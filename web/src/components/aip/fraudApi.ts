"use client";
import { API_URL } from "@/lib/api";
import type { AipEvent, Rec, Run } from "@/components/aip/aipRun";

/* The fraud system of AIP JKN: the consultancy (api/aip/konsultan.py, adk_runtime/firm.py), the tag ledger and the
   semantic layer (indikasi.py, semantik.py), the quarantine box (karantina.py), the clinical review (medis.py), the
   production pipeline (produksi.py) and the online inference service with POST /verify (layanan.py). */

async function req<T = Rec>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const d = body.detail;
    throw new Error(typeof d === "string" ? d : d ? JSON.stringify(d).slice(0, 400) : `${r.status} ${r.statusText}`);
  }
  return r.json();
}
const post = <T = Rec>(path: string, body: unknown) =>
  req<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export type FirmAgent = {
  key: string; name: string; peran: string; lini: string; jenjang: "partner" | "manajer" | "analis" | "validator" | "peran"; induk: string | null; model: string;
  peran_kode: string; target?: Rec | null; instans_dari?: string;
};
export type Sizing = { lini: string; agen: number; alasan: string };
export type Team = { tim: FirmAgent[]; mesin: { key: string; name: string; peran: string }[]; jumlah_agen: number; keluarga_model: Record<string, number>; brief: string;
  ukuran: Sizing[]; lini: Record<string, number> };
// a project's IT settings (api/aip/konsultan.py SOURCES, SEATS, PARALEL): the data the firm reads, each seat's model
export type SourceRow = { tipe: string; wajib: boolean; dipakai: string; ada: boolean; objek: number; dataset?: string | null; diperbarui?: string | null };
export type Sources = { sumber: string; tipe: SourceRow[]; siap: boolean; kurang: string[]; pendukung_kurang: string[] };
export type Seat = { kursi: string; label: string; dipakai: string; default: string };
export type ModelOpt = { id: string; label: string; vendor: string; keluarga: string; siap: boolean; alasan?: string | null; harga: { input: number; output: number } };
export type FirmConfig = { sumber: Sources; kursi: Seat[]; model: ModelOpt[]; paralel: { min: number; default: number; maks: number };
  batas_usd: { min: number; maks: number }; brief: string; versi?: Record<string, OrchestrationVersion> };
/** The AI orchestration an engagement runs (api/aip/konsultan.py VERSIONS): Blu 1.0, Blu 1.1 with the clinical review first, or
 *  Blu 1.3 with OpenAI Decisions' examination first. */
export type OrchestrationVersion = { nama: string; ringkas: string; tambahan: string | null };
/** The orchestrations with a clinical examination before the agents (api/aip/telaah.py REVIEWED). */
export const REVIEWED = ["1.1", "1.3"];
/** Each orchestration's badge before an engagement's name: its title and its colours. */
export const VERSI_BADGE: Record<string, [string, string]> = {
  "1.0": ["Blu 1.0: AI Agent Swarm", "bg-white/10 text-[#abb3bf]"],
  "1.1": ["Blu 1.1: telaah klinis setiap klaim berisiko sebelum agen bekerja", "bg-[#9d8cff]/20 text-[#c9c0ff]"],
  "1.3": ["Blu 1.3: OpenAI Decisions menilai setiap klaim berisiko sebelum agen bekerja; agen memeriksa yang teratas", "bg-[#c084fc]/20 text-[#e9d5ff]"],
  "3.0": ["Blu 3.0: AI Agent Swarm di atas model fraud v3 (scoring v3 setiap klaim, lima agen kelompok modus Permenkes)", "bg-[#199e70]/20 text-[#7ee2c0]"],
};
/** Blu 3.0's data profile and v3 scoring summary (api/aip/konsultan.py GET /v3). */
export type V3Status = { profil: { aktif: string; paket: boolean }; ringkasan: { klaim: number; ditandai: number; berisiko: number; faskes: number;
  famili: { famili: string; nama: string; klaim: number; faskes: number }[]; periode: string[] } | null };
