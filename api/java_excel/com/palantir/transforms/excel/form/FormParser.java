package com.palantir.transforms.excel.form;

import com.palantir.transforms.excel.ParsedRecord;
import com.palantir.transforms.excel.Parser;
import com.palantir.transforms.excel.functions.FirstSheetSelector;
import com.palantir.transforms.excel.functions.SheetSelector;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;

/**
 * "Form-style" sheets: one record per selected sheet (default: the first) with a column per field spec, the value at
 * its cell. A failed assertion makes the whole sheet an error (in ParseResult.errorDataframe()).
 */
public final class FormParser implements Parser {
    private static final long serialVersionUID = 1L;
    private final SheetSelector sheetSelector;
    private final List<FieldSpec> fieldSpecs;

    private FormParser(SheetSelector sheetSelector, List<FieldSpec> fieldSpecs) {
        if (fieldSpecs.isEmpty()) throw new IllegalArgumentException("a FormParser needs at least one field spec");
        this.sheetSelector = sheetSelector;
        this.fieldSpecs = List.copyOf(fieldSpecs);
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private SheetSelector sheetSelector = new FirstSheetSelector();
        private final List<FieldSpec> fieldSpecs = new ArrayList<>();

        public Builder sheetSelector(SheetSelector selector) {
            this.sheetSelector = selector;
            return this;
        }

        public Builder addFieldSpecs(FieldSpec... specs) {
            for (FieldSpec s : specs) fieldSpecs.add(s);
            return this;
        }

        public Builder addAllFieldSpecs(Iterable<? extends FieldSpec> specs) {
            specs.forEach(fieldSpecs::add);
            return this;
        }

        public FormParser build() {
            return new FormParser(sheetSelector, fieldSpecs);
        }
    }

    @Override
    public List<ParsedRecord> parse(Workbook workbook) {
        List<ParsedRecord> out = new ArrayList<>();
        for (Sheet sheet : sheetSelector.selectSheets(workbook)) {
            Map<String, String> values = new LinkedHashMap<>();
            for (FieldSpec f : fieldSpecs) values.put(f.fieldName(), f.cellValue().extract(sheet, f.fieldName()));
            out.add(new ParsedRecord(sheet.getSheetName(), values));
        }
        return out;
    }
}
