"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { TypeIcon } from "@/components/ontology/Datasources";
import { ErrorBox } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { promptDialog } from "@/lib/dialogs";
import type { ObjectType } from "@/lib/ontology";
import { om, saveToNewBranch, type LinkType } from "@/lib/ontologyModel";
import { PropertyPicker, TypePicker, WizardShell } from "./Wizard";

/* Create a link type in three steps, as in Foundry's Ontology Manager:
   1. Relationship type — foreign key (one-to-one, many-to-one / one-to-many), join table or backing object type
      (many-to-many);
   2. Link resources — the two object types and the property holding the other's primary key;
   3. Link type names — "Each Flight Alert has one Flight" / "Each Flight has many Flight Alerts", each side's name
      and API name (.get() for one, .all() for many). */

type Kind = LinkType["kind"];

const KINDS: { kind: Kind; label: string; hint: string; use: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
  { kind: "foreign_key", label: "Object type foreign keys", hint: "Link object types using a foreign key property.", use: "one-to-one and one-to-many", icon: "plug" },
  { kind: "join_table", label: "Join table dataset", hint: "Link object types using a dataset with both object types' primary keys.", use: "many-to-many", icon: "table" },
  { kind: "object_backed", label: "Backing object type", hint: "Link object types through a middle object type that carries properties of its own.", use: "many-to-many links with properties", icon: "cube" },
];

const camel = (s: string) => {
  const w = s.match(/[A-Za-z0-9]+/g) ?? [];
  const c = w.map((x) => x[0].toUpperCase() + x.slice(1)).join("");
  return c ? c[0].toLowerCase() + c.slice(1) : "";
};

/** The picture of a relationship: dots on the left, dots on the right, lines between them (a branch for "many"). */
function RelationDiagram({ kind, left, right, mid }: { kind: Kind; left?: ObjectType; right?: ObjectType; mid?: ObjectType }) {
  const node = (x: number, y: number, t?: ObjectType) => (
    <g transform={`translate(${x - 10} ${y - 10})`}>
      <rect width="20" height="20" rx="5" className="fill-panel-2 stroke-line-2" />
      <foreignObject x="2" y="2" width="16" height="16">
        <div className="flex h-4 w-4 items-center justify-center" style={{ color: t?.color ?? "var(--color-ocean)" }}>
          <Icon name={(t?.icon as Parameters<typeof Icon>[0]["name"]) ?? "cube"} className="h-3 w-3" />
        </div>
      </foreignObject>
    </g>
  );
  const line = (d: string) => <path d={d} fill="none" className="stroke-soft/60" strokeWidth="1.5" />;
  return (
    <svg viewBox="0 0 360 110" className="h-28 w-full" role="img" aria-label="Relationship diagram">
      {kind === "foreign_key" && (
        <>
          {line("M40 22 H320")}
          {line("M40 55 H320")}
          {line("M40 88 H200 V55")}
          {node(30, 22, left)}
          {node(30, 55, left)}
          {node(30, 88, left)}
          {node(330, 22, right)}
          {node(330, 55, right)}
        </>
      )}
      {kind === "join_table" && (
        <>
          {line("M40 22 L320 22")}
          {line("M40 22 L320 88")}
          {line("M40 88 L320 22")}
          {line("M40 55 L320 88")}
          {node(30, 22, left)}
          {node(30, 55, left)}
          {node(30, 88, left)}
          {node(330, 22, right)}
          {node(330, 88, right)}
        </>
      )}
      {kind === "object_backed" && (
        <>
          {line("M40 22 L170 40 L320 22")}
          {line("M40 88 L170 70 L320 88")}
          {line("M40 22 L170 70")}
          {node(30, 22, left)}
          {node(30, 88, left)}
          {node(180, 40, mid)}
          {node(180, 70, mid)}
          {node(330, 22, right)}
          {node(330, 88, right)}
        </>
      )}
    </svg>
  );
}

