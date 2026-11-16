"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, Card } from "@/components/ontology/parts";
import { ApiError, Loading } from "@/components/States";
import { LocationField, missingText } from "@/components/LocationField";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { API_URL } from "@/lib/api";
import { auth, type User } from "@/lib/auth";
import {
  audit, fmtBytes, fmtTime,
  type Alert, type AuditCategory, type AuditExport, type AuditLine, type AuditOrg, type AuditSummary, type Baseline, type Detection,
} from "@/lib/securityGov";

type Tab = "overview" | "events" | "alerts" | "detections" | "baselines" | "delivery" | "categories";
const TABS: { id: Tab; label: string; icon: "gauge" | "list" | "bell" | "alert" | "graph" | "download" | "layers" }[] = [
  { id: "overview", label: "Overview", icon: "gauge" },
  { id: "events", label: "Events", icon: "list" },
  { id: "alerts", label: "Alerts", icon: "bell" },
  { id: "detections", label: "Detections", icon: "alert" },
  { id: "baselines", label: "Baselines", icon: "graph" },
  { id: "delivery", label: "Delivery", icon: "download" },
  { id: "categories", label: "Categories", icon: "layers" },
];
const KEY_CATEGORIES = ["dataExport", "dataLoad", "dataImport", "dataDelete", "authenticationCheck", "userLogin", "tokenGeneration", "managementPermissions", "managementMarkings", "ontologyDataTransform", "codeExecution", "llmInference", "userJustify", "requestApprove"];
const SEV: Record<string, string> = { high: "text-bad", medium: "text-warn", low: "text-soft" };

/**
 * Security auditing: audit.3 logs of every application, category-based search, detections and alerts, user
 * baselines, and delivery to a SIEM (log files API) or to datasets.
 */
export default function SecurityAuditingPage() {
  // read once from the URL: ?alert=<id> (notification links), ?tab=, ?resource= / ?uid= / ?categories= (investigations from other apps)
  const [url] = useState(() => (typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search)));
  const [focusAlert] = useState<string | null>(() => url.get("alert"));
  const [preset, setPreset] = useState<{ categories?: string; uid?: string; resource?: string } | null>(() =>
    url.get("resource") || url.get("uid") || url.get("categories")
      ? { resource: url.get("resource") ?? undefined, uid: url.get("uid") ?? undefined, categories: url.get("categories") ?? undefined }
      : null,
  );
  const [tab, setTab] = useState<Tab>(() => {
    const t = url.get("tab") as Tab | null;
    return url.get("alert") ? "alerts" : preset ? "events" : t && TABS.some((x) => x.id === t) ? t : "overview";
  });
  const investigate = (q: { categories?: string; uid?: string; resource?: string }) => {
    setPreset(q);
    setTab("events");
  };
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Security auditing" icon="history" href="/security-auditing" crumbs={[{ label: "Security & Governance", href: "/security-governance" }]} />
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-panel px-4">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm ${tab === t.id ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>
            <Icon name={t.icon} className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
        <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
          {tab === "overview" && <Overview onInvestigate={investigate} />}
          {tab === "events" && <Events preset={preset} key={JSON.stringify(preset)} />}
          {tab === "alerts" && <Alerts focus={focusAlert} onInvestigate={investigate} />}
          {tab === "detections" && <Detections />}
          {tab === "baselines" && <Baselines onInvestigate={investigate} />}
          {tab === "delivery" && <Delivery />}
          {tab === "categories" && <Categories />}
        </div>
      </main>
    </div>
  );
}

function Bars({ data, onPick }: { data: Record<string, number>; onPick?: (k: string) => void }) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  if (!rows.length) return <p className="p-4 text-sm text-muted">No events yet.</p>;
  return (
    <div className="space-y-1.5 p-4">
      {rows.map(([k, v]) => (
        <button key={k} type="button" disabled={!onPick} onClick={() => onPick?.(k)} className="grid w-full grid-cols-[minmax(0,10rem)_1fr_3.5rem] items-center gap-2 text-left text-xs enabled:hover:text-white">
          <span className="truncate font-mono text-soft" title={k}>{k}</span>
          <span className="h-2 rounded bg-panel-2"><span className="block h-2 rounded bg-ocean" style={{ width: `${(v / max) * 100}%` }} /></span>
          <span className="text-right text-muted">{v.toLocaleString()}</span>
        </button>
      ))}
    </div>
  );
}

