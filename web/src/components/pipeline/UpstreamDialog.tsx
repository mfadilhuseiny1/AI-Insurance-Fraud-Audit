"use client";

import { useMemo, useState } from "react";
import type { Upstream } from "@/lib/pipeline";
import { Icon } from "../Icon";
import { Modal } from "./Modal";
import { Tabs } from "./ui";

/**
 * How the pipeline's inputs were made, before this pipeline: the source files (their edition, size, sha256 and rows,
 * and whether the file in Files still has that sha256), the transform that read them (its steps, and its code at each
 * commit used), and each input dataset with the build that wrote it and whether its rows equal its files' rows.
 */
const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString("id-ID"));
const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toLocaleString("id-ID", { maximumFractionDigits: 2 })} GB` : `${(b / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 })} MB`);
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" }) + " WIB" : "—");

type Tab = "steps" | "files" | "outputs" | "code";

export function UpstreamDialog({ upstream: u, onClose }: { upstream: Upstream; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("steps");
  const [version, setVersion] = useState(u.transform.versions.at(-1)?.commit ?? "");
  const files = u.source.files;
  const bytes = files.reduce((s, f) => s + (f.bytes || 0), 0);
  const rows = files.reduce((s, f) => s + (f.rows || 0), 0);
  const editions = new Set(files.map((f) => f.edisi)).size;
  const allMatch = u.outputs.every((o) => o.matches);
  const v = u.transform.versions.find((x) => x.commit === version);
  const byDataset = useMemo(() => [...new Set(files.map((f) => f.dataset))].map((d) => ({ d, fs: files.filter((f) => f.dataset === d) })), [files]);

  const box = "min-w-0 flex-1 rounded-lg border border-line-2 bg-panel-2/60 p-3";
  return (
    <Modal title={u.title} icon="upload" onClose={onClose} xl>
      <div className="space-y-3 px-4 py-3 text-sm">
        <p className="text-[13px] leading-relaxed text-soft">{u.summary}</p>
        <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-center">
          <div className={box}>
            <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted">Arsip Sumber</p>
            <p className="font-medium text-white">{files.length} file .dta · {editions} edisi</p>
            <p className="text-xs text-soft">{gb(bytes)} · {n(rows)} baris</p>
            {u.source.verified && (
              <p className={`mt-1 flex items-center gap-1 text-[11px] ${u.source.verified.matched === u.source.verified.files ? "text-ok" : "text-warn"}`}>
                <Icon name="lock" className="h-3 w-3" /> sha256 diperiksa ulang: {u.source.verified.matched}/{u.source.verified.files} cocok
              </p>
            )}
          </div>
          <Icon name="right" className="h-4 w-4 shrink-0 self-center text-muted max-md:rotate-90" />
          <div className={box}>
            <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted">Transform</p>
            <p className="truncate font-medium text-white" title={u.transform.label}>{u.transform.label}</p>
            <p className="truncate font-mono text-[11px] text-soft" title={u.transform.path}>{u.transform.path.split("/").at(-1)} · {u.transform.versions.length} commit</p>
          </div>
          <Icon name="right" className="h-4 w-4 shrink-0 self-center text-muted max-md:rotate-90" />
          <div className={box}>
            <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted">Data Mentah</p>
            <p className="font-medium text-white">{u.outputs.length} dataset · {n(u.outputs.reduce((s, o) => s + (o.rows || 0), 0))} baris</p>
            <p className={`mt-1 flex items-center gap-1 text-[11px] ${allMatch ? "text-ok" : "text-bad"}`}>
              <Icon name={allMatch ? "check" : "alert"} className="h-3 w-3" /> {allMatch ? "jumlah baris = jumlah baris file asli" : "ada dataset yang barisnya tidak sama dengan filenya"}
            </p>
          </div>
          <Icon name="right" className="h-4 w-4 shrink-0 self-center text-muted max-md:rotate-90" />
          <div className={`${box} border-ocean/40`}>
            <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted">Pipeline ini</p>
            <p className="font-medium text-white">Data Bersih → Siap Analisis</p>
            <p className="text-xs text-soft">dimulai dari dataset Data Mentah</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {u.source.folder && (
            <a href={`/files/${u.source.folder.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ocean hover:underline">
              <Icon name="folder" className="h-3.5 w-3.5" /> {u.source.folder.name}
            </a>
          )}
          {u.transform.link && (
            <a href={u.transform.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ocean hover:underline">
              <Icon name="code" className="h-3.5 w-3.5" /> {u.transform.repo?.name ?? "Code Repository"}
            </a>
          )}
        </div>
      </div>
      <div className="sticky top-0 z-10 border-y border-line bg-panel px-4 py-1.5">
        <Tabs value={tab} onChange={setTab} tabs={[
          { id: "steps", label: "Langkah" },
          { id: "files", label: `File asli (${files.length})` },
          { id: "outputs", label: `Data Mentah (${u.outputs.length})` },
          { id: "code", label: "Kode" },
        ]} />
      </div>
      <div className="px-4 py-3 text-xs">
        {tab === "steps" && (
          <ol className="space-y-2.5">
            {u.transform.steps.map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ocean/15 text-[11px] font-medium text-ocean">{i + 1}</span>
                <div>
                  <p className="font-medium text-white">{s.title}</p>
                  <p className="leading-relaxed text-soft">{s.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
        {tab === "files" && (
          <div className="space-y-4">
            {u.source.verified && <p className="text-muted">sha256 tiap file dihitung ulang dari file di Files pada {when(u.source.verified.at)} dan dibandingkan dengan sha256 yang dicatat katalog saat Data Mentah dibangun.</p>}
            {byDataset.map(({ d, fs }) => (
              <section key={d}>
                <h3 className="mb-1 font-mono text-[11.5px] font-medium text-white">raw/{d}</h3>
                <table className="w-full table-fixed text-left">
                  <colgroup><col className="w-64" /><col className="w-32" /><col className="w-24" /><col className="w-28" /><col /></colgroup>
                  <thead className="text-[10.5px] uppercase tracking-wide text-muted">
                    <tr><th className="py-1 font-medium">File</th><th className="font-medium">Edisi</th><th className="text-right font-medium">Ukuran</th><th className="text-right font-medium">Baris</th><th className="pl-4 font-medium">sha256</th></tr>
                  </thead>
                  <tbody>
                    {fs.map((f) => (
                      <tr key={f.name} className="border-t border-line align-top">
                        <td className="truncate py-1 font-mono text-[11px]" title={f.name}>
                          {f.item_id ? <a href={`/files/${f.item_id}`} target="_blank" rel="noreferrer" className="text-ocean hover:underline">{f.name}</a> : f.name}
                        </td>
                        <td className="py-1 text-soft">{f.edisi}</td>
                        <td className="py-1 text-right tabular-nums text-soft">{gb(f.bytes)}</td>
                        <td className="py-1 text-right tabular-nums text-soft">{n(f.rows)}</td>
                        <td className="truncate py-1 pl-4 font-mono text-[10.5px] text-muted" title={f.sha256}>
                          {f.sha256_ok === true && <Icon name="check" className="mr-1 inline h-3 w-3 text-ok" />}
                          {f.sha256_ok === false && <Icon name="alert" className="mr-1 inline h-3 w-3 text-bad" />}
                          {f.sha256}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </div>
        )}
        {tab === "outputs" && (
          <table className="w-full text-left">
            <thead className="text-[10.5px] uppercase tracking-wide text-muted">
              <tr>{["Dataset", "File", "Baris file asli", "Baris dataset", "", "Edisi", "Dibangun", "Commit"].map((h, i) => <th key={i} className={`py-1 font-medium ${i >= 2 && i <= 3 ? "text-right" : ""}`}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {u.outputs.map((o) => (
                <tr key={o.name} className="border-t border-line align-top">
                  <td className="py-1.5 font-mono text-[11px] text-white">bronze/{o.name}</td>
                  <td className="py-1.5 text-soft">{o.files}</td>
                  <td className="py-1.5 text-right tabular-nums text-soft">{n(o.rows_from_files)}</td>
                  <td className="py-1.5 text-right tabular-nums text-soft">{n(o.rows)}</td>
                  <td className="py-1.5 pl-2">{o.matches ? <Icon name="check" className="h-3.5 w-3.5 text-ok" /> : <Icon name="alert" className="h-3.5 w-3.5 text-bad" />}</td>
                  <td className="py-1.5 text-soft">{o.editions.join(", ")}</td>
                  <td className="py-1.5 text-soft">{when(o.built_at)}</td>
                  <td className="py-1.5 font-mono text-[11px] text-soft">
                    {o.commit ? <button type="button" onClick={() => { setVersion(o.commit!); setTab("code"); }} className="text-ocean hover:underline">{o.commit}</button> : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === "code" && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {u.transform.versions.map((x) => (
                <button key={x.commit} type="button" onClick={() => setVersion(x.commit)}
                  className={`rounded-md border px-2 py-1 text-left ${x.commit === version ? "border-ocean bg-ocean/10 text-white" : "border-line-2 text-soft hover:text-white"}`}>
                  <span className="font-mono text-[11px]">{x.commit}</span> <span className="text-muted">· {x.datasets.join(", ")}</span>
                </button>
              ))}
            </div>
            {v && (
              <>
                <p className="text-muted"><span className="font-mono">{v.path}</span> pada commit <span className="font-mono">{v.commit}</span>{v.message ? ` — ${v.message}` : ""}</p>
                <div className="max-h-[52vh] overflow-auto rounded-md border border-line bg-ink font-mono text-[11px] leading-[1.55]">
                  <table className="w-full border-collapse">
                    <tbody>
                      {v.code.split("\n").map((l, i) => (
                        <tr key={i}>
                          <td className="select-none border-r border-line px-2 text-right align-top text-muted">{i + 1}</td>
                          <td className="whitespace-pre px-2 text-soft">{l || " "}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
