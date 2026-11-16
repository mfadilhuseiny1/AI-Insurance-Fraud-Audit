package com.palantir.transforms.lang.java.api;

import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import org.apache.spark.sql.Dataset;
import org.apache.spark.sql.Row;

/** An input dataset of a low-level transform: as a DataFrame (asDataFrame) or as files (asFiles). */
public final class FoundryInput {
    private final String alias;
    private final FoundryDataFrame dataFrame;
    private final FoundryFiles files;

    /** Built by the runner. */
    public FoundryInput(String alias, Map<ReadRange, Supplier<Dataset<Row>>> frames, DataFrameModificationType modification,
            SchemaModificationType schemaModification, Map<String, String> allFiles, Set<String> processedFiles, FilesModificationType filesModification) {
        this.alias = alias;
        this.dataFrame = frames == null ? null : new FoundryDataFrame(alias, frames, modification, schemaModification);
        this.files = new FoundryFiles(allFiles, processedFiles, filesModification);
    }

    /** The dataset's path or item id, as given to @Input. */
    public String getDatasetPath() {
        return alias;
    }

    public FoundryDataFrame asDataFrame() {
        if (dataFrame == null) throw new IllegalStateException("Input " + alias + " is a folder of files, not a tabular dataset: read it with asFiles()");
        return dataFrame;
    }

    public FoundryFiles asFiles() {
        return files;
    }
}
