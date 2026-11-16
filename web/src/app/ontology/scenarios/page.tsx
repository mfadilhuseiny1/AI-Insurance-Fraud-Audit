"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { ActionForm } from "@/components/ontology/ActionForm";
import { AppHeader, Badge, Card, ErrorBox, ValueCell } from "@/components/ontology/parts";
import { buttonClass, fieldClass, Modal } from "@/components/pipeline/Modal";
import { ApiError } from "@/components/States";
import { alertDialog, confirmDialog, promptDialog } from "@/lib/dialogs";
import { ontology, type ActionType, type ObjectType, type OntologyObject } from "@/lib/ontology";
import { om, type LinkType, type SearchResult } from "@/lib/ontologyModel";
import { scenarios, type Comparison, type Scenario, type ScenarioDetail } from "@/lib/scenarios";

type Tab = "objects" | "edits" | "compare" | "activity";
const STATUS_LABEL: Record<string, string> = { draft: "Draft", in_review: "In review", approved: "Approved", rejected: "Rejected", merged: "Merged" };
const STATUS_BADGE: Record<string, string> = { draft: "experimental", in_review: "in_review", approved: "active", rejected: "deprecated", merged: "promoted" };

const until = (iso: string) => {
  const ms = new Date(iso).getTime() - Date.now();
  const days = Math.floor(ms / 86_400_000);
  return days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : `${Math.max(0, Math.floor(ms / 3_600_000))} h`;
};

/**
 * Ontology scenarios: what-if sandboxes. Actions applied in a scenario change only the scenario; its objects are main
 * with the scenario's edits on top. Compare aggregations across scenarios, review persisted ones, and merge through
 * an action type with an Apply scenario rule.
 */
