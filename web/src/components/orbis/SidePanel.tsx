"use client";

import { useMemo, useState } from "react";
import { orbis, orbisVariant, type KindMeta, type OrbisNode, type PredicateMeta, type SearchHit } from "@/lib/orbis";
import type { LabelMode } from "./GraphCanvas";

/* Filters, search (by name and by meaning through orbis-1), focus, path and layout — the ai-jkn explorer's side panel. */

interface Props {
  kinds: Record<string, KindMeta>;
  predicates: Record<string, PredicateMeta>;
  kindCounts: Record<string, number>;
  predicateCounts: Record<string, number>;
  enabledKinds: Set<string>;
  enabledPredicates: Set<string>;
  toggleKind: (k: string) => void;
  togglePredicate: (p: string) => void;
  setKinds: (next: Set<string>) => void;
  setPredicates: (next: Set<string>) => void;
  query: string;
  setQuery: (q: string) => void;
  hits: OrbisNode[];
  nodeIndex: Map<string, OrbisNode>;
  onSelect: (id: string) => void;
  onShowSet: (ids: string[]) => void;
  focusNode: OrbisNode | null;
  focusDepth: number;
  setFocusDepth: (d: number) => void;
  clearFocus: () => void;
  pathFrom: OrbisNode | null;
  pathTo: OrbisNode | null;
  pathResult: { labels: string[] } | null;
  clearPath: () => void;
  labelMode: LabelMode;
  setLabelMode: (m: LabelMode) => void;
  linkDistance: number;
  setLinkDistance: (n: number) => void;
  chargeStrength: number;
  setChargeStrength: (n: number) => void;
  releasePins: () => void;
  visibleNodes: number;
  visibleLinks: number;
}

