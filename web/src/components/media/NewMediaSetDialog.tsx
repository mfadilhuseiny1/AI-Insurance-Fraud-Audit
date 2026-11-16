"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DrivePicker, type PickedFolder } from "@/components/DrivePicker";
import { Icon, type IconName } from "@/components/Icon";
import { ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type DbConnection } from "@/lib/api";
import { mediaSets, SCHEMA_ICON, type MediaSchema, type MediaSet, type SchemaInfo, type TransactionPolicy } from "@/lib/mediaSets";

/** New media set: name and folder, media type, primary and additional input formats, transaction policy; or a
 *  virtual media set reading from an Amazon S3 connection. */
export function NewMediaSetDialog({ onClose, onCreated, parent, folderToConvert, virtualSource }: {
  onClose: () => void;
  onCreated: (m: MediaSet) => void;
  parent?: PickedFolder;
  /** turn this existing folder into a media set */
  folderToConvert?: { id: string; name: string };
  /** start as a virtual media set over this Amazon S3 connection and folder (Data Connection) */
  virtualSource?: { connection: DbConnection; folder: string };
}) {
  const [schemas, setSchemas] = useState<SchemaInfo[] | null>(null);
  const [name, setName] = useState(folderToConvert?.name ?? "");
  const [folder, setFolder] = useState<PickedFolder | null>(parent ?? null);
  const [picking, setPicking] = useState(false);
  const [schema, setSchema] = useState<MediaSchema>("image");
  const [primary, setPrimary] = useState<string>("png");
  const [additional, setAdditional] = useState<string[]>([]);
  const [policy, setPolicy] = useState<TransactionPolicy>("transactionless");
  const [virtual, setVirtual] = useState(!!virtualSource);
  const [conns, setConns] = useState<DbConnection[]>(virtualSource ? [virtualSource.connection] : []);
  const [conn, setConn] = useState(virtualSource?.connection.id ?? "");
  const [srcFolder, setSrcFolder] = useState(virtualSource?.folder || "/");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    mediaSets.schemas().then((s) => setSchemas(s.schemas), (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (virtual && !conns.length) api.dataSources.connections().then((c) => setConns(c.filter((x) => x.kind === "s3")), () => setConns([]));
  }, [virtual, conns.length]);
  const info = schemas?.find((s) => s.id === schema);
  const allowedExtra = useMemo(() => (info && primary ? info.additional[primary] ?? [] : []), [info, primary]);
  const pickSchema = (id: MediaSchema) => {
    const s = schemas?.find((x) => x.id === id);
    setSchema(id);
    setPrimary(s?.formats[0] ?? "");
    setAdditional([]);
  };
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await mediaSets.create({
          name: folderToConvert ? undefined : name.trim(),
          parent_id: folderToConvert ? undefined : folder?.id ?? null,
          folder_id: folderToConvert?.id,
          schema,
          primary_format: schema === "multimodal" ? null : primary,
          additional_formats: virtual ? [] : additional,
          transaction_policy: policy,
          virtual: virtual ? { connection_id: conn, folder: srcFolder } : undefined,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={folderToConvert ? `Make "${folderToConvert.name}" a media set` : "New media set"} icon="image" onClose={onClose} wide>
      <div className="space-y-4 p-4 text-sm">
        {!folderToConvert && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Scanned invoices" className={inputClass} autoFocus />
            </Field>
            <Field label="Folder" hint="Default: My Project / Media sets">
              <button type="button" onClick={() => setPicking(true)} className={`${inputClass} flex items-center gap-2 text-left`}>
                <Icon name="folder" className="h-4 w-4 text-muted" />
                <span className="truncate">{folder?.name ?? "My Project / Media sets"}</span>
              </button>
            </Field>
          </div>
        )}
        <Field label="Media type">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {(schemas ?? []).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => pickSchema(s.id)}
                className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs ${schema === s.id ? "border-ocean bg-ocean/10 text-white" : "border-line-2 text-soft hover:border-ocean/50"}`}
              >
                <Icon name={SCHEMA_ICON[s.id] as IconName} className="h-4 w-4 shrink-0 text-ocean" />
                {s.id === "multimodal" ? "Multimodal" : s.label}
              </button>
            ))}
          </div>
        </Field>
        {schema === "multimodal" ? (
          <p className="text-xs text-muted">A multimodal media set accepts any file format. Previews and transformations work for items of the supported media types.</p>
        ) : (
          info && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Primary format" hint="Every item is stored in this format">
                <select
                  value={primary}
                  onChange={(e) => {
                    setPrimary(e.target.value);
                    setAdditional([]);
                  }}
                  className={inputClass}
                >
                  {info.formats.map((f) => (
                    <option key={f} value={f}>
                      .{f}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Additional input formats" hint={allowedExtra.length ? "Converted to the primary format on upload" : "This primary format takes none"}>
                <div className="flex flex-wrap gap-1">
                  {allowedExtra.map((f) => (
                    <label key={f} className={`flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${additional.includes(f) ? "border-ocean bg-ocean/10" : "border-line-2"} ${virtual ? "opacity-40" : ""}`}>
                      <input
                        type="checkbox"
                        disabled={virtual}
                        checked={additional.includes(f)}
                        onChange={(e) => setAdditional(e.target.checked ? [...additional, f] : additional.filter((x) => x !== f))}
                        className="accent-[var(--color-ocean)]"
                      />
                      .{f}
                    </label>
                  ))}
                </div>
              </Field>
            </div>
          )
        )}
        <Field label="Transaction policy">
          <div className="grid gap-1.5 sm:grid-cols-2">
            {(
              [
                ["transactionless", "Transactionless", "Uploads are readable at once and cannot be rolled back; builds only add or overwrite items."],
                ["transactional", "Transactional", "Items are added in transactions (at most 10,000 each) that commit or abort as a whole; builds can replace the set."],
              ] as [TransactionPolicy, string, string][]
            ).map(([id, label, hint]) => (
              <label key={id} className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${policy === id ? "border-ocean bg-ocean/10" : "border-line-2"}`}>
                <input type="radio" checked={policy === id} onChange={() => setPolicy(id)} className="mt-0.5 accent-[var(--color-ocean)]" />
                <span>
                  <span className="block font-medium text-soft">{label}</span>
                  <span className="block text-muted">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>
        {!folderToConvert && (
          <div className="rounded-md border border-line-2 p-2.5">
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={virtual} onChange={(e) => setVirtual(e.target.checked)} className="accent-[var(--color-ocean)]" />
              <span className="font-medium text-soft">Virtual media set</span>
              <span className="text-muted">— read items from an Amazon S3 connection without copying them into the platform</span>
            </label>
            {virtual && (
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Field label="Amazon S3 connection" hint="Access key and secret connections">
                  <select value={conn} onChange={(e) => setConn(e.target.value)} className={inputClass}>
                    <option value="">Choose…</option>
                    {conns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Folder in the source">
                  <input value={srcFolder} onChange={(e) => setSrcFolder(e.target.value)} className={`${inputClass} font-mono`} />
                </Field>
                {conns.length === 0 && (
                  <p className="text-xs text-muted sm:col-span-2">
                    No Amazon S3 connections yet:{" "}
                    <Link href="/sources" className="text-ocean hover:underline">
                      add one in Data Connection
                    </Link>
                    .
                  </p>
                )}
              </div>
            )}
          </div>
        )}
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={busy || (!folderToConvert && !name.trim()) || (virtual && !conn)} onClick={create} className={buttonClass.primary}>
            {folderToConvert ? "Make media set" : "Create media set"}
          </button>
        </div>
      </div>
      {picking && (
        <DrivePicker
          title="Folder for the media set"
          folder={{ action: "Choose this folder", onPick: (f) => (setFolder(f), setPicking(false)) }}
          onClose={() => setPicking(false)}
        />
      )}
    </Modal>
  );
}
