package com.palantir.transforms.excel.table;

import com.palantir.transforms.excel.utils.WorkbookUtils;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;

/** A one-row header after `rowsToSkip` rows (default 0): its non-empty cells name the columns up to the last one used. */
public final class SimpleHeaderExtractor implements HeaderExtractor {
    private static final long serialVersionUID = 1L;
    private final int rowsToSkip;
    private final CaseNormalizationOption casing;

    private SimpleHeaderExtractor(int rowsToSkip, CaseNormalizationOption casing) {
        this.rowsToSkip = rowsToSkip;
        this.casing = casing;
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private int rowsToSkip = 0;
        private CaseNormalizationOption casing = CaseNormalizationOption.UNCHANGED;

        public Builder rowsToSkip(int rows) {
            if (rows < 0) throw new IllegalArgumentException("rowsToSkip must be >= 0");
            this.rowsToSkip = rows;
            return this;
        }

        public Builder caseNormalizationOption(CaseNormalizationOption option) {
            this.casing = option;
            return this;
        }

        public SimpleHeaderExtractor build() {
            return new SimpleHeaderExtractor(rowsToSkip, casing);
        }
    }

    @Override
    public Optional<Header> extractHeader(Sheet sheet) {
        Row row = sheet.getRow(rowsToSkip);
        if (row == null || row.getLastCellNum() <= 0) return Optional.empty();
        List<String> names = new ArrayList<>();
        List<Integer> idx = new ArrayList<>();
        int last = -1;
        for (int c = 0; c < row.getLastCellNum(); c++) {
            if (WorkbookUtils.getValueAsString(sheet, rowsToSkip, c) != null) last = c;
        }
        if (last < 0) return Optional.empty();
        for (int c = 0; c <= last; c++) {
            names.add(WorkbookUtils.getValueAsString(sheet, rowsToSkip, c));
            idx.add(c);
        }
        return Optional.of(Header.of(HeaderNames.clean(names, casing), idx, rowsToSkip + 1));
    }
}
