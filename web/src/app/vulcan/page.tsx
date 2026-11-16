"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { useVulcanScene, vulcanApi as api, type CadRow, type Schema } from "@/components/vulcan/VulcanScene";

/**
 * Vulcan: render CAD objects from the Ontology — meshes (GLB, GLTF, STL, OBJ, PLY, 3MF), ASCII DXF drawings (by layer)
 * and LAS point clouds (by class) — pick and recolor parts (layers and classes for drawings and point clouds), switch
 * the mesh style, and create annotations, measurements and section planes that are saved as Ontology objects through
 * actions. Binary DXF, DWG and LAZ are refused with the reason. The viewer and its tools are
 * components/vulcan/VulcanScene.tsx, shared with the Workshop Vulcan widget.
 */
export default function VulcanPage() {
  const [rows, setRows] = useState<CadRow[] | null>(null);
  const [schema, setSchema] = useState<Schema | null>(null);
  const [current, setCurrent] = useState<CadRow | null>(null);
  const vc = useVulcanScene(current);
  const { error, setError, scene } = vc;
  const reloadList = useCallback(() => Promise.all([api<CadRow[]>("/cad-objects"), api<Schema>("/schema")]).then(([r, s]) => (setRows(r), setSchema(s)), (e: Error) => setError(e.message)), [setError]);
  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  if (error && !rows) return <ApiError message={error} />;
  if (!rows || !schema) return <Loading />;
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Vulcan" icon="cube" href="/vulcan" crumbs={scene ? [{ label: scene.object.title }] : []}>
        {vc.toolbar}
      </AppHeader>
      <div className="flex min-h-0 flex-1">
        <nav className="w-64 shrink-0 space-y-3 overflow-y-auto border-r border-line bg-panel p-3 text-xs">
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">CAD objects</div>
            {rows.map((r) => (
              <button
                key={r.object_type_id + r.primary_key}
                type="button"
                onClick={() => (setCurrent(r), vc.reset())}
                className={`mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${current?.primary_key === r.primary_key ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}
              >
                <Icon name="cube" className="h-3.5 w-3.5 text-ocean" /> <span className="truncate">{r.title}</span>
              </button>
            ))}
            {!rows.length && <div className="text-muted">No CAD objects: an object type needs a media property with the vulcan:cad_media_reference type class.</div>}
          </div>
          {schema.problems.length > 0 && (
            <div className="space-y-1 rounded border border-warn/40 bg-warn/5 p-2 text-warn">
              <div className="font-medium">Schema</div>
              {schema.problems.map((p) => (
                <div key={p}>{p}</div>
              ))}
              {schema.cad_types[0] && (
                <button type="button" onClick={() => api("/setup", { method: "POST", json: { cad_object_type_id: schema.cad_types[0].id } }).then(reloadList, (e: Error) => setError(e.message))} className={buttonClass.secondary}>
                  Set up the Vulcan schema
                </button>
              )}
            </div>
          )}
          <p className="text-muted">Meshes: GLB, GLTF, STL, OBJ, PLY, 3MF. Drawings: ASCII DXF (binary DXF is refused). Point clouds: LAS 1.0–1.4, point formats 0–10 (LAZ is refused: no LASzip decoder here).</p>
        </nav>
        <main className="relative min-w-0 flex-1 bg-ink">{vc.viewport}</main>
        {scene && <aside className="w-80 shrink-0 space-y-3 overflow-y-auto border-l border-line bg-panel p-3 text-xs">{vc.sidebar}</aside>}
      </div>
    </div>
  );
}
