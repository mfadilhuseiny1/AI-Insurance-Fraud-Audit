"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { ImplementationDialog } from "@/components/ontology/Interfaces";
import { saveOrBranch } from "@/components/ontology/ObjectTypeExtras";
import { TypeClasses } from "@/components/ontology/PropertyEditor";
import { AppHeader, Badge, Card, Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { confirmDialog } from "@/lib/dialogs";
import { ontology, PROPERTY_TYPES, RENDER_HINTS, typeLabel, type ObjectType, type PropertyType, type Visibility } from "@/lib/ontology";
import { om, type ActionConstraint, type Interface, type InterfaceProperty, type LinkConstraint, type SharedProperty } from "@/lib/ontologyModel";

type Tab = "overview" | "properties" | "links" | "actions" | "extensions" | "implementations";
const TABS: [Tab, string, IconName][] = [
  ["overview", "Overview", "home"],
  ["properties", "Properties", "list"],
  ["links", "Link type constraints", "link"],
  ["actions", "Action type constraints", "bolt"],
  ["extensions", "Extensions", "layers"],
  ["implementations", "Implementations", "cube"],
];
const PARAM_TYPES = ["string", "integer", "long", "double", "decimal", "boolean", "date", "timestamp", "object", "interface", "object_set", "attachment", "media", "struct", "geopoint", "geoshape", "user"];
const apiOf = (s: string) =>
  s
    .trim()
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))
    .replace(/^[A-Z]/, (c) => c.toLowerCase());

