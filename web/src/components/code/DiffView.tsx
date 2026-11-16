"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import type { FileDiff } from "@/lib/codeRepos";

/** Unified diffs, one collapsible block per file. */
export function DiffView({ files, empty = "No changes.", onComment }: { files: FileDiff[]; empty?: string; onComment?: (path: string, line: number) => void }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (!files.length) return <p className="p-4 text-sm text-muted">{empty}</p>;
  return (
    <div className="space-y-3">
      {files.map((f) => {
        const open = !closed.has(f.path);
        let newLine = 0;
        return (
          <div key={f.path} className="overflow-hidden rounded-lg border border-line">
            <button
              type="button"
              onClick={() => {
                const s = new Set(closed);
                if (open) s.add(f.path);
                else s.delete(f.path);
                setClosed(s);
              }}
              className="flex w-full items-center gap-2 bg-panel-2 px-3 py-2 text-left text-xs"
            >
              <Icon name={open ? "down" : "right"} className="h-3 w-3 text-muted" />
              <span className="font-mono text-soft">{f.path}</span>
              <span className={`rounded px-1.5 text-[10px] ${f.status === "added" ? "bg-ok/15 text-ok" : f.status === "deleted" ? "bg-bad/15 text-bad" : "bg-ocean/15 text-ocean"}`}>{f.status}</span>
              <span className="ml-auto text-ok">+{f.additions}</span>
              <span className="text-bad">−{f.deletions}</span>
            </button>
            {open && (
              <pre className="max-h-[480px] overflow-auto bg-ink py-1 font-mono text-[12px] leading-[18px]">
                {f.diff.split("\n").map((l, i) => {
                  const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
                  if (hunk) newLine = Number(hunk[1]) - 1;
                  else if (!l.startsWith("-")) newLine++;
                  const cls = l.startsWith("+") ? "bg-ok/10 text-ok" : l.startsWith("-") ? "bg-bad/10 text-bad" : l.startsWith("@@") ? "text-ocean" : "text-soft";
                  const line = newLine;
                  return (
                    <div key={i} className={`group flex px-3 ${cls}`}>
                      <span className="w-10 shrink-0 select-none pr-2 text-right text-muted/60">{hunk || l.startsWith("-") ? "" : line}</span>
                      <span className="whitespace-pre">{l || " "}</span>
                      {onComment && !hunk && !l.startsWith("-") && (
                        <button type="button" onClick={() => onComment(f.path, line)} className="ml-auto pl-2 text-muted opacity-0 hover:text-white group-hover:opacity-100" title="Comment on this line">
                          <Icon name="comment" className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
