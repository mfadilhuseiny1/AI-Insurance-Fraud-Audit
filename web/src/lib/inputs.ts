/**
 * Re-reading an input from where it lives (Refresh): a Files dataset, a data source's ingested table,
 * a virtual table (its first rows; builds read all of it), or a media set folder.
 */
import { api, API_URL } from "./api";
import { readDriveTable } from "./deployed";
import { bytesToBase64, COL_TYPES, type ColType, type DatasetRef, type Table } from "./pipeline";

const MEDIA_EXT = /\.(pdf|png|jpe?g|gif|webp|bmp|tiff?)$/i;
const EXCEL_EXT = /\.(xlsx|xlsm|xltx|xltm|xls|xlt)$/i;
const typed = (columns: { name: string; type: string }[]) => columns.map((c) => ({ name: c.name, type: (COL_TYPES.includes(c.type as ColType) ? c.type : "String") as ColType }));

/** `limit`: only the first rows of a Files dataset (the preview sample of a DuckDB local pipeline). */
export async function readRef(ref: DatasetRef, limit?: number): Promise<Table> {
  switch (ref.kind) {
    case "drive": {
      const item = await api.drive.item(ref.itemId);
      if (item.trashed_at) throw new Error(`"${item.name}" is in the trash`);
      if (EXCEL_EXT.test(item.name)) {
        const res = await fetch(`${API_URL}/api/drive/items/${item.id}/content`);
        const base64 = bytesToBase64(new Uint8Array(await res.arrayBuffer()));
        const parsed = await fetch(`${API_URL}/api/pipeline/parse`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ calls: [{ key: `parse:excel:refresh:${item.id}:${item.updated_at}`, format: "excel", name: item.name, base64 }] }),
        }).then((r) => r.json());
        const r = Object.values(parsed.results as Record<string, { value?: Table; error?: string }>)[0];
        if (!r?.value) throw new Error(r?.error ?? "Could not read the workbook");
        return { columns: typed(r.value.columns), rows: r.value.rows };
      }
      return readDriveTable(item, limit);
    }
    case "datasource": {
      const t = await api.dataSources.table(ref.id);
      return { columns: typed(t.columns), rows: t.rows as Table["rows"] };
    }
    case "virtual": {
      const pv = await api.dataSources.preview(ref.connectionId, ref.database, ref.schema, ref.table);
      return { columns: typed(pv.columns), rows: pv.rows as Table["rows"] };
    }
    case "media": {
      const f = await api.drive.folder(ref.folderId);
      const items = f.items.filter((i) => i.kind === "file" && MEDIA_EXT.test(i.name));
      return {
        columns: [
          { name: "mediaReference", type: "String" },
          { name: "path", type: "String" },
          { name: "mediaType", type: "String" },
          { name: "size", type: "Long" },
        ],
        rows: items.map((i) => ({ mediaReference: i.id, path: i.name, mediaType: i.content_type ?? "", size: i.size ?? null })),
      };
    }
    case "stream":
    case "ingest": {
      const base = ref.kind === "ingest" ? "/api/streaming/streams" : "/api/pipeline/streams";
      const res = await fetch(`${API_URL}${base}/${ref.streamId}/records?limit=1000`);
      if (!res.ok) throw new Error(`Could not read the stream (${res.status})`);
      const body = (await res.json()) as { columns: { name: string; type: string }[]; rows: Table["rows"] };
      return { columns: typed(body.columns), rows: body.rows };
    }
  }
}

export const refLabel = (ref: DatasetRef) =>
  ref.kind === "drive"
    ? "a Files dataset"
    : ref.kind === "datasource"
      ? "a data source"
      : ref.kind === "virtual"
        ? `virtual table ${ref.connectionName} · ${ref.schema}.${ref.table}`
        : ref.kind === "media"
          ? "a media set folder"
          : ref.kind === "ingest"
            ? "an ingest stream"
            : "a stream";

/** Thumbnail of a media reference (a PDF page or an image). */
export const thumbnailUrl = (ref: string, size = 240) => {
  const [id, frag = ""] = ref.split("#");
  const page = new URLSearchParams(frag).get("page");
  return `${API_URL}/api/pipeline/media/${id}/thumbnail?size=${size}${page ? `&page=${page}` : ""}`;
};
