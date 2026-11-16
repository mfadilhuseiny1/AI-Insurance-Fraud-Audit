"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/Icon";
import { Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, Modal } from "@/components/pipeline/Modal";
import { API_URL } from "@/lib/api";
import { workshop, type Freshness, type Module, type ModuleSettings, type SavedColor, type Sources, type Widget, type WidgetConfig } from "@/lib/workshop";
import { profiler, profilerOn, type ProfEvent } from "@/lib/workshopProfiler";
import { MobileSettingsPanel } from "./MobileWidgets";
import type { ModuleState } from "./WidgetView";

const lab = "block text-[11px] text-muted";
const setS = (mod: Module, setMod: (m: Module) => void, x: Partial<ModuleSettings>) => setMod({ ...mod, settings: { ...mod.settings, ...x } });

// ------------------------------------------------------------------------------------------------
// saved colors, redact mode
// ------------------------------------------------------------------------------------------------

/** CSS variables for the module's saved colors, light and dark. */
export function savedColorsCss(colors: SavedColor[] | undefined): string {
  if (!colors?.length) return "";
  const dark = colors.map((c) => `--ws-color-${c.id}:${c.dark || c.light};`).join("");
  const light = colors.map((c) => `--ws-color-${c.id}:${c.light || c.dark};`).join("");
  return `:root{${dark}}:root[data-theme="light"]{${light}}`;
}

/** Redact mode (?workshop_enableRedactMode=true): text as masked glyphs of the same length, charts and icons as
 * stripes, media hidden. A visual aid for screenshots, not a security feature. */
export const REDACT_CSS = `
.ws-redact, .ws-redact * { -webkit-text-security: disc; text-security: disc; }
.ws-redact input, .ws-redact textarea, .ws-redact select { -webkit-text-security: disc; }
.ws-redact img, .ws-redact video, .ws-redact audio, .ws-redact iframe, .ws-redact canvas { visibility: hidden !important; }
.ws-redact [data-widget] svg { visibility: hidden !important; }
.ws-redact [data-widget] :has(> svg) { background: repeating-linear-gradient(45deg, var(--color-line) 0 6px, transparent 6px 12px) !important; }
`;

/** Where colors are used: saved ones by their variable, unsaved hex codes in layouts and widgets. */
function colorUses(mod: Module) {
  const saved: Record<string, string[]> = {};
  const unsaved: Record<string, string[]> = {};
  const scan = (where: string, x: unknown) => {
    const s = JSON.stringify(x ?? {});
    for (const m of s.matchAll(/var\(--ws-color-([\w-]+)\)/g)) {
      const list = (saved[m[1]] ??= []);
      if (!list.includes(where)) list.push(where);
    }
    for (const m of s.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
      const list = (unsaved[m[0].toLowerCase()] ??= []);
      if (!list.includes(where)) list.push(where);
    }
  };
  for (const w of mod.widgets) scan(`${w.title || w.type} (${w.id})`, w.config);
  for (const p of mod.pages ?? []) scan(`page ${p.name}`, p);
  scan("header", mod.settings?.header);
  return { saved, unsaved };
}

// ------------------------------------------------------------------------------------------------
// the Settings panel
// ------------------------------------------------------------------------------------------------

