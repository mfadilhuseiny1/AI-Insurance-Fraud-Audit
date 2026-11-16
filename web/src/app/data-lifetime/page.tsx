"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { AppHeader, Card } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { fmtTime, lifetime, type LifetimeDeletion, type LifetimePolicy } from "@/lib/securityGov";

/** Data Lifetime: lineage-aware deletion policies for datasets, their applications, overrides and deletions. */
export default function DataLifetimePage() {
  const { me, enabled } = useAuth();
  const dgo = !enabled || me?.role === "admin";
  const [tab, setTab] = useState<"policies" | "deletions">("policies");
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Data Lifetime" icon="clock" href="/data-lifetime" crumbs={[{ label: "Security & Governance", href: "/security-governance" }]}>
        {dgo && <button type="button" className={buttonClass.primary} onClick={() => setCreating(true)}><Icon name="plus" className="h-4 w-4" />New policy</button>}
      </AppHeader>
      <div className="flex shrink-0 gap-1 border-b border-line bg-panel px-4">
        {([["policies", "Policies", "list"], ["deletions", "Deletions", "trash"]] as const).map(([id, label, icon]) => (
          <button key={id} type="button" onClick={() => { setTab(id); setOpen(null); }}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm ${tab === id ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}><Icon name={icon} className="h-4 w-4" />{label}</button>
        ))}
      </div>
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
        <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
          <p className="rounded border border-warn/30 bg-warn/10 p-3 text-xs text-warn">
            Deletion policies are sensitive: a mistake can delete data, or keep it longer than the law allows. Apply them to root (upstream) datasets — every dataset built from
            them inherits the deletion dates. Consider a Checkpoint (&ldquo;Retention policy application&rdquo;) to ask for a justification whenever a policy is applied or removed.
          </p>
          {tab === "policies" && (open ? <PolicyView id={open} dgo={dgo} onBack={() => setOpen(null)} /> : <Policies onOpen={setOpen} />)}
          {tab === "deletions" && <Deletions dgo={dgo} />}
        </div>
      </main>
      {creating && <NewPolicy onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setTab("policies"); setOpen(id); }} />}
    </div>
  );
}

const describe = (p: LifetimePolicy) =>
  p.type === "fixed" ? `Fixed deletion date ${fmtTime(p.deletion_date)}${p.cutoff_date ? ` (transactions before ${fmtTime(p.cutoff_date)})` : ""}` : "Keep latest view only";

