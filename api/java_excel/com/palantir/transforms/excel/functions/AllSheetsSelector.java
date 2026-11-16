package com.palantir.transforms.excel.functions;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;

/** Every sheet of the workbook. */
public final class AllSheetsSelector implements SheetSelector {
    private static final long serialVersionUID = 1L;

    @Override
    public Collection<Sheet> selectSheets(Workbook workbook) {
        List<Sheet> out = new ArrayList<>();
        workbook.forEach(out::add);
        return out;
    }
}
