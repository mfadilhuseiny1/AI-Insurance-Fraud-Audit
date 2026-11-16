"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Field } from "@/components/ontology/parts";
import { inputClass } from "@/components/pipeline/Modal";
import { ontology, type ActionType, type ObjectType } from "@/lib/ontology";
import { scenarios, type Scenario, type ScenarioDetail } from "@/lib/scenarios";
import { workshop, type Module, type ScenarioSaveBody, type ScenarioSaveResult, type ScenarioSaveState, type Widget, type WidgetConfig } from "@/lib/workshop";
import type { ModuleState } from "./WidgetView";

const Msg = ({ children }: { children: React.ReactNode }) => <div className="flex h-full items-center justify-center p-3 text-center text-xs text-muted">{children}</div>;
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" && v ? [v] : []);

/** The scenarios visible to the user (by id or rid), refreshed with the module. */
export function useScenarios(version: number) {
  const [list, setList] = useState<Scenario[]>([]);
  const [n, setN] = useState(0);
  useEffect(() => {
    scenarios.list().then(setList, () => setList([]));
  }, [version, n]);
  const find = (x: string) => list.find((s) => s.id === x || s.rid === x);
  return { list, find, reload: () => setN((k) => k + 1) };
}

// ------------------------------------------------------------------------------------------------
// Scenario Manager
// ------------------------------------------------------------------------------------------------

/** Each scenario's save state (New / Saved / Updated), refreshed with the module and after a save. */
function useSaveStates(sids: string[], version: number, n: number) {
  const [states, setStates] = useState<Record<string, ScenarioSaveState>>({});
  const key = sids.join(",");
  useEffect(() => {
    if (!key) return;
    let stale = false;
    workshop.scenarioStates(key.split(",")).then((x) => !stale && setStates(x), () => {});
    return () => {
      stale = true;
    };
  }, [key, version, n]);
  return states;
}

const STATE_BADGE: Record<ScenarioSaveState["state"], [string, string]> = {
  new: ["New", "bg-warn/15 text-warn"],
  saved: ["Saved", "bg-ok/15 text-ok"],
  updated: ["Updated", "bg-ocean/15 text-ocean"],
};

