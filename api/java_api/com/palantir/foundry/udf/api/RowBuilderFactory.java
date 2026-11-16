package com.palantir.foundry.udf.api;

/** Hands out row builders: generated input / output classes are created with create(ctx.getRowBuilderFactory()). */
public final class RowBuilderFactory {
    public static final RowBuilderFactory INSTANCE = new RowBuilderFactory();

    private RowBuilderFactory() {}
}