export default function OntologyScenariosPage() {
  const [list, setList] = useState<Scenario[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ScenarioDetail | null>(null);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [links, setLinks] = useState<LinkType[]>([]);
  const [allActions, setAllActions] = useState<ActionType[]>([]);
  const [tab, setTab] = useState<Tab>("objects");
  const [creating, setCreating] = useState(false);
  const [merging, setMerging] = useState(false);

  const reload = useCallback(() => scenarios.list().then(setList, (e: Error) => setError(e.message)), []);
  const reloadDetail = useCallback(() => {
    if (!selected) return Promise.resolve();
    return scenarios.get(selected).then(setDetail, (e: Error) => setError(e.message));
  }, [selected]);

  useEffect(() => {
    void reload();
    Promise.all([ontology.objectTypes(), om.linkTypes(), ontology.actionTypes()]).then(
      ([t, l, a]) => {
        setTypes(t);
        setLinks(l);
        setAllActions(a);
      },
      () => undefined,
    );
  }, [reload]);
  useEffect(() => {
    void reloadDetail();
  }, [reloadDetail]);

  const refresh = async () => {
    await Promise.all([reload(), reloadDetail()]);
  };

  if (error && !list) return <ApiError message={error} />;
  const sc = detail && detail.id === selected ? detail : null;
  const merged = !!sc?.merged;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Nexus Scenarios" icon="split" href="/ontology/scenarios" crumbs={sc ? [{ label: sc.name }] : []}>
        <Badge status="experimental" label="Beta" />
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New scenario
        </button>
      </AppHeader>
      <div className="flex min-h-0 flex-1">
        <nav className="w-72 shrink-0 overflow-y-auto border-r border-line bg-panel p-2 text-sm">
          {(["Persisted", "Temporary"] as const).map((group) => {
            const rows = (list ?? []).filter((s) => s.persisted === (group === "Persisted"));
            return (
              <div key={group} className="mb-3">
                <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{group}</div>
                {rows.length === 0 && <div className="px-2 py-1 text-xs text-muted">None</div>}
                {rows.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSelected(s.id)}
                    className={`mb-0.5 flex w-full flex-col rounded-md px-2 py-1.5 text-left ${selected === s.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}
                  >
                    <span className="flex w-full items-center gap-2">
                      <Icon name="split" className="h-3.5 w-3.5 shrink-0 text-ocean" />
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      {(s.rebase?.conflicts.length ?? 0) > 0 && <Icon name="alert" className="h-3.5 w-3.5 text-warn" />}
                    </span>
                    <span className="pl-5.5 text-[11px] text-muted">
                      {s.object_edits + s.link_edits} edits · {s.merged ? "merged" : `expires in ${until(s.expires_at)}`}
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
          {!sc ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted">
              <Icon name="split" className="h-8 w-8 text-ocean" />
              <div className="text-base font-semibold text-white">What-if analysis in a sandbox</div>
              <p className="max-w-lg">
                Create a scenario, apply actions in it without changing live data, compare outcomes with main and other scenarios, then merge approved
                edits through an action type with an Apply scenario rule. Scenarios are not snapshots of the past: they always sit on the latest main.
              </p>
            </div>
          ) : (
            <div className="mx-auto max-w-7xl space-y-4 p-5">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h1 className="flex items-center gap-2 text-xl font-semibold">
                    {sc.name}
                    <Badge status={STATUS_BADGE[sc.status] ?? "experimental"} label={STATUS_LABEL[sc.status] ?? sc.status} />
                  </h1>
                  <div className="mt-1 text-xs text-muted">
                    {sc.description || "No description"} · by {sc.created_by} · <span className="font-mono">{sc.rid}</span>
                  </div>
                </div>
                {!merged && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        const name = await promptDialog("Scenario name", sc.name, { title: "Rename scenario" });
                        if (name) await scenarios.update(sc.id, { name }).then(refresh, (e: Error) => alertDialog(e.message));
                      }}
                      className={buttonClass.secondary}
                    >
                      <Icon name="pencil" className="h-3.5 w-3.5" /> Rename
                    </button>
                    {!sc.persisted && (
                      <button type="button" onClick={() => scenarios.update(sc.id, { persisted: true }).then(refresh, (e: Error) => alertDialog(e.message))} className={buttonClass.secondary}>
                        <Icon name="save" className="h-3.5 w-3.5" /> Persist
                      </button>
                    )}
                    {sc.persisted && (
                      <select
                        aria-label="Review status"
                        value={sc.status}
                        onChange={(e) => scenarios.update(sc.id, { status: e.target.value as "draft" }).then(refresh, (err: Error) => alertDialog(err.message))}
                        className={fieldClass}
                      >
                        {["draft", "in_review", "approved", "rejected"].map((s) => (
                          <option key={s} value={s}>
                            {STATUS_LABEL[s]}
                          </option>
                        ))}
                      </select>
                    )}
                    <button type="button" onClick={() => scenarios.rebase(sc.id).then(refresh, (e: Error) => alertDialog(e.message))} className={buttonClass.secondary}>
                      <Icon name="refresh" className="h-3.5 w-3.5" /> Rebase
                    </button>
                    <button type="button" onClick={() => setMerging(true)} disabled={sc.object_edits + sc.link_edits === 0} className={buttonClass.primary}>
                      <Icon name="check" className="h-3.5 w-3.5" /> Merge…
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    if (!(await confirmDialog({ message: `Delete ${sc.name} and its edits?`, danger: true, confirmLabel: "Delete" }))) return;
                    await scenarios.remove(sc.id);
                    setSelected(null);
                    await reload();
                  }}
                  className={buttonClass.ghost}
                  aria-label="Delete scenario"
                >
                  <Icon name="trash" className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-4">
                {[
                  ["Object edits", String(sc.object_edits)],
                  ["Link edits", String(sc.link_edits)],
                  ["Last rebase", sc.rebase ? new Date(sc.rebase.at).toLocaleTimeString() : "—"],
                  [merged ? "Merged" : "Time to live", merged ? new Date(sc.merged!.at).toLocaleString() : until(sc.expires_at)],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-line bg-panel px-3 py-2">
                    <div className="text-[11px] text-muted">{k}</div>
                    <div className="text-sm font-semibold">{v}</div>
                  </div>
                ))}
              </div>
              {(sc.rebase?.conflicts.length ?? 0) > 0 && (
                <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                  {sc.rebase!.conflicts.length} conflict{sc.rebase!.conflicts.length === 1 ? "" : "s"} with main:{" "}
                  {sc.rebase!.conflicts.map((c) => `${c.primary_key} (${c.reason})`).join("; ")}. Discard those edits before merging.
                </div>
              )}

              <div className="flex gap-1 border-b border-line">
                {(["objects", "edits", "compare", "activity"] as Tab[]).map((t) => (
                  <button key={t} type="button" onClick={() => setTab(t)} className={`px-3 py-2 text-xs capitalize ${tab === t ? "border-b-2 border-ocean text-white" : "text-muted hover:text-white"}`}>
                    {t === "edits" ? `Edits (${sc.object_edits + sc.link_edits})` : t}
                  </button>
                ))}
              </div>

              {tab === "objects" && <ScenarioObjects sc={sc} types={types} onChanged={refresh} />}
              {tab === "edits" && <ScenarioEdits sc={sc} onChanged={refresh} />}
              {tab === "compare" && <CompareView list={list ?? []} types={types} current={sc.id} />}
              {tab === "activity" && (
                <Card title="Activity" count={sc.activity.length}>
                  <div className="divide-y divide-line text-xs">
                    {sc.activity.length === 0 && <div className="p-4 text-muted">No actions applied yet.</div>}
                    {sc.activity.map((a, i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                        <span className="h-2 w-2 rounded-full bg-ocean" />
                        <span className="flex-1">
                          <span className="font-medium">{a.label}</span>
                          <span className="ml-2 text-muted">
                            {a.edited.length} object{a.edited.length === 1 ? "" : "s"}
                            {a.links ? `, ${a.links} links` : ""} · {a.user}
                          </span>
                        </span>
                        <span className="text-muted">{new Date(a.at).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          )}
        </main>
      </div>
      {creating && (
        <NewScenario
          onClose={() => setCreating(false)}
          onCreated={async (s) => {
            setCreating(false);
            await reload();
            setSelected(s.id);
          }}
        />
      )}
      {merging && sc && (
        <MergeDialog
          sc={sc}
          types={types}
          links={links}
          actions={allActions}
          onClose={() => setMerging(false)}
          onActions={setAllActions}
          onMerged={async () => {
            setMerging(false);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function NewScenario({ onClose, onCreated }: { onClose: () => void; onCreated: (s: Scenario) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [persisted, setPersisted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="New scenario" icon="split" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Increase spare parts" className={`${fieldClass} w-full`} autoFocus />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this scenario explore?" rows={3} className={`${fieldClass} w-full`} />
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={persisted} onChange={(e) => setPersisted(e.target.checked)} className="mt-0.5" />
          <span>
            <span className="font-medium">Persist the scenario</span>
            <span className="block text-muted">Shared with others, with a review status. Temporary scenarios are yours and end after a day without use. Every scenario is deleted 30 days after it was created.</span>
          </span>
        </label>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" onClick={() => scenarios.create({ name, description, persisted }).then(onCreated, (e: Error) => setError(e.message))} className={buttonClass.primary}>
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ScenarioObjects({ sc, types, onChanged }: { sc: ScenarioDetail; types: ObjectType[]; onChanged: () => Promise<void> }) {
  const edited = useMemo(() => new Set(sc.edits.map((e) => `${e.object_type_id}|${e.primary_key}`)), [sc.edits]);
  const [picked, setTypeId] = useState("");
  const typeId = picked || sc.edits[0]?.object_type_id || types[0]?.id || "";
  const [q, setQ] = useState("");
  const [res, setRes] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actions, setActions] = useState<ActionType[]>([]);
  const [applying, setApplying] = useState<{ action: ActionType; object?: OntologyObject } | null>(null);
  const [tick, setTick] = useState(0);
  const type = types.find((t) => t.id === typeId);

  useEffect(() => {
    if (!typeId) return;
    ontology.actionTypes(typeId).then((a) => setActions(a.filter((x) => !(x.rules ?? []).some((r) => r.kind === "apply_scenario"))), () => setActions([]));
  }, [typeId]);
  useEffect(() => {
    if (!typeId) return;
    const t = setTimeout(
      () =>
        scenarios.search(sc.id, { object_type_id: typeId, q, limit: 200, histograms: false, resource: "ontology-scenarios" }).then(
          (r) => {
            setRes(r);
            setError(null);
          },
          (e: Error) => setError(e.message),
        ),
      200,
    );
    return () => clearTimeout(t);
  }, [sc.id, typeId, q, tick, sc.updated_at]);

  const merged = !!sc.merged;
  const cols = (type?.properties ?? []).filter((p) => p.visibility !== "hidden" && p.type !== "vector").slice(0, 8);
  const objectActions = actions.filter((a) => a.kind !== "create");
  return (
    <Card
      title="Objects in this scenario"
      count={res?.total}
      action={
        <div className="flex items-center gap-2">
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={fieldClass} aria-label="Object type">
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.display_name}
              </option>
            ))}
          </select>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className={`${fieldClass} w-40`} />
          {!merged &&
            actions
              .filter((a) => a.kind === "create" || (a.kind === "rules" && !(a.parameters ?? []).some((p) => p.type === "object")))
              .slice(0, 2)
              .map((a) => (
                <button key={a.id} type="button" onClick={() => setApplying({ action: a })} className={buttonClass.secondary}>
                  <Icon name="plus" className="h-3.5 w-3.5" /> {a.display_name}
                </button>
              ))}
        </div>
      }
    >
      <ErrorBox message={error} />
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-panel-2 text-left text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Title</th>
              {cols.map((p) => (
                <th key={p.api_name} className="whitespace-nowrap px-3 py-2 font-medium">
                  {p.display_name}
                </th>
              ))}
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {(res?.objects ?? []).map((o) => {
              const isEdited = edited.has(`${o.object_type_id}|${o.primary_key}`);
              const ed = sc.edits.find((e) => e.object_type_id === o.object_type_id && e.primary_key === o.primary_key);
              return (
                <tr key={o.primary_key} className={isEdited ? "bg-ocean/5" : "hover:bg-panel-2"}>
                  <td className="px-3 py-2">
                    {isEdited && <span className="mr-1.5 rounded bg-ocean/20 px-1 text-[10px] text-ocean">{ed?.op === "create" ? "new" : "edited"}</span>}
                    {o.title}
                  </td>
                  {cols.map((p) => (
                    <td key={p.api_name} className={`max-w-48 truncate px-3 py-2 ${ed?.changed.includes(p.api_name) ? "font-semibold text-ocean" : ""}`}>
                      <ValueCell type={p.type} value={o.properties[p.api_name]} />
                    </td>
                  ))}
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {!merged && objectActions.length > 0 && (
                      <select
                        value=""
                        onChange={(e) => {
                          const a = objectActions.find((x) => x.id === e.target.value);
                          if (a) setApplying({ action: a, object: o });
                        }}
                        className={fieldClass}
                        aria-label="Apply an action"
                      >
                        <option value="">Actions…</option>
                        {objectActions.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.display_name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {applying && type && (
        <ActionForm
          action={applying.action}
          objectType={type}
          object={applying.object}
          scenarioId={sc.id}
          onClose={() => setApplying(null)}
          onDone={async () => {
            setApplying(null);
            setTick((x) => x + 1);
            await onChanged();
          }}
        />
      )}
    </Card>
  );
}

function ScenarioEdits({ sc, onChanged }: { sc: ScenarioDetail; onChanged: () => Promise<void> }) {
  const discard = async (body: Parameters<typeof scenarios.discard>[1]) => {
    try {
      await scenarios.discard(sc.id, body);
      await onChanged();
    } catch (e) {
      void alertDialog((e as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      <Card title="Object edits" count={sc.edits.length}>
        <div className="divide-y divide-line text-xs">
          {sc.edits.length === 0 && <div className="p-4 text-muted">No object edits. Apply actions in the Objects tab.</div>}
          {sc.edits.map((e) => (
            <div key={`${e.object_type_id}|${e.primary_key}`} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${e.op === "delete" ? "bg-bad/15 text-bad" : e.op === "create" ? "bg-ok/15 text-ok" : "bg-ocean/15 text-ocean"}`}>{e.op}</span>
                <span className="font-medium">{e.title}</span>
                <span className="text-muted">
                  {e.object_type} · {e.primary_key}
                </span>
                {e.conflict && <span className="text-warn">⚠ {e.conflict}</span>}
                <Link href={`/ontology/objects/${e.object_type_id}/${encodeURIComponent(e.primary_key)}`} className="ml-auto text-ocean hover:underline">
                  Main version
                </Link>
                {!sc.merged && (
                  <button type="button" onClick={() => discard({ object_type_id: e.object_type_id, primary_key: e.primary_key })} className={buttonClass.ghost}>
                    Discard
                  </button>
                )}
              </div>
              {e.op === "modify" && (
                <div className="mt-2 grid gap-1 pl-12">
                  {e.changed.map((k) => (
                    <div key={k} className="flex items-center gap-2 font-mono">
                      <span className="w-40 truncate text-muted">{k}</span>
                      <span className="text-bad line-through">{JSON.stringify(e.before?.[k] ?? null)}</span>
                      <Icon name="right" className="h-3 w-3 text-muted" />
                      <span className="text-ok">{JSON.stringify(e.after?.[k] ?? null)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>
      {sc.links.length > 0 && (
        <Card title="Link edits" count={sc.links.length}>
          <div className="divide-y divide-line text-xs">
            {sc.links.map((l, i) => (
              <div key={i} className="flex items-center gap-2 px-4 py-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${l.op === "add" ? "bg-ok/15 text-ok" : "bg-bad/15 text-bad"}`}>{l.op}</span>
                {l.link_type}: <span className="font-mono">{l.source}</span> → <span className="font-mono">{l.target}</span>
                {!sc.merged && (
                  <button type="button" onClick={() => discard({ link_type_id: l.link_type_id, source: l.source, target: l.target })} className={`${buttonClass.ghost} ml-auto`}>
                    Discard
                  </button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function CompareView({ list, types, current }: { list: Scenario[]; types: ObjectType[]; current: string }) {
  const [ids, setIds] = useState<string[]>([current]);
  const [picked, setTypeId] = useState("");
  const typeId = picked || types[0]?.id || "";
  const [metric, setMetric] = useState("count");
  const [property, setProperty] = useState("");
  const [groupBy, setGroupBy] = useState("");
  const [res, setRes] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const type = types.find((t) => t.id === typeId);
  const numeric = (type?.properties ?? []).filter((p) => ["integer", "long", "short", "double", "float", "decimal"].includes(p.type));

  useEffect(() => {
    if (!typeId || (metric !== "count" && !property)) return;
    scenarios.compare({ scenario_ids: ids, object_type_id: typeId, metric, property: property || null, group_by: groupBy || null }).then(
      (r) => {
        setRes(r);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [ids, typeId, metric, property, groupBy]);

  const max = Math.max(1, ...(res?.columns ?? []).flatMap((c) => Object.values(c.values).map((v) => (typeof v === "number" ? Math.abs(v) : 0))));
  const colors = ["bg-soft/40", "bg-ocean", "bg-sand", "bg-purple-400", "bg-ok"];
  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <Card title="Compare">
        <div className="space-y-3 p-4 text-xs">
          <div className="space-y-1">
            <div className="text-muted">Scenarios (main is always shown)</div>
            {list
              .filter((s) => !s.merged || s.id === current)
              .map((s) => (
                <label key={s.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={ids.includes(s.id)} onChange={(e) => setIds(e.target.checked ? [...ids, s.id].slice(0, 10) : ids.filter((x) => x !== s.id))} />
                  <span className="truncate">{s.name}</span>
                </label>
              ))}
          </div>
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={`${fieldClass} w-full`} aria-label="Object type">
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.display_name}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <select value={metric} onChange={(e) => setMetric(e.target.value)} className={fieldClass} aria-label="Metric">
              {["count", "sum", "avg", "min", "max"].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {metric !== "count" && (
              <select value={property} onChange={(e) => setProperty(e.target.value)} className={`${fieldClass} flex-1`} aria-label="Property">
                <option value="">property…</option>
                {numeric.map((p) => (
                  <option key={p.api_name} value={p.api_name}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className={`${fieldClass} w-full`} aria-label="Group by">
            <option value="">No grouping</option>
            {(type?.properties ?? []).map((p) => (
              <option key={p.api_name} value={p.api_name}>
                Group by {p.display_name}
              </option>
            ))}
          </select>
        </div>
      </Card>
      <Card title="Scenario comparison">
        <ErrorBox message={error} />
        {res && (
          <div className="space-y-4 p-4 text-xs">
            <table className="w-full">
              <thead className="text-left text-muted">
                <tr>
                  <th className="py-1.5 font-medium">{res.group_by ?? "All objects"}</th>
                  {res.columns.map((c, i) => (
                    <th key={c.scenario_id ?? "main"} className="py-1.5 font-medium">
                      <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${colors[i % colors.length]}`} />
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {res.groups.map((g) => (
                  <tr key={g}>
                    <td className="py-1.5">{g}</td>
                    {res.columns.map((c) => (
                      <td key={c.scenario_id ?? "main"} className="py-1.5 tabular-nums">
                        {c.values[g] === undefined || c.values[g] === null ? "—" : typeof c.values[g] === "number" ? Number(c.values[g]).toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(c.values[g])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="space-y-2">
              {res.groups.slice(0, 12).map((g) => (
                <div key={g}>
                  <div className="mb-0.5 text-muted">{g}</div>
                  {res.columns.map((c, i) => {
                    const v = c.values[g];
                    const n = typeof v === "number" ? v : 0;
                    return (
                      <div key={c.scenario_id ?? "main"} className="mb-0.5 flex items-center gap-2">
                        <div className="h-2.5 flex-1 rounded bg-panel-2">
                          <div className={`h-2.5 rounded ${colors[i % colors.length]}`} style={{ width: `${(Math.abs(n) / max) * 100}%` }} />
                        </div>
                        <span className="w-16 text-right tabular-nums">{typeof v === "number" ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function MergeDialog({
  sc,
  types,
  links,
  actions,
  onClose,
  onActions,
  onMerged,
}: {
  sc: ScenarioDetail;
  types: ObjectType[];
  links: LinkType[];
  actions: ActionType[];
  onClose: () => void;
  onActions: (a: ActionType[]) => void;
  onMerged: () => void;
}) {
  const mergeActions = actions.filter((a) => (a.rules ?? []).some((r) => r.kind === "apply_scenario"));
  const [actionId, setActionId] = useState(mergeActions[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const touchedTypes = [...new Set(sc.edits.map((e) => e.object_type_id))];
  const touchedLinks = [...new Set(sc.links.map((l) => l.link_type_id))];
  const scope = (a: ActionType) => {
    const r = (a.rules ?? []).find((x) => x.kind === "apply_scenario");
    const covered = touchedTypes.every((t) => (r?.object_type_ids ?? []).includes(t)) && touchedLinks.every((l) => (r?.link_type_ids ?? []).includes(l));
    return { r, covered };
  };
  return (
    <Modal title={`Merge ${sc.name}`} icon="check" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted">
          Merging applies the scenario&apos;s {sc.object_edits} object edit{sc.object_edits === 1 ? "" : "s"} and {sc.link_edits} link edit{sc.link_edits === 1 ? "" : "s"} to main as one
          transaction, through an action type with an Apply scenario rule. Its permissions and submission criteria decide who may merge.
        </p>
        {mergeActions.length > 0 ? (
          <div className="space-y-1">
            {mergeActions.map((a) => {
              const { covered } = scope(a);
              return (
                <label key={a.id} className="flex items-center gap-2 text-xs">
                  <input type="radio" checked={actionId === a.id} onChange={() => setActionId(a.id)} />
                  <span className="font-medium">{a.display_name}</span>
                  {!covered && <span className="text-warn">does not cover every edited type</span>}
                </label>
              );
            })}
          </div>
        ) : (
          <div className="rounded-md border border-line-2 bg-panel-2 p-3 text-xs text-muted">No action type merges scenarios yet.</div>
        )}
        <button
          type="button"
          onClick={async () => {
            try {
              const a = await scenarios.createMergeAction({
                display_name: `Merge scenario: ${touchedTypes.map((t) => types.find((x) => x.id === t)?.display_name ?? t).join(", ")}`,
                object_type_ids: touchedTypes.length ? touchedTypes : [types[0]?.id ?? ""],
                link_type_ids: touchedLinks.filter((l) => links.some((x) => x.id === l)),
              });
              onActions(await ontology.actionTypes());
              setActionId(a.id);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
          className={buttonClass.ghost}
        >
          <Icon name="plus" className="h-3.5 w-3.5" /> Create a merge action type for these object types
        </button>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!actionId || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await scenarios.merge(sc.id, actionId);
                onMerged();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
            className={buttonClass.primary}
          >
            {busy ? "Merging…" : "Merge into main"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
