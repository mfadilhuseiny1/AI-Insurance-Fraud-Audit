package com.palantir.transforms.lang.java.api;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** A project's transforms: registered one by one (register) or discovered in a package (autoBindFromPackage). */
public final class Pipeline {
    private final List<Transform> registered = new ArrayList<>();
    private final List<String> packages = new ArrayList<>();

    /** Every class in the package (and its subpackages) with an annotated @Compute method is added. */
    public void autoBindFromPackage(String packageName) {
        packages.add(packageName);
    }

    public void register(Transform transform) {
        registered.add(transform);
    }

    public List<Transform> registeredTransforms() {
        return Collections.unmodifiableList(registered);
    }

    public List<String> autoBoundPackages() {
        return Collections.unmodifiableList(packages);
    }
}
