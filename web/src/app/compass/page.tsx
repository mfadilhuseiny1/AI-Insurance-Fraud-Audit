"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { AppHeader, Card } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { auth, type Group, type Organization, type User } from "@/lib/auth";
import { compass, resultHref, type CatalogItem, type Collection, type SearchResult, type TagCategory } from "@/lib/securityGov";
import { Portfolios } from "@/components/security/Portfolios";

type Tab = "promoted" | "catalog" | "tags" | "settings" | "portfolios";

/** Compass: promoted items, the Data Catalog, tags and curation permissions over Files. */
export default function CompassPage() {
  const { me, enabled } = useAuth();
  const admin = !enabled || me?.role === "admin";
  const [init] = useState(() => (typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search)));
  const [tab, setTab] = useState<Tab>(init.get("portfolio") ? "portfolios" : init.get("collection") ? "catalog" : "promoted");
  const tabs: [Tab, string, "check" | "layers" | "list" | "sliders" | "folder"][] = [
    ["promoted", "Promoted items", "check"],
    ["catalog", "Data Catalog", "layers"],
    ["portfolios", "Portfolios", "folder"],
    ["tags", "Tags", "list"],
    ...(admin ? [["settings", "Settings", "sliders"] as [Tab, string, "sliders"]] : []),
  ];
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Compass" icon="folder" href="/compass" crumbs={[{ label: "Security & Governance", href: "/security-governance" }]}>
        <Link href="/files" className={buttonClass.secondary}><Icon name="folder" className="h-4 w-4" />Files</Link>
        <button type="button" className={buttonClass.secondary} onClick={() => window.dispatchEvent(new Event("bsai:quicksearch"))}><Icon name="search" className="h-4 w-4" />Quicksearch (Ctrl+J)</button>
      </AppHeader>
      <div className="flex shrink-0 gap-1 border-b border-line bg-panel px-4">
        {tabs.map(([id, label, icon]) => (
          <button key={id} type="button" onClick={() => setTab(id)} className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm ${tab === id ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>
            <Icon name={icon} className="h-4 w-4" />{label}
          </button>
        ))}
      </div>
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
        <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
          {tab === "promoted" && <Promoted />}
          {tab === "catalog" && <Catalog initial={init.get("collection")} />}
          {tab === "portfolios" && <Portfolios initial={init.get("portfolio")} />}
          {tab === "tags" && <Tags admin={admin} />}
          {tab === "settings" && admin && <Settings />}
        </div>
      </main>
    </div>
  );
}

function Promoted() {
  const [rows, setRows] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    compass.search({ promoted: "true", limit: 200 }).then((r) => setRows(r.results), (e: Error) => setError(e.message));
  }, []);
  if (error) return <ApiError message={error} />;
  if (!rows) return <Loading />;
  return (
    <Card title="Promoted items" count={rows.length}>
      <p className="px-4 pt-3 text-xs text-muted">Resources recommended for everyone: they are boosted in search and marked with a checkmark. Resource curators promote resources from Files (Details → Status).</p>
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.id}><Link href={resultHref(r)} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-panel-2">
            <Icon name="check" className="h-4 w-4 text-purple-300" /><span className="min-w-0 flex-1"><span className="font-medium">{r.name}</span><span className="block text-xs text-muted">{r.type_label}{r.path ? ` · ${r.path}` : ""}</span></span>
            <span className="text-xs text-muted">{r.views} views</span></Link></li>
        ))}
        {!rows.length && <li className="px-4 py-3 text-sm text-muted">Nothing is promoted yet.</li>}
      </ul>
    </Card>
  );
}

