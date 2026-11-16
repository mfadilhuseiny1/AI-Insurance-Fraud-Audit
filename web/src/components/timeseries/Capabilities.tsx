"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Card, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { ontology, type ObjectType } from "@/lib/ontology";
import {
  INTERPOLATION_HELP,
  INTERPOLATIONS,
  timeseries,
  tsOntology,
  type Diagnostics,
  type Formatting,
  type SensorConfig,
  type SeriesSync,
  type TimeSeriesConfig,
  type TspConfig,
} from "@/lib/timeseries";
import { SyncDialog } from "./SyncDialog";

type Editable = Omit<TimeSeriesConfig, "object_type_id" | "units" | "interpolations">;

/**
 * Ontology Manager → Capabilities: the object type's time series properties (their syncs, units, interpolation,
 * the default), sensor object type configuration, time series sync markings, geospatial tracks and why time
 * series fail to load.
 */
export function TimeSeriesCapabilities({ t, onChanged }: { t: ObjectType; onChanged: () => void }) {
  const [cfg, setCfg] = useState<TimeSeriesConfig | null>(null);
  const [syncs, setSyncs] = useState<SeriesSync[]>([]);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [setup, setSetup] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    tsOntology.config(t.id).then(setCfg, (e: Error) => setError(e.message));
    timeseries.syncs("timeseries").then(setSyncs, () => setSyncs([]));
    ontology.objectTypes().then(setTypes, () => setTypes([]));
  }, [t.id]);
  useEffect(load, [load]);
  if (!cfg) return <div className="p-8 text-sm text-muted">{error ?? "Loading…"}</div>;
  const tsps = Object.entries(cfg.properties);
  const syncName = (id: string) => syncs.find((s) => s.id === id)?.name ?? id;
  const save = async (next: Editable) => {
    setBusy(true);
    setError(null);
    try {
      setCfg(await tsOntology.saveConfig(t.id, next));
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const editable = (): Editable => ({ properties: cfg.properties, default_property: cfg.default_property, sensor: cfg.sensor, severed_markings: cfg.severed_markings, geospatial: cfg.geospatial });
  const usedSyncs = [...new Set(tsps.flatMap(([, p]) => p.syncs))];
  const sensorDone = cfg.sensor && cfg.sensor.links.length > 0 && tsps.length === 1;
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-8">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">Capabilities</h1>
          <p className="mt-1 text-sm text-muted">Time series properties make {t.display_name} a time series object type: Quiver, Workshop, derived series, alerting and the Map read them.</p>
        </div>
        <Link href={`/time-series/object-types/${t.id}`} className={buttonClass.secondary}>
          <Icon name="wave" className="h-3.5 w-3.5" /> Open in Time Series Catalog
        </Link>
      </div>
      <ErrorBox message={error} />

      <Card
        title="Time series"
        count={tsps.length}
        action={
          tsps.length > 0 && !cfg.sensor ? (
            <button type="button" className={buttonClass.ghost} onClick={() => setSetup(true)}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Add property
            </button>
          ) : null
        }
      >
        {tsps.length === 0 ? (
          <div className="p-6 text-center text-sm">
            <p className="mb-3 text-muted">No time series properties yet. Pick the string property that holds series IDs, the time series syncs that hold their points, and whether this is a sensor object type.</p>
            <button type="button" onClick={() => setSetup(true)} className={buttonClass.primary}>
              <Icon name="play" className="h-3.5 w-3.5" /> Get started
            </button>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Property</th>
                <th className="px-3 py-2 font-medium">Data sources (syncs)</th>
                <th className="px-3 py-2 font-medium">Units</th>
                <th className="px-3 py-2 font-medium">Interpolation</th>
                <th className="px-3 py-2 font-medium">Default</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tsps.map(([name, p]) => (
                <tr key={name} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 font-medium">{t.properties.find((x) => x.api_name === name)?.display_name ?? name}</td>
                  <td className="px-3 py-2 text-xs">
                    {p.syncs.map((s) => (
                      <Link key={s} href={`/time-series/${s}`} className="mr-2 text-ocean hover:underline">
                        {syncName(s)}
                      </Link>
                    ))}
                  </td>
                  <td className="px-3 py-2 text-xs">{fmtFormatting(p.unit) || (cfg.sensor?.unit_property ? `property ${cfg.sensor.unit_property}` : "—")}</td>
                  <td className="px-3 py-2 text-xs">
                    {fmtFormatting(p.interpolation) || (cfg.sensor?.interpolation_property ? `property ${cfg.sensor.interpolation_property}` : "default")}
                    {p.external === "NEAREST" ? " · extrapolate nearest" : ""}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="radio"
                      checked={cfg.default_property === name}
                      disabled={!!cfg.sensor || busy}
                      onChange={() => save({ ...editable(), default_property: name })}
                      aria-label="Default time series property"
                    />
                  </td>
                  <td className="whitespace-nowrap px-2 text-right">
                    <button type="button" className="rounded p-1.5 text-muted hover:bg-panel-2 hover:text-white" onClick={() => setEditing(name)} aria-label="Edit">
                      <Icon name="pencil" className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="rounded p-1.5 text-muted hover:bg-panel-2 hover:text-bad"
                      aria-label="Remove"
                      onClick={async () => {
                        if (!(await confirmDialog(`Stop using ${name} as a time series property? It becomes a string property again; its series IDs stay.`))) return;
                        setCfg(await tsOntology.removeTsp(t.id, name));
                        onChanged();
                      }}
                    >
                      <Icon name="trash" className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {cfg.sensor && (
        <Card title="Sensor object type configuration" action={sensorDone ? <span className="flex items-center gap-1 text-xs text-ok"><Icon name="check" className="h-3.5 w-3.5" /> All complete</span> : null}>
          <SensorEditor key={JSON.stringify(cfg.sensor)} t={t} types={types} sensor={cfg.sensor} busy={busy} onSave={(sensor) => save({ ...editable(), sensor })} />
        </Card>
      )}

      {usedSyncs.length > 0 && (
        <Card title="Time series sync markings">
          <div className="space-y-2 p-4 text-sm">
            <p className="text-xs text-muted">
              Syncs inherit the markings of their input dataset. Reading a time series through these properties needs them too — unless you stop inheriting them here; then
              object and property permissions alone decide. Direct access to a sync still needs its markings. Use with caution.
            </p>
            {usedSyncs.map((s) => {
              const severed = cfg.severed_markings.includes(s);
              return (
                <label key={s} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!severed}
                    disabled={busy}
                    onChange={() => save({ ...editable(), severed_markings: severed ? cfg.severed_markings.filter((x) => x !== s) : [...cfg.severed_markings, s] })}
                  />
                  <span>{syncName(s)}</span>
                  <span className="text-xs text-muted">{severed ? "markings not required through this object type" : "markings inherited"}</span>
                </label>
              );
            })}
          </div>
        </Card>
      )}

      {tsps.length > 0 && (
        <Card title="Geospatial">
          <div className="grid grid-cols-2 gap-3 p-4">
            {(["track_latitude", "track_longitude"] as const).map((k) => (
              <Field key={k} label={k === "track_latitude" ? "Track latitude" : "Track longitude"} hint="A time series property; the Map draws the object's track from both">
                <select
                  value={cfg.geospatial?.[k] ?? ""}
                  disabled={busy}
                  onChange={(e) => save({ ...editable(), geospatial: { ...(cfg.geospatial ?? {}), [k]: e.target.value || null } })}
                  className={inputClass}
                >
                  <option value="">—</option>
                  {tsps.map(([n]) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
        </Card>
      )}

      {t.backing_dataset && (
        <Card title="Backing dataset">
          <div className="flex items-center gap-3 p-4 text-sm">
            <Icon name="database" className="h-4 w-4 text-ocean" />
            <span className="flex-1">
              {t.backing_dataset.name} <span className="text-xs text-muted">· indexed {when(t.backing_dataset.synced_at)}</span>
            </span>
            <button type="button" className={buttonClass.secondary} onClick={async () => (await tsOntology.syncBacking(t.id), onChanged())}>
              <Icon name="refresh" className="h-3.5 w-3.5" /> Re-index objects
            </button>
          </div>
        </Card>
      )}

      {tsps.length > 0 && (
        <Card title="Why is my time series failing to load?" action={<button type="button" className={buttonClass.ghost} onClick={() => tsOntology.diagnostics(t.id).then(setDiag, (e: Error) => setError(e.message))}><Icon name="search" className="h-3.5 w-3.5" /> Check</button>}>
          <div className="p-4 text-sm">
            {!diag ? (
              <p className="text-xs text-muted">Checks that every object&apos;s series ID is held by one of the property&apos;s syncs (the set of series IDs in both should intersect, ideally be equal).</p>
            ) : (
              diag.properties.map((d) => (
                <div key={d.property} className="mb-3">
                  <div className="font-medium">{d.display_name}</div>
                  <div className="text-xs text-muted">
                    {d.with_value} of {d.objects} objects have a value · <span className={d.resolved === d.with_value ? "text-ok" : "text-warn"}>{d.resolved} resolve</span> · {d.derived} derived ·{" "}
                    {d.qualified} qualified · syncs hold {d.sync_series} series
                  </div>
                  {d.missing.map((m) => (
                    <div key={m.primary_key} className="text-xs text-warn">
                      {m.primary_key}: no data for series ID <span className="font-mono">{m.series_id}</span>
                      {m.sync ? ` in ${m.sync}` : ""}
                    </div>
                  ))}
                  {d.invalid.map((m) => (
                    <div key={m.primary_key} className="text-xs text-bad">
                      {m.primary_key}: {m.error}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </Card>
      )}

      {setup && (
        <TspSetupDialog
          t={t}
          types={types}
          syncs={syncs}
          first={tsps.length === 0}
          onClose={() => setSetup(false)}
          onDone={(c) => {
            setCfg(c);
            setSetup(false);
            onChanged();
            load();
          }}
        />
      )}
      {editing && cfg.properties[editing] && (
        <FormattingDialog
          t={t}
          name={editing}
          p={cfg.properties[editing]}
          syncs={syncs}
          onClose={() => setEditing(null)}
          onSave={async (p) => {
            await save({ ...editable(), properties: { ...cfg.properties, [editing]: p } });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

const fmtFormatting = (f: Formatting) => (f.property ? `property ${f.property}` : f.value || "");

function FormattingFields({ t, value, onChange, kind }: { t: ObjectType; value: Formatting; onChange: (f: Formatting) => void; kind: "unit" | "interpolation" }) {
  const strings = t.properties.filter((p) => p.type === "string");
  const byProp = !!value.property;
  return (
    <div className="flex gap-2">
      <select value={byProp ? "property" : "value"} onChange={(e) => onChange(e.target.value === "property" ? { property: strings[0]?.api_name ?? "" } : { value: "" })} className={`${fieldClass} w-36`}>
        <option value="value">Standard value</option>
        <option value="property">From a property</option>
      </select>
      {byProp ? (
        <select value={value.property ?? ""} onChange={(e) => onChange({ property: e.target.value })} className={`${fieldClass} flex-1`}>
          {strings.map((p) => (
            <option key={p.api_name} value={p.api_name}>
              {p.display_name}
            </option>
          ))}
        </select>
      ) : kind === "interpolation" ? (
        <select value={value.value ?? ""} onChange={(e) => onChange({ value: e.target.value || null })} className={`${fieldClass} flex-1`}>
          <option value="">Default (LINEAR numeric, PREVIOUS categorical)</option>
          {INTERPOLATIONS.map((i) => (
            <option key={i} value={i} title={INTERPOLATION_HELP[i]}>
              {i} — {INTERPOLATION_HELP[i]}
            </option>
          ))}
        </select>
      ) : (
        <input value={value.value ?? ""} onChange={(e) => onChange({ value: e.target.value || null })} list="ts-units" placeholder="°C, kPa, rpm…" className={`${fieldClass} flex-1`} />
      )}
      <datalist id="ts-units">
        {["°C", "°F", "K", "kPa", "bar", "psi", "m", "km", "m/s", "km/h", "kn", "rpm", "Hz", "V", "A", "W", "kW", "MW", "kWh", "%", "L", "kg", "count"].map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
    </div>
  );
}

function SyncPicker({ syncs, value, onChange, onNew }: { syncs: SeriesSync[]; value: string[]; onChange: (v: string[]) => void; onNew: () => void }) {
  return (
    <div className="space-y-1.5">
      {value.map((id, i) => (
        <div key={i} className="flex gap-2">
          <select value={id} onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))} className={inputClass}>
            <option value="">Choose a time series sync…</option>
            {syncs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.series} series)
              </option>
            ))}
          </select>
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} className={buttonClass.ghost} aria-label="Remove">
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <button type="button" onClick={() => onChange([...value, ""])} className={buttonClass.secondary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> Choose sync
        </button>
        <button type="button" onClick={onNew} className={buttonClass.ghost}>
          New time series sync…
        </button>
      </div>
      {value.filter(Boolean).length > 1 && <p className="text-[11px] text-muted">Backed by several syncs: values must be qualified series IDs ({`{"seriesId":"…","syncRid":"…"}`}).</p>}
    </div>
  );
}

function TspSetupDialog({
  t,
  types,
  syncs,
  first,
  onClose,
  onDone,
}: {
  t: ObjectType;
  types: ObjectType[];
  syncs: SeriesSync[];
  first: boolean;
  onClose: () => void;
  onDone: (c: TimeSeriesConfig) => void;
}) {
  const candidates = t.properties.filter((p) => (p.type === "string" || p.type === "timeseries") && p.api_name !== t.primary_key && p.api_name !== t.title_property);
  const [step, setStep] = useState(0);
  const [prop, setProp] = useState(candidates[0]?.api_name ?? "");
  const [chosen, setChosen] = useState<string[]>([""]);
  const [allSyncs, setAllSyncs] = useState(syncs);
  const [newSync, setNewSync] = useState(false);
  const [sensor, setSensor] = useState(false);
  const [links, setLinks] = useState<SensorConfig>({ links: [{ root_object_type_id: "", foreign_key: "", sensor_name_property: "" }] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await tsOntology.addTsp(t.id, { property: prop, syncs: chosen.filter(Boolean), sensor: sensor ? links : null, make_default: first }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Time series property setup" icon="wave" onClose={onClose} wide>
      <div className="flex gap-1 border-b border-line px-4 py-2 text-xs">
        {["Select property", "Select time series sync(s)", "Determine object type"].map((l, i) => (
          <span key={l} className={`rounded-md px-2 py-1 ${step === i ? "bg-ocean/15 text-white" : "text-muted"}`}>
            {i + 1}. {l}
          </span>
        ))}
      </div>
      <div className="space-y-4 p-4 text-sm">
        {step === 0 && (
          <Field label="Object type property" hint="A string property holding the series IDs (not the primary key or title)">
            <select value={prop} onChange={(e) => setProp(e.target.value)} className={inputClass}>
              {candidates.length === 0 && <option value="">No string property — add one in Properties</option>}
              {candidates.map((p) => (
                <option key={p.api_name} value={p.api_name}>
                  {p.display_name} ({p.api_name})
                </option>
              ))}
            </select>
          </Field>
        )}
        {step === 1 && (
          <Field label="Time series syncs" hint="The series IDs of this property must be held by one of them">
            <SyncPicker syncs={allSyncs} value={chosen} onChange={setChosen} onNew={() => setNewSync(true)} />
          </Field>
        )}
        {step === 2 && (
          <>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  [false, "Standard time series property", "Every object of this type has this time series"],
                  [true, "Sensor object type", "Each object is a sensor recording one series for a linked root object"],
                ] as const
              ).map(([v, label, hint]) => (
                <button key={label} type="button" onClick={() => setSensor(v)} className={`rounded-lg border p-2.5 text-left ${sensor === v ? "border-ocean bg-ocean/10" : "border-line-2"}`}>
                  <div className="font-medium">{label}</div>
                  <div className="text-xs text-muted">{hint}</div>
                </button>
              ))}
            </div>
            {sensor && <SensorEditor t={t} types={types} sensor={links} busy={false} onSave={setLinks} inline />}
          </>
        )}
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          {step > 0 && (
            <button type="button" onClick={() => setStep(step - 1)} className={buttonClass.secondary}>
              Back
            </button>
          )}
          {step < 2 ? (
            <button type="button" disabled={step === 0 ? !prop : !chosen.some(Boolean)} onClick={() => setStep(step + 1)} className={buttonClass.primary}>
              Next
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={submit} className={buttonClass.primary}>
              Add property
            </button>
          )}
        </div>
      </div>
      {newSync && (
        <SyncDialog
          onClose={() => setNewSync(false)}
          onSaved={(s) => {
            setAllSyncs([s, ...allSyncs]);
            setChosen([...chosen.filter(Boolean), s.id]);
            setNewSync(false);
          }}
        />
      )}
    </Modal>
  );
}

function SensorEditor({ t, types, sensor, busy, onSave, inline }: { t: ObjectType; types: ObjectType[]; sensor: SensorConfig; busy: boolean; onSave: (s: SensorConfig) => void; inline?: boolean }) {
  const [s, setS] = useState<SensorConfig>(sensor);
  const update = (next: SensorConfig) => (setS(next), inline && onSave(next));
  const props = (kinds: string[]) => t.properties.filter((p) => kinds.includes(p.type));
  const sel = (value: string | null | undefined, onChange: (v: string) => void, kinds: string[], empty = "—") => (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={`${fieldClass} w-full`}>
      <option value="">{empty}</option>
      {props(kinds).map((p) => (
        <option key={p.api_name} value={p.api_name}>
          {p.display_name}
        </option>
      ))}
    </select>
  );
  return (
    <div className="space-y-3 p-4 text-sm">
      <div className="text-xs font-medium text-soft">Sensor links (required)</div>
      {s.links.map((l, i) => {
        const setL = (patch: Partial<typeof l>) => update({ ...s, links: s.links.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
        return (
          <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
            <select value={l.root_object_type_id} onChange={(e) => setL({ root_object_type_id: e.target.value })} className={`${fieldClass} w-full`}>
              <option value="">Root object type…</option>
              {types
                .filter((x) => x.id !== t.id)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.display_name}
                  </option>
                ))}
            </select>
            {sel(l.foreign_key, (v) => setL({ foreign_key: v }), ["string", "integer"], "Foreign key (root's primary key)…")}
            {sel(l.sensor_name_property, (v) => setL({ sensor_name_property: v }), ["string", "integer"], "Sensor name…")}
            <button type="button" className={buttonClass.ghost} onClick={() => update({ ...s, links: s.links.filter((_, j) => j !== i) })} aria-label="Remove link">
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      <button type="button" className={buttonClass.ghost} onClick={() => update({ ...s, links: [...s.links, { root_object_type_id: "", foreign_key: "", sensor_name_property: "" }] })}>
        <Icon name="plus" className="h-3.5 w-3.5" /> Add sensor link
      </button>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Is categorical?" hint="Needed when syncs mix numeric and categorical data">
          {sel(s.is_categorical_property, (v) => update({ ...s, is_categorical_property: v || null }), ["boolean"])}
        </Field>
        <Field label="Units (recommended)">{sel(s.unit_property, (v) => update({ ...s, unit_property: v || null }), ["string"])}</Field>
        <Field label="Internal interpolation" hint="LINEAR, NEAREST, PREVIOUS, NEXT or NONE">
          {sel(s.interpolation_property, (v) => update({ ...s, interpolation_property: v || null }), ["string"])}
        </Field>
      </div>
      {!inline && (
        <div className="flex justify-end">
          <button type="button" disabled={busy} onClick={() => onSave(s)} className={buttonClass.primary}>
            Save sensor configuration
          </button>
        </div>
      )}
    </div>
  );
}

function FormattingDialog({ t, name, p, syncs, onClose, onSave }: { t: ObjectType; name: string; p: TspConfig; syncs: SeriesSync[]; onClose: () => void; onSave: (p: TspConfig) => void }) {
  const [v, setV] = useState<TspConfig>(p);
  const [newSync, setNewSync] = useState(false);
  const [all, setAll] = useState(syncs);
  return (
    <Modal title={`Time series formatting · ${name}`} icon="wave" onClose={onClose} wide>
      <div className="space-y-4 p-4 text-sm">
        <Field label="Data sources">
          <SyncPicker syncs={all} value={v.syncs.length ? v.syncs : [""]} onChange={(syncsNext) => setV({ ...v, syncs: syncsNext })} onNew={() => setNewSync(true)} />
        </Field>
        <Field label="Units" hint="Shown as axis labels in Quiver, Workshop and the catalog">
          <FormattingFields t={t} kind="unit" value={v.unit} onChange={(unit) => setV({ ...v, unit })} />
        </Field>
        <Field label="Internal interpolation" hint="Between points; used when series are combined">
          <FormattingFields t={t} kind="interpolation" value={v.interpolation} onChange={(interpolation) => setV({ ...v, interpolation })} />
        </Field>
        <Field label="External interpolation" hint="Before the first and after the last point">
          <select value={v.external} onChange={(e) => setV({ ...v, external: e.target.value as "NONE" | "NEAREST" })} className={inputClass}>
            <option value="NONE">NONE — no value outside the points</option>
            <option value="NEAREST">NEAREST — the first / last value</option>
          </select>
        </Field>
        <Field label="Description" hint="Optional: what the series hold (for example what each sync contributes)">
          <textarea value={v.description ?? ""} onChange={(e) => setV({ ...v, description: e.target.value })} rows={2} className={inputClass} aria-label="Time series property description" />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" onClick={() => onSave({ ...v, syncs: v.syncs.filter(Boolean) })} className={buttonClass.primary}>
            Save
          </button>
        </div>
      </div>
      {newSync && (
        <SyncDialog
          onClose={() => setNewSync(false)}
          onSaved={(s) => {
            setAll([s, ...all]);
            setV({ ...v, syncs: [...v.syncs.filter(Boolean), s.id] });
            setNewSync(false);
          }}
        />
      )}
    </Modal>
  );
}
