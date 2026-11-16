package com.palantir.foundry.udf.examples;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** One example: arguments, input rows and the output rows the UDF must produce for them. */
public final class UdfExample<I, O, C> {
    private final ExampleId id;
    private final String description;
    private final ExampleVisibility visibility;
    private final ExampleCategory category;
    private final C configuration;
    private final List<I> input;
    private final List<O> output;

    private UdfExample(Builder<I, O, C> b) {
        this.id = b.id;
        this.description = b.description;
        this.visibility = b.visibility;
        this.category = b.category;
        this.configuration = b.configuration;
        this.input = Collections.unmodifiableList(b.input);
        this.output = Collections.unmodifiableList(b.output);
    }

    public static <I, O, C> Builder<I, O, C> builder() {
        return new Builder<>();
    }

    public ExampleId id() { return id; }
    public String description() { return description; }
    public ExampleVisibility visibility() { return visibility; }
    public ExampleCategory category() { return category; }
    public C configuration() { return configuration; }
    public List<I> input() { return input; }
    public List<O> output() { return output; }

    public static final class Builder<I, O, C> {
        private ExampleId id;
        private String description = "";
        private ExampleVisibility visibility = ExampleVisibility.DEFAULT;
        private ExampleCategory category = ExampleCategory.BASE;
        private C configuration;
        private final List<I> input = new ArrayList<>();
        private final List<O> output = new ArrayList<>();

        public Builder<I, O, C> id(ExampleId id) { this.id = id; return this; }
        public Builder<I, O, C> description(String d) { this.description = d; return this; }
        public Builder<I, O, C> visibility(ExampleVisibility v) { this.visibility = v; return this; }
        public Builder<I, O, C> category(ExampleCategory c) { this.category = c; return this; }
        public Builder<I, O, C> configuration(C c) { this.configuration = c; return this; }
        @SafeVarargs
        public final Builder<I, O, C> input(I... rows) { input.addAll(Arrays.asList(rows)); return this; }
        @SafeVarargs
        public final Builder<I, O, C> output(O... rows) { output.addAll(Arrays.asList(rows)); return this; }

        public UdfExample<I, O, C> build() {
            if (id == null) throw new IllegalStateException("an example needs an id");
            return new UdfExample<>(this);
        }
    }
}
