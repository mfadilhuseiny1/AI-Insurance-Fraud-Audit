"use client";

import { useEffect, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { MapCanvas, type Basemap } from "@/components/map/MapCanvas";
import { ErrorBox } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { renderMarkdown } from "@/lib/markdown";
import { forms, type Evaluation, type FormField, type FormSheet, type Submission, type SubmitSource } from "@/lib/forms";

type Values = Record<string, unknown>;
type EffField = Evaluation["fields"][string];

// Phone width: controls are at least 40 px tall and use 16 px text (smaller text makes iOS zoom the page on focus).
const field = `${inputClass} min-h-10 max-sm:text-base`;
const readout = "flex min-h-10 items-center rounded border border-line bg-panel-2 px-2.5 py-1.5";
const touch = "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-bad";
const tall = "min-h-10 justify-center";
// radio buttons and checkboxes: one per line on a phone (each line a 40 px target), side by side from 640 px up
const CHOICES = "flex flex-col sm:flex-row sm:flex-wrap sm:gap-x-4";
const CHOICE = "flex min-h-10 min-w-0 items-center gap-2 text-sm";

/**
 * A respondent filling a form: the server evaluates transforms, auto-populating fields, data-backed options and
 * validators as the values change (draft: the editor's preview of the unpublished definition).
 * Embedded (the fill page in an iframe): `source` says where the form is filled and for which object, `notice` lists
 * prefilled values that were not used, `onSubmitted` tells the host page.
 */
export function FormFill({ formId, draft = false, initial = {}, noHeader = false, embedded = false, source, notice, onSubmitted, progress = false, subtitle }: {
  formId: string; draft?: boolean; initial?: Values; noHeader?: boolean; embedded?: boolean; source?: SubmitSource; notice?: Record<string, string>;
  onSubmitted?: (r: Submission) => void;
  /** a progress bar (the share of the visible fields that have a value) as the header (`progressOnly=true`) */
  progress?: boolean;
  /** under the title: the object the form is filled for */
  subtitle?: string;
}) {
  const [values, setValues] = useState<Values>(initial);
  const [entries, setEntries] = useState<Record<string, Values[]>>({});
  const [ev, setEv] = useState<Evaluation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openedAt] = useState(() => new Date().toISOString());
  const [touched, setTouched] = useState(false);
  const key = JSON.stringify(values);
  useEffect(() => {
    let stale = false;
    const timer = window.setTimeout(() => {
      forms.evaluate(formId, JSON.parse(key) as Values, draft).then(
        (r) => !stale && (setEv(r), setError(null)),
        (e: Error) => !stale && setError(e.message),
      );
    }, 250);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [formId, key, draft]);

  if (!ev) return error ? <ErrorBox message={error} /> : <p className="p-6 text-sm text-muted">Loading the form…</p>;
  const defn = ev.definition;
  const set = (id: string, v: unknown) => {
    setTouched(true);
    setValues((x) => ({ ...x, [id]: v }));
  };
  const errorsShown = touched ? { ...ev.errors, ...fieldErrors } : fieldErrors;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await forms.submit(formId, { values, entries, opened_at: openedAt, ...(source ? { source } : {}) });
      setDone(defn.settings.confirmation?.trim() || (r.edited_object ? "Saved: the object was updated." : `Submitted: ${r.rows} entr${r.rows === 1 ? "y" : "ies"} written.`));
      setEntries({});
      setFieldErrors({});
      setTouched(false);
      onSubmitted?.(r);
    } catch (e) {
      setError((e as Error).message);
      setFieldErrors((e as Error & { errors?: Record<string, string> }).errors ?? {});
      setTouched(true);
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <div className="space-y-3 rounded-xl border border-ok/40 bg-ok/10 p-4 text-sm sm:p-6" role="status">
        <div className="flex items-start gap-2 text-ok">
          <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" /> <span className="min-w-0 break-words">{done}</span>
        </div>
        {/* the starting values are read again here: an embedded form's page refreshes them after the submission */}
        <button type="button" onClick={() => { setValues(initial); setDone(null); }} className={`${buttonClass.secondary} ${tall} max-sm:w-full`}>
          Submit another response
        </button>
      </div>
    );

  return (
    <div className="min-w-0 space-y-5">
      {!noHeader && (
        <div>
          <h1 className="break-words text-xl font-semibold">{defn.title}</h1>
          {defn.description && <p className="mt-1 break-words text-sm text-muted">{defn.description}</p>}
        </div>
      )}
      {subtitle && <p className="break-words text-xs font-medium text-soft">{subtitle}</p>}
      {progress && <Progress ev={ev} />}
      {notice && Object.keys(notice).length > 0 && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
          Some prefilled values were not used:
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {Object.entries(notice).map(([k, why]) => <li key={k} className="break-words"><span className="font-mono">{k}</span> — {why}</li>)}
          </ul>
        </div>
      )}
      {defn.sheets.map((s, i) =>
        i === 0 || !s.multiplicity ? (
          <SheetBox key={s.id} sheet={s} main={i === 0}>
            {s.fields.map((f) => (
              <FieldRow key={f.id} f={ev.fields[f.id] ?? { ...f, hidden: false, disabled: false }} value={ev.values[f.id]} set={(v) => set(f.id, v)} ev={ev} formId={formId} error={errorsShown[f.id]} embedded={embedded} />
            ))}
          </SheetBox>
        ) : (
          <MultiSheet key={s.id} sheet={s} ev={ev} values={values} instances={entries[s.id] ?? []} formId={formId} errors={errorsShown} embedded={embedded}
            onChange={(list) => setEntries((x) => ({ ...x, [s.id]: list }))} />
        ),
      )}
      <ErrorBox message={error} />
      {/* phone width: the submit bar stays at the bottom of the screen (an embedded form is as tall as its content, so it does not need to) */}
      <div className={draft || embedded ? "" : "max-sm:sticky max-sm:bottom-0 max-sm:z-10 max-sm:-mx-4 max-sm:border-t max-sm:border-line max-sm:bg-ink max-sm:px-4 max-sm:pt-3 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]"}>
        <button type="button" disabled={busy || draft} onClick={submit} className={`${buttonClass.primary} min-h-11 justify-center max-sm:w-full`} title={draft ? "Publish the form to submit responses" : undefined}>
          {busy ? "Submitting…" : (defn.settings.submit_label ?? "Submit")}
        </button>
      </div>
    </div>
  );
}

