package com.palantir.transforms.lang.java.api;

import java.lang.annotation.*;

/** Accepted for compatibility (automatic registration only): this server records it on the transform. */
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.METHOD, ElementType.PARAMETER})
public @interface StopPropagating {}
