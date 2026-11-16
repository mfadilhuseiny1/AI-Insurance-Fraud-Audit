/**
 * Deploy: builds a pipeline output in the browser and writes it as a Parquet dataset in the Files tab —
 * in the output's location, else the pipeline's. Redeploying replaces that file (snapshot) or adds the
 * new rows to it (append); any pipeline can then add the dataset back as input data.
 */
import { api, API_URL, driveContentUrl, type DriveItem } from "./api";
import { ICEBERG_TYPE } from "./iceberg";
import {
  checkExpectations,
  COL_TYPES,
  deployModeFields,
  outputTable,
  parseCsv,
  parseJson,
  type ColType,
  type DriveLocation,
  type Output,
  type OutputDeploy,
  type Pipeline,
  type Table,
} from "./pipeline";

/** Where a deploy of this output writes: its own location, else the pipeline's, else the top level. */
export const outputLocation = (o: Output, p: Pick<Pipeline, "location">): DriveLocation =>
  o.location ?? p.location ?? { id: null, name: "Files & Projects" };

export async function deployOutput(o: Output, upstream: Table, pipeline: Pick<Pipeline, "location">): Promise<OutputDeploy> {
  const name = o.name.trim();
  if (!name) throw new Error("The output needs a name");
  const table = outputTable(o, upstream);
  const failed = checkExpectations(table, o.expectations).filter((r) => !r.ok);
  if (failed.length) throw new Error(`Expectation failed: ${failed.map((f) => f.message).join("; ")}`);
  const location = outputLocation(o, pipeline);
  const res = await api.pipelineData.deploy({
    name,
    // a moved output location starts a new file
    parent_id: location.id,
    item_id: o.deployed?.itemId && (o.deployed.parentId ?? null) === location.id ? o.deployed.itemId : null,
    // a browser deploy reads every input in full: Default is a snapshot
    ...deployModeFields(o, "snapshot"),
    columns: table.columns,
    rows: table.rows,
  });
  return {
    at: new Date().toISOString(),
    version: (o.deployed?.version ?? 0) + 1,
    rows: res.rows,
    columns: res.columns,
    itemId: res.item.id,
    parentId: res.item.parent_id,
    path: ["Files & Projects", ...(res.item.path ?? []).map((x) => x.name), res.item.name].join(" / "),
  };
}

/** Files the pipeline can read as data. */
export const DATA_FILE = /\.(parquet|view|csv|tsv|txt|json|jsonl|ndjson)$/i;
/** Foundry Iceberg tables (Files items of this content type) are read as data too. */
export { ICEBERG_TYPE };

/** Rows of each input a DuckDB local pipeline keeps for the editor's preview (its builds read every row from disk). */
export const SAMPLE_ROWS = 100;

/** A Files-tab dataset as a pipeline table: Parquet through the API, text formats parsed here; `limit`: only its first rows. */
export async function readDriveTable(item: DriveItem, limit?: number): Promise<Table> {
  if (item.content_type === ICEBERG_TYPE) {
    const t = await api.pipelineData.table(item.id, limit);
    return { columns: t.columns.map((c) => ({ name: c.name, type: (COL_TYPES.includes(c.type as ColType) ? c.type : "String") as ColType })), rows: t.rows as Table["rows"] };
  }
  if (/\.view$/i.test(item.name)) {
    const res = await fetch(`${API_URL}/api/views/${item.id}/table`, { cache: "no-store" });
    const t = await res.json();
    if (!res.ok) throw new Error(typeof t.detail === "string" ? t.detail : `Could not read the View "${item.name}"`);
    return { columns: (t.columns as { name: string; type: string }[]).map((c) => ({ name: c.name, type: (COL_TYPES.includes(c.type as ColType) ? c.type : "String") as ColType })), rows: t.rows };
  }
  if (/\.parquet$/i.test(item.name)) {
    const t = await api.pipelineData.table(item.id, limit);
    return {
      columns: t.columns.map((c) => ({ name: c.name, type: (COL_TYPES.includes(c.type as ColType) ? c.type : "String") as ColType })),
      rows: t.rows as Table["rows"],
    };
  }
  const res = await fetch(driveContentUrl(item.id));
  if (!res.ok) throw new Error(`Could not read "${item.name}" (${res.status})`);
  const text = await res.text();
  const t = /\.(json|jsonl|ndjson)$/i.test(item.name) ? parseJson(text) : parseCsv(text);
  return limit === undefined ? t : { ...t, rows: t.rows.slice(0, limit) };
}
