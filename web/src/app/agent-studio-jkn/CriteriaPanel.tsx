"use client";
import { Icon, type IconName } from "@/components/Icon";
import { rp, type Live } from "./liveData";

/* The Healthkathon judging criteria, each with the live evidence in this demo and a button that shows it.
   Numbers come from the JKN demo API (fictitious data); "—" when a service did not answer. */
export type CritKey = "kreativitas" | "bisnis" | "dampak" | "presentasi" | "kesiapan";
export const CRIT_LABEL: Record<CritKey, string> = { kreativitas: "Kreativitas & Keunikan", bisnis: "Model Bisnis", dampak: "Dampak", presentasi: "Presentasi & Komunikasi", kesiapan: "Kesiapan Produk" };

export function CriteriaPanel({ live, onRun, onClose }: { live: Live; onRun: (what: string) => void; onClose: () => void }) {
  const k = live.overview?.kpi ?? {};
  const q = live.queue?.ringkasan ?? {};
  const rules = live.rules?.rules ?? [];
  const conns = live.rules?.connectors ?? [];
  const fp = (live.metrics?.aturan_registry ?? []) as { id: string; fp_rate_statis: number }[];
  const fpMax = fp.length ? Math.max(...fp.map((r) => r.fp_rate_statis)) : null;
  const b = live.bench ?? {};
  const cards: { key: CritKey; icon: IconName; points: string[]; actions: [string, string][] }[] = [
    { key: "kreativitas", icon: "sparkle", points: [
      "Agen GenAI menjawab dari graf Nexus dengan sitasi ke objek (RAG Orbis), bukan teks bebas",
      "Skor risiko explainable: kontribusi per faktor + peer benchmark spesialisasi × prosedur",
      "Agen membangun pipeline sendiri — dataset telemetri IoT + transform AI, menunggu persetujuan",
    ], actions: [["Tanya agen (GenAI)", "Faskes mana yang paling berisiko dan kenapa?"], ["Agen bangun pipeline", "tambah data telemetri IoT"]] },
    { key: "bisnis", icon: "layers", points: [
      `${rules.length || "—"} aturan berversi dan ${conns.length || "—"} konektor dipakai ulang di semua kantor cabang`,
      "Satu platform, data per wilayah: tiap akun hanya melihat yang menjadi haknya (marking)",
      "Stack open source — tanpa lisensi per pengguna, skala nasional dengan biaya infrastruktur saja",
    ], actions: [["Lihat akses per akun", "lihat lineage dan akses data"]] },
    { key: "dampak", icon: "gauge", points: [
      `Estimasi kerugian terdeteksi ${rp(k.estimasi_kerugian_rp)} dari ${k.klaim_terflag ?? "—"} / ${k.total_klaim ?? "—"} klaim terflag`,
      `${k.kasus_investigasi ?? "—"} kasus investigasi otomatis · ${k.jaringan_kolusi ?? "—"} jaringan kolusi terdeteksi`,
      `Pre-payment: ${q.hold ?? "—"} ditahan · ${q.review ?? "—"} review · ${q.otomatis ?? "—"} bayar otomatis — dicegah sebelum dibayar`,
    ], actions: [["Jalankan skrining pre-payment", "skrining pre-payment klaim belum dibayar"]] },
    { key: "presentasi", icon: "play", points: [
      "Demo otomatis ±2 menit: rencana → pipeline → skrining → aplikasi audit → lineage & akses",
      "Setiap langkah agen terlihat (Search · Builder · Operator · Workshop) dan tercatat di log",
    ], actions: [["▶ Mulai demo otomatis", "__autoplay"]] },
    { key: "kesiapan", icon: "check", points: [
      `Latensi skrining p95 ${b.p95_ms ?? "—"} ms (target ${b.target_p95_ms ?? 300} ms) ${b.lolos_target ? "✓ lolos" : ""}`,
      "Keputusan berisiko perlu persetujuan manusia; semua tercatat di decision log + audit trail",
      `Rate limit + idempotency di API skrining · false-positive per aturan dipantau (maks ${fpMax == null ? "—" : Math.round(fpMax * 100) + "%"})`,
    ], actions: [["Buka aplikasi audit", "buat aplikasi audit"]] },
  ];
  return (
    <aside className="absolute right-3 top-3 z-30 flex max-h-[calc(100%-1.5rem)] w-[380px] flex-col overflow-hidden rounded-md border border-[#383e47] bg-[#1c2127]/97 shadow-2xl max-sm:left-3 max-sm:w-auto">
      <div className="flex items-center gap-2 border-b border-black/30 px-3 py-2.5">
        <Icon name="star" className="h-4 w-4 text-[#f0b14c]" /><p className="text-[13px] font-semibold">Kriteria Penilaian Healthkathon</p>
        <button onClick={onClose} aria-label="Tutup" className="ml-auto text-[#8f99a8] hover:text-white"><Icon name="x" className="h-4 w-4" /></button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
        {cards.map((c) => (
          <section key={c.key} className="rounded border border-[#383e47] bg-[#111418] p-2.5">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-white"><Icon name={c.icon} className="h-3.5 w-3.5 text-[#9d8cf5]" />{CRIT_LABEL[c.key]}</p>
            <ul className="mt-1.5 space-y-1">{c.points.map((p) => <li key={p} className="flex gap-1.5 text-[11px] leading-snug text-[#c5cbd3]"><span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-[#72ca9b]" />{p}</li>)}</ul>
            <div className="mt-2 flex flex-wrap gap-1.5">{c.actions.map(([label, what]) => <button key={label} onClick={() => onRun(what)} className="rounded-sm bg-[#5b5fd6] px-2 py-1 text-[11px] font-medium text-white hover:bg-[#6a6ee0]">{label}</button>)}</div>
          </section>
        ))}
      </div>
      <p className="border-t border-black/30 px-3 py-1.5 text-[10px] text-[#8f99a8]">Angka langsung dari API demo JKN · data fiktif</p>
    </aside>
  );
}
