package com.palantir.transforms.excel.form;

import java.io.Serializable;
import org.apache.poi.ss.util.CellReference;

/** A cell of a sheet, from its name ("B2") or zero-based row and column. */
public final class Location implements Serializable {
    private static final long serialVersionUID = 1L;
    private final int row;
    private final int column;

    private Location(int row, int column) {
        if (row < 0 || column < 0) throw new IllegalArgumentException("row and column must be >= 0");
        this.row = row;
        this.column = column;
    }

    public static Location of(String cellName) {
        CellReference ref = new CellReference(cellName);
        return new Location(ref.getRow(), ref.getCol());
    }

    public static Location of(int row, int column) {
        return new Location(row, column);
    }

    public int row() {
        return row;
    }

    public int column() {
        return column;
    }

    /** This location moved by rows / columns (may be negative). */
    public Location offset(int rows, int columns) {
        return new Location(row + rows, column + columns);
    }

    public String cellName() {
        return new CellReference(row, column).formatAsString(false);
    }

    @Override
    public String toString() {
        return cellName();
    }
}
