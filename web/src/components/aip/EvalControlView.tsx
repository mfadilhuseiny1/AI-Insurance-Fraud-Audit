"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { API_URL } from "@/lib/api";
import { modelName, usd, wib } from "@/components/aip/aipRun";
import { useTampilBiaya } from "@/components/aip/biaya";
import { VERSI_BADGE } from "@/components/aip/fraudApi";

/* Evaluasi Swarm (api/aip/evaluasi_swarm.py): every AI Agent Swarm engagement scored from its own trail — what it found,
   how its orchestration ran, whether its report holds. Until 2026-10-28 this tab was "Evaluasi & Kontrol" and scored
   the question copilot on golden sets; the user kept it only if it evaluates the swarm. Nothing here calls a model.
   A criterion the trail cannot show is "tidak terukur", never a pass; the model validator and the code gates are shown
   side by side, so a disagreement between them is visible. */

const OK = "#29a383", WARN = "#fab219", BAD = "#e5484d", MUTE = "#8f99a8";
const STATUS: Record<string, [string, string]> = {
  succeeded: ["berhasil", OK], failed: ["gagal", BAD], cancelled: ["dibatalkan", WARN], running: ["berjalan", "#7ea6e0"], interrupted: ["terputus", WARN],
};

type Krit = { id: string; nama: string; nilai: string; syarat: string; lulus: boolean | null };
type Cek = { klaim: string; ok: boolean | null; blok: boolean; bukti: string };
type Skor = { scrutiny: [number, number]; qa: [number, number]; validator: [number, number]; kontrak: [number, number, number] };
type Ringkas = {
  id: string; nama: string | null; proyek: string | null; proyek_nama: string | null; oleh: string | null; status: string; mulai: string; selesai: string | null;
  detik: number | null; biaya_usd: number | null; tulis_ulang_dari: string | null; lulus: number; terukur: number; skor: Skor; kriteria: Krit[];
  versi?: string;  // the AI orchestration: "1.0" (Blu 1.0) or "1.1" (Blu 1.1, the clinical review first)
  agen: number; instans: number; tag: number | null; kasus: number | null; galat: number; traceback: number | null; dilanjutkan: number;
  tool: number; tool_gagal: number; exhibit: number | null; berkas: number | null;
};
type Fase = { fase: string; label: string; mulai: string | null; selesai: string | null; kali: number; detik: number | null; hasil: Record<string, number> };
type Detail = Omit<Ringkas, "agen" | "instans" | "tag" | "kasus" | "galat" | "traceback" | "dilanjutkan" | "tool" | "tool_gagal" | "exhibit" | "berkas"> & {
  scrutiny: { milestone: string; passed: number; total: number; cek: Cek[] }[];
  qa: { lini: string; nama: string; model: string; passed: number; total: number; cek: Cek[] }[];
  validator: { model: string; cek: Cek[] } | null;
  kontrak: { id: string; teks: string; ok: boolean | null; bukti: string }[];
  hasil: { tag_tersimpan: number | null; tag_agen: number; kekuatan: Record<string, number>; lintas_keluarga: number; tag_baru: number; faskes_box: number | null;
    kasus: number | null; rekomendasi: number; jalur: Record<string, number>; ditindak_tanpa_tsm: string[]; red_team: Record<string, number>;
    telaah_klinis?: { status: string; ditelaah: number | null; diperiksa_ulang: number | null; layak_tag: number | null; tag: number | null; usd: number | null;
      alasan: string[]; kappa: number | null } | null };
  orkestrasi: { fase: Fase[]; agen: number; instans: number; serah_terima: number; prosedur_diikuti: number; diisi_agen: number; masalah_dilaporkan: number;
    tool: number; tool_gagal: number; tool_gagal_teratas: { tool: string; gagal: number; contoh: string }[];
    galat: { agen: string; pesan: string; t: string }[]; galat_total: number; giliran_diulang: number; dilanjutkan: number; traceback: number | null;
    pelajaran: { skill: string; teks: string }[] };
  biaya: { model: { model: string; panggilan: number; token_masuk: number; token_keluar: number; usd: number }[]; lini: { lini: string; usd: number }[] };
  laporan: { bab: { id: string; judul: string; teks_firma: boolean; exhibit: number | null; berisi: boolean | null }[]; bab_berisi: number; bab_firma: number;
    bab_total: number; exhibit: number | null; berkas: number | null; beku: boolean; beku_pada: string | null; narasi: number; narasi_dibuang: number };
};

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `${r.status} ${r.statusText}`);
  return r.json();
}

