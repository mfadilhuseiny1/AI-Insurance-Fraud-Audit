"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { SpanWaterfall } from "@/components/models/SpanWaterfall";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { API_URL } from "@/lib/api";
import { when } from "@/lib/format";
import type { TelemetrySpan } from "@/lib/modelDeployments";

/** Model telemetry beyond a single run (api/model_telemetry.py): the calls a transform made to this model (each
 *  linked to its build), and — for administrators — where model spans are exported (OTLP/HTTP JSON). */

export type TransformTrace = { at: string; run: string; transform: string; mode: string; repo: string; input: string; version: string; ok: boolean;
  ms: number | null; trace_id: string; spans: TelemetrySpan[] };
export type ExportStatus = {
  enabled: boolean; endpoint: string | null; source: "setting" | "environment" | null; problem: string | null; header_names: string[]; queued: number;
  exported?: number; failed?: number; dropped?: number; retries?: number; last_error?: string | null; last_success_at?: number | null;
  setting: { enabled: boolean; endpoint: string | null; header_names: string[]; updated_at: string; updated_by: string | null } | null; env_endpoint: string | null;
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/model-assets" + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const d = (await res.json()).detail;
      message = typeof d === "string" ? d : JSON.stringify(d);
    } catch {}
    throw Object.assign(new Error(message), { status: res.status });
  }
  return res.json() as Promise<T>;
}

export const modelTelemetry = {
  transformTraces: (modelId: string, limit = 50) => req<TransformTrace[]>(`/${modelId}/traces?limit=${limit}`),
  exportStatus: () => req<ExportStatus>("/telemetry/export"),
  saveExport: (body: { enabled?: boolean; endpoint?: string; headers?: Record<string, string | null>; clear?: boolean }) =>
    req<ExportStatus>("/telemetry/export", { method: "PUT", json: body }),
  testExport: () => req<{ ok: boolean; endpoint: string; trace_id: string; error: string | null }>("/telemetry/export/test", { method: "POST" }),
};

/** The model's calls in transforms (pipelines in Code Repositories), newest first, each with its spans. */
export function TransformCalls({ modelId }: { modelId: string }) {
  const [rows, setRows] = useState<TransformTrace[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    modelTelemetry.transformTraces(modelId).then(setRows, (e: Error) => setErr(e.message));
  }, [modelId]);
  useEffect(load, [load]);
  if (err) return <p className="text-xs text-bad">{err}</p>;
  if (!rows) return <p className="text-xs text-muted">Loading…</p>;
  if (!rows.length) return <p className="text-xs text-muted">No transform has called this model yet. Builds that use it through a ModelInput record each call here.</p>;
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <details key={`${r.trace_id}-${r.at}`} className="rounded border border-line text-xs">
          <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 px-2 py-1.5 hover:bg-panel-2">
            <span className={r.ok ? "text-ok" : "text-bad"}>{r.ok ? "ok" : "failed"}</span>
            <span className="truncate font-mono text-soft" title={r.transform}>{r.transform.split("::").pop() || "transform"}</span>
            <span className="text-muted">{r.mode || "build"} {r.run}</span>
            <span className="text-muted">· {r.version}{r.ms != null ? ` · ${r.ms} ms` : ""}</span>
            <span className="ml-auto text-muted">{when(r.at)}</span>
          </summary>
          <div className="space-y-2 border-t border-line p-2">
            <div className="break-all font-mono text-[11px] text-muted">{r.transform}{r.input ? ` · input ${r.input}` : ""} · trace {r.trace_id}</div>
            {r.repo && <Link href={`/code-repositories/${r.repo}`} className="text-ocean hover:underline">Open the repository</Link>}
            <SpanWaterfall spans={r.spans} />
          </div>
        </details>
      ))}
      <button type="button" className={buttonClass.ghost} onClick={load}>Refresh</button>
    </div>
  );
}

