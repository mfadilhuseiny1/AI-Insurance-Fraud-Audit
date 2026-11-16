package com.palantir.transforms.excel;

import java.io.Serializable;
import java.util.List;
import org.apache.poi.ss.usermodel.Workbook;

/**
 * Extracts records from an open workbook: a {@link com.palantir.transforms.excel.table.TableParser} (rows under a
 * header) or a {@link com.palantir.transforms.excel.form.FormParser} (fields at fixed or labelled cells). Each record
 * is an ordered map of column name to string value; a parse error is thrown as an exception and lands in
 * {@link ParseResult#errorDataframe()}.
 */
public interface Parser extends Serializable {
    List<ParsedRecord> parse(Workbook workbook);
}
