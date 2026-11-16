import { API_URL } from "./api";

/** Business logic as functions (api/function_integration.py): templates, AIP-written code, repositories, usage. */

export type LogicTemplate = { key: string; name: string; category: string; description: string; uses: string[]; code: string; object_type: string | null };
export type FunctionUse = { kind: string; name: string; id?: string; link?: string; kind_label?: string; version?: string };
export type IntegratedFunction = {
  id: string; name: string; kind: string; version: string; api_name?: string | null; repo_id: string; doc: string;
  signature?: unknown; output?: unknown; used_by: FunctionUse[]; released_at?: string;
};
export type CreatedLogic = { repo_id: string; file: string; functions: string[]; published: boolean; version?: string; publish_error?: string;
  released?: { id: string; name: string; kind: string }[] };

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`${API_URL}/api/function-integration${path}`, {
    credentials: "include",
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { method: rest.method ?? "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) } : {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const functionIntegration = {
  templates: (objectTypeId?: string | null) =>
    req<{ object_type: { id: string; api_name: string; display_name: string } | null; templates: LogicTemplate[] }>(`/templates${objectTypeId ? `?object_type_id=${encodeURIComponent(objectTypeId)}` : ""}`),
  generate: (prompt: string, objectTypeIds: string[]) => req<{ code: string; explanation: string; functions: string[] }>("/generate", { json: { prompt, object_type_ids: objectTypeIds } }),
  create: (body: { name: string; project_id?: string | null; code: string; description?: string; publish: boolean; version?: string }) =>
    req<CreatedLogic>("/create", { json: body }),
  overview: (tests = false) =>
    req<{ functions: IntegratedFunction[]; uses: Record<string, string[]>; lineage: boolean; hidden_tests: number }>(`/overview${tests ? "?tests=1" : ""}`),
};
