package com.palantir.transforms.excel.table;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Header names as columns: trimmed, inner whitespace collapsed, cased, blanks named column_N, duplicates suffixed _2, _3. */
final class HeaderNames {
    private HeaderNames() {}

    static List<String> clean(List<String> raw, CaseNormalizationOption casing) {
        List<String> out = new ArrayList<>();
        Map<String, Integer> seen = new HashMap<>();
        for (int i = 0; i < raw.size(); i++) {
            String n = raw.get(i) == null ? "" : raw.get(i).trim().replaceAll("\\s+", " ");
            if (n.isEmpty()) n = "column_" + (i + 1);
            if (casing == CaseNormalizationOption.CONVERT_TO_LOWERCASE) n = n.toLowerCase(Locale.ROOT);
            if (casing == CaseNormalizationOption.CONVERT_TO_UPPERCASE) n = n.toUpperCase(Locale.ROOT);
            int c = seen.merge(n.toLowerCase(Locale.ROOT), 1, Integer::sum);
            out.add(c == 1 ? n : n + "_" + c);
        }
        return out;
    }
}
