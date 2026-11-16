/**
 * Pipelines are files in the Files tab: "<name>.pipeline" holds the pipeline's JSON (its nodes, outputs
 * and the datasets added to it). The file's id is the pipeline's id, its folder the pipeline's location
 * (where deployed outputs go unless an output picks another folder).
 */
import { api, type DriveItem } from "./api";
import { starterFlow } from "./flow";
import { newPipeline, newSourceMode, uid, type BatchCompute, type DatasetRef, type DriveLocation, type Pipeline, type PipelineType, type Table } from "./pipeline";
import type { VersionControl } from "./versioning";

export const PIPELINE_EXT = ".pipeline";
export const isPipelineFile = (item: Pick<DriveItem, "kind" | "name">) => item.kind === "file" && item.name.toLowerCase().endsWith(PIPELINE_EXT);
export const pipelineName = (fileName: string) => fileName.replace(/\.pipeline$/i, "");

export const TOP_LEVEL: DriveLocation = { id: null, name: "Files & Projects" };

/** The folder a Drive item is in. */
export function locationOf(item: DriveItem): DriveLocation {
  const parent = item.path?.[item.path.length - 1];
  return item.parent_id && parent ? { id: item.parent_id, name: parent.name } : TOP_LEVEL;
}

/** "Files & Projects / My Project / Pipelines" */
export const pathOf = (item: DriveItem) => ["Files & Projects", ...(item.path ?? []).map((p) => p.name)].join(" / ");

/** What is written to the file: everything but what the file itself already records. */
function content(p: Pipeline) {
  const { id: _id, name: _name, location: _location, ...rest } = p;
  void _id;
  void _name;
  void _location;
  return rest;
}

export async function createPipelineFile(
  name: string,
  type: PipelineType,
  location: DriveLocation,
  extra: { compute?: BatchCompute; external?: Pipeline["external"]; description?: string; inputs?: { name: string; origin: string; table: Table; ref: DatasetRef }[] } = {},
): Promise<DriveItem> {
  const p: Pipeline = { ...newPipeline(name, type), ...(extra.compute ? { compute: extra.compute } : {}), ...(extra.external ? { external: extra.external } : {}), ...(extra.description ? { meta: { description: extra.description } } : {}) };
  // inputs the pipeline starts with (Start pipelining from a stream)
  const at = new Date().toISOString();
  (extra.inputs ?? []).forEach((d, i) => {
    const id = uid();
    p.datasets[id] = { id, name: d.name, origin: d.origin, createdAt: at, ...d.table, ref: d.ref, refreshedAt: at };
    p.nodes.push({ id, kind: "source", name: d.name, datasetId: id, mode: newSourceMode(p), x: 80, y: 80 + i * 120 });
  });
  // a device pipeline runs in Node-RED, starting from an example flow of simulated sensors (put in on its first start)
  return api.pipelineData.createFile(name, location.id, content(type === "device" ? { ...p, flow: starterFlow(), engine: "nodered" } : p));
}

/** The whole file: main's working copy and the version control data (branches, versions, proposals). */
export async function loadPipelineWithVc(itemId: string): Promise<{ pipeline: Pipeline; vc: VersionControl; item: DriveItem }> {
  const { pipeline, item } = await loadPipelineFile(itemId);
  const { vc, ...rest } = pipeline as Pipeline & { vc?: VersionControl };
  return { pipeline: rest as Pipeline, vc: vc ?? {}, item };
}

/**
 * The version of each file this tab read or last wrote (its updated_at): a save sends it, and the API refuses one over
 * a newer version — an editor left open since before someone else saved cannot silently overwrite that save.
 */
const fileVersion = new Map<string, string>();

async function saveVersioned(p: Pipeline, body: unknown): Promise<DriveItem> {
  const item = await api.pipelineData.saveFile(p.id, body, p.name.trim() || undefined, fileVersion.get(p.id));
  if (item.updated_at) fileVersion.set(p.id, item.updated_at);
  return item;
}

/** Writes main's working copy and the version control data. */
export async function savePipelineWithVc(p: Pipeline, vc: VersionControl): Promise<DriveItem> {
  const saved = { ...p, updatedAt: new Date().toISOString() };
  return saveVersioned(p, { ...content(saved), vc });
}

/** The pipeline in a file, with its id, name and location taken from the file. */
export async function loadPipelineFile(itemId: string): Promise<{ pipeline: Pipeline; item: DriveItem }> {
  const { item, content: raw } = await api.pipelineData.readFile(itemId);
  if (item.updated_at) fileVersion.set(item.id, item.updated_at);
  const stored = (raw && typeof raw === "object" ? raw : {}) as Partial<Pipeline>;
  const now = new Date().toISOString();
  const pipeline: Pipeline = {
    type: "batch",
    createdAt: item.created_at ?? now,
    nodes: [],
    datasets: {},
    outputs: [],
    legend: [],
    ...stored,
    updatedAt: item.updated_at ?? now,
    id: item.id,
    name: pipelineName(item.name),
    location: locationOf(item),
  };
  return { pipeline, item };
}

/** Writes the pipeline back to its file (renaming the file when the pipeline was renamed). */
export async function savePipelineFile(p: Pipeline): Promise<DriveItem> {
  const saved = { ...p, updatedAt: new Date().toISOString() };
  return saveVersioned(p, content(saved));
}

/** A pipeline kept in this browser before pipelines became files: written as a new file. */
export async function moveToFiles(p: Pipeline, location: DriveLocation): Promise<DriveItem> {
  return api.pipelineData.createFile(p.name || "Pipeline", location.id, content(p));
}
