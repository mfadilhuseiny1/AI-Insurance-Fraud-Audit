"use client";
import { API_URL } from "@/lib/api";

/* Client of /api/demo/jkn/mobile — the three JKN PWAs share it (demo data). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = Record<string, any>;
const BASE = "/api/demo/jkn/mobile";

async function req<T = Rec>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `${r.status} ${r.statusText}`);
  return r.json();
}
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const mobile = {
  peserta: (id: string) => req(`${BASE}/peserta/${id}`),
  pesertaList: () => req(`${BASE}/peserta`),
  lapor: (id: string, no_sep: string, jenis: string, alasan: string) => req(`${BASE}/peserta/${id}/lapor`, json({ no_sep, jenis, alasan })),
  faskes: (lat?: number, lon?: number) => req(`${BASE}/faskes${lat != null && lon != null ? `?lat=${lat}&lon=${lon}` : ""}`),
  rs: (id: string) => req(`${BASE}/rs/${id}`),
  rsList: () => req(`${BASE}/rs`),
  cek: (id: string, body: Rec) => req(`${BASE}/rs/${id}/cek`, json(body)),
  unggah: (id: string, no_sep: string, jenis: string, file: File, catatan = "") => {
    const f = new FormData(); f.append("no_sep", no_sep); f.append("jenis", jenis); f.append("catatan", catatan); f.append("file", file);
    return req(`${BASE}/rs/${id}/berkas`, { method: "POST", body: f });
  },
  petugas: () => req(`${BASE}/petugas`),
  keputusan: (body: Rec) => req(`${BASE}/petugas/keputusan`, json(body)),
  dibaca: (id: string) => req(`${BASE}/petugas/berkas/${id}/dibaca`, { method: "POST" }),
  kunjungan: (f: FormData) => req(`${BASE}/petugas/kunjungan`, { method: "POST", body: f }),
  ask: (q: string) => req("/api/orbis/ask", json({ q })),
};
export const fileUrl = (id: string) => `${API_URL}${BASE}/berkas/${id}`;

export const rp = (n?: number) => n == null ? "—" : `Rp ${Math.round(n).toLocaleString("id-ID")}`;
export const rpShort = (n?: number) => n == null ? "—" : n >= 1e9 ? `Rp ${(n / 1e9).toLocaleString("id-ID", { maximumFractionDigits: 1 })} M` : n >= 1e6 ? `Rp ${(n / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 })} jt` : rp(n);
export const tgl = (s?: string) => s ? new Date(s.length === 10 ? `${s}T00:00:00` : s.replace(" ", "T")).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }) : "—";
