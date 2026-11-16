"use client";

import { useMemo, useState } from "react";
import {
  JOIN_HOWS,
  JOIN_OPS,
  joinKeys,
  joinTables,
  type Column,
  type JoinHow,
  type JoinKey,
  type JoinNode,
  type JoinOp,
  type NodeResult,
  type PipelineNode,
  type Table,
} from "@/lib/pipeline";
import { Icon } from "../Icon";
import { DataPreview, TYPE_MARK } from "./DataPreview";
import { buttonClass, inputClass } from "./Modal";
import { confirmDialog } from "@/lib/dialogs";

export type JoinConfig = Pick<JoinNode, "name" | "left" | "right" | "leftKey" | "rightKey" | "keys" | "how" | "leftColumns" | "rightColumns" | "rightPrefix">;

const JOIN_LABEL: Record<JoinHow, string> = {
  inner: "Inner join",
  left: "Left join",
  right: "Right join",
  outer: "Outer join",
  "left semi": "Left semi join",
  "left anti": "Left anti join",
  cross: "Cross join",
};
const JOIN_HELP: Record<JoinHow, string> = {
  inner: "Joins two datasets together, keeping only rows which satisfy the provided condition in both tables.",
  left: "Joins two datasets together, keeping all rows from the left table and only rows which satisfy the provided condition from the right table.",
  right: "Joins two datasets together, keeping all rows from the right table and only rows which satisfy the provided condition from the left table.",
  outer: "Joins two datasets together, keeping all rows from both tables; columns are null where there is no match.",
  "left semi": "Keeps the rows of the left table that have a match in the right table (like WHERE EXISTS). Only left columns are kept.",
  "left anti": "Keeps the rows of the left table that have no match in the right table (like WHERE NOT EXISTS). Only left columns are kept.",
  cross: "Pairs every row of the left table with every row of the right table.",
};
const OP_LABEL: Record<JoinOp, string> = {
  // null-safe: rows with null keys match each other
  "<=>": "is equal to",
  "!<=>": "is not equal to",
  "=": "is equal to (not null safe)",
  "!=": "is not equal to (not null safe)",
  "<": "is less than",
  "<=": "is at most",
  ">": "is greater than",
  ">=": "is at least",
};

type Tab = "left" | "right" | "joined" | "errors";

/** Right columns chosen by default: all but the = keys (their values are already on the left). */
const defaultRight = (right: Table | undefined, keys: JoinKey[]) =>
  right ? right.columns.map((c) => c.name).filter((n) => !keys.some((k) => ((k.op ?? "=") === "=" || k.op === "<=>") && k.right === n)) : null;

