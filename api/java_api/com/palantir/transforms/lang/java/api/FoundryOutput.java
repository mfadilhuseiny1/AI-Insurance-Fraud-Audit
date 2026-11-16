package com.palantir.transforms.lang.java.api;

import java.util.function.BiConsumer;
import org.apache.spark.sql.Dataset;
import org.apache.spark.sql.Row;

/** An output dataset of a low-level transform: write a DataFrame, or files. */
public final class FoundryOutput {
    private final String alias;
    private final String filesDir;
    private final BiConsumer<Dataset<Row>, WriteMode> onDataFrame;
    private final java.util.function.Consumer<WriteMode> onFiles;

    /** Built by the runner. */
    public FoundryOutput(String alias, String filesDir, BiConsumer<Dataset<Row>, WriteMode> onDataFrame, java.util.function.Consumer<WriteMode> onFiles) {
        this.alias = alias;
        this.filesDir = filesDir;
        this.onDataFrame = onDataFrame;
        this.onFiles = onFiles;
    }

    public String getDatasetPath() {
        return alias;
    }

    public FoundryDataFrameWriter getDataFrameWriter(Dataset<Row> df) {
        return new FoundryDataFrameWriter(df, onDataFrame);
    }

    /** The output's file system for a snapshot (replacing the output's files). */
    public WriteOnlyLogicalFileSystem getFileSystem() {
        return getFileSystem(WriteMode.SNAPSHOT);
    }

    /** UPDATE keeps the output's files and adds (or replaces) the ones written; SNAPSHOT replaces them all. */
    public WriteOnlyLogicalFileSystem getFileSystem(WriteMode mode) {
        onFiles.accept(mode);
        return new WriteOnlyLogicalFileSystem(filesDir);
    }
}