// filled in by the form or only shown: not counted by the progress bar
const NOT_FILLED = new Set(["callout", "objects_provider", "object_property_display", "calculation", "created_at", "created_by", "primary_key", "template", "user_properties"]);

/** The progress header: how many of the visible fields of the main sheet have a value. */
function Progress({ ev }: { ev: Evaluation }) {
  const ids = (ev.definition.sheets[0]?.fields ?? []).map((f) => f.id).filter((fid) => {
    const f = ev.fields[fid];
    return f && !f.hidden && !NOT_FILLED.has(f.type);
  });
  const filled = ids.filter((fid) => {
    const v = ev.values[fid];
    return !(v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0));
  }).length;
  const pct = ids.length ? Math.round((100 * filled) / ids.length) : 100;
  return (
    <div className="space-y-1" aria-label={`${filled} of ${ids.length} fields filled`}>
      <div className="h-1.5 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="h-full rounded-full bg-ocean transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[11px] text-muted">{filled} of {ids.length} fields filled</div>
    </div>
  );
}

function SheetBox({ sheet, main, children }: { sheet: FormSheet; main: boolean; children: React.ReactNode }) {
  return (
    <section className={main ? "min-w-0 space-y-4" : "min-w-0 space-y-4 rounded-xl border border-line p-3 sm:p-4"}>
      {!main && <h2 className="break-words font-semibold">{sheet.title}</h2>}
      {sheet.description && <p className="text-xs text-muted">{sheet.description}</p>}
      {/* several columns from 640 px up; one column on a phone (min-w-0: a wide field shrinks instead of widening the page) */}
      <div className={sheet.columns && sheet.columns > 1 ? "grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0" : "space-y-4"}>{children}</div>
    </section>
  );
}

