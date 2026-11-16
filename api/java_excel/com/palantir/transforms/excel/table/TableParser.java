package com.palantir.transforms.excel.table;

import com.palantir.transforms.excel.ParsedRecord;
import com.palantir.transforms.excel.Parser;
import com.palantir.transforms.excel.functions.FirstSheetSelector;
import com.palantir.transforms.excel.functions.SheetSelector;
import com.palantir.transforms.excel.utils.WorkbookUtils;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;

/**
 * Rows of a table: for each selected sheet (default: the first), the header extractor (default: a SimpleHeaderExtractor
 * on the first row) names the columns, and every following row with at least one value becomes a record, until
 * `stopAtFirstEmptyRow` (off by default) sees an empty row. TableParser.builder().build() reads a plain sheet.
 */
public final class TableParser implements Parser {
    private static final long serialVersionUID = 1L;
    private final HeaderExtractor headerExtractor;
    private final SheetSelector sheetSelector;
    private final boolean stopAtFirstEmptyRow;

    private TableParser(HeaderExtractor headerExtractor, SheetSelector sheetSelector, boolean stopAtFirstEmptyRow) {
        this.headerExtractor = headerExtractor;
        this.sheetSelector = sheetSelector;
        this.stopAtFirstEmptyRow = stopAtFirstEmptyRow;
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private HeaderExtractor headerExtractor = SimpleHeaderExtractor.builder().build();
        private SheetSelector sheetSelector = new FirstSheetSelector();
        private boolean stopAtFirstEmptyRow = false;

        public Builder headerExtractor(HeaderExtractor extractor) {
            this.headerExtractor = extractor;
            return this;
        }

        public Builder sheetSelector(SheetSelector selector) {
            this.sheetSelector = selector;
            return this;
        }

        public Builder stopAtFirstEmptyRow(boolean stop) {
            this.stopAtFirstEmptyRow = stop;
            return this;
        }

        public TableParser build() {
            return new TableParser(headerExtractor, sheetSelector, stopAtFirstEmptyRow);
        }
    }

    @Override
    public List<ParsedRecord> parse(Workbook workbook) {
        List<ParsedRecord> out = new ArrayList<>();
        for (Sheet sheet : sheetSelector.selectSheets(workbook)) {
            Optional<Header> header = headerExtractor.extractHeader(sheet);
            if (header.isEmpty()) continue;
            Header h = header.get();
            for (int r = h.firstDataRowIndex(); r <= sheet.getLastRowNum(); r++) {
                Map<String, String> values = new LinkedHashMap<>();
                boolean any = false;
                for (int i = 0; i < h.columnNames().size(); i++) {
                    String v = WorkbookUtils.getValueAsString(sheet, r, h.columnIndexes().get(i));
                    any |= v != null;
                    values.put(h.columnNames().get(i), v);
                }
                if (!any) {
                    if (stopAtFirstEmptyRow) break;
                    continue;
                }
                out.add(new ParsedRecord(sheet.getSheetName(), values));
            }
        }
        return out;
    }
}
