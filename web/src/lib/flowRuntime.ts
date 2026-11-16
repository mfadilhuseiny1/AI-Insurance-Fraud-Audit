/**
 * Runs a deployed device flow in the browser, the way Node-RED's runtime does: each enabled node gets
 * an instance; messages leave a node through its output ports and are delivered to every node wired
 * there (copied for all but the first). It runs while the pipeline is open in this tab. Gateway nodes
 * (OPC-UA, Kafka, Modbus, RTSP) need a server-side device gateway and only report that they are idle.
 */
import { api } from "./api";
import { defOf, SENSOR_METRICS, UNKNOWN_DEF, type Flow, type FlowNode } from "./flow";
import { acquireMqtt, releaseMqtt } from "./mqtt";
import type { DriveLocation } from "./pipeline";

export type Msg = { _msgid: string; payload?: unknown; topic?: string; [key: string]: unknown };
export type NodeStatus = { fill?: "red" | "green" | "yellow" | "blue" | "grey"; shape?: "dot" | "ring"; text?: string };
export type DebugLevel = "log" | "warn" | "error" | "alert";
export type DebugEntry = { id: number; at: number; nodeId: string; nodeName: string; topic?: string; value: unknown; level: DebugLevel; property?: string };

export type Hooks = {
  debug: (e: Omit<DebugEntry, "id">) => void;
  status: (nodeId: string, s: NodeStatus) => void;
  alert: (text: string, level: string) => void;
  /** a reading seen at a device or protocol input: feeds the Devices sidebar */
  telemetry: (device: string, metric: string, value: number, unit?: string) => void;
  datasetWritten: (nodeId: string, itemId: string, parentId: string | null) => void;
  /** where dataset nodes write: the pipeline's folder */
  location?: DriveLocation;
};

type Send = (out: Msg | null | (Msg | Msg[] | null)[]) => void;
type Ctx = {
  node: FlowNode;
  send: Send;
  status: (s: NodeStatus) => void;
  log: (value: unknown, level?: DebugLevel) => void;
  onClose: (fn: () => void | Promise<void>) => void;
  hooks: Hooks;
  runtime: FlowRuntime;
};
type Impl = { input?: (msg: Msg) => void | Promise<void>; trigger?: () => void };

let msgCounter = 0;
export const newMsg = (props: Partial<Msg> = {}): Msg => ({ _msgid: `${Date.now().toString(36)}${(msgCounter++).toString(36)}`, ...props });

function clone(m: Msg): Msg {
  try {
    return { ...structuredClone(m), _msgid: m._msgid };
  } catch {
    return { ...m };
  }
}

// ---------------------------------------------------------------- message properties

export function getProp(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const part of String(path || "payload").replace(/^msg\./, "").split(/\.|\[(\d+)\]/).filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function setProp(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = String(path || "payload").replace(/^msg\./, "").split(".").filter(Boolean);
  let cur = obj;
  parts.slice(0, -1).forEach((p) => {
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  });
  cur[parts[parts.length - 1]] = value;
}

function deleteProp(obj: Record<string, unknown>, path: string) {
  const parts = String(path).replace(/^msg\./, "").split(".").filter(Boolean);
  const parent = parts.length > 1 ? getProp(obj, parts.slice(0, -1).join(".")) : obj;
  if (parent && typeof parent === "object") delete (parent as Record<string, unknown>)[parts[parts.length - 1]];
}

/** A typed value as in Node-RED's typed inputs. */
function typed(v: unknown, t: unknown, msg?: Msg): unknown {
  switch (t) {
    case "num":
      return Number(v);
    case "bool":
      return v === true || v === "true";
    case "json":
      return JSON.parse(String(v || "null"));
    case "date":
      return Date.now();
    case "msg":
      return msg ? structuredClone(getProp(msg, String(v))) : undefined;
    default:
      return v ?? "";
  }
}

/** "{{payload.value}} at {{topic}}" filled in from the message. */
export const template = (text: string, msg: Msg) =>
  text.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_, p: string) => {
    const v = getProp(msg, p);
    return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });

const num = (v: unknown) => (v === "" || v === null || v === undefined ? NaN : Number(v));
const valueOf = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : num((v as { value?: unknown } | null)?.value));
const keyOf = (n: FlowNode, msg: Msg) => (n.perTopic === false ? "_" : String(msg.topic ?? "_"));
const fmt = (v: number) => (Number.isFinite(v) ? String(+v.toFixed(3)) : String(v));