/** Administrators: the OpenTelemetry collector model spans go to (off unless set here or by OTEL_EXPORTER_OTLP_* variables). */
export function TelemetryExportSetting() {
  const [st, setSt] = useState<ExportStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [headers, setHeaders] = useState<{ name: string; value: string }[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const apply = (s: ExportStatus) => {
    setSt(s);
    setEndpoint(s.setting?.endpoint ?? "");
    setHeaders([]);
  };
  useEffect(() => {
    modelTelemetry.exportStatus().then(apply, (e: Error & { status?: number }) => (e.status === 403 || e.status === 401 ? setHidden(true) : setErr(e.message)));
  }, []);
  if (hidden) return <p className="text-muted">Only administrators can see and change where model spans are exported.</p>;
  if (!st) return err ? <p className="text-xs text-bad">{err}</p> : null;
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await f();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = (enabled: boolean) => run(async () => {
    const h: Record<string, string> = {};
    for (const x of headers) if (x.name.trim()) h[x.name.trim()] = x.value;
    apply(await modelTelemetry.saveExport({ enabled, endpoint: endpoint.trim(), ...(Object.keys(h).length ? { headers: h } : {}) }));
    setMsg(enabled ? "Saved: spans are exported." : "Saved: export off.");
  });
  return (
    <div className="space-y-2 text-xs">
      <div className="text-soft">
        {st.enabled ? <>Exporting to <code className="text-white">{st.endpoint}</code> ({st.source === "environment" ? "OTEL_EXPORTER_OTLP_* variables" : "this setting"})</> : "Off: model spans stay on the platform."}
        {st.problem && <div className="text-bad">{st.problem}</div>}
      </div>
      {st.enabled && (
        <div className="text-muted">
          {st.exported ?? 0} exported · {st.failed ?? 0} failed · {st.dropped ?? 0} dropped · {st.queued} queued
          {st.last_error && <div className="break-all text-bad">Last error: {st.last_error}</div>}
        </div>
      )}
      <label className="block">
        <span className="text-muted">OTLP/HTTP traces endpoint (JSON)</span>
        <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="http://collector:4318/v1/traces" className={`${inputClass} mt-1 font-mono text-xs`} />
      </label>
      <div>
        <div className="text-muted">Headers {st.setting?.header_names.length ? `(stored: ${st.setting.header_names.join(", ")}; values are kept encrypted)` : ""}</div>
        {headers.map((h, i) => (
          <div key={i} className="mt-1 flex gap-1">
            <input value={h.name} placeholder="name" onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${inputClass} w-1/3 text-xs`} />
            <input value={h.value} placeholder="value" type="password" onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className={`${inputClass} text-xs`} />
          </div>
        ))}
        <button type="button" className={`${buttonClass.ghost} mt-1 text-xs`} onClick={() => setHeaders([...headers, { name: "", value: "" }])}>Add header</button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={busy} className={buttonClass.primary} onClick={() => save(true)}>Save and export</button>
        {st.setting?.enabled && <button type="button" disabled={busy} className={buttonClass.secondary} onClick={() => save(false)}>Turn off</button>}
        {st.endpoint && (
          <button type="button" disabled={busy} className={buttonClass.secondary}
            onClick={() => run(async () => {
              const r = await modelTelemetry.testExport();
              if (r.ok) setMsg(`A test span reached the collector (trace ${r.trace_id}).`);
              else setErr(`The test span was not accepted: ${r.error ?? "no answer"}`);
            })}>Send a test span</button>
        )}
      </div>
      {msg && <p className="text-ok">{msg}</p>}
      {err && <p className="break-all text-bad">{err}</p>}
    </div>
  );
}

/** The page's telemetry card body: transform calls, then the export setting (shown to administrators only). */
export function ModelTelemetry({ modelId }: { modelId: string }) {
  return (
    <div className="space-y-3">
      <TransformCalls modelId={modelId} />
      <details className="text-xs">
        <summary className="cursor-pointer text-muted hover:text-white">Export model spans to an OpenTelemetry collector</summary>
        <div className="mt-2"><TelemetryExportSetting /></div>
      </details>
    </div>
  );
}
