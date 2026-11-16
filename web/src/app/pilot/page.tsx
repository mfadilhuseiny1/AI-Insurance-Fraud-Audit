"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { missingText } from "@/components/LocationField";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, API_URL, type DriveItem } from "@/lib/api";
import { pilot, type Check, type Session, type SessionSummary } from "@/lib/pilot";

/** Pilot (palantir.com/docs/foundry/pilot): describe an application or a custom widget; agents design the ontology,
 *  the design, seed data and the code; preview on seed data; deploy through Developer Console or a widget set. */
export default function PilotPage() {
  return (
    <Suspense fallback={null}>
      <Pilot />
    </Suspense>
  );
}

function Pilot() {
  const params = useSearchParams();
  const id = params.get("id");
  return id ? <Workspace key={id} id={id} /> : <Welcome />;
}

function Welcome() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"application" | "widget">("application");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [folder, setFolder] = useState("");
  const [models, setModels] = useState<{ id: string; label: string; default?: boolean }[]>([]);
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<"act" | "plan">("act");
  const [allowCreate, setAllowCreate] = useState(true);
  const [defaultEdit, setDefaultEdit] = useState<"allow" | "deny">("deny");
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [perms, setPerms] = useState(false);
  const [doc, setDoc] = useState("");
  const [tried, setTried] = useState(false);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [
    ...(prompt.trim().length >= 3 ? [] : ["describe what to build"]),
    ...(folder ? [] : ["choose a save location"]),
    ...(model ? [] : ["choose a model"]),
  ];
  const bad = (on: boolean) => (tried && on ? "border-bad ring-1 ring-bad/40" : "");
  useEffect(() => {
    api.drive.folder(null).then((f) => {
      const ps = f.items.filter((i) => i.kind === "project");
      setProjects(ps);
      setFolder((c) => c || ps[0]?.id || "");
    }, () => {});
    pilot.models().then((m) => {
      setModels(m);
      setModel((c) => c || m.find((x) => x.default)?.id || m[0]?.id || "");
    }, () => {});
    pilot.list().then(setSessions, () => setSessions([]));
  }, []);
  const go = async () => {
    setTried(true);
    if (missing.length) return;
    setBusy(true);
    setErr(null);
    try {
      const s = await pilot.create({ prompt, folder_id: folder, kind, model, mode, allow_create: allowCreate, default_edit: defaultEdit, attachments: doc.trim() ? [{ kind: "document", name: "Attached notes", text: doc.slice(0, 8000) }] : [] });
      router.push(`/pilot?id=${s.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <>
      <AppHome
        app="Pilot"
        icon="sparkle"
        accent="#7c3aed"
        href="/pilot"
        tagline="Describe an application or a custom widget set, and Pilot builds it on the Nexus with you."
        description={
          <>
            Each session is a workspace with a live preview, the Nexus types it uses or creates, the code and its logs; deploy it when it is ready. Nexus permissions decide
            whether Pilot may create new object and action types or change existing ones.
          </>
        }
        noun={["session", "sessions"]}
        items={
          sessions?.map((s) => ({
            id: s.id,
            href: `/pilot?id=${s.id}`,
            title: s.name,
            updated_at: s.updated_at,
            icon: s.kind === "application" ? ("sparkle" as const) : ("grid" as const),
            badges: [
              { label: s.kind === "application" ? "application" : "widget set", tone: "muted" as const },
              s.deployment ? { label: "deployed", tone: "ok" as const } : { label: s.status, tone: s.status === "failed" ? ("bad" as const) : ("ocean" as const) },
            ],
            meta: `${s.versions} version${s.versions === 1 ? "" : "s"} · ${s.messages} message${s.messages === 1 ? "" : "s"}`,
          })) ?? null
        }
        empty={{ title: "Build your first app with Pilot", hint: "Describe what you need in a sentence or two; Pilot proposes the data model and the code.", steps: ["Describe the app or widget", "Pick a Project and a model", "Review, refine and deploy"] }}
        create={
          <div className="w-full space-y-3">
            <h2 className="text-base font-semibold text-strong">What do you want to build?</h2>
            <div className="flex gap-2 text-sm">
              {(["application", "widget"] as const).map((k) => (
                <button key={k} type="button" onClick={() => setKind(k)} className={`rounded-full border px-3 py-1 ${kind === k ? "border-ocean bg-ocean/15 text-white" : "border-line text-muted"}`}>
                  {k === "application" ? "Application" : "Custom widget set"}
                </button>
              ))}
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              aria-invalid={tried && prompt.trim().length < 3}
              placeholder={kind === "application" ? "Build a claims review application for verifiers: queue of claims in verification, the tariff difference, approve or hold with a note…" : "A widget that shows the claims of an object set as a heat map by diagnosis and month; clicking a cell selects that diagnosis…"}
              className={`${inputClass} text-sm ${bad(prompt.trim().length < 3)}`}
            />
            {tried && prompt.trim().length < 3 && <span className="block text-[11px] text-bad">Describe the application or widget in a sentence or two.</span>}
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">Add context (notes, requirements)</summary>
              <textarea value={doc} onChange={(e) => setDoc(e.target.value)} rows={4} placeholder="Paste requirements, a process description, field lists…" className={`${inputClass} mt-1`} />
            </details>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <label className="text-muted">
                Save location <span className="text-bad" aria-hidden>*</span>{" "}
                <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-invalid={tried && !folder} className={`${inputClass} inline-block w-56 ${bad(!folder)}`}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-muted">
                Model <span className="text-bad" aria-hidden>*</span>{" "}
                <select value={model} onChange={(e) => setModel(e.target.value)} aria-invalid={tried && !model} className={`${inputClass} inline-block w-56 ${bad(!model)}`}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex rounded border border-line-2">
                {(["act", "plan"] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setMode(m)} className={`px-2 py-1 capitalize ${mode === m ? "bg-ocean/15 text-white" : "text-muted"}`}>
                    {m}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => setPerms(true)} className="text-ocean hover:underline">
                Nexus permissions
              </button>
              <div className="ml-auto flex items-center gap-3">
                {missing.length > 0 && <span className={tried ? "text-bad" : "text-muted"} data-create-missing>To create: {missingText(missing)}</span>}
                <button type="button" disabled={busy} onClick={go} className={buttonClass.primary}>
                  <Icon name="sparkle" className="h-3.5 w-3.5" /> {busy ? "Creating…" : kind === "application" ? "Create application" : "Create widget"}
                </button>
              </div>
            </div>
            {!models.length && <p className="text-xs text-warn">No language model is configured (Control Panel → models / API keys).</p>}
            {err && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</p>}
          </div>
        }
      />
      {perms && (
        <Modal title="Nexus permissions" icon="sliders" onClose={() => setPerms(false)}>
          <div className="space-y-3 p-5 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={allowCreate} onChange={(e) => setAllowCreate(e.target.checked)} /> Allow Pilot to create new object and action types
            </label>
            <label className="block text-xs text-muted">
              Default edit permission for existing entities
              <select value={defaultEdit} onChange={(e) => setDefaultEdit(e.target.value as "allow" | "deny")} className={`${inputClass} mt-1`}>
                <option value="deny">Do not allow modifications</option>
                <option value="allow">Allow modifications (adding properties can break their API)</option>
              </select>
            </label>
            <p className="text-xs text-muted">Per-entity permissions are on the Nexus tab once the session starts.</p>
          </div>
        </Modal>
      )}
    </>
  );
}

type Tab = "preview" | "ontology" | "code" | "logs";

function Workspace({ id }: { id: string }) {
  const [s, setS] = useState<Session | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("preview");
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"act" | "plan" | null>(null);
  const [deploying, setDeploying] = useState(false);
  const load = useCallback(() => pilot.get(id).then(setS, (e: Error) => setErr(e.message)), [id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (s?.status !== "running") return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [s?.status, load]);
  const lastVersion = s?.versions[s.versions.length - 1]?.n;
  if (err) return <p className="p-8 text-sm text-bad">{err}</p>;
  if (!s) return <p className="p-8 text-sm text-muted">Loading…</p>;
  const send = async () => {
    if (!text.trim()) return;
    try {
      setS(await pilot.prompt(id, { prompt: text, mode: mode ?? undefined }));
      setText("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="flex h-full flex-col">
      <AppHeader app="Pilot" icon="sparkle" href="/pilot" crumbs={[{ label: s.name }]}>
        <StatusPill s={s} />
        <select
          value=""
          onChange={async (e) => e.target.value && setS(await pilot.restore(id, Number(e.target.value)))}
          className={`${inputClass} w-44 text-xs`}
          title="Versions"
        >
          <option value="">Version {lastVersion ?? "—"}</option>
          {[...s.versions].reverse().map((v) => (
            <option key={v.n} value={v.n}>
              Restore v{v.n}: {v.label.slice(0, 30)}
            </option>
          ))}
        </select>
        <button type="button" disabled={s.status === "running" || !s.versions.length} onClick={() => setDeploying(true)} className={buttonClass.primary}>
          <Icon name="bolt" className="h-3.5 w-3.5" /> Deploy
        </button>
      </AppHeader>
      <div className="grid min-h-0 flex-1 grid-cols-[22rem_1fr]">
        <aside className="flex min-h-0 flex-col border-r border-line">
          <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3 text-sm">
            {s.messages.map((m, i) => (
              <div key={i} className={`rounded-lg px-3 py-2 ${m.role === "user" ? "ml-6 bg-ocean/15" : m.error ? "bg-bad/10 text-bad" : "bg-panel-2"}`}>
                {m.agent && <div className="mb-0.5 text-[10px] uppercase tracking-wider text-ocean">{m.agent}</div>}
                <div className="whitespace-pre-wrap text-[13px]">{m.text}</div>
                {m.entities && m.entities.length > 0 && <div className="mt-1 text-[11px] text-muted">{m.entities.join(" · ")}</div>}
                {m.awaiting_approval && s.pending_plan && (
                  <button type="button" onClick={async () => setS(await pilot.approve(id))} className={`${buttonClass.primary} mt-2`}>
                    Approve and build
                  </button>
                )}
              </div>
            ))}
            {s.status === "running" && <div className="text-xs text-muted">{s.logs[s.logs.length - 1]?.agent ?? "pilot"}: {s.logs[s.logs.length - 1]?.text ?? "working"}…</div>}
          </div>
          <div className="border-t border-line p-2">
            <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), void send())} rows={3} placeholder="Refine: add a dashboard, change the colors, add a field…" className={`${inputClass} text-sm`} disabled={s.status === "running"} />
            <div className="mt-1 flex items-center gap-2 text-xs">
              <div className="flex rounded border border-line-2">
                {(["act", "plan"] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setMode(m)} className={`px-2 py-0.5 capitalize ${(mode ?? s.mode) === m ? "bg-ocean/15 text-white" : "text-muted"}`} title="Applies to the next prompt">
                    {m}
                  </button>
                ))}
              </div>
              <span className="truncate text-muted">{s.model}</span>
              <button type="button" disabled={s.status === "running" || !text.trim()} onClick={send} className={`${buttonClass.primary} ml-auto`}>
                Send
              </button>
            </div>
          </div>
        </aside>
        <main className="flex min-h-0 flex-col">
          <div className="flex gap-1 border-b border-line px-3 text-sm">
            {(["preview", "ontology", "code", "logs"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)} className={`px-3 py-1.5 capitalize ${tab === t ? "border-b-2 border-ocean text-white" : "text-muted"}`}>
                {t === "logs" ? "Pilot logs" : t}
              </button>
            ))}
            {s.deployment && (
              <span className="ml-auto flex items-center gap-2 py-1.5 text-xs">
                <span className="text-ok">deployed</span>
                {s.deployment.url && (
                  <a href={String(s.deployment.url)} target="_blank" rel="noreferrer" className="text-ocean hover:underline">
                    Open application
                  </a>
                )}
                {s.deployment.module_id && (
                  <Link href={`/workshop/${s.deployment.module_id}`} className="text-ocean hover:underline">
                    Open in Workshop
                  </Link>
                )}
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === "preview" && <Preview s={s} nonce={lastVersion ?? 0} />}
            {tab === "ontology" && <OntologyTab s={s} onSession={setS} />}
            {tab === "code" && <CodeTab key={lastVersion} s={s} onSession={setS} />}
            {tab === "logs" && (
              <pre className="whitespace-pre-wrap p-3 font-mono text-[11px] text-soft">
                {s.logs.map((l) => `${l.at} [${l.agent}] ${l.text}`).join("\n")}
              </pre>
            )}
          </div>
        </main>
      </div>
      {deploying && <DeployDialog s={s} onClose={() => setDeploying(false)} onDone={() => (setDeploying(false), void load())} />}
    </div>
  );
}

function StatusPill({ s }: { s: Session }) {
  const ok = s.status !== "failed";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] ${s.status === "running" ? "bg-ocean/15 text-ocean" : ok ? "bg-ok/15 text-ok" : "bg-bad/15 text-bad"}`}>
      {s.status === "running" ? "building…" : ok ? (s.versions.length ? "ready" : "idle") : "build failed"}
    </span>
  );
}

