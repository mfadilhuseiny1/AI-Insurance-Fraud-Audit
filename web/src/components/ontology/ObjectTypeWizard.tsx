"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { datasources, IconColor, TypeIcon } from "@/components/ontology/Datasources";
import { ErrorBox } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { auth, type Group as UserGroup, type User } from "@/lib/auth";
import { ontology, PROPERTY_TYPES, request, typeIcon, type ObjectType, type PropertyType } from "@/lib/ontology";
import { om, type Group } from "@/lib/ontologyModel";
import { workshop } from "@/lib/workshop";
import { codeRepos } from "@/lib/codeRepos";
import { pluralOf, WizardShell } from "./Wizard";

/* Create an object type in four steps, as in Foundry's Ontology Manager:
   1. Datasource — continue without one (a dataset is generated, for permissions and for rows written later) or back
      it with an existing dataset (one object per row);
   2. Metadata — icon and color, name, plural name, description, groups;
   3. Properties — each source column mapped to a property (name and type) or properties typed in, the primary key and
      the title;
   4. Actions — generate Create / Modify / Delete action types and choose who can submit them.
   The new object type opens on its Overview. */

type Row = { column: string | null; include: boolean; display: string; api: string; type: PropertyType; array?: boolean; unique?: boolean; supported?: boolean };

