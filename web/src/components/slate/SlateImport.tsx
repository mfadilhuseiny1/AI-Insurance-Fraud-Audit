"use client";

import { useEffect, useRef, useState } from "react";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type DriveItem } from "@/lib/api";
import { slate, SlateError, type SlateAppSummary } from "@/lib/slate";

export function FolderSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [projects, setProjects] = useState<DriveItem[]>([]);
  useEffect(() => {
    api.drive.folder(null).then((f) => {
      const ps = f.items.filter((i) => i.kind === "project");
      setProjects(ps);
      if (!value && ps[0]) onChange(ps[0].id);
    }, () => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (r: { app: SlateAppSummary }) => void }) {
  const [file, setFile] = useState<{ name: string; size: number; json: Record<string, unknown> } | null>(null);
  const [folder, setFolder] = useState("");
  const [needLocation, setNeedLocation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement | null>(null);
  const go = async () => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      onImported(await slate.importJson(file.json, needLocation ? folder : undefined));
    } catch (e) {
      if (e instanceof SlateError && (e.detail as { code?: string })?.code === "location_needed") setNeedLocation(true);
      else setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Import Slate JSON" icon="upload" onClose={onClose}>
      <div className="space-y-2 p-4 text-xs">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={async (e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) setFile({ name: f.name, size: f.size, json: JSON.parse(await f.text()) });
          }}
          onClick={() => ref.current?.click()}
          className="cursor-pointer rounded-lg border border-dashed border-line-2 p-6 text-center text-muted hover:border-ocean"
        >
          {file ? `${file.name} · ${Math.round(file.size / 1024)} KB` : "Drop a .slate.json file here, or browse"}
        </div>
        <input
          ref={ref}
          type="file"
          accept=".json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              setFile({ name: f.name, size: f.size, json: JSON.parse(await f.text()) });
            } catch {
              setErr("not a JSON file");
            }
          }}
        />
        {needLocation && (
          <div>
            <p className="mb-1 text-muted">This permalink is new: choose where to create the application.</p>
            <FolderSelect value={folder} onChange={setFolder} />
          </div>
        )}
        {err && <p className="text-bad">{err}</p>}
        <button type="button" disabled={!file || busy} onClick={go} className={buttonClass.primary}>
          {busy ? "Importing…" : "Import"}
        </button>
        <p className="text-muted">An existing permalink gets a new version with the imported logic; images, datasets and objects are not imported.</p>
      </div>
    </Modal>
  );
}

