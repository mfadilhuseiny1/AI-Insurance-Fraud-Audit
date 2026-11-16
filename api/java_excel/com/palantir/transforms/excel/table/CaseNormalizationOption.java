package com.palantir.transforms.excel.table;

/** How header names are cased; normalising matters with incremental processing across files with inconsistent casing. */
public enum CaseNormalizationOption {
    UNCHANGED,
    CONVERT_TO_LOWERCASE,
    CONVERT_TO_UPPERCASE
}
