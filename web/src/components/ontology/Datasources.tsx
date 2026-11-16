"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { Card, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { PROPERTY_TYPES, request, type ObjectType, type PropertyType } from "@/lib/ontology";
import { workshop } from "@/lib/workshop";

export type DatasetColumn = {
  name: string;
  type: string;
  property_type: PropertyType | null;
  array: boolean;
  supported: boolean;
  unique?: boolean;
  api_name?: string;
  display_name?: string;
  sample?: unknown[];
  property?: string | null;
};
/** What a re-index met that its properties do not allow (api/ontology_datasources.py "disallowed dataset values"). */
export type InvalidValuesReport = {
  mode: "null" | "fail";
  total: number;
  rows_listed: number;
  row_limit: number;
  counts: { column: string | null; property: string | null; code: string; count: number }[];
  rows: { row: number; primary_key: string | null; column: string | null; property: string | null; code: string; value: unknown; reason: string }[];
};
export type SchemaError = { code: string; column: string | null; message: string; report?: InvalidValuesReport };
export type Datasource = {
  backing: {
    dataset_id: string;
    name: string;
    columns: Record<string, string>;
    synced_at: string;
    dataset_updated_at: string;
    auto_reindex?: boolean;
    /** A changelog datasource: rows are versions of objects (the last row per primary key wins), deleted where the deletion column is true. */
    changelog?: { deletion_column: string | null } | null;
    /** A dataset value its property does not allow: indexed as null (absent, the default) or the whole re-index fails. */
    invalid_values?: "null" | "fail";
  } | null;
  dataset?: { id: string; name: string; updated_at: string };
  rows?: number;
  columns?: DatasetColumn[];
  errors?: SchemaError[];
  unmapped_columns?: string[];
  unmapped_properties?: string[];
  stale?: boolean;
  imported?: number;
};
export type Impact = {
  objects: number;
  link_types: { id: string; display_name: string; status?: string }[];
  action_types: { id: string; display_name: string }[];
  automations: { id: string; name: string }[];
  interfaces: string[];
  workshop_modules: { id: string; name: string }[];
  edited_properties: string[];
  backing_dataset: string | null;
};

export const datasources = {
  schema: (datasetId: string) => request<{ id: string; name: string; rows: number; columns: DatasetColumn[]; registered_by: { id: string; display_name: string } | null }>(`/datasets/${datasetId}/schema`),
  fromDataset: (body: Record<string, unknown>) => request<ObjectType & { imported: number }>("/object-types/from-dataset", { method: "POST", json: body }),
  get: (typeId: string) => request<Datasource>(`/object-types/${typeId}/datasource`),
  put: (
    typeId: string,
    body: { dataset_id: string; columns?: Record<string, string>; map_unmapped?: boolean; auto_reindex?: boolean; changelog?: boolean; deletion_column?: string | null; invalid_values?: "null" | "fail" },
  ) =>
    request<Datasource>(`/object-types/${typeId}/datasource`, { method: "PUT", json: body }),
  remove: (typeId: string) => request<unknown>(`/object-types/${typeId}/datasource`, { method: "DELETE" }),
  reindex: (typeId: string) => request<{ imported: number; synced_at: string }>(`/object-types/${typeId}/datasource/reindex`, { method: "POST" }),
  impact: (typeId: string) => request<Impact>(`/object-types/${typeId}/impact`),
  /** The type's indexing runs, newest first (api/ontology_indexing.py). */
  runs: (typeId: string) => request<{ runs: { status: string; invalid_values?: InvalidValuesReport }[] }>(`/object-types/${typeId}/indexing`),
};

const ICONS: IconName[] = ["cube", "project", "globe", "doc", "bolt", "device", "database", "folder", "image", "wave", "graph", "layers", "check", "table", "code", "sparkle", "alert", "info", "cpu", "gauge", "bell", "bug", "home"];
export const COLORS = ["#4f8cff", "#2bb673", "#f2a33a", "#e5534b", "#a371f7", "#39c5cf", "#d4a373", "#8b949e"];

