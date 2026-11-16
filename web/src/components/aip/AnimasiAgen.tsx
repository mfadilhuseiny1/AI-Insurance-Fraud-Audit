"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { aip, modelName, usd, wib, type AipEvent, type Rec, type Run } from "@/components/aip/aipRun";
import { useTampilBiaya } from "@/components/aip/biaya";
import { fraud, rp, GROUP_COLOR, REVIEWED, STRENGTH, type FirmAgent } from "@/components/aip/fraudApi";
import { LINI } from "@/components/aip/KonsultanView";
import { demoLive, demoPoll, demoSwarm, useDemoSwarm } from "@/components/aip/demoSwarm";

/* Animasi sistem multi-agen: an engagement of the Konsultan Fraud replayed from its own event log (the real run, not a
   simulation). Each agent lights up in the colour of its line while it works; every interaction travels as a packet —
   a read to the data, a tag to the ledger, a handoff to its lead, a case to an investigator, a verdict to the
   orchestrator — and is written to the interaction log; the flow underneath fills as the engagement goes: indications →
   ML tagging → the quarantine box → the decision dashboard. Play, pause, speed and seek; click an agent, a stage or a
   line of the log. An engagement still running is followed live. */

const W = 1200, H = 612;
const HUB = { x: 600, y: 372, w: 560, h: 34 };
const CARD = { y: 432, w: 262, h: 166 };
// Blu 1.1's clinical review (adk_runtime/telaah.py): a machine between the data and the agents, working before the plan
// the review works on the Nexus itself (not a gate between the data and the agents): its chip sits under the Nexus bar
const TELAAH = { x: HUB.x, y: HUB.y + HUB.h / 2 + 18 };
const TELAAH_COLOR = "#c084fc";
const CARDS = [
  { key: "indikasi", label: "Indikasi", x: 30, hint: "aturan otomatis + tag agen dengan bukti" },
  { key: "ml", label: "Tagging berbasis ML", x: 326, hint: "konsensus teknik ML (supervised)" },
  { key: "box", label: "Box karantina", x: 622, hint: "faskes dikelompokkan menurut estimasi kerugian" },
  { key: "keputusan", label: "Dashboard keputusan", x: 918, hint: "rekomendasi jalur → keputusan manusia" },
] as const;
type CardKey = (typeof CARDS)[number]["key"];
// Blu 1.3's Decision examination first: it works before the domain leads (api/aip/telaah.py LEAD_13)
const LEAD_13 = "telaah_keputusan";
const LEAD_ORDER = [LEAD_13, "faskes_wilayah", "klinis", "klaim_fraud", "peserta", "machine_learning", "validator"];
const PHASES: [string, string, string][] = [
  ["telaah", "Clinical examination", "Blu 1.1: sebelum agen bekerja, setiap klaim berisiko ditelaah model saring; yang bukan wajar dan 5% sampel acak diperiksa ulang keluarga model lain. Tag lemah hanya bila keduanya melihat masalah."],
  ["penugasan", "Penugasan", "Orkestrator membaca lanskap data, lalu menulis rencana dan kontrak validasi sebelum agen mana pun bekerja."],
  ["lapangan", "Lapangan", "Analis per provinsi dan spesialis modus membaca data sendiri dan menandai setiap indikasi dengan bukti; sub-agen teknik ML menghitung konsensus."],
  ["karantina", "Box karantina", "Tag aturan, tag agen dan konsensus ML masuk ke box karantina: faskes dikelompokkan A–Z menurut estimasi kerugian."],
  ["investigasi", "Investigasi", "Peran penyidik membentuk satu instans per faskes di antrean box (A→Z); tiap instans menguji Terstruktur–Sistematis–Masif lalu merekomendasikan jalur."],
  ["sintesis", "Sintesis", "Agen domain menyatukan temuan agen kecilnya menjadi satu sintesis per lini, dengan rujukan hasil."],
  ["qa", "QA & red team", "Reviewer QA dari keluarga model lain memeriksa tiap sintesis; instans red team mencoba mematahkan tag terkuat."],
  ["laporan", "Laporan & keputusan", "Orkestrator menyusun kerangka bersumber (kode membuang poin tanpa sumber), tiap bagian ditulis dari sumbernya dan digabung kode; validator menilai angka dan kontrak; jalur diputuskan manusia."],
];
// Blu 1.3's first phase in place of Blu 1.1's
const PHASE_13: [string, string, string] = ["telaah", "Decision examination",
  "Blu 1.3: sebelum agen bekerja, OpenAI Decisions menilai setiap klaim berisiko di Nexus dengan peluang wajar / perlu diperiksa / mencurigakan. Tanpa tag: agen memeriksa klaim dengan skor tertinggi dan menandai dengan buktinya sendiri."];
// Blu 3.0 (api/aip/blu3.py): the v3 scoring machine first, in place of the clinical examination; no ML technique agents
const PHASES_30: Record<string, [string, string, string]> = {
  telaah: ["skoring_v3", "Scoring ML v3", "Blu 3.0: setiap klaim di Nexus sudah dinilai arsitektur v3 (graph + 4 spesialis keluarga Permenkes + rule route + network rule); ringkasannya menjadi hasil yang dirujuk rencana dan setiap agen."],
  lapangan: ["lapangan", "Lapangan", "Analis per provinsi dan agen kelompok modus membaca data sendiri, mulai dari work list skor v3, dan menandai setiap indikasi dengan bukti."],
  karantina: ["karantina", "Box karantina", "Tag aturan dan tag agen masuk ke box karantina: faskes dikelompokkan A–Z menurut estimasi kerugian."],
};
const V3_COLOR = "#2dd4bf";
const idn = (v: unknown) => Number(v ?? 0).toLocaleString("id-ID");
const PHASE_COLOR = [TELAAH_COLOR, "#9d8cff", "#3987e5", "#c98500", "#d55181", "#199e70", "#8f99a8", "#e5e8eb"];
const SPEEDS = [1, 5, 15, 40, 100];
const KINDS: [string, string][] = [["semua", "Semua"], ["tool", "Baca data"], ["tag", "Tag"], ["serah", "Serah-terima"], ["validasi", "Validasi"],
  ["keputusan", "Keputusan"], ["mesin", "Mesin"], ["galat", "Galat"]];
const JALUR: Record<string, string> = { ditindak: "#e5484d", dibina: "#fab219", dibebaskan: "#29a383" };
// an engagement picked up again after an API restart: its mark on the timeline and its line in the log
const RESUME = "#fbbf24";
const STATE_LABEL: Record<string, string> = { antre: "antre", bekerja: "bekerja", selesai: "selesai", gagal: "gagal" };

type XY = { x: number; y: number };
type Pos = XY & { r: number };
type Line = { i: number; at: number; rt: number; kind: string; key: string; who: string; color: string; text: string };  // at: replay ms; rt: real s from the start
type Packet = { a: XY; b: XY; color: string; r: number; t0: number; dur: number };
/** what one frame draws: the replay's clock and place in the log, the state there, the packets in flight */
type Snap = { clock: number; cursor: number; now: number; L: Live; packets: Packet[] };
type Live = {
  st: Record<string, string>; calls: Record<string, number>; tags: Record<string, number>; formed: Set<string>; flash: Record<string, number>;
  phase: string; phases: Record<string, string>; tagN: number; strength: Record<string, number>; modes: Record<string, number>; auto: number;
  ml: Rec | null; box: Rec | null; recs: Record<string, number>; reds: Record<string, number>; scrut: [number, number]; qa: [number, number];
  final: Rec | null; report: boolean; errors: number; lessons: number; log: Line[]; review: Review | null;
  /** rows the tools returned to each agent and in all (cumulative: a re-read counts again); objects the measures aggregated; Blu 3.0's scoring */
  rows: Record<string, number>; rowsN: number; objek: number; v3: Rec | null;
};
/** Blu 1.1's review as its events tell it: each stage's progress, the screen's verdicts, the calibration, how it ended */
type Review = { versi: string; klaim: number; saring: string; periksa: string; tahap: string; prog: Record<string, [number, number]>; kesimpulan: Record<string, number>;
  tag: number; status: "berjalan" | "selesai" | "berhenti"; kappa: number | null; lolos: boolean | null; alasan: string };
const fresh = (): Live => ({
  st: {}, calls: {}, tags: {}, formed: new Set(), flash: {}, phase: "", phases: {}, tagN: 0, strength: { lemah: 0, sedang: 0, kuat: 0 }, modes: {}, auto: 0,
  ml: null, box: null, recs: {}, reds: {}, scrut: [0, 0], qa: [0, 0], final: null, report: false, errors: 0, lessons: 0, log: [], review: null,
  rows: {}, rowsN: 0, objek: 0, v3: null,
});
const freshReview = (): Review => ({ versi: "1.1", klaim: 0, saring: "", periksa: "", tahap: "", prog: {}, kesimpulan: {}, tag: 0, status: "berjalan", kappa: null, lolos: null, alasan: "" });

/** Event times on a replay clock: events of one second spread across it; with `skip`, a quiet gap (models thinking)
    counts at most 2.5 s, so the replay keeps moving. */
function timeline(events: AipEvent[], skip: boolean): { at: number[]; real: number[]; total: number } {
  const secs = events.map((e) => Date.parse(String(e.t ?? "")));
  for (let i = 0; i < secs.length; i++) if (!Number.isFinite(secs[i])) secs[i] = i ? secs[i - 1] : 0;
  const real: number[] = new Array(events.length);
  for (let i = 0; i < events.length;) {
    let j = i;
    while (j < events.length && secs[j] === secs[i]) j++;
    for (let k = i; k < j; k++) real[k] = secs[i] + ((k - i + 0.5) / (j - i)) * 1000;
    i = j;
  }
  const at: number[] = new Array(events.length);
  let t = 0;
  for (let k = 0; k < events.length; k++) {
    // a time earlier than the one before (a copied trail, writers out of step) does not take the clock back
    const gap = k ? Math.max(0, real[k] - real[k - 1]) : 0;
    t += skip ? Math.min(gap, 2500) : gap;
    at[k] = t;
  }
  return { at, real, total: (at.at(-1) ?? 0) + 1200 };
}

const short = (a: FirmAgent | undefined, key: string) => (a?.name ?? key).replace("Orkestrator · Partner", "Orkestrator").replace(/^Agen /, "")
  .replace(/^Analis Wilayah · /, "Analis ").replace(/^Sub-agen /, "ML · ").replace(/^Reviewer QA · /, "QA ").replace(/^Spesialis /, "Spesialis ");
