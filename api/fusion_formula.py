"""Fusion's formula engine: cell values of a spreadsheet document (fusion.py).

A cell holds what the user typed: a plain value (numbers become numbers) or a formula starting with "=". Formulas use
Fusion's syntax — single quotes for strings ('text'), `==` (or `=`) for equality, `AND` / `OR` / `NOT`, cell
references (A1, A1:C3, Sheet2!A1, 'My sheet'!A1:B2) — and a function library: math, logic, text, dates, arrays,
`lookup*` on Foundry (Files) datasets, `object_lookup` / `object_dropdown` and the object functions (`object`,
`object_set`, `get_property`, `get_object_rid`, `get_object_type_id`) on Ontology objects, `dropdown` /
`multidropdown`, `url`, `color`, `tooltip`, the validation functions (`column_enum`, `column_not_null`,
`column_numeric`, `table_headers`, `table_key`) and the Action functions (`action.copy`, `action.toast`,
`action.submit_to_region`, `action.serial`, `action.parallel`, `action.trigger`, `action.label`,
`action.apply_action`). Rich results (dropdowns, buttons, links, styled values) are dicts with a "__kind__" key; a
cell referring to one of them sees its plain value. Errors are values too ({"__kind__": "error"}), shown as #ERROR.
"""

from __future__ import annotations

import datetime as dt
import math
import re
from typing import Any, Callable, Optional

MAX_LOOKUP = 2000
CELL = re.compile(r"^([A-Z]{1,3})([1-9][0-9]{0,5})$")


class FusionError(Exception):
    pass


class SpillError(FusionError):
    """A 2-D result that cannot spill over the cells beside it (shown as #SPILL!)."""


class RefError(FusionError):
    """A reference to something that is not there: A1# where A1 does not spill (shown as #REF!)."""


class NAError(FusionError):
    """No value (shown as #N/A, as in Excel): na(), a lookup that finds nothing (vlookup, hlookup, match, xmatch,
    xlookup), the cells vstack / hstack / wraprows / wrapcols / expand / textsplit pad without a pad value."""


class CalcError(FusionError):
    """A calculation without a result (shown as #CALC!, as in Excel): an empty array (filter matching nothing,
    sequence(0), take(…, 0)), several values where a lambda should give one, a lambda that is never called."""


_ERROR_CODES: dict[Optional[str], type] = {"spill": SpillError, "ref": RefError, "na": NAError, "calc": CalcError}
# What a cell holding an error shows; any other error shows #ERROR. The same table is in web/src/lib/fusion.ts (ERROR_TEXT).
ERROR_TEXT = {"spill": "#SPILL!", "ref": "#REF!", "na": "#N/A", "calc": "#CALC!"}


OMITTED = "\x00omitted"  # the key in a lambda's names holding the parameters it was called without


class _Pending(Exception):
    """Raised while a cell is computed ahead of its turn (to learn whether its result spills into an empty cell being
    read) and it needs a cell that is still being computed: the attempt is dropped — nothing is remembered — and the
    cell is computed again in its turn. Not a FusionError, so no formula (iferror …) can catch it."""