/** A multiplicity subsheet: free (add instances) or parameterized (one instance per value of a shared field). */
function MultiSheet({ sheet, ev, values, instances, onChange, formId, errors, embedded }: {
  sheet: FormSheet; ev: Evaluation; values: Values; instances: Values[]; onChange: (v: Values[]) => void; formId: string; errors: Record<string, string>; embedded: boolean;
}) {
  const m = sheet.multiplicity!;
  const params = m.kind === "parameterized" && m.param_field ? (([] as unknown[]).concat(values[m.param_field] ?? []).filter((x) => x !== "" && x !== null)) : null;
  const list = params ? params.map((p, i) => ({ ...(instances[i] ?? {}), ...(m.param_target ? { [m.param_target]: p } : {}) })) : instances;
  const update = (i: number, id: string, v: unknown) => {
    const next = [...list];
    next[i] = { ...next[i], [id]: v };
    onChange(next);
  };
  return (
    <section className="min-w-0 space-y-3 rounded-xl border border-line p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="break-words font-semibold">{sheet.title}</h2>
        <span className="text-xs text-muted">{m.kind === "free" ? "one entry per instance" : `one entry per ${ev.fields[m.param_field ?? ""]?.label ?? "value"}`}</span>
        {!params && (
          <button type="button" onClick={() => onChange([...list, {}])} className={`${buttonClass.secondary} ${tall} ml-auto`}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Add entry
          </button>
        )}
      </div>
      {list.map((inst, i) => (
        <div key={i} className="space-y-3 rounded-lg border border-line-2 p-3">
          <div className="flex items-center text-xs text-muted">
            Entry {i + 1}
            {!params && (
              <button type="button" onClick={() => onChange(list.filter((_, j) => j !== i))} className={`${touch} -my-2 ml-auto`} aria-label="Remove entry">
                <Icon name="x" className="h-4 w-4" />
              </button>
            )}
          </div>
          {sheet.fields.map((f) => (
            <FieldRow key={f.id} f={{ ...(ev.fields[f.id] ?? { ...f, hidden: false, disabled: false }), disabled: f.id === m.param_target || !!ev.fields[f.id]?.disabled }}
              value={inst[f.id]} set={(v) => update(i, f.id, v)} ev={ev} formId={formId} error={errors[`${sheet.id}[${i}].${f.id}`]} embedded={embedded} />
          ))}
        </div>
      ))}
      {list.length === 0 && <p className="text-xs text-muted">{params ? "Choose values above to create entries." : "No entries yet."}</p>}
    </section>
  );
}

/** Field types with one control: the whole row is its <label>. The others hold several controls (a map, a picker,
 *  a list of choices), where a <label> would send every tap to the first control (on a phone: open the keyboard). */
const ONE_CONTROL = new Set(["text", "textarea", "numeric", "slider", "date", "url"]);

function FieldRow({ f, value, set, ev, formId, error, embedded }: { f: EffField; value: unknown; set: (v: unknown) => void; ev: Evaluation; formId: string; error?: string; embedded: boolean }) {
  if (f.hidden) return null;
  const required = (f.validators ?? []).some((v) => v.kind === "required");
  if (f.type === "callout")
    // wide Markdown (tables, code) scrolls inside the callout
    return <div className="md-body min-w-0 overflow-x-auto break-words rounded-lg border border-ocean/30 bg-ocean/5 p-3 text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(ev.callouts[f.id] ?? "") }} />;
  const Row = ONE_CONTROL.has(f.type) ? "label" : "div";
  return (
    <Row className="block min-w-0 text-sm">
      <span className="mb-1 block break-words text-xs font-medium text-soft">
        {f.label || f.id}
        {required && <span className="text-bad"> *</span>}
        {f.unit && <span className="text-muted"> ({f.unit})</span>}
      </span>
      <Input f={f} value={value} set={set} options={ev.options[f.id] ?? (f.options ?? []).map((o) => ({ value: o.value, label: o.label ?? String(o.value) }))} formId={formId} embedded={embedded} />
      {f.description && <span className="mt-0.5 block break-words text-[11px] text-muted">{f.description}</span>}
      {error && <span className="mt-0.5 block break-words text-xs text-bad" role="alert">{error}</span>}
    </Row>
  );
}

