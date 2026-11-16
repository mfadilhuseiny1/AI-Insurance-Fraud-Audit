"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { wib } from "@/components/aip/aipRun";
import { CABANG_RUN_DIPILIH, pilihRunCabang } from "@/components/aip/cabangPilih";
import { bawaanAuditDemo, cabangPoll } from "@/components/aip/demoCabang";
import { NetworkOrb, usdLimit } from "@/components/aip/ProyekKonsultan";
import { SwarmCabangBagan, type IotBagan, type KasusBagan, type LangsungBagan, type SampulBagan } from "@/components/aip/SwarmCabangBagan";

/* Projects of the AI Agent Swarm Branch (the user, 2026-11-14: "tambahin fitur create new project kayak di audit nasional, jadi
   enak navigasi nya buat project audit baru, nanti di project audit baru ada create new audit, bisa milih mau audit tema apa
   aja, bisa select satu atau multiple tema, atau select all"). The national AI Agent Swarm's sidebar (KonsultanView,
   ProyekKonsultan), for the branch: a project holds one branch (or all of them) and its data; each audit picks its clinical
   themes and a cost cap. An audit with a run shows that run's report (SwarmCabangView, given as children, told through
   cabangPilih.ts); the project home and an audit not run yet show here, in its place. Data: /api/swarm-cabang/proyek.
   An audit can also read IoT device data (the user, 2026-11-15: "in case I have IoT data, patient data and claim data, I can run AI
   Agent Swarm and create the same report"): none, synthetic, or a folder under "Data Sintetis/" or data/iot.
   A project names its theme focus when it is made (the user, 2026-11-15: "di awal tuh ketika saya mau buat project, dan klik mulai
   audit, ada pilihan tema. Mau jantung, atau tema lain gitu" — a full audit had read every theme though only cardiology was meant):
   a required "Fokus tema" in "Buat proyek baru", shown on the project; a new audit starts from it ("Tema audit ini: …"), and
   "Mulai audit" always asks once more with what will be read (themes, claims, cost cap, IoT data), noting a theme choice that
   differs from the project's focus. */

type Status = "siap" | "berjalan" | "selesai" | "gagal" | "dibatalkan";
type RunInfo = { id: string; label: string; dijalankan: string | null; model?: string; kc: number; kc_pilih?: string | null; biaya_usd?: number;
  operasional?: { klaim: number; antrean: number; nilai_ditandai_rp: number; estimasi_kerugian_rp?: number } };
type Audit = { id: string; label: string; tema: string[] | null; tema_nama: string[]; batas_usd: number; status: Status; run: string | null;
  dibuat_pada: string; dibuat_oleh: string; dimulai_pada?: string; pesan?: string; perintah?: string; run_info: RunInfo | null;
  progres: { tahap?: string; persen?: number; pesan?: string } | null; iot?: { sumber: "sintetis" | "folder"; tampil: string } | null; iot_tampil?: string;
  /** the data size: the last N replicas of a theme dataset (null or absent = every replica) */ replika?: number | null };
type IotMode = "tidak" | "sintetis" | "folder";
/** tema_fokus: the project's theme focus (tema_klaim codes), null = every theme; tema_fokus_nama: their names. */
type Proyek = { id: string; nama: string; deskripsi: string; kc: string | null; kc_nama: string | null; dataset: string; dataset_nama: string;
  tema_fokus?: string[] | null; tema_fokus_nama?: string[]; dibuat_pada: string; dibuat_oleh: string; virtual?: boolean; audit: Audit[] };
type Dataset = { id: string; nama: string; keterangan: string; kc: string | null; kc_nama: string | null; tema_utama: string | null; siap: boolean; perlu?: string };
type Kc = { id: string; nama: string; provinsi: string };
type Daftar = { proyek: Proyek[]; dataset: Dataset[]; kc: Kc[]; admin: boolean; peluncur: { aktif: boolean }; batas_usd: { bawaan: number; maks: number } };
type TemaItem = { kode: string; nama: string; klaim: number; tagihan_rp?: number; rekam_medis?: boolean; per_replika?: number[] };
/** tanpa_jumlah: the counts are not computed for this data yet (a new project's fixed theme list). */
type DaftarTema = { proyek: string | null; dataset: string; kc: string | null; sumber: string; catatan: string | null; klaim: number; tema_utama: string | null;
  tema: TemaItem[]; tanpa_jumlah?: boolean; replika?: number; replika_ids?: number[] };
type JawabMulai = { dijalankan?: boolean; perintah?: string; pesan?: string; error?: string };
type Tampil = { jenis: "laporan" } | { jenis: "beranda"; proyek: string } | { jenis: "audit"; proyek: string; audit: string };

const API = "/api/swarm-cabang/proyek";
/** a window event that opens "Buat proyek baru" (the /swarm-x demo's empty page has its own button for it) */
export const CABANG_BUAT_PROYEK = "cabang-buat-proyek";
const TERAKHIR = "aip.cabang.proyek";  // where the viewer was (per browser)
const PANEL = "aip.cabang.panel";  // the project panel minimised to a rail on a wide screen ("kecil"), per browser
const STATUS: Record<Status, [string, string]> = {
  siap: ["siap dijalankan", "text-[#c9c0ff]"], berjalan: ["berjalan", "text-[#b8a9ff]"], selesai: ["selesai", "text-[#7ee2c0]"],
  gagal: ["gagal", "text-[#ffb4b4]"], dibatalkan: ["dibatalkan", "text-[#8f99a8]"],
};
const field = "w-full rounded-sm border border-white/15 bg-[#111418] px-2 py-1.5 text-[12px] text-[#e5e8eb] outline-none focus:border-[#5b5fd6]";
const angka = (n?: number | null) => (n == null ? "—" : n.toLocaleString("id-ID"));
const rp = (v: number) => (v >= 1e9 ? `Rp ${(v / 1e9).toLocaleString("id-ID", { maximumFractionDigits: 2 })} M`
  : v >= 1e6 ? `Rp ${(v / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 })} jt` : `Rp ${angka(v)}`);

