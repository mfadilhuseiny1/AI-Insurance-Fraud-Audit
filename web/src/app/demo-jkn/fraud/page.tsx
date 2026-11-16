"use client";

import { Suspense, useEffect, useState } from "react";
import { Badge } from "@/components/demo/audit/FacilityFile";
import { HeaderButton, ModuleHeader, PageRail, type PageDef } from "@/components/demo/audit/Workspace";
import { BillingPanel, RiskPanel } from "@/components/demo/fraud/BillingRisk";
import { CasesPanel, GraphPanel } from "@/components/demo/fraud/CasesGraph";
import { OpsPanel } from "@/components/demo/fraud/OpsPanel";
import { PrepayPanel, RulesPanel, SummaryPanel } from "@/components/demo/fraud/PrepayRules";
import { fraudApi } from "@/components/demo/fraud/api";
import type { AnyRec, TabId } from "@/components/demo/fraud/types";
import { StateMsg } from "@/components/demo/fraud/ui";

const PAGES: PageDef<TabId>[] = [
  { id: "ringkasan", label: "Ringkasan", icon: "gauge", group: "Fraud Intelligence" },
  { id: "kasus", label: "Kasus investigasi", icon: "alert", group: "Investigasi" },
  { id: "graf", label: "Graf kolusi", icon: "graph", group: "Investigasi" },
  { id: "billing", label: "Validasi billing", icon: "table", group: "Deteksi" },
  { id: "skor", label: "Skor risiko", icon: "sparkle", group: "Deteksi" },
  { id: "prepay", label: "Pre-payment", icon: "device", group: "Keputusan" },
  { id: "aturan", label: "Aturan & integrasi", icon: "layers", group: "Keputusan" },
  { id: "ops", label: "Operasional", icon: "gauge", group: "Keputusan" },
];
const INFO: Record<TabId, [string, string]> = {
  ringkasan: ["Ringkasan fraud", "Di mana risiko berada dan pain point mana yang sudah tertutup buktinya."],
  kasus: ["Kasus investigasi", "Setiap alert menjadi kasus berisi kronologi, bukti, relasi pihak terkait, dan rekomendasi langkah berikutnya."],
  graf: ["Graf kolusi banyak pihak", "Provider, dokter, peserta, lab, apotek, dan perusahaan induk dalam satu graf untuk menemukan pola jaringan."],
  billing: ["Validasi billing", "Klaim dibandingkan dengan rekam medis, diagnosis, prosedur, tarif kontrak, dan aturan manfaat sebelum dibayar."],
  skor: ["Skor risiko explainable", "Benchmark peer per spesialisasi × prosedur, riwayat provider, dan volume — setiap faktor dijelaskan untuk menekan false positive."],
  prepay: ["Skrining pre-payment", "Jalur otomatis untuk risiko rendah, antrian review untuk risiko sedang, hold untuk hard-stop — sebelum uang keluar."],
  aturan: ["Aturan & integrasi", "Registry aturan berversi dengan audit trail, status konektor, dan lineage claims intelligence."],
  ops: ["Operasional & skala", "Job batch async, benchmark latency skrining, feedback loop false-positive, dan decision log — bukti Tahap 3–4 plan skalabilitas."],
};

export default function FraudPage() {
  return <Suspense><FraudWorkspace /></Suspense>;
}

function FraudWorkspace() {
  const [tab, setTab] = useState<TabId>("ringkasan");
  const [ov, setOv] = useState<AnyRec | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [visited, setVisited] = useState<Set<TabId>>(new Set(["ringkasan"]));
  useEffect(() => { fraudApi.overview().then(setOv, (e: Error) => setErr(e.message)); }, []);
  const go = (t: TabId) => { setTab(t); setVisited((v) => new Set(v).add(t)); };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <ModuleHeader title="Fraud Command Center — JKN" crumbs={[{ label: "Demo JKN", href: "/demo-jkn" }, { label: "Fraud Intelligence" }]}>
        <span className="flex items-center gap-1.5 rounded-full bg-ok/10 px-2 py-1 text-[11px] font-semibold text-ok"><span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-ok" /></span>Mesin fraud aktif</span>
        <Badge text="Demo · data fiktif" color="#eab308" />
        <HeaderButton href="/demo-jkn/audit" icon="table">Ruang kerja audit</HeaderButton>
        <HeaderButton href="/demo-jkn" icon="layers">Demo JKN</HeaderButton>
      </ModuleHeader>
      <div className="flex min-h-0 flex-1">
        <div className="hidden md:flex">
          <PageRail pages={PAGES} current={tab} onPick={go} footer={<>Enam pain point fraud dalam satu ruang kerja.<br />Plan skalabilitas: <span className="text-soft">docs/PLAN_FRAUD_SCALABLE.md</span></>} />
        </div>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-ink">
          <div className="flex gap-1 overflow-x-auto border-b border-line bg-panel px-2 md:hidden">
            {PAGES.map((p) => <button key={p.id} type="button" onClick={() => go(p.id)} className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-xs ${tab === p.id ? "border-ocean text-white" : "border-transparent text-muted"}`}>{p.label}</button>)}
          </div>
          <div className="mx-auto max-w-[1500px] space-y-3 p-4">
            <div>
              <h2 className="text-lg font-semibold">{INFO[tab][0]}</h2>
              <p className="max-w-4xl text-xs leading-relaxed text-muted">{INFO[tab][1]}</p>
            </div>
            {err && <StateMsg kind="error" text={`${err} — pastikan API berjalan (start.ps1), lalu muat ulang.`} />}
            {msg && <p className="rounded-md border border-ok/40 bg-ok/5 p-2 text-xs text-ok">{msg}</p>}
            {/* Panel dimuat malas: hanya tab yang pernah dibuka yang fetch & dirender (plan Tahap 1). */}
            {tab === "ringkasan" && (ov ? <SummaryPanel ov={ov} go={(t) => go(t as TabId)} /> : !err && <StateMsg kind="loading" text="Memuat ringkasan…" />)}
            {visited.has("kasus") && <div className={tab === "kasus" ? "" : "hidden"}><CasesPanel onMsg={setMsg} /></div>}
            {visited.has("graf") && <div className={tab === "graf" ? "" : "hidden"}><GraphPanel /></div>}
            {visited.has("billing") && <div className={tab === "billing" ? "" : "hidden"}><BillingPanel onMsg={setMsg} /></div>}
            {visited.has("skor") && <div className={tab === "skor" ? "" : "hidden"}><RiskPanel /></div>}
            {visited.has("prepay") && <div className={tab === "prepay" ? "" : "hidden"}><PrepayPanel onMsg={setMsg} /></div>}
            {visited.has("aturan") && <div className={tab === "aturan" ? "" : "hidden"}><RulesPanel onMsg={setMsg} /></div>}
            {visited.has("ops") && <div className={tab === "ops" ? "" : "hidden"}><OpsPanel onMsg={setMsg} /></div>}
          </div>
        </main>
      </div>
    </div>
  );
}
