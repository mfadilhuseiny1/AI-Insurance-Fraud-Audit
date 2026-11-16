"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type DriveItem } from "@/lib/api";
import { auth, type Marking } from "@/lib/auth";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { peering, STATUS_LABEL, type Channel, type Enrollment, type Network, type OntologyEntity, type PeerConnection, type PeerJob, type PeerLinkType, type Profile } from "@/lib/peering";

/** Peer Manager (palantir.com/docs/foundry/peer-manager): network connections, peer connections between Projects of
 *  two enrollments, ontology peering, peering jobs and peer profiles. api/peering.py */
export default function PeerManagerPage() {
  const [tab, setTab] = useState<"connections" | "profiles" | "network" | "enrollment">("connections");
  const [conns, setConns] = useState<PeerConnection[] | null>(null);
  const [nets, setNets] = useState<Network[]>([]);
  const [me, setMe] = useState<Enrollment | null>(null);
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [markings, setMarkings] = useState<Marking[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "request" | "enter">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    peering.connections().then(setConns, (e: Error) => (setConns([]), setMsg(e.message)));
    peering.networks().then(setNets, () => {});
    peering.enrollment().then(setMe, () => {});
  }, []);
  useEffect(() => {
    load();
    api.drive.folder(null).then((f) => setProjects(f.items.filter((i) => i.kind === "project")), () => {});
    auth.markings().then(setMarkings, () => {});
  }, [load]);
  const selected = conns?.find((c) => c.id === selectedId) ?? conns?.[0] ?? null;
  const remoteName = (c: PeerConnection) => c.network?.remote_title || c.network?.name || c.remote_rid;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="rounded-md bg-ocean/15 p-1.5 text-ocean">
            <Icon name="link" className="h-4 w-4" />
          </span>
          Peer Manager
        </div>
        <span className="text-xs text-muted">{me?.display ?? "…"}</span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setDialog("enter")} className="rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white">
            Enter invite code
          </button>
          <button type="button" onClick={() => setDialog("request")} className="flex items-center gap-1.5 rounded-md bg-ocean px-3 py-1.5 text-xs font-medium text-white hover:bg-ocean-deep">
            <Icon name="plus" className="h-3.5 w-3.5" /> Create a peer request
          </button>
        </div>
      </header>
      <div className="flex border-b border-line bg-panel px-5">
        {(
          [
            ["connections", "Peer connections", conns?.length],
            ["profiles", "Peer profiles", undefined],
            ["network", "Network connections", nets.length],
            ["enrollment", "This enrollment", undefined],
          ] as const
        ).map(([id, label, n]) => (
          <button key={id} type="button" onClick={() => setTab(id)} className={`border-b-2 px-3 py-3 text-xs ${tab === id ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>
            {label} {n !== undefined && <span className="ml-1 rounded-full bg-panel-2 px-1.5 py-0.5 text-[10px]">{n}</span>}
          </button>
        ))}
      </div>
      {msg && (
        <button type="button" onClick={() => setMsg(null)} className="border-b border-line bg-panel-2 px-5 py-1.5 text-left text-xs text-soft">
          {msg} <span className="text-muted">(dismiss)</span>
        </button>
      )}
      {tab === "connections" && (
        <div className="flex min-h-0 flex-1">
          <aside className="w-[360px] shrink-0 overflow-y-auto border-r border-line bg-panel p-4">
            <div className="mb-3 text-xs font-semibold text-soft">Connections</div>
            {conns?.length === 0 && <p className="text-xs text-muted">No peer connections. Establish a network connection, then create a peer request or enter an invite code.</p>}
            <div className="space-y-2">
              {conns?.map((c) => (
                <button key={c.id} type="button" onClick={() => setSelectedId(c.id)} className={`w-full rounded-lg border p-3 text-left ${selected?.id === c.id ? "border-ocean/50 bg-ocean/10" : "border-line hover:bg-panel-2"}`}>
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${c.health === "healthy" ? "bg-ok" : c.health === "failing" ? "bg-bad" : c.health === "active" || c.health === "unknown" ? "bg-ocean" : "bg-muted"}`} />
                    <span className="truncate text-sm font-medium text-white">{remoteName(c)}</span>
                    <span className="ml-auto text-[10px] capitalize text-muted">{c.health}</span>
                  </div>
                  <div className="mt-2 text-[10px] text-muted">
                    {c.project_name} ↔ {c.remote_project ?? "?"} · objects {[c.data_types.objects.export && "export", c.data_types.objects.import && "import"].filter(Boolean).join(" + ") || "none"}
                  </div>
                  <div className="mt-1 text-[10px] text-muted">
                    {c.ontology.mappings.length} mapping{c.ontology.mappings.length === 1 ? "" : "s"} · {c.jobs_count} jobs
                  </div>
                </button>
              ))}
            </div>
          </aside>
          <main className="min-w-0 flex-1 overflow-y-auto">{selected ? <ConnectionView c={selected} markings={markings} onChanged={load} onMsg={setMsg} remote={remoteName(selected)} /> : null}</main>
        </div>
      )}
      {tab === "profiles" && <Profiles projects={projects} markings={markings} nets={nets} onMsg={setMsg} onChanged={load} />}
      {tab === "network" && <NetworkView nets={nets} onChanged={load} onMsg={setMsg} />}
      {tab === "enrollment" && me && <EnrollmentView me={me} onChanged={setMe} onMsg={setMsg} />}
      {dialog === "request" && <RequestDialog nets={nets} projects={projects} markings={markings} onClose={() => setDialog(null)} onDone={() => load()} />}
      {dialog === "enter" && (
        <EnterDialog
          projects={projects}
          markings={markings}
          onClose={() => setDialog(null)}
          onDone={(c) => {
            setDialog(null);
            setSelectedId(c.id);
            setTab("connections");
            load();
          }}
        />
      )}
    </div>
  );
}

function MarkingPicker({ markings, value, onChange }: { markings: Marking[]; value: string[]; onChange: (v: string[]) => void }) {
  if (!markings.length) return <p className="text-[11px] text-muted">No markings defined: only unmarked object types can peer.</p>;
  return (
    <div className="flex flex-wrap gap-1">
      {markings.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onChange(value.includes(m.id) ? value.filter((x) => x !== m.id) : [...value, m.id])}
          className={`rounded-full border px-2 py-0.5 text-[11px] ${value.includes(m.id) ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-soft"}`}
        >
          {m.name}
        </button>
      ))}
    </div>
  );
}

