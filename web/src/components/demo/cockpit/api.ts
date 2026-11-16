import { API_URL } from "@/lib/api";

/* PLN Grid Monitoring Cockpit — the API's shapes (api/pln_cockpit.py). Every record carries `ref` (Nexus object) and every
   page `sumber` (Nexus types / datasets with their lineage node), so the UI can always drill to the source. */

export type Ref = { type_id: string; pk: string } | null;
export type Sumber = { key: string; type_id?: string; nama: string; dataset_id?: string | null; lineage?: string | null };
/** AMI streaming in the Nexus: meter health and substation hourly balance (GET /api/pln-cockpit/ami). */
export type AmiData = {
  tersedia: boolean;
  alasan?: string;
  meter?: number;
  status?: Record<string, number>;
  pf_rata?: number | null;
  perlu_dicek?: { no_meter: string; kode_dt?: string; kode_ulp?: string; status: string; alasan?: string; terakhir?: string; ref: Ref }[];
  jam_terakhir?: string;
  gardu_jam_terakhir?: { kode_dt: string; kwh?: number; aktif?: number; rendah?: number; porsi?: number; status: string; ref: Ref }[];
  tren_jam?: { jam: string; kwh: number; anomali: number }[];
  sumber?: Sumber[];
};
export type Point = { t: string; value: number | null };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}/api/pln-cockpit${path}`, { cache: "no-store", credentials: "include", ...init });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return res.json();
}

export const post = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export type Freshness = { nama: string; pipeline_id: string | null; status: string; waktu: string | null; sukses_terakhir: string | null };
export type N1Row = {
  kode_gi: string; nama_gi: string; status_n1: string; beban_firm_puncak_pct: number; margin_n1_mva: number; puncak_mva: number;
  kapasitas_firm_mva: number; kapasitas_mva?: number; waktu_puncak: string; jam_melanggar_n1?: number; jam_waspada_n1?: number; faktor_beban?: number;
  faktor_diversitas?: number; penyulang?: number; rekomendasi?: string; n_trafo?: number; ref: Ref; gi_ref?: Ref;
};
export type Overview = {
  mode: string; dibuat: string;
  transmisi: { saluran: number; gardu: number; pembangkit: number; per_kelas_kv: Record<string, { ruas: number; km: number }>;
    struktural: { koridor: number; kritis: number; kritis_berdampak: number; mw_berisiko: number; artikulasi: number; radial: number } };
  distribusi: { gi: number; penyulang: number; gardu: number; pelanggan: number; per_status: Record<string, number> };
  n1_gi: N1Row[];
  termal: { maks_pct: number | null; penyulang: string | null; beban_tinggi: number; dt_maks_pct: number | null; dt: string | null; dt_overload: number };
  keandalan: { saidi: number; saifi: number; maifi: number; caidi: number | null; ens_kwh: number; gangguan: number; periode: string };
  risiko: Record<"Tinggi" | "Sedang" | "Rendah", number>;
  susut: { susut_pct: number; tl_pct: number; ntl_pct: number };
  alarm: { total: number; aktif: number; per_severity: Record<string, number>; per_kategori: Record<string, number>; belum_ditangani: number };
  pekerjaan: { perintah_terbuka: number; perintah: number; kunjungan_terjadwal: number };
  stream: { ami: { published?: number; running?: boolean; meters?: number; last_interval?: string | null }; sensor_gardu: { published?: number; running?: boolean; gardu?: number; last_interval?: string | null } };
  kesegaran: Freshness[];
  ketersediaan: Record<string, string>;
};
export type Alarm = {
  id: string; kind: "alarm" | "peristiwa"; type_id: string | null; severity: string; kategori: string; sumber: string; jenis_aset: string; aset: string;
  aset_ref: Ref; kode_penyulang: string | null; kode_dt: string | null; kode_ulp: string | null; judul: string; detail: string; nilai: number | null;
  ambang: number | null; satuan: string | null; waktu: string; status: string; penugasan: string; catatan: string; rekomendasi: string;
};
export type AlarmList = { events: Alarm[]; total: number; counts: { status: Record<string, number>; severity: Record<string, number>; kategori: Record<string, number> }; sumber: Sumber[] };
export type HistoryEntry = { at?: string; user?: string; user_name?: string; op?: string; changes?: Record<string, unknown> };

export type AssetRow = { id: string; nama: string; kelas_kv: number | null; cakupan: string | null; status: string | null };
export type Linked = { jenis: string; id: string; peran: string; nama?: string | null; ref: Ref; nilai?: string };
export type Koridor = {
  id: string; nama: string; kelas_kv: number; panjang_km: number; kritis_n1: boolean; dampak: string; mw_terisolasi: number; gardu_terisolasi: number;
  pembangkit_terisolasi: number; nama_simpul_a: string; nama_simpul_b: string; simpul_a: string; simpul_b: string; contoh_terisolasi: string; ref: Ref;
};
export type Detail = {
  jenis: string; id: string; nama: string; ref: Ref; properti: Record<string, unknown>; terhubung: Linked[];
  risiko: (Record<string, unknown> & { ref: Ref }) | null; struktural: (Record<string, unknown> & { ref: Ref }) | null; koridor: Koridor[];
  terkait: Record<string, unknown>; alarm: Alarm[]; sumber: Sumber[];
};
export type Outage = { id: string; kode_penyulang: string; kode_ulp: string; mulai: string; pulih: string | null; jenis: string; penyebab: string; peralatan: string;
  durasi_menit: number; pelanggan_padam: number; ens_kwh: number; ref: Ref };
export type OutageDetail = { id: string; ref: Ref; timeline: { waktu: string; kejadian: string }[];
  dampak_topologi: { penyulang: string; penyulang_ref: Ref; gardu: { id: string; nama: string; pelanggan: number; status: string; ref: Ref }[]; pelanggan_total: number;
    pelanggan_padam_soe: number; ens_kwh: number; pelanggan_jam: number; catatan: string };
  keandalan_bulan: (Record<string, unknown> & { ref: Ref }) | null };
export type Pembebanan = { kode_penyulang: string; nama: string; kode_gi: string; kode_ulp: string; jenis: string; kha_a: number; batas_termal_a: number; puncak_kw: number;
  waktu_puncak: string; rata_kw: number; faktor_beban: number; arus_puncak_a: number; beban_termal_pct: number; jam_di_atas_80pct: number; rugi_i2r_puncak_kw: number;
  ruang_tambah_kw: number; status_termal: string; ref: Ref; penyulang_ref: Ref };
export type Profil = { jam: string; rata_kw: number; min_kw: number; maks_kw: number; rata_hari_kerja_kw: number; rata_akhir_pekan_kw: number };
export type DtLoad = { kode_dt: string; kode_penyulang: string; kode_ulp: string; beban_pct: number; jam_overload: number; suhu_minyak_maks_c: number | null;
  tegangan_ujung_min_v: number | null; kelas_risiko: string; skor: number; rekomendasi: string; kejadian_terakhir: string | null; ref: Ref; risiko_ref: Ref };
export type Beban = {
  gi: { kode_gi: string; nama_gi: string; kapasitas_mva: number; kapasitas_firm_mva: number; harian_puncak_mva: Point[]; per_jam_mva: Point[] }[];
  n1_gi: N1Row[]; penyulang: Pembebanan[]; profil: Record<string, Profil[]>; gardu: DtLoad[]; sumber: Sumber[]; transmisi: { tersedia: boolean; alasan: string };
};
export type BebanPenyulang = { kode: string; pembebanan: Pembebanan; ref: Ref; kw: Point[]; termal_pct: Point[]; profil: Profil[]; sumber: Sumber[] };
export type Kontingensi = {
  gi: N1Row[];
  struktural: { tersedia: boolean; ringkas: { koridor: number; kritis: number; artikulasi: number; radial: number; simpul: number; mw_berisiko: number; gardu_berisiko: number };
    per_kelas: Record<string, { koridor: number; kritis: number; km: number }>; kritis_teratas: Koridor[];
    artikulasi_teratas: { osm_id?: string; nama: string; jenis: string; koridor: number; koridor_kritis: number; tetangga: number; redundansi: string; ref: Ref; gardu_ref: Ref }[];
    transform: { repo_id: string | null; status: string | null }; metode: string; batasan: string };
  aliran_daya: { tersedia: boolean; status: string; alasan: string; kebutuhan: string[] };
  sumber: Sumber[];
};
export type Keandalan = {
  sistem: { periode: string; per_bulan: { bulan: string; saidi: number; saifi: number; maifi: number; gangguan: number; permanen: number; ens_kwh: number }[];
    total: { saidi: number; saifi: number; maifi: number; caidi: number | null; ens_kwh: number; gangguan: number } };
  penyulang: { kode_penyulang: string; kode_ulp: string; pelanggan: number; saidi: number; saifi: number; maifi: number; caidi: number | null; gangguan: number;
    permanen: number; ens_kwh: number; bulan: Record<string, number>; ref: Ref }[];
  definisi: Record<string, string>; sumber: Sumber[];
};
export type RisikoRow = { id_risiko: string; jenis_aset: string; kode_aset: string; kode_penyulang: string; kode_ulp: string; skor: number; kelas_risiko: string;
  faktor_utama: string; bukti: string; rekomendasi: string; beban_pct: number | null; status_aset: string | null; jumlah_pelanggan: number | null; ref: Ref;
  aset_ref: Ref; aset_jenis: string };
export type Risiko = { rows: RisikoRow[]; total: number; per_kelas: Record<string, number>; per_faktor: Record<string, number>; sumber: Sumber[]; metode: string };
export type LossData = {
  tersedia: boolean; alasan?: string; periode_bulan?: string[];
  per_ulp?: { kode_ulp: string; mwh_kirim_q3: number; susut_pct: number; susut_teknis_pct: number; susut_non_teknis_pct: number; nilai_susut_rp_q3: number; temuan_p1: number; nilai_harapan_rp: number }[];
  total?: { mwh_kirim_q3: number; susut_pct: number; tl_pct: number; ntl_pct: number; nilai_susut_rp_q3: number; temuan_p1: number; nilai_harapan_rp: number };
  tren?: { bulan: string; kwh_kirim: number; tl_kwh: number; ntl_kwh: number; tl_pct: number; ntl_pct: number }[];
  komponen_tl?: { komponen: string; kwh: number; metode: string }[];
  hotspot_penyulang?: { kode: string; ulp: string; tl_kwh: number; tl_pct: number; ntl_kwh: number; ntl_pct: number; ref: Ref }[];
  hotspot_gardu?: { kode: string; penyulang: string; tl_kwh: number; tl_pct: number; ntl_pct: number; hari_overload: number; ref: Ref }[];
  metode?: Record<string, string>; sumber?: Sumber[];
};
export type MlData = {
  strategi: { strategi: string; k: number; presisi_at_k: number; rp_pulih_per_inspeksi_bulan: number; auroc_kunci: number }[];
  metrics: Record<string, { step: number; value: number; at: string }[]>;
  target: { id_pelanggan: string; segmen: string; skor_ntl: number; potensi_rp_bulan: number; kunci: number }[];
};
export type NtlData = { deteksi: { bacaan: number; meter_jam: number; dugaan: number; false_positive?: number;
  latensi: { kejadian: string; no_meter: string; pola: string; mulai_wib: string; terdeteksi_wib: string; latensi_jam: number }[] }; peristiwa_total: number };
export type Field = {
  perintah_kerja: { id: string; ref: Ref; riwayat: HistoryEntry[]; id_perintah: string; judul: string; jenis_pekerjaan: string; status_pekerjaan: string; kode_dt: string;
    kode_penyulang: string; id_temuan: string; uraian: string; estimasi_biaya_rp: number; tanggal_target: string; pelaksana: string }[];
  kunjungan: { id: string; ref: Ref; id_kunjungan: string; judul: string; id_temuan: string; id_pelanggan: string; kode_dt: string; kode_ulp: string; kode_tim: string;
    mulai: string; selesai: string; prioritas: string; pola_dugaan: string; nilai_harapan_rp: number; status_kunjungan: string }[];
  inspeksi: { id: string; ref: Ref; no_ba: string; id_pelanggan: string; tanggal: string; dasar_pemilihan: string; golongan: string; temuan: string; tim: string;
    rp_tagihan_susulan: number; ditemukan_pelanggaran: number; kode_ulp: string }[];
  actions: { ubah_status: string | null; buat: string | null }; sumber: Sumber[]; catatan: string;
};
/** ERD participation of one side of a relation: objects with at least one link; total = all (or a required key) */
export type PartSide = { linked: number; objects: number; total: boolean; required: boolean; pct: number | null };
export type DsInfo = { nama: string; dataset_id: string | null; lineage: string | null; akses: boolean; diperbarui: string | null; baris?: number | null; versi?: number | null };
export type Integrasi = {
  pipeline: { key: string; nama: string; pipeline_id: string | null; tipe: string; lineage: string | null;
    build: { id: string; status: string; trigger: string; at: string; error: string | null; last_success: string | null } | null; output: DsInfo[]; sumber: DsInfo[] }[];
  transform: { nama: string; repo_id: string | null; transform: string; status: string | null; build: { status: string; at: string } | null; output: DsInfo[]; sumber: DsInfo[] };
  nexus: { key: string; type_id: string; nama: string; dataset_id: string | null; lineage: string; objek_terlihat: number; properti: number; tautan: number;
    actions: { id: string; nama: string }[]; riwayat: boolean; kebijakan_baris: boolean; grup: string }[];
  relasi: { id: string; nama: string; dari: string; ke: string; kardinalitas: string; jenis: string; kunci: string | null;
    partisipasi: { source: PartSide; target: PartSide; links: number } | null }[];
  aplikasi: { lineage_graph: string; lineage_grid: string; peta_gabungan: string | null; peta_susut: string | null; workshop: string | null; orbis: string; project_id: string | null; monitor_ami: string | null };
  dibangun: string | null;
};

/* links into the platform */
export const objUrl = (r: Ref) => (r ? `/ontology/objects/${r.type_id}/${encodeURIComponent(r.pk)}` : undefined);
export const typeUrl = (id?: string | null) => (id ? `/ontology/${id}` : undefined);
export const lineageUrl = (node?: string | null) => (node ? `/lineage?node=${encodeURIComponent(node)}` : undefined);
export const datasetUrl = (id?: string | null) => (id ? `/datasets/${id}` : undefined);

export const fmt = (v: number | null | undefined, d = 0) => (v == null || Number.isNaN(v) ? "—" : v.toLocaleString("id-ID", { maximumFractionDigits: d, minimumFractionDigits: 0 }));
export const rp = (v: number | null | undefined) => (v == null ? "—" : `Rp ${(v / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 })} jt`);
export const waktu = (s?: string | null) => {
  if (!s) return "—";
  const d = new Date(s.length === 16 ? `${s.replace(" ", "T")}:00+07:00` : s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
};
