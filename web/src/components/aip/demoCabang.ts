"use client";
import { useSyncExternalStore } from "react";

/* /swarm-x · AI Agent Swarm Branch (the user, 2026-11-16: "bikin /swarm-x disini saya bisa buka create new project, klik tema
   jantung seakan2 audit baru tema jantung, padahal pake yg sekarang udh selesai scan nya, perbaiki UI UX nya buat demo").
   While the page is open the branch tab's calls are answered here: its projects and audits live in the page only, and "Mulai
   audit" plays the finished cardiology scan (run jantung_iot_5r: KC Makassar, the last 5 replicas, IoT + medical records) on a
   clock the speed buttons drive — the runner's seven stages, its counts and log lines in the runner's own format, all taken from
   that run's report (8,118 claims, TAHAN 213, RAGU 1,287, 331 to examine, 956 cleared, IoT 82/77/5, swarm $1.648). The audit ends
   on that run's report, dated and named as this audit ran, with no verifier marks yet. No runner starts, no model is called and
   nothing is written: a verifier's mark stays in the page, and any other change sent under /api/swarm-cabang or /api/aip is
   refused. Reads of the report itself (its claims, graph, trail, costs) go to the server as usual. */

export const SUMBER_RUN = "jantung_iot_5r";
const SUMBER_PROYEK = "p_jantung_iot_rme_makassar";  // its project: the theme list (claims per replica) is read from it
const SUMBER_DATA = "tema_jantung_kc_sul-7371";
export const DEMO_SPEEDS_CABANG = [1, 5, 15, 40, 100];
const API = "/api/swarm-cabang/proyek";

// the recorded run (kc_sul-7371.json sampul / iot, status.json gerbang, index.json biaya)
const REK = {
  klaim: 8118, tahan: 213, ragu: 1287, periksa: 331, dibersihkan: 956, antrean: 544, nilai_antrean_rp: 4734998700,
  iot: { beralat: 82, sesuai: 77, tidak: 5, selisih_rp: 31484800 },
  // the rule engine's signals on the run's claims (kc_sul-7371.json indikasi.data)
  sinyal: { klaim: 8118, klaim_bersinyal: 1562, teratas: [{ kode: "READMISI", label: "Readmisi ≤ 30 hari di faskes yang sama", n: 746 },
    { kode: "RME_DIAGNOSIS_TIDAK_TERCATAT", label: "Diagnosis yang ditagih tidak ada di rekam medis", n: 218 },
    { kode: "RME_KLINIS_TIDAK_MENDUKUNG", label: "Tindakan tanpa indikasi medis di rekam medis", n: 163 }] },
  // its tag summary (kc_sul-7371.json indikasi): shown from the aturan stage on, as the report counts it
  indikasi: { klaim: 8118, klaim_bertag: 2258, tag_aturan: 1963, tag_model: 1461, kekuatan: { lemah: 1567, sedang: 774, kuat: 1088 },
    per_tag: [{ tag: "RISIKO_ML_TINGGI", label: "Risiko tinggi menurut model", sumber: "model" as const, n: 1461 },
      { tag: "READMISI", label: "Readmisi tidak wajar", sumber: "aturan" as const, n: 813 },
      { tag: "TIDAK_SESUAI_INDIKASI", label: "Tidak sesuai indikasi medis", sumber: "aturan" as const, n: 278 },
      { tag: "UPCODING_KEPARAHAN", label: "Upcoding keparahan / kode", sumber: "aturan" as const, n: 274 }],
    ambang: { tahan: 0.7832, periksa: 0.2931, ragu: 0.121 },
    data: { baris: 8118, kolom: 49, peserta: 1654, rs: 85, klaim_bersinyal: 1562, sinyal: [] as { kode: string; label: string; n: number }[] } },
  // its Box, values and exhibits (kc_sul-7371.json box, sampul, exhibit, bab): shown from the laporan stage on
  laporan: { antrean: 544, nilai_terindikasi_rp: 4734998700, estimasi_kerugian_rp: 1524540700, exhibit: 20, bab: 11,
    box: { rs: 79, rs_klaim: 85, estimasi_kerugian_rp: 1524540700, jalur: { ditindak: 5, dibina: 35, dibebaskan: 39 }, kriteria: [] as string[],
      kelompok: { A: { rs: 7, estimasi_kerugian_rp: 811679500, rekomendasi: 7 }, B: { rs: 12, estimasi_kerugian_rp: 415940500, rekomendasi: 12 },
        C: { rs: 16, estimasi_kerugian_rp: 223280800, rekomendasi: 16 }, D: { rs: 13, estimasi_kerugian_rp: 59001600, rekomendasi: 13 },
        Z: { rs: 31, estimasi_kerugian_rp: 14638300, rekomendasi: 15 } } } }, usd_swarm: 1.648, usd: 1.652, replika: [57, 58, 59, 60, 61], per_replika: [] as number[],
};
const BATCH = 8, N_BATCH = Math.ceil(REK.ragu / BATCH);
// the stages in seconds of audit time (a real run of this size: ~1.5 min per replica, ~8 s per swarm batch): ~34 min, ~2 min at 15x
const FASE: [string, number][] = [["fitur", 450], ["zona", 20], ["iot", 30], ["aturan", 30], ["swarm", N_BATCH * 8], ["laporan", 60], ["narasi", 120]];
const TOTAL = FASE.reduce((s, [, t]) => s + t, 0);
const TAHAP = FASE.map(([k]) => k);

