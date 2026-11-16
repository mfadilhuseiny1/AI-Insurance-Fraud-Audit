/**
 * App Pairing and commands for the Map application (Gaia's role here) and Vertex (Graph's role), protocol-compatible
 * with Workshop's App Pairing widget (components/workshop/CrossApp.tsx, AppPairingWidget):
 *
 * - windows with the same pairing code talk on the BroadcastChannel "bluesandai-pair:<code>";
 * - messages are { from, kind: "hello" | "bye" | "selection" | "vars", key?, pk?, values? }; a selection's key is the
 *   Workshop selection key of an object type, "object_type:<type id>", and pk its selected primary key (none = cleared);
 * - "hello" is sent on joining and every 15 s (a peer answers a hello with a hello), "bye" on leaving.
 *
 * Extensions the Workshop widget ignores (it only reads key / pk / values): `app` on every message (which application
 * sent it), `pks` on a selection (every selected key of that type: Vertex and the map can hold several), and
 * { kind: "command", command, payload } for commands sent to paired windows.
 *
 * Commands also arrive as a window message { type: "bluesandai.command", command, payload } (what Workshop's
 * "send command" event posts to an embedded page or the parent window), answered with
 * { type: "bluesandai.command.result", command, ok }. Commands: select, focus (zoom to), add, clear (aliases below).
 *
 * The pure helpers are unit-tested without a browser (the hook and the session take an injectable channel).
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type ObjectRef = { object_type_id: string; primary_key: string };
export type PairKind = "hello" | "bye" | "selection" | "vars" | "command";
export type PairMsg = {
  from: string;
  kind: PairKind;
  key?: string;
  pk?: string;
  pks?: string[];
  values?: Record<string, unknown>;
  app?: string;
  command?: string;
  payload?: unknown;
};
export type PairApp = "map" | "vertex" | "workshop" | string;

export const PAIR_CHANNEL_PREFIX = "bluesandai-pair:";
export const HEARTBEAT_MS = 15000;
/** a peer counts as live this long after its last message (Workshop's widget uses the same window) */
export const LIVE_MS = 40000;
export const channelName = (code: string) => `${PAIR_CHANNEL_PREFIX}${code}`;
/** Workshop's selection key of an object type (lib/workshop.ts sourceKey({kind: "object_type", id})) */
export const objectTypeKey = (typeId: string) => `object_type:${typeId}`;
export function typeOfKey(key: string | undefined | null): string | null {
  const m = /^object_type:(.+)$/.exec(key ?? "");
  return m ? m[1] : null;
}
export const newPairCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

// ------------------------------------------------------------------------------------------------ commands

export type CommandName = "select" | "focus" | "add" | "clear";
const ALIASES: Record<string, CommandName> = {
  select: "select",
  selectobject: "select",
  selectobjects: "select",
  setselection: "select",
  focus: "focus",
  focusobject: "focus",
  focusobjects: "focus",
  zoomto: "focus",
  zoomtoobject: "focus",
  zoomtoobjects: "focus",
  panto: "focus",
  centeron: "focus",
  show: "focus",
  add: "add",
  addobject: "add",
  addobjects: "add",
  addtomap: "add",
  addtograph: "add",
  clear: "clear",
  clearselection: "clear",
  deselect: "clear",
};
export const COMMANDS: { name: CommandName; label: string }[] = [
  { name: "select", label: "select objects (selectObjects)" },
  { name: "focus", label: "zoom to objects (zoomTo, panTo)" },
  { name: "add", label: "add objects (addObjects)" },
  { name: "clear", label: "clear the selection (clearSelection)" },
];
export function commandName(name: unknown): CommandName | null {
  if (typeof name !== "string") return null;
  return ALIASES[name.toLowerCase().replace(/[^a-z]/g, "")] ?? null;
}

const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

/**
 * Object references from a command's payload or a drop: "object:<type>:<pk>" lines (what objects drag as), a primary
 * key (with a default type), {object_type_id | objectTypeId, primary_key | primaryKey | pk},
 * {object_type_id, primary_keys | primaryKeys | pks}, {objects: [...]}, or lists of these. Duplicates are dropped.
 */
