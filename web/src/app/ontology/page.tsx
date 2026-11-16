"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { ActionMenu } from "@/components/kg/parts";
import { AppHeader, Badge, EMPTY_BOX } from "@/components/ontology/parts";
import { TypeIcon } from "@/components/ontology/Datasources";
import { BranchesTab, GroupsTab, InterfacesTab, LinkTypesTab, OntologiesTab, SharedPropertiesTab } from "@/components/ontology/ManagerTabs";
import { NewLinkTypeDialog, saveOrBranch, statusChange } from "@/components/ontology/ObjectTypeExtras";
import { ObjectTypeWizard } from "@/components/ontology/ObjectTypeWizard";
import { buttonClass } from "@/components/pipeline/Modal";
import { ApiError } from "@/components/States";
import { when } from "@/lib/format";
import { ACTION_KIND_LABEL, ontology, type ActionType, type ObjectType } from "@/lib/ontology";
import { om, storedOntology, storeOntology, type Group, type Ontology } from "@/lib/ontologyModel";
import { confirmDialog } from "@/lib/dialogs";

type Tab = "object-types" | "link-types" | "action-types" | "interfaces" | "shared-properties" | "groups" | "branches" | "ontologies";
const TABS: [Tab, string, IconName, string][] = [
  ["object-types", "Object types", "cube", "Define the objects your applications work with: their properties, primary key and title. Media properties hold PDFs and images from Files."],
  ["link-types", "Link types", "link", "Relationships between object types: foreign keys, join tables and backing object types, each side with its own name."],
  ["action-types", "Action types", "edit", "Actions are how users, AIP Logic and automations create, modify and delete objects."],
  ["interfaces", "Interfaces", "layers", "Shapes object types implement, so applications work across every implementing object type."],
  ["shared-properties", "Shared properties", "list", "Properties defined once and used on many object types, which inherit their metadata."],
  ["groups", "Groups", "folder", "Labels that categorize object types for search and discovery."],
  ["branches", "Branches", "split", "Change resources on a branch, then review and merge them into main with a proposal."],
  ["ontologies", "Nexus", "globe", "Private and shared ontologies, their roles and main protection; migrate resources between them."],
];

export default function OntologyManagerPage() {
  return (
    <Suspense>
      <OntologyManager />
    </Suspense>
  );
}

