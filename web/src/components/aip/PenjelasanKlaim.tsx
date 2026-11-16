"use client";

// The AI Agent Swarm Branch case file, laid out as /testing lays out a flagged claim (the user, 2026-11-14: "tiap klaim yang
// indikasi fraud ada penjelasan 1 paragraf ... coba lihat /testing", "semuanya whitebox, ga ada blackbox", "all audit result can be
// explained to executive level ... each case of fraud needs evidence-based reasoning to justify"):
//   header        the mode found (Permenkes 16/2019), the claim, the screening model's score against its two thresholds;
//   tab 1         the claim network (GrafKlaim) beside the plain explanation: why, the modes with their evidence, the evidence
//                 one fact per line, what the verifier does, when the claim could still be fine, the decision path in words and
//                 what pushed the model's score (the claim itself / its graph neighbours / the fraud mechanisms), the verifier's
//                 decision buttons;
//   tab 2         the technical detail: every step with its numbers and thresholds, the model's strongest drivers, each agent;
//   tab 3         the data lineage (JejakKlaim; the user, 2026-11-14: "tambahin data lineage di tab baru disini"): the claim from its
//                 raw row to the figure in this case file, each layer with the claim's own values (g.jejak, testing/graf_cabang.py);
//   IoT tab       only for a claim with a monitored medical device (g.iot, testing/iot_cabang.py; the user, 2026-11-15: "add also IoT tab
//                 in case the fraud is about medical device use time"), right after the first tab, a red dot when the device's record
//                 does not match the bill: the usage dashboard, the binding, the tariff impact and the tamper-proof evidence (IotKlaim).
// The text is written by code from the case's own facts (testing/penjelasan_cabang.py), no LLM. Synthetic data.

import { useState } from "react";
import { GrafKlaim, type GrafKasus } from "./GrafKlaim";
import { IotKlaim, hasilIot, type IotKasus } from "./IotKlaim";
import { JejakKlaim } from "./JejakKlaim";

const persen = (v: number, d = 1) => `${(100 * v).toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d })}%`;
// "higher than x% of normal claims": never 100% (one more decimal near the top, as the explanation text writes it)
const persenNormal = (v: number) => (v >= 0.9995 ? `${Math.min(99.99, 100 * v).toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%` : persen(v));
const KEP: Record<string, [string, string]> = { TAHAN: ["ditahan", "#ff7d9c"], PERIKSA: ["perlu diperiksa", "#f2b35a"], DIBERSIHKAN: ["dibersihkan tim agen AI", "#8e9cad"] };
const YAKIN: Record<string, string> = { tinggi: "#ff7d9c", sedang: "#f2b35a", rendah: "#8e9cad" };

function Judul({ ikon, children }: { ikon: React.ReactNode; children: React.ReactNode }) {
  return <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#8e9cad]"><span aria-hidden="true">{ikon}</span>{children}</p>;
}

function Bar({ label, nilai, teks, warna, tanda }: { label: string; nilai: number; teks: string; warna: string; tanda?: number[] }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11.5px]"><span className="text-[#c3ccd7]">{label}</span><b className="tabular-nums text-white">{teks}</b></div>
      <div className="relative h-1.5 rounded-full bg-[#202b38]">
        <div className="h-1.5 rounded-full" style={{ width: `${Math.max(2, Math.min(100, 100 * nilai))}%`, background: warna }} />
        {tanda?.map((t) => <span key={t} className="absolute top-[-2px] h-2.5 w-px bg-white/70" style={{ left: `${100 * t}%` }} />)}
      </div>
    </div>
  );
}

