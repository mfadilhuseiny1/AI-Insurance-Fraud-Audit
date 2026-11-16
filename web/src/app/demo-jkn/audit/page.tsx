"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { ActionForm } from "@/components/ontology/ActionForm";
import {
  Badge,
  Bar,
  FacilityFile,
  STATUS_COLOR,
  TIER_COLOR,
  Votes,
  juta,
  type ActionRef,
} from "@/components/demo/audit/FacilityFile";
import { AnomalyDrawer, AnomalyGuide, AnomalyMap } from "@/components/demo/audit/AnomalyExplain";
import { GovernanceTab } from "@/components/demo/audit/GovernanceTab";
import { IotEvidence } from "@/components/demo/audit/IotEvidence";
import { IotNationalTab } from "@/components/demo/audit/IotNationalTab";
import { IotTab } from "@/components/demo/audit/IotTab";
import {
  HeaderButton,
  MetricWidget,
  ModuleHeader,
  PageRail,
  SummaryPage,
  Widget,
  type Decision,
  type PageDef,
} from "@/components/demo/audit/Workspace";
import { Icon } from "@/components/Icon";
import { API_URL } from "@/lib/api";
import {
  ontology,
  type ActionType,
  type ObjectType,
  type OntologyObject,
} from "@/lib/ontology";

type Row = {
  urutan: number;
  kode: string;
  nama: string;
  jenis: string;
  wilayah: string;
  kantor_cabang: string;
  status_audit: string;
  skor_risiko: number;
  skor_anomali: number | null;
  dokter_anomali: number;
  dokter_pola_baru: number;
  prioritas: number;
  tingkat_prioritas: string;
  indikasi_utama: string;
  jumlah_kasus: number;
  klaim_berisiko: number;
  potensi_kerugian_rp: number;
  tim_audit: string;
  tanggal_audit: string;
  diputuskan: boolean;
  iot_status?: string | null;
  iot_hari_temuan: number;
  iot_tindakan_tak_didukung: number;
  iot_nilai_tak_didukung_rp: number;
};
type Kind = "faskes" | "kasus" | "dokter";
type Queue = {
  types: Record<Kind, string>;
  actions: Record<Kind, ActionRef[]>;
  faskes: Row[];
  apps: {
    map?: string;
    template?: string;
    workshop?: string;
    graph_ops?: string;
    pipeline?: string;
    scoring_pipeline?: string;
  };
  kpi: {
    faskes: number;
    p1: number;
    p2: number;
    kasus: number;
    kasus_ditindaklanjuti: number;
    pola_baru: number;
    potensi_kerugian_rp: number;
    pengembalian_rp: number;
    keputusan: number;
    iot_faskes: number;
    iot_nilai_rp: number;
  };
  filters: { kantor_cabang: string[]; jenis: string[]; status: string[] };
  bobot: { aturan: number; anomali: number; iot?: number; iot_hari?: number };
};
type Anom = {
  id_dokter: string;
  nama: string;
  spesialisasi: string;
  faskes_utama: string;
  nama_faskes: string;
  status_faskes: string;
  skor_anomali: number;
  suara_model: number;
  peringkat_anomali: number;
  status_anomali: string;
  jumlah_kasus: number;
  alasan: { fitur: string; label: string; kontribusi: number }[];
  status_klarifikasi?: string | null;
};
type Case = {
  id_kasus: string;
  jenis_kasus: string;
  alur: string;
  faskes_asal: string;
  faskes_tujuan: string;
  nama_dokter_perujuk: string;
  nama_dokter_dpjp: string;
  diagnosa: string;
  jumlah_klaim: number;
  nilai_klaim_rp: number;
  status_kasus: string;
  tindak_lanjut?: string;
};
type Dist = {
  variabel: string;
  kategori: {
    kategori: string;
    porsi_dokter: number;
    porsi_populasi: number;
  }[];
}[];

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!r.ok)
    throw new Error(
      (await r.json().catch(() => ({ detail: r.statusText }))).detail ??
        r.statusText,
    );
  return r.json();
}

