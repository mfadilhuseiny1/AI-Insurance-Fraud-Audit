"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { modelName, usd, type Rec } from "@/components/aip/aipRun";
import { useTampilBiaya } from "@/components/aip/biaya";
import { fraud, type FirmConfig, type Project, type ProjectForm as ProjectFields, type ReviewSummary, type Team, type V3Status } from "@/components/aip/fraudApi";

/* Projects of the AI Agent Swarm (api/aip/konsultan.py, the user 2026-10-24: "Create new project", a tab of its own, empty
   and good-looking, with the button that starts an engagement). A project holds what it audits; the user (2026-10-28:
   "gausah banyak konfigurasi … gausah konfigure deepseek glm dll", "keep it simple for user") sets a name and a focus
   only — the models, agents at once and cost limit are the firm's defaults (the API still takes them), the data
   source is a readiness line, not a setting. */

const field = "w-full rounded-sm border border-white/15 bg-[#111418] px-2 py-1.5 text-[12px] text-[#e5e8eb] outline-none focus:border-[#5b5fd6]";
/** A cost limit in whole dollars where it is whole ("$20", not "$20.000", which reads as twenty thousand in Indonesian). */
export const usdLimit = (n?: number | null) => (n == null ? "—" : `$${Number.isInteger(n) ? n : n.toFixed(2)}`);
const modelLabel = (cfg: FirmConfig | null, id?: string) => cfg?.model.find((m) => m.id === id)?.label ?? modelName(id);
/** A project's seat models; the defaults for a seat it does not set (and for the engagements from before projects). */
const seatsOf = (cfg: FirmConfig | null, p?: Project | null): Record<string, string> =>
  Object.fromEntries((cfg?.kursi ?? []).map((s) => [s.kursi, p?.model?.[s.kursi] || s.default]));

/** A slowly turning network on a sphere behind a glowing ring: the empty project's mark. Canvas, no data; still for
 *  reduced motion; faster while `busy`. */
export function NetworkOrb({ size = 340, busy = false }: { size?: number; busy?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr; c.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // points on a sphere (golden spiral, a little off it), each joined to its three nearest
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const N = 96;
    const pts = Array.from({ length: N }, (_, i) => {
      const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), th = i * 2.399963, k = 0.86 + rnd() * 0.34;
      return [Math.cos(th) * r * k, y * k, Math.sin(th) * r * k];
    });
    const seen = new Set<string>();
    const edges: [number, number][] = [];
    pts.forEach((p, i) => {
      pts.map((q, j) => [j, (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2])
        .filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]).slice(0, 3)
        .forEach(([j]) => { const key = i < j ? `${i}-${j}` : `${j}-${i}`; if (!seen.has(key)) { seen.add(key); edges.push([i, j]); } });
    });
    const R = size * 0.34, cx = size / 2, cy = size / 2, tilt = 0.42;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const t0 = performance.now();
    const draw = (now: number) => {
      const t = (now - t0) / 1000, a = 0.6 + t * (busy ? 0.32 : 0.1), spin = t * 0.25;
      ctx.clearRect(0, 0, size, size);
      const haze = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.45);
      haze.addColorStop(0, "rgba(91,95,214,0.10)"); haze.addColorStop(0.7, "rgba(91,95,214,0.04)"); haze.addColorStop(1, "rgba(91,95,214,0)");
      ctx.fillStyle = haze; ctx.fillRect(0, 0, size, size);
      // the ring, brighter on the side the light turns to
      const ringR = R * 0.8, lx = Math.cos(spin) * ringR, ly = Math.sin(spin) * ringR;
      const light = ctx.createLinearGradient(cx + lx, cy + ly, cx - lx, cy - ly);
      light.addColorStop(0, "rgba(176,156,255,0.95)"); light.addColorStop(0.45, "rgba(124,108,240,0.4)"); light.addColorStop(1, "rgba(91,95,214,0.06)");
      ctx.save();
      ctx.shadowColor = "rgba(139,120,255,0.85)"; ctx.shadowBlur = 30; ctx.strokeStyle = light; ctx.lineWidth = 10;
      ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = light; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, ringR - 7, 0, Math.PI * 2); ctx.stroke();
      // the network: depth fades the back half
      const P = pts.map(([x, y, z]) => {
        const x1 = x * Math.cos(a) - z * Math.sin(a), z1 = x * Math.sin(a) + z * Math.cos(a);
        const y2 = y * Math.cos(tilt) - z1 * Math.sin(tilt), z2 = y * Math.sin(tilt) + z1 * Math.cos(tilt), s = 3 / (3 - z2);
        return [cx + x1 * R * s, cy + y2 * R * s, (z2 + 1) / 2];
      });
      ctx.lineWidth = 0.8;
      for (const [i, j] of edges) {
        ctx.strokeStyle = `rgba(226,230,240,${0.04 + ((P[i][2] + P[j][2]) / 2) * 0.36})`;
        ctx.beginPath(); ctx.moveTo(P[i][0], P[i][1]); ctx.lineTo(P[j][0], P[j][1]); ctx.stroke();
      }
      for (const [x, y, d] of P) {
        ctx.fillStyle = `rgba(240,242,250,${0.22 + d * 0.72})`;
        ctx.beginPath(); ctx.arc(x, y, 0.9 + d * 1.7, 0, Math.PI * 2); ctx.fill();
      }
      if (!still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size, busy]);
  return <canvas ref={ref} aria-hidden className="pointer-events-none max-w-[80vw]" style={{ width: size, aspectRatio: "1 / 1" }} />;
}

