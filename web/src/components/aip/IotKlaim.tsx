"use client";

// The IoT evidence of one claim in the AI Agent Swarm Branch case file (the user, 2026-11-15: "add also IoT tab in case the fraud
// is about medical device use time ... ≥ 96 hours and < 96 hours the claim value is far different", "show some IoT usage dashboard
// and time used vs time claimed", "IoT binding — device ID, patient ID and session"). A current clamp on the device's power cable
// (the device is never opened) records when the device is on, for how long, and its state read from the current draw: jalan
// (running), siaga (standby) or mati (off). It cannot tell how a patient is ventilated and measures nothing about the patient. Each
// attach-to-release session binds one device to one patient and one visit. The platform compares the device's longest
// uninterrupted "jalan" run with the procedure billed (96.72 = ventilation ≥ 96 consecutive hours) and anchors the readings on a
// hash chain before the claim is filed. An older block's ventilator modes (invasif / noninvasif / standby) are read as jalan /
// jalan / siaga. Laid out as a small dashboard for a
// verifier or an executive: the verdict, KPI tiles, used vs billed against the threshold, hours per day, the sessions by mode across
// the stay, the device-session-patient-claim binding, the tariff impact, the tamper-proof evidence, the verifier's steps.
// Data: the case's `iot` block (testing/iot_cabang.py); every field past the verdict is optional. Synthetic data.

import { useMemo, useState } from "react";

// ---------------------------------------------------------------- the contract
export type IotHasil = "tidak_sesuai" | "sesuai" | "tanpa_bukti";
export type IotAlat = { id: string; jenis?: string; nama?: string; sensor?: string; rs?: string; jam_nyala?: number; utilisasi_pct?: number };
/** a stretch of one device state (jalan / siaga / idle / nyala), read from the current draw */
export type IotSesiMode = { mulai: string; selesai: string; mode: string };
/** a binding session: one device attached to one patient for one visit, from attach to release */
export type IotIkatan = { sesi_id: string; device_id: string; peserta?: string | null; kunjungan?: string | null; mulai: string; selesai?: string | null;
  alasan_selesai?: string | null; masalah?: string | string[] | null };
export type IotHarian = { tanggal: string; jam_dipakai: number; jam_ditagih: number };
export type IotKasus = {
  hasil: IotHasil; aturan?: string; judul: string; alat?: IotAlat[]; rawat?: { masuk: string; pulang: string };
  ditagih?: { prosedur?: string; keterangan?: string; jam?: number; inacbg?: string; tarif_rp?: number };
  terukur?: { jam_total?: number; jam_berturut_maks?: number; mode_jam?: Record<string, number>; sesi?: IotSesiMode[] };
  ambang_jam?: number; tarif?: { ditagih_rp?: number; seharusnya_rp?: number; kode_seharusnya?: string; selisih_rp?: number };
  bukti?: { pembacaan?: number; merkle_root?: string; dijangkarkan?: string; klaim_diajukan?: string; rantai_ok?: boolean; catatan?: string };
  langkah?: string[]; sintetis?: boolean; harian?: IotHarian[];
  /** the binding sessions (device ↔ patient ↔ visit) and any binding problems the platform found */
  sesi?: IotIkatan[]; masalah_ikatan?: string[];
};
/** the branch report's IoT summary (L.iot, testing/laporan_cabang.py) */
export type IotRingkas = { rs_dengan_iot: number; alat: number; klaim_dengan_alat: number; sesuai: number; tidak_sesuai: number; tanpa_bukti: number; selisih_rp: number;
  aturan?: { aturan: string; judul: string; klaim: number; selisih_rp: number }[]; sintetis?: boolean };

/** the verdict as every screen shows it: a label, its colour and a mark, never the colour alone */
export const HASIL_IOT: Record<IotHasil, { label: string; warna: string; tanda: string }> = {
  tidak_sesuai: { label: "Tidak sesuai", warna: "#ff7d9c", tanda: "✕" },
  sesuai: { label: "Sesuai", warna: "#7ee2c0", tanda: "✓" },
  tanpa_bukti: { label: "Tanpa bukti", warna: "#8e9cad", tanda: "–" },
};
export const hasilIot = (h?: string) => HASIL_IOT[h as IotHasil] ?? HASIL_IOT.tanpa_bukti;

// the device states the clamp tells apart (running in blue, standby / idle in the neutral, off as the empty track)
const MODE: Record<string, { label: string; warna: string; pakai: boolean }> = {
  jalan: { label: "jalan", warna: "#3987e5", pakai: true },
  nyala: { label: "menyala", warna: "#3987e5", pakai: true },
  siaga: { label: "siaga", warna: "#5f6b7a", pakai: false },
  idle: { label: "diam (idle)", warna: "#5f6b7a", pakai: false },
  mati: { label: "mati", warna: "#202b38", pakai: false },
};
// other spellings, and an older block's ventilator modes: the clamp cannot tell a tube from a mask, so both read as running
const ALIAS_MODE: Record<string, string> = { invasif: "jalan", noninvasif: "jalan", running: "jalan", berjalan: "jalan", standby: "siaga", diam: "idle", menyala: "nyala" };
const kunciMode = (m: string) => { const k = m.toLowerCase().replace(/[^a-z]/g, ""); return ALIAS_MODE[k] ?? k; };
const modeDari = (m: string) => MODE[kunciMode(m)] ?? { label: m.replace(/_/g, " "), warna: "#7ea3ff", pakai: true };
const KLAIM = "#8e9cad", MERAH = "#ff7d9c", HIJAU = "#7ee2c0", AMBER = "#f2b35a", PASIEN = "#7ea3ff";
// the billed bars carry a texture as well as a colour, so billed and measured differ without colour
const GARIS_KLAIM = "repeating-linear-gradient(135deg, rgba(255,255,255,.22) 0 2px, transparent 2px 6px)";

// ---------------------------------------------------------------- numbers and times
const nf = (v: number) => v.toLocaleString("id-ID", { maximumFractionDigits: 1 });
const rupiah = (v: number) => `Rp ${Math.round(v).toLocaleString("id-ID")}`;
const POLA = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;
/** A timestamp as written ("2024-12-20T08:00", the hospital's local time) in hours, read the same in every time zone. */
function jamDari(s?: string | null): number | null {
  const m = s ? POLA.exec(s) : null;
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / 3.6e6 : null;
}
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const dua = (n: number) => String(n).padStart(2, "0");
function tgl(h: number, denganJam = true) {
  const d = new Date(Math.round(h * 60) * 60000);
  const t = `${d.getUTCDate()} ${BULAN[d.getUTCMonth()]}`;
  return denganJam ? `${t} ${dua(d.getUTCHours())}:${dua(d.getUTCMinutes())}` : t;
}
function lama(h: number) {
  const j = Math.round(h), hari = Math.floor(j / 24), sisa = j % 24;
  return hari ? `${hari} hari${sisa ? ` ${sisa} jam` : ""}` : `${nf(h)} jam`;
}
const pendekHash = (s: string) => (s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s);