export function LinkTypeWizard({ from, types, onClose, onDone, go }: { from?: ObjectType; types: ObjectType[]; onClose: () => void; onDone: () => void; go: (href: string) => void }) {
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<Kind>("foreign_key");
  const [many, setMany] = useState(true); // foreign key: each target has many sources (many-to-one) or one (one-to-one)
  const [source, setSource] = useState(from?.id ?? "");
  const [target, setTarget] = useState("");
  const [fk, setFk] = useState("");
  const [backing, setBacking] = useState({ object_type_id: "", source_property: "", target_property: "" });
  const [names, setNames] = useState<{ source?: string; target?: string; source_api?: string; target_api?: string }>({});
  const [linkName, setLinkName] = useState("");
  const [hierarchy, setHierarchy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const src = types.find((x) => x.id === source);
  const tgt = types.find((x) => x.id === target);
  const bt = types.find((x) => x.id === backing.object_type_id);
  const sourceMany = kind !== "foreign_key" || many;
  const targetMany = kind !== "foreign_key";
  // each side's name as seen from the other: the target from the source, the sources from the target
  const targetName = names.target ?? (targetMany ? tgt?.plural_name : tgt?.display_name) ?? "";
  const sourceName = names.source ?? (sourceMany ? src?.plural_name : src?.display_name) ?? "";
  const targetApi = names.target_api ?? camel(targetName);
  const sourceApi = names.source_api ?? camel(sourceName);

  // a property of the source named like the target's primary key is the likely foreign key
  const guessFk = (s?: ObjectType, t?: ObjectType) => {
    if (!s || !t) return "";
    const key = t.primary_key.toLowerCase();
    return (
      s.properties.find((p) => p.api_name.toLowerCase() === key)?.api_name ??
      s.properties.find((p) => p.api_name.toLowerCase().includes(key) || key.includes(p.api_name.toLowerCase()))?.api_name ??
      ""
    );
  };
  const ready1 = !!source && !!target && (kind !== "foreign_key" || !!fk) && (kind !== "object_backed" || (!!backing.object_type_id && !!backing.source_property && !!backing.target_property));
  const canVisit = (i: number) => i === 0 || (i === 1 && true) || (i === 2 && ready1);

  const submit = async () => {
    setError(null);
    setBusy(true);
    const body = {
      display_name: linkName.trim() || undefined,
      kind,
      cardinality: kind === "foreign_key" ? (many ? "many_to_one" : "one_to_one") : "many_to_many",
      source: { object_type_id: source, display_name: sourceName || undefined, plural_display_name: (sourceMany && sourceName) || undefined, api_name: sourceApi || undefined },
      target: { object_type_id: target, display_name: targetName || undefined, plural_display_name: (targetMany && targetName) || undefined, api_name: targetApi || undefined },
      foreign_key: kind === "foreign_key" ? fk : null,
      backing: kind === "object_backed" ? backing : null,
      type_classes: hierarchy ? ["hierarchy:parent"] : [],
    } as unknown as Partial<LinkType>;
    try {
      await om.createLinkType(body);
      onDone();
    } catch (e) {
      const msg = (e as Error).message;
      if (/protected/i.test(msg)) {
        const branch = await promptDialog("The ontology protects main: name a branch for the new link type", "New link type", { title: "Create and save to branch" });
        if (branch) {
          try {
            const b = await saveToNewBranch(branch, src?.ontology_id ?? "default", "link_type", "new", body as Record<string, unknown>);
            go(`/ontology/branches/${b.id}`);
          } catch (err) {
            setError((err as Error).message);
          }
        }
      } else setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const Chip = ({ t }: { t?: ObjectType }) => (
    <span className="inline-flex max-w-[14rem] items-center gap-1.5 rounded-md bg-panel-2 px-2 py-1 text-sm text-white ring-1 ring-line-2">
      <TypeIcon t={t ?? {}} className="h-3.5 w-3.5" box="rounded p-0.5" />
      <span className="truncate">{t?.display_name ?? "…"}</span>
    </span>
  );
  const sideCard = (opts: { each?: ObjectType; has: "one" | "many"; other?: ObjectType; hasPicker?: boolean; name: string; api: string; prefix: string; onName: (v: string) => void; onApi: (v: string) => void }) => (
    <div className="rounded-xl border border-line bg-panel-2/30 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-soft">
        Each <Chip t={opts.each} /> has
        {opts.hasPicker ? (
          <select value={many ? "many" : "one"} onChange={(e) => setMany(e.target.value === "many")} className="rounded-md border border-ocean/50 bg-ocean/10 px-2 py-1 text-sm text-white" data-link-many>
            <option value="many">many</option>
            <option value="one">one</option>
          </select>
        ) : (
          <strong className="text-white">{opts.has}</strong>
        )}
        <Chip t={opts.other} />
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-[80px_1fr] sm:items-center">
        <span className="text-xs text-muted">Name</span>
        <input value={opts.name} onChange={(e) => opts.onName(e.target.value)} className={inputClass} />
        <span className="text-xs text-muted">API name</span>
        <div className="flex items-center overflow-hidden rounded-md border border-line-2 bg-ink text-sm">
          <span className="max-w-[9rem] truncate border-r border-line-2 bg-panel-2 px-2 py-1.5 font-mono text-[11px] text-muted">{opts.prefix}.</span>
          <input value={opts.api} onChange={(e) => opts.onApi(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))} className="min-w-0 flex-1 bg-transparent px-2 py-1.5 font-mono text-xs outline-none" />
          <span className="border-l border-line-2 bg-panel-2 px-2 py-1.5 font-mono text-[11px] text-muted">{opts.has === "many" ? ".all()" : ".get()"}</span>
        </div>
      </div>
    </div>
  );

  return (
    <WizardShell
      title="Create a new link type"
      icon="link"
      steps={["Relationship type", "Link resources", "Link type names"]}
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
          {step < 2 ? (
            <button type="button" disabled={step === 1 && !ready1} onClick={() => setStep(step + 1)} className={buttonClass.primary} data-wizard-next>
              Next
            </button>
          ) : (
            <button type="button" disabled={busy || !ready1} onClick={submit} className={buttonClass.primary} data-wizard-create>
              {busy ? "Creating…" : "Create"}
            </button>
          )}
        </>
      }
    >
      {step === 0 && (
        <>
          <p className="mb-3 text-sm text-muted">Choose the method for defining links between instances.</p>
          <div className="overflow-hidden rounded-xl border border-line">
            {KINDS.map((k) => (
              <label key={k.kind} className={`block cursor-pointer border-b border-line p-4 last:border-b-0 ${kind === k.kind ? "bg-ocean/[0.07]" : "hover:bg-panel-2/40"}`}>
                <div className="flex items-start gap-3">
                  <input type="radio" checked={kind === k.kind} onChange={() => setKind(k.kind)} className="mt-1 accent-[var(--color-ocean)]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium text-white">
                      <Icon name={k.icon} className="h-4 w-4 text-ocean" /> {k.label}
                    </div>
                    <div className="text-xs text-muted">
                      {k.hint} Used for <strong className="text-soft">{k.use}</strong> link types.
                    </div>
                    {kind === k.kind && (
                      <div className="mt-2 rounded-lg border border-line bg-ink/60 px-4">
                        <RelationDiagram kind={k.kind} />
                      </div>
                    )}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </>
      )}

      {step === 1 && (
        <>
          <p className="mb-3 text-sm text-muted">
            {kind === "foreign_key"
              ? "Choose the object types you wish to link and the property to use as a foreign key."
              : kind === "join_table"
                ? "Choose the two object types: a join table holding both primary keys is generated for the links."
                : "Choose the two object types and the object type in the middle whose objects are the links."}
          </p>
          <div className="rounded-xl border border-line bg-ink/40 p-4">
            <RelationDiagram kind={kind} left={src} right={tgt} mid={bt} />
            <div className={`mt-2 grid items-start gap-3 ${kind === "object_backed" ? "md:grid-cols-3" : "md:grid-cols-[1fr_auto_1fr]"}`}>
              <div className="space-y-2">
                <TypePicker
                  types={types}
                  value={source}
                  onChange={(id) => {
                    setSource(id);
                    if (kind === "foreign_key") setFk(guessFk(types.find((x) => x.id === id), tgt));
                  }}
                />
                {kind === "foreign_key" && <PropertyPicker props={src?.properties ?? []} value={fk} onChange={setFk} placeholder="Foreign key property" />}
              </div>
              {kind === "object_backed" ? (
                <div className="space-y-2">
                  <TypePicker types={types} value={backing.object_type_id} onChange={(id) => setBacking({ ...backing, object_type_id: id })} placeholder="Backing object type" />
                  <PropertyPicker props={bt?.properties ?? []} value={backing.source_property} onChange={(v) => setBacking({ ...backing, source_property: v })} placeholder={`Holds ${src?.display_name ?? "left"} keys`} />
                  <PropertyPicker props={bt?.properties ?? []} value={backing.target_property} onChange={(v) => setBacking({ ...backing, target_property: v })} placeholder={`Holds ${tgt?.display_name ?? "right"} keys`} />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setSource(target);
                    setTarget(source);
                    if (kind === "foreign_key") setFk(guessFk(tgt, src));
                  }}
                  className="mt-0.5 self-start rounded-md border border-line-2 p-2 text-muted hover:border-ocean/60 hover:text-white"
                  title="Swap the two sides"
                  aria-label="Swap"
                >
                  <Icon name="refresh" className="h-3.5 w-3.5" />
                </button>
              )}
              <div className="space-y-2">
                <TypePicker
                  types={types}
                  value={target}
                  exclude={kind === "foreign_key" ? undefined : source}
                  onChange={(id) => {
                    setTarget(id);
                    if (kind === "foreign_key" && !fk) setFk(guessFk(src, types.find((x) => x.id === id)));
                  }}
                />
                {kind === "foreign_key" && tgt && (
                  <div className="flex items-center gap-2 rounded-md border border-line-2 bg-panel-2/40 px-2.5 py-1.5 text-sm text-soft">
                    <span className="min-w-0 flex-1 truncate">{tgt.properties.find((p) => p.api_name === tgt.primary_key)?.display_name ?? tgt.primary_key}</span>
                    <span className="rounded bg-violet-500/20 px-1.5 text-[10px] text-violet-200" title="Primary key">
                      primary key
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
          {kind === "foreign_key" && src && tgt && fk && (
            <p className="mt-3 text-xs text-muted">
              Each {src.display_name} points to the {tgt.display_name} whose <span className="font-mono">{tgt.primary_key}</span> equals its <span className="font-mono">{fk}</span>.
            </p>
          )}
        </>
      )}

      {step === 2 && (
        <div className="space-y-3">
          {sideCard({
            each: src,
            has: targetMany ? "many" : "one",
            other: tgt,
            name: targetName,
            api: targetApi,
            prefix: camel(src?.display_name ?? "source"),
            onName: (v) => setNames({ ...names, target: v }),
            onApi: (v) => setNames({ ...names, target_api: v }),
          })}
          <div className="flex items-center gap-2 px-1 text-xs text-muted">
            <TypeIcon t={tgt ?? {}} className="h-3 w-3" box="rounded p-0.5" /> {tgt?.display_name} <Icon name="right" className="h-3 w-3" /> <TypeIcon t={src ?? {}} className="h-3 w-3" box="rounded p-0.5" /> {src?.display_name}
          </div>
          {sideCard({
            each: tgt,
            has: sourceMany ? "many" : "one",
            other: src,
            hasPicker: kind === "foreign_key",
            name: sourceName,
            api: sourceApi,
            prefix: camel(tgt?.display_name ?? "target"),
            onName: (v) => setNames({ ...names, source: v }),
            onApi: (v) => setNames({ ...names, source_api: v }),
          })}
          <div className="grid gap-2 sm:grid-cols-[150px_1fr] sm:items-center">
            <span className="text-xs text-muted">Link type name (optional)</span>
            <input value={linkName} onChange={(e) => setLinkName(e.target.value)} placeholder={`${src?.display_name ?? "Source"} → ${tgt?.display_name ?? "Target"}`} className={inputClass} />
          </div>
          <label className="flex items-center gap-2 text-xs text-soft">
            <input type="checkbox" checked={hierarchy} onChange={(e) => setHierarchy(e.target.checked)} /> {tgt?.display_name ?? "The target"} is the parent of {src?.display_name ?? "the source"} in a hierarchy (Object View breadcrumbs)
          </label>
          <p className="rounded-lg bg-panel-2/40 px-3 py-2 text-xs text-muted">
            Cardinality:{" "}
            <strong className="text-soft">{kind === "foreign_key" ? (many ? `one ${tgt?.display_name ?? "target"} to many ${src?.plural_name ?? "sources"} (1:M)` : "one to one (1:1)") : "many to many (M:N)"}</strong>
          </p>
        </div>
      )}
    </WizardShell>
  );
}
