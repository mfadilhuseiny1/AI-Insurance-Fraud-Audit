package com.palantir.transforms.lang.java.api.internal;

import com.palantir.foundry.udf.api.FoundryRowMapUdf;
import com.palantir.foundry.udf.api.FoundryRowMapUdfFactory;
import com.palantir.foundry.udf.api.RowBuilderFactory;
import com.palantir.foundry.udf.api.Struct;
import com.palantir.foundry.udf.api.Values;
import com.palantir.foundry.udf.api.flatmap.FoundryRowFlatMapUdf;
import com.palantir.foundry.udf.api.flatmap.FoundryRowFlatMapUdfFactory;
import com.palantir.foundry.udf.api.keyed.FoundryKeyedProcessUdf;
import com.palantir.foundry.udf.api.keyed.FoundryKeyedProcessUdfFactory;
import com.palantir.foundry.udf.examples.Examples;
import com.palantir.foundry.udf.examples.UdfExample;
import java.io.File;
import java.io.PrintStream;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.*;

/**
 * The JVM side of user-defined functions (driven by api/code_java.py):
 *
 * check <spec>     each UDF definition has a factory implementation
 * run <spec>       run one UDF over rows with its arguments (Pipeline Builder steps); a keyed process UDF also takes
 *                  and returns its keyed state, timers and watermark ("keyed") — see KeyedRunner
 * examples <spec>  run every Examples class of examples.registry and compare with the expected rows
 */
