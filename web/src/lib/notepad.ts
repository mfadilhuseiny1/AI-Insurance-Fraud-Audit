import { API_URL, type DriveItem } from "./api";

export type TextBlock = { id: string; type: "paragraph"; text: string };
export type HeadingBlock = { id: string; type: "heading"; level: 1 | 2 | 3; text: string };
export type TableBlock = { id: string; type: "table"; rows: string[][] };
export type ImageBlock = { id: string; type: "image"; src: string; alt: string; width: number };
export type RuleBlock = { id: string; type: "rule" };
export type PageBreakBlock = { id: string; type: "page_break" };
export type NotepadApp = "contour" | "insight" | "quiver" | "object_explorer" | "code_workbook" | "workshop" | "map";
export type DateBlock = { id: string; type: "date"; date: string };
export type AppLinkBlock = { id: string; type: "app_link"; app: NotepadApp; label: string };
export type WidgetKind =
  | "object_property"
  | "object_card"
  | "object_media"
  | "object_markdown"
  | "map"
  | "contour_chart"
  | "quiver_chart"
  | "quiver_dashboard"
  | "vertex_graph"
  | "code_workbook_chart"
  | "solution_diagram"
  | "function"
  | "value_embed"
  | "latex"
  | "user_mention"
  | "anchor_link"
  | "resource_link"
  | "section_generator"
  | "table_row_generator"
  | "conditional_section";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WidgetConfig = Record<string, any>;
export type WidgetBlock = {
  id: string;
  type: "widget";
  kind: WidgetKind;
  config: WidgetConfig;
  children?: NotepadBlock[];
  locked?: { at: string; by?: { id?: string; name: string }; data: unknown } | null;
};
export type NotepadBlock = TextBlock | HeadingBlock | TableBlock | ImageBlock | RuleBlock | PageBreakBlock | DateBlock | AppLinkBlock | WidgetBlock;
export type TemplateInput = { name: string; type: "string" | "number" | "date" | "timestamp" | "object" | "object_set"; object_type_id?: string | null; preview?: unknown; required?: boolean };
export type PublishedVersion = { version: number; name: string; at: string; by: { name: string } };
export type TemplateSpec = { inputs: TemplateInput[]; published: (PublishedVersion & { document?: unknown })[] };
export type PageSettings = { size: "letter" | "a4" | "legal"; orientation: "portrait" | "landscape"; header: string; footer: string };
export type NotepadDocument = { schema_version: 1; blocks: NotepadBlock[]; template?: TemplateSpec | null; settings?: PageSettings | null; envelope?: boolean };
/** The widgets an envelope-secured document allows (notepad_engine.ENVELOPE_WIDGETS). */
export const ENVELOPE_WIDGETS: WidgetKind[] = ["object_property", "object_card", "object_media", "object_markdown", "latex", "anchor_link", "user_mention"];
export type LocatedDriveItem = DriveItem & { path?: { id: string; name: string }[] };
export type OpenNotepadDocument = { item: LocatedDriveItem; document: NotepadDocument };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WidgetData = Record<string, any> & { error?: string; locked?: { at: string; by?: { name: string } }; generator?: boolean; empty?: boolean };
export type Version = { id: string; at: string; by: { name: string }; name: string; endorsed: boolean; auto: boolean };
export type LinkedDocument = LocatedDriveItem & { rid: string; author: string | null; template: boolean };
/** A document's resource identifier (what Workshop variables hold) and back: the Files item id behind the prefix. */
export const NOTEPAD_RID = "ri.notepad.main.notepad.";
export const notepadRid = (itemId: string) => NOTEPAD_RID + itemId;
export const notepadItemId = (ridOrId: unknown): string | null => {
  const s = typeof ridOrId === "string" ? ridOrId.trim() : "";
  if (!s) return null;
  return s.startsWith(NOTEPAD_RID) ? s.slice(NOTEPAD_RID.length) || null : s;
};

/** Text as Notepad blocks. Markdown: headings (#, ##, ###) and paragraphs (lists stay in one paragraph block);
 * plain text: a paragraph per blank-line-separated part, with Markdown's special characters escaped. */
