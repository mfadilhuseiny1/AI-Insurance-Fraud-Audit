package com.palantir.transforms.excel;

import com.palantir.spark.binarystream.data.PortableFile;
import com.palantir.transforms.excel.utils.WorkbookUtils;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import org.apache.poi.openxml4j.util.ZipSecureFile;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.ss.usermodel.WorkbookFactory;
import org.apache.poi.util.IOUtils;
import org.apache.spark.sql.Dataset;
import org.apache.spark.sql.Row;
import org.apache.spark.sql.RowFactory;
import org.apache.spark.sql.SparkSession;
import org.apache.spark.sql.types.DataTypes;
import org.apache.spark.sql.types.StructField;
import org.apache.spark.sql.types.StructType;

/**
 * Palantir's transforms-excel-parser: Apache POI with sensible defaults. Reads every Excel file of a file dataset once
 * and runs each registered parser over it; files with partially overlapping schemas are combined (the union of their
 * columns, as strings). Supported: xls, xlt, xltm, xltx, xlsx, xlsm (xlsb is not). POI's "zip bomb" detection and
 * maximum byte array size are relaxed for large but legitimate workbooks.
 */
public final class TransformsExcelParser implements java.io.Serializable {
    private static final long serialVersionUID = 1L;
    static final String SINGLE_KEY = "__single__";
    static final Set<String> SUPPORTED = Set.of("xls", "xlt", "xltm", "xltx", "xlsx", "xlsm");

    static {
        ZipSecureFile.setMinInflateRatio(0.0001);
        ZipSecureFile.setMaxEntrySize(4L * 1024 * 1024 * 1024);
        IOUtils.setByteArrayMaxOverride(Integer.MAX_VALUE);
    }

    private final Map<String, Parser> parsers;

    private TransformsExcelParser(Map<String, Parser> parsers) {
        if (parsers.isEmpty()) throw new IllegalArgumentException("register at least one parser");
        this.parsers = new LinkedHashMap<>(parsers);
    }

    /** One parser; its DataFrame is ParseResult.singleResult(). */
    public static TransformsExcelParser of(Parser parser) {
        return new TransformsExcelParser(Map.of(SINGLE_KEY, Objects.requireNonNull(parser)));
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private final Map<String, Parser> parsers = new LinkedHashMap<>();

        public Builder putKeyToParser(String key, Parser parser) {
            parsers.put(Objects.requireNonNull(key), Objects.requireNonNull(parser));
            return this;
        }

        public Builder putAllKeyToParser(Map<String, ? extends Parser> all) {
            all.forEach(this::putKeyToParser);
            return this;
        }

        public TransformsExcelParser build() {
            return new TransformsExcelParser(parsers);
        }
    }

    /**
     * Parse the files (myInput.asFiles().getFileSystem().filesAsDataset()). Each workbook is opened and parsed on an
     * executor (the files are spread over up to the default parallelism); only the parsed records reach the driver,
     * which builds one DataFrame per parser from them.
     */
    public ParseResult parse(Dataset<PortableFile> files) {
        SparkSession spark = files.sparkSession();
        long n = files.count();
        int parts = (int) Math.max(1, Math.min(n, spark.sparkContext().defaultParallelism()));
        List<KeyedParsedRecord> out = files.repartition(parts)
                .flatMap((org.apache.spark.api.java.function.FlatMapFunction<PortableFile, KeyedParsedRecord>) f -> parseFile(f).iterator(),
                        org.apache.spark.sql.Encoders.javaSerialization(KeyedParsedRecord.class))
                .collectAsList();
        return assemble(out, spark);
    }

    List<KeyedParsedRecord> parseFile(PortableFile f) {
        String path = f.getLogicalPath();
        String ext = path.contains(".") ? path.substring(path.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
        List<KeyedParsedRecord> out = new ArrayList<>();
        if (ext.equals("xlsb")) {
            out.add(KeyedParsedRecord.error(null, path, "xlsb files are not supported"));
            return out;
        }
        if (!SUPPORTED.contains(ext)) {
            out.add(KeyedParsedRecord.error(null, path, "not an Excel file (supported: xls, xlt, xltm, xltx, xlsx, xlsm)"));
            return out;
        }
        try (InputStream in = f.getInputStream(); Workbook wb = WorkbookFactory.create(in)) {
            WorkbookUtils.drainWarnings();
            try {
                for (Map.Entry<String, Parser> e : parsers.entrySet()) {
                    try {
                        for (ParsedRecord r : e.getValue().parse(wb)) out.add(KeyedParsedRecord.of(e.getKey(), path, r));
                    } catch (RuntimeException ex) {
                        out.add(KeyedParsedRecord.error(e.getKey(), path, describe(ex)));
                    }
                    // formulas without a saved result that could not be calculated: one "warning: ..." row each
                    for (String w : WorkbookUtils.drainWarnings()) out.add(KeyedParsedRecord.error(e.getKey(), path, "warning: " + w));
                }
            } finally {
                WorkbookUtils.release(wb);
            }
        } catch (Exception ex) {
            out.add(KeyedParsedRecord.error(null, path, "could not open the workbook: " + describe(ex)));
        }
        return out;
    }

    private static String describe(Throwable t) {
        return t.getClass().getSimpleName() + (t.getMessage() == null ? "" : ": " + t.getMessage());
    }

    private ParseResult assemble(List<KeyedParsedRecord> records, SparkSession spark) {
        Map<String, Dataset<Row>> results = new LinkedHashMap<>();
        for (String key : parsers.keySet()) {
            Set<String> columns = new LinkedHashSet<>();
            List<KeyedParsedRecord> mine = new ArrayList<>();
            for (KeyedParsedRecord r : records) {
                if (!r.isError() && key.equals(r.key())) {
                    mine.add(r);
                    columns.addAll(r.record().values().keySet());
                }
            }
            if (mine.isEmpty()) continue;
            List<StructField> fields = new ArrayList<>();
            for (String c : columns) fields.add(DataTypes.createStructField(c, DataTypes.StringType, true));
            List<Row> rows = new ArrayList<>();
            for (KeyedParsedRecord r : mine) {
                Object[] vals = new Object[columns.size()];
                int i = 0;
                for (String c : columns) vals[i++] = r.record().values().get(c);
                rows.add(RowFactory.create(vals));
            }
            results.put(key, spark.createDataFrame(rows, DataTypes.createStructType(fields)));
        }
        StructType errSchema = DataTypes.createStructType(List.of(
                DataTypes.createStructField("file_path", DataTypes.StringType, true),
                DataTypes.createStructField("parser_key", DataTypes.StringType, true),
                DataTypes.createStructField("error", DataTypes.StringType, true)));
        List<Row> errs = new ArrayList<>();
        for (KeyedParsedRecord r : records) {
            if (r.isError()) errs.add(RowFactory.create(r.filePath(), SINGLE_KEY.equals(r.key()) ? null : r.key(), r.error()));
        }
        return new ParseResult(results, spark.createDataFrame(errs, errSchema));
    }
}
