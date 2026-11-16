"use client";

import { useMemo, useState } from "react";
import {
  COL_TYPES,
  compileGroup,
  newGroup,
  readFilter,
  sampleTable,
  uid,
  type ColType,
  type ConditionGroup,
  type NodeResult,
  type Parameter,
  type PipelineNode,
  type Sampling,
  type SourceNode,
  type SplitNode,
  type Table,
  type UserPreferences,
} from "@/lib/pipeline";
import { Icon } from "../Icon";
import { DataPreview, TYPE_MARK } from "./DataPreview";
import { GroupBody, MatchSelect } from "./FilterForm";
import { buttonClass, inputClass, Modal } from "./Modal";
import { Field, Switch } from "./ui";
import { confirmDialog } from "@/lib/dialogs";

const MOD = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl";

export const HOTKEYS: { keys: string; action: string; group: string }[] = [
  { group: "Graph", keys: `${MOD}+F`, action: "Open the Search pipeline panel" },
  { group: "Graph", keys: "↑ (Up arrow)", action: "Zoom to fit all nodes" },
  { group: "Graph", keys: `${MOD}+A`, action: "Select all nodes" },
  { group: "Graph", keys: `${MOD}+D`, action: "Select the children of the selected nodes" },
  { group: "Graph", keys: `${MOD}+E`, action: "Select the parents of the selected nodes" },
  { group: "Graph", keys: `${MOD}+H`, action: "Hide the selected nodes" },
  { group: "Graph", keys: `${MOD}+K`, action: "Unhide all hidden nodes" },
  { group: "Graph", keys: `${MOD}+Shift+L`, action: "Lay out the graph automatically" },
  { group: "Graph", keys: "Shift+drag", action: "Select the nodes in a box (drag select)" },
  { group: "Graph", keys: `${MOD}+scroll`, action: "Zoom in and out" },
  { group: "Graph", keys: "Double-click", action: "Edit a node (or a text node)" },
  { group: "Graph", keys: "Delete / Backspace", action: "Remove the selected nodes" },
  { group: "Graph", keys: "Esc", action: "Clear the selection, close a banner" },
  { group: "Editing", keys: `${MOD}+C`, action: "Copy the selected nodes (paste into this or another pipeline)" },
  { group: "Editing", keys: `${MOD}+V`, action: "Paste nodes" },
  { group: "Editing", keys: `${MOD}+Z`, action: "Undo" },
  { group: "Editing", keys: `${MOD}+Shift+Z / ${MOD}+Y`, action: "Redo" },
  { group: "Editing", keys: `${MOD}+S`, action: "Save" },
  { group: "Transform boards", keys: "Shift+↓ / Shift+↑", action: "Select boards (then + to make a custom function)" },
  { group: "Text nodes", keys: `${MOD}+Enter / Esc`, action: "Finish editing a text node" },
];

