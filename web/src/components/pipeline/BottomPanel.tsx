"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { Finding } from "@/lib/compat";
import { when } from "@/lib/format";
import { FALSE_PORT, inputsOf, joinKeys, refLabel, type NodeResult, type Output, type Pipeline, type PipelineNode, type Table } from "@/lib/pipeline";
import { Icon } from "../Icon";
import { DataPreview, FilesPreview, MediaPreview, TYPE_MARK } from "./DataPreview";
import type { PreviewPager } from "./previewQuery";
import { GlosariumDialog } from "../aip/GlosariumView";
import { DictionaryDialog } from "./DictionaryDialog";
import { UpstreamDialog } from "./UpstreamDialog";
import { NODE_ICON } from "./Graph";
import { DeployStatus } from "./OutputsPanel";
import { Info, NoteCard, Tabs } from "./ui";

const KIND_LABEL: Record<PipelineNode["kind"], string> = {
  source: "Dataset",
  transform: "Transform",
  join: "Join",
  union: "Union",
  split: "Split",
  subgraph: "Subgraph",
  input: "Subgraph input",
  llm: "Use LLM",
  model: "Trained model",
};

export type BottomTab = "preview" | "errors" | "warnings" | "extra";
export type PipelineError = { node?: string; output?: string; title: string; detail: string };