const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("id-ID"));
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
const tone = (p: number | null, good = 90) => (p == null ? MUTE : p >= good ? OK : p >= 70 ? WARN : BAD);
const dur = (s: number | null | undefined) => (s == null ? "—" : s < 60 ? `${s} dtk` : s < 3600 ? `${Math.round(s / 60)} mnt` : `${Math.floor(s / 3600)} j ${Math.round((s % 3600) / 60)} mnt`);
const title = (r: { nama: string | null; id: string; tulis_ulang_dari: string | null }) =>
  r.nama || (r.tulis_ulang_dari ? `Tulis ulang laporan ${r.tulis_ulang_dari}` : `Penugasan ${r.id}`);

function Bar({ value, color, w = "w-20" }: { value: number | null; color: string; w?: string }) {
  return (
    <span className={`inline-block h-1.5 ${w} shrink-0 overflow-hidden rounded-full bg-white/10 align-middle`}>
      <span className="block h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%`, background: color }} />
    </span>
  );
}
function Mark({ ok }: { ok: boolean | null }) {
  return ok == null ? <span className="text-[#8f99a8]" title="tidak terukur / tidak dinilai">—</span>
    : <span className="inline-flex shrink-0" style={{ color: ok ? OK : BAD }}><Icon name={ok ? "check" : "x"} className="h-3.5 w-3.5" /></span>;
}
function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-white/10 bg-[#1c2127] p-3">
      <p className="text-[12.5px] font-semibold text-white">{title}</p>
      {sub && <p className="mt-0.5 text-[11px] text-[#8f99a8]">{sub}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}
function Tile({ label, value, sub, base }: { label: string; value: string; sub?: React.ReactNode; base?: string | null }) {
  return (
    <div className="rounded border border-white/10 bg-[#111418] px-3 py-2">
      <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">{label}</p>
      <p className="mt-0.5 text-[18px] font-semibold leading-tight text-white">{value}</p>
      {sub && <div className="mt-1 text-[11px] leading-snug text-[#abb3bf]">{sub}</div>}
      {base != null && <p className="mt-0.5 text-[10.5px] text-[#8f99a8]">patokan: {base}</p>}
    </div>
  );
}
/** a verdict's checks, folded: the failed ones first, each with the evidence the validator or the code gave */
function Checks({ label, passed, total, cek, model }: { label: string; passed: number; total: number; cek: Cek[]; model?: string }) {
  const p = pct(passed, total);
  const sorted = [...cek].sort((a, b) => Number(a.ok === true) - Number(b.ok === true));
  return (
    <details className="group border-b border-white/5 py-1">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[11.5px]">
        <Icon name="right" className="h-3 w-3 shrink-0 text-[#8f99a8] transition-transform group-open:rotate-90" />
        <span className="min-w-0 flex-1 truncate text-[#d3d8de]">{label}{model && <span className="ml-1.5 text-[10.5px] text-[#8f99a8]">{model}</span>}</span>
        <Bar value={p} color={tone(p)} />
        <span className="w-12 shrink-0 text-right tabular-nums" style={{ color: tone(p) }}>{passed}/{total}</span>
      </summary>
      <div className="mb-1 ml-5 mt-1 space-y-1">
        {sorted.map((c, i) => (
          <div key={i} className="flex gap-2 text-[11px]">
            <span className="pt-px"><Mark ok={c.ok} /></span>
            <p className="min-w-0 text-[#d3d8de]">{c.klaim}{c.blok && !c.ok && <span className="ml-1 text-[10px] font-semibold uppercase" style={{ color: BAD }}>memblokir</span>}
              {c.bukti && <span className="block text-[10.5px] text-[#8f99a8]">{c.bukti}</span>}</p>
          </div>
        ))}
        {sorted.length === 0 && <p className="text-[11px] text-[#8f99a8]">Tanpa cek tercatat.</p>}
      </div>
    </details>
  );
}

export function EvalControlView() {
  const [list, setList] = useState<Ringkas[] | null>(null);
  const [at, setAt] = useState("");
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [base, setBase] = useState<string>("");
  const [det, setDet] = useState<Detail | null>(null);
  const [detErr, setDetErr] = useState("");
  const biaya = useTampilBiaya();

  const load = useCallback(() => {
    get<{ dibuat_pada: string; penugasan: Ringkas[] }>("/api/aip/evaluasi-swarm")
      .then((r) => { setList(r.penugasan); setAt(r.dibuat_pada); setErr(""); setSel((s) => s ?? r.penugasan[0]?.id ?? null); })
      .catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(() => { load(); }, [load]);
  const running = list?.some((r) => r.status === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 30000);
    return () => clearInterval(t);
  }, [running, load]);

  const row = list?.find((r) => r.id === sel);
  useEffect(() => {
    if (!sel) return;
    let live = true;
    get<Detail>(`/api/aip/evaluasi-swarm/${sel}`).then((d) => { if (live) { setDet(d); setDetErr(""); } }).catch((e) => { if (live) setDetErr((e as Error).message); });
    return () => { live = false; };
  }, [sel, row?.status, row?.selesai, row?.lulus]);

  // the baseline: chosen, or the newest other finished engagement that ran in full (a rewrite copies its phases)
  const others = useMemo(() => (list ?? []).filter((r) => r.id !== sel), [list, sel]);
  const patokan = others.find((r) => r.id === base) ?? others.find((r) => r.status === "succeeded" && !r.tulis_ulang_dari) ?? null;
  const pk = (id: string) => patokan?.kriteria.find((k) => k.id === id);

  if (!list) return <div className="flex flex-1 items-center justify-center text-[12px] text-[#8f99a8]">{err ? `Evaluasi tidak menjawab: ${err}` : "Memuat evaluasi penugasan…"}</div>;

  const d = det?.id === sel ? det : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto text-[12px]">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/5 bg-[#1c2127] px-4 py-2">
        <p className="text-[13px] font-semibold text-white">Evaluasi AI Agent Swarm</p>
        <span className="text-[#abb3bf]">setiap penugasan dinilai dari jejaknya sendiri: hasil, orkestrasi, laporan. Tanpa panggilan model.</span>
        <span className="ml-auto flex items-center gap-2 text-[11px] text-[#8f99a8]">
          diperbarui {wib(at)}
          <button onClick={load} className="flex items-center gap-1 rounded border border-white/15 px-2 py-0.5 text-[#d3d8de] hover:bg-white/10"><Icon name="refresh" className="h-3 w-3" />Muat ulang</button>
        </span>
      </div>
      {err && <p className="px-4 pt-2 text-red-300">{err}</p>}

      <div className="space-y-3 p-3">
        <Section title="Penugasan" sub="Pilih satu untuk melihat penilaiannya. Kriteria: yang lolos dari yang terukur.">
          <div className="max-h-[38vh] overflow-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-[#1c2127] text-[#8f99a8]"><tr>
                <th className="py-1 pr-2 font-normal">penugasan</th><th className="pr-2 font-normal">mulai</th><th className="pr-2 font-normal">status</th>
                <th className="pr-2 font-normal">kriteria</th><th className="pr-2 font-normal">QA</th><th className="pr-2 font-normal">validator</th>
                <th className="pr-2 font-normal">gerbang kode</th><th className="pr-2 font-normal">tag</th><th className="pr-2 font-normal">kasus</th>
                <th className="pr-2 font-normal">tool gagal</th><th className="pr-2 font-normal">traceback</th><th className="pr-2 font-normal">durasi</th>
                {biaya && <th className="font-normal">biaya</th>}
              </tr></thead>
              <tbody>{list.map((r) => {
                const [st, sc] = STATUS[r.status] ?? [r.status, MUTE];
                const kp = r.terukur ? pct(r.lulus, r.terukur) : null, qp = pct(...r.skor.qa), vp = pct(...r.skor.validator), gp = pct(...r.skor.scrutiny);
                return (
                  <tr key={r.id} onClick={() => setSel(r.id)} className={`cursor-pointer border-t border-white/5 ${r.id === sel ? "bg-white/[.08]" : "hover:bg-white/[.04]"}`}>
                    <td className="max-w-[260px] py-1 pr-2"><p className="truncate text-[#e5e8eb]" title={title(r)}><Versi v={r.versi} />{title(r)}</p>
                      <p className="truncate text-[10px] text-[#8f99a8]">{r.proyek_nama ?? (r.tulis_ulang_dari ? "tulis ulang laporan" : "tanpa proyek")} · {r.id}</p></td>
                    <td className="whitespace-nowrap pr-2 text-[#abb3bf]">{wib(r.mulai)}</td>
                    <td className="pr-2" style={{ color: sc }}>{st}</td>
                    <td className="whitespace-nowrap pr-2"><span className="tabular-nums" style={{ color: tone(kp, 100) }}>{r.lulus}/{r.terukur}</span></td>
                    <td className="pr-2 tabular-nums" style={{ color: tone(qp, 75) }}>{r.skor.qa[1] ? `${qp}%` : "—"}</td>
                    <td className="pr-2 tabular-nums" style={{ color: tone(vp, 100) }}>{r.skor.validator[1] ? `${r.skor.validator[0]}/${r.skor.validator[1]}` : "—"}</td>
                    <td className="pr-2 tabular-nums" style={{ color: tone(gp, 100) }}>{r.skor.scrutiny[1] ? `${r.skor.scrutiny[0]}/${r.skor.scrutiny[1]}` : "—"}</td>
                    <td className="pr-2 tabular-nums text-[#c5cbd3]">{num(r.tag)}</td>
                    <td className="pr-2 tabular-nums text-[#c5cbd3]">{num(r.kasus)}</td>
                    <td className="pr-2 tabular-nums text-[#c5cbd3]">{r.tool ? `${pct(r.tool_gagal, r.tool)}%` : "—"}</td>
                    <td className="pr-2 tabular-nums" style={{ color: r.traceback ? WARN : "#c5cbd3" }}>{num(r.traceback)}</td>
                    <td className="whitespace-nowrap pr-2 tabular-nums text-[#c5cbd3]">{dur(r.detik)}</td>
                    {biaya && <td className="tabular-nums text-[#c5cbd3]">{usd(r.biaya_usd ?? undefined)}</td>}
                  </tr>
                );
              })}</tbody>
            </table>
            {list.length === 0 && <p className="py-4 text-center text-[#8f99a8]">Belum ada penugasan AI Agent Swarm yang bisa Anda buka.</p>}
          </div>
        </Section>

        {row && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
            <p className="text-[13px] font-semibold text-white"><Versi v={row.versi} />{title(row)}</p>
            <span className="text-[11px] text-[#abb3bf]">{wib(row.mulai)} · {dur(row.detik)} · {row.oleh ?? "—"}{biaya ? ` · ${usd(row.biaya_usd ?? undefined)}` : ""}</span>
            {row.tulis_ulang_dari && <span className="rounded-full border border-white/15 px-1.5 py-px text-[10px] text-[#abb3bf]">fase 0–5 disalin dari {row.tulis_ulang_dari}</span>}
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-[#8f99a8]">Bandingkan dengan
              <select value={patokan?.id ?? ""} onChange={(e) => setBase(e.target.value)} className="max-w-[280px] rounded border border-white/15 bg-[#111418] px-1.5 py-0.5 text-[11px] text-white">
                {others.map((r) => <option key={r.id} value={r.id}>{title(r)} · {wib(r.mulai)}</option>)}
              </select></label>
          </div>
        )}
        {detErr && <p className="px-1 text-red-300">Penilaian penugasan tidak terbaca: {detErr}</p>}
        {row && !d && !detErr && <p className="px-1 text-[#8f99a8]">Membaca jejak penugasan…</p>}

        {d && (<>
          <Section title="Kriteria penerimaan" sub="Ukuran uji kesiapan Swarm (28 Okt) ditambah gerbang kode. — = tidak terukur dari jejak, misalnya laporan yang tidak dibekukan.">
            <table className="w-full text-left text-[11.5px]">
              <thead className="text-[10.5px] text-[#8f99a8]"><tr><th className="w-6" /><th className="py-0.5 pr-2 font-normal">kriteria</th><th className="pr-2 font-normal">nilai</th>
                <th className="pr-2 font-normal">syarat</th>{patokan && <th className="font-normal">patokan</th>}</tr></thead>
              <tbody>{d.kriteria.map((k) => { const b = pk(k.id); return (
                <tr key={k.id} className="border-t border-white/5">
                  <td className="py-1"><Mark ok={k.lulus} /></td>
                  <td className="pr-2 text-[#e5e8eb]">{k.nama}</td>
                  <td className="pr-2 tabular-nums" style={{ color: k.lulus == null ? MUTE : k.lulus ? "#d3d8de" : BAD }}>{k.nilai}</td>
                  <td className="pr-2 text-[#8f99a8]">{k.syarat}</td>
                  {patokan && <td className="text-[#8f99a8]">{b ? <span className="inline-flex items-center gap-1"><Mark ok={b.lulus} />{b.nilai}</span> : "—"}</td>}
                </tr>); })}</tbody>
            </table>
          </Section>

          <div className="grid gap-3 xl:grid-cols-2">
            <Section title="Hasil penugasan" sub="Apa yang ditemukan dan diputuskan agen, dari jejaknya.">
              <div className="grid grid-cols-2 gap-2">
                <Tile label="Tag indikasi tersimpan" value={num(d.hasil.tag_tersimpan)} base={patokan ? num(patokan.tag) : null}
                  sub={<>{d.hasil.tag_agen ? <>dari tag bertanda agen: kuat {num(d.hasil.kekuatan.kuat ?? 0)} · sedang {num(d.hasil.kekuatan.sedang ?? 0)} · lemah {num(d.hasil.kekuatan.lemah ?? 0)}<br />
                    {num(d.hasil.lintas_keluarga)} dikuatkan ≥ 2 keluarga model ({pct(d.hasil.lintas_keluarga, d.hasil.tag_agen)}%)</> : "tanpa tag dari agen"}</>} />
                <Tile label="Faskes di Box Karantina" value={num(d.hasil.faskes_box)} sub="dihitung mesin dari tag yang berdiri" />
                {d.hasil.telaah_klinis && (
                  <Tile label="Clinical examination (Blu 1.1)" value={num(d.hasil.telaah_klinis.ditelaah)}
                    sub={d.hasil.telaah_klinis.status === "selesai"
                      ? <>klaim ditelaah · {num(d.hasil.telaah_klinis.diperiksa_ulang)} diperiksa ulang · {num(d.hasil.telaah_klinis.tag)} ditandai (lemah)
                        {d.hasil.telaah_klinis.kappa != null ? ` · kappa ${d.hasil.telaah_klinis.kappa}` : ""}</>
                      : <span style={{ color: BAD }}>{d.hasil.telaah_klinis.status}: {d.hasil.telaah_klinis.alasan.join("; ") || "—"} — bekerja seperti Blu 1.0</span>} />
                )}
                <Tile label="Kasus diaudit penyidik" value={num(d.hasil.kasus)} base={patokan ? num(patokan.kasus) : null}
                  sub={<>{num(d.hasil.rekomendasi)} rekomendasi: ditindak {num(d.hasil.jalur.ditindak ?? 0)} · dibina {num(d.hasil.jalur.dibina ?? 0)}<br />
                    {d.hasil.rekomendasi > 0 && <span style={{ color: d.hasil.ditindak_tanpa_tsm.length ? BAD : OK }}>cek kode: {d.hasil.ditindak_tanpa_tsm.length ? `${d.hasil.ditindak_tanpa_tsm.length} ditindak tanpa T+S+M lengkap` : "setiap 'ditindak' memenuhi T, S dan M"}</span>}</>} />
                <Tile label="Red team" value={num(Object.values(d.hasil.red_team).reduce((a, b) => a + b, 0))}
                  sub={Object.keys(d.hasil.red_team).length ? Object.entries(d.hasil.red_team).map(([k, v]) => `${k} ${v}`).join(" · ") : "tidak ada uji red team"} />
              </div>
            </Section>
            <Section title="Orkestrasi" sub="Bagaimana tim agen bekerja: serah-terima, tool, galat, kelanjutan.">
              <div className="grid grid-cols-2 gap-2">
                <Tile label="Agen" value={`${num(d.orkestrasi.agen)} + ${num(d.orkestrasi.instans)}`} sub="agen tetap + instans dinamis (penyidik, red team)" />
                <Tile label="Serah-terima" value={num(d.orkestrasi.serah_terima)}
                  sub={`prosedur skill diikuti ${num(d.orkestrasi.prosedur_diikuti)} · diisi agen ${num(d.orkestrasi.diisi_agen)} · ${num(d.orkestrasi.masalah_dilaporkan)} masalah dilaporkan`} />
                <Tile label="Panggilan tool" value={num(d.orkestrasi.tool)} base={patokan?.tool ? `${pct(patokan.tool_gagal, patokan.tool)}% gagal` : null}
                  sub={d.orkestrasi.tool ? <span style={{ color: tone(100 - (pct(d.orkestrasi.tool_gagal, d.orkestrasi.tool) ?? 0), 95) }}>{num(d.orkestrasi.tool_gagal)} gagal ({pct(d.orkestrasi.tool_gagal, d.orkestrasi.tool)}%), dibaca agen sebagai umpan balik</span> : "tidak ada panggilan tool"} />
                <Tile label="Galat & kelanjutan" value={`${num(d.orkestrasi.galat_total)} galat`} base={patokan ? `${num(patokan.galat)} galat · ${num(patokan.traceback)} traceback` : null}
                  sub={`${num(d.orkestrasi.giliran_diulang)} giliran diulang · dilanjutkan ${d.orkestrasi.dilanjutkan}× setelah restart · ${num(d.orkestrasi.traceback)} traceback di log runtime`} />
              </div>
            </Section>
          </div>

          <Section title="Fase" sub="Lama tiap fase; fase yang dimulai lagi adalah fase yang dilanjutkan dari jejaknya setelah API dimulai ulang (waktunya termasuk jeda).">
            {(() => { const max = Math.max(1, ...d.orkestrasi.fase.map((f) => f.detik ?? 0)); return d.orkestrasi.fase.map((f) => (
              <div key={f.fase} className="flex items-center gap-2 border-b border-white/5 py-1 text-[11.5px]">
                <span className="w-40 shrink-0 truncate text-[#d3d8de]">{f.label}</span>
                <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-white/5">
                  <span className="block h-full rounded-full" style={{ width: `${Math.max(1, ((f.detik ?? 0) / max) * 100)}%`, background: f.selesai ? "#5b8def" : WARN }} /></span>
                <span className="w-20 shrink-0 text-right tabular-nums text-[#c5cbd3]">{f.selesai ? dur(f.detik) : "belum selesai"}</span>
                <span className="w-44 shrink-0 truncate text-[10.5px] text-[#8f99a8]">
                  {[...Object.entries(f.hasil).map(([k, v]) => `${k} ${num(v)}`), f.kali > 1 ? `dilanjutkan ${f.kali - 1}×` : ""].filter(Boolean).join(" · ")}</span>
              </div>)); })()}
            {d.orkestrasi.fase.length === 0 && <p className="text-[#8f99a8]">Tidak ada fase tercatat.</p>}
          </Section>

          <div className="grid gap-3 xl:grid-cols-2">
            <Section title="Validasi" sub="Gerbang kode (deterministik) di tiap milestone, QA atas sintesis tiap lini, dan validator laporan akhir. Klik untuk melihat cek dan buktinya.">
              <p className="mb-0.5 text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Gerbang kode per milestone</p>
              {d.scrutiny.map((s, i) => <Checks key={`${s.milestone}-${i}`} label={s.milestone} passed={s.passed} total={s.total} cek={s.cek} />)}
              {d.scrutiny.length === 0 && <p className="text-[11px] text-[#8f99a8]">Tidak ada gerbang kode tercatat (penugasan sebelum gerbang ada).</p>}
              <p className="mb-0.5 mt-3 text-[10.5px] uppercase tracking-wide text-[#8f99a8]">QA sintesis tiap lini</p>
              {d.qa.map((q) => <Checks key={q.lini} label={q.nama} model={modelName(q.model)} passed={q.passed} total={q.total} cek={q.cek} />)}
              {d.qa.length === 0 && <p className="text-[11px] text-[#8f99a8]">Tidak ada QA tercatat.</p>}
              <p className="mb-0.5 mt-3 text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Validator laporan akhir</p>
              {d.validator ? <Checks label="klaim laporan diperiksa ke hasil tool" model={modelName(d.validator.model)} passed={d.skor.validator[0]} total={d.skor.validator[1]} cek={d.validator.cek} />
                : <p className="text-[11px] text-[#8f99a8]">Tidak ada validator laporan akhir tercatat.</p>}
            </Section>
            <Section title="Kontrak penugasan" sub={`Dibuat pimpinan sebelum kerja dimulai, dinilai validator laporan akhir: ${d.skor.kontrak[0]} terpenuhi dari ${d.skor.kontrak[1]} yang dinilai (${d.skor.kontrak[2]} butir).`}>
              {d.kontrak.map((c) => (
                <details key={c.id} className="group border-b border-white/5 py-1">
                  <summary className="flex cursor-pointer list-none items-start gap-2 text-[11.5px]">
                    <span className="pt-px"><Mark ok={c.ok} /></span>
                    <span className="w-6 shrink-0 font-mono text-[10.5px] text-[#8f99a8]">{c.id}</span>
                    <span className="min-w-0 flex-1 text-[#d3d8de]">{c.teks}</span>
                  </summary>
                  <p className="mb-1 ml-14 mt-0.5 text-[10.5px] text-[#8f99a8]">{c.ok == null ? "Tidak dinilai validator." : c.bukti || "Tanpa bukti tertulis."}</p>
                </details>
              ))}
              {d.kontrak.length === 0 && <p className="text-[11px] text-[#8f99a8]">Tidak ada kontrak yang dinilai.</p>}
              {d.hasil.rekomendasi > 0 && d.hasil.ditindak_tanpa_tsm.length === 0 && d.kontrak.some((c) => c.ok === false && /ditindak/i.test(c.teks)) && (
                <p className="mt-2 rounded border border-white/10 bg-[#111418] px-2 py-1.5 text-[11px] text-[#abb3bf]">
                  <span style={{ color: WARN }}>Validator dan kode tidak sepakat:</span> validator menilai aturan &quot;ditindak&quot; dilanggar, sedangkan cek kode atas rekomendasi penyidik tidak menemukan &quot;ditindak&quot; tanpa T, S dan M terpenuhi. Periksa bukti validator di butir itu.</p>
              )}
            </Section>
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            <Section title="Hambatan orkestrasi" sub="Tool yang paling sering gagal (agen membaca pesannya dan mencoba lagi) dan galat giliran agen.">
              {d.orkestrasi.tool_gagal_teratas.map((t) => (
                <div key={t.tool} className="border-b border-white/5 py-1 text-[11px]">
                  <p className="flex gap-2"><span className="font-mono text-[#d3d8de]">{t.tool}</span><span className="ml-auto tabular-nums" style={{ color: WARN }}>{num(t.gagal)}× gagal</span></p>
                  <p className="truncate text-[10.5px] text-[#8f99a8]" title={t.contoh}>{t.contoh}</p>
                </div>
              ))}
              {d.orkestrasi.tool_gagal_teratas.length === 0 && <p className="text-[11px] text-[#8f99a8]">Tidak ada panggilan tool yang gagal.</p>}
              {d.orkestrasi.galat.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-[#abb3bf]">{d.orkestrasi.galat_total} galat giliran agen</summary>
                  {d.orkestrasi.galat.map((g, i) => <p key={i} className="border-b border-white/5 py-0.5 text-[10.5px] text-[#abb3bf]"><span className="text-[#8f99a8]">{wib(g.t)} · {g.agen}</span> — {g.pesan}</p>)}
                </details>
              )}
              {d.orkestrasi.pelajaran.length > 0 && (<>
                <p className="mb-0.5 mt-3 text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Pelajaran yang dicatat untuk penugasan berikutnya</p>
                {d.orkestrasi.pelajaran.map((p, i) => <p key={i} className="border-b border-white/5 py-1 text-[11px] text-[#d3d8de]"><span className="font-mono text-[10.5px] text-[#8f99a8]">{p.skill}</span> · {p.teks}</p>)}
              </>)}
            </Section>
            <Section title="Laporan" sub={d.laporan.beku ? `Dibekukan bersama penugasan ${wib(d.laporan.beku_pada)}: exhibit dan berkas kasus seperti saat penugasan selesai.` : "Tidak dibekukan: exhibit dan berkas kasusnya dihitung dari Box terkini, jadi tidak dinilai di sini."}>
              <table className="w-full text-left text-[11px]">
                <thead className="text-[10.5px] text-[#8f99a8]"><tr><th className="py-0.5 pr-2 font-normal">bab</th><th className="pr-2 font-normal">teks firma</th><th className="pr-2 font-normal">exhibit</th><th className="font-normal">berisi</th></tr></thead>
                <tbody>{d.laporan.bab.map((b) => (
                  <tr key={b.id} className="border-t border-white/5">
                    <td className="py-0.5 pr-2 text-[#d3d8de]">{b.judul}</td>
                    <td className="pr-2">{b.id === "kasus" ? <span className="text-[#8f99a8]">berkas kasus</span> : <Mark ok={b.teks_firma} />}</td>
                    <td className="pr-2 tabular-nums text-[#c5cbd3]">{num(b.exhibit)}</td>
                    <td><Mark ok={b.berisi} /></td>
                  </tr>
                ))}</tbody>
              </table>
              <p className="mt-2 text-[11px] text-[#abb3bf]">{num(d.laporan.exhibit)} exhibit · {num(d.laporan.berkas)} berkas kasus · narasi {d.laporan.narasi} exhibit
                {d.laporan.narasi_dibuang ? ` · ${d.laporan.narasi_dibuang} kalimat narasi dibuang gerbang angka` : ""}</p>
            </Section>
          </div>

          {biaya && (
            <Section title="Biaya model" sub="Dari buku pemakaian penugasan ini (gateway platform), per model dan per lini.">
              <div className="grid gap-3 lg:grid-cols-2">
                <table className="w-full text-left text-[11px]">
                  <thead className="text-[10.5px] text-[#8f99a8]"><tr><th className="py-0.5 pr-2 font-normal">model</th><th className="pr-2 font-normal">panggilan</th><th className="pr-2 font-normal">token masuk / keluar</th><th className="font-normal">biaya</th></tr></thead>
                  <tbody>{d.biaya.model.map((m) => (
                    <tr key={m.model} className="border-t border-white/5">
                      <td className="py-0.5 pr-2 font-mono text-[10.5px] text-[#d3d8de]">{modelName(m.model)}</td>
                      <td className="pr-2 tabular-nums text-[#c5cbd3]">{num(m.panggilan)}</td>
                      <td className="pr-2 tabular-nums text-[#c5cbd3]">{num(m.token_masuk)} / {num(m.token_keluar)}</td>
                      <td className="tabular-nums text-[#c5cbd3]">{usd(m.usd)}</td>
                    </tr>
                  ))}</tbody>
                </table>
                <div>{(() => { const max = Math.max(0.0001, ...d.biaya.lini.map((l) => l.usd)); return d.biaya.lini.map((l) => (
                  <div key={l.lini} className="flex items-center gap-2 py-0.5 text-[11px]">
                    <span className="w-32 shrink-0 truncate text-[#d3d8de]">{l.lini}</span>
                    <Bar value={(l.usd / max) * 100} color="#5b8def" w="flex-1" />
                    <span className="w-16 shrink-0 text-right tabular-nums text-[#c5cbd3]">{usd(l.usd)}</span>
                  </div>)); })()}</div>
              </div>
            </Section>
          )}
        </>)}
      </div>
    </div>
  );
}


/** The engagement's AI orchestration, before its name (Blu 1.0, 1.1 or 1.3). */
function Versi({ v }: { v?: string }) {
  const known = v && VERSI_BADGE[v] ? v : "1.0";
  return <span title={VERSI_BADGE[known][0]} className={`mr-1 inline-block rounded px-1 align-[1px] text-[9.5px] font-semibold ${VERSI_BADGE[known][1]}`}>
    Blu {known}</span>;
}