public final class UdfMain {
    public static void main(String[] args) throws Exception {
        PrintStream realOut = System.out;
        System.setOut(System.err);
        @SuppressWarnings("unchecked")
        Map<String, Object> spec = Main.JSON.readValue(new File(args[1]), Map.class);
        Map<String, Object> result = new LinkedHashMap<>();
        try {
            @SuppressWarnings("unchecked")
            List<Class<?>> classes = Main.loadClasses((List<String>) spec.get("classes"));
            switch (args[0]) {
                case "check": result.put("problems", check(spec, classes)); break;
                case "run": run(spec, classes, result); break;
                case "examples": result.put("examples", examples(spec, classes)); break;
                default: throw new IllegalArgumentException("unknown mode " + args[0]);
            }
            result.put("ok", true);
        } catch (Throwable e) {
            result.put("ok", false);
            result.put("error", Main.describe(e));
            e.printStackTrace();
        }
        Files.writeString(Paths.get((String) spec.get("out")), Main.JSON.writeValueAsString(result), StandardCharsets.UTF_8);
        realOut.flush();
        System.exit(0);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Map<String, Object>> definitions(Map<String, Object> spec) {
        Map<String, Map<String, Object>> out = new LinkedHashMap<>();
        for (Map<String, Object> u : (List<Map<String, Object>>) spec.get("udfs")) out.put((String) u.get("name"), u);
        return out;
    }

    static Class<?> factoryClass(Map<String, Object> udf, List<Class<?>> classes) throws Exception {
        Class<?> iface = Class.forName((String) udf.get("factory_interface"));
        Class<?> found = null;
        for (Class<?> c : classes) {
            if (iface.isAssignableFrom(c) && !c.isInterface() && !Modifier.isAbstract(c.getModifiers())) {
                if (found != null) throw new IllegalStateException("More than one implementation of " + iface.getSimpleName() + ": " + found.getName() + ", " + c.getName());
                found = c;
            }
        }
        return found;
    }

    static List<String> check(Map<String, Object> spec, List<Class<?>> classes) throws Exception {
        List<String> problems = new ArrayList<>();
        for (Map<String, Object> u : definitions(spec).values()) {
            try {
                Class<?> f = factoryClass(u, classes);
                if (f == null) problems.add(u.get("name") + ": no class implements " + u.get("factory_interface") + " (write " + u.get("name") + "…UdfFactoryImpl)");
                else f.getDeclaredConstructor();
            } catch (NoSuchMethodException e) {
                problems.add(u.get("name") + ": the factory needs a public no-argument constructor (it is service-loaded)");
            } catch (Exception e) {
                problems.add(u.get("name") + ": " + e.getMessage());
            }
        }
        return problems;
    }

    /** The UDF as the runtime calls it, created by its factory with a configuration object. */
    @SuppressWarnings({"unchecked", "rawtypes"})
    static Object create(Map<String, Object> udf, List<Class<?>> classes, Object config) throws Exception {
        Class<?> f = factoryClass(udf, classes);
        if (f == null) throw new IllegalStateException("no implementation of " + udf.get("factory_interface"));
        Object factory = f.getDeclaredConstructor().newInstance();
        if (factory instanceof FoundryRowMapUdfFactory) {
            return ((FoundryRowMapUdfFactory) factory).create((FoundryRowMapUdfFactory.Arguments) () -> config);
        }
        if (factory instanceof FoundryKeyedProcessUdfFactory) {
            return ((FoundryKeyedProcessUdfFactory) factory).create((FoundryKeyedProcessUdfFactory.Arguments) () -> config);
        }
        return ((FoundryRowFlatMapUdfFactory) factory).create((FoundryRowFlatMapUdfFactory.Arguments) () -> config);
    }

    static Object config(Map<String, Object> udf, Map<String, Object> values) throws Exception {
        try {
            return Class.forName((String) udf.get("config_class")).getMethod("fromMap", Map.class).invoke(null, values);
        } catch (java.lang.reflect.InvocationTargetException e) {
            throw e.getCause() instanceof Exception ? (Exception) e.getCause() : e;
        }
    }

    @SuppressWarnings("unchecked")
    static KeyedRunner keyed(Map<String, Object> def, Object udf, Map<String, Object> saved, Object now) {
        return new KeyedRunner((FoundryKeyedProcessUdf) udf, (List<String>) def.getOrDefault("key_columns", List.of()), (String) def.get("event_time_column"), saved,
                now instanceof Number ? ((Number) now).longValue() : System.currentTimeMillis());
    }

    /** Examples run a keyed process UDF as a batch: empty state, every event-time timer fires at the end. */
    static List<Map<String, Object>> apply(Map<String, Object> def, Object udf, List<Map<String, Object>> rows) throws Exception {
        if (!(udf instanceof FoundryKeyedProcessUdf)) return apply(udf, rows);
        KeyedRunner r = keyed(def, udf, null, null);
        r.run(rows, true);
        return r.out;
    }

    static List<Map<String, Object>> apply(Object udf, List<Map<String, Object>> rows) throws Exception {
        List<Map<String, Object>> out = new ArrayList<>();
        if (udf instanceof FoundryRowMapUdf) {
            FoundryRowMapUdf.Context ctx = () -> RowBuilderFactory.INSTANCE;
            for (Map<String, Object> r : rows) out.add(((FoundryRowMapUdf) udf).map(ctx, r));
        } else {
            FoundryRowFlatMapUdf.Context ctx = () -> RowBuilderFactory.INSTANCE;
            for (Map<String, Object> r : rows) ((FoundryRowFlatMapUdf) udf).flatMap(ctx, r, out::add);
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    static void run(Map<String, Object> spec, List<Class<?>> classes, Map<String, Object> result) throws Exception {
        Map<String, Object> udf = definitions(spec).get((String) spec.get("udf"));
        if (udf == null) throw new IllegalArgumentException("no UDF " + spec.get("udf") + " in this version");
        Object instance = create(udf, classes, config(udf, (Map<String, Object>) spec.getOrDefault("config", Map.of())));
        List<Map<String, Object>> rows = (List<Map<String, Object>>) spec.get("rows");
        if (instance instanceof FoundryKeyedProcessUdf) {
            KeyedRunner r = keyed(udf, instance, (Map<String, Object>) spec.get("keyed"), spec.get("now"));
            r.run(rows, Boolean.TRUE.equals(spec.get("bounded")));
            result.put("rows", r.out);
            result.put("keyed", r.saved());
            return;
        }
        result.put("rows", apply(instance, rows));
    }

    static Map<String, Object> rowOf(Object o) {
        if (o instanceof Struct) return Values.plainMap(((Struct) o).toMap());
        if (o instanceof Map) return Values.plainMap((Map<?, ?>) o);
        throw new IllegalArgumentException("example rows must be generated row objects, not " + o);
    }

    /** Rows compare by value: numbers by numeric value, everything else by equals. */
    static boolean same(Object a, Object b) {
        if (a instanceof Number && b instanceof Number) return Math.abs(((Number) a).doubleValue() - ((Number) b).doubleValue()) < 1e-9;
        if (a instanceof Map && b instanceof Map) {
            Map<?, ?> x = (Map<?, ?>) a, y = (Map<?, ?>) b;
            if (!x.keySet().equals(y.keySet())) return false;
            for (Object k : x.keySet()) if (!same(x.get(k), y.get(k))) return false;
            return true;
        }
        if (a instanceof List && b instanceof List) {
            List<?> x = (List<?>) a, y = (List<?>) b;
            if (x.size() != y.size()) return false;
            for (int i = 0; i < x.size(); i++) if (!same(x.get(i), y.get(i))) return false;
            return true;
        }
        return Objects.equals(a, b);
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    static List<Map<String, Object>> examples(Map<String, Object> spec, List<Class<?>> classes) throws Exception {
        Map<String, Map<String, Object>> defs = definitions(spec);
        List<Map<String, Object>> out = new ArrayList<>();
        for (Class<?> c : classes) {
            if (!Examples.class.isAssignableFrom(c) || c.isInterface() || Modifier.isAbstract(c.getModifiers())) continue;
            Examples ex = (Examples) c.getDeclaredConstructor().newInstance();
            Map<String, Object> udf = defs.get(ex.name());
            for (Object o : ex.examples()) {
                UdfExample e = (UdfExample) o;
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("class", c.getName());
                r.put("udf", ex.name());
                r.put("id", e.id().get());
                r.put("description", e.description());
                r.put("visibility", e.visibility().name());
                r.put("category", e.category().name());
                List<Map<String, Object>> input = new ArrayList<>();
                for (Object i : e.input()) input.add(rowOf(i));
                List<Map<String, Object>> expected = new ArrayList<>();
                for (Object i : e.output()) expected.add(rowOf(i));
                r.put("configuration", e.configuration() instanceof Struct ? Values.plainMap(((Struct) e.configuration()).toMap()) : Map.of());
                r.put("input", input);
                r.put("expected", expected);
                if (udf == null) {
                    r.put("ok", false);
                    r.put("error", "name() returns \"" + ex.name() + "\", which is not a UDF of this repository: the examples are not registered");
                } else {
                    try {
                        List<Map<String, Object>> actual = apply(udf, create(udf, classes, e.configuration()), input);
                        r.put("actual", actual);
                        boolean ok = actual.size() == expected.size();
                        for (int i = 0; ok && i < actual.size(); i++) ok = same(actual.get(i), expected.get(i));
                        r.put("ok", ok);
                        if (!ok) r.put("error", "the UDF output differs from the expected rows");
                    } catch (Throwable t) {
                        r.put("ok", false);
                        r.put("error", Main.describe(t));
                    }
                }
                out.add(r);
            }
        }
        return out;
    }
}
