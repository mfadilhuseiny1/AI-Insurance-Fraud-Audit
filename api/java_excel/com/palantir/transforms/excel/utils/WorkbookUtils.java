package com.palantir.transforms.excel.utils;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.WeakHashMap;
import org.apache.poi.ss.formula.eval.NotImplementedException;
import org.apache.poi.ss.formula.eval.NotImplementedFunctionException;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.CellType;
import org.apache.poi.ss.usermodel.CellValue;
import org.apache.poi.ss.usermodel.DataFormatter;
import org.apache.poi.ss.usermodel.Date1904Support;
import org.apache.poi.ss.usermodel.DateUtil;
import org.apache.poi.ss.usermodel.FormulaError;
import org.apache.poi.ss.usermodel.FormulaEvaluator;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.ss.util.CellRangeAddress;
import org.apache.poi.ss.util.CellReference;
import org.apache.poi.xssf.usermodel.XSSFCell;
import org.openxmlformats.schemas.spreadsheetml.x2006.main.CTCell;
import org.openxmlformats.schemas.spreadsheetml.x2006.main.STCellType;

/**
 * Cell helpers: values as strings (numbers without a trailing .0, dates as ISO, formulas by their cached result).
 * A formula without a cached result (a file written by a program that does not calculate, e.g. openpyxl) is
 * calculated here with POI's formula evaluator over the whole workbook (other sheets, ranges, defined names); when
 * it cannot be calculated (a function POI does not implement, a circular reference, a reference to another
 * workbook) the value is null and a warning is recorded for the current thread ({@link #drainWarnings()}).
 */
public final class WorkbookUtils {
    private WorkbookUtils() {}

    private static final int MAX_WARNINGS = 20;
    private static final Map<Workbook, FormulaEvaluator> EVALUATORS = Collections.synchronizedMap(new WeakHashMap<>());
    private static final ThreadLocal<Set<String>> WARNINGS = ThreadLocal.withInitial(LinkedHashSet::new);

    /** The warnings recorded on this thread since the last call (formulas that could not be calculated), cleared. */
    public static List<String> drainWarnings() {
        Set<String> w = WARNINGS.get();
        List<String> out = new ArrayList<>(w);
        w.clear();
        return out;
    }

    /** Forgets the formula evaluator kept for a workbook (call when done with it). */
    public static void release(Workbook workbook) {
        EVALUATORS.remove(workbook);
    }

    /** True for a formula cell whose file holds no result for it (an .xlsx {@code <c>} without a {@code <v>}). */
    public static boolean lacksCachedResult(Cell cell) {
        if (cell == null || cell.getCellType() != CellType.FORMULA || !(cell instanceof XSSFCell)) return false;
        CTCell ct = ((XSSFCell) cell).getCTCell();
        if (!ct.isSetV()) return true;
        // openpyxl writes <v></v>; an empty <v> is a real result only for a string formula (t="str")
        return ct.getV().isEmpty() && !(ct.isSetT() && ct.getT() == STCellType.STR);
    }

    /** A cell's value as a string, or null for a blank cell. */
    public static String getValueAsString(Cell cell) {
        if (cell == null) return null;
        if (lacksCachedResult(cell)) return calculated(cell);
        CellType type = cell.getCellType() == CellType.FORMULA ? cell.getCachedFormulaResultType() : cell.getCellType();
        switch (type) {
            case STRING:
                String s = cell.getStringCellValue();
                return s == null || s.isEmpty() ? null : s;
            case NUMERIC:
                if (DateUtil.isCellDateFormatted(cell)) {
                    java.time.LocalDateTime d = cell.getLocalDateTimeCellValue();
                    return d.toLocalTime().equals(java.time.LocalTime.MIDNIGHT) ? d.toLocalDate().toString() : d.toString();
                }
                return BigDecimal.valueOf(cell.getNumericCellValue()).stripTrailingZeros().toPlainString();
            case BOOLEAN:
                return Boolean.toString(cell.getBooleanCellValue());
            case ERROR:
                return new DataFormatter().formatCellValue(cell);
            default:
                return null;
        }
    }

    /** The value of a formula cell without a cached result, calculated now (null and a warning when it cannot be). */
    private static String calculated(Cell cell) {
        Workbook wb = cell.getSheet().getWorkbook();
        String where = "'" + cell.getSheet().getSheetName() + "'!" + cell.getAddress().formatAsString();
        CellValue v;
        try {
            FormulaEvaluator ev = EVALUATORS.computeIfAbsent(wb, w -> w.getCreationHelper().createFormulaEvaluator());
            v = ev.evaluate(cell);
        } catch (NotImplementedException e) {
            Throwable t = e;
            while (t != null && !(t instanceof NotImplementedFunctionException)) t = t.getCause();
            String fn = t == null ? null : ((NotImplementedFunctionException) t).getFunctionName();
            return warn(where, cell, fn == null ? "not supported: " + e.getMessage() : "unsupported function " + fn);
        } catch (RuntimeException e) {
            // FormulaParseException, a reference to another workbook, and the like
            return warn(where, cell, e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage()));
        }
        if (v == null) return null;
        switch (v.getCellType()) {
            case STRING:
                String s = v.getStringValue();
                return s == null || s.isEmpty() ? null : s;
            case NUMERIC:
                double d = v.getNumberValue();
                CellStyle style = cell.getCellStyle();
                if (style != null && DateUtil.isADateFormat(style.getDataFormat(), style.getDataFormatString())
                        && DateUtil.isValidExcelDate(d)) {
                    boolean d1904 = wb instanceof Date1904Support && ((Date1904Support) wb).isDate1904();
                    java.time.LocalDateTime t = DateUtil.getLocalDateTime(d, d1904);
                    return t.toLocalTime().equals(java.time.LocalTime.MIDNIGHT) ? t.toLocalDate().toString() : t.toString();
                }
                return BigDecimal.valueOf(d).stripTrailingZeros().toPlainString();
            case BOOLEAN:
                return Boolean.toString(v.getBooleanValue());
            case ERROR:
                int code = v.getErrorValue();
                if (code == FormulaError.CIRCULAR_REF.getCode()) return warn(where, cell, "circular reference");
                if (code == FormulaError.FUNCTION_NOT_IMPLEMENTED.getCode()) return warn(where, cell, "unsupported function");
                return FormulaError.isValidCode(code) ? FormulaError.forInt(code).getString() : "#VALUE!";
            default:
                return null;
        }
    }

    private static String warn(String where, Cell cell, String why) {
        Set<String> w = WARNINGS.get();
        if (w.size() < MAX_WARNINGS) {
            w.add("formula " + where + " (=" + cell.getCellFormula() + ") has no saved result and could not be calculated ("
                    + why + "); read as empty");
        }
        return null;
    }

    /** The value of the cell at a reference such as "B2" (a merged region gives its top-left cell's value). */
    public static Optional<String> getValueAsString(Sheet sheet, String cellName) {
        CellReference ref = new CellReference(cellName);
        return Optional.ofNullable(getValueAsString(sheet, ref.getRow(), ref.getCol()));
    }

    /** The value at (row, column), zero-based, looking through merged regions. */
    public static String getValueAsString(Sheet sheet, int row, int col) {
        for (CellRangeAddress m : sheet.getMergedRegions()) {
            if (m.isInRange(row, col)) {
                row = m.getFirstRow();
                col = m.getFirstColumn();
                break;
            }
        }
        Row r = sheet.getRow(row);
        return r == null ? null : getValueAsString(r.getCell(col));
    }
}
