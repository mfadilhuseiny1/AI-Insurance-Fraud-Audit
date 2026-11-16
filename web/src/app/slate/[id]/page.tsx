"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { SlateCanvas } from "@/components/slate/SlateCanvas";
import { EventsEditor, PANELS, SlatePanel, type Panel } from "@/components/slate/SlatePanels";
import { FolderSelect, ImportDialog } from "@/components/slate/SlateImport";
import { SlateViewer, urlParams, useSlateRuntime } from "@/components/slate/SlateView";
import type { SlateRuntime } from "@/lib/slateRuntime";
import { downloadProduct } from "@/components/ProductInstallDialog";
import { functions as fnRegistry, type FunctionRow } from "@/lib/actions";
import { api, type DriveItem } from "@/lib/api";
import { ontology, type ActionType } from "@/lib/ontology";
import {
  allNames,
  freshName,
  slate,
  SlateError,
  SLATE_WIDGETS,
  widgetSpec,
  type SlateAppSummary,
  type SlateConflict,
  type SlateDocument,
  type SlateSource,
  type SlateVersion,
  type SlateWidget,
  type SlateWidgetType,
} from "@/lib/slate";
import { merge, resolve, type Conflict } from "@/lib/slateMerge";
import { workshop, type ObjectTypeSource } from "@/lib/workshop";

export default function SlateAppPage() {
  return (
    <Suspense fallback={null}>
      <SlateApp />
    </Suspense>
  );
}

const CONTAINERS: SlateWidgetType[] = ["container", "tabs", "dialog"];

/** Find, update and remove widgets wherever they are (page, toolbar, inside containers). */
function mapWidgets(doc: SlateDocument, fn: (w: SlateWidget) => SlateWidget | null): SlateDocument {
  const walk = (ws: SlateWidget[]): SlateWidget[] =>
    ws.flatMap((w) => {
      const r = fn(w);
      if (!r) return [];
      return [{ ...r, ...(r.children ? { children: walk(r.children) } : {}) }];
    });
  return { ...doc, pages: doc.pages.map((p) => ({ ...p, widgets: walk(p.widgets) })), toolbar: walk(doc.toolbar) };
}
function findWidget(doc: SlateDocument, id: string): { w: SlateWidget; page: string | null; parent: string | null } | null {
  let out: { w: SlateWidget; page: string | null; parent: string | null } | null = null;
  const walk = (ws: SlateWidget[], page: string | null, parent: string | null) =>
    ws.forEach((w) => {
      if (w.id === id) out = { w, page, parent };
      walk(w.children ?? [], page, w.id);
    });
  doc.pages.forEach((p) => walk(p.widgets, p.id, null));
  walk(doc.toolbar, null, null);
  return out;
}

