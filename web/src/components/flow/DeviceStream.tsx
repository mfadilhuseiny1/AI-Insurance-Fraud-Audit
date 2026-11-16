"use client";

import { useCallback, useEffect, useState } from "react";
import { EditorWorkspace } from "@/components/code/VsCodeWorkspace";
import { Icon } from "@/components/Icon";
import { buttonClass } from "@/components/pipeline/Modal";
import { codeWorkspaces, type Workspace } from "@/lib/codeWorkspaces";
import { toNodeRed } from "@/lib/flowToNodeRed";
import type { Pipeline } from "@/lib/pipeline";
import { loadPipelineFile, savePipelineFile } from "@/lib/pipelineFiles";
import { FlowBuilder } from "./FlowBuilder";

/**
 * A Device stream pipeline. New ones run in real Node-RED (the pipeline's own Node-RED workspace, its datasets next
 * to the pipeline through the BluesandAI nodes); ones made in the built-in editor stay there until moved.
 */
export function DeviceStream({ initial }: { initial: Pipeline }) {
  const [pipeline, setPipeline] = useState(initial);
  const [moving, setMoving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (pipeline.engine === "nodered") return <NodeRedStream pipeline={pipeline} onChange={setPipeline} />;

  const move = async () => {
    setMoving(true);
    setErr(null);
    try {
      // the flow as last saved (the editor saves as you go)
      const { pipeline: latest } = await loadPipelineFile(pipeline.id);
      const next: Pipeline = { ...latest, engine: "nodered", noderedImported: false, movedToNodeRed: true };
      await savePipelineFile(next);
      setPipeline(next);
    } catch (e) {
      setErr((e as Error).message);
      setMoving(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-ocean/30 bg-ocean/10 px-5 py-2 text-xs text-soft" data-move-nodered>
        <Icon name="signal" className="h-4 w-4 text-ocean" />
        <span className="min-w-0 flex-1">
          This device stream uses the built-in editor, which runs the flow only while this tab is open. <b className="text-strong">Move it to Node-RED</b>: the same flow
          runs on the server until you stop it, with Node-RED&apos;s palette plugins.
        </span>
        {err && <span className="text-bad">{err}</span>}
        <button type="button" onClick={move} disabled={moving} className={buttonClass.primary} data-move-nodered-button>
          {moving ? "Moving…" : "Move to Node-RED"}
        </button>
      </div>
      <FlowBuilder key={pipeline.id} initial={pipeline} />
    </div>
  );
}

function NodeRedStream({ pipeline, onChange }: { pipeline: Pipeline; onChange: (p: Pipeline) => void }) {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    codeWorkspaces.create({ name: pipeline.name, kind: "nodered", pipeline_id: pipeline.id }).then(
      (w) => live && setWs(w),
      (e: Error) => live && setErr(e.message),
    );
    return () => {
      live = false;
    };
  }, [pipeline.id, pipeline.name]);

  // the first start puts the pipeline's flow (the starter flow, or the one moved from the built-in editor) into Node-RED
  const importFlow = useCallback(async () => {
    if (!ws) return;
    const { nodes, notes } = toNodeRed(
      pipeline.flow ?? { nodes: [] },
      pipeline.name,
      pipeline.movedToNodeRed
        ? "Moved from the built-in device-stream editor."
        : "A starter flow of simulated sensors: swap them for mqtt in, OPC-UA or Modbus nodes once devices are connected. The BluesandAI nodes write datasets next to this pipeline.",
    );
    await codeWorkspaces.noderedSetFlows(ws.id, nodes);
    const next: Pipeline = { ...pipeline, noderedImported: true };
    await savePipelineFile(next);
    setNotes(notes);
    onChange(next);
  }, [ws, pipeline, onChange]);

  if (err)
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-bad">
        <Icon name="alert" className="mr-2 h-4 w-4" /> Could not open this device stream&apos;s Node-RED: {err}
      </div>
    );
  if (!ws) return <div className="flex flex-1 items-center justify-center text-sm text-muted">Opening Node-RED…</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-device-stream={pipeline.id}>
      {notes.length > 0 && (
        <div className="shrink-0 border-b border-warn/30 bg-warn/10 px-5 py-2 text-xs text-warn" data-move-notes>
          <b>Moved to Node-RED.</b> Check these nodes: {notes.join(" · ")}
        </div>
      )}
      <EditorWorkspace
        workspace={ws}
        engine="nodered"
        header={{ app: "Pipeline Builder", icon: "pipeline", href: "/pipeline", crumbs: [{ label: pipeline.name }] }}
        beforeShow={pipeline.noderedImported ? undefined : importFlow}
        intro={
          pipeline.noderedImported
            ? "This device stream runs in Node-RED on the platform's machine, until you press Stop. The BluesandAI nodes write datasets next to this pipeline (its outputs in Data Lineage) and push to ingest streams; add any other nodes from Menu → Manage palette."
            : "This device stream runs in Node-RED on the platform's machine. Its flow goes in on the first start; it then runs until you press Stop. The BluesandAI nodes write datasets next to this pipeline and push to ingest streams; add any other nodes from Menu → Manage palette."
        }
      />
    </div>
  );
}