export function objectRefs(payload: unknown, defaultType?: string | null): ObjectRef[] {
  const out: ObjectRef[] = [];
  const seen = new Set<string>();
  const push = (t: string, pk: string) => {
    if (!t || !pk || seen.has(`${t}\u0000${pk}`)) return;
    seen.add(`${t}\u0000${pk}`);
    out.push({ object_type_id: t, primary_key: pk });
  };
  const walk = (v: unknown, type: string | null | undefined, depth: number) => {
    if (v == null || depth > 4) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, type, depth + 1));
    if (typeof v === "string") {
      for (const line of v.split("\n").map((l) => l.trim()).filter(Boolean)) {
        const m = /^object:([^:]+):(.+)$/.exec(line);
        if (m) push(m[1], m[2]);
        else if (type) push(type, line);
      }
      return;
    }
    if (typeof v === "number") return type ? push(type, String(v)) : undefined;
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const t = str(o.object_type_id ?? o.objectTypeId ?? o.objectType ?? o.type_id) || type || "";
    if (o.objects !== undefined) walk(o.objects, t || type, depth + 1);
    const many = o.primary_keys ?? o.primaryKeys ?? o.pks;
    if (Array.isArray(many)) many.forEach((pk) => push(t, str(pk)));
    const one = str(o.primary_key ?? o.primaryKey ?? o.pk);
    if (one) push(t, one);
  };
  walk(payload, defaultType ?? null, 0);
  return out;
}

export type PairCommand = { name: CommandName; command: string; objects: ObjectRef[] };
/** A command from a window message ({type: "bluesandai.command", command, payload}) or a pairing message
 * ({kind: "command", command, payload}); an object_type_id beside the payload is the default type of bare keys. */
export function parseCommand(data: unknown): PairCommand | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "bluesandai.command" && d.kind !== "command") return null;
  const name = commandName(d.command);
  if (!name) return null;
  const def = str(d.object_type_id ?? d.objectTypeId) || null;
  return { name, command: String(d.command), objects: objectRefs(d.payload, def) };
}

// ------------------------------------------------------------------------------------------------ selection

export type ByType = Record<string, string[]>;
export function selectionByType(objs: ObjectRef[]): ByType {
  const out: ByType = {};
  for (const o of objs) {
    const list = (out[o.object_type_id] ??= []);
    if (!list.includes(o.primary_key)) list.push(o.primary_key);
  }
  return out;
}
const sameList = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The selection messages that move the shared selection from `prev` to `next` (one per object type that changed;
 * a type no longer selected is cleared). pk is the first selected key (all Workshop holds), pks all of them. */
export function selectionMessages(prev: ByType, next: ByType): Omit<PairMsg, "from">[] {
  const out: Omit<PairMsg, "from">[] = [];
  for (const t of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    const n = next[t] ?? [];
    if (sameList(prev[t], n) || (!n.length && !(prev[t] ?? []).length)) continue;
    out.push({ kind: "selection", key: objectTypeKey(t), pk: n[0], pks: n });
  }
  return out;
}

/** The keys a received selection message selects for its object type ([] = cleared), or null when it is not an
 * object type's selection (Workshop also pairs interface selections). */
export function selectionOf(m: PairMsg): { typeId: string; pks: string[] } | null {
  if (m.kind !== "selection") return null;
  const typeId = typeOfKey(m.key);
  if (!typeId) return null;
  const pks = Array.isArray(m.pks) ? m.pks.map(String) : m.pk !== undefined && m.pk !== null && m.pk !== "" ? [String(m.pk)] : [];
  return { typeId, pks };
}

/** The current selection with one object type's part replaced by `pks` (the other types stay selected). */
export function replaceType(current: ObjectRef[], typeId: string, pks: string[]): ObjectRef[] {
  return [...current.filter((o) => o.object_type_id !== typeId), ...pks.map((pk) => ({ object_type_id: typeId, primary_key: pk }))];
}

export type Peer = { id: string; app: string; at: number };
export const livePeers = (peers: Record<string, Peer>, now: number) => Object.values(peers).filter((p) => now - p.at < LIVE_MS || p.at > now);

// ------------------------------------------------------------------------------------------------ session

export type ChannelLike = { postMessage: (m: unknown) => void; close: () => void; onmessage: ((e: MessageEvent) => void) | null };
export type ChannelFactory = (name: string) => ChannelLike;
export type SessionHandlers = {
  onSelection?: (typeId: string, pks: string[], from: Peer) => void;
  onCommand?: (cmd: PairCommand, from: Peer) => void;
  onPeers?: (peers: Record<string, Peer>) => void;
};

