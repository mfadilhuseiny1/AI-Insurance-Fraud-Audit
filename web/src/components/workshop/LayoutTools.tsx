"use client";

import { Icon, type IconName } from "@/components/Icon";
import { fieldClass } from "@/components/pipeline/Modal";
import { BACKGROUNDS, savedColorVar, type Background, type SavedColor, type Module, type ModuleHeader, type Padding, type Variable, type Widget } from "@/lib/workshop";
import type { ModuleState } from "./WidgetView";

/** Every widget inside a container widget (tabs, sections), however deep. */
export function descendants(widgets: Widget[], id: string): Widget[] {
  const out: Widget[] = [];
  const walk = (pid: string) => {
    for (const w of widgets)
      if (w.parent && w.parent.startsWith(`${pid}:`)) {
        out.push(w);
        walk(w.id);
      }
  };
  walk(id);
  return out;
}

const VAR_REFS = /\$var:([\w-]+)|\{\{\s*([\w-]+)\s*\}\}|"(?:variable|tab_variable|loop_variable|output_variable|open_variable)":"([\w-]+)"/g;
const refsOf = (x: unknown) => [...JSON.stringify(x ?? {}).matchAll(VAR_REFS)].map((m) => m[1] || m[2] || m[3]);

// ------------------------------------------------------------------------------------------------
// cut, copy and paste of widgets and sections (with their children), within or across modules
// ------------------------------------------------------------------------------------------------

export type Clip = { widgets: Widget[]; variables: Variable[]; from: string };
const CLIP_KEY = "workshop.clipboard";

/** A widget with its children and the variables they use. */
export function clipOf(mod: Module, id: string): Clip | null {
  const root = mod.widgets.find((w) => w.id === id);
  if (!root) return null;
  const widgets = [root, ...descendants(mod.widgets, id)];
  const names = new Set(widgets.flatMap((w) => refsOf(w.config)));
  // and the variables those variables are computed from
  for (let i = 0; i < 3; i++) for (const v of mod.variables ?? []) if (names.has(v.name)) for (const n of refsOf(v.definition)) names.add(n);
  return { widgets, variables: (mod.variables ?? []).filter((v) => names.has(v.name)), from: mod.id };
}
export function writeClip(clip: Clip | null) {
  try {
    if (clip) localStorage.setItem(CLIP_KEY, JSON.stringify(clip));
  } catch {
    // no storage: copy works within this page only
  }
  memo = clip;
}
let memo: Clip | null = null;
export function readClip(): Clip | null {
  try {
    const s = localStorage.getItem(CLIP_KEY);
    if (s) return JSON.parse(s) as Clip;
  } catch {
    // fall back to the in-page copy
  }
  return memo;
}

/** Paste into a container ("" for the first page). "same": the pasted widgets keep using the copied variables (added
 * to this module when missing); "duplicate": new variables are made for them, and the pasted widgets use those. */
export function paste(mod: Module, clip: Clip, into: string, mode: "same" | "duplicate"): { mod: Module; root: string } {
  let next = 1 + Math.max(0, ...mod.widgets.map((w) => Number(w.id.replace(/\D/g, "")) || 0));
  const ids = new Map(clip.widgets.map((w) => [w.id, `w${next++}`]));
  const vars = [...(mod.variables ?? [])];
  const rename = new Map<string, string>();
  for (const v of clip.variables) {
    if (mode === "same") {
      if (!vars.some((x) => x.name === v.name)) vars.push(v);
      continue;
    }
    let n = 2;
    while (vars.some((x) => x.name === `${v.name}_${n}`)) n++;
    rename.set(v.name, `${v.name}_${n}`);
  }
  const swap = <T,>(x: T): T => {
    if (!rename.size) return x;
    const s = JSON.stringify(x).replace(VAR_REFS, (all, a, b, c) => {
      const old = a || b || c;
      const to = rename.get(old);
      if (!to) return all;
      return all.replace(old, to);
    });
    // transformation and definition inputs ({"var": name}, params' "variable")
    return JSON.parse(s.replace(/"var":"([\w-]+)"/g, (all, n) => (rename.has(n) ? `"var":"${rename.get(n)}"` : all))) as T;
  };
  if (mode === "duplicate")
    for (const v of clip.variables) vars.push({ ...swap(v), name: rename.get(v.name)!, external_id: undefined });
  const root = clip.widgets[0];
  const siblings = mod.widgets.filter((w) => (w.parent ?? "") === into);
  const bottom = siblings.reduce((m, w) => Math.max(m, w.y + w.h), 0);
  const pasted = clip.widgets.map((w) => {
    const id = ids.get(w.id)!;
    if (w === root) {
      const { parent: _old, ...rest } = w;
      void _old;
      return { ...rest, id, y: bottom, config: swap(w.config), ...(into ? { parent: into } : {}) };
    }
    const [pid, slot] = String(w.parent).split(":");
    return { ...w, id, parent: `${ids.get(pid) ?? pid}:${slot}`, config: swap(w.config) };
  });
  return { mod: { ...mod, widgets: [...mod.widgets, ...pasted], variables: vars }, root: ids.get(root.id)! };
}

