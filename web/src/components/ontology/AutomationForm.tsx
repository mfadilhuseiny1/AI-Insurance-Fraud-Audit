"use client";

import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { TsConditionEditor } from "@/components/timeseries/TsCondition";
import { functions as fnRegistry, type FunctionRow } from "@/lib/actions";
import { API_URL } from "@/lib/api";
import { auth } from "@/lib/auth";
import {
  conditionType,
  ontology,
  typeLabel,
  type ActionType,
  type Automation,
  type Condition,
  type Effect,
  type Expr,
  type LogicFunction,
  type ObjectType,
  type ConditionDerived,
  type SetFilter,
} from "@/lib/ontology";
import { om, type LinkType } from "@/lib/ontologyModel";
import { ExecutionModeBox, NotificationExtras, ObjectSourceBox, ThresholdLogicBox } from "./AutomateExtras";

type Kind = Condition["kind"];
const CONDITIONS: { kind: Kind; label: string; icon: IconName; hint: string }[] = [
  { kind: "objects_added", label: "Objects added to set", icon: "plus", hint: "An object is created in the set, or an edit brings it into the set" },
  { kind: "objects_removed", label: "Objects removed from set", icon: "minus", hint: "An object is deleted, or an edit takes it out of the set" },
  { kind: "objects_modified", label: "Objects modified in set", icon: "edit", hint: "An object of the set is edited (optionally only some properties)" },
  { kind: "threshold", label: "Threshold crossed", icon: "gauge", hint: "A property's test turns true for an object of the set" },
  { kind: "run_on_all", label: "Run on all objects", icon: "layers", hint: "On a schedule, the effects run on every object of the set" },
  { kind: "schedule", label: "Time", icon: "clock", hint: "Every N minutes, or on cron schedules" },
  { kind: "automation_completed", label: "Automation completed", icon: "split", hint: "Runs after another automation finishes" },
  { kind: "time_series", label: "Time series", icon: "wave", hint: "Time series alerting" },
];
const OPS: [SetFilter["op"], string][] = [
  ["eq", "is"],
  ["neq", "is not"],
  ["gt", ">"],
  ["gte", "≥"],
  ["lt", "<"],
  ["lte", "≤"],
  ["contains", "contains"],
  ["is_empty", "is empty"],
  ["not_empty", "is not empty"],
];
const isObjectKind = (k: Kind) => ["objects_added", "objects_removed", "objects_modified", "threshold", "run_on_all"].includes(k);