/** "FKRTL · Rumah sakit · RS Kelas B · Pemerintah kab/kota · SRAGEN" → "RS Kelas B · SRAGEN" */
const place = (s: unknown) => {
  const p = String(s ?? "").split(" · ");
  return p[0] === "FKRTL" && p.length >= 4 ? `${p[2]} · ${p.at(-1)}` : String(s ?? "").slice(0, 60);
};
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** What an event changes in the engagement's state, and the line it writes to the interaction log. */
function apply(L: Live, e: AipEvent, i: number, at: number, rt: number, who: (k: string) => FirmAgent | undefined): void {
  const name = (k: string) => (k === "scrutiny" ? "Scrutiny (kode)" : k === "telaah_klinis" ? "Clinical examination" : short(who(k), k));
  const color = (k: string) => (k === "scrutiny" ? "#b8a9ff" : k === "telaah_klinis" ? TELAAH_COLOR : LINI[who(k)?.lini ?? ""]?.color ?? "#8f99a8");
  const log = (kind: string, k: string, text: string, c?: string) => L.log.push({ i, at, rt, kind, key: k, who: k ? name(k) : "", color: c ?? (k ? color(k) : "#8f99a8"), text });
  switch (e.type) {
    case "telaah": {
      const R = (L.review ??= freshReview());
      const t = String(e.tahap ?? ""), num = (v: unknown) => Number(v ?? 0).toLocaleString("id-ID");
      if (t === "mulai") {
        R.versi = String(e.versi ?? "1.1");
        R.klaim = Number(e.klaim ?? 0);
        R.saring = modelName(String((e.model as Rec)?.saring ?? ""));
        R.periksa = modelName(String((e.model as Rec)?.periksa ?? ""));
        L.st[LEAD_13] = "bekerja";  // Blu 1.3's lead in the tree (absent in Blu 1.1: nothing drawn)
        log("mesin", "telaah_klinis", R.versi === "1.3"
          ? `dimulai: ${num(e.klaim)} klaim berisiko · OpenAI Decisions menilai setiap klaim (peluang per kesimpulan) · tanpa periksa ulang, tanpa tag`
          : `dimulai: ${num(e.klaim)} klaim berisiko · saring ${R.saring} → periksa ulang ${R.periksa}`);
      } else if (t === "kalibrasi") {
        R.kappa = e.kappa ?? null;
        R.lolos = !!e.lolos;
        const ref = R.versi === "1.3" ? ` dengan putusan ${R.periksa} yang tersimpan` : "";
        log("mesin", "telaah_klinis", `kalibrasi ${num(e.n)} klaim: kappa berbobot ${e.kappa ?? "-"}${ref} — ${e.lolos ? "lolos, telaah penuh berjalan" : `tidak lolos: ${((e.alasan ?? []) as string[]).join("; ")}`}`);
      } else if (t === "saring" || t === "periksa") {
        // one line when a stage starts, no running counts (the user, 2026-10-30: the flow is drawn, not written)
        const sel = Number(e.selesai ?? 0), tot = Number(e.total ?? 0), prev = R.prog[t];
        const what = t === "periksa" ? `memeriksa ulang yang bukan wajar (${R.periksa})`
          : R.versi === "1.3" ? `menilai klaim berisiko dari Nexus (${R.saring})` : `menyaring klaim berisiko dari Nexus (${R.saring})`;
        if (!prev || prev[1] !== tot) log("mesin", "telaah_klinis", tot <= 300 ? `kalibrasi: ${what}` : `mulai ${what}`);
        R.prog[t] = [sel, tot];
        R.tahap = t;
        if (t === "saring") R.kesimpulan = (e.kesimpulan ?? {}) as Record<string, number>;
      } else if (t === "berhenti") {
        R.status = "berhenti";
        R.alasan = String(e.alasan ?? "");
        L.st[LEAD_13] = "gagal";
        log("mesin", "telaah_klinis", `berhenti: ${R.alasan} — putusan tersimpan; penugasan berlanjut seperti Blu 1.0`, "#fbd38d");
      } else if (t === "selesai") {
        R.status = e.status === "selesai" ? "selesai" : "berhenti";
        L.st[LEAD_13] = R.status === "selesai" ? "selesai" : "gagal";
        R.tag = Number(e.tag ?? 0);
        if (e.kesimpulan_saring) R.kesimpulan = e.kesimpulan_saring as Record<string, number>;
      }
      break;
    }
    case "agent_status":
      L.st[e.agent] = e.status;
      if (e.status === "gagal") log("galat", e.agent, "giliran gagal");
      break;
    case "tool": {
      L.calls[e.agent] = (L.calls[e.agent] ?? 0) + 1;
      const r = Number(e.rows ?? 0) || 0;
      L.rows[e.agent] = (L.rows[e.agent] ?? 0) + r;
      L.rowsN += r;
      // the objects a measure aggregated (ukur): `objek` since 2026-11-12, before that only in its summary when it had no dimension
      L.objek += Number(e.objek ?? /dihitung atas (\d+) objek/.exec(String(e.summary ?? ""))?.[1] ?? 0) || 0;
      log(e.ok === false ? "galat" : "tool", e.agent, `${e.tool} → ${String(e.summary ?? "").slice(0, 140)}${e.rid ? ` [${e.rid}]` : ""}${r ? ` · ${idn(r)} baris` : ""}`);
      break;
    }
    case "progress":
      log("tool", e.agent, String(e.text ?? "").replace(/^\[\s*\d+s\]\s*/, "").slice(0, 140));
      break;
    case "tag": {
      const n = Number(e.jumlah ?? 1), k = String(e.kekuatan ?? e.kekuatan_agen ?? "lemah");
      L.tags[e.agent] = (L.tags[e.agent] ?? 0) + n;
      L.tagN += n;
      L.strength[k] = (L.strength[k] ?? 0) + n;
      L.modes[e.tag] = (L.modes[e.tag] ?? 0) + n;
      log("tag", e.agent, `menandai ${place(e.judul)} · ${e.tag} (${k})`);
      break;
    }
    case "handoff": {
      const h = (e.handoff ?? {}) as Rec, lead = who(e.agent)?.induk;
      const q = (h.queries_run ?? []).length, issues = (h.issues_found ?? []).length;
      log("serah", e.agent, `serah-terima${lead ? ` ke ${name(lead)}` : ""}: ${q} kueri${issues ? `, ${issues} temuan` : ""}${(h.left_undone ?? []).length ? ", ada yang belum selesai" : ""}`);
      break;
    }
    case "assign": {
      const lead = who(e.agent)?.induk ?? "";
      log("serah", lead, `→ ${name(e.agent)}: audit ${place(e.target?.nama)} (kelompok ${e.target?.kelompok ?? "-"})`);
      break;
    }
    case "instances":
      for (const a of (e.agents ?? []) as FirmAgent[]) L.formed.add(a.key);
      log("serah", e.parent ?? "", `peran ${e.role === "red_team" ? "red team" : "penyidik"} membentuk ${(e.agents ?? []).length} instans dari antrean ${e.antrean ?? "-"}`);
      break;
    case "rekomendasi":
      L.recs[e.jalur] = (L.recs[e.jalur] ?? 0) + 1;
      log("keputusan", e.agent, `${place(e.nama)} [${e.kelompok}] → ${String(e.jalur).toUpperCase()} · T ${e.tsm?.terstruktur ?? "-"}, S ${e.tsm?.sistematis ?? "-"}, M ${e.tsm?.masif ?? "-"}`);
      break;
    case "red_team":
      L.reds[e.hasil] = (L.reds[e.hasil] ?? 0) + 1;
      log("validasi", e.agent, `menguji ${e.tag} di ${place(e.judul)}: ${e.hasil} → ${e.kekuatan}`);
      break;
    case "verdict":
      if (e.validator === "scrutiny") {
        L.scrut = [L.scrut[0] + Number(e.passed ?? 0), L.scrut[1] + Number(e.total ?? 0)];
        log("validasi", "scrutiny", `milestone ${e.milestone}: ${e.passed}/${e.total} cek lolos`);
      } else if (e.lini) {
        L.qa = [L.qa[0] + Number(e.passed ?? 0), L.qa[1] + Number(e.total ?? 0)];
        log("validasi", e.validator, `sintesis ${e.sintesis ?? e.lini}: ${e.passed}/${e.total} klaim bertahan`);
      } else {
        L.final = e;
        const k = (e.kontrak ?? []) as Rec[];
        const rated = k.filter((c) => typeof c.ok === "boolean").length;  // unjudged (null) is not failed
        log("validasi", e.validator ?? "validator", `laporan akhir: ${e.passed}/${e.total} cek; kontrak ` +
          (rated ? `${k.filter((c) => c.ok === true).length}/${rated} terpenuhi` : "belum dinilai"));
      }
      break;
    case "machine":
      if (e.status === "selesai") {
        if (e.key === "penanda_otomatis") {
          L.auto = Object.values((e.hasil?.aturan ?? {}) as Record<string, number>).reduce((n, v) => n + Number(v || 0), 0);
          log("mesin", "", `penanda otomatis: ${L.auto.toLocaleString("id-ID")} tag dari ${Object.keys(e.hasil?.aturan ?? {}).length} aturan lapisan semantik`, "#738091");
        } else if (e.key === "skoring_v3") {
          const h = (e.hasil ?? {}) as Rec;
          L.v3 = h;
          log("mesin", "", `scoring ML v3: ${idn(h.klaim)} klaim dinilai · ${idn(h.ditandai)} ditandai v3 · ${idn(h.berisiko)} klaim berisiko · ${idn(h.faskes)} faskes`, V3_COLOR);
        } else if (e.key === "konsensus_ml") {
          L.ml = e.hasil ?? {};
          log("mesin", "", `konsensus ML: ${L.ml?.teknik ?? "-"} teknik sepakat pada ${L.ml?.faskes ?? "-"} faskes`, LINI.ml.color);
        } else if (e.key === "karantina") {
          L.box = e.hasil ?? {};
          const g = (L.box?.kelompok ?? {}) as Record<string, Rec>;
          log("mesin", "", `box karantina: ${L.box?.faskes ?? "-"} faskes · ${Object.entries(g).map(([k, v]) => `${k} ${v.faskes}`).join(" · ")}`, LINI.kasus.color);
        } else if (e.key === "sinkron_nexus") {
          log("mesin", "", `buku besar disinkronkan ke Nexus: ${Number(e.hasil?.tag ?? 0).toLocaleString("id-ID")} tag`, "#738091");
        } else if (e.key === "telaah_klinis") {
          // Blu 1.1: the clinical review of every screened claim, before the plan (adk_runtime/telaah.py)
          const h = (e.hasil ?? {}) as Rec;
          log("mesin", "", h.status === "selesai"
            ? `clinical examination: ${Number(h.ditelaah ?? 0).toLocaleString("id-ID")} klaim ditelaah, ${Number(h.tag ?? 0).toLocaleString("id-ID")} ditandai (lemah)`
            : `clinical examination ${String(h.status ?? "berhenti")}: ${((h.alasan ?? []) as string[]).join("; ") || "-"} — berlanjut seperti Blu 1.0`, "#9d8cff");
        }
      }
      break;
    case "phase": {
      // a phase announced again after a resume is the same phase going on, not a new one
      const again = e.status === "mulai" && L.phases[e.phase] === "mulai";
      L.phases[e.phase] = e.status;
      if (e.status === "mulai") {
        L.phase = e.phase;
        log("fase", "", `Fase ${(e.phase === "skoring_v3" ? "Scoring ML v3" : PHASES.find((p) => p[0] === e.phase)?.[1]) ?? e.phase} ${again ? "dilanjutkan" : "dimulai"}`, "#e5e8eb");
      }
      break;
    }
    case "lanjut":
      // the API restarted mid-engagement: the engagement picked up from its own trail (runs.py resume)
      log("mesin", "", `penugasan dilanjutkan setelah API dimulai ulang: ${Number(e.agen_selesai ?? 0)} agen yang selesai tidak diulang, ${Number(e.agen_dilanjutkan ?? 0)} melanjutkan dari langkahnya`, RESUME);
      break;
    case "kontrak":
      log("validasi", "partner", `kontrak validasi: ${(e.kontrak ?? []).length} pernyataan, ditulis sebelum agen bekerja`);
      break;
    case "engagement_plan":
      log("fase", "partner", `rencana: ${String(e.plan?.ringkasan ?? "").slice(0, 180)}`);
      break;
    case "error":
      L.errors++;
      log("galat", e.agent ?? "", String(e.message ?? "").slice(0, 160), "#e5484d");
      break;
    case "pelajaran":
      L.lessons++;
      log("validasi", "", `pelajaran baru untuk skill ${e.skill} (${e.status})`, "#9d8cff");
      break;
    case "salinan":  // a report rewrite: what follows up to the report phase is the source engagement's trail, copied
      log("fase", "", `fase 0–5 disalin dari penugasan ${e.sumber} (tidak dijalankan ulang); hanya laporan yang ditulis baru`, "#e5e8eb");
      break;
    case "kerangka": {
      const parts = (e.bagian ?? []) as { poin?: unknown[] }[];
      const dropped = ((e.dibuang ?? []) as unknown[]).length;
      log("serah", "partner", `kerangka laporan: ${parts.length} bagian, ${parts.reduce((n, s) => n + (s.poin ?? []).length, 0)} poin bersumber` +
        (dropped ? `, ${dropped} poin dibuang kode` : ""));
      break;
    }
    case "bagian":
      if (e.status === "menulis") log("tool", "partner", `menulis bagian "${e.judul}" dari sumber poinnya${e.revisi ? " (revisi)" : ""}`);
      else log(e.status === "gagal" ? "galat" : "serah", "partner", `bagian "${e.judul}" ${e.status === "gagal" ? "gagal ditulis" : "selesai"}${e.revisi ? " (revisi)" : ""}`);
      break;
    case "engagement":
      L.report = true;
      log("keputusan", "partner", "laporan akhir diserahkan; keputusan jalur menunggu manusia");
      break;
    case "done":
      log("fase", "", "Penugasan selesai", "#e5e8eb");
      break;
  }
}

