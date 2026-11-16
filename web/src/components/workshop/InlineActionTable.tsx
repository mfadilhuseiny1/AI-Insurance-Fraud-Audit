"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { actions, type ActionParam, type FormState } from "@/lib/actions";
import { ontology, type ActionType } from "@/lib/ontology";
import { scenarios } from "@/lib/scenarios";

/**
 * The Inline Action widget's table layout (Workshop's Action table, formerly Action grid): one row per action request,
 * cells per visible parameter, live validation of each row (the action's form state: errors and submission criteria),
 * keyboard navigation (Enter / arrow keys move between rows), rows added / removed, a CSV file's rows appended, rows
 * pre-filled from an object set, then every row applied together (apply-batch: all validated first), or one by one
 * into a scenario.
 */

type Row = { id: number; values: Record<string, unknown> };
type Check = { key: string; form?: FormState; error?: string };

// row ids (React keys and validation results), unique across tables
let rowSeq = 1;
const NUMERIC = new Set(["integer", "long", "short", "byte", "double", "float", "decimal"]);
const LIVE_ROWS = 200;

/** CSV text → rows of cells: quoted cells (with "" for a quote and line breaks), a comma or semicolon delimiter (the
 * one the header uses more), a byte order mark and CRLF line ends. Blank lines are left out. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const head = src.slice(0, src.search(/\r?\n/) >= 0 ? src.search(/\r?\n/) : src.length);
  const delim = (head.match(/;/g)?.length ?? 0) > (head.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

/** A CSV cell as a parameter value: numbers, booleans (true / false, 1 / 0, yes / no, ya / tidak), arrays split on
 * | or ;, otherwise the text. Empty: no value. A cell that does not read as its type stays text (validation says so). */
