package com.palantir.transforms.excel;

import java.io.Serializable;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/** One extracted record: the sheet it came from and its values by column (strings; null for empty cells). */
public final class ParsedRecord implements Serializable {
    private static final long serialVersionUID = 1L;
    private final String sheetName;
    private final LinkedHashMap<String, String> values;

    public ParsedRecord(String sheetName, Map<String, String> values) {
        this.sheetName = sheetName;
        this.values = new LinkedHashMap<>(values);
    }

    public String sheetName() {
        return sheetName;
    }

    public Map<String, String> values() {
        return Collections.unmodifiableMap(values);
    }
}