// ---------------------------------------------------------------- node implementations

const IMPLS: Record<string, (c: Ctx) => Impl> = {
  inject(c) {
    const fire = () => {
      try {
        c.send(newMsg({ payload: typed(c.node.payload, c.node.payloadType), topic: String(c.node.topic ?? "") }));
      } catch (e) {
        c.log(`Invalid payload: ${(e as Error).message}`, "error");
      }
    };
    if (c.node.once) {
      const t = setTimeout(fire, 100);
      c.onClose(() => clearTimeout(t));
    }
    const every = num(c.node.repeat);
    if (every > 0) {
      const t = setInterval(fire, every * 1000);
      c.onClose(() => clearInterval(t));
      c.status({ fill: "blue", shape: "dot", text: `every ${every}s` });
    }
    return { trigger: fire };
  },

  debug(c) {
    return {
      input(msg) {
        if (!c.runtime.debugActive(c.node.id)) return;
        const all = c.node.complete === "true";
        c.hooks.debug({ at: Date.now(), nodeId: c.node.id, nodeName: c.node.name || "debug", topic: msg.topic, value: all ? msg : msg.payload, level: "log", property: all ? "msg" : "msg.payload" });
      },
    };
  },

  comment: () => ({}),

  sensor(c) {
    const metric = SENSOR_METRICS[String(c.node.metric)] ?? SENSOR_METRICS.temperature;
    const device = String(c.node.device || "sensor");
    // devices drift out of phase with each other
    const phase = [...device].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
    const every = Math.max(0.1, num(c.node.interval) || 2);
    const tick = () => {
      const t = Date.now() / 1000;
      const gauss = Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
      let value = metric.base + metric.amplitude * Math.sin((2 * Math.PI * t) / 180 + phase) + metric.noise * gauss;
      if (Math.random() * 100 < (num(c.node.spike) || 0)) value += (Math.random() < 0.5 ? -1 : 1) * metric.amplitude * (3 + 2 * Math.random());
      value = +value.toFixed(2);
      const ts = new Date().toISOString();
      const m = String(c.node.metric);
      c.status({ fill: "green", shape: "dot", text: `${value} ${metric.unit}` });
      c.send(
        newMsg({
          topic: `${c.node.topicPrefix || "devices"}/${device}/${m}`,
          payload: c.node.format === "object" ? { device, metric: m, value, unit: metric.unit, ts } : value,
          device,
          metric: m,
          unit: metric.unit,
          ts,
        }),
      );
    };
    const t = setInterval(tick, every * 1000);
    c.onClose(() => clearInterval(t));
    return { trigger: tick };
  },

  camera(c) {
    const source = String(c.node.source);
    if (source === "rtsp") {
      c.status({ fill: "grey", shape: "ring", text: "needs device gateway" });
      return {};
    }
    const width = Math.max(64, num(c.node.width) || 320);
    const canvas = document.createElement("canvas");
    const small = document.createElement("canvas");
    small.width = 64;
    small.height = 48;
    let prev: Uint8ClampedArray | null = null;
    let video: HTMLVideoElement | null = null;
    let stream: MediaStream | null = null;
    let busy = false;

    const frame = async () => {
      if (busy) return;
      busy = true;
      try {
        let img: CanvasImageSource;
        let w: number;
        let h: number;
        if (source === "webcam") {
          if (!video || video.readyState < 2) return;
          img = video;
          w = video.videoWidth;
          h = video.videoHeight;
        } else {
          const res = await fetch(String(c.node.url), { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bmp = await createImageBitmap(await res.blob());
          img = bmp;
          w = bmp.width;
          h = bmp.height;
        }
        canvas.width = width;
        canvas.height = Math.round((h / w) * width) || width;
        canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
        // motion: share of pixels whose brightness changed noticeably since the last frame
        const sctx = small.getContext("2d", { willReadFrequently: true })!;
        sctx.drawImage(canvas, 0, 0, 64, 48);
        const px = sctx.getImageData(0, 0, 64, 48).data;
        const gray = new Uint8ClampedArray(64 * 48);
        for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
        let changed = 0;
        if (prev) for (let i = 0; i < gray.length; i++) if (Math.abs(gray[i] - prev[i]) > 25) changed++;
        const motion = prev ? +((changed / gray.length) * 100).toFixed(1) : 0;
        prev = gray;
        c.status({ fill: motion >= (num(c.node.threshold) || 8) ? "yellow" : "green", shape: "dot", text: `motion ${motion}%` });
        if (c.node.motion && motion < (num(c.node.threshold) || 8)) return;
        const device = String(c.node.device || "camera");
        c.send(
          newMsg({
            topic: `devices/${device}/frame`,
            payload: { image: canvas.toDataURL("image/jpeg", 0.7), width: canvas.width, height: canvas.height, motion },
            device,
            metric: "motion",
            ts: new Date().toISOString(),
          }),
        );
        c.hooks.telemetry(device, "motion", motion, "%");
      } catch (e) {
        c.status({ fill: "red", shape: "ring", text: "no frame" });
        c.log(`Camera frame failed: ${(e as Error).message}`, "error");
      } finally {
        busy = false;
      }
    };

    if (source === "webcam") {
      c.status({ fill: "yellow", shape: "ring", text: "starting camera" });
      navigator.mediaDevices
        ?.getUserMedia({ video: true, audio: false })
        .then((s) => {
          stream = s;
          video = document.createElement("video");
          video.muted = true;
          video.playsInline = true;
          video.srcObject = s;
          return video.play();
        })
        .then(() => c.status({ fill: "green", shape: "dot", text: "streaming" }))
        .catch((e: Error) => {
          c.status({ fill: "red", shape: "ring", text: "camera blocked" });
          c.log(`Camera unavailable: ${e.message}`, "error");
        });
    }
    const t = setInterval(frame, Math.max(0.2, num(c.node.interval) || 5) * 1000);
    c.onClose(() => {
      clearInterval(t);
      stream?.getTracks().forEach((tr) => tr.stop());
    });
    return { trigger: frame };
  },

  telemetry(c) {
    return {
      input(msg) {
        let p = msg.payload;
        if (typeof p === "string") {
          try {
            p = JSON.parse(p);
          } catch {
            /* a plain value */
          }
        }
        const levels = String(msg.topic ?? "").split("/");
        const fromPayload = c.node.deviceFrom === "payload";
        const device = String((fromPayload ? getProp(p, String(c.node.deviceProp || "device")) : levels[num(c.node.level) || 0]) ?? msg.device ?? "unknown");
        const ts = String((p as Record<string, unknown> | null)?.ts ?? (p as Record<string, unknown> | null)?.timestamp ?? msg.ts ?? new Date().toISOString());
        const metrics: [string, number][] =
          p !== null && typeof p === "object"
            ? Object.entries(p as Record<string, unknown>)
                .filter(([k, v]) => !["ts", "timestamp", "time", String(c.node.deviceProp || "device")].includes(k) && (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)))))
                .map(([k, v]) => [k, Number(v)])
            : [[levels[levels.length - 1] || "value", valueOf(p)]];
        if (!metrics.length) return c.log("No numeric readings in the payload", "warn");
        if (c.node.split === false) {
          c.send({ ...msg, device, ts, payload: Object.fromEntries(metrics) });
        } else {
          for (const [metric, value] of metrics) c.send({ ...newMsg(), topic: `${device}/${metric}`, device, metric, ts, payload: value });
        }
        for (const [metric, value] of metrics) if (Number.isFinite(value)) c.hooks.telemetry(device, metric, value);
        c.status({ fill: "green", shape: "dot", text: `${device} · ${metrics.length} metric${metrics.length > 1 ? "s" : ""}` });
      },
    };
  },

  alarm(c) {
    const state = new Map<string, "normal" | "high" | "low">();
    const high = num(c.node.high);
    const low = num(c.node.low);
    const hyst = Math.abs(num(c.node.hysteresis) || 0);
    return {
      input(msg) {
        const v = valueOf(getProp(msg, String(c.node.property || "payload")));
        if (!Number.isFinite(v)) return;
        const key = keyOf(c.node, msg);
        const was = state.get(key) ?? "normal";
        let now = was;
        if (Number.isFinite(high) && v > high) now = "high";
        else if (Number.isFinite(low) && v < low) now = "low";
        else if (was === "high" && v < high - hyst) now = "normal";
        else if (was === "low" && v > low + hyst) now = "normal";
        if (now === was) return;
        state.set(key, now);
        const raised = [...state.values()].filter((s) => s !== "normal").length;
        c.status(raised ? { fill: "red", shape: "dot", text: `${raised} raised · ${now} ${fmt(v)}` } : { fill: "green", shape: "dot", text: "normal" });
        c.send({ ...msg, alarm: now, payload: { state: now, value: v, limit: now === "high" ? high : now === "low" ? low : null, device: msg.device, metric: msg.metric } });
      },
    };
  },

  "mqtt in"(c) {
    const client = acquireMqtt(String(c.node.broker), { username: String(c.node.username || "") || undefined, password: String(c.node.password || "") || undefined });
    const offStatus = client.onStatus((s, detail) => {
      c.status(s === "connected" ? { fill: "green", shape: "dot", text: "connected" } : s === "connecting" ? { fill: "yellow", shape: "ring", text: "connecting" } : { fill: "red", shape: "ring", text: "disconnected" });
      if (detail) c.log(detail, "error");
    });
    const dec = new TextDecoder();
    const off = client.subscribe(String(c.node.topic || "#"), Number(c.node.qos) || 0, (topic, bytes, info) => {
      let payload: unknown = bytes;
      const kind = c.node.datatype;
      if (kind !== "buffer") {
        const text = dec.decode(bytes);
        payload = text;
        if (kind === "json" || kind === "auto") {
          try {
            payload = JSON.parse(text);
          } catch {
            if (kind === "json") return c.log(`Not JSON on ${topic}`, "warn");
          }
        }
      } else payload = [...bytes];
      const levels = topic.split("/");
      const v = valueOf(payload);
      if (Number.isFinite(v)) c.hooks.telemetry(levels.length > 2 ? levels[levels.length - 2] : levels[0], levels[levels.length - 1], v);
      c.send(newMsg({ topic, payload, qos: info.qos, retain: info.retain }));
    });
    c.onClose(() => {
      off();
      offStatus();
      releaseMqtt(client);
    });
    return {};
  },

  "mqtt out"(c) {
    const client = acquireMqtt(String(c.node.broker), { username: String(c.node.username || "") || undefined, password: String(c.node.password || "") || undefined });
    const offStatus = client.onStatus((s, detail) => {
      c.status(s === "connected" ? { fill: "green", shape: "dot", text: "connected" } : s === "connecting" ? { fill: "yellow", shape: "ring", text: "connecting" } : { fill: "red", shape: "ring", text: "disconnected" });
      if (detail) c.log(detail, "error");
    });
    c.onClose(() => {
      offStatus();
      releaseMqtt(client);
    });
    return {
      input(msg) {
        const topic = String(c.node.topic || msg.topic || "");
        if (!topic) return c.log("No topic: set one on the node or in msg.topic", "warn");
        const p = msg.payload;
        client.publish(topic, p instanceof Uint8Array ? p : typeof p === "object" && p !== null ? JSON.stringify(p) : String(p ?? ""), Number(c.node.qos) || 0, !!c.node.retain);
      },
    };
  },

  "http request"(c) {
    return {
      async input(msg) {
        const url = template(String(c.node.url || msg.url || ""), msg);
        if (!url) return c.log("No URL: set one on the node or in msg.url", "warn");
        const method = c.node.method === "use" ? String(msg.method || "GET") : String(c.node.method || "GET");
        c.status({ fill: "blue", shape: "dot", text: "requesting" });
        try {
          const body = method === "GET" || method === "DELETE" ? undefined : typeof msg.payload === "object" ? JSON.stringify(msg.payload) : String(msg.payload ?? "");
          const res = await fetch(url, { method, body, headers: body && typeof msg.payload === "object" ? { "content-type": "application/json" } : undefined });
          const text = await res.text();
          let payload: unknown = text;
          if (c.node.ret === "obj")
            try {
              payload = JSON.parse(text);
            } catch {
              /* keep the text */
            }
          c.status({ fill: res.ok ? "green" : "red", shape: "dot", text: String(res.status) });
          c.send({ ...msg, payload, statusCode: res.status });
        } catch (e) {
          c.status({ fill: "red", shape: "ring", text: "failed" });
          c.log(`Request failed: ${(e as Error).message}`, "error");
        }
      },
    };
  },

  function(c) {
    let fn: (...args: unknown[]) => Promise<unknown>;
    try {
      fn = new Function("msg", "node", "context", "flow", `return (async () => {\n${c.node.func ?? "return msg;"}\n})();`) as typeof fn;
    } catch (e) {
      c.status({ fill: "red", shape: "dot", text: "syntax error" });
      c.log(`Syntax error: ${(e as Error).message}`, "error");
      return {};
    }
    const store = new Map<string, unknown>();
    const context = { get: (k: string) => store.get(k), set: (k: string, v: unknown) => void store.set(k, v) };
    const node = {
      id: c.node.id,
      name: c.node.name,
      send: (m: Msg | (Msg | null)[]) => c.send(Array.isArray(m) ? m : { ...newMsg(), ...m }),
      warn: (v: unknown) => c.log(v, "warn"),
      error: (v: unknown) => c.log(v, "error"),
      log: (v: unknown) => c.log(v),
      status: (s: NodeStatus) => c.status(s),
      done: () => {},
    };
    return {
      async input(msg) {
        try {
          const out = await fn(msg, node, context, c.runtime.flowContext);
          if (out !== undefined && out !== null) c.send(out as Msg | (Msg | Msg[] | null)[]);
        } catch (e) {
          c.status({ fill: "red", shape: "dot", text: "error" });
          c.log(`${(e as Error).message}`, "error");
        }
      },
    };
  },

  change(c) {
    type Rule = { t: string; p: string; to?: unknown; tot?: string };
    const rules = (c.node.rules as Rule[] | undefined) ?? [];
    return {
      input(msg) {
        try {
          for (const r of rules) {
            if (r.t === "set") setProp(msg, r.p, typed(r.to, r.tot, msg));
            else if (r.t === "delete") deleteProp(msg, r.p);
            else if (r.t === "move") {
              const v = getProp(msg, r.p);
              deleteProp(msg, r.p);
              setProp(msg, String(r.to), v);
            }
          }
          c.send(msg);
        } catch (e) {
          c.log(`Rule failed: ${(e as Error).message}`, "error");
        }
      },
    };
  },

  switch(c) {
    type Rule = { t: string; v?: unknown; vt?: string; v2?: unknown };
    const rules = (c.node.rules as Rule[] | undefined) ?? [];
    const all = String(c.node.checkall) !== "false";
    const test = (r: Rule, v: unknown, matched: boolean, msg: Msg): boolean => {
      const want = r.vt === "num" ? Number(r.v) : typed(r.v, r.vt, msg);
      const n = Number(v);
      switch (r.t) {
        case "eq":
          return r.vt === "num" ? n === want : v == want;
        case "neq":
          return r.vt === "num" ? n !== want : v != want;
        case "lt":
          return n < Number(want);
        case "lte":
          return n <= Number(want);
        case "gt":
          return n > Number(want);
        case "gte":
          return n >= Number(want);
        case "btwn":
          return n >= Math.min(Number(r.v), Number(r.v2)) && n <= Math.max(Number(r.v), Number(r.v2));
        case "cont":
          return String(v).includes(String(r.v));
        case "regex":
          try {
            return new RegExp(String(r.v)).test(String(v));
          } catch {
            return false;
          }
        case "true":
          return v === true;
        case "false":
          return v === false;
        case "null":
          return v === null || v === undefined;
        case "nnull":
          return v !== null && v !== undefined;
        case "else":
          return !matched;
        default:
          return false;
      }
    };
    return {
      input(msg) {
        const v = getProp(msg, String(c.node.property || "payload"));
        const out: (Msg | null)[] = rules.map(() => null);
        let matched = false;
        for (let i = 0; i < rules.length; i++) {
          if (!test(rules[i], v, matched, msg)) continue;
          out[i] = matched ? clone(msg) : msg;
          matched = true;
          if (!all) break;
        }
        if (matched) c.send(out);
      },
    };
  },

  range(c) {
    const [a, b, x, y] = [num(c.node.minin), num(c.node.maxin), num(c.node.minout), num(c.node.maxout)];
    return {
      input(msg) {
        const prop = String(c.node.property || "payload");
        const n = Number(getProp(msg, prop));
        if (!Number.isFinite(n)) return c.log("Not a number", "warn");
        let r = ((n - a) / (b - a)) * (y - x) + x;
        if (c.node.action === "clamp") r = Math.min(Math.max(x, y), Math.max(Math.min(x, y), r));
        else if (c.node.action === "roll") {
          const span = y - x;
          r = ((((r - x) % span) + span) % span) + x;
        }
        setProp(msg, prop, c.node.round ? Math.round(r) : r);
        c.send(msg);
      },
    };
  },

  rbe(c) {
    const last = new Map<string, unknown>();
    const gapText = String(c.node.gap ?? "0").trim();
    const pct = gapText.endsWith("%");
    const gap = Number(gapText.replace("%", "")) || 0;
    return {
      input(msg) {
        const v = getProp(msg, String(c.node.property || "payload"));
        const key = keyOf(c.node, msg);
        const had = last.has(key);
        const prev = last.get(key);
        let pass: boolean;
        if (c.node.func === "rbe") pass = !had || JSON.stringify(v) !== JSON.stringify(prev);
        else {
          const n = valueOf(v);
          const p = valueOf(prev);
          if (!Number.isFinite(n)) return;
          const limit = pct ? Math.abs(p * gap) / 100 : gap;
          pass = c.node.func === "narrowband" ? !had || Math.abs(n - p) <= limit : !had || Math.abs(n - p) >= limit;
        }
        if (!pass) return;
        last.set(key, v);
        c.send(msg);
      },
    };
  },

  smooth(c) {
    const series = new Map<string, number[]>();
    const filtered = new Map<string, number>();
    const count = Math.max(1, num(c.node.count) || 5);
    const places = num(c.node.round);
    return {
      input(msg) {
        const prop = String(c.node.property || "payload");
        const n = Number(getProp(msg, prop));
        if (!Number.isFinite(n)) return;
        const key = keyOf(c.node, msg);
        const xs = [...(series.get(key) ?? []), n].slice(-count);
        series.set(key, xs);
        const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
        let r: number;
        if (c.node.action === "low" || c.node.action === "high") {
          const lp = filtered.has(key) ? filtered.get(key)! + (n - filtered.get(key)!) / count : n;
          filtered.set(key, lp);
          r = c.node.action === "low" ? lp : n - lp;
        } else if (c.node.action === "min") r = Math.min(...xs);
        else if (c.node.action === "max") r = Math.max(...xs);
        else if (c.node.action === "sd") r = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length);
        else r = mean;
        setProp(msg, prop, Number.isFinite(places) ? +r.toFixed(places) : r);
        c.send(msg);
      },
    };
  },

  window(c) {
    const buckets = new Map<string, { values: number[]; from: string; last: Msg }>();
    const flush = (key: string) => {
      const b = buckets.get(key);
      buckets.delete(key);
      if (!b?.values.length) return;
      const xs = b.values;
      c.send({
        ...newMsg(),
        topic: b.last.topic,
        device: b.last.device,
        metric: b.last.metric,
        payload: { count: xs.length, mean: +(xs.reduce((s, v) => s + v, 0) / xs.length).toFixed(4), min: Math.min(...xs), max: Math.max(...xs), first: xs[0], last: xs[xs.length - 1], from: b.from, to: new Date().toISOString() },
      });
    };
    if (c.node.mode !== "count") {
      const t = setInterval(() => [...buckets.keys()].forEach(flush), Math.max(1, num(c.node.seconds) || 60) * 1000);
      c.onClose(() => clearInterval(t));
    }
    return {
      input(msg) {
        const v = valueOf(getProp(msg, String(c.node.property || "payload")));
        if (!Number.isFinite(v)) return;
        const key = keyOf(c.node, msg);
        const b = buckets.get(key) ?? { values: [], from: new Date().toISOString(), last: msg };
        b.values.push(v);
        b.last = msg;
        buckets.set(key, b);
        c.status({ fill: "blue", shape: "ring", text: `${[...buckets.values()].reduce((s, x) => s + x.values.length, 0)} buffered` });
        if (c.node.mode === "count" && b.values.length >= Math.max(1, num(c.node.count) || 10)) flush(key);
      },
    };
  },

  delay(c) {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    c.onClose(() => timers.forEach(clearTimeout));
    if (c.node.pauseType === "rate") {
      const unit = { second: 1000, minute: 60000, hour: 3600000 }[String(c.node.rateUnits)] ?? 1000;
      const gap = unit / Math.max(0.001, num(c.node.rate) || 1);
      let lastSent = 0;
      const queue: Msg[] = [];
      let pump: ReturnType<typeof setInterval> | null = null;
      c.onClose(() => {
        if (pump) clearInterval(pump);
      });
      return {
        input(msg) {
          const now = Date.now();
          if (now - lastSent >= gap && !queue.length) {
            lastSent = now;
            return c.send(msg);
          }
          if (c.node.drop !== false) return;
          if (queue.length < 1000) queue.push(msg);
          c.status({ fill: "blue", shape: "ring", text: `${queue.length} queued` });
          pump ??= setInterval(() => {
            const m = queue.shift();
            if (m) {
              lastSent = Date.now();
              c.send(m);
            }
            c.status(queue.length ? { fill: "blue", shape: "ring", text: `${queue.length} queued` } : {});
            if (!queue.length && pump) {
              clearInterval(pump);
              pump = null;
            }
          }, gap);
        },
      };
    }
    const ms = (num(c.node.timeout) || 0) * ({ milliseconds: 1, seconds: 1000, minutes: 60000 }[String(c.node.timeoutUnits)] ?? 1000);
    return {
      input(msg) {
        const t = setTimeout(() => {
          timers.delete(t);
          c.send(msg);
        }, ms);
        timers.add(t);
      },
    };
  },

  json(c) {
    return {
      input(msg) {
        const prop = String(c.node.property || "payload");
        const v = getProp(msg, prop);
        try {
          if (typeof v === "string" && c.node.action !== "str") setProp(msg, prop, JSON.parse(v));
          else if (typeof v !== "string" && c.node.action !== "obj") setProp(msg, prop, JSON.stringify(v));
          c.send(msg);
        } catch (e) {
          c.log(`Not JSON: ${(e as Error).message}`, "error");
        }
      },
    };
  },

  "dataset out"(c) {
    const columns = [
      { name: "ts", type: "Timestamp" },
      { name: "topic", type: "String" },
      { name: "device", type: "String" },
      { name: "metric", type: "String" },
      { name: "value", type: "Double" },
      { name: "payload", type: "String" },
    ];
    const location = c.hooks.location ?? { id: null, name: "Files & Projects" };
    // keep appending to the file the last run wrote, unless the pipeline's folder changed since
    let itemId = (c.node.parentId ?? null) === location.id ? ((c.node.itemId as string | undefined) ?? null) : null;
    let rows: Record<string, unknown>[] = [];
    let written = 0;
    let writing: Promise<void> = Promise.resolve();
    const flush = () => {
      if (!rows.length) return writing;
      const batch = rows;
      rows = [];
      writing = writing.then(async () => {
        try {
          const res = await api.pipelineData.deploy({ name: String(c.node.dataset || "telemetry"), parent_id: location.id, item_id: itemId, mode: "append", columns, rows: batch });
          if (itemId !== res.item.id) c.hooks.datasetWritten(c.node.id, res.item.id, res.item.parent_id);
          itemId = res.item.id;
          written += batch.length;
          c.status({ fill: "green", shape: "dot", text: `${written} rows written` });
        } catch (e) {
          c.status({ fill: "red", shape: "ring", text: "write failed" });
          c.log(`Dataset write failed: ${(e as Error).message}`, "error");
        }
      });
      return writing;
    };
    const t = setInterval(flush, Math.max(2, num(c.node.flushSeconds) || 30) * 1000);
    c.onClose(() => {
      clearInterval(t);
      return flush();
    });
    return {
      input(msg) {
        const p = msg.payload;
        const v = valueOf(p);
        let text = typeof p === "string" ? p : JSON.stringify(p ?? null);
        if (text.length > 10000) text = `${text.slice(0, 10000)}…`;
        const ts = typeof msg.ts === "string" && !isNaN(Date.parse(msg.ts)) ? msg.ts : new Date().toISOString();
        rows.push({ ts, topic: msg.topic ?? null, device: msg.device ?? null, metric: msg.metric ?? null, value: Number.isFinite(v) ? v : null, payload: text });
        c.status({ fill: "blue", shape: "ring", text: `${written} written · ${rows.length} pending` });
        if (rows.length >= Math.max(1, num(c.node.flushRows) || 100)) void flush();
      },
    };
  },

  alert(c) {
    if (c.node.notify && typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
    let raised = 0;
    return {
      input(msg) {
        const text = template(String(c.node.message || "{{payload}}"), msg);
        const level = String(c.node.level || "warning");
        raised++;
        c.status({ fill: level === "info" ? "blue" : level === "critical" ? "red" : "yellow", shape: "dot", text: `${raised} raised` });
        c.hooks.alert(text, level);
        c.hooks.debug({ at: Date.now(), nodeId: c.node.id, nodeName: c.node.name || "alert", topic: msg.topic, value: text, level: "alert" });
        if (c.node.notify && typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(`${level.toUpperCase()} · ${c.node.name || "Device alert"}`, { body: text });
      },
    };
  },
};

// ---------------------------------------------------------------- runtime

export class FlowRuntime {
  private nodes = new Map<string, FlowNode>();
  private impls = new Map<string, Impl>();
  private closers: (() => void | Promise<void>)[] = [];
  private queue: { to: string; msg: Msg }[] = [];
  private draining = false;
  private debugOff = new Set<string>();
  readonly flowContext = (() => {
    const store = new Map<string, unknown>();
    return { get: (k: string) => store.get(k), set: (k: string, v: unknown) => void store.set(k, v) };
  })();
  /** messages delivered since start */
  delivered = 0;

  constructor(
    flow: Flow,
    private hooks: Hooks,
  ) {
    for (const n of flow.nodes) if (!n.d) this.nodes.set(n.id, n);
    for (const n of flow.nodes) if (n.type === "debug" && n.active === false) this.debugOff.add(n.id);
  }

  start() {
    for (const n of this.nodes.values()) {
      const def = defOf(n);
      const status = (s: NodeStatus) => this.hooks.status(n.id, s);
      const log = (value: unknown, level: DebugLevel = "log") =>
        this.hooks.debug({ at: Date.now(), nodeId: n.id, nodeName: n.name || def.label, value, level });
      if (def === UNKNOWN_DEF) {
        status({ fill: "red", shape: "ring", text: `unknown type "${n.type}"` });
        continue;
      }
      if (def.runtime === "gateway") {
        status({ fill: "grey", shape: "ring", text: "needs device gateway" });
        log(`${def.label} runs on the device gateway (server-side bridge for ${def.label.split(" ")[0]}); it is idle in the browser runtime.`, "warn");
        continue;
      }
      const make = IMPLS[n.type];
      if (!make) continue;
      try {
        this.impls.set(
          n.id,
          make({
            node: n,
            send: (out) => this.send(n, out),
            status,
            log,
            onClose: (fn) => this.closers.push(fn),
            hooks: this.hooks,
            runtime: this,
          }),
        );
      } catch (e) {
        status({ fill: "red", shape: "ring", text: "failed to start" });
        log((e as Error).message, "error");
      }
    }
  }

  async stop() {
    const closers = this.closers.splice(0);
    this.impls.clear();
    this.queue = [];
    await Promise.allSettled(closers.map((fn) => Promise.resolve().then(fn)));
  }

  /** inject's button (and a sensor / camera's "read now") */
  trigger(nodeId: string) {
    this.impls.get(nodeId)?.trigger?.();
  }

  debugActive = (nodeId: string) => !this.debugOff.has(nodeId);
  setDebugActive(nodeId: string, on: boolean) {
    if (on) this.debugOff.delete(nodeId);
    else this.debugOff.add(nodeId);
  }

  private send(from: FlowNode, out: Msg | null | (Msg | Msg[] | null)[]) {
    if (out === null || out === undefined) return;
    const ports = Array.isArray(out) ? out : [out];
    // a sensor's readings feed the Devices sidebar (other inputs report theirs as they decode them)
    if (from.type === "sensor")
      for (const m of ports.flat()) {
        const v = valueOf(m?.payload);
        if (m && typeof m.device === "string" && typeof m.metric === "string" && Number.isFinite(v))
          this.hooks.telemetry(m.device, m.metric, v, typeof m.unit === "string" ? m.unit : undefined);
      }
    ports.forEach((port, i) => {
      const targets = from.wires[i] ?? [];
      for (const m of Array.isArray(port) ? port : [port]) {
        if (!m) continue;
        targets.forEach((to, k) => this.queue.push({ to, msg: k === 0 ? m : clone(m) }));
      }
    });
    this.drain();
  }

  /** Delivers queued messages asynchronously, yielding to the page every so often. */
  private drain() {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      let n = 0;
      while (this.queue.length && n++ < 500) {
        const { to, msg } = this.queue.shift()!;
        const impl = this.impls.get(to);
        if (!impl?.input) continue;
        this.delivered++;
        try {
          const r = impl.input(msg);
          if (r instanceof Promise) r.catch((e: Error) => this.hooks.debug({ at: Date.now(), nodeId: to, nodeName: this.nodes.get(to)?.name || "node", value: e.message, level: "error" }));
        } catch (e) {
          this.hooks.debug({ at: Date.now(), nodeId: to, nodeName: this.nodes.get(to)?.name || "node", value: (e as Error).message, level: "error" });
        }
      }
      this.draining = false;
      if (this.queue.length) setTimeout(() => this.drain(), 0);
    });
  }
}
