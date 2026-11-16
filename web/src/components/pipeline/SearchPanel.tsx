"use client";

import { useMemo, useState } from "react";
import { pseudocode } from "@/lib/describe";
import { replaceColumnName } from "@/lib/refactor";
import type { NodeResult, Pipeline } from "@/lib/pipeline";
import { Icon } from "../Icon";
import { NODE_ICON } from "./Graph";
import { buttonClass, inputClass } from "./Modal";
import { Panel, Switch, Tabs } from "./ui";

/** Search pipeline: nodes, columns and transform logic; plus find and replace of column names. */
export function SearchPanel({
  pipeline,
  result,
  onGo,
  change,
  onClose,
}: {
  pipeline: Pipeline;
  result: (id: string) => NodeResult;
  onGo: (nodeId: string) => void;
  change: (fn: (p: Pipeline) => Pipeline) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"search" | "replace">("search");
  const [q, setQ] = useState("");
  const [find, setFind] = useState("");
  const [to, setTo] = useState("");
  const [inData, setInData] = useState(true);
  const [done, setDone] = useState<string | null>(null);

  const hits = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    return pipeline.nodes
      .map((n) => {
        const r = result(n.id);
        const cols = (r.table?.columns ?? []).filter((c) => c.name.toLowerCase().includes(query)).map((c) => c.name);
        const logic = pseudocode(n, pipeline.nodes, pipeline.functions, pipeline.subgraphs).filter((l) => l.toLowerCase().includes(query));
        const named = n.name.toLowerCase().includes(query);
        return { n, cols, logic, named, score: (named ? 10 : 0) + logic.length * 2 + cols.length };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score);
  }, [q, pipeline, result]);

  const allColumns = useMemo(() => {
    const set = new Set<string>();
    for (const n of pipeline.nodes) for (const c of result(n.id).table?.columns ?? []) set.add(c.name);
    return [...set].sort();
  }, [pipeline, result]);

  const preview = useMemo(() => (find && to && find !== to ? replaceColumnName(pipeline, find, to, { datasets: inData }).count : 0), [pipeline, find, to, inData]);

  return (
    <Panel title="Search pipeline" icon="search" onClose={onClose}>
      <div className="border-b border-line p-2">
        <Tabs value={tab} onChange={setTab} tabs={[{ id: "search", label: "Search" }, { id: "replace", label: "Find and replace columns" }]} />
      </div>
      {tab === "search" ? (
        <>
          <div className="p-3">
            <label className="flex items-center gap-1.5 rounded-md border border-line-2 bg-ink px-2 py-1.5 text-sm focus-within:border-ocean">
              <Icon name="search" className="h-4 w-4 text-muted" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nodes, columns, transforms…" className="min-w-0 flex-1 bg-transparent outline-none" />
            </label>
          </div>
          <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3">
            {q && !hits.length && <li className="py-4 text-center text-xs text-muted">Nothing matches.</li>}
            {hits.map(({ n, cols, logic, named }) => (
              <li key={n.id}>
                <button type="button" onClick={() => onGo(n.id)} className="w-full rounded-md border border-line bg-panel-2 p-2 text-left text-xs hover:border-ocean/50">
                  <span className="flex items-center gap-1.5 text-sm">
                    <Icon name={NODE_ICON[n.kind]} className="h-3.5 w-3.5 text-ocean" />
                    <span className={`truncate ${named ? "text-white" : "text-soft"}`}>{n.name}</span>
                  </span>
                  {cols.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {cols.slice(0, 8).map((c) => (
                        <span key={c} className="rounded bg-panel px-1 font-mono text-[10px] text-soft ring-1 ring-line-2">
                          {c}
                        </span>
                      ))}
                      {cols.length > 8 && <span className="text-[10px] text-muted">+{cols.length - 8}</span>}
                    </span>
                  )}
                  {logic.slice(0, 3).map((l, i) => (
                    <span key={i} className="mt-1 block truncate font-mono text-[10px] text-muted">
                      {l}
                    </span>
                  ))}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="space-y-3 p-3 text-xs">
          <p className="text-muted">Renames a column everywhere the pipeline refers to it: transform boards, joins, splits, LLM prompts, output schemas and expectations.</p>
          <label className="block">
            <span className="mb-1 block font-medium text-soft">Find column</span>
            <input list="pipeline-columns" value={find} onChange={(e) => setFind(e.target.value)} placeholder="column_name" className={inputClass} />
            <datalist id="pipeline-columns">
              {allColumns.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="block">
            <span className="mb-1 block font-medium text-soft">Replace with</span>
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="new_name" className={inputClass} />
          </label>
          <Switch on={inData} onChange={setInData} label="Also rename the column in input datasets" hint="Otherwise only references are renamed (use when an upstream board already renames it)." />
          <p className="text-muted">{find && to ? `${preview} reference${preview === 1 ? "" : "s"} will change.` : "Enter both names."}</p>
          <button
            type="button"
            disabled={!preview}
            onClick={() => {
              change((p) => replaceColumnName(p, find, to, { datasets: inData }).pipeline);
              setDone(`Replaced ${preview} reference${preview === 1 ? "" : "s"} of "${find}" with "${to}".`);
            }}
            className={`${buttonClass.primary} w-full justify-center`}
          >
            Replace all
          </button>
          {done && <p className="text-ok">{done}</p>}
        </div>
      )}
    </Panel>
  );
}
