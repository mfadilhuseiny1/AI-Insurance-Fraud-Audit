"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { wib } from "@/components/aip/aipRun";
import { fraud, GROUP_COLOR, rp, STRENGTH, TSM_COLOR, VERDICT, type Box, type BoxChoices, type BoxFacility, type Review } from "@/components/aip/fraudApi";

/* Box Karantina (api/aip/karantina.py): every facility with an indication, grouped by the loss it may cause — A, the
   audit priority, down to Z — with its TSM reading (Terstruktur, Sistematis, Masif). An investigator agent recommends a
   path; a person decides: dibina (no intent: fix and recover), ditindak (TSM fraud: the legal track) or dibebaskan.
   Each AI Agent Swarm engagement builds its own box: the user picks the project and the engagement, by default the
   newest box of the newest project (the user, 2026-10-28). */

const GROUPS = ["A", "B", "C", "D", "Z"] as const;
const STATUS_LABEL: Record<string, string> = { karantina: "Karantina", diaudit: "Diaudit", dibina: "Dibina (diobati)", ditindak: "Ditindak (hukum)", dibebaskan: "Dibebaskan" };
const STATUS_COLOR: Record<string, string> = { karantina: "#8f99a8", diaudit: "#3987e5", dibina: "#fab219", ditindak: "#e5484d", dibebaskan: "#29a383" };
const PATH_TEXT: Record<string, string> = { ditindak: "text-[#ffb4b4]", dibebaskan: "text-[#7ee2c0]", dibina: "text-[#fbd38d]" };
const LIVE = "";  // no engagement box yet: the platform's live box

type Choice = BoxChoices["proyek"][number]["penugasan"][number];
type Row = BoxFacility;

const idn = (n?: number | null) => (n ?? 0).toLocaleString("id-ID");
const pct = (part: number, whole: number) => (whole > 0 ? `${((100 * part) / whole).toFixed(part / whole < 0.1 ? 1 : 0).replace(".", ",")}%` : "—");
// "FKRTL · Rumah sakit · RS Kelas B · Pemerintah kab/kota · KULON PROGO" → what tells it apart, its place on the line below
function title(f: Pick<Row, "nama" | "kabkota">): string {
  const parts = f.nama.split(" · ").filter((p) => p !== "FKRTL");
  if (parts.length > 1 && parts.at(-1)?.toUpperCase() === String(f.kabkota ?? "").toUpperCase()) parts.pop();
  return parts.join(" · ");
}
const place = (f: Pick<Row, "kabkota" | "provinsi">) => [f.kabkota, f.provinsi].filter(Boolean).join(", ");
const choiceLabel = (c: Choice) =>
  `${c.nama ?? c.run} · ${wib(c.mulai)}${c.status === "running" ? " · berjalan" : ""}${c.box === "ringkasan" ? " · ringkasan saja" : c.box ? "" : " · belum ada box"}`;

