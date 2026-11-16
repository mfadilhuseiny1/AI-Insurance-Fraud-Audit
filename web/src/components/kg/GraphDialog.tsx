"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { when } from "@/lib/format";
import { kg, type Extraction, type KnowledgeGraph } from "@/lib/kg";
import { ModelPicker, useKgModels } from "./parts";

/** Create a knowledge graph, or change an existing one's name, extractions and AI merging. */
export function GraphDialog({
  graph,
  onClose,
  onSaved,
}: {
  graph?: KnowledgeGraph;
  onClose: () => void;
  onSaved: (g: KnowledgeGraph) => void;
}) {
  const models = useKgModels();
  const [extractions, setExtractions] = useState<Extraction[] | null>(null);
  const [name, setName] = useState(graph?.name ?? "Knowledge graph");
  const [description, setDescription] = useState(graph?.description ?? "");
  const [ids, setIds] = useState<string[]>(graph?.extraction_ids ?? []);
  const [resolve, setResolve] = useState(graph ? !!graph.resolve_model : true);
  const [model, setModel] = useState(graph?.resolve_model ?? "");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    kg.extractions()
      .then((all) => setExtractions(all.filter((e) => e.status === "completed")))
      .catch((e: Error) => setError(e.message));
  }, []);

  const chosenModel = model || models?.find((m) => m.default && m.available)?.id || models?.find((m) => m.available)?.id || "";
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (extractions ?? []).filter((e) => !q || `${e.name} ${e.title ?? ""}`.toLowerCase().includes(q));
  }, [extractions, filter]);
  const totals = useMemo(() => {
    const chosen = (extractions ?? []).filter((e) => ids.includes(e.id));
    return { nodes: chosen.reduce((a, e) => a + (e.stats?.nodes ?? 0), 0), links: chosen.reduce((a, e) => a + (e.stats?.links ?? 0), 0) };
  }, [extractions, ids]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      description: description.trim(),
      extraction_ids: ids,
      resolve_model: resolve ? chosenModel : null,
    };
    try {
      onSaved(graph ? await kg.updateGraph(graph.id, body) : await kg.createGraph(body));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const toggle = (id: string) => setIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));

  return (
    <Modal title={graph ? "Edit knowledge graph" : "New knowledge graph"} icon="graph" onClose={onClose} wide>
      <div className="space-y-5 p-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-soft">Name</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-soft">Description (optional)</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
          </label>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-medium text-soft">Extractions to merge</span>
            <span className="text-muted tabular-nums">
              {ids.length} chosen · up to {totals.nodes.toLocaleString()} entities, {totals.links.toLocaleString()} relations
            </span>
          </div>
          <div className="rounded-lg border border-line-2">
            <div className="border-b border-line p-2">
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter extractions…" className={inputClass} />
            </div>
            <div className="max-h-64 overflow-y-auto">
              {extractions === null && <div className="p-3 text-xs text-muted">Loading…</div>}
              {extractions?.length === 0 && (
                <div className="p-3 text-xs text-muted">No finished extractions yet. Run one in the Extraction tab first.</div>
              )}
              {shown.map((e) => (
                <label key={e.id} className="flex cursor-pointer items-center gap-2.5 border-t border-line px-3 py-2 text-sm first:border-t-0 hover:bg-panel-2">
                  <input type="checkbox" checked={ids.includes(e.id)} onChange={() => toggle(e.id)} className="accent-ocean" />
                  <Icon name="extract" className="h-4 w-4 shrink-0 text-ocean" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{e.name}</span>
                    {e.title && <span className="block truncate text-xs text-muted">{e.title}</span>}
                  </span>
                  <span className="shrink-0 text-right text-xs text-muted tabular-nums">
                    {e.stats?.nodes.toLocaleString()} entities · {e.model_label}
                    <span className="block">{when(e.created_at)}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <p className="mt-1 text-xs text-muted">
            Entities with the same name or alias are merged; classes and relations with the same identifier are unified.
          </p>
        </div>

        <div>
          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} className="mt-0.5 accent-ocean" />
            <span>
              AI entity resolution
              <span className="block text-xs text-muted">
                A model also merges entities that are the same thing across documents under different spellings, abbreviations,
                transliterations or translations.
              </span>
            </span>
          </label>
          {resolve && models && (
            <div className="mt-2 pl-6">
              <ModelPicker models={models} value={chosenModel} onChange={setModel} />
            </div>
          )}
        </div>

        {error && <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={busy || !name.trim() || !ids.length || (resolve && !chosenModel)} onClick={save} className={buttonClass.primary}>
            {busy ? "Saving…" : graph ? "Save and rebuild" : "Build knowledge graph"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
