"use client";

import { ConvertToObjectBackedDialog, JoinTableDialog } from "@/components/ontology/JoinTableDataset";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ActionMenu } from "@/components/kg/parts";
import { Badge, ErrorBox, Field } from "@/components/ontology/parts";
import { NewLinkTypeDialog, saveOrBranch } from "@/components/ontology/ObjectTypeExtras";
import { TypeClasses } from "@/components/ontology/PropertyEditor";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { alertDialog, confirmDialog, promptDialog } from "@/lib/dialogs";
import { auth } from "@/lib/auth";
import { datasetPreview } from "@/lib/datasetPreview";
import { when } from "@/lib/format";
import { ontology, PROPERTY_TYPES, STRUCT_FIELD_TYPES, typeLabel, type ObjectType, type PropertyType, type StructField } from "@/lib/ontology";
import {
  CARDINALITY_LABEL,
  KIND_LABEL,
  LINK_KIND_LABEL,
  om,
  ROLES,
  type Grant,
  type Group,
  type Interface,
  type InterfaceProperty,
  type LinkConstraint,
  type LinkType,
  type MigratePreview,
  type Ontology,
  type ResourceKind,
  type SharedProperty,
  type ValueType,
} from "@/lib/ontologyModel";

const th = "px-4 py-2.5 font-medium";
const td = "px-4 py-2.5";

