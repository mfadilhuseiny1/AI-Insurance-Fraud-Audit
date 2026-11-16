package com.palantir.transforms.lang.java.api.internal;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.palantir.transforms.lang.java.api.*;
import java.io.File;
import java.io.PrintStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Parameter;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.*;
import java.util.function.Supplier;
import org.apache.spark.sql.Dataset;
import org.apache.spark.sql.Row;
import org.apache.spark.sql.RowFactory;
import org.apache.spark.sql.SparkSession;
import org.apache.spark.sql.types.*;

/**
 * The JVM side of Java transforms in Code Repositories (driven by api/code_java.py).
 *
 * list <spec.json>   discover the transforms: the project's PipelineDefiner (META-INF/services) registers them
 *                    with autoBindFromPackage (annotated @Compute methods) or register (builders)
 * build <spec.json>  run one transform on Spark (local mode): inputs arrive as rows, outputs leave as rows or files
 *
 * Results are written as JSON to the spec's "out" path; System.out of user code goes to the logs (stderr).
 */
public final class Main {
    static final ObjectMapper JSON = new ObjectMapper();

    public static void main(String[] args) throws Throwable {
        PrintStream realOut = System.out;
        System.setOut(System.err);
        @SuppressWarnings("unchecked")
        Map<String, Object> spec = JSON.readValue(new File(args[1]), Map.class);
        Map<String, Object> result = new LinkedHashMap<>();
        try {
            if (args[0].equals("list")) result.put("transforms", list(spec));
            else if (args[0].equals("build")) result.putAll(build(spec));
            else throw new IllegalArgumentException("unknown mode " + args[0]);
            result.put("ok", true);
        } catch (Throwable e) {
            Throwable t = e instanceof InvocationTargetException && e.getCause() != null ? e.getCause() : e;
            result.put("ok", false);
            result.put("error", describe(t));
            t.printStackTrace();
        }
        Files.writeString(Paths.get((String) spec.get("out")), JSON.writeValueAsString(result), StandardCharsets.UTF_8);
        realOut.flush();
        System.exit(0);
    }

    static String describe(Throwable t) {
        if (t instanceof InvocationTargetException && t.getCause() != null) return describe(t.getCause());
        StringBuilder b = new StringBuilder(t.toString());
        for (StackTraceElement el : t.getStackTrace()) {
            String c = el.getClassName();
            if (c.startsWith("java.") || c.startsWith("jdk.") || c.startsWith("sun.") || c.startsWith("org.apache.spark") || c.startsWith("scala.")
                    || c.startsWith("com.palantir.transforms.lang.java.api.internal")) continue;
            b.append("\n    at ").append(el);
        }
        if (t.getCause() != null && t.getCause() != t) b.append("\nCaused by: ").append(describe(t.getCause()));
        return b.toString();
    }

    // ---------------------------------------------------------------------------------------------- discovery

    /** A transform found in the project: where its compute function is and what it reads and writes. */
    static final class Found {
        Class<?> cls;
        Method method;
        String kind;
        String registration;
        int manualIndex = -1;
        Object instance;
        Map<String, String> inputs = new LinkedHashMap<>();
        Map<String, String> outputs = new LinkedHashMap<>();
        boolean ignoreDeletes;
        boolean schemaModification;
    }

    static List<Class<?>> loadClasses(List<String> names) {
        List<Class<?>> out = new ArrayList<>();
        for (String n : names) {
            try {
                out.add(Class.forName(n, false, Main.class.getClassLoader()));
            } catch (Throwable e) {
                System.err.println("Could not load " + n + ": " + e);
            }
        }
        return out;
    }

    static Method computeMethod(Class<?> cls) {
        Method found = null;
        for (Method m : cls.getMethods()) {
            if (!m.isAnnotationPresent(Compute.class)) continue;
            if (found != null) throw new IllegalStateException(cls.getName() + " has more than one @Compute method");
            found = m;
        }
        return found;
    }

