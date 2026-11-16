"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ActionMenu } from "@/components/kg/parts";
import { Badge, Card } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { alertDialog, confirmDialog, promptDialog } from "@/lib/dialogs";
import { IconColor } from "@/components/ontology/Datasources";
import { ImplementationDialog } from "@/components/ontology/Interfaces";
import { LinkTypeWizard } from "@/components/ontology/LinkTypeWizard";
import { ontology, type Implementation, type ObjectType } from "@/lib/ontology";
import {
  CARDINALITY_LABEL,
  LINK_KIND_LABEL,
  om,
  saveToNewBranch,
  type Group,
  type Interface,
  type LinkType,
  type Ontology,
  type ResourceKind,
} from "@/lib/ontologyModel";

/**
 * Save a change to main; a protected resource (or an ontology protecting main) instead goes to a new branch
 * ("Create and save to branch"), which opens. Returns true when main was changed.
 */
export async function saveOrBranch(
  kind: ResourceKind,
  rec: { id: string; ontology_id?: string; display_name?: string },
  changes: Record<string, unknown>,
  save: () => Promise<unknown>,
  go: (href: string) => void,
): Promise<boolean> {
  try {
    await save();
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    if (!/protected/i.test(msg)) {
      void alertDialog(msg);
      return false;
    }
    const name = await promptDialog(`${rec.display_name ?? "This resource"} is protected: changes go to a branch and merge with a proposal. Name the new branch:`, `Edit ${rec.display_name ?? ""}`.trim(), {
      title: "Create and save to branch",
    });
    if (!name) return false;
    try {
      const b = await saveToNewBranch(name, rec.ontology_id ?? "default", kind, rec.id, { ...rec, ...changes });
      go(`/ontology/branches/${b.id}`);
    } catch (err) {
      void alertDialog((err as Error).message);
    }
    return false;
  }
}

