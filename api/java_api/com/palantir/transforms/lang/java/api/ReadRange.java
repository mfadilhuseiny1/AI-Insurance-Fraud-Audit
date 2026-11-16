package com.palantir.transforms.lang.java.api;

/** Which rows (or files) of an input to read: added since the last build, already processed, or all. */
public enum ReadRange {
    UNPROCESSED,
    PROCESSED,
    ENTIRE_VIEW
}
