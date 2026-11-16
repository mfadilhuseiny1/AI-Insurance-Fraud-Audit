package com.palantir.transforms.lang.java.api;

import java.util.Map;
import java.util.function.Supplier;
import org.apache.spark.sql.Dataset;
import org.apache.spark.sql.Row;

/** An input read as a Spark DataFrame: all of it, or only the rows added since (or processed by) the last build. */
public final class FoundryDataFrame {
    private final String alias;
    private final Map<ReadRange, Supplier<Dataset<Row>>> frames;
    private final DataFrameModificationType modification;
    private final SchemaModificationType schemaModification;

    FoundryDataFrame(String alias, Map<ReadRange, Supplier<Dataset<Row>>> frames, DataFrameModificationType modification, SchemaModificationType schemaModification) {
        this.alias = alias;
        this.frames = frames;
        this.modification = modification;
        this.schemaModification = schemaModification;
    }

    /** The whole current view of the dataset. */
    public Dataset<Row> read() {
        return readForRange(ReadRange.ENTIRE_VIEW);
    }

    public Dataset<Row> readForRange(ReadRange range) {
        return frames.get(range).get();
    }

    /** How the input changed since the transform last built. */
    public DataFrameModificationType modificationType() {
        return modification;
    }

    /** NEW_SCHEMA when the input schema changed and the transform uses IncrementalOptions.USE_SCHEMA_MODIFICATION_TYPE. */
    public SchemaModificationType schemaModificationType() {
        return schemaModification;
    }

    @Override
    public String toString() {
        return "FoundryDataFrame(" + alias + ", " + modification + ")";
    }
}