/** Whether the data is ready, in one line — the only thing a user may need to know before starting; the models and the
 *  rest are the firm's defaults, named in the tooltip. */
export function ConfigChips({ cfg, project, onEdit }: { cfg: FirmConfig | null; project: Project | null; onEdit?: () => void }) {
  if (!cfg) return null;
  const seats = seatsOf(cfg, project);
  const src = cfg.sumber;
  const models = cfg.kursi.map((s) => modelLabel(cfg, seats[s.kursi])).filter((v, i, a) => a.indexOf(v) === i).join(", ");
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11.5px]">
      <span className={src.siap ? "text-[#7ee2c0]" : "text-[#ffb4b4]"} title={src.tipe.map((t) => `${t.tipe}: ${t.objek.toLocaleString("id-ID")} objek`).join("\n")}>
        {src.siap ? "✓ Data siap" : `✗ Data belum siap: ${src.kurang.join(", ")}`}
      </span>
      <span className="text-[#8f99a8]" title={`Model: ${models}`}>Model AI bawaan</span>
      {onEdit && <button onClick={onEdit} className="text-[#abb3bf] underline-offset-2 hover:text-white hover:underline">Ubah nama atau fokus</button>}
    </div>
  );
}

/** A project's own tab before its first engagement (or no project yet): the network, what the project audits, its
 *  settings, the button that starts an engagement. */