    static void warn(List<Map<String, String>> warnings, Class<?> cls, String message) {
        warnings.add(Map.of("class", cls == null ? "" : cls.getName(), "message", message));
    }

    static boolean annotated(Method m) {
        if (m.isAnnotationPresent(Output.class)) return true;
        for (Parameter p : m.getParameters()) if (p.isAnnotationPresent(Input.class) || p.isAnnotationPresent(Output.class)) return true;
        return false;
    }

    static List<Found> discover(List<String> classNames, List<Map<String, String>> warnings) throws Exception {
        List<Class<?>> classes = loadClasses(classNames);
        List<PipelineDefiner> definers = new ArrayList<>();
        ServiceLoader.load(PipelineDefiner.class).forEach(definers::add);
        Pipeline pipeline = new Pipeline();
        if (definers.isEmpty()) {
            warn(warnings, null, "No PipelineDefiner is named in src/main/resources/META-INF/services/com.palantir.transforms.lang.java.api.PipelineDefiner: every annotated @Compute method is registered");
            pipeline.autoBindFromPackage("");
        } else {
            if (definers.size() > 1) warn(warnings, null, "More than one PipelineDefiner: each Java subproject should have one");
            for (PipelineDefiner d : definers) d.define(pipeline);
        }
        List<Found> out = new ArrayList<>();
        for (String pkg : pipeline.autoBoundPackages()) {
            for (Class<?> cls : classes) {
                String cn = cls.getName();
                if (!pkg.isEmpty() && !(cn.startsWith(pkg + ".") && cn.indexOf('$') < 0)) continue;
                for (Method m : cls.getDeclaredMethods()) {
                    // a compute function without @Input / @Output is meant for manual registration
                    if (!m.isAnnotationPresent(Compute.class) || !annotated(m)) continue;
                    Found f = autoBind(cls, m, warnings);
                    if (f != null) out.add(f);
                }
            }
        }
        int i = 0;
        for (Transform t : pipeline.registeredTransforms()) {
            Found f = new Found();
            f.instance = t.computeFunctionInstance();
            f.cls = f.instance.getClass();
            f.method = computeMethod(f.cls);
            if (f.method == null) throw new IllegalStateException(f.cls.getName() + " has no public @Compute method");
            f.kind = t instanceof HighLevelTransform ? "high" : "low";
            f.registration = "manual";
            f.manualIndex = i++;
            f.inputs.putAll(t.parameterToInputAlias());
            f.outputs.putAll(t.parameterToOutputAlias());
            f.ignoreDeletes = t.ignoreIncrementalDeletes();
            f.schemaModification = t.useSchemaModificationType();
            checkParameters(f);
            out.add(f);
        }
        return out;
    }

    static Found autoBind(Class<?> cls, Method m, List<Map<String, String>> warnings) {
        String where = cls.getName() + "." + m.getName();
        if (!Modifier.isPublic(m.getModifiers()) || Modifier.isStatic(m.getModifiers())) {
            warn(warnings, cls, where + ": a compute function must be public and not static; not registered");
            return null;
        }
        Found f = new Found();
        f.cls = cls;
        f.method = m;
        f.registration = "auto";
        boolean high = m.getReturnType() != void.class;
        f.kind = high ? "high" : "low";
        if (high) {
            Output o = m.getAnnotation(Output.class);
            if (o == null) {
                warn(warnings, cls, where + ": a high-level transform needs @Output on the method; not registered");
                return null;
            }
            f.outputs.put("$return", o.value());
        }
        for (Parameter p : m.getParameters()) {
            if (p.getType() == TransformContext.class) continue;
            Input in = p.getAnnotation(Input.class);
            Output out = p.getAnnotation(Output.class);
            if (in != null) f.inputs.put(p.getName(), in.value());
            else if (out != null && !high) f.outputs.put(p.getName(), out.value());
            else {
                warn(warnings, cls, where + ": parameter " + p.getName() + " needs @Input" + (high ? "" : " or @Output") + "; not registered");
                return null;
            }
        }
        if (f.outputs.isEmpty()) {
            warn(warnings, cls, where + ": no @Output; not registered");
            return null;
        }
        UseIncrementalOptions opts = m.getAnnotation(UseIncrementalOptions.class);
        if (opts != null) {
            for (IncrementalOptions o : opts.value()) {
                if (high) {
                    warn(warnings, cls, where + ": incremental options apply to low-level transforms only; " + o + " ignored");
                    continue;
                }
                if (o == IncrementalOptions.IGNORE_INCREMENTAL_DELETES) f.ignoreDeletes = true;
                if (o == IncrementalOptions.USE_SCHEMA_MODIFICATION_TYPE) f.schemaModification = true;
            }
        }
        return f;
    }

