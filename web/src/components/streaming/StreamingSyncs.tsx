"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { streaming, type IngestStream, type ProfileSettings, type StreamingSync, type SyncKind } from "@/lib/streaming";
import { auth, type Marking, type MarkingRef, type Organization } from "@/lib/auth";
import { when } from "@/lib/format";
import { confirmDialog } from "@/lib/dialogs";
import { useAuth } from "../AuthGate";
import { MarkingChip } from "../auth/parts";
import { Icon } from "../Icon";
import { buttonClass, inputClass, Modal } from "../pipeline/Modal";
import { Field } from "../pipeline/ui";
import { ProfilePicker } from "./ProfilePicker";

type FieldDef = { name: string; label: string; kind?: "text" | "password" | "textarea" | "number" | "select" | "bool"; options?: string[]; default?: string | number | boolean; placeholder?: string; help?: string; required?: boolean };

const FORMAT: FieldDef = { name: "value_format", label: "Value format", kind: "select", options: ["json", "text", "base64"], default: "json", help: "json: an object's fields become columns" };
const AWS_KEYS: FieldDef[] = [
  { name: "access_key_id", label: "Access key ID", help: "Empty: this server's AWS credentials" },
  { name: "secret_access_key", label: "Secret access key", kind: "password" },
  { name: "session_token", label: "Session token", kind: "password" },
  { name: "endpoint_url", label: "Endpoint URL", placeholder: "Only for a VPC endpoint or a local emulator" },
];

/** Source settings, from each platform's consumer documentation. */
export const SOURCES: Record<SyncKind, { label: string; note: string; fields: FieldDef[] }> = {
  kafka: {
    label: "Apache Kafka",
    note: "A consumer group reads the topic; offsets are committed after each checkpoint.",
    fields: [
      { name: "bootstrap_servers", label: "Bootstrap servers", placeholder: "broker1:9092,broker2:9092", required: true },
      { name: "topic", label: "Topic(s)", placeholder: "orders (comma-separated for several)", required: true },
      { name: "group_id", label: "Consumer group", default: "bluesandai-streaming" },
      { name: "start_from", label: "Start from", kind: "select", options: ["earliest", "latest"], default: "earliest" },
      { name: "security_protocol", label: "Security protocol", kind: "select", options: ["PLAINTEXT", "SSL", "SASL_PLAINTEXT", "SASL_SSL"], default: "PLAINTEXT" },
      { name: "sasl_mechanism", label: "SASL mechanism", kind: "select", options: ["", "PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"], default: "" },
      { name: "user", label: "SASL username" },
      { name: "password", label: "SASL password", kind: "password" },
      { name: "ca_pem", label: "CA certificate (PEM)", kind: "textarea" },
      FORMAT,
    ],
  },
  kinesis: {
    label: "Amazon Kinesis",
    note: "Reads every shard; the shard sequence numbers are the checkpoint.",
    fields: [
      { name: "region", label: "Region", placeholder: "us-east-1", required: true },
      { name: "stream_name", label: "Stream name", required: true },
      { name: "start_from", label: "Start from", kind: "select", options: ["earliest", "latest"], default: "earliest", help: "TRIM_HORIZON or LATEST for the first run" },
      ...AWS_KEYS,
      FORMAT,
    ],
  },
  sqs: {
    label: "Amazon SQS / SNS",
    note: "Long-polls the queue; messages are deleted after the checkpoint. For Amazon SNS, subscribe an SQS queue to the topic: notifications are unwrapped.",
    fields: [{ name: "region", label: "Region", placeholder: "us-east-1", required: true }, { name: "queue_url", label: "Queue URL", placeholder: "https://sqs.us-east-1.amazonaws.com/123456789012/events", required: true }, ...AWS_KEYS, FORMAT],
  },
  pubsub: {
    label: "Google Pub/Sub",
    note: "Pulls the subscription with a service account (roles/pubsub.subscriber); messages are acknowledged after the checkpoint.",
    fields: [
      { name: "project_id", label: "Project ID", required: true },
      { name: "subscription", label: "Subscription", required: true },
      { name: "service_account", label: "Service account key (JSON)", kind: "textarea", required: true },
      FORMAT,
    ],
  },
  pi: {
    label: "AVEVA PI",
    note: "PI Web API: recorded values of the points since the last checkpoint, polled.",
    fields: [
      { name: "url", label: "PI Web API URL", placeholder: "https://piserver/piwebapi", required: true },
      { name: "points", label: "PI points", kind: "textarea", placeholder: "\\\\PISERVER\\SINUSOID\n\\\\PISERVER\\CDT158", required: true, help: "One point path per line" },
      { name: "user", label: "Username" },
      { name: "password", label: "Password", kind: "password" },
      { name: "start_time", label: "First run from", default: "*-1h", help: "PI time syntax" },
      { name: "poll_seconds", label: "Poll every (s)", kind: "number", default: 5 },
    ],
  },
  mqtt: {
    label: "MQTT (ActiveMQ, Solace, IBM MQ, RabbitMQ)",
    note: "Subscribes with a persistent session; QoS 1/2 messages are acknowledged after the checkpoint. ActiveMQ, Solace, IBM MQ (MQTT channel) and RabbitMQ (MQTT plugin) all accept MQTT. The platform's own broker (MQTT Broker app): host localhost, port 1883 and a login made there.",
    fields: [
      { name: "host", label: "Broker host", required: true },
      { name: "port", label: "Port", kind: "number", default: 1883 },
      { name: "topics", label: "Topics", placeholder: "plant/+/temperature, plant/#", required: true },
      { name: "qos", label: "QoS", kind: "select", options: ["0", "1", "2"], default: "1" },
      { name: "client_id", label: "Client ID", default: "bluesandai-streaming" },
      { name: "user", label: "Username" },
      { name: "password", label: "Password", kind: "password" },
      { name: "tls", label: "TLS", kind: "bool", default: false },
      FORMAT,
    ],
  },
  rabbitmq: {
    label: "RabbitMQ (AMQP)",
    note: "Reads a queue over AMQP 0-9-1; deliveries are acknowledged after the checkpoint.",
    fields: [
      { name: "url", label: "AMQP URL", placeholder: "amqps://rabbit.example.com:5671/%2F", required: true },
      { name: "queue", label: "Queue", required: true },
      { name: "user", label: "Username" },
      { name: "password", label: "Password", kind: "password" },
      FORMAT,
    ],
  },
  ibmmq: {
    label: "IBM MQ",
    note: "Gets messages under syncpoint and commits after the checkpoint (needs pymqi and the IBM MQ client on the server).",
    fields: [
      { name: "host", label: "Host", required: true },
      { name: "port", label: "Port", kind: "number", default: 1414 },
      { name: "queue_manager", label: "Queue manager", required: true },
      { name: "channel", label: "Channel", default: "DEV.APP.SVRCONN" },
      { name: "queue", label: "Queue", required: true },
      { name: "user", label: "Username" },
      { name: "password", label: "Password", kind: "password" },
      FORMAT,
    ],
  },
};

