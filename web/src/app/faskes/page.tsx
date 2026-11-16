"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge, Sheet, useToast } from "../jkn-mobile/_ui/kit";
import { ALAT, DEVICE, PASIEN, deviceById, lokasi, namaDevice, pasienById, type Alat } from "./_lib/data";
import { AMBANG_OTOMATIS, aktifDevice, aktifSlot, cocokkan, kunciPasangan, type Binding, type Usul } from "./_lib/match";
import { daftarPeringatan, type Peringatan } from "./_lib/peringatan";
import { durasi, ringkasanPulang } from "./_lib/ringkasan";
import { Bagian, Banner, C, DaftarAlasan, Ikon, Saklar, Skor, Tanda, Teks, isoLokal, jam, kodeTanggal, lama, tglJam, useSekarang, type Notif } from "./_ui/parts";
import { PreloadScan, ScanKamera, type JenisScan } from "./_ui/ScanKamera";

/* Faskes · Binding IoT (demo, phone first). A nurse scans patient wristbands and the QR on each IoT sensor (a current clamp
   on a medical device's power cable) into one scan session, in any order and any number. The matching engine pairs every
   device with a patient (doctor's order, bed, device status, one device per patient) and binds the sure pairs by itself;
   the rest wait for confirmation. Each binding opens an IoT session (sesi_id / device_id / peserta / kunjungan) as in
   docs/IOT_KONTRAK.md. "Scan" plays a recorded camera scan; data stays on this phone (localStorage). */

type Tab = "binding" | "pasien" | "device" | "peringatan" | "notif";
/** pulang: patient ID → discharge time (a discharged patient's sessions are closed and cannot be bound again) */
type Simpan = { bindings: Binding[]; notifs: Notif[]; seq: number; pulang?: Record<string, string> };
type Sesi = { pasien: string[]; device: string[]; tolak: string[] };
const KUNCI = "faskes-iot-binding:v1";
const SESI_KOSONG: Sesi = { pasien: [], device: [], tolak: [] };

