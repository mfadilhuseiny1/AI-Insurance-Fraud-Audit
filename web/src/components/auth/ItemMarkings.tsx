"use client";

import { useCallback, useEffect, useState } from "react";
import { auth, type ItemMarkings, type Marking, type Organization } from "@/lib/auth";
import { useAuth } from "../AuthGate";
import { MarkingChip } from "./parts";

/**
 * Markings of a Files item (file, dataset, pipeline, folder or project): its own, those inherited from the inputs
 * it was built from, and those of the folders above it. Applying or removing one needs holding it.
 */
export function ItemMarkingsPanel({ itemId, compact = false }: { itemId: string; compact?: boolean }) {
  const { me, enabled } = useAuth();
  const [info, setInfo] = useState<ItemMarkings | null>(null);
  const [markings, setMarkings] = useState<Marking[]>([]);
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [error, setError] = useState<string | null>(null);
  // applying or removing a marking needs the Owner role on the resource: said up front instead of after a refused save
  const [owner, setOwner] = useState(true);
  const load = useCallback(() => auth.itemMarkings(itemId).then(setInfo, (e: Error) => setError(e.message)), [itemId]);
  useEffect(() => {
    if (!enabled) return;
    load();
    auth.access(itemId).then((a) => setOwner(!a.operations || a.operations.includes("markings")), () => {});
    auth.markings().then(setMarkings, () => {});
    auth.organizations().then(setOrgs, () => {});
  }, [load, enabled]);
  if (!enabled) return null;
  if (!info) return error ? <p className="text-xs text-bad">{error}</p> : null;
  const held = new Set((me?.markings ?? []).map((m) => m.id));
  const own = info.own.map((m) => m.id);
  const set = (ids: string[]) => auth.setItemMarkings(itemId, ids).then((r) => (setInfo(r), setError(null)), (e: Error) => setError(e.message));
  const choices = [
    ...markings.map((m) => ({ id: m.id, name: m.name, kind: "marking" as const })),
    ...orgs.map((o) => ({ id: o.marking, name: `${o.name} (organization)`, kind: "organization" as const })),
  ].filter((c) => !own.includes(c.id) && held.has(c.id));
  return (
    <div className="text-xs">
      {!compact && <div className="mb-1 font-medium text-soft">Markings</div>}
      <div className="flex flex-wrap items-center gap-1">
        {info.own.map((m) => (
          <MarkingChip key={m.id} m={m} title="Applied here" onRemove={held.has(m.id) && owner ? () => set(own.filter((x) => x !== m.id)) : undefined} />
        ))}
        {info.inherited.map((m) => (
          <MarkingChip key={`i-${m.id}`} m={m} title="Inherited from the inputs this was built from" />
        ))}
        {info.from_folders.map((m) => (
          <MarkingChip key={`f-${m.id}-${m.folder_id}`} m={m} title={`From the folder ${m.folder}`} />
        ))}
        {info.effective.length === 0 && <span className="text-muted">None: everyone signed in can open it.</span>}
        {choices.length > 0 && !owner && (
          <span className="text-muted" data-markings-owner-needed>
            Applying a marking needs the Owner role on its Project.
          </span>
        )}
        {choices.length > 0 && owner && (
          <select value="" onChange={(e) => e.target.value && set([...own, e.target.value])} className="rounded border border-line-2 bg-ink px-1 py-0.5">
            <option value="">+ Apply marking…</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {(info.inherited.length > 0 || info.from_folders.length > 0) && (
        <p className="mt-1 text-muted">Inherited markings change where they come from: the inputs this was built from, or the folder.</p>
      )}
      {error && <p className="mt-1 text-bad">{error}</p>}
    </div>
  );
}

const RESOURCE_TEXT: Record<string, string> = {
  stream: "ingest stream",
  stream_sync: "streaming sync",
  object_type: "object type and its objects",
  vector_index: "vector index",
  code_repo: "code repository (its builds' outputs inherit them)",
  connection: "connection (browsing it, previews, new sources and exports)",
};

/** Markings on a resource outside Files (ingest stream, streaming sync, object type, vector index, code repository). */
export function ResourceMarkings({ kind, id, className = "" }: { kind: keyof typeof RESOURCE_TEXT; id: string; className?: string }) {
  const { enabled } = useAuth();
  if (!enabled) return null;
  return (
    <section className={`rounded-xl border border-line bg-panel p-4 text-sm ${className}`}>
      <div className="mb-1 font-medium">Markings</div>
      <p className="mb-2 text-xs text-muted">Only people holding every marking can see or use this {RESOURCE_TEXT[kind]}.</p>
      <ItemMarkingsPanel itemId={`${kind}:${id}`} compact />
    </section>
  );
}