export const STATUS_CLASS: Record<string, string> = {
  running: "text-ok",
  starting: "text-ocean",
  retrying: "text-warn",
  failed: "text-bad",
  stopped: "text-muted",
};

/**
 * Markings for a new sync (and its stream), as the item markings panel offers them: only markings the user holds and
 * may apply (a marking's Apply permission; an organization's members, those given Apply and administrators) — the
 * sync's job runs as its creator, who must hold them. Hidden with sign-in off (markings are not enforced).
 */
export function SyncMarkingsField({ value, onChange, streamId }: { value: string[]; onChange: (ids: string[]) => void; streamId?: string }) {
  const { me, enabled } = useAuth();
  const [markings, setMarkings] = useState<Marking[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [onStream, setOnStream] = useState<{ id: string; markings: MarkingRef[] } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    auth.markings().then(setMarkings, () => {});
    auth.organizations().then(setOrgs, () => {});
  }, [enabled]);
  // an existing target stream: the markings it already carries (its own, its syncs', those recorded with its records)
  useEffect(() => {
    if (!enabled || !streamId) return;
    let live = true;
    auth.itemMarkings(`stream:${streamId}`).then((m) => live && setOnStream({ id: streamId, markings: m.effective }), () => live && setOnStream(null));
    return () => {
      live = false;
    };
  }, [enabled, streamId]);
  const current = streamId && onStream?.id === streamId ? onStream.markings : [];
  if (!enabled) return null;
  const held = new Set((me?.markings ?? []).map((m) => m.id));
  const keys = new Set([`user:${me?.id}`, ...(me?.groups ?? []).map((g) => `group:${g.id}`)]);
  const admin = me?.role === "admin" && !me?.emulation;
  const all: MarkingRef[] = [
    ...markings.filter((m) => held.has(m.id) && m.permissions?.apply !== false).map((m) => ({ id: m.id, name: m.name, color: m.color, kind: "marking" as const })),
    ...orgs
      .filter((o) => held.has(o.marking) && (admin || me?.organization_id === o.id || [...(o.apply ?? []), ...(o.expand_access ?? [])].some((k) => keys.has(k))))
      .map((o) => ({ id: o.marking, name: `${o.name} (organization)`, color: o.color, kind: "organization" as const })),
  ];
  const chosen = value.map((id) => all.find((c) => c.id === id) ?? { id, name: id });
  const choices = all.filter((c) => !value.includes(c.id));
  return (
    <Field label="Markings" hint="Only people holding every marking can see the sync, its stream and the records it writes. You can apply markings you hold and may apply.">
      {current.length > 0 && (
        <div className="mb-1 flex flex-wrap items-center gap-1 text-xs" data-stream-markings>
          <span className="text-muted">The stream already carries</span>
          {current.map((m) => (
            <MarkingChip key={m.id} m={m} title="Already on the stream: everyone reading it needs this marking" />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1 text-xs" data-sync-markings>
        {chosen.map((m) => (
          <MarkingChip key={m.id} m={m} title="Applied to the sync and its stream" onRemove={() => onChange(value.filter((x) => x !== m.id))} />
        ))}
        {chosen.length === 0 && (
          <span className="text-muted">{current.length ? "No more markings." : "None: everyone who can see the stream sees its records."}</span>
        )}
        {choices.length > 0 ? (
          <select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} className="rounded border border-line-2 bg-ink px-1 py-0.5" data-sync-marking-select>
            <option value="">+ Apply marking…</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          chosen.length === 0 && <span className="text-muted">(no marking you may apply)</span>
        )}
      </div>
    </Field>
  );
}

/** Set up a streaming sync: source, target stream, streaming profile. */
export function NewSyncDialog({ onClose, onCreated, streamId }: { onClose: () => void; onCreated: (s: StreamingSync) => void; streamId?: string }) {
  const [kind, setKind] = useState<SyncKind>("kafka");
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [streams, setStreams] = useState<IngestStream[]>([]);
  const [target, setTarget] = useState<string>(streamId ?? "");
  const [newStream, setNewStream] = useState("");
  const [profiles, setProfiles] = useState<string[]>(["default"]);
  const [advanced, setAdvanced] = useState<Partial<ProfileSettings>>({});
  const [markings, setMarkings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    streaming.streams().then(setStreams, () => {});
  }, []);
  const src = SOURCES[kind];
  const val = (f: FieldDef) => (values[f.name] !== undefined ? values[f.name] : (f.default ?? ""));
  const missing = src.fields.filter((f) => f.required && !String(val(f) ?? "").trim()).map((f) => f.label);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const config = Object.fromEntries(src.fields.map((f) => [f.name, f.kind === "number" ? Number(val(f)) || undefined : val(f)]).filter(([, v]) => v !== "" && v !== undefined));
      onCreated(
        await streaming.createSync({
          name: name.trim() || `${src.label} sync`,
          kind,
          config,
          stream_id: target || null,
          new_stream_name: target ? null : newStream.trim() || name.trim() || `${src.label} stream`,
          profiles,
          advanced,
          start: true,
          ...(markings.length ? { markings } : {}),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Set up a streaming sync" icon="wave" onClose={onClose} wide>
      <div className="max-h-[78vh] space-y-4 overflow-y-auto p-5 text-sm">
        <Field label="Source">
          <div className="grid gap-1.5 sm:grid-cols-4">
            {(Object.keys(SOURCES) as SyncKind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => (setKind(k), setValues({}))}
                className={`rounded-md border px-2 py-1.5 text-left text-xs ${kind === k ? "border-ocean/60 bg-ocean/10 text-white" : "border-line-2 text-soft hover:border-ocean/40"}`}
              >
                {SOURCES[k].label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">{src.note}</p>
        </Field>
        <Field label="Sync name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${src.label} sync`} className={inputClass} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          {src.fields.map((f) => (
            <label key={f.name} className={`block ${f.kind === "textarea" ? "sm:col-span-2" : ""}`}>
              <span className="mb-1 block text-xs font-medium text-soft">
                {f.label} {!f.required && f.kind !== "bool" && <span className="font-normal text-muted">(optional)</span>}
              </span>
              {f.kind === "select" ? (
                <select value={String(val(f))} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} className={inputClass}>
                  {f.options!.map((o) => (
                    <option key={o} value={o}>
                      {o || "None"}
                    </option>
                  ))}
                </select>
              ) : f.kind === "textarea" ? (
                <textarea rows={3} value={String(val(f))} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} placeholder={f.placeholder} spellCheck={false} className={`${inputClass} font-mono text-xs`} />
              ) : f.kind === "bool" ? (
                <input type="checkbox" checked={!!val(f)} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} className="accent-[var(--color-ocean)]" />
              ) : (
                <input
                  type={f.kind === "password" ? "password" : f.kind === "number" ? "number" : "text"}
                  autoComplete="off"
                  value={String(val(f))}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                  placeholder={f.placeholder}
                  className={inputClass}
                />
              )}
              {f.help && <span className="mt-0.5 block text-xs text-muted">{f.help}</span>}
            </label>
          ))}
        </div>
        <Field label="Ingest stream" hint="The streaming dataset the records are written to.">
          <div className="flex flex-wrap gap-2">
            <select value={target} onChange={(e) => setTarget(e.target.value)} className={`${inputClass} sm:w-72`}>
              <option value="">New ingest stream…</option>
              {streams.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {!target && <input value={newStream} onChange={(e) => setNewStream(e.target.value)} placeholder="New stream name" className={`${inputClass} sm:w-64`} />}
          </div>
        </Field>
        <Field label="Streaming profiles" hint="Usually the default is enough; add profiles for very high throughput, very large records or very large state.">
          <ProfilePicker value={profiles} advanced={advanced} onChange={(p, a) => (setProfiles(p), setAdvanced(a))} />
        </Field>
        <SyncMarkingsField value={markings} onChange={setMarkings} streamId={target || undefined} />
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex items-center justify-end gap-3">
          {missing.length > 0 && <span className="text-xs text-muted">Fill in {missing.join(", ")}.</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={busy || missing.length > 0} onClick={create} className={buttonClass.primary}>
            <Icon name={busy ? "refresh" : "play"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Starting…" : "Create and start"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Streaming syncs: status, throughput, lag and checkpoints of every sync job. */
export function StreamingSyncs({ streamId }: { streamId?: string }) {
  const [syncs, setSyncs] = useState<StreamingSync[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const load = () => streaming.syncs().then((s) => (setSyncs(streamId ? s.filter((x) => x.stream_id === streamId) : s), setError(null)), (e: Error) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamId]);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted">Each sync is a streaming job: it pulls records into an ingest stream and checkpoints its position after writing them.</p>
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" /> New streaming sync
        </button>
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
      {!syncs ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : syncs.length === 0 ? (
        <p className="rounded-xl border-2 border-dashed border-line-2 py-10 text-center text-sm text-muted">No streaming syncs yet: connect Kafka, Kinesis, SQS, Pub/Sub, PI, MQTT, RabbitMQ or IBM MQ.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Sync</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Records (5 min)</th>
                <th className="px-3 py-2 font-medium">Lag</th>
                <th className="px-3 py-2 font-medium">Last checkpoint</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {syncs.map((s) => (
                <tr key={s.id} className="border-t border-line">
                  <td className="px-3 py-2">
                    <Link href={`/streaming/syncs/${s.id}`} className="font-medium hover:text-ocean">
                      {s.name}
                    </Link>
                    <div className="text-xs text-muted">{SOURCES[s.kind]?.label ?? s.kind}</div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span className={STATUS_CLASS[s.status] ?? "text-muted"}>● {s.status}</span>
                    {s.error && <div className="max-w-xs truncate text-bad" title={s.error}>{s.error}</div>}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{s.records_5m.toLocaleString()}</td>
                  <td className="px-3 py-2 tabular-nums">{s.lag ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted">{s.last_checkpoint_at ? `${when(s.last_checkpoint_at)} · ${s.last_checkpoint_ms} ms` : "—"}</td>
                  <td className="px-3 py-2 text-right">
                    {s.desired === "running" ? (
                      <button type="button" onClick={() => act(() => streaming.stopSync(s.id))} className="rounded p-1 text-muted hover:text-white" title="Stop">
                        <Icon name="pause" className="h-4 w-4" />
                      </button>
                    ) : (
                      <button type="button" onClick={() => act(() => streaming.startSync(s.id))} className="rounded p-1 text-muted hover:text-white" title="Start">
                        <Icon name="play" className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={async () => (await confirmDialog(`Delete the streaming sync "${s.name}"? Its stream stays.`)) && act(() => streaming.deleteSync(s.id))}
                      className="rounded p-1 text-muted hover:text-bad"
                      title="Delete"
                    >
                      <Icon name="trash" className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <NewSyncDialog
          streamId={streamId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </div>
  );
}

/** Per-minute bars of a metric. */
export function Bars({ points, label, unit = "" }: { points: { minute: string; value: number | null }[]; label: string; unit?: string }) {
  const max = Math.max(1, ...points.map((p) => p.value ?? 0));
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span>
          max {max.toLocaleString()}
          {unit}
        </span>
      </div>
      <div className="flex h-16 items-end gap-px rounded-md border border-line bg-ink p-1">
        {points.length === 0 && <span className="m-auto text-[11px] text-muted">No data yet</span>}
        {points.map((p) => (
          <span
            key={p.minute}
            title={`${p.minute.replace("T", " ")} · ${p.value ?? "—"}${unit}`}
            className="min-w-[2px] flex-1 rounded-sm bg-ocean/70"
            style={{ height: `${Math.max(2, ((p.value ?? 0) / max) * 100)}%` }}
          />
        ))}
      </div>
    </div>
  );
}
