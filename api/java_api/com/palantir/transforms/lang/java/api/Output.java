package com.palantir.transforms.lang.java.api;

import java.lang.annotation.*;

/** The output dataset: on the compute method of a high-level transform, on a FoundryOutput parameter of a low-level one. */
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.METHOD, ElementType.PARAMETER})
public @interface Output {
    String value();
}
