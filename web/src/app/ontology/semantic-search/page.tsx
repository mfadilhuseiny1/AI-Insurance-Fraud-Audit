"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, Card, ErrorBox, ValueCell } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { mediaUrl, ontology, request, type ObjectType, type OntologyObject } from "@/lib/ontology";

type Mode = "semantic" | "keyword" | "hybrid";
type Config = {
  models: { id: string; label: string; dimension: number; note?: string }[];
  default_model: string;
  object_types: { id: string; display_name: string; vector_properties: { api_name: string; display_name: string; dimension: number; model: string; source: string | null }[]; text_properties: string[] }[];
  max_k: number;
};
type Result = OntologyObject & { relevance: number; ranks?: Record<string, { rank: number; score: number }> };
type SearchOut = { query: { semantic: string; keyword: string; hypothetical?: string; enriched?: string; extracted?: string }; mode: Mode; searched: number | null; results: Result[]; timings: { prepare_ms: number; total_ms: number } };

const api = {
  config: () => request<Config>("/semantic/config"),
  search: (body: Record<string, unknown>) => request<SearchOut>("/semantic/search", { method: "POST", json: body }),
  embed: (typeId: string, body: Record<string, unknown>) => request<{ embedded: number; objects: number; vector_property: string }>(`/object-types/${typeId}/embed`, { method: "POST", json: body }),
  chunkSetup: (body: Record<string, unknown>) => request<{ object_type: { id: string; display_name: string }; chunks: number }>("/semantic/chunk-setup", { method: "POST", json: body }),
  chunkPreview: (body: Record<string, unknown>) => request<{ chunks: string[]; count: number }>("/semantic/chunk-preview", { method: "POST", json: body }),
};

/**
 * Semantic search over the Ontology: a playground (KNN on vector properties, BM25 keyword ranking, hybrid with RRF,
 * HyDE and query augmentation, each method's rank) with the selected object beside the results, and the setup
 * (embed a text property, chunk a long text property into a chunk object type).
 */
export default function SemanticSearchPage() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"playground" | "setup">("playground");
  const reload = () =>
    Promise.all([api.config(), ontology.objectTypes()]).then(
      ([c, t]) => {
        setCfg(c);
        setTypes(t);
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    void reload();
  }, []);
  if (error && !cfg) return <ApiError message={error} />;
  if (!cfg) return <Loading />;
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Semantic Search" icon="sparkle" href="/ontology/semantic-search">
        <div className="flex gap-1 rounded border border-line-2 bg-panel-2 p-1">
          {(["playground", "setup"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={`rounded px-3 py-1 text-xs capitalize ${tab === t ? "bg-ocean text-white" : "text-muted"}`}>
              {t}
            </button>
          ))}
        </div>
      </AppHeader>
      {tab === "playground" ? <Playground cfg={cfg} types={types} /> : <Setup cfg={cfg} types={types} onChanged={reload} />}
    </div>
  );
}

