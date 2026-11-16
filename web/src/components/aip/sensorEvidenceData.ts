/* Content of the "IoT · IoMT · Blockchain" tab (SensorEvidenceView.tsx): how measured evidence from devices, and a
   record that cannot be edited afterwards, close the gap of each claim-fraud mode in FKRTL claims (the six modes of
   Permenkes 16/2019, as in the Healthkathon deck). Concept content — it reads no BPJS claim data. The numbers in
   `metric` are ILLUSTRATIVE. Terms stay in English where an Indonesian coinage would not fit. */

export type Source = "IoT" | "IoMT";
export type Readiness = "demo" | "integration" | "research";

export type Signal = { type: Source; device: string; evidence: string };
export type FraudMode = {
  id: string;
  name: string;
  /** the swarm agent that reads these signals */
  agent: string;
  how: string;
  /** illustration: what the claim reports vs what measured evidence supports */
  metric: { reported: string; reportedValue: number; measured: string; measuredValue: number; unit: string };
  signals: Signal[];
  /** what the tamper-evident record adds */
  anchor: string;
  redFlag: string;
  /** what keeps the rule from accusing the wrong facility */
  guardrail: string;
  readiness: { level: Readiness; label: string };
  /** a page of the audit workspace (fictional data) where the principle already runs */
  demo?: { href: string; label: string };
};

export const READINESS_COLOR: Record<Readiness, string> = { demo: "#34d399", integration: "#fbbf24", research: "#94a3b8" };
export const SOURCE_COLOR: Record<Source | "Ledger", string> = { IoT: "#2dd4bf", IoMT: "#60a5fa", Ledger: "#a78bfa" };

export const LAYERS: { id: Source | "Ledger"; name: string; question: string; examples: string; limit: string }[] = [
  {
    id: "IoT",
    name: "IoT · infrastructure sensors",
    question: "Apakah alat, orang, atau barangnya benar ada di sana dan aktif pada jam itu?",
    examples: "Power meter / CT clamp, RFID wristband, bed sensor, smart cabinet, QR/NFC reader, device heartbeat.",
    limit: "Membuktikan kehadiran dan aktivitas, bukan isi tindakan medisnya.",
  },
  {
    id: "IoMT",
    name: "IoMT · connected medical devices",
    question: "Seberapa berat dan lama perawatannya, menurut alat yang merawat itu sendiri?",
    examples: "Ventilator, mesin hemodialisis, infusion pump, patient monitor, imaging (DICOM header), wearable pascapulang.",
    limit: "Butuh interface atau export log dari vendor, dan datanya data kesehatan, jadi dilindungi ketat.",
  },
  {
    id: "Ledger",
    name: "Blockchain · evidence integrity",
    question: "Apakah bukti ini sama persis dengan yang tercatat sebelum klaim diajukan?",
    examples: "Hash batch log alat, snapshot klaim, temuan agen, keputusan verifikator — di-anchor pada permissioned ledger.",
    limit: "Mengunci bukti setelah ditangkap; tidak membuktikan bahwa sumbernya jujur.",
  },
];

