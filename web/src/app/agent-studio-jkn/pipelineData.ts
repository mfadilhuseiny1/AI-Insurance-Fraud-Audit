import type { PEdge, PNode } from "../agent-studio/pipelineData";
export const JKN_NODES: PNode[] = [
  { id:"klaimRaw", label:"klaim_raw", kind:"dataset", group:"Klaim", color:"#c94f9e", x:20,y:30, cols:18, desc:"Klaim INA-CBG mentah dari VClaim" },
  { id:"klaimBack", label:"Klaim Backfill", kind:"dataset", group:"Klaim", color:"#c94f9e", x:20,y:105, cols:18, desc:"Backfill 24 bulan" },
  { id:"sep", label:"SEP + Berkas", kind:"metadata", group:"Klaim", color:"#c94f9e", x:20,y:185, cols:9, desc:"SEP dan resume ter-ekstraksi" },
  { id:"unionK", label:"Union by name", kind:"union", group:"Klaim", color:"#ffffff", x:210,y:70, cols:18, desc:"Union klaim + backfill" },
  { id:"joinTarif", label:"Left join Tarif", kind:"join", group:"Klaim", color:"#ffffff", x:400,y:60, cols:21, desc:"Join tarif INA-CBG per kelas/region" },
  { id:"skrining", label:"Skrining 20 kategori", kind:"transform", group:"Skrining Risiko", color:"#c62f3b", x:590,y:60, cols:24, desc:"Aturan efisiensi risiko faskes (Python transforms)" },
  { id:"skor", label:"Skor Risiko Faskes", kind:"function", group:"Skrining Risiko", color:"#8b5cf6", x:790,y:60, cols:6, desc:"Function skorRisikoFaskes()" },
  { id:"faskesOut", label:"Fasilitas Kesehatan", kind:"output", group:"Skrining Risiko", color:"#c62f3b", x:985,y:60, cols:12, desc:"Object output · Deployed" },
  { id:"los", label:"Pola LOS + Readmisi", kind:"transform", group:"Skrining Risiko", color:"#c62f3b", x:590,y:170, cols:8, desc:"LOS menyimpang + readmisi 30 hari" },
  { id:"temuanOut", label:"Temuan Audit", kind:"output", group:"Audit", color:"#f0a843", x:985,y:170, cols:9, desc:"Object output · Deployed" },
  { id:"peserta", label:"Peserta", kind:"dataset", group:"Peserta", color:"#8391a7", x:210,y:300, cols:7, desc:"Kepesertaan aktif" },
  { id:"rujukan", label:"Rujukan", kind:"dataset", group:"Peserta", color:"#5b84ae", x:210,y:375, cols:6, desc:"Rujukan FKTP ke FKRTL" },
  { id:"joinPeserta", label:"Left join Peserta", kind:"join", group:"Peserta", color:"#ffffff", x:400,y:335, cols:11, desc:"Klaim per peserta + rujukan" },
  { id:"anomali", label:"Deteksi Anomali Klaim", kind:"transform", group:"Skrining Risiko", color:"#c62f3b", x:590,y:335, cols:10, desc:"Upcoding, unbundling, phantom billing" },
  { id:"klaimOut", label:"Klaim INA-CBG", kind:"output", group:"Klaim", color:"#c94f9e", x:790,y:335, cols:14, desc:"Object output · Deployed" },
  { id:"iot", label:"IoT Alat Medis", kind:"dataset", group:"Faskes", color:"#34c38f", x:210,y:470, cols:5, desc:"Utilisasi alat per faskes" },
  { id:"iotJoin", label:"Join utilisasi × klaim", kind:"join", group:"Faskes", color:"#ffffff", x:400,y:470, cols:6, desc:"Utilisasi alat vs klaim tindakan" },
  { id:"iotOut", label:"Alat Medis (IoT)", kind:"output", group:"Faskes", color:"#34c38f", x:590,y:470, cols:5, desc:"Object output · Deployed" },
];
export const JKN_EDGES: PEdge[] = [
  {from:"klaimRaw",to:"unionK"},{from:"klaimBack",to:"unionK"},{from:"sep",to:"joinTarif"},{from:"unionK",to:"joinTarif"},
  {from:"joinTarif",to:"skrining"},{from:"skrining",to:"skor"},{from:"skor",to:"faskesOut"},{from:"skrining",to:"los"},{from:"los",to:"temuanOut"},
  {from:"peserta",to:"joinPeserta"},{from:"rujukan",to:"joinPeserta"},{from:"joinPeserta",to:"anomali"},{from:"anomali",to:"klaimOut"},
  {from:"iot",to:"iotJoin"},{from:"iotJoin",to:"iotOut"},
];
// what the agent adds on its branch "Tambah Telemetri IoT": three telemetry datasets, the joins, a utilisation-vs-claims
// check, a new object target and the two AI functions that feed Temuan Audit
export const JKN_AI_NODES: PNode[] = [
  { id:"aiLog", label:"Log Utilisasi Alat", kind:"dataset", group:"Telemetri IoT", color:"#7c6bb0", x:20,y:570, cols:8, desc:"Telemetri jam-an alat medis (MQTT)", proposed:true },
  { id:"aiKal", label:"Kalibrasi Alat", kind:"dataset", group:"Telemetri IoT", color:"#7c6bb0", x:20,y:640, cols:5, desc:"Riwayat kalibrasi per alat", proposed:true },
  { id:"aiTindakan", label:"Jadwal Tindakan", kind:"dataset", group:"Telemetri IoT", color:"#7c6bb0", x:20,y:710, cols:7, desc:"Tindakan terjadwal dari SIMRS", proposed:true },
  { id:"aiUnion", label:"Union by name", kind:"union", group:"Telemetri IoT", color:"#ffffff", x:210,y:600, cols:9, desc:"AI-generated · gabung log + kalibrasi", proposed:true },
  { id:"aiJoinT", label:"Left join Tindakan", kind:"join", group:"Telemetri IoT", color:"#ffffff", x:400,y:640, cols:12, desc:"AI-generated · alat × tindakan per jam", proposed:true },
  { id:"aiUtil", label:"Utilisasi vs Klaim", kind:"transform", group:"Telemetri IoT", color:"#7c6bb0", x:590,y:600, cols:13, desc:"AI-generated · tindakan diklaim tanpa pemakaian alat", proposed:true },
  { id:"aiUtilOut", label:"Utilisasi Alat Medis", kind:"output", group:"Telemetri IoT", color:"#7c6bb0", x:790,y:600, cols:13, desc:"Object target baru · dibuat agen", proposed:true },
  { id:"aiUpcoding", label:"Deteksi Upcoding (AI)", kind:"function", group:"Skrining Risiko", color:"#8b5cf6", x:790,y:170, cols:7, desc:"AI-generated · bandingkan kode klaim vs resume medis", proposed:true },
  { id:"aiPrioritas", label:"Prioritas Audit (AI)", kind:"transform", group:"Audit", color:"#ffffff", x:985,y:270, cols:6, desc:"AI-generated · rangking faskes untuk audit lapangan", proposed:true },
];
export const JKN_AI_EDGES: PEdge[] = [
  {from:"aiLog",to:"aiUnion"},{from:"aiKal",to:"aiUnion"},{from:"aiUnion",to:"aiJoinT"},{from:"aiTindakan",to:"aiJoinT"},
  {from:"aiJoinT",to:"aiUtil"},{from:"iotJoin",to:"aiUtil"},{from:"aiUtil",to:"aiUtilOut"},
  {from:"skrining",to:"aiUpcoding"},{from:"aiUtil",to:"aiUpcoding"},{from:"aiUpcoding",to:"aiPrioritas"},{from:"aiPrioritas",to:"temuanOut"},
];
export const JKN_LEGEND = [
  { group:"Skrining Risiko", color:"#c62f3b", count:11 }, { group:"Klaim", color:"#c94f9e", count:9 },
  { group:"Peserta", color:"#5b84ae", count:5 }, { group:"Faskes", color:"#34c38f", count:4 }, { group:"Audit", color:"#f0a843", count:4 }, { group:"Telemetri IoT", color:"#7c6bb0", count:7 },
];