// ---------------------------------------------------------------- the case, read once
type Rentang = { a: number; b: number };
type Ikat = IotIkatan & { a: number | null; b: number | null; milikIni: boolean; daftarMasalah: string[] };
type Olah = {
  ambang: number; masuk: number | null; pulang: number | null; lamaRawat: number | null;
  sesi: (Rentang & { mode: string })[]; perMode: [string, number][]; utama: string | null; run: Rentang | null;
  jamTotal: number; berturut: number; adaUkur: boolean; klaimPanjang: boolean; jamKlaim: number; klaimTeks: string; utilisasi: number | null;
  band: Rentang | null; domain: Rentang | null; hari: { h: number; dipakai: number; ditagih: number | null }[];
  ikatan: Ikat[]; pasien: string | null;
};
const tumpang = (x: Ikat, y: Ikat) => x.a != null && y.a != null && x.a < (y.b ?? Infinity) && y.a < (x.b ?? Infinity);

function olah(iot: IotKasus, klaimId?: string, klaimPeserta?: string): Olah {
  const ambang = iot.ambang_jam ?? 96;
  const masuk = jamDari(iot.rawat?.masuk), pulang = jamDari(iot.rawat?.pulang);
  const lamaRawat = masuk != null && pulang != null && pulang > masuk ? pulang - masuk : null;
  const sesi = (iot.terukur?.sesi ?? []).flatMap((s) => {
    const a = jamDari(s.mulai), b = jamDari(s.selesai);
    return a != null && b != null && b > a ? [{ a, b, mode: kunciMode(s.mode) }] : [];
  }).sort((x, y) => x.a - y.a);
  // hours per state: as the platform reports them, else summed from the sessions (older spellings merged into their state)
  const dariSesi: Record<string, number> = {};
  for (const s of sesi) dariSesi[s.mode] = (dariSesi[s.mode] ?? 0) + s.b - s.a;
  const mj = iot.terukur?.mode_jam;
  const dariPlatform: Record<string, number> = {};
  for (const [m, v] of Object.entries(mj ?? {})) dariPlatform[kunciMode(m)] = (dariPlatform[kunciMode(m)] ?? 0) + (v || 0);
  const perMode = Object.entries(Object.keys(dariPlatform).length ? dariPlatform : dariSesi).filter(([m, v]) => v > 0 && m !== "mati").sort((x, y) => y[1] - x[1]);
  // the state the billed procedure is about (running), else the working state the device was in longest
  const utama = [...sesi.map((s) => s.mode), ...perMode.map(([m]) => m)].find((m) => m === "jalan")
    ?? perMode.find(([m]) => modeDari(m).pakai)?.[0] ?? null;
  // its longest unbroken run (stretches that touch are one run)
  let run: Rentang | null = null, cur: Rentang | null = null;
  for (const s of sesi) {
    if (!utama || kunciMode(s.mode) !== kunciMode(utama)) { cur = null; continue; }
    if (cur && s.a - cur.b <= 1 / 60) cur.b = Math.max(cur.b, s.b);
    else cur = { a: s.a, b: s.b };
    if (!run || cur.b - cur.a > run.b - run.a) run = { ...cur };
  }
  // the measured total is the working time only: standby is not use (the user, 2026-11-16: "mode standby gausah dijadiin total
  // terukur"); the platform's jam_total (powered: running + standby) only for a block without hours per state
  const jamPakai = perMode.filter(([m]) => modeDari(m).pakai).reduce((t, [, v]) => t + v, 0);
  const jamTotal = perMode.length ? jamPakai : iot.terukur?.jam_total ?? 0;
  const berturut = iot.terukur?.jam_berturut_maks ?? (run ? run.b - run.a : 0);
  const adaUkur = sesi.length > 0 || jamTotal > 0;
  const j = iot.ditagih?.jam;
  const klaimPanjang = j == null || j >= ambang;
  const jamKlaim = j || ambang;
  const klaimTeks = j == null || j === 0 || j === ambang ? `${klaimPanjang ? "≥" : "<"} ${ambang} jam` : `${nf(j)} jam`;
  const alat = iot.alat ?? [];
  // the share of the stay the device worked (its standby hours are not use either)
  const utilisasi = lamaRawat ? (100 * jamTotal) / lamaRawat : alat.length === 1 && alat[0].utilisasi_pct != null && !perMode.length ? alat[0].utilisasi_pct : null;
  // where the billed run would have had to reach: from the start of the device's longest run (or admission), the threshold's length
  const awalBand = run?.a ?? masuk;
  const band = klaimPanjang && awalBand != null ? { a: awalBand, b: awalBand + ambang } : null;

  // the binding sessions, and what is wrong with them
  const mentah = (iot.sesi ?? []).map((s) => ({ ...s, a: jamDari(s.mulai), b: jamDari(s.selesai), milikIni: false, daftarMasalah: [] as string[] }));
  const hitung = new Map<string, number>();
  for (const s of mentah) if (s.peserta) hitung.set(s.peserta, (hitung.get(s.peserta) ?? 0) + 1);
  const pasien = mentah.find((s) => klaimId && s.kunjungan === klaimId && s.peserta)?.peserta
    ?? (klaimPeserta && hitung.has(klaimPeserta) ? klaimPeserta : null) ?? [...hitung].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  const ikatan: Ikat[] = mentah.map((s) => {
    const m = Array.isArray(s.masalah) ? [...s.masalah] : s.masalah ? [s.masalah] : [];
    if (!s.peserta) m.push("pembacaan tanpa pasien terikat");
    const lain = mentah.filter((o) => o !== s && o.device_id === s.device_id && o.peserta && s.peserta && o.peserta !== s.peserta && tumpang(s, o));
    if (lain.length) m.push(`alat yang sama terikat ke pasien ${[...new Set(lain.map((o) => o.peserta))].join(", ")} pada waktu yang tumpang tindih`);
    return { ...s, milikIni: !!s.peserta && s.peserta === pasien, daftarMasalah: [...new Set(m)] };
  });

  // the chart's span: the stay, every session, the threshold's reach
  const ujung = [masuk, pulang, ...sesi.flatMap((s) => [s.a, s.b]), band?.b ?? null, ...ikatan.flatMap((s) => [s.a, s.b])].filter((v): v is number => v != null);
  const domain = ujung.length > 1 && Math.max(...ujung) > Math.min(...ujung) ? { a: Math.min(...ujung), b: Math.max(...ujung) } : null;

  // hours per day: as the platform reports them, else the device's on-time per calendar day from the sessions (billed unknown)
  let hari: Olah["hari"] = [];
  if (iot.harian?.length) {
    hari = iot.harian.flatMap((x) => { const h = jamDari(x.tanggal); return h == null ? [] : [{ h, dipakai: x.jam_dipakai ?? 0, ditagih: x.jam_ditagih ?? null }]; });
  } else if (sesi.length) {
    const per = new Map<number, number>();
    for (const s of sesi) {
      if (!modeDari(s.mode).pakai) continue;
      for (let a = s.a; a < s.b;) { const h0 = Math.floor(a / 24) * 24, b = Math.min(s.b, h0 + 24); per.set(h0, (per.get(h0) ?? 0) + b - a); a = b; }
    }
    const d0 = Math.floor(Math.min(masuk ?? Infinity, sesi[0].a) / 24) * 24, d1 = Math.max(pulang ?? -Infinity, sesi[sesi.length - 1].b);
    for (let h = d0; h < d1 && hari.length < 62; h += 24) hari.push({ h, dipakai: per.get(h) ?? 0, ditagih: null });
  }
  return { ambang, masuk, pulang, lamaRawat, sesi, perMode, utama, run, jamTotal, berturut, adaUkur, klaimPanjang, jamKlaim, klaimTeks, utilisasi, band, domain, hari, ikatan, pasien };
}