/** Map picker: click the map (or type "lat, lon"); the value is stored as "lat,lon". */
function MapPicker({ f, value, disabled, set }: { f: EffField; value: string; disabled: boolean; set: (v: unknown) => void }) {
  const [basemap, setBasemap] = useState<Basemap>("google-satellite");
  const m = /^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/.exec(value);
  const point = m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
  const start = point ?? (f.location ? { lat: f.location[0], lon: f.location[1] } : { lat: 0, lon: 110 });
  const [locating, setLocating] = useState<string | null>(null);
  const locate = () => {
    if (!navigator.geolocation) return setLocating("This browser does not give a location.");
    setLocating("Locating…");
    navigator.geolocation.getCurrentPosition(
      (p) => { set(`${p.coords.latitude.toFixed(6)},${p.coords.longitude.toFixed(6)}`); setLocating(null); },
      (e) => setLocating(e.message || "The location is not available."),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <input value={value} disabled={disabled} aria-label={`${f.label || f.id}: latitude, longitude`} placeholder={f.placeholder ?? "latitude, longitude"} onChange={(e) => set(e.target.value || null)} className={`${field} min-w-0 flex-1 basis-40`} />
        {!disabled && <button type="button" onClick={locate} className={`${buttonClass.secondary} ${tall}`}>My location</button>}
      </div>
      {locating && <p className="text-xs text-muted">{locating}</p>}
      <div className="h-64 w-full max-w-full overflow-hidden rounded border border-line sm:h-56">
        <MapCanvas basemap={basemap} onBasemap={setBasemap} initial={{ ...start, zoom: f.initial_zoom ?? (point ? 12 : 3) }}>
          {(p) => (
            <>
              <rect x={0} y={0} width={p.w} height={p.h} fill="transparent" onClick={(e) => {
                if (disabled) return;
                const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                const [lon, lat] = p.unproject(e.clientX - box.left, e.clientY - box.top);
                set(`${lat.toFixed(6)},${lon.toFixed(6)}`);
              }} style={{ cursor: disabled ? "default" : "crosshair" }} />
              {point && <circle cx={p.px(point.lon)} cy={p.py(point.lat)} r={7} className="pointer-events-none fill-rose-500 stroke-white" strokeWidth={2} />}
            </>
          )}
        </MapCanvas>
      </div>
    </div>
  );
}

/** Resource picker: a Files item (folders, datasets or anything, as the field allows). */
function ResourcePicker({ f, value, disabled, set, embedded }: { f: EffField; value: string; disabled: boolean; set: (v: unknown) => void; embedded: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const allow = f.allow ?? "any";
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className={`${readout} min-w-0 flex-1 text-sm`}><span className="truncate">{value ? name ?? value : <span className="text-muted">{f.placeholder ?? "No resource chosen"}</span>}</span></span>
        <button type="button" disabled={disabled} onClick={() => setOpen(true)} className={`${buttonClass.secondary} ${tall} shrink-0`}>Choose…</button>
        {value && !disabled && <button type="button" onClick={() => { set(null); setName(null); }} className={touch} aria-label="Clear"><Icon name="x" className="h-4 w-4" /></button>}
      </div>
      {open && (
        // The picker is a full-window dialog. An embedded form is as tall as its content, so the middle of its window
        // may be far from what the reader sees: there the dialog is held in a box under the field (a transformed box
        // is the containing block of the dialog's fixed position).
        <div className={embedded ? "relative mt-2 h-[40rem] overflow-hidden rounded-xl [transform:translateZ(0)]" : "contents"}>
          <DrivePicker
            title={allow === "folders" ? "Choose a folder" : allow === "datasets" ? "Choose a dataset" : "Choose a resource"}
            canPick={(it) => (allow === "datasets" && !(it.kind === "file" && it.name.endsWith(".parquet")) ? "Choose a dataset" : allow === "folders" ? "Choose a folder with the folder button" : null)}
            onPick={(it) => { set(it.id); setName(it.name); setOpen(false); }}
            folder={allow !== "datasets" ? { action: "Choose this folder", onPick: (fd) => { if (fd.id) { set(fd.id); setName(fd.name ?? fd.id); } setOpen(false); } } : undefined}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

function Input({ f, value, set, options, formId, embedded }: { f: EffField; value: unknown; set: (v: unknown) => void; options: { value: unknown; label: string }[]; formId: string; embedded: boolean }) {
  const dis = f.disabled;
  const str = value === null || value === undefined ? "" : String(value);
  const many = f.multiple || f.type === "checkboxes";
  switch (f.type as FormField["type"]) {
    case "textarea":
      return <textarea rows={f.rows ?? 3} value={str} disabled={dis} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} className={field} />;
    case "numeric":
      return <input type="number" inputMode="decimal" value={str} disabled={dis} placeholder={f.placeholder} step={f.step ?? "any"} onChange={(e) => set(e.target.value === "" ? null : Number(e.target.value))} className={field} />;
    case "slider":
      return (
        <div className="flex min-h-10 items-center gap-3">
          <input type="range" min={Number(f.min ?? 0)} max={Number(f.max ?? 100)} step={f.step ?? 1} value={Number(value ?? f.min ?? 0)} disabled={dis} onChange={(e) => set(Number(e.target.value))} className="h-10 min-w-0 flex-1" />
          <span className="w-14 shrink-0 text-right tabular-nums">{str}</span>
        </div>
      );
    case "date":
      return <input type="date" value={str.slice(0, 10)} disabled={dis} min={typeof f.min === "string" ? f.min : undefined} max={typeof f.max === "string" ? f.max : undefined} onChange={(e) => set(e.target.value || null)} className={field} />;
    case "url":
      return <input type="url" value={str} disabled={dis} placeholder={f.placeholder ?? "https://"} onChange={(e) => set(e.target.value)} className={field} />;
    case "radio":
      return (
        <div className={CHOICES} role="radiogroup" aria-label={f.label || f.id}>
          {options.map((o) => (
            <label key={String(o.value)} className={CHOICE}>
              <input type="radio" checked={str === String(o.value)} disabled={dis} onChange={() => set(o.value)} className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" /> <span className="min-w-0 break-words">{o.label}</span>
            </label>
          ))}
        </div>
      );
    case "checkboxes": {
      const cur = Array.isArray(value) ? value : [];
      return (
        <div className={CHOICES} role="group" aria-label={f.label || f.id}>
          {options.map((o) => (
            <label key={String(o.value)} className={CHOICE}>
              <input type="checkbox" checked={cur.includes(o.value)} disabled={dis} onChange={(e) => set(e.target.checked ? [...cur, o.value] : cur.filter((x) => x !== o.value))} className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" /> <span className="min-w-0 break-words">{o.label}</span>
            </label>
          ))}
        </div>
      );
    }
    case "dropdown":
    case "user_dropdown":
    case "object_dropdown":
    case "object_property_dropdown":
    case "dataset_value_dropdown":
      return (
        <>
          <select
            multiple={many}
            aria-label={f.label || f.id}
            value={many ? (Array.isArray(value) ? value.map(String) : []) : str}
            disabled={dis}
            onChange={(e) => {
              const pick = (s: string) => options.find((o) => String(o.value) === s)?.value ?? s;
              set(many ? [...e.target.selectedOptions].map((o) => pick(o.value)) : e.target.value === "" ? null : pick(e.target.value));
            }}
            className={`${field} max-w-full`}
          >
            {!many && <option value="">{f.placeholder ?? "Choose…"}</option>}
            {options.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
          {f.allow_other && !many && <input value={options.some((o) => String(o.value) === str) ? "" : str} onChange={(e) => set(e.target.value)} placeholder="Other value" aria-label="Other value" className={`${field} mt-1`} />}
        </>
      );
    case "objects_provider":
      return (
        <div className="max-h-40 overflow-y-auto rounded border border-line p-2 text-xs">
          {options.map((o) => (
            <div key={String(o.value)} className="break-words py-0.5">{o.label}</div>
          ))}
          {!options.length && <span className="text-muted">No objects.</span>}
        </div>
      );
    case "object_property_display":
      return <div className={`${readout} break-words text-sm`}>{options.map((o) => String(o.value ?? o.label)).join(", ") || "—"}</div>;
    case "user_properties":
      return <div className={`${readout} break-words text-sm`}>{options.map((o) => (o.value === null || o.value === undefined ? o.label : String(o.value))).join(", ") || "—"}</div>;
    case "map_picker":
      return <MapPicker f={f} value={str} disabled={!!dis} set={set} />;
    case "resource_picker":
      return <ResourcePicker f={f} value={str} disabled={!!dis} set={set} embedded={embedded} />;
    case "calculation":
    case "created_at":
    case "created_by":
    case "primary_key":
    case "template":
      return <div className={`${readout} break-all font-mono text-xs text-soft`}>{str || "—"}</div>;
    case "attachments": {
      const ids = Array.isArray(value) ? (value as { id: string; name: string }[]) : [];
      return (
        <div className="min-w-0 space-y-1 text-xs">
          {ids.map((a) => (
            <div key={a.id} className="flex min-w-0 items-center gap-2">
              <Icon name="doc" className="h-3.5 w-3.5 shrink-0" /> <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <button type="button" onClick={() => set(ids.filter((x) => x.id !== a.id))} className={touch} aria-label={`Remove ${a.name}`}>
                <Icon name="x" className="h-4 w-4" />
              </button>
            </div>
          ))}
          <input
            type="file"
            disabled={dis}
            aria-label={f.label || f.id}
            className="block w-full max-w-full text-xs text-muted file:mr-3 file:min-h-10 file:rounded-md file:border file:border-solid file:border-line-2 file:bg-panel-2 file:px-3 file:text-sm file:text-soft"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = async () => {
                const saved = await forms.attach(formId, file.name, String(reader.result).split(",")[1] ?? "", f.folder_id);
                set([...ids, saved]);
              };
              reader.readAsDataURL(file);
            }}
          />
        </div>
      );
    }
    default:
      return <input value={str} disabled={dis} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} className={field} />;
  }
}
