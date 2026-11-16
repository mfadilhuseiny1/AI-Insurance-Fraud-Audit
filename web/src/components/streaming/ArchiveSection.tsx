"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { Section } from "@/components/streaming/parts";
import { api, type DriveItem } from "@/lib/api";
import { datasetHref } from "@/lib/datasetPreview";
import { streaming, type StreamDataset } from "@/lib/streaming";

/** Archive a stream into a dataset (api/stream_datasets.py): Dataset Preview then shows it as a streaming dataset
 *  with Live and Archive views, and the Stream and Metrics tabs. */
export function ArchiveSection({ streamId }: { streamId: string }) {
  const [state, setState] = useState<StreamDataset | null>(null);
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [folder, setFolder] = useState("");
  const [every, setEvery] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    streaming.archive(streamId).then(
      (s) => {
        setState(s);
        if (s.archive) {
          setFolder(s.archive.folder_id);
          setEvery(s.archive.every_minutes);
        }
      },
      () => {},
    );
    api.drive.folder(null).then((f) => {
      const ps = f.items.filter((i) => i.kind === "project");
      setProjects(ps);
      setFolder((cur) => cur || ps[0]?.id || "");
    }, () => {});
  }, [streamId]);
  const run = async (fn: () => Promise<StreamDataset>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const a = state?.archive;
  return (
    <Section title="Dataset archive" icon="table">
      <p className="mb-2 text-xs text-muted">
        Archive the stream&apos;s records into a dataset in a Project. Dataset Preview shows it as a streaming dataset: Live and Archive views, and the Stream and Metrics tabs.
      </p>
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="text-muted">
          Project
          <select value={folder} onChange={(e) => setFolder(e.target.value)} className={`${inputClass} mt-1 w-56`}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-muted">
          Every (minutes)
          <input type="number" min={1} max={1440} value={every} onChange={(e) => setEvery(Number(e.target.value) || 5)} className={`${inputClass} mt-1 w-24`} />
        </label>
        <button type="button" disabled={busy || !folder} onClick={() => run(() => streaming.setArchive(streamId, { folder_id: folder, every_minutes: every }))} className={buttonClass.primary}>
          {a ? "Save" : "Archive to a dataset"}
        </button>
        {a?.item_id && (
          <button type="button" disabled={busy} onClick={() => run(() => streaming.runArchive(streamId))} className={buttonClass.secondary}>
            <Icon name={busy ? "refresh" : "save"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> Archive now
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
      {a?.item_id && (
        <p className="mt-2 text-xs text-soft">
          <Link href={datasetHref(a.item_id)} className="text-ocean hover:underline">
            {(a.path ?? []).join(" / ")} / {a.name}.parquet
          </Link>{" "}
          <span className="text-muted">
            · {a.rows?.toLocaleString() ?? 0} records · last archived {a.last_at?.slice(0, 19).replace("T", " ")}
            {a.missing ? " · the dataset was deleted: save to create it again" : ""}
          </span>
        </p>
      )}
    </Section>
  );
}