/** Preview of the selected node, and the Pipeline errors / warnings lists. */
export function BottomPanel({
  pipeline,
  node,
  output,
  count,
  result,
  pager,
  errors,
  warnings,
  tab,
  setTab,
  confirmPreview,
  onRunPreview,
  onRename,
  onGo,
  extra,
}: {
  pipeline: Pipeline;
  node: PipelineNode | undefined;
  output?: { o: Output; table?: Table; error?: string };
  count: number;
  result: (ref: string) => NodeResult;
  /** Next pages, Find and Filter by over every row of a node (DuckDB local pipelines) */
  pager?: (ref: string, output?: Output) => PreviewPager | undefined;
  errors: PipelineError[];
  warnings: Finding[];
  tab: BottomTab;
  setTab: (t: BottomTab) => void;
  /** previews wait for Run preview (user preference) */
  confirmPreview: boolean;
  onRunPreview: () => void;
  onRename: (name: string) => void;
  onGo: (id: string) => void;
  /** a tab of test or evaluation results */
  extra?: { label: string; content: ReactNode };
}) {
  // folded until there is something to preview: the canvas keeps the height; selecting one node opens it
  const [collapsed, setCollapsed] = useState(true);
  const nodeId = node?.id ?? output?.o.id;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a newly selected node opens its preview
    if (nodeId) setCollapsed(false);
  }, [nodeId]);
  const [side, setSide] = useState<"true" | "false">("true");
  const [info, setInfo] = useState<"about" | "columns">("about");
  const [thumbs, setThumbs] = useState(true);
  const ref = node?.kind === "split" && side === "false" ? node.id + FALSE_PORT : node?.id;
  const r = ref ? result(ref) : null;
  const dataset = node?.kind === "source" ? pipeline.datasets[node.datasetId] : undefined;
  const [dictOpen, setDictOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [upstreamOpen, setUpstreamOpen] = useState(false);
  const dictionary = pipeline.dictionary ?? {};
  const hasDictionary = Object.keys(dictionary).length > 0;
  // an output's real row count is its node's (its table here may be only the preview's rows)
  const outRows = output?.table ? (output.table.totalRows ?? result(output.o.node).table?.totalRows ?? output.table.rows.length) : 0;
  const shownColumns = (output?.table ?? r?.table)?.columns.map((c) => c.name);

  return (
    <div className={`flex shrink-0 flex-col border-t border-line bg-ink ${collapsed ? "" : "h-80"}`}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-2 text-xs">
        <Tabs
          value={tab}
          onChange={(t) => {
            setTab(t);
            setCollapsed(false);
          }}
          tabs={[
            { id: "preview", label: "Preview" },
            { id: "errors", label: "Pipeline errors", badge: errors.length, tone: "bad" },
            { id: "warnings", label: "Pipeline warnings", badge: warnings.length, tone: "warn" },
            ...(extra ? [{ id: "extra" as const, label: extra.label }] : []),
          ]}
        />
        {pipeline.upstream && (
          <button
            type="button"
            onClick={() => setUpstreamOpen(true)}
            title="Bagaimana file asli BPJS (Stata .dta) menjadi data input pipeline ini (Data Mentah): langkah, file, hash, rekonsiliasi baris, kode"
            className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-soft hover:bg-panel-2 hover:text-white"
          >
            <Icon name="upload" className="h-3.5 w-3.5 text-ocean" /> Dari Arsip Sumber
          </button>
        )}
        {hasDictionary && (
          <button
            type="button"
            onClick={() => setDictOpen(true)}
            title="What every column means, where it comes from and which are anonymized"
            className={`${pipeline.upstream ? "" : "ml-auto "}inline-flex items-center gap-1 rounded px-2 py-1 text-soft hover:bg-panel-2 hover:text-white`}
          >
            <Icon name="info" className="h-3.5 w-3.5 text-ocean" /> Data dictionary
          </button>
        )}
        {hasDictionary && (
          <button
            type="button"
            onClick={() => setGlossaryOpen(true)}
            title="Arti istilah dataset: kapitasi, FKRTL, INA-CBG, LOS, tag indikasi, skor ML"
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-soft hover:bg-panel-2 hover:text-white"
          >
            <Icon name="doc" className="h-3.5 w-3.5 text-ocean" /> Glosarium
          </button>
        )}
        <button type="button" title={collapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed(!collapsed)} className={`${hasDictionary || pipeline.upstream ? "" : "ml-auto "}rounded p-1 text-muted hover:text-white`}>
          <Icon name="down" className={`h-4 w-4 ${collapsed ? "rotate-180" : ""}`} />
        </button>
      </div>
      {!collapsed && tab === "errors" && (
        <FindingList items={errors} empty="No errors — every node and output can be computed." tone="bad" onGo={onGo} pipeline={pipeline} />
      )}
      {!collapsed && tab === "warnings" && <FindingList items={warnings} empty="No warnings." tone="warn" onGo={onGo} pipeline={pipeline} />}
      {!collapsed && tab === "extra" && extra && <div className="flex min-h-0 flex-1 flex-col overflow-auto">{extra.content}</div>}
      {!collapsed && tab === "preview" && output && (
        <div className="flex min-h-0 flex-1">
          <div className="w-80 shrink-0 space-y-2.5 overflow-y-auto border-r border-line p-3 text-xs">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Icon name="table" className="h-4 w-4 shrink-0 text-ocean" />
              <span className="truncate">{output.o.name || "Unnamed output"}</span>
            </div>
            <dl className="space-y-2">
              <Info label="Type">{(output.o.kind ?? "dataset").replace(/([A-Z])/g, " $1").toLowerCase()} output</Info>
              <Info label="Input">{refLabel(pipeline.nodes, output.o.node)}</Info>
              <Info label="Status">
                <DeployStatus o={output.o} />
              </Info>
              {output.table && (
                <Info label="Size">
                  {outRows.toLocaleString()} rows · {output.table.columns.length} columns
                </Info>
              )}
            </dl>
            {output.o.description && <NoteCard text={output.o.description} />}
          </div>
          {output.table ? (
            <DataPreview key={output.o.id} table={{ ...output.table, totalRows: outRows }} title={output.o.name} pager={pager?.(output.o.node, output.o)} />
          ) : (
            <ErrorBox text={output.error} />
          )}
        </div>
      )}
      {!collapsed &&
        tab === "preview" &&
        !output &&
        (!node ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted">
            <Icon name="table" className="h-8 w-8 text-line-2" />
            {count > 1 ? `${count} nodes selected — select a single node to preview data` : "Select a single node to preview data"}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="flex w-80 shrink-0 flex-col border-r border-line">
              <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
                <Icon name={NODE_ICON[node.kind]} className="h-4 w-4 shrink-0 text-ocean" />
                <input
                  value={node.name}
                  onChange={(e) => onRename(e.target.value)}
                  aria-label="Node name"
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium outline-none hover:border-line-2 focus:border-ocean"
                />
              </div>
              {node.kind === "split" && (
                <div className="border-b border-line p-1.5">
                  <Tabs
                    value={side}
                    onChange={setSide}
                    tabs={[
                      { id: "true", label: "True output" },
                      { id: "false", label: "False output" },
                    ]}
                  />
                </div>
              )}
              <div className="p-1.5">
                <Tabs value={info} onChange={setInfo} tabs={[{ id: "about", label: "About" }, { id: "columns", label: "Columns" }]} />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 text-xs">
                {info === "about" ? (
                  <div className="space-y-2.5">
                  <dl className="space-y-2">
                    <Info label="Type">{KIND_LABEL[node.kind]}</Info>
                    {dataset && <Info label="Source">{dataset.origin}</Info>}
                    {dataset && <Info label="Added">{when(dataset.createdAt)}</Info>}
                    {node.kind === "source" && <Info label="Computation">{node.mode === "incremental" ? "Incremental (new rows only)" : "Snapshot"}</Info>}
                    {node.kind === "source" && node.sampling && node.sampling.kind !== "none" && <Info label="Preview sampling">{samplingText(node.sampling)}</Info>}
                    {node.kind === "transform" && <Info label="Transforms">{node.steps.length}</Info>}
                    {node.kind === "union" && <Info label="Operation">{node.mode ?? "union all"}</Info>}
                    {node.kind === "join" && (
                      <Info label="Join">
                        {node.how}
                        {node.how !== "cross" && ` on ${joinKeys(node).map((k) => `${k.left} ${k.op ?? "="} ${k.right}`).join(" and ")}`}
                      </Info>
                    )}
                    {inputsOf(node).length > 0 && <Info label="Inputs">{inputsOf(node).map((i) => refLabel(pipeline.nodes, i)).join(", ")}</Info>}
                    {node.checkpoint && <Info label="Checkpoint">Computed once per build and shared by its outputs</Info>}
                    {r?.table && (
                      <Info label="Size">
                        {(r.table.totalRows ?? r.table.rows.length).toLocaleString()} rows · {r.table.columns.length} columns
                        {r.pending ? ` · ${r.pending} rows computing` : ""}
                      </Info>
                    )}
                  </dl>
                  {node.description && <NoteCard text={node.description} />}
                  </div>
                ) : (
                  <ul className="space-y-0.5">
                    {r?.table?.columns.map((c) => {
                      const e = dictionary[c.name];
                      return (
                        <li key={c.name} className="flex items-start gap-2 rounded px-1 py-0.5 hover:bg-panel-2" title={e ? [e.label, e.note, e.anonymized].filter(Boolean).join("\n") : undefined}>
                          <span className="mt-px w-7 shrink-0 font-mono text-[10px] text-muted">{TYPE_MARK[c.type]}</span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1">
                              <span className="truncate">{c.name}</span>
                              {e?.anonymized && <Icon name="lock" className="h-3 w-3 shrink-0 text-warn" aria-label="anonymized" />}
                            </span>
                            {e && <span className="block truncate text-[10.5px] text-muted">{e.label}</span>}
                          </span>
                        </li>
                      );
                    })}
                    {hasDictionary && (
                      <li className="pt-1">
                        <button type="button" onClick={() => setDictOpen(true)} className="text-[11px] text-ocean hover:underline">
                          Open the data dictionary
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </div>
            {confirmPreview && !r ? (
              <div className="flex flex-1 items-center justify-center">
                <button type="button" onClick={onRunPreview} className="inline-flex items-center gap-1.5 rounded-md bg-ocean px-3 py-1.5 text-sm text-white">
                  <Icon name="play" className="h-4 w-4" /> Run preview
                </button>
              </div>
            ) : r?.table ? (
              r.table.files ? (
                <FilesPreview files={r.table.files} title={node.name} />
              ) : (
                <div className="flex min-w-0 flex-1 flex-col">
                  {r.table.columns.some((c) => c.name === "mediaReference") && (
                    <div className="flex items-center gap-2 border-b border-line px-3 py-1 text-xs">
                      <Tabs
                        value={thumbs ? "thumbs" : "table"}
                        onChange={(v) => setThumbs(v === "thumbs")}
                        tabs={[
                          { id: "thumbs", label: "Thumbnails" },
                          { id: "table", label: "Table" },
                        ]}
                      />
                    </div>
                  )}
                  {thumbs && r.table.columns.some((c) => c.name === "mediaReference") ? (
                    <MediaPreview table={r.table} title={node.name} />
                  ) : (
                    <DataPreview
                      key={ref}
                      table={r.table}
                      title={node.kind === "split" ? `${node.name} (${side === "true" ? "True" : "False"})` : node.name}
                      pager={ref ? pager?.(ref) : undefined}
                    />
                  )}
                </div>
              )
            ) : (
              <ErrorBox text={r?.error} />
            )}
          </div>
        ))}
      {dictOpen && <DictionaryDialog dictionary={dictionary} columns={shownColumns} nodeName={output ? output.o.name : node?.name} onClose={() => setDictOpen(false)} />}
      {glossaryOpen && <GlosariumDialog onClose={() => setGlossaryOpen(false)} />}
      {upstreamOpen && pipeline.upstream && <UpstreamDialog upstream={pipeline.upstream} onClose={() => setUpstreamOpen(false)} />}
    </div>
  );
}

export const samplingText = (s: NonNullable<Extract<PipelineNode, { kind: "source" }>["sampling"]>) =>
  s.kind === "first" ? `First ${s.rows.toLocaleString()} rows` : s.kind === "random" ? `${s.percent}% of rows` : s.kind === "filter" ? `Filtered${s.rows ? `, up to ${s.rows} rows` : ""}` : "None";

function ErrorBox({ text }: { text?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <p className="flex max-w-lg items-center gap-2 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
        <Icon name="alert" className="h-4 w-4 shrink-0" /> {text ?? "Unavailable"}
      </p>
    </div>
  );
}

function FindingList({
  items,
  empty,
  tone,
  onGo,
  pipeline,
}: {
  items: { node?: string; output?: string; title: string; detail: string; kind?: string }[];
  empty: string;
  tone: "bad" | "warn";
  onGo: (id: string) => void;
  pipeline: Pipeline;
}) {
  if (!items.length)
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
        <Icon name="check" className="h-4 w-4 text-ok" /> {empty}
      </div>
    );
  const groups = [...new Set(items.map((i) => i.kind ?? ""))];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {groups.map((g) => (
        <div key={g}>
          {g && (
            <div className="sticky top-0 bg-ink px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted">
              {g === "conversion" ? "Conversion compatibility checks" : g === "compute" ? "Expensive computations" : g === "pruned" ? "Pruned from builds" : g === "sampling" ? "Input sampling" : g}
            </div>
          )}
          <ul>
            {items
              .filter((i) => (i.kind ?? "") === g)
              .map((i, k) => {
                const n = i.node ? pipeline.nodes.find((x) => x.id === i.node) : undefined;
                return (
                  <li key={k} className="flex items-start gap-2 border-b border-line px-3 py-1.5 text-xs">
                    <Icon name="alert" className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone === "bad" ? "text-bad" : "text-warn"}`} />
                    {n && <Icon name={NODE_ICON[n.kind]} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ocean" />}
                    <span className="w-48 shrink-0 truncate font-medium">{i.title}</span>
                    <span className="min-w-0 flex-1 text-soft">{i.detail}</span>
                    {(i.node || i.output) && (
                      <button type="button" title="Go to node" onClick={() => onGo(i.node ?? `out:${i.output}`)} className="shrink-0 rounded p-0.5 text-muted hover:text-ocean">
                        <Icon name="external" className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </div>
  );
}