// ---------------------------------------------------------------- pieces
const KARTU = "rounded-lg border border-white/[.08] bg-[#151a1f] p-3";
function Judul({ children, kanan }: { children: React.ReactNode; kanan?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#8e9cad]">{children}</p>
      {kanan && <span className="ml-auto text-[10.5px] tabular-nums text-[#8e9cad]">{kanan}</span>}
    </div>
  );
}
function Ubin({ judul, nilai, sub, warna }: { judul: string; nilai: React.ReactNode; sub?: React.ReactNode; warna?: string }) {
  return (
    <div className="rounded-lg border border-white/[.08] bg-[#151a1f] px-3 py-2.5" style={{ borderTop: `2px solid ${warna ?? "rgba(255,255,255,.12)"}` }}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8e9cad]">{judul}</p>
      <p className="mt-0.5 text-[20px] font-semibold leading-tight tabular-nums text-white">{nilai}</p>
      {sub && <p className="mt-0.5 text-[10.5px] leading-snug text-[#c3ccd7]">{sub}</p>}
    </div>
  );
}
function Contoh({ warna, garis, teks }: { warna: string; garis?: boolean; teks: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2.5 w-3 rounded-[2px]" style={{ background: warna, backgroundImage: garis ? GARIS_KLAIM : undefined }} />{teks}
    </span>
  );
}

/** Time used against time billed, on one hour scale with the threshold through every bar. */
function Bandingan({ iot, d }: { iot: IotKasus; d: Olah }) {
  const maks = Math.max(d.ambang, d.jamKlaim, d.jamTotal, d.berturut, 1) * 1.08;
  const x = (v: number) => Math.min(100, (100 * Math.max(0, v)) / maks);
  const xa = x(d.ambang);
  const trek = (isi: React.ReactNode) => (
    <div className="relative h-3.5 rounded-[3px] bg-[#202b38]">
      {isi}
      <span className="absolute -bottom-1 -top-1 border-l border-dashed border-white/80" style={{ left: `${xa}%` }} />
    </div>
  );
  const warnaUtama = d.utama ? modeDari(d.utama).warna : "#3987e5";
  const kerja = d.utama ? modeDari(d.utama).label : "menyala";
  const pakai = d.perMode.filter(([m]) => modeDari(m).pakai);
  const jumlahPakai = pakai.reduce((t, [, v]) => t + v, 0) || 1;
  const kode = iot.ditagih?.prosedur;
  const [kalimat, warna] = !d.adaUkur ? ["Tidak ada pembacaan alat yang cocok dengan masa rawat ini.", KLAIM]
    : d.klaimPanjang ? (d.berturut < d.ambang
      ? [`Alat ${kerja} paling lama ${nf(d.berturut)} jam tanpa putus: kurang ${nf(d.ambang - d.berturut)} jam dari syarat ≥ ${d.ambang} jam berturut-turut.`, MERAH]
      : [`Alat ${kerja} ${nf(d.berturut)} jam tanpa putus: memenuhi syarat ≥ ${d.ambang} jam berturut-turut.`, HIJAU])
    : d.berturut >= d.ambang ? [`Alat ${kerja} ${nf(d.berturut)} jam tanpa putus, lebih lama dari yang ditagih (${d.klaimTeks}).`, AMBER]
    : [`Alat ${kerja} ${nf(d.berturut)} jam tanpa putus: cocok dengan kode ${d.klaimTeks}.`, HIJAU];
  return (
    <section className={`${KARTU} space-y-2.5`} aria-label="Waktu dipakai dibanding waktu ditagih">
      <Judul kanan={<span className="flex gap-2.5"><Contoh warna={KLAIM} garis teks="ditagih" /><Contoh warna={warnaUtama} teks="terukur alat" /></span>}>Waktu dipakai vs waktu ditagih</Judul>
      <div className="relative h-3.5 text-[10px] text-[#e6ecf2]">
        <span className="absolute whitespace-nowrap" style={{ left: `${xa}%`, transform: xa > 70 ? "translateX(-100%)" : "translateX(-50%)" }}>ambang {d.ambang} jam</span>
      </div>
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
          <span className="text-[#c3ccd7]">Ditagih{kode ? ` · kode ${kode}` : ""}</span><b className="tabular-nums text-white">{d.klaimTeks}{d.klaimPanjang ? " berturut-turut" : ""}</b>
        </div>
        {trek(<div className="h-3.5 rounded-[3px]" style={{ width: `${x(d.jamKlaim)}%`, background: KLAIM, backgroundImage: GARIS_KLAIM, opacity: 0.85 }} />)}
      </div>
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
          <span className="text-[#c3ccd7]">Terukur · berturut-turut terpanjang{d.utama ? ` (${modeDari(d.utama).label})` : ""}</span><b className="tabular-nums text-white">{d.adaUkur ? `${nf(d.berturut)} jam` : "—"}</b>
        </div>
        {trek(<div className="h-3.5 rounded-[3px]" style={{ width: `${x(d.berturut)}%`, background: warnaUtama }} />)}
      </div>
      {Math.abs(d.jamTotal - d.berturut) >= 0.5 && <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
          <span className="text-[#c3ccd7]">Terukur · total {pakai.length ? pakai.map(([m]) => modeDari(m).label).join(" + ") : "menyala"}</span><b className="tabular-nums text-white">{d.adaUkur ? `${nf(d.jamTotal)} jam` : "—"}</b>
        </div>
        {trek(
          <div className="flex h-3.5 gap-[2px] overflow-hidden rounded-[3px]" style={{ width: `${x(d.jamTotal)}%` }}>
            {pakai.map(([m, v]) => <span key={m} className="h-full" title={`${modeDari(m).label}: ${nf(v)} jam`} style={{ width: `${(100 * v) / jumlahPakai}%`, background: modeDari(m).warna }} />)}
          </div>,
        )}
      </div>}
      <p className="text-[12px] font-medium leading-snug" style={{ color: warna }}>{kalimat}</p>
    </section>
  );
}

