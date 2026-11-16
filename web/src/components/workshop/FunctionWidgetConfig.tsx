"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Field } from "@/components/ontology/parts";
import { inputClass } from "@/components/pipeline/Modal";
import { functions, type FnInput, type FunctionRow } from "@/lib/actions";
import { interfaceInput, type InterfaceSource, type ObjectInputBinding, type Variable, type Widget, type WidgetConfig } from "@/lib/workshop";
/** The interface (by API name or id) an interface-typed input names, and the interfaces extending it. */
export function interfacesFor(name: string, interfaces: InterfaceSource[]): InterfaceSource[] {
  const base = interfaces.find((x) => x.api_name === name || x.id === name);
  if (!base) return [];
  return [base, ...interfaces.filter((x) => x.id !== base.id && (x.extends ?? []).includes(base.id))];
}

/** An interface-typed function input (interface:X, array<interface:X>, interface_set:X): fed the object selected in a
 * widget on the interface (or an extending one) or on an implementing object type, an object / object set variable, or
 * (object sets) every object of the interface. Unbound, it stays a JSON / $var:name text input. */
function InterfaceInputField({ input, binding, interfaces, variables, onChange }: { input: FnInput; binding?: ObjectInputBinding; interfaces: InterfaceSource[]; variables: Variable[]; onChange: (b: ObjectInputBinding | undefined) => void }) {
  const info = interfaceInput(input.type)!;
  const ifs = interfacesFor(info.iface, interfaces);
  const types = [...new Map(ifs.flatMap((x) => x.types ?? []).map((t) => [t.id, t])).values()];
  const b = binding;
  const from = b?.from ?? "";
  const vars = variables.filter((v) => ["object", "object_set", "array", "string", "struct"].includes(v.type));
  return (
    <Field
      label={`${input.name}${input.required ? " *" : ""}`}
      hint={`${input.type} · ${ifs[0] ? `${ifs[0].name}: ${types.length} implementing type${types.length === 1 ? "" : "s"}` : "interface not found in the sources"}`}
    >
      <div className="space-y-1.5" data-interface-input={input.name}>
        <select
          value={from}
          onChange={(e) => {
            const v = e.target.value as ObjectInputBinding["from"] | "";
            onChange(v ? { from: v, type: input.type, ...(v === "selection" && ifs[0] ? { source: `interface:${ifs[0].id}` } : {}) } : undefined);
          }}
          className={inputClass}
        >
          <option value="">Typed value (JSON or $var:name)</option>
          <option value="selection">Selected object</option>
          <option value="variable">Object / object set variable</option>
          {info.shape === "set" && <option value="all">Every object of the interface</option>}
        </select>
        {from === "selection" && (
          <select value={b?.source ?? ""} onChange={(e) => onChange({ ...b!, source: e.target.value || undefined })} className={inputClass}>
            <option value="">Selected in a widget on…</option>
            {ifs.map((x) => (
              <option key={x.id} value={`interface:${x.id}`}>
                Interface: {x.name}
              </option>
            ))}
            {types.map((t) => (
              <option key={t.id} value={`object_type:${t.id}`}>
                Object type: {t.name}
              </option>
            ))}
          </select>
        )}
        {from === "variable" && (
          <div className="flex gap-2">
            <select value={b?.variable ?? ""} onChange={(e) => onChange({ ...b!, variable: e.target.value || undefined })} className={inputClass}>
              <option value="">Variable…</option>
              {vars.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name} ({v.type})
                </option>
              ))}
            </select>
            <select value={b?.object_type_id ?? ""} onChange={(e) => onChange({ ...b!, object_type_id: e.target.value || undefined })} className={inputClass} title="The object type of bare primary keys in the variable (references and <type id>:<pk> values carry their own)">
              <option value="">Keys carry their type</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  Keys of {t.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </Field>
  );
}

