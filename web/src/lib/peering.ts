/** Peer Manager (api/peering.py). */
import { API_URL } from "./api";

export type Enrollment = { rid: string; title: string; api_url: string; display: string };
export type Network = {
  id: string;
  name: string;
  remote_rid: string;
  remote_title: string;
  remote_url: string;
  remote_direction: "bidirectional" | "egress" | "ingress";
  local_direction?: string;
  complete: boolean;
  can_initiate: boolean;
  /** this side pulls from the remote (the remote cannot call this enrollment) */
  pulls: boolean;
  /** a data relay connection: no MPX invite on either side, control messages and payloads travel through the channels */
  relay_only: boolean;
  /** export / import File channels with the Peering integration to this remote */
  relay: { export: boolean; import: boolean };
  last_ok_at?: string;
  last_error?: string | null;
  created_at: string;
};
export type Channel = {
  id: string;
  name: string;
  description: string;
  remote_rid: string;
  direction: "export" | "import";
  connection_type: string;
  directory: string;
  integrations: string[];
  has_secret: boolean;
  /** relay sequence state: export — last sequence written, last acknowledged by the remote, files awaiting an
   * acknowledgement, sequences the remote reports missing; import — last applied, the missing sequence later files wait
   * for, files held, duplicates dropped */
  relay_state?: {
    sent_seq?: number;
    acked_seq?: number | null;
    acked_at?: string | null;
    unacked?: number;
    missing?: number[];
    applied_seq?: number;
    waiting_for?: number | null;
    held?: number;
    duplicates?: number;
    /** import: the last acknowledgement this side sent (cumulative sequence, when) */
    last_ack_seq?: number | null;
    last_ack_at?: string | null;
    /** export: how the remote's last acknowledgement came ("relay": its export channel, "network": the network connection) */
    acked_via?: "relay" | "network" | null;
    /** how acknowledgements travel for this channel (null: no way back — files count as delivered once written, nothing is resent) */
    ack_path?: "relay" | "network" | null;
    ack_warning?: string | null;
  };
  last_ok_at?: string;
  last_error?: string | null;
  created_at: string;
};
export type OntologyEntity = { object_type_id?: string; id?: string; api_name: string; display_name: string; primary_key: string; imports_blocked?: boolean; properties: { api_name: string; display_name: string; type: string }[] };
export type Mapping = {
  id: string;
  local_type_id: string;
  remote_type_id: string;
  properties: Record<string, string>;
  source_export: boolean;
  source_import: boolean;
  actions_export: boolean;
  actions_import: boolean;
  acked: string | null;
};
export type PeerConnection = {
  id: string;
  network_id: string;
  remote_rid: string;
  project_id: string;
  project_name: string;
  remote_project?: string;
  role: "originator" | "acceptor";
  status: "requested" | "approved" | "active";
  local_enabled: boolean;
  remote_enabled: boolean;
  data_types: { objects: { export: boolean; import: boolean }; files: { export: boolean; import: boolean } };
  security: string[];
  security_names: string[];
  security_requests: { id: string; markings: string[]; from: "local" | "remote"; at: string; state: "pending" | "approved" | "rejected" }[];
  ontology: {
    local: OntologyEntity[];
    remote: OntologyEntity[];
    mappings: Mapping[];
    local_links?: PeerLinkType[];
    remote_links?: PeerLinkType[];
    link_mappings?: { id: string; local_link_type_id: string; remote_link_type_id: string; export: boolean; import: boolean; received?: string[][] }[];
  };
  /** local marking → the remote enrollment's marking */
  marking_map?: { local: string; local_name: string; remote: string; remote_name: string }[];
  network: Network | null;
  health: string;
  jobs_count: number;
  last_error?: string;
  created_at: string;
  profile_id?: string;
};
export type PeerLinkType = { link_type_id: string; display_name: string; source_type_id: string; target_type_id: string };
export type PeerJob = {
  id: string;
  connection_id: string;
  direction: "export" | "import";
  payload: "data" | "ack";
  sequencing: "concurrent" | "sequential";
  producer: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  objects: number;
  error: string | null;
  error_instance_id?: string;
  /** relay Ack jobs: the cumulative sequence acknowledged, the sequences newly acknowledged and those reported missing
   * (as ranges, "#1–#4, #7"), and how the acknowledgement travelled */
  acked_seq?: number;
  acknowledged?: string;
  missing?: string;
  via?: "relay" | "network";
  /** import: objects received as this side already held them (not written, so not relayed on) */
  unchanged?: number;
  /** export: objects not sent back because they are as last received from this remote (no echo loop) */
  echo_skipped?: number;
  /** export: objects received without an origin version whose fingerprint had to be compared (echo check) */
  echo_fingerprinted?: number;
  /** import: edits / deletions not applied because this side holds a newer origin version of the object */
  stale_skipped?: number;
  /** export: deletions an earlier export could not deliver (remote offline, connection disabled), sent again */
  owed_deletions?: number;
};
export type Profile = {
  id: string;
  pair: string;
  side: "hub" | "spoke";
  name: string;
  project_id: string;
  auto_create: boolean;
  security: string[];
  objects_direction: "export" | "import" | "both";
  object_types: { object_type_id: string; direction: string }[];
  state: "draft" | "installed";
  installed?: { project_id: string; remote_strategy: string; remote_rid?: string; at: string; results: { network: string; status: string; connection_id?: string; error?: string; code?: string }[] } | null;
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/peering" + path, {
    cache: "no-store",
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

export const peering = {
  enrollment: () => req<Enrollment>("/enrollment"),
  setEnrollment: (title: string, api_url?: string) => req<Enrollment>("/enrollment", { method: "PUT", json: { title, api_url } }),
  networks: () => req<Network[]>("/networks"),
  invite: (direction: Network["remote_direction"]) => req<{ code: string; direction: string }>("/networks/invite", { method: "POST", json: { direction } }),
  enterInvite: (code: string, name: string) => req<Network & { check: { ok: boolean; error?: string } }>("/networks", { method: "POST", json: { code, name } }),
  checkNetwork: (id: string) => req<{ ok: boolean; error?: string | null; relay?: boolean }>(`/networks/${id}/check`, { method: "POST" }),
  deleteNetwork: (id: string) => req<{ deleted: string }>(`/networks/${id}`, { method: "DELETE" }),
  channels: () => req<Channel[]>("/channels"),
  createChannel: (body: { name: string; description: string; remote_rid: string; secret: string; direction: "export" | "import"; connection_type: string; directory: string; integrations: string[] }) =>
    req<Channel & { warning?: string }>("/channels", { method: "POST", json: body }),
  deleteChannel: (id: string) => req<{ deleted: string }>(`/channels/${id}`, { method: "DELETE" }),
  connections: () => req<PeerConnection[]>("/connections"),
  connection: (id: string) => req<PeerConnection>(`/connections/${id}`),
  request: (body: { network_id: string; project_id: string; export_objects: boolean; import_objects: boolean; security: string[] }) =>
    req<{ connection: PeerConnection; code: string }>("/connections/request", { method: "POST", json: body }),
  inspect: (code: string) =>
    req<{ from: string; from_rid: string; remote_project: string; objects: { export: boolean; import: boolean }; security: string[]; network: Network | null }>("/connections/inspect", {
      method: "POST",
      json: { code },
    }),
  approve: (code: string, project_id: string, security?: string[]) => req<PeerConnection>("/connections/import", { method: "POST", json: { code, project_id, security } }),
  activate: (id: string) => req<PeerConnection>(`/connections/${id}/activate`, { method: "POST" }),
  setStatus: (id: string, enabled: boolean) => req<PeerConnection>(`/connections/${id}/status`, { method: "POST", json: { enabled } }),
  requestSecurity: (id: string, markings: string[]) => req<PeerConnection>(`/connections/${id}/security`, { method: "POST", json: { markings } }),
  approveSecurity: (id: string, request_id: string, approve: boolean) => req<PeerConnection>(`/connections/${id}/security/approve`, { method: "POST", json: { request_id, approve } }),
  deleteConnection: (id: string) => req<{ deleted: string }>(`/connections/${id}`, { method: "DELETE" }),
  addEntities: (id: string, object_type_ids: string[], imports_blocked: boolean) =>
    req<PeerConnection>(`/connections/${id}/ontology/entities`, { method: "POST", json: { object_type_ids, imports_blocked } }),
  createMapping: (id: string, body: Omit<Mapping, "id" | "acked">) => req<PeerConnection>(`/connections/${id}/ontology/mappings`, { method: "POST", json: body }),
  deleteMapping: (id: string, mid: string) => req<PeerConnection>(`/connections/${id}/ontology/mappings/${mid}`, { method: "DELETE" }),
  objectTypes: () => req<(OntologyEntity & { id: string })[]>("/object-types"),
  linkTypes: () => req<PeerLinkType[]>("/link-types"),
  addLinkTypes: (id: string, link_type_ids: string[]) => req<PeerConnection>(`/connections/${id}/ontology/entities`, { method: "POST", json: { link_type_ids } }),
  createLinkMapping: (id: string, body: { local_link_type_id: string; remote_link_type_id: string; export: boolean; import_links: boolean }) =>
    req<PeerConnection>(`/connections/${id}/ontology/link-mappings`, { method: "POST", json: body }),
  remoteMarkings: (id: string) => req<{ id: string; name: string }[]>(`/connections/${id}/remote-markings`),
  setMarkingMap: (id: string, map: Record<string, string>) => req<PeerConnection>(`/connections/${id}/marking-map`, { method: "PUT", json: { map } }),
  jobs: (id: string, f: Record<string, string>) => req<PeerJob[]>(`/connections/${id}/jobs?${new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString()}`),
  sync: (id: string) => req<PeerJob[]>(`/connections/${id}/sync`, { method: "POST" }),
  pull: (id: string) => req<{ messages: number; payloads: number; applied: number; failed: number }>(`/connections/${id}/pull`, { method: "POST" }),
  runChannels: () => req<{ written: number; imported: number; resent?: number }>("/channels/run", { method: "POST" }),
  profiles: () => req<Profile[]>("/profiles"),
  createProfiles: (body: { hub_name: string; spoke_name: string; project_id: string; auto_create: boolean; security: string[]; objects_direction: string; object_types: { object_type_id: string; direction: string }[] }) =>
    req<Profile[]>("/profiles", { method: "POST", json: body }),
  install: (id: string, body: { project_id: string; remote_strategy: "all" | "specific"; remote_rid?: string }) => req<Profile>(`/profiles/${id}/install`, { method: "POST", json: body }),
  uninstall: (id: string) => req<Profile>(`/profiles/${id}/uninstall`, { method: "POST" }),
};

export const STATUS_LABEL: Record<string, string> = {
  collecting_data: "Collecting data",
  exporting: "Exporting",
  saving: "Saving",
  ready_to_download: "Ready to download",
  awaiting_pull: "Awaiting pull",
  empty: "Empty",
  failed: "Failed",
  succeeded: "Succeeded",
};
