"use client";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { modelName, type Agent, type Rec } from "@/components/aip/aipRun";
import { AGENT_COLOR } from "@/components/aip/AgentGraph";
import { GROUP_COLOR, rp, type FirmAgent } from "@/components/aip/fraudApi";
import { OrgChart } from "@/components/aip/KonsultanView";
import { TanggaBukti } from "@/components/aip/TanggaBukti";
import { API_URL } from "@/lib/api";

/* The AIP JKN fraud system in one picture, left to right: the real data and the production pipeline; the Nexus with its
   semantic layer and the tag ledger; the agents — the domain agents that answer questions, the ML agent with a
   sub-agent per technique, the consultancy firm (a swarm of agents in workstreams) and the machines; and what reaches
   people: the quarantine box, POST /verify for verifiers, the reports, the decisions only people make. Live counts;
   a card opens its tab (the production pipeline and POST /verify have none since their tab left the bar). */

type Go = (tab: string) => void;
// the four flows of the system, each step as its code runs it (adk_runtime/main.py, firm.py, produksi.py, layanan.py)
const WORKFLOWS: [string, string, [string, string][], string][] = [
  ["Tanya-jawab", "#9d8cff", [["Aturan rencana", "per model perencana: kode, atau versi GEPA yang dinyalakan admin (dinilai kode pada 47 pertanyaan berlabel)"],
    ["Orkestrator", "tugas sempit berskill + kontrak validasi, sebelum agen bekerja"], ["Agen kecil", "konteks segar per tugas, objek dan izin agen domainnya; serah-terima"],
    ["Orkestrator menulis", "structuring dari serah-terima, rujukan hasil"], ["Scrutiny (kode)", "rujukan, cakupan, angka bersumber"],
    ["Validator", "keluarga lain: angka ke data + kontrak"], ["Revisi", "sekali bila ada yang tidak bertahan"],
    ["Executive summary", "untuk pimpinan non-teknis; model lain, setiap angka dicek kode terhadap structuring"], ["Pelajaran", "temuan validator → skill"]], "agents"],
  ["AI Agent Swarm", "#d55181", [["Penugasan", "penanda otomatis + rencana & kontrak orkestrator"], ["Kerja lapangan", "analis per provinsi, spesialis modus, peer, teknik ML — paralel, baca-saja"],
    ["Box karantina", "faskes per kelompok kerugian A … Z"], ["Investigasi", "penyidik per faskes prioritas: kertas kerja + rekomendasi jalur"],
    ["Sintesis", "tiap agen domain menyintesis agen kecilnya"], ["QA & red team", "QA per sintesis (keluarga lain); red team"],
    ["Kerangka laporan", "poin per bagian dengan sumbernya; kode membuang poin tanpa sumber atau dengan hasil_id asing"],
    ["Bagian laporan", "tiap bagian ditulis dari sumber poinnya saja, paralel; digabung kode"],
    ["Validator laporan", "angka + kontrak; revisi hanya bagian yang dipersoalkan; tabel box dari data"], ["Scrutiny tiap fase", "kode menutup setiap milestone"]], "konsultan"],
  ["Pipeline produksi", "#29a383", [["Data masuk", "versi klaim Data Bersih"], ["Kontrak data", "18 cek, gerbang"], ["Fitur & drift", "PSI vs referensi"], ["Skoring", "model terpasang, ambang tetap"],
    ["Kinerja", "uji out-of-time saat data berlabel baru"], ["Paket", ".pkl + .onnx, paritas"], ["Penyimpanan fitur", "paritas fitur online = batch"], ["Publikasi", "dataset, Nexus"],
    ["Tag & karantina", "penanda otomatis, box"], ["Deploy", "layanan /verify"]], ""],
  ["POST /verify", "#3987e5", [["Client request", "JSON klaim (format juri atau kontrak lengkap)"], ["Schema validation", "Pydantic v2"], ["Feature engineering", "50 fitur dari penyimpanan fitur"],
    ["ML inference", "model.pkl (CatBoost / LightGBM)"], ["LLM service", "telaah klinis, httpx AsyncClient, gerbang angka, circuit breaker"],
    ["JSON response", "status, fraud_probability, ai_reasoning"]], ""],
];
const LINI: Record<string, string> = { pimpinan: "#9d8cff", wilayah: "#3987e5", modus: "#d95926", peer: "#199e70", ml: "#c98500", kasus: "#d55181", qa: "#8f99a8" };