/** Blu 1.1's clinical review before it runs (api/aip/telaah.py GET /ringkasan): the set, what is kept, the last calibration. */
export type ReviewSummary = {
  klaim: number; sumber: Record<string, number>; model: { saring: string; periksa: string }; versi_prompt: string; batch: number;
  tersimpan: { saring: number; periksa: number; kesimpulan_saring: Record<string, number>; mencurigakan_keduanya: number };
  kalibrasi: ReviewCalibration | null; kalibrasi_berlaku: boolean; batas_usd: number;
  estimasi: { klaim: number; sisa_saring: number; sisa_periksa_perkiraan: number; porsi_mencurigakan_dipakai: number; usd_saring: number; usd_periksa: number;
    usd_total: number };
  aturan: { sampel_kalibrasi: number; kappa_min: number; porsi_sah_min: number; audit_acak: number };
};
export type ReviewCalibration = { run_id: string; t: string; n: number; lolos: boolean; alasan: string[]; proyeksi_usd: number; terpakai_usd: number; batas_usd: number;
  model: { saring: string; periksa: string }; hasil: Rec };
export type Project = { id: string; nama: string; brief: string; fokus: string; batas_usd: number | null; paralel: number; model: Record<string, string>;
  dibuat_pada?: string; dibuat_oleh?: string; virtual?: boolean };
export type Exhibit = { id: string; nomor: number; bab: string; judul: string; ukuran: string; jenis: string; baris: Rec[]; fakta: string[]; sumber: string;
  satuan?: string; tanda?: { faskes: number; label: string }[]; model?: Rec;
  /** each measure as a leader reads it (the designed audit's exhibit): a plain name, its value, a sentence with the numbers */
  pimpinan?: { metrik: string; nilai: string; arti: string }[];
  /** the IoMT chapter's example claims (api/aip/laporan_iomt.py): billed against measured, and what the devices recorded */
  klaim?: IomtClaim[];
  /** a branch report's map (testing/laporan_cabang.py "wilayah-kc"): its kab/kota and the hospitals at SYNTHETIC coordinates */
  peta?: PetaKC;
  /** a table's own columns (the branch report's hospital table); without it the national Box columns. "tsm": the row's
   *  {terstruktur, sistematis, masif} levels; "jalur": the hospital's path (ditindak / dibina / dibebaskan) */
  kolom?: { key: string; label: string; jenis: "rs" | "kelompok" | "rp" | "teks" | "tsm" | "jalur" }[] };
/** kelompok: the hospital's Box Karantina group (A–D, Z), null = outside the box (no indication tag); jalur: its TSM path */
export type PetaKC = { kab: { kode: number; kabkota: string; klaim: number; rekomendasi: number; estimasi_kerugian_rp: number; rekomendasi_per_1000: number; rs: number }[];
  rs: { id: string; nama: string; kab: number; kabkota: string; lon: number; lat: number; klaim: number; rekomendasi: number; estimasi_kerugian_rp: number; kelompok: string | null;
    jalur?: string | null }[];
  keterangan: string; rata_per_1000: number };
export type IomtClaim = { id: string; faskes: string; jenis: string; dx: string; masuk: string; pulang: string; keparahan: string; tarif_rp: number; hasil: string;
  estimasi_rp: number; judul: string; ukuran: { label: string; satuan: string; ditagih: number; terukur: number; kode?: string; ambang?: number; berturut?: boolean; siaga?: boolean }[]; temuan: { hasil: string; judul: string }[];
  langkah: string; garis_waktu: { from: number; to: number; claimedFrom: number; claimedTo: number; series: { metric: string; label: string; note: string; cells: (number | null)[] }[] } | null };
export type FullReport = { basis?: string | null; beku_pada?: string | null; narasi_oleh?: string | null; run: string; status: string; mulai?: string; selesai?: string | null; biaya_usd?: number; agen: number; judul: string;
  /** a copy of another engagement's results (Blu 2.0 from Blu 1.0), and the IoMT chapter it carries (a synthetic world) */
  salinan_dari?: string | null; iomt?: { bab: string; pada: string; seed?: number | null } | null;
  bab: { id: string; judul: string; bagian: { id: string; judul: string; teks: string }[]; exhibit: string[] }[]; exhibit: Exhibit[];
  narasi?: Record<string, { makna?: string; implikasi?: string }> | null; narasi_model?: string | null; narasi_pada?: string | null; narasi_dibuang: number;
  narasi_status: "belum" | "menulis" | "ada" | "gagal"; narasi_galat?: string | null; berkas?: CaseFile[]; catatan_dpjp?: string };