function Policies({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<LifetimePolicy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    lifetime.policies().then(setRows, (e: Error) => setError(e.message));
  }, []);
  if (error) return <ApiError message={error} />;
  if (!rows) return <Loading />;
  return (
    <Card title="Policies" count={rows.length}>
      {!rows.length ? <p className="p-4 text-sm text-muted">No deletion policies yet.</p> : (
        <ul className="divide-y divide-line">
          {rows.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onOpen(p.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-panel-2">
                <Icon name="clock" className="h-4 w-4 text-ocean" />
                <span className="min-w-0 flex-1"><span className="font-medium">{p.name}</span><span className="block text-xs text-muted">{describe(p)}</span></span>
                <span className="text-xs text-muted">{(p.datasets as string[]).length} root dataset(s){(p.overrides as string[]).length ? ` · ${(p.overrides as string[]).length} override(s)` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function NewPolicy({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [p, setP] = useState<Partial<LifetimePolicy>>({ name: "", description: "", type: "fixed", deletion_date: "", cutoff_date: "" });
  const [error, setError] = useState<string | null>(null);
  const create = () =>
    lifetime.create({ ...p, deletion_date: p.deletion_date || null, cutoff_date: p.cutoff_date || null }).then((x) => onCreated(x.id), (e: Error) => setError(e.message));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md space-y-3 rounded-xl border border-line bg-panel p-5 text-sm">
        <h2 className="text-base font-semibold">New policy</h2>
        <input className={inputClass} placeholder="Policy name" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
        <textarea className={`${inputClass} min-h-14`} placeholder="Why (the obligation it implements)" value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} />
        <label className="flex items-start gap-2"><input type="radio" className="mt-1" checked={p.type === "fixed"} onChange={() => setP({ ...p, type: "fixed" })} />
          <span>Fixed deletion date<span className="block text-xs text-muted">Every transaction (or those before a cutoff) is deleted on the date.</span></span></label>
        <label className="flex items-start gap-2"><input type="radio" className="mt-1" checked={p.type === "latest_view"} onChange={() => setP({ ...p, type: "latest_view" })} />
          <span>Keep latest view only<span className="block text-xs text-muted">Transactions outside the current view are deleted right away.</span></span></label>
        {p.type === "fixed" && (
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-xs"><span className="text-muted">Deletion date</span><input type="date" className={inputClass} value={p.deletion_date ?? ""} onChange={(e) => setP({ ...p, deletion_date: e.target.value })} /></label>
            <label className="space-y-1 text-xs"><span className="text-muted">Cutoff (optional)</span><input type="date" className={inputClass} value={p.cutoff_date ?? ""} onChange={(e) => setP({ ...p, cutoff_date: e.target.value })} /></label>
          </div>
        )}
        {error && <p className="text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.ghost} onClick={onClose}>Cancel</button>
          <button type="button" className={buttonClass.primary} disabled={!p.name} onClick={create}>Create policy</button>
        </div>
      </div>
    </div>
  );
}

function PolicyView({ id, dgo, onBack }: { id: string; dgo: boolean; onBack: () => void }) {
  const [p, setP] = useState<LifetimePolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [side, setSide] = useState<"root" | "downstream" | "history">("root");
  // the policy's details (dataset names, downstream from Data Lineage) can take minutes on a large platform: the policy
  // itself comes from the (quick) list, so its header and "Apply to dataset" do not wait for them
  const [base, setBase] = useState<LifetimePolicy | null>(null);
  const load = useCallback(() => lifetime.policy(id).then(setP, (e: Error) => setError(e.message)), [id]);
  useEffect(() => {
    void load();
    lifetime.policies().then((rows) => setBase(rows.find((x) => x.id === id) ?? null), () => {});
  }, [load, id]);
  if (error && !p && !base) return <ApiError message={error} />;
  if (!p && !base) return <Loading />;
  const head = (p ?? base)!;
  const ds = (p?.datasets ?? []) as { id: string; name: string; visible: boolean }[];
  const ov = (p?.overrides ?? []) as { id: string; name: string; visible: boolean }[];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass.ghost} onClick={onBack}><Icon name="left" className="h-4 w-4" />Policies</button>
        <h1 className="flex-1 text-lg font-semibold">{head.name}</h1>
        <button type="button" className={buttonClass.primary} onClick={() => setPicking(true)}><Icon name="plus" className="h-4 w-4" />Apply to dataset</button>
        {dgo && <button type="button" className={buttonClass.ghost} onClick={() => lifetime.remove(head.id).then(onBack, (e: Error) => setError(e.message))}><Icon name="trash" className="h-4 w-4" />Delete policy</button>}
      </div>
      <p className="text-sm text-soft">{describe(head)}{head.description ? ` — ${head.description}` : ""}</p>
      {error && <p className="text-sm text-bad">{error}</p>}
      {notice && <p className="text-sm text-ok">{notice}</p>}
      <div className="flex gap-1">
        {([["root", `Root datasets (${p ? ds.length : "…"})`], ["downstream", `Downstream (${p ? p.downstream?.length ?? 0 : "…"})`], ["history", "History"]] as const).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setSide(k)} className={`rounded-md px-3 py-1.5 text-xs ${side === k ? "bg-ocean/15 text-white" : "text-muted hover:text-white"}`}>{l}</button>
        ))}
      </div>
      {!p && <Loading />}
      {p && side === "root" && (
        <Card title="Root datasets">
          <ul className="divide-y divide-line text-sm">
            {ds.map((d) => (
              <li key={d.id} className="flex items-center gap-2 px-4 py-2">
                <Link href={`/datasets/${d.id}`} className="flex-1 text-ocean hover:underline">{d.visible ? d.name : "(a dataset you cannot see)"}</Link>
                <button type="button" className={buttonClass.ghost} onClick={() => lifetime.unapply(head.id, d.id).then(() => { setNotice("Policy removed from the dataset"); void load(); }, (e: Error) => setError(e.message))}>Remove policy from dataset</button>
              </li>
            ))}
            {ov.map((d) => <li key={d.id} className="px-4 py-2 text-xs text-muted">Override on <Link href={`/datasets/${d.id}`} className="text-ocean hover:underline">{d.name}</Link></li>)}
            {!ds.length && !ov.length && <li className="px-4 py-3 text-muted">Not applied to any dataset.</li>}
          </ul>
        </Card>
      )}
      {p && side === "downstream" && (
        <Card title="Datasets inheriting deletion dates">
          <ul className="divide-y divide-line text-sm">
            {(p.downstream ?? []).map((d) => <li key={d.id} className="px-4 py-2"><Link href={`/datasets/${d.id}`} className="text-ocean hover:underline">{d.visible ? d.name : "(a dataset you cannot see)"}</Link></li>)}
            {!p.downstream?.length && <li className="px-4 py-3 text-muted">None (from Data Lineage).</li>}
          </ul>
        </Card>
      )}
      {p && side === "history" && (
        <Card title="History">
          <ul className="divide-y divide-line text-xs">
            {(p.history ?? []).map((h, i) => <li key={i} className="px-4 py-2">{fmtTime(h.at)} · {h.by} · <b>{h.action}</b>{h.dataset ? ` · ${h.detail || h.dataset}` : h.detail ? ` · ${h.detail}` : ""}</li>)}
          </ul>
        </Card>
      )}
      {picking && <DrivePicker title="The dataset to apply the policy to" onClose={() => setPicking(false)}
        onPick={(it) => { setPicking(false); lifetime.apply(head.id, it.id).then(() => { setNotice(`Applied to ${it.name}`); void load(); }, (e: Error) => setError(e.message)); }} />}
    </div>
  );
}

function Deletions({ dgo }: { dgo: boolean }) {
  const [tx, setTx] = useState("");
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState<"" | "deleted" | "scheduled">("");
  const [data, setData] = useState<{ total: number; rows: LifetimeDeletion[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => {
    const start = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19);
    lifetime.deletions({ transaction: tx || undefined, start: status === "scheduled" ? undefined : start }).then(setData, (e: Error) => setError(e.message));
  }, [tx, days, status]);
  useEffect(load, [load]);
  const rows = (data?.rows ?? []).filter((r) => !status || r.status === status);
  return (
    <Card title="Deletions" count={rows.length} action={dgo ? (
      <span className="flex gap-1">
        <button type="button" className={buttonClass.ghost} onClick={() => lifetime.run(true).then((r) => setNotice(`${r.due?.length ?? 0} transaction(s) due now`), (e: Error) => setError(e.message))}>Check what is due</button>
        <button type="button" className={buttonClass.secondary} onClick={() => lifetime.run(false).then((r) => { setNotice(`${r.deleted?.length ?? 0} deleted${r.remaining ? `, ${r.remaining} remaining` : ""}`); load(); }, (e: Error) => setError(e.message))}>Delete due transactions now</button>
      </span>) : undefined}>
      <div className="flex flex-wrap gap-2 border-b border-line p-3 text-sm">
        <input className={`${fieldClass} w-72 font-mono`} placeholder="Transaction ID or RID" value={tx} onChange={(e) => setTx(e.target.value.trim())} />
        <select className={fieldClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>{[[7, "Last 7 days"], [30, "Last 30 days"], [365, "Last year"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <select className={fieldClass} value={status} onChange={(e) => setStatus(e.target.value as "" | "deleted" | "scheduled")}><option value="">Deleted and scheduled</option><option value="deleted">Deleted</option><option value="scheduled">Scheduled</option></select>
      </div>
      {error && <p className="p-3 text-sm text-bad">{error}</p>}
      {notice && <p className="p-3 text-sm text-ok">{notice}</p>}
      {!data ? <Loading /> : !rows.length ? <p className="p-4 text-sm text-muted">Nothing deleted or scheduled.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="text-muted"><tr className="border-b border-line">{["Dataset", "Transaction", "Committed", "Deletion date", "Status", "Inherited from"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.dataset}:${r.transaction}`} className="border-b border-line/60">
                  <td className="px-3 py-2"><Link href={`/datasets/${r.dataset}`} className="text-ocean hover:underline">{r.dataset_name}</Link></td>
                  <td className="px-3 py-2 font-mono">{r.transaction}</td>
                  <td className="px-3 py-2 text-muted">{fmtTime(r.transaction_at)}</td>
                  <td className="px-3 py-2">{fmtTime(r.deletion_date)}</td>
                  <td className={`px-3 py-2 ${r.status === "deleted" ? "text-muted" : "text-warn"}`}>{r.status}{r.emptied_current_view ? " (current view emptied)" : ""}</td>
                  <td className="px-3 py-2 text-muted">{r.inherited_from ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="p-3 text-[11px] text-muted">Deleted copies are removed from the platform&apos;s storage right away; storage behind it (such as S3 versioning) can keep them for up to about 30 days.</p>
    </Card>
  );
}
