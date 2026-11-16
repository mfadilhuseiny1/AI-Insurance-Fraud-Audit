/** Spaces, Project constraints / templates / portfolios (api/governance_model.py) and restricted views (api/restricted_views.py). */
import { API_URL } from "./api";

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + path, {
    cache: "no-store",
    credentials: "include",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

export type RoleGrant = { principal_type: "user" | "group" | "everyone"; principal_id: string; role: string; name?: string; role_label?: string };
export type Space = {
  id: string;
  name: string;
  description: string;
  organizations: string[];
  owners: string[];
  editors: string[];
  viewers: string[];
  inherited_roles: RoleGrant[];
  /** inherited by the locked Projects Marketplace installations create, instead of inherited_roles */
  marketplace_inherited_roles?: RoleGrant[];
  role_set: string[];
  max_classification?: string | null;
  storage?: "default" | "local" | "s3";
  resource_queue?: string | null;
  usage_account?: string;
  maven_group?: string;
  deletion_organizations?: string[];
  deletion_pending?: boolean;
  builtin?: boolean;
  my_role: "owner" | "editor" | "viewer" | null;
  /** what the caller's roles on the space allow (SPACE_WORKFLOWS in api/governance_model.py) */
  my_workflows?: string[];
  custom_roles?: SpaceRole[];
  project_count: number | null;
};
export type SpaceRole = { id: string; name: string; workflows: string[]; grants: string[] };
export type SpaceBody = Omit<Space, "id" | "builtin" | "my_role" | "my_workflows" | "custom_roles" | "project_count" | "deletion_pending">;
export type Constraints = { mode: "none" | "allowed" | "prohibited"; markings: string[]; marking_names?: string[] };
export type Violation = { id: string; name: string; path?: string; kind: string; markings: string[]; marking_names: string[] };
export type ProjectGovernance = {
  project_id: string;
  space: { id: string; name: string; organizations: string[]; inherited_roles: RoleGrant[]; role_set: string[] };
  /** groups hidden from the Project's access request form */
  request_excluded_groups?: string[];
  /** set on a locked Project a Marketplace installation created */
  marketplace?: { product: string; name: string; version: string } | null;
  portfolio: { id: string; name: string } | null;
  constraints: Constraints;
  classification: string | null;
  template_id: string | null;
  violations: Violation[];
};
export type Template = {
  id: string;
  space_id: string;
  name: string;
  description: string;
  variables: string[];
  creator_role: string | null;
  roles: { principal: string; role: string }[];
  default_role: string | null;
  new_groups: { name: string }[];
  manager_group?: number | null;
  new_markings: { name: string; description?: string }[];
  markings: string[];
  constraints: Constraints;
  folders: string[];
};
export type TemplateBody = Omit<Template, "id">;
export type Portfolio = {
  id: string;
  space_id: string;
  name: string;
  description: string;
  color: string;
  curators: string[];
  documentation: string;
  projects: { id: string; name: string; role: string | null }[];
  hidden_projects: number;
  promoted: { id: string; name: string; kind: string; project_id: string | null }[];
  can_curate: boolean;
  thumbnail_item_id?: string | null;
  display_names?: Record<string, string>;
};
export type RestrictedView = {
  id: string;
  rid: string;
  name: string;
  description: string;
  project_id: string;
  backing_item_id: string;
  backing_name?: string;
  policy?: PolicyNode;
  stop_propagating: string[];
  stop_propagating_names: string[];
  markings: { id: string; name: string }[];
  transactions: number;
  my_role: string | null;
  created_at: string;
  updated_at?: string;
  branch?: string;
  /** policy and marking changes go through a global branch */
  protected?: boolean;
  object_types?: string[];
};
export type PolicySide = { kind: string; property?: string; attribute?: string; value?: string };
export type PolicyNode =
  | { kind: "and" | "or"; children: PolicyNode[] }
  | { kind: "condition"; op: "equals" | "intersects" | "contains_all" | "is_empty" | "is_not_empty"; left: PolicySide; right?: PolicySide };

const G = "/api/governance";
const RV = "/api/restricted-views";
type ViewVersion = { policy: PolicyNode; stop_propagating: string[] };
/** a restricted view on a global branch (api/restricted_views.py) */
export type ViewBranch = {
  branch_id: string;
  branch_name: string;
  added: boolean;
  main: ViewVersion;
  base?: ViewVersion;
  branch?: ViewVersion;
  status?: string;
  changed?: string[];
  conflicts?: string[];
  needs_rebase?: boolean;
  approved?: boolean;
  approvals?: number;
  reviews?: Record<string, { decision: string; at: string; counts: boolean }>;
  built_at?: string | null;
  reindexed?: string[];
  can_edit_policy?: boolean;
};

export const governance = {
  spaces: () => req<Space[]>(`${G}/spaces`),
  createSpace: (body: SpaceBody) => req<Space>(`${G}/spaces`, { method: "POST", json: body }),
  updateSpace: (id: string, body: SpaceBody) => req<Space>(`${G}/spaces/${id}`, { method: "PUT", json: body }),
  deleteSpace: (id: string) => req<{ deleted: string }>(`${G}/spaces/${id}`, { method: "DELETE" }),
  spaceWorkflows: () => req<{ workflows: { id: string; label: string }[]; defaults: Record<"viewer" | "editor" | "owner", string[]> }>(`${G}/space-workflows`),
  createSpaceRole: (sid: string, body: Omit<SpaceRole, "id">) => req<Space>(`${G}/spaces/${sid}/roles`, { method: "POST", json: body }),
  updateSpaceRole: (sid: string, rid: string, body: Omit<SpaceRole, "id">) => req<Space>(`${G}/spaces/${sid}/roles/${rid}`, { method: "PUT", json: body }),
  deleteSpaceRole: (sid: string, rid: string) => req<Space>(`${G}/spaces/${sid}/roles/${rid}`, { method: "DELETE" }),
  setRequestExcluded: (id: string, groups: string[]) => req<ProjectGovernance>(`${G}/projects/${id}/request-excluded-groups`, { method: "PUT", json: { groups } }),
  unlockProject: (id: string) => req<ProjectGovernance>(`${G}/projects/${id}/unlock`, { method: "POST" }),
  spaceProjects: (id: string) => req<{ id: string; name: string; portfolio_id: string | null; role: string | null }[]>(`${G}/spaces/${id}/projects`),
  project: (id: string) => req<ProjectGovernance>(`${G}/projects/${id}`),
  setConstraints: (id: string, body: { mode: Constraints["mode"]; markings: string[] }) =>
    req<ProjectGovernance>(`${G}/projects/${id}/constraints`, { method: "PUT", json: body }),
  moveProject: (id: string, spaceId: string) => req<ProjectGovernance>(`${G}/projects/${id}/space`, { method: "PUT", json: { space_id: spaceId } }),
  createProject: (body: { name: string; space_id?: string; template_id?: string | null; variables?: Record<string, string>; portfolio_id?: string | null; classification?: string | null }) =>
    req<{ id: string; name: string }>(`${G}/projects`, { method: "POST", json: body }),
  templates: (spaceId?: string) => req<Template[]>(`${G}/templates${spaceId ? `?space_id=${spaceId}` : ""}`),
  createTemplate: (body: TemplateBody) => req<Template>(`${G}/templates`, { method: "POST", json: body }),
  updateTemplate: (id: string, body: TemplateBody) => req<Template>(`${G}/templates/${id}`, { method: "PUT", json: body }),
  deleteTemplate: (id: string) => req<{ deleted: string }>(`${G}/templates/${id}`, { method: "DELETE" }),
  portfolios: (spaceId?: string) => req<Portfolio[]>(`${G}/portfolios${spaceId ? `?space_id=${spaceId}` : ""}`),
  portfolio: (id: string) => req<Portfolio>(`${G}/portfolios/${id}`),
  createPortfolio: (body: { space_id: string; name: string; description?: string; color?: string }) => req<Portfolio>(`${G}/portfolios`, { method: "POST", json: body }),
  updatePortfolio: (
    id: string,
    body: { space_id: string; name: string; description: string; color: string; curators: string[]; documentation: string; promoted: string[]; thumbnail_item_id?: string | null },
  ) =>
    req<Portfolio>(`${G}/portfolios/${id}`, { method: "PUT", json: body }),
  setPortfolioProjects: (id: string, projects: string[], displayNames: Record<string, string> = {}) =>
    req<Portfolio>(`${G}/portfolios/${id}/projects`, { method: "PUT", json: { projects, display_names: displayNames } }),
  deletePortfolio: (id: string) => req<{ deleted: string }>(`${G}/portfolios/${id}`, { method: "DELETE" }),

  restrictedViews: (projectId?: string) => req<RestrictedView[]>(`${RV}${projectId ? `?project_id=${projectId}` : ""}`),
  restrictedView: (id: string) => req<RestrictedView>(`${RV}/${id}`),
  createRestrictedView: (body: { name: string; description?: string; project_id: string; backing_item_id: string; policy: PolicyNode; stop_propagating?: string[]; branch?: string }) =>
    req<RestrictedView>(RV, { method: "POST", json: body }),
  updateRestrictedView: (id: string, body: { name?: string; description?: string; policy?: PolicyNode; stop_propagating?: string[] }) =>
    req<RestrictedView>(`${RV}/${id}`, { method: "PUT", json: body }),
  deleteRestrictedView: (id: string) => req<{ deleted: string }>(`${RV}/${id}`, { method: "DELETE" }),
  restrictedRows: (id: string, limit = 200, offset = 0) =>
    req<{ columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; total_rows: number }>(`${RV}/${id}/rows?limit=${limit}&offset=${offset}`),
  previewPolicy: (id: string, policy: PolicyNode, userId?: string) =>
    req<{ visible_rows: number; total_rows: number }>(`${RV}/${id}/preview`, { method: "POST", json: { policy, user_id: userId || null } }),
  applyToObjectType: (id: string, objectTypeId: string) => req<unknown>(`${RV}/${id}/object-type`, { method: "POST", json: { object_type_id: objectTypeId } }),
  setRestrictedProtection: (id: string, value: boolean) => req<RestrictedView>(`${RV}/${id}/protection`, { method: "PUT", json: { protected: value } }),
  globalBranches: () => req<{ id: string; name: string; status: string }[]>(`/api/ontology/branches?status=open`),
  viewOnBranch: (id: string, branchId: string) => req<ViewBranch>(`${RV}/${id}/branches/${branchId}`),
  addViewToBranch: (id: string, branchId: string, body: { policy?: PolicyNode; stop_propagating?: string[] } = {}) =>
    req<ViewBranch>(`${RV}/${id}/branches/${branchId}`, { method: "POST", json: body }),
  editViewOnBranch: (id: string, branchId: string, body: { policy?: PolicyNode; stop_propagating?: string[] }) =>
    req<ViewBranch>(`${RV}/${id}/branches/${branchId}`, { method: "PUT", json: body }),
  removeViewFromBranch: (id: string, branchId: string) => req<{ removed: boolean }>(`${RV}/${id}/branches/${branchId}`, { method: "DELETE" }),
  rebaseView: (id: string, branchId: string, choices: Record<string, "main" | "branch">) =>
    req<ViewBranch>(`${RV}/${id}/branches/${branchId}/rebase`, { method: "POST", json: { choices } }),
  reviewView: (id: string, branchId: string, decision: "approve" | "reject") => req<ViewBranch>(`${RV}/${id}/branches/${branchId}/review`, { method: "POST", json: { decision } }),
  mergeView: (id: string, branchId: string) => req<ViewBranch>(`${RV}/${id}/branches/${branchId}/merge`, { method: "POST" }),
  viewRowsOnBranch: (id: string, branchId: string) =>
    req<{ columns: string[]; rows: Record<string, unknown>[]; total: number; on_branch: boolean }>(`${RV}/${id}/branches/${branchId}/rows`),
  restrictedTransactions: (id: string) => req<{ at: string; by: string | null; policy: PolicyNode; stop_propagating: string[] }[]>(`${RV}/${id}/transactions`),
};

/** "user:<id>" / "group:<id>" / "everyone" lists, shown with names. */
export function principalLabel(key: string, users: { id: string; display_name?: string; username: string }[], groups: { id: string; name: string }[]): string {
  if (key === "everyone") return "Everyone";
  const [t, id] = key.split(":");
  if (t === "group") return `${groups.find((g) => g.id === id)?.name ?? id} (group)`;
  const u = users.find((x) => x.id === (id ?? t));
  return u ? u.display_name || u.username : (id ?? t);
}
