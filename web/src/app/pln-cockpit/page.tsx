"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/demo/audit/FacilityFile";
import { HeaderButton, ModuleHeader, PageRail, type PageDef } from "@/components/demo/audit/Workspace";
import { AssetContext, AssetDrawer, type AssetKey } from "@/components/demo/cockpit/AssetDrawer";
import { api, type AlarmList, type Overview } from "@/components/demo/cockpit/api";
import { FieldPage, GovernancePage, IntegrationPage, LossPage } from "@/components/demo/cockpit/BizPages";
import { LoadPage, NetworkPage, ReliabilityPage, RiskPage } from "@/components/demo/cockpit/GridPages";
import { AlarmPage, OverviewPage } from "@/components/demo/cockpit/OpsPages";
import { Loading } from "@/components/demo/cockpit/parts";

/* PLN Grid Monitoring Cockpit — transmission & distribution operations analytics on the platform's data: every figure
   comes from Nexus objects (read as the signed-in account) built by the grid pipelines, every write is a Nexus action,
   and every widget links to its object, dataset and lineage. Real OSM transmission carries no invented electrical
   numbers (structural N-1 only); electrical analytics run on the fictional demo distribution network. */

type Tab = "ringkasan" | "jaringan" | "beban" | "keandalan" | "alarm" | "risiko" | "ml" | "lapangan" | "integrasi" | "tata_kelola";
const TABS: Tab[] = ["ringkasan", "jaringan", "beban", "keandalan", "alarm", "risiko", "ml", "lapangan", "integrasi", "tata_kelola"];
const PAGE_INFO: Record<Tab, [string, string]> = {
  ringkasan: ["Ringkasan operasi", "Kondisi jaringan saat ini: alarm aktif, N-1 gardu induk, beban trafo, keandalan, susut, risiko aset, N-1 struktural transmisi, dan kesegaran pipeline."],
  jaringan: ["Jaringan & topologi", "Peta Jawa–Bali dan N-1 struktural transmisi dari topologi OSM riil: koridor kritis (jembatan graf), titik artikulasi, dan gardu/MW yang terisolasi bila satu koridor lepas."],
  beban: ["Beban & kontingensi", "Beban gardu induk per jam dan N-1 trafo daya, pembebanan termal penyulang terhadap KHA, kurva beban harian, serta trafo distribusi terberat dari AMR per jam."],
  keandalan: ["Keandalan & gangguan", "Indeks IEEE 1366 (SAIDI, SAIFI, MAIFI, CAIDI, ENS) per bulan dan per penyulang dari SOE SCADA, penyebab gangguan, dan linimasa padam berdampak topologi."],
  alarm: ["Pusat alarm", "Alarm operasi terpadu dari pipeline dan deteksi streaming AMI; akui, tugaskan, selesaikan lewat actions Nexus — riwayat tersimpan di objek."],
  risiko: ["Risiko aset", "Register risiko gardu distribusi dan penyulang dari aturan deterministik berbukti (beban, suhu, umur, tegangan, keandalan, susut) dengan rekomendasi tindakan."],
  ml: ["Loss Intelligence — TL & NTL", "Susut teknis dihitung dari fisika rekayasa; susut non-teknis adalah residu neraca yang diberi skor ML sebagai petunjuk investigasi, bukan vonis."],
  lapangan: ["Operasi lapangan", "Perintah kerja teknis (status lewat action Nexus), kunjungan P2TL terjadwal, dan berita acara yang menjadi label model."],
  integrasi: ["Integrasi data", "Rantai data cockpit: pipeline & transform → dataset berversi → object type Nexus (relasi, actions, kebijakan) → aplikasi, dengan kesegaran dan lineage."],
  tata_kelola: ["Keamanan & tata kelola", "Batas read-only ke SCADA, penulisan lewat actions beraudit, pembacaan sesuai penanda & kebijakan baris, dan kontrol platform terkait."],
};
const MAP_GABUNGAN = "map-06d3c34412";

export default function CockpitPage() {
  return (
    <Suspense>
      <Cockpit />
    </Suspense>
  );
}

