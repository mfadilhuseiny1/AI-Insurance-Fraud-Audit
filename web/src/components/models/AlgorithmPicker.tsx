"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import type { AlgoParam, AlgorithmChoice, AlgorithmSpec } from "@/lib/modelStudio";

/* The algorithm templates of a Model Studio configuration: pick popular algorithms (Random Forest, ANN, SVM, XGBoost…)
   and set their constants; each pick — and each variant of its settings — is a candidate the run trains and compares
   on the same validation rows. The catalog comes from GET /api/model-studio/trainers (api/ml_algorithms.py). */

const inputCls = "w-full rounded-md border border-line-2 bg-ink px-2 py-1 text-xs text-white outline-none focus:border-ocean";

function ParamInput({ p, value, onChange }: { p: AlgoParam; value: unknown; onChange: (v: unknown) => void }) {
  const shown = value === undefined ? p.default : value;
  if (p.kind === "bool")
    return (
      <label className="flex h-[26px] items-center gap-1.5 text-xs text-soft">
        <input type="checkbox" checked={Boolean(shown)} onChange={(e) => onChange(e.target.checked)} /> {shown ? "on" : "off"}
      </label>
    );
  if (p.kind === "select")
    return (
      <select value={String(shown ?? "")} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        {(p.options ?? []).map((o) => <option key={o}>{o}</option>)}
      </select>
    );
  return (
    <input
      value={shown === null || shown === undefined ? "" : String(shown)}
      placeholder={p.optional ? "none" : undefined}
      inputMode={p.kind === "layers" ? "text" : "decimal"}
      onChange={(e) => {
        const t = e.target.value;
        if (p.kind === "layers") return onChange(t);
        if (t.trim() === "") return onChange(p.optional ? null : undefined);
        const n = Number(t);
        onChange(Number.isNaN(n) ? t : n);
      }}
      className={inputCls}
    />
  );
}

function problem(p: AlgoParam, v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (p.kind === "int" || p.kind === "float") {
    if (typeof v !== "number") return "a number";
    if (p.kind === "int" && !Number.isInteger(v)) return "a whole number";
    if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max)) return `${p.min}–${p.max}`;
  }
  if (p.kind === "layers" && !/^\s*\d+(\s*,\s*\d+)*\s*$/.test(String(v))) return "e.g. 64,32";
  return null;
}

export function AlgorithmPicker({ catalog, value, onChange }: { catalog: AlgorithmSpec[]; value: AlgorithmChoice[]; onChange: (v: AlgorithmChoice[]) => void }) {
  const [open, setOpen] = useState<number | null>(value.length ? 0 : null);
  const spec = (k: string) => catalog.find((a) => a.key === k);
  const add = (k: string) => {
    onChange([...value, { algorithm: k, params: {} }]);
    setOpen(value.length);
  };
  const set = (i: number, patch: Partial<AlgorithmChoice>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 text-xs text-muted">Algorithm templates · click to add a candidate ({value.length}/12)</div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {catalog.map((a) => {
            const n = value.filter((c) => c.algorithm === a.key).length;
            return (
              <button key={a.key} type="button" disabled={value.length >= 12} onClick={() => add(a.key)} title={a.description}
                className={`rounded-lg border p-2.5 text-left transition hover:border-ocean disabled:opacity-40 ${n ? "border-ocean/60 bg-ocean/10" : "border-line bg-panel-2/40"}`}>
                <div className="flex items-center gap-1.5 text-xs font-medium text-white">
                  {a.name}
                  {n > 0 && <span className="ml-auto rounded-full bg-ocean/30 px-1.5 text-[10px] text-ocean">{n}</span>}
                  {!n && <Icon name="plus" className="ml-auto h-3 w-3 text-muted" />}
                </div>
                <div className="mt-1 line-clamp-2 text-[10px] leading-snug text-muted">{a.description}</div>
                <div className="mt-1 text-[9px] uppercase tracking-wide text-muted/70">{a.library}</div>
              </button>
            );
          })}
        </div>
      </div>
      {value.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-muted">Candidates · each is trained and scored on the same validation rows; the best is published, every one gets its charts</div>
          {value.map((c, i) => {
            const a = spec(c.algorithm);
            const errors = (a?.params ?? []).map((p) => problem(p, c.params[p.key])).filter(Boolean);
            return (
              <div key={i} className={`rounded-lg border ${errors.length ? "border-bad/50" : "border-line"} bg-panel`}>
                <div className="flex items-center gap-2 px-3 py-2">
                  <button type="button" onClick={() => setOpen(open === i ? null : i)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <Icon name={open === i ? "down" : "right"} className="h-3 w-3 text-muted" />
                    <span className="text-xs font-medium text-white">{a?.name ?? c.algorithm}</span>
                    <span className="truncate font-mono text-[10px] text-muted">
                      {Object.entries(c.params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${v === null ? "none" : String(v)}`).join(" · ") || "defaults"}
                    </span>
                  </button>
                  <button type="button" title="Add a variant with other settings" onClick={() => { onChange([...value.slice(0, i + 1), { ...c, params: { ...c.params } }, ...value.slice(i + 1)]); setOpen(i + 1); }}
                    disabled={value.length >= 12} className="rounded px-1.5 py-0.5 text-[10px] text-ocean hover:bg-ocean/10 disabled:opacity-40">+ variant</button>
                  <button type="button" title="Remove" onClick={() => { onChange(value.filter((_, j) => j !== i)); setOpen(null); }} className="text-muted hover:text-bad">
                    <Icon name="x" className="h-3.5 w-3.5" />
                  </button>
                </div>
                {open === i && a && (
                  <div className="grid gap-3 border-t border-line px-3 py-3 sm:grid-cols-2 lg:grid-cols-3">
                    {a.params.map((p) => {
                      const err = problem(p, c.params[p.key]);
                      return (
                        <label key={p.key} className="block text-[11px] text-muted" title={p.help}>
                          <span className="flex items-center gap-1">{p.label ?? p.key}{p.min !== undefined && p.kind !== "select" && <span className="text-muted/60">({p.min}–{p.max})</span>}</span>
                          <div className="mt-1"><ParamInput p={p} value={c.params[p.key]} onChange={(v) => set(i, { params: { ...c.params, [p.key]: v } })} /></div>
                          {err ? <span className="text-bad">must be {err}</span> : p.help ? <span className="line-clamp-2 text-[10px] text-muted/80">{p.help}</span> : null}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
