/* Tipe data Fraud Intelligence — satu kontrak dengan api/demo_jkn_fraud.py. */
export type AnyRec = Record<string, any>;
export type Pagination = { total: number; limit: number; offset: number };
export type TabId = "ringkasan" | "kasus" | "graf" | "billing" | "skor" | "prepay" | "aturan" | "ops";

export const rp = (v: number) => `Rp${Math.round(v || 0).toLocaleString("id-ID")}`;
export const PAGE_SIZE = 8;

export const TIER_TONE: Record<string, string> = {
  Kritis: "#f0616d", Tinggi: "#f0a843", Sedang: "#e2b866", Rendah: "#34c38f",
  P1: "#f0616d", P2: "#f0a843", P3: "#e2b866",
  hold: "#f0616d", review: "#f0a843", otomatis: "#34c38f",
  HOLD: "#f0616d", REVIEW: "#f0a843", AUTO_APPROVE: "#34c38f",
};
