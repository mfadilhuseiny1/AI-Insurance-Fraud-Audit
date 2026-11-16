"use client";
import { useEffect, useState } from "react";
import { Widget } from "@/components/demo/audit/Workspace";
import { fraudApi } from "./api";
import { Donut, Gauge, HBars } from "./charts";
import { rp, type AnyRec } from "./types";
import { DataTable, StateMsg, ToneBadge, inputCls } from "./ui";

export function PrepayPanel({ onMsg }: { onMsg: (m: string) => void }) {
  const [queue, setQueue] = useState<AnyRec | null>(null);
  const [screen, setScreen] = useState<AnyRec | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ diagnosa: "O80", prosedur: "74.1", tarif_klaim: 99000000, dokumen_lengkap: false });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { fraudApi.queue().then(setQueue, (e: Error) => setErr(e.message)); }, []);
  const doScreen = async () => {
    setBusy(true);
    try { setScreen(await fraudApi.screen(form)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (err) return <StateMsg kind="error" text={err} />;
  return (
    <div className="space-y-3">
      {queue ? (
        <div className="grid gap-3 md:grid-cols-3">
          {([["otomatis", "Jalur otomatis", "Bayar tanpa sentuhan"], ["review", "Antrian review", "Verifikator · SLA 4 jam"], ["hold", "Ditahan", "Buat kasus investigasi"]] as const).map(([lane, label, cap]) => (
            <Widget key={lane} title={label} caption={cap} right={<ToneBadge text={lane} />}>
              <div className="mb-2 text-2xl font-semibold tabular-nums">{queue.ringkasan[lane]}</div>
              <div className="space-y-2">{queue.lanes[lane].slice(0, 5).map((x: AnyRec) => <div key={x.no_sep} className="text-xs"><span className="font-mono">{x.no_sep}</span> · skor {x.skor}<div className="text-muted">{x.alasan[0]}</div></div>)}</div>
            </Widget>
          ))}
        </div>
      ) : <StateMsg kind="loading" text="Memuat antrian pre-payment…" />}
      <Widget title="Skrining klaim baru" caption="Keputusan diambil sebelum pembayaran — klaim bersih lolos otomatis, hard-stop ditahan">
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <label className="grid gap-1 text-muted">Diagnosis<input value={form.diagnosa} onChange={(e) => setForm({ ...form, diagnosa: e.target.value })} className={inputCls} /></label>
          <label className="grid gap-1 text-muted">Prosedur<input value={form.prosedur} onChange={(e) => setForm({ ...form, prosedur: e.target.value })} className={inputCls} /></label>
          <label className="grid gap-1 text-muted">Tarif klaim (Rp)<input type="number" value={form.tarif_klaim} onChange={(e) => setForm({ ...form, tarif_klaim: Number(e.target.value) })} className={inputCls} /></label>
          <label className="flex items-center gap-1.5 pb-1.5 text-soft"><input type="checkbox" checked={form.dokumen_lengkap} onChange={(e) => setForm({ ...form, dokumen_lengkap: e.target.checked })} /> Dokumen lengkap</label>
          <button type="button" disabled={busy} onClick={doScreen} className="rounded-md bg-ocean px-3 py-1.5 text-xs font-medium text-white hover:bg-ocean-deep disabled:opacity-50">{busy ? "Menyaring…" : "Skrining sekarang"}</button>
        </div>
        {screen && (
          <div className="mt-3 flex flex-wrap items-center gap-4 rounded-lg bg-panel-2/60 p-3">
            <Gauge value={screen.skor_risiko} />
            <div className="min-w-56 flex-1 text-xs">
              <div className="flex flex-wrap items-center gap-2 text-sm"><b>Keputusan: {screen.keputusan}</b><ToneBadge text={screen.tier} /><span className="text-muted">{screen.latensi_ms} ms · tercatat di decision log</span></div>
              <p className="mt-1 text-soft">{screen.jalur}</p>
              {screen.issues.map((i: AnyRec) => <p key={i.jenis} className="mt-1 text-muted"><b className="text-soft">{i.label}:</b> {i.detail}</p>)}
              {!screen.issues.length && <p className="mt-1 text-ok">Tidak ada anomali billing terdeteksi.</p>}
            </div>
          </div>
        )}
      </Widget>
    </div>
  );
}

const STEP = ["draft", "review", "aktif"];
function Lifecycle({ rule, act }: { rule: AnyRec; act: (fn: () => Promise<AnyRec>, msg: string) => void }) {
  return (
    <div className="space-y-1.5">
      {rule.versi.map((v: AnyRec) => {
        const idx = v.status === "arsip" ? -1 : STEP.indexOf(v.status);
        return (
          <div key={v.versi} className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1">{STEP.map((s, i) => (
              <span key={s} className="flex items-center gap-1">
                <span className={`rounded-full px-1.5 py-0.5 text-[9.5px] font-bold ${idx >= i ? "bg-ocean text-white" : "bg-panel-2 text-muted"}`}>{s}</span>
                {i < 2 && <span className="text-muted">→</span>}
              </span>))}
              {v.status === "arsip" && <span className="rounded-full bg-panel-2 px-1.5 py-0.5 text-[9.5px] font-bold text-muted">arsip</span>}
            </span>
            <span className="font-mono text-[11px]">v{v.versi}</span>
            {v.status === "draft" && <button type="button" onClick={() => act(() => fraudApi.submitReview(rule.id, v.versi), `${rule.id} v${v.versi} masuk review.`)} className="text-[11px] text-ocean hover:underline">Ajukan review</button>}
            {v.status === "review" && <button type="button" onClick={() => act(() => fraudApi.approve(rule.id, v.versi), `${rule.id} v${v.versi} disetujui & aktif.`)} className="text-[11px] font-semibold text-ok hover:underline">Setujui &amp; aktifkan</button>}
          </div>
        );
      })}
    </div>
  );
}

