"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ErrorBox } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { alertDialog } from "@/lib/dialogs";
import { request, type ObjectType } from "@/lib/ontology";
import type { LinkType } from "@/lib/ontologyModel";

type Backing = { dataset_id: string; name: string; source_column: string; target_column: string; auto_reindex: boolean; synced_at?: string; rows?: number; dangling?: number } | null;

/** The join table dataset of a many-to-many link type: generate one, attach one, re-index or detach. */
export function JoinTableDialog({ lt, onClose, onDone }: { lt: LinkType; onClose: () => void; onDone: () => void }) {
  const [data, setData] = useState<{ backing_dataset: Backing; user_edits: { add: string[][]; remove: string[][] } | null } | null>(null);
  const [form, setForm] = useState({ dataset_id: "", source_column: "", target_column: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => request<NonNullable<typeof data>>(`/link-types/${lt.id}/datasource`).then(setData, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lt.id]);
  const run = async (fn: () => Promise<{ links?: number; rows?: number; dangling?: number }>) => {
    try {
      const r = await fn();
      setMsg(r.links !== undefined ? `${r.links} links from ${r.rows} rows${r.dangling ? ` · ${r.dangling} point to missing objects` : ""}` : "Done");
      setError(null);
      await load();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const b = data?.backing_dataset;
  return (
    <Modal title={`Join table dataset · ${lt.display_name}`} icon="database" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted">
          A dataset with every combination of the two object types&apos; primary keys backs the links. Links users add or remove are kept apart, so re-indexing the dataset does not lose them.
        </p>
        {b ? (
          <div className="space-y-1 rounded-md border border-line p-3 text-xs">
            <div>
              Dataset:{" "}
              <Link href={`/datasets/${b.dataset_id}`} className="text-ocean">
                {b.name}
              </Link>
            </div>
            <div>
              Columns: <span className="font-mono">{b.source_column}</span> → source, <span className="font-mono">{b.target_column}</span> → target
            </div>
            <div className="text-muted">
              {b.rows ?? 0} rows · synced {b.synced_at ? new Date(b.synced_at).toLocaleString() : "never"} · user edits +{data?.user_edits?.add.length ?? 0} −{data?.user_edits?.remove.length ?? 0}
            </div>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => run(() => request(`/link-types/${lt.id}/datasource/reindex`, { method: "POST" }))} className={buttonClass.secondary}>
                <Icon name="refresh" className="h-3.5 w-3.5" /> Re-index
              </button>
              <button type="button" onClick={() => run(() => request(`/link-types/${lt.id}/datasource`, { method: "DELETE" }))} className={buttonClass.ghost}>
                Detach
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" onClick={() => run(() => request(`/link-types/${lt.id}/datasource/generate`, { method: "POST", json: {} }))} className={buttonClass.primary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Generate join table
            </button>
            <div className="text-xs text-muted">or back it with an existing dataset:</div>
            <input value={form.dataset_id} onChange={(e) => setForm({ ...form, dataset_id: e.target.value })} placeholder="Dataset ID" className={inputClass} />
            <div className="flex gap-2">
              <input value={form.source_column} onChange={(e) => setForm({ ...form, source_column: e.target.value })} placeholder="Column → source primary key" className={inputClass} />
              <input value={form.target_column} onChange={(e) => setForm({ ...form, target_column: e.target.value })} placeholder="Column → target primary key" className={inputClass} />
            </div>
            <button type="button" disabled={!form.dataset_id || !form.source_column || !form.target_column} onClick={() => run(() => request(`/link-types/${lt.id}/datasource`, { method: "PUT", json: form }))} className={buttonClass.secondary}>
              Use this dataset
            </button>
          </>
        )}
        {msg && <div className="text-xs text-ok">{msg}</div>}
        <ErrorBox message={error} />
      </div>
    </Modal>
  );
}

/** Turns a foreign-key or join-table link type into one backed by an object type: one backing object per existing link. */
export function ConvertToObjectBackedDialog({ lt, types, onClose, onDone }: { lt: LinkType; types: ObjectType[]; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ backing_object_type_id: "", source_property: "", target_property: "", migrate_links: true });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const candidates = types.filter((t) => t.id !== lt.source.object_type_id && t.id !== lt.target.object_type_id);
  const props = (candidates.find((t) => t.id === form.backing_object_type_id)?.properties ?? []).filter((p) => !["struct", "media", "geoshape", "vector", "attachment"].includes(p.type));
  const submit = async () => {
    setBusy(true);
    try {
      const r = await request<{ links: number; backing_objects_created: number }>(`/link-types/${lt.id}/convert-to-object-backed`, { method: "POST", json: form });
      await alertDialog(`Converted. ${r.links} links · ${r.backing_objects_created} backing objects created.`);
      onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const select = (k: "source_property" | "target_property", label: string) => (
    <label className="block text-xs text-muted">
      {label}
      <select value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className={inputClass}>
        <option value="">Choose a property…</option>
        {props.map((p) => (
          <option key={p.api_name} value={p.api_name}>
            {p.display_name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Modal title={`Convert to object-backed · ${lt.display_name}`} icon="link" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted">
          A backing object type holds one object per link, with a property for each side&apos;s primary key, so links can carry their own properties. Existing links become backing objects (primary key{" "}
          <span className="font-mono">source|target</span>).
        </p>
        <label className="block text-xs text-muted">
          Backing object type
          <select value={form.backing_object_type_id} onChange={(e) => setForm({ ...form, backing_object_type_id: e.target.value, source_property: "", target_property: "" })} className={inputClass}>
            <option value="">Choose an object type…</option>
            {candidates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.display_name}
              </option>
            ))}
          </select>
        </label>
        {select("source_property", "Property → source primary key")}
        {select("target_property", "Property → target primary key")}
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={form.migrate_links} onChange={(e) => setForm({ ...form, migrate_links: e.target.checked })} /> Create backing objects for existing links
        </label>
        <ErrorBox message={error} />
        <div className="flex justify-end">
          <button type="button" disabled={busy || !form.backing_object_type_id || !form.source_property || !form.target_property} onClick={submit} className={buttonClass.primary}>
            Convert
          </button>
        </div>
      </div>
    </Modal>
  );
}
