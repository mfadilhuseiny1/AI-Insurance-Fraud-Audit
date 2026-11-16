"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { Icon, type IconName } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { API_URL } from "@/lib/api";
import { carbon, CARBON_OPEN, MODULE_LABEL, moduleUrl, type CarbonConfig, type ModuleRef, type ModuleType, type Section, type Shortcut, type UpdatePage, type Workspace } from "@/lib/carbon";
import { moduleKey } from "@/components/carbon/OpenIn";
import { when } from "@/lib/format";

export default function CarbonWorkspacePage() {
  return (
    <Suspense fallback={null}>
      <CarbonWorkspace />
    </Suspense>
  );
}

type Tab = { key: string; title: string; module: ModuleRef; icon?: string; color?: string; anchored?: boolean };
const ICONS: IconName[] = ["cube", "table", "search", "bell", "layers", "doc", "grid", "graph", "gauge", "bolt", "globe", "list", "image", "wave", "logic", "check", "clock", "folder"];
const iconOf = (m: ModuleRef): IconName =>
  m.type === "workshop" ? "grid" : m.type === "slate" ? "palette" : m.type === "notepad" ? "doc" : m.type === "map" ? "globe" : m.type === "vertex" ? "graph" : m.type === "quiver" ? "wave" : m.type === "url" ? "external" : "cube";

