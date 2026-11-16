package com.palantir.transforms.lang.java.api;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/** A transform whose compute function takes FoundryInput / FoundryOutput parameters and writes its outputs. */
public final class LowLevelTransform implements Transform {
    private final Object instance;
    private final Map<String, String> inputs;
    private final Map<String, String> outputs;
    private final boolean ignoreDeletes;
    private final boolean schemaModification;

    private LowLevelTransform(Builder b) {
        this.instance = b.instance;
        this.inputs = b.inputs;
        this.outputs = b.outputs;
        this.ignoreDeletes = b.ignoreDeletes;
        this.schemaModification = b.schemaModification;
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
        return Collections.unmodifiableMap(outputs);
    }

    @Override
    public boolean ignoreIncrementalDeletes() {
        return ignoreDeletes;
    }

    @Override
    public boolean useSchemaModificationType() {
        return schemaModification;
    }

    public static final class Builder {
        private Object instance;
        private final Map<String, String> inputs = new LinkedHashMap<>();
        private final Map<String, String> outputs = new LinkedHashMap<>();
        private boolean ignoreDeletes;
        private boolean schemaModification;

        public Builder computeFunctionInstance(Object instance) {
            this.instance = instance;
            return this;
        }

        public Builder putParameterToInputAlias(String parameter, String datasetPath) {
            inputs.put(parameter, datasetPath);
            return this;
        }

        public Builder putParameterToOutputAlias(String parameter, String datasetPath) {
            outputs.put(parameter, datasetPath);
            return this;
        }

        public Builder ignoreIncrementalDeletes(boolean on) {
            this.ignoreDeletes = on;
            return this;
        }

        public Builder useSchemaModificationType(boolean on) {
            this.schemaModification = on;
            return this;
        }

        public LowLevelTransform build() {
            if (instance == null) throw new IllegalStateException("computeFunctionInstance(...) is required");
            if (outputs.isEmpty()) throw new IllegalStateException("putParameterToOutputAlias(...) is required: name at least one output");
            return new LowLevelTransform(this);
        }
    }
}
