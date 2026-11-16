"use client";

import { useEffect, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { Loading } from "@/components/States";
import { iceberg, type Bucket, type IcebergSettings as Settings, type Override } from "@/lib/iceberg";

const PROVIDERS: { id: Bucket["provider"]; label: string; placeholder: string; creds: string[] }[] = [
  { id: "s3", label: "AWS S3", placeholder: "s3://bucket-name/base-path/", creds: ["s3.access-key-id", "s3.secret-access-key", "s3.region"] },
  { id: "abfs", label: "Azure ABFS (dfs.core.windows.net)", placeholder: "abfss://container@account.dfs.core.windows.net/base-path", creds: ["adls.account-name", "adls.account-key"] },
  { id: "gcs", label: "Google GCS", placeholder: "gs://bucket-name/base-path", creds: ["gcs.oauth2.token"] },
  { id: "local", label: "Directory on the server", placeholder: "/mnt/iceberg", creds: [] },
];

/** Control Panel → Iceberg table settings: enable Iceberg, storage locations (bring-your-own-bucket), enrollment-wide
 *  defaults (projects, storage, client-side encryption) and project / namespace overrides. Administrators edit. */
export function IcebergSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [newBucket, setNewBucket] = useState<Bucket | null>(null);
  useEffect(() => {
    iceberg.settings().then(
      (v) => {
        setS(v);
        setDraft(v);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  if (error && !s) return <p className="text-sm text-bad">{error}</p>;
  if (!s || !draft) return <Loading />;
  const edit = s.can_edit;
  const set = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch });
  const save = async (next: Settings = draft) => {
    try {
      const v = await iceberg.saveSettings({
        enabled: next.enabled,
        allow_all_projects: next.allow_all_projects,
        default_storage: next.default_storage,
        cse: next.cse,
        dr_lookback_days: next.dr_lookback_days,
        buckets: next.buckets,
        overrides: next.overrides.map((o) => ({ target_id: o.target_id, storage: o.storage, cse: o.cse })),
      });
      setS(v);
      setDraft(v);
      setError(null);
      setNotice("Saved. New settings apply to tables created from now on; existing tables keep their storage and encryption.");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const storages = [{ id: "managed", name: "Foundry-managed storage" }, ...draft.buckets.map((b) => ({ id: b.id, name: b.name }))];
  return (
    <>
      <h1 className="text-xl font-semibold">Iceberg table settings</h1>
      <p className="mb-5 mt-1 text-sm text-muted">
        Storage and encryption for Foundry-managed Iceberg tables. Only Enrollment Administrators or Information Security Officers (administrators here) can change them.
        Server-side encryption is always required; client-side Iceberg table encryption is optional (and makes new tables format version 3).
      </p>
      {notice && <p className="mb-3 rounded-md bg-ok/10 px-3 py-2 text-xs text-ok">{notice}</p>}
      {error && <p className="mb-3 rounded-md bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>}
      <section className="mb-4 rounded-xl border border-line bg-panel p-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" disabled={!edit} checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enable Foundry Iceberg
        </label>
        <p className="mt-1 text-xs text-muted">Turns the Iceberg catalog on for the enrollment: Iceberg tables can be created and written.</p>
      </section>
      <section className="mb-4 rounded-xl border border-line bg-panel p-4">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="font-medium">Iceberg storage buckets</h2>
          {edit && (
            <button type="button" onClick={() => setNewBucket({ id: "", name: "", provider: "s3", uri: "", fileio: {}, access_delegation: "vended-credentials", credentials: {} })} className={`${buttonClass.secondary} ml-auto py-1 text-xs`}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Configure bucket
            </button>
          )}
        </div>
        <ul className="space-y-1 text-xs">
          <li className="flex items-center gap-2 rounded-md bg-panel-2 px-2 py-1.5">
            <Icon name="server" className="h-3.5 w-3.5 text-ocean" /> Foundry-managed storage <span className="text-muted">· SSE enforced by the platform</span>
          </li>
          {draft.buckets.map((b) => (
            <li key={b.id} className="flex items-center gap-2 rounded-md bg-panel-2 px-2 py-1.5">
              <Icon name="database" className="h-3.5 w-3.5 text-ocean" />
              <span className="font-medium">{b.name}</span>
              <span className="font-mono text-muted">{b.uri}</span>
              <span className="text-muted">
                · {b.access_delegation === "vended-credentials" ? "credential vending" : "no access delegation"}
                {b.has_credentials ? " · credentials set" : ""}
              </span>
              {edit && (
                <button type="button" onClick={() => setDraft({ ...draft, buckets: draft.buckets.filter((x) => x.id !== b.id) })} className="ml-auto text-muted hover:text-bad">
                  <Icon name="trash" className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-muted">
          A bring-your-own-bucket location: provision the bucket (S3 with an IAM role allowing Get/Put/Delete/ListBucket and KMS, ADLS with Storage Blob Data
          Contributor, or GCS with Storage Object Admin), enforce server-side encryption on it, then add it here. Without a base path, Foundry uses foundry-iceberg. Do not
          change a base path once tables use it.
        </p>
      </section>
      <section className="mb-4 rounded-xl border border-line bg-panel p-4">
        <h2 className="mb-2 font-medium">Configure global Iceberg storage</h2>
        <div className="space-y-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={!edit} checked={draft.allow_all_projects} onChange={(e) => set({ allow_all_projects: e.target.checked })} /> Allow writing Iceberg
            tables by default to all projects
          </label>
          <label className="block">
            <span className="text-xs text-muted">Default storage for newly created Iceberg tables</span>
            <select disabled={!edit} value={draft.default_storage} onChange={(e) => set({ default_storage: e.target.value })} className={`${fieldClass} block py-1 text-sm`}>
              {storages.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={!edit} checked={draft.cse} onChange={(e) => set({ cse: e.target.checked })} /> Iceberg table encryption (client-side encryption)
          </label>
          <p className="text-xs text-warn">Client-side encryption is new and evolving: not every Foundry feature, engine or tool reads such tables yet.</p>
          <label className="block">
            <span className="text-xs text-muted">Disaster recovery lookback (days): files of expired snapshots and orphan files are kept this long</span>
            <input type="number" disabled={!edit} min={0} value={draft.dr_lookback_days} onChange={(e) => set({ dr_lookback_days: Number(e.target.value) })} className={`${fieldClass} block w-32 py-1 text-sm`} />
          </label>
        </div>
      </section>
      <section className="mb-4 rounded-xl border border-line bg-panel p-4">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="font-medium">Customize storage</h2>
          {edit && (
            <button type="button" onClick={() => setPicking(true)} className={`${buttonClass.secondary} ml-auto py-1 text-xs`}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Add project or namespace
            </button>
          )}
        </div>
        <p className="mb-2 text-xs text-muted">Overrides for a Project or a namespace (folder) apply to tables written there from now on; the most specific one wins.</p>
        {draft.overrides.length === 0 && <p className="text-xs text-muted">No overrides.</p>}
        {draft.overrides.map((o, i) => (
          <OverrideRow
            key={o.target_id}
            o={o}
            storages={storages}
            edit={edit}
            onChange={(patch) => setDraft({ ...draft, overrides: draft.overrides.map((x, j) => (j === i ? { ...x, ...patch } : x)) })}
            onRemove={() => setDraft({ ...draft, overrides: draft.overrides.filter((_, j) => j !== i) })}
          />
        ))}
      </section>
      {edit && (
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setDraft(s)} className={buttonClass.secondary}>
            Discard changes
          </button>
          <button type="button" onClick={() => save()} className={buttonClass.primary}>
            Save settings
          </button>
        </div>
      )}
      {!edit && <p className="text-xs text-muted">Only administrators can change Iceberg table settings.</p>}
      {picking && (
        <DrivePicker
          title="Override Iceberg storage for a Project or folder"
          folder={{
            action: "Override here",
            onPick: (f) => {
              setPicking(false);
              if (!f.id || draft.overrides.some((o) => o.target_id === f.id)) return;
              setDraft({ ...draft, overrides: [...draft.overrides, { target_id: f.id, storage: null, cse: null, name: f.name, path: [f.name] }] });
            },
          }}
          onClose={() => setPicking(false)}
        />
      )}
      {newBucket && (
        <BucketForm
          b={newBucket}
          onCancel={() => setNewBucket(null)}
          onAdd={(b) => {
            setNewBucket(null);
            const next = { ...draft, buckets: [...draft.buckets, b] };
            setDraft(next);
            void save(next);
          }}
        />
      )}
    </>
  );
}

function OverrideRow({ o, storages, edit, onChange, onRemove }: { o: Override; storages: { id: string; name: string }[]; edit: boolean; onChange: (p: Partial<Override>) => void; onRemove: () => void }) {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-2 rounded-md bg-panel-2 px-2 py-1.5 text-xs">
      <Icon name={o.scope === "project" ? "project" : "folder"} className="h-3.5 w-3.5 text-ocean" />
      <span className="min-w-40 font-medium">{(o.path ?? [o.name]).join(" / ")}</span>
      <label className="flex items-center gap-1">
        Storage
        <select disabled={!edit} value={o.storage ?? ""} onChange={(e) => onChange({ storage: e.target.value || null })} className={`${fieldClass} py-0.5 text-xs`}>
          <option value="">Enrollment default</option>
          {storages.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        Client-side encryption
        <select disabled={!edit} value={o.cse === null || o.cse === undefined ? "" : o.cse ? "on" : "off"} onChange={(e) => onChange({ cse: e.target.value === "" ? null : e.target.value === "on" })} className={`${fieldClass} py-0.5 text-xs`}>
          <option value="">Enrollment default</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </label>
      {edit && (
        <button type="button" onClick={onRemove} className="ml-auto text-muted hover:text-bad">
          <Icon name="trash" className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function BucketForm({ b, onCancel, onAdd }: { b: Bucket; onCancel: () => void; onAdd: (b: Bucket) => void }) {
  const [d, setD] = useState<Bucket>(b);
  const spec = PROVIDERS.find((p) => p.id === d.provider)!;
  const [fileio, setFileio] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4">
      <div className="w-full max-w-lg space-y-3 rounded-xl border border-line bg-panel p-4 text-sm shadow-2xl">
        <h3 className="font-medium">Configure an Iceberg storage bucket</h3>
        <label className="block">
          <span className="text-xs text-muted">Name</span>
          <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} className={inputClass} />
        </label>
        <label className="block">
          <span className="text-xs text-muted">Storage</span>
          <select value={d.provider} onChange={(e) => setD({ ...d, provider: e.target.value as Bucket["provider"], credentials: {} })} className={`${fieldClass} w-full`}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-muted">URI (base path)</span>
          <input value={d.uri} onChange={(e) => setD({ ...d, uri: e.target.value })} placeholder={spec.placeholder} className={`${inputClass} font-mono text-xs`} />
        </label>
        {spec.creds.map((k) => (
          <label key={k} className="block">
            <span className="text-xs text-muted">{k}</span>
            <input
              type={k.includes("secret") || k.includes("key") || k.includes("token") ? "password" : "text"}
              value={d.credentials?.[k] ?? ""}
              onChange={(e) => setD({ ...d, credentials: { ...(d.credentials ?? {}), [k]: e.target.value } })}
              className={`${inputClass} font-mono text-xs`}
            />
          </label>
        ))}
        <label className="block">
          <span className="text-xs text-muted">Custom FileIO properties (key=value per line)</span>
          <textarea value={fileio} onChange={(e) => setFileio(e.target.value)} rows={2} className={`${inputClass} font-mono text-xs`} placeholder="s3.endpoint=https://…" />
        </label>
        <label className="block">
          <span className="text-xs text-muted">Access delegation</span>
          <select value={d.access_delegation} onChange={(e) => setD({ ...d, access_delegation: e.target.value as Bucket["access_delegation"] })} className={`${fieldClass} w-full`}>
            <option value="vended-credentials">Credential vending to authorized clients</option>
            <option value="none">None (clients need their own access)</option>
          </select>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!d.name.trim() || !d.uri.trim()}
            onClick={() =>
              onAdd({
                ...d,
                fileio: Object.fromEntries(
                  fileio
                    .split("\n")
                    .map((l) => l.split("=").map((x) => x.trim()))
                    .filter((p) => p[0] && p.length > 1)
                    .map((p) => [p[0], p.slice(1).join("=")]),
                ),
              })
            }
            className={buttonClass.primary}
          >
            Add bucket
          </button>
        </div>
      </div>
    </div>
  );
}
