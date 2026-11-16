"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { auth } from "@/lib/auth";
import { when } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import { STATUS_CLASS, uc, type App, type UseCase } from "@/lib/useCases";
import { workshop } from "@/lib/workshop";

type Section = "overview" | "applications" | "object_types" | "action_types" | "backing_data" | "other";
const SECTIONS: [Section, string, IconName][] = [
  ["overview", "Overview", "grid"],
  ["applications", "Applications", "device"],
  ["object_types", "Object types", "cube"],
  ["action_types", "Action types", "bolt"],
  ["backing_data", "Backing data", "database"],
  ["other", "Other resources", "folder"],
];

export default function UseCasePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [u, setU] = useState<UseCase | null>(null);
  const [section, setSection] = useState<Section>("overview");
  const [openType, setOpenType] = useState<string | null>(null);
  const [openApp, setOpenApp] = useState<App | null>(null);
  const [dialog, setDialog] = useState<null | "app" | "roles" | "add_type" | "add_action">(null);
  const [people, setPeople] = useState<{ principal: string; name: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    uc.get(id).then(setU, (e: Error) => setErr(e.message));
    Promise.all([auth.users().catch(() => []), auth.groups().catch(() => [])]).then(([us, gs]) =>
      setPeople([...us.map((x) => ({ principal: `user:${x.id}`, name: x.display_name || x.username })), ...gs.map((g) => ({ principal: `group:${g.id}`, name: `${g.name} (group)` }))]),
    );
  }, [id]);
  if (err && !u) return <p className="p-8 text-sm text-bad">{err}</p>;
  if (!u) return <p className="p-8 text-sm text-muted">Loading…</p>;
  const can = u.my_role !== null;
  const save = async (body: Parameters<typeof uc.update>[1]) => {
    try {
      setU(await uc.update(id, body));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="flex h-full flex-col">
      <AppHeader app="Use Cases" icon="layers" href="/use-cases" crumbs={[{ label: u.name }]}>
        {err && <span className="text-xs text-bad">{err}</span>}
        {u.my_role === "owner" && (
          <button type="button" onClick={() => setDialog("roles")} className={buttonClass.secondary}>
            Manage permissions
          </button>
        )}
      </AppHeader>
      <div className="flex min-h-0 flex-1">
        <nav className="w-56 shrink-0 space-y-0.5 border-r border-line bg-panel p-2 text-xs">
          {u.status_warning && (
            <div className="mb-2 rounded bg-warn/10 px-2 py-1 text-warn" title="Active use case with Experimental or Deprecated Nexus resources">
              <Icon name="alert" className="mr-1 inline h-3 w-3" /> Status disparity
            </div>
          )}
          {SECTIONS.map(([s, t, icon]) => (
            <button key={s} type="button" onClick={() => (setSection(s), setOpenType(null), setOpenApp(null))} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${section === s ? "bg-ocean/15 text-white" : "text-muted hover:text-white"}`} data-section={s}>
              <Icon name={icon} className="h-3.5 w-3.5" /> {t}
              <span className="ml-auto text-[10px]">{s === "applications" ? u.applications.length : s === "object_types" ? u.object_types.length : s === "action_types" ? u.action_types.length : s === "backing_data" ? u.backing_data.length : s === "other" ? u.other_resources.length : ""}</span>
            </button>
          ))}
          <div className="border-t border-line pt-2">
            <Link href={`/files/${u.project_id}`} className="block px-2 py-1 text-ocean hover:underline">
              Switch to Project view
            </Link>
          </div>
        </nav>
        <main className="min-w-0 flex-1 overflow-auto p-6 text-sm" data-use-case>
          {!u.can_view_project && <p className="mb-3 rounded bg-warn/10 px-3 py-2 text-xs text-warn">You can see this use case&apos;s metadata but not its Project ({u.project ?? u.project_id}).</p>}
          {section === "overview" && <Overview u={u} can={can} people={people} save={save} onSection={setSection} onNewApp={() => setDialog("app")} />}
          {section === "applications" &&
            (openApp ? (
              <AppPage u={u} app={openApp} can={can} save={save} onBack={() => setOpenApp(null)} onType={(t) => (setSection("object_types"), setOpenType(t))} />
            ) : (
              <Table
                title="Applications"
                action={can ? <button type="button" onClick={() => setDialog("app")} className={buttonClass.primary}>Create new application</button> : null}
                head={["Name", "Type", "Nexus resources", "Updated", ""]}
                rows={u.applications.map((a) => [
                  <button key="n" type="button" onClick={() => setOpenApp(a)} className="text-left text-ocean hover:underline">{a.name}</button>,
                  a.type_label,
                  String(a.refs.length),
                  when(a.updated_at),
                  <Link key="e" href={a.href} target="_blank" className="text-ocean">Edit application</Link>,
                ])}
              />
            ))}
          {section === "object_types" &&
            (openType ? (
              <ObjectTypePage uid={id} tid={openType} onBack={() => setOpenType(null)} />
            ) : (
              <Table
                title="Object types"
                action={can ? <button type="button" onClick={() => setDialog("add_type")} className={buttonClass.secondary}>Add object type</button> : null}
                head={["Name", "Status", "Datasource", "Used by", ""]}
                rows={u.object_types.map((o) => [
                  <span key="n" className="flex items-center gap-1">
                    <button type="button" onClick={() => setOpenType(o.id)} className="text-left text-ocean hover:underline">{o.name}</button>
                    {o.local && <span className="rounded bg-ocean/15 px-1 text-[10px] text-ocean">Local</span>}
                    {o.used_elsewhere.length > 0 && <span title={`Also used by ${o.used_elsewhere.join(", ")}: move its backing dataset to a shared Nexus Project`} className="text-warn">⚠</span>}
                  </span>,
                  o.status && o.status !== "active" ? <span key="s" className={`rounded px-1.5 text-[10px] capitalize ${STATUS_CLASS[o.status] ?? ""}`}>{o.status}</span> : "",
                  o.backing_dataset ?? "—",
                  o.manual ? "added by hand" : o.used_by.join(", "),
                  <span key="a" className="flex gap-2">
                    <Link href={`/ontology/${o.id}`} target="_blank" className="text-ocean">Nexus Manager</Link>
                    {o.manual && can && <button type="button" onClick={async () => setU(await uc.ontology(id, "object_type", o.id, false))} className="text-muted hover:text-bad">Remove</button>}
                  </span>,
                ])}
              />
            ))}
          {section === "action_types" && (
            <Table
              title="Action types"
              action={can ? <button type="button" onClick={() => setDialog("add_action")} className={buttonClass.secondary}>Add action type</button> : null}
              head={["Name", "Status", "Object type", "Used by", ""]}
              rows={u.action_types.map((a) => [
                a.name,
                a.status && a.status !== "active" ? <span key="s" className={`rounded px-1.5 text-[10px] capitalize ${STATUS_CLASS[a.status] ?? ""}`}>{a.status}</span> : "",
                a.object_type ?? "—",
                a.manual ? "added by hand" : a.used_by.join(", "),
                <span key="a" className="flex gap-2">
                  <Link href={`/ontology/actions/${a.id}`} target="_blank" className="text-ocean">Nexus Manager</Link>
                  {a.manual && can && <button type="button" onClick={async () => setU(await uc.ontology(id, "action_type", a.id, false))} className="text-muted hover:text-bad">Remove</button>}
                </span>,
              ])}
            />
          )}
          {section === "backing_data" && (
            <Table
              title="Backing data"
              head={["Object type", "Input datasource", "Writeback", "Updated via", ""]}
              rows={u.backing_data.map((b) => [
                <span key="o">
                  {b.object_type} {b.status && b.status !== "active" && <span className={`ml-1 rounded px-1 text-[10px] ${STATUS_CLASS[b.status] ?? ""}`}>{b.status}</span>}
                </span>,
                b.dataset ? (
                  <Link key="d" href={`/datasets/${b.dataset_id}`} target="_blank" className="text-ocean">{b.dataset}{b.extra.length ? ` + ${b.extra.length}` : ""}</Link>
                ) : (
                  <span key="d" className="text-muted">none (objects kept in the Nexus)</span>
                ),
                b.writeback ?? "—",
                b.update_via.map((p) => `${p.name} (${p.kind})`).join(", ") || "—",
                b.dataset_id ? <Link key="l" href="/lineage" target="_blank" className="text-ocean">Data Lineage</Link> : "",
              ])}
            />
          )}
          {section === "other" && (
            <Table
              title="Other resources"
              head={["Name", "Type", "Updated"]}
              rows={u.other_resources.map((r) => [<Link key="n" href={r.href} target="_blank" className="text-ocean">{r.name}</Link>, r.content_type ?? "—", when(r.updated_at)])}
            />
          )}
        </main>
      </div>
      {dialog === "app" && <NewAppDialog uid={id} onClose={() => setDialog(null)} onDone={async (href) => (setDialog(null), setU(await uc.get(id)), href && router.push(href))} />}
      {dialog === "roles" && <RolesDialog u={u} people={people} onClose={() => setDialog(null)} onSaved={(x) => (setU(x), setDialog(null))} />}
      {(dialog === "add_type" || dialog === "add_action") && <AddOntologyDialog kind={dialog === "add_type" ? "object_type" : "action_type"} onClose={() => setDialog(null)} onPick={async (rid) => (setU(await uc.ontology(id, dialog === "add_type" ? "object_type" : "action_type", rid, true)), setDialog(null))} />}
    </div>
  );
}

function Overview({ u, can, people, save, onSection, onNewApp }: { u: UseCase; can: boolean; people: { principal: string; name: string }[]; save: (b: Parameters<typeof uc.update>[1]) => void; onSection: (s: Section) => void; onNewApp: () => void }) {
  const [docEdit, setDocEdit] = useState<null | { text: string; tab: "write" | "preview" }>(null);
  const [showDoc, setShowDoc] = useState(false);
  const [status, setStatus] = useState(u.status);
  return (
    <div className="max-w-5xl space-y-5" data-overview>
      <div>
        <input defaultValue={u.name} readOnly={!can} onBlur={(e) => e.target.value.trim() && e.target.value !== u.name && save({ name: e.target.value.trim() })} className="w-full bg-transparent text-xl font-semibold text-white outline-none" aria-label="Name" />
        <textarea defaultValue={u.description} readOnly={!can} rows={2} onBlur={(e) => e.target.value !== u.description && save({ description: e.target.value })} className="mt-1 w-full resize-none bg-transparent text-sm text-soft outline-none" placeholder="Describe the use case" aria-label="Description" />
      </div>
      <div className="grid grid-cols-3 gap-3 text-xs">
        <Owners label="Technical owner" list={u.technical_owners} people={people} can={can} onChange={(p) => save({ technical_owners: p })} />
        <Owners label="Business owner" list={u.business_owners} people={people} can={can} onChange={(p) => save({ business_owners: p })} />
        <div className="rounded-lg border border-line bg-panel p-3">
          <div className="text-muted">Status</div>
          <div className="mt-1 flex items-center gap-1">
            <select value={status} disabled={!can} onChange={(e) => setStatus(e.target.value as typeof status)} className={`${fieldClass} text-xs`}>
              <option value="active">Active</option>
              <option value="experimental">Experimental</option>
              <option value="deprecated">Deprecated</option>
            </select>
            {status !== u.status && (
              <button type="button" onClick={() => save({ status })} className={buttonClass.primary}>
                Change status
              </button>
            )}
            {u.status_warning && <span title="Active with Experimental or Deprecated Nexus resources" className="text-warn">⚠</span>}
          </div>
          <div className="mt-1 text-muted">Backing Project: {u.project}</div>
        </div>
      </div>
      <div className="rounded-lg border border-line bg-panel p-3 text-xs">
        <div className="flex items-center">
          <button type="button" onClick={() => setShowDoc(!showDoc)} className="text-ocean">
            {showDoc ? "Hide documentation" : "Show documentation"}
          </button>
          {showDoc && can && !docEdit && (
            <button type="button" onClick={() => setDocEdit({ text: u.documentation, tab: "write" })} className="ml-3 text-ocean">
              Edit
            </button>
          )}
        </div>
        {showDoc && !docEdit && (u.documentation ? <div className="md-body mt-2 text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(u.documentation) }} /> : <p className="mt-2 text-muted">No documentation yet.</p>)}
        {docEdit && (
          <div className="mt-2 space-y-1">
            <div className="flex gap-1">
              {(["write", "preview"] as const).map((t) => (
                <button key={t} type="button" onClick={() => setDocEdit({ ...docEdit, tab: t })} className={`rounded px-2 py-0.5 capitalize ${docEdit.tab === t ? "bg-ocean/15 text-ocean" : "text-muted"}`}>
                  {t}
                </button>
              ))}
            </div>
            {docEdit.tab === "write" ? (
              <textarea value={docEdit.text} onChange={(e) => setDocEdit({ ...docEdit, text: e.target.value })} rows={10} className={`${inputClass} font-mono text-xs`} />
            ) : (
              <div className="md-body min-h-24 rounded border border-line p-2 text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(docEdit.text) }} />
            )}
            <div className="flex gap-2">
              <button type="button" onClick={() => (save({ documentation: docEdit.text }), setDocEdit(null))} className={buttonClass.primary}>
                Save
              </button>
              <button type="button" onClick={() => setDocEdit(null)} className={buttonClass.secondary}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      <Card title="Applications" count={u.applications.length} onOpen={() => onSection("applications")} action={can ? <button type="button" onClick={onNewApp} className="text-ocean">+ Create new application</button> : null}>
        {u.applications.slice(0, 3).map((a) => (
          <Link key={a.key} href={a.href} target="_blank" className="block rounded border border-line px-2 py-1.5 hover:border-ocean">
            <div className="text-soft">{a.name}</div>
            <div className="text-[10px] text-muted">
              {a.type_label} · {when(a.updated_at)}
            </div>
          </Link>
        ))}
        {!u.applications.length && <p className="text-muted">No applications yet.</p>}
      </Card>
      <div className="grid grid-cols-2 gap-3">
        <Card title="Object types" count={u.object_types.length} onOpen={() => onSection("object_types")}>
          {u.object_types.slice(0, 6).map((o) => (
            <div key={o.id} className="truncate">
              {o.name} {o.status && o.status !== "active" && <span className={`rounded px-1 text-[10px] ${STATUS_CLASS[o.status] ?? ""}`}>{o.status}</span>}
            </div>
          ))}
        </Card>
        <Card title="Action types" count={u.action_types.length} onOpen={() => onSection("action_types")}>
          {u.action_types.slice(0, 6).map((a) => (
            <div key={a.id} className="truncate">
              {a.name}
            </div>
          ))}
        </Card>
      </div>
      <Card title="Backing data" count={u.backing_data.filter((b) => b.dataset).length} onOpen={() => onSection("backing_data")}>
        {u.backing_data.slice(0, 4).map((b) => (
          <div key={b.object_type_id} className="truncate">
            {b.object_type}: <span className="text-muted">{b.dataset ?? "no datasource"}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

function Owners({ label, list, people, can, onChange }: { label: string; list: { principal: string; name: string }[]; people: { principal: string; name: string }[]; can: boolean; onChange: (p: string[]) => void }) {
  const [edit, setEdit] = useState(false);
  return (
    <div className="rounded-lg border border-line bg-panel p-3">
      <div className="flex text-muted">
        {label}
        {can && (
          <button type="button" onClick={() => setEdit(!edit)} className="ml-auto" aria-label={`Edit ${label}`}>
            <Icon name="pencil" className="h-3 w-3" />
          </button>
        )}
      </div>
      {edit ? (
        <select multiple value={list.map((x) => x.principal)} onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))} className={`${inputClass} mt-1 h-24 text-xs`}>
          {people.map((p) => (
            <option key={p.principal} value={p.principal}>
              {p.name}
            </option>
          ))}
        </select>
      ) : (
        <div className="mt-1 text-soft">{list.map((x) => x.name).join(", ") || "—"}</div>
      )}
    </div>
  );
}

function Card({ title, count, onOpen, action, children }: { title: string; count: number; onOpen: () => void; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel p-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <button type="button" onClick={onOpen} className="font-medium text-white hover:underline">
          {title}
        </button>
        <span className="text-muted">{count}</span>
        <span className="ml-auto">{action}</span>
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Table({ title, action, head, rows }: { title: string; action?: React.ReactNode; head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="max-w-6xl">
      <div className="mb-3 flex items-center">
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <span className="ml-2 text-xs text-muted">{rows.length}</span>
        <span className="ml-auto">{action}</span>
      </div>
      <table className="w-full text-xs">
        <thead className="text-left text-muted">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="py-1 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {r.map((c, j) => (
                <td key={j} className="max-w-xs truncate py-1.5 pr-3">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="mt-2 text-xs text-muted">Nothing here yet.</p>}
    </div>
  );
}

function AppPage({ u, app, can, save, onBack, onType }: { u: UseCase; app: App; can: boolean; save: (b: Parameters<typeof uc.update>[1]) => void; onBack: () => void; onType: (t: string) => void }) {
  const types = u.object_types.filter((o) => app.refs.includes(o.id));
  return (
    <div className="max-w-4xl space-y-3 text-xs">
      <button type="button" onClick={onBack} className="text-ocean">
        ← Applications
      </button>
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-white">{app.name}</h2>
        <span className="text-muted">{app.type_label}</span>
        <Link href={app.href} target="_blank" className={`${buttonClass.secondary} ml-auto`}>
          Edit application
        </Link>
      </div>
      <textarea defaultValue={app.description} readOnly={!can} rows={2} onBlur={(e) => e.target.value !== app.description && save({ app_description: { key: app.key, description: e.target.value } })} placeholder="Describe this application" className={inputClass} />
      <div className="font-medium text-soft">Object types used</div>
      {types.map((o) => (
        <div key={o.id} className="flex gap-2 border-t border-line py-1">
          <button type="button" onClick={() => onType(o.id)} className="text-ocean hover:underline">
            {o.name}
          </button>
          <span className="text-muted">also in {o.used_by.filter((x) => x !== app.name).join(", ") || "no other application"}</span>
        </div>
      ))}
      {!types.length && <p className="text-muted">No object types found in this application.</p>}
      <div className="font-medium text-soft">Action types used</div>
      {u.action_types.filter((a) => app.refs.includes(a.id)).map((a) => (
        <div key={a.id}>{a.name}</div>
      ))}
    </div>
  );
}

function ObjectTypePage({ uid, tid, onBack }: { uid: string; tid: string; onBack: () => void }) {
  const [t, setT] = useState<Awaited<ReturnType<typeof uc.objectType>> | null>(null);
  useEffect(() => {
    let stale = false;
    uc.objectType(uid, tid).then((x) => !stale && setT(x), () => {});
    return () => {
      stale = true;
    };
  }, [uid, tid]);
  if (!t) return <p className="text-muted">Loading…</p>;
  return (
    <div className="max-w-4xl space-y-3 text-xs" data-object-type-page>
      <button type="button" onClick={onBack} className="text-ocean">
        ← Object types
      </button>
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-white">{t.name}</h2>
        {t.status && <span className={`rounded px-1.5 text-[10px] capitalize ${STATUS_CLASS[t.status] ?? ""}`}>{t.status}</span>}
        <Link href={`/ontology/${t.id}`} target="_blank" className={`${buttonClass.secondary} ml-auto`}>
          View and edit in Nexus Manager
        </Link>
      </div>
      <p className="text-soft">{t.description}</p>
      <div>
        Datasource: {t.backing_dataset ? <Link href={`/datasets/${t.backing_dataset.dataset_id}`} className="text-ocean">{t.backing_dataset.name}</Link> : <span className="text-muted">none (objects kept in the Nexus)</span>}
        {t.additional_datasources.length > 0 && <span className="text-muted"> + {t.additional_datasources.join(", ")}</span>}
      </div>
      <div className="font-medium text-soft">Properties ({t.properties.length})</div>
      <div className="grid grid-cols-2 gap-x-6">
        {t.properties.map((p) => (
          <div key={p.api_name} className="flex border-t border-line py-0.5">
            <span className="flex-1 truncate">{p.display_name || p.api_name}</span>
            <span className="text-muted">{p.type}</span>
            {p.api_name === t.primary_key && <span className="ml-1 text-ocean">PK</span>}
          </div>
        ))}
      </div>
      <div className="font-medium text-soft">Applications in this use case</div>
      {t.applications.map((a) => (
        <Link key={a.key} href={a.href} target="_blank" className="block text-ocean hover:underline">
          {a.name} <span className="text-muted">· {a.type_label}</span>
        </Link>
      ))}
    </div>
  );
}

function NewAppDialog({ uid, onClose, onDone }: { uid: string; onClose: () => void; onDone: (href: string | null) => void }) {
  const [kind, setKind] = useState<"workshop" | "slate" | "quiver" | "existing">("workshop");
  const [name, setName] = useState("");
  const [mods, setMods] = useState<{ id: string; name: string }[]>([]);
  const [pick, setPick] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    workshop.modules().then((m) => setMods(m.map((x) => ({ id: x.id, name: x.name }))), () => {});
  }, []);
  return (
    <Modal title="Create new application" icon="device" onClose={onClose}>
      <div className="space-y-3 p-5 text-sm">
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["workshop", "Workshop", "Interactive no-code applications"],
              ["slate", "Slate", "Code-first applications"],
              ["quiver", "Quiver", "Analyses and dashboards"],
              ["existing", "Existing Workshop module", "Add a module kept in another Project (modules in this Project are found automatically)"],
            ] as const
          ).map(([k, t, d]) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={`rounded-lg border p-3 text-left text-xs ${kind === k ? "border-ocean bg-ocean/10" : "border-line-2"}`}>
              <div className="font-medium text-white">{t}</div>
              <div className="text-muted">{d}</div>
            </button>
          ))}
        </div>
        {kind === "existing" ? (
          <select value={pick} onChange={(e) => setPick(e.target.value)} className={inputClass}>
            <option value="">Choose a module</option>
            {mods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : kind !== "quiver" ? (
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={inputClass} />
        ) : (
          <p className="text-xs text-muted">Quiver analyses are created in Quiver and saved in the Project; they then appear here.</p>
        )}
        {err && <p className="text-xs text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={(kind === "existing" && !pick) || ((kind === "workshop" || kind === "slate") && !name.trim())}
            onClick={async () => {
              try {
                if (kind === "existing") {
                  await uc.linkWorkshop(uid, pick);
                  onDone(null);
                } else onDone((await uc.newApp(uid, kind, name.trim() || "Quiver analysis")).href);
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
            className={buttonClass.primary}>
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RolesDialog({ u, people, onClose, onSaved }: { u: UseCase; people: { principal: string; name: string }[]; onClose: () => void; onSaved: (u: UseCase) => void }) {
  const [roles, setRoles] = useState(u.roles.map((r) => ({ principal: r.principal, role: r.role as string })));
  const [add, setAdd] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const name = (p: string) => people.find((x) => x.principal === p)?.name ?? u.roles.find((r) => r.principal === p)?.name ?? p;
  return (
    <Modal title="Manage permissions" icon="lock" onClose={onClose}>
      <div className="space-y-2 p-5 text-xs">
        <p className="text-muted">Roles govern the use case&apos;s metadata only; everyone in the organization can see it. Resources keep their own permissions.</p>
        {roles.map((r, i) => (
          <div key={r.principal} className="flex items-center gap-2">
            <span className="flex-1">{name(r.principal)}</span>
            <select value={r.role} onChange={(e) => setRoles(roles.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} className={`${fieldClass} text-xs`}>
              <option value="owner">Use Case Owner</option>
              <option value="editor">Use Case Editor</option>
            </select>
            <button type="button" onClick={() => setRoles(roles.filter((_, j) => j !== i))} className="text-muted hover:text-bad">
              ✕
            </button>
          </div>
        ))}
        <div className="flex gap-1">
          <select value={add} onChange={(e) => setAdd(e.target.value)} className={`${fieldClass} flex-1 text-xs`}>
            <option value="">Add a user or group</option>
            {people.filter((p) => !roles.some((r) => r.principal === p.principal)).map((p) => (
              <option key={p.principal} value={p.principal}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="button" disabled={!add} onClick={() => (setRoles([...roles, { principal: add, role: "editor" }]), setAdd(""))} className={buttonClass.secondary}>
            Add
          </button>
        </div>
        {err && <p className="text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" onClick={async () => uc.roles(u.id, roles).then(onSaved, (e: Error) => setErr(e.message))} className={buttonClass.primary}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AddOntologyDialog({ kind, onClose, onPick }: { kind: "object_type" | "action_type"; onClose: () => void; onPick: (id: string) => void }) {
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    import("@/lib/ontology").then(({ ontology }) =>
      (kind === "object_type" ? ontology.objectTypes().then((ts) => ts.map((t) => ({ id: t.id, name: t.display_name }))) : ontology.actionTypes().then((as) => as.map((a) => ({ id: a.id, name: a.display_name })))).then(setList, () => {}),
    );
  }, [kind]);
  return (
    <Modal title={kind === "object_type" ? "Add object type" : "Add action type"} icon="plus" onClose={onClose}>
      <div className="p-3 text-xs">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className={inputClass} />
        <div className="mt-2 max-h-80 overflow-auto">
          {list.filter((x) => x.name.toLowerCase().includes(q.toLowerCase())).slice(0, 100).map((x) => (
            <button key={x.id} type="button" onClick={() => onPick(x.id)} className="block w-full rounded px-2 py-1 text-left hover:bg-panel-2">
              {x.name}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
