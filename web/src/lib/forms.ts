/** Forms [Sunset] (api/forms.py): definitions, published versions, evaluation, submissions and responses. */
import { API_URL, type DriveItem } from "./api";

export const FIELD_TYPES = [
  ["text", "Text"],
  ["textarea", "Text area"],
  ["numeric", "Numeric"],
  ["slider", "Slider"],
  ["dropdown", "Dropdown"],
  ["radio", "Radio buttons"],
  ["checkboxes", "Checkboxes"],
  ["date", "Date picker"],
  ["url", "URL"],
  ["callout", "Callout"],
  ["user_dropdown", "User dropdown"],
  ["object_dropdown", "Object dropdown"],
  ["object_property_dropdown", "Object property dropdown"],
  ["dataset_value_dropdown", "Dataset value dropdown"],
  ["objects_provider", "Objects provider"],
  ["object_property_display", "Object property display"],
  ["user_properties", "User properties"],
  ["map_picker", "Map picker"],
  ["resource_picker", "Resource picker"],
  ["calculation", "Calculation"],
  ["created_at", "Created at"],
  ["created_by", "Created by"],
  ["primary_key", "Generate primary key"],
  ["template", "Template"],
  ["attachments", "Attachments"],
] as const;
export type FieldType = (typeof FIELD_TYPES)[number][0];
export type Condition = { field?: string; op?: "is" | "is_not" | "has_value" | "no_value" | "contains"; value?: unknown; all?: Condition[]; any?: Condition[]; not?: Condition };
export type Validator = { kind: "required" | "regex" | "range" | "length"; pattern?: string; min?: number; max?: number; message?: string };
export type Transform = { kind: "hide" | "show" | "disable" | "update" | "change_type"; condition?: Condition; patch?: Record<string, unknown>; type?: FieldType };
export type FormField = {
  id: string;
  type: FieldType;
  label?: string;
  description?: string;
  column?: string;
  placeholder?: string;
  /** the URL parameter that prefills this field in an embedded form (besides field.<id>) */
  url_param?: string;
  default?: unknown;
  options?: { value: unknown; label?: string }[];
  multiple?: boolean;
  allow_other?: boolean;
  readonly?: boolean;
  hidden?: boolean;
  validators?: Validator[];
  transforms?: Transform[];
  unit?: string;
  min?: string | number;
  max?: string | number;
  step?: number;
  no_past?: boolean;
  no_future?: boolean;
  formula?: string;
  precision?: number;
  text?: string;
  dataset?: string;
  dataset_column?: string;
  filter_field?: string;
  filter_column?: string;
  filter_property?: string;
  object_type_id?: string;
  property?: string;
  source_field?: string;
  folder_id?: string;
  rows?: number;
  /** map picker: the map's starting center [lat, lon] and zoom */
  location?: [number, number];
  initial_zoom?: number;
  /** resource picker: what may be picked */
  allow?: "any" | "folders" | "datasets";
  /** user properties: which property, and the messages */
  none_message?: string;
  missing_message?: string;
  empty_message?: string;
};
export type FormSheet = { id: string; title: string; columns?: number; description?: string; fields: FormField[]; multiplicity?: { kind: "free" | "parameterized"; param_field?: string; param_target?: string } | null };
export type Destination = { kind: "none" | "fusion" | "object_type"; document_id?: string; table?: string; key_first_column?: boolean; object_type_id?: string };
export type FormDefinition = { title: string; description: string; sheets: FormSheet[]; destination: Destination; settings: { submit_label?: string; allow_without_permissions?: boolean; /** shown after a submission */ confirmation?: string } };
export type Form = FormDefinition & { versions: { n: number; name: string; at: string; by: string }[]; published: number | null; subscribers: string[] };
export type FormView = { item: DriveItem & { path?: { id: string; name: string }[] }; form: Form; can_edit: boolean; responses: number };
export type Evaluation = {
  definition: Pick<FormDefinition, "title" | "description" | "sheets" | "settings">;
  fields: Record<string, FormField & { hidden: boolean; disabled: boolean }>;
  values: Record<string, unknown>;
  options: Record<string, { value: unknown; label: string }[]>;
  errors: Record<string, string>;
  callouts: Record<string, string>;
};
export type FormResponse = { id: string; at: string; by: string; version: number; rows: Record<string, unknown>[]; written: Record<string, string>[]; edits?: { at: string; by: string; row: number }[] };

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/forms" + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      detail = (await res.json()).detail;
    } catch {}
    const errors = detail && typeof detail === "object" && "errors" in detail ? (detail as { errors: Record<string, string> }).errors : undefined;
    const err = new Error(typeof detail === "string" ? detail : errors ? Object.values(errors).join("; ") : JSON.stringify(detail)) as Error & { errors?: Record<string, string> };
    err.errors = errors;
    throw err;
  }
  return res.json() as Promise<T>;
}

/** A respondent link travels with the form ID ("<id>~link~<token>") through the fill components to these calls. */
export const withLink = (id: string, link?: string | null) => (link ? `${id}~link~${link}` : id);
const at = (id: string, suffix: string) => {
  const [fid, link] = id.split("~link~");
  return `/${fid}${suffix}${link ? `?link=${encodeURIComponent(link)}` : ""}`;
};
export type RespondentLink = { token: string; label: string; created_at: string; by: string; expires_at: string | null };

