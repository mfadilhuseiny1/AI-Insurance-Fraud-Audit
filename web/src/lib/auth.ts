/**
 * Sign-in and user management (api/auth.py): who is signed in, users, groups, organizations, markings, API tokens
 * and sessions. Importing this module makes every browser request to the API send the session cookie
 * (credentials: "include") and reports a 401 so the app can go to the sign-in page.
 */
import { API_URL } from "./api";
import { askCheckpoint, type CheckpointRequired } from "./checkpoints";

export type MarkingRef = { id: string; name: string; color?: string | null; kind?: "marking" | "organization" };
export type Me = {
  id: string;
  username: string;
  display_name: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  role: "admin" | "user";
  organization_id?: string | null;
  organization?: string | null;
  attributes?: Record<string, string>;
  groups: { id: string; name: string }[];
  markings: MarkingRef[];
  mfa_enabled?: boolean;
  mfa_required?: boolean;
  password_changed_at?: string | null;
  identities?: { provider: string; email?: string }[];
  has_password?: boolean;
  sign_in_method?: string;
  /** emulation mode: the session keeps only these groups and markings (and is not an administrator) */
  emulation?: { groups: string[]; markings: string[]; started_at?: string } | null;
  /** may author / run code on the host (Control Panel → Security → Code execution); false: code actions are disabled */
  can_run_code?: boolean;
};
export type AuthStatus = {
  enabled: boolean;
  setup_needed: boolean;
  user: Me | null;
  /** signed in, but must set up two-factor authentication before anything else */
  mfa_enrollment_required?: boolean;
  idle_timeout_minutes?: number;
};
export type PasswordPolicy = {
  password_min_length: number;
  password_require_upper: boolean;
  password_require_lower: boolean;
  password_require_digit: boolean;
  password_require_symbol: boolean;
  password_block_common: boolean;
  password_history: number;
  password_max_age_days: number;
};
export type SsoProvider = { id: string; name: string; kind: "oidc" | "saml"; start: string };
export type PublicPolicy = { password: PasswordPolicy; sso: SsoProvider[]; password_login: boolean; email: boolean; idle_timeout_minutes: number };
/** what a password sign-in answers: signed in, or the next step */
export type LoginResult = {
  user?: Me;
  mfa_enrollment_required?: boolean;
  mfa_required?: boolean;
  mfa_token?: string;
  password_expired?: boolean;
  reset_token?: string;
  reason?: string;
};
export type SecuritySettings = {
  password_min_length: number;
  password_require_upper: boolean;
  password_require_lower: boolean;
  password_require_digit: boolean;
  password_require_symbol: boolean;
  password_block_common: boolean;
  password_history: number;
  password_max_age_days: number;
  session_days: number;
  idle_timeout_minutes: number;
  mfa_required_admins: boolean;
  mfa_required_all: boolean;
  login_max_per_user: number;
  login_max_per_ip: number;
  login_window_minutes: number;
  invite_days: number;
  reset_minutes: number;
  sso_auto_create: boolean;
  sso_allowed_domains: string[];
  sso_attribute_claims: string[];
  sso_default_role: "user" | "admin";
  password_login: boolean;
  project_default_role: "none" | "discoverer" | "viewer" | "editor";
  require_project_classification: boolean;
  files_outside_projects: "creator" | "everyone";
  inactive_days: number;
  code_execution: "admins" | "groups" | "everyone";
  code_execution_groups: string[];
};
/** a default role, or a custom role's id (role-…) */
export type ProjectRole = "discoverer" | "viewer" | "editor" | "owner" | (string & {});
export type ProjectRoleEntry = { principal_type: "user" | "group" | "everyone"; principal_id: string; role: ProjectRole; name?: string; role_label?: string };
export type RoleDef = { id: string; name: string; description?: string; operations: string[]; default?: boolean; custom?: boolean; grants?: number };
export type ProjectRoles = {
  project_id: string;
  roles: ProjectRoleEntry[];
  open: boolean;
  my_role: ProjectRole | null;
  my_operations?: string[];
  can_manage: boolean;
  available_roles?: RoleDef[];
  /** roles every Project of its space grants (the space's inherited roles) */
  inherited?: ProjectRoleEntry[];
  space?: { id?: string; name?: string; role_set?: string[]; organizations?: string[] };
  /** a folder's or a file's roles (role grants on folders and files): the item, its Project, and the grants of the
   *  folders above it — they add to the Project's roles for everything inside */
  item_id?: string;
  item?: string;
  project?: string | null;
  from_project?: ProjectRoleEntry[];
  from_folders?: (ProjectRoleEntry & { item_id: string; item: string })[];
};
export type MarkingCategory = {
  id: string;
  name: string;
  description: string;
  kind: "conjunctive" | "disjunctive" | "hierarchical";
  visibility: "visible" | "hidden";
  administrators: string[];
  viewers: string[];
  organization_id: string | null;
  builtin?: boolean;
  my_role?: "administrator" | "viewer" | null;
};
export type User = {
  id: string;
  username: string;
  display_name: string;
  first_name: string;
  last_name: string;
  email: string;
  organization_id: string | null;
  attributes: Record<string, string>;
  role: "admin" | "user";
  markings: string[];
  groups: string[];
  status: "active" | "deactivated" | "invited";
  /** not signed in for the security settings' inactive days: tokens work again after a sign-in */
  inactive?: boolean;
  exempt_from_inactivity?: boolean;
  mfa_enabled?: boolean;
  must_change_password?: boolean;
  password_changed_at?: string | null;
  invited_at?: string | null;
  identities?: { provider: string; email?: string }[];
  disabled: boolean;
  created_at: string;
  last_login_at: string | null;
  last_login_ip?: string | null;
  effective_markings?: string[];
  active_sessions?: number;
  api_tokens?: number;
};
export type Group = {
  id: string;
  name: string;
  description: string;
  members: string[];
  member_names?: string[];
  markings: string[];
  managers?: string[];
  created_at: string;
  member_groups?: string[];
  member_expiry?: Record<string, string>;
  realm?: { provider: string; name: string } | null;
  effective_members?: number;
  /** free attributes; "access-request:<category>" ones are choices of the access request form */
  attributes?: Record<string, string>;
  contact?: GroupContact | null;
  expiry_policy?: { latest?: string; max_days?: number } | null;
  approval_policy?: { min_approvals: number; reviewers: string[] } | null;
};
export type GroupContact = { kind: "email" | "issues"; value: string };
type GroupBody = Pick<Group, "name" | "description" | "members" | "markings" | "managers"> & {
  member_groups?: string[];
  member_expiry?: Record<string, string>;
  realm?: { provider: string; name: string } | Record<string, never>;
  attributes?: Record<string, string>;
  contact?: GroupContact | Record<string, never>;
  expiry_policy?: { latest?: string; max_days?: number } | Record<string, never>;
  approval_policy?: { min_approvals: number; reviewers: string[] } | Record<string, never>;
};
export type Organization = {
  id: string;
  name: string;
  description: string;
  color: string;
  marking: string;
  members: number;
  created_at: string;
  guests?: string[];
  apply?: string[];
  expand_access?: string[];
};
export type Marking = {
  id: string;
  name: string;
  description: string;
  color: string;
  members: number;
  items: number;
  managers?: string[];
  created_at: string;
  category_id?: string;
  category?: string;
  category_kind?: MarkingCategory["kind"];
  level?: number;
  manage?: string[];
  apply?: string[];
  remove?: string[];
  permissions?: { member: boolean; manage: boolean; apply: boolean; remove: boolean };
};
export type MarkingBody = {
  name: string;
  description?: string;
  color?: string;
  managers?: string[];
  category_id?: string;
  level?: number | null;
  manage?: string[];
  apply?: string[];
  remove?: string[];
};
export type ApiToken = {
  id: string;
  name: string;
  description?: string;
  disabled?: boolean;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  token?: string;
};
export type Session = { id: string; created_at: string; expires_at: string; agent: string; current: boolean };
export type AuditEntry = { at: string; event: string; user_id: string | null; username: string | null; actor: string | null; ip: string | null; detail: string };
export type ItemMarkings = {
  item_id: string;
  own: MarkingRef[];
  inherited: MarkingRef[];
  from_folders: (MarkingRef & { folder: string; folder_id: string })[];
  effective: MarkingRef[];
  can_access: boolean;
};

