"use client";
/** Drilling an audit answer down to the facility: a row of the cockpit (a province, kab/kota, code, diagnosis, mode or
 *  facility) opens the audit pack of that narrower scope — the consultancy's report read at another page, by code, in a
 *  second or two, no agent analysing again (the user, 2026-10-24: "the report is general first but can be drilled to
 *  detail faskes level information"). Each part of the drawer drills further; the breadcrumb goes back up. */
import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api";
import { Icon } from "@/components/Icon";
import type { Rec } from "./aipRun";
import { BarRank, ChartCard, DataTable, TrendLine } from "./viz";

export type Scope = Record<string, unknown>;
type Part = { kunci: string; judul: string; jenis: string; kelompok?: string; baris: Rec[] };
type Pack = {
  cakupan: Rec & { teks: string }; bagian: Part[]; catatan: string[];
  konsultan?: { run?: string; pada?: string; laporan_analis?: { agen: string; laporan: string }[]; rekomendasi_jalur?: Rec[]; bagian_laporan?: { bagian: string; teks: string }[] };
};

const without = (s: Scope, keys: string[]) => Object.fromEntries(Object.entries(s).filter(([k]) => !keys.includes(k)));

/** The narrower scope a row leads to, inside the scope it came from; null when the row is not a place to go (a month). */
export function drillOf(kelompok: string | undefined, row: Rec, parent: Scope): Scope | null {
  if (row.faskes_profil_id) return { ...without(parent, ["provinsi", "kabkota", "faskes"]), faskes: String(row.faskes_profil_id) };
  const name = String(row.nama ?? row.group ?? "");
  if (!name) return null;
  switch (kelompok) {
    case "provinsi_kode": return { ...without(parent, ["provinsi", "kabkota"]), provinsi: name };
    case "kabkota_kode": return { ...parent, kabkota: name };
    case "inacbg_kode": return { ...parent, inacbg_kode: String(row.group) };
    case "dx_primer_nama": return { ...parent, diagnosis: String(row.group) };
    case "jenis_indikasi": return { ...parent, modus: String(row.group) };
    default: return null;
  }
}

async function readPack(scope: Scope): Promise<Pack> {
  const r = await fetch(`${API_URL}/api/aip/karantina/paket`, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(scope) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `${r.status}`);
  return r.json();
}

const RP = (v: unknown) => `Rp ${Math.round(Number(v ?? 0)).toLocaleString("id-ID")}`;
const N = (v: unknown) => Number(v ?? 0).toLocaleString("id-ID", { maximumFractionDigits: 1 });

function Kpis({ k }: { k: Rec }) {
  const items: [string, string, string?][] = [
    ["Klaim berisiko", N(k.klaim), `${N(k.porsi_nasional_pct)}% nasional`],
    ["Estimasi kerugian", RP(k.estimasi_kerugian_rp), `${N(k.porsi_kerugian_nasional_pct)}% nasional`],
    ["Sudah dikoreksi verifikator", RP(k.sudah_dikoreksi_rp), `${N(k.klaim_dikoreksi)} klaim · ${N(k.rasio_koreksi_pct)}% tagihan`],
    ["Faskes", N(k.faskes), `${N(k.faskes_di_karantina)} di Box Karantina`],
    ["LOS ekstrem", N(k.klaim_los_ekstrem)], ["Readmisi 30 hari", N(k.klaim_readmisi_30)], ["Calon klaim ganda", N(k.klaim_calon_ganda)],
    ...(k.peringkat_provinsi ? [["Peringkat provinsi", `${k.peringkat_provinsi} dari ${k.jumlah_provinsi}`, `${N(k.kali_rata_provinsi)}× rata-rata`] as [string, string, string]] : []),
  ];
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-white/[.07] bg-white/[.06] sm:grid-cols-4">
      {items.map(([label, value, note]) => (
        <div key={label} className="bg-[#1c2127] px-3 py-2.5">
          <p className="text-[10.5px] text-[#abb3bf]">{label}</p>
          <p className="mt-0.5 text-[16px] font-semibold tabular-nums text-white">{value}</p>
          {note && <p className="text-[10.5px] text-[#8f99a8]">{note}</p>}
        </div>
      ))}
    </div>
  );
}

