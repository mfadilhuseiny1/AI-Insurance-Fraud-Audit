"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { mqttBroker, type BrokerLogin, type BrokerStatus, type TopicAccess } from "@/lib/mqttBroker";

const ACCESS: { value: TopicAccess; label: string; short: string }[] = [
  { value: "readwrite", label: "send and receive", short: "send & receive" },
  { value: "read", label: "receive only", short: "receive only" },
  { value: "write", label: "send only", short: "send only" },
];

/** A topic pattern in words: "plant/#" → "everything under plant/". */
function patternText(p: string): string {
  if (p === "#") return "every topic";
  if (p.endsWith("/#")) return `everything under ${p.slice(0, -1)}`;
  if (p.includes("+")) return "topics matching this pattern (+ = any one level)";
  return "this topic only";
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function duration(s: number | null | undefined): string {
  if (s === null || s === undefined) return "—";
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

/** The platform's MQTT broker, explained for people new to MQTT: what it is, how to use it, who can connect, what arrives. */
export default function MqttBrokerPage() {
  const [st, setSt] = useState<BrokerStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<(BrokerLogin & { password: string }) | null>(null);
  const load = useCallback(() => mqttBroker.status().then((s) => (setSt(s), setErr(null)), (e: Error) => setErr(e.message)), []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (err && !st) return <ApiError message={err} />;
  if (!st) return <Loading label="Opening the MQTT broker…" />;
  const up = st.status === "running";
  const act = async (what: "start" | "stop") => {
    if (what === "stop" && !confirm("Stop the broker? Every device and Node-RED flow using it is disconnected until it starts again.")) return;
    setBusy(what);
    try {
      setSt({ ...st, ...(await (what === "start" ? mqttBroker.start() : mqttBroker.stop())) });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const port = st.ports?.mqtt ?? 1883;
  const sum = st.summary ?? {};
  const userLogins = st.credentials.filter((c) => c.kind === "user");

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-mqtt-broker>
      <AppHeader app="MQTT Broker" icon="signal" href="/mqtt-broker">
        <span className={`ml-auto flex items-center gap-2 rounded-full px-2.5 py-1 text-xs ${up ? "bg-ok/10 text-ok" : "bg-panel-2 text-muted"}`}>
          <span className={`h-2 w-2 rounded-full ${up ? "bg-ok" : "bg-line-2"}`} />
          {up ? "Running" : st.enabled ? "Stopped · starts with the first Node-RED flow" : "Stopped"}
        </span>
        {st.can_manage &&
          (up ? (
            <button type="button" disabled={!!busy} onClick={() => act("stop")} className={buttonClass.secondary} data-broker-stop>
              <Icon name="stop" className="h-3.5 w-3.5" /> {busy === "stop" ? "Stopping…" : "Stop broker"}
            </button>
          ) : (
            <button type="button" disabled={!!busy} onClick={() => act("start")} className={buttonClass.primary} data-broker-start>
              <Icon name="play" className="h-3.5 w-3.5" /> {busy === "start" ? "Starting…" : "Start broker"}
            </button>
          ))}
      </AppHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-6 p-5">
          {err && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</p>}

          {/* what it is, and how to use it */}
          <section className="rounded-2xl border border-line bg-gradient-to-br from-ocean/10 via-panel to-panel p-6" data-broker-intro>
            <div className="flex items-start gap-4">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-ocean/15 text-ocean">
                <Icon name="signal" className="h-6 w-6" />
              </span>
              <div className="min-w-0">
                <h1 className="text-lg font-semibold text-strong">The message hub for your devices</h1>
                <p className="mt-1 max-w-3xl text-sm text-soft">
                  Devices and gateways <b className="text-strong">send</b> readings to named <b className="text-strong">topics</b> such as{" "}
                  <code className="rounded bg-ink px-1">factory/line1/temperature</code>. Anything that <b className="text-strong">listens</b> to that topic —
                  a Node-RED flow, a Streaming sync, a dashboard — gets each reading the moment it arrives.
                </p>
              </div>
            </div>
            <ol className="mt-5 grid gap-3 md:grid-cols-3">
              <Step n={1} title="Give each device a login" text="A username and password, allowed to use only the topics you choose.">
                {st.can_create && (
                  <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary} data-broker-new-login>
                    <Icon name="plus" className="h-3.5 w-3.5" /> New login
                  </button>
                )}
              </Step>
              <Step n={2} title="Point the device here" text={`Server localhost, port ${port}, with that login (see “How to connect” below).`} />
              <Step n={3} title="Use the readings" text="In Node-RED, an mqtt in node with the broker “BluesandAI MQTT”; or a Streaming sync to keep them.">
                <Link href="/pipeline?new=device" className={buttonClass.secondary}>
                  <Icon name="signal" className="h-3.5 w-3.5" /> New Node-RED flow
                </Link>
              </Step>
            </ol>
          </section>

          {/* the numbers that matter */}
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat icon="device" label="Connected now" value={up ? String(sum.clients ?? "—") : "—"} hint="devices, tools and Node-RED flows" />
            <Stat icon="wave" label="Messages in the last minute" value={up ? String(sum.messages_last_minute ?? 0) : "—"} hint="sent by devices and flows" />
            <Stat icon="list" label="Topics in use" value={up ? String(sum.topics ?? 0) : "—"} hint="seen since the platform last restarted" />
            <Stat icon="clock" label="Running for" value={up ? duration(sum.uptime_seconds) : "—"} hint={up ? "keeps running until stopped" : "not running"} />
          </section>

          {/* how to connect */}
          <section className="rounded-xl border border-line bg-panel" data-broker-connect>
            <SectionHead icon="plug" title="How to connect" note="Only programs on this machine can connect — devices on other machines cannot reach it yet." />
            <div className="grid gap-px bg-line md:grid-cols-3">
              <Connect title="Node-RED flows" badge="Nothing to set up">
                <p>
                  In an <b className="text-strong">mqtt in</b> or <b className="text-strong">mqtt out</b> node, choose the server{" "}
                  <b className="text-strong">BluesandAI MQTT</b>. Every Node-RED flow has it, with its own login already filled in.
                </p>
              </Connect>
              <Connect title="Apps & gateways on this machine" badge="Use a login">
                <Field label="Server" value="localhost" />
                <Field label="Port" value={String(port)} />
                <Field label="Username & password" value="a login from the list below" plain />
                <p className="mt-2">
                  Also for{" "}
                  <Link href="/streaming" className="text-ocean hover:underline">
                    Streaming
                  </Link>{" "}
                  MQTT syncs, MQTT Explorer, mosquitto_pub.
                </p>
              </Connect>
              <Connect title="Web pages (MQTT over WebSocket)" badge="Use a login">
                <Field label="Address" value={st.addresses.websocket ?? "ws://localhost:9001"} />
                <p className="mt-2">For browser apps and dashboards that speak MQTT over WebSocket.</p>
              </Connect>
            </div>
          </section>

          <Logins st={st} logins={userLogins} onCreate={() => setCreating(true)} onChange={load} />
          <Topics st={st} />
          {up && st.can_create && <Publish onSent={load} />}

          <details className="rounded-xl border border-line bg-panel px-4 py-3 text-xs text-muted">
            <summary className="cursor-pointer text-soft">Technical details</summary>
            <dl className="mt-3 grid gap-x-6 gap-y-1 md:grid-cols-2">
              <Tech k="Software" v={st.image} />
              <Tech k="Inside Node-RED" v={st.addresses.node_red} />
              <Tech k="MQTT on this machine" v={st.addresses.this_machine ?? "—"} />
              <Tech k="WebSocket" v={st.addresses.websocket ?? "—"} />
              <Tech k="Subscriptions" v={st.stats["subscriptions/count"] ?? "—"} />
              <Tech k="Retained messages (incl. the broker's own)" v={st.stats["retained messages/count"] ?? "—"} />
              <Tech k="Messages sent / min (incl. the platform's monitor)" v={st.stats["load/messages/sent/1min"] ?? "—"} />
              <Tech k="Node-RED logins (automatic)" v={String(st.credentials.length - userLogins.length)} />
            </dl>
          </details>
        </div>
      </div>
      {creating && (
        <NewLogin
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setCreated(c);
            void load();
          }}
        />
      )}
      {created && <ShowPassword login={created} port={port} onClose={() => setCreated(null)} />}
    </div>
  );
}

function Step({ n, title, text, children }: { n: number; title: string; text: string; children?: React.ReactNode }) {
  return (
    <li className="flex flex-col rounded-xl border border-line bg-panel/80 p-4">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ocean text-xs font-semibold text-white">{n}</span>
        <span className="text-sm font-semibold text-strong">{title}</span>
      </div>
      <p className="mt-2 flex-1 text-xs leading-relaxed text-muted">{text}</p>
      {children && <div className="mt-3">{children}</div>}
    </li>
  );
}

function Stat({ icon, label, value, hint }: { icon: IconName; label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <Icon name={icon} className="h-3.5 w-3.5" /> {label}
      </div>
      <div className="mt-1 truncate text-2xl font-semibold text-strong">{value}</div>
      <div className="text-[11px] text-muted">{hint}</div>
    </div>
  );
}

function SectionHead({ icon, title, note, children }: { icon: IconName; title: string; note?: string; children?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3">
      <Icon name={icon} className="h-4 w-4 text-ocean" />
      <h2 className="text-sm font-semibold text-strong">{title}</h2>
      {note && <span className="text-xs text-muted">{note}</span>}
      {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </header>
  );
}

function Connect({ title, badge, children }: { title: string; badge: string; children: React.ReactNode }) {
  return (
    <div className="bg-panel p-4 text-xs leading-relaxed text-muted">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium text-strong">{title}</span>
        <span className="rounded-full bg-panel-2 px-2 py-0.5 text-[10px] text-soft">{badge}</span>
      </div>
      {children}
    </div>
  );
}

function Field({ label, value, plain }: { label: string; value: string; plain?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="w-36 shrink-0">{label}</span>
      {plain ? (
        <span className="text-soft">{value}</span>
      ) : (
        <>
          <code className="min-w-0 truncate rounded bg-ink px-1.5 py-0.5 text-strong">{value}</code>
          <button
            type="button"
            title="Copy"
            onClick={() => void navigator.clipboard?.writeText(value).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1200)))}
            className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white"
          >
            <Icon name={copied ? "check" : "copy"} className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  );
}

function Tech({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-line/50 py-1">
      <dt>{k}</dt>
      <dd className="font-mono text-soft">{v}</dd>
    </div>
  );
}

function Logins({ st, logins, onCreate, onChange }: { st: BrokerStatus; logins: BrokerLogin[]; onCreate: () => void; onChange: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const del = async (c: BrokerLogin) => {
    if (!confirm(`Delete the login "${c.username}"? Devices using it can no longer connect.`)) return;
    try {
      await mqttBroker.deleteLogin(c.id);
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <section className="rounded-xl border border-line bg-panel" data-broker-logins>
      <SectionHead icon="lock" title="Device logins" note={`Each device or app signs in with its own login and may only use the topics listed. ${st.can_manage ? "You see everyone's logins." : "You see your own logins."}`}>
        {st.can_create && (
          <button type="button" onClick={onCreate} className={buttonClass.primary}>
            <Icon name="plus" className="h-3.5 w-3.5" /> New login
          </button>
        )}
      </SectionHead>
      {err && <p className="px-4 pt-3 text-xs text-bad">{err}</p>}
      {logins.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">No device logins yet. Create one for each device, gateway or app that connects. (Node-RED flows have their own automatically.)</p>
      ) : (
        <ul className="divide-y divide-line">
          {logins.map((c) => (
            <li key={c.id} className="flex items-start gap-4 px-4 py-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-panel-2 text-soft">
                <Icon name="device" className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <code className="text-sm text-strong">{c.username}</code>
                  {c.label && <span className="text-xs text-muted">{c.label}</span>}
                </div>
                <div className="mt-1 space-y-0.5 text-xs text-muted">
                  {c.topics.map((t, i) => (
                    <div key={i}>
                      Can <b className="text-soft">{ACCESS.find((a) => a.value === t.access)?.label}</b> on <code className="rounded bg-ink px-1 text-soft">{t.pattern}</code>{" "}
                      <span>({patternText(t.pattern)})</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="shrink-0 text-right text-[11px] text-muted">
                {c.owner_name && <div>by {c.owner_name}</div>}
                <div>{ago(c.created_at)}</div>
              </div>
              <button type="button" onClick={() => del(c)} className={buttonClass.ghost} title="Delete login">
                <Icon name="trash" className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Topics({ st }: { st: BrokerStatus }) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => st.topics.filter((t) => t.topic.toLowerCase().includes(q.toLowerCase())), [st.topics, q]);
  return (
    <section className="rounded-xl border border-line bg-panel" data-broker-topics>
      <SectionHead icon="wave" title="Messages arriving" note="Each topic with its latest message. Updates every 5 seconds.">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a topic…" className={`${inputClass} w-56`} />
      </SectionHead>
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">
          {st.status !== "running" ? "The broker is stopped." : q ? "No topic matches." : "No messages yet. Send a test message below, or connect a device."}
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Topic</th>
              <th className="px-4 py-2 font-medium">Latest message</th>
              <th className="px-4 py-2 text-right font-medium">Messages</th>
              <th className="px-4 py-2 text-right font-medium">Last one</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.topic} className="border-t border-line">
                <td className="px-4 py-1.5">
                  <code className="text-strong">{t.topic}</code>
                  {t.retained && (
                    <span className="ml-2 rounded bg-panel-2 px-1.5 text-[10px] text-muted" title="Kept by the broker and given to anyone who starts listening">
                      kept
                    </span>
                  )}
                </td>
                <td className="max-w-md truncate px-4 py-1.5 font-mono text-xs text-soft" title={t.last}>
                  {t.last}
                </td>
                <td className="px-4 py-1.5 text-right tabular-nums text-soft">{t.count.toLocaleString()}</td>
                <td className="px-4 py-1.5 text-right text-xs text-muted" title={new Date(t.last_at).toLocaleString()}>
                  {ago(t.last_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Publish({ onSent }: { onSent: () => void }) {
  const [topic, setTopic] = useState("test/hello");
  const [payload, setPayload] = useState('{"value": 21.5}');
  const [retain, setRetain] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async () => {
    try {
      await mqttBroker.publish({ topic, payload, retain });
      setMsg({ ok: true, text: `Sent to ${topic} — it appears under “Messages arriving”, and every listener of that topic got it.` });
      setTimeout(onSent, 500);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <section className="rounded-xl border border-line bg-panel" data-broker-publish>
      <SectionHead icon="upload" title="Send a test message" note="Check that a flow or device listening to a topic receives it." />
      <div className="grid gap-3 p-4 md:grid-cols-[1fr_2fr_auto_auto] md:items-end">
        <label className="text-xs text-muted">
          Topic
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="factory/line1/temperature" className={`${inputClass} mt-1`} />
        </label>
        <label className="text-xs text-muted">
          Message
          <input value={payload} onChange={(e) => setPayload(e.target.value)} placeholder='{"value": 21.5}' className={`${inputClass} mt-1 font-mono`} />
        </label>
        <label className="flex items-center gap-1.5 pb-2 text-xs text-soft" title="The broker keeps the message and gives it to anyone who starts listening later">
          <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} /> Keep as latest value
        </label>
        <button type="button" onClick={send} disabled={!topic.trim()} className={buttonClass.secondary}>
          <Icon name="upload" className="h-3.5 w-3.5" /> Send
        </button>
      </div>
      {msg && <p className={`px-4 pb-3 text-xs ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
    </section>
  );
}

function NewLogin({ onClose, onCreated }: { onClose: () => void; onCreated: (c: BrokerLogin & { password: string }) => void }) {
  const [username, setUsername] = useState("");
  const [label, setLabel] = useState("");
  const [topics, setTopics] = useState<{ pattern: string; access: TopicAccess }[]>([{ pattern: "devices/#", access: "readwrite" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      onCreated(await mqttBroker.createLogin({ username: username.trim(), label, topics: topics.filter((t) => t.pattern.trim()) }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New device login" icon="lock" onClose={onClose}>
      <form className="space-y-4 p-5 text-sm" onSubmit={(e) => (e.preventDefault(), void create())} data-broker-login-dialog>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-soft">Username</span>
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. line1-gateway" className={inputClass} />
          <span className="mt-1 block text-[11px] text-muted">One per device or app. Letters, digits, dots, dashes or underscores. A password is made for you and shown once.</span>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-soft">What is it? (optional)</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Gateway on production line 1" className={inputClass} />
        </label>
        <div>
          <span className="mb-1 block text-xs font-medium text-soft">Topics it may use</span>
          <div className="space-y-2">
            {topics.map((t, i) => (
              <div key={i}>
                <div className="flex gap-2">
                  <input
                    value={t.pattern}
                    onChange={(e) => setTopics(topics.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))}
                    placeholder="factory/line1/#"
                    className={`${inputClass} font-mono`}
                  />
                  <select value={t.access} onChange={(e) => setTopics(topics.map((x, j) => (j === i ? { ...x, access: e.target.value as TopicAccess } : x)))} className={`${inputClass} max-w-44`}>
                    {ACCESS.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.short}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => setTopics(topics.filter((_, j) => j !== i))} disabled={topics.length === 1} className={buttonClass.ghost} title="Remove">
                    <Icon name="x" className="h-3.5 w-3.5" />
                  </button>
                </div>
                {t.pattern.trim() && <p className="mt-0.5 text-[11px] text-muted">→ {patternText(t.pattern.trim())}</p>}
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setTopics([...topics, { pattern: "", access: "readwrite" }])} className={`${buttonClass.ghost} mt-1`}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Add topic
          </button>
          <p className="mt-1 text-[11px] text-muted">
            <code>#</code> at the end means “everything below” (<code>factory/#</code>); <code>+</code> means “any one level” (<code>factory/+/temperature</code>).
          </p>
        </div>
        {err && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</p>}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className={buttonClass.ghost}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !username.trim()} className={buttonClass.primary}>
            {busy ? "Creating…" : "Create login"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ShowPassword({ login, port, onClose }: { login: BrokerLogin & { password: string }; port: number; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title={`Login "${login.username}" is ready`} icon="lock" onClose={onClose}>
      <div className="space-y-4 p-5 text-sm" data-broker-password>
        <p className="text-warn">Copy the password now — for security it is not shown again. (Lost it? Delete the login and make a new one.)</p>
        <div className="space-y-1 rounded-md border border-line-2 bg-ink p-3 text-xs">
          <Row k="Server" v="localhost" />
          <Row k="Port" v={String(port)} />
          <Row k="Username" v={login.username} />
          <div className="flex items-center gap-2">
            <span className="w-20 text-muted">Password</span>
            <code className="min-w-0 flex-1 break-all text-strong">{login.password}</code>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(login.password).then(() => setCopied(true))} className={buttonClass.secondary}>
              <Icon name={copied ? "check" : "copy"} className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Try it from a terminal</summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-ink p-3 text-soft">
            {`mosquitto_sub -h localhost -p ${port} -u ${login.username} -P '<password>' -t '${login.topics[0]?.pattern ?? "#"}'`}
          </pre>
        </details>
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className={buttonClass.primary}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 text-muted">{k}</span>
      <code className="text-strong">{v}</code>
    </div>
  );
}