export const UNAUTHENTICATED = "bsai:unauthenticated";
/** the API asks for two-factor setup before anything else */
export const MFA_ENROLLMENT = "bsai:mfa-enrollment";
/** a 403 that says what is missing: {kind: "project", project_id, project, role} or {kind: "marking", markings} */
export const ACCESS_DENIED = "bsai:access-denied";

// every request to the API carries the session cookie; a 401 sends the app to the sign-in page
if (typeof window !== "undefined" && !(window as unknown as { __bsaiFetch?: boolean }).__bsaiFetch) {
  (window as unknown as { __bsaiFetch?: boolean }).__bsaiFetch = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(API_URL)) return original(input, init);
    const res = await original(input, { ...init, credentials: "include" });
    // a checkpoint asks for a justification (api/checkpoints.py): answer it, then retry with the one-time pass
    if (res.status === 428 && !url.startsWith(`${API_URL}/api/checkpoints/`)) {
      const raw = await res.clone().json().catch(() => null);
      // from the middleware the payload is the body; from a checkpoint inside an endpoint it is the body's detail
      const body = raw?.code === "checkpoint_required" ? raw : raw?.detail;
      if (body?.code === "checkpoint_required") {
        const pass = await askCheckpoint(body as CheckpointRequired);
        if (!pass) return res;
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set("x-bluesandai-checkpoint", pass);
        return window.fetch(input instanceof Request ? input.clone() : input, { ...init, headers, credentials: "include" });
      }
    }
    if ((res.status === 401 || res.status === 403) && !url.startsWith(`${API_URL}/api/auth/`)) {
      // the reason (signed out after inactivity, two-factor setup needed) travels with the event
      const code = await res
        .clone()
        .json()
        .then((b: { code?: string; detail?: string }) => b, () => ({}) as { code?: string; detail?: string });
      if (res.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHENTICATED, { detail: code }));
      else if (code.code === "mfa_enrollment_required") window.dispatchEvent(new Event(MFA_ENROLLMENT));
      // what the 403 lacks (a Project role, markings): the app offers "Request access" (an Approvals request)
      const access = res.headers.get("x-bluesandai-access");
      if (res.status === 403 && access) {
        try {
          window.dispatchEvent(new CustomEvent(ACCESS_DENIED, { detail: { ...JSON.parse(access), message: code.detail ?? "" } }));
        } catch {
          // a malformed header is ignored
        }
      }
    }
    return res;
  };
}

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

