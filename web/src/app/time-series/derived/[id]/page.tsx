"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { LogicEditor, type Range } from "@/components/timeseries/LogicEditor";
import { SavingForm } from "@/components/timeseries/SavingForm";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { DERIVED_CARDS, tsOntology, type DerivedSaving, type DerivedSeries, type Logic, type ObjRef, type OntologyStatus, type TsObjectType } from "@/lib/timeseries";

type Tab = "overview" | "logic" | "ontology";

/** The derived series management page: Overview, Logic (saving a change makes a new version) and Ontology. */
export default function DerivedPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [d, setD] = useState<DerivedSeries | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const [types, setTypes] = useState<TsObjectType[]>([]);
  const [favorite, setFavorite] = useState(false);
  const load = useCallback(() => tsOntology.derived(id).then(setD, (e: Error) => setError(e.message)), [id]);
  useEffect(() => {
    load();
    tsOntology.objectTypes().then(setTypes, () => setTypes([]));
    tsOntology.viewed("derived", id);
    tsOntology.home().then((h) => setFavorite(h.favorites.some((f) => f.kind === "derived" && f.id === id)), () => {});
  }, [id, load]);
  if (error && !d) return <ApiError message={error} />;
  if (!d) return <Loading />;
  const remove = async () => {
    const left = d.saving.mode === "automatic" ? " Objects it saved to the Nexus are not deleted: use Delete from Nexus first." : "";
    if (!(await confirmDialog({ message: `Delete the derived series ${d.name}?${left}`, danger: true }))) return;
    await tsOntology.deleteDerived(d.id);
    router.push("/time-series?tab=derived");
  };
  return (
    <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl p-8">
        <Link href="/time-series?tab=derived" className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-white">
          <Icon name="left" className="h-3 w-3" /> Derived series
        </Link>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h1 className="flex flex-1 items-center gap-2 text-xl font-semibold">
            <Icon name="layers" className="h-5 w-5 text-ocean" /> {d.name}
            <span className="rounded bg-panel-2 px-1.5 text-xs font-normal capitalize text-muted">{d.type}</span>
            <span className="font-mono text-xs font-normal text-muted">v{d.version}</span>
          </h1>
          <button type="button" onClick={async () => (await tsOntology.favorite("derived", d.id, !favorite), setFavorite(!favorite))} className={`${buttonClass.secondary} ${favorite ? "text-sand" : ""}`} title="Favorite">
            <Icon name="star" className="h-4 w-4" />
          </button>
          <button type="button" onClick={remove} className={buttonClass.secondary} aria-label="Delete">
            <Icon name="trash" className="h-4 w-4" />
          </button>
        </div>
        <div className="mb-5 flex gap-1 border-b border-line">
          {(["overview", "logic", "ontology"] as Tab[]).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm capitalize ${tab === t ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>
              {t}
            </button>
          ))}
        </div>
        {tab === "overview" && <Overview d={d} onSaved={setD} />}
        {tab === "logic" && <LogicTab d={d} onSaved={setD} />}
        {tab === "ontology" && <OntologyTab d={d} types={types} onSaved={setD} />}
      </div>
    </div>
  );
}

