package com.palantir.transforms.lang.java.api;

/** How the files of an input dataset changed since the last build of the transform. */
public enum FilesModificationType {
    APPENDED,
    UPDATED,
    NEW_VIEW,
    UNCHANGED
}