/** The condition ("when"), effects ("then") and settings of an automation; creates one, or saves an existing one. */
export function AutomationForm({ automation, initialObjectType, onSaved, onCancel }: { automation?: Automation; initialObjectType?: string; onSaved: (a: Automation) => void; onCancel?: () => void }) {
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [fns, setFns] = useState<LogicFunction[]>([]);
  const [actions, setActions] = useState<ActionType[]>([]);
  const [published, setPublished] = useState<FunctionRow[]>([]);
  const [autos, setAutos] = useState<Automation[]>([]);
  const [people, setPeople] = useState<{ principal: string; name: string }[]>([]);
  const [name, setName] = useState(automation?.name ?? "");
  const [description, setDescription] = useState(automation?.description ?? "");
  const [condition, setCondition] = useState<Condition>(automation?.condition ?? { kind: "objects_added", object_type_id: initialObjectType ?? "" });
  const [effects, setEffects] = useState<Effect[]>(automation?.effects?.length ? automation.effects : automation?.effect ? [automation.effect] : [{ kind: "logic", logic_id: "", apply_edits: true }]);
  const [settings, setSettings] = useState(automation?.settings ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState<string[] | null>(null);

  useEffect(() => {
    Promise.all([ontology.objectTypes(), ontology.logicList(), ontology.actionTypes(), ontology.automations()])
      .then(([t, f, a, au]) => {
        setTypes(t);
        setFns(f);
        setActions(a);
        setAutos(au.filter((x) => x.id !== automation?.id));
        if (!automation && !initialObjectType && t[0]) setCondition((c) => ("object_type_id" in c && !c.object_type_id ? ({ ...c, object_type_id: t[0].id } as Condition) : c));
      })
      .catch((e: Error) => setError(e.message));
    fnRegistry.list().then(setPublished, () => setPublished([]));
    Promise.all([auth.users().catch(() => []), auth.groups().catch(() => [])]).then(([us, gs]) =>
      setPeople([...us.map((u) => ({ principal: `user:${u.id}`, name: u.display_name || u.username })), ...gs.map((g) => ({ principal: `group:${g.id}`, name: `${g.name} (group)` }))]),
    );
  }, [automation, initialObjectType]);

  const watchedId = conditionType(condition);
  const watched = types.find((t) => t.id === watchedId);
  const timed = condition.kind === "schedule" || condition.kind === "run_on_all";
  const cronKey = timed ? JSON.stringify([(condition as { cron?: string[] }).cron, (condition as { timezone?: string }).timezone, (condition as { every_minutes?: number }).every_minutes]) : "";
  useEffect(() => {
    if (!cronKey) return;
    let stale = false;
    const t = setTimeout(() => {
      fetch(`${API_URL}/api/automate/schedule-preview`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ condition }) })
        .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.detail)))))
        .then((r) => !stale && setNext(r.next), (e: Error) => !stale && setNext([`⚠ ${e.message}`]));
    }, 400);
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cronKey]);

  const set = (patch: Record<string, unknown>) => setCondition({ ...condition, ...patch } as Condition);
  const pick = (k: Kind) => {
    const ot = watchedId ?? types[0]?.id ?? "";
    if (k === "time_series") {
      setCondition({ kind: "time_series", mode: "batch", object_type_id: "", alert_object_type_id: "", logic: { cards: [] }, scope: { kind: "all" }, evaluation_minutes: 0 });
      setEffects([{ kind: "none" }]);
      return;
    }
    const keep = "filters" in condition ? { filters: condition.filters, skip_peering_events: condition.skip_peering_events } : {};
    if (k === "schedule") setCondition({ kind: "schedule", every_minutes: 60 });
    else if (k === "automation_completed") setCondition({ kind: "automation_completed", automation_id: autos[0]?.id ?? "", only_success: true });
    else if (k === "threshold") setCondition({ kind: "threshold", object_type_id: ot, threshold: { property: "", op: "gt", value: "" }, ...keep });
    else if (k === "run_on_all") setCondition({ kind: "run_on_all", object_type_id: ot, every_minutes: 1440, ...keep });
    else setCondition({ kind: k, object_type_id: ot, ...keep } as Condition);
    if (effects.length === 1 && effects[0].kind === "none") setEffects([{ kind: "logic", logic_id: fns[0]?.id ?? "", apply_edits: true }]);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (condition.kind === "time_series" && !condition.alert_object_type_id) throw new Error("Pick or create the time series alert object type");
      const fixed = effects.map((e) => fixLogicInput(e));
      const body = { name: name.trim() || defaultName(), description, condition, effects: fixed, effect: fixed[0], settings };
      const saved = automation ? await ontology.saveAutomation(automation.id, body) : await ontology.createAutomation({ ...body, enabled: true });
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const fixLogicInput = (e: Effect): Effect => {
    if (e.kind !== "logic" || !watched) return e;
    const fn = fns.find((f) => f.id === e.logic_id);
    const inputs = fn?.inputs.filter((i) => i.type === "object" && i.object_type_id === watched.id) ?? [];
    return { ...e, object_input: (inputs.find((i) => i.name === e.object_input) ?? inputs[0])?.name };
  };
  const defaultName = () => {
    const c = CONDITIONS.find((x) => x.kind === condition.kind)?.label ?? "Automation";
    return `${c}${watched ? ` · ${watched.display_name}` : ""}`;
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName()} className={inputClass} />
        </Field>
        <Field label="Description (optional)">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </Field>
      </div>

      <section className="rounded-xl border border-line bg-panel-2/40">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-sm font-semibold">
          <span className="rounded bg-sand/15 px-1.5 text-xs text-sand">WHEN</span> Condition
        </div>
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-4 gap-2">
            {CONDITIONS.map((c) => (
              <button key={c.kind} type="button" title={c.hint} disabled={!!automation && (automation.condition.kind === "time_series") !== (c.kind === "time_series")} onClick={() => pick(c.kind)}
                className={`flex items-center gap-2 rounded-lg border p-2 text-left text-xs disabled:opacity-40 ${condition.kind === c.kind ? "border-ocean bg-ocean/10" : "border-line-2 hover:border-ocean/50"}`} data-condition={c.kind}>
                <Icon name={c.icon} className="h-4 w-4 shrink-0 text-ocean" /> {c.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">{CONDITIONS.find((c) => c.kind === condition.kind)?.hint}</p>
          {condition.kind === "time_series" ? (
            <TsConditionEditor condition={condition} onChange={setCondition} types={types} locked={!!automation} onTypesChanged={() => ontology.objectTypes().then(setTypes)} />
          ) : condition.kind === "automation_completed" ? (
            <div className="space-y-2">
              <Field label="After this automation">
                <select value={condition.automation_id} onChange={(e) => set({ automation_id: e.target.value })} className={inputClass}>
                  <option value="">Choose…</option>
                  {autos.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex items-center gap-2 text-xs text-soft">
                <input type="checkbox" checked={condition.only_success !== false} onChange={(e) => set({ only_success: e.target.checked })} /> Only when it succeeded (else: always trigger when it completes)
              </label>
              <label className="flex items-center gap-2 text-xs text-soft">
                <input type="checkbox" checked={!!condition.pass_objects} onChange={(e) => set({ pass_objects: e.target.checked })} /> Pass on the objects it ran on
              </label>
            </div>
          ) : (
            <>
              {isObjectKind(condition.kind) && "object_type_id" in condition && (
                <ObjectSet condition={condition} types={types} set={set} />
              )}
              {isObjectKind(condition.kind) && "object_type_id" in condition && <ObjectSourceBox condition={condition as unknown as Record<string, unknown>} set={set} published={published} watched={watched} />}
              {condition.kind === "threshold" && <ThresholdLogicBox condition={condition as unknown as Record<string, unknown>} set={set} published={published} watched={watched} />}
              {timed && <TimeFields condition={condition as Condition & { every_minutes?: number; cron?: string[]; timezone?: string }} set={set} next={next} />}
              {isObjectKind(condition.kind) && "object_type_id" in condition && <ConditionSettingsBox condition={condition} set={set} />}
            </>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-line bg-panel-2/40">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-sm font-semibold">
          <span className="rounded bg-ocean/15 px-1.5 text-xs text-ocean">THEN</span> Effects
          <span className="text-xs font-normal text-muted">run in order</span>
        </div>
        <div className="space-y-3 p-4">
          {condition.kind === "time_series" && <p className="text-xs text-muted">Optional: effects run on each new alert object. Without one, the automation only writes alerts.</p>}
          {effects.map((e, i) => (
            <div key={i} className="rounded-lg border border-line bg-panel p-3" data-effect={i}>
              <div className="mb-2 flex items-center gap-2 text-xs">
                <span className="font-medium text-soft">Effect {i + 1}</span>
                <button type="button" disabled={i === 0} onClick={() => setEffects(swap(effects, i, i - 1))} className="text-muted disabled:opacity-30" aria-label="Move up">
                  ↑
                </button>
                <button type="button" disabled={i === effects.length - 1} onClick={() => setEffects(swap(effects, i, i + 1))} className="text-muted disabled:opacity-30" aria-label="Move down">
                  ↓
                </button>
                {effects.length > 1 && (
                  <button type="button" onClick={() => setEffects(effects.filter((_, j) => j !== i))} className="ml-auto text-muted hover:text-bad">
                    Remove
                  </button>
                )}
              </div>
              <EffectEditor effect={e} setEffect={(x) => setEffects(effects.map((y, j) => (j === i ? x : y)))} kinds={condition.kind === "time_series" ? ["none", "logic", "action", "function"] : ["logic", "action", "function", "notification", "none"]}
                fns={fns} actions={actions} published={published} watched={watched} objects={isObjectKind(condition.kind) || condition.kind === "time_series"} people={people} />
              {e.kind !== "none" && (
                <div className="mt-3 space-y-2 border-t border-line pt-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted">Retries</span>
                    <input type="number" min={0} max={10} value={e.retries?.max ?? 0} onChange={(x) => setEffects(effects.map((y, j) => (j === i ? { ...y, retries: { max: Number(x.target.value), backoff_seconds: y.retries?.backoff_seconds ?? 5 } } : y)))} className={`${fieldClass} w-16 text-xs`} />
                    <span className="text-muted">backoff (s)</span>
                    <input type="number" min={0} value={e.retries?.backoff_seconds ?? 5} onChange={(x) => setEffects(effects.map((y, j) => (j === i ? { ...y, retries: { max: y.retries?.max ?? 0, backoff_seconds: Number(x.target.value) } } : y)))} className={`${fieldClass} w-16 text-xs`} />
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={!!e.continue_on_failure} onChange={(x) => setEffects(effects.map((y, j) => (j === i ? { ...y, continue_on_failure: x.target.checked } : y)))} /> continue with the next effects if it fails
                    </label>
                  </div>
                  {e.fallback ? (
                    <div className="rounded border border-warn/30 p-2">
                      <div className="mb-1 flex items-center text-warn">
                        Fallback effect (runs when this effect fails; {"{{error.message}}"} holds the error)
                        <button type="button" onClick={() => setEffects(effects.map((y, j) => (j === i ? { ...y, fallback: undefined } : y)))} className="ml-auto text-muted hover:text-bad">
                          Remove
                        </button>
                      </div>
                      <EffectEditor effect={e.fallback} setEffect={(f) => setEffects(effects.map((y, j) => (j === i ? { ...y, fallback: f } : y)))} kinds={["action", "notification"]} fns={fns} actions={actions} published={published} watched={watched}
                        objects={isObjectKind(condition.kind)} people={people} extras={false} />
                    </div>
                  ) : (
                    <button type="button" onClick={() => setEffects(effects.map((y, j) => (j === i ? { ...y, fallback: { kind: "notification", recipients: { principals: [] }, grouping: "once", subject: `Automation failed: {{error.message}}` } } : y)))} className="text-ocean">
                      + Fallback effect
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {condition.kind !== "time_series" && (
            <button type="button" onClick={() => setEffects([...effects, { kind: "notification", recipients: { principals: [] }, grouping: "per_object", subject: "" }])} className="text-sm text-ocean">
              + Add effect
            </button>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-line bg-panel-2/40">
        <div className="border-b border-line px-4 py-2 text-sm font-semibold">Settings</div>
        <div className="grid grid-cols-3 gap-3 p-4 text-xs">
          <Field label="Expires (the automation pauses itself)">
            <input type="datetime-local" value={settings.expires_at ? settings.expires_at.slice(0, 16) : ""} onChange={(e) => setSettings({ ...settings, expires_at: e.target.value ? new Date(e.target.value).toISOString() : null })} className={inputClass} />
          </Field>
          <Field label="Executions">
            <select value={settings.execution ?? "parallel"} onChange={(e) => setSettings({ ...settings, execution: e.target.value as "parallel" | "sequential" })} className={inputClass}>
              <option value="parallel">In parallel</option>
              <option value="sequential">Queued (one at a time)</option>
            </select>
          </Field>
          <label className="col-span-3 flex items-center gap-2 text-soft">
            <input type="checkbox" checked={!!(settings as { auto_mute?: boolean }).auto_mute} onChange={(e) => setSettings({ ...settings, auto_mute: e.target.checked } as typeof settings)} data-auto-mute /> Auto-mute this
            automation: mute it for everyone when every effect failed in at least 80% of the last 30 executions
          </label>
          <Field label="Administrators (only they edit; empty: anyone who can see it)">
            <select multiple value={settings.administrators ?? []} onChange={(e) => setSettings({ ...settings, administrators: [...e.target.selectedOptions].map((o) => o.value) })} className={`${inputClass} h-20`}>
              {people.map((p) => (
                <option key={p.principal} value={p.principal}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="px-4 pb-3 text-[11px] text-muted">Effects run with the permissions of the automation&apos;s owner (the user who created it).</p>
      </section>

      <ErrorBox message={error} />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className={buttonClass.secondary}>
            Cancel
          </button>
        )}
        <button type="button" onClick={submit} disabled={busy} className={buttonClass.primary}>
          <Icon name={automation ? "save" : "bolt"} className="h-3.5 w-3.5" /> {busy ? "Saving…" : automation ? "Save" : "Create automation"}
        </button>
      </div>
    </div>
  );
}

const swap = <T,>(xs: T[], i: number, j: number) => {
  const out = [...xs];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
};

function FilterRow({ f, props, onChange, onRemove }: { f: SetFilter; props: ObjectType["properties"]; onChange: (f: SetFilter) => void; onRemove?: () => void }) {
  return (
    <div className="flex gap-1">
      <select value={f.property} onChange={(e) => onChange({ ...f, property: e.target.value })} className={`${fieldClass} w-48 text-xs`}>
        <option value="">Property…</option>
        {props.map((p) => (
          <option key={p.api_name} value={p.api_name}>
            {p.display_name}
          </option>
        ))}
      </select>
      <select value={f.op} onChange={(e) => onChange({ ...f, op: e.target.value as SetFilter["op"] })} className={`${fieldClass} w-28 text-xs`}>
        {OPS.map(([o, l]) => (
          <option key={o} value={o}>
            {l}
          </option>
        ))}
      </select>
      {f.op !== "is_empty" && f.op !== "not_empty" && <input value={String(f.value ?? "")} onChange={(e) => onChange({ ...f, value: e.target.value })} className={`${fieldClass} flex-1 text-xs`} />}
      {onRemove && (
        <button type="button" onClick={onRemove} className="px-1 text-muted hover:text-bad" aria-label="Remove filter">
          ✕
        </button>
      )}
    </div>
  );
}

function ObjectSet({ condition, types, set }: { condition: Extract<Condition, { object_type_id: string }>; types: ObjectType[]; set: (p: Record<string, unknown>) => void }) {
  const t = types.find((x) => x.id === condition.object_type_id);
  const filters = ("filters" in condition ? condition.filters : undefined) ?? [];
  const derived = ("derived" in condition ? condition.derived : undefined) ?? [];
  // filters can test the derived properties too
  const props = [...(t?.properties ?? []), ...derived.filter((d) => d.api_name).map((d) => ({ api_name: d.api_name, display_name: `${d.api_name} (derived)`, type: "double" }))] as ObjectType["properties"];
  return (
    <div className="space-y-2">
      <Field label="Object set: object type">
        <select value={condition.object_type_id} onChange={(e) => set({ object_type_id: e.target.value, filters: [], properties: [], derived: [] })} className={inputClass}>
          {types.map((x) => (
            <option key={x.id} value={x.id}>
              {x.display_name}
            </option>
          ))}
        </select>
      </Field>
      <div className="space-y-1">
        <div className="text-xs text-muted">Filters (objects of the set match all of them)</div>
        {filters.map((f, i) => (
          <FilterRow key={i} f={f} props={props} onChange={(x) => set({ filters: filters.map((y, j) => (j === i ? x : y)) })} onRemove={() => set({ filters: filters.filter((_, j) => j !== i) })} />
        ))}
        <button type="button" onClick={() => set({ filters: [...filters, { property: "", op: "eq", value: "" }] })} className="text-xs text-ocean">
          + Filter
        </button>
      </div>
      {t && <DerivedEditor typeId={t.id} derived={derived} onChange={(d) => set({ derived: d })} />}
      {condition.kind === "objects_modified" && (
        <Field label="Only when these properties change (empty: any change)">
          <select multiple value={condition.properties ?? []} onChange={(e) => set({ properties: [...e.target.selectedOptions].map((o) => o.value) })} className={`${inputClass} h-24`}>
            {t?.properties.map((p) => (
              <option key={p.api_name} value={p.api_name}>
                {p.display_name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {condition.kind === "threshold" && !(condition.threshold as { function?: unknown })?.function && (
        <div className="space-y-1">
          <div className="text-xs text-muted">Threshold: triggers when this test turns true</div>
          <FilterRow f={condition.threshold} props={t?.properties ?? []} onChange={(x) => set({ threshold: x })} />
        </div>
      )}
    </div>
  );
}

function TimeFields({ condition, set, next }: { condition: { every_minutes?: number; cron?: string[]; timezone?: string }; set: (p: Record<string, unknown>) => void; next: string[] | null }) {
  const cron = condition.cron ?? [];
  const useCron = cron.length > 0;
  return (
    <div className="space-y-2 rounded-lg border border-line p-3 text-xs">
      <div className="flex gap-3">
        <label className="flex items-center gap-1">
          <input type="radio" checked={!useCron} onChange={() => set({ cron: [], every_minutes: condition.every_minutes || 60 })} /> Every N minutes
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={useCron} onChange={() => set({ cron: ["0 8 * * 1-5"], timezone: condition.timezone || "Asia/Jakarta" })} /> Cron schedules
        </label>
      </div>
      {!useCron ? (
        <input type="number" min={1} value={condition.every_minutes ?? 60} onChange={(e) => set({ every_minutes: Math.max(1, Number(e.target.value) || 1) })} className={`${fieldClass} w-32`} />
      ) : (
        <>
          {cron.map((c, i) => (
            <div key={i} className="flex gap-1">
              <input value={c} onChange={(e) => set({ cron: cron.map((x, j) => (j === i ? e.target.value : x)) })} placeholder="minute hour day month weekday" className={`${fieldClass} flex-1 font-mono text-xs`} />
              {cron.length > 1 && (
                <button type="button" onClick={() => set({ cron: cron.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                  ✕
                </button>
              )}
            </div>
          ))}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => set({ cron: [...cron, "0 * * * *"] })} className="text-ocean">
              + Schedule
            </button>
            <span className="text-muted">Time zone</span>
            <input value={condition.timezone ?? ""} onChange={(e) => set({ timezone: e.target.value })} placeholder="Asia/Jakarta" className={`${fieldClass} w-40 text-xs`} />
          </div>
        </>
      )}
      {next && (
        <div className="text-muted" data-next-runs>
          Next: {next.slice(0, 4).map((x) => (x.startsWith("⚠") ? x : new Date(x).toLocaleString())).join(" · ")}
        </div>
      )}
    </div>
  );
}

function ConditionSettingsBox({ condition, set }: { condition: Extract<Condition, { object_type_id: string }>; set: (p: Record<string, unknown>) => void }) {
  const c = condition as Extract<Condition, { object_type_id: string }> & { allow_cycles?: boolean; skip_peering_events?: boolean; max_objects?: number; batch?: { mode: string; every_minutes?: number } };
  return (
    <details className="rounded-lg border border-line p-3 text-xs">
      <summary className="cursor-pointer text-soft">Condition settings</summary>
      <div className="mt-2 space-y-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!c.allow_cycles} onChange={(e) => set({ allow_cycles: e.target.checked })} /> Cycles: let this automation&apos;s own edits trigger it again
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!c.skip_peering_events} onChange={(e) => set({ skip_peering_events: e.target.checked })} /> Skip peering events (edits applied by Peer Manager)
        </label>
        <div className="flex items-center gap-2">
          Dropped objects: at most
          <input type="number" min={0} value={c.max_objects ?? 0} onChange={(e) => set({ max_objects: Number(e.target.value) || 0 })} className={`${fieldClass} w-20 text-xs`} />
          objects per execution (0: no limit)
        </div>
        {condition.kind !== "run_on_all" && (
          <div className="flex items-center gap-2">
            Evaluation
            <select value={c.batch?.mode ?? "live"} onChange={(e) => set({ batch: { mode: e.target.value, every_minutes: c.batch?.every_minutes ?? 60 } })} className={`${fieldClass} text-xs`}>
              <option value="live">Live: run on each event</option>
              <option value="scheduled">Scheduled: collect events, run every…</option>
            </select>
            {c.batch?.mode === "scheduled" && (
              <>
                <input type="number" min={1} value={c.batch.every_minutes ?? 60} onChange={(e) => set({ batch: { mode: "scheduled", every_minutes: Math.max(1, Number(e.target.value) || 1) } })} className={`${fieldClass} w-20 text-xs`} /> minutes
              </>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

function EffectEditor({ effect, setEffect, kinds, fns, actions, published, watched, objects, people, extras = true }: {
  effect: Effect; setEffect: (e: Effect) => void; kinds: Effect["kind"][]; fns: LogicFunction[]; actions: ActionType[]; published: FunctionRow[]; watched?: ObjectType; objects: boolean;
  people: { principal: string; name: string }[];
  /** execution modes, function-generated content and attachments (not for fallbacks) */
  extras?: boolean;
}) {
  const keep = { retries: effect.retries, fallback: effect.fallback, continue_on_failure: effect.continue_on_failure };
  const LABEL: Record<string, [string, IconName]> = { none: ["No effect", "x"], logic: ["Run AIP Logic", "logic"], action: ["Apply action", "edit"], function: ["Run function", "code"], notification: ["Send notification", "bell"] };
  const fn = effect.kind === "logic" ? fns.find((f) => f.id === effect.logic_id) : undefined;
  const objectInputs = fn?.inputs.filter((i) => i.type === "object" && (!watched || i.object_type_id === watched.id)) ?? [];
  const action = effect.kind === "action" ? actions.find((a) => a.id === effect.action_type_id) : undefined;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {kinds.map((k) => (
          <button key={k} type="button"
            onClick={() =>
              setEffect({
                ...keep,
                ...(k === "none"
                  ? { kind: "none" }
                  : k === "function"
                    ? { kind: "function", function_id: published[0]?.id ?? "" }
                    : k === "logic"
                      ? { kind: "logic", logic_id: fns[0]?.id ?? "", apply_edits: true }
                      : k === "notification"
                        ? { kind: "notification", recipients: { principals: [] }, grouping: objects ? "per_object" : "once", subject: "" }
                        : { kind: "action", action_type_id: "", parameters: {} }),
              } as Effect)
            }
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${effect.kind === k ? "border-ocean bg-ocean/10" : "border-line-2"}`}>
            <Icon name={LABEL[k][1]} className="h-3.5 w-3.5 text-ocean" /> {LABEL[k][0]}
          </button>
        ))}
      </div>
      {effect.kind === "function" && <FunctionEffect effect={effect} setEffect={setEffect} published={published} watched={watched} schedule={!objects} />}
      {effect.kind === "logic" && (
        <>
          <Field label="Logic function">
            <select value={effect.logic_id} onChange={(e) => setEffect({ ...effect, logic_id: e.target.value, object_input: undefined })} className={inputClass}>
              <option value="">Select a Logic function…</option>
              {fns.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
          {fn && objects && (
            <Field label="Pass the object to" hint={objectInputs.length ? "Execute once per object" : `The function has no ${watched?.display_name ?? "object"} input`}>
              <select value={effect.object_input ?? objectInputs[0]?.name ?? ""} onChange={(e) => setEffect({ ...effect, object_input: e.target.value })} className={inputClass}>
                {objectInputs.map((i) => (
                  <option key={i.name} value={i.name}>
                    {i.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {fn?.inputs
            .filter((i) => !objects || i.name !== (effect.object_input ?? objectInputs[0]?.name))
            .map((i) => (
              <Field key={i.name} label={`Input ${i.name}`} hint={`${typeLabel(i.type)} · fixed value`}>
                <input value={String(effect.inputs?.[i.name] ?? "")} onChange={(e) => setEffect({ ...effect, inputs: { ...effect.inputs, [i.name]: e.target.value } })} className={inputClass} />
              </Field>
            ))}
          <label className="flex items-center gap-2 text-sm text-soft">
            <input type="checkbox" checked={effect.apply_edits !== false} onChange={(e) => setEffect({ ...effect, apply_edits: e.target.checked })} /> Apply the ontology edits the function makes
          </label>
        </>
      )}
      {effect.kind === "action" && (
        <>
          <Field label="Action">
            <select value={effect.action_type_id} onChange={(e) => setEffect({ ...keep, kind: "action", action_type_id: e.target.value, parameters: {} })} className={inputClass}>
              <option value="">Select an action…</option>
              {actions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name}
                </option>
              ))}
            </select>
          </Field>
          {action?.parameters.map((p) => {
            const cur = effect.parameters[p.id] as Expr | string | undefined;
            const isVar = !!cur && typeof cur === "object" && "var" in cur;
            const fixed = cur !== undefined && !isVar;
            return (
              <Field key={p.id} label={`${p.display_name}${p.required ? " *" : ""}`} hint={typeLabel(p.type)}>
                <div className="flex gap-2">
                  <select value={isVar ? (cur as { var: string }).var : fixed ? "__fixed" : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      const next = { ...effect.parameters };
                      if (!v) delete next[p.id];
                      else next[p.id] = v === "__fixed" ? { value: "" } : { var: v };
                      setEffect({ ...effect, parameters: next });
                    }}
                    className={`${fieldClass} w-60`}>
                    <option value="">—</option>
                    {watched && objects && <option value="object">The {watched.display_name}</option>}
                    {objects &&
                      watched?.properties.map((wp) => (
                        <option key={wp.api_name} value={`object.${wp.api_name}`}>
                          object.{wp.api_name}
                        </option>
                      ))}
                    <option value="error.message">error.message (in a fallback)</option>
                    <option value="__fixed">Fixed value or {"{{template}}"}…</option>
                  </select>
                  {fixed && (
                    <input value={String(typeof cur === "object" && cur && "value" in cur ? (cur.value ?? "") : cur ?? "")}
                      onChange={(e) => setEffect({ ...effect, parameters: { ...effect.parameters, [p.id]: e.target.value.includes("{{") ? (e.target.value as unknown as Expr) : { value: e.target.value } } })}
                      className={`${fieldClass} flex-1`} />
                  )}
                </div>
              </Field>
            );
          })}
        </>
      )}
      {extras && objects && (effect.kind === "action" || effect.kind === "logic" || effect.kind === "function") && (
        <ExecutionModeBox effect={effect as unknown as Record<string, unknown>} setEffect={(x) => setEffect(x as unknown as Effect)} watched={watched} published={published} logicInputs={fn?.inputs} />
      )}
      {effect.kind === "notification" && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Recipients: users and groups">
              <select multiple value={effect.recipients.principals ?? []} onChange={(e) => setEffect({ ...effect, recipients: { ...effect.recipients, principals: [...e.target.selectedOptions].map((o) => o.value) } })} className={`${inputClass} h-24`}>
                {people.map((p) => (
                  <option key={p.principal} value={p.principal}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="…and the user in a property of each object">
              <select value={effect.recipients.property ?? ""} disabled={!objects} onChange={(e) => setEffect({ ...effect, recipients: { ...effect.recipients, property: e.target.value || undefined } })} className={inputClass}>
                <option value="">None</option>
                {watched?.properties.map((p) => (
                  <option key={p.api_name} value={p.api_name}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {objects && (
            <div className="flex items-center gap-2 text-xs">
              Send
              <select value={effect.grouping ?? "per_object"} onChange={(e) => setEffect({ ...effect, grouping: e.target.value as "once" })} className={`${fieldClass} text-xs`}>
                <option value="per_object">once for each object</option>
                <option value="per_group">once for each group of objects</option>
                <option value="once">once for all objects</option>
              </select>
              {effect.grouping === "per_group" && (
                <select value={effect.group_by ?? ""} onChange={(e) => setEffect({ ...effect, group_by: e.target.value })} className={`${fieldClass} text-xs`}>
                  <option value="">grouped by…</option>
                  {watched?.properties.map((p) => (
                    <option key={p.api_name} value={p.api_name}>
                      {p.display_name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          {extras && <NotificationExtras effect={effect as unknown as Record<string, unknown>} setEffect={(x) => setEffect(x as unknown as Effect)} published={published} watched={watched} objects={objects} />}
          <input value={effect.subject} onChange={(e) => setEffect({ ...effect, subject: e.target.value })} placeholder={(effect as { content?: { kind?: string } }).content?.kind === "function" ? "Subject when the function gives none (optional)" : "Subject, e.g. Claim {{object.no_sep}} is on hold"} className={inputClass} />
          <textarea value={effect.body ?? ""} onChange={(e) => setEffect({ ...effect, body: e.target.value })} rows={3} placeholder="Body: {{object.property}}, {{objects.count}}, {{group.value}}, {{error.message}} (empty for several objects: a list)" className={`${inputClass} text-xs`} />
          <label className="flex items-center gap-2 text-xs text-soft">
            <input type="checkbox" checked={!!effect.email} onChange={(e) => setEffect({ ...effect, email: e.target.checked })} /> Also send by email
          </label>
        </div>
      )}
    </div>
  );
}

/** A function effect: the published function, its version (range), the input that receives the object and fixed inputs. */
function FunctionEffect({ effect, setEffect, published, watched, schedule }: { effect: Extract<Effect, { kind: "function" }>; setEffect: (e: Effect) => void; published: FunctionRow[]; watched?: ObjectType; schedule: boolean }) {
  const f = published.find((x) => x.id === effect.function_id);
  const objectInputs = f?.inputs.filter((i) => i.type.startsWith("object:") && (!watched || i.type === `object:${watched.api_name}` || i.type === `object:${watched.id}`)) ?? [];
  return (
    <>
      <Field label="Function" hint={published.length ? undefined : "Publish functions from Code Repositories first"}>
        <select value={effect.function_id} onChange={(e) => setEffect({ ...effect, function_id: e.target.value, object_input: undefined, inputs: {} })} className={inputClass}>
          <option value="">Select a function…</option>
          {published.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} ({x.version})
            </option>
          ))}
        </select>
      </Field>
      {f && (
        <>
          <Field label="Version" hint="Exact version or a range such as ^1.0.0; empty uses the latest release">
            <input value={effect.version ?? ""} onChange={(e) => setEffect({ ...effect, version: e.target.value || undefined })} placeholder={`^${f.version.split(".")[0]}.0.0`} className={`${inputClass} font-mono`} />
          </Field>
          {!schedule && (
            <Field label="Pass the object to">
              <select value={effect.object_input ?? ""} onChange={(e) => setEffect({ ...effect, object_input: e.target.value || undefined })} className={inputClass}>
                <option value="">Don&apos;t pass the object</option>
                {(objectInputs.length ? objectInputs : f.inputs).map((i) => (
                  <option key={i.name} value={i.name}>
                    {i.name} ({i.type})
                  </option>
                ))}
              </select>
            </Field>
          )}
          {f.inputs
            .filter((i) => i.name !== effect.object_input)
            .map((i) => (
              <Field key={i.name} label={`Input ${i.name}${i.required ? " *" : ""}`} hint={`${i.type} · fixed value`}>
                <input value={String(effect.inputs?.[i.name] ?? "")} onChange={(e) => setEffect({ ...effect, inputs: { ...effect.inputs, [i.name]: e.target.value } })} className={inputClass} />
              </Field>
            ))}
        </>
      )}
    </>
  );
}

/** Derived properties of the condition: aggregates over linked objects (count, sum, …) the filters can test. */
function DerivedEditor({ typeId, derived, onChange }: { typeId: string; derived: ConditionDerived[]; onChange: (d: ConditionDerived[]) => void }) {
  const [links, setLinks] = useState<LinkType[]>([]);
  useEffect(() => {
    om.linkTypes({ object_type_id: typeId }).then(setLinks, () => setLinks([]));
  }, [typeId]);
  const set = (i: number, p: Partial<ConditionDerived>) => onChange(derived.map((d, j) => (j === i ? { ...d, ...p } : d)));
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted">Derived properties (aggregates over linked objects, computed from the object&apos;s current links)</div>
      {derived.map((d, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1">
          <input value={d.api_name} onChange={(e) => set(i, { api_name: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })} placeholder="name" className={`${fieldClass} w-28 font-mono`} />
          <select
            value={d.link_type_id}
            onChange={(e) => {
              const lt = links.find((x) => x.id === e.target.value);
              set(i, { link_type_id: e.target.value, direction: lt && lt.source.object_type_id === typeId ? "forward" : "reverse" });
            }}
            className={fieldClass}
          >
            <option value="">Link…</option>
            {links.map((l) => <option key={l.id} value={l.id}>{l.source.object_type_id === typeId ? l.target.display_name : l.source.display_name} ({l.display_name})</option>)}
          </select>
          <select value={d.metric} onChange={(e) => set(i, { metric: e.target.value as ConditionDerived["metric"] })} className={fieldClass}>
            {["count", "sum", "avg", "min", "max"].map((m) => <option key={m}>{m}</option>)}
          </select>
          {d.metric !== "count" && <input value={d.property ?? ""} onChange={(e) => set(i, { property: e.target.value || null })} placeholder="linked property" className={`${fieldClass} w-32`} />}
          <button type="button" onClick={() => onChange(derived.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Remove derived property"><Icon name="x" className="h-3 w-3" /></button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...derived, { api_name: `derived${derived.length + 1}`, link_type_id: "", direction: "forward", metric: "count" }])} className="text-xs text-ocean">
        + Derived property
      </button>
    </div>
  );
}
