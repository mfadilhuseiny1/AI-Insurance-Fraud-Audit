package com.palantir.foundry.udf.examples;

import com.palantir.foundry.udf.api.FoundryRowMapUdf;
import com.palantir.foundry.udf.api.RowBuilderFactory;
import java.util.List;

/**
 * The examples of a row map UDF (classes in the examples.registry package): shown with the UDF in Pipeline Builder
 * and run as tests. name() must return the UDF's name.
 */
public interface Examples<I, O, C> {
    String name();

    List<UdfExample<I, O, C>> examples();

    default FoundryRowMapUdf.Context ctx() {
        return () -> RowBuilderFactory.INSTANCE;
    }
}