export default function FaskesBinding() {
  const [tab, setTabRaw] = useState<Tab>("binding");
  const [db, setDb] = useState<Simpan>({ bindings: [], notifs: [], seq: 0 });
  const dbRef = useRef(db);
  useEffect(() => { dbRef.current = db; });
  const dimuat = useRef(false);
  const [sesi, setSesi] = useState<Sesi>(SESI_KOSONG);
  const [auto, setAuto] = useState(true);
  const [proses, setProses] = useState<{ usul: Usul; langkah: number; cara: Binding["cara"] } | null>(null);
  const [terakhir, setTerakhir] = useState<Binding | null>(null);
  const [scan, setScan] = useState<{ jenis: JenisScan; target?: string } | null>(null);
  const [manual, setManual] = useState<JenisScan | null>(null);
  const [banner, setBanner] = useState<Notif[]>([]);
  const [detail, setDetail] = useState<{ jenis: JenisScan; id: string } | null>(null);
  const [ringkas, setRingkas] = useState<string | null>(null);
  const [toast, say] = useToast();
  const now = useSekarang();

  // the bindings and notifications of this phone
  useEffect(() => {
    try {
      const s = localStorage.getItem(KUNCI);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read after hydration
      if (s) setDb(JSON.parse(s));
    } catch {}
    dimuat.current = true;
  }, []);
  useEffect(() => {
    if (!dimuat.current) return;
    try { localStorage.setItem(KUNCI, JSON.stringify(db)); } catch {}
  }, [db]);

  const setTab = (t: Tab) => {
    setTabRaw(t);
    if (t === "notif") setDb((s) => (s.notifs.some((n) => !n.baca) ? { ...s, notifs: s.notifs.map((n) => ({ ...n, baca: true })) } : s));
  };

  const kabar = useCallback((n: Omit<Notif, "id" | "waktu">) => {
    const x: Notif = { ...n, id: Math.random().toString(36).slice(2), waktu: new Date().toISOString() };
    setDb((s) => ({ ...s, notifs: [x, ...s.notifs].slice(0, 80) }));
    setBanner((q) => [...q, x]);
  }, []);

  const ikat = useCallback((u: Usul, cara: Binding["cara"]) => {
    const d = deviceById(u.device);
    const p = pasienById(u.pasien);
    const s = dbRef.current;
    const waktu = new Date().toISOString();
    const seq = s.seq + 1;
    const b: Binding = { sesi: `S-${kodeTanggal()}-${String(seq).padStart(3, "0")}`, device: d.id, pasien: p.id, sep: p.sep, mulai: waktu, cara, skor: u.skor };
    const lamaIkat = aktifDevice(s.bindings, d.id);
    setDb((x) => ({ ...x, seq: Math.max(x.seq, seq), bindings: [b, ...x.bindings.map((y) => (!y.selesai && y.device === d.id ? { ...y, selesai: waktu } : y))] }));
    setSesi((x) => ({ ...x, device: x.device.filter((id) => id !== d.id) }));
    setTerakhir(b);
    if (lamaIkat) kabar({ jenis: "info", judul: "Serah terima device", isi: `${d.id} dilepas dari ${lamaIkat.pasien} sebelum diikat ke ${p.id}.`, device: d.id });
    kabar({ jenis: "sukses", judul: "Binding IoT sukses", isi: `${d.id} · ${namaDevice(d)} terikat ke ${p.id} ${p.nama} (${lokasi(p)}). Pemakaian alat mulai direkam.`, device: d.id });
    try { navigator.vibrate?.([40, 60, 40]); } catch {}
  }, [kabar]);

  const lepas = (b: Binding) => {
    const waktu = new Date().toISOString();
    setDb((x) => ({ ...x, bindings: x.bindings.map((y) => (y.sesi === b.sesi ? { ...y, selesai: waktu } : y)) }));
    if (terakhir?.sesi === b.sesi) setTerakhir(null);
    kabar({ jenis: "info", judul: "Binding dilepas", isi: `${b.device} dilepas dari ${b.pasien}. Sesi ${b.sesi} ditutup.`, device: b.device });
  };

  const pulang = db.pulang ?? {};
  /** Discharge: close every IoT session of the patient at once and show the device-use summary for E-Klaim. */
  const pulangkan = (pid: string) => {
    const p = pasienById(pid);
    const waktu = new Date().toISOString();
    const ditutup = db.bindings.filter((b) => !b.selesai && b.pasien === pid).length;
    setDb((x) => ({
      ...x, pulang: { ...(x.pulang ?? {}), [pid]: waktu },
      bindings: x.bindings.map((b) => (!b.selesai && b.pasien === pid ? { ...b, selesai: waktu } : b)),
    }));
    setSesi((x) => ({ ...x, pasien: x.pasien.filter((id) => id !== pid) }));
    if (terakhir?.pasien === pid) setTerakhir(null);
    setDetail(null);
    setRingkas(pid);
    kabar({ jenis: "info", judul: "Pasien pulang", isi: `${p.id} ${p.nama}: ${ditutup} sesi IoT ditutup. Ringkasan pemakaian alat siap untuk E-Klaim.` });
  };

  const hasil = useMemo(() => cocokkan(sesi.pasien, sesi.device, db.bindings, sesi.tolak), [sesi, db.bindings]);
  const tunggu = hasil.usul.filter((u) => u.jenis !== "otomatis" || !auto).filter((u) => u.device !== proses?.usul.device);

  // auto-matching: whenever the session changes, bind the next sure pair (one at a time, with its animation)
  useEffect(() => {
    if (proses || scan) return;
    if (hasil.sudah.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a device scanned again for the patient it already serves
      setSesi((x) => ({ ...x, device: x.device.filter((d) => !hasil.sudah.includes(d)) }));
      say(`${hasil.sudah.join(", ")} sudah terikat ke pasien ini`);
      return;
    }
    if (!auto) return;
    const u = hasil.usul.find((x) => x.jenis === "otomatis");
    if (u) setProses({ usul: u, langkah: 0, cara: "otomatis" });
  }, [hasil, proses, scan, auto, say]);

  useEffect(() => {
    if (!proses) return;
    const n = proses.usul.alasan.length;
    const t = setTimeout(() => {
      if (proses.langkah <= n) setProses({ ...proses, langkah: proses.langkah + 1 });
      else {
        ikat(proses.usul, proses.cara);
        setProses(null);
      }
    }, proses.langkah === 0 ? 450 : proses.langkah > n ? 700 : 380);
    return () => clearTimeout(t);
  }, [proses, ikat]);

  /** What the next scan reads: the bed-mate of something already in the session first, else the next one still needing it. */
  const berikut = (jenis: JenisScan): string | undefined => {
    const b = db.bindings;
    if (jenis === "pasien") {
      const bebas = PASIEN.filter((p) => !sesi.pasien.includes(p.id) && !pulang[p.id]);
      const dev = sesi.device.map(deviceById);
      return (bebas.find((p) => dev.some((d) => d.unit === p.unit && d.bed === p.bed && p.order.includes(d.alat)))
        ?? bebas.find((p) => p.order.some((a) => !aktifSlot(b, p.id, a))) ?? bebas[0])?.id;
    }
    const bebas = DEVICE.filter((d) => !sesi.device.includes(d.id) && !aktifDevice(b, d.id));
    const pas = sesi.pasien.map(pasienById);
    return (bebas.find((d) => pas.some((p) => p.unit === d.unit && p.bed === d.bed && p.order.includes(d.alat) && !aktifSlot(b, p.id, d.alat)))
      ?? bebas[0] ?? DEVICE.find((d) => !sesi.device.includes(d.id)))?.id;
  };

  const tambah = (jenis: JenisScan, id: string, cara: "scan" | "manual") => {
    const daftar = jenis === "pasien" ? sesi.pasien : sesi.device;
    setTabRaw("binding");
    if (jenis === "pasien" && pulang[id]) { say(`${id} sudah pulang ${jam(pulang[id])}: tidak bisa diikat lagi`); return; }
    if (daftar.includes(id)) { say(`${id} sudah ada di sesi scan`); return; }
    setSesi((x) => (jenis === "pasien" ? { ...x, pasien: [...x.pasien, id] } : { ...x, device: [...x.device, id] }));
    setTerakhir(null);
    say(cara === "scan" ? `QR terbaca: ${id}` : `${id} ditambahkan`);
  };

  const selesaiScan = () => {
    if (!scan) return;
    const id = scan.target ?? berikut(scan.jenis);
    setScan(null);
    if (id) tambah(scan.jenis, id, "scan");
    else say(scan.jenis === "pasien" ? "Semua gelang pasien sudah ada di sesi ini" : "Semua device sudah ada di sesi ini");
  };

  const aktif = db.bindings.filter((b) => !b.selesai);
  const unread = db.notifs.filter((n) => !n.baca).length;
  const dirawat = PASIEN.filter((p) => !pulang[p.id]);
  const kurang = dirawat.reduce((n, p) => n + p.order.filter((a) => !aktifSlot(db.bindings, p.id, a)).length, 0);
  const terpantau = dirawat.filter((p) => aktif.some((b) => b.pasien === p.id)).length;
  const peringatan = daftarPeringatan(db.bindings, pulang);
  const tutupBanner = useCallback(() => setBanner((q) => q.slice(1)), []);

  return (
    <div className="flex h-[100dvh] w-full flex-col bg-[#f4f6f8] text-[#1c2127]">
      <PreloadScan />
      <header className="shrink-0 px-4 pb-3 pt-[max(12px,env(safe-area-inset-top))] text-white" style={{ background: C }}>
        <div className="mx-auto flex max-w-[560px] items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/15">{Ikon.link}</span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[18px] font-semibold leading-tight">Binding IoT Pasien</h1>
            <div className="mt-0.5 truncate text-[12.5px] text-white/85">ICU · HCU · Unit HD</div>
          </div>
          <button onClick={() => setTab("notif")} aria-label="Notifikasi" className="relative rounded-full p-2 hover:bg-white/10">
            {Ikon.bell}
            {unread > 0 && <span className="absolute right-0.5 top-0.5 min-w-[18px] rounded-full bg-[#f97316] px-1 text-center text-[10.5px] font-semibold leading-[18px]">{unread}</span>}
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[560px] px-3 pb-6 pt-3">
          {tab === "binding" && (
            <>
              <div className="grid grid-cols-3 gap-2">
                <Angka nilai={aktif.length} label="Binding aktif" />
                <Angka nilai={`${terpantau}/${dirawat.length}`} label="Pasien terpantau" />
                <Angka nilai={kurang} label="Alat dipesan belum terikat" warna={kurang ? "#b45309" : "#15803d"} />
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2.5">
                <TombolScan judul="Scan QR Pasien" sub="Gelang pasien" ikon={Ikon.user} warna={C} onScan={() => setScan({ jenis: "pasien" })} onManual={() => setManual("pasien")} />
                <TombolScan judul="Scan QR Device" sub="Sensor IoT di alat" ikon={Ikon.chip} warna="#0b4f4a" onScan={() => setScan({ jenis: "device" })} onManual={() => setManual("device")} />
              </div>

              <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-[#e3e7ec] bg-white px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold">Binding otomatis</p>
                  <p className="text-[12px] leading-snug text-[#5f6b7c]">Keyakinan ≥ {AMBANG_OTOMATIS}% langsung diikat. 50–79% dan serah terima menunggu konfirmasi.</p>
                </div>
                <Saklar on={auto} onChange={setAuto} label="Binding otomatis" />
              </div>

              {proses && <Mencocokkan p={proses} />}
              {!proses && terakhir && <Sukses b={terakhir} onDetail={() => setDetail({ jenis: "device", id: terakhir.device })} />}

              {tunggu.length > 0 && (
                <Bagian judul={`Perlu konfirmasi · ${tunggu.length}`}>
                  <div className="space-y-2.5">
                    {tunggu.map((u) => (
                      <KartuUsul key={u.device} u={u} sibuk={!!proses}
                        onIkat={() => setProses({ usul: u, langkah: 0, cara: "konfirmasi" })}
                        onTolak={() => setSesi((x) => ({ ...x, tolak: [...x.tolak, kunciPasangan(u.device, u.pasien)] }))} />
                    ))}
                  </div>
                </Bagian>
              )}

              <Bagian judul="Sesi scan" kanan={(sesi.pasien.length > 0 || sesi.device.length > 0) && (
                <button onClick={() => { setSesi(SESI_KOSONG); setTerakhir(null); }} className="text-[13px] font-medium" style={{ color: C }}>Selesaikan sesi</button>
              )}>
                {sesi.pasien.length === 0 && sesi.device.length === 0 ? <CaraKerja /> : (
                  <div className="space-y-2">
                    {sesi.pasien.map((id) => (
                      <BarisPasien key={id} id={id} bindings={db.bindings} onBuka={() => setDetail({ jenis: "pasien", id })}
                        onHapus={() => setSesi((x) => ({ ...x, pasien: x.pasien.filter((p) => p !== id) }))} />
                    ))}
                    {hasil.tanpa.map((t) => (
                      <BarisDevice key={t.device} id={t.device} alasan={t.alasan} onBuka={() => setDetail({ jenis: "device", id: t.device })}
                        onHapus={() => setSesi((x) => ({ ...x, device: x.device.filter((d) => d !== t.device) }))} />
                    ))}
                    {sesi.pasien.length === 0 && <p className="px-1 text-[12.5px] text-[#5f6b7c]">Scan gelang pasien agar device di atas bisa dicocokkan.</p>}
                  </div>
                )}
              </Bagian>

              {aktif.length > 0 && (
                <Bagian judul="Binding terbaru" kanan={<button onClick={() => setTab("device")} className="text-[13px] font-medium" style={{ color: C }}>Semua device ›</button>}>
                  <div className="space-y-2">
                    {aktif.slice(0, 4).map((b) => <BarisBinding key={b.sesi} b={b} now={now} onBuka={() => setDetail({ jenis: "device", id: b.device })} />)}
                  </div>
                </Bagian>
              )}
              <ResetDemo onReset={() => { setDb({ bindings: [], notifs: [], seq: 0, pulang: {} }); setSesi(SESI_KOSONG); setTerakhir(null); setBanner([]); say("Data dikosongkan"); }} />
            </>
          )}

          {tab === "pasien" && (
            <div className="space-y-2">
              <p className="px-1 pb-1 text-[12.5px] text-[#5f6b7c]">Setiap alat yang dipesan dokter harus terikat ke device IoT, agar jam pemakaiannya tercatat dan klaim bisa dibuktikan.</p>
              {PASIEN.map((p) => {
                const isi = p.order.filter((a) => aktifSlot(db.bindings, p.id, a)).length;
                const pl = pulang[p.id];
                return (
                  <Kartu key={p.id} onClick={() => (pl ? setRingkas(p.id) : setDetail({ jenis: "pasien", id: p.id }))}>
                    <div className={`flex items-start gap-3 ${pl ? "opacity-70" : ""}`}>
                      <Inisial nama={p.nama} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2"><p className="truncate text-[15px] font-semibold">{p.nama}</p>{pl ? <Badge tone="blue">Pulang {jam(pl)}</Badge> : <Badge tone={isi === p.order.length ? "green" : isi ? "amber" : "gray"}>{isi}/{p.order.length} alat</Badge>}</div>
                        <p className="text-[12.5px] text-[#5f6b7c]"><span className="font-mono">{p.id}</span> · {lokasi(p)}</p>
                        {pl ? <p className="mt-1.5 text-[12.5px] font-medium" style={{ color: C }}>Lihat ringkasan pemakaian alat ›</p>
                          : <div className="mt-2 flex flex-wrap gap-1.5">{p.order.map((a) => <SlotChip key={a} alat={a} b={aktifSlot(db.bindings, p.id, a)} />)}</div>}
                      </div>
                    </div>
                  </Kartu>
                );
              })}
            </div>
          )}

          {tab === "device" && <TabDevice bindings={db.bindings} now={now} onBuka={(id) => setDetail({ jenis: "device", id })} />}

          {tab === "peringatan" && (
            <TabPeringatan list={peringatan} onAksi={(w) => {
              if (w.aksi === "scan-device" && w.device) setScan({ jenis: "device", target: w.device });
              else if (w.aksi === "buka-device" && w.device) setDetail({ jenis: "device", id: w.device });
              else if (w.pasien) setDetail({ jenis: "pasien", id: w.pasien });
            }} />
          )}

          {tab === "notif" && (
            <div className="space-y-2">
              {db.notifs.length === 0 ? (
                <p className="rounded-xl border border-dashed border-[#cfd6de] px-4 py-10 text-center text-[13.5px] text-[#5f6b7c]">Belum ada notifikasi. Notifikasi muncul saat binding IoT sukses, dilepas, atau ada serah terima device.</p>
              ) : db.notifs.map((n) => (
                <Kartu key={n.id} onClick={n.device ? () => setDetail({ jenis: "device", id: n.device! }) : undefined}>
                  <div className="flex items-start gap-3">
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white ${n.jenis === "sukses" ? "bg-[#15803d]" : n.jenis === "warn" ? "bg-[#b45309]" : "bg-[#0f766e]"}`}>{n.jenis === "sukses" ? Ikon.ok : Ikon.link}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2"><p className="flex-1 text-[14.5px] font-semibold">{n.judul}</p><span className="shrink-0 text-[11.5px] text-[#8a95a3]">{tglJam(n.waktu)}</span></div>
                      <p className="text-[13px] leading-snug text-[#4a5563]"><Teks>{n.isi}</Teks></p>
                    </div>
                  </div>
                </Kartu>
              ))}
            </div>
          )}
        </div>
      </main>

      <nav className="shrink-0 border-t border-[#dfe3e8] bg-white pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-[560px]">
          {([
            { key: "binding", label: "Binding", icon: Ikon.qr, badge: tunggu.length },
            { key: "pasien", label: "Pasien", icon: Ikon.user, badge: 0 },
            { key: "device", label: "Device", icon: Ikon.chip, badge: 0 },
            { key: "peringatan", label: "Peringatan", icon: Ikon.alarm, badge: peringatan.length },
            { key: "notif", label: "Notifikasi", icon: Ikon.bell, badge: unread },
          ] as const).map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} className="relative flex min-h-[58px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium" style={{ color: tab === t.key ? C : "#738091" }}>
              <span className="h-6 w-6">{t.icon}</span>{t.label}
              {t.badge > 0 && <span className="absolute right-[calc(50%-22px)] top-1.5 min-w-[18px] rounded-full bg-[#d33d17] px-1 text-[10px] leading-[18px] text-white">{t.badge}</span>}
            </button>
          ))}
        </div>
      </nav>

      {scan && <ScanKamera jenis={scan.jenis} onSelesai={selesaiScan} onBatal={() => setScan(null)} onManual={() => { const j = scan.jenis; setScan(null); setManual(j); }} />}
      {manual && <PilihManual jenis={manual} sesi={sesi} bindings={db.bindings} pulang={pulang} onPilih={(id) => { tambah(manual, id, "manual"); setManual(null); }} onTutup={() => setManual(null)} />}
      {detail && (
        <Detail d={detail} bindings={db.bindings} now={now} onTutup={() => setDetail(null)} onLepas={lepas} onPulang={pulangkan}
          onScan={(j, id) => { setDetail(null); setScan({ jenis: j, target: id }); }} />
      )}
      {ringkas && pulang[ringkas] && <RingkasanPulang pid={ringkas} pada={pulang[ringkas]} bindings={db.bindings} onTutup={() => setRingkas(null)} />}
      {banner[0] && <Banner n={banner[0]} onTutup={tutupBanner} onTap={() => { tutupBanner(); if (banner[0].device) setDetail({ jenis: "device", id: banner[0].device }); }} />}
      {toast}
    </div>
  );
}

/* ---------- pieces ---------- */

function Kartu({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  const cls = "block w-full rounded-xl border border-[#e3e7ec] bg-white p-3.5 text-left shadow-[0_1px_2px_rgba(16,22,26,.05)]";
  return onClick ? <button onClick={onClick} className={`${cls} active:bg-[#f0f3f6]`}>{children}</button> : <div className={cls}>{children}</div>;
}

function Angka({ nilai, label, warna = "#1c2127" }: { nilai: ReactNode; label: string; warna?: string }) {
  return (
    <div className="rounded-xl border border-[#e3e7ec] bg-white px-2.5 py-2">
      <p className="text-[20px] font-semibold tabular-nums leading-tight" style={{ color: warna }}>{nilai}</p>
      <p className="text-[11px] leading-tight text-[#5f6b7c]">{label}</p>
    </div>
  );
}

function TombolScan({ judul, sub, ikon, warna, onScan, onManual }: { judul: string; sub: string; ikon: ReactNode; warna: string; onScan: () => void; onManual: () => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <button onClick={onScan} className="flex min-h-[112px] flex-col items-start justify-between rounded-2xl p-3.5 text-left text-white shadow-[0_4px_14px_rgba(15,118,110,.25)] active:scale-[.98]" style={{ background: warna }}>
        <span className="flex w-full items-center justify-between"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15">{Ikon.qr}</span><span className="opacity-80">{ikon}</span></span>
        <span><span className="block text-[15px] font-semibold leading-tight">{judul}</span><span className="block text-[12px] text-white/80">{sub}</span></span>
      </button>
      <button onClick={onManual} className="flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12.5px] font-medium text-[#4a5563] active:bg-[#e8ecf0]">{Ikon.key} Input manual</button>
    </div>
  );
}

function Mencocokkan({ p }: { p: { usul: Usul; langkah: number } }) {
  const { usul: u, langkah } = p;
  const d = deviceById(u.device);
  const ps = pasienById(u.pasien);
  const n = u.alasan.length;
  const skor = u.alasan.slice(0, Math.min(langkah, n)).reduce((s, a) => s + (a.poin ?? 0), 0);
  const jadi = langkah > n;
  return (
    <div className="mt-3 rounded-2xl border-2 bg-white p-3.5" style={{ borderColor: jadi ? "#15803d" : C }}>
      <p className="text-[11.5px] font-semibold uppercase tracking-wide" style={{ color: jadi ? "#15803d" : C }}>{jadi ? "Cocok · membuat binding" : "Mencocokkan Device ID ↔ Patient ID"}</p>
      <div className="mt-2 flex items-center gap-2">
        <Tanda jenis="device" id={d.id} sub={namaDevice(d)} gelap />
        <span className={`shrink-0 ${jadi ? "text-[#15803d]" : "animate-pulse text-[#0f766e]"}`}>{Ikon.link}</span>
        <Tanda jenis="pasien" id={ps.id} sub={ps.nama} />
      </div>
      <div className="mt-3"><DaftarAlasan alasan={u.alasan} sampai={langkah} /></div>
      <div className="mt-3"><Skor nilai={skor} /></div>
    </div>
  );
}

function Sukses({ b, onDetail }: { b: Binding; onDetail: () => void }) {
  const d = deviceById(b.device);
  const p = pasienById(b.pasien);
  return (
    <div className="mt-3 rounded-2xl bg-[#e7f6ec] p-3.5 ring-1 ring-[#b7e2c5]">
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#15803d] text-white [&_svg]:h-5 [&_svg]:w-5">{Ikon.ok}</span>
        <div className="min-w-0 flex-1"><p className="text-[15px] font-semibold text-[#14532d]">Binding IoT sukses</p><p className="text-[12.5px] text-[#2f6b45]">Sesi {b.sesi} · mulai {jam(b.mulai)} · keyakinan {b.skor}%</p></div>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <Tanda jenis="device" id={d.id} sub={namaDevice(d)} gelap />
        <span className="shrink-0 text-[#15803d]">{Ikon.link}</span>
        <Tanda jenis="pasien" id={p.id} sub={`${p.nama} · ${p.bed}`} />
      </div>
      <button onClick={onDetail} className="mt-2.5 text-[13px] font-semibold text-[#15803d]">Lihat data sesi ›</button>
    </div>
  );
}

function KartuUsul({ u, sibuk, onIkat, onTolak }: { u: Usul; sibuk: boolean; onIkat: () => void; onTolak: () => void }) {
  const d = deviceById(u.device);
  const p = pasienById(u.pasien);
  return (
    <div className="rounded-2xl border border-[#f1d9a8] bg-white p-3.5">
      <div className="flex items-center gap-2">
        <Badge tone={u.jenis === "pindah" ? "red" : u.jenis === "otomatis" ? "green" : "amber"}>{u.jenis === "pindah" ? "Serah terima" : u.jenis === "otomatis" ? "Siap diikat" : "Perlu konfirmasi"}</Badge>
        {u.dari && <span className="truncate text-[12px] text-[#8a5a00]">masih terikat ke {u.dari}</span>}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Tanda jenis="device" id={d.id} sub={namaDevice(d)} gelap />
        <span className="shrink-0 text-[#b45309]">{Ikon.link}</span>
        <Tanda jenis="pasien" id={p.id} sub={`${p.nama} · ${p.bed}`} />
      </div>
      <div className="mt-2.5"><Skor nilai={u.skor} /></div>
      <div className="mt-2.5"><DaftarAlasan alasan={u.alasan} /></div>
      {u.catatan && <p className="mt-2 text-[12.5px] text-[#8a5a00]">{u.catatan}</p>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button onClick={onTolak} disabled={sibuk} className="min-h-[44px] rounded-xl border border-[#cfd6de] text-[14px] font-semibold text-[#4a5563] disabled:opacity-50">Bukan pasangannya</button>
        <button onClick={onIkat} disabled={sibuk} className="min-h-[44px] rounded-xl text-[14px] font-semibold text-white disabled:opacity-50" style={{ background: C }}>{u.jenis === "pindah" ? "Pindahkan" : "Ikat"}</button>
      </div>
    </div>
  );
}

function Inisial({ nama }: { nama: string }) {
  const s = nama.split(" ").map((x) => x[0]).slice(0, 2).join("");
  return <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#e3f1ef] text-[13.5px] font-semibold text-[#0b4f4a]">{s}</span>;
}

function SlotChip({ alat, b }: { alat: Alat; b?: Binding }) {
  return b ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#e1f4e8] px-2 py-0.5 text-[11.5px] font-medium text-[#1c6e42]"><span className="[&_svg]:h-3.5 [&_svg]:w-3.5">{Ikon.ok}</span>{ALAT[alat].singkat} · <span className="font-mono">{b.device}</span></span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#fdf1d8] px-2 py-0.5 text-[11.5px] font-medium text-[#8a5a00]">{ALAT[alat].singkat} · belum terikat</span>
  );
}

function BarisPasien({ id, bindings, onBuka, onHapus }: { id: string; bindings: Binding[]; onBuka: () => void; onHapus: () => void }) {
  const p = pasienById(id);
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[#e3e7ec] bg-white p-3">
      <button onClick={onBuka} className="flex min-w-0 flex-1 items-start gap-3 text-left">
        <Inisial nama={p.nama} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[#0f766e]"><span className="[&_svg]:h-3.5 [&_svg]:w-3.5">{Ikon.ok}</span> Gelang terbaca</span>
          <span className="block truncate text-[14.5px] font-semibold"><span className="font-mono">{p.id}</span> · {p.nama}</span>
          <span className="block text-[12.5px] text-[#5f6b7c]">{lokasi(p)}</span>
          <span className="mt-1.5 flex flex-wrap gap-1.5">{p.order.map((a) => <SlotChip key={a} alat={a} b={aktifSlot(bindings, p.id, a)} />)}</span>
        </span>
      </button>
      <button onClick={onHapus} aria-label={`Keluarkan ${p.id} dari sesi`} className="rounded-full p-1.5 text-[#8a95a3] active:bg-[#eef1f4]">{Ikon.x}</button>
    </div>
  );
}

function BarisDevice({ id, alasan, onBuka, onHapus }: { id: string; alasan: string; onBuka: () => void; onHapus: () => void }) {
  const d = deviceById(id);
  return (
    <div className="flex items-start gap-3 rounded-xl border border-dashed border-[#e0b96a] bg-[#fffaf0] p-3">
      <button onClick={onBuka} className="flex min-w-0 flex-1 items-start gap-3 text-left">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#0b4f4a] text-white [&_svg]:h-5 [&_svg]:w-5">{Ikon.chip}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-[#8a5a00]">Device menunggu pasangan</span>
          <span className="block truncate text-[14.5px] font-semibold"><span className="font-mono">{d.id}</span> · {namaDevice(d)}</span>
          <span className="block text-[12.5px] text-[#5f6b7c]">{lokasi(d)}</span>
          <span className="mt-1 flex items-start gap-1.5 text-[12.5px] text-[#8a5a00]"><span className="mt-px shrink-0">{Ikon.warn}</span>{alasan}</span>
        </span>
      </button>
      <button onClick={onHapus} aria-label={`Keluarkan ${d.id} dari sesi`} className="rounded-full p-1.5 text-[#8a95a3] active:bg-[#f3ead6]">{Ikon.x}</button>
    </div>
  );
}

function BarisBinding({ b, now, onBuka }: { b: Binding; now: number; onBuka: () => void }) {
  const d = deviceById(b.device);
  const p = pasienById(b.pasien);
  return (
    <Kartu onClick={onBuka}>
      <div className="flex items-center gap-2 text-[13.5px]">
        <span className="font-mono font-semibold">{d.id}</span><span className="text-[#15803d]">{Ikon.link}</span><span className="font-mono font-semibold">{p.id}</span>
        <span className="ml-auto text-[12px] text-[#8a95a3]">{now ? lama(now - Date.parse(b.mulai)) : ""}</span>
      </div>
      <p className="mt-0.5 truncate text-[12.5px] text-[#5f6b7c]">{namaDevice(d)} → {p.nama} · {lokasi(p)}</p>
    </Kartu>
  );
}

function CaraKerja() {
  const langkah = [
    ["Scan gelang pasien", "Satu atau beberapa pasien sekaligus, urutan bebas."],
    ["Scan QR device IoT", "Sensor clamp di kabel daya alat: ventilator, mesin HD, syringe/infusion pump."],
    ["Dicocokkan otomatis", "Device ID dipasangkan ke Patient ID menurut order dokter, lokasi bed, status device, dan aturan satu device satu pasien."],
    ["Notifikasi binding sukses", "Sesi IoT terbuka: jam nyala dan mode alat mulai direkam untuk klaim."],
  ];
  return (
    <div className="rounded-xl border border-dashed border-[#cfd6de] bg-white p-3.5">
      <ol className="space-y-2.5">
        {langkah.map(([j, s], i) => (
          <li key={j} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-white" style={{ background: C }}>{i + 1}</span>
            <span><span className="block text-[14px] font-semibold">{j}</span><span className="block text-[12.5px] leading-snug text-[#5f6b7c]">{s}</span></span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TabDevice({ bindings, now, onBuka }: { bindings: Binding[]; now: number; onBuka: (id: string) => void }) {
  const [f, setF] = useState<"semua" | "terikat" | "bebas" | "offline">("semua");
  const list = DEVICE.filter((d) => {
    const b = aktifDevice(bindings, d.id);
    return f === "semua" || (f === "terikat" ? !!b : f === "bebas" ? !b : !d.online);
  });
  return (
    <>
      <div className="mb-2.5 flex gap-1.5 overflow-x-auto">
        {(["semua", "terikat", "bebas", "offline"] as const).map((k) => (
          <button key={k} onClick={() => setF(k)} className={`shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium capitalize ${f === k ? "text-white" : "bg-white text-[#5f6b7c] ring-1 ring-[#dfe3e8]"}`} style={f === k ? { background: C } : undefined}>{k}</button>
        ))}
      </div>
      <div className="space-y-2">
        {list.map((d) => {
          const b = aktifDevice(bindings, d.id);
          const p = b ? pasienById(b.pasien) : null;
          return (
            <Kartu key={d.id} onClick={() => onBuka(d.id)}>
              <div className="flex items-start gap-3">
                <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#0b4f4a] text-white [&_svg]:h-5 [&_svg]:w-5">
                  {Ikon.chip}<span className={`absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full ring-2 ring-white ${d.online ? "bg-[#22c55e]" : "bg-[#94a3b8]"}`} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><p className="font-mono text-[14.5px] font-semibold">{d.id}</p><Badge tone={b ? "green" : "gray"}>{b ? "Terikat" : "Bebas"}</Badge></div>
                  <p className="text-[12.5px] text-[#5f6b7c]">{namaDevice(d)} · {lokasi(d)}</p>
                  {p && b ? (
                    <p className="mt-1 text-[12.5px] text-[#1c6e42]">→ <span className="font-mono">{p.id}</span> {p.nama} · {now ? lama(now - Date.parse(b.mulai)) : ""}</p>
                  ) : (
                    <p className="mt-1 text-[12.5px] text-[#8a95a3]">{d.online ? `Online · mode ${d.mode}` : "Offline · menunggu gateway"}</p>
                  )}
                </div>
              </div>
            </Kartu>
          );
        })}
      </div>
    </>
  );
}

function PilihManual({ jenis, sesi, bindings, pulang, onPilih, onTutup }: { jenis: JenisScan; sesi: Sesi; bindings: Binding[]; pulang: Record<string, string>; onPilih: (id: string) => void; onTutup: () => void }) {
  const [q, setQ] = useState("");
  const cari = q.trim().toLowerCase();
  const rows = jenis === "pasien"
    ? PASIEN.filter((p) => !cari || `${p.id} ${p.nama} ${p.bed}`.toLowerCase().includes(cari)).map((p) => ({ id: p.id, judul: p.nama, sub: lokasi(p), diSesi: sesi.pasien.includes(p.id) || !!pulang[p.id], status: pulang[p.id] ? "pulang" : `${p.order.filter((a) => aktifSlot(bindings, p.id, a)).length}/${p.order.length} alat` }))
    : DEVICE.filter((d) => !cari || `${d.id} ${namaDevice(d)} ${d.bed ?? ""}`.toLowerCase().includes(cari)).map((d) => ({ id: d.id, judul: namaDevice(d), sub: lokasi(d), diSesi: sesi.device.includes(d.id), status: aktifDevice(bindings, d.id) ? `terikat ${aktifDevice(bindings, d.id)!.pasien}` : "bebas" }));
  return (
    <Sheet open onClose={onTutup} title={jenis === "pasien" ? "Input manual · Patient ID" : "Input manual · Device ID"}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={jenis === "pasien" ? "Cari ID pasien, nama, atau bed" : "Cari device ID, alat, atau bed"}
        className="w-full rounded-xl border border-[#cfd6de] bg-white px-3 py-2.5 text-[15px] outline-none focus:border-[#0f766e]" />
      <div className="mt-2.5 space-y-1.5">
        {rows.map((r) => (
          <button key={r.id} disabled={r.diSesi} onClick={() => onPilih(r.id)} className="flex w-full items-center gap-3 rounded-xl border border-[#e3e7ec] px-3 py-2.5 text-left active:bg-[#f0f3f6] disabled:opacity-50">
            <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-semibold"><span className="font-mono">{r.id}</span> · {r.judul}</span><span className="block text-[12.5px] text-[#5f6b7c]">{r.sub}</span></span>
            <span className="shrink-0 text-[12px] text-[#738091]">{r.status === "pulang" ? "pulang" : r.diSesi ? "di sesi" : r.status}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function Baris({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return <div className="flex gap-3 border-b border-[#eef1f4] py-2 text-[13.5px] last:border-0"><span className="w-[120px] shrink-0 text-[#5f6b7c]">{k}</span><span className={`min-w-0 flex-1 break-words ${mono ? "font-mono text-[12.5px]" : ""}`}>{v}</span></div>;
}

function Detail({ d, bindings, now, onTutup, onLepas, onPulang, onScan }: {
  d: { jenis: JenisScan; id: string }; bindings: Binding[]; now: number; onTutup: () => void; onLepas: (b: Binding) => void;
  onPulang: (pid: string) => void; onScan: (j: JenisScan, id: string) => void;
}) {
  if (d.jenis === "pasien") {
    const p = pasienById(d.id);
    return (
      <Sheet open onClose={onTutup} title={p.nama}>
        <div className="rounded-xl bg-[#f6f8fa] px-3">
          <Baris k="Patient ID / No. RM" v={p.id} mono />
          <Baris k="Jenis kelamin, umur" v={`${p.jk === "L" ? "Laki-laki" : "Perempuan"}, ${p.umur} th`} />
          <Baris k="No. kartu JKN" v={p.kartu} mono />
          <Baris k="No. SEP" v={p.sep} mono />
          <Baris k="Ruang" v={lokasi(p)} />
          <Baris k="Diagnosis" v={p.dx} />
          <Baris k="DPJP" v={p.dpjp} />
        </div>
        <h3 className="mb-1.5 mt-4 text-[13px] font-semibold uppercase tracking-wide text-[#5f6b7c]">Alat dipesan dokter</h3>
        <div className="space-y-2">
          {p.order.map((a) => {
            const b = aktifSlot(bindings, p.id, a);
            return (
              <div key={a} className={`rounded-xl p-3 ${b ? "bg-[#e7f6ec]" : "bg-[#fdf1d8]"}`}>
                <div className="flex items-center gap-2">
                  <p className="flex-1 text-[14px] font-semibold">{ALAT[a].nama}</p>
                  {b && <button onClick={() => onLepas(b)} className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-medium text-[#b42318] active:bg-white/60">{Ikon.unlink} Lepas</button>}
                </div>
                {b ? (
                  <p className="text-[12.5px] text-[#1c6e42]"><span className="font-mono">{b.device}</span> · {namaDevice(deviceById(b.device))} · sesi {b.sesi} · {now ? lama(now - Date.parse(b.mulai)) : ""}</p>
                ) : (
                  <p className="text-[12.5px] text-[#8a5a00]">Belum terikat ke device IoT: pemakaian alat ini tidak tercatat, jam pemakaian di klaim tidak bisa dibuktikan.</p>
                )}
              </div>
            );
          })}
        </div>
        <button onClick={() => onScan("pasien", p.id)} className="mt-4 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl text-[15px] font-semibold text-white" style={{ background: C }}>{Ikon.qr} Scan QR gelang pasien ini</button>
        <TombolPulang sesi={bindings.filter((b) => !b.selesai && b.pasien === p.id).length} onPulang={() => onPulang(p.id)} />
      </Sheet>
    );
  }
  const dv = deviceById(d.id);
  const b = aktifDevice(bindings, dv.id);
  const p = b ? pasienById(b.pasien) : null;
  const riwayat = bindings.filter((x) => x.device === dv.id && x.selesai);
  return (
    <Sheet open onClose={onTutup} title={`${dv.id} · ${namaDevice(dv)}`}>
      <div className="rounded-xl bg-[#f6f8fa] px-3">
        <Baris k="Device ID" v={dv.id} mono />
        <Baris k="Sensor" v="Clamp arus non-invasif di kabel daya alat (jam nyala dan mode, bukan tanda vital)" />
        <Baris k="Alat" v={namaDevice(dv)} />
        <Baris k="Lokasi tercatat" v={lokasi(dv)} />
        <Baris k="Koneksi" v={dv.online ? <span className="text-[#15803d]">Online · kunci perangkat aktif</span> : <span className="text-[#b45309]">Offline · data dikirim saat gateway tersambung</span>} />
        <Baris k="Bacaan terakhir" v={dv.online ? `Mode ${dv.mode} · ${dv.arus.toLocaleString("id-ID")} A` : "-"} />
      </div>
      {b && p ? (
        <>
          <div className="mt-4 rounded-xl bg-[#e7f6ec] p-3">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-[#1c6e42]">Terikat ke pasien</p>
            <p className="text-[15px] font-semibold"><span className="font-mono">{p.id}</span> · {p.nama}</p>
            <p className="text-[12.5px] text-[#2f6b45]">{lokasi(p)} · sejak {tglJam(b.mulai)} ({now ? lama(now - Date.parse(b.mulai)) : ""}) · {b.cara === "otomatis" ? "dicocokkan otomatis" : "dikonfirmasi petugas"}, keyakinan {b.skor}%</p>
          </div>
          <h3 className="mb-1.5 mt-4 text-[13px] font-semibold uppercase tracking-wide text-[#5f6b7c]">Data sesi IoT untuk klaim</h3>
          <div className="rounded-xl bg-[#0f1b1a] px-3 py-2.5 font-mono text-[12px] leading-relaxed text-[#cde9e5]">
            {[["sesi_id", b.sesi], ["device_id", dv.id], ["jenis", dv.alat], ["peserta", p.id], ["kunjungan", b.sep], ["mulai", isoLokal(b.mulai)], ["mode", dv.mode]].map(([k, v]) => (
              <div key={k} className="flex gap-2"><span className="w-[84px] shrink-0 text-[#7fb8b0]">{k}</span><span className="min-w-0 break-all">{v}</span></div>
            ))}
          </div>
          <button onClick={() => onLepas(b)} className="mt-3 flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl border-[1.5px] border-[#b42318] text-[14.5px] font-semibold text-[#b42318]">{Ikon.unlink} Lepas binding</button>
        </>
      ) : (
        <p className="mt-4 rounded-xl bg-[#f6f8fa] p-3 text-[13px] text-[#5f6b7c]">Device bebas. Scan QR-nya bersama gelang pasien agar dicocokkan.</p>
      )}
      {riwayat.length > 0 && (
        <>
          <h3 className="mb-1.5 mt-4 text-[13px] font-semibold uppercase tracking-wide text-[#5f6b7c]">Riwayat binding</h3>
          <div className="space-y-1.5">
            {riwayat.map((x) => <p key={x.sesi} className="text-[12.5px] text-[#4a5563]"><span className="font-mono">{x.sesi}</span> · {x.pasien} · {tglJam(x.mulai)} – {jam(x.selesai!)}</p>)}
          </div>
        </>
      )}
      <button onClick={() => onScan("device", dv.id)} className="mt-4 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl text-[15px] font-semibold text-white" style={{ background: "#0b4f4a" }}>{Ikon.qr} Scan QR device ini</button>
    </Sheet>
  );
}

/** What to fix now so device use is recorded right: running devices with no patient, bound devices on standby or
    offline, orders with no device. Each card says why in plain words and offers the next step. */
function TabPeringatan({ list, onAksi }: { list: Peringatan[]; onAksi: (w: Peringatan) => void }) {
  const tinggi = list.filter((w) => w.tingkat === "tinggi").length;
  return (
    <div className="space-y-2">
      <p className="px-1 pb-1 text-[12.5px] leading-snug text-[#5f6b7c]">
        Hal yang perlu ditindak sekarang supaya pemakaian alat tercatat benar, sebelum menjadi temuan saat klaim diaudit.
        {list.length > 0 && <> <b className="text-[#b42318]">{tinggi} penting</b> · {list.length - tinggi} perlu dicek.</>}
      </p>
      {list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[#b7e2c5] bg-[#f3fbf6] px-4 py-10 text-center text-[13.5px] text-[#1c6e42]">Tidak ada peringatan. Semua alat yang menyala sudah terikat ke pasien, dan semua order alat sudah punya device.</p>
      ) : list.map((w) => (
        <div key={w.id} className="flex overflow-hidden rounded-xl border border-[#e3e7ec] bg-white">
          <span className={`w-1.5 shrink-0 ${w.tingkat === "tinggi" ? "bg-[#d33d17]" : "bg-[#e0a43a]"}`} />
          <div className="min-w-0 flex-1 p-3">
            <div className="flex items-start gap-2">
              <span className={`mt-0.5 shrink-0 ${w.tingkat === "tinggi" ? "text-[#b42318]" : "text-[#b45309]"}`}>{Ikon.warn}</span>
              <p className="min-w-0 flex-1 text-[14px] font-semibold leading-snug"><Teks>{w.judul}</Teks></p>
            </div>
            <p className="mt-1 text-[12.5px] leading-snug text-[#4a5563]"><Teks>{w.isi}</Teks></p>
            <button onClick={() => onAksi(w)} className="mt-2 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-white" style={{ background: w.aksi === "scan-device" ? "#0b4f4a" : C }}>
              {w.aksi === "scan-device" ? <><span className="[&_svg]:h-4 [&_svg]:w-4">{Ikon.qr}</span> Scan QR device</> : w.aksi === "buka-device" ? "Buka device" : "Buka pasien"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Discharge asks twice: it closes every IoT session of the patient. */
function TombolPulang({ sesi, onPulang }: { sesi: number; onPulang: () => void }) {
  const [yakin, setYakin] = useState(false);
  useEffect(() => {
    if (!yakin) return;
    const t = setTimeout(() => setYakin(false), 4000);
    return () => clearTimeout(t);
  }, [yakin]);
  return (
    <button onClick={() => (yakin ? onPulang() : setYakin(true))}
      className={`mt-2.5 min-h-[46px] w-full rounded-xl border-[1.5px] text-[14.5px] font-semibold ${yakin ? "border-[#1f4fa8] bg-[#1f4fa8] text-white" : "border-[#1f4fa8] text-[#1f4fa8]"}`}>
      {yakin ? `Ketuk lagi: pulangkan & tutup ${sesi} sesi IoT` : "Pulangkan pasien"}
    </button>
  );
}

/** Device-use summary at discharge: each IoT session, and the E-Klaim duration fields read from the devices. */
function RingkasanPulang({ pid, pada, bindings, onTutup }: { pid: string; pada: string; bindings: Binding[]; onTutup: () => void }) {
  const p = pasienById(pid);
  const r = ringkasanPulang(pid, bindings, pada);
  const angka = (n: number) => n.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <Sheet open onClose={onTutup} title={`Ringkasan pemakaian alat · ${p.nama}`}>
      <p className="text-[13px] text-[#4a5563]"><span className="font-mono">{p.id}</span> · {lokasi(p)} · pulang {tglJam(pada)}<br />SEP <span className="font-mono">{p.sep}</span></p>
      <h3 className="mb-1.5 mt-4 text-[13px] font-semibold uppercase tracking-wide text-[#5f6b7c]">Sesi IoT selama rawat</h3>
      {r.baris.length === 0 ? (
        <p className="rounded-xl bg-[#fdf1d8] p-3 text-[13px] text-[#8a5a00]">Tidak ada alat IoT yang terikat selama rawat: jam pemakaian alat di klaim tidak punya bukti dari alat.</p>
      ) : (
        <div className="space-y-1.5">
          {r.baris.map((x) => (
            <div key={x.sesi} className="rounded-xl border border-[#e3e7ec] px-3 py-2">
              <div className="flex items-center gap-2"><span className="font-mono text-[13.5px] font-semibold">{x.device}</span><span className="text-[12.5px] text-[#5f6b7c]">{namaDevice(deviceById(x.device))}</span>
                <span className="ml-auto text-[13px] font-semibold tabular-nums">{durasi(x.jam)}</span></div>
              <div className="flex items-center gap-2 text-[12px] text-[#738091]"><span className="font-mono">{x.sesi}</span> · {jam(x.mulai)}–{jam(x.selesai)}
                <span className={`ml-auto rounded-full px-1.5 text-[11px] font-medium ${x.mode === "jalan" ? "bg-[#e1f4e8] text-[#1c6e42]" : "bg-[#fdf1d8] text-[#8a5a00]"}`}>{x.mode}</span></div>
            </div>
          ))}
        </div>
      )}
      <h3 className="mb-1.5 mt-4 text-[13px] font-semibold uppercase tracking-wide text-[#5f6b7c]">Isian E-Klaim dari data alat</h3>
      <div className="rounded-xl bg-[#0f1b1a] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-[#cde9e5]">
        {[["jam_ventilator", angka(r.eklaim.jam_ventilator)], ["jam_niv", angka(r.eklaim.jam_niv)], ["sesi_hemodialisis", String(r.eklaim.sesi_hemodialisis)]].map(([k, v]) => (
          <div key={k} className="flex gap-2"><span className="w-[140px] shrink-0 text-[#7fb8b0]">{k}</span><span>{v}</span></div>
        ))}
      </div>
      <p className="mt-2 text-[12.5px] leading-snug text-[#5f6b7c]">
        Angka diambil dari sensor alat, tidak diketik ulang. Hanya jam saat alat <b>jalan</b> yang dihitung{r.jamSiaga > 0 ? `; ${durasi(r.jamSiaga)} siaga tidak ikut` : ""}.
        Ventilasi mekanik ≥ 96 jam berturut-turut dikode 96.72.
      </p>
      <button onClick={onTutup} className="mt-4 min-h-[46px] w-full rounded-xl text-[14.5px] font-semibold text-white" style={{ background: C }}>Selesai</button>
    </Sheet>
  );
}

function ResetDemo({ onReset }: { onReset: () => void }) {
  const [yakin, setYakin] = useState(false);
  useEffect(() => {
    if (!yakin) return;
    const t = setTimeout(() => setYakin(false), 3000);
    return () => clearTimeout(t);
  }, [yakin]);
  return (
    <div className="mt-6 text-center">
      <button onClick={() => { if (yakin) { onReset(); setYakin(false); } else setYakin(true); }} className={`text-[12.5px] font-medium ${yakin ? "text-[#b42318]" : "text-[#8a95a3]"}`}>
        {yakin ? "Ketuk lagi untuk mengosongkan semua binding" : "Reset data"}
      </button>
    </div>
  );
}