export const FRAUD_MODES: FraudMode[] = [
  {
    id: "upcoding",
    name: "Upcoding & Unbundling",
    agent: "Agen Klinis · Agen Tagihan",
    how: "Diagnosis atau tindakan dinaikkan ke kelas tarif yang lebih tinggi dari yang sebenarnya dikerjakan; atau satu paket tindakan dipecah supaya tiap bagiannya ditagih sendiri.",
    metric: { reported: "Ventilasi mekanik pada klaim (severity III)", reportedValue: 120, measured: "Jam ventilasi di log ventilator", measuredValue: 11, unit: "jam" },
    signals: [
      { type: "IoMT", device: "Ventilator & patient monitor (ICU)", evidence: "Jam ventilasi, mode, tren tanda vital: intensitas perawatan nyata vs severity yang ditagih." },
      { type: "IoMT", device: "Imaging (DICOM header)", evidence: "Jenis studi, jumlah series, timestamp. Beberapa kode tindakan dalam satu sesi alat yang kontinu = kandidat unbundling." },
      { type: "IoMT", device: "Smart infusion pump", evidence: "Obat dan volume yang benar-benar diberikan, bukan yang tertulis di resume." },
      { type: "IoT", device: "Power meter alat", evidence: "Alat tanpa interface digital tetap meninggalkan jejak daya per tindakan (sudah didemokan)." },
    ],
    anchor: "Hash log alat di-anchor sebelum klaim diajukan, sehingga log tidak bisa disesuaikan belakangan agar cocok dengan kode yang sudah ditagih.",
    redFlag: "Severity atau INA-CBG yang ditagih lebih tinggi dari intensitas terukur (jam alat, tren vital), atau beberapa kode tindakan jatuh dalam satu sesi alat yang kontinu.",
    guardrail: "Alat membuktikan tindakan dan intensitasnya, bukan benar-tidaknya kode diagnosis. Diagnosis tetap dinilai Agen Klinis dan verifikator.",
    readiness: { level: "integration", label: "Power meter sudah didemokan · log IoMT butuh integrasi" },
    demo: { href: "/demo-jkn/audit?tab=iot", label: "IoT alat medis (data fiktif)" },
  },
  {
    id: "phantom",
    name: "Phantom & Repeat Billing",
    agent: "Agen Tagihan",
    how: "Tindakan yang tidak pernah dilakukan ditagih (phantom), atau satu service event ditagih berkali-kali (repeat).",
    metric: { reported: "Sesi hemodialisis pada klaim bulan ini", reportedValue: 310, measured: "Sesi tercatat di mesin HD", measuredValue: 214, unit: "sesi" },
    signals: [
      { type: "IoMT", device: "Mesin hemodialisis", evidence: "ID sesi, durasi, volume ultrafiltrasi per pasien: data sesi yang disimpan mesin." },
      { type: "IoT", device: "Power meter alat", evidence: "Daya alat pada jam tindakan yang ditagih: alat mati = klaim tanpa pemakaian (sudah didemokan)." },
      { type: "IoT", device: "RFID/BLE wristband & location beacon", evidence: "Kehadiran fisik pasien di ruang tindakan pada jam klaim." },
      { type: "IoT", device: "Point-of-service check (QR/NFC, sidik jari, wajah)", evidence: "Peserta benar-benar hadir saat dilayani; menyulitkan klaim atas peserta yang tidak datang." },
    ],
    anchor: "Tiap service event diberi ID unik (alat + waktu + patient token pseudonim) yang dicatat sekali. Klaim kedua atas ID yang sama ditolak otomatis, juga lintas faskes.",
    redFlag: "Klaim pada jam alat mati; satu alat 'melayani' lebih banyak pasien daripada kapasitas fisiknya; ID service event yang sama muncul pada dua klaim.",
    guardrail: "Hari dengan bacaan meter < 90 % tidak dihitung sebagai bukti (data tidak lengkap); alat tanpa meter menjadi 'perlu verifikasi', bukan tuduhan. Selisih kecil di bawah toleransi diabaikan.",
    readiness: { level: "demo", label: "Reconciliation klaim vs alat sudah didemokan" },
    demo: { href: "/demo-jkn/audit?tab=iot", label: "IoT alat medis (data fiktif)" },
  },
  {
    id: "inflated",
    name: "Inflated Bills & Cloning",
    agent: "Agen Tagihan · Agen Klinis",
    how: "Obat, bahan habis pakai, atau implan ditagih lebih banyak dari yang dipakai; atau rekam medis disalin antarpasien supaya tampak lengkap (cloning).",
    metric: { reported: "Implan/BMHP pada klaim", reportedValue: 40, measured: "Unit yang terpindai UDI/serial saat dipakai", measuredValue: 26, unit: "unit" },
    signals: [
      { type: "IoT", device: "Smart cabinet obat/BMHP, scanner barcode/RFID", evidence: "Jumlah yang benar-benar dikeluarkan per pasien, dengan timestamp." },
      { type: "IoT", device: "UDI / serial scan implan", evidence: "Satu nomor serial = satu pasien, sekali pakai; ditagih tanpa jejak distribusi langsung terlihat." },
      { type: "IoMT", device: "Infusion pump & patient monitor", evidence: "Volume obat nyata. Tanda vital hasil ukur punya variasi alami; deret yang identik antarpasien = catatan disalin." },
    ],
    anchor: "Serial implan dan batch obat dicatat sekali pada ledger: serial yang ditagih dua kali, atau tanpa riwayat distribusi, terlihat tanpa menunggu audit manual.",
    redFlag: "Jumlah yang ditagih melebihi yang keluar dari cabinet atau terpindai; serial sama pada dua pasien; resume menyebut tren vital yang tidak ada di log monitor.",
    guardrail: "Selisih stok bisa berasal dari pemborosan atau retur: diberi toleransi dan ditandai untuk diverifikasi. Tanda vital yang mirip bisa wajar pada pasien yang stabil.",
    readiness: { level: "integration", label: "Butuh integrasi SIMRS & farmasi" },
  },
  {
    id: "los",
    name: "Prolonged Stay & Readmission",
    agent: "Agen Lama Rawat",
    how: "Pasien ditahan lebih lama dari kebutuhan medis, atau satu episode dipecah menjadi dua rawat inap (readmission) supaya ditagih dua kali.",
    metric: { reported: "Length of stay pada klaim", reportedValue: 9, measured: "Malam hunian bed yang terukur", measuredValue: 5, unit: "hari" },
    signals: [
      { type: "IoT", device: "Bed sensor / RFID wristband", evidence: "Jam masuk dan keluar fisik, hunian per malam." },
      { type: "IoMT", device: "Patient monitor", evidence: "Tanda vital yang stabil berhari-hari sebelum pulang: dasar menelaah apakah rawat lanjutan diperlukan." },
      { type: "IoMT", device: "Wearable remote monitoring pascapulang", evidence: "Apakah ada perburukan sungguhan sebelum 'readmission', atau hanya episode yang dipecah." },
      { type: "IoT", device: "Biometric identity (pseudonim)", evidence: "Menghubungkan episode berjarak dekat ke orang yang sama tanpa membuka identitasnya." },
    ],
    anchor: "Jam masuk-keluar di-anchor, dan riwayat episode per patient token tidak bisa dihapus atau diubah supaya readmission tampak sebagai kasus baru.",
    redFlag: "Hari rawat yang ditagih melebihi hari hunian bed; tanda vital stabil beberapa hari sebelum pulang; episode kedua dalam jangka pendek tanpa lonjakan tanda vital.",
    guardrail: "Pasien yang stabil secara fisiologis tetap bisa perlu dirawat (rehabilitasi, hasil tertunda, faktor sosial). Ini indikasi untuk telaah klinis, bukan vonis.",
    readiness: { level: "integration", label: "Butuh integrasi bed & monitor" },
  },
  {
    id: "referral",
    name: "Referral & Self-referral",
    agent: "Agen Rujukan",
    how: "Pasien dirujuk padahal FKTP mampu menanganinya, atau diarahkan ke fasilitas milik atau terafiliasi dengan dokter perujuk.",
    metric: { reported: "Rujukan beralasan 'alat tidak tersedia'", reportedValue: 18, measured: "Rujukan saat alat FKTP memang mati/tak ada", measuredValue: 3, unit: "rujukan" },
    signals: [
      { type: "IoT", device: "Status alat FKTP (meter, heartbeat, riwayat calibration) + inventaris alat", evidence: "Apakah alat yang dijadikan alasan rujukan sungguh tidak tersedia saat itu." },
      { type: "IoMT", device: "Tele-diagnostic di Puskesmas (EKG, USG, spirometri jarak jauh)", evidence: "Hasil bisa dibaca spesialis tanpa rujukan fisik: rujukan menjadi tidak perlu." },
      { type: "IoT", device: "Check-in QR/NFC di tiap simpul rujukan", evidence: "Rantai FKTP → FKRTL terekam; pola dokter perujuk → fasilitas tujuan bisa dihitung." },
    ],
    anchor: "Referral chain ditulis sebagai transaksi bertanda tangan dokter perujuk; pola perujuk → penerima yang berulang tidak bisa dihapus.",
    redFlag: "Alasan rujukan 'alat/tenaga tidak tersedia' padahal alat FKTP aktif dan terkalibrasi; satu dokter perujuk mengarahkan sebagian besar pasiennya ke satu fasilitas.",
    guardrail: "Alat menyala belum berarti ada tenaga yang kompeten, dan keputusan klinis rujukan tetap hak dokter. Dipakai untuk memilih rujukan yang ditelaah, bukan memblokir.",
    readiness: { level: "research", label: "Research · butuh data status alat FKTP" },
  },
  {
    id: "facility",
    name: "Facility & Regional Pattern",
    agent: "Agen Profil Faskes",
    how: "Satu fasilitas atau wilayah menagih jauh di atas apa yang mungkin dikerjakan secara fisik, atau polanya menyimpang dari faskes sejenis.",
    metric: { reported: "Pemeriksaan CT pada klaim sebulan", reportedValue: 2400, measured: "Batas atas dari jam alat menyala", measuredValue: 1050, unit: "pemeriksaan" },
    signals: [
      { type: "IoT", device: "Power meter & status alat per faskes", evidence: "Jam aktif nyata → batas atas kapasitas fisik (mesin × shift)." },
      { type: "IoT", device: "Inventaris & calibration alat", evidence: "Faskes tanpa alat terdaftar yang tetap menagih tindakannya." },
      { type: "IoT", device: "National network monitor", evidence: "Bandingkan faskes sejenis per kabupaten/kota; penyimpangan wilayah muncul sebagai cluster." },
    ],
    anchor: "Ringkasan kapasitas per faskes per periode di-anchor, sehingga tren tidak bisa dirapikan mundur saat ada audit.",
    redFlag: "Volume klaim melebihi kapasitas fisik; klaim tindakan pada faskes tanpa alat terdaftar; satu faskes menyimpang jauh dari rata-rata jejaringnya.",
    guardrail: "Kapasitas adalah batas atas, bukan perkiraan; pakai toleransi dan bandingkan hanya dengan faskes sejenis (kelas, tipe layanan).",
    readiness: { level: "demo", label: "National network monitor sudah didemokan" },
    demo: { href: "/demo-jkn/audit?tab=nasional", label: "Pantauan nasional (data fiktif)" },
  },
];