    static void checkParameters(Found f) {
        for (Parameter p : f.method.getParameters()) {
            if (p.getType() == TransformContext.class) continue;
            if (!f.inputs.containsKey(p.getName()) && !f.outputs.containsKey(p.getName()))
                throw new IllegalStateException(f.cls.getName() + "." + f.method.getName() + ": parameter " + p.getName()
                        + " is not given an alias (putParameterToInputAlias / putParameterToOutputAlias). Compile with parameter names (-parameters).");
        }
    }

    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> list(Map<String, Object> spec) throws Exception {
        List<Map<String, String>> warnings = new ArrayList<>();
        List<Found> found = discover((List<String>) spec.get("classes"), warnings);
        List<Map<String, Object>> out = new ArrayList<>();
        for (Found f : found) {
            Map<String, Object> d = new LinkedHashMap<>();
            d.put("class", f.cls.getName());
            d.put("method", f.method.getName());
            d.put("kind", f.kind);
            d.put("registration", f.registration);
            d.put("manual_index", f.manualIndex);
            d.put("inputs", f.inputs);
            d.put("outputs", f.outputs);
            List<Map<String, String>> params = new ArrayList<>();
            for (Parameter p : f.method.getParameters()) params.add(Map.of("name", p.getName(), "type", p.getType().getSimpleName()));
            d.put("parameters", params);
            MaxAllowedDuration max = f.method.getAnnotation(MaxAllowedDuration.class);
            d.put("max_duration", max == null ? null : max.value());
            d.put("ignore_incremental_deletes", f.ignoreDeletes);
            d.put("use_schema_modification_type", f.schemaModification);
            d.put("stop_propagating", f.method.isAnnotationPresent(StopPropagating.class));
            d.put("stop_requiring", f.method.isAnnotationPresent(StopRequiring.class));
            d.put("warnings", warnings);
            out.add(d);
        }
        if (out.isEmpty() && !warnings.isEmpty()) {
            Map<String, Object> w = new LinkedHashMap<>();
            w.put("warnings_only", warnings);
            out.add(w);
        }
        return out;
    }

    // ---------------------------------------------------------------------------------------------- build

