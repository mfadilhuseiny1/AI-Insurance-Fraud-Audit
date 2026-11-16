package com.palantir.transforms.excel.table;

import java.io.Serializable;
import java.util.Optional;
import org.apache.poi.ss.usermodel.Sheet;

/** Finds a sheet's table header; empty when the sheet holds no table (not an error). */
@FunctionalInterface
public interface HeaderExtractor extends Serializable {
    Optional<Header> extractHeader(Sheet sheet);
}