def col_index(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def col_letters(i: int) -> str:
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def parse_addr(a: str) -> tuple[int, int]:
    m = CELL.match(a.upper())
    if not m:
        raise FusionError(f"not a cell: {a}")
    return int(m.group(2)) - 1, col_index(m.group(1))


def addr(r: int, c: int) -> str:
    return f"{col_letters(c)}{r + 1}"


def range_cells(a: str, b: str) -> list[list[str]]:
    r1, c1 = parse_addr(a)
    r2, c2 = parse_addr(b)
    r1, r2 = sorted((r1, r2))
    c1, c2 = sorted((c1, c2))
    if (r2 - r1 + 1) * (c2 - c1 + 1) > 200_000:
        raise FusionError("the range is too large")
    return [[addr(r, c) for c in range(c1, c2 + 1)] for r in range(r1, r2 + 1)]


# ------------------------------------------------------------------ values


class Range:
    """A rectangular block of values (rows of columns)."""

    def __init__(self, rows: list[list[Any]], sheet: str = "", cells: Optional[list[list[str]]] = None) -> None:
        self.rows, self.sheet, self.cells = rows, sheet, cells or []

    def flat(self) -> list[Any]:
        return [v for row in self.rows for v in row]


class Matrix(Range):
    """A computed two-dimensional result (transpose, mmult, linest …): a range to the functions that take it, and a
    result that spills over the neighbouring cells when it is what a cell's formula gives."""


def plain(v: Any) -> Any:
    """The value a reference sees: a dropdown's selection, a styled value's value."""
    if isinstance(v, dict) and "__kind__" in v:
        k = v["__kind__"]
        if k in ("dropdown", "checkbox", "datepicker"):
            return v.get("value")
        if k == "matrix":
            # the cell a spilled result starts in holds its top-left value
            rows = v.get("rows") or [[None]]
            return plain(rows[0][0]) if rows[0] else None
        if k in ("styled", "url", "modifier", "property"):
            return v.get("value")
        if k == "error":
            # a cell reading a #SPILL! (#REF!) cell shows #SPILL! (#REF!) too
            raise _ERROR_CODES.get(v.get("code"), FusionError)(v.get("message") or "error in a referenced cell")
        if k == "array":
            return v.get("items")
    return v


def flat(args: list[Any]) -> list[Any]:
    out: list[Any] = []
    for a in args:
        if isinstance(a, Range):
            out.extend(plain(x) for x in a.flat())
        elif isinstance(a, list):
            out.extend(flat(a))
        else:
            p = plain(a)
            if isinstance(p, list):
                out.extend(p)
            else:
                out.append(p)
    return out


def num(v: Any) -> Optional[float]:
    v = plain(v)
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return None


def nums(args: list[Any]) -> list[float]:
    return [x for x in (num(v) for v in flat(args)) if x is not None]


def clean_number(x: float) -> Any:
    if isinstance(x, float) and x.is_integer() and abs(x) < 1e15:
        return int(x)
    return x


def truthy(v: Any) -> bool:
    v = plain(v)
    if isinstance(v, str):
        return v.strip().lower() not in ("", "false", "0", "no")
    return bool(v)


def literal(text: str) -> Any:
    """What a typed (non-formula) cell holds."""
    s = text.strip()
    if s == "":
        return None
    if re.fullmatch(r"-?\d+", s):
        return int(s)
    if re.fullmatch(r"-?(\d+\.\d*|\.\d+|\d+)([eE]-?\d+)?", s):
        return float(s)
    return text


# ------------------------------------------------------------------ tokens and parser

TOKEN = re.compile(r"""
    (?P<ws>\s+)
  | (?P<num>\d+\.\d*|\.\d+|\d+)
  | (?P<sref>'(?:[^']|'')+'!(?!=))
  | (?P<str>'(?:[^']|'')*')
  | (?P<dstr>"(?:[^"]|"")*")
  | (?P<op><=|>=|==|!=|<>|&&|\|\||[-+*/^%&<>=(),:!{};#])
  | (?P<aref>(?:\$[A-Za-z]{1,3}\$?|[A-Za-z]{1,3}\$)[1-9][0-9]{0,5}(?![A-Za-z0-9_.$]))
  | (?P<name>[A-Za-z_][A-Za-z0-9_.]*)
""", re.X)


def tokenize(src: str) -> list[tuple[str, str]]:
    out, i = [], 0
    while i < len(src):
        m = TOKEN.match(src, i)
        if not m:
            raise FusionError(f"unexpected character {src[i]!r}")
        i = m.end()
        kind = m.lastgroup
        if kind == "ws":
            continue
        if kind == "aref":
            # $A$1, $A1, A$1: the same cell as A1 — the $ only says which part stays when the formula is shifted
            out.append(("name", m.group().replace("$", "")))
            continue
        out.append((kind, m.group()))
    out.append(("end", ""))
    return out


class Parser:
    def __init__(self, src: str) -> None:
        self.t = tokenize(src)
        self.i = 0
        self.scope: list[str] = []  # the names let() and lambda() have bound around the expression being read

    def peek(self, k: int = 0) -> tuple[str, str]:
        return self.t[min(self.i + k, len(self.t) - 1)]

    def take(self, value: Optional[str] = None) -> tuple[str, str]:
        tok = self.t[self.i]
        if value is not None and tok[1].upper() != value.upper():
            raise FusionError(f"expected {value!r}, found {tok[1] or 'the end'!r}")
        self.i += 1
        return tok

    def parse(self) -> Any:
        node = self.expr()
        if self.peek()[0] != "end":
            raise FusionError(f"unexpected {self.peek()[1]!r}")
        return node

    def expr(self) -> Any:
        return self.or_()

    def or_(self) -> Any:
        node = self.and_()
        while self.peek()[1].upper() in ("OR", "||"):
            self.take()
            node = ("or", node, self.and_())
        return node

    def and_(self) -> Any:
        node = self.not_()
        while self.peek()[1].upper() in ("AND", "&&"):
            self.take()
            node = ("and", node, self.not_())
        return node

    def not_(self) -> Any:
        if self.peek()[1].upper() == "NOT":
            self.take()
            return ("not", self.not_())
        return self.cmp()

    def cmp(self) -> Any:
        node = self.concat()
        while self.peek()[1] in ("==", "=", "!=", "<>", "<", ">", "<=", ">="):
            op = self.take()[1]
            node = ("cmp", {"=": "==", "<>": "!="}.get(op, op), node, self.concat())
        return node

    def concat(self) -> Any:
        node = self.add()
        while self.peek()[1] == "&":
            self.take()
            node = ("concat", node, self.add())
        return node

    def add(self) -> Any:
        node = self.mul()
        while self.peek()[1] in ("+", "-"):
            op = self.take()[1]
            node = ("bin", op, node, self.mul())
        return node

    def mul(self) -> Any:
        node = self.unary()
        while self.peek()[1] in ("*", "/", "%"):
            op = self.take()[1]
            node = ("bin", op, node, self.unary())
        return node

    def unary(self) -> Any:
        if self.peek()[1] == "-":
            self.take()
            return ("neg", self.unary())
        if self.peek()[1] == "+":
            self.take()
            return self.unary()
        return self.pow()

    def pow(self) -> Any:
        node = self.primary()
        if self.peek()[1] == "^":
            self.take()
            node = ("bin", "^", node, self.unary())
        return node

    def primary(self) -> Any:
        kind, val = self.peek()
        if kind == "num":
            self.take()
            return ("lit", float(val) if "." in val else int(val))
        if kind in ("str", "dstr"):
            self.take()
            q = val[0]
            return ("lit", val[1:-1].replace(q + q, q))
        if val == "(":
            self.take()
            node = self.expr()
            self.take(")")
            return node
        if val == "{":
            # an inline array: "," goes to the next column, ";" to the next row, as in Excel — {1, 2, 3} is a row,
            # {1; 2; 3} a column, {1, 2; 3, 4} two rows; a single value {5} stays a one-cell array, like array(5)
            self.take()
            rows: list[list[Any]] = [[]]
            while self.peek()[1] != "}":
                if self.peek()[0] == "end":
                    raise FusionError("expected '}' at the end of the array")
                rows[-1].append(self.expr())
                if self.peek()[1] == ",":
                    self.take()
                elif self.peek()[1] == ";":
                    self.take()
                    rows.append([])
            self.take("}")
            if len(rows) == 1 and len(rows[0]) < 2:
                return ("call", "array", rows[0])
            return ("rows", rows)
        if kind == "sref":
            self.take()
            sheet = val[1:-2].replace("''", "'")
            return self.ref(sheet)
        if kind == "name":
            # Sheet2!A1
            if self.peek(1)[1] == "!":
                self.take()
                self.take("!")
                return self.ref(val)
            if val.lower() in self.scope:
                # a name bound by let() / lambda(); name(…) calls the lambda it holds
                self.take()
                return self.applied(("var", val.lower()))
            if CELL.match(val.upper()) and self.peek(1)[1] != "(":
                return self.ref(None)
            self.take()
            low = val.lower()
            if self.peek()[1] == "(":
                if low in ("let", "lambda"):
                    return self.binder(low)
                return ("call", low, self.args(val))
            if low == "true":
                return ("lit", True)
            if low == "false":
                return ("lit", False)
            if low == "null":
                return ("lit", None)
            raise FusionError(f"unknown name {val}")
        raise FusionError(f"unexpected {val or 'end of formula'!r}")

    def args(self, name: str) -> list[Any]:
        self.take("(")
        args = []
        while self.peek()[1] != ")":
            if self.peek()[1] in (",", ";"):
                # an argument left out: sort(A1:A5, , -1), reduce(, A1:A3, …) — null, as if written so (marked, for
                # isomitted() in a lambda called so)
                args.append(("lit", None, "omitted"))
                self.take()
                continue
            args.append(self.expr())
            if self.peek()[1] in (",", ";"):
                self.take()
            elif self.peek()[1] != ")":
                raise FusionError(f"expected ',' or ')' in {name}(…)")
        self.take(")")
        return args

    def applied(self, node: Any) -> Any:
        """node(…)(…): a lambda called with arguments."""
        while self.peek()[1] == "(":
            node = ("apply", node, self.args("a lambda"))
        return node

    def binder(self, low: str) -> Any:
        """let(name, value, [name, value …], expression) and lambda(parameter …, expression): a name followed by a
        comma is bound for what comes after it; the last argument is the expression."""
        self.take("(")
        bound: list[tuple[str, Any]] = []
        depth = len(self.scope)
        while self.peek()[0] == "name" and self.peek(1)[1] in (",", ";"):
            name = self.take()[1].lower()
            self.take()
            if low == "let":
                value = self.expr()
                if self.peek()[1] not in (",", ";"):
                    raise FusionError("let(name, value, …, expression): the expression is missing")
                self.take()
                bound.append((name, value))
            else:
                bound.append((name, None))
            self.scope.append(name)
        if self.peek()[1] == ")":
            raise FusionError(f"{low}(): the expression is missing")
        body = self.expr()
        self.take(")")
        del self.scope[depth:]
        if low == "let":
            return ("let", bound, body)
        return self.applied(("lambda", [n for n, _ in bound], body))

    def ref(self, sheet: Optional[str]) -> Any:
        kind, a = self.take()
        if kind != "name" or not CELL.match(a.upper()):
            raise FusionError(f"expected a cell reference, found {a!r}")
        if self.peek()[1] == ":":
            self.take()
            kind, b = self.take()
            if kind != "name" or not CELL.match(b.upper()):
                raise FusionError(f"expected a cell reference after ':', found {b!r}")
            return ("range", sheet, a.upper(), b.upper())
        if self.peek()[1] == "#":
            # A1#: the whole result spilled from A1
            self.take()
            return ("spillref", sheet, a.upper())
        return ("ref", sheet, a.upper())


# What shifting reads in a formula, in this order: a quoted string (a sheet name when "!" follows), a double-quoted
# string, a sheet name with "!", a cell reference ($ marks the absolute part), any other name. The same pattern is in
# web/src/lib/fusion.ts (shiftFormula), so the fill handle and paste shift exactly as the server does.
_SHIFT = re.compile(
    r"""(?P<q>'(?:[^']|'')*'(?P<qs>!(?!=))?)"""
    r"""|(?P<d>"(?:[^"]|"")*")"""
    r"""|(?P<sheet>[A-Za-z_][A-Za-z0-9_.]*\s*!(?!=))"""
    r"""|(?<![A-Za-z0-9_.$])(?P<ca>\$?)(?P<col>[A-Za-z]{1,3})(?P<ra>\$?)(?P<row>[1-9][0-9]{0,5})(?![A-Za-z0-9_.$])(?!\s*\()"""
    r"""|(?P<name>[A-Za-z_][A-Za-z0-9_.]*)""")
MAX_ROW, MAX_COL = 999_999, 18_277  # the last row and column an address can name (ZZZ999999)


def parse(src: str) -> Any:
    return Parser(src).parse()


def shift_formula(src: str, drow: int, dcol: int = 0, only_rows_after: Optional[int] = None) -> str:
    """Shift a formula's relative references (fill, paste, sort) — the parts marked absolute with $ stay: $A$1 never
    moves, $A1 keeps its column, A$1 its row — or, with only_rows_after, every reference to a row below an inserted
    row (insert), absolute or not. References to other sheets (Sheet2!A1, 'My sheet'!A1:B2) and text are left alone."""
    if not isinstance(src, str) or not src.startswith("="):
        return src
    body = src[1:]

    def one(m: re.Match) -> str:
        cabs, col, rabs, row = m.group("ca"), m.group("col").upper(), m.group("ra"), int(m.group("row"))
        if only_rows_after is not None:
            return f"{cabs}{col}{rabs}{min(MAX_ROW, row + drow) if row - 1 > only_rows_after else row}"
        c = col if cabs else col_letters(min(MAX_COL, max(0, col_index(col) + dcol)))
        r = row if rabs else min(MAX_ROW, max(1, row + drow))
        return f"{cabs}{c}{rabs}{r}"

    out, last = [], 0
    qual, second = -1, False  # where a reference qualified by a sheet name may start; whether it is the range's end
    for m in _SHIFT.finditer(body):
        if m.group("qs") or m.group("sheet"):
            qual, second = m.end(), False
            continue
        if m.group("col") is None:
            qual = -1
            continue
        if qual >= 0:
            between = body[qual: m.start()].strip()
            if between == (":" if second else ""):
                qual, second = (-1, False) if second else (m.end(), True)
                continue
            qual = -1
        out.append(body[last: m.start()])
        out.append(one(m))
        last = m.end()
    out.append(body[last:])
    return "=" + "".join(out)


# ------------------------------------------------------------------ evaluation


def _elements(v: Any) -> Optional[list[Any]]:
    """The values of a multi-cell range or an array; None for a single value."""
    if isinstance(v, Range):
        vals = [plain(x) for x in v.flat()]
        return vals if len(vals) != 1 else None
    if isinstance(v, list):
        return [plain(x) for x in v]
    if isinstance(v, dict) and v.get("__kind__") == "array":
        return list(v.get("items") or [])
    return None


def _apply_op(op: str, sym: str, a: Any, b: Any) -> Any:
    if op == "cmp":
        return compare(sym, a, b)
    x, y = num(a), num(b)
    if x is None or y is None:
        if sym == "+" and isinstance(a, str) and isinstance(b, str):
            return a + b
        raise FusionError(f"{sym} needs numbers")
    # only the operator asked for is computed: x ** y overflows for operands that x * y or x - y handle well (10 * 365)
    r = {"+": lambda: x + y, "-": lambda: x - y, "*": lambda: x * y, "/": lambda: x / y if y else _div0(),
         "%": lambda: x % y if y else _div0(), "^": lambda: x ** y}[sym]()
    return clean_number(r)


class Evaluator:
    """Evaluates every cell of a document; `datasets(name)` → (columns, rows), `objects(type, filters)` → objects."""

    def __init__(self, doc: dict, datasets: Optional[Callable[[str], tuple[list[str], list[dict]]]] = None,
                 objects: Optional[Callable[[str, list[dict]], tuple[dict, list[dict]]]] = None) -> None:
        self.doc = doc
        self.sheets = {s["name"]: s for s in doc["sheets"]}
        self.by_id = {s["id"]: s for s in doc["sheets"]}
        self.memo: dict[tuple[str, str], Any] = {}
        self.visiting: set[tuple[str, str]] = set()
        self.datasets_fn, self.objects_fn = datasets, objects
        self.sources: dict[str, dict] = {}
        self.sheet: Optional[dict] = None
        self.at: Optional[str] = None  # the cell being computed (row() / column() without arguments)
        self.meta: dict = {}  # document_metadata(): document_identifier, creator
        self.env: dict[str, Any] = {}  # the names let() / lambda() have bound
        self.depth = 0  # nested lambda calls
        self.spill: dict[tuple[str, str], Any] = {}  # (sheet id, address) → the value a 2-D result spilled there
        self.spill_from: dict[tuple[str, str], str] = {}  # … and the cell the result starts in
        self.spill_size: dict[tuple[str, str], tuple[int, int]] = {}  # (sheet id, anchor) → rows, columns of its result (A1#)
        # sheet id → (row, column, address) of the formula cells that may spill and are not computed yet, in sheet order
        self.anchors: dict[str, list[tuple[int, int, str]]] = {}
        self.read_early: dict[tuple[str, str], set[str]] = {}  # (sheet id, anchor) → empty cells read while it was computed
        self.stack: list[tuple[str, str]] = []  # the cells being computed, the outermost first
        self.floor = 0  # the cells below this depth of the stack wait for a cell that is computed ahead of its turn

    # spilled results
    #
    # A formula whose result has several values (a 2-D result, a range, filter / sort / sequence …) spills them over the
    # cells right of and below it. Which result an empty cell shows is only known once the formula cells above and left
    # of it are computed, so reading an empty cell computes them first ("ahead of their turn"). When two results would
    # spill over the same cell, the one whose formula cell comes first on the sheet — row by row from the top, left to
    # right in a row — keeps the cells and the other shows #SPILL!; only when the first one needs the other one's
    # result (it is then computed second) does the other one keep them.
    def candidates(self, sheet: dict) -> list[tuple[int, int, str]]:
        pending = self.anchors.get(sheet["id"])
        if pending is None:
            pending = self.anchors[sheet["id"]] = sorted(
                (*parse_addr(k), k) for k, c in (sheet.get("cells") or {}).items()
                if isinstance(c.get("input"), str) and c["input"].startswith("=") and _SPILLS.search(c["input"]))
        return pending

    def ahead(self, sheet: dict, k: str) -> bool:
        """Compute cell k ahead of its turn. False when it needs a cell that is still being computed (below the floor
        of the stack): nothing of the attempt is kept, and k is computed again in its turn."""
        saved = self.floor
        self.floor = len(self.stack)
        try:
            self.cell_value(sheet, k)
            return True
        except _Pending:
            return False
        finally:
            self.floor = saved

    def spilled(self, sheet: dict, a: str) -> Any:
        """What an empty cell shows: the value a result of a formula above or left of it spilled there."""
        sid = sheet["id"]
        r, c = parse_addr(a)
        pending = self.candidates(sheet)
        for item in list(pending):
            rk, ck, k = item
            if rk > r:
                break
            key = (sid, k)
            if key in self.memo:
                pending.remove(item)
            elif ck > c:
                continue
            elif key in self.visiting:
                if self.stack.index(key) < self.floor:
                    # the cell computed ahead of its turn reads where a result still being computed may spill
                    raise _Pending()
                # read while that result is being computed: if it spills here, the result depends on itself
                self.read_early.setdefault(key, set()).add(a)
            elif self.ahead(sheet, k):
                if item in pending:
                    pending.remove(item)
            else:
                # k needs a cell being computed, which reads this one: if k spills here, it depends on itself
                self.read_early.setdefault(key, set()).add(a)
        return self.spill.get((sid, a))

    def spill_over(self, sheet: dict, a: str, m: "Range") -> Any:
        """The value of the cell a result starts in; its other values go to the cells right of and below it. A cell in
        the way that is not empty (or holds the result of a formula cell before it) makes it #SPILL! instead."""
        rows = [[_spilled_value(x) for x in row] for row in m.rows]
        if not rows or not rows[0]:
            return None
        sid = sheet["id"]
        if len(rows) == 1 and len(rows[0]) == 1:
            self.spill_size[(sid, a)] = (1, 1)
            return rows[0][0]
        if len(rows) * len(rows[0]) > MAX_SPILL:
            raise SpillError(f"a result spills over at most {MAX_SPILL:,} cells")
        cells = sheet.get("cells") or {}
        r0, c0 = parse_addr(a)
        if r0 + len(rows) > MAX_ROW or c0 + len(rows[0]) > MAX_COL + 1:
            raise SpillError("the result does not fit on the sheet")
        # the formula cells before this one that could spill over the same cells go first
        c1 = c0 + len(rows[0]) - 1
        for rk, ck, k in list(self.candidates(sheet)):
            if (rk, ck) >= (r0, c0):
                break
            if ck <= c1 and (sid, k) not in self.memo and (sid, k) not in self.visiting:
                self.ahead(sheet, k)
        targets = []
        for i, row in enumerate(rows):
            for j, x in enumerate(row):
                if i == 0 and j == 0:
                    continue
                t = addr(r0 + i, c0 + j)
                if (cells.get(t) or {}).get("input") not in (None, ""):
                    raise SpillError(f"the result cannot spill: {t} is not empty")
                if (sid, t) in self.spill:
                    raise SpillError(f"the result cannot spill: {t} holds the result of {self.spill_from[(sid, t)]}")
                targets.append((t, x))
        early = self.read_early.get((sid, a)) or set()
        loop = next((t for t, _ in targets if t in early), None)
        if loop:
            raise FusionError(f"circular reference: the result spills into {loop}, which it reads")
        for t, x in targets:
            self.spill[(sid, t)] = x
            self.spill_from[(sid, t)] = a
        self.spill_size[(sid, a)] = (len(rows), len(rows[0]))
        return {"__kind__": "matrix", "rows": rows}

    def spill_range(self, sheet_name: Optional[str], a: str) -> Range:
        """A1#: the cells the result of A1 spilled over (A1 among them)."""
        s = self.sheet_named(sheet_name)
        v = self.cell_value(s, a)
        if isinstance(v, dict) and v.get("__kind__") == "error":
            plain(v)  # A1 is an error (#SPILL! …): so is A1#
        size = self.spill_size.get((s["id"], a))
        if not size:
            raise RefError(f"{a}# refers to the cells a result spills over, and {a} holds no such result")
        r0, c0 = parse_addr(a)
        cells = range_cells(a, addr(r0 + size[0] - 1, c0 + size[1] - 1))
        return Range([[self.cell_value(s, x) for x in row] for row in cells], s["name"], cells)

    # cells
    def sheet_named(self, name: Optional[str]) -> dict:
        if name is None:
            return self.sheet or self.doc["sheets"][0]
        s = self.sheets.get(name) or next((x for x in self.doc["sheets"] if x["name"].lower() == name.lower()), None)
        if not s:
            raise FusionError(f"no sheet {name}")
        return s

    def cell_value(self, sheet: dict, a: str) -> Any:
        key = (sheet["id"], a)
        if key in self.memo:
            return self.memo[key]
        if key in self.visiting:
            if self.stack.index(key) < self.floor:
                raise _Pending()  # needed by a cell computed ahead of its turn: that cell waits for its turn
            raise FusionError(f"circular reference at {sheet['name']}!{a}")
        cell = (sheet.get("cells") or {}).get(a) or {}
        src = cell.get("input")
        if src is None or src == "":
            return self.spilled(sheet, a)
        self.visiting.add(key)
        self.stack.append(key)
        prev, prev_at, prev_env = self.sheet, self.at, self.env
        self.sheet, self.at, self.env = sheet, a, {}
        try:
            if isinstance(src, str) and src.startswith("="):
                try:
                    node = parse(src[1:])
                    v = self.eval(node)
                    if isinstance(v, dict) and v.get("__kind__") in ("checkbox", "datepicker") and not (node[0] == "call" and node[1] == v["__kind__"]):
                        v = plain(v)  # =B2 where B2 is a checkbox or datepicker: its value, not a second control
                    if isinstance(v, Matrix) or (isinstance(v, Range) and v.cells and _is_grid(v)):
                        # a computed array, or a reference to several cells (=A1:B3, =A1#, =offset(…)), spills
                        v = self.spill_over(sheet, a, v)
                    elif isinstance(v, dict) and v.get("__kind__") == "matrix":
                        v = plain(v)  # =B2 where B2 starts a spilled result: its top-left value
                    elif node[0] == "call" and node[1] in DYNAMIC and not isinstance(v, (Range, list, dict)):
                        self.spill_size[key] = (1, 1)  # =sequence(1): a one-cell result A1# can still refer to
                    elif isinstance(v, Range):
                        v = {"__kind__": "array", "items": [plain(x) for x in v.flat()]}
                    elif isinstance(v, list):
                        v = {"__kind__": "array", "items": v}
                    if isinstance(v, dict) and v.get("__kind__") == "dropdown":
                        sel = cell.get("selected")
                        opts = v.get("options") or []
                        if v.get("multi"):
                            v = {**v, "value": [x for x in (sel or []) if x in opts]}
                        else:
                            v = {**v, "value": sel if sel in opts else (v.get("value") if v.get("value") in opts else None)}
                    elif isinstance(v, dict) and v.get("__kind__") in ("checkbox", "datepicker") and not v.get("bound") and "selected" in cell:
                        # a control that is not bound to another cell keeps what the user set with the cell
                        v = {**v, "value": _control_value(v, cell.get("selected"))}
                    elif isinstance(v, dict) and v.get("__kind__") == "lambda":
                        raise CalcError("a lambda gives a value when it is called: lambda(x, x + 1)(2)")
                except FusionError as e:
                    v = {"__kind__": "error", "message": str(e)}
                    code = next((c for c, cls in _ERROR_CODES.items() if isinstance(e, cls)), None)
                    if code:
                        v["code"] = code  # #SPILL!, #REF!, #N/A, #CALC!
                except (ZeroDivisionError, ValueError, TypeError, OverflowError) as e:
                    v = {"__kind__": "error", "message": str(e) or type(e).__name__}
            else:
                v = literal(str(src))
        finally:
            self.visiting.discard(key)
            self.stack.pop()
            self.sheet, self.at, self.env = prev, prev_at, prev_env
        self.memo[key] = v
        return v

    def values(self) -> dict[str, dict[str, Any]]:
        out = {}
        for s in self.doc["sheets"]:
            out[s["id"]] = {a: self.cell_value(s, a) for a in (s.get("cells") or {})}
        # the cells 2-D results spilled over hold no input of their own
        for (sid, a), v in self.spill.items():
            out[sid].setdefault(a, v)
        return out

    # expressions
    def eval(self, n: Any) -> Any:
        op = n[0]
        if op == "lit":
            return n[1]
        if op == "ref":
            return self.cell_value(self.sheet_named(n[1]), n[2])
        if op == "range":
            s = self.sheet_named(n[1])
            cells = range_cells(n[2], n[3])
            return Range([[self.cell_value(s, a) for a in row] for row in cells], s["name"], cells)
        if op == "spillref":
            return self.spill_range(n[1], n[2])
        if op == "rows":
            # {1, 2; 3, 4}
            rows = [[plain(self.scalar(x)) for x in row] for row in n[1]]
            if any(len(row) != len(rows[0]) for row in rows) or not rows[0]:
                raise FusionError("the rows of an array {…; …} need as many values each")
            return Matrix(rows)
        if op == "neg":
            v = self.eval(n[1])
            if _is_grid(v):
                return _elementwise(lambda x: _apply_op("bin", "-", 0, x), v)
            x = num(v)
            if x is None:
                raise FusionError("- needs a number")
            return clean_number(-x)
        if op == "not":
            return not truthy(self.eval(n[1]))
        if op == "and":
            return truthy(self.eval(n[1])) and truthy(self.eval(n[2]))
        if op == "or":
            return truthy(self.eval(n[1])) or truthy(self.eval(n[2]))
        if op == "concat":
            parts = [self.eval(x) for x in n[1:]]
            if any(_is_grid(p) for p in parts):
                # A1:A3 & "x": value by value
                out = parts[0]
                for p in parts[1:]:
                    out = _broadcast(lambda u, w: to_text(u) + to_text(w), [out, p], "&")
                return out
            return "".join(to_text(plain(p)) for p in parts)
        if op in ("cmp", "bin"):
            x, y = self.eval(n[2]), self.eval(n[3])
            if _is_grid(x) or _is_grid(y):
                # a range or a 2-D result with other values: value by value, keeping the shape (A1:A4 * 2, A1:A3 > B1:B3);
                # a column with a row gives every pair (A1:A3 * B1:D1 is 3 x 3)
                return _broadcast(lambda u, w: _apply_op(op, n[1], u, w), [x, y], n[1])
            x, y = _single(x), _single(y)
            xs, ys = _elements(x), _elements(y)
            if xs is None and ys is None:
                return _apply_op(op, n[1], plain(x), plain(y))
            # element-wise over arrays ({1, 2} * 2), a single value applying to every element: an array again
            if xs is not None and ys is not None and len(xs) != len(ys):
                raise FusionError(f"{n[1]} on arrays of different sizes ({len(xs)} and {len(ys)})")
            size = len(xs if xs is not None else ys)
            return [_apply_op(op, n[1], xs[i] if xs is not None else plain(x), ys[i] if ys is not None else plain(y)) for i in range(size)]
        if op == "call":
            return self.call(n[1], n[2])
        if op == "var":
            if n[1] not in self.env:
                raise FusionError(f"unknown name {n[1]}")
            return self.env[n[1]]
        if op == "let":
            saved = self.env
            try:
                for name, value in n[1]:
                    self.env = {**self.env, name: self.eval(value)}
                return self.eval(n[2])
            finally:
                self.env = saved
        if op == "lambda":
            return {"__kind__": "lambda", "params": n[1], "body": n[2], "env": self.env}
        if op == "apply":
            f = self.eval(n[1])
            if not (isinstance(f, dict) and f.get("__kind__") == "lambda"):
                raise FusionError("only a lambda can be called with (…)")
            if len(n[2]) > len(f["params"]):
                raise FusionError(f"the lambda takes {len(f['params'])} argument(s), {len(n[2])} given")
            # parameters left out — (1, ) (, 2) or fewer arguments — are null, and isomitted() is true for them
            given = list(n[2]) + [None] * (len(f["params"]) - len(n[2]))
            omitted = {p for p, x in zip(f["params"], given) if x is None or (x[0] == "lit" and x[2:] == ("omitted",))}
            args = [None if p in omitted else self.eval(x) for p, x in zip(f["params"], given)]
            if self.depth >= 50:
                raise FusionError("lambda calls are nested too deeply")
            saved = self.env
            outer = set(f["env"].get(OMITTED) or ()) - set(f["params"])
            self.env, self.depth = {**f["env"], **dict(zip(f["params"], args)), OMITTED: frozenset(outer | omitted)}, self.depth + 1
            try:
                return self.eval(f["body"])
            finally:
                self.env, self.depth = saved, self.depth - 1
        raise FusionError(f"cannot evaluate {op}")

    def scalar(self, n: Any) -> Any:
        v = self.eval(n)
        if isinstance(v, Range):
            vals = v.flat()
            if len(vals) == 1:
                return vals[0]
            raise FusionError("a range where one value is expected")
        return v

    def call(self, name: str, args: list[Any]) -> Any:
        lazy = LAZY.get(name)
        if lazy:
            return lazy(self, args)
        fn = FUNCS.get(name)
        if not fn:
            raise FusionError(f"unknown function {name}()")
        return fn(self, [self.eval(a) for a in args])

    # data access
    def dataset(self, ref: Any) -> tuple[list[str], list[dict]]:
        if not self.datasets_fn:
            raise FusionError("datasets are not available")
        name = str(plain(ref))
        cols, rows, info = self.datasets_fn(name)
        self.sources[info["id"]] = info
        return cols, rows


def _div0() -> float:
    raise FusionError("division by zero")


def to_text(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return str(clean_number(v))
    if isinstance(v, list):
        return ", ".join(to_text(x) for x in v)
    if isinstance(v, dict) and v.get("__kind__") == "object":
        return to_text(v.get("title"))  # an Ontology object reads as its title
    return str(v)


def compare(op: str, a: Any, b: Any) -> bool:
    if isinstance(a, (int, float)) and not isinstance(a, bool) and isinstance(b, str):
        nb = num(b)
        b = nb if nb is not None else b
    if isinstance(b, (int, float)) and not isinstance(b, bool) and isinstance(a, str):
        na = num(a)
        a = na if na is not None else a
    if op == "==":
        return a == b if not (isinstance(a, str) and isinstance(b, str)) else a == b
    if op == "!=":
        return a != b
    if a is None or b is None:
        return False
    try:
        return {"<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b}[op]
    except TypeError:
        return {"<": str(a) < str(b), ">": str(a) > str(b), "<=": str(a) <= str(b), ">=": str(a) >= str(b)}[op]


# ------------------------------------------------------------------ the function library


def _arity(args: list, lo: int, hi: Optional[int] = None, name: str = "") -> None:
    if len(args) < lo or (hi is not None and len(args) > hi):
        raise FusionError(f"{name}() takes {lo}{'' if hi == lo else f' to {hi}' if hi is not None else ' or more'} arguments")


def _date(v: Any) -> dt.date:
    v = plain(v)
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    try:
        return dt.date.fromisoformat(str(v)[:10])
    except ValueError:
        raise FusionError(f"not a date: {v}") from None


def _filters(args: list[Any]) -> list[tuple[str, Any]]:
    if len(args) % 2:
        raise FusionError("filters come in pairs: column, value")
    return [(str(plain(args[i])), args[i + 1] if _is_modifier(args[i + 1]) else plain(args[i + 1])) for i in range(0, len(args), 2)]


def _is_modifier(v: Any) -> bool:
    """A filter value tagged by eq / neq / gt / gte / lt / lte / exact / fuzzy / all_token_match / any_token_match."""
    return isinstance(v, dict) and v.get("__kind__") == "modifier"


def _match(row: dict, filters: list[tuple[str, Any]]) -> bool:
    for col, val in filters:
        cell = row.get(col)
        if _is_modifier(val):
            if not _modified(cell, val):
                return False
        elif isinstance(val, list):
            if not any(compare("==", cell, x) for x in val):
                return False
        elif val is not None and val != "" and not compare("==", cell, val):
            return False
    return True


def _lookup(ev: Evaluator, args: list[Any]) -> list[Any]:
    if len(args) < 2:
        raise FusionError("lookup(dataset, column, [filter column, filter value]…)")
    cols, rows = ev.dataset(args[0])
    col = str(plain(args[1]))
    if col not in cols:
        raise FusionError(f"the dataset has no column {col}")
    fs = _filters(args[2:])
    for c, _ in fs:
        if c not in cols:
            raise FusionError(f"the dataset has no column {c}")
    return [r.get(col) for r in _hit_rows(rows, fs, [col], MAX_LOOKUP)]


def _hit_rows(rows: Any, fs: list[tuple[str, Any]], need: list[str], limit: Optional[int] = None) -> list[dict]:
    """The rows the filters keep, in the dataset's order. An indexed dataset (fusion_index.Rows) finds them through
    its index when it can, with the same result; `need` names the columns the caller reads."""
    select = getattr(rows, "select", None)
    if select is not None:
        return select(fs, limit, need)
    hit = [r for r in rows if _match(r, fs)]
    return hit[:limit] if limit else hit


def _one_or_many(vals: list[Any]) -> Any:
    if len(vals) == 1:
        return vals[0]
    if not vals:
        return None
    return {"__kind__": "array", "items": vals}


def _objects(ev: Evaluator, type_ref: Any, args: list[Any]) -> tuple[dict, list[dict]]:
    if not ev.objects_fn:
        raise FusionError("the Ontology is not available")
    fs = []
    for c, v in _filters(args):
        if _is_modifier(v):
            if v.get("op") not in _OBJECT_OPS:
                raise FusionError("fuzzy and token matches are for dataset lookups; objects take eq, neq, gt, gte, lt, lte and exact")
            fs.append({"property": c, "op": _OBJECT_OPS[v["op"]], "value": v.get("value")})
        elif v not in (None, ""):
            fs.append({"property": c, "op": "eq", "value": v})
    return ev.objects_fn(str(plain(type_ref)), fs)


def _range_columns(r: Any, name: str) -> tuple[list[str], list[list[Any]]]:
    if not isinstance(r, Range) or len(r.rows) < 1:
        raise FusionError(f"{name}() needs a table range with a header row")
    headers = [to_text(plain(x)) for x in r.rows[0]]
    return headers, [[plain(x) for x in row] for row in r.rows[1:]]


def _validation(ok: bool, message: str) -> dict:
    return {"__kind__": "validation", "ok": ok, "message": message}


def _column(r: Any, name: str) -> list[Any]:
    if isinstance(r, Range):
        return [plain(x) for x in r.flat()]
    if isinstance(r, list):
        return r
    raise FusionError(f"{name}() needs a range")


def _action(kind: str, **spec: Any) -> dict:
    return {"__kind__": "action", "action": kind, **spec}


def _range_spec(n: Any, ev: Evaluator) -> dict:
    """An action's target range, kept as addresses (sheet id + cells)."""
    if n[0] == "ref":
        s = ev.sheet_named(n[1])
        return {"sheet": s["id"], "cells": [[n[2]]]}
    if n[0] == "range":
        s = ev.sheet_named(n[1])
        return {"sheet": s["id"], "cells": range_cells(n[2], n[3])}
    raise FusionError("expected a cell or range")


def _copy(ev: Evaluator, args: list[Any]) -> dict:
    _arity(args, 2, 3, "action.copy")
    return _action("copy", source=_range_spec(args[0], ev), target=_range_spec(args[1], ev),
                   copy_result=truthy(ev.eval(args[2])) if len(args) > 2 else False)


def _actions_of(ev: Evaluator, args: list[Any]) -> list[dict]:
    out = []
    for a in args:
        v = ev.eval(a)
        if isinstance(v, dict) and v.get("__kind__") in ("action", "validation"):
            out.append(v)
        else:
            raise FusionError("expected an action")
    return out


def _serial(ev: Evaluator, args: list[Any]) -> dict:
    _arity(args, 1, 3, "action.serial")
    acts = [ev.eval(a) for a in args]
    for a in acts:
        if not (isinstance(a, dict) and a.get("__kind__") in ("action", "validation")):
            raise FusionError("action.serial(action, on success, on failure) takes actions")
    return _action("serial", first=acts[0], on_success=acts[1] if len(acts) > 1 else None, on_failure=acts[2] if len(acts) > 2 else None)


def _submit(ev: Evaluator, args: list[Any]) -> dict:
    if len(args) < 2:
        raise FusionError("action.submit_to_region(table name, key value, values…)")
    name = to_text(plain(ev.scalar(args[0])))
    vals: list[Any] = []
    for a in args[1:]:
        v = ev.eval(a)
        vals.extend(flat([v]) if isinstance(v, Range) else [plain(v)])
    return _action("submit_to_region", table=name, values=vals)


def _apply_action(ev: Evaluator, args: list[Any]) -> dict:
    if not args:
        raise FusionError("action.apply_action(action type, parameter, value…)")
    vals = [plain(ev.scalar(a)) for a in args]
    if len(vals[1:]) % 2:
        raise FusionError("parameters come in pairs: parameter, value")
    return _action("apply_action", action_type=to_text(vals[0]), parameters={to_text(vals[i]): vals[i + 1] for i in range(1, len(vals), 2)})


def _vlookup(ev: Evaluator, a: list[Any]) -> Any:
    _arity(a, 3, 4, "vlookup")
    key, table, col = plain(a[0]), a[1], num(a[2])
    if not isinstance(table, Range) or col is None:
        raise FusionError("vlookup(value, range, column number)")
    for row in table.rows:
        if row and compare("==", plain(row[0]), key):
            i = int(col) - 1
            return plain(row[i]) if 0 <= i < len(row) else None
    raise NAError(f"vlookup: {to_text(key)} not found")


def _index(ev: Evaluator, a: list[Any]) -> Any:
    _arity(a, 2, 3, "index")
    r = a[0]
    rows = r.rows if isinstance(r, Range) else [[x] for x in (plain(r) or [])]
    i = int(num(a[1]) or 1) - 1
    j = int(num(a[2]) or 1) - 1 if len(a) > 2 else 0
    try:
        return plain(rows[i][j])
    except IndexError:
        raise FusionError("index out of range") from None


def _date_diff(ev: Evaluator, a: list[Any]) -> Any:
    _arity(a, 2, 3, "date_diff")
    d = (_date(a[1]) - _date(a[0])).days
    unit = to_text(plain(a[2])).lower() if len(a) > 2 else "days"
    return {"days": d, "weeks": d // 7, "months": d // 30, "years": d // 365}.get(unit, d)


FUNCS: dict[str, Callable[[Evaluator, list[Any]], Any]] = {
    # math
    "sum": lambda ev, a: clean_number(sum(nums(a))),
    "avg": lambda ev, a: clean_number(sum(nums(a)) / len(nums(a))) if nums(a) else None,
    "average": lambda ev, a: clean_number(sum(nums(a)) / len(nums(a))) if nums(a) else None,
    "min": lambda ev, a: clean_number(min(nums(a))) if nums(a) else None,
    "max": lambda ev, a: clean_number(max(nums(a))) if nums(a) else None,
    "count": lambda ev, a: len(nums(a)),
    "counta": lambda ev, a: sum(1 for v in flat(a) if v not in (None, "")),
    "product": lambda ev, a: clean_number(math.prod(nums(a))),
    "round": lambda ev, a: clean_number(round(num(a[0]) or 0, int(num(a[1]) or 0) if len(a) > 1 else 0)),
    "abs": lambda ev, a: clean_number(abs(num(a[0]) or 0)),
    "floor": lambda ev, a: math.floor(num(a[0]) or 0),
    "ceil": lambda ev, a: math.ceil(num(a[0]) or 0),
    "ceiling": lambda ev, a: math.ceil(num(a[0]) or 0),
    "sqrt": lambda ev, a: clean_number(math.sqrt(num(a[0]) or 0)),
    "power": lambda ev, a: clean_number((num(a[0]) or 0) ** (num(a[1]) or 0)),
    "mod": lambda ev, a: clean_number((num(a[0]) or 0) % (num(a[1]) or _div0())),
    # logic
    "and": lambda ev, a: all(truthy(x) for x in flat(a)),
    "or": lambda ev, a: any(truthy(x) for x in flat(a)),
    "not": lambda ev, a: not truthy(a[0]),
    "is_null": lambda ev, a: plain(a[0]) in (None, ""),
    "isnull": lambda ev, a: plain(a[0]) in (None, ""),
    "coalesce": lambda ev, a: next((v for v in flat(a) if v not in (None, "")), None),
    # text
    "concat": lambda ev, a: "".join(to_text(v) for v in flat(a)),
    "concatenate": lambda ev, a: "".join(to_text(v) for v in flat(a)),
    "upper": lambda ev, a: to_text(plain(a[0])).upper(),
    "lower": lambda ev, a: to_text(plain(a[0])).lower(),
    "len": lambda ev, a: len(to_text(plain(a[0]))),
    "length": lambda ev, a: len(to_text(plain(a[0]))),
    "trim": lambda ev, a: to_text(plain(a[0])).strip(),
    "left": lambda ev, a: to_text(plain(a[0]))[: int(num(a[1]) or 1)],
    "right": lambda ev, a: to_text(plain(a[0]))[-int(num(a[1]) or 1):],
    "substring": lambda ev, a: to_text(plain(a[0]))[int(num(a[1]) or 0): int(num(a[1]) or 0) + int(num(a[2])) if len(a) > 2 else None],
    "mid": lambda ev, a: to_text(plain(a[0]))[int(num(a[1]) or 1) - 1: int(num(a[1]) or 1) - 1 + int(num(a[2]) or 0)],
    "replace": lambda ev, a: to_text(plain(a[0])).replace(to_text(plain(a[1])), to_text(plain(a[2]))),
    "contains": lambda ev, a: to_text(plain(a[1])) in to_text(plain(a[0])),
    "starts_with": lambda ev, a: to_text(plain(a[0])).startswith(to_text(plain(a[1]))),
    "ends_with": lambda ev, a: to_text(plain(a[0])).endswith(to_text(plain(a[1]))),
    "split": lambda ev, a: {"__kind__": "array", "items": to_text(plain(a[0])).split(to_text(plain(a[1])) if len(a) > 1 else ",")},
    "to_string": lambda ev, a: to_text(plain(a[0])),
    "to_number": lambda ev, a: clean_number(num(a[0])) if num(a[0]) is not None else None,
    "number": lambda ev, a: clean_number(num(a[0])) if num(a[0]) is not None else None,
    # dates
    "today": lambda ev, a: dt.date.today().isoformat(),
    "now": lambda ev, a: dt.datetime.now().replace(microsecond=0).isoformat(sep=" "),
    "date": lambda ev, a: dt.date(int(num(a[0]) or 1970), int(num(a[1]) or 1), int(num(a[2]) or 1)).isoformat(),
    "year": lambda ev, a: _date(a[0]).year,
    "month": lambda ev, a: _date(a[0]).month,
    "day": lambda ev, a: _date(a[0]).day,
    "date_diff": _date_diff,
    "add_days": lambda ev, a: (_date(a[0]) + dt.timedelta(days=int(num(a[1]) or 0))).isoformat(),
    # arrays
    "array": lambda ev, a: {"__kind__": "array", "items": flat(a)},
    "array_flatten": lambda ev, a: {"__kind__": "array", "items": flat(a)},
    "array_length": lambda ev, a: len(flat(a)),
    "array_contains": lambda ev, a: any(compare("==", v, plain(a[1])) for v in flat([a[0]])),
    "unique": lambda ev, a: {"__kind__": "array", "items": list(dict.fromkeys(v for v in flat(a) if v is not None))},
    "sort": lambda ev, a: {"__kind__": "array", "items": sorted((v for v in flat(a) if v is not None), key=lambda x: (isinstance(x, str), x))},
    "index": _index,
    "match": lambda ev, a: next((i + 1 for i, v in enumerate(flat([a[1]])) if compare("==", v, plain(a[0]))), None),
    "vlookup": _vlookup,
    # datasets
    "lookup": lambda ev, a: _one_or_many(_lookup(ev, a)),
    "lookup_array": lambda ev, a: {"__kind__": "array", "items": _lookup(ev, a)},
    "lookup_distinct": lambda ev, a: {"__kind__": "array", "items": list(dict.fromkeys(v for v in _lookup(ev, a) if v is not None))},
    "lookup_dropdown": lambda ev, a: {"__kind__": "dropdown", "options": list(dict.fromkeys(v for v in _lookup(ev, a) if v is not None)), "value": None, "multi": False},
    "lookup_schema": lambda ev, a: {"__kind__": "array", "items": ev.dataset(a[0])[0]},
    # objects
    "object_lookup": lambda ev, a: _object_lookup(ev, a),
    "object_dropdown": lambda ev, a: _object_dropdown(ev, a),
    # presentation
    "dropdown": lambda ev, a: {"__kind__": "dropdown", "options": flat([a[0]]) if a else [], "value": plain(a[1]) if len(a) > 1 else None, "multi": False},
    "multidropdown": lambda ev, a: {"__kind__": "dropdown", "options": flat([a[0]]) if a else [], "value": [], "multi": True},
    "url": lambda ev, a: {"__kind__": "url", "href": to_text(plain(a[0])), "value": to_text(plain(a[1])) if len(a) > 1 else to_text(plain(a[0]))},
    "color": lambda ev, a: {"__kind__": "styled", "value": plain(a[0]), "color": to_text(plain(a[1])) if len(a) > 1 else None},
    "tooltip": lambda ev, a: {"__kind__": "styled", "value": plain(a[0]), "tooltip": to_text(plain(a[1])) if len(a) > 1 else None},
    # validation (buttons; also used inside action.serial)
    "column_enum": lambda ev, a: _validation(all(v in flat([a[1]]) for v in _column(a[0], "column_enum") if v not in (None, "")),
                                             "every value is in the allowed list"),
    "column_not_null": lambda ev, a: _validation(all(v not in (None, "") for v in _column(a[0], "column_not_null")), "no empty values"),
    "column_numeric": lambda ev, a: _validation(all(num(v) is not None for v in _column(a[0], "column_numeric") if v not in (None, "")), "only numbers"),
    "table_headers": lambda ev, a: _validation(set(to_text(x) for x in flat([a[1]])) <= set(_range_columns(a[0], "table_headers")[0]),
                                               "the table has the columns"),
    "table_key": lambda ev, a: _table_key(a),
}


def _table_key(a: list[Any]) -> dict:
    headers, rows = _range_columns(a[0], "table_key")
    keys = [to_text(x) for x in flat(a[1:])] or headers
    idx = [headers.index(k) for k in keys if k in headers]
    if len(idx) != len(keys):
        return _validation(False, "the table lacks a key column")
    seen = [tuple(r[i] for i in idx) for r in rows if any(x not in (None, "") for x in r)]
    return _validation(len(seen) == len(set(seen)), f"{', '.join(keys)} is unique")


def _object_lookup(ev: Evaluator, a: list[Any]) -> Any:
    if len(a) < 2:
        raise FusionError("object_lookup(object type, property, [filter property, value]…)")
    t, objs = _objects(ev, a[0], a[2:])
    prop = to_text(plain(a[1]))
    return _one_or_many([o["properties"].get(prop) for o in objs][:MAX_LOOKUP])


def _object_dropdown(ev: Evaluator, a: list[Any]) -> dict:
    if not a:
        raise FusionError("object_dropdown(object type, [filter property, value]…) or object_dropdown(object set, [selected object RID], [placeholder])")
    items = _object_items(a[0])
    if items is not None:
        return _object_set_dropdown(a, items)
    t, objs = _objects(ev, a[0], a[1:])
    return {"__kind__": "dropdown", "options": [o["title"] for o in objs][:200], "value": None, "multi": False,
            "objects": {o["title"]: o["primary_key"] for o in objs[:200]}, "object_type_id": t["id"],
            "rids": {o["title"]: object_rid(t["id"], o["primary_key"]) for o in objs[:200]}}


def _if(ev: Evaluator, a: list[Any]) -> Any:
    _arity(a, 2, 3, "if")
    return ev.eval(a[1]) if truthy(ev.scalar(a[0])) else (ev.eval(a[2]) if len(a) > 2 else None)


def _iferror(ev: Evaluator, a: list[Any]) -> Any:
    _arity(a, 2, 2, "iferror")
    try:
        v = ev.eval(a[0])
        plain(v)
        return v
    except (FusionError, ZeroDivisionError, ValueError, TypeError):
        return ev.eval(a[1])


_LABEL_TYPES = ("button", "link", "tag")
_INTENTS = ("primary", "success", "warning", "danger", "none")


def _label(ev: Evaluator, a: list[Any]) -> dict:
    """action.label(type, label, [icon], [intent]) — type 'button', 'link' or 'tag' — as documented; the shorter
    action.label(text, [intent]) of earlier documents keeps its meaning (also when its text is 'button' and an intent
    follows)."""
    vals = [to_text(plain(ev.scalar(x))) for x in a]
    if len(vals) >= 2 and vals[0].strip().lower() in _LABEL_TYPES and (len(vals) > 2 or vals[1].strip().lower() not in _INTENTS):
        _arity(a, 2, 4, "action.label")
        intent = vals[3].strip().lower() if len(vals) > 3 and vals[3].strip() else "primary"
        return {"__kind__": "label", "text": vals[1], "intent": intent, "type": vals[0].strip().lower(), "icon": vals[2].strip() if len(vals) > 2 else ""}
    return {"__kind__": "label", "text": vals[0] if vals else "Run", "intent": vals[1] if len(vals) > 1 else "primary"}


def _trigger(ev: Evaluator, a: list[Any]) -> dict:
    _arity(a, 2, 2, "action.trigger")
    lab = ev.eval(a[0])
    act = ev.eval(a[1])
    if not (isinstance(act, dict) and act.get("__kind__") in ("action", "validation")):
        raise FusionError("action.trigger(label, action)")
    return {**act, "label": lab if isinstance(lab, dict) else {"__kind__": "label", "text": to_text(plain(lab)), "intent": "primary"}} \
        if act.get("__kind__") == "action" else _action("serial", first=act, on_success=None, on_failure=None, label=lab)


# ------------------------------------------------------------------ more of Fusion's library

import contextvars  # noqa: E402
import re as _re  # noqa: E402
import statistics as _st  # noqa: E402
import urllib.parse as _up  # noqa: E402

# the URL parameters the document was opened with (query_params)
QUERY_PARAMS: contextvars.ContextVar[dict] = contextvars.ContextVar("fusion_query_params", default={})


def _crit(v: Any, crit: Any) -> bool:
    """A criterion of sumif / countif: ">=10", "<>x", "a*" (wildcards) or a value."""
    c = plain(crit)
    if isinstance(c, str):
        m = _re.match(r"^(>=|<=|<>|>|<|=)(.*)$", c)
        if m:
            op, rhs = m.groups()
            target = num(rhs) if num(rhs) is not None else rhs
            return compare({"<>": "!=", "=": "=="}.get(op, op), v, target)
        if "*" in c or "?" in c:
            pat = "^" + _re.escape(c).replace(r"\*", ".*").replace(r"\?", ".") + "$"
            return bool(_re.match(pat, to_text(v), _re.I))
    return compare("==", v, c)


def _ifagg(a: list[Any], agg: str) -> Any:
    rng = flat([a[0]])
    crit = a[1]
    vals = flat([a[2]]) if len(a) > 2 else rng
    picked = [vals[i] for i, v in enumerate(rng) if i < len(vals) and _crit(v, crit)]
    if agg == "count":
        return len(picked)
    ns = nums(picked)
    if agg == "sum":
        return clean_number(sum(ns))
    return clean_number(sum(ns) / len(ns)) if ns else None


def _percentile(a: list[Any]) -> Any:
    xs = sorted(nums([a[0]]))
    if not xs:
        return None
    k = (len(xs) - 1) * float(num(a[1]) or 0)
    f, c = math.floor(k), math.ceil(k)
    return clean_number(xs[f] + (xs[c] - xs[f]) * (k - f))


def _add_months(d: dt.date, n: int) -> dt.date:
    import calendar

    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    return dt.date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def _eomonth(a: list[Any]) -> str:
    import calendar

    d = _add_months(_date(a[0]), int(num(a[1]) or 0) if len(a) > 1 else 0)
    return d.replace(day=calendar.monthrange(d.year, d.month)[1]).isoformat()


def _networkdays(a: list[Any]) -> int:
    d0, d1 = _date(a[0]), _date(a[1])
    step = 1 if d1 >= d0 else -1
    holidays = {_date(x) for x in flat(a[2:])} if len(a) > 2 else set()
    n, d = 0, d0
    while (d <= d1) if step > 0 else (d >= d1):
        if d.weekday() < 5 and d not in holidays:
            n += 1
        d += dt.timedelta(days=step)
    return n * step


def _text_format(a: list[Any]) -> str:
    """text(value, format): "0.00", "#,##0", "0%", or a date format like "yyyy-mm-dd" / "dd/mm/yyyy"."""
    v, f = plain(a[0]), to_text(plain(a[1])) if len(a) > 1 else ""
    if num(v) is not None and not any(x in f.lower() for x in ("yy", "dd")):
        x = float(num(v))
        pct = f.endswith("%")
        if pct:
            x *= 100
        dec = len(f.split(".")[1].rstrip("%")) if "." in f else 0
        out = f"{x:,.{dec}f}" if "," in f else f"{x:.{dec}f}"
        return out + ("%" if pct else "")
    d = _date(v)
    py = f.replace("yyyy", "%Y").replace("yy", "%y").replace("mm", "%m").replace("dd", "%d")
    return d.strftime(py or "%Y-%m-%d")


def _switch(ev: "Evaluator", a: list[Any]) -> Any:
    if len(a) < 3:
        raise FusionError("switch(value, case, result, …, [default])")
    v = plain(ev.scalar(a[0]))
    rest = a[1:]
    for i in range(0, len(rest) - 1, 2):
        if compare("==", v, plain(ev.scalar(rest[i]))):
            return ev.eval(rest[i + 1])
    return ev.eval(rest[-1]) if len(rest) % 2 else None


def _ifs(ev: "Evaluator", a: list[Any]) -> Any:
    for i in range(0, len(a) - 1, 2):
        if truthy(ev.scalar(a[i])):
            return ev.eval(a[i + 1])
    return None


def _choose(ev: "Evaluator", a: list[Any]) -> Any:
    i = int(num(ev.scalar(a[0])) or 0)
    if not 1 <= i < len(a):
        raise FusionError("choose: index out of range")
    return ev.eval(a[i])


def _regex(pattern: Any) -> "_re.Pattern":
    try:
        return _re.compile(to_text(plain(pattern)))
    except _re.error as e:
        raise FusionError(f"not a valid regular expression: {e}") from None


FUNCS.update({
    # math and statistics
    "ln": lambda ev, a: clean_number(math.log(num(a[0]) or _div0())),
    "log": lambda ev, a: clean_number(math.log(num(a[0]) or _div0(), num(a[1]) if len(a) > 1 else 10)),
    "log10": lambda ev, a: clean_number(math.log10(num(a[0]) or _div0())),
    "exp": lambda ev, a: clean_number(math.exp(num(a[0]) or 0)),
    "sign": lambda ev, a: ((num(a[0]) or 0) > 0) - ((num(a[0]) or 0) < 0),
    "int": lambda ev, a: math.floor(num(a[0]) or 0),
    "trunc": lambda ev, a: math.trunc(num(a[0]) or 0),
    "pi": lambda ev, a: math.pi,
    "sin": lambda ev, a: clean_number(math.sin(num(a[0]) or 0)),
    "cos": lambda ev, a: clean_number(math.cos(num(a[0]) or 0)),
    "tan": lambda ev, a: clean_number(math.tan(num(a[0]) or 0)),
    "median": lambda ev, a: clean_number(_st.median(nums(a))) if nums(a) else None,
    "mode": lambda ev, a: clean_number(_st.mode(nums(a))) if nums(a) else None,
    "stdev": lambda ev, a: clean_number(_st.stdev(nums(a))) if len(nums(a)) > 1 else None,
    "stdevp": lambda ev, a: clean_number(_st.pstdev(nums(a))) if nums(a) else None,
    "var": lambda ev, a: clean_number(_st.variance(nums(a))) if len(nums(a)) > 1 else None,
    "large": lambda ev, a: clean_number(sorted(nums([a[0]]), reverse=True)[int(num(a[1]) or 1) - 1]),
    "small": lambda ev, a: clean_number(sorted(nums([a[0]]))[int(num(a[1]) or 1) - 1]),
    "percentile": lambda ev, a: _percentile(a),
    "rank": lambda ev, a: sorted(nums([a[1]]), reverse=not (len(a) > 2 and truthy(a[2]))).index(num(a[0])) + 1 if num(a[0]) in nums([a[1]]) else None,
    "sumif": lambda ev, a: _ifagg(a, "sum"),
    "countif": lambda ev, a: _ifagg(a, "count"),
    "averageif": lambda ev, a: _ifagg(a, "avg"),
    "sumproduct": lambda ev, a: clean_number(sum(math.prod(x) for x in zip(*[nums([r]) for r in a]))),
    "countblank": lambda ev, a: sum(1 for v in flat(a) if v in (None, "")),
    # logic
    "xor": lambda ev, a: sum(1 for x in flat(a) if truthy(x)) % 2 == 1,
    "true": lambda ev, a: True,
    "false": lambda ev, a: False,
    "is_number": lambda ev, a: isinstance(plain(a[0]), (int, float)) and not isinstance(plain(a[0]), bool),
    "is_text": lambda ev, a: isinstance(plain(a[0]), str),
    # text
    "proper": lambda ev, a: to_text(plain(a[0])).title(),
    "rept": lambda ev, a: to_text(plain(a[0])) * int(num(a[1]) or 0),
    "find": lambda ev, a: (to_text(plain(a[1])).find(to_text(plain(a[0]))) + 1) or None,
    "search": lambda ev, a: (to_text(plain(a[1])).lower().find(to_text(plain(a[0])).lower()) + 1) or None,
    "text": lambda ev, a: _text_format(a),
    "value": lambda ev, a: clean_number(num(a[0])) if num(a[0]) is not None else None,
    "char": lambda ev, a: chr(int(num(a[0]) or 32)),
    "code": lambda ev, a: ord(to_text(plain(a[0]))[:1] or " "),
    "textjoin": lambda ev, a: to_text(plain(a[0])).join(to_text(v) for v in flat(a[2:]) if not (truthy(a[1]) and v in (None, ""))),
    "join": lambda ev, a: to_text(plain(a[1]) if len(a) > 1 else ",").join(to_text(v) for v in flat([a[0]])),
    "pad_left": lambda ev, a: to_text(plain(a[0])).rjust(int(num(a[1]) or 0), (to_text(plain(a[2])) if len(a) > 2 else " ")[:1] or " "),
    "pad_right": lambda ev, a: to_text(plain(a[0])).ljust(int(num(a[1]) or 0), (to_text(plain(a[2])) if len(a) > 2 else " ")[:1] or " "),
    "regex_match": lambda ev, a: bool(_regex(a[1]).search(to_text(plain(a[0])))),
    "regex_extract": lambda ev, a: (lambda m: (m.group(1) if m and m.groups() else m.group(0) if m else None))(_regex(a[1]).search(to_text(plain(a[0])))),
    "regex_replace": lambda ev, a: _regex(a[1]).sub(to_text(plain(a[2])) if len(a) > 2 else "", to_text(plain(a[0]))),
    "url_encode": lambda ev, a: _up.quote(to_text(plain(a[0])), safe=""),
    "url_decode": lambda ev, a: _up.unquote(to_text(plain(a[0]))),
    "query_params": lambda ev, a: (QUERY_PARAMS.get().get(to_text(plain(a[0])), plain(a[1]) if len(a) > 1 else None) if a
                                   else {"__kind__": "array", "items": [f"{k}={v}" for k, v in QUERY_PARAMS.get().items()]}),
    # dates
    "weekday": lambda ev, a: _date(a[0]).isoweekday() % 7 + 1,
    "weeknum": lambda ev, a: _date(a[0]).isocalendar()[1],
    "hour": lambda ev, a: dt.datetime.fromisoformat(to_text(plain(a[0])).replace(" ", "T")).hour,
    "minute": lambda ev, a: dt.datetime.fromisoformat(to_text(plain(a[0])).replace(" ", "T")).minute,
    "second": lambda ev, a: dt.datetime.fromisoformat(to_text(plain(a[0])).replace(" ", "T")).second,
    "edate": lambda ev, a: _add_months(_date(a[0]), int(num(a[1]) or 0)).isoformat(),
    "add_months": lambda ev, a: _add_months(_date(a[0]), int(num(a[1]) or 0)).isoformat(),
    "eomonth": lambda ev, a: _eomonth(a),
    "datevalue": lambda ev, a: _date(a[0]).isoformat(),
    "date_format": lambda ev, a: _text_format([a[0], a[1] if len(a) > 1 else "yyyy-mm-dd"]),
    "networkdays": lambda ev, a: _networkdays(a),
    # arrays
    "array_slice": lambda ev, a: {"__kind__": "array", "items": flat([a[0]])[int(num(a[1]) or 0): int(num(a[2])) if len(a) > 2 else None]},
    "array_join": lambda ev, a: to_text(plain(a[1]) if len(a) > 1 else ",").join(to_text(v) for v in flat([a[0]])),
    "array_reverse": lambda ev, a: {"__kind__": "array", "items": list(reversed(flat([a[0]])))},
    "array_sum": lambda ev, a: clean_number(sum(nums([a[0]]))),
    "array_avg": lambda ev, a: clean_number(sum(nums([a[0]])) / len(nums([a[0]]))) if nums([a[0]]) else None,
    "array_min": lambda ev, a: clean_number(min(nums([a[0]]))) if nums([a[0]]) else None,
    "array_max": lambda ev, a: clean_number(max(nums([a[0]]))) if nums([a[0]]) else None,
    "array_get": lambda ev, a: (flat([a[0]]) + [None] * int(num(a[1]) or 0))[int(num(a[1]) or 1) - 1],
})


# functions whose arguments are evaluated lazily (control flow, ranges kept as addresses)
LAZY: dict[str, Callable[[Evaluator, list[Any]], Any]] = {
    "if": _if,
    "iferror": _iferror,
    "ifs": _ifs,
    "switch": _switch,
    "choose": _choose,
    "action.copy": _copy,
    "action.copy_range": _copy,
    "action.toast": lambda ev, a: _action("toast", message=to_text(plain(ev.scalar(a[0]))) if a else "",
                                          intent=to_text(plain(ev.scalar(a[1]))) if len(a) > 1 else "primary"),
    "action.parallel": lambda ev, a: _action("parallel", actions=_actions_of(ev, a)),
    "action.serial": _serial,
    "action.trigger": _trigger,
    "action.label": _label,
    "action.submit_to_region": _submit,
    "action.apply_action": _apply_action,
}


def display(v: Any) -> str:
    """The text a cell shows."""
    if isinstance(v, dict) and "__kind__" in v:
        k = v["__kind__"]
        if k == "error":
            return ERROR_TEXT.get(v.get("code") or "", "#ERROR")
        if k == "array":
            return "[" + ", ".join(to_text(x) for x in v.get("items") or []) + "]"
        if k == "dropdown":
            return to_text(v.get("value"))
        if k in ("url", "styled", "modifier", "checkbox", "datepicker", "property"):
            return to_text(v.get("value"))
        if k == "object":
            return to_text(v.get("title"))
        if k == "submit_options":
            return ", ".join(f"{key}={to_text(x)}" for key, x in (v.get("options") or {}).items())
        if k == "matrix":
            rows = v.get("rows") or [[None]]
            return display(rows[0][0] if rows[0] else None)
        if k == "chart":
            return "chart · " + ", ".join(f"{p.get('type')} of {len(p.get('y') or [])}" for p in v.get("plots") or [])
        if k == "chart_options":
            return ", ".join(f"{key}={to_text(x)}" for key, x in (v.get("options") or {}).items())
        if k == "action":
            return ((v.get("label") or {}).get("text") if isinstance(v.get("label"), dict) else None) or "▶"
        if k == "validation":
            return "Validate"
        if k == "label":
            return v.get("text") or ""
        if k == "timeseries":
            pts = v.get("points") or []
            return f"{v.get('label') or 'time series'} · {len(pts)} points" + (f" · last {to_text(pts[-1][1])}" if pts else "")
    return to_text(v)


# ------------------------------------------------------------------ time series (ts.*)

TS_MAX_POINTS = 10_000


def _series(v: Any, name: str) -> dict:
    if isinstance(v, dict) and v.get("__kind__") == "timeseries":
        return v
    raise FusionError(f"{name} takes a time series (ts.timeseries(…))")


def _ts_value(points: list, label: str) -> dict:
    return {"__kind__": "timeseries", "label": label, "points": points[-TS_MAX_POINTS:]}


def _ts_load(ev: "Evaluator", a: list) -> dict:
    """ts.timeseries("series id") or ("sync id/series id"): the series' points from a time series sync this user can read."""
    import timeseries
    from fastapi import HTTPException

    _arity(a, 1, 1, "ts.timeseries")
    ref = to_text(plain(a[0])).strip()
    sync_id, _, series_id = ref.rpartition("/") if "/" in ref else ("", "", ref)
    for sid in ([sync_id] if sync_id else timeseries.syncs_holding(series_id)):
        try:
            timeseries.check_sync(sid)
        except HTTPException:
            continue
        pts = [[t, v] for t, v in timeseries.read_points(sid, series_id)]
        if pts or sync_id:
            return _ts_value(pts, series_id)
    raise FusionError(f"no time series {ref} you can read")


def _ms_of(v: Any) -> int:
    t = to_text(plain(v)).strip().replace("T", " ")
    try:
        d = dt.datetime.fromisoformat(t)
    except ValueError:
        raise FusionError(f"{t} is not a date or time") from None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return int(d.timestamp() * 1000)


def _when(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).replace(tzinfo=None).isoformat(sep=" ")


def _ts_nums(s: dict) -> list[tuple[int, float]]:
    return [(t, float(v)) for t, v in s["points"] if isinstance(v, (int, float)) and not isinstance(v, bool)]


_UNIT_MS = {"ms": 1, "milliseconds": 1, "s": 1000, "seconds": 1000, "m": 60_000, "minutes": 60_000, "h": 3_600_000, "hours": 3_600_000,
            "d": 86_400_000, "days": 86_400_000, "w": 604_800_000, "weeks": 604_800_000}


def _ts_last(ev: "Evaluator", a: list) -> dict:
    _arity(a, 3, 3, "ts.last")
    s = _series(a[0], "ts.last")
    unit = to_text(plain(a[2])).lower()
    if unit not in _UNIT_MS:
        raise FusionError(f"ts.last: the unit is one of {', '.join(sorted(set(_UNIT_MS)))}")
    if not s["points"]:
        return s
    cut = s["points"][-1][0] - (num(a[1]) or 0) * _UNIT_MS[unit]
    return _ts_value([p for p in s["points"] if p[0] >= cut], s["label"])


def _ts_integral(ev: "Evaluator", a: list) -> Any:
    _arity(a, 1, 2, "ts.integral")
    pts = _ts_nums(_series(a[0], "ts.integral"))
    method = (to_text(plain(a[1])) if len(a) > 1 else "linear").lower()
    if method not in ("linear", "left", "right"):
        raise FusionError("ts.integral: the method is linear, left or right")
    area = 0.0
    for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
        dt_s = (t1 - t0) / 1000
        area += dt_s * ((v0 + v1) / 2 if method == "linear" else v0 if method == "left" else v1)
    return clean_number(area)


def _ts_scale(ev: "Evaluator", a: list) -> dict:
    _arity(a, 2, 2, "ts.scale")
    s = _series(a[0], "ts.scale")
    k = num(a[1]) or 0
    return _ts_value([[t, v * k] for t, v in _ts_nums(s)], s["label"])


def _ts_shift(ev: "Evaluator", a: list) -> dict:
    """Shift the timestamps by a number of milliseconds."""
    _arity(a, 2, 2, "ts.shift")
    s = _series(a[0], "ts.shift")
    d = int(num(a[1]) or 0)
    return _ts_value([[t + d, v] for t, v in s["points"]], s["label"])


def _ts_range(ev: "Evaluator", a: list) -> dict:
    _arity(a, 3, 3, "ts.time_range")
    s = _series(a[0], "ts.time_range")
    lo, hi = _ms_of(a[1]), _ms_of(a[2])
    return _ts_value([p for p in s["points"] if lo <= p[0] <= hi], s["label"])


def _ts_derivative(ev: "Evaluator", a: list) -> dict:
    """The change per second between consecutive points."""
    _arity(a, 1, 1, "ts.derivative")
    s = _series(a[0], "ts.derivative")
    p = _ts_nums(s)
    return _ts_value([[t1, (v1 - v0) / ((t1 - t0) / 1000)] for (t0, v0), (t1, v1) in zip(p, p[1:]) if t1 > t0], s["label"])


def _ts_stat(fn: Callable[[list[float]], Any], name: str) -> Callable[["Evaluator", list], Any]:
    def run(ev: "Evaluator", a: list) -> Any:
        _arity(a, 1, 1, name)
        vals = [v for _, v in _ts_nums(_series(a[0], name))]
        return clean_number(fn(vals)) if vals else None

    return run


FUNCS.update({
    "ts.timeseries": _ts_load,
    "ts.count": lambda ev, a: len(_series(a[0], "ts.count")["points"]),
    "ts.first_value": lambda ev, a: (_series(a[0], "ts.first_value")["points"] or [[None, None]])[0][1],
    "ts.last_value": lambda ev, a: (_series(a[0], "ts.last_value")["points"] or [[None, None]])[-1][1],
    "ts.first_timestamp": lambda ev, a: _when(s["points"][0][0]) if (s := _series(a[0], "ts.first_timestamp"))["points"] else None,
    "ts.last_timestamp": lambda ev, a: _when(s["points"][-1][0]) if (s := _series(a[0], "ts.last_timestamp"))["points"] else None,
    "ts.min": _ts_stat(min, "ts.min"),
    "ts.max": _ts_stat(max, "ts.max"),
    "ts.mean": _ts_stat(lambda v: sum(v) / len(v), "ts.mean"),
    "ts.stddev": _ts_stat(lambda v: _st.stdev(v) if len(v) > 1 else 0.0, "ts.stddev"),
    "ts.difference": lambda ev, a: clean_number(p[-1][1] - p[0][1]) if (p := _ts_nums(_series(a[0], "ts.difference"))) else None,
    "ts.scale": _ts_scale,
    "ts.shift": _ts_shift,
    "ts.time_range": _ts_range,
    "ts.derivative": _ts_derivative,
    "ts.integral": _ts_integral,
    "ts.last": _ts_last,
})


# ------------------------------------------------------------------------------------------------
# more of the library: multi-criteria aggregates, lookups, rounding, statistics, dates, text, info
# ------------------------------------------------------------------------------------------------

import random as _rand  # noqa: E402


def _ifs_agg(a: list[Any], agg: str, name: str) -> Any:
    """sumifs / averageifs / maxifs / minifs (value range first) and countifs: pairs of range, criterion; all must hold."""
    vals = flat([a[0]]) if agg != "count" else None
    pairs = a[1:] if agg != "count" else a
    if not pairs or len(pairs) % 2:
        raise FusionError(f"{name}() takes pairs of range, criterion")
    ranges = [(flat([pairs[i]]), pairs[i + 1]) for i in range(0, len(pairs), 2)]
    n = len(ranges[0][0]) if vals is None else len(vals)
    hit = [i for i in range(n) if all(i < len(r) and _crit(r[i], c) for r, c in ranges)]
    if agg == "count":
        return len(hit)
    ns = nums([vals[i] for i in hit])
    if not ns:
        return 0 if agg == "sum" else None
    return clean_number({"sum": sum(ns), "avg": sum(ns) / len(ns), "max": max(ns), "min": min(ns)}[agg])


def _xlookup(ev: Evaluator, a: list[Any]) -> Any:
    _arity(a, 3, 4, "xlookup")
    keys, vals = flat([a[1]]), flat([a[2]])
    for i, k in enumerate(keys):
        if compare("==", k, plain(a[0])):
            return vals[i] if i < len(vals) else None
    if len(a) > 3:
        return plain(a[3])
    raise FusionError(f"xlookup: {plain(a[0])} not found")


def _hlookup(ev: Evaluator, a: list[Any]) -> Any:
    _arity(a, 3, 4, "hlookup")
    table, row = a[1], num(a[2])
    if not isinstance(table, Range) or row is None or not table.rows:
        raise FusionError("hlookup(value, range, row number)")
    for j, v in enumerate(table.rows[0]):
        if compare("==", plain(v), plain(a[0])):
            i = int(row) - 1
            return plain(table.rows[i][j]) if 0 <= i < len(table.rows) and j < len(table.rows[i]) else None
    raise NAError(f"hlookup: {to_text(plain(a[0]))} not found")


def _round_to(a: list[Any], how: str) -> Any:
    x, d = num(a[0]) or 0, int(num(a[1]) or 0) if len(a) > 1 else 0
    f = 10 ** d
    if how == "up":
        return clean_number((math.ceil(abs(x) * f - 1e-9) / f) * (1 if x >= 0 else -1))
    return clean_number((math.floor(abs(x) * f + 1e-9) / f) * (1 if x >= 0 else -1))


def _pairs(a: list[Any], name: str) -> tuple[list[float], list[float]]:
    ys, xs = flat([a[0]]), flat([a[1]])
    pts = [(num(y), num(x)) for y, x in zip(ys, xs)]
    pts = [(y, x) for y, x in pts if y is not None and x is not None]
    if len(pts) < 2:
        raise FusionError(f"{name}() needs at least two pairs of numbers")
    return [y for y, _ in pts], [x for _, x in pts]


def _linreg(a: list[Any], name: str) -> tuple[float, float, float]:
    """(slope, intercept, r²) of known y's on known x's."""
    ys, xs = _pairs(a, name)
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if not sxx:
        raise FusionError(f"{name}(): the x values are all the same")
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    syy = sum((y - my) ** 2 for y in ys)
    slope = sxy / sxx
    return slope, my - slope * mx, (sxy * sxy / (sxx * syy)) if syy else 1.0


def _correl(a: list[Any]) -> Any:
    ys, xs = _pairs(a, "correl")
    try:
        return clean_number(_st.correlation(xs, ys))
    except _st.StatisticsError as e:
        raise FusionError(f"correl(): {e}") from None


def _moments(a: list[Any], k: int) -> Any:
    xs = nums(a)
    n = len(xs)
    if n < (3 if k == 3 else 4):
        return None
    m, s = sum(xs) / n, _st.stdev(xs)
    if not s:
        return None
    if k == 3:
        return clean_number(n / ((n - 1) * (n - 2)) * sum(((x - m) / s) ** 3 for x in xs))
    return clean_number(n * (n + 1) / ((n - 1) * (n - 2) * (n - 3)) * sum(((x - m) / s) ** 4 for x in xs) - 3 * (n - 1) ** 2 / ((n - 2) * (n - 3)))


def _quartile(a: list[Any]) -> Any:
    q = int(num(a[1]) or 0)
    if q not in range(5):
        raise FusionError("quartile(range, 0 to 4)")
    return _percentile([a[0], q / 4])


def _percentrank(a: list[Any]) -> Any:
    xs, x = sorted(nums([a[0]])), num(a[1])
    if not xs or x is None or x < xs[0] or x > xs[-1]:
        return None
    if len(xs) == 1:
        return 1
    below = sum(1 for v in xs if v < x)
    if x in xs:
        return clean_number(round(below / (len(xs) - 1), int(num(a[2]) or 3) if len(a) > 2 else 3))
    i = below - 1
    frac = (x - xs[i]) / (xs[i + 1] - xs[i])
    return clean_number(round((i + frac) / (len(xs) - 1), int(num(a[2]) or 3) if len(a) > 2 else 3))


def _substitute(a: list[Any]) -> str:
    text, old, new = to_text(plain(a[0])), to_text(plain(a[1])), to_text(plain(a[2]))
    if len(a) < 4:
        return text.replace(old, new) if old else text
    n = int(num(a[3]) or 0)
    idx = -1
    for _ in range(n):
        idx = text.find(old, idx + 1)
        if idx < 0:
            return text
    return text[:idx] + new + text[idx + len(old):] if old else text


def _fixed(a: list[Any]) -> str:
    x, d = num(a[0]) or 0, int(num(a[1]) or 2) if len(a) > 1 else 2
    no_commas = len(a) > 2 and truthy(a[2])
    return f"{x:.{max(d, 0)}f}" if no_commas else f"{x:,.{max(d, 0)}f}"


def _datedif(a: list[Any]) -> int:
    d0, d1 = _date(a[0]), _date(a[1])
    if d1 < d0:
        raise FusionError("datedif(): the start date is after the end date")
    unit = to_text(plain(a[2])).upper()
    months = (d1.year - d0.year) * 12 + d1.month - d0.month - (1 if d1.day < d0.day else 0)
    if unit == "Y":
        return months // 12
    if unit == "M":
        return months
    if unit == "D":
        return (d1 - d0).days
    if unit == "YM":
        return months % 12
    if unit == "MD":
        return (d1 - _add_months(d0, months)).days
    if unit == "YD":
        start = _add_months(d0, (months // 12) * 12)
        return (d1 - start).days
    raise FusionError("datedif() unit: Y, M, D, YM, MD or YD")


def _days360(d0: dt.date, d1: dt.date) -> int:
    a, b = min(d0.day, 30), d1.day
    if b == 31 and a == 30:
        b = 30
    return (d1.year - d0.year) * 360 + (d1.month - d0.month) * 30 + (b - a)


def _yearfrac(a: list[Any]) -> Any:
    d0, d1 = sorted([_date(a[0]), _date(a[1])])
    basis = int(num(a[2]) or 0) if len(a) > 2 else 0
    if basis == 0:
        return clean_number(_days360(d0, d1) / 360)
    if basis == 2:
        return clean_number((d1 - d0).days / 360)
    if basis == 3:
        return clean_number((d1 - d0).days / 365)
    if basis == 1:
        import calendar

        years = range(d0.year, d1.year + 1)
        avg = sum(366 if calendar.isleap(y) else 365 for y in years) / len(years)
        return clean_number((d1 - d0).days / avg)
    raise FusionError("yearfrac() basis: 0 to 3")


def _workday(a: list[Any]) -> str:
    d, n = _date(a[0]), int(num(a[1]) or 0)
    holidays = {_date(x) for x in flat(a[2:])} if len(a) > 2 else set()
    step = 1 if n >= 0 else -1
    while n:
        d += dt.timedelta(days=step)
        if d.weekday() < 5 and d not in holidays:
            n -= step
    return d.isoformat()


# sequence: see "dynamic arrays" below (its result spills)


def _filter_values(a: list[Any]) -> Any:
    vals, keep = flat([a[0]]), flat([a[1]])
    out = [v for i, v in enumerate(vals) if i < len(keep) and truthy(keep[i])]
    if not out and len(a) > 2:
        return plain(a[2])
    return {"__kind__": "array", "items": out}


def _ifna(ev: Evaluator, a: list[Any]) -> Any:
    _arity(a, 2, 2, "ifna")
    v = ev.eval(a[0])
    return ev.eval(a[1]) if plain(v) is None else v


def _iserror(ev: Evaluator, a: list[Any]) -> bool:
    _arity(a, 1, 1, "iserror")
    try:
        plain(ev.eval(a[0]))
        return False
    except (FusionError, ZeroDivisionError, ValueError, TypeError):
        return True


def _time(a: list[Any]) -> str:
    total = int((num(a[0]) or 0) * 3600 + (num(a[1]) or 0) * 60 + (num(a[2]) or 0)) % 86400
    return f"{total // 3600:02d}:{total % 3600 // 60:02d}:{total % 60:02d}"


FUNCS.update({
    # multi-criteria aggregates
    "sumifs": lambda ev, a: _ifs_agg(a, "sum", "sumifs"),
    "countifs": lambda ev, a: _ifs_agg(a, "count", "countifs"),
    "averageifs": lambda ev, a: _ifs_agg(a, "avg", "averageifs"),
    "maxifs": lambda ev, a: _ifs_agg(a, "max", "maxifs"),
    "minifs": lambda ev, a: _ifs_agg(a, "min", "minifs"),
    # lookups and arrays
    "xlookup": _xlookup,
    "hlookup": _hlookup,
    "sequence": lambda ev, a: _sequence(a),
    "filter": lambda ev, a: _filter_values(a),
    "countunique": lambda ev, a: len({to_text(v) for v in flat(a) if v not in (None, "")}),
    # rounding and arithmetic
    "roundup": lambda ev, a: _round_to(a, "up"),
    "rounddown": lambda ev, a: _round_to(a, "down"),
    "mround": lambda ev, a: clean_number(round((num(a[0]) or 0) / (num(a[1]) or _div0())) * (num(a[1]) or 0)),
    "quotient": lambda ev, a: int((num(a[0]) or 0) / (num(a[1]) or _div0())),
    "gcd": lambda ev, a: math.gcd(*[int(x) for x in nums(a)]) if nums(a) else 0,
    "lcm": lambda ev, a: math.lcm(*[int(x) for x in nums(a)]) if nums(a) else 0,
    "fact": lambda ev, a: math.factorial(int(num(a[0]) or 0)),
    "combin": lambda ev, a: math.comb(int(num(a[0]) or 0), int(num(a[1]) or 0)),
    "permut": lambda ev, a: math.perm(int(num(a[0]) or 0), int(num(a[1]) or 0)),
    "even": lambda ev, a: (lambda x: int(math.copysign(math.ceil(abs(x) / 2) * 2, x)))(num(a[0]) or 0),
    "odd": lambda ev, a: (lambda x: int(math.copysign(max(1, math.ceil((abs(x) - 1) / 2) * 2 + 1), x or 1)))(num(a[0]) or 0),
    "sumsq": lambda ev, a: clean_number(sum(x * x for x in nums(a))),
    "radians": lambda ev, a: math.radians(num(a[0]) or 0),
    "degrees": lambda ev, a: clean_number(math.degrees(num(a[0]) or 0)),
    "asin": lambda ev, a: math.asin(num(a[0]) or 0),
    "acos": lambda ev, a: math.acos(num(a[0]) or 0),
    "atan": lambda ev, a: math.atan(num(a[0]) or 0),
    "atan2": lambda ev, a: math.atan2(num(a[1]) or 0, num(a[0]) or 0),
    "sinh": lambda ev, a: clean_number(math.sinh(num(a[0]) or 0)),
    "cosh": lambda ev, a: clean_number(math.cosh(num(a[0]) or 0)),
    "tanh": lambda ev, a: math.tanh(num(a[0]) or 0),
    "rand": lambda ev, a: _rand.random(),
    "randbetween": lambda ev, a: _rand.randint(int(num(a[0]) or 0), int(num(a[1]) or 0)),
    # statistics
    "geomean": lambda ev, a: clean_number(_st.geometric_mean(nums(a))) if nums(a) and min(nums(a)) > 0 else None,
    "harmean": lambda ev, a: clean_number(_st.harmonic_mean(nums(a))) if nums(a) and min(nums(a)) > 0 else None,
    "avedev": lambda ev, a: clean_number(sum(abs(x - sum(xs) / len(xs)) for x in xs) / len(xs)) if (xs := nums(a)) else None,
    "devsq": lambda ev, a: clean_number(sum((x - sum(xs) / len(xs)) ** 2 for x in xs)) if (xs := nums(a)) else None,
    "varp": lambda ev, a: clean_number(_st.pvariance(nums(a))) if nums(a) else None,
    "correl": lambda ev, a: _correl(a),
    "covar": lambda ev, a: (lambda ys, xs: clean_number(sum((x - sum(xs) / len(xs)) * (y - sum(ys) / len(ys)) for x, y in zip(xs, ys)) / len(xs)))(*_pairs(a, "covar")),
    "slope": lambda ev, a: clean_number(_linreg(a, "slope")[0]),
    "intercept": lambda ev, a: clean_number(_linreg(a, "intercept")[1]),
    "rsq": lambda ev, a: clean_number(_linreg(a, "rsq")[2]),
    "forecast": lambda ev, a: (lambda s, i, _r: clean_number(i + s * (num(a[0]) or 0)))(*_linreg(a[1:], "forecast")),
    "quartile": lambda ev, a: _quartile(a),
    "percentrank": lambda ev, a: _percentrank(a),
    "skew": lambda ev, a: _moments(a, 3),
    "kurt": lambda ev, a: _moments(a, 4),
    # information
    "isblank": lambda ev, a: plain(a[0]) in (None, ""),
    "iseven": lambda ev, a: int(num(a[0]) or 0) % 2 == 0,
    "isodd": lambda ev, a: int(num(a[0]) or 0) % 2 == 1,
    "islogical": lambda ev, a: isinstance(plain(a[0]), bool),
    "isnumber": lambda ev, a: isinstance(plain(a[0]), (int, float)) and not isinstance(plain(a[0]), bool),
    "istext": lambda ev, a: isinstance(plain(a[0]), str),
    "na": lambda ev, a: _na(),
    "n": lambda ev, a: (lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else int(v) if isinstance(v, bool) else 0)(plain(a[0])),
    "t": lambda ev, a: plain(a[0]) if isinstance(plain(a[0]), str) else "",
    # text
    "exact": lambda ev, a: to_text(plain(a[0])) == to_text(plain(a[1])),
    "substitute": lambda ev, a: _substitute(a),
    "fixed": lambda ev, a: _fixed(a),
    "clean": lambda ev, a: "".join(ch for ch in to_text(plain(a[0])) if ord(ch) >= 32),
    "unichar": lambda ev, a: chr(int(num(a[0]) or 32)),
    "unicode": lambda ev, a: ord(to_text(plain(a[0]))[:1] or " "),
    "textbefore": lambda ev, a: (lambda s, d: s[: s.find(d)] if d and d in s else None)(to_text(plain(a[0])), to_text(plain(a[1]))),
    "textafter": lambda ev, a: (lambda s, d: s[s.find(d) + len(d):] if d and d in s else None)(to_text(plain(a[0])), to_text(plain(a[1]))),
    # dates and times
    "time": lambda ev, a: _time(a),
    "datedif": lambda ev, a: _datedif(a),
    "days": lambda ev, a: (_date(a[0]) - _date(a[1])).days,
    "days360": lambda ev, a: _days360(_date(a[0]), _date(a[1])),
    "yearfrac": lambda ev, a: _yearfrac(a),
    "workday": lambda ev, a: _workday(a),
    "isoweeknum": lambda ev, a: _date(a[0]).isocalendar()[1],
    "quarter": lambda ev, a: (_date(a[0]).month - 1) // 3 + 1,
})
LAZY.update({"ifna": _ifna, "iserror": _iserror})


# ------------------------------------------------------------------------------------------------
# the rest of the library: Fusion's remaining documented functions (arrays, text, dates, hashes, lookup modifiers,
# subtotal, validate_table) and the spreadsheet families (financial, distributions, database, engineering, references)
# ------------------------------------------------------------------------------------------------

import calendar as _cal  # noqa: E402
import hashlib as _hash  # noqa: E402

_ERRORS = (FusionError, ZeroDivisionError, ValueError, TypeError, OverflowError)


def _arr(items: Any) -> dict:
    return {"__kind__": "array", "items": list(items)}


def _x(a: list[Any], i: int, name: str, default: Optional[float] = None) -> float:
    """The i-th argument as a number (the default when it is left out)."""
    if i >= len(a) or plain(a[i]) in (None, ""):
        if default is None:
            raise FusionError(f"{name}(): argument {i + 1} is missing")
        return default
    v = num(a[i])
    if v is None:
        raise FusionError(f"{name}(): argument {i + 1} is not a number")
    return v


def _flag(a: list[Any], i: int, default: bool) -> bool:
    return truthy(a[i]) if len(a) > i and plain(a[i]) not in (None, "") else default


def _key(v: Any) -> tuple:
    """What makes two array elements the same (1 and 1.0 are, 1 and '1' are not)."""
    if isinstance(v, bool):
        return ("b", v)
    if isinstance(v, (int, float)):
        return ("n", float(v))
    return ("o", repr(v))


def _distinct(vals: list[Any]) -> list[Any]:
    seen: dict[tuple, Any] = {}
    for v in vals:
        seen.setdefault(_key(v), v)
    return list(seen.values())


def _array_difference(a: list[Any]) -> dict:
    drop = {_key(v) for x in a[1:] for v in flat([x])}
    return _arr(v for v in _distinct(flat([a[0]])) if _key(v) not in drop)


def _array_intersection(a: list[Any]) -> dict:
    keep = [{_key(v) for v in flat([x])} for x in a[1:]]
    return _arr(v for v in _distinct(flat([a[0]])) if all(_key(v) in k for k in keep))


def _array_sort(a: list[Any]) -> dict:
    desc = len(a) > 1 and (plain(a[1]) is False or to_text(plain(a[1])).upper() in ("DESC", "FALSE"))
    return _arr(sorted((v for v in flat([a[0]]) if v is not None), key=lambda x: (isinstance(x, str), x), reverse=desc))


def _array_at(a: list[Any], i: int) -> Any:
    vals = flat([a[0]])
    return vals[i] if -len(vals) <= i < len(vals) else None


def _pad(a: list[Any], left: bool, name: str) -> str:
    """lpad / rpad: the pad string repeats up to the length; a longer value is cut to the length."""
    s, n = to_text(plain(a[0])), int(_x(a, 1, name))
    pad = to_text(plain(a[2])) if len(a) > 2 else " "
    if n <= len(s) or not pad:
        return s[: max(n, 0)]
    fill = (pad * n)[: n - len(s)]
    return fill + s if left else s + fill


def _format_string(a: list[Any]) -> str:
    if not a:
        raise FusionError("format_string(format, value…)")
    vals = tuple(clean_number(v) if isinstance(v, float) else v for v in flat(a[1:]))
    try:
        return to_text(plain(a[0])) % vals
    except (TypeError, ValueError) as e:
        raise FusionError(f"format_string(): {e}") from None


def _sum_product(a: list[Any]) -> Any:
    cols = [[num(v) or 0 for v in flat([r])] for r in a]
    if len({len(c) for c in cols}) > 1:
        raise FusionError("sum_product(): the ranges have different sizes")
    return clean_number(sum(math.prod(t) for t in zip(*cols)))


# ------------------------------------------------------------------ dates and timestamps


def _datetime(v: Any) -> dt.datetime:
    v = plain(v)
    if isinstance(v, dt.datetime):
        return v.replace(tzinfo=None)
    if isinstance(v, dt.date):
        return dt.datetime(v.year, v.month, v.day)
    try:
        return dt.datetime.fromisoformat(str(v).strip().replace("T", " ").removesuffix("Z")).replace(tzinfo=None)
    except ValueError:
        raise FusionError(f"not a date or timestamp: {v}") from None


def _stamp(d: dt.datetime) -> str:
    """A date when the time is midnight, a timestamp (yyyy-MM-dd HH:mm:ss) otherwise."""
    d = d.replace(microsecond=0)
    return d.date().isoformat() if (d.hour, d.minute, d.second) == (0, 0, 0) else d.isoformat(sep=" ")


def _is_days(v: Any) -> bool:
    v = plain(v)
    if isinstance(v, bool):
        return False
    return isinstance(v, (int, float)) or (isinstance(v, str) and num(v) is not None)


def _date_add(a: list[Any], sign: int, name: str) -> Any:
    """date_add / date_sub: each side is a date or a number of days (fractions of a day give a timestamp)."""
    _arity(a, 2, 2, name)
    left, right = a
    if _is_days(left) and _is_days(right):
        return clean_number(num(left) + sign * num(right))
    if _is_days(right):
        return _stamp(_datetime(left) + dt.timedelta(days=sign * num(right)))
    if _is_days(left):
        if sign < 0:
            raise FusionError("date_sub(): a date cannot be taken from a number of days")
        return _stamp(_datetime(right) + dt.timedelta(days=num(left)))
    if sign < 0:
        return clean_number((_datetime(left) - _datetime(right)).total_seconds() / 86400)
    raise FusionError("date_add(): one of the two is a number of days")


def _pattern_runs(pattern: str) -> list[tuple[str, str]]:
    """A Java date pattern as runs: ("y", "yyyy"), ("", "-"), ("'", literal text)."""
    out, i = [], 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == "'":
            j = pattern.find("'", i + 1)
            j = len(pattern) if j < 0 else j
            out.append(("'", pattern[i + 1: j] or "'"))
            i = j + 1
        elif ch.isalpha():
            j = i
            while j < len(pattern) and pattern[j] == ch:
                j += 1
            out.append((ch, pattern[i:j]))
            i = j
        else:
            out.append(("", ch))
            i += 1
    return out


def _legacy_pattern(pattern: str) -> str:
    """"yyyy-mm-dd" (months written in lower case, no time in the pattern) reads as yyyy-MM-dd."""
    return pattern.replace("m", "M") if not _re.search(r"[MHhs]", pattern) else pattern


def _java_format(d: dt.datetime, pattern: str) -> str:
    out = []
    for ch, run in _pattern_runs(pattern):
        n = len(run)
        if ch in ("", "'"):
            out.append(run)
        elif ch == "y":
            out.append(f"{d.year % 100:02d}" if n == 2 else f"{d.year:04d}")
        elif ch == "M":
            out.append(_cal.month_name[d.month] if n >= 4 else _cal.month_abbr[d.month] if n == 3 else f"{d.month:0{n}d}")
        elif ch == "E":
            out.append(_cal.day_name[d.weekday()] if n >= 4 else _cal.day_abbr[d.weekday()])
        elif ch == "a":
            out.append("AM" if d.hour < 12 else "PM")
        elif ch == "S":
            out.append(f"{d.microsecond:06d}"[:n].ljust(n, "0"))
        elif ch in "dDHhms":
            val = {"d": d.day, "D": d.timetuple().tm_yday, "H": d.hour, "h": d.hour % 12 or 12, "m": d.minute, "s": d.second}[ch]
            out.append(f"{val:0{n}d}")
        else:
            raise FusionError(f"date format: {run} is not supported")
    return "".join(out)


def _strptime_format(pattern: str) -> str:
    out = []
    for ch, run in _pattern_runs(pattern):
        n = len(run)
        if ch in ("", "'"):
            out.append(run.replace("%", "%%"))
        elif ch == "y":
            out.append("%y" if n == 2 else "%Y")
        elif ch == "M":
            out.append("%B" if n >= 4 else "%b" if n == 3 else "%m")
        elif ch == "E":
            out.append("%A" if n >= 4 else "%a")
        elif ch in "dDHhmsSa":
            out.append({"d": "%d", "D": "%j", "H": "%H", "h": "%I", "m": "%M", "s": "%S", "S": "%f", "a": "%p"}[ch])
        else:
            raise FusionError(f"date format: {run} is not supported")
    return "".join(out)


def _date_format(a: list[Any]) -> str:
    _arity(a, 1, 2, "date_format")
    pattern = to_text(plain(a[1])) if len(a) > 1 else "yyyy-MM-dd"
    if _is_days(a[0]):
        return _text_format([a[0], pattern])  # a number keeps the number formats of text(), as before
    return _java_format(_datetime(a[0]), _legacy_pattern(pattern))


def _parse_when(a: list[Any], name: str) -> dt.datetime:
    """parse_date / parse_timestamp: the formats (Java patterns) are tried in order."""
    if not a:
        raise FusionError(f"{name}(text, format…)")
    s = to_text(plain(a[0])).strip()
    fmts = [to_text(f) for f in flat(a[1:]) if f not in (None, "")]
    if not fmts:
        return _datetime(s)
    for f in fmts:
        try:
            return dt.datetime.strptime(s, _strptime_format(f))
        except ValueError:
            continue
    raise FusionError(f"{name}(): {s!r} does not match {', '.join(fmts)}")


def _timestamp(a: list[Any]) -> str:
    y = int(_x(a, 0, "timestamp"))
    vals = [int(_x(a, i, "timestamp", 1 if i < 3 else 0)) for i in range(1, 6)]
    return dt.datetime(y + 1900 if y < 1900 else y, *vals).isoformat(sep=" ")


def _months_between(a: list[Any]) -> Any:
    s, e = _datetime(a[0]), _datetime(a[1])
    months = (e.year - s.year) * 12 + e.month - s.month
    last = lambda d: d.day == _cal.monthrange(d.year, d.month)[1]  # noqa: E731
    if s.day == e.day or (last(s) and last(e)):
        return months
    return clean_number(round(months + (e.day - s.day) / 31, 8))


def _timevalue(a: list[Any]) -> Any:
    m = _re.search(r"(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\s*$", to_text(plain(a[0])))
    if not m:
        raise FusionError(f"timevalue(): not a time: {plain(a[0])}")
    h, mi, s = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
    if m.group(4):
        h = h % 12 + (12 if m.group(4).lower() == "pm" else 0)
    if h > 23 or mi > 59 or s > 59:
        raise FusionError(f"timevalue(): not a time: {plain(a[0])}")
    return clean_number((h * 3600 + mi * 60 + s) / 86400)


# weekend codes of networkdays.intl / workday.intl → Python weekdays (Monday = 0)
_WEEKENDS = {1: (5, 6), 2: (6, 0), 3: (0, 1), 4: (1, 2), 5: (2, 3), 6: (3, 4), 7: (4, 5), 11: (6,), 12: (0,), 13: (1,), 14: (2,), 15: (3,), 16: (4,),
             17: (5,)}


def _weekend(a: list[Any], i: int, name: str) -> set[int]:
    v = plain(a[i]) if len(a) > i else None
    if v in (None, ""):
        return {5, 6}
    s = to_text(v)
    if len(s) == 7 and set(s) <= {"0", "1"}:
        if s == "1111111":
            raise FusionError(f"{name}(): every day is a weekend")
        return {k for k, ch in enumerate(s) if ch == "1"}
    n = num(v)
    if n is None or int(n) not in _WEEKENDS:
        raise FusionError(f"{name}(): weekend is 1 to 7, 11 to 17 or seven 0/1 characters starting on Monday")
    return set(_WEEKENDS[int(n)])


def _networkdays_intl(a: list[Any]) -> int:
    _arity(a, 2, None, "networkdays.intl")
    d0, d1 = _date(a[0]), _date(a[1])
    off = _weekend(a, 2, "networkdays.intl")
    holidays = {_date(x) for x in flat(a[3:]) if x not in (None, "")}
    step = 1 if d1 >= d0 else -1
    n, d = 0, d0
    while (d <= d1) if step > 0 else (d >= d1):
        if d.weekday() not in off and d not in holidays:
            n += 1
        d += dt.timedelta(days=step)
    return n * step


def _workday_intl(a: list[Any]) -> str:
    _arity(a, 2, None, "workday.intl")
    d, n = _date(a[0]), int(_x(a, 1, "workday.intl"))
    off = _weekend(a, 2, "workday.intl")
    holidays = {_date(x) for x in flat(a[3:]) if x not in (None, "")}
    step = 1 if n >= 0 else -1
    while n:
        d += dt.timedelta(days=step)
        if d.weekday() not in off and d not in holidays:
            n -= step
    return d.isoformat()


def _epochtodate(a: list[Any]) -> str:
    unit = int(_x(a, 1, "epochtodate", 1))
    if unit not in (1, 2, 3):
        raise FusionError("epochtodate() unit: 1 seconds, 2 milliseconds, 3 microseconds")
    secs = _x(a, 0, "epochtodate") / (1, 1000, 1_000_000)[unit - 1]
    return (dt.datetime(1970, 1, 1) + dt.timedelta(seconds=int(secs))).isoformat(sep=" ")


# ------------------------------------------------------------------ lookup modifiers (eq, gt, fuzzy, …)

_MODIFIER_OPS = {"eq": "==", "neq": "!=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}
_OBJECT_OPS = {"==": "eq", "!=": "neq", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte", "exact": "eq"}


def _modifier(op: str, a: list[Any], name: str) -> dict:
    """A value tagged with how a lookup compares it: lookup(dataset, column, 'age', gt(30))."""
    _arity(a, 1, 2 if op == "fuzzy" else 1, name)
    out = {"__kind__": "modifier", "op": op, "value": plain(a[0])}
    if op == "fuzzy":
        d = int(_x(a, 1, "fuzzy", 2))
        if d not in (0, 1, 2):
            raise FusionError("fuzzy(): the distance is 0, 1 or 2")
        out["distance"] = d
    return out


def _levenshtein(s: str, t: str) -> int:
    prev = list(range(len(t) + 1))
    for i, cs in enumerate(s, 1):
        cur = [i]
        for j, ct in enumerate(t, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (cs != ct)))
        prev = cur
    return prev[-1]


def _modified(cell: Any, m: dict) -> bool:
    op, want = m.get("op"), m.get("value")
    if op in ("==", "!=", "<", ">", "<=", ">="):
        return compare(op, cell, want)
    if op == "exact":
        return to_text(cell) == to_text(want)
    if op == "fuzzy":
        return _levenshtein(to_text(cell).lower(), to_text(want).lower()) <= int(m.get("distance", 2))
    words = set(_re.findall(r"\w+", to_text(cell).lower()))
    terms = _re.findall(r"\w+", to_text(want).lower())
    return bool(terms) and (all if op == "all_tokens" else any)(t in words for t in terms)


def _exact(a: list[Any]) -> Any:
    if len(a) == 1:
        return _modifier("exact", a, "exact")
    _arity(a, 2, 2, "exact")
    return to_text(plain(a[0])) == to_text(plain(a[1]))


def _lookup_sorted(ev: Evaluator, a: list[Any]) -> Any:
    if len(a) < 4:
        raise FusionError("lookup_sorted(dataset, column, sort column, 'ASC' or 'DESC', [filter column, filter value]…)")
    cols, rows = ev.dataset(a[0])
    col, by, direction = (to_text(plain(x)) for x in a[1:4])
    fs = _filters(a[4:])
    for c in [col, by] + [c for c, _ in fs]:
        if c not in cols:
            raise FusionError(f"the dataset has no column {c}")
    if direction.upper() not in ("ASC", "DESC"):
        raise FusionError("lookup_sorted(): the direction is 'ASC' or 'DESC'")
    hit = _hit_rows(rows, fs, [col, by])
    known = [r for r in hit if r.get(by) is not None]
    try:
        known.sort(key=lambda r: r[by], reverse=direction.upper() == "DESC")
    except TypeError:
        known.sort(key=lambda r: to_text(r[by]), reverse=direction.upper() == "DESC")
    return _one_or_many([r.get(col) for r in known + [r for r in hit if r.get(by) is None]][:MAX_LOOKUP])


# ------------------------------------------------------------------ subtotal, validate_table, document metadata

_SUBTOTAL = {1: "avg", 2: "count_numeric", 3: "counta", 4: "max", 5: "min", 6: "product", 7: "stdev", 8: "stdevp", 9: "sum", 10: "var", 11: "varp"}


def _subtotal(ev: Evaluator, a: list[Any]) -> Any:
    """subtotal(code, range…): cells that are themselves subtotals are left out, so nothing is counted twice."""
    code = int(_x(a, 0, "subtotal")) % 100
    if code not in _SUBTOTAL or len(a) < 2:
        raise FusionError("subtotal(function code 1 to 11 or 101 to 111, range…)")
    vals: list[Any] = []
    for r in a[1:]:
        if isinstance(r, Range) and r.cells:
            cells = ev.sheet_named(r.sheet).get("cells") or {}
            for row, addrs in zip(r.rows, r.cells):
                for v, ad in zip(row, addrs):
                    src = (cells.get(ad) or {}).get("input")
                    if not (isinstance(src, str) and _re.match(r"\s*=\s*subtotal\s*\(", src, _re.I)):
                        vals.append(plain(v))
        else:
            vals.extend(flat([r]))
    return FUNCS[_SUBTOTAL[code]](ev, [vals])


_TABLE_CONDITIONS = ("column_enum", "column_not_null", "column_numeric", "column_regex", "table_headers", "table_key")


def _table_condition(ev: Evaluator, node: Any, headers: list[str], rows: list[list[Any]]) -> dict:
    """One condition of validate_table: column_*('column name', …) and table_*('column name'…) read the table by header."""
    by_name = node[0] == "call" and node[1] in _TABLE_CONDITIONS and not (node[2] and node[2][0][0] == "range")
    if not by_name:
        v = ev.eval(node)
        if isinstance(v, dict) and v.get("__kind__") == "validation":
            return v
        return _validation(truthy(v), "the condition holds")
    name, args = node[1], [ev.eval(x) for x in node[2]]
    names = [to_text(x) for x in flat(args if name in ("column_not_null", "column_numeric", "table_headers", "table_key") else args[:1])]

    def col(c: str) -> list[Any]:
        if c not in headers:
            raise FusionError(f"{name}(): the table has no column {c}")
        j = headers.index(c)
        return [r[j] for r in rows if j < len(r) and r[j] not in (None, "")]

    if name == "table_headers":
        return _validation(set(names) <= set(headers), f"the table has the columns {', '.join(names)}")
    if name == "table_key":
        idx = [headers.index(k) for k in (names or headers) if k in headers]
        if len(idx) != len(names or headers):
            return _validation(False, "the table lacks a key column")
        seen = [tuple(r[i] for i in idx) for r in rows if any(x not in (None, "") for x in r)]
        return _validation(len(seen) == len(set(seen)), f"{', '.join(names or headers)} is unique")
    if not names:
        raise FusionError(f"{name}() needs a column name")
    if name == "column_not_null":
        ok = all(len(col(c)) == sum(1 for r in rows if any(x not in (None, "") for x in r)) for c in names)
        return _validation(ok, f"{', '.join(names)}: no empty values")
    if name == "column_numeric":
        return _validation(all(num(v) is not None for c in names for v in col(c)), f"{', '.join(names)}: only numbers")
    if len(args) < 2:
        raise FusionError(f"{name}(column name, {'allowed values' if name == 'column_enum' else 'regular expression'})")
    if name == "column_enum":
        allowed = flat([args[1]])
        return _validation(all(v in allowed for v in col(names[0])), f"{names[0]}: every value is in the allowed list")
    rx = _regex(args[1])
    return _validation(all(rx.search(to_text(v)) for v in col(names[0])), f"{names[0]}: every value matches {rx.pattern}")


def _validate_table(ev: Evaluator, a: list[Any]) -> dict:
    if not a:
        raise FusionError("validate_table(table range, condition…)")
    headers, rows = _range_columns(ev.eval(a[0]), "validate_table")
    failed = [c["message"] for c in (_table_condition(ev, n, headers, rows) for n in a[1:]) if not c.get("ok")]
    return _validation(not failed, "; ".join(failed) if failed else "the table is valid")


def _document_metadata(ev: Evaluator, a: list[Any]) -> Any:
    _arity(a, 1, 1, "document_metadata")
    key = to_text(plain(a[0]))
    if key not in ("creator", "document_identifier"):
        raise FusionError("document_metadata(): the key is 'creator' or 'document_identifier'")
    return (getattr(ev, "meta", None) or {}).get(key)


def _experimental_range(a: list[Any]) -> Range:
    w = int(_x(a, 0, "experimental_range"))
    if w < 1:
        raise FusionError("experimental_range(): the width is at least 1")
    vals = flat(a[1:])
    return Range([vals[i: i + w] + [None] * (w - len(vals[i: i + w])) for i in range(0, len(vals), w)])


# ------------------------------------------------------------------ references and arrays


def _index_at(ev: Evaluator, a: list[Any]) -> Any:
    """index(range, row, [column]); row 0 gives the whole column, column 0 the whole row, both 0 the range."""
    _arity(a, 2, 3, "index")
    r = a[0]
    rows = r.rows if isinstance(r, Range) else [[x] for x in (flat([r]) or [])]
    i = 1 if num(a[1]) is None else int(num(a[1]))
    j = 1 if len(a) < 3 or num(a[2]) is None else int(num(a[2]))
    if len(a) < 3 and len(rows) == 1 and len(rows[0]) > 1:
        i, j = 1, i
    if i < 0 or j < 0:
        raise FusionError("index out of range")
    try:
        if i == 0 and j == 0:
            return r if isinstance(r, Range) else _arr(flat([r]))
        if i == 0:
            return _arr(plain(row[j - 1]) for row in rows)
        if j == 0:
            return _arr(plain(x) for x in rows[i - 1])
        return plain(rows[i - 1][j - 1])
    except IndexError:
        raise FusionError("index out of range") from None


def _nearest(item: Any, vals: list[Any], mode: int) -> Optional[int]:
    """The position (1-based) of item; mode 1: the largest value below or equal, -1: the smallest above or equal."""
    best: Optional[int] = None
    for i, v in enumerate(vals):
        if v in (None, ""):
            continue
        if compare("==", v, item):
            return i + 1
        if mode and compare("<" if mode > 0 else ">", v, item):
            if best is None or compare(">" if mode > 0 else "<", v, vals[best - 1]):
                best = i + 1
    return best


def _match_pos(a: list[Any]) -> Any:
    _arity(a, 2, 3, "match")
    return _found(_nearest(plain(a[0]), flat([a[1]]), int(_x(a, 2, "match", 0))), "match", a[0])


def _found(pos: Optional[int], name: str, item: Any) -> int:
    """A position match / xmatch found; nothing found is #N/A."""
    if pos is None:
        raise NAError(f"{name}: {to_text(plain(item))} not found")
    return pos


def _xmatch(a: list[Any]) -> Any:
    _arity(a, 2, 3, "xmatch")
    mode = int(_x(a, 2, "xmatch", 0))
    vals = flat([a[1]])
    if mode == 2:
        return _found(next((i + 1 for i, v in enumerate(vals) if _crit(v, a[0])), None), "xmatch", a[0])
    if mode not in (0, 1, -1):
        raise FusionError("xmatch() match mode: 0 exact, -1 exact or next smaller, 1 exact or next larger, 2 wildcard")
    return _found(_nearest(plain(a[0]), vals, -mode), "xmatch", a[0])


def _ref_cells(ev: Evaluator, n: Any, name: str) -> tuple[dict, list[list[str]]]:
    if not isinstance(n, tuple) or n[0] not in ("ref", "range"):
        raise FusionError(f"{name}() takes a cell or a range")
    return ev.sheet_named(n[1]), [[n[2]]] if n[0] == "ref" else range_cells(n[2], n[3])


def _position(ev: Evaluator, a: list[Any], name: str) -> tuple[int, int]:
    _arity(a, 0, 1, name)
    if not a:
        at = getattr(ev, "at", None)
        if not at:
            raise FusionError(f"{name}() needs a cell")
        return parse_addr(at)
    return parse_addr(_ref_cells(ev, a[0], name)[1][0][0])


def _offset(ev: Evaluator, a: list[Any]) -> Any:
    _arity(a, 3, 5, "offset")
    s, cells = _ref_cells(ev, a[0], "offset")
    r0, c0 = parse_addr(cells[0][0])

    def arg(i: int, default: int) -> int:
        v = num(ev.scalar(a[i])) if len(a) > i else None
        return default if v is None else int(v)

    r, c, h, w = r0 + arg(1, 0), c0 + arg(2, 0), arg(3, len(cells)), arg(4, len(cells[0]))
    if r < 0 or c < 0 or h < 1 or w < 1:
        raise FusionError("offset(): the reference is off the sheet")
    if h == 1 and w == 1:
        return ev.cell_value(s, addr(r, c))
    out = range_cells(addr(r, c), addr(r + h - 1, c + w - 1))
    return Range([[ev.cell_value(s, x) for x in row] for row in out], s["name"], out)


def _indirect(ev: Evaluator, a: list[Any]) -> Any:
    _arity(a, 1, 1, "indirect")
    node = parse(to_text(plain(a[0])))
    if node[0] not in ("ref", "range"):
        raise FusionError("indirect(): the text is a cell or a range, like 'B2' or 'Sheet2!A1:A5'")
    return ev.eval(node)


def _address(a: list[Any]) -> str:
    r, c, mode = int(_x(a, 0, "address")), int(_x(a, 1, "address")), int(_x(a, 2, "address", 1))
    if r < 1 or c < 1 or mode not in (1, 2, 3, 4):
        raise FusionError("address(row, column, [1 absolute, 2 row absolute, 3 column absolute, 4 relative])")
    return f"{'$' if mode in (1, 3) else ''}{col_letters(c - 1)}{'$' if mode in (1, 2) else ''}{r}"


def _formula_of(ev: Evaluator, a: list[Any], name: str) -> Optional[str]:
    _arity(a, 1, 1, name)
    s, cells = _ref_cells(ev, a[0], name)
    src = ((s.get("cells") or {}).get(cells[0][0]) or {}).get("input")
    return src if isinstance(src, str) and src.startswith("=") else None


# take, drop, sortby: see "dynamic arrays" below (their results spill)


def _type(ev: Evaluator, a: list[Any]) -> int:
    """type(value): 1 number, 2 text, 4 logical, 16 error, 64 array."""
    _arity(a, 1, 1, "type")
    try:
        v = ev.eval(a[0])
        if _elements(v) is not None:
            return 64
        v = plain(v.flat()[0] if isinstance(v, Range) else v)
    except _ERRORS:
        return 16
    return 4 if isinstance(v, bool) else 2 if isinstance(v, str) else 64 if isinstance(v, (list, dict)) else 1


def _iserr(ev: Evaluator, a: list[Any]) -> bool:
    _arity(a, 1, 1, "iserr")
    try:
        plain(ev.eval(a[0]))
        return False
    except _ERRORS:
        return True


def _isdate(v: Any) -> bool:
    try:
        _datetime(v)
        return not _is_days(v) and plain(v) not in (None, "")
    except FusionError:
        return False


def _isbetween(a: list[Any]) -> bool:
    _arity(a, 3, 5, "isbetween")
    v, lo, hi = plain(a[0]), plain(a[1]), plain(a[2])
    return compare(">=" if _flag(a, 3, True) else ">", v, lo) and compare("<=" if _flag(a, 4, True) else "<", v, hi)


# ------------------------------------------------------------------ text


def _find_at(a: list[Any], fold: bool, name: str) -> Any:
    _arity(a, 2, 3, name)
    needle, hay = to_text(plain(a[0])), to_text(plain(a[1]))
    start = max(int(_x(a, 2, name, 1)), 1) - 1
    if fold:
        needle, hay = needle.lower(), hay.lower()
    return (hay.find(needle, start) + 1) or None


def _replace(a: list[Any]) -> str:
    """replace(text, old, new), or the spreadsheet form replace(text, start, number of characters, new text)."""
    if len(a) == 4:
        s, start, n = to_text(plain(a[0])), max(int(_x(a, 1, "replace")), 1) - 1, max(int(_x(a, 2, "replace")), 0)
        return s[:start] + to_text(plain(a[3])) + s[start + n:]
    _arity(a, 3, 4, "replace")
    return to_text(plain(a[0])).replace(to_text(plain(a[1])), to_text(plain(a[2])))


def _dollar(a: list[Any]) -> str:
    x, d = _x(a, 0, "dollar"), int(_x(a, 1, "dollar", 2))
    r = _half_up(x, d)
    body = f"${abs(r):,.{max(d, 0)}f}"
    return f"({body})" if r < 0 else body


def _half_up(x: float, d: int) -> float:
    f = 10.0 ** d
    return math.copysign(math.floor(abs(x) * f + 0.5 + 1e-9) / f, x)


def _numbervalue(a: list[Any]) -> Any:
    _arity(a, 1, 3, "numbervalue")
    s = to_text(plain(a[0]))
    dec = to_text(plain(a[1]))[:1] if len(a) > 1 else "."
    grp = to_text(plain(a[2]))[:1] if len(a) > 2 else ("," if dec != "," else ".")
    s = "".join(s.split())
    pct = len(s) - len(s.rstrip("%"))
    s = s.rstrip("%").replace(grp, "").replace(dec, ".")
    try:
        return clean_number(float(s or 0) / 100 ** pct)
    except ValueError:
        raise FusionError(f"numbervalue(): not a number: {plain(a[0])}") from None


# textsplit: see "dynamic arrays" below (its result spills)


_ROMAN = ((1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"))


def _roman(a: list[Any]) -> str:
    n = int(_x(a, 0, "roman"))
    if not 0 <= n <= 3999:
        raise FusionError("roman(): the number is 0 to 3999")
    out = ""
    for v, s in _ROMAN:
        while n >= v:
            out, n = out + s, n - v
    return out


def _arabic(a: list[Any]) -> int:
    s = to_text(plain(a[0])).strip().upper()
    neg, s = s.startswith("-"), s.lstrip("-")
    vals = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
    if any(ch not in vals for ch in s):
        raise FusionError(f"arabic(): not a Roman numeral: {plain(a[0])}")
    total = 0
    for i, ch in enumerate(s):
        v = vals[ch]
        total += -v if i + 1 < len(s) and vals[s[i + 1]] > v else v
    return -total if neg else total


_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def _digits(n: int, radix: int) -> str:
    out = ""
    while n:
        n, r = divmod(n, radix)
        out = _DIGITS[r] + out
    return out or "0"


def _base(a: list[Any]) -> str:
    n, radix, width = int(_x(a, 0, "base")), int(_x(a, 1, "base")), int(_x(a, 2, "base", 0))
    if n < 0 or not 2 <= radix <= 36:
        raise FusionError("base(number ≥ 0, radix 2 to 36, [minimum length])")
    return _digits(n, radix).zfill(width)


def _decimal(a: list[Any]) -> int:
    radix = int(_x(a, 1, "decimal"))
    try:
        return int(to_text(plain(a[0])).strip(), radix)
    except ValueError:
        raise FusionError(f"decimal(): {plain(a[0])} is not a number in base {radix}") from None


# ------------------------------------------------------------------ engineering: number bases, bits, units

_BASES = {"bin": 2, "oct": 8, "dec": 10, "hex": 16}


def _base_convert(src: str, dst: str) -> Callable[[Evaluator, list[Any]], Any]:
    """bin2dec, dec2hex, hex2oct, …: ten digits at most, negative numbers in two's complement."""
    name, sb, db = f"{src}2{dst}", _BASES[src], _BASES[dst]

    def run(ev: Evaluator, a: list[Any]) -> Any:
        _arity(a, 1, 1 if dst == "dec" else 2, name)
        if src == "dec":
            n = int(_x(a, 0, name))
        else:
            s = to_text(plain(a[0])).strip().upper()
            if not s or len(s) > 10 or any(ch not in _DIGITS[:sb] for ch in s):
                raise FusionError(f"{name}(): {plain(a[0])} is not a {src} number of at most 10 digits")
            n = int(s, sb)
            if len(s) == 10 and n >= sb ** 10 // 2:
                n -= sb ** 10
        if dst == "dec":
            return n
        limit = db ** 10 // 2
        if not -limit <= n < limit:
            raise FusionError(f"{name}(): {n} does not fit in 10 {dst} digits")
        if n < 0:
            return _digits(n + db ** 10, db)
        out = _digits(n, db)
        places = int(_x(a, 1, name, 0))
        if places and len(out) > places:
            raise FusionError(f"{name}(): {out} needs more than {places} places")
        return out.zfill(places)

    return run


def _bits(a: list[Any], name: str) -> tuple[int, int]:
    x, y = _x(a, 0, name), _x(a, 1, name)
    if x < 0 or x != int(x) or x >= 2 ** 48 or y != int(y):
        raise FusionError(f"{name}() takes whole numbers from 0 to 2^48 - 1")
    return int(x), int(y)


def _bitshift(a: list[Any], left: bool, name: str) -> int:
    x, n = _bits(a, name)
    n = n if left else -n
    return x << n if n >= 0 else x >> -n


_UNITS: dict[str, dict[str, float]] = {
    "mass": {"g": 1, "sg": 14593.9029372064, "lbm": 453.59237, "ozm": 28.349523125, "grain": 0.06479891, "cwt": 45359.237, "shweight": 45359.237,
             "uk_cwt": 50802.34544, "lcwt": 50802.34544, "stone": 6350.29318, "ton": 907184.74, "uk_ton": 1016046.9088, "LTON": 1016046.9088},
    "distance": {"m": 1, "mi": 1609.344, "Nmi": 1852, "in": 0.0254, "ft": 0.3048, "yd": 0.9144, "ang": 1e-10, "ell": 1.143, "ly": 9.4607304725808e15,
                 "parsec": 3.08567758128155e16, "pc": 3.08567758128155e16, "Picapt": 0.0254 / 72, "Pica": 0.0254 / 72, "pica": 0.0254 / 6,
                 "survey_mi": 1609.3472186944},
    "time": {"sec": 1, "s": 1, "mn": 60, "min": 60, "hr": 3600, "day": 86400, "d": 86400, "yr": 31557600},
    "pressure": {"Pa": 1, "p": 1, "atm": 101325, "at": 101325, "mmHg": 133.322, "psi": 6894.75729316836, "Torr": 101325 / 760},
    "force": {"N": 1, "dyn": 1e-5, "dy": 1e-5, "lbf": 4.4482216152605, "pond": 9.80665e-3},
    "energy": {"J": 1, "e": 1e-7, "c": 4.184, "cal": 4.1868, "eV": 1.602176487e-19, "ev": 1.602176487e-19, "HPh": 2684519.537696172792,
               "hh": 2684519.537696172792, "Wh": 3600, "wh": 3600, "flb": 1.3558179483314, "BTU": 1055.05585262, "btu": 1055.05585262},
    "power": {"W": 1, "w": 1, "HP": 745.69987158227022, "h": 745.69987158227022, "PS": 735.49875},
    "magnetism": {"T": 1, "ga": 1e-4},
    "volume": {"l": 1, "L": 1, "lt": 1, "tsp": 0.00492892159375, "tspm": 0.005, "tbs": 0.01478676478125, "oz": 0.0295735295625, "cup": 0.2365882365,
               "pt": 0.473176473, "us_pt": 0.473176473, "uk_pt": 0.56826125, "qt": 0.946352946, "uk_qt": 1.1365225, "gal": 3.785411784,
               "uk_gal": 4.54609, "m3": 1000, "ft3": 28.316846592, "in3": 0.016387064, "yd3": 764.554857984, "barrel": 158.987294928,
               "bushel": 35.23907016688, "ang3": 1e-27, "MTON": 1132.67386368, "GRT": 2831.6846592, "regton": 2831.6846592},
    "area": {"m2": 1, "ha": 10000, "ar": 100, "uk_acre": 4046.8564224, "us_acre": 4046.87260987425, "ft2": 0.09290304, "in2": 0.00064516,
             "yd2": 0.83612736, "mi2": 2589988.110336, "Nmi2": 3429904, "Morgen": 2500, "ang2": 1e-20},
    "information": {"bit": 1, "byte": 8},
    "speed": {"m/s": 1, "m/sec": 1, "m/h": 1 / 3600, "m/hr": 1 / 3600, "mph": 0.44704, "kn": 1852 / 3600, "admkn": 0.514773333},
}
_TEMPERATURES = {"C": "C", "cel": "C", "F": "F", "fah": "F", "K": "K", "kel": "K", "Rank": "R", "Reau": "Re"}
_PREFIXES = {"Y": 1e24, "Z": 1e21, "E": 1e18, "P": 1e15, "T": 1e12, "G": 1e9, "M": 1e6, "k": 1e3, "h": 1e2, "da": 1e1, "d": 1e-1, "c": 1e-2, "m": 1e-3,
             "u": 1e-6, "n": 1e-9, "p": 1e-12, "f": 1e-15, "a": 1e-18}
_BINARY_PREFIXES = {"ki": 2.0 ** 10, "Mi": 2.0 ** 20, "Gi": 2.0 ** 30, "Ti": 2.0 ** 40, "Pi": 2.0 ** 50}
_PREFIXABLE = {"g", "m", "sec", "s", "Pa", "N", "dyn", "J", "e", "c", "cal", "eV", "Wh", "W", "T", "ga", "l", "L", "lt", "bit", "byte", "m/s", "m/h"}


def _unit(u: str) -> tuple[str, float]:
    """(category, factor to the category's base unit) of a unit, with metric prefixes (kg, cm, kWh, Mbyte, kibyte)."""
    if u in _TEMPERATURES:
        return "temperature", 1.0
    for cat, units in _UNITS.items():
        if u in units:
            return cat, units[u]
    for prefixes in (_BINARY_PREFIXES, _PREFIXES):
        for p, f in sorted(prefixes.items(), key=lambda kv: -len(kv[0])):
            rest = u[len(p):]
            if u.startswith(p) and rest in _PREFIXABLE and (prefixes is _PREFIXES or rest in ("bit", "byte")):
                cat, base = _unit(rest)
                return cat, base * f
    raise FusionError(f"convert(): unknown unit {u}")


def _convert(a: list[Any]) -> Any:
    _arity(a, 3, 3, "convert")
    x, src, dst = _x(a, 0, "convert"), to_text(plain(a[1])), to_text(plain(a[2]))
    (c1, f1), (c2, f2) = _unit(src), _unit(dst)
    if c1 != c2:
        raise FusionError(f"convert(): {src} is a {c1} unit and {dst} a {c2} unit")
    if c1 != "temperature":
        return clean_number(float(f"{x * f1 / f2:.15g}"))
    s, d = _TEMPERATURES[src], _TEMPERATURES[dst]
    k = {"C": x + 273.15, "F": (x + 459.67) * 5 / 9, "K": x, "R": x * 5 / 9, "Re": x * 1.25 + 273.15}[s]
    out = {"C": k - 273.15, "F": k * 9 / 5 - 459.67, "K": k, "R": k * 9 / 5, "Re": (k - 273.15) / 1.25}[d]
    return clean_number(round(out, 10))


# ------------------------------------------------------------------ rounding and other math


def _multiple(x: float, s: float, up: bool) -> Any:
    """x rounded up (or down) to a multiple of s; a quotient that is whole but for float noise stays whole."""
    if not s:
        return 0
    q = x / s
    if abs(q - round(q)) < 1e-9:
        q = round(q)
    return clean_number(round((math.ceil(q) if up else math.floor(q)) * s, 12))


def _ceiling(a: list[Any], up: bool, name: str) -> Any:
    """ceiling(x) / floor(x), or with a significance: ceiling(2.5, 1) → 3, floor(1.58, 0.1) → 1.5."""
    x = num(a[0]) or 0
    if len(a) < 2:
        return math.ceil(x) if up else math.floor(x)
    s = _x(a, 1, name)
    if x > 0 and s < 0:
        raise FusionError(f"{name}(): a positive number with a negative significance")
    return _multiple(x, s, up)


def _ceiling_math(a: list[Any], up: bool, name: str) -> Any:
    """ceiling.math / floor.math(x, [significance], [mode]): a mode other than 0 rounds negative numbers the other way."""
    x, s = _x(a, 0, name), abs(_x(a, 1, name, 1))
    if x < 0 and _x(a, 2, name, 0):
        return _multiple(x, s, not up)
    return _multiple(x, s, up)


def _series_sum(a: list[Any]) -> Any:
    x, n, m = _x(a, 0, "seriessum"), _x(a, 1, "seriessum"), _x(a, 2, "seriessum")
    return clean_number(sum(c * x ** (n + i * m) for i, c in enumerate(nums(a[3:]))))


def _xy(a: list[Any], name: str) -> list[tuple[float, float]]:
    xs, ys = flat([a[0]]), flat([a[1]])
    if len(xs) != len(ys):
        raise FusionError(f"{name}(): the two ranges have different sizes")
    return [(num(x), num(y)) for x, y in zip(xs, ys) if num(x) is not None and num(y) is not None]


def _mdeterm(a: list[Any]) -> Any:
    r = a[0]
    m = [[num(v) for v in row] for row in r.rows] if isinstance(r, Range) else None
    if not m or any(len(row) != len(m) for row in m) or any(v is None for row in m for v in row):
        raise FusionError("mdeterm() takes a square range of numbers")
    n, det = len(m), 1.0
    for i in range(n):
        p = max(range(i, n), key=lambda k: abs(m[k][i]))
        if not m[p][i]:
            return 0
        if p != i:
            m[i], m[p], det = m[p], m[i], -det
        det *= m[i][i]
        for k in range(i + 1, n):
            f = m[k][i] / m[i][i]
            m[k] = [vk - f * vi for vk, vi in zip(m[k], m[i])]
    return clean_number(round(det, 9))


# ------------------------------------------------------------------ financial


def _fv(rate: float, nper: float, pmt: float, pv: float, typ: float) -> float:
    if rate == 0:
        return -(pv + pmt * nper)
    g = (1 + rate) ** nper
    return -(pv * g + pmt * (1 + rate * typ) * (g - 1) / rate)


def _pv(rate: float, nper: float, pmt: float, fv: float, typ: float) -> float:
    if rate == 0:
        return -(fv + pmt * nper)
    g = (1 + rate) ** nper
    return -(fv + pmt * (1 + rate * typ) * (g - 1) / rate) / g


def _pmt(rate: float, nper: float, pv: float, fv: float, typ: float) -> float:
    if nper == 0:
        _div0()
    if rate == 0:
        return -(pv + fv) / nper
    g = (1 + rate) ** nper
    return -(rate * (pv * g + fv)) / ((1 + rate * typ) * (g - 1))


def _nper(rate: float, pmt: float, pv: float, fv: float, typ: float) -> float:
    if rate == 0:
        return -(pv + fv) / (pmt or _div0())
    z = pmt * (1 + rate * typ) / rate
    return math.log((z - fv) / (z + pv)) / math.log(1 + rate)


def _ipmt(rate: float, per: float, nper: float, pv: float, fv: float, typ: float, name: str = "ipmt") -> float:
    if not 1 <= per <= nper:
        raise FusionError(f"{name}(): the period is between 1 and the number of periods")
    pay = _pmt(rate, nper, pv, fv, typ)
    if per == 1 and typ:
        return 0.0
    i = _fv(rate, per - 1, pay, pv, typ) * rate
    return i / (1 + rate) if typ else i


def _typ(a: list[Any], i: int, name: str) -> float:
    return 1.0 if _x(a, i, name, 0) else 0.0


def _solve(f: Callable[[float], float], guess: float, name: str) -> float:
    """A rate where f is zero: Newton's steps from the guess, then a sign change on a grid and bisection."""
    def safe(x: float) -> Optional[float]:
        try:
            return f(x)
        except (ZeroDivisionError, OverflowError, ValueError):
            return None

    x = guess
    for _ in range(60):
        y = safe(x)
        if y is None:
            break
        if y == 0:
            return x
        y2 = safe(x + 1e-7)
        if y2 is None or y2 == y:
            break
        nx = x - y * 1e-7 / (y2 - y)
        if nx <= -1:
            nx = (x - 1) / 2
        if abs(nx - x) <= 1e-12 * max(1.0, abs(nx)):
            return nx
        x = nx
    prev: Optional[tuple[float, float]] = None
    for k in range(1100):
        g = -0.99 + 0.01 * k
        y = safe(g)
        if y is None:
            prev = None
            continue
        if prev is not None and (prev[1] < 0) != (y < 0):
            lo, hi, ylo = prev[0], g, prev[1]
            for _ in range(200):
                mid = (lo + hi) / 2
                ym = safe(mid)
                if ym is None:
                    break
                if (ym < 0) == (ylo < 0):
                    lo, ylo = mid, ym
                else:
                    hi = mid
            return (lo + hi) / 2
        prev = (g, y)
    raise FusionError(f"{name}(): no rate was found; try another guess")


def _rate(a: list[Any]) -> Any:
    _arity(a, 3, 6, "rate")
    nper, pmt, pv, fv, typ = _x(a, 0, "rate"), _x(a, 1, "rate"), _x(a, 2, "rate"), _x(a, 3, "rate", 0), _typ(a, 4, "rate")

    def f(r: float) -> float:
        if abs(r) < 1e-12:
            return pv + pmt * nper + fv
        g = (1 + r) ** nper
        return pv * g + pmt * (1 + r * typ) * (g - 1) / r + fv

    return _solve(f, _x(a, 5, "rate", 0.1), "rate")


def _cash_flows(v: Any, name: str) -> list[float]:
    xs = nums([v])
    if not (any(x > 0 for x in xs) and any(x < 0 for x in xs)):
        raise FusionError(f"{name}(): the values hold at least one positive and one negative number")
    return xs


def _irr(a: list[Any]) -> Any:
    _arity(a, 1, 2, "irr")
    xs = _cash_flows(a[0], "irr")
    return _solve(lambda r: sum(v / (1 + r) ** i for i, v in enumerate(xs)), _x(a, 1, "irr", 0.1), "irr")


def _mirr(a: list[Any]) -> Any:
    _arity(a, 3, 3, "mirr")
    xs, fr, rr = _cash_flows(a[0], "mirr"), _x(a, 1, "mirr"), _x(a, 2, "mirr")
    n = len(xs)
    pos = sum(v / (1 + rr) ** (i + 1) for i, v in enumerate(xs) if v > 0)
    neg = sum(v / (1 + fr) ** (i + 1) for i, v in enumerate(xs) if v < 0)
    return (-pos * (1 + rr) ** n / (neg * (1 + fr))) ** (1 / (n - 1)) - 1


def _dated(values: Any, dates: Any, name: str) -> list[tuple[float, float]]:
    """(value, years since the first date) of xnpv / xirr."""
    vs, ds = nums([values]), [_date(d) for d in flat([dates]) if d not in (None, "")]
    if not vs or len(vs) != len(ds):
        raise FusionError(f"{name}(): as many dates as values")
    return [(v, (d - ds[0]).days / 365) for v, d in zip(vs, ds)]


def _xirr(a: list[Any]) -> Any:
    _arity(a, 2, 3, "xirr")
    _cash_flows(a[0], "xirr")
    flows = _dated(a[0], a[1], "xirr")
    return _solve(lambda r: sum(v / (1 + r) ** t for v, t in flows), _x(a, 2, "xirr", 0.1), "xirr")


def _depreciation(a: list[Any], name: str) -> tuple[float, float, float, int]:
    cost, salvage, life, period = _x(a, 0, name), _x(a, 1, name), _x(a, 2, name), int(_x(a, 3, name))
    if cost <= 0 or salvage < 0 or life <= 0 or period < 1:
        raise FusionError(f"{name}(cost, salvage, life, period): positive numbers")
    return cost, salvage, life, period


def _db(a: list[Any]) -> Any:
    cost, salvage, life, period = _depreciation(a, "db")
    month = _x(a, 4, "db", 12)
    if period > life + (1 if month < 12 else 0):
        raise FusionError("db(): the period is past the asset's life")
    rate = round(1 - (salvage / cost) ** (1 / life), 3)
    total = dep = 0.0
    for p in range(1, period + 1):
        dep = cost * rate * month / 12 if p == 1 else (cost - total) * rate * ((12 - month) / 12 if p == life + 1 else 1)
        total += dep
    return dep


def _ddb(a: list[Any]) -> Any:
    cost, salvage, life, period = _depreciation(a, "ddb")
    factor = _x(a, 4, "ddb", 2)
    if period > life:
        raise FusionError("ddb(): the period is past the asset's life")
    total = dep = 0.0
    for _ in range(period):
        dep = max(min((cost - total) * factor / life, cost - salvage - total), 0.0)
        total += dep
    return dep


def _cumulative(a: list[Any], principal: bool, name: str) -> Any:
    _arity(a, 6, 6, name)
    rate, nper, pv = _x(a, 0, name), _x(a, 1, name), _x(a, 2, name)
    start, end, typ = int(_x(a, 3, name)), int(_x(a, 4, name)), _typ(a, 5, name)
    if rate <= 0 or nper <= 0 or pv <= 0 or start < 1 or end < start or end > nper:
        raise FusionError(f"{name}(rate, periods, present value, first period, last period, type)")
    pay = _pmt(rate, nper, pv, 0, typ)
    interest = [_ipmt(rate, p, nper, pv, 0, typ, name) for p in range(start, end + 1)]
    return sum(pay - i for i in interest) if principal else sum(interest)


def _dollar_fraction(a: list[Any], to_decimal: bool, name: str) -> Any:
    x, frac = _x(a, 0, name), int(_x(a, 1, name))
    if frac < 1:
        raise FusionError(f"{name}(): the fraction is at least 1")
    scale = 10 ** math.ceil(math.log10(frac)) if frac > 1 else 1
    whole = math.trunc(x)
    part = (x - whole) * scale / frac if to_decimal else (x - whole) * frac / scale
    return clean_number(round(whole + part, 12))


# ------------------------------------------------------------------ distributions


def _gammainc(s: float, x: float) -> float:
    """The regularized lower incomplete gamma function P(s, x)."""
    if x <= 0:
        return 0.0
    front = math.exp(-x + s * math.log(x) - math.lgamma(s))
    if x < s + 1:
        term = total = 1 / s
        n = s
        for _ in range(2000):
            n += 1
            term *= x / n
            total += term
            if abs(term) < abs(total) * 1e-16:
                break
        return min(total * front, 1.0)
    tiny = 1e-300
    b = x + 1 - s
    c, d = 1 / tiny, 1 / b
    h = d
    for i in range(1, 2000):
        an = -i * (i - s)
        b += 2
        d = an * d + b
        d = tiny if abs(d) < tiny else d
        c = b + an / c
        c = tiny if abs(c) < tiny else c
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < 1e-16:
            break
    return max(1 - front * h, 0.0)


def _betacf(p: float, q: float, x: float) -> float:
    tiny = 1e-300
    qab, qap, qam = p + q, p + 1, p - 1
    c, d = 1.0, 1 - qab * x / qap
    d = 1 / (tiny if abs(d) < tiny else d)
    h = d
    for m in range(1, 2000):
        m2 = 2 * m
        for aa in (m * (q - m) * x / ((qam + m2) * (p + m2)), -(p + m) * (qab + m) * x / ((p + m2) * (qap + m2))):
            d = 1 + aa * d
            d = 1 / (tiny if abs(d) < tiny else d)
            c = 1 + aa / c
            c = tiny if abs(c) < tiny else c
            delta = d * c
            h *= delta
        if abs(delta - 1) < 1e-16:
            break
    return h


def _lbeta(p: float, q: float) -> float:
    return math.lgamma(p) + math.lgamma(q) - math.lgamma(p + q)


def _betainc(p: float, q: float, x: float) -> float:
    """The regularized incomplete beta function I_x(p, q)."""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    front = math.exp(p * math.log(x) + q * math.log(1 - x) - _lbeta(p, q))
    if x < (p + 1) / (p + q + 2):
        return front * _betacf(p, q, x) / p
    return 1 - front * _betacf(q, p, 1 - x) / q


def _invert(cdf: Callable[[float], float], p: float, name: str, lo: float = 0.0, hi: float = 1.0, bounded: bool = False) -> float:
    """x where a rising cdf reaches p, by bisection (the upper end doubles until it is past p)."""
    if not 0 <= p <= 1 or (p == 1 and not bounded):
        raise FusionError(f"{name}(): the probability is between 0 and 1")
    if p == 0:
        return lo
    if not bounded:
        while cdf(hi) < p and hi < 1e300:
            lo, hi = hi, hi * 2
    for _ in range(200):
        mid = (lo + hi) / 2
        if cdf(mid) < p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def _positive(v: float, name: str, what: str) -> float:
    if v <= 0:
        raise FusionError(f"{name}(): {what} is above 0")
    return v


def _df(a: list[Any], i: int, name: str) -> int:
    d = int(_x(a, i, name))
    if d < 1:
        raise FusionError(f"{name}(): the degrees of freedom are at least 1")
    return d


def _normal(mean: float, sd: float, name: str) -> "_st.NormalDist":
    return _st.NormalDist(mean, _positive(sd, name, "the standard deviation"))


def _norm_inv(p: float, mean: float, sd: float, name: str) -> float:
    if not 0 < p < 1:
        raise FusionError(f"{name}(): the probability is between 0 and 1")
    return _normal(mean, sd, name).inv_cdf(p)


def _norm_dist(a: list[Any], name: str, cumulative: Optional[bool] = None) -> Any:
    d = _normal(_x(a, 1, name), _x(a, 2, name), name)
    cum = _flag(a, 3, True) if cumulative is None else cumulative
    return d.cdf(_x(a, 0, name)) if cum else d.pdf(_x(a, 0, name))


def _lognorm_dist(a: list[Any], name: str, cum: bool) -> Any:
    x, mean, sd = _positive(_x(a, 0, name), name, "x"), _x(a, 1, name), _positive(_x(a, 2, name), name, "the standard deviation")
    z = (math.log(x) - mean) / sd
    return _st.NormalDist().cdf(z) if cum else _st.NormalDist().pdf(z) / (x * sd)


def _t_cdf(x: float, df: float) -> float:
    tail = 0.5 * _betainc(df / 2, 0.5, df / (df + x * x))
    return 1 - tail if x >= 0 else tail


def _t_pdf(x: float, df: float) -> float:
    return math.exp(math.lgamma((df + 1) / 2) - math.lgamma(df / 2)) / math.sqrt(df * math.pi) * (1 + x * x / df) ** (-(df + 1) / 2)


def _t_inv(p: float, df: float, name: str) -> float:
    if not 0 < p < 1:
        raise FusionError(f"{name}(): the probability is between 0 and 1")
    if p < 0.5:
        return -_t_inv(1 - p, df, name)
    return _invert(lambda x: _t_cdf(x, df), p, name)


def _t_tail(a: list[Any], name: str, tails: Optional[int] = None) -> Any:
    x, df = _x(a, 0, name), _df(a, 1, name)
    n = int(_x(a, 2, name)) if tails is None else tails
    if n not in (1, 2) or (x < 0 and (n == 2 or tails is None)):
        raise FusionError(f"{name}(): x is at least 0 and tails is 1 or 2")
    return n * (1 - _t_cdf(x, df))


def _chi_cdf(x: float, df: float) -> float:
    return _gammainc(df / 2, x / 2) if x > 0 else 0.0


def _chi_pdf(x: float, df: float) -> float:
    return math.exp((df / 2 - 1) * math.log(x) - x / 2 - (df / 2) * math.log(2) - math.lgamma(df / 2)) if x > 0 else 0.0


def _f_cdf(x: float, d1: float, d2: float) -> float:
    return _betainc(d1 / 2, d2 / 2, d1 * x / (d1 * x + d2)) if x > 0 else 0.0


def _f_pdf(x: float, d1: float, d2: float) -> float:
    if x <= 0:
        return 0.0
    return math.exp(0.5 * (d1 * math.log(d1 * x) + d2 * math.log(d2) - (d1 + d2) * math.log(d1 * x + d2)) - math.log(x) - _lbeta(d1 / 2, d2 / 2))


def _gamma_dist(a: list[Any], name: str) -> Any:
    x, k, theta = _x(a, 0, name), _positive(_x(a, 1, name), name, "alpha"), _positive(_x(a, 2, name), name, "beta")
    if x < 0:
        raise FusionError(f"{name}(): x is at least 0")
    if _flag(a, 3, True):
        return _gammainc(k, x / theta)
    return math.exp((k - 1) * math.log(x) - x / theta - k * math.log(theta) - math.lgamma(k)) if x > 0 else 0.0


def _beta_dist(a: list[Any], name: str, legacy: bool) -> Any:
    """beta.dist(x, alpha, beta, cumulative, [A], [B]); betadist(x, alpha, beta, [A], [B]) is the cumulative one."""
    x, p, q = _x(a, 0, name), _positive(_x(a, 1, name), name, "alpha"), _positive(_x(a, 2, name), name, "beta")
    k = 3 if legacy else 4
    lo, hi = _x(a, k, name, 0), _x(a, k + 1, name, 1)
    if hi <= lo or not lo <= x <= hi:
        raise FusionError(f"{name}(): x lies between A and B")
    z = (x - lo) / (hi - lo)
    if legacy or _flag(a, 3, True):
        return _betainc(p, q, z)
    return math.exp((p - 1) * math.log(z) + (q - 1) * math.log(1 - z) - _lbeta(p, q)) / (hi - lo) if 0 < z < 1 else 0.0


def _beta_inv(a: list[Any], name: str) -> Any:
    prob, p, q = _x(a, 0, name), _positive(_x(a, 1, name), name, "alpha"), _positive(_x(a, 2, name), name, "beta")
    lo, hi = _x(a, 3, name, 0), _x(a, 4, name, 1)
    return lo + (hi - lo) * _invert(lambda z: _betainc(p, q, z), prob, name, bounded=True)


def _trials(a: list[Any], i: int, name: str) -> int:
    n = _x(a, i, name)
    if n < 0:
        raise FusionError(f"{name}(): counts are at least 0")
    return int(n)


def _prob(a: list[Any], i: int, name: str) -> float:
    p = _x(a, i, name)
    if not 0 <= p <= 1:
        raise FusionError(f"{name}(): the probability is between 0 and 1")
    return p


def _binom_pmf(k: int, n: int, p: float) -> float:
    return math.comb(n, k) * p ** k * (1 - p) ** (n - k) if 0 <= k <= n else 0.0


def _binom_dist(a: list[Any], name: str) -> Any:
    k, n, p = _trials(a, 0, name), _trials(a, 1, name), _prob(a, 2, name)
    if k > n:
        raise FusionError(f"{name}(): more successes than trials")
    return sum(_binom_pmf(i, n, p) for i in range(k + 1)) if _flag(a, 3, False) else _binom_pmf(k, n, p)


def _binom_inv(a: list[Any], name: str) -> Any:
    n, p, alpha = _trials(a, 0, name), _prob(a, 1, name), _prob(a, 2, name)
    total = 0.0
    for k in range(n + 1):
        total += _binom_pmf(k, n, p)
        if total >= alpha - 1e-15:
            return k
    return n


def _negbinom_dist(a: list[Any], name: str, cumulative: Optional[bool] = None) -> Any:
    f, s, p = _trials(a, 0, name), _trials(a, 1, name), _prob(a, 2, name)
    if s < 1:
        raise FusionError(f"{name}(): at least one success")
    pmf = lambda k: math.comb(k + s - 1, s - 1) * p ** s * (1 - p) ** k  # noqa: E731
    cum = _flag(a, 3, False) if cumulative is None else cumulative
    return sum(pmf(k) for k in range(f + 1)) if cum else pmf(f)


def _poisson_dist(a: list[Any], name: str) -> Any:
    k, mean = _trials(a, 0, name), _x(a, 1, name)
    if mean < 0:
        raise FusionError(f"{name}(): the mean is at least 0")
    pmf = lambda i: math.exp(-mean + i * math.log(mean) - math.lgamma(i + 1)) if mean > 0 else float(i == 0)  # noqa: E731
    return sum(pmf(i) for i in range(k + 1)) if _flag(a, 2, False) else pmf(k)


def _hypgeom_dist(a: list[Any], name: str, cumulative: Optional[bool] = None) -> Any:
    k, n, big_k, big_n = (_trials(a, i, name) for i in range(4))
    if n > big_n or big_k > big_n or k > min(n, big_k) or k < max(0, n - big_n + big_k):
        raise FusionError(f"{name}(sample successes, sample size, population successes, population size)")
    pmf = lambda i: math.comb(big_k, i) * math.comb(big_n - big_k, n - i) / math.comb(big_n, n) if n - i <= big_n - big_k else 0.0  # noqa: E731
    cum = _flag(a, 4, False) if cumulative is None else cumulative
    return sum(pmf(i) for i in range(k + 1)) if cum else pmf(k)


def _expon_dist(a: list[Any], name: str) -> Any:
    x, lam = _x(a, 0, name), _positive(_x(a, 1, name), name, "lambda")
    if x < 0:
        raise FusionError(f"{name}(): x is at least 0")
    return 1 - math.exp(-lam * x) if _flag(a, 2, True) else lam * math.exp(-lam * x)


def _weibull_dist(a: list[Any], name: str) -> Any:
    x, k, lam = _x(a, 0, name), _positive(_x(a, 1, name), name, "alpha"), _positive(_x(a, 2, name), name, "beta")
    if x < 0:
        raise FusionError(f"{name}(): x is at least 0")
    if _flag(a, 3, True):
        return 1 - math.exp(-((x / lam) ** k))
    return k / lam ** k * x ** (k - 1) * math.exp(-((x / lam) ** k))


def _confidence(a: list[Any], name: str, student: bool) -> Any:
    alpha, sd, n = _x(a, 0, name), _positive(_x(a, 1, name), name, "the standard deviation"), int(_x(a, 2, name))
    if not 0 < alpha < 1 or n < (2 if student else 1):
        raise FusionError(f"{name}(alpha between 0 and 1, standard deviation, sample size)")
    z = _t_inv(1 - alpha / 2, n - 1, name) if student else _st.NormalDist().inv_cdf(1 - alpha / 2)
    return z * sd / math.sqrt(n)


def _erf(a: list[Any]) -> Any:
    _arity(a, 1, 2, "erf")
    return math.erf(_x(a, 1, "erf")) - math.erf(_x(a, 0, "erf")) if len(a) > 1 else math.erf(_x(a, 0, "erf"))


def _gamma_fn(a: list[Any]) -> Any:
    x = _x(a, 0, "gamma")
    if x == 0 or (x < 0 and x == int(x)):
        raise FusionError("gamma(): not defined at 0 and the negative whole numbers")
    return clean_number(math.gamma(x))


def _ztest(a: list[Any], name: str) -> Any:
    _arity(a, 2, 3, name)
    xs = nums([a[0]])
    if len(xs) < 2:
        raise FusionError(f"{name}() needs at least two numbers")
    sigma = _positive(_x(a, 2, name, _st.stdev(xs)), name, "sigma")
    return 1 - _st.NormalDist().cdf((sum(xs) / len(xs) - _x(a, 1, name)) / (sigma / math.sqrt(len(xs))))


def _chitest(a: list[Any], name: str) -> Any:
    _arity(a, 2, 2, name)
    shape = (len(a[0].rows), len(a[0].rows[0])) if isinstance(a[0], Range) and a[0].rows else (1, len(flat([a[0]])))
    obs, exp = [num(v) for v in flat([a[0]])], [num(v) for v in flat([a[1]])]
    if len(obs) != len(exp) or len(obs) < 2 or any(v is None for v in obs + exp):
        raise FusionError(f"{name}(actual range, expected range): two ranges of numbers of the same size")
    r, c = shape
    df = (r - 1) * (c - 1) if r > 1 and c > 1 else len(obs) - 1
    stat = sum((o - e) ** 2 / (e or _div0()) for o, e in zip(obs, exp))
    return 1 - _chi_cdf(stat, df)


# ------------------------------------------------------------------ more statistics


def _a_values(a: list[Any]) -> list[float]:
    """The values of averagea / maxa / mina: text counts as 0, TRUE as 1, empty cells are left out."""
    return [float(v) if isinstance(v, (bool, int, float)) else 0.0 for v in flat(a) if v not in (None, "")]


def _percentile_exc(a: list[Any], name: str = "percentile.exc") -> Any:
    xs, p = sorted(nums([a[0]])), _x(a, 1, name)
    k = p * (len(xs) + 1)
    if not xs or not 1 <= k <= len(xs):
        raise FusionError(f"{name}(): the percentile is between 1/(n+1) and n/(n+1)")
    f = math.floor(k)
    return clean_number(xs[f - 1] + (xs[min(f, len(xs) - 1)] - xs[f - 1]) * (k - f))


def _quartile_exc(a: list[Any]) -> Any:
    q = int(_x(a, 1, "quartile.exc"))
    if q not in (1, 2, 3):
        raise FusionError("quartile.exc(range, 1 to 3)")
    return _percentile_exc([a[0], q / 4], "quartile.exc")


def _percentrank_exc(a: list[Any]) -> Any:
    xs, x = sorted(nums([a[0]])), _x(a, 1, "percentrank.exc")
    digits = int(_x(a, 2, "percentrank.exc", 3))
    if not xs or x < xs[0] or x > xs[-1]:
        return None
    below = sum(1 for v in xs if v < x)
    frac = 1.0 if x in xs else (x - xs[below - 1]) / (xs[below] - xs[below - 1])
    scale = 10 ** digits  # the spreadsheet cuts the result to the digits, it does not round it
    return clean_number(math.floor((below + frac) / (len(xs) + 1) * scale + 1e-9) / scale)


def _rank_avg(a: list[Any]) -> Any:
    _arity(a, 2, 3, "rank.avg")
    x, xs = _x(a, 0, "rank.avg"), nums([a[1]])
    if x not in xs:
        return None
    ahead = sum(1 for v in xs if (v < x if _x(a, 2, "rank.avg", 0) else v > x))
    return clean_number(ahead + (xs.count(x) + 1) / 2)


def _trimmean(a: list[Any]) -> Any:
    xs, p = sorted(nums([a[0]])), _x(a, 1, "trimmean")
    if not xs or not 0 <= p < 1:
        raise FusionError("trimmean(range, share between 0 and 1)")
    k = int(len(xs) * p / 2)
    kept = xs[k: len(xs) - k]
    return clean_number(sum(kept) / len(kept))


def _frequency(a: list[Any]) -> dict:
    data, bins = nums([a[0]]), sorted(nums([a[1]]))
    counts = [0] * (len(bins) + 1)
    for v in data:
        counts[next((i for i, b in enumerate(bins) if v <= b), len(bins))] += 1
    return _arr(counts)


def _prob_range(a: list[Any]) -> Any:
    _arity(a, 3, 4, "prob")
    xs, ps = flat([a[0]]), flat([a[1]])
    lo = _x(a, 2, "prob")
    hi = _x(a, 3, "prob", lo)
    pairs = [(num(x), num(p)) for x, p in zip(xs, ps)]
    if len(xs) != len(ps) or any(x is None or p is None or not 0 <= p <= 1 for x, p in pairs) or abs(sum(p for _, p in pairs) - 1) > 1e-9:
        raise FusionError("prob(): the probabilities are between 0 and 1 and add up to 1")
    return clean_number(round(sum(p for x, p in pairs if lo <= x <= hi), 12))


def _mode_mult(a: list[Any]) -> dict:
    xs = nums(a)
    counts: dict[float, int] = {}
    for v in xs:
        counts[v] = counts.get(v, 0) + 1
    top = max(counts.values(), default=0)
    if top < 2:
        raise FusionError("mode.mult(): no value appears more than once")
    return _arr(clean_number(v) for v, n in counts.items() if n == top)


def _steyx(a: list[Any]) -> Any:
    ys, xs = _pairs(a, "steyx")
    if len(xs) < 3:
        raise FusionError("steyx() needs at least three pairs of numbers")
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    sxx, syy = sum((x - mx) ** 2 for x in xs), sum((y - my) ** 2 for y in ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return clean_number(math.sqrt((syy - sxy * sxy / (sxx or _div0())) / (len(xs) - 2)))


def _covariance_s(a: list[Any]) -> Any:
    ys, xs = _pairs(a, "covariance.s")
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    return clean_number(sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (len(xs) - 1))


def _skew_p(a: list[Any]) -> Any:
    xs = nums(a)
    if len(xs) < 3 or not _st.pstdev(xs):
        return None
    m, s = sum(xs) / len(xs), _st.pstdev(xs)
    return clean_number(sum(((x - m) / s) ** 3 for x in xs) / len(xs))


# ------------------------------------------------------------------ database functions (dsum, dcount, …)


def _database(a: list[Any], name: str) -> list[Any]:
    """The field's values in the database rows that meet the criteria: a criteria row holds when all its filled cells
    hold (">10", "<>x", "a*", a value), and a database row is kept when any criteria row holds."""
    _arity(a, 3, 3, name)
    headers, rows = _range_columns(a[0], name)
    low = [h.lower() for h in headers]
    field = plain(a[1])
    if isinstance(field, (int, float)) and not isinstance(field, bool):
        j = int(field) - 1
    else:
        j = low.index(to_text(field).lower()) if to_text(field).lower() in low else -1
    if not 0 <= j < len(headers):
        raise FusionError(f"{name}(): the database has no field {field}")
    crit_headers, crit_rows = _range_columns(a[2], name)
    idx = [low.index(h.lower()) if h.lower() in low else None for h in crit_headers]

    def kept(row: list[Any]) -> bool:
        for crit in crit_rows:
            conds = [(idx[k], c) for k, c in enumerate(crit) if c not in (None, "")]
            if all(i is not None and _crit(row[i], c) for i, c in conds):
                return True
        return not crit_rows

    return [row[j] for row in rows if any(x not in (None, "") for x in row) and kept(row)]


def _dget(a: list[Any]) -> Any:
    vals = _database(a, "dget")
    if len(vals) != 1:
        raise FusionError(f"dget(): {len(vals)} rows meet the criteria; exactly one is expected")
    return vals[0]


def _dstat(fn: Callable[[list[float]], Any], name: str, least: int = 1) -> Callable[[Evaluator, list[Any]], Any]:
    def run(ev: Evaluator, a: list[Any]) -> Any:
        xs = nums(_database(a, name))
        return clean_number(fn(xs)) if len(xs) >= least else None

    return run


FUNCS.update({
    # Fusion: arrays
    "array_concat": lambda ev, a: _arr(flat(a)),
    "array_difference": lambda ev, a: _array_difference(a),
    "array_distinct": lambda ev, a: _arr(_distinct(flat(a))),
    "array_get_at_index": lambda ev, a: _array_at(a, int(_x(a, 1, "array_get_at_index")) - 1) if _x(a, 1, "array_get_at_index") >= 1 else None,
    "array_get_first": lambda ev, a: _array_at(a, 0),
    "array_get_last": lambda ev, a: _array_at(a, -1),
    "array_intersection": lambda ev, a: _array_intersection(a),
    "array_sort": lambda ev, a: _array_sort(a),
    "array_zip": lambda ev, a: _arr(list(t) for t in zip(*[flat([x]) for x in a])),
    "set_to_array": lambda ev, a: _array_sort([_arr(_distinct(flat(a)))]),
    "set_get_any": lambda ev, a: _array_at(a, 0),
    "experimental_range": lambda ev, a: _experimental_range(a),
    # Fusion: math and aggregates
    "cbrt": lambda ev, a: clean_number(round(math.cbrt(_x(a, 0, "cbrt")), 12)),
    "pow": lambda ev, a: clean_number(_x(a, 0, "pow") ** _x(a, 1, "pow")),
    "factorial": lambda ev, a: math.factorial(int(_x(a, 0, "factorial"))),
    "mean": lambda ev, a: clean_number(sum(nums(a)) / len(nums(a))) if nums(a) else None,
    "stddev": lambda ev, a: clean_number(_st.stdev(nums(a))) if len(nums(a)) > 1 else None,
    "stddev_p": lambda ev, a: clean_number(_st.pstdev(nums(a))) if nums(a) else None,
    "variance": lambda ev, a: clean_number(_st.variance(nums(a))) if len(nums(a)) > 1 else None,
    "variance_p": lambda ev, a: clean_number(_st.pvariance(nums(a))) if nums(a) else None,
    "count_distinct": lambda ev, a: len(_distinct([v for v in flat(a) if v not in (None, "")])),
    "count_numeric": lambda ev, a: sum(1 for v in flat(a) if isinstance(v, (int, float)) and not isinstance(v, bool)),
    "sum_distinct": lambda ev, a: clean_number(sum(set(nums(a)))),
    "sum_product": lambda ev, a: _sum_product(a),
    "subtotal": _subtotal,
    # Fusion: text and hashes
    "case_toggle": lambda ev, a: to_text(plain(a[0])).swapcase(),
    "concat_ws": lambda ev, a: to_text(plain(a[0])).join(to_text(v) for v in flat(a[1:]) if v is not None),
    "format_number": lambda ev, a: f"{_x(a, 0, 'format_number'):,.{max(int(_x(a, 1, 'format_number', 0)), 0)}f}",
    "format_string": lambda ev, a: _format_string(a),
    "lpad": lambda ev, a: _pad(a, True, "lpad"),
    "rpad": lambda ev, a: _pad(a, False, "rpad"),
    "ltrim": lambda ev, a: to_text(plain(a[0])).lstrip(" "),
    "rtrim": lambda ev, a: to_text(plain(a[0])).rstrip(" "),
    "reverse": lambda ev, a: to_text(plain(a[0]))[::-1],
    "md5": lambda ev, a: _hash.md5(to_text(plain(a[0])).encode()).hexdigest(),
    "sha1": lambda ev, a: _hash.sha1(to_text(plain(a[0])).encode()).hexdigest(),
    "regexp_replace": lambda ev, a: _regex(a[1]).sub(to_text(plain(a[2])) if len(a) > 2 else "", to_text(plain(a[0]))),
    "split_regex": lambda ev, a: _arr(x for x in _regex(a[1]).split(to_text(plain(a[0]))) if x),
    "empty_cell": lambda ev, a: None,
    "experimental_error": lambda ev, a: (_ for _ in ()).throw(FusionError(" ".join(to_text(v) for v in flat(a)) or "error")),
    "document_metadata": _document_metadata,
    # Fusion: dates and timestamps
    "date_add": lambda ev, a: _date_add(a, 1, "date_add"),
    "date_sub": lambda ev, a: _date_add(a, -1, "date_sub"),
    "date_format": lambda ev, a: _date_format(a),
    "day_of_month": lambda ev, a: _datetime(a[0]).day,
    "day_of_year": lambda ev, a: _datetime(a[0]).timetuple().tm_yday,
    "week_of_year": lambda ev, a: _datetime(a[0]).isocalendar()[1],
    "last_day": lambda ev, a: _eomonth([a[0]]),
    "months_between": lambda ev, a: _months_between(a),
    "net_workdays": lambda ev, a: _networkdays(a),
    "parse_date": lambda ev, a: _parse_when(a, "parse_date").date().isoformat(),
    "parse_timestamp": lambda ev, a: _parse_when(a, "parse_timestamp").replace(microsecond=0).isoformat(sep=" "),
    "timestamp": lambda ev, a: _timestamp(a),
    "to_unix_timestamp": lambda ev, a: _cal.timegm(_parse_when(a, "to_unix_timestamp").timetuple()) * 1000,
    # Fusion: lookup modifiers and sorted / set lookups
    "eq": lambda ev, a: _modifier("==", a, "eq"),
    "neq": lambda ev, a: _modifier("!=", a, "neq"),
    "gt": lambda ev, a: _modifier(">", a, "gt"),
    "gte": lambda ev, a: _modifier(">=", a, "gte"),
    "lt": lambda ev, a: _modifier("<", a, "lt"),
    "lte": lambda ev, a: _modifier("<=", a, "lte"),
    "exact": lambda ev, a: _exact(a),
    "fuzzy": lambda ev, a: _modifier("fuzzy", a, "fuzzy"),
    "all_token_match": lambda ev, a: _modifier("all_tokens", a, "all_token_match"),
    "any_token_match": lambda ev, a: _modifier("any_tokens", a, "any_token_match"),
    "lookup_set": lambda ev, a: _arr(_distinct([v for v in _lookup(ev, a) if v is not None])),
    "lookup_sorted": _lookup_sorted,
    # Fusion: validation and no-op actions
    "column_regex": lambda ev, a: _validation(all(_regex(a[1]).search(to_text(v)) for v in _column(a[0], "column_regex") if v not in (None, "")),
                                              "every value matches the pattern"),
    "action.success": lambda ev, a: _action("noop", ok=True),
    "action.fail": lambda ev, a: _action("noop", ok=False),
    # references, lookups and arrays
    "index": _index_at,
    "match": lambda ev, a: _match_pos(a),
    "xmatch": lambda ev, a: _xmatch(a),
    "rows": lambda ev, a: len(a[0].rows) if isinstance(a[0], Range) else len(flat([a[0]])),
    "columns": lambda ev, a: len(a[0].rows[0]) if isinstance(a[0], Range) and a[0].rows else 1,
    "address": lambda ev, a: _address(a),
    "indirect": _indirect,
    "take": lambda ev, a: _take(a, False, "take"),
    "drop": lambda ev, a: _take(a, True, "drop"),
    "tocol": lambda ev, a: _arr(flat(a[:1])),
    "torow": lambda ev, a: _arr(flat(a[:1])),
    "flatten": lambda ev, a: _arr(flat(a)),
    "sortby": lambda ev, a: _sortby(a),
    "sheet": lambda ev, a: ev.doc["sheets"].index(ev.sheet_named(None)) + 1,
    "sheets": lambda ev, a: len(ev.doc["sheets"]),
    "hyperlink": lambda ev, a: {"__kind__": "url", "href": to_text(plain(a[0])), "value": to_text(plain(a[1])) if len(a) > 1 else to_text(plain(a[0]))},
    # information
    "isna": lambda ev, a: plain(a[0]) is None,
    "isnontext": lambda ev, a: not isinstance(plain(a[0]), str),
    "isdate": lambda ev, a: _isdate(a[0]),
    "isemail": lambda ev, a: bool(_re.fullmatch(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+", to_text(plain(a[0])).strip())),
    "isurl": lambda ev, a: bool(_re.fullmatch(r"(?:(?:https?|ftp)://)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d+)?([/?#]\S*)?", to_text(plain(a[0])).strip())),
    "isbetween": lambda ev, a: _isbetween(a),
    # text
    "find": lambda ev, a: _find_at(a, False, "find"),
    "search": lambda ev, a: _find_at(a, True, "search"),
    "replace": lambda ev, a: _replace(a),
    "dollar": lambda ev, a: _dollar(a),
    "numbervalue": lambda ev, a: _numbervalue(a),
    "textsplit": lambda ev, a: _textsplit(a),
    "arraytotext": lambda ev, a: ", ".join(to_text(v) for v in flat(a[:1])),
    "roman": lambda ev, a: _roman(a),
    "arabic": lambda ev, a: _arabic(a),
    "base": lambda ev, a: _base(a),
    "decimal": lambda ev, a: _decimal(a),
    # dates and times
    "timevalue": lambda ev, a: _timevalue(a),
    "networkdays.intl": lambda ev, a: _networkdays_intl(a),
    "workday.intl": lambda ev, a: _workday_intl(a),
    "epochtodate": lambda ev, a: _epochtodate(a),
    # rounding, trigonometry and arithmetic
    "ceiling": lambda ev, a: _ceiling(a, True, "ceiling"),
    "floor": lambda ev, a: _ceiling(a, False, "floor"),
    "ceiling.math": lambda ev, a: _ceiling_math(a, True, "ceiling.math"),
    "floor.math": lambda ev, a: _ceiling_math(a, False, "floor.math"),
    "ceiling.precise": lambda ev, a: _multiple(_x(a, 0, "ceiling.precise"), abs(_x(a, 1, "ceiling.precise", 1)), True),
    "floor.precise": lambda ev, a: _multiple(_x(a, 0, "floor.precise"), abs(_x(a, 1, "floor.precise", 1)), False),
    "iso.ceiling": lambda ev, a: _multiple(_x(a, 0, "iso.ceiling"), abs(_x(a, 1, "iso.ceiling", 1)), True),
    "sec": lambda ev, a: 1 / math.cos(_x(a, 0, "sec")),
    "csc": lambda ev, a: 1 / (math.sin(_x(a, 0, "csc")) or _div0()),
    "cot": lambda ev, a: 1 / (math.tan(_x(a, 0, "cot")) or _div0()),
    "sech": lambda ev, a: 1 / math.cosh(_x(a, 0, "sech")),
    "csch": lambda ev, a: 1 / (math.sinh(_x(a, 0, "csch")) or _div0()),
    "coth": lambda ev, a: 1 / (math.tanh(_x(a, 0, "coth")) or _div0()),
    "asinh": lambda ev, a: math.asinh(_x(a, 0, "asinh")),
    "acosh": lambda ev, a: math.acosh(_x(a, 0, "acosh")),
    "atanh": lambda ev, a: math.atanh(_x(a, 0, "atanh")),
    "acot": lambda ev, a: math.pi / 2 - math.atan(_x(a, 0, "acot")),
    "acoth": lambda ev, a: 0.5 * math.log((_x(a, 0, "acoth") + 1) / (_x(a, 0, "acoth") - 1)),
    "sqrtpi": lambda ev, a: math.sqrt(_x(a, 0, "sqrtpi") * math.pi),
    "multinomial": lambda ev, a: math.factorial(sum(int(x) for x in nums(a))) // math.prod(math.factorial(int(x)) for x in nums(a)),
    "seriessum": lambda ev, a: _series_sum(a),
    "factdouble": lambda ev, a: math.prod(range(int(_x(a, 0, "factdouble")), 0, -2)),
    "combina": lambda ev, a: math.comb(int(_x(a, 0, "combina")) + int(_x(a, 1, "combina")) - 1, int(_x(a, 1, "combina"))),
    "permutationa": lambda ev, a: int(_x(a, 0, "permutationa")) ** int(_x(a, 1, "permutationa")),
    "sumx2my2": lambda ev, a: clean_number(sum(x * x - y * y for x, y in _xy(a, "sumx2my2"))),
    "sumx2py2": lambda ev, a: clean_number(sum(x * x + y * y for x, y in _xy(a, "sumx2py2"))),
    "sumxmy2": lambda ev, a: clean_number(sum((x - y) ** 2 for x, y in _xy(a, "sumxmy2"))),
    "mdeterm": lambda ev, a: _mdeterm(a),
    # engineering
    "bitand": lambda ev, a: (lambda x, y: x & y)(*_bits(a, "bitand")),
    "bitor": lambda ev, a: (lambda x, y: x | y)(*_bits(a, "bitor")),
    "bitxor": lambda ev, a: (lambda x, y: x ^ y)(*_bits(a, "bitxor")),
    "bitlshift": lambda ev, a: _bitshift(a, True, "bitlshift"),
    "bitrshift": lambda ev, a: _bitshift(a, False, "bitrshift"),
    "delta": lambda ev, a: int(_x(a, 0, "delta") == _x(a, 1, "delta", 0)),
    "gestep": lambda ev, a: int(_x(a, 0, "gestep") >= _x(a, 1, "gestep", 0)),
    "convert": lambda ev, a: _convert(a),
    "erf": lambda ev, a: _erf(a),
    "erfc": lambda ev, a: math.erfc(_x(a, 0, "erfc")),
    # financial
    "pmt": lambda ev, a: _pmt(_x(a, 0, "pmt"), _x(a, 1, "pmt"), _x(a, 2, "pmt"), _x(a, 3, "pmt", 0), _typ(a, 4, "pmt")),
    "fv": lambda ev, a: _fv(_x(a, 0, "fv"), _x(a, 1, "fv"), _x(a, 2, "fv"), _x(a, 3, "fv", 0), _typ(a, 4, "fv")),
    "pv": lambda ev, a: _pv(_x(a, 0, "pv"), _x(a, 1, "pv"), _x(a, 2, "pv"), _x(a, 3, "pv", 0), _typ(a, 4, "pv")),
    "nper": lambda ev, a: _nper(_x(a, 0, "nper"), _x(a, 1, "nper"), _x(a, 2, "nper"), _x(a, 3, "nper", 0), _typ(a, 4, "nper")),
    "rate": lambda ev, a: _rate(a),
    "ipmt": lambda ev, a: _ipmt(_x(a, 0, "ipmt"), _x(a, 1, "ipmt"), _x(a, 2, "ipmt"), _x(a, 3, "ipmt"), _x(a, 4, "ipmt", 0), _typ(a, 5, "ipmt")),
    "ppmt": lambda ev, a: (_pmt(_x(a, 0, "ppmt"), _x(a, 2, "ppmt"), _x(a, 3, "ppmt"), _x(a, 4, "ppmt", 0), _typ(a, 5, "ppmt"))
                           - _ipmt(_x(a, 0, "ppmt"), _x(a, 1, "ppmt"), _x(a, 2, "ppmt"), _x(a, 3, "ppmt"), _x(a, 4, "ppmt", 0), _typ(a, 5, "ppmt"), "ppmt")),
    "npv": lambda ev, a: sum(v / (1 + _x(a, 0, "npv")) ** (i + 1) for i, v in enumerate(nums(a[1:]))),
    "irr": lambda ev, a: _irr(a),
    "mirr": lambda ev, a: _mirr(a),
    "xnpv": lambda ev, a: sum(v / (1 + _x(a, 0, "xnpv")) ** t for v, t in _dated(a[1], a[2], "xnpv")),
    "xirr": lambda ev, a: _xirr(a),
    "sln": lambda ev, a: (_x(a, 0, "sln") - _x(a, 1, "sln")) / (_x(a, 2, "sln") or _div0()),
    "syd": lambda ev, a: (lambda c, s, life, per: (c - s) * (life - per + 1) * 2 / (life * (life + 1)))(*_depreciation(a, "syd")),
    "db": lambda ev, a: _db(a),
    "ddb": lambda ev, a: _ddb(a),
    "effect": lambda ev, a: (1 + _x(a, 0, "effect") / int(_positive(_x(a, 1, "effect"), "effect", "the number of periods"))) ** int(_x(a, 1, "effect")) - 1,
    "nominal": lambda ev, a: ((1 + _x(a, 0, "nominal")) ** (1 / int(_positive(_x(a, 1, "nominal"), "nominal", "the number of periods"))) - 1) * int(_x(a, 1, "nominal")),
    "cumipmt": lambda ev, a: _cumulative(a, False, "cumipmt"),
    "cumprinc": lambda ev, a: _cumulative(a, True, "cumprinc"),
    "fvschedule": lambda ev, a: _x(a, 0, "fvschedule") * math.prod(1 + r for r in nums(a[1:])),
    "pduration": lambda ev, a: (math.log(_x(a, 2, "pduration")) - math.log(_x(a, 1, "pduration"))) / math.log(1 + _x(a, 0, "pduration")),
    "rri": lambda ev, a: (_x(a, 2, "rri") / (_x(a, 1, "rri") or _div0())) ** (1 / (_x(a, 0, "rri") or _div0())) - 1,
    "dollarde": lambda ev, a: _dollar_fraction(a, True, "dollarde"),
    "dollarfr": lambda ev, a: _dollar_fraction(a, False, "dollarfr"),
    # distributions
    "norm.dist": lambda ev, a: _norm_dist(a, "norm.dist"),
    "norm.inv": lambda ev, a: _norm_inv(_x(a, 0, "norm.inv"), _x(a, 1, "norm.inv"), _x(a, 2, "norm.inv"), "norm.inv"),
    "norm.s.dist": lambda ev, a: _st.NormalDist().cdf(_x(a, 0, "norm.s.dist")) if _flag(a, 1, True) else _st.NormalDist().pdf(_x(a, 0, "norm.s.dist")),
    "norm.s.inv": lambda ev, a: _norm_inv(_x(a, 0, "norm.s.inv"), 0, 1, "norm.s.inv"),
    "normsdist": lambda ev, a: _st.NormalDist().cdf(_x(a, 0, "normsdist")),
    "phi": lambda ev, a: _st.NormalDist().pdf(_x(a, 0, "phi")),
    "gauss": lambda ev, a: _st.NormalDist().cdf(_x(a, 0, "gauss")) - 0.5,
    "standardize": lambda ev, a: (_x(a, 0, "standardize") - _x(a, 1, "standardize")) / _positive(_x(a, 2, "standardize"), "standardize", "the standard deviation"),
    "fisher": lambda ev, a: math.atanh(_x(a, 0, "fisher")),
    "fisherinv": lambda ev, a: math.tanh(_x(a, 0, "fisherinv")),
    "confidence.norm": lambda ev, a: _confidence(a, "confidence.norm", False),
    "confidence.t": lambda ev, a: _confidence(a, "confidence.t", True),
    "lognorm.dist": lambda ev, a: _lognorm_dist(a, "lognorm.dist", _flag(a, 3, True)),
    "lognormdist": lambda ev, a: _lognorm_dist(a, "lognormdist", True),
    "lognorm.inv": lambda ev, a: math.exp(_norm_inv(_x(a, 0, "lognorm.inv"), _x(a, 1, "lognorm.inv"), _x(a, 2, "lognorm.inv"), "lognorm.inv")),
    "binom.dist": lambda ev, a: _binom_dist(a, "binom.dist"),
    "binom.inv": lambda ev, a: _binom_inv(a, "binom.inv"),
    "negbinom.dist": lambda ev, a: _negbinom_dist(a, "negbinom.dist"),
    "negbinomdist": lambda ev, a: _negbinom_dist(a, "negbinomdist", False),
    "poisson.dist": lambda ev, a: _poisson_dist(a, "poisson.dist"),
    "hypgeom.dist": lambda ev, a: _hypgeom_dist(a, "hypgeom.dist"),
    "hypgeomdist": lambda ev, a: _hypgeom_dist(a, "hypgeomdist", False),
    "expon.dist": lambda ev, a: _expon_dist(a, "expon.dist"),
    "weibull.dist": lambda ev, a: _weibull_dist(a, "weibull.dist"),
    "gamma": lambda ev, a: _gamma_fn(a),
    "gammaln": lambda ev, a: math.lgamma(_positive(_x(a, 0, "gammaln"), "gammaln", "x")),
    "gamma.dist": lambda ev, a: _gamma_dist(a, "gamma.dist"),
    "gamma.inv": lambda ev, a: _positive(_x(a, 2, "gamma.inv"), "gamma.inv", "beta") * _invert(
        lambda x: _gammainc(_positive(_x(a, 1, "gamma.inv"), "gamma.inv", "alpha"), x), _x(a, 0, "gamma.inv"), "gamma.inv"),
    "beta.dist": lambda ev, a: _beta_dist(a, "beta.dist", False),
    "betadist": lambda ev, a: _beta_dist(a, "betadist", True),
    "beta.inv": lambda ev, a: _beta_inv(a, "beta.inv"),
    "chisq.dist": lambda ev, a: (_chi_cdf if _flag(a, 2, True) else _chi_pdf)(_x(a, 0, "chisq.dist"), _df(a, 1, "chisq.dist")),
    "chisq.dist.rt": lambda ev, a: 1 - _chi_cdf(_x(a, 0, "chisq.dist.rt"), _df(a, 1, "chisq.dist.rt")),
    "chisq.inv": lambda ev, a: _invert(lambda x: _chi_cdf(x, _df(a, 1, "chisq.inv")), _x(a, 0, "chisq.inv"), "chisq.inv"),
    "chisq.inv.rt": lambda ev, a: _invert(lambda x: _chi_cdf(x, _df(a, 1, "chisq.inv.rt")), 1 - _x(a, 0, "chisq.inv.rt"), "chisq.inv.rt"),
    "chisq.test": lambda ev, a: _chitest(a, "chisq.test"),
    "t.dist": lambda ev, a: (_t_cdf if _flag(a, 2, True) else _t_pdf)(_x(a, 0, "t.dist"), _df(a, 1, "t.dist")),
    "t.dist.2t": lambda ev, a: _t_tail(a, "t.dist.2t", 2),
    "t.dist.rt": lambda ev, a: _t_tail(a, "t.dist.rt", 1),
    "tdist": lambda ev, a: _t_tail(a, "tdist"),
    "t.inv": lambda ev, a: _t_inv(_x(a, 0, "t.inv"), _df(a, 1, "t.inv"), "t.inv"),
    "t.inv.2t": lambda ev, a: _t_inv(1 - _x(a, 0, "t.inv.2t") / 2, _df(a, 1, "t.inv.2t"), "t.inv.2t"),
    "f.dist": lambda ev, a: (_f_cdf if _flag(a, 3, True) else _f_pdf)(_x(a, 0, "f.dist"), _df(a, 1, "f.dist"), _df(a, 2, "f.dist")),
    "f.dist.rt": lambda ev, a: 1 - _f_cdf(_x(a, 0, "f.dist.rt"), _df(a, 1, "f.dist.rt"), _df(a, 2, "f.dist.rt")),
    "f.inv": lambda ev, a: _invert(lambda x: _f_cdf(x, _df(a, 1, "f.inv"), _df(a, 2, "f.inv")), _x(a, 0, "f.inv"), "f.inv"),
    "f.inv.rt": lambda ev, a: _invert(lambda x: _f_cdf(x, _df(a, 1, "f.inv.rt"), _df(a, 2, "f.inv.rt")), 1 - _x(a, 0, "f.inv.rt"), "f.inv.rt"),
    "z.test": lambda ev, a: _ztest(a, "z.test"),
    # more statistics
    "averagea": lambda ev, a: clean_number(sum(_a_values(a)) / len(_a_values(a))) if _a_values(a) else None,
    "maxa": lambda ev, a: clean_number(max(_a_values(a))) if _a_values(a) else 0,
    "mina": lambda ev, a: clean_number(min(_a_values(a))) if _a_values(a) else 0,
    "stdeva": lambda ev, a: clean_number(_st.stdev(_a_values(a))) if len(_a_values(a)) > 1 else None,
    "stdevpa": lambda ev, a: clean_number(_st.pstdev(_a_values(a))) if _a_values(a) else None,
    "vara": lambda ev, a: clean_number(_st.variance(_a_values(a))) if len(_a_values(a)) > 1 else None,
    "varpa": lambda ev, a: clean_number(_st.pvariance(_a_values(a))) if _a_values(a) else None,
    "percentile.exc": lambda ev, a: _percentile_exc(a),
    "quartile.exc": lambda ev, a: _quartile_exc(a),
    "percentrank.exc": lambda ev, a: _percentrank_exc(a),
    "rank.avg": lambda ev, a: _rank_avg(a),
    "trimmean": lambda ev, a: _trimmean(a),
    "frequency": lambda ev, a: _frequency(a),
    "prob": lambda ev, a: _prob_range(a),
    "mode.mult": lambda ev, a: _mode_mult(a),
    "steyx": lambda ev, a: _steyx(a),
    "covariance.s": lambda ev, a: _covariance_s(a),
    "skew.p": lambda ev, a: _skew_p(a),
    # database functions
    "dsum": lambda ev, a: clean_number(sum(nums(_database(a, "dsum")))),
    "dcount": lambda ev, a: len(nums(_database(a, "dcount"))),
    "dcounta": lambda ev, a: sum(1 for v in _database(a, "dcounta") if v not in (None, "")),
    "dget": lambda ev, a: _dget(a),
    "daverage": _dstat(lambda xs: sum(xs) / len(xs), "daverage"),
    "dmax": _dstat(max, "dmax"),
    "dmin": _dstat(min, "dmin"),
    "dproduct": _dstat(math.prod, "dproduct"),
    "dstdev": _dstat(_st.stdev, "dstdev", 2),
    "dstdevp": _dstat(_st.pstdev, "dstdevp"),
    "dvar": _dstat(_st.variance, "dvar", 2),
    "dvarp": _dstat(_st.pvariance, "dvarp"),
})

for _src in _BASES:
    for _dst in _BASES:
        if _src != _dst:
            FUNCS[f"{_src}2{_dst}"] = _base_convert(_src, _dst)

# other names of the same functions (the spreadsheet's newer and older spellings)
for _alias, _name in {
    "stdev.s": "stdev", "stdev.p": "stdevp", "var.s": "var", "var.p": "varp", "mode.sngl": "mode", "percentile.inc": "percentile",
    "quartile.inc": "quartile", "percentrank.inc": "percentrank", "rank.eq": "rank", "covariance.p": "covar", "pearson": "correl",
    "forecast.linear": "forecast", "normdist": "norm.dist", "norminv": "norm.inv", "normsinv": "norm.s.inv", "loginv": "lognorm.inv",
    "binomdist": "binom.dist", "critbinom": "binom.inv", "poisson": "poisson.dist", "expondist": "expon.dist", "weibull": "weibull.dist",
    "gammadist": "gamma.dist", "gammainv": "gamma.inv", "gammaln.precise": "gammaln", "betainv": "beta.inv", "chidist": "chisq.dist.rt",
    "chiinv": "chisq.inv.rt", "chitest": "chisq.test", "tinv": "t.inv.2t", "fdist": "f.dist.rt", "finv": "f.inv.rt", "ztest": "z.test",
    "confidence": "confidence.norm", "erf.precise": "erf", "erfc.precise": "erfc", "regexmatch": "regex_match", "regextest": "regex_match",
    "regexextract": "regex_extract", "regexreplace": "regex_replace", "encodeurl": "url_encode", "validate_table": "action.validate_table",
}.items():
    if _name in FUNCS:
        FUNCS[_alias] = FUNCS[_name]

LAZY.update({
    "action.validate_table": _validate_table,
    "validate_table": _validate_table,
    "row": lambda ev, a: _position(ev, a, "row")[0] + 1,
    "column": lambda ev, a: _position(ev, a, "column")[1] + 1,
    "offset": _offset,
    "isformula": lambda ev, a: _formula_of(ev, a, "isformula") is not None,
    "formulatext": lambda ev, a: _formula_of(ev, a, "formulatext"),
    "isref": lambda ev, a: len(a) == 1 and isinstance(a[0], tuple) and a[0][0] in ("ref", "range"),
    "iserr": _iserr,
    "type": _type,
})


# ------------------------------------------------------------------ 2-D results: they spill over the cells beside them

MAX_SPILL = 10_000
# a formula can only give a result that spills through a range (A1:B3), a spill reference (A1#), an array {…; …} or a
# function call: Evaluator.spilled looks at no other formula cell (=B1 + C1 never spills)
_SPILLS = re.compile(r"[:#{(]")


def _grid(v: Any, name: str) -> list[list[Any]]:
    """Rows of values: a range or a 2-D result as it is, an array as one column, a single value as one cell."""
    if isinstance(v, Range):
        rows = [[plain(x) for x in row] for row in v.rows]
    elif isinstance(v, dict) and v.get("__kind__") == "matrix":
        rows = [list(row) for row in v.get("rows") or []]
    else:
        p = plain(v)
        rows = [[plain(x)] for x in p] if isinstance(p, list) else [[p]]
    if not rows or not rows[0]:
        raise FusionError(f"{name}(): the array is empty")
    if len(rows) * len(rows[0]) > MAX_SPILL:
        raise FusionError(f"{name}() takes at most {MAX_SPILL:,} values")
    return rows


def _numgrid(v: Any, name: str) -> list[list[float]]:
    rows = [[num(x) for x in row] for row in _grid(v, name)]
    if any(x is None for row in rows for x in row):
        raise FusionError(f"{name}() takes numbers: a cell of the range is empty or text")
    return rows


def _matrix(rows: list[list[Any]]) -> Matrix:
    return Matrix([[clean_number(x) if isinstance(x, float) else x for x in row] for row in rows])


def _given(a: list[Any], i: int) -> bool:
    """Whether the i-th argument was given (null stands for an argument left out)."""
    return len(a) > i and a[i] is not None


def _transpose(a: list[Any]) -> Matrix:
    _arity(a, 1, 1, "transpose")
    return Matrix([list(col) for col in zip(*_grid(a[0], "transpose"))])


def _mmult(a: list[Any]) -> Matrix:
    _arity(a, 2, 2, "mmult")
    x, y = _numgrid(a[0], "mmult"), _numgrid(a[1], "mmult")
    if len(x[0]) != len(y):
        raise FusionError(f"mmult(): the first array has {len(x[0])} columns, the second {len(y)} rows — they must be equal")
    cols = list(zip(*y))
    return _matrix([[math.fsum(p * q for p, q in zip(row, col)) for col in cols] for row in x])


def _inverse(m: list[list[float]], name: str, why: str) -> list[list[float]]:
    """Gauss-Jordan elimination with partial pivoting."""
    n = len(m)
    scale = max((abs(v) for row in m for v in row), default=0.0)
    w = [list(map(float, row)) + [1.0 if i == j else 0.0 for j in range(n)] for i, row in enumerate(m)]
    for i in range(n):
        p = max(range(i, n), key=lambda k: abs(w[k][i]))
        if abs(w[p][i]) <= 1e-12 * scale or scale == 0:
            raise FusionError(f"{name}(): {why}")
        w[i], w[p] = w[p], w[i]
        d = w[i][i]
        w[i] = [v / d for v in w[i]]
        for k in range(n):
            if k != i and w[k][i]:
                f = w[k][i]
                w[k] = [vk - f * vi for vk, vi in zip(w[k], w[i])]
    return [row[n:] for row in w]


def _minverse(a: list[Any]) -> Matrix:
    _arity(a, 1, 1, "minverse")
    m = _numgrid(a[0], "minverse")
    if any(len(row) != len(m) for row in m):
        raise FusionError("minverse() takes a square array")
    return _matrix(_inverse(m, "minverse", "the matrix is singular, it has no inverse"))


def _munit(a: list[Any]) -> Matrix:
    _arity(a, 1, 1, "munit")
    n = int(_x(a, 0, "munit"))
    if not 1 <= n <= 100:
        raise FusionError("munit(dimension): a dimension from 1 to 100")
    return Matrix([[1 if i == j else 0 for j in range(n)] for i in range(n)])


class _Fit:
    """Least squares of y on one or more x variables: y = b + m1·x1 + … + mk·xk (b = 0 without a constant)."""

    def __init__(self, a: list[Any], name: str, log: bool = False) -> None:
        yg = _numgrid(a[0], name)
        xg = _numgrid(a[1], name) if _given(a, 1) else None
        self.name, self.const, self.log = name, _flag(a, 3 if name in ("trend", "growth") else 2, True), log
        self.xg, self.shape = xg, (len(yg), len(yg[0]))
        ys = [v for row in yg for v in row]
        n = len(ys)
        if xg is None:
            xs, self.orient = [[float(i + 1) for i in range(n)]], "same"
        elif (len(xg), len(xg[0])) == self.shape:
            xs, self.orient = [[v for row in xg for v in row]], "same"
        elif len(yg[0]) == 1 and len(xg) == n:
            xs, self.orient = [list(col) for col in zip(*xg)], "columns"  # one x variable per column
        elif len(yg) == 1 and len(xg[0]) == n:
            xs, self.orient = [list(row) for row in xg], "rows"  # one x variable per row
        else:
            raise FusionError(f"{name}(): the known x values need as many rows (or columns) as there are known y values ({n})")
        if log:
            if any(v <= 0 for v in ys):
                raise FusionError(f"{name}() fits an exponential curve: every known y must be positive")
            ys = [math.log(v) for v in ys]
        k = len(xs)
        self.n, self.k, self.df = n, k, n - k - (1 if self.const else 0)
        if self.df < 0:
            raise FusionError(f"{name}(): {n} observations are too few for {k} x variable(s)")
        self.xm = [math.fsum(x) / n for x in xs] if self.const else [0.0] * k
        ym = math.fsum(ys) / n if self.const else 0.0
        xc = [[v - m for v in x] for x, m in zip(xs, self.xm)]
        yc = [v - ym for v in ys]
        s = [[math.fsum(p * q for p, q in zip(xc[i], xc[j])) for j in range(k)] for i in range(k)]
        self.c = _inverse(s, name, "the x values do not vary, or one x variable is a combination of the others")
        t = [math.fsum(p * q for p, q in zip(x, yc)) for x in xc]
        self.m = [math.fsum(self.c[i][j] * t[j] for j in range(k)) for i in range(k)]
        self.b = ym - math.fsum(m * x for m, x in zip(self.m, self.xm)) if self.const else 0.0
        fitted = [self.at([x[i] for x in xs]) for i in range(n)]
        self.ss_resid = math.fsum((y - f) ** 2 for y, f in zip(ys, fitted))
        self.ss_total = math.fsum(v * v for v in yc)
        self.ss_reg = self.ss_total - self.ss_resid

    def at(self, x: list[float]) -> float:
        return self.b + math.fsum(m * v for m, v in zip(self.m, x))

    def stats(self) -> list[list[Any]]:
        """linest's five rows: coefficients (last x variable first, then b), their standard errors, r² and the
        standard error of y, F and the degrees of freedom, the regression and residual sums of squares."""
        k, width = self.k, self.k + 1
        sey = math.sqrt(self.ss_resid / self.df) if self.df > 0 else None
        se_m = [sey * math.sqrt(max(self.c[i][i], 0.0)) if sey is not None else None for i in range(k)]
        se_b = None
        if sey is not None and self.const:
            q = math.fsum(self.xm[i] * self.c[i][j] * self.xm[j] for i in range(k) for j in range(k))
            se_b = sey * math.sqrt(max(1 / self.n + q, 0.0))
        f = (self.ss_reg / k) / (self.ss_resid / self.df) if self.df > 0 and self.ss_resid > 0 else None
        pad = [None] * (width - 2)
        return [list(reversed(self.m)) + [self.b], list(reversed(se_m)) + [se_b],
                [self.ss_reg / self.ss_total if self.ss_total else None, sey] + pad, [f, self.df] + pad, [self.ss_reg, self.ss_resid] + pad]

    def predict(self, a: list[Any]) -> Matrix:
        """trend / growth: the fitted line at the new x values (the known x values when none are given)."""
        ng = _numgrid(a[2], self.name) if _given(a, 2) else self.xg
        if ng is None:
            rows, cols = self.shape
            out = [[self.at([float(i * cols + j + 1)]) for j in range(cols)] for i in range(rows)]
        elif self.k == 1:
            out = [[self.at([v]) for v in row] for row in ng]
        elif self.orient == "columns":
            if len(ng[0]) != self.k:
                raise FusionError(f"{self.name}(): the new x values need {self.k} columns, one per x variable")
            out = [[self.at(list(row))] for row in ng]
        else:
            if len(ng) != self.k:
                raise FusionError(f"{self.name}(): the new x values need {self.k} rows, one per x variable")
            out = [[self.at(list(col)) for col in zip(*ng)]]
        return _matrix([[math.exp(v) for v in row] for row in out] if self.log else out)


def _linest(a: list[Any]) -> Matrix:
    """linest(known y, [known x], [constant = true], [statistics = false])."""
    _arity(a, 1, 4, "linest")
    fit = _Fit(a, "linest")
    rows = fit.stats()
    return _matrix(rows if _flag(a, 3, False) else rows[:1])


def _trend(a: list[Any], name: str) -> Matrix:
    """trend / growth(known y, [known x], [new x], [constant = true])."""
    _arity(a, 1, 4, name)
    return _Fit(a, name, log=name == "growth").predict(a)


def _one_or_matrix(m: Matrix) -> Any:
    """A 1 x 1 result is a single value (trend(B1:B5, A1:A5, 6) + 1)."""
    return m.rows[0][0] if len(m.rows) == 1 and len(m.rows[0]) == 1 else m


FUNCS.update({
    "transpose": lambda ev, a: _one_or_matrix(_transpose(a)),
    "mmult": lambda ev, a: _one_or_matrix(_mmult(a)),
    "minverse": lambda ev, a: _one_or_matrix(_minverse(a)),
    "munit": lambda ev, a: _one_or_matrix(_munit(a)),
    "linest": lambda ev, a: _one_or_matrix(_linest(a)),
    "trend": lambda ev, a: _one_or_matrix(_trend(a, "trend")),
    "growth": lambda ev, a: _one_or_matrix(_trend(a, "growth")),
})


# ------------------------------------------------------------------ dynamic arrays: results that spill
#
# A formula spills when its result has several values: a computed array (the functions below, value-by-value
# arithmetic on ranges: A1:A4 * 2) or a reference to several cells (=A1:B3, =A1#). Fusion's own arrays — array(),
# split(), lookup_array(), array_* — stay one value in one cell, shown as [a, b, c]. Given to the functions below, such
# an array is one column (a value per row), like {1; 2; 3}; {1, 2; 3, 4} is two rows.

# the functions whose result spills: a one-value result of one of them can still be referred to as A1#
DYNAMIC = frozenset({"transpose", "mmult", "minverse", "munit", "linest", "trend", "growth", "filter", "sort", "sortby", "unique",
                     "sequence", "randarray", "take", "drop", "choosecols", "chooserows", "vstack", "hstack", "tocol", "torow",
                     "wraprows", "wrapcols", "expand", "textsplit", "frequency", "mode.mult"})
_MAX_INPUT = 200_000  # values an array function reads (as many as a range can hold)


def _single(v: Any) -> Any:
    """A range of one cell is that cell's value."""
    if isinstance(v, Range) and len(v.rows) == 1 and len(v.rows[0]) == 1:
        return v.rows[0][0]
    return v


def _is_grid(v: Any) -> bool:
    """A range or computed array of more than one value (Fusion's one-cell arrays are not)."""
    return isinstance(v, Range) and bool(v.rows) and (len(v.rows) > 1 or len(v.rows[0]) > 1)


def _error_value(e: Exception) -> dict:
    v = {"__kind__": "error", "message": str(e) or type(e).__name__}
    code = next((c for c, cls in _ERROR_CODES.items() if isinstance(e, cls)), None)
    if code:
        v["code"] = code
    return v


def _spilled_value(x: Any) -> Any:
    """What a cell a result spills over holds: a plain value, an error of its own (#ERROR in that cell only), an array
    as one value."""
    if isinstance(x, dict) and x.get("__kind__") == "matrix":
        rows = x.get("rows") or [[None]]
        x = rows[0][0] if rows[0] else None
    if isinstance(x, dict) and x.get("__kind__") == "error":
        return x
    p = plain(x)
    return {"__kind__": "array", "items": p} if isinstance(p, list) else p


def _raw_rows(v: Any) -> list[list[Any]]:
    """Rows of a value as given (errors kept): a range or 2-D result as it is, an array as one column, a value as one cell."""
    v = _single(v)
    if isinstance(v, Range):
        return [list(row) for row in v.rows]
    if isinstance(v, dict) and v.get("__kind__") == "matrix":
        return [list(row) for row in v.get("rows") or [[None]]]
    items = v.get("items") if isinstance(v, dict) and v.get("__kind__") == "array" else v
    if isinstance(items, list):
        return [[x] for x in items] or [[]]
    return [[v]]


def _rows_of(v: Any, name: str) -> list[list[Any]]:
    """Rows of plain values; an error among them is the function's error."""
    raw = _raw_rows(v)
    if not raw or not raw[0]:
        raise FusionError(f"{name}(): the array is empty")
    if len(raw) * len(raw[0]) > _MAX_INPUT:
        raise FusionError(f"{name}() reads at most {_MAX_INPUT:,} values")
    return [[plain(x) for x in row] for row in raw]


def _flip(rows: list[list[Any]]) -> list[list[Any]]:
    return [list(col) for col in zip(*rows)]


def _out(rows: list[list[Any]], name: str) -> Any:
    """A function's result: one value, or the rows that spill."""
    if not rows or not rows[0]:
        raise CalcError(f"{name}(): the result is empty")
    if len(rows) == 1 and len(rows[0]) == 1:
        return rows[0][0]
    return Matrix(rows)


def _cell(fn: Callable[..., Any], raw: bool, *xs: Any) -> Any:
    """One value of a value-by-value operation; an error is that value's error, not the whole result's."""
    try:
        return fn(*xs) if raw else fn(*(plain(x) for x in xs))
    except _ERRORS as e:
        return _error_value(e)


def _shaped(v: Any, like: Optional[list[list[Any]]]) -> list[list[Any]]:
    """An operand's rows; a one-cell array as long as the range beside it takes that range's shape (B1:D1 * {1, 2, 3})."""
    v = _single(v)
    items = v.get("items") if isinstance(v, dict) and v.get("__kind__") == "array" else v if isinstance(v, list) else None
    if items is not None and like and len(items) == len(like) * len(like[0]) and len(items) > 1:
        w = len(like[0])
        return [list(items[i: i + w]) for i in range(0, len(items), w)]
    return _raw_rows(v)


def _broadcast(fn: Callable[..., Any], operands: list[Any], what: str, raw: bool = False) -> Matrix:
    """fn value by value over ranges and arrays of the same size; a single value, a single row or a single column is
    repeated to the size of the others (A1:A3 * 2, A1:A3 * B1:D1 is 3 x 3)."""
    first = next((_raw_rows(v) for v in operands if _is_grid(v)), None)
    grids = [_raw_rows(v) if _is_grid(v) else _shaped(v, first) for v in operands]

    def size(ns: list[int]) -> int:
        big = {n for n in ns if n != 1}
        if len(big) > 1:
            shapes = " and ".join(f"{len(g)} x {len(g[0])}" for g in grids)
            raise FusionError(f"{what} on arrays of different sizes ({shapes})")
        return big.pop() if big else 1

    h, w = size([len(g) for g in grids]), size([len(g[0]) for g in grids])
    if h * w > _MAX_INPUT:
        raise FusionError(f"{what} gives at most {_MAX_INPUT:,} values")
    return Matrix([[_cell(fn, raw, *(g[i if len(g) > 1 else 0][j if len(g[0]) > 1 else 0] for g in grids)) for j in range(w)]
                   for i in range(h)])


def _elementwise(fn: Callable[[Any], Any], v: Any) -> Matrix:
    return Matrix([[_cell(fn, False, x) for x in row] for row in _raw_rows(v)])


def _if_arrays(ev: Evaluator, cond: Any, a: list[Any]) -> Matrix:
    """if(A1:A5 > 2, 'big', 'small'): the condition value by value."""
    yes = ev.eval(a[1])
    no = ev.eval(a[2]) if len(a) > 2 else None
    return _broadcast(lambda c, t, f: t if truthy(c) else f, [cond, yes, no], "if", raw=True)


def _order_key(v: Any) -> tuple:
    """Sorting order: numbers, then text (ignoring case), then true / false; empty cells come last."""
    if v is None or v == "":
        return (3, 0)
    if isinstance(v, bool):
        return (2, v)
    if isinstance(v, (int, float)):
        return (0, float(v))
    return (1, to_text(v).lower())


def _sorted_by(items: list[Any], keys: list[tuple[list[Any], bool]]) -> list[Any]:
    """items in the order of keys (values, descending); a stable sort, empty values last either way."""
    import functools

    def cmp(i: int, j: int) -> int:
        for vals, desc in keys:
            p, q = _order_key(vals[i]), _order_key(vals[j])
            if p[0] == 3 or q[0] == 3:
                c = (p[0] == 3) - (q[0] == 3)
            else:
                c = (p > q) - (p < q)
                c = -c if desc else c
            if c:
                return c
        return 0

    return [items[i] for i in sorted(range(len(items)), key=functools.cmp_to_key(cmp))]


def _order(a: list[Any], i: int, name: str) -> bool:
    """A sort order argument: 1 ascending (the default), -1 descending; True when descending."""
    o = _x(a, i, name, 1)
    if o not in (1, -1):
        raise FusionError(f"{name}(): the sort order is 1 (ascending) or -1 (descending)")
    return o < 0


def _sort(a: list[Any]) -> Any:
    """sort(array, [sort index], [sort order], [by column]): the rows (or the columns) sorted by one of their values."""
    _arity(a, 1, 4, "sort")
    rows = _rows_of(a[0], "sort")
    by_col = _flag(a, 3, False)
    if by_col:
        rows = _flip(rows)
    idx = [int(x) for x in nums([a[1]])] if _given(a, 1) else [1]
    orders = [num(x) for x in flat([a[2]])] if _given(a, 2) else [1]
    if len(orders) == 1:
        orders = orders * len(idx)
    if not idx or len(orders) != len(idx):
        raise FusionError("sort(): as many sort orders as sort indexes")
    width = len(rows[0])
    if any(not 1 <= i <= width for i in idx):
        raise FusionError(f"sort(): the sort index is from 1 to {width}")
    descs = [_order([o], 0, "sort") for o in orders]
    out = _sorted_by(rows, [([r[i - 1] for r in rows], d) for i, d in zip(idx, descs)])
    return _out(_flip(out) if by_col else out, "sort")


def _one_way(g: list[list[Any]], h: int, w: int, name: str) -> tuple[bool, list[Any]]:
    """A by / include array beside an h x w array: (True, values) for one per row, (False, values) for one per column."""
    bh, bw = len(g), len(g[0])
    if bw == 1 and bh == h:
        return True, [r[0] for r in g]
    if bh == 1 and bw == w:
        return False, list(g[0])
    flat_ = [x for r in g for x in r]
    if (bh == 1 or bw == 1) and len(flat_) == h:
        return True, flat_
    if (bh == 1 or bw == 1) and len(flat_) == w:
        return False, flat_
    raise FusionError(f"{name}(): {bh} x {bw} values beside a {h} x {w} array: give one per row or one per column")


def _sortby(a: list[Any]) -> Any:
    """sortby(array, by array, [order], [by array, order …]): the rows (or columns) sorted by other values."""
    if len(a) < 2:
        raise FusionError("sortby(array, by array, [sort order], …)")
    rows = _rows_of(a[0], "sortby")
    h, w = len(rows), len(rows[0])
    keys: list[tuple[list[Any], bool]] = []
    per_row: Optional[bool] = None
    for i in range(1, len(a), 2):
        one, vals = _one_way(_rows_of(a[i], "sortby"), h, w, "sortby")
        if per_row is not None and one != per_row:
            raise FusionError("sortby(): the by arrays are all columns or all rows")
        per_row = one
        keys.append((vals, _order(a, i + 1, "sortby")))
    if per_row:
        return _out(_sorted_by(rows, keys), "sortby")
    return _out(_flip(_sorted_by(_flip(rows), keys)), "sortby")


def _ukey(v: Any) -> tuple:
    """What makes two values the same for unique(): text ignoring case, 1 and 1.0."""
    if v is None or v == "":
        return ("e",)
    if isinstance(v, bool):
        return ("b", v)
    if isinstance(v, (int, float)):
        return ("n", float(v))
    if isinstance(v, str):
        return ("s", v.lower())
    return ("o", repr(v))


def _unique(a: list[Any]) -> Any:
    """unique(array, [by column], [exactly once]): the distinct rows (or columns), in the order they first appear."""
    _arity(a, 1, 3, "unique")
    rows = _rows_of(a[0], "unique")
    by_col, once = _flag(a, 1, False), _flag(a, 2, False)
    if by_col:
        rows = _flip(rows)
    seen: dict[tuple, list[Any]] = {}
    for r in rows:
        k = tuple(_ukey(x) for x in r)
        if k in seen:
            seen[k][1] += 1
        else:
            seen[k] = [r, 1]
    out = [r for r, n in seen.values() if not once or n == 1]
    if not out:
        raise CalcError("unique(): no row appears exactly once")
    return _out(_flip(out) if by_col else out, "unique")


def _filter(a: list[Any]) -> Any:
    """filter(array, include, [if empty]): the rows (or columns) whose include value is true."""
    _arity(a, 2, 3, "filter")
    rows = _rows_of(a[0], "filter")
    per_row, keep = _one_way(_rows_of(a[1], "filter"), len(rows), len(rows[0]), "filter")
    out = [r for r, k in zip(rows, keep) if truthy(k)] if per_row else _flip([c for c, k in zip(_flip(rows), keep) if truthy(k)])
    if not out or not out[0]:
        if len(a) > 2:
            return a[2]
        raise CalcError("filter(): nothing matches (a third argument gives what to show instead)")
    return _out(out, "filter")


def _tidy(x: float) -> Any:
    """A computed step without binary noise: 0.1 * 3 is 0.3."""
    return clean_number(float(f"{x:.15g}"))


def _size(a: list[Any], i: int, name: str, what: str, default: Optional[float] = None) -> int:
    n = _x(a, i, name, default)
    if n == 0 and name in ("sequence", "randarray"):
        raise CalcError(f"{name}(): no {what} — the result is empty")
    if n < 1 or n != int(n):
        raise FusionError(f"{name}(): the number of {what} is a whole number of at least 1")
    return int(n)


def _sequence(a: list[Any]) -> Any:
    """sequence(rows, [columns], [start], [step]): numbers row by row."""
    _arity(a, 1, 4, "sequence")
    rows, cols = _size(a, 0, "sequence", "rows"), _size(a, 1, "sequence", "columns", 1)
    start, step = _x(a, 2, "sequence", 1), _x(a, 3, "sequence", 1)
    if rows * cols > MAX_SPILL:
        raise FusionError(f"sequence() makes at most {MAX_SPILL:,} values")
    return _out([[_tidy(start + (i * cols + j) * step) for j in range(cols)] for i in range(rows)], "sequence")


def _randarray(a: list[Any]) -> Any:
    """randarray([rows], [columns], [min], [max], [whole numbers]): random numbers."""
    _arity(a, 0, 5, "randarray")
    rows, cols = _size(a, 0, "randarray", "rows", 1), _size(a, 1, "randarray", "columns", 1)
    lo, hi, whole = _x(a, 2, "randarray", 0), _x(a, 3, "randarray", 1), _flag(a, 4, False)
    if rows * cols > MAX_SPILL:
        raise FusionError(f"randarray() makes at most {MAX_SPILL:,} values")
    if lo > hi:
        raise FusionError("randarray(): the minimum is above the maximum")
    if whole:
        lo_i, hi_i = math.ceil(lo), math.floor(hi)
        if lo_i > hi_i:
            raise FusionError("randarray(): no whole number lies between the minimum and the maximum")
        return _out([[_rand.randint(lo_i, hi_i) for _ in range(cols)] for _ in range(rows)], "randarray")
    return _out([[lo + _rand.random() * (hi - lo) for _ in range(cols)] for _ in range(rows)], "randarray")


def _cut(items: list[Any], n: Optional[int], drop: bool) -> list[Any]:
    if n is None:
        return items
    if drop:
        return items[n:] if n >= 0 else items[:max(0, len(items) + n)]
    return items[:n] if n >= 0 else items[n:]


def _take(a: list[Any], drop: bool, name: str) -> Any:
    """take / drop(array, rows, [columns]): the first rows (negative: the last) and columns — or all but those."""
    _arity(a, 2, 3, name)
    rows = _rows_of(a[0], name)
    r = int(_x(a, 1, name)) if _given(a, 1) else None
    c = int(_x(a, 2, name)) if _given(a, 2) else None
    out = [_cut(row, c, drop) for row in _cut(rows, r, drop)]
    return _out(out, name)


def _choose_lines(a: list[Any], cols: bool) -> Any:
    """choosecols / chooserows(array, number, …): the columns (rows) at those positions, negative from the end."""
    name = "choosecols" if cols else "chooserows"
    if len(a) < 2:
        raise FusionError(f"{name}(array, number, …)")
    rows = _rows_of(a[0], name)
    if cols:
        rows = _flip(rows)
    picks = [num(x) for x in flat(a[1:])]
    n = len(rows)
    if any(p is None or p != int(p) or not (1 <= abs(p) <= n) for p in picks):
        raise FusionError(f"{name}(): the positions are whole numbers from 1 to {n} (or -1 to -{n} from the end)")
    out = [rows[int(p) - 1 if p > 0 else n + int(p)] for p in picks]
    return _out(_flip(out) if cols else out, name)


def _stack(a: list[Any], vertical: bool) -> Any:
    """vstack / hstack(array, …): the arrays one below (beside) the other; shorter ones are padded with empty cells."""
    name = "vstack" if vertical else "hstack"
    if not a:
        raise FusionError(f"{name}(array, …)")
    grids = [_rows_of(v, name) for v in a]
    if not vertical:
        grids = [_flip(g) for g in grids]
    w = max(len(g[0]) for g in grids)
    out = [row + [_na_pad(name) for _ in range(w - len(row))] for g in grids for row in g]
    if len(out) * w > _MAX_INPUT:
        raise FusionError(f"{name}() gives at most {_MAX_INPUT:,} values")
    return _out(out if vertical else _flip(out), name)


def _to_line(a: list[Any], column: bool) -> Any:
    """tocol / torow(array, [ignore: 0 nothing, 1 empty cells, 2 errors, 3 both], [scan by column]): one column (row)."""
    name = "tocol" if column else "torow"
    _arity(a, 1, 3, name)
    ignore = _x(a, 1, name, 0)
    if ignore not in (0, 1, 2, 3):
        raise FusionError(f"{name}(): ignore is 0 (nothing), 1 (empty cells), 2 (errors) or 3 (both)")
    raw = _raw_rows(a[0])
    if _flag(a, 2, False):
        raw = _flip(raw)
    vals: list[Any] = []
    for x in (x for row in raw for x in row):
        try:
            v = _spilled_value(x)
        except _ERRORS as e:
            v = _error_value(e)
        if isinstance(v, dict) and v.get("__kind__") == "error":
            if ignore in (2, 3):
                continue
            plain(v)  # an error that is not ignored is the result's error
        if v in (None, "") and ignore in (1, 3):
            continue
        vals.append(plain(v))
    return _out([[v] for v in vals] if column else [vals], name)


def _wrap(a: list[Any], rows: bool) -> Any:
    """wraprows / wrapcols(row or column, count, [pad with]): the values in rows (columns) of count values."""
    name = "wraprows" if rows else "wrapcols"
    _arity(a, 2, 3, name)
    g = _rows_of(a[0], name)
    if len(g) > 1 and len(g[0]) > 1:
        raise FusionError(f"{name}(): the values are one row or one column")
    vals = [x for r in g for x in r]
    n = _size(a, 1, name, "values in a row" if rows else "values in a column")
    pad = plain(a[2]) if _given(a, 2) else _na_pad(name)
    chunks = [vals[i: i + n] for i in range(0, len(vals), n)]
    chunks[-1] = chunks[-1] + [pad] * (n - len(chunks[-1]))
    return _out(chunks if rows else _flip(chunks), name)


def _expand(a: list[Any]) -> Any:
    """expand(array, rows, [columns], [pad with]): the array made larger, the new cells padded."""
    _arity(a, 2, 4, "expand")
    g = _rows_of(a[0], "expand")
    h, w = len(g), len(g[0])
    r = int(_x(a, 1, "expand")) if _given(a, 1) else h
    c = int(_x(a, 2, "expand")) if _given(a, 2) else w
    if r < h or c < w:
        raise FusionError(f"expand(): the array has {h} rows and {w} columns; it can only grow")
    if r * c > MAX_SPILL:
        raise FusionError(f"expand() gives at most {MAX_SPILL:,} values")
    pad = plain(a[3]) if _given(a, 3) else _na_pad("expand")
    return _out([row + [pad] * (c - w) for row in g] + [[pad] * c for _ in range(r - h)], "expand")


def _xlookup(ev: Evaluator, a: list[Any]) -> Any:
    """xlookup(value, lookup array, return array, [if not found], [match mode], [search mode]). The lookup array is a
    row or a column; the result is the matching value of the return array — or its whole row (column) when the return
    array has several columns (rows), which spills."""
    _arity(a, 3, 6, "xlookup")
    if _is_grid(a[0]):
        raise FusionError("xlookup(): looks up one value")
    item = plain(_single(a[0]))
    look = _rows_of(a[1], "xlookup")
    if len(look) > 1 and len(look[0]) > 1:
        raise FusionError("xlookup(): the lookup array is one row or one column")
    vertical = len(look[0]) == 1
    keys = [r[0] for r in look] if vertical else look[0]
    mode = _x(a, 4, "xlookup", 0)
    search = _x(a, 5, "xlookup", 1)
    if mode not in (0, -1, 1, 2):
        raise FusionError("xlookup(): the match mode is 0 (exact), -1 (exact or next smaller), 1 (exact or next larger) or 2 (wildcard)")
    if search not in (1, -1, 2, -2):
        raise FusionError("xlookup(): the search mode is 1 (first to last), -1 (last to first), 2 or -2 (sorted)")
    order = list(range(len(keys)))
    if search < 0:
        order.reverse()
    if mode == 2:
        found = next((i for i in order if _crit(keys[i], item)), None)
    else:
        found = next((i for i in order if compare("==", keys[i], item)), None)
        if found is None and mode:
            near = _nearest(item, keys, -int(mode))
            found = near - 1 if near else None
    if found is None:
        if _given(a, 3):
            return a[3]
        raise NAError(f"xlookup: {to_text(item)} not found")
    ret = _rows_of(a[2], "xlookup")
    rh, rw = len(ret), len(ret[0])
    n = len(keys)
    if vertical and rh == n and n > 1:
        return _out([ret[found]], "xlookup")
    if not vertical and rw == n and n > 1:
        return _out([[r[found]] for r in ret], "xlookup")
    if (rh == 1 or rw == 1) and rh * rw == n:
        return ret[found][0] if rw == 1 else ret[0][found]
    raise FusionError(f"xlookup(): the return array needs {n} {'rows' if vertical else 'columns'}, like the lookup array")


def _textsplit(a: list[Any]) -> Any:
    """textsplit(text, column delimiter, [row delimiter], [ignore empty], [match mode: 1 ignores case], [pad with]):
    the parts in columns (and rows)."""
    _arity(a, 2, 6, "textsplit")
    text = to_text(plain(_single(a[0])))
    col_d = [to_text(d) for d in flat([a[1]]) if d not in (None, "")]
    row_d = [to_text(d) for d in flat([a[2]]) if d not in (None, "")] if _given(a, 2) else []
    if not col_d and not row_d:
        raise FusionError("textsplit(text, column delimiter, [row delimiter]): a delimiter is needed")
    ignore = _flag(a, 3, False)
    flags = _re.I if _x(a, 4, "textsplit", 0) == 1 else 0
    pad = plain(a[5]) if _given(a, 5) else _na_pad("textsplit")

    def split(s: str, ds: list[str]) -> list[str]:
        parts = _re.split("|".join(_re.escape(d) for d in sorted(ds, key=len, reverse=True)), s, flags=flags) if ds else [s]
        return [p for p in parts if p != ""] if ignore else parts

    rows = [split(line, col_d) for line in split(text, row_d)]
    rows = [r for r in rows if r]
    w = max((len(r) for r in rows), default=0)
    if not w:
        raise FusionError("textsplit(): the result is empty")
    if len(rows) * w > MAX_SPILL:
        raise FusionError(f"textsplit() gives at most {MAX_SPILL:,} values")
    return _out([r + [pad] * (w - len(r)) for r in rows], "textsplit")


def _column_of(d: dict, name: str) -> Any:
    """A one-cell array function's result as a column that spills (frequency, mode.mult)."""
    return _out([[x] for x in d["items"]], name)


def _index_spill(ev: Evaluator, a: list[Any]) -> Any:
    """index(range, 0, column) / index(range, row, 0): the whole column (row) spills."""
    v = _index_at(ev, a)
    if isinstance(v, dict) and v.get("__kind__") == "array" and isinstance(a[0], Range):
        # the same reading of the positions as _index_at: a single row takes index(row, column)
        rows = a[0].rows
        i = 1 if num(a[1]) is None else int(num(a[1]))
        if len(a) < 3 and len(rows) == 1 and len(rows[0]) > 1:
            i = 1
        items = v["items"]
        return _out([[x] for x in items] if i == 0 else [items], "index")
    return v


def _if(ev: Evaluator, a: list[Any]) -> Any:
    """if(condition, value, [otherwise]); a range or array as the condition gives a value per value (it spills)."""
    _arity(a, 2, 3, "if")
    cond = ev.eval(a[0])
    if _is_grid(cond):
        return _if_arrays(ev, cond, a)
    return ev.eval(a[1]) if truthy(_single(cond)) else (ev.eval(a[2]) if len(a) > 2 else None)


_mode_mult_items = FUNCS["mode.mult"]
_frequency_items = FUNCS["frequency"]
FUNCS.update({
    "sort": lambda ev, a: _sort(a),
    "sortby": lambda ev, a: _sortby(a),
    "unique": lambda ev, a: _unique(a),
    "filter": lambda ev, a: _filter(a),
    "sequence": lambda ev, a: _sequence(a),
    "randarray": lambda ev, a: _randarray(a),
    "take": lambda ev, a: _take(a, False, "take"),
    "drop": lambda ev, a: _take(a, True, "drop"),
    "choosecols": lambda ev, a: _choose_lines(a, True),
    "chooserows": lambda ev, a: _choose_lines(a, False),
    "vstack": lambda ev, a: _stack(a, True),
    "hstack": lambda ev, a: _stack(a, False),
    "tocol": lambda ev, a: _to_line(a, True),
    "torow": lambda ev, a: _to_line(a, False),
    "wraprows": lambda ev, a: _wrap(a, True),
    "wrapcols": lambda ev, a: _wrap(a, False),
    "expand": lambda ev, a: _expand(a),
    "xlookup": _xlookup,
    "textsplit": lambda ev, a: _textsplit(a),
    "frequency": lambda ev, a: _column_of(_frequency_items(ev, a), "frequency"),
    "mode.mult": lambda ev, a: _column_of(_mode_mult_items(ev, a), "mode.mult"),
    "index": _index_spill,
})
LAZY["if"] = _if


# lambda helpers: map, reduce, scan, byrow, bycol, makearray call a lambda value by value (row by row …)

def _invoke(ev: Evaluator, f: Any, args: list[Any], name: str) -> Any:
    """Call the lambda f with args, as lambda(…)(…) does."""
    if not (isinstance(f, dict) and f.get("__kind__") == "lambda"):
        raise FusionError(f"{name}(): the last argument is a lambda, like lambda(x, x * 2)")
    if len(args) != len(f["params"]):
        raise FusionError(f"{name}(): the lambda takes {len(args)} parameter(s), it has {len(f['params'])}")
    if ev.depth >= 50:
        raise FusionError("lambda calls are nested too deeply")
    saved = ev.env
    outer = frozenset(set(f["env"].get(OMITTED) or ()) - set(f["params"]))
    ev.env, ev.depth = {**f["env"], **dict(zip(f["params"], args)), OMITTED: outer}, ev.depth + 1
    try:
        return ev.eval(f["body"])
    finally:
        ev.env, ev.depth = saved, ev.depth - 1


def _lambda_arg(f: Any, name: str) -> None:
    """The lambda argument checked before any value is computed: without one the whole result is the error."""
    if not (isinstance(f, dict) and f.get("__kind__") == "lambda"):
        raise FusionError(f"{name}(): the last argument is a lambda, like lambda(x, x * 2)")


def _one_value(v: Any, name: str) -> Any:
    """A lambda's result where one value is expected (map, byrow …): several values are an error (#CALC! in Excel)."""
    v = _single(v)
    if _is_grid(v):
        raise CalcError(f"{name}(): the lambda gives several values where one is expected")
    return v


def _each(ev: Evaluator, f: Any, args: list[Any], name: str) -> Any:
    """One value of map / byrow / bycol / makearray; an error is that value's error only."""
    try:
        return _one_value(_invoke(ev, f, args, name), name)
    except _ERRORS as e:
        return _error_value(e)


def _map(ev: Evaluator, a: list[Any]) -> Any:
    """map(array, [array …], lambda(x, [y …], …)): the lambda applied to every value (to the values at the same place of
    several arrays of the same size)."""
    if len(a) < 2:
        raise FusionError("map(array, …, lambda(x, …))")
    _lambda_arg(a[-1], "map")
    grids = [_raw_rows(v) for v in a[:-1]]
    h, w = len(grids[0]), len(grids[0][0])
    if any(len(g) != h or len(g[0]) != w for g in grids):
        raise FusionError("map(): the arrays are all of the same size")
    if h * w > _MAX_INPUT:
        raise FusionError(f"map() reads at most {_MAX_INPUT:,} values")
    out = []
    for i in range(h):
        row = []
        for j in range(w):
            try:
                xs = [plain(g[i][j]) for g in grids]
            except _ERRORS as e:
                row.append(_error_value(e))
                continue
            row.append(_each(ev, a[-1], xs, "map"))
        out.append(row)
    return _out(out, "map")


def _accumulate(ev: Evaluator, a: list[Any], name: str) -> tuple[list[list[Any]], Any]:
    """reduce / scan([initial value], array, lambda(accumulator, value)): (the accumulator after each value in the
    array's shape, the last one)."""
    _arity(a, 2, 3, name)
    init, arr, f = (None, a[0], a[1]) if len(a) == 2 else (a[0], a[1], a[2])
    _lambda_arg(f, name)
    # a left-out initial value is 0, as in Excel: reduce(, A1:A3, lambda(a, v, a + v))
    acc = init if _is_grid(init) else 0 if init is None else plain(_single(init))
    rows = _rows_of(arr, name)
    steps = []
    for row in rows:
        line = []
        for x in row:
            acc = _invoke(ev, f, [acc, x], name)
            acc = _single(acc)
            line.append(acc)
        steps.append(line)
    return steps, acc


def _reduce(ev: Evaluator, a: list[Any]) -> Any:
    """reduce([initial value], array, lambda(accumulator, value)): the accumulator after the last value (it may be an
    array: reduce(, A1:A3, lambda(t, v, vstack(t, v))))."""
    return _accumulate(ev, a, "reduce")[1]


def _scan(ev: Evaluator, a: list[Any]) -> Any:
    """scan([initial value], array, lambda(accumulator, value)): every step of the accumulator, in the array's shape."""
    steps, _ = _accumulate(ev, a, "scan")
    return _out([[_one_value(x, "scan") for x in row] for row in steps], "scan")


def _by_line(ev: Evaluator, a: list[Any], rows: bool) -> Any:
    """byrow / bycol(array, lambda(row)): one value per row (a column) or per column (a row)."""
    name = "byrow" if rows else "bycol"
    _arity(a, 2, 2, name)
    _lambda_arg(a[1], name)
    g = _raw_rows(a[0])
    lines = g if rows else _flip(g)
    vals = [_each(ev, a[1], [Matrix([list(line)] if rows else [[x] for x in line])], name) for line in lines]
    return _out([[v] for v in vals] if rows else [vals], name)


def _makearray(ev: Evaluator, a: list[Any]) -> Any:
    """makearray(rows, columns, lambda(row, column)): an array of the lambda's values, rows and columns from 1."""
    _arity(a, 3, 3, "makearray")
    _lambda_arg(a[2], "makearray")
    h, w = _size(a, 0, "makearray", "rows"), _size(a, 1, "makearray", "columns")
    if h * w > MAX_SPILL:
        raise FusionError(f"makearray() makes at most {MAX_SPILL:,} values")
    return _out([[_each(ev, a[2], [i + 1, j + 1], "makearray") for j in range(w)] for i in range(h)], "makearray")


FUNCS.update({
    "map": _map,
    "reduce": _reduce,
    "scan": _scan,
    "byrow": lambda ev, a: _by_line(ev, a, True),
    "bycol": lambda ev, a: _by_line(ev, a, False),
    "makearray": _makearray,
})
DYNAMIC = DYNAMIC | {"map", "scan", "byrow", "bycol", "makearray"}


# ------------------------------------------------------------------ controls: checkbox, datepicker

_PRECISIONS = ("NONE", "MINUTE", "SECOND")


def date_value(v: Any, precision: str = "NONE") -> Optional[str]:
    """A datepicker's value: yyyy-MM-dd, with HH:mm:ss when the precision is MINUTE or SECOND; None when empty."""
    if v is None or v == "":
        return None
    s = to_text(v).strip().replace("T", " ")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?", s):
        raise FusionError(f"{s} is not a date: yyyy-MM-dd, optionally with HH:mm:ss")
    try:
        d = dt.datetime.fromisoformat(s)
    except ValueError:
        raise FusionError(f"{s} is not a date") from None
    if precision == "NONE":
        return d.date().isoformat()
    return (d.replace(second=0) if precision == "MINUTE" else d).isoformat(sep=" ")


def _control_value(v: dict, selected: Any) -> Any:
    """What the user set on a control that is not bound to another cell (kept as the cell's selection)."""
    if v["__kind__"] == "checkbox":
        return selected if isinstance(selected, bool) else v.get("value")
    try:
        return date_value(selected, v.get("precision") or "NONE")
    except FusionError:
        return v.get("value")


def _bound(ev: Evaluator, n: Any) -> Optional[dict]:
    """The cell a control writes to: the one its first argument refers to."""
    return {"sheet": ev.sheet_named(n[1])["id"], "cell": n[2]} if n[0] == "ref" else None


def _checkbox(ev: Evaluator, a: list[Any]) -> dict:
    """checkbox([checked], [label]): true when checked. checkbox(B1) is bound to B1 — a click writes true / false
    there; otherwise the click is kept with the checkbox's own cell."""
    _arity(a, 0, 2, "checkbox")
    return {"__kind__": "checkbox", "value": truthy(ev.scalar(a[0])) if a else False,
            "label": to_text(plain(ev.scalar(a[1]))) if len(a) > 1 else "", "bound": _bound(ev, a[0]) if a else None}


def _datepicker(ev: Evaluator, a: list[Any]) -> dict:
    """datepicker([selected date], [time precision: 'NONE', 'MINUTE' or 'SECOND']): the selected date."""
    _arity(a, 0, 2, "datepicker")
    precision = to_text(plain(ev.scalar(a[1]))).strip().upper() if len(a) > 1 else "NONE"
    if precision not in _PRECISIONS:
        raise FusionError("datepicker(): the time precision is 'NONE', 'MINUTE' or 'SECOND'")
    return {"__kind__": "datepicker", "value": date_value(plain(ev.scalar(a[0])), precision) if a else None, "precision": precision,
            "bound": _bound(ev, a[0]) if a else None}


# ------------------------------------------------------------------ actions that happen in the browser


def safe_url(url: Any) -> str:
    """An address action.open_url may open: absolute http or https, nothing else (no javascript:, data:, file: …)."""
    u = to_text(plain(url)).strip()
    if not u or len(u) > 2000 or re.search(r"[\s\x00-\x1f\x7f\\]", u):
        raise FusionError("action.open_url() takes an http or https address")
    try:
        parts = _up.urlsplit(u)
        host = parts.hostname
    except ValueError:
        raise FusionError("action.open_url() takes an http or https address") from None
    if parts.scheme.lower() not in ("http", "https") or not host:
        raise FusionError("action.open_url() opens http and https addresses only")
    return u


def _open_url(ev: Evaluator, a: list[Any]) -> dict:
    """action.open_url(url, [redirect]): a new tab, or this page when redirect is true."""
    _arity(a, 1, 2, "action.open_url")
    return _action("open_url", url=safe_url(ev.scalar(a[0])), redirect=truthy(ev.scalar(a[1])) if len(a) > 1 else False)


def _open_markdown_panel(ev: Evaluator, a: list[Any]) -> dict:
    """action.open_markdown_panel(panel title, markdown content): a side panel showing the Markdown."""
    _arity(a, 2, 2, "action.open_markdown_panel")
    title, text = (to_text(plain(ev.scalar(x))) for x in a)
    if len(text) > 100_000:
        raise FusionError("action.open_markdown_panel(): the Markdown is longer than 100,000 characters")
    return _action("open_markdown_panel", title=title[:200], markdown=text)


LAZY.update({
    "checkbox": _checkbox,
    "datepicker": _datepicker,
    "action.open_url": _open_url,
    "action.open_markdown_panel": _open_markdown_panel,
})


# ------------------------------------------------------------------ charts (chart.*)

_CHART_OPTIONS: dict[str, dict[str, Any]] = {
    "bar": {"drawLabels": bool, "orientation": ("horizontal", "vertical")},
    "line": {"dataMarkers": bool, "color": str},
    "chart": {"showAxes": bool, "showLegend": bool, "showResetZoomButton": bool, "showToolbar": bool, "tooltip": (False, "closest", "aggregate"),
              "yAxisInset": bool, "rangeSelection": ("select", "visual", False), "height": int, "width": int},
}
_COLOR = re.compile(r"#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,30}|rgba?\([0-9., %]{1,40}\)")


def _chart_options(ev: Evaluator, a: list[Any]) -> dict:
    """chart.options(key, value, …)."""
    if len(a) % 2:
        raise FusionError("chart.options(key, value, …): options come in pairs")
    return {"__kind__": "chart_options", "options": {to_text(plain(a[i])): plain(a[i + 1]) for i in range(0, len(a), 2)}}


def _options_for(kind: str, given: list[Any]) -> dict:
    """The options a plot or chart takes, checked: unknown keys and wrong values are errors."""
    spec = _CHART_OPTIONS[kind]
    names = {k.lower(): k for k in spec}
    out: dict[str, Any] = {}
    for g in given:
        if not (isinstance(g, dict) and g.get("__kind__") == "chart_options"):
            raise FusionError(f"chart.{kind}(): options are given with chart.options(key, value, …)")
        for key, val in g["options"].items():
            k = names.get(key.strip().lower())
            if not k:
                raise FusionError(f"chart.{kind}() has no option {key}; it takes {', '.join(spec)}")
            want = spec[k]
            low = val.strip().lower() if isinstance(val, str) else val
            if low in ("true", "false"):
                low = low == "true"
            if want is bool:
                if not isinstance(low, bool):
                    raise FusionError(f"chart.{kind}(): {k} is true or false")
                out[k] = low
            elif want is int:
                n = num(val)
                if isinstance(val, bool) or n is None or not 20 <= n <= 2000:
                    raise FusionError(f"chart.{kind}(): {k} is a number of pixels from 20 to 2000")
                out[k] = int(n)
            elif want is str:
                if not isinstance(val, str) or not _COLOR.fullmatch(val.strip()):
                    raise FusionError(f"chart.{kind}(): {k} is a color like '#2563eb' or 'red'")
                out[k] = val.strip()
            else:
                if not any(low == w and type(low) is type(w) for w in want):
                    raise FusionError(f"chart.{kind}(): {k} is one of {', '.join(to_text(w) if isinstance(w, bool) else repr(w) for w in want)}")
                out[k] = low
    return out


def _one_dimension(v: Any, name: str, what: str) -> list[Any]:
    if isinstance(v, Range):
        if len(v.rows) > 1 and v.rows and len(v.rows[0]) > 1:
            raise FusionError(f"{name}(): the {what} are a one-dimensional range (one row or one column)")
        vals = [plain(x) for x in v.flat()]
    else:
        p = plain(v)
        vals = [plain(x) for x in p] if isinstance(p, list) else [p]
    if len(vals) > MAX_LOOKUP:
        raise FusionError(f"{name}() plots at most {MAX_LOOKUP:,} points")
    return vals


def _x_axis(xs: list[Any]) -> tuple[str, Optional[list[Any]]]:
    """How the x values are laid out: numbers on a number axis, dates on a time axis (milliseconds), anything else as
    categories in the order given."""
    present = [v for v in xs if v not in (None, "")]
    if present and len(present) == len(xs):
        if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in present):
            return "number", [float(v) for v in xs]
        if all(isinstance(v, str) and re.match(r"\d{4}-\d{2}-\d{2}", v.strip()) for v in present):
            try:
                return "date", [_ms_of(v) for v in xs]
            except FusionError:
                pass
    return "category", None


def _plot(kind: str, a: list[Any]) -> dict:
    """chart.bar / chart.line(x values, y values, [options …]): one series, as a chart of its own."""
    name = f"chart.{kind}"
    if len(a) < 2:
        raise FusionError(f"{name}(x values, y values, [chart.options(…)])")
    xs, ys = _one_dimension(a[0], name, "x values"), _one_dimension(a[1], name, "y values")
    if len(xs) != len(ys):
        raise FusionError(f"{name}(): {len(xs)} x values and {len(ys)} y values — they must be as many")
    y = [None if isinstance(v, bool) else num(v) for v in ys]
    if not any(v is not None for v in y):
        raise FusionError(f"{name}(): the y values hold no number")
    x_kind, x_num = _x_axis(xs)
    plot = {"type": kind, "x": [None if v is None else v if isinstance(v, (int, float)) and not isinstance(v, bool) else to_text(v) for v in xs],
            "y": [None if v is None else clean_number(v) for v in y], "x_kind": x_kind, "x_num": x_num, "options": _options_for(kind, a[2:])}
    return {"__kind__": "chart", "plots": [plot], "options": {}}


def _chart(ev: Evaluator, a: list[Any]) -> dict:
    """chart.chart(plots or options …): several series on one chart, with the chart's options."""
    plots: list[dict] = []
    given: list[Any] = []
    for v in a:
        if isinstance(v, dict) and v.get("__kind__") == "chart":
            plots.extend(v.get("plots") or [])
        elif isinstance(v, dict) and v.get("__kind__") == "chart_options":
            given.append(v)
        else:
            raise FusionError("chart.chart() takes plots (chart.bar, chart.line) and chart.options(…)")
    if not plots:
        raise FusionError("chart.chart() needs at least one plot: chart.bar(…) or chart.line(…)")
    if len(plots) > 20:
        raise FusionError("chart.chart() shows at most 20 plots")
    return {"__kind__": "chart", "plots": plots, "options": _options_for("chart", given)}


FUNCS.update({
    "chart.bar": lambda ev, a: _plot("bar", a),
    "chart.line": lambda ev, a: _plot("line", a),
    "chart.chart": _chart,
    "chart.options": _chart_options,
})

# ------------------------------------------------------------------ complex numbers (complex, im…)
# A complex number is text, as in spreadsheets: '3+4i', '-2.5j', 'i', '7' (a number is one too). Results keep the
# suffix of the arguments (i, or j when they use j); i and j mixed is an error.

import cmath as _cm  # noqa: E402

_CNUM = r"(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"
_CREAL = re.compile(rf"[+-]?{_CNUM}")


def _cparse(v: Any, name: str) -> tuple[complex, str]:
    """A complex argument: (value, its suffix: 'i', 'j' or '' when it has no imaginary part written)."""
    v = plain(_single(v))
    if isinstance(v, bool):
        raise FusionError(f"{name}(): {v} is not a complex number")
    if v is None or v == "":
        return complex(0, 0), ""
    if isinstance(v, (int, float)):
        return complex(float(v), 0), ""
    s = str(v).strip()
    bad = FusionError(f"{name}(): {s!r} is not a complex number like '3+4i'")
    if not s:
        return complex(0, 0), ""
    if s[-1] in "ij":
        suffix, body = s[-1], s[:-1]
        k = next((k for k in range(len(body) - 1, 0, -1) if body[k] in "+-" and body[k - 1] not in "eE"), 0)
        re_part, im_part = body[:k], body[k:]
        if re_part and not _CREAL.fullmatch(re_part):
            raise bad
        if im_part in ("", "+", "-"):
            im = -1.0 if im_part == "-" else 1.0
        elif _CREAL.fullmatch(im_part):
            im = float(im_part)
        else:
            raise bad
        return complex(float(re_part) if re_part else 0.0, im), suffix
    if not _CREAL.fullmatch(s):
        raise bad
    return complex(float(s), 0), ""


def _csuffix(suffixes: list[str], name: str) -> str:
    given = {s for s in suffixes if s}
    if len(given) > 1:
        raise FusionError(f"{name}(): the arguments mix the suffixes i and j")
    return given.pop() if given else "i"


def _cnumber(x: float) -> str:
    """A part of a complex result: 15 significant digits, as a spreadsheet shows it."""
    if x == 0 or not math.isfinite(x):
        if not math.isfinite(x):
            raise FusionError("the result is too large")
        return "0"
    return ("%.15g" % x).replace("e", "E")


def _cformat(z: complex, suffix: str = "i") -> str:
    re_s = _cnumber(z.real)
    im_s = _cnumber(z.imag)
    if im_s == "0":
        return re_s
    im_s = suffix if im_s == "1" else "-" + suffix if im_s == "-1" else im_s + suffix
    if re_s == "0":
        return im_s
    return re_s + (im_s if im_s.startswith("-") else "+" + im_s)


def _complex(a: list[Any]) -> str:
    """complex(real, imaginary, [suffix 'i' or 'j'])."""
    _arity(a, 2, 3, "complex")
    suffix = "i" if len(a) < 3 or plain(a[2]) in (None, "") else to_text(plain(a[2]))
    if suffix not in ("i", "j"):
        raise FusionError("complex(): the suffix is 'i' or 'j' (lower case)")
    return _cformat(complex(_x(a, 0, "complex"), _x(a, 1, "complex")), suffix)


def _cdiv(z: complex, w: complex, name: str) -> complex:
    d = w.real * w.real + w.imag * w.imag
    if d == 0:
        raise FusionError(f"{name}(): division by 0")
    return complex((z.real * w.real + z.imag * w.imag) / d, (z.imag * w.real - z.real * w.imag) / d)


def _cpow(z: complex, n: float, name: str) -> complex:
    """z ** n in polar form, as spreadsheets compute it: r^n (cos nθ + i sin nθ)."""
    if z == 0:
        if n > 0:
            return complex(0, 0)
        raise FusionError(f"{name}(): 0 to a power of 0 or less")
    r, t = abs(z), math.atan2(z.imag, z.real)
    m = r ** n
    return complex(m * math.cos(n * t), m * math.sin(n * t))


def _cone(fn: Callable[[complex], complex], name: str, zero_ok: bool = True) -> Callable[["Evaluator", list[Any]], Any]:
    def run(ev: "Evaluator", a: list[Any]) -> str:
        _arity(a, 1, 1, name)
        z, s = _cparse(a[0], name)
        if not zero_ok and z == 0:
            raise FusionError(f"{name}() of 0 is not defined")
        try:
            w = fn(z)
        except (ValueError, ZeroDivisionError, OverflowError):
            raise FusionError(f"{name}(): no result for {_cformat(z, s or 'i')}") from None
        return _cformat(w, s or "i")
    return run


def _cmany(a: list[Any], name: str) -> tuple[list[complex], str]:
    vals: list[tuple[complex, str]] = []
    for x in a:
        if isinstance(x, Range):
            vals.extend(_cparse(v, name) for v in x.flat() if plain(v) not in (None, ""))
        else:
            p = plain(x)
            items = p if isinstance(p, list) else [x]
            vals.extend(_cparse(v, name) for v in items)
    if not vals:
        raise FusionError(f"{name}() needs at least one complex number")
    return [z for z, _ in vals], _csuffix([s for _, s in vals], name)


def _imsum(a: list[Any]) -> str:
    zs, s = _cmany(a, "imsum")
    return _cformat(complex(math.fsum(z.real for z in zs), math.fsum(z.imag for z in zs)), s)


def _improduct(a: list[Any]) -> str:
    zs, s = _cmany(a, "improduct")
    out = zs[0]
    for z in zs[1:]:
        out = complex(out.real * z.real - out.imag * z.imag, out.real * z.imag + out.imag * z.real)
    return _cformat(out, s)


def _imtwo(a: list[Any], name: str) -> tuple[complex, complex, str]:
    _arity(a, 2, 2, name)
    (z, s1), (w, s2) = _cparse(a[0], name), _cparse(a[1], name)
    return z, w, _csuffix([s1, s2], name)


def _impower(a: list[Any]) -> str:
    _arity(a, 2, 2, "impower")
    z, s = _cparse(a[0], "impower")
    return _cformat(_cpow(z, _x(a, 1, "impower"), "impower"), s or "i")


def _cln(z: complex) -> complex:
    if z == 0:
        raise ValueError
    return complex(math.log(abs(z)), math.atan2(z.imag, z.real))


def _imsqrt(z: complex) -> complex:
    return _cpow(z, 0.5, "imsqrt") if z != 0 else complex(0, 0)


def _cpart(a: list[Any], name: str, part: Callable[[complex], float]) -> Any:
    _arity(a, 1, 1, name)
    return clean_number(part(_cparse(a[0], name)[0]))


def _imargument(a: list[Any]) -> Any:
    _arity(a, 1, 1, "imargument")
    z = _cparse(a[0], "imargument")[0]
    if z == 0:
        raise ZeroDivisionError("imargument() of 0 is not defined")
    return math.atan2(z.imag, z.real)


FUNCS.update({
    "complex": lambda ev, a: _complex(a),
    "imreal": lambda ev, a: _cpart(a, "imreal", lambda z: z.real),
    "imaginary": lambda ev, a: _cpart(a, "imaginary", lambda z: z.imag),
    "imabs": lambda ev, a: _cpart(a, "imabs", lambda z: math.hypot(z.real, z.imag)),
    "imargument": lambda ev, a: _imargument(a),
    "imconjugate": _cone(lambda z: z.conjugate(), "imconjugate"),
    "imsum": lambda ev, a: _imsum(a),
    "imsub": lambda ev, a: (lambda z, w, s: _cformat(z - w, s))(*_imtwo(a, "imsub")),
    "improduct": lambda ev, a: _improduct(a),
    "imdiv": lambda ev, a: (lambda z, w, s: _cformat(_cdiv(z, w, "imdiv"), s))(*_imtwo(a, "imdiv")),
    "impower": lambda ev, a: _impower(a),
    "imsqrt": _cone(_imsqrt, "imsqrt"),
    "imexp": _cone(_cm.exp, "imexp"),
    "imln": _cone(_cln, "imln", zero_ok=False),
    "imlog10": _cone(lambda z: _cln(z) / math.log(10), "imlog10", zero_ok=False),
    "imlog2": _cone(lambda z: _cln(z) / math.log(2), "imlog2", zero_ok=False),
    "imsin": _cone(_cm.sin, "imsin"),
    "imcos": _cone(_cm.cos, "imcos"),
    "imtan": _cone(_cm.tan, "imtan"),
    "imsinh": _cone(_cm.sinh, "imsinh"),
    "imcosh": _cone(_cm.cosh, "imcosh"),
    "imsec": _cone(lambda z: 1 / _cm.cos(z), "imsec"),
    "imsech": _cone(lambda z: 1 / _cm.cosh(z), "imsech"),
    "imcsc": _cone(lambda z: 1 / _cm.sin(z), "imcsc", zero_ok=False),
    "imcsch": _cone(lambda z: 1 / _cm.sinh(z), "imcsch", zero_ok=False),
    "imcot": _cone(lambda z: 1 / _cm.tan(z), "imcot", zero_ok=False),
})


# ------------------------------------------------------------------ Bessel functions (integer order)


def _bessel_args(a: list[Any], name: str) -> tuple[float, int]:
    _arity(a, 2, 2, name)
    x, n = _x(a, 0, name), _x(a, 1, name)
    n = int(n)  # the order is truncated, as in spreadsheets
    if abs(x) > 100_000:
        raise FusionError(f"{name}(): x is at most 100,000 in size")
    if n < 0:
        raise FusionError(f"{name}(): the order n is 0 or more")
    return x, n


def _miller_j(x: float, n: int) -> list[float]:
    """J_0(x) … J_m(x) for x > 0 by Miller's backward recurrence, normalised with J0 + 2 (J2 + J4 + …) = 1;
    m is past n and the terms the normalisation needs."""
    top = max(n, int(x)) + 30 + int(math.sqrt(60 * max(n, x, 1.0)))
    top += top % 2
    vals = [0.0] * (top + 2)
    vals[top] = 1e-300
    for k in range(top, 0, -1):
        vals[k - 1] = 2 * k / x * vals[k] - vals[k + 1]
        if abs(vals[k - 1]) > 1e250:
            for i in range(k - 1, top + 1):
                vals[i] *= 1e-250
    norm = vals[0] + 2 * math.fsum(vals[2:top + 1:2])
    return [v / norm for v in vals]


def _besselj(x: float, n: int) -> float:
    if x == 0:
        return 1.0 if n == 0 else 0.0
    j = _miller_j(abs(x), n)[n]
    return -j if x < 0 and n % 2 else j


def _bessely(x: float, n: int) -> float:
    if x <= 0:
        raise FusionError("bessely(): x is greater than 0")
    j = _miller_j(x, n + 1)
    lg = math.log(x / 2) + 0.5772156649015329
    m = len(j) - 3
    # Neumann series: Y0 = 2/π [(ln(x/2) + γ) J0 + 2 Σ (-1)^(k+1) J_2k / k]; Y1 = -Y0'
    y0 = 2 / math.pi * (lg * j[0] + 2 * math.fsum((-1) ** (k + 1) * j[2 * k] / k for k in range(1, m // 2)))
    y1 = -2 / math.pi * (j[0] / x - lg * j[1] + math.fsum((-1) ** (k + 1) * (j[2 * k - 1] - j[2 * k + 1]) / k for k in range(1, m // 2)))
    if n == 0:
        return y0
    for k in range(1, n):
        y0, y1 = y1, 2 * k / x * y1 - y0
    return y1


def _besseli(x: float, n: int) -> float:
    if abs(x) > 700:
        raise FusionError("besseli(): x is too large")
    h = abs(x) / 2
    term = h ** n / math.factorial(n) if n < 170 else math.exp(n * math.log(h) - math.lgamma(n + 1)) if h else 0.0
    total, k = 0.0, 0
    while True:
        total += term
        k += 1
        term *= h * h / (k * (k + n))
        if term < 1e-17 * total or term == 0:
            break
    return -total if x < 0 and n % 2 else total


def _bessel_k01(x: float) -> tuple[float, float]:
    """K0(x) and K1(x) from ∫0^∞ exp(-x cosh t) cosh(νt) dt by the trapezoid rule (the integrand is smooth and dies
    off fast, so the rule converges quickly)."""
    h = 0.02
    k0 = k1 = 0.0
    t = 0.0
    while True:
        e = math.exp(-x * math.cosh(t))
        w = 0.5 if t == 0 else 1.0
        k0 += w * e
        k1 += w * e * math.cosh(t)
        if x * math.cosh(t) - t > 745:
            break
        t += h
    return k0 * h, k1 * h


def _besselk(x: float, n: int) -> float:
    if x <= 0:
        raise FusionError("besselk(): x is greater than 0")
    k0, k1 = _bessel_k01(x)
    if n == 0:
        return k0
    for k in range(1, n):
        k0, k1 = k1, k0 + 2 * k / x * k1
    return k1


FUNCS.update({
    "besselj": lambda ev, a: _besselj(*_bessel_args(a, "besselj")),
    "bessely": lambda ev, a: _bessely(*_bessel_args(a, "bessely")),
    "besseli": lambda ev, a: _besseli(*_bessel_args(a, "besseli")),
    "besselk": lambda ev, a: _besselk(*_bessel_args(a, "besselk")),
})


# ------------------------------------------------------------------ bonds and securities
# Day-count bases as in spreadsheets: 0 US (NASD) 30/360, 1 actual/actual, 2 actual/360, 3 actual/365,
# 4 European 30/360. Coupons fall every 12 / frequency months counted back from maturity (month ends when maturity is
# a month end).


def _basis(a: list[Any], i: int, name: str) -> int:
    b = int(_x(a, i, name, 0.0))
    if b not in (0, 1, 2, 3, 4):
        raise FusionError(f"{name}(): the basis is 0 to 4")
    return b


def _coupon_freq(a: list[Any], i: int, name: str) -> int:
    f = int(_x(a, i, name))
    if f not in (1, 2, 4):
        raise FusionError(f"{name}(): the frequency is 1 (annual), 2 (semiannual) or 4 (quarterly)")
    return f


def _last_of_month(d: dt.date) -> bool:
    return d.day == _cal.monthrange(d.year, d.month)[1]


def _days360x(d0: dt.date, d1: dt.date, us: bool) -> int:
    """30/360 days: US (NASD, with the end-of-February rule) or European."""
    a, b, m1, y1, m2, y2 = d0.day, d1.day, d0.month, d0.year, d1.month, d1.year
    if a == 31:
        a = 30
    elif us and m1 == 2 and _last_of_month(d0):
        a = 30
    if b == 31:
        if us and a != 30:
            b = 1
            m2, y2 = (1, y2 + 1) if m2 == 12 else (m2 + 1, y2)
        else:
            b = 30
    return (y2 - y1) * 360 + (m2 - m1) * 30 + (b - a)


def _daycount(d0: dt.date, d1: dt.date, basis: int) -> int:
    if basis == 0:
        return _days360x(d0, d1, True)
    if basis == 4:
        return _days360x(d0, d1, False)
    return (d1 - d0).days


def _yearfrac_b(d0: dt.date, d1: dt.date, basis: int) -> float:
    """The fraction of a year from d0 to d1 (d0 <= d1) by the basis, as spreadsheets count it."""
    if basis == 0:
        a, b = d0.day, d1.day
        if a == 31 and b == 31:
            a = b = 30
        elif a == 31:
            a = 30
        elif a == 30 and b == 31:
            b = 30
        elif d0.month == 2 and d1.month == 2 and _last_of_month(d0) and _last_of_month(d1):
            a = b = 30
        elif d0.month == 2 and _last_of_month(d0):
            a = 30
        return ((d1.year - d0.year) * 360 + (d1.month - d0.month) * 30 + (b - a)) / 360
    if basis == 4:
        return _days360x(d0, d1, False) / 360
    days = (d1 - d0).days
    if basis == 2:
        return days / 360
    if basis == 3:
        return days / 365
    within_year = d0.year == d1.year or (d1.year == d0.year + 1 and (d0.month, d0.day) >= (d1.month, d1.day))
    if within_year:
        if d0.year == d1.year:
            length = 366 if _cal.isleap(d0.year) else 365
        else:
            leap_day = any(_cal.isleap(y) and d0 <= dt.date(y, 2, 29) <= d1 for y in (d0.year, d1.year))
            length = 366 if leap_day else 365
        return days / length
    years = range(d0.year, d1.year + 1)
    return days / (sum(366 if _cal.isleap(y) else 365 for y in years) / len(years))


def _year_days(basis: int) -> int:
    return 365 if basis == 3 else 360


def _months_back(mat: dt.date, months: int) -> dt.date:
    """maturity moved back by months: a month end stays a month end."""
    d = _add_months(mat, -months)
    return d.replace(day=_cal.monthrange(d.year, d.month)[1]) if _last_of_month(mat) else d


def _coupons(settle: dt.date, mat: dt.date, freq: int, name: str) -> tuple[dt.date, dt.date, int]:
    """(previous coupon date on or before settlement, next coupon date after it, coupons from settlement to maturity)."""
    if settle >= mat:
        raise FusionError(f"{name}(): settlement is before maturity")
    step = 12 // freq
    k = 1
    while _months_back(mat, k * step) > settle:
        k += 1
    return _months_back(mat, k * step), _months_back(mat, (k - 1) * step), k


def _coupon_args(a: list[Any], name: str) -> tuple[dt.date, dt.date, int, int]:
    _arity(a, 3, 4, name)
    return _date(a[0]), _date(a[1]), _coupon_freq(a, 2, name), _basis(a, 3, name)


def _period_days(pcd: dt.date, ncd: dt.date, freq: int, basis: int) -> float:
    """Days in the coupon period from pcd to ncd."""
    if basis == 1:
        return (ncd - pcd).days
    return (365 if basis == 3 else 360) / freq


def _coup(settle: dt.date, mat: dt.date, freq: int, basis: int, name: str) -> dict:
    pcd, ncd, n = _coupons(settle, mat, freq, name)
    e = _period_days(pcd, ncd, freq, basis)
    a = _daycount(pcd, settle, basis)
    dsc = e - a if basis in (0, 4) else (ncd - settle).days
    return {"pcd": pcd, "ncd": ncd, "n": n, "e": e, "a": a, "dsc": dsc}


def _coupfn(key: str, name: str) -> Callable[["Evaluator", list[Any]], Any]:
    def run(ev: "Evaluator", a: list[Any]) -> Any:
        c = _coup(*_coupon_args(a, name), name)
        v = c[key]
        return v.isoformat() if isinstance(v, dt.date) else clean_number(float(v))
    return run


def _price(c: dict, rate: float, yld: float, red: float, freq: int) -> float:
    coupon = 100 * rate / freq
    n, e, a, dsc = c["n"], c["e"], c["a"], c["dsc"]
    if n == 1:
        return (red + coupon) / (1 + dsc / e * yld / freq) - coupon * a / e
    base = 1 + yld / freq
    return (red / base ** (n - 1 + dsc / e) + math.fsum(coupon / base ** (k - 1 + dsc / e) for k in range(1, n + 1))
            - coupon * a / e)


def _bond_args(a: list[Any], name: str, lo: int = 6) -> tuple:
    _arity(a, lo, lo + 1, name)
    settle, mat = _date(a[0]), _date(a[1])
    freq, basis = _coupon_freq(a, lo - 1, name), _basis(a, lo, name)
    return settle, mat, freq, basis


def _price_fn(a: list[Any]) -> Any:
    """price(settlement, maturity, rate, yld, redemption, frequency, [basis]): price per 100 face value."""
    settle, mat, freq, basis = _bond_args(a, "price", 6)
    rate, yld, red = _x(a, 2, "price"), _x(a, 3, "price"), _x(a, 4, "price")
    if rate < 0 or yld < 0 or red <= 0:
        raise FusionError("price(): rate and yield are 0 or more, redemption more than 0")
    return _price(_coup(settle, mat, freq, basis, "price"), rate, yld, red, freq)


def _root(f: Callable[[float], float], lo: float, hi: float, name: str) -> float:
    """f's root between lo and hi (f decreasing), by bisection then secant steps."""
    flo, fhi = f(lo), f(hi)
    while flo * fhi > 0 and hi < 1e4:
        hi *= 2
        fhi = f(hi)
    if flo * fhi > 0:
        raise FusionError(f"{name}(): no result")
    for _ in range(300):
        mid = (lo + hi) / 2
        fm = f(mid)
        if fm == 0 or hi - lo < 1e-15:
            return mid
        if fm * flo > 0:
            lo, flo = mid, fm
        else:
            hi = mid
    return (lo + hi) / 2


def _yield_fn(a: list[Any]) -> Any:
    """yield(settlement, maturity, rate, pr, redemption, frequency, [basis])."""
    settle, mat, freq, basis = _bond_args(a, "yield", 6)
    rate, pr, red = _x(a, 2, "yield"), _x(a, 3, "yield"), _x(a, 4, "yield")
    if rate < 0 or pr <= 0 or red <= 0:
        raise FusionError("yield(): rate is 0 or more, price and redemption more than 0")
    c = _coup(settle, mat, freq, basis, "yield")
    if c["n"] == 1:
        e, a_, dsr = c["e"], c["a"], c["dsc"]  # days from settlement to redemption
        paid = pr / 100 + a_ / e * rate / freq
        return (red / 100 + rate / freq - paid) / paid * freq * e / dsr
    return _root(lambda y: _price(c, rate, y, red, freq) - pr, 0.0, 1.0, "yield")


def _duration(a: list[Any], name: str) -> Any:
    """duration / mduration(settlement, maturity, coupon, yld, frequency, [basis]): Macaulay (modified) duration in years."""
    settle, mat, freq, basis = _bond_args(a, name, 5)
    rate, yld = _x(a, 2, name), _x(a, 3, name)
    if rate < 0 or yld < 0:
        raise FusionError(f"{name}(): coupon and yield are 0 or more")
    c = _coup(settle, mat, freq, basis, name)
    n, frac = c["n"], c["dsc"] / c["e"]
    base, coupon = 1 + yld / freq, 100 * rate / freq
    flows = [(k - 1 + frac, coupon + (100 if k == n else 0)) for k in range(1, n + 1)]
    pv = math.fsum(cf / base ** t for t, cf in flows)
    d = math.fsum(t * cf / base ** t for t, cf in flows) / pv / freq
    return d / base if name == "mduration" else d


def _accrint(a: list[Any]) -> Any:
    """accrint(issue, first_interest, settlement, rate, par, frequency, [basis], [calc_method]): interest accrued on
    a security that pays periodic interest, summed over the quasi-coupon periods counted back from first_interest."""
    _arity(a, 6, 8, "accrint")
    issue, first, settle = _date(a[0]), _date(a[1]), _date(a[2])
    rate, par = _x(a, 3, "accrint"), _x(a, 4, "accrint", 1000.0)
    freq, basis = _coupon_freq(a, 5, "accrint"), _basis(a, 6, "accrint")
    from_issue = _flag(a, 7, True)
    if rate <= 0 or par <= 0:
        raise FusionError("accrint(): rate and par are more than 0")
    if issue >= settle:
        raise FusionError("accrint(): issue is before settlement")
    start = issue if from_issue or settle <= first else first
    step = 12 // freq
    total = 0.0
    k = 0
    # quasi-coupon periods counted back from first_interest (and on past it when settlement is later)
    while _months_back(first, k * step) > start:
        k += 1
    j = k
    while True:
        lo, hi = _months_back(first, j * step), _months_back(first, (j - 1) * step)
        if lo >= settle:
            break
        s, e = max(lo, start), min(hi, settle)
        if e > s:
            total += _daycount(s, e, basis) / _period_days(lo, hi, freq, basis)
        j -= 1
    return par * rate / freq * total


def _accrintm(a: list[Any]) -> Any:
    """accrintm(issue, settlement, rate, par, [basis]): interest of a security that pays at maturity."""
    _arity(a, 3, 5, "accrintm")
    issue, settle = _date(a[0]), _date(a[1])
    rate, par, basis = _x(a, 2, "accrintm"), _x(a, 3, "accrintm", 1000.0), _basis(a, 4, "accrintm")
    if rate <= 0 or par <= 0 or issue >= settle:
        raise FusionError("accrintm(): rate and par are more than 0, issue before settlement")
    return par * rate * _yearfrac_b(issue, settle, basis)


def _discount_args(a: list[Any], name: str) -> tuple[float, float, float, int]:
    """(year fraction settlement → maturity, argument 3, argument 4, basis) of disc / intrate / received / pricedisc / yielddisc."""
    _arity(a, 4, 5, name)
    settle, mat = _date(a[0]), _date(a[1])
    if settle >= mat:
        raise FusionError(f"{name}(): settlement is before maturity")
    x, y, basis = _x(a, 2, name), _x(a, 3, name), _basis(a, 4, name)
    if x <= 0 or y <= 0:
        raise FusionError(f"{name}(): the amounts are more than 0")
    return _yearfrac_b(settle, mat, basis), x, y, basis


def _pricemat(a: list[Any], solve: bool) -> Any:
    """pricemat(settlement, maturity, issue, rate, yld, [basis]) / yieldmat(settlement, maturity, issue, rate, pr, [basis])."""
    name = "yieldmat" if solve else "pricemat"
    _arity(a, 5, 6, name)
    settle, mat, issue = _date(a[0]), _date(a[1]), _date(a[2])
    rate, x, basis = _x(a, 3, name), _x(a, 4, name), _basis(a, 5, name)
    if settle >= mat or issue > settle:
        raise FusionError(f"{name}(): issue <= settlement < maturity")
    if rate < 0 or x < 0:
        raise FusionError(f"{name}(): rate and {'price' if solve else 'yield'} are 0 or more")
    b = _year_days(basis)
    dim, a_, dsm = _daycount(issue, mat, basis) / b, _daycount(issue, settle, basis) / b, _daycount(settle, mat, basis) / b
    if basis == 1:
        dim, a_, dsm = _yearfrac_b(issue, mat, 1), _yearfrac_b(issue, settle, 1), _yearfrac_b(settle, mat, 1)
    if solve:
        paid = x / 100 + a_ * rate
        return ((1 + dim * rate) - paid) / paid / dsm
    return (100 + dim * rate * 100) / (1 + dsm * x) - a_ * rate * 100


def _tbill(a: list[Any], name: str) -> tuple[int, float]:
    _arity(a, 3, 3, name)
    settle, mat = _date(a[0]), _date(a[1])
    dsm = (mat - settle).days
    if dsm <= 0 or mat > _add_months(settle, 12):
        raise FusionError(f"{name}(): maturity is after settlement and at most a year later")
    x = _x(a, 2, name)
    if x <= 0:
        raise FusionError(f"{name}(): the third argument is more than 0")
    return dsm, x


def _tbilleq(a: list[Any]) -> Any:
    dsm, disc = _tbill(a, "tbilleq")
    if dsm <= 182:
        return 365 * disc / (360 - disc * dsm)
    price = 100 * (1 - disc * dsm / 360)
    if price <= 0:
        raise FusionError("tbilleq(): the discount is too large")
    t = dsm / 365
    return (-t + math.sqrt(t * t - (2 * t - 1) * (1 - 100 / price))) / (t - 0.5)


def _tbillprice(a: list[Any]) -> Any:
    dsm, disc = _tbill(a, "tbillprice")
    p = 100 * (1 - disc * dsm / 360)
    if p <= 0:
        raise FusionError("tbillprice(): the discount is too large")
    return p


# odd first / last periods


def _odd_dates(start: dt.date, end: dt.date, anchor: dt.date, step: int, backward: bool) -> list[tuple[dt.date, dt.date]]:
    """The quasi-coupon periods covering start … end, on the schedule through anchor (counted back from it, or forward)."""
    out = []
    if backward:
        k = 0
        while _months_back(anchor, k * step) > start:
            k += 1
        for j in range(k, 0, -1):
            out.append((_months_back(anchor, j * step), _months_back(anchor, (j - 1) * step)))
    else:
        k = 0
        while True:
            lo, hi = _add_months(anchor, k * step), _add_months(anchor, (k + 1) * step)
            if _last_of_month(anchor):
                lo, hi = (d.replace(day=_cal.monthrange(d.year, d.month)[1]) for d in (lo, hi))
            out.append((lo, hi))
            if hi >= end:
                break
            k += 1
    return out


def _oddf(a: list[Any], name: str) -> tuple:
    _arity(a, 8, 9, name)
    settle, mat, issue, first = (_date(a[i]) for i in range(4))
    if not issue < settle < first < mat:
        raise FusionError(f"{name}(): issue < settlement < first_coupon < maturity")
    rate, x, red = _x(a, 4, name), _x(a, 5, name), _x(a, 6, name)
    freq, basis = _coupon_freq(a, 7, name), _basis(a, 8, name)
    if rate < 0 or x < 0 or red <= 0:
        raise FusionError(f"{name}(): rate and {'yield' if name == 'oddfprice' else 'price'} are 0 or more, redemption more than 0")
    return settle, mat, issue, first, rate, x, red, freq, basis


def _oddfprice_of(settle: dt.date, mat: dt.date, issue: dt.date, first: dt.date, rate: float, yld: float, red: float,
                  freq: int, basis: int) -> float:
    step = 12 // freq
    coupon = 100 * rate / freq
    base = 1 + yld / freq
    n = _coupons(first, mat, freq, "oddfprice")[2]  # coupons after the first one
    periods = _odd_dates(issue, first, first, step, True)
    pcd = periods[-1][0]
    e = _period_days(pcd, first, freq, basis)
    if len(periods) == 1:
        # a short (or regular) first period
        dfc = _daycount(issue, first, basis)
        a_ = _daycount(issue, settle, basis)
        dsc = _daycount(settle, first, basis)
        frac = dsc / e
        p = red / base ** (n + frac) + coupon * dfc / e / base ** frac
        p += math.fsum(coupon / base ** (k + frac) for k in range(1, n + 1))
        return p - coupon * a_ / e
    # a long first period: quasi-coupon periods back from first_coupon
    dc = acc = 0.0
    nq = 0
    dsc = None
    for lo, hi in periods:
        nl = _period_days(lo, hi, freq, basis)
        s = max(lo, issue)
        dc += _daycount(s, hi, basis) / nl
        if settle > s:
            acc += _daycount(s, min(settle, hi), basis) / nl
        if lo <= settle < hi:
            dsc = _daycount(settle, hi, basis) if basis not in (0, 4) else nl - _daycount(lo, settle, basis)
            e = nl
        elif lo >= settle:
            nq += 1
    frac = dsc / e
    p = red / base ** (n + nq + frac) + coupon * dc / base ** (nq + frac)
    p += math.fsum(coupon / base ** (k + nq + frac) for k in range(1, n + 1))
    return p - coupon * acc


def _oddfprice(a: list[Any]) -> Any:
    """oddfprice(settlement, maturity, issue, first_coupon, rate, yld, redemption, frequency, [basis])."""
    return _oddfprice_of(*_oddf(a, "oddfprice"))


def _oddfyield(a: list[Any]) -> Any:
    """oddfyield(settlement, maturity, issue, first_coupon, rate, pr, redemption, frequency, [basis])."""
    settle, mat, issue, first, rate, pr, red, freq, basis = _oddf(a, "oddfyield")
    if pr <= 0:
        raise FusionError("oddfyield(): the price is more than 0")
    return _root(lambda y: _oddfprice_of(settle, mat, issue, first, rate, y, red, freq, basis) - pr, 0.0, 1.0, "oddfyield")


def _oddl(a: list[Any], name: str) -> Any:
    """oddlprice(settlement, maturity, last_interest, rate, yld, redemption, frequency, [basis]) and oddlyield (pr for
    yld): an odd last period, its quasi-coupon periods counted forward from last_interest."""
    _arity(a, 7, 8, name)
    settle, mat, last = _date(a[0]), _date(a[1]), _date(a[2])
    if not last < settle < mat:
        raise FusionError(f"{name}(): last_interest < settlement < maturity")
    rate, x, red = _x(a, 3, name), _x(a, 4, name), _x(a, 5, name)
    freq, basis = _coupon_freq(a, 6, name), _basis(a, 7, name)
    if rate < 0 or x < 0 or red <= 0:
        raise FusionError(f"{name}(): rate and {'yield' if name == 'oddlprice' else 'price'} are 0 or more, redemption more than 0")
    dc = acc = dsc = 0.0
    for lo, hi in _odd_dates(last, mat, last, 12 // freq, False):
        nl = _period_days(lo, hi, freq, basis)
        end = min(hi, mat)
        dc += _daycount(lo, end, basis) / nl
        if settle > lo:
            acc += _daycount(lo, min(settle, end), basis) / nl
        if end > settle:
            dsc += _daycount(max(lo, settle), end, basis) / nl
    coupon = 100 * rate / freq
    if name == "oddlprice":
        return (red + dc * coupon) / (1 + dsc * x / freq) - acc * coupon
    paid = x + acc * coupon
    return ((red + dc * coupon) - paid) / paid * freq / dsc


FUNCS.update({
    "coupdaybs": _coupfn("a", "coupdaybs"),
    "coupdays": _coupfn("e", "coupdays"),
    "coupdaysnc": _coupfn("dsc", "coupdaysnc"),
    "coupncd": _coupfn("ncd", "coupncd"),
    "couppcd": _coupfn("pcd", "couppcd"),
    "coupnum": _coupfn("n", "coupnum"),
    "price": lambda ev, a: _price_fn(a),
    "yield": lambda ev, a: _yield_fn(a),
    "duration": lambda ev, a: _duration(a, "duration"),
    "mduration": lambda ev, a: _duration(a, "mduration"),
    "accrint": lambda ev, a: _accrint(a),
    "accrintm": lambda ev, a: _accrintm(a),
    "disc": lambda ev, a: (lambda t, pr, red, _b: (red - pr) / red / t)(*_discount_args(a, "disc")),
    "intrate": lambda ev, a: (lambda t, inv, red, _b: (red - inv) / inv / t)(*_discount_args(a, "intrate")),
    "received": lambda ev, a: (lambda t, inv, d, _b: inv / (1 - d * t) if d * t < 1 else _div0())(*_discount_args(a, "received")),
    "pricedisc": lambda ev, a: (lambda t, d, red, _b: red - d * red * t)(*_discount_args(a, "pricedisc")),
    "yielddisc": lambda ev, a: (lambda t, pr, red, _b: (red - pr) / pr / t)(*_discount_args(a, "yielddisc")),
    "pricemat": lambda ev, a: _pricemat(a, False),
    "yieldmat": lambda ev, a: _pricemat(a, True),
    "tbilleq": lambda ev, a: _tbilleq(a),
    "tbillprice": lambda ev, a: _tbillprice(a),
    "tbillyield": lambda ev, a: (lambda dsm, pr: (100 - pr) / pr * 360 / dsm)(*_tbill(a, "tbillyield")),
    "oddfprice": lambda ev, a: _oddfprice(a),
    "oddfyield": lambda ev, a: _oddfyield(a),
    "oddlprice": lambda ev, a: _oddl(a, "oddlprice"),
    "oddlyield": lambda ev, a: _oddl(a, "oddlyield"),
})


# ------------------------------------------------------------------ isomitted


def _isomitted(ev: "Evaluator", a: list[Any]) -> bool:
    """isomitted(parameter): true when a lambda was called without a value for that parameter —
    lambda(a, b, if(isomitted(b), a, a + b))(1) or (1, ) or (, 2) for a."""
    _arity(a, 1, 1, "isomitted")
    n = a[0]
    return n[0] == "var" and n[1] in (ev.env.get(OMITTED) or ())


LAZY.update({"isomitted": _isomitted})


# ------------------------------------------------------------------ object functions
#
# An Ontology object in a cell is {"__kind__": "object", rid, object_type_id, primary_key, title, properties}: it shows
# its title, and get_property / get_object_rid / get_object_type_id read it. A property read with get_property keeps
# the object it came from ({"__kind__": "property", value, rid, …}: other cells see the value). Objects come through the
# `objects` callable the Evaluator was given: objects.get(type, primary key) → (type, object) and
# objects.object_set(object set, filters) → (type, objects) — fusion.py reads them with the caller's permissions.

OBJECT_RID = "ri.ontology.main.object."
MAX_OBJECTS = 200  # an object set, like an object dropdown or table, brings at most 200 objects into a sheet


def object_rid(type_id: str, pk: Any) -> str:
    return f"{OBJECT_RID}{type_id}.{pk}"


def parse_object_rid(rid: Any) -> tuple[str, str]:
    """ri.ontology.main.object.<object type id>.<primary key> → (object type id, primary key)."""
    s = to_text(rid).strip()
    rest = s[len(OBJECT_RID):] if s.startswith(OBJECT_RID) else ""
    type_id, dot, pk = rest.partition(".")
    if not (type_id and dot and pk):
        raise FusionError(f"{s or 'an empty value'} is not an object RID (ri.ontology.main.object.<object type>.<primary key>)")
    return type_id, pk


def _object_value(t: dict, o: dict) -> dict:
    return {"__kind__": "object", "rid": object_rid(t["id"], o["primary_key"]), "object_type_id": t["id"],
            "object_type": t.get("display_name") or t["id"], "primary_key": o["primary_key"], "title": o.get("title") or o["primary_key"],
            "properties": o.get("properties") or {}}


def _load_object(ev: Evaluator, type_ref: Any, pk: Any) -> dict:
    get = getattr(ev.objects_fn, "get", None)
    if not get:
        raise FusionError("the Ontology is not available")
    cache = ev.__dict__.setdefault("object_cache", {})
    key = (to_text(type_ref), to_text(pk))
    if key not in cache:
        try:
            t, o = get(*key)
            cache[key] = _object_value(t, o)
        except FusionError as e:
            cache[key] = e
    if isinstance(cache[key], FusionError):
        raise cache[key]
    return cache[key]


def _object_items(v: Any) -> Optional[list[dict]]:
    """The objects of an object set value (object_set(…), a cell holding one, a range of object cells); None when v is
    not one."""
    if isinstance(v, Range):
        vals = [x for x in v.flat() if x not in (None, "")]
    elif isinstance(v, dict) and v.get("__kind__") == "array":
        vals = v.get("items") or []
    elif isinstance(v, list):
        vals = v
    elif isinstance(v, dict) and v.get("__kind__") == "object":
        vals = [v]
    else:
        return None
    if not vals or not all(isinstance(x, dict) and x.get("__kind__") == "object" for x in vals):
        return None
    return vals


def _object_of(ev: Evaluator, v: Any, name: str, properties: bool = False) -> dict:
    """The object a value stands for: an object, an object dropdown's selection, or (with `properties`) the object a
    property was read from (only its RID and type)."""
    if isinstance(v, Range) and len(v.flat()) == 1:
        v = v.flat()[0]
    if isinstance(v, dict):
        k = v.get("__kind__")
        if k == "object":
            return v
        if k == "property" and properties:
            return {"rid": v.get("rid"), "object_type_id": v.get("object_type_id")}
        if k == "dropdown" and v.get("rids"):
            rid = (v.get("rids") or {}).get(v.get("value"))
            if not rid:
                raise FusionError(f"{name}(): no object is selected in the dropdown")
            return _load_object(ev, *parse_object_rid(rid))
    raise FusionError(f"{name}() takes an object" + (" or an object property" if properties else ""))


def _object_fn(ev: Evaluator, a: list[Any]) -> dict:
    """object(object RID): the object with that RID. Also object(object type, primary key)."""
    _arity(a, 1, 2, "object")
    if len(a) == 2:
        return _load_object(ev, plain(a[0]), plain(a[1]))
    return _load_object(ev, *parse_object_rid(plain(a[0])))


def _object_set_fn(ev: Evaluator, a: list[Any]) -> list[dict]:
    """object_set(object set, [property, value, …]): the objects of a saved exploration (an Object Explorer object set)
    or an object list — by RID (ri.object-set.main.exploration.<id> / ri.object-set.main.list.<id>), ID or name —
    filtered by the property / value pairs (an empty value adds no filter), at most 200."""
    if not a:
        raise FusionError("object_set(object set, [property, value]…)")
    fn = getattr(ev.objects_fn, "object_set", None)
    if not fn:
        raise FusionError("the Ontology is not available")
    if len(a[1:]) % 2:
        raise FusionError("object_set(): parameters come in pairs: property, value")
    fs = []
    for i in range(1, len(a), 2):
        key, v = to_text(plain(a[i])), a[i + 1]
        if _is_modifier(v):
            if v.get("op") not in _OBJECT_OPS:
                raise FusionError("object_set(): objects take eq, neq, gt, gte, lt, lte and exact")
            fs.append({"property": key, "op": _OBJECT_OPS[v["op"]], "value": v.get("value")})
        elif plain(v) not in (None, ""):
            fs.append({"property": key, "op": "eq", "value": plain(v)})
    # one read per object set and filters in a recalculation: the cells of a region that repeat the call share it
    cache = ev.__dict__.setdefault("object_set_cache", {})
    key = (to_text(plain(a[0])), repr(fs))
    if key not in cache:
        try:
            cache[key] = fn(key[0], fs)
        except FusionError as e:
            cache[key] = e
    if isinstance(cache[key], FusionError):
        raise cache[key]
    t, objs = cache[key]
    return [_object_value(t if not o.get("object_type_id") or o["object_type_id"] == t["id"] else {"id": o["object_type_id"]}, o)
            for o in objs[:MAX_OBJECTS]]


def _object_set_dropdown(a: list[Any], items: list[dict]) -> dict:
    """object_dropdown(object set, [selected object RID], [placeholder]): a dropdown of the objects (by title; a title
    two objects share gets the primary key added)."""
    _arity(a, 1, 3, "object_dropdown")
    counts: dict[str, int] = {}
    for o in items:
        counts[o["title"]] = counts.get(o["title"], 0) + 1
    names = [o["title"] if counts[o["title"]] == 1 else f"{o['title']} ({o['primary_key']})" for o in items[:MAX_OBJECTS]]
    rids = {n: o["rid"] for n, o in zip(names, items)}
    selected = to_text(plain(a[1])).strip() if len(a) > 1 else ""
    if selected and not selected.startswith(OBJECT_RID):
        parse_object_rid(selected)  # the error: not an object RID
    types = {o["object_type_id"] for o in items}
    return {"__kind__": "dropdown", "options": names, "value": next((n for n, r in rids.items() if r == selected), None), "multi": False,
            "objects": {n: o["primary_key"] for n, o in zip(names, items)}, "object_type_id": next(iter(types)) if len(types) == 1 else None,
            "rids": rids, "placeholder": to_text(plain(a[2])) if len(a) > 2 else None}


def _get_property(ev: Evaluator, a: list[Any]) -> Any:
    """get_property(object, property): the property's value (by API name; a different case matches too). An object set
    gives the values of every object."""
    _arity(a, 2, 2, "get_property")
    key = to_text(plain(a[1]))

    def one(o: dict) -> dict:
        props = o.get("properties") or {}
        name = key if key in props else next((k for k in props if k.lower() == key.lower()), None)
        if name is None:
            raise FusionError(f"get_property(): {o.get('object_type') or o.get('object_type_id')} has no property {key}")
        return {"__kind__": "property", "value": props[name], "property": name, "rid": o["rid"], "object_type_id": o["object_type_id"]}

    items = _object_items(a[0])
    if items is not None and not (isinstance(a[0], dict) and a[0].get("__kind__") == "object"):
        return [one(o)["value"] for o in items]
    return one(_object_of(ev, a[0], "get_property"))


FUNCS.update({
    "object": _object_fn,
    "object_set": _object_set_fn,
    "get_property": _get_property,
    "get_object_rid": lambda ev, a: (_arity(a, 1, 1, "get_object_rid"), _object_of(ev, a[0], "get_object_rid", properties=True)["rid"])[1],
    "get_object_type_id": lambda ev, a: (_arity(a, 1, 1, "get_object_type_id"),
                                         _object_of(ev, a[0], "get_object_type_id", properties=True)["object_type_id"])[1],
})


# ------------------------------------------------------------------ submit_to_region_with_*
#
# Row by row into a table region of this or another Fusion document, matched on a key column: a row whose key is in
# the region is updated (only the columns given), any other row is appended. should_submit is one value or one per
# row; rows without a key are skipped. The actions carry {document, table, rows: [{column: value}], key_column,
# timestamp_column, options}; fusion.py runs them. The _lazy variants compute their values only when clicked (the
# button shows its label without reading the ranges).

_SUBMIT_OPTIONS = {"submitemptycells": "submitEmptyCells", "succeedwhennorows": "succeedWhenNoRows"}


def _submit_options(ev: Evaluator, a: list[Any]) -> dict:
    """submit_options(key, value, …): submitEmptyCells (empty values overwrite the destination's), succeedWhenNoRows
    (nothing to submit is a success, not a failure)."""
    if len(a) % 2:
        raise FusionError("submit_options(key, value, …): options come in pairs")
    out = {}
    for i in range(0, len(a), 2):
        k = to_text(plain(a[i]))
        name = _SUBMIT_OPTIONS.get(k.lower())
        if not name:
            raise FusionError(f"submit_options(): unknown option {k} (submitEmptyCells, succeedWhenNoRows)")
        out[name] = truthy(a[i + 1])
    return {"__kind__": "submit_options", "options": out}


def _column_values(v: Any) -> list[Any]:
    if isinstance(v, Range):
        return [plain(x) for x in v.flat()]
    p = plain(v)
    if isinstance(p, list):
        return [plain(x) for x in p]
    return [p]


def _submit_rows(name: str, should: Any, key_column: str, key_value: Any, pairs: list[Any]) -> list[dict]:
    if len(pairs) % 2:
        raise FusionError(f"{name}(): columns and values come in pairs")
    keys = _column_values(key_value)
    n = len(keys)
    cols: list[tuple[str, list[Any]]] = [(key_column, keys)]
    for i in range(0, len(pairs), 2):
        col = to_text(plain(pairs[i])).strip()
        if not col:
            raise FusionError(f"{name}(): a column name is empty")
        cols.append((col, _column_values(pairs[i + 1])))
    flags = _column_values(should)
    for label, vals in [("should_submit", flags)] + [(c, v) for c, v in cols[1:]]:
        if len(vals) not in (1, n):
            raise FusionError(f"{name}(): {label} has {len(vals)} values for {n} keys")
    rows = []
    for i in range(n):
        if not truthy(flags[i if len(flags) > 1 else 0]) or keys[i] in (None, ""):
            continue
        rows.append({c: (v[i] if len(v) > 1 else v[0]) for c, v in cols})
    return rows


def _submit_keyed(name: str, timestamp: bool, lazy: bool, with_label: bool = True, with_options: bool = False) -> Callable[[Evaluator, list[Any]], dict]:
    # with_key:                 label, document, region, should_submit, key column, key value, [column, value]…
    # with_key_and_timestamp:   label, document, region, should_submit, timestamp column, key column, key value, …
    # with_options:             document, region, options, should_submit, timestamp column, key column, key value, …
    fixed = (1 if with_label else 0) + 3 + (1 if with_options else 0) + (1 if timestamp else 0) + 2
    usage = (f"{name}(" + ("button label, " if with_label else "") + "document identifier, region name, " + ("submit options, " if with_options else "")
             + "should submit, " + ("timestamp column, " if timestamp else "") + "key column, key value, [column, value]…)")

    def fn(ev: Evaluator, args: list[Any]) -> dict:
        if len(args) < fixed:
            raise FusionError(usage)
        i = 0
        label = None
        if with_label:
            label = to_text(plain(ev.scalar(args[0])))
            i = 1
        document = to_text(plain(ev.scalar(args[i]))).strip()
        table = to_text(plain(ev.scalar(args[i + 1]))).strip()
        if not document or not table:
            raise FusionError(f"{name}(): name the document and the table region")
        i += 2
        options: dict = {}
        if with_options:
            o = ev.eval(args[i])
            if isinstance(o, dict) and o.get("__kind__") == "submit_options":
                options = dict(o.get("options") or {})
            elif plain(o) not in (None, ""):
                raise FusionError(f"{name}(): the submit options come from action.submit_options(…)")
            i += 1
        should_node = args[i]
        i += 1
        ts_col = None
        if timestamp:
            ts_col = to_text(plain(ev.scalar(args[i]))).strip() or None
            i += 1
        key_column = to_text(plain(ev.scalar(args[i]))).strip()
        if not key_column:
            raise FusionError(f"{name}(): name the key column")
        key_node, pair_nodes = args[i + 1], args[i + 2:]
        if len(pair_nodes) % 2:
            raise FusionError(f"{name}(): columns and values come in pairs")
        spec: dict[str, Any] = {"document": document, "table": table, "key_column": key_column, "timestamp_column": ts_col, "options": options}
        if lazy:
            spec["lazy"] = True  # fusion.py keeps what it read of the target region between clicks
        if lazy and not getattr(ev, "clicking", False):
            spec["rows"] = None  # computed when the button is clicked
        else:
            spec["rows"] = _submit_rows(name, ev.eval(should_node), key_column, ev.eval(key_node), [ev.eval(x) for x in pair_nodes])
        act = _action("submit_rows", **spec)
        if label is not None:
            act["label"] = {"__kind__": "label", "text": label or "Submit", "intent": "primary"}
        return act

    return fn


LAZY.update({
    "submit_to_region_with_key": _submit_keyed("submit_to_region_with_key", False, False),
    "submit_to_region_with_key_lazy": _submit_keyed("submit_to_region_with_key_lazy", False, True),
    "submit_to_region_with_key_and_timestamp": _submit_keyed("submit_to_region_with_key_and_timestamp", True, False),
    "submit_to_region_with_key_and_timestamp_lazy": _submit_keyed("submit_to_region_with_key_and_timestamp_lazy", True, True),
    "action.submit_to_region_with_options": _submit_keyed("action.submit_to_region_with_options", True, False, with_label=False, with_options=True),
    "submit_to_region_with_options": _submit_keyed("submit_to_region_with_options", True, False, with_label=False, with_options=True),
})
FUNCS.update({"action.submit_options": _submit_options, "submit_options": _submit_options})


# ------------------------------------------------------------------ error values: #N/A, #CALC! and the functions reading errors


def _na() -> Any:
    raise NAError("na(): no value")


def _na_pad(name: str) -> dict:
    """The value of a cell vstack / hstack / wraprows / wrapcols / expand / textsplit add without a pad value."""
    return {"__kind__": "error", "code": "na", "message": f"{name}(): no value here (a pad value fills these cells)"}


def _error_in(x: Any) -> Optional[dict]:
    """The error a single value is (an error cell, a spilled error), or None."""
    x = _single(x)
    if isinstance(x, dict) and x.get("__kind__") == "error":
        return x
    try:
        plain(x)
    except _ERRORS as e:
        return _error_value(e)
    return None


def _probe(ev: Evaluator, n: Any) -> Any:
    """A value, or the error computing it gave (as an error value)."""
    try:
        return ev.eval(n)
    except _ERRORS as e:
        return _error_value(e)


def _per_value(v: Any, fn: Callable[[Any], Any]) -> Any:
    """fn on one value, or value by value on a range or 2-D result (which then spills)."""
    if _is_grid(v):
        return Matrix([[fn(x) for x in row] for row in _raw_rows(v)])
    return fn(_single(v))


def _is_error(name: str, which: Callable[[Optional[str]], bool]) -> Callable[[Evaluator, list[Any]], Any]:
    def f(ev: Evaluator, a: list[Any]) -> Any:
        _arity(a, 1, 1, name)
        return _per_value(_probe(ev, a[0]), lambda x: (lambda e: e is not None and which(e.get("code")))(_error_in(x)))
    return f


def _replace_errors(name: str, which: Callable[[Optional[str]], bool]) -> Callable[[Evaluator, list[Any]], Any]:
    """iferror / ifna(value, value if error): the second value where the first is an error of that kind — value by
    value on a range or 2-D result; the second argument is only computed when it is needed."""
    def f(ev: Evaluator, a: list[Any]) -> Any:
        _arity(a, 2, 2, name)
        v = _probe(ev, a[0])
        if _is_grid(v):
            rows = _raw_rows(v)
            hit = [[(lambda e: e is not None and which(e.get("code")))(_error_in(x)) for x in row] for row in rows]
            if not any(any(r) for r in hit):
                return v
            alt = ev.eval(a[1])
            if _is_grid(alt):
                # an array as the replacement: its value at the same place (a row or column repeats)
                return _broadcast(lambda x, h, y: y if h is True else x, [v, Matrix(hit), alt], name, raw=True)
            return Matrix([[alt if h else x for x, h in zip(row, hrow)] for row, hrow in zip(rows, hit)])
        e = _error_in(v)
        if e is None:
            return v
        if not which(e.get("code")):
            plain(e)  # an error of another kind stays the result: ifna(1 / 0, 0) is #ERROR
        return ev.eval(a[1])
    return f


_ERROR_TYPE = {"ref": 4, "na": 7, "spill": 9, "calc": 14}


def _error_type_of(x: Any) -> Any:
    """Excel's error numbers: #DIV/0! 2, #REF! 4, #N/A 7, #SPILL! 9, #CALC! 14; any other Fusion error (#ERROR) gives 3,
    Excel's #VALUE!. A value that is not an error is #N/A."""
    e = _error_in(x)
    if e is None:
        raise NAError("error.type(): the value is not an error")
    code = e.get("code")
    if code in _ERROR_TYPE:
        return _ERROR_TYPE[code]
    return 2 if "division by zero" in str(e.get("message") or "") else 3


def _error_type(ev: Evaluator, a: list[Any]) -> Any:
    _arity(a, 1, 1, "error.type")
    v = _probe(ev, a[0])
    if _is_grid(v):
        return _elementwise_raw(_error_type_of, v)
    return _error_type_of(v)


def _elementwise_raw(fn: Callable[[Any], Any], v: Any) -> Matrix:
    """fn on every value as it is (errors included); an error fn raises is that value's error."""
    def one(x: Any) -> Any:
        try:
            return fn(x)
        except _ERRORS as e:
            return _error_value(e)
    return Matrix([[one(x) for x in row] for row in _raw_rows(v)])


LAZY.update({
    "iserror": _is_error("iserror", lambda code: True),
    "iserr": _is_error("iserr", lambda code: code != "na"),
    "isna": _is_error("isna", lambda code: code == "na"),
    "iferror": _replace_errors("iferror", lambda code: True),
    "ifna": _replace_errors("ifna", lambda code: code == "na"),
    "error.type": _error_type,
})