export function SistemMap({ agents, roles, go }: { agents: Agent[]; roles: Record<string, string>; go: Go }) {
  const [s, setS] = useState<Rec | null>(null);
  const [net, setNet] = useState<Rec | null>(null);
  useEffect(() => {
    fetch(`${API_URL}/api/aip/konsultan/sistem`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then(setS).catch(() => {});
    fetch(`${API_URL}/api/aip/jaringan`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => setNet(j?.ringkasan ?? null)).catch(() => {});
  }, []);
  const domain = agents;
  const ml = agents.find((a) => a.key === "machine_learning");
  const firm = s?.firma as Rec | undefined;
  const firmSize = Number(firm?.agen ?? 0) || null;
  // every agent once (api/aip/jaringan.py): the firm is the same agents at work, not a second set
  const swarmTotal = net?.agen ?? (firmSize ?? 0) + 1;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[#161a1f] p-4 text-[12px] text-[#d3d8de]">
      <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <p className="text-[15px] font-semibold text-white">Peta sistem AIP JKN: deteksi indikasi fraud</p>
          <p className="max-w-[900px] text-[11.5px] text-[#abb3bf]">Dari data klaim nyata sampai keputusan manusia. Agen hanya membaca data dan menulis catatan (tag, laporan, rekomendasi); yang mengubah status klaim atau faskes selalu manusia.</p>
        </div>
        <div className="ml-auto flex gap-5">
          <Num v={String(swarmTotal)} l="agen di seluruh sistem" />
          <Num v={firmSize ? String(firmSize) : "—"} l="agen di penugasan firma terakhir" />
          <Num v={(s?.indikasi?.total ?? 0).toLocaleString("id-ID")} l="indikasi bertag" />
          <Num v={String(s?.karantina?.faskes ?? "—")} l="faskes di box karantina" />
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_auto_1.15fr_auto_1.6fr_auto_1.1fr]">
        {/* 1 data */}
        <Col title="1 · Data & pipeline produksi" icon="database">
          <Card onClick={() => go("pipeline")} color="#738091" title="Data Sampel BPJS Kesehatan 2025" sub="klaim FKRTL nyata, dianonimkan (Data Bersih)">
            <p>{s?.data?.klaim ? `${Number(s.data.klaim).toLocaleString("id-ID")} klaim` : "—"}</p>
          </Card>
          <Arrow label="otomatis: jadwal / data baru" vertical />
          <Card color="#29a383" title="Pipeline produksi" sub="kontrak data → fitur & drift → skor → paket → penyimpanan fitur → publikasi → tag → deploy">
            <p>run terakhir: <b className={s?.pipeline?.status === "lulus" ? "text-[#7ee2c0]" : "text-[#fbd38d]"}>{s?.pipeline?.status ?? "—"}</b></p>
            <p className="text-[#8f99a8]">{(s?.pipeline?.tahap ?? []).length} tahap bergerbang</p>
          </Card>
        </Col>
        <Arrow label="objek Nexus, skor, paket" />
        {/* 2 nexus */}
        <Col title="2 · Nexus & lapisan semantik" icon="cube">
          <Card onClick={() => go("objects")} color="#7961db" title="Objek Nexus" sub="klaim, faskes, wilayah, kode INA-CBG, peserta, rujukan, skor ML">
            <p>{agents.reduce((n, a) => n + a.object_types.length, 0)} tipe objek</p>
          </Card>
          <Card onClick={() => go("konsultan")} color="#b7791f" title="Lapisan semantik" sub="ukuran, dimensi, istilah, taksonomi tag (Permenkes 16/2019): satu definisi untuk semua agen" />
          <Card onClick={() => go("karantina")} color="#c0392b" title="Buku besar indikasi" sub="satu tag per objek × modus; kekuatan dihitung dari sumbernya; marking Internal / Rahasia per baris">
            <p>{(s?.indikasi?.kuat ?? 0).toLocaleString("id-ID")} kuat · {(s?.indikasi?.sedang ?? 0).toLocaleString("id-ID")} sedang · {(s?.indikasi?.lemah ?? 0).toLocaleString("id-ID")} lemah</p>
          </Card>
        </Col>
        <Arrow label="dibaca lewat tool; tag ditulis" />
        {/* 3 agents */}
        <Col title="3 · Agen" icon="sparkle">
          <Card onClick={() => go("agents")} color="#9d8cff" title="Tanya-jawab: orkestrator + agen domain" sub={`setiap agen memegang objek Nexus-nya; orkestrator ${modelName(roles.writer)} menulis → scrutiny (kode) → validator ${modelName(roles.validator)} (keluarga lain)`}>
            <div className="mt-1 flex flex-wrap gap-1">{domain.map((a, i) => <span key={a.key} className="rounded px-1.5 py-0.5 text-[10.5px] text-white" style={{ background: `${AGENT_COLOR[i % AGENT_COLOR.length]}cc` }}>{a.name.replace(" (BPJS)", "").replace("Agen ", "")}</span>)}</div>
            {net?.aturan_rencana && <p className="mt-1 text-[10.5px] text-[#8f99a8]">aturan rencana: {String(net.aturan_rencana)}</p>}
          </Card>
          {ml && (
            <Card onClick={() => go("ml")} color="#c98500" title="Agen Machine Learning + sub-agen teknik" sub="benchmark lintas teknik (validasi silang per faskes, uji berpasangan terkoreksi), model terpilih dikemas model.pkl">
              <div className="mt-1 flex flex-wrap gap-1">{(ml.subagents ?? []).map((x) => <span key={x.key} className="rounded border border-[#c98500]/50 px-1 text-[10px] text-[#f5d9a8]">{x.technique}</span>)}</div>
            </Card>
          )}
          <Card onClick={() => go("konsultan")} color="#d55181" title={`AI Agent Swarm: ${firmSize ? `${firmSize} agen` : "agen"}`} sub="orkestrator (partner) → agen domain → agen kecilnya: analis per provinsi, spesialis modus, analis peer, sub-agen teknik ML, penyidik kasus; validator → QA dan red team">
            <div className="mt-1 flex flex-wrap gap-1">
              {((firm?.ukuran ?? []) as Rec[]).map((w) => (
                <span key={w.lini} title={w.alasan} className="flex items-center gap-1 rounded bg-white/[.05] px-1.5 py-0.5 text-[10.5px]"><span className="h-2 w-2 rounded-full" style={{ background: LINI[w.lini] }} />{w.lini} {w.agen}</span>
              ))}
              {!firm?.ukuran && <span className="text-[10.5px] text-[#8f99a8]">penugasan pertama: 100 agen (34 menit, 367 tag)</span>}
            </div>
            <p className="mt-1 text-[10.5px] text-[#8f99a8]">{s?.penugasan ?? 0} penugasan · mesin deterministik: penanda otomatis, konsensus teknik ML, box karantina · laporan: kerangka dulu, tiap bagian dari sumbernya</p>
          </Card>
        </Col>
        <Arrow label="rekomendasi, bukan keputusan" />
        {/* 4 people */}
        <Col title="4 · Untuk verifikator & auditor" icon="eye">
          <Card onClick={() => go("karantina")} color="#e5484d" title="Box karantina → audit" sub="kelompok A (kerugian terbesar) … Z; TSM; dibina / ditindak (hanya bila Terstruktur, Sistematis, Masif) / dibebaskan">
            <div className="mt-1 flex gap-1">{["A", "B", "C", "D", "Z"].map((g) => {
              const v = s?.karantina?.kelompok?.[g];
              return v ? <span key={g} title={rp(v.kerugian_rp)} className="rounded px-1.5 text-[10.5px] font-semibold text-black" style={{ background: GROUP_COLOR[g] }}>{g} {v.faskes}</span> : null;
            })}</div>
          </Card>
          <Card color="#29a383" title="POST /verify" sub="klaim → validasi → fitur → model.pkl → telaah klinis LLM → {status, fraud_probability, ai_reasoning}">
            <p className="text-[#8f99a8]">{s?.model?.segmen ? Object.entries(s.model.segmen as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join(" · ") : "—"}</p>
          </Card>
          <Card onClick={() => go("karantina")} color="#9d8cff" title="Keputusan manusia" sub="konfirmasi tag, jalur audit, menyalakan pelajaran skill dan aturan rencana (admin): gerbang yang tidak pernah dilewati agen">
            <p className="text-[#8f99a8]">{s?.karantina?.per_status ? Object.entries(s.karantina.per_status as Record<string, number>).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(" · ") : ""}</p>
          </Card>
        </Col>
      </div>

      {firm?.tim && (
        <div className="mt-4 rounded border border-white/10 bg-[#1c2127] p-3">
          <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
            <p className="font-semibold text-white">AI Agent Swarm: {String(firm.agen)} agen pada penugasan {String(firm.run)}</p>
            <span className="text-[11px] text-[#8f99a8]">setiap titik satu agen dengan perannya sendiri; garis = siapa melapor ke siapa; belah ketupat = mesin deterministik</span>
            <button onClick={() => go("konsultan")} className="ml-auto rounded border border-white/15 px-2 py-0.5 text-[11px] hover:bg-white/10">Lihat kerja tiap agen →</button>
          </div>
          <OrgChart roster={firm.tim as FirmAgent[]} states={{}} focus={null} onFocus={() => go("konsultan")} machines={[]} />
        </div>
      )}

      <div className="mt-4 rounded border border-white/10 bg-[#1c2127] p-3">
        <p className="mb-2 font-semibold text-white">Alur kerja</p>
        {WORKFLOWS.map(([name, color, steps, tab]) => (
          <div key={name} className="mb-2 flex flex-wrap items-center gap-1.5 border-t border-white/5 pt-2 text-[11px]">
            {tab ? <button onClick={() => go(tab)} className="w-[170px] shrink-0 text-left font-semibold" style={{ color }}>{name}</button>
              : <span className="w-[170px] shrink-0 font-semibold" style={{ color }}>{name}</span>}
            {steps.map(([t, d], i) => (
              <div key={t} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-[#4b5563]">→</span>}
                <div className="rounded border bg-black/20 px-2 py-1" style={{ borderColor: `${color}55` }} title={d}><p className="font-medium text-[#e5e8eb]">{t}</p><p className="max-w-[150px] truncate text-[10px] text-[#8f99a8]">{d}</p></div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="mt-4"><TanggaBukti pilot={false} /></div>

      <div className="mt-4 rounded border border-white/10 bg-[#1c2127] p-3">
        <p className="mb-2 font-semibold text-white">Alur sebuah indikasi</p>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {[["Sinyal di data", "aturan semantik, model, agen"], ["Tag (indikasi)", "bukti = hasil yang dibaca"], ["Box karantina", "kelompok kerugian A … Z"], ["Audit", "penyidik AI + auditor"],
            ["Dibina", "salah sistem / kelola: diperbaiki, kelebihan bayar kembali"], ["Ditindak", "TSM: Tim PK-JKN & penegak hukum"], ["Dibebaskan", "tidak terbukti"]].map(([t, d], i) => (
            <div key={t} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-[#4b5563]">{i >= 5 ? "|" : "→"}</span>}
              <div className="rounded border border-white/10 bg-black/20 px-2 py-1"><p className="font-medium text-[#e5e8eb]">{t}</p><p className="text-[10px] text-[#8f99a8]">{d}</p></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Num({ v, l }: { v: string; l: string }) {
  return <div className="text-right"><p className="text-[20px] font-semibold tabular-nums text-white">{v}</p><p className="text-[10.5px] text-[#8f99a8]">{l}</p></div>;
}

function Col({ title, icon, children }: { title: string; icon: IconName; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#8f99a8]"><Icon name={icon} className="h-3.5 w-3.5" />{title}</p>
      {children}
    </div>
  );
}

function Card({ title, sub, color, children, onClick }: { title: string; sub?: string; color: string; children?: React.ReactNode; onClick?: () => void }) {
  const body = (<>
    <p className="font-semibold text-white">{title}</p>
    {sub && <p className="mt-0.5 text-[10.5px] leading-snug text-[#abb3bf]">{sub}</p>}
    {children && <div className="mt-1 text-[11px]">{children}</div>}
  </>);
  // a card without a tab to open is not a button
  return onClick
    ? <button onClick={onClick} className="rounded border border-white/10 bg-[#1c2127] p-2.5 text-left hover:border-white/25 hover:bg-[#222831]" style={{ borderLeft: `3px solid ${color}` }}>{body}</button>
    : <div className="rounded border border-white/10 bg-[#1c2127] p-2.5" style={{ borderLeft: `3px solid ${color}` }}>{body}</div>;
}

function Arrow({ label, vertical = false }: { label: string; vertical?: boolean }) {
  return vertical
    ? <div className="flex items-center gap-1 pl-3 text-[10px] text-[#6b7480]"><span>↓</span>{label}</div>
    : <div className="flex items-center justify-center max-xl:hidden"><div className="flex flex-col items-center text-[10px] text-[#6b7480]"><span className="text-[18px] leading-none">→</span><span className="w-[70px] text-center leading-tight">{label}</span></div></div>;
}
