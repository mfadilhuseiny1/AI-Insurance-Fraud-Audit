"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { LogicEditor, type Range } from "@/components/timeseries/LogicEditor";
import { SavingForm } from "@/components/timeseries/SavingForm";
import { DEFAULT_SAVING, DERIVED_CARDS, tsOntology, type DerivedSaving, type Logic, type ObjRef, type TsObjectType } from "@/lib/timeseries";

export default function NewDerivedPage() {
  return (
    <Suspense>
      <NewDerived />
    </Suspense>
  );
}

/** + New derived series: the type, the logic (Set as output), then Save: Ontology options, resource, review. */
function NewDerived() {
  const router = useRouter();
  const params = useSearchParams();
  const [type, setType] = useState<"templated" | "single" | null>(params.get("root") ? "templated" : null);
  const [types, setTypes] = useState<TsObjectType[]>([]);
  const [rootTypeId, setRootTypeId] = useState(params.get("root") ?? "");
  const [root, setRoot] = useState<ObjRef | null>(() => (params.get("root") && params.get("pk") ? { object_type_id: params.get("root")!, primary_key: params.get("pk")! } : null));
  const [logic, setLogic] = useState<Logic>(() => {
    try {
      const pre = params.get("logic");
      if (pre) return JSON.parse(pre) as Logic;
    } catch {}
    return { cards: [], output: null };
  });
  const [range, setRange] = useState<Range>({ last: "7d" });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    tsOntology.objectTypes().then(setTypes, () => setTypes([]));
  }, []);
  const roots = types.filter((t) => !t.is_sensor || t.sensor_types.length);
  return (
    <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-4 p-8">
        <Link href="/time-series?tab=derived" className="inline-flex items-center gap-1 text-xs text-muted hover:text-white">
          <Icon name="left" className="h-3 w-3" /> Derived series
        </Link>
        <div className="flex items-center gap-2">
          <h1 className="flex flex-1 items-center gap-2 text-xl font-semibold">
            <Icon name="layers" className="h-5 w-5 text-ocean" /> New derived series
          </h1>
          {type && (
            <button type="button" disabled={!logic.output} onClick={() => setSaving(true)} className={buttonClass.primary}>
              <Icon name="save" className="h-4 w-4" /> Save
            </button>
          )}
        </div>
        {!type ? (
          <div className="grid gap-3 md:grid-cols-2">
            {(
              [
                ["templated", "Templated derived series", "Logic written against one root object, then available for every object of its type — e.g. a rolling average temperature on every Machine."],
                ["single", "Single derived series", "Logic over any objects you name — not tied to one root object."],
              ] as const
            ).map(([k, label, hint]) => (
              <button key={k} type="button" onClick={() => setType(k)} className="rounded-xl border border-line bg-panel p-5 text-left hover:border-ocean/50">
                <div className="mb-1 font-semibold">{label}</div>
                <div className="text-sm text-muted">{hint}</div>
              </button>
            ))}
          </div>
        ) : (
          <>
            {type === "templated" && (
              <Field label="Root object type">
                <select
                  value={rootTypeId}
                  onChange={(e) => {
                    setRootTypeId(e.target.value);
                    setRoot(null);
                    setLogic({ cards: [], output: null });
                  }}
                  className={`${inputClass} max-w-md`}
                >
                  <option value="">Pick a time series object type…</option>
                  {roots.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.display_name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {(type === "single" || rootTypeId) && (
              <LogicEditor
                logic={logic}
                onChange={setLogic}
                mode={type}
                rootTypeId={type === "templated" ? rootTypeId : null}
                root={type === "templated" ? root : null}
                onRoot={setRoot}
                range={range}
                onRange={setRange}
                resource="catalog"
                allowed={DERIVED_CARDS}
              />
            )}
            {!logic.output && logic.cards.length > 0 && <p className="text-xs text-muted">Choose “Set as output” on the card the derived series returns.</p>}
          </>
        )}
      </div>
      {saving && type && (
        <SaveDialog
          type={type}
          rootTypeId={type === "templated" ? rootTypeId : null}
          types={types}
          logic={logic}
          onClose={() => setSaving(false)}
          onSaved={(id) => router.push(`/time-series/derived/${id}`)}
        />
      )}
    </div>
  );
}

function SaveDialog({ type, rootTypeId, types, logic, onClose, onSaved }: { type: "templated" | "single"; rootTypeId: string | null; types: TsObjectType[]; logic: Logic; onClose: () => void; onSaved: (id: string) => void }) {
  const [step, setStep] = useState(0);
  const candidates = type === "templated" ? types.filter((t) => t.id === rootTypeId || t.root_object_types.includes(rootTypeId ?? "")) : types;
  const [bound, setBound] = useState(candidates[0]?.id ?? "");
  const [saving, setSaving] = useState<DerivedSaving>(DEFAULT_SAVING);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [folder, setFolder] = useState("");
  const [versionText, setVersionText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const boundInfo = types.find((t) => t.id === bound) ?? null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await tsOntology.createDerived({ name, description, type, root_object_type_id: rootTypeId, bound_object_type_id: bound, logic, saving, folder, version_description: versionText });
      if (saving.mode === "automatic") await tsOntology.deploy(d.id).catch(() => null);
      onSaved(d.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Save derived series" icon="layers" onClose={onClose} wide>
      <div className="flex gap-1 border-b border-line px-4 py-2 text-xs">
        {["Nexus", "Resource file", "Review"].map((l, i) => (
          <button key={l} type="button" onClick={() => setStep(i)} className={`rounded-md px-2 py-1 ${step === i ? "bg-ocean/15 text-white" : "text-muted"}`}>
            {i + 1}. {l}
          </button>
        ))}
      </div>
      <div className="space-y-4 p-4 text-sm">
        {step === 0 && (
          <>
            <Field label="Bound object type" hint="The only object type the derived series resolves from; it cannot change after saving">
              <select value={bound} onChange={(e) => (setBound(e.target.value), setSaving(DEFAULT_SAVING))} className={inputClass}>
                {candidates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.display_name}
                    {t.is_sensor ? " (sensor object type)" : t.id === rootTypeId ? " (root object type)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <SavingForm saving={saving} onChange={setSaving} bound={boundInfo} rootTypeId={rootTypeId} type={type} />
          </>
        )}
        {step === 1 && (
          <>
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="Delta pressure" />
            </Field>
            <Field label="Description">
              <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
            </Field>
            <Field label="Folder" hint="Where the resource is listed (optional)">
              <input value={folder} onChange={(e) => setFolder(e.target.value)} className={inputClass} placeholder="My Project / Derived series" />
            </Field>
          </>
        )}
        {step === 2 && (
          <>
            <ul className="space-y-1 text-xs text-soft">
              <li>
                {type === "templated" ? "Templated" : "Single"} derived series · {logic.cards.length} cards · output ${logic.output}
              </li>
              <li>Bound to {boundInfo?.display_name}</li>
              <li>
                Nexus saving: {saving.mode}
                {saving.mode === "automatic" ? ` — sensor “${saving.sensor_name}”, scope ${saving.scope.kind}; objects are created on save` : " — add its template RID to a time series property"}
              </li>
            </ul>
            <Field label="Version description (optional)">
              <input value={versionText} onChange={(e) => setVersionText(e.target.value)} className={inputClass} />
            </Field>
          </>
        )}
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          {step < 2 ? (
            <button type="button" onClick={() => setStep(step + 1)} disabled={step === 1 && !name.trim()} className={buttonClass.primary}>
              Next
            </button>
          ) : (
            <button type="button" onClick={save} disabled={busy || !name.trim() || !bound} className={buttonClass.primary}>
              {busy ? "Saving…" : "Save derived series"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
