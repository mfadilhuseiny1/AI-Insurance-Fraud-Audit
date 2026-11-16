"use client";

import { useState } from "react";
import { SET_MODES, type NodeResult, type PipelineNode, type SetMode } from "@/lib/pipeline";
import { buttonClass, inputClass, Modal } from "./Modal";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[7rem_1fr] items-center gap-3">
      <span className="text-xs text-soft">{label}</span>
      {children}
    </label>
  );
}

const SET_HELP: Record<SetMode, string> = {
  "union all": "Stacks all rows (UNION ALL)",
  "union distinct": "Stacks rows and removes duplicates (UNION)",
  intersect: "Distinct rows of the first dataset found in every other one (INTERSECT)",
  "intersect all": "Like intersect but keeps duplicates: a row appears as often as in the input that has it least (INTERSECT ALL)",
  except: "Distinct rows of the first dataset found in none of the others (EXCEPT / MINUS)",
  "except all": "Like except but counts copies: each copy in the others removes one copy from the first (EXCEPT ALL)",
};

export function UnionDialog({
  initial,
  nodes,
  result,
  onClose,
  onSave,
}: {
  initial: { name: string; inputs: string[]; mode?: SetMode; strict?: boolean };
  nodes: PipelineNode[];
  result: (id: string) => NodeResult;
  onClose: () => void;
  onSave: (c: { name: string; inputs: string[]; mode: SetMode; strict: boolean }) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [inputs, setInputs] = useState(initial.inputs);
  const [mode, setMode] = useState<SetMode>(initial.mode ?? "union all");
  const [strict, setStrict] = useState(!!initial.strict);
  const schemaProblems = (() => {
    const tables = inputs.map((i) => result(i).table).filter((t): t is NonNullable<typeof t> => !!t);
    const all = new Set(tables.flatMap((t) => t.columns.map((c) => c.name)));
    return inputs
      .map((i) => {
        const t = result(i).table;
        const missing = t ? [...all].filter((c) => !t.columns.some((x) => x.name === c)) : [];
        return missing.length ? `${nodes.find((n) => n.id === i)?.name ?? i} is missing ${missing.join(", ")}` : "";
      })
      .filter(Boolean);
  })();
  const ordered = mode !== "union all" && mode !== "union distinct";

  return (
    <Modal title="Set operation" icon="union" onClose={onClose}>
      <div className="space-y-3 p-4">
        <Row label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Row>
        <div className="grid grid-cols-[7rem_1fr] items-start gap-3">
          <span className="pt-1 text-xs text-soft">Operation</span>
          <div>
            <div className="grid grid-cols-3 gap-1 rounded-md bg-ink p-1">
              {SET_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m);
                    // rename while the name is still a default
                    if (["Union", ...SET_MODES.map(setName_)].includes(name)) setName(setName_(m));
                  }}
                  className={`rounded py-1 text-xs capitalize ${mode === m ? "bg-panel-2 text-white ring-1 ring-line-2" : "text-muted"}`}
                >
                  {m}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">{SET_HELP[mode]}</p>
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs text-soft">
            Datasets (matched by column name{ordered ? "; the first one selected is the base" : ""})
          </div>
          <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line text-sm">
            {nodes.map((n) => {
              const r = result(n.id);
              const at = inputs.indexOf(n.id);
              return (
                <li key={n.id}>
                  <label className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-panel-2">
                    <input
                      type="checkbox"
                      checked={at >= 0}
                      onChange={(e) => setInputs(e.target.checked ? [...inputs, n.id] : inputs.filter((i) => i !== n.id))}
                      className="accent-[var(--color-ocean)]"
                    />
                    <span className="flex-1">{n.name}</span>
                    {at >= 0 && (
                      <span className={`rounded px-1.5 text-[10px] ${ordered && at === 0 ? "bg-ocean/20 text-ocean" : "bg-panel-2 text-muted"}`}>
                        {ordered && at === 0 ? "base" : at + 1}
                      </span>
                    )}
                    <span className="text-xs text-muted">{r.table ? `${r.table.columns.length} columns` : "error"}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
        <label className="flex cursor-pointer items-start gap-2 text-xs">
          <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} className="mt-0.5 accent-[var(--color-ocean)]" />
          <span>
            <span className="block text-soft">Require the same schema</span>
            <span className="block text-muted">Every input must have the same columns; a missing column is an error. Off: missing columns are filled with nulls.</span>
          </span>
        </label>
        {strict && schemaProblems.length > 0 && (
          <ul className="space-y-0.5 rounded-md bg-bad/10 px-2.5 py-1.5 text-xs text-bad">
            {schemaProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim() || inputs.length < 2}
            onClick={() => onSave({ name: name.trim(), inputs, mode, strict })}
            className={buttonClass.primary}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

const setName_ = (m: SetMode) => m.replace(/(^|\s)\w/g, (x) => x.toUpperCase());
