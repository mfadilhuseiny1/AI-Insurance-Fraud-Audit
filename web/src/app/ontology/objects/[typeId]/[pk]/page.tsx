"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AppHeader, Badge, Card, ObjectPicker, ValueCell } from "@/components/ontology/parts";
import { DrillCaptureBadge } from "@/components/ontology/DrillCaptureBadge";
import { capture } from "@/lib/drillCapture";
import { OpenInMenu } from "@/components/ontology/OpenInMenu";
import { ActionForm as ActionDialog } from "@/components/ontology/ActionForm";
import { ConfiguredObjectView } from "@/components/ontology/ConfiguredObjectView";
import { buttonClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { ObjectSeries } from "@/components/timeseries/ObjectSeries";
import { alertDialog, confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { typeIcon, type ActionType, type Property } from "@/lib/ontology";
import { om, type ObjectLinks, type ObjectView } from "@/lib/ontologyModel";
import { favorites, recents } from "@/lib/explorer";

/**
 * The Object View of one object: its key information (prominent properties first, keywords and long text in their own
 * sections), every linked object, implemented interfaces, time series, the actions that apply to it, related
 * resources, the automations watching its type and its edit history.
 */
export default function ObjectViewPage() {
  return (
    <Suspense>
      <ObjectViewInner />
    </Suspense>
  );
}

function ObjectViewInner() {
  const { typeId, pk: rawPk } = useParams<{ typeId: string; pk: string }>();
  const pk = decodeURIComponent(rawPk);
  const router = useRouter();
  const search = useSearchParams();
  const [view, setView] = useState<ObjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<ActionType | null>(null);
  const load = useCallback(() => {
    om.objectView(typeId, pk).then(
      (v) => {
        setView(v);
        setError(null);
        recents.add({ kind: "object", id: v.object_type.id, pk, title: v.object.title, typeName: v.object_type.display_name, icon: v.object_type.icon, color: v.object_type.color });
        capture({ object_type_id: typeId, primary_key: pk });
      },
      (e: Error) => setError(e.message),
    );
  }, [typeId, pk]);
  useEffect(load, [load]);

  if (error) return <ApiError message={error} />;
  if (!view) return <Loading />;
  const t = view.object_type;
  const o = view.object;
  const visible = t.properties.filter((p) => p.visibility !== "hidden" && p.api_name !== t.title_property);
  const hints = (p: Property) => p.render_hints ?? [];
  const header = view.header_properties.length
    ? view.header_properties.map((n) => t.properties.find((p) => p.api_name === n)).filter((p): p is Property => !!p)
    : visible.filter((p) => p.visibility === "prominent").slice(0, 6);
  const keywords = visible.filter((p) => hints(p).includes("keywords"));
  const longText = visible.filter((p) => hints(p).includes("long_text"));
  const rest = visible.filter((p) => !header.includes(p) && !keywords.includes(p) && !longText.includes(p) && p.type !== "timeseries");
  const value = (p: Property) => (o.reduced && p.api_name in o.reduced ? o.reduced[p.api_name] : o.properties[p.api_name]);
  const relatedHref = (r: ObjectView["related"][number]) =>
    r.kind === "workshop" ? `/workshop/${r.id}` : r.kind === "quiver" ? `/quiver/${r.id}` : (r.url ?? "#").replaceAll("{pk}", encodeURIComponent(pk));

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader
        app="Object View"
        icon="cube"
        href={`/ontology/${t.id}?tab=objects`}
        crumbs={[{ label: t.plural_name, href: `/object-explorer?type=${t.id}` }, ...view.breadcrumbs.map((b) => ({ label: b.title, href: `/ontology/objects/${b.object_type_id}/${encodeURIComponent(b.primary_key)}` })), { label: o.title }]}
      >
        <DrillCaptureBadge />
        {view.actions.length > 0 && (
          <select
            value=""
            onChange={(e) => setRunning(view.actions.find((a) => a.id === e.target.value) ?? null)}
            className="rounded-md border border-line-2 bg-ink px-2 py-1.5 text-xs"
          >
            <option value="">Actions…</option>
            {view.actions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name}
              </option>
            ))}
          </select>
        )}
        <Link href={`/object-explorer?type=${t.id}`} className={buttonClass.secondary}>
          <Icon name="search" className="h-3.5 w-3.5" /> Explore {t.plural_name}
        </Link>
        <FavoriteStar item={{ kind: "object", id: t.id, pk, title: o.title, typeName: t.display_name, icon: t.icon, color: t.color }} />
        <MoreMenu
          items={[
            { label: "Explore data lineage", hint: "The pipeline upstream and downstream of this object", icon: "split", href: `/lineage?focus=${encodeURIComponent(`object_type:${t.id}`)}` },
            ...(t.backing_dataset ? [{ label: "View backing dataset", hint: t.backing_dataset.name, icon: "database" as const, href: `/datasets/${t.backing_dataset.dataset_id}` }] : []),
            { label: "Edit object view", hint: "The widgets shown for objects of this type", icon: "edit", href: `/object-views?type=${t.id}` },
            { label: "Configure in Ontology Manager", hint: "Edit the configuration of this object type", icon: "cube", href: `/ontology/${t.id}` },
          ]}
        />
      </AppHeader>
      <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-7xl gap-5 p-8 lg:grid-cols-[1fr_320px]">
          <div className="min-w-0 space-y-5">
            <section className="rounded-xl border border-line bg-panel p-5">
              <div className="flex items-start gap-3">
                <span className="rounded-lg bg-ocean/15 p-2.5 text-ocean">
                  <Icon name="cube" className="h-6 w-6" />
                </span>
                <div className="min-w-0 flex-1">
                  <h1 className="break-words text-xl font-semibold">{o.title}</h1>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <Link href={`/ontology/${t.id}`} className="hover:text-ocean">
                      {t.display_name}
                    </Link>
                    <span className="font-mono">{o.primary_key}</span>
                    {t.status !== "active" && <Badge status={t.status} />}
                    {o.updated_at && <span>updated {when(o.updated_at)}</span>}
                    <span className="ml-auto">
                      <OpenInMenu typeId={typeId} pk={pk} />
                    </span>
                  </div>
                  {t.status === "deprecated" && t.deprecation && (
                    <p className="mt-2 rounded-md border border-bad/30 bg-bad/10 px-2 py-1 text-xs text-bad">
                      {t.display_name} is deprecated: {t.deprecation.reason}
                      {t.deprecation.deadline ? ` (until ${t.deprecation.deadline})` : ""}
                    </p>
                  )}
                </div>
              </div>
              {header.length > 0 && (
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  {header.map((p) => (
                    <div key={p.api_name} className="rounded-lg bg-panel-2 p-3">
                      <div className="text-[11px] text-muted">{p.display_name}</div>
                      <div className="mt-0.5 text-base font-semibold">
                        <ValueCell type={p.type} value={value(p)} prop={p} object={o.properties} edit={{ typeId, pk }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <ConfiguredObjectView typeId={typeId} pk={pk} initialTab={search.get("tab")} />

            {keywords.length > 0 && (
              <Card title="Keywords">
                <div className="flex flex-wrap gap-1.5 p-4">
                  {keywords.flatMap((p) => {
                    const v = value(p);
                    return (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]).map((x, i) => (
                      <span key={`${p.api_name}-${i}`} className="rounded-full bg-ocean/10 px-2 py-0.5 text-xs text-ocean ring-1 ring-ocean/30" title={p.display_name}>
                        {String(x)}
                      </span>
                    ));
                  })}
                </div>
              </Card>
            )}

            <Card title="Properties" count={rest.length}>
              <dl className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2">
                {rest.map((p) => (
                  <div key={p.api_name} className="min-w-0">
                    <dt className="mb-0.5 flex items-center gap-1.5 text-xs text-muted">
                      <Icon name={typeIcon(p.type)} className="h-3 w-3" /> {p.display_name}
                      {p.derived && <span className="text-[10px]">(derived)</span>}
                    </dt>
                    <dd className="text-soft">
                      <ValueCell type={p.type} value={value(p)} prop={p} object={o.properties} large edit={{ typeId, pk }} />
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>

            {longText.map((p) => (
              <Card key={p.api_name} title={p.display_name}>
                <div className="whitespace-pre-wrap p-4 text-sm leading-relaxed text-soft">{String(value(p) ?? "—")}</div>
              </Card>
            ))}

            {view.has_time_series && (
              <Card title="Time series">
                <div className="p-4">
                  <ObjectSeries typeId={t.id} pk={o.primary_key} resource={`object-view:${t.id}`} />
                </div>
              </Card>
            )}

            {view.links.map((l) => (
              <LinkedObjects key={`${l.link_type_id}:${l.direction}`} l={l} pk={o.primary_key} onChanged={load} keyProp={t.primary_key} title={o.title} />
            ))}

            {view.interfaces.length > 0 && (
              <Card title="Interfaces">
                <div className="divide-y divide-line">
                  {view.interfaces.map((i) => (
                    <div key={i.id} className="p-4 text-sm">
                      <div className="mb-1 flex items-center gap-1.5 font-medium">
                        <Icon name="layers" className="h-3.5 w-3.5 text-sand" /> {i.display_name}
                      </div>
                      <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                        {Object.entries(i.properties).map(([k, v]) => (
                          <Fragment key={k}>
                            <span className="text-muted">{k}</span>
                            <span className="truncate text-soft">{v === null || v === undefined ? "—" : String(v)}</span>
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>

          <aside className="space-y-5">
            {view.related.length > 0 && (
              <Card title="Related">
                <ul className="p-2 text-sm">
                  {view.related.map((r, i) => (
                    <li key={i}>
                      <Link href={relatedHref(r)} target={r.kind === "url" ? "_blank" : undefined} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-panel-2">
                        <Icon name={r.kind === "workshop" ? "device" : r.kind === "quiver" ? "wave" : "external"} className="h-3.5 w-3.5 text-ocean" /> {r.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            <Card title="Actions" count={view.actions.length}>
              <ul className="p-2 text-sm">
                {view.actions.length === 0 && <li className="px-2 py-1.5 text-muted">No actions apply to {t.plural_name}</li>}
                {view.actions.map((a) => (
                  <li key={a.id}>
                    <button type="button" onClick={() => setRunning(a)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-panel-2">
                      <Icon name={a.kind === "delete" ? "trash" : "edit"} className="h-3.5 w-3.5 text-ok" /> {a.display_name}
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
            {view.automations.length > 0 && (
              <Card title="Automations">
                <ul className="p-2 text-sm">
                  {view.automations.map((a) => (
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
            )}
            <Card title="History" count={view.history.length}>
              <ul className="max-h-96 space-y-2 overflow-y-auto p-3 text-xs">
                {view.history.length === 0 && <li className="text-muted">No edits recorded yet</li>}
                {view.history.map((h, i) => (
                  <li key={i} className="border-l-2 border-line-2 pl-2">
                    <div className="text-soft">
                      <span className="font-medium capitalize">{h.op}</span> by {h.user}
                    </div>
                    <div className="text-muted">
                      {when(h.at)}
                      {h.properties.length ? ` · ${h.properties.slice(0, 5).join(", ")}${h.properties.length > 5 ? "…" : ""}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </aside>
        </div>
      </div>
      {running && (
        <ActionDialog
          action={running}
          objectType={t}
          object={o}
          onClose={() => setRunning(null)}
          onDone={() => {
            setRunning(null);
            if (running.kind === "delete") router.push(`/object-explorer?type=${t.id}`);
            else load();
          }}
        />
      )}
    </div>
  );
}

/** Open in Explorer: the objects linked to this one, as an exploration of their object type ("Linked to … is any of …"). */
function linkedExploreHref(l: ObjectLinks, keyProp: string, pk: string, title: string): string {
  const spec = {
    object_type_id: l.object_type_id,
    filters: [{ property: "__link", op: "eq", value: { link_type_id: l.link_type_id, direction: l.direction === "forward" ? "reverse" : "forward", label: title, filters: [{ property: keyProp, op: "eq", value: pk }] } }],
  };
  return `/object-explorer?spec=${encodeURIComponent(JSON.stringify(spec))}`;
}

function LinkedObjects({ l, pk, onChanged, keyProp, title }: { l: ObjectLinks; pk: string; onChanged: () => void; keyProp: string; title: string }) {
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState("");
  if (l.visibility === "hidden") return null;
  const edit = async (op: "add" | "remove", other: string) => {
    const [source, target] = l.direction === "forward" ? [pk, other] : [other, pk];
    try {
      await om.editLink(l.link_type_id, op, source, target);
      onChanged();
    } catch (e) {
      void alertDialog((e as Error).message);
    }
  };
  return (
    <Card
      title={l.name}
      count={l.count}
      action={
        <span className="flex items-center gap-2 text-xs font-normal text-muted">
          {l.object_type}
          <Link href={linkedExploreHref(l, keyProp, pk, title)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-ocean hover:bg-ocean/10" title="Open in Explorer: a chart for every property of these linked objects" data-open-in-explorer>
            <Icon name="graph" className="h-3.5 w-3.5" /> Open in Explorer
          </Link>
          {l.editable && (
            <button type="button" onClick={() => setAdding(!adding)} className={buttonClass.ghost}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Link
            </button>
          )}
        </span>
      }
    >
      {adding && (
        <div className="flex items-center gap-2 border-b border-line p-3">
          <div className="flex-1">
            <ObjectPicker objectTypeId={l.object_type_id} value={pick} onChange={setPick} />
          </div>
          <button
            type="button"
            disabled={!pick}
            onClick={() => {
              edit("add", pick);
              setAdding(false);
              setPick("");
            }}
            className={buttonClass.primary}
          >
            Add link
          </button>
        </div>
      )}
      {l.objects.length === 0 ? (
        <p className="p-4 text-sm text-muted">No linked {l.object_type} objects.</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {l.objects.map((x) => (
            <li key={x.primary_key} className="flex items-center gap-2 px-4 py-2 hover:bg-panel-2">
              <Icon name="cube" className="h-3.5 w-3.5 text-ocean" />
              <Link href={`/ontology/objects/${l.object_type_id}/${encodeURIComponent(x.primary_key)}`} className="truncate font-medium hover:text-ocean">
                {x.title}
              </Link>
              <span className="truncate font-mono text-xs text-muted">{x.primary_key}</span>
              {l.editable && (
                <button
                  type="button"
                  onClick={async () => {
                    if (await confirmDialog(`Remove the link to ${x.title}?`)) edit("remove", x.primary_key);
                  }}
                  className="ml-auto text-muted hover:text-bad"
                  title="Remove link"
                >
                  <Icon name="x" className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
          {l.count > l.objects.length && <li className="px-4 py-2 text-xs text-muted">and {l.count - l.objects.length} more — explore them in Object Explorer</li>}
        </ul>
      )}
    </Card>
  );
}

function FavoriteStar({ item }: { item: Parameters<typeof favorites.toggle>[0] }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOn(favorites.has(item)), 0);
    return () => clearTimeout(t);
  }, [item]);
  return (
    <button type="button" onClick={() => (favorites.toggle(item), setOn(!on))} className={`rounded-md p-1.5 hover:bg-panel-2 ${on ? "text-sand" : "text-muted hover:text-white"}`} title={on ? "Remove from favorites" : "Add to favorites"}>
      <Icon name="star" className={`h-4 w-4 ${on ? "fill-current" : ""}`} />
    </button>
  );
}

function MoreMenu({ items }: { items: { label: string; hint: string; icon: IconName; href: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <button type="button" onClick={() => setOpen(!open)} className={buttonClass.secondary} data-object-more>
        More <Icon name="down" className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-80 rounded-xl border border-line-2 bg-panel p-1 text-xs shadow-2xl">
          {items.map((i) => (
            <Link key={i.label} href={i.href} className="flex items-start gap-2.5 rounded-lg px-2.5 py-2 hover:bg-panel-2" onClick={() => setOpen(false)}>
              <Icon name={i.icon} className="mt-0.5 h-4 w-4 text-ocean" />
              <span>
                <span className="block text-sm text-white">{i.label}</span>
                <span className="block text-muted">{i.hint}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
