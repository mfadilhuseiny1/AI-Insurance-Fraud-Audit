"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { modelAssets, type ModelAsset } from "@/lib/modelAssets";
import { modelOverview, type Migration, type MigrationFinding } from "@/lib/modelOverview";

const STATUS: Record<MigrationFinding["status"], string> = { needs_migration: "Needs migration", completed: "Completed", ignored: "Ignored" };
const TONE: Record<MigrationFinding["status"], string> = { needs_migration: "text-warn", completed: "text-ok", ignored: "text-muted" };

/** Migration from foundry_ml to palantir_models (palantir.com/docs/foundry/migrate-models): code that still uses
 *  foundry_ml, a suggested palantir_models version, and the replacement model once migrated. api/model_overview.py */
export default function ModelMigrationPage() {
  const [data, setData] = useState<Migration | null>(null);
  const [models, setModels] = useState<ModelAsset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [show, setShow] = useState<"open" | "all">("open");
  const load = useCallback(() => { modelOverview.migration().then(setData, (e: Error) => setError(e.message)); }, []);
  useEffect(load, [load]);
  useEffect(() => { modelAssets.list().then(setModels, () => {}); }, []);
  if (error) return <ApiError message={error} />;
  if (!data) return <Loading label="Scanning repositories and workbooks…" />;
  const rows = data.findings.filter((f) => show === "all" || f.status === "needs_migration");
  const item = data.findings.find((f) => f.key === selected) ?? rows[0] ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader app="Model Migration Center" icon="restore" href="/model-migration">
        <Link href="/code-repositories" className={buttonClass.ghost}><Icon name="code" className="h-3.5 w-3.5" /> Code Repositories</Link>
      </AppHeader>
      <main className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl space-y-4">
          <div>
            <h1 className="text-xl font-semibold">Migrate from foundry_ml to palantir_models</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted">{data.note} Each finding gets a suggested rewrite: an adapter, a ModelOutput training transform, a ModelInput for inference and evaluations instead of MetricSets. Once migrated, name the model that replaces it.</p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {(Object.keys(STATUS) as MigrationFinding["status"][]).map((k) => <span key={k} className={TONE[k]}>{STATUS[k]}: {data.counts[k]}</span>)}
            <div className="ml-auto flex rounded-md border border-line">
              <button type="button" onClick={() => setShow("open")} className={`px-3 py-1 ${show === "open" ? "bg-panel-2 text-white" : "text-muted"}`}>Needs migration</button>
              <button type="button" onClick={() => setShow("all")} className={`px-3 py-1 ${show === "all" ? "bg-panel-2 text-white" : "text-muted"}`}>All</button>
            </div>
          </div>
          {rows.length === 0 ? <p className="rounded-xl border border-dashed border-line-2 p-8 text-center text-sm text-muted">No code uses foundry_ml{show === "open" ? " that still needs migration" : ""}.</p> : (
            <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
              <aside className="rounded-xl border border-line bg-panel p-2">
                {rows.map((f) => (
                  <button key={f.key} type="button" onClick={() => setSelected(f.key)} className={`block w-full rounded px-3 py-2 text-left text-xs ${item?.key === f.key ? "bg-panel-2" : "hover:bg-panel-2"}`}>
                    <div className="truncate text-white">{f.resource_name}</div>
                    <div className="truncate text-muted">{f.file ?? f.resource}</div>
                    <div className={TONE[f.status]}>{STATUS[f.status]}</div>
                  </button>
                ))}
              </aside>
              {item && <FindingView key={item.key} f={item} models={models} onChanged={setData} />}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function FindingView({ f, models, onChanged }: { f: MigrationFinding; models: ModelAsset[]; onChanged: (m: Migration) => void }) {
  const [replacement, setReplacement] = useState(f.replacement?.id ?? "");
  const [note, setNote] = useState(f.note);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const set = async (status: MigrationFinding["status"]) => {
    setErr(null);
    try { onChanged(await modelOverview.setMigration(f.key, { status, replacement_model_id: status === "completed" ? replacement : null, note })); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-line bg-panel p-4 text-sm">
        <div className="flex items-center gap-2">
          <span className="font-medium">{f.resource_name}</span><span className="text-xs text-muted">{f.resource}{f.file ? ` · ${f.file}` : ""}</span>
          <Link href={f.resource === "Code Repository" ? `/code-repositories/${f.resource_id}` : `/code-workbook/workbooks/${f.resource_id}`} className="ml-auto text-xs text-ocean hover:underline">Open</Link>
        </div>
        <ul className="mt-3 space-y-1 font-mono text-[11px]">
          {f.hits.map((h, i) => <li key={i} className="text-soft"><span className="text-muted">{h.node ? `${h.node}:` : ""}{h.line}</span> {h.code} <span className="font-sans text-warn">— {h.what}</span></li>)}
        </ul>
      </section>
      <section className="rounded-xl border border-line bg-panel">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-sm font-medium">Suggested palantir_models code
          <button type="button" className="text-xs font-normal text-ocean hover:underline" onClick={() => { void navigator.clipboard.writeText(f.suggestion); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button></div>
        <pre className="max-h-[28rem] overflow-auto p-4 text-xs text-soft">{f.suggestion}</pre>
        <p className="border-t border-line px-4 py-2 text-[11px] text-muted">Generated from the code&apos;s imports, paths and calls: fill in the feature columns and the training code. Start from the Model Training repository template for the full layout.</p>
      </section>
      <section className="space-y-2 rounded-xl border border-line bg-panel p-4 text-xs">
        <div className="text-sm font-medium">Status: <span className={TONE[f.status]}>{STATUS[f.status]}</span>{f.replacement && <> · replaced by <Link href={`/model-assets/${f.replacement.id}`} className="text-ocean hover:underline">{f.replacement.name}</Link></>}</div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={replacement} onChange={(e) => setReplacement(e.target.value)} className={`${inputClass} w-72 text-xs`}><option value="">Replacement model…</option>{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note" className={`${inputClass} w-64 text-xs`} />
          <button type="button" disabled={!replacement} onClick={() => set("completed")} className={buttonClass.primary}>Mark migrated</button>
          <button type="button" onClick={() => set("ignored")} className={buttonClass.ghost}>Ignore</button>
          {f.status !== "needs_migration" && <button type="button" onClick={() => set("needs_migration")} className={buttonClass.ghost}>Reopen</button>}
        </div>
        {err && <p className="text-bad">{err}</p>}
      </section>
    </div>
  );
}
