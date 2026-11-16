"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon, type IconName } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { Field } from "@/components/pipeline/ui";
import { KeysEditor, NO_KEYS, SchemaEditor } from "@/components/streaming/parts";
import { StreamingSyncs } from "@/components/streaming/StreamingSyncs";
import { streaming, type IngestStream, type StreamColumn, type StreamKeys } from "@/lib/streaming";

type Tab = "guide" | "streams" | "syncs";

/** The streaming resource guide's steps, each linked to the app that covers it. */
const GUIDE: { step: string; text: string; links: { label: string; href?: string; tab?: Tab; icon: IconName }[] }[] = [
  {
    step: "1. Core concepts",
    text: "A stream holds records in order and is processed continuously by a streaming job (Flink: a job graph of operators; Job Managers schedule and checkpoint, Task Managers run tasks and keep state).",
    links: [{ label: "Ingest streams", tab: "streams", icon: "wave" }],
  },
  {
    step: "2. Overview",
    text: "Streaming suits data that must be acted on within seconds; batch suits periodic loads. Size jobs with streaming profiles only when throughput, record size or state require it; watch them with stream monitoring.",
    links: [
      { label: "Streaming profiles · Control Panel", href: "/control-panel", icon: "sliders" },
      { label: "Stream monitoring · Data Health", href: "/data-health", icon: "bell" },
    ],
  },
  {
    step: "3. Connect to data sources",
    text: "Set up a streaming sync (Kafka, Kinesis, SQS / SNS, Pub/Sub, AVEVA PI, MQTT for ActiveMQ / Solace / IBM MQ, RabbitMQ, IBM MQ) or push records into a stream through its stream proxy URL.",
    links: [
      { label: "Streaming syncs", tab: "syncs", icon: "plug" },
      { label: "Push-based ingestion", tab: "streams", icon: "upload" },
      { label: "Data Connection", href: "/sources", icon: "plug" },
    ],
  },
  {
    step: "4. Transform your streaming data",
    text: "Create a Streaming pipeline in Pipeline Builder with an ingest stream as input; outputs stay streaming datasets.",
    links: [{ label: "Pipeline Builder", href: "/pipeline", icon: "pipeline" }],
  },
  {
    step: "5. Monitor streaming pipelines [Beta]",
    text: "Alert when records ingested fall below a threshold, checkpoints stop or fail, lag grows, or utilization runs high. Output monitors watch what pipelines write into time series syncs (points written) and geotemporal series syncs (observations sent).",
    links: [
      { label: "Data Health · Monitoring Views", href: "/data-health", icon: "bell" },
      { label: "Time Series Catalog", href: "/time-series", icon: "wave" },
      { label: "Map", href: "/map", icon: "globe" },
    ],
  },
  {
    step: "6. Development tools",
    text: "Reset an ingest stream to clear its records and change its schema, throughput or configuration (not for production streams: records are lost).",
    links: [{ label: "Reset stream (stream → Details)", tab: "streams", icon: "restore" }],
  },
];

