"use client";
// What the branch report's tabs (Jejak kerja, Indikasi & rekomendasi, Biaya & token) share: number formats, the run's step names
// in plain words, and the "not recorded" marker (a breakdown the runner does not record is said so, never estimated).
import type { KodeTahap } from "@/lib/cabangJejak";

export const fmt = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
export const usd = (v: number) => `$${v.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: v > 0 && v < 0.01 ? 4 : v < 1 ? 3 : 2 })}`;
export const tok = (n: number) => (n >= 1e6 ? `${fmt(n / 1e6, 2)} jt` : n >= 1e3 ? `${(n / 1e3).toLocaleString("id-ID", { maximumFractionDigits: 1 })} rb` : `${n}`);
export const persen = (a: number, b: number) => (b ? `${((100 * a) / b).toLocaleString("id-ID", { maximumFractionDigits: 1 })}%` : "–");
export const lama = (detik: number) => (detik < 90 ? `${Math.round(detik)} dtk` : `${(detik / 60).toLocaleString("id-ID", { maximumFractionDigits: 1 })} mnt`);
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
/** "2026-11-15 16:05:32" → "15 Nov 16:05" (the runner's local time, shown as written) */
export function jam(s?: string | null, tanggal = true): string {
  if (!s) return "–";
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)/.exec(s);
  if (!m) return s;
  return tanggal ? `${+m[3]} ${BULAN[+m[2] - 1]} ${m[4]}:${m[5]}` : `${m[4]}:${m[5]}`;
}

export const NAMA_TAHAP: Record<KodeTahap, [string, string]> = {
  fitur: ["Fitur & mesin aturan", "Klaim tiap ulangan data dibaca mesin aturan (rekam medis ikut diperiksa), lalu ciri tiap klaim dihitung."],
  zona: ["Zona model ML", "Model ML memberi skor tiap klaim: ditahan langsung, ragu (dibaca tim agen AI), atau lolos."],
  iot: ["Cek pemakaian alat medis (IoT)", "Lama nyala dan mode alat yang terpantau dicocokkan dengan yang ditagihkan RS."],
  aturan: ["Temuan aturan ke tim agen AI", "Temuan rekam medis dan alat diberi nomor dan masuk ke berkas yang dibaca agen; temuan kuat yang terverifikasi membuka jalur bukti aturan."],
  swarm: ["Tim agen AI membaca klaim ragu", "Tiga spesialis lalu hakim membaca berkas 8 klaim sekaligus; gerbang memutuskan klaim perlu diperiksa atau dibersihkan."],
  laporan: ["Laporan & jaringan klaim", "Kode menulis laporan KC, berkas per RS dan per klaim, serta jaringan klaim."],
  narasi: ["Agen penulis", "Agen menulis makna dan implikasi tiap exhibit; kalimat yang angkanya tidak cocok dibuang kode."],
};
// the agents of a branch run (testing/swarm_v5_adk.py): three specialists and the judge per batch of 8 claims, the writer per batch of exhibits
export const AGEN_CABANG: { key: string; nama: string; peran: string; lini: "spesialis" | "hakim" | "penulis" }[] = [
  { key: "koding", nama: "Spesialis koding & klinis", peran: "Tim agen AI · spesialis", lini: "spesialis" },
  { key: "tagihan", nama: "Spesialis tagihan", peran: "Tim agen AI · spesialis", lini: "spesialis" },
  { key: "episode", nama: "Spesialis episode & jaringan", peran: "Tim agen AI · spesialis", lini: "spesialis" },
  { key: "hakim", nama: "Hakim", peran: "Tim agen AI · penilai akhir", lini: "hakim" },
  { key: "penulis", nama: "Agen penulis", peran: "Narasi laporan", lini: "penulis" },
];
/** the model, named neutrally (one model for every agent of the branch run) */
export const MODEL_CABANG = "Model AI tim agen";

export const STATUS_TAHAP: Record<string, [string, string]> = {
  selesai: ["selesai", "#7ee2c0"], berjalan: ["sedang berjalan", "#c9c0ff"], gagal: ["berhenti", "#ff8a8d"], dilewati: ["dilewati", "#8f99a8"],
  belum: ["belum dijalankan", "#8f99a8"], tidak_tercatat: ["tidak tercatat", "#8f99a8"],
};

/** A breakdown the run does not record: said plainly, in place of a number. */
export function TakTercatat({ children = "tidak tercatat per agen di run ini" }: { children?: React.ReactNode }) {
  return <span className="inline-flex items-center rounded border border-dashed border-white/15 px-1.5 py-0.5 text-[10.5px] italic text-[#8f99a8]">{children}</span>;
}

export function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div><p className="text-[16px] font-semibold tabular-nums text-white">{value}</p><p className="text-[10.5px] text-[#8f99a8]">{label}{hint ? ` · ${hint}` : ""}</p></div>;
}

export function KepalaBagian({ judul, nilai }: { judul: string; nilai?: string }) {
  return (
    <div className="mb-2">
      <p className="text-[10.5px] font-semibold uppercase tracking-[.12em] text-[#d95926]">{judul}</p>
      {nilai && <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-white">{nilai}</p>}
    </div>
  );
}
export const SubJudul = ({ children }: { children: React.ReactNode }) => <p className="mb-1 mt-3 text-[10px] uppercase tracking-[.1em] text-[#8f99a8]">{children}</p>;