export function RulesPanel({ onMsg }: { onMsg: (m: string) => void }) {
  const [data, setData] = useState<AnyRec | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState({ rule_id: "R-04", versi: "", perubahan: "" });
  const load = () => fraudApi.rules().then(setData, (e: Error) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const act = async (fn: () => Promise<AnyRec>, msg: string) => {
    try { await fn(); onMsg(msg); load(); } catch (e) { setErr((e as Error).message); }
  };
  const activate = (id: string, versi: string) => act(() => fraudApi.activate(id, versi), `Aturan ${id} v${versi} aktif dan tercatat di audit trail.`);
  const makeDraft = () => {
    if (!draft.versi || !draft.perubahan) return setErr("Isi nomor versi & catatan perubahan dulu.");
    act(() => fraudApi.draft(draft.rule_id, draft.versi, draft.perubahan), `Draft ${draft.rule_id} v${draft.versi} dibuat — ajukan review untuk mengaktifkannya.`);
    setDraft({ ...draft, versi: "", perubahan: "" });
  };
  if (err) return <StateMsg kind="error" text={err} />;
  if (!data) return <StateMsg kind="loading" text="Memuat registry aturan…" />;
  return (
    <div className="space-y-3">
      <Widget title="Registry aturan berversi" caption="Satu sumber kebenaran aturan — aktivasi tercatat, FP rate terpantau" bodyClass="p-0">
        <DataTable head={["Aturan", "Versi aktif", "Riwayat", "Hit / FP", "Aksi"]}>
          {data.rules.map((r: AnyRec) => (
            <tr key={r.id} className="border-b border-line/60 last:border-0 hover:bg-panel-2/60">
              <td className="px-3 py-2"><b>{r.id}</b> <span className="text-soft">{r.nama}</span><div className="text-muted">{r.owner} · pain point {r.pain_point}</div></td>
              <td className="px-3 py-2 font-mono">v{r.versi_aktif}</td>
              <td className="px-3 py-2 text-muted"><Lifecycle rule={r} act={act} /><div className="mt-1">{r.versi.map((v: AnyRec) => <div key={v.versi}>v{v.versi} ({v.tanggal}) — {v.perubahan}</div>)}</div></td>
              <td className="px-3 py-2 tabular-nums">{Math.round(r.hit_rate * 100)}% / {Math.round(r.false_positive_rate * 100)}%</td>
              <td className="px-3 py-2">{r.versi.filter((v: AnyRec) => v.versi !== r.versi_aktif).map((v: AnyRec) => <button key={v.versi} type="button" onClick={() => activate(r.id, v.versi)} className="whitespace-nowrap text-ocean hover:underline">Aktifkan v{v.versi}</button>)}</td>
            </tr>
          ))}
        </DataTable>
      </Widget>
      <Widget title="Buat versi aturan baru" caption="Alur resmi Tahap 2: draft → review → persetujuan → aktif (semua tercatat & persisten)">
        <div className="flex flex-wrap items-end gap-2 text-xs">
          <label className="grid gap-1 text-muted">Aturan<select value={draft.rule_id} onChange={(e) => setDraft({ ...draft, rule_id: e.target.value })} className={inputCls}>{data.rules.map((r: AnyRec) => <option key={r.id} value={r.id}>{r.id} — {r.nama}</option>)}</select></label>
          <label className="grid gap-1 text-muted">Versi baru<input value={draft.versi} onChange={(e) => setDraft({ ...draft, versi: e.target.value })} placeholder="2.2.0" className={inputCls} /></label>
          <label className="grid flex-1 gap-1 text-muted">Catatan perubahan<input value={draft.perubahan} onChange={(e) => setDraft({ ...draft, perubahan: e.target.value })} placeholder="mis. tambah cek indikasi transfusi" className={`${inputCls} min-w-52`} /></label>
          <button type="button" onClick={makeDraft} className="rounded-md bg-ocean px-3 py-1.5 font-semibold text-white hover:bg-ocean-deep">Buat draft</button>
        </div>
      </Widget>
      <div className="grid items-start gap-3 lg:grid-cols-2">
        <Widget title="Konektor & lineage" caption="Unified claims intelligence">
          {data.connectors.map((c: AnyRec) => <div key={c.sistem} className="flex items-center justify-between gap-2 border-b border-line/50 py-1.5 text-xs last:border-0"><span className="text-soft">{c.sistem}</span><span className={c.status === "terhubung" ? "text-ok" : "text-warn"}>{c.status} · {c.latensi_ms} ms</span></div>)}
          <p className="mt-3 text-[11px] leading-relaxed text-muted">{data.lineage.join(" → ")}</p>
        </Widget>
        <Widget title="Audit trail" caption="Setiap perubahan aturan & alasannya">
          {data.audit_trail.map((a: AnyRec, i: number) => <div key={i} className="border-b border-line/50 py-1.5 text-xs last:border-0"><span className="text-muted">{a.waktu} · {a.aktor}</span><br /><b>{a.aksi}</b> <span className="text-soft">— {a.detail}</span></div>)}
        </Widget>
      </div>
    </div>
  );
}

const TIER_COLORS: Record<string, string> = { Kritis: "#f0616d", Tinggi: "#f0a843", Sedang: "#e2b866", Rendah: "#34c38f" };
const ISSUE_LABEL: Record<string, string> = { duplicate_billing: "Duplicate", upcoding: "Upcoding", phantom_billing: "Phantom", unnecessary_service: "Tanpa indikasi", unsupported_documentation: "Dokumen kurang", over_tariff: "Di atas tarif" };

export function SummaryPanel({ ov, go }: { ov: AnyRec; go: (t: string) => void }) {
  const k = ov.kpi, ch = ov.charts ?? {};
  const tiers = Object.entries(ch.distribusi_tier ?? {}).map(([label, value]) => ({ label, value: value as number, color: TIER_COLORS[label] ?? "#8391a7" }));
  const issues = Object.entries(ch.distribusi_temuan ?? {}).map(([key, value]) => ({ label: ISSUE_LABEL[key] ?? key, value: value as number, color: "#f0a843" })).sort((a, b) => b.value - a.value);
  const faskes = (ch.risiko_per_faskes ?? []).map((f: AnyRec) => ({ label: f.nama, value: f.nilai_risiko, color: "#f0616d" })).sort((a: AnyRec, b: AnyRec) => b.value - a.value);
  return (
    <div className="space-y-3">
      {/* Hero risiko: angka kerugian besar + komposisi tier */}
      <div className="grid gap-3 xl:grid-cols-[1.25fr_1fr]">
        <div className="rounded-xl bg-panel p-5 ring-1 ring-line">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-muted">Estimasi nilai berisiko terdeteksi</div>
          <div className="mt-1 text-4xl font-bold tabular-nums tracking-tight text-bad sm:text-5xl">{rp(k.estimasi_kerugian_rp)}</div>
          <p className="mt-2 max-w-md text-xs leading-relaxed text-muted">Dari {k.klaim_terflag} klaim terflag sebelum pembayaran — ditahan di jalur review/hold, bukan dibayar lalu dikejar.</p>
          <div className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3 text-center">
            <button type="button" onClick={() => go("kasus")} className="hover:opacity-80"><div className="text-xl font-bold tabular-nums">{k.kasus_investigasi}</div><div className="text-[11px] text-muted">kasus investigasi</div></button>
            <button type="button" onClick={() => go("graf")} className="hover:opacity-80"><div className="text-xl font-bold tabular-nums">{k.jaringan_kolusi}</div><div className="text-[11px] text-muted">jaringan kolusi</div></button>
            <button type="button" onClick={() => go("prepay")} className="hover:opacity-80"><div className="text-xl font-bold tabular-nums">{k.klaim_belum_dibayar}</div><div className="text-[11px] text-muted">klaim belum dibayar</div></button>
          </div>
        </div>
        <Widget title="Komposisi risiko klaim" caption="Distribusi tier skor per klaim"><Donut data={tiers} /></Widget>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Widget title="Temuan billing terbanyak" caption="Jenis anomali sebelum pembayaran"><HBars data={issues} /></Widget>
        <Widget title="Nilai berisiko per faskes" caption="Konsentrasi kerugian untuk prioritas audit"><HBars data={faskes} format={rp} /></Widget>
      </div>
      <Widget title="Cakupan enam pain point" caption="Klik untuk membuka panel pembuktiannya" bodyClass="p-2">
        <div className="grid gap-1.5 md:grid-cols-2">
          {ov.pain_points.map((p: AnyRec) => (
            <button key={p.no} type="button" onClick={() => go(["kasus", "graf", "billing", "skor", "prepay", "aturan"][p.no - 1])} className="rounded-md bg-panel-2/50 p-3 text-left transition hover:bg-panel-2 hover:ring-1 hover:ring-ocean/50">
              <span className="flex items-center gap-2 text-[13px] font-medium"><span className="font-mono text-[11px] text-muted">0{p.no}</span>{p.judul}<span className="ml-auto text-[11px] font-semibold text-ok">{p.status}</span></span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">{p.bukti}</span>
            </button>
          ))}
        </div>
      </Widget>
    </div>
  );
}
