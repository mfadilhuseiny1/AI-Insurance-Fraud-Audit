import { ALAT, DEVICE, PASIEN, lokasi, namaDevice, pasienById } from "./data";
import { aktifDevice, aktifSlot, type Binding } from "./match";

/* What the nurse should fix now, before it turns into an audit finding months later. Each warning mirrors a check of the
   claim engine (api/aip/realtime/iot.py), in plain words:
   - a device running with no patient bound: its use counts for no claim (unbound readings);
   - a bound device on standby: standby hours are not use (ventilator billed while only on standby);
   - a bound device offline: its readings wait on the device until the gateway is back;
   - a doctor's order with no device bound, where no running device at that bed could take it. */

export type Peringatan = {
  id: string; tingkat: "tinggi" | "sedang"; judul: string; isi: string;
  device?: string; pasien?: string; aksi: "scan-device" | "buka-device" | "buka-pasien";
};

const PENTING = new Set(["ventilator", "niv", "hd"]);

export function daftarPeringatan(bindings: Binding[], pulang: Record<string, string>): Peringatan[] {
  const out: Peringatan[] = [];
  const dirawat = PASIEN.filter((p) => !pulang[p.id]);
  for (const d of DEVICE) {
    const b = aktifDevice(bindings, d.id);
    if (!b && d.online && d.mode === "jalan") {
      const sebed = dirawat.find((p) => p.unit === d.unit && p.bed === d.bed && p.order.includes(d.alat) && !aktifSlot(bindings, p.id, d.alat));
      out.push({
        id: `jalan-${d.id}`, tingkat: PENTING.has(d.alat) ? "tinggi" : "sedang", device: d.id, aksi: "scan-device",
        judul: `${d.id} menyala tanpa pasien terikat`,
        isi: `${namaDevice(d)} di ${lokasi(d)} sedang jalan, tetapi belum diikat ke pasien: pemakaiannya tidak tercatat untuk klaim siapa pun.${sebed ? ` Pasien di bed ini: ${sebed.id} ${sebed.nama}.` : ""}`,
      });
    } else if (b && d.online && d.mode !== "jalan") {
      const p = pasienById(b.pasien);
      out.push({
        id: `siaga-${d.id}`, tingkat: PENTING.has(d.alat) ? "tinggi" : "sedang", device: d.id, aksi: "buka-device",
        judul: `${d.id} terikat tetapi ${d.mode === "standby" ? "siaga" : "mati"}`,
        isi: `${namaDevice(d)} terikat ke ${p.id} ${p.nama}, tetapi sensor membaca mode ${d.mode}. Jam ${d.mode === "standby" ? "siaga" : "mati"} tidak dihitung sebagai jam pemakaian.`,
      });
    } else if (b && !d.online) {
      const p = pasienById(b.pasien);
      out.push({
        id: `offline-${d.id}`, tingkat: "sedang", device: d.id, aksi: "buka-device",
        judul: `${d.id} offline`,
        isi: `Terikat ke ${p.id} ${p.nama}. Bacaan tertahan di alat sampai gateway ${d.unit} tersambung lagi; pastikan jaringan ruangan menyala supaya jam pemakaian tidak terputus.`,
      });
    }
  }
  const ditangani = new Set(out.filter((x) => x.aksi === "scan-device").map((x) => x.device));
  for (const p of dirawat) {
    for (const a of p.order) {
      if (aktifSlot(bindings, p.id, a)) continue;
      // a running unbound device at this bed is already listed above: binding it answers this order too
      const diBed = DEVICE.find((d) => d.alat === a && d.unit === p.unit && d.bed === p.bed && ditangani.has(d.id));
      if (diBed) continue;
      out.push({
        id: `order-${p.id}-${a}`, tingkat: "sedang", pasien: p.id, aksi: "buka-pasien",
        judul: `${p.id}: ${ALAT[a].nama} belum terikat`,
        isi: `Order ${ALAT[a].nama} untuk ${p.nama} (${lokasi(p)}) belum punya device IoT terikat, dan tidak ada device ${ALAT[a].nama.toLowerCase()} yang menyala di bed ini.`,
      });
    }
  }
  return out.sort((x, y) => (x.tingkat === y.tingkat ? x.id.localeCompare(y.id) : x.tingkat === "tinggi" ? -1 : 1));
}
