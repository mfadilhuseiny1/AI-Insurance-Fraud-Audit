"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ErrorBox } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ontology, typeLabel, type ActionType, type Implementation, type ObjectType } from "@/lib/ontology";
import { om, type ActionConstraint, type Interface, type LinkConstraint, type LinkType } from "@/lib/ontologyModel";

type Tab = "properties" | "links" | "actions";

/** Whether a link type of `t` can satisfy an interface link constraint (target and cardinality). */
export function linkFits(t: ObjectType, lt: LinkType, lc: LinkConstraint, types: ObjectType[]): boolean {
  const ends = [lt.source.object_type_id, lt.target.object_type_id];
  if (!ends.includes(t.id)) return false;
  const other = lt.source.object_type_id === t.id ? lt.target.object_type_id : lt.source.object_type_id;
  if (lc.target_object_type_id && other !== lc.target_object_type_id) return false;
  if (lc.target_interface_id) {
    const ot = types.find((x) => x.id === other);
    if (!ot || !(ot.implements ?? []).some((i) => i.interface_id === lc.target_interface_id)) return false;
  }
  if (lc.cardinality === "one") return (lt.kind === "foreign_key" && lt.source.object_type_id === t.id) || lt.cardinality === "one_to_one";
  return true;
}

/** Whether an action parameter is compatible with a parameter constraint. */
export function paramFits(p: { type: string; array?: boolean; required?: boolean }, pc: ActionConstraint["parameters"][number]): boolean {
  if (pc.type === "object_set") return p.type === "object" && !!p.array;
  return p.type === pc.type && !!p.array === !!pc.list && (!pc.required || !!p.required);
}

/**
 * Implement an interface (or edit an implementation): map interface properties to local properties, link type
 * constraints to link types and action type constraints to action types with their parameters.
 */
