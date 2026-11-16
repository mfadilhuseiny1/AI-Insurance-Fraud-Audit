"use client";

import { useEffect, useState } from "react";
import { defOf, fitWires, UNKNOWN_DEF, type FieldDef, type FlowNode } from "@/lib/flow";
import { Icon } from "../Icon";
import { buttonClass, fieldClass, inputClass } from "../pipeline/Modal";

type SwitchRule = { t: string; v?: string; vt?: string; v2?: string };
type ChangeRule = { t: string; p: string; pt?: string; to?: string; tot?: string };

const SWITCH_OPS: [string, string][] = [
  ["eq", "=="],
  ["neq", "!="],
  ["lt", "<"],
  ["lte", "<="],
  ["gt", ">"],
  ["gte", ">="],
  ["btwn", "is between"],
  ["cont", "contains"],
  ["regex", "matches regex"],
  ["true", "is true"],
  ["false", "is false"],
  ["null", "is null"],
  ["nnull", "is not null"],
  ["else", "otherwise"],
];
const NO_VALUE = new Set(["true", "false", "null", "nnull", "else"]);
const VALUE_TYPES: [string, string][] = [
  ["str", "string"],
  ["num", "number"],
  ["bool", "boolean"],
  ["json", "JSON"],
  ["date", "timestamp"],
  ["msg", "msg."],
];

/** Node-RED's edit tray: slides over the sidebar; Done applies, Cancel discards. */
export function NodeTray({
  node,
  onDone,
  onCancel,
  onDelete,
}: {
  node: FlowNode;
  onDone: (n: FlowNode) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<FlowNode>(node);
  const def = defOf(node);
  const set = (key: string, value: unknown) => setDraft((d) => ({ ...d, [key]: value }));
  const done = () => onDone(fitWires(draft));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") onDone(fitWires(draft));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, onCancel, onDone]);

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-[420px] max-w-full flex-col border-l border-line-2 bg-panel shadow-2xl">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 text-sm font-semibold">
        <span className="h-3 w-3 rounded-sm ring-1 ring-black/20" style={{ background: def.color }} />
        <span className="flex-1 truncate">Edit {def === UNKNOWN_DEF ? node.type : def.label} node</span>
        <button type="button" onClick={onDelete} className={`${buttonClass.ghost} text-bad hover:text-bad`}>
          <Icon name="trash" className="h-3.5 w-3.5" /> Delete
        </button>
        <button type="button" onClick={onCancel} className={buttonClass.secondary}>
          Cancel
        </button>
        <button type="button" onClick={done} className={buttonClass.primary}>
          Done
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <Row label="Name">
          <input value={String(draft.name ?? "")} onChange={(e) => set("name", e.target.value)} className={inputClass} placeholder={def.label} autoFocus />
        </Row>
        {def === UNKNOWN_DEF && (
          <p className="rounded-md border border-warn/40 bg-warn/10 p-2 text-xs text-warn">
            Node type <code>{node.type}</code> is not available here. Its properties are kept as imported.
          </p>
        )}
        {def.runtime === "gateway" && (
          <p className="flex gap-2 rounded-md border border-line-2 bg-panel-2 p-2 text-xs text-soft">
            <Icon name="server" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ocean" />
            Runs on the device gateway, next to the devices — browsers cannot open {def.label.split(" ")[0].toUpperCase()} connections. The node is kept in the flow and is idle in the browser runtime.
          </p>
        )}
        {def.fields
          .filter((f) => !f.show || f.show(draft))
          .map((f) => (
            <Field key={f.key} field={f} value={draft[f.key]} onChange={(v) => set(f.key, v)} />
          ))}
        <p className="border-t border-line pt-3 text-xs leading-relaxed text-muted">{def.info}</p>
      </div>

      <div className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-xs text-muted">
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={!draft.d} onChange={(e) => set("d", e.target.checked ? undefined : true)} className="accent-ocean" />
          Enabled
        </label>
        <span className="ml-auto font-mono text-[11px]">{node.id}</span>
      </div>
    </div>
  );
}

function Row({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-soft">{label}</span>
      {children}
      {help && <span className="mt-1 block text-[11px] text-muted">{help}</span>}
    </label>
  );
}

