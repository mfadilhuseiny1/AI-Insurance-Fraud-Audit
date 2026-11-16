/** The platform's MQTT broker (api/mqtt_broker.py): Eclipse Mosquitto, internal to the platform's machine. */
import { API_URL } from "./api";

export type TopicAccess = "read" | "write" | "readwrite";
export type BrokerLogin = {
  id: string;
  username: string;
  label?: string;
  /** "user": made on the MQTT Broker page; "nodered": a Node-RED workspace's own login */
  kind: "user" | "nodered";
  workspace?: string;
  topics: { pattern: string; access: TopicAccess }[];
  owner?: string | null;
  owner_name?: string | null;
  created_at: string;
};
export type LiveTopic = { topic: string; count: number; bytes: number; last_at: string; last: string; retained: boolean };
export type BrokerStatus = {
  status: "running" | "stopped";
  enabled: boolean;
  image: string;
  started_at?: string | null;
  ports: { mqtt: number; ws: number } | null;
  addresses: { node_red: string; this_machine: string | null; websocket: string | null };
  stats: Record<string, string | null>;
  /** plain numbers: devices and tools connected (not the platform's monitor), their messages in the last minute */
  summary: { clients?: number | null; messages_last_minute?: number; topics?: number; uptime_seconds?: number | null };
  topics: LiveTopic[];
  credentials: BrokerLogin[];
  can_manage: boolean;
  can_create: boolean;
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`${API_URL}/api/mqtt-broker${path}`, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const d = (await res.json()).detail;
      message = typeof d === "string" ? d : JSON.stringify(d);
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

export const mqttBroker = {
  status: () => req<BrokerStatus>(""),
  start: () => req<BrokerStatus>("/start", { method: "POST" }),
  stop: () => req<BrokerStatus>("/stop", { method: "POST" }),
  createLogin: (body: { username: string; label: string; topics: { pattern: string; access: TopicAccess }[] }) =>
    req<BrokerLogin & { password: string }>("/credentials", { method: "POST", json: body }),
  deleteLogin: (id: string) => req<{ deleted: string }>(`/credentials/${id}`, { method: "DELETE" }),
  publish: (body: { topic: string; payload: string; retain: boolean }) => req<{ published: boolean }>("/publish", { method: "POST", json: body }),
};
