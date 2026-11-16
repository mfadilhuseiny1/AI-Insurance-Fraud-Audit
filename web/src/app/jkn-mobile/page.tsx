import Link from "next/link";

/* Launcher of the three JKN mobile PWAs (demo). Each opens as its own app and can be installed on Android from
   Chrome (⋮ → Install app / Add to Home screen). */
const APPS = [
  { href: "/jkn-mobile/petugas", icon: "/jkn-mobile/petugas-192.png", name: "JKN Petugas", who: "Petugas verifikasi BPJS", what: "Antrian skrining pre-payment dengan alasan skor, laporan peserta, berkas masuk, kunjungan audit (foto + GPS), tanya agen GenAI." },
  { href: "/jkn-mobile/rs", icon: "/jkn-mobile/rs-192.png", name: "JKN Rumah Sakit", who: "Rumah sakit / faskes", what: "Status klaim dan alasan ditahan, jawab permintaan berkas dengan kamera, cek klaim sebelum kirim, skor kepatuhan." },
  { href: "/jkn-mobile/peserta", icon: "/jkn-mobile/peserta-192.png", name: "JKN Peserta", who: "Peserta JKN", what: "Kartu digital, layanan yang ditagihkan atas nama saya, tombol “Saya tidak menerima layanan ini”, faskes terdekat." },
];

export default function JknMobileLauncher() {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-[#f4f6f8] text-[#1c2127]">
      <div className="mx-auto max-w-[560px] px-4 py-6">
        <h1 className="text-[22px] font-bold">JKN Mobile</h1>
        <p className="mt-1 text-[14px] text-[#5f6b7c]">Tiga aplikasi Android (PWA) di atas satu data: laporan peserta masuk ke petugas, permintaan petugas masuk ke rumah sakit, berkas rumah sakit kembali ke petugas.</p>
        <div className="mt-5 space-y-3">
          {APPS.map((a) => (
            <Link key={a.href} href={a.href} className="flex gap-3.5 rounded-2xl border border-[#e3e7ec] bg-white p-4 shadow-sm active:bg-[#f0f3f6]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.icon} alt="" className="h-14 w-14 shrink-0 rounded-2xl" />
              <span className="min-w-0"><span className="block text-[16px] font-semibold">{a.name}</span><span className="block text-[12.5px] font-medium text-[#5f6b7c]">{a.who}</span><span className="mt-1 block text-[13px] leading-snug text-[#4a5563]">{a.what}</span></span>
            </Link>
          ))}
        </div>
        <div className="mt-6 rounded-2xl bg-white p-4 text-[13px] leading-relaxed text-[#4a5563] ring-1 ring-[#e3e7ec]">
          <p className="font-semibold text-[#1c2127]">Pasang di HP Android</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5"><li>Buka aplikasinya di Chrome.</li><li>Tekan tombol <b>Install</b> di kanan atas aplikasi, atau menu ⋮ → <b>Instal aplikasi</b>.</li><li>Ikonnya muncul di layar utama dan terbuka layar penuh seperti aplikasi biasa.</li></ol>
          <p className="mt-2 text-[12px] text-[#738091]">Chrome hanya mengizinkan install dari alamat HTTPS (atau localhost).</p>
        </div>
        <p className="mt-6 text-center text-[11px] text-[#8a95a3]">Data demo fiktif · BluesandAI</p>
      </div>
    </main>
  );
}
