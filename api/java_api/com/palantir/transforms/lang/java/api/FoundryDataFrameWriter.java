package com.palantir.transforms.lang.java.api;

import java.util.function.BiConsumer;
import org.apache.spark.sql.Dataset;
import org.apache.spark.sql.Row;

/** Writes a DataFrame to an output: write() replaces it (SNAPSHOT), write(WriteMode.UPDATE) adds the rows. */
public final class FoundryDataFrameWriter {
    private final Dataset<Row> df;
    private final BiConsumer<Dataset<Row>, WriteMode> sink;

    FoundryDataFrameWriter(Dataset<Row> df, BiConsumer<Dataset<Row>, WriteMode> sink) {
        this.df = df;
        this.sink = sink;
    }

    public void write() {
        write(WriteMode.SNAPSHOT);
    }

    public void write(WriteMode mode) {
        sink.accept(df, mode);
    }
}
