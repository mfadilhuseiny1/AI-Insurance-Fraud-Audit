package com.palantir.foundry.udf.api;

import java.util.Map;

/** A row map UDF as the runtime calls it: one row in, exactly one row out (generated adapters wrap the typed UDF). */
public interface FoundryRowMapUdf {
    interface Context {
        RowBuilderFactory getRowBuilderFactory();
    }

    Map<String, Object> map(Context ctx, Map<String, Object> row) throws Exception;
}
