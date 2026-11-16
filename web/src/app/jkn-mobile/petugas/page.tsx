"use client";
import { useState } from "react";
import { fileUrl, mobile, rp, rpShort, tgl, type Rec } from "../_ui/api";
import { Badge, Btn, Card, DemoNote, Empty, ICONS, Loading, Sheet, Shell, field, toneFor, usePoll, useToast } from "../_ui/kit";

/* JKN Petugas (demo): the verification officer's phone — the pre-payment queue with the engine's reasons (patients'
   reports first), decisions that reach the hospital, incoming documents, investigation cases, field visits with photo
   and GPS, and questions to the GenAI agent over the Nexus graph. */
const C = "#0f766e";
type Tab = "antrian" | "laporan" | "kasus" | "kunjungan" | "ai";
const JALUR: Record<string, string> = { hold: "Ditahan", review: "Review", otomatis: "Otomatis" };

export default function PetugasApp() {
  const [tab, setTab] = useState<Tab>("antrian");
  const { data, error, reload } = usePoll(() => mobile.petugas(), []);
  const [sel, setSel] = useState<string | null>(null);
  const [lane, setLane] = useState<"semua" | "hold" | "review" | "otomatis">("semua");
  const [toast, say] = useToast();
  const r = data?.ringkasan;
  const claim = sel ? (data?.antrian ?? []).find((c: Rec) => c.no_sep === sel) : null;
  const antrian: Rec[] = (data?.antrian ?? []).filter((c: Rec) => lane === "semua" || c.jalur === lane);

  return (
    <Shell app="petugas" color={C} title="Verifikasi Klaim" subtitle="Petugas Verifikasi · KC Contoh Kota" tab={tab} setTab={setTab}
      tabs={[{ key: "antrian", label: "Antrian", icon: ICONS.inbox, badge: r ? r.hold : 0 }, { key: "laporan", label: "Laporan", icon: ICONS.flag, badge: r?.laporan_baru },
        { key: "kasus", label: "Berkas", icon: ICONS.folder, badge: r?.berkas_baru }, { key: "kunjungan", label: "Kunjungan", icon: ICONS.pin }, { key: "ai", label: "Tanya AI", icon: ICONS.spark }]}>
      {!data ? <Loading error={error} onRetry={reload} /> : (
        <>
          {tab === "antrian" && (
            <>
              <div className="grid grid-cols-3 gap-2">
                {([["hold", "Ditahan", "#b91c1c"], ["review", "Review", "#b45309"], ["otomatis", "Otomatis", "#15803d"]] as const).map(([k, l, col]) => (
                  <button key={k} onClick={() => setLane(lane === k ? "semua" : k)} className={`rounded-xl bg-white px-2 py-2.5 text-left ring-1 ${lane === k ? "ring-2" : "ring-[#e3e7ec]"}`} style={lane === k ? { boxShadow: `inset 0 0 0 2px ${col}` } : undefined}>
                    <p className="text-[22px] font-bold leading-none tabular-nums" style={{ color: col }}>{r[k]}</p><p className="mt-1 text-[12px] text-[#5f6b7c]">{l}</p></button>
                ))}
              </div>
              <p className="mt-2 px-1 text-[12.5px] text-[#5f6b7c]">Nilai ditahan sebelum dibayar: <b className="text-[#1c2127]">{rpShort(r.nilai_ditahan_rp)}</b></p>
              <div className="mt-2 space-y-2">
                {antrian.map((c) => {
                  const lap = c.laporan_peserta?.some((x: Rec) => x.status === "Baru");
                  return (
                    <Card key={c.no_sep} onClick={() => setSel(c.no_sep)} className={lap ? "border-[#f0a58a]" : ""}>
                      {lap && <p className="mb-1.5 text-[12px] font-semibold text-[#c2410c]">⚑ Dilaporkan peserta: tidak menerima layanan</p>}
                      <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="text-[15px] font-semibold">{c.prosedur !== "NONE" ? c.prosedur_nama : c.diagnosa_nama}</p><p className="text-[12.5px] text-[#5f6b7c]">{c.nama_faskes} · {c.no_sep}</p></div><p className="shrink-0 text-[14px] font-semibold tabular-nums">{rpShort(c.tarif_klaim)}</p></div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5"><Badge tone={toneFor(c.keputusan ? c.status : JALUR[c.jalur])}>{c.keputusan ? c.status : JALUR[c.jalur]}</Badge><span className="text-[12px] text-[#5f6b7c]">Skor {c.skor}</span>{c.berkas?.some((b: Rec) => !b.dibaca) && <Badge tone="blue">Berkas baru</Badge>}</div>
                      {c.jalur !== "otomatis" && !c.keputusan && <p className="mt-1.5 line-clamp-2 text-[12.5px] text-[#4a5563]">{c.alasan[0]}</p>}
                    </Card>
                  );
                })}
              </div>
            </>
          )}
          {tab === "laporan" && (
            <div className="space-y-2">
              <p className="px-1 text-[12.5px] text-[#5f6b7c]">Peserta yang menyatakan tidak menerima layanan yang ditagihkan atas namanya.</p>
              {data.laporan.length === 0 ? <Empty>Belum ada laporan peserta.</Empty> : data.laporan.map((x: Rec) => (
                <Card key={x.id} onClick={() => setSel(x.no_sep)}>
                  <div className="flex items-center gap-2"><p className="flex-1 text-[14.5px] font-semibold">{x.jenis}</p><Badge tone={toneFor(x.status)}>{x.status}</Badge></div>
                  <p className="mt-0.5 text-[12.5px] text-[#5f6b7c]">{x.no_sep} · {x.nama_faskes} · {x.waktu}</p>
                  <p className="mt-1 text-[13px]">{x.prosedur_nama} · {rp(x.tarif_klaim)}</p>
                  <p className="mt-1.5 text-[13.5px] italic">“{x.alasan}”</p>
                </Card>
              ))}
            </div>
          )}
          {tab === "kasus" && <Berkas data={data} onRead={async (id) => { await mobile.dibaca(id); reload(); }} />}
          {tab === "kunjungan" && <Kunjungan data={data} onDone={() => { say("Kunjungan tercatat"); reload(); }} />}
          {tab === "ai" && <TanyaAI />}
          <DemoNote />
        </>
      )}
      <Sheet open={!!claim} onClose={() => setSel(null)} title={claim ? `${claim.no_sep}` : ""}>
        {claim && <Keputusan c={claim} jenisBerkas={data?.jenis_berkas ?? []} onDone={(m) => { setSel(null); say(m); reload(); }} />}
      </Sheet>
      {toast}
    </Shell>
  );
}

function Keputusan({ c, jenisBerkas, onDone }: { c: Rec; jenisBerkas: string[]; onDone: (m: string) => void }) {
  const [mode, setMode] = useState<"" | "minta_berkas" | "tahan">("");
  const [jenis, setJenis] = useState(jenisBerkas[3] ?? jenisBerkas[0]);
  const [catatan, setCatatan] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const kirim = async (keputusan: string) => {
    setBusy(true); setErr(null);
    try {
      await mobile.keputusan({ no_sep: c.no_sep, keputusan, catatan, jenis_berkas: keputusan === "minta_berkas" ? jenis : undefined });
      onDone(keputusan === "setujui" ? "Klaim disetujui untuk dibayar" : keputusan === "tahan" ? "Pembayaran ditahan" : "Permintaan berkas dikirim ke rumah sakit");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const lap: Rec[] = c.laporan_peserta ?? [];
  return (
    <div className="space-y-3 text-[14px]">
      <div className="flex flex-wrap items-center gap-2"><Badge tone={toneFor(c.keputusan ? c.status : JALUR[c.jalur])}>{c.keputusan ? c.status : `Mesin: ${JALUR[c.jalur]}`}</Badge><span className="text-[13px] text-[#5f6b7c]">Skor {c.skor} · {c.tier}</span></div>
      <dl className="grid grid-cols-[100px_1fr] gap-y-1.5">
        {[["Faskes", c.nama_faskes], ["Layanan", `${c.prosedur_nama} · ${c.diagnosa_nama}`], ["Dokter", c.dokter], ["Peserta", c.peserta], ["Tanggal", tgl(c.tanggal)], ["Tarif", rp(c.tarif_klaim)]].map(([a, b]) => <div key={a} className="contents"><dt className="text-[#5f6b7c]">{a}</dt><dd className="font-medium">{b}</dd></div>)}
      </dl>
      {lap.map((x) => <div key={x.id} className="rounded-xl bg-[#fff1ec] p-3 text-[13.5px] text-[#9a3412]"><b>Laporan peserta ({x.waktu}):</b> {x.jenis} — “{x.alasan}”</div>)}
      <div className="rounded-xl border border-[#e3e7ec] p-3">
        <p className="font-semibold">Alasan skor (explainable)</p>
        <ul className="mt-1 space-y-1 text-[13px] text-[#4a5563]">{c.alasan.map((a: string) => <li key={a}>• {a}</li>)}</ul>
        <div className="mt-2 space-y-1.5">{c.faktor.map((x: Rec) => <div key={x.faktor}><div className="flex justify-between text-[12.5px]"><span>{x.faktor}</span><span className="tabular-nums">+{x.kontribusi}</span></div><div className="h-1.5 rounded-full bg-[#eceff2]"><div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, x.kontribusi * 2)}%`, background: C }} /></div></div>)}</div>
        {c.nilai_risiko_rp > 0 && <p className="mt-2 text-[12.5px] text-[#5f6b7c]">Nilai berisiko: <b>{rp(c.nilai_risiko_rp)}</b></p>}
      </div>
      {c.berkas?.length > 0 && <div><p className="mb-1 font-semibold">Berkas dari rumah sakit</p>{c.berkas.map((b: Rec) => <a key={b.id} href={fileUrl(b.id)} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-2 rounded-xl border border-[#e3e7ec] px-3 py-2.5 text-[13.5px]"><span className="h-5 w-5 text-[#5f6b7c]">{ICONS.doc}</span><span className="flex-1">{b.jenis}<span className="block text-[12px] text-[#5f6b7c]">{b.nama_file} · {b.waktu}</span></span><span style={{ color: C }}>Buka</span></a>)}</div>}
      {c.keputusan && <p className="rounded-xl bg-[#f4f6f8] p-3 text-[13px]">Keputusan terakhir: <b>{c.status}</b> oleh {c.keputusan.petugas} · {c.keputusan.waktu}{c.keputusan.catatan ? ` — ${c.keputusan.catatan}` : ""}</p>}
      {mode === "minta_berkas" && <div className="space-y-2"><select value={jenis} onChange={(e) => setJenis(e.target.value)} className={field}>{jenisBerkas.map((j) => <option key={j}>{j}</option>)}</select></div>}
      {mode && <textarea value={catatan} onChange={(e) => setCatatan(e.target.value)} rows={2} placeholder={mode === "tahan" ? "Alasan penahanan (wajib)" : "Pesan untuk rumah sakit"} className={field} />}
      {err && <p className="text-[13px] text-[#a82a12]">{err}</p>}
      {!mode ? (
        <div className="grid grid-cols-3 gap-2">
          <Btn color="#15803d" onClick={() => kirim("setujui")} disabled={busy}>Setujui</Btn>
          <Btn color="#b45309" variant="outline" onClick={() => setMode("minta_berkas")} disabled={busy}>Minta berkas</Btn>
          <Btn color="#b91c1c" variant="outline" onClick={() => setMode("tahan")} disabled={busy}>Tahan</Btn>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2"><Btn color="#738091" variant="outline" onClick={() => setMode("")}>Batal</Btn>
          <Btn color={mode === "tahan" ? "#b91c1c" : "#b45309"} onClick={() => kirim(mode)} disabled={busy || (mode === "tahan" && !catatan.trim())}>{mode === "tahan" ? "Tahan pembayaran" : "Kirim permintaan"}</Btn></div>
      )}
      <p className="text-[11.5px] text-[#8a95a3]">Keputusan tercatat di audit trail. Mesin hanya merekomendasikan; petugas yang memutuskan.</p>
    </div>
  );
}

function Berkas({ data, onRead }: { data: Rec; onRead: (id: string) => void }) {
  return (
    <div className="space-y-4">
      <section><p className="mb-1.5 px-1 text-[13px] font-semibold text-[#5f6b7c]">Berkas masuk dari rumah sakit</p>
        <div className="space-y-2">{data.berkas.filter((b: Rec) => b.no_sep !== "-").length === 0 ? <Empty>Belum ada berkas masuk.</Empty> : data.berkas.filter((b: Rec) => b.no_sep !== "-").map((b: Rec) => (
          <Card key={b.id}><div className="flex items-center gap-2"><p className="flex-1 text-[14.5px] font-semibold">{b.jenis}</p>{!b.dibaca && <Badge tone="blue">Baru</Badge>}</div>
            <p className="text-[12.5px] text-[#5f6b7c]">{b.no_sep} · {b.faskes} · {b.waktu}</p>
            <div className="mt-2 flex gap-2"><a href={fileUrl(b.id)} target="_blank" rel="noreferrer" onClick={() => !b.dibaca && onRead(b.id)} className="flex min-h-[42px] flex-1 items-center justify-center rounded-xl text-[14px] font-semibold text-white" style={{ background: C }}>Buka {b.nama_file}</a></div></Card>
        ))}</div></section>
      <section><p className="mb-1.5 px-1 text-[13px] font-semibold text-[#5f6b7c]">Kasus investigasi</p>
        <div className="space-y-2">{data.kasus.map((k: Rec) => (
          <Card key={k.id}><div className="flex items-center gap-2"><p className="flex-1 text-[14px] font-semibold">{k.judul}</p><Badge tone={k.prioritas === "P1" ? "red" : "amber"}>{k.prioritas}</Badge></div>
            <p className="mt-0.5 text-[12.5px] text-[#5f6b7c]">{k.id} · {k.status} · {k.jumlah_klaim} klaim · {rpShort(k.estimasi_kerugian_rp)}</p></Card>
        ))}</div></section>
    </div>
  );
}

function Kunjungan({ data, onDone }: { data: Rec; onDone: () => void }) {
  const [faskes, setFaskes] = useState(data.faskes[0]?.id ?? "RS-01");
  const [temuan, setTemuan] = useState("Sesuai");
  const [catatan, setCatatan] = useState("");
  const [foto, setFoto] = useState<File | null>(null);
  const [pos, setPos] = useState<{ lat: number; lon: number; acc: number } | null>(null);
  const [gps, setGps] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locate = () => {
    if (!navigator.geolocation) { setGps("Perangkat tidak mendukung lokasi"); return; }
    setGps("Mencari lokasi…");
    navigator.geolocation.getCurrentPosition((p) => { setPos({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }); setGps(null); }, (e) => setGps(e.message), { enableHighAccuracy: true, timeout: 15000 });
  };
  const kirim = async () => {
    setBusy(true);
    const f = new FormData(); f.append("faskes", faskes); f.append("temuan", temuan); f.append("catatan", catatan);
    if (pos) { f.append("lat", String(pos.lat)); f.append("lon", String(pos.lon)); }
    if (foto) f.append("foto", foto);
    try { await mobile.kunjungan(f); setCatatan(""); setFoto(null); onDone(); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3">
      <Card className="space-y-2.5">
        <p className="text-[15px] font-semibold">Catat kunjungan audit lapangan</p>
        <label className="block text-[13px] font-medium">Faskes<select value={faskes} onChange={(e) => setFaskes(e.target.value)} className={field}>{data.faskes.map((p: Rec) => <option key={p.id} value={p.id}>{p.nama}</option>)}</select></label>
        <label className="block text-[13px] font-medium">Temuan<select value={temuan} onChange={(e) => setTemuan(e.target.value)} className={field}>{["Sesuai", "Dokumen tidak lengkap", "Layanan tidak dapat diverifikasi", "Indikasi kecurangan"].map((t) => <option key={t}>{t}</option>)}</select></label>
        <textarea value={catatan} onChange={(e) => setCatatan(e.target.value)} rows={3} placeholder="Catatan pemeriksaan" className={field} />
        <div className="grid grid-cols-2 gap-2">
          <label className="flex min-h-[46px] cursor-pointer items-center justify-center gap-1.5 rounded-xl border-[1.5px] text-[13.5px] font-semibold" style={{ borderColor: C, color: C }}><span className="h-5 w-5">{ICONS.upload}</span>{foto ? "Foto ✓" : "Ambil foto"}<input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => setFoto(e.target.files?.[0] ?? null)} /></label>
          <Btn color={C} variant="outline" onClick={locate}>{pos ? "GPS ✓" : "Ambil GPS"}</Btn>
        </div>
        {(gps || pos) && <p className="text-[12.5px] text-[#5f6b7c]">{gps ?? `${pos!.lat.toFixed(5)}, ${pos!.lon.toFixed(5)} · akurasi ±${Math.round(pos!.acc)} m`}</p>}
        <Btn color={C} onClick={kirim} disabled={busy} className="w-full">{busy ? "Menyimpan…" : "Simpan kunjungan"}</Btn>
      </Card>
      {data.kunjungan.map((k: Rec) => (
        <Card key={k.id}><div className="flex items-center gap-2"><p className="flex-1 text-[14px] font-semibold">{k.nama_faskes}</p><Badge tone={toneFor(k.temuan)}>{k.temuan}</Badge></div>
          <p className="text-[12.5px] text-[#5f6b7c]">{k.waktu}{k.jarak_ke_faskes_km != null ? ` · ${k.jarak_ke_faskes_km} km dari faskes` : " · tanpa GPS"}{k.foto ? " · ada foto" : ""}</p>
          {k.catatan && <p className="mt-1 text-[13px]">{k.catatan}</p>}
          {k.foto && <a href={fileUrl(k.foto)} target="_blank" rel="noreferrer" className="mt-1.5 inline-block text-[13px] font-semibold" style={{ color: C }}>Lihat foto</a>}</Card>
      ))}
    </div>
  );
}

function TanyaAI() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<{ q: string; a?: string; refs?: Rec[]; err?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const ask = async (text: string) => {
    const t = text.trim(); if (!t || busy) return;
    setQ(""); setBusy(true); setItems((xs) => [...xs, { q: t }]);
    try { const r = await mobile.ask(t); setItems((xs) => xs.map((x, i) => i === xs.length - 1 ? { ...x, a: String(r.answer ?? "").replace(/\*\*/g, "").replace(/^\* /gm, "• "), refs: (r.refs ?? []).slice(0, 5) } : x)); }
    catch (e) { setItems((xs) => xs.map((x, i) => i === xs.length - 1 ? { ...x, err: (e as Error).message } : x)); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-2.5">
      <p className="px-1 text-[12.5px] text-[#5f6b7c]">Agen GenAI menjawab dari graf pengetahuan JKN (Nexus) dan menyebut sumbernya.</p>
      {items.length === 0 && <div className="flex flex-wrap gap-1.5">{["Faskes mana yang paling berisiko dan kenapa?", "Dokter mana yang pola rujukannya tidak wajar?", "Apa kategori risiko yang paling sering muncul?"].map((s) => <button key={s} onClick={() => ask(s)} className="rounded-full bg-white px-3 py-2 text-left text-[13px] ring-1 ring-[#dfe3e8]">{s}</button>)}</div>}
      {items.map((x, i) => (
        <div key={i} className="space-y-1.5">
          <p className="ml-auto w-fit max-w-[88%] rounded-2xl rounded-br-sm px-3 py-2 text-[14px] text-white" style={{ background: C }}>{x.q}</p>
          {x.a ? <Card><p className="whitespace-pre-line text-[14px] leading-relaxed">{x.a}</p>{x.refs && x.refs.length > 0 && <p className="mt-2 border-t border-[#eceff2] pt-2 text-[12px] text-[#5f6b7c]">Sumber: {x.refs.map((r, j) => `[${r.n ?? j + 1}] ${r.label}`).join(" · ")}</p>}</Card>
            : x.err ? <p className="text-[13px] text-[#a82a12]">Agen tidak menjawab: {x.err}</p> : <p className="text-[13px] text-[#5f6b7c]">Agen sedang mencari di graf Nexus…</p>}
        </div>
      ))}
      <div className="sticky bottom-0 flex gap-2 bg-[#f4f6f8] pt-1"><input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask(q)} placeholder="Tanya tentang faskes, klaim, dokter…" className={field} /><Btn color={C} onClick={() => ask(q)} disabled={busy || !q.trim()}>Kirim</Btn></div>
    </div>
  );
}
