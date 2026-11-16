package com.palantir.foundry.udf.api.flatmap;

import com.palantir.foundry.udf.api.RowBuilderFactory;
import java.util.Map;

/** A flat map UDF as the runtime calls it: one row in, zero or more rows out. */
public interface FoundryRowFlatMapUdf {
    interface Context {
        RowBuilderFactory getRowBuilderFactory();
    }

    void flatMap(Context ctx, Map<String, Object> row, Collector<Map<String, Object>> out) throws Exception;
}
