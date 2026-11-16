"use client";
import { useState } from "react";
import { mobile, rp, rpShort, tgl, type Rec } from "../_ui/api";
import { Badge, Btn, Card, DemoNote, Empty, ICONS, Loading, Sheet, Shell, field, toneFor, useLocal, usePoll, useToast } from "../_ui/kit";

/* JKN Rumah Sakit (demo): the hospital sees each claim's status and why it is held, answers document requests from
   the officer (camera or file), checks a claim against the same rules before sending it, and its compliance score. */
const C = "#1d4ed8";
type Tab = "klaim" | "permintaan" | "cek" | "profil";
const DOKTER = [["D-01", "dr. Contoh Satu, Sp.PD"], ["D-02", "dr. Contoh Dua, Sp.B"], ["D-03", "dr. Contoh Tiga, Sp.OT"], ["D-06", "dr. Contoh Enam, Sp.OG"]];
const DIAG = [["J18.9", "Pneumonia"], ["I10", "Hipertensi"], ["K35.8", "Apendisitis akut"], ["M17.1", "Osteoartritis lutut"], ["O82", "Persalinan sesar"], ["D64.9", "Anemia"], ["N18.5", "Gagal ginjal kronik"]];
const PROC = [["87.44", "Foto thorax"], ["NONE", "Tanpa prosedur khusus"], ["47.09", "Appendektomi"], ["81.54", "Total knee replacement"], ["74.1", "Sectio caesarea"], ["99.04", "Transfusi darah"], ["39.95", "Hemodialisis"]];
const DOK = [["resume_medis", "Resume medis"], ["hasil_lab", "Hasil lab"], ["log_tindakan", "Log tindakan"], ["kehadiran", "Daftar hadir pasien"]];

export default function RsApp() {
  const [tab, setTab] = useState<Tab>("klaim");
  const [fid, setFid] = useLocal("jkn-mobile:rs", "RS-01");
  const { data, error, reload } = usePoll(() => mobile.rs(fid), [fid]);
  const [sel, setSel] = useState<Rec | null>(null);
  const [filter, setFilter] = useState<"semua" | "perhatian">("perhatian");
  const [toast, say] = useToast();
  const open = data?.permintaan_terbuka?.length ?? 0;
  const klaim: Rec[] = (data?.klaim ?? []).filter((k: Rec) => filter === "semua" || (k.status_bayar !== "sudah_dibayar" && k.jalur !== "otomatis") || k.permintaan?.some((r: Rec) => r.status === "Terbuka"));

  return (
    <Shell app="rs" color={C} title={data?.faskes?.nama ?? "JKN Rumah Sakit"} subtitle={data ? `${data.faskes.jenis}${data.faskes.kelas !== "-" ? ` kelas ${data.faskes.kelas}` : ""} · ${data.faskes.kantor_cabang}` : "Portal faskes"}
      tab={tab} setTab={setTab}
      tabs={[{ key: "klaim", label: "Klaim", icon: ICONS.doc }, { key: "permintaan", label: "Permintaan", icon: ICONS.upload, badge: open },
        { key: "cek", label: "Cek klaim", icon: ICONS.check }, { key: "profil", label: "Kepatuhan", icon: ICONS.building }]}>
      {!data ? <Loading error={error} onRetry={reload} /> : (
        <>
          {tab === "klaim" && (
            <>
              {open > 0 && <button onClick={() => setTab("permintaan")} className="mb-3 w-full rounded-xl bg-[#fdf1d8] px-3.5 py-3 text-left text-[14px] text-[#8a5a00]"><b>{open} permintaan berkas</b> dari petugas BPJS menunggu jawaban ›</button>}
              <div className="mb-2 flex gap-1.5">{(["perhatian", "semua"] as const).map((f) => <button key={f} onClick={() => setFilter(f)} className={`rounded-full px-3 py-1.5 text-[13px] font-medium ${filter === f ? "text-white" : "bg-white text-[#5f6b7c] ring-1 ring-[#dfe3e8]"}`} style={filter === f ? { background: C } : undefined}>{f === "perhatian" ? "Perlu perhatian" : "Semua klaim"}</button>)}</div>
              <div className="space-y-2">
                {klaim.length === 0 ? <Empty>Tidak ada klaim yang perlu perhatian.</Empty> : klaim.map((k) => (
                  <Card key={k.no_sep} onClick={() => setSel(k)}>
                    <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="text-[15px] font-semibold">{k.prosedur !== "NONE" ? k.prosedur_nama : k.diagnosa_nama}</p><p className="text-[12.5px] text-[#5f6b7c]">{k.no_sep} · {tgl(k.tanggal)} · {k.peserta}</p></div><p className="shrink-0 text-[14px] font-semibold tabular-nums">{rpShort(k.tarif_klaim)}</p></div>
                    <div className="mt-2 flex flex-wrap gap-1.5"><Badge tone={toneFor(k.status)}>{k.status}</Badge>{k.permintaan?.some((r: Rec) => r.status === "Terbuka") && <Badge tone="amber">Berkas diminta</Badge>}</div>
                  </Card>
                ))}
              </div>
            </>
          )}
          {tab === "permintaan" && (
            <div className="space-y-2">
              {open === 0 ? <Empty>Tidak ada permintaan berkas terbuka.</Empty> : data.permintaan_terbuka.map((r: Rec) => <Permintaan key={r.id} r={r} fid={fid} onDone={() => { say("Berkas terkirim ke petugas BPJS"); reload(); }} />)}
            </div>
          )}
          {tab === "cek" && <Cek fid={fid} />}
          {tab === "profil" && <Profil data={data} fid={fid} setFid={setFid} />}
          <DemoNote />
        </>
      )}
      <Sheet open={!!sel} onClose={() => setSel(null)} title={sel ? `Klaim ${sel.no_sep}` : ""}>
        {sel && <KlaimDetail k={sel} fid={fid} onDone={() => { setSel(null); say("Berkas terkirim ke petugas BPJS"); reload(); }} />}
      </Sheet>
      {toast}
    </Shell>
  );
}