/** One window's membership of a pairing code: hello / bye / heartbeats, peers, selection and command messages. */
export class PairingSession {
  readonly id: string;
  readonly code: string;
  readonly app: string;
  peers: Record<string, Peer> = {};
  /** the shared selection as this window last sent or received it, per object type */
  known: ByType = {};
  /** the object types this window's own selection holds */
  private mine = new Set<string>();
  private ch: ChannelLike;
  private beat: ReturnType<typeof setInterval> | null = null;
  private handlers: SessionHandlers;
  private closed = false;

  constructor(code: string, app: string, handlers: SessionHandlers, make: ChannelFactory, opts?: { id?: string; heartbeat?: boolean }) {
    this.code = code;
    this.app = app;
    this.handlers = handlers;
    this.id = opts?.id ?? Math.random().toString(36).slice(2, 8);
    this.ch = make(channelName(code));
    this.ch.onmessage = (e: MessageEvent) => this.receive(e.data as PairMsg);
    this.send({ kind: "hello" });
    if (opts?.heartbeat !== false) this.beat = setInterval(() => this.send({ kind: "hello" }), HEARTBEAT_MS);
  }
  setHandlers(h: SessionHandlers) {
    this.handlers = h;
  }
  send(m: Omit<PairMsg, "from">) {
    if (this.closed) return; // a closed channel throws
    this.ch.postMessage({ ...m, from: this.id, app: this.app });
  }
  receive(m: PairMsg) {
    if (!m || typeof m !== "object" || !m.from || m.from === this.id) return;
    const peer: Peer = { id: m.from, app: m.app || "workshop", at: Date.now() };
    const isNew = !(m.from in this.peers);
    if (m.kind === "bye") {
      const { [m.from]: _gone, ...rest } = this.peers;
      void _gone;
      this.peers = rest;
    } else this.peers = { ...this.peers, [m.from]: peer };
    this.handlers.onPeers?.(this.peers);
    // a hello from a window not seen yet is answered (so it learns about this one); answering every hello would never
    // end between two windows that both answer (each answer is a hello)
    if (m.kind === "hello") {
      if (isNew) this.send({ kind: "hello" });
      return;
    }
    const sel = selectionOf(m);
    if (sel) {
      // Workshop holds one key per type and can send a received selection back ({key, pk}, no pks): when that is the
      // first key of the shared selection it is an echo, and applying it would cut a multi-selection down to one
      if (!Array.isArray(m.pks) && sel.pks.length === 1 && (this.known[sel.typeId] ?? [])[0] === sel.pks[0]) return;
      if (sel.pks.length) this.known = { ...this.known, [sel.typeId]: sel.pks };
      else {
        const { [sel.typeId]: _cleared, ...rest } = this.known;
        void _cleared;
        this.known = rest;
      }
      this.handlers.onSelection?.(sel.typeId, sel.pks, peer);
      return;
    }
    const cmd = m.kind === "command" ? parseCommand(m) : null;
    if (cmd) this.handlers.onCommand?.(cmd, peer);
  }
  /** Sends what changed in this window's selection since the shared selection last changed; returns the messages.
   * A type is cleared only when this window selected it before: a window that holds one selection (the map) does not
   * clear the other types a paired Workshop module has selected. */
  publish(objs: ObjectRef[]): Omit<PairMsg, "from">[] {
    const next = selectionByType(objs);
    const prev = Object.fromEntries(Object.entries(this.known).filter(([t]) => t in next || this.mine.has(t)));
    const msgs = selectionMessages(prev, next);
    // the shared selection is updated before sending: an answer can arrive while sending
    for (const t of Object.keys(prev)) if (!(t in next)) delete this.known[t];
    this.known = { ...this.known, ...next };
    this.mine = new Set(Object.keys(next));
    msgs.forEach((m) => this.send(m));
    return msgs;
  }
  command(name: string, payload: unknown) {
    this.send({ kind: "command", command: name, payload });
  }
  close() {
    if (this.closed) return;
    this.send({ kind: "bye" });
    this.closed = true;
    if (this.beat) clearInterval(this.beat);
    this.ch.close();
  }
}

// ------------------------------------------------------------------------------------------------ React hook

