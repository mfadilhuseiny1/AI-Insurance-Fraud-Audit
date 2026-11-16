package com.palantir.transforms.lang.java.api;

import java.lang.annotation.*;

/** Marks the compute function of a transform: a public, non-static method. */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface Compute {}
