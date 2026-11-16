package com.google.auto.service;

import java.lang.annotation.*;

/** Marks a service implementation (UDF factories). The runner finds implementations by their interfaces. */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
public @interface AutoService {
    Class<?>[] value();
}