export function textBlocks(text: string, format: "markdown" | "plain"): NotepadBlock[] {
  const out: NotepadBlock[] = [];
  const uid = () => crypto.randomUUID();
  for (const part of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    if (format === "plain") {
      if (part.trim()) out.push({ id: uid(), type: "paragraph", text: part.trim().replace(/([\\`*_{}\[\]<>#+\-!|~])/g, "\\$1") });
      continue;
    }
    let para: string[] = [];
    const flush = () => {
      if (para.join("").trim()) out.push({ id: uid(), type: "paragraph", text: para.join("\n").trim() });
      para = [];
    };
    for (const line of part.split("\n")) {
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) {
        flush();
        out.push({ id: uid(), type: "heading", level: h[1].length as 1 | 2 | 3, text: h[2].trim() });
      } else para.push(line);
    }
    flush();
  }
  return out.slice(0, 200);
}

export type TemplateListItem = LocatedDriveItem & { versions: PublishedVersion[]; inputs: TemplateInput[] };

export const WIDGETS: { kind: WidgetKind; label: string; group: "Nexus" | "Applications" | "Native" | "Template" }[] = [
  { kind: "object_property", label: "Object property", group: "Nexus" },
  { kind: "object_card", label: "Object card", group: "Nexus" },
  { kind: "object_media", label: "Object media preview", group: "Nexus" },
  { kind: "object_markdown", label: "Object property Markdown editor", group: "Nexus" },
  { kind: "map", label: "Map", group: "Nexus" },
  { kind: "contour_chart", label: "Contour chart", group: "Applications" },
  { kind: "quiver_chart", label: "Quiver chart", group: "Applications" },
  { kind: "quiver_dashboard", label: "Quiver dashboard", group: "Applications" },
  { kind: "vertex_graph", label: "Vertex graph", group: "Applications" },
  { kind: "code_workbook_chart", label: "Code Workbook chart", group: "Applications" },
  { kind: "solution_diagram", label: "Solution Designer diagram", group: "Applications" },
  { kind: "function", label: "Function", group: "Applications" },
  { kind: "latex", label: "LaTeX", group: "Native" },
  { kind: "user_mention", label: "User mention", group: "Native" },
  { kind: "anchor_link", label: "Anchor link", group: "Native" },
  { kind: "resource_link", label: "Resource link", group: "Native" },
  { kind: "value_embed", label: "Value embed", group: "Template" },
  { kind: "section_generator", label: "Section generator", group: "Template" },
  { kind: "table_row_generator", label: "Table row generator", group: "Template" },
  { kind: "conditional_section", label: "Conditional section", group: "Template" },
];

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(API_URL + path, { cache: "no-store", ...init });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      message = typeof body.detail === "string" ? body.detail : body.detail ? JSON.stringify(body.detail) : message;
    } catch {}
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const doc = (id: string) => `/api/notepad/documents/${encodeURIComponent(id)}`;

export type GenerationLimits = { top: number; nested: number; rows: number };
/** A published Quiver dashboard's input (notepad_engine.dashboard_inputs): `type` is Quiver's, `accepts` the Notepad input types mapped to it. */
export type DashboardInput = {
  key: string;
  kind: "object" | "param" | "selector";
  card_id: string | null;
  title: string;
  type: "Boolean" | "Number" | "String" | "Time" | "Time Range" | "Object" | "Object Set" | "String List";
  accepts: TemplateInput["type"][];
  default: unknown;
  object_type_id: string | null;
};
export type DashboardInfo = { item_id: string; name: string; version: number; latest: number; versions: { version: number; at: string; note: string }[]; inputs: DashboardInput[] };
export const notepad = {
  settings: () => request<{ limits: GenerationLimits; defaults: GenerationLimits; max: GenerationLimits }>("/api/notepad/settings"),
  saveSettings: (limits: Partial<GenerationLimits>) =>
    request<{ limits: GenerationLimits; defaults: GenerationLimits; max: GenerationLimits }>("/api/notepad/settings", { ...json(limits), method: "PUT" }),
  documents: () => request<LocatedDriveItem[]>("/api/notepad/documents"),
  folders: () => request<LocatedDriveItem[]>("/api/notepad/folders"),
  templates: () => request<TemplateListItem[]>("/api/notepad/templates"),
  get: (id: string) => request<OpenNotepadDocument>(doc(id)),
  create: (body: { name: string; parent_id: string | null; document: NotepadDocument }) => request<OpenNotepadDocument>("/api/notepad/documents", json(body)),
  /** AIP assist: Markdown from a language model, with the (draft) document as context */
  assist: (id: string, body: { mode: "write" | "rewrite" | "summarize"; instruction: string; selection?: string | null; document?: NotepadDocument | null }) =>
    request<{ markdown: string; model: string; context_chars: number }>(`${doc(id)}/assist`, json(body)),
  save: (id: string, expectedUpdatedAt: string, document: NotepadDocument) =>
    request<OpenNotepadDocument>(doc(id), { ...json({ expected_updated_at: expectedUpdatedAt, document }), method: "PUT" }),
  resolve: (id: string, document?: NotepadDocument, inputs: Record<string, unknown> = {}) =>
    request<{ widgets: Record<string, WidgetData>; banner?: string | null }>(`${doc(id)}/resolve`, json({ document, inputs })),
  /** An embedded Quiver dashboard re-run with a reader's selections (nothing saved); `block`: the widget as drafted. */
  runDashboard: (id: string, blockId: string, selections: Record<string, unknown>, block?: WidgetBlock) =>
    request<{ selections: Record<string, unknown>; tables: WidgetData }>(`${doc(id)}/widgets/${encodeURIComponent(blockId)}/run`, json({ selections, block })),
  /** A published Quiver dashboard's versions and a version's (default: the latest) inputs, for the widget's properties. */
  dashboardInfo: (itemId: string, version?: number | null) =>
    request<DashboardInfo>(`/api/notepad/quiver-dashboards/${encodeURIComponent(itemId)}${version ? `?version=${version}` : ""}`),
  lock: (id: string, lock: boolean, blockIds?: string[]) => request<OpenNotepadDocument & { changed: number }>(`${doc(id)}/lock`, json({ lock, block_ids: blockIds })),
  versions: (id: string, all: boolean) => request<Version[]>(`${doc(id)}/versions?all=${all}`),
  saveVersion: (id: string, name: string, endorsed: boolean) => request<Version>(`${doc(id)}/versions`, json({ name, endorsed })),
  version: (id: string, versionId: string) =>
    request<Version & { document: NotepadDocument; changes: { op: "added" | "removed"; text: string }[] }>(`${doc(id)}/versions/${versionId}`),
  restore: (id: string, versionId: string) => request<OpenNotepadDocument>(`${doc(id)}/versions/${versionId}/restore`, json({})),
  publish: (id: string, name: string) => request<OpenNotepadDocument & { version: number }>(`${doc(id)}/template/publish`, json({ name })),
  generate: (id: string, body: { inputs: Record<string, unknown>; version?: number | "draft"; name?: string; parent_id?: string | null; dry_run?: boolean }) =>
    request<OpenNotepadDocument & { widgets?: Record<string, WidgetData> }>(`${doc(id)}/template/generate`, json(body)),
  saveAsTemplate: (id: string, name: string) => request<OpenNotepadDocument>(`${doc(id)}/save-as-template`, json({ name })),
  links: (id: string) =>
    request<{ objects: { object_type_id: string; pk: string; title: string | null }[]; resources: { id: string; kind: string; name?: string | null }[] }>(`${doc(id)}/links`),
  exportUrl: (id: string, format: "docx" | "markdown" | "pdf", filename?: string) =>
    `${API_URL}${doc(id)}/export?format=${format}${filename ? `&filename=${encodeURIComponent(filename)}` : ""}`,
  /** documents whose widgets reference an object (Workshop's Notepad: Linked documents) */
  linkedDocuments: (objectTypeId: string, pk: string) =>
    request<LinkedDocument[]>(`/api/notepad/linked-documents?object_type_id=${encodeURIComponent(objectTypeId)}&pk=${encodeURIComponent(pk)}`),
  people: () => request<{ id: string; label: string }[]>("/api/dataset-preview/tools/people"),
};