export const auth = {
  status: () => req<AuthStatus>("/api/auth/status"),
  setup: (body: { username: string; password: string; display_name?: string }) => req<{ user: Me }>("/api/auth/setup", { method: "POST", json: body }),
  login: (username: string, password: string) => req<LoginResult>("/api/auth/login", { method: "POST", json: { username, password } }),
  loginMfa: (mfa_token: string, code: string, recovery_code = "") => req<LoginResult>("/api/auth/login/mfa", { method: "POST", json: { mfa_token, code, recovery_code } }),
  policy: () => req<PublicPolicy>("/api/auth/policy"),
  heartbeat: () => req<{ idle_timeout_minutes: number }>("/api/auth/heartbeat", { method: "POST" }),
  forgot: (login: string) => req<{ sent: boolean; email: boolean }>("/api/auth/password/forgot", { method: "POST", json: { login } }),
  resetInfo: (token: string) => req<{ username: string; display_name?: string; kind: "reset" | "expired"; policy: PasswordPolicy }>(`/api/auth/password/reset/${encodeURIComponent(token)}`),
  reset: (token: string, new_password: string) => req<LoginResult & { reset: boolean }>("/api/auth/password/reset", { method: "POST", json: { token, new_password } }),
  inviteInfo: (token: string) =>
    req<{ username: string; email: string; display_name?: string; policy: PasswordPolicy; sso: SsoProvider[] }>(`/api/auth/invitations/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, password: string, display_name = "") => req<LoginResult>("/api/auth/invitations/accept", { method: "POST", json: { token, password, display_name } }),
  mfa: () => req<{ enabled: boolean; required: boolean; recovery_codes_left: number }>("/api/auth/me/mfa"),
  mfaSetup: () => req<{ secret: string; otpauth_uri: string; qr_svg: string | null }>("/api/auth/me/mfa/setup", { method: "POST" }),
  mfaEnable: (code: string) => req<{ enabled: boolean; recovery_codes: string[] }>("/api/auth/me/mfa/enable", { method: "POST", json: { code } }),
  mfaDisable: (code: string) => req<{ enabled: boolean }>("/api/auth/me/mfa/disable", { method: "POST", json: { code } }),
  mfaRecovery: (code: string) => req<{ recovery_codes: string[] }>("/api/auth/me/mfa/recovery-codes", { method: "POST", json: { code } }),
  settings: () => req<{ settings: SecuritySettings; defaults: SecuritySettings; store: string; email: boolean; sso: SsoProvider[]; web_url: string }>("/api/auth/settings"),
  saveSettings: (values: Partial<SecuritySettings>) =>
    req<{ settings: SecuritySettings; defaults: SecuritySettings; store: string; email: boolean; sso: SsoProvider[]; web_url: string }>("/api/auth/settings", {
      method: "PUT",
      json: values,
    }),
  invite: (body: { email: string; username?: string; display_name?: string; role?: "admin" | "user"; organization_id?: string | null; groups?: string[]; markings?: string[] }) =>
    req<{ user: User; link: string; emailed: boolean }>("/api/auth/invitations", { method: "POST", json: body }),
  resendInvite: (userId: string) => req<{ link: string; emailed: boolean }>(`/api/auth/users/${userId}/invite`, { method: "POST" }),
  resetLink: (userId: string) => req<{ link: string; emailed: boolean }>(`/api/auth/users/${userId}/reset-link`, { method: "POST" }),
  resetUserMfa: (userId: string) => req<{ reset: boolean }>(`/api/auth/users/${userId}/mfa`, { method: "DELETE" }),
  projectRoles: (projectId: string) => req<ProjectRoles>(`/api/auth/projects/${projectId}/roles`),
  setProjectRoles: (projectId: string, roles: ProjectRoleEntry[]) =>
    req<ProjectRoles>(`/api/auth/projects/${projectId}/roles`, { method: "PUT", json: { roles: roles.map(({ principal_type, principal_id, role }) => ({ principal_type, principal_id, role })) } }),
  /** roles granted on a folder or a file of a Project (they add to the Project's roles below it) */
  itemRoles: (itemId: string) => req<ProjectRoles>(`/api/auth/items/${itemId}/roles`),
  setItemRoles: (itemId: string, roles: ProjectRoleEntry[]) =>
    req<ProjectRoles>(`/api/auth/items/${itemId}/roles`, { method: "PUT", json: { roles: roles.map(({ principal_type, principal_id, role }) => ({ principal_type, principal_id, role })) } }),
  logout: () => req<{ signed_out: boolean }>("/api/auth/logout", { method: "POST" }),
  /** sign out here and, for a single sign-on session, at the identity provider: `redirect` is where the browser goes next */
  ssoLogout: () => req<{ signed_out: boolean; redirect: string | null }>("/api/auth/sso/logout", { method: "POST" }),
  me: () => req<Me>("/api/auth/me"),
  updateMe: (body: Partial<Pick<Me, "display_name" | "first_name" | "last_name" | "email">>) => req<Me>("/api/auth/me", { method: "PUT", json: body }),
  changePassword: (current_password: string, new_password: string) => req<{ changed: boolean }>("/api/auth/me/password", { method: "POST", json: { current_password, new_password } }),
  sessions: () => req<Session[]>("/api/auth/me/sessions"),
  revokeSession: (id: string) => req<{ revoked: string }>(`/api/auth/me/sessions/${id}`, { method: "DELETE" }),
  tokens: () => req<ApiToken[]>("/api/auth/tokens"),
  createToken: (name: string, expires_days?: number, description = "") =>
    req<ApiToken>("/api/auth/tokens", { method: "POST", json: { name, description, expires_days: expires_days || null } }),
  updateToken: (id: string, body: { disabled?: boolean; description?: string }) => req<ApiToken>(`/api/auth/tokens/${id}`, { method: "PATCH", json: body }),
  deleteToken: (id: string) => req<{ deleted: string }>(`/api/auth/tokens/${id}`, { method: "DELETE" }),

  users: (q: { q?: string; organization_id?: string; group_id?: string; status?: string } = {}) =>
    req<User[]>(`/api/auth/users?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString()}`),
  user: (id: string) => req<User>(`/api/auth/users/${id}`),
  createUser: (body: Partial<User> & { username: string; password: string; must_change_password?: boolean }) => req<User>("/api/auth/users", { method: "POST", json: body }),
  updateUser: (id: string, body: Partial<Omit<User, "id">> & { password?: string; must_change_password?: boolean }) => req<User>(`/api/auth/users/${id}`, { method: "PUT", json: body }),
  deleteUser: (id: string) => req<{ deleted: string }>(`/api/auth/users/${id}`, { method: "DELETE" }),
  signOutEverywhere: (id: string) => req<{ ended: number }>(`/api/auth/users/${id}/sessions`, { method: "DELETE" }),

  groups: () => req<Group[]>("/api/auth/groups"),
  createGroup: (body: GroupBody) => req<Group>("/api/auth/groups", { method: "POST", json: body }),
  updateGroup: (id: string, body: GroupBody) => req<Group>(`/api/auth/groups/${id}`, { method: "PUT", json: body }),
  deleteGroup: (id: string) => req<{ deleted: string }>(`/api/auth/groups/${id}`, { method: "DELETE" }),

  organizations: () => req<Organization[]>("/api/auth/organizations"),
  createOrganization: (body: { name: string; description?: string; color?: string }) => req<Organization>("/api/auth/organizations", { method: "POST", json: body }),
  updateOrganization: (id: string, body: { name: string; description?: string; color?: string; guests?: string[]; apply?: string[]; expand_access?: string[] }) =>
    req<Organization>(`/api/auth/organizations/${id}`, { method: "PUT", json: body }),
  deleteOrganization: (id: string) => req<{ deleted: string }>(`/api/auth/organizations/${id}`, { method: "DELETE" }),

  markings: () => req<Marking[]>("/api/auth/markings"),
  createMarking: (body: MarkingBody) => req<Marking>("/api/auth/markings", { method: "POST", json: body }),
  updateMarking: (id: string, body: MarkingBody) => req<Marking>(`/api/auth/markings/${id}`, { method: "PUT", json: body }),
  markingCategories: () => req<MarkingCategory[]>("/api/auth/marking-categories"),
  createMarkingCategory: (body: Omit<MarkingCategory, "id" | "builtin" | "my_role">) => req<MarkingCategory>("/api/auth/marking-categories", { method: "POST", json: body }),
  updateMarkingCategory: (id: string, body: Omit<MarkingCategory, "id" | "builtin" | "my_role">) =>
    req<MarkingCategory>(`/api/auth/marking-categories/${id}`, { method: "PUT", json: body }),
  roles: () => req<{ operations: { id: string; description: string }[]; roles: RoleDef[] }>("/api/auth/roles"),
  createRole: (body: { name: string; description?: string; operations: string[] }) => req<RoleDef>("/api/auth/roles", { method: "POST", json: body }),
  updateRole: (id: string, body: { name: string; description?: string; operations: string[] }) => req<RoleDef>(`/api/auth/roles/${id}`, { method: "PUT", json: body }),
  deleteRole: (id: string) => req<{ deleted: string }>(`/api/auth/roles/${id}`, { method: "DELETE" }),
  notificationSettings: () =>
    req<{ sources: { id: string; label: string }[]; settings: Record<string, { web?: boolean; email?: boolean }> }>("/api/auth/me/notifications"),
  setNotificationSettings: (settings: Record<string, { web?: boolean; email?: boolean }>) =>
    req<{ sources: { id: string; label: string }[]; settings: Record<string, { web?: boolean; email?: boolean }> }>("/api/auth/me/notifications", {
      method: "PUT",
      json: { settings },
    }),
  startEmulation: (groups: string[], markings: string[]) => req<{ emulation: unknown }>("/api/auth/me/emulation", { method: "POST", json: { groups, markings } }),
  endEmulation: () => req<{ emulation: null }>("/api/auth/me/emulation", { method: "DELETE" }),
  deleteMarking: (id: string) => req<{ deleted: string }>(`/api/auth/markings/${id}`, { method: "DELETE" }),
  itemMarkings: (itemId: string) => req<ItemMarkings>(`/api/auth/items/${itemId}/markings`),
  setItemMarkings: (itemId: string, markings: string[]) => req<ItemMarkings>(`/api/auth/items/${itemId}/markings`, { method: "PUT", json: { markings } }),
  access: (itemId: string, userId?: string) =>
    req<{ can_access: boolean; required: string[]; lacking: string[]; operations?: string[]; role?: string | null }>(`/api/auth/access?item_id=${itemId}${userId ? `&user_id=${userId}` : ""}`),
  audit: (q: { user_id?: string; event?: string; limit?: number } = {}) =>
    req<AuditEntry[]>(`/api/auth/audit?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== "") as [string, string][]).toString()}`),
};

export const AUDIT_LABEL: Record<string, string> = {
  setup: "Platform set up",
  sign_in: "Signed in",
  sign_in_failed: "Sign-in failed",
  sign_out: "Signed out",
  password_changed: "Password changed",
  session_revoked: "Session revoked",
  token_created: "API token created",
  user_created: "User created",
  user_updated: "User updated",
  user_deactivated: "User deactivated",
  user_reactivated: "User reactivated",
  user_deleted: "User deleted",
  signed_out_everywhere: "Signed out everywhere",
  group_created: "Group created",
  group_updated: "Group updated",
  group_deleted: "Group deleted",
  organization_created: "Organization created",
  organization_deleted: "Organization deleted",
  markings_changed: "Markings changed",
  password_expired: "Password expired",
  password_reset_requested: "Password reset requested",
  password_reset: "Password reset",
  user_invited: "User invited",
  invitation_accepted: "Invitation accepted",
  mfa_enabled: "Two-factor turned on",
  mfa_disabled: "Two-factor turned off",
  mfa_reset: "Two-factor reset",
  mfa_recovery_used: "Recovery code used",
  mfa_recovery_codes: "New recovery codes",
  settings_changed: "Security settings changed",
  project_roles_changed: "Project roles changed",
};

/** The policy as a sentence for password fields. */
export function policyHint(p: PasswordPolicy | undefined): string {
  if (!p) return "";
  const need = [`at least ${p.password_min_length} characters`];
  if (p.password_require_upper) need.push("an upper-case letter");
  if (p.password_require_lower) need.push("a lower-case letter");
  if (p.password_require_digit) need.push("a digit");
  if (p.password_require_symbol) need.push("a symbol");
  const not = [];
  if (p.password_block_common) not.push("a common password");
  if (p.password_history) not.push(`one of your last ${p.password_history}`);
  return `${need.join(", ")}${not.length ? `; not ${not.join(" or ")}` : ""}.`;
}

/** Client-side check of the simple rules (the server checks all of them). */
export function policyProblems(pw: string, p: PasswordPolicy | undefined): string[] {
  if (!p || !pw) return [];
  const out = [];
  if (pw.length < p.password_min_length) out.push(`${p.password_min_length - pw.length} more character${p.password_min_length - pw.length === 1 ? "" : "s"}`);
  if (p.password_require_upper && !/[A-Z]/.test(pw)) out.push("an upper-case letter");
  if (p.password_require_lower && !/[a-z]/.test(pw)) out.push("a lower-case letter");
  if (p.password_require_digit && !/\d/.test(pw)) out.push("a digit");
  if (p.password_require_symbol && !/[^A-Za-z0-9]/.test(pw)) out.push("a symbol");
  return out;
}
