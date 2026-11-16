import { deviceById, type Alat } from "./data";
import type { Binding } from "./match";

/* Discharge summary: every IoT session of one stay, closed at discharge, and the E-Klaim duration fields taken from the
   device data instead of being typed (docs/IOT_KONTRAK.md: jam_ventilator, sesi_hemodialisis). A session counts as use
   only when the sensor reads the device running ("jalan"); standby hours are shown apart and never added. */

export type BarisSesi = { sesi: string; device: string; alat: Alat; mulai: string; selesai: string; jam: number; mode: "jalan" | "standby" | "mati" };
export type Ringkasan = {
  baris: BarisSesi[];
  /** E-Klaim fields from the devices */
  eklaim: { jam_ventilator: number; jam_niv: number; sesi_hemodialisis: number };
  /** hours a bound device was on standby: not use */
  jamSiaga: number;
};

const jamAntara = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 3_600_000);

export function ringkasanPulang(pasien: string, bindings: Binding[], pulangPada: string): Ringkasan {
  const baris = bindings
    .filter((b) => b.pasien === pasien && Date.parse(b.mulai) <= Date.parse(pulangPada))
    .map((b) => {
      const d = deviceById(b.device);
      const selesai = b.selesai ?? pulangPada;
      return { sesi: b.sesi, device: d.id, alat: d.alat, mulai: b.mulai, selesai, jam: jamAntara(b.mulai, selesai), mode: d.mode };
    })
    .sort((a, b) => a.mulai.localeCompare(b.mulai));
  const jalan = (alat: Alat) => baris.filter((x) => x.alat === alat && x.mode === "jalan");
  const jumlah = (xs: BarisSesi[]) => Math.round(xs.reduce((s, x) => s + x.jam, 0) * 1000) / 1000;
  return {
    baris,
    eklaim: { jam_ventilator: jumlah(jalan("ventilator")), jam_niv: jumlah(jalan("niv")), sesi_hemodialisis: jalan("hd").length },
    jamSiaga: jumlah(baris.filter((x) => x.mode !== "jalan")),
  };
}

/** "3 mnt", "5,2 jam" */
export const durasi = (jam: number) => (jam < 1 ? `${Math.round(jam * 60)} mnt` : `${jam.toLocaleString("id-ID", { maximumFractionDigits: 1 })} jam`);