function OntologyManager() {
  const router = useRouter();
  const params = useSearchParams();
  const [types, setTypes] = useState<ObjectType[] | null>(null);
  const [actions, setActions] = useState<ActionType[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [onts, setOnts] = useState<Ontology[]>([]);
  const [ontologyId, setOntologyId] = useState(storedOntology);
  const [error, setError] = useState<string | null>(null);
  const wanted = params.get("tab");
  const [tab, setTab] = useState<Tab>(TABS.some(([k]) => k === wanted) ? (wanted as Tab) : "object-types");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [linking, setLinking] = useState(false);

  const load = useCallback(() => {
    Promise.all([ontology.objectTypes(), ontology.actionTypes(), om.groups(), om.ontologies()])
      .then(([t, a, g, o]) => {
        setTypes(t);
        setActions(a);
        setGroups(g);
        setOnts(o);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const ont = onts.find((o) => o.id === ontologyId) ?? onts[0];
  const inOntology = (types ?? []).filter((t) => (t.ontology_id ?? "default") === (ont?.id ?? "default"));
  const typeName = useMemo(() => Object.fromEntries((types ?? []).map((t) => [t.id, t.display_name])), [types]);
  const q = query.trim().toLowerCase();
  const shownTypes = inOntology.filter(
    (t) => (!q || `${t.display_name} ${t.api_name} ${t.description} ${(t.aliases ?? []).join(" ")}`.toLowerCase().includes(q)) && (!group || (t.groups ?? []).includes(group)),
  );
  const ids = new Set(inOntology.map((t) => t.id));
  const shownActions = actions.filter((a) => ids.has(a.object_type_id) && (!q || `${a.display_name} ${typeName[a.object_type_id] ?? ""}`.toLowerCase().includes(q)));
  const info = TABS.find(([k]) => k === tab)!;
  const go = (h: string) => router.push(h);

  if (error && !types) return <ApiError message={error} />;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Nexus Manager" icon="cube" href="/ontology">
        <select
          value={ont?.id ?? "default"}
          onChange={(e) => {
            setOntologyId(e.target.value);
            storeOntology(e.target.value);
            setChecked(new Set());
          }}
          className="rounded-md border border-line-2 bg-ink px-2 py-1.5 text-xs"
          title="BluesandAI Nexus"
        >
          {onts.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} {o.kind !== "default" ? `(${o.kind})` : ""}
            </option>
          ))}
        </select>
        {ont?.protect_main && <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] text-warn ring-1 ring-warn/30">Main protected</span>}
        <Link href="/object-explorer" className={buttonClass.secondary}>
          <Icon name="search" className="h-3.5 w-3.5" /> Object Explorer
        </Link>
        <NewResourceMenu
          onObjectType={() => setCreating(true)}
          onLinkType={() => setLinking(true)}
          onTab={(t) => setTab(t)}
          go={go}
        />
      </AppHeader>

      <div className="flex min-h-0 flex-1">
        <nav className="w-56 shrink-0 overflow-y-auto border-r border-line bg-panel p-2 text-sm">
          {TABS.map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left ${
                tab === id ? "bg-ocean/15 font-medium text-white ring-1 ring-ocean/30" : "text-soft hover:bg-panel-2 hover:text-white"
              }`}
            >
              <Icon name={icon} className="h-4 w-4" />
              <span className="flex-1">{label}</span>
              {id === "object-types" && <span className="text-xs tabular-nums text-muted">{inOntology.length}</span>}
              {id === "action-types" && <span className="text-xs tabular-nums text-muted">{shownActions.length}</span>}
            </button>
          ))}
          <div className="px-3 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wide text-muted">Nexus apps</div>
          {(
            [
              ["/object-explorer", "Object Explorer", "search"],
              ["/object-views", "Object Views", "layers"],
              ["/object-monitors", "Object Monitors", "bell"],
              ["/ontology/semantic-search", "Semantic search", "sparkle"],
              ["/ontology/search", "Nexus search", "search"],
              ["/ontology/scenarios", "Scenarios", "split"],
              ["/map", "Map", "globe"],
              ["/vertex", "Vertex", "graph"],
              ["/vertex/grid-intelligence-nexus", "Grid Intelligence Nexus", "sparkle"],
              ["/vertex/jkn-intelligence-nexus", "JKN Intelligence Nexus", "sparkle"],
              ["/machinery", "Device and Machinery", "cpu"],
              ["/foundry-rules", "Foundry Rules", "sliders"],
              ["/ontology-overview", "Nexus Overview", "cube"],
              ["/object-permissioning", "Object Permissioning", "eye"],
              ["/ontology-indexing", "Indexing", "pipeline"],
              ["/object-edits", "Object Edits & Materializations", "edit"],
              ["/object-databases", "Object Databases", "database"],
              ["/vulcan", "Vulcan", "cube"],
              ["/dynamic-scheduling", "Dynamic Scheduling", "clock"],
              ["/value-types", "Value Types", "link"],
              ["/ontology/proposals", "Proposals", "check"],
              ["/ontology/design", "Design review", "sparkle"],
              ["/resource-management#ontology", "Usage", "gauge"],
              ["/ontology/advanced", "Export, import & cleanup", "download"],
            ] as const
          ).map(([href, label, icon]) => (
            <Link key={href} href={href} className="flex items-center gap-2.5 rounded-md px-3 py-2 text-soft hover:bg-panel-2 hover:text-white">
              <Icon name={icon} className="h-4 w-4" /> {label}
            </Link>
          ))}
          <div className="px-3 pb-1 pt-5 text-[11px] font-semibold uppercase tracking-wide text-muted">Build with the ontology</div>
          {(
            [
              ["/logic", "AIP Logic", "logic"],
              ["/automate", "Automate", "bolt"],
              ["/agents", "AIP Agent Studio", "sparkle"],
            ] as const
          ).map(([href, label, icon]) => (
            <Link key={href} href={href} className="flex items-center gap-2.5 rounded-md px-3 py-2 text-soft hover:bg-panel-2 hover:text-white">
              <Icon name={icon} className="h-4 w-4" /> {label}
            </Link>
          ))}
        </nav>

        <section className="dot-grid min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl p-8">
            <div className="flex items-end gap-4">
              <div className="flex-1">
                <h1 className="text-xl font-semibold">{info[1]}</h1>
                <p className="mt-1 text-sm text-muted">{info[3]}</p>
              </div>
              {tab !== "groups" && tab !== "ontologies" && tab !== "branches" && (
                <div className="flex w-72 items-center gap-2 rounded-md border border-line-2 bg-ink px-2.5">
                  <Icon name="search" className="h-4 w-4 text-muted" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className="w-full bg-transparent py-1.5 text-sm outline-none" />
                </div>
              )}
            </div>

            {types === null ? null : tab === "object-types" ? (
              inOntology.length === 0 ? (
                <button type="button" onClick={() => setCreating(true)} className={EMPTY_BOX}>
                  <span className="mb-3 rounded-full bg-panel-2 p-3 text-ocean ring-1 ring-line-2">
                    <Icon name="cube" className="h-6 w-6" />
                  </span>
                  <span className="font-semibold">Create your first object type</span>
                  <span className="mt-1 text-sm text-muted">For example “AIP PDF Extract” with a PDF and its extracted content.</span>
                </button>
              ) : (
                <>
                  {(groups.length > 0 || checked.size > 0) && (
                    <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs">
                      {groups.length > 0 && <span className="text-muted">Groups</span>}
                      {groups.map((g) => (
                        <button
                          key={g.id}
                          type="button"
                          onClick={() => setGroup(group === g.id ? null : g.id)}
                          className={`rounded-full px-2 py-0.5 ring-1 ${group === g.id ? "bg-ocean/15 text-ocean ring-ocean/40" : "text-muted ring-line-2 hover:text-white"}`}
                        >
                          {g.name} <span className="tabular-nums">{g.object_type_ids.length}</span>
                        </button>
                      ))}
                      {checked.size > 0 && (
                        <span className="ml-auto flex items-center gap-2">
                          {checked.size} selected
                          <select
                            value=""
                            onChange={async (e) => {
                              const status = e.target.value as ObjectType["status"];
                              if (!status) return;
                              for (const id of checked) {
                                const t = inOntology.find((x) => x.id === id)!;
                                const c = await statusChange(t, status);
                                if (!c) return;
                                if (!(await saveOrBranch("object_type", t, c, () => ontology.updateObjectType(t.id, c), go))) break;
                              }
                              setChecked(new Set());
                              load();
                            }}
                            className="rounded border border-line-2 bg-ink px-1.5 py-1"
                          >
                            <option value="">Edit status…</option>
                            <option value="experimental">Experimental</option>
                            <option value="active">Active</option>
                            <option value="deprecated">Deprecated</option>
                            <option value="example">Example</option>
                          </select>
                        </span>
                      )}
                    </div>
                  )}
                  <div className="mt-3 overflow-hidden rounded-xl border border-line bg-panel">
                    <table className="w-full text-sm">
                      <thead className="border-b border-line text-left text-xs text-muted">
                        <tr>
                          <th className="w-8 px-3 py-2.5" />
                          <th className="px-4 py-2.5 font-medium">Name</th>
                          <th className="px-4 py-2.5 font-medium">API name</th>
                          <th className="px-4 py-2.5 font-medium">Status</th>
                          <th className="px-4 py-2.5 text-right font-medium">Properties</th>
                          <th className="px-4 py-2.5 text-right font-medium">Objects</th>
                          <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                          <th className="px-4 py-2.5 font-medium">Updated</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {shownTypes.map((t) => (
                          <tr key={t.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-panel-2" onClick={() => router.push(`/ontology/${t.id}`)}>
                            <td className="px-3" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={checked.has(t.id)}
                                onChange={(e) => {
                                  const n = new Set(checked);
                                  if (e.target.checked) n.add(t.id);
                                  else n.delete(t.id);
                                  setChecked(n);
                                }}
                              />
                            </td>
                            <td className="px-4 py-2.5">
                              <span className="flex items-center gap-2 font-medium">
                                <TypeIcon t={t} />
                                {t.display_name}
                                {t.visibility === "prominent" && <Icon name="star" className="h-3 w-3 text-sand" />}
                                {t.protected && <span className="rounded bg-warn/15 px-1 text-[10px] text-warn">protected</span>}
                              </span>
                              {(t.groups ?? []).length > 0 && (
                                <span className="ml-8 text-[11px] text-muted">{(t.groups ?? []).map((g) => groups.find((x) => x.id === g)?.name ?? g).join(", ")}</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-xs text-soft">{t.api_name}</td>
                            <td className="px-4 py-2.5">
                              <Badge status={t.status} />
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{t.properties.length}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{t.object_count.toLocaleString()}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{t.action_type_count}</td>
                            <td className="px-4 py-2.5 text-xs text-muted">{when(t.updated_at)}</td>
                            <td className="px-2" onClick={(e) => e.stopPropagation()}>
                              <ActionMenu
                                items={[
                                  { label: "Open", icon: "external", onClick: () => router.push(`/ontology/${t.id}`) },
                                  { label: "Explore objects", icon: "search", onClick: () => router.push(`/object-explorer?type=${t.id}`) },
                                  "divider",
                                  {
                                    label: "Delete",
                                    icon: "trash",
                                    danger: true,
                                    onClick: async () => {
                                      if (!(await confirmDialog(`Delete "${t.display_name}" with its ${t.object_count} objects, action types and automations?`))) return;
                                      if (await saveOrBranch("object_type", t, {}, () => ontology.deleteObjectType(t.id), go)) load();
                                    },
                                  },
                                ]}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )
            ) : tab === "action-types" ? (
              <div className="mt-6 overflow-hidden rounded-xl border border-line bg-panel">
                {shownActions.length === 0 ? (
                  <p className="p-6 text-center text-sm text-muted">No action types yet. Open an object type to add one.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="border-b border-line text-left text-xs text-muted">
                      <tr>
                        <th className="px-4 py-2.5 font-medium">Name</th>
                        <th className="px-4 py-2.5 font-medium">Kind</th>
                        <th className="px-4 py-2.5 font-medium">Object type</th>
                        <th className="px-4 py-2.5 font-medium">Status</th>
                        <th className="px-4 py-2.5 text-right font-medium">Parameters</th>
                        <th className="px-4 py-2.5 font-medium">Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownActions.map((a) => (
                        <tr key={a.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-panel-2" onClick={() => router.push(`/ontology/action-types/${a.id}`)}>
                          <td className="px-4 py-2.5">
                            <span className="flex items-center gap-2 font-medium">
                              <Icon name={a.kind === "delete" ? "trash" : "edit"} className="h-4 w-4 text-ok" /> {a.display_name}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-soft">{ACTION_KIND_LABEL[a.kind]}</td>
                          <td className="px-4 py-2.5 text-soft">{a.object_type_id ? typeName[a.object_type_id] : "Interface action"}</td>
                          <td className="px-4 py-2.5">
                            <Badge status={a.status ?? "experimental"} />
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{a.parameters.length}</td>
                          <td className="px-4 py-2.5 text-xs text-muted">{when(a.updated_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : tab === "link-types" ? (
              <LinkTypesTab ontologyId={ont?.id ?? "default"} types={types} query={query} go={go} />
            ) : tab === "interfaces" ? (
              <InterfacesTab ontologyId={ont?.id ?? "default"} query={query} go={go} />
            ) : tab === "shared-properties" ? (
              <SharedPropertiesTab ontologyId={ont?.id ?? "default"} query={query} go={go} />
            ) : tab === "groups" ? (
              <GroupsTab ontologyId={ont?.id ?? "default"} types={types} />
            ) : tab === "branches" ? (
              <BranchesTab ontologyId={ont?.id ?? "default"} go={go} />
            ) : (
              <OntologiesTab current={ont?.id ?? "default"} onChanged={load} />
            )}
          </div>
        </section>
      </div>
      {creating && <ObjectTypeWizard ontologyId={ont?.id ?? "default"} onClose={() => setCreating(false)} onCreated={(t, warnings) => router.push(`/ontology/${t.id}?created=1${warnings.length ? `&warn=${encodeURIComponent(warnings.join("\n"))}` : ""}`)} />}
      {linking && <NewLinkTypeDialog types={inOntology} onClose={() => setLinking(false)} onDone={() => (setLinking(false), setTab("link-types"), load())} go={go} />}
    </div>
  );
}

/** "New": every Nexus resource, as in Foundry's Ontology Manager. */
function NewResourceMenu({ onObjectType, onLinkType, onTab, go }: { onObjectType: () => void; onLinkType: () => void; onTab: (t: Tab) => void; go: (h: string) => void }) {
  const [open, setOpen] = useState(false);
  const items: { label: string; hint: string; icon: IconName; run: () => void; divider?: boolean }[] = [
    { label: "Object type", hint: "Map datasets and models to object types", icon: "cube", run: onObjectType },
    { label: "Link type", hint: "Create relationships between object types (1:1, 1:M, M:N)", icon: "link", run: onLinkType },
    { label: "Action type", hint: "Allow users to write back to their Nexus", icon: "edit", run: () => onTab("action-types") },
    { label: "Shared property", hint: "Create properties that can be shared across object types", icon: "globe", run: () => onTab("shared-properties"), divider: true },
    { label: "Group", hint: "Use groups to create Nexus taxonomies", icon: "grid", run: () => onTab("groups") },
    { label: "Interface", hint: "Use interfaces to build against abstract types", icon: "layers", run: () => onTab("interfaces") },
    { label: "Function", hint: "Define object modifications and business logic in code", icon: "code", run: () => go("/functions?new=logic") },
    { label: "Value type", hint: "Define constraints that can be applied to property values", icon: "check", run: () => go("/value-types") },
  ];
  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <button type="button" onClick={() => setOpen(!open)} className={buttonClass.primary} data-new-resource>
        <Icon name="plus" /> New <Icon name="down" className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-80 rounded-xl border border-line-2 bg-panel p-1 shadow-2xl">
          {items.map((i) => (
            <div key={i.label}>
              {i.divider && <div className="my-1 border-t border-line" />}
              <button type="button" onClick={() => (setOpen(false), i.run())} className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-panel-2" data-new-item={i.label}>
                <Icon name={i.icon} className="mt-0.5 h-4 w-4 text-ocean" />
                <span>
                  <span className="block text-sm text-white">{i.label}</span>
                  <span className="block text-xs text-muted">{i.hint}</span>
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