const camel = (s: string) => {
  const w = s.match(/[A-Za-z0-9]+/g) ?? [];
  const c = w.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1) : x[0].toLowerCase() + x.slice(1))).join("");
  return c;
};
const titleCase = (s: string) => s.replace(/\.parquet$/i, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Submission criteria letting only these users and groups run an action (none: everyone in the organization). */
function runnersCriteria(users: string[], groups: string[]) {
  const children = [
    ...(users.length ? [{ kind: "condition", left: { kind: "current_user_id" }, op: "included_in", value: { kind: "static", value: users } }] : []),
    ...(groups.length ? [{ kind: "condition", left: { kind: "current_user_groups" }, op: "includes_any", value: { kind: "static", value: groups } }] : []),
  ];
  return children.length ? [{ kind: "or", children, failure_message: "Only the users and groups chosen when the object type was created can run this action" }] : [];
}

export function ObjectTypeWizard({ ontologyId, onClose, onCreated }: { ontologyId: string; onClose: () => void; onCreated: (t: ObjectType, warnings: string[]) => void }) {
  const [step, setStep] = useState(0);
  // 1. datasource
  const [mode, setMode] = useState<"none" | "dataset">("dataset");
  const [datasets, setDatasets] = useState<{ id: string; name: string; path: string[] }[]>([]);
  const [dsFind, setDsFind] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [dsInfo, setDsInfo] = useState<{ name: string; rows: number; registered: string | null } | null>(null);
  // without a datasource: the Project the generated dataset goes to (the user's Editor Projects)
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState("");
  // 2. metadata
  const [name, setName] = useState("");
  const [plural, setPlural] = useState("");
  const [description, setDescription] = useState("");
  const [look, setLook] = useState<{ icon?: string; color?: string }>({ icon: "cube", color: "#4f8cff" });
  const [iconOpen, setIconOpen] = useState(false);
  const [typeGroups, setTypeGroups] = useState<string[]>([]);
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  // 3. properties
  const [rows, setRows] = useState<Row[]>([{ column: null, include: true, display: "ID", api: "id", type: "string" }]);
  const [pk, setPk] = useState("id");
  const [title, setTitle] = useState("id");
  // 4. actions
  const [kinds, setKinds] = useState<("create" | "modify" | "delete")[]>(["create", "modify"]);
  const [who, setWho] = useState<"organization" | "group" | "user">("organization");
  const [runGroups, setRunGroups] = useState<string[]>([]);
  const [runUsers, setRunUsers] = useState<string[]>([]);
  const [people, setPeople] = useState<{ users: User[]; groups: UserGroup[] }>({ users: [], groups: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    workshop.sources().then((s) => setDatasets(s.datasets), () => setDatasets([]));
    codeRepos.projects().then(
      (r) => {
        const list = [...r.projects.filter((x) => !x.default), ...r.projects.filter((x) => x.default)].filter((x) => x.my_role === "editor" || x.my_role === "owner");
        setProjects(list.map((x) => ({ id: x.id, name: x.name })));
        setProjectId((cur) => cur || list[0]?.id || "");
      },
      () => setProjects([]),
    );
    om.groups().then(setAllGroups, () => setAllGroups([]));
    Promise.all([auth.users().catch(() => [] as User[]), auth.groups().catch(() => [] as UserGroup[])]).then(([users, groups]) => setPeople({ users, groups }));
  }, []);

  const pickDataset = async (id: string) => {
    setDatasetId(id);
    setError(null);
    setDsInfo(null);
    try {
      const s = await datasources.schema(id);
      setDsInfo({ name: s.name, rows: s.rows, registered: s.registered_by?.display_name ?? null });
      setName((n) => n || titleCase(s.name));
      const rs: Row[] = s.columns.map((c) => ({
        column: c.name,
        include: c.supported,
        display: c.display_name ?? titleCase(c.name),
        api: c.api_name ?? camel(c.name),
        type: (c.property_type ?? "string") as PropertyType,
        array: c.array,
        unique: c.unique,
        supported: c.supported,
      }));
      setRows(rs);
      const key = rs.find((r) => r.unique)?.api ?? rs[0]?.api ?? "";
      setPk(key);
      setTitle(rs.find((r) => /name|title|judul|nama/i.test(r.display) && r.supported)?.api ?? key);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const included = rows.filter((r) => r.include && r.display.trim());
  const keyable = included.filter((r) => (mode === "dataset" ? r.unique : ["string", "integer", "long", "short"].includes(r.type)));
  const pkEff = keyable.some((r) => r.api === pk) ? pk : (keyable[0]?.api ?? "");
  const titleEff = included.some((r) => r.api === title) ? title : pkEff;
  const pluralEff = plural.trim() || (name.trim() ? pluralOf(name) : "");
  const ok = [mode === "none" || (!!datasetId && !!dsInfo && !dsInfo.registered), !!name.trim(), included.length > 0 && !!pkEff, true];
  const canVisit = (i: number) => ok.slice(0, i).every(Boolean);
  const filteredDs = useMemo(() => datasets.filter((d) => !/\(test\)/i.test(`${d.name} ${d.path.join(" ")}`) && (!dsFind || `${d.name} ${d.path.join(" ")}`.toLowerCase().includes(dsFind.toLowerCase()))).slice(0, 80), [datasets, dsFind]);

  const create = async () => {
    setBusy(true);
    setError(null);
    const criteria = who === "organization" ? [] : runnersCriteria(who === "user" ? runUsers : [], who === "group" ? runGroups : []);
    try {
      let t: ObjectType;
      if (mode === "dataset") {
        t = await datasources.fromDataset({
          dataset_id: datasetId,
          display_name: name.trim(),
          plural_name: pluralEff || undefined,
          description: description.trim(),
          ...look,
          ontology_id: ontologyId,
          groups: typeGroups,
          primary_key: rows.find((r) => r.api === pkEff)?.column,
          title_property: rows.find((r) => r.api === titleEff)?.column,
          columns: included.map((r) => ({ column: r.column, api_name: r.api, display_name: r.display, type: r.type, array: r.array })),
          // with submitters chosen, the actions are made below with their submission criteria
          generate_actions: criteria.length ? [] : kinds,
        });
      } else {
        t = await ontology.createObjectType({
          display_name: name.trim(),
          description: description.trim(),
          ...(pluralEff ? { plural_name: pluralEff } : {}),
          ...look,
          properties: included.map((r) => ({ api_name: r.api, display_name: r.display, type: r.type })),
          primary_key: pkEff,
          title_property: titleEff,
          ontology_id: ontologyId,
          groups: typeGroups,
        });
      }
      // once the object type exists, the rest only warns: the type opens either way (no half-made retry, no duplicate)
      const warnings: string[] = [];
      if (mode === "none") {
        // the generated dataset: a column per property, registered as the datasource (permissions, rows written later)
        try {
          const folder =
            projectId ||
            (await codeRepos
              .projects()
              .then((r) => r.projects.find((x) => !x.default && (x.my_role === "editor" || x.my_role === "owner"))?.id)
              .catch(() => undefined));
          await request(`/object-types/${t.id}/datasource/generate`, { method: "POST", json: folder ? { folder_id: folder } : {} });
        } catch (e) {
          warnings.push(`No backing dataset was generated (${(e as Error).message}): add one in Datasources.`);
        }
      }
      if (mode === "none" || criteria.length)
        for (const kind of kinds)
          try {
            await ontology.createActionType({ object_type_id: t.id, kind, submission_criteria: criteria } as Parameters<typeof ontology.createActionType>[0]);
          } catch (e) {
            warnings.push(`The ${kind} action type was not created (${(e as Error).message}).`);
          }
      onCreated(t, warnings);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const propNames = included.map((r) => r.display);
  const listed = (names: string[]) => (names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")}, and ${names.length - 3} more properties`);

  return (
    <WizardShell
      title="Create a new object type"
      icon="cube"
      steps={["Datasource", "Metadata", "Properties", "Actions"]}
      step={step}
      onStep={setStep}
      canVisit={canVisit}
      onClose={onClose}
      footer={
        <>
          <ErrorBox message={error} />
          {step > 0 && (
            <button type="button" onClick={() => setStep(step - 1)} className={buttonClass.secondary}>
              Back
            </button>
          )}
          {step < 3 ? (
            <button type="button" disabled={!ok[step]} onClick={() => setStep(step + 1)} className={buttonClass.primary} data-wizard-next>
              Next
            </button>
          ) : (
            <button type="button" disabled={busy || !ok.every(Boolean)} onClick={create} className="rounded-md bg-ok px-3 py-1.5 text-sm font-medium text-ink hover:brightness-110 disabled:opacity-50" data-wizard-create>
              {busy ? "Creating…" : "Create"}
            </button>
          )}
        </>
      }
    >
      {step === 0 && (
        <>
          <div className="text-xs font-medium text-soft">Object type backing</div>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {(
              [
                ["none", "Continue without datasource", "Generate a dataset for permissions purposes; rows written to it later become objects.", "doc"],
                ["dataset", "Use existing datasource", "Select a dataset: one object per row, its columns become properties.", "table"],
              ] as const
            ).map(([k, l, h, i]) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setMode(k);
                  if (k === "none") setRows([{ column: null, include: true, display: "ID", api: "id", type: "string" }]);
                }}
                className={`flex items-start gap-3 rounded-xl border p-4 text-left ${mode === k ? "border-ocean bg-ocean/10" : "border-line-2 hover:border-ocean/50"}`}
                data-ds-mode={k}
              >
                <Icon name={i} className="mt-0.5 h-5 w-5 text-ocean" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-white">{l}</span>
                  <span className="block text-xs text-muted">{h}</span>
                </span>
                {mode === k && <Icon name="check" className="h-4 w-4 text-ocean" />}
              </button>
            ))}
          </div>
          {mode === "none" && (
            <label className="mt-4 block text-xs text-muted">
              Project for the generated dataset
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={`${inputClass} mt-1`}>
                {!projects.length && <option value="">Your documents folder</option>}
                {projects.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {mode === "dataset" && (
            <div className="mt-4">
              <div className="mb-1.5 text-xs font-medium text-soft">Select a datasource to back this object type</div>
              <div className="rounded-xl border border-line">
                <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                  <Icon name="search" className="h-3.5 w-3.5 text-muted" />
                  <input value={dsFind} onChange={(e) => setDsFind(e.target.value)} placeholder={datasetId && dsInfo ? dsInfo.name : "No datasource selected — search datasets…"} className="flex-1 bg-transparent text-sm outline-none" data-ds-search />
                </div>
                <div className="max-h-56 overflow-y-auto py-1">
                  {filteredDs.map((d) => (
                    <button key={d.id} type="button" onClick={() => pickDataset(d.id)} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${datasetId === d.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`} data-ds-option={d.name}>
                      <Icon name="table" className="h-3.5 w-3.5 text-ocean" />
                      <span className="min-w-0 flex-1 truncate">{d.name}</span>
                      <span className="max-w-[45%] truncate text-[10px] text-muted">{d.path.slice(-2).join(" / ")}</span>
                    </button>
                  ))}
                  {!filteredDs.length && <p className="px-3 py-2 text-xs text-muted">No dataset matches.</p>}
                </div>
              </div>
              {dsInfo && (
                <p className={`mt-2 text-xs ${dsInfo.registered ? "text-bad" : "text-muted"}`}>
                  {dsInfo.registered ? `This dataset already backs ${dsInfo.registered}: pick another one.` : `${dsInfo.name} · ${dsInfo.rows.toLocaleString()} rows → ${dsInfo.rows.toLocaleString()} objects`}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <p className="-mt-2 text-sm text-muted">Configure object type metadata.</p>
          <div className="grid gap-3 sm:grid-cols-[auto_1fr_1fr]">
            <div>
              <div className="mb-1 text-xs text-muted">Icon</div>
              <button type="button" onClick={() => setIconOpen(!iconOpen)} className="rounded-lg border border-line-2 p-2 hover:border-ocean/60" title="Icon and color">
                <TypeIcon t={look} className="h-5 w-5" box="rounded-md p-1" />
              </button>
            </div>
            <label className="text-xs text-muted">
              Name
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Flight Alert" className={`${inputClass} mt-1`} data-ot-name />
            </label>
            <label className="text-xs text-muted">
              Plural name
              <input value={plural} onChange={(e) => setPlural(e.target.value)} placeholder={pluralEff || "Flight Alerts"} className={`${inputClass} mt-1`} />
            </label>
          </div>
          {iconOpen && (
            <div className="rounded-xl border border-line bg-panel-2/30 p-3">
              <IconColor icon={look.icon} color={look.color} onChange={(c) => setLook({ ...look, ...c })} />
            </div>
          )}
          <label className="block text-xs text-muted">
            Description
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Enter optional description…" className={`${inputClass} mt-1`} />
          </label>
          <div>
            <div className="mb-1 text-xs text-muted">Groups (optional)</div>
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line-2 p-2">
              {typeGroups.map((g) => (
                <span key={g} className="flex items-center gap-1 rounded-full bg-ocean/15 px-2 py-0.5 text-xs text-ocean">
                  {allGroups.find((x) => x.id === g)?.name ?? g}
                  <button type="button" onClick={() => setTypeGroups(typeGroups.filter((x) => x !== g))} aria-label="Remove group">
                    <Icon name="x" className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {!typeGroups.length && <span className="text-xs text-muted">No group selected</span>}
              <select value="" onChange={(e) => e.target.value && setTypeGroups([...typeGroups, e.target.value])} className="ml-auto bg-transparent text-xs text-ocean outline-none">
                <option value="">+ Add to group</option>
                {allGroups
                  .filter((g) => !typeGroups.includes(g.id) && !/\(test\)/i.test(g.name))
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="overflow-hidden rounded-xl border border-line">
            <div className="flex items-center gap-2 border-b border-line bg-panel-2/40 px-3 py-2 text-xs text-muted">
              <span className="w-[38%]">Source</span>
              <span className="flex-1">Property</span>
              {mode === "none" && (
                <button type="button" onClick={() => setRows([...rows, { column: null, include: true, display: "", api: "", type: "string" }])} className="flex items-center gap-1 text-ocean hover:underline" data-add-property>
                  <Icon name="plus" className="h-3 w-3" /> Add property
                </button>
              )}
            </div>
            <div className="max-h-[42vh] overflow-y-auto">
              {rows.map((r, i) => (
                <div key={i} className={`flex items-center gap-2 border-b border-line/60 px-3 py-1.5 ${r.include ? "" : "opacity-50"}`}>
                  <div className="flex w-[38%] min-w-0 items-center gap-2">
                    {mode === "dataset" ? (
                      <>
                        <input type="checkbox" checked={r.include} disabled={!r.supported} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))} aria-label={`Include ${r.column}`} />
                        <Icon name="table" className="h-3.5 w-3.5 shrink-0 text-muted" />
                        <span className="truncate font-mono text-xs text-soft" title={r.column ?? ""}>
                          {r.column}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-muted">— typed in —</span>
                    )}
                  </div>
                  <div className="relative">
                    <Icon name={typeIcon(r.type)} className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted" />
                    <select value={r.type} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, type: e.target.value as PropertyType } : x)))} className="w-32 appearance-none rounded-md border border-line-2 bg-ink py-1.5 pl-7 pr-2 text-xs" aria-label="Property type">
                      {PROPERTY_TYPES.filter((t) => t.id !== "geotemporal_series_reference").map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <input
                    value={r.display}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, display: e.target.value, api: mode === "none" && (!x.api || x.api === camel(x.display)) ? camel(e.target.value) : x.api } : x)))}
                    placeholder="Property name"
                    className={`${inputClass} flex-1`}
                    data-prop-name={i}
                  />
                  {r.api === pkEff && r.include && <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] text-violet-200">Primary key</span>}
                  {r.api === titleEff && r.include && r.api !== pkEff && <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-200">Title</span>}
                  {mode === "none" && rows.length > 1 && (
                    <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} className="rounded p-1 text-muted hover:text-white" aria-label="Remove property">
                      <Icon name="x" className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted">
              Primary key {mode === "dataset" && <span className="text-[10px]">(a unique column)</span>}
              <select value={pkEff} onChange={(e) => setPk(e.target.value)} className={`${inputClass} mt-1 ${pkEff ? "" : "border-bad"}`}>
                {!keyable.length && <option value="">No unique property</option>}
                {keyable.map((r) => (
                  <option key={r.api} value={r.api}>
                    {r.display}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted">
              Title <span className="text-[10px]">(shown as the object&apos;s name)</span>
              <select value={titleEff} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} mt-1`}>
                {included.map((r) => (
                  <option key={r.api} value={r.api}>
                    {r.display}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-xs font-medium text-soft">Select action types to generate</div>
            <div className="overflow-hidden rounded-xl border border-line">
              {(
                [
                  ["create", "Create", `Set ${listed(propNames)}`, "plus"],
                  ["modify", "Modify", `Modify ${listed(propNames.filter((n) => n !== included.find((r) => r.api === pkEff)?.display))}`, "edit"],
                  ["delete", "Delete", "Allows deleting object instances and all of their properties", "trash"],
                ] as const
              ).map(([k, l, h, i]) => (
                <label key={k} className="flex cursor-pointer items-start gap-3 border-b border-line px-4 py-3 last:border-b-0 hover:bg-panel-2/40">
                  <input type="checkbox" checked={kinds.includes(k)} onChange={(e) => setKinds(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k))} className="mt-1" data-action-kind={k} />
                  <Icon name={i} className="mt-0.5 h-4 w-4 text-ocean" />
                  <span className="min-w-0">
                    <span className="block text-sm text-white">
                      {l} {name || "object"}
                    </span>
                    <span className="block truncate text-xs text-muted">{h}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className={kinds.length ? "" : "pointer-events-none opacity-40"}>
            <div className="mb-1.5 text-xs font-medium text-soft">Choose who can submit these action types</div>
            <div className="grid gap-2 sm:grid-cols-3">
              {(
                [
                  ["organization", "Organization", "home"],
                  ["group", "Group", "grid"],
                  ["user", "User", "eye"],
                ] as const
              ).map(([k, l, i]) => (
                <button key={k} type="button" onClick={() => setWho(k)} className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${who === k ? "border-ocean bg-ocean/10 text-white" : "border-line-2 text-soft hover:border-ocean/50"}`}>
                  <span className={`h-3.5 w-3.5 rounded-full border ${who === k ? "border-4 border-ocean" : "border-line-2"}`} />
                  <Icon name={i} className="h-4 w-4" /> {l}
                </button>
              ))}
            </div>
            {who !== "organization" && (
              <div className="mt-2 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-line p-2">
                {(who === "group" ? people.groups.map((g) => ({ id: g.id, label: g.name })) : people.users.map((u) => ({ id: u.id, label: u.display_name || u.username }))).map((x) => {
                  const list = who === "group" ? runGroups : runUsers;
                  const set = who === "group" ? setRunGroups : setRunUsers;
                  const on = list.includes(x.id);
                  return (
                    <button key={x.id} type="button" onClick={() => set(on ? list.filter((y) => y !== x.id) : [...list, x.id])} className={`rounded-full border px-2 py-0.5 text-xs ${on ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-soft"}`}>
                      {x.label}
                    </button>
                  );
                })}
                {!(who === "group" ? people.groups : people.users).length && <span className="text-xs text-muted">Nothing to choose from (administrators see users and groups).</span>}
              </div>
            )}
          </div>
        </div>
      )}
    </WizardShell>
  );
}
