"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import {
  api,
  DEFAULT_EMBED_OPTIONS,
  type EmbedOptions,
  type EmbedPreview,
  type Job,
  type VectorConfig,
  type VectorIndex,
  type VectorIngest,
  type VectorSettings,
} from "@/lib/api";
import { usd } from "@/lib/format";
import { CreateIndexDialog } from "./CreateIndexDialog";

const nf = (n: number) => n.toLocaleString();
const TAG_KEY = /^[a-z][a-z0-9_]{0,39}$/;
// set by the API on every vector (vectors.BASE_METADATA_KEYS)
const RESERVED = ["job_id", "file_id", "file_name", "tier", "chunk_index", "page_start", "page_end", "language", "text"];
const SUGGESTED_TAGS = ["tenant", "department", "access_level", "doc_type", "project", "confidentiality"];
const MAX_TAGS = 10;
const REMEMBER = "bluesandai.embed.last"; // last index and options, per browser

type Tag = { key: string; value: string };

function remembered(): { index?: string; options?: EmbedOptions } {
  try {
    return JSON.parse(localStorage.getItem(REMEMBER) ?? "{}");
  } catch {
    return {};
  }
}

function tagError(tags: Tag[]): string | null {
  const keys = new Set<string>();
  for (const { key, value } of tags) {
    if (!key && !value) continue;
    if (!TAG_KEY.test(key)) return `Tag "${key}": lowercase letters, numbers and _, starting with a letter.`;
    if (RESERVED.includes(key)) return `Tag "${key}" is set automatically; choose another name.`;
    if (keys.has(key)) return `Tag "${key}" is used twice.`;
    if (!value.trim() || value.length > 100) return `Tag "${key}": the value must be 1–100 characters.`;
    keys.add(key);
  }
  return null;
}

/**
 * Embed parse results into a vector index, from the Parse tab: pick (or create) the index, then
 * how the documents become vectors (chunking, contextual headers, filtering, metadata tags, what
 * to do with documents already in the index). A dry run shows the result before anything is spent.
 */