async function ambil<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error || `HTTP ${r.status}`);
  return d as T;
}
const kirim = <T,>(body: object) => ambil<T>(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Theme names as one phrase: up to `maks` names, then "+N tema lain". */
const namaTema = (nama: string[], maks = 3) => (nama.length <= maks ? nama.join(", ") : `${nama.slice(0, maks).join(", ")} +${nama.length - maks} tema lain`);
/** A project's theme focus in words. */
const fokusTeks = (p: Proyek) => (p.tema_fokus?.length ? namaTema(p.tema_fokus_nama?.length ? p.tema_fokus_nama : p.tema_fokus) : "semua tema klinis");
/** A theme choice as one comparable key: null, or every theme of the list, = "*" (codes outside the list left out). */
function kunciTema(x: string[] | null | undefined, semuaKode: string[]): string {
  if (!x) return "*";
  const ada = semuaKode.length ? x.filter((k) => semuaKode.includes(k)) : [...x];
  if (semuaKode.length && semuaKode.every((k) => ada.includes(k))) return "*";
  return [...new Set(ada)].sort().join(",");
}
const catatanKuning = "rounded border border-[#fab219]/40 bg-[#fab219]/10 px-2 py-1.5 text-[11px] leading-snug text-[#fbd38d]";

// the data size of a theme dataset (the user, 2026-11-15: "kasih opsi aja, data nya jadi saya bisa milih"): the last N replicas
// (jalan_kc_tema.py --replika-terakhir), or every replica
const UKURAN = [5, 10, 20, 40];
const adaPerReplika = (d: DaftarTema | null) => !!d?.replika && !!d.replika_ids?.length && d.tema.some((t) => t.per_replika?.length);
/** A theme's claims in the last n replicas (every replica: n = null). */
const klaimUkuran = (t: TemaItem, n: number | null | undefined) => (n && t.per_replika?.length ? t.per_replika.slice(-n).reduce((s, x) => s + x, 0) : t.klaim);
const teksUkuran = (n: number | null | undefined, total: number) => (n && n < total ? `${n} ulangan terakhir dari ${total}` : `semua ${total} ulangan`);
/** A rough estimate from the Jantung audit of 2026-11-15 (8.118 claims): ±16% of the claims read by the agents at ±$0.0013 each,
 *  ±2 minutes per replica to prepare the data, the agents ±1 claim a second. Said as rough wherever it is shown. */
function perkiraan(klaim: number, replika: number): { usd: number; waktu: string; saran: number } {
  const usd = klaim * 0.00022, menit = replika * 2 + (klaim * 0.16) / 60 + 5;
  const waktu = menit < 60 ? `±${Math.max(5, Math.round(menit / 5) * 5)} menit` : `±${(menit / 60).toLocaleString("id-ID", { maximumFractionDigits: 1 })} jam`;
  return { usd, waktu, saran: Math.max(5, Math.ceil((usd * 1.3) / 5) * 5) };
}
const usdKira = (v: number) => `±$${v < 10 ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : Math.round(v)}`;

/** An audit's themes in one chip: the theme's name, "N tema", or every theme. */
function TemaChip({ a }: { a: Audit }) {
  const n = a.tema?.length ?? 0;
  return (
    <span title={a.tema ? a.tema_nama.join(", ") : "semua tema klinis"}
      className="max-w-full truncate rounded bg-[#199e70]/20 px-1 text-[9.5px] font-semibold text-[#7ee2c0]">
      {!a.tema ? "Semua tema" : n === 1 ? a.tema_nama[0] : `${n} tema`}
    </span>
  );
}

/** A project's theme focus as chips: its themes (`maks` at most, then "+N tema"), or every theme. */
function FokusChips({ p, maks = 2, besar = false }: { p: Proyek; maks?: number; besar?: boolean }) {
  const kode = p.tema_fokus ?? null;
  const nama = p.tema_fokus_nama?.length ? p.tema_fokus_nama : kode ?? [];
  const cls = `max-w-full truncate rounded font-semibold ${besar ? "px-1.5 py-0.5 text-[11px]" : "px-1 text-[9.5px]"}`;
  const judul = `Fokus tema proyek: ${kode?.length ? nama.join(", ") : "semua tema klinis"}`;
  if (!kode?.length) return <span title={judul} className={`${cls} bg-white/10 text-[#c5cbd3]`}>Semua tema</span>;
  return (
    <>
      {nama.slice(0, maks).map((n) => <span key={n} title={judul} className={`${cls} bg-[#9d8cff]/20 text-[#ddd6ff]`}>{n}</span>)}
      {nama.length > maks && <span title={judul} className={`${cls} bg-[#9d8cff]/20 text-[#ddd6ff]`}>+{nama.length - maks} tema</span>}
    </>
  );
}

/** What "Mulai audit" will read, for the confirmation. */
type Ringkasan = { label: string; tema: string[] | null; temaNama: string[]; jumlahTema: number | null; klaim: number | null; klaimSemua: number | null;
  batas: number; iot: string; beda: boolean; ukuran?: string | null; perkiraan?: { usd: number; waktu: string; saran: number } | null };

/** An audit asked once more before it starts: its themes, the claims in scope, the cost cap, the IoT data, the data and branch,
 *  and a note when its themes differ from the project's focus. "Ubah tema" goes back to the audit's form; never started without it. */
function KonfirmasiMulai({ id, p, r, siap, busy, err, onUbah, onMulai }: { id: string; p: Proyek; r: Ringkasan; siap: boolean; busy: boolean; err: string;
  onUbah: () => void; onMulai: () => void }) {
  const baris = "flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3";
  const k = "shrink-0 text-[11px] text-[#8f99a8] sm:w-[150px]";
  return (
    <div className="flex max-h-[calc(100vh-32px)] w-full max-w-[600px] flex-col overflow-y-auto rounded-lg border border-white/10 bg-[#1c2127] p-5 shadow-2xl">
      <p id={id} className="text-[15px] font-semibold text-white">Mulai audit ini?</p>
      <p className="mt-1 text-[11.5px] leading-snug text-[#abb3bf]">
        Periksa dulu apa yang akan dibaca. Audit memakai biaya model AI sampai batasnya, dan temanya tidak bisa diganti setelah dimulai.
      </p>
      <dl className="mt-3 divide-y divide-white/5 rounded border border-white/10 bg-[#111418] text-[12px] text-[#e5e8eb]">
        <div className={baris}><dt className={k}>Audit</dt><dd className="min-w-0 break-words">{r.label}</dd></div>
        <div className={baris}>
          <dt className={k}>Tema</dt>
          <dd className="flex min-w-0 flex-wrap gap-1">
            {r.tema
              ? r.temaNama.map((t) => <span key={t} className="rounded bg-[#199e70]/20 px-1.5 py-0.5 text-[11px] font-medium text-[#7ee2c0]">{t}</span>)
              : <span className="font-semibold text-white">Semua tema klinis{r.jumlahTema ? ` (${r.jumlahTema} tema)` : ""}</span>}
          </dd>
        </div>
        <div className={baris}>
          <dt className={k}>Klaim yang diperiksa</dt>
          <dd>
            {!siap ? <span className="text-[#8f99a8]">menghitung…</span> : r.klaim == null ? <span className="text-[#8f99a8]">jumlahnya belum tersedia</span> : (
              <><b className="font-semibold text-white">{angka(r.klaim)}</b> klaim{r.tema && r.klaimSemua ? <span className="text-[#8f99a8]"> dari {angka(r.klaimSemua)} klaim di data ini</span> : null}</>
            )}
          </dd>
        </div>
        {r.ukuran && <div className={baris}><dt className={k}>Ukuran data</dt><dd>{r.ukuran}</dd></div>}
        <div className={baris}>
          <dt className={k}>Batas biaya model AI</dt>
          <dd><b className="font-semibold text-white">{usdLimit(r.batas)}</b><span className="text-[#8f99a8]"> · audit berhenti memanggil model AI saat batas tercapai</span></dd>
        </div>
        {r.perkiraan && (
          <div className={baris}>
            <dt className={k}>Perkiraan kasar</dt>
            <dd>biaya AI <b className="font-semibold text-white">{usdKira(r.perkiraan.usd)}</b> · waktu <b className="font-semibold text-white">{r.perkiraan.waktu}</b>
              <span className="text-[#8f99a8]"> · dari audit Jantung sebelumnya</span></dd>
          </div>
        )}
        <div className={baris}><dt className={k}>Data IoT</dt><dd className="min-w-0 break-all">{r.iot}</dd></div>
        <div className={baris}><dt className={k}>Data · kantor cabang</dt><dd className="min-w-0">{p.dataset_nama} · {p.kc_nama ?? "semua kantor cabang"}</dd></div>
      </dl>
      {r.perkiraan && r.perkiraan.usd > r.batas && (
        <p className={`mt-3 ${catatanKuning}`}>
          Perkiraan biaya ({usdKira(r.perkiraan.usd)}) lebih besar dari batas ({usdLimit(r.batas)}): agen AI berhenti di batas dan sisa klaim yang meragukan
          tercatat &ldquo;belum dibaca&rdquo;. Untuk membaca semuanya, naikkan batas ke sekitar ${r.perkiraan.saran} lewat Ubah tema.
        </p>
      )}
      {r.beda && (
        <p className={`mt-3 ${catatanKuning}`}>
          Tema audit ini berbeda dari fokus tema proyek (<b className="font-semibold">{fokusTeks(p)}</b>). Pastikan memang tema ini yang ingin diaudit, atau pilih Ubah tema.
        </p>
      )}
      {err && <p className="mt-3 text-[11.5px] text-[#ffb4b4]">{err}</p>}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <button type="button" autoFocus onClick={onUbah} className="flex items-center gap-1 rounded-sm border border-white/15 px-3 py-1.5 text-[12px] text-[#d3d8de] hover:bg-white/10">
          <Icon name="left" className="h-3 w-3" />Ubah tema
        </button>
        <button type="button" disabled={busy || !siap} onClick={onMulai}
          className="flex items-center gap-1 rounded-sm bg-[#5b5fd6] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#6a6ee0] disabled:opacity-40">
          <Icon name="play" className="h-3 w-3" />{busy ? "Memulai…" : "Mulai"}
        </button>
      </div>
    </div>
  );
}

function Modal({ id, onClose, children }: { id: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby={id}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      {children}
    </div>
  );
}

/** A delete asked once more on its row. */
function Confirm({ text, busy, err, onYes, onNo }: { text: string; busy: boolean; err: string; onYes: () => void; onNo: () => void }) {
  return (
    <div className="mx-2 mb-2 rounded-sm border border-[#e5484d]/50 bg-[#e5484d]/10 p-2 text-[10.5px] leading-snug text-[#ffb4b4]">
      <p>{text}</p>
      <div className="mt-1.5 flex gap-1">
        <button disabled={busy} onClick={onYes} className="flex-1 rounded-sm bg-[#e5484d] py-0.5 font-medium text-white hover:brightness-110 disabled:opacity-40">{busy ? "Menghapus…" : "Ya, hapus"}</button>
        <button onClick={onNo} className="flex-1 rounded-sm border border-white/15 py-0.5 text-[#d3d8de] hover:bg-white/10">Batal</button>
      </div>
      {err && <p className="mt-1.5 rounded-sm bg-black/30 px-1.5 py-1 text-[#ffd0d0]">Gagal menghapus: {err}</p>}
    </div>
  );
}

export function ProyekCabang({ children }: { children?: React.ReactNode }) {
  const [d, setD] = useState<Daftar | null>(null);
  const [err, setErr] = useState("");
  const [aktif, setAktif] = useState<string | null>(null);  // the project opened in the list
  const [sel, setSel] = useState<string | null>(null);  // the audit highlighted in it
  const [tampil, setTampil] = useState<Tampil>({ jenis: "laporan" });
  const [formProyek, setFormProyek] = useState(false);
  // the audit form of a project: a new audit, or (dari) the one "Ubah tema" came back from — changed when it never ran, else copied
  const [formAudit, setFormAudit] = useState<{ proyek: string; dari: string | null } | null>(null);
  const [buka, setBuka] = useState(false);  // the list over the page, on a small screen
  // the panel minimised to a rail on a wide screen (the user, 2026-11-15: "panel kiri bisa di minimize"); remembered per browser
  const [kecil, setKecil] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => { try { if (localStorage.getItem(PANEL) === "kecil") setKecil(true); } catch { /* storage blocked: open */ } });
    return () => cancelAnimationFrame(r);
  }, []);
  const ubahKecil = (v: boolean) => { setKecil(v); try { localStorage.setItem(PANEL, v ? "kecil" : "lebar"); } catch { /* storage blocked: this visit only */ } };
  const [jawab, setJawab] = useState<Record<string, JawabMulai>>({});  // what "Mulai audit" answered, per audit
  const [hapus, setHapus] = useState<string | null>(null);
  const [hapusErr, setHapusErr] = useState("");
  const [busy, setBusy] = useState(false);
  const awal = useRef(false);
  // an audit that finishes while it is open shows its report at once (2026-11-16: the page otherwise stayed on the finished audit)
  const tampilRef = useRef<Tampil>(tampil);
  useEffect(() => { tampilRef.current = tampil; }, [tampil]);
  const statusLalu = useRef<Record<string, Status>>({});

  const muat = useCallback(async (): Promise<Daftar | null> => {
    try {
      const x = await ambil<Daftar>(API);
      setD(x); setErr("");
      const lalu = statusLalu.current, t = tampilRef.current;
      statusLalu.current = Object.fromEntries(x.proyek.flatMap((p) => p.audit.map((a) => [a.id, a.status])));
      if (t.jenis === "audit") {
        const a = x.proyek.find((p) => p.id === t.proyek)?.audit.find((q) => q.id === t.audit);
        if (a?.run && lalu[a.id] === "berjalan") { pilihRunCabang(a.run); setSel(a.id); setTampil({ jenis: "laporan" }); }
      }
      return x;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    }
  }, []);

  // first load: back where the viewer was; else the project of the newest run (the report opens on it)
  useEffect(() => {
    let batal = false;
    muat().then((x) => {
      if (!x || batal || awal.current) return;
      awal.current = true;
      let last: { proyek?: string; audit?: string | null; beranda?: boolean; pada?: number } | null = null;
      try { last = JSON.parse(localStorage.getItem(TERAKHIR) ?? "null"); } catch { last = null; }
      let baru: { p: Proyek; a: Audit } | null = null;
      for (const q of x.proyek) for (const b of q.audit) {
        if (b.run_info?.dijalankan && (!baru || Date.parse(b.run_info.dijalankan) > Date.parse(baru.a.run_info?.dijalankan ?? ""))) baru = { p: q, a: b };
      }
      // a run finished since the viewer was last here: open its report (the user, 2026-11-15, could not find the new run
      // because the tab reopened on the project home they had left it on)
      const tBaru = baru?.a.run_info?.dijalankan ? Date.parse(baru.a.run_info.dijalankan) : NaN;
      if (baru && (!last?.pada || tBaru > last.pada)) {
        setAktif(baru.p.id); setSel(baru.a.id);
        if (baru.a.run) pilihRunCabang(baru.a.run);
        return;
      }
      const p = x.proyek.find((q) => q.id === last?.proyek);
      const a = p?.audit.find((q) => q.id === last?.audit);
      if (p && a) {
        setAktif(p.id); setSel(a.id);
        if (a.run) pilihRunCabang(a.run);
        else setTampil({ jenis: "audit", proyek: p.id, audit: a.id });
        return;
      }
      if (p && last?.beranda) { setAktif(p.id); setTampil({ jenis: "beranda", proyek: p.id }); return; }
      if (baru) { setAktif(baru.p.id); setSel(baru.a.id); if (baru.a.run) pilihRunCabang(baru.a.run); }
    });
    return () => { batal = true; };
  }, [muat]);
  useEffect(() => {
    if (!awal.current) return;
    try {
      localStorage.setItem(TERAKHIR, JSON.stringify({ proyek: aktif, audit: tampil.jenis === "beranda" ? null : sel, beranda: tampil.jenis === "beranda", pada: Date.now() }));
    } catch { /* storage blocked */ }
  }, [aktif, sel, tampil]);
  // the report's own run picker, when it says which run it shows (cabangPilih.ts)
  useEffect(() => {
    const h = (e: Event) => {
      const run = (e as CustomEvent<string>).detail;
      for (const p of d?.proyek ?? []) {
        const a = p.audit.find((x) => x.run === run);
        if (a) { setAktif(p.id); setSel(a.id); setTampil({ jenis: "laporan" }); return; }
      }
    };
    window.addEventListener(CABANG_RUN_DIPILIH, h);
    return () => window.removeEventListener(CABANG_RUN_DIPILIH, h);
  }, [d]);
  // a running audit: its status and progress follow the runner
  const jalan = !!d?.proyek.some((p) => p.audit.some((a) => a.status === "berjalan"));
  useEffect(() => {
    if (!jalan) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") muat(); }, cabangPoll(10000));
    return () => clearInterval(t);
  }, [jalan, muat]);
  useEffect(() => {
    const h = () => setFormProyek(true);
    window.addEventListener(CABANG_BUAT_PROYEK, h);
    return () => window.removeEventListener(CABANG_BUAT_PROYEK, h);
  }, []);

  const proyekDari = (pid: string | null) => d?.proyek.find((p) => p.id === pid) ?? null;
  const bukaProyek = (pid: string) => { setAktif(pid); setSel(null); setTampil({ jenis: "beranda", proyek: pid }); setBuka(false); };
  const pilihAudit = (p: Proyek, a: Audit) => {
    setAktif(p.id); setSel(a.id); setBuka(false);
    if (a.run) { pilihRunCabang(a.run); setTampil({ jenis: "laporan" }); } else setTampil({ jenis: "audit", proyek: p.id, audit: a.id });
  };
  // only from the start confirmation (KonfirmasiMulai): the API refuses a start without it
  const mulai = async (p: Proyek, a: Audit) => {
    setBusy(true);
    try {
      const r = await kirim<JawabMulai>({ aksi: "mulai", proyek: p.id, audit: a.id, konfirmasi: true });
      setJawab((j) => ({ ...j, [a.id]: r }));
    } catch (e) {
      setJawab((j) => ({ ...j, [a.id]: { error: (e as Error).message } }));
    } finally { setBusy(false); }
    await muat();
  };
  const batalkan = async (p: Proyek, a: Audit) => {
    setBusy(true);
    try { await kirim({ aksi: "batal", proyek: p.id, audit: a.id }); } catch (e) { setJawab((j) => ({ ...j, [a.id]: { error: (e as Error).message } })); }
    finally { setBusy(false); }
    await muat();
  };
  const hapusAudit = async (p: Proyek, a: Audit) => {
    setBusy(true); setHapusErr("");
    try {
      await kirim({ aksi: "hapus_audit", proyek: p.id, audit: a.id });
      setHapus(null);
      if (sel === a.id) { setSel(null); setTampil({ jenis: "beranda", proyek: p.id }); }
      await muat();
    } catch (e) { setHapusErr((e as Error).message); } finally { setBusy(false); }
  };
  const hapusProyek = async (p: Proyek) => {
    setBusy(true); setHapusErr("");
    try {
      await kirim({ aksi: "hapus_proyek", proyek: p.id });
      setHapus(null);
      if (aktif === p.id) { setAktif(null); setSel(null); setTampil({ jenis: "laporan" }); }
      await muat();
    } catch (e) { setHapusErr((e as Error).message); } finally { setBusy(false); }
  };

  // what the main area shows: a project home, an audit without a report, or the report (kept mounted underneath)
  const pTampil = tampil.jenis === "laporan" ? null : proyekDari(tampil.proyek);
  const aTampil = tampil.jenis === "audit" ? pTampil?.audit.find((a) => a.id === tampil.audit) ?? null : null;
  const lihat: "beranda" | "audit" | "laporan" = !pTampil ? "laporan" : tampil.jenis === "audit" && aTampil ? "audit" : "beranda";
  const pForm = proyekDari(formAudit?.proyek ?? null);
  const aForm = pForm?.audit.find((a) => a.id === formAudit?.dari) ?? null;
  const jejak = pTampil ? `${pTampil.nama}${aTampil ? ` › ${aTampil.label}` : ""}` : (() => {
    const p = proyekDari(aktif), a = p?.audit.find((x) => x.id === sel);
    return p ? `${p.nama}${a ? ` › ${a.label}` : ""}` : "Laporan kantor cabang";
  })();

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden text-[12px]">
      {formProyek && d && (
        <ProyekBaruDialog d={d} onClose={() => setFormProyek(false)}
          onSaved={async (p) => { setFormProyek(false); await muat(); bukaProyek(p.id); }} />
      )}
      {pForm && d && (
        <AuditBaruDialog key={`${pForm.id}|${aForm?.id ?? ""}`} p={pForm} d={d} dari={aForm} onClose={() => setFormAudit(null)}
          onDone={async (a, mulaiJawab) => {
            setFormAudit(null);
            // a changed audit's earlier answer (its old command) goes; a start's answer is shown
            setJawab((j) => { const n = { ...j }; delete n[a]; if (mulaiJawab) n[a] = mulaiJawab; return n; });
            const x = await muat();
            const p = x?.proyek.find((q) => q.id === pForm.id);
            const baru = p?.audit.find((q) => q.id === a);
            if (p && baru) pilihAudit(p, baru);
          }} />
      )}
      {buka && <div className="absolute inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setBuka(false)} aria-hidden />}
      {/* minimised (wide screens): a rail with the way back, a new project, and each project by its icon */}
      {kecil && (
        <nav className="flex w-[46px] shrink-0 flex-col items-center gap-1 border-r border-black/30 bg-[#1c2127] py-2.5 max-lg:hidden" aria-label="Proyek AI Agent Swarm Branch (diperkecil)">
          <button onClick={() => ubahKecil(false)} title="Buka panel proyek" aria-label="Buka panel proyek" className="rounded p-1.5 text-[#c5cbd3] hover:bg-white/10 hover:text-white">
            <Icon name="right" className="h-4 w-4" />
          </button>
          <button disabled={!d} onClick={() => setFormProyek(true)} title="Buat proyek baru" aria-label="Buat proyek baru"
            className="rounded-sm bg-[#5b5fd6] p-1.5 text-white hover:bg-[#6a6ee0] disabled:opacity-40">
            <Icon name="plus" className="h-3.5 w-3.5" />
          </button>
          <span className="my-1 h-px w-6 bg-white/10" aria-hidden />
          <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
            {(d?.proyek ?? []).map((p) => (
              <button key={p.id} onClick={() => bukaProyek(p.id)} title={p.nama} aria-label={p.nama}
                className={`rounded p-1.5 ${aktif === p.id ? "bg-white/[.08] text-[#9d8cff]" : "text-[#8f99a8] hover:bg-white/5 hover:text-white"}`}>
                <Icon name="project" className="h-4 w-4" />
              </button>
            ))}
          </div>
        </nav>
      )}
      <aside className={`flex w-[300px] shrink-0 flex-col border-r border-black/30 bg-[#1c2127] ${buka ? "max-lg:absolute max-lg:inset-y-0 max-lg:left-0 max-lg:z-40 max-lg:shadow-2xl" : "max-lg:hidden"} ${kecil ? "lg:hidden" : ""}`}
        aria-label="Proyek AI Agent Swarm Branch">
        <div className="space-y-2 border-b border-white/5 p-3">
          <div className="flex items-center gap-2">
            <p className="text-[13px] font-semibold text-white">AI Agent Swarm Branch</p>
            <button onClick={() => ubahKecil(true)} title="Perkecil panel proyek" aria-label="Perkecil panel proyek" className="ml-auto rounded p-1 text-[#8f99a8] hover:bg-white/10 hover:text-white max-lg:hidden">
              <Icon name="left" className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setBuka(false)} aria-label="Tutup daftar proyek" className="ml-auto rounded p-1 text-[#8f99a8] hover:bg-white/10 hover:text-white lg:hidden">
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="line-clamp-4 text-[11px] leading-snug text-[#abb3bf]">Audit klaim oleh kantor cabang BPJS Kesehatan. Satu proyek memegang satu kantor cabang (atau semuanya), datanya, dan fokus temanya — mis. jantung saja. Tiap audit mulai dari fokus itu (satu, beberapa, atau semua tema), lalu mesin aturan, model ML dan agen AI membaca klaim tema itu dan menulis laporan per tema.</p>
          <button disabled={!d} onClick={() => setFormProyek(true)} title={d ? undefined : "memuat…"}
            className="flex w-full items-center justify-center gap-1 rounded-sm bg-[#5b5fd6] py-1.5 font-medium text-white hover:bg-[#6a6ee0] disabled:opacity-40">
            <Icon name="plus" className="h-3 w-3" />Buat proyek baru
          </button>
          {err && <p className="text-[11px] text-red-300">{err}</p>}
        </div>
        <p className="px-3 pt-2 font-semibold text-[#e5e8eb]">Proyek</p>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {(d?.proyek ?? []).map((p) => {
            const on = aktif === p.id;
            return (
              <div key={p.id} className="border-b border-white/5">
                <div className={`group relative ${on ? "bg-white/[.05]" : "hover:bg-white/5"}`}>
                  <button onClick={() => bukaProyek(p.id)} className="flex w-full items-start gap-2 px-3 py-2 pr-8 text-left">
                    <Icon name="project" className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${on ? "text-[#9d8cff]" : "text-[#8f99a8]"}`} />
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-medium text-white">{p.nama}</span>
                      <span className="block text-[10.5px] text-[#8f99a8]">{p.audit.length ? `${p.audit.length} audit · terbaru ${STATUS[p.audit[0].status][0]}` : "belum ada audit"}</span>
                      {!p.virtual && <span className="mt-0.5 flex flex-wrap gap-1"><FokusChips p={p} /></span>}
                    </span>
                  </button>
                  {!p.virtual && !p.audit.length && hapus !== `p:${p.id}` && (
                    <button onClick={() => { setHapus(`p:${p.id}`); setHapusErr(""); }} title="hapus proyek ini" aria-label="Hapus proyek"
                      className="absolute right-2 top-2 rounded p-1 text-[#8f99a8] opacity-0 hover:bg-white/10 hover:text-[#ffb4b4] focus:opacity-100 group-hover:opacity-100">
                      <Icon name="trash" className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {hapus === `p:${p.id}` && (
                  <Confirm busy={busy} err={hapusErr} onYes={() => hapusProyek(p)} onNo={() => setHapus(null)} text="Hapus proyek ini? Proyek belum punya audit." />
                )}
                {on && (
                  <button onClick={() => bukaProyek(p.id)}
                    className={`flex w-full items-center gap-1.5 py-1 pl-8 text-left text-[11px] ${lihat === "beranda" && pTampil?.id === p.id ? "bg-white/[.08] text-white" : "text-[#8f99a8] hover:text-white"}`}>
                    <Icon name="home" className="h-3 w-3" />Beranda proyek
                  </button>
                )}
                {on && p.audit.map((a) => (
                  <div key={a.id} className={`group relative ${sel === a.id && lihat !== "beranda" ? "bg-white/[.08]" : "hover:bg-white/5"}`}>
                    <button onClick={() => pilihAudit(p, a)} className="block w-full py-1.5 pl-8 pr-8 text-left">
                      <p className="truncate text-[11.5px] font-medium text-white" title={a.label}>{a.label}</p>
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        <TemaChip a={a} />
                        {a.run_info?.model && <span className="rounded bg-white/10 px-1 text-[9.5px] font-semibold text-[#d3d8de]">{a.run_info.model}</span>}
                      </span>
                      <p className="text-[10.5px] text-[#c5cbd3]">{wib(a.run_info?.dijalankan ?? a.dibuat_pada)}</p>
                      <p className={`text-[10px] tabular-nums ${STATUS[a.status][1]}`}>
                        {STATUS[a.status][0]}{a.status === "berjalan" && a.progres?.persen != null ? ` · ${a.progres.persen}%` : ""}
                        {a.run_info?.operasional ? <span className="text-[#8f99a8]"> · {angka(a.run_info.operasional.klaim)} klaim</span> : null}
                      </p>
                    </button>
                    {!p.virtual && a.status === "siap" && !a.run && hapus !== `a:${a.id}` && (
                      <button onClick={() => { setHapus(`a:${a.id}`); setHapusErr(""); }} title="hapus audit ini (belum pernah dijalankan)" aria-label="Hapus audit"
                        className="absolute right-2 top-1.5 rounded p-1 text-[#8f99a8] opacity-0 hover:bg-white/10 hover:text-[#ffb4b4] focus:opacity-100 group-hover:opacity-100">
                        <Icon name="trash" className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {hapus === `a:${a.id}` && (
                      <Confirm busy={busy} err={hapusErr} onYes={() => hapusAudit(p, a)} onNo={() => setHapus(null)} text="Hapus audit ini? Audit belum pernah dijalankan." />
                    )}
                  </div>
                ))}
              </div>
            );
          })}
          {d && !d.proyek.length && <p className="px-3 py-2 text-[11px] text-[#8f99a8]">Belum ada proyek.</p>}
          {!d && !err && <p className="px-3 py-2 text-[11px] text-[#8f99a8]">Memuat proyek…</p>}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-[#15181d] px-2 py-1 lg:hidden">
          <button onClick={() => setBuka(true)} className="flex items-center gap-1 rounded border border-white/15 px-2 py-0.5 text-[11px] text-[#d3d8de] hover:bg-white/5">
            <Icon name="project" className="h-3 w-3" />Proyek
          </button>
          <span className="truncate text-[11px] text-[#abb3bf]">{jejak}</span>
        </div>
        {lihat === "beranda" && pTampil && d && (
          <BerandaProyek p={pTampil} onBuat={() => setFormAudit({ proyek: pTampil.id, dari: null })} onPilih={(a) => pilihAudit(pTampil, a)} />
        )}
        {lihat === "audit" && pTampil && aTampil && d && (
          <AuditDetail key={aTampil.id} p={pTampil} a={aTampil} d={d} jawab={jawab[aTampil.id]} busy={busy}
            onMulai={() => mulai(pTampil, aTampil)} onBatal={() => batalkan(pTampil, aTampil)} onBeranda={() => bukaProyek(pTampil.id)}
            onUbah={() => setFormAudit({ proyek: pTampil.id, dari: aTampil.id })} />
        )}
        <div className={lihat === "laporan" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>{children}</div>
      </div>
    </div>
  );
}

/** A project's home (the national "Beranda proyek"): what it audits, the button for a new audit, and its audits. */
function BerandaProyek({ p, onBuat, onPilih }: { p: Proyek; onBuat: () => void; onPilih: (a: Audit) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[#15181d]">
      {/* the glow behind the orb fades into the page colour inside its own ellipse (fixed size, centred on the orb), so no edge shows
          where the header ends (the user, 2026-11-15: "transisi ke hitam nya"); it scrolls with the page */}
      <div className="flex min-h-full flex-col bg-[radial-gradient(ellipse_1100px_620px_at_50%_170px,#262c3a_0%,#1f2430_35%,#191d24_65%,#15181d_100%)] bg-no-repeat">
      <div className="flex flex-col items-center px-4 pb-8 pt-2">
        <NetworkOrb size={280} />
        <p className="-mt-3 text-[10.5px] uppercase tracking-[0.2em] text-[#8f99a8]">Proyek AI Agent Swarm Branch</p>
        <h2 className="mt-1 text-center text-[20px] font-semibold text-white">{p.nama}</h2>
        {p.deskripsi && <p className="mt-1.5 line-clamp-3 max-w-[640px] text-center text-[12px] leading-relaxed text-[#abb3bf]">{p.deskripsi}</p>}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11.5px] text-[#abb3bf]">
          <span>Kantor cabang: <b className="font-medium text-white">{p.kc_nama ?? "semua kantor cabang"}</b></span>
          <span>Data: <b className="font-medium text-white">{p.dataset_nama}</b></span>
          <span>{p.audit.length ? `${p.audit.length} audit` : "belum ada audit"}</span>
        </div>
        {!p.virtual && (
          <div className="mt-2 flex max-w-[640px] flex-wrap items-center justify-center gap-1 text-[11.5px] text-[#abb3bf]">
            <span className="mr-0.5">Fokus tema:</span><FokusChips p={p} maks={4} besar />
          </div>
        )}
        {p.virtual ? (
          <p className="mt-5 max-w-[520px] text-center text-[11.5px] text-[#8f99a8]">Run yang dibuat sebelum ada proyek, atau dijalankan langsung dari baris perintah. Untuk audit baru, buat proyek baru.</p>
        ) : (
          <>
            <button onClick={onBuat}
              className="mt-6 flex items-center gap-2 rounded-md bg-[#5b5fd6] px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_0_24px_rgba(91,95,214,0.45)] hover:bg-[#6a6ee0]">
              <Icon name="plus" className="h-3.5 w-3.5" />Buat audit baru
            </button>
            <p className="mt-2 max-w-[560px] text-center text-[11px] text-[#8f99a8]">
              Audit baru mulai dari fokus tema proyek ini ({fokusTeks(p)}); temanya masih bisa diubah, dan sebelum dimulai ringkasannya ditanyakan sekali lagi.
              Hasilnya laporan kantor cabang per tema: klaim yang perlu diperiksa, alasannya, dan langkah verifikator.
            </p>
          </>
        )}
      </div>
      {p.audit.length > 0 && (
        <div className="mx-auto w-full max-w-[980px] p-4">
          <p className="mb-2 text-[12.5px] font-semibold text-white">Audit di proyek ini</p>
          <div className="grid gap-2 md:grid-cols-2">
            {p.audit.map((a) => {
              const o = a.run_info?.operasional;
              return (
                <button key={a.id} onClick={() => onPilih(a)} className="rounded border border-white/10 bg-[#1c2127] p-3 text-left hover:border-[#9d8cff]/50 hover:bg-[#20262d]">
                  <p className="truncate text-[12px] font-medium text-white" title={a.label}>{a.label}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px]">
                    <TemaChip a={a} />
                    {a.iot && <span className="rounded bg-[#3f7fd6]/20 px-1 text-[9.5px] font-semibold text-[#9cc4ff]" title={`data IoT: ${a.iot_tampil ?? a.iot.tampil}`}>IoT</span>}
                    {a.run_info?.model && <span className="rounded bg-white/10 px-1 text-[9.5px] font-semibold text-[#d3d8de]">{a.run_info.model}</span>}
                    <span className={STATUS[a.status][1]}>{STATUS[a.status][0]}</span>
                    <span className="text-[#8f99a8]">{wib(a.run_info?.dijalankan ?? a.dibuat_pada)}</span>
                  </p>
                  {o ? (
                    <p className="mt-1.5 text-[11px] text-[#abb3bf]">
                      {angka(o.klaim)} klaim dianalisis · {angka(o.antrean)} perlu diperiksa · nilai ditandai {rp(o.nilai_ditandai_rp)}
                      {a.run_info && a.run_info.kc > 1 ? ` · ${a.run_info.kc} KC` : ""}
                    </p>
                  ) : (
                    <p className="mt-1.5 text-[11px] text-[#8f99a8]">{a.tema ? a.tema_nama.join(", ") : "Semua tema klinis"} · batas biaya {usdLimit(a.batas_usd)}</p>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

/** An audit that has no report yet: what it will read, its state, and (admin) the button that starts it; until the runner is
 *  installed, the command it would run. */
function AuditDetail({ p, a, d, jawab, busy, onMulai, onBatal, onBeranda, onUbah }: { p: Proyek; a: Audit; d: Daftar; jawab?: JawabMulai; busy: boolean;
  onMulai: () => Promise<void>; onBatal: () => void; onBeranda: () => void; onUbah: () => void }) {
  const [tersalin, setTersalin] = useState(false);
  const [tanya, setTanya] = useState(false);  // the start confirmation
  const perintah = jawab?.perintah ?? a.perintah;
  const bisaMulai = ["siap", "gagal", "dibatalkan"].includes(a.status) && !a.run;
  const salin = async () => {
    if (!perintah) return;
    try { await navigator.clipboard.writeText(perintah); setTersalin(true); setTimeout(() => setTersalin(false), 1500); } catch { /* clipboard blocked */ }
  };
  const beda = kunciTema(a.tema, []) !== kunciTema(p.tema_fokus ?? null, []);
  // what the audit reads; while it runs, under the live chart (the chart is what is watched: 2026-11-16, demo recording)
  const rincian = (
    <section className="rounded border border-white/10 bg-[#1c2127] p-3">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.1em] text-[#8f99a8]">Tema yang diaudit</p>
      {a.tema ? (
        <div className="flex flex-wrap gap-1">
          {a.tema_nama.map((t) => <span key={t} className="rounded bg-[#199e70]/20 px-1.5 py-0.5 text-[11px] text-[#7ee2c0]">{t}</span>)}
        </div>
      ) : <p className="text-[12px] text-[#d3d8de]">Semua tema klinis</p>}
      <p className="mt-1.5 text-[11px] text-[#8f99a8]">Fokus tema proyek: <span className="text-[#d3d8de]">{fokusTeks(p)}</span></p>
      {beda && !a.run && <p className={`mt-1.5 ${catatanKuning}`}>Tema audit ini berbeda dari fokus tema proyek.</p>}
      <div className="mt-3 grid gap-x-6 gap-y-1.5 text-[11.5px] sm:grid-cols-2">
        <p className="text-[#8f99a8]">Kantor cabang <span className="text-[#e5e8eb]">{p.kc_nama ?? "semua kantor cabang"}</span></p>
        <p className="text-[#8f99a8]">Data <span className="text-[#e5e8eb]">{p.dataset_nama}</span></p>
        <p className="text-[#8f99a8]">Batas biaya <span className="text-[#e5e8eb]">{usdLimit(a.batas_usd)}</span></p>
        <p className="text-[#8f99a8]">Dibuat <span className="text-[#e5e8eb]">{wib(a.dibuat_pada)} · {a.dibuat_oleh}</span></p>
        <p className="text-[#8f99a8]">Nama run <span className="font-mono text-[11px] text-[#e5e8eb]">{a.id}</span></p>
        {p.dataset !== "gen3" && <p className="text-[#8f99a8]">Ukuran data <span className="text-[#e5e8eb]">{a.replika ? `${a.replika} ulangan terakhir` : "semua ulangan"}</span></p>}
        <p className="text-[#8f99a8] sm:col-span-2">Data IoT <span className="break-all text-[#e5e8eb]">{a.iot_tampil ?? "tidak ada"}</span></p>
        {a.dimulai_pada && <p className="text-[#8f99a8]">Dimulai <span className="text-[#e5e8eb]">{wib(a.dimulai_pada)}</span></p>}
      </div>
    </section>
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[#12161b]">
      {tanya && (
        <MulaiAuditModal p={p} a={a} busy={busy} onClose={() => setTanya(false)}
          onUbah={() => { setTanya(false); onUbah(); }}
          onMulai={async () => { await onMulai(); setTanya(false); }} />
      )}
      <div className="mx-auto max-w-[920px] space-y-3 p-4">
        <button onClick={onBeranda} className="flex items-center gap-1 text-[11px] text-[#8abbff] hover:text-white"><Icon name="left" className="h-3 w-3" />{p.nama}</button>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[17px] font-semibold text-white">{a.label}</h2>
          <span className={`rounded-full border border-current/40 px-2 py-0.5 text-[10.5px] ${STATUS[a.status][1]}`}>{STATUS[a.status][0]}</span>
        </div>
        {a.status !== "berjalan" && rincian}

        {a.status === "berjalan" && (
          <section className="rounded border border-[#b8a9ff]/30 bg-[#1c2127] p-3">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-[#b8a9ff]" />
              <p className="font-medium text-white">Audit sedang berjalan{a.progres?.tahap ? ` · ${a.progres.tahap}` : ""}</p>
              {d.admin && (
                <button disabled={busy} onClick={onBatal} className="ml-auto flex items-center gap-1 rounded border border-[#e5484d]/50 px-2 py-0.5 text-[11px] text-[#ffb4b4] hover:bg-[#e5484d]/10 disabled:opacity-40">
                  <Icon name="x" className="h-3 w-3" />Batalkan
                </button>
              )}
            </div>
            {a.progres?.persen != null && (
              <div className="mt-2 h-1.5 overflow-hidden rounded bg-white/10" role="progressbar" aria-valuenow={a.progres.persen} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded bg-[#9d8cff]" style={{ width: `${a.progres.persen}%` }} />
              </div>
            )}
            <p className="mt-1.5 text-[11px] text-[#abb3bf]">{a.progres?.pesan ?? "Laporan muncul di sini setelah audit selesai."}</p>
          </section>
        )}

        {bisaMulai && (
          <section className="rounded border border-white/10 bg-[#1c2127] p-3">
            <p className="text-[12.5px] font-medium text-white">
              {a.status === "siap" ? "Audit ini siap dijalankan." : a.status === "gagal" ? "Audit ini gagal." : "Audit ini dibatalkan."}
            </p>
            {a.pesan && <p className="mt-1 text-[11px] text-[#fbd38d]">{a.pesan}</p>}
            <p className="mt-1 text-[11px] text-[#abb3bf]">
              Saat dijalankan, klaim tema terpilih dibaca mesin aturan (termasuk pencocokan rekam medis{a.iot ? " dan data pemakaian alat (IoT)" : ""}) dan model ML;
              klaim yang meragukan atau punya temuan aturan dibaca agen AI, lalu laporan kantor cabang ditulis per tema.
              Biaya model AI berhenti di {usdLimit(a.batas_usd)}.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button disabled={busy || !d.admin} onClick={() => setTanya(true)} title={d.admin ? "ringkasan audit ditampilkan dulu sebelum dimulai" : "hanya admin yang bisa memulai audit"}
                className="flex items-center gap-1.5 rounded bg-[#5b5fd6] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#6a6ee0] disabled:opacity-40">
                <Icon name="play" className="h-3 w-3" />{busy ? "Memulai…" : a.status === "siap" ? "Mulai audit" : "Jalankan lagi"}
              </button>
              <button onClick={onUbah} className="flex items-center gap-1 rounded border border-white/15 px-3 py-1.5 text-[12px] text-[#d3d8de] hover:bg-white/10"
                title={a.status === "siap" ? "ubah tema, nama, batas biaya atau data IoT audit ini" : "audit ini sudah pernah dijalankan: tema lain disimpan sebagai audit baru"}>
                <Icon name="pencil" className="h-3 w-3" />{a.status === "siap" ? "Ubah tema" : "Audit baru dengan tema lain"}
              </button>
              {!d.admin && <span className="text-[11px] text-[#8f99a8]">Hanya admin yang bisa memulai audit.</span>}
            </div>
            {jawab?.error && <p className="mt-2 text-[11.5px] text-[#ffb4b4]">{jawab.error}</p>}
            {(jawab ? jawab.dijalankan === false : !d.peluncur.aktif) && (
              <p className="mt-3 rounded border border-[#fab219]/40 bg-[#fab219]/10 px-2 py-1.5 text-[11px] leading-snug text-[#fbd38d]">
                {jawab?.pesan ?? "Runner audit belum terpasang di aplikasi ini: \"Mulai audit\" menampilkan perintah yang akan dijalankan, dan audit tetap siap dijalankan."}
              </p>
            )}
            {perintah && (
              <div className="mt-2">
                <div className="flex items-center gap-2">
                  <p className="text-[10.5px] font-semibold uppercase tracking-[.1em] text-[#8f99a8]">Perintah</p>
                  <button onClick={salin} className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-[#abb3bf] hover:bg-white/10 hover:text-white">
                    <Icon name={tersalin ? "check" : "copy"} className="h-3 w-3" />{tersalin ? "Tersalin" : "Salin"}
                  </button>
                </div>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-[#d3d8de]">{perintah}</pre>
                <p className="mt-1 text-[10.5px] text-[#8f99a8]">Dijalankan dari folder proyek. Setelah selesai, hasilnya muncul sebagai run <span className="font-mono">{a.id}</span> dan audit ini menampilkan laporannya.</p>
              </div>
            )}
          </section>
        )}
      </div>
      {a.status === "berjalan" && (<>
        <div className="mx-auto w-full max-w-[1680px] px-4"><BaganLangsung p={p} a={a} /></div>
        <div className="mx-auto max-w-[920px] p-4 pb-6">{rincian}</div>
      </>)}
    </div>
  );
}

const KASUS_KOSONG: KasusBagan[] = [];
const PUTUSAN_NOL = { terbukti: 0, sesuai: 0, investigasi: 0 };
const IOT_LIVE: IotBagan = { klaim_dengan_alat: 0, tidak_sesuai: 0, selisih_rp: 0, sintetis: true };

/** A running audit drawn live on the branch's own system chart (the user, 2026-11-15: "live animation juga buat yg branch tapi
 *  arsitektur sistem nya yg branch"): the runner's stage lit and playing with its data flowing, its numbers and log as they come
 *  (api/swarm-cabang/proyek?langsung=1, every 3 s while the page is visible). */
function BaganLangsung({ p, a }: { p: Proyek; a: Audit }) {
  const [L, setL] = useState<LangsungBagan | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let batal = false;
    const tarik = () => ambil<LangsungBagan>(`${API}?langsung=1&proyek=${encodeURIComponent(p.id)}&audit=${encodeURIComponent(a.id)}`)
      .then((x) => { if (!batal) { setL(x); setErr(""); } }, (e) => { if (!batal) setErr((e as Error).message); });
    tarik();
    const t = setInterval(() => { if (document.visibilityState === "visible") tarik(); }, cabangPoll(3000));
    return () => { batal = true; clearInterval(t); };
  }, [p.id, a.id]);
  const klaim = L?.klaim ?? 0, tahan = L?.zona?.tahan ?? 0, ragu = L?.zona?.ragu ?? 0, periksa = L?.gerbang?.periksa ?? 0, bersih = L?.gerbang?.dibersihkan ?? 0;
  const lap = L?.laporan ?? null;
  const sampul = useMemo<SampulBagan>(() => ({ klaim, lolos: Math.max(0, klaim - tahan - ragu), tahan, ragu, periksa, dibersihkan: bersih,
    antrean: lap?.antrean ?? tahan + periksa, rs: lap?.box.rs_klaim ?? 0, tema_aktif: 1, nilai_antrean_rp: lap?.nilai_terindikasi_rp ?? 0, tagihan_rp: 0, model: "ML v7",
    ...(lap ? { nilai_terindikasi_rp: lap.nilai_terindikasi_rp, estimasi_kerugian_rp: lap.estimasi_kerugian_rp } : {}) }), [klaim, tahan, ragu, periksa, bersih, lap]);
  const batch = L?.progres?.batch_total ?? (ragu ? Math.ceil(ragu / 8) : 0);
  if (!L) return <p className="text-[11px] text-[#8f99a8]">{err ? `Animasi langsung belum tersedia: ${err}` : "Memuat animasi langsung…"}</p>;
  return (
    <SwarmCabangBagan kc={p.kc_nama ?? "Kantor cabang"} periode={`${L.replika} ulangan`} riil={false} sampul={sampul} kasus={KASUS_KOSONG} exhibit={lap?.exhibit ?? 0} bab={lap?.bab ?? 0} narasi={0}
      putusan={PUTUSAN_NOL} iot={L.iot ? L.iot_hasil ?? IOT_LIVE : undefined} langsung={L} batchLive={batch} />
  );
}

/** "Mulai audit" of a saved audit: its summary (the claims of its themes counted from the project's theme list), then start. */
function MulaiAuditModal({ p, a, busy, onClose, onUbah, onMulai }: { p: Proyek; a: Audit; busy: boolean; onClose: () => void; onUbah: () => void;
  onMulai: () => void }) {
  const [daftar, setDaftar] = useState<DaftarTema | null>(null);
  const [gagalMuat, setGagalMuat] = useState(false);
  useEffect(() => {
    let batal = false;
    ambil<DaftarTema>(`${API}?tema=1&proyek=${encodeURIComponent(p.id)}`)
      .then((x) => { if (!batal) setDaftar(x); })
      .catch(() => { if (!batal) setGagalMuat(true); });
    return () => { batal = true; };
  }, [p.id]);
  const tema = daftar?.tema ?? [];
  const kode = tema.map((t) => t.kode);
  const masuk = tema.filter((t) => !a.tema || a.tema.includes(t.kode));
  const nRep = daftar?.replika ?? 0, ukur = adaPerReplika(daftar) ? a.replika ?? null : null;
  const klaimA = masuk.reduce((s, t) => s + klaimUkuran(t, ukur), 0);
  const r: Ringkasan = {
    label: a.label, tema: a.tema, temaNama: a.tema_nama, jumlahTema: daftar ? tema.length : null,
    klaim: daftar ? klaimA : null, klaimSemua: daftar ? tema.reduce((s, t) => s + klaimUkuran(t, ukur), 0) : null,
    batas: a.batas_usd, iot: a.iot_tampil ?? "tidak ada", beda: kunciTema(a.tema, kode) !== kunciTema(p.tema_fokus ?? null, kode),
    ukuran: adaPerReplika(daftar) ? teksUkuran(ukur, nRep) : null, perkiraan: adaPerReplika(daftar) ? perkiraan(klaimA, ukur ?? nRep) : null,
  };
  return (
    <Modal id="km-judul" onClose={onClose}>
      <KonfirmasiMulai id="km-judul" p={p} r={r} siap={!!daftar || gagalMuat} busy={busy} err="" onUbah={onUbah} onMulai={onMulai} />
    </Modal>
  );
}

/** A new project: a name, a short description, the data, its theme focus (required) and the branch (a dataset of one branch
 *  fixes the branch). */
function ProyekBaruDialog({ d, onSaved, onClose }: { d: Daftar; onSaved: (p: { id: string }) => void; onClose: () => void }) {
  const awalData = d.dataset.find((x) => x.kc && x.siap)?.id ?? d.dataset[0]?.id ?? "gen3";
  const [nama, setNama] = useState("");
  const [deskripsi, setDeskripsi] = useState("");
  const [dataset, setDataset] = useState(awalData);
  const [kc, setKc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ds = d.dataset.find((x) => x.id === dataset);
  const kcPakai = ds?.kc ?? kc;
  const prov = useMemo(() => {
    const m: Record<string, Kc[]> = {};
    for (const k of d.kc) (m[k.provinsi || "Lainnya"] ??= []).push(k);
    return Object.entries(m).sort(([x], [y]) => x.localeCompare(y));
  }, [d.kc]);
  // the theme focus: the themes of the chosen data and branch, with claim counts (loaded per data/branch; a theme dataset starts on
  // its main theme, a change of branch keeps the themes still there)
  const kunci = `${dataset}|${kcPakai}`;
  const [muat, setMuat] = useState<{ kunci: string; daftar: DaftarTema | null; err: string } | null>(null);
  const [pilih, setPilih] = useState<Set<string>>(new Set());
  const awalUntuk = useRef<string | null>(null);  // the data the selection was started for
  const utamaData = ds?.tema_utama ?? null;
  useEffect(() => {
    let batal = false;
    const k = `${dataset}|${kcPakai}`;
    ambil<DaftarTema>(`${API}?tema=1&dataset=${encodeURIComponent(dataset)}${kcPakai ? `&kc=${encodeURIComponent(kcPakai)}` : ""}`)
      .then((x) => {
        if (batal) return;
        setMuat({ kunci: k, daftar: x, err: "" });
        const ada = x.tema.map((t) => t.kode);
        const utama = x.tema_utama ?? utamaData;
        const baru = awalUntuk.current !== dataset;
        awalUntuk.current = dataset;
        setPilih((s) => (baru ? new Set(utama && ada.includes(utama) ? [utama] : []) : new Set([...s].filter((t) => ada.includes(t)))));
      })
      .catch((e) => { if (!batal) setMuat({ kunci: k, daftar: null, err: (e as Error).message }); });
    return () => { batal = true; };
  }, [dataset, kcPakai, utamaData]);
  const daftar = muat?.kunci === kunci ? muat.daftar : null;
  const errTema = muat?.kunci === kunci ? muat.err : "";
  const tema = daftar?.tema ?? [];
  const tanpaJumlah = !!daftar?.tanpa_jumlah;
  const dipilih = tema.filter((t) => pilih.has(t.kode));
  const semua = tema.length > 0 && dipilih.length === tema.length;
  const klaimPilih = dipilih.reduce((s, t) => s + t.klaim, 0);
  const maksKlaim = Math.max(1, ...tema.map((t) => t.klaim));
  const adaJantung = tema.some((t) => t.kode === "I");
  const ubah = (k: string) => setPilih((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const bad = nama.trim().length < 3 ? "Beri nama proyek (paling sedikit 3 huruf)." : !ds ? "Pilih data."
    : !daftar ? (errTema ? "Daftar tema tidak tersedia." : "Memuat daftar tema…")
    : !dipilih.length ? "Pilih fokus tema: satu, beberapa, atau semua tema." : "";
  const save = async () => {
    setBusy(true); setErr("");
    try {
      const r = await kirim<{ proyek: { id: string } }>({ aksi: "proyek_baru", nama: nama.trim(), deskripsi: deskripsi.trim(), kc: kcPakai || null, dataset,
        tema_fokus: semua ? "semua" : dipilih.map((t) => t.kode) });
      onSaved(r.proyek);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const label = "mt-3 block text-[11.5px] font-medium text-[#d3d8de]";
  return (
    <Modal id="pc-judul" onClose={onClose}>
      <form className="max-h-[calc(100vh-32px)] w-full max-w-[600px] overflow-y-auto rounded-lg border border-white/10 bg-[#1c2127] p-5 shadow-2xl"
        onSubmit={(e) => { e.preventDefault(); if (!bad) save(); }}>
        <p id="pc-judul" className="text-[15px] font-semibold text-white">Proyek baru · AI Agent Swarm Branch</p>
        <label htmlFor="pc-nama" className={label}>Nama proyek</label>
        <input id="pc-nama" autoFocus value={nama} onChange={(e) => setNama(e.target.value)} maxLength={120} placeholder="mis. Audit jantung KC Makassar 2025" className={`${field} mt-1`} />
        <label htmlFor="pc-desk" className={label}>Deskripsi <span className="font-normal text-[#8f99a8]">(opsional)</span></label>
        <textarea id="pc-desk" value={deskripsi} onChange={(e) => setDeskripsi(e.target.value)} rows={2} maxLength={600}
          placeholder="mis. Klaim jantung dan pembuluh darah di RS wilayah KC Makassar, dibandingkan dengan rekam medis" className={`${field} mt-1 resize-y leading-relaxed`} />
        <label htmlFor="pc-data" className={label}>Data</label>
        <select id="pc-data" value={dataset} onChange={(e) => setDataset(e.target.value)} className={`${field} mt-1`}>
          {d.dataset.map((x) => <option key={x.id} value={x.id}>{x.nama}{x.siap ? "" : " (jumlah per tema belum dihitung)"}</option>)}
        </select>
        {ds && <p className="mt-1 text-[10.5px] leading-snug text-[#8f99a8]">{ds.keterangan}{ds.perlu ? ` Sebelum membuat audit: ${ds.perlu}.` : ""}</p>}

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p id="pc-tema" className="text-[11.5px] font-medium text-[#d3d8de]">Fokus tema <span className="font-normal text-[#8f99a8]">(wajib)</span></p>
          {adaJantung && (
            <button type="button" onClick={() => setPilih(new Set(["I"]))} aria-pressed={dipilih.length === 1 && pilih.has("I")}
              className={`rounded-full border px-2 py-0.5 text-[10.5px] ${dipilih.length === 1 && pilih.has("I") ? "border-[#9d8cff] bg-[#9d8cff]/15 text-white" : "border-white/15 text-[#c9c0ff] hover:bg-white/5"}`}>
              Jantung saja
            </button>
          )}
          <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-[#d3d8de]">
            <input type="checkbox" checked={semua} disabled={!tema.length} className="accent-[#5b5fd6]"
              ref={(el) => { if (el) el.indeterminate = dipilih.length > 0 && !semua; }}
              onChange={() => setPilih(semua ? new Set() : new Set(tema.map((t) => t.kode)))} />
            Pilih semua
          </label>
        </div>
        <p className="mt-0.5 text-[10.5px] leading-snug text-[#8f99a8]">Tema klinis yang ingin diaudit di proyek ini. Audit baru memakai tema ini (masih bisa diubah per audit).</p>
        <div role="group" aria-labelledby="pc-tema" className="mt-1.5 max-h-[200px] overflow-y-auto rounded border border-white/10 bg-[#111418]">
          {errTema && <p className="p-3 text-[11.5px] text-[#ffb4b4]">{errTema}</p>}
          {!daftar && !errTema && <p className="p-3 text-[11.5px] text-[#8f99a8]">Memuat daftar tema…</p>}
          {tema.map((t) => (
            <label key={t.kode} className={`flex cursor-pointer items-center gap-2 border-b border-white/5 px-2 py-1.5 last:border-b-0 ${pilih.has(t.kode) ? "bg-[#5b5fd6]/10" : "hover:bg-white/5"}`}>
              <input type="checkbox" checked={pilih.has(t.kode)} onChange={() => ubah(t.kode)} className="accent-[#5b5fd6]" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-[#e5e8eb]">{t.nama}</span>
              {t.rekam_medis && <span className="shrink-0 rounded bg-[#199e70]/20 px-1 text-[9.5px] font-semibold text-[#7ee2c0]" title="klaim tema ini punya rekam medis untuk dicocokkan">rekam medis</span>}
              {!tanpaJumlah && (
                <span className="hidden h-1.5 w-[90px] shrink-0 overflow-hidden rounded bg-white/5 sm:block" aria-hidden>
                  <span className="block h-full rounded bg-[#9d8cff]/55" style={{ width: `${Math.max(2, (100 * t.klaim) / maksKlaim)}%` }} />
                </span>
              )}
              <span className="w-[70px] shrink-0 text-right text-[11.5px] tabular-nums text-[#d3d8de]">{tanpaJumlah ? "—" : angka(t.klaim)}</span>
            </label>
          ))}
        </div>
        {daftar && (
          <p className="mt-1.5 rounded border border-[#9d8cff]/30 bg-[#9d8cff]/10 px-2 py-1.5 text-[11.5px] text-[#e0dbff]" aria-live="polite">
            Fokus tema proyek: <b className="font-semibold text-white">{!dipilih.length ? "belum dipilih" : semua ? `semua ${tema.length} tema klinis` : namaTema(dipilih.map((t) => t.nama), 4)}</b>
            {dipilih.length > 0 && !tanpaJumlah && <> · <b className="font-semibold text-white">{angka(klaimPilih)}</b> klaim</>}
          </p>
        )}
        {daftar && <p className="mt-1 text-[10.5px] leading-snug text-[#8f99a8]">{daftar.sumber}{daftar.catatan ? ` ${daftar.catatan}` : ""}</p>}

        <label htmlFor="pc-kc" className={label}>Kantor cabang</label>
        <select id="pc-kc" value={kcPakai} disabled={!!ds?.kc} onChange={(e) => setKc(e.target.value)} className={`${field} mt-1 disabled:opacity-70`}>
          <option value="">Semua kantor cabang</option>
          {prov.map(([p, xs]) => <optgroup key={p} label={p}>{xs.map((k) => <option key={k.id} value={k.id}>{k.nama}</option>)}</optgroup>)}
        </select>
        {ds?.kc && <p className="mt-1 text-[10.5px] text-[#8f99a8]">Data ini hanya berisi klaim {ds.kc_nama ?? ds.kc}.</p>}
        <div className="mt-5 flex items-center justify-end gap-2">
          {(bad && nama) || err ? <p className="mr-auto text-[11.5px] text-[#ffb4b4]">{err || bad}</p> : null}
          <button type="button" onClick={onClose} className="rounded-sm border border-white/15 px-3 py-1.5 text-[12px] text-[#d3d8de] hover:bg-white/10">Batal</button>
          <button type="submit" disabled={busy || !!bad} className="flex items-center gap-1 rounded-sm bg-[#5b5fd6] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#6a6ee0] disabled:opacity-40">
            <Icon name="plus" className="h-3 w-3" />{busy ? "Menyimpan…" : "Buat proyek"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** A project's audit form: its name, the clinical themes it reads (one, several or all, with each theme's claim count; starting
 *  from the project's theme focus), its cost cap and IoT data; saved ready to run, or, after the start confirmation, saved and
 *  started. With `dari` (back from "Ubah tema"): that audit changed when it never ran, else a new audit starting from its choices. */
function AuditBaruDialog({ p, d, dari, onDone, onClose }: { p: Proyek; d: Daftar; dari?: Audit | null; onDone: (audit: string, mulai: JawabMulai | null) => void;
  onClose: () => void }) {
  const ubahAudit = !!dari && dari.status === "siap" && !dari.run;  // changes that audit (the API checks it never ran)
  const [label, setLabel] = useState(ubahAudit && dari ? dari.label : `${p.nama} · audit ${p.audit.length + 1}`);
  const [daftar, setDaftar] = useState<DaftarTema | null>(null);
  const [errTema, setErrTema] = useState("");
  const [pilih, setPilih] = useState<Set<string>>(new Set());
  // the themes it starts on: the audit it came from, else the project's focus (null = every theme)
  const [awalTema] = useState<string[] | null>(() => (dari ? dari.tema : p.tema_fokus ?? null));
  // in the /swarm-x demo a new audit starts on the replayed scan's own settings (demoCabang.ts)
  const [demo] = useState(bawaanAuditDemo);
  const [batas, setBatas] = useState(String(dari?.batas_usd ?? demo?.batas ?? d.batas_usd.bawaan));
  const [iotMode, setIotMode] = useState<IotMode>(dari?.iot?.sumber ?? (p.dataset !== "gen3" ? demo?.iot : undefined) ?? "tidak");
  const [ukuran, setUkuran] = useState<number | null>(dari?.replika ?? demo?.ukuran ?? null);  // the last N replicas; null = every replica
  const [iotFolder, setIotFolder] = useState(dari?.iot?.sumber === "folder" ? dari.iot.tampil : "");
  const [iotDaftar, setIotDaftar] = useState<string[]>([]);
  const bisaIot = p.dataset !== "gen3";
  const [busy, setBusy] = useState<"" | "simpan" | "mulai">("");
  const [err, setErr] = useState("");
  const [tanya, setTanya] = useState(false);  // the start confirmation, in place of the form
  useEffect(() => {
    let batal = false;
    ambil<DaftarTema>(`${API}?tema=1&proyek=${encodeURIComponent(p.id)}`)
      .then((x) => {
        if (batal) return;
        setDaftar(x);
        const ada = x.tema.map((t) => t.kode);
        const awal = awalTema ? awalTema.filter((k) => ada.includes(k)) : ada;
        setPilih(new Set(awal.length ? awal : x.tema_utama && ada.includes(x.tema_utama) ? [x.tema_utama] : []));
      })
      .catch((e) => { if (!batal) setErrTema((e as Error).message); });
    return () => { batal = true; };
  }, [p.id, awalTema]);
  // IoT folders already under the allowed roots, offered while typing (the server checks the path again)
  useEffect(() => {
    if (iotMode !== "folder" || iotDaftar.length) return;
    ambil<{ folder: string[] }>(`${API}?iot=1`).then((x) => setIotDaftar(x.folder ?? [])).catch(() => undefined);
  }, [iotMode, iotDaftar.length]);
  const tema = daftar?.tema ?? [];
  const kode = tema.map((t) => t.kode);
  const bisaUkur = adaPerReplika(daftar), nRep = daftar?.replika ?? 0;
  const uk = bisaUkur ? ukuran : null;  // the size the counts are for
  const maksKlaim = Math.max(1, ...tema.map((t) => klaimUkuran(t, uk)));
  const dipilih = tema.filter((t) => pilih.has(t.kode));
  const semua = tema.length > 0 && dipilih.length === tema.length;
  const klaimPilih = dipilih.reduce((s, t) => s + klaimUkuran(t, uk), 0);
  const kira = bisaUkur ? perkiraan(klaimPilih, uk ?? nRep) : null;
  const adaJantung = tema.some((t) => t.kode === "I");
  const fokus = p.tema_fokus ?? null;
  const fokusAda = fokus ? fokus.filter((k) => kode.includes(k)) : kode;
  const beda = dipilih.length > 0 && kunciTema(semua ? null : dipilih.map((t) => t.kode), kode) !== kunciTema(fokus, kode);
  const ubah = (k: string) => setPilih((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const nBatas = Number(batas);
  const bad = label.trim().length < 3 ? "Beri nama audit (paling sedikit 3 huruf)."
    : !daftar ? (errTema ? "Daftar tema belum tersedia." : "Memuat daftar tema…")
    : !dipilih.length ? "Pilih paling sedikit satu tema, atau Pilih semua."
    : !Number.isFinite(nBatas) || nBatas <= 0 ? "Isi batas biaya lebih dari $0."
    : nBatas > d.batas_usd.maks ? `Batas biaya paling tinggi ${usdLimit(d.batas_usd.maks)}${d.admin ? "" : " (admin bisa menaikkan)"}.`
    : iotMode === "folder" && !iotFolder.trim() ? "Isi folder data IoT, atau pilih tidak ada / sintetis." : "";
  const iotTeks = !bisaIot || iotMode === "tidak" ? "tidak ada (klaim dicocokkan dengan rekam medis saja)"
    : iotMode === "sintetis" ? "sintetis (dibuat untuk audit ini)" : `folder ${iotFolder.trim()}`;
  const ringkasan: Ringkasan = {
    label: label.trim(), tema: semua ? null : dipilih.map((t) => t.kode), temaNama: dipilih.map((t) => t.nama), jumlahTema: tema.length,
    klaim: klaimPilih, klaimSemua: tema.reduce((s, t) => s + klaimUkuran(t, uk), 0), batas: nBatas, iot: iotTeks, beda,
    ukuran: bisaUkur ? teksUkuran(uk, nRep) : null, perkiraan: kira,
  };
  const simpan = async (mulai: boolean) => {
    setBusy(mulai ? "mulai" : "simpan"); setErr("");
    try {
      const isi = { proyek: p.id, label: label.trim(), tema: semua ? "semua" : dipilih.map((t) => t.kode), batas_usd: nBatas,
        iot: bisaIot ? iotMode : "tidak", ...(bisaIot && iotMode === "folder" ? { iot_folder: iotFolder.trim() } : {}),
        ...(bisaUkur ? { replika: uk ?? "semua" } : {}) };
      const r = await kirim<{ audit: { id: string } }>(ubahAudit && dari ? { aksi: "ubah_audit", audit: dari.id, ...isi } : { aksi: "audit_baru", ...isi });
      let jawab: JawabMulai | null = null;
      if (mulai) {
        // only from the confirmation below (KonfirmasiMulai)
        try { jawab = await kirim<JawabMulai>({ aksi: "mulai", proyek: p.id, audit: r.audit.id, konfirmasi: true }); } catch (e) { jawab = { error: (e as Error).message }; }
      }
      onDone(r.audit.id, jawab);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };
  if (tanya) {
    return (
      <Modal id="ac-konfirmasi" onClose={() => setTanya(false)}>
        <KonfirmasiMulai id="ac-konfirmasi" p={p} r={ringkasan} siap busy={!!busy} err={err}
          onUbah={() => { setTanya(false); setErr(""); }} onMulai={() => { if (!bad) simpan(true); }} />
      </Modal>
    );
  }
  return (
    <Modal id="ac-judul" onClose={onClose}>
      <form className="flex max-h-[calc(100vh-32px)] w-full max-w-[680px] flex-col overflow-y-auto rounded-lg border border-white/10 bg-[#1c2127] p-5 shadow-2xl"
        onSubmit={(e) => { e.preventDefault(); if (!bad) simpan(false); }}>
        <p id="ac-judul" className="text-[15px] font-semibold text-white">{ubahAudit ? "Ubah audit" : "Audit baru"} · {p.nama}</p>
        <p className="mt-1 text-[11.5px] text-[#abb3bf]">{p.kc_nama ?? "Semua kantor cabang"} · {p.dataset_nama} · fokus tema proyek: {fokusTeks(p)}</p>
        {dari && !ubahAudit && (
          <p className="mt-1.5 text-[11px] text-[#8f99a8]">&ldquo;{dari.label}&rdquo; sudah pernah dijalankan, jadi pilihan ini disimpan sebagai audit baru.</p>
        )}
        <label htmlFor="ac-label" className="mt-4 block text-[11.5px] font-medium text-[#d3d8de]">Nama audit</label>
        <input id="ac-label" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} className={`${field} mt-1`} />

        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="text-[11.5px] font-medium text-[#d3d8de]" id="ac-tema">Tema klinis</p>
          {adaJantung && (
            <button type="button" onClick={() => setPilih(new Set(["I"]))} aria-pressed={dipilih.length === 1 && pilih.has("I")}
              className={`rounded-full border px-2 py-0.5 text-[10.5px] ${dipilih.length === 1 && pilih.has("I") ? "border-[#9d8cff] bg-[#9d8cff]/15 text-white" : "border-white/15 text-[#c9c0ff] hover:bg-white/5"}`}>
              Jantung saja
            </button>
          )}
          <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-[#d3d8de]">
            <input type="checkbox" checked={semua} disabled={!tema.length} className="accent-[#5b5fd6]"
              ref={(el) => { if (el) el.indeterminate = dipilih.length > 0 && !semua; }}
              onChange={() => setPilih(semua ? new Set() : new Set(kode))} />
            Pilih semua
          </label>
          <span className="ml-auto text-[11px] tabular-nums text-[#abb3bf]">{semua ? `Semua ${tema.length} tema` : `${dipilih.length} dari ${tema.length} tema`}</span>
        </div>
        <div role="group" aria-labelledby="ac-tema" className="mt-1.5 min-h-[120px] flex-1 overflow-y-auto rounded border border-white/10 bg-[#111418]">
          {errTema && <p className="p-3 text-[11.5px] text-[#ffb4b4]">{errTema}</p>}
          {!daftar && !errTema && <p className="p-3 text-[11.5px] text-[#8f99a8]">Memuat daftar tema…</p>}
          {tema.map((t) => (
            <label key={t.kode} className={`flex cursor-pointer items-center gap-2 border-b border-white/5 px-2 py-1.5 last:border-b-0 ${pilih.has(t.kode) ? "bg-[#5b5fd6]/10" : "hover:bg-white/5"}`}>
              <input type="checkbox" checked={pilih.has(t.kode)} onChange={() => ubah(t.kode)} className="accent-[#5b5fd6]" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-[#e5e8eb]">{t.nama}</span>
              {fokus?.includes(t.kode) && <span className="shrink-0 rounded bg-[#9d8cff]/20 px-1 text-[9.5px] font-semibold text-[#ddd6ff]" title="tema ini fokus proyek">fokus proyek</span>}
              {t.rekam_medis && <span className="shrink-0 rounded bg-[#199e70]/20 px-1 text-[9.5px] font-semibold text-[#7ee2c0]" title="klaim tema ini punya rekam medis untuk dicocokkan">rekam medis</span>}
              <span className="hidden h-1.5 w-[110px] shrink-0 overflow-hidden rounded bg-white/5 sm:block" aria-hidden>
                <span className="block h-full rounded bg-[#9d8cff]/55" style={{ width: `${Math.max(2, (100 * t.klaim) / maksKlaim)}%` }} />
              </span>
              <span className="w-[76px] shrink-0 text-right text-[11.5px] tabular-nums text-[#d3d8de]">{angka(klaimUkuran(t, uk))}</span>
            </label>
          ))}
        </div>
        {daftar && (
          <p className="mt-1.5 rounded border border-[#9d8cff]/30 bg-[#9d8cff]/10 px-2 py-1.5 text-[12px] text-[#e0dbff]" aria-live="polite">
            Tema audit ini: <b className="font-semibold text-white">{!dipilih.length ? "belum dipilih" : semua ? `semua ${tema.length} tema klinis` : namaTema(dipilih.map((t) => t.nama), 4)}</b>
            {dipilih.length > 0 && <> · <b className="font-semibold text-white">{angka(klaimPilih)}</b> klaim</>}
          </p>
        )}
        {beda && (
          <p className={`mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 ${catatanKuning}`}>
            <span>Berbeda dari fokus tema proyek ({fokusTeks(p)}).</span>
            {fokusAda.length > 0 && (
              <button type="button" onClick={() => setPilih(new Set(fokusAda))} className="rounded border border-[#fab219]/50 px-1.5 py-0.5 text-[10.5px] hover:bg-[#fab219]/15">
                Pakai fokus proyek
              </button>
            )}
          </p>
        )}
        {daftar && <p className="mt-1 text-[10.5px] leading-snug text-[#8f99a8]">Urut dari klaim terbanyak. {daftar.sumber}{daftar.catatan ? ` ${daftar.catatan}` : ""}</p>}

        {bisaUkur && (
          <fieldset className="mt-3">
            <legend className="text-[11.5px] font-medium text-[#d3d8de]">Ukuran data <span className="font-normal text-[#8f99a8]">(berapa ulangan setahun yang dibaca)</span></legend>
            <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label="Ukuran data">
              {[...UKURAN.filter((n) => n < nRep), null].map((n) => {
                const on = (uk ?? null) === n, nk = dipilih.reduce((s, t) => s + klaimUkuran(t, n), 0);
                return (
                  <button key={n ?? "semua"} type="button" onClick={() => setUkuran(n)} aria-pressed={on}
                    className={`rounded border px-2 py-1 text-left text-[11.5px] leading-tight ${on ? "border-[#9d8cff] bg-[#9d8cff]/15 text-white" : "border-white/15 text-[#d3d8de] hover:bg-white/5"}`}>
                    {n ? `${n} ulangan terakhir` : `Semua ${nRep} ulangan`}
                    <span className="block text-[10.5px] tabular-nums text-[#8f99a8]">{angka(nk)} klaim</span>
                  </button>
                );
              })}
            </div>
            {kira && (
              <p className="mt-1.5 text-[10.5px] leading-snug text-[#8f99a8]">
                Perkiraan kasar untuk pilihan ini: biaya AI <b className="font-semibold text-[#e5e8eb]">{usdKira(kira.usd)}</b>, waktu <b className="font-semibold text-[#e5e8eb]">{kira.waktu}</b> (dari audit Jantung sebelumnya: ±16% klaim dibaca agen AI). Laporan Jantung yang sekarang memakai 5 ulangan terakhir.
              </p>
            )}
            {kira && Number.isFinite(nBatas) && kira.usd > nBatas && (
              <p className={`mt-1.5 ${catatanKuning}`}>
                Perkiraan biaya {usdKira(kira.usd)} lebih besar dari batas {usdLimit(nBatas)}: agen AI berhenti di batas dan sisa klaim yang meragukan tercatat &ldquo;belum dibaca&rdquo;.
                Untuk membaca semuanya, naikkan batas ke sekitar ${kira.saran}.
              </p>
            )}
          </fieldset>
        )}

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="ac-batas" className="block text-[11.5px] font-medium text-[#d3d8de]">Batas biaya model AI (USD)</label>
            <input id="ac-batas" type="number" min={1} max={d.batas_usd.maks} step={1} value={batas} onChange={(e) => setBatas(e.target.value)} className={`${field} mt-1 w-[120px] tabular-nums`} />
          </div>
          <p className="pb-1.5 text-[10.5px] text-[#8f99a8]">Bawaan {usdLimit(d.batas_usd.bawaan)}; paling tinggi {usdLimit(d.batas_usd.maks)}{d.admin ? " (admin)" : ", admin bisa menaikkan"}. Audit berhenti memanggil model AI saat batas tercapai.</p>
        </div>

        {bisaIot && (
          <fieldset className="mt-3">
            <legend className="text-[11.5px] font-medium text-[#d3d8de]">Data IoT <span className="font-normal text-[#8f99a8]">(pemakaian alat medis)</span></legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {([["tidak", "Tidak ada"], ["sintetis", "Sintetis"], ["folder", "Folder"]] as [IotMode, string][]).map(([v, t]) => (
                <label key={v} className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-[#d3d8de]">
                  <input type="radio" name="ac-iot" value={v} checked={iotMode === v} onChange={() => setIotMode(v)} className="accent-[#5b5fd6]" />{t}
                </label>
              ))}
            </div>
            {iotMode === "folder" && (
              <>
                <input aria-label="Folder data IoT" value={iotFolder} onChange={(e) => setIotFolder(e.target.value)} maxLength={400} list="ac-iot-daftar"
                  placeholder={'mis. Data Sintetis/tema_jantung_kc_sul-7371/iot atau data/iot/rs_a'} className={`${field} mt-1.5 font-mono`} />
                <datalist id="ac-iot-daftar">{iotDaftar.map((x) => <option key={x} value={x} />)}</datalist>
              </>
            )}
            <p className="mt-1 text-[10.5px] leading-snug text-[#8f99a8]">
              {iotMode === "tidak" ? "Tanpa data IoT: klaim dicocokkan dengan rekam medis saja."
                : iotMode === "sintetis" ? "Data pemakaian alat sintetis dibuat untuk audit ini (benih tetap), untuk uji alur."
                  : "Folder berformat data IoT (alat, pengikatan alat–pasien–kunjungan, catatan waktu nyala dan mode, jangkar). Harus berada di dalam folder Data Sintetis atau data/iot; isinya diperiksa saat audit dimulai."}
              {" "}Sensor membaca waktu nyala, lama dan mode alat dari kabel dayanya, bukan tanda vital pasien.
            </p>
          </fieldset>
        )}

        {(bad && label) || err ? <p className="mt-3 text-[11.5px] text-[#ffb4b4]">{err || bad}</p> : null}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {!d.admin && <span className="mr-auto text-[10.5px] text-[#8f99a8]">Audit disimpan siap dijalankan; hanya admin yang bisa memulainya.</span>}
          <button type="button" onClick={onClose} className="rounded-sm border border-white/15 px-3 py-1.5 text-[12px] text-[#d3d8de] hover:bg-white/10">Batal</button>
          <button type="submit" disabled={!!busy || !!bad} className="flex items-center gap-1 rounded-sm border border-[#9d8cff]/60 px-3 py-1.5 text-[12px] font-medium text-[#e0dbff] hover:bg-[#9d8cff]/10 disabled:opacity-40">
            <Icon name="save" className="h-3 w-3" />{busy === "simpan" ? "Menyimpan…" : ubahAudit ? "Simpan perubahan" : "Simpan audit"}
          </button>
          <button type="button" onClick={() => { if (!bad) { setErr(""); setTanya(true); } }} disabled={!!busy || !!bad || !d.admin}
            title={d.admin ? "ringkasan audit ditampilkan dulu sebelum dimulai" : "hanya admin yang bisa memulai audit"}
            className="flex items-center gap-1 rounded-sm bg-[#5b5fd6] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#6a6ee0] disabled:opacity-40">
            <Icon name="play" className="h-3 w-3" />Mulai audit…
          </button>
        </div>
      </form>
    </Modal>
  );
}