// one audited facility's case file (laporan_konsultan.case_files): every figure computed by code, the evidence in the
// words of the rule or agent that tagged it
// a claim of a case file traced layer by layer to its raw transaction (api/aip/jejak_data.py)
export type ClaimTrace = { klaim: string; edisi: string; kunjungan: string; lapis: Rec[]; dibaca_pada: string; ml_versi?: string | null };
export type Evidence = { indikasi: string; kekuatan: string; oleh: string; teks: string };
export type CaseClaim = { kunjungan_id: string; edisi?: string; tgl_datang?: string | null; tgl_pulang?: string | null; bulan?: string | null; los_hari?: number | null;
  poli?: string | null; kelas_rawat?: string | null; inacbg_kode?: string | null; keparahan?: string | null; dx_primer?: string | null; peserta_id?: string | null;
  biaya_tagih_rp?: number | null; biaya_verifikasi_rp?: number | null; peer_biaya_p50_rp?: number | null; rasio_biaya_peer?: number | null;
  estimasi_kerugian_rp?: number | null; komponen?: string | null; indikasi: string[]; bukti: Evidence[]; di_skrining: boolean };
export type CaseFile = { faskes_profil_id: string; nama: string; provinsi: string; kabkota: string; kelompok: string; status?: string; profil: Rec;
  kerugian: { estimasi_rp: number; sudah_dikoreksi_rp: number; terpapar_rp: number; rincian: Record<string, number> };
  tsm: Record<string, string | null>; penyidik?: { jalur?: string; alasan?: string; agen?: string; model?: string; tsm?: Record<string, string>; pada?: string } | null;
  modus: { modus: string; kuat: number; sedang: number; lemah: number; total: number }[];
  poli: { poli: string; klaim_berisiko: number; klaim_bertag: number; biaya_tagih_rp: number; estimasi_kerugian_rp: number }[]; poli_tercatat: string;
  temuan_faskes: Evidence[]; peserta: { jumlah: number; klaim_berisiko: number; berulang: Rec[] }; klaim: CaseClaim[]; porsi_klaim_pct?: number | null;
  klaim_bertag?: number };
export type ProjectForm = { nama: string; brief: string; fokus: string; batas_usd: number | null; paralel: number; model: Record<string, string> };

export type Tag = {
  id: string; tag: string; tag_label: string; modus: string; permenkes: boolean; entitas: string; tipe: string; kunci: string; judul: string;
  konteks: Rec; kekuatan: "lemah" | "sedang" | "kuat"; tingkat: number; alasan_kekuatan: string; dukungan: number; agen_pendukung: string[];
  keluarga_model: string[]; otomatis: boolean; bukti: string; klasifikasi: "Internal" | "Rahasia"; marking: string[]; status: string;
  red_team?: { hasil: string; alasan: string; agen: string } | null; keputusan?: Rec | null; diperbarui_pada: string; sumber?: Rec[];
};
export type TagSummary = {
  total: number; kuat: number; sedang: number; lemah: number;
  per_tag: { tag: string; label: string; lemah: number; sedang: number; kuat: number; total: number }[];
  per_entitas: Record<string, number>; per_provinsi: { provinsi: string; tag: number }[];
  faskes_teratas: { faskes_profil_id: string; nama: string; provinsi: string; tag: number; bobot: number; kuat: number; jenis_tag: string[] }[];
  per_agen: { agen: string; tag: number }[]; markings?: Rec | null; nexus?: Rec | null; otomatis?: Rec | null; sinkron?: Rec;
};

