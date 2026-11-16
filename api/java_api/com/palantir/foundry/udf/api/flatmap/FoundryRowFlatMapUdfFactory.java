package com.palantir.foundry.udf.api.flatmap;

/** Creates a flat map UDF once per run, with the arguments chosen in Pipeline Builder. */
public interface FoundryRowFlatMapUdfFactory<C> {
    interface Arguments<C> {
        C config();
    }

    FoundryRowFlatMapUdf create(Arguments<C> args);
}
