package com.palantir.transforms.excel.table;

import com.palantir.transforms.excel.utils.WorkbookUtils;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.util.CellReference;

/**
 * A header spanning several rows with merged cells (e.g. "Q1" over "Revenue" and "Cost"), from topLeftCellName to
 * bottomRightCellName: each column's name joins the values above it, top to bottom, with "_" (a merged cell repeats
 * over the columns it spans; repeated layers are not joined twice). Data starts on the row below.
 */
public final class MultilayerMergedHeaderExtractor implements HeaderExtractor {
    private static final long serialVersionUID = 1L;
    private final String topLeft;
    private final String bottomRight;
    private final String separator;
    private final CaseNormalizationOption casing;

    private MultilayerMergedHeaderExtractor(String topLeft, String bottomRight, String separator, CaseNormalizationOption casing) {
        this.topLeft = topLeft;
        this.bottomRight = bottomRight;
        this.separator = separator;
        this.casing = casing;
    }

    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String topLeft;
        private String bottomRight;
        private String separator = "_";
        private CaseNormalizationOption casing = CaseNormalizationOption.UNCHANGED;

        public Builder topLeftCellName(String name) {
            this.topLeft = name;
            return this;
        }

        public Builder bottomRightCellName(String name) {
            this.bottomRight = name;
            return this;
        }

        public Builder separator(String separator) {
            this.separator = separator;
            return this;
        }

        public Builder caseNormalizationOption(CaseNormalizationOption option) {
            this.casing = option;
            return this;
        }

        public MultilayerMergedHeaderExtractor build() {
            if (topLeft == null || bottomRight == null) throw new IllegalArgumentException("set topLeftCellName and bottomRightCellName");
            return new MultilayerMergedHeaderExtractor(topLeft, bottomRight, separator, casing);
        }
    }

    @Override
    public Optional<Header> extractHeader(Sheet sheet) {
        CellReference a = new CellReference(topLeft);
        CellReference b = new CellReference(bottomRight);
        int r0 = Math.min(a.getRow(), b.getRow()), r1 = Math.max(a.getRow(), b.getRow());
        int c0 = Math.min(a.getCol(), b.getCol()), c1 = Math.max(a.getCol(), b.getCol());
        List<String> names = new ArrayList<>();
        List<Integer> idx = new ArrayList<>();
        boolean any = false;
        for (int c = c0; c <= c1; c++) {
            List<String> parts = new ArrayList<>();
            for (int r = r0; r <= r1; r++) {
                String v = WorkbookUtils.getValueAsString(sheet, r, c);
                if (v != null && !v.isBlank() && (parts.isEmpty() || !parts.get(parts.size() - 1).equals(v.trim()))) parts.add(v.trim());
            }
            any |= !parts.isEmpty();
            names.add(String.join(separator, parts));
            idx.add(c);
        }
        if (!any) return Optional.empty();
        return Optional.of(Header.of(HeaderNames.clean(names, casing), idx, r1 + 1));
    }
}
