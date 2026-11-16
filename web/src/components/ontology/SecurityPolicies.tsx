"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Card, ErrorBox } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { auth } from "@/lib/auth";
import { request, type ObjectType } from "@/lib/ontology";

/** Granular policy conditions (api/ontology_security.py). */
type Side = { kind: string; property?: string; attribute?: string; value?: unknown };
type Node = { kind: "and" | "or"; children: Node[] } | { kind: "condition"; left: Side; op: string; right?: Side };
export type Policy = { granular?: Node | null; markings?: string[] };
type PropertyPolicy = Policy & { id?: string; name: string; properties: string[] };
type Security = { object_policy: Policy | null; property_policies: PropertyPolicy[] };
type TestResult = { object_visible: boolean; properties: { api_name: string; display_name: string; visible: boolean; policy: string | null }[] };

export const security = {
  get: (id: string) => request<Security>(`/object-types/${id}/security`),
  save: (id: string, s: Security) => request<Security>(`/object-types/${id}/security`, { method: "PUT", json: s }),
  test: (id: string, body: Record<string, unknown>) => request<TestResult>(`/object-types/${id}/security/test`, { method: "POST", json: body }),
};

const LEFT: [string, string][] = [
  ["user_id", "User ID"],
  ["user_groups", "User's groups"],
  ["user_organization", "User's organization"],
  ["user_markings", "User's markings"],
  ["user_attribute", "User attribute"],
  ["property", "Property"],
];
const OPS: [string, string][] = [
  ["equals", "equals"],
  ["intersects", "has any of"],
  ["contains_all", "has all of"],
  ["is_empty", "is empty"],
  ["is_not_empty", "is not empty"],
];
const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

type Named = { id: string; name: string };

/** IDs chosen by name (markings, groups): chips to remove, a list to add from; an ID outside the list can still be typed. */
function IdPicker({ value, options, onChange, label }: { value: string[]; options: Named[]; onChange: (v: string[]) => void; label: string }) {
  const left = options.filter((o) => !value.includes(o.id));
  return (
    <span className="flex flex-1 flex-wrap items-center gap-1" data-id-picker={label}>
      {value.map((id) => (
        <span key={id} className="inline-flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5" title={id}>
          {options.find((o) => o.id === id)?.name ?? id}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== id))} className="text-muted hover:text-bad" aria-label="Remove">
            ×
          </button>
        </span>
      ))}
      {left.length > 0 && (
        <select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} className={fieldClass} aria-label={`Add ${label}`}>
          <option value="">Add {label}…</option>
          {left.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}
      <input
        placeholder="or an ID"
        onKeyDown={(e) => {
          const v = e.currentTarget.value.trim();
          if (e.key !== "Enter" || !v) return;
          e.preventDefault();
          if (!value.includes(v)) onChange([...value, v]);
          e.currentTarget.value = "";
        }}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && !value.includes(v)) onChange([...value, v]);
          e.target.value = "";
        }}
        className={`${fieldClass} w-24`}
        aria-label={`${label} ID`}
      />
    </span>
  );
}

/** A flat policy (all / any of conditions) is edited with the builder; nested ones as JSON. */
function flat(node: Node | null | undefined): node is { kind: "and" | "or"; children: Node[] } {
  return !!node && node.kind !== "condition" && node.children.every((c) => c.kind === "condition");
}

