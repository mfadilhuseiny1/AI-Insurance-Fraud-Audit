"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { renderMarkdown } from "@/lib/markdown";
import { compass, type Collection, type CompassMeta, type TagCategory } from "@/lib/securityGov";

/** A folder's README.md, rendered above its contents (Compass documentation); Editors add or edit it in place. */
export function FolderReadme({ folderId }: { folderId: string }) {
  const [doc, setDoc] = useState<{ item_id: string | null; text: string | null } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    compass.readme(folderId).then(setDoc, () => setDoc(null));
  }, [folderId]);
  if (!doc) return null;
  if (editing !== null)
    return (
      <div className="mb-4 space-y-2 rounded-xl border border-line bg-panel p-3" onClick={(e) => e.stopPropagation()}>
        <textarea className="min-h-40 w-full rounded-md border border-line-2 bg-ink p-2 font-mono text-xs outline-none focus:border-ocean" value={editing} onChange={(e) => setEditing(e.target.value)} />
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex gap-2 text-xs">
          <button type="button" className="rounded-md bg-ocean px-3 py-1 text-white" onClick={() => compass.saveReadme(folderId, editing).then((d) => { setDoc(d); setEditing(null); }, (e: Error) => setError(e.message))}>Save README.md</button>
          <button type="button" className="px-2 text-soft" onClick={() => setEditing(null)}>Cancel</button>
        </div>
      </div>
    );
  if (!doc.text)
    return (
      <button type="button" onClick={(e) => { e.stopPropagation(); setEditing("# About this folder\n\n"); }} className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ocean">
        <Icon name="doc" className="h-3.5 w-3.5" />Add description
      </button>
    );
  return (
    <div className="mb-4 rounded-xl border border-line bg-panel p-4 text-sm" onClick={(e) => e.stopPropagation()} data-folder-readme>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted"><Icon name="doc" className="h-3.5 w-3.5" />README.md
        <button type="button" className="ml-auto hover:text-ocean" onClick={() => setEditing(doc.text ?? "")}>Edit</button></div>
      <div className="prose-sm max-w-none text-soft [&_a]:text-ocean [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_ul]:ml-4 [&_ul]:list-disc" dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.text) }} />
    </div>
  );
}

/** Compass rows of the Files details panel: tags, status, collections, views (and the Project dashboard). */
export function CompassMetaRows({ itemId, isProject }: { itemId: string; isProject: boolean }) {
  const [m, setM] = useState<CompassMeta | null>(null);
  const [cats, setCats] = useState<TagCategory[]>([]);
  const [cols, setCols] = useState<Collection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    compass.meta(itemId).then(setM, () => setM(null));
  }, [itemId]);
  useEffect(() => {
    load();
    compass.tags().then(setCats, () => {});
    compass.collections().then(setCols, () => {});
  }, [load]);
  if (!m) return null;
  const tagIds = m.tags.map((t) => t.id);
  return (
    <Fragment>
      <dt className="text-muted">Tags</dt>
      <dd className="space-y-1">
        <div className="flex flex-wrap gap-1">
          {m.tags.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5 text-[11px]">{t.category}: {t.name}
              {m.can_tag && <button type="button" className="text-muted hover:text-bad" onClick={() => compass.setTags(itemId, tagIds.filter((x) => x !== t.id)).then(setM, (e: Error) => setError(e.message))}>×</button>}</span>
          ))}
          {!m.tags.length && <span className="text-muted">None</span>}
        </div>
        {m.can_tag && !!cats.length && (
          <select className="w-full rounded border border-line-2 bg-ink px-1 py-0.5 text-[11px]" value="" onChange={(e) => e.target.value && compass.setTags(itemId, [...tagIds, e.target.value]).then(setM, (er: Error) => setError(er.message))}>
            <option value="">Add a tag…</option>
            {cats.map((c) => <optgroup key={c.id} label={c.name}>{c.tags.filter((t) => !tagIds.includes(t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>)}
          </select>
        )}
      </dd>
      <dt className="text-muted">Status</dt>
      <dd>
        {m.status ? <span className="inline-flex items-center gap-1 text-purple-300"><Icon name="check" className="h-3.5 w-3.5" />Promoted</span> : <span className="text-muted">No status</span>}
        {m.can_promote && (
          <button type="button" className="ml-2 text-[11px] text-ocean hover:underline" onClick={() => compass.setStatus(itemId, m.status ? null : "promoted").then(setM, (e: Error) => setError(e.message))}>
            {m.status ? "Remove status" : "Promote"}
          </button>
        )}
      </dd>
      <dt className="text-muted">Collections</dt>
      <dd>
        {m.collections.map((c) => <Link key={c.id} href={`/compass?collection=${c.id}`} className="mr-1 text-ocean hover:underline">{c.name}</Link>)}
        {!m.collections.length && <span className="text-muted">None</span>}
        {m.can_curate && !!cols.length && (
          <select className="mt-1 w-full rounded border border-line-2 bg-ink px-1 py-0.5 text-[11px]" value="" onChange={(e) => e.target.value && compass.addToCollection(e.target.value, [itemId]).then(load, (er: Error) => setError(er.message))}>
            <option value="">Add to a Data Catalog collection…</option>
            {cols.filter((c) => !m.collections.some((x) => x.id === c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </dd>
      <dt className="text-muted">Views</dt>
      <dd>{m.views}</dd>
      {isProject && (
        <>
          <dt className="text-muted">Project</dt>
          <dd><Link href={`/compass/projects/${itemId}`} className="inline-flex items-center gap-1 text-ocean hover:underline"><Icon name="project" className="h-3.5 w-3.5" />Cover page, activity, access graph</Link></dd>
        </>
      )}
      {error && <><dt /><dd className="text-[11px] text-bad">{error}</dd></>}
    </Fragment>
  );
}
