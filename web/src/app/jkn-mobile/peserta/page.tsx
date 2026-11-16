"use client";
import { useState } from "react";
import { mobile, rp, tgl, type Rec } from "../_ui/api";
import { Badge, Btn, Card, DemoNote, Empty, ICONS, Loading, Sheet, Shell, field, toneFor, useLocal, usePoll, useToast } from "../_ui/kit";

/* JKN Peserta (demo): the participant's digital card, every service billed to JKN in their name — with "I did not
   receive this service" — nearby facilities and the reports they made. A report reaches the officer's inbox. */
const C = "#15803d";
type Tab = "kartu" | "riwayat" | "faskes" | "laporan";
const ALASAN = ["Saya tidak pernah menerima layanan ini", "Tanggal layanan tidak sesuai", "Tindakan berbeda dari yang saya terima", "Saya diminta membayar biaya tambahan"];

export default function PesertaApp() {
  const [tab, setTab] = useState<Tab>("riwayat");
  const [pid, setPid] = useLocal("jkn-mobile:peserta", "PES-204");
  const { data, error, reload } = usePoll(() => mobile.peserta(pid), [pid]);
  const [sel, setSel] = useState<Rec | null>(null);
  const [toast, say] = useToast();
  const laporanBaru = (data?.laporan ?? []).filter((x: Rec) => x.status !== "Baru" && x.tindak_lanjut).length;

  return (
    <Shell app="peserta" color={C} title={data ? `Halo, ${data.kartu.nama}` : "JKN Saya"} subtitle={data ? `${data.kartu.segmen} · ${data.kartu.kelas}` : "Peserta JKN"}
      tab={tab} setTab={setTab}
      tabs={[{ key: "kartu", label: "Kartu", icon: ICONS.card }, { key: "riwayat", label: "Layanan", icon: ICONS.history },
        { key: "faskes", label: "Faskes", icon: ICONS.pin }, { key: "laporan", label: "Laporan", icon: ICONS.flag, badge: laporanBaru }]}>
      {!data ? <Loading error={error} onRetry={reload} /> : (
        <>
          {tab === "kartu" && <Kartu k={data.kartu} pid={pid} setPid={setPid} />}
          {tab === "riwayat" && (
            <>
              <p className="mb-2 px-1 text-[13px] leading-snug text-[#5f6b7c]">Layanan yang ditagihkan ke BPJS Kesehatan atas nama Anda. Jika ada yang tidak Anda terima, laporkan — laporan Anda membantu mencegah kecurangan.</p>
              <div className="space-y-2">
                {data.layanan.map((l: Rec) => {
                  const lap = l.laporan_peserta?.[0];
                  return (
                    <Card key={l.no_sep} onClick={() => setSel(l)}>
                      <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><p className="text-[15px] font-semibold">{l.prosedur !== "NONE" ? l.prosedur_nama : l.diagnosa_nama}</p><p className="text-[13px] text-[#5f6b7c]">{l.nama_faskes} · {tgl(l.tanggal)}</p></div><p className="shrink-0 text-[14px] font-semibold tabular-nums">{rp(l.tarif_klaim)}</p></div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">{lap ? <Badge tone={toneFor(lap.status)}>Dilaporkan · {lap.status}</Badge> : <span className="text-[12.5px] font-medium" style={{ color: C }}>Periksa layanan ini ›</span>}</div>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
          {tab === "faskes" && <Faskes />}
          {tab === "laporan" && (
            <div className="space-y-2">
              {data.laporan.length === 0 ? <Empty>Belum ada laporan. Laporkan dari tab Layanan jika ada tagihan yang tidak Anda terima.</Empty> :
                data.laporan.slice().reverse().map((x: Rec) => (
                  <Card key={x.id}><div className="flex items-center gap-2"><p className="flex-1 text-[14px] font-semibold">{x.jenis}</p><Badge tone={toneFor(x.status)}>{x.status}</Badge></div>
                    <p className="mt-1 text-[13px] text-[#5f6b7c]">{x.no_sep} · {x.waktu}</p><p className="mt-1.5 text-[13.5px]">“{x.alasan}”</p>
                    {x.tindak_lanjut && <p className="mt-2 rounded-lg bg-[#e1f4e8] px-2.5 py-1.5 text-[13px] text-[#1c6e42]">Tindak lanjut BPJS: {x.tindak_lanjut}</p>}</Card>))}
            </div>
          )}
          <DemoNote />
        </>
      )}
      <Sheet open={!!sel} onClose={() => setSel(null)} title="Detail layanan">
        {sel && <Detail l={sel} onDone={(m, lapor) => { setSel(null); say(m); reload(); if (lapor) setTab("laporan"); }} pid={pid} />}
      </Sheet>
      {toast}
    </Shell>
  );
}

function Kartu({ k, pid, setPid }: { k: Rec; pid: string; setPid: (s: string) => void }) {
  const { data } = usePoll(() => mobile.pesertaList(), []);
  return (
    <>
      <div className="relative overflow-hidden rounded-2xl p-5 text-white shadow-lg" style={{ background: "linear-gradient(135deg,#15803d,#0f5132 70%)" }}>
        <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10" />
        <p className="text-[12px] uppercase tracking-wider text-white/80">Kartu Peserta JKN · Digital</p>
        <p className="mt-4 font-mono text-[21px] tracking-wider">{k.no_kartu}</p>
        <p className="mt-3 text-[17px] font-semibold">{k.nama}</p>
        <div className="mt-3 grid grid-cols-2 gap-2 text-[12.5px]"><span><span className="block text-white/70">Faskes tingkat 1</span>{k.fktp}</span><span><span className="block text-white/70">Kelas · Status</span>{k.kelas} · {k.status}</span></div>
      </div>
      <p className="mt-3 px-1 text-[13px] text-[#5f6b7c]">Tunjukkan kartu ini saat berobat di faskes. Nomor disamarkan pada demo.</p>
      <Card className="mt-4">
        <p className="text-[13px] font-semibold">Ganti peserta (demo)</p>
        <select value={pid} onChange={(e) => setPid(e.target.value)} className={`${field} mt-2`}>{(data?.peserta ?? [{ id: pid }]).map((p: Rec) => <option key={p.id} value={p.id}>{p.id}{p.layanan ? ` · ${p.layanan} layanan` : ""}</option>)}</select>
      </Card>
    </>
  );
}

function Detail({ l, pid, onDone }: { l: Rec; pid: string; onDone: (m: string, lapor?: boolean) => void }) {
  const [form, setForm] = useState(false);
  const [jenis, setJenis] = useState(ALASAN[0]);
  const [teks, setTeks] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lap = l.laporan_peserta?.[0];
  const kirim = async () => {
    setBusy(true); setErr(null);
    try { await mobile.lapor(pid, l.no_sep, jenis, teks.trim() || jenis); onDone("Laporan terkirim ke petugas BPJS", true); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3 text-[14px]">
      <dl className="grid grid-cols-[110px_1fr] gap-y-1.5">
        {[["Layanan", l.prosedur !== "NONE" ? l.prosedur_nama : "Pemeriksaan / rawat"], ["Diagnosis", l.diagnosa_nama], ["Faskes", l.nama_faskes], ["Dokter", l.dokter], ["Tanggal", tgl(l.tanggal)], ["Ditagihkan", rp(l.tarif_klaim)], ["No. SEP", l.no_sep]].map(([k, v]) => <div key={k} className="contents"><dt className="text-[#5f6b7c]">{k}</dt><dd className="font-medium">{v}</dd></div>)}
      </dl>
      <p className="rounded-lg bg-[#f4f6f8] px-3 py-2 text-[12.5px] text-[#5f6b7c]">Biaya ini dibayar BPJS Kesehatan ke faskes — Anda tidak perlu membayarnya.</p>
      {lap ? (
        <div className="rounded-xl border border-[#e3e7ec] p-3"><div className="flex items-center gap-2"><p className="flex-1 font-semibold">Anda sudah melaporkan layanan ini</p><Badge tone={toneFor(lap.status)}>{lap.status}</Badge></div><p className="mt-1 text-[13px] text-[#5f6b7c]">{lap.waktu} · “{lap.alasan}”</p>{lap.tindak_lanjut && <p className="mt-1.5 text-[13px] text-[#1c6e42]">{lap.tindak_lanjut}</p>}</div>
      ) : !form ? (
        <div className="grid gap-2"><Btn color={C} variant="outline" onClick={() => onDone("Terima kasih — layanan dikonfirmasi")}>Ya, saya menerima layanan ini</Btn><Btn color="#c2410c" onClick={() => setForm(true)}>Saya tidak menerima layanan ini</Btn></div>
      ) : (
        <div className="space-y-2">
          <p className="font-semibold">Apa yang tidak sesuai?</p>
          {ALASAN.map((a) => <label key={a} className="flex min-h-[44px] items-center gap-3 rounded-xl border border-[#e3e7ec] px-3"><input type="radio" name="alasan" checked={jenis === a} onChange={() => setJenis(a)} className="h-5 w-5 accent-[#c2410c]" />{a}</label>)}
          <textarea value={teks} onChange={(e) => setTeks(e.target.value)} rows={3} placeholder="Ceritakan singkat (opsional)" className={field} />
          {err && <p className="text-[13px] text-[#a82a12]">{err}</p>}
          <Btn color="#c2410c" onClick={kirim} disabled={busy} className="w-full">{busy ? "Mengirim…" : "Kirim laporan ke BPJS"}</Btn>
          <p className="text-[12px] text-[#738091]">Identitas Anda dilindungi. Laporan langsung masuk ke antrian petugas verifikasi.</p>
        </div>
      )}
    </div>
  );
}

function Faskes() {
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(null);
  const [gpsErr, setGpsErr] = useState<string | null>(null);
  const { data } = usePoll(() => mobile.faskes(pos?.lat, pos?.lon), [pos?.lat, pos?.lon]);
  const locate = () => {
    if (!navigator.geolocation) { setGpsErr("Perangkat tidak mendukung lokasi"); return; }
    navigator.geolocation.getCurrentPosition((p) => { setPos({ lat: p.coords.latitude, lon: p.coords.longitude }); setGpsErr(null); }, (e) => setGpsErr(e.message), { enableHighAccuracy: true, timeout: 10000 });
  };
  return (
    <>
      <Card><div className="flex items-center gap-3"><div className="flex-1 text-[13.5px]"><p className="font-semibold">{pos ? "Berdasarkan lokasi Anda" : "Lokasi contoh: pusat Kota Bandung"}</p><p className="text-[12.5px] text-[#5f6b7c]">{gpsErr ?? (pos ? `${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}` : "Izinkan lokasi untuk jarak yang akurat")}</p></div><Btn color={C} onClick={locate}>Lokasi saya</Btn></div></Card>
      <div className="mt-2 space-y-2">
        {(data?.faskes ?? []).map((f: Rec) => (
          <Card key={f.id}><div className="flex items-center gap-3"><div className="min-w-0 flex-1"><p className="text-[15px] font-semibold">{f.nama}</p><p className="text-[13px] text-[#5f6b7c]">{f.jenis}{f.kelas !== "-" ? ` · Kelas ${f.kelas}` : ""} · {f.jarak_km.toLocaleString("id-ID")} km</p></div>
            <a href={`https://www.openstreetmap.org/?mlat=${f.lat}&mlon=${f.lon}#map=17/${f.lat}/${f.lon}`} target="_blank" rel="noreferrer" className="shrink-0 rounded-xl border-[1.5px] px-3 py-2 text-[13px] font-semibold" style={{ borderColor: C, color: C }}>Peta</a></div></Card>
        ))}
      </div>
      <p className="mt-2 px-1 text-[11.5px] text-[#8a95a3]">{data?.catatan}</p>
    </>
  );
}
