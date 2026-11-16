"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type EmbeddingModel, type VectorConfig, type VectorIndex, type VectorMetric } from "@/lib/api";

const NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

const METRICS: { id: VectorMetric; label: string; note: string }[] = [
  { id: "cosine", label: "Cosine", note: "Angle between vectors. The standard choice for text embeddings." },
  { id: "euclidean", label: "Euclidean", note: "Straight-line distance between vectors (L2)." },
];

/** Whether a model can produce `dim` dimensions: one of its offered sizes, or inside its range. */
export function modelFits(m: EmbeddingModel, dim: number): boolean {
  return m.dimensions.includes(dim) || (!!m.range && dim >= m.range[0] && dim <= m.range[1]);
}

export function CreateIndexDialog({
  config,
  taken,
  onClose,
  onCreated,
}: {
  config: VectorConfig;
  taken: string[];
  onClose: () => void;
  onCreated: (index: VectorIndex) => void;
}) {
  const initial = config.models.find((m) => m.id === config.default_model) ?? config.models[0];
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState(initial.id);
  const [dimension, setDimension] = useState(initial.dimension);
  const [metric, setMetric] = useState<VectorMetric>("cosine");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const model = config.models.find((m) => m.id === modelId) ?? initial;
  const nameError = !name
    ? null
    : !NAME.test(name) || name.includes("..")
      ? "3–63 characters: lowercase letters, numbers, hyphens and dots; starts and ends with a letter or number."
      : taken.includes(name)
        ? "An index with this name already exists."
        : null;
  const dimError = !modelFits(model, dimension)
    ? model.range
      ? `${model.label} supports ${model.range[0]}–${model.range[1]} dimensions.`
      : `${model.label} produces ${model.dimensions.join(" or ")} dimensions.`
    : null;

  const pickModel = (m: EmbeddingModel) => {
    setModelId(m.id);
    setDimension(m.dimension);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.vectors.createIndex({ name, model: model.id, dimension, metric }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Create vector index" icon="database" onClose={onClose} wide>
      <div className="space-y-5 p-4">
        <div>
          <Label>Index name</Label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[\s_]/g, "-"))}
            placeholder="e.g. tafsir-bge-m3"
            className={`${inputClass} font-mono`}
          />
          {nameError ? (
            <p className="mt-1 text-xs text-bad">{nameError}</p>
          ) : (
            <p className="mt-1 text-xs text-muted">
              Created in vector bucket <span className="font-mono text-soft">{config.bucket}</span>. The name, dimension
              and metric can&apos;t be changed later.
            </p>
          )}
        </div>

        <div>
          <Label>Embedding model</Label>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {config.models.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => pickModel(m)}
                className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                  m.id === modelId ? "border-ocean bg-ocean/10" : "border-line-2 bg-panel-2 hover:border-line-2 hover:bg-panel-2/60"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{m.label}</span>
                  {m.id === config.default_model && (
                    <span className="rounded bg-sand/15 px-1.5 py-px text-[10px] font-medium text-sand">Default</span>
                  )}
                  <span className="ml-auto font-mono text-[11px] text-muted">{m.dimension}d</span>
                </div>
                <div className="mt-0.5 font-mono text-[10.5px] text-muted">{m.id}</div>
                <div className="mt-1 text-xs text-soft">{m.note}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <Label>Dimension</Label>
            <div className="flex flex-wrap gap-1.5">
              {model.dimensions.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDimension(d)}
                  className={`rounded-md border px-2.5 py-1 font-mono text-xs ${
                    d === dimension ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-soft hover:text-white"
                  }`}
                >
                  {d}
                  {d === model.dimension && <span className="ml-1 text-[10px] text-muted">native</span>}
                </button>
              ))}
            </div>
            {model.range ? (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  min={model.range[0]}
                  max={Math.min(model.range[1], config.max_dimension)}
                  value={dimension}
                  onChange={(e) => setDimension(Math.round(Number(e.target.value)) || 0)}
                  className={`${fieldClass} w-28 font-mono`}
                />
                <span className="text-xs text-muted">
                  custom, {model.range[0]}–{model.range[1]}
                </span>
              </div>
            ) : (
              model.dimensions.length === 1 && <p className="mt-2 text-xs text-muted">This model has a fixed size.</p>
            )}
            {dimError && <p className="mt-1 text-xs text-bad">{dimError}</p>}
            {!dimError && dimension !== model.dimension && (
              <p className="mt-1 text-xs text-muted">
                Shortened (Matryoshka) vectors: smaller and faster, slightly less accurate.
              </p>
            )}
          </div>

          <div>
            <Label>Distance metric</Label>
            <div className="space-y-1.5">
              {METRICS.map((m) => (
                <label
                  key={m.id}
                  className={`flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2 ${
                    metric === m.id ? "border-ocean bg-ocean/10" : "border-line-2 bg-panel-2"
                  }`}
                >
                  <input
                    type="radio"
                    name="metric"
                    checked={metric === m.id}
                    onChange={() => setMetric(m.id)}
                    className="mt-0.5 accent-ocean"
                  />
                  <span>
                    <span className="block text-sm font-medium">{m.label}</span>
                    <span className="block text-xs text-soft">{m.note}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-soft">
            <Icon name="alert" className="h-4 w-4 shrink-0 text-bad" />
            {error}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        <span className="font-mono text-xs text-muted">
          {model.id} · {dimension}d · {metric}
        </span>
        <button type="button" onClick={onClose} className={`${buttonClass.secondary} ml-auto`}>
          Cancel
        </button>
        <button
          type="button"
          onClick={create}
          disabled={busy || !name || !!nameError || !!dimError}
          className={buttonClass.primary}
        >
          <Icon name="plus" className="h-4 w-4" />
          {busy ? "Creating…" : "Create index"}
        </button>
      </div>
    </Modal>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-xs font-medium text-soft">{children}</div>;
}
