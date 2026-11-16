"use client";
import { useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { wib } from "@/components/aip/aipRun";
import { fraud, STRENGTH } from "@/components/aip/fraudApi";

/* Aturan Indikasi (AIP JKN, in the Box Karantina tab): every rule and fact the fraud indications rest on, explained — what it checks, why,
   on which data, its threshold and strength, the Permenkes mode it points to and how many it found last — from one
   catalogue on the server (GET /api/aip/aturan, api/aip/aturan.py), whose thresholds are the code's own. Laid out for
   people who do not read code (the user, 2026-10-28: "lebih mudah dipahami orang2"): the four steps a claim goes
   through first, the rules as cards with their explanation beside, the 19 Permenkes modes as a coverage map. */

type Aturan = {
  id: string; lapisan: string; nama: string; entitas: string; tag: string | null; tag_label: string | null; modus: string | null; kondisi: string;
  kenapa: string; data: string; kekuatan: string; keterbatasan: string; kolom: string | null; catatan: string; temuan?: number | null; temuan_satuan?: string;
};
type Modus = { id: string; no: number; nama: string; deteksi: string; dasar: string; tag: string[]; fokus: boolean; aturan: string[] };
type Katalog = { lapisan: { id: string; nama: string; arti: string }[]; aturan: Aturan[]; modus: Modus[]; kekuatan: Record<string, string>;
  penandaan_terakhir: { pada?: string; tag?: number; dicabut?: number } };

// each step in the words of the question it answers
const STEP: Record<string, { tanya: string; icon: IconName; warna: string }> = {
  fakta: { tanya: "Apa yang terjadi pada klaim ini?", icon: "doc", warna: "#3987e5" },
  skrining: { tanya: "Klaim mana yang perlu dilihat lebih dekat?", icon: "filter", warna: "#8abbff" },
  penanda: { tanya: "Indikasi apa yang muncul, seberapa kuat?", icon: "alert", warna: "#fab219" },
  kerugian: { tanya: "Berapa uang yang mungkin hilang?", icon: "gauge", warna: "#e5484d" },
};
const ENTITY: Record<string, string> = { klaim: "Per klaim", faskes: "Per faskes", kabkota: "Per kab/kota", inacbg: "Per kode INA-CBG", rujukan: "Per alur rujukan", peserta: "Per peserta" };
const DETEKSI: Record<string, { warna: string; arti: string }> = {
  terdeteksi: { warna: "#29a383", arti: "ada aturan dan ukurannya di data klaim" },
  sinyal: { warna: "#fab219", arti: "sinyal awal; memastikannya butuh rekam medis atau dokumen" },
  aturan: { warna: "#3987e5", arti: "aturannya berjalan, belum ada temuan di data sampel" },
  "tidak ada data": { warna: "#5f6b7c", arti: "data sampel tidak memuat yang dibutuhkan modus ini" },
};
const LEVELS = ["lemah", "sedang", "kuat"] as const;

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ");
const idn = (n: number) => n.toLocaleString("id-ID");
// the strongest level a rule can reach, read from its own strength text ("sedang bila …, selain itu lemah" → sedang)
const peak = (a: Aturan) => [...LEVELS].reverse().find((l) => a.kekuatan.includes(l)) ?? null;
// what a note says: a fact that only tells others apart, a fix, or a plain note
const noteKind = (a: Aturan) => !a.catatan ? null : a.catatan.startsWith("Bukan indikasi") ? "pembeda" : a.catatan.startsWith("Diperbaiki") ? "diperbaiki" : "catatan";

export function AturanView() {
  const [k, setK] = useState<Katalog | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [lap, setLap] = useState("");
  const [modus, setModus] = useState("");
  const [buka, setBuka] = useState<string | null>(null);
  useEffect(() => { fraud.aturan().then((x) => setK(x as unknown as Katalog)).catch((e) => setErr((e as Error).message)); }, []);
  const modusOf = useMemo(() => new Map((k?.modus ?? []).map((m) => [m.id, m])), [k]);
  const hasil = useMemo(() => {
    const query = norm(q).trim();
    const tags = modus ? new Set(modusOf.get(modus)?.tag ?? []) : null;
    return (k?.aturan ?? []).filter((a) => (!lap || a.lapisan === lap) && (!tags || (a.tag && tags.has(a.tag))) &&
      (!query || norm([a.nama, a.kondisi, a.kenapa, a.data, a.tag ?? "", a.tag_label ?? "", a.modus ?? "", a.kolom ?? "", a.id].join(" ")).includes(query)));
  }, [k, q, lap, modus, modusOf]);
  const open = k?.aturan.find((a) => a.id === buka) ?? null;

  if (err) return <div className="flex flex-1 items-center justify-center text-[12px] text-red-300">Katalog aturan tidak terbaca: {err}</div>;
  if (!k) return <div className="flex flex-1 items-center justify-center text-[12px] text-[#8f99a8]">Memuat aturan…</div>;
  const filtered = !!(q || lap || modus);
  const pickMode = (id: string) => { setModus(id); setLap(""); setQ(""); document.getElementById("aturan-daftar")?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden text-[12px]">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="border-b border-white/5 bg-[#1c2127] px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-[14px] font-semibold text-white">Aturan Indikasi</p>
            <p className="text-[#abb3bf]">Bagaimana sistem memutuskan sebuah klaim atau faskes perlu diperiksa: {k.aturan.length} aturan dan fakta, dengan alasan dan ambangnya.</p>
            {k.penandaan_terakhir.pada && <p className="ml-auto text-[11px] text-[#8f99a8]">Penandaan otomatis terakhir {wib(k.penandaan_terakhir.pada)} · {idn(k.penandaan_terakhir.tag ?? 0)} tag</p>}
          </div>
        </div>

        <div className="space-y-4 p-3">
          {/* the four steps a claim goes through, each one a filter */}
          <section>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
              {k.lapisan.map((l, i) => {
                const s = STEP[l.id] ?? { tanya: l.arti, icon: "info" as IconName, warna: "#8abbff" };
                const n = k.aturan.filter((a) => a.lapisan === l.id).length;
                const on = lap === l.id;
                return (
                  <button key={l.id} onClick={() => { setLap(on ? "" : l.id); setBuka(null); }}
                    className={`group relative rounded-md border p-3 text-left transition-colors ${on ? "bg-white/[.07]" : "border-white/10 bg-[#1c2127] hover:bg-white/[.04]"}`}
                    style={{ borderColor: on ? s.warna : undefined }}>
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold text-black" style={{ background: s.warna }}>{i + 1}</span>
                      <span className="font-semibold text-white">{l.nama}</span>
                      <span className="ml-auto opacity-70" style={{ color: s.warna }}><Icon name={s.icon} className="h-4 w-4" /></span>
                    </div>
                    <p className="mt-2 text-[12.5px] font-medium leading-snug text-[#e5e8eb]">{s.tanya}</p>
                    <p className="mt-1 text-[11px] leading-snug text-[#8f99a8]">{l.arti}</p>
                    <p className="mt-2 text-[11px] text-[#abb3bf]"><b className="text-white">{n}</b> {l.id === "kerugian" ? "komponen" : l.id === "fakta" ? "fakta" : "aturan"}
                      {l.id === "penanda" && k.penandaan_terakhir.tag ? <> · <b className="text-white">{idn(k.penandaan_terakhir.tag)}</b> tag terakhir</> : null}</p>
                  </button>
                );
              })}
              <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-[#b8a9ff]/40 px-4 py-3 text-[#c9c0ff] max-xl:col-span-full">
                <Icon name="lock" className="h-4 w-4" /><span className="font-medium">Box Karantina</span>
              </div>
            </div>
            <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-[#abb3bf]">
              <Icon name="info" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#8abbff]" />
              <span>Semua yang di sini adalah <b className="text-white">sinyal untuk diperiksa, bukan fraud terbukti</b>. Agen AI Agent Swarm menilai indikasinya, dan keputusan
                audit (dibina, ditindak, atau dibebaskan) selalu dibuat manusia.</span>
            </p>
          </section>

          {/* filters and what a strength means */}
          <section id="aturan-daftar" className="scroll-mt-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative min-w-[240px] flex-1 sm:max-w-sm">
                <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8f99a8]" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari aturan… coba: tarif, tumpang tindih, kelas, readmisi"
                  className="w-full rounded-sm border border-white/15 bg-[#111418] py-1.5 pl-7 pr-2 text-[12px] text-[#e5e8eb] outline-none placeholder:text-[#6b7586] focus:border-[#8abbff]/60" />
              </label>
              <select value={modus} onChange={(e) => setModus(e.target.value)} className="max-w-[320px] rounded-sm border border-white/15 bg-[#111418] px-2 py-1.5 text-[12px] text-[#e5e8eb]">
                <option value="">Semua modus Permenkes</option>
                {k.modus.map((m) => <option key={m.id} value={m.id}>{m.no}. {m.nama}</option>)}
              </select>
              {filtered && (
                <button onClick={() => { setQ(""); setLap(""); setModus(""); }} className="flex items-center gap-1 rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-[#d3d8de] hover:bg-white/10">
                  <Icon name="x" className="h-3 w-3" />{hasil.length} cocok · hapus filter
                </button>
              )}
              <div className="ml-auto flex flex-wrap items-center gap-3 text-[11px] text-[#8f99a8]">
                <span>Kekuatan indikasi:</span>
                {LEVELS.map((l) => (
                  <span key={l} className="flex items-center gap-1" title={k.kekuatan[l]}><Dots level={l} /><span className="text-[#d3d8de]">{l}</span></span>
                ))}
              </div>
            </div>
            <div className="grid gap-1 text-[11px] leading-snug text-[#8f99a8] md:grid-cols-3">
              {LEVELS.map((l) => <p key={l}><b style={{ color: STRENGTH[l] === "#8f99a8" ? "#d3d8de" : STRENGTH[l] }}>{l}</b>: {k.kekuatan[l]}</p>)}
            </div>
          </section>

          {/* the rules, step by step; the tagger's by what they look at */}
          {k.lapisan.filter((l) => !lap || lap === l.id).map((l) => {
            const rows = hasil.filter((a) => a.lapisan === l.id);
            if (!rows.length) return null;
            const s = STEP[l.id];
            const top = Math.max(1, ...rows.map((a) => a.temuan ?? 0));
            const groups = l.id === "penanda" ? Object.keys(ENTITY).map((e) => [e, rows.filter((a) => a.entitas === e)] as const).filter(([, v]) => v.length) : [["", rows] as const];
            return (
              <section key={l.id}>
                <div className="mb-2 flex items-baseline gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full text-[10.5px] font-bold text-black" style={{ background: s?.warna ?? "#8abbff" }}>{k.lapisan.indexOf(l) + 1}</span>
                  <p className="text-[13px] font-semibold text-white">{l.nama}</p>
                  <p className="text-[11px] text-[#8f99a8]">{s?.tanya ?? l.arti}</p>
                </div>
                {groups.map(([e, v]) => (
                  <div key={e || l.id} className="mb-3">
                    {e && <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[#8f99a8]">{ENTITY[e]} · {v.length}</p>}
                    <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
                      {v.map((a) => <RuleCard key={a.id} a={a} top={top} on={buka === a.id} onClick={() => setBuka(buka === a.id ? null : a.id)} />)}
                    </div>
                  </div>
                ))}
              </section>
            );
          })}
          {!hasil.length && <p className="rounded border border-white/10 bg-[#1c2127] px-3 py-6 text-center text-[#8f99a8]">Tidak ada aturan yang cocok dengan filter ini.</p>}

          {/* the 19 Permenkes modes: what the sample data can show of each */}
          <section className="rounded-md border border-white/10 bg-[#1c2127]">
            <div className="border-b border-white/5 px-3 py-2.5">
              <p className="font-semibold text-white">Cakupan modus fraud Permenkes 16/2019</p>
              <p className="text-[11px] text-[#8f99a8]">Apa yang bisa dilihat dari data sampel untuk tiap modus. Klik modus untuk melihat aturannya.</p>
              <ModeBar modes={k.modus} />
            </div>
            <div className="grid gap-px bg-white/5 sm:grid-cols-2 xl:grid-cols-3">
              {k.modus.map((m) => {
                const d = DETEKSI[m.deteksi] ?? { warna: "#8f99a8", arti: m.deteksi };
                return (
                  <button key={m.id} onClick={() => m.aturan.length && pickMode(m.id)} disabled={!m.aturan.length}
                    className={`bg-[#1c2127] px-3 py-2.5 text-left enabled:hover:bg-[#232a31] ${modus === m.id ? "outline outline-1 outline-[#8abbff]/60" : ""}`}>
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 w-5 shrink-0 text-right text-[11px] tabular-nums text-[#6b7586]">{m.no}</span>
                      <p className="min-w-0 flex-1 font-medium leading-snug text-[#e5e8eb]">{m.nama}</p>
                      {m.fokus && <span className="shrink-0 rounded bg-white/10 px-1.5 text-[10px] text-[#d3d8de]">fokus tim</span>}
                    </div>
                    <div className="ml-7 mt-1 flex items-center gap-2 text-[10.5px]">
                      <span className="flex items-center gap-1 rounded-full px-1.5 py-px" style={{ background: `${d.warna}22`, color: d.warna === "#5f6b7c" ? "#9aa5b4" : d.warna }}>
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: d.warna }} />{m.deteksi}</span>
                      {m.aturan.length > 0 && <span className="text-[#8abbff]">{m.aturan.length} aturan →</span>}
                    </div>
                    <p className="ml-7 mt-1 line-clamp-3 text-[11px] leading-snug text-[#8f99a8]">{m.dasar}</p>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>
      {open && <RuleDetail a={open} k={k} onClose={() => setBuka(null)} onMode={pickMode} />}
    </div>
  );
}

function Dots({ level }: { level: string | null }) {
  const n = level ? LEVELS.indexOf(level as (typeof LEVELS)[number]) + 1 : 0;
  return (
    <span className="flex gap-0.5" aria-label={level ?? "tanpa kekuatan"}>
      {LEVELS.map((l, i) => <span key={l} className="h-1.5 w-1.5 rounded-full" style={{ background: i < n ? STRENGTH[level!] : "rgba(255,255,255,.12)" }} />)}
    </span>
  );
}

function NoteChip({ a }: { a: Aturan }) {
  const kind = noteKind(a);
  if (!kind) return null;
  const style = kind === "pembeda" ? "bg-white/10 text-[#c5cbd3]" : kind === "diperbaiki" ? "bg-[#3987e5]/20 text-[#8abbff]" : "bg-[#fab219]/15 text-[#fbd38d]";
  return <span className={`rounded px-1.5 py-px text-[10px] ${style}`} title={a.catatan}>{kind === "pembeda" ? "pembeda, bukan indikasi" : kind}</span>;
}

function RuleCard({ a, top, on, onClick }: { a: Aturan; top: number; on: boolean; onClick: () => void }) {
  const lvl = peak(a);
  return (
    <button onClick={onClick}
      className={`flex flex-col rounded-md border p-3 text-left transition-colors ${on ? "border-[#8abbff]/70 bg-white/[.06]" : "border-white/10 bg-[#1c2127] hover:border-white/20 hover:bg-white/[.03]"}`}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 font-semibold leading-snug text-[#e5e8eb]">{a.nama}</p>
        {a.temuan != null && (
          <span className="shrink-0 text-right">
            <span className="block text-[13px] font-semibold tabular-nums text-white">{idn(a.temuan)}</span>
            <span className="block text-[10px] text-[#8f99a8]">{a.temuan_satuan}</span>
          </span>
        )}
      </div>
      <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-[#abb3bf]">{a.kondisi}</p>
      {a.temuan != null && top > 1 && (
        <div className="mt-2 h-1 overflow-hidden rounded bg-white/5"><div className="h-full rounded bg-[#8abbff]/60" style={{ width: `${Math.max(1, (100 * a.temuan) / top)}%` }} /></div>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2 text-[10.5px]">
        {a.tag_label && <span className="rounded bg-[#5b5fd6]/25 px-1.5 py-px text-[#c9c0ff]" title={a.modus ?? ""}>{a.tag_label}</span>}
        <NoteChip a={a} />
        {a.keterbatasan && <span className="flex items-center gap-0.5 text-[#fbd38d]/80" title={a.keterbatasan}><Icon name="alert" className="h-3 w-3" />ada batasan</span>}
        {lvl && <span className="ml-auto flex items-center gap-1 text-[#8f99a8]" title={a.kekuatan}>sampai <Dots level={lvl} /></span>}
      </div>
    </button>
  );
}

function RuleDetail({ a, k, onClose, onMode }: { a: Aturan; k: Katalog; onClose: () => void; onMode: (id: string) => void }) {
  const layer = k.lapisan.find((l) => l.id === a.lapisan);
  const s = STEP[a.lapisan];
  const modes = k.modus.filter((m) => m.aturan.includes(a.id));
  const lvl = peak(a);
  return (
    <aside className="flex w-[440px] shrink-0 flex-col overflow-y-auto border-l border-black/30 bg-[#1c2127] max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-10 max-lg:w-full">
      <div className="flex items-start gap-2 border-b border-white/5 p-3">
        <div className="min-w-0">
          <p className="text-[11px]" style={{ color: s?.warna ?? "#8abbff" }}>{layer?.nama}{ENTITY[a.entitas] ? ` · ${ENTITY[a.entitas].toLowerCase()}` : ""}</p>
          <p className="text-[14px] font-semibold leading-snug text-white">{a.nama}</p>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[10.5px]">
            {a.tag_label && <span className="rounded bg-[#5b5fd6]/25 px-1.5 py-px text-[#c9c0ff]">tag: {a.tag_label}</span>}
            <NoteChip a={a} />
          </div>
        </div>
        <button onClick={onClose} className="ml-auto rounded p-1 text-[#8f99a8] hover:bg-white/10"><Icon name="x" className="h-4 w-4" /></button>
      </div>
      <div className="space-y-3 p-3 text-[12px] leading-relaxed">
        {a.temuan != null && (
          <div className="rounded bg-white/[.04] px-3 py-2">
            <p className="text-[20px] font-semibold tabular-nums text-white">{idn(a.temuan)} <span className="text-[12px] font-normal text-[#8f99a8]">{a.temuan_satuan}</span></p>
            <p className="text-[11px] text-[#8f99a8]">{a.lapisan === "penanda" ? "ditandai pada penandaan otomatis terakhir" : "di seluruh data klaim saat ini"}</p>
          </div>
        )}
        <Block title="Yang dicek"><p className="rounded border border-white/10 bg-[#111418] px-2.5 py-1.5 text-[#e5e8eb]">{a.kondisi}</p></Block>
        <Block title="Kenapa ini penting"><p className="text-[#c5cbd3]">{a.kenapa}</p></Block>
        {a.kekuatan && (
          <Block title="Kekuatan indikasi">
            <p className="flex items-center gap-2 text-[#c5cbd3]">{lvl && <Dots level={lvl} />}{a.kekuatan}</p>
          </Block>
        )}
        {(a.modus || modes.length > 0) && (
          <Block title="Mengarah ke modus Permenkes 16/2019">
            {a.modus && <p className="text-[#c5cbd3]">{a.modus}</p>}
            {modes.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{modes.map((m) => (
              <button key={m.id} onClick={() => onMode(m.id)} className="rounded border border-white/15 px-1.5 py-px text-[11px] text-[#d3d8de] hover:bg-white/10">{m.no}. {m.nama}</button>
            ))}</div>}
          </Block>
        )}
        {a.keterbatasan && (
          <div className="flex gap-2 rounded border border-[#fab219]/30 bg-[#fab219]/[.07] px-2.5 py-2 text-[#fbd38d]">
            <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div><p className="text-[10.5px] font-semibold uppercase tracking-wide">Perlu diingat</p><p>{a.keterbatasan}</p></div>
          </div>
        )}
        {a.catatan && <Block title="Catatan"><p className="text-[#c5cbd3]">{a.catatan}</p></Block>}
        <Block title="Sumber data">
          <p className="font-mono text-[11px] text-[#c9c0ff]">{a.data}</p>
          {a.kolom && <p className="mt-1 text-[11px] text-[#8f99a8]">kolom hasil: <span className="font-mono text-[#c9c0ff]">{a.kolom}</span></p>}
        </Block>
        <p className="font-mono text-[10.5px] text-[#6b7586]">ID aturan: {a.id}</p>
      </div>
    </aside>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[#8f99a8]">{title}</p>{children}</div>;
}

// how many of the modes the data can see, as one bar with its legend
function ModeBar({ modes }: { modes: Modus[] }) {
  const order = Object.keys(DETEKSI);
  const count = order.map((d) => [d, modes.filter((m) => m.deteksi === d).length] as const).filter(([, n]) => n);
  return (
    <div className="mt-2">
      <div className="flex h-2 overflow-hidden rounded-full">
        {count.map(([d, n]) => <div key={d} title={`${d}: ${n}`} style={{ width: `${(100 * n) / modes.length}%`, background: DETEKSI[d].warna }} className="border-r border-[#1c2127] last:border-0" />)}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {count.map(([d, n]) => (
          <span key={d} className="flex items-center gap-1.5 text-[#abb3bf]" title={DETEKSI[d].arti}>
            <span className="h-2 w-2 rounded-full" style={{ background: DETEKSI[d].warna }} /><b className="text-white">{n}</b> {d}
            <span className="text-[#6b7586]">— {DETEKSI[d].arti}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
