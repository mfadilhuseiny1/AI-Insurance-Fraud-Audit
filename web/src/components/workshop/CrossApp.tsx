"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Field } from "@/components/ontology/parts";
import { fieldClass, inputClass } from "@/components/pipeline/Modal";
import { type Filter, type Module, type SourceRef, type Widget, type WidgetConfig } from "@/lib/workshop";
import type { ModuleState } from "./WidgetView";
import { EventsEditor } from "./WorkshopConfig";

// ------------------------------------------------------------------------------------------------
// drag payloads: objects travel as text/plain lines "object:<type id>:<primary key>" (what Ontology Manager drags and
// the Map application accepts) plus JSON; object sets as JSON {source, filters}
// ------------------------------------------------------------------------------------------------

export const OBJECTS_MIME = "application/x-bluesandai-objects";
export const OBJECT_SET_MIME = "application/x-bluesandai-objectset";

export function dragObjects(e: React.DragEvent, typeId: string, pks: string[]) {
  e.dataTransfer.setData("text/plain", pks.map((pk) => `object:${typeId}:${pk}`).join("\n"));
  e.dataTransfer.setData(OBJECTS_MIME, JSON.stringify({ objectTypeId: typeId, primaryKeys: pks }));
  e.dataTransfer.effectAllowed = "copy";
}
export function dragObjectSet(e: React.DragEvent, source: SourceRef, filters: Filter[]) {
  e.dataTransfer.setData(OBJECT_SET_MIME, JSON.stringify({ source, filters }));
  e.dataTransfer.setData("text/plain", `objectset:${source.id}`);
  e.dataTransfer.effectAllowed = "copy";
}
export type Dropped = { typeId: string; pks: string[] } | { set: { source: SourceRef; filters: Filter[] } };
export function readDrop(dt: DataTransfer): Dropped | null {
  try {
    const set = dt.getData(OBJECT_SET_MIME);
    if (set) return { set: JSON.parse(set) };
    const objs = dt.getData(OBJECTS_MIME);
    if (objs) {
      const o = JSON.parse(objs) as { objectTypeId: string; primaryKeys: string[] };
      return { typeId: o.objectTypeId, pks: o.primaryKeys };
    }
  } catch {
    // fall back to the text form
  }
  const lines = dt.getData("text/plain").split("\n").map((l) => /^object:([^:]+):(.+)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m);
  return lines.length ? { typeId: lines[0][1], pks: lines.filter((m) => m[1] === lines[0][1]).map((m) => m[2]) } : null;
}
export const acceptsDrop = (dt: DataTransfer) => [...dt.types].some((t) => t === "text/plain" || t === OBJECTS_MIME || t === OBJECT_SET_MIME);

/** What a drop writes into the output variable, by its type: primary keys (object set), a filter (object set filter),
 * or the first primary key. */
export function dropValue(d: Dropped, type: string | undefined): unknown {
  if ("set" in d) return type === "object_set_filter" ? { filters: d.set.filters, mode: "all" } : d.set.source.id;
  if (type === "object_set" || type === "array") return d.pks;
  if (type === "object_set_filter") return { filters: [{ column: "__pk", op: "in", value: d.pks }], mode: "all" };
  return d.pks[0];
}

// ------------------------------------------------------------------------------------------------
// display optimization
// ------------------------------------------------------------------------------------------------

/** Mounts its children once on screen (delay), and unmounts them when off screen (offscreen). */
export function LazyMount({ mount, unmount, children }: { mount?: string; unmount?: string; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const lazy = mount === "delay" || unmount === "offscreen";
  const [on, setOn] = useState(!lazy);
  useEffect(() => {
    if (!lazy || !box.current) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) setOn(true);
      else if (unmount === "offscreen") setOn(false);
    });
    io.observe(box.current);
    return () => io.disconnect();
  }, [lazy, unmount]);
  return (
    <div ref={box} className="h-full" data-mounted={on ? "yes" : "no"}>
      {on ? children : <div className="flex h-full items-center justify-center text-[11px] text-muted">…</div>}
    </div>
  );
}

/** Containers ("<tabs id>:<tab id>", "page:<id>", "overlay:<id>") whose widgets must stay mounted while hidden:
 * those holding a widget that never unmounts (kept once visited) or mounts eagerly (from the start). */