    static SparkSession session(Map<String, Object> spec) {
        String tmp = (String) spec.get("tmp");
        return SparkSession.builder()
                .master("local[" + spec.getOrDefault("cores", 2) + "]")
                .appName("BluesandAI Java transform")
                .config("spark.ui.enabled", "false")
                .config("spark.ui.showConsoleProgress", "false")
                .config("spark.driver.host", "127.0.0.1")
                .config("spark.driver.bindAddress", "127.0.0.1")
                .config("spark.sql.shuffle.partitions", "4")
                .config("spark.sql.session.timeZone", "UTC")
                .config("spark.sql.warehouse.dir", new File(tmp, "warehouse").toURI().toString())
                .config("spark.local.dir", new File(tmp, "spark").getAbsolutePath())
                .getOrCreate();
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> build(Map<String, Object> spec) throws Throwable {
        Map<String, Object> t = (Map<String, Object>) spec.get("transform");
        String cls = (String) t.get("class");
        String methodName = (String) t.get("method");
        int manualIndex = ((Number) t.getOrDefault("manual_index", -1)).intValue();
        Found f = null;
        for (Found x : discover((List<String>) spec.get("classes"), new ArrayList<>())) {
            if (x.cls.getName().equals(cls) && x.method.getName().equals(methodName) && x.manualIndex == manualIndex) f = x;
        }
        if (f == null) throw new IllegalStateException("transform " + cls + "." + methodName + " is no longer registered");
        Object instance = f.instance != null ? f.instance : f.cls.getDeclaredConstructor().newInstance();

        SparkSession session = session(spec);
        Map<String, Object> inputs = (Map<String, Object>) spec.get("inputs");
        Map<String, Object> outputDirs = (Map<String, Object>) spec.get("outputs");
        Map<String, Object> written = new LinkedHashMap<>();
        Map<String, List<String>> uris = new LinkedHashMap<>();
        uris.put("api", List.of(String.valueOf(spec.getOrDefault("api_url", ""))));
        TransformContext ctx = new TransformContext(session, (Map<String, Object>) spec.getOrDefault("parameters", Map.of()), new ServiceDiscovery(uris, String.valueOf(spec.getOrDefault("api_token", ""))));

        Parameter[] params = f.method.getParameters();
        Object[] args = new Object[params.length];
        for (int i = 0; i < params.length; i++) {
            Parameter p = params[i];
            if (p.getType() == TransformContext.class) {
                args[i] = ctx;
                continue;
            }
            String name = p.getName();
            if (f.inputs.containsKey(name)) {
                Map<String, Object> in = (Map<String, Object>) inputs.get(name);
                if (in == null) throw new IllegalStateException("no data for input " + name);
                FoundryInput fi = foundryInput(session, f.inputs.get(name), in);
                if (f.kind.equals("high")) {
                    if (!Dataset.class.isAssignableFrom(p.getType()))
                        throw new IllegalStateException("a high-level transform takes Dataset<Row> inputs; " + name + " is " + p.getType().getSimpleName());
                    args[i] = fi.asDataFrame().read();
                } else {
                    if (p.getType() != FoundryInput.class)
                        throw new IllegalStateException("a low-level transform takes FoundryInput inputs; " + name + " is " + p.getType().getSimpleName());
                    args[i] = fi;
                }
            } else if (f.outputs.containsKey(name)) {
                args[i] = foundryOutput(name, f.outputs.get(name), (String) outputDirs.get(name), written);
            }
        }
        f.method.setAccessible(true);
        Object returned;
        try {
            returned = f.method.invoke(instance, args);
        } catch (InvocationTargetException e) {
            throw e.getCause();
        }
        if (f.kind.equals("high")) {
            if (!(returned instanceof Dataset)) throw new IllegalStateException("the compute function must return a Dataset<Row>, not " + returned);
            writeFrame("$return", (Dataset<Row>) returned, WriteMode.SNAPSHOT, (String) outputDirs.get("$return"), written);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("outputs", written);
        session.stop();
        return out;
    }

    // ---------------------------------------------------------------------------------------------- inputs

    @SuppressWarnings("unchecked")
    static FoundryInput foundryInput(SparkSession session, String alias, Map<String, Object> in) throws Exception {
        Map<ReadRange, Supplier<Dataset<Row>>> frames = null;
        DataFrameModificationType mod = DataFrameModificationType.valueOf((String) in.getOrDefault("modification", "NEW_VIEW"));
        SchemaModificationType schemaMod = SchemaModificationType.valueOf((String) in.getOrDefault("schema_modification", "UNCHANGED"));
        if (in.get("data") != null) {
            Map<String, Object> data = JSON.readValue(new File((String) in.get("data")), Map.class);
            List<Map<String, String>> columns = (List<Map<String, String>>) data.get("columns");
            List<Map<String, Object>> rows = (List<Map<String, Object>>) data.get("rows");
            StructType schema = schemaOf(columns);
            List<Row> all = new ArrayList<>(rows.size());
            for (Map<String, Object> r : rows) all.add(toRow(r, columns));
            int processed = Math.min(all.size(), ((Number) in.getOrDefault("processed", 0)).intValue());
            frames = new EnumMap<>(ReadRange.class);
            frames.put(ReadRange.ENTIRE_VIEW, () -> session.createDataFrame(all, schema));
            frames.put(ReadRange.PROCESSED, () -> session.createDataFrame(all.subList(0, processed), schema));
            frames.put(ReadRange.UNPROCESSED, () -> session.createDataFrame(all.subList(processed, all.size()), schema));
        }
        Map<String, String> files = (Map<String, String>) in.getOrDefault("files", Map.of());
        Set<String> processedFiles = new HashSet<>((List<String>) in.getOrDefault("processed_files", List.of()));
        FilesModificationType filesMod = FilesModificationType.valueOf((String) in.getOrDefault("files_modification", "NEW_VIEW"));
        return new FoundryInput(alias, frames, mod, schemaMod, files, processedFiles, filesMod);
    }

    static DataType sparkType(String t) {
        switch (t) {
            case "Boolean": return DataTypes.BooleanType;
            case "Byte": return DataTypes.ByteType;
            case "Short": return DataTypes.ShortType;
            case "Integer": return DataTypes.IntegerType;
            case "Long": return DataTypes.LongType;
            case "Float": return DataTypes.FloatType;
            case "Double": return DataTypes.DoubleType;
            case "Decimal": return DataTypes.createDecimalType(38, 18);
            case "Date": return DataTypes.DateType;
            case "Timestamp": return DataTypes.TimestampType;
            default: return DataTypes.StringType;
        }
    }

    static StructType schemaOf(List<Map<String, String>> columns) {
        StructType s = new StructType();
        for (Map<String, String> c : columns) s = s.add(c.get("name"), sparkType(c.get("type")), true);
        return s;
    }

    static Row toRow(Map<String, Object> r, List<Map<String, String>> columns) {
        Object[] values = new Object[columns.size()];
        for (int i = 0; i < values.length; i++) {
            Map<String, String> c = columns.get(i);
            values[i] = toValue(r.get(c.get("name")), c.get("type"));
        }
        return RowFactory.create(values);
    }

    static Object toValue(Object v, String type) {
        if (v == null) return null;
        switch (type) {
            case "Boolean": return v instanceof Boolean ? v : Boolean.parseBoolean(v.toString());
            case "Byte": return ((Number) num(v)).byteValue();
            case "Short": return ((Number) num(v)).shortValue();
            case "Integer": return ((Number) num(v)).intValue();
            case "Long": return ((Number) num(v)).longValue();
            case "Float": return ((Number) num(v)).floatValue();
            case "Double": return ((Number) num(v)).doubleValue();
            case "Decimal": return new BigDecimal(v.toString());
            case "Date": return Date.valueOf(LocalDate.parse(v.toString().substring(0, 10)));
            case "Timestamp": return Timestamp.from(instant(v.toString()));
            default: return v instanceof String ? v : v.toString();
        }
    }

    static Object num(Object v) {
        return v instanceof Number ? v : Double.valueOf(v.toString());
    }

    static Instant instant(String s) {
        try {
            return OffsetDateTime.parse(s).toInstant();
        } catch (Exception e) {
            return LocalDateTime.parse(s.replace(' ', 'T')).toInstant(ZoneOffset.UTC);
        }
    }

    // ---------------------------------------------------------------------------------------------- outputs

    @SuppressWarnings("unchecked")
    static FoundryOutput foundryOutput(String param, String alias, String dir, Map<String, Object> written) {
        String filesDir = new File(dir, "files").getAbsolutePath();
        return new FoundryOutput(alias, filesDir,
                (df, mode) -> writeFrame(param, df, mode, dir, written),
                mode -> {
                    Map<String, Object> w = new LinkedHashMap<>();
                    w.put("kind", "files");
                    w.put("mode", mode.name());
                    w.put("dir", filesDir);
                    written.put(param, w);
                });
    }

    static void writeFrame(String param, Dataset<Row> df, WriteMode mode, String dir, Map<String, Object> written) {
        try {
            StructType schema = df.schema();
            List<Map<String, String>> columns = new ArrayList<>();
            for (StructField f : schema.fields()) columns.add(Map.of("name", f.name(), "type", typeName(f.dataType())));
            List<Map<String, Object>> rows = new ArrayList<>();
            for (Row r : df.collectAsList()) {
                Map<String, Object> m = new LinkedHashMap<>();
                for (int i = 0; i < schema.fields().length; i++) m.put(schema.fields()[i].name(), fromValue(r.get(i), schema.fields()[i].dataType()));
                rows.add(m);
            }
            Files.createDirectories(Paths.get(dir));
            File data = new File(dir, "data.json");
            JSON.writeValue(data, Map.of("columns", columns, "rows", rows));
            Map<String, Object> w = new LinkedHashMap<>();
            w.put("kind", "dataframe");
            w.put("mode", mode.name());
            w.put("data", data.getAbsolutePath());
            w.put("rows", rows.size());
            written.put(param, w);
        } catch (Exception e) {
            throw new RuntimeException("writing output " + param + " failed: " + e, e);
        }
    }

    static String typeName(DataType t) {
        if (t instanceof BooleanType) return "Boolean";
        if (t instanceof ByteType) return "Byte";
        if (t instanceof ShortType) return "Short";
        if (t instanceof IntegerType) return "Integer";
        if (t instanceof LongType) return "Long";
        if (t instanceof FloatType) return "Float";
        if (t instanceof DoubleType) return "Double";
        if (t instanceof DecimalType) return "Decimal";
        if (t instanceof DateType) return "Date";
        if (t instanceof TimestampType || t instanceof TimestampNTZType) return "Timestamp";
        return "String";
    }

    static Object fromValue(Object v, DataType t) throws Exception {
        if (v == null) return null;
        if (v instanceof Date) return v.toString();
        if (v instanceof Timestamp) return ((Timestamp) v).toInstant().toString();
        if (v instanceof LocalDate || v instanceof Instant || v instanceof LocalDateTime) return v.toString();
        if (v instanceof BigDecimal) return ((BigDecimal) v).toPlainString();
        if (v instanceof byte[]) return Base64.getEncoder().encodeToString((byte[]) v);
        if (t instanceof ArrayType || t instanceof MapType || t instanceof StructType) return JSON.writeValueAsString(plain(v));
        return v;
    }

    /** Spark's nested values (Rows, Scala collections) as plain Java maps and lists, for JSON. */
    static Object plain(Object v) {
        if (v instanceof Row) {
            Row r = (Row) v;
            Map<String, Object> m = new LinkedHashMap<>();
            for (int i = 0; i < r.size(); i++) m.put(r.schema() != null ? r.schema().fields()[i].name() : "_" + i, plain(r.get(i)));
            return m;
        }
        if (v instanceof scala.collection.Map) {
            Map<String, Object> m = new LinkedHashMap<>();
            scala.collection.Iterator<?> it = ((scala.collection.Map<?, ?>) v).iterator();
            while (it.hasNext()) {
                scala.Tuple2<?, ?> e = (scala.Tuple2<?, ?>) it.next();
                m.put(String.valueOf(e._1()), plain(e._2()));
            }
            return m;
        }
        if (v instanceof scala.collection.Iterable) {
            List<Object> l = new ArrayList<>();
            scala.collection.Iterator<?> it = ((scala.collection.Iterable<?>) v).iterator();
            while (it.hasNext()) l.add(plain(it.next()));
            return l;
        }
        if (v instanceof Date || v instanceof Timestamp || v instanceof BigDecimal) return v.toString();
        return v;
    }
}
