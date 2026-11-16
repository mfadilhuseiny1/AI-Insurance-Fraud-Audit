"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { fusion, type LocatedItem } from "@/lib/fusion";

/** Fusion: spreadsheets on Foundry data — the documents, a new sheet, or a workbook imported from Excel. */
export default function FusionHome() {
  const router = useRouter();
  const [docs, setDocs] = useState<LocatedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("Untitled spreadsheet");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fusion.list().then(setDocs, (e: Error) => setError(e.message));
  }, []);
  const go = async (fn: () => Promise<{ item: { id: string } }>) => {
    setBusy(true);
    setError(null);
    try {
      const v = await fn();
      router.push(`/fusion/${v.item.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const importFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).split(",")[1] ?? "";
      void go(() => fusion.importXlsx({ name: file.name.replace(/\.xlsx?$/i, ""), data }));
    };
    reader.readAsDataURL(file);
  };
  return (
    <AppHome
      app="Fusion"
      icon="table"
      accent="#22c55e"
      href="/fusion"
      tagline="Spreadsheets on platform data: formulas, lookups from datasets and objects, and tables synced back to datasets."
      description={
        <>
          Spreadsheets on Foundry data: formulas with single-quoted strings, <span className="font-mono">lookup</span> from datasets, Nexus objects, table regions synced to datasets, buttons
          that run actions, and an edit history.
        </>
      }
      noun={["spreadsheet", "spreadsheets"]}
      items={docs?.map((d) => ({ id: d.id, href: `/fusion/${d.id}`, title: d.name.replace(/\.fusion$/, ""), path: (d.path ?? []).map((p) => p.name), updated_at: d.updated_at })) ?? null}
      error={error}
      empty={{ title: "Start your first spreadsheet", hint: "Begin from a blank sheet or bring in an Excel workbook, then pull in live data with lookup.", steps: ["Name it, or pick an .xlsx file", "Write formulas and lookups", "Sync a table region to a dataset"] }}
      create={
        <>
          <div className="w-64">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} aria-label="Name" />
          </div>
          <button type="button" disabled={busy || !name.trim()} onClick={() => go(() => fusion.create(name.trim()))} className={buttonClass.primary}>
            <Icon name="plus" className="h-3.5 w-3.5" /> New spreadsheet
          </button>
          <label className={`${buttonClass.secondary} cursor-pointer`}>
            <Icon name="upload" className="h-3.5 w-3.5" /> New from Excel file
            <input type="file" accept=".xlsx" className="hidden" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          </label>
        </>
      }
    />
  );
}
