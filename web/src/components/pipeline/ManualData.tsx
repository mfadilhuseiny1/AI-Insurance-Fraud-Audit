"use client";

import { useState } from "react";
import { EXAMPLES, fillLlmColumns, generateTable, GENERATOR_INFO, US_STATES } from "@/lib/generate";
import {
  castCell,
  COL_TYPES,
  GENERATORS,
  parseCsv,
  refLabel,
  type Cell,
  type ColType,
  type ColumnGenerator,
  type GeneratorConfig,
  type GeneratorKind,
  type NodeResult,
  type PipelineNode,
  type Row,
  type Table,
} from "@/lib/pipeline";
import { Icon } from "../Icon";
import { DataPreview } from "./DataPreview";
import { buttonClass, inputClass, Modal } from "./Modal";
import { Field, Switch, Tabs } from "./ui";

const toCell = (text: string, type: ColType): Cell => (text === "" ? null : castCell(text, type));

/** A manually entered table: edit cells, paste CSV, or generate notional data. */
export function ManualDataEditor({
  initial,
  nodes,
  result,
  onSave,
  onClose,
}: {
  initial: { name: string; table: Table; generator?: GeneratorConfig };
  nodes: PipelineNode[];
  result: (ref: string) => NodeResult;
  onSave: (d: { name: string; table: Table; generator?: GeneratorConfig }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [table, setTable] = useState<Table>(initial.table);
  const [tab, setTab] = useState<"table" | "csv" | "generate" | "preview">("table");
  const [csv, setCsv] = useState("");
  const [csvError, setCsvError] = useState<string | null>(null);
  const [cfg, setCfg] = useState<GeneratorConfig>(
    initial.generator ?? { rows: Math.max(10, initial.table.rows.length || 10), seed: 1, columns: initial.table.columns.map((c) => ({ column: c.name, kind: guess(c.name, c.type) })) },
  );
  const [focus, setFocus] = useState(0);
  const [preview, setPreview] = useState<Table | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setCell = (i: number, col: string, text: string) =>
    setTable((t) => ({ ...t, rows: t.rows.map((r, j) => (j === i ? { ...r, [col]: toCell(text, t.columns.find((c) => c.name === col)!.type) } : r)) }));
  const renameColumn = (k: number, next: string) =>
    setTable((t) => {
      const old = t.columns[k].name;
      if (!next || t.columns.some((c, j) => j !== k && c.name === next)) return t;
      setCfg((g) => ({ ...g, columns: g.columns.map((x) => (x.column === old ? { ...x, column: next } : x)) }));
      return {
        columns: t.columns.map((c, j) => (j === k ? { ...c, name: next } : c)),
        rows: t.rows.map((r) => {
          const { [old]: v, ...rest } = r;
          return { ...rest, [next]: v ?? null };
        }),
      };
    });
  const addColumn = () => {
    let n = table.columns.length + 1;
    while (table.columns.some((c) => c.name === `column_${n}`)) n++;
    const col = `column_${n}`;
    setTable((t) => ({ columns: [...t.columns, { name: col, type: "String" }], rows: t.rows.map((r) => ({ ...r, [col]: null })) }));
    setCfg((g) => ({ ...g, columns: [...g.columns, { column: col, kind: "Constant", value: "" }] }));
  };

  // the foreign key generator picks from another node's column
  const foreign = (g: ColumnGenerator) => {
    if (!g.foreignNode || !g.foreignColumn) return undefined;
    return result(g.foreignNode).table?.rows.map((r) => r[g.foreignColumn!] ?? null);
  };
  const ensureColumns = (c: GeneratorConfig) => ({ ...c, columns: table.columns.map((col) => c.columns.find((x) => x.column === col.name) ?? { column: col.name, kind: "Constant" as GeneratorKind }) });

  const runPreview = async () => {
    setError(null);
    const conf = ensureColumns(cfg);
    let t = generateTable(conf, table, foreign);
    if (conf.columns.some((g) => g.kind === "Generate with LLM")) {
      setBusy("Asking the LLM for 10 preview rows…");
      try {
        t = await fillLlmColumns({ ...t, rows: t.rows.slice(0, 10) }, conf, 10);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    }
    setPreview(t);
    setTab("preview");
  };

  const generate = async () => {
    setError(null);
    const conf = ensureColumns(cfg);
    let t = generateTable(conf, table, foreign);
    if (conf.columns.some((g) => g.kind === "Generate with LLM" && !g.locked)) {
      setBusy("Generating LLM columns… (can take up to a minute)");
      try {
        t = await fillLlmColumns(t, conf, t.rows.length, (n) => setBusy(`Generating LLM columns… ${n}/${t.rows.length}`));
      } catch (e) {
        setError((e as Error).message);
        setBusy(null);
        return;
      }
      setBusy(null);
    }
    setTable(t);
    setCfg(conf);
    setTab("table");
  };

  const g = ensureColumns(cfg).columns[focus];
  const setG = (patch: Partial<ColumnGenerator>) => setCfg((c) => ({ ...ensureColumns(c), columns: ensureColumns(c).columns.map((x, i) => (i === focus ? { ...x, ...patch } : x)) }));

  return (
    <Modal title="Manually entered data" icon="keyboard" onClose={onClose} wide>
      <div className="space-y-3 p-4">
        <div className="flex items-end gap-3">
          <Field label="Dataset name">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </Field>
          <Tabs
            value={tab}
            onChange={setTab}
            className="mb-1 ml-auto"
            tabs={[
              { id: "table", label: "Table" },
              { id: "csv", label: "Paste CSV" },
              { id: "generate", label: "Generate notional data" },
              ...(preview ? [{ id: "preview" as const, label: "Preview generated data" }] : []),
            ]}
          />
        </div>

        {tab === "table" && (
          <div className="max-h-[50vh] overflow-auto rounded-md border border-line">
            <table className="min-w-full border-separate border-spacing-0 text-xs">
              <thead className="sticky top-0 z-10 bg-panel">
                <tr>
                  <th className="w-8 border-b border-r border-line" />
                  {table.columns.map((c, k) => (
                    <th key={k} className="min-w-36 border-b border-r border-line p-1 text-left font-normal">
                      <div className="flex items-center gap-1">
                        <input defaultValue={c.name} onBlur={(e) => renameColumn(k, e.target.value.trim())} className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 font-medium outline-none hover:border-line-2 focus:border-ocean" />
                        <button
                          type="button"
                          title="Remove column"
                          onClick={() => {
                            setTable((t) => ({ columns: t.columns.filter((_, j) => j !== k), rows: t.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([key]) => key !== c.name))) }));
                            setCfg((x) => ({ ...x, columns: x.columns.filter((y) => y.column !== c.name) }));
                          }}
                          className="rounded p-0.5 text-muted hover:text-bad"
                        >
                          <Icon name="x" className="h-3 w-3" />
                        </button>
                      </div>
                      <select
                        value={c.type}
                        onChange={(e) => {
                          const type = e.target.value as ColType;
                          setTable((t) => ({
                            columns: t.columns.map((x, j) => (j === k ? { ...x, type } : x)),
                            rows: t.rows.map((r) => ({ ...r, [c.name]: r[c.name] === null || r[c.name] === undefined ? null : castCell(r[c.name] ?? null, type) })),
                          }));
                        }}
                        className="mt-0.5 w-full rounded border border-line-2 bg-ink px-1 py-0.5 text-[11px] text-muted"
                      >
                        {COL_TYPES.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </th>
                  ))}
                  <th className="border-b border-line p-1">
                    <button type="button" onClick={addColumn} className="whitespace-nowrap rounded px-2 py-1 text-ocean hover:bg-panel-2">
                      + Add column
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="border-b border-r border-line px-1 text-right text-muted">
                      <button type="button" title="Remove row" onClick={() => setTable((t) => ({ ...t, rows: t.rows.filter((_, j) => j !== i) }))} className="hover:text-bad">
                        {i + 1}
                      </button>
                    </td>
                    {table.columns.map((c) => (
                      <td key={c.name} className="border-b border-r border-line p-0">
                        <input
                          value={r[c.name] === null || r[c.name] === undefined ? "" : String(r[c.name])}
                          onChange={(e) => setCell(i, c.name, e.target.value)}
                          placeholder="null"
                          className="w-full bg-transparent px-1.5 py-1 outline-none placeholder:italic placeholder:text-muted focus:bg-panel-2"
                        />
                      </td>
                    ))}
                    <td className="border-b border-line" />
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              onClick={() => setTable((t) => ({ ...t, rows: [...t.rows, Object.fromEntries(t.columns.map((c) => [c.name, null])) as Row] }))}
              className="m-1 rounded px-2 py-1 text-xs text-ocean hover:bg-panel-2"
            >
              + Add row
            </button>
          </div>
        )}

        {tab === "csv" && (
          <div className="space-y-2">
            <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={10} spellCheck={false} placeholder={"id,name,value\n1,first,10"} className={`${inputClass} font-mono text-xs`} />
            {csvError && <p className="text-xs text-bad">{csvError}</p>}
            <button
              type="button"
              disabled={!csv.trim()}
              onClick={() => {
                try {
                  const t = parseCsv(csv);
                  setTable(t);
                  setCfg((c) => ({ ...c, columns: t.columns.map((col) => c.columns.find((x) => x.column === col.name) ?? { column: col.name, kind: guess(col.name, col.type) }) }));
                  setTab("table");
                  setCsvError(null);
                } catch (e) {
                  setCsvError((e as Error).message);
                }
              }}
              className={buttonClass.secondary}
            >
              Use this CSV (replaces the table)
            </button>
          </div>
        )}

        {tab === "generate" && (
          <div className="grid grid-cols-[13rem_1fr] gap-3">
            <ul className="max-h-[48vh] space-y-0.5 overflow-y-auto rounded-md border border-line p-1">
              {ensureColumns(cfg).columns.map((c, i) => (
                <li key={c.column}>
                  <button
                    type="button"
                    onClick={() => setFocus(i)}
                    className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs ${focus === i ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">{c.column}</span>
                    <span className="truncate text-[10px] text-muted">{c.kind}</span>
                    {c.locked && <Icon name="check" className="h-3 w-3 text-sand" />}
                  </button>
                </li>
              ))}
              {!table.columns.length && <li className="p-2 text-xs text-muted">Add columns in the Table tab first.</li>}
            </ul>
            {g ? (
              <div className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <Field label="Auto populate with">
                    <select value={g.kind} onChange={(e) => setG({ kind: e.target.value as GeneratorKind })} className={`${inputClass} w-56`}>
                      {GENERATORS.map((k) => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                  </Field>
                  <div className="mt-5">
                    <Switch on={!!g.locked} onChange={(v) => setG({ locked: v })} label="Lock" hint="Keep this column's values when generating again" />
                  </div>
                </div>
                <p className="text-xs text-muted">{GENERATOR_INFO[g.kind].hint}</p>
                {EXAMPLES[g.kind] && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-ocean">Examples</summary>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {EXAMPLES[g.kind]!.map((x) => (
                        <span key={x} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-soft ring-1 ring-line-2">
                          {x}
                        </span>
                      ))}
                    </div>
                  </details>
                )}
                {(g.kind === "Constant" || g.kind === "Template") && (
                  <Field label={g.kind === "Template" ? "Template" : "Value"}>
                    <input value={g.value ?? ""} onChange={(e) => setG({ value: e.target.value })} className={`${inputClass} font-mono text-xs`} />
                  </Field>
                )}
                {(g.kind === "Integer" || g.kind === "Decimal" || g.kind === "Date") && (
                  <div className="flex gap-2">
                    <Field label={g.kind === "Date" ? "From year" : "Min"}>
                      <input type="number" value={g.min ?? ""} onChange={(e) => setG({ min: e.target.value === "" ? undefined : Number(e.target.value) })} className={`${inputClass} w-28`} />
                    </Field>
                    <Field label={g.kind === "Date" ? "To year" : "Max"}>
                      <input type="number" value={g.max ?? ""} onChange={(e) => setG({ max: e.target.value === "" ? undefined : Number(e.target.value) })} className={`${inputClass} w-28`} />
                    </Field>
                  </div>
                )}
                {g.kind === "US ZIP code" && (
                  <Field label="State">
                    <select value={g.state ?? ""} onChange={(e) => setG({ state: e.target.value })} className={`${inputClass} w-56`}>
                      <option value="">Any state</option>
                      {US_STATES.map((s) => (
                        <option key={s[1]} value={s[1]}>
                          {s[0]}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {g.kind === "List" && (
                  <WeightedList
                    items={(g.options ?? []).map((o) => ({ label: o.value, weight: o.weight }))}
                    onChange={(items) => setG({ options: items.map((x) => ({ value: x.label, weight: x.weight })) })}
                    placeholder="value"
                  />
                )}
                {g.kind === "One of" && (
                  <div className="space-y-1">
                    {(g.choices ?? []).map((c, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-xs">
                        <select
                          value={c.kind}
                          onChange={(e) => setG({ choices: (g.choices ?? []).map((x, j) => (j === i ? { ...x, kind: e.target.value as GeneratorKind } : x)) })}
                          className={`${inputClass} w-44 py-1 text-xs`}
                        >
                          {GENERATORS.filter((k) => !["One of", "Foreign key", "Generate with LLM", "List"].includes(k)).map((k) => (
                            <option key={k}>{k}</option>
                          ))}
                        </select>
                        {(c.kind === "Constant" || c.kind === "Template") && (
                          <input value={c.value ?? ""} onChange={(e) => setG({ choices: (g.choices ?? []).map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} className={`${inputClass} py-1 text-xs`} />
                        )}
                        <span className="text-muted">weight</span>
                        <input
                          type="number"
                          min={0}
                          value={c.weight}
                          onChange={(e) => setG({ choices: (g.choices ?? []).map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)) })}
                          className={`${inputClass} w-16 py-1 text-xs`}
                        />
                        <button type="button" onClick={() => setG({ choices: (g.choices ?? []).filter((_, j) => j !== i) })} className="text-muted hover:text-bad">
                          <Icon name="x" className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                    <button type="button" onClick={() => setG({ choices: [...(g.choices ?? []), { kind: "City", weight: 1 }] })} className="text-xs text-ocean hover:underline">
                      + Add generator
                    </button>
                  </div>
                )}
                {g.kind === "Foreign key" && (
                  <div className="flex gap-2">
                    <Field label="Node">
                      <select value={g.foreignNode ?? ""} onChange={(e) => setG({ foreignNode: e.target.value, foreignColumn: "" })} className={`${inputClass} w-52`}>
                        <option value="">Choose…</option>
                        {nodes.map((n) => (
                          <option key={n.id} value={n.id}>
                            {refLabel(nodes, n.id)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Column">
                      <select value={g.foreignColumn ?? ""} onChange={(e) => setG({ foreignColumn: e.target.value })} className={`${inputClass} w-52`}>
                        <option value="">Choose…</option>
                        {(g.foreignNode ? (result(g.foreignNode).table?.columns ?? []) : []).map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                )}
                {g.kind === "Generate with LLM" && (
                  <>
                    <Field label="Column prompt" hint="Describe the data; reference other columns as /column_name.">
                      <textarea value={g.value ?? ""} onChange={(e) => setG({ value: e.target.value })} rows={3} className={`${inputClass} text-xs`} />
                    </Field>
                    <Field label="Example cell value" hint="Highly encouraged: shows the type and format you expect.">
                      <input value={g.example ?? ""} onChange={(e) => setG({ example: e.target.value })} className={inputClass} />
                    </Field>
                    <p className="text-xs text-muted">Previews show at most 10 LLM-generated rows; many rows or a complex prompt can take up to a minute.</p>
                  </>
                )}
                <div className="flex items-end gap-2 border-t border-line pt-2.5">
                  <Field label="Pick number of rows" hint="1 to 1000">
                    <input type="number" min={1} max={1000} value={cfg.rows} onChange={(e) => setCfg({ ...cfg, rows: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })} className={`${inputClass} w-28`} />
                  </Field>
                  <Field label="Seed">
                    <input type="number" value={cfg.seed ?? 1} onChange={(e) => setCfg({ ...cfg, seed: Number(e.target.value) || 1 })} className={`${inputClass} w-24`} />
                  </Field>
                  <button type="button" disabled={!!busy} onClick={runPreview} className={`${buttonClass.secondary} mb-px`}>
                    Preview
                  </button>
                  <button type="button" disabled={!!busy} onClick={generate} title="Overwrites the table (locked columns keep their values)" className={`${buttonClass.primary} mb-px ml-auto`}>
                    Generate table
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted">Choose a column.</p>
            )}
          </div>
        )}

        {tab === "preview" && preview && (
          <div className="flex h-[48vh] flex-col rounded-md border border-line">
            <DataPreview table={preview} title="Preview generated data" />
          </div>
        )}

        {busy && (
          <p className="flex items-center gap-2 text-xs text-muted">
            <Icon name="refresh" className="h-3.5 w-3.5 animate-spin text-ocean" /> {busy}
          </p>
        )}
        {error && <p className="text-xs text-bad">{error}</p>}

        <div className="flex justify-between">
          <span className="text-xs text-muted">
            {table.rows.length.toLocaleString()} rows · {table.columns.length} columns
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={buttonClass.secondary}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!name.trim() || !table.columns.length || !!busy}
              onClick={() => onSave({ name: name.trim(), table, generator: cfg.columns.length ? ensureColumns(cfg) : undefined })}
              className={buttonClass.primary}
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function WeightedList({ items, onChange, placeholder }: { items: { label: string; weight: number }[]; onChange: (i: { label: string; weight: number }[]) => void; placeholder: string }) {
  return (
    <div className="space-y-1">
      {items.map((x, i) => (
        <div key={i} className="flex items-center gap-1.5 text-xs">
          <input value={x.label} placeholder={placeholder} onChange={(e) => onChange(items.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} className={`${inputClass} py-1 text-xs`} />
          <span className="text-muted">weight</span>
          <input type="number" min={0} value={x.weight} onChange={(e) => onChange(items.map((y, j) => (j === i ? { ...y, weight: Number(e.target.value) } : y)))} className={`${inputClass} w-16 py-1 text-xs`} />
          <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-muted hover:text-bad">
            <Icon name="x" className="h-3 w-3" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...items, { label: "", weight: 1 }])} className="text-xs text-ocean hover:underline">
        + Add value
      </button>
    </div>
  );
}

/** A starting generator from a column's name and type. */
function guess(name: string, type: ColType): GeneratorKind {
  const n = name.toLowerCase();
  if (/email/.test(n)) return "Email";
  if (/first.?name/.test(n)) return "First name";
  if (/last.?name|surname/.test(n)) return "Last name";
  if (/name/.test(n)) return "Full name";
  if (/city/.test(n)) return "City";
  if (/company|employer/.test(n)) return "Company";
  if (/country/.test(n)) return "Country code";
  if (/address|street/.test(n)) return "Street address";
  if (/zip|postal/.test(n)) return "US ZIP code";
  if (/state/.test(n)) return "US state code";
  if (/uuid|guid/.test(n)) return "UUID";
  if (type === "Integer" || type === "Long" || type === "Short" || type === "Byte") return "Integer";
  if (type === "Double" || type === "Float" || type === "Decimal") return "Decimal";
  if (type === "Date" || type === "Timestamp") return "Date";
  if (type === "Boolean") return "Boolean";
  return "Template";
}

export const EMPTY_MANUAL: Table = {
  columns: [
    { name: "id", type: "Integer" },
    { name: "name", type: "String" },
    { name: "email", type: "String" },
  ],
  rows: [],
};

