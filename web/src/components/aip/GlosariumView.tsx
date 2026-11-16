"use client";
import { useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { GLOSARIUM, KATEGORI_GLOSARIUM, type KategoriGlosarium } from "@/components/aip/glosarium";
import { Modal } from "@/components/pipeline/Modal";

/* Glosarium AIP JKN: istilah dataset Data Sampel BPJS (glosarium.ts) agar user non-teknis paham makna kolom dan
   tag yang mereka lihat di dataset, pipeline, dan hasil analisis. Cari bebas (istilah/alias/arti) + saring kategori.
   Dibuka sebagai dialog: dari tombol di sebelah Data dictionary (Pipeline Builder). */

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ");

export function GlosariumDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Glosarium Dataset JKN" icon="doc" onClose={onClose} xl>
      <GlosariumView />
    </Modal>
  );
}

function GlosariumView() {
  const [q, setQ] = useState("");
  const [kat, setKat] = useState<KategoriGlosarium | "">("");
  const hasil = useMemo(() => {
    const query = norm(q).trim();
    return GLOSARIUM.filter((g) => (!kat || g.kategori === kat) &&
      (!query || norm([g.istilah, ...(g.alias ?? []), g.arti, g.contoh ?? "", g.catatan ?? "", g.sumber ?? ""].join(" ")).includes(query)));
  }, [q, kat]);
  const perKat = useMemo(() => {
    const m = new Map<string, number>();
    hasil.forEach((g) => m.set(g.kategori, (m.get(g.kategori) ?? 0) + 1));
    return m;
  }, [hasil]);

  return (
    <div className="flex flex-col text-[12px]">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/5 bg-[#1c2127] px-4 py-2">
        <span className="text-[#abb3bf]">{GLOSARIUM.length} istilah Data Sampel BPJS Edisi 2025 — kapitasi, FKRTL, INA-CBG, LOS, tag indikasi, sampai skor ML</span>
        <span className="ml-auto text-[11px] text-[#8f99a8]">Sumber: katalog kolom Data Bersih, Pipeline Builder (Data Mentah → Siap Analisis) &amp; lapisan semantik agen</span>
      </div>

      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="relative min-w-[240px] flex-1 sm:max-w-sm">
            <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8f99a8]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari istilah… coba: kapitasi, FKRTL, LOS, upcoding, biaya_tagih_rp"
              className="w-full rounded-sm border border-white/15 bg-[#111418] py-1.5 pl-7 pr-2 text-[12px] text-[#e5e8eb] outline-none placeholder:text-[#8f99a8] focus:border-[#8abbff]/60" />
          </label>
          <button onClick={() => setKat("")} className={`rounded border px-2 py-1 ${kat === "" ? "border-[#8abbff]/70 bg-white/[.07] text-white" : "border-white/15 text-[#d3d8de] hover:bg-white/5"}`}>Semua ({GLOSARIUM.length})</button>
          {KATEGORI_GLOSARIUM.map((k) => (
            <button key={k} onClick={() => setKat(kat === k ? "" : k)}
              className={`rounded border px-2 py-1 ${kat === k ? "border-[#8abbff]/70 bg-white/[.07] text-white" : "border-white/15 text-[#d3d8de] hover:bg-white/5"}`}>{k}</button>
          ))}
          {(q || kat) && <span className="text-[11px] text-[#8f99a8]">{hasil.length} istilah cocok</span>}
        </div>

        <p className="rounded border border-white/10 bg-[#1c2127] px-3 py-2 text-[11.5px] leading-relaxed text-[#c5cbd3]">
          Cara membaca: nama kolom di dataset sudah diganti jadi bahasa jelas di tahap <b className="text-white">Data Bersih</b> (mis. <code className="font-mono text-[11px] text-[#c9c0ff]">FKL47 → biaya_tagih_rp</code>);
          kode aslinya tetap dicatat di tiap istilah. Ingat: <b className="text-white">indikasi/tag adalah sinyal untuk diperiksa, bukan fraud terbukti</b> — label nyata di data hanyalah “dikoreksi verifikator”.
        </p>

        {KATEGORI_GLOSARIUM.filter((k) => !kat || kat === k).map((k) => {
          const rows = hasil.filter((g) => g.kategori === k);
          if (!rows.length) return null;
          return (
            <section key={k} className="rounded border border-white/10 bg-[#1c2127] p-3">
              <p className="mb-2 font-semibold text-white">{k} <span className="font-normal text-[#8f99a8]">· {perKat.get(k) ?? 0}</span></p>
              <dl>
                {rows.map((g) => (
                  <div key={g.istilah} className="grid gap-x-4 gap-y-0.5 border-t border-white/5 py-2 first:border-t-0 sm:grid-cols-[260px_1fr]">
                    <dt className="min-w-0">
                      <span className="break-words font-medium text-[#e5e8eb]">{g.istilah}</span>
                      {g.alias?.length ? <span className="block break-words text-[10.5px] text-[#8f99a8]">alias: {g.alias.join(" · ")}</span> : null}
                      {g.sumber ? <span className="mt-0.5 block break-words font-mono text-[9.5px] leading-snug text-[#6b7586]">{g.sumber}</span> : null}
                    </dt>
                    <dd className="min-w-0 text-[11.5px] leading-relaxed text-[#c5cbd3]">
                      <span>{g.arti}</span>
                      {g.contoh ? <span className="mt-0.5 block text-[#abb3bf]"><span className="text-[#8f99a8]">Contoh: </span>{g.contoh}</span> : null}
                      {g.catatan ? <span className="mt-0.5 block text-[#fbd38d]"><span>Catatan: </span>{g.catatan}</span> : null}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
        {!hasil.length && (
          <p className="rounded border border-white/10 bg-[#1c2127] px-3 py-6 text-center text-[#8f99a8]">
            Tidak ada istilah cocok untuk “{q}”. Coba kata lain: kapitasi, FKTP, INA-CBG, selisih, readmisi, peer…
          </p>
        )}
      </div>
    </div>
  );
}
