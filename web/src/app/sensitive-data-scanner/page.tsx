"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { AppHeader, Card } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { CipherLicenseSelect } from "@/components/security/CipherLicenseSelect";
import { ApiError, Loading } from "@/components/States";
import { auth, type Marking, type User } from "@/lib/auth";
import { fmtTime, sds, type SdsAction, type SdsCondition, type SdsScan, type SdsScanIn } from "@/lib/securityGov";

const SCHEDULE_LABEL: Record<string, string> = {
  once: "One-time", daily: "Daily (00:00 UTC)", weekly: "Weekly (Tuesday 00:00 UTC)", monthly: "Monthly (1st, 00:00 UTC)", continuous: "Continuous (on new data)",
};
const ACTION_KIND: Record<SdsAction["kind"], string> = { apply_markings: "Apply markings", create_issues: "Create issues", obfuscate: "Obfuscate data (Cipher)" };
const ADMIN_KINDS: ("admin")[] = ["admin"];

/** Sensitive Data Scanner: scans datasets and media sets for sensitive data and acts on matches. */
export default function SensitiveDataScannerPage() {
  const [scans, setScans] = useState<SdsScan[] | null>(null);
  const [conditions, setConditions] = useState<SdsCondition[]>([]);
  const [actions, setActions] = useState<SdsAction[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  // ?include=<dataset>&name=… (Dataset Preview → Scan for sensitive data): a new scan of that dataset
  const [prefill] = useState(() => {
    const q = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
    return q?.get("include") ? { id: q.get("include")!, name: q.get("name") ?? q.get("include")! } : null;
  });
  const [creating, setCreating] = useState(!!prefill);
  const [editor, setEditor] = useState<"condition" | "action" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    sds.scans().then(setScans, (e: Error) => setError(e.message));
    sds.conditions().then(setConditions, () => {});
    sds.actions().then(setActions, () => {});
  }, []);
  useEffect(load, [load]);
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Sensitive Data Scanner" icon="search" href="/sensitive-data-scanner" crumbs={[{ label: "Security & Governance", href: "/security-governance" }]}>
        <button type="button" className={buttonClass.primary} onClick={() => { setOpen(null); setCreating(true); }}><Icon name="plus" className="h-4 w-4" />Create new sensitive data scan</button>
      </AppHeader>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="min-w-0 flex-1 overflow-y-auto bg-ink p-4 md:p-6">
          {error && <ApiError message={error} />}
          {creating ? <NewScan conditions={conditions} actions={actions} prefill={prefill} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); load(); setOpen(id); }} />
            : open ? <ScanView id={open} conditions={conditions} actions={actions} onBack={() => { setOpen(null); load(); }} />
              : (
                <Card title="Scans" count={scans?.length}>
                  {!scans ? <Loading /> : !scans.length ? <p className="p-4 text-sm text-muted">No scans yet. Test your match conditions with a scan without match actions first.</p> : (
                    <ul className="divide-y divide-line">
                      {scans.map((s) => (
                        <li key={s.id}>
                          <button type="button" onClick={() => setOpen(s.id)} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left text-sm hover:bg-panel-2">
                            <span className={`h-2 w-2 rounded-full ${s.active ? "bg-ok" : "bg-muted"}`} />
                            <span className="min-w-0 flex-1"><span className="font-medium">{s.name}</span>
                              <span className="block text-xs text-muted">{SCHEDULE_LABEL[s.schedule]} · {s.conditions.length} condition(s) · {s.actions.length} action(s) · {s.created_by} · {fmtTime(s.created_at)}</span></span>
                            <span className="text-xs text-muted">{s.runs[0] ? `${s.runs[0].status} · ${s.runs[0].matched}/${s.runs[0].resources} matched` : "not run yet"}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              )}
        </main>
        <aside className="shrink-0 space-y-4 overflow-y-auto border-t border-line bg-panel p-4 lg:w-80 lg:border-l lg:border-t-0">
          <div>
            <div className="mb-1 flex items-center justify-between text-xs font-semibold text-soft">Custom match conditions <button type="button" className="text-ocean" onClick={() => setEditor("condition")}>Add</button></div>
            <ul className="space-y-1 text-xs">
              {conditions.filter((c) => !c.builtin).map((c) => (
                <li key={c.id} className="flex items-center gap-1"><span className="flex-1 truncate">{c.name}</span><span className="text-muted">{c.kind}</span>
                  <button type="button" className="text-muted hover:text-bad" onClick={() => sds.deleteCondition(c.id).then(load)}><Icon name="trash" className="h-3 w-3" /></button></li>
              ))}
            </ul>
          </div>
          <details>
            <summary className="cursor-pointer text-xs font-semibold text-soft">Built-in match conditions</summary>
            <ul className="mt-1 space-y-1 text-xs">{conditions.filter((c) => c.builtin).map((c) => <li key={c.id} title={c.content_regex}>{c.name}</li>)}</ul>
            <p className="mt-1 text-[11px] text-muted">Check that built-in conditions fit your data&apos;s formats before acting on their matches.</p>
          </details>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs font-semibold text-soft">Available match actions <button type="button" className="text-ocean" onClick={() => setEditor("action")}>Add</button></div>
            <ul className="space-y-1 text-xs">
              {actions.map((a) => (
                <li key={a.id} className="flex items-center gap-1"><span className="flex-1 truncate">{a.name}</span><span className="text-muted">{ACTION_KIND[a.kind]}</span>
                  <button type="button" className="text-muted hover:text-bad" onClick={() => sds.deleteAction(a.id).then(load)}><Icon name="trash" className="h-3 w-3" /></button></li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
      {editor === "condition" && <ConditionEditor onClose={() => { setEditor(null); load(); }} />}
      {editor === "action" && <ActionEditor onClose={() => { setEditor(null); load(); }} />}
    </div>
  );
}

function ConditionEditor({ onClose }: { onClose: () => void }) {
  const [c, setC] = useState<Partial<SdsCondition>>({ kind: "regex", name: "", content_regex: "", column_regex: "", logic: "content", threshold: null, prompt: "" });
  const [sample, setSample] = useState("");
  const [test, setTest] = useState<string | null>(null);
  const [aip, setAip] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const set = (x: Partial<SdsCondition>) => setC((o) => ({ ...o, ...x }));
  const run = async () => {
    try {
      const r = await sds.testCondition(c, sample.split("\n").filter(Boolean));
      setTest(r.match ? `Match: ${r.matched}/${r.scanned} values (${(r.samples ?? []).join(", ")})` : "No match");
    } catch (e) {
      setTest((e as Error).message);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-xl space-y-3 overflow-y-auto rounded-xl border border-line bg-panel p-5 text-sm">
        <h2 className="text-base font-semibold">Create a match condition</h2>
        <div className="flex gap-3">{(["regex", "llm", "overlap"] as const).map((k) => <label key={k} className="flex items-center gap-1"><input type="radio" checked={c.kind === k} onChange={() => set({ kind: k })} />{k === "regex" ? "Regular expression" : k === "llm" ? "Language model" : "Value overlap"}</label>)}</div>
        <input className={inputClass} placeholder="Name" value={c.name} onChange={(e) => set({ name: e.target.value })} />
        <input className={inputClass} placeholder="Description (optional)" value={c.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
        {c.kind !== "overlap" && (
          <select className={inputClass} value={c.logic} onChange={(e) => set({ logic: e.target.value as SdsCondition["logic"] })}>
            <option value="content">Match content</option><option value="column">Match column name</option><option value="both">Match both</option><option value="either">Match either</option>
          </select>
        )}
        {c.kind === "regex" && (
          <>
            <div className="flex gap-2">
              <input className={`${inputClass} font-mono`} placeholder="Content regex" value={c.content_regex} onChange={(e) => set({ content_regex: e.target.value })} />
              <input className={`${fieldClass} w-28`} placeholder="Threshold %" value={c.threshold ?? ""} onChange={(e) => set({ threshold: e.target.value ? Number(e.target.value) : null })} />
            </div>
            <div className="flex gap-2">
              <input className={inputClass} placeholder="Generate regex with AIP: describe the data (e.g. all email addresses)" value={aip} onChange={(e) => setAip(e.target.value)} />
              <button type="button" className={buttonClass.secondary} disabled={!aip} onClick={() => sds.generateRegex(aip).then((r) => { set({ content_regex: r.regex }); setSample(r.matches.concat(r.non_matches).join("\n")); }, (e: Error) => setError(e.message))}><Icon name="sparkle" className="h-4 w-4" />Generate</button>
            </div>
            <input className={`${inputClass} font-mono`} placeholder="Column name regex" value={c.column_regex} onChange={(e) => set({ column_regex: e.target.value })} />
          </>
        )}
        {c.kind === "llm" && (
          <>
            <textarea className={`${inputClass} min-h-20`} placeholder="Describe the sensitive data the model should detect" value={c.prompt} onChange={(e) => set({ prompt: e.target.value })} />
            {(c.logic === "both" || c.logic === "either") && <textarea className={`${inputClass} min-h-14`} placeholder="Column name prompt (optional: the same prompt otherwise)" value={c.column_prompt ?? ""} onChange={(e) => set({ column_prompt: e.target.value })} />}
            <textarea className={`${inputClass} min-h-14`} placeholder="Correct examples (one per line)" onChange={(e) => set({ examples: e.target.value.split("\n").filter(Boolean) })} />
            <textarea className={`${inputClass} min-h-14`} placeholder="Counter examples (one per line)" onChange={(e) => set({ counter_examples: e.target.value.split("\n").filter(Boolean) })} />
            <p className="text-xs text-muted">Language model scans read the column name and up to 20 sampled values per column; usage counts toward the model&apos;s capacity.</p>
          </>
        )}
        {c.kind === "overlap" && (
          <div className="flex gap-2">
            <button type="button" className={buttonClass.secondary} onClick={() => setPicking(true)}><Icon name="table" className="h-4 w-4" />{c.overlap_dataset ? "Dataset chosen" : "Overlap dataset…"}</button>
            <input className={inputClass} placeholder="Overlap column" value={c.overlap_column ?? ""} onChange={(e) => set({ overlap_column: e.target.value })} />
          </div>
        )}
        {c.kind !== "overlap" && (
          <div className="space-y-1">
            <textarea className={`${inputClass} min-h-16 font-mono text-xs`} placeholder="Test values (one per line)" value={sample} onChange={(e) => setSample(e.target.value)} />
            <button type="button" className={buttonClass.ghost} onClick={run}><Icon name="play" className="h-4 w-4" />Test</button>
            {test && <span className="text-xs text-soft">{test}</span>}
          </div>
        )}
        {error && <p className="text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.ghost} onClick={onClose}>Cancel</button>
          <button type="button" className={buttonClass.primary} disabled={!c.name} onClick={() => sds.createCondition(c).then(onClose, (e: Error) => setError(e.message))}>Save condition</button>
        </div>
      </div>
      {picking && <DrivePicker title="Dataset with the known sensitive values" onClose={() => setPicking(false)} onPick={(it) => { set({ overlap_dataset: it.id }); setPicking(false); }} />}
    </div>
  );
}

function ActionEditor({ onClose }: { onClose: () => void }) {
  const [a, setA] = useState<Partial<SdsAction>>({ kind: "apply_markings", name: "", markings: [], assignees: [], severity: "medium", mode: "column", reapply_removed: false, notify_creator: false, skip_if_archived: true, skip_if_closed: false, issue_text: "Sensitive Data Scanner found {condition} in column {column} of {dataset}.", label: "sensitive-data" });
  const [markings, setMarkings] = useState<Marking[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    auth.markings().then(setMarkings, () => {});
    auth.users().then(setUsers, () => {});
  }, []);
  const set = (x: Partial<SdsAction>) => setA((o) => ({ ...o, ...x }));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-xl border border-line bg-panel p-5 text-sm">
        <h2 className="text-base font-semibold">Create match action</h2>
        <div className="flex flex-wrap gap-3">{(Object.keys(ACTION_KIND) as SdsAction["kind"][]).map((k) => <label key={k} className="flex items-center gap-1"><input type="radio" checked={a.kind === k} onChange={() => set({ kind: k })} />{ACTION_KIND[k]}</label>)}</div>
        <input className={inputClass} placeholder="Name" value={a.name} onChange={(e) => set({ name: e.target.value })} />
        {a.kind === "apply_markings" && (
          <>
            <div className="flex flex-wrap gap-1">
              {markings.map((m) => <label key={m.id} className="flex items-center gap-1 rounded bg-panel-2 px-2 py-1 text-xs"><input type="checkbox" checked={a.markings?.includes(m.id)} onChange={(e) => set({ markings: e.target.checked ? [...(a.markings ?? []), m.id] : (a.markings ?? []).filter((x) => x !== m.id) })} />{m.name}</label>)}
            </div>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={a.reapply_removed} onChange={(e) => set({ reapply_removed: e.target.checked })} />Reapply markings that have been manually removed</label>
            <p className="rounded border border-warn/30 bg-warn/10 p-2 text-xs text-warn">Markings are all-or-nothing: users lose access to matched datasets unless they hold them. Limit the scan&apos;s scope.</p>
          </>
        )}
        {a.kind === "create_issues" && (
          <>
            <select className={inputClass} value="" onChange={(e) => e.target.value && set({ assignees: [...new Set([...(a.assignees ?? []), e.target.value])] })}>
              <option value="">{a.assignees?.length ? `Assignees: ${a.assignees.map((x) => users.find((u) => u.id === x)?.username ?? x).join(", ")}` : "Add assignees…"}</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.username}</option>)}
            </select>
            <textarea className={`${inputClass} min-h-14`} value={a.issue_text} onChange={(e) => set({ issue_text: e.target.value })} />
            <div className="flex gap-2">
              <input className={inputClass} placeholder="Label" value={a.label} onChange={(e) => set({ label: e.target.value })} />
              <select className={inputClass} value={a.severity} onChange={(e) => set({ severity: e.target.value })}>{["low", "medium", "high", "critical"].map((s) => <option key={s}>{s}</option>)}</select>
            </div>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={a.notify_creator} onChange={(e) => set({ notify_creator: e.target.checked })} />Notify the dataset creator</label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={a.skip_if_archived} onChange={(e) => set({ skip_if_archived: e.target.checked })} />No new issue if an earlier one was archived</label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={a.skip_if_closed} onChange={(e) => set({ skip_if_closed: e.target.checked })} />No new issue if an earlier one was closed</label>
          </>
        )}
        {a.kind === "obfuscate" && (
          <>
            <CipherLicenseSelect value={a.license ?? ""} onChange={(v) => set({ license: v })} operation="encrypt" kinds={ADMIN_KINDS} className={inputClass} />
            <select className={inputClass} value={a.mode} onChange={(e) => set({ mode: e.target.value as SdsAction["mode"] })}>
              <option value="column">Entire column</option><option value="row">Entire row</option><option value="cell">Matched cell only</option><option value="segments">Matched segments only</option>
            </select>
            <p className="rounded border border-warn/30 bg-warn/10 p-2 text-xs text-warn">Creates an obfuscated copy of every matched dataset (the license must be in the same Project). Not reversible: delete the copies by hand.</p>
          </>
        )}
        {error && <p className="text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.ghost} onClick={onClose}>Cancel</button>
          <button type="button" className={buttonClass.primary} disabled={!a.name} onClick={() => sds.createAction(a).then(onClose, (e: Error) => setError(e.message))}>Save action</button>
        </div>
      </div>
    </div>
  );
}

const EMPTY_SCAN: SdsScanIn = {
  name: "", description: "", resource_types: ["datasets"], include: [], exclude: [], strategy: "source_only", source_kinds: ["upload", "sync", "manual", "import", "drive"],
  rows: "all", sample_rows: null, schedule: "once", initial_scan: true, include_markings: [], exclude_markings: [], conditions: [], actions: [],
};

function NewScan({ conditions, actions, prefill, onClose, onCreated }: { conditions: SdsCondition[]; actions: SdsAction[]; prefill: { id: string; name: string } | null; onClose: () => void; onCreated: (id: string) => void }) {
  const [s, setS] = useState<SdsScanIn>(prefill ? { ...EMPTY_SCAN, include: [prefill.id], strategy: "all" } : EMPTY_SCAN);
  const [names, setNames] = useState<Record<string, string>>(prefill ? { [prefill.id]: prefill.name } : {});
  const [picking, setPicking] = useState<{ list: "include" | "exclude"; what: "folder" | "dataset" } | null>(null);
  const [markings, setMarkings] = useState<Marking[]>([]);
  const [review, setReview] = useState<{ count: number; datasets: number; media_sets: number; virtual_tables?: number; llm_conditions: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    auth.markings().then(setMarkings, () => {});
  }, []);
  const set = (x: Partial<SdsScanIn>) => { setS((o) => ({ ...o, ...x })); setReview(null); };
  const toggle = (k: "conditions" | "actions" | "resource_types" | "include_markings" | "exclude_markings", v: string) => set({ [k]: s[k].includes(v) ? s[k].filter((x) => x !== v) : [...s[k], v] });
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2"><button type="button" className={buttonClass.ghost} onClick={onClose}><Icon name="left" className="h-4 w-4" />Scans</button><h1 className="text-lg font-semibold">New sensitive data scan</h1></div>
      <Card title="1 · Resources to scan">
        <div className="space-y-3 p-4 text-sm">
          <div className="flex gap-3">{[["datasets", "Datasets"], ["virtual_tables", "Virtual tables (read through their connection)"], ["media_sets", "Media sets (documents, images, audio)"]].map(([k, l]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={s.resource_types.includes(k)} onChange={() => toggle("resource_types", k)} />{l}</label>)}</div>
          {(["include", "exclude"] as const).map((k) => (
            <div key={k} className="flex flex-wrap items-center gap-1">
              <span className="w-56 text-xs text-muted">{k === "include" ? "Included datasets and folders" : "Excluded datasets and folders"}</span>
              {s[k].map((id) => <button key={id} type="button" className="rounded-full bg-panel-2 px-2 py-0.5 text-xs ring-1 ring-line-2 hover:text-bad" onClick={() => set({ [k]: s[k].filter((x) => x !== id) })}>{names[id] ?? id} ×</button>)}
              <button type="button" className={`${buttonClass.ghost} text-xs`} onClick={() => setPicking({ list: k, what: "folder" })}><Icon name="folder" className="h-3.5 w-3.5" />Add folder</button>
              <button type="button" className={`${buttonClass.ghost} text-xs`} onClick={() => setPicking({ list: k, what: "dataset" })}><Icon name="table" className="h-3.5 w-3.5" />Add dataset</button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1"><input type="radio" checked={s.strategy === "source_only"} onChange={() => set({ strategy: "source_only" })} />Scan only source datasets (uploads, syncs, manual entry) — recommended</label>
            <label className="flex items-center gap-1"><input type="radio" checked={s.strategy === "all"} onChange={() => set({ strategy: "all" })} />Scan all datasets, including derived ones</label>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1"><input type="radio" checked={s.rows === "all"} onChange={() => set({ rows: "all" })} />Scan all rows</label>
            <label className="flex items-center gap-1"><input type="radio" checked={s.rows === "sample"} onChange={() => set({ rows: "sample", sample_rows: s.sample_rows ?? 1000 })} />Only scan a random subset of</label>
            <input className={`${fieldClass} w-24`} disabled={s.rows !== "sample"} value={s.sample_rows ?? ""} onChange={(e) => set({ sample_rows: Number(e.target.value.replace(/\D/g, "")) || null })} /> rows
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select className={fieldClass} value={s.schedule} onChange={(e) => set({ schedule: e.target.value as SdsScanIn["schedule"] })}>{Object.entries(SCHEDULE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            {s.schedule !== "once" && <label className="flex items-center gap-1"><input type="checkbox" checked={s.initial_scan} onChange={(e) => set({ initial_scan: e.target.checked })} />Perform an initial scan of all matching datasets</label>}
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted">Included and excluded markings</summary>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {(["include_markings", "exclude_markings"] as const).map((k) => (
                <div key={k}><div className="text-muted">{k === "include_markings" ? "Only datasets with" : "Skip datasets with"}</div>
                  {markings.map((m) => <label key={m.id} className="mr-2 inline-flex items-center gap-1"><input type="checkbox" checked={s[k].includes(m.id)} onChange={() => toggle(k, m.id)} />{m.name}</label>)}</div>
              ))}
            </div>
          </details>
        </div>
      </Card>
      <Card title="2 · Match conditions">
        <div className="grid gap-1 p-4 text-sm md:grid-cols-2">
          {conditions.map((c) => <label key={c.id} className="flex items-center gap-2"><input type="checkbox" checked={s.conditions.includes(c.id)} onChange={() => toggle("conditions", c.id)} />{c.name}<span className="text-xs text-muted">{c.builtin ? "built-in" : c.kind}</span></label>)}
        </div>
      </Card>
      <Card title="3 · Match actions (none: test the conditions first)">
        <div className="space-y-1 p-4 text-sm">
          {actions.map((a) => <label key={a.id} className="flex items-center gap-2"><input type="checkbox" checked={s.actions.includes(a.id)} onChange={() => toggle("actions", a.id)} />{a.name}<span className="text-xs text-muted">{ACTION_KIND[a.kind]}</span></label>)}
          {!actions.length && <p className="text-xs text-muted">No match actions yet (add them in the sidebar).</p>}
        </div>
      </Card>
      <Card title="4 · Review and run">
        <div className="space-y-3 p-4 text-sm">
          <div className="flex flex-wrap gap-2">
            <input className={inputClass} placeholder="Scan name" value={s.name} onChange={(e) => set({ name: e.target.value })} />
            <input className={inputClass} placeholder="Description (optional)" value={s.description} onChange={(e) => set({ description: e.target.value })} />
            <button type="button" className={buttonClass.secondary} disabled={!s.include.length || !s.conditions.length} onClick={() => sds.preview(s).then(setReview, (e: Error) => setError(e.message))}>Compute the datasets to scan</button>
          </div>
          {review && <p className="text-xs text-soft">{review.count} resources: {review.datasets} datasets, {review.virtual_tables ?? 0} virtual tables, {review.media_sets} media sets{review.llm_conditions ? ` · ${review.llm_conditions} language model condition(s): every scanned column calls the model` : ""}.</p>}
          {error && <p className="text-bad">{error}</p>}
          <button type="button" className={buttonClass.primary} disabled={!s.include.length || !s.conditions.length}
            onClick={() => sds.create(s).then((x) => onCreated(x.id), (e: Error) => setError(e.message))}>{s.schedule === "once" ? "Run one-time scan" : "Save as recurring scan"}</button>
        </div>
      </Card>
      {picking && (picking.what === "folder" ? (
        <DrivePicker title={picking.list === "include" ? "Include a folder or Project" : "Exclude a folder"} onClose={() => setPicking(null)}
          folder={{ action: "Use this folder", onPick: (f) => { if (f.id) { const fid = f.id; setNames((n) => ({ ...n, [fid]: f.name })); set({ [picking.list]: [...new Set([...s[picking.list], fid])] }); } setPicking(null); } }} />
      ) : (
        <DrivePicker title={picking.list === "include" ? "Include a dataset" : "Exclude a dataset"} onClose={() => setPicking(null)}
          onPick={(it) => { setNames((n) => ({ ...n, [it.id]: it.name })); set({ [picking.list]: [...new Set([...s[picking.list], it.id])] }); setPicking(null); }} />
      ))}
    </div>
  );
}

function ScanView({ id, conditions, actions, onBack }: { id: string; conditions: SdsCondition[]; actions: SdsAction[]; onBack: () => void }) {
  const [s, setS] = useState<SdsScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [extra, setExtra] = useState<string[]>([]);
  const load = useCallback(() => sds.scan(id).then(setS, (e: Error) => setError(e.message)), [id]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);
  if (error) return <ApiError message={error} />;
  if (!s) return <Loading />;
  const running = s.runs[0]?.status === "running";
  const act = (p: Promise<unknown>, msg: string) => p.then(() => { setNotice(msg); void load(); }, (e: Error) => setError(e.message));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass.ghost} onClick={onBack}><Icon name="left" className="h-4 w-4" />Scans</button>
        <h1 className="flex-1 text-lg font-semibold">{s.name}</h1>
        {s.can_manage && (
          <>
            {running ? <button type="button" className={buttonClass.secondary} onClick={() => act(sds.cancel(s.id), "Cancelling")}>Cancel scan</button>
              : <button type="button" className={buttonClass.secondary} onClick={() => act(sds.run(s.id), "Scan started")}><Icon name="play" className="h-4 w-4" />Run now</button>}
            {s.schedule !== "once" && <button type="button" className={buttonClass.secondary} onClick={() => act(sds.update(s.id, { active: !s.active }), s.active ? "Deactivated" : "Activated")}>{s.active ? "Deactivate" : "Activate"}</button>}
          </>
        )}
      </div>
      {notice && <p className="rounded border border-ok/30 bg-ok/10 p-2 text-sm text-ok">{notice}</p>}
      <p className="text-xs text-muted">{SCHEDULE_LABEL[s.schedule]} · {s.active ? "active" : "inactive"} · {s.strategy === "source_only" ? "source datasets only" : "all datasets"} · {s.rows === "sample" ? `random ${s.sample_rows} rows` : "all rows"} ·
        conditions: {s.conditions.map((c) => conditions.find((x) => x.id === c)?.name ?? c).join(", ")} · actions: {s.actions.map((a) => actions.find((x) => x.id === a)?.name ?? a).join(", ") || "none"}</p>
      <Card title="Scan results" count={s.results?.length}>
        {!s.results?.length ? <p className="p-4 text-sm text-muted">{running ? "Scanning…" : "No results yet."}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="text-muted"><tr className="border-b border-line">{["Resource", "Scanned", "Matches", ""].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {s.results.map((r) => (
                  <tr key={r.id} className="border-b border-line/60 align-top">
                    <td className="px-3 py-2"><Link href={r.type === "dataset" ? `/datasets/${r.id}` : `/files/${r.id}`} className="text-ocean hover:underline">{r.name}</Link>
                      <span className="block text-muted">{r.type === "dataset" ? "dataset" : "media set"}{r.incremental ? " · incremental" : ""}</span></td>
                    <td className="px-3 py-2">{r.scanned_rows} {r.type === "dataset" ? "rows" : "items"}{r.error ? ` · ${r.error}` : ""}</td>
                    <td className="px-3 py-2">
                      {!r.matches.length ? <span className="text-muted">No match</span> : r.matches.map((m) => (
                        <div key={m.condition_id} className="mb-1">
                          <span className="font-medium text-warn">{m.condition_name}</span> — {m.columns.length ? `columns ${m.columns.join(", ")}` : `${m.count} item(s)`}{m.samples.length ? ` (e.g. ${m.samples.join(", ")})` : ""}
                          {m.items && <span className="block text-muted">{m.items.map((i) => i.name).join(", ")}</span>}
                        </div>
                      ))}
                      {r.history && r.history.length > 1 && <details className="mt-1"><summary className="cursor-pointer text-muted">Scan history</summary>{r.history.map((h, i) => <div key={i} className="text-muted">{fmtTime(h.at)} · {h.scanned} scanned{h.incremental ? " (incremental)" : ""} · {h.conditions.join(", ") || "no match"}</div>)}</details>}
                    </td>
                    <td className="px-3 py-2">{s.can_manage && r.type === "media_set" && <button type="button" className="text-ocean hover:underline" onClick={() => act(sds.run(s.id, { full: true, resource: r.id }), "Full re-scan started")}>Full re-scan</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {s.can_manage && (
        <Card title="Adjust match actions">
          <div className="space-y-2 p-4 text-sm">
            {!s.adjustable ? <p className="text-xs text-muted">Additional or reversed actions are for inactive scans created within the past seven days.</p> : (
              <>
                <div className="flex flex-wrap gap-2">{actions.map((a) => <label key={a.id} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={extra.includes(a.id)} onChange={(e) => setExtra((x) => (e.target.checked ? [...x, a.id] : x.filter((y) => y !== a.id)))} />{a.name}</label>)}</div>
                <div className="flex gap-2">
                  <button type="button" className={buttonClass.secondary} disabled={!extra.length} onClick={() => act(sds.applyActions(s.id, extra), "Additional actions applied")}>Apply additional match actions</button>
                  <button type="button" className={buttonClass.secondary} disabled={!extra.length} onClick={() => act(sds.reverseActions(s.id, extra), "Actions reversed (obfuscated datasets stay)")}>Reverse match actions</button>
                </div>
              </>
            )}
            {s.adjustments?.map((a, i) => <p key={i} className="text-xs text-muted">{fmtTime(a.at)} · {a.kind} {a.actions.map((x) => actions.find((y) => y.id === x)?.name ?? x).join(", ")}{a.undone !== undefined ? ` · ${a.undone} undone, ${a.not_reversible} not reversible` : ""}</p>)}
          </div>
        </Card>
      )}
      <Card title="Runs" count={s.runs.length}>
        <ul className="divide-y divide-line text-xs">
          {s.runs.map((r) => <li key={r.id} className="px-4 py-2">{fmtTime(r.started_at)} · {r.trigger} · <b>{r.status}</b> · {r.matched}/{r.resources} resources matched{r.llm_calls ? ` · ${r.llm_calls} model calls` : ""}{r.errors.length ? ` · ${r.errors.join("; ")}` : ""}</li>)}
        </ul>
      </Card>
    </div>
  );
}
