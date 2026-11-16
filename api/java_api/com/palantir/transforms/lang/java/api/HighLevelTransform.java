package com.palantir.transforms.lang.java.api;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/** A transform whose compute function takes Dataset<Row> inputs and returns the one output Dataset<Row>. */
public final class HighLevelTransform implements Transform {
    private final Object instance;
    private final Map<String, String> inputs;
    private final String output;

    private HighLevelTransform(Object instance, Map<String, String> inputs, String output) {
        this.instance = instance;
        this.inputs = inputs;
        this.output = output;
    }

    public static Builder builder() {
        return new Builder();
    }

    @Override
    public Object computeFunctionInstance() {
        return instance;
    }

    @Override
    public Map<String, String> parameterToInputAlias() {
        return Collections.unmodifiableMap(inputs);
    }

    @Override
    public Map<String, String> parameterToOutputAlias() {
        return Collections.singletonMap("$return", output);
    }

    @Override
    public boolean ignoreIncrementalDeletes() {
        return false;
    }

    @Override
    public boolean useSchemaModificationType() {
        return false;
    }

    public static final class Builder {
        private Object instance;
        private final Map<String, String> inputs = new LinkedHashMap<>();
        private String output;

        public Builder computeFunctionInstance(Object instance) {
            this.instance = instance;
            return this;
        }

        public Builder putParameterToInputAlias(String parameter, String datasetPath) {
            inputs.put(parameter, datasetPath);
            return this;
        }

        public Builder returnedAlias(String datasetPath) {
            this.output = datasetPath;
            return this;
        }

        public HighLevelTransform build() {
            if (instance == null) throw new IllegalStateException("computeFunctionInstance(...) is required");
            if (output == null) throw new IllegalStateException("returnedAlias(...) is required: a high-level transform has one output");
            return new HighLevelTransform(instance, inputs, output);
        }
    }
}