/** end-to-end flow */
export const FLOW: { title: string; body: string; color: string }[] = [
  { title: "Devices & sensors", body: "IoT dan IoMT di faskes menghasilkan bacaan dan session log.", color: "#2dd4bf" },
  { title: "Edge gateway", body: "Menandatangani batch, membuang duplikat dan glitch, memseudonimkan identitas.", color: "#38bdf8" },
  { title: "Anchor", body: "Hash batch + timestamp dikunci di ledger sebelum klaim diajukan.", color: "#a78bfa" },
  { title: "Pipeline & Nexus", body: "Bukti bersih direkonsiliasi dengan e-Klaim; menjadi objek device, event, dan finding.", color: "#60a5fa" },
  { title: "Agent swarm", body: "Klinis, Tagihan, Lama Rawat, Rujukan, Profil Faskes membaca bukti terukur.", color: "#f0a843" },
  { title: "Verifikator BPJS", body: "Memutuskan. Bukti dan keputusan ikut di-anchor ke Evidence Ledger.", color: "#34d399" },
];

/** commit-before-claim */
export const ANCHOR_STEPS: [string, string][] = [
  ["Capture", "Gateway menandatangani tiap batch bacaan dengan kunci perangkatnya (idealnya di secure element)."],
  ["Hash chain", "Batch per jam digabung menjadi Merkle root. Hanya hash yang naik; data kesehatan tetap di faskes."],
  ["Anchor", "Merkle root dikirim ke permissioned ledger sebelum klaim diajukan. Timestamp ini yang menjadi bukti urutan."],
  ["Reconcile", "Klaim hanya dicocokkan dengan bukti yang anchor-nya lebih tua dari tanggal klaim."],
  ["Re-verify", "Verifikator atau auditor luar menghitung ulang hash dari log mentah. Cocok = utuh; beda = ada yang diubah."],
];