type Rec = Record<string, unknown>;
type AuditRaw = { id: string; label: string; tema: string[] | null; batas_usd: number; status: "siap" | "berjalan" | "selesai" | "dibatalkan";
  dibuat_pada: string; dibuat_oleh: string; dimulai_pada?: string; iot: { sumber: "sintetis" | "folder"; tampil: string } | null; replika: number | null;
  /** the audit clock: seconds of audit time, the wall time it last moved, and when it ended (ms) */ jam?: number; dinding?: number; selesai_ms?: number };
type ProyekRaw = { id: string; nama: string; deskripsi: string; kc: string | null; dataset: string; tema_fokus: string[] | null; dibuat_pada: string;
  dibuat_oleh: string; audit: AuditRaw[] };

const S = {
  speed: 15, paused: false, proyek: [] as ProyekRaw[], verif: {} as Record<string, Rec>,
  dasar: null as Promise<Rec> | null, temaNama: {} as Record<string, string>, runBaris: null as Rec | null, oleh: "admin", err: "",
};

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(Math.ceil(n / 2))), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, n);
const dua = (n: number) => String(n).padStart(2, "0");
/** a wall time as the runner writes it (WIB, "YYYY-MM-DD HH:MM:SS") */
function wibTeks(ms: number, detik = true) {
  const d = new Date(ms + 7 * 3600e3);
  const s = `${d.getUTCFullYear()}-${dua(d.getUTCMonth() + 1)}-${dua(d.getUTCDate())} ${dua(d.getUTCHours())}:${dua(d.getUTCMinutes())}`;
  return detik ? `${s}:${dua(d.getUTCSeconds())}` : s;
}
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const tolak = (msg: string, status = 400) => json({ error: msg }, status);

