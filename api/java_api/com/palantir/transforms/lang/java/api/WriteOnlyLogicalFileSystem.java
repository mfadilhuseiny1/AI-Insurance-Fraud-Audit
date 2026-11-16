package com.palantir.transforms.lang.java.api;

import com.palantir.util.syntacticpath.Path;
import java.io.IOException;
import java.io.OutputStream;
import java.io.Serializable;
import java.io.UncheckedIOException;
import java.nio.file.Files;

/** The files of an output dataset: write each file once through an output stream. Usable from Spark tasks. */
public final class WriteOnlyLogicalFileSystem implements Serializable {
    private static final long serialVersionUID = 1L;

    /** Writes into an open output stream; may throw. The stream is closed afterwards. */
    @FunctionalInterface
    public interface OutputStreamConsumer extends Serializable {
        void accept(OutputStream stream) throws IOException;
    }

    private final String root;

    WriteOnlyLogicalFileSystem(String root) {
        this.root = root;
    }

    /** Writes the file at a logical path; writing the same path twice in one build fails. */
    public void writeTo(Path path, OutputStreamConsumer fn) {
        if (path.toString().isEmpty()) throw new IllegalArgumentException("writeTo needs a file path");
        java.nio.file.Path target = java.nio.file.Paths.get(root).resolve(path.toString().replace('/', java.io.File.separatorChar));
        try {
            Files.createDirectories(target.getParent());
            OutputStream out;
            try {
                out = Files.newOutputStream(target, java.nio.file.StandardOpenOption.CREATE_NEW);
            } catch (java.nio.file.FileAlreadyExistsException e) {
                throw new IllegalStateException("Attempted to produce the same output twice: " + path);
            }
            try (OutputStream o = out) {
                fn.accept(o);
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
