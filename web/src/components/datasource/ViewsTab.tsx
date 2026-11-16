"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { views, type DatasetRef, type ViewDef, type ViewPreview } from "@/lib/dataConnection";
import { when } from "@/lib/format";
import { DrivePicker, type PickedFolder } from "../DrivePicker";
import { Icon } from "../Icon";
import { buttonClass, inputClass, Modal } from "../pipeline/Modal";
import { Field, Switch } from "../pipeline/ui";
import { useLoad } from "./DataSourceWizard";
import { EmptyState, ErrorLine, TabPage } from "./dcui";

type Backing = DatasetRef & { label: string };

/** Views: datasets read as the union of backing datasets, with optional primary-key deduplication. */
export function ViewsTab() {
  const list = useLoad("views", () => views.list());
  const [editing, setEditing] = useState<{ id?: string } | null>(null);
  const rows = list.data ?? list.last;
  return (
    <TabPage
      title="Views"
      description="A View holds no data: it reads as the union of its backing datasets. With a primary key it keeps the latest row per key (by the ordering columns) and drops keys whose latest row is marked deleted — ideal over incremental or changelog data. Pipelines and exports read Views like datasets."
      actions={
        <button type="button" onClick={() => setEditing({})} className={buttonClass.primary}>
          <Icon name="plus" /> New View
        </button>
      }
    >
      {list.error && <ErrorLine text={list.error} onRetry={list.retry} />}
      {!rows ? (
        !list.error && <p className="text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState icon="eye" title="No Views yet" text="Union several datasets with the same columns, or deduplicate an appended changelog to its latest state, without copying data." action={<button type="button" onClick={() => setEditing({})} className={buttonClass.primary}><Icon name="plus" /> New View</button>} />
      ) : (
        <ul className="space-y-2">
          {rows.map((v) => (
            <li key={v.id}>
              <button type="button" onClick={() => setEditing({ id: v.id })} className="flex w-full items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-left hover:border-ocean/50">
                <Icon name="eye" className="h-4 w-4 text-ocean" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{v.name}</span>
                  <span className="block truncate text-xs text-muted">{["Files & Projects", ...(v.path ?? []).map((p) => p.name)].join(" / ")}</span>
                </span>
                <span className="text-xs text-muted">updated {when(v.updated_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <ViewEditor
          id={editing.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.retry();
          }}
        />
      )}
    </TabPage>
  );
}

function ViewEditor({ id, onClose, onSaved }: { id?: string; onClose: () => void; onSaved: () => void }) {
  const existing = useLoad(id ? `view:${id}` : null, () => views.get(id!));
  const sources = useLoad("sources", () => api.dataSources.sources());
  const [draft, setDraft] = useState<{ name: string; location: PickedFolder; backing: Backing[]; def: Omit<ViewDef, "backing"> } | null>(null);
  const loaded = existing.data;
  const d =
    draft ??
    (loaded
      ? {
          name: loaded.item.name,
          location: { id: loaded.item.parent_id, name: "" },
          backing: loaded.definition.backing.map((b) => ({ ...b, label: b.name })) as Backing[],
          def: { primary_key: loaded.definition.primary_key, ordering: loaded.definition.ordering, deletion_column: loaded.definition.deletion_column, schema_evolution: loaded.definition.schema_evolution },
        }
      : { name: "", location: { id: null, name: "Files & Projects" }, backing: [], def: { primary_key: [], ordering: [], deletion_column: null, schema_evolution: false } });
  const set = (patch: Partial<typeof d>) => setDraft({ ...d, ...patch });
  const setDef = (patch: Partial<typeof d.def>) => setDraft({ ...d, def: { ...d.def, ...patch } });
  const [picking, setPicking] = useState<"dataset" | "folder" | null>(null);
  const [preview, setPreview] = useState<ViewPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const definition = (): ViewDef => ({ ...d.def, backing: d.backing.map(({ label: _l, ...r }) => (void _l, r as DatasetRef)) });
  const columns = preview?.columns ?? [];
  const pkLocked = !!loaded?.definition.primary_key.length;

  const runPreview = async () => {
    setError(null);
    try {
      setPreview(await views.preview(definition()));
    } catch (e) {
      setError((e as Error).message);
      setPreview(null);
    }
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (id) await views.update(id, definition());
      else await views.create(d.name.trim(), d.location.id, definition());
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={id ? `View ${loaded?.item.name ?? ""}` : "New View"} icon="eye" onClose={onClose} wide>
      <div className="max-h-[80vh] space-y-4 overflow-y-auto p-5 text-sm">
        {id && !loaded ? (
          <p className="text-muted">{existing.error ?? "Loading…"}</p>
        ) : (
          <>
            {!id && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name" required>
                  <input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Latest orders" className={inputClass} />
                </Field>
                <Field label="Location">
                  <button type="button" onClick={() => setPicking("folder")} className={`${buttonClass.secondary} w-full justify-start`}>
                    <Icon name="folder" className="h-3.5 w-3.5" /> {d.location.name || "Files & Projects"}
                  </button>
                </Field>
              </div>
            )}
            <div>
              <div className="mb-1 text-xs font-medium text-soft">Backing datasets</div>
              <p className="mb-2 text-xs text-muted">Every backing dataset must have the same column names and types (any order) — or turn on schema evolution.</p>
              <ul className="mb-2 space-y-1">
                {d.backing.map((b, i) => (
                  <li key={i} className="flex items-center gap-2 rounded-md border border-line-2 px-2 py-1.5 text-xs">
                    <Icon name={b.kind === "source" ? "database" : "table"} className="h-3.5 w-3.5 text-ocean" />
                    <span className="flex-1 truncate">{b.label}</span>
                    <button type="button" onClick={() => set({ backing: d.backing.filter((_, j) => j !== i) })} className="text-muted hover:text-bad">
                      <Icon name="x" className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setPicking("dataset")} className={`${buttonClass.secondary} py-1 text-xs`}>
                  <Icon name="plus" className="h-3 w-3" /> Dataset from Files
                </button>
                <select
                  value=""
                  onChange={(e) => {
                    const s = sources.data?.find((x) => x.id === e.target.value);
                    if (s) set({ backing: [...d.backing, { kind: "source", id: s.id, label: s.name }] });
                  }}
                  className={`${inputClass} w-64 py-1 text-xs`}
                >
                  <option value="">+ A data source…</option>
                  {(sources.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <button type="button" disabled={!d.backing.length} onClick={runPreview} className={`${buttonClass.secondary} ml-auto py-1 text-xs`}>
                  <Icon name="eye" className="h-3 w-3" /> Preview
                </button>
              </div>
            </div>
            <Switch on={d.def.schema_evolution} onChange={(schema_evolution) => setDef({ schema_evolution })} label="Schema evolution" hint="Backing datasets may miss columns; they are read as null." />
            <div className="rounded-lg border border-line-2 p-3">
              <div className="mb-2 text-xs font-medium text-soft">Primary key (optional)</div>
              {!columns.length && <p className="mb-2 text-xs text-muted">Preview the View to choose its columns.</p>}
              <div className="grid gap-3 md:grid-cols-3">
                <Field label="Primary key columns" hint={pkLocked ? "Set when the View was created — create a new View to change it." : "No nulls allowed."}>
                  <ColumnChecks columns={columns.map((c) => c.name)} value={d.def.primary_key} disabled={pkLocked} onChange={(primary_key) => setDef({ primary_key })} />
                </Field>
                <Field label="Resolve duplicates by" hint="The row with the highest values of these columns (in order) wins.">
                  <ColumnChecks columns={columns.map((c) => c.name)} value={d.def.ordering} onChange={(ordering) => setDef({ ordering })} />
                </Field>
                <Field label="Deletion column" hint="Boolean: a key whose latest row is true is removed.">
                  <select value={d.def.deletion_column ?? ""} onChange={(e) => setDef({ deletion_column: e.target.value || null })} className={inputClass}>
                    <option value="">None</option>
                    {columns
                      .filter((c) => c.type === "Boolean")
                      .map((c) => (
                        <option key={c.name}>{c.name}</option>
                      ))}
                  </select>
                </Field>
              </div>
            </div>
            {preview && (
              <div>
                <div className="mb-1 text-xs text-muted">
                  {preview.total_rows.toLocaleString()} rows · first {preview.rows.length} shown
                </div>
                <div className="max-h-64 overflow-auto rounded-lg border border-line">
                  <table className="min-w-full text-xs">
                    <thead className="sticky top-0 bg-panel">
                      <tr>
                        {preview.columns.map((c) => (
                          <th key={c.name} className="whitespace-nowrap px-2 py-1 text-left font-medium">
                            {c.name} <span className="font-normal text-muted">{c.type}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r, i) => (
                        <tr key={i} className="border-t border-line">
                          {preview.columns.map((c) => (
                            <td key={c.name} className="max-w-xs truncate whitespace-nowrap px-2 py-1">
                              {r[c.name] === null || r[c.name] === undefined ? <span className="text-muted">null</span> : String(r[c.name])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {error && <ErrorLine text={error} />}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className={buttonClass.secondary}>
                Cancel
              </button>
              <button type="button" disabled={busy || !d.backing.length || (!id && !d.name.trim())} onClick={save} className={buttonClass.primary}>
                <Icon name="save" className="h-3.5 w-3.5" /> {busy ? "Saving…" : id ? "Save View" : "Create View"}
              </button>
            </div>
          </>
        )}
      </div>
      {picking === "dataset" && (
        <DrivePicker
          title="Add a backing dataset"
          canPick={(i) => (i.kind === "file" && /\.parquet$/i.test(i.name) ? null : "Views are backed by Parquet datasets")}
          onPick={(i) => {
            set({ backing: [...d.backing, { kind: "file", item_id: i.id, label: i.name }] });
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}
      {picking === "folder" && (
        <DrivePicker
          title="Where to create the View"
          folder={{
            action: "Create here",
            onPick: (f) => {
              set({ location: f });
              setPicking(null);
            },
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </Modal>
  );
}

function ColumnChecks({ columns, value, onChange, disabled }: { columns: string[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const all = [...new Set([...value, ...columns])];
  if (!all.length) return <p className="text-xs text-muted">—</p>;
  return (
    <div className="max-h-32 space-y-0.5 overflow-y-auto">
      {all.map((c) => (
        <label key={c} className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" disabled={disabled} checked={value.includes(c)} onChange={(e) => onChange(e.target.checked ? [...value, c] : value.filter((x) => x !== c))} />
          <span className="truncate">{c}</span>
          {value.includes(c) && value.length > 1 && <span className="text-muted">#{value.indexOf(c) + 1}</span>}
        </label>
      ))}
    </div>
  );
}
