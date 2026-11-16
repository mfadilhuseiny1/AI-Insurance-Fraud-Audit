package com.palantir.transforms.excel.form.cellvalue;

import com.palantir.transforms.excel.form.Location;
import com.palantir.transforms.excel.utils.WorkbookUtils;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import org.apache.poi.ss.usermodel.Sheet;

/** Where a form field's value is (a cell) and the assertions that must hold before it is read. */
public final class CellValue implements Serializable {
    private static final long serialVersionUID = 1L;
    private final Location location;
    private final List<CellAssertion> assertions;

    private CellValue(Location location, List<CellAssertion> assertions) {
        this.location = Objects.requireNonNull(location, "location");
        this.assertions = List.copyOf(assertions);
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private Location location;
        private final List<CellAssertion> assertions = new ArrayList<>();

        public Builder location(Location location) {
            this.location = location;
            return this;
        }

        public Builder addAssertions(CellAssertion... more) {
            for (CellAssertion a : more) assertions.add(a);
            return this;
        }

        public Builder addAllAssertions(Iterable<? extends CellAssertion> more) {
            more.forEach(assertions::add);
            return this;
        }

        public CellValue build() {
            return new CellValue(location, assertions);
        }
    }

    public Location location() {
        return location;
    }

    /** The value (null when empty); IllegalStateException with every failed assertion. */
    public String extract(Sheet sheet, String fieldName) {
        List<String> failed = new ArrayList<>();
        for (CellAssertion a : assertions) a.check(sheet, location).ifPresent(failed::add);
        if (!failed.isEmpty()) {
            throw new IllegalStateException("sheet \"" + sheet.getSheetName() + "\", field " + fieldName + ": " + String.join("; ", failed));
        }
        return WorkbookUtils.getValueAsString(sheet, location.row(), location.column());
    }
}