const defaultChannel: ChannelFactory = (name) => new BroadcastChannel(name) as unknown as ChannelLike;
const STORE = "bluesandai.pairing.";

export type Pairing = {
  code: string;
  setCode: (c: string) => void;
  paired: boolean;
  pair: (code?: string) => void;
  unpair: () => void;
  peers: Peer[];
  last: string | null;
  /** sends this window's selection (call it from user actions, not when applying a received selection) */
  publish: (objs: ObjectRef[]) => void;
  /** sends a command to the paired windows */
  command: (name: string, payload: unknown) => void;
};

/**
 * Pairs this window by a code (also ?pair=<code> in the URL; the last code is remembered for the tab), calls
 * onSelection with each received object type selection, and onCommand with commands from paired windows or from a
 * same-origin window message (an embedding Workshop module, the window that opened this one).
 */
export function usePairing(app: PairApp, handlers: { onSelection: (typeId: string, pks: string[]) => void; onCommand: (cmd: PairCommand) => boolean | void }, make: ChannelFactory = defaultChannel): Pairing {
  const [code, setCode] = useState("");
  const [paired, setPaired] = useState(false);
  const [peerMap, setPeerMap] = useState<Record<string, Peer>>({});
  const [last, setLast] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const session = useRef<PairingSession | null>(null);
  const h = useRef(handlers);
  useEffect(() => {
    h.current = handlers;
  });
  // ?pair=<code> joins on load; otherwise the tab's last code is offered
  useEffect(() => {
    let initial = "";
    let join = false;
    try {
      initial = new URLSearchParams(window.location.search).get("pair") ?? "";
      join = !!initial;
      if (!initial) initial = sessionStorage.getItem(STORE + app) ?? "";
    } catch {
      // storage can be unavailable
    }
    if (!initial) return;
    const t = setTimeout(() => {
      setCode(initial);
      if (join) setPaired(true);
    }, 0);
    return () => clearTimeout(t);
  }, [app]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), HEARTBEAT_MS);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!paired || !code || typeof BroadcastChannel === "undefined") return;
    try {
      sessionStorage.setItem(STORE + app, code);
    } catch {
      // storage can be unavailable
    }
    const s = new PairingSession(
      code,
      app,
      {
        onPeers: (p) => setPeerMap({ ...p }),
        onSelection: (typeId, pks, from) => {
          h.current.onSelection(typeId, pks);
          setLast(`${from.app}: ${pks.length ? `selected ${pks.slice(0, 3).join(", ")}${pks.length > 3 ? ` +${pks.length - 3}` : ""}` : "cleared the selection"}`);
        },
        onCommand: (cmd, from) => {
          h.current.onCommand(cmd);
          setLast(`${from.app}: ${cmd.command} (${cmd.objects.length} object${cmd.objects.length === 1 ? "" : "s"})`);
        },
      },
      make,
    );
    session.current = s;
    // closing the tab or leaving the site does not unmount the page: say bye then (and hello again if the page comes
    // back from the back / forward cache)
    const hide = () => s.send({ kind: "bye" });
    const show = (e: PageTransitionEvent) => {
      if (e.persisted) s.send({ kind: "hello" });
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      s.close();
      session.current = null;
      setPeerMap({});
    };
  }, [paired, code, app, make]);
  // commands from an embedding / opening window (Workshop's "send command" event)
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data as { type?: string; command?: string } | null;
      if (!d || d.type !== "bluesandai.command") return;
      const cmd = parseCommand(d);
      const ok = !!cmd && h.current.onCommand(cmd) !== false;
      (e.source as Window | null)?.postMessage({ type: "bluesandai.command.result", command: d.command, ok }, window.location.origin);
      if (cmd) setLast(`command ${cmd.command} (${cmd.objects.length} object${cmd.objects.length === 1 ? "" : "s"})`);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);
  const publish = useCallback((objs: ObjectRef[]) => void session.current?.publish(objs), []);
  const command = useCallback((name: string, payload: unknown) => session.current?.command(name, payload), []);
  return {
    code,
    setCode,
    paired,
    pair: (c?: string) => {
      if (c) setCode(c);
      setPaired(true);
    },
    unpair: () => setPaired(false),
    peers: livePeers(peerMap, now),
    last,
    publish,
    command,
  };
}