export function ScenarioManagerWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const { find, reload } = useScenarios(state.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [tick, setTick] = useState(0);
  const statics = ids(c.static_scenarios ? state.variables[c.static_scenarios] : undefined);
  const dynamics = ids(c.dynamic_scenarios ? state.variables[c.dynamic_scenarios] : undefined).filter((x) => !statics.includes(x));
  const active = c.active_scenario ? String(state.variables[c.active_scenario] ?? "") : "";
  const saveStates = useSaveStates([...statics, ...dynamics], state.version, tick);
  if (!c.dynamic_scenarios && !c.static_scenarios) return <Msg>Choose the scenario variables in the panel</Msg>;
  const stateOf = (sid: string): ScenarioSaveState["state"] | null => {
    const s = find(sid);
    const st = saveStates[sid] ?? (s ? saveStates[s.id] ?? saveStates[s.rid] : undefined);
    return st ? st.state : s ? (s.persisted ? "saved" : "new") : null;
  };
  const duplicate = async (sid: string) => {
    setBusy(true);
    setError(null);
    try {
      const s = await workshop.duplicateScenario(sid);
      if (c.dynamic_scenarios) state.setVariable(c.dynamic_scenarios, [...dynamics, s.id]);
      if (c.active_scenario) state.setVariable(c.active_scenario, s.id);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await scenarios.create({ name: `Scenario ${statics.length + dynamics.length + 1}`, description: "Workshop scenario" });
      if (c.dynamic_scenarios) state.setVariable(c.dynamic_scenarios, [...dynamics, s.id]);
      if (c.active_scenario) state.setVariable(c.active_scenario, s.id);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (sid: string) => {
    if (c.dynamic_scenarios) state.setVariable(c.dynamic_scenarios, dynamics.filter((x) => x !== sid));
    if (active === sid && c.active_scenario) state.setVariable(c.active_scenario, "");
    await scenarios.remove(sid).catch(() => {});
    reload();
  };
  const row = (sid: string, dynamic: boolean) => {
    const s = find(sid);
    const st = stateOf(sid);
    const on = active === sid || (!!s && active === s.rid);
    return (
      <div key={sid} className={`group flex items-center gap-2 rounded px-2 py-1 ${on ? "bg-ocean/15 ring-1 ring-ocean" : "hover:bg-panel-2"}`} data-scenario={sid}>
        <button type="button" disabled={editing} onClick={() => c.active_scenario && state.setVariable(c.active_scenario, sid)} className="min-w-0 flex-1 truncate text-left">
          {s?.name ?? sid}
        </button>
        {st && <span className={`rounded px-1 text-[10px] ${STATE_BADGE[st][1]}`} data-save-state={st}>{STATE_BADGE[st][0]}</span>}
        {s && !editing && !state.readOnly && c.dynamic_scenarios && (
          <button type="button" disabled={busy} onClick={() => void duplicate(sid)} className="hidden text-muted hover:text-white group-hover:block" title="Duplicate the scenario (its edits and actions)" data-scenario-duplicate={sid}>
            <Icon name="copy" className="h-3 w-3" />
          </button>
        )}
        {dynamic && !editing && (
          <button type="button" onClick={() => void remove(sid)} className="hidden text-muted hover:text-bad group-hover:block" title="Delete the scenario">
            <Icon name="trash" className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  };
  return (
    <div className="flex h-full flex-col text-xs" data-scenario-manager>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        <button type="button" disabled={editing} onClick={() => c.active_scenario && state.setVariable(c.active_scenario, "")} className={`block w-full rounded px-2 py-1 text-left ${!active ? "bg-panel-2 text-white" : "text-muted hover:bg-panel-2"}`} data-scenario="main">
          Main (the Nexus)
        </button>
        {statics.map((x) => row(x, false))}
        {dynamics.map((x) => row(x, true))}
        {error && <p className="text-bad">{error}</p>}
      </div>
      {saving && active && (
        <SaveScenarioForm
          sid={active}
          config={c}
          onClose={() => setSaving(false)}
          onSaved={() => {
            setSaving(false);
            setTick((k) => k + 1);
            reload();
            state.bump();
          }}
        />
      )}
      <div className="flex shrink-0 gap-1.5 border-t border-line p-2">
        <button type="button" disabled={editing || busy || !c.dynamic_scenarios || !!state.readOnly} onClick={create} className="rounded bg-ocean px-2.5 py-1 text-white disabled:opacity-40" data-scenario-create>
          <Icon name="plus" className="inline h-3 w-3" /> Create
        </button>
        <button type="button" disabled={editing || busy || !active || !!state.readOnly || stateOf(active) === "saved"} onClick={() => setSaving((x) => !x)} className="rounded border border-line px-2.5 py-1 disabled:opacity-40" title={c.scenario_save_type ? "Save the active scenario to its scenario object" : "Save (persist) the active scenario"} data-scenario-save>
          <Icon name="save" className="inline h-3 w-3" /> Save
        </button>
        <button type="button" disabled={editing || busy || !active || !c.dynamic_scenarios || !!state.readOnly} onClick={() => void duplicate(active)} className="rounded border border-line px-2.5 py-1 disabled:opacity-40" data-scenario-duplicate-active>
          <Icon name="copy" className="inline h-3 w-3" /> Duplicate
        </button>
      </div>
    </div>
  );
}

/** Save scenario: the scenario object's action form with the scenario id, name and object filled from their type
 * classes (the id and object locked); without a scenario object type it only persists the scenario. */
function SaveScenarioForm({ sid, config: c, onClose, onSaved }: { sid: string; config: WidgetConfig; onClose: () => void; onSaved: () => void }) {
  const [pv, setPv] = useState<ScenarioSaveResult | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const body: ScenarioSaveBody = { object_type_id: c.scenario_save_type, create_action_id: c.scenario_save_create_action, update_action_id: c.scenario_save_update_action };
  const bodyKey = JSON.stringify(body);
  useEffect(() => {
    let stale = false;
    workshop.saveScenario(sid, { ...(JSON.parse(bodyKey) as ScenarioSaveBody), preview: true }).then(
      (x) => !stale && (setPv(x), setValues(x.parameters ?? {}), setError(null)),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [sid, bodyKey]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const locked = new Set(pv?.locked ?? []);
      await workshop.saveScenario(sid, { ...body, parameters: Object.fromEntries(Object.entries(values).filter(([k]) => !locked.has(k))) });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="max-h-[60%] shrink-0 space-y-1.5 overflow-y-auto border-t border-line p-2" data-scenario-save-form>
      <div className="font-medium">
        {!pv ? "Save scenario" : pv.mode === "persist" ? "Save scenario" : pv.mode === "create" ? `Save scenario · ${pv.action ?? "create"}` : `Update the saved scenario${pv.action ? ` · ${pv.action}` : ""}`}
      </div>
      {pv?.mode === "persist" && <p className="text-muted">Keeps the scenario (it no longer expires).</p>}
      {pv && pv.mode !== "persist" && !pv.action && <p className="text-muted">No update action: the scenario is kept, its object is left as it is.</p>}
      {(pv?.fields ?? []).map((f) => (
        <label key={f.id} className="block">
          <span className="text-[10px] text-muted">
            {f.display_name}
            {f.required && " *"}
            {f.locked && " · from the scenario"}
          </span>
          {f.type === "boolean" ? (
            <input type="checkbox" className="ml-2" checked={!!values[f.id]} disabled={f.locked} onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.checked }))} data-save-param={f.id} />
          ) : (
            <input
              value={values[f.id] === undefined || values[f.id] === null ? "" : String(values[f.id])}
              disabled={f.locked}
              type={f.type === "integer" || f.type === "double" || f.type === "number" ? "number" : "text"}
              onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value }))}
              className={`${inputClass} py-0.5 text-xs disabled:opacity-60`}
              data-save-param={f.id}
            />
          )}
        </label>
      ))}
      {error && <p className="text-bad">{error}</p>}
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onClose} className="rounded px-2 py-0.5 text-muted hover:text-white">
          Cancel
        </button>
        <button type="button" disabled={!pv || busy} onClick={() => void save()} className="rounded bg-ocean px-2.5 py-0.5 text-white disabled:opacity-40" data-scenario-save-submit>
          Save
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Scenario Selector
// ------------------------------------------------------------------------------------------------