export function PenjelasanKlaim({ g, model, kc, keputusan, meta, onBuka, teknis, tindakan, iotLaporan }: {
  g: GrafKasus; model: string; kc: string; keputusan: "TAHAN" | "PERIKSA" | "DIBERSIHKAN"; meta: { id: string; rs: string; kode: string; tgl: string };
  onBuka: (id: string) => void; teknis: React.ReactNode; tindakan: React.ReactNode;
  /** the report's copy of the claim's IoT evidence, for a graph built before the IoT layer */
  iotLaporan?: IotKasus;
}) {
  const [tab, setTab] = useState<"utama" | "iot" | "teknis" | "jejak">("utama");
  const p = g.penjelasan;
  const iot = g.iot ?? iotLaporan;
  const hi = iot ? hasilIot(iot.hasil) : null;
  const tabs: [typeof tab, string][] = [["utama", "Graph dan penjelasan"], ...(iot ? [["iot", "IoT alat medis"] as [typeof tab, string]] : []), ["teknis", "Detail teknis"], ["jejak", "Jejak data"]];
  const [kepNama, kepWarna] = KEP[keputusan];
  const s = p.skor;
  const bersih = keputusan === "DIBERSIHKAN";
  return (
    <div className="border-t border-white/[.06]">
      {/* header: the mode, the claim, the score */}
      <div className="flex flex-wrap items-start gap-3 px-3 py-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: `${kepWarna}22`, color: kepWarna }} aria-hidden="true">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-semibold leading-snug" style={{ color: kepWarna }}>{bersih ? "Sempat ditandai: " : "Terindikasi: "}{p.modus.nama}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {p.jenis_fraud.map((j) => (
              <span key={j.kode} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]" style={{ background: `${YAKIN[j.keyakinan] ?? "#8e9cad"}22`, color: YAKIN[j.keyakinan] ?? "#c3ccd7" }}>
                {j.kode !== "-" && <b className="rounded bg-black/30 px-1 text-[10px]">{j.kode}</b>}{j.nama}
              </span>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-[#8e9cad]">{meta.id} · {meta.rs} · {meta.kode} · {meta.tgl} · <b className="text-[#e6ecf2]">keputusan: {kepNama}</b></p>
        </div>
        <div className="w-full max-w-[230px] text-right sm:w-auto">
          <p className="text-[24px] font-semibold tabular-nums text-white">{persen(s.model)}</p>
          <div className="relative mt-1 h-1.5 rounded-full bg-[#202b38]">
            <div className="h-1.5 rounded-full" style={{ width: `${Math.max(2, 100 * s.model)}%`, background: kepWarna }} />
            {[s.ambang_ragu, s.ambang_tahan].map((t) => <span key={t} className="absolute top-[-2px] h-2.5 w-px bg-white/80" style={{ left: `${100 * t}%` }} />)}
          </div>
          <p className="mt-1 text-[10.5px] text-[#8e9cad]">skor {model} · ragu ≥ {persen(s.ambang_ragu)} · tahan ≥ {persen(s.ambang_tahan)}</p>
          <p className="text-[10.5px] text-[#c3ccd7]">lebih berisiko daripada {persenNormal(s.di_atas_normal)} klaim normal</p>
        </div>
      </div>
      <div className="flex gap-1 border-b border-white/[.08] px-3" role="tablist">
        {tabs.map(([k, t]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] ${tab === k ? "border-[#7ea3ff] font-semibold text-[#7ea3ff]" : "border-transparent text-[#c3ccd7] hover:text-white"}`}>
            {t}{k === "iot" && iot?.hasil === "tidak_sesuai" && <span className="h-1.5 w-1.5 rounded-full bg-[#ff7d9c]" role="img" aria-label="tidak sesuai" />}</button>
        ))}
      </div>
      {tab === "iot" && iot ? (
        <div className="p-3"><IotKlaim iot={iot} klaim={{ id: meta.id, peserta: g.fokus.peserta_id }} /></div>
      ) : tab === "utama" || tab === "iot" ? (
        <div className="grid gap-4 p-3 xl:grid-cols-[minmax(0,1fr)_380px]">
          <GrafKlaim g={g} model={model} kc={kc} onBuka={onBuka} />
          <div className="space-y-4 xl:max-h-[640px] xl:overflow-y-auto xl:pr-1">
            {iot && hi && (
              <button onClick={() => setTab("iot")} className="w-full rounded-lg border px-3 py-2 text-left hover:bg-white/[.03]" style={{ borderColor: `${hi.warna}66`, background: `${hi.warna}10` }}>
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em]" style={{ color: hi.warna }}>{hi.tanda} Bukti IoT alat medis · {hi.label.toLowerCase()}</p>
                <p className="mt-0.5 text-[12.5px] leading-snug text-white">{iot.judul}</p>
                <p className="mt-0.5 text-[10.5px] text-[#8e9cad]">lihat tab IoT alat medis →</p>
              </button>
            )}
            <section className="space-y-1.5">
              <Judul ikon="✦">{bersih ? "Kenapa klaim ini sempat ditandai" : "Kenapa klaim ini terindikasi"}</Judul>
              <p className="text-[13px] leading-relaxed text-[#e6ecf2]">{p.paragraf}</p>
            </section>
            <section className="space-y-1.5 border-t border-white/[.06] pt-3">
              <Judul ikon="⚠">Jenis fraud (Permenkes 16/2019)</Judul>
              {p.jenis_fraud.map((j) => (
                <div key={j.kode + j.nama} className="rounded-lg border border-white/[.08] bg-[#151a1f] px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {j.kode !== "-" && <b className="rounded bg-[#ff7d9c]/15 px-1.5 text-[11px] text-[#ff9db3]">{j.kode}</b>}
                    <b className="text-[12.5px] text-white">{j.nama}</b>
                    <span className="ml-auto text-[10.5px]" style={{ color: YAKIN[j.keyakinan] ?? "#8e9cad" }}>keyakinan {j.keyakinan}</span>
                  </div>
                  <p className="mt-1 text-[11.5px] leading-snug text-[#c3ccd7]">{j.bukti}</p>
                </div>
              ))}
            </section>
            <section className="space-y-1.5 border-t border-white/[.06] pt-3">
              <Judul ikon="⌕">Bukti</Judul>
              <ul className="space-y-1.5">{p.bukti.map((b) => <li key={b} className="flex gap-2 text-[12px] leading-snug text-[#e6ecf2]"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#ff7d9c]" />{b}</li>)}</ul>
            </section>
            <section className="space-y-1.5 border-t border-white/[.06] pt-3">
              <Judul ikon="✓">Yang perlu dilakukan verifikator</Judul>
              <ol className="space-y-1.5">{p.langkah.map((l, i) => (
                <li key={l} className="flex gap-2 text-[12px] leading-snug text-[#e6ecf2]"><span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#1b2741] text-[10px] text-[#7ea3ff]">{i + 1}</span>{l}</li>))}
              </ol>
              <p className="text-[11px] leading-snug text-[#8e9cad]">{p.catatan}</p>
            </section>
            <section className="space-y-2 border-t border-white/[.06] pt-3">
              <Judul ikon="▥">Skor dan alur keputusan</Judul>
              <div className="flex flex-wrap items-center gap-1 text-[11px]">
                {p.alur.map((a, i) => (
                  <span key={a.label} className="flex items-center gap-1">
                    {i > 0 && <span className="text-[#8e9cad]">→</span>}
                    <span className="rounded-full border px-2 py-0.5" style={a.nyala ? { borderColor: "#ff7d9c99", color: "#ffd1dc" } : { borderColor: "rgba(255,255,255,.12)", color: "#c3ccd7" }}>
                      {a.label} <b className="text-white">{a.nilai}</b></span>
                  </span>
                ))}
              </div>
              <Bar label={`Skor ${model}`} nilai={s.model} teks={persen(s.model)} warna={kepWarna} tanda={[s.ambang_ragu, s.ambang_tahan]} />
              <Bar label="Dorongan skor dari tetangga graph (klaim pembanding)" nilai={p.dorongan.graph} teks={persen(p.dorongan.graph)} warna="#7ea3ff" />
              <Bar label="Dorongan skor dari klaim sendiri (termasuk pemeriksaan otomatis)" nilai={p.dorongan.klaim} teks={persen(p.dorongan.klaim)} warna="#7ea3ff" />
              <Bar label="Dorongan skor dari mekanisme fraud" nilai={p.dorongan.mekanisme} teks={persen(p.dorongan.mekanisme)} warna="#7ea3ff" />
              <div className="flex justify-between text-[11.5px]"><span className="text-[#c3ccd7]">Jaringan RS · berbagi peserta ±{g.cincin.hari} hari</span><b className="text-white">{g.cincin.rs_lain.length} RS</b></div>
              <div className="text-[11.5px]">
                <div className="flex justify-between"><span className="text-[#c3ccd7]">Pemeriksaan otomatis</span><b className="text-white">{p.pemeriksaan.length} temuan</b></div>
                {p.pemeriksaan.length > 0 && <p className="mt-0.5 text-[11px] leading-snug text-[#8e9cad]">{p.pemeriksaan.join(" · ")}</p>}
              </div>
            </section>
            <section className="border-t border-white/[.06] pt-3">{tindakan}</section>
          </div>
        </div>
      ) : tab === "jejak" ? (
        <div className="p-3">
          {g.jejak?.nodes?.length
            ? <JejakKlaim jejak={g.jejak} judul={meta.id} />
            : <p className="rounded border border-white/[.07] px-3 py-2 text-[11.5px] text-[#c3ccd7]">
                Jejak data belum dibuat untuk run ini. Bangun ulang graph klaim run ini (testing/graf_cabang.py) agar tab ini menampilkan perjalanan klaim dari data mentah sampai berkas kasus.
              </p>}
        </div>
      ) : (
        <div className="space-y-3 p-3">
          <div className="space-y-1.5">
            <Judul ikon="⛓">Jejak keputusan: setiap langkah dengan angka dan ambangnya</Judul>
            <ol className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
              {p.jejak.map((j, i) => (
                <li key={j.tahap} className="rounded-lg border px-3 py-2" style={{ borderColor: j.nyala ? "#ff7d9c66" : "rgba(255,255,255,.08)", background: "#151a1f" }}>
                  <p className="text-[10.5px] text-[#8e9cad]">{i + 1}. {j.tahap}</p>
                  <p className="text-[12px] font-semibold text-white">{j.hasil}</p>
                  <ul className="mt-1 space-y-0.5">{j.rinci.map((r) => <li key={r} className="text-[11px] leading-snug text-[#c3ccd7]">{r}</li>)}</ul>
                </li>
              ))}
            </ol>
          </div>
          {teknis}
        </div>
      )}
    </div>
  );
}