/**
 * The JKN audit team's workspace: the work queue of facilities (rule screening + anomaly models, one priority),
 * a facility's full file with the decisions taken through the Ontology's actions, the doctors the anomaly models
 * flag (new patterns first), and the risky cases — all on the objects the end-to-end pipeline maintains.
 */
export default function AuditWorkspacePage() {
  // useSearchParams needs a Suspense boundary on a static page
  return (
    <Suspense>
      <AuditWorkspace />
    </Suspense>
  );
}

type Tab = "ringkasan" | "antrian" | "anomali" | "kasus" | "iot" | "nasional" | "tata_kelola";

function AuditWorkspace() {
  const params = useSearchParams();
  const [q, setQ] = useState<Queue | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // a link can open a tab and an IoT finding's evidence: /demo-jkn/audit?tab=iot&temuan=…
  const [tab, setTab] = useState<Tab>(() => {
    const t = params.get("tab");
    return t === "antrian" || t === "anomali" || t === "kasus" || t === "iot" || t === "nasional" || t === "tata_kelola" ? t : "ringkasan";
  });
  const [evidence, setEvidence] = useState<string | null>(() => params.get("temuan"));
  const [kantor, setKantor] = useState("");
  const [status, setStatus] = useState("");
  const [jenis, setJenis] = useState("");
  const [tier, setTier] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [anom, setAnom] = useState<Anom[] | null>(null);
  const [onlyNew, setOnlyNew] = useState(true);
  const [cases, setCases] = useState<Case[] | null>(null);
  const [form, setForm] = useState<{
    action: ActionType;
    type: ObjectType;
    object: OntologyObject;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [explain, setExplain] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(true);

  const load = useCallback(() => {
    get<Queue>("/api/demo/jkn/workbench").then(
      (x) => (setQ(x), setErr(null)),
      (e: Error) => setErr(e.message),
    );
    get<{ dokter: Anom[] }>("/api/demo/jkn/workbench/pola-baru").then(
      (x) => setAnom(x.dokter),
      () => setAnom([]),
    );
    get<{ kasus: Case[] }>("/api/demo/jkn/workbench/kasus").then(
      (x) => setCases(x.kasus),
      () => setCases([]),
    );
    get<{ keputusan: Decision[] }>("/api/demo/jkn/workbench/keputusan").then(
      (x) => setDecisions(x.keputusan),
      () => setDecisions([]),
    );
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const openAction = useCallback(
    async (kind: Kind, a: ActionRef, pk: string) => {
      if (!q) return;
      try {
        const tid = q.types[kind];
        const [acts, type, object] = await Promise.all([
          ontology.actionTypes(tid),
          ontology.objectType(tid),
          ontology.object(tid, pk),
        ]);
        const action = acts.find((x) => x.id === a.id);
        if (!action) throw new Error(`Action ${a.name} tidak ditemukan`);
        setForm({ action, type, object });
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [q],
  );

  // an action on any object type (the national tab's hospitals): object type, action and object by id
  const openActionFor = useCallback(async (tid: string, actionId: string, pk: string) => {
    try {
      const [acts, type, object] = await Promise.all([ontology.actionTypes(tid), ontology.objectType(tid), ontology.object(tid, pk)]);
      const action = acts.find((x) => x.id === actionId);
      if (!action) throw new Error("Action tidak ditemukan");
      setForm({ action, type, object });
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q?.faskes ?? []).filter(
      (r) =>
        (!kantor || r.kantor_cabang === kantor) &&
        (!status || r.status_audit === status) &&
        (!jenis || r.jenis === jenis) &&
        (!tier || r.tingkat_prioritas === tier) &&
        (!s ||
          `${r.nama} ${r.kode} ${r.indikasi_utama}`.toLowerCase().includes(s)),
    );
  }, [q, kantor, status, jenis, tier, search]);
  const k = q?.kpi;
  const select = "rounded-md border border-line-2 bg-ink px-2 py-1.5 text-xs";
  const pages: PageDef<Tab>[] = [
    { id: "ringkasan", label: "Ringkasan", icon: "gauge", group: "Ruang kerja" },
    { id: "antrian", label: "Antrian prioritas", icon: "list", count: q?.faskes.length, group: "Ruang kerja" },
    { id: "anomali", label: "Anomali ML", icon: "sparkle", count: anom?.length, group: "Sinyal" },
    { id: "kasus", label: "Kasus berisiko", icon: "alert", count: cases?.length, group: "Sinyal" },
    { id: "iot", label: "IoT alat medis", icon: "device", count: k?.iot_faskes || null, group: "Sinyal" },
    { id: "nasional", label: "Pantauan nasional", icon: "globe", group: "Skala nasional" },
    { id: "tata_kelola", label: "Keamanan & tata kelola", icon: "lock", group: "Tata kelola" },
  ];
  const PAGE_INFO: Record<Tab, [string, string]> = {
    ringkasan: ["Ringkasan audit", "Di mana risiko berada, faskes yang dikerjakan dulu, dan keputusan terakhir tim audit."],
    antrian: [
      "Antrian prioritas",
      `Prioritas = ${Math.round((q?.bobot.aturan ?? 0.65) * 100)}% skor aturan + ${Math.round((q?.bobot.anomali ?? 0.35) * 100)}% anomali dokter tertinggi, ditambah bukti IoT (maks +${Math.round((q?.bobot.iot ?? 0.15) * 100)} saat ≥ ${q?.bobot.iot_hari ?? 7} hari tindakan tak didukung alat). Faskes dalam investigasi selalu di atas.`,
    ],
    anomali: ["Anomali ML", "Dokter yang dinilai menyimpang oleh ≥ 5 dari 8 detektor tanpa label. Pola baru belum tentu fraud: perlu klarifikasi."],
    kasus: ["Kasus rujukan berisiko", "Kasus dari aturan skrining dan tindak lanjutnya, diputuskan lewat action."],
    iot: ["IoT alat medis", "Pemakaian listrik alat medis dibandingkan dengan tindakan penunjang yang diklaim, per hari."],
    nasional: ["Pantauan IoT nasional", "Semua RS jejaring di Indonesia, per provinsi dan kabupaten/kota, sampai arsip gateway alat."],
    tata_kelola: ["Keamanan & tata kelola", "Bagaimana identitas peserta dan berkas investigasi dilindungi — dengan kontrol platform yang sebenarnya."],
  };
  const pick = (t: Tab) => {
    setTab(t);
    const u = new URL(window.location.href);
    u.searchParams.set("tab", t);
    u.searchParams.delete("temuan");
    window.history.replaceState(null, "", u.toString());
  };
  const filterQueue = (f: { tier?: string; status?: string; kantor?: string }) => {
    setTier(f.tier ?? "");
    setStatus(f.status ?? "");
    setKantor(f.kantor ?? "");
    setJenis("");
    setSearch("");
    pick("antrian");
  };
  const activeFilters = [kantor, status, jenis, tier, search.trim()].filter(Boolean).length;
  // through fetch (not a link): the export is checkpointed, and the app's fetch asks for the purpose first
  const exportCsv = async () => {
    const r = await fetch(`${API_URL}/api/demo/jkn/workbench/export.csv`, { credentials: "include" });
    if (!r.ok) {
      if (r.status !== 428) setErr(`Ekspor gagal (${r.status})`);
      return;
    }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = "antrean-audit-faskes-jkn.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <ModuleHeader
        title="Ruang Kerja Audit Faskes JKN"
        crumbs={[{ label: "JKN Healthcare System Intelligence", href: "/demo-jkn" }, { label: "apps" }, { label: "Ruang kerja audit" }]}
      >
        <Badge text="Demo · data fiktif" color="#eab308" />
        <HeaderButton onClick={exportCsv} icon="download">
          CSV
        </HeaderButton>
        {q?.apps.workshop && (
          <HeaderButton href={`/workshop/${q.apps.workshop}`} icon="grid">
            Kokpit Workshop
          </HeaderButton>
        )}
        {q?.apps.map && (
          <HeaderButton href={`/map/${q.apps.map}`} icon="globe">
            Peta audit
          </HeaderButton>
        )}
        <HeaderButton href="/demo-jkn/arsitektur" icon="layers">
          Arsitektur
        </HeaderButton>
        <HeaderButton href="/demo-jkn/ontologi" icon="cube" primary>
          Cara kerja (Nexus)
        </HeaderButton>
      </ModuleHeader>

      <div className="flex min-h-0 flex-1">
        <div className="hidden md:flex">
          <PageRail
            pages={pages}
            current={tab}
            onPick={pick}
            footer={
              <>
                <div className="font-medium text-soft">Sumber data</div>
                Objek Nexus yang dipelihara pipeline end-to-end; keputusan lewat action, tercatat di riwayat edit.
              </>
            }
          />
        </div>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-ink">
          <div className="flex gap-1 overflow-x-auto border-b border-line bg-panel px-2 md:hidden">
            {pages.map((p) => (
              <button key={p.id} type="button" onClick={() => pick(p.id)}
                className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-xs ${tab === p.id ? "border-ocean text-white" : "border-transparent text-muted"}`}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="mx-auto max-w-[1600px] space-y-3 p-4">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold">{PAGE_INFO[tab][0]}</h2>
                <p className="max-w-4xl text-xs text-muted">{PAGE_INFO[tab][1]}</p>
              </div>
              <button type="button" onClick={load} className="flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:border-ocean hover:text-white">
                <Icon name="refresh" className="h-3.5 w-3.5" /> Muat ulang
              </button>
            </div>
            {err && <p className="rounded border border-bad/40 bg-bad/5 p-2 text-xs text-bad">{err}</p>}
            {toast && <p className="rounded border border-ok/40 bg-ok/5 p-2 text-xs text-ok">{toast}</p>}

            {tab === "ringkasan" &&
              (q && k ? (
                <SummaryPage rows={q.faskes} kpi={k} decisions={decisions} onFacility={setOpen} onFilter={filterQueue} onPage={pick} />
              ) : (
                !err && <p className="py-10 text-center text-muted">Memuat ringkasan…</p>
              ))}

            {tab === "antrian" && (
              <Widget
                title="Faskes untuk diaudit"
                caption={`${rows.length} dari ${q?.faskes.length ?? 0} faskes · klik baris untuk membuka berkas faskes`}
                bodyClass="p-0"
                right={
                  activeFilters > 0 && (
                    <button type="button" onClick={() => filterQueue({})} className="rounded px-2 py-1 text-[11px] text-ocean hover:bg-ocean/10">
                      Hapus {activeFilters} saringan
                    </button>
                  )
                }
              >
                <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel-2/40 px-3 py-2">
                  <div className="relative">
                    <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                    <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cari faskes, kode, indikasi…" className={`${select} w-60 pl-7`} />
                  </div>
                  <select value={kantor} onChange={(e) => setKantor(e.target.value)} className={select}>
                    <option value="">Semua kantor cabang</option>
                    {q?.filters.kantor_cabang.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                  <select value={status} onChange={(e) => setStatus(e.target.value)} className={select}>
                    <option value="">Semua status</option>
                    {q?.filters.status.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                  <select value={jenis} onChange={(e) => setJenis(e.target.value)} className={select}>
                    <option value="">Semua jenis</option>
                    {q?.filters.jenis.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                  <select value={tier} onChange={(e) => setTier(e.target.value)} className={select}>
                    <option value="">Semua prioritas</option>
                    {["P1", "P2", "P3", "Pantau", "Selesai"].map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-left text-[10.5px] text-muted">
                      <tr className="border-b border-line">
                        <th className="px-3 py-2">#</th>
                        <th className="px-2 py-2">Faskes</th>
                        <th className="px-2 py-2">Prioritas</th>
                        <th className="px-2 py-2">Status audit</th>
                        <th className="px-2 py-2">Skor aturan</th>
                        <th className="px-2 py-2">Anomali ML</th>
                        <th className="px-2 py-2">Indikasi utama</th>
                        <th className="px-2 py-2 text-right">Kasus</th>
                        <th className="px-2 py-2 text-right">Potensi kerugian</th>
                        <th className="px-3 py-2">Tim / jadwal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.kode} onClick={() => setOpen(r.kode)} className={`cursor-pointer border-b border-line/50 last:border-0 ${open === r.kode ? "bg-ocean/10" : "hover:bg-panel-2"}`}>
                          <td className="px-3 py-2 tabular-nums text-muted">{r.urutan}</td>
                          <td className="px-2 py-2">
                            <div className="font-medium">
                              {r.nama}{" "}
                              {r.diputuskan && (
                                <span title="Ada keputusan tim audit" className="text-warn">
                                  ⚡
                                </span>
                              )}
                            </div>
                            <div className="text-[10.5px] text-muted">
                              {r.kode} · {r.jenis} · {r.kantor_cabang}
                            </div>
                            {r.iot_hari_temuan > 0 && (
                              <span className="mt-0.5 inline-block" title={`IoT: ${r.iot_tindakan_tak_didukung} tindakan diklaim tanpa jejak pemakaian alat dalam ${r.iot_hari_temuan} hari`}>
                                <Badge text={`IoT · ${r.iot_tindakan_tak_didukung} tindakan tak didukung alat`} color="#14b8a6" />
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-1.5">
                              <Badge text={r.tingkat_prioritas} color={TIER_COLOR[r.tingkat_prioritas] ?? "#64748b"} />
                              <span className="tabular-nums">{r.prioritas}</span>
                            </div>
                          </td>
                          <td className="px-2 py-2">
                            <Badge text={r.status_audit} color={STATUS_COLOR[r.status_audit] ?? "#64748b"} />
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-1.5">
                              <Bar value={r.skor_risiko / 100} color={STATUS_COLOR[r.status_audit] ?? "#64748b"} />
                              <span className="tabular-nums">{r.skor_risiko}</span>
                            </div>
                          </td>
                          <td className="px-2 py-2">
                            {r.skor_anomali != null ? (
                              <div className="flex items-center gap-1.5">
                                <Bar value={r.skor_anomali} color="#a78bfa" />
                                <span className="tabular-nums">{r.skor_anomali.toFixed(2)}</span>
                                {r.dokter_pola_baru > 0 && <Badge text={`${r.dokter_pola_baru} pola baru`} color="#a78bfa" />}
                              </div>
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </td>
                          <td className="max-w-56 truncate px-2 py-2" title={r.indikasi_utama}>
                            {r.indikasi_utama || <span className="text-muted">—</span>}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">{r.jumlah_kasus || "—"}</td>
                          <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{r.potensi_kerugian_rp ? juta(r.potensi_kerugian_rp) : "—"}</td>
                          <td className="px-3 py-2 text-[10.5px]">
                            {r.tim_audit ? (
                              <>
                                {r.tim_audit}
                                <div className="text-muted">{r.tanggal_audit}</div>
                              </>
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                      {q && rows.length === 0 && (
                        <tr>
                          <td colSpan={10} className="px-3 py-6 text-center text-muted">
                            Tidak ada faskes untuk saringan ini.
                          </td>
                        </tr>
                      )}
                      {!q && !err && (
                        <tr>
                          <td colSpan={10} className="px-3 py-6 text-center text-muted">
                            Memuat antrian…
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Widget>
            )}

            {tab === "anomali" && <AnomalyGuide open={guideOpen} onToggle={() => setGuideOpen((v) => !v)} />}
            {tab === "anomali" && (
              <Widget title="Peta dokter: siapa yang jauh dari populasi" caption="semua dokter dalam satu gambar · klik titik untuk penjelasan">
                <AnomalyMap selected={explain} onPick={(id) => (setExplain(id), setGuideOpen(false))} />
              </Widget>
            )}
            {tab === "anomali" && (
              <Widget
                title="Dokter dengan anomali"
                caption={`${(anom ?? []).filter((a) => !onlyNew || a.status_anomali.includes("pola baru")).length} dokter · skor, suara 8 detektor dan alasan Shapley`}
                right={
                  <label className="flex items-center gap-1.5 text-[11px] text-soft">
                    <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> Hanya pola baru
                  </label>
                }
              >
                <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {(anom ?? [])
                    .filter((a) => !onlyNew || a.status_anomali.includes("pola baru"))
                    .map((a) => (
                      <AnomalyCard key={a.id_dokter} a={a} actions={q?.actions.dokter ?? []} onAction={(act) => openAction("dokter", act, a.id_dokter)} onFacility={() => setOpen(a.faskes_utama)}
                        onExplain={() => (setExplain(a.id_dokter), setGuideOpen(false))} />
                    ))}
                  {anom && anom.length === 0 && <p className="text-muted">Belum ada skor anomali.</p>}
                </div>
              </Widget>
            )}

            {tab === "kasus" && (
              <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <MetricWidget label="Kasus berisiko" value={cases?.length ?? "…"} color="#94a3b8" />
                  <MetricWidget label="Ditindaklanjuti" value={`${k?.kasus_ditindaklanjuti ?? 0} / ${k?.kasus ?? 0}`} color="#22c55e" />
                  <MetricWidget label="Klaim terkait" value={(cases ?? []).reduce((s, c) => s + (c.jumlah_klaim || 0), 0).toLocaleString("id-ID")} color="#3b82f6" />
                  <MetricWidget label="Nilai klaim" value={juta((cases ?? []).reduce((s, c) => s + (c.nilai_klaim_rp || 0), 0))} color="#ef4444" />
                </div>
                <Widget title="Kasus rujukan berisiko" caption="klik alur untuk membuka berkas faskes tujuan" bodyClass="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="text-left text-[10.5px] text-muted">
                        <tr className="border-b border-line">
                          <th className="px-3 py-2">Kasus</th>
                          <th className="px-2 py-2">Alur</th>
                          <th className="px-2 py-2">Dokter</th>
                          <th className="px-2 py-2 text-right">Klaim</th>
                          <th className="px-2 py-2 text-right">Nilai</th>
                          <th className="px-2 py-2">Status / tindak lanjut</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {(cases ?? []).map((c) => (
                          <tr key={c.id_kasus} className="border-b border-line/50 align-top last:border-0 hover:bg-panel-2/50">
                            <td className="px-3 py-2">
                              <div className="font-mono">{c.id_kasus}</div>
                              <div className="text-[10.5px] text-muted">{c.jenis_kasus}</div>
                            </td>
                            <td className="px-2 py-2">
                              <button type="button" onClick={() => setOpen(c.faskes_tujuan)} className="text-left hover:text-ocean">
                                {c.alur}
                              </button>
                              <div className="text-[10.5px] text-muted">{c.diagnosa}</div>
                            </td>
                            <td className="px-2 py-2 text-[10.5px]">
                              {c.nama_dokter_perujuk} → {c.nama_dokter_dpjp}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">{c.jumlah_klaim}</td>
                            <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{juta(c.nilai_klaim_rp)}</td>
                            <td className="px-2 py-2">
                              <Badge text={c.status_kasus} color={STATUS_COLOR[c.status_kasus] ?? "#64748b"} />
                              {c.tindak_lanjut && <div className="mt-0.5 text-[10.5px] text-soft">{c.tindak_lanjut}</div>}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {q?.actions.kasus.map((a) => (
                                <button key={a.id} type="button" onClick={() => openAction("kasus", a, c.id_kasus)}
                                  className="whitespace-nowrap rounded border border-warn/40 px-1.5 py-0.5 text-[10.5px] text-warn hover:bg-warn/10">
                                  ⚡ Tindak lanjut
                                </button>
                              ))}
                            </td>
                          </tr>
                        ))}
                        {!cases && (
                          <tr>
                            <td colSpan={7} className="px-3 py-6 text-center text-muted">
                              Memuat kasus…
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </Widget>
              </>
            )}

            {tab === "iot" && <IotTab version={version} onEvidence={setEvidence} onFacility={setOpen} />}

            {tab === "tata_kelola" && <GovernanceTab />}

            {tab === "nasional" && <IotNationalTab version={version} onEvidence={setEvidence} onAction={openActionFor} />}
          </div>
        </main>
        {explain && tab === "anomali" && (
        <AnomalyDrawer
          id={explain}
          onClose={() => setExplain(null)}
          actions={
            <>
              {(q?.actions.dokter ?? []).map((x) => (
                <button key={x.id} type="button" onClick={() => openAction("dokter", x, explain)}
                  className="rounded border border-warn/40 px-2 py-1 text-[11px] text-warn hover:bg-warn/10">
                  ⚡ {x.name}
                </button>
              ))}
              {anom?.find((a) => a.id_dokter === explain) && (
                <button type="button" onClick={() => (setOpen(anom.find((a) => a.id_dokter === explain)!.faskes_utama), setExplain(null))}
                  className="rounded border border-line-2 px-2 py-1 text-[11px] hover:border-ocean">
                  Buka berkas faskes
                </button>
              )}
            </>
          }
        />
      )}
      </div>

      {open && q && (
        <>
          <div className="fixed inset-0 z-30 bg-black/40" onClick={() => setOpen(null)} />
          <FacilityFile
            kode={open}
            version={version}
            actions={q.actions}
            apps={q.apps}
            onAction={openAction}
            onIot={(id) => {
              setOpen(null);
              setEvidence(id);
            }}
            onClose={() => setOpen(null)}
          />
        </>
      )}
      {evidence && (
        <IotEvidence
          id={evidence}
          onClose={() => setEvidence(null)}
          onFacility={(kode) => {
            setEvidence(null);
            setOpen(kode);
          }}
          onDecided={() => {
            setVersion((v) => v + 1);
            load();
          }}
        />
      )}
      {form && (
        <ActionForm
          action={form.action}
          objectType={form.type}
          object={form.object}
          onClose={() => setForm(null)}
          onDone={() => {
            setToast(`${form.action.display_name} diterapkan pada ${form.object.title ?? form.object.primary_key}. Tercatat di riwayat edit.`);
            setForm(null);
            setVersion((v) => v + 1);
            load();
            setTimeout(() => setToast(null), 6000);
          }}
        />
      )}
    </div>
  );
}

function AnomalyCard({
  a,
  actions,
  onAction,
  onFacility,
  onExplain,
}: {
  a: Anom;
  actions: ActionRef[];
  onAction: (a: ActionRef) => void;
  onFacility: () => void;
  onExplain: () => void;
}) {
  const [dist, setDist] = useState<Dist | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!show || dist) return;
    get<{ rows: Dist }>(
      `/api/demo/jkn/e2e/ml/distribusi/${encodeURIComponent(a.id_dokter)}`,
    ).then(
      (x) => setDist(x.rows),
      () => setDist([]),
    );
  }, [show, dist, a.id_dokter]);
  const maxPhi = Math.max(0.0001, ...a.alasan.map((x) => x.kontribusi));
  const isNew = a.status_anomali.includes("pola baru");
  return (
    <div
      className="rounded-xl border bg-panel p-3 text-xs"
      style={{ borderColor: isNew ? "#a78bfa66" : "var(--color-line)" }}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 w-7 shrink-0 text-right font-semibold tabular-nums text-muted">
          #{a.peringkat_anomali}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{a.nama}</div>
          <div className="text-[10.5px] text-muted">
            {a.spesialisasi} ·{" "}
            <button
              type="button"
              onClick={onFacility}
              className="hover:text-ocean"
            >
              {a.nama_faskes}
            </button>{" "}
            ({a.status_faskes}) · {a.jumlah_kasus} kasus audit
          </div>
        </div>
        <div className="text-right">
          <div className="flex items-center justify-end gap-1.5">
            <Bar value={a.skor_anomali} color="#ef4444" width={48} />
            <span className="font-semibold tabular-nums">
              {a.skor_anomali.toFixed(2)}
            </span>
          </div>
          <Votes n={a.suara_model} />
        </div>
      </div>
      <div className="mt-2">
        <Badge
          text={
            isNew
              ? "Pola baru — belum ada kasus aturan"
              : "Anomali — sudah ada kasus audit"
          }
          color={isNew ? "#a78bfa" : "#ef4444"}
        />
        {a.status_klarifikasi && (
          <span className="ml-2 text-[10.5px] text-warn">
            ⚡ {a.status_klarifikasi}
          </span>
        )}
      </div>
      <div className="mt-2 space-y-0.5">
        {a.alasan.slice(0, 4).map((x) => (
          <div key={x.fitur} className="flex items-center gap-2">
            <span className="w-40 shrink-0 truncate" title={x.label}>
              {x.label}
            </span>
            <span
              className="h-1.5 rounded"
              style={{
                width: `${(x.kontribusi / maxPhi) * 110}px`,
                background: "#ef4444",
              }}
            />
            <span className="tabular-nums text-muted">
              +{x.kontribusi.toFixed(3)}
            </span>
          </div>
        ))}
      </div>
      {show && (
        <div className="mt-2 space-y-1.5 border-t border-line pt-2">
          {!dist ? (
            <span className="text-muted">Memuat distribusi…</span>
          ) : (
            dist.slice(0, 3).map((v) => (
              <div key={v.variabel}>
                <div className="text-[10.5px] text-muted">{v.variabel}</div>
                {v.kategori.slice(0, 2).map((c) => (
                  <div
                    key={c.kategori}
                    className="flex items-center gap-2 text-[10.5px]"
                  >
                    <span className="w-20 truncate font-mono">
                      {c.kategori}
                    </span>
                    <span className="tabular-nums">
                      <b style={{ color: "#ef4444" }}>
                        {(c.porsi_dokter * 100).toFixed(0)}%
                      </b>{" "}
                      dokter vs {(c.porsi_populasi * 100).toFixed(0)}% populasi
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="rounded border border-line-2 px-2 py-0.5 text-[10.5px] hover:border-ocean"
        >
          {show ? "Sembunyikan" : "Bandingkan dengan populasi"}
        </button>
        <button
          type="button"
          onClick={onExplain}
          className="rounded border border-violet-500/50 bg-violet-500/10 px-2 py-0.5 text-[10.5px] text-violet-200 hover:bg-violet-500/20"
        >
          Kenapa dicurigai? →
        </button>
        <button
          type="button"
          onClick={onFacility}
          className="rounded border border-line-2 px-2 py-0.5 text-[10.5px] hover:border-ocean"
        >
          Buka berkas faskes
        </button>
        {actions.map((x) => (
          <button
            key={x.id}
            type="button"
            onClick={() => onAction(x)}
            className="rounded border border-warn/40 px-2 py-0.5 text-[10.5px] text-warn hover:bg-warn/10"
          >
            ⚡ {x.name}
          </button>
        ))}
      </div>
    </div>
  );
}
