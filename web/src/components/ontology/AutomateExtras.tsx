"use client";

/** Automate configuration beyond the basics: function-generated object sets, function-backed threshold logic, effect
 *  execution modes, function-generated notifications and attachments (AutomationForm.tsx renders these). */
import { useEffect, useState } from "react";
import { Field } from "@/components/ontology/parts";
import { fieldClass, inputClass } from "@/components/pipeline/Modal";
import type { FunctionRow } from "@/lib/actions";
import { API_URL } from "@/lib/api";
import type { ObjectType } from "@/lib/ontology";

export type FnSpec = { function_id: string; version?: string; inputs?: Record<string, unknown> };
type Rec = Record<string, unknown>;
const isSet = (t: string) => t.startsWith("object_set:") || t.startsWith("array<object");
const forType = (t: string, w?: ObjectType) => !w || t.endsWith(`:${w.api_name}`) || t.endsWith(`:${w.id}`) || t.endsWith(`:${w.api_name}>`) || t.endsWith(`:${w.id}>`);

/** A published function (filtered by its output), its version range and fixed values for the inputs not wired. */
export function FnSpecFields({ spec, set, published, output, wired = [], label }: { spec: FnSpec; set: (s: FnSpec) => void; published: FunctionRow[]; output: (t: string) => boolean; wired?: string[]; label: string }) {
  const list = published.filter((f) => output(String(f.output ?? "")));
  const f = list.find((x) => x.id === spec.function_id);
  return (
    <div className="space-y-2" data-fn-spec>
      <Field label={label} hint={list.length ? undefined : "No published function returns this; publish one from Code Repositories"}>
        <select value={spec.function_id} onChange={(e) => set({ function_id: e.target.value, inputs: {} })} className={inputClass}>
          <option value="">Select a function…</option>
          {list.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} ({x.version}) → {String(x.output)}
            </option>
          ))}
        </select>
      </Field>
      {f && (
        <>
          <Field label="Version" hint="Exact version or a range such as ^1.0.0; empty uses the latest release">
            <input value={spec.version ?? ""} onChange={(e) => set({ ...spec, version: e.target.value || undefined })} placeholder={`^${f.version.split(".")[0]}.0.0`} className={`${inputClass} font-mono`} />
          </Field>
          {f.inputs
            .filter((i) => !wired.includes(i.name))
            .map((i) => (
              <Field key={i.name} label={`Input ${i.name}${i.required ? " *" : ""}`} hint={`${i.type} · fixed value`}>
                <input
                  value={String(spec.inputs?.[i.name] ?? "")}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const num = /^(integer|long|double|float|number|short)$/.test(i.type) && raw !== "" && !Number.isNaN(Number(raw));
                    set({ ...spec, inputs: { ...spec.inputs, [i.name]: num ? Number(raw) : i.type === "boolean" ? raw === "true" : raw } });
                  }}
                  className={inputClass}
                />
              </Field>
            ))}
        </>
      )}
    </div>
  );
}

const inputsOf = (published: FunctionRow[], id?: string) => published.find((f) => f.id === id)?.inputs ?? [];

/** Where the condition's object set comes from: filters on the object type, or a function returning an ObjectSet. */
export function ObjectSourceBox({ condition, set, published, watched }: { condition: Rec; set: (p: Rec) => void; published: FunctionRow[]; watched?: ObjectType }) {
  const src = (condition.object_source as (FnSpec & { kind?: string }) | undefined) ?? null;
  const fn = src?.kind === "function";
  return (
    <div className="space-y-2 rounded-lg border border-line p-3 text-xs" data-object-source>
      <div className="flex items-center gap-3">
        <span className="text-muted">Object set</span>
        <label className="flex items-center gap-1">
          <input type="radio" checked={!fn} onChange={() => set({ object_source: undefined })} /> Defined by filters
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={fn} onChange={() => set({ object_source: { kind: "function", function_id: "" }, poll_minutes: (condition.poll_minutes as number) ?? 5 })} data-source-function /> Function-generated object set
        </label>
      </div>
      {fn && (
        <>
          <FnSpecFields spec={src as FnSpec} set={(s) => set({ object_source: { kind: "function", ...s } })} published={published} output={(t) => t.startsWith("object_set:") && forType(t, watched)} label="Function returning the object set" />
          <PollMinutes condition={condition} set={set} />
          <p className="text-muted">The filters above narrow the function&apos;s set. The function runs on a schedule; each evaluation is compared with the previous one (the first only records the set).</p>
        </>
      )}
    </div>
  );
}