function Cockpit() {
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => (TABS as string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "ringkasan");
  const [extra, setExtra] = useState<Record<string, string>>((): Record<string, string> => {
    const k = params.get("kategori");
    return k ? { kategori: k } : {};
  });
  const [ov, setOv] = useState<Overview | null>(null);
  const [aktif, setAktif] = useState<AlarmList | null>(null);
  const [err, setErr] = useState("");
  const [asset, setAsset] = useState<AssetKey | null>(null);
  const [nonce, setNonce] = useState(0);

  const muat = useCallback(async () => {
    try {
      const [o, a] = await Promise.all([api<Overview>("/overview"), api<AlarmList>("/alarms?aktif=true&limit=20")]);
      setOv(o);
      setAktif(a);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    muat();
    const t = setInterval(muat, 30000);
    return () => clearInterval(t);
  }, [muat]);

  const go = (t: string, x: Record<string, string> = {}) => {
    setTab(t as Tab);
    setExtra(x);
    const u = new URL(window.location.href);
    u.searchParams.set("tab", t);
    u.searchParams.delete("kategori");
    for (const [k, v] of Object.entries(x)) u.searchParams.set(k, v);
    window.history.replaceState(null, "", u.toString());
  };
  const pages: PageDef<Tab>[] = [
    { id: "ringkasan", label: "Ringkasan operasi", icon: "gauge", group: "Ruang kerja" },
    { id: "alarm", label: "Pusat alarm", icon: "alert", count: ov?.alarm.belum_ditangani ?? null, group: "Ruang kerja" },
    { id: "jaringan", label: "Jaringan & topologi", icon: "layers", count: ov?.transmisi.struktural.kritis ?? null, group: "Jaringan" },
    { id: "beban", label: "Beban & kontingensi", icon: "bolt", count: ov?.termal.dt_overload || null, group: "Jaringan" },
    { id: "keandalan", label: "Keandalan & gangguan", icon: "signal", group: "Jaringan" },
    { id: "risiko", label: "Risiko aset", icon: "thermometer", count: ov?.risiko.Tinggi ?? null, group: "Analitik" },
    { id: "ml", label: "Loss Intelligence", icon: "cpu", group: "Analitik" },
    { id: "lapangan", label: "Operasi lapangan", icon: "list", count: ov?.pekerjaan.kunjungan_terjadwal ?? null, group: "Lapangan" },
    { id: "integrasi", label: "Integrasi data", icon: "pipeline", group: "Platform" },
    { id: "tata_kelola", label: "Keamanan & tata kelola", icon: "lock", group: "Platform" },
  ];
  const refresh = () => {
    muat();
    setNonce((n) => n + 1);
  };

  return (
    <AssetContext.Provider value={setAsset}>
      <div className="flex min-h-0 flex-1 flex-col text-sm">
        <ModuleHeader title="PLN Grid Monitoring Cockpit" crumbs={[{ label: "PLN Grid Project", href: "/demo-grid" }, { label: "apps" }, { label: "Operations Intelligence" }]}>
          <Badge text="Demo · OSM riil + jaringan & telemetri simulasi" color="#eab308" />
          <HeaderButton href={`/map/${MAP_GABUNGAN}`} icon="globe">Peta</HeaderButton>
          <HeaderButton href="/lineage?graph=gridoperasi" icon="split">Lineage</HeaderButton>
          <HeaderButton href="/ontology" icon="cube">Nexus</HeaderButton>
          <HeaderButton href="/orbis/grid" icon="sparkle">Orbis Grid</HeaderButton>
          <HeaderButton href="/demo-grid" icon="layers" primary>Demo Grid</HeaderButton>
        </ModuleHeader>
        <div className="flex min-h-0 flex-1">
          <div className="hidden md:flex">
            <PageRail pages={pages} current={tab} onPick={(t) => go(t)} footer={
              <>
                <div className="font-medium text-soft">Sumber data</div>
                Objek Nexus dibaca sebagai akun Anda, dibangun pipeline analitik operasi & transform topologi. Transmisi: OSM (ODbL) riil; distribusi & telemetri: simulasi demo. Read-only ke SCADA.
              </>
            } />
          </div>
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-ink">
            <div className="flex gap-1 overflow-x-auto border-b border-line bg-panel px-2 md:hidden">
              {pages.map((p) => (
                <button key={p.id} type="button" onClick={() => go(p.id)} className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-xs ${tab === p.id ? "border-ocean text-white" : "border-transparent text-muted"}`}>{p.label}</button>
              ))}
            </div>
            <div className="mx-auto flex min-h-full w-full max-w-[1680px] flex-col gap-3 p-4">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold">{PAGE_INFO[tab][0]}</h2>
                  <p className="max-w-5xl text-xs text-muted">{PAGE_INFO[tab][1]}</p>
                </div>
                {ov && <span className="text-[11px] text-muted">data per {new Date(ov.dibuat).toLocaleTimeString("id-ID")} · auto 30 dtk</span>}
                <button type="button" onClick={refresh} className="flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:border-ocean hover:text-white">
                  <Icon name="refresh" className="h-3.5 w-3.5" /> Muat ulang
                </button>
              </div>
              {err && <p className="rounded border border-bad/40 bg-bad/5 p-2 text-xs text-bad">API cockpit tidak terjangkau: {err}</p>}
              <div key={`${tab}-${nonce}`} className="flex flex-1 flex-col">
                {tab === "ringkasan" && (ov ? <OverviewPage ov={ov} alarms={aktif?.events ?? []} go={go} /> : !err && <Loading text="Memuat ringkasan operasi…" />)}
                {tab === "alarm" && <AlarmPage initial={extra} onChanged={muat} />}
                {tab === "jaringan" && <NetworkPage mapId={MAP_GABUNGAN} />}
                {tab === "beban" && <LoadPage />}
                {tab === "keandalan" && <ReliabilityPage />}
                {tab === "risiko" && <RiskPage />}
                {tab === "ml" && <LossPage go={go} />}
                {tab === "lapangan" && <FieldPage />}
                {tab === "integrasi" && <IntegrationPage />}
                {tab === "tata_kelola" && <GovernancePage ov={ov} />}
              </div>
            </div>
          </main>
        </div>
        <AssetDrawer asset={asset} onClose={() => setAsset(null)} />
      </div>
    </AssetContext.Provider>
  );
}
