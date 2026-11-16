"use client";

import { useEffect, useRef, useState } from "react";
import {
  COL_TYPES,
  FILTER_MODES,
  FILTER_OPS,
  isGroup,
  LIST_OPS,
  newCondition,
  newGroup,
  RANGE_OPS,
  readCases,
  readFilter,
  uid,
  UNARY_OPS,
  type ColType,
  type Column,
  type Condition,
  type ConditionGroup,
  type FilterOp,
  type Operand,
  type CaseSpec,
  type Params,
} from "@/lib/pipeline";
import { Icon } from "../Icon";
import { TYPE_MARK } from "./DataPreview";

const MAX_DEPTH = 2;
const selectClass =
  "rounded-md border border-line-2 bg-panel-2 px-2 py-1 text-xs outline-none hover:border-ocean/50 focus:border-ocean";

/** Editor for the filter step: keep/remove rows matching a tree of conditions. */
export function FilterForm({
  params,
  columns,
  onChange,
}: {
  params: Params;
  columns: Column[];
  onChange: (p: Params) => void;
}) {
  const root = readFilter(params);
  const mode = typeof params.mode === "string" && params.mode ? params.mode : FILTER_MODES[0];
  const save = (next: { mode?: string; root?: ConditionGroup }) =>
    onChange({ mode: next.mode ?? mode, filter: JSON.stringify(next.root ?? root) });

  return (
    <div className="space-y-2 border-t border-line px-3 py-3">
      <div className="flex items-center gap-2 text-xs">
        <select value={mode} onChange={(e) => save({ mode: e.target.value })} className={selectClass}>
          {FILTER_MODES.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <span className="text-muted">that match</span>
        <MatchSelect group={root} onChange={(g) => save({ root: g })} />
      </div>
      <GroupBody group={root} depth={0} columns={columns} onChange={(g) => save({ root: g })} />
    </div>
  );
}

export function MatchSelect({ group, onChange }: { group: ConditionGroup; onChange: (g: ConditionGroup) => void }) {
  return (
    <select
      value={group.match}
      onChange={(e) => onChange({ ...group, match: e.target.value as ConditionGroup["match"] })}
      className={selectClass}
    >
      <option value="all">all conditions</option>
      <option value="any">any condition</option>
    </select>
  );
}

export function GroupBody({
  group,
  depth,
  columns,
  onChange,
}: {
  group: ConditionGroup;
  depth: number;
  columns: Column[];
  onChange: (g: ConditionGroup) => void;
}) {
  const setItem = (id: string, item: Condition | ConditionGroup | null) =>
    onChange({
      ...group,
      items: item ? group.items.map((i) => (i.id === id ? item : i)) : group.items.filter((i) => i.id !== id),
    });

  return (
    <div className="ml-2 space-y-1.5 border-l border-line-2 pl-3">
      {group.items.map((item, i) => (
        <div key={item.id} className="flex items-start gap-2">
          <span className="w-8 shrink-0 pt-1.5 text-right text-[11px] text-muted">
            {i === 0 ? "" : group.match === "any" ? "Or" : "And"}
          </span>
          <div className="min-w-0 flex-1">
            {isGroup(item) ? (
              <div className="rounded-md border border-line-2 bg-ink/40 p-2">
                <div className="mb-1.5 flex items-center gap-2 text-xs">
                  <span className="text-muted">Group that matches</span>
                  <MatchSelect group={item} onChange={(g) => setItem(item.id, g)} />
                  <RemoveButton title="Remove group" onClick={() => setItem(item.id, null)} />
                </div>
                <GroupBody group={item} depth={depth + 1} columns={columns} onChange={(g) => setItem(item.id, g)} />
              </div>
            ) : (
              <ConditionRow
                condition={item}
                columns={columns}
                onChange={(c) => setItem(item.id, c)}
                onRemove={group.items.length > 1 || depth > 0 ? () => setItem(item.id, null) : undefined}
              />
            )}
          </div>
        </div>
      ))}
      <div className="flex gap-2 pl-10 pt-0.5">
        <AddButton label="Add condition" onClick={() => onChange({ ...group, items: [...group.items, newCondition()] })} />
        {depth < MAX_DEPTH && (
          <AddButton label="Add condition group" onClick={() => onChange({ ...group, items: [...group.items, newGroup()] })} />
        )}
      </div>
    </div>
  );
}

function ConditionRow({
  condition: c,
  columns,
  onChange,
  onRemove,
}: {
  condition: Condition;
  columns: Column[];
  onChange: (c: Condition) => void;
  onRemove?: () => void;
}) {
  const unary = UNARY_OPS.has(c.op);
  const typeOf = (o: Operand): ColType | undefined =>
    o?.kind === "column" ? columns.find((col) => col.name === o.column)?.type : undefined;

  return (
    <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
      <OperandPicker
        className="min-w-[11rem] flex-1"
        value={c.left}
        columns={columns}
        defaultTab="columns"
        valueType={typeOf(c.right)}
        onChange={(left) => onChange({ ...c, left })}
      />
      <OperatorPicker
        value={c.op}
        onChange={(op) =>
          onChange({
            ...c,
            op,
            right: UNARY_OPS.has(op) ? null : c.right,
            emptyAsNull: UNARY_OPS.has(op) ? c.emptyAsNull : undefined,
          })
        }
      />
      {unary && (
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-soft">
          <input
            type="checkbox"
            checked={!!c.emptyAsNull}
            onChange={(e) => onChange({ ...c, emptyAsNull: e.target.checked || undefined })}
            className="accent-[var(--color-ocean)]"
          />
          Treat empty string as null
        </label>
      )}
      {!unary && (
        <OperandPicker
          className="min-w-[11rem] flex-1"
          value={c.right}
          columns={columns}
          defaultTab="value"
          valueType={typeOf(c.left)}
          onChange={(right) => onChange({ ...c, right })}
        />
      )}
      {RANGE_OPS.has(c.op) && (
        <>
          <span className="text-xs text-muted">and</span>
          <OperandPicker
            value={c.right2 ?? null}
            columns={columns}
            defaultTab="value"
            valueType={typeOf(c.left)}
            onChange={(right2) => onChange({ ...c, right2 })}
          />
        </>
      )}
      {LIST_OPS.has(c.op) && <span className="text-xs text-muted">values separated by commas</span>}
      {onRemove && <RemoveButton title="Remove condition" onClick={onRemove} />}
    </div>
  );
}

const OP_MARK: Record<FilterOp, string> = {
  "is null": "∅",
  "is not null": "!∅",
  "is equal to": "=",
  "is not equal to": "≠",
  "is equal to (not null safe)": "=",
  "is not equal to (not null safe)": "≠",
  "starts with": "(x)",
  "ends with": "(x)",
  contains: "(x)",
  "does not contain": "(x)",
  "regex find": "(x)",
  "regex match": "(x)",
  "is less than": "<",
  "is less than or equal to": "≤",
  "is greater than": ">",
  "is greater than or equal to": "≥",
  "is in": "∈",
  "is not in": "∉",
  "is between": "[ ]",
  "is not between": "] [",
  like: "%",
  "not like": "!%",
};

const OP_HINT: Partial<Record<FilterOp, string>> = {
  "is in": "Equals one of a comma-separated list, e.g. Ann, Bob",
  like: "SQL LIKE: % is any text, _ is one character; case-sensitive",
  "not like": "SQL NOT LIKE: % is any text, _ is one character; case-sensitive",
  "is between": "Between two values, both included",
  "regex find": "The pattern occurs anywhere in the value",
  "regex match": "The pattern matches the whole value",
};

/** Operator dropdown with a filter box, like the column picker. */
function OperatorPicker({ value, onChange }: { value: FilterOp; onChange: (op: FilterOp) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const ops = FILTER_OPS.filter((op) => op.includes(query.toLowerCase()));
  const pick = (op: FilterOp) => {
    onChange(op);
    setOpen(false);
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => {
          setQuery("");
          setOpen(!open);
        }}
        className={`flex w-48 items-center gap-1.5 rounded-md border bg-panel-2 px-2 py-1 text-left text-xs hover:border-ocean/50 ${
          open ? "border-ocean" : "border-line-2"
        }`}
      >
        <span className="w-5 shrink-0 text-center font-mono text-[10px] text-muted">{OP_MARK[value]}</span>
        <span className="truncate">{value}</span>
        <Icon name="down" className="ml-auto h-3.5 w-3.5 shrink-0 text-muted" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-60 overflow-hidden rounded-lg border border-line-2 bg-panel-2 shadow-xl">
          <div className="border-b border-line p-1.5">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "Enter" && ops[0]) {
                  e.preventDefault();
                  pick(ops[0]);
                }
              }}
              placeholder="Filter…"
              className="w-full rounded-md border border-line-2 bg-ink px-2 py-1 text-xs outline-none focus:border-ocean"
            />
          </div>
          <ul className="max-h-72 overflow-y-auto py-1 text-xs">
            {ops.length === 0 && <li className="px-3 py-2 text-muted">No matching operators.</li>}
            {ops.map((op) => (
              <li key={op}>
                <button
                  type="button"
                  onClick={() => pick(op)}
                  title={OP_HINT[op]}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel ${
                    op === value ? "bg-ocean/15 text-white" : "text-soft"
                  }`}
                >
                  <span className="w-5 shrink-0 text-center font-mono text-[10px] text-muted">{OP_MARK[op]}</span>
                  {op}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** "Column, expression, or value": a search box over a Value / Columns popover. */
export function OperandPicker({
  value,
  columns,
  defaultTab,
  valueType,
  onChange,
  className = "w-64",
}: {
  value: Operand;
  columns: Column[];
  defaultTab: "value" | "columns";
  /** type to suggest for a literal: the column on the other side of the comparison */
  valueType?: ColType;
  onChange: (o: Operand) => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"value" | "columns">(defaultTab);
  const [query, setQuery] = useState("");
  const [literal, setLiteral] = useState("");
  const [type, setType] = useState<ColType>("String");

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const start = () => {
    setTab(value?.kind === "column" ? "columns" : value?.kind === "value" ? "value" : defaultTab);
    setQuery("");
    setLiteral(value?.kind === "value" ? value.value : "");
    setType(value?.kind === "value" ? value.type : (valueType ?? "String"));
    setOpen(true);
  };

  const pick = (o: Operand) => {
    onChange(o);
    setOpen(false);
  };

  const matches = columns.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
  const missing = value?.kind === "column" && !columns.some((c) => c.name === value.column);

  return (
    <div ref={box} className={`relative ${className}`}>
      {open ? (
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (tab === "value") setLiteral(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Enter") {
              e.preventDefault();
              if (tab === "columns" && matches[0]) pick({ kind: "column", column: matches[0].name });
              if (tab === "value") pick({ kind: "value", type, value: literal });
            }
          }}
          placeholder="Search…"
          className="w-full rounded-md border border-ocean bg-ink px-2 py-1 text-xs outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={start}
          className={`flex w-full items-center gap-1.5 rounded-md border bg-ink px-2 py-1 text-left text-xs hover:border-ocean/50 ${
            missing ? "border-bad/60" : "border-line-2"
          }`}
        >
          {!value ? (
            <span className="text-muted">Column, expression, or value</span>
          ) : value.kind === "column" ? (
            <>
              <span className="font-mono text-[10px] text-muted">
                {TYPE_MARK[columns.find((c) => c.name === value.column)?.type ?? "String"]}
              </span>
              <span className={`truncate ${missing ? "text-bad" : ""}`}>{value.column}</span>
            </>
          ) : (
            <>
              <span className="rounded bg-panel-2 px-1 text-[10px] text-muted ring-1 ring-line-2">{value.type}</span>
              <span className="truncate text-sand">{value.value === "" ? <i className="text-muted">empty</i> : value.value}</span>
            </>
          )}
          <Icon name="down" className="ml-auto h-3.5 w-3.5 shrink-0 text-muted" />
        </button>
      )}

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-80 overflow-hidden rounded-lg border border-line-2 bg-panel-2 shadow-xl">
          <div className="grid grid-cols-2 gap-1 border-b border-line p-1 text-xs">
            {(["value", "columns"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTab(t);
                  if (t === "value" && query) setLiteral(query);
                }}
                className={`rounded py-1 capitalize ${tab === t ? "bg-ocean/20 text-white" : "text-muted hover:bg-panel"}`}
              >
                {t}
              </button>
            ))}
          </div>
          {tab === "columns" ? (
            <ul className="max-h-60 overflow-y-auto py-1 text-xs">
              {matches.length === 0 && <li className="px-3 py-2 text-muted">No matching columns.</li>}
              {matches.map((c) => (
                <li key={c.name}>
                  <button
                    type="button"
                    onClick={() => pick({ kind: "column", column: c.name })}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
                  >
                    <span className="w-7 shrink-0 font-mono text-[10px] text-muted">{TYPE_MARK[c.type]}</span>
                    <span className="truncate">{c.name}</span>
                    <span className="ml-auto text-[10px] text-muted">{c.type}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <form
              className="space-y-2 p-2"
              onSubmit={(e) => {
                e.preventDefault();
                pick({ kind: "value", type, value: literal });
              }}
            >
              <div className="flex gap-1.5">
                <select value={type} onChange={(e) => setType(e.target.value as ColType)} className={selectClass}>
                  {COL_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <input
                  value={literal}
                  onChange={(e) => setLiteral(e.target.value)}
                  placeholder={type === "Date" ? "yyyy-MM-dd" : type === "Boolean" ? "true / false" : "No value set"}
                  className="min-w-0 flex-1 rounded-md border border-line-2 bg-ink px-2 py-1 text-xs outline-none focus:border-ocean"
                />
              </div>
              <div className="flex justify-end">
                <button type="submit" className="rounded-md bg-ocean px-2.5 py-1 text-xs font-medium text-white hover:bg-ocean-deep">
                  Set value
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

export function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 rounded-md border border-line-2 px-2 py-1 text-xs text-soft hover:border-ocean/50 hover:text-white"
    >
      <Icon name="plus" className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function RemoveButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button type="button" title={title} onClick={onClick} className="rounded p-1 text-muted hover:bg-bad/10 hover:text-bad">
      <Icon name="x" className="h-3.5 w-3.5" />
    </button>
  );
}

/** CASE WHEN editor: ordered cases (condition tree → result) and an Else result. */
export function CasesField({
  value,
  columns,
  onChange,
}: {
  value: string;
  columns: Column[];
  onChange: (v: string) => void;
}) {
  const spec = readCases({ cases: value });
  const save = (next: CaseSpec) => onChange(JSON.stringify(next));
  const setCase = (id: string, patch: Partial<CaseSpec["cases"][number]> | null) =>
    save({
      ...spec,
      cases: patch ? spec.cases.map((b) => (b.id === id ? { ...b, ...patch } : b)) : spec.cases.filter((b) => b.id !== id),
    });

  return (
    <div className="space-y-2 text-xs">
      {spec.cases.map((b, i) => (
        <div key={b.id} className="rounded-md border border-line-2 bg-ink/40 p-2">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="rounded bg-ocean/15 px-1.5 py-0.5 font-mono font-medium text-ocean">{i === 0 ? "WHEN" : "ELSE WHEN"}</span>
            <span className="text-muted">rows match</span>
            <MatchSelect group={b.when} onChange={(when) => setCase(b.id, { when })} />
            {spec.cases.length > 1 && (
              <span className="ml-auto">
                <RemoveButton title="Remove case" onClick={() => setCase(b.id, null)} />
              </span>
            )}
          </div>
          <GroupBody group={b.when} depth={1} columns={columns} onChange={(when) => setCase(b.id, { when })} />
          <div className="mt-2 flex items-center gap-2">
            <span className="rounded bg-ok/15 px-1.5 py-0.5 font-mono font-medium text-ok">THEN</span>
            <OperandPicker value={b.then} columns={columns} defaultTab="value" onChange={(then) => setCase(b.id, { then })} className="min-w-0 flex-1" />
          </div>
        </div>
      ))}
      <AddButton
        label="Add case"
        onClick={() => save({ ...spec, cases: [...spec.cases, { id: uid(), when: newGroup(), then: null }] })}
      />
      <div className="flex items-center gap-2 rounded-md border border-line-2 bg-ink/40 p-2">
        <span className="rounded bg-warn/15 px-1.5 py-0.5 font-mono font-medium text-warn">ELSE</span>
        <OperandPicker value={spec.else} columns={columns} defaultTab="value" onChange={(v) => save({ ...spec, else: v })} className="min-w-0 flex-1" />
        {spec.else && <RemoveButton title="No else (null)" onClick={() => save({ ...spec, else: null })} />}
      </div>
    </div>
  );
}
