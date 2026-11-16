package com.palantir.transforms.lang.java.api;

import java.lang.annotation.*;

/** Cancels the job when it runs longer than this ISO 8601 duration (for example "PT2H"). */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface MaxAllowedDuration {
    String value();
}