function KlaimDetail({ k, fid, onDone }: { k: Rec; fid: string; onDone: () => void }) {
  const req: Rec[] = k.permintaan?.filter((r: Rec) => r.status === "Terbuka") ?? [];
  return (
    <div className="space-y-3 text-[14px]">
      <div className="flex flex-wrap items-center gap-2"><Badge tone={toneFor(k.status)}>{k.status}</Badge><span className="text-[13px] text-[#5f6b7c]">Skor risiko {k.skor} · {k.tier}</span></div>
      <dl className="grid grid-cols-[110px_1fr] gap-y-1.5">
        {[["Layanan", k.prosedur_nama], ["Diagnosis", `${k.diagnosa} · ${k.diagnosa_nama}`], ["Dokter", k.dokter], ["Tanggal", tgl(k.tanggal)], ["Tarif klaim", rp(k.tarif_klaim)]].map(([a, b]) => <div key={a} className="contents"><dt className="text-[#5f6b7c]">{a}</dt><dd className="font-medium">{b}</dd></div>)}
      </dl>
      {k.jalur !== "otomatis" && k.status_bayar !== "sudah_dibayar" && (
        <div className="rounded-xl bg-[#fff7ed] p-3"><p className="font-semibold text-[#9a3412]">Mengapa klaim ini diperiksa</p><ul className="mt-1.5 space-y-1 text-[13px] text-[#7c2d12]">{k.alasan.map((a: string) => <li key={a}>• {a}</li>)}</ul></div>
      )}
      {k.keputusan?.catatan && <p className="rounded-xl bg-[#f4f6f8] p-3 text-[13px]">Catatan petugas: {k.keputusan.catatan}</p>}
      <div><p className="mb-1 font-semibold">Kelengkapan dokumen</p><div className="grid grid-cols-2 gap-1.5 text-[13px]">{DOK.map(([key, label]) => <span key={key} className={k.dokumen[key] ? "text-[#1c6e42]" : "text-[#a82a12]"}>{k.dokumen[key] ? "✓" : "✗"} {label}</span>)}</div></div>
      {req.map((r) => <Permintaan key={r.id} r={r} fid={fid} onDone={onDone} />)}
      {k.berkas?.length > 0 && <p className="text-[13px] text-[#5f6b7c]">Sudah dikirim: {k.berkas.map((b: Rec) => `${b.jenis} (${b.waktu})`).join(", ")}</p>}
    </div>
  );
}

