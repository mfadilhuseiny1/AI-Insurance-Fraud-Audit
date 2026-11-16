import { base64ToBytes, bytesToBase64, type Cell, type ColType, type Column, type Row, type SqlEngine, type Table } from "./pipeline";
import { registerSparkFunctions, toSqlite, type FunctionHost } from "./sparkSql";

/** The parts of sql.js (SQLite compiled to WebAssembly) the SQL step uses. */
type SqlValue = number | string | Uint8Array | null;
type Statement = { run: (values: SqlValue[]) => void; free: () => void };
type Database = FunctionHost & {
  run: (sql: string) => void;
  prepare: (sql: string) => Statement;
  exec: (sql: string) => { columns: string[]; values: SqlValue[][] }[];
  iterateStatements: (sql: string) => Iterable<{ getColumnNames: () => string[]; free: () => void }>;
  close: () => void;
};
export type SqlJs = { Database: new () => Database };

const SQL_TYPE: Record<ColType, string> = {
  String: "TEXT",
  Boolean: "INTEGER",
  Byte: "INTEGER",
  Short: "INTEGER",
  Integer: "INTEGER",
  Long: "INTEGER",
  Float: "REAL",
  Double: "REAL",
  Decimal: "REAL",
  Date: "TEXT",
  Timestamp: "TEXT",
  Binary: "BLOB",
};

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

const toSql = (v: Cell | undefined, type: ColType): SqlValue => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  // binary columns hold base64; SQLite gets the bytes
  if (type === "Binary") return base64ToBytes(String(v));
  return v;
};

function load(db: Database, name: string, t: Table) {
  if (!t.columns.length) {
    db.run(`CREATE TABLE ${quote(name)} (_empty INTEGER)`);
    return;
  }
  db.run(`CREATE TABLE ${quote(name)} (${t.columns.map((c) => `${quote(c.name)} ${SQL_TYPE[c.type]}`).join(", ")})`);
  const insert = db.prepare(`INSERT INTO ${quote(name)} VALUES (${t.columns.map(() => "?").join(", ")})`);
  try {
    db.run("BEGIN");
    for (const r of t.rows) insert.run(t.columns.map((c) => toSql(r[c.name], c.type)));
    db.run("COMMIT");
  } finally {
    insert.free();
  }
}

/** Type of a result column: input columns keep Boolean / Date / Timestamp when the values fit; otherwise inferred. */
function resultColumn(name: string, values: SqlValue[], known: Map<string, ColType>): { type: ColType; cells: Cell[] } {
  const present = values.filter((v) => v !== null);
  const hint = known.get(name);
  if (hint === "Boolean" && present.every((v) => v === 0 || v === 1))
    return { type: "Boolean", cells: values.map((v) => (v === null ? null : v === 1)) };
  if (present.length && present.every((v) => v instanceof Uint8Array))
    return { type: "Binary", cells: values.map((v) => (v instanceof Uint8Array ? bytesToBase64(v) : null)) };
  if ((hint === "Date" || hint === "Timestamp") && present.every((v) => typeof v === "string"))
    return { type: hint, cells: values as Cell[] };
  // new columns of yyyy-MM-dd or ISO instants (e.g. from to_date / date_add) are dates and timestamps
  if (!hint && present.length && present.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)))
    return { type: "Date", cells: values as Cell[] };
  if (!hint && present.length && present.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)))
    return { type: "Timestamp", cells: values as Cell[] };
  // narrower number types survive when every value still fits them
  if ((hint === "Byte" || hint === "Short" || hint === "Long") && present.every((v) => typeof v === "number" && Number.isInteger(v)))
    return { type: hint, cells: values as Cell[] };
  if ((hint === "Float" || hint === "Decimal") && present.every((v) => typeof v === "number"))
    return { type: hint, cells: values as Cell[] };
  const cells = values.map((v): Cell => (v instanceof Uint8Array ? [...v].map((b) => b.toString(16).padStart(2, "0")).join("") : v));
  if (present.length && present.every((v) => typeof v === "number"))
    return {
      // whole numbers beyond 32 bits are bigint (Long), as in Spark
      type: present.every((v) => Number.isSafeInteger(v)) ? (present.every((v) => Math.abs(v as number) <= 2147483647) ? "Integer" : "Long") : "Double",
      cells,
    };
  return { type: "String", cells: cells.map((v) => (v === null || typeof v === "string" ? v : String(v))) };
}

/** A SqlEngine on sql.js: each query runs in a fresh in-memory database holding the given tables. */
export function makeSqlEngine(SQL: SqlJs): SqlEngine {
  return {
    query(tables, sql) {
      const db = new SQL.Database();
      try {
        registerSparkFunctions(db);
        const known = new Map<string, ColType>();
        for (const [name, t] of Object.entries(tables)) {
          load(db, name, t);
          for (const c of t.columns) if (!known.has(c.name)) known.set(c.name, c.type);
        }
        let results: ReturnType<Database["exec"]>;
        try {
          results = db.exec(toSqlite(sql));
        } catch (e) {
          // show Spark names, not the internal spark_ registrations
          const message = String((e as Error).message ?? e).replace(/\bspark_(?!cast\b)(\w+)/g, "$1");
          if (/may not be used as a window function/.test(message))
            throw new Error(
              `SQL: ${message} — with OVER (...) use SQLite's window functions (row_number, rank, dense_rank, ntile, lag, lead, first_value, last_value, nth_value, percent_rank, cume_dist, sum, avg, count, min, max), or the Window function step`,
            );
          throw new Error(`SQL: ${message}`);
        }
        let last = results[results.length - 1];
        if (!last) {
          // a SELECT that matches no rows yields no result set: its columns come from the prepared statement (an empty table)
          let columns: string[] = [];
          try {
            for (const stmt of db.iterateStatements(toSqlite(sql))) {
              const names = stmt.getColumnNames();
              if (names.length) columns = names;
              stmt.free();
            }
          } catch {
            columns = [];
          }
          if (!columns.length) throw new Error("The query returned no result — end it with a SELECT");
          last = { columns, values: [] };
        }
        // SQLite allows repeated names (SELECT a, a); make them unique
        // first occurrences keep their names; repeats get the next free _2, _3… (never one already in the result)
        const firsts = new Set(last.columns);
        const used = new Set<string>();
        const names = last.columns.map((n) => {
          if (!used.has(n)) {
            used.add(n);
            return n;
          }
          let k = 2;
          while (used.has(`${n}_${k}`) || firsts.has(`${n}_${k}`)) k++;
          used.add(`${n}_${k}`);
          return `${n}_${k}`;
        });
        // SQLite can hold ±∞ (e.g. 1e400); results keep only finite numbers
        const finite = (v: SqlValue) => (typeof v === "number" && !Number.isFinite(v) ? null : v);
        const typed = names.map((n, i) => resultColumn(last.columns[i], last.values.map((row) => finite(row[i])), known));
        const columns: Column[] = names.map((name, i) => ({ name, type: typed[i].type }));
        const rows: Row[] = last.values.map((_, r) => Object.fromEntries(names.map((name, i) => [name, typed[i].cells[r]])));
        return { columns, rows };
      } finally {
        db.close();
      }
    },
  };
}