function Catalog({ initial }: { initial: string | null }) {
  const [cols, setCols] = useState<Collection[] | null>(null);
  const [cats, setCats] = useState<TagCategory[]>([]);
  const [sel, setSel] = useState<string | null>(initial);
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [groupBy, setGroupBy] = useState("");
  const [canCurate, setCanCurate] = useState(false);
  const [creating, setCreating] = useState<{ name: string; description: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    compass.collections().then(setCols, (e: Error) => setError(e.message));
    compass.tags().then(setCats, () => {});
    compass.settings().then(() => setCanCurate(true), () => setCanCurate(false));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    compass.catalog({ collection: sel ?? undefined, tags: tags.join(",") || undefined }).then((r) => setItems(r.items), (e: Error) => setError(e.message));
  }, [sel, tags, cols]);
  const grouped = useMemo(() => {
    if (!groupBy || !items) return null;
    const out: Record<string, CatalogItem[]> = {};
    for (const it of items) {
      const t = it.tags.filter((x) => x.category_id === groupBy);
      for (const k of t.length ? t.map((x) => x.name) : ["(untagged)"]) (out[k] ??= []).push(it);
    }
    return out;
  }, [groupBy, items]);
  const current = cols?.find((c) => c.id === sel);
  const row = (it: CatalogItem) => (
    <li key={it.id} className="flex items-center gap-3 px-4 py-2 text-sm">
      <Icon name={it.kind === "dataset" ? "table" : it.kind === "app" ? "grid" : "doc"} className="h-4 w-4 text-purple-300" />
      <span className="min-w-0 flex-1">
        <Link href={it.kind === "dataset" ? `/datasets/${it.id}` : "/files"} className="font-medium hover:underline">{it.name}</Link>
        <span className="block text-xs text-muted">{it.path.join(" / ")} · {it.collections.join(", ")}</span>
        {!!it.tags.length && <span className="mt-0.5 flex flex-wrap gap-1">{it.tags.map((t) => <span key={t.id} className="rounded bg-panel-2 px-1.5 text-[10px] text-soft">{t.category}: {t.name}</span>)}</span>}
      </span>
      {canCurate && sel && <button type="button" className="text-xs text-muted hover:text-bad" onClick={() => compass.removeFromCollection(sel, it.id).then(load, (e: Error) => setError(e.message))}>Remove</button>}
    </li>
  );
  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <Card title="Collections" count={cols?.length} action={canCurate ? <button type="button" className={`${buttonClass.ghost} text-xs`} onClick={() => setCreating({ name: "", description: "" })}><Icon name="plus" className="h-3.5 w-3.5" />New</button> : undefined}>
        {creating && (
          <div className="space-y-2 border-b border-line p-3">
            <input className={inputClass} placeholder="Collection name" value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} />
            <textarea className={`${inputClass} min-h-14`} placeholder="Description (topic, audience, purpose)" value={creating.description} onChange={(e) => setCreating({ ...creating, description: e.target.value })} />
            <button type="button" className={buttonClass.primary} disabled={!creating.name} onClick={() => compass.createCollection(creating.name, creating.description).then(() => { setCreating(null); load(); }, (e: Error) => setError(e.message))}>Create</button>
          </div>
        )}
        <ul className="divide-y divide-line text-sm">
          <li><button type="button" onClick={() => setSel(null)} className={`w-full px-4 py-2 text-left ${!sel ? "bg-ocean/10" : "hover:bg-panel-2"}`}>All curated files</button></li>
          {cols?.map((c) => (
            <li key={c.id}><button type="button" onClick={() => setSel(c.id)} className={`w-full px-4 py-2 text-left ${sel === c.id ? "bg-ocean/10" : "hover:bg-panel-2"}`}>
              <span className="font-medium">{c.name}</span><span className="block text-xs text-muted">{c.items.length} file(s){c.hidden ? ` · ${c.hidden} not shared with you` : ""}</span></button></li>
          ))}
        </ul>
      </Card>
      <div className="space-y-3">
        {error && <ApiError message={error} />}
        {current && (
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1"><h2 className="text-lg font-semibold">{current.name}</h2><p className="text-sm text-soft">{current.description}</p></div>
            {canCurate && <button type="button" className={buttonClass.secondary} onClick={() => setPicking(true)}><Icon name="plus" className="h-4 w-4" />Add resource</button>}
            {canCurate && <button type="button" className={buttonClass.ghost} onClick={() => compass.deleteCollection(current.id).then(() => { setSel(null); load(); }, (e: Error) => setError(e.message))}><Icon name="trash" className="h-4 w-4" /></button>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Filter</span>
          {cats.flatMap((c) => c.tags.map((t) => ({ ...t, category: c.name }))).map((t) => (
            <label key={t.id} className="flex items-center gap-1 rounded bg-panel-2 px-2 py-0.5"><input type="checkbox" checked={tags.includes(t.id)} onChange={(e) => setTags((x) => (e.target.checked ? [...x, t.id] : x.filter((y) => y !== t.id)))} />{t.category}: {t.name}</label>
          ))}
          <select className={`${fieldClass} ml-auto text-xs`} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            <option value="">No grouping</option>{cats.map((c) => <option key={c.id} value={c.id}>Group by {c.name}</option>)}
          </select>
        </div>
        <Card title="Files">
          {!items ? <Loading /> : !items.length ? <p className="p-4 text-sm text-muted">No curated files here.</p> : grouped ? (
            Object.entries(grouped).map(([k, list]) => <div key={k}><div className="bg-panel-2 px-4 py-1 text-xs font-semibold text-soft">{k}</div><ul className="divide-y divide-line">{list.map(row)}</ul></div>)
          ) : <ul className="divide-y divide-line">{items.map(row)}</ul>}
        </Card>
      </div>
      {picking && sel && <DrivePicker title="Add a resource to the collection" onClose={() => setPicking(false)} onPick={(it) => { setPicking(false); compass.addToCollection(sel, [it.id]).then(load, (e: Error) => setError(e.message)); }} />}
    </div>
  );
}

function Tags({ admin }: { admin: boolean }) {
  const [cats, setCats] = useState<TagCategory[] | null>(null);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [name, setName] = useState("");
  const [tag, setTag] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const load = () => compass.tags().then(setCats, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    auth.organizations().then(setOrgs, () => {});
  }, []);
  if (!cats) return <Loading />;
  return (
    <>
      <p className="text-sm text-muted">Tags categorize resources for search and the Data Catalog. They do not add security. A category is visible to the organizations it is restricted to.</p>
      {error && <p className="text-sm text-bad">{error}</p>}
      {admin && (
        <div className="flex gap-2">
          <input className={inputClass} placeholder="New tag category (e.g. Region, Source system, Refresh schedule)" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" className={buttonClass.primary} disabled={!name} onClick={() => compass.createCategory(name).then(() => { setName(""); void load(); }, (e: Error) => setError(e.message))}>New tag category</button>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {cats.map((c) => (
          <Card key={c.id} title={c.name} action={admin ? <button type="button" className="text-xs text-muted hover:text-bad" onClick={() => window.confirm("Delete the category and remove its tags from every resource?") && compass.deleteCategory(c.id).then(load)}>Delete category</button> : undefined}>
            <div className="space-y-2 p-3 text-sm">
              <p className="text-xs text-muted">Visible to: {c.orgs.length ? c.orgs.map((o) => orgs.find((x) => x.id === o)?.name ?? (o === "default" ? "users without an organization" : o)).join(", ") : "everyone"}</p>
              <div className="flex flex-wrap gap-1">
                {c.tags.map((t) => <span key={t.id} className="inline-flex items-center gap-1 rounded bg-panel-2 px-2 py-0.5 text-xs">{t.name}{admin && <button type="button" className="text-muted hover:text-bad" onClick={() => window.confirm(`Delete the tag ${t.name} from every resource?`) && compass.deleteTag(t.id).then(load)}>×</button>}</span>)}
              </div>
              {admin && (
                <div className="flex gap-1">
                  <input className={`${fieldClass} flex-1 text-xs`} placeholder="Add a tag" value={tag[c.id] ?? ""} onChange={(e) => setTag({ ...tag, [c.id]: e.target.value })} />
                  <button type="button" className={buttonClass.secondary} disabled={!tag[c.id]} onClick={() => compass.addTag(c.id, tag[c.id]).then(() => { setTag({ ...tag, [c.id]: "" }); void load(); }, (e: Error) => setError(e.message))}>Add</button>
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function Settings() {
  const [s, setS] = useState<{ curators: string[]; taggers: string[]; catalog_managers: string[] } | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  useEffect(() => {
    compass.settings().then(setS, () => {});
    auth.users().then(setUsers, () => {});
    auth.groups().then(setGroups, () => {});
  }, []);
  if (!s) return <Loading />;
  const label = (id: string) => (id === "*" ? "Everyone" : users.find((u) => u.id === id)?.username ?? groups.find((g) => g.id === id)?.name ?? id);
  const section = (k: "curators" | "taggers" | "catalog_managers", title: string, help: string) => (
    <Card title={title}>
      <div className="space-y-2 p-3 text-sm">
        <p className="text-xs text-muted">{help}</p>
        <div className="flex flex-wrap gap-1">{s[k].map((x) => <button key={x} type="button" className="rounded-full bg-panel-2 px-2 py-0.5 text-xs ring-1 ring-line-2 hover:text-bad" onClick={() => compass.saveSettings({ [k]: s[k].filter((y) => y !== x) }).then(setS)}>{label(x)} ×</button>)}</div>
        <select className={`${fieldClass} text-xs`} value="" onChange={(e) => e.target.value && compass.saveSettings({ [k]: [...new Set([...s[k], e.target.value])] }).then(setS)}>
          <option value="">Add a user or group…</option>
          <option value="*">Everyone</option>
          {groups.map((g) => <option key={g.id} value={g.id}>Group: {g.name}</option>)}
          {users.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.username}</option>)}
        </select>
      </div>
    </Card>
  );
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {section("curators", "Resource curators", "Promote resources they can edit. Administrators always can.")}
      {section("taggers", "Apply tags to resources", "Apply and remove tags on resources they can edit.")}
      {section("catalog_managers", "Catalog managers", "Create collections and add or remove their resources.")}
    </div>
  );
}
