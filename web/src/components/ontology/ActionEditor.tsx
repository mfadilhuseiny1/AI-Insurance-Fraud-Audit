"use client";

import { Icon } from "@/components/Icon";
import { Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { RULE_INFO, ruleLabel, type ActionParam, type Condition, type Rule, type Section, type ValueRef, type FunctionRow, type FnRef } from "@/lib/actions";
import { PROPERTY_TYPES, type ObjectType } from "@/lib/ontology";
import type { Interface, LinkType, ValueType } from "@/lib/ontologyModel";

export type EditorData = {
  types: ObjectType[];
  links: LinkType[];
  interfaces: Interface[];
  valueTypes: ValueType[];
  functions: FunctionRow[];
  webhooks: { id: string; name: string; inputs: { id?: string; name?: string }[] }[];
};

const small = `${fieldClass} py-1 text-xs`;
export const PARAM_TYPES: { id: string; label: string }[] = [
  { id: "object", label: "Object reference" },
  { id: "interface", label: "Interface reference" },
  { id: "object_type", label: "Object type (interface create)" },
  { id: "user", label: "User" },
  { id: "group", label: "Group" },
  ...PROPERTY_TYPES.filter((t) => !["timeseries", "string_array"].includes(t.id)).map((t) => ({ id: t.id, label: t.label })),
];

/** Where a rule gets a value: a parameter, an object parameter's property, a static value, the current user / time… */
export function RefEditor({ value, params, data, onChange, allow }: { value?: ValueRef | null; params: ActionParam[]; data: EditorData; onChange: (v: ValueRef | null) => void; allow?: string[] }) {
  const kinds = allow ?? ["parameter", "object_property", "static", "current_user", "current_time", "writeback_response", "schedule_run", "new_object"];
  const v = value ?? null;
  const objParams = params.filter((p) => p.type === "object" || p.type === "interface");
  const typeOf = (pid?: string) => {
    const p = params.find((x) => x.id === pid);
    return data.types.find((t) => t.id === p?.object_type_id);
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      <select value={v?.kind ?? ""} onChange={(e) => onChange(e.target.value ? ({ kind: e.target.value } as ValueRef) : null)} className={small}>
        <option value="">Not set</option>
        {kinds.map((k) => (
          <option key={k} value={k}>
            {{ parameter: "From parameter", object_property: "Object parameter property", static: "Static value", current_user: "Current user", current_time: "Current time", writeback_response: "Writeback response", schedule_run: "Schedule run ID", new_object: "New object (rule)" }[k]}
          </option>
        ))}
      </select>
      {(v?.kind === "parameter" || v?.kind === "object_property") && (
        <select value={v.parameter ?? ""} onChange={(e) => onChange({ ...v, parameter: e.target.value } as ValueRef)} className={small}>
          <option value="">Parameter…</option>
          {(v.kind === "object_property" ? objParams : params).map((p) => (
            <option key={p.id} value={p.id}>
              {p.display_name || p.id}
            </option>
          ))}
        </select>
      )}
      {v?.kind === "object_property" && (
        <select value={v.property ?? ""} onChange={(e) => onChange({ ...v, property: e.target.value })} className={small}>
          <option value="">Property…</option>
          {typeOf(v.parameter)?.properties.map((p) => (
            <option key={p.api_name} value={p.api_name}>
              {p.display_name}
            </option>
          ))}
        </select>
      )}
      {v?.kind === "static" && <input value={String(v.value ?? "")} onChange={(e) => onChange({ ...v, value: e.target.value })} placeholder="value" className={`${small} w-32`} />}
      {v?.kind === "writeback_response" && <input value={v.field ?? ""} onChange={(e) => onChange({ ...v, field: e.target.value })} placeholder="output" className={`${small} w-28`} />}
      {v?.kind === "new_object" && <input type="number" min={0} value={v.rule ?? 0} onChange={(e) => onChange({ ...v, rule: Number(e.target.value) })} className={`${small} w-16`} title="Rule number (from 0)" />}
    </div>
  );
}

const OPS = [
  ["is", "is"],
  ["is_not", "is not"],
  ["matches", "matches (regex)"],
  ["lt", "<"],
  ["lte", "≤"],
  ["gt", ">"],
  ["gte", "≥"],
  ["includes", "includes"],
  ["includes_any", "includes any"],
  ["included_in", "is included in"],
  ["each_is", "each is"],
  ["each_is_not", "each is not"],
];

/** A submission criterion or override condition: a condition, or an all / any / none group of them. */
export function ConditionEditor({ node, params, data, onChange, onRemove, root }: { node: Condition; params: ActionParam[]; data: EditorData; onChange: (c: Condition) => void; onRemove: () => void; root?: boolean }) {
  if (node.kind !== "condition") {
    return (
      <div className="space-y-1.5 rounded-md border border-line-2 p-2">
        <div className="flex items-center gap-1.5 text-xs">
          <select value={node.kind} onChange={(e) => onChange({ ...node, kind: e.target.value as "and" })} className={small}>
            <option value="and">All of</option>
            <option value="or">Any of</option>
            <option value="not">None of</option>
          </select>
          {root && <input value={node.failure_message ?? ""} onChange={(e) => onChange({ ...node, failure_message: e.target.value })} placeholder="Failure message" className={`${small} flex-1`} />}
          <button type="button" onClick={onRemove} className="ml-auto text-muted hover:text-bad">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
        {node.children.map((c, i) => (
          <div key={i} className="pl-3">
            <ConditionEditor node={c} params={params} data={data} onChange={(x) => onChange({ ...node, children: node.children.map((y, j) => (j === i ? x : y)) })} onRemove={() => onChange({ ...node, children: node.children.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <div className="flex gap-1 pl-3">
          <button type="button" onClick={() => onChange({ ...node, children: [...node.children, blankCondition()] })} className={buttonClass.ghost}>
            <Icon name="plus" className="h-3 w-3" /> Condition
          </button>
          <button type="button" onClick={() => onChange({ ...node, children: [...node.children, { kind: "and", children: [] }] })} className={buttonClass.ghost}>
            <Icon name="plus" className="h-3 w-3" /> Group
          </button>
        </div>
      </div>
    );
  }
  const left = node.left;
  const val = node.value ?? { kind: "static" };
  const leftType = data.types.find((t) => t.id === params.find((p) => p.id === left.parameter)?.object_type_id);
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md bg-panel-2 p-1.5 text-xs">
      <select value={left.kind} onChange={(e) => onChange({ ...node, left: { kind: e.target.value as "parameter" } })} className={small}>
        <option value="current_user_id">Current user ID</option>
        <option value="current_user_groups">Current user groups</option>
        <option value="current_user_attribute">Current user attribute</option>
        <option value="parameter">Parameter</option>
        <option value="execution_context">Execution context</option>
      </select>
      {left.kind === "current_user_attribute" && <input value={left.attribute ?? ""} onChange={(e) => onChange({ ...node, left: { ...left, attribute: e.target.value } })} placeholder="attribute" className={`${small} w-24`} />}
      {left.kind === "parameter" && (
        <>
          <select value={left.parameter ?? ""} onChange={(e) => onChange({ ...node, left: { ...left, parameter: e.target.value, property: undefined } })} className={small}>
            <option value="">Parameter…</option>
            {params.filter((p) => p.type !== "attachment").map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name || p.id}
              </option>
            ))}
          </select>
          {leftType && (
            <select value={left.property ?? ""} onChange={(e) => onChange({ ...node, left: { ...left, property: e.target.value || undefined } })} className={small}>
              <option value="">(the object)</option>
              {leftType.properties.map((p) => (
                <option key={p.api_name} value={p.api_name}>
                  {p.display_name}
                </option>
              ))}
            </select>
          )}
          <label className="flex items-center gap-1 text-muted">
            <input type="checkbox" checked={!!left.length} onChange={(e) => onChange({ ...node, left: { ...left, length: e.target.checked } })} /> length
          </label>
        </>
      )}
      <select value={node.op} onChange={(e) => onChange({ ...node, op: e.target.value })} className={small}>
        {OPS.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
      <select value={val.kind} onChange={(e) => onChange({ ...node, value: { kind: e.target.value as "static" } })} className={small}>
        <option value="static">Specific value</option>
        <option value="parameter">Parameter</option>
        <option value="no_value">No value</option>
      </select>
      {val.kind === "static" && (
        <input
          value={Array.isArray(val.value) ? (val.value as unknown[]).join(", ") : String(val.value ?? "")}
          onChange={(e) => onChange({ ...node, value: { kind: "static", value: e.target.value.includes(",") ? e.target.value.split(",").map((x) => x.trim()) : e.target.value } })}
          placeholder="value (comma separates a list)"
          className={`${small} w-40`}
        />
      )}
      {val.kind === "parameter" && (
        <select value={val.parameter ?? ""} onChange={(e) => onChange({ ...node, value: { ...val, parameter: e.target.value } })} className={small}>
          <option value="">Parameter…</option>
          {params.map((p) => (
            <option key={p.id} value={p.id}>
              {p.display_name || p.id}
            </option>
          ))}
        </select>
      )}
      {root && <input value={node.failure_message ?? ""} onChange={(e) => onChange({ ...node, failure_message: e.target.value })} placeholder="Failure message" className={`${small} min-w-40 flex-1`} />}
      <button type="button" onClick={onRemove} className="ml-auto text-muted hover:text-bad">
        <Icon name="x" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export const blankCondition = (): Condition => ({ kind: "condition", left: { kind: "current_user_groups" }, op: "includes", value: { kind: "static", value: "" } });

/** One parameter's configuration: type, required, visibility, default, allowed values, object filters, overrides. */
export function ParamEditor({ p, params, data, onChange }: { p: ActionParam; params: ActionParam[]; data: EditorData; onChange: (p: ActionParam) => void }) {
  const set = (c: Partial<ActionParam>) => onChange({ ...p, ...c });
  const above = params.slice(0, params.findIndex((x) => x.id === p.id));
  const objType = data.types.find((t) => t.id === p.object_type_id);
  const d = p.default ?? null;
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Display name">
          <input value={p.display_name} onChange={(e) => set({ display_name: e.target.value })} className={inputClass} />
        </Field>
        <Field label="ID">
          <input value={p.id} onChange={(e) => set({ id: e.target.value })} className={`${inputClass} font-mono`} />
        </Field>
      </div>
      <Field label="Description" hint="Shown under the parameter in the form">
        <input value={p.description ?? ""} onChange={(e) => set({ description: e.target.value })} className={inputClass} />
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Type">
          <select value={p.type} onChange={(e) => set({ type: e.target.value })} className={inputClass}>
            {PARAM_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Visibility">
          <select value={p.visibility ?? "normal"} onChange={(e) => set({ visibility: e.target.value as ActionParam["visibility"] })} className={inputClass}>
            <option value="normal">Editable</option>
            <option value="disabled">Disabled</option>
            <option value="hidden">Hidden</option>
          </select>
        </Field>
        <div className="flex flex-col justify-end gap-1 pb-1 text-xs text-soft">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={!!p.required} onChange={(e) => set({ required: e.target.checked })} /> Required
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={!!p.array} onChange={(e) => set({ array: e.target.checked })} /> Allow multiple values
          </label>
        </div>
      </div>
      {p.type === "object" && (
        <Field label="Object type">
          <select value={p.object_type_id ?? ""} onChange={(e) => set({ object_type_id: e.target.value })} className={inputClass}>
            <option value="">Pick…</option>
            {data.types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.display_name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {(p.type === "interface" || p.type === "object_type") && (
        <Field label="Interface">
          <select value={p.interface_id ?? ""} onChange={(e) => set({ interface_id: e.target.value })} className={inputClass}>
            <option value="">Pick…</option>
            {data.interfaces.map((i) => (
              <option key={i.id} value={i.id}>
                {i.display_name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!["object", "interface", "object_type", "user", "group"].includes(p.type) && (
        <Field label="Value type constraint">
          <select value={p.value_type_id ?? ""} onChange={(e) => set({ value_type_id: e.target.value || null })} className={inputClass}>
            <option value="">None</option>
            {data.valueTypes.map((v) => (
              <option key={v.id} value={v.id}>
                {v.display_name} ({v.base_type})
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="rounded-md border border-line-2 p-2">
        <div className="mb-1 text-xs font-medium text-soft">Default value</div>
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <select value={d?.kind ?? ""} onChange={(e) => set({ default: e.target.value ? ({ kind: e.target.value } as ActionParam["default"]) : null })} className={small}>
            <option value="">None</option>
            <option value="static">Static value</option>
            <option value="object_property">Object parameter property</option>
            <option value="parameter">Another parameter</option>
            <option value="current_user">Current user</option>
            <option value="current_time">Current time</option>
          </select>
          {d?.kind === "static" && <input value={String(d.value ?? "")} onChange={(e) => set({ default: { ...d, value: e.target.value } })} className={`${small} w-36`} />}
          {(d?.kind === "object_property" || d?.kind === "parameter") && (
            <select value={d.parameter ?? ""} onChange={(e) => set({ default: { ...d, parameter: e.target.value } })} className={small}>
              <option value="">Parameter above…</option>
              {above
                .filter((x) => d.kind === "parameter" || x.type === "object")
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.display_name || x.id}
                  </option>
                ))}
            </select>
          )}
          {d?.kind === "object_property" && (
            <select value={d.property ?? ""} onChange={(e) => set({ default: { ...d, property: e.target.value } })} className={small}>
              <option value="">Property…</option>
              {data.types
                .find((t) => t.id === above.find((x) => x.id === d.parameter)?.object_type_id)
                ?.properties.map((x) => (
                  <option key={x.api_name} value={x.api_name}>
                    {x.display_name}
                  </option>
                ))}
            </select>
          )}
        </div>
      </div>
      {p.type !== "object" && (
        <div className="rounded-md border border-line-2 p-2">
          <div className="mb-1 text-xs font-medium text-soft">Allowed values</div>
          <div className="flex flex-wrap items-center gap-1 text-xs">
            <select
              value={p.allowed?.kind ?? ""}
              onChange={(e) => set({ allowed: e.target.value === "values" ? { kind: "values", values: [] } : e.target.value === "object_set_property" ? { kind: "object_set_property", object_type_id: "", property: "" } : null })}
              className={small}
            >
              <option value="">Any value</option>
              <option value="values">Multiple choice</option>
              <option value="object_set_property">Get options from an object set</option>
            </select>
            {p.allowed?.kind === "values" && (
              <input
                value={(p.allowed.values ?? []).join(", ")}
                onChange={(e) => set({ allowed: { kind: "values", values: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })}
                placeholder="comma separated"
                className={`${small} flex-1`}
              />
            )}
            {p.allowed?.kind === "object_set_property" && (
              <>
                <select value={p.allowed.object_type_id} onChange={(e) => set({ allowed: { kind: "object_set_property", object_type_id: e.target.value, property: "" } })} className={small}>
                  <option value="">Object type…</option>
                  {data.types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.display_name}
                    </option>
                  ))}
                </select>
                <select
                  value={p.allowed.property}
                  onChange={(e) => set({ allowed: { kind: "object_set_property", object_type_id: (p.allowed as { object_type_id: string }).object_type_id, property: e.target.value } })}
                  className={small}
                >
                  <option value="">Property…</option>
                  {data.types
                    .find((t) => t.id === (p.allowed as { object_type_id: string }).object_type_id)
                    ?.properties.map((x) => (
                      <option key={x.api_name} value={x.api_name}>
                        {x.display_name}
                      </option>
                    ))}
                </select>
              </>
            )}
          </div>
        </div>
      )}
      {p.type === "object" && objType && (
        <div className="space-y-1 rounded-md border border-line-2 p-2 text-xs">
          <div className="font-medium text-soft">Dropdown filters</div>
          {(p.object_filter?.filters ?? []).map((f, i) => {
            const src = f.values[0] ?? { kind: "static" };
            const setF = (nf: typeof f) => set({ object_filter: { ...p.object_filter, filters: (p.object_filter?.filters ?? []).map((x, j) => (j === i ? nf : x)) } });
            return (
              <div key={i} className="flex flex-wrap items-center gap-1">
                <select value={f.property} onChange={(e) => setF({ ...f, property: e.target.value })} className={small}>
                  {objType.properties.map((x) => (
                    <option key={x.api_name} value={x.api_name}>
                      {x.display_name}
                    </option>
                  ))}
                </select>
                <span className="text-muted">matches</span>
                <select value={src.kind} onChange={(e) => setF({ ...f, values: [{ kind: e.target.value as "static" }] })} className={small}>
                  <option value="static">Static values</option>
                  <option value="parameter">Parameter</option>
                </select>
                {src.kind === "static" ? (
                  <input
                    value={f.values.map((v) => String(v.value ?? "")).join(", ")}
                    onChange={(e) => setF({ ...f, values: e.target.value.split(",").map((x) => ({ kind: "static" as const, value: x.trim() })) })}
                    className={`${small} w-36`}
                  />
                ) : (
                  <select value={src.parameter ?? ""} onChange={(e) => setF({ ...f, values: [{ kind: "parameter", parameter: e.target.value }] })} className={small}>
                    <option value="">Parameter above…</option>
                    {above.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.display_name || x.id}
                      </option>
                    ))}
                  </select>
                )}
                <button type="button" onClick={() => set({ object_filter: { ...p.object_filter, filters: (p.object_filter?.filters ?? []).filter((_, j) => j !== i) } })} className="text-muted hover:text-bad">
                  <Icon name="x" className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => set({ object_filter: { ...p.object_filter, filters: [...(p.object_filter?.filters ?? []), { property: objType.properties[0]?.api_name ?? "", values: [{ kind: "static", value: "" }] }] } })}
            className={buttonClass.ghost}
          >
            <Icon name="plus" className="h-3 w-3" /> Filter
          </button>
          <p className="text-[11px] text-muted">Static filter values are visible to everyone who can view the action type.</p>
        </div>
      )}
      <div className="space-y-1.5 rounded-md border border-line-2 p-2 text-xs">
        <div className="font-medium text-soft">Overrides (the first block whose conditions hold applies; conditions use parameters above)</div>
        {(p.overrides ?? []).map((b, i) => {
          const setB = (nb: typeof b) => set({ overrides: (p.overrides ?? []).map((x, j) => (j === i ? nb : x)) });
          return (
            <div key={i} className="space-y-1 rounded bg-panel-2 p-1.5">
              <div className="text-muted">If</div>
              {b.conditions.map((c, j) => (
                <ConditionEditor key={j} node={c} params={above} data={data} onChange={(x) => setB({ ...b, conditions: b.conditions.map((y, k) => (k === j ? x : y)) })} onRemove={() => setB({ ...b, conditions: b.conditions.filter((_, k) => k !== j) })} />
              ))}
              <button type="button" onClick={() => setB({ ...b, conditions: [...b.conditions, blankCondition()] })} className={buttonClass.ghost}>
                <Icon name="plus" className="h-3 w-3" /> Condition
              </button>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted">Then</span>
                <select value={b.then.visibility ?? ""} onChange={(e) => setB({ ...b, then: { ...b.then, visibility: (e.target.value || undefined) as never } })} className={small}>
                  <option value="">Visibility unchanged</option>
                  <option value="normal">Editable</option>
                  <option value="disabled">Disabled</option>
                  <option value="hidden">Hidden</option>
                </select>
                <select value={b.then.required === undefined ? "" : String(b.then.required)} onChange={(e) => setB({ ...b, then: { ...b.then, required: e.target.value === "" ? undefined : e.target.value === "true" } })} className={small}>
                  <option value="">Requiredness unchanged</option>
                  <option value="true">Required</option>
                  <option value="false">Optional</option>
                </select>
                <input
                  value={b.then.default?.kind === "static" ? String(b.then.default.value ?? "") : ""}
                  onChange={(e) => setB({ ...b, then: { ...b.then, default: e.target.value ? { kind: "static", value: e.target.value } : undefined } })}
                  placeholder="Default (static)"
                  className={`${small} w-32`}
                />
                <button type="button" onClick={() => set({ overrides: (p.overrides ?? []).filter((_, j) => j !== i) })} className="ml-auto text-muted hover:text-bad">
                  <Icon name="trash" className="h-3 w-3" />
                </button>
              </div>
            </div>
          );
        })}
        <button type="button" onClick={() => set({ overrides: [...(p.overrides ?? []), { conditions: [blankCondition()], then: {} }] })} className={buttonClass.ghost}>
          <Icon name="plus" className="h-3 w-3" /> Override block
        </button>
      </div>
    </div>
  );
}

/** One rule's configuration. */
export function RuleEditor({ rule, index, params, data, objectTypeId, onChange, onAddParams }: {
  rule: Rule;
  index: number;
  params: ActionParam[];
  data: EditorData;
  objectTypeId: string | null;
  onChange: (r: Rule) => void;
  onAddParams: (p: ActionParam[]) => void;
}) {
  const set = (c: Partial<Rule>) => onChange({ ...rule, ...c });
  const t = data.types.find((x) => x.id === (rule.object_type_id ?? objectTypeId));
  const objParams = params.filter((p) => p.type === "object");
  const iface = data.interfaces.find((i) => i.id === rule.interface_id);
  const mapping = (props: { api_name: string; display_name?: string }[], cur: Record<string, ValueRef> | undefined) => (
    <div className="space-y-1">
      {Object.entries(cur ?? {}).map(([k, ref]) => (
        <div key={k} className="flex items-center gap-1.5 text-xs">
          <span className="w-32 truncate font-mono">{k}</span>
          <RefEditor value={ref} params={params} data={data} onChange={(v) => set({ properties: v ? { ...cur, [k]: v } : Object.fromEntries(Object.entries(cur ?? {}).filter(([x]) => x !== k)) })} />
        </div>
      ))}
      <select
        value=""
        onChange={(e) => {
          const name = e.target.value;
          if (!name) return;
          // a new property gets a parameter of the same name, as in Foundry
          const exists = params.some((p) => p.id === name);
          if (!exists) {
            const prop = t?.properties.find((x) => x.api_name === name);
            onAddParams([{ id: name, display_name: prop?.display_name ?? name, type: prop?.type ?? "string", array: prop?.array }]);
          }
          set({ properties: { ...cur, [name]: { kind: "parameter", parameter: name } } });
        }}
        className={small}
      >
        <option value="">+ Add property…</option>
        {props
          .filter((p) => !(p.api_name in (cur ?? {})))
          .map((p) => (
            <option key={p.api_name} value={p.api_name}>
              {p.display_name || p.api_name}
            </option>
          ))}
      </select>
    </div>
  );
  const typeSelect = (
    <select value={rule.object_type_id ?? ""} onChange={(e) => set({ object_type_id: e.target.value })} className={small}>
      <option value="">Object type…</option>
      {data.types.map((x) => (
        <option key={x.id} value={x.id}>
          {x.display_name}
        </option>
      ))}
    </select>
  );
  const paramSelect = (key: "object_param" | "interface_param" | "object_type_param", kind: string) => (
    <select value={(rule[key] as string) ?? ""} onChange={(e) => set({ [key]: e.target.value })} className={small}>
      <option value="">Parameter…</option>
      {params
        .filter((p) => p.type === kind)
        .map((p) => (
          <option key={p.id} value={p.id}>
            {p.display_name || p.id}
          </option>
        ))}
    </select>
  );
  const fn = data.functions.find((f) => f.id === rule.function_id);
  const hook = data.webhooks.find((w) => w.id === rule.webhook_id);
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2 text-xs text-muted">
        Rule {index} · {ruleLabel(rule.kind)} · {RULE_INFO.find((r) => r.kind === rule.kind)?.description}
      </div>
      {["create_object", "modify_object", "create_or_modify_object", "delete_object"].includes(rule.kind) && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {typeSelect}
            {rule.kind !== "create_object" && paramSelect("object_param", "object")}
          </div>
          {rule.kind !== "delete_object" && t && mapping(t.properties.filter((p) => !p.derived), rule.properties)}
          {rule.kind === "create_object" && t && (
            <div className="space-y-1 text-xs">
              <div className="text-muted">Many-to-many links of the new object</div>
              {(rule.links ?? []).map((ln, i) => (
                <div key={i} className="flex items-center gap-1">
                  <select value={ln.link_type_id} onChange={(e) => set({ links: (rule.links ?? []).map((x, j) => (j === i ? { ...x, link_type_id: e.target.value } : x)) })} className={small}>
                    {data.links
                      .filter((l) => l.kind === "join_table" && (l.source.object_type_id === t.id || l.target.object_type_id === t.id))
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.display_name}
                        </option>
                      ))}
                  </select>
                  <RefEditor value={ln.target} params={objParams} data={data} allow={["parameter"]} onChange={(v) => set({ links: (rule.links ?? []).map((x, j) => (j === i ? { ...x, target: v as ValueRef } : x)) })} />
                  <button type="button" onClick={() => set({ links: (rule.links ?? []).filter((_, j) => j !== i) })} className="text-muted hover:text-bad">
                    <Icon name="x" className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  const l = data.links.find((x) => x.kind === "join_table" && (x.source.object_type_id === t.id || x.target.object_type_id === t.id));
                  if (l) set({ links: [...(rule.links ?? []), { link_type_id: l.id, target: { kind: "parameter", parameter: objParams[0]?.id ?? "" } }] });
                }}
                className={buttonClass.ghost}
              >
                <Icon name="plus" className="h-3 w-3" /> Add link
              </button>
            </div>
          )}
        </>
      )}
      {(rule.kind === "create_link" || rule.kind === "delete_link") && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <select value={rule.link_type_id ?? ""} onChange={(e) => set({ link_type_id: e.target.value })} className={small}>
            <option value="">Many-to-many link type…</option>
            {data.links
              .filter((l) => l.kind === "join_table")
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.display_name}
                </option>
              ))}
          </select>
          <span className="text-muted">source</span>
          <RefEditor value={rule.source} params={objParams} data={data} allow={["parameter", "new_object"]} onChange={(v) => set({ source: v as ValueRef })} />
          <span className="text-muted">target</span>
          <RefEditor value={rule.target} params={objParams} data={data} allow={["parameter", "new_object"]} onChange={(v) => set({ target: v as ValueRef })} />
        </div>
      )}
      {rule.kind.includes("interface") && (
        <div className="space-y-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <select value={rule.interface_id ?? ""} onChange={(e) => set({ interface_id: e.target.value })} className={small}>
              <option value="">Interface…</option>
              {data.interfaces.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.display_name}
                </option>
              ))}
            </select>
            {rule.kind === "create_interface_object" && paramSelect("object_type_param", "object_type")}
            {(rule.kind === "modify_interface_object" || rule.kind === "delete_interface_object") && paramSelect("interface_param", "interface")}
            {rule.kind.endsWith("_link") && (
              <>
                <select value={rule.link_constraint ?? ""} onChange={(e) => set({ link_constraint: e.target.value })} className={small}>
                  <option value="">Link type constraint…</option>
                  {(iface?.all_link_constraints ?? iface?.link_constraints ?? []).map((c) => (
                    <option key={c.api_name} value={c.api_name}>
                      {c.display_name || c.api_name}
                    </option>
                  ))}
                </select>
                <RefEditor value={rule.source} params={params} data={data} allow={["parameter"]} onChange={(v) => set({ source: v as ValueRef })} />
                <RefEditor value={rule.target} params={params} data={data} allow={["parameter"]} onChange={(v) => set({ target: v as ValueRef })} />
              </>
            )}
          </div>
          {iface && (rule.kind === "create_interface_object" || rule.kind === "modify_interface_object") && mapping(iface.all_properties, rule.properties)}
        </div>
      )}
      {rule.kind === "function" && (
        <div className="space-y-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <select value={rule.function_id ?? ""} onChange={(e) => set({ function_id: e.target.value, inputs: {} })} className={small}>
              <option value="">Nexus edit function…</option>
              {data.functions
                .filter((f) => f.kind === "edit")
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} ({f.version})
                  </option>
                ))}
            </select>
            <input value={rule.version ?? ""} onChange={(e) => set({ version: e.target.value })} placeholder={fn ? `${fn.version} or ^${fn.version}` : "version"} className={`${small} w-32`} title="A version, or a range like ^1.2.0 for auto upgrades" />
            <label className="flex items-center gap-1 text-muted">
              <input type="checkbox" checked={!!rule.batched} onChange={(e) => set({ batched: e.target.checked, inputs: {} })} /> Batched execution
            </label>
            {fn && !rule.batched && (
              <button
                type="button"
                onClick={() => {
                  const missing = fn.inputs.filter((i) => !params.some((p) => p.id === i.name));
                  onAddParams(
                    missing.map((i) => {
                      const obj = i.type.replace(/^array</, "").replace(/>$/, "");
                      const tt = obj.startsWith("object:") ? data.types.find((x) => x.api_name === obj.slice(7)) : undefined;
                      return { id: i.name, display_name: i.name, type: tt ? "object" : i.type.includes("integer") ? "integer" : i.type.includes("double") ? "double" : i.type.includes("boolean") ? "boolean" : "string", object_type_id: tt?.id, required: i.required, array: i.type.startsWith("array<") };
                    }),
                  );
                  set({ inputs: Object.fromEntries(fn.inputs.map((i) => [i.name, { kind: "parameter", parameter: i.name } as ValueRef])) });
                }}
                className={buttonClass.secondary}
              >
                Generate parameters from inputs
              </button>
            )}
          </div>
          {rule.batched && (
            <div className="space-y-1.5">
              <p className="text-muted">
                The function takes one list of structs ({fn?.inputs[0] ? <span className="font-mono">{fn.inputs[0].name}</span> : "its single input"}); a batch of action calls runs it once, with an entry per call. Map each struct field:
              </p>
              {Object.entries(rule.inputs ?? {}).map(([name, ref]) => (
                <div key={name} className="flex items-center gap-1.5">
                  <span className="w-32 truncate font-mono">{name}</span>
                  <RefEditor value={ref} params={params} data={data} onChange={(v) => set({ inputs: { ...rule.inputs, [name]: v as ValueRef } })} />
                  <button type="button" onClick={() => set({ inputs: Object.fromEntries(Object.entries(rule.inputs ?? {}).filter(([k]) => k !== name)) })} className={buttonClass.ghost} aria-label="Remove field">
                    <Icon name="x" className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <input
                placeholder="Struct field name, then Enter"
                onKeyDown={(e) => {
                  const name = e.currentTarget.value.trim();
                  if (e.key !== "Enter" || !name) return;
                  e.preventDefault();
                  set({ inputs: { ...rule.inputs, [name]: { kind: "parameter", parameter: params.find((p) => p.id === name)?.id ?? params[0]?.id ?? "" } as ValueRef } });
                  e.currentTarget.value = "";
                }}
                className={`${small} w-56`}
              />
            </div>
          )}
          {!rule.batched && fn?.inputs.map((i) => (
            <div key={i.name} className="flex items-center gap-1.5">
              <span className="w-32 truncate font-mono">
                {i.name}
                {i.required && "*"}
              </span>
              <span className="w-28 truncate text-muted">{i.type}</span>
              <RefEditor value={rule.inputs?.[i.name]} params={params} data={data} onChange={(v) => set({ inputs: { ...rule.inputs, [i.name]: v as ValueRef } })} />
            </div>
          ))}
        </div>
      )}
      {rule.kind === "notification" && (
        <div className="space-y-1.5 text-xs">
          <FnRefEditor
            label="Recipients from a function"
            hint="returns Principals (users and groups); added to any recipients below"
            value={rule.recipients_function ?? null}
            output={(o) => o.includes("principal") || o.startsWith("array<string")}
            params={params}
            data={data}
            onChange={(v) => set({ recipients_function: v })}
          />
          {(rule.recipients ?? []).map((rc, i) => {
            const setR = (x: typeof rc) => set({ recipients: (rule.recipients ?? []).map((y, j) => (j === i ? x : y)) });
            return (
              <div key={i} className="flex flex-wrap items-center gap-1">
                <select value={rc.kind} onChange={(e) => setR({ kind: e.target.value as "static" })} className={small}>
                  <option value="static">Users / groups</option>
                  <option value="parameter">From a parameter</option>
                  <option value="object_property">Object parameter property</option>
                  <option value="current_user">Current user</option>
                </select>
                {rc.kind === "static" && (
                  <>
                    <input value={(rc.users ?? []).join(", ")} onChange={(e) => setR({ ...rc, users: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="user IDs" className={`${small} w-36`} />
                    <input value={(rc.groups ?? []).join(", ")} onChange={(e) => setR({ ...rc, groups: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="group IDs" className={`${small} w-36`} />
                  </>
                )}
                {(rc.kind === "parameter" || rc.kind === "object_property") && (
                  <RefEditor
                    value={rc.kind === "parameter" ? { kind: "parameter", parameter: rc.parameter ?? "" } : { kind: "object_property", parameter: rc.parameter ?? "", property: rc.property ?? "" }}
                    params={params}
                    data={data}
                    allow={[rc.kind]}
                    onChange={(v) => v && setR({ ...rc, parameter: (v as { parameter: string }).parameter, property: (v as { property?: string }).property })}
                  />
                )}
                <button type="button" onClick={() => set({ recipients: (rule.recipients ?? []).filter((_, j) => j !== i) })} className="text-muted hover:text-bad">
                  <Icon name="x" className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          <button type="button" onClick={() => set({ recipients: [...(rule.recipients ?? []), { kind: "static", users: [] }] })} className={buttonClass.ghost}>
            <Icon name="plus" className="h-3 w-3" /> Recipients
          </button>
          <FnRefEditor
            label="Content from a function"
            hint="returns a Notification (heading, content, links); replaces the subject and body below"
            value={rule.content_function ?? null}
            output={(o) => o === "notification"}
            params={params}
            data={data}
            onChange={(v) => set({ content_function: v })}
          />
          <input value={rule.subject ?? ""} onChange={(e) => set({ subject: e.target.value })} placeholder="Subject — {{{ticket}}}, {{{ticket.status}}}, {{{currentUser}}}, {{{recipient}}}" maxLength={250} className={`${inputClass} text-xs`} />
          <textarea rows={3} value={rule.body ?? ""} onChange={(e) => set({ body: e.target.value })} placeholder="Body (at most 1,000 characters)" maxLength={1000} className={`${inputClass} text-xs`} />
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted">Link</span>
            <select value={rule.link?.kind ?? ""} onChange={(e) => set({ link: e.target.value ? { kind: e.target.value as "url" } : null })} className={small}>
              <option value="">None</option>
              <option value="object_param">Object View of a parameter</option>
              <option value="new_object">Newly created object</option>
              <option value="url">URL</option>
            </select>
            {rule.link?.kind === "object_param" && (
              <select value={rule.link.parameter ?? ""} onChange={(e) => set({ link: { ...rule.link!, parameter: e.target.value } })} className={small}>
                <option value="">Parameter…</option>
                {objParams.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name || p.id}
                  </option>
                ))}
              </select>
            )}
            {rule.link?.kind === "url" && <input value={rule.link.url ?? ""} onChange={(e) => set({ link: { ...rule.link!, url: e.target.value } })} placeholder="/workshop/…" className={`${small} w-48`} />}
            {rule.link && <input value={rule.link.label ?? ""} onChange={(e) => set({ link: { ...rule.link!, label: e.target.value } })} placeholder="Button text" className={`${small} w-28`} />}
          </div>
          <textarea rows={2} value={rule.email_html ?? ""} onChange={(e) => set({ email_html: e.target.value || undefined })} placeholder="Custom HTML for email (optional)" className={`${inputClass} font-mono text-xs`} />
        </div>
      )}
      {rule.kind === "webhook" && (
        <div className="space-y-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <select value={rule.mode ?? "side_effect"} onChange={(e) => set({ mode: e.target.value as "writeback" })} className={small}>
              <option value="side_effect">Side effect (after the edits; failures not shown)</option>
              <option value="writeback">Writeback (before the edits; a failure stops the action)</option>
            </select>
            <select value={rule.webhook_id ?? ""} onChange={(e) => set({ webhook_id: e.target.value, inputs: {} })} className={small}>
              <option value="">Webhook…</option>
              {data.webhooks.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          {hook?.inputs.map((i) => {
            const name = i.name ?? i.id ?? "";
            return (
              <div key={name} className="flex items-center gap-1.5">
                <span className="w-32 truncate font-mono">{name}</span>
                <RefEditor value={rule.inputs?.[name]} params={params} data={data} onChange={(v) => set({ inputs: { ...rule.inputs, [name]: v as ValueRef } })} />
              </div>
            );
          })}
        </div>
      )}
      {rule.kind === "apply_scenario" && (
        <div className="space-y-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted">Scenario parameter</span>
            <select value={rule.scenario_param ?? ""} onChange={(e) => set({ scenario_param: e.target.value })} className={small}>
              <option value="">String parameter…</option>
              {params
                .filter((p) => p.type === "string")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name || p.id}
                  </option>
                ))}
            </select>
          </div>
          <div className="text-muted">Object types and link types the scenario may change</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {data.types.map((x) => (
              <label key={x.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={(rule.object_type_ids ?? []).includes(x.id)}
                  onChange={(e) => set({ object_type_ids: e.target.checked ? [...(rule.object_type_ids ?? []), x.id] : (rule.object_type_ids ?? []).filter((i) => i !== x.id) })}
                />
                {x.display_name}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {data.links
              .filter((l) => l.kind === "join_table")
              .map((l) => (
                <label key={l.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={(rule.link_type_ids ?? []).includes(l.id)}
                    onChange={(e) => set({ link_type_ids: e.target.checked ? [...(rule.link_type_ids ?? []), l.id] : (rule.link_type_ids ?? []).filter((i) => i !== l.id) })}
                  />
                  {l.display_name}
                </label>
              ))}
          </div>
        </div>
      )}
      {rule.kind === "schedule" && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <input value={rule.pipeline_id ?? ""} onChange={(e) => set({ pipeline_id: e.target.value })} placeholder="Pipeline ID" className={`${small} w-40`} />
          <input value={rule.schedule_id ?? ""} onChange={(e) => set({ schedule_id: e.target.value })} placeholder="Schedule ID" className={`${small} w-40`} />
          <span className="text-muted">The run ID is available to rules as “Schedule run ID”.</span>
        </div>
      )}
    </div>
  );
}

/** The form's sections: title, description, one or two columns, collapsible, hidden, and their parameters. */
export function SectionsEditor({ sections, params, onChange }: { sections: Section[]; params: ActionParam[]; onChange: (s: Section[]) => void }) {
  const used = new Set(sections.flatMap((s) => s.parameters));
  return (
    <div className="space-y-3">
      {sections.map((s, i) => {
        const setS = (c: Partial<Section>) => onChange(sections.map((x, j) => (j === i ? { ...x, ...c } : x)));
        return (
          <div key={s.id} className="space-y-2 rounded-lg border border-line-2 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <input value={s.title} onChange={(e) => setS({ title: e.target.value })} placeholder="Section title" className={`${inputClass} max-w-xs`} />
              <select value={s.columns} onChange={(e) => setS({ columns: Number(e.target.value) as 1 | 2 })} className={small}>
                <option value={1}>One column</option>
                <option value={2}>Two columns</option>
              </select>
              {(["collapsible", "collapsed", "hidden"] as const).map((k) => (
                <label key={k} className="flex items-center gap-1 text-xs text-soft">
                  <input type="checkbox" checked={!!s[k]} onChange={(e) => setS({ [k]: e.target.checked })} /> {k}
                </label>
              ))}
              <button type="button" onClick={() => onChange(sections.filter((_, j) => j !== i))} className="ml-auto text-muted hover:text-bad">
                <Icon name="trash" className="h-3.5 w-3.5" />
              </button>
            </div>
            <input value={s.description ?? ""} onChange={(e) => setS({ description: e.target.value })} placeholder="Description" className={`${inputClass} text-xs`} />
            <div className="flex flex-wrap gap-1.5">
              {params.map((p) => {
                const on = s.parameters.includes(p.id);
                const elsewhere = !on && used.has(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={elsewhere}
                    onClick={() => setS({ parameters: on ? s.parameters.filter((x) => x !== p.id) : [...s.parameters, p.id] })}
                    className={`rounded-full px-2 py-0.5 text-xs ring-1 disabled:opacity-40 ${on ? "bg-ocean/15 text-ocean ring-ocean/40" : "text-muted ring-line-2"}`}
                  >
                    {p.display_name || p.id}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <button type="button" onClick={() => onChange([...sections, { id: `s${Date.now().toString(36)}`, title: "New section", columns: 1, parameters: [] }])} className={buttonClass.secondary}>
        <Icon name="plus" className="h-3.5 w-3.5" /> Add section
      </button>
    </div>
  );
}

export const blankRule = (kind: string, objectTypeId: string | null): Rule =>
  kind === "notification"
    ? { kind, recipients: [{ kind: "current_user" }], subject: "", body: "" }
    : kind === "webhook"
      ? { kind, mode: "side_effect", inputs: {} }
      : kind.includes("interface")
        ? { kind, properties: {} }
        : kind === "function"
          ? { kind, inputs: {} }
          : { kind, object_type_id: objectTypeId ?? undefined, properties: {} };

/** A function reference for a rule (content or recipients of a notification): function, version and inputs. */
function FnRefEditor({
  label,
  hint,
  value,
  output,
  params,
  data,
  onChange,
}: {
  label: string;
  hint: string;
  value: FnRef | null;
  output: (o: string) => boolean;
  params: ActionParam[];
  data: EditorData;
  onChange: (v: FnRef | null) => void;
}) {
  const fn = value ? data.functions.find((f) => f.id === value.function_id) : undefined;
  return (
    <div className="space-y-1 rounded-md border border-line-2 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted">{label}</span>
        <select value={value?.function_id ?? ""} onChange={(e) => onChange(e.target.value ? { function_id: e.target.value, inputs: {} } : null)} className={small}>
          <option value="">None</option>
          {data.functions
            .filter((f) => output(f.output))
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({f.version})
              </option>
            ))}
        </select>
        {value && <input value={value.version ?? ""} onChange={(e) => onChange({ ...value, version: e.target.value || undefined })} placeholder="version or ^range" className={`${small} w-28`} />}
        <span className="text-[11px] text-muted">{hint}</span>
      </div>
      {fn?.inputs.map((i) => (
        <div key={i.name} className="flex items-center gap-1.5">
          <span className="w-32 truncate font-mono">
            {i.name}
            {i.required && "*"}
          </span>
          <span className="w-28 truncate text-muted">{i.type}</span>
          <RefEditor value={value?.inputs?.[i.name]} params={params} data={data} onChange={(v) => value && onChange({ ...value, inputs: { ...value.inputs, [i.name]: v as ValueRef } })} />
        </div>
      ))}
    </div>
  );
}
