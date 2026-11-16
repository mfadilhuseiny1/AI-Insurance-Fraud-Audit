"use client";

import { ResourceMarkings } from "@/components/auth/ItemMarkings";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { ActionMenu } from "@/components/kg/parts";
import { AppHeader, Badge, Card, ErrorBox, Field, ValueCell } from "@/components/ontology/parts";
import { ActionForm as ActionDialog } from "@/components/ontology/ActionForm";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { when } from "@/lib/format";
import {
  ACTION_KIND_LABEL,
  GEO_PROPERTY_TYPES,
  ontology,
  typeIcon,
  typeLabel,
  type ActionKind,
  type ActionType,
  type Automation,
  type ObjectType,
  type OntologyObject,
  type Property,
} from "@/lib/ontology";
import { confirmDialog } from "@/lib/dialogs";
import { mapHrefForObject } from "@/lib/geo";
import { timeseries, type SeriesSync } from "@/lib/timeseries";
import { ObjectSeries } from "@/components/timeseries/ObjectSeries";
import { TimeSeriesCapabilities } from "@/components/timeseries/Capabilities";
import { PropertyEditor, TypeClasses, type EditorContext } from "@/components/ontology/PropertyEditor";
import { datasources, DatasourcesTab, impactText, TypeIcon } from "@/components/ontology/Datasources";
import { InterfacesCard, LinkTypesCard, MetadataCard, ObjectViewCard, saveOrBranch, statusChange } from "@/components/ontology/ObjectTypeExtras";
import { om, type Group, type SearchResult, type ValueType } from "@/lib/ontologyModel";
import { checks, ReviewChanges, type Staged } from "@/components/ontology/ReviewChanges";
import { actions as actionsApi } from "@/lib/actions";
import { SecurityTab } from "@/components/ontology/SecurityPolicies";
import { AdditionalDatasources } from "@/components/ontology/AdditionalDatasources";
import { SqlConsole } from "@/components/sql/SqlConsole";

type Tab = "overview" | "properties" | "datasources" | "objects" | "actions" | "automations" | "capabilities" | "security" | "sql";
const TABS: [Tab, string, IconName][] = [
  ["overview", "Overview", "home"],
  ["properties", "Properties", "list"],
  ["datasources", "Datasources", "database"],
  ["objects", "Objects", "table"],
  ["actions", "Action types", "edit"],
  ["automations", "Automations", "bolt"],
  ["capabilities", "Capabilities", "wave"],
  ["security", "Security", "eye"],
  ["sql", "SQL", "code"],
];