function Overview({ onInvestigate }: { onInvestigate: (q: { categories?: string }) => void }) {
  const [s, setS] = useState<AuditSummary | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    audit.summary(7).then(setS, (e: Error) => setError(e.message));
    audit.alerts("open").then(setAlerts, () => setAlerts([]));
  }, []);
  if (error) return <ApiError message={error} />;
  if (!s) return <Loading />;
  const failed = (s.results.UNAUTHORIZED ?? 0) + (s.results.ERROR ?? 0);
  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Security auditing</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Every application writes audit.3 logs: who did what, when and to which resources, under standard categories such as <code>dataExport</code> or <code>userLogin</code>.
          Audit logs can hold personal data and search queries — only administrators and the organization&apos;s audit log readers see them.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Events (7 days)", s.total.toLocaleString(), "text-white"],
          ["Active users", String(s.users), "text-ocean"],
          ["Denied or failed", failed.toLocaleString(), failed ? "text-bad" : "text-ok"],
          ["Open alerts", alerts ? String(alerts.length) : "…", alerts?.length ? "text-warn" : "text-ok"],
        ].map(([k, v, tone]) => (
          <div key={k} className="rounded-lg border border-line bg-panel px-4 py-3">
            <div className="text-xs text-muted">{k}</div>
            <div className={`text-2xl font-semibold ${tone}`}>{v}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="By category" action={<span className="text-xs text-muted">click to investigate</span>}><Bars data={s.categories} onPick={(c) => onInvestigate({ categories: c })} /></Card>
        <Card title="By product"><Bars data={s.products} /></Card>
        <Card title="Per day"><Bars data={s.days} /></Card>
        <Card title="Open alerts" count={alerts?.length}>
          {!alerts?.length ? <p className="p-4 text-sm text-muted">No open alerts.</p> : (
            <ul className="divide-y divide-line">
              {alerts.slice(0, 8).map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <Icon name="alert" className={`h-4 w-4 ${SEV[a.severity]}`} />
                  <span className="min-w-0 flex-1"><span className="font-medium">{a.title}</span><span className="block truncate text-xs text-muted">{a.detail}</span></span>
                  <span className="text-xs text-muted">{fmtTime(a.last_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

const resultTone = (r: string) => (r === "SUCCESS" ? "text-ok" : r === "UNAUTHORIZED" ? "text-warn" : "text-bad");

function Events({ preset }: { preset: { categories?: string; uid?: string; resource?: string } | null }) {
  const [hours, setHours] = useState(24);
  const [cats, setCats] = useState<string[]>(preset?.categories ? preset.categories.split(",") : []);
  const [uid, setUid] = useState(preset?.uid ?? "");
  const [resource, setResource] = useState(preset?.resource ?? "");
  const [result, setResult] = useState("");
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ total: number; events: AuditLine[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<AuditLine | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [allCats, setAllCats] = useState<AuditCategory[]>([]);
  useEffect(() => {
    auth.users().then(setUsers, () => {});
    audit.categories().then(setAllCats, () => {});
  }, []);
  const load = useCallback(() => {
    const start = new Date(Date.now() - hours * 3600_000).toISOString();
    audit.events({ start, categories: cats.join(","), uid, resource, result, q, limit: 500 }).then(setData, (e: Error) => setError(e.message));
  }, [hours, cats, uid, resource, result, q]);
  useEffect(load, [load]);
  const refresh = () => {
    setData(null);
    load();
  };
  const toggle = (c: string) => setCats((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]));
  return (
    <>
      <Card title="Search audit logs" action={<span className="text-xs text-muted">filter by time first, then categories</span>}>
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap gap-2">
            <select className={fieldClass} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {[[1, "Last hour"], [24, "Last 24 hours"], [168, "Last 7 days"], [720, "Last 30 days"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select className={fieldClass} value={uid} onChange={(e) => setUid(e.target.value)}>
              <option value="">Any user</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.username}</option>)}
            </select>
            <select className={fieldClass} value={result} onChange={(e) => setResult(e.target.value)}>
              <option value="">Any result</option>
              {["SUCCESS", "UNAUTHORIZED", "ERROR"].map((r) => <option key={r}>{r}</option>)}
            </select>
            <input className={`${fieldClass} w-52`} placeholder="Resource id" value={resource} onChange={(e) => setResource(e.target.value)} />
            <input className={`${fieldClass} min-w-48 flex-1`} placeholder="Search any field (name, path, query…)" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[...new Set([...KEY_CATEGORIES, ...cats])].map((c) => (
              <button key={c} type="button" onClick={() => toggle(c)}
                className={`rounded-full px-2.5 py-1 font-mono text-[11px] ring-1 ${cats.includes(c) ? "bg-ocean/20 text-ocean ring-ocean/40" : "text-muted ring-line-2 hover:text-white"}`}>{c}</button>
            ))}
            <select className={`${fieldClass} py-0.5 text-xs`} value="" onChange={(e) => e.target.value && toggle(e.target.value)}>
              <option value="">More categories…</option>
              {allCats.filter((c) => !KEY_CATEGORIES.includes(c.name)).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </div>
        </div>
      </Card>
      {error && <ApiError message={error} />}
      <Card title="Events" count={data?.total} action={<button type="button" className={buttonClass.ghost} onClick={refresh}><Icon name="refresh" className="h-4 w-4" />Refresh</button>}>
        {!data ? <Loading /> : !data.events.length ? <p className="p-4 text-sm text-muted">No events match.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead className="text-muted"><tr className="border-b border-line">{["Time", "User", "Categories", "Name", "Resources", "Result"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {data.events.map((e) => (
                  <tr key={e.logEntryId} onClick={() => setOpen(e)} className="cursor-pointer border-b border-line/60 hover:bg-panel-2">
                    <td className="whitespace-nowrap px-3 py-2 text-muted">{fmtTime(e.time)}</td>
                    <td className="px-3 py-2">{e.userName ?? e.uid ?? <span className="text-muted">service</span>}</td>
                    <td className="px-3 py-2 font-mono text-ocean">{e.categories.join(", ")}</td>
                    <td className="max-w-[18rem] truncate px-3 py-2 font-mono text-soft" title={e.name}>{e.name}</td>
                    <td className="max-w-[12rem] truncate px-3 py-2 text-muted">{e.entities.map((x) => x.id).join(", ")}</td>
                    <td className={`px-3 py-2 ${resultTone(e.result)}`}>{e.result}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setOpen(null)}>
          <aside className="h-full w-full max-w-xl overflow-y-auto border-l border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="min-w-0 flex-1 truncate font-mono text-sm font-semibold">{open.name}</h2>
              <button type="button" className={buttonClass.ghost} onClick={() => setOpen(null)}><Icon name="x" className="h-4 w-4" /></button>
            </div>
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">
              {([["time", fmtTime(open.time)], ["user", open.userName ?? open.uid ?? "—"], ["organization", open.orgId ?? "—"], ["product", open.product], ["result", open.result],
                ["categories", open.categories.join(", ")], ["session", open.sid ?? "—"], ["token", open.tokenId ?? "—"], ["trace", open.traceId ?? "—"], ["origin", open.origin ?? "—"],
                ["user agent", open.userAgent ?? "—"]] as [string, string][]).map(([k, v]) => <Fragment key={k}><dt className="text-muted">{k}</dt><dd className="break-all">{v}</dd></Fragment>)}
            </dl>
            <h3 className="mt-4 text-xs font-semibold text-muted">requestFields</h3>
            <pre className="mt-1 overflow-x-auto rounded bg-ink p-3 text-[11px]">{JSON.stringify(open.requestFields, null, 2)}</pre>
            <h3 className="mt-3 text-xs font-semibold text-muted">resultFields</h3>
            <pre className="mt-1 overflow-x-auto rounded bg-ink p-3 text-[11px]">{JSON.stringify(open.resultFields, null, 2)}</pre>
            <h3 className="mt-3 text-xs font-semibold text-muted">Full line</h3>
            <pre className="mt-1 max-h-72 overflow-auto rounded bg-ink p-3 text-[11px]">{JSON.stringify(open, null, 2)}</pre>
          </aside>
        </div>
      )}
    </>
  );
}

function Alerts({ focus, onInvestigate }: { focus: string | null; onInvestigate: (q: { uid?: string }) => void }) {
  const [status, setStatus] = useState("open");
  const [rows, setRows] = useState<Alert[] | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [note, setNote] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => audit.alerts(status || undefined).then(setRows, (e: Error) => setError(e.message)), [status]);
  useEffect(() => {
    void load();
    auth.users().then(setUsers, () => {});
  }, [load]);
  const change = async (a: Alert, body: { status?: string; assignee?: string; note?: string }) => {
    try {
      await audit.updateAlert(a.id, body);
      setNote((n) => ({ ...n, [a.id]: "" }));
      void load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (error) return <ApiError message={error} />;
  return (
    <Card title="Alerts" count={rows?.length} action={
      <select className={`${fieldClass} py-0.5 text-xs`} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option><option value="">All</option>
      </select>}>
      {!rows ? <Loading /> : !rows.length ? <p className="p-4 text-sm text-muted">No alerts here. Detections open alerts as audit logs arrive.</p> : (
        <ul className="divide-y divide-line">
          {rows.map((a) => (
            <li key={a.id} className={`space-y-2 px-4 py-3 ${focus === a.id ? "bg-ocean/5" : ""}`}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Icon name="alert" className={`h-4 w-4 ${SEV[a.severity]}`} />
                <span className="font-medium">{a.title}</span>
                <span className={`text-xs uppercase ${SEV[a.severity]}`}>{a.severity}</span>
                <span className="text-xs text-muted">· {a.userName ?? a.key} · {a.count}× · {fmtTime(a.first_at)} – {fmtTime(a.last_at)}</span>
                <span className="ml-auto rounded-full bg-panel-2 px-2 py-0.5 text-xs capitalize text-soft ring-1 ring-line-2">{a.status}</span>
              </div>
              <p className="text-xs text-soft">{a.detail}</p>
              {a.notes.map((n, i) => <p key={i} className="border-l-2 border-line-2 pl-2 text-xs text-muted">{n.by} · {fmtTime(n.at)}: {n.text}</p>)}
              <div className="flex flex-wrap items-center gap-2">
                {a.uid && <button type="button" className={buttonClass.secondary} onClick={() => onInvestigate({ uid: a.uid ?? undefined })}><Icon name="search" className="h-4 w-4" />Investigate user</button>}
                {a.status !== "acknowledged" && a.status !== "resolved" && <button type="button" className={buttonClass.secondary} onClick={() => change(a, { status: "acknowledged" })}>Acknowledge</button>}
                {a.status !== "resolved" ? <button type="button" className={buttonClass.secondary} onClick={() => change(a, { status: "resolved" })}>Resolve</button>
                  : <button type="button" className={buttonClass.ghost} onClick={() => change(a, { status: "open" })}>Reopen</button>}
                <select className={`${fieldClass} text-xs`} value={a.assignee ?? ""} onChange={(e) => change(a, { assignee: e.target.value })}>
                  <option value="">Unassigned</option>
                  {users.filter((u) => u.role === "admin").map((u) => <option key={u.id} value={u.id}>{u.display_name || u.username}</option>)}
                </select>
                <input className={`${fieldClass} min-w-40 flex-1 text-xs`} placeholder="Add a note…" value={note[a.id] ?? ""} onChange={(e) => setNote((n) => ({ ...n, [a.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && note[a.id] && change(a, { note: note[a.id] })} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Detections() {
  const [rows, setRows] = useState<Detection[] | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = () => audit.detections().then(setRows, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    auth.users().then(setUsers, () => {});
  }, []);
  const save = async (d: Detection, body: Partial<Detection>) => {
    try {
      const out = await audit.updateDetection(d.id, body);
      setRows((r) => r?.map((x) => (x.id === d.id ? out : x)) ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const test = async (d: Detection) => {
    setTests((t) => ({ ...t, [d.id]: "Testing…" }));
    try {
      const r = await audit.testDetection(d.id, 7);
      setTests((t) => ({ ...t, [d.id]: `Last 7 days: ${r.matches} match${r.matches === 1 ? "" : "es"} over ${r.scanned.toLocaleString()} lines` + (r.by_user.length ? ` — ${r.by_user.slice(0, 4).map((u) => `${u.name} ${u.count}`).join(", ")}` : "") }));
    } catch (e) {
      setTests((t) => ({ ...t, [d.id]: (e as Error).message }));
    }
  };
  if (error) return <ApiError message={error} />;
  if (!rows) return <Loading />;
  return (
    <>
      <p className="max-w-3xl text-sm text-muted">Detections are category-based, so new features that log with the same categories are covered without changes. Tune thresholds against past logs (Test) before relying on alerts; recipients default to every administrator.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        {rows.map((d) => (
          <Card key={d.id} title={d.name} action={
            <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={d.enabled} onChange={(e) => save(d, { enabled: e.target.checked })} />Enabled</label>}>
            <div className="space-y-3 p-4 text-sm">
              <p className="text-xs text-muted">{d.description}</p>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted">Severity</span>
                <select className={`${fieldClass} text-xs`} value={d.severity} onChange={(e) => save(d, { severity: e.target.value as Detection["severity"] })}>
                  {["low", "medium", "high"].map((s) => <option key={s}>{s}</option>)}
                </select>
                {Object.entries(d.params).map(([k, v]) => (
                  <label key={k} className="flex items-center gap-1">
                    <span className="text-muted">{k}</span>
                    <input className={`${fieldClass} w-28 text-xs`} defaultValue={String(v)}
                      onBlur={(e) => { const raw = e.target.value; const val = typeof v === "number" ? Number(raw) : raw; if (String(val) !== String(v)) void save(d, { params: { [k]: val } }); }} />
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted">Notify</span>
                <select className={`${fieldClass} text-xs`} value="" onChange={(e) => e.target.value && save(d, { recipients: [...new Set([...d.recipients, e.target.value])] })}>
                  <option value="">{d.recipients.length ? "Add recipient…" : "Administrators (default) — add…"}</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.username}</option>)}
                </select>
                {d.recipients.map((r) => (
                  <button key={r} type="button" className="rounded-full bg-panel-2 px-2 py-0.5 ring-1 ring-line-2 hover:text-bad" onClick={() => save(d, { recipients: d.recipients.filter((x) => x !== r) })}>
                    {users.find((u) => u.id === r)?.username ?? r} ×
                  </button>
                ))}
                <label className="ml-auto flex items-center gap-1 text-muted"><input type="checkbox" checked={d.email} onChange={(e) => save(d, { email: e.target.checked })} />Email</label>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" className={buttonClass.secondary} onClick={() => test(d)}><Icon name="play" className="h-4 w-4" />Test on the last 7 days</button>
                {tests[d.id] && <span className="text-xs text-soft">{tests[d.id]}</span>}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function Baselines({ onInvestigate }: { onInvestigate: (q: { uid?: string }) => void }) {
  const [rows, setRows] = useState<Baseline[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    audit.baselines(14).then(setRows, (e: Error) => setError(e.message));
  }, []);
  if (error) return <ApiError message={error} />;
  if (!rows) return <Loading />;
  return (
    <Card title="User baselines (last 14 days)" count={rows.length}>
      <p className="px-4 pt-3 text-xs text-muted">Anomalies are only meaningful in context: compare today&apos;s activity with each user&apos;s usual level and sign-in hours.</p>
      <ul className="divide-y divide-line">
        {rows.map((b) => {
          const max = Math.max(1, ...b.login_hours);
          return (
            <li key={b.uid} className="grid gap-3 px-4 py-3 md:grid-cols-[12rem_1fr_14rem]">
              <div>
                <div className="font-medium">{b.name}</div>
                <div className="text-xs text-muted">{b.avg_per_day}/day usual · {b.today} today</div>
                <button type="button" onClick={() => onInvestigate({ uid: b.uid })} className="mt-1 text-xs text-ocean hover:underline">Events →</button>
              </div>
              <div>
                <div className="mb-1 text-[11px] text-muted">Sign-in hours (UTC)</div>
                <div className="flex h-8 items-end gap-px">
                  {b.login_hours.map((n, h) => <span key={h} title={`${h}:00 — ${n}`} className="flex-1 rounded-sm bg-ocean/60" style={{ height: `${Math.max(4, (n / max) * 100)}%`, opacity: n ? 1 : 0.15 }} />)}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">{b.top_categories.map(([c, n]) => <span key={c} className="rounded bg-panel-2 px-1.5 font-mono text-[10px] text-soft">{c} {n}</span>)}</div>
              </div>
              <div className="text-xs">
                <div className="text-muted">Exports {b.exports} · {fmtBytes(b.export_bytes)}</div>
                <div className="text-muted">Failed auth {b.failed_auth}</div>
                {b.flags.map((f) => <div key={f} className="mt-1 flex items-start gap-1 text-warn"><Icon name="alert" className="mt-0.5 h-3 w-3 shrink-0" />{f}</div>)}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Delivery() {
  const [orgs, setOrgs] = useState<AuditOrg[] | null>(null);
  const [exports, setExports] = useState<AuditExport[] | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ org: string; schema: string; name: string; retention: string; start: string; ack: boolean; folder: { id: string; name: string } | null } | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const load = () => {
    audit.organizations().then(setOrgs, (e: Error) => setError(e.message));
    audit.exports().then(setExports, () => {});
  };
  useEffect(() => {
    load();
    auth.users().then(setUsers, () => {});
  }, []);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = form ? [...(form.name.trim() ? [] : ["enter a dataset name"]), ...(form.folder ? [] : ["choose a location"]), ...(form.ack ? [] : ["confirm the sensitive-data notice"])] : [];
  const create = async () => {
    setTried(true);
    if (!form || missing.length || !form.folder) return;
    setBusy(true);
    setFormErr(null);
    try {
      await audit.createExport({ org: form.org, schema: form.schema, folder_id: form.folder.id, name: form.name, retention_days: form.retention ? Number(form.retention) : null,
        start_date: form.start || null, acknowledged: form.ack });
      setForm(null);
      setTimeout(load, 800);
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const nameInvalid = tried && !!form && !form.name.trim();
  const base = API_URL.replace(/\/$/, "");
  return (
    <>
      {error && <ApiError message={error} />}
      <Card title="Ingest into a SIEM (audit.3)">
        <div className="space-y-2 p-4 text-sm">
          <p className="text-muted">Poll the log files API: each 5-minute file is listed once its window has ended. <code>nextPageToken</code> is always returned — store it and pass it on the next request; an empty <code>data</code> means nothing new yet.</p>
          <pre className="overflow-x-auto rounded bg-ink p-3 text-[11px]">{`GET ${base}/api/v2/audit/organizations/<org>/logFiles?startDate=2026-01-01
GET ${base}/api/v2/audit/organizations/<org>/logFiles?pageToken=<nextPageToken>
GET ${base}/api/v2/audit/organizations/<org>/logFiles/<id>/content      (JSON lines)
Authorization: Bearer <access_token>`}</pre>
          <p className="text-xs text-muted">
            Recommended: a backend application in <Link href="/developer-console" className="text-ocean hover:underline">Developer Console</Link> with audit-read access (its tokens carry <code>api:audit-read</code>),
            using the client credentials grant; its service user must be an audit log reader below. Personal API tokens of administrators also work but are not recommended for production.
          </p>
        </div>
      </Card>
      <Card title="Audit log readers per organization">
        {!orgs ? <Loading /> : (
          <ul className="divide-y divide-line">
            {orgs.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1"><span className="font-medium">{o.name}</span> <span className="font-mono text-xs text-muted">{o.id}</span></span>
                {o.readers.map((r) => (
                  <button key={r} type="button" className="rounded-full bg-panel-2 px-2 py-0.5 text-xs ring-1 ring-line-2 hover:text-bad"
                    onClick={() => audit.setReaders(o.id, o.readers.filter((x) => x !== r)).then(load, (e: Error) => setError(e.message))}>
                    {users.find((u) => u.id === r)?.username ?? r} ×
                  </button>
                ))}
                <select className={`${fieldClass} text-xs`} value="" onChange={(e) => e.target.value && audit.setReaders(o.id, [...o.readers, e.target.value]).then(load, (er: Error) => setError(er.message))}>
                  <option value="">Add reader…</option>
                  {users.filter((u) => !o.readers.includes(u.id)).map((u) => <option key={u.id} value={u.id}>{u.display_name || u.username}</option>)}
                </select>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Export datasets" count={exports?.length} action={
        <button type="button" className={buttonClass.primary} onClick={() => (setTried(false), setFormErr(null), setForm({ org: orgs?.[0]?.id ?? "default", schema: "audit.3", name: "Audit logs", retention: "90", start: "", ack: false, folder: null }))}>
          <Icon name="plus" className="h-4 w-4" />Create export dataset
        </button>}>
        {form && (
          <div className="space-y-3 border-b border-line p-4 text-sm">
            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1"><span className="text-xs text-muted">Organization</span>
                <select className={inputClass} value={form.org} onChange={(e) => setForm({ ...form, org: e.target.value })}>{orgs?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
              <label className="space-y-1"><span className="text-xs text-muted">Log type</span>
                <select className={inputClass} value={form.schema} onChange={(e) => setForm({ ...form, schema: e.target.value })}>
                  <option value="audit.3">audit.3 (current logs)</option><option value="audit.2">audit.2 (sign-in log kept before audit.3)</option></select></label>
              <label className="block"><span className="mb-1 flex items-center gap-1 text-xs font-medium text-soft">Dataset name <span className="text-bad" aria-hidden>*</span></span>
                <input className={`${inputClass} ${nameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} aria-invalid={nameInvalid} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                {nameInvalid && <span className="mt-1 block text-[11px] text-bad">Give the dataset a name.</span>}</label>
              <label className="space-y-1"><span className="text-xs text-muted">Start date (optional)</span><input type="date" className={inputClass} value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></label>
              <label className="space-y-1"><span className="text-xs text-muted">Retention in days (max 730, empty = keep all)</span><input className={inputClass} value={form.retention} onChange={(e) => setForm({ ...form, retention: e.target.value.replace(/\D/g, "") })} /></label>
              <LocationField value={form.folder} onChange={(folder) => setForm((f) => (f ? { ...f, folder } : f))} invalid={tried} hint="Where the audit log dataset goes." />
            </div>
            <p className="text-xs text-muted">The dataset is marked with the organization&apos;s marking, so only its members with need-to-know access can open it; add markings afterwards in Files to narrow it further.</p>
            <label className={`flex items-start gap-2 text-xs ${tried && !form.ack ? "rounded-md text-bad ring-1 ring-bad/40" : ""}`}><input type="checkbox" checked={form.ack} onChange={(e) => setForm({ ...form, ack: e.target.checked })} className="mt-0.5" aria-invalid={tried && !form.ack} />
              <span>I understand that this dataset holds sensitive usage data (names, search queries, resources) and the settings applied to it. <span className="text-bad" aria-hidden>*</span></span></label>
            {formErr && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{formErr}</p>}
            <div className="flex items-center justify-end gap-2">
              {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To create: {missingText(missing)}</span>}
              <button type="button" className={buttonClass.ghost} onClick={() => setForm(null)}>Cancel</button>
              <button type="button" className={buttonClass.primary} disabled={busy} onClick={create}>{busy ? "Creating…" : "Create export"}</button>
            </div>
          </div>
        )}
        {!exports ? <Loading /> : !exports.length ? <p className="p-4 text-sm text-muted">No export datasets.</p> : (
          <ul className="divide-y divide-line">
            {exports.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <Icon name="table" className="h-4 w-4 text-ocean" />
                <span className="min-w-0 flex-1">
                  {x.item_id ? <Link href={`/datasets/${x.item_id}`} className="font-medium hover:underline">{x.name}</Link> : <span className="font-medium">{x.name}</span>}
                  <span className="block text-xs text-muted">{x.schema} · {x.org} · {x.rows.toLocaleString()} rows · retention {x.retention_days ? `${x.retention_days} days` : "none"} · last run {fmtTime(x.last_run)}{x.error ? ` · ${x.error}` : ""}</span>
                </span>
                {x.paused ? <span className="text-xs text-warn">Paused</span> : <span className="text-xs text-ok">Exporting</span>}
                <button type="button" className={buttonClass.ghost} onClick={() => audit.runExport(x.id).then(load, (e: Error) => setError(e.message))}><Icon name="refresh" className="h-4 w-4" />Append now</button>
                <button type="button" className={buttonClass.secondary} onClick={() => audit.updateExport(x.id, { paused: !x.paused }).then(load, (e: Error) => setError(e.message))}>{x.paused ? "Resume export" : "Pause export"}</button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Categories() {
  const [rows, setRows] = useState<AuditCategory[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    audit.categories().then(setRows, () => setRows([]));
  }, []);
  const shown = useMemo(() => rows?.filter((c) => !q || `${c.name} ${c.description}`.toLowerCase().includes(q.toLowerCase())) ?? [], [rows, q]);
  if (!rows) return <Loading />;
  return (
    <Card title="audit.3 categories" count={rows.length} action={<input className={`${fieldClass} text-xs`} placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="text-muted"><tr className="border-b border-line">{["Category", "Description", "Request fields", "Result fields"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.name} className="border-b border-line/60 align-top">
                <td className="px-3 py-2 font-mono text-ocean">{c.name}</td>
                <td className="px-3 py-2 text-soft">{c.description}</td>
                <td className="px-3 py-2 font-mono text-muted">{c.request_fields.join(", ") || "—"}</td>
                <td className="px-3 py-2 font-mono text-muted">{c.result_fields.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
