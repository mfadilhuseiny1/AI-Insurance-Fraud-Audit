"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { AppHeader, Card } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { datasetPreview } from "@/lib/datasetPreview";
import { auth, type User } from "@/lib/auth";
import { renderMarkdown } from "@/lib/markdown";
import { compass, fmtTime, type CompassProject } from "@/lib/securityGov";

type Tab = "cover" | "overview" | "autosaved" | "activity" | "access";

/** A Project's dashboard (Compass): cover page, overview, activity of the last month and the access graph. */
export default function CompassProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [p, setP] = useState<CompassProject | null>(null);
  const [tab, setTab] = useState<Tab>("cover");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => compass.project(id).then(setP, (e: Error) => setError(e.message)), [id]);
  useEffect(() => {
    void load();
    void compass.view(id).catch(() => {});
  }, [load, id]);
  if (error) return <ApiError message={error} />;
  if (!p) return <Loading />;
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Compass" icon="folder" href="/compass" crumbs={[{ label: p.name }]}>
        <Link href={`/files/${id}`} className={buttonClass.secondary}><Icon name="folder" className="h-4 w-4" />Files</Link>
      </AppHeader>
      <div className="flex shrink-0 gap-1 border-b border-line bg-panel px-4">
        {([["cover", "Cover page"], ["overview", "Overview"], ["autosaved", "Autosaved"], ["activity", "Activity"], ["access", "Access graph"]] as const).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`border-b-2 px-3 py-2.5 text-sm ${tab === k ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>{l}</button>
        ))}
      </div>
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
        <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
          {tab === "cover" && <Cover p={p} onSaved={setP} />}
          {tab === "overview" && <Overview p={p} onSaved={setP} />}
          {tab === "autosaved" && <Autosaved id={id} />}
          {tab === "activity" && <Activity id={id} />}
          {tab === "access" && <AccessGraph id={id} />}
        </div>
      </main>
    </div>
  );
}

function Cover({ p, onSaved }: { p: CompassProject; onSaved: (p: CompassProject) => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (edit !== null)
    return (
      <Card title="Cover page">
        <div className="space-y-2 p-4">
          <textarea className={`${inputClass} min-h-72 font-mono text-xs`} value={edit} onChange={(e) => setEdit(e.target.value)} />
          {error && <p className="text-sm text-bad">{error}</p>}
          <div className="flex gap-2">
            <button type="button" className={buttonClass.primary} onClick={() => compass.updateProject(p.id, { cover: edit }).then((x) => { onSaved(x); setEdit(null); }, (e: Error) => setError(e.message))}>Save</button>
            <button type="button" className={buttonClass.ghost} onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      </Card>
    );
  return (
    <Card title="Cover page" action={p.can_edit ? <button type="button" className={`${buttonClass.ghost} text-xs`} onClick={() => setEdit(p.cover || `# ${p.name}\n\nWhat this Project is for, who to ask, and where to start.`)}><Icon name="edit" className="h-3.5 w-3.5" />Edit</button> : undefined}>
      <div className="p-5 text-sm">
        {p.cover ? <div className="text-soft [&_a]:text-ocean [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:font-semibold [&_ul]:ml-4 [&_ul]:list-disc" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.cover) }} />
          : <p className="text-muted">No cover page yet.{p.can_edit ? " Owners write one in Markdown." : ""}</p>}
      </div>
    </Card>
  );
}