export const ANCHOR_ITEMS = [
  "Batch log alat (IoT/IoMT) per faskes per jam",
  "Snapshot klaim saat diajukan",
  "Temuan tiap agen beserta evidence (Evidence Ledger)",
  "Keputusan verifikator: dibebaskan, dibina, atau ditindaklanjuti",
];

export const LEDGER_LIMITS: [string, string][] = [
  ["Garbage in, garbage out", "Jika alat atau gateway dimanipulasi, ledger hanya mengunci kebohongan itu dengan rapi (oracle problem). Penangkalnya: tanda tangan perangkat, tamper seal fisik, audit alat, dan cross-check antar sensor (daya, DICOM, tanda vital harus saling cocok)."],
  ["Diagnosis correctness", "Tetap penilaian klinis oleh Agen Klinis dan verifikator."],
  ["Privacy", "Data kesehatan adalah data pribadi spesifik (UU PDP No. 27/2022), dan hak penghapusan tidak cocok dengan rantai yang tak bisa diubah. Karena itu hanya hash dan token pseudonim yang boleh naik ke ledger."],
  ["Governance", "Siapa menjalankan node? Perlu kesepakatan konsorsium (BPJS, Kemenkes, asosiasi RS, auditor) sebelum ledger bersama masuk akal."],
];

