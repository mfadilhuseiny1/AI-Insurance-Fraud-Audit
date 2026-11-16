"use client";
import { useEffect, useMemo, useState } from "react";
import { Widget } from "@/components/demo/audit/Workspace";
import { fraudApi } from "./api";
import { Gauge, Timeline } from "./charts";
import { rp, type AnyRec } from "./types";
import { ScoreBar, Section, StateMsg, ToneBadge, inputCls } from "./ui";

const KC = ["", "KC Contoh Kota", "KC Contoh Kabupaten", "Nasional"];
const DECISIONS = ["Dalam Investigasi", "Menunggu Bukti", "Eskalasi", "Selesai - Terbukti", "Selesai - Tidak Terbukti"];

export function CasesPanel({ onMsg }: { onMsg: (m: string) => void }) {
  const [cases, setCases] = useState<AnyRec[] | null>(null);
  const [open, setOpen] = useState<AnyRec | null>(null);
  const [q, setQ] = useState("");
  const [kc, setKc] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const load = () => fraudApi.cases(50, 0).then((x) => { setCases(x.cases); setOpen((o) => x.cases.find((c: AnyRec) => c.id === o?.id) ?? x.cases[0] ?? null); }, (e: Error) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const shown = useMemo(() => (cases ?? []).filter((c) => (!kc || c.kantor_cabang === kc) && (!q || `${c.judul} ${c.id} ${c.nama_faskes}`.toLowerCase().includes(q.toLowerCase()))), [cases, q, kc]);
  const decide = async (status: string) => {
    if (!open) return;
    try { await fraudApi.caseDecision(open.id, status); onMsg(`Kasus ${open.id} → ${status}. Tersimpan persisten & tercatat di audit trail.`); load(); }
    catch (e) { setErr((e as Error).message); }
  };
  if (err && !cases) return <StateMsg kind="error" text={err} />;
  if (!cases) return <StateMsg kind="loading" text="Memuat kasus investigasi…" />;
  return (
    <div className="grid items-start gap-3 xl:grid-cols-[430px_1fr]">
      <Widget title="Antrian kasus" caption="Alert yang sudah menjadi kasus — klik untuk membuka berkasnya" bodyClass="p-2.5"
        right={<span className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] tabular-nums text-muted">{shown.length} kasus</span>}>
        <div className="mb-2 flex gap-1.5">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari kasus / faskes…" className={`${inputCls} min-w-0 flex-1`} />
          <select value={kc} onChange={(e) => setKc(e.target.value)} className={inputCls} aria-label="Kantor cabang">
            {KC.map((k) => <option key={k} value={k}>{k || "Semua KC"}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          {shown.map((c) => (
            <button key={c.id} type="button" onClick={() => setOpen(c)} className={`w-full rounded-lg p-3 text-left transition ${open?.id === c.id ? "bg-ocean/15 ring-1 ring-ocean/50" : "bg-panel-2/50 hover:bg-panel-2"}`}>
              <span className="flex items-center gap-2"><span className="font-mono text-[11px] text-muted">{c.id}</span><ToneBadge text={c.prioritas} /><span className="ml-auto"><ScoreBar value={c.skor_risiko} /></span></span>
              <span className="mt-1.5 block text-[13px] font-medium leading-snug">{c.judul}</span>
              <span className="mt-1 block text-[11px] text-muted">{c.jumlah_klaim} klaim · {rp(c.estimasi_kerugian_rp)} · {c.kantor_cabang} · {c.status}</span>
            </button>
          ))}
          {!shown.length && <StateMsg kind="empty" text="Tidak ada kasus pada saringan ini." />}
        </div>
      </Widget>
      {open ? (
        <Widget title={open.judul} caption={`${open.id} · ${open.dibuat_dari}`} right={<ToneBadge text={open.status} />}
          >
          <div className="mb-4 flex flex-wrap items-center gap-4 rounded-lg bg-panel-2/60 p-3">
            <Gauge value={open.skor_risiko} />
            <div className="grid flex-1 grid-cols-3 gap-3 text-center">
              <div><div className="text-lg font-bold tabular-nums">{open.jumlah_klaim}</div><div className="text-[11px] text-muted">klaim terkait</div></div>
              <div><div className="text-lg font-bold tabular-nums">{rp(open.estimasi_kerugian_rp)}</div><div className="text-[11px] text-muted">estimasi kerugian</div></div>
              <div><div className="text-lg font-bold tabular-nums">{open.sla_jam} jam</div><div className="text-[11px] text-muted">SLA investigasi</div></div>
            </div>
          </div>
          <Section title="Kronologi"><Timeline items={open.kronologi} /></Section>
          <Section title="Bukti pendukung">
            <div className="grid gap-1.5 sm:grid-cols-2">{open.bukti.map((b: AnyRec, i: number) => (
              <div key={i} className="rounded-md bg-panel-2/60 p-2.5 text-xs"><div className="font-semibold">{b.jenis}</div><div className="mt-0.5 leading-relaxed text-muted">{b.detail}</div><div className="mt-1 text-[10px] text-muted">{b.sumber}</div></div>
            ))}</div>
          </Section>
          <Section title="Relasi pihak terkait">{open.relasi_jaringan.map((r: AnyRec) => <p key={r.id} className="mb-1 rounded-md bg-bad/10 p-2.5 text-xs"><b>{r.pola}</b> — <span className="text-soft">{r.penjelasan}</span></p>)}</Section>
          <Section title="Rekomendasi langkah berikutnya"><ol className="list-decimal space-y-1 pl-4">{open.rekomendasi.map((r: string, i: number) => <li key={i} className="text-xs leading-relaxed text-soft">{r}</li>)}</ol></Section>
          <Section title="Keputusan investigator">
            <div className="flex flex-wrap gap-1.5">{DECISIONS.map((d) => (
              <button key={d} type="button" onClick={() => decide(d)} className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium ${open.status === d ? "bg-ocean text-white" : "bg-panel-2 text-soft hover:ring-1 hover:ring-ocean/60"}`}>{d}</button>
            ))}</div>
            <p className="mt-1.5 text-[11px] text-muted">Keputusan tersimpan persisten (Tahap 2) dan masuk audit trail.</p>
          </Section>
        </Widget>
      ) : <StateMsg kind="empty" text="Pilih kasus di antrian." />}
    </div>
  );
}

const NODE_FILL: Record<string, string> = { "Perusahaan Induk": "#f0616d", Dokter: "#3d8bfd", Peserta: "#5b6b82", "Rumah Sakit": "#f0a843", Klinik: "#f0a843", FKTP: "#e2b866", Laboratorium: "#34c38f", Apotek: "#34c38f" };

export function GraphPanel() {
  const [g, setG] = useState<AnyRec | null>(null);
  const [focus, setFocus] = useState<AnyRec | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { fraudApi.graph(400).then(setG, (e: Error) => setErr(e.message)); }, []);
  const ringMembers = useMemo(() => new Set((g?.networks ?? []).flatMap((n: AnyRec) => n.anggota)), [g]);
  const view = focus ?? g;
  const byId = useMemo(() => new Map<string, AnyRec>(((view?.nodes ?? []) as AnyRec[]).map((n) => [n.id, n] as [string, AnyRec])), [view]);
  const pick = async (id: string) => {
    try { setFocus(await fraudApi.subgraph(id, 1)); } catch (e) { setErr((e as Error).message); }
  };
  if (err && !g) return <StateMsg kind="error" text={err} />;
  if (!g || !view) return <StateMsg kind="loading" text="Memuat graf jaringan…" />;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        {g.networks.map((n: AnyRec) => (
          <button key={n.id} type="button" onClick={() => pick(n.anggota[0])} className="rounded-lg bg-bad/10 p-3.5 text-left ring-1 ring-bad/30 transition hover:ring-bad/70">
            <div className="flex items-center justify-between gap-2"><span className="text-[13px] font-semibold text-bad">{n.pola}</span><span className="rounded bg-bad/20 px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-bad">×{n.kekuatan}</span></div>
            <p className="mt-1 text-xs leading-relaxed text-soft">{n.penjelasan}</p>
            <p className="mt-2 font-mono text-[10.5px] text-muted">{n.anggota.join(" · ")}</p>
          </button>
        ))}
      </div>
      <Widget title={focus ? `Subgraf sekitar ${focus.pusat} — kedalaman ${focus.kedalaman}` : "Graf relasi banyak pihak"}
        caption="Klik node faskes/dokter untuk memuat subgrafnya saja (query Tahap 3, bukan full-graph)"
        right={focus ? <button type="button" onClick={() => setFocus(null)} className="rounded-md bg-panel-2 px-2 py-1 text-[11px] text-soft hover:ring-1 hover:ring-ocean/60">Lihat semua</button> : undefined} bodyClass="p-0">
        <svg viewBox="0 0 800 500" className="w-full" role="img" aria-label="Graf relasi fraud">
          {view.edges.map((e: AnyRec, i: number) => {
            const a = byId.get(e.source), b = byId.get(e.target);
            const hot = ringMembers.has(e.source) && ringMembers.has(e.target);
            return a && b ? <line key={i} x1={a.x * 800} y1={a.y * 500} x2={b.x * 800} y2={b.y * 500} stroke={hot ? "#f0616d" : "#2a3647"} strokeWidth={hot ? 1.4 : 0.6} opacity={hot ? 0.85 : 1} /> : null;
          })}
          {view.nodes.map((n: AnyRec) => {
            const hot = ringMembers.has(n.id);
            return (
              <g key={n.id} onClick={() => n.jenis !== "Peserta" && pick(n.id)} className={n.jenis !== "Peserta" ? "cursor-pointer" : ""}>
                <circle cx={n.x * 800} cy={n.y * 500} r={hot ? 8 : n.jenis === "Peserta" ? 2.5 : 5.5} fill={NODE_FILL[n.jenis] ?? "#8391a7"} stroke={hot ? "#f0616d" : "none"} strokeWidth={hot ? 2 : 0} />
                {n.jenis !== "Peserta" && <text x={n.x * 800 + 9} y={n.y * 500 + 3} fill="#c3ccda" fontSize="9.5" fontWeight={hot ? 700 : 400}>{n.id}</text>}
              </g>
            );
          })}
        </svg>
        <div className="flex flex-wrap gap-3 border-t border-line px-3 py-2 text-[11px] text-muted">
          {Object.entries(NODE_FILL).map(([k, v]) => <span key={k} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: v }} />{k}</span>)}
          <span className="ml-auto text-bad">Garis &amp; node merah = anggota jaringan kolusi</span>
        </div>
      </Widget>
    </div>
  );
}