export function PolicyEditor({
  policy,
  props,
  onChange,
  noMarkings = false,
}: {
  policy: Policy;
  props: Pick<ObjectType["properties"][number], "api_name" | "display_name">[];
  onChange: (p: Policy) => void;
  /** restricted views: the policy alone (their markings come from the backing dataset) */
  noMarkings?: boolean;
}) {
  const g = policy.granular;
  const [json, setJson] = useState(!!g && !flat(g));
  const [text, setText] = useState(() => JSON.stringify(g ?? null, null, 1));
  const [jsonError, setJsonError] = useState<string | null>(null);
  // markings and groups are picked by name (the policy stores their IDs)
  const [markings, setMarkings] = useState<Named[]>([]);
  const [groups, setGroups] = useState<Named[]>([]);
  useEffect(() => {
    auth.markings().then(setMarkings, () => {});
    auth.groups().then(setGroups, () => {});
  }, []);
  // "Any condition" chosen before the first condition exists is kept (an empty policy stores nothing)
  const [emptyKind, setEmptyKind] = useState<"and" | "or">(flat(g) ? g.kind : "and");
  const group = flat(g) && g.children.length ? g : { kind: emptyKind, children: g && g.kind === "condition" ? [g] : [] };
  const setGroup = (kind: "and" | "or", children: Node[]) => onChange({ ...policy, granular: children.length ? { kind, children } : null });
  return (
    <div className="space-y-2 text-xs">
      <div className={noMarkings ? "hidden" : "flex items-center gap-2"}>
        <span className="text-muted">Markings every viewer needs</span>
        <IdPicker label="marking" value={policy.markings ?? []} options={markings} onChange={(v) => onChange({ ...policy, markings: v })} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted">Granular policy</span>
        {!json && (
          <select value={group.kind} onChange={(e) => (setEmptyKind(e.target.value as "and" | "or"), setGroup(e.target.value as "and" | "or", group.children))} className={fieldClass} aria-label="Combine">
            <option value="and">All conditions</option>
            <option value="or">Any condition</option>
          </select>
        )}
        <button type="button" onClick={() => setJson(!json)} className={`${buttonClass.ghost} ml-auto`}>
          {json ? "Builder" : "JSON"}
        </button>
      </div>
      {json ? (
        <>
          <textarea
            value={text}
            rows={8}
            onChange={(e) => {
              setText(e.target.value);
              try {
                onChange({ ...policy, granular: JSON.parse(e.target.value) as Node | null });
                setJsonError(null);
              } catch (err) {
                setJsonError((err as Error).message);
              }
            }}
            className={`${inputClass} font-mono text-[11px]`}
          />
          {jsonError && <div className="text-bad">{jsonError}</div>}
        </>
      ) : (
        <div className="space-y-1.5">
          {group.children.map((c, i) => {
            if (c.kind !== "condition") return null;
            const set = (n: Partial<typeof c>) => setGroup(group.kind, group.children.map((x, j) => (j === i ? { ...c, ...n } : x)));
            const unary = c.op === "is_empty" || c.op === "is_not_empty";
            return (
              <div key={i} className="flex flex-wrap items-center gap-1.5">
                <select value={c.left.kind} onChange={(e) => set({ left: { kind: e.target.value, property: e.target.value === "property" ? props[0]?.api_name : undefined } })} className={fieldClass}>
                  {LEFT.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
                {c.left.kind === "property" && (
                  <select value={c.left.property ?? ""} onChange={(e) => set({ left: { kind: "property", property: e.target.value } })} className={fieldClass}>
                    {props.map((p) => (
                      <option key={p.api_name} value={p.api_name}>
                        {p.display_name}
                      </option>
                    ))}
                  </select>
                )}
                {c.left.kind === "user_attribute" && <input value={c.left.attribute ?? ""} onChange={(e) => set({ left: { kind: "user_attribute", attribute: e.target.value } })} placeholder="attribute" className={`${fieldClass} w-28`} />}
                {/* is empty / is not empty compare nothing: they keep no right side */}
                <select
                  value={c.op}
                  onChange={(e) => set(e.target.value === "is_empty" || e.target.value === "is_not_empty" ? { op: e.target.value, right: undefined } : { op: e.target.value, right: c.right ?? { kind: "static", value: [] } })}
                  className={fieldClass}
                >
                  {OPS.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
                {!unary && (
                  <>
                    <select value={c.right?.kind ?? "static"} onChange={(e) => set({ right: e.target.value === "property" ? { kind: "property", property: props[0]?.api_name } : { kind: "static", value: [] } })} className={fieldClass}>
                      <option value="property">property</option>
                      <option value="static">values</option>
                    </select>
                    {c.right?.kind === "property" ? (
                      <select value={c.right.property ?? ""} onChange={(e) => set({ right: { kind: "property", property: e.target.value } })} className={fieldClass}>
                        {props.map((p) => (
                          <option key={p.api_name} value={p.api_name}>
                            {p.display_name}
                          </option>
                        ))}
                      </select>
                    ) : c.left.kind === "user_groups" || c.left.kind === "user_markings" ? (
                      <IdPicker
                        label={c.left.kind === "user_groups" ? "group" : "marking"}
                        value={Array.isArray(c.right?.value) ? (c.right?.value as string[]) : c.right?.value ? [String(c.right.value)] : []}
                        options={c.left.kind === "user_groups" ? groups : markings}
                        onChange={(v) => set({ right: { kind: "static", value: v } })}
                      />
                    ) : (
                      <input
                        defaultValue={Array.isArray(c.right?.value) ? (c.right?.value as string[]).join(", ") : String(c.right?.value ?? "")}
                        onBlur={(e) => set({ right: { kind: "static", value: list(e.target.value) } })}
                        placeholder="values, comma separated"
                        className={`${fieldClass} w-48`}
                      />
                    )}
                  </>
                )}
                <button type="button" onClick={() => setGroup(group.kind, group.children.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Remove condition">
                  <Icon name="x" className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setGroup(group.kind, [...group.children, { kind: "condition", left: { kind: "user_groups" }, op: "intersects", right: { kind: "static", value: [] } }])}
            className={buttonClass.ghost}
          >
            <Icon name="plus" className="h-3.5 w-3.5" /> Add condition
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The Security tab of an object type: the object security policy (row-level), property security policies
 * (column-level) and a tester that shows what a user would see of an object under the unsaved policies.
 */
export function SecurityTab({ t }: { t: ObjectType }) {
  const [sec, setSec] = useState<Security | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testUser, setTestUser] = useState({ id: "", groups: "", markings: "", organization: "", attributes: "" });
  const [testPk, setTestPk] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const props = t.properties;

  useEffect(() => {
    security.get(t.id).then(setSec, (e: Error) => setError(e.message));
  }, [t.id]);
  if (!sec) return <ErrorBox message={error} />;

  const save = async () => {
    try {
      setSec(await security.save(t.id, sec));
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const test = async () => {
    try {
      const attrs = Object.fromEntries(
        list(testUser.attributes)
          .map((kv) => kv.split("="))
          .filter((kv) => kv.length === 2)
          .map(([k, v]) => [k.trim(), v.trim()]),
      );
      setResult(
        await security.test(t.id, {
          user: { id: testUser.id || "test-user", groups: list(testUser.groups), markings: list(testUser.markings), organization_id: testUser.organization || null, attributes: attrs },
          primary_key: testPk || null,
          security: sec,
        }),
      );
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        Object security policies filter which objects a user can read (row-level security); property security policies hide property values (column-level), together
        cell-level security. Policies apply when objects are read, not to data downstream. Only owners of the object type can change them.
      </p>
      <DatasourceMarkings typeId={t.id} />
      <Card
        title="Object security policy"
        action={
          sec.object_policy ? (
            <button type="button" onClick={() => setSec({ object_policy: null, property_policies: [] })} className={buttonClass.ghost}>
              Remove
            </button>
          ) : (
            <button type="button" onClick={() => setSec({ ...sec, object_policy: { granular: null, markings: [] } })} className={buttonClass.secondary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Create
            </button>
          )
        }
      >
        <div className="p-4">
          {sec.object_policy ? (
            <PolicyEditor policy={sec.object_policy} props={props} onChange={(p) => setSec({ ...sec, object_policy: p })} />
          ) : (
            <div className="text-xs text-muted">
              No policy: everyone who can view {t.display_name} sees every object. Create one (it may stay without conditions) to add property security policies.
            </div>
          )}
        </div>
      </Card>
      {sec.object_policy && (
        <Card
          title="Property security policies"
          count={sec.property_policies.length}
          action={
            <button type="button" onClick={() => setSec({ ...sec, property_policies: [...sec.property_policies, { name: `Policy ${sec.property_policies.length + 1}`, properties: [], markings: [] }] })} className={buttonClass.secondary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Add
            </button>
          }
        >
          <div className="divide-y divide-line">
            {sec.property_policies.map((pp, i) => {
              const set = (c: Partial<PropertyPolicy>) => setSec({ ...sec, property_policies: sec.property_policies.map((x, j) => (j === i ? { ...x, ...c } : x)) });
              const taken = new Set(sec.property_policies.filter((_, j) => j !== i).flatMap((x) => x.properties));
              return (
                <div key={i} className="space-y-2 p-4 text-xs">
                  <div className="flex items-center gap-2">
                    <input value={pp.name} onChange={(e) => set({ name: e.target.value })} className={`${fieldClass} w-56 font-medium`} />
                    <button type="button" onClick={() => setSec({ ...sec, property_policies: sec.property_policies.filter((_, j) => j !== i) })} className={`${buttonClass.ghost} ml-auto`}>
                      Remove
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {props
                      .filter((p) => p.api_name !== t.primary_key && !taken.has(p.api_name))
                      .map((p) => (
                        <label key={p.api_name} className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={pp.properties.includes(p.api_name)}
                            onChange={(e) => set({ properties: e.target.checked ? [...pp.properties, p.api_name] : pp.properties.filter((x) => x !== p.api_name) })}
                          />
                          {p.display_name}
                        </label>
                      ))}
                  </div>
                  <PolicyEditor policy={pp} props={props} onChange={(p) => set(p)} />
                </div>
              );
            })}
            {sec.property_policies.length === 0 && <div className="p-4 text-xs text-muted">Properties outside a property policy follow the object policy only.</div>}
          </div>
        </Card>
      )}
      <ErrorBox message={error} />
      <div className="flex items-center gap-2">
        <button type="button" onClick={save} className={buttonClass.primary}>
          <Icon name="save" className="h-3.5 w-3.5" /> Save policies
        </button>
        {saved && <span className="text-xs text-ok">Saved</span>}
      </div>
      <Card title="Test security policies">
        <div className="grid gap-4 p-4 text-xs md:grid-cols-[280px_1fr]">
          <div className="space-y-2">
            <input value={testUser.id} onChange={(e) => setTestUser({ ...testUser, id: e.target.value })} placeholder="User ID" className={inputClass} />
            <input value={testUser.groups} onChange={(e) => setTestUser({ ...testUser, groups: e.target.value })} placeholder="Group IDs, comma separated" className={inputClass} />
            <input value={testUser.markings} onChange={(e) => setTestUser({ ...testUser, markings: e.target.value })} placeholder="Marking IDs, comma separated" className={inputClass} />
            <input value={testUser.organization} onChange={(e) => setTestUser({ ...testUser, organization: e.target.value })} placeholder="Organization ID" className={inputClass} />
            <input value={testUser.attributes} onChange={(e) => setTestUser({ ...testUser, attributes: e.target.value })} placeholder="Attributes: key=value, …" className={inputClass} />
            <input value={testPk} onChange={(e) => setTestPk(e.target.value)} placeholder={`${t.display_name} primary key`} className={inputClass} />
            <button type="button" onClick={test} className={buttonClass.secondary}>
              Test unsaved policies
            </button>
          </div>
          <div>
            {result ? (
              <>
                <div className={`mb-2 rounded-md px-3 py-2 ${result.object_visible ? "bg-ok/10 text-ok" : "bg-bad/10 text-bad"}`}>
                  {result.object_visible ? "The user can see this object." : "The object security policy hides this object from the user."}
                </div>
                <div className="divide-y divide-line rounded-md border border-line">
                  {result.properties.map((p) => (
                    <div key={p.api_name} className="flex items-center gap-2 px-3 py-1.5">
                      <Icon name={p.visible ? "eye" : "x"} className={`h-3.5 w-3.5 ${p.visible ? "text-ok" : "text-bad"}`} />
                      <span className="flex-1">{p.display_name}</span>
                      {p.policy && <span className="text-muted">{p.policy}</span>}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="text-muted">Pick a user and an object to see which properties they could view.</div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

type MarkingRef = { id: string; name: string };

/** Markings the object type inherits from its datasources; owners holding a marking can stop (or restart) inheriting it. */
function DatasourceMarkings({ typeId }: { typeId: string }) {
  const [d, setD] = useState<{ from_datasources: MarkingRef[]; stop_inheriting: MarkingRef[]; inherited: MarkingRef[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    request<typeof d>(`/object-types/${typeId}/datasource-markings`).then(setD, (e: Error) => setError(e.message));
  }, [typeId]);
  if (!d || (!d.from_datasources.length && !d.stop_inheriting.length)) return error ? <ErrorBox message={error} /> : null;
  const stopped = new Set(d.stop_inheriting.map((m) => m.id));
  const put = (ids: string[]) =>
    request<typeof d>(`/object-types/${typeId}/datasource-markings`, { method: "PUT", json: { stop_inheriting: ids } }).then((x) => (setD(x), setError(null)), (e: Error) => setError(e.message));
  return (
    <Card title="Datasource markings">
      <div className="space-y-2 p-4 text-xs">
        <p className="text-muted">The object type inherits its datasources&apos; markings: only users holding them see it. Stop inheriting a marking when an object security policy protects the objects instead (you need to hold the marking).</p>
        {[...d.from_datasources, ...d.stop_inheriting.filter((m) => !d.from_datasources.some((x) => x.id === m.id))].map((m) => (
          <div key={m.id} className="flex items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 ${stopped.has(m.id) ? "bg-panel-2 text-muted line-through" : "bg-warn/15 text-warn"}`}>{m.name}</span>
            <span className="flex-1 text-muted">{stopped.has(m.id) ? "not inherited" : "inherited"}</span>
            <button type="button" onClick={() => put(stopped.has(m.id) ? [...stopped].filter((x) => x !== m.id) : [...stopped, m.id])} className={buttonClass.ghost}>
              {stopped.has(m.id) ? "Start inheriting" : "Stop inheriting"}
            </button>
          </div>
        ))}
        <ErrorBox message={error} />
      </div>
    </Card>
  );
}
