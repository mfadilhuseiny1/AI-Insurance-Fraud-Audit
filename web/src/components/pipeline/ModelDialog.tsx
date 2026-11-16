"use client";

import { useState } from "react";
import { driveContentUrl, uploadDriveFile } from "@/lib/api";
import { trainModel, type TrainSpec } from "@/lib/models";
import { uid, type ModelNode, type NodeResult, type TrainedModel } from "@/lib/pipeline";
import { DrivePicker } from "../DrivePicker";
import { Icon } from "../Icon";
import { ColumnMultiSelect } from "./ColumnMultiSelect";
import { buttonClass, inputClass, Modal } from "./Modal";
import { Field, Tabs } from "./ui";

const ALGOS: { id: TrainSpec["algorithm"]; label: string; hint: string }[] = [
  { id: "linear", label: "Linear regression", hint: "Predicts a number from the features." },
  { id: "logistic", label: "Logistic regression", hint: "Predicts one of two classes, with a probability." },
  { id: "kmeans", label: "K-means clustering", hint: "Assigns each row to one of k clusters." },
];

/** Trained model node: train a model on the input (Train model), import one, or register a REST model; then map its features. */
export function ModelDialog({
  node,
  input,
  inputName,
  onSave,
  onClose,
}: {
  node?: ModelNode;
  input: NodeResult;
  inputName: string;
  onSave: (patch: { name: string; model: TrainedModel; features: string[]; output: string }) => void;
  onClose: () => void;
}) {
  const t = input.table;
  const columns = t?.columns ?? [];
  const [tab, setTab] = useState<"train" | "import" | "rest">(node?.model.algorithm === "rest" ? "rest" : node ? "import" : "train");
  const [model, setModel] = useState<TrainedModel | null>(node?.model ?? null);
  const [features, setFeatures] = useState<string[]>(node?.features ?? []);
  const [output, setOutput] = useState(node?.output ?? "prediction");
  const [name, setName] = useState(node?.name ?? "Model inference");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  // training
  const [spec, setSpec] = useState<TrainSpec>({ name: "My model", algorithm: "linear", features: [], target: "", k: 3 });
  // REST
  const [rest, setRest] = useState({ url: "", features: "", headers: "" });

  const applyModel = (m: TrainedModel) => {
    setModel(m);
    setFeatures(m.features.map((f) => (columns.some((c) => c.name === f.name) ? f.name : "")));
    setError(null);
  };

  return (
    <Modal title={node ? `Trained model — ${node.name}` : `Trained model after "${inputName}"`} icon="cpu" onClose={onClose} wide>
      <div className="space-y-3 p-4">
        <p className="text-xs text-muted">
          Runs model inference over every row (one tabular input and output). Models run in isolation from the rest of the pipeline; faster and external pipelines do not support
          them.
        </p>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "train", label: "Train a model" },
            { id: "import", label: "Import a model" },
            { id: "rest", label: "Registered (REST)" },
          ]}
        />
        {tab === "train" && (
          <div className="space-y-2 rounded-md border border-line-2 p-3">
            <div className="grid grid-cols-3 gap-1.5">
              {ALGOS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSpec({ ...spec, algorithm: a.id })}
                  className={`rounded-md border p-2 text-left text-xs ${spec.algorithm === a.id ? "border-ocean bg-ocean/10" : "border-line-2 hover:border-ocean/50"}`}
                >
                  <span className="block font-medium text-white">{a.label}</span>
                  <span className="block text-muted">{a.hint}</span>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Model name">
                <input value={spec.name} onChange={(e) => setSpec({ ...spec, name: e.target.value })} className={inputClass} />
              </Field>
              {spec.algorithm === "kmeans" ? (
                <Field label="Clusters (k)">
                  <input type="number" min={1} max={50} value={spec.k ?? 3} onChange={(e) => setSpec({ ...spec, k: Number(e.target.value) })} className={inputClass} />
                </Field>
              ) : (
                <Field label="Target column">
                  <select value={spec.target ?? ""} onChange={(e) => setSpec({ ...spec, target: e.target.value })} className={inputClass}>
                    <option value="">Choose…</option>
                    {columns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name} · {c.type}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            <Field label="Feature columns" hint="Text and boolean columns are one-hot encoded (up to 50 categories).">
              <ColumnMultiSelect value={spec.features} columns={columns.filter((c) => c.name !== spec.target)} onChange={(f) => setSpec({ ...spec, features: f })} placeholder="Columns…" />
            </Field>
            <button
              type="button"
              disabled={!t}
              onClick={() => {
                try {
                  if (!t) return;
                  applyModel(trainModel(t, spec));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
              className={buttonClass.primary}
            >
              <Icon name="cpu" className="h-3.5 w-3.5" /> Train on {t ? `${t.rows.length.toLocaleString()} rows` : "the input"}
            </button>
            <p className="text-xs text-muted">Previews may read a sample of the input; train on the full data by turning sampling off for the input first.</p>
          </div>
        )}
        {tab === "import" && (
          <div className="space-y-2 rounded-md border border-line-2 p-3 text-xs">
            <p className="text-muted">A model JSON saved from a pipeline (.model.json), or coefficients you trained elsewhere in the same format.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setPicking(true)} className={buttonClass.secondary}>
                <Icon name="folder" className="h-3.5 w-3.5" /> From Files
              </button>
              <label className={`${buttonClass.secondary} cursor-pointer`}>
                <Icon name="upload" className="h-3.5 w-3.5" /> Upload JSON
                <input
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    try {
                      applyModel(validate(JSON.parse(await f.text())));
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                />
              </label>
            </div>
            {picking && (
              <DrivePicker
                title="Import a model"
                canPick={(item) => (/\.json$/i.test(item.name) ? null : "Choose a .model.json file")}
                onPick={async (item) => {
                  setPicking(false);
                  try {
                    const res = await fetch(driveContentUrl(item.id));
                    applyModel({ ...validate(await res.json()), itemId: item.id });
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
                onClose={() => setPicking(false)}
              />
            )}
          </div>
        )}
        {tab === "rest" && (
          <div className="space-y-2 rounded-md border border-line-2 p-3">
            <Field label="Endpoint URL" hint={'Receives POST {"features": {name: value}} for each row and answers JSON (its "prediction" field, or the whole body).'}>
              <input value={rest.url} onChange={(e) => setRest({ ...rest, url: e.target.value })} placeholder="https://models.example.com/predict" className={inputClass} />
            </Field>
            <Field label="Feature names" hint="Comma separated, in order.">
              <input value={rest.features} onChange={(e) => setRest({ ...rest, features: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Headers" hint="One per line: Name: value (e.g. an Authorization header).">
              <textarea value={rest.headers} onChange={(e) => setRest({ ...rest, headers: e.target.value })} rows={2} className={`${inputClass} font-mono text-xs`} />
            </Field>
            <button
              type="button"
              disabled={!/^https?:\/\//.test(rest.url) || !rest.features.trim()}
              onClick={() =>
                applyModel({
                  id: uid(),
                  name: new URL(rest.url).hostname,
                  createdAt: new Date().toISOString(),
                  algorithm: "rest",
                  url: rest.url,
                  headers: Object.fromEntries(rest.headers.split("\n").map((l) => l.split(":").map((x) => x.trim())).filter((p) => p[0] && p[1]) as [string, string][]),
                  features: rest.features.split(",").map((x) => ({ name: x.trim(), type: "numeric" as const })).filter((x) => x.name),
                })
              }
              className={buttonClass.primary}
            >
              Register
            </button>
          </div>
        )}
        {error && <p className="text-sm text-bad">{error}</p>}
        {model && (
          <div className="space-y-2 rounded-md border border-ocean/50 bg-ocean/5 p-3 text-xs">
            <div className="flex items-center gap-2">
              <Icon name="cpu" className="h-4 w-4 text-ocean" />
              <span className="font-medium text-white">{model.name}</span>
              <span className="text-muted">{model.algorithm}</span>
              {model.metrics && (
                <span className="text-ok">
                  {Object.entries(model.metrics)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(" · ")}
                </span>
              )}
              <button
                type="button"
                onClick={async () => {
                  const file = new File([JSON.stringify(model, null, 1)], `${model.name.replace(/[^\w.-]+/g, "_")}.model.json`, { type: "application/json" });
                  try {
                    const item = await uploadDriveFile(file, null, () => {});
                    setSaved(item.name);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
                className="ml-auto text-ocean hover:underline"
              >
                Save model to Files
              </button>
            </div>
            {saved && <p className="text-ok">Saved {saved} to Files &amp; Projects — import it in other pipelines.</p>}
            <div className="text-muted">Map each model feature to an input column</div>
            {model.features.map((f, i) => (
              <label key={f.name + i} className="flex items-center gap-2">
                <span className="w-40 truncate font-mono">
                  {f.name} <span className="text-muted">({f.type})</span>
                </span>
                <select
                  value={features[i] ?? ""}
                  onChange={(e) => {
                    const next = [...features];
                    next[i] = e.target.value;
                    setFeatures(next);
                  }}
                  className={`${inputClass} py-1 text-xs`}
                >
                  <option value="">Choose…</option>
                  {columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name} · {c.type}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <div className="grid grid-cols-2 gap-3 pt-1">
              <Field label="Node name">
                <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
              </Field>
              <Field label="Prediction column">
                <input value={output} onChange={(e) => setOutput(e.target.value)} className={inputClass} />
              </Field>
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!model || features.length !== model.features.length || features.some((f) => !f) || !output.trim()}
            onClick={() => model && onSave({ name: name.trim() || "Model inference", model, features, output: output.trim() })}
            className={buttonClass.primary}
          >
            {node ? "Save" : "Add model node"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function validate(raw: unknown): TrainedModel {
  const m = raw as TrainedModel;
  if (!m || typeof m !== "object" || !Array.isArray(m.features) || !["linear", "logistic", "kmeans", "rest"].includes((m as { algorithm: string }).algorithm))
    throw new Error("Not a model file: it needs an algorithm (linear, logistic, kmeans or rest) and features");
  return { ...m, id: m.id ?? uid(), name: m.name ?? "Imported model", createdAt: m.createdAt ?? new Date().toISOString() };
}
