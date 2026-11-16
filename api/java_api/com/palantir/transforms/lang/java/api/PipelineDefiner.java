package com.palantir.transforms.lang.java.api;

/**
 * Adds a project's transforms to its Pipeline. Each Java project implements one, named in
 * src/main/resources/META-INF/services/com.palantir.transforms.lang.java.api.PipelineDefiner.
 */
public interface PipelineDefiner {
    void define(Pipeline pipeline);
}
