"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { GraphDialog } from "@/components/kg/GraphDialog";
import { ActionMenu, usePolling, type MenuItem } from "@/components/kg/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError } from "@/components/States";
import { kg, kgDownloadUrl, kgUsage, STAGE_LABEL, usd, type KgUsage, type KnowledgeGraph } from "@/lib/kg";
import { alertDialog, confirmDialog } from "@/lib/dialogs";

export default function KnowledgeGraphsPage() {
  const router = useRouter();
  const [items, setItems] = useState<KnowledgeGraph[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<KnowledgeGraph | null>(null);
  const [renaming, setRenaming] = useState<KnowledgeGraph | null>(null);
  const [usage, setUsage] = useState<Record<string, KgUsage>>({});

  const load = useCallback(() => {
    kg.graphs()
      .then((x) => {
        setItems(x);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
    kgUsage()
      .then((u) => setUsage(u.graphs))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);
  usePolling(load, !!items?.some((g) => g.status === "queued" || g.status === "running"));

  /** Run an action, then refresh; errors are shown, not swallowed. */
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      load();
    } catch (err) {
      void alertDialog((err as Error).message);
    }
  };

  const menu = (g: KnowledgeGraph): MenuItem[] => {
    const busy = g.status === "queued" || g.status === "running";
    const items: MenuItem[] = [
      { label: "Open", icon: "external", onClick: () => router.push(`/knowledge-graph/${g.id}`) },
      { label: "Rename", icon: "pencil", onClick: () => setRenaming(g) },
      { label: "Edit sources", icon: "edit", onClick: () => setEditing(g), disabled: busy },
      "divider",
    ];
    if (busy)
      items.push({
        label: g.stage === "stopping" ? "Stopping…" : "Stop",
        icon: "stop",
        disabled: g.stage === "stopping",
        onClick: () => act(() => kg.stopGraph(g.id)),
      });
    else if (g.status === "cancelled" || g.status === "failed")
      items.push({ label: "Continue", icon: "play", onClick: () => act(() => kg.continueGraph(g.id)) });
    else items.push({ label: "Rebuild", icon: "refresh", onClick: () => act(() => kg.rebuildGraph(g.id)) });
    if (g.status === "completed")
      items.push(
        { label: "Download JSON", icon: "download", href: kgDownloadUrl("graphs", g.id, "json") },
        { label: "Download Turtle", icon: "download", href: kgDownloadUrl("graphs", g.id, "ttl") },
      );
    items.push("divider", {
      label: "Delete",
      icon: "trash",
      danger: true,
      disabled: busy,
      onClick: async () => {
        if ((await confirmDialog(`Delete the knowledge graph "${g.name}"? Its extractions are kept.`))) act(() => kg.deleteGraph(g.id));
      },
    });
    return items;
  };

  if (error && !items) return <ApiError message={error} />;

  const tone = (st: KnowledgeGraph["status"]) => (st === "completed" ? ("ok" as const) : st === "failed" ? ("bad" as const) : st === "running" || st === "queued" ? ("ocean" as const) : ("muted" as const));

  return (
    <>
      <AppHome
        app="Knowledge Graph"
        icon="graph"
        accent="#0ea5e9"
        href="/knowledge-graph"
        tagline="Unified knowledge graphs: merge several extractions so the same entity becomes one node."
        description={
          <>
            Merge several extractions into one graph: the same entity found in different documents becomes one node, with the evidence from each document kept.
          </>
        }
        noun={["knowledge graph", "knowledge graphs"]}
        error={items ? error : null}
        items={
          items?.map((g) => ({
            id: g.id,
            href: `/knowledge-graph/${g.id}`,
            title: g.name,
            updated_at: g.updated_at,
            detail: g.description || undefined,
            badges: [{ label: g.status === "running" ? STAGE_LABEL[g.stage] : g.status === "cancelled" ? "stopped" : g.status, tone: tone(g.status) }],
            meta: [
              `${g.extraction_ids.length} ${g.extraction_ids.length === 1 ? "extraction" : "extractions"}`,
              g.stats ? `${g.stats.nodes.toLocaleString()} entities · ${g.stats.links.toLocaleString()} relations` : "",
              usage[g.id]?.calls ? usd(usage[g.id].cost_usd) : "",
            ]
              .filter(Boolean)
              .join(" · "),
            actions: <ActionMenu items={menu(g)} />,
          })) ?? null
        }
        empty={{ title: "Create your first knowledge graph", hint: "Choose the extractions to merge; matching entities are resolved into one node each.", steps: ["Run extractions on your documents", "Pick the extractions to merge", "Explore the unified graph"] }}
        create={
          <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
            <Icon name="plus" className="h-3.5 w-3.5" /> New knowledge graph
          </button>
        }
      />

      {creating && (
        <GraphDialog onClose={() => setCreating(false)} onSaved={(g) => router.push(`/knowledge-graph/${g.id}`)} />
      )}
      {editing && (
        <GraphDialog
          graph={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          graph={renaming}
          onClose={() => setRenaming(null)}
          onSaved={() => {
            setRenaming(null);
            load();
          }}
        />
      )}
    </>
  );
}

/** Rename and describe a knowledge graph; does not rebuild it. */
function RenameDialog({ graph, onClose, onSaved }: { graph: KnowledgeGraph; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(graph.name);
  const [description, setDescription] = useState(graph.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Rename knowledge graph" icon="pencil" onClose={onClose}>
      <form
        className="space-y-4 p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await kg.updateGraph(graph.id, { name: name.trim(), description: description.trim() });
            onSaved();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-soft">Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-soft">Description (optional)</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={inputClass} />
        </label>
        {error && <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim()} className={buttonClass.primary}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
