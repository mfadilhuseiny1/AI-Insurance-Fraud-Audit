package com.palantir.transforms.excel.form;

import com.palantir.transforms.excel.form.cellvalue.CellValue;
import java.io.Serializable;
import java.util.Objects;

/** A form field: the output column name and where its value is. */
public final class FieldSpec implements Serializable {
    private static final long serialVersionUID = 1L;
    private final String fieldName;
    private final CellValue cellValue;

    private FieldSpec(String fieldName, CellValue cellValue) {
        this.fieldName = Objects.requireNonNull(fieldName);
        this.cellValue = Objects.requireNonNull(cellValue);
    }

    public static FieldSpec of(String fieldName, CellValue cellValue) {
        return new FieldSpec(fieldName, cellValue);
    }

    public String fieldName() {
        return fieldName;
    }

    public CellValue cellValue() {
        return cellValue;
    }
}
