package com.palantir.transforms.excel;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import org.apache.spark.sql.Dataset;
import org.apache.spark.sql.Row;

/**
 * What {@link TransformsExcelParser#parse} found: one DataFrame per parser key (absent when the parser found no rows,
 * e.g. no sheet matched — that is not an error) and the error DataFrame (file_path, parser_key, error), which can be
 * checked at runtime to fail fast or written to its own output and checked asynchronously.
 */
public final class ParseResult {
    private final Map<String, Dataset<Row>> results;
    private final Dataset<Row> errors;

    ParseResult(Map<String, Dataset<Row>> results, Dataset<Row> errors) {
        this.results = new LinkedHashMap<>(results);
        this.errors = errors;
    }

    /** The DataFrame of the only parser (TransformsExcelParser.of(parser)). */
    public Optional<Dataset<Row>> singleResult() {
        if (results.size() > 1) {
            throw new IllegalStateException("singleResult() needs exactly one parser; use dataframeForKey(key) with " + results.keySet());
        }
        return dataframeForKey(TransformsExcelParser.SINGLE_KEY);
    }

    public Optional<Dataset<Row>> dataframeForKey(String key) {
        return Optional.ofNullable(results.get(key));
    }

    /** Every parser's DataFrame by key (only parsers that found rows). */
    public Map<String, Dataset<Row>> dataframes() {
        return Collections.unmodifiableMap(results);
    }

    /**
     * Errors: file_path, parser_key (null for errors opening the file) and error. Empty when everything parsed. Rows
     * whose error starts with "warning: " are not failures: a formula with no saved result that could not be
     * calculated (unsupported function, circular reference) and was read as empty; the file's records are present.
     */
    public Dataset<Row> errorDataframe() {
        return errors;
    }
}
