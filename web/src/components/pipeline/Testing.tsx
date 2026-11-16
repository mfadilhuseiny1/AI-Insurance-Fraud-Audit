"use client";

import { useMemo, useState } from "react";
import { API_URL, api } from "@/lib/api";
import { evaluate, EVALUATOR_INFO } from "@/lib/evaluators";
import { when } from "@/lib/format";
import { coerceAnswer, effectiveOutputType, rowCall } from "@/lib/llm";
import {
  castCell,
  COL_TYPES,
  EVALUATORS,
  refLabel,
  uid,
  type Cell,
  type ColType,
  type Column,
  type Dataset,
  type EvalSuite,
  type Evaluator,
  type EvaluatorKind,
  type LlmNode,
  type NodeResult,
  type Pipeline,
  type Row,
  type Table,
  type UnitTest,
  type UnitTestTable,
} from "@/lib/pipeline";
import { ORDERING, runUnitTest, testShape, withNodesBetween, type TestRun } from "@/lib/unitTests";
import { useSqlEngine } from "@/lib/useSqlEngine";
import { Icon } from "../Icon";
import { DataPreview } from "./DataPreview";
import { buttonClass, inputClass, Modal } from "./Modal";
import { DropMenu, Field, Panel, Switch, Tabs } from "./ui";
import { confirmDialog } from "@/lib/dialogs";

// ---------------------------------------------------------------- a table typed by hand (test inputs, expected outputs, testing data)