function ConnectionView({ c, markings, onChanged, onMsg, remote }: { c: PeerConnection; markings: Marking[]; onChanged: () => void; onMsg: (m: string) => void; remote: string }) {
  const [tab, setTab] = useState<"overview" | "ontology" | "files" | "settings">("overview");
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) onMsg(done);
      onChanged();
    } catch (e) {
      onMsg((e as Error).message);
    }
  };
  const pendingFromRemote = c.security_requests.filter((r) => r.from === "remote" && r.state === "pending");
  return (
    <>
      <div className="border-b border-line bg-panel px-6 py-5">
        <div className="flex items-start gap-4">
          <span className="rounded-lg bg-ocean/15 p-3 text-ocean">
            <Icon name="link" className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold">{remote}</h1>
              <span className="rounded-full bg-panel-2 px-2 py-0.5 text-[10px] capitalize text-soft">{c.status}</span>
              <span className="text-[10px] capitalize text-muted">{c.health}</span>
            </div>
            <p className="mt-1 text-xs text-muted">
              Local Project <span className="text-soft">{c.project_name}</span> ↔ remote Project <span className="text-soft">{c.remote_project ?? "?"}</span> · you are the {c.role} · security:{" "}
              {c.security_names.length ? c.security_names.join(", ") : "unmarked data only"}
            </p>
            {c.last_error && <p className="mt-1 text-[11px] text-warn">Last error: {c.last_error}</p>}
          </div>
          {c.role === "originator" && c.status === "approved" && (
            <button type="button" onClick={() => act(() => peering.activate(c.id), "Activated.")} className={buttonClass.primary}>
              Activate
            </button>
          )}
          {c.status === "active" && (
            <button type="button" onClick={() => act(async () => onMsg(`${(await peering.sync(c.id)).length} export job(s) run.`))} className={buttonClass.secondary}>
              <Icon name="refresh" className="h-3.5 w-3.5" /> Sync now
            </button>
          )}
          {c.network?.pulls && (
            <button
              type="button"
              onClick={() => act(async () => {
                const r = await peering.pull(c.id);
                onMsg(`Pulled ${r.messages} control message(s) and ${r.payloads} payload(s): ${r.applied} edit(s) applied${r.failed ? `, ${r.failed} failed` : ""}.`);
              })}
              className={buttonClass.secondary}
            >
              Pull now
            </button>
          )}
        </div>
        {c.status === "requested" && <p className="mt-3 rounded-md bg-ocean/10 p-2 text-xs text-soft">Waiting for the remote administrator to enter the invite code and approve the request.</p>}
        {pendingFromRemote.length > 0 && (
          <div className="mt-3 rounded-md border border-warn/40 bg-warn/10 p-2 text-xs text-warn">
            The remote side asks to change the security to: {pendingFromRemote[0].markings.join(", ") || "no markings"}.
            <button type="button" onClick={() => act(() => peering.approveSecurity(c.id, pendingFromRemote[0].id, true), "Security change approved.")} className="ml-2 text-ok hover:underline">
              Approve
            </button>
            <button type="button" onClick={() => act(() => peering.approveSecurity(c.id, pendingFromRemote[0].id, false), "Rejected.")} className="ml-2 text-bad hover:underline">
              Reject
            </button>
          </div>
        )}
        <div className="mt-4 flex gap-1">
          {(["overview", "ontology", "files", "settings"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={`rounded-md px-3 py-1.5 text-xs capitalize ${tab === t ? "bg-ocean/15 text-white" : "text-muted hover:bg-panel-2 hover:text-white"}`}>
              {t}
            </button>
          ))}
        </div>
      </div>
      {tab === "overview" && <Jobs c={c} />}
      {tab === "ontology" && <OntologyTab c={c} act={act} />}
      {tab === "files" && (
        <div className="p-6 text-sm text-muted">File peering synchronizes Gotham files (Gaia maps). There is no Gotham here, so files do not peer over this connection.</div>
      )}
      {tab === "settings" && <SettingsTab c={c} markings={markings} act={act} />}
    </>
  );
}