export function SettingsPanel({ mod, setMod, sources, selection }: { mod: Module; setMod: (m: Module) => void; sources: Sources; selection?: Record<string, string | undefined> }) {
  const st = mod.settings ?? {};
  const ar = st.auto_refresh ?? {};
  const setAr = (x: Partial<NonNullable<ModuleSettings["auto_refresh"]>>) => setS(mod, setMod, { auto_refresh: { ...ar, ...x } });
  const used = useMemo(() => colorUses(mod), [mod]);
  const colors = st.colors ?? [];
  const setColors = (c: SavedColor[]) => setS(mod, setMod, { colors: c });
  // object types the module reads: a sensible default for auto-refresh
  const readTypes = [...new Set(mod.widgets.map((w) => (w.config.source?.kind === "object_type" ? w.config.source.id : "")).filter(Boolean))];
  return (
    <div className="space-y-4 text-xs" data-settings>
      <MobileSettingsPanel mod={mod} setMod={setMod} />
      <StartingSelection mod={mod} setMod={setMod} sources={sources} selection={selection} />
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-muted">Auto-refresh</div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!ar.enabled} onChange={(e) => setAr({ enabled: e.target.checked, object_type_ids: ar.object_type_ids?.length ? ar.object_type_ids : readTypes })} data-auto-refresh /> Reload the module when watched object types change
        </label>
        {ar.enabled && (
          <div className="mt-2 space-y-2">
            <div className={lab}>Watched object types</div>
            <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
              {sources.object_types.map((t) => {
                const on = (ar.object_type_ids ?? []).includes(t.id);
                return (
                  <button key={t.id} type="button" onClick={() => setAr({ object_type_ids: on ? (ar.object_type_ids ?? []).filter((x) => x !== t.id) : [...(ar.object_type_ids ?? []), t.id] })} className={`rounded border px-1.5 py-0.5 ${on ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-muted"}`}>
                    {t.name}
                  </button>
                );
              })}
            </div>
            <label className={lab}>
              Minimum seconds between refreshes (10 or more)
              <input type="number" min={10} value={ar.min_seconds ?? 10} onChange={(e) => setAr({ min_seconds: Math.max(10, Number(e.target.value) || 10) })} className={`${fieldClass} mt-1 w-24 text-xs`} />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={!!ar.disable_in_edit} onChange={(e) => setAr({ disable_in_edit: e.target.checked })} /> Off in edit mode
            </label>
            <p className="text-muted">Pause or resume updates with the “Enable / disable auto-refresh updates” event; only visible tabs refresh.</p>
          </div>
        )}
      </div>
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-muted">Advanced functionalities</div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!st.kiosk} onChange={(e) => setS(mod, setMod, { kiosk: e.target.checked })} data-kiosk-toggle /> Kiosk mode (an “Open kiosk” button in view mode)
        </label>
        <label className="mt-1 flex items-center gap-2">
          <input type="checkbox" checked={!!st.translations?.enabled} onChange={(e) => setS(mod, setMod, { translations: { base: "id", languages: {}, ...st.translations, enabled: e.target.checked } })} data-translations-toggle /> Translations (a Translations tab)
        </label>
        <p className="mt-1 text-muted">
          Redact mode: add <code>?workshop_enableRedactMode=true</code> to the URL (a visual aid for screenshots, not security).
        </p>
      </div>
      <div data-used-colors>
        <div className="mb-1 font-semibold uppercase tracking-wide text-muted">Used colors</div>
        <div className={lab}>Saved colors (selectable as backgrounds; an edit changes every use)</div>
        {colors.map((c, i) => (
          <div key={c.id} className="mt-1 flex items-center gap-1">
            <input value={c.name} onChange={(e) => setColors(colors.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${fieldClass} min-w-0 flex-1 text-xs`} />
            <input type="color" value={c.light} onChange={(e) => setColors(colors.map((x, j) => (j === i ? { ...x, light: e.target.value } : x)))} className="h-5 w-6 bg-transparent" title="Light mode" />
            <input type="color" value={c.dark} onChange={(e) => setColors(colors.map((x, j) => (j === i ? { ...x, dark: e.target.value } : x)))} className="h-5 w-6 bg-transparent" title="Dark mode" />
            <span className="w-8 text-right text-muted" title={(used.saved[c.id] ?? []).join("\n") || "Not used"}>
              {(used.saved[c.id] ?? []).length}×
            </span>
            <button type="button" disabled={!!used.saved[c.id]?.length} onClick={() => setColors(colors.filter((_, j) => j !== i))} className="px-1 text-muted hover:text-bad disabled:opacity-30" title={used.saved[c.id]?.length ? "In use" : "Delete"}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setColors([...colors, { id: `c${Date.now().toString(36)}`, name: `Color ${colors.length + 1}`, light: "#1f6feb", dark: "#58a6ff" }])} className="mt-1 text-ocean">
          + Saved color
        </button>
        <div className={`${lab} mt-2`}>Unsaved colors (custom hex codes in layouts and widgets; select to copy)</div>
        <div className="mt-1 space-y-0.5">
          {Object.entries(used.unsaved).map(([hex, where]) => (
            <div key={hex} className="flex items-center gap-1">
              <span className="h-3 w-3 rounded" style={{ background: hex }} />
              <button type="button" onClick={() => void navigator.clipboard?.writeText(hex)} className="font-mono text-soft hover:text-white" title="Copy">
                {hex}
              </button>
              <span className="truncate text-muted" title={where.join("\n")}>
                {where.length} use{where.length === 1 ? "" : "s"}
              </span>
              <button type="button" onClick={() => setColors([...colors, { id: `c${Date.now().toString(36)}`, name: hex, light: hex, dark: hex }])} className="ml-auto text-ocean" title="Add as a saved color">
                Save
              </button>
            </div>
          ))}
          {!Object.keys(used.unsaved).length && <p className="text-muted">None.</p>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// translations
// ------------------------------------------------------------------------------------------------

/** The module's translatable strings: header and page names, widget titles, tabs, button labels, Markdown text, steps. */
export function translatable(mod: Module): { source: string; where: string }[] {
  const out = new Map<string, string>();
  const add = (s: unknown, where: string) => typeof s === "string" && s.trim() && !out.has(s) && out.set(s, where);
  add(mod.settings?.header?.title || mod.name, "header title");
  for (const p of mod.pages ?? []) add(p.name, "page");
  for (const o of mod.overlays ?? []) add(o.title, "overlay title");
  for (const w of mod.widgets) {
    const at = `${w.type} ${w.id}`;
    add(w.title, `${at} title`);
    const c = w.config;
    if (w.type === "text") add(c.text, `${at} text`);
    for (const t of c.tabs ?? []) add(t.name, `${at} tab`);
    for (const b of c.buttons ?? []) add(b.label, `${at} button`);
    for (const s of c.steps ?? []) add(s.label, `${at} step`);
    if (w.type === "button") add(c.label, `${at} label`);
  }
  return [...out].map(([source, where]) => ({ source, where }));
}

export function TranslationsPanel({ mod, setMod, lang, setLang }: { mod: Module; setMod: (m: Module) => void; lang: string | null; setLang: (l: string | null) => void }) {
  const tr = mod.settings?.translations ?? {};
  const langs = tr.languages ?? {};
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = lang && langs[lang] ? lang : null;
  const strings = translatable(mod);
  const save = (l: string, x: Partial<{ strings: Record<string, string>; complete: string[] }>) =>
    setS(mod, setMod, { translations: { ...tr, languages: { ...langs, [l]: { ...(langs[l] ?? { strings: {}, complete: [] }), ...x } } } });
  const cur = target ? langs[target] : null;
  const todo = strings.filter((s) => !cur?.complete?.includes(s.source));
  const done = strings.filter((s) => cur?.complete?.includes(s.source));
  const aip = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const pending = todo.map((s) => s.source);
      const prompt = `Translate each string of this JSON array from the language "${tr.base || "auto"}" into the language "${target}". Keep Markdown, {{variables}} and placeholders as they are. Answer with only a JSON object mapping each original string to its translation.\n\n${JSON.stringify(pending)}`;
      const res = await fetch(`${API_URL}/api/functions/llm/chat`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail ?? res.statusText);
      const text = String(body.text ?? "");
      const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, string>;
      save(target, { strings: { ...cur?.strings, ...Object.fromEntries(Object.entries(json).filter(([k, v]) => pending.includes(k) && typeof v === "string")) } });
    } catch (e) {
      setError(`AIP translation failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const row = (s: { source: string; where: string }) => (
    <div key={s.source} className="space-y-1 rounded border border-line p-1.5" data-translation={s.source.slice(0, 40)}>
      <div className="truncate text-muted" title={`${s.where}: ${s.source}`}>
        {s.source.slice(0, 120)}
      </div>
      <div className="flex gap-1">
        {s.source.length > 60 ? (
          <textarea rows={3} value={cur?.strings[s.source] ?? ""} onChange={(e) => save(target!, { strings: { ...cur?.strings, [s.source]: e.target.value } })} className={`${fieldClass} min-w-0 flex-1 text-xs`} />
        ) : (
          <input value={cur?.strings[s.source] ?? ""} onChange={(e) => save(target!, { strings: { ...cur?.strings, [s.source]: e.target.value } })} className={`${fieldClass} min-w-0 flex-1 text-xs`} />
        )}
        <button
          type="button"
          onClick={() => save(target!, { complete: cur?.complete?.includes(s.source) ? cur.complete.filter((x) => x !== s.source) : [...(cur?.complete ?? []), s.source] })}
          className={`px-1 ${cur?.complete?.includes(s.source) ? "text-ok" : "text-muted hover:text-white"}`}
          title={cur?.complete?.includes(s.source) ? "Back to “To translate”" : "Mark as complete"}
        >
          <Icon name="check" className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
  return (
    <div className="space-y-3 text-xs" data-translations>
      <label className={lab}>
        Starting language of the module
        <input value={tr.base ?? ""} onChange={(e) => setS(mod, setMod, { translations: { ...tr, base: e.target.value } })} placeholder="id, en…" className={`${fieldClass} mt-1 w-24 text-xs`} />
      </label>
      <div className="flex flex-wrap items-center gap-1">
        {Object.keys(langs).map((l) => (
          <button key={l} type="button" onClick={() => setLang(target === l ? null : l)} className={`rounded border px-2 py-0.5 ${target === l ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-muted"}`} data-lang={l}>
            {l}
          </button>
        ))}
        <input value={code} onChange={(e) => setCode(e.target.value.trim())} placeholder="en, fr-FR…" className={`${fieldClass} w-20 text-xs`} />
        <button type="button" disabled={!code || !!langs[code]} onClick={() => (save(code, { strings: {}, complete: [] }), setLang(code), setCode(""))} className="text-ocean disabled:opacity-40">
          + Language
        </button>
      </div>
      {target ? (
        <>
          <p className="text-muted">Previewing “{target}” in the module. Viewers whose browser language is {target} see it.</p>
          <button type="button" onClick={aip} disabled={busy || !todo.length} className={buttonClass.secondary} data-aip-translate>
            <Icon name="sparkle" className="h-3.5 w-3.5 text-ocean" /> {busy ? "Translating…" : `Translate ${todo.length} with AIP`}
          </button>
          {error && <p className="text-bad">{error}</p>}
          <div className="font-semibold text-soft">To translate · {todo.length}</div>
          {todo.map(row)}
          <div className="font-semibold text-soft">Complete · {done.length}</div>
          {done.map(row)}
        </>
      ) : (
        <p className="text-muted">Add or select a target language.</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Performance Profiler
// ------------------------------------------------------------------------------------------------

function useProfile() {
  const events = useSyncExternalStore(profiler.subscribe, profiler.events, profiler.events);
  const load = useSyncExternalStore(profiler.subscribe, profiler.loadTime, profiler.loadTime);
  return { events, load };
}

const reloadWith = (on: boolean) => {
  const u = new URL(window.location.href);
  if (on) {
    u.searchParams.set("profiler", "1");
    u.searchParams.set("edit", "1");
  } else u.searchParams.delete("profiler");
  window.location.assign(u.toString());
};

export function ProfilerBanner() {
  const { events, load } = useProfile();
  return (
    <div className="flex shrink-0 items-center gap-3 bg-warn/15 px-4 py-1.5 text-xs text-warn" data-profiler-banner>
      <Icon name="gauge" className="h-3.5 w-3.5" /> Profiler mode: recording widget and variable loads · {events.length} captured{load !== null ? ` · module loaded in ${(load / 1000).toFixed(2)} s` : ""}
      <button type="button" onClick={() => reloadWith(false)} className="ml-auto underline">
        Exit
      </button>
    </div>
  );
}

export function ProfilerPanel({ mod }: { mod: Module }) {
  const { events, load } = useProfile();
  const [q, setQ] = useState("");
  const [where, setWhere] = useState("");
  if (!profilerOn())
    return (
      <div className="space-y-2 text-xs" data-profiler>
        <p className="text-muted">Records how long each widget and variable takes to load, from the module&apos;s start. The page reloads in Profiler mode.</p>
        <button type="button" onClick={() => reloadWith(true)} className={buttonClass.primary} data-profiler-start>
          <Icon name="gauge" className="h-3.5 w-3.5" /> Reload in Profiler mode
        </button>
      </div>
    );
  const containerName = (k: string) => {
    if (!k) return "Page 1";
    const [kind, id] = k.split(":");
    if (kind === "page") return `Page · ${mod.pages?.find((p) => p.id === id)?.name ?? id}`;
    if (kind === "overlay") return `Overlay · ${mod.overlays?.find((o) => o.id === id)?.name ?? id}`;
    if (kind === "header") return "Header";
    return `In ${mod.widgets.find((w) => w.id === kind)?.title || kind}`;
  };
  const containers = [...new Set(events.map((e) => e.container))];
  const shown = events.filter((e) => (!where || e.container === where) && (!q || e.name.toLowerCase().includes(q.toLowerCase())));
  const t0 = 0;
  const t1 = Math.max(1, ...events.map((e) => e.end));
  const per = new Map<string, { e: ProfEvent; n: number; total: number; max: number }>();
  for (const e of shown) {
    const k = `${e.kind}:${e.id}`;
    const d = e.end - e.start;
    const x = per.get(k);
    per.set(k, x ? { e, n: x.n + 1, total: x.total + d, max: Math.max(x.max, d) } : { e, n: 1, total: d, max: d });
  }
  return (
    <div className="space-y-2 text-xs" data-profiler>
      <div className="flex items-center gap-2">
        <span className="font-semibold">Module load: {load !== null ? `${(load / 1000).toFixed(2)} s` : "loading…"}</span>
        <button type="button" onClick={profiler.clear} className="ml-auto text-muted hover:text-white">
          Clear
        </button>
        <button type="button" onClick={() => reloadWith(false)} className="text-ocean">
          Exit
        </button>
      </div>
      <div className="flex gap-1">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search widgets and variables" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
        <select value={where} onChange={(e) => setWhere(e.target.value)} className={`${fieldClass} text-xs`}>
          <option value="">Everywhere</option>
          {containers.map((k) => (
            <option key={k} value={k}>
              {containerName(k)}
            </option>
          ))}
        </select>
      </div>
      <div className="text-muted">Timeline (0 – {(t1 / 1000).toFixed(1)} s)</div>
      <div className="max-h-48 space-y-0.5 overflow-y-auto" data-profiler-timeline>
        {shown.map((e) => (
          <div key={e.seq} className="relative h-3.5 rounded bg-ink" title={`${e.kind} ${e.name}: ${Math.round(e.end - e.start)} ms${e.ok ? "" : " (failed)"}`}>
            <span className={`absolute inset-y-0 rounded ${e.kind === "widget" ? "bg-ocean/70" : "bg-ok/70"} ${e.ok ? "" : "bg-bad/70"}`} style={{ left: `${((e.start - t0) / t1) * 100}%`, width: `max(2px, ${((e.end - e.start) / t1) * 100}%)` }} />
            <span className="absolute left-1 top-0 truncate text-[9px] leading-[14px] text-white">{e.name}</span>
          </div>
        ))}
      </div>
      <div className="text-muted">Breakdown (slowest first)</div>
      <table className="w-full" data-profiler-breakdown>
        <tbody>
          {[...per.values()]
            .sort((a, b) => b.max - a.max)
            .map(({ e, n, total, max }) => (
              <tr key={`${e.kind}:${e.id}`} className="border-t border-line">
                <td className="py-0.5">
                  <span className={e.kind === "widget" ? "text-ocean" : "text-ok"}>{e.kind === "widget" ? "W" : "V"}</span> {e.name}
                </td>
                <td className="text-right text-muted">{n}×</td>
                <td className="text-right">{Math.round(max)} ms</td>
                <td className="text-right text-muted">{Math.round(total)} ms</td>
              </tr>
            ))}
        </tbody>
      </table>
      <p className="text-muted">Only widgets and variables that load data are timed; switch pages, open overlays or run events to capture more.</p>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// kiosk mode
// ------------------------------------------------------------------------------------------------

/** What a kiosk session can read: the object types the module references (widgets, variables, derived properties);
 * action types are listed as off (sessions are read-only). */
export function KioskLaunch({ mod, sources, onClose, onLaunch }: { mod: Module; sources: Sources; onClose: () => void; onLaunch: () => void }) {
  const s = JSON.stringify([mod.widgets, mod.variables, mod.derived]);
  const types = sources.object_types.filter((t) => s.includes(t.id));
  const actions = [...new Set([...s.matchAll(/"(act-[0-9a-f]+)"/g)].map((m) => m[1]))];
  const modules = [...new Set([...s.matchAll(/"(wsm-[0-9a-f]+)"/g)].map((m) => m[1]))].filter((x) => x !== mod.id);
  return (
    <Modal title="Launch kiosk session" icon="device" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm" data-kiosk-modal>
        <p className="text-muted">A long-lived, read-only session of the published version: actions, comments and other writes are off.</p>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Content in scope</div>
          <ul className="space-y-0.5 text-xs">
            {types.map((t) => (
              <li key={t.id}>
                <Icon name="cube" className="mr-1 inline h-3 w-3 text-ocean" />
                {t.name}
              </li>
            ))}
            {modules.map((m) => (
              <li key={m}>
                <Icon name="device" className="mr-1 inline h-3 w-3 text-ocean" />
                Embedded module {m}
              </li>
            ))}
            {actions.length > 0 && <li className="text-muted">{actions.length} action type(s): off in kiosk mode</li>}
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" onClick={onLaunch} className={buttonClass.primary} data-kiosk-launch>
            Open kiosk
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------
// Data Freshness widget
// ------------------------------------------------------------------------------------------------

function relative(at: string): string {
  const ms = Date.now() - Date.parse(at);
  if (ms > 86_400_000) return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

export function DataFreshnessWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const ids = c.freshness_types?.length ? c.freshness_types : c.source?.kind === "object_type" ? [c.source.id] : [];
  const key = ids.join(",");
  const [f, setF] = useState<Freshness | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!key) return;
    let stale = false;
    workshop.freshness(key.split(",")).then((x) => !stale && setF(x), () => !stale && setF({}));
    return () => {
      stale = true;
    };
  }, [key, state.version, tick]);
  if (!ids.length) return <div className="flex h-full items-center justify-center p-2 text-xs text-muted">Choose object types in the panel</div>;
  return (
    <div className="flex h-full flex-col justify-center gap-0.5 px-3 text-xs" data-freshness>
      {ids.map((id) => {
        const x = f?.[id];
        return (
          <div key={id} className="flex items-center gap-1.5 truncate">
            <Icon name="clock" className="h-3 w-3 shrink-0 text-muted" />
            <span className="text-soft">{x?.name ?? id}</span>
            <span className="text-muted">· updated {x?.updated_at ? relative(x.updated_at) : "—"}</span>
          </div>
        );
      })}
      {state.autoRefresh === false && <div className="text-warn">Auto-refresh updates paused</div>}
    </div>
  );
}

export function FreshnessConfig({ widget, set, sources }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; sources: Sources }) {
  const v = widget.config.freshness_types ?? [];
  return (
    <Field label="Object types (empty: the source)">
      <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
        {sources.object_types.map((t) => (
          <button key={t.id} type="button" onClick={() => set({ freshness_types: v.includes(t.id) ? v.filter((x) => x !== t.id) : [...v, t.id] })} className={`rounded border px-1.5 py-0.5 text-[11px] ${v.includes(t.id) ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-muted"}`}>
            {t.name}
          </button>
        ))}
      </div>
    </Field>
  );
}

/** The objects selected when the module opens (settings.default_selection: source key → primary key), so selection-
 * driven widgets (object views, functions on the selection, inline actions) show something before anyone clicks. */
function StartingSelection({ mod, setMod, sources, selection }: { mod: Module; setMod: (m: Module) => void; sources: Sources; selection?: Record<string, string | undefined> }) {
  const sel = mod.settings?.default_selection ?? {};
  const put = (next: Record<string, string>) => setS(mod, setMod, { default_selection: Object.keys(next).length ? next : undefined });
  const current = Object.fromEntries(Object.entries(selection ?? {}).filter((e): e is [string, string] => !!e[1] && e[0].startsWith("object_type:")));
  const name = (key: string) => sources.object_types.find((t) => `object_type:${t.id}` === key)?.name ?? key;
  const [type, setType] = useState("");
  return (
    <div data-starting-selection>
      <div className="mb-1 font-semibold uppercase tracking-wide text-muted">Starting selection</div>
      <p className="mb-1 text-muted">Objects selected when the module opens.</p>
      {Object.entries(sel).map(([k, pk]) => (
        <div key={k} className="mb-1 flex items-center gap-1" data-starting-row={k}>
          <span className="w-28 truncate" title={name(k)}>{name(k)}</span>
          <input value={pk} onChange={(e) => put({ ...sel, [k]: e.target.value })} className={`${fieldClass} min-w-0 flex-1 font-mono text-xs`} />
          <button type="button" onClick={() => put(Object.fromEntries(Object.entries(sel).filter(([x]) => x !== k)))} className="px-1 text-muted hover:text-bad" title="Remove">
            ✕
          </button>
        </div>
      ))}
      <div className="flex gap-1">
        <select value={type} onChange={(e) => setType(e.target.value)} className={`${fieldClass} min-w-0 flex-1 text-xs`} data-starting-type>
          <option value="">Object type…</option>
          {sources.object_types
            .filter((t) => !(`object_type:${t.id}` in sel))
            .map((t) => (
              <option key={t.id} value={`object_type:${t.id}`}>
                {t.name}
              </option>
            ))}
        </select>
        <button type="button" disabled={!type} onClick={() => (put({ ...sel, [type]: current[type] ?? "" }), setType(""))} className="text-xs text-ocean disabled:opacity-40" data-starting-add>
          + Add
        </button>
      </div>
      {Object.keys(current).length > 0 && JSON.stringify(current) !== JSON.stringify(sel) && (
        <button type="button" onClick={() => put(current)} className="mt-1 text-xs text-ocean" data-starting-current title={Object.entries(current).map(([k, v]) => `${name(k)}: ${v}`).join(", ")}>
          Use the current selection
        </button>
      )}
    </div>
  );
}
