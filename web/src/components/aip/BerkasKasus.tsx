"use client";
import { useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { modelName, wib, type Rec } from "@/components/aip/aipRun";
import { GROUP_COLOR, STRENGTH, TSM_COLOR, type CaseClaim, type CaseFile, type Evidence } from "@/components/aip/fraudApi";
import { JejakData } from "@/components/aip/JejakData";
import { compact, fmtCell } from "@/components/aip/viz";

/* The case file of each facility the investigators audited, in the long report (api/aip/laporan_konsultan.case_files; the
   user, 2026-10-24: "cover detailed information like which doctor involved or something detail like that"). The sample
   holds no doctor identity: the nearest details are the care unit, the patients and the claims — each claim with its visit
   id (to pull the claim file, and its DPJP, from the facility) and the evidence in the words of the rule or agent that
   tagged it. Every figure comes from code; the claims are the Box's own top contributors, so they add up to its estimate. */

const idn = (n: number, d = 0) => n.toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const rp = (n?: number | null) => (n == null ? "—" : `Rp ${compact(Number(n))}`);
const JALUR: Record<string, string> = { ditindak: "#e5484d", dibina: "#fab219", dibebaskan: "#29a383" };
const TSM_ORDER = ["terstruktur", "sistematis", "masif"] as const;
const day = (s?: string | null) => (s ? fmtCell(s, "tanggal", "date") : "");

function Block({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="mb-1.5 flex items-baseline gap-2">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#8f99a8]">{title}</p>
        {aside && <span className="text-[10.5px] text-[#8f99a8]">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return <div className="flex justify-between gap-3 border-t border-white/[.04] py-0.5 text-[11.5px]"><span className="text-[#8f99a8]">{k}</span><span className="text-right tabular-nums text-[#e5e8eb]">{v}</span></div>;
}

function Chip({ color, children, title }: { color: string; children: ReactNode; title?: string }) {
  return <span title={title} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium" style={{ background: `${color}26`, color: "#e5e8eb", boxShadow: `inset 0 0 0 1px ${color}66` }}>{children}</span>;
}

// ------------------------------------------------------------------------------------------------ easier reading
// (the user, 2026-10-28, on a case file: "kadang di UI laporan baca ini pusing"): the agents' prose keeps every word, but
// its evidence references become small marks, claim ids recede, the amounts stand out, and long texts open on request

// [r827] / [r876, r877] / [r936/r964], a claim id (reguler:180760823V000320/321/322), an amount, a percentage or a multiple
const TOKEN = /(\[r\d+(?:\s*[,/]\s*r\d+)*\])|(\b[a-z_]+:[0-9A-Z]{8,}[0-9A-Z/]*)|(Rp\s?[\d.,]+(?:\s?(?:jt|juta|M|miliar|T|triliun|rb))?)|(\d+(?:[.,]\d+)?\s?[%×])/g;

/** An agent's text with its references as small marks (their codes on hover and on paper), ids muted, figures bold. */
function Rich({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const [all, ref, id, money, num] = m;
    const k = m.index;
    if (ref) {
      const codes = ref.slice(1, -1).split(/\s*[,/]\s*/);
      out.push(
        <sup key={k} title={`rujukan bukti: ${codes.join(", ")}`} className="ml-0.5 cursor-help rounded-sm bg-white/[.07] px-1 text-[9px] font-medium text-[#8f99a8]">
          <span className="lp-no-print">{codes.length > 1 ? `${codes.length} ref` : "ref"}</span>
          <span className="hidden print:inline">{codes.join(" ")}</span>
        </sup>,
      );
    } else if (id) out.push(<span key={k} className="font-mono text-[10.5px] text-[#8f99a8]">{id}</span>);
    else if (money || num) out.push(<b key={k} className="font-semibold text-white">{all}</b>);
    at = k + all.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/** The first sentence of a finding (its point), and the rest (the evidence behind it). */
function splitHead(text: string): [string, string] {
  const t = text.trim();
  if (t.length <= 200) return [t, ""];
  const end = /[.;](\s|$)/g;
  end.lastIndex = 25;
  const m = end.exec(t);
  if (m && m.index <= 240) return [t.slice(0, m.index + 1), t.slice(m.index + 1).trim()];
  const dash = t.indexOf(" — ", 25);
  if (dash > 0 && dash <= 240) return [t.slice(0, dash), t.slice(dash + 3).trim()];
  const cut = t.lastIndexOf(" ", 200);
  return [`${t.slice(0, cut)}…`, `…${t.slice(cut + 1)}`];
}

/** Who tagged it: the rule's name, or how many agents agreed (each one named on hover). */
function source(oleh: string) {
  const who = oleh.split(/\s*,\s*/).filter(Boolean);
  return who.length > 1 ? <span title={who.join(", ")}>{who.length} agen sepakat</span> : <span>{oleh.replace(/_/g, " ")}</span>;
}

function Finding({ e, open }: { e: Evidence; open: boolean }) {
  const [more, setMore] = useState(open);
  const [head, rest] = splitHead(String(e.teks ?? ""));
  return (
    <li className="rounded-md border border-white/[.06] bg-black/20 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: STRENGTH[e.kekuatan] ?? "#8f99a8" }} />
        <span className="text-[12.5px] font-semibold text-white">{e.indikasi}</span>
        <span className="rounded px-1.5 text-[10px] font-medium" style={{ color: STRENGTH[e.kekuatan] ?? "#8f99a8", boxShadow: `inset 0 0 0 1px ${STRENGTH[e.kekuatan] ?? "#8f99a8"}66` }}>{e.kekuatan}</span>
        <span className="text-[10.5px] text-[#8f99a8]">{source(String(e.oleh ?? ""))}</span>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-[#d3d8de]"><Rich text={head} /></p>
      {rest && more && <p className="mt-1 text-[11.5px] leading-relaxed text-[#abb3bf]"><Rich text={rest} /></p>}
      {rest && (
        <button onClick={() => setMore(!more)} className="lp-no-print mt-1 text-[10.5px] text-[#8abbff] hover:underline">{more ? "Ringkas" : "Bukti lengkap"}</button>
      )}
    </li>
  );
}

/** What a tag says, in its own words: its point first, the evidence behind it on request (all of it on paper). */
function EvidenceList({ items, empty, print = false }: { items: Evidence[]; empty: string; print?: boolean }) {
  if (!items.length) return <p className="text-[11.5px] text-[#8f99a8]">{empty}</p>;
  return (
    <ul className="space-y-2">
      {items.map((e, i) => <Finding key={i} e={e} open={print} />)}
    </ul>
  );
}

const TSM_MARK: Record<string, string> = { terpenuhi: "✓", sebagian: "◐", tidak: "–" };
const DIMS: Record<string, string> = { terstruktur: "Terstruktur", sistematis: "Sistematis", masif: "Masif" };
type Part = { dim?: string; status?: string; num?: string; text: string };

/** The investigator's reasoning in parts: its numbered sources, each TSM test with its verdict, the conclusion. The text
 *  is the model's own prose, so a part it does not mark stays one paragraph. */
function partsOf(text: string): Part[] {
  const at = /(?=\b(?:TERSTRUKTUR|SISTEMATIS|MASIF)\b|\b(?:Terstruktur|Sistematis|Masif)\s*=|\(\d\)\s|\b(?:Karena|Namun|Catatan|Kesimpulan|Rekomendasi)\b)/g;
  // "… [r827]. TSM: Terstruktur=…": the "TSM:" that introduced the tests is left at the end of the part before them
  return text.split(at).map((s) => s.trim().replace(/\s*TSM:\s*$/, "")).filter((s) => s.length > 5).map((s) => {
    const dim = /^(TERSTRUKTUR|SISTEMATIS|MASIF|Terstruktur|Sistematis|Masif)\b/.exec(s);
    if (dim) {
      const lead = s.slice(dim[0].length, dim[0].length + 40);
      const status = [...lead.matchAll(/terpenuhi|sebagian|tidak/gi)].pop()?.[0].toLowerCase();
      const body = s.slice(dim[0].length).replace(/^\s*(?:\(([^)]{0,30})\)|[:=]\s*[a-zA-Z→ ]{0,25}?(?=\s*[(—:–-]|\s))\s*[:—–-]?\s*/, "")
        .replace(/^\((.*)\)\.?$/s, "$1");  // "Terstruktur=sebagian (4 modus: …)." → its explanation without the brackets
      return { dim: dim[1].toLowerCase(), status, text: body || s };
    }
    const num = /^\((\d)\)\s*/.exec(s);
    return num ? { num: num[1], text: s.slice(num[0].length) } : { text: s.replace(/^TSM:\s*/, "") };
  });
}

function Assessment({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-[12px] leading-relaxed text-[#d3d8de]">
      {partsOf(text).map((p, i) =>
        p.dim ? (
          <div key={i} className="grid grid-cols-[118px_1fr] gap-2">
            <span className="h-fit rounded px-1.5 py-0.5 text-[11px] font-semibold text-white" style={{ background: `${TSM_COLOR[p.status ?? ""] ?? "#4b5563"}33`, boxShadow: `inset 0 0 0 1px ${TSM_COLOR[p.status ?? ""] ?? "#4b5563"}88` }}>
              {TSM_MARK[p.status ?? ""] ?? "·"} {DIMS[p.dim]}{p.status ? <span className="block text-[10px] font-normal text-[#c5cbd3]">{p.status}</span> : null}
            </span>
            <p><Rich text={p.text} /></p>
          </div>
        ) : p.num ? (
          <div key={i} className="flex gap-2">
            <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-white/10 text-[10px] font-semibold text-white">{p.num}</span>
            <p><Rich text={p.text} /></p>
          </div>
        ) : (
          <p key={i}><Rich text={p.text} /></p>
        ),
      )}
    </div>
  );
}

const RANK: Record<string, number> = { kuat: 3, sedang: 2, lemah: 1 };
// a chip's few words for the indications a case file shows most; any other label is cut at its first "(" or "/"
const SHORT: [RegExp, string][] = [[/^cloning/i, "Cloning"], [/^tagihan di atas tarif/i, "Di atas tarif"], [/^lama rawat/i, "LOS panjang"],
  [/^klaim ganda/i, "Klaim ganda"], [/^readmisi/i, "Readmisi"], [/^upcoding/i, "Upcoding"], [/^pemecahan episode/i, "Pecah episode"],
  [/kelas rawat/i, "Kelas rawat"], [/^konsensus/i, "Konsensus ML"], [/^koreksi berulang/i, "Koreksi berulang"], [/^lolos verifikasi/i, "Lolos verifikasi"]];
const short = (label: string) => SHORT.find(([re]) => re.test(label))?.[1] ?? label.split(" (")[0].split(" / ")[0];
const dot = (k: string) => <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: STRENGTH[k] ?? "#8f99a8" }} />;
type Line = { teks: string; kekuatan: string; oleh: string; klaim: string[] };

/** The claims behind a case file's loss (the user, 2026-10-28: the table with an evidence block under every claim read
 *  "agak pusing"): what every claim shares said once above; one line per claim with its indications as chips; the
 *  evidence below, grouped by indication, each text once with the claims it is about. A row and its evidence light
 *  up together on hover. */
function Claims({ claims }: { claims: CaseClaim[] }) {
  const [hot, setHot] = useState<string[]>([]);
  const same = <T,>(f: (c: CaseClaim) => T): T | undefined => (claims.every((c) => f(c) === f(claims[0])) ? f(claims[0]) : undefined);
  const kode = same((c) => c.inacbg_kode ?? ""), dx = same((c) => c.dx_primer ?? ""), parah = same((c) => c.keparahan ?? ""),
    kelas = same((c) => c.kelas_rawat ?? ""), peer = same((c) => c.peer_biaya_p50_rp ?? null), komponen = same((c) => c.komponen ?? "");
  const shared = [kode && [kode, dx].filter(Boolean).join(" · "), parah, kelas && `peserta ${kelas.toLowerCase()}`,
    peer != null && `median peer setarif ${rp(peer)}`].filter(Boolean) as string[];
  // the evidence once per text, with the claims it is about; the indications by their strongest evidence, then their reach
  const groups = new Map<string, Line[]>();
  for (const c of claims) {
    for (const e of c.bukti) {
      const lines = groups.get(e.indikasi) ?? [];
      const hit = lines.find((l) => l.teks === e.teks && l.kekuatan === e.kekuatan && l.oleh === e.oleh);
      if (hit) { if (!hit.klaim.includes(c.kunjungan_id)) hit.klaim.push(c.kunjungan_id); } else lines.push({ teks: e.teks, kekuatan: e.kekuatan, oleh: e.oleh, klaim: [c.kunjungan_id] });
      groups.set(e.indikasi, lines);
    }
  }
  const top = (ls: Line[]) => Math.max(...ls.map((l) => RANK[l.kekuatan] ?? 0));
  const reach = (ls: Line[]) => new Set(ls.flatMap((l) => l.klaim)).size;
  const order = [...groups.entries()].sort((a, b) => top(b[1]) - top(a[1]) || reach(b[1]) - reach(a[1]));
  const chips = (c: CaseClaim) => {
    const best = new Map<string, string>();
    for (const e of c.bukti) if ((RANK[e.kekuatan] ?? 0) > (RANK[best.get(e.indikasi) ?? ""] ?? 0)) best.set(e.indikasi, e.kekuatan);
    return order.filter(([k]) => best.has(k)).map(([k]) => [k, best.get(k)!] as const);
  };
  const lit = (ids: string[]) => ids.some((id) => hot.includes(id));
  const head = "whitespace-nowrap px-2 py-1.5 font-medium";
  return (
    <div className="space-y-2.5">
      <div className="space-y-1.5 rounded border border-white/5 bg-black/20 px-3 py-2 text-[11.5px]">
        {shared.length > 0 && <p className="text-[#c5cbd3]"><span className="text-[#8f99a8]">Sama di {claims.length === 1 ? "klaim ini" : `${claims.length} klaim`}:</span> {shared.join(" · ")}</p>}
        {komponen && <p className="text-[#c5cbd3]"><span className="text-[#8f99a8]">Estimasi kerugian tiap klaim:</span> {komponen.toLowerCase()}</p>}
        {order.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[#8f99a8]">Indikasi:</span>
            {order.map(([k, ls]) => (
              <span key={k} className="inline-flex items-center gap-1.5 rounded border border-white/10 px-1.5 py-0.5 text-[#e5e8eb]" title={k}>
                {dot(Object.keys(RANK).find((s) => RANK[s] === top(ls)) ?? "lemah")}{short(k)} <span className="tabular-nums text-[#8f99a8]">{reach(ls)} klaim</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="overflow-x-auto rounded border border-white/5">
        <table className="w-full min-w-[780px] text-[11.5px]">
          <thead className="bg-[#20262d] text-left text-[#abb3bf]">
            <tr>
              <th className={head}>ID kunjungan</th><th className={head}>Rawat</th>{kode === undefined && <th className={head}>INA-CBG · diagnosis</th>}
              <th className={head}>Peserta</th><th className={`${head} text-right`}>Tagihan</th><th className={`${head} text-right`} title="tagihan ÷ median peer setarif">× peer</th>
              <th className={head}>Indikasi</th><th className={`${head} text-right`}>Estimasi kerugian</th>
            </tr>
          </thead>
          <tbody>
            {claims.map((c, i) => (
              <tr key={`${c.kunjungan_id}-${i}`} onMouseEnter={() => setHot([c.kunjungan_id])} onMouseLeave={() => setHot([])}
                className={`border-t border-white/[.06] ${lit([c.kunjungan_id]) ? "bg-[#9d8cff]/10" : ""}`}>
                <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-white" title={c.di_skrining ? c.edisi ?? "" : "di luar skrining: ditemukan dari Data Bersih"}>
                  {c.kunjungan_id}{c.di_skrining ? null : <span className="ml-1 font-sans text-[10px] text-[#8f99a8]">luar skrining</span>}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-[#e5e8eb]">
                  {c.tgl_datang ? `${day(c.tgl_datang)}${c.tgl_pulang ? ` – ${day(c.tgl_pulang)}` : ""}` : c.bulan ? fmtCell(c.bulan, "bulan") : "—"}
                  {c.los_hari != null && <span className="ml-1.5 tabular-nums text-[#8f99a8]">{idn(Number(c.los_hari))} hr</span>}
                </td>
                {kode === undefined && <td className="max-w-[220px] truncate px-2 py-1.5 text-[#e5e8eb]" title={[c.inacbg_kode, c.keparahan, c.dx_primer].filter(Boolean).join(" · ")}>
                  {c.inacbg_kode ?? "—"}{c.dx_primer && <span className="text-[#8f99a8]"> · {c.dx_primer}</span>}</td>}
                <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-[#c5cbd3]">{c.peserta_id ?? "—"}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-[#e5e8eb]"
                  title={c.biaya_verifikasi_rp != null && c.biaya_verifikasi_rp !== c.biaya_tagih_rp ? `verifikasi ${rp(c.biaya_verifikasi_rp)}` : "dibayar penuh"}>{rp(c.biaya_tagih_rp)}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-[#e5e8eb]" title={peer == null ? `median peer ${rp(c.peer_biaya_p50_rp)}` : undefined}>
                  {c.rasio_biaya_peer ? `${idn(Number(c.rasio_biaya_peer), 1)}×` : "—"}
                </td>
                <td className="px-2 py-1.5">
                  <span className="flex flex-wrap gap-x-2.5 gap-y-0.5">
                    {chips(c).map(([k, s]) => <span key={k} className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-[#d3d8de]" title={`${k} · ${s}`}>{dot(s)}{short(k)}</span>)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums" title={komponen ? undefined : c.komponen ?? undefined}>
                  <span className="font-semibold text-white">{rp(c.estimasi_kerugian_rp)}</span>
                  {!komponen && c.komponen && <span className="block text-[10px] text-[#8f99a8]">{c.komponen}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {order.length > 0 && (
        <div className="space-y-2.5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#8f99a8]">Bukti per indikasi</p>
          {order.map(([k, ls]) => {
            // a strength and source every line of the indication shares: said once, in its heading
            const one = ls.every((l) => l.kekuatan === ls[0].kekuatan && l.oleh === ls[0].oleh);
            return (
              <div key={k}>
                <p className="flex flex-wrap items-center gap-x-1.5 text-[11.5px] font-medium text-[#e5e8eb]">{k}
                  <span className="font-normal text-[#8f99a8]">· {reach(ls)} klaim{one ? ` · ${ls[0].kekuatan} · ${ls[0].oleh}` : ""}</span></p>
                <ul className="mt-0.5 space-y-0.5">
                  {ls.map((l, j) => (
                    <li key={j} onMouseEnter={() => setHot(l.klaim)} onMouseLeave={() => setHot([])}
                      className={`grid grid-cols-[auto_1fr] gap-x-2 rounded px-1.5 py-1 text-[11.5px] leading-snug ${lit(l.klaim) ? "bg-[#9d8cff]/10" : ""}`}>
                      <span className="mt-[5px]" title={l.kekuatan}>{dot(l.kekuatan)}</span>
                      <span className="min-w-0">
                        <span className="mr-1.5 font-mono text-[10.5px] text-[#c9c0ff]">{l.klaim.join(", ")}</span>
                        <span className="text-[#c5cbd3]">{l.teks}</span>
                        {!one && <span className="ml-1.5 whitespace-nowrap text-[10.5px] text-[#8f99a8]">{l.kekuatan} · {l.oleh}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Patients({ f }: { f: CaseFile }) {
  const rows = f.peserta.berulang;
  return (
    <>
      <p className="text-[11.5px] text-[#d3d8de]">{idn(f.peserta.jumlah)} peserta di balik {idn(f.peserta.klaim_berisiko)} klaim berisiko{rows.length ? `; ${rows.length} dengan lebih dari satu klaim:` : "; tidak ada peserta berulang."}</p>
      {rows.length > 0 && (
        <table className="mt-1 w-full text-[11px]">
          <thead className="text-left text-[#8f99a8]"><tr><th className="py-0.5 font-normal">Peserta</th><th className="font-normal">Profil</th><th className="text-right font-normal">Klaim</th><th className="text-right font-normal">Tagihan</th><th className="text-right font-normal">Readmisi ≤30 hr</th></tr></thead>
          <tbody>
            {rows.map((p: Rec, i) => (
              <tr key={i} className="border-t border-white/[.04] text-[#e5e8eb]">
                <td className="py-0.5 font-mono">{String(p.peserta_id ?? "—")}</td>
                <td className="text-[#c5cbd3]">{[p.jenis_kelamin === "LAKI-LAKI" ? "L" : p.jenis_kelamin === "PEREMPUAN" ? "P" : p.jenis_kelamin, p.usia != null ? `${p.usia} th` : "", p.segmen].filter(Boolean).join(" · ")}</td>
                <td className="text-right tabular-nums">{idn(Number(p.klaim))}</td>
                <td className="text-right tabular-nums">{rp(Number(p.biaya_tagih_rp))}</td>
                <td className="text-right tabular-nums">{idn(Number(p.readmisi_30))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function CaseFileCard({ f, name, open, run, top, print }: { f: CaseFile; name: string; open: boolean; run: string; top: boolean; print: boolean }) {
  const jal = f.penyidik?.jalur;
  const p = f.profil;
  const parts = Object.entries(f.kerugian.rincian).filter(([, v]) => v > 0);
  // the recommendation rests on the investigator's TSM; the Box's own rule (code) may read it lower, and is named apart
  const tsm: Record<string, string | null | undefined> = f.penyidik?.tsm ?? f.tsm;
  const ruleDiffers = !!f.penyidik?.tsm && TSM_ORDER.some((d) => f.penyidik?.tsm?.[d] !== f.tsm[d]);
  // the summary a leader reads first: the loss against the bills, the risky claims, the strongest indication, the call
  const bills = Number(p.biaya_tagih_rp) || 0, claimN = Number(p.klaim_fkrtl) || 0, risky = Number(p.klaim_berisiko) || 0;
  const lead = [...f.modus].sort((x, y) => y.kuat - x.kuat || y.total - x.total)[0];
  const tsmPill = (d: (typeof TSM_ORDER)[number]) => (
    <span key={d} title={`${DIMS[d]}: ${tsm[d] ?? "-"}`} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-[#e5e8eb]"
      style={{ background: `${TSM_COLOR[String(tsm[d])] ?? "#4b5563"}26`, boxShadow: `inset 0 0 0 1px ${TSM_COLOR[String(tsm[d])] ?? "#4b5563"}66` }}>
      {TSM_MARK[String(tsm[d])] ?? "·"} {DIMS[d]}
    </span>
  );
  const tile = (label: string, value: ReactNode, sub?: ReactNode) => (
    <div className="rounded-md border border-white/[.06] bg-black/20 px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.1em] text-[#8f99a8]">{label}</p>
      <p className="mt-0.5 text-[15px] font-semibold leading-snug text-white">{value}</p>
      {sub && <div className="text-[11px] leading-snug text-[#abb3bf]">{sub}</div>}
    </div>
  );
  return (
    <details id={`berkas-${f.faskes_profil_id}`} open={open} className="lp-berkas group scroll-mt-4 rounded-lg border border-white/[.08] bg-[#1c2127]">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="rounded px-1.5 py-0.5 text-[11px] font-bold text-[#111418]" style={{ background: GROUP_COLOR[f.kelompok] ?? "#8f99a8" }} title={`kelompok ${f.kelompok} Box Karantina`}>{f.kelompok}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-white" title={f.nama}>{name}</span>
          <span className="text-[11px] text-[#8f99a8]">{[f.kabkota, f.provinsi].filter(Boolean).join(", ")} · {String(p.tipe ?? "")} · {String(p.kepemilikan ?? "")}</span>
        </span>
        <span className="text-right"><span className="block text-[14px] font-semibold tabular-nums text-white">{rp(f.kerugian.estimasi_rp)}</span><span className="text-[10px] text-[#8f99a8]">estimasi kerugian</span></span>
        {jal && <Chip color={JALUR[jal] ?? "#8f99a8"} title="rekomendasi jalur penyidik; keputusan akhir di tangan manusia">{jal}</Chip>}
        <span className="flex gap-1" title={`${f.penyidik?.tsm ? "TSM menurut penyidik" : "TSM menurut aturan Box (kode)"}: ✓ terpenuhi · ◐ sebagian · – tidak`}>{TSM_ORDER.map(tsmPill)}</span>
        <Icon name="down" className="lp-no-print h-3.5 w-3.5 text-[#8f99a8] transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-5 border-t border-white/[.06] p-4">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {tile("Estimasi kerugian", rp(f.kerugian.estimasi_rp), bills ? `${idn((100 * f.kerugian.estimasi_rp) / bills, 1)}% dari tagihan ${rp(bills)}` : undefined)}
          {tile("Klaim berisiko", `${idn(risky)} dari ${idn(claimN)}`, claimN ? `${idn((100 * risky) / claimN, 1)}% klaim faskes ini` : undefined)}
          {tile("Indikasi terkuat", lead ? lead.modus : "—", lead ? `${idn(lead.total)} tag${lead.kuat ? `, ${idn(lead.kuat)} kuat` : ""}` : undefined)}
          {tile("Rekomendasi penyidik", jal ? <span style={{ color: JALUR[jal] ?? "#e5e8eb" }}>{jal[0].toUpperCase() + jal.slice(1)}</span> : "Belum diaudit",
            <span className="mt-1 flex flex-wrap gap-1">{TSM_ORDER.map(tsmPill)}</span>)}
        </div>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <Block title="Penilaian penyidik" aside={f.penyidik ? `${f.penyidik.agen ?? ""} · ${modelName(f.penyidik.model)} · ${wib(f.penyidik.pada)}` : undefined}>
            {f.penyidik ? (
              <>
                {ruleDiffers && (
                  <p className="mb-2 text-[10.5px] text-[#8f99a8]" title="penilaian awal Box Karantina dari aturan kode (modus, layanan, kode, jaringan; bulan dan koreksi), sebelum audit penyidik">
                    Aturan Box (kode): {TSM_ORDER.map((d) => `${d} ${f.tsm[d] ?? "-"}`).join(" · ")}
                  </p>
                )}
                <div className="rounded-md bg-black/20 px-3 py-2.5"><Assessment text={String(f.penyidik.alasan ?? "")} /></div>
              </>
            ) : <p className="text-[11.5px] text-[#8f99a8]">Belum diaudit penyidik.</p>}
          </Block>
          <div className="space-y-4">
            <Block title="Kerugian">
              <Row k="Estimasi kerugian" v={<b className="text-white">{rp(f.kerugian.estimasi_rp)}</b>} />
              <Row k="Sudah dikoreksi verifikator" v={rp(f.kerugian.sudah_dikoreksi_rp)} />
              <Row k="Nilai terpapar" v={rp(f.kerugian.terpapar_rp)} />
              {parts.map(([k, v]) => <Row key={k} k={`· ${k}`} v={rp(v)} />)}
            </Block>
            <Block title="Profil faskes">
              <Row k="Tipe · jenis" v={`${String(p.tipe ?? "—")} · ${String(p.jenis ?? "—")}`} />
              <Row k="Kepemilikan" v={String(p.kepemilikan ?? "—")} />
              <Row k="Klaim FKRTL" v={p.klaim_fkrtl != null ? idn(Number(p.klaim_fkrtl)) : "—"} />
              <Row k="Klaim rawat inap" v={p.klaim_inap != null ? idn(Number(p.klaim_inap)) : "—"} />
              <Row k="Readmisi ≤30 hari" v={p.pct_readmisi_30 != null ? `${idn(Number(p.pct_readmisi_30), 1)}%` : "—"} />
              <Row k="Klaim berisiko · bertag" v={`${p.klaim_berisiko != null ? idn(Number(p.klaim_berisiko)) : "—"} · ${f.klaim_bertag != null ? idn(f.klaim_bertag) : "—"}`} />
              <Row k="Total tagihan" v={rp(Number(p.biaya_tagih_rp))} />
              <Row k="Status audit" v={f.status ?? "—"} />
            </Block>
          </div>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <Block title="Temuan tingkat faskes"><EvidenceList items={f.temuan_faskes} print={print} empty="Tidak ada tag pada faskes itu sendiri; indikasinya ada pada klaim-klaimnya." /></Block>
          <div className="space-y-4">
            <Block title="Modus indikasi">
              <div className="space-y-1">
                {f.modus.map((m) => (
                  <div key={m.modus} className="flex items-center gap-2 text-[11.5px]">
                    <span className="min-w-0 flex-1 truncate text-[#e5e8eb]">{m.modus}</span>
                    <span className="flex h-[10px] w-28 shrink-0 gap-[2px] overflow-hidden rounded-r-[4px]" title={`kuat ${m.kuat} · sedang ${m.sedang} · lemah ${m.lemah}`}>
                      {(["kuat", "sedang", "lemah"] as const).filter((k) => m[k] > 0).map((k) => <span key={k} style={{ width: `${(100 * m[k]) / m.total}%`, background: STRENGTH[k] }} />)}
                    </span>
                    <span className="w-24 shrink-0 text-right tabular-nums text-[#c5cbd3]">{idn(m.total)} tag{m.kuat ? ` · ${m.kuat} kuat` : ""}</span>
                  </div>
                ))}
              </div>
            </Block>
            <Block title="Unit layanan (poli)" aside={`tercatat pada ${f.poli_tercatat}`}>
              {f.poli.length ? (
                <table className="w-full text-[11px]">
                  <thead className="text-left text-[#8f99a8]"><tr><th className="py-0.5 font-normal">Poli</th><th className="text-right font-normal">Klaim berisiko</th><th className="text-right font-normal">Tagihan</th><th className="text-right font-normal">Estimasi kerugian</th></tr></thead>
                  <tbody>{f.poli.map((u) => (
                    <tr key={u.poli} className="border-t border-white/[.04] text-[#e5e8eb]"><td className="py-0.5">{u.poli}</td><td className="text-right tabular-nums">{idn(u.klaim_berisiko)}</td>
                      <td className="text-right tabular-nums">{rp(u.biaya_tagih_rp)}</td><td className="text-right tabular-nums">{rp(u.estimasi_kerugian_rp)}</td></tr>))}</tbody>
                </table>
              ) : <p className="text-[11.5px] text-[#8f99a8]">Poli tidak tercatat pada klaim berisiko faskes ini (rawat inap di data sampel umumnya tanpa poli).</p>}
            </Block>
            <Block title="Peserta"><Patients f={f} /></Block>
          </div>
        </div>
        <Block title="Klaim di balik estimasi kerugian" aside={`${f.klaim.length} klaim teratas menurut aturan Box${f.porsi_klaim_pct != null ? ` = ${idn(f.porsi_klaim_pct, 1)}% estimasi kerugian faskes ini` : ""}`}>
          {f.klaim.length ? <Claims claims={f.klaim} /> : <p className="text-[11.5px] text-[#8f99a8]">Tidak ada klaim bernilai kerugian (semua sudah dikoreksi atau tanpa komponen).</p>}
        </Block>
        {f.klaim.length > 0 && (
          <JejakData run={run} fid={f.faskes_profil_id} open={top} print={print}
            claims={f.klaim.map((c) => ({ id: `${c.edisi}:${c.kunjungan_id}`, label: `${c.kunjungan_id} · ${c.estimasi_kerugian_rp != null ? `Rp ${compact(Number(c.estimasi_kerugian_rp))}` : "—"}` }))} />
        )}
      </div>
    </details>
  );
}

/** Every case file, the first two open (all of them on paper); the parts every name shares said once. */
export function CaseFiles({ files, note, print = false, run }: { files: CaseFile[]; note?: string; print?: boolean; run: string }) {
  // the file with the largest loss opens its data lineage by default; the others keep it folded (the user, 2026-10-24)
  const top = files.reduce<CaseFile | null>((b, f) => (!b || f.kerugian.estimasi_rp > b.kerugian.estimasi_rp ? f : b), null)?.faskes_profil_id;
  const [all, setAll] = useState<boolean | null>(null);
  const parts = files.map((f) => String(f.nama ?? "").split(" · "));
  let k = 0;
  while (parts.length > 1 && parts.every((p) => p.length > k + 1 && p[k] === parts[0][k])) k++;
  return (
    <div className="mt-3 space-y-3">
      <div className="lp-info flex flex-wrap items-start gap-3 rounded border border-[#3987e5]/30 bg-[#3987e5]/[.06] p-3 text-[12px] leading-relaxed text-[#d3d8de]">
        <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0 text-[#8abbff]" />
        <p className="min-w-0 flex-1 text-justify [text-justify:inter-word]">{files.length} faskes diaudit penyidik di penugasan ini, urut kelompok Box Karantina dan estimasi kerugian; tiap berkas memuat profil, kerugian, penilaian penyidik lengkap, temuan dengan buktinya, unit layanan, peserta dan klaim di baliknya. {note}</p>
        <button onClick={() => setAll((a) => !(a ?? false))} className="lp-no-print shrink-0 rounded border border-white/15 px-2 py-0.5 text-[11px] text-[#d3d8de] hover:bg-white/10">{all ? "Tutup semua" : "Buka semua"}</button>
      </div>
      {k > 0 && <p className="text-[10.5px] text-[#8f99a8]">Semua: {parts[0].slice(0, k).join(" · ")}</p>}
      {files.map((f, i) => <CaseFileCard key={`${f.faskes_profil_id}-${all}`} f={f} name={parts[i].slice(k).join(" · ")} open={print || (all ?? i < 2)}
        run={run} top={f.faskes_profil_id === top} print={print} />)}
    </div>
  );
}