/** Aliases, groups, visibility, ontology, protection and deprecation of an object type. */
export function MetadataCard({ t, onChanged, go }: { t: ObjectType; onChanged: () => void; go: (href: string) => void }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [onts, setOnts] = useState<Ontology[]>([]);
  const [alias, setAlias] = useState("");
  useEffect(() => {
    om.groups().then(setGroups, () => setGroups([]));
    om.ontologies().then(setOnts, () => setOnts([]));
  }, []);
  const save = async (changes: Partial<ObjectType>) => {
    if (await saveOrBranch("object_type", t, changes, () => ontology.updateObjectType(t.id, changes), go)) onChanged();
  };
  const ont = onts.find((o) => o.id === (t.ontology_id ?? "default"));
  return (
    <Card title="Metadata">
      <div className="space-y-3 p-4 text-sm">
        <div className="grid grid-cols-[140px_1fr] items-start gap-3">
          <span className="pt-1 text-muted">Icon</span>
          <IconColor icon={t.icon} color={t.color} onChange={(c) => save(c)} />
          <span className="pt-1 text-muted">Aliases</span>
          <div>
            <div className="flex flex-wrap gap-1.5">
              {(t.aliases ?? []).map((a) => (
                <span key={a} className="flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5 text-xs ring-1 ring-line-2">
                  {a}
                  <button type="button" onClick={() => save({ aliases: (t.aliases ?? []).filter((x) => x !== a) })} className="text-muted hover:text-bad">
                    <Icon name="x" className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (alias.trim()) save({ aliases: [...(t.aliases ?? []), alias.trim()] }).then(() => setAlias(""));
                }}
              >
                <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Add an alias (searchable)" className={`${fieldClass} w-48 py-0.5 text-xs`} />
              </form>
            </div>
          </div>
          <span className="pt-1 text-muted">Groups</span>
          <div className="flex flex-wrap gap-1.5">
            {groups.map((g) => {
              const on = (t.groups ?? []).includes(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => save({ groups: on ? (t.groups ?? []).filter((x) => x !== g.id) : [...(t.groups ?? []), g.id] })}
                  className={`rounded-full px-2 py-0.5 text-xs ring-1 ${on ? "bg-ocean/15 text-ocean ring-ocean/40" : "text-muted ring-line-2 hover:text-white"}`}
                >
                  {g.name}
                </button>
              );
            })}
            {groups.length === 0 && <span className="text-xs text-muted">No groups yet (Nexus Manager → Groups)</span>}
          </div>
          <span className="pt-1 text-muted">Visibility</span>
          <select value={t.visibility ?? "normal"} onChange={(e) => save({ visibility: e.target.value as ObjectType["visibility"] })} className={`${inputClass} max-w-xs`}>
            <option value="prominent">Prominent</option>
            <option value="normal">Normal</option>
            <option value="hidden">Hidden</option>
          </select>
          <span className="pt-1 text-muted">Nexus</span>
          <span className="pt-1">
            {ont?.name ?? t.ontology_id ?? "Default ontology"}
            {ont && <span className="ml-1 text-xs capitalize text-muted">({ont.kind})</span>}
          </span>
          <span className="pt-1 text-muted">Protection</span>
          <label className="flex items-center gap-2 pt-1 text-xs text-soft">
            <input type="checkbox" checked={!!t.protected} onChange={(e) => save({ protected: e.target.checked })} />
            Protected: changes to main go through branch proposals
            {ont?.protect_main && <span className="text-warn">(the ontology protects main)</span>}
          </label>
          {t.status === "deprecated" && (
            <>
              <span className="pt-1 text-muted">Deprecation</span>
              <div className="text-xs text-soft">
                {t.deprecation?.reason}
                {t.deprecation?.deadline ? ` · deleted after ${t.deprecation.deadline}` : ""}
                {t.deprecation?.replaced_by ? ` · replaced by ${t.deprecation.replaced_by}` : ""}
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Ask for the deprecation details (and whether to activate every property) when the status changes. */
export async function statusChange(t: ObjectType, status: ObjectType["status"]): Promise<Partial<ObjectType> & { apply_status_to_properties?: boolean } | null> {
  if (status === "deprecated") {
    const reason = await promptDialog("Why is this object type deprecated?", "", { title: "Deprecate object type" });
    if (!reason) return null;
    const deadline = await promptDialog("When will it be deleted? (YYYY-MM-DD, optional)", "", { title: "Deprecation deadline" });
    const replaced = await promptDialog("Which object type replaces it? (optional)", "", { title: "Replacement" });
    return { status, deprecation: { reason, deadline: deadline || null, replaced_by: replaced || null } };
  }
  if (status === "active" && t.status !== "active") {
    const all = await confirmDialog({ title: "Make active", message: "Also apply the active status to every property?", confirmLabel: "Yes, all properties", cancelLabel: "Only the object type" });
    return { status, apply_status_to_properties: all };
  }
  return { status };
}

/** The link types of an object type, with a helper to create one. */
export function LinkTypesCard({ t, types, go }: { t: ObjectType; types: ObjectType[]; go: (href: string) => void }) {
  const [links, setLinks] = useState<LinkType[] | null>(null);
  const [creating, setCreating] = useState(false);
  const load = () => om.linkTypes({ object_type_id: t.id }).then(setLinks, () => setLinks([]));
  useEffect(() => {
    om.linkTypes({ object_type_id: t.id }).then(setLinks, () => setLinks([]));
  }, [t.id]);
  const name = (id: string) => types.find((x) => x.id === id)?.display_name ?? id;
  return (
    <Card
      title="Link types"
      count={links?.length}
      action={
        <button className={buttonClass.ghost} onClick={() => setCreating(true)}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New
        </button>
      }
    >
      <ul className="p-2 text-sm">
        {links?.length === 0 && <li className="px-2 py-1.5 text-muted">No links to other object types</li>}
        {links?.map((lt) => {
          const out = lt.source.object_type_id === t.id;
          const other = out ? lt.target : lt.source;
          return (
            <li key={lt.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-panel-2">
              <Icon name="link" className="h-3.5 w-3.5 text-ocean" />
              <span className="truncate">
                {other.display_name} <span className="text-xs text-muted">→ {name(other.object_type_id)}</span>
              </span>
              <span className="ml-auto text-xs text-muted">{CARDINALITY_LABEL[lt.cardinality]}</span>
              <Badge status={lt.status} />
              <ActionMenu
                items={[
                  {
                    label: "Delete link type",
                    icon: "trash",
                    danger: true,
                    onClick: async () => {
                      if (!(await confirmDialog(`Delete the link type "${lt.display_name}"?`))) return;
                      if (await saveOrBranch("link_type", lt, {}, () => om.deleteLinkType(lt.id), go)) load();
                    },
                  },
                ]}
              />
            </li>
          );
        })}
      </ul>
      {creating && <NewLinkTypeDialog from={t} types={types} onClose={() => setCreating(false)} onDone={() => (setCreating(false), load())} go={go} />}
    </Card>
  );
}

/** New link type: the three-step wizard (relationship type, link resources, link type names). */
export function NewLinkTypeDialog(props: { from?: ObjectType; types: ObjectType[]; onClose: () => void; onDone: () => void; go: (href: string) => void }) {
  return <LinkTypeWizard {...props} />;
}

/** Interfaces the object type implements, with their property, link type and action type mappings. */
export function InterfacesCard({ t, onChanged, go }: { t: ObjectType; onChanged: () => void; go: (href: string) => void }) {
  const [ifaces, setIfaces] = useState<Interface[]>([]);
  const [editing, setEditing] = useState<{ iface: Interface; current?: Implementation } | null>(null);
  useEffect(() => {
    om.interfaces().then(setIfaces, () => setIfaces([]));
  }, []);
  const impl = t.implements ?? [];
  const save = async (next: Implementation[]) => {
    if (await saveOrBranch("object_type", t, { implements: next }, () => ontology.updateObjectType(t.id, { implements: next }), go)) {
      setEditing(null);
      onChanged();
    }
  };
  return (
    <Card
      title="Interfaces"
      count={impl.length}
      action={
        <select
          value=""
          onChange={(e) => {
            const i = ifaces.find((x) => x.id === e.target.value);
            if (i) setEditing({ iface: i });
          }}
          className="rounded-md border border-line-2 bg-ink px-2 py-1 text-xs"
        >
          <option value="">Implement new interface…</option>
          {ifaces
            .filter((i) => !impl.some((x) => x.interface_id === i.id))
            .map((i) => (
              <option key={i.id} value={i.id}>
                {i.display_name}
              </option>
            ))}
        </select>
      }
    >
      <ul className="p-2 text-sm">
        {impl.length === 0 && <li className="px-2 py-1.5 text-muted">Implements no interfaces</li>}
        {impl.map((x) => {
          const i = ifaces.find((y) => y.id === x.interface_id);
          const nLinks = Object.keys(x.links ?? {}).length;
          const nActs = Object.keys(x.actions ?? {}).length;
          return (
            <li key={x.interface_id} className="rounded-md px-2 py-1.5 hover:bg-panel-2">
              <div className="flex items-center gap-2">
                <span className="rounded border border-dashed border-sand/60 p-0.5">
                  <Icon name="layers" className="h-3 w-3 text-sand" />
                </span>
                <Link href={`/ontology/interfaces/${x.interface_id}`} className="hover:underline">
                  {i?.display_name ?? x.interface_id}
                </Link>
                <ActionMenu
                  className="ml-auto"
                  items={[
                    { label: "Edit mappings", icon: "pencil", onClick: () => i && setEditing({ iface: i, current: x }) },
                    "divider",
                    {
                      label: "Remove interface",
                      icon: "trash",
                      danger: true,
                      onClick: async () => {
                        if (await confirmDialog(`Remove the implementation of ${i?.display_name ?? "this interface"}?`)) await save(impl.filter((y) => y.interface_id !== x.interface_id));
                      },
                    },
                  ]}
                />
              </div>
              <div className="mt-0.5 pl-6 text-xs text-muted">
                {Object.entries(x.mapping ?? {})
                  .map(([a, b]) => `${a} ← ${b}`)
                  .join(" · ")}
                {nLinks ? ` · ${nLinks} link${nLinks === 1 ? "" : "s"}` : ""}
                {nActs ? ` · ${nActs} action${nActs === 1 ? "" : "s"}` : ""}
              </div>
            </li>
          );
        })}
      </ul>
      {editing && (
        <ImplementationDialog
          t={t}
          iface={editing.iface}
          current={editing.current}
          onClose={() => setEditing(null)}
          onSave={(next) => save(editing.current ? impl.map((y) => (y.interface_id === next.interface_id ? next : y)) : [...impl, next])}
        />
      )}
    </Card>
  );
}

/** Related resources (Workshop modules, Quiver analyses, links) and header properties of the Object View. */
export function ObjectViewCard({ t, onChanged }: { t: ObjectType; onChanged: () => void }) {
  const cfg = t.object_view ?? { related: [], header_properties: [] };
  const [draft, setDraft] = useState<{ kind: "workshop" | "quiver" | "url"; id: string; label: string }>({ kind: "url", id: "", label: "" });
  const save = async (next: NonNullable<ObjectType["object_view"]>) => {
    try {
      await om.saveObjectView(t.id, next);
      onChanged();
    } catch (e) {
      void alertDialog((e as Error).message);
    }
  };
  return (
    <Card title="Object View" action={<span className="text-xs font-normal text-muted">The hub of each {t.display_name}</span>}>
      <div className="space-y-3 p-4 text-sm">
        <div>
          <div className="mb-1 text-xs text-muted">Header properties</div>
          <div className="flex flex-wrap gap-1.5">
            {t.properties
              .filter((p) => p.visibility !== "hidden")
              .map((p) => {
                const on = cfg.header_properties.includes(p.api_name);
                return (
                  <button
                    key={p.api_name}
                    type="button"
                    onClick={() => save({ ...cfg, header_properties: on ? cfg.header_properties.filter((x) => x !== p.api_name) : [...cfg.header_properties, p.api_name] })}
                    className={`rounded-full px-2 py-0.5 text-xs ring-1 ${on ? "bg-ocean/15 text-ocean ring-ocean/40" : "text-muted ring-line-2 hover:text-white"}`}
                  >
                    {p.display_name}
                  </button>
                );
              })}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs text-muted">Related resources</div>
          {cfg.related.map((r, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5 text-xs">
              <Icon name={r.kind === "workshop" ? "device" : r.kind === "quiver" ? "wave" : "external"} className="h-3.5 w-3.5 text-muted" />
              {r.label}
              <span className="text-muted">{r.kind === "url" ? r.url : r.id}</span>
              <button type="button" onClick={() => save({ ...cfg, related: cfg.related.filter((_, j) => j !== i) })} className="ml-auto text-muted hover:text-bad">
                <Icon name="x" className="h-3 w-3" />
              </button>
            </div>
          ))}
          <div className="mt-1 flex gap-1.5">
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as typeof draft.kind })} className={`${fieldClass} py-1 text-xs`}>
              <option value="url">Link</option>
              <option value="workshop">Workshop module</option>
              <option value="quiver">Quiver analysis</option>
            </select>
            <input value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} placeholder={draft.kind === "url" ? "https://… ({pk} is the object)" : "Module or analysis ID"} className={`${fieldClass} min-w-0 flex-1 py-1 text-xs`} />
            <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Label" className={`${fieldClass} w-28 py-1 text-xs`} />
            <button
              type="button"
              disabled={!draft.id || !draft.label}
              onClick={() =>
                save({ ...cfg, related: [...cfg.related, draft.kind === "url" ? { kind: "url", url: draft.id, label: draft.label } : { kind: draft.kind, id: draft.id, label: draft.label }] }).then(() =>
                  setDraft({ kind: "url", id: "", label: "" }),
                )
              }
              className={buttonClass.secondary}
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** A link to an object's Object View. */
export function ObjectViewLink({ typeId, pk, children, className = "" }: { typeId: string; pk: string; children: React.ReactNode; className?: string }) {
  return (
    <Link href={`/ontology/objects/${typeId}/${encodeURIComponent(pk)}`} className={className}>
      {children}
    </Link>
  );
}

export { LINK_KIND_LABEL };
