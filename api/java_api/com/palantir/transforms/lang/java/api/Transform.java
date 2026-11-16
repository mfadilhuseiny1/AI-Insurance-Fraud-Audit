package com.palantir.transforms.lang.java.api;

import java.util.Map;

/** A registered transform: a compute function instance with its input and output aliases. */
public interface Transform {
    Object computeFunctionInstance();

    /** compute parameter name -> input dataset path */
    Map<String, String> parameterToInputAlias();

    /** compute parameter name -> output dataset path ("$return" for the returned DataFrame of a high-level transform) */
    Map<String, String> parameterToOutputAlias();

    boolean ignoreIncrementalDeletes();

    boolean useSchemaModificationType();
}