export function EmbedDocumentsDialog({
  jobs,
  ingests,
  initialIndex,
  onClose,
  onStarted,
}: {
  jobs: Job[];
  ingests: VectorIngest[];
  /** preselect this index (opened from an index in Vector Storage) */
  initialIndex?: string;
  onClose: () => void;
  onStarted: (index: string, rows: VectorIngest[]) => void;
}) {
  const [config, setConfig] = useState<VectorConfig | null>(null);
  const [indexes, setIndexes] = useState<VectorIndex[] | null>(null);
  const [indexName, setIndexName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [options, setOptions] = useState<EmbedOptions>(() => ({ ...DEFAULT_EMBED_OPTIONS, ...remembered().options, metadata: {} }));
  const [tags, setTags] = useState<Tag[]>(() =>
    Object.entries(remembered().options?.metadata ?? {}).map(([key, value]) => ({ key, value })),
  );
  const [preview, setPreview] = useState<EmbedPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // settings of the chosen index, and the index auto-embed is ticked for (each resets with the index)
  const [loaded, setLoaded] = useState<{ index: string; settings: VectorSettings } | null>(null);
  const [autoEmbedFor, setAutoEmbedFor] = useState<string | null>(null);

  const loadIndexes = (select?: string) =>
    api.vectors
      .indexes()
      .then((list) => {
        setIndexes(list);
        const usable = list.filter((i) => i.model);
        const want = select ?? initialIndex ?? remembered().index;
        setIndexName((cur) => cur ?? (usable.find((i) => i.name === want) ?? usable[0])?.name ?? null);
        if (select) setIndexName(select);
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    api.vectors
      .config()
      .then((c) => {
        setConfig(c);
        if (!c.problem) loadIndexes();
      })
      .catch((e: Error) => setError(e.message));
    // once, when the window opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (indexName)
      api.vectors
        .settings(indexName)
        .then((s) => setLoaded({ index: indexName, settings: s }))
        .catch(() => {});
  }, [indexName]);

  const index = indexes?.find((i) => i.name === indexName) ?? null;
  const settings = loaded && loaded.index === indexName ? loaded.settings : null;
  const autoEmbed = !!indexName && autoEmbedFor === indexName;
  const model = config?.models.find((m) => m.id === index?.model) ?? null;
  const storesText = !!index?.non_filterable_keys.includes("text");
  const metadata = useMemo(() => Object.fromEntries(tags.filter((t) => t.key).map((t) => [t.key, t.value.trim()])), [tags]);
  const run: EmbedOptions = { ...options, chunking: storesText ? options.chunking : "parsed", metadata };
  const tagsInvalid = tagError(tags);
  const chunkingInvalid =
    run.chunking === "custom" && (run.overlap >= run.max_chars || run.combine_under >= run.max_chars)
      ? "The overlap and the merge threshold must be smaller than the chunk size."
      : null;
  // ~3 characters a token is a safe floor for Arabic and Indonesian
  const contextWarning =
    model && run.chunking === "custom" && run.max_chars / 3 > model.context
      ? `${model.label} reads ${nf(model.context)} tokens; chunks of ${nf(run.max_chars)} characters may be cut off.`
      : null;

  const parseChunks = jobs.reduce((n, j) => n + (j.chunks ?? 0), 0);
  const already = useMemo(
    () => new Set(ingests.filter((i) => i.index_name === indexName && i.status === "completed").map((i) => i.job_id)),
    [ingests, indexName],
  );
  const alreadyCount = jobs.filter((j) => already.has(j.id)).length;
  const toEmbed = run.on_existing === "skip" ? jobs.length - alreadyCount : jobs.length;

  const set = <K extends keyof EmbedOptions>(k: K, v: EmbedOptions[K]) => {
    setOptions((o) => ({ ...o, [k]: v }));
    setPreview(null);
  };
  const setTag = (i: number, t: Partial<Tag>) => {
    setTags((all) => all.map((x, n) => (n === i ? { ...x, ...t } : x)));
    setPreview(null);
  };

  const dryRun = async () => {
    setPreviewing(true);
    setError(null);
    try {
      setPreview(await api.vectors.preview(jobs.map((j) => j.id), run, index?.model));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const start = async () => {
    if (!index) return;
    setBusy(true);
    setError(null);
    try {
      const rows = await api.vectors.ingest(index.name, jobs.map((j) => j.id), run);
      if (autoEmbed) await api.vectors.updateSettings(index.name, { auto_embed: true, auto_embed_options: run });
      try {
        localStorage.setItem(REMEMBER, JSON.stringify({ index: index.name, options: run }));
      } catch {}
      onStarted(index.name, rows);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (creating && config) {
    return (
      <CreateIndexDialog
        config={config}
        taken={(indexes ?? []).map((i) => i.name)}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          setCreating(false);
          loadIndexes(created.name);
        }}
      />
    );
  }

  const title = jobs.length === 1 ? `Embed ${jobs[0].file_name}` : `Embed ${jobs.length} documents`;

  return (
    <Modal title={title} icon="sparkle" onClose={onClose} wide>
      <div className="space-y-5 p-4">
        {config?.problem && (
          <div className="flex items-start gap-2 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-soft">
            <Icon name="alert" className="h-4 w-4 shrink-0 text-bad" />
            Vector storage is not available: {config.problem}
          </div>
        )}

        {/* ---------------------------------------------------------- index */}
        <Section
          n={1}
          title="Target index"
          aside={
            <button type="button" onClick={() => setCreating(true)} disabled={!config || !!config.problem} className={buttonClass.ghost}>
              <Icon name="plus" className="h-3.5 w-3.5" /> New index
            </button>
          }
        >
          {!indexes && !config?.problem && <p className="text-sm text-muted">Loading indexes…</p>}
          {indexes && !indexes.length && (
            <div className="rounded-lg border border-dashed border-line-2 p-4 text-center text-sm text-muted">
              No vector indexes yet.{" "}
              <button type="button" onClick={() => setCreating(true)} className="text-ocean hover:underline">
                Create one
              </button>{" "}
              to choose its embedding model, dimension and distance metric.
            </div>
          )}
          <div className="grid gap-1.5 sm:grid-cols-2">
            {indexes?.map((i) => {
              const m = config?.models.find((x) => x.id === i.model);
              const inIt = jobs.filter((j) => ingests.some((g) => g.index_name === i.name && g.job_id === j.id && g.status === "completed")).length;
              return (
                <button
                  key={i.name}
                  type="button"
                  disabled={!i.model}
                  onClick={() => {
                    setIndexName(i.name);
                    setPreview(null);
                  }}
                  title={i.model ? undefined : "This index has no embedding model yet: choose one in Vector Storage"}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    i.name === indexName ? "border-ocean bg-ocean/10" : "border-line-2 bg-panel-2 hover:border-ocean/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm">{i.name}</span>
                    {inIt > 0 && (
                      <span className="shrink-0 rounded bg-ok/15 px-1.5 py-px text-[10px] text-ok">
                        has {inIt}/{jobs.length}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-soft">{m?.label ?? i.model ?? "no model"}</div>
                  <div className="mt-1 flex flex-wrap gap-1 font-mono text-[10.5px] text-muted">
                    <span>{i.dimension}d</span>·<span>{i.metric}</span>·<span>{i.documents ?? 0} docs</span>
                    {!i.non_filterable_keys.includes("text") && <span className="text-sand">· no stored text</span>}
                  </div>
                </button>
              );
            })}
          </div>
          {index && model && (
            <p className="mt-2 text-xs text-muted">
              {model.label} · {model.multilingual ? "multilingual" : "English"} · reads up to {nf(model.context)} tokens per chunk. The model,
              dimension and metric are fixed by the index; vectors from different models can&apos;t share one.
              {model.price_per_mtok != null && ` ${usd(model.price_per_mtok)} per million tokens.`}
            </p>
          )}
          {index && settings && (
            <p className="mt-1 text-xs text-muted">
              Spent on this index: <span className="text-soft">{usd(settings.spent_usd)}</span>
              {settings.budget_usd != null ? (
                <>
                  {" "}
                  of a <span className="text-soft">{usd(settings.budget_usd)}</span> limit
                  {settings.spent_usd >= settings.budget_usd && <span className="text-bad"> · limit reached, raise it in Vector Storage → Settings</span>}
                </>
              ) : (
                " · no spending limit"
              )}
            </p>
          )}
        </Section>

        {/* ---------------------------------------------------------- chunking */}
        <Section n={2} title="Chunking">
          <div className="grid gap-1.5 sm:grid-cols-2">
            <Choice
              checked={run.chunking === "parsed"}
              onChange={() => set("chunking", "parsed")}
              title="Parse chunks"
              note={`The chunks shown in the result viewer (${nf(parseChunks)} in total), split at headings or by topic.`}
            />
            <Choice
              checked={run.chunking === "custom"}
              onChange={() => set("chunking", "custom")}
              disabled={!!index && !storesText}
              title="Re-chunk"
              note={
                index && !storesText
                  ? "Needs an index that stores chunk text (any index created in this app)."
                  : "Split the parsed elements again at your own size, with overlap between chunks."
              }
            />
          </div>
          {run.chunking === "custom" && (
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <NumberField label="Chunk size" unit="chars" value={run.max_chars} min={200} max={8000} step={100} onChange={(v) => set("max_chars", v)} />
              <NumberField label="Overlap" unit="chars" value={run.overlap} min={0} max={2000} step={50} onChange={(v) => set("overlap", v)} />
              <NumberField
                label="Merge sections under"
                unit="chars"
                value={run.combine_under}
                min={0}
                max={4000}
                step={50}
                onChange={(v) => set("combine_under", v)}
              />
            </div>
          )}
          {(chunkingInvalid || contextWarning) && <p className={`mt-2 text-xs ${chunkingInvalid ? "text-bad" : "text-sand"}`}>{chunkingInvalid ?? contextWarning}</p>}
        </Section>

        {/* ---------------------------------------------------------- quality */}
        <Section n={3} title="Enrichment and filtering">
          <div className="space-y-2">
            <Check
              checked={run.context_header}
              onChange={(v) => set("context_header", v)}
              title="Contextual header"
              note="Embed “Document: <name> · pages a–b” ahead of each chunk, so chunks that only make sense in context still match. The stored text stays the chunk itself."
            />
            <Check
              checked={run.dedupe}
              onChange={(v) => set("dedupe", v)}
              title="Skip repeated chunks"
              note="Leave out chunks whose text already came earlier in the same document (disclaimers, repeated boilerplate)."
            />
            <label
              className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                run.min_chars > 0 ? "border-ocean bg-ocean/10" : "border-line-2 bg-panel-2"
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">Minimum chunk length</span>
                <span className="block text-xs text-soft">
                  Leave out page debris and lone headings that only add noise to search. 0 keeps every chunk.
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  max={4000}
                  step={10}
                  value={run.min_chars}
                  onChange={(e) => set("min_chars", Math.max(0, Math.round(Number(e.target.value)) || 0))}
                  className={`${fieldClass} w-20 text-right font-mono`}
                />
                <span className="text-xs text-muted">chars</span>
              </span>
            </label>
          </div>
        </Section>

        {/* ---------------------------------------------------------- metadata */}
        <Section n={4} title="Metadata tags">
          <p className="mb-2 text-xs text-soft">
            Filterable on every vector of this run, for multi-tenant isolation and access control at query time (Vector Storage →
            Search → filter). Every vector already carries <span className="font-mono text-muted">job_id, file_name, tier, pages, language</span>.
          </p>
          <div className="space-y-1.5">
            {tags.map((t, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  value={t.key}
                  onChange={(e) => setTag(i, { key: e.target.value.toLowerCase().replace(/[\s-]/g, "_") })}
                  placeholder="key"
                  className={`${fieldClass} w-44 font-mono`}
                />
                <span className="text-muted">=</span>
                <input value={t.value} onChange={(e) => setTag(i, { value: e.target.value })} placeholder="value" className={inputClass} />
                <button
                  type="button"
                  onClick={() => {
                    setTags((all) => all.filter((_, n) => n !== i));
                    setPreview(null);
                  }}
                  className="rounded p-1.5 text-muted hover:bg-bad/10 hover:text-bad"
                  title="Remove tag"
                >
                  <Icon name="x" className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={tags.length >= MAX_TAGS}
              onClick={() => setTags((all) => [...all, { key: "", value: "" }])}
              className={buttonClass.ghost}
            >
              <Icon name="plus" className="h-3.5 w-3.5" /> Add tag
            </button>
            {SUGGESTED_TAGS.filter((k) => !tags.some((t) => t.key === k)).map((k) => (
              <button
                key={k}
                type="button"
                disabled={tags.length >= MAX_TAGS}
                onClick={() => setTags((all) => [...all, { key: k, value: "" }])}
                className="rounded-full border border-line-2 px-2 py-0.5 font-mono text-[11px] text-muted hover:border-ocean hover:text-ocean disabled:opacity-40"
              >
                + {k}
              </button>
            ))}
          </div>
          {tagsInvalid && <p className="mt-2 text-xs text-bad">{tagsInvalid}</p>}
        </Section>

        {/* ---------------------------------------------------------- existing */}
        <Section n={5} title="Documents already in the index">
          <div className="grid gap-1.5 sm:grid-cols-2">
            <Choice
              checked={run.on_existing === "replace"}
              onChange={() => set("on_existing", "replace")}
              title="Replace"
              note="Embed again with these settings; the document's old vectors are overwritten or removed."
            />
            <Choice
              checked={run.on_existing === "skip"}
              onChange={() => set("on_existing", "skip")}
              title="Skip"
              note="Only embed documents the index doesn't have yet. Safe for re-running a batch."
            />
          </div>
          {index && alreadyCount > 0 && (
            <p className="mt-2 text-xs text-muted">
              {alreadyCount} of {jobs.length} selected {alreadyCount === 1 ? "is" : "are"} already in {index.name}.
            </p>
          )}
        </Section>

        {/* ---------------------------------------------------------- automation */}
        <Section n={6} title="Automation">
          <Check
            checked={autoEmbed}
            onChange={(v) => setAutoEmbedFor(v ? indexName : null)}
            title={`Auto-embed future parses${index ? ` into ${index.name}` : ""}`}
            note={
              settings?.auto_embed
                ? "Auto-embed is already on for this index. Tick to replace its saved settings with these; it can be turned off or limited to some tiers in Vector Storage → Settings."
                : "Off unless you tick it: every document parsed from now on is embedded into this index with these settings. Turn it off or limit it to some tiers in Vector Storage → Settings."
            }
          />
        </Section>

        {/* ---------------------------------------------------------- dry run */}
        <Section
          n={7}
          title="Dry run"
          aside={
            <button type="button" onClick={dryRun} disabled={previewing || !!tagsInvalid || !!chunkingInvalid} className={buttonClass.secondary}>
              <Icon name="search" className="h-3.5 w-3.5" />
              {previewing ? "Preparing…" : preview ? "Run again" : "Preview"}
            </button>
          }
        >
          {!preview ? (
            <p className="text-xs text-muted">
              See how many vectors these settings produce, what gets left out, what it will cost, and the first chunks exactly as they will
              be embedded. Nothing is spent.
            </p>
          ) : (
            <PreviewResult preview={preview} jobs={jobs} settings={settings} />
          )}
        </Section>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-soft">
            <Icon name="alert" className="h-4 w-4 shrink-0 text-bad" />
            {error}
          </div>
        )}
      </div>

      <div className="sticky bottom-0 flex items-center gap-2 border-t border-line bg-panel px-4 py-3">
        <span className="min-w-0 truncate font-mono text-xs text-muted">
          {index ? `${index.name} · ${index.model} · ${index.dimension}d · ${index.metric}` : "Choose an index"}
        </span>
        <button type="button" onClick={onClose} className={`${buttonClass.secondary} ml-auto`}>
          Cancel
        </button>
        <button
          type="button"
          onClick={start}
          disabled={busy || !index?.model || !toEmbed || !!tagsInvalid || !!chunkingInvalid}
          className={buttonClass.primary}
        >
          <Icon name="play" className="h-3.5 w-3.5" />
          {busy ? "Starting…" : toEmbed === jobs.length ? (jobs.length === 1 ? "Embed" : `Embed ${jobs.length}`) : `Embed ${toEmbed} new`}
        </button>
      </div>
    </Modal>
  );
}

function PreviewResult({ preview, jobs, settings }: { preview: EmbedPreview; jobs: Job[]; settings: VectorSettings | null }) {
  const t = preview.totals;
  const left = t.empty + t.short + t.duplicate;
  const remaining = settings?.budget_usd != null ? settings.budget_usd - settings.spent_usd : null;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="Vectors" value={nf(t.vectors)} sub={`from ${nf(t.chunks)} chunks`} />
        <Stat
          label="Left out"
          value={nf(left)}
          sub={left ? [t.short && `${t.short} short`, t.duplicate && `${t.duplicate} repeated`, t.empty && `${t.empty} empty`].filter(Boolean).join(" · ") : "none"}
        />
        <Stat label="Tokens to embed" value={`≤${nf(t.tokens)}`} sub={`${nf(t.chars)} characters`} />
        <Stat label="Longest chunk" value={nf(t.longest)} sub="characters" />
        <Stat
          label="Estimated cost"
          value={preview.cost_usd == null ? "–" : usd(preview.cost_usd)}
          sub={preview.price_per_mtok == null ? "price unknown" : `${usd(preview.price_per_mtok)} / M tokens`}
        />
      </div>
      {remaining != null && preview.cost_usd != null && preview.cost_usd > remaining && (
        <p className="flex items-center gap-1.5 text-xs text-bad">
          <Icon name="alert" className="h-3.5 w-3.5" />
          Over the index&apos;s spending limit: {usd(Math.max(0, remaining))} left of {usd(settings?.budget_usd)}. The run will be refused.
        </p>
      )}
      {t.over_context > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-sand">
          <Icon name="alert" className="h-3.5 w-3.5" />
          {t.over_context} chunk{t.over_context === 1 ? "" : "s"} may be longer than the model reads ({nf(preview.model_context ?? 0)} tokens); the end would be
          ignored. Use a smaller chunk size.
        </p>
      )}
      {preview.per_job.length > 1 && (
        <div className="max-h-32 overflow-y-auto rounded-lg border border-line text-xs">
          {preview.per_job.map((p) => (
            <div key={p.job_id} className="flex gap-2 border-b border-line px-2.5 py-1 last:border-0">
              <span className="min-w-0 flex-1 truncate">{jobs.find((j) => j.id === p.job_id)?.file_name ?? p.job_id}</span>
              <span className="tabular-nums text-soft">{nf(p.vectors)} vectors</span>
              <span className="w-24 text-right tabular-nums text-muted">≈{nf(p.tokens)} tok</span>
            </div>
          ))}
        </div>
      )}
      {preview.samples.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] text-muted">First chunks of {jobs.find((j) => preview.samples[0].key.startsWith(j.id))?.file_name}, as embedded</div>
          <div className="space-y-1.5">
            {preview.samples.map((s) => (
              <div key={s.key} className="rounded-lg border border-line bg-ink">
                <div className="flex gap-2 border-b border-line px-2.5 py-1 font-mono text-[10.5px] text-muted">
                  <span>{s.key}</span>
                  {s.pages.length > 0 && <span>· p. {s.pages[0] === s.pages[s.pages.length - 1] ? s.pages[0] : `${s.pages[0]}–${s.pages[s.pages.length - 1]}`}</span>}
                  <span className="ml-auto">{nf(s.chars)} chars</span>
                </div>
                <pre dir="auto" className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words px-2.5 py-1.5 font-sans text-xs text-soft">
                  {s.embed_text}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ small */

function Section({ n, title, aside, children }: { n: number; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-panel-2 text-[11px] text-soft ring-1 ring-line-2">{n}</span>
        <span className="text-sm font-medium">{title}</span>
        {aside && <span className="ml-auto">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Choice({
  checked,
  onChange,
  title,
  note,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  note: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex gap-2.5 rounded-lg border px-3 py-2 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${
        checked ? "border-ocean bg-ocean/10" : "border-line-2 bg-panel-2"
      }`}
    >
      <input type="radio" checked={checked} onChange={onChange} disabled={disabled} className="mt-0.5 accent-ocean" />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-soft">{note}</span>
      </span>
    </label>
  );
}

function Check({ checked, onChange, title, note }: { checked: boolean; onChange: (v: boolean) => void; title: string; note: string }) {
  return (
    <label className={`flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2 ${checked ? "border-ocean bg-ocean/10" : "border-line-2 bg-panel-2"}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-ocean" />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-soft">{note}</span>
      </span>
    </label>
  );
}

function NumberField({
  label,
  unit,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-soft">{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Math.round(Number(e.target.value)) || 0)}
          onBlur={() => onChange(Math.min(max, Math.max(min, value)))}
          className={`${inputClass} font-mono`}
        />
        <span className="text-xs text-muted">{unit}</span>
      </span>
    </label>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
      <div className="truncate text-[10.5px] text-muted" title={sub}>
        {sub}
      </div>
    </div>
  );
}
