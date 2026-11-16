package com.palantir.transforms.excel.table;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;

/** A table's header: the column names (by zero-based column index) and the first row holding data. */
public final class Header implements Serializable {
    private static final long serialVersionUID = 1L;
    private final List<String> columnNames;
    private final List<Integer> columnIndexes;
    private final int firstDataRowIndex;

    private Header(List<String> names, List<Integer> indexes, int firstDataRowIndex) {
        this.columnNames = List.copyOf(names);
        this.columnIndexes = List.copyOf(indexes);
        this.firstDataRowIndex = firstDataRowIndex;
    }

    /** Names for columns 0..n-1. */
    public static Header of(List<String> columnNames, int firstDataRowIndex) {
        List<Integer> idx = new ArrayList<>();
        for (int i = 0; i < columnNames.size(); i++) idx.add(i);
        return new Header(columnNames, idx, firstDataRowIndex);
    }

    /** Names for the given column indexes. */
    public static Header of(List<String> columnNames, List<Integer> columnIndexes, int firstDataRowIndex) {
        if (columnNames.size() != columnIndexes.size()) throw new IllegalArgumentException("one column index per name");
        return new Header(columnNames, columnIndexes, firstDataRowIndex);
    }

    public List<String> columnNames() {
        return columnNames;
    }

    public List<Integer> columnIndexes() {
        return columnIndexes;
    }

    public int firstDataRowIndex() {
        return firstDataRowIndex;
    }
}
