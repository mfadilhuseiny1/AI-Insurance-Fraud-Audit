import { ALAT, PASIEN, deviceById, lokasi, pasienById, type Alat } from "./data";

/* Matching engine of the binding app: every device QR scanned in the session is paired with one of the patient wristbands
   scanned in the same session. White-box: each pair carries its points and the reason behind each point.

   Hard rules (a pair that breaks one is never proposed):
   - the patient has a doctor's order for that kind of device;
   - one device per kind per patient (a second ventilator for the same patient is refused);
   - one patient per device at a time (a device still bound elsewhere needs a handover, always confirmed by hand).
   Points: order 35; location: same bed 55, spare device of the unit 20, another bed of the unit 10 (0 when that bed's
   own patient has the same order: the device belongs there); device online 10.
   >= 80 binds automatically (when auto mode is on), 50-79 waits for confirmation, below 50 is not proposed. */

export type Binding = {
  sesi: string; device: string; pasien: string; sep: string; mulai: string; selesai?: string;
  cara: "otomatis" | "konfirmasi" | "manual"; skor: number;
};
export type Alasan = { status: "ok" | "warn" | "no"; teks: string; poin?: number };
export type Usul = { device: string; pasien: string; skor: number; alasan: Alasan[]; jenis: "otomatis" | "konfirmasi" | "pindah"; dari?: string; catatan?: string };
export type HasilCocok = { usul: Usul[]; tanpa: { device: string; alasan: string }[]; sudah: string[] };

export const AMBANG_OTOMATIS = 80;
export const AMBANG_USUL = 50;
export const kunciPasangan = (device: string, pasien: string) => `${device}|${pasien}`;

export const aktifDevice = (aktif: Binding[], device: string) => aktif.find((b) => !b.selesai && b.device === device);
export const aktifSlot = (aktif: Binding[], pasien: string, alat: Alat) =>
  aktif.find((b) => !b.selesai && b.pasien === pasien && deviceById(b.device).alat === alat);

export function nilai(deviceId: string, pasienId: string, aktif: Binding[]) {
  const d = deviceById(deviceId);
  const p = pasienById(pasienId);
  const alasan: Alasan[] = [];
  let skor = 0;
  let layak = true;
  if (p.order.includes(d.alat)) {
    skor += 35;
    alasan.push({ status: "ok", teks: `Order dokter: ${ALAT[d.alat].nama} untuk ${p.id}`, poin: 35 });
  } else {
    layak = false;
    alasan.push({ status: "no", teks: `${p.id} tidak punya order ${ALAT[d.alat].nama}` });
  }
  if (d.unit === p.unit && d.bed === p.bed) {
    skor += 55;
    alasan.push({ status: "ok", teks: `Lokasi sama: ${lokasi(p)}`, poin: 55 });
  } else if (d.unit === p.unit && !d.bed) {
    skor += 20;
    alasan.push({ status: "warn", teks: `Device cadangan ${p.unit}, belum tercatat di bed mana pun`, poin: 20 });
  } else if (d.unit === p.unit) {
    // a device recorded at another bed belongs there when that bed's patient has the same order; otherwise it was moved
    const pemilik = PASIEN.find((x) => x.id !== p.id && x.unit === d.unit && x.bed === d.bed && x.order.includes(d.alat));
    const poin = pemilik ? 0 : 10;
    skor += poin;
    alasan.push({ status: "warn", poin, teks: pemilik ? `Device tercatat di ${d.bed} untuk order ${pemilik.id}, pasien ini di ${p.bed}` : `Device tercatat di ${d.bed} (tidak dipakai di sana), pasien di ${p.bed}: kemungkinan dipindah` });
  } else {
    alasan.push({ status: "warn", teks: `Lokasi berbeda: device di ${lokasi(d)}, pasien di ${lokasi(p)}`, poin: 0 });
  }
  if (d.online) {
    skor += 10;
    alasan.push({ status: "ok", teks: "Device online, kunci perangkat aktif", poin: 10 });
  } else {
    alasan.push({ status: "warn", teks: "Device offline: data pemakaian dikirim saat gateway tersambung lagi", poin: 0 });
  }
  const lain = aktif.find((b) => !b.selesai && b.pasien === p.id && b.device !== d.id && deviceById(b.device).alat === d.alat);
  if (lain) {
    layak = false;
    alasan.push({ status: "no", teks: `${p.id} sudah memakai ${ALAT[d.alat].nama} lain (${lain.device})` });
  }
  const ikat = aktifDevice(aktif, d.id);
  if (ikat && ikat.pasien !== p.id) alasan.push({ status: "warn", teks: `Device masih terikat ke ${ikat.pasien}: serah terima, binding lama dilepas` });
  else if (!ikat) alasan.push({ status: "ok", teks: "Device belum terikat ke pasien lain" });
  return { skor, alasan, layak };
}