/** An interface in Ontology Manager: metadata, properties, link and action type constraints, extensions and implementations. */
export default function InterfacePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [saved, setSaved] = useState<Interface | null>(null);
  const [d, setD] = useState<Interface | null>(null);
  const [all, setAll] = useState<Interface[]>([]);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [shared, setShared] = useState<SharedProperty[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    om.interface(id).then(
      (i) => {
        setSaved(i);
        setD(JSON.parse(JSON.stringify(i)));
      },
      (e: Error) => setError(e.message),
    );
    om.interfaces().then(setAll, () => setAll([]));
    ontology.objectTypes().then(setTypes, () => setTypes([]));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    om.sharedProperties().then(setShared, () => setShared([]));
  }, []);
  if (error && !saved) return <ApiError message={error} />;
  if (!saved || !d) return <Loading />;
  const set = (c: Partial<Interface>) => setD({ ...d, ...c });
  const dirty = JSON.stringify(d) !== JSON.stringify(saved);
  const save = async () => {
    const body: Partial<Interface> = {
      display_name: d.display_name,
      description: d.description,
      api_name: d.api_name,
      icon: d.icon,
      status: d.status,
      searchable: d.searchable,
      properties: d.properties,
      extends: d.extends,
      link_constraints: d.link_constraints,
      action_type_constraints: d.action_type_constraints ?? [],
    };
    if (await saveOrBranch("interface", saved, body, () => om.updateInterface(saved.id, body), (h) => router.push(h))) load();
  };
  const name = (iid: string) => all.find((x) => x.id === iid)?.display_name ?? iid;
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Nexus Manager" icon="cube" href="/ontology" crumbs={[{ label: "Interfaces", href: "/ontology?tab=interfaces" }, { label: saved.display_name }]}>
        {dirty && (
          <button type="button" onClick={() => setD(JSON.parse(JSON.stringify(saved)))} className={buttonClass.secondary}>
            Discard
          </button>
        )}
        <button type="button" disabled={!dirty} onClick={save} className={buttonClass.primary}>
          Save
        </button>
      </AppHeader>
      <div className="flex min-h-0 flex-1">
        <nav className="w-60 shrink-0 space-y-0.5 overflow-y-auto border-r border-line bg-panel p-2 text-sm">
          <div className="mb-2 flex items-center gap-2 px-3 py-2">
            <span className="rounded-md border border-dashed border-sand/70 p-1.5 text-sand">
              <Icon name="layers" className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="truncate font-semibold">{saved.display_name}</div>
              <div className="text-xs text-muted">Interface</div>
            </div>
          </div>
          {TABS.map(([k, label, icon]) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left ${tab === k ? "bg-panel-2 text-white" : "text-soft hover:bg-panel-2"}`}>
              <Icon name={icon} className="h-4 w-4" /> {label}
            </button>
          ))}
        </nav>
        <section className="min-w-0 flex-1 space-y-4 overflow-y-auto p-6">
          {tab === "overview" && <Overview d={d} saved={saved} set={set} />}
          {tab === "properties" && <Properties d={d} set={set} shared={shared} />}
          {tab === "links" && <Links d={d} set={set} all={all} types={types} name={name} />}
          {tab === "actions" && <Actions d={d} set={set} name={name} />}
          {tab === "extensions" && <Extensions d={d} set={set} all={all} />}
          {tab === "implementations" && <Implementations iface={saved} types={types} onChanged={load} go={(h) => router.push(h)} />}
        </section>
      </div>
    </div>
  );
}

function Overview({ d, saved, set }: { d: Interface; saved: Interface; set: (c: Partial<Interface>) => void }) {
  return (
    <>
      <Card title="Metadata">
        <div className="grid gap-3 p-4 text-sm sm:grid-cols-2">
          <Field label="Display name">
            <input value={d.display_name} onChange={(e) => set({ display_name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="API name" hint={saved.status === "active" ? "Fixed while active" : "Used in code; changing it breaks consumers"}>
            <input value={d.api_name} disabled={saved.status === "active"} onChange={(e) => set({ api_name: e.target.value })} className={`${inputClass} font-mono`} />
          </Field>
          <Field label="Description">
            <input value={d.description} onChange={(e) => set({ description: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Status">
            <select value={d.status} onChange={(e) => set({ status: e.target.value as Interface["status"] })} className={inputClass}>
              {["experimental", "active", "deprecated", "example"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Icon">
            <input value={d.icon} onChange={(e) => set({ icon: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Searchable" hint="Searchable interfaces load or search all their objects at once: at most 75 implementing object types (1,000 otherwise)">
            <label className="flex items-center gap-2 py-1.5">
              <input type="checkbox" checked={d.searchable !== false} onChange={(e) => set({ searchable: e.target.checked })} /> Searchable
            </label>
          </Field>
          <div className="break-all font-mono text-xs text-muted sm:col-span-2">RID ri.ontology.main.interface.{saved.id}</div>
        </div>
      </Card>
      <Card title="Summary">
        <div className="grid grid-cols-2 gap-3 p-4 text-sm sm:grid-cols-5">
          {[
            ["Properties", saved.all_properties.length],
            ["Link constraints", (saved.all_link_constraints ?? saved.link_constraints).length],
            ["Action constraints", (saved.all_action_constraints ?? []).length],
            ["Extends", saved.extends.length],
            ["Implementations", saved.implemented_by.length],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg bg-panel-2 p-3">
              <div className="text-lg font-semibold tabular-nums">{v}</div>
              <div className="text-xs text-muted">{k}</div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

function Properties({ d, set, shared }: { d: Interface; set: (c: Partial<Interface>) => void; shared: SharedProperty[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const props = d.properties;
  const setP = (i: number, c: Partial<InterfaceProperty>) => set({ properties: props.map((p, j) => (j === i ? { ...p, ...c } : p)) });
  const inherited = d.all_properties.filter((p) => !props.some((x) => x.api_name === p.api_name));
  const p = open !== null ? props[open] : null;
  return (
    <>
      <Card
        title="Properties"
        count={props.length}
        action={
          <div className="flex gap-2">
            <select
              value=""
              onChange={(e) => {
                const sp = shared.find((x) => x.id === e.target.value);
                if (sp) set({ properties: [...props, { api_name: sp.api_name, display_name: sp.display_name, type: sp.type, array: sp.array, shared_property_id: sp.id, required: true }] });
              }}
              className={`${fieldClass} py-1 text-xs`}
            >
              <option value="">Add shared property…</option>
              {shared
                .filter((s) => !props.some((x) => x.shared_property_id === s.id))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.display_name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              onClick={() => {
                set({ properties: [...props, { api_name: `property${props.length + 1}`, display_name: `Property ${props.length + 1}`, type: "string", required: true }] });
                setOpen(props.length);
              }}
              className={buttonClass.secondary}
            >
              <Icon name="plus" className="h-3.5 w-3.5" /> New property
            </button>
          </div>
        }
      >
        <table className="w-full text-sm">
          <tbody>
            {props.map((x, i) => (
              <tr key={i} onClick={() => setOpen(i)} className={`cursor-pointer border-b border-line last:border-0 hover:bg-panel-2 ${open === i ? "bg-panel-2" : ""}`}>
                <td className="px-4 py-2">
                  {x.display_name || x.api_name}
                  {x.required ? <span className="text-bad"> *</span> : <span className="ml-1 text-xs text-muted">optional</span>}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-muted">{x.api_name}</td>
                <td className="px-4 py-2 text-xs">{typeLabel(x.type, x.array)}</td>
                <td className="px-4 py-2 text-xs text-muted">
                  {x.shared_property_id ? "Shared" : "Local"}
                  {x.primary_key_constraint ? ` · ${x.primary_key_constraint === "must" ? "must be" : "cannot be"} primary key` : ""}
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(null);
                      set({ properties: props.filter((_, j) => j !== i) });
                    }}
                    className="text-muted hover:text-bad"
                  >
                    <Icon name="trash" className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {inherited.map((x) => (
              <tr key={`inh-${x.api_name}`} className="border-b border-line text-muted last:border-0">
                <td className="px-4 py-2">{x.display_name || x.api_name}</td>
                <td className="px-4 py-2 font-mono text-xs">{x.api_name}</td>
                <td className="px-4 py-2 text-xs">{typeLabel(x.type, x.array)}</td>
                <td className="px-4 py-2 text-xs" colSpan={2}>
                  Inherited through an extension
                </td>
              </tr>
            ))}
            {props.length + inherited.length === 0 && (
              <tr>
                <td className="px-4 py-4 text-sm text-muted">No properties yet. Local properties are recommended; shared properties work too.</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      {p && open !== null && (
        <Card title={`Property: ${p.display_name || p.api_name}`} action={<span className="text-xs font-normal text-warn">Changing a type breaks implementations that map it</span>}>
          <div className="grid gap-3 p-4 text-sm sm:grid-cols-2">
            <Field label="Display name">
              <input value={p.display_name ?? ""} onChange={(e) => setP(open, { display_name: e.target.value })} className={inputClass} />
            </Field>
            <Field label="API name">
              <input value={p.api_name} onChange={(e) => setP(open, { api_name: e.target.value })} className={`${inputClass} font-mono`} />
            </Field>
            <Field label="Description">
              <input value={p.description ?? ""} onChange={(e) => setP(open, { description: e.target.value })} className={inputClass} />
            </Field>
            <Field label="Base type" hint={p.shared_property_id ? "From the shared property" : undefined}>
              <div className="flex gap-2">
                <select value={p.type} disabled={!!p.shared_property_id} onChange={(e) => setP(open, { type: e.target.value as PropertyType })} className={inputClass}>
                  {PROPERTY_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-xs text-muted">
                  <input type="checkbox" disabled={!!p.shared_property_id} checked={!!p.array} onChange={(e) => setP(open, { array: e.target.checked })} /> array
                </label>
              </div>
            </Field>
            <Field label="Implementation" hint="Required properties must be mapped by every implementing object type">
              <select value={p.required ? "required" : "optional"} onChange={(e) => setP(open, { required: e.target.value === "required" })} className={inputClass}>
                <option value="required">Required</option>
                <option value="optional">Optional</option>
              </select>
            </Field>
            <Field label="Primary key constraint">
              <select value={p.primary_key_constraint ?? ""} onChange={(e) => setP(open, { primary_key_constraint: (e.target.value || null) as InterfaceProperty["primary_key_constraint"] })} className={inputClass}>
                <option value="">No constraint</option>
                <option value="must">Must be the primary key</option>
                <option value="cannot">Cannot be the primary key</option>
              </select>
            </Field>
            <Field label="Visibility">
              <select value={p.visibility ?? "normal"} onChange={(e) => setP(open, { visibility: e.target.value as Visibility })} className={inputClass}>
                <option value="prominent">Prominent</option>
                <option value="normal">Normal</option>
                <option value="hidden">Hidden</option>
              </select>
            </Field>
            <Field label="Render hints">
              <div className="flex flex-wrap gap-1.5">
                {RENDER_HINTS.map((h) => {
                  const on = (p.render_hints ?? []).includes(h.id);
                  return (
                    <button
                      key={h.id}
                      type="button"
                      title={h.hint}
                      onClick={() => setP(open, { render_hints: on ? (p.render_hints ?? []).filter((x) => x !== h.id) : [...(p.render_hints ?? []), h.id] })}
                      className={`rounded-full px-2 py-0.5 text-xs ring-1 ${on ? "bg-ocean/15 text-ocean ring-ocean/40" : "text-muted ring-line-2"}`}
                    >
                      {h.label}
                    </button>
                  );
                })}
              </div>
            </Field>
            <div className="sm:col-span-2">
              <TypeClasses value={p.type_classes ?? []} onChange={(v) => setP(open, { type_classes: v })} />
            </div>
          </div>
        </Card>
      )}
    </>
  );
}

function Links({ d, set, all, types, name }: { d: Interface; set: (c: Partial<Interface>) => void; all: Interface[]; types: ObjectType[]; name: (id: string) => string }) {
  const links = d.link_constraints;
  const setL = (i: number, c: Partial<LinkConstraint>) => set({ link_constraints: links.map((x, j) => (j === i ? { ...x, ...c } : x)) });
  const inherited = (d.all_link_constraints ?? []).filter((c) => c.inherited_from);
  return (
    <Card
      title="Link type constraints"
      count={links.length}
      action={
        <button type="button" onClick={() => set({ link_constraints: [...links, { api_name: `link${links.length + 1}`, display_name: "", target_kind: "object_type", cardinality: "many", required: false }] })} className={buttonClass.secondary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New link type constraint
        </button>
      }
    >
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted">An object-to-object relationship every implementation provides through one of its link types. Cardinality One means each object links to one target object.</p>
        {links.map((l, i) => {
          const kind = l.target_kind ?? (l.target_interface_id ? "interface" : "object_type");
          return (
            <div key={i} className="grid gap-2 rounded-lg border border-line-2 p-3 sm:grid-cols-3">
              <Field label="Display name">
                <input value={l.display_name ?? ""} onChange={(e) => setL(i, { display_name: e.target.value, api_name: l.api_name || apiOf(e.target.value) })} className={inputClass} />
              </Field>
              <Field label="API name">
                <input value={l.api_name} onChange={(e) => setL(i, { api_name: e.target.value })} className={`${inputClass} font-mono`} />
              </Field>
              <Field label="Description">
                <input value={l.description ?? ""} onChange={(e) => setL(i, { description: e.target.value })} className={inputClass} />
              </Field>
              <Field label="Link target type">
                <select value={kind} onChange={(e) => setL(i, { target_kind: e.target.value as "interface" | "object_type", target_interface_id: null, target_object_type_id: null })} className={inputClass}>
                  <option value="object_type">Object type</option>
                  <option value="interface">Interface</option>
                </select>
              </Field>
              <Field label="Target">
                {kind === "interface" ? (
                  <select value={l.target_interface_id ?? ""} onChange={(e) => setL(i, { target_interface_id: e.target.value || null })} className={inputClass}>
                    <option value="">Choose an interface…</option>
                    {all.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.display_name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select value={l.target_object_type_id ?? ""} onChange={(e) => setL(i, { target_object_type_id: e.target.value || null })} className={inputClass}>
                    <option value="">Choose an object type…</option>
                    {types.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.display_name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Cardinality and requirement">
                <div className="flex gap-2">
                  <select value={l.cardinality} onChange={(e) => setL(i, { cardinality: e.target.value as "one" | "many" })} className={inputClass}>
                    <option value="one">One</option>
                    <option value="many">Many</option>
                  </select>
                  <select value={l.required ? "required" : "optional"} onChange={(e) => setL(i, { required: e.target.value === "required" })} className={inputClass}>
                    <option value="required">Required</option>
                    <option value="optional">Optional</option>
                  </select>
                  <button type="button" onClick={() => set({ link_constraints: links.filter((_, j) => j !== i) })} className="text-muted hover:text-bad">
                    <Icon name="trash" className="h-4 w-4" />
                  </button>
                </div>
              </Field>
            </div>
          );
        })}
        {inherited.map((l) => (
          <div key={l.api_name} className="rounded-lg border border-dashed border-line-2 px-3 py-2 text-xs text-muted">
            {l.display_name || l.api_name} · {l.cardinality} → {l.target_interface_id ? name(l.target_interface_id) : (types.find((t) => t.id === l.target_object_type_id)?.display_name ?? "?")} · inherited from {name(l.inherited_from ?? "")}
          </div>
        ))}
        {links.length + inherited.length === 0 && <p className="text-xs text-muted">No link type constraints.</p>}
      </div>
    </Card>
  );
}

function Actions({ d, set, name }: { d: Interface; set: (c: Partial<Interface>) => void; name: (id: string) => string }) {
  const acs = d.action_type_constraints ?? [];
  const setA = (i: number, c: Partial<ActionConstraint>) => set({ action_type_constraints: acs.map((x, j) => (j === i ? { ...x, ...c } : x)) });
  const inherited = (d.all_action_constraints ?? []).filter((c) => c.inherited_from);
  return (
    <Card
      title="Action type constraints"
      count={acs.length}
      action={
        <button
          type="button"
          onClick={() => set({ action_type_constraints: [...acs, { api_name: `action${acs.length + 1}`, display_name: "", description: "", required: false, parameters: [] }] })}
          className={buttonClass.secondary}
        >
          <Icon name="plus" className="h-3.5 w-3.5" /> Create new
        </button>
      }
    >
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted">
          <Badge status="experimental" label="Beta" /> An action capability each implementing object type maps to one of its action types with compatible parameters. Describe the expected edits and side effects: the constraint does not
          enforce them.
        </p>
        {acs.map((a, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-line-2 p-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Display name">
                <input value={a.display_name ?? ""} onChange={(e) => setA(i, { display_name: e.target.value })} className={inputClass} />
              </Field>
              <Field label="API name">
                <input value={a.api_name} onChange={(e) => setA(i, { api_name: e.target.value })} className={`${inputClass} font-mono`} />
              </Field>
              <Field label="Implementation">
                <div className="flex gap-2">
                  <select value={a.required ? "required" : "optional"} onChange={(e) => setA(i, { required: e.target.value === "required" })} className={inputClass}>
                    <option value="required">Required</option>
                    <option value="optional">Optional</option>
                  </select>
                  <button type="button" onClick={() => set({ action_type_constraints: acs.filter((_, j) => j !== i) })} className="text-muted hover:text-bad">
                    <Icon name="trash" className="h-4 w-4" />
                  </button>
                </div>
              </Field>
            </div>
            <Field label="Description" hint="What the satisfying action type should do">
              <input value={a.description ?? ""} onChange={(e) => setA(i, { description: e.target.value })} className={inputClass} />
            </Field>
            <div>
              <div className="mb-1 flex items-center gap-2 text-xs font-medium text-soft">
                Parameter constraints
                <select
                  value=""
                  onChange={(e) => {
                    const ip = d.all_properties.find((x) => x.api_name === e.target.value);
                    if (ip)
                      setA(i, {
                        parameters: [...a.parameters, { api_name: apiOf(ip.display_name || ip.api_name), display_name: ip.display_name || ip.api_name, type: PARAM_TYPES.includes(ip.type) ? ip.type : "string", list: !!ip.array, required: !!ip.required }],
                      });
                  }}
                  className={`${fieldClass} ml-auto py-0.5 text-xs`}
                >
                  <option value="">Add from interface property…</option>
                  {d.all_properties.map((p) => (
                    <option key={p.api_name} value={p.api_name}>
                      {p.display_name || p.api_name}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => setA(i, { parameters: [...a.parameters, { api_name: `param${a.parameters.length + 1}`, display_name: "", type: "string", required: true }] })} className="text-xs text-ocean hover:underline">
                  + Parameter
                </button>
              </div>
              {a.parameters.map((pc, k) => {
                const setPc = (c: Partial<ActionConstraint["parameters"][number]>) => setA(i, { parameters: a.parameters.map((x, j) => (j === k ? { ...x, ...c } : x)) });
                return (
                  <div key={k} className="mb-1 flex items-center gap-1.5 text-xs">
                    <input value={pc.display_name ?? ""} onChange={(e) => setPc({ display_name: e.target.value })} placeholder="Display name" className={`${fieldClass} w-40 py-1 text-xs`} />
                    <input value={pc.api_name} onChange={(e) => setPc({ api_name: e.target.value })} placeholder="apiName" className={`${fieldClass} w-36 py-1 font-mono text-xs`} />
                    <select value={pc.type} onChange={(e) => setPc({ type: e.target.value })} className={`${fieldClass} py-1 text-xs`}>
                      {PARAM_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t.replace("_", " ")}
                        </option>
                      ))}
                    </select>
                    <select value={pc.list ? "list" : "single"} onChange={(e) => setPc({ list: e.target.value === "list" })} className={`${fieldClass} py-1 text-xs`}>
                      <option value="single">Single</option>
                      <option value="list">List</option>
                    </select>
                    <label className="flex items-center gap-1 text-muted">
                      <input type="checkbox" checked={!!pc.required} onChange={(e) => setPc({ required: e.target.checked })} /> must be mapped
                    </label>
                    <button type="button" onClick={() => setA(i, { parameters: a.parameters.filter((_, j) => j !== k) })} className="ml-auto text-muted hover:text-bad">
                      <Icon name="x" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {inherited.map((a) => (
          <div key={a.api_name} className="rounded-lg border border-dashed border-line-2 px-3 py-2 text-xs text-muted">
            {a.display_name || a.api_name} ({a.parameters.length} parameters{a.required ? ", required" : ""}) · inherited from {name(a.inherited_from ?? "")}
          </div>
        ))}
        {acs.length + inherited.length === 0 && <p className="text-xs text-muted">No action type constraints.</p>}
      </div>
    </Card>
  );
}

function Extensions({ d, set, all }: { d: Interface; set: (c: Partial<Interface>) => void; all: Interface[] }) {
  const [adding, setAdding] = useState<Interface | null>(null);
  return (
    <Card
      title="Extensions"
      count={d.extends.length}
      action={
        <select
          value=""
          onChange={(e) => setAdding(all.find((x) => x.id === e.target.value) ?? null)}
          className={`${fieldClass} py-1 text-xs`}
        >
          <option value="">Add extension…</option>
          {all
            .filter((x) => x.id !== d.id && !d.extends.includes(x.id))
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.display_name}
              </option>
            ))}
        </select>
      }
    >
      <div className="divide-y divide-line text-sm">
        {d.extends.map((pid) => {
          const p = all.find((x) => x.id === pid);
          return (
            <div key={pid} className="flex items-center gap-3 px-4 py-2.5">
              <Link href={`/ontology/interfaces/${pid}`} className="font-medium text-ocean hover:underline">
                {p?.display_name ?? pid}
              </Link>
              <span className="text-xs text-muted">
                {p ? `${p.all_properties.length} properties · ${(p.all_link_constraints ?? p.link_constraints).length} link constraints · ${(p.all_action_constraints ?? []).length} action constraints` : ""}
              </span>
              <button
                type="button"
                onClick={async () => {
                  if (await confirmDialog(`Remove the extension of ${p?.display_name ?? pid}? Its inherited properties, link type constraints and action type constraints are removed from this interface.`))
                    set({ extends: d.extends.filter((x) => x !== pid) });
                }}
                className="ml-auto text-xs text-muted hover:text-bad"
              >
                Remove
              </button>
            </div>
          );
        })}
        {d.extends.length === 0 && <p className="px-4 py-3 text-xs text-muted">This interface extends no other interface.</p>}
      </div>
      {adding && (
        <Modal title={`Extend ${adding.display_name}`} icon="layers" onClose={() => setAdding(null)}>
          <div className="space-y-3 p-4 text-sm">
            <p className="text-muted">{d.display_name} will inherit:</p>
            <ul className="list-disc space-y-1 pl-5 text-xs">
              {adding.all_properties.map((p) => (
                <li key={p.api_name}>
                  Property {p.display_name || p.api_name} ({typeLabel(p.type, p.array)}){d.all_properties.some((x) => x.api_name === p.api_name) ? " — already present" : ""}
                </li>
              ))}
              {(adding.all_link_constraints ?? adding.link_constraints).map((l) => (
                <li key={`l-${l.api_name}`}>Link type constraint {l.display_name || l.api_name}</li>
              ))}
              {(adding.all_action_constraints ?? []).map((a) => (
                <li key={`a-${a.api_name}`}>Action type constraint {a.display_name || a.api_name}</li>
              ))}
            </ul>
            <p className="text-xs text-warn">Implementations must satisfy the inherited required constraints too.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setAdding(null)} className={buttonClass.secondary}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  set({ extends: [...d.extends, adding.id] });
                  setAdding(null);
                }}
                className={buttonClass.primary}
              >
                Confirm
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function Implementations({ iface, types, onChanged, go }: { iface: Interface; types: ObjectType[]; onChanged: () => void; go: (h: string) => void }) {
  const [picking, setPicking] = useState("");
  const t = types.find((x) => x.id === picking);
  const limit = iface.searchable === false ? 1000 : 75;
  return (
    <Card
      title="Implementations"
      count={iface.implemented_by.length}
      action={
        <select value="" onChange={(e) => setPicking(e.target.value)} className={`${fieldClass} py-1 text-xs`}>
          <option value="">+ New implementation…</option>
          {types
            .filter((x) => !iface.implemented_by.some((i) => i.object_type_id === x.id))
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.display_name}
              </option>
            ))}
        </select>
      }
    >
      <div className="divide-y divide-line text-sm">
        {iface.implemented_by.map((i) => (
          <Link key={i.object_type_id} href={`/ontology/${i.object_type_id}`} className="flex items-center gap-2 px-4 py-2.5 hover:bg-panel-2">
            <Icon name="cube" className="h-4 w-4 text-ocean" /> {i.display_name}
            <span className="ml-auto text-xs text-muted">Edit mappings on the object type</span>
          </Link>
        ))}
        {iface.implemented_by.length === 0 && <p className="px-4 py-3 text-xs text-muted">No object type implements this interface yet.</p>}
        <p className="px-4 py-2 text-xs text-muted">
          {iface.implemented_by.length} of at most {limit} implementing object types ({iface.searchable === false ? "not searchable" : "searchable"}).{" "}
          <Link href={`/object-explorer?interface=${iface.id}`} className="text-ocean hover:underline">
            Explore objects
          </Link>
        </p>
      </div>
      {t && (
        <ImplementationDialog
          t={t}
          iface={iface}
          onClose={() => setPicking("")}
          onSave={async (impl) => {
            const next = [...(t.implements ?? []), impl];
            if (await saveOrBranch("object_type", t, { implements: next }, () => ontology.updateObjectType(t.id, { implements: next }), go)) {
              setPicking("");
              onChanged();
            }
          }}
        />
      )}
    </Card>
  );
}