/** An object type's icon in its color. */
export function TypeIcon({ t, className = "h-4 w-4", box = "rounded-md p-1" }: { t: { icon?: string; color?: string | null }; className?: string; box?: string }) {
  const name = (ICONS as string[]).includes(t.icon ?? "") ? (t.icon as IconName) : "cube";
  return (
    <span className={`${box} ${t.color ? "" : "bg-ocean/15 text-ocean"}`} style={t.color ? { color: t.color, background: `${t.color}26` } : undefined}>
      <Icon name={name} className={className} />
    </span>
  );
}

/** Icon and color pickers for object types. */
export function IconColor({ icon, color, onChange }: { icon?: string; color?: string | null; onChange: (c: { icon?: string; color?: string }) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ICONS.map((i) => (
        <button key={i} type="button" onClick={() => onChange({ icon: i })} title={i} className={`rounded-md p-1.5 ring-1 ${icon === i ? "ring-ocean" : "ring-line-2 hover:ring-ocean/50"}`}>
          <span style={{ color: color ?? undefined }}>
            <Icon name={i} className="h-4 w-4" />
          </span>
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-line-2" />
      {COLORS.map((c) => (
        <button key={c} type="button" onClick={() => onChange({ color: c })} title={c} className={`h-5 w-5 rounded-full ring-2 ${color === c ? "ring-white" : "ring-transparent"}`} style={{ background: c }} />
      ))}
      {/* any other color (committed when the picker closes) */}
      <input
        type="color"
        aria-label="Custom color"
        title={color && !COLORS.includes(color) ? color : "Custom color"}
        value={/^#[0-9a-f]{6}$/i.test(color ?? "") ? (color as string) : "#4f8cff"}
        onChange={(e) => onChange({ color: e.target.value })}
        className={`h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0 ring-2 ${color && !COLORS.includes(color) ? "ring-white" : "ring-transparent"}`}
      />
    </div>
  );
}

/** A datasource's changelog setting: rows as versions of objects, and the Boolean column whose true value deletes the object. */
function ChangelogFields({
  on,
  deletion,
  columns,
  disabled,
  onChange,
}: {
  on: boolean;
  deletion: string;
  columns: DatasetColumn[];
  disabled?: boolean;
  onChange: (on: boolean, deletion: string) => void;
}) {
  const bools = columns.filter((c) => c.property_type === "boolean" && !c.array).map((c) => c.name);
  if (deletion && !bools.includes(deletion)) bools.push(deletion); // (no longer a Boolean column: the save reports it)
  return (
    <div className="space-y-2 text-sm">
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked, e.target.checked ? deletion : "")} />
        <span>
          Changelog dataset
          <span className="block text-xs text-muted">
            Rows are versions of objects: the last row of each primary key wins, so a key may repeat. Appended transactions are applied as inserts, updates and deletes. Versions are ordered by
            transaction and row order (as in Object Storage v2): order them by your ordering column upstream.
          </span>
        </span>
      </label>
      {on && (
        <div className="flex flex-wrap items-center gap-2 pl-6 text-xs">
          <span className="text-muted">Deletion column</span>
          <select value={deletion} disabled={disabled} onChange={(e) => onChange(true, e.target.value)} className={`${fieldClass} w-64 py-1 text-xs`} aria-label="Deletion column">
            <option value="">None: rows never delete objects</option>
            {bools.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <span className="text-muted">{bools.length ? "Where its last row holds true, the object is deleted." : "The dataset has no Boolean column."}</span>
        </div>
      )}
    </div>
  );
}

const INVALID_KINDS: Record<string, string> = {
  InvalidValue: "Not a valid value of the type",
  ValueTypeConstraint: "Outside the value type",
  RequiredPropertyNull: "Required, but null",
  NullPrimaryKey: "No primary key",
  DuplicatePrimaryKey: "Repeated primary key",
};

const cellText = (v: unknown) => (v === null || v === undefined ? "null" : typeof v === "string" ? v : JSON.stringify(v));

/** A re-index's disallowed values: counts per column / property / kind, and the first offending rows. */
export function InvalidValuesTable({ report }: { report: InvalidValuesReport }) {
  return (
    <div className="space-y-2 text-xs" data-testid="invalid-values-report">
      <div className="text-muted">
        {report.total.toLocaleString()} disallowed value{report.total === 1 ? "" : "s"} · {report.mode === "fail" ? "the re-index failed: nothing was written" : "indexed as null"}
      </div>
      <table className="w-full">
        <thead className="text-left text-muted">
          <tr>
            <th className="py-1 pr-3 font-medium">Column</th>
            <th className="py-1 pr-3 font-medium">Property</th>
            <th className="py-1 pr-3 font-medium">Problem</th>
            <th className="py-1 text-right font-medium">Values</th>
          </tr>
        </thead>
        <tbody>
          {report.counts.map((c, i) => (
            <tr key={i} className="border-t border-line">
              <td className="py-1 pr-3 font-mono">{c.column ?? "—"}</td>
              <td className="py-1 pr-3 font-mono">{c.property ?? "—"}</td>
              <td className="py-1 pr-3" title={c.code}>
                {INVALID_KINDS[c.code] ?? c.code}
              </td>
              <td className="py-1 text-right tabular-nums">{c.count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details>
        <summary className="cursor-pointer text-muted">
          First {report.rows_listed} offending row{report.rows_listed === 1 ? "" : "s"}
          {report.total > report.rows_listed ? ` of ${report.total.toLocaleString()}` : ""}
        </summary>
        <table className="mt-1 w-full">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">Row</th>
              <th className="py-1 pr-3 font-medium">Primary key</th>
              <th className="py-1 pr-3 font-medium">Column</th>
              <th className="py-1 pr-3 font-medium">Value</th>
              <th className="py-1 font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r, i) => (
              <tr key={i} className="border-t border-line align-top">
                <td className="py-1 pr-3 tabular-nums">{r.row.toLocaleString()}</td>
                <td className="py-1 pr-3 font-mono">{r.primary_key ?? "—"}</td>
                <td className="py-1 pr-3 font-mono">{r.column ?? "—"}</td>
                <td className="max-w-[16rem] truncate py-1 pr-3 font-mono" title={cellText(r.value)}>
                  {cellText(r.value)}
                </td>
                <td className="py-1">{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

type Col = DatasetColumn & { include: boolean; api: string; label: string; ptype: PropertyType };

/** Create an object type from a dataset: every column a property (curated: include, rename, retype), the primary key checked for uniqueness. */
export function FromDatasetDialog({ ontologyId, onClose, onCreated }: { ontologyId: string; onClose: () => void; onCreated: (t: ObjectType) => void }) {
  const [datasets, setDatasets] = useState<{ id: string; name: string; path: string[] }[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [cols, setCols] = useState<Col[] | null>(null);
  const [registered, setRegistered] = useState<string | null>(null);
  const [rows, setRows] = useState(0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("cube");
  const [color, setColor] = useState<string | undefined>();
  const [pk, setPk] = useState("");
  const [title, setTitle] = useState("");
  const [actions, setActions] = useState<string[]>(["create", "modify"]);
  const [changelog, setChangelog] = useState(false);
  const [deletion, setDeletion] = useState("");
  const [strict, setStrict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    workshop.sources().then((s) => setDatasets(s.datasets), (e: Error) => setError(e.message));
  }, []);
  const pick = async (id: string) => {
    setDatasetId(id);
    setCols(null);
    setError(null);
    setChangelog(false);
    setDeletion("");
    if (!id) return;
    try {
      const s = await datasources.schema(id);
      setRows(s.rows);
      setRegistered(s.registered_by?.display_name ?? null);
      setName((n) => n || s.name.replace(/\.parquet$/i, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
      const cs = s.columns.map((c) => ({ ...c, include: c.supported, api: c.api_name ?? c.name, label: c.display_name ?? c.name, ptype: (c.property_type ?? "string") as PropertyType }));
      setCols(cs);
      const firstUnique = cs.find((c) => c.unique)?.name ?? "";
      setPk(firstUnique);
      setTitle(cs.find((c) => /name|title/i.test(c.name) && c.supported)?.name ?? firstUnique);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const setC = (i: number, c: Partial<Col>) => setCols((cur) => cur?.map((x, j) => (j === i ? { ...x, ...c } : x)) ?? null);
  // the primary key: a unique column, or for a changelog dataset any scalar column (its rows are versions of objects)
  const keyable = (c: Col) => !!c.unique || (changelog && c.supported && !c.array);
  const create = async () => {
    if (!cols) return;
    setBusy(true);
    setError(null);
    try {
      const t = await datasources.fromDataset({
        dataset_id: datasetId,
        display_name: name.trim(),
        description,
        icon,
        color,
        ontology_id: ontologyId,
        primary_key: pk,
        title_property: title || pk,
        columns: cols.filter((c) => c.include).map((c) => ({ column: c.name, api_name: c.api, display_name: c.label, type: c.ptype, array: c.array })),
        generate_actions: actions,
        changelog,
        deletion_column: changelog ? deletion || null : null,
        invalid_values: strict ? "fail" : "null",
      });
      onCreated(t);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="New object type from a dataset" icon="database" onClose={onClose} wide>
      <div className="space-y-4 p-4 text-sm">
        <Field label="Backing datasource" hint="One object per row; at most one object type per dataset">
          <select value={datasetId} onChange={(e) => pick(e.target.value)} className={inputClass}>
            <option value="">Choose a dataset…</option>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.path.length ? ` — ${d.path.slice(-2).join(" / ")}` : ""}
              </option>
            ))}
          </select>
        </Field>
        {registered && <p className="text-xs text-bad">This dataset already backs {registered} (DatasetAndBranchAlreadyRegistered).</p>}
        {cols && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Display name" hint="A singular, concrete noun a domain expert would recognize">
                <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
              </Field>
              <Field label="Description">
                <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What one object represents" className={inputClass} />
              </Field>
            </div>
            <Field label="Icon">
              <IconColor
                icon={icon}
                color={color}
                onChange={(c) => {
                  if (c.icon) setIcon(c.icon);
                  if (c.color) setColor(c.color);
                }}
              />
            </Field>
            <div>
              <div className="mb-1 flex items-center gap-2 text-xs font-medium text-soft">
                Properties ({cols.filter((c) => c.include).length} of {cols.length} columns · {rows.toLocaleString()} rows)
                <span className="font-normal text-muted">Curate intentionally: leave out ETL and technical columns.</span>
              </div>
              <div className="max-h-80 overflow-y-auto rounded-lg border border-line-2">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-panel text-left text-muted">
                    <tr>
                      <th className="px-2 py-1.5" />
                      <th className="px-2 py-1.5 font-medium">Column</th>
                      <th className="px-2 py-1.5 font-medium">Display name</th>
                      <th className="px-2 py-1.5 font-medium">API name</th>
                      <th className="px-2 py-1.5 font-medium">Base type</th>
                      <th className="px-2 py-1.5 font-medium">Key</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cols.map((c, i) => (
                      <tr key={c.name} className="border-t border-line">
                        <td className="px-2 py-1">
                          <input type="checkbox" disabled={!c.supported || c.name === pk} checked={c.include} onChange={(e) => setC(i, { include: e.target.checked })} />
                        </td>
                        <td className="px-2 py-1">
                          <span className="font-mono">{c.name}</span>
                          <span className="block text-[10px] text-muted">{c.supported ? c.type : `${c.type}: map/struct columns cannot back properties`}</span>
                        </td>
                        <td className="px-2 py-1">
                          <input value={c.label} disabled={!c.include} onChange={(e) => setC(i, { label: e.target.value })} className={`${fieldClass} w-full py-0.5 text-xs`} />
                        </td>
                        <td className="px-2 py-1">
                          <input value={c.api} disabled={!c.include} onChange={(e) => setC(i, { api: e.target.value })} className={`${fieldClass} w-full py-0.5 font-mono text-xs`} />
                        </td>
                        <td className="px-2 py-1">
                          <select value={c.ptype} disabled={!c.include} onChange={(e) => setC(i, { ptype: e.target.value as PropertyType })} className={`${fieldClass} py-0.5 text-xs`}>
                            {PROPERTY_TYPES.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.label}
                                {c.array ? " array" : ""}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap">
                          <label
                            className="mr-2 inline-flex items-center gap-1"
                            title={c.unique ? "Unique and set on every row" : keyable(c) ? "Repeats: each row is a version of its object (changelog)" : "Not unique: cannot be the primary key"}
                          >
                            <input
                              type="radio"
                              name="pk"
                              disabled={!keyable(c)}
                              checked={pk === c.name}
                              onChange={() => {
                                setPk(c.name);
                                setC(i, { include: true });
                              }}
                            />
                            PK
                          </label>
                          <label className="inline-flex items-center gap-1">
                            <input type="radio" name="title" disabled={!c.include} checked={title === c.name} onChange={() => setTitle(c.name)} /> Title
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!pk && (
                <p className="mt-1 text-xs text-bad">
                  {changelog ? "Choose the primary key column." : "No column is unique and set on every row: the dataset needs a primary key column (or is a changelog dataset)."}
                </p>
              )}
            </div>
            <ChangelogFields
              on={changelog}
              deletion={deletion}
              columns={cols}
              onChange={(on, del) => {
                setChangelog(on);
                setDeletion(del);
                // a repeating key column can be the primary key of a changelog dataset only
                if (!on && pk && !cols.find((c) => c.name === pk)?.unique) setPk(cols.find((c) => c.unique)?.name ?? "");
              }}
            />
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={strict} onChange={(e) => setStrict(e.target.checked)} aria-label="Fail the index on disallowed values" />
              <span>
                Fail the index on disallowed values
                <span className="block text-xs text-muted">Off: a value its property does not allow is indexed as null. On: the type is not created while the dataset holds such values.</span>
              </span>
            </label>
            <Field label="Generate action types">
              <div className="flex gap-3">
                {["create", "modify", "delete"].map((k) => (
                  <label key={k} className="flex items-center gap-1.5 capitalize">
                    <input type="checkbox" checked={actions.includes(k)} onChange={(e) => setActions(e.target.checked ? [...actions, k] : actions.filter((x) => x !== k))} /> {k}
                  </label>
                ))}
              </div>
            </Field>
          </>
        )}
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={busy || !cols || !pk || !name.trim() || !!registered} onClick={create} className={buttonClass.primary}>
            {busy ? "Creating and indexing…" : "Create"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The Datasources tab: the backing dataset, column ↔ property mapping, schema errors, re-index and replace. */
export function DatasourcesTab({ t, onChanged }: { t: ObjectType; onChanged: () => void }) {
  const [d, setD] = useState<Datasource | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [datasets, setDatasets] = useState<{ id: string; name: string; path?: string[] }[]>([]);
  const [replacing, setReplacing] = useState("");
  const [edited, setEdited] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cl, setCl] = useState({ on: false, deletion: "" });
  const [inv, setInv] = useState<"null" | "fail">("null");
  // the report of a "Fail the re-index" save the API refused (the dataset holds disallowed values; nothing was saved)
  const [refused, setRefused] = useState<InvalidValuesReport | null>(null);
  const load = useCallback(() => {
    datasources.get(t.id).then(
      (x) => {
        setD(x);
        setMapping(x.backing?.columns ?? {});
        setCl({ on: !!x.backing?.changelog, deletion: x.backing?.changelog?.deletion_column ?? "" });
        setInv(x.backing?.invalid_values === "fail" ? "fail" : "null");
      },
      (e: Error) => setError(e.message),
    );
    datasources.impact(t.id).then((i) => setEdited(i.edited_properties), () => setEdited([]));
  }, [t.id]);
  useEffect(load, [load]);
  useEffect(() => {
    workshop.sources().then((s) => setDatasets(s.datasets), () => setDatasets([]));
  }, []);
  const run = async (f: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await f();
      if (done) setNote(done);
      load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      // a failed re-index keeps its errors, and a disallowed-values report, on the datasource: show them, keeping the
      // unsaved choices in the cards
      datasources.get(t.id).then(setD, () => undefined);
    } finally {
      setBusy(false);
    }
  };
  const saveInvalid = (mode: "null" | "fail") =>
    run(
      async () => {
        setRefused(null);
        const bk = d?.backing;
        if (!bk) return;
        try {
          await datasources.put(t.id, { dataset_id: bk.dataset_id, columns: bk.columns, invalid_values: mode });
        } catch (e) {
          const last = (await datasources.runs(t.id).catch(() => null))?.runs?.[0];
          if (last?.status === "failed" && last.invalid_values) setRefused(last.invalid_values);
          throw e;
        }
      },
      mode === "fail" ? "Saved: a re-index with disallowed values now fails. Re-indexed." : "Saved: disallowed values are indexed as null. Re-indexed.",
    );
  if (!d) return <p className="p-8 text-sm text-muted">Loading…</p>;
  const b = d.backing;
  const props = t.properties.filter((p) => !p.derived);
  const dirty = JSON.stringify(mapping) !== JSON.stringify(b?.columns ?? {});
  const clDirty = cl.on !== !!b?.changelog || (cl.on && cl.deletion !== (b?.changelog?.deletion_column ?? ""));
  const invSaved = b?.invalid_values === "fail" ? "fail" : "null";
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-8">
      <div>
        <h2 className="text-lg font-semibold">Datasources</h2>
        <p className="text-sm text-muted">The dataset that backs {t.display_name}: one object per row, a property per mapped column. Edits survive re-indexing on edit-only properties and properties no column backs.</p>
      </div>
      <ErrorBox message={error} />
      {note && <div className="rounded-md bg-ok/10 px-3 py-2 text-sm text-ok">{note}</div>}
      {!b ? (
        <Card title="No backing datasource">
          <div className="space-y-3 p-4 text-sm">
            <p className="text-muted">Objects of {t.display_name} are created and edited by actions only. Attach a dataset to index its rows (columns map to properties with the same API names).</p>
            <div className="flex gap-2">
              <select value={replacing} onChange={(e) => setReplacing(e.target.value)} className={`${inputClass} flex-1`}>
                <option value="">Choose a dataset…</option>
                {datasets.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.path?.length ? ` — ${x.path.slice(-2).join(" / ")}` : ""}
                  </option>
                ))}
              </select>
              <button type="button" disabled={!replacing || busy} onClick={() => run(() => datasources.put(t.id, { dataset_id: replacing }), "Datasource added and indexed.")} className={buttonClass.primary}>
                Add datasource
              </button>
            </div>
          </div>
        </Card>
      ) : (
        <>
          <Card
            title={b.name}
            action={
              <div className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => run(() => datasources.reindex(t.id), "Re-indexed.")} className={buttonClass.secondary}>
                  <Icon name="refresh" className="h-3.5 w-3.5" /> Re-index
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (await confirmDialog(`Detach ${b.name}? Objects stay and are only changed by actions from now on.`)) await run(() => datasources.remove(t.id), "Datasource removed.");
                  }}
                  className={buttonClass.secondary}
                >
                  Remove
                </button>
              </div>
            }
          >
            <div className="grid gap-2 p-4 text-sm sm:grid-cols-4">
              <div>
                <div className="text-xs text-muted">Rows</div>
                {d.rows?.toLocaleString() ?? "—"}
              </div>
              <div>
                <div className="text-xs text-muted">Last indexed</div>
                {when(b.synced_at)}
              </div>
              <div>
                <div className="text-xs text-muted">Dataset</div>
                {d.stale ? <span className="text-warn">Updated since the last index</span> : "Up to date"}
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={b.auto_reindex !== false} onChange={(e) => run(() => datasources.put(t.id, { dataset_id: b.dataset_id, columns: b.columns, auto_reindex: e.target.checked }))} /> Re-index when the dataset updates
              </label>
            </div>
            {!!d.errors?.length && (
              <div className="space-y-1 border-t border-line px-4 py-3">
                {d.errors.map((e, i) => (
                  <div key={i} className="text-xs text-bad">
                    <span className="font-mono">{e.code}</span>: {e.message}
                    {e.report && (
                      <div className="mt-2 rounded-md border border-line p-2 text-ink">
                        <InvalidValuesTable report={e.report} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card
            title="Changelog"
            action={
              <div className="flex gap-2">
                {clDirty && (
                  <button type="button" disabled={busy} onClick={() => setCl({ on: !!b.changelog, deletion: b.changelog?.deletion_column ?? "" })} className={buttonClass.secondary}>
                    Discard
                  </button>
                )}
                <button
                  type="button"
                  disabled={!clDirty || busy}
                  onClick={() =>
                    run(
                      () => datasources.put(t.id, { dataset_id: b.dataset_id, columns: b.columns, changelog: cl.on, deletion_column: cl.on ? cl.deletion || null : null }),
                      cl.on ? "Changelog setting saved and re-indexed." : "Changelog off: re-indexed with one object per row.",
                    )
                  }
                  className={buttonClass.primary}
                >
                  Save
                </button>
              </div>
            }
          >
            <div className="p-4">
              <ChangelogFields on={cl.on} deletion={cl.deletion} columns={d.columns ?? []} disabled={busy} onChange={(on, deletion) => setCl({ on, deletion })} />
              {clDirty && !cl.on && <p className="mt-2 pl-6 text-xs text-warn">Without the changelog setting the primary key column must be unique and set on every row.</p>}
            </div>
          </Card>
          <Card
            title="Disallowed values"
            action={
              <div className="flex gap-2">
                {inv !== invSaved && (
                  <button type="button" disabled={busy} onClick={() => setInv(invSaved)} className={buttonClass.secondary}>
                    Discard
                  </button>
                )}
                <button
                  type="button"
                  disabled={inv === invSaved || busy}
                  onClick={() => saveInvalid(inv)}
                  className={buttonClass.primary}
                >
                  Save
                </button>
              </div>
            }
          >
            <div className="space-y-2 p-4 text-sm" role="radiogroup" aria-label="Disallowed values">
              <p className="text-xs text-muted">
                A value its property does not allow: the wrong type, outside the property&apos;s value type (allowed values, length, range, pattern), a bad geopoint or timestamp, a null in a required property, a row without a primary key.
              </p>
              <label className="flex items-start gap-2">
                <input type="radio" name={`invalid-${t.id}`} className="mt-1" checked={inv === "null"} disabled={busy} onChange={() => setInv("null")} />
                <span>
                  Index as null
                  <span className="block text-xs text-muted">The default. The value is indexed as null and counted on the indexing run; the rest of the row is indexed.</span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name={`invalid-${t.id}`} className="mt-1" checked={inv === "fail"} disabled={busy} onChange={() => setInv("fail")} />
                <span>
                  Fail the re-index
                  <span className="block text-xs text-muted">
                    Nothing is written: the objects stay as the last index left them, and the run lists the offending rows and columns. Value types and required properties are checked too.
                  </span>
                </span>
              </label>
              {inv !== invSaved && inv === "fail" && <p className="pl-6 text-xs text-warn">Saving re-indexes now: if the dataset holds disallowed values the save is refused and the run shows them.</p>}
              {refused && inv === "fail" && inv !== invSaved && (
                <div className="ml-6 rounded-md border border-bad/40 bg-bad/5 p-2" data-testid="invalid-values-refused">
                  <p className="mb-1 text-xs text-bad">Not saved: the dataset holds values its properties do not allow. Fix them, or keep indexing them as null.</p>
                  <InvalidValuesTable report={refused} />
                </div>
              )}
            </div>
          </Card>
          <Card
            title="Column ↔ property mapping"
            action={
              <div className="flex gap-2">
                {!!d.unmapped_columns?.length && (
                  <button type="button" disabled={busy} onClick={() => run(() => datasources.put(t.id, { dataset_id: b.dataset_id, columns: mapping, map_unmapped: true }), "Unmapped columns added as properties.")} className={buttonClass.secondary}>
                    Map all unmapped columns
                  </button>
                )}
                <button type="button" disabled={!dirty || busy} onClick={() => run(() => datasources.put(t.id, { dataset_id: b.dataset_id, columns: mapping }), "Mapping saved and re-indexed.")} className={buttonClass.primary}>
                  Save mapping
                </button>
              </div>
            }
          >
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Column</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Backs property</th>
                </tr>
              </thead>
              <tbody>
                {(d.columns ?? []).map((c) => {
                  const err = d.errors?.find((e) => e.column === c.name);
                  const target = mapping[c.name] ?? "";
                  return (
                    <tr key={c.name} className="border-b border-line last:border-0">
                      <td className="px-4 py-1.5 font-mono text-xs">{c.name}</td>
                      <td className="px-4 py-1.5 text-xs text-muted">{c.type}</td>
                      <td className="px-4 py-1.5">
                        <select
                          value={target}
                          disabled={!c.supported}
                          onChange={(e) => {
                            const next = { ...mapping };
                            for (const [k, v] of Object.entries(next)) if (v === e.target.value) delete next[k];
                            if (e.target.value) next[c.name] = e.target.value;
                            else delete next[c.name];
                            setMapping(next);
                          }}
                          className={`${fieldClass} w-64 py-1 text-xs`}
                        >
                          <option value="">{c.supported ? "Not mapped" : "Unsupported column type"}</option>
                          {props.map((p) => (
                            <option key={p.api_name} value={p.api_name}>
                              {p.display_name} ({p.type}
                              {p.array ? " array" : ""}){p.api_name === t.primary_key ? " · primary key" : ""}
                            </option>
                          ))}
                        </select>
                        {target && edited.includes(target) && <span className="ml-2 text-[11px] text-warn">has received edits</span>}
                        {err && <span className="ml-2 text-[11px] text-bad">{err.code}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!!d.unmapped_properties?.length && (
              <p className="border-t border-line px-4 py-2 text-xs text-muted">
                Not backed by a column (changed by edits only): {d.unmapped_properties.join(", ")}
              </p>
            )}
          </Card>
          <Card title="Replace the datasource">
            <div className="flex gap-2 p-4 text-sm">
              <select value={replacing} onChange={(e) => setReplacing(e.target.value)} className={`${inputClass} flex-1`}>
                <option value="">Choose a dataset…</option>
                {datasets
                  .filter((x) => x.id !== b.dataset_id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                      {x.path?.length ? ` — ${x.path.slice(-2).join(" / ")}` : ""}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                disabled={!replacing || busy}
                onClick={async () => {
                  if (await confirmDialog("Replace the datasource? Columns with the same names are re-mapped automatically; the objects are re-indexed from the new dataset."))
                    await run(() => datasources.put(t.id, { dataset_id: replacing }), "Datasource replaced and re-indexed.");
                }}
                className={buttonClass.secondary}
              >
                Replace
              </button>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/** The impact of deleting an object type, for its confirmation. */
export function impactText(i: Impact): string {
  const parts = [`${i.objects} objects`];
  if (i.action_types.length) parts.push(`${i.action_types.length} action types (${i.action_types.map((a) => a.display_name).join(", ")})`);
  if (i.automations.length) parts.push(`${i.automations.length} automations`);
  if (i.link_types.length) parts.push(`${i.link_types.length} link types`);
  if (i.workshop_modules.length) parts.push(`Workshop modules ${i.workshop_modules.map((m) => m.name).join(", ")}`);
  if (i.interfaces.length) parts.push(`${i.interfaces.length} interface implementations`);
  if (i.edited_properties.length) parts.push(`edits to ${i.edited_properties.join(", ")}`);
  return parts.join("; ");
}