/** Move a widget earlier or later among its siblings (the order of a rows / columns / toolbar / flow section). */
export function reorder(mod: Module, id: string, dir: -1 | 1): Module {
  const w = mod.widgets.find((x) => x.id === id);
  if (!w) return mod;
  const sibs = mod.widgets.filter((x) => (x.parent ?? "") === (w.parent ?? "")).sort((a, b) => a.y - b.y || a.x - b.x);
  const i = sibs.findIndex((x) => x.id === id);
  const j = i + dir;
  if (j < 0 || j >= sibs.length) return mod;
  [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
  const order = new Map(sibs.map((x, k) => [x.id, k]));
  return { ...mod, widgets: mod.widgets.map((x) => (order.has(x.id) ? { ...x, x: 0, y: order.get(x.id)! } : x)) };
}

// ------------------------------------------------------------------------------------------------
// page layout templates
// ------------------------------------------------------------------------------------------------

type Tpl = { id: string; label: string; sections: { title: string; x: number; y: number; w: number; h: number; layout?: Widget["config"]["section_layout"] }[] };
export const TEMPLATES: Tpl[] = [
  { id: "two", label: "Two columns", sections: [{ title: "Section 1", x: 0, y: 0, w: 6, h: 12 }, { title: "Section 2", x: 6, y: 0, w: 6, h: 12 }] },
  { id: "three", label: "Three columns", sections: [0, 4, 8].map((x, i) => ({ title: `Section ${i + 1}`, x, y: 0, w: 4, h: 12 })) },
  { id: "inbox", label: "Inbox (list and details)", sections: [{ title: "Inbox", x: 0, y: 0, w: 4, h: 14, layout: "rows" }, { title: "Details", x: 4, y: 0, w: 8, h: 14 }] },
  { id: "toolbar", label: "Toolbar and body", sections: [{ title: "", x: 0, y: 0, w: 12, h: 2, layout: "toolbar" }, { title: "Body", x: 0, y: 2, w: 12, h: 12 }] },
  { id: "cop", label: "Common operating picture", sections: [{ title: "Metrics", x: 0, y: 0, w: 12, h: 3, layout: "columns" }, { title: "Map or chart", x: 0, y: 3, w: 8, h: 10 }, { title: "Details", x: 8, y: 3, w: 4, h: 10, layout: "flow" }] },
];
export function applyTemplate(mod: Module, into: string, tpl: Tpl): Module {
  let next = 1 + Math.max(0, ...mod.widgets.map((w) => Number(w.id.replace(/\D/g, "")) || 0));
  const add: Widget[] = tpl.sections.map((s) => ({
    id: `w${next++}`, type: "section", title: s.title, x: s.x, y: s.y, w: s.w, h: s.h,
    config: { section_layout: s.layout ?? "grid" }, ...(into ? { parent: into } : {}),
  }));
  return { ...mod, widgets: [...mod.widgets, ...add] };
}

// ------------------------------------------------------------------------------------------------
// style fields
// ------------------------------------------------------------------------------------------------

export function BackgroundField({ value, onChange, saved }: { value?: Background; onChange: (b: Background | undefined) => void; saved?: SavedColor[] }) {
  const custom = value !== undefined && !(value in BACKGROUNDS) && !value.startsWith("var(--ws-color-");
  return (
    <div className="flex items-center gap-1" data-background>
      {Object.keys(BACKGROUNDS).map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k === "default" ? undefined : k)}
          title={k === "default" ? "Default" : k === "transparent" ? "Transparent" : `Shade ${k}`}
          className={`h-5 w-5 rounded border ${(value ?? "default") === k ? "border-ocean ring-1 ring-ocean" : "border-line-2"}`}
          style={{ background: k === "transparent" ? "repeating-conic-gradient(var(--color-line-2) 0 25%, transparent 0 50%) 0 0/8px 8px" : BACKGROUNDS[k] }}
        />
      ))}
      {(saved ?? []).map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onChange(savedColorVar(c.id))}
          title={`Saved color: ${c.name}`}
          className={`h-5 w-5 rounded-full border ${value === savedColorVar(c.id) ? "border-ocean ring-1 ring-ocean" : "border-line-2"}`}
          style={{ background: savedColorVar(c.id) }}
          data-saved-color={c.id}
        />
      ))}
      <input type="color" value={custom ? String(value) : "#1f6feb"} onChange={(e) => onChange(e.target.value)} className={`h-5 w-6 bg-transparent ${custom ? "ring-1 ring-ocean" : ""}`} title="Custom color" />
    </div>
  );
}