function Field({ field: f, value, onChange }: { field: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  switch (f.kind) {
    case "checkbox":
      return (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-soft">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} className="accent-ocean" />
          {f.label}
        </label>
      );
    case "select":
      return (
        <Row label={f.label} help={f.help}>
          <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={inputClass}>
            {f.options!.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Row>
      );
    case "number":
      return (
        <Row label={f.label} help={f.help}>
          <input
            type="number"
            value={value === undefined || value === null ? "" : String(value)}
            placeholder={f.placeholder}
            onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
            className={inputClass}
          />
        </Row>
      );
    case "textarea":
    case "code":
      return (
        <Row label={f.label} help={f.help}>
          <textarea
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            rows={f.kind === "code" ? 14 : 5}
            onKeyDown={(e) => {
              if (f.kind !== "code" || e.key !== "Tab") return;
              e.preventDefault();
              const t = e.currentTarget;
              const at = t.selectionStart;
              onChange(`${t.value.slice(0, at)}  ${t.value.slice(t.selectionEnd)}`);
              requestAnimationFrame(() => t.setSelectionRange(at + 2, at + 2));
            }}
            className={`${inputClass} ${f.kind === "code" ? "font-mono text-xs leading-relaxed" : ""}`}
          />
        </Row>
      );
    case "switchRules":
      return <SwitchRules rules={(value as SwitchRule[] | undefined) ?? []} onChange={onChange} />;
    case "changeRules":
      return <ChangeRules rules={(value as ChangeRule[] | undefined) ?? []} onChange={onChange} />;
    default:
      return (
        <Row label={f.label} help={f.help}>
          <input
            type={f.kind === "password" ? "password" : "text"}
            value={String(value ?? "")}
            placeholder={f.placeholder}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
            autoComplete="off"
          />
        </Row>
      );
  }
}

function TypeSelect({ value, onChange, types = VALUE_TYPES }: { value?: string; onChange: (v: string) => void; types?: [string, string][] }) {
  return (
    <select value={value ?? "str"} onChange={(e) => onChange(e.target.value)} className={`${fieldClass} w-24 shrink-0 px-1.5`}>
      {types.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

function SwitchRules({ rules, onChange }: { rules: SwitchRule[]; onChange: (r: SwitchRule[]) => void }) {
  const patch = (i: number, p: Partial<SwitchRule>) => onChange(rules.map((r, k) => (k === i ? { ...r, ...p } : r)));
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-soft">Rules — one output each</span>
      <ol className="space-y-1.5">
        {rules.map((r, i) => (
          <li key={i} className="flex items-center gap-1.5 rounded-md border border-line-2 bg-ink/40 p-1.5">
            <span className="w-5 text-center text-[11px] text-muted">{i + 1}</span>
            <select value={r.t} onChange={(e) => patch(i, { t: e.target.value })} className={`${fieldClass} w-32 shrink-0 px-1.5`}>
              {SWITCH_OPS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            {!NO_VALUE.has(r.t) && (
              <>
                <input value={r.v ?? ""} onChange={(e) => patch(i, { v: e.target.value })} className={`${fieldClass} min-w-0 flex-1`} />
                {r.t === "btwn" ? (
                  <input value={r.v2 ?? ""} onChange={(e) => patch(i, { v2: e.target.value })} placeholder="and" className={`${fieldClass} w-16`} />
                ) : r.t !== "cont" && r.t !== "regex" ? (
                  <TypeSelect value={r.vt} onChange={(vt) => patch(i, { vt })} types={VALUE_TYPES.filter(([v]) => v !== "date")} />
                ) : null}
              </>
            )}
            {NO_VALUE.has(r.t) && <span className="flex-1" />}
            <button type="button" onClick={() => onChange(rules.filter((_, k) => k !== i))} className="rounded p-1 text-muted hover:text-bad" title="Remove rule">
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ol>
      <button type="button" onClick={() => onChange([...rules, { t: "eq", v: "", vt: "str" }])} className={`${buttonClass.ghost} mt-1.5`}>
        <Icon name="plus" className="h-3.5 w-3.5" /> Add rule
      </button>
    </div>
  );
}

function ChangeRules({ rules, onChange }: { rules: ChangeRule[]; onChange: (r: ChangeRule[]) => void }) {
  const patch = (i: number, p: Partial<ChangeRule>) => onChange(rules.map((r, k) => (k === i ? { ...r, ...p } : r)));
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-soft">Rules — applied in order</span>
      <ol className="space-y-1.5">
        {rules.map((r, i) => (
          <li key={i} className="space-y-1.5 rounded-md border border-line-2 bg-ink/40 p-2">
            <div className="flex items-center gap-1.5">
              <select value={r.t} onChange={(e) => patch(i, { t: e.target.value })} className={`${fieldClass} w-24 shrink-0 px-1.5`}>
                <option value="set">Set</option>
                <option value="delete">Delete</option>
                <option value="move">Move</option>
              </select>
              <span className="text-xs text-muted">msg.</span>
              <input value={r.p} onChange={(e) => patch(i, { p: e.target.value })} className={`${fieldClass} min-w-0 flex-1`} placeholder="payload" />
              <button type="button" onClick={() => onChange(rules.filter((_, k) => k !== i))} className="rounded p-1 text-muted hover:text-bad" title="Remove rule">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </div>
            {r.t !== "delete" && (
              <div className="flex items-center gap-1.5 pl-[6.6rem]">
                <span className="text-xs text-muted">to</span>
                {r.t === "move" && <span className="text-xs text-muted">msg.</span>}
                <input value={r.to ?? ""} onChange={(e) => patch(i, { to: e.target.value })} className={`${fieldClass} min-w-0 flex-1`} />
                {r.t === "set" && <TypeSelect value={r.tot} onChange={(tot) => patch(i, { tot })} />}
              </div>
            )}
          </li>
        ))}
      </ol>
      <button type="button" onClick={() => onChange([...rules, { t: "set", p: "payload", pt: "msg", to: "", tot: "str" }])} className={`${buttonClass.ghost} mt-1.5`}>
        <Icon name="plus" className="h-3.5 w-3.5" /> Add rule
      </button>
    </div>
  );
}
