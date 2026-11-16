package com.palantir.transforms.excel;

import java.io.Serializable;

/** A record (or an error) tagged with the key of the parser that produced it and the file it came from. */
public final class KeyedParsedRecord implements Serializable {
    private static final long serialVersionUID = 1L;
    private final String key;
    private final String filePath;
    private final ParsedRecord record;
    private final String error;

    private KeyedParsedRecord(String key, String filePath, ParsedRecord record, String error) {
        this.key = key;
        this.filePath = filePath;
        this.record = record;
        this.error = error;
    }

    public static KeyedParsedRecord of(String key, String filePath, ParsedRecord record) {
        return new KeyedParsedRecord(key, filePath, record, null);
    }

    public static KeyedParsedRecord error(String key, String filePath, String error) {
        return new KeyedParsedRecord(key, filePath, null, error);
    }

    public String key() {
        return key;
    }

    public String filePath() {
        return filePath;
    }

    public ParsedRecord record() {
        return record;
    }

    public String error() {
        return error;
    }

    public boolean isError() {
        return error != null;
    }
}
