package com.palantir.transforms.excel.functions;

import java.io.Serializable;
import java.util.Collection;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;

/** Which sheets of a workbook a parser reads (an empty collection is not an error: the parser finds nothing). */
@FunctionalInterface
public interface SheetSelector extends Serializable {
    Collection<Sheet> selectSheets(Workbook workbook);
}