/** Hours used against hours billed, day by day across the stay. */
function Harian({ d }: { d: Olah }) {
  const kerja = d.utama ? modeDari(d.utama).label : "dipakai";
  const [tabel, setTabel] = useState(false);
  const [fokus, setFokus] = useState<number | null>(null);
  const hari = d.hari;
  const adaTagih = hari.some((x) => x.ditagih != null);
  const maks = Math.max(24, ...hari.flatMap((x) => [x.dipakai, x.ditagih ?? 0]));
  const sumbu = [0, 6, 12, 18, 24].filter((v) => v <= maks);
  const totPakai = hari.reduce((t, x) => t + x.dipakai, 0), totTagih = hari.reduce((t, x) => t + (x.ditagih ?? 0), 0);
  const tiap = hari.length > 10 ? Math.ceil(hari.length / 8) : 1;
  const f = fokus != null ? hari[fokus] : null;
  const tombol = (on: boolean) => `rounded-sm px-1.5 py-0.5 ${on ? "bg-white/10 text-white" : "text-[#8e9cad] hover:text-white"}`;
  return (
    <section className={`${KARTU} space-y-2`} aria-label="Jam dipakai dan jam ditagih per hari">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#8e9cad]">Jam per hari selama rawat</p>
        {hari.length > 0 && (
          <span className="lp-no-print ml-auto flex rounded border border-white/10 p-0.5 text-[10.5px]">
            <button onClick={() => setTabel(false)} className={tombol(!tabel)}>Grafik</button>
            <button onClick={() => setTabel(true)} className={tombol(tabel)}>Tabel</button>
          </span>
        )}
      </div>
      {!hari.length ? <p className="text-[11.5px] text-[#8e9cad]">Belum ada rincian per hari untuk klaim ini.</p> : tabel ? (
        <table className="w-full text-[11px] tabular-nums">
          <thead><tr className="text-[#8e9cad]"><th className="py-1 text-left font-normal">Tanggal</th><th className="py-1 text-right font-normal">Dipakai</th>
            {adaTagih && <><th className="py-1 text-right font-normal">Ditagih</th><th className="py-1 text-right font-normal">Selisih</th></>}</tr></thead>
          <tbody>
            {hari.map((x) => (
              <tr key={x.h} className="border-t border-white/[.05] text-[#e6ecf2]">
                <td className="py-1">{tgl(x.h, false)}</td><td className="py-1 text-right">{nf(x.dipakai)} jam</td>
                {adaTagih && <><td className="py-1 text-right">{x.ditagih == null ? "—" : `${nf(x.ditagih)} jam`}</td>
                  <td className="py-1 text-right" style={{ color: x.ditagih != null && x.ditagih - x.dipakai > 0.5 ? MERAH : undefined }}>{x.ditagih == null ? "—" : `${nf(x.ditagih - x.dipakai)} jam`}</td></>}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <p className="min-h-[16px] text-[11px] tabular-nums text-[#c3ccd7]">
            {f ? <><b className="text-white">{tgl(f.h, false)}</b> · dipakai {nf(f.dipakai)} jam{f.ditagih != null ? ` · ditagih ${nf(f.ditagih)} jam · selisih ${nf(f.ditagih - f.dipakai)} jam` : ""}</>
              : <>Total: dipakai {nf(totPakai)} jam{adaTagih ? ` · ditagih ${nf(totTagih)} jam` : ""} · {hari.length} hari</>}
          </p>
          <div className="relative h-[132px] pl-7" role="img" aria-label={`Jam alat dipakai${adaTagih ? " dan jam ditagih" : ""} per hari, ${hari.length} hari`}>
            {sumbu.map((v) => (
              <div key={v} className="absolute left-7 right-0 border-t border-white/[.06]" style={{ bottom: `${(100 * v) / maks}%` }}>
                <span className="absolute -left-7 -translate-y-1/2 text-[9.5px] tabular-nums text-[#8e9cad]">{v} j</span>
              </div>
            ))}
            <div className="absolute inset-y-0 left-7 right-0 flex items-end gap-[3px]" onPointerLeave={() => setFokus(null)}>
              {hari.map((x, i) => (
                <div key={x.h} tabIndex={0} onPointerEnter={() => setFokus(i)} onFocus={() => setFokus(i)} onBlur={() => setFokus(null)}
                  className={`flex h-full min-w-0 flex-1 items-end justify-center gap-[2px] rounded-sm outline-none ${fokus === i ? "bg-white/[.05]" : ""}`}>
                  {x.ditagih != null && <span className="w-[38%] max-w-[16px] rounded-t-[3px]" style={{ height: `${(100 * x.ditagih) / maks}%`, background: KLAIM, backgroundImage: GARIS_KLAIM, opacity: 0.85 }} />}
                  <span className="w-[38%] max-w-[16px] rounded-t-[3px]" style={{ height: `${Math.max(x.dipakai ? 1.5 : 0, (100 * x.dipakai) / maks)}%`, background: "#3987e5" }} />
                </div>
              ))}
            </div>
          </div>
          <div className="flex gap-[3px] pl-7">
            {hari.map((x, i) => <span key={x.h} className="min-w-0 flex-1 truncate text-center text-[9.5px] tabular-nums text-[#8e9cad]">{i % tiap ? "" : tgl(x.h, false)}</span>)}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-[#c3ccd7]">
            {adaTagih && <Contoh warna={KLAIM} garis teks="jam ditagih" />}<Contoh warna="#3987e5" teks={`jam alat ${kerja}`} />
            {!adaTagih && <span className="text-[#8e9cad]">jam ditagih per hari belum ada di data run ini</span>}
          </div>
        </>
      )}
    </section>
  );
}

/** The stay from admission to discharge: the device's stretches by mode, its longest run, the run the code needs, the bindings. */
function GarisWaktu({ iot, d }: { iot: IotKasus; d: Olah }) {
  const [fokus, setFokus] = useState<string | null>(null);
  const dm = d.domain;
  if (!dm) return null;
  const pos = (h: number) => (100 * (h - dm.a)) / (dm.b - dm.a);
  const lebar = (a: number, b: number) => Math.max(0.35, pos(b) - pos(a));
  const malam: number[] = [];
  for (let h = Math.ceil(dm.a / 24) * 24; h < dm.b; h += 24) malam.push(h);
  const tiap = malam.length > 7 ? Math.ceil(malam.length / 7) : 1;
  const kode = iot.ditagih?.prosedur;
  const ikat = d.ikatan.filter((s) => s.a != null);
  // overlapping bindings (the same device on two patients) each get their own row, so the overlap shows
  const lajurIkat = { ke: [] as number[], n: 1 };
  const ujungLajur: number[] = [];
  for (const i of ikat.map((_, j) => j).sort((x, y) => ikat[x].a! - ikat[y].a!)) {
    let l = ujungLajur.findIndex((e) => e <= ikat[i].a!);
    if (l < 0) { l = ujungLajur.length; ujungLajur.push(0); }
    ujungLajur[l] = ikat[i].b ?? Infinity;
    lajurIkat.ke[i] = l;
  }
  lajurIkat.n = Math.max(1, ujungLajur.length);
  const urut = (m: string) => { const i = Object.keys(MODE).indexOf(kunciMode(m)); return i < 0 ? 99 : i; };
  const modeAda = [...new Set(d.sesi.map((s) => kunciMode(s.mode)))].map((k) => d.sesi.find((s) => kunciMode(s.mode) === k)!.mode).sort((x, y) => urut(x) - urut(y));
  const baca = (() => {
    if (!fokus) return null;
    const [jenis, i] = fokus.split(":"), n = Number(i);
    if (jenis === "m") { const s = d.sesi[n]; return `Alat ${modeDari(s.mode).label} · ${tgl(s.a)} → ${tgl(s.b)} · ${nf(s.b - s.a)} jam`; }
    const s = ikat[n];
    return `Sesi ${s.sesi_id} · alat ${s.device_id} · pasien ${s.peserta || "tidak terikat"} · ${tgl(s.a!)} → ${s.b != null ? tgl(s.b) : "belum dilepas"}${s.daftarMasalah.length ? ` · ${s.daftarMasalah.join("; ")}` : ""}`;
  })();
  return (
    <section className={`${KARTU} space-y-1.5`} aria-label="Garis waktu pemakaian alat selama rawat">
      <Judul kanan={d.masuk != null && d.pulang != null ? `masuk ${tgl(d.masuk)} → pulang ${tgl(d.pulang)} · ${lama(d.pulang - d.masuk)}` : undefined}>Pemakaian alat sepanjang rawat</Judul>
      <div className="relative h-4 text-[10px] text-[#e6ecf2]">
        {d.band && <span className="absolute top-0.5 truncate" style={{ left: `${pos(d.band.a)}%`, maxWidth: `${Math.max(0, 100 - pos(d.band.a))}%` }}>
          syarat{kode ? ` kode ${kode}` : ""}: ≥ {d.ambang} jam berturut-turut</span>}
      </div>
      <div className="relative h-8" onPointerLeave={() => setFokus(null)}>
        {d.masuk != null && d.pulang != null && <div className="absolute inset-y-1 rounded-[3px] bg-[#202b38]" style={{ left: `${pos(d.masuk)}%`, width: `${lebar(d.masuk, d.pulang)}%` }} title="masa rawat" />}
        {d.pulang != null && dm.b > d.pulang && <div className="absolute inset-y-1 rounded-[3px]" title="setelah pulang"
          style={{ left: `${pos(d.pulang)}%`, width: `${lebar(d.pulang, dm.b)}%`, backgroundImage: "repeating-linear-gradient(135deg, rgba(255,255,255,.06) 0 2px, transparent 2px 6px)" }} />}
        {d.sesi.map((s, i) => (
          <div key={i} className="absolute inset-y-[7px] cursor-default rounded-[2px]" onPointerEnter={() => setFokus(`m:${i}`)} title={`${modeDari(s.mode).label} · ${tgl(s.a)} → ${tgl(s.b)} · ${nf(s.b - s.a)} jam`}
            style={{ left: `${pos(s.a)}%`, width: `${lebar(s.a, s.b)}%`, background: modeDari(s.mode).warna, opacity: fokus && fokus !== `m:${i}` ? 0.55 : 1 }} />
        ))}
        {d.run && (
          <div className="pointer-events-none absolute inset-y-[3px] flex items-center overflow-hidden rounded-[4px] border-2 border-white px-1.5" style={{ left: `${pos(d.run.a)}%`, width: `${lebar(d.run.a, d.run.b)}%` }}>
            <span className="truncate text-[10px] font-semibold text-white [text-shadow:0_0_3px_#000]">{nf(Math.abs(d.run.b - d.run.a - d.berturut) <= 1 ? d.berturut : d.run.b - d.run.a)} jam berturut-turut</span>
          </div>
        )}
        {d.band && <div className="pointer-events-none absolute inset-y-0 rounded-[5px] border border-dashed border-white/70" style={{ left: `${pos(d.band.a)}%`, width: `${lebar(d.band.a, d.band.b)}%` }} />}
        {[d.masuk, d.pulang].map((h, i) => h != null && <span key={i} className="pointer-events-none absolute -bottom-0.5 -top-0.5 w-px bg-[#e6ecf2]/70" style={{ left: `${pos(h)}%` }} />)}
      </div>
      {ikat.length > 0 && (
        <div>
          <p className="text-[9.5px] text-[#8e9cad]">sesi ikatan alat ke pasien</p>
          <div className="relative" style={{ height: 8 * lajurIkat.n }} onPointerLeave={() => setFokus(null)} aria-label="Sesi ikatan alat ke pasien">
            {ikat.map((s, i) => {
              const b = s.b ?? dm.b, buruk = s.daftarMasalah.length > 0;
              return <div key={s.sesi_id + i} className="absolute h-[5px] cursor-default rounded-full" onPointerEnter={() => setFokus(`i:${i}`)}
                title={`sesi ${s.sesi_id} · pasien ${s.peserta || "tidak terikat"}${buruk ? ` · ${s.daftarMasalah.join("; ")}` : ""}`}
                style={{ top: 8 * lajurIkat.ke[i] + 1.5, left: `${pos(s.a!)}%`, width: `${lebar(s.a!, b)}%`, background: !s.peserta ? MERAH : s.milikIni ? PASIEN : "#5f6b7a",
                  boxShadow: buruk ? `0 0 0 1.5px ${MERAH}` : undefined }} />;
            })}
          </div>
        </div>
      )}
      <div className="relative h-4">
        {malam.map((h, i) => {
          const p = pos(h);
          return (
            <span key={h} className="absolute top-0 h-1.5 w-px bg-white/25" style={{ left: `${p}%` }}>
              {i % tiap === 0 && <span className="absolute top-1.5 whitespace-nowrap text-[9.5px] tabular-nums text-[#8e9cad]"
                style={{ transform: p > 93 ? "translateX(-100%)" : p < 4 ? "none" : "translateX(-50%)" }}>{tgl(h, false)}</span>}
            </span>
          );
        })}
      </div>
      <p className="min-h-[16px] text-[11px] tabular-nums text-[#c3ccd7]">{baca ?? "Arahkan kursor ke potongan waktu untuk rinciannya."}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-[#c3ccd7]">
        {modeAda.map((m) => <Contoh key={m} warna={modeDari(m).warna} teks={`alat ${modeDari(m).label}`} />)}
        {d.sesi.length > 0 && <Contoh warna={MODE.mati.warna} teks="mati / tanpa arus" />}
        {d.run && <span className="flex items-center gap-1"><span className="h-2.5 w-3 rounded-[2px] border-2 border-white" />run terpanjang</span>}
        {d.band && <span className="flex items-center gap-1"><span className="h-2.5 w-3 rounded-[2px] border border-dashed border-white/80" />syarat ≥ {d.ambang} jam</span>}
        {ikat.length > 0 && <>
          <Contoh warna={PASIEN} teks="sesi pasien klaim ini" /><Contoh warna="#5f6b7a" teks="sesi pasien lain" /><Contoh warna={MERAH} teks="tanpa pasien" />
          <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-full" style={{ boxShadow: `0 0 0 1.5px ${MERAH}` }} />ikatan bermasalah</span></>}
        <span className="text-[#8e9cad]">jalan / siaga / mati dibaca dari besar arus listrik</span>
      </div>
    </section>
  );
}

function Mata({ cap, isi, warna, sub }: { cap: string; isi: React.ReactNode; warna: string; sub?: string }) {
  return (
    <span className="inline-flex min-w-0 flex-col rounded-md border px-2 py-1" style={{ borderColor: `${warna}66`, background: `${warna}14` }}>
      <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[#8e9cad]">{cap}</span>
      <span className="truncate text-[11.5px] font-medium tabular-nums text-white">{isi}</span>
      {sub && <span className="truncate text-[10px] tabular-nums text-[#c3ccd7]">{sub}</span>}
    </span>
  );
}
const ALASAN: Record<string, string> = { dilepas: "dilepas dari pasien", pasien_pulang: "pasien pulang", pulang: "pasien pulang", meninggal: "pasien meninggal", dipindah: "dipindah ke pasien lain" };

/** Which device was bound to which patient, when, for which visit, and what is wrong with a binding. */
function Ikatan({ iot, d, klaimId }: { iot: IotKasus; d: Olah; klaimId?: string }) {
  const xs = d.ikatan;
  const terikat = xs.filter((s) => s.milikIni || (klaimId && s.kunjungan === klaimId));
  const masalah = [...new Set([...(iot.masalah_ikatan ?? []), ...xs.flatMap((s) => s.daftarMasalah.map((m) => `${s.sesi_id}: ${m}`))])];
  const jenisAlat = (id: string) => iot.alat?.find((a) => a.id === id)?.jenis;
  return (
    <section className={`${KARTU} space-y-2.5`} aria-label="Ikatan alat, sesi, pasien dan klaim">
      <Judul kanan={`${xs.length} sesi · ${masalah.length ? `${masalah.length} masalah ikatan` : "ikatan utuh"}`}>Ikatan alat ↔ sesi ↔ pasien ↔ klaim</Judul>
      {terikat.slice(0, 3).map((s, i) => (
        <div key={`${s.sesi_id}-${i}`} className="flex flex-wrap items-center gap-1.5">
          <Mata cap="alat" isi={s.device_id} sub={jenisAlat(s.device_id)} warna="#3987e5" />
          <span className="text-[#8e9cad]" aria-hidden="true">↔</span>
          <Mata cap="sesi" isi={s.sesi_id} sub={s.a != null ? `${tgl(s.a)} → ${s.b != null ? tgl(s.b) : "belum dilepas"}` : s.mulai} warna="#8e9cad" />
          <span className="text-[#8e9cad]" aria-hidden="true">↔</span>
          <Mata cap="pasien" isi={s.peserta || "tidak terikat"} warna={s.peserta ? PASIEN : MERAH} />
          <span className="text-[#8e9cad]" aria-hidden="true">↔</span>
          <Mata cap="klaim" isi={klaimId ?? "klaim ini"} sub={s.kunjungan && s.kunjungan !== klaimId ? `kunjungan ${s.kunjungan}` : undefined} warna={s.daftarMasalah.length ? MERAH : HIJAU} />
          {s.daftarMasalah.length ? <span className="text-[11px] font-medium text-[#ff9db3]">✕ bermasalah</span> : <span className="text-[11px] font-medium text-[#7ee2c0]">✓ terikat</span>}
        </div>
      ))}
      {!terikat.length && <p className="text-[11.5px] text-[#ff9db3]">✕ Tidak ada sesi alat yang terikat ke pasien klaim ini.</p>}
      {masalah.length > 0 && (
        <ul className="space-y-1 rounded-md border border-[#ff7d9c]/30 bg-[#ff7d9c]/[.06] px-2.5 py-1.5">
          {masalah.slice(0, 6).map((m) => <li key={m} className="flex gap-1.5 text-[11.5px] leading-snug text-[#ffd1dc]"><span aria-hidden="true">✕</span>{m}</li>)}
        </ul>
      )}
      <ul className="divide-y divide-white/[.05] text-[11px]">
        {xs.map((s, i) => {
          const ok = !s.daftarMasalah.length;
          return (
            <li key={`${s.sesi_id}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5">
              <b className="font-mono text-[10.5px] text-white">{s.sesi_id}</b>
              <span className="rounded bg-[#3987e5]/15 px-1.5 font-mono text-[10.5px] text-[#a9c8f5]">{s.device_id}</span>
              <span className="text-[#c3ccd7]">pasien <b className={s.peserta ? "text-white" : "text-[#ff9db3]"}>{s.peserta || "tidak terikat"}</b>{s.milikIni ? " (pasien klaim ini)" : ""}</span>
              {s.kunjungan && <span className="text-[#8e9cad]">kunjungan {s.kunjungan}</span>}
              <span className="tabular-nums text-[#c3ccd7]">{s.a != null ? tgl(s.a) : s.mulai} → {s.b != null ? tgl(s.b) : "belum dilepas"}{s.a != null && s.b != null ? ` · terpasang ${nf(s.b - s.a)} jam` : ""}</span>
              {s.alasan_selesai && <span className="text-[#8e9cad]">selesai: {ALASAN[s.alasan_selesai] ?? s.alasan_selesai.replace(/_/g, " ")}</span>}
              <span className="ml-auto text-[10.5px] font-medium" style={{ color: ok ? (s.milikIni ? HIJAU : KLAIM) : MERAH }}>{ok ? (s.milikIni ? "✓ ikatan utuh" : "pasien lain") : "✕ bermasalah"}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Tarif({ iot }: { iot: IotKasus }) {
  const t = iot.tarif, dt = iot.ditagih;
  const ditagih = t?.ditagih_rp ?? dt?.tarif_rp;
  if (ditagih == null && t?.seharusnya_rp == null) return null;
  const selisih = t?.selisih_rp ?? (ditagih != null && t?.seharusnya_rp != null ? ditagih - t.seharusnya_rp : null);
  const kode = [dt?.prosedur, dt?.inacbg].filter(Boolean).join(" · ");
  return (
    <section className={`${KARTU} space-y-2`} aria-label="Dampak tarif">
      <Judul>Dampak tarif</Judul>
      <div className="space-y-1.5">
        <div className="rounded-md border border-white/[.08] px-2.5 py-1.5">
          <p className="text-[10.5px] text-[#8e9cad]">Tarif ditagih{kode ? ` · ${kode}` : ""}</p>
          <p className="text-[15px] font-semibold tabular-nums text-white">{ditagih != null ? rupiah(ditagih) : "—"}</p>
        </div>
        <p className="pl-3 text-[11px] text-[#8e9cad]" aria-hidden="true">↓ menurut pemakaian alat</p>
        <div className="rounded-md border border-white/[.08] px-2.5 py-1.5">
          <p className="text-[10.5px] text-[#8e9cad]">Tarif sesuai IoT{t?.kode_seharusnya ? ` · ${t.kode_seharusnya}` : ""}</p>
          <p className="text-[15px] font-semibold tabular-nums text-white">{t?.seharusnya_rp != null ? rupiah(t.seharusnya_rp) : "—"}</p>
        </div>
        <div className="rounded-md border px-2.5 py-1.5" style={{ borderColor: selisih ? `${MERAH}66` : "rgba(255,255,255,.08)", background: selisih ? `${MERAH}12` : undefined }}>
          <p className="text-[10.5px] text-[#8e9cad]">Selisih</p>
          <p className="text-[17px] font-semibold tabular-nums" style={{ color: selisih ? "#ff9db3" : "#ffffff" }}>{selisih ? rupiah(selisih) : "tidak ada selisih"}</p>
          {selisih ? <p className="text-[10.5px] text-[#c3ccd7]">potensi kelebihan bayar bila terbukti</p> : null}
        </div>
      </div>
    </section>
  );
}

function Bukti({ iot }: { iot: IotKasus }) {
  const [salin, setSalin] = useState(false);
  const b = iot.bukti;
  if (!b) return null;
  const root = b.merkle_root ?? "";
  const a = jamDari(b.dijangkarkan), k = jamDari(b.klaim_diajukan);
  const jeda = a != null && k != null ? k - a : null;
  const salinRoot = () => {
    navigator.clipboard?.writeText(root).then(() => { setSalin(true); setTimeout(() => setSalin(false), 1500); }, () => {});
  };
  return (
    <section className={`${KARTU} space-y-2`} aria-label="Bukti tak bisa diubah">
      <Judul kanan={b.rantai_ok == null ? undefined : <span className="font-semibold" style={{ color: b.rantai_ok ? HIJAU : MERAH }}>{b.rantai_ok ? "✓ rantai hash utuh" : "✕ rantai hash rusak"}</span>}>
        Bukti tak bisa diubah (blockchain)</Judul>
      {b.pembacaan != null && <p className="text-[12px] text-[#e6ecf2]"><b className="text-[15px] tabular-nums text-white">{b.pembacaan.toLocaleString("id-ID")}</b> pembacaan sensor clamp dicatat</p>}
      {root && (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-[#8e9cad]">Merkle root</span>
          <code className="min-w-0 truncate rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10.5px] text-[#c3ccd7]" title={root}>{pendekHash(root)}</code>
          <button onClick={salinRoot} className="lp-no-print rounded border border-white/15 px-1.5 py-0.5 text-[10.5px] text-white hover:bg-white/5">{salin ? "tersalin" : "salin"}</button>
        </div>
      )}
      {(a != null || k != null) && (
        <div className="space-y-1">
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 text-[10.5px] tabular-nums">
            <span className="text-[#c3ccd7]">dijangkarkan<br /><b className="text-white">{a != null ? tgl(a) : "—"}</b></span>
            <span className="relative h-px bg-white/25"><span className="absolute -top-[3px] left-0 h-[7px] w-[7px] rounded-full bg-[#3987e5]" /><span className="absolute -top-[3px] right-0 h-[7px] w-[7px] rounded-full bg-[#8e9cad]" /></span>
            <span className="text-right text-[#c3ccd7]">klaim diajukan<br /><b className="text-white">{k != null ? tgl(k) : "—"}</b></span>
          </div>
          {jeda != null && (
            <p className="text-[11px] leading-snug" style={{ color: jeda >= 0 ? HIJAU : AMBER }}>
              {jeda >= 0 ? `✓ Bukti tercatat ${lama(jeda)} sebelum klaim diajukan: tidak bisa disesuaikan dengan klaim.` : `⚠ Bukti dijangkarkan ${lama(-jeda)} setelah klaim diajukan: periksa urutannya.`}
            </p>
          )}
        </div>
      )}
      {b.catatan && <p className="text-[10.5px] leading-snug text-[#8e9cad]">{b.catatan}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- the tab
export function IotKlaim({ iot, klaim }: { iot: IotKasus; klaim?: { id: string; peserta?: string } }) {
  const kid = klaim?.id, kps = klaim?.peserta;
  const d = useMemo(() => olah(iot, kid, kps), [iot, kid, kps]);
  const h = hasilIot(iot.hasil);
  const alat = iot.alat ?? [];
  const modeDom = d.perMode.find(([m]) => modeDari(m).pakai);
  const selisihJam = d.jamKlaim - d.berturut;
  // the working states only: standby is not shown as use
  const pakaiMode = d.perMode.filter(([m]) => modeDari(m).pakai);
  const kerja = d.utama ? modeDari(d.utama).label : "menyala";
  // the device the claim's hours are measured on (it has running / standby states): its chip says how long it ran, not how long it was on
  const adaSiaga = d.perMode.some(([m]) => !modeDari(m).pakai);
  const diukur = (a: IotAlat) => adaSiaga && /ventilator|dialis|hemodial|\bhd\b/i.test(`${a.jenis ?? ""} ${a.nama ?? ""}`);
  return (
    <div className="space-y-3">
      {/* the verdict */}
      <div className="flex flex-wrap items-start gap-3">
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] font-semibold" style={{ background: `${h.warna}22`, color: h.warna, boxShadow: `inset 0 0 0 1px ${h.warna}66` }}>
          <span aria-hidden="true">{h.tanda}</span>{h.label}</span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-snug text-white">{iot.judul}</p>
          <p className="mt-0.5 text-[11px] text-[#8e9cad]">
            {iot.ditagih?.prosedur ? `Ditagih kode ${iot.ditagih.prosedur}${iot.ditagih.keterangan ? `: ${iot.ditagih.keterangan}` : ""}` : "Klaim dengan alat medis"}
            {iot.aturan ? <> · aturan <span className="font-mono">{iot.aturan}</span></> : null}
          </p>
          <p className="mt-0.5 text-[11px] text-[#c3ccd7]">Sensor clamp pada kabel daya (tanpa membuka alat): mencatat kapan alat jalan, siaga atau mati, dan berapa lama. Tidak mengukur kondisi pasien.</p>
        </div>
        {iot.sintetis !== false && <span className="rounded border border-dashed border-amber-300/50 px-1.5 py-0.5 text-[10.5px] text-amber-200">data IoT sintetis</span>}
      </div>
      {alat.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {alat.map((a) => (
            <div key={a.id} className="min-w-0 max-w-full rounded-md border border-[#3987e5]/40 bg-[#3987e5]/[.08] px-2.5 py-1.5">
              <p className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                <b className="text-white">{a.nama ?? a.jenis ?? "Alat"}</b>
                {a.jenis && a.nama && <span className="text-[#c3ccd7]">{a.jenis}</span>}
                <span className="rounded bg-black/30 px-1 font-mono text-[10.5px] text-[#a9c8f5]">{a.id}</span>
              </p>
              <p className="text-[10.5px] text-[#c3ccd7]">{a.sensor ?? "sensor clamp pada kabel daya (tanpa membuka alat)"}</p>
              {diukur(a) ? (
                <p className="text-[10.5px] tabular-nums text-[#8e9cad]">{kerja} {nf(d.jamTotal)} jam{d.utilisasi != null ? ` · utilisasi ${nf(d.utilisasi)}%` : ""}</p>
              ) : (a.jam_nyala != null || a.utilisasi_pct != null) && (
                <p className="text-[10.5px] tabular-nums text-[#8e9cad]">{[a.jam_nyala != null ? `menyala ${nf(a.jam_nyala)} jam` : "", a.utilisasi_pct != null ? `utilisasi ${nf(a.utilisasi_pct)}%` : ""].filter(Boolean).join(" · ")}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* the dashboard */}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Ubin judul="Jam dipakai vs ditagih" nilai={d.adaUkur ? `${nf(d.berturut)} vs ${d.klaimTeks}` : `— vs ${d.klaimTeks}`} warna={h.warna}
          sub={d.adaUkur ? `berturut-turut terpanjang${Math.abs(d.jamTotal - d.berturut) >= 0.5 ? ` · total ${kerja} ${nf(d.jamTotal)} jam` : ""}` : "tidak ada pembacaan alat"} />
        <Ubin judul="Selisih jam" nilai={d.adaUkur ? `${nf(Math.abs(selisihJam))} jam` : "—"} warna={d.adaUkur && d.klaimPanjang && d.berturut < d.ambang ? MERAH : undefined}
          sub={!d.adaUkur ? undefined : d.klaimPanjang
            ? (d.berturut < d.ambang ? `alat kurang ${nf(d.ambang - d.berturut)} jam dari syarat ≥ ${d.ambang} jam` : `syarat ≥ ${d.ambang} jam terpenuhi`)
            : (selisihJam < 0 ? `alat menyala lebih lama dari yang ditagih` : `dalam batas kode yang ditagih`)} />
        <Ubin judul="Utilisasi alat" nilai={d.utilisasi != null ? `${nf(d.utilisasi)}%` : "—"}
          sub={d.lamaRawat ? `${kerja} ${nf(d.jamTotal)} dari ${nf(d.lamaRawat)} jam masa rawat` : "dari masa rawat"} />
        <Ubin judul="Status alat" nilai={modeDom ? modeDari(modeDom[0]).label : d.perMode.length ? modeDari(d.perMode[0][0]).label : "—"}
          sub={pakaiMode.length ? `${pakaiMode.map(([m, v]) => `${modeDari(m).label} ${nf(v)} jam`).join(" · ")} · dari besar arus` : undefined} />
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Bandingan iot={iot} d={d} />
        <Harian d={d} />
      </div>
      <GarisWaktu iot={iot} d={d} />
      {d.ikatan.length > 0 && <Ikatan iot={iot} d={d} klaimId={kid} />}
      <div className="grid gap-3 lg:grid-cols-3">
        <Tarif iot={iot} />
        <Bukti iot={iot} />
        {iot.langkah?.length ? (
          <section className={`${KARTU} space-y-1.5`}>
            <Judul>Langkah verifikasi</Judul>
            <ol className="space-y-1.5">
              {iot.langkah.map((l, i) => (
                <li key={l} className="flex gap-2 text-[12px] leading-snug text-[#e6ecf2]">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#1b2741] text-[10px] text-[#7ea3ff]">{i + 1}</span>{l}</li>))}
            </ol>
          </section>
        ) : null}
      </div>
      {iot.sintetis !== false && (
        <p className="text-[10.5px] text-[#8e9cad]">Data IoT sintetis: alat, sensor, sesi dan pembacaan dibuat untuk demonstrasi; belum ada sensor yang terpasang di RS.</p>
      )}
    </div>
  );
}