/* ---------- ontology (the Nexus) ---------- */

export type OntologyLink = { verb: string; target: string };
export const NEXUS_EXISTING: { name: string; role: string }[] = [
  { name: "Alat Medis IoT JKN", role: "Device: tempat semua sinyal baru menempel (alat → faskes, sudah ada)." },
  { name: "Temuan IoT JKN", role: "Finding per faskes × jenis alat × hari yang tidak cocok dengan klaim." },
  { name: "Tindakan Penunjang Diklaim JKN", role: "Claim line yang direkonsiliasi dengan bukti alat." },
  { name: "Faskes Audit JKN", role: "Facility; juga RS Jejaring IoT JKN untuk pantauan nasional." },
  { name: "Klaim JKN", role: "Claim; di Nexus BPJS-nya adalah Klaim FKRTL (BPJS)." },
  { name: "Dokter Audit JKN · Verifikator JKN", role: "Siapa yang meminta tindakan, dan siapa yang memutuskan." },
];

export const NEXUS_NEW: { name: string; modes: string; holds: string; links: OntologyLink[] }[] = [
  {
    name: "Device Session",
    modes: "Upcoding · Phantom",
    holds: "Satu sesi alat pada satu pasien: mulai, selesai, durasi, volume atau jumlah siklus, hash log mentah.",
    links: [
      { verb: "recorded on", target: "Alat Medis IoT JKN" },
      { verb: "performed at", target: "Faskes Audit JKN" },
      { verb: "reconciled in", target: "Tindakan Penunjang Diklaim JKN" },
    ],
  },
  {
    name: "Bed Stay",
    modes: "Prolonged Stay",
    holds: "Interval hunian bed dari bed sensor atau wristband; dibandingkan dengan length of stay yang ditagih.",
    links: [
      { verb: "occupied at", target: "Faskes Audit JKN" },
      { verb: "compared with", target: "Klaim JKN" },
    ],
  },
  {
    name: "Stock Movement",
    modes: "Inflated Bills · Cloning",
    holds: "Item yang keluar dari smart cabinet atau implan yang terpindai UDI/serial, dengan patient token.",
    links: [
      { verb: "dispensed at", target: "Faskes Audit JKN" },
      { verb: "billed in", target: "Klaim JKN" },
    ],
  },
  {
    name: "Service Event",
    modes: "Repeat Billing · Referral",
    holds: "ID unik (alat + waktu + patient token) yang wajib ditunjuk oleh sebuah claim line; kunci deteksi duplikasi.",
    links: [
      { verb: "evidenced by", target: "Device Session" },
      { verb: "claimed in", target: "Klaim JKN" },
      { verb: "requested by", target: "Dokter Audit JKN" },
    ],
  },
  {
    name: "Evidence Anchor",
    modes: "Semua modus",
    holds: "Merkle root, jendela waktu, signer, anchored_at, referensi ledger. Properti turunan: anchored_at lebih tua dari tanggal klaim?",
    links: [
      { verb: "anchors", target: "Device Session" },
      { verb: "anchors", target: "Temuan IoT JKN" },
      { verb: "reviewed by", target: "Verifikator JKN" },
    ],
  },
];

