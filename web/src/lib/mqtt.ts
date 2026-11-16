/**
 * A minimal MQTT 3.1.1 client over WebSocket, enough for device flows: connect (with optional
 * username / password), subscribe with + and # wildcards, publish at QoS 0 or 1, keep-alive pings.
 * Brokers must expose a WebSocket listener (Mosquitto `listener 9001` + `protocol websockets`,
 * EMQX / HiveMQ on 8083 / 8884 …). Connections are shared per broker URL and credentials.
 */

type Handler = (topic: string, payload: Uint8Array, packet: { retain: boolean; qos: number }) => void;
export type MqttStatus = "connecting" | "connected" | "closed" | "error";

const enc = new TextEncoder();

function remainingLength(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

const str = (s: string) => {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 0xff, ...b];
};

function packet(type: number, body: number[]): Uint8Array {
  return new Uint8Array([type, ...remainingLength(body.length), ...body]);
}

/** Whether a topic matches a subscription filter (+ = one level, # = the rest). */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

export class MqttClient {
  private ws: WebSocket | null = null;
  private buf = new Uint8Array(0);
  private nextId = 1;
  private ping: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private subs: { filter: string; qos: number; handler: Handler }[] = [];
  private queue: Uint8Array[] = [];
  private listeners = new Set<(s: MqttStatus, detail?: string) => void>();
  private closed = false;
  status: MqttStatus = "connecting";
  users = 0;

  constructor(
    readonly url: string,
    private opts: { clientId?: string; username?: string; password?: string; keepalive?: number } = {},
  ) {
    this.open();
  }

  private setStatus(s: MqttStatus, detail?: string) {
    this.status = s;
    this.listeners.forEach((l) => l(s, detail));
  }

  onStatus(l: (s: MqttStatus, detail?: string) => void) {
    this.listeners.add(l);
    l(this.status);
    return () => this.listeners.delete(l);
  }

  private open() {
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, ["mqtt"]);
    } catch (e) {
      this.setStatus("error", (e as Error).message);
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      const keepalive = this.opts.keepalive ?? 60;
      let flags = 0x02; // clean session
      const payload = str(this.opts.clientId || `bluesand-${Math.random().toString(16).slice(2, 10)}`);
      if (this.opts.username) {
        flags |= 0x80;
        payload.push(...str(this.opts.username));
        if (this.opts.password) {
          flags |= 0x40;
          payload.push(...str(this.opts.password));
        }
      }
      ws.send(packet(0x10, [...str("MQTT"), 4, flags, keepalive >> 8, keepalive & 0xff, ...payload]));
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(new Uint8Array([0xc0, 0])), (keepalive * 1000) / 2);
    };
    ws.onmessage = (e) => this.read(new Uint8Array(e.data as ArrayBuffer));
    ws.onerror = () => this.setStatus("error", `Could not reach ${this.url}`);
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      this.buf = new Uint8Array(0);
      if (this.closed) return this.setStatus("closed");
      if (this.status !== "error") this.setStatus("error", "Connection lost");
      this.retry = setTimeout(() => this.open(), 5000);
    };
  }

  private read(chunk: Uint8Array) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    for (;;) {
      if (this.buf.length < 2) return;
      let len = 0;
      let mul = 1;
      let i = 1;
      for (; ; i++) {
        if (i >= this.buf.length) return;
        len += (this.buf[i] & 0x7f) * mul;
        mul *= 128;
        if (!(this.buf[i] & 0x80)) break;
      }
      const start = i + 1;
      if (this.buf.length < start + len) return;
      this.handle(this.buf[0], this.buf.subarray(start, start + len));
      this.buf = this.buf.slice(start + len);
    }
  }

  private handle(header: number, body: Uint8Array) {
    const type = header >> 4;
    if (type === 2) {
      // CONNACK
      const rc = body[1];
      if (rc !== 0) {
        const why = ["", "unacceptable protocol version", "client id rejected", "server unavailable", "bad username or password", "not authorized"][rc];
        this.closed = true;
        this.setStatus("error", `Broker refused the connection: ${why ?? `code ${rc}`}`);
        this.ws?.close();
        return;
      }
      this.setStatus("connected");
      for (const s of this.subs) this.sendSubscribe(s.filter, s.qos);
      this.queue.splice(0).forEach((p) => this.ws?.send(p));
    } else if (type === 3) {
      // PUBLISH
      const qos = (header >> 1) & 3;
      const tlen = (body[0] << 8) | body[1];
      const topic = new TextDecoder().decode(body.subarray(2, 2 + tlen));
      let at = 2 + tlen;
      if (qos > 0) {
        const id = (body[at] << 8) | body[at + 1];
        at += 2;
        this.ws?.send(new Uint8Array([0x40, 2, id >> 8, id & 0xff]));
      }
      const payload = body.slice(at);
      for (const s of this.subs) if (topicMatches(s.filter, topic)) s.handler(topic, payload, { retain: !!(header & 1), qos });
    }
  }

  private sendSubscribe(filter: string, qos: number) {
    const id = this.nextId++ & 0xffff || 1;
    this.ws?.send(packet(0x82, [id >> 8, id & 0xff, ...str(filter), qos]));
  }

  subscribe(filter: string, qos: number, handler: Handler) {
    const sub = { filter, qos, handler };
    this.subs.push(sub);
    if (this.status === "connected") this.sendSubscribe(filter, qos);
    return () => {
      this.subs = this.subs.filter((s) => s !== sub);
      if (this.status === "connected" && !this.subs.some((s) => s.filter === filter)) {
        const id = this.nextId++ & 0xffff || 1;
        this.ws?.send(packet(0xa2, [id >> 8, id & 0xff, ...str(filter)]));
      }
    };
  }

  publish(topic: string, payload: string | Uint8Array, qos = 0, retain = false) {
    const data = typeof payload === "string" ? enc.encode(payload) : payload;
    const body = [...str(topic)];
    if (qos > 0) {
      const id = this.nextId++ & 0xffff || 1;
      body.push(id >> 8, id & 0xff);
    }
    const p = packet(0x30 | (Math.min(qos, 1) << 1) | (retain ? 1 : 0), [...body, ...data]);
    if (this.status === "connected") this.ws?.send(p);
    else if (this.queue.length < 1000) this.queue.push(p);
  }

  end() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(new Uint8Array([0xe0, 0]));
    this.ws?.close();
    this.setStatus("closed");
  }
}

// ---------------------------------------------------------------- shared connections

const pool = new Map<string, MqttClient>();

export function acquireMqtt(url: string, opts: { clientId?: string; username?: string; password?: string } = {}): MqttClient {
  const key = `${url}|${opts.username ?? ""}|${opts.clientId ?? ""}`;
  let c = pool.get(key);
  if (!c || c.status === "closed") {
    c = new MqttClient(url, opts);
    pool.set(key, c);
  }
  c.users++;
  return c;
}

export function releaseMqtt(c: MqttClient) {
  if (--c.users > 0) return;
  c.end();
  for (const [k, v] of pool) if (v === c) pool.delete(k);
}
