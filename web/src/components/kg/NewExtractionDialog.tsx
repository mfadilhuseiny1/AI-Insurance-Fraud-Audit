"use client";

import { useEffect, useMemo, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type DriveItem, type Job } from "@/lib/api";
import { when } from "@/lib/format";
import { kg, type Extraction, type NewExtraction } from "@/lib/kg";
import { ModelPicker, useKgModels } from "./parts";

const TEXT_FILE = /\.(json|md|txt)$/i;

/**
 * Start extractions: one per chosen parse job (several at once), or one for a JSON / Markdown /
 * text file from the Files tab.
 */
export function NewExtractionDialog({
  extractions,
  onClose,
  onCreated,
}: {
  extractions: Extraction[];
  onClose: () => void;
  onCreated: (created: Extraction[]) => void;
}) {
  const models = useKgModels();
  const [sourceType, setSourceType] = useState<"job" | "drive">("job");
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [jobFilter, setJobFilter] = useState("");
  const [file, setFile] = useState<DriveItem | null>(null);
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [schemaFrom, setSchemaFrom] = useState("");
  const [instructions, setInstructions] = useState("");
  const [dedupe, setDedupe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .jobs()
      .then((all) => setJobs(all.filter((j) => j.status === "completed")))
      .catch((e: Error) => setError(e.message));
  }, []);

  const chosenModel = model || models?.find((m) => m.default && m.available)?.id || models?.find((m) => m.available)?.id || "";
  const finished = extractions.filter((e) => e.status === "completed");
  const shownJobs = useMemo(() => {
    const q = jobFilter.trim().toLowerCase();
    return (jobs ?? []).filter((j) => !q || j.file_name.toLowerCase().includes(q));
  }, [jobs, jobFilter]);

  const sources: NewExtraction["source"][] =
    sourceType === "job" ? jobIds.map((id) => ({ type: "job", id })) : file ? [{ type: "drive", id: file.id }] : [];

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created: Extraction[] = [];
      for (const source of sources) {
        created.push(
          await kg.createExtraction({
            source,
            model: chosenModel,
            name: sources.length === 1 ? name.trim() || undefined : undefined,
            instructions: instructions.trim() || undefined,
            schema_from: schemaFrom || null,
            dedupe,
          }),
        );
      }
      onCreated(created);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const toggleJob = (id: string) => setJobIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  return (
    <>
      {!picking && (
      <Modal title="New extraction" icon="extract" onClose={onClose} wide>
        <div className="space-y-5 p-4">
          {/* source */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-soft">Parsed document</span>
              <div className="flex rounded-md border border-line-2 p-0.5 text-xs">
                {(
                  [
                    ["job", "Parse history"],
                    ["drive", "From Files"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSourceType(id)}
                    className={`rounded px-2.5 py-1 ${sourceType === id ? "bg-ocean/20 text-white" : "text-muted hover:text-white"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {sourceType === "job" ? (
              <div className="rounded-lg border border-line-2">
                <div className="border-b border-line p-2">
                  <input
                    value={jobFilter}
                    onChange={(e) => setJobFilter(e.target.value)}
                    placeholder="Filter completed parse jobs…"
                    className={inputClass}
                  />
                </div>
                <div className="max-h-56 overflow-y-auto">
                  {jobs === null && <div className="p-3 text-xs text-muted">Loading…</div>}
                  {jobs?.length === 0 && <div className="p-3 text-xs text-muted">No completed parse jobs yet.</div>}
                  {shownJobs.map((j) => (
                    <label key={j.id} className="flex cursor-pointer items-center gap-2.5 border-t border-line px-3 py-2 text-sm first:border-t-0 hover:bg-panel-2">
                      <input type="checkbox" checked={jobIds.includes(j.id)} onChange={() => toggleJob(j.id)} className="accent-ocean" />
                      <Icon name="doc" className="h-4 w-4 shrink-0 text-ocean" />
                      <span className="min-w-0 flex-1 truncate">{j.file_name}</span>
                      <span className="shrink-0 text-xs text-muted">
                        {j.pages_total} p · {j.tier_label} · {when(j.created_at)}
                      </span>
                    </label>
                  ))}
                </div>
                {jobIds.length > 1 && (
                  <div className="border-t border-line px-3 py-1.5 text-xs text-muted">
                    {jobIds.length} documents: one extraction each.
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setPicking(true)}
                className="flex w-full items-center gap-2.5 rounded-lg border border-dashed border-line-2 px-3 py-3 text-left text-sm hover:border-ocean/60"
              >
                <Icon name="folder" className="h-4 w-4 text-ocean" />
                {file ? <span className="truncate">{file.name}</span> : <span className="text-muted">Choose a parse-result JSON (or any JSON, .md, .txt) from Files…</span>}
              </button>
            )}
          </div>

          <p className="-mt-3 flex items-center gap-1.5 text-xs text-muted">
            <Icon name="info" className="h-3.5 w-3.5 shrink-0" />
            JSON is converted to Markdown first (headings, lists and tables kept, page furniture dropped), the way parse
            results are; the model reads the Markdown.
          </p>

          {sources.length <= 1 && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-soft">Name (optional)</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the document name" className={inputClass} />
            </label>
          )}

          <div>
            <span className="mb-1.5 block text-xs font-medium text-soft">Model</span>
            {models ? <ModelPicker models={models} value={chosenModel} onChange={setModel} /> : <div className="text-xs text-muted">Loading…</div>}
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium text-soft">Nexus</span>
            <select value={schemaFrom} onChange={(e) => setSchemaFrom(e.target.value)} className={inputClass}>
              <option value="">Design a new ontology for this document</option>
              {finished.map((e) => (
                <option key={e.id} value={e.id}>
                  Reuse the ontology of “{e.name}” ({e.stats?.classes} classes, {e.stats?.properties} properties)
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted">
              Documents extracted with the same ontology merge cleanly into one knowledge graph.
            </p>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-soft">Instructions (optional)</span>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={3}
              placeholder="e.g. Focus on legal rulings, the evidence they cite and who issued them. Use Indonesian class names."
              className={inputClass}
            />
          </label>

          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} className="mt-0.5 accent-ocean" />
            <span>
              AI de-duplication
              <span className="block text-xs text-muted">
                After extracting, the model merges entities that are the same thing under different spellings, abbreviations
                or transliterations.
              </span>
            </span>
          </label>

          {error && <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={buttonClass.secondary}>
              Cancel
            </button>
            <button type="button" disabled={busy || !sources.length || !chosenModel} onClick={submit} className={buttonClass.primary}>
              <Icon name="play" className="h-3.5 w-3.5" />
              {busy ? "Starting…" : sources.length > 1 ? `Extract ${sources.length} documents` : "Start extraction"}
            </button>
          </div>
        </div>
      </Modal>
      )}
      {picking && (
        <DrivePicker
          title="Choose a parsed document"
          canPick={(item) => (TEXT_FILE.test(item.name) ? null : "Choose a .json, .md or .txt file")}
          onPick={(item) => {
            setFile(item);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