function Jobs({ c }: { c: PeerConnection }) {
  const [f, setF] = useState<Record<string, string>>({ direction: "", payload: "", sequencing: "", status: "", q: "" });
  const [jobs, setJobs] = useState<PeerJob[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => peering.jobs(c.id, f).then((j) => alive && setJobs(j), () => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [c.id, f]);
  const sel = (key: string, options: [string, string][]) => (
    <select value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} className="rounded border border-line-2 bg-ink px-2 py-1 text-xs text-soft outline-none">
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
  return (
    <div className="p-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Search by job ID" className="rounded border border-line-2 bg-ink px-2 py-1 text-xs text-soft outline-none" />
        {sel("direction", [["", "Any direction"], ["export", "Export"], ["import", "Import"]])}
        {sel("payload", [["", "Any payload"], ["data", "Data"], ["ack", "Ack"]])}
        {sel("sequencing", [["", "Any sequencing"], ["concurrent", "Concurrent"], ["sequential", "Sequential"]])}
        {sel("status", [["", "Non-empty jobs"], ["succeeded", "Succeeded"], ["failed", "Failed"], ["awaiting_pull", "Awaiting pull"], ["ready_to_download", "Ready to download"], ["empty", "Empty"]])}
        <button type="button" onClick={() => setF({ direction: "", payload: "", sequencing: "", status: "", q: "" })} className="text-xs text-ocean hover:underline">
          Reset all filters
        </button>
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-line text-[10px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Job</th>
              <th className="px-4 py-2.5">Type</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Producer</th>
              <th className="px-4 py-2.5">Objects</th>
              <th className="px-4 py-2.5">Ran</th>
            </tr>
          </thead>
          <tbody>
            {jobs?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-muted">
                  No jobs match.
                </td>
              </tr>
            )}
            {jobs?.map((j) => (
              <tr key={j.id} className="border-b border-line align-top last:border-0">
                <td className="px-4 py-2 font-mono text-[11px] text-muted">{j.id}</td>
                <td className="px-4 py-2 text-soft">
                  {j.direction === "export" ? "Export" : "Import"} · {j.payload === "data" ? "Data" : "Ack"}
                  <div className="text-[10px] capitalize text-muted">{j.sequencing}</div>
                </td>
                <td className={`px-4 py-2 ${j.status === "failed" ? "text-bad" : j.status === "succeeded" ? "text-ok" : "text-soft"}`}>
                  {STATUS_LABEL[j.status] ?? j.status}
                  {j.error && <div className="max-w-xs text-[10px] text-bad">{j.error}</div>}
                  {j.error_instance_id && <div className="text-[10px] text-muted">error instance {j.error_instance_id}</div>}
                </td>
                <td className="px-4 py-2 text-muted">{j.producer}</td>
                <td className="px-4 py-2 text-muted">
                  {j.objects}
                  {j.unchanged ? (
                    <div className="text-[10px]" data-job-unchanged={j.id}>
                      {j.unchanged} unchanged (already held here)
                    </div>
                  ) : null}
                  {j.stale_skipped ? (
                    <div className="text-[10px] text-warn" data-job-stale={j.id} title="A newer version of these objects (by origin version) is already held here">
                      {j.stale_skipped} stale skipped (older than held here)
                    </div>
                  ) : null}
                  {j.echo_skipped ? (
                    <div className="text-[10px]" data-job-echo={j.id}>
                      {j.echo_skipped} not sent back (as received from the remote)
                      {j.echo_fingerprinted ? ` · ${j.echo_fingerprinted} compared by fingerprint (no origin version)` : ""}
                    </div>
                  ) : null}
                  {j.owed_deletions ? (
                    <div className="text-[10px]" data-job-owed={j.id} title="Deletions an earlier export could not deliver (the remote offline or the connection disabled)">
                      {j.owed_deletions} owed deletion{j.owed_deletions === 1 ? "" : "s"} sent again
                    </div>
                  ) : null}
                  {j.acked_seq != null && (
                    <div className="text-[10px]" data-ack-job={j.id}>
                      {j.direction === "export" ? "acknowledged" : "remote acknowledged"} up to #{j.acked_seq}
                      {j.acknowledged ? ` (new: ${j.acknowledged})` : ""}
                      {j.missing ? <span className="text-warn"> · missing {j.missing}</span> : null}
                      {j.via ? ` · via ${j.via === "relay" ? "relay channel" : "network connection"}` : ""}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2 text-muted">{when(j.started_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted">Empty jobs (a catch-up job with nothing to send) are hidden by default: they mean real-time peering is keeping up.</p>
    </div>
  );
}

function OntologyTab({ c, act }: { c: PeerConnection; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [types, setTypes] = useState<(OntologyEntity & { id: string })[]>([]);
  const [adding, setAdding] = useState<string[]>([]);
  const [blocked, setBlocked] = useState(false);
  const [mapping, setMapping] = useState<{ local: OntologyEntity; remote: OntologyEntity } | null>(null);
  useEffect(() => {
    peering.objectTypes().then(setTypes, () => {});
  }, []);
  const mappedLocal = new Set(c.ontology.mappings.map((m) => m.local_type_id));
  const unmappedLocal = c.ontology.local.filter((x) => !mappedLocal.has(x.object_type_id!));
  const unmappedRemote = c.ontology.remote.filter((x) => !c.ontology.mappings.some((m) => m.remote_type_id === x.id));
  return (
    <div className="space-y-5 p-6 text-xs">
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="mb-2 font-semibold text-soft">Mapped</div>
        {c.ontology.mappings.length === 0 && <p className="text-muted">No object type mappings yet.</p>}
        {c.ontology.mappings.map((m) => {
          const l = c.ontology.local.find((x) => x.object_type_id === m.local_type_id);
          const r = c.ontology.remote.find((x) => x.id === m.remote_type_id);
          return (
            <div key={m.id} className="flex items-center gap-3 border-t border-line py-2 first:border-0">
              <Icon name="cube" className="h-4 w-4 text-ocean" />
              <span className="text-soft">{l?.display_name ?? m.local_type_id}</span>
              <Icon name="right" className="h-3 w-3 text-muted" />
              <span className="text-soft">{r?.display_name ?? m.remote_type_id}</span>
              <span className="text-muted">
                {Object.keys(m.properties).length} properties · actions {[m.actions_export && "export", m.actions_import && "import"].filter(Boolean).join(" + ") || "off"} · source data{" "}
                {[m.source_export && "export", m.source_import && "import"].filter(Boolean).join(" + ") || "off"}
              </span>
              <span className="text-muted">{m.acked ? `acknowledged up to ${when(m.acked)}` : "nothing acknowledged yet"}</span>
              <button type="button" onClick={() => act(() => peering.deleteMapping(c.id, m.id), "Mapping removed.")} className="ml-auto text-muted hover:text-bad">
                Remove
              </button>
            </div>
          );
        })}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-line bg-panel p-4">
          <div className="mb-2 font-semibold text-soft">Unmapped · local ontology</div>
          {unmappedLocal.map((x) => (
            <div key={x.object_type_id} className="flex items-center gap-2 py-1">
              <Icon name="cube" className="h-3.5 w-3.5 text-muted" /> <span className="text-soft">{x.display_name}</span>
              {x.imports_blocked && <span className="text-[10px] text-warn">imports blocked</span>}
            </div>
          ))}
          <div className="mt-3 border-t border-line pt-3">
            <div className="mb-1 text-muted">+ Add ontology entities</div>
            <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
              {types
                .filter((t) => !c.ontology.local.some((x) => x.object_type_id === t.id))
                .map((t) => (
                  <button key={t.id} type="button" onClick={() => setAdding(adding.includes(t.id) ? adding.filter((x) => x !== t.id) : [...adding, t.id])} className={`rounded-full border px-2 py-0.5 ${adding.includes(t.id) ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-soft"}`}>
                    {t.display_name}
                  </button>
                ))}
            </div>
            <label className="mt-2 flex items-center gap-2 text-soft">
              <input type="checkbox" checked={blocked} onChange={(e) => setBlocked(e.target.checked)} /> Imports blocked (only send)
            </label>
            <button type="button" disabled={!adding.length} onClick={() => act(() => peering.addEntities(c.id, adding, blocked), "Added.").then(() => setAdding([]))} className={`${buttonClass.secondary} mt-2`}>
              Add {adding.length || ""} ontology entities
            </button>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-panel p-4">
          <div className="mb-2 font-semibold text-soft">Unmapped · remote ontology</div>
          {unmappedRemote.length === 0 && <p className="text-muted">The remote side has made no (other) object types available yet.</p>}
          {unmappedRemote.map((x) => (
            <div key={x.id} className="flex items-center gap-2 py-1">
              <Icon name="cube" className="h-3.5 w-3.5 text-muted" /> <span className="text-soft">{x.display_name}</span>
              <select
                defaultValue=""
                onChange={(e) => {
                  const l = c.ontology.local.find((y) => y.object_type_id === e.target.value);
                  if (l) setMapping({ local: l, remote: x });
                }}
                className="ml-auto rounded border border-line-2 bg-ink px-1 py-0.5 text-soft outline-none"
              >
                <option value="">+ map to…</option>
                {unmappedLocal.map((l) => (
                  <option key={l.object_type_id} value={l.object_type_id}>
                    {l.display_name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>
      <LinkTypesCard c={c} act={act} />
      {mapping && <MappingDialog c={c} local={mapping.local} remote={mapping.remote} act={act} onClose={() => setMapping(null)} />}
    </div>
  );
}

/** Join table link types: offered on each side, then mapped once both of their object types are mapped. */
function LinkTypesCard({ c, act }: { c: PeerConnection; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [all, setAll] = useState<PeerLinkType[]>([]);
  useEffect(() => {
    peering.linkTypes().then(setAll, () => {});
  }, []);
  const local = c.ontology.local_links ?? [];
  const remote = c.ontology.remote_links ?? [];
  const maps = c.ontology.link_mappings ?? [];
  const typeName = (id: string) => c.ontology.local.find((x) => x.object_type_id === id)?.display_name ?? id;
  const offerable = all.filter((l) => !local.some((x) => x.link_type_id === l.link_type_id));
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="mb-1 font-semibold text-soft">Link types (join tables)</div>
      <p className="mb-2 text-muted">Foreign key links travel with the objects. Join table links peer once both object types are mapped: sequential jobs send the link pairs when they change.</p>
      {maps.map((m) => (
        <div key={m.id} className="flex items-center gap-2 border-t border-line py-1.5 first:border-0">
          <Icon name="link" className="h-3.5 w-3.5 text-ocean" />
          <span className="text-soft">{local.find((x) => x.link_type_id === m.local_link_type_id)?.display_name ?? m.local_link_type_id}</span>
          <Icon name="right" className="h-3 w-3 text-muted" />
          <span className="text-soft">{remote.find((x) => x.link_type_id === m.remote_link_type_id)?.display_name ?? m.remote_link_type_id}</span>
          <span className="text-muted">
            {[m.export && "export", m.import && "import"].filter(Boolean).join(" + ") || "off"} · {m.received?.length ?? 0} links received
          </span>
        </div>
      ))}
      <div className="mt-2 grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-muted">Offered on this side</div>
          {local.map((l) => (
            <div key={l.link_type_id} className="py-0.5 text-soft">
              {l.display_name} <span className="text-muted">({typeName(l.source_type_id)} → {typeName(l.target_type_id)})</span>
            </div>
          ))}
          {offerable.length > 0 && (
            <select
              defaultValue=""
              onChange={(e) => e.target.value && act(() => peering.addLinkTypes(c.id, [e.target.value]), "Link type offered.")}
              className="mt-1 rounded border border-line-2 bg-ink px-1 py-0.5 text-soft outline-none"
            >
              <option value="">+ Offer a link type…</option>
              {offerable.map((l) => (
                <option key={l.link_type_id} value={l.link_type_id}>
                  {l.display_name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <div className="mb-1 text-muted">Offered by the remote</div>
          {remote
            .filter((r) => !maps.some((m) => m.remote_link_type_id === r.link_type_id))
            .map((r) => (
              <div key={r.link_type_id} className="flex items-center gap-2 py-0.5">
                <span className="text-soft">{r.display_name}</span>
                <select
                  defaultValue=""
                  onChange={(e) =>
                    e.target.value &&
                    act(() => peering.createLinkMapping(c.id, { local_link_type_id: e.target.value, remote_link_type_id: r.link_type_id, export: true, import_links: true }), "Link type mapped.")
                  }
                  className="ml-auto rounded border border-line-2 bg-ink px-1 py-0.5 text-soft outline-none"
                >
                  <option value="">+ map to…</option>
                  {local.map((l) => (
                    <option key={l.link_type_id} value={l.link_type_id}>
                      {l.display_name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          {!remote.length && <p className="text-muted">The remote side has offered no link types.</p>}
        </div>
      </div>
    </div>
  );
}

/** Each local marking → one of the remote enrollment's markings (their ids differ between enrollments). */
function MarkingMapCard({ c, markings, act }: { c: PeerConnection; markings: Marking[]; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [remote, setRemote] = useState<{ id: string; name: string }[] | null>(null);
  const [map, setMap] = useState<Record<string, string>>(() => Object.fromEntries((c.marking_map ?? []).map((m) => [m.local, m.remote])));
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="mb-1 font-semibold text-soft">Marking mapping</div>
      <p className="mb-2 text-muted">
        Enrollments have their own markings. Map each local marking to the remote&apos;s: security change requests reach the remote in its markings and marking properties are
        translated on export. With a mapping, an unmapped marking stops the export.
      </p>
      {(c.marking_map ?? []).map((m) => (
        <div key={m.local} className="py-0.5 text-soft">
          {m.local_name} <Icon name="right" className="inline h-3 w-3 text-muted" /> {m.remote_name}
        </div>
      ))}
      {!remote ? (
        <button type="button" onClick={() => peering.remoteMarkings(c.id).then(setRemote, (e: Error) => setErr(e.message))} className={`${buttonClass.secondary} mt-2`}>
          Edit mapping (load the remote&apos;s markings)
        </button>
      ) : (
        <div className="mt-2 space-y-1">
          {markings.map((m) => (
            <div key={m.id} className="flex items-center gap-2">
              <span className="w-40 truncate text-soft">{m.name}</span>
              <Icon name="right" className="h-3 w-3 text-muted" />
              <select value={map[m.id] ?? ""} onChange={(e) => setMap({ ...map, [m.id]: e.target.value })} className="rounded border border-line-2 bg-ink px-1 py-0.5 text-soft outline-none">
                <option value="">(not mapped)</option>
                {remote.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <button
            type="button"
            onClick={() => act(() => peering.setMarkingMap(c.id, Object.fromEntries(Object.entries(map).filter(([, v]) => v))), "Marking mapping saved.").then(() => setRemote(null))}
            className={`${buttonClass.secondary} mt-1`}
          >
            Save mapping
          </button>
        </div>
      )}
      {err && <p className="mt-1 text-bad">{err}</p>}
    </div>
  );
}

function MappingDialog({ c, local, remote, act, onClose }: { c: PeerConnection; local: OntologyEntity; remote: OntologyEntity; act: (fn: () => Promise<unknown>, done?: string) => Promise<void>; onClose: () => void }) {
  const [props, setProps] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = { [local.primary_key]: remote.primary_key };
    for (const p of local.properties) {
      const same = remote.properties.find((r) => r.api_name === p.api_name && r.type === p.type);
      if (same && !out[p.api_name]) out[p.api_name] = same.api_name;
    }
    return out;
  });
  const [dir, setDir] = useState({ source_export: false, source_import: false, actions_export: true, actions_import: true });
  return (
    <Modal title="Create ontology mapping" icon="cube" onClose={onClose} wide>
      <div className="max-h-[70vh] space-y-4 overflow-y-auto p-5 text-xs">
        <p className="text-muted">
          {local.display_name} (local) ↔ {remote.display_name} (remote). Map the properties to peer; both sides of a pair must have the same type. The primary keys must be mapped.
        </p>
        <table className="w-full">
          <tbody>
            {local.properties.map((p) => (
              <tr key={p.api_name} className="border-b border-line">
                <td className="py-1.5 text-soft">
                  {p.display_name} <span className="text-muted">({p.type})</span>
                </td>
                <td className="py-1.5">
                  <select value={props[p.api_name] ?? ""} onChange={(e) => setProps({ ...props, [p.api_name]: e.target.value })} className={`${inputClass} text-xs`}>
                    <option value="">not peered</option>
                    {remote.properties
                      .filter((r) => r.type === p.type)
                      .map((r) => (
                        <option key={r.api_name} value={r.api_name}>
                          {r.display_name}
                        </option>
                      ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              ["actions_export", "Actions: export"],
              ["actions_import", "Actions: import"],
              ["source_export", "Source data: export"],
              ["source_import", "Source data: import"],
            ] as const
          ).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2 text-soft">
              <input type="checkbox" checked={dir[k]} onChange={(e) => setDir({ ...dir, [k]: e.target.checked })} /> {l}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              act(
                () => peering.createMapping(c.id, { local_type_id: local.object_type_id!, remote_type_id: remote.id!, properties: Object.fromEntries(Object.entries(props).filter(([, v]) => v)), ...dir }),
                "Mapping created: objects start peering.",
              ).then(onClose)
            }
            className={buttonClass.primary}
          >
            Submit
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SettingsTab({ c, markings, act }: { c: PeerConnection; markings: Marking[]; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [sec, setSec] = useState<string[]>(c.security);
  const pendingLocal = c.security_requests.filter((r) => r.from === "local" && r.state === "pending");
  return (
    <div className="max-w-2xl space-y-4 p-6 text-xs">
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="mb-2 font-semibold text-soft">Status</div>
        <p className="text-muted">
          This side: {c.local_enabled ? "enabled" : "disabled"} · remote side: {c.remote_enabled ? "enabled" : "disabled"}. Data stops peering when either side disables the connection.
        </p>
        <button type="button" onClick={() => act(() => peering.setStatus(c.id, !c.local_enabled), c.local_enabled ? "Disabled." : "Enabled.")} className={`${buttonClass.secondary} mt-2`}>
          {c.local_enabled ? "Disable" : "Enable"}
        </button>
      </div>
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="mb-2 font-semibold text-soft">Security</div>
        <p className="mb-2 text-muted">Markings allowed to peer: an object type peers only when every marking on it is in this list. Changes need the remote&apos;s approval.</p>
        <MarkingPicker markings={markings} value={sec} onChange={setSec} />
        {pendingLocal.length > 0 && <p className="mt-2 text-warn">A change request is waiting for the remote&apos;s approval.</p>}
        <button type="button" onClick={() => act(() => peering.requestSecurity(c.id, sec), "Change request sent to the remote enrollment.")} className={`${buttonClass.secondary} mt-2`}>
          Request security change
        </button>
      </div>
      <MarkingMapCard c={c} markings={markings} act={act} />
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="mb-2 font-semibold text-soft">Data types</div>
        <p className="text-muted">
          Objects: {c.data_types.objects.export ? "export" : "no export"} · {c.data_types.objects.import ? "import" : "no import"}. Files: not available (no Gotham).
        </p>
      </div>
      <button
        type="button"
        onClick={async () => (await confirmDialog("Delete this peer connection? The remote side is disabled too.")) && act(() => peering.deleteConnection(c.id), "Deleted.")}
        className="text-bad hover:underline"
      >
        Delete connection
      </button>
    </div>
  );
}

function RequestDialog({ nets, projects, markings, onClose, onDone }: { nets: Network[]; projects: DriveItem[]; markings: Marking[]; onClose: () => void; onDone: () => void }) {
  const [network, setNetwork] = useState(nets[0]?.id ?? "");
  const [project, setProject] = useState(projects[0]?.id ?? "");
  const [exp, setExp] = useState(true);
  const [imp, setImp] = useState(true);
  const [sec, setSec] = useState<string[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="Create a peering request" icon="link" onClose={onClose}>
      <div className="space-y-3 p-5 text-xs">
        {!nets.length && <p className="text-warn">Establish a network connection or a data relay connection first (Network connections tab).</p>}
        <label className="block text-muted">
          Network connection
          <select value={network} onChange={(e) => setNetwork(e.target.value)} className={`${inputClass} mt-1`}>
            {nets.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} ({n.remote_title || n.remote_rid}){n.relay_only ? " · data relay" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-muted">
          Select a space to peer (Project)
          <select value={project} onChange={(e) => setProject(e.target.value)} className={`${inputClass} mt-1`}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-4 text-soft">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={exp} onChange={(e) => setExp(e.target.checked)} /> Export objects
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={imp} onChange={(e) => setImp(e.target.checked)} /> Import objects
          </label>
        </div>
        <div>
          <div className="mb-1 text-muted">Security (markings allowed to peer)</div>
          <MarkingPicker markings={markings} value={sec} onChange={setSec} />
        </div>
        {err && <p className="text-bad">{err}</p>}
        {code ? (
          <div className="space-y-1">
            <div className="text-muted">Share this invite code with the remote administrator:</div>
            <textarea readOnly value={code} rows={4} className={`${inputClass} font-mono text-[10px]`} />
            <button type="button" onClick={() => navigator.clipboard?.writeText(code)} className={buttonClass.secondary}>
              <Icon name="copy" className="h-3.5 w-3.5" /> Copy invite code
            </button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={buttonClass.secondary}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!network || !project}
              onClick={async () => {
                try {
                  const r = await peering.request({ network_id: network, project_id: project, export_objects: exp, import_objects: imp, security: sec });
                  setCode(r.code);
                  onDone();
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
              className={buttonClass.primary}
            >
              Create invite code
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function EnterDialog({ projects, markings, onClose, onDone }: { projects: DriveItem[]; markings: Marking[]; onClose: () => void; onDone: (c: PeerConnection) => void }) {
  const [code, setCode] = useState("");
  const [info, setInfo] = useState<Awaited<ReturnType<typeof peering.inspect>> | null>(null);
  const [project, setProject] = useState(projects[0]?.id ?? "");
  const [sec, setSec] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="Importing peer request" icon="link" onClose={onClose}>
      <div className="space-y-3 p-5 text-xs">
        <textarea
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setInfo(null);
            setErr(null);
            if (e.target.value.trim().length > 20)
              peering.inspect(e.target.value).then(
                (i) => (setInfo(i), setSec(i.security)),
                (ex: Error) => setErr(ex.message),
              );
          }}
          rows={4}
          placeholder="Paste the invite code"
          className={`${inputClass} font-mono text-[10px]`}
        />
        {info && (
          <div className="space-y-2 rounded-md border border-line-2 p-3">
            <div className="font-semibold text-soft">Connection details</div>
            <p className="text-muted">
              From <span className="text-soft">{info.from}</span> (Project {info.remote_project}) · this side would {info.objects.export ? "export" : ""}
              {info.objects.export && info.objects.import ? " and " : ""}
              {info.objects.import ? "import" : ""} objects
            </p>
            {!info.network && <p className="text-warn">No network connection to that enrollment yet: establish one first.</p>}
            <label className="block text-muted">
              Select a space to peer (Project)
              <select value={project} onChange={(e) => setProject(e.target.value)} className={`${inputClass} mt-1`}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="text-muted">Set security</div>
            <MarkingPicker markings={markings} value={sec ?? []} onChange={setSec} />
          </div>
        )}
        {err && <p className="text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!info || !project}
            onClick={async () => {
              try {
                onDone(await peering.approve(code, project, sec ?? undefined));
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            Approve request
          </button>
        </div>
      </div>
    </Modal>
  );
}

function NetworkView({ nets, onChanged, onMsg }: { nets: Network[]; onChanged: () => void; onMsg: (m: string) => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);
  const [entry, setEntry] = useState({ code: "", name: "" });
  const [channels, setChannels] = useState<Channel[]>([]);
  const [chan, setChan] = useState({ name: "", description: "", remote_rid: "", secret: "", direction: "export" as "export" | "import", connection_type: "file", directory: "", integrations: ["peering"] });
  const [chanOpen, setChanOpen] = useState(false);
  const [openState, setOpenState] = useState<string | null>(null);
  useEffect(() => {
    peering.channels().then(setChannels, () => {});
  }, []);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) onMsg(done);
      onChanged();
      peering.channels().then(setChannels, () => {});
    } catch (e) {
      onMsg((e as Error).message);
    }
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-5 text-xs">
        <div className="rounded-xl border border-line bg-panel p-4">
          <div className="mb-1 flex items-center gap-2 font-semibold text-soft">
            Multipass exchanger (MPX) connections
            <span className="ml-auto flex gap-1">
              {(["bidirectional", "egress", "ingress"] as const).map((d) => (
                <button key={d} type="button" onClick={() => act(async () => setCode((await peering.invite(d)).code))} className={buttonClass.secondary}>
                  New MPX invite: {d === "bidirectional" ? "Bidirectional" : d === "egress" ? "Egress only" : "Ingress only"}
                </button>
              ))}
              <button type="button" onClick={() => setEntering(true)} className={buttonClass.primary}>
                Enter code
              </button>
            </span>
          </div>
          <p className="mb-2 text-muted">Both administrators create an invite code with matching directions and enter each other&apos;s code.</p>
          {code && (
            <div className="mb-3 space-y-1">
              <textarea readOnly value={code} rows={3} className={`${inputClass} font-mono text-[10px]`} />
              <button type="button" onClick={() => navigator.clipboard?.writeText(code)} className={buttonClass.secondary}>
                <Icon name="copy" className="h-3.5 w-3.5" /> Copy
              </button>
            </div>
          )}
          {entering && (
            <div className="mb-3 space-y-1 rounded-md border border-line-2 p-2">
              <input value={entry.name} onChange={(e) => setEntry({ ...entry, name: e.target.value })} placeholder="Connection name" className={`${inputClass} text-xs`} />
              <textarea value={entry.code} onChange={(e) => setEntry({ ...entry, code: e.target.value })} rows={3} placeholder="Paste the remote's MPX invite code" className={`${inputClass} font-mono text-[10px]`} />
              <button
                type="button"
                disabled={!entry.code || !entry.name}
                onClick={() =>
                  act(async () => {
                    const r = await peering.enterInvite(entry.code, entry.name);
                    onMsg(r.check.ok ? "Connected: the remote answered." : `Saved; the remote did not answer yet: ${r.check.error}`);
                    setEntering(false);
                    setEntry({ code: "", name: "" });
                  })
                }
                className={buttonClass.primary}
              >
                Create connection
              </button>
            </div>
          )}
          <table className="w-full">
            <tbody>
              {nets.map((n) => (
                <tr key={n.id} className="border-t border-line">
                  <td className="py-2 text-soft">{n.name}</td>
                  <td className="py-2 text-muted">{n.remote_title || n.remote_rid}</td>
                  <td className="py-2 text-muted">
                    {n.relay_only ? (
                      "Data relay (File channels)"
                    ) : (
                      <>
                        {n.remote_url || "(the remote calls in)"}
                        {!n.can_initiate ? (n.relay?.export ? " · control messages through the relay" : " · the remote pulls") : n.pulls ? " · this side pulls" : ""}
                      </>
                    )}
                  </td>
                  <td className={`py-2 ${n.complete ? "text-ok" : "text-warn"}`}>
                    {n.complete
                      ? "Established"
                      : n.relay_only
                        ? `Needs ${!n.relay?.export && !n.relay?.import ? "an export and an import" : n.relay?.export ? "an import" : "an export"} channel (Peering)`
                        : "Waiting for the other code"}
                  </td>
                  <td className="py-2 text-muted">{n.last_error ? <span className="text-bad">{n.last_error}</span> : n.last_ok_at ? `reached ${when(n.last_ok_at)}` : ""}</td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() =>
                        act(async () => {
                          const r = await peering.checkNetwork(n.id);
                          onMsg(r.ok ? (r.relay ? "Reachable: the remote's hello came through the relay." : "Reachable.") : `Not reachable${r.error ? `: ${r.error}` : "."}`);
                        })
                      }
                      className="text-ocean hover:underline"
                    >
                      Check
                    </button>
                    <button type="button" onClick={async () => (await confirmDialog(`Delete ${n.name}?`)) && act(() => peering.deleteNetwork(n.id), "Deleted.")} className="ml-3 text-muted hover:text-bad">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rounded-xl border border-line bg-panel p-4">
          <div className="mb-1 flex items-center font-semibold text-soft">
            Send data across a CDS (data relay)
            {channels.length > 0 && (
              <button
                type="button"
                onClick={() => act(async () => {
                  const r = await peering.runChannels();
                  onMsg(`${r.written} file(s) written, ${r.imported} imported${r.resent ? `, ${r.resent} unacknowledged file(s) written again` : ""}.`);
                })}
                className={`${buttonClass.secondary} ml-auto`}
              >
                Run channels now
              </button>
            )}
            <button type="button" onClick={() => setChanOpen(!chanOpen)} className={`${buttonClass.secondary} ${channels.length ? "" : "ml-auto"}`}>
              New CDS channel
            </button>
          </div>
          <p className="mb-2 text-muted">
            File channels exchange signed payload files through a directory both enrollments (or your CDS) reach. Without an MPX connection, an export and an import channel with the Peering
            integration on each side are a data relay connection: the peer request, approval, activation, ontology mappings and status travel through the channels too (each side runs its
            channels every minute, or Run channels now). Files are numbered and applied in sequence; each side acknowledges what it applied through its own export channel (or, without
            one, over the network connection), and a file that is lost or reported missing is written again. A channel with no way back for acknowledgements is flagged: its files
            count as delivered once written. Acknowledgements are listed as Ack jobs on the connection; select a channel&apos;s sequence state for details. Exchange enrollment RIDs with the remote administrator (Enrollment tab). S3 and Lattice transports are not available here.
          </p>
          {chanOpen && (
            <div className="mb-3 grid gap-2 rounded-md border border-line-2 p-3 sm:grid-cols-2">
              <input value={chan.name} onChange={(e) => setChan({ ...chan, name: e.target.value })} placeholder="Channel name" className={`${inputClass} text-xs`} />
              <input value={chan.remote_rid} onChange={(e) => setChan({ ...chan, remote_rid: e.target.value })} placeholder="Remote enrollment RID" className={`${inputClass} text-xs`} />
              <select value={chan.direction} onChange={(e) => setChan({ ...chan, direction: e.target.value as "export" | "import" })} className={`${inputClass} text-xs`}>
                <option value="export">Export</option>
                <option value="import">Import</option>
              </select>
              <input value={chan.directory} onChange={(e) => setChan({ ...chan, directory: e.target.value })} placeholder="Directory (absolute path)" className={`${inputClass} text-xs`} />
              <input value={chan.secret} onChange={(e) => setChan({ ...chan, secret: e.target.value })} placeholder="Channel secret (optional, same on both sides)" className={`${inputClass} text-xs`} />
              <input value={chan.description} onChange={(e) => setChan({ ...chan, description: e.target.value })} placeholder="Description" className={`${inputClass} text-xs`} />
              <button
                type="button"
                onClick={() =>
                  act(async () => {
                    const r = await peering.createChannel(chan);
                    onMsg(r.warning ? `Channel created. Warning: ${r.warning}` : "Channel created.");
                  }).then(() => setChanOpen(false))
                }
                className={buttonClass.primary}
              >
                Save changes
              </button>
            </div>
          )}
          {channels.map((ch) => (
            <div key={ch.id} className="border-t border-line py-2" data-channel={ch.id}>
              <div className="flex items-center gap-3">
                <span className="text-soft">{ch.name}</span>
                <span className="text-muted">
                  {ch.direction} · {ch.connection_type} · {ch.directory} · {ch.integrations.join(", ")}
                  {ch.has_secret ? " · signed" : ""}
                </span>
                {ch.relay_state && (
                  <button
                    type="button"
                    data-channel-state={ch.id}
                    aria-expanded={openState === ch.id}
                    title="Sequence state: details"
                    onClick={() => {
                      setOpenState(openState === ch.id ? null : ch.id);
                      peering.channels().then(setChannels, () => {});
                    }}
                    className={`text-left hover:underline ${ch.relay_state.ack_warning ? "text-warn" : "text-muted"}`}
                  >
                    {relayStateText(ch)}
                    {ch.relay_state.ack_warning ? " · no acknowledgements" : ""}
                  </button>
                )}
                {ch.last_error ? <span className="truncate text-bad">{ch.last_error}</span> : ch.last_ok_at ? <span className="text-muted">ran {when(ch.last_ok_at)}</span> : null}
                <button type="button" onClick={() => act(() => peering.deleteChannel(ch.id), "Deleted.")} className="ml-auto text-muted hover:text-bad">
                  Delete
                </button>
              </div>
              {openState === ch.id && ch.relay_state && <RelayStateDetail ch={ch} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Sequence numbers as ranges: #1–#4, #7. */
function seqRanges(seqs: number[]): string {
  const out: [number, number][] = [];
  for (const s of [...new Set(seqs)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && s === last[1] + 1) last[1] = s;
    else out.push([s, s]);
  }
  return out.map(([a, b]) => (a === b ? `#${a}` : `#${a}–#${b}`)).join(", ");
}

/** A channel's sequence state in full (opened from its row). */
function RelayStateDetail({ ch }: { ch: Channel }) {
  const s = ch.relay_state!;
  const path = s.ack_path === "relay" ? "through the relay channel back" : s.ack_path === "network" ? "over the network connection" : null;
  const rows: [string, string][] =
    ch.direction === "export"
      ? [
          ["Last sequence written", s.sent_seq ? `#${s.sent_seq}` : "none yet"],
          ["Acknowledged by the remote", s.acked_seq == null ? "nothing yet" : `up to #${s.acked_seq}${s.acked_at ? `, ${when(s.acked_at)}` : ""}${s.acked_via ? ` (via ${s.acked_via === "relay" ? "relay channel" : "network connection"})` : ""}`],
          ["Awaiting acknowledgement", s.sent_seq && s.unacked ? `${s.unacked} file(s)${s.acked_seq != null && s.sent_seq > s.acked_seq ? `: ${seqRanges(Array.from({ length: s.sent_seq - s.acked_seq }, (_, i) => s.acked_seq! + 1 + i))}` : ""}` : "none"],
          ["Reported missing by the remote", s.missing?.length ? seqRanges(s.missing) : "none"],
          ["Acknowledgements come back", path ?? "no way back"],
        ]
      : [
          ["Applied up to", `#${s.applied_seq ?? 0}`],
          ["Waiting for", s.waiting_for != null ? `#${s.waiting_for} (${s.held ?? 0} later file(s) held)` : "nothing"],
          ["Duplicates dropped", String(s.duplicates ?? 0)],
          ["Last acknowledgement sent", s.last_ack_seq != null ? `up to #${s.last_ack_seq}${s.last_ack_at ? `, ${when(s.last_ack_at)}` : ""}` : "none yet"],
          ["Acknowledgements go back", path ?? "no way back"],
        ];
  return (
    <div className="mt-2 rounded-md border border-line-2 bg-ink/40 p-2" data-channel-detail={ch.id}>
      <table className="w-full">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="w-56 py-0.5 text-muted">{k}</td>
              <td className="py-0.5 text-soft">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.ack_warning && <p className="mt-1 text-warn">{s.ack_warning}</p>}
    </div>
  );
}

/** A relay channel's sequence state: export — written / acknowledged by the remote; import — applied, waiting for a missing file, duplicates dropped. */
function relayStateText(ch: Channel): string {
  const s = ch.relay_state;
  if (!s) return "";
  if (ch.direction === "export") {
    if (!s.sent_seq) return "nothing sent yet";
    const acked = s.acked_seq == null ? "no acknowledgement yet" : `acknowledged #${s.acked_seq}`;
    const missing = s.missing?.length ? ` · remote missing #${s.missing.join(", #")}` : "";
    return `sent #${s.sent_seq} · ${acked}${s.unacked ? ` (${s.unacked} awaiting)` : ""}${missing}`;
  }
  const waiting = s.waiting_for != null ? ` · waiting for #${s.waiting_for} (${s.held ?? 0} file(s) held)` : "";
  return `applied #${s.applied_seq ?? 0}${waiting}${s.duplicates ? ` · ${s.duplicates} duplicate(s) dropped` : ""}`;
}

function EnrollmentView({ me, onChanged, onMsg }: { me: Enrollment; onChanged: (e: Enrollment) => void; onMsg: (m: string) => void }) {
  const [title, setTitle] = useState(me.title);
  const [url, setUrl] = useState(me.api_url);
  return (
    <div className="max-w-2xl space-y-3 p-6 text-xs">
      <p className="text-muted">Remote peers identify this enrollment by its platform title. Invite codes carry the API address remote enrollments call.</p>
      <label className="block text-muted">
        Platform title
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} mt-1`} />
      </label>
      <label className="block text-muted">
        API address remote enrollments reach
        <input value={url} onChange={(e) => setUrl(e.target.value)} className={`${inputClass} mt-1 font-mono`} />
      </label>
      <p className="text-muted">
        Enrollment RID: <span className="font-mono text-soft">{me.rid}</span>
      </p>
      <button
        type="button"
        onClick={() =>
          peering.setEnrollment(title, url).then(
            (e) => (onChanged(e), onMsg("Saved.")),
            (e: Error) => onMsg(e.message),
          )
        }
        className={buttonClass.primary}
      >
        Save
      </button>
    </div>
  );
}

function Profiles({ projects, markings, nets, onMsg, onChanged }: { projects: DriveItem[]; markings: Marking[]; nets: Network[]; onMsg: (m: string) => void; onChanged: () => void }) {
  const [list, setList] = useState<Profile[]>([]);
  const [creating, setCreating] = useState(false);
  const [perspective, setPerspective] = useState<"hub" | "spoke">("hub");
  const [form, setForm] = useState({ hub_name: "", spoke_name: "", project_id: projects[0]?.id ?? "", auto_create: true, security: [] as string[], objects_direction: "export" });
  const [install, setInstall] = useState<{ id: string; project_id: string; remote_strategy: "all" | "specific"; remote_rid: string } | null>(null);
  const load = () => peering.profiles().then(setList, () => {});
  useEffect(() => {
    peering.profiles().then(setList, () => {});
  }, []);
  const flip: Record<string, string> = { export: "import", import: "export", both: "both" };
  const shownDir = perspective === "hub" ? form.objects_direction : flip[form.objects_direction];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-8">
      <div className="mx-auto max-w-5xl space-y-5 text-xs">
        <div className="flex items-end">
          <div>
            <h1 className="text-xl font-semibold">Peer profiles</h1>
            <p className="mt-1 text-sm text-muted">Reusable data sharing configurations: a hub profile and its mirrored spoke profile, installed on each enrollment.</p>
          </div>
          <button type="button" onClick={() => setCreating(!creating)} className={`${buttonClass.primary} ml-auto`}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Create peer profile pair
          </button>
        </div>
        {creating && (
          <div className="space-y-3 rounded-xl border border-line bg-panel p-4">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-soft">Editing the {perspective} perspective</span>
              <button type="button" onClick={() => setPerspective(perspective === "hub" ? "spoke" : "hub")} className="text-ocean hover:underline">
                Swap perspective
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <input value={form.hub_name} onChange={(e) => setForm({ ...form, hub_name: e.target.value })} placeholder="Hub profile name" className={`${inputClass} text-xs`} />
              <input value={form.spoke_name} onChange={(e) => setForm({ ...form, spoke_name: e.target.value })} placeholder="Spoke profile name" className={`${inputClass} text-xs`} />
              <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })} className={`${inputClass} text-xs`}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    Location: {p.name}
                  </option>
                ))}
              </select>
              <select
                value={shownDir}
                onChange={(e) => setForm({ ...form, objects_direction: perspective === "hub" ? e.target.value : flip[e.target.value] })}
                className={`${inputClass} text-xs`}
              >
                <option value="export">Nexus: export</option>
                <option value="import">Nexus: import</option>
                <option value="both">Nexus: export and import</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-soft">
              <input type="checkbox" checked={form.auto_create} onChange={(e) => setForm({ ...form, auto_create: e.target.checked })} /> Create peer connections automatically
            </label>
            <div>
              <div className="mb-1 text-muted">Peer connection security</div>
              <MarkingPicker markings={markings} value={form.security} onChange={(v) => setForm({ ...form, security: v })} />
            </div>
            <button
              type="button"
              disabled={!form.hub_name || !form.spoke_name || !form.project_id}
              onClick={() =>
                peering.createProfiles({ ...form, object_types: [] }).then(
                  () => (setCreating(false), load(), onMsg("Created two draft profiles: install the hub here and the spoke on the remote enrollments.")),
                  (e: Error) => onMsg(e.message),
                )
              }
              className={buttonClass.primary}
            >
              Create peer profile
            </button>
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((p) => (
            <div key={p.id} className="rounded-xl border border-line bg-panel p-4">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-soft">{p.name}</span>
                <span className="rounded bg-panel-2 px-1.5 text-[10px] uppercase text-muted">{p.side}</span>
                <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] ${p.state === "installed" ? "bg-ok/15 text-ok" : "bg-panel-2 text-muted"}`}>{p.state}</span>
              </div>
              <p className="mt-1 text-muted">
                Objects {p.objects_direction} · security {p.security.length ? p.security.length + " marking(s)" : "unmarked only"} · {p.auto_create ? "creates connections" : "configures existing connections"}
              </p>
              {p.installed && (
                <ul className="mt-2 space-y-0.5">
                  {p.installed.results.map((r, i) => (
                    <li key={i} className={r.status === "failed" ? "text-bad" : "text-soft"}>
                      {r.network}: {r.status}
                      {r.error ? ` (${r.error})` : ""}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex gap-2">
                {p.state === "installed" ? (
                  <button type="button" onClick={() => peering.uninstall(p.id).then(load, (e: Error) => onMsg(e.message))} className={buttonClass.secondary}>
                    Uninstall
                  </button>
                ) : (
                  <button type="button" onClick={() => setInstall({ id: p.id, project_id: p.project_id, remote_strategy: "all", remote_rid: "" })} className={buttonClass.secondary}>
                    Install here
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        {install && (
          <Modal title="Install peer profile" icon="link" onClose={() => setInstall(null)}>
            <div className="space-y-3 p-5 text-xs">
              <select value={install.project_id} onChange={(e) => setInstall({ ...install, project_id: e.target.value })} className={inputClass}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    Local space: {p.name}
                  </option>
                ))}
              </select>
              <select value={install.remote_strategy} onChange={(e) => setInstall({ ...install, remote_strategy: e.target.value as "all" | "specific" })} className={inputClass}>
                <option value="all">Remote strategy: All</option>
                <option value="specific">Remote strategy: Specific enrollment</option>
              </select>
              {install.remote_strategy === "specific" && (
                <select value={install.remote_rid} onChange={(e) => setInstall({ ...install, remote_rid: e.target.value })} className={inputClass}>
                  <option value="">Choose an enrollment…</option>
                  {nets.map((n) => (
                    <option key={n.id} value={n.remote_rid}>
                      {n.remote_title || n.name}
                    </option>
                  ))}
                </select>
              )}
              <p className="text-muted">Mesh strategies need a mesh of environments, which does not exist here.</p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setInstall(null)} className={buttonClass.secondary}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() =>
                    peering.install(install.id, { project_id: install.project_id, remote_strategy: install.remote_strategy, remote_rid: install.remote_rid || undefined }).then(
                      () => (setInstall(null), load(), onChanged(), onMsg("Installed.")),
                      (e: Error) => onMsg(e.message),
                    )
                  }
                  className={buttonClass.primary}
                >
                  Install
                </button>
              </div>
            </div>
          </Modal>
        )}
      </div>
    </div>
  );
}
