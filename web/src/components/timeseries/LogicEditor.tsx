"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { ObjectPicker } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { codeRepos, type RepoSummary } from "@/lib/codeRepos";
import { ontology, type ObjectType } from "@/lib/ontology";
import {
  AGGREGATIONS,
  CARD_INFO,
  cardInfo,
  fmtValue,
  nextCardId,
  resolveRange,
  SCALAR_CARDS,
  timeseries,
  tsOntology,
  type Card,
  type CardGroup,
  type CardResult,
  type CardType,
  type DerivedSeries,
  type Logic,
  type ObjectTsp,
  type ObjRef,
  type QueryResult,
  type SeriesSync,
  type VisualFunction,
} from "@/lib/timeseries";
import { RangePicker, TsChart } from "./TsChart";

// cards whose result is intervals (time series search, event sets)
const INTERVAL_CARDS: string[] = ["search", "event_set", "event_ranges", "event_shift", "event_dedupe"];

export type EditorMode = "templated" | "single" | "alerting" | "quiver";
export type Range = { start?: string | null; end?: string | null; last?: string | null };

/**
 * Quiver-style time series logic: cards in order, each with its identifier ($A), configuration and a live preview
 * for the preview root object over the chosen range. Templated logic (derived series, alerting) reads the root
 * object's time series properties and linked sensors; single and Quiver logic can name other objects per card.
 */
