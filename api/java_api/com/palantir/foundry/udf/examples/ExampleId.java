package com.palantir.foundry.udf.examples;

/** A unique id of an example within its UDF. */
public final class ExampleId {
    private final String id;

    private ExampleId(String id) {
        this.id = id;
    }

    public static ExampleId of(String id) {
        return new ExampleId(id);
    }

    public String get() {
        return id;
    }

    @Override
    public String toString() {
        return id;
    }
}