export function JoinEditor({
  initial,
  isNew,
  nodes,
  result,
  onApply,
  onClose,
}: {
  initial: JoinConfig;
  isNew: boolean;
  /** nodes that can be inputs */
  nodes: PipelineNode[];
  result: (id: string) => NodeResult;
  onApply: (c: JoinConfig) => void;
  onClose: () => void;
}) {
  const [c, setC] = useState<JoinConfig>(() => {
    const keys = joinKeys(initial);
    return { ...initial, keys: keys.length ? keys : [{ left: "", right: "", op: "<=>" }] };
  });
  // a new join keeps the default right columns in step with the keys until the user picks columns
  const [rightTouched, setRightTouched] = useState(!isNew);
  const [tab, setTab] = useState<Tab>("joined");
  const set = (patch: Partial<JoinConfig>) => setC((prev) => ({ ...prev, ...patch }));

  const leftR = c.left ? result(c.left) : undefined;
  const rightR = c.right ? result(c.right) : undefined;
  const leftT = leftR?.table;
  const rightT = rightR?.table;
  const keys = useMemo(() => c.keys ?? [], [c.keys]);
  const cross = c.how === "cross";
  const semi = c.how === "left semi" || c.how === "left anti";

  // what Apply saves
  const effective: JoinConfig = useMemo(() => {
    const complete = cross ? [] : keys.filter((k) => k.left && k.right);
    return {
      ...c,
      name: c.name.trim(),
      keys: complete,
      leftKey: complete[0]?.left ?? "",
      rightKey: complete[0]?.right ?? "",
      leftColumns: c.leftColumns ?? null,
      rightColumns: rightTouched ? (c.rightColumns ?? null) : defaultRight(rightT, complete),
      rightPrefix: c.rightPrefix ?? "",
    };
  }, [c, cross, keys, rightTouched, rightT]);

  const joined = useMemo((): { table?: Table; error?: string } => {
    if (!leftT || !rightT) return { error: !c.left || !c.right ? "Choose both input tables" : (leftR?.error ?? rightR?.error) };
    if (!cross && !effective.keys?.length) return { error: "Add a match condition" };
    try {
      return { table: joinTables(leftT, rightT, effective) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [leftT, rightT, effective, cross, c.left, c.right, leftR, rightR]);

  // right columns renamed because the name is already taken on the left
  const renamed = useMemo(() => {
    if (!joined.table || !rightT || semi) return [];
    const prefix = effective.rightPrefix ?? "";
    const chosen = effective.rightColumns ?? rightT.columns.map((x) => x.name);
    const outNames = new Set(joined.table.columns.map((x) => x.name));
    return chosen.filter((n) => !outNames.has(prefix + n)).map((n) => `${prefix}${n}`);
  }, [joined.table, rightT, effective, semi]);

  // same-named columns not yet matched, e.g. variation_id with variation_id
  const suggestions = useMemo(() => {
    if (!leftT || !rightT || cross) return [];
    return leftT.columns
      .filter((l) => rightT.columns.some((r) => r.name === l.name) && !keys.some((k) => k.left === l.name && k.right === l.name))
      .map((l) => l.name)
      .slice(0, 3);
  }, [leftT, rightT, keys, cross]);

  const setKey = (i: number, patch: Partial<JoinKey>) => set({ keys: keys.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  const suggest = (name: string) => {
    const empty = keys.findIndex((k) => !k.left && !k.right);
    const key = { left: name, right: name, op: "<=>" as JoinOp };
    set({ keys: empty >= 0 ? keys.map((k, j) => (j === empty ? key : k)) : [...keys, key] });
  };

  const valid = !!effective.name && !!c.left && !!c.right && c.left !== c.right && (cross || (!!effective.keys?.length && effective.keys.length === keys.length));
  const dirty = isNew || JSON.stringify(effective) !== JSON.stringify({ ...initial, keys: joinKeys(initial), leftColumns: initial.leftColumns ?? null, rightColumns: initial.rightColumns ?? null, rightPrefix: initial.rightPrefix ?? "" });

  const close = async () => {
    if (dirty && !isNew && !(await confirmDialog("Discard the changes you have not applied?"))) return;
    onClose();
  };

  const nodeOptions = (exclude: string) => nodes.filter((n) => n.id !== exclude);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <Icon name="join" className="h-4 w-4 text-ocean" />
        <input
          value={c.name}
          onChange={(e) => set({ name: e.target.value })}
          className="w-64 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium outline-none hover:border-line-2 focus:border-ocean"
        />
        <div className="ml-auto flex gap-2">
          <button type="button" disabled={!valid || !dirty} onClick={() => onApply(effective)} className={buttonClass.primary}>
            <Icon name="check" /> {isNew ? "Apply" : dirty ? "Apply" : "Applied"}
          </button>
          <button type="button" onClick={close} className={buttonClass.secondary}>
            <Icon name="x" /> Close
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl divide-y divide-line px-5 text-sm">
          <Section label="Join type">
            <div className="flex flex-wrap items-center gap-3">
              <select value={c.how} onChange={(e) => set({ how: e.target.value as JoinHow })} className={`${inputClass} w-44`}>
                {JOIN_HOWS.map((h) => (
                  <option key={h} value={h}>
                    {JOIN_LABEL[h]}
                  </option>
                ))}
              </select>
              <span className="min-w-0 flex-1 text-xs text-muted">{JOIN_HELP[c.how]}</span>
            </div>
          </Section>

          <Section label="Input tables">
            <div className="flex flex-wrap items-center gap-2">
              <NodeSelect nodes={nodeOptions(c.right)} value={c.left} onChange={(left) => set({ left, leftColumns: null })} />
              <button
                type="button"
                onClick={() => {
                  set({
                    left: c.right,
                    right: c.left,
                    keys: keys.map((k) => ({ left: k.right, right: k.left, op: flip(k.op ?? "=") })),
                    leftColumns: null,
                    rightColumns: null,
                  });
                  setRightTouched(false);
                }}
                className={buttonClass.secondary}
              >
                <Icon name="refresh" className="h-3.5 w-3.5" /> Swap
              </button>
              <NodeSelect
                nodes={nodeOptions(c.left)}
                value={c.right}
                onChange={(right) => {
                  set({ right, rightColumns: null });
                  setRightTouched(false);
                }}
              />
            </div>
          </Section>

          {!cross && (
            <Section label="Match condition">
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span className="rounded bg-panel-2 px-1.5 py-0.5 ring-1 ring-line-2">rows</span> that match all conditions
                </div>
                {keys.map((k, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <ColumnSelect columns={leftT?.columns ?? []} value={k.left} onChange={(left) => setKey(i, { left })} placeholder="Select a left column" />
                    <select value={k.op ?? "="} onChange={(e) => setKey(i, { op: e.target.value as JoinOp })} className={`${inputClass} w-36`}>
                      {JOIN_OPS.map((op) => (
                        <option key={op} value={op}>
                          {OP_LABEL[op]}
                        </option>
                      ))}
                    </select>
                    <ColumnSelect columns={rightT?.columns ?? []} value={k.right} onChange={(right) => setKey(i, { right })} placeholder="Select a right column" />
                    {keys.length > 1 && (
                      <button type="button" title="Remove condition" onClick={() => set({ keys: keys.filter((_, j) => j !== i) })} className="rounded p-1 text-muted hover:bg-bad/10 hover:text-bad">
                        <Icon name="x" className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
                {suggestions.map((s) => (
                  <button key={s} type="button" onClick={() => suggest(s)} className="block text-xs text-ocean underline decoration-dotted underline-offset-2">
                    Suggestion: {s} could be matched with {s}
                  </button>
                ))}
                <button type="button" onClick={() => set({ keys: [...keys, { left: "", right: "", op: "<=>" }] })} className={buttonClass.secondary}>
                  <Icon name="plus" className="h-3.5 w-3.5" /> Add match condition
                </button>
              </div>
            </Section>
          )}

          <Section label="Select columns">
            <div className={`grid gap-4 ${semi ? "" : "md:grid-cols-2"}`}>
              <div>
                <div className="mb-1.5 text-xs font-medium text-soft">Left: {nodes.find((n) => n.id === c.left)?.name ?? "—"}</div>
                <ColumnChecklist
                  columns={leftT?.columns ?? []}
                  selected={c.leftColumns ?? null}
                  onChange={(leftColumns) => set({ leftColumns })}
                  autoLabel="Auto-select all left columns"
                />
              </div>
              {semi ? (
                <p className="text-xs text-muted">{JOIN_LABEL[c.how]} keeps only the left columns.</p>
              ) : (
                <div>
                  <div className="mb-1.5 text-xs font-medium text-soft">Right: {nodes.find((n) => n.id === c.right)?.name ?? "—"}</div>
                  <input
                    value={c.rightPrefix ?? ""}
                    onChange={(e) => set({ rightPrefix: e.target.value })}
                    placeholder="Prefix right columns"
                    className={`${inputClass} mb-1.5`}
                  />
                  <ColumnChecklist
                    columns={rightT?.columns ?? []}
                    selected={effective.rightColumns ?? null}
                    onChange={(rightColumns) => {
                      setRightTouched(true);
                      set({ rightColumns });
                    }}
                    autoLabel="Auto-select all right columns"
                    prefix={c.rightPrefix ?? ""}
                  />
                </div>
              )}
            </div>
          </Section>
        </div>
      </div>

      <div className="flex h-72 shrink-0 flex-col border-t border-line bg-ink">
        <div className="flex shrink-0 items-center gap-1 border-b border-line bg-panel px-2 text-xs">
          {(
            [
              ["left", "Left input table"],
              ["right", "Right input table"],
              ["joined", "Joined table"],
              ["errors", `Errors${joined.error || renamed.length ? ` (${(joined.error ? 1 : 0) + (renamed.length ? 1 : 0)})` : ""}`],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-2.5 py-2 ${tab === t ? "border-b-2 border-ocean text-white" : "text-muted hover:text-white"} ${t === "errors" && joined.error ? "text-bad" : ""}`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "errors" ? (
          <div className="space-y-2 p-4 text-sm">
            {joined.error && (
              <p className="flex items-center gap-2 text-bad">
                <Icon name="alert" className="h-4 w-4 shrink-0" /> {joined.error}
              </p>
            )}
            {renamed.length > 0 && (
              <p className="flex items-center gap-2 text-warn">
                <Icon name="alert" className="h-4 w-4 shrink-0" /> {renamed.join(", ")} also exist{renamed.length === 1 ? "s" : ""} on the left, so the right
                column{renamed.length === 1 ? " gets" : "s get"} a _right suffix — set a prefix to name them yourself.
              </p>
            )}
            {!joined.error && !renamed.length && <p className="text-muted">No errors.</p>}
          </div>
        ) : (
          (() => {
            const t = tab === "left" ? leftT : tab === "right" ? rightT : joined.table;
            const name = tab === "left" ? "Left input" : tab === "right" ? "Right input" : c.name || "Joined table";
            if (t?.files) return <p className="p-6 text-center text-sm text-muted">Extract rows from the files before joining them.</p>;
            return t ? (
              <DataPreview table={t} title={name} />
            ) : (
              <p className="flex items-center justify-center gap-2 p-6 text-sm text-muted">
                {tab === "joined" && joined.error ? (
                  <>
                    <Icon name="alert" className="h-4 w-4 text-bad" /> {joined.error}
                  </>
                ) : (
                  "Choose the input table."
                )}
              </p>
            );
          })()
        )}
      </div>
    </div>
  );
}

const flip = (op: JoinOp): JoinOp => (op === "<" ? ">" : op === ">" ? "<" : op === "<=" ? ">=" : op === ">=" ? "<=" : op);

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] items-start gap-4 py-4">
      <span className="pt-1.5 text-xs font-medium text-soft">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function NodeSelect({ nodes, value, onChange }: { nodes: PipelineNode[]; value: string; onChange: (id: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputClass} w-64`}>
      <option value="">Choose a dataset…</option>
      {nodes.map((n) => (
        <option key={n.id} value={n.id}>
          {n.name}
        </option>
      ))}
    </select>
  );
}

function ColumnSelect({ columns, value, onChange, placeholder }: { columns: Column[]; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputClass} w-64`}>
      <option value="">{placeholder}</option>
      {value && !columns.some((c) => c.name === value) && <option value={value}>{value} (missing)</option>}
      {columns.map((c) => (
        <option key={c.name} value={c.name}>
          {TYPE_MARK[c.type]} {c.name}
        </option>
      ))}
    </select>
  );
}

/** Inline checklist of columns: auto-select all, search, selected / not selected filters, select all / deselect all. */
function ColumnChecklist({
  columns,
  selected,
  onChange,
  autoLabel,
  prefix = "",
}: {
  columns: Column[];
  /** null = all (auto) */
  selected: string[] | null;
  onChange: (v: string[] | null) => void;
  autoLabel: string;
  prefix?: string;
}) {
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<"all" | "selected" | "unselected">("all");
  const auto = selected === null;
  const chosen = new Set(auto ? columns.map((c) => c.name) : selected);
  const visible = columns.filter(
    (c) => (prefix + c.name).toLowerCase().includes(query.toLowerCase()) && (show === "all" || (show === "selected") === chosen.has(c.name)),
  );
  // keep the input's order
  const write = (names: Set<string>) => onChange(columns.map((c) => c.name).filter((n) => names.has(n)));
  const toggle = (name: string) => {
    const next = new Set(chosen);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    write(next);
  };
  const filterClass = (on: boolean) =>
    `flex items-center gap-1 rounded border px-2 py-0.5 ${on ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-soft hover:border-ocean/50"}`;

  return (
    <div className="text-xs">
      <label className="mb-1.5 flex cursor-pointer items-center gap-2 text-soft">
        <input type="checkbox" checked={auto} onChange={(e) => onChange(e.target.checked ? null : columns.map((c) => c.name))} className="accent-[var(--color-ocean)]" />
        {autoLabel}
      </label>
      <div className="overflow-hidden rounded-md border border-line-2">
        <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
          <Icon name="search" className="h-3.5 w-3.5 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search for columns…" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5">
          <span className="font-medium">
            {chosen.size} of {columns.length} columns selected
          </span>
          <button type="button" onClick={() => setShow(show === "selected" ? "all" : "selected")} className={filterClass(show === "selected")}>
            Selected
          </button>
          <button type="button" onClick={() => setShow(show === "unselected" ? "all" : "unselected")} className={filterClass(show === "unselected")}>
            Not selected
          </button>
          <span className="ml-auto flex overflow-hidden rounded border border-line-2">
            <button
              type="button"
              disabled={auto}
              onClick={() => write(new Set([...chosen, ...visible.map((c) => c.name)]))}
              className="px-2 py-0.5 text-ocean hover:bg-panel-2 disabled:text-muted disabled:opacity-50"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => write(new Set([...chosen].filter((n) => !visible.some((c) => c.name === n))))}
              className="border-l border-line-2 px-2 py-0.5 text-ocean hover:bg-panel-2"
            >
              Deselect all
            </button>
          </span>
        </div>
        <ul className="max-h-56 overflow-y-auto py-1">
          {!columns.length && <li className="px-3 py-2 text-muted">Choose the input table first.</li>}
          {columns.length > 0 && !visible.length && <li className="px-3 py-2 text-muted">No matching columns.</li>}
          {visible.map((c) => {
            const on = chosen.has(c.name);
            return (
              <li key={c.name}>
                <button
                  type="button"
                  onClick={() => toggle(c.name)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel-2 ${on ? "bg-ocean/10 text-ocean" : "text-soft"}`}
                >
                  <span className="truncate">
                    {prefix && <span className="opacity-60">{prefix}</span>}
                    {c.name}
                  </span>
                  <span className="ml-auto rounded bg-panel px-1.5 py-0.5 text-[10px] text-muted ring-1 ring-line-2">{c.type}</span>
                  <Icon name="check" className={`h-3.5 w-3.5 shrink-0 ${on ? "" : "invisible"}`} />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
