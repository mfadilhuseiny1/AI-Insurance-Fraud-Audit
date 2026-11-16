package com.palantir.transforms.excel.form.cellvalue;

import com.palantir.transforms.excel.form.Location;
import com.palantir.transforms.excel.utils.WorkbookUtils;
import java.util.Locale;
import java.util.Optional;
import org.apache.poi.ss.usermodel.Sheet;

/**
 * The cell `distance` cells left of / right of / above / below the field holds the expected label (compared trimmed
 * and case-insensitively), so a form whose layout moved fails instead of reading the wrong cell.
 */
public final class AdjacentCellAssertion implements CellAssertion {
    private static final long serialVersionUID = 1L;
    private final int rows;
    private final int columns;
    private final String expected;

    private AdjacentCellAssertion(int rows, int columns, String expected) {
        this.rows = rows;
        this.columns = columns;
        this.expected = expected;
    }

    public static AdjacentCellAssertion left(int distance, String expectedValue) {
        return new AdjacentCellAssertion(0, -distance, expectedValue);
    }

    public static AdjacentCellAssertion right(int distance, String expectedValue) {
        return new AdjacentCellAssertion(0, distance, expectedValue);
    }

    public static AdjacentCellAssertion above(int distance, String expectedValue) {
        return new AdjacentCellAssertion(-distance, 0, expectedValue);
    }

    public static AdjacentCellAssertion below(int distance, String expectedValue) {
        return new AdjacentCellAssertion(distance, 0, expectedValue);
    }

    @Override
    public Optional<String> check(Sheet sheet, Location location) {
        int r = location.row() + rows, c = location.column() + columns;
        if (r < 0 || c < 0) return Optional.of("no cell " + (rows != 0 ? Math.abs(rows) + " rows" : Math.abs(columns) + " columns") + " from " + location);
        String actual = WorkbookUtils.getValueAsString(sheet, r, c);
        String a = actual == null ? "" : actual.trim().toLowerCase(Locale.ROOT);
        if (a.equals(expected.trim().toLowerCase(Locale.ROOT))) return Optional.empty();
        return Optional.of("expected \"" + expected + "\" at " + Location.of(r, c) + " next to " + location + ", found " + (actual == null ? "an empty cell" : "\"" + actual + "\""));
    }
}
