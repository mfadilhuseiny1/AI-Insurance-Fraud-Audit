"use client";

// System Architecture · rule engine client: the contract in docs/RULE_ENGINE_KONTRAK.md (API 8300, prefix
// /api/aip/realtime/v1, api/aip/realtime/aturan_kustom.py). Field names as the realtime API writes them. A status code travels
// with every error, so the page can tell "the rule engine API is not live yet" (404) from a refused action (403, 409, 422).

import { API_URL } from "@/lib/api";

export type Status = "draf" | "diuji" | "menunggu" | "aktif" | "ditolak" | "nonaktif";

export type Katalog = {
  fields: { nama: string; jenis: "angka" | "teks" | "bool" | "tanggal" | string; sumber: "klaim" | "turunan" | "peserta" | "fitur" | string; deskripsi: string }[];
  fungsi: { nama: string; argumen?: string | string[] | null; deskripsi: string }[];
  modus: { kode: string; nama: string }[];
  contoh: string[];
  batas?: { bobot_min?: number; bobot_maks?: number; panjang?: number };
};

export type Uji = {
  versi?: number; waktu?: string; data?: string; klaim: number; normal: number; fraud: number;
  kena: { normal: number; fraud: number }; laju_normal: number; recall: number; precision: number | null;
  per_skema?: { skema: string; label?: string; n: number; kena: number }[];
  unik?: { fraud_baru_vs_rule?: number; fraud_baru_vs_keputusan?: number };
  beban_per_hari?: number; contoh_kode?: string[]; detik?: number;
};

export type Riwayat = { versi: number; status: Status | string; oleh?: string; waktu?: string; catatan?: string | null };

export type Aturan = {
  id: string; kode: string; label: string; deskripsi?: string; kondisi: string; modus: string[]; bobot: number; status: Status; versi: number;
  menggantikan?: string | null; dibuat_oleh?: string; dibuat?: string; diubah_oleh?: string; diubah?: string; uji?: Uji | null; riwayat?: Riwayat[];
  /** the approved version the engine runs (null: none), while a newer draft may be in progress */
  versi_aktif?: number | null; berjalan?: boolean;
};

/** a pending change to a built-in rule (the contract leaves its shape open: what is read here is optional) */
export type Perubahan = {
  kode?: string; aktif?: boolean | null; bobot?: number | null; status?: Status | string; versi?: number; catatan?: string | null;
  oleh?: string; dibuat_oleh?: string; dibuat?: string; waktu?: string; uji?: Uji | null; sebelum?: { aktif?: boolean; bobot?: number } | null;
};

export type Bawaan = {
  kode: string; label: string; modus: string[]; tag?: string; bobot_default: number; bobot: number; aktif: boolean; deskripsi?: string;
  perubahan_menunggu?: Perubahan | null;
  /** one of the 45 signals ML v7 reads as features (aktif.CODES, frozen) */
  masuk_model?: boolean; digantikan_oleh?: string[];
};

export type Daftar = { bawaan: Bawaan[]; kustom: Aturan[]; ringkas?: { aktif?: number; menunggu?: number; draf?: number } };

export type Validasi = { ok: boolean; error: string | null; field?: string[]; fungsi?: string[] };

export type Draf = {
  kode: string; label: string; deskripsi?: string; kondisi: string; modus: string[]; bobot: number; menggantikan?: string | null;
  aksi?: "aturan_baru" | "ubah_parameter"; parameter?: { aktif?: boolean; bobot?: number } | null;
  penjelasan?: string; field_dipakai?: string[]; peringatan?: string[]; valid?: boolean; error?: string | null; biaya_usd?: number | null;
  // an AI edit (POST /aturan/ai/edit) also says what it changed
  sebelum?: { kondisi?: string; bobot?: number; aktif?: boolean } | null; perubahan?: string | null;
};

export type AturanIn = { kode: string; label: string; deskripsi: string; kondisi: string; modus: string[]; bobot: number; menggantikan?: string | null };

