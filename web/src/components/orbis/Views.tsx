"use client";

import { useEffect, useMemo, useState } from "react";
import { orbis, orbisVariant, type IndexStatus, type KindMeta, type LinkRow, type OrbisNode, type OrbisPayload, type PredicateMeta } from "@/lib/orbis";

/* The explorer's other views: Relasi (every relation type and its rows), Ringkasan (the layers of the operating picture,
   the vector index orbis-1 and rebuilding) and Rujukan (the journals and regulations, and what rests on them). */

const muted = { color: "var(--kg-text-muted)" };
const faint = { color: "var(--kg-text-faint)" };

export function RelationsView({ links, nodeIndex, kinds, predicates, onSelect }: {
  links: LinkRow[];
  nodeIndex: Map<string, OrbisNode>;
  kinds: Record<string, KindMeta>;
  predicates: Record<string, PredicateMeta>;
  onSelect: (id: string) => void;
}) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const l of links) c[l.predicate] = (c[l.predicate] ?? 0) + 1;
    return c;
  }, [links]);
  const order = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const [pred, setPred] = useState<string>(order[0] ?? "");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(200);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return links.filter((l) => l.predicate === pred && (!s || `${nodeIndex.get(l.s)?.label} ${nodeIndex.get(l.t)?.label}`.toLowerCase().includes(s)));
  }, [links, pred, q, nodeIndex]);
  const end = (id: string) => {
    const n = nodeIndex.get(id);
    return (
      <button className="flex min-w-0 items-center gap-1.5 text-left hover:underline" onClick={() => onSelect(id)}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: kinds[n?.kind ?? ""]?.color ?? "#94a3b8" }} />
        <span className="truncate">{n?.label ?? id}</span>
      </button>
    );
  };
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-[300px] shrink-0 overflow-y-auto border-r panel p-2">
        {order.map((p) => (
          <button key={p} onClick={() => (setPred(p), setLimit(200))}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--kg-surface-2)]"
            style={p === pred ? { background: "var(--kg-accent-soft)" } : undefined} title={predicates[p]?.desc}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: predicates[p]?.color ?? "#64748b" }} />
            <span className="min-w-0 flex-1 truncate">{predicates[p]?.label ?? p}</span>
            <span className="mono text-[10px]" style={faint}>{counts[p].toLocaleString("id-ID")}</span>
          </button>
        ))}
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-4">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-medium">{predicates[pred]?.label ?? pred}</div>
            <p className="text-[12px]" style={muted}>{predicates[pred]?.desc}</p>
          </div>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Saring baris…" className="w-64 px-2.5 py-1.5" />
        </div>
        <div className="card overflow-hidden">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b text-left" style={faint}>
                <th className="px-3 py-2 font-normal">Subjek</th>
                <th className="px-3 py-2 font-normal">Relasi</th>
                <th className="px-3 py-2 font-normal">Objek</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((l) => (
                <tr key={l.id} className="border-b last:border-0">
                  <td className="max-w-0 px-3 py-1.5">{end(l.s)}</td>
                  <td className="mono whitespace-nowrap px-3 py-1.5 text-[11px]" style={muted}>
                    {predicates[l.predicate]?.label}
                    {l.propertyLabel ? ` · ${l.propertyLabel}` : ""}
                  </td>
                  <td className="max-w-0 px-3 py-1.5">{end(l.t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > limit && (
          <button className="btn mt-2" onClick={() => setLimit((n) => n + 500)}>
            Tampilkan lebih banyak ({(rows.length - limit).toLocaleString("id-ID")} lagi)
          </button>
        )}
      </main>
    </div>
  );
}

export function BriefView({ data, onKinds, onReload }: { data: OrbisPayload; onKinds: (kinds: string[]) => void; onReload: () => void }) {
  const [idx, setIdx] = useState<IndexStatus | null>(null);
  const [build, setBuild] = useState<{ state: string; error?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [i, b] = await Promise.all([orbis.index(), orbis.buildStatus()]);
        if (!alive) return;
        setIdx(i);
        setBuild((prev) => {
          if (prev?.state === "running" && b.state === "done") onReload();
          return b;
        });
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [onReload]);
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const pct = idx?.todo ? Math.round(((idx.done ?? 0) / idx.todo) * 100) : null;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1200px] space-y-4 p-5">
        <div>
          <div className="text-[20px] font-semibold tracking-tight">{orbisVariant().title}</div>
          <p className="mt-1 max-w-3xl leading-relaxed" style={muted}>
            Graf pengetahuan operasional demo <b>{data.meta.project}</b>: {orbisVariant().intro}
          </p>
          <div className="mono mt-2 flex flex-wrap gap-3 text-[11px]" style={faint}>
            <span>{data.stats.nodes.toLocaleString("id-ID")} simpul</span>
            <span>{data.stats.links.toLocaleString("id-ID")} relasi</span>
            <span>{Object.keys(data.kinds).length} jenis simpul</span>
            <span>{Object.keys(data.predicates).length} jenis relasi</span>
            <span>dibangun {new Date(data.stats.generatedAt).toLocaleString("id-ID")}</span>
          </div>
        </div>
        {err && <p className="notice" data-tone="error">{err}</p>}

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.layers.map((l) => (
            <div key={l.key} className="card p-3">
              <div className="flex items-center gap-2">
                <span className="mono flex h-5 w-5 items-center justify-center rounded text-[10px]" style={{ background: "var(--kg-accent-soft)", color: "var(--kg-accent)" }}>
                  {l.n}
                </span>
                <span className="font-medium">{l.name}</span>
                <button className="mono ml-auto text-[10.5px] hover:underline" style={{ color: "var(--kg-accent)" }} onClick={() => onKinds(l.kinds.map((k) => k.kind))}>
                  tampilkan di graf
                </button>
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed" style={muted}>{l.gist}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {l.kinds.map((k) => (
                  <button key={k.kind} className="chip flex items-center gap-1 hover:underline" onClick={() => onKinds([k.kind])}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: data.kinds[k.kind]?.color }} />
                    {k.label} <span className="mono" style={faint}>{k.count.toLocaleString("id-ID")}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="card p-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">Indeks vector {idx?.index ?? data.meta.index}</span>
              <span className="chip">{idx?.state ?? "…"}</span>
            </div>
            <dl className="mt-2 grid grid-cols-[130px_1fr] gap-y-1 text-[12px]">
              <dt style={faint}>Vector bucket</dt>
              <dd className="mono truncate" style={muted}>{idx?.bucket ?? "—"}</dd>
              <dt style={faint}>Model embedding</dt>
              <dd className="mono" style={muted}>{idx?.model ?? data.meta.embedding_model} · {idx?.dimension ?? 1024} dimensi · cosine</dd>
              <dt style={faint}>Vector tersimpan</dt>
              <dd style={muted}>{(idx?.vectors ?? 0).toLocaleString("id-ID")} dari {data.stats.nodes.toLocaleString("id-ID")} simpul</dd>
              {idx?.state === "running" && (
                <>
                  <dt style={faint}>Kemajuan</dt>
                  <dd style={muted}>{idx.done ?? 0} / {idx.todo ?? "…"} {pct != null ? `(${pct} %)` : ""}</dd>
                </>
              )}
              {idx?.cost_usd != null && (
                <>
                  <dt style={faint}>Biaya run terakhir</dt>
                  <dd style={muted}>US$ {idx.cost_usd.toFixed(4)}</dd>
                </>
              )}
              {idx?.finished_at && (
                <>
                  <dt style={faint}>Selesai</dt>
                  <dd style={muted}>{new Date(idx.finished_at).toLocaleString("id-ID")}</dd>
                </>
              )}
            </dl>
            {idx?.error && <p className="notice mt-2" data-tone="error">{idx.error}</p>}
            <p className="mt-2 text-[11.5px] leading-relaxed" style={faint}>
              Tiap simpul di-embed bersama atribut dan relasinya, jadi pencarian makna menemukan objek lewat tetangganya. Hanya simpul yang berubah
              di-embed ulang.
            </p>
            <div className="mt-2 flex gap-1.5">
              <button className="btn" disabled={idx?.state === "running"} onClick={() => run(() => orbis.reindex(false).then(setIdx))}>
                Perbarui indeks
              </button>
              <button className="btn" disabled={idx?.state === "running"} onClick={() => run(() => orbis.reindex(true).then(setIdx))}>
                Embed ulang semua
              </button>
            </div>
          </div>
          <div className="card p-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">Sumber graf</span>
              <span className="chip">{build?.state ?? "…"}</span>
            </div>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-[12px] leading-relaxed" style={muted}>
              {orbisVariant().sources.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            {build?.error && <p className="notice mt-2" data-tone="error">{build.error}</p>}
            <button className="btn mt-2" disabled={build?.state === "running"} onClick={() => run(() => orbis.rebuild().then(setBuild))}>
              {build?.state === "running" ? "Membangun ulang… (beberapa menit)" : "Bangun ulang graf dari platform"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ReferencesView({ data, nodeIndex, links, onSelect }: { data: OrbisPayload; nodeIndex: Map<string, OrbisNode>; links: LinkRow[]; onSelect: (id: string) => void }) {
  const users = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const l of links) {
      if (l.predicate !== "basedOn" && l.predicate !== "governs") continue;
      const ref = l.predicate === "basedOn" ? l.t : l.s;
      const other = l.predicate === "basedOn" ? l.s : l.t;
      m.set(ref, [...(m.get(ref) ?? []), other]);
    }
    return m;
  }, [links]);
  const journals = data.nodes.filter((n) => n.kind === "c:journal").sort((a, b) => Number(fact(a, "Tahun")) - Number(fact(b, "Tahun")));
  const regs = data.nodes.filter((n) => n.kind === "c:regulation");
  const card = (n: OrbisNode) => (
    <div key={n.id} className="card p-3">
      <button className="text-left font-medium hover:underline" onClick={() => onSelect(n.id)}>{n.label}</button>
      {n.definition && <p className="mt-1 text-[12px] leading-relaxed" style={muted}>{n.definition}</p>}
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px]" style={faint}>
        {(n.facts ?? []).map(([k, v]) => (
          <span key={k}>
            {k}: <span style={muted}>{v}</span>
          </span>
        ))}
      </div>
      {n.url && (
        <a href={n.url} target="_blank" rel="noopener" className="mono mt-1 inline-block text-[11px] hover:underline" style={{ color: "var(--kg-accent)" }}>
          {n.url.replace(/^https?:\/\//, "")} ↗
        </a>
      )}
      {!!users.get(n.id)?.length && (
        <div className="mt-2 flex flex-wrap gap-1">
          <span className="text-[10.5px]" style={faint}>{n.kind === "c:journal" ? "dirujuk oleh" : "mengatur"}</span>
          {users.get(n.id)!.slice(0, 12).map((id) => (
            <button key={id} className="chip hover:underline" onClick={() => onSelect(id)}>{nodeIndex.get(id)?.label ?? id}</button>
          ))}
          {users.get(n.id)!.length > 12 && <span className="chip">+{users.get(n.id)!.length - 12}</span>}
        </div>
      )}
    </div>
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1200px] space-y-4 p-5">
        <div>
          <div className="text-[15px] font-medium">Jurnal rujukan machine learning & IoT</div>
          <p className="text-[12px]" style={muted}>Publikasi asal tiap detektor, metode dan model yang dipakai demo. Data demo fiktif; metodenya nyata.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">{journals.map(card)}</div>
        <div className="pt-2">
          <div className="text-[15px] font-medium">Regulasi, pedoman & standar</div>
          <p className="text-[12px]" style={muted}>Dasar aturan skrining, kode klaim dan register alat.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">{regs.map(card)}</div>
      </div>
    </div>
  );
}

function fact(n: OrbisNode, k: string): string {
  return n.facts?.find(([a]) => a === k)?.[1] ?? "";
}
