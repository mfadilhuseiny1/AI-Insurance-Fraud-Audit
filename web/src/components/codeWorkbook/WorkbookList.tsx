"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { codeWorkbooks } from "@/lib/codeWorkbook";
import { contour } from "@/lib/contour";
import { when } from "@/lib/format";

type Row = Awaited<ReturnType<typeof codeWorkbooks.list>>[number];

/** Code Workbook home: the workbooks (Files items) and a form for a new one from imported datasets. */
export function WorkbookList() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [title, setTitle] = useState("Untitled workbook");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    codeWorkbooks.list().then(setRows, (e: Error) => setError(e.message));
    contour.sources().then((s) => setDatasets(s.datasets), () => undefined);
  }, []);
  return (
    <section className="mt-6 rounded-xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="mr-auto">
          <h2 className="text-base font-semibold">Workbooks</h2>
          <p className="text-xs text-muted">Python and SQL nodes over datasets in Files.</p>
        </div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} w-56 py-1.5 text-sm`} aria-label="Workbook title" />
        <select multiple value={picked} onChange={(e) => setPicked([...e.target.selectedOptions].map((o) => o.value))} className={`${inputClass} h-16 w-64 text-xs`} aria-label="Datasets to import" title="Datasets to import (Ctrl+click for several)">
          {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <button
          type="button"
          disabled={!title.trim()}
          className={buttonClass.primary}
          onClick={async () => {
            try {
              const w = await codeWorkbooks.create(title.trim(), picked);
              router.push(`/code-workbook/workbooks/${w.item.id}`);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <Icon name="plus" className="h-3.5 w-3.5" /> New workbook
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
      <div className="mt-3 divide-y divide-line">
        {rows === null && !error && <p className="py-3 text-sm text-muted">Loading…</p>}
        {rows?.length === 0 && <p className="py-3 text-sm text-muted">No workbooks yet.</p>}
        {rows?.map((r) => (
          <Link key={r.id} href={`/code-workbook/workbooks/${r.id}`} className="flex items-center gap-3 py-2 text-sm hover:bg-panel-2">
            <Icon name="graph" className="h-4 w-4 text-ocean" />
            <span className="min-w-0 flex-1 truncate">{r.name.replace(/\.codeworkbook$/, "")}<span className="ml-2 text-xs text-muted">{(r.path ?? []).map((p) => p.name).join(" / ")}</span></span>
            <span className="text-xs text-muted">{when(r.updated_at)}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
