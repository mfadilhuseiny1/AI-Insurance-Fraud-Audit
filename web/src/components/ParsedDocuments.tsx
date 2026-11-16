"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { JobControls } from "@/components/JobControls";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { StatusPill } from "@/components/StatusPill";
import { EmbedDocumentsDialog } from "@/components/vector-storage/EmbedDocumentsDialog";
import { api, type Job, type VectorIngest, type VectorSettings } from "@/lib/api";
import { when } from "@/lib/format";

const PAGE = 25;
const selectClass = inputClass.replace("w-full", "w-auto");

type Filter = "all" | "not_embedded" | "embedded" | "failed";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "not_embedded", label: "Not embedded" },
  { id: "embedded", label: "Embedded" },
  { id: "failed", label: "Embedding failed" },
];

const embeddable = (j: Job) => j.status === "completed" && (j.chunks ?? 0) > 0;
const active = (s: string) => s === "queued" || s === "running";

/**
 * Parse results under the upload area on the Parse tab, with where each one is embedded and
 * buttons to embed one or many into a vector index.
 */
export function ParsedDocuments() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [ingests, setIngests] = useState<VectorIngest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState<string[]>([]);
  const [embedding, setEmbedding] = useState<Job[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState<Record<string, VectorSettings>>({});

  const load = useCallback(() => {
    api
      .jobs()
      .then(setJobs)
      .catch((e: Error) => setError(e.message));
    // vector storage may not be configured: the list still works without it
    api.vectors
      .allIngests()
      .then(setIngests)
      .catch(() => setIngests([]));
    api.vectors
      .allSettings()
      .then(setSettings)
      .catch(() => setSettings({}));
  }, []);

  const busy = (jobs ?? []).some((j) => active(j.status)) || ingests.some((i) => active(i.status));
  useEffect(() => {
    load();
    const t = setInterval(load, busy ? 3000 : 15000);
    return () => clearInterval(t);
  }, [load, busy]);

  const byJob = useMemo(() => {
    const m = new Map<string, VectorIngest[]>();
    for (const i of ingests) m.set(i.job_id, [...(m.get(i.job_id) ?? []), i]);
    return m;
  }, [ingests]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (jobs ?? []).filter((j) => {
      if (j.status === "failed") return false;
      if (needle && !j.file_name.toLowerCase().includes(needle) && !j.id.includes(needle)) return false;
      const ins = byJob.get(j.id) ?? [];
      if (filter === "embedded") return ins.some((i) => i.status === "completed");
      if (filter === "not_embedded") return embeddable(j) && !ins.some((i) => i.status === "completed");
      if (filter === "failed") return ins.some((i) => i.status === "failed");
      return true;
    });
  }, [jobs, q, filter, byJob]);

  if (error) return <p className="px-8 text-sm text-bad">{error}</p>;
  if (!jobs) return null;

  const visible = rows.slice(0, shown);
  const auto = Object.entries(settings).filter(([, s]) => s.auto_embed);
  const selectable = visible.filter(embeddable);
  const allPicked = selectable.length > 0 && selectable.every((j) => picked.includes(j.id));
  const pickedJobs = jobs.filter((j) => picked.includes(j.id));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const started = (index: string, out: VectorIngest[]) => {
    const n = embedding?.length ?? 0;
    const skipped = out.filter((r) => r.status === "completed").length;
    setEmbedding(null);
    setPicked([]);
    setNotice(
      `Embedding ${n - skipped} document${n - skipped === 1 ? "" : "s"} into ${index}` +
        (skipped ? ` · ${skipped} already there, skipped` : "") +
        ". Progress shows below.",
    );
    load();
  };

  return (
    <section className="mx-auto w-full max-w-6xl px-8 pb-10">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-sm font-semibold">
          Parsed documents <span className="font-normal text-muted">{rows.length}</span>
        </h2>
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or job id" className={`${inputClass} w-60 py-1 pl-8 text-xs`} />
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className={`${selectClass} py-1 text-xs`}>
          {FILTERS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <Link href="/vector-storage" className={`${buttonClass.ghost} ml-auto text-xs`}>
          <Icon name="database" className="h-3.5 w-3.5" /> Vector Storage
        </Link>
        <button type="button" disabled={!pickedJobs.length} onClick={() => setEmbedding(pickedJobs)} className={buttonClass.primary}>
          <Icon name="sparkle" className="h-3.5 w-3.5" />
          Embed selected{pickedJobs.length ? ` (${pickedJobs.length})` : ""}
        </button>
      </div>

      {auto.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-soft">
          <Icon name="bolt" className="h-3.5 w-3.5 text-sand" />
          New parses are embedded automatically into
          {auto.map(([name, s]) => (
            <Link
              key={name}
              href="/vector-storage"
              title="Change or turn off in Vector Storage → Settings"
              className="rounded border border-sand/40 px-1.5 py-px font-mono text-[11px] text-sand hover:bg-sand/10"
            >
              {name}
              {s.auto_embed_tiers.length > 0 && <span className="text-muted"> · {s.auto_embed_tiers.join(", ")} only</span>}
            </Link>
          ))}
        </div>
      )}

      {notice && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-ocean/40 bg-ocean/10 px-3 py-2 text-xs text-soft">
          <Icon name="info" className="h-4 w-4 shrink-0 text-ocean" />
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-muted hover:text-white">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {!rows.length ? (
        <div className="rounded-xl border border-dashed border-line-2 py-10 text-center text-sm text-muted">
          {jobs.length ? "No documents match." : "Nothing parsed yet. Upload a file above to start."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel/40">
          <table className="w-full text-sm">
            <thead className="bg-panel text-left text-xs text-muted">
              <tr>
                <th className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allPicked}
                    disabled={!selectable.length}
                    onChange={() =>
                      setPicked((p) => (allPicked ? p.filter((id) => !selectable.some((j) => j.id === id)) : [...new Set([...p, ...selectable.map((j) => j.id)])]))
                    }
                    className="accent-ocean"
                  />
                </th>
                {["Document", "Pages", "Chunks", "Parsed", "Vector indexes", ""].map((h) => (
                  <th key={h} className="px-3 py-2.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((j) => {
                const ok = embeddable(j);
                return (
                  <tr key={j.id} className={`border-t border-line ${picked.includes(j.id) ? "bg-ocean/5" : "hover:bg-panel/60"}`}>
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        aria-label={`Select ${j.file_name}`}
                        checked={picked.includes(j.id)}
                        disabled={!ok}
                        onChange={() => toggle(j.id)}
                        className="accent-ocean"
                      />
                    </td>
                    <td className="max-w-xs px-3 py-2.5">
                      <Link href={`/parse/${j.id}`} className="block truncate hover:text-ocean" title={j.file_name}>
                        {j.file_name}
                      </Link>
                      <span className="font-mono text-[11px] text-muted">
                        {j.id} · {j.tier_label}
                      </span>
                      {j.batch_id && (
                        <Link href={`/parse/batch/${j.batch_id}`} className="ml-1.5 rounded bg-panel-2 px-1 py-px text-[10px] text-soft ring-1 ring-line-2 hover:text-ocean">
                          batch
                        </Link>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-soft">
                      {j.page_from}–{j.page_to}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-soft">
                      {j.chunks ?? "–"}
                      {j.chunking && <div className="text-[10.5px] text-muted">{j.chunking === "semantic" ? "by topic" : "by heading"}</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-soft">{j.status === "completed" ? (
                        <>
                          {when(j.finished_at ?? j.created_at)}
                          {j.partial && <div className="text-[10.5px] text-sand">partial: {j.pages_not_parsed.length} pages not parsed</div>}
                        </>
                      ) : (
                        <div className="space-y-1">
                          <StatusPill job={j} />
                          <JobControls job={j} compact onChanged={load} />
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <IndexChips ingests={byJob.get(j.id) ?? []} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      <button
                        type="button"
                        disabled={!ok}
                        onClick={() => setEmbedding([j])}
                        title={ok ? "Embed into a vector index" : j.status === "completed" ? "No chunks to embed" : "Not parsed yet"}
                        className="inline-flex items-center gap-1 rounded-md border border-line-2 px-2 py-1 text-xs text-soft hover:border-ocean hover:text-ocean disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <Icon name="sparkle" className="h-3.5 w-3.5" /> Embed
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > shown && (
            <button type="button" onClick={() => setShown((n) => n + PAGE)} className="w-full border-t border-line py-2 text-xs text-soft hover:bg-panel hover:text-white">
              Show more ({rows.length - shown} left)
            </button>
          )}
        </div>
      )}

      {embedding && <EmbedDocumentsDialog jobs={embedding} ingests={ingests} onClose={() => setEmbedding(null)} onStarted={started} />}
    </section>
  );
}

function IndexChips({ ingests }: { ingests: VectorIngest[] }) {
  if (!ingests.length) return <span className="text-xs text-muted">–</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {ingests.map((i) => {
        const tone =
          i.status === "completed" ? "border-ok/30 text-ok" : i.status === "failed" ? "border-bad/40 text-bad" : "border-ocean/40 text-ocean";
        const detail =
          i.status === "completed"
            ? `${i.vectors} vectors` + (i.skipped ? ` · ${i.skipped} chunks left out` : "")
            : i.status === "failed"
              ? i.error ?? "failed"
              : `${i.vectors}/${i.total || "?"}`;
        const tags = Object.entries(i.options?.metadata ?? {});
        return (
          <Link
            key={i.index_name}
            href="/vector-storage"
            title={[`${i.index_name} · ${i.model} · ${i.dimension}d`, detail, ...tags.map(([k, v]) => `${k}=${v}`)].join("\n")}
            className={`inline-flex max-w-[14rem] items-center gap-1 rounded border px-1.5 py-px font-mono text-[10.5px] hover:bg-panel-2 ${tone}`}
          >
            {active(i.status) ? (
              <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent" />
            ) : (
              <Icon name={i.status === "completed" ? "check" : "alert"} className="h-3 w-3 shrink-0" />
            )}
            <span className="truncate">{i.index_name}</span>
            {active(i.status) && <span className="tabular-nums">{detail}</span>}
          </Link>
        );
      })}
    </div>
  );
}