export function keepAlive(mod: Module): { never: Set<string>; eager: Set<string> } {
  const never = new Set<string>();
  const eager = new Set<string>();
  const byId = new Map(mod.widgets.map((w) => [w.id, w]));
  const first = mod.pages?.[0]?.id ?? "main";
  // every container a widget sits in, up to the page or overlay
  const chain = (w: Widget): string[] => {
    const out: string[] = [];
    let cur: Widget | undefined = w;
    for (let i = 0; cur && i < 10; i++) {
      const par = cur.parent ?? `page:${first}`;
      out.push(par);
      cur = byId.get(par.split(":")[0]);
    }
    return out;
  };
  for (const w of mod.widgets) {
    if (w.config.unmount === "never") chain(w).forEach((k) => never.add(k));
    if (w.config.mount === "eager") chain(w).forEach((k) => (never.add(k), eager.add(k)));
  }
  return { never, eager };
}

// ------------------------------------------------------------------------------------------------
// App Pairing: windows with the same pairing code share selections and chosen variables (BroadcastChannel)
// ------------------------------------------------------------------------------------------------

type PairMsg = { from: string; kind: "hello" | "bye" | "selection" | "vars"; key?: string; pk?: string; values?: Record<string, unknown> };

export function AppPairingWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const [code, setCode] = useState(c.pairing_code ?? "");
  const [paired, setPaired] = useState(false);
  const [peers, setPeers] = useState<Record<string, number>>({});
  const [last, setLast] = useState<string | null>(null);
  const [myId] = useState(() => Math.random().toString(36).slice(2, 8));
  const me = useRef(myId);
  // a clock for "live" peers (heartbeats every 15 s)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  const ch = useRef<BroadcastChannel | null>(null);
  const applying = useRef(false);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  useEffect(() => {
    if (!paired || !code || typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel(`bluesandai-pair:${code}`);
    ch.current = bc;
    const send = (m: Omit<PairMsg, "from">) => bc.postMessage({ ...m, from: me.current });
    const known = new Set<string>();
    // a closed or navigated-away window says bye at once (unmount does not run then), instead of staying a peer for 40 s
    const leave = () => send({ kind: "bye" });
    window.addEventListener("pagehide", leave);
    bc.onmessage = (e: MessageEvent<PairMsg>) => {
      const m = e.data;
      if (!m || m.from === me.current) return;
      setPeers((p) => ({ ...p, [m.from]: Date.now() }));
      // answer a hello only from a window not heard before: answering every hello makes two widgets ping each other forever
      if (m.kind === "hello" && !known.has(m.from)) send({ kind: "hello" });
      if (m.kind === "bye") known.delete(m.from);
      else known.add(m.from);
      if (m.kind === "bye") setPeers((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== m.from)));
      applying.current = true;
      if (m.kind === "selection" && c.pairing_selection !== false && m.key) {
        stateRef.current.select(m.key, m.pk);
        setLast(`selected ${m.pk ?? "nothing"}`);
      }
      if (m.kind === "vars" && m.values) {
        for (const [k, v] of Object.entries(m.values)) if ((c.pairing_variables ?? []).includes(k)) stateRef.current.setVariable(k, v);
        setLast(`variables ${Object.keys(m.values).join(", ")}`);
      }
      setTimeout(() => (applying.current = false), 0);
    };
    send({ kind: "hello" });
    const beat = setInterval(() => send({ kind: "hello" }), 15000);
    return () => {
      send({ kind: "bye" });
      window.removeEventListener("pagehide", leave);
      clearInterval(beat);
      bc.close();
      ch.current = null;
    };
  }, [paired, code, c.pairing_selection, c.pairing_variables]);
  // local changes go out (not the ones just received)
  const selKey = JSON.stringify(state.selection);
  const prevSel = useRef<Record<string, string | undefined>>({});
  useEffect(() => {
    if (!ch.current || applying.current || c.pairing_selection === false) return;
    for (const [k, pk] of Object.entries(state.selection)) if (prevSel.current[k] !== pk) ch.current.postMessage({ from: me.current, kind: "selection", key: k, pk });
    prevSel.current = { ...state.selection };
    // selKey holds the selection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, paired]);
  const varKey = JSON.stringify((c.pairing_variables ?? []).map((n) => state.variables[n]));
  useEffect(() => {
    if (!ch.current || applying.current || !(c.pairing_variables ?? []).length) return;
    ch.current.postMessage({ from: me.current, kind: "vars", values: Object.fromEntries((c.pairing_variables ?? []).map((n) => [n, state.variables[n]])) });
    // varKey holds the paired variables' values
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [varKey, paired]);
  const live = Object.values(peers).filter((t) => now - t < 40000 || t > now).length;
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 px-3 text-xs" data-pairing={paired ? "on" : "off"}>
      <div className="flex items-center gap-2">
        <Icon name="link" className={`h-4 w-4 ${paired ? "text-ok" : "text-muted"}`} />
        <input value={code} onChange={(e) => setCode(e.target.value.trim())} disabled={paired} placeholder="Pairing code" className={`${fieldClass} w-28 text-xs`} data-pairing-code />
        <button type="button" disabled={editing || !code} onClick={() => setPaired(!paired)} className={`rounded px-2 py-0.5 ${paired ? "border border-line-2 text-soft" : "bg-ocean text-white"} disabled:opacity-40`} data-pairing-toggle>
          {paired ? "Unpair" : "Pair"}
        </button>
        {!paired && (
          <button type="button" disabled={editing} onClick={() => setCode(Math.random().toString(36).slice(2, 8).toUpperCase())} className="text-muted hover:text-white" title="New code">
            <Icon name="refresh" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="text-muted" data-pairing-peers={live}>
        {paired ? `${live} paired window${live === 1 ? "" : "s"}${last ? ` · last: ${last}` : ""}` : "Open the same code in another window to pair."}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// configuration: display optimization (every widget), drop zones (sections), drag zones, reordering, pairing
// ------------------------------------------------------------------------------------------------

const MOUNTS: Record<string, string[]> = { normal: ["normal", "never"], delay: ["normal", "offscreen", "never"], eager: ["never"] };

export function CrossAppConfig({ widget, set, mod }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module }) {
  const c = widget.config;
  const t = widget.type;
  const vars = mod.variables ?? [];
  const mount = c.mount ?? "normal";
  const allowed = MOUNTS[mount];
  return (
    <div className="space-y-3 text-xs">
      <details className="rounded border border-line p-2" data-display-optimization>
        <summary className="cursor-pointer text-soft">Display optimization</summary>
        <div className="mt-2 grid grid-cols-2 gap-1">
          <label className="text-muted">
            Mount
            <select value={mount} onChange={(e) => set({ mount: e.target.value === "normal" ? undefined : (e.target.value as "delay"), unmount: MOUNTS[e.target.value].includes(c.unmount ?? "normal") ? c.unmount : (MOUNTS[e.target.value][0] as "never") })} className={`${fieldClass} w-full text-xs`}>
              <option value="normal">Normal</option>
              <option value="delay">Delay until on-screen</option>
              <option value="eager">Eagerly mount</option>
            </select>
          </label>
          <label className="text-muted">
            Unmount
            <select value={c.unmount ?? "normal"} onChange={(e) => set({ unmount: e.target.value === "normal" ? undefined : (e.target.value as "never") })} className={`${fieldClass} w-full text-xs`}>
              {["normal", "offscreen", "never"].map((u) => (
                <option key={u} value={u} disabled={!allowed.includes(u)}>
                  {{ normal: "Normal", offscreen: "Unmount when off-screen", never: "Never unmount" }[u]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-1 text-muted">Kept-mounted widgets keep their state (scroll, inputs) and keep loading data while hidden: use sparingly.</p>
      </details>
      {t === "section" && (
        <details className="rounded border border-line p-2" open={!!c.drop_handling} data-drop-config>
          <summary className="cursor-pointer text-soft">Drop handling</summary>
          <div className="mt-2 space-y-1">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={!!c.drop_handling} onChange={(e) => set({ drop_handling: e.target.checked || undefined })} /> Users can drop objects or object sets here
            </label>
            {c.drop_handling && (
              <>
                <div className="flex gap-1">
                  <input value={c.drop_label ?? ""} onChange={(e) => set({ drop_label: e.target.value || undefined })} placeholder="Drop label" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
                  <input value={c.drop_icon ?? ""} onChange={(e) => set({ drop_icon: e.target.value || undefined })} placeholder="icon" className={`${fieldClass} w-16 text-xs`} />
                </div>
                <Field label="Output variable (object set: keys; object set filter: a filter; string: the first key)">
                  <select value={c.drop_output ?? ""} onChange={(e) => set({ drop_output: e.target.value || undefined })} className={inputClass}>
                    <option value="">None</option>
                    {vars.filter((v) => ["object_set", "object_set_filter", "array", "string"].includes(v.type)).map((v) => (
                      <option key={v.name}>{v.name}</option>
                    ))}
                  </select>
                </Field>
                <EventsEditor events={c.drop_events ?? []} mod={mod} onChange={(ev) => set({ drop_events: ev })} label="On drop" />
              </>
            )}
          </div>
        </details>
      )}
      {(t === "table" || t === "object_set_title" || t === "object_view") && (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!c.enable_drag} onChange={(e) => set({ enable_drag: e.target.checked || undefined })} data-enable-drag /> Enable drag ({t === "table" ? "rows" : t === "object_view" ? "the header icon" : "the title"} to drop zones and other applications)
        </label>
      )}
      {t === "object_list" && (
        <div className="space-y-1">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!c.reorderable} onChange={(e) => set({ reorderable: e.target.checked || undefined })} /> Users reorder the cards by dragging (first 500)
          </label>
          {c.reorderable && (
            <Field label="Order into (an array variable)">
              <select value={c.order_variable ?? ""} onChange={(e) => set({ order_variable: e.target.value || undefined })} className={inputClass}>
                <option value="">None</option>
                {vars.filter((v) => v.type === "array" || v.type === "object_set").map((v) => (
                  <option key={v.name}>{v.name}</option>
                ))}
              </select>
            </Field>
          )}
        </div>
      )}
      {t === "app_pairing" && (
        <div className="space-y-2">
          <Field label="Default pairing code">
            <input value={c.pairing_code ?? ""} onChange={(e) => set({ pairing_code: e.target.value || undefined })} className={inputClass} />
          </Field>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.pairing_selection !== false} onChange={(e) => set({ pairing_selection: e.target.checked })} /> Sync object selections
          </label>
          <Field label="Variables kept in sync">
            <div className="flex flex-wrap gap-1">
              {vars.map((v) => {
                const on = (c.pairing_variables ?? []).includes(v.name);
                return (
                  <button key={v.name} type="button" onClick={() => set({ pairing_variables: on ? (c.pairing_variables ?? []).filter((x) => x !== v.name) : [...(c.pairing_variables ?? []), v.name] })} className={`rounded border px-1.5 py-0.5 text-[11px] ${on ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-muted"}`}>
                    {v.name}
                  </button>
                );
              })}
            </div>
          </Field>
        </div>
      )}
    </div>
  );
}

/** Module commands other applications can execute (Settings panel). */
export function CommandsSettings({ mod, setMod }: { mod: Module; setMod: (m: Module) => void }) {
  const list = mod.settings?.commands ?? [];
  const setList = (l: NonNullable<NonNullable<Module["settings"]>["commands"]>) => setMod({ ...mod, settings: { ...mod.settings, commands: l } });
  return (
    <div className="space-y-2 text-xs" data-commands>
      <div className="font-semibold uppercase tracking-wide text-muted">Commands</div>
      <p className="text-muted">
        A parent window or an embedded page sends <code>{'{type: "bluesandai.command", command, payload}'}</code> with postMessage; the payload goes into the variable, then the events run.
      </p>
      {list.map((cmd, i) => (
        <div key={i} className="space-y-1 rounded border border-line p-1.5">
          <div className="flex gap-1">
            <input value={cmd.name} onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="command name" className={`${fieldClass} min-w-0 flex-1 font-mono text-xs`} />
            <select value={cmd.variable ?? ""} onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, variable: e.target.value || undefined } : x)))} className={`${fieldClass} text-xs`}>
              <option value="">No payload</option>
              {(mod.variables ?? []).map((v) => (
                <option key={v.name}>{v.name}</option>
              ))}
            </select>
            <button type="button" onClick={() => setList(list.filter((_, j) => j !== i))} className="px-1 text-muted hover:text-bad">
              ✕
            </button>
          </div>
          <EventsEditor events={cmd.events} mod={mod} onChange={(ev) => setList(list.map((x, j) => (j === i ? { ...x, events: ev } : x)))} label="Then" />
        </div>
      ))}
      <button type="button" onClick={() => setList([...list, { name: `command${list.length + 1}`, events: [] }])} className="text-ocean">
        + Command
      </button>
    </div>
  );
}
