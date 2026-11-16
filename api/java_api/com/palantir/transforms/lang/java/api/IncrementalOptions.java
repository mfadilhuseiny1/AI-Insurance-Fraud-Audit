package com.palantir.transforms.lang.java.api;

/** IGNORE_INCREMENTAL_DELETES: rows removed upstream do not break incrementality. USE_SCHEMA_MODIFICATION_TYPE: a
 *  schema change reads as UNCHANGED with SchemaModificationType.NEW_SCHEMA instead of NEW_VIEW. */
public enum IncrementalOptions {
    IGNORE_INCREMENTAL_DELETES,
    USE_SCHEMA_MODIFICATION_TYPE
}