/** Where an event's interaction travels: from the agent (or stage) to the data, the ledger, its lead, a stage. */
function packetsOf(e: AipEvent, pos: Record<string, Pos>, who: (k: string) => FirmAgent | undefined): Omit<Packet, "t0">[] {
  const at = (k: string | null | undefined): XY | null => (k && pos[k] ? pos[k] : null);
  const hub = (x: number): XY => ({ x: Math.max(HUB.x - HUB.w / 2 + 12, Math.min(HUB.x + HUB.w / 2 - 12, x)), y: HUB.y - HUB.h / 2 });
  const card = (k: CardKey, dx = 0): XY => { const c = CARDS.find((x) => x.key === k)!; return { x: c.x + CARD.w / 2 + dx, y: CARD.y }; };
  const col = (k: string) => LINI[who(k)?.lini ?? ""]?.color ?? "#8f99a8";
  const out: Omit<Packet, "t0">[] = [];
  const go = (a: XY | null, b: XY | null, color: string, r = 2.4, dur = 800) => { if (a && b) out.push({ a, b, color, r, dur }); };
  const burst = (a: XY | null, b: (i: number) => XY, color: string, n: number, dur = 1300) => { for (let i = 0; i < n; i++) go(a, b(i), color, 3, dur + i * 90); };
  switch (e.type) {
    case "tool": { const p = at(e.agent); if (p) go(p, hub(p.x), col(e.agent), 2, 650); break; }
    case "telaah": {
      // sparks along the Nexus bar while the claims are read; the calibration up to the orchestrator; the tags to the indications
      const top: XY = { x: HUB.x, y: HUB.y - HUB.h / 2 }, chip: XY = { x: TELAAH.x, y: TELAAH.y };
      const along = () => ({ x: HUB.x - HUB.w / 2 + 30 + Math.random() * (HUB.w - 60), y: HUB.y });
      if (e.tahap === "saring" || e.tahap === "periksa")
        for (let i = 0; i < 3; i++) go(along(), along(), e.tahap === "saring" ? TELAAH_COLOR : "#9d8cff", 2.2, 900 + i * 150);
      if (e.tahap === "kalibrasi") go(top, at("partner"), TELAAH_COLOR, 3.2, 1200);
      if (e.tahap === "selesai") { burst(chip, (i) => card("indikasi", (i - 3) * 22), TELAAH_COLOR, 7); go(top, at("partner"), TELAAH_COLOR, 3.2, 1300); }
      break;
    }
    case "tag": go(at(e.agent), card("indikasi", (Math.random() - 0.5) * 120), STRENGTH[String(e.kekuatan ?? e.kekuatan_agen)] ?? "#8f99a8", 3, 1200); break;
    case "handoff": go(at(e.agent), at(who(e.agent)?.induk ?? "partner"), "#e5e8eb", 2.6, 900); break;
    case "assign": go(at(who(e.agent)?.induk), at(e.agent), LINI.kasus.color, 2.8, 900); break;
    case "instances": for (const a of (e.agents ?? []) as FirmAgent[]) go(at(e.role), at(a.key), col(a.key), 2.6, 1000); break;
    case "rekomendasi": go(at(e.agent), card("keputusan", (Math.random() - 0.5) * 100), JALUR[e.jalur] ?? "#e5e8eb", 3.6, 1400); break;
    case "red_team": go(at(e.agent), card("indikasi", 60), e.hasil === "bertahan" ? "#ffb4b4" : "#7ee2c0", 3.2, 1300); break;
    case "verdict":
      if (e.validator === "scrutiny") go(at("scrutiny"), at("partner"), "#b8a9ff", 3, 900);
      else if (e.lini) go(at(e.validator), at(e.lini), e.passed === e.total ? "#29a383" : "#fab219", 3, 1000);
      else go(at("validator"), at("partner"), e.passed === e.total ? "#29a383" : "#fab219", 3.4, 1100);
      break;
    case "machine":
      if (e.status !== "selesai") break;
      if (e.key === "penanda_otomatis") burst({ x: HUB.x - 200, y: HUB.y + HUB.h / 2 }, (i) => card("indikasi", (i - 3) * 22), "#738091", 7);
      if (e.key === "konsensus_ml") burst(at("machine_learning"), (i) => card("ml", (i - 3) * 22), LINI.ml.color, 7);
      if (e.key === "skoring_v3") burst({ x: HUB.x - 60, y: HUB.y + HUB.h / 2 }, (i) => card("ml", (i - 3) * 22), V3_COLOR, 7);
      if (e.key === "karantina") {
        burst(card("indikasi", 100), (i) => card("box", (i - 3) * 22), LINI.kasus.color, 6);
        burst(card("ml", 100), (i) => card("box", (i - 3) * 22), LINI.ml.color, 6);
      }
      if (e.key === "sinkron_nexus") burst(card("keputusan"), () => ({ x: HUB.x + 220, y: HUB.y + HUB.h / 2 }), "#738091", 5);
      break;
    case "kontrak": case "engagement_plan":
      for (const k of LEAD_ORDER) go(at("partner"), at(k), LINI.pimpinan.color, 3, 1000);
      break;
    // the outline is built from the leads' syntheses; a finished section goes to the report
    case "kerangka": for (const k of LEAD_ORDER) if (k !== "validator") go(at(k), at("partner"), LINI.pimpinan.color, 2.6, 900); break;
    case "bagian": if (e.status === "selesai") go(at("partner"), card("keputusan", (Math.random() - 0.5) * 90), LINI.pimpinan.color, 2.6, 1100); break;
    case "engagement": burst(at("partner"), (i) => card("keputusan", (i - 2) * 25), LINI.pimpinan.color, 5, 1500); break;
  }
  return out;
}

/** The firm drawn as a stage: the orchestrator on top, a column per lead, its small agents beneath; roles' instances
    take their places as they are formed. */
function layoutOf(roster: FirmAgent[]): Record<string, Pos> {
  const pos: Record<string, Pos> = {};
  const partner = roster.find((a) => a.jenjang === "partner");
  if (partner) pos[partner.key] = { x: W / 2, y: 52, r: 21 };
  pos.scrutiny = { x: W / 2 + 150, y: 52, r: 10 };
  pos.telaah_klinis = { x: TELAAH.x, y: TELAAH.y, r: 6 };  // (Blu 1.1: its tags flow from the Nexus to the indications)
  const rank = (k: string) => (LEAD_ORDER.includes(k) ? LEAD_ORDER.indexOf(k) : 99);
  const leads = roster.filter((a) => a.jenjang === "manajer").sort((a, b) => rank(a.key) - rank(b.key));
  const colW = W / Math.max(leads.length, 1);
  const order = (a: FirmAgent) => (a.instans_dari ? 2 : a.jenjang === "peran" ? 1 : 0);
  leads.forEach((lead, i) => {
    const cx = colW * i + colW / 2;
    pos[lead.key] = { x: cx, y: 140, r: 14 };
    const kids = roster.filter((a) => a.induk === lead.key && a.jenjang !== "manajer").sort((a, b) => order(a) - order(b) || a.key.localeCompare(b.key));
    const COLS = 7, G = 21, cols = Math.min(COLS, kids.length);
    kids.forEach((a, j) => { pos[a.key] = { x: cx + ((j % COLS) - (cols - 1) / 2) * G, y: 196 + Math.floor(j / COLS) * G, r: a.jenjang === "peran" ? 8 : 6.5 }; });
  });
  return pos;
}

/** What an agent does in the network, in one line for an audience (the user, 2026-10-24: "when I hover an agent it shows
 *  what agent + a short description of its function, so I can show the agent network to an audience"); its own
 *  assignment (a.peran: the province, the mode, the facility) follows it on the card */
function fungsi(a: FirmAgent): string {
  const role = `${a.instans_dari ?? a.peran_kode} ${a.key}`;
  if (a.jenjang === "partner") return "Orkestrator penugasan: menyusun hipotesis dan kontrak validasi, membagi fokus tiap lini, menulis laporan akhir untuk klien.";
  if (a.key === "validator" || (a.jenjang === "manajer" && a.lini === "qa")) return "Validator: memimpin QA dan red team, memeriksa setiap sintesis dan laporan akhir ke data, dengan keluarga model lain.";
  if (a.key === LEAD_13) return "Decision examination (Blu 1.3): memimpin pemeriksa keputusan — sebelum agen bekerja, OpenAI Decisions menilai setiap klaim berisiko di Nexus; tanpa tag, agen memeriksa klaim teratas dengan buktinya sendiri.";
  if (a.peran_kode === "pemeriksa_keputusan") return "Pemeriksa keputusan: mengambil sepuluh klaim dari antrean bersama dan menilai tiap klaim dengan OpenAI Decisions — peluang wajar / perlu diperiksa / mencurigakan dan tag usulan, tanpa teks.";
  if (a.key === "redaksi") return "Redaksi laporan (kode): menjalankan editor dan analis exhibit, menolak suntingan yang mengubah angka, dan membekukan exhibit serta berkas kasus saat penugasan selesai.";
  if (a.jenjang === "manajer") return "Agen domain: pemilik objek Nexus-nya; memimpin agen kecilnya dan menyintesis temuan mereka untuk orkestrator.";
  if (a.key === "editor_laporan") return "Editor laporan: menyunting bahasa tiap bagian laporan; kode menolak suntingan yang mengubah angka, rujukan atau kode tag.";
  if (a.key === "analis_exhibit") return "Analis exhibit: menulis makna dan implikasi tiap exhibit laporan lengkap; kalimat yang angkanya tidak ada di fakta exhibit dibuang kode.";
  if (/penyidik/.test(role)) return "Penyidik: mengaudit satu faskes dari Box Karantina: kertas kerja audit, bacaan TSM dan rekomendasi jalur (dibina / ditindak).";
  if (/red_team/.test(role)) return "Red team: menguji indikasi terkuat dengan penjelasan wajarnya, lalu memutus apakah indikasi bertahan atau melemah.";
  if (a.lini === "qa") return "Reviewer QA: memeriksa ulang sintesis satu lini terhadap data dengan bacaannya sendiri.";
  if (a.lini === "wilayah") return "Analis wilayah: menelusuri indikasi fraud di satu provinsi lintas modus dan menandai temuannya dengan bukti.";
  if (a.lini === "peer") return "Analis peer: membandingkan faskes dengan faskes sekelasnya pada beberapa ukuran sekaligus.";
  if (a.key.startsWith("famili_")) return "Agen kelompok modus (Blu 3.0): membuktikan dan menandai satu kelompok modus Permenkes 16/2019 secara nasional, mulai dari work list skor spesialis v3.";
  if (a.lini === "modus") return "Spesialis modus (Permenkes 16/2019): mencari sinyal satu modus fraud di seluruh data dan menandai faskes atau klaimnya.";
  if (a.lini === "ml") return "Sub-agen teknik ML: menguji satu teknik pada lipatan yang sama; daftar teratasnya masuk konsensus model.";
  return a.peran;
}
const LEVEL: Record<string, string> = { partner: "orkestrator", manajer: "agen domain", analis: "agen kecil", validator: "validator", peran: "peran (instans per kasus)" };

/** embedded: the firm chart of the AI Agent Swarm tab — the engagement the tab selected (no selector of its own), at rest
 *  on its end state as a chart until played (a running one live), sized by its own width: the log beside the network
 *  when the box is wide, under it when narrow. playKey: a new value replays from the start (the tab's "Putar Sistem AI Swarm").
 *  onAgent: the agent clicked (the tab opens its report). */
