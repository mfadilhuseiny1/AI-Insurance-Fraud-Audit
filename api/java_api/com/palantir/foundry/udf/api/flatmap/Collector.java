package com.palantir.foundry.udf.api.flatmap;

/** Receives the rows a flat map UDF outputs for one input row. */
public interface Collector<T> {
    void collect(T row);
}
