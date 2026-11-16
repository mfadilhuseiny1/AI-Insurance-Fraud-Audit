/** Cipher (api/cipher.py): channels, licenses and operations on values. */
import { API_URL } from "./api";
import { qs, sg } from "./securityGov";

export type CipherAlgorithm = "AES_GCM_SIV" | "AES_SIV" | "SHA256" | "SHA512" | "VISUAL";
export type CipherChannel = {
  id: string;
  rid: string;
  name: string;
  description: string;
  algorithm: CipherAlgorithm;
  key_mode: "derived" | "single" | "pepper" | "seed";
  item_id: string | null;
  created_by: string;
  created_at: string;
  licenses?: number | CipherLicense[];
  can_manage?: boolean;
};
export type CipherLicense = {
  id: string;
  rid: string;
  name: string;
  description?: string;
  kind: "operational" | "data_manager" | "admin" | "legacy";
  channel_id?: string;
  channel?: { rid: string; name: string; algorithm: CipherAlgorithm } | null;
  operations: ("encrypt" | "decrypt")[];
  rate_limit?: { count: number; minutes: number } | null;
  bypass_checkpoints?: boolean;
  expires_at?: string | null;
  item_id?: string | null;
  created_at: string;
  created_by: string;
};
export const ALGORITHM_LABEL: Record<CipherAlgorithm, string> = {
  AES_SIV: "AES-256-SIV — deterministic encryption (joins and group-bys work)",
  AES_GCM_SIV: "AES-GCM-SIV — probabilistic encryption",
  SHA256: "SHA-256 hashing (with a pepper)",
  SHA512: "SHA-512 hashing (with a pepper)",
  VISUAL: "Visual obfuscation — image scrambling",
};
export const KIND_LABEL: Record<CipherLicense["kind"], string> = {
  operational: "Operational User", data_manager: "Data Manager", admin: "Admin", legacy: "Media (legacy)",
};

/** Cipher-encrypted values: CIPHER::<channel rid>::<value>::CIPHER */
export const CIPHER_VALUE = /^CIPHER::(ri\.bellaso\.main\.cipher-channel\.[A-Za-z0-9-]+)::[A-Za-z0-9_\-=]+::CIPHER$/;

export const cipherApi = {
  channels: () => sg<CipherChannel[]>("/api/cipher/channels"),
  channel: (id: string) => sg<CipherChannel & { licenses: CipherLicense[] }>(`/api/cipher/channels/${encodeURIComponent(id)}`),
  createChannel: (body: { name: string; folder_id: string; algorithm: CipherAlgorithm; key_mode: "derived" | "single"; secret?: string; description?: string }) =>
    sg<CipherChannel>("/api/cipher/channels", { method: "POST", json: body }),
  issue: (channel: string, body: { name: string; kind: string; operations: string[]; rate_limit?: { count: number; minutes: number } | null; bypass_checkpoints?: boolean; expires_at?: string | null; description?: string }) =>
    sg<CipherLicense>(`/api/cipher/channels/${encodeURIComponent(channel)}/licenses`, { method: "POST", json: body }),
  licenses: (q: { usable_for?: string; channel?: string; kind?: string } = {}) => sg<CipherLicense[]>(`/api/cipher/licenses${qs(q)}`),
  updateLicense: (id: string, body: { operations?: string[]; rate_limit?: { count: number; minutes: number } | null; bypass_checkpoints?: boolean; expires_at?: string | null; revoked?: boolean }) =>
    sg<CipherLicense>(`/api/cipher/licenses/${encodeURIComponent(id)}`, { method: "PATCH", json: body }),
  /** the original pixels of encrypted areas of a visually obfuscated image (an object URL of the PNG) */
  visualDecrypt: async (itemId: string, boxes: { x: number; y: number; w: number; h: number }[]) => {
    const res = await fetch(`${API_URL}/api/cipher/visual/decrypt`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: itemId, boxes }),
    });
    if (!res.ok) {
      let message = res.statusText;
      try {
        const b = await res.json();
        message = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
      } catch {}
      throw new Error(message);
    }
    return URL.createObjectURL(await res.blob());
  },
  packageChannel: (channel: string) => sg<Record<string, unknown>>(`/api/cipher/channels/${encodeURIComponent(channel)}/package`),
  installChannel: (pkg: Record<string, unknown>, folderId: string) => sg<unknown>("/api/cipher/install", { method: "POST", json: { package: pkg, folder_id: folderId } }),
  createPipeline: (license: string, body: { dataset_item_id: string; column: string; folder_id: string; name?: string }) =>
    sg<{ pipeline: { id: string; name: string } }>(`/api/cipher/licenses/${encodeURIComponent(license.split(".").pop() ?? license)}/create-pipeline`, { method: "POST", json: body }),
  inlineEdit: (body: { object_type_id: string; primary_key: string; property: string; value: string; license: string; context?: string }) =>
    sg<{ value: string }>("/api/cipher/inline-edit", { method: "POST", json: body }),
  operate: (license: string, operation: "encrypt" | "decrypt" | "hash", value: string | null, context = "") =>
    sg<{ value: string | null }>(`/api/cipher/licenses/${encodeURIComponent(license.split(".").pop() ?? license)}/operate`, { method: "POST", json: { operation, value, context } }),
};