export function AnimasiAgen({ full = false, initialRun, embedded = false, playKey = 0, simKey = 0, proyek = null, simulasi = false, onAgent }: { full?: boolean;
  initialRun?: string | null; embedded?: boolean; playKey?: number; onAgent?: (key: string | null) => void;
  /** a new value plays the Blu 1.1 simulation of `proyek` (the tab's "Simulasi Blu 1.1") */
  simKey?: number; proyek?: string | null;
  /** the project's "Simulasi Blu 1.1" view: the simulation from the start, no engagement loaded first */
  simulasi?: boolean }) {
  const tampilBiaya = useTampilBiaya();
  const [runs, setRuns] = useState<Rec[]>([]);
  const [sel, setSel] = useState<string | null>(initialRun ?? null);
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<AipEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [box, setBox] = useState<Rec | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(15);
  const [skip, setSkip] = useState(true);
  const [kind, setKind] = useState("semua");
  const [focus, setFocus] = useState<{ agent?: string; card?: CardKey } | null>(null);
  // the agent under the pointer and where it is in the stage's (scrolled) content: a card, not the browser's title box
  const [hover, setHover] = useState<{ key: string; x: number; y: number; w: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [roomy, setRoomy] = useState(true);
  useEffect(() => {
    const el = root.current;
    if (!embedded || !el) return;
    const ro = new ResizeObserver(([e]) => setRoomy(e.contentRect.width >= 1150));
    ro.observe(el);
    return () => ro.disconnect();
  }, [embedded]);
  const stacked = embedded && !roomy;
  const point = (key: string) => (e: React.PointerEvent) => {
    const r = stage.current?.getBoundingClientRect();
    setHover({ key, x: e.clientX - (r?.left ?? 0) + (stage.current?.scrollLeft ?? 0), y: e.clientY - (r?.top ?? 0) + (stage.current?.scrollTop ?? 0),
      w: stage.current?.clientWidth ?? 0 });
  };
  // the replay runs in refs (60 fps, no render per event); a frame's snapshot goes to the state about 30 times a second
  const [snap, setSnap] = useState<Snap>(() => ({ clock: 0, cursor: 0, now: 0, L: fresh(), packets: [] }));
  const clock = useRef(0), cursor = useRef(0), live = useRef<Live>(fresh()), packets = useRef<Packet[]>([]);
  const paint = useCallback((now: number) => setSnap({ clock: clock.current, cursor: cursor.current, now, L: live.current, packets: packets.current.slice() }), []);
  const logBox = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // a replay file opened from disk (Simpan replay): played without the API, the engagement's spend not repeated
  const [file, setFile] = useState<string | null>(null);
  const opener = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fraud.engagements().then((l) => { setRuns(l); if (!simulasi) setSel((s) => s ?? (l[0]?.id ?? null)); }).catch((e) => setErr((e as Error).message));
    fraud.box().then(setBox).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, on open (a simulation view never picks an engagement)
  // the engagement's events: all of a finished one; a running one is followed as its agents work
  useEffect(() => {
    if (!sel || file) return;
    let halt = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new engagement starts empty
    setLoading(true); setEvents([]); setErr("");
    aip.run(sel, 0).then(async (first) => {
      if (halt) return;
      setRun(first.run); setEvents(first.events); setLoading(false);
      if (first.run.status !== "running") return;
      let after = first.next;
      for (;;) {
        await new Promise((r) => setTimeout(r, demoPoll(2000)));
        if (halt) return;
        const r = await aip.run(sel, after).catch(() => null);
        if (!r) continue;
        after = r.next;
        if (r.events.length) setEvents((es) => [...es, ...r.events]);
        setRun(r.run);
        if (r.run.status !== "running") return;
      }
    }).catch((e) => { if (!halt) { setErr((e as Error).message); setLoading(false); } });
    return () => { halt = true; };
  }, [sel, file]);

  const roster: FirmAgent[] = useMemo(() => {
    const firm = events.find((e) => e.type === "firm");
    const formed = events.filter((e) => e.type === "instances").flatMap((e) => (e.agents ?? []) as FirmAgent[]);
    return [...((firm?.tim ?? []) as FirmAgent[]), ...((firm?.telaah_tim ?? []) as FirmAgent[]), ...formed];
  }, [events]);
  const byKey = useMemo(() => new Map(roster.map((a) => [a.key, a])), [roster]);
  const who = useCallback((k: string) => byKey.get(k), [byKey]);
  const pos = useMemo(() => layoutOf(roster), [roster]);
  const tl = useMemo(() => timeline(events, skip), [events, skip]);
  const phaseSpans = useMemo(() => {
    const s: Record<string, [number, number]> = {};
    events.forEach((e, i) => {
      if (e.type !== "phase") return;
      // after a resume (an API restart) the phase is announced again: it keeps its first start
      if (e.status === "mulai") s[e.phase] = [s[e.phase]?.[0] ?? tl.at[i], tl.total];
      else if (s[e.phase]) s[e.phase][1] = tl.at[i];
    });
    return s;
  }, [events, tl]);
  // a Blu 1.1 / 1.3 engagement: the clinical review stands on the stage (aip/telaah.py); Blu 1.3's also as a tree
  const versi = useMemo(() => String(events.find((e) => e.type === "firm")?.versi ?? events.find((e) => e.type === "telaah" && e.tahap === "mulai")?.versi ?? ""), [events]);
  const blu11 = useMemo(() => events.some((e) => e.type === "telaah") || REVIEWED.includes(versi), [events, versi]);
  const blu13 = versi === "1.3";
  const v3 = versi === "3.0";
  const phases = useMemo(() => (blu13 ? PHASES.map((p) => (p[0] === "telaah" ? PHASE_13 : p)) : v3 ? PHASES.map((p) => PHASES_30[p[0]] ?? p) : PHASES), [blu13, v3]);
  const cardText = (c: (typeof CARDS)[number]) => (v3 && c.key === "ml" ? { label: "Scoring ML v3", hint: "arsitektur v3 menilai setiap klaim · mesin, bukan agen" } : c);
  const marks = useMemo(() => events.map((e, i) => ({ e, i })).filter(({ e }) => e.type === "error" || e.type === "rekomendasi" || e.type === "lanjut" || (e.type === "verdict" && !e.lini && e.validator !== "scrutiny")), [events]);

  /** the state at a moment of the replay, rebuilt from the log (no packets: a jump is not an animation) */
  const seek = useCallback((ms: number) => {
    const L = fresh();
    let i = 0;
    while (i < tl.at.length && tl.at[i] <= ms) { apply(L, events[i], i, tl.at[i], (tl.real[i] - tl.real[0]) / 1000, who); i++; }
    live.current = L; cursor.current = i; clock.current = Math.max(0, Math.min(ms, tl.total)); packets.current = [];
    stick.current = true;
    paint(performance.now());
  }, [tl, events, who, paint]);

  // a new engagement plays from its start; a running one is joined live at its end
  const loadedFor = useRef<string | null>(null);
  const source = file ? `berkas:${file}` : sel;
  useEffect(() => {
    if (!events.length || loadedFor.current === source) return;
    loadedFor.current = source;
    const rest = embedded && run?.status !== "running" && !file;  // the chart: a finished engagement as it ended
    seek((run?.status === "running" && !file) || rest ? tl.total : 0);
    setPlaying(!rest);  // the replay starts once the log has arrived
  }, [events.length, source, file, run?.status, seek, tl.total, embedded]);
  useEffect(() => {
    if (!playKey) return;
    seek(0);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a command from outside (the tab's "Putar Sistem AI Swarm"), not derived state
    setPlaying(true);
  }, [playKey, seek]);

  /** The engagement as a file (its run and every event): the animation replays from it later, offline, at no model cost. */
  const saveReplay = () => {
    if (!run || !events.length) return;
    const blob = new Blob([JSON.stringify({ jenis: "animasi-penugasan", versi: 1, disimpan: new Date().toISOString(), run, events })], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `animasi-${run.id}${run.status === "running" ? "-sebagian" : ""}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const openReplay = async (f?: File | null) => {
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (j?.jenis !== "animasi-penugasan" || !Array.isArray(j.events) || !j.run?.id) throw new Error("bukan berkas replay animasi (Simpan replay)");
      setErr(""); setFocus(null); setPlaying(false);
      // (saved while it ran: a part of the engagement, replayed as it stood — never "live")
      setFile(f.name); setRun({ ...(j.run as Run), status: j.run.status === "running" ? "tersimpan sebagian" : j.run.status }); setEvents(j.events as AipEvent[]);
    } catch (e) { setErr(`Berkas tidak bisa dibuka: ${(e as Error).message}`); }
  };
  /** Blu 1.1 as an animation only (GET /api/aip/konsultan/simulasi): played like a replay file, no model called */
  const loadSim = async () => {
    try {
      const j = await fraud.simulation(proyek);
      loadedFor.current = null;
      setErr(""); setFocus(null); setPlaying(false);
      setFile("Simulasi Blu 1.1"); setRun(j.run); setEvents(j.events);
    } catch (e) { setErr(`Simulasi tidak bisa dimuat: ${(e as Error).message}`); }
  };
  // a new simKey from the tab; the value it was mounted with is not a request (switching engagements remounts this chart)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the simulation view loads its replay once, when it opens
    if (simulasi) loadSim();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, on open
  const simSeen = useRef(simKey);
  useEffect(() => {
    if (!simKey || simKey === simSeen.current) return;
    simSeen.current = simKey;
    loadSim();
  }, [simKey]); // eslint-disable-line react-hooks/exhaustive-deps -- loads once per request
  // the clock keeps its place in the log when the timeline is rebuilt (idle skipping toggled, live events added)
  useEffect(() => { clock.current = cursor.current ? tl.at[cursor.current - 1] : 0; }, [tl]);

  // /swarm-x (demoSwarm.ts): while its engagement runs, the transport drives the demo's clock — its speed, its pause — and
  // the chart follows at that speed; a replay afterwards is the chart's own again
  const demo = useDemoSwarm();
  const bound = !!demo && run?.status === "running" && !file;
  const rate = bound ? demo.speed : speed;
  const on = bound ? !demo.paused : playing;
  useEffect(() => {
    let raf = 0, last = performance.now(), painted = 0;
    const step = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      if (on && events.length) {
        clock.current = Math.min(tl.total, clock.current + dt * rate);
        const L = live.current;
        let n = 0;
        while (cursor.current < tl.at.length && tl.at[cursor.current] <= clock.current) {
          const i = cursor.current, e = events[i];
          apply(L, e, i, tl.at[i], (tl.real[i] - tl.real[0]) / 1000, who);
          if (n++ < 60) for (const p of packetsOf(e, pos, who)) packets.current.push({ ...p, t0: now });
          if (e.agent && (e.type === "tool" || e.type === "tag" || e.type === "handoff" || e.type === "rekomendasi" || e.type === "bagian")) L.flash[e.agent] = now;
          cursor.current++;
        }
        if (packets.current.length > 260) packets.current.splice(0, packets.current.length - 260);
        if (clock.current >= tl.total && run?.status !== "running") setPlaying(false);
      }
      packets.current = packets.current.filter((p) => now - p.t0 < p.dur);
      if (now - painted > 33 && (on || packets.current.length)) { painted = now; paint(now); }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on, rate, tl, events, pos, who, run?.status, paint]);

  // space plays and pauses (not while typing; while a demo engagement runs, the demo page pauses its clock)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code !== "Space" || demoLive() || (e.target as HTMLElement)?.closest("input, textarea, select")) return;
      e.preventDefault();
      setPlaying((p) => !p);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const { L, now } = snap;
  // phase dividers stay in every filter: they say where in the engagement a line belongs
  const shown = L.log.filter((l) => l.kind === "fase" || kind === "semua" || l.kind === kind).slice(-220);
  useEffect(() => { if (stick.current && logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight; }, [snap, kind]);
  const working = Object.values(L.st).filter((s) => s === "bekerja").length;
  const doneN = Object.values(L.st).filter((s) => s === "selesai" || s === "gagal").length;
  // a role (the investigator, the red team) is a template, never run itself: its instances are counted, and its node
  // shows how they stand (engagement 5 read "104/106 selesai" with every agent done: the two roles were counted)
  const runners = roster.filter((a) => a.jenjang !== "peran").length;
  const roleState = (key: string): string | undefined => {
    const st = roster.filter((a) => a.instans_dari === key && L.formed.has(a.key)).map((a) => L.st[a.key]);
    if (!st.length) return undefined;
    return st.some((s) => s === "bekerja") ? "bekerja" : st.every((s) => s === "selesai" || s === "gagal") ? "selesai" : st.some((s) => s === "antre") ? "antre" : undefined;
  };
  const phaseIdx = Math.max(0, phases.findIndex((p) => p[0] === (L.phase || (blu11 ? "telaah" : v3 ? "skoring_v3" : "penugasan"))));
  const famV3 = ((L.v3?.famili ?? []) as Rec[]).filter((x) => Number(x.klaim) > 0);
  const rowsTitle = `baris hasil yang dikembalikan tool ke agen, dijumlah per panggilan (baca ulang ikut terhitung)${L.objek ? `; ukur mengagregasi ${idn(L.objek)} objek Nexus` : ""}${L.v3 ? `; mesin v3 menilai ${idn(L.v3.klaim)} klaim` : ""}`;
  const realNow = snap.cursor && tl.real[snap.cursor - 1] != null ? (tl.real[snap.cursor - 1] - tl.real[0]) / 1000 : 0;
  const realTotal = events.length ? (tl.real[events.length - 1] - tl.real[0]) / 1000 : 0;
  const pct = tl.total ? Math.min(1, snap.clock / tl.total) : 0;
  const leads = roster.filter((a) => a.jenjang === "manajer");
  const partner = roster.find((a) => a.jenjang === "partner");
  const techs = roster.filter((a) => a.lini === "ml" && a.jenjang === "analis");
  const techsDone = techs.filter((a) => L.st[a.key] === "selesai").length;
  const recTotal = Object.values(L.recs).reduce((n, v) => n + v, 0);
  const strengthTotal = Math.max(1, L.strength.lemah + L.strength.sedang + L.strength.kuat);
  const topModes = Object.entries(L.modes).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const groups = Object.entries((L.box?.kelompok ?? {}) as Record<string, Rec>);
  const groupMax = Math.max(1, ...groups.map(([, g]) => Number(g.faskes) || 0));
  const hubHot = snap.packets.filter((p) => p.b.y === HUB.y - HUB.h / 2 && now - p.t0 > p.dur * 0.8).length;
  // a lead whose small agents are at work is lit too: it is the team that works
  const busyLeads = new Set(roster.filter((a) => a.induk && L.st[a.key] === "bekerja").map((a) => a.induk));
  // the box as people have it now (decisions are people's, after the engagement)
  const human = useMemo(() => {
    const ps = (box?.per_status ?? null) as Record<string, number> | null;
    if (!ps) return null;
    const waiting = (ps.karantina ?? 0) + (ps.diaudit ?? 0);
    return { waiting, decided: Object.values(ps).reduce((n, v) => n + Number(v || 0), 0) - waiting };
  }, [box]);

  const curve = (p: Packet): XY & { o: number } => {
    const t = Math.min(1, (now - p.t0) / p.dur), u = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const mx = (p.a.x + p.b.x) / 2, my = (p.a.y + p.b.y) / 2, dx = p.b.x - p.a.x, dy = p.b.y - p.a.y;
    const cx = mx - dy * 0.18, cy = my + dx * 0.18;
    return { x: (1 - u) ** 2 * p.a.x + 2 * (1 - u) * u * cx + u * u * p.b.x, y: (1 - u) ** 2 * p.a.y + 2 * (1 - u) * u * cy + u * u * p.b.y, o: t < 0.85 ? 1 : (1 - t) / 0.15 };
  };

  const selAgent = focus?.agent ? byKey.get(focus.agent) : undefined;

  return (
    <div ref={root} className={`flex min-h-0 flex-1 flex-col overflow-hidden bg-[#12161b] text-[12px] text-[#e5e8eb] ${full ? "h-screen" : ""} `}>
      {/* the run and the transport */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/5 bg-[#1c2127] px-3 py-2">
        <p className="mr-1 flex items-center gap-1.5 text-[13px] font-semibold text-white"><Icon name="play" className="h-3.5 w-3.5 text-[#9d8cff]" />{embedded ? "Bagan firma" : "Animasi sistem multi-agen"}</p>
        {!embedded && <select value={file ? "" : sel ?? ""} onChange={(e) => { loadedFor.current = null; setFile(null); setSel(e.target.value); setFocus(null); }}
          className="rounded-sm border border-white/15 bg-[#111418] px-1.5 py-0.5 text-[11px] text-[#d3d8de] outline-none" title="penugasan AI Agent Swarm yang diputar ulang">
          {file && <option value="">berkas · {file}</option>}
          {/* a run opened by its link that the list does not hold (the list shows the signed-in user's own runs) */}
          {!file && sel && run?.id === sel && !runs.some((r) => r.id === sel) && (
            <option value={sel}>{wib(run.created_at)} · {run.status === "running" ? "berjalan" : `${run.status}${tampilBiaya ? ` · ${usd(run.spent_usd)}` : ""}`}</option>
          )}
          {runs.map((r) => <option key={r.id} value={r.id}>{wib(String(r.created_at ?? ""))} · {r.status === "running" ? "berjalan" : `${r.status}${tampilBiaya ? ` · ${usd(r.spent_usd)}` : ""}`}</option>)}
        </select>}
        <button onClick={saveReplay} disabled={!events.length} title="unduh penugasan ini (run + semua event) sebagai berkas: animasinya bisa diputar ulang kapan saja, offline, tanpa biaya model"
          className="flex items-center gap-1 rounded border border-white/15 px-2 py-0.5 text-[11px] text-[#d3d8de] hover:bg-white/10 disabled:opacity-40"><Icon name="download" className="h-3 w-3" />Simpan replay</button>
        <button onClick={() => opener.current?.click()} title="putar berkas replay yang pernah disimpan"
          className="flex items-center gap-1 rounded border border-white/15 px-2 py-0.5 text-[11px] text-[#d3d8de] hover:bg-white/10"><Icon name="upload" className="h-3 w-3" />Buka replay</button>
        <input ref={opener} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { openReplay(e.target.files?.[0]); e.target.value = ""; }} />
        {!demo && <button onClick={loadSim} title="putar penugasan Blu 1.1 sebagai animasi saja: fase telaah klinis diproyeksikan dari kalibrasi, fase berikutnya jejak nyata penugasan terakhir proyek — tanpa panggilan model, tanpa biaya"
          className="flex items-center gap-1 rounded border border-[#c084fc]/50 px-2 py-0.5 text-[11px] text-[#e9d5ff] hover:bg-[#c084fc]/10"><Icon name="sparkle" className="h-3 w-3" />Simulasi Blu 1.1</button>}
        {run?.simulasi && <span className="rounded-full bg-[#c084fc]/20 px-2 py-0.5 text-[10px] font-semibold text-[#e9d5ff]"
          title="animasi saja: fase telaah klinis adalah proyeksi dari kalibrasi terakhir; fase berikutnya jejak nyata penugasan sumber; tidak ada model yang dipanggil">SIMULASI · tanpa panggilan model</span>}
        <div className="flex items-center gap-0.5">
          <button onClick={() => { seek(0); setPlaying(true); }} title="ulang dari awal" className="rounded p-1 hover:bg-white/10"><Icon name="restore" className="h-3.5 w-3.5" /></button>
          <button onClick={() => { if (bound) { demoSwarm.togglePause(); return; } if (clock.current >= tl.total) seek(0); setPlaying((p) => !p); }} title="putar / jeda (spasi)"
            className="flex items-center gap-1 rounded-sm bg-[#5b5fd6] px-2.5 py-0.5 font-medium text-white hover:bg-[#6a6ee0]">
            <Icon name={on ? "pause" : "play"} className="h-3 w-3" />{on ? "Jeda" : "Putar"}
          </button>
        </div>
        <div className="flex overflow-hidden rounded border border-white/15 text-[10.5px]" title="kecepatan putar ulang">
          {SPEEDS.map((s) => <button key={s} onClick={() => (bound ? demoSwarm.setSpeed(s) : setSpeed(s))} className={`px-1.5 py-0.5 tabular-nums ${rate === s ? "bg-white/15 text-white" : "text-[#abb3bf] hover:bg-white/10"}`}>{s}×</button>)}
        </div>
        <label className="flex items-center gap-1 text-[10.5px] text-[#abb3bf]" title="jeda panjang saat model berpikir dipadatkan menjadi paling lama 2,5 detik">
          <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />lewati jeda
        </label>
        {run?.status === "running" && <span className="rounded-full bg-[#e5484d]/20 px-2 py-0.5 text-[10px] font-semibold text-[#ffb4b4]">● LANGSUNG</span>}
        <span className="ml-auto tabular-nums text-[11px] text-[#8f99a8]">waktu nyata {mmss(realNow)} / {mmss(realTotal)} · {snap.cursor.toLocaleString("id-ID")}/{events.length.toLocaleString("id-ID")} event{tampilBiaya ? ` · biaya ${usd(run?.spent_usd)}` : ""}</span>
        {!full && !demo && <a href={`/aip-jkn/animasi?embed=1${sel ? `&run=${sel}` : ""}`} target="_blank" rel="noreferrer" title="layar penuh untuk presentasi" className="rounded p-1 text-[#abb3bf] hover:bg-white/10"><Icon name="external" className="h-3.5 w-3.5" /></a>}
      </div>
      {/* the timeline: the phases, the moments that matter, the playhead */}
      <div className="border-b border-white/5 bg-[#161a1f] px-3 pb-2 pt-1.5">
        <div className="relative h-7 cursor-pointer select-none" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * tl.total); }}>
          {phases.map(([k, label], i) => {
            const s = phaseSpans[k];
            if (!s || !tl.total) return null;
            return (
              <div key={k} className="absolute top-0 flex h-4 items-center overflow-hidden rounded-sm px-1 text-[9.5px] font-medium text-black/80"
                style={{ left: `${(s[0] / tl.total) * 100}%`, width: `${Math.max(0.4, ((s[1] - s[0]) / tl.total) * 100)}%`, background: k === "skoring_v3" ? V3_COLOR : PHASE_COLOR[i], opacity: L.phase === k ? 1 : 0.55 }} title={label}>
                <span className="truncate">{label}</span>
              </div>
            );
          })}
          {marks.map(({ e, i }) => (
            <div key={i} className={`absolute ${e.type === "lanjut" ? "top-0 h-7 w-0.5" : "top-[18px] h-2 w-px"}`}
              title={e.type === "error" ? `galat: ${e.message}` : e.type === "rekomendasi" ? `rekomendasi ${e.jalur}` : e.type === "lanjut" ? `dilanjutkan setelah API dimulai ulang (${Number(e.agen_selesai ?? 0)} agen selesai tidak diulang)` : "putusan validator"}
              style={{ left: `${(tl.at[i] / tl.total) * 100}%`, background: e.type === "error" ? "#e5484d" : e.type === "rekomendasi" ? JALUR[e.jalur] ?? "#d55181" : e.type === "lanjut" ? RESUME : "#29a383" }} />
          ))}
          <div className="absolute -top-0.5 h-7 w-0.5 rounded bg-white shadow-[0_0_6px_white]" style={{ left: `${pct * 100}%` }} />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="rounded px-1.5 py-px text-[10.5px] font-semibold text-black" style={{ background: phases[phaseIdx]?.[0] === "skoring_v3" ? V3_COLOR : PHASE_COLOR[phaseIdx] }}>{phases[phaseIdx]?.[1]}</span>
          <p className="min-w-0 flex-1 truncate text-[11px] text-[#c5cbd3]">{phases[phaseIdx]?.[2]}</p>
          <span className="shrink-0 text-[10.5px] tabular-nums text-[#8f99a8]" title="agen tetap dan instans dinamis yang dibentuk sejauh ini; peran (penyidik, red team) tidak dihitung, instansnya yang dihitung"><b className="text-[#b8a9ff]">{working}</b> bekerja · {doneN}/{runners} selesai · <span title={rowsTitle}>{idn(L.rowsN)} baris dibaca</span> · {L.tagN.toLocaleString("id-ID")} tag · {recTotal} rekomendasi{L.errors ? ` · ${L.errors} galat` : ""}</span>
        </div>
      </div>

      <div className={`flex min-h-0 flex-1 ${stacked ? "flex-col" : embedded ? "" : "max-xl:flex-col"}`}>
        <div ref={stage} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto p-2" onPointerLeave={() => setHover(null)}>
          {loading && <p className="p-6 text-center text-[#8f99a8]">Memuat log penugasan…</p>}
          {err && <p className="p-3 text-red-300">{err}</p>}
          {!loading && !roster.length && !err && <p className="p-6 text-center text-[#8f99a8]">Belum ada penugasan AI Agent Swarm untuk diputar ulang.</p>}
          {roster.length > 0 && (
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Animasi agen bekerja: orkestrator, agen domain dan agen kecilnya, alur indikasi ke keputusan">
              <defs>
                <filter id="ag-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4" /></filter>
                <filter id="ag-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6" /></filter>
                <linearGradient id="ag-hub" x1="0" x2="1"><stop offset="0" stopColor="#1e2a36" /><stop offset="0.5" stopColor="#24384a" /><stop offset="1" stopColor="#1e2a36" /></linearGradient>
                {/* Blu 1.1's clinical review: a light sweeping the Nexus bar, clipped to it */}
                <linearGradient id="ag-scan" x1="0" x2="1"><stop offset="0" stopColor={TELAAH_COLOR} stopOpacity="0" /><stop offset="0.5" stopColor={TELAAH_COLOR} stopOpacity="0.55" /><stop offset="1" stopColor={TELAAH_COLOR} stopOpacity="0" /></linearGradient>
                <clipPath id="ag-hubclip"><rect x={HUB.x - HUB.w / 2} y={HUB.y - HUB.h / 2} width={HUB.w} height={HUB.h} rx={17} /></clipPath>
              </defs>
              {/* links: the orchestrator to its leads, each lead to its small agents */}
              {leads.map((l) => {
                const a = pos[partner?.key ?? "partner"], b = pos[l.key];
                if (!a || !b) return null;
                const hot = L.st[l.key] === "bekerja";
                return <path key={`pl-${l.key}`} d={`M${a.x},${a.y + a.r} C${a.x},${(a.y + b.y) / 2} ${b.x},${(a.y + b.y) / 2} ${b.x},${b.y - b.r}`} fill="none"
                  stroke={LINI[l.lini]?.color ?? "#555"} strokeOpacity={hot ? 0.8 : 0.28} strokeWidth={hot ? 2 : 1.2} />;
              })}
              {roster.filter((a) => a.induk && a.jenjang !== "manajer" && pos[a.key] && pos[a.induk] && (!a.instans_dari || L.formed.has(a.key))).map((a) => {
                const p = pos[a.key], q = pos[a.induk!], hot = L.st[a.key] === "bekerja";
                return <line key={`e-${a.key}`} x1={q.x} y1={q.y + q.r} x2={p.x} y2={p.y - p.r} stroke={LINI[a.lini]?.color ?? "#555"} strokeOpacity={hot ? 0.55 : 0.08} strokeWidth={hot ? 1.2 : 0.8} />;
              })}
              {/* the shared data every agent reads */}
              <g>
                <rect x={HUB.x - HUB.w / 2} y={HUB.y - HUB.h / 2} width={HUB.w} height={HUB.h} rx={17} fill="url(#ag-hub)" stroke="#3987e5" strokeOpacity={0.35 + Math.min(0.6, hubHot * 0.06)} strokeWidth={1.5} />
                <text x={HUB.x} y={HUB.y + 4} textAnchor="middle" className="fill-[#c5d8ef] text-[12px] font-semibold">
                  {L.v3 ? `Nexus: ${idn(L.v3.klaim)} klaim dari ${idn(L.v3.faskes)} faskes (data sintetis)` : "Nexus · data JKN sintetis · buku besar indikasi · shared state"}
                </text>
              </g>
              {/* how much of it was analysed (Blu 1.1 / 1.3 keep this place for the examination's chip; their count is in the header) */}
              {!blu11 && (L.rowsN > 0 || !!L.v3) && (
                <text x={HUB.x} y={HUB.y + HUB.h / 2 + 16} textAnchor="middle" className="fill-[#b4bcc7] text-[10.5px] tabular-nums">
                  {L.v3 && <tspan x={HUB.x}>{L.v3.kontrol
                    ? `Model v3 sudah menilai ke-${idn(L.v3.klaim)} klaim; AI Agent hanya membaca ${idn(L.v3.berisiko)} Klaim Berisiko + ${idn(L.v3.kontrol)} sampel kontrol acak dari luar saringan.`
                    : `Model v3 sudah menilai ke-${idn(L.v3.klaim)} klaim; ${idn(L.v3.berisiko)} di antaranya masuk Klaim Berisiko (yang dibaca agen lebih dulu).`}</tspan>}
                  <tspan x={HUB.x} dy={L.v3 ? 14 : 0}>{`Sejauh ini AI Agent membaca ${idn(L.rowsN)} baris data (termasuk baca ulang)` +
                    `${L.objek ? ` dan mengagregasi ${idn(L.objek)} objek` : ""} untuk mencari indikasi fraud.`}</tspan>
                  <title>{rowsTitle}</title>
                </text>
              )}
              {/* Blu 1.1 only: the review runs on the Nexus data (the user, 2026-10-30: no node, it must not read as a gate) */}
              {blu11 && (() => {
                const R = L.review, on = !!R && R.status === "berjalan" && L.phase === "telaah";
                const done = R?.status === "selesai", stopped = R?.status === "berhenti";
                const what = blu13 ? "Decision examination" : "Clinical examination";
                const label = done ? `${what} ✓` : stopped ? `${what} berhenti · berlanjut seperti Blu 1.0` : what;
                const w = label.length * 6.1 + (on ? 34 : 24), c = done ? "#29a383" : stopped ? "#fab219" : TELAAH_COLOR;
                return (
                  <g>
                    {on && (
                      <g clipPath="url(#ag-hubclip)">
                        <rect y={HUB.y - HUB.h / 2} width={150} height={HUB.h} fill="url(#ag-scan)">
                          <animate attributeName="x" from={HUB.x - HUB.w / 2 - 150} to={HUB.x + HUB.w / 2} dur="2.4s" repeatCount="indefinite" />
                        </rect>
                      </g>
                    )}
                    {on && (
                      <rect x={HUB.x - HUB.w / 2} y={HUB.y - HUB.h / 2} width={HUB.w} height={HUB.h} rx={17} fill="none" stroke={TELAAH_COLOR} strokeWidth={1.8}>
                        <animate attributeName="stroke-opacity" values="0.9;0.25;0.9" dur="1.8s" repeatCount="indefinite" />
                      </rect>
                    )}
                    <g transform={`translate(${TELAAH.x},${TELAAH.y})`}>
                      <title>{blu13
                        ? "Decision examination (Blu 1.3): OpenAI Decisions menilai setiap klaim berisiko di Nexus (aturan + ML) dengan peluang wajar / perlu diperiksa / mencurigakan. Tanpa tag: agen memeriksa klaim dengan skor tertinggi dan menandai dengan buktinya sendiri."
                        : "Clinical examination (Blu 1.1): membaca setiap klaim berisiko di Nexus (aturan + ML) dengan model saring; yang bukan wajar dan 5% sampel acak diperiksa ulang keluarga model lain. Agen tetap membaca seluruh data; tag lemah hanya bila kedua model melihat masalah."}</title>
                      <rect x={-w / 2} y={-9} width={w} height={18} rx={9} fill={c} fillOpacity={on ? 0.28 : 0.14} stroke={c} strokeOpacity={on ? 0.9 : 0.5} />
                      {on && (
                        <circle cx={-w / 2 + 11} cy={0} r={3} fill={TELAAH_COLOR}>
                          <animate attributeName="opacity" values="1;0.2;1" dur="1.2s" repeatCount="indefinite" />
                        </circle>
                      )}
                      <text x={on ? 6 : 0} y={3.5} textAnchor="middle" className="fill-[#f3e8ff] text-[10px] font-medium">{label}</text>
                    </g>
                  </g>
                );
              })()}
              {/* the flow: indication → ML tagging → quarantine box → decision dashboard */}
              {CARDS.slice(0, -1).map((c, i) => {
                const x1 = c.x + CARD.w, x2 = CARDS[i + 1].x, y = CARD.y + CARD.h / 2, on = [L.tagN + L.auto > 0, !!L.ml || !!L.v3, !!L.box][i];
                return (
                  <g key={`ar-${c.key}`}>
                    <line x1={x1 + 3} y1={y} x2={x2 - 6} y2={y} stroke={on ? "#e5e8eb" : "#3a414b"} strokeWidth={2} strokeDasharray="5 4">
                      {on && <animate attributeName="stroke-dashoffset" from="18" to="0" dur="0.8s" repeatCount="indefinite" />}
                    </line>
                    <path d={`M${x2 - 8},${y - 5} L${x2 - 2},${y} L${x2 - 8},${y + 5}`} fill="none" stroke={on ? "#e5e8eb" : "#3a414b"} strokeWidth={2} />
                  </g>
                );
              })}
              {CARDS.map((c) => {
                const active = focus?.card === c.key;
                const lit = c.key === "indikasi" ? L.tagN + L.auto > 0 : c.key === "ml" ? !!L.ml || !!L.v3 || techsDone > 0 : c.key === "box" ? !!L.box : recTotal > 0 || L.report;
                return (
                  <g key={c.key} transform={`translate(${c.x},${CARD.y})`} className="cursor-pointer" onClick={() => setFocus(active ? null : { card: c.key })}>
                    <rect width={CARD.w} height={CARD.h} rx={8} fill="#1c2127" stroke={active ? "#ffffff" : lit ? "#4b5563" : "#2a3038"} strokeWidth={active ? 2 : 1} />
                    <text x={12} y={20} className="fill-white text-[12.5px] font-semibold">{cardText(c).label}</text>
                    <text x={12} y={34} className="fill-[#8f99a8] text-[9.5px]">{cardText(c).hint}</text>
                    {c.key === "indikasi" && (
                      <g>
                        <text x={12} y={64}><tspan className="fill-white text-[22px] font-semibold tabular-nums">{L.tagN.toLocaleString("id-ID")}</tspan><tspan dx={6} className="fill-[#abb3bf] text-[10.5px]">tag agen</tspan></text>
                        <text x={12} y={80} className="fill-[#8f99a8] text-[10px]">+ {L.auto.toLocaleString("id-ID")} tag aturan otomatis</text>
                        {(["lemah", "sedang", "kuat"] as const).reduce<{ x: number; els: ReactNode[] }>((acc, k) => {
                          const w = ((CARD.w - 24) * (L.strength[k] ?? 0)) / strengthTotal;
                          acc.els.push(<rect key={k} x={12 + acc.x} y={88} width={Math.max(0, w - (w > 2 ? 2 : 0))} height={8} rx={2} fill={STRENGTH[k]} />);
                          acc.x += w;
                          return acc;
                        }, { x: 0, els: [] }).els}
                        <text x={12} y={110} className="fill-[#8f99a8] text-[9.5px]">lemah {L.strength.lemah} · sedang {L.strength.sedang} · kuat {L.strength.kuat}</text>
                        {topModes.slice(0, 2).map(([m, n], i) => <text key={m} x={12} y={126 + i * 12} className="fill-[#c5cbd3] text-[9.5px]">{m.replace(/_/g, " ").toLowerCase()} · {n}</text>)}
                        {!!(L.reds.melemah || L.reds.bertahan) && <text x={12} y={CARD.h - 10} className="fill-[#7ee2c0] text-[9.5px]">red team: {L.reds.melemah ?? 0} melemah · {L.reds.bertahan ?? 0} bertahan</text>}
                      </g>
                    )}
                    {c.key === "ml" && v3 && (
                      <g>
                        <text x={12} y={64}><tspan className="fill-white text-[22px] font-semibold tabular-nums">{L.v3 ? idn(L.v3.klaim) : "—"}</tspan><tspan dx={6} className="fill-[#abb3bf] text-[10.5px]">klaim dinilai</tspan></text>
                        <text x={12} y={80} className="fill-[#8f99a8] text-[10px]">{L.v3 ? `dari ${idn(L.v3.faskes)} faskes · saringan v3:` : "menunggu mesin scoring"}</text>
                        {/* the funnel: every claim scored, the risky claims the agents read first, v3's own decision (each inside the one above) */}
                        {L.v3 && ([
                          ["dinilai v3", L.v3.klaim, "semua klaim di Nexus, tanpa saringan"],
                          ["Klaim Berisiko", L.v3.berisiko, "ditandai v3, ditandai rule, atau peluang ≥ 20%: tabel Klaim Berisiko (BPJS) yang dibaca agen lebih dulu"],
                          ["ditandai v3", L.v3.ditandai, "keputusan v3: peluang terkalibrasi ≥ ambang atau network rule"],
                        ] as [string, unknown, string][]).map(([label, n, arti], i) => {
                          const w = Math.max(2, ((CARD.w - 150) * (Number(n) || 0)) / Math.max(1, Number(L.v3?.klaim) || 1));
                          return (
                            <g key={label} transform={`translate(12,${90 + i * 14})`}>
                              <title>{`${label}: ${idn(n)} klaim — ${arti}`}</title>
                              <text y={8} className="fill-[#c5cbd3] text-[9.5px]">{label}</text>
                              <rect x={80} y={1} width={w} height={8} rx={2} fill={V3_COLOR} fillOpacity={i === 0 ? 0.35 : 0.85} />
                              <text x={86 + w} y={8} className="fill-white text-[9.5px] font-semibold tabular-nums">{idn(n)}</text>
                            </g>
                          );
                        })}
                        {!!L.v3?.kontrol && (
                          <text x={12} y={140} className="fill-[#c5cbd3] text-[9.5px]">
                            <title>{`klaim acak di luar Klaim Berisiko (1% per provinsi, maks 40) dari ${idn(L.v3.di_luar)} klaim yang menurut v3 tidak berisiko: diperiksa analis wilayah untuk mengukur yang terlewat ML`}</title>
                            + sampel kontrol <tspan className="fill-white font-semibold tabular-nums">{idn(L.v3.kontrol)}</tspan> klaim dari luar saringan
                          </text>
                        )}
                        <text x={12} y={CARD.h - 10} className="fill-[#8f99a8] text-[9.5px]">label: planted fraud sintetis · tidak dibaca agen</text>
                      </g>
                    )}
                    {c.key === "ml" && !v3 && (
                      <g>
                        <text x={12} y={64} className="fill-white text-[22px] font-semibold tabular-nums">{L.ml ? `${L.ml.faskes ?? 0}` : techsDone ? `${techsDone}/${techs.length}` : "—"}</text>
                        <text x={12} y={80} className="fill-[#abb3bf] text-[10.5px]">{L.ml ? `faskes disepakati ${L.ml.teknik ?? "-"} teknik` : `sub-agen teknik selesai`}</text>
                        {techs.map((a, i) => {
                          const s = L.st[a.key];
                          return <rect key={a.key} x={12 + i * 26} y={90} width={22} height={8} rx={2} fill={s === "selesai" ? LINI.ml.color : s === "bekerja" ? "#ffd27a" : "#2a3038"}><title>{a.name}: {STATE_LABEL[s ?? ""] ?? "belum"}</title></rect>;
                        })}
                        {L.ml?.tag && <text x={12} y={118} className="fill-[#c5cbd3] text-[9.5px]">tag ML: kuat {L.ml.tag.kuat ?? 0} · sedang {L.ml.tag.sedang ?? 0} · lemah {L.ml.tag.lemah ?? 0}</text>}
                        <text x={12} y={134} className="fill-[#8f99a8] text-[9.5px]">label nyata: klaim yang dikoreksi verifikator</text>
                      </g>
                    )}
                    {c.key === "box" && (
                      <g>
                        <text x={12} y={64} className="fill-white text-[22px] font-semibold tabular-nums">{L.box ? Number(L.box.faskes ?? 0).toLocaleString("id-ID") : "—"}</text>
                        <text x={12} y={80} className="fill-[#abb3bf] text-[10.5px]">{L.box ? `faskes · estimasi kerugian ${rp(Number(L.box.total_estimasi_kerugian_rp ?? 0))}` : "menunggu fase karantina"}</text>
                        {groups.map(([g, v], i) => {
                          const n = Number(v.faskes) || 0, h = Math.max(2, (46 * Math.log10(1 + n)) / Math.log10(1 + groupMax));
                          return (
                            <g key={g} transform={`translate(${16 + i * 48},0)`}>
                              <rect x={0} y={142 - h} width={30} height={h} rx={2} fill={GROUP_COLOR[g] ?? "#738091"}><title>{`kelompok ${g}: ${n} faskes — ${v.arti ?? ""}`}</title></rect>
                              <text x={15} y={154} textAnchor="middle" className="fill-[#d3d8de] text-[9.5px] font-semibold">{g} · {n}</text>
                            </g>
                          );
                        })}
                      </g>
                    )}
                    {c.key === "keputusan" && (
                      <g>
                        <text x={12} y={64} className="fill-white text-[22px] font-semibold tabular-nums">{recTotal}</text>
                        <text x={12} y={80} className="fill-[#abb3bf] text-[10.5px]">rekomendasi jalur dari penyidik</text>
                        {(["ditindak", "dibina", "dibebaskan"] as const).map((j, i) => (
                          <g key={j} transform={`translate(${12 + i * 80},90)`}>
                            <rect width={74} height={18} rx={9} fill={JALUR[j]} fillOpacity={0.18} stroke={JALUR[j]} strokeOpacity={0.6} />
                            <text x={37} y={12.5} textAnchor="middle" className="fill-[#e5e8eb] text-[9.5px]">{j} · {L.recs[j] ?? 0}</text>
                          </g>
                        ))}
                        <text x={12} y={126} className="fill-[#c5cbd3] text-[9.5px]">{L.final ? `validator laporan: ${L.final.passed}/${L.final.total}` : "validator laporan: menunggu"}{L.report ? " · laporan diserahkan" : ""}</text>
                        <text x={12} y={142} className="fill-[#8f99a8] text-[9.5px]">{human ? `keputusan manusia kini: ${human.decided} diputuskan · ${human.waiting.toLocaleString("id-ID")} menunggu` : "keputusan: manusia, di Box Karantina"}</text>
                        <text x={CARD.w - 12} y={CARD.h - 8} textAnchor="end" className="fill-[#b8a9ff] text-[9.5px] underline">buka dashboard keputusan →</text>
                      </g>
                    )}
                  </g>
                );
              })}
              {/* the scrutiny validator (code) beside the orchestrator */}
              {pos.scrutiny && (
                <g transform={`translate(${pos.scrutiny.x},${pos.scrutiny.y})`} className="cursor-pointer" onClick={() => setFocus({ agent: "scrutiny" })}
                  onPointerEnter={point("scrutiny")} onPointerMove={point("scrutiny")} onPointerLeave={() => setHover(null)}>
                  <rect x={-8} y={-8} width={16} height={16} transform="rotate(45)" fill="#232a33" stroke="#b8a9ff" strokeWidth={2} />
                  <text y={24} textAnchor="middle" className="fill-[#c5cbd3] text-[10px]">Scrutiny · kode</text>
                  {L.scrut[1] > 0 && <text y={-14} textAnchor="middle" className="fill-[#b8a9ff] text-[9.5px] tabular-nums">{L.scrut[0]}/{L.scrut[1]}</text>}
                </g>
              )}
              {/* the agents */}
              {roster.filter((a) => pos[a.key] && (!a.instans_dari || L.formed.has(a.key))).map((a) => {
                const p = pos[a.key], s = a.jenjang === "peran" ? roleState(a.key) : L.st[a.key], c = LINI[a.lini]?.color ?? "#8f99a8", f = L.flash[a.key];
                const sel = focus?.agent === a.key, big = a.jenjang !== "analis", team = s !== "bekerja" && busyLeads.has(a.key);
                // idle: tinted with its line; at work: its line's colour, bright and pulsing; done: dimmed with a green ring
                const fill = s === "gagal" ? "#5a2326" : c;
                const fillOp = s === "bekerja" ? 1 : s === "selesai" ? 0.42 : team ? 0.55 : s === "gagal" ? 1 : 0.14;
                const ring = sel ? "#ffffff" : s === "antre" ? "#fab219" : s === "selesai" ? "#29a383" : s === "gagal" ? "#e5484d" : s === "bekerja" || team ? "#ffffff" : c;
                const ringOp = s || team || sel ? 1 : 0.45;
                const age = f ? now - f : 1e9;
                return (
                  <g key={a.key} transform={`translate(${p.x},${p.y})`} className="cursor-pointer" onClick={() => { setFocus(sel ? null : { agent: a.key }); onAgent?.(sel ? null : a.key); }}
                    onPointerEnter={point(a.key)} onPointerMove={point(a.key)} onPointerLeave={() => setHover(null)}>
                    {(s === "bekerja" || team) && <circle r={p.r + 5} fill={c} opacity={team ? 0.25 : 0.45} filter="url(#ag-glow)" />}
                    {s === "bekerja" && <circle r={p.r + 3} fill="none" stroke={c} strokeOpacity={0.7}><animate attributeName="r" values={`${p.r + 1};${p.r + 7};${p.r + 1}`} dur="1.4s" repeatCount="indefinite" /><animate attributeName="stroke-opacity" values="0.8;0;0.8" dur="1.4s" repeatCount="indefinite" /></circle>}
                    {age < 450 && <circle r={p.r + 2 + (age / 450) * 9} fill="none" stroke="#ffffff" strokeOpacity={1 - age / 450} strokeWidth={1.2} />}
                    <circle r={p.r} fill={fill} fillOpacity={fillOp} stroke={ring} strokeOpacity={ringOp} strokeWidth={sel ? 2.4 : s === "bekerja" ? 1.4 : 1.6}
                      strokeDasharray={a.jenjang === "peran" || s === "antre" ? "3 2" : undefined} />
                    {a.jenjang === "peran" && <text y={3} textAnchor="middle" className="pointer-events-none fill-white text-[7px] font-semibold">×{String(a.target?.kapasitas ?? roster.filter((x) => x.instans_dari === a.key).length ?? "")}</text>}
                    {!!L.tags[a.key] && a.jenjang === "analis" && <text y={2.5} textAnchor="middle" className="pointer-events-none fill-white text-[6.5px] font-bold">{L.tags[a.key] > 99 ? "99+" : L.tags[a.key]}</text>}
                    {big && a.jenjang !== "peran" && <text y={p.r + 13} textAnchor="middle" className="pointer-events-none fill-[#e5e8eb] text-[11px] font-medium">{short(a, a.key)}</text>}
                    {a.jenjang === "partner" && <text y={p.r + 25} textAnchor="middle" className="pointer-events-none fill-[#8f99a8] text-[9.5px]">rencana · kontrak · laporan</text>}
                  </g>
                );
              })}
              {/* the interactions in flight */}
              {snap.packets.map((p, i) => {
                const q = curve(p);
                return <circle key={i} cx={q.x} cy={q.y} r={p.r} fill={p.color} opacity={q.o} filter={p.r >= 3 ? "url(#ag-soft)" : undefined} />;
              })}
            </svg>
          )}
          {hover && (() => {
            // the hover card: who the agent is, what its kind of agent does, its own assignment, and its state now
            const wide = hover.w;
            const style = { top: hover.y + 14, ...(hover.x > wide - 340 ? { right: wide - hover.x + 14 } : { left: hover.x + 14 }) };
            const box = "pointer-events-none absolute z-30 rounded-lg border border-white/15 bg-[#111418] px-3 py-2 text-[11.5px] shadow-2xl";
            if (hover.key === "scrutiny") return (
              <div className={`${box} w-[300px]`} style={style}>
                <p className="font-semibold text-white">Validator scrutiny</p>
                <p className="mt-0.5 text-[10.5px] text-[#b8a9ff]">kode, bukan model</p>
                <p className="mt-1.5 leading-snug text-[#d3d8de]">Memeriksa di akhir setiap fase apa yang ditinggalkan fase itu: setiap angka bersumber, setiap tugas punya bukti, setiap cakupan dijawab.</p>
                {L.scrut[1] > 0 && <p className="mt-1.5 text-[10.5px] tabular-nums text-[#8f99a8]">{L.scrut[0]}/{L.scrut[1]} cek lolos sejauh ini</p>}
              </div>
            );
            const a = roster.find((x) => x.key === hover.key);
            if (!a) return null;
            const st = a.jenjang === "peran" ? roleState(a.key) : L.st[a.key];
            const lead = a.induk ? roster.find((x) => x.key === a.induk)?.name : null;
            const what = fungsi(a);
            return (
              <div className={`${box} w-[320px]`} style={style}>
                <p className="font-semibold leading-snug text-white">{a.name}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-[#abb3bf]">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: LINI[a.lini]?.color ?? "#8f99a8" }} />
                  {LINI[a.lini]?.label ?? a.lini} · {a.key === "redaksi" ? "meja redaksi (kode)" : LEVEL[a.jenjang] ?? a.jenjang}{lead ? ` · dipimpin ${lead}` : ""}
                </p>
                <p className="mt-1.5 leading-snug text-[#e5e8eb]">{what}</p>
                {a.peran && a.peran !== what && <p className="mt-1 line-clamp-3 leading-snug text-[#8f99a8]">Tugasnya: {a.peran}</p>}
                <p className="mt-1.5 flex flex-wrap gap-x-2 border-t border-white/[.06] pt-1.5 text-[10.5px] tabular-nums text-[#abb3bf]">
                  <span>{modelName(a.model)}</span><span>· {STATE_LABEL[st ?? ""] ?? "belum bekerja"}</span>
                  {!!L.calls[a.key] && <span>· {L.calls[a.key]} panggilan tool</span>}
                  {!!L.rows[a.key] && <span>· {idn(L.rows[a.key])} baris dibaca</span>}
                  {!!L.tags[a.key] && <span>· {L.tags[a.key]} tag</span>}
                </p>
              </div>
            );
          })()}
          {roster.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[10.5px] text-[#8f99a8]">
              {Object.entries(LINI).filter(([k]) => roster.some((a) => a.lini === k)).map(([k, v]) => <span key={k} className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: v.color }} />{v.label}</span>)}
              <span>· warna menyala = agen sedang bekerja (berdenyut) · cincin kuning putus-putus = antre · redup + cincin hijau = selesai · merah = gagal · kilat putih = satu interaksi · titik bergerak = baca data, tag (warna kekuatan), serah-terima, putusan</span>
            </div>
          )}
        </div>

        {/* the interaction log, or what was clicked */}
        <aside className={`flex min-h-0 shrink-0 flex-col bg-[#1c2127] ${stacked ? "h-[260px] w-full border-t border-black/30" : embedded ? "relative w-[380px] border-l border-black/30" : "w-[380px] border-l border-black/30 max-xl:h-[360px] max-xl:w-full max-xl:border-l-0 max-xl:border-t"}`}>
          <div className={embedded && !stacked ? "absolute inset-0 flex min-h-0 flex-col" : "contents"}>
          {focus && (
            <div className="max-h-[50%] shrink-0 overflow-y-auto border-b border-white/5 p-3">
              <div className="mb-1 flex items-start gap-2">
                <p className="min-w-0 flex-1 text-[13px] font-semibold text-white">{focus.card ? cardText(CARDS.find((c) => c.key === focus.card) ?? CARDS[0]).label : focus.agent === "scrutiny" ? "Validator scrutiny (kode)" : selAgent?.name ?? focus.agent}</p>
                <button onClick={() => setFocus(null)} className="rounded p-0.5 text-[#8f99a8] hover:bg-white/10"><Icon name="x" className="h-3.5 w-3.5" /></button>
              </div>
              {focus.agent && focus.agent !== "scrutiny" && selAgent && (
                <div className="space-y-1 text-[11px] text-[#c5cbd3]">
                  <p>{selAgent.peran}</p>
                  <p className="text-[#8f99a8]">{LINI[selAgent.lini]?.label ?? selAgent.lini} · {modelName(selAgent.model)} · {STATE_LABEL[L.st[selAgent.key] ?? ""] ?? "belum bekerja"} · {L.calls[selAgent.key] ?? 0} panggilan tool · {idn(L.rows[selAgent.key])} baris dibaca · {L.tags[selAgent.key] ?? 0} tag</p>
                  {selAgent.instans_dari && <p className="text-[#8f99a8]">instans dari peran {selAgent.instans_dari === "red_team" ? "red team" : "penyidik"}: dibentuk saat ada kasus di antrean, bukan agen tetap</p>}
                </div>
              )}
              {focus.agent === "scrutiny" && <p className="text-[11px] text-[#c5cbd3]">Validator tanpa model: kode yang memeriksa apa yang ditinggalkan setiap fase di shared state (serah-terima, bukti tag, rujukan hasil, kontrak). Sejauh ini {L.scrut[0]}/{L.scrut[1]} cek lolos.</p>}
              {focus.card === "indikasi" && (
                <div className="space-y-1 text-[11px] text-[#c5cbd3]">
                  <p>Indikasi masuk dari dua sumber: penanda otomatis lapisan semantik ({L.auto.toLocaleString("id-ID")} tag aturan) dan agen yang menandai dengan bukti hasil bacaannya sendiri ({L.tagN.toLocaleString("id-ID")} tag). Kekuatan dihitung dari sumbernya; yang kuat ditandai Rahasia.</p>
                  <ul className="space-y-0.5">{Object.entries(L.modes).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([m, n]) => <li key={m} className="flex"><span className="truncate">{m}</span><span className="ml-auto tabular-nums text-white">{n}</span></li>)}</ul>
                </div>
              )}
              {focus.card === "ml" && v3 && (
                <div className="space-y-1 text-[11px] text-[#c5cbd3]">
                  <p>Mesin, bukan agen: arsitektur v3 (Model 1 graph + tetangga, 4 spesialis keluarga Permenkes, rule route, network rule) sudah menilai setiap klaim di profil data v3. Agen membaca ringkasan dan work list per kelompok modus, lalu membuktikan sendiri sebelum menandai.</p>
                  {L.v3 && <p className="text-white">{idn(L.v3.klaim)} klaim dinilai · {idn(L.v3.ditandai)} ditandai v3 · {idn(L.v3.berisiko)} klaim berisiko · {idn(L.v3.faskes)} faskes</p>}
                  {famV3.length > 0 && <ul className="space-y-0.5">{famV3.map((x) => <li key={String(x.famili)} className="flex"><span className="truncate">{String(x.nama)}</span><span className="ml-auto tabular-nums text-white">{idn(x.klaim)}</span></li>)}</ul>}
                  <p className="text-[#8f99a8]">Agen sejauh ini membaca {idn(L.rowsN)} baris hasil tool{L.objek ? ` dan mengagregasi ${idn(L.objek)} objek lewat ukur` : ""} (kumulatif: baca ulang ikut terhitung).</p>
                </div>
              )}
              {focus.card === "ml" && !v3 && (
                <div className="space-y-1 text-[11px] text-[#c5cbd3]">
                  <p>Sub-agen teknik ML (supervised; label nyata = klaim yang dikoreksi verifikator) masing-masing menjalankan tekniknya; faskes yang disepakati banyak teknik menjadi tag konsensus ML.</p>
                  <ul className="space-y-0.5">{techs.map((a) => <li key={a.key} className="flex"><span>{a.name.replace("Sub-agen ", "")}</span><span className="ml-auto" style={{ color: L.st[a.key] === "selesai" ? LINI.ml.color : "#8f99a8" }}>{STATE_LABEL[L.st[a.key] ?? ""] ?? "belum"}</span></li>)}</ul>
                  {L.ml && <p className="text-white">Konsensus: {L.ml.teknik} teknik, {L.ml.faskes} faskes · kuat {L.ml.tag?.kuat ?? 0}, sedang {L.ml.tag?.sedang ?? 0}, lemah {L.ml.tag?.lemah ?? 0}</p>}
                </div>
              )}
              {focus.card === "box" && (
                <div className="space-y-1 text-[11px] text-[#c5cbd3]">
                  {L.box ? groups.map(([g, v]) => (
                    <p key={g}><b style={{ color: GROUP_COLOR[g] ?? "#d3d8de" }}>{g}</b> · {v.faskes} faskes · {rp(Number(v.kerugian_rp ?? 0))} <span className="text-[#8f99a8]">— {v.arti}</span></p>
                  )) : <p>Box dihitung di fase karantina, setelah semua tag lapangan masuk.</p>}
                </div>
              )}
              {focus.card === "keputusan" && (
                <div className="space-y-1 text-[11px] text-[#c5cbd3]">
                  <p>Penyidik merekomendasikan jalur per faskes (ditindak hanya bila Terstruktur, Sistematis dan Masif terpenuhi); manusia yang memutuskan di Box Karantina.</p>
                  <ul className="space-y-0.5">{L.log.filter((l) => l.kind === "keputusan" && l.key !== "partner").slice(-12).map((l) => <li key={l.i} className="truncate" title={l.text}>{l.text}</li>)}</ul>
                  <a href="/aip-jkn?tab=karantina" className="inline-block rounded bg-[#5b5fd6] px-2 py-0.5 text-white">Buka dashboard keputusan (Box Karantina)</a>
                </div>
              )}
              {focus.agent && (
                <ul className="mt-2 space-y-0.5 border-t border-white/5 pt-1.5 text-[10.5px]">
                  {L.log.filter((l) => l.key === focus.agent).slice(-25).map((l) => <li key={l.i} className="text-[#c5cbd3]"><span className="tabular-nums text-[#6b7480]">{mmss(l.rt)} </span>{l.text}</li>)}
                  {!L.log.some((l) => l.key === focus.agent) && <li className="text-[#8f99a8]">Belum ada interaksi sampai titik ini.</li>}
                </ul>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-1 border-b border-white/5 px-2 py-1.5">
            <p className="mr-1 self-center text-[11px] font-semibold text-white">Log interaksi</p>
            {KINDS.map(([k, label]) => <button key={k} onClick={() => setKind(k)} className={`rounded px-1.5 py-0.5 text-[10px] ${kind === k ? "bg-white/15 text-white" : "text-[#abb3bf] hover:bg-white/10"}`}>{label}</button>)}
          </div>
          <div ref={logBox} onScroll={(e) => { const d = e.currentTarget; stick.current = d.scrollHeight - d.scrollTop - d.clientHeight < 30; }}
            className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 py-1 font-mono text-[10.5px]">
            {shown.map((l) => l.kind === "fase" && !l.key ? (
              <p key={l.i} className="py-1 text-center text-[10px] font-semibold uppercase tracking-wide text-[#c5cbd3]">— {l.text} —</p>
            ) : (
              <button key={l.i} onClick={() => { seek(l.at); if (l.key) setFocus({ agent: l.key }); }} title="lompat ke momen ini"
                className={`flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left hover:bg-white/[.06] ${focus?.agent && focus.agent === l.key ? "bg-white/[.05]" : ""}`}>
                <span className="shrink-0 tabular-nums text-[#6b7480]" title="waktu nyata sejak penugasan dimulai">{mmss(l.rt)}</span>
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: l.color }} />
                <span className={`min-w-0 ${l.kind === "galat" ? "text-[#ffb4b4]" : l.kind === "keputusan" ? "text-[#ffd8a8]" : l.kind === "tag" ? "text-[#e5e8eb]" : "text-[#abb3bf]"}`}>
                  {l.who && <b className="font-semibold" style={{ color: l.color }}>{l.who} </b>}{l.text}
                </span>
              </button>
            ))}
            {!shown.length && <p className="p-3 text-center font-sans text-[#8f99a8]">{events.length ? "Tekan Putar: setiap interaksi agen muncul di sini." : "—"}</p>}
          </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