function CarbonWorkspace() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const { me, signOut } = useAuth();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [draft, setDraft] = useState<CarbonConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(params.get("edit") === "1");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState("home");
  const [navOpen, setNavOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [updates, setUpdates] = useState<UpdatePage[]>([]);
  const [whatsNew, setWhatsNew] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let stale = false;
    carbon.get(id, preview ?? undefined).then(
      (w) => {
        if (stale) return;
        setWs(w);
        setDraft(structuredClone(w.config));
      },
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [id, preview, nonce]);
  useEffect(() => {
    carbon.unseen(id).then((u) => {
      setUpdates(u);
      if (u.length) setWhatsNew(true);
    }, () => {});
  }, [id]);
  const cfg = editing ? draft : ws?.config;
  const open = useCallback((t: Tab) => {
    setTabs((ts) => (ts.some((x) => x.key === t.key) ? ts : [...ts, t]));
    setActive(t.key);
  }, []);
  // opened from Object Explorer's "Open in" (?module=<type>:<id>): that discoverable module in a tab
  const wanted = params.get("module");
  const openedWanted = useRef(false);
  useEffect(() => {
    if (!wanted || !ws || openedWanted.current) return;
    const all = [...ws.config.general.discoverableModules, ...ws.config.moduleShortcuts.primary.map((s) => s.module), ...ws.config.moduleShortcuts.secondary.map((s) => s.module)];
    const m = all.find((x) => moduleKey(x) === wanted);
    if (!m) return;
    openedWanted.current = true;
    // deferred, and not cancelled by a re-run: the flag above already marks it as opened
    setTimeout(() => open({ key: `open-in:${wanted}`, title: m.title || MODULE_LABEL[m.type], module: m }), 0);
  }, [wanted, ws, open]);
  // navigation between modules: an embedded Workshop module's "open module" event opens that module in a tab here,
  // with the event's parameters (the first module's outputs) as the second module's inputs
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const d = e.data as { type?: string; module?: ModuleRef; title?: string } | null;
      if (e.origin !== window.location.origin || d?.type !== CARBON_OPEN || d.module?.type !== "workshop" || !d.module.id) return;
      const m = d.module;
      const key = `workshop:${m.id}:${JSON.stringify(m.params ?? {})}`;
      open({ key, title: d.title || "Workshop module", module: m });
      fetch(`${API_URL}/api/workshop/modules/${m.id}?count=false`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((x: { name?: string } | null) => x?.name && setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, title: x.name! } : t))), () => {});
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [open]);
  if (error) return <div className="p-8 text-sm text-bad">{error}</div>;
  if (!ws || !cfg) return <div className="p-8 text-sm text-muted">Loading the workspace…</div>;
  const navOut = cfg.general.navigationOutOfCarbon === "enabled";
  const links = cfg.general.externalLinks.length ? cfg.general.externalLinks : ws.org_external_links;
  const openShortcut = (s: Shortcut, anchored = false) => {
    if (s.module.type === "url" && /^https?:/.test(s.module.url ?? "")) {
      if (navOut) window.open(s.module.url, "_blank", "noopener");
      return;
    }
    open({ key: `${s.module.type}:${s.module.id ?? s.module.objectTypeId ?? s.module.url ?? s.title}:${s.module.pk ?? ""}`, title: s.title, module: s.module, icon: s.icon, color: s.color, anchored });
  };
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(ws.config);
  return (
    <div className="flex h-screen flex-col bg-ink text-sm">
      {/* menu bar */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
        <div className="relative">
          <button type="button" onClick={() => setNavOpen(!navOpen)} className="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-panel-2" title="Navigation Menu">
            <Icon name="grid" className="h-4 w-4 text-ocean" />
            <span className="font-semibold">{cfg.displayMetadata.title}</span>
            <Icon name="down" className="h-3 w-3 text-muted" />
          </button>
          {navOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-line bg-panel p-2 shadow-xl" onMouseLeave={() => setNavOpen(false)}>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted">Workspaces</div>
              {ws.navigation.map((w) => (
                <Link key={w.id} href={`/carbon/${w.id}`} className={`block rounded px-2 py-1.5 ${w.id === ws.id ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}>
                  {w.title}
                </Link>
              ))}
              {!ws.navigation.length && <div className="px-2 py-1 text-xs text-muted">No promoted workspaces</div>}
              {navOut && links.length > 0 && (
                <>
                  <div className="mt-1 border-t border-line px-2 py-1 pt-2 text-[10px] uppercase tracking-wider text-muted">Applications</div>
                  {links.map((l) => (
                    <a key={l.url} href={l.url} className="block rounded px-2 py-1.5 hover:bg-panel-2">
                      {l.title}
                    </a>
                  ))}
                </>
              )}
              {navOut && (
                <Link href="/" className="mt-1 block border-t border-line px-2 py-1.5 pt-2 text-xs text-muted hover:text-white">
                  Open the full platform
                </Link>
              )}
            </div>
          )}
        </div>
        <TabButton active={active === "home"} onClick={() => setActive("home")} icon="home" title="Home" />
        {cfg.moduleShortcuts.primary.map((s) => {
          const key = `${s.module.type}:${s.module.id ?? s.module.objectTypeId ?? s.module.url ?? s.title}:${s.module.pk ?? ""}`;
          return <TabButton key={key} active={active === key} onClick={() => openShortcut(s, true)} icon={(s.icon as IconName) || iconOf(s.module)} color={s.color} title={s.title} />;
        })}
        {tabs
          .filter((t) => !t.anchored)
          .map((t) => (
            <TabButton key={t.key} active={active === t.key} onClick={() => setActive(t.key)} icon={(t.icon as IconName) || iconOf(t.module)} color={t.color} title={t.title} onClose={() => (setTabs((x) => x.filter((y) => y.key !== t.key)), active === t.key && setActive("home"))} />
          ))}
        {cfg.moduleShortcuts.secondary.length > 0 && (
          <div className="relative">
            <button type="button" onClick={() => setMoreOpen(!moreOpen)} className="rounded px-2 py-1 text-muted hover:bg-panel-2" title="More modules">
              <Icon name="plus" className="h-4 w-4" />
            </button>
            {moreOpen && (
              <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-line bg-panel p-1 shadow-xl" onMouseLeave={() => setMoreOpen(false)}>
                {cfg.moduleShortcuts.secondary.map((s, i) => (
                  <button key={i} type="button" onClick={() => (openShortcut(s), setMoreOpen(false))} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-panel-2">
                    <span className="inline-flex shrink-0" style={{ color: s.color }}><Icon name={(s.icon as IconName) || iconOf(s.module)} className="h-3.5 w-3.5" /></span>
                    <span className="flex-1 truncate">{s.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          {preview && <span className="rounded bg-warn/15 px-2 py-0.5 text-[11px] text-warn">Previewing v{preview}</span>}
          <button type="button" onClick={() => setWhatsNew(true)} className="relative rounded px-2 py-1 text-muted hover:bg-panel-2" title="What's New">
            <Icon name="bell" className="h-4 w-4" />
            {updates.length > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warn" />}
          </button>
          {ws.can_edit && (
            <button type="button" onClick={() => setEditing(!editing)} className={`rounded px-2 py-1 ${editing ? "bg-ocean/15 text-white" : "text-muted hover:bg-panel-2"}`}>
              <Icon name="edit" className="mr-1 inline h-3.5 w-3.5" />
              Edit
            </button>
          )}
          <span className="px-2 text-xs text-muted">{me?.display_name ?? me?.username}</span>
          <button type="button" onClick={() => void signOut()} className="rounded px-2 py-1 text-xs text-muted hover:bg-panel-2">
            Sign out
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <div className={active === "home" ? "h-full overflow-auto" : "hidden"}>
            {cfg.homePage.type === "module" && cfg.homePage.module ? <ModuleFrame m={cfg.homePage.module} /> : <Home cfg={cfg} onOpen={open} />}
          </div>
          {[...cfg.moduleShortcuts.primary.map((s) => ({ key: `${s.module.type}:${s.module.id ?? s.module.objectTypeId ?? s.module.url ?? s.title}:${s.module.pk ?? ""}`, module: s.module })), ...tabs]
            .filter((t, i, all) => all.findIndex((x) => x.key === t.key) === i)
            .filter((t) => tabs.some((x) => x.key === t.key))
            .map((t) => (
              <div key={t.key} className={active === t.key ? "absolute inset-0" : "hidden"}>
                <ModuleFrame m={t.module} />
              </div>
            ))}
        </div>
        {editing && draft && (
          <Editor
            ws={ws}
            draft={draft}
            setDraft={setDraft}
            dirty={dirty}
            onSaved={() => (setPreview(null), setNonce((n) => n + 1))}
            onPreview={setPreview}
            onClose={() => setEditing(false)}
          />
        )}
      </div>
      {whatsNew && <WhatsNew ws={ws} updates={updates.length ? updates : (cfg.updates ?? []).filter((u) => !u.archived)} onClose={() => {
        if (updates.length) void carbon.seen(ws.id, updates.map((u) => u.id));
        setUpdates([]);
        setWhatsNew(false);
      }} />}
    </div>
  );
}

function TabButton({ active, onClick, icon, title, color, onClose }: { active: boolean; onClick: () => void; icon: IconName; title: string; color?: string; onClose?: () => void }) {
  return (
    <span className={`group flex items-center rounded ${active ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}>
      <button type="button" onClick={onClick} className="flex items-center gap-1.5 px-2.5 py-1">
        <span className="inline-flex shrink-0" style={color ? { color } : undefined}><Icon name={ICONS.includes(icon) || icon ? icon : "cube"} className="h-3.5 w-3.5" /></span>
        <span className="max-w-40 truncate">{title}</span>
      </button>
      {onClose && (
        <button type="button" onClick={onClose} className="pr-1.5 text-muted opacity-0 group-hover:opacity-100" aria-label={`Close ${title}`}>
          ✕
        </button>
      )}
    </span>
  );
}

function ModuleFrame({ m }: { m: ModuleRef }) {
  const src = moduleUrl(m);
  if (/^https?:/.test(src)) return <iframe src={src} className="h-full w-full border-0" title={m.title ?? m.type} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />;
  return <iframe src={src} className="h-full w-full border-0" title={m.title ?? m.type} data-carbon-module={m.type} />;
}

function Home({ cfg, onOpen }: { cfg: CarbonConfig; onOpen: (t: Tab) => void }) {
  const h = cfg.homePage.internal;
  const [q, setQ] = useState("");
  const [types, setTypes] = useState<{ id: string; name: string; count: number }[]>([]);
  useEffect(() => {
    fetch(`${API_URL}/api/workshop/sources`, { credentials: "include" })
      .then((r) => r.json())
      .then((s) => setTypes(s.object_types ?? []), () => {});
  }, []);
  const tname = (tid: string) => types.find((t) => t.id === tid)?.name ?? tid;
  const items = (sec: Section): { title: string; sub?: string; module: ModuleRef; icon?: string; color?: string }[] => {
    const c = sec.contents;
    if (c.type === "menuItems") return [...cfg.moduleShortcuts.primary, ...cfg.moduleShortcuts.secondary].map((s) => ({ title: s.title, sub: s.description, module: s.module, icon: s.icon, color: s.color }));
    if (c.type === "objectTypes") {
      const ids = c.objectTypes.length ? c.objectTypes : types.slice(0, 8).map((t) => t.id);
      return ids.map((tid) => ({ title: tname(tid), sub: `${types.find((t) => t.id === tid)?.count ?? ""} objects`, module: { type: "object_type", objectTypeId: tid } }));
    }
    return c.items.map((m) => ({ title: m.title || MODULE_LABEL[m.type], sub: MODULE_LABEL[m.type], module: m }));
  };
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-8">
      <div className="flex flex-col items-center gap-3 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {h.logo ? <img src={h.logo} alt="" style={{ maxWidth: 400, maxHeight: 80 }} /> : <Icon name="cube" className="h-10 w-10 text-ocean" />}
        {h.welcomeText && <h1 className="text-2xl font-semibold">{h.welcomeText}</h1>}
        {cfg.displayMetadata.description && <p className="text-muted">{cfg.displayMetadata.description}</p>}
        {!h.hideSearchBar && (
          <form
            className="w-full max-w-xl"
            onSubmit={(e) => {
              e.preventDefault();
              if (!q.trim()) return;
              onOpen({ key: `search:${q}`, title: `Search: ${q}`, module: { type: "search", query: q, objectTypeId: h.searchObjectTypes[0] } });
            }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${h.searchObjectTypes.length ? h.searchObjectTypes.map(tname).join(", ") : "objects"}…`} className={`${inputClass} text-sm`} />
          </form>
        )}
      </div>
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${Math.max(1, h.columns.length)}, minmax(0, 1fr))` }}>
        {h.columns.map((col, ci) => (
          <div key={ci} className="space-y-4">
            {col.sections.map((sec, si) => (
              <div key={si}>
                {sec.title && <div className="mb-1 text-xs uppercase tracking-wider text-muted">{sec.title}</div>}
                {sec.description && <p className="mb-2 text-xs text-muted">{sec.description}</p>}
                <div className={sec.displayAs === "CARD" ? "grid grid-cols-1 gap-2" : "space-y-0.5"}>
                  {items(sec).map((it, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => onOpen({ key: `${it.module.type}:${it.module.id ?? it.module.objectTypeId ?? it.module.url ?? it.title}:${it.module.pk ?? ""}`, title: it.title, module: it.module, icon: it.icon, color: it.color })}
                      className={sec.displayAs === "CARD" ? "flex items-center gap-3 rounded-lg border border-line bg-panel p-3 text-left hover:border-ocean" : "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-panel-2"}
                    >
                      <span className="inline-flex shrink-0" style={it.color ? { color: it.color } : undefined}><Icon name={(it.icon as IconName) || iconOf(it.module)} className={`h-4 w-4 shrink-0 ${it.color ? "" : "text-ocean"}`} /></span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{it.title}</span>
                        {it.sub && <span className="block truncate text-[11px] text-muted">{it.sub}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function WhatsNew({ ws, updates, onClose }: { ws: Workspace; updates: UpdatePage[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  const u = updates[i];
  return (
    <Modal title={`What's New in ${ws.title}`} icon="bell" onClose={onClose}>
      <div className="space-y-3 p-5 text-sm">
        {!u && <p className="text-muted">Nothing new.</p>}
        {u && (
          <>
            <div className="text-lg font-semibold">{u.title}</div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {u.media && <img src={u.media} alt="" className="max-h-64 rounded border border-line" />}
            {u.description && <p className="whitespace-pre-wrap text-soft">{u.description}</p>}
            {u.documentation && (
              <a href={u.documentation} target="_blank" rel="noreferrer" className="text-ocean hover:underline">
                Documentation
              </a>
            )}
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">
                {i + 1} / {updates.length}
              </span>
              <span className="flex gap-2">
                {i > 0 && (
                  <button type="button" onClick={() => setI(i - 1)} className={buttonClass.secondary}>
                    Back
                  </button>
                )}
                <button type="button" onClick={() => (i < updates.length - 1 ? setI(i + 1) : onClose())} className={buttonClass.primary}>
                  {i < updates.length - 1 ? "Next" : "Done"}
                </button>
              </span>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------------------------------------
 * the editing sidebar
 * --------------------------------------------------------------------------------------------- */

type Choices = { workshop: { id: string; name: string }[]; slate: { id: string; name: string }[]; object_type: { id: string; name: string }[]; notepad: { id: string; name: string }[]; map: { id: string; name: string }[]; vertex: { id: string; name: string }[] };

function useChoices(): Choices {
  const [c, setC] = useState<Choices>({ workshop: [], slate: [], object_type: [], notepad: [], map: [], vertex: [] });
  useEffect(() => {
    const get = (p: string) => fetch(API_URL + p, { credentials: "include" }).then((r) => (r.ok ? r.json() : []), () => []);
    void Promise.all([get("/api/workshop/modules"), get("/api/slate/apps"), get("/api/workshop/sources"), get("/api/notepad/documents"), get("/api/geo/maps"), get("/api/vertex/graphs")]).then(([w, s, src, n, m, v]) =>
      setC({
        workshop: (w ?? []).map((x: { id: string; name: string }) => ({ id: x.id, name: x.name })),
        slate: (s ?? []).map((x: { id: string; name: string }) => ({ id: x.id, name: x.name })),
        object_type: (src?.object_types ?? []).map((x: { id: string; name: string }) => ({ id: x.id, name: x.name })),
        notepad: (n ?? []).map((x: { id: string; name: string }) => ({ id: x.id, name: x.name })),
        map: (Array.isArray(m) ? m : (m?.maps ?? [])).map((x: { id: string; name?: string; title?: string }) => ({ id: x.id, name: x.name ?? x.title ?? x.id })),
        vertex: (Array.isArray(v) ? v : (v?.graphs ?? [])).map((x: { id: string; name?: string }) => ({ id: x.id, name: x.name ?? x.id })),
      }),
    );
  }, []);
  return c;
}

function ModulePicker({ value, onChange, choices }: { value: ModuleRef; onChange: (m: ModuleRef) => void; choices: Choices }) {
  const list = (choices as Record<string, { id: string; name: string }[]>)[value.type] ?? [];
  return (
    <div className="space-y-1">
      <select value={value.type} onChange={(e) => onChange({ type: e.target.value as ModuleType })} className={inputClass}>
        {(Object.keys(MODULE_LABEL) as ModuleType[]).map((t) => (
          <option key={t} value={t}>
            {MODULE_LABEL[t]}
          </option>
        ))}
      </select>
      {["workshop", "slate", "notepad", "map", "vertex"].includes(value.type) && (
        <select value={value.id ?? ""} onChange={(e) => onChange({ ...value, id: e.target.value, title: list.find((x) => x.id === e.target.value)?.name })} className={inputClass}>
          <option value="">Choose…</option>
          {list.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      )}
      {(value.type === "workshop" || value.type === "slate") && value.id && (
        <textarea
          defaultValue={Object.entries(value.params ?? {}).map(([k, v]) => `${k}=${v}`).join("\n")}
          onBlur={(e) => {
            const params = Object.fromEntries(e.target.value.split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2).map((x) => x.trim())).filter((kv) => kv[0] && kv[1] !== undefined));
            onChange({ ...value, params: Object.keys(params).length ? params : undefined });
          }}
          placeholder={value.type === "workshop" ? "Parameter values, one per line: faskes=RS-01 (an external ID), v.status=ditunda (a variable), page=p2" : "URL parameters, one per line: name=value"}
          rows={2}
          className={`${inputClass} font-mono text-xs`}
          data-module-params
        />
      )}
      {value.type === "quiver" && <input value={value.id ?? ""} onChange={(e) => onChange({ ...value, id: e.target.value })} placeholder="dashboard id" className={`${inputClass} font-mono`} />}
      {["object_type", "object_explorer", "object", "search"].includes(value.type) && (
        <select value={value.objectTypeId ?? ""} onChange={(e) => onChange({ ...value, objectTypeId: e.target.value })} className={inputClass}>
          <option value="">{value.type === "search" || value.type === "object_explorer" ? "All object types" : "Choose an object type…"}</option>
          {choices.object_type.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      )}
      {value.type === "object" && <input value={value.pk ?? ""} onChange={(e) => onChange({ ...value, pk: e.target.value })} placeholder="primary key" className={`${inputClass} font-mono`} />}
      {value.type === "search" && <input value={value.query ?? ""} onChange={(e) => onChange({ ...value, query: e.target.value })} placeholder="search text" className={inputClass} />}
      {(value.type === "url" || value.type === "developer_app") && <input value={value.url ?? ""} onChange={(e) => onChange({ ...value, url: e.target.value })} placeholder="https://… or /path" className={`${inputClass} font-mono`} />}
    </div>
  );
}

function ShortcutsEditor({ list, onChange, choices }: { list: Shortcut[]; onChange: (l: Shortcut[]) => void; choices: Choices }) {
  return (
    <div className="space-y-2">
      {list.map((s, i) => (
        <div key={i} className="space-y-1 rounded border border-line p-2">
          <div className="flex gap-1">
            <input value={s.title} onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} placeholder="Title" className={inputClass} />
            <input type="color" value={s.color ?? "#3b82f6"} onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} className="h-8 w-8 shrink-0 rounded border border-line-2 bg-transparent" title="Icon color" />
            <select value={s.icon ?? ""} onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, icon: e.target.value || undefined } : x)))} className={`${inputClass} w-24`} title="Icon">
              <option value="">auto</option>
              {ICONS.map((ic) => (
                <option key={ic}>{ic}</option>
              ))}
            </select>
          </div>
          <input value={s.description ?? ""} onChange={(e) => onChange(list.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} placeholder="Description" className={inputClass} />
          <ModulePicker value={s.module} onChange={(m) => onChange(list.map((x, j) => (j === i ? { ...x, module: m, title: x.title || m.title || "" } : x)))} choices={choices} />
          <div className="flex gap-2 text-[11px]">
            <button type="button" disabled={i === 0} onClick={() => onChange(list.map((x, j) => (j === i - 1 ? list[i] : j === i ? list[i - 1] : x)))} className="text-muted disabled:opacity-30">
              ↑
            </button>
            <button type="button" disabled={i === list.length - 1} onClick={() => onChange(list.map((x, j) => (j === i + 1 ? list[i] : j === i ? list[i + 1] : x)))} className="text-muted disabled:opacity-30">
              ↓
            </button>
            <button type="button" onClick={() => onChange(list.filter((_, j) => j !== i))} className="ml-auto text-muted hover:text-bad">
              Remove
            </button>
          </div>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...list, { title: "", module: { type: "workshop" } }])} className="text-xs text-ocean">
        + Add item
      </button>
    </div>
  );
}

function Editor({ ws, draft, setDraft, dirty, onSaved, onPreview, onClose }: { ws: Workspace; draft: CarbonConfig; setDraft: (c: CarbonConfig) => void; dirty: boolean; onSaved: () => void; onPreview: (v: number | null) => void; onClose: () => void }) {
  const [tab, setTab] = useState<"general" | "home" | "menu" | "access" | "updates" | "yaml" | "versions">("general");
  const [msg, setMsg] = useState<string | null>(null);
  const [yamlText, setYamlText] = useState<string | null>(null);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const choices = useChoices();
  useEffect(() => {
    fetch(`${API_URL}/api/auth/groups`, { credentials: "include" }).then((r) => (r.ok ? r.json() : []), () => []).then((g) => setGroups(Array.isArray(g) ? g : (g.groups ?? [])), () => {});
  }, []);
  const set = (fn: (c: CarbonConfig) => void) => {
    const c = structuredClone(draft);
    fn(c);
    setDraft(c);
  };
  const h = draft.homePage.internal;
  const save = async () => {
    try {
      if (tab === "yaml" && yamlText !== null) await carbon.putYaml(ws.id, yamlText, ws.version);
      else await carbon.save(ws.id, draft, ws.version);
      setMsg("Saved and published");
      setYamlText(null);
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const tabs = useMemo(() => ["general", "home", "menu", "access", "updates", "yaml", "versions"] as const, []);
  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-line bg-panel text-xs">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-semibold">Edit workspace</span>
        <button type="button" onClick={() => setTab("versions")} className="rounded border border-line-2 px-1.5 font-mono text-[11px]">
          v{ws.version}
          {dirty ? "*" : ""}
        </button>
        <button type="button" disabled={!dirty && yamlText === null} onClick={() => (setDraft(structuredClone(ws.config)), setYamlText(null))} className="ml-auto text-muted disabled:opacity-40">
          Discard
        </button>
        <button type="button" disabled={!dirty && yamlText === null} onClick={save} className={buttonClass.primary}>
          Save
        </button>
        <button type="button" onClick={onClose} className="text-muted hover:text-white" aria-label="Close the editor">
          ✕
        </button>
      </div>
      <div className="flex flex-wrap gap-1 border-b border-line px-2 py-1">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={async () => {
              setTab(t);
              if (t === "yaml") setYamlText(await carbon.yaml(ws.id));
            }}
            className={`rounded px-2 py-0.5 capitalize ${tab === t ? "bg-ocean/15 text-white" : "text-muted"}`}
          >
            {t === "yaml" ? "YAML" : t}
          </button>
        ))}
      </div>
      {msg && <p className="px-3 pt-2 text-muted">{msg}</p>}
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {tab === "general" && (
          <>
            <label className="block text-muted">
              Name
              <input value={draft.displayMetadata.title} onChange={(e) => set((c) => void (c.displayMetadata.title = e.target.value))} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-muted">
              Description
              <textarea value={draft.displayMetadata.description ?? ""} onChange={(e) => set((c) => void (c.displayMetadata.description = e.target.value))} rows={2} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-muted">
              Navigation out of Carbon
              <select value={draft.general.navigationOutOfCarbon} onChange={(e) => set((c) => void (c.general.navigationOutOfCarbon = e.target.value as "enabled" | "disabled"))} className={`${inputClass} mt-1`}>
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled (external links and the full platform hidden)</option>
              </select>
            </label>
            <div className={draft.general.navigationOutOfCarbon === "disabled" ? "opacity-40" : ""}>
              <div className="mb-1 text-muted">External links (override the organization&apos;s)</div>
              {draft.general.externalLinks.map((l, i) => (
                <div key={i} className="mb-1 flex gap-1">
                  <input value={l.title} onChange={(e) => set((c) => void (c.general.externalLinks[i].title = e.target.value))} placeholder="Title" className={inputClass} />
                  <input value={l.url} onChange={(e) => set((c) => void (c.general.externalLinks[i].url = e.target.value))} placeholder="https://…" className={`${inputClass} font-mono`} />
                  <button type="button" onClick={() => set((c) => void c.general.externalLinks.splice(i, 1))} className="text-muted hover:text-bad">
                    ✕
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => set((c) => void c.general.externalLinks.push({ title: "", url: "" }))} className="text-ocean">
                + Add link
              </button>
            </div>
            <div>
              <div className="mb-1 text-muted">Discoverable modules (Open in, from Object Explorer, for their object type)</div>
              {draft.general.discoverableModules.map((m, i) => (
                <div key={i} className="mb-2 rounded border border-line p-2">
                  <ModulePicker value={m} onChange={(nm) => set((c) => void (c.general.discoverableModules[i] = { ...nm, objectTypeId: nm.objectTypeId ?? m.objectTypeId }))} choices={choices} />
                  <select value={m.objectTypeId ?? ""} onChange={(e) => set((c) => void (c.general.discoverableModules[i].objectTypeId = e.target.value || undefined))} className={`${inputClass} mt-1`}>
                    <option value="">For every object type</option>
                    {choices.object_type.map((x) => (
                      <option key={x.id} value={x.id}>
                        For {x.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => set((c) => void c.general.discoverableModules.splice(i, 1))} className="mt-1 text-muted hover:text-bad">
                    Remove
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => set((c) => void c.general.discoverableModules.push({ type: "workshop" }))} className="text-ocean">
                + Add item
              </button>
            </div>
          </>
        )}
        {tab === "home" && (
          <>
            <label className="block text-muted">
              Home page
              <select value={draft.homePage.type} onChange={(e) => set((c) => void (c.homePage.type = e.target.value as "internal" | "module"))} className={`${inputClass} mt-1`}>
                <option value="internal">Carbon home page</option>
                <option value="module">A module</option>
              </select>
            </label>
            {draft.homePage.type === "module" ? (
              <ModulePicker value={draft.homePage.module ?? { type: "workshop" }} onChange={(m) => set((c) => void (c.homePage.module = m))} choices={choices} />
            ) : (
              <>
                <label className="block text-muted">
                  Logo (image URL or data URL)
                  <input value={h.logo ?? ""} onChange={(e) => set((c) => void (c.homePage.internal.logo = e.target.value || null))} className={`${inputClass} mt-1 font-mono`} />
                </label>
                <label className="block text-muted">
                  Welcome text
                  <input value={h.welcomeText ?? ""} onChange={(e) => set((c) => void (c.homePage.internal.welcomeText = e.target.value))} className={`${inputClass} mt-1`} />
                </label>
                <label className="flex items-center gap-2 text-muted">
                  <input type="checkbox" checked={!h.hideSearchBar} onChange={(e) => set((c) => void (c.homePage.internal.hideSearchBar = !e.target.checked))} /> Search bar
                </label>
                <label className="block text-muted">
                  Search these object types
                  <select multiple value={h.searchObjectTypes} onChange={(e) => set((c) => void (c.homePage.internal.searchObjectTypes = [...e.target.selectedOptions].map((o) => o.value)))} className={`${inputClass} mt-1 h-24`}>
                    {choices.object_type.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </label>
                {h.columns.map((col, ci) => (
                  <div key={ci} className="space-y-2 rounded border border-line p-2">
                    <div className="flex items-center text-muted">
                      Column {String.fromCharCode(65 + ci)}
                      <button type="button" onClick={() => set((c) => void c.homePage.internal.columns.splice(ci, 1))} className="ml-auto hover:text-bad">
                        Remove column
                      </button>
                    </div>
                    {col.sections.map((sec, si) => (
                      <div key={si} className="space-y-1 rounded bg-ink p-2">
                        <input value={sec.title ?? ""} onChange={(e) => set((c) => void (c.homePage.internal.columns[ci].sections[si].title = e.target.value))} placeholder="Section title" className={inputClass} />
                        <div className="flex gap-1">
                          <select value={sec.contents.type} onChange={(e) => set((c) => void (c.homePage.internal.columns[ci].sections[si].contents = e.target.value === "custom" ? { type: "custom", items: [] } : e.target.value === "objectTypes" ? { type: "objectTypes", objectTypes: [] } : { type: "menuItems" }))} className={inputClass}>
                            <option value="custom">Custom items</option>
                            <option value="objectTypes">Object types</option>
                            <option value="menuItems">All menu bar items</option>
                          </select>
                          <select value={sec.displayAs} onChange={(e) => set((c) => void (c.homePage.internal.columns[ci].sections[si].displayAs = e.target.value as "CARD" | "LIST"))} className={`${inputClass} w-24`}>
                            <option value="CARD">Cards</option>
                            <option value="LIST">List</option>
                          </select>
                        </div>
                        {sec.contents.type === "objectTypes" && (
                          <select multiple value={sec.contents.objectTypes} onChange={(e) => set((c) => void (c.homePage.internal.columns[ci].sections[si].contents = { type: "objectTypes", objectTypes: [...e.target.selectedOptions].map((o) => o.value) }))} className={`${inputClass} h-20`}>
                            {choices.object_type.map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.name}
                              </option>
                            ))}
                          </select>
                        )}
                        {sec.contents.type === "custom" &&
                          sec.contents.items.map((m, ii) => (
                            <div key={ii} className="rounded border border-line p-1">
                              <input value={m.title ?? ""} onChange={(e) => set((c) => void ((c.homePage.internal.columns[ci].sections[si].contents as { items: ModuleRef[] }).items[ii].title = e.target.value))} placeholder="Title" className={`${inputClass} mb-1`} />
                              <ModulePicker value={m} onChange={(nm) => set((c) => void ((c.homePage.internal.columns[ci].sections[si].contents as { items: ModuleRef[] }).items[ii] = { ...nm, title: m.title || nm.title }))} choices={choices} />
                            </div>
                          ))}
                        {sec.contents.type === "custom" && (
                          <button type="button" onClick={() => set((c) => void (c.homePage.internal.columns[ci].sections[si].contents as { items: ModuleRef[] }).items.push({ type: "workshop" }))} className="text-ocean">
                            + Add item
                          </button>
                        )}
                        <button type="button" onClick={() => set((c) => void c.homePage.internal.columns[ci].sections.splice(si, 1))} className="ml-2 text-muted hover:text-bad">
                          Remove section
                        </button>
                      </div>
                    ))}
                    <button type="button" onClick={() => set((c) => void c.homePage.internal.columns[ci].sections.push({ title: "", displayAs: "CARD", contents: { type: "custom", items: [] } }))} className="text-ocean">
                      + Add section
                    </button>
                  </div>
                ))}
                {h.columns.length < 4 && (
                  <button type="button" onClick={() => set((c) => void c.homePage.internal.columns.push({ sections: [] }))} className="text-ocean">
                    + Add column
                  </button>
                )}
              </>
            )}
          </>
        )}
        {tab === "menu" && (
          <>
            <div className="font-medium">Anchored tabs</div>
            <ShortcutsEditor list={draft.moduleShortcuts.primary} onChange={(l) => set((c) => void (c.moduleShortcuts.primary = l))} choices={choices} />
            <div className="pt-2 font-medium">More menu (+)</div>
            <ShortcutsEditor list={draft.moduleShortcuts.secondary} onChange={(l) => set((c) => void (c.moduleShortcuts.secondary = l))} choices={choices} />
          </>
        )}
        {tab === "access" && (
          <>
            <label className="flex items-center gap-2 text-muted">
              <input type="checkbox" checked={draft.access.promoted} onChange={(e) => set((c) => void (c.access.promoted = e.target.checked))} /> Promoted in the organization&apos;s Navigation Menu (administrators)
            </label>
            <label className="block text-muted">
              Default workspace for these groups
              <select multiple value={draft.access.defaultForGroups} onChange={(e) => set((c) => void (c.access.defaultForGroups = [...e.target.selectedOptions].map((o) => o.value)))} className={`${inputClass} mt-1 h-28`}>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-muted">
              <input type="checkbox" checked={draft.access.landing} onChange={(e) => set((c) => void (c.access.landing = e.target.checked))} /> Open this workspace instead of the platform home for those groups
            </label>
            <p className="text-muted">Who can open or edit the workspace comes from its Files item&apos;s Project roles and markings.</p>
          </>
        )}
        {tab === "updates" && (
          <>
            {draft.updates.map((u, i) => (
              <div key={u.id} className={`space-y-1 rounded border border-line p-2 ${u.archived ? "opacity-60" : ""}`}>
                <input value={u.title} onChange={(e) => set((c) => void (c.updates[i].title = e.target.value))} placeholder="Title (required)" className={inputClass} />
                <textarea value={u.description ?? ""} onChange={(e) => set((c) => void (c.updates[i].description = e.target.value))} placeholder="Description" rows={2} className={inputClass} />
                <input value={u.media ?? ""} onChange={(e) => set((c) => void (c.updates[i].media = e.target.value))} placeholder="Media (image URL)" className={`${inputClass} font-mono`} />
                <input value={u.documentation ?? ""} onChange={(e) => set((c) => void (c.updates[i].documentation = e.target.value))} placeholder="Documentation link" className={`${inputClass} font-mono`} />
                <div className="flex gap-2">
                  <button type="button" onClick={() => set((c) => void (c.updates[i].archived = !u.archived))} className="text-muted hover:text-white">
                    {u.archived ? "Unarchive" : "Archive"}
                  </button>
                  {u.archived && (
                    <button type="button" onClick={() => window.confirm("Delete this update permanently?") && set((c) => void c.updates.splice(i, 1))} className="text-muted hover:text-bad">
                      Delete permanently
                    </button>
                  )}
                </div>
              </div>
            ))}
            <button type="button" onClick={() => set((c) => void c.updates.push({ id: `u${Date.now().toString(36)}`, title: "" }))} className="text-ocean">
              + New update page
            </button>
          </>
        )}
        {tab === "yaml" && (
          <>
            <textarea value={yamlText ?? ""} onChange={(e) => setYamlText(e.target.value)} rows={30} className={`${inputClass} font-mono text-[11px]`} spellCheck={false} />
            <p className="text-muted">Save validates the YAML and publishes it as a new version.</p>
          </>
        )}
        {tab === "versions" && (
          <div className="space-y-1">
            {ws.versions.map((v) => (
              <div key={v.version} className="flex items-center gap-2 rounded border border-line px-2 py-1">
                <span className="font-mono">v{v.version}</span>
                <span className="flex-1 truncate text-muted">
                  {v.description || "Saved"} · {when(v.at)}
                </span>
                <button type="button" onClick={() => onPreview(v.version)} className="text-ocean">
                  Preview
                </button>
                {v.version !== ws.version && (
                  <button type="button" onClick={async () => (await carbon.republish(ws.id, v.version), onSaved())} className="text-ocean">
                    Republish
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={() => onPreview(null)} className="text-muted">
              Back to the latest
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
