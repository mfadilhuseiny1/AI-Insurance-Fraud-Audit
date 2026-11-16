"use client";
import { useEffect, useState } from "react";
import type { Rec } from "@/components/aip/aipRun";
import { fraud } from "@/components/aip/fraudApi";

/* The evidence ladder ("each step supports a broader claim, and none shows everything") and the
   designed audit of a pilot (api/aip/karantina.py): the box's top facilities and a random slice of the others, blinded;
   auditors record what they found; real precision and recall with Wilson intervals. */

const pct = (x: unknown) => (typeof x === "number" ? `${(100 * x).toFixed(1).replace(".", ",")}%` : "—");
const rupiah = (x: unknown) => (typeof x === "number" ? `Rp ${Math.round(x).toLocaleString("id-ID")}` : "—");

export function TanggaBukti({ pilot = true }: { pilot?: boolean }) {
  const [t, setT] = useState<Rec | null>(null);
  const [p, setP] = useState<Rec | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState({ ditandai: 30, acak: 30 });
  const [found, setFound] = useState<Record<string, string>>({}); // the overpayment an auditor found, per audit code (rupiah)
  const load = () => {
    fraud.ladder().then(setT).catch((e) => setErr((e as Error).message));
    if (pilot) fraud.pilot().then(setP).catch(() => {});
  };
  useEffect(load, [pilot]);
  const design = async () => {
    setBusy(true); setErr("");
    try { setP(await fraud.designPilot(n)); load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const record = async (kode: string, terbukti: boolean) => {
    const nilai = Number(found[kode]);
    try { setP(await fraud.pilotOutcome(kode, { terbukti, ...(terbukti && nilai > 0 ? { nilai_rp: nilai } : {}) })); fraud.ladder().then(setT); } catch (e) { setErr((e as Error).message); }
  };
  const est = p?.estimasi as Rec | undefined;
  return (
    <section className="rounded border border-white/10 bg-[#1c2127] p-3 text-[12px]">
      <p className="font-semibold text-white">Tangga bukti</p>
      <p className="mb-2 text-[11px] text-[#8f99a8]">{t?.pesan ?? "Tiap langkah mendukung klaim yang lebih luas, dan tidak satu pun menunjukkan semuanya."}</p>
      {err && <p className="text-[11px] text-red-300">{err}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[11px]">
          <thead className="text-[#8f99a8]"><tr><th className="py-1 pr-3">Langkah</th><th className="pr-3">Mendukung</th><th className="pr-3">Tidak menunjukkan</th><th>Status</th></tr></thead>
          <tbody>
            {((t?.tangga ?? []) as Rec[]).map((r, i) => (
              <tr key={r.langkah} className="border-t border-white/5 align-top">
                <td className="py-1.5 pr-3"><p className="font-medium text-[#e5e8eb]">{i + 1}. {r.langkah}</p><p className="text-[10.5px] text-[#8f99a8]">{r.sumber}</p></td>
                <td className="pr-3 text-[#7ee2c0]">{r.mendukung}</td>
                <td className="pr-3 text-[#fbd38d]">{r.tidak_menunjukkan}</td>
                <td className="text-[#d3d8de]">
                  <p>{r.status}</p>
                  {r.angka && <p className="text-[10.5px] text-[#8f99a8]">{summary(r)}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pilot && (
        <div className="mt-3 border-t border-white/5 pt-2">
          <p className="font-semibold text-[#e5e8eb]">Pilot audit terancang</p>
          <p className="mb-1 text-[10.5px] text-[#8f99a8]">Bila verifikator hanya memeriksa kasus yang ditandai, label hanya ada untuk kasus itu. Sampel acak dari faskes lain membuat recall bisa diukur; auditor tidak tahu faskes mana dari lengan mana.</p>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <label>teratas box <input type="number" min={5} max={500} value={n.ditandai} onChange={(e) => setN({ ...n, ditandai: Number(e.target.value) })} className="w-16 rounded border border-white/15 bg-[#111418] px-1" /></label>
            <label>acak <input type="number" min={5} max={500} value={n.acak} onChange={(e) => setN({ ...n, acak: Number(e.target.value) })} className="w-16 rounded border border-white/15 bg-[#111418] px-1" /></label>
            <button disabled={busy} onClick={design} className="rounded bg-[#5b5fd6] px-2 py-0.5 text-white disabled:opacity-40">{p?.id ? "Rancang ulang" : "Rancang pilot"}</button>
            {p?.id && <span className="text-[#8f99a8]">{String(p.id)} · {String(p.ditandai)} teratas + {String(p.acak)} acak dari {String(p.populasi_lain)} faskes lain</span>}
          </div>
          {est && (
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              <Est label="Presisi daftar teratas" v={pct(est.presisi?.porsi)} ci={est.presisi?.ik95} sub={`${est.presisi?.terbukti}/${est.presisi?.diaudit} terbukti dari ${est.presisi?.sampel}`}
                arti="Dari 10 faskes yang diaudit dari daftar prioritas, berapa yang memang bermasalah." />
              <Est label="Porsi terbukti di sampel acak" v={pct(est.acak?.porsi)} ci={est.acak?.ik95} sub={`${est.acak?.terbukti}/${est.acak?.diaudit} dari ${est.acak?.sampel}`}
                arti="Pembanding: seberapa sering masalah ditemukan bila faskes dipilih tanpa sistem." />
              <Est label="Recall (perkiraan)" v={pct(est.recall)} ci={est.recall_ik95} sub={est.terlewat_diperkirakan != null ? `±${Math.round(est.terlewat_diperkirakan)} faskes terlewat` : "menunggu hasil audit"}
                arti="Dari semua faskes bermasalah, termasuk yang di luar daftar, berapa persen yang tertangkap." />
              {/* beside precision, as the kit's references report: lift (Shekhar et al. 2026), the no-change rate and the rupiah (Black et al. 2022) */}
              <Est label="Lift atas sampel acak" v={typeof est.lift === "number" ? `${est.lift.toFixed(1).replace(".", ",")}×` : "—"} sub="presisi ÷ porsi sampel acak"
                arti="Satu audit dari daftar prioritas setara dengan berapa audit yang dipilih acak." />
              <Est label="No-change rate" v={pct(est.no_change)} sub="audit daftar teratas yang tidak menemukan apa pun"
                arti="Waktu auditor yang terpakai tanpa temuan; makin kecil makin hemat." />
              <Est label="Temuan rupiah" v={rupiah(est.temuan_per_audit_rp)} sub={`per audit · recall rupiah ${pct(est.recall_rp)} · di luar daftar ${rupiah(est.temuan_di_luar_rp)}`}
                arti="Rata-rata kelebihan bayar yang ditemukan per audit; bandingkan dengan biaya satu audit." />
            </div>
          )}
          {p?.sampel && (
            <div className="mt-2 max-h-72 overflow-y-auto">
              <table className="w-full text-left text-[11px]">
                <thead className="text-[#8f99a8]"><tr><th className="py-0.5">kode</th><th>faskes</th><th>provinsi</th><th>hasil audit</th></tr></thead>
                <tbody>{(p.sampel as Rec[]).map((it) => (
                  <tr key={it.kode} className="border-t border-white/5">
                    <td className="py-0.5 font-mono text-[10.5px]">{it.kode}</td>
                    <td className="max-w-[360px] truncate text-[#d3d8de]" title={it.nama}>{it.nama}</td>
                    <td className="text-[#8f99a8]">{it.provinsi}</td>
                    <td>{it.terbukti == null
                      ? <span className="flex items-center gap-1">
                          <input type="number" min={0} placeholder="temuan Rp" value={found[it.kode] ?? ""} onChange={(e) => setFound({ ...found, [it.kode]: e.target.value })}
                            title="Kelebihan bayar yang ditemukan auditor (rupiah), diisi bila terbukti" className="w-24 rounded border border-white/15 bg-[#111418] px-1 tabular-nums" />
                          <button onClick={() => record(it.kode, true)} className="rounded border border-[#e5484d]/60 px-1.5 text-[#ffb4b4]">terbukti</button>
                          <button onClick={() => record(it.kode, false)} className="rounded border border-[#29a383]/60 px-1.5 text-[#7ee2c0]">tidak</button></span>
                      : <span className={it.terbukti ? "text-[#ffb4b4]" : "text-[#7ee2c0]"}>{it.terbukti ? "terbukti" : "tidak terbukti"}{it.terbukti && it.nilai_rp ? ` · ${rupiah(it.nilai_rp)}` : ""} <span className="text-[#6b7480]">· {it.oleh}</span></span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** A permutation test's p as a reader reads it: 1/1001 (the floor of 1,000 permutations) printed "0.000999000999000999". */
function pValue(v: unknown): string {
  const p = Number(v);
  if (!Number.isFinite(p)) return "p = –";
  return p <= 0.001 + 1e-9 ? "p ≤ 0,001" : `p = ${p.toLocaleString("id-ID", { maximumFractionDigits: 3 })}`;
}

function summary(r: Rec): string {
  const a = r.angka as Rec;
  if (r.langkah === "Label nyata parsial") return `precision@k RS ${pct(a.precision_at_k_rs)} · lift ${Number(a.lift_rs ?? 0).toFixed(0)}× · uji permutasi ${pValue(a.permutasi_p)}`;
  if (r.langkah === "Audit terancang dalam pilot") return `presisi ${pct(a.presisi?.porsi)} · recall ${pct(a.recall)}`;
  return Object.entries(a).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === "object" ? `P@k ${pct((v as Rec)?.precision_at_k)}` : v}`).join(" · ");
}

/** arti: the measure in a sentence a leader reads without the method */
function Est({ label, v, ci, sub, arti }: { label: string; v: string; ci?: (number | null)[]; sub?: string; arti?: string }) {
  return (
    <div className="rounded bg-white/[.04] p-2">
      <p className="text-[10.5px] text-[#8f99a8]">{label}</p>
      <p className="text-[15px] font-semibold tabular-nums text-white">{v}</p>
      <p className="text-[10.5px] text-[#8f99a8]">{ci ? `IK 95% ${ci[0] != null ? `${pct(ci[0])}–${pct(ci[1])}` : "—"} · ` : ""}{sub}</p>
      {arti && <p className="mt-1 text-[11px] leading-snug text-[#c5cbd3]">{arti}</p>}
    </div>
  );
}