export function cocokkan(pasienIds: string[], deviceIds: string[], aktif: Binding[], tolak: string[]): HasilCocok {
  const sudah: string[] = [];
  const calon: { d: string; p: string; skor: number; alasan: Alasan[] }[] = [];
  const gagal = new Map<string, string>();
  const petunjuk = new Map<string, string>();
  for (const d of deviceIds) {
    const ikat = aktifDevice(aktif, d);
    if (ikat && pasienIds.includes(ikat.pasien)) {
      sudah.push(d);
      continue;
    }
    let terbaik: { skor: number; teks: string } | null = null;
    for (const p of pasienIds) {
      if (tolak.includes(kunciPasangan(d, p))) continue;
      const n = nilai(d, p, aktif);
      if (n.layak && n.skor >= AMBANG_USUL) calon.push({ d, p, skor: n.skor, alasan: n.alasan });
      else {
        const teks = n.alasan.find((a) => a.status === "no")?.teks ?? `Keyakinan ${n.skor}% untuk ${p}, di bawah ${AMBANG_USUL}%`;
        if (!terbaik || n.skor > terbaik.skor) terbaik = { skor: n.skor, teks };
      }
    }
    const dv = deviceById(d);
    const alat = ALAT[dv.alat].nama;
    // the ward census knows who lies at the device's bed: point the nurse at that wristband first
    const sebelah = PASIEN.find((p) => p.unit === dv.unit && p.bed === dv.bed && p.order.includes(dv.alat) && !pasienIds.includes(p.id));
    if (sebelah) petunjuk.set(d, `Gelang pasien ${lokasi(dv)} belum dipindai di sesi ini`);
    gagal.set(d, pasienIds.length === 0 ? "Belum ada gelang pasien yang dipindai di sesi ini" : (terbaik?.teks ?? `Belum ada pasien di sesi ini yang memesan ${alat}`));
  }

  calon.sort((a, b) => b.skor - a.skor || a.d.localeCompare(b.d));
  const pakaiDevice = new Set<string>();
  const pakaiSlot = new Set<string>();
  const usul: Usul[] = [];
  for (const c of calon) {
    const slot = `${c.p}|${deviceById(c.d).alat}`;
    if (pakaiDevice.has(c.d) || pakaiSlot.has(slot)) continue;
    pakaiDevice.add(c.d);
    pakaiSlot.add(slot);
    const seri = calon.some((x) => x.d === c.d && x.p !== c.p && x.skor === c.skor);
    const ikat = aktifDevice(aktif, c.d);
    const jenis = ikat ? "pindah" : c.skor >= AMBANG_OTOMATIS && !seri ? "otomatis" : "konfirmasi";
    usul.push({ device: c.d, pasien: c.p, skor: c.skor, alasan: c.alasan, jenis, dari: ikat?.pasien, catatan: seri ? "Pasien lain di sesi ini sama cocoknya: pastikan pasangannya benar" : undefined });
  }
  const tanpa = deviceIds
    .filter((d) => !sudah.includes(d) && !pakaiDevice.has(d))
    .map((d) => ({
      device: d,
      alasan: petunjuk.get(d) ?? (calon.some((c) => c.d === d) ? `Pasien yang cocok sudah mendapat ${ALAT[deviceById(d).alat].nama} lain di sesi ini` : gagal.get(d)!),
    }));
  return { usul, tanpa, sudah };
}
