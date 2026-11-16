"use client";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { GRID, SURFACE, Tooltip, compact, num, useTip, type Tip } from "@/components/aip/viz";

/* IoT Monitoring (the user, 2026-11-15: "generate some synthetic data for several case and create dashboard of it on IoT
   Monitoring tabs"): the medical devices of one branch office's hospitals, seen through a current clamp on each device's power
   cable (the device is never opened). The clamp reports only when a device is on, for how long and in which state (ventilator
   jalan / siaga / mati, hemodialysis jalan / idle, ICU bed or monitor nyala / mati, infusion pump jalan / idle): no vital signs,
   and no way to tell how a patient is ventilated (an older file's ventilator modes invasif / noninvasif / standby read as jalan /
   jalan / siaga). Each use is bound device <-> masked patient <-> visit/claim, and the readings of an episode are anchored as one
   Merkle root on a tamper-proof log before the claim. The dashboard reads data/aip/cabang/iot/<run>/monitoring.json through
   /api/iot-monitoring (synthetic data); every field may be missing and every list may be empty. */

// ------------------------------------------------------------------------------------------------ data contract

type ModeJam = Record<string, number>;
type Harian = { tanggal?: string; jam?: number; mode_jam?: ModeJam };
type Alat = {
  id: string; jenis?: string; nama?: string; rs_id?: string; rs?: string; status?: string; jam_nyala?: number; utilisasi_pct?: number;
  sesi?: number; terakhir?: string; kunci_dicabut?: boolean; dicabut_pada?: string | null; mode_jam?: ModeJam; harian?: Harian[];
};
type Jangkar = { status?: string; root?: string; waktu?: string; tx?: string };
type Sesi = {
  sesi_id: string; device_id?: string; jenis?: string; peserta?: string | null; kunjungan?: string | null; klaim_id?: string | null; mulai?: string; selesai?: string;
  alasan_selesai?: string; jam?: number; mode_jam?: ModeJam; jam_ditagih?: number | null; hasil?: string; kode?: string | null; selisih_rp?: number;
  jangkar?: Jangkar | null;
};
type Peringatan = {
  waktu?: string; jenis?: string; device_id?: string | null; klaim_id?: string | null; sesi_id?: string | null; rs?: string; judul?: string;
  selisih_rp?: number; mulai?: string; selesai?: string; peserta?: string | null;
};
type RsRow = { id: string; nama?: string; kabkota?: string; alat?: number; jam?: number; utilisasi_pct?: number; tidak_sesuai?: number; selisih_rp?: number };
type JenisRow = { jenis: string; nama?: string; alat?: number; jam?: number; utilisasi_pct?: number };
type Ringkas = {
  rs: number; alat: number; alat_aktif: number; sesi: number; jam_total: number; klaim_dengan_alat: number; sesuai: number; tidak_sesuai: number;
  tanpa_bukti: number; selisih_rp: number; jangkar: number | null; jangkar_ok: number | null;
};
type Rentang = { mulai?: string; akhir?: string };
// periode: the claims' period; jendela: the span of the readings, which may run past it (a stay that ends after the period)
type Kepala = { run?: string; kc?: { id?: string; nama?: string }; periode?: Rentang; jendela?: Rentang; sintetis?: boolean };
type Monitoring = Kepala & { ringkas?: Partial<Record<keyof Ringkas, unknown>>; jenis_alat: JenisRow[]; rs: RsRow[]; alat: Alat[]; sesi: Sesi[]; peringatan: Peringatan[] };
type RunInfo = Kepala & { id: string; diubah?: string };
type Pilih = { kind: "alat" | "sesi"; id: string };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
function daftar<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as T[]) : [];
}
const teks = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined);

function kepala(raw: unknown): Kepala {
  const m = obj(raw), kc = obj(m.kc), p = obj(m.periode), j = obj(m.jendela);
  return {
    run: teks(m.run), kc: { id: teks(kc.id), nama: teks(kc.nama) }, periode: { mulai: teks(p.mulai), akhir: teks(p.akhir) },
    jendela: { mulai: teks(j.mulai), akhir: teks(j.akhir) }, sintetis: m.sintetis === true,
  };
}

/** monitoring.json as the screen can trust it: lists are lists, rows have their key. */
function norm(raw: unknown): Monitoring {
  const m = obj(raw);
  const sesi = daftar<Sesi>(m.sesi).map((s, i) => ({ ...s, sesi_id: teks(s.sesi_id) ?? `${s.device_id ?? "sesi"}#${i + 1}` }));
  const unik = new Set<string>();
  return {
    ...kepala(raw),
    ringkas: obj(m.ringkas),
    jenis_alat: daftar<JenisRow>(m.jenis_alat).filter((j) => teks(j.jenis)),
    rs: daftar<RsRow>(m.rs).filter((r) => teks(r.id)),
    alat: daftar<Alat>(m.alat).filter((a) => teks(a.id) && !unik.has(a.id) && unik.add(a.id)),
    sesi: sesi.filter((s) => !unik.has(`sesi:${s.sesi_id}`) && unik.add(`sesi:${s.sesi_id}`)),
    peringatan: daftar<Peringatan>(m.peringatan),
  };
}

// ------------------------------------------------------------------------------------------------ vocabulary & colour

const panel = "rounded-lg border border-white/[.07] bg-[#1c2127]";
const BAD = "#f87171";
const WARN = "#fbbf24";
const OK = "#34d399";
const LEDGER = "#a78bfa";
const UKUR = "#3987e5"; // hours measured by the sensor (the app's first series hue)
const TAGIH_INK = "#e5e8eb"; // hours billed in the claim: a hollow ring in ink, so the measured mark stays the only fill
const BATAS_VENT = 96; // ICD-9-CM 96.72: continuous mechanical ventilation for 96 consecutive hours or more

// one colour per device state, the same in every panel (running green, standby / idle grey, off dark); every state also carries
// its name in legends and tooltips
const MODE: Record<string, { label: string; color: string; order: number; aktif: boolean }> = {
  jalan: { label: "Jalan", color: "#199e70", order: 0, aktif: true },
  nyala: { label: "Nyala", color: "#199e70", order: 1, aktif: true },
  siaga: { label: "Siaga", color: "#6b7684", order: 2, aktif: false },
  idle: { label: "Idle", color: "#6b7684", order: 3, aktif: false },
  mati: { label: "Mati", color: "#3b444e", order: 4, aktif: false },
};
// an older file's ventilator modes: the clamp cannot tell a tube from a mask, so both read as running; standby is siaga
const ALIAS_MODE: Record<string, string> = { invasif: "jalan", noninvasif: "jalan", non_invasif: "jalan", standby: "siaga" };
const kunciMode = (k: string) => ALIAS_MODE[k] ?? k;
const modeInfo = (k: string) => MODE[kunciMode(k)] ?? { label: k.replace(/_/g, " "), color: "#5b8fd1", order: 9, aktif: true };

const STATUS_ALAT: Record<string, { label: string; color: string; isi: boolean }> = {
  dipakai: { label: "Dipakai", color: OK, isi: true },
  siaga: { label: "Siaga", color: "#8abbff", isi: true },
  mati: { label: "Mati", color: "#8f99a8", isi: false },
  offline: { label: "Offline", color: WARN, isi: false },
};
const statusInfo = (s?: string) => STATUS_ALAT[s ?? ""] ?? { label: s ? s.replace(/_/g, " ") : "Tidak diketahui", color: "#6b7684", isi: false };

const HASIL: Record<string, { label: string; color: string }> = {
  sesuai: { label: "Sesuai", color: OK },
  tidak_sesuai: { label: "Tidak sesuai", color: BAD },
  tanpa_bukti: { label: "Tanpa bukti alat", color: WARN },
  tanpa_klaim: { label: "Belum ada klaim", color: "#8f99a8" },
};
const hasilInfo = (h?: string) => HASIL[h ?? ""] ?? { label: h ? h.replace(/_/g, " ") : "—", color: "#8f99a8" };

const PERINGATAN: Record<string, { label: string; icon: IconName; color: string; kalimat: string }> = {
  "iot.tidak_sesuai": { label: "Jam tidak sesuai klaim", icon: "alert", color: BAD, kalimat: "Jam yang ditagih lebih banyak dari jam yang diukur alat." },
  binding_tumpang: { label: "Satu alat, dua pasien", icon: "split", color: BAD, kalimat: "Alat yang sama terikat ke dua pasien pada jam yang sama." },
  tanpa_pasien: { label: "Nyala tanpa pasien", icon: "eye", color: WARN, kalimat: "Alat menyala tanpa pasien yang terikat." },
  jangkar_tidak_cocok: { label: "Jangkar tidak cocok", icon: "unlock", color: BAD, kalimat: "Bacaan alat tidak cocok dengan root yang sudah dijangkarkan." },
  jangkar_terlambat: { label: "Jangkar terlambat", icon: "clock", color: WARN, kalimat: "Bukti dijangkarkan setelah klaim diajukan." },
  offline: { label: "Alat offline", icon: "signal", color: WARN, kalimat: "Alat berhenti mengirim bacaan." },
  kunci_dicabut: { label: "Kunci dicabut", icon: "lock", color: LEDGER, kalimat: "Kunci alat dicabut: bacaan baru tidak diakui." },
};
const peringatanInfo = (j?: string) => PERINGATAN[j ?? ""] ?? { label: j ? j.replace(/[._]/g, " ") : "Peringatan", icon: "bell" as IconName, color: WARN, kalimat: "" };

const JENIS_NAMA: Record<string, string> = {
  ventilator: "Ventilator", hemodialisis: "Hemodialisis", hd: "Hemodialisis", icu_bed: "Bed ICU", bed_icu: "Bed ICU", monitor: "Monitor ICU",
  icu: "Bed/monitor ICU", pompa_infus: "Pompa infus", infus: "Pompa infus", infusion_pump: "Pompa infus",
};

// ------------------------------------------------------------------------------------------------ formatting

const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const DAY = 864e5;
const RE_WAKTU = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;
/** The wall-clock time written in the data (the hospital's local time), as a number: the offset, if any, is ignored, so
 *  every panel reads the same clock whatever the viewer's time zone. */