export default function SidePanel(p: Props) {
  const [semantic, setSemantic] = useState<{ q: string; hits: SearchHit[]; ms: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const kindGroups = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const [key, meta] of Object.entries(p.kinds)) {
      const arr = groups.get(meta.group);
      if (arr) arr.push(key);
      else groups.set(meta.group, [key]);
    }
    return [...groups.entries()];
  }, [p.kinds]);

  const bySemantic = async () => {
    const q = p.query.trim();
    if (!q) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await orbis.search(q, 20);
      setSemantic({ q, hits: r.hits.filter((h) => p.nodeIndex.has(h.id)), ms: r.ms });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex min-h-0 flex-1 flex-col">
      <div className="border-b p-3">
        <div className="flex gap-1.5">
          <input
            type="search"
            value={p.query}
            onChange={(e) => p.setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && bySemantic()}
            placeholder="Cari faskes, dokter, dataset, model, jurnal…"
            className="min-w-0 flex-1 px-2.5 py-1.5"
          />
          <button className="btn shrink-0" onClick={bySemantic} disabled={busy || !p.query.trim()} title={`Pencarian semantik di indeks vector ${orbisVariant().index}`}>
            {busy ? "…" : "Makna"}
          </button>
        </div>
        {err && <p className="notice mt-2" data-tone="error">{err}</p>}
        {semantic && semantic.q === p.query.trim() && (
          <div className="mt-2">
            <div className="mb-1 flex items-center justify-between text-[11px]" style={{ color: "var(--kg-text-faint)" }}>
              <span className="mono">{orbisVariant().index} · {semantic.hits.length} hasil · {semantic.ms} ms</span>
              <button className="mono hover:underline" style={{ color: "var(--kg-accent)" }} onClick={() => p.onShowSet(semantic.hits.map((h) => h.id))}>
                sorot di graf
              </button>
            </div>
            <ul className="max-h-[260px] overflow-y-auto">
              {semantic.hits.map((h) => {
                const n = p.nodeIndex.get(h.id)!;
                return (
                  <li key={h.id}>
                    <button className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-[var(--kg-surface-2)]" onClick={() => p.onSelect(h.id)}>
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: p.kinds[n.kind]?.color ?? "#94a3b8" }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{n.label}</span>
                        <span className="block truncate text-[10.5px]" style={{ color: "var(--kg-text-faint)" }}>
                          {p.kinds[n.kind]?.label ?? n.kind}
                        </span>
                      </span>
                      <span className="mono shrink-0 text-[10px]" style={{ color: "var(--kg-text-faint)" }}>
                        {h.score.toFixed(2)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {!!p.hits.length && !(semantic && semantic.q === p.query.trim()) && (
          <ul className="mt-2 max-h-[240px] overflow-y-auto">
            {p.hits.map((node) => (
              <li key={node.id}>
                <button className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-[var(--kg-surface-2)]" onClick={() => p.onSelect(node.id)}>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: p.kinds[node.kind]?.color ?? "#94a3b8" }} />
                  <span className="min-w-0 flex-1 truncate">{node.label}</span>
                  <span className="mono max-w-24 shrink-0 truncate text-[10px]" style={{ color: "var(--kg-text-faint)" }}>
                    {node.rawId}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {p.query.trim() && !p.hits.length && !semantic && (
          <p className="mt-2 text-[11px]" style={{ color: "var(--kg-text-faint)" }}>
            Tidak ada nama yang cocok — tekan <b>Makna</b> untuk mencari menurut arti.
          </p>
        )}
      </div>

      {(p.focusNode || p.pathFrom || p.pathTo) && (
        <div className="border-b p-3">
          {p.focusNode && (
            <div className="mb-2">
              <Title>Fokus</Title>
              <div className="mb-1.5 truncate" style={{ color: "var(--kg-text-muted)" }}>
                {p.focusNode.label}
              </div>
              <div className="flex items-center gap-1.5">
                {[1, 2, 3].map((d) => (
                  <button key={d} className="btn" data-active={p.focusDepth === d} onClick={() => p.setFocusDepth(d)}>
                    {d} langkah
                  </button>
                ))}
                <button className="btn ml-auto" onClick={p.clearFocus}>
                  Lepas
                </button>
              </div>
            </div>
          )}
          {(p.pathFrom || p.pathTo) && (
            <div>
              <Title>Jalur</Title>
              <div className="space-y-0.5" style={{ color: "var(--kg-text-muted)" }}>
                <div className="truncate">
                  <span style={{ color: "var(--kg-text-faint)" }}>dari </span>
                  {p.pathFrom?.label ?? "—"}
                </div>
                <div className="truncate">
                  <span style={{ color: "var(--kg-text-faint)" }}>ke </span>
                  {p.pathTo?.label ?? "—"}
                </div>
              </div>
              {p.pathResult && (
                <ol className="mt-2 space-y-0.5">
                  {p.pathResult.labels.map((step, i) => (
                    <li key={i} className="flex gap-1.5 text-[11px]">
                      <span className="mono shrink-0" style={{ color: "var(--kg-text-faint)" }}>
                        {i + 1}
                      </span>
                      <span style={{ color: "var(--kg-text-muted)" }}>{step}</span>
                    </li>
                  ))}
                </ol>
              )}
              {p.pathFrom && p.pathTo && !p.pathResult && (
                <p className="mt-1.5 text-[11px]" style={{ color: "var(--kg-text-faint)" }}>
                  Tidak ada jalur dengan saringan relasi saat ini.
                </p>
              )}
              <button className="btn mt-2" onClick={p.clearPath}>
                Hapus jalur
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <section className="border-b p-3">
          <div className="mb-2 flex items-center justify-between">
            <Title>Jenis simpul</Title>
            <div className="flex gap-1">
              <MiniBtn onClick={() => p.setKinds(new Set(Object.keys(p.kinds)))}>semua</MiniBtn>
              <MiniBtn onClick={() => p.setKinds(new Set())}>kosongkan</MiniBtn>
            </div>
          </div>
          {kindGroups.map(([group, keys]) => (
            <div key={group} className="mb-2.5 last:mb-0">
              <div className="mono mb-1 text-[10px] uppercase tracking-wide" style={{ color: "var(--kg-text-faint)" }}>
                {group}
              </div>
              <div className="space-y-px">
                {keys.map((k) => (
                  <Row key={k} color={p.kinds[k].color} label={p.kinds[k].label} count={p.kindCounts[k] ?? 0} active={p.enabledKinds.has(k)}
                    onClick={() => p.toggleKind(k)} onOnly={() => p.setKinds(new Set([k]))} />
                ))}
              </div>
            </div>
          ))}
        </section>

        <section className="border-b p-3">
          <div className="mb-2 flex items-center justify-between">
            <Title>Jenis relasi</Title>
            <div className="flex gap-1">
              <MiniBtn onClick={() => p.setPredicates(new Set(Object.keys(p.predicates)))}>semua</MiniBtn>
              <MiniBtn onClick={() => p.setPredicates(new Set())}>kosongkan</MiniBtn>
            </div>
          </div>
          <div className="space-y-px">
            {Object.entries(p.predicates)
              .filter(([key]) => (p.predicateCounts[key] ?? 0) > 0)
              .sort((a, b) => (p.predicateCounts[b[0]] ?? 0) - (p.predicateCounts[a[0]] ?? 0))
              .map(([key, meta]) => (
                <Row key={key} color={meta.color} label={meta.label} title={meta.desc} count={p.predicateCounts[key] ?? 0}
                  active={p.enabledPredicates.has(key)} onClick={() => p.togglePredicate(key)} onOnly={() => p.setPredicates(new Set([key]))} />
              ))}
          </div>
        </section>

        <section className="p-3">
          <Title>Tata letak</Title>
          <div className="mt-2 space-y-3">
            <div>
              <div className="mb-1 text-[11px]" style={{ color: "var(--kg-text-faint)" }}>
                Label
              </div>
              <div className="flex gap-1">
                {(["auto", "all", "none"] as LabelMode[]).map((m) => (
                  <button key={m} className="btn" data-active={p.labelMode === m} onClick={() => p.setLabelMode(m)}>
                    {m === "auto" ? "otomatis" : m === "all" ? "semua" : "tanpa"}
                  </button>
                ))}
              </div>
            </div>
            <Slider label="Jarak relasi" value={p.linkDistance} min={10} max={140} step={5} onChange={p.setLinkDistance} />
            <Slider label="Gaya tolak" value={-p.chargeStrength} min={10} max={400} step={10} onChange={(v) => p.setChargeStrength(-v)} />
            <button className="btn w-full" onClick={p.releasePins}>
              Lepas simpul yang dipaku
            </button>
          </div>
        </section>
      </div>

      <footer className="mono border-t px-3 py-2 text-[10px]" style={{ color: "var(--kg-text-faint)" }}>
        {p.visibleNodes.toLocaleString("id-ID")} simpul · {p.visibleLinks.toLocaleString("id-ID")} relasi tampil
      </footer>
    </aside>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mono text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: "var(--kg-text-faint)" }}>
      {children}
    </h3>
  );
}

function MiniBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="mono rounded px-1.5 py-0.5 text-[10px] hover:bg-[var(--kg-surface-2)]" style={{ color: "var(--kg-text-faint)" }}>
      {children}
    </button>
  );
}

function Row({ color, label, count, active, onClick, onOnly, title }: {
  color: string; label: string; count: number; active: boolean; onClick: () => void; onOnly: () => void; title?: string;
}) {
  return (
    <div className="group flex items-center gap-2 rounded px-1 py-[3px] hover:bg-[var(--kg-surface-2)]" title={title}>
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onClick}>
        <span className="h-2 w-2 shrink-0 rounded-full transition-opacity" style={{ background: color, opacity: active ? 1 : 0.22 }} />
        <span className="min-w-0 flex-1 truncate" style={{ color: active ? "var(--kg-text)" : "var(--kg-text-faint)" }}>
          {label}
        </span>
        <span className="mono shrink-0 text-[10px]" style={{ color: "var(--kg-text-faint)" }}>
          {count.toLocaleString("id-ID")}
        </span>
      </button>
      <button onClick={onOnly} className="mono shrink-0 text-[10px] opacity-0 transition-opacity group-hover:opacity-100" style={{ color: "var(--kg-accent)" }} title="Hanya ini">
        hanya
      </button>
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-[11px]" style={{ color: "var(--kg-text-faint)" }}>
        <span>{label}</span>
        <span className="mono">{value}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--kg-accent)]" />
    </label>
  );
}