export const NEXUS_ACTIONS: { name: string; status: "exists" | "proposed"; body: string }[] = [
  { name: "Verify against device log", status: "exists", body: "Verifikator menandai finding IoT terkonfirmasi atau tidak; tercatat di edit history." },
  { name: "Request raw log", status: "proposed", body: "Minta faskes mengirim export mentah (RIS/PACS, sesi HD, log ventilator); file menempel pada finding." },
  { name: "Flag duplicate event", status: "proposed", body: "Dipicu saat satu Service Event muncul pada dua claim line; masuk ke antrian verifikator." },
];

/** the pattern of NVIDIA's Auto Ontology (Discover → Ground → Validate → Expose) applied to new device sources */
export const AUTO_ONTOLOGY: { stage: string; here: string; today: string }[] = [
  {
    stage: "Discover",
    here: "LLM membaca skema export vendor (HD, ventilator, DICOM, smart cabinet) dan mengusulkan object type, property, dan link seperti Device Session.",
    today: "Extraction sudah merancang ontology dari dokumen, dengan kutipan evidence.",
  },
  {
    stage: "Ground",
    here: "Usulan diikat ke kolom nyata dataset bersih di Pipeline Builder; manusia menyetujui mapping-nya di Ontology Manager, pada branch.",
    today: "Pipeline Builder, Ontology Manager, dan branch sudah ada.",
  },
  {
    stage: "Validate",
    here: "Definisi tersertifikasi: toleransi 10 % + 1, meter < 90 % bukan bukti, anchored_at < tanggal klaim. Jawaban agen harus mengutip aturan ini, dengan provenance.",
    today: "Aturan Indikasi dan evidence per temuan sudah ada.",
  },
  {
    stage: "Expose",
    here: "Operator dan agen swarm membaca objek lewat tool. Langkah berikutnya: endpoint MCP, supaya agen eksternal mendapat konteks tertata yang sama.",
    today: "Operator membaca Nexus lewat tool; MCP belum ada.",
  },
];

export const ROADMAP: { name: string; status: string; color: string; items: string[] }[] = [
  {
    name: "Phase 0 · Sudah ada (demo)",
    status: "Berjalan dengan data fiktif",
    color: "#34d399",
    items: [
      "Power meter alat medis → pipeline → reconciliation klaim vs pemakaian alat",
      "Finding IoT sebagai objek Nexus, dengan action verifikasi dan edit history",
      "National network monitor per provinsi dan kabupaten/kota",
      "Evidence Ledger lokal di Swarm",
    ],
  },
  {
    name: "Phase 1 · Perluas sinyal",
    status: "Butuh 1–2 RS mitra",
    color: "#fbbf24",
    items: [
      "Export batch log IoMT: hemodialisis, ventilator, header DICOM",
      "Gateway menandatangani batch; hash chain dan timestamp independen (belum perlu blockchain)",
      "Agen Klinis dan Lama Rawat membaca sinyal baru; ukur presisi lewat pilot teraudit",
    ],
  },
  {
    name: "Phase 2 · Shared anchor",
    status: "Butuh kesepakatan lembaga",
    color: "#a78bfa",
    items: [
      "Permissioned ledger antarpihak untuk Service Event ID yang unik lintas faskes",
      "Cek duplikasi sebelum klaim dibayar lewat smart contract sederhana",
      "Akses auditor luar untuk memverifikasi hash tanpa membuka data pasien",
    ],
  },
];

export const GUARDRAILS: [string, string][] = [
  ["Indication, not verdict", "Sinyal alat memberi alasan untuk memeriksa log asli (RIS/PACS, catatan HD), bukan kesimpulan. Keputusan akhir tetap verifikator BPJS."],
  ["Data minimisation", "Hanya bacaan yang perlu untuk reconciliation. Identitas pasien diganti patient token di gateway, sebelum data keluar dari faskes."],
  ["Consent & ownership", "Data alat milik faskes dan vendornya. Perlu perjanjian pemakaian, dasar hukum pemrosesan, dan penilaian dampak pelindungan data sebelum pilot nyata."],
  ["Sensor reliability", "Data hilang bukan bukti. Hari dengan data tidak lengkap dan alat tanpa meter masuk 'perlu verifikasi', tidak pernah 'finding'."],
  ["Cost & value", "Pasang sensor dulu di modus bernilai tinggi (hemodialisis, imaging, ICU) dan di faskes yang sudah berisiko tinggi, bukan di semua tempat."],
];