export function LinkTypesTab({ ontologyId, types, query, go }: { ontologyId: string; types: ObjectType[]; query: string; go: (h: string) => void }) {
  const [links, setLinks] = useState<LinkType[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [joinTable, setJoinTable] = useState<LinkType | null>(null);
  const [converting, setConverting] = useState<LinkType | null>(null);
  const load = useCallback(() => om.linkTypes({ ontology_id: ontologyId }).then(setLinks, () => setLinks([])), [ontologyId]);
  useEffect(() => {
    load();
  }, [load]);
  const name = (id: string) => types.find((t) => t.id === id)?.display_name ?? id;
  const q = query.toLowerCase();
  const shown = (links ?? []).filter((l) => !q || `${l.display_name} ${name(l.source.object_type_id)} ${name(l.target.object_type_id)}`.toLowerCase().includes(q));
  return (
    <>
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" /> New link type
        </button>
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border border-line bg-panel">
        {shown.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted">No link types yet. Link types relate two object types through a foreign key, a join table or a backing object type.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th className={th}>Source → target</th>
                <th className={th}>Relationship</th>
                <th className={th}>Cardinality</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`}>Links</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.id} data-link-type={l.id} title={l.display_name} className="border-b border-line last:border-0">
                  <td className={td}>
                    <div className="flex items-center gap-2 font-medium">
                      <Icon name="link" className="h-4 w-4 text-ocean" />
                      <Link href={`/ontology/${l.source.object_type_id}`} className="hover:text-ocean">
                        {name(l.source.object_type_id)}
                      </Link>
                      <span className="text-muted">→</span>
                      <Link href={`/ontology/${l.target.object_type_id}`} className="hover:text-ocean">
                        {name(l.target.object_type_id)}
                      </Link>
                    </div>
                    <div className="pl-6 text-xs text-muted">
                      {l.display_name ? `${l.display_name} · ` : ""}
                      {name(l.source.object_type_id)} sees <span className="font-mono">{l.target.api_name}</span> · {name(l.target.object_type_id)} sees{" "}
                      <span className="font-mono">{l.source.api_name}</span>
                      {l.type_classes.length ? ` · ${l.type_classes.join(", ")}` : ""}
                      {vertexArrow(l) !== "target" ? ` · Vertex arrows: ${vertexArrow(l) === "source" ? `toward ${name(l.source.object_type_id)}` : vertexArrow(l)}` : ""}
                    </div>
                  </td>
                  <td className={`${td} text-soft`}>
                    {LINK_KIND_LABEL[l.kind]}
                    {l.kind === "foreign_key" && <span className="block font-mono text-xs text-muted">{l.foreign_key}</span>}
                    {l.kind === "object_backed" && l.backing && <span className="block text-xs text-muted">{name(l.backing.object_type_id)}</span>}
                  </td>
                  <td className={`${td} text-soft`}>{CARDINALITY_LABEL[l.cardinality]}</td>
                  <td className={td}>
                    <select
                      value={l.status}
                      onChange={async (e) => {
                        const st = e.target.value as LinkType["status"];
                        if (await saveOrBranch("link_type", l, { status: st }, () => om.updateLinkType(l.id, { status: st }), go)) load();
                      }}
                      className="rounded border border-line-2 bg-ink px-1.5 py-0.5 text-xs"
                    >
                      {["experimental", "active", "deprecated", "example"].map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{l.link_count ?? "—"}</td>
                  <td className="px-2">
                    <ActionMenu
                      items={[
                        ...(l.kind === "join_table" ? [{ label: "Join table dataset…", icon: "database" as const, onClick: () => setJoinTable(l) }] : []),
                        ...(["target", "source", "none", "both"] as const).filter((a) => a !== vertexArrow(l)).map((a) => ({
                          label: `Vertex arrows: ${a === "target" ? `toward ${name(l.target.object_type_id)}` : a === "source" ? `toward ${name(l.source.object_type_id)}` : a}`,
                          icon: "graph" as const,
                          onClick: async () => {
                            const sides = withVertexArrow(l, a);
                            if (await saveOrBranch("link_type", l, sides, () => om.updateLinkType(l.id, sides), go)) load();
                          },
                        })),
                        ...(["vertex:link_merge_incoming", "vertex:link_merge_outgoing"] as const).map((c) => {
                          const on = l.type_classes.includes(c);
                          const merged = name(c === "vertex:link_merge_incoming" ? l.target.object_type_id : l.source.object_type_id);
                          return {
                            label: `${on ? "Stop merging" : "Vertex: merge"} ${merged} into edges (this link)`,
                            icon: "graph" as const,
                            onClick: async () => {
                              const type_classes = on ? l.type_classes.filter((x) => x !== c) : [...l.type_classes, c];
                              if (await saveOrBranch("link_type", l, { type_classes }, () => om.updateLinkType(l.id, { type_classes }), go)) load();
                            },
                          };
                        }),
                        ...(l.kind !== "object_backed" ? [{ label: "Convert to object-backed…", icon: "link" as const, onClick: () => setConverting(l) }] : []),
                        {
                          label: "Delete",
                          icon: "trash",
                          danger: true,
                          onClick: async () => {
                            if (!(await confirmDialog(`Delete the link type "${l.display_name}"?`))) return;
                            if (await saveOrBranch("link_type", l, {}, () => om.deleteLinkType(l.id), go)) load();
                          },
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {converting && <ConvertToObjectBackedDialog lt={converting} types={types} onClose={() => setConverting(null)} onDone={load} />}
      {joinTable && <JoinTableDialog lt={joinTable} onClose={() => setJoinTable(null)} onDone={load} />}
      {creating && <NewLinkTypeDialog types={types} onClose={() => setCreating(false)} onDone={() => (setCreating(false), load())} go={go} />}
    </>
  );
}

export function InterfacesTab({ ontologyId, query, go }: { ontologyId: string; query: string; go: (h: string) => void }) {
  const [list, setList] = useState<Interface[] | null>(null);
  const [shared, setShared] = useState<SharedProperty[]>([]);
  const [editing, setEditing] = useState<Interface | "new" | null>(null);
  const load = useCallback(() => om.interfaces(ontologyId).then(setList, () => setList([])), [ontologyId]);
  useEffect(() => {
    load();
    om.sharedProperties().then(setShared, () => setShared([]));
  }, [load]);
  const q = query.toLowerCase();
  const shown = (list ?? []).filter((i) => !q || `${i.display_name} ${i.api_name}`.toLowerCase().includes(q));
  return (
    <>
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={() => setEditing("new")} className={buttonClass.primary}>
          <Icon name="plus" /> New interface
        </button>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {shown.length === 0 && <p className="col-span-2 rounded-xl border border-line bg-panel p-6 text-center text-sm text-muted">No interfaces yet. An interface describes a shape that object types implement, so applications can work across them.</p>}
        {shown.map((i) => (
          <div key={i.id} className="rounded-xl border border-line bg-panel p-4">
            <div className="flex items-center gap-2">
              <span className="rounded border border-dashed border-sand/70 p-0.5">
                <Icon name="layers" className="h-3.5 w-3.5 text-sand" />
              </span>
              <button type="button" onClick={() => go(`/ontology/interfaces/${i.id}`)} className="font-semibold hover:underline">
                {i.display_name}
              </button>
              <span className="font-mono text-xs text-muted">{i.api_name}</span>
              <Badge status={i.status} />
              <ActionMenu
                className="ml-auto"
                items={[
                  { label: "Open", icon: "external", onClick: () => go(`/ontology/interfaces/${i.id}`) },
                  { label: "Quick edit", icon: "pencil", onClick: () => setEditing(i) },
                  { label: "Explore objects", icon: "search", onClick: () => go(`/object-explorer?interface=${i.id}`) },
                  "divider",
                  {
                    label: "Delete",
                    icon: "trash",
                    danger: true,
                    onClick: async () => {
                      if (!(await confirmDialog(`Delete the interface "${i.display_name}"?`))) return;
                      if (await saveOrBranch("interface", i, {}, () => om.deleteInterface(i.id), go)) load();
                    },
                  },
                ]}
              />
            </div>
            {i.description && <p className="mt-1 text-xs text-muted">{i.description}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {i.all_properties.map((p) => (
                <span key={p.api_name} className="rounded bg-panel-2 px-1.5 py-0.5 text-xs ring-1 ring-line-2">
                  {p.display_name || p.api_name}
                  {p.required && <span className="text-bad">*</span>} <span className="text-muted">{typeLabel(p.type, p.array)}</span>
                </span>
              ))}
            </div>
            <div className="mt-2 text-xs text-muted">
              {i.extends.length ? `Extends ${i.extends.map((x) => list?.find((y) => y.id === x)?.display_name ?? x).join(", ")} · ` : ""}
              Implemented by {i.implemented_by.length ? i.implemented_by.map((x) => x.display_name).join(", ") : "no object types yet"}
              {i.link_constraints.length ? ` · ${i.link_constraints.length} link constraints` : ""}
              {i.action_type_constraints?.length ? ` · ${i.action_type_constraints.length} action constraints` : ""}
              {i.searchable === false ? " · not searchable" : ""}
            </div>
          </div>
        ))}
      </div>
      {editing && <InterfaceDialog iface={editing === "new" ? null : editing} all={list ?? []} shared={shared} ontologyId={ontologyId} onClose={() => setEditing(null)} onDone={() => (setEditing(null), load())} go={go} />}
    </>
  );
}

function InterfaceDialog({ iface, all, shared, ontologyId, onClose, onDone, go }: { iface: Interface | null; all: Interface[]; shared: SharedProperty[]; ontologyId: string; onClose: () => void; onDone: () => void; go: (h: string) => void }) {
  const [name, setName] = useState(iface?.display_name ?? "");
  const [description, setDescription] = useState(iface?.description ?? "");
  const [status, setStatus] = useState(iface?.status ?? "experimental");
  const [props, setProps] = useState<InterfaceProperty[]>(iface?.properties ?? []);
  const [ext, setExt] = useState<string[]>(iface?.extends ?? []);
  const [links, setLinks] = useState<LinkConstraint[]>(iface?.link_constraints ?? []);
  const [error, setError] = useState<string | null>(null);
  const setP = (i: number, c: Partial<InterfaceProperty>) => setProps(props.map((p, j) => (j === i ? { ...p, ...c } : p)));
  const submit = async () => {
    setError(null);
    const body = { display_name: name, description, status, properties: props, extends: ext, link_constraints: links, ontology_id: ontologyId } as Partial<Interface>;
    try {
      if (iface) {
        if (await saveOrBranch("interface", iface, body, () => om.updateInterface(iface.id, body), go)) onDone();
      } else {
        const created = await om.createInterface(body);
        go(`/ontology/interfaces/${created.id}`);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={iface ? `Edit ${iface.display_name}` : "New interface"} icon="layers" onClose={onClose} wide>
      <div className="space-y-4 p-4 text-sm">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Display name">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Description">
            <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as Interface["status"])} className={inputClass}>
              {["experimental", "active", "deprecated", "example"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div>
          <div className="mb-1.5 text-xs font-medium text-soft">Properties (a shared property, or a local property with a base type)</div>
          {props.map((p, i) => (
            <div key={i} className="mb-1.5 flex items-center gap-1.5">
              <input value={p.api_name} onChange={(e) => setP(i, { api_name: e.target.value })} placeholder="apiName" className={`${fieldClass} w-36 font-mono text-xs`} />
              <select
                value={p.shared_property_id ?? ""}
                onChange={(e) => {
                  const sp = shared.find((x) => x.id === e.target.value);
                  setP(i, sp ? { shared_property_id: sp.id, type: sp.type, array: sp.array, api_name: p.api_name || sp.api_name } : { shared_property_id: null });
                }}
                className={`${fieldClass} w-44 text-xs`}
              >
                <option value="">Local property</option>
                {shared.map((s) => (
                  <option key={s.id} value={s.id}>
                    Shared: {s.display_name}
                  </option>
                ))}
              </select>
              <select value={p.type} disabled={!!p.shared_property_id} onChange={(e) => setP(i, { type: e.target.value as PropertyType })} className={`${fieldClass} w-32 text-xs`}>
                {PROPERTY_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs text-muted">
                <input type="checkbox" disabled={!!p.shared_property_id} checked={!!p.array} onChange={(e) => setP(i, { array: e.target.checked })} /> array
              </label>
              <label className="flex items-center gap-1 text-xs text-muted">
                <input type="checkbox" checked={!!p.required} onChange={(e) => setP(i, { required: e.target.checked })} /> required
              </label>
              <button type="button" onClick={() => setProps(props.filter((_, j) => j !== i))} className="ml-auto text-muted hover:text-bad">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setProps([...props, { api_name: "", type: "string", required: true }])} className={buttonClass.ghost}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Property
          </button>
        </div>
        <Field label="Extends" hint="Implementations must also provide the parent interfaces' properties">
          <div className="flex flex-wrap gap-1.5">
            {all
              .filter((x) => x.id !== iface?.id)
              .map((x) => {
                const on = ext.includes(x.id);
                return (
                  <button key={x.id} type="button" onClick={() => setExt(on ? ext.filter((y) => y !== x.id) : [...ext, x.id])} className={`rounded-full px-2 py-0.5 text-xs ring-1 ${on ? "bg-ocean/15 text-ocean ring-ocean/40" : "text-muted ring-line-2"}`}>
                    {x.display_name}
                  </button>
                );
              })}
          </div>
        </Field>
        <div>
          <div className="mb-1.5 text-xs font-medium text-soft">Link constraints</div>
          {links.map((l, i) => (
            <div key={i} className="mb-1.5 flex items-center gap-1.5 text-xs">
              <input value={l.api_name} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, api_name: e.target.value } : x)))} placeholder="apiName" className={`${fieldClass} w-32 font-mono text-xs`} />
              <select
                value={l.target_interface_id ?? ""}
                onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, target_interface_id: e.target.value || null } : x)))}
                className={`${fieldClass} w-44 text-xs`}
              >
                <option value="">Target interface…</option>
                {all.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.display_name}
                  </option>
                ))}
              </select>
              <select value={l.cardinality} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, cardinality: e.target.value as "one" | "many" } : x)))} className={`${fieldClass} text-xs`}>
                <option value="one">One</option>
                <option value="many">Many</option>
              </select>
              <label className="flex items-center gap-1 text-muted">
                <input type="checkbox" checked={!!l.required} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} /> required
              </label>
              <button type="button" onClick={() => setLinks(links.filter((_, j) => j !== i))} className="ml-auto text-muted hover:text-bad">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setLinks([...links, { api_name: "", cardinality: "many" }])} className={buttonClass.ghost}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Link constraint
          </button>
        </div>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!name.trim()} onClick={submit} className={buttonClass.primary}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function SharedPropertiesTab({ ontologyId, query, go }: { ontologyId: string; query: string; go: (h: string) => void }) {
  const [list, setList] = useState<SharedProperty[] | null>(null);
  const [vts, setVts] = useState<ValueType[]>([]);
  const [editing, setEditing] = useState<SharedProperty | "new" | null>(null);
  const load = useCallback(() => om.sharedProperties(ontologyId).then(setList, () => setList([])), [ontologyId]);
  useEffect(() => {
    load();
    om.valueTypes().then(setVts, () => setVts([]));
  }, [load]);
  const q = query.toLowerCase();
  const shown = (list ?? []).filter((s) => !q || `${s.display_name} ${s.api_name}`.toLowerCase().includes(q));
  return (
    <>
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={() => setEditing("new")} className={buttonClass.primary}>
          <Icon name="plus" /> New shared property
        </button>
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border border-line bg-panel">
        {shown.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted">No shared properties yet. A shared property is defined once and used on many object types; they inherit its metadata.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th className={th}>Name</th>
                <th className={th}>Base type</th>
                <th className={th}>Status</th>
                <th className={th}>Used on</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id} className="border-b border-line last:border-0">
                  <td className={td}>
                    <div className="font-medium">{s.display_name}</div>
                    <div className="font-mono text-xs text-muted">{s.api_name}</div>
                  </td>
                  <td className={`${td} text-soft`}>
                    {typeLabel(s.type, s.array)}
                    {s.value_type_id && <span className="block text-xs text-muted">Value type: {vts.find((v) => v.id === s.value_type_id)?.display_name}</span>}
                  </td>
                  <td className={td}>
                    <Badge status={s.status} />
                  </td>
                  <td className={`${td} text-xs text-soft`}>
                    {s.usage.length ? s.usage.map((u) => `${u.object_type}.${u.property}`).join(", ") : <span className="text-muted">Not used</span>}
                    {s.interface_ids.length ? <span className="block text-muted">{s.interface_ids.length} interfaces</span> : null}
                  </td>
                  <td className="px-2">
                    <ActionMenu
                      items={[
                        { label: "Edit", icon: "pencil", onClick: () => setEditing(s) },
                        "divider",
                        {
                          label: "Delete (detaches it)",
                          icon: "trash",
                          danger: true,
                          onClick: async () => {
                            if (!(await confirmDialog(`Delete "${s.display_name}"? The ${s.usage.length} properties using it keep their current metadata.`))) return;
                            if (await saveOrBranch("shared_property", s, {}, () => om.deleteSharedProperty(s.id), go)) load();
                          },
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <SharedPropertyDialog sp={editing === "new" ? null : editing} vts={vts} ontologyId={ontologyId} onClose={() => setEditing(null)} onDone={() => (setEditing(null), load())} go={go} />}
    </>
  );
}

function SharedPropertyDialog({ sp, vts, ontologyId, onClose, onDone, go }: { sp: SharedProperty | null; vts: ValueType[]; ontologyId: string; onClose: () => void; onDone: () => void; go: (h: string) => void }) {
  const [rec, setRec] = useState<Partial<SharedProperty>>(sp ?? { display_name: "", type: "string", status: "experimental", visibility: "normal" });
  const [error, setError] = useState<string | null>(null);
  const set = (c: Partial<SharedProperty>) => setRec({ ...rec, ...c });
  const fields = rec.struct_fields ?? [];
  return (
    <Modal title={sp ? `Edit ${sp.display_name}` : "New shared property"} icon="list" onClose={onClose} wide>
      <div className="space-y-4 p-4 text-sm">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Display name">
            <input value={rec.display_name ?? ""} onChange={(e) => set({ display_name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="API name" hint={sp?.status === "active" ? "Fixed: active" : undefined}>
            <input value={rec.api_name ?? ""} disabled={sp?.status === "active"} placeholder="auto" onChange={(e) => set({ api_name: e.target.value })} className={`${inputClass} font-mono`} />
          </Field>
          <Field label="Status">
            <select value={rec.status} onChange={(e) => set({ status: e.target.value as SharedProperty["status"] })} className={inputClass}>
              {["experimental", "active", "deprecated", "example"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Base type" hint={sp?.usage.length ? "Fixed while in use" : undefined}>
            <select value={rec.type} disabled={!!sp?.usage.length} onChange={(e) => set({ type: e.target.value as PropertyType, struct_fields: e.target.value === "struct" ? [{ api_name: "value", type: "string", main: true }] : undefined })} className={inputClass}>
              {PROPERTY_TYPES.filter((t) => t.id !== "timeseries").map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Value type">
            <select value={rec.value_type_id ?? ""} onChange={(e) => set({ value_type_id: e.target.value || null })} className={inputClass}>
              <option value="">None</option>
              {vts.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.display_name} ({v.base_type})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Visibility">
            <select value={rec.visibility ?? "normal"} onChange={(e) => set({ visibility: e.target.value as SharedProperty["visibility"] })} className={inputClass}>
              <option value="prominent">Prominent</option>
              <option value="normal">Normal</option>
              <option value="hidden">Hidden</option>
            </select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-xs text-soft">
          <input type="checkbox" checked={!!rec.array} onChange={(e) => set({ array: e.target.checked })} /> Array
        </label>
        {rec.type === "struct" && (
          <div className="rounded-md border border-line-2 p-3">
            <div className="mb-1.5 text-xs font-medium text-soft">Struct fields</div>
            {fields.map((f, i) => (
              <div key={i} className="mb-1.5 flex items-center gap-1.5">
                <input value={f.api_name} onChange={(e) => set({ struct_fields: fields.map((x, j) => (j === i ? { ...x, api_name: e.target.value } : x)) })} className={`${fieldClass} w-32 font-mono text-xs`} />
                <select value={f.type} onChange={(e) => set({ struct_fields: fields.map((x, j) => (j === i ? { ...x, type: e.target.value as PropertyType } : x)) })} className={`${fieldClass} text-xs`}>
                  {STRUCT_FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {typeLabel(t)}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-xs text-muted">
                  <input type="checkbox" checked={!!f.main} onChange={(e) => set({ struct_fields: fields.map((x, j) => (j === i ? { ...x, main: e.target.checked } : x)) })} /> main
                </label>
              </div>
            ))}
            <button type="button" onClick={() => set({ struct_fields: [...fields, { api_name: "", type: "string" } as StructField] })} className={buttonClass.ghost}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Field
            </button>
          </div>
        )}
        <Field label="Description">
          <textarea rows={2} value={rec.description ?? ""} onChange={(e) => set({ description: e.target.value })} className={inputClass} />
        </Field>
        <TypeClasses value={rec.type_classes ?? []} onChange={(v) => set({ type_classes: v })} />
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!rec.display_name?.trim()}
            onClick={async () => {
              setError(null);
              const body = { ...rec, ontology_id: rec.ontology_id ?? ontologyId };
              delete (body as { usage?: unknown }).usage;
              delete (body as { interface_ids?: unknown }).interface_ids;
              try {
                if (sp) {
                  if (await saveOrBranch("shared_property", sp, body, () => om.updateSharedProperty(sp.id, body), go)) onDone();
                } else {
                  await om.createSharedProperty(body);
                  onDone();
                }
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function GroupsTab({ ontologyId, types }: { ontologyId: string; types: ObjectType[] }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [name, setName] = useState("");
  const load = useCallback(() => om.groups().then(setGroups, () => setGroups([])), []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <>
      <form
        className="mt-4 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await om.createGroup({ name, ontology_id: ontologyId });
            setName("");
            load();
          } catch (err) {
            void alertDialog((err as Error).message);
          }
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New group (e.g. HR, Employee 360)" className={`${inputClass} max-w-sm`} />
        <button disabled={!name.trim()} className={buttonClass.primary}>
          <Icon name="plus" /> Create group
        </button>
      </form>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {groups?.length === 0 && <p className="col-span-2 rounded-xl border border-line bg-panel p-6 text-center text-sm text-muted">No groups yet. Groups label object types so they are easier to find.</p>}
        {groups?.map((g) => (
          <div key={g.id} className="rounded-xl border border-line bg-panel p-4">
            <div className="flex items-center gap-2 font-semibold">
              <Icon name="folder" className="h-4 w-4 text-sand" /> {g.name}
              <button
                type="button"
                onClick={async () => {
                  if (await confirmDialog(`Delete the group "${g.name}"? Object types keep existing.`)) {
                    await om.deleteGroup(g.id);
                    load();
                  }
                }}
                className="ml-auto text-muted hover:text-bad"
              >
                <Icon name="trash" className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {g.object_type_ids.length === 0 && <span className="text-muted">No object types (add them from an object type&apos;s overview)</span>}
              {g.object_type_ids.map((id) => (
                <Link key={id} href={`/ontology/${id}`} className="rounded bg-panel-2 px-1.5 py-0.5 ring-1 ring-line-2 hover:text-ocean">
                  {types.find((t) => t.id === id)?.display_name ?? id}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** The ontologies: kind, organizations, roles, main protection; create one; migrate resources between them. */
export function OntologiesTab({ current, onChanged }: { current: string; onChanged: () => void }) {
  const [list, setList] = useState<Ontology[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const load = useCallback(() => om.ontologies().then(setList, () => setList([])), []);
  useEffect(() => {
    load();
  }, [load]);
  const o = list?.find((x) => x.id === current);
  const save = async (c: Partial<Ontology>) => {
    try {
      await om.updateOntology(current, c);
      load();
      onChanged();
    } catch (e) {
      void alertDialog((e as Error).message);
    }
  };
  return (
    <>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={() => setMigrating(true)} className={buttonClass.secondary}>
          <Icon name="move" className="h-3.5 w-3.5" /> Migrate resources
        </button>
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" /> New ontology
        </button>
      </div>
      {o && (
        <div className="mt-3 space-y-4 rounded-xl border border-line bg-panel p-5 text-sm">
          <div className="flex items-center gap-3">
            <Icon name="cube" className="h-5 w-5 text-ocean" />
            <div className="flex-1">
              <div className="font-semibold">{o.name}</div>
              <div className="text-xs capitalize text-muted">
                {o.kind} ontology{o.organization_ids.length ? ` · organizations: ${o.organization_ids.join(", ")}` : ""} · your role: {o.your_role ?? "none"}
              </div>
            </div>
            {o.kind !== "default" && (
              <button
                type="button"
                onClick={async () => {
                  if (!(await confirmDialog(`Delete the ontology "${o.name}"? It must be empty.`))) return;
                  try {
                    await om.deleteOntology(o.id);
                    load();
                    onChanged();
                  } catch (e) {
                    void alertDialog((e as Error).message);
                  }
                }}
                className={`${buttonClass.ghost} text-bad`}
              >
                <Icon name="trash" className="h-3.5 w-3.5" /> Delete
              </button>
            )}
          </div>
          <div className="grid grid-cols-5 gap-2 text-center text-xs">
            {(Object.keys(KIND_LABEL) as ResourceKind[]).map((k) => (
              <div key={k} className="rounded-md bg-panel-2 p-2">
                <div className="text-lg font-semibold tabular-nums">{o.counts[k] ?? 0}</div>
                <div className="text-muted">{KIND_LABEL[k]}s</div>
              </div>
            ))}
          </div>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={o.protect_main} onChange={(e) => save({ protect_main: e.target.checked })} />
            <span>
              Protect main
              <span className="block text-xs text-muted">Changes to every resource of this ontology are made on branches and merged through approved proposals.</span>
            </span>
          </label>
          <RolesEditor grants={o.roles} onSave={(roles) => save({ roles })} />
        </div>
      )}
      {creating && <NewOntologyDialog onClose={() => setCreating(false)} onDone={() => (setCreating(false), load(), onChanged())} />}
      {migrating && list && <MigrateDialog from={current} ontologies={list} onClose={() => setMigrating(false)} onDone={() => (setMigrating(false), load(), onChanged())} />}
    </>
  );
}

export function RolesEditor({ grants, onSave }: { grants: Grant[]; onSave: (g: Grant[]) => void }) {
  const [draft, setDraft] = useState<Grant>({ principal: "everyone", role: "viewer" });
  // groups and people are picked by name (a grant stores "group:<id>" / "user:<id>"); another ID can still be typed
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [people, setPeople] = useState<{ id: string; label: string }[]>([]);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    auth.groups().then(setGroups, () => {});
    datasetPreview.people().then(setPeople, () => {});
  }, []);
  const nameOf = (principal: string) => {
    const [kind, id] = principal.split(":");
    if (principal === "everyone") return "Everyone";
    const n = kind === "group" ? groups.find((g) => g.id === id)?.name : kind === "user" ? people.find((u) => u.id === id)?.label : undefined;
    return n ? `${n} (${kind})` : principal;
  };
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-soft">Nexus roles</div>
      <p className="mb-2 text-xs text-muted">
        Discoverers see definitions, viewers see objects, editors change resources, owners manage roles and promote object types. With no grants everyone can edit.
      </p>
      {grants.map((g, i) => (
        <div key={i} className="flex items-center gap-2 py-0.5 text-xs">
          <span className="w-56 truncate" title={g.principal}>
            {nameOf(g.principal)}
          </span>
          <Badge status="open" label={g.role} />
          <button type="button" onClick={() => onSave(grants.filter((_, j) => j !== i))} className="ml-auto text-muted hover:text-bad">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="mt-1.5 flex gap-1.5">
        {typing ? (
          <input value={draft.principal} onChange={(e) => setDraft({ ...draft, principal: e.target.value })} placeholder="everyone, user:<id> or group:<id>" className={`${fieldClass} flex-1 text-xs`} />
        ) : (
          <select
            value={draft.principal}
            onChange={(e) => (e.target.value === "__type" ? setTyping(true) : setDraft({ ...draft, principal: e.target.value }))}
            className={`${fieldClass} min-w-0 flex-1 text-xs`}
            aria-label="Who"
            data-role-principal
          >
            <option value="everyone">Everyone</option>
            {groups.length > 0 && (
              <optgroup label="Groups">
                {groups.map((g) => (
                  <option key={g.id} value={`group:${g.id}`}>
                    {g.name}
                  </option>
                ))}
              </optgroup>
            )}
            {people.length > 0 && (
              <optgroup label="People">
                {people.map((u) => (
                  <option key={u.id} value={`user:${u.id}`}>
                    {u.label}
                  </option>
                ))}
              </optgroup>
            )}
            <option value="__type">Type an ID…</option>
          </select>
        )}
        <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as Grant["role"] })} className={`${fieldClass} text-xs`}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => onSave([...grants, draft])} className={buttonClass.secondary}>
          Grant
        </button>
      </div>
    </div>
  );
}

function NewOntologyDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [orgs, setOrgs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const list = orgs.split(",").map((x) => x.trim()).filter(Boolean);
  return (
    <Modal title="New ontology" icon="cube" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Organizations" hint="One organization: a private ontology. Two or more: a shared ontology their members can be granted access to.">
          <input value={orgs} onChange={(e) => setOrgs(e.target.value)} placeholder="org IDs, comma separated" className={inputClass} />
        </Field>
        <p className="text-xs text-muted">{list.length > 1 ? "Shared ontology" : "Private ontology"} · you become its owner.</p>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim()}
            onClick={async () => {
              try {
                await om.createOntology({ name, organization_ids: list, kind: list.length > 1 ? "shared" : "private" });
                onDone();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}

function MigrateDialog({ from, ontologies, onClose, onDone }: { from: string; ontologies: Ontology[]; onClose: () => void; onDone: () => void }) {
  const [target, setTarget] = useState(ontologies.find((o) => o.id !== from)?.id ?? "");
  const [resources, setResources] = useState<{ key: string; name: string; kind: ResourceKind }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{ key: string; data: MigratePreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([om.linkTypes({ ontology_id: from }), om.interfaces(from), om.sharedProperties(from), ontology.objectTypes(), ontology.actionTypes()]).then(
      ([lts, ifs, sps, ots, ats]) => {
        const mine = ots.filter((t) => (t.ontology_id ?? "default") === from);
        setResources([
          ...mine.map((t) => ({ key: `object_type:${t.id}`, name: t.display_name, kind: "object_type" as const })),
          ...lts.map((l) => ({ key: `link_type:${l.id}`, name: l.display_name, kind: "link_type" as const })),
          ...ats.filter((a) => mine.some((t) => t.id === a.object_type_id)).map((a) => ({ key: `action_type:${a.id}`, name: a.display_name, kind: "action_type" as const })),
          ...ifs.map((i) => ({ key: `interface:${i.id}`, name: i.display_name, kind: "interface" as const })),
          ...sps.map((s) => ({ key: `shared_property:${s.id}`, name: s.display_name, kind: "shared_property" as const })),
        ]);
      },
      (e: Error) => setError(e.message),
    );
  }, [from]);
  const key = JSON.stringify([target, [...picked].sort()]);
  const shownPreview = preview?.key === key ? preview.data : null;
  useEffect(() => {
    if (!target || !picked.size) return;
    const k = JSON.stringify([target, [...picked].sort()]);
    om.migratePreview(target, [...picked]).then((data) => setPreview({ key: k, data }), (e: Error) => setError(e.message));
  }, [target, picked]);
  return (
    <Modal title="Migrate resources" icon="move" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-sm">
        <Field label="Target ontology">
          <select value={target} onChange={(e) => setTarget(e.target.value)} className={inputClass}>
            {ontologies
              .filter((o) => o.id !== from)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.kind})
                </option>
              ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <div className="max-h-72 overflow-y-auto rounded-md border border-line-2 p-2">
            <div className="mb-1 text-xs text-muted">Resources in this ontology</div>
            {resources.map((r) => (
              <label key={r.key} className="flex items-center gap-2 py-0.5 text-xs">
                <input
                  type="checkbox"
                  checked={picked.has(r.key)}
                  onChange={(e) => {
                    const n = new Set(picked);
                    if (e.target.checked) n.add(r.key);
                    else n.delete(r.key);
                    setPicked(n);
                  }}
                />
                <span className="text-muted">{KIND_LABEL[r.kind]}</span> {r.name}
              </label>
            ))}
          </div>
          <div className="max-h-72 overflow-y-auto rounded-md border border-line-2 p-2 text-xs">
            <div className="mb-1 text-muted">Preview in the target</div>
            {shownPreview?.resources.map((r) => (
              <div key={r.key} className={`py-0.5 ${r.selected ? "" : "text-warn"}`}>
                {r.name}
                {!r.selected && (
                  <button type="button" onClick={() => setPicked(new Set([...picked, r.key]))} className="ml-1 underline">
                    add — {r.required_by[0]}
                  </button>
                )}
              </div>
            ))}
            {shownPreview?.problems.map((p) => (
              <div key={p} className="py-0.5 text-bad">
                {p}
              </div>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted">Connected resources (link types, their object types, action types, interfaces and shared properties) move together. Objects and edits are kept.</p>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!shownPreview?.ok}
            onClick={async () => {
              try {
                await om.migrate(target, [...picked]);
                onDone();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            Submit migration
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function BranchesTab({ ontologyId, go }: { ontologyId: string; go: (h: string) => void }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof om.branches>> | null>(null);
  useEffect(() => {
    om.branches({ ontology_id: ontologyId }).then(setRows, () => setRows([]));
  }, [ontologyId]);
  return (
    <>
      <div className="mt-4 flex justify-end gap-2">
        <Link href="/ontology/proposals" className={buttonClass.secondary}>
          <Icon name="check" className="h-3.5 w-3.5" /> Proposals
        </Link>
        <button
          type="button"
          onClick={async () => {
            const name = await promptDialog("Name the branch", "", { title: "Create new branch" });
            if (!name) return;
            try {
              const b = await om.createBranch({ name, ontology_id: ontologyId });
              go(`/ontology/branches/${b.id}`);
            } catch (e) {
              void alertDialog((e as Error).message);
            }
          }}
          className={buttonClass.primary}
        >
          <Icon name="split" /> New branch
        </button>
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border border-line bg-panel">
        {rows?.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted">No branches. Branch from main to change resources in isolation, then merge them with a reviewed proposal.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th className={th}>Branch</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`}>Changes</th>
                <th className={th}>Proposal</th>
                <th className={th}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((b) => (
                <tr key={b.id} onClick={() => go(`/ontology/branches/${b.id}`)} className="cursor-pointer border-b border-line last:border-0 hover:bg-panel-2">
                  <td className={td}>
                    <span className="flex items-center gap-2 font-medium">
                      <Icon name="split" className="h-4 w-4 text-ocean" /> {b.name}
                    </span>
                  </td>
                  <td className={td}>
                    <Badge status={b.status} />
                    {b.conflict_count ? <span className="ml-1 text-xs text-bad">{b.conflict_count} conflicts</span> : null}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{b.change_count}</td>
                  <td className={td}>{b.proposal ? <Badge status={b.proposal.status} /> : <span className="text-xs text-muted">—</span>}</td>
                  <td className={`${td} text-xs text-muted`}>{when(b.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

const VERTEX_CLASSES = ["vertex:link_primary_direction", "vertex:link_undirectional", "vertex:link_bidirectional"];

/** Where Vertex points this link type's edge arrows (api/vertex.py edge_arrow). */
function vertexArrow(l: LinkType): "target" | "source" | "none" | "both" {
  const s = l.source.type_classes ?? [];
  const t = l.target.type_classes ?? [];
  if ([...s, ...t].includes("vertex:link_undirectional")) return "none";
  if ([...s, ...t].includes("vertex:link_bidirectional")) return "both";
  return s.includes("vertex:link_primary_direction") && !t.includes("vertex:link_primary_direction") ? "source" : "target";
}

/** The link type's sides with the Vertex type classes for an arrow direction (other type classes kept). */
function withVertexArrow(l: LinkType, arrow: "target" | "source" | "none" | "both"): Pick<LinkType, "source" | "target"> {
  const keep = (xs?: string[]) => (xs ?? []).filter((x) => !VERTEX_CLASSES.includes(x));
  const add = arrow === "none" ? "vertex:link_undirectional" : arrow === "both" ? "vertex:link_bidirectional" : "vertex:link_primary_direction";
  return {
    source: { ...l.source, type_classes: [...keep(l.source.type_classes), ...(arrow === "source" || arrow === "none" || arrow === "both" ? [add] : [])] },
    target: { ...l.target, type_classes: keep(l.target.type_classes) },
  };
}