function wall(s?: string | null): number | null {
  const m = s ? RE_WAKTU.exec(s) : null;
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : null;
}
const pad = (n: number) => String(n).padStart(2, "0");
const tgl = (ms: number) => { const d = new Date(ms); return `${d.getUTCDate()} ${BULAN[d.getUTCMonth()]}`; };
const tglPanjang = (s?: string) => { const ms = wall(s); if (ms === null) return s ?? "—"; const d = new Date(ms); return `${d.getUTCDate()} ${BULAN[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
function waktu(s?: string | null): string {
  const ms = wall(s);
  if (ms === null) return s || "—";
  const d = new Date(ms);
  return RE_WAKTU.exec(s ?? "")?.[4] === undefined ? tgl(ms) : `${tgl(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
const N = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);
const nf = (n: number, d = 0) => n.toLocaleString("id-ID", { maximumFractionDigits: d });
// one decimal always: 95,6 hours must not read as 96 next to the 96-hour threshold
const jamFmt = (h?: number | null) => (typeof h !== "number" || !isFinite(h) ? "—" : `${nf(h, 1)} jam`);
const rp = (n?: number | null) => `Rp ${compact(N(n))}`;
const pct = (v?: number | null) => (typeof v !== "number" || !isFinite(v) ? "—" : `${nf(v, v < 10 ? 1 : 0)}%`);
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const isVent = (a?: Alat, s?: Sesi) => (a?.jenis ?? s?.jenis) === "ventilator" || /^VNT/i.test(a?.id ?? s?.device_id ?? "");

function modeParts(mj?: ModeJam | null) {
  if (!mj || typeof mj !== "object") return [];
  const per = new Map<string, number>();  // older spellings merged into their state
  for (const [k, v] of Object.entries(mj)) if (typeof v === "number" && v > 0) per.set(kunciMode(k), (per.get(kunciMode(k)) ?? 0) + v);
  return [...per].map(([k, v]) => ({ k, v, ...modeInfo(k) })).sort((a, b) => a.order - b.order);
}
/** The mode a session is drawn in: the longest of the working modes, else the longest of all. */
function dominan(mj?: ModeJam | null) {
  const ps = modeParts(mj);
  const pool = ps.some((p) => p.aktif) ? ps.filter((p) => p.aktif) : ps;
  return pool.length ? pool.reduce((a, b) => (b.v > a.v ? b : a)) : null;
}
const modeLines = (mj?: ModeJam | null) => modeParts(mj).map((p) => ({ key: p.color, value: jamFmt(p.v), label: p.label }));

/** When a session ran: its start and end, or its start plus its hours when the end is missing. */
function rentang(s: { mulai?: string; selesai?: string; jam?: number }): [number, number] | null {
  const a = wall(s.mulai);
  if (a === null) return null;
  const b = wall(s.selesai) ?? (N(s.jam) > 0 ? a + N(s.jam) * 36e5 : null);
  return b === null || b <= a ? null : [a, b];
}

/** One plain sentence on a session, for the reader who will not open the numbers. */
function kalimatSesi(s: Sesi, a?: Alat): string {
  const ukur = N(s.jam), tagih = typeof s.jam_ditagih === "number" ? s.jam_ditagih : null;
  switch (s.hasil) {
    case "tidak_sesuai": {
      const ps = modeParts(s.mode_jam);
      const jl = ps.find((p) => p.k === "jalan")?.v;
      if (isVent(a, s) && tagih !== null && tagih >= BATAS_VENT) {
        const v = typeof jl === "number" ? jl : ps.length ? 0 : ukur;
        if (v < BATAS_VENT)
          return `Klaim menagih ventilasi ≥ ${BATAS_VENT} jam berturut-turut (ICD-9-CM 96.72), tetapi ventilator hanya tercatat jalan ${jamFmt(v)}. Tarif INA-CBG kelompok < ${BATAS_VENT} jam jauh lebih rendah.`;
      }
      if (tagih !== null && tagih > ukur) return `Klaim menagih ${jamFmt(tagih)}, alat hanya tercatat ${jamFmt(ukur)}.`;
      // the device was on for the hours billed, but not running (a ventilator only on standby)
      const kerja = ps.filter((p) => p.aktif).map((p) => `${p.label.toLowerCase()} ${jamFmt(p.v)}`).join(", ");
      const diam = ps.filter((p) => !p.aktif && p.k !== "mati").map((p) => `${p.label.toLowerCase()} ${jamFmt(p.v)}`).join(", ");
      return `Alat menyala selama jam yang ditagih${tagih !== null ? ` (${jamFmt(tagih)})` : ""}, tetapi ${kerja ? `hanya ${kerja}` : "tidak pernah jalan"}${diam ? `; sisanya ${diam}` : ""}.`;
    }
    case "sesuai":
      return `Jam yang diukur alat (${jamFmt(ukur)}) mendukung jam yang ditagih${tagih !== null ? ` (${jamFmt(tagih)})` : ""}.`;
    case "tanpa_bukti":
      return "Klaim menyebut pemakaian alat, tetapi tidak ada bacaan alat yang terikat ke kunjungan ini.";
    case "tanpa_klaim":
      return "Alat tercatat dipakai untuk pasien ini; belum ada klaim yang terhubung.";
    default:
      return s.peserta ? "" : "Alat menyala tanpa pasien yang terikat.";
  }
}

// ------------------------------------------------------------------------------------------------ model

type Model = {
  m: Monitoring; r: Ringkas;
  alatById: Map<string, Alat>; sesiById: Map<string, Sesi>; sesiByAlat: Map<string, Sesi[]>; harian: Map<string, Map<number, Harian>>;
  rsList: (RsRow & { nama: string })[]; jenisList: (JenisRow & { nama: string })[]; jenisNama: (j?: string) => string;
  hari: number[]; t0: number; t1: number; akhirPeriode: number | null;
  tumpang: Map<string, string[]>; tumpangSeg: Map<string, [number, number][]>; tumpangAlat: Set<string>;
  selisihKlaim: Map<string, number>;
};

function bangun(m: Monitoring): Model {
  const alatById = new Map(m.alat.map((a) => [a.id, a] as const));
  const sesiById = new Map(m.sesi.map((s) => [s.sesi_id, s] as const));
  const sesiByAlat = new Map<string, Sesi[]>();
  for (const s of m.sesi) if (s.device_id) sesiByAlat.set(s.device_id, [...(sesiByAlat.get(s.device_id) ?? []), s]);
  for (const l of sesiByAlat.values()) l.sort((a, b) => (wall(a.mulai) ?? 0) - (wall(b.mulai) ?? 0));

  // one device bound to two patients at the same time
  const tumpang = new Map<string, string[]>(), tumpangSeg = new Map<string, [number, number][]>(), tumpangAlat = new Set<string>();
  for (const [dev, l] of sesiByAlat) {
    for (let i = 0; i < l.length; i++) {
      const ra = rentang(l[i]);
      if (!ra || !l[i].peserta) continue;
      for (let j = i + 1; j < l.length; j++) {
        const rb = rentang(l[j]);
        if (!rb) continue;
        if (rb[0] >= ra[1]) break;
        if (!l[j].peserta || l[j].peserta === l[i].peserta) continue;
        const lo = Math.max(ra[0], rb[0]), hi = Math.min(ra[1], rb[1]);
        if (hi <= lo) continue;
        tumpang.set(l[i].sesi_id, [...(tumpang.get(l[i].sesi_id) ?? []), l[j].sesi_id]);
        tumpang.set(l[j].sesi_id, [...(tumpang.get(l[j].sesi_id) ?? []), l[i].sesi_id]);
        tumpangSeg.set(dev, [...(tumpangSeg.get(dev) ?? []), [lo, hi]]);
        tumpangAlat.add(dev);
      }
    }
  }
  for (const p of m.peringatan) if (p.jenis === "binding_tumpang" && p.device_id) tumpangAlat.add(p.device_id);

  const selisihKlaim = new Map<string, number>();
  for (const p of m.peringatan) if (p.jenis === "iot.tidak_sesuai" && p.klaim_id && N(p.selisih_rp)) selisihKlaim.set(p.klaim_id, N(p.selisih_rp));
  const selisihSesi = (s: Sesi) => N(s.selisih_rp) || (s.klaim_id ? selisihKlaim.get(s.klaim_id) ?? 0 : 0);

  const harian = new Map<string, Map<number, Harian>>();
  for (const a of m.alat) {
    const h = new Map<number, Harian>();
    for (const x of daftar<Harian>(a.harian)) { const t = wall(x.tanggal); if (t !== null) h.set(Math.floor(t / DAY) * DAY, x); }
    harian.set(a.id, h);
  }

  // the days on the time axes: the claims' period and the readings' window together, else the span of the readings
  const batas = (xs: (number | null)[], f: (...v: number[]) => number) => { const v = xs.filter((x): x is number => x !== null); return v.length ? f(...v) : null; };
  let d0 = batas([wall(m.periode?.mulai), wall(m.jendela?.mulai)], Math.min), d1 = batas([wall(m.periode?.akhir), wall(m.jendela?.akhir)], Math.max);
  if (d0 === null || d1 === null) {
    const all: number[] = [];
    for (const h of harian.values()) all.push(...h.keys());
    for (const s of m.sesi) { const r = rentang(s); if (r) all.push(r[0], r[1] - 1); }
    if (all.length) { d0 ??= Math.min(...all); d1 ??= Math.max(...all); }
  }
  const hari: number[] = [];
  if (d0 !== null && d1 !== null) {
    const b = Math.floor(Math.max(d0, d1) / DAY) * DAY;
    for (let a = Math.floor(Math.min(d0, d1) / DAY) * DAY; a <= b && hari.length < 62; a += DAY) hari.push(a);
  }
  const t0 = hari[0] ?? 0, t1 = hari.length ? hari[hari.length - 1] + DAY : 0;

  // hospitals: as listed, plus any a device names; the numbers a row lacks are counted from the devices
  const rsMap = new Map<string, RsRow>();
  for (const r of m.rs) rsMap.set(r.id, r);
  for (const a of m.alat) { const id = a.rs_id ?? a.rs; if (id && !rsMap.has(id)) rsMap.set(id, { id, nama: a.rs ?? id }); }
  const rsList = [...rsMap.values()].map((r) => {
    const xs = m.alat.filter((a) => (a.rs_id ?? a.rs) === r.id);
    const ids = new Set(xs.map((a) => a.id));
    const salah = m.sesi.filter((s) => s.device_id && ids.has(s.device_id) && s.hasil === "tidak_sesuai");
    return {
      ...r, nama: teks(r.nama) ?? xs[0]?.rs ?? r.id,
      alat: num(r.alat) ?? xs.length,
      jam: num(r.jam) ?? sum(xs.map((a) => N(a.jam_nyala))),
      utilisasi_pct: num(r.utilisasi_pct) ?? (xs.length ? sum(xs.map((a) => N(a.utilisasi_pct))) / xs.length : undefined),
      tidak_sesuai: num(r.tidak_sesuai) ?? salah.length,
      selisih_rp: num(r.selisih_rp) ?? sum(salah.map(selisihSesi)),
    };
  }).sort((a, b) => a.nama.localeCompare(b.nama, "id"));

  const jMap = new Map<string, JenisRow>();
  for (const j of m.jenis_alat) jMap.set(j.jenis, j);
  for (const a of m.alat) if (a.jenis && !jMap.has(a.jenis)) jMap.set(a.jenis, { jenis: a.jenis });
  const jenisList = [...jMap.values()].map((j) => {
    const xs = m.alat.filter((a) => a.jenis === j.jenis);
    return {
      ...j, nama: teks(j.nama) ?? JENIS_NAMA[j.jenis] ?? j.jenis.replace(/_/g, " "),
      alat: num(j.alat) ?? xs.length,
      jam: num(j.jam) ?? sum(xs.map((a) => N(a.jam_nyala))),
      utilisasi_pct: num(j.utilisasi_pct) ?? (xs.length ? sum(xs.map((a) => N(a.utilisasi_pct))) / xs.length : undefined),
    };
  });
  const jenisNama = (j?: string) => (j ? jenisList.find((x) => x.jenis === j)?.nama ?? JENIS_NAMA[j] ?? j : "Alat");

  const rk = m.ringkas ?? {};
  const hit = (h: string) => m.sesi.filter((s) => s.hasil === h).length;
  const r: Ringkas = {
    rs: num(rk.rs) ?? rsList.length,
    alat: num(rk.alat) ?? m.alat.length,
    alat_aktif: num(rk.alat_aktif) ?? m.alat.filter((a) => a.status === "dipakai").length,
    sesi: num(rk.sesi) ?? m.sesi.length,
    jam_total: num(rk.jam_total) ?? sum(m.sesi.map((s) => N(s.jam))),
    klaim_dengan_alat: num(rk.klaim_dengan_alat) ?? new Set(m.sesi.map((s) => s.klaim_id).filter(Boolean)).size,
    sesuai: num(rk.sesuai) ?? hit("sesuai"),
    tidak_sesuai: num(rk.tidak_sesuai) ?? hit("tidak_sesuai"),
    tanpa_bukti: num(rk.tanpa_bukti) ?? hit("tanpa_bukti"),
    selisih_rp: num(rk.selisih_rp) ?? sum(m.sesi.filter((s) => s.hasil === "tidak_sesuai").map(selisihSesi)),
    jangkar: num(rk.jangkar),
    jangkar_ok: num(rk.jangkar_ok),
  };

  // where the claims' period ends on the time axis, when the readings run past it
  const ap = wall(m.periode?.akhir);
  const akhirPeriode = ap !== null && Math.floor(ap / DAY) * DAY + DAY < t1 ? Math.floor(ap / DAY) * DAY + DAY : null;

  return { m, r, alatById, sesiById, sesiByAlat, harian, rsList, jenisList, jenisNama, hari, t0, t1, akhirPeriode, tumpang, tumpangSeg, tumpangAlat, selisihKlaim };
}

const urutAlat = (model: Model) => (a: Alat, b: Alat) => {
  const ra = model.rsList.find((r) => r.id === (a.rs_id ?? a.rs))?.nama ?? a.rs ?? "", rb = model.rsList.find((r) => r.id === (b.rs_id ?? b.rs))?.nama ?? b.rs ?? "";
  return ra.localeCompare(rb, "id") || (a.jenis ?? "").localeCompare(b.jenis ?? "") || a.id.localeCompare(b.id);
};
const rsNamaAlat = (model: Model, a?: Alat) => (a ? model.rsList.find((r) => r.id === (a.rs_id ?? a.rs))?.nama ?? a.rs ?? "—" : "—");

// ------------------------------------------------------------------------------------------------ small pieces

const Pill = ({ color, children }: { color: string; children: ReactNode }) => (
  <span className="inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-px text-[10px] font-medium" style={{ color, background: `${color}22`, border: `1px solid ${color}55` }}>{children}</span>
);

function StatusDot({ status, size = 8 }: { status?: string; size?: number }) {
  const s = statusInfo(status);
  return <span title={s.label} aria-label={s.label} className="inline-block shrink-0 rounded-full"
    style={{ width: size, height: size, ...(s.isi ? { background: s.color } : { border: `1.5px solid ${s.color}` }) }} />;
}

const Swatch = ({ color, label, hollow, hatch }: { color: string; label: string; hollow?: boolean; hatch?: boolean }) => (
  <span className="flex items-center gap-1.5 whitespace-nowrap">
    <span className="h-2.5 w-3 shrink-0 rounded-[3px]" style={hatch ? { background: `repeating-linear-gradient(135deg, ${color} 0 2px, transparent 2px 4px)`, border: `1px solid ${color}` }
      : hollow ? { border: `1px dashed ${color}` } : { background: color }} />
    {label}
  </span>
);

function Kartu({ title, insight, kanan, tabel, children, className = "" }: { title: string; insight?: ReactNode; kanan?: ReactNode; tabel?: ReactNode; children: ReactNode; className?: string }) {
  const [lihat, setLihat] = useState<"grafik" | "tabel">("grafik");
  return (
    <section className={`${panel} flex min-w-0 flex-col p-3.5 ${className}`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-[200px] flex-1">
          <h3 className="text-[13px] font-semibold leading-snug text-white">{title}</h3>
          {insight && <p className="mt-0.5 text-[11.5px] leading-snug text-[#abb3bf]">{insight}</p>}
        </div>
        {kanan}
        {tabel && (
          <div className="flex shrink-0 rounded border border-white/10 p-0.5 text-[10.5px]">
            {(["grafik", "tabel"] as const).map((v) => (
              <button key={v} type="button" onClick={() => setLihat(v)} className={`rounded-sm px-1.5 py-0.5 ${lihat === v ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`}>{v === "grafik" ? "Grafik" : "Tabel"}</button>
            ))}
          </div>
        )}
      </div>
      <div className="mt-3 min-w-0">{lihat === "grafik" || !tabel ? children : tabel}</div>
    </section>
  );
}

function Tabel({ head, rows, angka = [], onRow }: { head: string[]; rows: ReactNode[][]; angka?: number[]; onRow?: (i: number) => void }) {
  return (
    <div className="max-h-[420px] overflow-auto rounded border border-white/5">
      <table className="w-full text-[11.5px]">
        <thead className="sticky top-0 z-10 bg-[#20262d]">
          <tr>{head.map((h, i) => <th key={h} className={`whitespace-nowrap px-2 py-1.5 font-medium text-[#abb3bf] ${angka.includes(i) ? "text-right" : "text-left"}`}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} onClick={onRow ? () => onRow(i) : undefined} className={`border-t border-white/[.04] hover:bg-white/[.03] ${onRow ? "cursor-pointer" : ""}`}>
              {r.map((c, j) => <td key={j} className={`px-2 py-1 text-[#e5e8eb] ${angka.includes(j) ? "text-right tabular-nums" : ""}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="px-2 py-3 text-[11px] text-[#8f99a8]">Tidak ada baris.</p>}
    </div>
  );
}

const Kosong = ({ children }: { children: ReactNode }) => <p className="rounded border border-dashed border-white/10 px-3 py-4 text-center text-[11.5px] text-[#8f99a8]">{children}</p>;

const tipAlat = (model: Model, a: Alat): Omit<NonNullable<Tip>, "x" | "y"> => ({
  title: `${a.id} · ${a.nama ?? model.jenisNama(a.jenis)}`,
  lines: [
    { key: statusInfo(a.status).color, value: statusInfo(a.status).label, label: "status" },
    { value: jamFmt(a.jam_nyala), label: "nyala dalam periode" },
    { value: pct(a.utilisasi_pct), label: "utilisasi" },
    { value: nf(N(a.sesi) || (model.sesiByAlat.get(a.id)?.length ?? 0)), label: "sesi" },
    ...(a.terakhir ? [{ value: waktu(a.terakhir), label: "terakhir terlihat" }] : []),
    ...(a.kunci_dicabut ? [{ key: BAD, value: "Kunci dicabut", label: "bacaan baru tidak diakui" }] : []),
  ],
});

// ------------------------------------------------------------------------------------------------ the view

async function baca(r: Response) {
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof b?.error === "string" ? b.error : `${r.status} ${r.statusText}`);
  return b;
}
const pesan = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function IotMonitoringView() {
  const [runs, setRuns] = useState<RunInfo[] | null>(null);
  const [run, setRun] = useState<string | null>(null);
  const [muat, setMuat] = useState(0);
  const [data, setData] = useState<{ run: string; raw: unknown } | null>(null);
  const [err, setErr] = useState<{ run: string | null; msg: string } | null>(null);

  useEffect(() => {
    let on = true;
    fetch("/api/iot-monitoring", { cache: "no-store" }).then(baca)
      .then((b: { runs?: unknown }) => {
        if (!on) return;
        const list = daftar<RunInfo>(b.runs).filter((r) => typeof r.id === "string");
        setRuns(list);
        setRun((cur) => cur ?? list[0]?.id ?? null);
      })
      .catch((e) => on && setErr({ run: null, msg: pesan(e) }));
    return () => { on = false; };
  }, []);

  useEffect(() => {
    if (!run) return;
    let on = true;
    fetch(`/api/iot-monitoring?run=${encodeURIComponent(run)}`, { cache: "no-store" }).then(baca)
      .then((b) => { if (on) { setData({ run, raw: b }); setErr(null); } })
      .catch((e) => on && setErr({ run, msg: pesan(e) }));
    return () => { on = false; };
  }, [run, muat]);

  const raw = data && data.run === run ? data.raw : null;
  const k = useMemo(() => (raw ? kepala(raw) : null), [raw]);
  const galat = err && (err.run === null || err.run === run) ? err.msg : null;
  const info = runs?.find((r) => r.id === run);
  const kc = k?.kc?.nama ?? info?.kc?.nama;
  const periode = k?.periode ?? info?.periode;

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-[#252d35] text-[12px] text-[#c5cbd3]">
      <div className="mx-auto max-w-[1320px] space-y-4 p-4">
        <header className={`${panel} flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3`}>
          <div className="min-w-[260px] flex-1">
            <h1 className="flex flex-wrap items-center gap-x-2 text-[15px] font-semibold text-white">
              <Icon name="signal" className="h-4 w-4 text-[#2dd4bf]" />IoT Monitoring
              {kc && <span className="font-normal text-[#c5cbd3]">· {kc}</span>}
            </h1>
            <p className="mt-0.5 text-[11.5px] text-[#abb3bf]">Sensor clamp pada kabel daya (tanpa membuka alat): waktu nyala & status jalan / siaga / mati, bukan tanda vital.</p>
            {(periode?.mulai || periode?.akhir) && (
              <p className="mt-0.5 text-[11px] text-[#8f99a8]">
                Periode klaim {tglPanjang(periode?.mulai)} – {tglPanjang(periode?.akhir)}
                {k?.jendela?.akhir && k.jendela.akhir.slice(0, 10) !== periode?.akhir?.slice(0, 10) ? ` · bacaan alat sampai ${tglPanjang(k.jendela.akhir)}` : ""}
                {k?.kc?.id ? ` · ${k.kc.id}` : ""}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {(k?.sintetis ?? info?.sintetis) && <Pill color={WARN}>data IoT sintetis</Pill>}
            <Pill color={OK}>tanpa tanda vital · pasien disamarkan</Pill>
            {runs && runs.length > 0 && (
              <label className="flex items-center gap-1.5 text-[11px] text-[#8f99a8]">Run
                <select value={run ?? ""} onChange={(e) => setRun(e.target.value)}
                  className="max-w-[260px] rounded border border-white/15 bg-[#111418] px-2 py-1 text-[11.5px] text-white outline-none focus:border-[#3987e5]">
                  {runs.map((r) => <option key={r.id} value={r.id}>{r.kc?.nama ? `${r.kc.nama} · ${r.id}` : r.id}</option>)}
                </select>
              </label>
            )}
            {run && (
              <button type="button" onClick={() => setMuat((n) => n + 1)} title="Muat ulang data run ini"
                className="grid h-7 w-7 place-items-center rounded border border-white/15 text-[#c5cbd3] hover:bg-white/[.06] hover:text-white">
                <Icon name="refresh" className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </header>

        {galat ? (
          <div role="alert" className="rounded border border-[#fbbf24]/40 bg-[#fbbf24]/10 px-3 py-3 text-[12px] text-[#fde68a]">{galat}</div>
        ) : runs && runs.length === 0 ? (
          <Kosong>Belum ada data IoT Monitoring. Setiap run disimpan di data/aip/cabang/iot/&lt;run&gt;/monitoring.json.</Kosong>
        ) : !raw ? (
          <p className="py-10 text-center text-[12px] text-[#abb3bf]">Memuat data IoT…</p>
        ) : (
          <IotMonitoringBoard key={run} data={raw} />
        )}
      </div>
    </div>
  );
}

/** Everything below the header, for one run's monitoring.json (raw: it is normalised here). */
export function IotMonitoringBoard({ data }: { data: unknown }) {
  const model = useMemo(() => bangun(norm(data)), [data]);
  const [jenis, setJenis] = useState<string | null>(null);
  const [rsId, setRsId] = useState<string | null>(null);
  const [tumpuk, setTumpuk] = useState<Pilih[]>([]);

  const f = useMemo(() => {
    const semua = !jenis && !rsId;
    const alat = model.m.alat.filter((a) => (!jenis || a.jenis === jenis) && (!rsId || (a.rs_id ?? a.rs) === rsId)).sort(urutAlat(model));
    const ids = new Set(alat.map((a) => a.id));
    const sesi = model.m.sesi.filter((s) => (s.device_id && model.alatById.has(s.device_id) ? ids.has(s.device_id) : semua));
    const rsNama = rsId ? model.rsList.find((r) => r.id === rsId)?.nama : null;
    const peringatan = model.m.peringatan.filter((p) =>
      p.device_id && model.alatById.has(p.device_id) ? ids.has(p.device_id) : semua || (!jenis && !!rsNama && p.rs === rsNama));
    return { alat, sesi, peringatan };
  }, [model, jenis, rsId]);

  const buka = (p: Pilih) => setTumpuk([p]);
  const lanjut = (p: Pilih) => setTumpuk((t) => [...t, p]);
  const kini = tumpuk[tumpuk.length - 1];

  return (
    <>
      <KpiTiles r={model.r} dipakai={model.m.alat.filter((a) => N(a.jam_nyala) > 0).length} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-white/[.07] bg-[#1c2127] px-3 py-2">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Jenis alat">
          <span className="mr-1 flex items-center gap-1 text-[11px] text-[#8f99a8]"><Icon name="filter" className="h-3 w-3" />Jenis alat</span>
          {[{ jenis: null as string | null, nama: "Semua", alat: model.m.alat.length, utilisasi_pct: undefined as number | undefined }, ...model.jenisList].map((j) => (
            <button key={j.jenis ?? "_semua"} type="button" onClick={() => setJenis(j.jenis)} aria-pressed={jenis === j.jenis}
              title={j.jenis ? `${j.nama}: ${nf(N(j.alat))} alat · utilisasi ${pct(j.utilisasi_pct)}` : "Semua jenis alat"}
              className={`rounded border px-2 py-0.5 text-[11px] ${jenis === j.jenis ? "border-[#3987e5]/70 bg-[#3987e5]/15 text-white" : "border-white/10 text-[#c5cbd3] hover:bg-white/[.05]"}`}>
              {j.nama} <span className="tabular-nums text-[#8f99a8]">{nf(N(j.alat))}</span>
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-[#8f99a8]">Rumah sakit
          <select value={rsId ?? ""} onChange={(e) => setRsId(e.target.value || null)}
            className="max-w-[240px] rounded border border-white/15 bg-[#111418] px-2 py-0.5 text-[11.5px] text-white outline-none focus:border-[#3987e5]">
            <option value="">Semua RS</option>
            {model.rsList.map((r) => <option key={r.id} value={r.id}>{r.nama}</option>)}
          </select>
        </label>
        {(jenis || rsId) && <button type="button" onClick={() => { setJenis(null); setRsId(null); }} className="text-[11px] text-[#8abbff] hover:underline">Hapus filter</button>}
        <span className="ml-auto text-[11px] text-[#8f99a8]">{nf(f.alat.length)} alat · {nf(f.sesi.length)} sesi · {nf(f.peringatan.length)} peringatan</span>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <Armada alat={f.alat} model={model} onPick={buka} />
        <Feed items={f.peringatan} model={model} onPick={buka} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <JamVsTagih sesi={f.sesi} model={model} onPick={buka} />
        <TabelRs rows={model.rsList} aktif={rsId} onPick={(id) => setRsId(id === rsId ? null : id)} />
      </div>

      <Heatmap alat={f.alat} model={model} onPick={buka} />
      <Gantt alat={f.alat} sesi={f.sesi} peringatan={f.peringatan} model={model} onPick={buka} />

      <p className="pb-2 text-[10.5px] leading-relaxed text-[#8f99a8]">
        Data IoT sintetis{model.m.run ? ` (run ${model.m.run})` : ""}. Sensor hanya membaca arus listrik alat: kapan alat jalan, siaga atau mati, dan berapa lama. Tidak ada tanda vital;
        pasien disamarkan. Bacaan tiap episode di-hash menjadi satu root Merkle dan dijangkarkan ke log yang tidak bisa diubah sebelum klaim diajukan.
      </p>

      {kini && (
        <Laci pilih={kini} model={model} bisaKembali={tumpuk.length > 1} onKembali={() => setTumpuk((t) => t.slice(0, -1))} onTutup={() => setTumpuk([])} onPick={lanjut} />
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------------ KPI tiles

function KpiTiles({ r, dipakai }: { r: Ringkas; dipakai: number }) {
  const jangkarBuruk = r.jangkar !== null && r.jangkar_ok !== null ? r.jangkar - r.jangkar_ok : 0;
  const tiles: { label: string; value: string; sub: ReactNode; color: string; icon: IconName; bad?: boolean }[] = [
    { label: "Alat aktif / terpasang", value: `${nf(r.alat_aktif)} / ${nf(r.alat)}`, sub: `${nf(dipakai)} dipakai dalam periode · ${nf(r.rs)} RS`, color: "#2dd4bf", icon: "device" },
    { label: "Sesi pemakaian", value: nf(r.sesi), sub: "alat terikat ke pasien", color: UKUR, icon: "link" },
    { label: "Jam pemakaian", value: compact(r.jam_total), sub: "jam, diukur sensor arus", color: UKUR, icon: "clock" },
    { label: "Klaim dengan bukti alat", value: nf(r.klaim_dengan_alat), sub: `${nf(r.sesuai)} sesuai · ${nf(r.tanpa_bukti)} tanpa bukti`, color: OK, icon: "check" },
    { label: "Tidak sesuai", value: nf(r.tidak_sesuai), sub: "jam ditagih > jam terukur", color: BAD, icon: "alert", bad: r.tidak_sesuai > 0 },
    { label: "Selisih tarif", value: rp(r.selisih_rp), sub: "INA-CBG ditagih vs didukung alat", color: BAD, icon: "alert", bad: r.selisih_rp > 0 },
    {
      label: "Jangkar blockchain OK", value: r.jangkar === null ? "—" : `${nf(r.jangkar_ok ?? 0)} / ${nf(r.jangkar)}`,
      sub: jangkarBuruk > 0 ? <span className="text-[#fca5a5]">{nf(jangkarBuruk)} tidak cocok atau terlambat</span> : "root Merkle per episode, sebelum klaim",
      color: LEDGER, icon: "lock",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
      {tiles.map((t) => (
        <div key={t.label} className={`${panel} min-w-0 p-3`} style={{ borderTopColor: t.color, borderTopWidth: 2 }}>
          <p className="flex items-center gap-1.5 text-[11px] text-[#8f99a8]"><span className="shrink-0" style={{ color: t.color }}><Icon name={t.icon} className="h-3 w-3" /></span><span className="truncate">{t.label}</span></p>
          <p className={`mt-1 truncate text-[22px] font-semibold leading-tight tabular-nums ${t.bad ? "text-[#fca5a5]" : "text-white"}`}>{t.value}</p>
          <p className="mt-0.5 text-[10.5px] leading-snug text-[#abb3bf]">{t.sub}</p>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ fleet

function Armada({ alat, model, onPick }: { alat: Alat[]; model: Model; onPick: (p: Pilih) => void }) {
  const { box, tip, at, clear } = useTip();
  const grup = useMemo(() => {
    const by = new Map<string, Alat[]>();
    for (const a of alat) { const k = a.rs_id ?? a.rs ?? "—"; by.set(k, [...(by.get(k) ?? []), a]); }
    return [...by.entries()].map(([id, xs]) => ({ id, rs: model.rsList.find((r) => r.id === id), alat: xs }));
  }, [alat, model]);
  const hitung = (s: string) => alat.filter((a) => a.status === s).length;
  const dicabut = alat.filter((a) => a.kunci_dicabut).length;
  return (
    <Kartu title="Armada alat" insight="Status terakhir tiap alat per rumah sakit. Garis di bawah kotak = utilisasi dalam periode. Klik alat untuk detail.">
      <div className="mb-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#c5cbd3]">
        {Object.entries(STATUS_ALAT).map(([k, s]) => (
          <span key={k} className="flex items-center gap-1.5"><StatusDot status={k} />{s.label} <span className="tabular-nums text-[#8f99a8]">{nf(hitung(k))}</span></span>
        ))}
        <span className="flex items-center gap-1.5"><Icon name="lock" className="h-3 w-3 text-[#f87171]" />Kunci dicabut <span className="tabular-nums text-[#8f99a8]">{nf(dicabut)}</span></span>
      </div>
      {!alat.length ? <Kosong>Tidak ada alat untuk filter ini.</Kosong> : (
        <div ref={box} className="relative" onPointerLeave={clear}>
          <div className="max-h-[400px] space-y-3 overflow-y-auto pr-1">
            {grup.map((g) => (
              <div key={g.id}>
                <p className="mb-1 flex flex-wrap items-baseline gap-x-2 text-[11.5px]">
                  <span className="font-medium text-[#e5e8eb]">{g.rs?.nama ?? g.alat[0]?.rs ?? g.id}</span>
                  <span className="text-[10.5px] text-[#8f99a8]">{[g.rs?.kabkota, `${nf(g.alat.length)} alat`, `${nf(g.alat.filter((a) => a.status === "dipakai").length)} dipakai`].filter(Boolean).join(" · ")}</span>
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {g.alat.map((a) => {
                    const t = tipAlat(model, a);
                    return (
                      <button key={a.id} type="button" onClick={() => onPick({ kind: "alat", id: a.id })} onPointerMove={(e) => at(e, t)} onFocus={(e) => at(e, t)} onBlur={clear}
                        className={`relative flex items-center gap-1.5 overflow-hidden rounded border bg-[#111418] py-1 pl-1.5 pr-2 text-[11px] text-[#e5e8eb] outline-none hover:border-white/30 focus-visible:ring-1 focus-visible:ring-[#3987e5] ${a.kunci_dicabut ? "border-[#f87171]/50" : "border-white/10"}`}>
                        <StatusDot status={a.status} />
                        <span className="font-mono text-[10.5px]">{a.id}</span>
                        <span className="text-[10px] text-[#8f99a8]">{model.jenisNama(a.jenis)}</span>
                        {a.kunci_dicabut && <Icon name="lock" className="h-3 w-3 text-[#f87171]" />}
                        {model.tumpangAlat.has(a.id) && <Icon name="split" className="h-3 w-3 text-[#f87171]" />}
                        <span className="absolute inset-x-0 bottom-0 h-[2px] bg-white/[.06]"><span className="block h-full" style={{ width: `${Math.min(100, Math.max(0, N(a.utilisasi_pct)))}%`, background: UKUR }} /></span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <Tooltip tip={tip} />
        </div>
      )}
    </Kartu>
  );
}

// ------------------------------------------------------------------------------------------------ alerts

function tujuanPeringatan(model: Model, p: Peringatan): Pilih | null {
  if (p.sesi_id && model.sesiById.has(p.sesi_id)) return { kind: "sesi", id: p.sesi_id };
  if (p.klaim_id) {
    const s = model.m.sesi.find((x) => x.klaim_id === p.klaim_id && (!p.device_id || x.device_id === p.device_id));
    if (s) return { kind: "sesi", id: s.sesi_id };
  }
  return p.device_id && model.alatById.has(p.device_id) ? { kind: "alat", id: p.device_id } : null;
}

function Feed({ items, model, onPick }: { items: Peringatan[]; model: Model; onPick: (p: Pilih) => void }) {
  const [jenis, setJenis] = useState<string | null>(null);
  const [semua, setSemua] = useState(false);
  const jenisAda = useMemo(() => {
    const c = new Map<string, number>();
    for (const p of items) c.set(p.jenis ?? "", (c.get(p.jenis ?? "") ?? 0) + 1);
    const urut = Object.keys(PERINGATAN);
    return [...c.entries()].sort((a, b) => (urut.indexOf(a[0]) + 1 || 99) - (urut.indexOf(b[0]) + 1 || 99));
  }, [items]);
  const rows = useMemo(() => items.filter((p) => jenis === null || (p.jenis ?? "") === jenis).sort((a, b) => (wall(b.waktu) ?? -Infinity) - (wall(a.waktu) ?? -Infinity)), [items, jenis]);
  const shown = semua ? rows : rows.slice(0, 40);
  const totalRp = sum(rows.map((p) => N(p.selisih_rp)));
  return (
    <Kartu title="Peringatan" insight={items.length ? `${nf(items.length)} peringatan dalam periode${totalRp ? `, selisih tarif ${rp(totalRp)}` : ""}. Klik untuk membuka alat atau sesinya.` : "Tidak ada peringatan untuk filter ini."}>
      {items.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1" role="group" aria-label="Jenis peringatan">
          <button type="button" onClick={() => setJenis(null)} aria-pressed={jenis === null}
            className={`rounded border px-1.5 py-0.5 text-[10.5px] ${jenis === null ? "border-white/30 bg-white/10 text-white" : "border-white/10 text-[#c5cbd3] hover:bg-white/[.05]"}`}>Semua {nf(items.length)}</button>
          {jenisAda.map(([j, n]) => {
            const t = peringatanInfo(j);
            return (
              <button key={j || "_"} type="button" onClick={() => setJenis(jenis === j ? null : j)} aria-pressed={jenis === j}
                className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] ${jenis === j ? "border-white/30 bg-white/10 text-white" : "border-white/10 text-[#c5cbd3] hover:bg-white/[.05]"}`}>
                <span style={{ color: t.color }}><Icon name={t.icon} className="h-3 w-3" /></span>{t.label} <span className="tabular-nums text-[#8f99a8]">{nf(n)}</span>
              </button>
            );
          })}
        </div>
      )}
      <ul className="max-h-[400px] divide-y divide-white/[.05] overflow-y-auto pr-1">
        {shown.map((p, i) => {
          const t = peringatanInfo(p.jenis);
          const ke = tujuanPeringatan(model, p);
          const a = p.device_id ? model.alatById.get(p.device_id) : undefined;
          return (
            <li key={`${p.jenis}-${p.device_id}-${p.waktu}-${i}`}>
              <button type="button" disabled={!ke} onClick={ke ? () => onPick(ke) : undefined}
                className="flex w-full items-start gap-2.5 rounded px-1 py-2 text-left outline-none enabled:hover:bg-white/[.04] focus-visible:ring-1 focus-visible:ring-[#3987e5]">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full" style={{ background: `${t.color}22`, color: t.color }}><Icon name={t.icon} className="h-3.5 w-3.5" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11.5px] leading-snug text-[#e5e8eb]">{p.judul || t.kalimat || t.label}</span>
                  <span className="mt-0.5 block truncate text-[10.5px] text-[#8f99a8]">
                    {[t.label, p.waktu ? waktu(p.waktu) : null, p.device_id, p.rs ?? (a ? rsNamaAlat(model, a) : null), p.klaim_id].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {N(p.selisih_rp) > 0 && <span className="shrink-0 pt-0.5 text-[11px] font-semibold tabular-nums text-[#fca5a5]">{rp(p.selisih_rp)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {rows.length > shown.length || semua ? (
        <button type="button" onClick={() => setSemua(!semua)} className="mt-1 self-start text-[10.5px] text-[#8abbff] hover:underline">{semua ? "Ringkas" : `Lihat semua ${nf(rows.length)}`}</button>
      ) : null}
    </Kartu>
  );
}

// ------------------------------------------------------------------------------------------------ hours used vs hours billed

type BarisKlaim = { s: Sesi; a?: Alat; ukur: number; tagih: number | null; vent: boolean; gap: number; rp: number };
const RANK_HASIL: Record<string, number> = { tidak_sesuai: 0, tanpa_bukti: 1, sesuai: 2 };

function JamVsTagih({ sesi, model, onPick }: { sesi: Sesi[]; model: Model; onPick: (p: Pilih) => void }) {
  const { box, tip, at, clear } = useTip();
  const [semua, setSemua] = useState(false);
  // a claim can bind several devices (ventilator, ICU monitor, infusion pump): one row per session, and the claim's tariff
  // gap on one of them only (its own selisih_rp, else the claim's, on the row with the largest gap), so it is not counted twice
  const rows = useMemo<BarisKlaim[]>(() => {
    const out = sesi.filter((s) => s.klaim_id).map((s) => {
      const a = s.device_id ? model.alatById.get(s.device_id) : undefined;
      const ukur = N(s.jam), tagih = typeof s.jam_ditagih === "number" && isFinite(s.jam_ditagih) ? s.jam_ditagih : null;
      return { s, a, ukur, tagih, vent: isVent(a, s), gap: tagih === null ? 0 : tagih - ukur, rp: N(s.selisih_rp) };
    }).sort((p, q) => (RANK_HASIL[p.s.hasil ?? ""] ?? 3) - (RANK_HASIL[q.s.hasil ?? ""] ?? 3) || q.gap - p.gap);
    const sudah = new Set(out.filter((r) => r.rp).map((r) => r.s.klaim_id));
    for (const r of out) {
      const k = r.s.klaim_id ?? "";
      if (r.rp || sudah.has(k) || r.s.hasil !== "tidak_sesuai") continue;
      r.rp = model.selisihKlaim.get(k) ?? 0;
      sudah.add(k);
    }
    return out;
  }, [sesi, model]);
  const vent = rows.filter((r) => r.vent), lain = rows.filter((r) => !r.vent);
  const maxH = Math.max(vent.length ? BATAS_VENT + 24 : 24, ...rows.flatMap((r) => [r.ukur, r.tagih ?? 0]));
  const step = maxH > 480 ? 96 : maxH > 240 ? 48 : maxH > 48 ? 24 : 6;
  const top = Math.ceil((maxH * 1.03) / step) * step;
  const x = (h: number) => (100 * Math.min(top, Math.max(0, h))) / top;
  const ticks = Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step);
  const klaim = new Set(rows.map((r) => r.s.klaim_id)).size;
  const nSalah = new Set(rows.filter((r) => r.s.hasil === "tidak_sesuai").map((r) => r.s.klaim_id)).size;
  const ventSalah = new Set(vent.filter((r) => r.tagih !== null && r.tagih >= BATAS_VENT && r.ukur < BATAS_VENT).map((r) => r.s.klaim_id)).size;
  const grid = `repeating-linear-gradient(90deg, ${GRID} 0 1px, transparent 1px ${(100 * step) / top}%)`;
  const cols = "grid-cols-[minmax(96px,190px)_minmax(0,1fr)_76px]";

  const tipBaris = (r: BarisKlaim): Omit<NonNullable<Tip>, "x" | "y"> => ({
    title: `${r.s.klaim_id} · ${r.s.device_id ?? "—"}`,
    lines: [
      { key: UKUR, value: jamFmt(r.ukur), label: "diukur sensor" },
      { key: TAGIH_INK, value: jamFmt(r.tagih), label: "ditagih di klaim" },
      ...(r.tagih !== null ? [{ value: `${r.gap > 0 ? "+" : ""}${nf(r.gap, 1)} jam`, label: "selisih jam" }] : []),
      ...(r.rp ? [{ key: BAD, value: rp(r.rp), label: "selisih tarif" }] : []),
      { key: hasilInfo(r.s.hasil).color, value: hasilInfo(r.s.hasil).label, label: r.s.peserta ?? "" },
      ...(r.s.kode ? [{ value: r.s.kode, label: "kode di klaim" }] : []),
    ],
  });

  const grup = (judul: string, xs: BarisKlaim[], batas: boolean) => {
    const tampil = semua ? xs : xs.slice(0, 18);
    return (
      <div className="min-w-[520px]">
        <div className={`grid ${cols} items-end gap-2 px-1 pb-1`}>
          <span className="text-[11px] font-medium text-[#e5e8eb]">{judul} <span className="font-normal text-[#8f99a8]">{nf(xs.length)} sesi</span></span>
          <span className="relative h-4">
            {ticks.map((t) => (
              <span key={t} className="absolute bottom-0 -translate-x-1/2 text-[9.5px] tabular-nums text-[#8f99a8]" style={{ left: `${x(t)}%` }}>{t}</span>
            ))}
            {batas && <span className="absolute -top-0.5 whitespace-nowrap rounded bg-[#1c2127] px-1 text-[9.5px] font-semibold text-[#e5e8eb]" style={{ left: `${x(BATAS_VENT)}%` }}>96 jam</span>}
          </span>
          <span className="text-right text-[10px] text-[#8f99a8]">selisih</span>
        </div>
        {tampil.map((r) => {
          const salah = r.s.hasil === "tidak_sesuai", lebih = r.tagih !== null && r.tagih > r.ukur;
          const lo = Math.min(r.ukur, r.tagih ?? r.ukur), hi = Math.max(r.ukur, r.tagih ?? r.ukur);
          const t = tipBaris(r);
          return (
            <button key={r.s.sesi_id} type="button" onClick={() => onPick({ kind: "sesi", id: r.s.sesi_id })} onPointerMove={(e) => at(e, t)} onFocus={(e) => at(e, t)} onBlur={clear}
              className={`grid w-full ${cols} items-stretch gap-2 px-1 text-left outline-none hover:bg-white/[.05] focus-visible:ring-1 focus-visible:ring-[#3987e5] ${salah ? "bg-[#d03b3b]/[.10]" : ""}`}>
              <span className="flex min-w-0 items-center gap-1.5 py-[3px]">
                {salah ? <Icon name="alert" className="h-3 w-3 shrink-0 text-[#f87171]" /> : <span className="w-3 shrink-0" />}
                <span className="truncate font-mono text-[10.5px] text-[#e5e8eb]">{r.s.klaim_id}</span>
                <span className="hidden truncate text-[10px] text-[#8f99a8] sm:inline" title={r.s.device_id}>{model.jenisNama(r.a?.jenis ?? r.s.jenis)}</span>
              </span>
              <span className="relative min-h-[20px]" style={{ backgroundImage: grid }}>
                {batas && <span className="absolute inset-y-0 w-0 border-l border-dashed border-[#e5e8eb]/55" style={{ left: `${x(BATAS_VENT)}%` }} />}
                {r.tagih !== null && hi > lo && (
                  <span className="absolute top-1/2 h-[2px] -translate-y-1/2 rounded" style={{ left: `${x(lo)}%`, width: `${x(hi) - x(lo)}%`, background: salah && lebih ? BAD : "#5f6b7c" }} />
                )}
                <span className="absolute top-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${x(r.ukur)}%`, background: UKUR, boxShadow: `0 0 0 2px ${SURFACE}` }} />
                {r.tagih !== null && (
                  <span className="absolute top-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ left: `${x(r.tagih)}%`, borderColor: TAGIH_INK, background: SURFACE }} />
                )}
              </span>
              <span className="flex flex-col items-end justify-center py-[3px] text-[10.5px] leading-tight tabular-nums">
                {salah ? (
                  <>
                    <span className="font-semibold text-[#fca5a5]">{r.rp ? rp(r.rp) : lebih ? `+${nf(r.gap, 1)} j` : "tidak jalan"}</span>
                    {r.rp > 0 && <span className="text-[9.5px] text-[#8f99a8]">{lebih ? `+${nf(r.gap, 1)} jam` : "tidak jalan"}</span>}
                  </>
                ) : (
                  <span style={{ color: hasilInfo(r.s.hasil).color }}>{hasilInfo(r.s.hasil).label.toLowerCase()}</span>
                )}
              </span>
            </button>
          );
        })}
        {xs.length > tampil.length && <p className="px-1 pt-1 text-[10.5px] text-[#8f99a8]">{nf(xs.length - tampil.length)} sesi lain disembunyikan.</p>}
      </div>
    );
  };

  const tabel = (
    <Tabel head={["Klaim", "Alat", "Peserta", "Diukur", "Ditagih", "Hasil", "Selisih tarif"]} angka={[3, 4, 6]}
      rows={rows.map((r) => [<span key="k" className="font-mono">{r.s.klaim_id}</span>, r.s.device_id ?? "—", r.s.peserta ?? "—", jamFmt(r.ukur), jamFmt(r.tagih), hasilInfo(r.s.hasil).label, r.rp ? rp(r.rp) : "—"])}
      onRow={(i) => onPick({ kind: "sesi", id: rows[i].s.sesi_id })} />
  );

  return (
    <Kartu title="Jam dipakai vs jam ditagih"
      insight={rows.length ? <>
        <b className="font-semibold text-[#fca5a5]">{nf(nSalah)}</b> dari {nf(klaim)} klaim menagih jam yang tidak didukung alat. Satu baris = satu alat dalam klaim.
        {ventSalah > 0 && <> {nf(ventSalah)} klaim ventilator ditagih ≥ 96 jam padahal alat mencatat kurang.</>}
      </> : "Belum ada sesi yang terhubung ke klaim untuk filter ini."}
      tabel={rows.length ? tabel : undefined}>
      {rows.length > 0 && (
        <>
          <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-[#c5cbd3]">
            <span className="flex items-center gap-1.5"><span className="h-[9px] w-[9px] rounded-full" style={{ background: UKUR }} />diukur sensor</span>
            <span className="flex items-center gap-1.5"><span className="h-[9px] w-[9px] rounded-full border-2" style={{ borderColor: TAGIH_INK }} />ditagih di klaim</span>
            <span className="flex items-center gap-1.5"><span className="h-[2px] w-4 rounded" style={{ background: BAD }} />jam ditagih tanpa bukti alat</span>
            <span className="flex items-center gap-1.5"><Icon name="alert" className="h-3 w-3 text-[#f87171]" />tidak sesuai (jam atau status alat)</span>
            {vent.length > 0 && <span className="flex items-center gap-1.5"><span className="h-3 w-0 border-l border-dashed border-[#e5e8eb]/70" />batas 96 jam (ICD-9-CM 96.72)</span>}
            <span className="text-[#8f99a8]">sumbu: jam</span>
          </div>
          <div ref={box} className="relative" onPointerLeave={clear}>
            <div className="max-h-[520px] space-y-3 overflow-auto pr-1">
              {vent.length > 0 && grup("Ventilator", vent, true)}
              {lain.length > 0 && grup(vent.length ? "Alat lain" : "Klaim", lain, false)}
            </div>
            <Tooltip tip={tip} />
          </div>
          {rows.length > 18 && (
            <button type="button" onClick={() => setSemua(!semua)} className="mt-1.5 text-[10.5px] text-[#8abbff] hover:underline">{semua ? "Ringkas" : `Lihat semua ${nf(rows.length)} sesi`}</button>
          )}
        </>
      )}
    </Kartu>
  );
}

// ------------------------------------------------------------------------------------------------ hospitals

function TabelRs({ rows, aktif, onPick }: { rows: Model["rsList"]; aktif: string | null; onPick: (id: string) => void }) {
  const urut = useMemo(() => [...rows].sort((a, b) => N(b.selisih_rp) - N(a.selisih_rp) || N(b.tidak_sesuai) - N(a.tidak_sesuai) || a.nama.localeCompare(b.nama, "id")), [rows]);
  return (
    <Kartu title="Rumah sakit" insight="Urut dari selisih tarif terbesar. Klik baris untuk menyaring dashboard ke satu RS.">
      {!urut.length ? <Kosong>Belum ada rumah sakit.</Kosong> : (
        <div className="max-h-[560px] overflow-auto rounded border border-white/5">
          <table className="w-full text-[11.5px]">
            <thead className="sticky top-0 z-10 bg-[#20262d] text-[#abb3bf]">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">RS</th>
                <th className="px-1.5 py-1.5 text-right font-medium">Alat</th>
                <th className="px-1.5 py-1.5 text-right font-medium">Jam</th>
                <th className="px-1.5 py-1.5 text-left font-medium">Utilisasi</th>
                <th className="px-1.5 py-1.5 text-right font-medium" title="Klaim dengan jam ditagih lebih dari jam terukur">Tdk sesuai</th>
                <th className="px-2 py-1.5 text-right font-medium">Selisih</th>
              </tr>
            </thead>
            <tbody>
              {urut.map((r) => (
                <tr key={r.id} onClick={() => onPick(r.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onPick(r.id); }}
                  className={`cursor-pointer border-t border-white/[.04] outline-none hover:bg-white/[.04] focus-visible:bg-white/[.06] ${aktif === r.id ? "bg-[#3987e5]/15" : ""}`}>
                  <td className="max-w-[180px] px-2 py-1">
                    <span className="block truncate text-[#e5e8eb]" title={r.nama}>{r.nama}</span>
                    {r.kabkota && <span className="block truncate text-[10px] text-[#8f99a8]">{r.kabkota}</span>}
                  </td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{nf(N(r.alat))}</td>
                  <td className="px-1.5 py-1 text-right tabular-nums">{compact(N(r.jam))}</td>
                  <td className="px-1.5 py-1">
                    <span className="flex items-center gap-1.5">
                      <span className="h-[6px] w-10 shrink-0 rounded-sm bg-white/[.07]"><span className="block h-full rounded-r-[3px]" style={{ width: `${Math.min(100, N(r.utilisasi_pct))}%`, background: UKUR }} /></span>
                      <span className="tabular-nums text-[#c5cbd3]">{pct(r.utilisasi_pct)}</span>
                    </span>
                  </td>
                  <td className={`px-1.5 py-1 text-right tabular-nums ${N(r.tidak_sesuai) > 0 ? "font-semibold text-[#fca5a5]" : "text-[#8f99a8]"}`}>{nf(N(r.tidak_sesuai))}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${N(r.selisih_rp) > 0 ? "text-[#fca5a5]" : "text-[#8f99a8]"}`}>{N(r.selisih_rp) > 0 ? rp(r.selisih_rp) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Kartu>
  );
}

// ------------------------------------------------------------------------------------------------ utilisation heatmap

// hours on per day, one hue (the app's blue) from dim to bright; a day with no reading is hatched, never zero
const BIN_JAM = [4, 8, 12, 18, 24];
const BIN_ALFA = [0.22, 0.4, 0.58, 0.78, 1];
const warnaJam = (h: number) => (h <= 0 ? "#262d35" : `rgba(57,135,229,${BIN_ALFA[BIN_JAM.findIndex((b) => h <= b) === -1 ? BIN_ALFA.length - 1 : BIN_JAM.findIndex((b) => h <= b)]})`);
const TANPA_DATA = "repeating-linear-gradient(135deg, #2f3740 0 2px, transparent 2px 5px)";

function Heatmap({ alat, model, onPick }: { alat: Alat[]; model: Model; onPick: (p: Pilih) => void }) {
  const { box, tip, at, clear } = useTip();
  const { hari } = model;
  const grup = useMemo(() => {
    const out: { id: string; nama: string; alat: Alat[] }[] = [];
    for (const a of alat) {
      const id = a.rs_id ?? a.rs ?? "—";
      const g = out.find((x) => x.id === id);
      if (g) g.alat.push(a); else out.push({ id, nama: rsNamaAlat(model, a), alat: [a] });
    }
    return out;
  }, [alat, model]);
  const labelTiap = hari.length > 31 ? 7 : hari.length > 16 ? 2 : 1;
  const cols = `minmax(120px,190px) repeat(${hari.length}, minmax(12px,1fr)) 46px`;
  const tabel = (
    <Tabel head={["Alat", "RS", "Jam nyala", "Utilisasi", "Hari aktif"]} angka={[2, 3, 4]}
      rows={alat.map((a) => {
        const h = model.harian.get(a.id);
        return [<span key="a" className="font-mono">{a.id}</span>, rsNamaAlat(model, a), jamFmt(a.jam_nyala ?? sum([...(h?.values() ?? [])].map((x) => N(x.jam)))), pct(a.utilisasi_pct),
          `${nf([...(h?.values() ?? [])].filter((x) => N(x.jam) > 0).length)} / ${nf(hari.length)}`];
      })}
      onRow={(i) => onPick({ kind: "alat", id: alat[i].id })} />
  );
  return (
    <Kartu title="Utilisasi harian per alat" insight="Jam nyala per hari dari sensor clamp. Arahkan ke sel untuk pembagian jalan / siaga; klik untuk detail alat." tabel={alat.length && hari.length ? tabel : undefined}>
      {!alat.length || !hari.length ? <Kosong>Belum ada bacaan harian untuk filter ini.</Kosong> : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-[#c5cbd3]">
            <span className="text-[#8f99a8]">Jam nyala per hari</span>
            <span className="flex items-center gap-1"><span className="h-2.5 w-3 rounded-[2px]" style={{ background: warnaJam(0) }} />0</span>
            {BIN_JAM.map((b, i) => (
              <span key={b} className="flex items-center gap-1"><span className="h-2.5 w-3 rounded-[2px]" style={{ background: `rgba(57,135,229,${BIN_ALFA[i]})` }} />{i === 0 ? `≤ ${b}` : `${BIN_JAM[i - 1]}–${b}`}</span>
            ))}
            <span className="flex items-center gap-1"><span className="h-2.5 w-3 rounded-[2px] border border-[#2f3740]" style={{ background: TANPA_DATA }} />tidak ada bacaan</span>
          </div>
          <div ref={box} className="relative" onPointerLeave={clear}>
            <div className="max-h-[480px] overflow-auto pr-1">
              <div className="grid min-w-[560px] gap-[2px]" style={{ gridTemplateColumns: cols }}>
                <div className="sticky top-0 z-10 bg-[#1c2127]" />
                {hari.map((d, i) => {
                  const dt = new Date(d);
                  const baru = i === 0 || dt.getUTCDate() === 1;
                  return (
                    <div key={d} className="sticky top-0 z-10 bg-[#1c2127] pb-0.5 text-center text-[9.5px] leading-tight tabular-nums text-[#8f99a8]">
                      {i % labelTiap === 0 || baru ? <>{dt.getUTCDate()}{baru && <span className="block text-[9px]">{BULAN[dt.getUTCMonth()]}</span>}</> : ""}
                    </div>
                  );
                })}
                <div className="sticky top-0 z-10 bg-[#1c2127] text-right text-[9.5px] text-[#8f99a8]">util.</div>
                {grup.map((g) => (
                  <Fragment key={g.id}>
                    <div className="truncate pt-1.5 text-[10.5px] font-medium text-[#abb3bf]" style={{ gridColumn: "1 / -1" }}>{g.nama}</div>
                    {g.alat.map((a) => {
                      const h = model.harian.get(a.id);
                      return (
                        <Fragment key={a.id}>
                          <button type="button" onClick={() => onPick({ kind: "alat", id: a.id })}
                            className="flex min-w-0 items-center gap-1.5 truncate rounded-sm pr-1 text-left text-[10.5px] text-[#e5e8eb] outline-none hover:bg-white/[.05] focus-visible:ring-1 focus-visible:ring-[#3987e5]">
                            <StatusDot status={a.status} size={6} />
                            <span className="truncate font-mono">{a.id}</span>
                            {a.kunci_dicabut && <Icon name="lock" className="h-2.5 w-2.5 shrink-0 text-[#f87171]" />}
                          </button>
                          {hari.map((d) => {
                            const x = h?.get(d);
                            const jam = x ? N(x.jam) || sum(modeParts(x.mode_jam).filter((p) => p.k !== "mati").map((p) => p.v)) : null;
                            const t = { title: `${a.id} · ${tgl(d)}`, lines: jam === null ? [{ value: "—", label: "tidak ada bacaan" }] : [{ key: UKUR, value: jamFmt(jam), label: "nyala" }, ...modeLines(x?.mode_jam)] };
                            return (
                              <div key={d} title={`${a.id} ${tgl(d)}: ${jam === null ? "tidak ada bacaan" : jamFmt(jam)}`}
                                className="h-[15px] cursor-pointer rounded-[2px] hover:outline hover:outline-1 hover:outline-white/70"
                                style={jam === null ? { background: TANPA_DATA } : { background: warnaJam(jam) }}
                                onPointerMove={(e) => at(e, t)} onClick={() => onPick({ kind: "alat", id: a.id })} />
                            );
                          })}
                          <div className="text-right text-[10px] leading-[15px] tabular-nums text-[#c5cbd3]">{pct(a.utilisasi_pct)}</div>
                        </Fragment>
                      );
                    })}
                  </Fragment>
                ))}
              </div>
            </div>
            <Tooltip tip={tip} />
          </div>
        </>
      )}
    </Kartu>
  );
}

// ------------------------------------------------------------------------------------------------ binding timeline (Gantt)

function Gantt({ alat, sesi, peringatan, model, onPick }: { alat: Alat[]; sesi: Sesi[]; peringatan: Peringatan[]; model: Model; onPick: (p: Pilih) => void }) {
  const { box, tip, at, clear } = useTip();
  const [masalah, setMasalah] = useState(false);
  const { t0, t1, hari, akhirPeriode } = model;
  const span = t1 - t0 || 1;
  const x = (ms: number) => (100 * (Math.min(t1, Math.max(t0, ms)) - t0)) / span;

  const rows = useMemo(() => {
    const by = new Map<string, Sesi[]>();
    for (const s of sesi) if (s.device_id) by.set(s.device_id, [...(by.get(s.device_id) ?? []), s]);
    // alerts about a binding, drawn on their device's row: on without a patient (amber), bound twice (red)
    const tanda = new Map<string, Peringatan[]>();
    for (const p of peringatan) if ((p.jenis === "tanpa_pasien" || p.jenis === "binding_tumpang") && p.device_id) tanda.set(p.device_id, [...(tanda.get(p.device_id) ?? []), p]);
    return alat.filter((a) => by.has(a.id) || tanda.has(a.id)).map((a) => {
      const ss = by.get(a.id) ?? [], tt = tanda.get(a.id) ?? [];
      return { a, ss, seg: model.tumpangSeg.get(a.id) ?? [], tumpang: model.tumpangAlat.has(a.id), tanpa: ss.some((s) => !s.peserta) || tt.some((p) => p.jenis === "tanpa_pasien"), tanda: tt };
    });
  }, [alat, sesi, peringatan, model]);
  const tampil = masalah ? rows.filter((r) => r.tumpang || r.tanpa) : rows;
  const nTumpang = rows.filter((r) => r.tumpang).length, nTanpa = rows.filter((r) => r.tanpa).length;
  const modeAda = useMemo(() => {
    const seen = new Map<string, ReturnType<typeof modeInfo>>();
    for (const r of rows) for (const s of r.ss) { const d = dominan(s.mode_jam); if (d && !seen.has(d.label)) seen.set(d.label, d); }
    return [...seen.values()].sort((a, b) => a.order - b.order);
  }, [rows]);
  const garisHari = `repeating-linear-gradient(90deg, ${GRID} 0 1px, transparent 1px ${hari.length ? 100 / hari.length : 100}%)`;
  const labelTiap = hari.length > 31 ? 7 : hari.length > 16 ? 2 : 1;

  const tipSesi = (s: Sesi, lain: string[]): Omit<NonNullable<Tip>, "x" | "y"> => ({
    title: `${s.sesi_id} · ${s.device_id ?? ""}`,
    lines: [
      { value: s.peserta || "tanpa pasien", label: s.kunjungan ? `kunjungan ${s.kunjungan}` : "pasien" },
      { value: `${waktu(s.mulai)} – ${waktu(s.selesai)}`, label: "" },
      { key: UKUR, value: jamFmt(s.jam), label: "diukur" },
      ...modeLines(s.mode_jam),
      ...(s.klaim_id ? [{ value: s.klaim_id, label: "klaim" }] : []),
      ...(lain.length ? [{ key: BAD, value: "Tumpang", label: `dengan ${lain.map((id) => model.sesiById.get(id)?.peserta ?? id).join(", ")}` }] : []),
    ],
  });

  return (
    <Kartu title="Ikatan alat ↔ pasien (timeline)"
      insight={rows.length ? <>Setiap batang = satu sesi alat terikat ke satu pasien, diwarnai status utamanya (jalan / siaga).{" "}
        {nTumpang > 0 ? <b className="font-semibold text-[#fca5a5]">{nf(nTumpang)} alat terikat ke dua pasien pada jam yang sama.</b> : "Tidak ada alat yang terikat ke dua pasien sekaligus."}
        {nTanpa > 0 && <> {nf(nTanpa)} alat menyala tanpa pasien.</>}</> : "Belum ada sesi untuk filter ini."}
      kanan={rows.length ? (
        <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-[#c5cbd3]">
          <input type="checkbox" checked={masalah} onChange={(e) => setMasalah(e.target.checked)} className="accent-[#3987e5]" />hanya yang bermasalah
        </label>
      ) : undefined}>
      {rows.length > 0 && hari.length > 0 && (
        <>
          <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-[#c5cbd3]">
            {modeAda.map((mo) => <Swatch key={mo.label} color={mo.color} label={mo.label} />)}
            <Swatch color={BAD} label="dua pasien, jam yang sama" hatch />
            <Swatch color={WARN} label="tanpa pasien" hollow />
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rotate-45" style={{ background: WARN }} />peringatan tanpa jam selesai</span>
            {akhirPeriode !== null && <span className="flex items-center gap-1.5"><span className="h-3 w-0 border-l border-dashed border-[#8f99a8]" />akhir periode klaim</span>}
          </div>
          <div ref={box} className="relative" onPointerLeave={clear}>
            <div className="max-h-[520px] overflow-auto pr-1">
              <div className="min-w-[720px]">
                <div className="sticky top-0 z-10 grid grid-cols-[180px_minmax(0,1fr)] bg-[#1c2127]">
                  <span className="text-[10px] text-[#8f99a8]">Alat</span>
                  <span className="relative h-5">
                    {hari.map((d, i) => (i % labelTiap === 0 ? (
                      <span key={d} className="absolute bottom-0.5 pl-0.5 text-[9.5px] tabular-nums text-[#8f99a8]" style={{ left: `${x(d)}%` }}>{tgl(d)}</span>
                    ) : null))}
                  </span>
                </div>
                {!tampil.length && <Kosong>Tidak ada alat bermasalah.</Kosong>}
                {tampil.map((r) => (
                  <div key={r.a.id} className="grid grid-cols-[180px_minmax(0,1fr)] border-t border-white/[.04]">
                    <button type="button" onClick={() => onPick({ kind: "alat", id: r.a.id })}
                      className="flex min-w-0 items-center gap-1.5 py-1 pr-2 text-left outline-none hover:bg-white/[.04] focus-visible:ring-1 focus-visible:ring-[#3987e5]">
                      {r.tumpang ? <Icon name="split" className="h-3 w-3 shrink-0 text-[#f87171]" /> : r.tanpa ? <Icon name="eye" className="h-3 w-3 shrink-0 text-[#fbbf24]" /> : <span className="w-3 shrink-0" />}
                      <span className="min-w-0">
                        <span className={`block truncate font-mono text-[10.5px] ${r.tumpang ? "text-[#fca5a5]" : "text-[#e5e8eb]"}`}>{r.a.id}</span>
                        <span className="block truncate text-[9.5px] text-[#8f99a8]">{rsNamaAlat(model, r.a)}</span>
                      </span>
                    </button>
                    <div className="relative min-h-[30px]" style={{ backgroundImage: garisHari }}>
                      {r.ss.map((s) => {
                        const rg = rentang(s);
                        if (!rg || rg[1] <= t0 || rg[0] >= t1) return null;
                        const lain = model.tumpang.get(s.sesi_id) ?? [];
                        const d = dominan(s.mode_jam);
                        const tanpaPasien = !s.peserta;
                        const w = x(rg[1]) - x(rg[0]);
                        const t = tipSesi(s, lain);
                        return (
                          <button key={s.sesi_id} type="button" onClick={() => onPick({ kind: "sesi", id: s.sesi_id })} onPointerMove={(e) => at(e, t)} onFocus={(e) => at(e, t)} onBlur={clear}
                            aria-label={`${s.sesi_id} ${s.peserta ?? "tanpa pasien"} ${jamFmt(s.jam)}`}
                            className="absolute inset-y-[6px] flex min-w-[3px] items-center overflow-hidden rounded-[3px] px-1 outline-none hover:brightness-125 focus-visible:ring-1 focus-visible:ring-white"
                            style={{
                              left: `${x(rg[0])}%`, width: `${w}%`,
                              ...(tanpaPasien ? { border: `1px dashed ${WARN}`, background: `${WARN}14` } : { background: d?.color ?? UKUR }),
                              boxShadow: lain.length ? `0 0 0 1.5px ${BAD}` : `0 0 0 1px ${SURFACE}`,
                            }}>
                            {w > 5 && <span className={`truncate text-[9.5px] font-medium ${tanpaPasien ? "text-[#fde68a]" : "text-white"}`}>{s.peserta || "tanpa pasien"}</span>}
                          </button>
                        );
                      })}
                      {r.seg.map(([lo, hi], i) => (
                        <span key={`seg-${i}`} className="pointer-events-none absolute inset-y-[3px] rounded-[2px]"
                          style={{ left: `${x(lo)}%`, width: `${Math.max(0.25, x(hi) - x(lo))}%`, background: `repeating-linear-gradient(135deg, ${BAD}cc 0 2px, transparent 2px 5px)`, border: `1px solid ${BAD}` }} />
                      ))}
                      {akhirPeriode !== null && <span className="pointer-events-none absolute inset-y-0 w-0 border-l border-dashed border-[#8f99a8]/60" style={{ left: `${x(akhirPeriode)}%` }} />}
                      {r.tanda.map((p, i) => {
                        const rg = rentang({ mulai: p.mulai, selesai: p.selesai });
                        const w0 = rg ? rg[0] : wall(p.waktu);
                        if (w0 === null || w0 >= t1 || (rg ? rg[1] : w0) < t0) return null;
                        const ganda = p.jenis === "binding_tumpang", c = ganda ? BAD : WARN;
                        const t = { title: peringatanInfo(p.jenis).label, lines: [{ key: c, value: waktu(p.waktu ?? p.mulai), label: p.judul ?? peringatanInfo(p.jenis).kalimat }] };
                        const ke = tujuanPeringatan(model, p);
                        const buka = ke ? () => onPick(ke) : undefined;
                        return rg ? (
                          <button key={`tp-${i}`} type="button" onClick={buka} onPointerMove={(e) => at(e, t)} onFocus={(e) => at(e, t)} onBlur={clear} aria-label={peringatanInfo(p.jenis).label}
                            className="absolute inset-y-[6px] rounded-[3px] outline-none focus-visible:ring-1 focus-visible:ring-white"
                            style={{ left: `${x(rg[0])}%`, width: `${x(rg[1]) - x(rg[0])}%`, ...(ganda ? { background: `repeating-linear-gradient(135deg, ${BAD}cc 0 2px, transparent 2px 5px)`, border: `1px solid ${BAD}` } : { border: `1px dashed ${WARN}`, background: `${WARN}14` }) }} />
                        ) : (
                          <button key={`tp-${i}`} type="button" onClick={buka} onPointerMove={(e) => at(e, t)} onFocus={(e) => at(e, t)} onBlur={clear} aria-label={peringatanInfo(p.jenis).label}
                            className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 outline-none focus-visible:ring-1 focus-visible:ring-white"
                            style={{ left: `${x(w0)}%`, background: c, boxShadow: `0 0 0 2px ${SURFACE}` }} />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <Tooltip tip={tip} />
          </div>
        </>
      )}
    </Kartu>
  );
}

// ------------------------------------------------------------------------------------------------ detail drawer

function Laci({ pilih, model, bisaKembali, onKembali, onTutup, onPick }: {
  pilih: Pilih; model: Model; bisaKembali: boolean; onKembali: () => void; onTutup: () => void; onPick: (p: Pilih) => void;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onTutup(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onTutup]);
  const a = pilih.kind === "alat" ? model.alatById.get(pilih.id) : undefined;
  const s = pilih.kind === "sesi" ? model.sesiById.get(pilih.id) : undefined;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/45" onClick={onTutup} aria-hidden />
      <aside role="dialog" aria-modal="true" aria-label={pilih.kind === "alat" ? `Detail alat ${pilih.id}` : `Detail sesi ${pilih.id}`}
        className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[480px] flex-col border-l border-white/10 bg-[#1c2127] text-[12px] text-[#c5cbd3] shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-2.5">
          {bisaKembali && (
            <button type="button" onClick={onKembali} className="grid h-6 w-6 place-items-center rounded text-[#abb3bf] hover:bg-white/10 hover:text-white" title="Kembali"><Icon name="left" className="h-3.5 w-3.5" /></button>
          )}
          <p className="min-w-0 flex-1 truncate text-[11px] uppercase tracking-wide text-[#8f99a8]">{pilih.kind === "alat" ? "Detail alat" : "Detail sesi"}</p>
          <button type="button" onClick={onTutup} className="grid h-6 w-6 place-items-center rounded text-[#abb3bf] hover:bg-white/10 hover:text-white" title="Tutup (Esc)"><Icon name="x" className="h-3.5 w-3.5" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {a ? <DetailAlat a={a} model={model} onPick={onPick} /> : s ? <DetailSesi s={s} model={model} onPick={onPick} /> : <Kosong>{pilih.id} tidak ada di data ini.</Kosong>}
        </div>
      </aside>
    </>
  );
}

const Subjudul = ({ children }: { children: ReactNode }) => <p className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wide text-[#8f99a8]">{children}</p>;
const Angka = ({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) => (
  <div className="rounded border border-white/[.07] bg-[#111418] px-2.5 py-2">
    <p className="text-[10.5px] text-[#8f99a8]">{label}</p>
    <p className="mt-0.5 text-[14px] font-semibold tabular-nums" style={{ color: tone ?? "#fff" }}>{value}</p>
  </div>
);

function DaftarPeringatan({ items, model, onPick }: { items: Peringatan[]; model: Model; onPick: (p: Pilih) => void }) {
  if (!items.length) return null;
  return (
    <>
      <Subjudul>Peringatan</Subjudul>
      <ul className="space-y-1">
        {items.map((p, i) => {
          const t = peringatanInfo(p.jenis);
          const ke = tujuanPeringatan(model, p);
          return (
            <li key={i}>
              <button type="button" disabled={!ke} onClick={ke ? () => onPick(ke) : undefined} className="flex w-full items-start gap-2 rounded px-1 py-1 text-left enabled:hover:bg-white/[.04]">
                <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full" style={{ background: `${t.color}22`, color: t.color }}><Icon name={t.icon} className="h-3 w-3" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11.5px] leading-snug text-[#e5e8eb]">{p.judul || t.kalimat || t.label}</span>
                  <span className="block text-[10.5px] text-[#8f99a8]">{[t.label, p.waktu ? waktu(p.waktu) : null].filter(Boolean).join(" · ")}</span>
                </span>
                {N(p.selisih_rp) > 0 && <span className="shrink-0 text-[11px] font-semibold tabular-nums text-[#fca5a5]">{rp(p.selisih_rp)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function BarisSesi({ s, model, onPick }: { s: Sesi; model: Model; onPick: (p: Pilih) => void }) {
  const h = hasilInfo(s.hasil);
  const lain = model.tumpang.get(s.sesi_id)?.length ?? 0;
  return (
    <button type="button" onClick={() => onPick({ kind: "sesi", id: s.sesi_id })}
      className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left hover:bg-white/[.04] ${lain ? "border-[#f87171]/50" : "border-white/[.07]"}`}>
      <span className="h-6 w-1 shrink-0 rounded" style={{ background: s.peserta ? dominan(s.mode_jam)?.color ?? UKUR : "transparent", border: s.peserta ? undefined : `1px dashed ${WARN}` }} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[11.5px] text-[#e5e8eb]">
          <span className="font-medium">{s.peserta || "tanpa pasien"}</span>
          {lain > 0 && <Icon name="split" className="h-3 w-3 text-[#f87171]" />}
          {s.klaim_id && <span className="truncate font-mono text-[10px] text-[#8f99a8]">{s.klaim_id}</span>}
        </span>
        <span className="block truncate text-[10.5px] text-[#8f99a8]">{waktu(s.mulai)} – {waktu(s.selesai)} · {jamFmt(s.jam)}{typeof s.jam_ditagih === "number" ? ` · ditagih ${jamFmt(s.jam_ditagih)}` : ""}</span>
      </span>
      {s.hasil && <Pill color={h.color}>{h.label}</Pill>}
    </button>
  );
}

function BatangMode({ mj, total }: { mj?: ModeJam | null; total?: number }) {
  const ps = modeParts(mj);
  const t = Math.max(N(total), sum(ps.map((p) => p.v))) || 1;
  if (!ps.length) return <p className="text-[11px] text-[#8f99a8]">Pembagian status alat tidak tersedia.</p>;
  return (
    <div>
      <div className="flex h-3 gap-[2px] overflow-hidden rounded-[3px]">
        {ps.map((p) => <span key={p.k} title={`${p.label}: ${jamFmt(p.v)}`} style={{ width: `${(100 * p.v) / t}%`, background: p.color }} />)}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {ps.map((p) => (
          <span key={p.k} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: p.color }} />{p.label}
            <span className="tabular-nums text-white">{jamFmt(p.v)}</span><span className="tabular-nums text-[#8f99a8]">{nf((100 * p.v) / t)}%</span></span>
        ))}
      </div>
    </div>
  );
}

function HarianAlat({ a, model }: { a: Alat; model: Model }) {
  const { box, tip, at, clear } = useTip();
  const h = model.harian.get(a.id);
  const { hari } = model;
  if (!hari.length || !h?.size) return <p className="text-[11px] text-[#8f99a8]">Belum ada bacaan harian.</p>;
  const modeAda = new Map<string, ReturnType<typeof modeInfo>>();
  for (const x of h.values()) for (const p of modeParts(x.mode_jam)) if (!modeAda.has(p.label)) modeAda.set(p.label, p);
  return (
    <div ref={box} className="relative" onPointerLeave={clear}>
      <div className="relative flex h-[96px] items-end gap-[2px] border-b border-[#383f47]">
        {[6, 12, 18, 24].map((g) => <span key={g} className="pointer-events-none absolute inset-x-0 border-t border-[#2c333b]" style={{ bottom: `${(100 * g) / 24}%` }} />)}
        {hari.map((d) => {
          const x = h.get(d);
          const ps = modeParts(x?.mode_jam).filter((p) => p.k !== "mati");
          const jam = x ? N(x.jam) || sum(ps.map((p) => p.v)) : null;
          const t = { title: tgl(d), lines: jam === null ? [{ value: "—", label: "tidak ada bacaan" }] : [{ key: UKUR, value: jamFmt(jam), label: "nyala" }, ...modeLines(x?.mode_jam)] };
          return (
            <div key={d} className="relative z-[1] flex h-full min-w-0 flex-1 flex-col-reverse gap-[1px] overflow-hidden" onPointerMove={(e) => at(e, t)}
              style={jam === null ? { background: TANPA_DATA } : undefined}>
              {ps.length ? ps.map((p, i) => (
                <span key={p.k} className={i === ps.length - 1 ? "rounded-t-[3px]" : ""} style={{ height: `${(100 * Math.min(24, p.v)) / 24}%`, background: p.color, flexShrink: 0 }} />
              )) : jam ? <span className="rounded-t-[3px]" style={{ height: `${(100 * Math.min(24, jam)) / 24}%`, background: UKUR, flexShrink: 0 }} /> : null}
            </div>
          );
        })}
      </div>
      <div className="mt-0.5 flex justify-between text-[9.5px] tabular-nums text-[#8f99a8]">
        <span>{tgl(hari[0])}</span><span>skala 0–24 jam per hari</span><span>{tgl(hari[hari.length - 1])}</span>
      </div>
      {modeAda.size > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px]">{[...modeAda.values()].sort((p, q) => p.order - q.order).map((p) => <Swatch key={p.label} color={p.color} label={p.label} />)}</div>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

function DetailAlat({ a, model, onPick }: { a: Alat; model: Model; onPick: (p: Pilih) => void }) {
  const st = statusInfo(a.status);
  const ss = model.sesiByAlat.get(a.id) ?? [];
  const pr = model.m.peringatan.filter((p) => p.device_id === a.id).sort((p, q) => (wall(q.waktu) ?? 0) - (wall(p.waktu) ?? 0));
  const salah = ss.filter((s) => s.hasil === "tidak_sesuai").length;
  return (
    <div>
      <div className="flex items-start gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#2dd4bf]/15 text-[#2dd4bf]"><Icon name="device" className="h-4.5 w-4.5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-white">{a.nama ?? model.jenisNama(a.jenis)}</p>
          <p className="font-mono text-[11px] text-[#abb3bf]">{a.id}</p>
          <p className="mt-0.5 text-[11px] text-[#8f99a8]">{model.jenisNama(a.jenis)} · {rsNamaAlat(model, a)}</p>
        </div>
        <span className="flex items-center gap-1.5 rounded border border-white/10 px-1.5 py-0.5 text-[11px]" style={{ color: st.color }}><StatusDot status={a.status} />{st.label}</span>
      </div>
      {a.kunci_dicabut && (
        <p className="mt-3 flex items-start gap-2 rounded border border-[#f87171]/40 bg-[#f87171]/10 px-2.5 py-2 text-[11.5px] text-[#fecaca]">
          <Icon name="lock" className="mt-px h-3.5 w-3.5 shrink-0" />Kunci alat ini sudah dicabut{a.dicabut_pada ? ` pada ${waktu(a.dicabut_pada)}` : ""}. Bacaan yang ditandatangani setelahnya tidak diakui sebagai bukti.
        </p>
      )}
      {model.tumpangAlat.has(a.id) && (
        <p className="mt-2 flex items-start gap-2 rounded border border-[#f87171]/40 bg-[#f87171]/10 px-2.5 py-2 text-[11.5px] text-[#fecaca]">
          <Icon name="split" className="mt-px h-3.5 w-3.5 shrink-0" />Alat ini pernah terikat ke dua pasien pada jam yang sama.
        </p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Angka label="Jam nyala (periode)" value={jamFmt(a.jam_nyala)} />
        <Angka label="Utilisasi" value={pct(a.utilisasi_pct)} />
        <Angka label="Sesi" value={nf(N(a.sesi) || ss.length)} />
        <Angka label="Klaim tidak sesuai" value={nf(salah)} tone={salah ? "#fca5a5" : undefined} />
      </div>
      {a.terakhir && <p className="mt-2 text-[11px] text-[#8f99a8]">Terakhir terlihat {waktu(a.terakhir)}.</p>}
      {a.mode_jam && modeParts(a.mode_jam).length > 0 && (
        <>
          <Subjudul>Status alat dalam periode (jalan / siaga / mati)</Subjudul>
          <BatangMode mj={a.mode_jam} />
        </>
      )}

      <Subjudul>Pemakaian harian</Subjudul>
      <HarianAlat a={a} model={model} />

      <Subjudul>Sesi & ikatan pasien ({nf(ss.length)})</Subjudul>
      {ss.length ? <div className="space-y-1">{ss.map((s) => <BarisSesi key={s.sesi_id} s={s} model={model} onPick={onPick} />)}</div> : <p className="text-[11px] text-[#8f99a8]">Tidak ada sesi dalam periode.</p>}

      <DaftarPeringatan items={pr} model={model} onPick={onPick} />
    </div>
  );
}

function SalinKlaim({ id }: { id: string }) {
  const [salin, setSalin] = useState(false);
  return (
    <button type="button" title="Salin nomor klaim"
      onClick={() => { navigator.clipboard?.writeText(id).then(() => { setSalin(true); setTimeout(() => setSalin(false), 1500); }).catch(() => {}); }}
      className="inline-flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-[10.5px] text-[#c5cbd3] hover:bg-white/[.06]">
      <Icon name={salin ? "check" : "copy"} className="h-3 w-3" />{salin ? "Tersalin" : "Salin"}
    </button>
  );
}

/** One link of the binding chain device <-> patient <-> visit <-> claim. */
function Simpul({ icon, label, value, onClick, warn }: { icon: IconName; label: string; value: string; onClick?: () => void; warn?: boolean }) {
  const isi = (
    <>
      <span className="flex items-center gap-1 text-[9.5px] uppercase tracking-wide text-[#8f99a8]"><Icon name={icon} className="h-3 w-3" />{label}</span>
      <span className={`mt-0.5 block truncate font-mono text-[11px] ${warn ? "text-[#fde68a]" : "text-[#e5e8eb]"}`}>{value}</span>
    </>
  );
  const cls = `min-w-0 flex-1 rounded border px-2 py-1.5 text-left ${warn ? "border-dashed border-[#fbbf24]/60" : "border-white/[.08]"} bg-[#111418]`;
  return onClick ? <button type="button" onClick={onClick} className={`${cls} hover:border-white/30`}>{isi}</button> : <div className={cls}>{isi}</div>;
}

function DetailSesi({ s, model, onPick }: { s: Sesi; model: Model; onPick: (p: Pilih) => void }) {
  const a = s.device_id ? model.alatById.get(s.device_id) : undefined;
  const h = hasilInfo(s.hasil);
  const vent = isVent(a, s);
  const ukur = N(s.jam), tagih = typeof s.jam_ditagih === "number" && isFinite(s.jam_ditagih) ? s.jam_ditagih : null;
  const top = Math.max(ukur, tagih ?? 0, vent ? BATAS_VENT * 1.15 : 1) * 1.05;
  const selisih = N(s.selisih_rp) || (s.klaim_id ? model.selisihKlaim.get(s.klaim_id) ?? 0 : 0);
  const lain = (model.tumpang.get(s.sesi_id) ?? []).map((id) => model.sesiById.get(id)).filter((x): x is Sesi => !!x);
  const rg = rentang(s);
  const pr = model.m.peringatan.filter((p) => (p.sesi_id && p.sesi_id === s.sesi_id) || (p.klaim_id && p.klaim_id === s.klaim_id)
    || (!p.klaim_id && !p.sesi_id && p.device_id === s.device_id && rg && (wall(p.waktu) ?? -1) >= rg[0] && (wall(p.waktu) ?? -1) <= rg[1]));
  const kalimat = kalimatSesi(s, a);
  const jg = s.jangkar && typeof s.jangkar === "object" ? s.jangkar : null;
  const jgInfo = jg?.status === "ok" ? { label: "Cocok, sebelum klaim", color: OK } : jg?.status === "tidak_cocok" ? { label: "Tidak cocok", color: BAD }
    : jg?.status === "terlambat" ? { label: "Dijangkarkan setelah klaim", color: WARN } : { label: jg?.status ?? "—", color: "#8f99a8" };
  const bar = (label: string, v: number | null, color: string, hollow?: boolean) => (
    <div>
      <div className="flex justify-between text-[11px]"><span>{label}</span><span className="font-semibold tabular-nums text-white">{jamFmt(v)}</span></div>
      <div className="relative mt-0.5 h-2.5 rounded-sm bg-white/[.06]">
        {v !== null && <div className="h-full rounded-r-[4px]" style={{ width: `${Math.min(100, (100 * v) / top)}%`, ...(hollow ? { border: `1.5px solid ${color}` } : { background: color }) }} />}
        {vent && <span className="absolute -inset-y-1 w-0 border-l border-dashed border-[#e5e8eb]/70" style={{ left: `${(100 * BATAS_VENT) / top}%` }} />}
      </div>
    </div>
  );
  return (
    <div>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-white">Sesi {s.sesi_id}</p>
          <p className="text-[11px] text-[#8f99a8]">{a ? `${a.nama ?? model.jenisNama(a.jenis)} · ${rsNamaAlat(model, a)}` : s.device_id ?? "—"}</p>
        </div>
        {s.hasil && <Pill color={h.color}>{h.label}</Pill>}
      </div>
      {kalimat && (
        <p className="mt-3 rounded border px-2.5 py-2 text-[12px] leading-relaxed" style={{ borderColor: `${h.color}55`, background: `${h.color}12`, color: "#e5e8eb" }}>{kalimat}</p>
      )}

      <Subjudul>Ikatan</Subjudul>
      <div className="flex items-stretch gap-1">
        <Simpul icon="device" label="Alat" value={s.device_id ?? "—"} onClick={a ? () => onPick({ kind: "alat", id: a.id }) : undefined} />
        <span className="self-center text-[#5f6b7c]">↔</span>
        <Simpul icon="eye" label="Pasien" value={s.peserta || "tanpa pasien"} warn={!s.peserta} />
        <span className="self-center text-[#5f6b7c]">↔</span>
        <Simpul icon="doc" label="Kunjungan" value={s.kunjungan || "—"} />
        <span className="self-center text-[#5f6b7c]">↔</span>
        <Simpul icon="parse" label="Klaim" value={s.klaim_id || "belum ada"} />
      </div>
      {s.klaim_id && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          <SalinKlaim id={s.klaim_id} />
          <a href="/aip-jkn?tab=cabang" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#8abbff] hover:underline">
            Buka laporan kantor cabang<Icon name="external" className="h-3 w-3" />
          </a>
          {s.kode && <span className="text-[#8f99a8]">Kode prosedur di klaim: <span className="font-mono text-[#e5e8eb]">{s.kode}</span></span>}
        </div>
      )}

      <Subjudul>Jam diukur vs jam ditagih</Subjudul>
      <div className="space-y-2 rounded border border-white/[.07] bg-[#111418] p-2.5">
        {bar("Diukur sensor", ukur, UKUR)}
        {bar("Ditagih di klaim", tagih, TAGIH_INK, true)}
        {vent && <p className="text-[10.5px] text-[#8f99a8]">Garis putus-putus: batas {BATAS_VENT} jam (ICD-9-CM 96.72). Tarif INA-CBG untuk ≥ {BATAS_VENT} jam jauh lebih tinggi.</p>}
        {selisih > 0 && <p className="text-[11.5px]">Selisih tarif: <b className="text-[#fca5a5]">{rp(selisih)}</b></p>}
      </div>

      <Subjudul>Status alat selama sesi (jalan / siaga / mati)</Subjudul>
      <BatangMode mj={s.mode_jam} total={s.jam} />

      <Subjudul>Waktu</Subjudul>
      <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-y-1 text-[11.5px]">
        <dt className="text-[#8f99a8]">Mulai</dt><dd className="text-[#e5e8eb]">{waktu(s.mulai)}</dd>
        <dt className="text-[#8f99a8]">Selesai</dt><dd className="text-[#e5e8eb]">{waktu(s.selesai)}</dd>
        {s.alasan_selesai && <><dt className="text-[#8f99a8]">Alasan selesai</dt><dd className="text-[#e5e8eb]">{s.alasan_selesai.replace(/_/g, " ")}</dd></>}
      </dl>

      {jg && (
        <>
          <Subjudul>Jangkar bukti</Subjudul>
          <div className="space-y-1 rounded border border-[#a78bfa]/30 bg-[#a78bfa]/10 p-2.5 text-[11.5px]">
            <p className="flex items-center gap-1.5"><Icon name="lock" className="h-3.5 w-3.5 text-[#c4b5fd]" /><span style={{ color: jgInfo.color }} className="font-medium">{jgInfo.label}</span></p>
            {jg.root && <p className="truncate font-mono text-[10.5px] text-[#ddd6fe]" title={jg.root}>root {jg.root}</p>}
            {jg.waktu && <p className="text-[10.5px] text-[#c4b5fd]">dijangkarkan {waktu(jg.waktu)}</p>}
            {jg.tx && <p className="truncate font-mono text-[10.5px] text-[#c4b5fd]" title={jg.tx}>tx {jg.tx}</p>}
          </div>
        </>
      )}

      {lain.length > 0 && (
        <>
          <Subjudul>Tumpang dengan sesi lain</Subjudul>
          <p className="mb-1.5 text-[11.5px] text-[#fecaca]">Pada jam yang sama alat ini juga terikat ke {lain.map((x) => x.peserta).filter(Boolean).join(", ")}. Satu alat tidak bisa merawat dua pasien sekaligus.</p>
          <div className="space-y-1">{lain.map((x) => <BarisSesi key={x.sesi_id} s={x} model={model} onPick={onPick} />)}</div>
        </>
      )}

      <DaftarPeringatan items={pr} model={model} onPick={onPick} />
    </div>
  );
}