export function HotkeysDialog({ onClose }: { onClose: () => void }) {
  const groups = [...new Set(HOTKEYS.map((h) => h.group))];
  return (
    <Modal title="Pipeline Builder hotkeys" icon="keyboard" onClose={onClose}>
      <div className="space-y-4 p-4">
        {groups.map((g) => (
          <div key={g}>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{g}</div>
            <table className="w-full text-sm">
              <tbody>
                {HOTKEYS.filter((h) => h.group === g).map((h) => (
                  <tr key={h.keys} className="border-t border-line">
                    <td className="w-48 py-1.5 pr-3">
                      <kbd className="rounded border border-line-2 bg-ink px-1.5 py-0.5 font-mono text-xs">{h.keys}</kbd>
                    </td>
                    <td className="py-1.5 text-soft">{h.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function PreferencesDialog({ prefs, onSave, onClose }: { prefs: UserPreferences; onSave: (p: UserPreferences) => void; onClose: () => void }) {
  const [p, setP] = useState(prefs);
  const radio = <K extends keyof UserPreferences>(key: K, value: UserPreferences[K], label: string, hint: string) => (
    <label className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-panel-2">
      <input type="radio" checked={p[key] === value} onChange={() => setP({ ...p, [key]: value })} className="mt-0.5 accent-[var(--color-ocean)]" />
      <span>
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
    </label>
  );
  return (
    <Modal title="User preferences" icon="sliders" onClose={onClose}>
      <div className="space-y-4 p-4">
        <div>
          <div className="mb-1 text-xs font-medium text-soft">Collapsed transform style</div>
          {radio("collapsedStyle", "summary", "Summary", "Transform nodes show their name, columns and rows.")}
          {radio("collapsedStyle", "pseudocode", "Pseudocode", "Transform nodes also list their boards in a code-like form (not any specific language).")}
        </div>
        <Switch on={!!p.autoName} onChange={(v) => setP({ ...p, autoName: v })} label="Name transform paths automatically" hint="New transform nodes are named after the boards they contain until you rename them." />
        <div>
          <div className="mb-1 text-xs font-medium text-soft">Preview behavior</div>
          {radio("previewMode", "auto", "Run previews automatically", "Selecting a node runs the logic up to it and shows its data.")}
          {radio("previewMode", "confirm", "Require confirmation", "Previews wait for you to select Run preview — useful with large inputs or LLM nodes.")}
        </div>
        <Switch on={!!p.snapToGrid} onChange={(v) => setP({ ...p, snapToGrid: v })} label="Snap nodes to the grid" hint="Dragged nodes align to a 20-pixel grid." />
        <Field label="Your name" hint="Shown as the author of saves, proposals, comments and approvals.">
          <input value={p.userName ?? ""} placeholder="You" onChange={(e) => setP({ ...p, userName: e.target.value })} className={inputClass} />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onSave(p);
              onClose();
            }}
            className={buttonClass.primary}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Pipeline parameters: named values used in any board as {{name}}. */
export function ParametersDialog({ parameters, onSave, onClose }: { parameters: Parameter[]; onSave: (p: Parameter[]) => void; onClose: () => void }) {
  const [list, setList] = useState<Parameter[]>(parameters);
  const bad = list.some((p) => !/^[A-Za-z_][\w.-]*$/.test(p.name)) || new Set(list.map((p) => p.name)).size !== list.length;
  return (
    <Modal title="Parameters" icon="sliders" onClose={onClose} wide>
      <div className="space-y-3 p-4">
        <p className="text-xs text-muted">
          Parameters are values you can use in many transforms. Write <code className="rounded bg-ink px-1">{"{{name}}"}</code> in any value, condition, formula or SQL
          query; changing the parameter here changes every board that uses it.
        </p>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="pb-1 font-medium">Name</th>
              <th className="pb-1 font-medium">Type</th>
              <th className="pb-1 font-medium">Value</th>
              <th className="pb-1 font-medium">Description</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((p, i) => {
              const set = (patch: Partial<Parameter>) => setList(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <tr key={p.id}>
                  <td className="pr-2 pb-1.5">
                    <input value={p.name} onChange={(e) => set({ name: e.target.value })} className={`${inputClass} font-mono text-xs`} />
                  </td>
                  <td className="pr-2 pb-1.5">
                    <select value={p.type} onChange={(e) => set({ type: e.target.value as ColType })} className={`${inputClass} text-xs`}>
                      {COL_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </td>
                  <td className="pr-2 pb-1.5">
                    <input value={p.value} onChange={(e) => set({ value: e.target.value })} className={`${inputClass} text-xs`} />
                  </td>
                  <td className="pr-2 pb-1.5">
                    <input value={p.description ?? ""} onChange={(e) => set({ description: e.target.value })} className={`${inputClass} text-xs`} />
                  </td>
                  <td className="pb-1.5">
                    <button type="button" onClick={() => setList(list.filter((_, j) => j !== i))} className="rounded p-1 text-muted hover:text-bad">
                      <Icon name="trash" className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!list.length && <p className="py-2 text-center text-xs text-muted">No parameters yet.</p>}
        {bad && <p className="text-xs text-bad">Names must be unique and start with a letter or _ (letters, digits, _ . -).</p>}
        <div className="flex justify-between">
          <button type="button" onClick={() => setList([...list, { id: uid(), name: `param${list.length + 1}`, type: "String", value: "" }])} className={buttonClass.secondary}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Add parameter
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={buttonClass.secondary}>
              Cancel
            </button>
            <button
              type="button"
              disabled={bad}
              onClick={() => {
                onSave(list);
                onClose();
              }}
              className={buttonClass.primary}
            >
              Save parameters
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

const SAMPLING_KINDS: { kind: Sampling["kind"]; label: string; hint: string }[] = [
  { kind: "none", label: "No sampling", hint: "Previews read every row." },
  { kind: "first", label: "First rows", hint: "Previews read the first N rows." },
  { kind: "random", label: "Percentage", hint: "Previews read a random percentage of rows (same rows each time)." },
  { kind: "filter", label: "Filtered preview", hint: "Previews read only the rows matching a condition." },
];

/** Input sampling strategies: previews downsample an input; deploys still read everything. */
export function SamplingDialog({
  node,
  sources,
  table,
  onApply,
  onApplyAll,
  onClose,
}: {
  node: SourceNode;
  sources: SourceNode[];
  /** the input's full table */
  table: Table | undefined;
  onApply: (s: Sampling) => void;
  onApplyAll: (s: Sampling) => string[];
  onClose: () => void;
}) {
  const [s, setS] = useState<Sampling>(node.sampling ?? { kind: "none" });
  const [warnings, setWarnings] = useState<string[]>([]);
  const group: ConditionGroup = s.kind === "filter" ? readFilter({ filter: s.filter }) : newGroup();
  let sampled: Table | undefined;
  let error: string | undefined;
  try {
    sampled = table ? sampleTable(table, s) : undefined;
  } catch (e) {
    error = (e as Error).message;
  }
  return (
    <Modal title={`Sampling strategies — ${node.name}`} icon="filter" onClose={onClose} wide>
      <div className="space-y-3 p-4">
        <p className="text-xs text-muted">The strategy applies to every node after this input, in previews only. Deploys always read the full dataset.</p>
        <div className="grid grid-cols-4 gap-1.5">
          {SAMPLING_KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              onClick={() =>
                setS(
                  k.kind === "none"
                    ? { kind: "none" }
                    : k.kind === "first"
                      ? { kind: "first", rows: 1000 }
                      : k.kind === "random"
                        ? { kind: "random", percent: 10, seed: 42 }
                        : { kind: "filter", filter: JSON.stringify(newGroup()) },
                )
              }
              className={`rounded-md border p-2 text-left text-xs ${s.kind === k.kind ? "border-ocean bg-ocean/10" : "border-line-2 hover:border-ocean/50"}`}
            >
              <span className="block font-medium text-white">{k.label}</span>
              <span className="block text-muted">{k.hint}</span>
            </button>
          ))}
        </div>
        {s.kind === "first" && (
          <Field label="Rows">
            <input type="number" min={1} value={s.rows} onChange={(e) => setS({ kind: "first", rows: Math.max(1, Number(e.target.value) || 1) })} className={`${inputClass} w-40`} />
          </Field>
        )}
        {s.kind === "random" && (
          <div className="flex gap-3">
            <Field label="Percent of rows">
              <input type="number" min={0} max={100} step={0.1} value={s.percent} onChange={(e) => setS({ ...s, percent: Number(e.target.value) })} className={`${inputClass} w-32`} />
            </Field>
            <Field label="Seed">
              <input type="number" value={s.seed ?? 42} onChange={(e) => setS({ ...s, seed: Number(e.target.value) })} className={`${inputClass} w-32`} />
            </Field>
          </div>
        )}
        {s.kind === "filter" && (
          <div className="space-y-2 rounded-md border border-line-2 p-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted">Keep rows that match</span>
              <MatchSelect group={group} onChange={(g) => setS({ ...s, filter: JSON.stringify(g) })} />
              <span className="ml-auto text-muted">at most</span>
              <input
                type="number"
                min={0}
                placeholder="all"
                value={s.rows ?? ""}
                onChange={(e) => setS({ ...s, rows: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })}
                className={`${inputClass} w-24 py-1 text-xs`}
              />
              <span className="text-muted">rows</span>
            </div>
            <GroupBody group={group} depth={0} columns={table?.columns ?? []} onChange={(g) => setS({ ...s, filter: JSON.stringify(g) })} />
          </div>
        )}
        <p className={`text-xs ${error ? "text-bad" : "text-muted"}`}>
          {error ?? (table && sampled ? `Previews will read ${sampled.rows.length.toLocaleString()} of ${table.rows.length.toLocaleString()} rows.` : "")}
        </p>
        {warnings.length > 0 && (
          <ul className="space-y-0.5 rounded-md bg-warn/10 p-2 text-xs text-warn">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-between">
          <button
            type="button"
            title={`Apply this strategy to all ${sources.length} inputs`}
            onClick={() => setWarnings(onApplyAll(s))}
            className={buttonClass.secondary}
          >
            Apply to all inputs
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className={buttonClass.secondary}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!!error}
              onClick={() => {
                onApply(s);
                onClose();
              }}
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

const UNARY_SPLIT = new Set(["is null", "is not null"]);
const RANGE_SPLIT = new Set(["is between", "is not between"]);
/** Whether every condition of a group is filled in (an incomplete condition is not an error yet). */
function conditionComplete(g: ConditionGroup): boolean {
  return g.items.every((i) => ("items" in i ? conditionComplete(i) : !!i.left && (UNARY_SPLIT.has(i.op) || !!i.right) && (!RANGE_SPLIT.has(i.op) || !!i.right2)));
}

/** The Split board: a condition sends rows to the True output, the rest to False. */
export function SplitEditor({
  initial,
  input,
  inputName,
  onApply,
  onClose,
}: {
  initial: Pick<SplitNode, "name" | "condition" | "description">;
  input: NodeResult;
  inputName: string;
  onApply: (c: { name: string; condition: string; description?: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [describing, setDescribing] = useState(!!initial.description);
  const [group, setGroup] = useState<ConditionGroup>(() => readFilter({ filter: initial.condition }));
  const [tab, setTab] = useState<"input" | "output" | "errors">("output");
  const [side, setSide] = useState<"true" | "false">("true");
  const [search, setSearch] = useState("");
  const t = input.table;
  const ready = conditionComplete(group);
  const outcome = useMemo((): { error: string } | { incomplete: true } | { yes: Table; no: Table } => {
    if (!t) return { error: input.error ?? "The input is unavailable" };
    if (!ready) return { incomplete: true };
    try {
      const test = compileGroup(t, group);
      const yes = t.rows.filter(test);
      const no = t.rows.filter((r) => !test(r));
      return { yes: { columns: t.columns, rows: yes }, no: { columns: t.columns, rows: no } };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [t, group, input.error, ready]);
  const error = "error" in outcome ? outcome.error : null;
  const dirty =
    name !== initial.name || description !== (initial.description ?? "") || JSON.stringify(group) !== JSON.stringify(readFilter({ filter: initial.condition }));
  const shown = tab === "input" ? t : "yes" in outcome ? (side === "true" ? outcome.yes : outcome.no) : null;
  const columns = (t?.columns ?? []).filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));
  const tabs: ["input" | "output" | "errors", string][] = [
    ["input", "Input table"],
    ["output", "Output table"],
    ["errors", error ? "Errors (1)" : "Errors"],
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* board header: name, description, apply / close */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <label className="flex w-64 items-center gap-2 rounded-md border border-line-2 bg-ink px-2 py-1 focus-within:border-ocean">
          <Icon name="split" className="h-4 w-4 shrink-0 text-ocean" />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Split" className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none" />
        </label>
        <button type="button" onClick={() => setDescribing(!describing)} className={`${buttonClass.ghost} text-xs ${describing ? "text-white" : ""}`}>
          <Icon name="edit" className="h-3.5 w-3.5" /> Description
        </button>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            disabled={!dirty || !name.trim() || !!error || !ready}
            title={!ready ? "Complete every condition first" : undefined}
            onClick={() => onApply({ name: name.trim(), condition: JSON.stringify(group), description: description.trim() || undefined })}
            className={buttonClass.primary}
          >
            <Icon name="check" /> {dirty ? "Apply" : "Applied"}
          </button>
          <button type="button" onClick={async () => (!dirty || (await confirmDialog("Discard the changes you have not applied?"))) && onClose()} className={buttonClass.secondary}>
            <Icon name="x" /> Close
          </button>
        </div>
      </div>

      <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-3 p-5">
          {describing && (
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What this split is for (shown on the node)" className={`${inputClass} text-sm`} />
          )}
          {/* the input */}
          <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-md border border-line-2 bg-panel px-3 py-2 text-sm">
            <Icon name="table" className="h-4 w-4 text-ocean" />
            <span className="truncate font-medium">{inputName}</span>
            <span className="text-xs text-muted">{t ? `${t.columns.length} columns · ${t.rows.length.toLocaleString()} rows` : "unavailable"}</span>
          </div>
          {/* the condition */}
          <div className="rounded-lg border border-line-2 bg-panel shadow-lg">
            <div className="border-b border-line px-4 py-3">
              <div className="text-sm font-semibold">Split on condition</div>
              <p className="mt-0.5 text-xs text-muted">
                Define a condition to partition the input. Rows where the condition is true are sent to the first output (True); rows where it is false — including rows
                where a compared value is null — are sent to the second output (False).
              </p>
            </div>
            <div className="space-y-2 px-4 py-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-soft">Include rows that match</span>
                <MatchSelect group={group} onChange={setGroup} />
              </div>
              <GroupBody group={group} depth={0} columns={t?.columns ?? []} onChange={setGroup} />
            </div>
            <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-xs">
              {error ? (
                <span className="flex items-center gap-1.5 text-bad">
                  <Icon name="alert" className="h-3.5 w-3.5" /> {error}
                </span>
              ) : "yes" in outcome ? (
                <>
                  <span className="rounded-full bg-ok/15 px-2 py-0.5 text-ok">True · {outcome.yes.rows.length.toLocaleString()} rows</span>
                  <span className="rounded-full bg-panel-2 px-2 py-0.5 text-soft ring-1 ring-line-2">False · {outcome.no.rows.length.toLocaleString()} rows</span>
                </>
              ) : (
                <span className="text-muted">Complete the condition to see which rows go to each output.</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* bottom panel: input / output tables and errors */}
      <div className="flex h-80 shrink-0 flex-col border-t border-line bg-ink">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-panel px-2 text-xs">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`rounded px-2.5 py-1 font-medium ${tab === id ? "bg-panel-2 text-white ring-1 ring-line-2" : "text-muted hover:text-white"} ${id === "errors" && error ? "text-bad" : ""}`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "errors" ? (
          <div className="p-4 text-sm">
            {error ? (
              <p className="flex items-center gap-2 text-bad">
                <Icon name="alert" /> {error}
              </p>
            ) : (
              <p className="text-muted">No errors.</p>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <aside className="flex w-60 shrink-0 flex-col border-r border-line">
              {tab === "output" && (
                <label className="flex items-center gap-2 border-b border-line px-2 py-1.5 text-xs">
                  <span className="text-muted">Output</span>
                  <select value={side} onChange={(e) => setSide(e.target.value as "true" | "false")} className={`${inputClass} py-0.5 text-xs`}>
                    <option value="true">True{"yes" in outcome ? ` (${outcome.yes.rows.length.toLocaleString()})` : ""}</option>
                    <option value="false">False{"no" in outcome ? ` (${outcome.no.rows.length.toLocaleString()})` : ""}</option>
                  </select>
                </label>
              )}
              <label className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
                <Icon name="search" className="h-3.5 w-3.5 text-muted" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${t?.columns.length ?? 0} columns…`} className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
              </label>
              <ul className="min-h-0 flex-1 overflow-y-auto py-1 text-xs">
                {columns.map((c) => (
                  <li key={c.name} className="flex items-center gap-2 px-2 py-1 hover:bg-panel">
                    <span className="w-7 shrink-0 text-center font-mono text-[10px] text-muted">{TYPE_MARK[c.type]}</span>
                    <span className="truncate">{c.name}</span>
                  </li>
                ))}
              </ul>
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
              {shown ? (
                <DataPreview table={shown} title={tab === "input" ? inputName : `${name || "Split"} (${side === "true" ? "True" : "False"})`} />
              ) : (
                <p className="m-auto text-sm text-muted">{error ? "No preview: fix the error first." : "Complete the condition to preview the outputs."}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Nodes a new node can read: anything but itself and what depends on it. */
export const candidateInputs = (nodes: PipelineNode[], self?: string) => nodes.filter((n) => n.id !== self && n.kind !== "input");