// fokus: a faskes_profil_id to open, as clicking it would (the AIP operator's "buka_aplikasi karantina <faskes>")
export function KarantinaView({ fokus }: { fokus?: string | null } = {}) {
  const [choices, setChoices] = useState<BoxChoices | null>(null);
  const [proj, setProj] = useState("");
  const [run, setRun] = useState<string | null>(null);  // null: not chosen yet
  const [box, setBox] = useState<Box | null>(null);
  const [whole, setWhole] = useState<Record<string, Row[]>>({});  // groups loaded whole (beyond the first 300)
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [grp, setGrp] = useState<string>("A");
  const [q, setQ] = useState("");
  const [st, setSt] = useState("");
  const [sel, setSel] = useState<string | null>(null);

  const loadChoices = (keep: boolean) => fraud.boxChoices().then((c) => {
    setChoices(c);
    if (!keep || run === null) {
      setProj(c.bawaan?.proyek ?? c.proyek[0]?.id ?? "");
      setRun(c.bawaan?.run ?? LIVE);
    }
  }).catch((e) => { setErr((e as Error).message); if (run === null) setRun(LIVE); });
  const loadBox = (r: string) => {
    setBusy(true); setErr("");
    return fraud.box({ penugasan: r || undefined, limit: 300, ringkas: true }).then((b) => {
      setBox(b); setWhole({});
      setGrp((g) => (b.kelompok[g]?.total ? g : GROUPS.find((x) => b.kelompok[x]?.total) ?? "A"));
    }).catch((e) => { setBox(null); setErr((e as Error).message); }).finally(() => setBusy(false));
  };
  useEffect(() => { loadChoices(false); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (run === null) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- another box: nothing of it selected yet
    setSel(null);
    loadBox(run);
  }, [run]);
  // a facility asked for from outside: its group in the list, its row in view, its panel open
  const done = useRef<string | null>(null);  // once per facility asked for, not again at every reload of the box
  useEffect(() => {
    if (!fokus || !box || done.current === fokus) return;
    done.current = fokus;
    const g = GROUPS.find((x) => box.kelompok[x]?.faskes.some((f) => f.faskes_profil_id === fokus));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a command from outside (the operator), not derived state
    if (g) { setQ(""); setSt(""); setGrp(g); }
    setSel(fokus);
    const t = setTimeout(() => document.getElementById(`faskes-${fokus}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    return () => clearTimeout(t);
  }, [fokus, box]);

  const project = choices?.proyek.find((p) => p.id === proj);
  const pickProject = (id: string) => {
    setProj(id);
    const p = choices?.proyek.find((x) => x.id === id);
    const first = p?.penugasan.find((e) => e.box === "lengkap") ?? p?.penugasan.find((e) => e.box);
    if (first) setRun(first.run);
  };
  const current = project?.penugasan.find((e) => e.run === run);
  const isDefault = !!choices?.bawaan && choices.bawaan.run === run;
  const s = box?.ringkasan as BoxSummary | null | undefined;
  const summaryOnly = box?.penugasan && !box.penugasan.lengkap;

  const rows = useMemo(() => {
    if (!box) return [];
    const query = q.trim().toLowerCase();
    const pool = query ? GROUPS.flatMap((g) => whole[g] ?? box.kelompok[g]?.faskes ?? []) : (whole[grp] ?? box.kelompok[grp]?.faskes ?? []);
    return pool.filter((f) => (!st || f.status === st) && (!query || `${f.nama} ${f.kabkota ?? ""} ${f.provinsi ?? ""}`.toLowerCase().includes(query)));
  }, [box, whole, grp, q, st]);
  const shown = box ? (q ? GROUPS.reduce((n, g) => n + (whole[g] ?? box.kelompok[g]?.faskes ?? []).length, 0) : (whole[grp] ?? box.kelompok[grp]?.faskes ?? []).length) : 0;
  const total = box ? (q ? box.total : box.kelompok[grp]?.total ?? 0) : 0;
  const loadWhole = async () => {
    setBusy(true);
    try {
      const want = q ? GROUPS.filter((g) => (box?.kelompok[g]?.total ?? 0) > (whole[g] ?? box?.kelompok[g]?.faskes ?? []).length) : [grp];
      const got = await Promise.all(want.map((g) => fraud.box({ kelompok: g, penugasan: run || undefined, ringkas: true }).then((b) => [g, b.kelompok[g]?.faskes ?? []] as const)));
      setWhole((w) => ({ ...w, ...Object.fromEntries(got) }));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden text-[12px]">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {/* which box: the project and its engagement */}
        <div className="border-b border-white/5 bg-[#1c2127] px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="flex items-center gap-1.5 text-[14px] font-semibold text-white"><Icon name="lock" className="h-4 w-4 text-[#b8a9ff]" />Box Karantina</p>
            {choices && choices.proyek.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <Picker label="Proyek" value={proj} onChange={pickProject}
                  options={choices.proyek.map((p) => ({ v: p.id, t: `${p.nama}${p.penugasan.some((e) => e.box) ? "" : " (belum ada box)"}`, off: !p.penugasan.some((e) => e.box) }))} />
                <Picker label="Penugasan" value={run ?? ""} onChange={setRun} wide
                  options={(project?.penugasan ?? []).map((e) => ({ v: e.run, t: choiceLabel(e), off: !e.box }))} />
                {isDefault ? <span className="rounded-full bg-[#29a383]/20 px-2 py-0.5 text-[10.5px] font-medium text-[#7ee2c0]" title="Box terbaru dari proyek terbaru">terbaru</span>
                  : choices.bawaan && <button onClick={() => { setProj(choices.bawaan!.proyek); setRun(choices.bawaan!.run); }} className="rounded-full border border-white/15 px-2 py-0.5 text-[10.5px] text-[#d3d8de] hover:bg-white/10">Ke box terbaru</button>}
              </div>
            )}
            <button onClick={() => { loadChoices(true); if (run !== null) loadBox(run); }} disabled={busy} title="Muat ulang"
              className="ml-auto flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[#d3d8de] hover:bg-white/10 disabled:opacity-50">
              <Icon name="refresh" className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />Muat ulang
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-[#8f99a8]">
            {box?.penugasan
              ? <>Box yang dibangun penugasan <b className="font-medium text-[#d3d8de]">{current?.nama ?? box.penugasan.run}</b>{box.penugasan.pada ? ` pada ${wib(box.penugasan.pada)}` : ""}
                {current?.status === "running" ? " · penugasan masih berjalan: rekomendasi penyidik masuk saat mereka selesai" : ""}{project?.fokus ? ` · fokus: ${project.fokus}` : ""}</>
              : run === LIVE && box ? <>Box aktif platform{s?.pada ? `, dihitung ${wib(s.pada)}` : ""}: belum ada penugasan AI Agent Swarm yang menyimpan box-nya.</> : "Memuat box…"}
          </p>
          {err && <p className="mt-1 text-red-300">{err}</p>}
        </div>

        {box && s && (
          <div className="space-y-3 p-3">
            {summaryOnly && (
              <div className="flex gap-2 rounded border border-[#fab219]/30 bg-[#fab219]/[.07] px-3 py-2 text-[11.5px] leading-relaxed text-[#fbd38d]">
                <Icon name="info" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p>Penugasan ini berjalan sebelum box tiap penugasan disimpan utuh (28 Okt 2026). Yang tersimpan dari jejaknya: ringkasan kelompok di bawah, dan faskes yang
                  diaudit penyidiknya beserta rekomendasi mereka. Daftar faskes lengkap ada pada box penugasan yang lebih baru.</p>
              </div>
            )}

            {/* the figures, the flow and the Pareto groups */}
            <section className="rounded border border-white/10 bg-[#1c2127] p-3">
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <Stat label="Faskes di box" value={idn(s.faskes)} hint="faskes dengan sedikitnya satu indikasi, sekecil apa pun" />
                <Stat label="Estimasi kerugian" value={rp(s.total_estimasi_kerugian_rp)} hint="dari klaim bertag yang belum dikoreksi verifikator" strong />
                <Stat label="Sudah dikoreksi verifikator" value={rp(s.sudah_dikoreksi_rp)} hint="uang yang sudah diselamatkan, bukan kerugian" />
                <Stat label="Indikasi TSM penuh" value={idn(s.indikasi_tsm)} hint="Terstruktur, Sistematis dan Masif terpenuhi: kandidat jalur ditindak" />
              </div>
              {!summaryOnly && <Flow per={box.per_status} />}
              <div className="mt-3">
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <p className="font-semibold text-[#e5e8eb]">Kelompok menurut estimasi kerugian</p>
                  <p className="text-[10.5px] text-[#8f99a8]">analisis ABC/Pareto: A = faskes yang bersama-sama menanggung 50% pertama kerugian · B s.d. 80% · C s.d. 95% · D s.d. 99% · Z sisanya</p>
                </div>
                <div className="flex h-2.5 overflow-hidden rounded-full bg-white/5">
                  {GROUPS.map((g) => {
                    const v = s.kelompok?.[g];
                    return v && v.kerugian_rp > 0 ? <div key={g} title={`${g}: ${rp(v.kerugian_rp)} (${pct(v.kerugian_rp, s.total_estimasi_kerugian_rp)})`}
                      style={{ width: `${(100 * v.kerugian_rp) / Math.max(s.total_estimasi_kerugian_rp, 1)}%`, background: GROUP_COLOR[g] }} className="min-w-[3px] border-r border-[#1c2127] last:border-0" /> : null;
                  })}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                  {GROUPS.map((g) => {
                    const v = s.kelompok?.[g];
                    if (!v) return null;
                    const on = !summaryOnly && !q && grp === g;
                    return (
                      <button key={g} disabled={!!summaryOnly || !v.faskes} onClick={() => { setGrp(g); setQ(""); }} title={v.arti}
                        className={`rounded border px-2.5 py-2 text-left transition-colors disabled:cursor-default ${on ? "bg-white/[.07]" : "border-white/10 hover:enabled:bg-white/[.04]"}`}
                        style={{ borderTopColor: GROUP_COLOR[g], borderTopWidth: 3, ...(on ? { borderRightColor: GROUP_COLOR[g], borderBottomColor: GROUP_COLOR[g], borderLeftColor: GROUP_COLOR[g] } : {}) }}>
                        <p className="flex items-baseline gap-1.5"><b className="text-[13px]" style={{ color: GROUP_COLOR[g] }}>{g}</b>
                          <span className="text-[11px] text-[#abb3bf]">{idn(v.faskes)} faskes</span>
                          <span className="ml-auto text-[10.5px] text-[#8f99a8]">{pct(v.kerugian_rp, s.total_estimasi_kerugian_rp)}</span></p>
                        <p className="text-[14px] font-semibold tabular-nums text-white">{rp(v.kerugian_rp)}</p>
                        <p className="line-clamp-1 text-[10.5px] text-[#8f99a8]">{g === "Z" ? "kecil atau hanya sinyal non-uang" : `tiap faskes ≥ ${rp(v.batas_bawah_rp)}`}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            {summaryOnly ? <Audited box={box} onOpen={setSel} sel={sel} /> : (
              <section className="rounded border border-white/10 bg-[#1c2127]">
                <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2">
                  {q ? <p className="font-semibold text-[#e5e8eb]">Hasil pencarian di semua kelompok</p> : (
                    <p className="flex min-w-0 items-center gap-2"><span className="rounded px-1.5 font-bold text-black" style={{ background: GROUP_COLOR[grp] }}>{grp}</span>
                      <span className="truncate text-[#e5e8eb]">{box.kelompok_arti[grp]}</span></p>
                  )}
                  <label className="relative ml-auto w-full sm:w-[240px]">
                    <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8f99a8]" />
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari faskes, kab/kota, provinsi…"
                      className="w-full rounded-sm border border-white/15 bg-[#111418] py-1 pl-7 pr-2 text-[12px] text-[#e5e8eb] outline-none placeholder:text-[#6b7586] focus:border-[#8abbff]/60" />
                  </label>
                  <select value={st} onChange={(e) => setSt(e.target.value)} className="rounded-sm border border-white/15 bg-[#111418] px-2 py-1 text-[12px] text-[#e5e8eb]">
                    <option value="">Semua status</option>
                    {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l} ({idn(box.per_status[k])})</option>)}
                  </select>
                </div>
                <FacilityTable rows={rows} sel={sel} onOpen={setSel} showGroup={!!q} />
                <div className="flex flex-wrap items-center gap-2 border-t border-white/5 px-3 py-1.5 text-[11px] text-[#8f99a8]">
                  <span>{idn(rows.length)} faskes ditampilkan{shown < total ? ` · ${idn(shown)} dari ${idn(total)} dimuat` : ""}</span>
                  {shown < total && <button onClick={loadWhole} disabled={busy} className="rounded border border-white/15 px-2 py-0.5 text-[#d3d8de] hover:bg-white/10 disabled:opacity-50">Muat semua {idn(total)}</button>}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
      {sel && <Detail fid={sel} run={box?.penugasan?.lengkap ? box.penugasan.run : undefined} older={!isDefault && !!box?.penugasan}
        onClose={() => setSel(null)} onDecided={() => run !== null && loadBox(run)} />}
    </div>
  );
}

type BoxSummary = {
  pada?: string; faskes: number; total_estimasi_kerugian_rp: number; sudah_dikoreksi_rp: number; indikasi_tsm: number;
  kelompok?: Record<string, { faskes: number; kerugian_rp: number; batas_bawah_rp: number | null; arti: string }>;
};

function Picker({ label, value, onChange, options, wide }: { label: string; value: string; onChange: (v: string) => void; options: { v: string; t: string; off?: boolean }[]; wide?: boolean }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-[#8f99a8]">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className={`rounded-sm border border-white/15 bg-[#111418] px-2 py-1 text-[12px] text-[#e5e8eb] outline-none focus:border-[#8abbff]/60 ${wide ? "max-w-[min(440px,80vw)]" : "max-w-[260px]"}`}>
        {options.map((o) => <option key={o.v} value={o.v} disabled={o.off}>{o.t}</option>)}
      </select>
    </label>
  );
}

function Stat({ label, value, hint, strong }: { label: string; value: string; hint: string; strong?: boolean }) {
  return (
    <div className="rounded bg-white/[.04] px-3 py-2" title={hint}>
      <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">{label}</p>
      <p className={`text-[18px] font-semibold tabular-nums ${strong ? "text-[#ffb4b4]" : "text-white"}`}>{value}</p>
      <p className="line-clamp-1 text-[10.5px] text-[#6b7586]">{hint}</p>
    </div>
  );
}

// indikasi → karantina → audit → dibina / ditindak / dibebaskan, with how many facilities stand at each step
function Flow({ per }: { per: Record<string, number> }) {
  const step = (k: string, sub: string) => (
    <span className="flex items-center gap-1.5 rounded-full border px-2 py-0.5" style={{ borderColor: `${STATUS_COLOR[k]}55` }} title={sub}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_COLOR[k] }} />
      <span className="text-[#d3d8de]">{STATUS_LABEL[k]}</span><b className="tabular-nums text-white">{idn(per[k])}</b>
    </span>
  );
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-[#8f99a8]">Alur:</span>
      <span className="text-[#abb3bf]">indikasi</span><Icon name="right" className="h-3 w-3 text-[#6b7586]" />
      {step("karantina", "menunggu audit")}<Icon name="right" className="h-3 w-3 text-[#6b7586]" />
      {step("diaudit", "diaudit agen penyidik atau auditor")}<Icon name="right" className="h-3 w-3 text-[#6b7586]" />
      {step("dibina", "kesalahan tanpa kesengajaan: perbaikan, pengembalian, sanksi administratif")}
      {step("ditindak", "fraud Terstruktur, Sistematis dan Masif: jalur hukum")}
      {step("dibebaskan", "audit tidak menemukan apa pun: keluar dari karantina")}
    </div>
  );
}

function TsmChips({ tsm }: { tsm: BoxFacility["tsm"] }) {
  return (
    <span className="flex gap-0.5">
      {(["terstruktur", "sistematis", "masif"] as const).map((d) => (
        <span key={d} title={`${d}: ${tsm[d].nilai} — ${tsm[d].bukti}`} className="w-4 rounded text-center text-[10px] font-semibold text-white" style={{ background: TSM_COLOR[tsm[d].nilai] }}>{d[0].toUpperCase()}</span>
      ))}
    </span>
  );
}

function FacilityTable({ rows, sel, onOpen, showGroup }: { rows: Row[]; sel: string | null; onOpen: (fid: string) => void; showGroup: boolean }) {
  const top = Math.max(1, ...rows.map((r) => r.estimasi_kerugian_rp));
  if (!rows.length) return <p className="px-3 py-6 text-center text-[#8f99a8]">Tidak ada faskes yang cocok.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-left text-[11.5px]">
        <thead className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">
          <tr className="border-b border-white/5">
            <th className="w-8 py-1.5 pl-3 font-medium">#</th>
            <th className="font-medium">Faskes</th>
            <th className="w-[190px] pr-4 text-right font-medium">Estimasi kerugian</th>
            <th className="pr-4 text-right font-medium">Klaim bertag</th>
            <th className="pr-4 font-medium">Indikasi</th>
            <th className="pr-4 font-medium" title="Terstruktur · Sistematis · Masif">TSM</th>
            <th className="pr-4 font-medium">Status</th>
            <th className="pr-3 font-medium">Rekomendasi agen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f, i) => {
            const rec = f.rekomendasi?.at(-1);
            return (
              <tr key={f.faskes_profil_id} id={`faskes-${f.faskes_profil_id}`} onClick={() => onOpen(f.faskes_profil_id)}
                className={`cursor-pointer border-b border-white/5 hover:bg-white/[.04] ${sel === f.faskes_profil_id ? "bg-[#b8a9ff]/10" : ""}`}>
                <td className="py-1.5 pl-3 align-top tabular-nums text-[#6b7586]">{showGroup ? <b style={{ color: GROUP_COLOR[f.kelompok] }}>{f.kelompok}</b> : i + 1}</td>
                <td className="max-w-[380px] py-1.5 pr-4 align-top">
                  <p className="flex items-center gap-1.5"><span className="truncate text-[#e5e8eb]" title={f.nama}>{title(f)}</span>
                    {f.klasifikasi === "Rahasia" && <span className="shrink-0 rounded bg-[#e5484d]/20 px-1 text-[9.5px] text-[#ffb4b4]" title="Klasifikasi Rahasia">Rahasia</span>}</p>
                  <p className="truncate text-[10.5px] text-[#8f99a8]">{place(f)}</p>
                </td>
                <td className="py-1.5 pr-4 text-right align-top">
                  <p className="font-semibold tabular-nums text-white">{rp(f.estimasi_kerugian_rp)}</p>
                  <div className="ml-auto mt-1 h-1 w-full max-w-[150px] overflow-hidden rounded bg-white/5">
                    <div className="ml-auto h-full rounded" style={{ width: `${(100 * f.estimasi_kerugian_rp) / top}%`, background: GROUP_COLOR[f.kelompok] }} />
                  </div>
                </td>
                <td className="py-1.5 pr-4 text-right align-top tabular-nums text-[#d3d8de]">{idn(f.klaim_bertag)}</td>
                <td className="py-1.5 pr-4 align-top">
                  <span className="flex items-center gap-1 whitespace-nowrap text-[#d3d8de]" title={`${f.kuat} kuat · ${f.sedang} sedang · ${f.lemah} lemah`}>
                    {idn(f.tag)} tag
                    {f.kuat > 0 && <span className="rounded px-1 text-[10px]" style={{ background: `${STRENGTH.kuat}33`, color: "#ffb4b4" }}>{f.kuat} kuat</span>}
                  </span>
                </td>
                <td className="py-1.5 pr-4 align-top"><TsmChips tsm={f.tsm} /></td>
                <td className="py-1.5 pr-4 align-top">
                  <span className="whitespace-nowrap rounded px-1.5 py-0.5 text-[10.5px]" style={{ background: `${STATUS_COLOR[f.status]}26`, color: STATUS_COLOR[f.status] }}>{STATUS_LABEL[f.status] ?? f.status}</span>
                </td>
                <td className="py-1.5 pr-3 align-top">{rec ? <b className={`font-medium ${PATH_TEXT[rec.jalur] ?? ""}`}>{rec.jalur}</b> : <span className="text-[#6b7586]">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// an engagement that kept only its summary: the facilities its investigators audited, with what they recommended
function Audited({ box, onOpen, sel }: { box: Box; onOpen: (fid: string) => void; sel: string | null }) {
  const rows = box.diaudit_penugasan ?? [];
  return (
    <section className="rounded border border-white/10 bg-[#1c2127]">
      <p className="border-b border-white/5 px-3 py-2"><span className="font-semibold text-[#e5e8eb]">Diaudit penyidik penugasan ini</span>
        <span className="text-[#8f99a8]"> · {rows.length} faskes; kelompok dan estimasi menurut box saat ini</span></p>
      {!rows.length ? <p className="px-3 py-6 text-center text-[#8f99a8]">Rekomendasi penyidik penugasan ini tidak lagi tersimpan di box (tiap faskes menyimpan 10 terakhir).</p> : rows.map((f) => {
        const r = f.rekomendasi.at(-1)!;
        return (
          <button key={f.faskes_profil_id} onClick={() => onOpen(f.faskes_profil_id)}
            className={`block w-full border-t border-white/5 px-3 py-2 text-left first:border-t-0 hover:bg-white/[.03] ${sel === f.faskes_profil_id ? "bg-[#b8a9ff]/10" : ""}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded px-1.5 text-[10.5px] font-bold text-black" style={{ background: GROUP_COLOR[f.kelompok] }}>{f.kelompok}</span>
              <span className="text-[#e5e8eb]">{title(f)}</span><span className="text-[10.5px] text-[#8f99a8]">{place(f)}</span>
              <span className="ml-auto tabular-nums text-white">{rp(f.estimasi_kerugian_rp)}</span>
            </div>
            <p className="mt-0.5 text-[11px] text-[#abb3bf]">Rekomendasi: <b className={PATH_TEXT[r.jalur] ?? ""}>{r.jalur}</b> · T {String(r.tsm?.terstruktur)} · S {String(r.tsm?.sistematis)} · M {String(r.tsm?.masif)} · {r.agen}</p>
            <p className="line-clamp-2 text-[11px] text-[#8f99a8]">{r.alasan}</p>
          </button>
        );
      })}
    </section>
  );
}

function Detail({ fid, run, older, onClose, onDecided }: { fid: string; run?: string; older: boolean; onClose: () => void; onDecided: () => void }) {
  const [f, setF] = useState<BoxFacility | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviews, setReviews] = useState<Record<string, { r?: { telaah: Review; pendapat_kedua?: Review; sepakat?: boolean; di_luar_prompt?: Record<string, unknown> }; busy?: boolean; err?: string }>>({});
  const load = () => fraud.facility(fid, run).then(setF).catch((e) => setErr((e as Error).message));
  useEffect(() => { setF(null); setErr(""); load(); }, [fid, run]);  // eslint-disable-line react-hooks/exhaustive-deps
  const decide = async (status: string) => {
    setBusy(true); setErr("");
    try { await fraud.decideFacility(fid, status, note); setNote(""); await load(); onDecided(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const review = async (kid: string, second = false) => {
    setReviews((m) => ({ ...m, [kid]: { busy: true } }));
    try { const r = await fraud.review(kid, second); setReviews((m) => ({ ...m, [kid]: { r } })); }
    catch (e) { setReviews((m) => ({ ...m, [kid]: { err: (e as Error).message } })); }
  };
  return (
    <aside className="flex w-[520px] shrink-0 flex-col overflow-y-auto border-l border-black/30 bg-[#1c2127] max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-10 max-lg:w-full">
      <div className="flex items-start gap-2 border-b border-white/5 p-3">
        {f && <span className="mt-0.5 rounded px-1.5 font-bold text-black" style={{ background: GROUP_COLOR[f.kelompok] }}>{f.kelompok}</span>}
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-white">{f ? title(f) : fid}</p>
          {f && <p className="text-[11px] text-[#abb3bf]">{place(f)} · {f.klaim_faskes.toLocaleString("id-ID")} klaim · <span className={f.klasifikasi === "Rahasia" ? "text-[#ffb4b4]" : "text-[#fbd38d]"}>{f.klasifikasi}</span></p>}
        </div>
        <button onClick={onClose} className="ml-auto rounded p-1 text-[#8f99a8] hover:bg-white/10"><Icon name="x" className="h-4 w-4" /></button>
      </div>
      {err && <p className="px-3 pt-2 text-red-300">{err}</p>}
      {f && (
        <div className="space-y-3 p-3">
          <section>
            <p className="mb-1 font-semibold text-[#e5e8eb]">Estimasi kerugian {rp(f.estimasi_kerugian_rp)} <span className="font-normal text-[#8f99a8]">(sudah dikoreksi {rp(f.sudah_dikoreksi_rp)})</span></p>
            {f.rincian_kerugian && (
              <div className="flex h-2 overflow-hidden rounded bg-white/5">
                {Object.entries(f.rincian_kerugian).filter(([, v]) => v > 0).map(([k, v], i) => (
                  <div key={k} title={`${k.replace(/_/g, " ")}: ${rp(v)}`} style={{ width: `${(100 * v) / Math.max(f.estimasi_kerugian_rp, 1)}%`, background: ["#3987e5", "#d95926", "#c98500", "#29a383"][i % 4] }} />
                ))}
              </div>
            )}
            <p className="mt-1 text-[10.5px] text-[#8f99a8]">{Object.entries(f.rincian_kerugian ?? {}).map(([k, v]) => `${k.replace(/_/g, " ")} ${rp(v)}`).join(" · ")}. Di atas tarif = tagihan di luar tarif INA-CBG + top-up; di atas peer = dibayar di atas 1,5× median peer setarif (bukan klaim COVID); klaim ganda = separuh nilai; ekspektasi model = peluang × tagihan × rasio koreksi median.</p>
          </section>
          <section className="rounded border border-white/10 p-2">
            <p className="mb-1 font-semibold text-[#e5e8eb]">TSM: Terstruktur, Sistematis, Masif</p>
            {(["terstruktur", "sistematis", "masif"] as const).map((d) => (
              <p key={d} className="text-[11px]"><span className="inline-block w-[86px] font-medium capitalize" style={{ color: TSM_COLOR[f.tsm[d].nilai] === "#4b5563" ? "#8f99a8" : TSM_COLOR[f.tsm[d].nilai] }}>{d}</span>{f.tsm[d].nilai} — <span className="text-[#abb3bf]">{f.tsm[d].bukti}</span></p>
            ))}
            <p className="mt-1 text-[11px] text-[#abb3bf]">Jalur awal dari data: <b>{f.jalur_awal}</b>{f.indikasi_tsm ? " (ketiga dimensi terpenuhi)" : " (ditindak hanya bila ketiganya terpenuhi)"}</p>
          </section>
          {f.rekomendasi?.length > 0 && (
            <section>
              <p className="mb-1 font-semibold text-[#e5e8eb]">Rekomendasi agen penyidik</p>
              {f.rekomendasi.map((r, i) => (
                <div key={i} className="mb-1 rounded bg-white/[.03] p-2 text-[11px]">
                  <p><b className={PATH_TEXT[r.jalur] ?? ""}>{r.jalur}</b> · {r.agen} · T {String(r.tsm?.terstruktur)} · S {String(r.tsm?.sistematis)} · M {String(r.tsm?.masif)}{r.t ? <span className="text-[#6b7586]"> · {wib(r.t)}</span> : null}</p>
                  <p className="whitespace-pre-wrap text-[#abb3bf]">{r.alasan}</p>
                </div>
              ))}
            </section>
          )}
          <section className="rounded border border-[#b8a9ff]/30 p-2">
            <p className="mb-1 font-semibold text-[#e5e8eb]">Keputusan audit (manusia)</p>
            {older && <p className="mb-1 text-[10.5px] text-[#8f99a8]">Angka di panel ini sesuai box penugasan yang dipilih. Keputusan berlaku untuk faskesnya di semua box.</p>}
            {f.keputusan && <p className="mb-1 text-[11px] text-[#abb3bf]">Terakhir: <b>{String((f.keputusan as Record<string, unknown>).status)}</b> oleh {String((f.keputusan as Record<string, unknown>).oleh)} · {String((f.keputusan as Record<string, unknown>).catatan ?? "")}</p>}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Catatan keputusan (temuan audit lapangan, dasar keputusan)…" className="w-full resize-none rounded-sm border border-white/15 bg-[#111418] px-2 py-1 text-[11.5px] outline-none" />
            <div className="mt-1 flex flex-wrap gap-1">
              {(["diaudit", "dibina", "ditindak", "dibebaskan"] as const).map((st) => (
                <button key={st} disabled={busy || (st === "ditindak" && !note.trim())} onClick={() => decide(st)} title={st === "ditindak" ? "Hanya untuk fraud Terstruktur, Sistematis dan Masif; tulis dasar keputusannya" : ""}
                  className="rounded border px-2 py-0.5 text-[11px] disabled:opacity-40" style={{ borderColor: `${STATUS_COLOR[st]}88`, color: STATUS_COLOR[st] }}>{STATUS_LABEL[st]}</button>
              ))}
            </div>
          </section>
          {f.klaim_kontributor && f.klaim_kontributor.length > 0 && (
            <section>
              <p className="mb-1 font-semibold text-[#e5e8eb]">Klaim penyumbang kerugian terbesar</p>
              {f.klaim_kontributor.map((c) => {
                const rv = reviews[c.klaim_id];
                return (
                  <div key={c.klaim_id} className="mb-1.5 rounded bg-white/[.03] p-2 text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10.5px] text-[#d3d8de]">{c.klaim_id}</span>
                      <span className="text-[#8f99a8]">{c.inacbg_kode} · LOS {c.los_hari ?? "—"}</span>
                      <span className="ml-auto tabular-nums text-white">{rp(c.nilai_rp)}</span>
                    </div>
                    <p className="text-[10.5px] text-[#8f99a8]">{c.komponen.replace(/_/g, " ")} · dibayar {rp(c.dibayar_rp)} · median peer {rp(c.peer_p50_rp)} · {c.tag.join(", ")}</p>
                    {!rv?.r && <div className="mt-1 flex gap-1">
                      <button disabled={rv?.busy} onClick={() => review(c.klaim_id)} className="rounded bg-[#5b5fd6] px-2 py-0.5 text-white disabled:opacity-40">{rv?.busy ? "LLM menelaah…" : "Telaah klinis (LLM)"}</button>
                      <button disabled={rv?.busy} onClick={() => review(c.klaim_id, true)} className="rounded border border-white/15 px-2 py-0.5 text-[#d3d8de] disabled:opacity-40" title="dua model dari keluarga berbeda">+ pendapat kedua</button>
                    </div>}
                    {rv?.err && <p className="text-red-300">{rv.err}</p>}
                    {rv?.r && <ReviewCard r={rv.r.telaah} second={rv.r.pendapat_kedua} agree={rv.r.sepakat} aside={rv.r.di_luar_prompt} />}
                  </div>
                );
              })}
            </section>
          )}
          {f.indikasi && f.indikasi.length > 0 && (
            <section>
              <p className="mb-1 font-semibold text-[#e5e8eb]">Indikasi saat ini ({f.indikasi.length})</p>
              {f.indikasi.slice(0, 60).map((t) => (
                <div key={t.id} className="border-t border-white/5 py-1 text-[11px]">
                  <p><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: STRENGTH[t.kekuatan] }} /><b className="text-[#e5e8eb]">{t.tag_label}</b> · {t.entitas} {t.judul.slice(0, 60)} · {t.kekuatan} · {t.dukungan} sumber{t.red_team ? ` · red team: ${t.red_team.hasil}` : ""}</p>
                  <p className="text-[10.5px] text-[#8f99a8]">{t.bukti}</p>
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </aside>
  );
}

export function ReviewCard({ r, second, agree, aside }: { r: Review; second?: Review; agree?: boolean; aside?: Record<string, unknown> }) {
  const v = VERDICT[r.kesimpulan];
  return (
    <div className="mt-1.5 rounded border border-white/10 bg-black/20 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-black" style={{ background: v?.color }}>{v?.label ?? r.label}</span>
        <span className="text-[10.5px] text-[#8f99a8]">{r.fallback ? "fallback deterministik" : r.model.split("/").pop()} · keyakinan {r.keyakinan}{r.detik != null ? ` · ${r.detik} s` : ""}</span>
        <span className={`text-[10.5px] ${r.lolos_gerbang_angka ? "text-[#7ee2c0]" : "text-[#ffb4b4]"}`} title="setiap angka di telaah harus ada di fakta klaim">{r.lolos_gerbang_angka ? "angka terverifikasi" : `angka tak terverifikasi: ${r.angka_tidak_terverifikasi.join(", ")}`}</span>
      </div>
      <p className="mt-1 text-[11.5px] text-[#e5e8eb]">{r.ringkasan}</p>
      {r.alasan_klinis.length > 0 && <List title="Alasan klinis" items={r.alasan_klinis} />}
      {r.kejanggalan.length > 0 && <List title="Kejanggalan" items={r.kejanggalan} color="#ffb4b4" />}
      {r.penjelasan_wajar.length > 0 && <List title="Penjelasan wajar" items={r.penjelasan_wajar} color="#7ee2c0" />}
      {r.dokumen_diperiksa.length > 0 && <p className="mt-1 text-[10.5px] text-[#abb3bf]"><b>Dokumen untuk diperiksa:</b> {r.dokumen_diperiksa.join("; ")}</p>}
      {second && <p className="mt-1 text-[10.5px] text-[#abb3bf]">Pendapat kedua ({second.model.split("/").pop()}): <b style={{ color: VERDICT[second.kesimpulan]?.color }}>{second.label}</b> — {agree ? "sepakat" : "TIDAK sepakat: periksa keduanya"}. {second.ringkasan}</p>}
      {aside && <p className="mt-1 text-[10px] text-[#6b7480]">Di luar prompt (tidak dilihat LLM): dikoreksi verifikator {String(aside.dikoreksi_verifikator)}{aside.selisih_rp ? `, selisih ${rp(Number(aside.selisih_rp))}` : ""}.</p>}
    </div>
  );
}

function List({ title, items, color }: { title: string; items: string[]; color?: string }) {
  return (
    <div className="mt-1">
      <p className="text-[10.5px] font-semibold" style={{ color: color ?? "#d3d8de" }}>{title}</p>
      <ul className="list-disc pl-4 text-[11px] text-[#c5cbd3]">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  );
}
