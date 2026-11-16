package com.palantir.util.syntacticpath;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** A logical path inside a dataset's file system ("dir/file.csv"); purely syntactic, never touches a disk. */
public final class Path implements Serializable, Comparable<Path> {
    private static final long serialVersionUID = 1L;
    private final List<String> parts;

    Path(List<String> parts) {
        this.parts = parts;
    }

    static Path parse(String first, String... more) {
        List<String> out = new ArrayList<>();
        List<String> all = new ArrayList<>();
        all.add(first);
        all.addAll(Arrays.asList(more));
        for (String s : all) {
            for (String p : s.replace('\\', '/').split("/")) {
                if (p.isEmpty() || p.equals(".")) continue;
                if (p.equals("..")) {
                    if (!out.isEmpty()) out.remove(out.size() - 1);
                    continue;
                }
                out.add(p);
            }
        }
        return new Path(out);
    }

    public Path getFileName() {
        return parts.isEmpty() ? this : new Path(List.of(parts.get(parts.size() - 1)));
    }

    public Path getParent() {
        return parts.size() <= 1 ? null : new Path(new ArrayList<>(parts.subList(0, parts.size() - 1)));
    }

    public Path resolve(String other) {
        return parse(toString(), other);
    }

    public int getNameCount() {
        return parts.size();
    }

    public boolean startsWith(Path other) {
        return parts.size() >= other.parts.size() && parts.subList(0, other.parts.size()).equals(other.parts);
    }

    @Override
    public String toString() {
        return String.join("/", parts);
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof Path && ((Path) o).parts.equals(parts);
    }

    @Override
    public int hashCode() {
        return parts.hashCode();
    }

    @Override
    public int compareTo(Path o) {
        return toString().compareTo(o.toString());
    }
}
