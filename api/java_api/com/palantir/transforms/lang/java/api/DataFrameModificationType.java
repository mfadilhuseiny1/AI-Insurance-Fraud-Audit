package com.palantir.transforms.lang.java.api;

/** How an input dataset changed since the last build of the transform. */
public enum DataFrameModificationType {
    APPENDED,
    UPDATED,
    NEW_VIEW,
    UNCHANGED
}
