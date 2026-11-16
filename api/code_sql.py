"""SQL transforms for Code Repositories (used by code_runner.py).

A `.sql` file in a repository holds one or more Palantir-style statements, each a buildable transform:

    -- comments are allowed
    CREATE TABLE `/My Project/Clean/high_value_orders` AS
    SELECT o.*, c.segment
    FROM `/My Project/Raw/orders` o
    JOIN `/My Project/Raw/customers` c ON c.customer_id = o.customer_id
    WHERE o.amount > 100;

The table in backticks after CREATE TABLE is the output (its last path segment is the dataset name, the rest
its folder; a bare name goes to the repository's output folder). Every other backticked name is an input
dataset in Files, by path or item id (an optional `branch`. prefix is accepted and ignored, as in Foundry).
Statements run in an in-memory SQLite database with the inputs loaded as tables (DuckDB is not installed), so
the SQL dialect is SQLite's. Only SELECT / WITH … SELECT bodies are allowed.
"""

from __future__ import annotations

import json
import re
import sqlite3
import time

BACKTICK = re.compile(r"(?:`[^`]+`\s*\.\s*)?`([^`]+)`")
CREATE = re.compile(r"(?is)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+`([^`]+)`\s+AS\s+(.+)$")
SECONDS = 240


def strip_comments(sql: str) -> str:
    """Remove -- and /* */ comments outside string literals (newlines are kept so line numbers stay right)."""
    out, i, n, quote = [], 0, len(sql), None
    while i < n:
        c = sql[i]
        if quote:
            out.append(c)
            if c == quote:
                quote = None
            i += 1
        elif c in ("'", '"', "`"):
            quote = c
            out.append(c)
            i += 1
        elif sql.startswith("--", i):
            j = sql.find("\n", i)
            i = n if j < 0 else j
        elif sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            chunk = sql[i: n if j < 0 else j + 2]
            out.append("\n" * chunk.count("\n"))
            i = n if j < 0 else j + 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _split(sql: str) -> list[tuple[int, str]]:
    """Top-level statements with the 1-based line each starts on."""
    parts, start, quote = [], 0, None
    for i, c in enumerate(sql):
        if quote:
            if c == quote:
                quote = None
        elif c in ("'", '"', "`"):
            quote = c
        elif c == ";":
            parts.append((start, sql[start:i]))
            start = i + 1
    parts.append((start, sql[start:]))
    out = []
    for pos, text in parts:
        if text.strip():
            lead = len(text) - len(text.lstrip())
            out.append((sql.count("\n", 0, pos + lead) + 1, text.strip()))
    return out


def output_ref(path: str) -> dict:
    parts = [p for p in path.split("/") if p]
    if not parts:
        raise ValueError("the output table needs a name")
    return {"name": parts[-1], "folder": "/".join(parts[:-1]) or None}


def parse(source: str) -> list[dict]:
    """[{output {name, folder}, inputs {name: ref}, select, line}] for each CREATE TABLE … AS statement.
    Raises ValueError with a readable message when a statement is not one."""
    out = []
    for line, stmt in _split(strip_comments(source)):
        m = CREATE.match(stmt)
        if not m:
            raise ValueError(f"line {line}: a SQL transform must be CREATE TABLE `/path/output` AS SELECT … (got: {stmt[:60]!r})")
        body = m.group(2).strip()
        if not re.match(r"(?is)^\(?\s*(with|select)\b", body):
            raise ValueError(f"line {line}: the table body must be a SELECT (or WITH … SELECT) query")
        refs: dict[str, str] = {}
        for r in BACKTICK.finditer(body):
            if r.group(1) not in refs.values():
                refs[f"input_{len(refs) + 1}"] = r.group(1)
        out.append({"output": output_ref(m.group(1)), "inputs": refs, "select": body, "line": line})
    return out


def execute(select: str, refs: dict[str, str], frames: dict, seconds: int = SECONDS):
    """Run a SELECT over pandas DataFrames: refs maps input name -> backticked ref, frames input name -> DataFrame."""
    import pandas as pd

    con = sqlite3.connect(":memory:")
    started = time.monotonic()
    con.set_progress_handler(lambda: 1 if time.monotonic() - started > seconds else 0, 10_000)
    try:
        table_of: dict[str, str] = {}
        for i, (name, ref) in enumerate(refs.items()):
            df = frames[name].copy()
            for c in df.columns:
                if df[c].dtype == object:
                    df[c] = df[c].map(lambda v: json.dumps(v, default=str) if isinstance(v, (list, dict)) else v)
            df.columns = [str(c) for c in df.columns]
            table_of[ref] = f"t{i}"
            df.to_sql(table_of[ref], con, index=False)
        sql = BACKTICK.sub(lambda m: f'"{table_of[m.group(1)]}"', select)
        con.execute("PRAGMA query_only = ON")
        try:
            return pd.read_sql_query(sql, con)
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if "interrupt" in msg:
                msg = f"interrupted: the query took longer than {seconds} s"
            raise ValueError(f"SQL error: {msg}") from None
    finally:
        con.close()
