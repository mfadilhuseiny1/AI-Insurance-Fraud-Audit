/* Demo ward for the IoT binding app: patients (wristband QR = patient ID / no. RM) and IoT sensors (a current clamp on the
   power cable of a medical device: it records on-time and mode, never vitals). All names and numbers are fictitious.
   The scan videos show P-87345 and IOT-DEV-001, so those two come first in the decode order. */

export type Alat = "ventilator" | "niv" | "hd" | "syringe" | "infus";

export const ALAT: Record<Alat, { nama: string; singkat: string }> = {
  ventilator: { nama: "Ventilator", singkat: "Ventilator" },
  niv: { nama: "NIV / CPAP", singkat: "NIV" },
  hd: { nama: "Mesin hemodialisis", singkat: "Hemodialisis" },
  syringe: { nama: "Syringe pump", singkat: "Syringe pump" },
  infus: { nama: "Infusion pump", singkat: "Infusion pump" },
};

export type Pasien = {
  id: string; nama: string; jk: "L" | "P"; umur: number; unit: string; bed: string;
  sep: string; kartu: string; dpjp: string; dx: string; order: Alat[];
};

export type Device = {
  id: string; alat: Alat; label: string; unit: string; bed: string | null;
  online: boolean; mode: "jalan" | "standby" | "mati"; arus: number;
};

export const PASIEN: Pasien[] = [
  { id: "P-87345", nama: "Siti Rahmawati", jk: "P", umur: 54, unit: "ICU", bed: "Bed 3", sep: "0901R0011126V000873", kartu: "0001•••••4821", dpjp: "dr. Contoh Satu, Sp.An", dx: "Gagal napas akut (J96.0)", order: ["ventilator", "syringe"] },
  { id: "P-87352", nama: "Budi Santoso", jk: "L", umur: 61, unit: "ICU", bed: "Bed 4", sep: "0901R0011126V000881", kartu: "0001•••••7310", dpjp: "dr. Contoh Satu, Sp.An", dx: "Pneumonia berat (J18.9)", order: ["ventilator", "infus"] },
  { id: "P-87371", nama: "Andi Pratama", jk: "L", umur: 38, unit: "ICU", bed: "Bed 5", sep: "0901R0011126V000902", kartu: "0002•••••1187", dpjp: "dr. Contoh Dua, Sp.P", dx: "Edema paru akut (J81)", order: ["niv", "infus"] },
  { id: "P-87394", nama: "Rudi Hartono", jk: "L", umur: 59, unit: "ICU", bed: "Bed 6", sep: "0901R0011126V000917", kartu: "0001•••••5562", dpjp: "dr. Contoh Satu, Sp.An", dx: "ARDS (J80)", order: ["ventilator", "syringe"] },
  { id: "P-87360", nama: "Wahyuni Lestari", jk: "P", umur: 47, unit: "Unit HD", bed: "Kursi 2", sep: "0901R0011126V000894", kartu: "0003•••••0459", dpjp: "dr. Contoh Tiga, Sp.PD-KGH", dx: "Gagal ginjal kronik st. 5 (N18.5)", order: ["hd"] },
  { id: "P-87388", nama: "Maria Ulfa", jk: "P", umur: 66, unit: "HCU", bed: "Bed 1", sep: "0901R0011126V000925", kartu: "0002•••••9034", dpjp: "dr. Contoh Empat, Sp.PD", dx: "Syok sepsis (A41.9)", order: ["syringe", "infus"] },
];

export const DEVICE: Device[] = [
  { id: "IOT-DEV-001", alat: "ventilator", label: "V-03", unit: "ICU", bed: "Bed 3", online: true, mode: "jalan", arus: 1.8 },
  { id: "IOT-DEV-002", alat: "syringe", label: "SP-11", unit: "ICU", bed: "Bed 3", online: true, mode: "jalan", arus: 0.3 },
  { id: "IOT-DEV-003", alat: "ventilator", label: "V-04", unit: "ICU", bed: "Bed 4", online: true, mode: "jalan", arus: 1.7 },
  { id: "IOT-DEV-004", alat: "infus", label: "IP-07", unit: "ICU", bed: "Bed 4", online: true, mode: "jalan", arus: 0.4 },
  { id: "IOT-DEV-005", alat: "niv", label: "N-01", unit: "ICU", bed: "Bed 5", online: true, mode: "standby", arus: 0.2 },
  { id: "IOT-DEV-006", alat: "infus", label: "IP-09", unit: "ICU", bed: "Bed 5", online: true, mode: "jalan", arus: 0.4 },
  { id: "IOT-DEV-007", alat: "ventilator", label: "V-06", unit: "ICU", bed: "Bed 6", online: true, mode: "jalan", arus: 1.9 },
  { id: "IOT-DEV-008", alat: "syringe", label: "SP-15", unit: "ICU", bed: "Bed 6", online: false, mode: "mati", arus: 0 },
  { id: "IOT-DEV-009", alat: "hd", label: "HD-02", unit: "Unit HD", bed: "Kursi 2", online: true, mode: "jalan", arus: 6.2 },
  { id: "IOT-DEV-010", alat: "syringe", label: "SP-14", unit: "HCU", bed: "Bed 1", online: true, mode: "jalan", arus: 0.3 },
  { id: "IOT-DEV-011", alat: "infus", label: "IP-12", unit: "HCU", bed: "Bed 1", online: true, mode: "jalan", arus: 0.4 },
  { id: "IOT-DEV-012", alat: "ventilator", label: "V-07", unit: "ICU", bed: null, online: true, mode: "standby", arus: 0.3 },
];

export const pasienById = (id: string) => PASIEN.find((p) => p.id === id)!;
export const deviceById = (id: string) => DEVICE.find((d) => d.id === id)!;
export const lokasi = (x: { unit: string; bed: string | null }) => (x.bed ? `${x.unit} · ${x.bed}` : `${x.unit} · ruang alat (cadangan)`);
export const namaDevice = (d: Device) => `${ALAT[d.alat].nama} ${d.label}`;
