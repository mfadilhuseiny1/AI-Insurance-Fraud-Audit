"use client";

import { useState } from "react";
import { api, type DataSource, type DbConnection } from "@/lib/api";
import { sapTools, type DatasetRef } from "@/lib/dataConnection";
import { DrivePicker } from "../DrivePicker";
import { Icon } from "../Icon";
import { buttonClass, fieldClass, inputClass } from "../pipeline/Modal";
import { useLoad } from "./DataSourceWizard";

export const SAP_KINDS = ["sap-erp", "sap-slt", "sap-custom-source"];

type Panel = "resources" | "call" | "bulk" | "dms";

/** Palantir SAP add-on tools on an SAP connection (Connections tab). */
export function SapTools({ connection }: { connection: DbConnection }) {
  const [open, setOpen] = useState<Panel | null>(null);
  if (!connection.config.use_addon) {
    return (
      <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
        Turn on &quot;Palantir SAP add-on&quot; in this connection to call BAPIs, write back to SAP and copy DMS documents.
      </p>
    );
  }
  const tab = (id: Panel, icon: Parameters<typeof Icon>[0]["name"], label: string) => (
    <button type="button" onClick={() => setOpen(open === id ? null : id)} className={`${buttonClass.secondary} py-1 text-xs ${open === id ? "border-ocean/60" : ""}`}>
      <Icon name={icon} className="h-3.5 w-3.5" /> {label}
    </button>
  );
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap gap-2">
        {tab("resources", "gauge", "Resource check")}
        {tab("call", "bolt", "Call a BAPI")}
        {tab("bulk", "table", "BAPI per dataset row")}
        {tab("dms", "image", "DMS documents")}
      </div>
      {open === "resources" && <Resources connection={connection} />}
      {open === "call" && <CallFunction connection={connection} />}
      {open === "bulk" && <BulkCall connection={connection} />}
      {open === "dms" && <DmsSync connection={connection} />}
    </div>
  );
}

function Messages({ counts }: { counts: Record<string, number> }) {
  const label: Record<string, string> = { S: "success", I: "info", W: "warning", E: "error", A: "abort" };
  const entries = Object.entries(counts);
  if (!entries.length) return <span className="text-muted">no RETURN messages</span>;
  return (
    <span className="flex flex-wrap gap-2">
      {entries.map(([t, n]) => (
        <span key={t} className={t === "E" || t === "A" ? "text-bad" : t === "W" ? "text-warn" : "text-ok"}>
          {n} {label[t] ?? t}
        </span>
      ))}
    </span>
  );
}