export function PaddingField({ value, onChange }: { value?: Padding; onChange: (p: Padding | undefined) => void }) {
  const kind = typeof value === "number" ? "custom" : value ?? "none";
  return (
    <div className="flex gap-1">
      <select value={kind} onChange={(e) => onChange(e.target.value === "none" ? undefined : e.target.value === "custom" ? 12 : (e.target.value as Padding))} className={`${fieldClass} flex-1 text-xs`}>
        <option value="none">No padding</option>
        <option value="compact">Compact (16 px)</option>
        <option value="regular">Regular (24 / 48 px)</option>
        <option value="large">Large (40 / 62 px)</option>
        <option value="custom">Custom</option>
      </select>
      {kind === "custom" && <input type="number" min={0} max={120} value={Number(value)} onChange={(e) => onChange(Number(e.target.value) || 0)} className={`${fieldClass} w-16 text-xs`} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// the module header
// ------------------------------------------------------------------------------------------------

export const HEADER_ICONS: IconName[] = ["device", "grid", "layers", "graph", "table", "gauge", "bell", "star", "globe", "database", "project", "sparkle"];

function Logo({ h, collapsed }: { h: ModuleHeader; collapsed?: boolean }) {
  // eslint-disable-next-line @next/next/no-img-element
  if (h.image_url) return <img src={h.image_url} alt="" style={{ height: collapsed ? 28 : h.image_height ?? 28 }} className="max-w-full shrink-0 object-contain" />;
  if (h.icon) return <span style={{ color: h.icon_color }}><Icon name={h.icon as IconName} className="h-5 w-5 shrink-0" /></span>;
  return null;
}

/** The module header in view and edit mode: title, logo, its own widgets (tabs, button groups, inputs…), favorite. */
export function ModuleHeaderBar({
  mod, state, editing, collapsed, onCollapse, favorite, onFavorite, onSelect,
}: {
  mod: Module; state: ModuleState; editing: boolean; collapsed: boolean; onCollapse: (c: boolean) => void;
  favorite: boolean; onFavorite: () => void; onSelect: () => void;
}) {
  const h = mod.settings?.header ?? {};
  const title = state.tr?.(h.title || mod.name) ?? (h.title || mod.name);
  const vertical = h.orientation === "vertical";
  const star = h.favorite && !editing && (
    <button type="button" onClick={onFavorite} title={favorite ? "Remove from favorites" : "Add to favorites"} className={favorite ? "text-warn" : "text-muted hover:text-white"} data-favorite={favorite ? "on" : "off"}>
      <Icon name="star" className="h-4 w-4" />
    </button>
  );
  const pick = (e: React.MouseEvent) => {
    if (editing && e.target === e.currentTarget) onSelect();
  };
  if (vertical) {
    const top = (h.image_position ?? "top") !== "bottom";
    return (
      <aside onClick={pick} className="flex shrink-0 flex-col border-r border-line" style={{ width: collapsed ? 56 : h.width ?? 220, background: h.background ?? "var(--color-panel)" }} data-module-header="vertical">
        {top && <div className="flex justify-center px-2 pt-3"><Logo h={h} collapsed={collapsed} /></div>}
        {!collapsed && (
          <div className="flex items-center gap-2 px-3 py-2 text-sm font-semibold" style={{ color: h.title_color }}>
            <span className="truncate">{title}</span>
            <span className="ml-auto">{star}</span>
          </div>
        )}
        <div className="min-h-0 flex-1">{!collapsed && state.renderContainer?.("header")}</div>
        {!top && <div className="flex justify-center px-2 pb-2"><Logo h={h} collapsed={collapsed} /></div>}
        {h.collapsible && (
          <button type="button" onClick={() => onCollapse(!collapsed)} className="border-t border-line py-1.5 text-muted hover:text-white" title={collapsed ? "Expand" : "Collapse"} data-header-collapse>
            <Icon name={collapsed ? "right" : "left"} className="mx-auto h-4 w-4" />
          </button>
        )}
      </aside>
    );
  }
  const pos = h.image_position ?? "left";
  return (
    <div onClick={pick} className="flex shrink-0 items-center gap-3 border-b border-line px-3" style={{ height: h.height ?? 56, background: h.background ?? "var(--color-panel)" }} data-module-header="horizontal">
      {pos === "left" && <Logo h={h} />}
      <span className="shrink-0 truncate text-base font-semibold" style={{ color: h.title_color }}>{title}</span>
      {pos === "center" && <div className="flex flex-1 justify-center"><Logo h={h} /></div>}
      <div className="h-full min-w-0 flex-1">{state.renderContainer?.("header")}</div>
      {pos === "right" && <Logo h={h} />}
      {star}
    </div>
  );
}

/** Header settings (the Layout panel). */
export function HeaderSettings({ mod, setMod }: { mod: Module; setMod: (m: Module) => void }) {
  const h = mod.settings?.header;
  const set = (x: Partial<ModuleHeader>) => setMod({ ...mod, settings: { ...mod.settings, header: { ...h, ...x } } });
  const lab = "block text-muted";
  return (
    <div className="space-y-2" data-header-settings>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!!h && !h.hidden} onChange={(e) => set({ hidden: !e.target.checked })} /> Show the module header
      </label>
      {h && !h.hidden && (
        <>
          <label className={lab}>
            Title (also the browser tab name; empty: the module name)
            <input value={h.title ?? ""} onChange={(e) => set({ title: e.target.value || undefined })} className={`${fieldClass} mt-1 w-full text-xs`} />
          </label>
          <div className="flex items-center gap-2">
            <span className="text-muted">Title color</span>
            <input type="color" value={h.title_color ?? "#e6edf3"} onChange={(e) => set({ title_color: e.target.value })} className="h-5 w-6 bg-transparent" />
            <span className="text-muted">Background</span>
            <input type="color" value={h.background ?? "#161b22"} onChange={(e) => set({ background: e.target.value })} className="h-5 w-6 bg-transparent" />
            {(h.title_color || h.background) && (
              <button type="button" onClick={() => set({ title_color: undefined, background: undefined })} className="text-muted hover:text-white">
                reset
              </button>
            )}
          </div>
          <div className="flex gap-1">
            <select value={h.icon ?? ""} onChange={(e) => set({ icon: e.target.value || undefined })} className={`${fieldClass} flex-1 text-xs`}>
              <option value="">No icon</option>
              {HEADER_ICONS.map((i) => (
                <option key={i}>{i}</option>
              ))}
            </select>
            <input type="color" value={h.icon_color ?? "#1f6feb"} onChange={(e) => set({ icon_color: e.target.value })} className="h-6 w-7 bg-transparent" title="Icon color" />
          </div>
          <label className={lab}>
            Logo image URL (instead of the icon)
            <input value={h.image_url ?? ""} onChange={(e) => set({ image_url: e.target.value || undefined })} placeholder="https://… or /api/…" className={`${fieldClass} mt-1 w-full text-xs`} />
          </label>
          {h.image_url && (
            <div className="flex gap-1">
              <input type="number" min={12} max={120} value={h.image_height ?? 28} onChange={(e) => set({ image_height: Number(e.target.value) || 28 })} className={`${fieldClass} w-16 text-xs`} title="Image height" />
              <select value={h.image_position ?? (h.orientation === "vertical" ? "top" : "left")} onChange={(e) => set({ image_position: e.target.value as ModuleHeader["image_position"] })} className={`${fieldClass} flex-1 text-xs`}>
                {(h.orientation === "vertical" ? ["top", "bottom"] : ["left", "center", "right"]).map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </div>
          )}
          <div className="flex gap-1">
            <select value={h.orientation ?? "horizontal"} onChange={(e) => set({ orientation: e.target.value as "horizontal" | "vertical", image_position: undefined })} className={`${fieldClass} flex-1 text-xs`} data-header-orientation>
              <option value="horizontal">Horizontal (top)</option>
              <option value="vertical">Vertical (left)</option>
            </select>
            {h.orientation === "vertical" ? (
              <input type="number" min={120} max={480} value={h.width ?? 220} onChange={(e) => set({ width: Number(e.target.value) || 220 })} className={`${fieldClass} w-16 text-xs`} title="Width" />
            ) : (
              <input type="number" min={36} max={160} value={h.height ?? 56} onChange={(e) => set({ height: Number(e.target.value) || 56 })} className={`${fieldClass} w-16 text-xs`} title="Height" />
            )}
          </div>
          {h.orientation === "vertical" && (
            <div className="flex gap-3">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={!!h.collapsible} onChange={(e) => set({ collapsible: e.target.checked })} /> Collapsible
              </label>
              {h.collapsible && (
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={!!h.collapsed} onChange={(e) => set({ collapsed: e.target.checked })} /> Collapsed by default
                </label>
              )}
            </div>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!h.favorite} onChange={(e) => set({ favorite: e.target.checked })} /> Users can favorite the module
          </label>
          <p className="text-muted">Add tabs, button groups or inputs to the header with “Add into → Header”.</p>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// outline: the containers and widgets of the page, with conditional visibility and collapse indicators
// ------------------------------------------------------------------------------------------------

export function Outline({ mod, roots, selected, onSelect }: { mod: Module; roots: Widget[]; selected: string | null; onSelect: (id: string) => void }) {
  const children = (w: Widget): { label: string; key: string }[] =>
    w.type === "tabs" ? (w.config.tabs ?? [{ id: "t1", name: "Tab 1" }]).map((t) => ({ label: t.name, key: `${w.id}:${t.id}` })) : w.type === "section" ? [{ label: "", key: `${w.id}:body` }] : [];
  const row = (w: Widget, depth: number): React.ReactNode => (
    <div key={w.id}>
      <button
        type="button"
        onClick={() => onSelect(w.id)}
        className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left ${selected === w.id ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}
        style={{ paddingLeft: 4 + depth * 12 }}
        data-outline={w.id}
      >
        <span className="truncate">{w.title || w.type}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-muted">
          {w.config.hide_if?.variable && (
            <span title={`Conditional visibility: hidden when ${w.config.hide_if.variable} is ${w.config.hide_if.when ?? true}`}>
              <Icon name="eye" className="h-3 w-3" />
            </span>
          )}
          {w.config.collapsible && (
            <span title={w.config.collapsed ? "Collapsible, collapsed by default" : "Collapsible"}>
              <Icon name="down" className="h-3 w-3" />
            </span>
          )}
          {w.type === "section" && <span className="font-mono text-[9px]">{w.config.section_layout ?? "grid"}</span>}
        </span>
      </button>
      {children(w).map((c) => {
        const kids = mod.widgets.filter((x) => x.parent === c.key).sort((a, b) => a.y - b.y || a.x - b.x);
        return (
          <div key={c.key}>
            {c.label && <div className="truncate text-[10px] text-muted" style={{ paddingLeft: 16 + depth * 12 }}>{c.label}</div>}
            {kids.map((k) => row(k, depth + 1))}
          </div>
        );
      })}
    </div>
  );
  const sorted = [...roots].sort((a, b) => a.y - b.y || a.x - b.x);
  return <div className="space-y-0.5" data-outline-tree>{sorted.length ? sorted.map((w) => row(w, 0)) : <p className="text-muted">No widgets on this page.</p>}</div>;
}
