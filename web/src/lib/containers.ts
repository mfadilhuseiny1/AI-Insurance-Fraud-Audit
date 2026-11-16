/** Containers (api/container_registry.py, api/container_runtime.py): Docker Artifacts repositories, the registry at
 *  /v2, image requirement checks and the container runtime sidecar transforms run on. */
import { API_URL } from "./api";

export type RequirementCheck = { id: "user" | "platform" | "tag" | "layers" | "ports" | "telemetry"; label: string; status: "pass" | "fail" | "warn" | "pending"; detail: string };
export type ImageTag = {
  tag: string;
  digest: string;
  pushed_at: string;
  pushed_by: string;
  size_total: number;
  platform: string;
  user: string;
  ports: number[];
  layers: { digest: string; size: number }[];
  media_type: string;
  checks: RequirementCheck[];
};
export type ArtifactsRepo = {
  id: string;
  name: string;
  slug: string;
  type: "docker";
  description: string;
  item_id: string;
  path: string;
  created_at: string;
  created_by: string;
  images: number;
  tags: number;
  size: number;
};
export type ArtifactsRepoDetail = ArtifactsRepo & {
  images_detail: { name: string; tags: ImageTag[]; untagged: { digest: string; pushed_at: string; size_total: number }[] }[];
  can_push: boolean;
};
export type RuntimeInfo = {
  kind: "native" | "wsl" | "off";
  distro?: string;
  version?: string;
  error?: string;
  sidecars?: { Names: string; Image: string; Status: string; RunningFor: string; Labels: string }[];
  relay: { running: boolean; port: number; address: string | null; needed: boolean; error?: string };
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/containers" + path, {
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

export const containers = {
  repositories: () => req<ArtifactsRepo[]>("/repositories"),
  repository: (id: string) => req<ArtifactsRepoDetail>(`/repositories/${id}`),
  byItem: (itemId: string) => req<ArtifactsRepoDetail>(`/repositories/by-item/${itemId}`),
  create: (body: { name: string; folder_id: string; description?: string }) => req<ArtifactsRepoDetail>("/repositories", { method: "POST", json: body }),
  deleteTag: (id: string, image: string, tag: string) => req<{ deleted: string }>(`/repositories/${id}/images/${image}/tags/${encodeURIComponent(tag)}`, { method: "DELETE" }),
  upload: (id: string, file: File, image?: string, tag?: string) => {
    const fd = new FormData();
    fd.append("file", file);
    if (image) fd.append("image", image);
    if (tag) fd.append("tag", tag);
    return req<{ stored: { image: string; tag: string; digest: string }[]; repository: ArtifactsRepoDetail }>(`/repositories/${id}/images/upload`, { method: "POST", body: fd });
  },
  runtime: () => req<RuntimeInfo>("/runtime"),
  startRelay: () => req<RuntimeInfo["relay"]>("/runtime/relay", { method: "POST" }),
};

/** The registry host docker talks to: the relay inside WSL, else this API's host. */
export function registryHost(rt: RuntimeInfo | null): string {
  if (rt?.kind === "wsl") return rt.relay.address ?? `127.0.0.1:${rt.relay.port}`;
  try {
    return new URL(API_URL || (typeof window !== "undefined" ? window.location.origin : "http://localhost:8000")).host;
  } catch {
    return "localhost:8000";
  }
}

export const SIDECAR_PROFILES: [string, number, string, string, string][] = [
  ["SMALL_CPU_SMALL_MEMORY", 1, "3GB", "None", "None"],
  ["MEDIUM_CPU_MEDIUM_MEMORY", 2, "6GB", "None", "None"],
  ["MEDIUM_CPU_MEDIUM_MEMORY_SMALL_SHARED_MEMORY", 2, "6GB", "None", "2GB"],
  ["LARGE_CPU_LARGE_MEMORY", 4, "13GB", "None", "None"],
  ["LARGE_CPU_LARGE_MEMORY_GPU_ENABLED", 4, "13GB", "1x NVIDIA", "None"],
  ["X_LARGE_CPU_X_LARGE_MEMORY", 8, "27GB", "None", "None"],
  ["X_LARGE_CPU_X_LARGE_MEMORY_GPU_ENABLED", 8, "27GB", "1x NVIDIA", "None"],
  ["XX_LARGE_CPU_XX_LARGE_MEMORY", 16, "54GB", "None", "None"],
];

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
