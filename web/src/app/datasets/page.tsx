"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { datasetHref, datasetPreview, formatBytes, type DatasetListing } from "@/lib/datasetPreview";

const KIND_LABEL: Record<DatasetListing["kind"], string> = { parquet: "Parquet", file: "File", raw: "Raw · files", iceberg: "Iceberg table" };

/** Dataset Preview home: find a dataset (built Parquet datasets, CSV / TSV / JSON files, raw datasets) or make one. */
export default function DatasetsHome() {
  const router = useRouter();
  const [list, setList] = useState<DatasetListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("New dataset");
  // the server searches (names across every Project); AppHome hands over the query
  const search = useCallback((q: string) => {
    datasetPreview.list(q).then(
      (l) => {
        setList(l);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  return (
    <>
      <AppHome
        app="Dataset Preview"
        icon="table"
        accent="#06b6d4"
        href="/datasets"
        tagline="Metadata, preview, history, schema, health, compare and Time Travel for any dataset."
        description={<>Built Parquet datasets, CSV / TSV / JSON files, raw datasets of files and Iceberg tables — open one to see its rows, schema, transactions and health checks, compare versions or read it as of an earlier time.</>}
        noun={["dataset", "datasets"]}
        onSearch={search}
        items={
          list?.map((d) => ({
            id: d.id,
            href: datasetHref(d.id),
            title: d.name,
            path: d.path,
            updated_at: d.updated_at,
            icon: d.kind === "raw" ? "folder" : d.kind === "iceberg" ? "layers" : "table",
            badges: [{ label: KIND_LABEL[d.kind], tone: d.kind === "iceberg" ? "ocean" : d.kind === "raw" ? "sand" : "muted" }],
            meta: d.kind === "raw" ? undefined : formatBytes(d.size),
          })) ?? null
        }
        error={error}
        empty={{ title: "Make your first dataset", hint: "Pick the folder it lives in, then upload files or build it from a pipeline.", steps: ["Click New dataset", "Pick its Project folder", "Upload files or build it"] }}
        create={
          <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
            <Icon name="plus" className="h-3.5 w-3.5" /> New dataset
          </button>
        }
      />
      {creating && (
        <DrivePicker
          title="New dataset: pick its folder"
          folder={{
            action: "Create dataset here",
            extra: <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dataset name" className={`${inputClass} max-w-xs`} />,
            onPick: async (f) => {
              try {
                const ds = await datasetPreview.create(f.id, name.trim() || "New dataset");
                router.push(datasetHref(ds.id));
              } catch (e) {
                setError((e as Error).message);
                setCreating(false);
              }
            },
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}