/** The function widget's configuration: the published function, its version, the selection it follows and fixed inputs. */
export function FunctionWidgetConfig({ widget, set, objectTypes, interfaces = [], variables = [] }: { widget: Widget; set: (c: Partial<WidgetConfig>) => void; objectTypes: { id: string; name: string }[]; interfaces?: InterfaceSource[]; variables?: Variable[] }) {
  const c = widget.config;
  const [fns, setFns] = useState<FunctionRow[]>([]);
  useEffect(() => {
    functions.list().then(setFns, () => setFns([]));
  }, []);
  const f = fns.find((x) => x.id === c.function_id);
  return (
    <>
      <Field label="Function" hint={fns.length ? undefined : "No published functions yet"}>
        <select value={c.function_id ?? ""} onChange={(e) => set({ function_id: e.target.value || undefined, function_inputs: {}, object_input: undefined, function_object_inputs: undefined })} className={inputClass}>
          <option value="">Choose a function…</option>
          {fns.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} ({x.version})
            </option>
          ))}
        </select>
      </Field>
      {f && (
        <>
          <Link href={`/functions/${f.id}`} className="block text-xs text-ocean hover:underline">
            Open in Functions
          </Link>
          <Field label="Version" hint="Exact version or a range such as ^1.0.0; empty uses the latest release">
            <input value={c.function_version ?? ""} onChange={(e) => set({ function_version: e.target.value || undefined })} placeholder={`^${f.version.split(".")[0]}.0.0`} className={`${inputClass} font-mono`} />
          </Field>
          <Field label="Selected object" hint="Feed the object selected in a table on this object type to an input">
            <div className="flex gap-2">
              <select value={c.object_type_id ?? ""} onChange={(e) => set({ object_type_id: e.target.value || undefined })} className={inputClass}>
                <option value="">None</option>
                {objectTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {c.object_type_id && (
                <select value={c.object_input ?? ""} onChange={(e) => set({ object_input: e.target.value || undefined })} className={inputClass}>
                  <option value="">Input…</option>
                  {f.inputs.map((i) => (
                    <option key={i.name} value={i.name}>
                      {i.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </Field>
          {f.inputs
            .filter((i) => i.name !== c.object_input && interfaceInput(i.type))
            .map((i) => (
              <InterfaceInputField
                key={i.name}
                input={i}
                binding={c.function_object_inputs?.[i.name]}
                interfaces={interfaces}
                variables={variables}
                onChange={(b) => {
                  const next = { ...(c.function_object_inputs ?? {}) };
                  if (b) next[i.name] = b;
                  else delete next[i.name];
                  set({ function_object_inputs: Object.keys(next).length ? next : undefined });
                }}
              />
            ))}
          {f.inputs
            .filter((i) => i.name !== c.object_input && !(interfaceInput(i.type) && c.function_object_inputs?.[i.name]))
            .map((i) => (
              <Field key={i.name} label={`${i.name}${i.required ? " *" : ""}`} hint={`${i.type} · JSON or text, or $var:name for a module variable`}>
                <input value={c.function_inputs?.[i.name] ?? ""} onChange={(e) => set({ function_inputs: { ...c.function_inputs, [i.name]: e.target.value } })} className={`${inputClass} font-mono`} />
              </Field>
            ))}
          <Field label="Output variable" hint="Write the result to a module variable: other widgets read it as $var:name (inputs, filter values) or {{name}} in text">
            <input value={c.output_variable ?? ""} onChange={(e) => set({ output_variable: e.target.value.replace(/[^\w.-]/g, "") || undefined })} placeholder="e.g. totalClaims" className={`${inputClass} font-mono`} />
          </Field>
        </>
      )}
    </>
  );
}

/** Object tables: a function-backed column (functions returning Map<Object, value> from an object set input). */
export function FunctionColumnConfig({ widget, set }: { widget: Widget; set: (c: Partial<WidgetConfig>) => void }) {
  const c = widget.config;
  const [fns, setFns] = useState<FunctionRow[]>([]);
  useEffect(() => {
    functions.list().then((rows) => setFns(rows.filter((f) => f.output.startsWith("map<object:"))), () => setFns([]));
  }, []);
  const f = fns.find((x) => x.id === c.column_function_id);
  return (
    <Field label="Function-backed column" hint="A function that takes an object set and returns Map<Object, value>">
      <div className="space-y-1.5">
        <select value={c.column_function_id ?? ""} onChange={(e) => set({ column_function_id: e.target.value || undefined, column_function_input: undefined })} className={inputClass}>
          <option value="">None</option>
          {fns.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} ({x.version})
            </option>
          ))}
        </select>
        {f && (
          <>
            <select value={c.column_function_input ?? ""} onChange={(e) => set({ column_function_input: e.target.value || undefined })} className={inputClass}>
              <option value="">Object set input…</option>
              {f.inputs
                .filter((i) => i.type.startsWith("object_set:") || i.type.startsWith("array<object:"))
                .map((i) => (
                  <option key={i.name} value={i.name}>
                    {i.name} ({i.type})
                  </option>
                ))}
            </select>
            <input value={c.column_function_label ?? ""} onChange={(e) => set({ column_function_label: e.target.value })} placeholder="Column header" className={inputClass} />
          </>
        )}
      </div>
    </Field>
  );
}