function Overview({ p, onSaved }: { p: CompassProject; onSaved: (p: CompassProject) => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [desc, setDesc] = useState(p.description);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // administrators list users; others pick from the names-only people directory
    auth.users().then(setUsers, () => datasetPreview.people().then((ps) => setUsers(ps.map((x) => ({ id: x.id, display_name: x.label, username: "" }) as User)), () => {}));
    auth.groups().then(setGroups, () => {});
  }, []);
  const poc = p.point_of_contact;
  const save = (body: { description?: string; point_of_contact?: string; discoverable?: boolean }) => compass.updateProject(p.id, body).then(onSaved, (e: Error) => setError(e.message));
  return (
    <Card title="Overview">
      <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-3 p-4 text-sm">
        <dt className="text-muted">Description</dt>
        <dd>{p.can_edit ? <div className="flex gap-2"><textarea className={`${inputClass} min-h-14`} value={desc} onChange={(e) => setDesc(e.target.value)} /><button type="button" className={buttonClass.secondary} disabled={desc === p.description} onClick={() => save({ description: desc })}>Save</button></div> : p.description || <span className="text-muted">—</span>}</dd>
        <dt className="text-muted">Point of contact</dt>
        <dd>{p.can_edit ? (
          <select className={fieldClass} value={p.point_of_contact?.id ?? ""} onChange={(e) => save({ point_of_contact: e.target.value })}>
            <option value="">—</option>{users.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.username}</option>)}
            {groups.length > 0 && <optgroup label="Groups">{groups.map((g) => <option key={g.id} value={`group:${g.id}`}>{g.name}</option>)}</optgroup>}
          </select>) : poc?.name ?? <span className="text-muted">—</span>}
          {poc?.contact && (
            <span className="ml-2 text-xs text-muted">
              {poc.contact.kind === "email" ? <a href={`mailto:${poc.contact.value}`} className="text-ocean hover:underline">{poc.contact.value}</a> : "through Issues"}
            </span>
          )}</dd>
        <dt className="text-muted">RID</dt><dd className="font-mono text-xs">{p.rid}</dd>
        <dt className="text-muted">Your role</dt><dd className="capitalize">{p.role ?? "—"}</dd>
        <dt className="text-muted">Discoverability</dt>
        <dd>{p.can_edit ? <label className="flex items-center gap-2"><input type="checkbox" checked={p.discoverable} onChange={(e) => save({ discoverable: e.target.checked })} />Discoverable by people in other organizations</label> : p.discoverable ? "Discoverable" : "Not discoverable"}</dd>
        <dt className="text-muted">Created</dt><dd>{fmtTime(p.created)}</dd>
        <dt className="text-muted">Last modified</dt><dd>{fmtTime(p.modified)}</dd>
        <dt className="text-muted">Views</dt><dd>{p.views}</dd>
        <dt className="text-muted">More</dt>
        <dd className="flex flex-wrap gap-3 text-xs">
          <Link href={`/files/${p.id}`} className="text-ocean hover:underline">Files, roles and markings</Link>
          <Link href={`/resource-management?project=${p.id}`} className="text-ocean hover:underline">Project usage and resource queues</Link>
          <Link href={`/security-auditing?resource=${p.id}`} className="text-ocean hover:underline">Audit log</Link>
        </dd>
      </dl>
      {error && <p className="px-4 pb-3 text-sm text-bad">{error}</p>}
    </Card>
  );
}

/** Files made from an existing resource of the Project (an analysis or preparation of its dataset), until saved. */
function Autosaved({ id }: { id: string }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof compass.autosaved>> | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => compass.autosaved(id).then(setRows, (e: Error) => setError(e.message)), [id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (error && !rows) return <ApiError message={error} />;
  if (!rows) return <Loading />;
  return (
    <Card title="Autosaved" count={rows.length}>
      <p className="px-4 pt-3 text-xs text-muted">Files made from this Project&apos;s resources start here, visible to everyone with access to the Project. Save one to move it into the Files section.</p>
      <ul className="divide-y divide-line text-sm">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-2 px-4 py-2">
            <span className="rounded bg-panel-2 px-1.5 text-[10px] text-muted">Autosaved</span>
            <Link href={`/files/${r.id}`} className="min-w-0 flex-1 truncate hover:text-ocean">{r.name}</Link>
            <span className="text-xs text-muted">{r.updated_at ? fmtTime(r.updated_at) : ""}</span>
            <button type="button" onClick={() => setSaving(r.id)} className={`${buttonClass.ghost} text-xs`}>Save to…</button>
          </li>
        ))}
        {!rows.length && <li className="px-4 py-3 text-xs text-muted">Nothing autosaved.</li>}
      </ul>
      {error && <p className="px-4 pb-3 text-xs text-bad">{error}</p>}
      {saving && (
        <DrivePicker
          title="Save to"
          onClose={() => setSaving(null)}
          folder={{ action: "Save here", onPick: (f) => compass.saveAutosaved(saving, f.id ?? "").then(() => (setSaving(null), load()), (e: Error) => (setSaving(null), setError(e.message))) }}
        />
      )}
    </Card>
  );
}

