package com.palantir.transforms.excel.utils;

import com.palantir.transforms.lang.java.api.FilesModificationType;
import com.palantir.transforms.lang.java.api.FoundryOutput;
import com.palantir.transforms.lang.java.api.WriteMode;
import org.apache.spark.sql.Dataset;
import org.apache.spark.sql.Row;

/** Incremental pipelines over Excel files. */
public final class IncrementalUtils {
    private IncrementalUtils() {}

    /**
     * Appends (an APPEND transaction) when only files were added since the last build; otherwise the input was rewritten or
     * seen for the first time, the unprocessed range holds every file, and the output is replaced (SNAPSHOT).
     */
    public static void writeAppendingIfPossible(FilesModificationType modificationType, Dataset<Row> dataframe, FoundryOutput output) {
        if (modificationType == FilesModificationType.APPENDED || modificationType == FilesModificationType.UNCHANGED) {
            output.getDataFrameWriter(dataframe).write(WriteMode.UPDATE);
        } else {
            output.getDataFrameWriter(dataframe).write(WriteMode.SNAPSHOT);
        }
    }
}