export type Tsm = Record<"terstruktur" | "sistematis" | "masif", { nilai: "terpenuhi" | "sebagian" | "tidak"; poin: number; bukti: string }>;
export type BoxFacility = {
  faskes_profil_id: string; nama: string; provinsi?: string; kabkota?: string; tipe?: string; jenis?: string; kelompok: string;
  estimasi_kerugian_rp: number; sudah_dikoreksi_rp: number; nilai_terpapar_rp: number; rincian_kerugian?: Record<string, number>;
  klaim_kontributor?: { klaim_id: string; komponen: string; nilai_rp: number; dibayar_rp: number; peer_p50_rp: number; inacbg_kode?: string; los_hari?: number; tag: string[] }[];
  klaim_bertag: number; klaim_faskes: number; porsi_klaim_bertag: number; peserta_terdampak: number; bulan_aktif: number; kode_inacbg: number; jaringan: string[];
  modus: Record<string, number>; tag: number; kuat: number; sedang: number; lemah: number; keparahan: number; keparahan_label: string; tsm: Tsm;
  indikasi_tsm: boolean; jalur_awal: "dibina" | "ditindak"; status: string; rekomendasi: { agen: string; jalur: string; tsm: Rec; alasan: string; t: string; run_id: string }[];
  keputusan?: Rec | null; riwayat: Rec[]; klasifikasi: string; marking: string[]; indikasi?: Tag[];
};
export type Box = {
  ringkasan: Rec | null; jalur: Record<string, string>; kelompok_arti: Record<string, string>; total: number; per_status: Record<string, number>;
  kelompok: Record<string, { total: number; faskes: BoxFacility[] }>;
  // an engagement's box (?penugasan=): whole, or only its summary (engagements before 2026-10-28) with the facilities its investigators audited
  penugasan?: { run: string; lengkap: boolean; asal: string; pada: string | null };
  diaudit_penugasan?: (Pick<BoxFacility, "faskes_profil_id" | "nama" | "provinsi" | "kabkota" | "tipe" | "kelompok" | "estimasi_kerugian_rp" | "status" | "klasifikasi" | "tsm"> &
    { rekomendasi: BoxFacility["rekomendasi"] })[];
};
/** The boxes to choose from (GET /api/aip/karantina/penugasan): per AI Agent Swarm project, newest first, and the default. */
export type BoxChoices = {
  proyek: { id: string; nama: string; fokus: string; dibuat_pada: string | null;
    penugasan: { run: string; nama: string | null; status: string; mulai: string; selesai: string | null; box: "lengkap" | "ringkasan" | null;
      box_pada: string | null; faskes: number | null; kerugian_rp: number | null }[] }[];
  bawaan: { proyek: string; run: string } | null;
  aktif: { pada: string | null; run: string | null };
};

export type Review = {
  kesimpulan: "wajar" | "perlu_diperiksa" | "mencurigakan"; label: string; ringkasan: string; alasan_klinis: string[]; kejanggalan: string[];
  penjelasan_wajar: string[]; dokumen_diperiksa: string[]; keyakinan: string; model: string; lolos_gerbang_angka: boolean; angka_tidak_terverifikasi: string[];
  fallback?: boolean; alasan_fallback?: string; detik?: number; percobaan?: number;
};
export type Verify = {
  status: "INDIKASI_KUAT" | "PERLU_DIPERIKSA" | "WAJAR"; fraud_probability: number; ai_reasoning: string; status_label: string; arti_probabilitas: string;
  klaim_id: string; ml: Rec; indikasi: { tag: string; label: string; bukti: string }[]; analisis_medis: { telaah: Review; pendapat_kedua?: Review; sepakat?: boolean } | null;
  galat_llm: string | null; peringatan: string[]; pipeline: { tahap: string; keterangan: string; ms: number }[]; model: Rec; di_luar_prompt?: Rec;
};
/** One claim of a batch verification (POST /verify/csv or /verify/batch): its row, why the contract refused it or the
    pipeline failed, and its answer as a table row. */
export type BatchRow = {
  no: number; id: string; format: string | null; galat: string | null; ditolak: boolean; dicoba_ulang?: boolean;
  ringkas: { klaim_id: string; status: Verify["status"]; fraud_probability: number; ai_reasoning: string; kesimpulan_klinis?: string; keyakinan?: string;
    llm?: string; llm_fallback?: boolean; tag_aturan?: string; risiko_pct?: number; ditandai_model?: boolean; ms?: number } | null;
};
export type VerifyBatch = {
  id: string; status: "berjalan" | "selesai" | "gagal" | "dibatalkan" | "terhenti"; sumber: "csv" | "json"; berkas?: string; format: string; kolom: string[];
  kolom_tambahan: string[]; peringatan: string[]; jumlah: number; ditolak: number; selesai: number; per_status: Record<string, number>; llm_fallback: number;
  dicoba_ulang: number; pendapat_kedua: boolean; dibuat: string; selesai_pada?: string; detik?: number; error?: string; batal?: boolean;
  baris?: BatchRow[]; total_baris?: number; offset?: number;
};