export function ProjectHome({ cfg, project, count, busy, running, onStart, onCreate, onEdit }: { cfg: FirmConfig | null; project: Project | null;
  count: number; busy: boolean; running: boolean; onStart: () => void; onCreate: () => void; onEdit?: () => void }) {
  return (
    <div className="flex min-h-[560px] flex-1 flex-col items-center justify-center bg-[radial-gradient(ellipse_at_50%_38%,#262c3a_0%,#1a1e24_55%,#15181d_100%)] px-4 py-8">
      <NetworkOrb busy={busy || running} />
      {project ? (
        <>
          <p className="-mt-3 text-[10.5px] uppercase tracking-[0.2em] text-[#8f99a8]">Proyek AI Agent Swarm</p>
          <h2 className="mt-1 text-center text-[20px] font-semibold text-white">{project.nama}</h2>
          <p className="mt-1.5 line-clamp-3 max-w-[640px] text-center text-[12px] leading-relaxed text-[#abb3bf]">{project.brief}</p>
          {project.fokus && <p className="mt-1 max-w-[640px] text-center text-[11.5px] text-[#c9c0ff]">Fokus: {project.fokus}</p>}
          <div className="mt-4"><ConfigChips cfg={cfg} project={project} onEdit={onEdit} /></div>
          <button disabled={busy || running || (cfg ? !cfg.sumber.siap : false)} onClick={onStart}
            title={running ? "satu penugasan sedang berjalan" : cfg && !cfg.sumber.siap ? `sumber data belum siap: ${cfg.sumber.kurang.join(", ")}` : undefined}
            className="mt-6 flex items-center gap-2 rounded-md bg-[#5b5fd6] px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_0_24px_rgba(91,95,214,0.45)] hover:bg-[#6a6ee0] disabled:opacity-40 disabled:shadow-none">
            <Icon name="play" className="h-3.5 w-3.5" />Mulai penugasan baru
          </button>
          <p className="mt-2 max-w-[520px] text-center text-[11px] text-[#8f99a8]">
            {count ? `${count} penugasan di proyek ini (daftar di kiri). ` : "Belum ada penugasan di proyek ini. "}
            Satu penugasan sekitar satu jam; hasilnya mengisi Box Karantina dan buku besar indikasi, dan menjadi sumber jawaban tab Agen.
          </p>
        </>
      ) : (
        <>
          <h2 className="-mt-3 text-[20px] font-semibold text-white">Belum ada proyek</h2>
          <p className="mt-1.5 max-w-[520px] text-center text-[12px] leading-relaxed text-[#abb3bf]">
            Beri nama proyek, lalu mulai penugasan. Data, model AI dan pengaturan lainnya sudah disiapkan.
          </p>
          <button onClick={onCreate} className="mt-6 flex items-center gap-2 rounded-md bg-[#5b5fd6] px-5 py-2.5 text-[13px] font-semibold text-white shadow-[0_0_24px_rgba(91,95,214,0.45)] hover:bg-[#6a6ee0]">
            <Icon name="plus" className="h-3.5 w-3.5" />Buat proyek baru
          </button>
        </>
      )}
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

/** A new project, or its name and focus changed (the user, 2026-10-28: "keep it simple for user"): a name, an optional
 *  focus, the audit scope folded (the default brief); the models, agents at once and cost limit stay the firm's defaults
 *  — a project made before keeps the ones it was saved with. */
export function ProjectFormDialog({ cfg, project, onSaved, onClose }: { cfg: FirmConfig | null; team?: Team | null; project?: Project | null;
  onSaved: (p: Project) => void; onClose: () => void }) {
  const [nama, setNama] = useState(project?.nama ?? "");
  const [brief, setBrief] = useState(project?.brief ?? cfg?.brief ?? "");
  const [fokus, setFokus] = useState(project?.fokus ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const bad = nama.trim().length < 3 ? "Beri nama proyek (paling sedikit 3 huruf)." : "";
  const save = async () => {
    setBusy(true); setErr("");
    const f: ProjectFields = { nama: nama.trim(), brief: brief.trim(), fokus: fokus.trim(), batas_usd: project?.batas_usd ?? null,
      paralel: project?.paralel ?? cfg?.paralel.default ?? 8, model: seatsOf(cfg, project) };
    try { onSaved(project ? await fraud.updateProject(project.id, f) : await fraud.createProject(f)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const label = "mt-3 block text-[11.5px] font-medium text-[#d3d8de]";
  return (
    <Modal id="proyek-judul" onClose={onClose}>
      <form className="w-full max-w-[560px] rounded-lg border border-white/10 bg-[#1c2127] p-5 shadow-2xl" onSubmit={(e) => { e.preventDefault(); if (!bad) save(); }}>
        <p id="proyek-judul" className="text-[15px] font-semibold text-white">{project ? `Ubah proyek · ${project.nama}` : "Proyek baru"}</p>
        <label htmlFor="pr-nama" className={label}>Nama proyek</label>
        <input id="pr-nama" autoFocus value={nama} onChange={(e) => setNama(e.target.value)} maxLength={120} placeholder="mis. Audit FKRTL 2025 — Jawa" className={`${field} mt-1`} />
        <label htmlFor="pr-fokus" className={label}>Fokus <span className="font-normal text-[#8f99a8]">(opsional)</span></label>
        <input id="pr-fokus" value={fokus} onChange={(e) => setFokus(e.target.value)} maxLength={600} placeholder="mis. Jawa Tengah dan Jawa Timur; modus klaim ganda dan upcoding" className={`${field} mt-1`} />
        <details className="mt-3">
          <summary className="cursor-pointer text-[11.5px] text-[#abb3bf] hover:text-white">Lingkup audit <span className="text-[#8f99a8]">(bawaan; ubah bila perlu)</span></summary>
          <textarea id="pr-brief" aria-label="Lingkup audit" value={brief} onChange={(e) => setBrief(e.target.value)} rows={5} maxLength={4000} className={`${field} mt-1.5 resize-y leading-relaxed`} />
        </details>
        <div className="mt-3"><ConfigChips cfg={cfg} project={project ?? null} /></div>
        <div className="mt-5 flex items-center justify-end gap-2">
          {(bad && nama) || err ? <p className="mr-auto text-[11.5px] text-[#ffb4b4]">{err || bad}</p> : null}
          <button type="button" onClick={onClose} className="rounded-sm border border-white/15 px-3 py-1.5 text-[12px] text-[#d3d8de] hover:bg-white/10">Batal</button>
          <button type="submit" disabled={busy || !!bad || !cfg} className="flex items-center gap-1 rounded-sm bg-[#5b5fd6] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#6a6ee0] disabled:opacity-40">
            <Icon name={project ? "save" : "plus"} className="h-3 w-3" />{busy ? "Menyimpan…" : project ? "Simpan" : "Buat proyek"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// the orchestration the start form chooses unless the user picks another (the user, 2026-10-30: Blu 1.1 "(Default)"); the API's
// own default stays Blu 1.0, so a caller that names no version never starts the clinical review unasked
const DEFAULT_VERSION = "1.1";
/** Whether Blu 1.1 or 1.3 can start, in one word (the user, 2026-10-30: "gausah show … cuman bilang ready aja"): "Siap", or why
 *  not — the calibration failed (the engagement would then work as Blu 1.0), the claims cannot be read, or (Blu 1.3) the
 *  OpenAI key is missing (api/aip/telaah.py). */
function ReviewReady({ cfg, project, versi }: { cfg: FirmConfig | null; project: Project; versi: string }) {
  const seats = seatsOf(cfg, project);
  const [sum, setSum] = useState<ReviewSummary | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    // Blu 1.3's seats are the API's own (OpenAI Decisions); Blu 1.1's the project's
    fraud.reviewSummary(versi === "1.3" ? { versi } : { saring: seats.telaah_saring, periksa: seats.telaah_periksa }, project.batas_usd)
      .then((r) => { setErr(""); setSum(r); }).catch((e) => setErr((e as Error).message));
  }, [project.id, cfg, versi]); // eslint-disable-line react-hooks/exhaustive-deps -- seats follow the project and config
  const k = sum?.kalibrasi;
  const failed = !!(k && sum?.kalibrasi_berlaku && !k.lolos);
  return (
    <p className="mt-2 text-[11.5px]">
      {err ? <span className="text-[#ffb4b4]">✗ Belum siap: {err}</span>
        : !sum ? <span className="text-[#8f99a8]">Memeriksa…</span>
        : failed ? <span className="text-[#fbd38d]" title={(k?.alasan ?? []).join("; ")}>✗ Belum siap: kalibrasi tidak lolos (akan bekerja seperti Blu 1.0)</span>
        : <span className="text-[#7ee2c0]">✓ Siap</span>}
    </p>
  );
}

/** Whether Blu 3.0 can start: the Nexus types hold the v3 data profile (testing/blu3_profil.py) and its scoring summary, and
 *  how big its firm is (api/aip/blu3.py). */
function V3Ready() {
  const [st, setSt] = useState<V3Status | null>(null);
  const [agents, setAgents] = useState<number | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fraud.v3Status().then((r) => { setErr(""); setSt(r); }).catch((e) => setErr((e as Error).message));
    fraud.team("3.0").then((t) => setAgents(t.jumlah_agen)).catch(() => setAgents(null));
  }, []);
  const r = st?.ringkasan;
  const ok = st?.profil.aktif === "v3" && st.profil.paket && !!r;
  return (
    <div className="mt-2 text-[11.5px]">
      {err ? <span className="text-[#ffb4b4]">✗ Belum siap: {err}</span>
        : !st ? <span className="text-[#8f99a8]">Memeriksa…</span>
        : !ok ? <span className="text-[#fbd38d]">✗ Belum siap: profil data Nexus belum v3</span>
        : <span className="text-[#7ee2c0]">✓ Siap · data v3 sintetis: {r.klaim.toLocaleString("id-ID")} klaim, {r.ditandai.toLocaleString("id-ID")} ditandai v3
          {agents ? ` · ${agents} agen` : ""}</span>}
    </div>
  );
}

/** Before an engagement of a project runs (the user, 2026-10-24: a form, not a click that starts it): its name and focus,
 *  and the AI orchestration (the user, 2026-10-30: Blu 1.0, or Blu 1.1 with the clinical review first); the rest is the
 *  project's configuration, shown, not asked again. */
export function StartForm({ cfg, project, count, agents, last, busy, err, onStart, onClose }: { cfg: FirmConfig | null; project: Project; count: number;
  agents?: number; last?: Rec; busy: boolean; err: string; onStart: (f: { nama: string; fokus: string; versi: string }) => void; onClose: () => void }) {
  const tampilBiaya = useTampilBiaya();
  const [nama, setNama] = useState(`${project.nama} · penugasan ${count + 1}`);
  const [fokus, setFokus] = useState(project.fokus ?? "");
  const [versi, setVersi] = useState(DEFAULT_VERSION);
  const versions = Object.entries(cfg?.versi ?? { "1.0": { nama: "Blu 1.0", ringkas: "AI Agent Swarm", tambahan: null } });
  const bad = nama.trim().length < 3 ? "Beri nama penugasan (paling sedikit 3 huruf)." : !cfg ? "Memuat konfigurasi proyek…"
    : !cfg.sumber.siap ? `Sumber data belum siap: ${cfg.sumber.kurang.join(", ")}.` : "";
  const mins = last?.created_at && last?.finished_at ? Math.round((Date.parse(String(last.finished_at)) - Date.parse(String(last.created_at))) / 60000) : null;
  return (
    <Modal id="mulai-judul" onClose={onClose}>
      <form className="w-full max-w-[640px] rounded-lg border border-white/10 bg-[#1c2127] p-5 shadow-2xl"
        onSubmit={(e) => { e.preventDefault(); if (!bad) onStart({ nama: nama.trim(), fokus: fokus.trim(), versi }); }}>
        <p id="mulai-judul" className="text-[15px] font-semibold text-white">Penugasan baru · {project.nama}</p>
        <p className="mt-1 text-[11.5px] text-[#abb3bf]">
          {agents ? `${agents} agen` : "Seluruh firma"} bekerja di data JKN{mins ? ` sekitar ${mins} menit` : ""}{tampilBiaya && last ? `; penugasan terakhir berbiaya ${usd(last.spent_usd)}` : ""}.
          Hasilnya memperbarui Box Karantina dan buku besar indikasi, dan menjadi sumber jawaban tab Agen.
        </p>
        <label htmlFor="pg-nama" className="mt-4 block text-[11.5px] font-medium text-[#d3d8de]">Nama penugasan</label>
        <input id="pg-nama" autoFocus value={nama} onChange={(e) => setNama(e.target.value)} maxLength={120} className={`${field} mt-1`} />
        <label htmlFor="pg-fokus" className="mt-3 block text-[11.5px] font-medium text-[#d3d8de]">Fokus penugasan ini <span className="font-normal text-[#8f99a8]">(opsional; dari proyek)</span></label>
        <input id="pg-fokus" value={fokus} onChange={(e) => setFokus(e.target.value)} maxLength={600} placeholder="mis. Jawa Tengah dan Jawa Timur; modus klaim ganda dan upcoding" className={`${field} mt-1`} />
        <p className="mt-3 text-[11.5px] font-medium text-[#d3d8de]" id="pg-versi">Orkestrasi AI</p>
        <div role="radiogroup" aria-labelledby="pg-versi" className={`mt-1 grid gap-2 ${versions.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
          {versions.map(([id, v]) => (
            <button key={id} type="button" role="radio" aria-checked={versi === id} onClick={() => setVersi(id)}
              className={`rounded border p-2 text-left ${versi === id ? "border-[#9d8cff] bg-[#9d8cff]/10" : "border-white/15 hover:bg-white/5"}`}>
              <span className="block text-[12.5px] font-semibold text-white">
                {v.nama}{id === DEFAULT_VERSION && <span className="ml-1 text-[10.5px] font-normal text-[#c9c0ff]">(Default)</span>}
              </span>
              <span className="mt-0.5 block text-[10.5px] leading-snug text-[#abb3bf]">{v.ringkas}</span>
            </button>
          ))}
        </div>
        {(versi === "1.1" || versi === "1.3") && <ReviewReady key={versi} cfg={cfg} project={project} versi={versi} />}
        {versi === "3.0" && <V3Ready />}
        <div className="mt-4 flex"><ConfigChips cfg={cfg} project={project} /></div>
        {(bad && nama) || err ? <p className="mt-3 text-[11.5px] text-[#ffb4b4]">{err || bad}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-sm border border-white/15 px-3 py-1.5 text-[12px] text-[#d3d8de] hover:bg-white/10">Batal</button>
          <button type="submit" disabled={busy || !!bad} className="flex items-center gap-1 rounded-sm bg-[#5b5fd6] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#6a6ee0] disabled:opacity-40">
            <Icon name="play" className="h-3 w-3" />{busy ? "Membentuk firma…" : `Mulai penugasan ${versions.find(([id]) => id === versi)?.[1].nama ?? ""}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