export function LogicEditor({
  logic,
  onChange,
  mode,
  rootTypeId,
  root,
  onRoot,
  range,
  onRange,
  resource,
  allowed,
  showOutput = true,
  params,
  onResults,
  readOnly,
  visibleCardIds,
  openCardPicker = false,
  onCloseCardPicker,
}: {
  logic: Logic;
  onChange: (l: Logic) => void;
  mode: EditorMode;
  rootTypeId?: string | null;
  root: ObjRef | null;
  onRoot?: (r: ObjRef | null) => void;
  range: Range;
  onRange?: (r: Range) => void;
  resource: string;
  allowed?: CardType[];
  showOutput?: boolean;
  params?: Record<string, unknown>;
  onResults?: (r: QueryResult | null) => void;
  readOnly?: boolean;
  /** Canvas membership affects display only; the full analysis logic still evaluates in dependency order. */
  visibleCardIds?: string[];
  openCardPicker?: boolean;
  onCloseCardPicker?: () => void;
}) {
  const [results, setResults] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tspsState, setTsps] = useState<{ key: string; list: ObjectTsp[] }>({ key: "", list: [] });
  const [rootTypeState, setRootType] = useState<ObjectType | null>(null);
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const spec = JSON.stringify({ logic, root, range, params });

  const rootKey = root ? `${root.object_type_id}:${root.primary_key}` : "";
  const tsps = tspsState.key === rootKey ? tspsState.list : [];
  const rootType = rootTypeId && rootTypeState?.id === rootTypeId ? rootTypeState : null;
  useEffect(() => {
    if (!rootTypeId) return;
    ontology.objectType(rootTypeId).then(setRootType, () => setRootType(null));
  }, [rootTypeId]);
  useEffect(() => {
    if (!root) return;
    tsOntology.objectTsps(root.object_type_id, root.primary_key).then(
      (list) => setTsps({ key: `${root.object_type_id}:${root.primary_key}`, list }),
      () => setTsps({ key: "", list: [] }),
    );
  }, [root]);
  useEffect(() => {
    if (!logic.cards.length) {
      onResults?.(null);
      return;
    }
    const t = setTimeout(() => {
      const { start, end } = resolveRange(range);
      setBusy(true);
      tsOntology
        .query({ logic, root, start, end, params, resource, buckets: 400 })
        .then((r) => {
          setResults(r);
          setError(null);
          onResults?.(r);
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setBusy(false));
    }, 450);
    return () => clearTimeout(t);
    // the spec string holds every input of the query
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, resource]);

  const setCard = (id: string, patch: Partial<Card>) => onChange({ ...logic, cards: logic.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const setCfg = (id: string, cfg: Record<string, unknown>) => setCard(id, { config: { ...(logic.cards.find((c) => c.id === id)?.config ?? {}), ...cfg } });
  const remove = (id: string) => onChange({ ...logic, cards: logic.cards.filter((c) => c.id !== id), output: logic.output === id ? null : logic.output });
  const insert = (type: CardType, at: number) => {
    const info = cardInfo(type);
    const id = nextCardId(logic);
    const prevSeries = [...logic.cards.slice(0, at)].reverse().find((c) => !SCALAR_CARDS.includes(c.type) && !INTERVAL_CARDS.includes(c.type));
    const config: Record<string, unknown> = JSON.parse(JSON.stringify(info.config));
    if ("input" in config && prevSeries) config.input = prevSeries.id;
    if (type === "formula" && prevSeries) config.formula = `$${prevSeries.id}`;
    if (type === "search" && prevSeries) config.condition = `$${prevSeries.id} > 0`;
    if (type === "tsp") config.property = tsps.find((p) => p.default)?.key ?? tsps[0]?.key ?? "";
    if ((type === "combine" || type === "bounds") && logic.cards.length) config.inputs = logic.cards.filter((c) => !SCALAR_CARDS.includes(c.type) && !INTERVAL_CARDS.includes(c.type)).slice(-2).map((c) => c.id);
    const card: Card = { id, type, config };
    const cards = [...logic.cards.slice(0, at), card, ...logic.cards.slice(at)];
    const output = type === "search" && mode === "alerting" ? id : logic.output ?? (showOutput && !SCALAR_CARDS.includes(type) && !INTERVAL_CARDS.includes(type) ? id : logic.output);
    onChange({ ...logic, cards, output });
    setInsertAt(null);
    onCloseCardPicker?.();
  };
  const allowedSet = new Set(allowed ?? CARD_INFO.map((c) => c.type));
  const seriesIds = (except: string) => logic.cards.filter((c) => c.id !== except && !SCALAR_CARDS.includes(c.type) && !INTERVAL_CARDS.includes(c.type)).map((c) => c.id);
  const displayCards = visibleCardIds ? visibleCardIds.map((id) => logic.cards.find((c) => c.id === id)).filter((c): c is Card => Boolean(c)) : logic.cards;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel px-3 py-2">
        {mode !== "single" && rootTypeId && (
          <div className="flex min-w-64 items-center gap-2 text-xs">
            <span className="text-muted">{mode === "quiver" ? "Object" : "Preview root object"}</span>
            <div className="w-56">
              <ObjectPicker objectTypeId={rootTypeId} value={root?.primary_key ?? ""} onChange={(pk) => onRoot?.(pk ? { object_type_id: rootTypeId, primary_key: pk } : null)} />
            </div>
          </div>
        )}
        {onRange && <RangePicker value={range} onChange={onRange} />}
        <span className="ml-auto text-[11px] text-muted">
          {busy ? "Running…" : results && logic.cards.length ? `${results.points_scanned.toLocaleString()} points scanned · ${results.compute_seconds.toFixed(2)} compute-seconds` : ""}
        </span>
      </div>
      {mode !== "single" && rootTypeId && !root && (
        <p className="rounded-md border border-line bg-panel-2 px-3 py-2 text-xs text-muted">Pick a preview object to see the time series and choose its properties. It only illustrates the logic; it does not change what the logic runs on.</p>
      )}
      {error && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>}
      {displayCards.map((card) => {
        const logicIndex = logic.cards.findIndex((c) => c.id === card.id);
        return (
        <Fragment key={card.id}>
          {!readOnly && <InsertBar open={insertAt === logicIndex} onOpen={() => setInsertAt(insertAt === logicIndex ? null : logicIndex)} onPick={(t) => insert(t, logicIndex)} allowed={allowedSet} />}
          <CardView
            card={card}
            result={results?.cards[card.id]}
            output={logic.output === card.id}
            showOutput={showOutput && !SCALAR_CARDS.includes(card.type) && (mode !== "alerting" || card.type === "search")}
            onOutput={() => onChange({ ...logic, output: card.id })}
            onTitle={(title) => setCard(card.id, { title })}
            onRemove={() => remove(card.id)}
            readOnly={readOnly}
          >
            <CardConfig
              card={card}
              mode={mode}
              tsps={tsps}
              rootType={rootType}
              seriesIds={seriesIds(card.id)}
              cards={logic.cards}
              onCfg={(cfg) => setCfg(card.id, cfg)}
              readOnly={readOnly}
            />
          </CardView>
        </Fragment>
      ); })}
      {!readOnly && (
        <div className="relative" id="quiver-add-card">
          <button type="button" onClick={() => { onCloseCardPicker?.(); setInsertAt(insertAt === logic.cards.length ? null : logic.cards.length); }} className={`${buttonClass.secondary} w-full justify-center border-dashed`}>
            <Icon name="plus" className="h-4 w-4" /> {logic.cards.length ? "Add card" : "Add time series data"}
          </button>
          {(insertAt === logic.cards.length || openCardPicker) && <CardMenu allowed={allowedSet} onPick={(t) => insert(t, logic.cards.length)} />}
        </div>
      )}
    </div>
  );
}

function InsertBar({ open, onOpen, onPick, allowed }: { open: boolean; onOpen: () => void; onPick: (t: CardType) => void; allowed: Set<CardType> }) {
  return (
    <div className="group relative -my-1.5 flex h-3 items-center justify-center">
      <button type="button" onClick={onOpen} className="rounded-full border border-line-2 bg-panel px-2 text-[10px] text-muted opacity-0 hover:text-soft group-hover:opacity-100">
        Insert
      </button>
      {open && <CardMenu allowed={allowed} onPick={onPick} />}
    </div>
  );
}

function CardMenu({ allowed, onPick }: { allowed: Set<CardType>; onPick: (t: CardType) => void }) {
  const [q, setQ] = useState("");
  const groups: CardGroup[] = ["Data", "Combine", "Transform", "Search", "Parameter"];
  const shown = CARD_INFO.filter((c) => allowed.has(c.type) && `${c.label} ${c.description}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="absolute left-1/2 top-full z-30 mt-1 max-h-96 w-[34rem] -translate-x-1/2 overflow-y-auto rounded-xl border border-line-2 bg-panel p-2 shadow-2xl">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search cards…" className={`${inputClass} mb-2`} />
      {groups.map((g) => {
        const items = shown.filter((c) => c.group === g);
        if (!items.length) return null;
        return (
          <div key={g} className="mb-1">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{g}</div>
            <div className="grid grid-cols-2 gap-0.5">
              {items.map((c) => (
                <button key={c.type} type="button" onClick={() => onPick(c.type)} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-panel-2">
                  <Icon name={c.icon} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ocean" />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">{c.label}</span>
                    <span className="block text-[10px] leading-tight text-muted">{c.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CardView({
  card,
  result,
  output,
  showOutput,
  onOutput,
  onTitle,
  onRemove,
  readOnly,
  children,
}: {
  card: Card;
  result?: CardResult;
  output: boolean;
  showOutput: boolean;
  onOutput: () => void;
  onTitle: (t: string) => void;
  onRemove: () => void;
  readOnly?: boolean;
  children: React.ReactNode;
}) {
  const info = cardInfo(card.type);
  const [open, setOpen] = useState(true);
  return (
    <section id={`quiver-card-${card.id}`} data-quiver-card={card.id} className={`rounded-xl border bg-panel ${output ? "border-ocean/60 ring-1 ring-ocean/30" : "border-line"}`}>
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="rounded bg-ocean/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-ocean">${card.id}</span>
        <Icon name={info.icon} className="h-3.5 w-3.5 text-muted" />
        <span className="text-xs text-muted">{info.label}</span>
        <input
          value={card.title ?? ""}
          onChange={(e) => onTitle(e.target.value)}
          placeholder="Title"
          disabled={readOnly}
          className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-muted"
        />
        {showOutput &&
          (output ? (
            <span className="rounded-full bg-ocean/15 px-2 py-0.5 text-[10px] font-medium text-ocean">Output</span>
          ) : (
            !readOnly && (
              <button type="button" onClick={onOutput} className="text-[11px] text-muted hover:text-soft">
                Set as output
              </button>
            )
          ))}
        <button type="button" onClick={() => setOpen(!open)} className="rounded p-1 text-muted hover:text-soft" aria-label={open ? "Collapse" : "Expand"}>
          <Icon name={open ? "minus" : "plus"} className="h-3.5 w-3.5" />
        </button>
        {!readOnly && (
          <button type="button" onClick={onRemove} className="rounded p-1 text-muted hover:text-bad" aria-label="Remove card">
            <Icon name="trash" className="h-3.5 w-3.5" />
          </button>
        )}
      </header>
      {open && (
        <div className="grid gap-3 p-3 lg:grid-cols-[minmax(16rem,22rem)_1fr]">
          <div className="space-y-2">{children}</div>
          <CardPreview result={result} />
        </div>
      )}
    </section>
  );
}

function CardPreview({ result }: { result?: CardResult }) {
  if (!result) return <div className="flex h-36 items-center justify-center rounded-md border border-line bg-ink text-xs text-muted">No preview yet</div>;
  if (result.kind === "error") return <div className="rounded-md border border-bad/40 bg-bad/10 p-3 text-xs text-bad">{result.error}</div>;
  if (result.kind === "scalar")
    return (
      <div className="flex h-24 flex-col justify-center rounded-md border border-line bg-ink px-4">
        <div className="text-2xl font-semibold tabular-nums">{fmtValue(result.value)}</div>
        <div className="text-[11px] text-muted">{result.scalar_kind}</div>
      </div>
    );
  if (result.kind === "intervals")
    return (
      <div className="rounded-md border border-line bg-ink p-2">
        <div className="mb-1 text-xs text-soft">
          {result.count} interval{result.count === 1 ? "" : "s"} found{result.intervals.some((i) => i.ongoing) ? " · one ongoing" : ""}
        </div>
        <div className="max-h-36 overflow-y-auto text-[11px]">
          {result.intervals.slice(0, 50).map((iv, i) => (
            <div key={i} className="flex gap-2 border-t border-line py-0.5 tabular-nums">
              <span>{iv.start.slice(0, 19).replace("T", " ")}</span>→<span>{iv.end ? iv.end.slice(0, 19).replace("T", " ") : "ongoing"}</span>
              <span className="ml-auto text-muted">{Math.round(iv.duration_ms / 60000).toLocaleString()} min</span>
            </div>
          ))}
        </div>
      </div>
    );
  return (
    <div>
      <TsChart series={[{ key: "s", label: result.label, unit: result.unit, points: result.points, categorical: result.categorical }]} height={150} />
      <div className="mt-1 text-[11px] text-muted">
        {result.stats.points.toLocaleString()} points · {result.interpolation.toLowerCase()} interpolation
        {result.categorical ? " · categorical" : ` · min ${fmtValue(result.stats.min)} · mean ${fmtValue(result.stats.mean)} · max ${fmtValue(result.stats.max)}`}
        {result.unit ? ` ${result.unit}` : ""}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// card configuration
// ------------------------------------------------------------------------------------------------

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] text-muted">{label}</span>
      {children}
    </label>
  );
}

function Select({ value, onChange, options, disabled, placeholder }: { value: string; onChange: (v: string) => void; options: [string, string][]; disabled?: boolean; placeholder?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={`${inputClass} py-1 text-xs`}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

function Text({ value, onChange, placeholder, disabled, mono }: { value: unknown; onChange: (v: string) => void; placeholder?: string; disabled?: boolean; mono?: boolean }) {
  return (
    <input
      value={value === undefined || value === null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={`${inputClass} py-1 text-xs ${mono ? "font-mono" : ""}`}
    />
  );
}

const aggOptions: [string, string][] = AGGREGATIONS.map((a) => [a, a]);
const unitOptions: [string, string][] = [
  ["s", "per second"],
  ["m", "per minute"],
  ["h", "per hour"],
  ["d", "per day"],
];

function CardConfig({
  card,
  mode,
  tsps,
  rootType,
  seriesIds,
  cards,
  onCfg,
  readOnly,
}: {
  card: Card;
  mode: EditorMode;
  tsps: ObjectTsp[];
  rootType: ObjectType | null;
  seriesIds: string[];
  cards: Card[];
  onCfg: (cfg: Record<string, unknown>) => void;
  readOnly?: boolean;
}) {
  const c = card.config;
  const input = (key = "input", label = "Input") => (
    <L label={label}>
      <Select value={String(c[key] ?? "")} onChange={(v) => onCfg({ [key]: v })} options={seriesIds.map((id) => [id, `$${id} · ${cards.find((x) => x.id === id)?.title || cardInfo(cards.find((x) => x.id === id)!.type).label}`])} placeholder="Pick a series card…" disabled={readOnly} />
    </L>
  );
  const agg = (label = "Aggregation") => (
    <L label={label}>
      <Select value={String(c.aggregation ?? "mean")} onChange={(v) => onCfg({ aggregation: v })} options={aggOptions} disabled={readOnly} />
    </L>
  );
  const dur = (key: string, label: string, placeholder = "1h") => (
    <L label={label}>
      <Text value={c[key]} onChange={(v) => onCfg({ [key]: v })} placeholder={placeholder} disabled={readOnly} mono />
    </L>
  );
  const hint = (text: string) => <p className="text-[11px] leading-snug text-muted">{text}</p>;
  switch (card.type) {
    case "tsp":
      return <TspConfigForm card={card} mode={mode} tsps={tsps} onCfg={onCfg} readOnly={readOnly} />;
    case "series":
      return <SeriesConfig card={card} onCfg={onCfg} readOnly={readOnly} />;
    case "derived":
      return <DerivedConfig card={card} onCfg={onCfg} readOnly={readOnly} />;
    case "function":
      return <FunctionConfig card={card} onCfg={onCfg} readOnly={readOnly} />;
    case "formula":
      return (
        <>
          <L label="Formula">
            <Text value={c.formula} onChange={(v) => onCfg({ formula: v })} placeholder="$A - $B" disabled={readOnly} mono />
          </L>
          {hint(`Cards: ${cards.filter((x) => x.id !== card.id).map((x) => `$${x.id}`).join(" ") || "—"}. Operators + - * / % ** < > == != && || !; abs, min, max, sqrt, log, exp, round, if_else(c, a, b); @property reads the root object.`)}
        </>
      );
    case "filter":
      return (
        <>
          {input()}
          <div className="grid grid-cols-2 gap-2">
            <L label="Min value">
              <Text value={c.min} onChange={(v) => onCfg({ min: v === "" ? null : v })} disabled={readOnly} />
            </L>
            <L label="Max value">
              <Text value={c.max} onChange={(v) => onCfg({ max: v === "" ? null : v })} disabled={readOnly} />
            </L>
          </div>
          <L label="Keep categorical values (comma separated)">
            <Text value={Array.isArray(c.values) ? (c.values as string[]).join(", ") : ""} onChange={(v) => onCfg({ values: v.split(",").map((x) => x.trim()).filter(Boolean) })} disabled={readOnly} />
          </L>
          <div className="grid grid-cols-2 gap-2">
            <L label="From">
              <Text value={c.start} onChange={(v) => onCfg({ start: v })} placeholder="2025-01-01" disabled={readOnly} />
            </L>
            <L label="To">
              <Text value={c.end} onChange={(v) => onCfg({ end: v })} disabled={readOnly} />
            </L>
          </div>
        </>
      );
    case "derivative":
    case "integral":
      return (
        <>
          {input()}
          <L label="Unit">
            <Select value={String(c.unit ?? "s")} onChange={(v) => onCfg({ unit: v })} options={unitOptions} disabled={readOnly} />
          </L>
        </>
      );
    case "cumulative":
    case "aggregate":
      return (
        <>
          {input()}
          {agg()}
        </>
      );
    case "rolling":
      return (
        <>
          {input()}
          {agg()}
          {dur("window", "Window", "7d")}
        </>
      );
    case "periodic":
      return (
        <>
          {input()}
          {agg()}
          {dur("period", "Period (s, m, h, d, w, mo, y)", "1d")}
        </>
      );
    case "sample":
      return (
        <>
          {input()}
          {dur("every", "Every", "15m")}
        </>
      );
    case "shift":
      return (
        <>
          {input()}
          {dur("by", "Shift by (negative: earlier)", "-7d")}
        </>
      );
    case "relative":
      return (
        <>
          {input()}
          <L label="Mode">
            <Select value={String(c.mode ?? "time")} onChange={(v) => onCfg({ mode: v })} options={[["time", "Align the start in time (overlay)"], ["value", "Subtract the value at the start"]]} disabled={readOnly} />
          </L>
          <L label="Start (empty: the first point)">
            <Text value={c.reference} onChange={(v) => onCfg({ reference: v })} placeholder="2025-03-01T00:00" disabled={readOnly} />
          </L>
          {(c.mode ?? "time") === "time" && (
            <L label="Align to (empty: the range start)">
              <Text value={c.align_to} onChange={(v) => onCfg({ align_to: v })} disabled={readOnly} />
            </L>
          )}
        </>
      );
    case "combine":
    case "bounds":
      return (
        <>
          <L label="Series">
            <div className="flex flex-wrap gap-1">
              {seriesIds.map((id) => {
                const on = ((c.inputs as string[]) ?? []).includes(id);
                return (
                  <button
                    key={id}
                    type="button"
                    disabled={readOnly}
                    onClick={() => onCfg({ inputs: on ? ((c.inputs as string[]) ?? []).filter((x) => x !== id) : [...((c.inputs as string[]) ?? []), id] })}
                    className={`rounded px-1.5 py-0.5 font-mono text-xs ${on ? "bg-ocean/20 text-ocean ring-1 ring-ocean/40" : "bg-panel-2 text-muted"}`}
                  >
                    ${id}
                  </button>
                );
              })}
            </div>
          </L>
          {card.type === "bounds" && (
            <L label="Bound">
              <Select value={String(c.band ?? "upper")} onChange={(v) => onCfg({ band: v })} options={[["upper", "Upper"], ["lower", "Lower"]]} disabled={readOnly} />
            </L>
          )}
        </>
      );
    case "bollinger":
      return (
        <>
          {input()}
          {dur("window", "Window", "1d")}
          <div className="grid grid-cols-2 gap-2">
            <L label="Standard deviations (k)">
              <Text value={c.k} onChange={(v) => onCfg({ k: v })} disabled={readOnly} />
            </L>
            <L label="Band">
              <Select value={String(c.band ?? "upper")} onChange={(v) => onCfg({ band: v })} options={[["upper", "Upper"], ["middle", "Middle"], ["lower", "Lower"]]} disabled={readOnly} />
            </L>
          </div>
        </>
      );
    case "dsp":
      return (
        <>
          {input()}
          <L label="Filter">
            <Select
              value={String(c.filter ?? "moving_average")}
              onChange={(v) => onCfg({ filter: v })}
              options={[["moving_average", "Moving average"], ["ema", "Exponential smoothing"], ["lowpass", "Low-pass"], ["highpass", "High-pass"]]}
              disabled={readOnly}
            />
          </L>
          {c.filter === "ema" ? (
            <L label="Alpha (0–1)">
              <Text value={c.alpha} onChange={(v) => onCfg({ alpha: v })} disabled={readOnly} />
            </L>
          ) : (
            dur("window", "Window / time constant", "1h")
          )}
        </>
      );
    case "segment_stats":
      return (
        <>
          {input()}
          {agg()}
          <L label="Segments">
            <Select
              value={String(c.segments ?? "")}
              onChange={(v) => onCfg({ segments: v || null })}
              options={cards.filter((x) => INTERVAL_CARDS.includes(x.type)).map((x) => [x.id, `$${x.id} ${x.type === "search" ? "intervals" : "events"}`])}
              placeholder="Periods"
              disabled={readOnly}
            />
          </L>
          {!c.segments && dur("period", "Period", "1d")}
        </>
      );
    case "linked_agg":
      return (
        <>
          {agg()}
          <L label="Sensors whose name contains (empty: all)">
            <Text value={c.match} onChange={(v) => onCfg({ match: v })} disabled={readOnly} />
          </L>
          {hint(`Linked sensors of this object: ${tsps.filter((t) => t.source === "sensor").map((t) => t.label).join(", ") || "none"}`)}
        </>
      );
    case "event_set":
      return <EventSetForm c={c} onCfg={onCfg} readOnly={readOnly} />;
    case "event_ranges":
      return (
        <>
          {((c.ranges as { start: string; end: string; label?: string }[]) ?? []).map((r, i, all) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-1">
              <Text value={r.start} onChange={(v) => onCfg({ ranges: all.map((x, j) => (j === i ? { ...x, start: v } : x)) })} placeholder="start 2026-10-09 08:00" disabled={readOnly} mono />
              <Text value={r.end} onChange={(v) => onCfg({ ranges: all.map((x, j) => (j === i ? { ...x, end: v } : x)) })} placeholder="end" disabled={readOnly} mono />
              <Text value={r.label} onChange={(v) => onCfg({ ranges: all.map((x, j) => (j === i ? { ...x, label: v } : x)) })} placeholder="label" disabled={readOnly} />
              <button type="button" disabled={readOnly} onClick={() => onCfg({ ranges: all.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove range"><Icon name="x" className="h-3 w-3" /></button>
            </div>
          ))}
          <button type="button" disabled={readOnly} onClick={() => onCfg({ ranges: [...((c.ranges as unknown[]) ?? []), { start: "", end: "", label: "" }] })} className={buttonClass.ghost}>
            <Icon name="plus" className="h-3 w-3" /> Range
          </button>
        </>
      );
    case "vfunction":
      return <VFunctionForm c={c} cards={cards.filter((x) => x.id !== card.id)} onCfg={onCfg} readOnly={readOnly} />;
    case "event_shift":
    case "event_dedupe":
      return (
        <>
          <L label="Event set">
            <Select value={String(c.input ?? "")} onChange={(v) => onCfg({ input: v })} options={cards.filter((x) => x.id !== card.id && INTERVAL_CARDS.includes(x.type)).map((x) => [x.id, `$${x.id}`])} placeholder="Pick an event set…" disabled={readOnly} />
          </L>
          {card.type === "event_shift" && (
            <div className="grid grid-cols-2 gap-2">
              {dur("before", "Start earlier by", "")}
              {dur("after", "End later by", "")}
            </div>
          )}
        </>
      );
    case "search":
      return (
        <>
          <L label="Condition">
            <Text value={c.condition} onChange={(v) => onCfg({ condition: v })} placeholder="$C > 120" disabled={readOnly} mono />
          </L>
          {hint("Combine conditions in one formula with && and ||.")}
          <div className="grid grid-cols-2 gap-2">
            {dur("min_duration", mode === "alerting" ? "Min duration (streaming)" : "Min duration", "")}
            {mode !== "alerting" && dur("max_duration", "Max duration", "")}
          </div>
          {mode === "alerting" && (
            <L label="Custom recovery condition (streaming only)">
              <Text value={c.recovery} onChange={(v) => onCfg({ recovery: v || null })} placeholder="$C < 100" disabled={readOnly} mono />
            </L>
          )}
        </>
      );
    case "param_number":
    case "param_string":
    case "param_duration":
      return (
        <L label="Value">
          <Text value={c.value} onChange={(v) => onCfg({ value: card.type === "param_number" ? (v === "" ? "" : Number(v)) : v })} disabled={readOnly} mono={card.type === "param_duration"} />
        </L>
      );
    case "param_boolean":
      return (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!c.value} onChange={(e) => onCfg({ value: e.target.checked })} disabled={readOnly} /> True
        </label>
      );
    case "param_datetime":
      return (
        <L label="Date / time">
          <input type="datetime-local" value={String(c.value ?? "").slice(0, 16)} onChange={(e) => onCfg({ value: e.target.value ? new Date(e.target.value).toISOString() : "" })} className={`${fieldClass} w-full py-1 text-xs`} disabled={readOnly} />
        </L>
      );
    case "param_range":
      return (
        <div className="grid grid-cols-2 gap-2">
          <L label="Start">
            <input type="datetime-local" value={String(c.start ?? "").slice(0, 16)} onChange={(e) => onCfg({ start: e.target.value ? new Date(e.target.value).toISOString() : "" })} className={`${fieldClass} w-full py-1 text-xs`} disabled={readOnly} />
          </L>
          <L label="End">
            <input type="datetime-local" value={String(c.end ?? "").slice(0, 16)} onChange={(e) => onCfg({ end: e.target.value ? new Date(e.target.value).toISOString() : "" })} className={`${fieldClass} w-full py-1 text-xs`} disabled={readOnly} />
          </L>
        </div>
      );
    case "param_object_property":
      return (
        <L label="Property of the root object">
          <Select
            value={String(c.property ?? "")}
            onChange={(v) => onCfg({ property: v })}
            options={(rootType?.properties ?? []).filter((p) => p.type !== "timeseries").map((p) => [p.api_name, p.display_name])}
            placeholder="Pick a property…"
            disabled={readOnly}
          />
        </L>
      );
    case "shift_datetime":
      return (
        <>
          <L label="Date/time parameter">
            <Select value={String(c.datetime_card ?? "")} onChange={(v) => onCfg({ datetime_card: v || null })} options={cards.filter((x) => x.type === "param_datetime" || x.type === "param_range").map((x) => [x.id, `$${x.id}`])} placeholder="A fixed time…" disabled={readOnly} />
          </L>
          {!c.datetime_card && (
            <L label="Date/time">
              <Text value={c.datetime} onChange={(v) => onCfg({ datetime: v })} placeholder="2025-03-01T00:00" disabled={readOnly} />
            </L>
          )}
          {dur("by", "Shift by", "-7d")}
        </>
      );
  }
  return null;
}

/** A visual function card: the function, and each input from a card of this analysis ($A) or a value. */
function VFunctionForm({ c, cards, onCfg, readOnly }: { c: Record<string, unknown>; cards: Card[]; onCfg: (cfg: Record<string, unknown>) => void; readOnly?: boolean }) {
  const [fns, setFns] = useState<VisualFunction[]>([]);
  useEffect(() => {
    tsOntology.visualFunctions().then(setFns, () => setFns([]));
  }, []);
  const fn = fns.find((f) => f.id === c.function_id);
  const args = (c.arguments as Record<string, unknown>) ?? {};
  return (
    <>
      <L label="Function">
        <Select value={String(c.function_id ?? "")} onChange={(v) => onCfg({ function_id: v, arguments: {} })} options={fns.map((f) => [f.id, f.name])} placeholder="Pick a visual function…" disabled={readOnly} />
      </L>
      {fn?.description && <p className="text-[11px] text-muted">{fn.description}</p>}
      {fn?.inputs.map((inp) => (
        <L key={inp.card} label={`${inp.name} (${inp.type})`}>
          {inp.type.startsWith("param_") ? (
            <Text value={args[inp.card] as string} onChange={(v) => onCfg({ arguments: { ...args, [inp.card]: v } })} placeholder="the function's default, a value or $A" disabled={readOnly} mono />
          ) : (
            <Select value={String(args[inp.card] ?? "")} onChange={(v) => onCfg({ arguments: { ...args, [inp.card]: v } })} options={cards.map((x) => [`$${x.id}`, `$${x.id} ${x.title || x.type}`])} placeholder="The function's own card" disabled={readOnly} />
          )}
        </L>
      ))}
    </>
  );
}

/** Event set from objects: an object type, its start / end (and label) properties, optionally matched to the root. */
function EventSetForm({ c, onCfg, readOnly }: { c: Record<string, unknown>; onCfg: (cfg: Record<string, unknown>) => void; readOnly?: boolean }) {
  const [types, setTypes] = useState<ObjectType[]>([]);
  useEffect(() => {
    ontology.objectTypes().then(setTypes, () => setTypes([]));
  }, []);
  const t = types.find((x) => x.id === c.object_type_id);
  const props = (t?.properties ?? []).map((p) => [p.api_name, p.display_name] as [string, string]);
  const times = (t?.properties ?? []).filter((p) => ["date", "timestamp", "string"].includes(p.type)).map((p) => [p.api_name, p.display_name] as [string, string]);
  return (
    <>
      <L label="Object type">
        <Select value={String(c.object_type_id ?? "")} onChange={(v) => onCfg({ object_type_id: v, start_property: "", end_property: "" })} options={types.map((x) => [x.id, x.display_name])} placeholder="Pick the event object type…" disabled={readOnly} />
      </L>
      <div className="grid grid-cols-2 gap-2">
        <L label="Start"><Select value={String(c.start_property ?? "")} onChange={(v) => onCfg({ start_property: v })} options={times} placeholder="Start property…" disabled={readOnly} /></L>
        <L label="End (empty: a point in time)"><Select value={String(c.end_property ?? "")} onChange={(v) => onCfg({ end_property: v || null })} options={times} placeholder="No end" disabled={readOnly} /></L>
      </div>
      <L label="Label"><Select value={String(c.label_property ?? "")} onChange={(v) => onCfg({ label_property: v || null })} options={props} placeholder="Title" disabled={readOnly} /></L>
      <L label="Only events whose property equals the root object's key (e.g. sensor id)">
        <Select value={String(c.match_property ?? "")} onChange={(v) => onCfg({ match_property: v || null })} options={props} placeholder="All events" disabled={readOnly} />
      </L>
    </>
  );
}

function TspConfigForm({ card, mode, tsps, onCfg, readOnly }: { card: Card; mode: EditorMode; tsps: ObjectTsp[]; onCfg: (cfg: Record<string, unknown>) => void; readOnly?: boolean }) {
  const c = card.config;
  const obj = (c.object as ObjRef | undefined) ?? null;
  const [types, setTypes] = useState<{ id: string; display_name: string }[]>([]);
  const [ownState, setOwn] = useState<{ key: string; list: ObjectTsp[] } | null>(null);
  const named = mode === "single" || (mode === "quiver" && !!obj);
  useEffect(() => {
    if (mode !== "single" && mode !== "quiver") return;
    tsOntology.objectTypes().then(setTypes, () => setTypes([]));
  }, [mode]);
  const objKey = obj?.object_type_id && obj.primary_key ? `${obj.object_type_id}:${obj.primary_key}` : "";
  const own = objKey && ownState?.key === objKey ? ownState.list : null;
  useEffect(() => {
    if (!obj?.object_type_id || !obj.primary_key) return;
    const key = `${obj.object_type_id}:${obj.primary_key}`;
    tsOntology.objectTsps(obj.object_type_id, obj.primary_key).then((list) => setOwn({ key, list }), () => setOwn({ key, list: [] }));
  }, [obj?.object_type_id, obj?.primary_key]);
  const options = named ? own ?? [] : tsps;
  return (
    <>
      {(mode === "single" || mode === "quiver") && (
        <>
          {mode === "quiver" && (
            <label className="flex items-center gap-2 text-[11px] text-muted">
              <input type="checkbox" checked={!!obj} onChange={(e) => onCfg({ object: e.target.checked ? { object_type_id: types[0]?.id ?? "", primary_key: "" } : null })} disabled={readOnly} />
              Another object than the analysis object
            </label>
          )}
          {(mode === "single" || obj) && (
            <>
              <L label="Object type">
                <Select value={obj?.object_type_id ?? ""} onChange={(v) => onCfg({ object: { object_type_id: v, primary_key: "" } })} options={types.map((t) => [t.id, t.display_name])} placeholder="Pick a time series object type…" disabled={readOnly} />
              </L>
              {obj?.object_type_id && (
                <L label="Object">
                  <ObjectPicker objectTypeId={obj.object_type_id} value={obj.primary_key ?? ""} onChange={(pk) => onCfg({ object: { ...obj, primary_key: pk } })} />
                </L>
              )}
            </>
          )}
        </>
      )}
      <L label="Time series">
        <Select
          value={String(c.property ?? "")}
          onChange={(v) => onCfg({ property: v })}
          options={options.map((t) => [t.key, `${t.source === "sensor" ? "Sensor · " : ""}${t.label}${t.unit ? ` (${t.unit})` : ""}${t.default ? " · default" : ""}`])}
          placeholder={options.length ? "Pick a time series property…" : "Pick an object first"}
          disabled={readOnly}
        />
      </L>
      {!options.find((t) => t.key === c.property) && !!c.property && <p className="text-[11px] text-muted">{String(c.property)}</p>}
    </>
  );
}

function SeriesConfig({ card, onCfg, readOnly }: { card: Card; onCfg: (cfg: Record<string, unknown>) => void; readOnly?: boolean }) {
  const [syncs, setSyncs] = useState<SeriesSync[]>([]);
  useEffect(() => {
    timeseries.syncs("timeseries").then(setSyncs, () => setSyncs([]));
  }, []);
  return (
    <>
      <L label="Time series sync">
        <Select value={String(card.config.sync ?? "")} onChange={(v) => onCfg({ sync: v || null })} options={syncs.map((s) => [s.id, s.name])} placeholder="Any sync holding the series" disabled={readOnly} />
      </L>
      <L label="Series ID">
        <Text value={card.config.series_id} onChange={(v) => onCfg({ series_id: v })} disabled={readOnly} mono />
      </L>
    </>
  );
}

function DerivedConfig({ card, onCfg, readOnly }: { card: Card; onCfg: (cfg: Record<string, unknown>) => void; readOnly?: boolean }) {
  const [list, setList] = useState<DerivedSeries[]>([]);
  useEffect(() => {
    tsOntology.derivedList().then(setList, () => setList([]));
  }, []);
  const picked = list.find((d) => d.template_rid === card.config.template);
  return (
    <>
      <L label="Derived series">
        <Select value={String(card.config.template ?? "")} onChange={(v) => onCfg({ template: v })} options={list.map((d) => [d.template_rid, `${d.name} (${d.type})`])} placeholder="Pick a derived series…" disabled={readOnly} />
      </L>
      <L label="Version (empty: latest)">
        <Text value={card.config.version} onChange={(v) => onCfg({ version: v || null })} placeholder={picked?.version ?? "0.0.1"} disabled={readOnly} mono />
      </L>
    </>
  );
}

function FunctionConfig({ card, onCfg, readOnly }: { card: Card; onCfg: (cfg: Record<string, unknown>) => void; readOnly?: boolean }) {
  const c = card.config;
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [filesState, setFiles] = useState<{ repo: string; files: string[] }>({ repo: "", files: [] });
  const files = filesState.repo === String(c.repo_id ?? "") ? filesState.files : [];
  useEffect(() => {
    codeRepos.list().then(setRepos, () => setRepos([]));
  }, []);
  useEffect(() => {
    if (!c.repo_id) return;
    const repo = String(c.repo_id);
    codeRepos.get(repo).then((r) => setFiles({ repo, files: Object.keys(r.files).filter((f) => f.endsWith(".py")) }), () => setFiles({ repo, files: [] }));
  }, [c.repo_id]);
  const params = useMemo(() => JSON.stringify(c.parameters ?? {}), [c.parameters]);
  return (
    <>
      <L label="Code repository">
        <Select value={String(c.repo_id ?? "")} onChange={(v) => onCfg({ repo_id: v, file: "" })} options={repos.map((r) => [r.id, r.name])} placeholder="Pick a repository…" disabled={readOnly} />
      </L>
      <L label="File">
        <Select value={String(c.file ?? "")} onChange={(v) => onCfg({ file: v })} options={files.map((f) => [f, f])} placeholder="Pick a Python file…" disabled={readOnly} />
      </L>
      <div className="grid grid-cols-2 gap-2">
        <L label="Function">
          <Text value={c.function} onChange={(v) => onCfg({ function: v })} placeholder="performance_forecast" disabled={readOnly} mono />
        </L>
        <L label="Object parameter">
          <Text value={c.object_param} onChange={(v) => onCfg({ object_param: v })} placeholder="machine" disabled={readOnly} mono />
        </L>
      </div>
      <L label="Other parameters (JSON; &quot;$P&quot; reads a parameter card)">
        <input
          defaultValue={params}
          onChange={(e) => {
            try {
              onCfg({ parameters: JSON.parse(e.target.value || "{}") });
            } catch {}
          }}
          className={`${inputClass} py-1 font-mono text-xs`}
          disabled={readOnly}
        />
      </L>
      <p className="text-[11px] text-muted">Runs the default branch&apos;s last commit; results are cached for 10 minutes. The function returns TimeSeries.serialize(df) or a DataFrame of timestamp / value.</p>
    </>
  );
}
