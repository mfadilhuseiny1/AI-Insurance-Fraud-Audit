package com.palantir.util.syntacticpath;

/** Builds logical paths: Paths.get("dir", "file.csv"). */
public final class Paths {
    private Paths() {}

    public static Path get(String first, String... more) {
        return Path.parse(first, more);
    }
}
