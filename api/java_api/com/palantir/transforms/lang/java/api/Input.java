package com.palantir.transforms.lang.java.api;

import java.lang.annotation.*;

/** An input dataset of an automatically registered transform: a Files path or item id. */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.PARAMETER)
public @interface Input {
    String value();
}