let asli: typeof fetch | null = null;
const ambilAsli = async (url: string): Promise<Rec> => {
  const r = await asli!(url, { cache: "no-store" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error || `HTTP ${r.status}`);
  return d as Rec;
};

/** what the demo borrows from the server once: the data and branch lists, the theme names and replica sizes, the run's row */
function dasar(): Promise<Rec> {
  S.dasar ??= (async () => {
    const [d, tema, runs] = await Promise.all([ambilAsli(API), ambilAsli(`${API}?tema=1&proyek=${SUMBER_PROYEK}`), ambilAsli("/api/swarm-cabang")]);
    for (const t of (tema.tema ?? []) as { kode: string; nama: string; per_replika?: number[] }[]) {
      S.temaNama[t.kode] = t.nama;
      if (t.kode === "I" && t.per_replika?.length) REK.per_replika = t.per_replika.slice(-REK.replika.length);
    }
    S.runBaris = ((runs.runs ?? []) as Rec[]).find((r) => r.id === SUMBER_RUN) ?? null;
    // the cardiology data of KC Makassar first: "Buat proyek baru" opens on it
    const ds = [...((d.dataset ?? []) as { id: string }[])].sort((a, b) => Number(b.id === SUMBER_DATA) - Number(a.id === SUMBER_DATA));
    return { dataset: ds, kc: d.kc ?? [], batas_usd: d.batas_usd ?? { bawaan: 20, maks: 100 } };
  })();
  S.dasar.catch((e) => { S.dasar = null; S.err = (e as Error).message; emit(); });
  return S.dasar;
}

// ------------------------------------------------------------------------------------------------ the audit clock

function maju(a: AuditRaw, now = Date.now()) {
  if (a.status !== "berjalan" || a.jam === undefined || a.dinding === undefined) return;
  if (!S.paused) a.jam = Math.min(TOTAL, a.jam + ((now - a.dinding) / 1000) * S.speed);
  a.dinding = now;
  if (a.jam >= TOTAL) { a.status = "selesai"; a.selesai_ms = now; emit(); }
}
const semuaAudit = () => S.proyek.flatMap((p) => p.audit);
const majuSemua = () => { const now = Date.now(); semuaAudit().forEach((a) => maju(a, now)); };

/** where the replay is at a given second of audit time */
function posisi(jam: number) {
  let t = 0;
  for (let i = 0; i < FASE.length; i++) {
    const [k, lama] = FASE[i];
    if (jam < t + lama) return { i, tahap: k, frac: (jam - t) / lama };
    t += lama;
  }
  return { i: FASE.length, tahap: null as string | null, frac: 1 };
}
const mulaiFase = (k: string) => FASE.slice(0, TAHAP.indexOf(k)).reduce((s, [, t]) => s + t, 0);

/** the runner's log lines up to this second of audit time, in its format ("[  12.3 min] ...") */
function log(a: AuditRaw, jam: number): string[] {
  const out: [number, string][] = [];
  const say = (t: number, s: string) => { if (t <= jam) out.push([t, s]); };
  const iot = a.iot ? "IoT sintetis" : "tanpa IoT";
  say(0, `set ${a.id} · NYATA (batas $${a.batas_usd.toFixed(1)}) · KC sul-7371 · tema ['I'] · ${REK.replika.length} replika · ${iot} · tahap ${TAHAP.join(",")}`);
  const fl = FASE[0][1] / REK.replika.length;
  // per replica without its claim count: the theme list counts 8,161 for these replicas, the run kept 8,118 (its zones say so next)
  REK.replika.forEach((r, i) => say(fl * (i + 1), `fitur: replika ${r} selesai · mesin aturan + rekam medis + 646 fitur ML v7`));
  say(mulaiFase("zona") + 18, `zona: ${REK.klaim} klaim · TAHAN ${REK.tahan} · RAGU ${REK.ragu} (termasuk yang dirutekan rule)`);
  if (a.iot) say(mulaiFase("iot") + 26, `iot periksa: ${REK.iot.beralat} klaim beralat · sesuai ${REK.iot.sesuai} · tidak sesuai ${REK.iot.tidak}`);
  say(mulaiFase("aturan") + 25, `aturan: dibaca swarm ${REK.ragu} klaim · temuan IoT ${a.iot ? REK.iot.tidak : 0}`);
  const s0 = mulaiFase("swarm"), dur = FASE[4][1] / N_BATCH;
  for (let b = 1; b <= N_BATCH; b++) {
    const t = s0 + b * dur;
    if (t > jam) break;
    const n = b < N_BATCH ? BATCH : REK.ragu - BATCH * (N_BATCH - 1);
    say(t, `swarm: batch ${b}/${N_BATCH} · ${n} klaim · ≈$${(REK.usd_swarm / N_BATCH).toFixed(3)}`);
  }
  say(s0 + FASE[4][1], `swarm: dibaca ${REK.ragu} · periksa ${REK.periksa} · dibersihkan ${REK.dibersihkan}`);
  say(mulaiFase("laporan") + 55, `laporan: 1 KC · ${REK.antrean} klaim antrean · nilai Rp ${(REK.nilai_antrean_rp / 1e9).toFixed(2).replace(".", ",")} M`);
  say(mulaiFase("narasi") + 110, `narasi: bab dan exhibit laporan ditulis`);
  say(TOTAL, `selesai · biaya model $${REK.usd.toFixed(3)} dari batas $${a.batas_usd.toFixed(1)}`);
  return out.slice(-60).map(([t, s]) => `[${(t / 60).toFixed(1).padStart(6)} min] ${s}`);
}

const PESAN: Record<string, (f: number) => string> = {
  fitur: (f) => `Tahap mesin aturan + fitur per replika: replika ${Math.min(REK.replika.length, Math.floor(f * REK.replika.length) + 1)}/${REK.replika.length}`,
  zona: () => "Zona ML v7: klaim dibagi ke TAHAN, RAGU, LOLOS",
  iot: () => "Mencocokkan klaim dengan data pemakaian alat (IoT)",
  aturan: () => "Rule engine + rekam medis: klaim yang dibaca AI Agent Swarm",
  swarm: (f) => `AI Agent Swarm: batch ${Math.min(N_BATCH, Math.floor(f * N_BATCH) + 1)}/${N_BATCH}`,
  laporan: () => "Menyusun laporan kantor cabang",
  narasi: () => "Menulis narasi laporan",
};

/** the live state the chart polls (api/swarm-cabang/proyek?langsung=1), as the runner's status.json gives it */
function langsung(a: AuditRaw) {
  maju(a);
  const jam = a.status === "selesai" ? TOTAL : a.jam ?? 0;
  const { i, tahap, frac } = posisi(jam);
  const lewat = (k: string) => TAHAP.indexOf(k) < i;
  const swarmF = tahap === "swarm" ? frac : lewat("swarm") ? 1 : 0;
  const batch = Math.min(N_BATCH, Math.floor(swarmF * N_BATCH));
  const dibaca = Math.min(REK.ragu, batch * BATCH);
  const periksa = Math.round(REK.periksa * (dibaca / REK.ragu));
  const usd = lewat("swarm") ? (lewat("narasi") || a.status === "selesai" ? REK.usd : REK.usd_swarm) : REK.usd_swarm * swarmF;
  return {
    status: a.status, tahap, tahap_daftar: TAHAP, tahap_selesai: TAHAP.slice(0, i), mulai: wibTeks(Date.now() - jam * 1000),
    usd: Math.round(usd * 1e4) / 1e4, batas: a.batas_usd, pesan: tahap ? PESAN[tahap](frac) : "Selesai.", iot: !!a.iot, replika: REK.replika.length,
    progres: tahap === "fitur" ? { replika_selesai: Math.floor(frac * REK.replika.length), replika_total: REK.replika.length }
      : tahap === "swarm" ? { batch, batch_total: N_BATCH } : null,
    zona: lewat("zona") ? { klaim: REK.klaim, tahan: REK.tahan, ragu: REK.ragu } : null,
    gerbang: tahap === "swarm" || lewat("swarm") ? { dibaca, periksa, dibersihkan: dibaca - periksa } : null,
    // the device check's result once its stage is done (the chart's AIoT block counts it)
    sinyal: lewat("zona") ? REK.sinyal : null, indikasi: lewat("aturan") ? REK.indikasi : null, laporan: lewat("laporan") ? REK.laporan : null,
    iot_hasil: a.iot && lewat("iot") ? { klaim_dengan_alat: REK.iot.beralat, sesuai: REK.iot.sesuai, tidak_sesuai: REK.iot.tidak, selisih_rp: REK.iot.selisih_rp, sintetis: true } : null,
    log: log(a, jam), klaim: REK.klaim, kc_nama: "sul-7371",
  };
}

// ------------------------------------------------------------------------------------------------ the project API, in the page

const iotTampil = (x: AuditRaw["iot"]) => (!x ? "tidak ada" : x.sumber === "sintetis" ? "sintetis (dibuat untuk audit ini)" : `folder ${x.tampil}`);
function tampilAudit(a: AuditRaw) {
  maju(a);
  const L = a.status === "berjalan" ? langsung(a) : null;
  const rb = S.runBaris ?? {};
  return {
    id: a.id, label: a.label, tema: a.tema, tema_nama: (a.tema ?? []).map((k) => S.temaNama[k] ?? k), batas_usd: a.batas_usd, status: a.status,
    run: a.status === "selesai" ? SUMBER_RUN : null, dibuat_pada: a.dibuat_pada, dibuat_oleh: a.dibuat_oleh, dimulai_pada: a.dimulai_pada,
    progres: L ? { tahap: L.tahap ?? undefined, persen: Math.round((100 * (a.jam ?? 0)) / TOTAL), pesan: L.pesan } : null,
    iot: a.iot ? { sumber: a.iot.sumber, tampil: a.iot.sumber === "folder" ? a.iot.tampil : "sintetis" } : null, iot_tampil: iotTampil(a.iot), replika: a.replika,
    run_info: a.status === "selesai" ? { id: SUMBER_RUN, label: a.label, dijalankan: new Date(a.selesai_ms ?? Date.now()).toISOString(), model: rb.model ?? "ML v7",
      kc: 1, kc_pilih: "sul-7371", biaya_usd: REK.usd, operasional: rb.operasional ?? { klaim: REK.klaim, antrean: REK.antrean, nilai_ditandai_rp: REK.nilai_antrean_rp } } : null,
  };
}
async function tampilProyek(p: ProyekRaw) {
  const b = await dasar();
  const ds = (b.dataset as { id: string; nama: string }[]).find((x) => x.id === p.dataset);
  const kc = (b.kc as { id: string; nama: string }[]).find((x) => x.id === p.kc);
  return { ...p, kc_nama: kc?.nama ?? p.kc, dataset_nama: ds?.nama ?? p.dataset, tema_fokus_nama: (p.tema_fokus ?? []).map((k) => S.temaNama[k] ?? k),
    audit: [...p.audit].reverse().map(tampilAudit) };
}
const cariProyek = (id: unknown) => S.proyek.find((p) => p.id === id) ?? null;
const cariAudit = (p: ProyekRaw | null, id: unknown) => p?.audit.find((a) => a.id === id) ?? null;
const temaDari = (v: unknown): string[] | null => (v === "semua" || v == null ? null : Array.isArray(v) ? v.map(String) : null);
function isian(body: Rec, maks: number) {
  const label = String(body.label ?? "").trim().slice(0, 120);
  if (label.length < 3) throw new Error("Beri nama audit (paling sedikit 3 huruf).");
  const batas = Number(body.batas_usd);
  if (!Number.isFinite(batas) || batas <= 0 || batas > maks) throw new Error(`Batas biaya $0–$${maks}.`);
  const iot = body.iot === "sintetis" ? { sumber: "sintetis" as const, tampil: "sintetis" } : body.iot === "folder" ? { sumber: "folder" as const, tampil: String(body.iot_folder ?? "") } : null;
  const replika = typeof body.replika === "number" ? body.replika : null;
  return { label, tema: temaDari(body.tema), batas_usd: batas, iot, replika };
}

async function proyekApi(method: string, url: URL, init?: RequestInit): Promise<Response> {
  const q = url.searchParams;
  if (method === "GET") {
    if (q.get("iot") === "1") return asli!(url.toString(), init);
    if (q.get("langsung") === "1") {
      const a = cariAudit(cariProyek(q.get("proyek")), q.get("audit"));
      return a ? json(langsung(a)) : tolak("Audit tidak ditemukan.", 404);
    }
    if (q.get("tema") === "1") {
      const p = cariProyek(q.get("proyek"));
      if (!p) return asli!(url.toString(), init);  // a new project's theme focus: the server's list for that data
      const src = p.dataset === SUMBER_DATA ? `${API}?tema=1&proyek=${SUMBER_PROYEK}` : `${API}?tema=1&dataset=${encodeURIComponent(p.dataset)}${p.kc ? `&kc=${p.kc}` : ""}`;
      return json({ ...(await ambilAsli(src)), proyek: p.id });
    }
    const b = await dasar();
    majuSemua();
    return json({ ...b, proyek: await Promise.all([...S.proyek].reverse().map(tampilProyek)), admin: true, peluncur: { aktif: true } });
  }
  let body: Rec = {};
  try { body = JSON.parse(String(init?.body ?? "{}")); } catch { return tolak("Body tidak valid."); }
  const now = new Date().toISOString();
  const b = await dasar();
  const maks = Number((b.batas_usd as { maks?: number }).maks ?? 100);
  try {
    switch (body.aksi) {
      case "proyek_baru": {
        const nama = String(body.nama ?? "").trim().slice(0, 120);
        if (nama.length < 3) return tolak("Beri nama proyek (paling sedikit 3 huruf).");
        const p: ProyekRaw = { id: `p_${Date.now().toString(36)}_${hex(4)}`, nama, deskripsi: String(body.deskripsi ?? "").trim().slice(0, 600),
          kc: (body.kc as string) || null, dataset: String(body.dataset ?? SUMBER_DATA), tema_fokus: temaDari(body.tema_fokus), dibuat_pada: now, dibuat_oleh: S.oleh, audit: [] };
        S.proyek.push(p);
        emit();
        return json({ ok: true, proyek: await tampilProyek(p) });
      }
      case "audit_baru": case "ubah_audit": {
        const p = cariProyek(body.proyek);
        if (!p) return tolak("Proyek tidak ditemukan.", 404);
        const isi = isian(body, maks);
        if (body.aksi === "ubah_audit") {
          const a = cariAudit(p, body.audit);
          if (!a || a.status !== "siap") return tolak("Hanya audit yang belum pernah dijalankan yang bisa diubah.", 409);
          Object.assign(a, isi);
          return json({ ok: true, audit: tampilAudit(a) });
        }
        const d = new Date(Date.now() + 7 * 3600e3);
        const id = `cab_${String(d.getUTCFullYear()).slice(2)}${dua(d.getUTCMonth() + 1)}${dua(d.getUTCDate())}_${dua(d.getUTCHours())}${dua(d.getUTCMinutes())}_${hex(4)}`;
        const a: AuditRaw = { id, ...isi, status: "siap", dibuat_pada: now, dibuat_oleh: S.oleh };
        p.audit.push(a);
        emit();
        return json({ ok: true, audit: tampilAudit(a) });
      }
      case "mulai": {
        const a = cariAudit(cariProyek(body.proyek), body.audit);
        if (!a) return tolak("Audit tidak ditemukan.", 404);
        if (body.konfirmasi !== true) return tolak("Konfirmasi dulu ringkasan audit.", 409);
        if (semuaAudit().some((x) => x.status === "berjalan")) return tolak("Satu audit sedang berjalan.", 409);
        Object.assign(a, { status: "berjalan", dimulai_pada: now, jam: 0, dinding: Date.now() });
        S.paused = false;
        emit();
        return json({ ok: true, dijalankan: true, audit: tampilAudit(a) });
      }
      case "batal": {
        const a = cariAudit(cariProyek(body.proyek), body.audit);
        if (!a || a.status !== "berjalan") return tolak("Audit ini tidak sedang berjalan.", 409);
        maju(a);
        a.status = "dibatalkan";
        emit();
        return json({ ok: true, audit: tampilAudit(a) });
      }
      case "hapus_audit": {
        const p = cariProyek(body.proyek);
        if (p) p.audit = p.audit.filter((a) => a.id !== body.audit || a.status !== "siap");
        emit();
        return json({ ok: true });
      }
      case "hapus_proyek": {
        S.proyek = S.proyek.filter((p) => p.id !== body.proyek || p.audit.length);
        emit();
        return json({ ok: true });
      }
    }
  } catch (e) { return tolak((e as Error).message); }
  return tolak("Aksi tidak dikenal.");
}

/** the report's reads: the run list holds only the replayed run once an audit has finished, named and dated as that audit;
 *  the report's header fields follow; a verifier's mark lives in the page */
const terakhirSelesai = () => semuaAudit().filter((a) => a.status === "selesai").sort((x, y) => (y.selesai_ms ?? 0) - (x.selesai_ms ?? 0))[0] ?? null;
async function laporanApi(method: string, url: URL, init?: RequestInit): Promise<Response> {
  const q = url.searchParams;
  const a = terakhirSelesai();
  if (method === "POST") {
    let b: Rec = {};
    try { b = JSON.parse(String(init?.body ?? "{}")); } catch { return tolak("Body tidak valid."); }
    const kc = String(b.kc ?? ""), klaim = String(b.klaim ?? "");
    const m = (S.verif[kc] ??= {});
    if (!b.status) delete m[klaim]; else m[klaim] = { status: b.status, catatan: String(b.catatan ?? "").slice(0, 1000), oleh: S.oleh, pada: new Date().toISOString() };
    return json({ ok: true, verifikasi: m });
  }
  if (!q.has("run")) {
    const d = await ambilAsli(url.pathname + url.search);
    const r = S.runBaris ?? ((d.runs ?? []) as Rec[]).find((x) => x.id === SUMBER_RUN);
    return json({ ...d, runs: a && r ? [{ ...r, label: a.label, dijalankan: wibTeks(a.selesai_ms ?? Date.now(), false), dibuat: wibTeks(a.selesai_ms ?? Date.now(), false) }] : [] });
  }
  if (q.get("run") !== SUMBER_RUN || q.has("graf") || q.has("jejak") || q.has("biaya") || q.has("kasus")) return asli!(url.toString(), init);
  const d = await ambilAsli(url.pathname + url.search);
  const kapan = a ? wibTeks(a.selesai_ms ?? Date.now(), false) : undefined;
  const lbl = a?.label;
  if (q.has("kc")) {
    // the report of the branch: as this audit wrote it, no verifier marks yet
    return json({ ...d, ...(kapan ? { dibuat: kapan } : {}), ...(lbl && d.run ? { run: { ...(d.run as Rec), label: lbl } } : {}), verifikasi: S.verif[q.get("kc") ?? ""] ?? {} });
  }
  return json({ ...d, ...(lbl ? { label: lbl } : {}), ...(kapan ? { dibuat: kapan, dijalankan: kapan } : {}) });
}

function demoFetch(orig: typeof fetch): typeof fetch {
  return async (input, init) => {
    const req = input instanceof Request ? input : null;
    const method = String(init?.method ?? req?.method ?? "GET").toUpperCase();
    const url = new URL(req ? req.url : String(input), window.location.href);
    const sini = url.origin === window.location.origin;
    try {
      if (sini && url.pathname === API) return await proyekApi(method, url, init);
      if (sini && url.pathname === "/api/swarm-cabang") return await laporanApi(method, url, init);
    } catch (e) { return tolak(`Mode demo: ${(e as Error).message}`, 502); }
    // the safety net: no other change leaves the page while the demo is open (a box tag, a rule, a question to a model)
    if (method !== "GET" && method !== "HEAD" && (url.pathname.startsWith("/api/swarm-cabang") || url.pathname.startsWith("/api/aip/"))) {
      return tolak("Mode demo: tidak dikirim ke server.", 403);
    }
    return orig(input, init);
  };
}

/** Open the demo (the tab's mount): the calls answered here. Returns its close, which puts fetch back. */
export function installDemoCabang(o: { kecepatan?: number | null } = {}): () => void {
  if (asli) return () => {};
  if (o.kecepatan && DEMO_SPEEDS_CABANG.includes(o.kecepatan)) S.speed = o.kecepatan;
  asli = window.fetch;
  const orig = asli;
  window.fetch = demoFetch(orig);
  emit();
  dasar().then(() => { S.err = ""; emit(); }, () => {});
  return () => {
    if (window.fetch !== orig) window.fetch = orig;
    asli = null;
    emit();
  };
}

// ------------------------------------------------------------------------------------------------ the store the page reads

export type DemoCabangSnap = { speed: number; paused: boolean; err: string; selesai: number; berjalan: boolean };
let snap: DemoCabangSnap | null = null;
const listeners = new Set<() => void>();
function emit() {
  const audit = semuaAudit();
  snap = asli ? { speed: S.speed, paused: S.paused, err: S.err, selesai: audit.filter((a) => a.status === "selesai").length, berjalan: audit.some((a) => a.status === "berjalan") } : null;
  listeners.forEach((l) => l());
}
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
/** the demo's state while /swarm-x shows the branch tab; null elsewhere */
export function useDemoCabang(): DemoCabangSnap | null {
  return useSyncExternalStore(subscribe, () => snap, () => null);
}
/** how often the branch tab polls: in the demo often (nothing goes over the network) */
export const cabangPoll = (ms: number) => (asli ? Math.min(ms, 900) : ms);
/** the new audit form's start in the demo: the recorded scan's own settings (5 replicas, synthetic IoT, $15 cap) */
export const bawaanAuditDemo = (): { ukuran: number; iot: "sintetis"; batas: number } | null => (asli ? { ukuran: REK.replika.length, iot: "sintetis", batas: 15 } : null);

export const demoCabang = {
  /** who makes the demo's projects and audits: the signed-in viewer */
  setOleh: (nama: string) => { S.oleh = nama; },
  setSpeed: (s: number) => { majuSemua(); S.speed = s; emit(); },
  togglePause: () => { majuSemua(); S.paused = !S.paused; emit(); },
  /** a new take: no project, no audit, no report */
  reset: () => { S.proyek = []; S.verif = {}; S.paused = false; emit(); },
  /** the running audit (else the last one): its audit time and how far it is */
  now: (): { label: string; status: string; detik: number; pct: number; tahap: string | null } | null => {
    majuSemua();
    const a = semuaAudit().find((x) => x.status === "berjalan") ?? semuaAudit().filter((x) => x.jam !== undefined).slice(-1)[0];
    if (!a) return null;
    const jam = a.status === "selesai" ? TOTAL : a.jam ?? 0;
    return { label: a.label, status: a.status, detik: jam, pct: jam / TOTAL, tahap: posisi(jam).tahap };
  },
};