function Resources({ connection }: { connection: DbConnection }) {
  const res = useLoad(`sap-res:${connection.id}`, () => sapTools.resources(connection.id));
  return (
    <div className="mt-3 text-xs">
      {res.loading && <p className="text-muted">Checking CPU, memory and work processes on the SAP system…</p>}
      {res.error && <p className="text-bad">{res.error}</p>}
      {res.data && (
        <ul className="space-y-1">
          {res.data.map((r, i) => (
            <li key={i} className="flex gap-2">
              <span className={r.type === "S" ? "text-ok" : r.type === "W" ? "text-warn" : "text-bad"}>{r.type}</span>
              <span className="text-soft">{r.message}</span>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={res.retry} className="mt-2 text-ocean hover:underline">
        Check again
      </button>
    </div>
  );
}

function parseJson(text: string): Record<string, unknown> {
  const v = JSON.parse(text || "{}");
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("The input must be a JSON object");
  return v as Record<string, unknown>;
}

function CallFunction({ connection }: { connection: DbConnection }) {
  const [fn, setFn] = useState("BAPI_COMPANYCODE_GETLIST");
  const [input, setInput] = useState("{}");
  const [output, setOutput] = useState("RETURN");
  const [commit, setCommit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<string | null>(null);
  const [result, setResult] = useState<{ messages: Record<string, number>; json: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadMeta = async () => {
    setError(null);
    try {
      setMeta(JSON.stringify(await sapTools.metadata(connection.id, fn.trim()), null, 2));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await sapTools.call(connection.id, fn.trim(), {
        input: parseJson(input),
        output: output.split(/[,\s]+/).filter(Boolean),
        commit,
      });
      setResult({ messages: r.messages, json: JSON.stringify(r.result, null, 2) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 text-xs">
      <p className="text-muted">
        Calls a function module through the add-on (<code>/v2/function/…/writeback</code>). Turn on commit for BAPIs that change data; this needs &quot;Enable
        exports to this source&quot;.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-soft">Function module</span>
          <input value={fn} onChange={(e) => setFn(e.target.value.toUpperCase())} className={`${inputClass} font-mono`} />
        </label>
        <label className="block">
          <span className="mb-1 block text-soft">Output tables / structures</span>
          <input value={output} onChange={(e) => setOutput(e.target.value)} className={`${inputClass} font-mono`} placeholder="RETURN, COMPANYCODE_LIST" />
        </label>
        <label className="flex items-end gap-2 pb-2 text-soft">
          <input type="checkbox" checked={commit} onChange={(e) => setCommit(e.target.checked)} className="accent-[var(--color-ocean)]" /> Commit (COMMIT WORK)
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-soft">Input (JSON: the IMPORTING / TABLES parameters)</span>
        <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={5} spellCheck={false} className={`${inputClass} font-mono text-xs`} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={loadMeta} className={`${buttonClass.secondary} py-1 text-xs`}>
          <Icon name="info" className="h-3.5 w-3.5" /> Show inputs and outputs
        </button>
        <button type="button" onClick={run} disabled={busy || !fn.trim()} className={buttonClass.primary}>
          <Icon name={busy ? "refresh" : "play"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Calling…" : "Call"}
        </button>
      </div>
      {error && <p className="text-bad">{error}</p>}
      {meta && <pre className="max-h-48 overflow-auto rounded-md border border-line bg-ink p-2 font-mono text-[11px] text-soft">{meta}</pre>}
      {result && (
        <div className="space-y-1">
          <Messages counts={result.messages} />
          <pre className="max-h-64 overflow-auto rounded-md border border-line bg-ink p-2 font-mono text-[11px] text-soft">{result.json}</pre>
        </div>
      )}
    </div>
  );
}

function BulkCall({ connection }: { connection: DbConnection }) {
  const sources = useLoad("sources-for-sap-bulk", () => api.dataSources.sources());
  const [fn, setFn] = useState("BAPI_SALESORDER_CHANGE");
  const [dataset, setDataset] = useState<(DatasetRef & { label: string }) | null>(null);
  const [picking, setPicking] = useState(false);
  const [template, setTemplate] = useState(
    JSON.stringify({ SALESDOCUMENT: "{{sales_doc_id}}", ORDER_HEADER_IN: { PURCH_DATE: "{{purchase_date}}" }, ORDER_HEADER_INX: { UPDATEFLAG: "U", PURCH_DATE: "X" } }, null, 2),
  );
  const [commit, setCommit] = useState(true);
  const [jobs, setJobs] = useState(5);
  const [perJob, setPerJob] = useState(10);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!dataset) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setCounts(null);
    try {
      const ref: DatasetRef = dataset.kind === "source" ? { kind: "source", id: dataset.id } : { kind: dataset.kind, item_id: dataset.item_id };
      const r = await sapTools.bulk(connection.id, fn.trim(), { dataset: ref, template: parseJson(template), output: ["RETURN"], commit, parallel: true, jobs, per_job: perJob });
      setCounts(r.messages);
      setResult(
        `${r.calls.toLocaleString()} of ${r.rows.toLocaleString()} rows called ${r.function}${r.errors.length ? `; ${r.errors.length} request${r.errors.length === 1 ? "" : "s"} failed: ${r.errors[0].error}` : ""}.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 text-xs">
      <p className="text-muted">
        Calls the function once per dataset row through <code>parallel_writeback</code>; SAP spreads the calls over background jobs. Use {"{{column}}"} in
        the input to take a row&apos;s value.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setPicking(true)} className={`${buttonClass.secondary} py-1 text-xs`}>
          <Icon name="folder" className="h-3.5 w-3.5" /> Choose in Files…
        </button>
        <select
          value={dataset?.kind === "source" ? dataset.id : ""}
          onChange={(e) => {
            const s = sources.data?.find((x: DataSource) => x.id === e.target.value);
            if (s) setDataset({ kind: "source", id: s.id, label: s.name });
          }}
          className={`${fieldClass} w-56`}
        >
          <option value="">…or a data source</option>
          {(sources.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {dataset && <span className="rounded-md bg-ocean/10 px-2 py-1 text-white">{dataset.label}</span>}
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-soft">Function module</span>
          <input value={fn} onChange={(e) => setFn(e.target.value.toUpperCase())} className={`${inputClass} font-mono`} />
        </label>
        <label className="block">
          <span className="mb-1 block text-soft">Parallel jobs</span>
          <input type="number" min={1} max={50} value={jobs} onChange={(e) => setJobs(Number(e.target.value) || 1)} className={inputClass} />
        </label>
        <label className="block">
          <span className="mb-1 block text-soft">Calls per job</span>
          <input type="number" min={1} value={perJob} onChange={(e) => setPerJob(Number(e.target.value) || 1)} className={inputClass} />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-soft">Input template (JSON)</span>
        <textarea value={template} onChange={(e) => setTemplate(e.target.value)} rows={6} spellCheck={false} className={`${inputClass} font-mono text-xs`} />
      </label>
      <label className="flex items-center gap-2 text-soft">
        <input type="checkbox" checked={commit} onChange={(e) => setCommit(e.target.checked)} className="accent-[var(--color-ocean)]" /> Commit after each call
      </label>
      <button type="button" onClick={run} disabled={busy || !dataset || !fn.trim()} className={buttonClass.primary}>
        <Icon name={busy ? "refresh" : "play"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Writing back…" : "Write back"}
      </button>
      {!connection.exports_enabled && <p className="text-warn">Write-back is not enabled for this connection (turn on exports above).</p>}
      {error && <p className="text-bad">{error}</p>}
      {result && <p className="text-soft">{result}</p>}
      {counts && <Messages counts={counts} />}
      {picking && (
        <DrivePicker
          title="Choose the dataset with one row per call"
          canPick={(i) => (i.kind === "file" && /\.(parquet|view)$/i.test(i.name) ? null : "Choose a Parquet dataset or a View")}
          onPick={(i) => {
            setDataset(/\.view$/i.test(i.name) ? { kind: "view", item_id: i.id, label: i.name } : { kind: "file", item_id: i.id, label: i.name });
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function DmsSync({ connection }: { connection: DbConnection }) {
  const [docType, setDocType] = useState("");
  const [format, setFormat] = useState("pdf");
  const [match, setMatch] = useState("\\.pdf$");
  const [maxBytes, setMaxBytes] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await sapTools.dmsSync(connection.id, {
        documenttype: docType.trim(),
        fileformat: format.trim(),
        path_matches: match,
        max_bytes: maxBytes ? Number(maxBytes) : null,
        exclude_synced: true,
      });
      setResult(
        `Copied ${r.copied} document${r.copied === 1 ? "" : "s"} into Files (My Project / Data Source / Media / ${connection.name} / DMS)${r.failed ? `, ${r.failed} failed` : ""}${r.skipped ? `, ${r.skipped} over the size limit` : ""}${r.remaining ? `; ${r.remaining} more on the next run` : ""}.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 text-xs">
      <p className="text-muted">Copies documents from SAP&apos;s Document Management System into Files, like Foundry&apos;s SAP media set syncs. Already copied documents are skipped.</p>
      <div className="grid gap-2 sm:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-soft">Document type</span>
          <input value={docType} onChange={(e) => setDocType(e.target.value.toUpperCase())} className={inputClass} placeholder="CPT (all when empty)" />
        </label>
        <label className="block">
          <span className="mb-1 block text-soft">File format</span>
          <input value={format} onChange={(e) => setFormat(e.target.value)} className={inputClass} placeholder="pdf" />
        </label>
        <label className="block">
          <span className="mb-1 block text-soft">Path matches (regex)</span>
          <input value={match} onChange={(e) => setMatch(e.target.value)} className={`${inputClass} font-mono`} />
        </label>
        <label className="block">
          <span className="mb-1 block text-soft">File size limit (bytes)</span>
          <input value={maxBytes} onChange={(e) => setMaxBytes(e.target.value.replace(/\D/g, ""))} className={inputClass} placeholder="none" />
        </label>
      </div>
      <button type="button" onClick={run} disabled={busy} className={buttonClass.primary}>
        <Icon name={busy ? "refresh" : "play"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Syncing…" : "Sync documents"}
      </button>
      {error && <p className="text-bad">{error}</p>}
      {result && <p className="text-ok">{result}</p>}
    </div>
  );
}