/** One page of the report: a scope's pack, every ranking and list a way further down */
function PackPage({ pack, scope, go }: { pack: Pack; scope: Scope; go: (s: Scope, label: string) => void }) {
  const part = (k: string) => pack.bagian.find((b) => b.kunci === k);
  const k = part("ringkasan")?.baris[0] ?? {};
  const drillable = (p: Part) => (r: Rec) => { const s = drillOf(p.kelompok, r, scope); if (s) go(s, String(r.nama ?? r.group ?? r.faskes_profil_id)); };
  const firm = pack.konsultan ?? {};
  const one = scope.faskes ? part("faskes")?.baris[0] : undefined;  // a facility's own card from the box
  return (
    <div className="space-y-3">
      <Kpis k={k} />
      {one && (
        <section className="rounded-lg border border-[#f0b14c]/30 bg-[#f0b14c]/5 p-3 text-[12px] text-[#e5e8eb]">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#f6c86b]">Box Karantina</p>
          <p className="mt-1">Kelompok <b>{String(one.kelompok_karantina)}</b> · status {String(one.status)} · jalur awal {String(one.jalur_awal)} · TSM {String(one.tsm)}</p>
          <p className="mt-0.5 text-[#c5cbd3]">Estimasi kerugian faskes {RP(one.estimasi_kerugian_faskes_rp)} · modus: {String(one.modus_faskes)}</p>
        </section>
      )}
      {(firm.rekomendasi_jalur ?? []).length > 0 && (
        <section className="rounded-lg border border-white/[.07] bg-[#1c2127] p-3 text-[12px]">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#8f99a8]">Rekomendasi penyidik AI Agent Swarm</p>
          {(firm.rekomendasi_jalur ?? []).map((x, i) => (
            <p key={i} className="mt-1 leading-relaxed text-[#d3d8de]"><b className="text-white">{String(x.faskes)}</b> — jalur <b>{String(x.jalur)}</b> (kelompok {String(x.kelompok)}; {String(x.tsm)}): {String(x.alasan)}</p>
          ))}
        </section>
      )}
      {(firm.laporan_analis ?? []).map((x) => (
        <details key={x.agen} className="rounded-lg border border-white/[.07] bg-[#1c2127] p-3 text-[12px]">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-[#8f99a8]">Laporan analis AI Agent Swarm · {x.agen}</summary>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed text-[#d3d8de]">{x.laporan}</p>
        </details>
      ))}
      {(["wilayah", "kode", "diagnosis", "modus", "kelas"] as const).map((key) => {
        const p = part(key);
        if (!p || p.baris.length === 0) return null;
        const go1 = drillable(p);
        const can = p.kelompok && drillOf(p.kelompok, p.baris[0], scope) !== null;
        return (
          <ChartCard key={key} title={p.judul} insight={can ? "Klik baris untuk rincian cakupan itu." : undefined}
            table={<DataTable rows={p.baris} fields={["nama", "group", "value", "estimasi_kerugian_rp", "sudah_dikoreksi_rp", "rasio_koreksi_pct", "indikasi_utama", "per_1000_klaim"].filter((f) => p.baris.some((r) => r[f] !== undefined))} onRow={can ? go1 : undefined} />}>
            <BarRank rows={p.baris} label={p.baris.some((r) => r.nama) ? "nama" : "group"} value={key === "kelas" ? "per_1000_klaim" : "value"} onPick={can ? go1 : undefined} />
          </ChartCard>
        );
      })}
      {part("tren") && (part("tren")?.baris.length ?? 0) > 1 && (
        <ChartCard title="Per bulan"><TrendLine rows={part("tren")!.baris} x="group" value="value" /></ChartCard>
      )}
      {part("faskes") && !scope.faskes && (
        <ChartCard title={part("faskes")!.judul} insight="Klik faskes untuk rinciannya: Box Karantina, rekomendasi, klaim.">
          <DataTable rows={part("faskes")!.baris} fields={["prioritas", "nama", "kabkota", "kelompok_karantina", "status", "value", "estimasi_kerugian_rp", "sudah_dikoreksi_rp", "readmisi_30_pct", "indikasi_utama"]}
            onRow={drillable(part("faskes")!)} />
        </ChartCard>
      )}
      {(part("kontributor")?.baris.length ?? 0) > 0 && (
        <ChartCard title={part("kontributor")!.judul}>
          <DataTable rows={part("kontributor")!.baris} fields={["klaim_id", "faskes", "inacbg_kode", "dx_primer_nama", "los_hari", "biaya_verifikasi_rp", "peer_biaya_p50_rp", "estimasi_kerugian_rp", "indikasi"]} />
        </ChartCard>
      )}
      <ul className="space-y-0.5 text-[10.5px] text-[#8f99a8]">{pack.catatan.map((c) => <li key={c}>· {c}</li>)}</ul>
      {firm.run && <p className="text-[10.5px] text-[#6b7480]">Temuan dari penugasan AI Agent Swarm {firm.run}; angka dihitung kode dari tag, Box Karantina dan klaim berisiko.</p>}
    </div>
  );
}

/** The drawer: the scope stack (the answer's scope at the bottom), each step a page of the report */
export function AuditDrill({ path, onClose }: { path: { scope: Scope; label: string }[]; onClose: () => void }) {
  const [stack, setStack] = useState(path);
  const [pack, setPack] = useState<Pack | null>(null);
  const [err, setErr] = useState("");
  const top = stack[stack.length - 1];
  useEffect(() => {
    let on = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new page loads
    setPack(null); setErr("");
    readPack(top.scope).then((p) => { if (on) setPack(p); }).catch((e) => { if (on) setErr((e as Error).message); });
    return () => { on = false; };
  }, [top]);
  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-[min(820px,100%)] flex-col border-l border-black/40 bg-[#20262d] shadow-2xl">
      <div className="flex items-start gap-2 border-b border-white/[.06] px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Rincian dari laporan AI Agent Swarm</p>
          <nav className="mt-0.5 flex flex-wrap items-center gap-1 text-[13px]">
            {stack.map((s, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-[#6b7480]">›</span>}
                <button onClick={() => setStack(stack.slice(0, i + 1))} disabled={i === stack.length - 1}
                  className={i === stack.length - 1 ? "font-semibold text-white" : "text-[#8abbff] hover:underline"}>{s.label}</button>
              </span>
            ))}
          </nav>
          {pack && <p className="mt-0.5 text-[11px] text-[#abb3bf]">{pack.cakupan.teks}</p>}
        </div>
        <button onClick={onClose} className="rounded p-1 text-[#abb3bf] hover:bg-white/10 hover:text-white" aria-label="Tutup"><Icon name="x" className="h-4 w-4" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {err ? <p className="text-[12px] text-red-300">{err}</p>
          : pack ? <PackPage pack={pack} scope={top.scope} go={(scope, label) => setStack([...stack, { scope, label }])} />
          : <p className="text-[12px] text-[#8f99a8]">Membaca laporan…</p>}
      </div>
    </div>
  );
}