function Activity({ id }: { id: string }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof compass.activity>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    compass.activity(id).then(setRows, (e: Error) => setError(e.message));
  }, [id]);
  if (error) return <ApiError message={error} />;
  if (!rows) return <Loading />;
  return (
    <Card title="Activity (last month)" count={rows.length}>
      <ul className="divide-y divide-line text-xs">
        {rows.map((r, i) => (
          <li key={i} className="flex flex-wrap gap-2 px-4 py-2">
            <span className="text-muted">{fmtTime(r.time)}</span><span className="font-medium">{r.user ?? "service"}</span>
            <span className="font-mono text-ocean">{r.categories.join(", ")}</span>
            <span className="text-soft">{r.resources.map((x) => x.name).join(", ")}</span>
            {r.result !== "SUCCESS" && <span className="text-bad">{r.result}</span>}
          </li>
        ))}
        {!rows.length && <li className="px-4 py-3 text-muted">No activity in the last month.</li>}
      </ul>
    </Card>
  );
}

function AccessGraph({ id }: { id: string }) {
  const [g, setG] = useState<Awaited<ReturnType<typeof compass.accessGraph>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    compass.accessGraph(id).then(setG, (e: Error) => setError(e.message));
  }, [id]);
  if (error) return <ApiError message={error} />;
  if (!g) return <Loading />;
  const col = (kinds: string[]) => g.nodes.filter((n) => kinds.includes(n.kind));
  const cols = [col(["user"]), col(["group", "everyone"]), col(["project"]), col(["marking"])];
  const W = 860;
  const colX = [80, 300, 520, 740];
  const pos: Record<string, { x: number; y: number }> = {};
  cols.forEach((list, ci) => list.forEach((n, i) => (pos[n.id] = { x: colX[ci], y: 40 + i * 44 })));
  const H = Math.max(120, ...cols.map((l) => 40 + l.length * 44));
  const color: Record<string, string> = { user: "#60a5fa", group: "#a78bfa", everyone: "#a78bfa", project: "#f5c26b", marking: "#f87171" };
  return (
    <Card title="Access graph">
      <p className="px-4 pt-3 text-xs text-muted">{g.open_to_everyone ? "No roles are set: only administrators can open the Project. " : ""}Users and groups with a role on the Project (and the groups&apos; members), and the markings every user must hold.</p>
      <div className="overflow-x-auto p-4">
        <svg width={W} height={H} className="text-xs">
          {g.edges.map((e, i) => pos[e.from] && pos[e.to] && (
            <g key={i}>
              <line x1={pos[e.from].x + 60} y1={pos[e.from].y} x2={pos[e.to].x - 60} y2={pos[e.to].y} stroke="currentColor" className="text-line-2" />
              <text x={(pos[e.from].x + pos[e.to].x) / 2} y={(pos[e.from].y + pos[e.to].y) / 2 - 4} textAnchor="middle" className="fill-muted" fontSize="10">{e.label}</text>
            </g>
          ))}
          {g.nodes.map((n) => pos[n.id] && (
            <g key={n.id}>
              <rect x={pos[n.id].x - 60} y={pos[n.id].y - 14} width={120} height={28} rx={6} fill={color[n.kind]} fillOpacity={0.15} stroke={color[n.kind]} />
              <text x={pos[n.id].x} y={pos[n.id].y + 4} textAnchor="middle" fill="currentColor" fontSize="11">{n.name.length > 18 ? `${n.name.slice(0, 17)}…` : n.name}</text>
            </g>
          ))}
        </svg>
      </div>
    </Card>
  );
}
