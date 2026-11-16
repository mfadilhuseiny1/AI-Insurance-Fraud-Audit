package com.palantir.transforms.lang.java.api;

/** SNAPSHOT replaces the output; UPDATE adds to it (downstream sees an APPENDED modification). */
public enum WriteMode {
    SNAPSHOT,
    UPDATE
}