export type LogBaris = { waktu?: string; oleh?: string; aksi?: string; id?: string; kode?: string; versi?: number; catatan?: string | null };

export class RuleApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const BASE = "/api/aip/realtime/v1";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${BASE}${path}`, { cache: "no-store", ...init });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const d = (body as { detail?: unknown }).detail;
    const msg = typeof d === "string" ? d : d ? JSON.stringify(d).slice(0, 400) : `${r.status} ${r.statusText}`;
    throw new RuleApiError(msg, r.status);
  }
  return r.json() as Promise<T>;
}
const kirim = <T,>(path: string, body?: unknown, method = "POST") =>
  req<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
const e = encodeURIComponent;

export const aturanApi = {
  katalog: () => req<Katalog>("/aturan/katalog"),
  daftar: () => req<Daftar>("/aturan"),
  log: () => req<LogBaris[] | { log?: LogBaris[] }>("/aturan/log").then((x) => (Array.isArray(x) ? x : x.log ?? [])),
  validasi: (kondisi: string) => kirim<Validasi>("/aturan/validasi", { kondisi }),
  aiDraf: (teks: string) => kirim<Draf>("/aturan/ai/draf", { teks }),
  aiEdit: (sasaran: { id: string } | { kode_bawaan: string }, teks: string) => kirim<Draf>("/aturan/ai/edit", { ...sasaran, teks }),
  aiPerbaiki: (id: string) => kirim<Draf>("/aturan/ai/perbaiki", { id }),
  buat: (body: AturanIn) => kirim<Aturan>("/aturan", body),
  ubah: (id: string, body: AturanIn) => kirim<Aturan>(`/aturan/${e(id)}`, body, "PUT"),
  uji: (id: string) => kirim<Uji>(`/aturan/${e(id)}/uji`),
  ajukan: (id: string, catatan?: string) => kirim<Aturan>(`/aturan/${e(id)}/ajukan`, catatan ? { catatan } : {}),
  setujui: (id: string, catatan?: string) => kirim<Aturan>(`/aturan/${e(id)}/setujui`, catatan ? { catatan } : {}),
  tolak: (id: string, catatan: string) => kirim<Aturan>(`/aturan/${e(id)}/tolak`, { catatan }),
  nonaktifkan: (id: string) => kirim<Aturan>(`/aturan/${e(id)}/nonaktifkan`),
  rollback: (id: string, versi: number) => kirim<Aturan>(`/aturan/${e(id)}/rollback`, { versi }),
  // archived + logged by the API; a running rule only by an admin (403 otherwise)
  hapus: (id: string) => req<{ id: string; kode: string; dihapus: boolean; berjalan_sebelumnya: boolean }>(`/aturan/${e(id)}`, { method: "DELETE" }),
  // a built-in rule: a pending change (on/off, weight) through the same draft → test → approve flow
  bawaanUbah: (kode: string, body: { aktif?: boolean; bobot?: number; catatan?: string }) => kirim<Perubahan>(`/aturan/bawaan/${e(kode)}`, body),
  bawaanUji: (kode: string) => kirim<Uji>(`/aturan/bawaan/${e(kode)}/uji`),
  bawaanAjukan: (kode: string, catatan?: string) => kirim<Perubahan>(`/aturan/bawaan/${e(kode)}/ajukan`, catatan ? { catatan } : {}),
  bawaanSetujui: (kode: string, catatan?: string) => kirim<Perubahan>(`/aturan/bawaan/${e(kode)}/setujui`, catatan ? { catatan } : {}),
  bawaanTolak: (kode: string, catatan: string) => kirim<Perubahan>(`/aturan/bawaan/${e(kode)}/tolak`, { catatan }),
};

/** the message a failed action shows */
export const pesan = (x: unknown) => {
  const er = x as RuleApiError;
  if (er?.status === 404) return "Endpoint ini belum ada di API rule engine (menunggu restart API).";
  if (er?.status === 403) return `Ditolak: ${er.message || "butuh admin"}`;
  return er?.message || "Gagal";
};