export function csvValue(p: Pick<ActionParam, "type" | "array">, raw: string): unknown {
  const s = raw.trim();
  if (s === "") return undefined;
  if (p.array || p.type === "string_array") return s.split(/\s*[|;]\s*/).filter(Boolean).map((x) => csvValue({ type: p.type === "string_array" ? "string" : p.type }, x));
  if (NUMERIC.has(p.type)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  if (p.type === "boolean") {
    if (/^(true|1|yes|ya|y)$/i.test(s)) return true;
    if (/^(false|0|no|tidak|n)$/i.test(s)) return false;
    return s;
  }
  return s;
}

/** The CSV's rows as parameter values: header cells matched to parameters by ID, API-style name or display name
 * (ignoring case); unmatched columns are reported. */
export function csvRows(params: ActionParam[], text: string): { rows: Record<string, unknown>[]; unknown: string[]; matched: string[] } {
  const [header, ...body] = parseCsv(text);
  if (!header) return { rows: [], unknown: [], matched: [] };
  const norm = (x: string) => x.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const cols = header.map((h) => params.find((p) => norm(p.id) === norm(h) || norm(p.display_name ?? "") === norm(h)));
  const rows = body.map((cells) => {
    const r: Record<string, unknown> = {};
    cols.forEach((p, i) => {
      if (!p) return;
      const v = csvValue(p, cells[i] ?? "");
      if (v !== undefined) r[p.id] = v;
    });
    return r;
  });
  return { rows: rows.filter((r) => Object.keys(r).length), unknown: header.filter((_, i) => !cols[i]).map((h) => h.trim()), matched: cols.filter(Boolean).map((p) => p!.id) };
}

const shown = (v: unknown): string => (v === null || v === undefined ? "" : Array.isArray(v) ? v.map(shown).join(" | ") : typeof v === "object" ? ((v as { primary_key?: unknown }).primary_key !== undefined ? String((v as { primary_key: unknown }).primary_key) : JSON.stringify(v)) : String(v));

export function InlineActionTable({
  action,
  defaults,
  scenarioId,
  prefill,
  allowRows = true,
  allowCsv = true,
  hideHeader,
  title,
  onApplied,
}: {
  action: ActionType;
  defaults: Record<string, unknown>;
  scenarioId?: string;
  /** primary keys (an object set variable) put one per row into the parameter */
  prefill?: { param: string; keys: string[] };
  allowRows?: boolean;
  allowCsv?: boolean;
  hideHeader?: boolean;
  title?: string;
  /** after the rows were applied (the widget's On successful action submit) */
  onApplied: () => void;
}) {
  const params = useMemo(() => (action.parameters as unknown as ActionParam[]).filter((p) => p.visibility !== "hidden"), [action.parameters]);
  const fresh = (values: Record<string, unknown> = {}): Row => ({ id: rowSeq++, values: { ...clean(defaults), ...values } });
  const prefillKey = prefill ? `${prefill.param}:${prefill.keys.join("\u0001")}` : "";
  const defaultsKey = JSON.stringify(defaults);
  const [rows, setRows] = useState<Row[]>(() => (prefill?.keys.length ? prefill.keys.map((k) => fresh({ [prefill.param]: k })) : [fresh()]));
  const [checks, setChecks] = useState<Record<number, Check>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState<{ applied: number; edits: number } | null>(null);
  // the object set variable (or the defaults) changed: the rows start again from it
  const seeded = useRef(`${prefillKey}|${defaultsKey}`);
  useEffect(() => {
    if (seeded.current === `${prefillKey}|${defaultsKey}`) return;
    seeded.current = `${prefillKey}|${defaultsKey}`;
    setRows(prefill?.keys.length ? prefill.keys.map((k) => fresh({ [prefill.param]: k })) : [fresh()]);
    setDone(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillKey, defaultsKey]);
  // live validation: each row's form state (errors, submission criteria), the first LIVE_ROWS rows
  const rowsKey = JSON.stringify(rows.slice(0, LIVE_ROWS).map((r) => [r.id, r.values]));
  useEffect(() => {
    let stale = false;
    const t = setTimeout(async () => {
      const todo = rows.slice(0, LIVE_ROWS).filter((r) => checks[r.id]?.key !== JSON.stringify(r.values));
      for (let i = 0; i < todo.length && !stale; i += 4) {
        const part = todo.slice(i, i + 4);
        const got = await Promise.all(
          part.map(async (r): Promise<[number, Check]> => {
            const key = JSON.stringify(r.values);
            try {
              const form = await (scenarioId ? scenarios.form(scenarioId, action.id, r.values, Object.keys(r.values)) : actions.form(action.id, r.values, Object.keys(r.values)));
              return [r.id, { key, form }];
            } catch (e) {
              return [r.id, { key, error: (e as Error).message }];
            }
          }),
        );
        if (!stale) setChecks((c) => ({ ...c, ...Object.fromEntries(got) }));
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey, action.id, scenarioId]);

  // modify actions: each row's object shows its current values (unchanged cells keep them)
  const objParam = action.kind === "modify" || action.kind === "rules" ? params.find((p) => p.type === "object" && (p.object_type_id || action.object_type_id) === action.object_type_id) : undefined;
  const [current, setCurrent] = useState<Record<string, Record<string, unknown> | null>>({});
  const pksKey = objParam ? [...new Set(rows.slice(0, LIVE_ROWS).map((r) => r.values[objParam.id]).filter((v) => typeof v === "string" && v))].join("\u0001") : "";
  useEffect(() => {
    if (!objParam || !pksKey) return;
    let stale = false;
    const want = pksKey.split("\u0001").filter((pk) => !(pk in current));
    Promise.all(want.map((pk) => ontology.object(action.object_type_id, pk).then((o) => [pk, o.properties] as const, () => [pk, null] as const))).then(
      (got) => !stale && got.length && setCurrent((c) => ({ ...c, ...Object.fromEntries(got) })),
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pksKey, action.object_type_id]);
  const currentOf = (r: Row, p: ActionParam): unknown => (objParam && p.property ? current[String(r.values[objParam.id] ?? "")]?.[p.property] : undefined);

  const problems = (r: Row): string[] => {
    const c = checks[r.id];
    if (!c || c.key !== JSON.stringify(r.values)) return [];
    if (c.error) return [c.error];
    return [...Object.entries(c.form?.errors ?? {}).map(([k, m]) => `${params.find((p) => p.id === k)?.display_name ?? k}: ${m}`), ...(c.form?.criteria.passed ? [] : c.form?.criteria.failures ?? [])];
  };
  const checked = rows.slice(0, LIVE_ROWS).every((r) => checks[r.id]?.key === JSON.stringify(r.values));
  const invalid = rows.filter((r) => problems(r).length).length;

  const setCell = (id: number, p: string, v: unknown) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, values: v === undefined || v === "" ? omit(r.values, p) : { ...r.values, [p]: v } } : r)));
  const focus = (row: number, col: number) => (document.querySelector(`[data-action-table="${action.id}"] [data-cell="${row}:${col}"]`) as HTMLElement | null)?.focus();
  const onKey = (e: React.KeyboardEvent, ri: number, ci: number) => {
    const target = e.target as HTMLElement;
    const text = target.tagName === "INPUT" && !["number", "checkbox"].includes((target as HTMLInputElement).type);
    if (e.key === "Enter" || (e.key === "ArrowDown" && text)) {
      e.preventDefault();
      if (ri === rows.length - 1 && e.key === "Enter" && allowRows) {
        setRows((rs) => [...rs, fresh()]);
        setTimeout(() => focus(ri + 1, ci), 0);
      } else focus(ri + 1, ci);
    } else if (e.key === "ArrowUp" && text) {
      e.preventDefault();
      focus(ri - 1, ci);
    }
  };

  const upload = async (f: File) => {
    setError(null);
    const { rows: got, unknown, matched } = csvRows(params, await f.text());
    if (!got.length) {
      setError(matched.length ? "The CSV has no rows" : `No CSV column matches a parameter (${params.map((p) => p.display_name).join(", ")})`);
      return;
    }
    // a pristine first row (only the defaults) is replaced by the file's rows
    setRows((rs) => [...rs.filter((r) => JSON.stringify(r.values) !== JSON.stringify(clean(defaults))), ...got.map((v) => fresh(v))]);
    setNote(`${got.length} row${got.length === 1 ? "" : "s"} from ${f.name}${unknown.length ? ` · columns not used: ${unknown.join(", ")}` : ""}`);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const reqs = rows.map((r) => r.values);
      if (scenarioId) {
        let edits = 0;
        for (const [i, r] of reqs.entries()) {
          try {
            edits += (await scenarios.apply(scenarioId, action.id, r)).edits.length;
          } catch (e) {
            throw new Error(`Row ${i + 1}: ${(e as Error).message}${i ? ` (rows 1–${i} were applied to the scenario)` : ""}`);
          }
        }
        setDone({ applied: reqs.length, edits });
      } else setDone(await actions.batch(action.id, reqs));
      onApplied();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cell = (r: Row, p: ActionParam, ri: number, ci: number) => {
    const st = checks[r.id]?.form?.parameters.find((x) => x.id === p.id);
    const v = r.values[p.id];
    const common = { "data-cell": `${ri}:${ci}`, onKeyDown: (e: React.KeyboardEvent) => onKey(e, ri, ci), disabled: st?.disabled, title: p.description || p.display_name };
    const cls = "w-full min-w-[7rem] rounded border border-line bg-ink px-1.5 py-1 text-xs disabled:opacity-50";
    const now = currentOf(r, p);
    const placeholder =
      v !== undefined ? "" : now !== undefined && now !== null ? shown(now) : st && st.value !== null && st.value !== undefined ? shown(st.value) : p.type === "object" ? "primary key" : "";
    if (st?.options && !p.array)
      return (
        <select {...common} value={v === undefined || v === null ? "" : String(v)} onChange={(e) => setCell(r.id, p.id, e.target.value || undefined)} className={cls}>
          <option value="">{placeholder || "—"}</option>
          {st.options.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      );
    if (p.type === "boolean" && !p.array)
      return (
        <input
          {...common}
          type="checkbox"
          checked={v === undefined ? now === true || st?.value === true : v === true}
          onChange={(e) => setCell(r.id, p.id, e.target.checked)}
          className="h-3.5 w-3.5"
        />
      );
    const kind = p.array ? "text" : NUMERIC.has(p.type) ? "number" : p.type === "date" ? "date" : "text";
    return (
      <input
        {...common}
        type={kind}
        value={v === undefined || v === null ? "" : p.array ? shown(v) : typeof v === "object" ? shown(v) : String(v)}
        placeholder={placeholder}
        onChange={(e) => setCell(r.id, p.id, p.array ? csvValue(p, e.target.value) : NUMERIC.has(p.type) ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value)}
        className={cls}
      />
    );
  };

  const heading = title || action.display_name;
  if (done)
    return (
      <div className="space-y-3 p-4 text-sm" data-action-table-done={done.applied}>
        <div className="rounded-md bg-ok/10 px-3 py-2 text-ok">
          Applied {done.applied} row{done.applied === 1 ? "" : "s"}
          {scenarioId ? " to the scenario" : ""}: {done.edits} edit{done.edits === 1 ? "" : "s"}.
        </div>
        <button
          type="button"
          onClick={() => {
            setDone(null);
            setRows([fresh()]);
            setNote(null);
          }}
          className="rounded bg-ocean px-2.5 py-1 text-xs text-white"
        >
          Submit more
        </button>
      </div>
    );
  return (
    <div className="flex h-full flex-col text-xs" data-action-table={action.id}>
      {!hideHeader && <div className="shrink-0 border-b border-line px-4 py-2 text-sm font-semibold">{heading}</div>}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-panel">
            <tr>
              <th className="w-6 px-1 py-1 text-left text-muted">#</th>
              {params.map((p) => (
                <th key={p.id} className="px-1 py-1 text-left font-medium text-soft" title={p.description || p.id}>
                  {p.display_name}
                  {p.required ? " *" : ""}
                </th>
              ))}
              <th className="w-6" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => {
              const errs = problems(r);
              return (
                <tr key={r.id} className={`border-t border-line align-top ${errs.length ? "bg-bad/5" : ""}`} data-row={ri} data-row-valid={checks[r.id]?.key === JSON.stringify(r.values) ? String(!errs.length) : "pending"}>
                  <td className="px-1 py-1 text-muted" title={errs.join("\n") || "Valid"}>
                    {errs.length ? <Icon name="alert" className="h-3 w-3 text-bad" /> : ri + 1}
                  </td>
                  {params.map((p, ci) => (
                    <td key={p.id} className="px-1 py-1">
                      {cell(r, p, ri, ci)}
                    </td>
                  ))}
                  <td className="px-1 py-1">
                    {allowRows && rows.length > 1 && (
                      <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} className="text-muted hover:text-bad" title="Remove the row" data-row-remove>
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {invalid > 0 && (
          <ul className="space-y-0.5 px-2 py-1 text-[11px] text-bad" data-action-table-errors>
            {rows.flatMap((r, i) => problems(r).map((m) => <li key={`${r.id}:${m}`}>Row {i + 1}: {m}</li>)).slice(0, 8)}
          </ul>
        )}
      </div>
      {error && <p className="mx-2 mb-1 text-bad" data-action-table-error>{error}</p>}
      {note && <p className="mx-2 mb-1 text-muted">{note}</p>}
      <div className="flex shrink-0 items-center gap-2 border-t border-line p-2">
        {allowRows && (
          <button type="button" onClick={() => setRows((rs) => [...rs, fresh()])} className="text-ocean" data-row-add>
            + Row
          </button>
        )}
        {allowCsv && (
          <label className="cursor-pointer text-ocean" title="Columns named like the parameters (ID or display name); arrays separated by | or ;">
            <Icon name="upload" className="inline h-3 w-3" /> CSV
            <input type="file" accept=".csv,text/csv" className="hidden" data-csv-upload onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0]).finally(() => (e.target.value = ""))} />
          </label>
        )}
        <span className="text-muted">
          {rows.length} row{rows.length === 1 ? "" : "s"}
          {invalid ? ` · ${invalid} invalid` : ""}
          {rows.length > LIVE_ROWS ? ` · rows past ${LIVE_ROWS} are checked when submitted` : ""}
        </span>
        <button type="button" onClick={submit} disabled={busy || !rows.length || invalid > 0 || !checked} className="ml-auto rounded bg-ocean px-2.5 py-1 text-white disabled:opacity-40" data-action-table-submit>
          {busy ? "Applying…" : `Submit ${rows.length} row${rows.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}

function clean(x: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

function omit(x: Record<string, unknown>, k: string): Record<string, unknown> {
  const { [k]: _drop, ...rest } = x;
  void _drop;
  return rest;
}
