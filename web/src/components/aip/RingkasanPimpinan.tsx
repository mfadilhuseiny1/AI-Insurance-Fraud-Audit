"use client";

// The branch audit report as a leader reads it ("Ringkas"; the user, 2026-11-15: "Laporan Audit itu kelihatan sangat kompleks
// ya, bisa di-rearrange biar orang awam bisa bacanya lebih enak"): one page in plain words — the gist in three sentences,
// four headline numbers, the main findings each with one small picture, the hospitals by path, two flagged claims told as a
// story from their evidence, the decisions, and a short glossary. Everything is derived here from the report's own fields
// (testing/laporan_cabang.py: sampul, exhibit, box, berkas_rs, kasus, iot); the full report ("Lengkap") keeps every chapter,
// exhibit and case file, and each link here opens the matching place in it.

import type { ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { JALUR } from "./fraudApi";
import { HASIL_IOT, type IotRingkas } from "./IotKlaim";
import type { BerkasRS, Kasus, Laporan } from "./SwarmCabangView";

// ---------------------------------------------------------------- numbers in plain words
const angka = (v: number, d = 0) => v.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
/** Rupiah as a reader says it: "Rp 1,40 miliar", "Rp 490 juta", "Rp 32,4 juta". */
export const rupiah = (v: number) =>
  v >= 1e9 ? `Rp ${angka(v / 1e9, 2)} miliar` : v >= 1e8 ? `Rp ${angka(v / 1e6)} juta` : v >= 1e6 ? `Rp ${angka(v / 1e6, 1)} juta` : `Rp ${angka(v)}`;
const persen = (v: number, d = 0) => `${angka(100 * v, d)}%`;
const kapital = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const tanggal = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return m ? `${Number(m[3])} ${BULAN[Number(m[2]) - 1]} ${m[1]}` : s; };
/** "2024-12-18 s/d 2025-12-17" → "18 Des 2024 – 17 Des 2025" */
export const periodeAwam = (p: string) => { const d = p.match(/\d{4}-\d{2}-\d{2}/g); return d?.length === 2 ? `${tanggal(d[0])} – ${tanggal(d[1])}` : p; };

