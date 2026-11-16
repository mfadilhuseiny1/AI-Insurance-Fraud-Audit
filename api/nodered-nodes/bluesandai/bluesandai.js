/**
 * BluesandAI platform nodes for Node-RED (mounted read-only into every Node-RED workspace at /data/nodes/bluesandai).
 *
 * Platform nodes reach the platform's API through BLUESANDAI_API with BLUESANDAI_TOKEN, a token that can only call
 * /api/nodered-platform/<workspace>/… (api/nodered_platform.py) and acts for the user who started Node-RED:
 *   dataset out  appends messages to a Parquet dataset in the workspace's (or device stream's) folder
 *   dataset in   reads a dataset's rows into msg.payload
 *   stream out   pushes msg.payload records into an ingest stream
 * Device nodes are the ones of Pipeline Builder's built-in device-stream editor, so its flows move over unchanged:
 * sensor, camera, telemetry, alarm, smooth, window, alert.
 */
module.exports = function (RED) {
  const API = (process.env.BLUESANDAI_API || "").replace(/\/$/, "");
  const TOKEN = process.env.BLUESANDAI_TOKEN || "";
  const WS = process.env.BLUESANDAI_WORKSPACE || "";
  const BASE = `${API}/api/nodered-platform/${WS}`;

  async function platform(path, opts = {}) {
    if (!API) throw new Error("not connected to the platform (start Node-RED from BluesandAI)");
    const res = await fetch(BASE + path, {
      ...opts,
      headers: { ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) },
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (e) {
      body = text;
    }
    if (!res.ok) throw new Error((body && body.detail) || `HTTP ${res.status}`);
    return body;
  }

  // ------------------------------------------------------------------ helpers (as in the built-in runtime)
  const num = (v) => (v === "" || v === null || v === undefined ? NaN : Number(v));
  const valueOf = (v) =>
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : num(v && typeof v === "object" ? v.value : undefined);
  const keyOf = (cfg, msg) => (cfg.perTopic === false || cfg.perTopic === "false" ? "_" : String(msg.topic ?? "_"));
  const fmt = (v) => (Number.isFinite(v) ? String(+v.toFixed(3)) : String(v));
  const getProp = (msg, path) => {
    try {
      return RED.util.getMessageProperty(msg, String(path || "payload"));
    } catch (e) {
      return undefined;
    }
  };
  const setProp = (msg, path, v) => RED.util.setMessageProperty(msg, String(path || "payload"), v, true);
  const template = (text, msg) =>
    String(text).replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_, p) => {
      const v = getProp(msg, p);
      return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  const SENSOR_METRICS = {
    temperature: { unit: "°C", base: 22, amplitude: 3, noise: 0.3 },
    humidity: { unit: "%", base: 45, amplitude: 8, noise: 1 },
    pressure: { unit: "hPa", base: 1013, amplitude: 4, noise: 0.5 },
    vibration: { unit: "mm/s", base: 2.5, amplitude: 1.5, noise: 0.6 },
    power: { unit: "kW", base: 12, amplitude: 5, noise: 0.8 },
    co2: { unit: "ppm", base: 600, amplitude: 150, noise: 20 },
    level: { unit: "%", base: 60, amplitude: 25, noise: 1 },
    flow: { unit: "L/min", base: 120, amplitude: 30, noise: 4 },
  };

  // ------------------------------------------------------------------ platform: dataset out
  function DatasetOut(cfg) {
    RED.nodes.createNode(this, cfg);
    const node = this;
    const name = String(cfg.dataset || "telemetry");
    let rows = [];
    let written = 0;
    let writing = Promise.resolve();
    const flush = () => {
      if (!rows.length) return writing;
      const batch = rows;
      rows = [];
      writing = writing.then(async () => {
        try {
          const r = await platform("/datasets/append", { method: "POST", body: JSON.stringify({ name, rows: batch }) });
          written += batch.length;
          node.status({ fill: "green", shape: "dot", text: `${written} rows written · ${r.rows} in ${r.name}` });
        } catch (e) {
          // kept for the next write
          rows = batch.concat(rows).slice(-50000);
          node.status({ fill: "red", shape: "ring", text: "write failed" });
          node.error(`Dataset write failed: ${e.message}`);
        }
      });
      return writing;
    };
    const t = setInterval(flush, Math.max(2, num(cfg.flushSeconds) || 30) * 1000);
    node.on("input", (msg, send, done) => {
      const p = msg.payload;
      const v = valueOf(p);
      let text = typeof p === "string" ? p : JSON.stringify(p ?? null);
      if (text && text.length > 10000) text = `${text.slice(0, 10000)}…`;
      const ts = typeof msg.ts === "string" && !isNaN(Date.parse(msg.ts)) ? msg.ts : new Date().toISOString();
      rows.push({ ts, topic: msg.topic ?? null, device: msg.device ?? null, metric: msg.metric ?? null, value: Number.isFinite(v) ? v : null, payload: text });
      node.status({ fill: "blue", shape: "ring", text: `${written} written · ${rows.length} pending` });
      if (rows.length >= Math.max(1, num(cfg.flushRows) || 100)) flush();
      done();
    });
    node.on("close", (done) => {
      clearInterval(t);
      flush().then(() => done(), () => done());
    });
  }
  RED.nodes.registerType("bluesandai dataset out", DatasetOut);

  // ------------------------------------------------------------------ platform: dataset in
  function DatasetIn(cfg) {
    RED.nodes.createNode(this, cfg);
    const node = this;
    node.on("input", async (msg, send, done) => {
      const name = String(msg.dataset || cfg.dataset || "");
      if (!name) return done(new Error("Set the dataset to read"));
      node.status({ fill: "blue", shape: "ring", text: "reading" });
      try {
        const r = await platform(`/datasets/read?name=${encodeURIComponent(name)}&limit=${Math.max(1, num(cfg.limit) || 1000)}`);
        msg.payload = r.rows;
        msg.columns = r.columns;
        msg.dataset = r.name;
        node.status({ fill: "green", shape: "dot", text: `${r.rows.length} of ${r.total} rows` });
        send(msg);
        done();
      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: "read failed" });
        done(e);
      }
    });
  }
  RED.nodes.registerType("bluesandai dataset in", DatasetIn);

  // ------------------------------------------------------------------ platform: stream out
  function StreamOut(cfg) {
    RED.nodes.createNode(this, cfg);
    const node = this;
    let pushed = 0;
    node.on("input", async (msg, send, done) => {
      const stream = String(msg.stream || cfg.stream || "");
      if (!stream) return done(new Error("Choose the ingest stream to push to"));
      const p = msg.payload;
      const records = (Array.isArray(p) ? p : [p]).map((r) =>
        r !== null && typeof r === "object" ? r : { topic: msg.topic ?? null, device: msg.device ?? null, metric: msg.metric ?? null, value: r, ts: msg.ts ?? new Date().toISOString() },
      );
      try {
        await platform(`/streams/${encodeURIComponent(stream)}/records`, { method: "POST", body: JSON.stringify(records) });
        pushed += records.length;
        node.status({ fill: "green", shape: "dot", text: `${pushed} pushed` });
        done();
      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: "push failed" });
        done(e);
      }
    });
  }
  RED.nodes.registerType("bluesandai stream out", StreamOut);

  // the editor's pickers: datasets in the folder, streams the user can see
  RED.httpAdmin.get("bluesandai/datasets", RED.auth.needsPermission("flows.read"), (req, res) =>
    platform("/datasets").then((r) => res.json(r), (e) => res.status(502).json({ error: e.message })),
  );
  RED.httpAdmin.get("bluesandai/streams", RED.auth.needsPermission("flows.read"), (req, res) =>
    platform("/streams").then((r) => res.json(r), (e) => res.status(502).json({ error: e.message })),
  );

  // ------------------------------------------------------------------ devices: sensor (simulated)
  function Sensor(cfg) {
    RED.nodes.createNode(this, cfg);
    const node = this;
    const m = String(cfg.metric || "temperature");
    const metric = SENSOR_METRICS[m] || SENSOR_METRICS.temperature;
    const device = String(cfg.device || "sensor");
    const phase = [...device].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
    const tick = () => {
      const t = Date.now() / 1000;
      const gauss = Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
      let value = metric.base + metric.amplitude * Math.sin((2 * Math.PI * t) / 180 + phase) + metric.noise * gauss;
      if (Math.random() * 100 < (num(cfg.spike) || 0)) value += (Math.random() < 0.5 ? -1 : 1) * metric.amplitude * (3 + 2 * Math.random());
      value = +value.toFixed(2);
      const ts = new Date().toISOString();
      node.status({ fill: "green", shape: "dot", text: `${value} ${metric.unit}` });
      node.send({
        topic: `${cfg.topicPrefix || "devices"}/${device}/${m}`,
        payload: cfg.format === "object" ? { device, metric: m, value, unit: metric.unit, ts } : value,
        device,
        metric: m,
        unit: metric.unit,
        ts,
      });
    };
    const t = setInterval(tick, Math.max(0.1, num(cfg.interval) || 2) * 1000);
    node.on("input", (msg, send, done) => (tick(), done()));
    node.on("close", () => clearInterval(t));
  }
  RED.nodes.registerType("bluesandai sensor", Sensor);

  // ------------------------------------------------------------------ devices: camera (snapshot URL)
  function Camera(cfg) {
    RED.nodes.createNode(this, cfg);
    const node = this;
    const device = String(cfg.device || "camera");
    let prev = null;
    let busy = false;
    const frame = async () => {
      if (busy) return;
      if (!cfg.url) return node.status({ fill: "grey", shape: "ring", text: "set a snapshot URL" });
      busy = true;
      try {
        const res = await fetch(String(cfg.url), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        // motion: share of sampled bytes that changed noticeably (a cheap proxy without decoding the image)
        let motion = 0;
        if (prev) {
          const n = Math.min(prev.length, buf.length);
          const step = Math.max(1, Math.floor(n / 4096));
          let changed = 0;
          let seen = 0;
          for (let i = 0; i < n; i += step, seen++) if (Math.abs(buf[i] - prev[i]) > 25) changed++;
          motion = seen ? +((changed / seen) * 100).toFixed(1) : 0;
        }
        prev = buf;
        const threshold = num(cfg.threshold) || 8;
        node.status({ fill: motion >= threshold ? "yellow" : "green", shape: "dot", text: `motion ${motion}%` });
        if (cfg.motion && motion < threshold) return;
        const type = res.headers.get("content-type") || "image/jpeg";
        node.send({
          topic: `devices/${device}/frame`,
          payload: { image: `data:${type};base64,${buf.toString("base64")}`, bytes: buf.length, motion },
          device,
          metric: "motion",
          ts: new Date().toISOString(),
        });
      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: "no frame" });
        node.error(`Camera frame failed: ${e.message}`);
      } finally {
        busy = false;
      }
    };
    const t = setInterval(frame, Math.max(0.2, num(cfg.interval) || 5) * 1000);
    node.on("input", (msg, send, done) => frame().then(() => done()));
    node.on("close", () => clearInterval(t));
  }
  RED.nodes.registerType("bluesandai camera", Camera);

  // ------------------------------------------------------------------ devices: telemetry
  function Telemetry(cfg) {
    RED.nodes.createNode(this, cfg);
    const node = this;
    node.on("input", (msg, send, done) => {
      let p = msg.payload;
      if (typeof p === "string") {
        try {
          p = JSON.parse(p);
        } catch (e) {
          /* a plain value */
        }
      }
      const levels = String(msg.topic ?? "").split("/");
      const prop = String(cfg.deviceProp || "device");
      const fromPayload = cfg.deviceFrom === "payload";
      const device = String((fromPayload ? (p && typeof p === "object" ? p[prop] : undefined) : levels[num(cfg.level) || 0]) ?? msg.device ?? "unknown");
      const ts = String((p && typeof p === "object" && (p.ts ?? p.timestamp)) || msg.ts || new Date().toISOString());
      const metrics =
        p !== null && typeof p === "object"
          ? Object.entries(p)
              .filter(([k, v]) => !["ts", "timestamp", "time", prop].includes(k) && (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)))))
              .map(([k, v]) => [k, Number(v)])
          : [[levels[levels.length - 1] || "value", valueOf(p)]];
      if (!metrics.length) {
        node.warn("No numeric readings in the payload");
        return done();
      }
      if (cfg.split === false || cfg.split === "false") send({ ...msg, device, ts, payload: Object.fromEntries(metrics) });
      else for (const [metric, value] of metrics) send({ _msgid: RED.util.generateId(), topic: `${device}/${metric}`, device, metric, ts, payload: value });
      node.status({ fill: "green", shape: "dot", text: `${device} · ${metrics.length} metric${metrics.length > 1 ? "s" : ""}` });
      done();
    });
  }
  RED.nodes.registerType("bluesandai telemetry", Telemetry);

  // ------------------------------------------------------------------ devices: alarm
  function Alarm(cfg) {
    RED.nodes.createNode(this, cfg);
    const node = this;
    const state = new Map();
    const high = num(cfg.high);
    const low = num(cfg.low);
    const hyst = Math.abs(num(cfg.hysteresis) || 0);
    node.on("input", (msg, send, done) => {
      const v = valueOf(getProp(msg, cfg.property || "payload"));
      if (!Number.isFinite(v)) return done();
      const key = keyOf(cfg, msg);
      const was = state.get(key) || "normal";
      let now = was;
      if (Number.isFinite(high) && v > high) now = "high";
      else if (Number.isFinite(low) && v < low) now = "low";
      else if (was === "high" && v < high - hyst) now = "normal";
      else if (was === "low" && v > low + hyst) now = "normal";
      if (now !== was) {
        state.set(key, now);
        const raised = [...state.values()].filter((s) => s !== "normal").length;
        node.status(raised ? { fill: "red", shape: "dot", text: `${raised} raised · ${now} ${fmt(v)}` } : { fill: "green", shape: "dot", text: "normal" });
        send({ ...msg, alarm: now, payload: { state: now, value: v, limit: now === "high" ? high : now === "low" ? low : null, device: msg.device, metric: msg.metric } });
      }
      done();
    });
  }
  RED.nodes.registerType("bluesandai alarm", Alarm);

  // ------------------------------------------------------------------ function: smooth
  function Smooth(cfg) {
    RED.nodes.createNode(this, cfg);
    const node = this;
    const series = new Map();
    const filtered = new Map();
    const count = Math.max(1, num(cfg.count) || 5);
    const places = num(cfg.round);
    node.on("input", (msg, send, done) => {
      const prop = cfg.property || "payload";
      const n = Number(getProp(msg, prop));
      if (!Number.isFinite(n)) return done();
      const key = keyOf(cfg, msg);
      const xs = [...(series.get(key) || []), n].slice(-count);
      series.set(key, xs);
      const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
      let r;
      if (cfg.action === "low" || cfg.action === "high") {
        const lp = filtered.has(key) ? filtered.get(key) + (n - filtered.get(key)) / count : n;
        filtered.set(key, lp);
        r = cfg.action === "low" ? lp : n - lp;
      } else if (cfg.action === "min") r = Math.min(...xs);
      else if (cfg.action === "max") r = Math.max(...xs);
      else if (cfg.action === "sd") r = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length);
      else r = mean;
      setProp(msg, prop, Number.isFinite(places) ? +r.toFixed(places) : r);
      send(msg);
      done();
    });
  }
  RED.nodes.registerType("bluesandai smooth", Smooth);

  // ------------------------------------------------------------------ function: window
  function Window(cfg) {
    RED.nodes.createNode(this, cfg);
    const node = this;
    const buckets = new Map();
    const flush = (key) => {
      const b = buckets.get(key);
      buckets.delete(key);
      if (!b || !b.values.length) return;
      const xs = b.values;
      node.send({
        topic: b.last.topic,
        device: b.last.device,
        metric: b.last.metric,
        payload: { count: xs.length, mean: +(xs.reduce((s, v) => s + v, 0) / xs.length).toFixed(4), min: Math.min(...xs), max: Math.max(...xs), first: xs[0], last: xs[xs.length - 1], from: b.from, to: new Date().toISOString() },
      });
    };
    let t = null;
    if (cfg.mode !== "count") t = setInterval(() => [...buckets.keys()].forEach(flush), Math.max(1, num(cfg.seconds) || 60) * 1000);
    node.on("input", (msg, send, done) => {
      const v = valueOf(getProp(msg, cfg.property || "payload"));
      if (!Number.isFinite(v)) return done();
      const key = keyOf(cfg, msg);
      const b = buckets.get(key) || { values: [], from: new Date().toISOString(), last: msg };
      b.values.push(v);
      b.last = msg;
      buckets.set(key, b);
      node.status({ fill: "blue", shape: "ring", text: `${[...buckets.values()].reduce((s, x) => s + x.values.length, 0)} buffered` });
      if (cfg.mode === "count" && b.values.length >= Math.max(1, num(cfg.count) || 10)) flush(key);
      done();
    });
    node.on("close", () => t && clearInterval(t));
  }
  RED.nodes.registerType("bluesandai window", Window);

  // ------------------------------------------------------------------ storage & alerts: alert
  function Alert(cfg) {
    RED.nodes.createNode(this, cfg);
    const node = this;
    let raised = 0;
    node.on("input", (msg, send, done) => {
      const level = String(cfg.level || "warning");
      const text = template(cfg.message || "{{payload}}", msg);
      raised++;
      node.status({ fill: level === "info" ? "blue" : level === "critical" ? "red" : "yellow", shape: "dot", text: `${raised} raised` });
      // the Debug sidebar shows it (warnings yellow, critical red)
      if (level === "critical") node.error(text, msg);
      else if (level === "warning") node.warn(text);
      else node.log(text);
      send({ ...msg, alert: { level, text } });
      done();
    });
  }
  RED.nodes.registerType("bluesandai alert", Alert);
};
