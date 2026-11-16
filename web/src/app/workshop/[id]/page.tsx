"use client";

import { CustomWidgetConfig } from "@/components/workshop/CustomWidgetHost";
import Link from "next/link";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { API_URL } from "@/lib/api";
import { AppHeader, Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { type ModuleState } from "@/components/workshop/WidgetView";
import { Canvas, COLS, DRAG_TYPE } from "@/components/workshop/Canvas";
import { initialVariables, pageWidgets, readStateParam, stateLink, useModuleRuntime } from "@/components/workshop/ModuleRuntime";
import { CommonWidgetConfig, EventsEditor, NewWidgetConfig, NO_SOURCE } from "@/components/workshop/WorkshopConfig";
import { VariablesEditor } from "@/components/workshop/VariablesEditor";
import { VIZ_TYPES, VizWidgetConfig } from "@/components/workshop/VizWidgets";
import { AIP_TYPES, AipWidgetConfig } from "@/components/workshop/AipWidgets";
import { FreshnessConfig, KioskLaunch, ProfilerBanner, ProfilerPanel, REDACT_CSS, savedColorsCss, SettingsPanel, TranslationsPanel } from "@/components/workshop/ModuleSettings";
import { profilerOn } from "@/lib/workshopProfiler";
import { CommandsSettings, CrossAppConfig } from "@/components/workshop/CrossApp";
import { NotepadWidgetConfig } from "@/components/workshop/NotepadWidgets";
import { GraphWidgetConfig } from "@/components/workshop/GraphWidgets";
import { SchedulingWidgetConfig } from "@/components/workshop/SchedulingWidgets";
import { ProgramSchedulingConfig } from "@/components/workshop/ProgramScheduling";
import { RulesWidgetConfig } from "@/components/workshop/RulesWidgets";
import { VulcanWidgetConfig } from "@/components/workshop/VulcanWidget";
import { FormEmbedConfig } from "@/components/workshop/FormWidgets";
import { ScenarioConfig } from "@/components/workshop/ScenarioWidgets";
import { isMobile, MOBILE_CSS, MOBILE_TYPES, MobileNavBar, MobileWidgetConfig, PHONE } from "@/components/workshop/MobileWidgets";
import { BranchControl, ChangelogPanel, MoveDialog, PlatformSettings } from "@/components/workshop/PlatformPanels";
import { FILTER_TYPES, FilterWidgetConfig, UnionTypesPicker } from "@/components/workshop/FilterWidgets";
import { MarkdownConfig, OBJECT_TYPES, ObjectWidgetConfig } from "@/components/workshop/ObjectWidgets";
import { MEDIA_TYPES, MediaWidgetConfig } from "@/components/workshop/MediaWidgets";
import { applyTemplate, BackgroundField, clipOf, descendants, HeaderSettings, ModuleHeaderBar, Outline, PaddingField, paste, readClip, reorder, TEMPLATES, writeClip } from "@/components/workshop/LayoutTools";
import { TsWidgetConfig } from "@/components/workshop/TsWidgetConfig";
import { TsColumnsConfig, TsMetricFormatConfig } from "@/components/workshop/TsFormatting";
import { FunctionColumnConfig, FunctionWidgetConfig } from "@/components/workshop/FunctionWidgetConfig";
import { InterfaceActionConfig } from "@/components/workshop/InterfaceActionConfig";
import { ontology, type ActionType } from "@/lib/ontology";
import {
  backgroundOf,
  enterGlobalBranch,
  globalBranches,
  leaveGlobalBranch,
  METRIC_LABEL,
  paddingOf,
  sourceKey,
  unionColumns,
  WIDGETS,
  widgetInfo,
  workshop,
  type BranchContext,
  type Column,
  type Filter,
  type Metric,
  type Module,
  type ModuleVersion,
  type SectionLayout,
  type SourceRef,
  type Sources,
  type Widget,
  type WidgetConfig,
  type WidgetType,
} from "@/lib/workshop";


/**
 * The module runs on a global branch: objects and actions use the branch's data (edits never reach main), functions
 * run the branch's "Branched pre-release" versions. Newer function versions on main can be rebased onto; a version
 * target main released meanwhile needs a new one before the branch can merge.
 */
function BranchRuntimeBar({ ctx, onChanged }: { ctx: BranchContext; onChanged: (c: BranchContext) => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fns = ctx.functions;
  const branched = fns.repos.reduce((n, r) => n + r.targets.length, 0);
  const rebase = async () => {
    setBusy(true);
    setNote(null);
    try {
      let r = await globalBranches.rebaseFunctions(ctx.branch_id);
      if (r.status === "needs_target") {
        const retarget: Record<string, string> = {};
        for (const s of r.stale ?? []) {
          const next = window.prompt(`${s.repository}: main released ${s.target}. New version target for the branch`, "");
          if (!next) return setNote("Rebase cancelled: a new version target is needed");
          retarget[s.target] = next.trim();
        }
        r = await globalBranches.rebaseFunctions(ctx.branch_id, { retarget });
      }
      const deps = r.dependents ?? [];
      setNote(deps.length ? `Rebased · update ${deps.length} resource${deps.length > 1 ? "s" : ""} pinned to the old target: ${deps.map((d) => d.name).join(", ")}` : "Rebased onto main");
      onChanged(await globalBranches.context(ctx.branch_id));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-ocean/10 px-3 py-1.5 text-xs" data-branch-runtime={ctx.branch_id}>
      <span className="flex items-center gap-1 font-medium text-ocean">
        <Icon name="split" className="h-3.5 w-3.5" /> On branch {ctx.branch_name}
      </span>
      <span className="text-muted" data-branch-data>
        Objects and actions use the branch&apos;s data ({ctx.object_edits} object edit{ctx.object_edits === 1 ? "" : "s"}, never merged into main)
      </span>
      <span className="text-muted" data-branch-functions>
        {branched ? `Functions run ${branched} Branched pre-release${branched > 1 ? "s" : ""}` : "Functions run main's versions as of the branch"}
      </span>
      {fns.stale_targets.length > 0 && (
        <span className="text-bad" data-branch-stale>
          Main released {fns.stale_targets.map((s) => `${s.repository} ${s.target}`).join(", ")}: choose a new version target
        </span>
      )}
      {fns.rebase_available && fns.stale_targets.length === 0 && <span className="text-warn" data-branch-newer>Newer function versions on main</span>}
      {(fns.rebase_available || fns.stale_targets.length > 0) && (
        <button type="button" onClick={rebase} disabled={busy} className={buttonClass.ghost} data-branch-rebase>
          {busy ? "Rebasing…" : "Rebase functions"}
        </button>
      )}
      {note && <span className="text-soft" data-branch-note>{note}</span>}
    </div>
  );
}

export default function WorkshopModulePage() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  // the mobile app launcher (/m/<id>): view only, without the editor, pages in the browser history
  const launcher = (usePathname() ?? "").startsWith("/m/");
  const startEditing = !launcher && !!search.get("edit");
  const [saved, setSaved] = useState<Module | null>(null);
  const [mod, setMod] = useState<Module | null>(null);
  const [editing, setEditing] = useState(startEditing);
  const [selected, setSelected] = useState<string | null>(null);
  const [sources, setSources] = useState<Sources>({ datasets: [], object_types: [] });
  const [actions, setActions] = useState<ActionType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<"widgets" | "layout" | "variables" | "versions" | "settings" | "translations" | "profiler" | "changelog">(() => (search.get("profiler") === "1" ? "profiler" : "widgets"));
  // kiosk mode (?kiosk=1): read-only, without the editor; redact mode; a previewed translation; profiler mode
  const kiosk = search.get("kiosk") === "1";
  const redact = search.get("workshop_enableRedactMode") === "true";
  const [kioskOpen, setKioskOpen] = useState(false);
  // global branching: the branch being edited (?branch=), main when null; moving into a Project
  const [branchId, setBranchIdState] = useState<string | null>(search.get("branch"));
  // the branch's runtime context: its data scenario and its functions' state
  const [branchCtx, setBranchCtx] = useState<BranchContext | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [lang, setLang] = useState<string | null>(null);
  const [profiling] = useState(() => profilerOn());
  // display optimization: pages and overlays seen so far (never-unmount widgets on them stay mounted)
  const [visitedPages, setVisitedPages] = useState<string[]>([]);
  const [visitedOverlays, setVisitedOverlays] = useState<string[]>([]);
  const [target, setTarget] = useState<string>("");
  const [versions, setVersions] = useState<ModuleVersion[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [headerCollapsed, setHeaderCollapsed] = useState<boolean | null>(null);
  const [favorite, setFavorite] = useState(false);
  const [clipNote, setClipNote] = useState<string | null>(null);

  // URL: ?v.<name>=… for URL-parameter variables, ?state=… (a saved state link), ?page=…
  const urlState = useMemo(() => readStateParam(search.get("state")), [search]);
  const initial = useMemo(() => {
    const out: Record<string, unknown> = { ...(urlState?.v ?? {}) };
    search.forEach((v, k) => {
      if (k.startsWith("v.")) out[k.slice(2)] = v;
    });
    return out;
  }, [search, urlState]);

  const stateRef = useRef<ModuleState | null>(null);
  const renderCanvas = useCallback(
    (key: string, widgets: Widget[], layout?: SectionLayout) => (
      <NestedCanvas key={key} layout={layout} widgets={widgets} editing={editing} selected={selected} onSelect={setSelected}
        onChange={(wid, c) => setMod((m) => (m ? { ...m, widgets: m.widgets.map((w) => (w.id === wid ? { ...w, ...c } : w)) } : m))}
        onDrop={(t, x, y) =>
          setMod((m) => {
            if (!m) return m;
            const w = newWidget(m, t, x, y, key);
            queueMicrotask(() => setSelected(w.id));
            return { ...m, widgets: [...m.widgets, w] };
          })
        }
        stateRef={stateRef} />
    ),
    [editing, selected],
  );
  const rt = useModuleRuntime(mod, { initial, renderCanvas, readOnly: kiosk, editing, lang: editing ? lang : null });
  const mobile = isMobile(mod);
  const rtState = rt.state;
  const state = useMemo(() => ({ ...rtState, mobile }), [rtState, mobile]);
  useEffect(() => {
    stateRef.current = state;
  });

  // Ctrl+I: this module's resources in Workflow Lineage
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") {
        e.preventDefault();
        window.open(`/workflow-lineage/new?add=workshop:${id}`, "_blank");
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [id]);

  const { setVariables, setFilters, setSelection, setPage } = rt;
  // the launcher: each page change is a browser history entry, so Back / Forward (and swipes on a phone) move between pages
  const shownPage = mod ? rt.page : null;
  const lastPage = useRef<string | null>(null);
  useEffect(() => {
    if (!launcher || !shownPage) return;
    const h = window.history.state ?? {};
    if (lastPage.current === null) window.history.replaceState({ ...h, wsPage: shownPage }, "");
    else if (lastPage.current !== shownPage && h.wsPage !== shownPage) {
      const u = new URL(window.location.href);
      u.searchParams.set("page", shownPage);
      window.history.pushState({ ...h, wsPage: shownPage }, "", u.toString());
    }
    lastPage.current = shownPage;
  }, [launcher, shownPage]);
  // one listener for the page's life: the router re-renders during popstate, and a listener swapped then would miss it
  const setPageRef = useRef(setPage);
  useEffect(() => {
    setPageRef.current = setPage;
  });
  useEffect(() => {
    if (!launcher) return;
    const on = (e: PopStateEvent) => {
      const p = (e.state as { wsPage?: string } | null)?.wsPage;
      if (p) setPageRef.current(p);
    };
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, [launcher]);
  // on a global branch the runtime works in the branch's context (its data, its function versions) before loading
  useEffect(() => () => leaveGlobalBranch(), []);
  useEffect(() => {
    // viewers see the published version; editing starts from the latest one (a superseded load, e.g. the effect run
    // twice, must not overwrite edits made after the first one arrived)
    let live = true;
    (branchId ? enterGlobalBranch(branchId).then(setBranchCtx) : Promise.resolve())
      .then(() => Promise.all([branchId ? workshop.onBranch(id, branchId) : startEditing ? workshop.module(id) : workshop.moduleAt(id, { published: true }), workshop.sources(), ontology.actionTypes().catch(() => [])]))
      .then(([m, s, a]) => {
        if (!live) return;
        setSaved(m);
        setMod(m);
        setSources(s);
        setActions(a);
        workshop.modules().then((all) => setFavorite(!!all.find((x) => x.id === m.id)?.favorite), () => {});
        // module interface variables also initialize from ?<external id>=
        const given: Record<string, unknown> = { ...initial };
        for (const v of m.variables ?? []) if (v.external_id && search.get(v.external_id) !== null) given[v.name] = search.get(v.external_id);
        setVariables(initialVariables(m.variables, given));
        if (urlState?.f) setFilters(urlState.f);
        // the starting selection (Settings), unless the link carries one: the runtime state was created before the module loaded
        setSelection(urlState?.s ?? { ...(m.settings?.default_selection ?? {}) });
        const p = search.get("page") ?? urlState?.p;
        if (p) setPage(p);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const dirty = !!mod && !!saved && JSON.stringify(FIELDS.map((k) => mod[k])) !== JSON.stringify(FIELDS.map((k) => saved[k]));
  // switching branches reloads the module as it is there
  const setBranchId = (b: string | null) => {
    setBranchIdState(b);
    const u = new URL(window.location.href);
    if (b) u.searchParams.set("branch", b);
    else u.searchParams.delete("branch");
    window.history.replaceState(null, "", u.toString());
    if (!b) {
      leaveGlobalBranch();
      setBranchCtx(null);
    }
    (b ? enterGlobalBranch(b).then((c) => (setBranchCtx(c), workshop.onBranch(id, b))) : workshop.module(id)).then((m) => (setSaved(m), setMod(m)), (e: Error) => setSaveError(e.message));
    if (b) setLeftTab("changelog");
  };
  const save = useCallback(async () => {
    if (!mod) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body = { name: mod.name, description: mod.description ?? "", widgets: mod.widgets, pages: mod.pages, overlays: mod.overlays, variables: mod.variables, settings: mod.settings, derived: mod.derived };
      let target = branchId;
      // a protected module is saved to a new branch, not to main (unless protection is being turned off)
      if (!target && saved?.settings?.protected && mod.settings?.protected !== false) {
        const name = window.prompt("This module is protected: name the new branch for your changes");
        if (!name) return;
        const r = await fetch(`${API_URL}/api/ontology/branches`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description: "Workshop changes" }) });
        const b = await r.json();
        if (!r.ok) throw new Error(b.detail ?? r.statusText);
        target = b.id as string;
        setBranchId(target);
      }
      const s = target ? await workshop.saveOnBranch(mod.id, target, body) : await workshop.save(mod.id, body);
      setSaved(s);
      setMod((m) => (m ? { ...m, latest_version: s.latest_version, published_version: s.published_version, branch: s.branch } : m));
      setVersions(null);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
    // setBranchId only reloads the module after a protected save
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod, branchId, saved]);
  const reloadBranch = () => branchId && workshop.onBranch(id, branchId).then((m) => (setSaved(m), setMod(m)), () => {});

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        save();
      }
      const tag = (e.target as HTMLElement).tagName;
      if (!editing || ["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if (selected && (e.key === "Delete" || e.key === "Backspace")) {
        setMod((m) => (m ? removeWidget(m, selected) : m));
        setSelected(null);
      }
      if ((e.ctrlKey || e.metaKey) && selected && (e.key === "c" || e.key === "x")) {
        setMod((m) => {
          if (!m) return m;
          writeClip(clipOf(m, selected));
          setClipNote(e.key === "x" ? "Cut" : "Copied");
          return e.key === "x" ? removeWidget(m, selected) : m;
        });
        if (e.key === "x") setSelected(null);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "v") {
        const clip = readClip();
        if (!clip) return;
        e.preventDefault();
        setMod((m) => {
          if (!m) return m;
          const r = paste(m, clip, pasteTarget(m, selected, rt.state, target, rt.page), e.shiftKey ? "duplicate" : "same");
          queueMicrotask(() => setSelected(r.root));
          return r.mod;
        });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [save, editing, selected, rt.state, rt.page, target]);
  useEffect(() => {
    if (!clipNote) return;
    const t = setTimeout(() => setClipNote(null), 1500);
    return () => clearTimeout(t);
  }, [clipNote]);
  // the header title names the browser tab
  const tabTitle = (mobile && mod?.settings?.mobile?.navbar?.visible && mod.settings.mobile.navbar.title) || (mod?.settings?.header && !mod.settings.header.hidden ? mod.settings.header.title || mod.name : mod?.name);
  useEffect(() => {
    if (tabTitle) document.title = tabTitle;
  }, [tabTitle]);
  useEffect(() => {
    if (leftTab !== "versions" || versions) return;
    let stale = false;
    workshop.versions(id).then((v) => !stale && setVersions(v), () => !stale && setVersions([]));
    return () => {
      stale = true;
    };
  }, [leftTab, versions, id]);

  const exitKiosk = () => {
    const u = new URL(window.location.href);
    u.searchParams.delete("kiosk");
    window.location.assign(u.toString());
  };
  if (error) return <ApiError message={error} />;
  if (!mod) return <Loading />;

  const pages = rt.pages;
  const page = rt.page;
  if (!visitedPages.includes(page)) setVisitedPages([...visitedPages, page]);
  if (rt.overlay && !visitedOverlays.includes(rt.overlay)) setVisitedOverlays([...visitedOverlays, rt.overlay]);
  const setWidgets = (widgets: Widget[]) => setMod({ ...mod, widgets });
  const updateWidget = (wid: string, c: Partial<Widget>) => setWidgets(mod.widgets.map((w) => (w.id === wid ? { ...w, ...c } : w)));
  // where new widgets go: the chosen container, else the page shown
  const firstPage = pages[0].id;
  const containers = [
    ...pages.map((p) => ({ key: p.id === firstPage ? "" : `page:${p.id}`, label: `Page · ${p.name}` })),
    ...mod.widgets.filter((w) => w.type === "tabs").flatMap((w) => (w.config.tabs ?? [{ id: "t1", name: "Tab 1" }]).map((t) => ({ key: `${w.id}:${t.id}`, label: `${w.title || "Tabs"} · ${t.name}` }))),
    ...mod.widgets.filter((w) => w.type === "section").map((w) => ({ key: `${w.id}:body`, label: `Section · ${w.title || w.id}` })),
    ...(mod.overlays ?? []).map((o) => ({ key: `overlay:${o.id}`, label: `Overlay · ${o.name}` })),
    ...(mod.settings?.header && !mod.settings.header.hidden ? [{ key: "header", label: "Header" }] : []),
  ];
  const pageKey = page === firstPage ? "" : `page:${page}`;
  const addWidget = (type: WidgetType, x?: number, y?: number, parent?: string) => {
    const w = newWidget(mod, type, x, y, parent ?? (target || pageKey));
    setWidgets([...mod.widgets, w]);
    setSelected(w.id);
  };
  const sel = mod.widgets.find((w) => w.id === selected) ?? null;
  const overlay = (mod.overlays ?? []).find((o) => o.id === rt.overlay);
  const showing = mod.showing_version;
  const header = mod.settings?.header && !mod.settings.header.hidden ? mod.settings.header : null;
  const vertical = header?.orientation === "vertical";
  const headerBar = header && (
    <ModuleHeaderBar
      mod={mod}
      state={state}
      editing={editing}
      collapsed={!!header.collapsible && (headerCollapsed ?? !!header.collapsed)}
      onCollapse={setHeaderCollapsed}
      favorite={favorite}
      onFavorite={() => workshop.favorite(mod.id, !favorite).then((r) => setFavorite(r.favorite), () => {})}
      onSelect={() => setLeftTab("layout")}
    />
  );
  const pageStyle = (pages.find((p) => p.id === page) ?? {}) as { background?: string; padding?: number | string };
  const closeOverlay = () => {
    const events = overlay?.on_close ?? [];
    rt.setOverlay(null);
    if (events.length) void state.runEvents?.(events);
  };

  return (
    <div className={`foundry-light flex flex-1 flex-col overflow-hidden ${redact ? "ws-redact" : ""} ${mobile && !editing ? "ws-mobile" : ""}`} data-redact={redact ? "on" : undefined} data-device={mobile ? "mobile" : "desktop"}>
      <style>{`${savedColorsCss(mod.settings?.colors)}${redact ? REDACT_CSS : ""}${mobile ? MOBILE_CSS : ""}`}</style>
      {moveOpen && <MoveDialog mod={mod} onClose={() => setMoveOpen(false)} onMoved={(m) => (setMod({ ...mod, ...m }), setSaved((s) => (s ? { ...s, ...m } : s)), setMoveOpen(false))} />}
      {kioskOpen && (
        <KioskLaunch
          mod={mod}
          sources={sources}
          onClose={() => setKioskOpen(false)}
          onLaunch={() => {
            const u = new URL(window.location.href);
            u.searchParams.set("kiosk", "1");
            u.searchParams.delete("edit");
            window.location.assign(u.toString());
          }}
        />
      )}
      {launcher ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-2 text-sm" data-launcher-bar>
          <Link href="/m" className="flex min-h-9 items-center gap-1 pr-2 text-ocean" data-launcher-back>
            <Icon name="left" className="h-4 w-4" /> Apps
          </Link>
          <span className="truncate font-semibold">{tabTitle}</span>
        </div>
      ) : kiosk ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-1 text-xs text-muted" data-kiosk-bar>
          <Icon name="device" className="h-3.5 w-3.5" /> Kiosk mode · read-only
          <button type="button" onClick={() => exitKiosk()} className="ml-auto rounded border border-line-2 px-2 py-0.5 text-soft hover:text-white" data-exit-kiosk>
            Exit kiosk mode
          </button>
        </div>
      ) : (
        <>
      <AppHeader app="Workshop" icon="device" href="/workshop" crumbs={[{ label: mod.name }]}>
        {saveError && <span className="max-w-sm truncate text-xs text-bad">{saveError}</span>}
        {editing && <BranchControl mod={mod} branchId={branchId} setBranchId={setBranchId} />}
        {editing && <span className="text-xs text-muted">{dirty ? "Unsaved changes" : branchId ? `Saved on ${mod.branch?.branch_name ?? "the branch"}` : `Saved · v${mod.latest_version ?? 1}`}</span>}
        {mod.path && <span className="hidden max-w-xs truncate text-xs text-muted xl:inline" title={mod.path.map((p) => p.name).join(" / ")} data-module-path>{mod.path.map((p) => p.name).join(" / ")}</span>}
        {editing && mod.can_edit !== false && (
          <button type="button" onClick={() => setMoveOpen(true)} className={buttonClass.ghost} title={mod.in_files ? "Move to another Project or folder" : "Not a Files item yet: put it in a Project so its permissions apply"} data-move>
            <Icon name="folder" className="h-3.5 w-3.5" /> {mod.in_files ? "Move" : "Put in a Project"}
          </button>
        )}
        {!editing && showing && <span className="text-xs text-muted">Published v{showing}</span>}
        {!editing && (
          <button type="button" onClick={() => (void navigator.clipboard?.writeText(stateLink(id, page, state)), setCopied(true), setTimeout(() => setCopied(false), 1500))} className={buttonClass.ghost} title="Copy a link to this module in its current state">
            <Icon name="link" className="h-3.5 w-3.5" /> {copied ? "Copied" : "Share state"}
          </button>
        )}
        <a href={`/workflow-lineage/new?add=workshop:${id}`} target="_blank" rel="noreferrer" title="Open in Workflow Lineage (Ctrl+I)" className={buttonClass.ghost}>
          <Icon name="split" className="h-3.5 w-3.5" />
        </a>
        <div className="flex rounded-lg border border-line bg-ink p-0.5">
          {(
            [
              [false, "View", "eye"],
              [true, "Edit", "pencil"],
            ] as const
          ).map(([on, label, icon]) => (
            <button
              key={label}
              type="button"
              disabled={on && mod.can_edit === false}
              title={on && mod.can_edit === false ? "You need the Editor role on the module's Project" : undefined}
              onClick={async () => {
                if (on && showing) {
                  // edit the latest version, not the published one being shown
                  const m = await workshop.module(id);
                  setSaved(m);
                  setMod(m);
                }
                setEditing(on);
                if (!on) setSelected(null);
              }}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${editing === on ? "bg-panel-2 text-white ring-1 ring-line-2" : "text-muted hover:text-white"}`}
            >
              <Icon name={icon} className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
        {clipNote && <span className="text-xs text-muted">{clipNote}</span>}
        {!editing && mod.settings?.kiosk && (
          <button type="button" onClick={() => setKioskOpen(true)} className={buttonClass.ghost} data-open-kiosk>
            <Icon name="device" className="h-3.5 w-3.5" /> Open kiosk
          </button>
        )}
        {editing && (
          <button type="button" onClick={save} disabled={!dirty || saving} className={buttonClass.primary}>
            <Icon name="save" className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Save"}
          </button>
        )}
      </AppHeader>
        </>
      )}
      {profiling && <ProfilerBanner />}
      {branchId && branchCtx && <BranchRuntimeBar ctx={branchCtx} onChanged={setBranchCtx} />}

      {!vertical && headerBar}
      {(editing || (pages.length > 1 && !mobile)) && (
        <div className="flex shrink-0 items-center gap-1 border-b border-line bg-panel px-3" data-pages>
          {pages.map((p) => (
            <button key={p.id} type="button" onClick={() => rt.setPage(p.id)} className={`border-b-2 px-3 py-2 text-xs ${p.id === page ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`} data-page={p.id}>
              {state.tr?.(p.name) ?? p.name}
            </button>
          ))}
          {editing && (
            <button
              type="button"
              onClick={() => {
                const list = mod.pages?.length ? mod.pages : [{ id: "main", name: "Page 1" }];
                const np = { id: `p${Date.now().toString(36)}`, name: `Page ${list.length + 1}` };
                setMod({ ...mod, pages: [...list, np] });
                rt.setPage(np.id);
              }}
              className="px-2 text-xs text-ocean"
            >
              + Page
            </button>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {editing && (
          <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
            <div className="flex flex-wrap gap-0.5 border-b border-line p-1 text-[11px]">
              {(["widgets", "layout", "variables", "versions", "settings", ...(mod.settings?.translations?.enabled ? (["translations"] as const) : []), "profiler", ...(branchId ? (["changelog"] as const) : [])] as const).map((t) => (
                <button key={t} type="button" onClick={() => setLeftTab(t)} className={`rounded px-1.5 py-1 capitalize ${leftTab === t ? "bg-ocean/15 text-ocean" : "text-muted hover:text-white"}`} data-left={t}>
                  {t}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {leftTab === "widgets" && (
                <>
                  <Field label="Module name">
                    <input value={mod.name} onChange={(e) => setMod({ ...mod, name: e.target.value })} className={inputClass} />
                  </Field>
                  <Field label="Description">
                    <textarea value={mod.description ?? ""} onChange={(e) => setMod({ ...mod, description: e.target.value })} rows={2} placeholder="Shown on the module's card in Workshop" className={inputClass} data-module-description />
                  </Field>
                  <Field label="Add into">
                    <select value={target} onChange={(e) => setTarget(e.target.value)} className={inputClass} data-add-into>
                      <option value="">The page shown</option>
                      {containers
                        .filter((x) => x.key)
                        .map((x) => (
                          <option key={x.key} value={x.key}>
                            {x.label}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <div className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">Widgets — drag onto the page</div>
                  <div className="space-y-1.5">
                    {WIDGETS.map((w) => (
                      <div
                        key={w.type}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(DRAG_TYPE, w.type);
                          e.dataTransfer.effectAllowed = "copy";
                        }}
                        onDoubleClick={() => addWidget(w.type)}
                        title={`${w.description}. Drag onto the page, or double-click to add.`}
                        className="flex cursor-grab items-center gap-2 rounded-lg border border-line-2 bg-panel-2 px-2.5 py-2 text-sm text-soft hover:border-ocean/60 hover:text-white active:cursor-grabbing"
                        data-palette={w.type}
                      >
                        <Icon name={w.icon} className="h-4 w-4 text-ocean" />
                        {w.label}
                      </div>
                    ))}
                  </div>
                </>
              )}
              {leftTab === "layout" && <LayoutPanel mod={mod} setMod={setMod} page={page} onPage={rt.setPage} sources={sources} selected={selected} onSelect={setSelected} />}
              {leftTab === "settings" && (
                <div className="space-y-4">
                  <SettingsPanel mod={mod} setMod={setMod} sources={sources} selection={state.selection} />
                  <PlatformSettings mod={mod} setMod={setMod} />
                  <CommandsSettings mod={mod} setMod={setMod} />
                </div>
              )}
              {leftTab === "translations" && <TranslationsPanel mod={mod} setMod={setMod} lang={lang} setLang={setLang} />}
              {leftTab === "profiler" && <ProfilerPanel mod={mod} />}
              {leftTab === "changelog" && branchId && <ChangelogPanel mod={mod} branchId={branchId} onChanged={reloadBranch} />}
              {leftTab === "variables" && <VariablesEditor mod={mod} setMod={setMod} values={state.variables} computed={rt.computed} objectTypes={sources.object_types} />}
              {leftTab === "versions" && (
                <div className="space-y-2 text-xs" data-versions>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={mod.settings?.auto_publish !== false} onChange={(e) => setMod({ ...mod, settings: { ...mod.settings, auto_publish: e.target.checked } })} /> Publish every save automatically
                  </label>
                  <p className="text-muted">
                    Viewers see version {mod.published_version ?? mod.latest_version ?? 1}; the latest is {mod.latest_version ?? 1}.
                  </p>
                  {(versions ?? []).map((v) => (
                    <div key={v.version} className="rounded border border-line p-2">
                      <div className="flex items-center gap-1">
                        <span className="font-mono">v{v.version}</span>
                        {v.version === mod.published_version && <span className="rounded bg-ok/15 px-1 text-[10px] text-ok">published</span>}
                        <span className="ml-auto text-muted">{new Date(v.at).toLocaleString()}</span>
                      </div>
                      <div className="text-muted">
                        {v.summary}
                        {v.by ? ` · ${v.by}` : ""}
                      </div>
                      {v.version !== mod.published_version && (
                        <button
                          type="button"
                          onClick={async () => {
                            const m = await workshop.publish(id, v.version);
                            setMod((x) => (x ? { ...x, published_version: m.published_version } : x));
                            setSaved((x) => (x ? { ...x, published_version: m.published_version } : x));
                          }}
                          className="text-ocean"
                        >
                          Publish this version
                        </button>
                      )}
                    </div>
                  ))}
                  {versions && !versions.length && <p className="text-muted">Save to make the first version.</p>}
                </div>
              )}
            </div>
          </aside>
        )}

        {vertical && headerBar}
        <div
          className={`flex min-w-0 flex-1 flex-col ${editing && mobile ? "overflow-hidden rounded-[28px] border-4 border-line-2 shadow-2xl" : ""}`}
          style={{
            background: backgroundOf(pageStyle.background as string | undefined),
            padding: paddingOf(pageStyle.padding as number | undefined),
            // the editor shows a mobile module at phone size
            ...(editing && mobile ? { flex: `0 1 ${PHONE.w}px`, maxWidth: PHONE.w, height: PHONE.h, maxHeight: "calc(100% - 24px)", margin: "12px auto" } : {}),
          }}
          data-page-surface
        >
          <Canvas widgets={pageWidgets(mod, page)} editing={editing} selected={selected} onSelect={setSelected} onChange={updateWidget} onDrop={(t, x, y) => addWidget(t, x, y, pageKey)} state={state} transparent={!!pageStyle.background} />
          {!editing &&
            pages
              .filter((p) => p.id !== page && (state.keep?.eager.has(`page:${p.id}`) || (state.keep?.never.has(`page:${p.id}`) && visitedPages.includes(p.id))))
              .map((p) => (
                <div key={p.id} className="hidden" data-kept-page={p.id}>
                  <Canvas widgets={pageWidgets(mod, p.id)} editing={false} selected={null} onSelect={() => {}} onChange={() => {}} onDrop={() => {}} state={state} />
                </div>
              ))}
          {!editing &&
            (mod.overlays ?? [])
              .filter((o) => o.id !== rt.overlay && (state.keep?.eager.has(`overlay:${o.id}`) || (state.keep?.never.has(`overlay:${o.id}`) && visitedOverlays.includes(o.id))))
              .map((o) => (
                <div key={o.id} className="hidden" data-kept-overlay={o.id}>
                  {state.renderContainer?.(`overlay:${o.id}`)}
                </div>
              ))}
          <MobileNavBar mod={mod} state={state} page={page} editing={editing} />
          {editing && !pageWidgets(mod, page).length && (
            <div className="flex flex-wrap items-center justify-center gap-2 border-t border-line bg-panel px-3 py-2 text-xs" data-templates>
              <span className="text-muted">Layout templates:</span>
              {TEMPLATES.map((t) => (
                <button key={t.id} type="button" onClick={() => setMod(applyTemplate(mod, pageKey, t))} className="rounded border border-line-2 px-2 py-1 text-soft hover:border-ocean hover:text-white" data-template={t.id}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {editing && (
          <aside className="w-80 shrink-0 overflow-y-auto border-l border-line bg-panel">
            {sel ? (
              <WidgetConfigPanel
                key={sel.id}
                widget={sel}
                mod={mod}
                sources={sources}
                actions={actions}
                onChange={(c) => updateWidget(sel.id, c)}
                onDelete={() => {
                  setMod(removeWidget(mod, sel.id));
                  setSelected(null);
                }}
                onDuplicate={(mode) => {
                  // with its children; "duplicate": new copies of the variables it uses
                  const r = paste(mod, clipOf(mod, sel.id)!, sel.parent ?? "", mode);
                  setMod(r.mod);
                  setSelected(r.root);
                }}
                onCopy={(cut) => {
                  writeClip(clipOf(mod, sel.id));
                  setClipNote(cut ? "Cut" : "Copied");
                  if (cut) {
                    setMod(removeWidget(mod, sel.id));
                    setSelected(null);
                  }
                }}
                onPaste={(mode) => {
                  const clip = readClip();
                  if (!clip) return setClipNote("Nothing copied");
                  const r = paste(mod, clip, pasteTarget(mod, sel.id, state, target, page), mode);
                  setMod(r.mod);
                  setSelected(r.root);
                }}
                onOrder={(dir) => setMod(reorder(mod, sel.id, dir))}
              />
            ) : (
              <div className="p-6 text-center text-sm text-muted">
                <Icon name="grid" className="mx-auto mb-2 h-6 w-6" />
                Drag a widget onto the page, then select it to choose its data.
                <p className="mt-3 text-xs">Move widgets by their title bar; resize from the bottom-right corner. Tabs and overlays hold their own widgets.</p>
              </div>
            )}
          </aside>
        )}
      </div>
      {overlay && (
        <div
          className={`fixed inset-0 z-40 flex ${overlay.kind === "drawer" ? (overlay.side === "left" ? "justify-start" : "justify-end") : "items-center justify-center"} ${overlay.backdrop === false ? "pointer-events-none" : "bg-ink/60"}`}
          onClick={() => overlay.close_on_backdrop !== false && closeOverlay()}
          data-overlay={overlay.id}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: overlay.width ?? (overlay.kind === "drawer" ? 520 : 760) }}
            className={`pointer-events-auto flex flex-col border-line bg-panel shadow-2xl ${overlay.kind === "drawer" ? `h-full ${overlay.side === "left" ? "border-r" : "border-l"}` : "max-h-[85vh] min-h-[50vh] rounded-xl border"}`}
          >
            {overlay.show_header !== false && (
              <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-sm font-semibold">
                {overlay.icon && <Icon name={overlay.icon as "grid"} className="h-4 w-4 text-ocean" />}
                {overlay.title ? fillVarsText(state.tr?.(overlay.title) ?? overlay.title, state.variables) : (state.tr?.(overlay.name) ?? overlay.name)}
                <button type="button" onClick={closeOverlay} className="ml-auto text-muted hover:text-white" aria-label="Close" data-overlay-close>
                  <Icon name="x" className="h-4 w-4" />
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1">{state.renderContainer?.(`overlay:${overlay.id}`)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

const FIELDS = ["name", "description", "widgets", "pages", "overlays", "variables", "settings", "derived"] as const;

const fillVarsText = (t: string, vars: Record<string, unknown>) => t.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, n) => String(vars[n] ?? ""));

/** Remove a widget with everything inside it. */
function removeWidget(mod: Module, id: string): Module {
  const gone = new Set([id, ...descendants(mod.widgets, id).map((w) => w.id)]);
  return { ...mod, widgets: mod.widgets.filter((w) => !gone.has(w.id)) };
}

/** Where a paste goes: into the selected container (a section's body, the open tab), else the "Add into" target or the page. */
function pasteTarget(mod: Module, selected: string | null, state: ModuleState, target: string, page: string): string {
  const w = selected ? mod.widgets.find((x) => x.id === selected) : undefined;
  if (w?.type === "section") return `${w.id}:body`;
  if (w?.type === "tabs") return `${w.id}:${state.tabs?.[w.id] ?? w.config.tabs?.[0]?.id ?? "t1"}`;
  if (w) return w.parent ?? "";
  if (target) return target;
  const first = mod.pages?.[0]?.id ?? "main";
  return page === first ? "" : `page:${page}`;
}

/** A new widget in a container ("" for the first page): at the drop point, else below its siblings. */
function newWidget(mod: Module, type: WidgetType, x: number | undefined, y: number | undefined, into: string): Widget {
  const info = widgetInfo(type);
  const siblings = mod.widgets.filter((w) => (w.parent ?? "") === into);
  const bottom = siblings.reduce((m, w) => Math.max(m, w.y + w.h), 0);
  const next = 1 + Math.max(0, ...mod.widgets.map((w) => Number(w.id.replace(/\D/g, "")) || 0));
  // new widgets read the source most recently used, so a dashboard builds up quickly
  const lastSource = [...mod.widgets].reverse().find((w) => w.config.source)?.config.source;
  return {
    id: `w${next}`,
    type,
    title: type === "section" ? "Section" : type === "text" || NO_SOURCE.has(type) ? "" : info.label,
    x: Math.max(0, Math.min(COLS - info.w, x ?? 0)),
    y: Math.max(0, y ?? bottom),
    w: info.w,
    h: info.h,
    config:
      type === "text"
        ? { text: "## Section title" }
        : type === "tabs"
          ? { tabs: [{ id: "t1", name: "Tab 1" }, { id: "t2", name: "Tab 2" }] }
          : type === "section"
            ? { section_layout: "grid" as const }
          : type === "button" || type === "function" || NO_SOURCE.has(type)
            ? {}
            : { source: lastSource, metric: "count" },
    ...(into ? { parent: into } : {}),
  };
}

/** A tab or an overlay: its own grid, editable in place (drops add into it). */
function NestedCanvas({
  widgets,
  layout,
  editing,
  selected,
  onSelect,
  onChange,
  onDrop,
  stateRef,
}: {
  widgets: Widget[];
  layout?: SectionLayout;
  editing: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, c: Partial<Widget>) => void;
  onDrop: (type: WidgetType, x: number, y: number) => void;
  stateRef: React.RefObject<ModuleState | null>;
}) {
  const [state, setState] = useState<ModuleState | null>(null);
  useEffect(() => {
    // the module state is read once mounted (it is created after this renderer)
    const t = setTimeout(() => setState(stateRef.current), 0);
    return () => clearTimeout(t);
  });
  if (!state) return null;
  return <Canvas nested layout={layout} minRows={layout === "toolbar" ? 1 : 4} widgets={widgets} editing={editing} selected={selected} onSelect={onSelect} onChange={onChange} onDrop={onDrop} state={state} />;
}

function LayoutPanel({ mod, setMod, page, onPage, sources, selected, onSelect }: { mod: Module; setMod: (m: Module) => void; page: string; onPage: (p: string) => void; sources: Sources; selected: string | null; onSelect: (id: string) => void }) {
  const pages = mod.pages?.length ? mod.pages : [{ id: "main", name: "Page 1" }];
  const overlays = mod.overlays ?? [];
  const vars = mod.variables ?? [];
  const derived = mod.derived ?? [];
  return (
    <div className="space-y-4 text-xs" data-layout>
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-muted">Header</div>
        <HeaderSettings mod={mod} setMod={setMod} />
      </div>
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-muted">Outline of this page</div>
        <Outline mod={mod} roots={pageWidgets(mod, page)} selected={selected} onSelect={onSelect} />
      </div>
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-muted">Pages</div>
        <label className="mb-2 block text-muted">
          Variable-backed page selection (a string variable holding a page ID)
          <select value={mod.settings?.page_variable ?? ""} onChange={(e) => setMod({ ...mod, settings: { ...mod.settings, page_variable: e.target.value || undefined } })} className={`${fieldClass} mt-1 w-full text-xs`}>
            <option value="">None</option>
            {vars.filter((v) => v.type === "string").map((v) => (
              <option key={v.name}>{v.name}</option>
            ))}
          </select>
        </label>
        {pages.map((p, i) => (
          <div key={p.id} className="mb-1 flex gap-1">
            <span className="w-14 truncate pt-1.5 font-mono text-[10px] text-muted" title="Page ID">{p.id}</span>
            <input value={p.name} onChange={(e) => setMod({ ...mod, pages: pages.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} onFocus={() => onPage(p.id)} className={`${fieldClass} flex-1 text-xs ${p.id === page ? "border-ocean" : ""}`} />
            {i > 0 && (
              <button type="button" title="Delete the page and its widgets" onClick={() => setMod(dropContainer({ ...mod, pages: pages.filter((x) => x.id !== p.id) }, `page:${p.id}`))} className="px-1 text-muted hover:text-bad">
                ✕
              </button>
            )}
          </div>
        ))}
        <p className="text-muted">The first page holds widgets without a page.</p>
        {(() => {
          const i = pages.findIndex((p) => p.id === page);
          const p = pages[i];
          if (!p) return null;
          const setP = (x: Partial<typeof p>) => setMod({ ...mod, pages: pages.map((y, j) => (j === i ? { ...y, ...x } : y)) });
          return (
            <div className="mt-2 space-y-1 rounded border border-line p-2" data-page-style>
              <div className="text-muted">Style of “{p.name}”</div>
              <BackgroundField value={p.background} onChange={(b) => setP({ background: b })} saved={mod.settings?.colors} />
              <PaddingField value={p.padding} onChange={(x) => setP({ padding: x })} />
            </div>
          );
        })()}
      </div>
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-muted">Overlays</div>
        {overlays.map((o, i) => (
          <div key={o.id} className="mb-2 space-y-1 rounded border border-line p-2">
            <div className="flex gap-1">
              <input value={o.name} onChange={(e) => setMod({ ...mod, overlays: overlays.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} className={`${fieldClass} flex-1 text-xs`} />
              <button type="button" onClick={() => setMod(dropContainer({ ...mod, overlays: overlays.filter((x) => x.id !== o.id) }, `overlay:${o.id}`))} className="px-1 text-muted hover:text-bad">
                ✕
              </button>
            </div>
            <div className="flex gap-1">
              <select value={o.kind} onChange={(e) => setMod({ ...mod, overlays: overlays.map((x, j) => (j === i ? { ...x, kind: e.target.value as "drawer" } : x)) })} className={`${fieldClass} text-xs`}>
                <option value="drawer">Drawer</option>
                <option value="modal">Modal</option>
              </select>
              <input type="number" value={o.width ?? ""} placeholder="width" onChange={(e) => setMod({ ...mod, overlays: overlays.map((x, j) => (j === i ? { ...x, width: Number(e.target.value) || undefined } : x)) })} className={`${fieldClass} w-20 text-xs`} />
            </div>
            <select value={o.open_variable ?? ""} onChange={(e) => setMod({ ...mod, overlays: overlays.map((x, j) => (j === i ? { ...x, open_variable: e.target.value || undefined } : x)) })} className={`${fieldClass} w-full text-xs`} title="Variable-backed open state">
              <option value="">No open-state variable</option>
              {vars.filter((v) => v.type === "boolean").map((v) => (
                <option key={v.name}>{v.name}</option>
              ))}
            </select>
            <OverlayOptions o={o} mod={mod} set={(x) => setMod({ ...mod, overlays: overlays.map((y, j) => (j === i ? { ...y, ...x } : y)) })} />
            <p className="text-muted">Add widgets into it with “Add into”; open it with a button event or its boolean variable.</p>
          </div>
        ))}
        <button type="button" onClick={() => setMod({ ...mod, overlays: [...overlays, { id: `o${Date.now().toString(36)}`, name: `Overlay ${overlays.length + 1}`, kind: "drawer" }] })} className="text-ocean">
          + Overlay
        </button>
      </div>
      <div data-derived>
        <div className="mb-1 font-semibold uppercase tracking-wide text-muted">Derived properties</div>
        <p className="mb-1 text-muted">Column math on an object type, available to every widget on it in this module.</p>
        {derived.map((d, i) => {
          const t = sources.object_types.find((x) => x.id === d.object_type_id);
          const set = (x: Partial<typeof d>) => setMod({ ...mod, derived: derived.map((y, j) => (j === i ? { ...y, ...x } : y)) });
          return (
            <div key={i} className="mb-2 space-y-1 rounded border border-line p-2">
              <div className="flex gap-1">
                <input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="name" className={`${fieldClass} min-w-0 flex-1 font-mono text-xs`} />
                <button type="button" onClick={() => setMod({ ...mod, derived: derived.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                  ✕
                </button>
              </div>
              <select value={d.object_type_id} onChange={(e) => set({ object_type_id: e.target.value })} className={`${fieldClass} w-full text-xs`}>
                {sources.object_types.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
              <div className="flex gap-1">
                <select value={d.column} onChange={(e) => set({ column: e.target.value })} className={`${fieldClass} min-w-0 flex-1 text-xs`}>
                  <option value="">Property…</option>
                  {t?.properties.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <select value={d.op} onChange={(e) => set({ op: e.target.value as typeof d.op })} className={`${fieldClass} text-xs`}>
                  {["add", "subtract", "multiply", "divide", "concat", "upper", "lower", "year"].map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </div>
              {["add", "subtract", "multiply", "divide", "concat"].includes(d.op) && (
                <select value={d.other_column ?? ""} onChange={(e) => set({ other_column: e.target.value || undefined })} className={`${fieldClass} w-full text-xs`}>
                  <option value="">and a fixed value…</option>
                  {t?.properties.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.label}
                    </option>
                  ))}
                </select>
              )}
              {["add", "subtract", "multiply", "divide", "concat"].includes(d.op) && !d.other_column && (
                <input value={String(d.value ?? "")} onChange={(e) => set({ value: e.target.value })} placeholder="value" className={`${fieldClass} w-full text-xs`} />
              )}
            </div>
          );
        })}
        <button type="button" onClick={() => setMod({ ...mod, derived: [...derived, { object_type_id: sources.object_types[0]?.id ?? "", name: `derived${derived.length + 1}`, op: "subtract", column: "" }] })} className="text-ocean">
          + Derived property
        </button>
      </div>
    </div>
  );
}

/** Delete a page's or an overlay's widgets with everything inside them. */
function dropContainer(mod: Module, key: string): Module {
  let m = mod;
  for (const w of mod.widgets.filter((x) => x.parent === key)) m = removeWidget(m, w.id);
  return m;
}

function OverlayOptions({ o, mod, set }: { o: NonNullable<Module["overlays"]>[number]; mod: Module; set: (x: Partial<NonNullable<Module["overlays"]>[number]>) => void }) {
  return (
    <details className="rounded border border-line p-1.5" data-overlay-options>
      <summary className="cursor-pointer text-soft">Options</summary>
      <div className="mt-1 space-y-1">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={o.show_header !== false} onChange={(e) => set({ show_header: e.target.checked })} /> Show the overlay header (with a close button)
        </label>
        {o.show_header !== false && (
          <div className="flex gap-1">
            <input value={o.title ?? ""} onChange={(e) => set({ title: e.target.value || undefined })} placeholder="Title ({{variables}})" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
            <input value={o.icon ?? ""} onChange={(e) => set({ icon: e.target.value || undefined })} placeholder="icon" className={`${fieldClass} w-16 text-xs`} />
          </div>
        )}
        {o.kind === "drawer" && (
          <select value={o.side ?? "right"} onChange={(e) => set({ side: e.target.value as "left" | "right" })} className={`${fieldClass} w-full text-xs`}>
            <option value="right">From the right</option>
            <option value="left">From the left</option>
          </select>
        )}
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={o.close_on_backdrop !== false} onChange={(e) => set({ close_on_backdrop: e.target.checked })} /> Close on backdrop click
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={o.backdrop !== false} onChange={(e) => set({ backdrop: e.target.checked })} /> Background behind the overlay
        </label>
        <EventsEditor events={o.on_close ?? []} mod={mod} onChange={(ev) => set({ on_close: ev })} label="On close" />
      </div>
    </details>
  );
}

/** The columns of a source (object type properties, or a dataset's schema). */
function useColumns(source: SourceRef | undefined, sources: Sources): Column[] {
  const [cols, setCols] = useState<{ key: string; cols: Column[] }>({ key: "", cols: [] });
  const key = sourceKey(source);
  const objectCols = useMemo(() => {
    if (source?.kind === "interface") return (sources.interfaces?.find((x) => x.id === source.id)?.properties ?? []).map((p) => ({ name: p.name, type: p.type }));
    if (source?.kind === "object_types") return unionColumns(source, sources.object_types).map((p) => ({ name: p.name, type: p.type }));
    if (source?.kind !== "object_type") return null;
    const t = sources.object_types.find((x) => x.id === source.id);
    return (t?.properties ?? []).map((p) => ({ name: p.name, type: p.type }));
  }, [source, sources]);
  useEffect(() => {
    // a dataset or a restricted view: the columns come from a one-row query
    if (!source || (source.kind !== "dataset" && source.kind !== "restricted_view")) return;
    let stale = false;
    workshop
      .query({ source, limit: 1 })
      .then((r) => !stale && setCols({ key: sourceKey(source), cols: r.columns }))
      .catch(() => !stale && setCols({ key: sourceKey(source), cols: [] }));
    return () => {
      stale = true;
    };
  }, [source]);
  return objectCols ?? (cols.key === key ? cols.cols : []);
}

/** Widgets whose query takes the widget's own filters (config.filters). */
/** A table column dragged within the Columns list (reordering). */
const COLUMN_DRAG = "application/x-workshop-column";
const WIDGET_FILTER_TYPES = new Set<WidgetType>(["metric", "table", "bar", "pie", "line", "filter"]);
const WIDGET_FILTER_OPS: Filter["op"][] = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "is_null", "not_null", "starts_with"];

function WidgetConfigPanel({
  widget,
  mod,
  sources,
  actions,
  onChange,
  onDelete,
  onDuplicate,
  onCopy,
  onPaste,
  onOrder,
}: {
  widget: Widget;
  mod: Module;
  sources: Sources;
  actions: ActionType[];
  onChange: (c: Partial<Widget>) => void;
  onDelete: () => void;
  onDuplicate: (mode: "same" | "duplicate") => void;
  onCopy: (cut: boolean) => void;
  onPaste: (mode: "same" | "duplicate") => void;
  onOrder: (dir: -1 | 1) => void;
}) {
  const c = widget.config;
  const set = (x: Partial<WidgetConfig>) => onChange({ config: { ...c, ...x } });
  const cols = useColumns(c.source, sources);
  const info = widgetInfo(widget.type);
  const numeric = cols.filter((x) => /Integer|Long|Short|Byte|Double|Float|Decimal|integer|double/.test(x.type));
  const colSelect = (value: string | undefined, onPick: (v: string | undefined) => void, list = cols, empty = "Choose a column…") => (
    <select value={value ?? ""} onChange={(e) => onPick(e.target.value || undefined)} className={inputClass}>
      <option value="">{empty}</option>
      {list.map((col) => (
        <option key={col.name} value={col.name}>
          {col.name} · {col.type}
        </option>
      ))}
    </select>
  );

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold">
        <Icon name={info.icon} className="h-4 w-4 text-ocean" />
        <span className="flex-1">{info.label}</span>
        <details className="relative" data-clipboard>
          <summary className="list-none rounded p-1 text-muted hover:bg-panel-2 hover:text-white" title="Duplicate, cut, copy, paste">
            <Icon name="copy" className="h-3.5 w-3.5" />
          </summary>
          <div className="absolute right-0 z-20 mt-1 w-60 rounded-lg border border-line-2 bg-panel p-1 text-xs font-normal shadow-xl">
            {(
              [
                ["Duplicate (same input variables)", () => onDuplicate("same")],
                ["Duplicate with new input variables", () => onDuplicate("duplicate")],
                ["Copy (Ctrl+C)", () => onCopy(false)],
                ["Cut (Ctrl+X)", () => onCopy(true)],
                ["Paste with the same input variables (Ctrl+V)", () => onPaste("same")],
                ["Paste with duplicate input variables (Ctrl+Shift+V)", () => onPaste("duplicate")],
              ] as const
            ).map(([label, fn]) => (
              <button key={label} type="button" onClick={(e) => (fn(), (e.currentTarget.closest("details") as HTMLDetailsElement).removeAttribute("open"))} className="block w-full rounded px-2 py-1 text-left text-soft hover:bg-panel-2 hover:text-white">
                {label}
              </button>
            ))}
          </div>
        </details>
        <button type="button" onClick={onDelete} title="Delete (Del)" className="rounded p-1 text-muted hover:bg-panel-2 hover:text-bad">
          <Icon name="trash" className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="space-y-4 p-4">
        <Field label="Title">
          <input value={widget.title} onChange={(e) => onChange({ title: e.target.value })} placeholder="No title bar" className={inputClass} />
        </Field>
        {(() => {
          // order inside a rows / columns / toolbar / flow section, or the header
          const owner = widget.parent?.endsWith(":body") ? mod.widgets.find((w) => `${w.id}:body` === widget.parent) : undefined;
          const flex = widget.parent === "header" || isMobile(mod) || (owner?.type === "section" && (owner.config.section_layout ?? "grid") !== "grid");
          if (!flex) return null;
          return (
            <div className="flex flex-wrap items-center gap-2 text-xs" data-order>
              {isMobile(mod) && widget.parent !== "header" && (
                <label className="flex items-center gap-1 text-muted">
                  Height
                  <input type="number" min={1} max={30} value={widget.h} onChange={(e) => onChange({ h: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })} className="w-14 rounded border border-line-2 bg-ink px-1 py-0.5 text-soft" data-mobile-height />
                  rows
                </label>
              )}
              <span className="text-muted">Order</span>
              <button type="button" onClick={() => onOrder(-1)} className="rounded border border-line-2 px-2 py-0.5 text-soft hover:text-white">
                ↑ Earlier
              </button>
              <button type="button" onClick={() => onOrder(1)} className="rounded border border-line-2 px-2 py-0.5 text-soft hover:text-white">
                ↓ Later
              </button>
            </div>
          );
        })()}
        <CommonWidgetConfig widget={widget} set={set} mod={mod} cols={cols} />
        <CrossAppConfig widget={widget} set={set} mod={mod} />
        <NotepadWidgetConfig widget={widget} set={set} mod={mod} />
        <GraphWidgetConfig widget={widget} set={set} mod={mod} />
        <SchedulingWidgetConfig widget={widget} set={set} mod={mod} />
        <ProgramSchedulingConfig widget={widget} set={set} mod={mod} />
        <RulesWidgetConfig widget={widget} set={set} mod={mod} />
        <VulcanWidgetConfig widget={widget} set={set} mod={mod} />
        <FormEmbedConfig widget={widget} set={set} mod={mod} />
        <ScenarioConfig widget={widget} set={set} mod={mod} />
        {MOBILE_TYPES.has(widget.type) && <MobileWidgetConfig widget={widget} set={set} mod={mod} cols={cols} />}
        {VIZ_TYPES.has(widget.type) && <VizWidgetConfig widget={widget} set={set} mod={mod} cols={cols} sources={sources} />}
        {MEDIA_TYPES.has(widget.type) && <MediaWidgetConfig widget={widget} set={set} mod={mod} cols={cols} sources={sources} />}
        {OBJECT_TYPES.has(widget.type) && <ObjectWidgetConfig widget={widget} set={set} mod={mod} cols={cols} sources={sources} />}
        {widget.type === "text" && <MarkdownConfig widget={widget} set={set} mod={mod} sources={sources} />}
        {FILTER_TYPES.has(widget.type) && <FilterWidgetConfig widget={widget} set={set} mod={mod} cols={cols} sources={sources} />}
        {widget.type === "data_freshness" && <FreshnessConfig widget={widget} set={set} sources={sources} />}
        {AIP_TYPES.has(widget.type) && <AipWidgetConfig widget={widget} set={set} mod={mod} cols={cols} sources={sources} />}
        {widget.type === "inline_action" && <InterfaceActionConfig widget={widget} set={set} interfaces={sources.interfaces ?? []} actions={actions} />}

        {widget.type === "text" && (
          <Field label="Text (Markdown)">
            <textarea rows={8} value={c.text ?? ""} onChange={(e) => set({ text: e.target.value })} className={`${inputClass} font-mono text-xs`} />
          </Field>
        )}

        {widget.type === "button" && (
          <>
            <InterfaceActionConfig widget={widget} set={set} interfaces={sources.interfaces ?? []} actions={actions} />
            <Field label="Action" hint={c.action_interface_id ? "An interface action, or an action of an implementing type (used for objects of that type)" : "Edit and delete actions use the object selected in a table"}>
              <select value={c.action_type_id ?? ""} onChange={(e) => set({ action_type_id: e.target.value || undefined })} className={inputClass}>
                <option value="">{c.action_interface_id ? "None" : "Choose an action…"}</option>
                {actions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Button text">
              <input value={c.label ?? ""} onChange={(e) => set({ label: e.target.value })} placeholder="The action's name" className={inputClass} />
            </Field>
            <EventsEditor events={c.events ?? []} mod={mod} onChange={(ev) => set({ events: ev })} label={c.action_type_id ? "After the action" : "On click"} />
          </>
        )}

        <NewWidgetConfig widget={widget} set={set} mod={mod} cols={cols} actions={actions} />

        {(widget.type === "ts_chart" || widget.type === "ts_metric" || widget.type === "quiver" || widget.type === "derived") && <TsWidgetConfig widget={widget} set={set} />}
        {widget.type === "ts_metric" && <TsMetricFormatConfig widget={widget} set={set} />}
        {widget.type === "table" && <TsColumnsConfig widget={widget} set={set} />}

        {widget.type === "function" && <FunctionWidgetConfig widget={widget} set={set} objectTypes={sources.object_types} interfaces={sources.interfaces ?? []} variables={mod.variables ?? []} />}

        {widget.type !== "text" && widget.type !== "button" && widget.type !== "audio_recorder" && widget.type !== "custom" && widget.type !== "quiver" && widget.type !== "derived" && widget.type !== "function" && !NO_SOURCE.has(widget.type) && (
          <Field label="Data source">
            <select
              value={sourceKey(c.source)}
              onChange={(e) => {
                const [kind, ...rest] = e.target.value.split(":");
                set({ source: e.target.value ? { kind: kind as SourceRef["kind"], id: rest.join(":") } : undefined, columns: [], group_by: undefined, metric_column: undefined, column: undefined, sort: undefined });
              }}
              className={inputClass}
            >
              <option value="">Choose a dataset, object type or interface…</option>
              <optgroup label="Object types">
                {sources.object_types.map((t) => (
                  <option key={t.id} value={`object_type:${t.id}`}>
                    {t.name} ({t.count})
                  </option>
                ))}
              </optgroup>
              <optgroup label="Union of object types (choose them below)">
                <option value={c.source?.kind === "object_types" ? sourceKey(c.source) : "object_types:"}>
                  {c.source?.kind === "object_types" ? `Union of ${c.source.id.split(",").filter(Boolean).length} object types` : "Union of several object types…"}
                </option>
              </optgroup>
              {(sources.interfaces ?? []).length > 0 && (
                <optgroup label="Interfaces (every implementing object type)">
                  {(sources.interfaces ?? []).map((i) => (
                    <option key={i.id} value={`interface:${i.id}`}>
                      {i.name} ({i.implemented_by} object types)
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Datasets">
                {sources.datasets.map((d) => (
                  <option key={d.id} value={`dataset:${d.id}`}>
                    {d.name}
                    {d.path.length ? ` — ${d.path.slice(-2).join(" / ")}` : ""}
                  </option>
                ))}
              </optgroup>
              {(sources.restricted_views ?? []).length > 0 && (
                <optgroup label="Restricted views (each viewer sees their rows)">
                  {(sources.restricted_views ?? []).map((v) => (
                    <option key={v.id} value={`restricted_view:${v.id}`}>
                      {v.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {sources.datasets.length === 0 && <span className="mt-1 block text-[11px] text-muted">No datasets yet: deploy a pipeline output to create one.</span>}
            {c.source?.kind === "object_types" && <UnionTypesPicker source={c.source} types={sources.object_types} onChange={(s) => set({ source: s })} />}
          </Field>
        )}

        {c.source?.kind === "object_type" && widget.type === "table" && <FunctionColumnConfig widget={widget} set={set} />}
        {c.source?.kind === "object_type" && (widget.type === "table" || widget.type === "object_list") && <EventsEditor events={c.on_select ?? []} mod={mod} onChange={(ev) => set({ on_select: ev })} label="When a row is selected" />}

        {widget.type === "semantic_search" && c.source?.kind === "object_type" && (
          <>
            <Field label="Embedding" hint="The vector property queries are compared with (tables, charts and metrics on this object type follow the search)">
              <select value={c.semantic_property ?? ""} onChange={(e) => set({ semantic_property: e.target.value || undefined })} className={inputClass}>
                <option value="">First vector property</option>
                {(sources.object_types.find((t) => t.id === c.source?.id)?.properties ?? [])
                  .filter((p) => p.type === "vector")
                  .map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.label}
                    </option>
                  ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="K (results)" hint="1–500">
                <input type="number" min={1} max={500} value={c.semantic_k ?? 20} onChange={(e) => set({ semantic_k: Math.max(1, Math.min(500, Number(e.target.value) || 20)) })} className={inputClass} />
              </Field>
              <Field label="Ranking">
                <select value={c.semantic_mode ?? "semantic"} onChange={(e) => set({ semantic_mode: e.target.value as WidgetConfig["semantic_mode"] })} className={inputClass}>
                  <option value="semantic">By meaning (KNN)</option>
                  <option value="keyword">Ranked keywords</option>
                  <option value="hybrid">Hybrid (RRF)</option>
                </select>
              </Field>
            </div>
            <Field label="Placeholder">
              <input value={c.placeholder ?? ""} onChange={(e) => set({ placeholder: e.target.value })} placeholder="Search by meaning…" className={inputClass} />
            </Field>
          </>
        )}

        {c.source && widget.type === "table" && (
          <>
            <div>
              <div className="mb-1 text-xs font-medium text-soft">Columns</div>
              <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-line-2 bg-ink p-2" data-table-columns>
                {/* the shown columns first, in their order (drag a row to reorder), then the hidden ones */}
                {[...(c.columns ?? []).map((n) => cols.find((x) => x.name === n)).filter((x): x is Column => !!x), ...cols.filter((x) => !c.columns?.includes(x.name))].map((col) => {
                  const shown = !c.columns?.length || c.columns.includes(col.name);
                  const all = c.columns?.length ? c.columns : cols.map((x) => x.name);
                  return (
                    <label
                      key={col.name}
                      draggable={shown}
                      onDragStart={(e) => (e.dataTransfer.setData(COLUMN_DRAG, col.name), (e.dataTransfer.effectAllowed = "move"))}
                      onDragOver={(e) => shown && e.dataTransfer.types.includes(COLUMN_DRAG) && e.preventDefault()}
                      onDrop={(e) => {
                        const moved = e.dataTransfer.getData(COLUMN_DRAG);
                        if (!moved || moved === col.name) return;
                        e.preventDefault();
                        const rest = all.filter((n) => n !== moved);
                        rest.splice(rest.indexOf(col.name), 0, moved);
                        set({ columns: rest });
                      }}
                      className={`flex items-center gap-2 text-xs text-soft ${shown ? "cursor-grab" : ""}`}
                      data-table-column={col.name}
                    >
                      <input
                        type="checkbox"
                        checked={shown}
                        onChange={() => set({ columns: shown ? all.filter((n) => n !== col.name) : [...all, col.name] })}
                        className="accent-[var(--color-ocean)]"
                      />
                      {col.name}
                      {shown && <span className="ml-auto text-muted" title="Drag to reorder">⋮⋮</span>}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Field label="Sort by">{colSelect(c.sort, (sort) => set({ sort }), cols, "Unsorted")}</Field>
              <Field label="Order">
                <select value={c.descending ? "desc" : "asc"} onChange={(e) => set({ descending: e.target.value === "desc" })} className={fieldClass}>
                  <option value="asc">Asc</option>
                  <option value="desc">Desc</option>
                </select>
              </Field>
            </div>
            <Field label="Rows shown">
              <input type="number" min={1} max={5000} value={c.limit ?? 200} onChange={(e) => set({ limit: Number(e.target.value) || 200 })} className={inputClass} />
            </Field>
          </>
        )}

        {c.source && WIDGET_FILTER_TYPES.has(widget.type) && (
          <Field label="Widget filters" hint="Rows this widget always leaves out (on top of the module's filters); a value may be $var:name">
            <div className="space-y-1" data-widget-filters>
              {(c.filters ?? []).map((f, i) => {
                const setF = (x: Partial<Filter>) => set({ filters: (c.filters ?? []).map((g, j) => (j === i ? { ...g, ...x } : g)) });
                return (
                  <div key={i} className="flex gap-1" data-widget-filter={i}>
                    <select value={f.column} onChange={(e) => setF({ column: e.target.value })} className={`${fieldClass} w-28 min-w-0 text-xs`}>
                      <option value="">Column…</option>
                      {cols.map((x) => (
                        <option key={x.name} value={x.name}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                    <select value={f.op} onChange={(e) => setF({ op: e.target.value as Filter["op"] })} className={`${fieldClass} text-xs`}>
                      {WIDGET_FILTER_OPS.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                    {f.op !== "is_null" && f.op !== "not_null" && (
                      <input
                        value={Array.isArray(f.value) ? f.value.join(", ") : String(f.value ?? "")}
                        onChange={(e) => setF({ value: f.op === "in" && !e.target.value.startsWith("$var:") ? e.target.value.split(",").map((x) => x.trim()) : e.target.value })}
                        placeholder={f.op === "in" ? "a, b, c" : "value"}
                        className={`${fieldClass} min-w-0 flex-1 text-xs`}
                      />
                    )}
                    <button type="button" onClick={() => set({ filters: (c.filters ?? []).filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad" title="Remove this filter">
                      ✕
                    </button>
                  </div>
                );
              })}
              <button type="button" onClick={() => set({ filters: [...(c.filters ?? []), { column: "", op: "eq", value: "" }] })} className="text-xs text-ocean" data-widget-filter-add>
                + Filter
              </button>
            </div>
          </Field>
        )}

        {c.source && (widget.type === "bar" || widget.type === "pie" || widget.type === "line") && (
          <Field label={widget.type === "line" ? "X axis (time or ordered column)" : "Group by"}>{colSelect(c.group_by, (group_by) => set({ group_by }))}</Field>
        )}
        {c.source && widget.type === "line" && (
          <Field label="Time bucket" hint="Groups dates and timestamps by day, month or year">
            <select value={c.bucket ?? ""} onChange={(e) => set({ bucket: (e.target.value || undefined) as WidgetConfig["bucket"] })} className={inputClass}>
              <option value="">None (exact values)</option>
              <option value="day">Day</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
            </select>
          </Field>
        )}
        {c.source && (widget.type === "metric" || widget.type === "bar" || widget.type === "pie" || widget.type === "line") && (
          <>
            <Field label="Measure">
              <select value={c.metric ?? "count"} onChange={(e) => set({ metric: e.target.value as Metric })} className={inputClass}>
                {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => (
                  <option key={m} value={m}>
                    {METRIC_LABEL[m]}
                  </option>
                ))}
              </select>
            </Field>
            {c.metric && c.metric !== "count" && (
              <Field label="Of column">{colSelect(c.metric_column, (metric_column) => set({ metric_column }), c.metric === "distinct" ? cols : numeric)}</Field>
            )}
          </>
        )}
        {c.source && widget.type === "metric" && (
          <Field label="Label">
            <input value={c.label ?? ""} onChange={(e) => set({ label: e.target.value })} placeholder="e.g. Total Credit Amount" className={inputClass} />
          </Field>
        )}
        {widget.type === "custom" && <CustomWidgetConfig widget={widget} set={set} sources={sources} variables={mod.variables ?? []} />}
        {widget.type === "audio_recorder" && (
          <>
            <Field label="Action" hint="Its media parameter gets the recording; modify actions use the object selected in a table">
              <select value={c.action_type_id ?? ""} onChange={(e) => set({ action_type_id: e.target.value || undefined })} className={inputClass}>
                <option value="">Choose an action…</option>
                {actions
                  .filter((a) => a.parameters.some((p) => p.type === "media"))
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.display_name}
                    </option>
                  ))}
              </select>
            </Field>
            {(actions.find((a) => a.id === c.action_type_id)?.parameters.filter((p) => p.type === "media").length ?? 0) > 1 && (
              <Field label="Recording parameter">
                <select value={c.column ?? ""} onChange={(e) => set({ column: e.target.value || undefined })} className={inputClass}>
                  {actions
                    .find((a) => a.id === c.action_type_id)!
                    .parameters.filter((p) => p.type === "media")
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.display_name}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <Field label="Button text">
              <input value={c.label ?? ""} onChange={(e) => set({ label: e.target.value })} placeholder="The action's name" className={inputClass} />
            </Field>
          </>
        )}
        {c.source && widget.type === "image_annotation" && (
          <>
            <Field label="Image column" hint="A media reference property with the image; follows the object selected in a table on the same source">
              {colSelect(c.column, (column) => set({ column }), cols.filter((col) => col.type === "Media" || col.type === "String"))}
            </Field>
            <Field label="Annotation object type">
              <select
                value={c.annotation_type_id ?? ""}
                onChange={(e) => set({ annotation_type_id: e.target.value || undefined, annotation_link: undefined, annotation_box: undefined, annotation_label: undefined, action_type_id: undefined, annotation_modify_action: undefined, annotation_delete_action: undefined })}
                className={inputClass}
              >
                <option value="">Choose an object type…</option>
                {sources.object_types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            {(() => {
              const props = sources.object_types.find((t) => t.id === c.annotation_type_id)?.properties ?? [];
              const pick = (value: string | undefined, onPick: (v: string | undefined) => void) => (
                <select value={value ?? ""} onChange={(e) => onPick(e.target.value || undefined)} className={inputClass}>
                  <option value="">Choose a property…</option>
                  {props.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.label} · {p.type}
                    </option>
                  ))}
                </select>
              );
              return (
                c.annotation_type_id && (
                  <>
                    <Field label="Image object property" hint="Holds the annotated object's primary key">
                      {pick(c.annotation_link, (annotation_link) => set({ annotation_link }))}
                    </Field>
                    <Field label="Box property" hint={'A string: JSON {"x", "y", "w", "h"} as fractions of the image; polygons {"type": "polygon", "points": [[x, y], …]}, points {"type": "point", "x", "y"}, PDF text spans {"type": "text", "page", "start", "end", "quote", "boxes"}'}>
                      {pick(c.annotation_box, (annotation_box) => set({ annotation_box }))}
                    </Field>
                    <Field label="Label property">{pick(c.annotation_label, (annotation_label) => set({ annotation_label }))}</Field>
                    <Field label="Create action" hint="Gets the image object, box and label through the parameters setting those properties">
                      <select value={c.action_type_id ?? ""} onChange={(e) => set({ action_type_id: e.target.value || undefined })} className={inputClass}>
                        <option value="">None (view only)</option>
                        {actions
                          .filter((a) => a.object_type_id === c.annotation_type_id && a.kind === "create")
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.display_name}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <Field label="Drawing tools" hint="Text spans only on PDFs; none ticked: all">
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        {(
                          [
                            ["rect", "Rectangle"],
                            ["polygon", "Polygon"],
                            ["point", "Point"],
                            ["text", "Text span"],
                          ] as const
                        ).map(([t, l]) => (
                          <label key={t} className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={(c.annotation_tools ?? []).includes(t)}
                              onChange={(e) => {
                                const next = (c.annotation_tools ?? []).filter((x) => x !== t);
                                set({ annotation_tools: e.target.checked ? [...next, t] : next.length ? next : undefined });
                              }}
                            />
                            {l}
                          </label>
                        ))}
                      </div>
                    </Field>
                    <Field label="Modify action" hint="Runs on a selected annotation after moving, resizing or relabeling it: its object parameter gets the annotation, the box and label through the parameters setting those properties">
                      <select value={c.annotation_modify_action ?? ""} onChange={(e) => set({ annotation_modify_action: e.target.value || undefined })} className={inputClass}>
                        <option value="">None (no editing)</option>
                        {actions
                          .filter((a) => a.object_type_id === c.annotation_type_id && a.kind !== "create" && a.kind !== "delete" && a.parameters.some((p) => p.type === "object"))
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.display_name}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <Field label="Delete action" hint="Deletes a selected annotation (its object parameter); none: no delete button">
                      <select value={c.annotation_delete_action ?? ""} onChange={(e) => set({ annotation_delete_action: e.target.value || undefined })} className={inputClass}>
                        <option value="">None (no delete)</option>
                        {actions
                          .filter((a) => a.object_type_id === c.annotation_type_id && a.kind !== "create" && a.parameters.some((p) => p.type === "object"))
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.display_name}
                            </option>
                          ))}
                      </select>
                    </Field>
                  </>
                )
              );
            })()}
          </>
        )}
        {c.source && widget.type === "transcription" && (
          <>
            <Field label="Audio column" hint="A media reference property or column with audio (or video); follows the object selected in a table on the same source">
              {colSelect(c.column, (column) => set({ column }), cols.filter((col) => col.type === "Media" || col.type === "String"))}
            </Field>
            <Field label="Language" hint="Empty: detected">
              <input value={c.language ?? ""} onChange={(e) => set({ language: e.target.value })} placeholder="indonesian" className={inputClass} />
            </Field>
          </>
        )}
        {c.source && widget.type === "media" && (
          <Field label="Media column" hint="A media reference property or column; shows the object selected in a table on the same source">
            {colSelect(c.column, (column) => set({ column }), cols.filter((col) => col.type === "Media" || col.type === "String"))}
          </Field>
        )}
        {c.source && widget.type === "filter" && (
          <>
            <Field label="Column" hint="Filters every widget on the same source">{colSelect(c.column, (column) => set({ column }))}</Field>
            <Field label="Label">
              <input value={c.label ?? ""} onChange={(e) => set({ label: e.target.value })} placeholder={c.column} className={inputClass} />
            </Field>
          </>
        )}

        <div className="grid grid-cols-4 gap-2 border-t border-line pt-4">
          {(["x", "y", "w", "h"] as const).map((k) => (
            <Field key={k} label={{ x: "Column", y: "Row", w: "Width", h: "Height" }[k]}>
              <input
                type="number"
                min={k === "w" || k === "h" ? 1 : 0}
                max={k === "x" ? COLS - widget.w : k === "w" ? COLS - widget.x : undefined}
                value={widget[k]}
                onChange={(e) => onChange({ [k]: Math.max(k === "w" || k === "h" ? 1 : 0, Number(e.target.value) || 0) })}
                className={`${fieldClass} w-full`}
              />
            </Field>
          ))}
        </div>
      </div>
    </div>
  );
}
