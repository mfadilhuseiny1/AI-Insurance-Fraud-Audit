package com.palantir.spark.binarystream.data;

import java.io.IOException;
import java.io.InputStream;
import java.io.Serializable;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Iterator;
import java.util.function.Function;

/** One file of an input dataset as a Spark task sees it (ReadOnlyLogicalFileSystem.filesAsDataset): its logical path and bytes. */
public final class PortableFile implements Serializable {
    private static final long serialVersionUID = 1L;

    /** Reads an open input stream; may throw. */
    @FunctionalInterface
    public interface InputStreamFunction<T> extends Serializable {
        T apply(InputStream stream) throws IOException;
    }

    private final String logicalPath;
    private final String localPath;

    public PortableFile(String logicalPath, String localPath) {
        this.logicalPath = logicalPath;
        this.localPath = localPath;
    }

    /** The file's path inside the dataset. */
    public String getLogicalPath() {
        return logicalPath;
    }

    /** Opens the file; the caller closes the stream. */
    public InputStream getInputStream() {
        try {
            return Files.newInputStream(Paths.get(localPath));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Opens the file, passes the stream to `fn`, closes it and returns what `fn` returned. */
    public <T> T convertToInputStream(InputStreamFunction<T> fn) {
        try (InputStream in = getInputStream()) {
            return fn.apply(in);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Reads the file into an iterator of values (e.g. its lines or records), for flatMap over files. */
    public <T> Iterator<T> convertToIterator(InputStreamFunction<Iterator<T>> fn) {
        return convertToInputStream(fn);
    }

    /** The bytes as one value. */
    public <T> T map(Function<byte[], T> fn) {
        return convertToInputStream(in -> fn.apply(in.readAllBytes()));
    }

    @Override
    public String toString() {
        return "PortableFile(" + logicalPath + ")";
    }
}