export type Stage = { id: string; label: string; status: string; detik?: number; cek: { id: string; cek: string; nilai: unknown; ambang: string; status: string; blok: boolean }[] } & Rec;
export type ProdRun = { id: string; status: string; pemicu: string; mulai: string; selesai?: string; model_versi?: string; ringkasan?: Rec; error?: string | null; log?: string[];
  laporan?: { tahap: Stage[]; status: string; sumber?: string } | null };
export type Production = { deploy: Rec | null; signature: Record<string, Rec>; format: Record<string, string> | null; runs: ProdRun[]; jadwal: Rec;
  kontrak: { kolom: Record<string, string>; cek: { id: string; cek: string; ambang: string; blok: boolean }[] }; ambang: Rec };

// the Blu 1.1 simulation of a project, kept after its first load in this page (the server keeps it on disk too)
const simCache = new Map<string, Promise<{ run: Run; events: AipEvent[]; sumber: string; catatan: string }>>();

export const fraud = {
  // every rule and fact behind the indications, explained (api/aip/aturan.py)
  aturan: () => req<Rec>("/api/aip/aturan"),
  team: (versi?: string) => req<Team>(`/api/aip/konsultan/tim${versi ? `?versi=${encodeURIComponent(versi)}` : ""}`),
  v3Status: () => req<V3Status>("/api/aip/konsultan/v3"),
  // from the start form: its name and focus; in a project, the project's brief and IT settings (fokus null: the project's)
  startEngagement: (f: { nama: string; fokus: string | null; proyek: string | null; versi?: string }) =>
    post<{ run: string; jumlah_agen: number }>("/api/aip/konsultan", { nama: f.nama, fokus: f.fokus, proyek: f.proyek, versi: f.versi ?? "1.0" }),
  // Blu 1.1's / 1.3's clinical review (api/aip/telaah.py): its state for the start form, and a calibration-only run (300 claims);
  // Blu 1.3 names no models: its seats are fixed (OpenAI Decisions, DeepSeek's kept verdicts as the reference)
  reviewSummary: (m: { saring?: string; periksa?: string; versi?: string }, batas?: number | null) =>
    req<ReviewSummary>(`/api/aip/telaah/ringkasan?${new URLSearchParams({ ...(m.saring ? { saring: m.saring } : {}), ...(m.periksa ? { periksa: m.periksa } : {}),
      ...(m.versi ? { versi: m.versi } : {}), ...(batas ? { batas_usd: String(batas) } : {}) })}`),
  // a Blu 1.1 engagement as an animation only (api/aip/konsultan.py GET /simulasi): phase 1 projected from the calibration,
  // phases 2–8 the project's latest finished engagement as it ran; no model is called
  simulation: (proyek?: string | null) => {
    const k = proyek ?? "";
    let p = simCache.get(k);
    if (!p) {
      p = req<{ run: Run; events: AipEvent[]; sumber: string; catatan: string }>(`/api/aip/konsultan/simulasi${proyek ? `?proyek=${encodeURIComponent(proyek)}` : ""}`);
      simCache.set(k, p);
      p.catch(() => simCache.delete(k));
    }
    return p;
  },
  calibrate: (proyek: string | null, versi = "1.1") =>
    post<{ run: string; model: { saring: string; periksa: string }; n: number }>("/api/aip/telaah/kalibrasi", { proyek, versi }),
  config: () => req<FirmConfig>("/api/aip/konsultan/konfigurasi"),
  sources: () => req<Sources>("/api/aip/konsultan/sumber"),
  projects: () => req<Project[]>("/api/aip/konsultan/proyek"),
  createProject: (f: ProjectForm) => post<Project>("/api/aip/konsultan/proyek", f),
  updateProject: (id: string, f: ProjectForm) =>
    req<Project>(`/api/aip/konsultan/proyek/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) }),
  // the engagement's long report (api/aip/laporan_konsultan.py): chapters, numbered exhibits, the commentary once written
  fullReport: (run: string) => req<FullReport>(`/api/aip/konsultan/${run}/laporan-lengkap`),
  claimTrace: (run: string, klaim: string, faskes: string) =>
    req<ClaimTrace>(`/api/aip/konsultan/${run}/laporan-lengkap/jejak?klaim=${encodeURIComponent(klaim)}&faskes=${encodeURIComponent(faskes)}`),
  // the long report as a PDF, drawn by the API's headless browser as the caller (api/report_render.py)
  reportPdf: async (run: string): Promise<Blob> => {
    const r = await fetch(`${API_URL}/api/aip/konsultan/${run}/laporan-lengkap/pdf`, { cache: "no-store" });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(typeof body.detail === "string" ? body.detail : `${r.status} ${r.statusText}`);
    }
    return r.blob();
  },
  writeNotes: (run: string) => post<{ status: string }>(`/api/aip/konsultan/${run}/laporan-lengkap/narasi`, {}),
  // a project off the list with its engagements (their trails kept in runs-terhapus/)
  deleteProject: (id: string) => req<{ dihapus: string; penugasan: string[] }>(`/api/aip/konsultan/proyek/${id}`, { method: "DELETE" }),
  // a wrong or accidental engagement off the list (its trail kept in runs-terhapus/ for an administrator)
  deleteEngagement: (id: string) => req<{ dihapus: string }>(`/api/aip/konsultan/${id}`, { method: "DELETE" }),
  engagements: () => req<Rec[]>("/api/aip/konsultan/runs"),
  // the last finished engagement on the platform: the analysis the chat answers from ({ada: false} before the first)
  latest: () => req<{ ada: boolean; run?: string; pada?: string; biaya_usd?: number }>("/api/aip/konsultan/terakhir"),
  rewriteReport: (runId: string) => post<{ run: string; sumber: string }>(`/api/aip/konsultan/${runId}/laporan`, {}),
  semantic: () => req<Rec>("/api/aip/semantik"),
  tags: (q: Record<string, string | number | undefined> = {}) =>
    req<{ total: number; tags: Tag[]; markings?: Rec }>(`/api/aip/indikasi?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]))}`),
  tagSummary: (run_id?: string) => req<TagSummary>(`/api/aip/indikasi/ringkasan${run_id ? `?run_id=${run_id}` : ""}`),
  tag: (id: string) => req<Tag>(`/api/aip/indikasi/${id}`),
  decideTag: (id: string, status: string, catatan: string) => post<Tag>(`/api/aip/indikasi/${id}/keputusan`, { status, catatan }),
  // the live box, or an engagement's (penugasan); ringkas: list rows only
  box: (q: { kelompok?: string; penugasan?: string; limit?: number; ringkas?: boolean } = {}) =>
    req<Box>(`/api/aip/karantina?${new URLSearchParams(Object.entries({ limit: q.kelompok ? 2000 : 60, ...q }).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]))}`),
  boxChoices: () => req<BoxChoices>("/api/aip/karantina/penugasan"),
  facility: (fid: string, penugasan?: string) => req<BoxFacility>(`/api/aip/karantina/${fid}${penugasan ? `?penugasan=${penugasan}` : ""}`),
  decideFacility: (fid: string, status: string, catatan: string) => post<BoxFacility>(`/api/aip/karantina/${fid}/keputusan`, { status, catatan }),
  rebuildBox: () => post<Rec>("/api/aip/karantina/hitung", {}),
  review: (klaim_id: string, pendapat_kedua = false) => post<Rec & { telaah: Review; pendapat_kedua?: Review; sepakat?: boolean; fakta: Rec; di_luar_prompt: Rec }>(
    "/api/aip/medis/klaim", { klaim_id, pendapat_kedua }),
  production: () => req<Production>("/api/aip/produksi"),
  productionRun: (id: string) => req<ProdRun>(`/api/aip/produksi/runs/${id}`),
  runPipeline: () => post<ProdRun>("/api/aip/produksi/jalankan", {}),
  schedule: (body: { aktif: boolean; jam: number; saat_data_baru: boolean }) => req<Rec>("/api/aip/produksi/jadwal", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  health: () => req<Rec>("/api/aip/fraud/v1/sehat"),
  verify: (body: Rec) => post<Verify>("/api/aip/fraud/v1/verify", body),
  verifyClaim: (klaim_id: string, pendapat_kedua = false) => post<Verify>("/api/aip/fraud/v1/verify/klaim", { klaim_id, pendapat_kedua }),
  // many claims: a CSV (one claim per row) in the background, its progress, a claim's whole answer, the results as a CSV
  verifyCsv: (file: File, pendapat_kedua = false) => {
    const fd = new FormData();
    fd.append("berkas", file);
    fd.append("pendapat_kedua", String(pendapat_kedua));
    return req<VerifyBatch>("/api/aip/fraud/v1/verify/csv", { method: "POST", body: fd });
  },
  verifyBatches: () => req<VerifyBatch[]>("/api/aip/fraud/v1/verify/batch"),
  verifyBatch: (id: string, q: { status?: string; offset?: number; limit?: number } = {}) =>
    req<VerifyBatch>(`/api/aip/fraud/v1/verify/batch/${id}?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]))}`),
  verifyBatchRow: (id: string, no: number) => req<BatchRow & { masukan: Rec; hasil: Verify | null }>(`/api/aip/fraud/v1/verify/batch/${id}/baris/${no}`),
  cancelVerifyBatch: (id: string) => post<VerifyBatch>(`/api/aip/fraud/v1/verify/batch/${id}/batal`, {}),
  /** A file of the API saved by the browser (fetch carries the session; a plain link might not). */
  download: async (path: string, name: string) => {
    const r = await fetch(`${API_URL}${path}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob());
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  // the evidence ladder and the pilot's designed audit (api/aip/ml.py /tangga, api/aip/karantina.py /pilot)
  ladder: () => req<Rec>("/api/aip/ml/tangga"),
  pilot: () => req<Rec>("/api/aip/karantina/pilot/aktif"),
  designPilot: (body: { ditandai: number; acak: number; seed?: number }) => post<Rec>("/api/aip/karantina/pilot", body),
  pilotOutcome: (kode: string, body: { terbukti: boolean; nilai_rp?: number; catatan?: string }) => post<Rec>(`/api/aip/karantina/pilot/${kode}/hasil`, body),
};

