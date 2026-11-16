import type { ObjType } from "../agent-studio/data";
export type { ObjType };
export const OBJECT_TYPES: ObjType[] = [
  { id:"faskes", name:"Fasilitas Kesehatan", plural:"Fasilitas Kesehatan", group:"Faskes", color:"#c62f3b", count:1842, status:"Attention", desc:"RS, puskesmas dan klinik peserta JKN dengan skor efisiensi risiko hasil skrining 20 kategori.", x:400,y:250,
    props:[{name:"faskes_id",type:"String",value:"FK-0201"},{name:"nama",type:"String",value:"RSUD Al-Ihsan"},{name:"kelas",type:"String",value:"RS Kelas B"},{name:"skor_risiko",type:"Double",value:"87.4 / 100"},{name:"wilayah",type:"String",value:"Kab. Bandung"}],
    pipeline:"jkn-risk-screening-pipeline", dataset:"bpjs_faskes_master", freshness:"9 min ago",
    instances:[{id:"FK-0201",title:"RSUD Al-Ihsan — Kab. Bandung",status:"Risiko 87.4",detail:"Kategori: LOS, readmisi, INA-CBG"},{id:"FK-0117",title:"RSIA Limijati — Kota Bandung",status:"Risiko 71.2",detail:"Kategori: klaim bedah, farmasi"},{id:"FK-0330",title:"Puskesmas Arcamanik",status:"Risiko 22.8",detail:"Dalam batas wajar"}]},
  { id:"klaim", name:"Klaim INA-CBG", plural:"Klaim INA-CBG", group:"Klaim", color:"#c94f9e", count:284120, status:"Attention", desc:"Klaim INA-CBG yang diajukan faskes, lengkap dengan tarif, LOS dan status verifikasi.", x:560,y:150,
    props:[{name:"klaim_id",type:"String",value:"KLM-991820"},{name:"kode_inacbg",type:"String",value:"I-4-12-I"},{name:"tarif_klaim",type:"Long",value:"Rp 18.450.000"},{name:"los_hari",type:"Integer",value:"9 hari"},{name:"status",type:"String",value:"Ditahan — audit"}],
    pipeline:"jkn-claims-pipeline", dataset:"bpjs_klaim_inacbg", freshness:"14 min ago",
    instances:[{id:"KLM-991820",title:"INA-CBG I-4-12-I — RSUD Al-Ihsan",status:"Ditahan",detail:"LOS 9 hari · Rp 18,45 jt"},{id:"KLM-991204",title:"INA-CBG O-6-10-B — RSIA Limijati",status:"Verifikasi",detail:"Sectio · Rp 9,8 jt"}]},
  { id:"peserta", name:"Peserta JKN", plural:"Peserta JKN", group:"Peserta", color:"#8391a7", count:1824000, status:"Healthy", desc:"Peserta JKN terdaftar per faskes tingkat pertama dan wilayah.", x:400,y:90,
    props:[{name:"peserta_id",type:"String",value:"PST-••••8812"},{name:"segmen",type:"String",value:"PBPU"},{name:"fktp",type:"String",value:"Puskesmas Arcamanik"},{name:"status_kepesertaan",type:"String",value:"Aktif"}],
    pipeline:"peserta-sync", dataset:"bpjs_peserta", freshness:"1 h ago",
    instances:[{id:"PST-8812",title:"Peserta PBPU — Arcamanik",status:"Aktif",detail:"FKTP Puskesmas Arcamanik"}]},
  { id:"dpjp", name:"Dokter / DPJP", plural:"Dokter / DPJP", group:"Faskes", color:"#3d8bfd", count:4210, status:"Healthy", desc:"Dokter dan DPJP dengan beban kasus, pola klaim dan spesialisasi.", x:250,y:140,
    props:[{name:"dpjp_id",type:"String",value:"DR-5510"},{name:"nama",type:"String",value:"dr. Spesialis Penyakit Dalam"},{name:"kasus_bulan",type:"Integer",value:"212 kasus"},{name:"rasio_rujukan",type:"Double",value:"0.31"}],
    pipeline:"jkn-risk-screening-pipeline", dataset:"bpjs_dpjp", freshness:"26 min ago",
    instances:[{id:"DR-5510",title:"DPJP Penyakit Dalam — RSUD Al-Ihsan",status:"212 kasus/bln",detail:"Rasio rujukan 0.31"}]},
  { id:"rujukan", name:"Kasus Rujukan", plural:"Kasus Rujukan", group:"Klaim", color:"#5b84ae", count:38940, status:"Degraded", desc:"Rujukan FKTP ke FKRTL, termasuk rujukan parsial dan balik.", x:650,y:270,
    props:[{name:"rujukan_id",type:"String",value:"RJK-77120"},{name:"jenis",type:"String",value:"Rujukan parsial"},{name:"diagnosa",type:"String",value:"I10 — Hipertensi"},{name:"fktp_asal",type:"Link · Fasilitas Kesehatan",value:"Puskesmas Arcamanik"}],
    pipeline:"rujukan-pipeline", dataset:"bpjs_rujukan", freshness:"19 min ago",
    instances:[{id:"RJK-77120",title:"Rujukan parsial I10 — Arcamanik",status:"Berjalan",detail:"Kontrol ke-4 bulan ini"}]},
  { id:"temuan", name:"Temuan Audit", plural:"Temuan Audit", group:"Audit", color:"#f0a843", count:1284, status:"Attention", desc:"Temuan hasil pemeriksaan auditor atas klaim dan berkas faskes, siap keputusan.", x:250,y:370,
    props:[{name:"temuan_id",type:"String",value:"TMN-118"},{name:"kategori",type:"String",value:"Potensi upcoding INA-CBG"},{name:"nilai_klaim",type:"Long",value:"Rp 1,24 M"},{name:"keyakinan",type:"Double",value:"0.91"}],
    pipeline:"jkn-risk-screening-pipeline", dataset:"audit_temuan", freshness:"7 min ago",
    instances:[{id:"TMN-118",title:"Potensi upcoding — RSUD Al-Ihsan",status:"Keyakinan 0.91",detail:"42 klaim · Rp 1,24 M"}]},
  { id:"tarif", name:"Tarif INA-CBG", plural:"Tarif INA-CBG", group:"Klaim", color:"#c94f9e", count:1420, status:"Healthy", desc:"Referensi tarif INA-CBG per kode, kelas RS dan region.", x:540,y:380,
    props:[{name:"kode",type:"String",value:"I-4-12-I"},{name:"tarif_kelas_b",type:"Long",value:"Rp 14.920.000"},{name:"region",type:"String",value:"Region I"}],
    pipeline:"tarif-reference-sync", dataset:"ref_tarif_inacbg", freshness:"1 d ago",
    instances:[{id:"I-4-12-I",title:"I-4-12-I — Kelas B Region I",status:"Rp 14,92 jt",detail:"Selisih klaim +23%"}]},
  { id:"iot", name:"Alat Medis (IoT)", plural:"Alat Medis", group:"Faskes", color:"#34c38f", count:8640, status:"Healthy", desc:"Alat medis terhubung: utilisasi, kalibrasi dan ketersediaan per faskes.", x:130,y:250,
    props:[{name:"alat_id",type:"String",value:"ALKES-VENT-07"},{name:"jenis",type:"String",value:"Ventilator ICU"},{name:"utilisasi",type:"Double",value:"0.86"},{name:"kalibrasi",type:"Date",value:"2026-08-14"}],
    pipeline:"iot-alkes-pipeline", dataset:"iot_alat_medis", freshness:"3 min ago",
    instances:[{id:"VENT-07",title:"Ventilator ICU — RSUD Al-Ihsan",status:"Utilisasi 0.86",detail:"Kalibrasi berlaku"}]},
  { id:"jadwal", name:"Jadwal Audit", plural:"Jadwal Audit", group:"Audit", color:"#34c38f", count:148, status:"Healthy", desc:"Jadwal audit lapangan dan desk audit per faskes dan auditor.", x:130,y:110,
    props:[{name:"jadwal_id",type:"String",value:"JDW-88"},{name:"faskes",type:"Link · Fasilitas Kesehatan",value:"RSUD Al-Ihsan"},{name:"tanggal",type:"Date",value:"2026-10-27"},{name:"auditor",type:"String",value:"Tim Audit A"}],
    pipeline:"audit-planning", dataset:"audit_jadwal", freshness:"32 min ago",
    instances:[{id:"JDW-88",title:"Audit lapangan RSUD Al-Ihsan",status:"27 Okt 2026",detail:"Tim Audit A · 3 hari"}]},
  { id:"berkas", name:"Berkas Klaim", plural:"Berkas Klaim", group:"Audit", color:"#e2b866", count:52110, status:"Healthy", desc:"SEP, resume medis dan dokumen pendukung klaim hasil ekstraksi dokumen.", x:400,y:410,
    props:[{name:"berkas_id",type:"String",value:"BRK-55210"},{name:"jenis",type:"String",value:"Resume medis + SEP"},{name:"ekstraksi",type:"String",value:"Parse selesai · 98% field"}],
    pipeline:"berkas-extract-pipeline", dataset:"klaim_berkas", freshness:"11 min ago",
    instances:[{id:"BRK-55210",title:"Resume medis KLM-991820",status:"Parse 98%",detail:"SEP terverifikasi"}]},
];
export const EDGES: [string,string,string][] = [
  ["klaim","faskes","diajukan oleh"],["klaim","peserta","untuk peserta"],["klaim","tarif","dibandingkan ke"],["faskes","dpjp","memiliki DPJP"],
  ["rujukan","faskes","menuju faskes"],["temuan","klaim","atas klaim"],["temuan","berkas","bukti berkas"],["jadwal","faskes","audit faskes"],
  ["iot","faskes","terpasang di"],["berkas","klaim","mendukung klaim"],
];
export const AGENTS = [
  { id:"audit", name:"Audit Copilot JKN", desc:"Menyelidiki faskes berisiko, mengambil klaim terkait dan menyusun rencana audit.", model:"AIP · jkn-audit-copilot", online:true },
  { id:"fraud", name:"Fraud Screening Agent", desc:"Skrining 20 kategori efisiensi risiko: upcoding, LOS, readmisi, rujukan dan farmasi.", model:"AIP · jkn-fraud-screener", online:true },
  { id:"medical", name:"Medical Review Agent", desc:"Menilai kewajaran medis klaim dari resume dan berkas pendukung.", model:"AIP · medical-review", online:false },
];
export const ACTIONS = [
  { name:"Tahan Klaim", on:"Klaim INA-CBG", href:"/ontology" },
  { name:"Minta Berkas Tambahan", on:"Fasilitas Kesehatan", href:"/ontology" },
  { name:"Jadwalkan Audit Lapangan", on:"Fasilitas Kesehatan", href:"/demo-jkn/audit" },
  { name:"Setujui Klaim", on:"Klaim INA-CBG", href:"/ontology" },
  { name:"Eskalasi ke Investigasi", on:"Temuan Audit", href:"/demo-jkn/audit" },
];
export const LOGICS = [
  { name:"Skrining Efisiensi Risiko (20 kategori)", runs:412, href:"/logic" },
  { name:"Deteksi Upcoding INA-CBG", runs:238, href:"/logic" },
  { name:"Rekomendasi Prioritas Audit Faskes", runs:167, href:"/logic" },
  { name:"Ringkasan Dampak Peserta", runs:304, href:"/logic" },
];
export const FUNCTIONS = [
  { name:"skorRisikoFaskes()", ver:"v9", href:"/functions" },
  { name:"estimasiPotensiEfisiensi()", ver:"v6", href:"/functions" },
  { name:"klaimAnomaliPeriode()", ver:"v11", href:"/functions" },
];
export const FILES = [
  { name:"jkn-risk-screening-pipeline", kind:"Pipeline", href:"/pipeline" },
  { name:"berkas-extract-pipeline", kind:"Pipeline", href:"/pipeline" },
  { name:"bpjs_klaim_inacbg", kind:"Dataset", href:"/datasets" },
  { name:"klaim_berkas (SEP + resume)", kind:"Media set", href:"/media-sets" },
  { name:"Ruang Kerja Audit Faskes (Workshop)", kind:"Workshop app", href:"/demo-jkn/audit" },
];
export const SUGGESTIONS = [
  "Investigasi RSUD Al-Ihsan dan susun rencana audit",
  "Klaim INA-CBG mana yang berpotensi upcoding minggu ini?",
  "Faskes mana prioritas audit lapangan bulan ini?",
  "Tahan klaim anomali dan minta berkas tambahan",
];
export const byId = (id:string)=>OBJECT_TYPES.find(o=>o.id===id)!;
export const neighbors = (id:string)=>{ const s=new Set<string>(); EDGES.forEach(([a,b])=>{ if(a===id)s.add(b); if(b===id)s.add(a); }); return s; };
