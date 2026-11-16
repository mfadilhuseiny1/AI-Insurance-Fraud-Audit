package com.palantir.transforms.excel.functions;

import java.util.Collection;
import java.util.List;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;

/** The first sheet (the default of TableParser and FormParser). */
public final class FirstSheetSelector implements SheetSelector {
    private static final long serialVersionUID = 1L;

    @Override
    public Collection<Sheet> selectSheets(Workbook workbook) {
        return workbook.getNumberOfSheets() == 0 ? List.of() : List.of(workbook.getSheetAt(0));
    }
}