export default function ObjectTypePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [t, setT] = useState<ObjectType | null>(null);
  const [actions, setActions] = useState<ActionType[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const wanted = useSearchParams().get("tab");
  const [tab, setTab] = useState<Tab>(TABS.some(([k]) => k === wanted) ? (wanted as Tab) : "overview");

  const load = useCallback(() => {
    Promise.all([ontology.objectType(id), ontology.actionTypes(id), ontology.automations()])
      .then(([type, a, autos]) => {
        setT(type);
        setActions(a);
        setAutomations(
          autos.filter((x) => ("object_type_id" in x.condition && x.condition.object_type_id === id) || (x.condition.kind === "time_series" && x.condition.alert_object_type_id === id)),
        );
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (error) return <ApiError message={error} />;
  if (!t) return <Loading />;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Nexus Manager" icon="cube" href="/ontology" crumbs={[{ label: "Object types", href: "/ontology" }, { label: t.display_name }]} />
      <div className="flex min-h-0 flex-1">
        <nav className="w-56 shrink-0 border-r border-line bg-panel p-2 text-sm">
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-line bg-panel-2 p-2.5">
            <TypeIcon t={t} className="h-5 w-5" box="rounded-md p-1.5" />
            <div className="min-w-0">
              <div className="truncate font-medium">{t.display_name}</div>
              <div className="text-xs text-muted">{t.object_count.toLocaleString()} objects</div>
            </div>
          </div>
          {TABS.map(([k, label, icon]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left ${
                tab === k ? "bg-ocean/15 font-medium text-white ring-1 ring-ocean/30" : "text-soft hover:bg-panel-2 hover:text-white"
              }`}
            >
              <Icon name={icon} className="h-4 w-4" />
              <span className="flex-1">{label}</span>
              {k === "properties" && <span className="text-xs text-muted">{t.properties.length}</span>}
              {k === "actions" && <span className="text-xs text-muted">{actions.length}</span>}
              {k === "automations" && <span className="text-xs text-muted">{automations.length}</span>}
            </button>
          ))}
        </nav>
        <section className="dot-grid min-w-0 flex-1 overflow-y-auto">
          {tab === "overview" && <Overview t={t} actions={actions} automations={automations} onChanged={load} onTab={setTab} onDeleted={() => router.push("/ontology")} />}
          {tab === "properties" && <Properties t={t} onChanged={load} />}
          {tab === "objects" && <Objects t={t} actions={actions} onChanged={load} />}
          {tab === "actions" && <Actions t={t} actions={actions} onChanged={load} />}
          {tab === "automations" && <Automations t={t} automations={automations} />}
          {tab === "datasources" && (
            <>
              <DatasourcesTab t={t} onChanged={load} />
              <AdditionalDatasources t={t} onChanged={load} />
            </>
          )}
          {tab === "capabilities" && <TimeSeriesCapabilities t={t} onChanged={load} />}
          {tab === "security" && <SecurityTab t={t} />}
          {tab === "sql" && (
            <div className="flex h-[70vh] min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-panel">
              <SqlConsole key={t.id} name={t.display_name} mode="object" resource={`ri.ontology.main.object-type.${t.id}`} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Overview({
  t,
  actions,
  automations,
  onChanged,
  onTab,
  onDeleted,
}: {
  t: ObjectType;
  actions: ActionType[];
  automations: Automation[];
  onChanged: () => void;
  onTab: (t: Tab) => void;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<null | "display_name" | "plural_name" | "description" | "api_name" | "aliases">(null);
  const [draft, setDraft] = useState("");
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const search = useSearchParams();
  const created = search.get("created") === "1";
  const createdWarnings = (search.get("warn") ?? "").split("\n").filter(Boolean);
  useEffect(() => {
    ontology.objectTypes().then(setTypes, () => setTypes([]));
    om.groups().then(setGroups, () => setGroups([]));
  }, []);
  // edits are staged here and saved together: "N edits" → Save → Review changes → Save to Nexus
  const [pending, setPending] = useState<Staged>({});
  const [reviewing, setReviewing] = useState(false);
  const cur = { ...t, ...pending } as ObjectType;
  const save = async (changes: Staged) => {
    const next: Staged = { ...pending, ...changes };
    for (const k of Object.keys(next) as (keyof Staged)[])
      if (k !== "apply_status_to_properties" && JSON.stringify(next[k]) === JSON.stringify(t[k as keyof ObjectType])) delete next[k];
    setPending(next);
    setEditing(null);
  };
  const commit = async () => {
    if (await saveOrBranch("object_type", t, pending, () => ontology.updateObjectType(t.id, pending), (h) => router.push(h))) {
      setPending({});
      setReviewing(false);
      onChanged();
      return true;
    }
    return false;
  };
  const edits = Object.keys(pending).filter((k) => k !== "apply_status_to_properties").length;
  const problems = checks(t, pending);
  const row = (label: string, key: "display_name" | "plural_name" | "description" | "api_name" | "aliases", mono = false) => (
    <div className="grid grid-cols-[140px_1fr] items-center gap-3 py-1.5">
      <span className="text-muted">{label}</span>
      {editing === key ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save(key === "aliases" ? { aliases: draft.split(",").map((x) => x.trim()).filter(Boolean) } : { [key]: draft });
          }}
        >
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={key === "aliases" ? "Comma separated" : undefined} className={inputClass} />
          <button className={buttonClass.primary}>Set</button>
          <button type="button" onClick={() => setEditing(null)} className={buttonClass.ghost}>
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setEditing(key);
            setDraft(key === "aliases" ? (cur.aliases ?? []).join(", ") : (cur[key] ?? ""));
          }}
          className={`group flex items-center gap-2 text-left ${mono ? "font-mono text-xs" : ""} ${key in pending ? "text-sand" : ""}`}
        >
          {(key === "aliases" ? (cur.aliases ?? []).join(", ") : cur[key]) || <span className="text-muted">{key === "aliases" ? "Add aliases…" : "Type here…"}</span>}
          <Icon name="pencil" className="h-3 w-3 text-muted opacity-0 group-hover:opacity-100" />
        </button>
      )}
    </div>
  );
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-8">
      {(edits > 0 || created) && (
        <div className={`sticky top-0 z-20 -mx-2 flex items-center gap-3 rounded-xl border px-4 py-2.5 text-sm shadow-lg backdrop-blur ${edits ? "border-sand/40 bg-panel/95" : "border-ok/30 bg-ok/10"}`} data-edits-bar>
          {edits ? (
            <>
              <Icon name="pencil" className="h-4 w-4 text-sand" />
              <span className="text-white">
                {edits} edit{edits === 1 ? "" : "s"}
              </span>
              <span className="text-xs text-muted">
                not saved to the Nexus yet{problems.errors.length ? ` · ${problems.errors.length} error${problems.errors.length === 1 ? "" : "s"}` : ""}
              </span>
              <button type="button" onClick={() => setPending({})} className={`${buttonClass.ghost} ml-auto`}>
                Discard
              </button>
              <button type="button" onClick={() => setReviewing(true)} className="rounded-md bg-ok px-3 py-1.5 text-sm font-medium text-ink hover:brightness-110" data-save-edits>
                Save
              </button>
            </>
          ) : (
            <>
              <Icon name="check" className="h-4 w-4 text-ok" />
              <span className="text-soft">
                {t.display_name} is created and saved to the Nexus{t.backing_dataset ? ` from ${t.backing_dataset.name}` : ""}. Review its properties, link it to other object types, and preview its objects below.
                {createdWarnings.map((w) => (
                  <span key={w} className="mt-1 block text-xs text-warn">
                    {w}
                  </span>
                ))}
              </span>
            </>
          )}
        </div>
      )}
      <div className="flex items-start gap-3">
        <TypeIcon t={t} className="h-6 w-6" box="rounded-lg p-2.5" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{cur.display_name}</h1>
          <div className="text-xs text-muted">
            Object type · {t.object_count.toLocaleString()} objects
            {t.aliases?.length ? ` · also known as ${t.aliases.join(", ")}` : ""}
            {t.protected ? " · protected" : ""}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {(cur.groups ?? []).map((g) => (
              <span key={g} className="flex items-center gap-1 rounded-full bg-ocean/15 px-2 py-0.5 text-xs text-ocean">
                <Icon name="grid" className="h-3 w-3" /> {groups.find((x) => x.id === g)?.name ?? g}
                <button type="button" onClick={() => save({ groups: (cur.groups ?? []).filter((x) => x !== g) })} aria-label="Remove from group">
                  <Icon name="x" className="h-3 w-3" />
                </button>
              </span>
            ))}
            <select value="" onChange={(e) => e.target.value && save({ groups: [...(cur.groups ?? []), e.target.value] })} className="bg-transparent text-xs text-ocean outline-none" data-add-group>
              <option value="">+ Add to group</option>
              {groups
                .filter((g) => !(cur.groups ?? []).includes(g.id) && !/\(test\)/i.test(g.name))
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </select>
          </div>
          <ResourceMarkings kind="object_type" id={t.id} className="mt-3 max-w-xl" />
        </div>
        <ActionMenu
          items={[
            { label: "Explore objects", icon: "table", onClick: () => onTab("objects") },
            { label: "Open in Object Explorer", icon: "search", onClick: () => router.push(`/object-explorer?type=${t.id}`) },
            "divider",
            {
              label: "Delete object type",
              icon: "trash",
              danger: true,
              onClick: async () => {
                const impact = await datasources.impact(t.id).catch(() => null);
                if (!(await confirmDialog(`Delete "${t.display_name}"? This removes ${impact ? impactText(impact) : "its objects, action types and automations"}. Link types to it are removed too.`))) return;
                if (await saveOrBranch("object_type", t, {}, () => ontology.deleteObjectType(t.id), (h) => router.push(h))) onDeleted();
              },
            },
          ]}
        />
      </div>

      <section className="grid gap-5 rounded-xl border border-line bg-panel p-5 text-sm lg:grid-cols-[1fr_300px]">
        <div>
          {row("Display name", "display_name")}
          {row("Plural name", "plural_name")}
          {row("Description", "description")}
          {row("Aliases", "aliases")}
          {row("API name", "api_name", true)}
          <div className="grid grid-cols-[140px_1fr] items-center gap-3 py-1.5">
            <span className="text-muted">Primary key</span>
            <span className="font-mono text-xs">{t.primary_key}</span>
          </div>
          <div className="grid grid-cols-[140px_1fr] items-center gap-3 py-1.5">
            <span className="text-muted">Title property</span>
            <select value={cur.title_property} onChange={(e) => save({ title_property: e.target.value })} className={`${inputClass} max-w-xs ${"title_property" in pending ? "border-sand/60" : ""}`}>
              {t.properties.map((p) => (
                <option key={p.api_name} value={p.api_name}>
                  {p.display_name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-2 border-line lg:border-l lg:pl-5">
          <div className="flex items-center justify-between">
            <span className="text-muted">Status</span>
            <select
              value={cur.status}
              onChange={async (e) => {
                const c = await statusChange(t, e.target.value as ObjectType["status"]);
                if (c) save(c);
              }}
              className="rounded-md border border-line-2 bg-ink px-2 py-1 text-xs"
            >
              <option value="experimental">Experimental</option>
              <option value="active">Active</option>
              <option value="promoted">Promoted (ontology owners)</option>
              <option value="deprecated">Deprecated</option>
              <option value="example">Example</option>
            </select>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">Visibility</span>
            <select value={cur.visibility ?? "normal"} onChange={(e) => save({ visibility: e.target.value as ObjectType["visibility"] })} className="rounded-md border border-line-2 bg-ink px-2 py-1 text-xs" data-visibility>
              <option value="prominent">Prominent</option>
              <option value="normal">Normal</option>
              <option value="hidden">Hidden</option>
            </select>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">Edits</span>
            <Badge status="enabled" label={actions.length ? "Enabled" : "No actions"} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">Created</span>
            <span className="text-xs">{when(t.created_at)}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted">ID</span>
            <span className="truncate font-mono text-xs" title={t.id}>
              {t.id}
            </span>
          </div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Properties" count={t.properties.length} action={<button className={buttonClass.ghost} onClick={() => onTab("properties")}><Icon name="plus" className="h-3.5 w-3.5" /> New</button>}>
          <ul className="p-2 text-sm">
            {t.properties.map((p) => (
              <li key={p.api_name} className={`flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-panel-2 ${p.visibility === "hidden" ? "opacity-60" : ""}`}>
                <Icon name={typeIcon(p.type)} className="h-3.5 w-3.5 text-muted" />
                {p.display_name}
                {p.api_name === t.primary_key && <span className="rounded bg-ocean/15 px-1.5 text-[10px] text-ocean">Primary key</span>}
                {p.api_name === t.title_property && <span className="rounded bg-sand/15 px-1.5 text-[10px] text-sand">Title</span>}
                {p.derived && <span className="rounded bg-panel-2 px-1.5 text-[10px] text-muted ring-1 ring-line-2">Derived</span>}
                {p.shared_property_id && <span className="rounded bg-panel-2 px-1.5 text-[10px] text-muted ring-1 ring-line-2">Shared</span>}
                <span className="ml-auto text-xs text-muted">{typeLabel(p.type, p.array)}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Action types" count={actions.length} action={<button className={buttonClass.ghost} onClick={() => onTab("actions")}><Icon name="plus" className="h-3.5 w-3.5" /> New</button>}>
          <div className="px-4 pt-2 text-xs text-muted">Modifies {t.display_name}</div>
          <ul className="p-2 text-sm">
            {actions.length === 0 && <li className="px-2 py-1.5 text-muted">None yet</li>}
            {actions.map((a) => (
              <li key={a.id} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                <Icon name={a.kind === "delete" ? "trash" : "edit"} className="h-3.5 w-3.5 text-ok" /> {a.display_name}
                <span className="ml-auto text-xs text-muted">{ACTION_KIND_LABEL[a.kind]}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Automations" count={automations.length} action={<Link className={buttonClass.ghost} href="/automate"><Icon name="plus" className="h-3.5 w-3.5" /> New</Link>}>
          <ul className="p-2 text-sm">
            {automations.length === 0 && <li className="px-2 py-1.5 text-muted">None watch this object type</li>}
            {automations.map((a) => (
              <li key={a.id}>
                <Link href={`/automate/${a.id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-panel-2">
                  <Icon name="bolt" className="h-3.5 w-3.5 text-sand" /> {a.name}
                  <span className="ml-auto">
                    <Badge status={a.enabled ? "enabled" : "paused"} label={a.enabled ? "Enabled" : "Paused"} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
        <LinkTypesCard t={t} types={types} go={(h) => router.push(h)} />
        <InterfacesCard t={t} onChanged={onChanged} go={(h) => router.push(h)} />
        <MetadataCard t={t} onChanged={onChanged} go={(h) => router.push(h)} />
        <ObjectViewCard t={t} onChanged={onChanged} />
      </div>
      <PreviewObjects t={t} onAll={() => onTab("objects")} />
      {reviewing && <ReviewChanges t={t} staged={pending} groups={groups} onDiscard={() => (setPending({}), setReviewing(false))} onClose={() => setReviewing(false)} onSave={commit} />}
    </div>
  );
}

/** The first objects of the type: the Overview's preview table. */
function PreviewObjects({ t, onAll }: { t: ObjectType; onAll: () => void }) {
  const [data, setData] = useState<SearchResult | null>(null);
  useEffect(() => {
    om.search({ object_type_id: t.id, limit: 8, histograms: false, resource: "ontology-manager" }).then(setData, () => setData(null));
  }, [t.id]);
  const props = t.properties.filter((p) => p.visibility !== "hidden").slice(0, 8);
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm">
        <TypeIcon t={t} className="h-3.5 w-3.5" box="rounded p-0.5" />
        <span className="font-medium text-white">{t.display_name}</span>
        <span className="text-xs text-muted">{data ? `${data.total.toLocaleString()} objects` : "…"}</span>
        <button type="button" onClick={onAll} className="ml-auto text-xs text-ocean hover:underline">
          Preview objects →
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-panel-2/40 text-left text-muted">
            <tr>
              <th className="w-8 px-3 py-2 font-normal">#</th>
              {props.map((p) => (
                <th key={p.api_name} className="whitespace-nowrap px-3 py-2 font-normal">
                  <div className="text-soft">{p.display_name}</div>
                  <div className="text-[10px]">{typeLabel(p.type, p.array)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data?.objects ?? []).map((o, i) => (
              <tr key={o.primary_key} className="border-t border-line/60">
                <td className="px-3 py-1.5 text-muted">{i + 1}</td>
                {props.map((p) => (
                  <td key={p.api_name} className="max-w-[16rem] truncate px-3 py-1.5 text-soft">
                    <ValueCell type={p.type} value={o.properties[p.api_name]} prop={p} object={o.properties} />
                  </td>
                ))}
              </tr>
            ))}
            {data && !data.objects.length && (
              <tr>
                <td colSpan={props.length + 1} className="px-3 py-4 text-center text-muted">
                  No objects yet: rows written to the backing dataset become objects on the next index.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Properties({ t, onChanged }: { t: ObjectType; onChanged: () => void }) {
  const router = useRouter();
  const [props, setProps] = useState<Property[]>(t.properties);
  const [open, setOpen] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [ctx, setCtx] = useState<EditorContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([om.sharedProperties(), om.valueTypes(), om.linkTypes(), ontology.objectTypes(), ontology.actionTypes(t.id)]).then(
      ([sharedProperties, valueTypes, linkTypes, objectTypes, acts]) =>
        setCtx({ t, sharedProperties, valueTypes, linkTypes, objectTypes, actions: acts.filter((a) => a.kind === "modify" || (a.kind === "rules" && (a.rules ?? []).some((r) => r.kind === "modify_object"))) }),
      () => setCtx({ t, sharedProperties: [], valueTypes: [], linkTypes: [], objectTypes: [] }),
    );
  }, [t]);
  const saved = (name: string) => t.properties.find((o) => o.api_name === name) ?? null;
  // geotemporal series references point into one geotemporal series sync
  const [syncs, setSyncs] = useState<SeriesSync[]>([]);
  useEffect(() => {
    if (props.some((p) => p.type === "geotemporal_series_reference")) timeseries.syncs("geotemporal").then(setSyncs, () => setSyncs([]));
  }, [props]);
  const dirty = JSON.stringify(props) !== JSON.stringify(t.properties);
  const bulk = (c: Partial<Property> | ((p: Property) => Property)) => setProps(props.map((x, j) => (selected.has(j) ? (typeof c === "function" ? c(x) : { ...x, ...c }) : x)));
  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto p-8">
        <div className="flex items-center gap-3">
          <h1 className="flex-1 text-xl font-semibold">Properties</h1>
          <button
            type="button"
            onClick={() => {
              setProps([...props, { api_name: "", display_name: "", type: "string", status: "experimental" }]);
              setOpen(props.length);
            }}
            className={buttonClass.secondary}
          >
            <Icon name="plus" className="h-3.5 w-3.5" /> New property
          </button>
          <button
            type="button"
            disabled={!dirty || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const ok = await saveOrBranch("object_type", t, { properties: props }, () => ontology.updateObjectType(t.id, { properties: props }), (h) => router.push(h));
              if (ok) onChanged();
              setBusy(false);
            }}
            className={buttonClass.primary}
          >
            <Icon name="save" className="h-3.5 w-3.5" /> Save
          </button>
        </div>
        <p className="mt-1 text-sm text-muted">
          Select a property to edit its metadata, formatting, render hints, type classes, reducers or derived source. Tick several to edit them in bulk. Active properties cannot be removed.
        </p>
        <div className="mt-4">
          <ErrorBox message={error} />
        </div>
        {selected.size > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-ocean/40 bg-ocean/10 px-3 py-2 text-xs">
            <span className="font-medium">{selected.size} selected</span>
            <select value="" onChange={(e) => e.target.value && bulk({ status: e.target.value as Property["status"] })} className="rounded border border-line-2 bg-ink px-1.5 py-1">
              <option value="">Status…</option>
              <option value="experimental">Experimental</option>
              <option value="active">Active</option>
              <option value="example">Example</option>
            </select>
            <select value="" onChange={(e) => e.target.value && bulk({ visibility: e.target.value as Property["visibility"] })} className="rounded border border-line-2 bg-ink px-1.5 py-1">
              <option value="">Visibility…</option>
              <option value="prominent">Prominent</option>
              <option value="normal">Normal</option>
              <option value="hidden">Hidden</option>
            </select>
            <select
              value=""
              onChange={(e) => {
                const [op, h] = e.target.value.split(":");
                if (h) bulk((p) => ({ ...p, render_hints: op === "add" ? [...new Set([...(p.render_hints ?? []), h])] : (p.render_hints ?? []).filter((x) => x !== h) }));
              }}
              className="rounded border border-line-2 bg-ink px-1.5 py-1"
            >
              <option value="">Render hint…</option>
              {["searchable", "sortable", "selectable", "low_cardinality", "long_text"].flatMap((h) => [
                <option key={`add:${h}`} value={`add:${h}`}>
                  + {h.replace("_", " ")}
                </option>,
                <option key={`remove:${h}`} value={`remove:${h}`}>
                  − {h.replace("_", " ")}
                </option>,
              ])}
            </select>
            <button type="button" onClick={() => bulk({ value_formatting: null })} className={buttonClass.ghost}>
              Remove value formatting
            </button>
            <div className="w-64">
              <TypeClasses value={[]} onChange={(v) => v[0] && bulk((p) => ({ ...p, type_classes: [...new Set([...(p.type_classes ?? []), v[0]])] }))} />
            </div>
            <button type="button" onClick={() => setSelected(new Set())} className={`${buttonClass.ghost} ml-auto`}>
              Clear
            </button>
          </div>
        )}
        <div className="mt-4 overflow-hidden rounded-xl border border-line bg-panel">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th className="w-8 px-3 py-2.5" />
                <th className="px-3 py-2.5 font-medium">Display name</th>
                <th className="px-3 py-2.5 font-medium">API name</th>
                <th className="px-3 py-2.5 font-medium">Base type</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Details</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {props.map((p, i) => {
                const isPk = p.api_name === t.primary_key;
                return (
                  <tr key={i} onClick={() => setOpen(i)} className={`cursor-pointer border-b border-line last:border-0 ${open === i ? "bg-ocean/10" : "hover:bg-panel-2"} ${p.visibility === "hidden" ? "opacity-70" : ""}`}>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(i)}
                        onChange={(e) => {
                          const n = new Set(selected);
                          if (e.target.checked) n.add(i);
                          else n.delete(i);
                          setSelected(n);
                        }}
                      />
                    </td>
                    <td className="px-3 py-2 font-medium">
                      {p.display_name || <span className="text-muted">New property</span>}
                      {p.visibility === "prominent" && <Icon name="star" className="ml-1 inline h-3 w-3 text-sand" />}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-soft">{p.api_name}</td>
                    <td className="px-3 py-2 text-xs">{typeLabel(p.type, p.array)}</td>
                    <td className="px-3 py-2">
                      <Badge status={p.status ?? "experimental"} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1 text-[10px]">
                        {isPk && <span className="rounded bg-ocean/15 px-1.5 text-ocean">Primary key</span>}
                        {p.api_name === t.title_property && <span className="rounded bg-sand/15 px-1.5 text-sand">Title</span>}
                        {p.required && <span className="rounded bg-panel-2 px-1.5 ring-1 ring-line-2">Required</span>}
                        {p.edit_only && <span className="rounded bg-panel-2 px-1.5 ring-1 ring-line-2">Edit-only</span>}
                        {p.derived && <span className="rounded bg-panel-2 px-1.5 ring-1 ring-line-2">Derived</span>}
                        {p.shared_property_id && <span className="rounded bg-panel-2 px-1.5 ring-1 ring-line-2">Shared</span>}
                        {p.value_type_id && <span className="rounded bg-panel-2 px-1.5 ring-1 ring-line-2">Value type</span>}
                        {p.mandatory_control && <span className="rounded bg-bad/15 px-1.5 text-bad">Mandatory control</span>}
                        {p.reducers?.length ? <span className="rounded bg-panel-2 px-1.5 ring-1 ring-line-2">Reducer</span> : null}
                      </div>
                    </td>
                    <td className="px-2" onClick={(e) => e.stopPropagation()}>
                      {!isPk && (
                        <button
                          type="button"
                          onClick={() => {
                            setProps(props.filter((_, j) => j !== i));
                            setOpen(null);
                            setSelected(new Set());
                          }}
                          className="rounded p-1.5 text-muted hover:bg-panel-2 hover:text-bad"
                          aria-label="Remove"
                        >
                          <Icon name="trash" className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {open !== null && props[open] && ctx && (
        <PropertyEditor
          key={open}
          prop={props[open]}
          saved={saved(props[open].api_name)}
          all={props}
          ctx={{ ...ctx, geoSyncs: syncs }}
          onChange={(np) => setProps(props.map((x, j) => (j === open ? np : x)))}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function Objects({ t, actions, onChanged }: { t: ObjectType; actions: ActionType[]; onChanged: () => void }) {
  const [rows, setRows] = useState<OntologyObject[] | null>(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<OntologyObject | null>(null);
  const [running, setRunning] = useState<{ action: ActionType; object?: OntologyObject } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    ontology
      .objects(t.id, q)
      .then((r) => {
        setRows(r.objects);
        setTotal(r.total);
        setSelected((cur) => (cur ? (r.objects.find((o) => o.primary_key === cur.primary_key) ?? null) : null));
      })
      .catch((e: Error) => setError(e.message));
  }, [t.id, q]);
  useEffect(() => {
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
  }, [load]);
  // automations may still be writing: refresh for a little while after an action
  const refreshSoon = () => {
    load();
    onChanged();
    [1500, 4000, 9000].forEach((ms) => setTimeout(load, ms));
  };

  // object actions take an object of this type (or an object of an interface it implements); the rest create
  const onObject = (a: ActionType) =>
    a.kind === "rules"
      ? a.parameters.some((p) => (p.type === "object" && ((p as { object_type_id?: string }).object_type_id ?? a.object_type_id) === t.id) || p.type === ("interface" as never))
      : a.kind !== "create";
  const hidden = (a: ActionType) => (a.type_classes ?? []).some((c) => c.endsWith(":hide-action"));
  const creates = actions.filter((a) => !onObject(a) && !hidden(a));
  const objectActions = actions.filter((a) => onObject(a) && !hidden(a));
  // hidden properties stay out of applications; prominent ones come first
  const shown = [...t.properties.filter((p) => p.visibility !== "hidden")].sort((a, b) => Number(b.visibility === "prominent") - Number(a.visibility === "prominent"));
  const cellValue = (o: OntologyObject, p: Property) => (o.reduced && p.api_name in o.reduced ? o.reduced[p.api_name] : o.properties[p.api_name]);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line bg-panel px-4 py-2.5">
          <div className="flex w-72 items-center gap-2 rounded-md border border-line-2 bg-ink px-2.5">
            <Icon name="search" className="h-4 w-4 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${t.plural_name}…`} className="w-full bg-transparent py-1.5 text-sm outline-none" />
          </div>
          <span className="text-xs text-muted">{total.toLocaleString()} objects</span>
          <button type="button" onClick={load} className={buttonClass.ghost} title="Refresh">
            <Icon name="refresh" className="h-3.5 w-3.5" />
          </button>
          <div className="ml-auto flex gap-2">
            {creates.length === 0 && <span className="text-xs text-muted">Add a “Create object” action type to add objects</span>}
            {creates.map((a) => (
              <button key={a.id} type="button" onClick={() => setRunning({ action: a })} className={buttonClass.primary}>
                <Icon name="plus" className="h-3.5 w-3.5" /> {a.display_name}
              </button>
            ))}
          </div>
        </div>
        {error && <div className="p-4"><ErrorBox message={error} /></div>}
        <div className="min-h-0 flex-1 overflow-auto bg-panel">
          {rows === null ? (
            <Loading />
          ) : rows.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted">No objects{q ? " match" : " yet"}.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 border-b border-line bg-panel text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Title</th>
                  {shown.map((p) => (
                    <th key={p.api_name} className="whitespace-nowrap px-3 py-2 font-medium">
                      {p.display_name}
                    </th>
                  ))}
                  <th className="px-3 py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr
                    key={o.primary_key}
                    onClick={() => setSelected(o)}
                    // drop onto a map (Map → a saved map) to add the object there
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", `object:${t.id}:${o.primary_key}`)}
                    className={`cursor-pointer border-b border-line align-top ${selected?.primary_key === o.primary_key ? "bg-ocean/10" : "hover:bg-panel-2"}`}
                  >
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5 font-medium">
                        <Icon name="cube" className="h-3.5 w-3.5 shrink-0 text-ocean" />
                        <span className="line-clamp-1 max-w-48 break-all">{o.title}</span>
                      </span>
                    </td>
                    {shown.map((p) => (
                      <td key={p.api_name} className="max-w-72 px-3 py-2 text-soft" onClick={(e) => p.inline_edit_action_id && e.stopPropagation()}>
                        {p.inline_edit_action_id ? (
                          <InlineCell t={t} pk={o.primary_key} prop={p} value={o.properties[p.api_name]} object={o.properties} onSaved={load} />
                        ) : (
                          <ValueCell type={p.type} value={cellValue(o, p)} prop={p} object={o.properties} />
                        )}
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">{o.updated_at ? when(o.updated_at) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {selected && (
        <aside className="flex w-[420px] shrink-0 flex-col border-l border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Icon name="cube" className="h-4 w-4 text-ocean" />
            <span className="min-w-0 flex-1 truncate font-semibold">{selected.title}</span>
            <Link href={`/ontology/objects/${t.id}/${encodeURIComponent(selected.primary_key)}`} className={buttonClass.ghost} title="Open the Object View">
              <Icon name="external" className="h-3.5 w-3.5" /> Object View
            </Link>
            <button type="button" onClick={() => setSelected(null)} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white">
              <Icon name="x" />
            </button>
          </div>
          <div className="flex flex-wrap gap-2 border-b border-line px-4 py-2.5">
            {objectActions.map((a) => (
              <button key={a.id} type="button" onClick={() => setRunning({ action: a, object: selected })} className={buttonClass.secondary}>
                <Icon name={a.kind === "delete" ? "trash" : "edit"} className="h-3.5 w-3.5" /> {a.display_name}
              </button>
            ))}
            {t.properties.some((p) => GEO_PROPERTY_TYPES.includes(p.type)) && (
              <Link href={mapHrefForObject(t.id, selected.primary_key)} className={buttonClass.secondary} title="Open a map with this object">
                <Icon name="globe" className="h-3.5 w-3.5" /> Show on map
              </Link>
            )}
            <button
              type="button"
              onClick={async () => {
                if (!(await confirmDialog(`Delete ${selected.title}?`))) return;
                await ontology.deleteObject(t.id, selected.primary_key);
                setSelected(null);
                refreshSoon();
              }}
              className={`${buttonClass.ghost} text-bad`}
            >
              <Icon name="trash" className="h-3.5 w-3.5" /> Delete
            </button>
          </div>
          <dl className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-sm">
            {shown.map((p) => (
              <div key={p.api_name}>
                <dt className="mb-0.5 flex items-center gap-1.5 text-xs text-muted">
                  <Icon name={typeIcon(p.type)} className="h-3 w-3" /> {p.display_name}
                </dt>
                <dd className="text-soft">
                  <ValueCell type={p.type} value={selected.properties[p.api_name]} large prop={p} object={selected.properties} />
                </dd>
              </div>
            ))}
            {(t.properties.some((p) => p.type === "timeseries") || t.time_series) && (
              <div className="border-t border-line pt-3">
                <ObjectSeries typeId={t.id} pk={selected.primary_key} compact />
              </div>
            )}
          </dl>
        </aside>
      )}

      {running && (
        <ActionDialog
          action={running.action}
          objectType={t}
          object={running.object}
          onClose={() => setRunning(null)}
          onDone={() => {
            setRunning(null);
            refreshSoon();
          }}
        />
      )}
    </div>
  );
}

/** A cell edited in place with the property's inline edit action (double-click to edit, Enter to save). */
function InlineCell({ t, pk, prop, value, object, onSaved }: { t: ObjectType; pk: string; prop: Property; value: unknown; object: Record<string, unknown>; onSaved: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (draft === null)
    return (
      <span onDoubleClick={() => setDraft(value === null || value === undefined ? "" : String(value))} className="block cursor-text rounded px-0.5 hover:ring-1 hover:ring-ocean/40" title="Double-click to edit">
        <ValueCell type={prop.type} value={value} prop={prop} object={object} />
        {err && <span className="block text-[10px] text-bad">{err}</span>}
      </span>
    );
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => setDraft(null)}
      onKeyDown={async (e) => {
        if (e.key === "Escape") setDraft(null);
        if (e.key !== "Enter") return;
        try {
          await actionsApi.inlineEdit(t.id, pk, prop.api_name, draft);
          setErr(null);
          setDraft(null);
          onSaved();
        } catch (ex) {
          setErr((ex as Error).message);
          setDraft(null);
        }
      }}
      className={`${inputClass} py-0.5 text-xs`}
    />
  );
}

function Actions({ t, actions, onChanged }: { t: ObjectType; actions: ActionType[]; onChanged: () => void }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ActionType | null>(null);
  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">Action types</h1>
          <p className="mt-1 text-sm text-muted">Each action writes some properties of {t.display_name}. AIP Logic and Automate apply them too.</p>
        </div>
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" /> New action type
        </button>
      </div>
      <div className="mt-5 space-y-3">
        {actions.length === 0 && <p className="rounded-xl border border-line bg-panel p-6 text-center text-sm text-muted">No action types yet.</p>}
        {actions.map((a) => (
          <div key={a.id} className="rounded-xl border border-line bg-panel">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              <Icon name={a.kind === "delete" ? "trash" : "edit"} className="h-4 w-4 text-ok" />
              <Link href={`/ontology/action-types/${a.id}`} className="font-semibold hover:text-ocean">
                {a.display_name}
              </Link>
              <span className="text-xs text-muted">{ACTION_KIND_LABEL[a.kind]}</span>
              <span className="font-mono text-xs text-muted">· {a.api_name}</span>
              <ActionMenu
                className="ml-auto"
                items={[
                  { label: "Open action type editor", icon: "external", onClick: () => router.push(`/ontology/action-types/${a.id}`) },
                  ...(a.kind !== "rules" ? [{ label: "Edit parameters, status and type classes", icon: "pencil" as const, onClick: () => setEditing(a) }] : []),
                  "divider",
                  {
                    label: "Delete",
                    icon: "trash",
                    danger: true,
                    onClick: async () => {
                      if (!(await confirmDialog(`Delete the action type "${a.display_name}"?`))) return;
                      await ontology.deleteActionType(a.id);
                      onChanged();
                    },
                  },
                ]}
              />
            </div>
            <div className="flex flex-wrap gap-1.5 p-3">
              {a.parameters.map((p) => (
                <span key={p.id} className="flex items-center gap-1.5 rounded-md bg-panel-2 px-2 py-1 text-xs ring-1 ring-line-2">
                  <Icon name={typeIcon(p.type)} className="h-3 w-3 text-muted" />
                  {p.display_name}
                  {p.required && <span className="text-bad">*</span>}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      {creating && <NewActionDialog t={t} onClose={() => setCreating(false)} onDone={() => { setCreating(false); onChanged(); }} />}
      {editing && <EditParametersDialog t={t} action={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); onChanged(); }} />}
    </div>
  );
}

function NewActionDialog({ t, onClose, onDone }: { t: ObjectType; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<ActionKind>("create");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const placeholder = { create: `Create ${t.display_name}`, modify: `Edit ${t.display_name}`, delete: `Delete ${t.display_name}`, rules: `Update ${t.display_name}` }[kind];
  return (
    <Modal title="New action type" icon="edit" onClose={onClose}>
      <form
        className="space-y-4 p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (kind === "rules") {
              // a rule-based action starts with the object parameter and an empty Modify object rule
              const a = await ontology.createActionType({
                object_type_id: t.id,
                kind,
                display_name: name.trim() || placeholder,
                description,
                parameters: [{ id: "object", display_name: t.display_name, type: "object", object_type_id: t.id, required: true, property: null } as never],
                rules: [{ kind: "modify_object", object_type_id: t.id, object_param: "object", properties: {} }],
              });
              router.push(`/ontology/action-types/${a.id}`);
              return;
            }
            await ontology.createActionType({ object_type_id: t.id, kind, display_name: name.trim() || undefined, description });
            onDone();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <div className="grid grid-cols-4 gap-2">
          {(["create", "modify", "delete", "rules"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded-lg border p-3 text-left text-sm ${kind === k ? "border-ocean bg-ocean/10" : "border-line-2 hover:border-ocean/50"}`}
            >
              <Icon name={k === "delete" ? "trash" : k === "create" ? "plus" : k === "rules" ? "sliders" : "edit"} className="mb-1 h-4 w-4 text-ocean" />
              {ACTION_KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} className={inputClass} />
        </Field>
        <Field label="Description (optional)">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </Field>
        <p className="text-xs text-muted">
          {kind === "rules"
            ? "Opens the action type editor: rules (objects, links, interfaces, functions, notifications, webhooks, schedules), parameters, form sections, submission criteria and security."
            : "Parameters for every property are added; edit them afterwards to leave some out."}
        </p>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" className={buttonClass.primary}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Choose which properties the action writes, which are required, and their labels. */
function EditParametersDialog({ t, action, onClose, onDone }: { t: ObjectType; action: ActionType; onClose: () => void; onDone: () => void }) {
  const byProp = Object.fromEntries(action.parameters.filter((p) => p.property).map((p) => [p.property!, p]));
  const [rows, setRows] = useState(() =>
    t.properties
      .filter((p) => !(action.kind === "modify" && p.api_name === t.primary_key) && !["byte", "float", "short"].includes(p.type) && !p.derived)
      .map((p) => ({
        property: p,
        on: !!byProp[p.api_name],
        required: byProp[p.api_name]?.required ?? false,
        label: byProp[p.api_name]?.display_name ?? p.display_name,
        value_type_id: byProp[p.api_name]?.value_type_id ?? null,
        prefill: byProp[p.api_name]?.prefill ?? null,
      })),
  );
  const [error, setError] = useState<string | null>(null);
  const [vts, setVts] = useState<ValueType[]>([]);
  const [classes, setClasses] = useState<string[]>(action.type_classes ?? []);
  const [status, setStatus] = useState(action.status ?? "experimental");
  useEffect(() => {
    om.valueTypes().then(setVts, () => setVts([]));
  }, []);
  const objectParam = action.parameters.find((p) => p.type === "object");
  return (
    <Modal title={`Parameters · ${action.display_name}`} icon="sliders" onClose={onClose} wide>
      <div className="space-y-3 p-4">
        {objectParam && (
          <div className="flex items-center gap-2 rounded-md bg-panel-2 px-3 py-2 text-sm">
            <Icon name="cube" className="h-4 w-4 text-ocean" /> {objectParam.display_name} <span className="text-xs text-muted">(the object; always required)</span>
          </div>
        )}
        {action.kind !== "delete" &&
          rows.map((r, i) => (
            <div key={r.property.api_name} className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={r.on}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))}
                className="accent-[var(--color-ocean)]"
              />
              <input value={r.label} disabled={!r.on} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className={`${inputClass} flex-1`} />
              <span className="w-28 text-xs text-muted">{typeLabel(r.property.type, r.property.array)}</span>
              <select
                value={r.value_type_id ?? ""}
                disabled={!r.on}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value_type_id: e.target.value || null } : x)))}
                className="w-36 rounded-md border border-line-2 bg-ink px-1.5 py-1 text-xs"
                title="Constrain with a value type"
              >
                <option value="">No value type</option>
                {vts.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.display_name}
                  </option>
                ))}
              </select>
              {r.property.type === "string" && (
                <label className="flex items-center gap-1 text-xs text-soft" title="An empty value becomes the user applying the action">
                  <input
                    type="checkbox"
                    disabled={!r.on}
                    checked={r.prefill === "current_user"}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, prefill: e.target.checked ? "current_user" : null } : x)))}
                  />
                  Me
                </label>
              )}
              <label className="flex items-center gap-1.5 text-xs text-soft">
                <input
                  type="checkbox"
                  disabled={!r.on}
                  checked={r.required}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))}
                  className="accent-[var(--color-ocean)]"
                />
                Required
              </label>
            </div>
          ))}
        <div className="grid grid-cols-[160px_1fr] gap-3 border-t border-line pt-3 text-sm">
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={inputClass}>
              {["experimental", "active", "deprecated", "example"].map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </Field>
          <TypeClasses value={classes} onChange={setClasses} />
        </div>
        <p className="text-[11px] text-muted">
          Type classes: actions:generate_uuid fills an empty string primary key with a UUID, hubble-oe:hide-action hides the action in Object Explorer and Object Views. Byte, float and short properties cannot be action parameters.
        </p>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await ontology.updateActionType(action.id, {
                  parameters: [
                    ...(objectParam ? [objectParam] : []),
                    // parameters the action already has keep their place, id and other settings (description, default, allowed values)
                    ...rows
                      .filter((r) => r.on && action.kind !== "delete")
                      .map((r, i) => ({ r, at: action.parameters.findIndex((p) => p.property === r.property.api_name), i }))
                      .sort((a, b) => (a.at < 0 ? 1e6 + a.i : a.at) - (b.at < 0 ? 1e6 + b.i : b.at))
                      .map(({ r }) => ({
                        ...byProp[r.property.api_name],
                        id: byProp[r.property.api_name]?.id ?? r.property.api_name,
                        display_name: r.label || r.property.display_name,
                        type: r.property.type,
                        required: r.required,
                        property: r.property.api_name,
                        value_type_id: r.value_type_id,
                        prefill: r.prefill,
                      })),
                  ],
                  type_classes: classes,
                  status,
                });
                onDone();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Automations({ t, automations }: { t: ObjectType; automations: Automation[] }) {
  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">Automations</h1>
          <p className="mt-1 text-sm text-muted">Automations that run when {t.plural_name} are added or modified.</p>
        </div>
        <Link href={`/automate?new=${t.id}`} className={buttonClass.primary}>
          <Icon name="plus" /> New automation
        </Link>
      </div>
      <div className="mt-5 space-y-2">
        {automations.length === 0 && <p className="rounded-xl border border-line bg-panel p-6 text-center text-sm text-muted">No automations watch this object type.</p>}
        {automations.map((a) => (
          <Link key={a.id} href={`/automate/${a.id}`} className="flex items-center gap-3 rounded-xl border border-line bg-panel p-4 hover:border-ocean/50">
            <Icon name="bolt" className="h-5 w-5 text-sand" />
            <div className="flex-1">
              <div className="font-medium">{a.name}</div>
              <div className="text-xs text-muted">
                {a.condition.kind === "objects_added" ? "When objects are added" : "When objects are modified"} · {a.run_count} runs
                {a.failed_runs ? ` · ${a.failed_runs} failed` : ""}
              </div>
            </div>
            <Badge status={a.enabled ? "enabled" : "paused"} label={a.enabled ? "Enabled" : "Paused"} />
          </Link>
        ))}
      </div>
    </div>
  );
}