export function ScenarioSelectorWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const { find } = useScenarios(state.version);
  const cands = ids(c.scenario_candidates ? state.variables[c.scenario_candidates] : undefined);
  const out = c.scenario_output ? state.variables[c.scenario_output] : undefined;
  const chosen = ids(out);
  if (!c.scenario_candidates || !c.scenario_output) return <Msg>Choose the candidate scenarios and the output variable in the panel</Msg>;
  if (!cands.length) return <Msg>No scenarios</Msg>;
  const toggle = (sid: string) => {
    if (c.scenario_multi) state.setVariable(c.scenario_output!, chosen.includes(sid) ? chosen.filter((x) => x !== sid) : [...chosen, sid]);
    else state.setVariable(c.scenario_output!, chosen.includes(sid) ? "" : sid);
  };
  return (
    <div className="h-full space-y-0.5 overflow-y-auto p-2 text-xs" data-scenario-selector>
      {cands.map((sid) => (
        <label key={sid} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-panel-2">
          <input type={c.scenario_multi ? "checkbox" : "radio"} checked={chosen.includes(sid)} disabled={editing} onChange={() => toggle(sid)} data-select-scenario={sid} />
          <span className="truncate">{find(sid)?.name ?? sid}</span>
        </label>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Scenario Summary
// ------------------------------------------------------------------------------------------------

export function ScenarioSummaryWidget({ widget, state }: { widget: Widget; state: ModuleState }) {
  const c = widget.config;
  const sid = c.active_scenario ? String(state.variables[c.active_scenario] ?? "") : "";
  const [d, setD] = useState<ScenarioDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!sid) return;
    let stale = false;
    scenarios.get(sid).then((x) => !stale && (setD(x), setError(null)), (e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [sid, state.version]);
  if (!c.active_scenario) return <Msg>Choose the scenario variable in the panel</Msg>;
  if (!sid) return <Msg>No scenario selected (main)</Msg>;
  if (error) return <Msg>{error}</Msg>;
  if (!d || (d.id !== sid && d.rid !== sid)) return <Msg>Loading…</Msg>;
  return (
    <div className="h-full overflow-y-auto p-2 text-xs" data-scenario-summary>
      <div className="mb-1 font-semibold">{d.name}</div>
      <div className="mb-2 text-muted">
        {d.activity.length} action{d.activity.length === 1 ? "" : "s"} · {d.edits.length} edited object{d.edits.length === 1 ? "" : "s"}
      </div>
      {d.activity.map((a, i) => (
        <div key={i} className="border-b border-line py-1" data-scenario-action>
          <div>{a.label}</div>
          <div className="text-[10px] text-muted">
            {new Date(a.at).toLocaleString()} · {a.user} · {a.edited.length} object{a.edited.length === 1 ? "" : "s"}
          </div>
        </div>
      ))}
      {!d.activity.length && <p className="text-muted">No actions applied to this scenario yet.</p>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// configuration
// ------------------------------------------------------------------------------------------------

export const SCENARIO_TYPES = new Set(["scenario_manager", "scenario_selector", "scenario_summary"]);

const VIZ_TYPES = new Set(["map", "vega", "pivot", "gantt", "timeline"]);

const hasTrait = (t: ObjectType) =>
  t.properties.some((p) => ((p as { type_classes?: string[] }).type_classes ?? []).some((x) => x.split(":").pop() === "versioned-scenario-rid"));

/** Save scenario's target: an object type implementing the scenario trait and its create / update actions. */
function SaveTargetConfig({ widget, set }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void }) {
  const c = widget.config;
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [actions, setActions] = useState<ActionType[]>([]);
  useEffect(() => {
    ontology.objectTypes().then((x) => setTypes(x.filter(hasTrait)), () => setTypes([]));
  }, []);
  useEffect(() => {
    if (!c.scenario_save_type) return;
    ontology.actionTypes(c.scenario_save_type).then(setActions, () => setActions([]));
  }, [c.scenario_save_type]);
  const acts = c.scenario_save_type ? actions : [];
  const actSel = (k: "scenario_save_create_action" | "scenario_save_update_action", label: string, kind: string) => (
    <Field label={label}>
      <select value={c[k] ?? ""} onChange={(e) => set({ [k]: e.target.value || undefined })} className={inputClass} data-scenario-save-cfg={k}>
        <option value="">None</option>
        {acts.filter((a) => a.kind === kind).map((a) => (
          <option key={a.id} value={a.id}>
            {a.display_name}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <div className="space-y-2 rounded border border-line p-2">
      <Field label="Save scenario to an object type (an ID property with the type class scenarios:versioned-scenario-rid)">
        <select value={c.scenario_save_type ?? ""} onChange={(e) => set({ scenario_save_type: e.target.value || undefined, scenario_save_create_action: undefined, scenario_save_update_action: undefined })} className={inputClass} data-scenario-save-cfg="scenario_save_type">
          <option value="">None (Save only keeps the scenario)</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.display_name}
            </option>
          ))}
        </select>
      </Field>
      {c.scenario_save_type && actSel("scenario_save_create_action", "Create action (the scenario id and name fill from their type classes)", "create")}
      {c.scenario_save_type && actSel("scenario_save_update_action", "Update action (the object: scenarios:scenario-object-locator)", "modify")}
    </div>
  );
}

export function ScenarioConfig({ widget, set, mod }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module }) {
  const c = widget.config;
  const t = widget.type;
  const vars = mod.variables ?? [];
  const varSel = (k: keyof WidgetConfig, label: string, types: string[]) => (
    <Field label={label}>
      <select value={(c[k] as string | undefined) ?? ""} onChange={(e) => set({ [k]: e.target.value || undefined })} className={inputClass} data-scenario-var={k}>
        <option value="">None</option>
        {vars.filter((v) => types.includes(v.type)).map((v) => (
          <option key={v.name}>{v.name}</option>
        ))}
      </select>
    </Field>
  );
  if (t === "scenario_manager")
    return (
      <div className="space-y-2">
        {varSel("static_scenarios", "Static scenarios (a scenario array: saved ones users cannot remove)", ["scenario_array"])}
        {varSel("dynamic_scenarios", "Dynamic scenarios (a scenario array: those users create)", ["scenario_array"])}
        {varSel("active_scenario", "Active scenario (a scenario variable)", ["scenario"])}
        <SaveTargetConfig widget={widget} set={set} />
      </div>
    );
  if (t === "scenario_selector")
    return (
      <div className="space-y-2">
        {varSel("scenario_candidates", "Candidate scenarios (a scenario array)", ["scenario_array"])}
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!c.scenario_multi} onChange={(e) => set({ scenario_multi: e.target.checked })} /> Multi-select (outputs a scenario array)
        </label>
        {varSel("scenario_output", "Output", c.scenario_multi ? ["scenario_array"] : ["scenario"])}
      </div>
    );
  if (t === "scenario_summary") return varSel("active_scenario", "Scenario to summarize", ["scenario"]);
  // data and action widgets: scenario awareness
  // visualization widgets with their own sources (map layers, Vega inputs) read from the scenario too
  const hasData = !!c.source || VIZ_TYPES.has(t);
  const acts = t === "button" || t === "inline_action";
  if (!hasData && !acts) return null;
  if (!vars.some((v) => v.type === "scenario" || v.type === "scenario_array")) return null;
  return (
    <details className="rounded border border-line p-2 text-xs" open={!!(c.scenario_variable || c.scenario_compare || c.apply_to_scenario)} data-scenario-aware>
      <summary className="cursor-pointer text-soft">Scenarios [Legacy]</summary>
      <div className="mt-2 space-y-2">
        {hasData && varSel("scenario_variable", "Load data from scenario", ["scenario"])}
        {hasData && t === "table" && varSel("scenario_compare", "Compare against scenarios (differing values side by side)", ["scenario_array"])}
        {acts && varSel("apply_to_scenario", "Apply the action to this scenario (instead of the Nexus)", ["scenario"])}
      </div>
    </details>
  );
}