function Playground({ cfg, types }: { cfg: Config; types: ObjectType[] }) {
  const [typeId, setTypeId] = useState(cfg.object_types[0]?.id ?? types[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>(cfg.object_types.length ? "hybrid" : "keyword");
  const [k, setK] = useState(10);
  const [rrf, setRrf] = useState(60);
  const [hyde, setHyde] = useState(false);
  const [exact, setExact] = useState(false);
  const [aug, setAug] = useState<"none" | "enrich" | "extract">("none");
  const [vecProp, setVecProp] = useState("");
  const [res, setRes] = useState<SearchOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Result | null>(null);
  const t = types.find((x) => x.id === typeId);
  const vecs = cfg.object_types.find((x) => x.id === typeId)?.vector_properties ?? [];
  const run = async () => {
    if (!query.trim() || !typeId) return;
    setBusy(true);
    try {
      const r = await api.search({ object_type_id: typeId, query, mode: vecs.length ? mode : "keyword", k, rrf_k: rrf, hyde, augmentation: aug, vector_property: vecProp || null, exact, resource: "semantic-search" });
      setRes(r);
      setPicked(r.results[0] ?? null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const shown = useMemo(() => (t?.properties ?? []).filter((p) => p.type !== "vector" && p.visibility !== "hidden"), [t]);
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-72 shrink-0 space-y-3 overflow-y-auto border-r border-line bg-panel p-4 text-xs">
        <label className="block">
          <span className="text-muted">Object type</span>
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={`${inputClass} mt-1`}>
            {types.map((x) => (
              <option key={x.id} value={x.id}>
                {x.display_name}
                {cfg.object_types.some((v) => v.id === x.id) ? " · vectors" : ""}
              </option>
            ))}
          </select>
        </label>
        <div>
          <span className="text-muted">Retrieval</span>
          <div className="mt-1 flex gap-1 rounded border border-line-2 bg-panel-2 p-1">
            {(["semantic", "keyword", "hybrid"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                disabled={m !== "keyword" && !vecs.length}
                onClick={() => setMode(m)}
                className={`flex-1 rounded px-2 py-1 capitalize ${mode === m || (!vecs.length && m === "keyword") ? "bg-ocean text-white" : "text-muted disabled:opacity-40"}`}
              >
                {m}
              </button>
            ))}
          </div>
          {!vecs.length && <div className="mt-1 text-muted">No vector property: keyword (BM25) only. Embed one in Setup.</div>}
        </div>
        {vecs.length > 0 && mode !== "keyword" && (
          <label className="block">
            <span className="text-muted">Vector property</span>
            <select value={vecProp} onChange={(e) => setVecProp(e.target.value)} className={`${inputClass} mt-1`}>
              <option value="">Default ({vecs[0].display_name})</option>
              {vecs.map((v) => (
                <option key={v.api_name} value={v.api_name}>
                  {v.display_name} · {v.model}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="text-muted">Results (k)</span>
          <input type="number" min={1} max={cfg.max_k} value={k} onChange={(e) => setK(Number(e.target.value) || 10)} className={`${inputClass} mt-1`} />
        </label>
        {mode === "hybrid" && (
          <label className="block">
            <span className="text-muted">RRF k</span>
            <input type="number" min={1} max={1000} value={rrf} onChange={(e) => setRrf(Number(e.target.value) || 60)} className={`${inputClass} mt-1`} />
          </label>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={hyde} disabled={mode === "keyword"} onChange={(e) => setHyde(e.target.checked)} /> HyDE (embed a hypothetical answer)
        </label>
        <label className="flex items-start gap-2" title="Object types of 5,000+ objects search an approximate (ANN) index, calibrated to 97% recall@10">
          <input type="checkbox" className="mt-0.5" checked={exact} disabled={mode === "keyword" || !vecs.length} onChange={(e) => setExact(e.target.checked)} />
          <span>
            Exact KNN
            <span className="block text-muted">Compare the query with every vector instead of the approximate index used for 5,000+ objects (slower, never misses a neighbor).</span>
          </span>
        </label>
        <label className="block">
          <span className="text-muted">Query augmentation</span>
          <select value={aug} onChange={(e) => setAug(e.target.value as typeof aug)} className={`${inputClass} mt-1`}>
            <option value="none">None</option>
            <option value="enrich">Enrich (synonyms, for keyword search)</option>
            <option value="extract">Extract the core ask (for semantic search)</option>
          </select>
        </label>
        <p className="text-muted">HyDE and augmentation call a language model; KNN embeds the query with the vector property&apos;s model.</p>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink p-5">
        <div className="flex gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void run()} placeholder="Ask in your own words…" className={`${inputClass} flex-1`} />
          <button type="button" onClick={run} disabled={busy || !query.trim()} className={buttonClass.primary}>
            <Icon name="search" className="h-3.5 w-3.5" /> {busy ? "Searching…" : "Search"}
          </button>
        </div>
        <ErrorBox message={error} />
        {res && (
          <div className="mt-3 text-xs text-muted">
            {res.results.length} of {res.searched ?? "the visible"} objects · {res.mode} · {res.timings.total_ms} ms
            {res.query.hypothetical && <div className="mt-1 rounded border border-line bg-panel p-2 text-soft">HyDE passage: {res.query.hypothetical}</div>}
            {res.query.enriched && <div className="mt-1 rounded border border-line bg-panel p-2 text-soft">Enriched keyword query: {res.query.enriched}</div>}
            {res.query.extracted && <div className="mt-1 rounded border border-line bg-panel p-2 text-soft">Extracted ask: {res.query.extracted}</div>}
          </div>
        )}
        <div className="mt-3 grid gap-4 xl:grid-cols-[1fr_380px]">
          <div className="space-y-2">
            {(res?.results ?? []).map((r, i) => (
              <button
                key={r.primary_key}
                type="button"
                onClick={() => setPicked(r)}
                className={`w-full rounded-lg border p-3 text-left text-xs ${picked?.primary_key === r.primary_key ? "border-ocean bg-ocean/5" : "border-line bg-panel hover:bg-panel-2"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-muted">#{i + 1}</span>
                  <span className="font-medium text-ocean">{r.title}</span>
                  <span className="ml-auto rounded-full bg-ok/10 px-2 py-0.5 text-ok">{r.relevance.toFixed(4)}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-soft">
                  {shown
                    .map((p) => r.properties[p.api_name])
                    .filter((v) => typeof v === "string" && v.length > 30)
                    .slice(0, 1)
                    .join(" ") || shown.slice(0, 4).map((p) => `${p.display_name}: ${String(r.properties[p.api_name] ?? "—")}`).join(" · ")}
                </div>
                {r.ranks && Object.keys(r.ranks).length > 0 && (
                  <div className="mt-1 flex gap-3 text-[10px] text-muted">
                    {Object.entries(r.ranks).map(([m, v]) => (
                      <span key={m}>
                        {m}: rank {v.rank} ({v.score})
                      </span>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
          {picked && t && (
            <Card title={picked.title} action={<Link href={`/ontology/objects/${t.id}/${encodeURIComponent(picked.primary_key)}`} className="text-xs font-normal text-ocean">Object View</Link>}>
              <div className="max-h-[70vh] space-y-2 overflow-y-auto p-4 text-xs">
                {t.properties
                  .filter((p) => p.type === "media" && picked.properties[p.api_name])
                  .map((p) => (
                    <iframe key={p.api_name} title={p.display_name} src={mediaUrl(String(picked.properties[p.api_name]))} className="h-72 w-full rounded border border-line bg-white" />
                  ))}
                {shown.map((p) => (
                  <div key={p.api_name}>
                    <div className="text-muted">{p.display_name}</div>
                    <div className="whitespace-pre-wrap">
                      <ValueCell type={p.type} value={picked.properties[p.api_name]} large />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </main>
    </div>
  );
}

function Setup({ cfg, types, onChanged }: { cfg: Config; types: ObjectType[]; onChanged: () => void }) {
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const t = types.find((x) => x.id === typeId);
  const texts = (t?.properties ?? []).filter((p) => p.type === "string");
  const [source, setSource] = useState("");
  const [model, setModel] = useState(cfg.default_model);
  const [size, setSize] = useState(500);
  const [overlap, setOverlap] = useState(50);
  const [seps, setSeps] = useState("\\n\\n | \\n | .  |  ");
  const [sample, setSample] = useState("");
  const [preview, setPreview] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const src = source || texts[0]?.api_name || "";
  const separators = seps.split("|").map((s) => s.trim().replace(/\\n/g, "\n") || (s.includes(" ") ? " " : ""));
  const go = async (label: string, fn: () => Promise<string>) => {
    setBusy(true);
    try {
      setMsg(await fn());
      setError(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      void label;
    }
  };
  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
      <div className="mx-auto max-w-5xl space-y-4 p-6 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={fieldClass} aria-label="Object type">
            {types.map((x) => (
              <option key={x.id} value={x.id}>
                {x.display_name}
              </option>
            ))}
          </select>
          <select value={src} onChange={(e) => setSource(e.target.value)} className={fieldClass} aria-label="Text property">
            {texts.map((p) => (
              <option key={p.api_name} value={p.api_name}>
                {p.display_name}
              </option>
            ))}
          </select>
          <select value={model} onChange={(e) => setModel(e.target.value)} className={fieldClass} aria-label="Embedding model">
            {cfg.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.dimension})
              </option>
            ))}
          </select>
        </div>
        <ErrorBox message={error} />
        {msg && <div className="rounded-md bg-ok/10 px-3 py-2 text-ok">{msg}</div>}
        <Card title="Embed a text property">
          <div className="space-y-2 p-4">
            <p className="text-muted">Creates (or fills) the vector property &quot;{src}Embedding&quot; with the chosen model; only objects whose text changed are embedded again. Calls the embedding model.</p>
            <button
              type="button"
              disabled={busy || !src}
              onClick={() => go("embed", async () => {
                const r = await api.embed(typeId, { source_property: src, model });
                return `Embedded ${r.embedded} objects into ${r.vector_property}.`;
              })}
              className={buttonClass.primary}
            >
              <Icon name="sparkle" className="h-3.5 w-3.5" /> Embed objects
            </button>
          </div>
        </Card>
        <Card title="Chunk a long text property">
          <div className="space-y-2 p-4">
            <p className="text-muted">A chunk object type linked back to each object: the text split recursively on the separators (in priority order) with a size and overlap, then embedded.</p>
            <div className="flex flex-wrap items-center gap-2">
              <span>Chunk size</span>
              <input type="number" value={size} onChange={(e) => setSize(Number(e.target.value) || 500)} className={`${fieldClass} w-24`} />
              <span>Overlap</span>
              <input type="number" value={overlap} onChange={(e) => setOverlap(Number(e.target.value) || 0)} className={`${fieldClass} w-20`} />
              <span>Separators</span>
              <input value={seps} onChange={(e) => setSeps(e.target.value)} className={`${fieldClass} w-48 font-mono`} />
            </div>
            <textarea value={sample} onChange={(e) => setSample(e.target.value)} rows={4} placeholder="Paste sample text to preview the chunks" className={inputClass} />
            <div className="flex gap-2">
              <button type="button" disabled={!sample} onClick={() => api.chunkPreview({ text: sample, chunk_size: size, overlap, separators }).then((r) => setPreview(r.chunks), (e: Error) => setError(e.message))} className={buttonClass.secondary}>
                Preview chunks
              </button>
              <button
                type="button"
                disabled={busy || !src}
                onClick={() => go("chunk", async () => {
                  const r = await api.chunkSetup({ object_type_id: typeId, text_property: src, chunk_size: size, overlap, separators, model });
                  return `Created ${r.chunks} chunks in ${r.object_type.display_name}.`;
                })}
                className={buttonClass.primary}
              >
                Create chunk object type
              </button>
            </div>
            {preview && (
              <div className="space-y-1">
                {preview.map((c, i) => (
                  <div key={i} className="rounded border border-line bg-panel p-2 font-mono">
                    <span className="text-muted">#{i + 1} · {c.length} chars · </span>
                    {c}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </main>
  );
}