function Preview({ s, nonce }: { s: Session; nonce: number }) {
  const [device, setDevice] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [reload, setReload] = useState(0);
  const width = device === "desktop" ? "100%" : device === "tablet" ? 820 : 390;
  if (!s.versions.length) return <div className="flex h-full items-center justify-center text-sm text-muted">Pilot is building the first version…</div>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1 text-xs">
        <button type="button" onClick={() => setReload((r) => r + 1)} className="text-muted hover:text-white" title="Reload">
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </button>
        <span className="truncate font-mono text-muted">{s.kind === "application" ? "seed data preview" : "widget sandbox · seed data"}</span>
        <div className="ml-auto flex rounded border border-line-2">
          {(["desktop", "tablet", "mobile"] as const).map((d) => (
            <button key={d} type="button" onClick={() => setDevice(d)} className={`px-2 py-0.5 capitalize ${device === d ? "bg-ocean/15 text-white" : "text-muted"}`}>
              {d}
            </button>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 justify-center bg-ink p-2">
        <iframe
          key={`${nonce}:${reload}`}
          src={API_URL + s.preview_url}
          title="Preview"
          data-pilot-preview
          sandbox={s.kind === "widget" ? "allow-scripts" : "allow-scripts allow-same-origin allow-forms"}
          style={{ width, maxWidth: "100%" }}
          className="h-full rounded border border-line bg-white"
        />
      </div>
    </div>
  );
}

function OntologyTab({ s, onSession }: { s: Session; onSession: (s: Session) => void }) {
  const [sel, setSel] = useState<string | null>(s.plan.object_types[0]?.apiName ?? null);
  const [filter, setFilter] = useState<"all" | "existing" | "proposed">("all");
  const types = s.plan.object_types.filter((t) => filter === "all" || t.status === filter);
  const pos = useMemo(() => Object.fromEntries(s.plan.object_types.map((t, i) => [t.apiName, { x: 30 + (i % 4) * 230, y: 30 + Math.floor(i / 4) * 170 }])), [s.plan.object_types]);
  const t = s.plan.object_types.find((x) => x.apiName === sel);
  const rows = (sel && s.seed[sel]) || [];
  const setPerm = async (eid: string, v: "allow" | "deny") => onSession(await pilot.permissions(s.id, { ...s.permissions, entities: { ...s.permissions.entities, [eid]: v } }));
  return (
    <div className="grid h-full grid-cols-[1fr_24rem]">
      <div className="relative overflow-auto">
        <div className="absolute left-3 top-2 z-10 flex gap-1 text-xs">
          {(["all", "existing", "proposed"] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} className={`rounded px-2 py-0.5 capitalize ${filter === f ? "bg-ocean/15 text-white" : "bg-panel text-muted"}`}>
              {f}
            </button>
          ))}
          <label className="ml-2 flex items-center gap-1 rounded bg-panel px-2 text-muted">
            <input type="checkbox" checked={s.permissions.allow_create} onChange={async (e) => onSession(await pilot.permissions(s.id, { ...s.permissions, allow_create: e.target.checked }))} /> may create new types
          </label>
        </div>
        <svg width={Math.max(600, 4 * 230 + 40)} height={Math.max(300, Math.ceil(s.plan.object_types.length / 4) * 170 + 60)} className="mt-6 text-xs">
          {s.plan.link_types.map((l, i) => {
            const a = pos[l.from];
            const b = pos[l.to];
            if (!a || !b) return null;
            return <line key={i} x1={a.x + 100} y1={a.y + 40} x2={b.x + 100} y2={b.y + 40} stroke="currentColor" className="text-ocean/50" strokeWidth={1.5} />;
          })}
          {types.map((x) => {
            const p = pos[x.apiName];
            const acts = s.plan.action_types.filter((a) => a.objectType === x.apiName);
            return (
              <g key={x.apiName} transform={`translate(${p.x},${p.y})`} onClick={() => setSel(x.apiName)} className="cursor-pointer">
                <rect width={200} height={60 + acts.length * 16} rx={8} className={`${sel === x.apiName ? "fill-ocean/20" : "fill-panel-2"} ${x.status === "proposed" ? "stroke-ok" : "stroke-line-2"}`} strokeWidth={1.5} strokeDasharray={x.status === "proposed" ? "4 3" : undefined} />
                <text x={10} y={20} className="fill-current font-medium">
                  {x.displayName.slice(0, 26)}
                </text>
                <text x={10} y={38} className="fill-current text-[10px] text-muted">
                  {x.status} · {x.properties.length} properties · {(s.seed[x.apiName] ?? []).length} rows
                </text>
                {acts.map((a, j) => (
                  <text key={a.apiName} x={14} y={56 + j * 16} className="fill-current text-[10px] text-ocean">
                    ⚡ {a.displayName.slice(0, 28)} ({a.kind})
                  </text>
                ))}
              </g>
            );
          })}
        </svg>
        <div className="px-3 pb-3 text-[11px] text-muted">Dashed green: proposed by Pilot · solid: existing entities reused. {s.plan.rationale}</div>
      </div>
      <div className="overflow-auto border-l border-line p-3 text-xs">
        {t ? (
          <>
            <div className="text-sm font-medium">{t.displayName}</div>
            <div className="font-mono text-[11px] text-muted">{t.apiName}</div>
            {t.status === "existing" && t.existingId && (
              <label className="mt-2 block text-muted">
                Pilot may
                <select value={s.permissions.entities[t.existingId] ?? s.permissions.default} onChange={(e) => setPerm(t.existingId!, e.target.value as "allow" | "deny")} className={`${inputClass} mt-1`}>
                  <option value="deny">Do not allow modifications</option>
                  <option value="allow">Allow modifications</option>
                </select>
              </label>
            )}
            <div className="mt-2 font-medium">Properties</div>
            {t.properties.map((p) => (
              <div key={p.apiName} className="flex gap-2">
                <span className="font-mono">{p.apiName}</span>
                <span className="text-muted">{p.type}</span>
                {t.primaryKey === p.apiName && <span className="text-ocean">primary key</span>}
                {t.added?.includes(p.apiName) && <span className="text-ok">added</span>}
              </div>
            ))}
            <div className="mt-3 font-medium">Seed data ({rows.length} rows)</div>
            <div className="overflow-auto">
              <table className="mt-1 w-full">
                <tbody>
                  {rows.slice(0, 15).map((r, i) => (
                    <tr key={i} className="border-t border-line">
                      {Object.values(r)
                        .slice(0, 4)
                        .map((v, j) => (
                          <td key={j} className="max-w-24 truncate px-1 py-0.5">
                            {String(v ?? "")}
                          </td>
                        ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="text-muted">Select an object type.</p>
        )}
      </div>
    </div>
  );
}

function CodeTab({ s, onSession }: { s: Session; onSession: (s: Session) => void }) {
  const initial = useMemo<Record<string, string>>(
    () =>
      s.kind === "widget"
        ? { "widget.js": s.widget?.js ?? "", "widget.html": s.widget?.html ?? "", "widget.css": s.widget?.css ?? "", "widget.config.json": JSON.stringify({ name: s.widget?.name, description: s.widget?.description, parameters: s.widget?.parameters, events: s.widget?.events }, null, 2) }
        : { ...s.files },
    [s],
  );
  const [files, setFiles] = useState(initial);
  const [sel, setSel] = useState(Object.keys(initial).find((k) => k.endsWith(".js")) ?? Object.keys(initial)[0]);
  const [msg, setMsg] = useState<string | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  return (
    <div className="flex h-full flex-col p-3 text-xs">
      <div className="mb-2 flex items-center gap-1">
        {Object.keys(files).map((k) => (
          <button key={k} type="button" onClick={() => setSel(k)} className={`rounded px-2 py-0.5 font-mono ${sel === k ? "bg-ocean/15 text-white" : "text-muted"}`}>
            {k}
          </button>
        ))}
        <span className="ml-auto text-muted">{msg}</span>
        <button type="button" onClick={async () => setChecks(await pilot.checks(s.id))} className={buttonClass.secondary}>
          Run checks
        </button>
        <button
          type="button"
          onClick={async () => {
            try {
              const out = s.kind === "widget" ? Object.fromEntries(Object.entries(files).map(([k, v]) => [k.replace(/^widget\.(js|html|css)$/, "widget.$1"), v])) : files;
              onSession(await pilot.saveFiles(s.id, out));
              setMsg("Saved as a new version");
            } catch (e) {
              setMsg((e as Error).message);
            }
          }}
          className={buttonClass.primary}
        >
          Save
        </button>
      </div>
      {checks && (
        <div className="mb-2 space-y-0.5">
          {checks.map((c) => (
            <div key={c.check} className={c.ok ? "text-ok" : "text-bad"}>
              {c.ok ? "✓" : "✕"} {c.check}: {c.detail}
            </div>
          ))}
        </div>
      )}
      <textarea value={files[sel] ?? ""} onChange={(e) => setFiles({ ...files, [sel]: e.target.value })} className={`${inputClass} min-h-0 flex-1 font-mono text-[11px]`} spellCheck={false} />
      {s.kind === "application" && <p className="mt-1 text-muted">pilot.js and sdk/index.js are provided by the platform (seed data in the preview, the Developer Console application once deployed).</p>}
    </div>
  );
}

function DeployDialog({ s, onClose, onDone }: { s: Session; onClose: () => void; onDone: () => void }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [loadSeed, setLoadSeed] = useState(false);
  const [module, setModule] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[] | null>(null);
  useEffect(() => {
    pilot.checks(s.id).then(setChecks, (e: Error) => setErr(e.message));
  }, [s.id]);
  const proposed = s.plan.object_types.filter((t) => t.status === "proposed");
  const changed = s.plan.object_types.filter((t) => t.added?.length);
  return (
    <Modal title={s.kind === "application" ? "Deploy the application" : "Publish the widget"} icon="bolt" onClose={onClose}>
      <div className="space-y-3 p-5 text-sm">
        <div className="text-xs">
          <div className="font-medium">1. Nexus</div>
          {proposed.length || changed.length || s.plan.action_types.some((a) => a.status === "proposed") ? (
            <ul className="ml-4 list-disc text-muted">
              {proposed.map((t) => (
                <li key={t.apiName}>create {t.displayName}</li>
              ))}
              {changed.map((t) => (
                <li key={t.apiName}>
                  add {t.added!.join(", ")} to {t.displayName}
                </li>
              ))}
              {s.plan.action_types.filter((a) => a.status === "proposed").map((a) => (
                <li key={a.apiName}>create the action {a.displayName}</li>
              ))}
              {s.plan.link_types.map((l, i) => (
                <li key={i}>
                  link {l.from} → {l.to}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">Only existing entities: nothing to promote.</p>
          )}
          {proposed.length > 0 && (
            <label className="mt-1 flex items-center gap-2 text-muted">
              <input type="checkbox" checked={loadSeed} onChange={(e) => setLoadSeed(e.target.checked)} /> Load the seed rows into the new object types as starting objects (they are invented data)
            </label>
          )}
        </div>
        <div className="text-xs">
          <div className="font-medium">2. Checks</div>
          {checks?.map((c) => (
            <div key={c.check} className={c.ok ? "text-ok" : "text-bad"}>
              {c.ok ? "✓" : "✕"} {c.check}: {c.detail}
            </div>
          )) ?? <span className="text-muted">running…</span>}
        </div>
        <div className="text-xs">
          <div className="font-medium">3. {s.kind === "application" ? "Developer Console and release" : "Widget set release"}</div>
          <p className="text-muted">
            {s.kind === "application"
              ? "A Developer Console application with these scopes, its SDK, and the site released at /api/dc-hosting/…; users sign in with OAuth and work on real data."
              : "A widget set version with the Nexus resources configured (Nexus APIs enabled if you are an administrator)."}
          </p>
          {s.kind === "widget" && (
            <label className="mt-1 flex items-center gap-2 text-muted">
              <input type="checkbox" checked={module} onChange={(e) => setModule(e.target.checked)} /> Embed it in a new Workshop module
            </label>
          )}
        </div>
        {steps && (
          <ul className="ml-4 list-disc text-xs text-ok">
            {steps.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
        {err && <p className="text-xs text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={steps ? onDone : onClose} className={buttonClass.secondary}>
            {steps ? "Close" : "Cancel"}
          </button>
          {!steps && (
            <button
              type="button"
              disabled={busy || !checks || checks.some((c) => !c.ok)}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  const d = await pilot.deploy(s.id, { load_seed: loadSeed, workshop_module: module });
                  setSteps(d.steps ?? []);
                } catch (e) {
                  setErr((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
              className={buttonClass.primary}
            >
              {busy ? "Deploying…" : "Deploy"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
