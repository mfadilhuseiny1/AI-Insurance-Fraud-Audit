package com.palantir.transforms.excel.form.cellvalue;

import com.palantir.transforms.excel.form.Location;
import java.io.Serializable;
import java.util.Optional;
import org.apache.poi.ss.usermodel.Sheet;

/** A check made before a field's value is read; a failure (the message) is a parse error for the sheet. */
@FunctionalInterface
public interface CellAssertion extends Serializable {
    Optional<String> check(Sheet sheet, Location location);
}