export default function StreamingApp() {
  const [tab, setTab] = useState<Tab>("streams");
  if (tab === "streams") return <Streams onTab={setTab} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-panel px-3 text-sm">
        <span className="mr-3 flex items-center gap-1.5 font-medium">
          <Icon name="wave" className="h-4 w-4 text-ocean" /> Streaming
        </span>
        {(
          [
            ["streams", "Ingest streams", "wave"],
            ["syncs", "Streaming syncs", "plug"],
            ["guide", "Resource guide", "doc"],
          ] as [Tab, string, IconName][]
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 ${tab === id ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:bg-panel-2 hover:text-white"}`}
          >
            <Icon name={icon} className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </nav>
      <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl p-8">
          {tab === "guide" && <Guide onTab={setTab} />}
          {tab === "syncs" && (
            <>
              <h1 className="mb-1 text-xl font-semibold">Streaming syncs</h1>
              <p className="mb-5 text-sm text-muted">Pull records from streaming platforms into ingest streams with low latency and high throughput.</p>
              <StreamingSyncs />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Guide({ onTab }: { onTab: (t: Tab) => void }) {
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Streaming resource guide</h1>
      <p className="mb-6 text-sm text-muted">What you need for an end-to-end streaming workflow, and where each part lives.</p>
      <div className="space-y-3">
        {GUIDE.map((g) => (
          <div key={g.step} className="rounded-xl border border-line bg-panel p-4">
            <div className="font-medium">{g.step}</div>
            <p className="mt-1 text-sm text-muted">{g.text}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {g.links.map((l) =>
                l.href ? (
                  <Link key={l.label} href={l.href} className={`${buttonClass.secondary} py-1 text-xs`}>
                    <Icon name={l.icon} className="h-3.5 w-3.5" /> {l.label}
                  </Link>
                ) : (
                  <button key={l.label} type="button" onClick={() => onTab(l.tab!)} className={`${buttonClass.secondary} py-1 text-xs`}>
                    <Icon name={l.icon} className="h-3.5 w-3.5" /> {l.label}
                  </button>
                ),
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Streams({ onTab }: { onTab: (t: Tab) => void }) {
  const [streams, setStreams] = useState<IngestStream[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const load = () => streaming.streams().then(setStreams, (e: Error) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <AppHome
        app="Streaming"
        icon="wave"
        accent="#0d9488"
        href="/streaming"
        tagline="Ingest streams: records in order, read by pipelines in real time."
        description={<>Streaming datasets written by streaming syncs or pushed to through the stream proxy. Pipelines read them in real time.</>}
        headerActions={
          <>
            <button type="button" onClick={() => onTab("syncs")} className={buttonClass.secondary}>
              <Icon name="plug" className="h-3.5 w-3.5" /> Streaming syncs
            </button>
            <button type="button" onClick={() => onTab("guide")} className={buttonClass.secondary}>
              <Icon name="doc" className="h-3.5 w-3.5" /> Resource guide
            </button>
          </>
        }
        noun={["stream", "streams"]}
        items={
          streams?.map((s) => ({
            id: s.id,
            href: `/streaming/streams/${s.id}`,
            title: s.name,
            updated_at: s.last_record_at ?? s.updated_at,
            detail: s.schema.length ? s.schema.map((c) => `${c.name}: ${c.type}`).join(", ") : "Schema from the records",
            badges: [
              { label: `${s.throughput} throughput`, tone: s.throughput === "high" ? ("warn" as const) : ("muted" as const) },
              ...(s.origin?.kind === "pipeline" ? [{ label: "pipeline output", tone: "ocean" as const }] : []),
            ],
            meta: `${s.records.toLocaleString()} records`,
          })) ?? null
        }
        stats={
          streams
            ? [
                { label: "Streams", value: streams.length.toLocaleString() },
                { label: "Records", value: streams.reduce((n, s) => n + s.records, 0).toLocaleString() },
                { label: "From pipelines", value: streams.filter((s) => s.origin?.kind === "pipeline").length.toLocaleString() },
              ]
            : undefined
        }
        error={error}
        empty={{
          title: "No ingest streams yet",
          hint: "Create one, or set up a streaming sync that writes into it.",
          steps: ["Create a stream with a schema", "Push records or add a streaming sync", "Read it from a streaming pipeline"],
        }}
        create={
          <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
            <Icon name="plus" /> New stream
          </button>
        }
      />
      {creating && <NewStreamDialog onClose={() => setCreating(false)} onCreated={() => (setCreating(false), load())} />}
    </>
  );
}

function NewStreamDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("Sensor readings");
  const [throughput, setThroughput] = useState("normal");
  const [schema, setSchema] = useState<StreamColumn[]>([
    { name: "sensor_id", type: "String" },
    { name: "value", type: "Double" },
  ]);
  const [keys, setKeys] = useState<StreamKeys>(NO_KEYS);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    try {
      await streaming.createStream({ name: name.trim(), schema, throughput, keys: { partition: keys.partition.filter((k) => schema.some((c) => c.name === k)), primary: keys.primary } });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="New ingest stream" icon="wave" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Throughput" hint="High uses more partitions for very high record rates.">
          <select value={throughput} onChange={(e) => setThroughput(e.target.value)} className={inputClass}>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </Field>
        <Field label="Schema" hint="Leave empty to take the columns from the records (as streaming syncs do).">
          <SchemaEditor value={schema} onChange={setSchema} />
        </Field>
        <Field label="Keys (optional)" hint="Partition keys keep records with the same key in order; CDC mode adds a primary key.">
          <KeysEditor columns={schema.map((c) => c.name).filter(Boolean)} value={keys} onChange={setKeys} />
        </Field>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!name.trim()} onClick={create} className={buttonClass.primary}>
            Create stream
          </button>
        </div>
      </div>
    </Modal>
  );
}
