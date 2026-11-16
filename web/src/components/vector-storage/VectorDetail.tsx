"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { api, type VectorDetail as Detail, type VectorMetric, type VectorRow } from "@/lib/api";

/**
 * One vector, loaded in full only when opened; its neighbors are searched only when asked for.
 * Render it with key={vectorKey} so its state starts fresh for each vector.
 */
export function VectorDetail({
  index,
  metric,
  vectorKey,
  onOpen,
  onClose,
}: {
  index: string;
  metric: VectorMetric;
  vectorKey: string;
  onOpen: (key: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [neighbors, setNeighbors] = useState<VectorRow[] | null>(null);
  const [nbLoading, setNbLoading] = useState(false);
  const [allValues, setAllValues] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    api.vectors
      .vector(index, vectorKey, ctl.signal)
      .then(setData)
      .catch((e: Error) => !ctl.signal.aborted && setError(e.message));
    return () => ctl.abort();
  }, [index, vectorKey]);

  const loadNeighbors = async () => {
    setNbLoading(true);
    try {
      setNeighbors((await api.vectors.neighbors(index, vectorKey, 10)).rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setNbLoading(false);
    }
  };

  return (
    <aside className="flex min-h-0 w-[460px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="break-all font-mono text-xs">{vectorKey}</div>
          {data && (
            <div className="mt-0.5 truncate text-xs text-muted">
              {data.file_name} {data.pages.length > 0 && `· ${pageLabel(data.pages)}`}
            </div>
          )}
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white" title="Close">
          <Icon name="x" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {error && <p className="text-xs text-bad">{error}</p>}
        {!data && !error && <p className="text-xs text-muted">Loading vector…</p>}

        {data && (
          <>
            <Section title="Metadata">
              <table className="w-full text-xs">
                <tbody>
                  {Object.entries(data.metadata).map(([k, v]) => (
                    <tr key={k} className="border-b border-line last:border-0">
                      <td className="w-28 py-1 pr-2 align-top font-mono text-[11px] text-muted">{k}</td>
                      <td className="break-all py-1 font-mono text-[11px]">{JSON.stringify(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <Section title="Embedded text">
              {data.text ? (
                <ShowMore text={data.text} limit={480} />
              ) : (
                <p className="text-xs text-muted">The source chunk could not be found (its parse job may have been deleted).</p>
              )}
            </Section>

            <Section title={`Embedding · ${data.stats.dimension} dimensions`}>
              <div className="mb-3 grid grid-cols-3 gap-1.5">
                <Stat label="L2 norm" value={data.stats.norm} />
                <Stat label="mean" value={data.stats.mean} />
                <Stat label="std dev" value={data.stats.std} />
                <Stat label="min" value={data.stats.min} />
                <Stat label="max" value={data.stats.max} />
                <Stat label="zeros" value={data.stats.zeros} />
              </div>
              <Heatmap values={data.data} std={data.stats.std} />
              <div className="mt-3 grid grid-cols-4 gap-x-2 gap-y-0.5 font-mono text-[10.5px]">
                {(allValues ? data.data : data.data.slice(0, 24)).map((v, i) => (
                  <span key={i} className="flex justify-between gap-1">
                    <span className="text-muted">{i}</span>
                    <span>{v.toFixed(4)}</span>
                  </span>
                ))}
              </div>
              <div className="mt-2 flex gap-1.5">
                <button type="button" className={smallButton} onClick={() => setAllValues((a) => !a)}>
                  {allValues ? "Show fewer" : `Show all ${data.data.length} values`}
                </button>
                <button
                  type="button"
                  className={smallButton}
                  onClick={() =>
                    navigator.clipboard.writeText(JSON.stringify(data.data)).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    })
                  }
                >
                  <Icon name={copied ? "check" : "copy"} className="h-3.5 w-3.5" />
                  {copied ? "Copied" : "Copy JSON"}
                </button>
              </div>
            </Section>

            <Section title="Nearest neighbors">
              {!neighbors ? (
                <button type="button" className={smallButton} onClick={loadNeighbors} disabled={nbLoading}>
                  {nbLoading ? "Searching…" : "Find the 10 closest vectors"}
                </button>
              ) : (
                <ResultList rows={neighbors} metric={metric} onOpen={onOpen} />
              )}
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}

export const smallButton =
  "inline-flex items-center gap-1.5 rounded-md border border-line-2 bg-panel-2 px-2.5 py-1 text-xs text-soft hover:text-white disabled:cursor-not-allowed disabled:opacity-40";

export function pageLabel(pages: number[]): string {
  if (!pages.length) return "";
  const [a, b] = [Math.min(...pages), Math.max(...pages)];
  return a === b ? `p. ${a}` : `pp. ${a}–${b}`;
}

/** Cosine scores are similarities (higher is closer); euclidean scores are distances (lower is closer). */
export function ScoreBar({ score, metric }: { score: number; metric: VectorMetric }) {
  // unit vectors: cosine similarity is in [-1, 1], euclidean distance in [0, 2]
  const fill = metric === "cosine" ? score : 1 - score / 2;
  return (
    <div className="h-[3px] rounded-full bg-line">
      <div className="h-full rounded-full bg-ocean" style={{ width: `${Math.max(0, Math.min(1, fill)) * 100}%` }} />
    </div>
  );
}

type ScoreKind = VectorMetric | "rrf" | "rerank";

const SCORE_TITLE: Record<ScoreKind, string> = {
  cosine: "cosine similarity (higher is closer)",
  euclidean: "euclidean distance (lower is closer)",
  rrf: "reciprocal rank fusion of vector and keyword ranks (higher is better)",
  rerank: "AI relevance score, 0–1 (higher is better)",
};

/** Search or neighbor results. `scoreKind` says what `score` is (the metric unless hybrid or re-ranked). */
export function ResultList({
  rows,
  metric,
  scoreKind = metric,
  onOpen,
}: {
  rows: VectorRow[];
  metric: VectorMetric;
  scoreKind?: ScoreKind;
  onOpen: (key: string) => void;
}) {
  if (!rows.length) return <p className="text-xs text-muted">No results.</p>;
  // a hybrid score is 1/(60+rank) summed over the two lists: at most 2/61
  const fill = (score: number) => (scoreKind === "rrf" ? score / (2 / 61) : scoreKind === "rerank" ? score : null);
  return (
    <ul className="space-y-1">
      {rows.map((r) => {
        const s = r.signals;
        const f = fill(r.score ?? 0);
        return (
          <li key={r.key ?? `${r.job_id}#${r.chunk_index}`}>
            <button
              type="button"
              disabled={!r.key}
              className="w-full rounded-md px-2 py-1.5 text-left hover:bg-panel-2 disabled:cursor-default"
              onClick={() => r.key && onOpen(r.key)}
              title={r.key ? undefined : "Found by keyword only: its vector wasn't among the vector hits"}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-soft">
                  {r.key ?? `${r.job_id} · chunk ${r.chunk_index}`}
                </span>
                {s && scoreKind !== metric && (
                  <span className="flex shrink-0 gap-1 font-mono text-[10px] text-muted">
                    {s.vector_rank != null && <span title="rank among vector hits">vec #{s.vector_rank}</span>}
                    {s.keyword_rank != null && <span title="rank among keyword (BM25) hits">kw #{s.keyword_rank}</span>}
                    {s.rerank != null && <span title="AI relevance, 0–10">ai {s.rerank}</span>}
                  </span>
                )}
                <span className="shrink-0 font-mono text-[11px] tabular-nums" title={SCORE_TITLE[scoreKind]}>
                  {r.score?.toFixed(scoreKind === "rrf" ? 4 : 3)}
                </span>
              </div>
              <div className="mt-1">
                {f == null ? (
                  <ScoreBar score={r.score ?? 0} metric={metric} />
                ) : (
                  <div className="h-[3px] rounded-full bg-line">
                    <div className="h-full rounded-full bg-ocean" style={{ width: `${Math.max(0, Math.min(1, f)) * 100}%` }} />
                  </div>
                )}
              </div>
              <div className="mt-1 truncate text-xs text-muted">
                {r.file_name} {r.pages.length > 0 && `· ${pageLabel(r.pages)}`}
              </div>
              {r.preview && <div className="line-clamp-2 text-xs text-soft">{r.preview}</div>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ShowMore({ text, limit }: { text: string; limit: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > limit;
  return (
    <div className="text-xs leading-relaxed text-soft">
      <p className="whitespace-pre-wrap" dir="auto">
        {open || !long ? text : `${text.slice(0, limit)}…`}
      </p>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 text-ocean hover:underline">
          {open ? "Show less" : `Show all ${text.length.toLocaleString()} characters`}
        </button>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted">{title}</h3>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-line bg-panel-2 px-2 py-1">
      <div className="text-[10px] text-muted">{label}</div>
      <div className="font-mono text-xs tabular-nums">{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------ heatmap */

// diverging ocean (positive) ↔ red (negative) through the panel color
const POS = [0x3d, 0x8b, 0xfd];
const NEG = [0xf0, 0x61, 0x6d];
const MID = [0x1d, 0x27, 0x35];

/**
 * Every dimension as one cell of a square grid on a single canvas (not thousands of DOM nodes).
 * The scale saturates at ±4 standard deviations: values cluster near zero, so a ±max scale would
 * leave almost every cell grey.
 */
function Heatmap({ values, std }: { values: number[]; std: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const cols = Math.ceil(Math.sqrt(values.length));
  const rows = Math.ceil(values.length / cols);
  // fit the grid in the panel: 1024 dims → 32 columns of 9 px; 4096 → 64 columns of 4 px
  const cell = Math.max(3, Math.min(9, Math.floor(400 / cols) - 1));
  const gap = 1;
  const span = useMemo(() => Math.max(std * 4, 1e-6), [std]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cols * (cell + gap) - gap;
    const h = rows * (cell + gap) - gap;
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    values.forEach((v, i) => {
      const t = Math.min(Math.abs(v) / span, 1);
      const pole = v >= 0 ? POS : NEG;
      const rgb = MID.map((m, k) => Math.round(m + (pole[k] - m) * t));
      ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      ctx.fillRect((i % cols) * (cell + gap), Math.floor(i / cols) * (cell + gap), cell, cell);
    });
    if (hover) {
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-strong").trim() || "#e8edf5";
      ctx.lineWidth = 1.5;
      ctx.strokeRect((hover.i % cols) * (cell + gap) - 0.5, Math.floor(hover.i / cols) * (cell + gap) - 0.5, cell + 1, cell + 1);
    }
  }, [values, cols, rows, cell, span, hover]);

  const css = (c: number[]) => `rgb(${c.join(",")})`;

  return (
    <div>
      <div className="relative inline-block">
        <canvas
          ref={ref}
          role="img"
          aria-label={`Heatmap of ${values.length} embedding values`}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - r.left;
            const y = e.clientY - r.top;
            const i = Math.floor(y / (cell + gap)) * cols + Math.floor(x / (cell + gap));
            setHover(i >= 0 && i < values.length ? { i, x, y } : null);
          }}
          onMouseLeave={() => setHover(null)}
        />
        {hover && (
          <div
            className="pointer-events-none absolute z-10 rounded border border-line-2 bg-ink px-1.5 py-0.5 font-mono text-[11px] shadow-lg"
            style={{ left: Math.min(hover.x + 12, cols * (cell + gap) - 110), top: hover.y + 12 }}
          >
            dim {hover.i} · {values[hover.i].toFixed(5)}
          </div>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2" style={{ maxWidth: cols * (cell + gap) }}>
        <span className="font-mono text-[10px] text-muted">−{span.toFixed(3)}</span>
        <div className="h-2 flex-1 rounded-sm" style={{ background: `linear-gradient(to right, ${css(NEG)}, ${css(MID)}, ${css(POS)})` }} />
        <span className="font-mono text-[10px] text-muted">+{span.toFixed(3)}</span>
      </div>
      <p className="mt-1 text-[10.5px] text-muted">One cell per dimension, left to right from the top. Scale saturates at ±4 std dev.</p>
    </div>
  );
}