function Overview({ d, onSaved }: { d: DerivedSeries; onSaved: (d: DerivedSeries) => void }) {
  const [name, setName] = useState(d.name);
  const [description, setDescription] = useState(d.description);
  const [root, setRoot] = useState<ObjRef | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = name !== d.name || description !== d.description;
  const pinned = JSON.stringify({ templateRid: d.template_rid, templateVersion: d.version });
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        <div className="space-y-3 rounded-xl border border-line bg-panel p-4">
          <Field label="Title">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Description">
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inputClass} />
          </Field>
          <ErrorBox message={error} />
          <button
            type="button"
            disabled={!dirty}
            onClick={async () => {
              try {
                onSaved(await tsOntology.updateDerived(d.id, { name, description }));
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            Save
          </button>
        </div>
        <div className="rounded-xl border border-line bg-panel p-4">
          <div className="mb-2 text-sm font-semibold">Preview</div>
          <LogicEditor
            logic={d.logic ?? { cards: [] }}
            onChange={() => {}}
            mode={d.type === "templated" ? "templated" : "single"}
            rootTypeId={d.root_object_type_id}
            root={root}
            onRoot={setRoot}
            range={{ last: "7d" }}
            resource={`derived:${d.id}`}
            readOnly
          />
          <p className="mt-2 text-xs text-muted">Read only; edit in the Logic tab.</p>
        </div>
      </div>
      <aside className="space-y-3 rounded-xl border border-line bg-panel p-4 text-sm">
        <div className="font-semibold">Derived series details</div>
        <Detail label="Logic RID (codex template)" value={d.template_rid} mono copy />
        <Detail label="Pinned to this version" value={pinned} mono copy />
        <Detail label="Derived series RID" value={d.rid} mono copy />
        <Detail label="Bound object type" value={d.bound_object_type ?? d.bound_object_type_id} />
        {d.root_object_type && <Detail label="Root object type" value={d.root_object_type} />}
        <Detail label="Nexus saving" value={d.saving.mode} />
        <Detail label="Created" value={when(d.created_at)} />
        <div>
          <div className="mb-1 text-xs text-muted">Versions</div>
          {(d.versions ?? [])
            .slice()
            .reverse()
            .map((v) => (
              <div key={v.version} className="flex gap-2 text-xs">
                <span className="font-mono">{v.version}</span>
                <span className="truncate text-muted">{v.description || "—"}</span>
                <span className="ml-auto text-muted">{when(v.at)}</span>
              </div>
            ))}
        </div>
        <p className="text-[11px] text-muted">
          A time series property whose value is the logic RID follows the latest logic; the pinned value keeps this version. Derived series used in Quiver, Workshop and other derived series
          recalculate when read.
        </p>
      </aside>
    </div>
  );
}

function Detail({ label, value, mono, copy }: { label: string; value: string; mono?: boolean; copy?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="flex items-start gap-1">
        <span className={`min-w-0 break-all ${mono ? "font-mono text-[11px]" : "capitalize"}`}>{value}</span>
        {copy && (
          <button type="button" onClick={() => navigator.clipboard?.writeText(value)} className="shrink-0 rounded p-0.5 text-muted hover:text-white" aria-label="Copy">
            <Icon name="copy" className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

function LogicTab({ d, onSaved }: { d: DerivedSeries; onSaved: (d: DerivedSeries) => void }) {
  const [logic, setLogic] = useState<Logic>(d.logic ?? { cards: [] });
  const [root, setRoot] = useState<ObjRef | null>(null);
  const [range, setRange] = useState<Range>({ last: "7d" });
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(logic) !== JSON.stringify(d.logic);
  const save = async () => {
    const text = await promptDialog("Describe this version (optional)", "", { title: "Save a new version" });
    if (text === null) return;
    try {
      const next = await tsOntology.updateDerived(d.id, { logic, version_description: text });
      onSaved(next);
      setLogic(next.logic ?? logic);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-xs text-muted">
          Saving makes version 0.0.{(d.versions?.length ?? 0) + 1}. Manually saved time series properties that use the logic RID follow it at once; automatically saved objects pin a version: deploy from the
          Nexus tab.
        </p>
        <button type="button" disabled={!dirty} onClick={() => setLogic(d.logic ?? { cards: [] })} className={buttonClass.secondary}>
          Discard
        </button>
        <button type="button" disabled={!dirty} onClick={save} className={buttonClass.primary}>
          <Icon name="save" className="h-4 w-4" /> Save
        </button>
      </div>
      <ErrorBox message={error} />
      <LogicEditor
        logic={logic}
        onChange={setLogic}
        mode={d.type === "templated" ? "templated" : "single"}
        rootTypeId={d.root_object_type_id}
        root={root}
        onRoot={setRoot}
        range={range}
        onRange={setRange}
        resource={`derived:${d.id}`}
        allowed={DERIVED_CARDS}
      />
    </div>
  );
}

function OntologyTab({ d, types, onSaved }: { d: DerivedSeries; types: TsObjectType[]; onSaved: (d: DerivedSeries) => void }) {
  const [saving, setSaving] = useState<DerivedSaving>(d.saving);
  const [status, setStatus] = useState<OntologyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadStatus = useCallback(() => tsOntology.ontologyStatus(d.id).then(setStatus, (e: Error) => setError(e.message)), [d.id]);
  useEffect(() => {
    loadStatus();
  }, [loadStatus, d.updated_at]);
  const bound = types.find((t) => t.id === d.bound_object_type_id) ?? null;
  const dirty = JSON.stringify(saving) !== JSON.stringify(d.saving);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await loadStatus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-3 rounded-xl border border-line bg-panel p-4">
        <div className="text-sm">
          Bound object type: <span className="font-medium">{bound?.display_name ?? d.bound_object_type_id}</span> <span className="text-xs text-muted">(cannot change)</span>
        </div>
        <SavingForm saving={saving} onChange={setSaving} bound={bound} rootTypeId={d.root_object_type_id} type={d.type} />
        <ErrorBox message={error} />
        <div className="flex justify-end">
          <button type="button" disabled={!dirty || busy} onClick={() => run(async () => onSaved(await tsOntology.saveDerivedOntology(d.id, saving)))} className={buttonClass.primary}>
            <Icon name="save" className="h-4 w-4" /> Save
          </button>
        </div>
      </div>
      <aside className="space-y-3 rounded-xl border border-line bg-panel p-4 text-sm">
        <div className="font-semibold">Nexus status</div>
        {!status ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : status.mode === "manual" ? (
          <>
            <p className="text-xs text-muted">Manual saving: put one of these in a time series property of {bound?.display_name} (a root object type&apos;s column, or one sensor object per root object). Even then the property still lists a sync of the right type as its data source.</p>
            <Detail label="Latest logic" value={status.template_rid} mono copy />
            <Detail label="Pinned version" value={status.pinned_value} mono copy />
            <div className="text-xs text-muted">{status.objects} objects reference it now.</div>
          </>
        ) : (
          <>
            <div className={`flex items-center gap-1.5 ${status.up_to_date ? "text-ok" : "text-warn"}`}>
              <Icon name={status.up_to_date ? "check" : "alert"} className="h-4 w-4" />
              {status.up_to_date ? `Up to date: ${status.in_ontology} objects on v${status.version}` : "Out of date: deploy to update the Nexus"}
            </div>
            <div className="text-xs text-muted">
              Expected {status.expected} · in the Nexus {status.in_ontology} · to create {status.counts.create} · to modify {status.counts.modify} · to delete {status.counts.delete}
            </div>
            {status.deployed && <div className="text-xs text-muted">Last deployed v{status.deployed.version} {when(status.deployed.at)}</div>}
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy || status.up_to_date || dirty} onClick={() => run(() => tsOntology.deploy(d.id))} className={buttonClass.primary}>
                <Icon name="play" className="h-3.5 w-3.5" /> Deploy
              </button>
              <button
                type="button"
                disabled={busy || !status.in_ontology}
                onClick={async () => {
                  if (await confirmDialog({ message: `Delete the ${status.in_ontology} sensor objects of ${d.name} from the Nexus?`, danger: true })) run(() => tsOntology.deleteFromOntology(d.id));
                }}
                className={buttonClass.secondary}
              >
                <Icon name="trash" className="h-3.5 w-3.5" /> Delete from Nexus
              </button>
            </div>
            {dirty && <p className="text-[11px] text-muted">Save the options before deploying.</p>}
          </>
        )}
      </aside>
    </div>
  );
}
