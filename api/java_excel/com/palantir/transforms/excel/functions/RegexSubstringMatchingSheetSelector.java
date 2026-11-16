package com.palantir.transforms.excel.functions;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.regex.Pattern;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;

/** Every sheet whose name contains a match of the regular expression. */
public final class RegexSubstringMatchingSheetSelector implements SheetSelector {
    private static final long serialVersionUID = 1L;
    private final String regex;

    public RegexSubstringMatchingSheetSelector(String regex) {
        this.regex = regex;
        Pattern.compile(regex);
    }

    @Override
    public Collection<Sheet> selectSheets(Workbook workbook) {
        Pattern p = Pattern.compile(regex);
        List<Sheet> out = new ArrayList<>();
        for (Sheet s : workbook) {
            if (p.matcher(s.getSheetName()).find()) out.add(s);
        }
        return out;
    }
}