export function ImplementationDialog({
  t,
  iface,
  current,
  onClose,
  onSave,
}: {
  t: ObjectType;
  iface: Interface;
  current?: Implementation;
  onClose: () => void;
  onSave: (impl: Implementation) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("properties");
  const [mapping, setMapping] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      iface.all_properties.map((p) => [
        p.api_name,
        current?.mapping?.[p.api_name] ?? t.properties.find((x) => (p.shared_property_id && x.shared_property_id === p.shared_property_id) || (x.api_name === p.api_name && x.type === p.type))?.api_name ?? "",
      ]),
    ),
  );
  const [links, setLinks] = useState<Record<string, string>>(current?.links ?? {});
  const [acts, setActs] = useState<NonNullable<Implementation["actions"]>>(current?.actions ?? {});
  const [linkTypes, setLinkTypes] = useState<LinkType[]>([]);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [actionTypes, setActionTypes] = useState<ActionType[]>([]);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([om.linkTypes({ object_type_id: t.id }), ontology.objectTypes(), ontology.actionTypes()]).then(
      ([l, ts, a]) => {
        setLinkTypes(l);
        setTypes(ts);
        setActionTypes(a.filter((x) => x.object_type_id === t.id));
      },
      (e: Error) => setError(e.message),
    );
  }, [t.id]);
  const lcs = iface.all_link_constraints ?? iface.link_constraints;
  const acs = iface.all_action_constraints ?? iface.action_type_constraints ?? [];
  const missing = {
    properties: iface.all_properties.filter((p) => p.required && !mapping[p.api_name]).length,
    links: lcs.filter((l) => l.required && !links[l.api_name]).length,
    actions: acs.filter((a) => a.required && !acts[a.api_name]?.action_type_id).length,
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({
        interface_id: iface.id,
        mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)),
        links: Object.fromEntries(Object.entries(links).filter(([, v]) => v)),
        actions: Object.fromEntries(Object.entries(acts).filter(([, v]) => v.action_type_id)),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ac = acs.find((a) => a.api_name === configuring);
  const acAction = ac ? actionTypes.find((a) => a.id === acts[ac.api_name]?.action_type_id) : undefined;
  return (
    <Modal title={`${current ? "Edit implementation of" : "Implement"} ${iface.display_name}`} icon="layers" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-sm">
        <div className="flex gap-1 border-b border-line">
          {(
            [
              ["properties", "Properties", iface.all_properties.length],
              ["links", "Link type constraints", lcs.length],
              ["actions", "Action type constraints", acs.length],
            ] as [Tab, string, number][]
          ).map(([k, label, n]) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs ${tab === k ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>
              {label} <span className="text-muted">{n}</span>
              {missing[k] > 0 && <span className="rounded-full bg-bad/20 px-1.5 text-[10px] text-bad">{missing[k]} required</span>}
            </button>
          ))}
        </div>
        {tab === "properties" && (
          <div className="space-y-2">
            <p className="text-xs text-muted">Map each interface property to a property of {t.display_name} with the same base type. Optional properties may stay unmapped.</p>
            {iface.all_properties.map((p) => (
              <div key={p.api_name} className="flex items-center gap-2">
                <span className="w-48 truncate">
                  {p.display_name || p.api_name}
                  {p.required && <span className="text-bad"> *</span>}
                  <span className="block text-[11px] text-muted">
                    {typeLabel(p.type, p.array)}
                    {p.primary_key_constraint === "must" ? " · must be the primary key" : p.primary_key_constraint === "cannot" ? " · cannot be the primary key" : ""}
                  </span>
                </span>
                <select value={mapping[p.api_name] ?? ""} onChange={(e) => setMapping({ ...mapping, [p.api_name]: e.target.value })} className={`${inputClass} flex-1`}>
                  <option value="">Not mapped</option>
                  {t.properties
                    .filter((x) => x.type === p.type && !!x.array === !!p.array)
                    .filter((x) => (p.primary_key_constraint === "must" ? x.api_name === t.primary_key : p.primary_key_constraint === "cannot" ? x.api_name !== t.primary_key : true))
                    .map((x) => (
                      <option key={x.api_name} value={x.api_name}>
                        {x.display_name}
                      </option>
                    ))}
                  {!p.array &&
                    p.primary_key_constraint !== "must" &&
                    t.properties
                      .filter((x) => x.type === "struct")
                      .flatMap((x) => (x.struct_fields ?? []).filter((f) => f.type === p.type).map((f) => ({ x, f })))
                      .map(({ x, f }) => (
                        <option key={`${x.api_name}.${f.api_name}`} value={`${x.api_name}.${f.api_name}`}>
                          {x.display_name} → {f.display_name || f.api_name} (struct field)
                        </option>
                      ))}
                </select>
              </div>
            ))}
          </div>
        )}
        {tab === "links" && (
          <div className="space-y-2">
            {lcs.length === 0 && <p className="text-xs text-muted">The interface has no link type constraints.</p>}
            {lcs.map((lc) => {
              const fits = linkTypes.filter((lt) => linkFits(t, lt, lc, types));
              return (
                <div key={lc.api_name} className="flex items-center gap-2">
                  <span className="w-48 truncate">
                    {lc.display_name || lc.api_name}
                    {lc.required && <span className="text-bad"> *</span>}
                    <span className="block text-[11px] text-muted">
                      {lc.cardinality === "one" ? "One" : "Many"} →{" "}
                      {lc.target_interface_id ? `objects of an interface` : (types.find((x) => x.id === lc.target_object_type_id)?.display_name ?? "an object type")}
                    </span>
                  </span>
                  <select value={links[lc.api_name] ?? ""} onChange={(e) => setLinks({ ...links, [lc.api_name]: e.target.value })} className={`${inputClass} flex-1`}>
                    <option value="">{fits.length ? "Not mapped" : "No link type of this object type satisfies the constraint"}</option>
                    {fits.map((lt) => (
                      <option key={lt.id} value={lt.id}>
                        {lt.display_name} ({lt.source.display_name} → {lt.target.display_name})
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        )}
        {tab === "actions" && (
          <div className="space-y-2">
            {acs.length === 0 && <p className="text-xs text-muted">The interface has no action type constraints.</p>}
            {acs.map((c) => {
              const m = acts[c.api_name];
              const fits = actionTypes.filter((a) => (c.parameters ?? []).filter((pc) => pc.required).every((pc) => a.parameters.some((p) => paramFits(p as never, pc))));
              const unmapped = (c.parameters ?? []).filter((pc) => pc.required && !m?.parameters?.[pc.api_name]).length;
              return (
                <div key={c.api_name} className="rounded-lg border border-line-2 p-2">
                  <div className="flex items-center gap-2">
                    <span className="w-48 truncate">
                      {c.display_name || c.api_name}
                      {c.required && <span className="text-bad"> *</span>}
                      <span className="block text-[11px] text-muted">{c.parameters.length} parameter constraints</span>
                    </span>
                    <select
                      value={m?.action_type_id ?? ""}
                      onChange={(e) => {
                        const a = actionTypes.find((x) => x.id === e.target.value);
                        // pre-map parameters by API name / display name when compatible
                        const params = Object.fromEntries(
                          (c.parameters ?? [])
                            .map((pc) => [pc.api_name, a?.parameters.find((p) => (p.id === pc.api_name || p.display_name === pc.display_name) && paramFits(p as never, pc))?.id ?? ""])
                            .filter(([, v]) => v),
                        );
                        setActs({ ...acts, [c.api_name]: { action_type_id: e.target.value, parameters: params } });
                      }}
                      className={`${inputClass} flex-1`}
                    >
                      <option value="">Not mapped</option>
                      {fits.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.display_name}
                        </option>
                      ))}
                    </select>
                    <button type="button" disabled={!m?.action_type_id} onClick={() => setConfiguring(c.api_name)} title="Configure parameters" className="rounded p-1.5 text-muted hover:bg-panel-2 hover:text-white disabled:opacity-40">
                      <Icon name="sliders" className="h-4 w-4" />
                    </button>
                  </div>
                  {c.description && <p className="mt-1 text-xs text-muted">{c.description}</p>}
                  {m?.action_type_id && unmapped > 0 && <p className="mt-1 text-xs text-bad">{unmapped} required parameter constraint(s) not mapped</p>}
                </div>
              );
            })}
          </div>
        )}
        {ac && acAction && (
          <div className="rounded-lg border border-ocean/40 bg-ocean/5 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
              Configure parameters: {ac.display_name || ac.api_name} → {acAction.display_name}
              <button type="button" onClick={() => setConfiguring(null)} className="ml-auto text-muted hover:text-white">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </div>
            {ac.parameters.map((pc) => {
              const used = Object.entries(acts[ac.api_name]?.parameters ?? {})
                .filter(([k]) => k !== pc.api_name)
                .map(([, v]) => v);
              return (
                <div key={pc.api_name} className="mb-1.5 flex items-center gap-2 text-xs">
                  <span className="w-48 truncate">
                    {pc.display_name || pc.api_name}
                    {pc.required && <span className="text-bad"> *</span>} <span className="text-muted">{pc.type}{pc.list ? " list" : ""}</span>
                  </span>
                  <select
                    value={acts[ac.api_name]?.parameters?.[pc.api_name] ?? ""}
                    onChange={(e) => {
                      const cur = acts[ac.api_name];
                      const params = { ...(cur.parameters ?? {}), [pc.api_name]: e.target.value };
                      if (!e.target.value) delete params[pc.api_name];
                      setActs({ ...acts, [ac.api_name]: { ...cur, parameters: params } });
                    }}
                    className={`${inputClass} flex-1 py-1 text-xs`}
                  >
                    <option value="">Not mapped</option>
                    {acAction.parameters
                      .filter((p) => paramFits(p as never, pc) && !used.includes(p.id))
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.display_name} ({p.id})
                        </option>
                      ))}
                  </select>
                </div>
              );
            })}
          </div>
        )}
        <ErrorBox message={error} />
        <div className="flex items-center justify-end gap-2">
          {missing.properties + missing.links + missing.actions > 0 && <span className="mr-auto text-xs text-bad">Map every required constraint before saving.</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={save} className={buttonClass.primary}>
            {current ? "Save" : "Implement"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