function PollMinutes({ condition, set }: { condition: Rec; set: (p: Rec) => void }) {
  return (
    <div className="flex items-center gap-2">
      Evaluate every
      <input type="number" min={1} value={(condition.poll_minutes as number) ?? 5} onChange={(e) => set({ poll_minutes: Math.max(1, Number(e.target.value) || 1) })} className={`${fieldClass} w-20 text-xs`} data-poll-minutes />
      minutes
    </div>
  );
}

/** Threshold crossed: Automate-defined (a property test) or function-backed logic (a function returning a boolean). */
export function ThresholdLogicBox({ condition, set, published, watched }: { condition: Rec; set: (p: Rec) => void; published: FunctionRow[]; watched?: ObjectType }) {
  const th = (condition.threshold as Rec | undefined) ?? {};
  const fnSpec = th.function as (FnSpec & { objects_input?: string; only_when_true?: boolean }) | undefined;
  const setFn = (x: Partial<NonNullable<typeof fnSpec>>) => set({ threshold: { ...th, function: { ...(fnSpec ?? { function_id: "" }), ...x } } });
  const setInputs = inputsOf(published, fnSpec?.function_id).filter((i) => isSet(i.type) && forType(i.type, watched));
  return (
    <div className="space-y-2 rounded-lg border border-line p-3 text-xs" data-threshold-logic>
      <div className="flex items-center gap-3">
        <span className="text-muted">Logic</span>
        <label className="flex items-center gap-1">
          <input type="radio" checked={!fnSpec} onChange={() => set({ threshold: { property: "", op: "gt", value: "" } })} /> Automate-defined (a property test)
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={!!fnSpec} onChange={() => set({ threshold: { function: { function_id: "" } }, poll_minutes: (condition.poll_minutes as number) ?? 5 })} data-threshold-function /> Function-backed (returns a boolean)
        </label>
      </div>
      {fnSpec && (
        <>
          <FnSpecFields spec={fnSpec} set={(s) => setFn(s)} published={published} output={(t) => t === "boolean"} wired={fnSpec.objects_input ? [fnSpec.objects_input] : []} label="Function returning a boolean" />
          <Field label="Pass the condition's object set to">
            <select value={fnSpec.objects_input ?? ""} onChange={(e) => setFn({ objects_input: e.target.value || undefined })} className={inputClass}>
              <option value="">Don&apos;t pass it</option>
              {setInputs.map((i) => (
                <option key={i.name} value={i.name}>
                  {i.name} ({i.type})
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!fnSpec.only_when_true} onChange={(e) => setFn({ only_when_true: e.target.checked })} /> Run the effects only when it turns true (else: on every change, in either direction)
          </label>
          <PollMinutes condition={condition} set={set} />
        </>
      )}
    </div>
  );
}

/** How an action / Logic / function effect runs on several objects, and which input receives them. */
export function ExecutionModeBox({ effect, setEffect, watched, published, logicInputs }: {
  effect: Rec; setEffect: (e: Rec) => void; watched?: ObjectType; published: FunctionRow[]; logicInputs?: { name: string; type: string; object_type_id?: string }[];
}) {
  const mode = (effect.execution_mode as string) ?? "per_object";
  const kind = effect.kind as string;
  const inputs =
    kind === "function"
      ? inputsOf(published, effect.function_id as string).filter((i) => isSet(i.type) && forType(i.type, watched))
      : kind === "logic"
        ? (logicInputs ?? []).filter((i) => /object_set|array|list/.test(i.type))
        : [];
  const groupBy = Array.isArray(effect.group_by) ? (effect.group_by as string[]) : effect.group_by ? [String(effect.group_by)] : [];
  return (
    <div className="space-y-2 rounded-lg border border-line p-3 text-xs" data-execution-mode>
      <div className="flex flex-wrap items-center gap-2">
        Execute
        <select value={mode} onChange={(e) => setEffect({ ...effect, execution_mode: e.target.value })} className={`${fieldClass} text-xs`}>
          <option value="per_object">once for each object</option>
          <option value="once">once for all objects</option>
          <option value="per_batch">once for each batch of objects</option>
          <option value="per_group">once for each group of objects</option>
        </select>
        {mode === "per_batch" && (
          <>
            of at most
            <input type="number" min={1} value={(effect.batch_size as number) ?? 100} onChange={(e) => setEffect({ ...effect, batch_size: Math.max(1, Number(e.target.value) || 1) })} className={`${fieldClass} w-20 text-xs`} /> objects
          </>
        )}
        {mode === "per_group" && (
          <select multiple value={groupBy} onChange={(e) => setEffect({ ...effect, group_by: [...e.target.selectedOptions].map((o) => o.value) })} className={`${fieldClass} h-16 text-xs`}>
            {watched?.properties.map((p) => (
              <option key={p.api_name} value={p.api_name}>
                {p.display_name}
              </option>
            ))}
          </select>
        )}
      </div>
      {mode !== "per_object" &&
        (kind === "action" ? (
          <p className="text-muted">Pass the objects to an object set or list parameter with a fixed value of {"{{objects.set}}"} or {"{{objects.primary_keys}}"}.</p>
        ) : (
          <Field label="Pass the objects to">
            <select value={(effect.objects_input as string) ?? ""} onChange={(e) => setEffect({ ...effect, objects_input: e.target.value || undefined })} className={inputClass}>
              <option value="">Choose an object set / list input…</option>
              {inputs.map((i) => (
                <option key={i.name} value={i.name}>
                  {i.name} ({i.type})
                </option>
              ))}
            </select>
          </Field>
        ))}
    </div>
  );
}

type Doc = { id: string; name: string };

/** Notification content (plain, or generated by a function per recipient) and attachments rendered to PDF. */
export function NotificationExtras({ effect, setEffect, published, watched, objects }: { effect: Rec; setEffect: (e: Rec) => void; published: FunctionRow[]; watched?: ObjectType; objects: boolean }) {
  const content = (effect.content as (FnSpec & { kind?: string; recipient_input?: string; objects_input?: string; object_input?: string }) | undefined) ?? null;
  const fn = content?.kind === "function";
  const setC = (x: Rec) => setEffect({ ...effect, content: { ...(content ?? {}), kind: "function", ...x } });
  const ins = inputsOf(published, content?.function_id);
  const atts = (effect.attachments as Rec[] | undefined) ?? [];
  const setAtts = (a: Rec[]) => setEffect({ ...effect, attachments: a.length ? a : undefined });
  const [docs, setDocs] = useState<Doc[]>([]);
  const [analyses, setAnalyses] = useState<Doc[]>([]);
  const [tplInputs, setTplInputs] = useState<Record<string, { name: string; type: string }[]>>({});
  useEffect(() => {
    if (!atts.length) return;
    fetch(`${API_URL}/api/notepad/documents`, { credentials: "include" }).then((r) => (r.ok ? r.json() : []), () => []).then((d: Doc[]) => setDocs(Array.isArray(d) ? d : []));
    fetch(`${API_URL}/api/contour/analyses`, { credentials: "include" }).then((r) => (r.ok ? r.json() : []), () => []).then((d: Doc[]) => setAnalyses(Array.isArray(d) ? d.map((x) => ({ id: (x as Doc & { item_id?: string }).item_id ?? x.id, name: x.name })) : []));
  }, [atts.length]);
  const tplIds = atts.filter((a) => a.kind === "notepad_template" && a.item_id).map((a) => String(a.item_id)).join(",");
  useEffect(() => {
    for (const id of tplIds.split(",").filter(Boolean))
      fetch(`${API_URL}/api/notepad/documents/${id}`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { document?: { template?: { inputs?: { name: string; type: string }[] } } } | null) => setTplInputs((m) => ({ ...m, [id]: d?.document?.template?.inputs ?? [] })), () => {});
  }, [tplIds]);
  return (
    <div className="space-y-2" data-notification-extras>
      <div className="flex items-center gap-3 text-xs">
        <span className="text-muted">Content</span>
        <label className="flex items-center gap-1">
          <input type="radio" checked={!fn} onChange={() => setEffect({ ...effect, content: undefined })} /> Plain (subject and body)
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={fn} onChange={() => setC({ function_id: "" })} data-content-function /> Generated by a function
        </label>
      </div>
      {fn && (
        <div className="space-y-2 rounded-lg border border-line p-3 text-xs">
          <FnSpecFields spec={content as FnSpec} set={(s) => setC(s)} published={published} output={(t) => /notification/i.test(t)} label="Function returning a Notification (None skips it)"
            wired={[content?.recipient_input, content?.objects_input, content?.object_input].filter((x): x is string => !!x)} />
          {ins.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Recipient input (the user it is rendered for)">
                <select value={content?.recipient_input ?? ""} onChange={(e) => setC({ recipient_input: e.target.value || undefined })} className={inputClass}>
                  <option value="">None</option>
                  {ins.filter((i) => /principal|user|string/.test(i.type)).map((i) => (
                    <option key={i.name} value={i.name}>
                      {i.name} ({i.type})
                    </option>
                  ))}
                </select>
              </Field>
              {objects && (
                <Field label="The objects (of the message) to">
                  <select value={content?.objects_input ?? ""} onChange={(e) => setC({ objects_input: e.target.value || undefined })} className={inputClass}>
                    <option value="">None</option>
                    {ins.filter((i) => isSet(i.type) && forType(i.type, watched)).map((i) => (
                      <option key={i.name} value={i.name}>
                        {i.name} ({i.type})
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          )}
        </div>
      )}
      <div className="space-y-1 text-xs" data-attachments>
        <div className="text-muted">Attachments (rendered to PDF for the email; inline: an image in the email body)</div>
        {atts.map((a, i) => {
          const put = (x: Rec) => setAtts(atts.map((y, j) => (j === i ? { ...y, ...x } : y)));
          const list = a.kind === "contour" ? analyses : docs;
          const ti = tplInputs[String(a.item_id ?? "")] ?? [];
          return (
            <div key={i} className="space-y-1 rounded border border-line-2 p-2">
              <div className="flex flex-wrap items-center gap-1">
                <select value={String(a.kind)} onChange={(e) => put({ kind: e.target.value, item_id: "", inputs: undefined })} className={`${fieldClass} text-xs`}>
                  <option value="notepad">Notepad document</option>
                  <option value="notepad_template">Notepad template</option>
                  <option value="contour">Contour analysis</option>
                </select>
                <select value={String(a.item_id ?? "")} onChange={(e) => put({ item_id: e.target.value })} className={`${fieldClass} min-w-0 flex-1 text-xs`}>
                  <option value="">Choose…</option>
                  {list.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <input value={String(a.file_name ?? "")} onChange={(e) => put({ file_name: e.target.value })} placeholder="File name" className={`${fieldClass} w-40 text-xs`} />
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={!!a.inline} onChange={(e) => put({ inline: e.target.checked })} /> Inline
                </label>
                <button type="button" onClick={() => setAtts(atts.filter((_, j) => j !== i))} className="px-1 text-muted hover:text-bad">
                  ✕
                </button>
              </div>
              {a.kind === "notepad_template" &&
                ti.map((inp) => (
                  <div key={inp.name} className="flex items-center gap-1 pl-2">
                    <span className="w-28 truncate text-muted">{inp.name}</span>
                    <select
                      value={["{{objects}}", "{{object}}"].includes(String((a.inputs as Rec | undefined)?.[inp.name] ?? "")) ? String((a.inputs as Rec)[inp.name]) : "fixed"}
                      onChange={(e) => put({ inputs: { ...(a.inputs as Rec | undefined), [inp.name]: e.target.value === "fixed" ? "" : e.target.value } })}
                      className={`${fieldClass} text-xs`}
                    >
                      {inp.type === "object_set" && <option value="{{objects}}">The condition&apos;s objects</option>}
                      {inp.type === "object" && <option value="{{object}}">The (first) object</option>}
                      <option value="fixed">Fixed value</option>
                    </select>
                    {!["{{objects}}", "{{object}}"].includes(String((a.inputs as Rec | undefined)?.[inp.name] ?? "")) && (
                      <input value={String((a.inputs as Rec | undefined)?.[inp.name] ?? "")} onChange={(e) => put({ inputs: { ...(a.inputs as Rec | undefined), [inp.name]: e.target.value } })} className={`${fieldClass} flex-1 text-xs`} />
                    )}
                  </div>
                ))}
            </div>
          );
        })}
        <button type="button" onClick={() => setAtts([...atts, { kind: "notepad", item_id: "", file_name: "Attachment" }])} className="text-ocean">
          + Attachment
        </button>
        {atts.length > 0 && !effect.email && <p className="text-warn">Attachments go with the email: turn on “Also send by email”.</p>}
      </div>
    </div>
  );
}