function Permintaan({ r, fid, onDone }: { r: Rec; fid: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const kirim = async () => {
    if (!file) return;
    setBusy(true); setErr(null);
    try { await mobile.unggah(fid, r.no_sep, r.jenis, file); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card className="border-[#f5c56b]">
      <div className="flex items-center gap-2"><p className="flex-1 text-[14.5px] font-semibold">{r.jenis}</p><Badge tone="amber">Diminta</Badge></div>
      <p className="mt-0.5 text-[12.5px] text-[#5f6b7c]">{r.no_sep} · {r.waktu}</p>
      {r.catatan && <p className="mt-1.5 text-[13.5px]">“{r.catatan}”</p>}
      <label className="mt-3 flex min-h-[48px] cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#bcc5cf] px-3 text-[14px] text-[#4a5563]">
        <span className="h-5 w-5">{ICONS.upload}</span>{file ? file.name : "Foto dokumen atau pilih file"}
        <input type="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      {err && <p className="mt-1.5 text-[13px] text-[#a82a12]">{err}</p>}
      <Btn color={C} onClick={kirim} disabled={!file || busy} className="mt-2 w-full">{busy ? "Mengunggah…" : "Kirim ke petugas BPJS"}</Btn>
    </Card>
  );
}

function Cek({ fid }: { fid: string }) {
  const [f, setF] = useState({ dokter: "D-01", diagnosa: "J18.9", prosedur: "87.44", severity_diklaim: 1, severity_didukung: 1, tarif_klaim: 350000 });
  const [dok, setDok] = useState<Record<string, boolean>>({ resume_medis: true, hasil_lab: true, log_tindakan: true, kehadiran: true });
  const [res, setRes] = useState<Rec | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { setRes(await mobile.cek(fid, { ...f, dokumen: dok })); } finally { setBusy(false); } };
  const sel = (key: keyof typeof f, opts: string[][]) => <select value={String(f[key])} onChange={(e) => { setF({ ...f, [key]: e.target.value }); setRes(null); }} className={field}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
  return (
    <div className="space-y-3">
      <p className="px-1 text-[13px] leading-snug text-[#5f6b7c]">Periksa klaim dengan aturan yang sama yang dipakai BPJS — sebelum dikirim. Hasil cek tidak tercatat dan tidak dikirim.</p>
      <Card className="space-y-2.5">
        <label className="block text-[13px] font-medium">Dokter{sel("dokter", DOKTER)}</label>
        <label className="block text-[13px] font-medium">Diagnosis{sel("diagnosa", DIAG)}</label>
        <label className="block text-[13px] font-medium">Prosedur{sel("prosedur", PROC)}</label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[13px] font-medium">Severity diklaim{sel("severity_diklaim", [["1", "I"], ["2", "II"], ["3", "III"]])}</label>
          <label className="block text-[13px] font-medium">Didukung lab{sel("severity_didukung", [["1", "I"], ["2", "II"], ["3", "III"]])}</label>
        </div>
        <label className="block text-[13px] font-medium">Tarif klaim (Rp)<input inputMode="numeric" value={f.tarif_klaim} onChange={(e) => { setF({ ...f, tarif_klaim: Number(e.target.value.replace(/\D/g, "")) || 0 }); setRes(null); }} className={field} /></label>
        <div><p className="text-[13px] font-medium">Dokumen terlampir</p><div className="mt-1 grid grid-cols-2 gap-1.5">{DOK.map(([k, l]) => <label key={k} className="flex min-h-[40px] items-center gap-2 text-[13.5px]"><input type="checkbox" checked={dok[k]} onChange={(e) => { setDok({ ...dok, [k]: e.target.checked }); setRes(null); }} className="h-5 w-5 accent-[#1d4ed8]" />{l}</label>)}</div></div>
        <Btn color={C} onClick={run} disabled={busy} className="w-full">{busy ? "Memeriksa…" : "Cek klaim"}</Btn>
      </Card>
      {res && (
        <Card>
          <div className="flex items-center gap-2"><p className="flex-1 text-[15px] font-semibold">Perkiraan: {res.status_perkiraan}</p><Badge tone={toneFor(res.jalur)}>Skor {res.skor}</Badge></div>
          <ul className="mt-2 space-y-1 text-[13.5px]">{res.saran.map((s: string) => <li key={s}>{res.jalur === "otomatis" ? "✓" : "→"} {s}</li>)}</ul>
          {res.faktor?.length > 0 && <div className="mt-2.5 space-y-1.5">{res.faktor.map((x: Rec) => <div key={x.faktor}><div className="flex justify-between text-[12.5px]"><span>{x.faktor}</span><span className="tabular-nums">+{x.kontribusi}</span></div><div className="h-1.5 rounded-full bg-[#eceff2]"><div className="h-1.5 rounded-full bg-[#c2410c]" style={{ width: `${Math.min(100, x.kontribusi * 2)}%` }} /></div></div>)}</div>}
        </Card>
      )}
    </div>
  );
}

function Profil({ data, fid, setFid }: { data: Rec; fid: string; setFid: (s: string) => void }) {
  const { data: list } = usePoll(() => mobile.rsList(), []);
  const k = data.kepatuhan;
  const color = k.skor >= 80 ? "#15803d" : k.skor >= 60 ? "#b45309" : "#b91c1c";
  return (
    <div className="space-y-3">
      <Card>
        <p className="text-[13px] font-semibold text-[#5f6b7c]">Skor kepatuhan klaim</p>
        <div className="mt-1 flex items-end gap-2"><p className="text-[44px] font-bold leading-none tabular-nums" style={{ color }}>{k.skor}</p><p className="pb-1.5 text-[14px] text-[#5f6b7c]">/ 100</p></div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">{[["Dokumen lengkap", `${k.dokumen_lengkap_pct}%`], ["Lolos otomatis", `${k.lolos_otomatis_pct}%`], ["Rata skor risiko", k.rata_skor_risiko]].map(([a, b]) => <div key={a} className="rounded-xl bg-[#f4f6f8] px-2 py-2"><p className="text-[17px] font-semibold tabular-nums">{b}</p><p className="text-[11px] text-[#5f6b7c]">{a}</p></div>)}</div>
        <p className="mt-2.5 text-[11.5px] text-[#8a95a3]">{k.rumus}</p>
      </Card>
      <Card><p className="text-[13px] font-semibold">Ganti faskes (demo)</p><select value={fid} onChange={(e) => setFid(e.target.value)} className={`${field} mt-2`}>{(list?.faskes ?? [data.faskes]).map((p: Rec) => <option key={p.id} value={p.id}>{p.nama}</option>)}</select></Card>
    </div>
  );
}
