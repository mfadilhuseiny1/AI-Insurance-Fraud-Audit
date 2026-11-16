"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { Field } from "@/components/pipeline/ui";
import { when } from "@/lib/format";
import { health, type DatasetHealth, type ExpectationRow } from "@/lib/health";
import { streaming, type MonitoringView } from "@/lib/streaming";

type Tab = "views" | "datasets" | "expectations";

/**
 * Data Health: Monitoring Views group monitors on streams, streaming syncs, datasets and schedules, with
 * subscriptions for alerts; dataset health checks (set in Data Lineage) and expectation results of builds.
 */
export default function DataHealthApp() {
  const [tab, setTab] = useState<Tab>("views");
  const [views, setViews] = useState<MonitoringView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // "Monitor" from another app (Data Connection …): /data-health?add=<resource type>:<resource id>&name=<label>
  const [adding, setAdding] = useState<{ add: string; name: string } | null>(null);
  const load = () => streaming.views().then(setViews, (e: Error) => setError(e.message));
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const add = q.get("add");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the URL on load
    if (add) setAdding({ add, name: q.get("name") ?? add });
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl p-8">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Icon name="bell" className="h-5 w-5 text-ocean" /> Data Health
            </h1>
            <p className="mt-1 text-sm text-muted">
              Monitoring Views [Beta] watch ingest streams, streaming syncs, datasets, schedules and Data Connection syncs and exports: records ingested, checkpoints, lag,
              freshness (of the dataset or of the data itself), schema, row counts, build, schedule and sync status. Alerts go to email, PagerDuty or a webhook, as they
              happen or as an hourly or daily digest.
            </p>
          </div>
          {tab === "views" && (
            <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
              <Icon name="plus" /> New monitoring view
            </button>
          )}
        </div>
        {adding && (
          <div className="mb-4 rounded-xl border border-ocean/40 bg-ocean/10 p-3 text-sm">
            <div className="flex items-center gap-2">
              <Icon name="bell" className="h-4 w-4 text-ocean" /> Add a health check for <span className="font-medium">{adding.name}</span>: choose the monitoring view
              it goes in.
              <button type="button" onClick={() => setAdding(null)} className="ml-auto text-muted hover:text-white">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(views ?? []).map((v) => (
                <Link key={v.id} href={`/data-health/views/${v.id}?add=${encodeURIComponent(adding.add)}`} className={`${buttonClass.secondary} py-1 text-xs`}>
                  <Icon name="gauge" className="h-3.5 w-3.5" /> {v.name}
                </Link>
              ))}
              <button type="button" onClick={() => setCreating(true)} className={`${buttonClass.secondary} py-1 text-xs`}>
                <Icon name="plus" className="h-3.5 w-3.5" /> New monitoring view
              </button>
            </div>
          </div>
        )}
        <div className="mb-4 flex gap-1 text-sm">
          {(
            [
              ["views", "Monitoring views", "gauge"],
              ["datasets", "Dataset checks", "database"],
              ["expectations", "Expectations", "check"],
            ] as const
          ).map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 ${tab === id ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:bg-panel-2 hover:text-white"}`}
            >
              <Icon name={icon} className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
        {tab === "datasets" && <DatasetChecks />}
        {tab === "expectations" && <Expectations />}
        {tab === "views" && error && <p className="text-sm text-bad">{error}</p>}
        {tab !== "views" ? null : !views ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : views.length === 0 ? (
          <p className="rounded-xl border-2 border-dashed border-line-2 py-12 text-center text-sm text-muted">
            No monitoring views yet. Create one, then add monitoring rules for your streams and syncs.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {views.map((v) => (
              <Link key={v.id} href={`/data-health/views/${v.id}`} className="rounded-xl border border-line bg-panel p-4 hover:border-ocean/60">
                <div className="flex items-center gap-2 font-medium">
                  <Icon name="gauge" className="h-4 w-4 text-ocean" /> {v.name}
                  {v.firing > 0 && <span className="ml-auto rounded-full bg-bad/15 px-2 py-0.5 text-xs text-bad">{v.firing} firing</span>}
                </div>
                {v.description && <p className="mt-1 text-xs text-soft">{v.description}</p>}
                <div className="mt-1 text-xs text-muted">
                  {v.monitors} monitor{v.monitors === 1 ? "" : "s"} · created {when(v.created_at)}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
      {creating && <NewViewDialog onClose={() => setCreating(false)} onCreated={() => (setCreating(false), load())} />}
    </div>
  );
}

/** The health rules set on datasets in Data Lineage, checked in the background every couple of minutes. */
function DatasetChecks() {
  const [list, setList] = useState<DatasetHealth[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (refresh = false) =>
    health.datasets(refresh).then(
      (l) => {
        setList(l);
        setError(null);
        setBusy(false);
      },
      (e: Error) => {
        setError(e.message);
        setBusy(false);
      },
    );
  useEffect(() => {
    load();
    const t = setInterval(() => load(), 30000);
    return () => clearInterval(t);
  }, []);
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-4">
        <p className="text-sm text-muted">
          Health checks set on datasets in{" "}
          <Link href="/lineage" className="text-ocean hover:underline">
            Data Lineage
          </Link>{" "}
          (Data health tab), checked every two minutes. To alert on them, add the same checks as monitors to a monitoring view.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            load(true);
          }}
          className={buttonClass.secondary}
        >
          <Icon name="refresh" className={busy ? "animate-spin" : ""} /> Check now
        </button>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {list?.length === 0 && <p className="rounded-xl border-2 border-dashed border-line-2 py-10 text-center text-sm text-muted">No dataset has health checks yet.</p>}
      <div className="space-y-2">
        {list?.map((d) => (
          <div key={d.item_id} className="rounded-xl border border-line bg-panel p-3 text-sm">
            <div className="flex items-center gap-2">
              <Icon name={d.status === "failing" ? "alert" : "check"} className={`h-4 w-4 ${d.status === "failing" ? "text-bad" : "text-ok"}`} />
              <span className="font-medium">{d.name}</span>
              <span className="truncate text-xs text-muted">{d.path.join(" / ")}</span>
              <span className="ml-auto text-xs text-muted">checked {when(d.checked_at)}</span>
            </div>
            <ul className="mt-1.5 space-y-0.5 pl-6 text-xs">
              {d.results.map((r, i) => (
                <li key={r.id ?? i} className={r.ok ? "text-soft" : "text-bad"}>
                  {r.kind.replace(/_/g, " ")}: {r.message}
                  {r.failing_since && <span className="text-muted"> · failing since {when(r.failing_since)}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Expectation results of recent builds: output expectations and input pre-conditions. */
function Expectations() {
  const [rows, setRows] = useState<ExpectationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [only, setOnly] = useState<"failing" | "all">("failing");
  useEffect(() => {
    health.expectations(300).then(setRows, (e: Error) => setError(e.message));
  }, []);
  const shown = (rows ?? []).filter((r) => only === "all" || !r.ok);
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <p className="mr-auto text-sm text-muted">
          Pipeline Builder expectations on outputs and pre-conditions on inputs, and the data expectation checks of Python transforms in Code Repositories, from recent builds. Warn-only checks never stop a build.
        </p>
        {(["failing", "all"] as const).map((f) => (
          <button key={f} type="button" onClick={() => setOnly(f)} className={`rounded-md px-2.5 py-1 text-xs capitalize ${only === f ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:bg-panel-2"}`}>
            {f}
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {rows !== null && !shown.length && (
        <p className="rounded-xl border-2 border-dashed border-line-2 py-10 text-center text-sm text-muted">{only === "failing" ? "No failing expectations." : "No expectations checked yet."}</p>
      )}
      {shown.length > 0 && (
        <table className="w-full rounded-xl border border-line bg-panel text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-3 py-2">Result</th>
              <th className="px-3 py-2">Pipeline or transform</th>
              <th className="px-3 py-2">On</th>
              <th className="px-3 py-2">Check</th>
              <th className="px-3 py-2">Build</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={`${r.build_id}-${r.id}-${i}`} className="border-b border-line align-top text-xs last:border-0">
                <td className="px-3 py-2">{r.ok ? <span className="text-ok">Pass</span> : r.mode === "warn" ? <span className="text-warn">Warn</span> : <span className="text-bad">Fail</span>}</td>
                <td className="px-3 py-2">
                  <Link href={r.source === "code" ? `/code-repositories/${r.repo_id}` : `/pipeline/${r.pipeline_id}`} className="text-ocean hover:underline">
                    {r.pipeline_name}
                  </Link>
                  {r.source === "code" && <span className="ml-1 rounded bg-panel-2 px-1 text-[10px] text-muted">code</span>}
                  {r.branch !== "main" && r.branch !== "master" && <span className="text-muted"> · {r.branch}</span>}
                </td>
                <td className="px-3 py-2">
                  {r.target_kind === "input" ? "pre-condition on " : ""}
                  {r.target}
                </td>
                <td className="px-3 py-2 text-soft">
                  {r.source === "code" && <span className="font-medium">{r.id}: </span>}
                  {r.message}
                </td>
                <td className="px-3 py-2">
                  <Link href={r.source === "code" ? `/builds` : `/pipeline/${r.pipeline_id}/builds/${r.build_id}`} className="text-ocean hover:underline">
                    {r.build_status}
                  </Link>
                  <div className="text-muted">{when(r.at)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewViewDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("Streaming pipelines");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = () =>
    streaming.createView(name.trim(), description).then(onCreated, (e: Error) => setError(e.message));
  return (
    <Modal title="New monitoring view" icon="bell" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </Field>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!name.trim()} onClick={create} className={buttonClass.primary}>
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}
