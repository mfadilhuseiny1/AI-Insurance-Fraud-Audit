package com.palantir.foundry.udf.api;

/** Creates a row map UDF once per run, with the arguments chosen in Pipeline Builder. */
public interface FoundryRowMapUdfFactory<C> {
    interface Arguments<C> {
        C config();
    }

    FoundryRowMapUdf create(Arguments<C> args);
}