// ---------------------------------------------------------------- the report's labels in plain words (the label itself stays in the tooltip)
/** the loss-basis tags (ledger) and the indication tags */
const MODUS_AWAM: Record<string, string> = {
  "Tagihan di atas tarif INA-CBG / top-up": "tagihan melebihi tarif paket",
  "Readmisi tidak wajar": "pasien dirawat ulang tanpa alasan kuat",
  "Pemecahan episode": "satu perawatan dipecah jadi beberapa klaim",
  "Upcoding keparahan / kode": "diagnosis dibuat lebih berat agar tarif naik",
  "Cloning (penjiplakan klaim)": "klaim jiplakan dari klaim lain",
  "Klaim fiktif (sinyal)": "tanda klaim fiktif",
  "Klaim ganda / berulang": "klaim yang sama ditagih dua kali",
  "Rujukan semu / tidak sesuai": "rujukan semu",
  "Durasi alat medis tidak sesuai klaim (IoT)": "jam pemakaian alat medis tidak cocok",
  "Tidak sesuai indikasi medis": "tindakan tanpa alasan medis",
  "Lama rawat diperpanjang": "lama rawat diperpanjang",
  "Manipulasi kelas rawat": "kelas rawat ditagih lebih tinggi",
  "Tindakan ditagih tanpa dilakukan": "tindakan ditagih padahal tidak dilakukan",
  "Klaim fiktif obat/alkes/tindakan": "obat, alat atau tindakan ditagih tapi tidak diberikan",
  "Risiko tinggi menurut model": "pola tagihan sangat tidak biasa",
  "Jaringan faskes tidak wajar (graf realtime)": "pola pasien antar-RS tidak wajar",
};
/** the Permenkes 16/2019 modes the claims' own explanations name, by code */
const PERMENKES_AWAM: Record<string, string> = {
  M04: "diagnosis atau tindakan dibuat lebih berat", M06: "klaim palsu (layanannya tidak ada)", M07: "tagihan digelembungkan",
  M08: "satu perawatan dipecah jadi beberapa klaim", M09: "layanan paket ditagih terpisah-pisah", M10: "rujukan semu",
  M11: "klaim yang sama ditagih berulang", M12: "lama rawat diperpanjang", M13: "kelas rawat ditagih lebih tinggi",
  M14: "tindakan ditagih padahal tidak dilakukan", M15: "tindakan tanpa alasan medis", M16: "pasien dirawat ulang tanpa alasan kuat",
  M17: "obat, alat atau tindakan ditagih tapi tidak diberikan",
};
/** the claim-vs-medical-record findings (api/aip/realtime/rme.py signals), short */
const RME_AWAM: Record<string, string> = {
  RME_DIAGNOSIS_TIDAK_TERCATAT: "diagnosis yang ditagih tidak tercatat",
  RME_KLINIS_TIDAK_MENDUKUNG: "tidak ada alasan medis untuk tindakannya",
  RME_EPISODE_DIPECAH: "satu rawat inap ditagih jadi beberapa klaim",
  RME_TINDAKAN_TIDAK_TERCATAT: "tindakan yang ditagih tidak tercatat",
  RME_DIAGNOSIS_TIDAK_DIDUKUNG: "diagnosis dibantah hasil pemeriksaan",
  RME_RAWAT_INAP_TANPA_INDIKASI: "dirawat inap padahal hasil pemeriksaan normal",
  RME_KUNJUNGAN_TIDAK_ADA: "tidak ada kunjungan pada tanggal klaim",
  RME_OBAT_ALKES_TIDAK_TERCATAT: "obat atau alat yang ditagih tidak tercatat",
  RME_PASIEN_BERBEDA: "pasien di rekam medis bukan pemilik kartu",
  RME_KUNJUNGAN_DIPAKAI_ULANG: "satu kunjungan ditagih dua kali",
  RME_KELAS_BERBEDA: "kelas rawat ditagih lebih tinggi",
  RME_LOS_TIDAK_SESUAI: "lama rawat ditagih lebih panjang",
  RME_JENIS_RAWAT_BERBEDA: "ditagih rawat inap, tercatat rawat jalan",
  RME_VENTILASI_TIDAK_SESUAI: "jam ventilasi ditagih lebih lama",
  RME_HARI_ICU_LEBIH: "hari ICU ditagih lebih banyak",
  RME_OBAT_JUMLAH_KURANG: "jumlah obat ditagih lebih banyak",
  RME_READMISI_TERENCANA: "rawat ulang terencana tanpa kebutuhan medis",
  RME_READMISI_PULANG_DINI: "dipulangkan belum stabil lalu masuk lagi",
  RME_RUJUKAN_TANPA_INDIKASI: "dirujuk tanpa alasan medis",
  RME_DOKTER_PASIEN_DIPUTAR: "pasien berpindah RS mengikuti satu dokter",
};
export const modusAwam = (label: string) => MODUS_AWAM[label] ?? label.replace(/\s*\((sinyal|graf realtime)\)$/, "").toLowerCase();
const modusKlaimAwam = (m: { kode: string; nama: string }) => PERMENKES_AWAM[m.kode] ?? m.nama.replace(/\s*\(.*\)$/, "").toLowerCase();
const rmeAwam = (kode: string, teks?: string) => RME_AWAM[kode] ?? (teks ? teks.split(/[(;]/)[0].trim() : kode.replace(/^RME_/, "").replace(/_/g, " ").toLowerCase());
/** a hospital's main indication in plain words: the claims' own explanations first, else the loss basis */
export const alasanRS = (b: BerkasRS) => {
  const mk = b.modus_klaim?.[0];
  if (mk) return { teks: modusKlaimAwam(mk), asli: `${mk.kode} · ${mk.nama}` };
  const r = b.rugi_modus[0];
  return r ? { teks: modusAwam(r.label), asli: r.label } : { teks: b.modus_utama, asli: b.modus_utama };
};

// ---------------------------------------------------------------- what the page shows, derived from the report
type JalurKey = "ditindak" | "dibina" | "dibebaskan";
const JALUR_URUT: JalurKey[] = ["ditindak", "dibina", "dibebaskan"];
export type Ringkas = {
  kc: string; klaim: number; nilaiTransaksi: number; rs: number; kabkota: number; periode: string; sintetis: boolean;
  antre: number; persenAntre: number; nilaiAntre: number; tahan: number; periksa: number; rugi: number;
  konsentrasi: { rs: number; porsi: number } | null;
  kab: { nama: string; rugi: number; porsi: number }[]; kabRapat: { nama: string; per100: number } | null;
  modus: { label: string; asli: string; nilai: number; klaim: number }[]; judulModus?: string;
  rsTop: BerkasRS[]; nRsAntre: number; judulRs?: string;
  jalur: Record<JalurKey, number> | null; rsJalur: Record<JalurKey, BerkasRS[]>;
  iot?: IotRingkas;
  rme: { klaim: number; jenis: { kode: string; label: string; klaim: number }[] } | null;
  andal: { lolos: number; total: number; uji: string } | null;
  prioritas: Record<"P1" | "P2" | "P3", { n: number; rp: number }>;
  verif: { sudah: number; terbukti: number; sesuai: number; investigasi: number };
  nBab: number; nExhibit: number;
};

export function olahRingkas(L: Laporan, riil = false): Ringkas {
  const s = L.sampul;
  const antre = L.kasus.filter((k) => k.keputusan !== "DIBERSIHKAN");
  const nilaiTransaksi = s.nilai_transaksi_rp ?? s.tagihan_rp;
  const rugi = s.estimasi_kerugian_rp ?? antre.reduce((t, k) => t + (k.estimasi_kerugian_rp ?? 0), 0);
  const exh = (x: string) => L.exhibit.find((e) => e.id === x);
  const berkas = [...(L.berkas_rs ?? [])].sort((a, b) => b.estimasi_kerugian_rp - a.estimasi_kerugian_rp);
  // where the loss concentrates: the Box's group A (the hospitals holding the first half of it), else counted here
  const A = L.box?.kelompok?.A;
  let konsentrasi: Ringkas["konsentrasi"] = A && rugi > 0 ? { rs: A.rs, porsi: A.estimasi_kerugian_rp / rugi } : null;
  if (!konsentrasi && rugi > 0 && berkas.length) {
    let t = 0, n = 0;
    for (const b of berkas) { t += b.estimasi_kerugian_rp; n += 1; if (t >= rugi / 2) break; }
    konsentrasi = { rs: n, porsi: t / rugi };
  }
  // the kab/kota (the "wilayah-kc" exhibit's rows); the densest among those with enough claims to say so
  const wil = (exh("wilayah-kc")?.baris ?? []).map((r) => ({ nama: String(r.kabkota ?? ""), rugi: Number(r.estimasi_kerugian_rp) || 0,
    per1000: Number(r.rekomendasi_per_1000) || 0, klaim: Number(r.klaim) || 0 }));
  const kab = [...wil].sort((a, b) => b.rugi - a.rugi).filter((r) => r.rugi > 0).map((r) => ({ nama: r.nama, rugi: r.rugi, porsi: rugi ? r.rugi / rugi : 0 }));
  const rapat = wil.filter((r) => r.klaim >= 100).sort((a, b) => b.per1000 - a.per1000)[0];
  // the loss by mode (the "kerugian-modus" exhibit, else the claims' own loss tags)
  const em = exh("kerugian-modus");
  let modus = (em?.baris ?? []).map((r) => ({ asli: String(r.label ?? ""), nilai: Number(r.nilai) || 0, klaim: Number(r.klaim) || 0 }));
  if (!modus.length) {
    const m: Record<string, { nilai: number; klaim: number }> = {};
    for (const k of antre) if (k.tag_label && k.estimasi_kerugian_rp) { const x = (m[k.tag_label] ??= { nilai: 0, klaim: 0 }); x.nilai += k.estimasi_kerugian_rp; x.klaim += 1; }
    modus = Object.entries(m).map(([asli, v]) => ({ asli, ...v }));
  }
  modus = modus.filter((m) => m.nilai > 0).sort((a, b) => b.nilai - a.nilai);
  // the hospitals by path
  const rsJalur = { ditindak: [], dibina: [], dibebaskan: [] } as Record<JalurKey, BerkasRS[]>;
  for (const b of berkas) if (b.jalur && b.jalur in rsJalur) rsJalur[b.jalur as JalurKey].push(b);
  const jb = L.box?.jalur;
  const jalur = jb ? { ditindak: jb.ditindak ?? 0, dibina: jb.dibina ?? 0, dibebaskan: jb.dibebaskan ?? 0 } : null;
  // the medical-record findings among the claims to check, by kind (a claim counted once per kind)
  const rmeKlaim = antre.filter((k) => (k.temuan_aturan ?? []).some((t) => t.sumber === "rme"));
  const jenis: Record<string, { label: string; klaim: number }> = {};
  for (const k of rmeKlaim) {
    const sudah = new Set<string>();
    for (const t of k.temuan_aturan ?? []) {
      if (t.sumber !== "rme" || sudah.has(t.kode)) continue;
      sudah.add(t.kode);
      (jenis[t.kode] ??= { label: rmeAwam(t.kode, t.teks), klaim: 0 }).klaim += 1;
    }
  }
  // the first cross-check of the "keandalan" exhibit: recommendations backed by a second source besides the model
  const ka = exh("keandalan")?.baris?.[0];
  const prioritas = { P1: { n: 0, rp: 0 }, P2: { n: 0, rp: 0 }, P3: { n: 0, rp: 0 } };
  for (const k of antre) if (k.prioritas) { prioritas[k.prioritas].n += 1; prioritas[k.prioritas].rp += k.biaya_rp; }
  const verif = { sudah: 0, terbukti: 0, sesuai: 0, investigasi: 0 };
  for (const k of antre) { const v = L.verifikasi?.[k.id]; if (v) { verif.sudah += 1; verif[v.status] += 1; } }
  return {
    kc: L.kc.nama, klaim: s.klaim, nilaiTransaksi, rs: s.rs, kabkota: L.kc.kabkota.length, periode: periodeAwam(L.periode), sintetis: !riil,
    antre: s.antrean, persenAntre: s.persen_antrean / 100, nilaiAntre: s.nilai_terindikasi_rp ?? s.nilai_antrean_rp, tahan: s.tahan, periksa: s.periksa, rugi,
    konsentrasi, kab, kabRapat: rapat ? { nama: rapat.nama, per100: rapat.per1000 / 10 } : null,
    modus: modus.map((m) => ({ ...m, label: modusAwam(m.asli) })), judulModus: em?.judul,
    rsTop: berkas, nRsAntre: berkas.length, judulRs: exh("konsentrasi-rs")?.judul,
    jalur, rsJalur, iot: L.iot,
    rme: rmeKlaim.length ? { klaim: rmeKlaim.length, jenis: Object.entries(jenis).map(([kode, v]) => ({ kode, ...v })).sort((a, b) => b.klaim - a.klaim) } : null,
    andal: ka ? { lolos: Number(ka.lolos) || 0, total: Number(ka.total) || 0, uji: String(ka.uji ?? "") } : null,
    prioritas, verif, nBab: L.bab.length, nExhibit: L.exhibit.length,
  };
}

// ---------------------------------------------------------------- the two example claims
export type Contoh = { k: Kasus; jenis: "iot" | "rme" | "rugi"; label: string; judul: string; bukti: string };
/** Two claims worth telling: the device mismatch with the largest tariff gap, the medical-record mismatch with the largest
 *  loss, else the largest losses (from different hospitals). */
export function pilihContoh(L: Laporan): Contoh[] {
  const antre = L.kasus.filter((k) => k.keputusan !== "DIBERSIHKAN");
  const rugi = (k: Kasus) => k.estimasi_kerugian_rp ?? 0;
  const out: Contoh[] = [];
  const iot = antre.filter((k) => k.iot?.hasil === "tidak_sesuai")
    .sort((a, b) => (b.iot?.tarif?.selisih_rp ?? 0) - (a.iot?.tarif?.selisih_rp ?? 0) || rugi(b) - rugi(a))[0];
  if (iot?.iot) {
    const aturan = L.iot?.aturan?.find((a) => a.aturan === iot.iot?.aturan)?.judul;
    out.push({ k: iot, jenis: "iot", label: "Dibuktikan sensor alat medis", judul: kapital(aturan ?? iot.iot.judul), bukti: iot.iot.judul });
  }
  const rme = antre.filter((k) => (k.temuan_aturan ?? []).some((t) => t.sumber === "rme") && k.id !== iot?.id).sort((a, b) => rugi(b) - rugi(a))[0];
  const t = rme?.temuan_aturan?.find((x) => x.sumber === "rme");
  if (rme && t) out.push({ k: rme, jenis: "rme", label: "Tidak cocok dengan rekam medis", judul: kapital(rmeAwam(t.kode, t.teks)), bukti: t.teks ?? rmeAwam(t.kode) });
  for (const k of [...antre].sort((a, b) => rugi(b) - rugi(a))) {
    if (out.length >= 2) break;
    if (out.some((c) => c.k.id === k.id || c.k.faskes === k.faskes) || !rugi(k)) continue;
    const h = k.agen?.hakim;
    out.push({ k, jenis: "rugi", label: "Estimasi kerugian terbesar", judul: kapital(k.tag_label ? modusAwam(k.tag_label) : k.keputusan_ai.alasan),
      bukti: h?.bukti || h?.alasan || k.keputusan_ai.alasan });
  }
  return out.slice(0, 2);
}

/** The story of a claim from its own fields, for when its explanation (the claim network's paragraph) is not loaded. */
function ceritaKasus(c: Contoh): string {
  const k = c.k;
  const apa = `${k.rs} menagih ${k.deskripsi.toLowerCase()}${k.dx_nama ? ` untuk pasien dengan ${k.dx_nama}` : ""} sebesar ${rupiah(k.biaya_rp)} (${tanggal(k.tgl)}).`;
  const bukti = c.jenis === "iot" ? `Catatan sensor alatnya menunjukkan: ${c.bukti.replace(/\.$/, "")}.`
    : c.jenis === "rme" ? `Rekam medis RS-nya menunjukkan: ${c.bukti.replace(/\.$/, "")}.`
    : `Bukti yang ditemukan: ${c.bukti.replace(/\.$/, "")}.`;
  const rugi = k.estimasi_kerugian_rp ? `Estimasi kerugian ${rupiah(k.estimasi_kerugian_rp)}${k.dasar_kerugian ? ` (${k.dasar_kerugian})` : ""}.` : "";
  return [apa, bukti, rugi, k.keputusan_ai.rekomendasi].filter(Boolean).join(" ");
}

/** A claim's explanation paragraph (testing/penjelasan_cabang.py) as a story: what was billed, the evidence, why it is a fraud
 *  sign, how the system decided. Its last parts (the gate's arithmetic for the rule-evidence lane, and how to read the claim
 *  network) belong to the opened case file, where the network and the technical tab are. */
const ceritaDariParagraf = (p: string) => p.split(/\s(?=Klaim ini masuk antrean lewat jalur|Di graph,)/)[0].trim();

// ---------------------------------------------------------------- pieces
const LABEL = "text-[11px] font-semibold uppercase tracking-[0.14em]";
const TAUTAN = "lp-no-print inline-flex items-center gap-1 text-[12.5px] font-medium text-[#b8a9ff] hover:text-white";
const B = ({ children }: { children: ReactNode }) => <b className="font-semibold text-white">{children}</b>;

function Seksi({ judul, sub, aksi, children }: { judul: string; sub?: ReactNode; aksi?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1.5">
        <div className="min-w-0 flex-[1_1_20rem]">
          <h2 className="text-[19px] font-semibold text-white">{judul}</h2>
          {sub && <p className="mt-0.5 text-[13px] leading-snug text-[#abb3bf]">{sub}</p>}
        </div>
        {aksi}
      </div>
      {children}
    </section>
  );
}

/** Ranked bars with the label above each (long plain labels wrap instead of being cut); the first is the one the sentence names. */
function BatangMini({ baris, format }: { baris: { label: string; nilai: number; title?: string }[]; format: (v: number) => string }) {
  const maks = Math.max(1e-9, ...baris.map((b) => b.nilai));
  return (
    <ul className="space-y-2">
      {baris.map((b, i) => (
        <li key={b.label} title={b.title}>
          <div className="flex items-baseline gap-2 text-[12.5px]">
            <span className={`min-w-0 flex-1 leading-snug ${i ? "text-[#c5cbd3]" : "font-medium text-white"}`}>{kapital(b.label)}</span>
            <span className={`shrink-0 tabular-nums ${i ? "text-[#abb3bf]" : "font-semibold text-white"}`}>{format(b.nilai)}</span>
          </div>
          <span className="mt-1 block h-1.5 rounded-full bg-[#2c333b]">
            <span className="block h-1.5 rounded-full" style={{ width: `${Math.max(2, (100 * b.nilai) / maks)}%`, background: i ? "#5b6573" : "#ec835a" }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function KartuTemuan({ label, warna, kalimat, visual, aksi }: { label: string; warna: string; kalimat: ReactNode; visual?: ReactNode; aksi?: { teks: string; f: () => void } }) {
  return (
    <article className="flex flex-col rounded-xl border border-white/[.08] bg-[#1c2127] p-4">
      <p className={LABEL} style={{ color: warna }}>{label}</p>
      <p className="mt-1.5 text-[15px] leading-snug text-[#e5e8eb]">{kalimat}</p>
      {visual && <div className="mt-3.5 flex-1">{visual}</div>}
      {aksi && <button onClick={aksi.f} className={`${TAUTAN} mt-3.5 self-start`}>{aksi.teks}<Icon name="right" className="h-3.5 w-3.5" /></button>}
    </article>
  );
}

/** The device checks as dots: every claim that billed a monitored device, the mismatches first (colour and mark). */
function TitikIot({ r }: { r: IotRingkas }) {
  const ts = HASIL_IOT.tidak_sesuai, ok = HASIL_IOT.sesuai, nb = HASIL_IOT.tanpa_bukti;
  const n = r.tidak_sesuai + r.sesuai + r.tanpa_bukti;
  const sel = (jumlah: number, w: string, key: string) => Array.from({ length: jumlah }, (_, i) => <span key={`${key}${i}`} className="h-2.5 w-2.5 rounded-[2px]" style={{ background: w }} />);
  return (
    <div>
      {n <= 160 ? (
        <div className="flex flex-wrap gap-[3px]" role="img" aria-label={`${r.tidak_sesuai} tidak sesuai, ${r.sesuai} sesuai, ${r.tanpa_bukti} tanpa bukti`}>
          {sel(r.tidak_sesuai, ts.warna, "t")}{sel(r.tanpa_bukti, nb.warna, "n")}{sel(r.sesuai, `${ok.warna}55`, "s")}
        </div>
      ) : (
        <div className="flex h-2.5 overflow-hidden rounded-full bg-[#2c333b]">
          <span style={{ width: `${(100 * r.tidak_sesuai) / Math.max(1, n)}%`, background: ts.warna }} />
          <span style={{ width: `${(100 * r.tanpa_bukti) / Math.max(1, n)}%`, background: nb.warna }} />
        </div>
      )}
      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-[#abb3bf]">
        <span style={{ color: ts.warna }}>{ts.tanda} {angka(r.tidak_sesuai)} tidak cocok</span>
        <span>{ok.tanda} {angka(r.sesuai)} cocok</span>
        {r.tanpa_bukti > 0 && <span>{nb.tanda} {angka(r.tanpa_bukti)} tanpa bukti</span>}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- the gist and the headline numbers (inside the report's cover)
export function RingkasInti({ R }: { R: Ringkas }) {
  const k = R.konsentrasi, kab = R.kab[0];
  const inti: ReactNode[] = [
    <>Sistem memeriksa <B>{angka(R.klaim)} klaim</B> senilai <B>{rupiah(R.nilaiTransaksi)}</B> dari {R.rs} rumah sakit di wilayah {R.kc}.</>,
    <><B>{angka(R.antre)} klaim</B> ({persen(R.persenAntre, 1)}) senilai {rupiah(R.nilaiAntre)} perlu dicek verifikator{R.tahan ? <>; {angka(R.tahan)} di antaranya ditahan dulu pembayarannya</> : null}.</>,
    R.rugi > 0
      ? <>Perkiraan kerugiannya <B>{rupiah(R.rugi)}</B>{k ? <>: {k.porsi >= 0.5 ? "lebih dari separuhnya" : "sebagian besar"} (<B>{persen(k.porsi)}</B>) ada di <B>{k.rs} RS</B></> : null}{kab ? <>{k ? ", dan " : ", "}{persen(kab.porsi)} di {kab.nama}</> : null}.</>
      : <>Laporan ini belum memuat estimasi kerugian.</>,
  ];
  const ubin: [string, ReactNode, string, string][] = [
    ["Klaim diperiksa", angka(R.klaim), `Semua klaim dari ${R.rs} RS, senilai ${rupiah(R.nilaiTransaksi)}.`, "#c5cbd3"],
    ["Perlu dicek verifikator", angka(R.antre), `${persen(R.persenAntre, 1)} dari semua klaim, senilai ${rupiah(R.nilaiAntre)}.`, "#f0c661"],
    ["Estimasi kerugian", rupiah(R.rugi), `Perkiraan kelebihan bayar (${persen(R.rugi / Math.max(1, R.nilaiTransaksi), 1)} nilai klaim), sebelum diverifikasi.`, "#ffb59a"],
    k ? ["RS prioritas", `${k.rs} RS`, `Menanggung ${persen(k.porsi)} estimasi kerugian; diaudit lebih dulu.`, "#ff8a8d"]
      : ["RS dengan klaim bermasalah", `${R.nRsAntre} RS`, `dari ${R.rs} RS di wilayah ini.`, "#ff8a8d"],
  ];
  return (
    <div className="mt-5 grid gap-6 @5xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div>
        <p className={`${LABEL} text-[#c9c0ff]`}>Intinya</p>
        <ol className="mt-2.5 space-y-3">
          {inti.map((s, i) => (
            <li key={i} className="flex gap-3 text-[17px] leading-snug text-[#e5e8eb] @3xl:text-[18px]">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#9d8cff]/20 text-[12px] font-semibold text-[#c9c0ff]">{i + 1}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3.5 text-[12.5px] leading-snug text-[#abb3bf]">
          Angka kerugian adalah perkiraan sebelum verifikasi, bukan kerugian yang sudah terbukti. Sistem hanya menandai klaim; keputusan tetap di tangan verifikator.
        </p>
      </div>
      <div className="grid content-start gap-3 @md:grid-cols-2 @3xl:grid-cols-4 @5xl:grid-cols-2">
        {ubin.map(([a, v, arti, w]) => (
          <div key={a} className="rounded-lg border border-white/[.08] bg-black/20 px-3.5 py-3" style={{ borderTop: `3px solid ${w}` }}>
            <p className="text-[12px] font-medium text-[#c5cbd3]">{a}</p>
            <p className="mt-0.5 text-[26px] font-semibold leading-tight tabular-nums text-white">{v}</p>
            <p className="mt-1 text-[12px] leading-snug text-[#abb3bf]">{arti}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the terms the report uses, one plain line each (both reading modes)
const ISTILAH: [string, string][] = [
  ["TAHAN (ditahan)", "Pembayaran klaim ditahan dulu karena tanda bahayanya sangat kuat; dibayar setelah diverifikasi."],
  ["PERIKSA", "Klaim perlu dicek dokumennya oleh verifikator sebelum diproses."],
  ["Box Karantina", "Daftar RS yang punya minimal satu tanda masalah, dikelompokkan A–Z menurut besar kerugiannya (A = terbesar)."],
  ["TSM", "Terstruktur, Sistematis, Masif: apakah masalah di RS itu terencana, berulang, dan besar."],
  ["Jalur RS", "Tindak lanjut untuk RS: ditindak (ketiga pola TSM ada), dibina (sebagian), dibebaskan (tidak ada)."],
  ["IoT alat medis", "Sensor arus di kabel alat (ventilator, mesin cuci darah) yang mencatat kapan dan berapa lama alat menyala; bukan data pasien."],
  ["Estimasi kerugian", "Perkiraan kelebihan bayar sebelum verifikasi; bukan kerugian yang sudah terbukti."],
  ["P1, P2, P3", "Urutan pengecekan: P1 paling mendesak (risiko dikali nilai tagihan terbesar)."],
];
export function IstilahSingkat() {
  return (
    <div className="@container">
      <dl className="grid gap-x-6 gap-y-3 rounded-xl border border-white/[.08] bg-[#1c2127] p-4 @2xl:grid-cols-2 @5xl:grid-cols-4">
        {ISTILAH.map(([t, a]) => (
          <div key={t}><dt className="text-[13px] font-semibold text-white">{t}</dt><dd className="mt-0.5 text-[12.5px] leading-snug text-[#abb3bf]">{a}</dd></div>
        ))}
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------- the rest of the page
type Aksi = { bukaBab: (bab: string) => void; bukaRS: (faskes: string) => void; bukaKlaim: (klaim: string) => void; bukaKerja: () => void; keLengkap: () => void };
const ARTI_JALUR: Record<JalurKey, string> = {
  ditindak: "Pola terstruktur, sistematis dan masif (TSM) terpenuhi. Teruskan ke Tim PK-JKN dan penegak hukum.",
  dibina: "Sebagian pola TSM terpenuhi. Pembinaan: perbaikan koding, pengembalian kelebihan bayar, sanksi administratif.",
  dibebaskan: "Tidak ada pola di tingkat RS. Klaimnya yang ditandai tetap dicek satu per satu.",
};
const TAMPIL_JALUR: Record<JalurKey, number> = { ditindak: 5, dibina: 4, dibebaskan: 0 };

export function RingkasanPimpinan({ R, contoh, aksi }: { R: Ringkas; contoh: (Contoh & { paragraf?: string })[]; aksi: Aksi }) {
  const temuan: ReactNode[] = [];
  const m = R.modus[0];
  if (m) temuan.push(
    <KartuTemuan key="modus" label="Modus dengan kerugian terbesar" warna="#ffb59a" aksi={{ teks: "Rincian kerugian", f: () => aksi.bukaBab("skala") }}
      kalimat={<><B>{kapital(m.label)}</B>: {rupiah(m.nilai)} dari {angka(m.klaim)} klaim{R.rugi ? ` (${persen(m.nilai / R.rugi)} estimasi kerugian)` : ""}.</>}
      visual={<BatangMini baris={R.modus.slice(0, 4).map((x) => ({ label: x.label, nilai: x.nilai, title: `${x.asli} · ${angka(x.klaim)} klaim` }))} format={rupiah} />} />);
  if (R.rsTop.length) {
    const k = R.konsentrasi;
    temuan.push(
      <KartuTemuan key="rs" label="RS dengan kerugian terbesar" warna="#ff8a8d" aksi={{ teks: "Semua RS prioritas", f: () => aksi.bukaBab("rs") }}
        kalimat={k ? <><B>{k.rs} dari {R.nRsAntre} RS</B> menanggung <B>{persen(k.porsi)}</B> estimasi kerugian. Tiga teratas:</> : <>Tiga RS dengan estimasi kerugian terbesar:</>}
        visual={
          <ul className="space-y-1">
            {R.rsTop.slice(0, 3).map((b) => (
              <li key={b.faskes_profil_id}>
                <button onClick={() => aksi.bukaRS(b.faskes_profil_id)} title="Buka berkas RS ini" className="w-full rounded-md px-1.5 py-1 text-left hover:bg-white/[.05]">
                  <span className="flex items-baseline gap-2 text-[12.5px]">
                    <span className="min-w-0 flex-1 leading-snug text-[#e5e8eb]">{b.nama}</span>
                    <span className="shrink-0 font-semibold tabular-nums text-white">{rupiah(b.estimasi_kerugian_rp)}</span>
                  </span>
                  <span className="mt-1 block h-1.5 rounded-full bg-[#2c333b]"><span className="block h-1.5 rounded-full bg-[#ec835a]" style={{ width: `${Math.max(2, 100 * b.porsi_kerugian)}%` }} /></span>
                </button>
              </li>
            ))}
          </ul>} />);
  }
  const kab = R.kab[0];
  if (kab) temuan.push(
    <KartuTemuan key="wilayah" label="Lokasi" warna="#7ea3ff" aksi={{ teks: "Peta wilayah", f: () => aksi.bukaBab("wilayah") }}
      kalimat={<><B>{kab.nama}</B> menanggung <B>{persen(kab.porsi)}</B> estimasi kerugian ({rupiah(kab.rugi)}).{R.kabRapat ? <> Paling rapat di <B>{R.kabRapat.nama}</B>: {angka(Math.round(R.kabRapat.per100))} dari 100 klaim perlu dicek.</> : null}</>}
      visual={<BatangMini baris={R.kab.slice(0, 4).map((x) => ({ label: x.nama, nilai: x.porsi, title: rupiah(x.rugi) }))} format={(v) => persen(v)} />} />);
  if (R.iot && R.iot.klaim_dengan_alat > 0) temuan.push(
    <KartuTemuan key="iot" label="Sensor alat medis (IoT)" warna="#2dd4bf" aksi={{ teks: "Bukti sensor", f: () => aksi.bukaBab("iot") }}
      kalimat={<><B>{angka(R.iot.tidak_sesuai)} dari {angka(R.iot.klaim_dengan_alat)}</B> klaim yang menagih pemakaian alat (ventilator, cuci darah, ICU) tidak cocok dengan catatan sensornya{R.iot.selisih_rp ? <>; selisih tarif <B>{rupiah(R.iot.selisih_rp)}</B></> : null}.</>}
      visual={<><TitikIot r={R.iot} />{R.iot.sintetis !== false && <p className="mt-1.5 text-[11px] text-[#8f99a8]">Data sensor masih sintetis (contoh).</p>}</>} />);
  if (R.rme) temuan.push(
    <KartuTemuan key="rme" label="Rekam medis RS" warna="#7ea3ff" aksi={{ teks: "Lihat berkas klaim", f: () => aksi.bukaBab("kasus") }}
      kalimat={<><B>{angka(R.rme.klaim)} dari {angka(R.antre)}</B> klaim yang perlu dicek tidak cocok dengan rekam medis RS; paling sering <B>{R.rme.jenis[0]?.label}</B>.</>}
      visual={<BatangMini baris={R.rme.jenis.slice(0, 3).map((x) => ({ label: x.label, nilai: x.klaim, title: x.kode }))} format={(v) => `${angka(v)} klaim`} />} />);
  if (R.andal && R.andal.total > 0) temuan.push(
    <KartuTemuan key="andal" label="Seberapa yakin" warna="#7ee2c0" aksi={{ teks: "Pemeriksaan silang", f: () => aksi.bukaBab("andal") }}
      kalimat={<><B>{angka(R.andal.lolos)} dari {angka(R.andal.total)}</B> klaim yang ditandai didukung lebih dari satu sumber bukti (aturan, tim agen AI, sensor alat), bukan skor model saja.</>}
      visual={
        <div title={R.andal.uji}>
          <span className="block h-2.5 rounded-full bg-[#2c333b]"><span className="block h-2.5 rounded-full bg-[#29a383]" style={{ width: `${(100 * R.andal.lolos) / R.andal.total}%` }} /></span>
          <p className="mt-1.5 text-[11.5px] text-[#abb3bf]">{persen(R.andal.lolos / R.andal.total)} punya bukti kedua. Tetap indikasi untuk diverifikasi, bukan putusan.</p>
        </div>} />);

  const p = R.prioritas;
  const keputusan: { siapa: string; apa: ReactNode; rinci: string }[] = [];
  if (R.jalur?.ditindak) keputusan.push({ siapa: "Kepala KC", apa: <>Teruskan {R.jalur.ditindak} RS jalur &ldquo;ditindak&rdquo; ke Tim PK-JKN dan penegak hukum</>, rinci: "beserta berkas buktinya." });
  if (p.P1.n) keputusan.push({ siapa: "Tim verifikator", apa: <>Cek {angka(p.P1.n)} klaim paling mendesak (P1) lebih dulu</>, rinci: `senilai ${rupiah(p.P1.rp)}; lalu ${angka(p.P2.n + p.P3.n)} klaim lainnya.` });
  if (R.tahan) keputusan.push({ siapa: "Keuangan", apa: <>Tahan pembayaran {angka(R.tahan)} klaim</>, rinci: "yang tandanya sangat kuat, sampai verifikasi selesai." });
  if (R.jalur?.dibina) keputusan.push({ siapa: "Kepala KC", apa: <>Bina {R.jalur.dibina} RS jalur &ldquo;dibina&rdquo;</>, rinci: "perbaikan koding, pengembalian kelebihan bayar, sanksi administratif." });

  return (
    <div className="@container mt-6 space-y-9">
      {temuan.length > 0 && (
        <Seksi judul="Temuan utama" sub="Apa yang paling menentukan besarnya kerugian di wilayah ini.">
          <div className="grid gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">{temuan}</div>
        </Seksi>
      )}

      {R.jalur && (
        <Seksi judul="RS yang perlu ditindak atau dibina" sub="Setiap RS dengan tanda masalah diberi jalur menurut polanya. Klik RS untuk membuka berkasnya."
          aksi={<button onClick={() => aksi.bukaBab("rs")} className={TAUTAN}>Tabel semua RS<Icon name="right" className="h-3.5 w-3.5" /></button>}>
          <div className="grid gap-3 @4xl:grid-cols-3">
            {JALUR_URUT.map((j) => {
              const w = JALUR[j].color, daftar = R.rsJalur[j], tampil = daftar.slice(0, TAMPIL_JALUR[j]), n = R.jalur?.[j] ?? 0;
              return (
                <div key={j} className="flex flex-col rounded-xl border border-white/[.08] bg-[#1c2127] p-4" style={{ borderTop: `3px solid ${w}` }}>
                  <p className="flex items-baseline gap-2"><span className="text-[16px] font-semibold" style={{ color: w }}>{JALUR[j].label}</span><span className="text-[22px] font-semibold tabular-nums text-white">{n} RS</span></p>
                  <p className="mt-1 text-[12.5px] leading-snug text-[#c5cbd3]">{ARTI_JALUR[j]}</p>
                  {tampil.length > 0 && (
                    <ul className="mt-2.5 space-y-0.5 border-t border-white/[.06] pt-2">
                      {tampil.map((b) => {
                        const a = alasanRS(b);
                        return (
                          <li key={b.faskes_profil_id}>
                            <button onClick={() => aksi.bukaRS(b.faskes_profil_id)} className="w-full rounded-md px-1.5 py-1.5 text-left hover:bg-white/[.05]">
                              <span className="flex items-baseline gap-2">
                                <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-white">{b.nama}</span>
                                <span className="shrink-0 text-[13px] tabular-nums text-[#ffb59a]">{rupiah(b.estimasi_kerugian_rp)}</span>
                              </span>
                              <span className="mt-0.5 block text-[12px] leading-snug text-[#abb3bf]" title={a.asli}>{b.rekomendasi} klaim perlu dicek · terutama {a.teks}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {j === "dibebaskan" && daftar.length > 0 && <p className="mt-2.5 border-t border-white/[.06] pt-2 text-[12px] text-[#abb3bf]">{daftar.length} di antaranya punya klaim yang tetap dicek satu per satu.</p>}
                  {daftar.length > tampil.length && j !== "dibebaskan" && (
                    <button onClick={() => aksi.bukaBab("kasus")} className={`${TAUTAN} mt-2 self-start`}>+{daftar.length - tampil.length} RS lainnya<Icon name="right" className="h-3.5 w-3.5" /></button>
                  )}
                </div>
              );
            })}
          </div>
        </Seksi>
      )}

      {contoh.length > 0 && (
        <Seksi judul="Contoh kasus" sub="Klaim yang ditandai, diceritakan dari buktinya. Setiap klaim yang ditandai punya berkas seperti ini.">
          <div className="grid gap-3 @4xl:grid-cols-2">
            {contoh.map((c, i) => (
              <article key={c.k.id} className="flex flex-col rounded-xl border border-white/[.08] bg-[#1c2127] p-4">
                <p className={`${LABEL} text-[#f0c661]`}>Contoh {i + 1} · {c.label}</p>
                <h3 className="mt-1.5 text-[16px] font-semibold leading-snug text-white">{c.judul}</h3>
                <p className="mt-2 flex-1 text-[13.5px] leading-relaxed text-[#d3d8de]">{c.paragraf ? ceritaDariParagraf(c.paragraf) : ceritaKasus(c)}</p>
                <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-white/[.06] pt-3 text-[12px] @lg:grid-cols-3">
                  <div><dt className="text-[#8f99a8]">Ditagih</dt><dd className="font-semibold tabular-nums text-white">{rupiah(c.k.biaya_rp)}</dd></div>
                  <div><dt className="text-[#8f99a8]">Estimasi kerugian</dt><dd className="font-semibold tabular-nums text-[#ffb59a]">{c.k.estimasi_kerugian_rp ? rupiah(c.k.estimasi_kerugian_rp) : "belum ditaksir"}</dd></div>
                  <div className="col-span-2 @lg:col-span-1"><dt className="text-[#8f99a8]">Rumah sakit</dt><dd className="leading-snug text-[#e5e8eb]">{c.k.rs}</dd></div>
                </dl>
                <button onClick={() => aksi.bukaKlaim(c.k.id)} className="lp-no-print mt-3 inline-flex items-center gap-1.5 self-start rounded-md border border-white/15 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-white/[.06]">
                  <Icon name="doc" className="h-3.5 w-3.5" />Buka berkas {c.k.id}</button>
              </article>
            ))}
          </div>
        </Seksi>
      )}

      {keputusan.length > 0 && (
        <Seksi judul="Yang perlu diputuskan" sub="Usulan tindak lanjut dari temuan ini; siapa yang menjalankannya adalah saran."
          aksi={<button onClick={aksi.bukaKerja} className={TAUTAN}>Dashboard keputusan<Icon name="right" className="h-3.5 w-3.5" /></button>}>
          <ol className="grid gap-3 @3xl:grid-cols-2">
            {keputusan.map((d, i) => (
              <li key={i} className="flex gap-3 rounded-xl border border-white/[.08] bg-[#1c2127] p-4">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-[13px] font-semibold text-white">{i + 1}</span>
                <div className="min-w-0">
                  <p className="text-[15px] leading-snug text-[#d3d8de]"><b className="font-semibold text-white">{d.apa}</b>, {d.rinci}</p>
                  <p className="mt-1 text-[12px] text-[#abb3bf]">Siapa: <span className="text-[#e5e8eb]">{d.siapa}</span></p>
                </div>
              </li>
            ))}
          </ol>
          <div className="rounded-xl border border-white/[.08] bg-black/20 px-4 py-3">
            <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-[#d3d8de]">
              <span className="font-medium text-white">Hasil verifikasi sejauh ini:</span>
              {angka(R.verif.sudah)} dari {angka(R.antre)} klaim sudah dicek
              {R.verif.sudah > 0 && <span className="text-[#abb3bf]">({R.verif.terbukti} terbukti bermasalah · {R.verif.sesuai} sesuai · {R.verif.investigasi} perlu investigasi)</span>}
            </p>
            <span className="mt-2 flex h-2 overflow-hidden rounded-full bg-[#2c333b]">
              {([["terbukti", "#e5484d"], ["investigasi", "#e0a02b"], ["sesuai", "#29a383"]] as const).map(([x, w]) => (
                <span key={x} style={{ width: `${(100 * R.verif[x]) / Math.max(1, R.antre)}%`, background: w }} />))}
            </span>
          </div>
        </Seksi>
      )}

      <Seksi judul="Istilah singkat"><IstilahSingkat /></Seksi>

      <div className="lp-no-print flex flex-wrap items-center gap-3 rounded-xl border border-[#9d8cff]/30 bg-[#9d8cff]/[.07] px-4 py-3.5">
        <p className="min-w-0 flex-1 text-[13.5px] text-[#d3d8de]">
          Ingin melihat semua grafik, bukti dan berkas? Laporan lengkap memuat {R.nBab} bab, {R.nExhibit} grafik, berkas {R.nRsAntre} RS dan setiap klaim yang ditandai.
        </p>
        <button onClick={aksi.keLengkap} className="inline-flex items-center gap-1.5 rounded-md bg-[#9d8cff] px-3.5 py-2 text-[13px] font-semibold text-[#14111f] hover:bg-[#b8a9ff]">
          Baca laporan lengkap<Icon name="right" className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
