package com.palantir.transforms.lang.java.api;

import com.palantir.spark.binarystream.data.PortableFile;
import com.palantir.util.syntacticpath.Path;
import com.palantir.util.syntacticpath.Paths;
import java.io.IOException;
import java.io.InputStream;
import java.io.Serializable;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.apache.spark.sql.Dataset;
import org.apache.spark.sql.Encoders;
import org.apache.spark.sql.SparkSession;

/** The files of an input dataset (for a read range): list them, read them, or spread them over Spark tasks. */
public final class ReadOnlyLogicalFileSystem implements Serializable {
    private static final long serialVersionUID = 1L;

    /** Reads an open input stream; may throw. */
    @FunctionalInterface
    public interface InputStreamFunction<T> extends Serializable {
        T apply(InputStream stream) throws IOException;
    }

    /** logical path -> local file holding its bytes */
    private final Map<String, String> files;

    ReadOnlyLogicalFileSystem(Map<String, String> files) {
        this.files = new LinkedHashMap<>(files);
    }

    /** Every file's logical path. */
    public Stream<Path> listAllFiles() {
        return files.keySet().stream().map(Paths::get);
    }

    /** Files whose logical path starts with a prefix ("dir/"); the glob "*" lists everything. */
    public Stream<Path> listFiles(String prefixOrGlob) {
        if (prefixOrGlob == null || prefixOrGlob.isEmpty() || prefixOrGlob.equals("*") || prefixOrGlob.equals("**")) return listAllFiles();
        String regex = prefixOrGlob.contains("*") ? prefixOrGlob.replace(".", "\\.").replace("**", ".+").replace("*", "[^/]*") : null;
        return files.keySet().stream().filter(p -> regex != null ? p.matches(regex) : p.startsWith(prefixOrGlob)).map(Paths::get);
    }

    public boolean exists(Path path) {
        return files.containsKey(path.toString());
    }

    /** Opens the file, passes the stream to `fn`, closes it and returns what `fn` returned. */
    public <T> T readFrom(Path path, InputStreamFunction<T> fn) {
        String local = files.get(path.toString());
        if (local == null) throw new IllegalArgumentException("No file " + path + " in the input");
        try (InputStream in = Files.newInputStream(java.nio.file.Paths.get(local))) {
            return fn.apply(in);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** The files as a Spark Dataset, one PortableFile per file, so tasks can process them in parallel. */
    public Dataset<PortableFile> filesAsDataset() {
        List<PortableFile> list = new ArrayList<>();
        files.forEach((logical, local) -> list.add(new PortableFile(logical, local)));
        SparkSession session = SparkSession.active();
        return session.createDataset(list, Encoders.javaSerialization(PortableFile.class));
    }
}