export function TestTableEditor({
  title,
  initial,
  reuse,
  datasets,
  ordering,
  onApply,
  onClose,
}: {
  title: string;
  initial: UnitTestTable | undefined;
  /** the schema of the connected table (Reuse schema) */
  reuse?: Column[];
  datasets: Dataset[];
  /** streaming tests: an `ordering` column sets the order rows are emitted in */
  ordering?: boolean;
  onApply: (t: UnitTestTable) => void;
  onClose: () => void;
}) {
  const withOrdering = (cols: Column[]) => (ordering && !cols.some((c) => c.name === ORDERING) ? [{ name: ORDERING, type: "Long" as ColType }, ...cols] : cols);
  const [t, setT] = useState<UnitTestTable>(() => ({ columns: withOrdering(initial?.columns ?? reuse ?? []), rows: initial?.rows ?? [] }));
  const [from, setFrom] = useState("");
  const setSchema = (cols: Column[]) => setT({ columns: withOrdering(cols), rows: t.rows.map((r) => Object.fromEntries(withOrdering(cols).map((c) => [c.name, r[c.name] ?? null]))) });
  const paste = (text: string) => {
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    const rows = lines.map((l) => {
      const cells = l.split("\t");
      return Object.fromEntries(t.columns.map((c, i) => [c.name, cells[i] === undefined || cells[i] === "" ? null : castCell(cells[i], c.type)]));
    });
    setT({ ...t, rows: [...t.rows, ...rows] });
  };
  return (
    <Modal title={title} icon="keyboard" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {reuse && (
            <button type="button" onClick={() => setSchema(reuse)} className={buttonClass.secondary}>
              Reuse schema
            </button>
          )}
          <select value={from} onChange={(e) => setFrom(e.target.value)} className={`${inputClass} w-56 py-1 text-xs`}>
            <option value="">From dataset…</option>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <button type="button" disabled={!from} onClick={() => setSchema(datasets.find((d) => d.id === from)?.columns ?? [])} className={buttonClass.secondary}>
            Use its schema
          </button>
          <button
            type="button"
            disabled={!from}
            title="Copy its first 20 rows (then edit them)"
            onClick={() => {
              const d = datasets.find((x) => x.id === from);
              if (d) setT({ columns: withOrdering(d.columns), rows: d.rows.slice(0, 20).map((r, i) => (ordering ? { [ORDERING]: i + 1, ...r } : r)) });
            }}
            className={buttonClass.secondary}
          >
            Copy rows
          </button>
          <button
            type="button"
            onClick={() => {
              let n = t.columns.length + 1;
              while (t.columns.some((c) => c.name === `column_${n}`)) n++;
              setSchema([...t.columns.filter((c) => c.name !== ORDERING), { name: `column_${n}`, type: "String" }]);
            }}
            className={buttonClass.secondary}
          >
            <Icon name="plus" className="h-3 w-3" /> Add column
          </button>
        </div>
        {ordering && <p className="text-xs text-muted">Streaming test: the ordering column (a unique long per row across all test inputs) sets the order rows are emitted in; it is not part of the data.</p>}
        <div className="max-h-[45vh] overflow-auto rounded-md border border-line">
          <table className="min-w-full border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 bg-panel">
              <tr>
                <th className="w-8 border-b border-r border-line" />
                {t.columns.map((c, k) => (
                  <th key={k} className="min-w-32 border-b border-r border-line p-1 text-left font-normal">
                    <input
                      defaultValue={c.name}
                      disabled={c.name === ORDERING && ordering}
                      onBlur={(e) => {
                        const name = e.target.value.trim();
                        if (!name || name === c.name || t.columns.some((x) => x.name === name)) return;
                        setT({ columns: t.columns.map((x, j) => (j === k ? { ...x, name } : x)), rows: t.rows.map((r) => Object.fromEntries(Object.entries(r).map(([key, v]) => [key === c.name ? name : key, v]))) });
                      }}
                      className="w-full bg-transparent px-1 font-medium outline-none"
                    />
                    <div className="flex gap-1">
                      <select
                        value={c.type}
                        onChange={(e) => setT({ ...t, columns: t.columns.map((x, j) => (j === k ? { ...x, type: e.target.value as ColType } : x)) })}
                        className="w-full rounded border border-line-2 bg-ink px-1 text-[10px] text-muted"
                      >
                        {COL_TYPES.map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                      {!(c.name === ORDERING && ordering) && (
                        <button type="button" onClick={() => setSchema(t.columns.filter((_, j) => j !== k))} className="text-muted hover:text-bad">
                          <Icon name="x" className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((r, i) => (
                <tr key={i}>
                  <td className="border-b border-r border-line px-1 text-right text-muted">
                    <button type="button" title="Remove row" onClick={() => setT({ ...t, rows: t.rows.filter((_, j) => j !== i) })} className="hover:text-bad">
                      {i + 1}
                    </button>
                  </td>
                  {t.columns.map((c) => (
                    <td key={c.name} className="border-b border-r border-line p-0">
                      <input
                        value={r[c.name] === null || r[c.name] === undefined ? "" : String(r[c.name])}
                        placeholder="null"
                        onChange={(e) => setT({ ...t, rows: t.rows.map((x, j) => (j === i ? { ...x, [c.name]: e.target.value === "" ? null : castCell(e.target.value, c.type) } : x)) })}
                        className="w-full bg-transparent px-1.5 py-1 outline-none placeholder:italic placeholder:text-muted focus:bg-panel-2"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2 p-1">
            <button
              type="button"
              onClick={() => setT({ ...t, rows: [...t.rows, Object.fromEntries(t.columns.map((c) => [c.name, c.name === ORDERING && ordering ? t.rows.length + 1 : null]))] })}
              className="rounded px-2 py-1 text-xs text-ocean hover:bg-panel-2"
            >
              + Add row
            </button>
            <textarea
              placeholder="…or paste rows (tab-separated, e.g. from a spreadsheet)"
              rows={1}
              onPaste={(e) => {
                e.preventDefault();
                paste(e.clipboardData.getData("text"));
              }}
              className="min-w-0 flex-1 resize-none rounded border border-line-2 bg-ink px-2 py-1 text-xs"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!t.columns.length} onClick={() => onApply(t)} className={buttonClass.primary}>
            Apply
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- unit tests

export function UnitTestsPanel({
  pipeline,
  onNew,
  onEdit,
  change,
  onShowResult,
  onClose,
}: {
  pipeline: Pipeline;
  onNew: () => void;
  onEdit: (id: string) => void;
  change: (fn: (p: Pipeline) => Pipeline) => void;
  onShowResult: (r: { name: string; run: TestRun }) => void;
  onClose: () => void;
}) {
  const sql = useSqlEngine(true);
  const tests = pipeline.unitTests ?? [];
  const run = (t: UnitTest) => {
    const r = runUnitTest(pipeline, t, sql);
    change((p) => ({ ...p, unitTests: (p.unitTests ?? []).map((x) => (x.id === t.id ? { ...x, lastRun: { at: new Date().toISOString(), ok: r.ok, results: r.results.map((y) => ({ node: y.node, ok: y.ok, message: y.message })) } } : x)) }));
    onShowResult({ name: t.name, run: r });
  };
  return (
    <Panel
      title="Unit tests"
      icon="check"
      onClose={onClose}
      actions={
        <button type="button" onClick={onNew} className={`${buttonClass.primary} px-2 py-1 text-xs`}>
          <Icon name="plus" className="h-3 w-3" /> New test
        </button>
      }
    >
      <p className="border-b border-line px-3 py-2 text-[11px] text-muted">Check that transforms produce the expected outputs for predefined inputs. Proposals check the tests pass before merging.</p>
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {!tests.length && (
          <li className="flex flex-col items-center gap-2 py-6 text-center text-xs text-muted">
            No unit tests yet.
            <button type="button" onClick={onNew} className={buttonClass.secondary}>
              Create new test
            </button>
          </li>
        )}
        {tests.map((t) => (
          <li key={t.id} className="rounded-md border border-line bg-panel-2 p-2.5 text-xs">
            <div className="flex items-center gap-2">
              <Icon name={t.lastRun ? (t.lastRun.ok ? "check" : "alert") : "clock"} className={`h-3.5 w-3.5 ${t.lastRun ? (t.lastRun.ok ? "text-ok" : "text-bad") : "text-muted"}`} />
              <span className="min-w-0 flex-1 truncate font-medium text-white">{t.name}</span>
              <button type="button" title="Edit test" onClick={() => onEdit(t.id)} className="rounded p-0.5 text-muted hover:text-white">
                <Icon name="pencil" className="h-3.5 w-3.5" />
              </button>
              <DropMenu
                label=""
                hideLabel
                icon="dots"
                align="right"
                buttonClass="rounded p-0.5 text-muted hover:text-white"
                items={[{ icon: "trash", label: "Delete test case", danger: true, run: async () => (await confirmDialog(`Delete "${t.name}"?`)) && change((p) => ({ ...p, unitTests: (p.unitTests ?? []).filter((x) => x.id !== t.id) })) }]}
              />
            </div>
            <p className="mt-1 text-muted">
              {t.nodes.length} transform{t.nodes.length === 1 ? "" : "s"} · {Object.keys(t.inputs).length} inputs · {Object.keys(t.expected).length} expected outputs
            </p>
            {t.lastRun && (
              <p className={`mt-0.5 ${t.lastRun.ok ? "text-ok" : "text-bad"}`}>
                {t.lastRun.ok ? "Passed" : "Failed"} {when(t.lastRun.at)}
              </p>
            )}
            <div className="mt-1.5 flex gap-1.5">
              <button type="button" onClick={() => run(t)} className={`${buttonClass.primary} py-0.5 text-xs`}>
                <Icon name="play" className="h-3 w-3" /> Run test
              </button>
              {t.lastRun && (
                <button type="button" onClick={() => onShowResult({ name: t.name, run: runUnitTest(pipeline, t, sql) })} className={`${buttonClass.secondary} py-0.5 text-xs`}>
                  View test result
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Configuration window of one unit test: inputs (green), tested transforms (yellow), expected outputs (blue). */
export function UnitTestEditor({
  pipeline,
  test,
  result,
  onSave,
  onReselect,
  onClose,
}: {
  pipeline: Pipeline;
  test: UnitTest;
  result: (ref: string) => NodeResult;
  onSave: (t: UnitTest) => void;
  onReselect: () => void;
  onClose: () => void;
}) {
  const [t, setT] = useState(test);
  const [edit, setEdit] = useState<{ kind: "input" | "expected"; ref: string } | null>(null);
  const [run, setRun] = useState<TestRun | null>(null);
  const [view, setView] = useState<string | null>(null);
  const sql = useSqlEngine(true);
  const nodeIds = withNodesBetween(pipeline, t.nodes);
  const { inputs, outputs } = testShape(pipeline, nodeIds);
  const streaming = pipeline.type === "streaming";
  const card = (key: string, tone: string, label: string, sub: string, onClick?: () => void) => (
    <button key={key} type="button" onClick={onClick} disabled={!onClick} className={`w-full rounded-md border-l-4 bg-panel p-2 text-left text-xs shadow ${tone} ${onClick ? "hover:bg-panel-2" : ""}`}>
      <span className="block truncate font-medium text-white">{label}</span>
      <span className="block text-muted">{sub}</span>
    </button>
  );
  const shown = run?.results.find((r) => r.node === view) ?? run?.results[0];
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4 text-sm">
        <Icon name="check" className="h-4 w-4 text-ocean" />
        <input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} className="w-64 rounded-md border border-line-2 bg-ink px-2 py-1 outline-none focus:border-ocean" aria-label="Test name" />
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onReselect} className={buttonClass.secondary}>
            Re-select
          </button>
          <button
            type="button"
            onClick={() => {
              const r = runUnitTest(pipeline, t, sql);
              setRun(r);
              setT({ ...t, lastRun: { at: new Date().toISOString(), ok: r.ok, results: r.results.map((y) => ({ node: y.node, ok: y.ok, message: y.message })) } });
            }}
            className={buttonClass.primary}
          >
            <Icon name="play" className="h-3.5 w-3.5" /> Run test
          </button>
          <button
            type="button"
            onClick={() => {
              onSave(t);
              onClose();
            }}
            className={buttonClass.secondary}
          >
            Close unit test
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="dot-grid min-h-0 flex-1 overflow-auto p-6">
          <div className="mx-auto grid max-w-4xl grid-cols-3 gap-6">
            <div className="space-y-2">
              <div className="text-xs font-medium text-ok">Test inputs</div>
              {inputs.map((ref) =>
                card(ref, "border-ok", refLabel(pipeline.nodes, ref), t.inputs[ref] ? `${t.inputs[ref].rows.length} rows · ${t.inputs[ref].columns.length} columns` : "Click to fill in", () => setEdit({ kind: "input", ref })),
              )}
              {!inputs.length && <p className="text-xs text-muted">The tested nodes read nothing from outside.</p>}
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-sand">Tested transforms</div>
              {pipeline.nodes.filter((n) => nodeIds.includes(n.id)).map((n) => card(n.id, "border-sand", n.name, test.nodes.includes(n.id) ? n.kind : `${n.kind} · added between tested nodes`))}
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-ocean">Expected outputs</div>
              {outputs.map((id) =>
                card(id, "border-ocean", pipeline.nodes.find((n) => n.id === id)?.name ?? id, t.expected[id] ? `${t.expected[id].rows.length} rows · ${t.expected[id].columns.length} columns` : "Fill in the expected output", () => setEdit({ kind: "expected", ref: id })),
              )}
            </div>
          </div>
        </div>
        <aside className="w-72 shrink-0 space-y-2 overflow-y-auto border-l border-line bg-panel p-3 text-xs">
          <div className="font-medium">Test data</div>
          {[...inputs.map((r) => ({ kind: "input" as const, ref: r })), ...outputs.map((r) => ({ kind: "expected" as const, ref: r }))].map((x) => {
            const tbl = x.kind === "input" ? t.inputs[x.ref] : t.expected[x.ref];
            return (
              <div key={x.kind + x.ref} className="flex items-center gap-2 rounded bg-panel-2 px-2 py-1.5">
                <span className={`h-2 w-2 rounded-full ${x.kind === "input" ? "bg-ok" : "bg-ocean"}`} />
                <span className="min-w-0 flex-1 truncate">{refLabel(pipeline.nodes, x.ref)}</span>
                <span className="text-muted">{tbl ? `${tbl.rows.length}×${tbl.columns.length}` : "empty"}</span>
                <button type="button" onClick={() => setEdit(x)} className="text-muted hover:text-white">
                  <Icon name="pencil" className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          {run && (
            <div className="space-y-1 border-t border-line pt-2">
              <div className={`font-medium ${run.ok ? "text-ok" : "text-bad"}`}>{run.ok ? "Test passed" : "Test failed"}</div>
              {run.results.map((r, i) => (
                <button key={i} type="button" onClick={() => setView(r.node)} className={`block w-full text-left ${r.ok ? "text-soft" : "text-bad"} hover:underline`}>
                  {r.message}
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>
      {shown && (shown.received || shown.expected) && (
        <div className="grid h-64 shrink-0 grid-cols-2 border-t border-line">
          <div className="flex min-h-0 flex-col border-r border-line">{shown.expected ? <DataPreview table={shown.expected} title="Expected" /> : <p className="p-3 text-xs text-muted">No expected output.</p>}</div>
          <div className="flex min-h-0 flex-col">{shown.received ? <DataPreview table={shown.received} title="Received" /> : <p className="p-3 text-xs text-muted">Nothing received.</p>}</div>
        </div>
      )}
      {edit && (
        <TestTableEditor
          title={edit.kind === "input" ? `Test input — ${refLabel(pipeline.nodes, edit.ref)}` : `Expected output — ${refLabel(pipeline.nodes, edit.ref)}`}
          initial={edit.kind === "input" ? t.inputs[edit.ref] : t.expected[edit.ref]}
          reuse={result(edit.ref).table?.columns}
          datasets={Object.values(pipeline.datasets)}
          ordering={streaming && edit.kind === "input"}
          onClose={() => setEdit(null)}
          onApply={(tbl) => {
            setT(edit.kind === "input" ? { ...t, inputs: { ...t.inputs, [edit.ref]: tbl } } : { ...t, expected: { ...t.expected, [edit.ref]: tbl } });
            setEdit(null);
          }}
        />
      )}
    </div>
  );
}

export function TestResultView({ name, run }: { name: string; run: TestRun }) {
  const [pick, setPick] = useState(0);
  const r = run.results[pick];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1 text-xs">
        <span className={run.ok ? "text-ok" : "text-bad"}>{name}: {run.ok ? "passed" : "failed"}</span>
        <Tabs value={String(pick)} onChange={(v) => setPick(Number(v))} tabs={run.results.map((x, i) => ({ id: String(i), label: x.message.split(":")[0] || "result", tone: x.ok ? undefined : "bad" }))} />
        <span className="truncate text-muted">{r?.message}</span>
      </div>
      {r && (
        <div className="grid min-h-0 flex-1 grid-cols-2">
          <div className="flex min-h-0 flex-col border-r border-line">{r.expected ? <DataPreview table={r.expected} title="Expected" /> : <p className="p-3 text-xs text-muted">No expected output.</p>}</div>
          <div className="flex min-h-0 flex-col">{r.received ? <DataPreview table={r.received} title="Received" /> : <p className="p-3 text-xs text-muted">Nothing received.</p>}</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- LLM evaluation suites

export function EvalSuitesPanel({ pipeline, onOpen, onNew, onClose }: { pipeline: Pipeline; onOpen: (id: string) => void; onNew: () => void; onClose: () => void }) {
  const suites = pipeline.evalSuites ?? [];
  return (
    <Panel
      title="Evaluation suites"
      icon="sparkle"
      onClose={onClose}
      actions={
        <button type="button" onClick={onNew} className={`${buttonClass.primary} px-2 py-1 text-xs`}>
          <Icon name="plus" className="h-3 w-3" /> New
        </button>
      }
    >
      <p className="border-b border-line px-3 py-2 text-[11px] text-muted">Test Use LLM nodes before deploying: run them on testing data in isolation and compare their answers with evaluators.</p>
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {!suites.length && <li className="py-6 text-center text-xs text-muted">No evaluations yet.</li>}
        {suites.map((s) => (
          <li key={s.id}>
            <button type="button" onClick={() => onOpen(s.id)} className="w-full rounded-md border border-line bg-panel-2 p-2.5 text-left text-xs hover:border-ocean/50">
              <span className="block font-medium text-white">{s.name}</span>
              <span className="block text-muted">
                {pipeline.nodes.find((n) => n.id === s.node)?.name ?? "missing node"} · {s.evaluators.length} evaluators · {s.testData.rows.length} test rows
              </span>
              {s.lastRun && (
                <span className={`block ${s.lastRun.passed === s.lastRun.total ? "text-ok" : "text-warn"}`}>
                  {s.lastRun.passed}/{s.lastRun.total} passed · {when(s.lastRun.at)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function EvaluatorConfig({ e, columns, outputColumn, onApply, onClose }: { e: Evaluator; columns: Column[]; outputColumn: string; onApply: (e: Evaluator) => void; onClose: () => void }) {
  const [x, setX] = useState(e);
  const info = EVALUATOR_INFO[x.kind];
  const range = ["integerRange", "floatRange", "temporalRange", "stringLength"].includes(x.kind);
  return (
    <Modal title={info.label} icon="check" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted">{info.hint}</p>
        <Field label="Actual value">
          <input value={outputColumn} disabled className={inputClass} />
        </Field>
        {info.expected && (
          <Field label="Expected value column" required>
            <select value={x.expected ?? ""} onChange={(ev) => setX({ ...x, expected: ev.target.value })} className={inputClass}>
              <option value="">Choose…</option>
              {columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {range && (
          <div className="flex gap-2">
            <Field label="Minimum">
              <input value={x.min ?? ""} onChange={(ev) => setX({ ...x, min: ev.target.value })} placeholder={x.kind === "temporalRange" ? "2024-01-01" : "0"} className={inputClass} />
            </Field>
            <Field label="Maximum">
              <input value={x.max ?? ""} onChange={(ev) => setX({ ...x, max: ev.target.value })} placeholder={x.kind === "temporalRange" ? "2024-12-31" : "100"} className={inputClass} />
            </Field>
          </div>
        )}
        {x.kind === "levenshtein" && (
          <Field label="Maximum distance">
            <input type="number" min={0} value={x.threshold ?? 0} onChange={(ev) => setX({ ...x, threshold: Number(ev.target.value) })} className={`${inputClass} w-32`} />
          </Field>
        )}
        {x.kind === "keywords" && (
          <Field label="Keywords" hint="Comma separated; all must be present.">
            <input value={(x.keywords ?? []).join(", ")} onChange={(ev) => setX({ ...x, keywords: ev.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} className={inputClass} />
          </Field>
        )}
        {x.kind === "regex" && (
          <Field label="Regular expression">
            <input value={x.pattern ?? ""} onChange={(ev) => setX({ ...x, pattern: ev.target.value })} className={`${inputClass} font-mono`} />
          </Field>
        )}
        {x.kind === "llmJudge" && (
          <>
            <Field label="Condition" hint="A clear, verifiable assertion, e.g. “The summary mentions the food and is at most one sentence.”">
              <textarea value={x.condition ?? ""} onChange={(ev) => setX({ ...x, condition: ev.target.value })} rows={3} className={inputClass} />
            </Field>
            <Field label="Judge model">
              <input value={x.model ?? ""} placeholder="vertex/openai/gpt-oss-120b-maas" onChange={(ev) => setX({ ...x, model: ev.target.value || undefined })} className={inputClass} />
            </Field>
          </>
        )}
        {(x.kind === "exactString" || x.kind === "exactStringArray" || x.kind === "keywords") && (
          <div className="flex gap-6">
            <Switch on={x.matchCase !== false} onChange={(v) => setX({ ...x, matchCase: v })} label="Match case" />
            {x.kind !== "keywords" && <Switch on={!!x.trimWhitespace} onChange={(v) => setX({ ...x, trimWhitespace: v })} label="Trim whitespace" />}
          </div>
        )}
        {(x.kind === "exactStringArray" || x.kind === "exactNumericArray") && <Switch on={x.orderMatters !== false} onChange={(v) => setX({ ...x, orderMatters: v })} label="Order matters" />}
        <Field label="Passing condition">
          <select value={x.passing ?? "match"} onChange={(ev) => setX({ ...x, passing: ev.target.value as Evaluator["passing"] })} className={`${inputClass} w-56`}>
            <option value="match">Passes when it matches</option>
            <option value="no match">Passes when it does not match</option>
          </select>
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Close
          </button>
          <button type="button" disabled={info.expected && !x.expected} onClick={() => onApply(x)} className={buttonClass.primary}>
            Apply
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Evaluation suite configuration: testing data, evaluators, output dataset; Run evaluation suite. */
export function EvalSuiteEditor({
  pipeline,
  suite,
  result,
  onSave,
  onDelete,
  onClose,
}: {
  pipeline: Pipeline;
  suite: EvalSuite;
  result: (ref: string) => NodeResult;
  onSave: (s: EvalSuite) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [s, setS] = useState(suite);
  const [edit, setEdit] = useState<Evaluator | null>(null);
  const [data, setData] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const node = pipeline.nodes.find((n) => n.id === s.node) as LlmNode | undefined;
  const inputCols = node ? (result(node.input).table?.columns ?? []) : [];
  const out = node?.config.outputColumn ?? "llm_output";
  const results: Table | null = useMemo(() => {
    if (!s.lastRun?.rows.length) return null;
    const cols = Object.keys(s.lastRun.rows[0]);
    return { columns: cols.map((c) => ({ name: c, type: (c.endsWith("_pass") || c === "passed" ? "Boolean" : "String") as ColType })), rows: s.lastRun.rows };
  }, [s.lastRun]);

  const run = async () => {
    if (!node) return;
    setError(null);
    setRunning("Running the Use LLM node on the testing data…");
    try {
      const columns = s.testData.columns.map((c) => c.name);
      const calls = s.testData.rows.map((row, i) => ({ ...rowCall(node.config, row, columns, `eval:${s.id}`).call, key: `eval:${s.id}:${i}:${Date.now()}`, fresh: true }));
      const res = await fetch(`${API_URL}/api/pipeline/ai/llm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ calls }) });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { results: Record<string, { value?: unknown; error?: string }> };
      const rows: Row[] = [];
      let passed = 0;
      for (const [i, row] of s.testData.rows.entries()) {
        setRunning(`Evaluating row ${i + 1} of ${s.testData.rows.length}…`);
        const a = body.results[calls[i].key];
        let actual: Cell = null;
        let err = a?.error ?? null;
        if (!err) {
          try {
            actual = coerceAnswer(node.config, a?.value);
          } catch (e) {
            err = (e as Error).message;
          }
        }
        const r: Row = { ...row, [out]: actual, llm_error: err };
        let all = !err;
        for (const e of s.evaluators) {
          const o = await evaluate(e, actual, row);
          r[`${EVALUATOR_INFO[e.kind].label}_pass`] = o.pass;
          r[`${EVALUATOR_INFO[e.kind].label}_reason`] = o.reason;
          all &&= o.pass;
        }
        r.passed = all;
        if (all) passed++;
        rows.push(r);
      }
      const next = { ...s, lastRun: { at: new Date().toISOString(), rows, passed, total: rows.length } };
      setS(next);
      onSave(next);
      if (s.outputDataset?.trim()) {
        setRunning("Writing the evaluation suite output…");
        const cols = Object.keys(rows[0] ?? {}).map((c) => ({ name: c, type: typeof rows[0][c] === "boolean" ? "Boolean" : typeof rows[0][c] === "number" ? "Double" : "String" }));
        await api.pipelineData.deploy({
          name: s.outputDataset.trim(),
          parent_id: pipeline.location?.id ?? null,
          item_id: null,
          mode: "snapshot",
          columns: cols,
          rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c.name, c.type === "String" && r[c.name] !== null && typeof r[c.name] !== "string" ? JSON.stringify(r[c.name]) : r[c.name]]))),
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4 text-sm">
        <Icon name="sparkle" className="h-4 w-4 text-ocean" />
        <span className="text-muted">Evaluation of</span>
        <span className="font-medium">{node?.name ?? "missing node"}</span>
        <input value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} className="ml-auto w-56 rounded-md border border-line-2 bg-ink px-2 py-1 outline-none focus:border-ocean" aria-label="Evaluation name" />
        <button type="button" disabled={!node || !s.testData.rows.length || !!running} onClick={run} className={buttonClass.primary}>
          <Icon name={running ? "refresh" : "play"} className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} /> Run evaluation suite
        </button>
        <button
          type="button"
          onClick={() => {
            onSave(s);
            onClose();
          }}
          className={buttonClass.secondary}
        >
          Close
        </button>
        <button type="button" title="Delete evaluation" onClick={async () => (await confirmDialog("Delete this evaluation?")) && onDelete()} className="rounded p-1 text-muted hover:text-bad">
          <Icon name="trash" className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-5xl grid-cols-2 gap-6 p-6 text-sm">
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-medium">Testing data</span>
              <button type="button" onClick={() => setData(true)} className={`${buttonClass.secondary} py-1 text-xs`}>
                <Icon name="plus" className="h-3 w-3" /> {s.testData.rows.length ? "Edit" : "Add"}
              </button>
            </div>
            <p className="text-xs text-muted">The columns the LLM node reads, plus a column of expected outputs for evaluators that need one.</p>
            <div className="flex h-60 flex-col rounded-md border border-line">
              {s.testData.columns.length ? <DataPreview table={s.testData} title="Testing data" /> : <p className="p-4 text-xs text-muted">No testing data yet.</p>}
            </div>
          </section>
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-medium">Evaluators</span>
              <DropMenu
                label="Add"
                icon="plus"
                align="right"
                width="w-72"
                items={EVALUATORS.map((k: EvaluatorKind) => ({
                  label: EVALUATOR_INFO[k].label,
                  hint: EVALUATOR_INFO[k].hint,
                  run: () => setEdit({ id: uid(), kind: k, matchCase: true, trimWhitespace: false, orderMatters: true, passing: "match" }),
                }))}
              />
            </div>
            <ul className="space-y-1">
              {s.evaluators.map((e) => (
                <li key={e.id} className="flex items-center gap-2 rounded-md border border-line bg-panel-2 px-2.5 py-1.5 text-xs">
                  <span className="flex-1">
                    {EVALUATOR_INFO[e.kind].label}
                    {e.expected ? <span className="text-muted"> · expected {e.expected}</span> : null}
                  </span>
                  <button type="button" onClick={() => setEdit(e)} className="text-muted hover:text-white">
                    <Icon name="pencil" className="h-3 w-3" />
                  </button>
                  <button type="button" onClick={() => setS({ ...s, evaluators: s.evaluators.filter((x) => x.id !== e.id) })} className="text-muted hover:text-bad">
                    <Icon name="x" className="h-3 w-3" />
                  </button>
                </li>
              ))}
              {!s.evaluators.length && <li className="text-xs text-muted">Add evaluators to compare the LLM output with your expectations.</li>}
            </ul>
            <Field label="Evaluation suite output" hint="A dataset (in the pipeline's folder) that stores each run's results.">
              <input value={s.outputDataset ?? ""} onChange={(e) => setS({ ...s, outputDataset: e.target.value })} placeholder={`${s.name} results`} className={inputClass} />
            </Field>
            {node && <p className="text-xs text-muted">Actual value: the node&apos;s output column “{out}” ({effectiveOutputType(node.config)}). Model {node.config.model}.</p>}
          </section>
        </div>
        {running && <p className="text-center text-xs text-muted">{running}</p>}
        {error && <p className="text-center text-xs text-bad">{error}</p>}
      </div>
      <div className="flex h-72 shrink-0 flex-col border-t border-line">
        <div className="border-b border-line px-3 py-1 text-xs">
          Evaluation results{s.lastRun ? ` — ${s.lastRun.passed}/${s.lastRun.total} passed · ${when(s.lastRun.at)}` : ""}
        </div>
        {results ? <DataPreview table={results} title={`${s.name} results`} /> : <p className="p-4 text-center text-xs text-muted">Run the evaluation suite to see results.</p>}
      </div>
      {edit && (
        <EvaluatorConfig
          e={edit}
          columns={s.testData.columns}
          outputColumn={out}
          onClose={() => setEdit(null)}
          onApply={(e) => {
            setS({ ...s, evaluators: s.evaluators.some((x) => x.id === e.id) ? s.evaluators.map((x) => (x.id === e.id ? e : x)) : [...s.evaluators, e] });
            setEdit(null);
          }}
        />
      )}
      {data && (
        <TestTableEditor
          title="Testing data"
          initial={s.testData.columns.length ? s.testData : { columns: [...inputCols, { name: "expected", type: "String" }], rows: [] }}
          reuse={[...inputCols, { name: "expected", type: "String" }]}
          datasets={Object.values(pipeline.datasets)}
          onClose={() => setData(false)}
          onApply={(t) => {
            setS({ ...s, testData: t });
            setData(false);
          }}
        />
      )}
    </div>
  );
}
