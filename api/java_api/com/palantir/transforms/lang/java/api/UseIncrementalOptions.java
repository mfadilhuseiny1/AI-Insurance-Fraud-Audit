package com.palantir.transforms.lang.java.api;

import java.lang.annotation.*;

/** Advanced incremental options of a low-level transform. */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface UseIncrementalOptions {
    IncrementalOptions[] value();
}
