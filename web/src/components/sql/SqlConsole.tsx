"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { downloadCsv, ResultsPanel, SqlEditor } from "@/components/sql/SqlParts";
import { sqlStudio, type SqlResult } from "@/lib/sqlStudio";

/** The SQL console embedded in an application (Dataset Preview, Data Lineage, Ontology Manager): one query over one
 *  resource, with an expand link that opens the same query in SQL Studio. `mode` "object" queries object types. */
export function SqlConsole({ resource: resourceRef, name, mode = "data" }: { resource: string; name: string; mode?: "data" | "object" }) {
  const [sql, setSql] = useState(`SELECT *\nFROM \`${resourceRef}\`\nLIMIT 100`);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const run = async (q = sql) => {
    if (!q.trim()) return;
    setRunning(true);
    setError(null);
    try {
      setResult(await sqlStudio.query(q, mode));
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <button type="button" disabled={running} onClick={() => run()} className="flex items-center gap-1.5 rounded-md bg-ocean px-3 py-1.5 text-xs font-medium text-white hover:bg-ocean-deep disabled:opacity-50" title="Run (Ctrl+Enter)">
          <Icon name={running ? "refresh" : "play"} className={`h-3 w-3 ${running ? "animate-spin" : ""}`} /> Run
        </button>
        <span className="text-[10px] text-muted">Spark SQL · read-only · {mode === "object" ? "the object type" : "the dataset"} is {`\`${resourceRef}\``}</span>
        <Link href={`/sql-studio?sql=${encodeURIComponent(sql)}&mode=${mode}`} className="ml-auto flex items-center gap-1 text-xs text-ocean hover:underline" title="Open this query in SQL Studio">
          <Icon name="external" className="h-3.5 w-3.5" /> Open in SQL Studio
        </Link>
      </div>
      <div className="flex max-h-[40%] min-h-[150px] flex-col bg-ink">
        <SqlEditor value={sql} onChange={setSql} onRun={run} minHeight={140} />
      </div>
      <ResultsPanel result={result} error={error} running={running} onDownload={result ? () => downloadCsv(result, name) : undefined} />
    </div>
  );
}
