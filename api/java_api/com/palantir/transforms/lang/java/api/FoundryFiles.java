package com.palantir.transforms.lang.java.api;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** An input read as files: for a tabular dataset its file, for a folder (media set) the files in it. */
public final class FoundryFiles {
    private final Map<String, String> all;
    private final Set<String> processed;
    private final FilesModificationType modification;

    FoundryFiles(Map<String, String> all, Set<String> processed, FilesModificationType modification) {
        this.all = all;
        this.processed = processed;
        this.modification = modification;
    }

    /** Every file of the current view. */
    public ReadOnlyLogicalFileSystem getFileSystem() {
        return getFileSystem(ReadRange.ENTIRE_VIEW);
    }

    /** UNPROCESSED: files added since the last build; PROCESSED: files the last build read; ENTIRE_VIEW: all. */
    public ReadOnlyLogicalFileSystem getFileSystem(ReadRange range) {
        Map<String, String> chosen = new LinkedHashMap<>();
        all.forEach((logical, local) -> {
            boolean seen = processed.contains(logical);
            if (range == ReadRange.ENTIRE_VIEW || (range == ReadRange.PROCESSED) == seen) chosen.put(logical, local);
        });
        return new ReadOnlyLogicalFileSystem(chosen);
    }

    public FilesModificationType modificationType() {
        return modification;
    }
}
