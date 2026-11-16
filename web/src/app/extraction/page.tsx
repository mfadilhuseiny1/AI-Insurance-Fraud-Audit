"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { NewExtractionDialog } from "@/components/kg/NewExtractionDialog";
import { ActionMenu, usePolling, type MenuItem } from "@/components/kg/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError } from "@/components/States";
import {
  extractionProgress,
  kg,
  kgDownloadUrl,
  kgUsage,
  STAGE_LABEL,
  tokens,
  usd,
  type Extraction,
  type KgUsage,
} from "@/lib/kg";
import { alertDialog, confirmDialog } from "@/lib/dialogs";

export default function ExtractionsPage() {
  const router = useRouter();
  const [items, setItems] = useState<Extraction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Extraction | null>(null);
  const [usage, setUsage] = useState<Record<string, KgUsage>>({});

  const load = useCallback(() => {
    kg.extractions()
      .then((x) => {
        setItems(x);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
    kgUsage()
      .then((u) => setUsage(u.extractions))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);
  usePolling(load, !!items?.some((e) => e.status === "queued" || e.status === "running"));

  /** Run an action, then refresh; errors are shown, not swallowed. */
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      load();
    } catch (err) {
      void alertDialog((err as Error).message);
    }
  };

  const menu = (e: Extraction): MenuItem[] => {
    const busy = e.status === "queued" || e.status === "running";
    const out: MenuItem[] = [
      { label: "Open", icon: "external", onClick: () => router.push(`/extraction/${e.id}`) },
      { label: "Rename", icon: "pencil", onClick: () => setRenaming(e) },
      "divider",
    ];
    if (busy)
      out.push({
        label: e.stage === "stopping" ? "Stopping…" : "Stop",
        icon: "stop",
        disabled: e.stage === "stopping",
        onClick: async () => {
          if ((await confirmDialog(`Stop "${e.name}"? Finished parts are kept; Continue picks up where it stopped.`)))
            act(() => kg.stopExtraction(e.id));
        },
      });
    if (e.status === "cancelled" || e.status === "failed")
      out.push({ label: "Continue", icon: "play", onClick: () => act(() => kg.continueExtraction(e.id)) });
    else if (e.status === "completed" && e.windows_failed > 0)
      out.push({
        label: `Retry ${e.windows_failed} failed part${e.windows_failed > 1 ? "s" : ""}`,
        icon: "play",
        onClick: () => act(() => kg.continueExtraction(e.id)),
      });
    if (!busy)
      out.push({
        label: "Start over",
        icon: "refresh",
        onClick: async () => {
          if ((await confirmDialog(`Run "${e.name}" again from scratch? Saved parts are discarded.`))) act(() => kg.rerunExtraction(e.id));
        },
      });
    if (e.status === "completed")
      out.push(
        { label: "Download JSON", icon: "download", href: kgDownloadUrl("extractions", e.id, "json") },
        { label: "Download Turtle", icon: "download", href: kgDownloadUrl("extractions", e.id, "ttl") },
      );
    out.push("divider", {
      label: "Delete",
      icon: "trash",
      danger: true,
      disabled: busy,
      onClick: async () => {
        if ((await confirmDialog(`Delete the extraction "${e.name}"?`))) act(() => kg.deleteExtraction(e.id));
      },
    });
    return out;
  };

  const total = Object.values(usage).length
    ? (items ?? [])
        .map((e) => usage[e.id])
        .filter(Boolean)
        .reduce(
          (a, u) => ({
            calls: a.calls + u.calls,
            input_tokens: a.input_tokens + u.input_tokens,
            output_tokens: a.output_tokens + u.output_tokens,
            cost_usd: a.cost_usd + u.cost_usd,
          }),
          { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
        )
    : null;

  if (error && !items) return <ApiError message={error} />;

  const tone = (st: Extraction["status"]) => (st === "completed" ? ("ok" as const) : st === "failed" ? ("bad" as const) : st === "running" || st === "queued" ? ("ocean" as const) : ("muted" as const));
  const progress = (e: Extraction) =>
    e.status === "running" || e.status === "queued"
      ? e.stage === "extracting"
        ? `part ${e.windows_done} of ${e.windows_total}`
        : `${Math.round(extractionProgress(e) * 100)}%`
      : e.status === "cancelled" && e.windows_total > 0
        ? `at part ${e.windows_done} of ${e.windows_total}`
        : "";

  return (
    <>
      <AppHome
        app="Extraction"
        icon="extract"
        accent="#f43f5e"
        href="/extraction"
        tagline="Extract knowledge into an ontology: classes, entities and relations, each backed by a quote."
        description={
          <>
            An LLM reads a parsed document, designs an ontology for it (classes, hierarchy, relations), and fills it with entities and relations, each backed by a quote
            from the text. Merge extractions in the{" "}
            <Link href="/knowledge-graph" className="text-ocean hover:underline">
              Knowledge Graph
            </Link>{" "}
            tab.
          </>
        }
        noun={["extraction", "extractions"]}
        error={items ? error : null}
        items={
          items?.map((e) => {
            const u = usage[e.id];
            return {
              id: e.id,
              href: `/extraction/${e.id}`,
              title: e.name,
              updated_at: e.finished_at ?? e.started_at ?? e.created_at,
              detail: e.status === "failed" && e.error ? e.error : [e.title && e.title !== e.name ? e.title : "", e.model_label].filter(Boolean).join(" · "),
              badges: [{ label: e.status === "running" ? STAGE_LABEL[e.stage] : e.status === "cancelled" ? "stopped" : e.status, tone: tone(e.status) }],
              meta: [
                progress(e),
                e.stats ? `${e.stats.nodes.toLocaleString()} ent · ${e.stats.links.toLocaleString()} rel · ${e.stats.classes} classes` : "",
                u ? `${tokens(u.input_tokens)} / ${tokens(u.output_tokens)} tok · ${usd(u.cost_usd)}` : "",
              ]
                .filter(Boolean)
                .join(" · "),
              actions: <ActionMenu items={menu(e)} />,
            };
          }) ?? null
        }
        empty={{ title: "Extract your first document", hint: "Pick a parsed document and a model.", steps: ["Parse a document", "Pick it and a model", "Review the ontology and entities"] }}
        create={
          <>
            <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> New extraction
            </button>
            {total && (
              <span className="ml-auto rounded-lg border border-line bg-ink/40 px-3 py-1.5 text-xs text-muted tabular-nums" data-extraction-total>
                Total LLM cost <span className="font-semibold text-sand">{usd(total.cost_usd)}</span> · {tokens(total.input_tokens)} in · {tokens(total.output_tokens)} out
              </span>
            )}
          </>
        }
      />

      {creating && (
        <NewExtractionDialog
          extractions={items ?? []}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          extraction={renaming}
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

function RenameDialog({ extraction, onClose, onSaved }: { extraction: Extraction; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(extraction.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Rename extraction" icon="pencil" onClose={onClose}>
      <form
        className="space-y-4 p-4"
        onSubmit={async (ev) => {
          ev.preventDefault();
          setBusy(true);
          try {
            await kg.renameExtraction(extraction.id, name.trim());
            onSaved();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-soft">Name</span>
          <input autoFocus value={name} onChange={(ev) => setName(ev.target.value)} className={inputClass} />
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
