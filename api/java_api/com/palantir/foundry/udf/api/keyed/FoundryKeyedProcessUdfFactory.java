package com.palantir.foundry.udf.api.keyed;

/** Creates a keyed process UDF once per run, with the arguments chosen in Pipeline Builder. */
public interface FoundryKeyedProcessUdfFactory<C> {
    interface Arguments<C> {
        C config();
    }

    FoundryKeyedProcessUdf create(Arguments<C> args);
}