function SlateApp() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const editing = params.get("edit") === "1";
  const tag = params.get("$tag") ?? undefined;
  const versionParam = params.get("version") ? Number(params.get("version")) : undefined;
  const [app, setApp] = useState<SlateAppSummary | null>(null);
  const [doc, setDoc] = useState<SlateDocument | null>(null);
  const [version, setVersion] = useState(0);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const load = useCallback(async () => setNonce((n) => n + 1), []);
  useEffect(() => {
    let stale = false;
    (id.startsWith("sl-") ? slate.open(id, { version: versionParam, tag }) : slate.byPermalink(id, tag)).then(
      (r) => {
        if (stale) return;
        setApp(r.app);
        setDoc(r.document);
        setVersion(r.version);
        setCanEdit(r.can_edit);
        setError(null);
      },
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [id, versionParam, tag, nonce]);
  const viewRt = useRef<SlateRuntime | null>(null);
  const [shared, setShared] = useState<string | null>(null);
  if (error)
    return (
      <div className="p-8 text-sm">
        <p className="text-bad">{error}</p>
        <Link href="/slate" className="mt-2 inline-block text-ocean hover:underline">
          ← Slate applications
        </Link>
      </div>
    );
  if (!app || !doc) return <div className="p-8 text-sm text-muted">Loading…</div>;
  if (editing && canEdit) return <Editor key={`${app.id}:${version}`} app={app} initial={doc} initialVersion={version} onApp={setApp} reload={load} />;
  const unpublished = version !== app.published && !Object.values(app.tags ?? {}).includes(version);
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-4 py-1.5 text-xs">
        <Link href="/slate" className="text-muted hover:text-white">
          Slate
        </Link>
        <span className="text-muted">/</span>
        <span className="font-medium">{app.name}</span>
        <span className="text-muted">v{version}</span>
        <button
          type="button"
          onClick={async () => {
            // Actions → Get shareable view: the current state under a view id, the link copied
            try {
              const vid = await viewRt.current?.saveView();
              if (!vid) return;
              const u = new URL(window.location.href);
              u.searchParams.set("view", vid);
              await navigator.clipboard?.writeText(u.toString()).catch(() => {});
              window.history.replaceState(window.history.state, "", u.toString());
              setShared("Link copied");
            } catch (e) {
              setShared((e as Error).message);
            }
            setTimeout(() => setShared(null), 2500);
          }}
          className="ml-auto inline-flex items-center gap-1 rounded border border-line-2 px-2 py-0.5 hover:border-ocean"
          title="Save the current selections and variables as a view anyone with access can open"
          data-share-view
        >
          <Icon name="link" className="h-3 w-3" /> {shared ?? "Get shareable view"}
        </button>
        {canEdit && (
          <button type="button" onClick={() => router.push(`/slate/${app.id}?edit=1`)} className="inline-flex items-center gap-1 rounded border border-line-2 px-2 py-0.5 hover:border-ocean">
            <Icon name="edit" className="h-3 w-3" /> Edit
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <SlateViewer
          doc={doc}
          appId={app.id}
          banner={unpublished ? `You are viewing version ${version}, which is not published${version === app.latest ? " (the latest version)" : ""}.` : null}
          initialPage={params.get("page")}
          onRuntime={(r) => (viewRt.current = r)}
          onNavigate={(p) => {
            const q = new URLSearchParams(window.location.search);
            q.set("page", p);
            window.history.replaceState({}, "", `?${q}`);
          }}
        />
      </div>
    </div>
  );
}

type Props = { app: SlateAppSummary; initial: SlateDocument; initialVersion: number; onApp: (a: SlateAppSummary) => void; reload: () => Promise<void> };

function Editor({ app, initial, initialVersion, onApp, reload }: Props) {
  const router = useRouter();
  const [doc, setDocState] = useState<SlateDocument>(initial);
  const [base, setBase] = useState(initialVersion);
  const [baseDoc, setBaseDoc] = useState<SlateDocument>(initial);
  const [dirty, setDirty] = useState(false);
  const [pageId, setPageId] = useState(initial.pages[0].id);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [tab, setTab] = useState<"property" | "layout" | "json" | "events">("property");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [conflict, setConflict] = useState<SlateConflict | null>(null);
  const [dialog, setDialog] = useState<"versions" | "settings" | "saveas" | "import" | "search" | null>(null);
  const [undo, setUndo] = useState<{ label: string; doc: SlateDocument } | null>(null);
  const [preview, setPreview] = useState(false);
  const [sources, setSources] = useState<SlateSource[]>([]);
  const [objectTypes, setObjectTypes] = useState<ObjectTypeSource[]>([]);
  const [actions, setActions] = useState<ActionType[]>([]);
  const [fns, setFns] = useState<FunctionRow[]>([]);
  const publicApp = app.type === "public";
  useEffect(() => {
    slate.sources().then(setSources, () => {});
    if (!publicApp) {
      workshop.sources().then((s) => setObjectTypes(s.object_types), () => {});
      ontology.actionTypes().then(setActions, () => {});
      fnRegistry.list().then(setFns, () => {});
    }
  }, [publicApp]);
  const { rt, scope } = useSlateRuntime(doc, { key: `${app.id}:edit`, appId: app.id, isEditMode: true, publicApp, urlParams: urlParams() });
  const update = useCallback((fn: (d: SlateDocument) => SlateDocument) => {
    setDocState((d) => fn(d));
    setDirty(true);
  }, []);
  useEffect(() => {
    rt?.invalidate();
  }, [rt, doc]);
  // widgets that keep user changes in the document (a graph's node positions in Manual layout) write through here
  useEffect(() => {
    rt.setPersister((id, patch) => update((d) => mapWidgets(d, (x) => (x.id === id ? { ...x, props: { ...x.props, ...patch } } : x))));
    return () => rt.setPersister(undefined);
  }, [rt, update]);
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];
  const names = useMemo(() => allNames(doc).map((n) => n.name), [doc]);
  const sel = selected ? findWidget(doc, selected) : null;

  const save = useCallback(
    async (overwrite = false, document = doc, baseVersion = base) => {
      setSaving(true);
      setMsg(null);
      try {
        const r = await slate.save(app.id, document, baseVersion, overwrite);
        setBase(r.version);
        setBaseDoc(document);
        onApp(r.app);
        setDirty(false);
        setConflict(null);
        setMsg(`Saved version ${r.version}${r.app.published === r.version ? " (published)" : ""}`);
      } catch (e) {
        if (e instanceof SlateError && e.status === 409 && (e.detail as SlateConflict)?.code === "conflict") setConflict(e.detail as SlateConflict);
        else setMsg((e as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [app.id, base, doc, onApp],
  );

  // Ctrl+S saves, Ctrl+K searches, Ctrl+Z undoes the last deletion
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        void save();
      } else if (k === "k") {
        e.preventDefault();
        setDialog("search");
      } else if (k === "z" && undo && !(e.target as HTMLElement).closest("input,textarea")) {
        e.preventDefault();
        setDocState(undo.doc);
        setUndo(null);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [save, undo]);

  const addWidget = (type: SlateWidgetType, where: "page" | "toolbar" = "page") => {
    const spec = widgetSpec(type);
    const id = freshName(`w_${type}`, names);
    const y = Math.max(0, ...page.widgets.map((w) => w.y + w.h));
    const w: SlateWidget = { id, type, x: 0, y, w: spec.w, h: spec.h, props: structuredClone(spec.props), ...(CONTAINERS.includes(type) ? { children: [] } : {}) };
    const into = sel && CONTAINERS.includes(sel.w.type) && where === "page" ? sel.w.id : null;
    update((d) =>
      into
        ? mapWidgets(d, (x) => (x.id === into ? { ...x, children: [...(x.children ?? []), w] } : x))
        : where === "toolbar"
          ? { ...d, toolbar: [...d.toolbar, { ...w, w: 2, h: 1 }] }
          : { ...d, pages: d.pages.map((p) => (p.id === page.id ? { ...p, widgets: [...p.widgets, w] } : p)) },
    );
    setSelected(id);
  };
  const removeWidget = (id: string) => {
    setUndo({ label: `Deleted ${id}`, doc });
    update((d) => ({ ...mapWidgets(d, (x) => (x.id === id ? null : x)), events: d.events }));
    setSelected(null);
  };
  const patchWidget = (id: string, patch: Partial<SlateWidget>) => update((d) => mapWidgets(d, (x) => (x.id === id ? { ...x, ...patch } : x)));
  const renameWidget = (from: string, to: string) =>
    update((d) => {
      const next = mapWidgets(d, (x) => (x.id === from ? { ...x, id: to } : x));
      // events wired to the widget follow it
      return { ...next, events: next.events.map((e) => ({ ...e, trigger: e.trigger.startsWith(`${from}.`) ? to + e.trigger.slice(from.length) : e.trigger, action: e.action.startsWith(`${from}.`) ? to + e.action.slice(from.length) : e.action })) };
    });

  if (!rt) return null;
  if (preview)
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-4 py-1.5 text-xs">
          <span className="font-medium">{app.name}</span>
          <span className="text-muted">preview of the unsaved document</span>
          <button type="button" onClick={() => setPreview(false)} className="ml-auto rounded border border-line-2 px-2 py-0.5">
            Back to edit
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <SlateViewer doc={doc} appId={app.id} publicApp={publicApp} />
        </div>
      </div>
    );

  const ctx = { doc, update, rt, scope, sources, objectTypes, foundryFunctions: fns, names, publicApp };
  return (
    <div className="flex h-full flex-col text-sm">
      {/* action bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
        <Link href="/slate" className="text-xs text-muted hover:text-white">
          Slate
        </Link>
        <span className="text-muted">/</span>
        <span className="font-medium">{app.name}</span>
        {publicApp && <span className="rounded bg-warn/15 px-1.5 text-[10px] text-warn">public</span>}
        <button type="button" onClick={() => setDialog("versions")} className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-ocean hover:bg-panel-2" title="Versions">
          <Icon name="check" className="h-3 w-3" /> v{base}
          {app.published === base ? " · published" : app.published ? ` · v${app.published} published` : " · unpublished"}
        </button>
        <Menu
          label="File"
          items={[
            ["Export JSON", async () => {
              const j = await slate.exportJson(app.id);
              const a = document.createElement("a");
              a.href = URL.createObjectURL(new Blob([JSON.stringify(j, null, 2)], { type: "application/json" }));
              a.download = `${app.permalink}.slate.json`;
              a.click();
            }],
            ["Import JSON", () => setDialog("import")],
            ["Save as…", () => setDialog("saveas")],
            ["Settings", () => setDialog("settings")],
          ]}
        />
        <button type="button" onClick={() => setDialog("search")} className="rounded px-2 py-0.5 text-xs text-muted hover:bg-panel-2" title="Search (Ctrl+K)">
          <Icon name="search" className="h-3.5 w-3.5" />
        </button>
        <div className="ml-auto flex items-center gap-2">
          {msg && <span className="text-xs text-muted">{msg}</span>}
          {undo && (
            <span className="rounded bg-panel-2 px-2 py-0.5 text-xs">
              {undo.label} ·{" "}
              <button type="button" onClick={() => (setDocState(undo.doc), setUndo(null))} className="text-ocean">
                Undo
              </button>
            </span>
          )}
          <button type="button" className={buttonClass.secondary} title="Download a Marketplace product package of the published version (dependencies and parameters included)" data-package
            onClick={async () => {
              try {
                const lt = await slate.lint(app.id);
                if (lt.errors.length) throw new Error(lt.errors.map((e) => e.message).join("\n"));
                if (lt.warnings.length && !window.confirm(`Package with these notes?\n\n${lt.warnings.map((w) => `• ${w.message}`).join("\n")}`)) return;
                downloadProduct(await slate.package(app.id), "slate-product");
              } catch (e) {
                window.alert(`Cannot package: ${(e as Error).message}`);
              }
            }}>
            <Icon name="download" className="h-3.5 w-3.5" /> Package
          </button>
          <button type="button" onClick={() => setPreview(true)} className={buttonClass.secondary}>
            <Icon name="play" className="h-3.5 w-3.5" /> Preview
          </button>
          <button type="button" onClick={() => router.push(`/slate/${app.id}`)} className={buttonClass.secondary}>
            <Icon name="eye" className="h-3.5 w-3.5" /> View
          </button>
          <button type="button" disabled={saving} onClick={() => void save()} className={buttonClass.primary}>
            {saving ? "Saving…" : dirty ? "Save" : "Saved"}
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* widget list and pages */}
        <aside className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-line bg-panel">
          <div className="border-b border-line p-2">
            <div className="mb-1 flex items-center text-[11px] uppercase tracking-wider text-muted">
              Pages
              <button
                type="button"
                className="ml-auto text-ocean"
                onClick={() => {
                  const name = window.prompt("Page name");
                  if (!name || !/^[A-Za-z0-9_-]+$/.test(name) || doc.pages.some((p) => p.name === name)) return;
                  const pid = `page${Date.now().toString(36)}`;
                  update((d) => ({ ...d, pages: [...d.pages, { id: pid, name, widgets: [] }] }));
                  setPageId(pid);
                }}
              >
                +
              </button>
            </div>
            {doc.pages.map((p) => (
              <div key={p.id} className={`group flex items-center rounded px-2 py-0.5 text-xs ${p.id === page.id ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}>
                <button type="button" onClick={() => (setPageId(p.id), setSelected(null), rt.navigate(p.name))} className="flex-1 truncate text-left">
                  {p.name}
                </button>
                {doc.pages.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      setUndo({ label: `Deleted page ${p.name}`, doc });
                      update((d) => ({ ...d, pages: d.pages.filter((x) => x.id !== p.id) }));
                      setPageId(doc.pages.find((x) => x.id !== p.id)!.id);
                    }}
                    className="hidden text-muted hover:text-bad group-hover:block"
                    aria-label={`Delete page ${p.name}`}
                  >
                    <Icon name="trash" className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <div className="mb-1 text-[11px] uppercase tracking-wider text-muted">Widgets</div>
            <WidgetTree ws={doc.toolbar} label="Toolbar" selected={selected} onSelect={setSelected} />
            <WidgetTree ws={page.widgets} label="Canvas" selected={selected} onSelect={setSelected} />
            <div className="mb-1 mt-3 text-[11px] uppercase tracking-wider text-muted">Add widget{sel && CONTAINERS.includes(sel.w.type) ? ` into ${sel.w.id}` : ""}</div>
            {(["Text", "Control", "Chart", "Visualization", "Time", "Container", "Platform", "Advanced"] as const).map((g) => {
              const ws = SLATE_WIDGETS.filter((w) => w.group === g && !(publicApp && (g === "Platform" || w.type === "iframe")));
              if (!ws.length) return null;
              return (
                <div key={g} className="mb-1.5">
                  <div className="text-[10px] text-muted">{g}</div>
                  <div className="grid grid-cols-2 gap-1">
                    {ws.map((w) => (
                      <button key={w.type} type="button" onClick={() => addWidget(w.type)} className="flex items-center gap-1 rounded border border-line px-1.5 py-1 text-left text-[11px] hover:border-ocean" title={`Add ${w.label}`}>
                        <Icon name={w.icon} className="h-3 w-3 shrink-0 text-ocean" />
                        <span className="truncate">{w.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            <button type="button" onClick={() => addWidget("button", "toolbar")} className="mt-1 text-[11px] text-ocean">
              + Button in the toolbar
            </button>
          </div>
        </aside>
        {/* canvas and panels */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className={`min-h-0 flex-1 overflow-auto ${doc.styles.theme === "light" ? "foundry-light" : ""}`}>
            <SlateCanvas rt={rt} scope={scope} widgets={page.widgets} toolbar={doc.toolbar} editing selected={selected} onSelect={setSelected} onChange={patchWidget} />
          </div>
          <div className="flex shrink-0 gap-1 border-t border-line bg-panel px-2 py-1 text-xs">
            {PANELS.map(([k, l]) => (
              <button key={k} type="button" onClick={() => setPanel(panel === k ? null : k)} className={`rounded px-2 py-0.5 ${panel === k ? "bg-ocean/15 text-white" : "text-muted hover:bg-panel-2"}`}>
                {l}
              </button>
            ))}
          </div>
          {panel && (
            <div className="h-72 shrink-0 overflow-hidden border-t border-line bg-panel p-2">
              <SlatePanel panel={panel} ctx={ctx} />
            </div>
          )}
        </div>
        {/* widget editor */}
        <aside className="w-80 shrink-0 overflow-auto border-l border-line bg-panel">
          {sel ? (
            <WidgetEditor
              key={sel.w.id}
              w={sel.w}
              tab={tab}
              setTab={setTab}
              names={names}
              actions={actions}
              objectTypes={objectTypes}
              onPatch={(p) => patchWidget(sel.w.id, p)}
              onRename={(to) => (renameWidget(sel.w.id, to), setSelected(to))}
              onDelete={() => removeWidget(sel.w.id)}
              events={<EventsEditor ctx={ctx} onlyFor={sel.w.id} />}
              state={rt.widgetState[sel.w.id]}
            />
          ) : (
            <div className="space-y-2 p-4 text-xs text-muted">
              <p>Select a widget on the canvas or in the list to edit it.</p>
              <p>Every widget, query, function and variable has a unique name you reference with Handlebars: {"{{w_dropdown1.selectedValue}}"}, {"{{q_query1.name}}"}.</p>
              <p>Ctrl+S saves, Ctrl+K searches, Ctrl+Z undoes a deletion.</p>
            </div>
          )}
        </aside>
      </div>
      {dialog === "versions" && <VersionsDialog app={app} current={base} onApp={onApp} onClose={() => setDialog(null)} onReverted={async () => (setDialog(null), await reload())} latest={doc} />}
      {dialog === "settings" && <SettingsDialog app={app} sources={sources} onApp={onApp} onClose={() => setDialog(null)} />}
      {dialog === "saveas" && <SaveAsDialog app={app} onClose={() => setDialog(null)} />}
      {dialog === "import" && (
        <ImportDialog
          onClose={() => setDialog(null)}
          onImported={(r) => {
            setDialog(null);
            if (r.app.id === app.id) void reload();
            else router.push(`/slate/${r.app.id}?edit=1`);
          }}
        />
      )}
      {dialog === "search" && (
        <SearchDialog
          doc={doc}
          onClose={() => setDialog(null)}
          onPick={(n) => {
            setDialog(null);
            const f = findWidget(doc, n.name);
            if (f) {
              if (f.page) setPageId(f.page);
              setSelected(n.name);
            } else setPanel(n.kind === "query" ? "queries" : n.kind === "function" ? "functions" : n.kind.startsWith("variable") ? "variables" : "platform");
          }}
        />
      )}
      {conflict && (
        <ConflictDialog
          conflict={conflict}
          base={baseDoc}
          mine={doc}
          onClose={() => setConflict(null)}
          onDiscard={async () => (setConflict(null), await reload())}
          onOverwrite={() => void save(true)}
          onSaveAs={() => (setConflict(null), setDialog("saveas"))}
          onMerged={(merged) => {
            setDocState(merged);
            void save(false, merged, conflict.latest_version);
          }}
        />
      )}
    </div>
  );
}

function Menu({ label, items }: { label: string; items: [string, () => void | Promise<void>][] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="rounded px-2 py-0.5 text-xs text-muted hover:bg-panel-2">
        {label} ▾
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-40 rounded-md border border-line bg-panel py-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
          {items.map(([l, f]) => (
            <button key={l} type="button" onClick={() => (setOpen(false), void f())} className="block w-full px-3 py-1 text-left text-xs hover:bg-panel-2">
              {l}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function WidgetTree({ ws, label, selected, onSelect, depth = 0 }: { ws: SlateWidget[]; label?: string; selected: string | null; onSelect: (id: string) => void; depth?: number }) {
  if (!ws.length && label === "Toolbar") return null;
  return (
    <div className={label ? "mb-2" : ""}>
      {label && <div className="text-[10px] text-muted">{label}</div>}
      {ws.map((w) => (
        <div key={w.id}>
          <button type="button" onClick={() => onSelect(w.id)} style={{ paddingLeft: 8 + depth * 12 }} className={`flex w-full items-center gap-1.5 rounded py-0.5 pr-2 text-left font-mono text-[11px] ${selected === w.id ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}>
            <Icon name={widgetSpec(w.type).icon} className="h-3 w-3 shrink-0 text-muted" />
            <span className="truncate">{w.id}</span>
          </button>
          {w.children && <WidgetTree ws={w.children} selected={selected} onSelect={onSelect} depth={depth + 1} />}
        </div>
      ))}
    </div>
  );
}

function JsonField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const isText = typeof value === "string";
  const [text, setText] = useState(isText ? (value as string) : JSON.stringify(value, null, 1));
  const [bad, setBad] = useState(false);
  return (
    <textarea
      value={text}
      rows={isText ? Math.min(6, Math.max(1, text.split("\n").length)) : Math.min(8, Math.max(1, text.split("\n").length))}
      onChange={(e) => {
        setText(e.target.value);
        if (isText) onChange(e.target.value);
        else
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
      }}
      className={`${inputClass} font-mono text-[11px] ${bad ? "border-bad" : ""}`}
      spellCheck={false}
    />
  );
}

function WidgetEditor({
  w,
  tab,
  setTab,
  names,
  actions,
  objectTypes,
  onPatch,
  onRename,
  onDelete,
  events,
  state,
}: {
  w: SlateWidget;
  tab: "property" | "layout" | "json" | "events";
  setTab: (t: "property" | "layout" | "json" | "events") => void;
  names: string[];
  actions: ActionType[];
  objectTypes: ObjectTypeSource[];
  onPatch: (p: Partial<SlateWidget>) => void;
  onRename: (to: string) => void;
  onDelete: () => void;
  events: React.ReactNode;
  state?: Record<string, unknown>;
}) {
  const spec = widgetSpec(w.type);
  const [name, setName] = useState(w.id);
  const [json, setJson] = useState(() => JSON.stringify({ ...w, children: undefined }, null, 2));
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const badName = name !== w.id && (names.includes(name) || !/^[A-Za-z_$][\w$]*$/.test(name));
  return (
    <div className="text-xs">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Icon name={spec.icon} className="h-4 w-4 text-ocean" />
        <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => (!badName && name !== w.id ? onRename(name) : setName(w.id))} className={`${inputClass} font-mono ${badName ? "border-bad" : ""}`} />
        <button type="button" onClick={onDelete} className="text-muted hover:text-bad" title="Delete (Ctrl+Z undoes)">
          <Icon name="trash" className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex gap-1 border-b border-line px-2 py-1">
        {(["property", "layout", "json", "events"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={`rounded px-2 py-0.5 capitalize ${tab === t ? "bg-ocean/15 text-white" : "text-muted"}`}>
            {t === "json" ? "JSON" : t}
          </button>
        ))}
      </div>
      <div className="space-y-2.5 p-3">
        {tab === "property" && (
          <>
            {w.type === "action" && (
              <label className="block text-muted">
                Action type
                <select value={String(w.props.actionTypeId ?? "")} onChange={(e) => onPatch({ props: { ...w.props, actionTypeId: e.target.value } })} className={`${inputClass} mt-1`}>
                  <option value="">Choose…</option>
                  {actions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.display_name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {w.type === "objectcard" && (
              <label className="block text-muted">
                Object type
                <select value={String(w.props.objectTypeId ?? "")} onChange={(e) => onPatch({ props: { ...w.props, objectTypeId: e.target.value } })} className={`${inputClass} mt-1`}>
                  <option value="">Choose…</option>
                  {objectTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {Object.entries(w.props)
              .filter(([k]) => !(w.type === "action" && k === "actionTypeId") && !(w.type === "objectcard" && k === "objectTypeId"))
              .map(([k, v]) => (
                <label key={k} className="block text-muted">
                  {k}
                  <div className="mt-1">
                    <JsonField value={v} onChange={(nv) => onPatch({ props: { ...w.props, [k]: nv } })} />
                  </div>
                </label>
              ))}
            {spec.state.length > 0 && (
              <div className="rounded bg-ink p-2 text-[10px] text-muted">
                State you can reference: {spec.state.map((s) => `{{${w.id}.${s}}}`).join(", ")}
                {state && <pre className="mt-1 max-h-24 overflow-auto font-mono text-soft">{JSON.stringify(state, null, 1)}</pre>}
              </div>
            )}
            <p className="text-[10px] text-muted">Text values may hold Handlebars; a value that is just {"{{x}}"} keeps its type (arrays for values, data…).</p>
          </>
        )}
        {tab === "layout" && (
          <>
            <div className="grid grid-cols-4 gap-1.5">
              {(["x", "y", "w", "h"] as const).map((k) => (
                <label key={k} className="text-muted">
                  {k}
                  <input type="number" value={w[k]} min={k === "w" || k === "h" ? 1 : 0} max={k === "x" || k === "w" ? 12 : undefined} onChange={(e) => onPatch({ [k]: Math.max(k === "w" || k === "h" ? 1 : 0, Number(e.target.value) || 0) })} className={`${inputClass} mt-1`} />
                </label>
              ))}
            </div>
            <label className="block text-muted">
              Inline CSS
              <textarea value={w.css ?? ""} onChange={(e) => onPatch({ css: e.target.value })} rows={3} placeholder="background: #102030; border-radius: 8px;" className={`${inputClass} mt-1 font-mono text-[11px]`} />
            </label>
            <label className="block text-muted">
              CSS classes (styled by the global stylesheet)
              <input value={w.classes ?? ""} onChange={(e) => onPatch({ classes: e.target.value })} className={`${inputClass} mt-1 font-mono`} />
            </label>
            <label className="block text-muted">
              Hidden when (Handlebars)
              <input value={w.hidden ?? ""} onChange={(e) => onPatch({ hidden: e.target.value })} placeholder="{{v_hideDetails}}" className={`${inputClass} mt-1 font-mono`} />
            </label>
          </>
        )}
        {tab === "json" && (
          <>
            <textarea
              value={json}
              onChange={(e) => {
                setJson(e.target.value);
                try {
                  JSON.parse(e.target.value);
                  setJsonErr(null);
                } catch (ex) {
                  setJsonErr((ex as Error).message);
                }
              }}
              rows={18}
              className={`${inputClass} font-mono text-[11px]`}
              spellCheck={false}
            />
            {jsonErr && <p className="text-bad">{jsonErr}</p>}
            <button
              type="button"
              disabled={!!jsonErr || json === JSON.stringify({ ...w, children: undefined }, null, 2)}
              onClick={() => {
                const v = JSON.parse(json) as SlateWidget;
                onPatch({ props: v.props ?? {}, x: v.x, y: v.y, w: v.w, h: v.h, css: v.css, classes: v.classes, hidden: v.hidden });
              }}
              className={buttonClass.primary}
            >
              Update
            </button>
          </>
        )}
        {tab === "events" && (
          <div className="h-[60vh]">
            <p className="mb-1 text-[10px] text-muted">Events: {spec.events.map((e) => `${w.id}.${e}`).join(", ") || "none"} · Actions: {spec.actions.map((a) => `${w.id}.${a}`).join(", ") || "none"}</p>
            {events}
          </div>
        )}
      </div>
    </div>
  );
}

function VersionsDialog({ app, current, onApp, onClose, onReverted, latest }: { app: SlateAppSummary; current: number; onApp: (a: SlateAppSummary) => void; onClose: () => void; onReverted: () => void; latest: SlateDocument }) {
  const [list, setList] = useState<SlateVersion[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ v: number; changes: string[] } | null>(null);
  const reload = useCallback(() => slate.versions(app.id).then(setList, (e: Error) => setErr(e.message)), [app.id]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const act = async (f: () => Promise<SlateAppSummary>) => {
    try {
      onApp(await f());
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal title="Versions" icon="history" onClose={onClose}>
      <div className="space-y-2 p-4 text-xs">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={app.auto_publish} disabled={app.type === "public"} onChange={(e) => act(() => slate.settings(app.id, { auto_publish: e.target.checked }))} /> Always publish when saving
          {app.type === "public" && <span className="text-muted">(public applications are published by hand)</span>}
        </label>
        {err && <p className="text-bad">{err}</p>}
        <div className="max-h-[50vh] overflow-auto rounded border border-line">
          {(list ?? []).map((v) => (
            <div key={v.version} className="flex items-center gap-2 border-t border-line px-3 py-1.5 first:border-0">
              <span className={`w-10 font-mono ${v.version === current ? "text-white" : "text-muted"}`}>v{v.version}</span>
              {v.published && <span className="rounded bg-ok/15 px-1.5 text-ok">published</span>}
              {v.tags.map((t) => (
                <span key={t} className="rounded bg-ocean/15 px-1.5 text-ocean">
                  {t}{" "}
                  <button type="button" onClick={() => act(() => slate.untag(app.id, t))} aria-label={`Remove tag ${t}`}>
                    ✕
                  </button>
                </span>
              ))}
              <span className="truncate text-muted">
                {v.saved_by_name} · {new Date(v.saved_at).toLocaleString()} {v.message ? `· ${v.message}` : ""}
              </span>
              <span className="ml-auto flex shrink-0 gap-2">
                <a href={`/slate/${app.id}?version=${v.version}`} target="_blank" className="text-ocean" rel="noreferrer">
                  View
                </a>
                <button type="button" className="text-ocean" onClick={async () => {
                  const r = await slate.open(app.id, { version: v.version });
                  setDiff({ v: v.version, changes: diffLabels(r.document, latest) });
                }}>
                  Compare
                </button>
                {!v.published && (
                  <button type="button" className="text-ocean" onClick={() => act(() => slate.publish(app.id, v.version))}>
                    Publish
                  </button>
                )}
                {v.published && (
                  <button type="button" className="text-warn" onClick={() => act(() => slate.unpublish(app.id))}>
                    Unpublish
                  </button>
                )}
                <button type="button" className="text-ocean" onClick={() => {
                  const t = window.prompt("Tag name (not published)");
                  if (t) void act(() => slate.tag(app.id, t, v.version));
                }}>
                  Tag
                </button>
                {v.version !== current && (
                  <button type="button" className="text-ocean" onClick={async () => {
                    await slate.revert(app.id, v.version);
                    onReverted();
                  }}>
                    Revert
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
        {diff && (
          <div className="rounded border border-line p-2">
            <div className="mb-1 font-medium">v{diff.v} compared with the open document</div>
            {diff.changes.length ? diff.changes.map((c) => <div key={c} className="font-mono text-[11px]">{c}</div>) : <p className="text-muted">No differences.</p>}
          </div>
        )}
        <p className="text-muted">Viewers open the published version, or a tagged one with ?$tag=name.</p>
      </div>
    </Modal>
  );
}

/** What changed between two documents, per element (added, removed, changed). */
function diffLabels(a: SlateDocument, b: SlateDocument): string[] {
  const out: string[] = [];
  const elems = (d: SlateDocument) => new Map([...merge(d, d, d).values].map(([k, v]) => [k, JSON.stringify(v)]));
  const ka = elems(a);
  const kb = elems(b);
  for (const k of new Set([...ka.keys(), ...kb.keys()])) {
    if (!ka.has(k)) out.push(`+ ${k}`);
    else if (!kb.has(k)) out.push(`- ${k}`);
    else if (ka.get(k) !== kb.get(k)) out.push(`~ ${k}`);
  }
  return out;
}

function SettingsDialog({ app, sources, onApp, onClose }: { app: SlateAppSummary; sources: SlateSource[]; onApp: (a: SlateAppSummary) => void; onClose: () => void }) {
  const [name, setName] = useState(app.name);
  const [permalink, setPermalink] = useState(app.permalink);
  const [chosen, setChosen] = useState<string[]>(app.sources ?? []);
  const [err, setErr] = useState<string | null>(null);
  const [folders, setFolders] = useState<DriveItem[]>([]);
  const [channel, setChannel] = useState({ id: `${app.permalink}-upload`, folder: "" });
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    if (app.type === "public") api.drive.folder(null).then((f) => setFolders(f.items.filter((i) => i.kind === "project" || i.kind === "folder")), () => {});
  }, [app.type]);
  const save = async () => {
    try {
      onApp(await slate.settings(app.id, { name, permalink, sources: chosen }));
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const external = sources.filter((s) => s.kind === "http_json");
  return (
    <Modal title="Application settings" icon="sliders" onClose={onClose}>
      <div className="space-y-3 p-4 text-xs">
        <label className="block text-muted">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} mt-1`} />
        </label>
        <label className="block text-muted">
          Permalink (/slate/<span className="font-mono">{permalink}</span>
          {app.type === "public" ? <> · public link /s/slate/{permalink}</> : null})
          <input value={permalink} onChange={(e) => setPermalink(e.target.value.toLowerCase())} className={`${inputClass} mt-1 font-mono`} />
        </label>
        {app.type !== "public" && (
          <div>
            <div className="mb-1 text-muted">Data Connection REST API sources HTTP JSON queries may call</div>
            {external.length === 0 && <p className="text-muted">No REST API sources in Data Connection.</p>}
            {external.map((s) => (
              <label key={s.id} className="flex items-center gap-2">
                <input type="checkbox" checked={chosen.includes(s.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, s.id] : chosen.filter((x) => x !== s.id))} /> {s.name} <span className="text-muted">{s.domains?.join(", ")}</span>
              </label>
            ))}
          </div>
        )}
        {app.type === "public" && (
          <div className="space-y-1.5 rounded border border-line p-2">
            <div className="font-medium">Secure upload</div>
            <p className="text-muted">A channel sends anonymous uploads (JSON blobs, one file each) into a folder; a token (with an expiry and a count) lets the public application upload through the secure-upload query source.</p>
            <div className="flex gap-1">
              <input value={channel.id} onChange={(e) => setChannel({ ...channel, id: e.target.value })} className={`${inputClass} font-mono`} />
              <select value={channel.folder} onChange={(e) => setChannel({ ...channel, folder: e.target.value })} className={inputClass}>
                <option value="">Folder…</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={!channel.folder}
              className={buttonClass.secondary}
              onClick={async () => {
                try {
                  await slate.putChannel(app.id, { channel_id: channel.id, folder_id: channel.folder });
                  const t = await slate.createToken(app.id, { channel: channel.id, expiry: new Date(Date.now() + 30 * 86400_000).toISOString(), count: 1000 });
                  setToken(t.token);
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              Create channel and a token (30 days, 1,000 uploads)
            </button>
            {token && <p className="break-all font-mono text-ok">{token}</p>}
          </div>
        )}
        {err && <p className="text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" onClick={save} className={buttonClass.primary}>
            Save settings
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SaveAsDialog({ app, onClose }: { app: SlateAppSummary; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(`${app.name} copy`);
  const [folder, setFolder] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="Save as" icon="copy" onClose={onClose}>
      <div className="space-y-2 p-4 text-xs">
        <p className="text-muted">A new application with the latest saved version as v1 (save first to include unsaved changes).</p>
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        <FolderSelect value={folder} onChange={setFolder} />
        {err && <p className="text-bad">{err}</p>}
        <button
          type="button"
          className={buttonClass.primary}
          onClick={async () => {
            try {
              const r = await slate.saveAs(app.id, { name, folder_id: folder });
              router.push(`/slate/${r.app.id}?edit=1`);
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Save as
        </button>
      </div>
    </Modal>
  );
}

function SearchDialog({ doc, onClose, onPick }: { doc: SlateDocument; onClose: () => void; onPick: (n: { name: string; kind: string }) => void }) {
  const [q, setQ] = useState("");
  const all = useMemo(() => allNames(doc), [doc]);
  const recent = useMemo<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("slate.search.recent") ?? "[]");
    } catch {
      return [];
    }
  }, []);
  const hits = (q ? all.filter((n) => n.name.toLowerCase().includes(q.toLowerCase())) : [...all].sort((a, b) => recent.indexOf(b.name) - recent.indexOf(a.name))).slice(0, 30);
  const pick = (n: { name: string; kind: string }) => {
    try {
      localStorage.setItem("slate.search.recent", JSON.stringify([n.name, ...recent.filter((r) => r !== n.name)].slice(0, 20)));
    } catch {}
    onPick(n);
  };
  return (
    <Modal title="Search" icon="search" onClose={onClose}>
      <div className="p-3 text-xs">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && hits[0] && pick(hits[0])} placeholder="Widgets, queries, functions, objects, variables…" className={inputClass} />
        <div className="mt-2 max-h-80 overflow-auto">
          {hits.map((n) => (
            <button key={n.name} type="button" onClick={() => pick(n)} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-panel-2">
              <span className="font-mono">{n.name}</span>
              <span className="text-muted">{n.kind}</span>
              {"page" in n && n.page ? <span className="ml-auto text-muted">{String(n.page)}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function ConflictDialog({
  conflict,
  base,
  mine,
  onClose,
  onDiscard,
  onOverwrite,
  onSaveAs,
  onMerged,
}: {
  conflict: SlateConflict;
  base: SlateDocument;
  mine: SlateDocument;
  onClose: () => void;
  onDiscard: () => void;
  onOverwrite: () => void;
  onSaveAs: () => void;
  onMerged: (d: SlateDocument) => void;
}) {
  const result = useMemo(() => merge(conflict.base ?? base, mine, conflict.latest), [conflict, base, mine]);
  const [mode, setMode] = useState<"choose" | "merge" | "preview">("choose");
  const [items, setItems] = useState<Conflict[]>(result.conflicts.map((c) => ({ ...c, resolved: c.theirs })));
  const [sel, setSel] = useState(0);
  const [text, setText] = useState(() => JSON.stringify(result.conflicts[0]?.theirs ?? null, null, 2));
  const final = useMemo(() => resolve(result.values, items), [result, items]);
  const cur = items[sel];
  const pickConflict = (i: number) => {
    setSel(i);
    setText(JSON.stringify(items[i].resolved ?? null, null, 2));
  };
  return (
    <Modal title="Someone saved a newer version" icon="alert" onClose={onClose}>
      <div className="space-y-3 p-4 text-xs">
        <p>{conflict.message}.</p>
        {mode === "choose" && (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onDiscard} className={buttonClass.secondary}>
              Discard my changes
            </button>
            <button type="button" onClick={onOverwrite} className={buttonClass.secondary}>
              Overwrite theirs
            </button>
            <button type="button" onClick={onSaveAs} className={buttonClass.secondary}>
              Save with a different name
            </button>
            <button type="button" onClick={() => setMode(result.conflicts.length ? "merge" : "preview")} className={buttonClass.primary}>
              Merge… {result.conflicts.length ? `(${result.conflicts.length} conflict${result.conflicts.length > 1 ? "s" : ""})` : "(no conflicts)"}
            </button>
          </div>
        )}
        {mode === "merge" && cur && (
          <div className="flex gap-3">
            <div className="w-48 shrink-0 space-y-0.5">
              {items.map((c, i) => (
                <button key={c.key} type="button" onClick={() => pickConflict(i)} className={`block w-full truncate rounded px-2 py-1 text-left ${i === sel ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}>
                  {c.done ? "✓ " : <span className="text-warn">Conflict </span>}
                  {c.label}
                </button>
              ))}
            </div>
            <div className="grid min-w-0 flex-1 grid-cols-3 gap-2">
              <div>
                <div className="mb-1 text-muted">Their changes</div>
                <pre className="h-56 overflow-auto rounded bg-ink p-2 font-mono text-[10px]">{JSON.stringify(cur.theirs ?? "(deleted)", null, 2)}</pre>
                <button type="button" className="mt-1 text-ocean" onClick={() => setText(JSON.stringify(cur.theirs ?? null, null, 2))}>
                  Use theirs
                </button>
              </div>
              <div>
                <div className="mb-1 text-muted">Merge result</div>
                <textarea value={text} onChange={(e) => setText(e.target.value)} className={`${inputClass} h-56 font-mono text-[10px]`} spellCheck={false} />
                <button
                  type="button"
                  className="mt-1 text-ok"
                  onClick={() => {
                    try {
                      const v = JSON.parse(text);
                      setItems(items.map((c, i) => (i === sel ? { ...c, resolved: v === null ? undefined : v, done: true } : c)));
                    } catch {
                      window.alert("The merge result is not valid JSON");
                    }
                  }}
                >
                  Mark as resolved
                </button>
              </div>
              <div>
                <div className="mb-1 text-muted">Your changes</div>
                <pre className="h-56 overflow-auto rounded bg-ink p-2 font-mono text-[10px]">{JSON.stringify(cur.mine ?? "(deleted)", null, 2)}</pre>
                <button type="button" className="mt-1 text-ocean" onClick={() => setText(JSON.stringify(cur.mine ?? null, null, 2))}>
                  Use mine
                </button>
              </div>
            </div>
          </div>
        )}
        {mode === "merge" && (
          <button type="button" disabled={items.some((c) => !c.done)} onClick={() => setMode("preview")} className={buttonClass.primary}>
            Preview the final result
          </button>
        )}
        {mode === "preview" && (
          <>
            <div className="h-[45vh] overflow-auto rounded border border-line">
              <SlateViewer doc={final} appId={null} />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setMode(result.conflicts.length ? "merge" : "choose")} className={buttonClass.secondary}>
                Make changes
              </button>
              <button type="button" onClick={() => onMerged(final)} className={buttonClass.primary}>
                Accept and save
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