export const forms = {
  list: () => req<(DriveItem & { path?: { id: string; name: string }[]; responses: number })[]>(""),
  create: (title: string, parentId?: string | null) => req<FormView>("", { method: "POST", json: { title, parent_id: parentId ?? undefined } }),
  get: (id: string) => req<FormView>(`/${id}`),
  save: (id: string, form: Partial<FormDefinition>) => req<FormView>(`/${id}`, { method: "PUT", json: { form } }),
  code: (id: string) => req<{ yaml: string }>(`/${id}/code`),
  saveCode: (id: string, yaml: string) => req<FormView>(`/${id}/code`, { method: "PUT", json: { yaml } }),
  publish: (id: string, name = "") => req<FormView>(`/${id}/publish`, { method: "POST", json: { name } }),
  subscribe: (id: string, on: boolean) => req<{ subscribed: boolean }>(`/${id}/subscribe?on=${on}`, { method: "POST" }),
  evaluate: (id: string, values: Record<string, unknown>, draft = false) => req<Evaluation>(at(id, "/evaluate"), { method: "POST", json: { values, draft } }),
  submit: (id: string, body: { values: Record<string, unknown>; entries?: Record<string, Record<string, unknown>[]>; opened_at?: string; source?: SubmitSource }) =>
    req<Submission>(at(id, "/submit"), { method: "POST", json: body }),
  /** the values an embedded form starts with: URL parameters and the object it is embedded for, validated by the server */
  prefill: (id: string, body: { params: Record<string, string | string[]>; object_type?: string | null; pk?: string | null }) => req<Prefill>(at(id, "/prefill"), { method: "POST", json: body }),
  responses: (id: string) => req<FormResponse[]>(`/${id}/responses`),
  editResponse: (id: string, rid: string, row: number, values: Record<string, unknown>) => req<FormResponse>(`/${id}/responses/${rid}`, { method: "PUT", json: { row, values } }),
  attach: (id: string, filename: string, data: string, folder_id?: string) => req<{ id: string; name: string }>(at(id, "/attachments"), { method: "POST", json: { filename, data, folder_id } }),
  links: (id: string) => req<RespondentLink[]>(`/${id}/links`),
  /** per-user sharing of this form (respondent / viewer / editor), beyond its Project's roles */
  collaborators: (id: string) => req<Collaborator[]>(`/${id}/collaborators`),
  setCollaborators: (id: string, collaborators: { user_id?: string; username?: string; role: Collaborator["role"] }[]) =>
    req<Collaborator[]>(`/${id}/collaborators`, { method: "PUT", json: { collaborators } }),
  createLink: (id: string, body: { expires_days?: number | null; label?: string }) => req<RespondentLink>(`/${id}/links`, { method: "POST", json: body }),
  deleteLink: (id: string, token: string) => req<unknown>(`/${id}/links/${encodeURIComponent(token)}`, { method: "DELETE" }),
};

export type Collaborator = { user_id: string; role: "respondent" | "viewer" | "editor"; added_by: string; at: string; user: { id: string; username: string; display_name: string | null; status: string } | null };

/* ---- embedding (doc "Slate", "Object Explorer"): the fill page in an iframe */

export type SubmitSource = { embedded?: boolean; object_type?: string; pk?: string };
export type Submission = { response_id: string; form_id?: string; rows: number; written: unknown[]; edited_object?: boolean };
export type Prefill = {
  values: Record<string, unknown>;
  /** parameter → why its value was not applied */
  ignored: Record<string, string>;
  object: { object_type_id: string; primary_key: string; title?: string } | null;
  /** the form writes to the object's own type: submitting edits that object */
  edits_object: boolean;
};

/** The fill page's own URL parameters (never field values). */
export const EMBED_PARAMS = ["embed", "embedded", "noHeader", "progressOnly", "forceDarkMode", "link", "object_type", "pk"];

/** Messages an embedded form posts to its host page (window.parent.postMessage(message, "*")). */
export const FORM_SUBMITTED = "bluesandai.form.submitted";
export const FORM_HEIGHT = "bluesandai.form.height";
export type FormSubmittedMessage = { type: typeof FORM_SUBMITTED; form_id: string; response_id: string; rows: number; object: { object_type: string; pk: string } | null; edited_object: boolean };
export type FormHeightMessage = { type: typeof FORM_HEIGHT; form_id: string; height: number };

export type FormEmbedOptions = {
  /** the object the form is embedded for (an object view): object dropdowns of its type select it, {{property}} values come from it, a form on its own type edits it */
  object?: { objectType: string; pk: string } | null;
  /** field ID → value ("{{property}}" with an object) */
  prefill?: Record<string, string | number | boolean | (string | number)[] | null | undefined>;
  /** a respondent link's token */
  link?: string | null;
  /** hide the form's title and description */
  noHeader?: boolean;
};

/** The path of the embedded fill page: /forms/<id>/fill?embed=1[&noHeader=true][&object_type=…&pk=…][&field.<id>=…][&link=…]. */
export function formEmbedPath(id: string, o: FormEmbedOptions = {}): string {
  const q = [`embed=1`];
  const enc = (v: string) => encodeURIComponent(v).replace(/%7B/g, "{").replace(/%7D/g, "}");
  if (o.noHeader) q.push("noHeader=true");
  if (o.object) q.push(`object_type=${enc(o.object.objectType)}`, `pk=${enc(o.object.pk)}`);
  for (const [k, v] of Object.entries(o.prefill ?? {})) {
    if (v === null || v === undefined || v === "") continue;
    for (const x of Array.isArray(v) ? v : [v]) q.push(`field.${enc(k)}=${enc(String(x))}`);
  }
  if (o.link) q.push(`link=${enc(o.link)}`);
  return `/forms/${encodeURIComponent(id)}/fill?${q.join("&")}`;
}
