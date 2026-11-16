package com.palantir.foundry.udf.api;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/** Conversions between row values (JSON-like: strings, numbers, booleans, lists, maps) and generated field types. */
public final class Values {
    private Values() {}

    private static Number number(Object v) {
        if (v instanceof Number) return (Number) v;
        String s = v.toString().trim();
        return s.matches("-?\\d+") ? (Number) Long.valueOf(s) : (Number) Double.valueOf(s);
    }

    public static String toStr(Object v) {
        return v == null ? null : v.toString();
    }

    public static Boolean toBoolean(Object v) {
        return v == null ? null : v instanceof Boolean ? (Boolean) v : Boolean.valueOf(v.toString().trim());
    }

    public static Byte toByte(Object v) {
        return v == null ? null : number(v).byteValue();
    }

    public static Short toShort(Object v) {
        return v == null ? null : number(v).shortValue();
    }

    public static Integer toInteger(Object v) {
        return v == null ? null : number(v).intValue();
    }

    public static Long toLong(Object v) {
        return v == null ? null : number(v).longValue();
    }

    public static Float toFloat(Object v) {
        return v == null ? null : number(v).floatValue();
    }

    public static Double toDouble(Object v) {
        return v == null ? null : number(v).doubleValue();
    }

    public static BigDecimal toDecimal(Object v) {
        return v == null ? null : v instanceof BigDecimal ? (BigDecimal) v : new BigDecimal(v.toString().trim());
    }

    public static LocalDate toDate(Object v) {
        return v == null ? null : v instanceof LocalDate ? (LocalDate) v : LocalDate.parse(v.toString().substring(0, 10));
    }

    public static Instant toTimestamp(Object v) {
        if (v == null) return null;
        if (v instanceof Instant) return (Instant) v;
        String s = v.toString();
        try {
            return OffsetDateTime.parse(s).toInstant();
        } catch (Exception e) {
            return LocalDateTime.parse(s.replace(' ', 'T')).toInstant(ZoneOffset.UTC);
        }
    }

    public static byte[] toBinary(Object v) {
        return v == null ? null : v instanceof byte[] ? (byte[]) v : Base64.getDecoder().decode(v.toString());
    }

    public static <T> List<T> toList(Object v, Function<Object, T> element) {
        if (v == null) return null;
        List<T> out = new ArrayList<>();
        for (Object x : (Iterable<?>) parsed(v)) out.add(element.apply(x));
        return out;
    }

    public static <K, V> Map<K, V> toMap(Object v, Function<Object, K> key, Function<Object, V> value) {
        if (v == null) return null;
        Map<K, V> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> e : ((Map<?, ?>) parsed(v)).entrySet()) out.put(key.apply(e.getKey()), value.apply(e.getValue()));
        return out;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> toRow(Object v) {
        return v == null ? null : (Map<String, Object>) parsed(v);
    }

    /** Arrays, maps and structs may arrive as JSON text (how tables hold them). */
    private static Object parsed(Object v) {
        if (v instanceof String) {
            try {
                return new com.fasterxml.jackson.databind.ObjectMapper().readValue((String) v, Object.class);
            } catch (Exception e) {
                throw new IllegalArgumentException("not a JSON array / object: " + v);
            }
        }
        return v;
    }

    /** A field value as a plain row value (dates and timestamps as ISO text, structs as maps). */
    public static Object plain(Object v) {
        if (v == null) return null;
        if (v instanceof Struct) return plainMap(((Struct) v).toMap());
        if (v instanceof LocalDate || v instanceof Instant) return v.toString();
        if (v instanceof BigDecimal) return ((BigDecimal) v).toPlainString();
        if (v instanceof byte[]) return Base64.getEncoder().encodeToString((byte[]) v);
        if (v instanceof Map) return plainMap((Map<?, ?>) v);
        if (v instanceof Iterable) {
            List<Object> out = new ArrayList<>();
            for (Object x : (Iterable<?>) v) out.add(plain(x));
            return out;
        }
        return v;
    }

    public static Map<String, Object> plainMap(Map<?, ?> m) {
        Map<String, Object> out = new LinkedHashMap<>();
        m.forEach((k, x) -> out.put(String.valueOf(k), plain(x)));
        return out;
    }
}