export const rp = (n: number | null | undefined) =>
  n == null ? "—" : n >= 1e9 ? `Rp ${(n / 1e9).toFixed(2).replace(".", ",")} M` : n >= 1e6 ? `Rp ${(n / 1e6).toFixed(1).replace(".", ",")} jt` : `Rp ${Math.round(n).toLocaleString("id-ID")}`;
export const STRENGTH: Record<string, string> = { lemah: "#8f99a8", sedang: "#fab219", kuat: "#e5484d" };
export const GROUP_COLOR: Record<string, string> = { A: "#e5484d", B: "#ec835a", C: "#fab219", D: "#3987e5", Z: "#738091" };
export const TSM_COLOR: Record<string, string> = { terpenuhi: "#e5484d", sebagian: "#fab219", tidak: "#4b5563" };
/** A TSM level as a mark (✓ terpenuhi · ◐ sebagian · – tidak), and the three dimensions in order with their names. */
export const TSM_MARK: Record<string, string> = { terpenuhi: "✓", sebagian: "◐", tidak: "–" };
export const TSM_DIM = [["terstruktur", "Terstruktur"], ["sistematis", "Sistematis"], ["masif", "Masif"]] as const;
/** A hospital's path from its TSM (the branch report's Box Karantina): ditindak = all three met, dibina = at least one, dibebaskan = none. */
export const JALUR: Record<string, { label: string; color: string }> = {
  ditindak: { label: "Ditindak", color: "#e5484d" }, dibina: { label: "Dibina", color: "#e0a02b" }, dibebaskan: { label: "Dibebaskan", color: "#29a383" },
};
export const VERDICT: Record<string, { label: string; color: string }> = {
  INDIKASI_KUAT: { label: "Indikasi kuat", color: "#e5484d" }, PERLU_DIPERIKSA: { label: "Perlu diperiksa", color: "#fab219" }, WAJAR: { label: "Wajar", color: "#29a383" },
  mencurigakan: { label: "Mencurigakan", color: "#e5484d" }, perlu_diperiksa: { label: "Perlu diperiksa", color: "#fab219" }, wajar: { label: "Wajar secara klinis", color: "#29a383" },
};
