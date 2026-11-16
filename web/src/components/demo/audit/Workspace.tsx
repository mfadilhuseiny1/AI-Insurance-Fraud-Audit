"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { Badge, STATUS_COLOR, TIER_COLOR, juta } from "./FacilityFile";

/* The audit workspace laid out as a Workshop module: a module header, a rail of pages, and widgets on a grid. */

export function ModuleHeader({ title, crumbs, children }: { title: string; crumbs: { label: string; href?: string }[]; children?: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ocean/15 text-ocean">
        <Icon name="table" className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          {crumbs.map((c, i) => (
            <span key={c.label} className="flex items-center gap-1.5">
              {i > 0 && <span>/</span>}
              {c.href ? (
                <Link href={c.href} className="hover:text-white">
                  {c.label}
                </Link>
              ) : (
                <span>{c.label}</span>
              )}
            </span>
          ))}
        </div>
        <h1 className="truncate text-[15px] font-semibold leading-tight">{title}</h1>
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">{children}</div>
    </header>
  );
}

export function HeaderButton({ href, onClick, icon, children, primary = false }: { href?: string; onClick?: () => void; icon: IconName; children: ReactNode; primary?: boolean }) {
  const cls = `flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium ${primary ? "bg-ocean text-white hover:bg-ocean-deep" : "border border-line-2 text-soft hover:border-ocean hover:text-white"}`;
  if (href?.startsWith("/")) {
    return (
      <Link href={href} className={cls}>
        <Icon name={icon} className="h-3.5 w-3.5" /> {children}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} className={cls}>
        <Icon name={icon} className="h-3.5 w-3.5" /> {children}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      <Icon name={icon} className="h-3.5 w-3.5" /> {children}
    </button>
  );
}

export type PageDef<T extends string> = { id: T; label: string; icon: IconName; count?: number | string | null; group?: string };

export function PageRail<T extends string>({ pages, current, onPick, footer }: { pages: PageDef<T>[]; current: T; onPick: (p: T) => void; footer?: ReactNode }) {
  return (
    <nav className="flex w-56 shrink-0 flex-col border-r border-line bg-panel">
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {pages.map((p, i) => {
          const head = p.group && p.group !== pages[i - 1]?.group ? p.group : null;
          return (
            <div key={p.id}>
              {head && <div className="px-2.5 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wide text-muted">{head}</div>}
              <button type="button" onClick={() => onPick(p.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition ${p.id === current ? "bg-ocean/15 font-medium text-white ring-1 ring-ocean/30" : "text-soft hover:bg-panel-2 hover:text-white"}`}>
                <Icon name={p.icon} className={`h-4 w-4 shrink-0 ${p.id === current ? "text-ocean" : "text-muted"}`} />
                <span className="min-w-0 flex-1 truncate">{p.label}</span>
                {p.count !== undefined && p.count !== null && p.count !== "" && <span className="rounded bg-panel-2 px-1.5 text-[10.5px] tabular-nums text-muted">{p.count}</span>}
              </button>
            </div>
          );
        })}
      </div>
      {footer && <div className="border-t border-line p-3 text-[11px] text-muted">{footer}</div>}
    </nav>
  );
}

/** A Workshop widget: a title bar (title, optional caption and actions) over its content. */
export function Widget({ title, caption, right, children, className = "", bodyClass = "p-3" }: { title: string; caption?: string; right?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={`flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-panel ${className}`}>
      <div className="flex min-h-10 items-center gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold">{title}</h2>
          {caption && <p className="truncate text-[11px] text-muted">{caption}</p>}
        </div>
        {right && <div className="ml-auto flex shrink-0 items-center gap-1.5">{right}</div>}
      </div>
      <div className={`min-h-0 flex-1 ${bodyClass}`}>{children}</div>
    </section>
  );
}

export function MetricWidget({ label, value, caption, color = "#38bdf8", onClick }: { label: string; value: ReactNode; caption?: string; color?: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="absolute inset-y-0 left-0 w-1 rounded-l-lg" style={{ background: color }} />
      <div className="text-[11px] font-medium text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color }}>
        {value}
      </div>
      {caption && <div className="mt-0.5 truncate text-[11px] text-muted">{caption}</div>}
    </>
  );
  const cls = "relative overflow-hidden rounded-lg border border-line bg-panel py-3 pl-4 pr-3 text-left";
  return onClick ? (
    <button type="button" onClick={onClick} className={`${cls} transition hover:border-ocean`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Horizontal bars, one per category: click a bar to act on it (filter the queue). */
export function BarList({ rows, format = (v) => v.toLocaleString("id-ID"), onPick }: { rows: { key: string; value: number; color?: string; note?: string }[]; format?: (v: number) => string; onPick?: (key: string) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <button key={r.key} type="button" disabled={!onPick} onClick={() => onPick?.(r.key)} className="group grid w-full grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-left text-xs disabled:cursor-default">
          <span className="truncate text-soft group-hover:text-white" title={r.key}>
            {r.key}
          </span>
          <span className="h-5 overflow-hidden rounded bg-ink">
            <span className="block h-full rounded transition-all group-hover:brightness-125" style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, background: r.color ?? "#3b82f6" }} />
          </span>
          <span className="w-20 text-right tabular-nums text-soft">
            {format(r.value)}
            {r.note && <span className="block text-[10px] text-muted">{r.note}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

export type SummaryRow = {
  kode: string;
  nama: string;
  jenis: string;
  kantor_cabang: string;
  status_audit: string;
  tingkat_prioritas: string;
  prioritas: number;
  skor_risiko: number;
  skor_anomali: number | null;
  dokter_anomali?: number;
  dokter_pola_baru: number;
  indikasi_utama: string;
  potensi_kerugian_rp: number;
  iot_hari_temuan?: number;
  iot_tindakan_tak_didukung?: number;
  diputuskan?: boolean;
};
export type Decision = { type: string; type_id: string; pk: string; title: string; properties: Record<string, unknown>; at: string };

const TIERS = ["P1", "P2", "P3", "Pantau", "Selesai"];
const STATUSES = ["Dalam Investigasi", "Ada Indikasi Fraud", "Perlu Pemantauan", "Selesai Diaudit", "Sehat"];
const TYPE_LABEL: Record<string, string> = {
  "Faskes Audit JKN (demo)": "Faskes",
  "Kasus Rujukan Berisiko JKN (demo)": "Kasus",
  "Dokter Audit JKN (demo)": "Dokter",
  "Temuan IoT JKN (demo)": "Temuan IoT",
  "RS Jejaring IoT JKN (demo)": "RS jejaring",
};

/**
 * The workspace's overview page: the numbers that matter, where the risk sits (priority, audit status, branch office),
 * the facilities to work on first, the three signals behind the priority, and what the team decided lately.
 */
export function SummaryPage({ rows, kpi, decisions, onFacility, onFilter, onPage }: {
  rows: SummaryRow[];
  kpi: { faskes: number; p1: number; p2: number; kasus: number; kasus_ditindaklanjuti: number; pola_baru: number; potensi_kerugian_rp: number; pengembalian_rp: number; keputusan: number; iot_faskes?: number; iot_nilai_rp?: number };
  decisions: Decision[] | null;
  onFacility: (kode: string) => void;
  onFilter: (f: { tier?: string; status?: string; kantor?: string }) => void;
  onPage: (p: "anomali" | "kasus" | "iot" | "nasional") => void;
}) {
  const open = rows.filter((r) => r.status_audit !== "Selesai Diaudit");
  const byKantor = new Map<string, number>();
  for (const r of open) byKantor.set(r.kantor_cabang, (byKantor.get(r.kantor_cabang) ?? 0) + (r.potensi_kerugian_rp || 0));
  const top = [...rows].filter((r) => r.tingkat_prioritas !== "Selesai").slice(0, 10);
  const withMl = rows.filter((r) => (r.dokter_anomali ?? 0) > 0).length;
  const withIot = rows.filter((r) => (r.iot_hari_temuan ?? 0) > 0).length;
  return (
    <div className="grid grid-cols-12 gap-3">
      <div className="col-span-12 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <MetricWidget label="Faskes dipantau" value={kpi.faskes} caption={`${kpi.kasus} kasus berisiko`} color="#94a3b8" />
        <MetricWidget label="Prioritas P1" value={kpi.p1} caption="segera diaudit" color={TIER_COLOR.P1} onClick={() => onFilter({ tier: "P1" })} />
        <MetricWidget label="Prioritas P2" value={kpi.p2} caption="dijadwalkan" color={TIER_COLOR.P2} onClick={() => onFilter({ tier: "P2" })} />
        <MetricWidget label="Potensi kerugian terbuka" value={juta(kpi.potensi_kerugian_rp)} caption="faskes belum selesai diaudit" color="#ef4444" />
        <MetricWidget label="Dana dikembalikan" value={juta(kpi.pengembalian_rp)} caption="dari audit selesai" color="#22c55e" />
        <MetricWidget label="Pola baru (ML)" value={kpi.pola_baru} caption="dokter tanpa kasus audit" color="#a78bfa" onClick={() => onPage("anomali")} />
        <MetricWidget label="Tak didukung alat (IoT)" value={juta(kpi.iot_nilai_rp ?? 0)} caption={`${kpi.iot_faskes ?? 0} faskes pilot`} color="#14b8a6" onClick={() => onPage("iot")} />
        <MetricWidget label="Keputusan tim audit" value={kpi.keputusan} caption={`${kpi.kasus_ditindaklanjuti}/${kpi.kasus} kasus ditindaklanjuti`} color="#f59e0b" onClick={() => onPage("kasus")} />
      </div>

      <Widget title="Faskes per tingkat prioritas" caption="klik untuk membuka antrian" className="col-span-12 md:col-span-6 xl:col-span-4">
        <BarList rows={TIERS.map((t) => ({ key: t, value: rows.filter((r) => r.tingkat_prioritas === t).length, color: TIER_COLOR[t] }))} onPick={(k) => onFilter({ tier: k })} />
      </Widget>
      <Widget title="Faskes per status audit" caption="keputusan tim audit menang atas skrining" className="col-span-12 md:col-span-6 xl:col-span-4">
        <BarList rows={STATUSES.map((s) => ({ key: s, value: rows.filter((r) => r.status_audit === s).length, color: STATUS_COLOR[s] }))} onPick={(k) => onFilter({ status: k })} />
      </Widget>
      <Widget title="Potensi kerugian terbuka per kantor cabang" caption="faskes yang belum selesai diaudit" className="col-span-12 xl:col-span-4">
        <BarList rows={[...byKantor].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, value: v, color: "#ef4444" }))} format={juta} onPick={(k) => onFilter({ kantor: k })} />
      </Widget>

      <Widget title="10 faskes prioritas teratas" caption="65 % aturan skrining + 35 % anomali ML, ditambah bukti IoT" className="col-span-12 xl:col-span-8" bodyClass="p-0"
        right={<button type="button" onClick={() => onFilter({})} className="rounded px-2 py-1 text-[11px] text-ocean hover:bg-ocean/10">Antrian lengkap →</button>}>
        <table className="w-full text-xs">
          <thead className="text-left text-[10.5px] text-muted">
            <tr className="border-b border-line">
              <th className="px-3 py-2">Faskes</th>
              <th className="px-2 py-2">Prioritas</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Indikasi utama</th>
              <th className="px-2 py-2 text-right">Potensi kerugian</th>
              <th className="px-3 py-2">Sinyal</th>
            </tr>
          </thead>
          <tbody>
            {top.map((r) => (
              <tr key={r.kode} onClick={() => onFacility(r.kode)} className="cursor-pointer border-b border-line/50 last:border-0 hover:bg-panel-2">
                <td className="px-3 py-2">
                  <div className="font-medium">{r.nama}</div>
                  <div className="text-[10.5px] text-muted">
                    {r.jenis} · {r.kantor_cabang}
                  </div>
                </td>
                <td className="px-2 py-2">
                  <span className="flex items-center gap-1.5">
                    <Badge text={r.tingkat_prioritas} color={TIER_COLOR[r.tingkat_prioritas] ?? "#64748b"} />
                    <span className="tabular-nums text-muted">{r.prioritas}</span>
                  </span>
                </td>
                <td className="px-2 py-2">
                  <Badge text={r.status_audit} color={STATUS_COLOR[r.status_audit] ?? "#64748b"} />
                </td>
                <td className="max-w-52 truncate px-2 py-2" title={r.indikasi_utama}>
                  {r.indikasi_utama || "—"}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{r.potensi_kerugian_rp ? juta(r.potensi_kerugian_rp) : "—"}</td>
                <td className="px-3 py-2">
                  <span className="flex flex-wrap gap-1">
                    <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-soft">aturan {r.skor_risiko}</span>
                    {r.skor_anomali != null && <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-300">ML {r.skor_anomali.toFixed(2)}</span>}
                    {(r.iot_hari_temuan ?? 0) > 0 && <span className="rounded bg-teal-500/15 px-1.5 py-0.5 text-[10px] text-teal-300">IoT {r.iot_tindakan_tak_didukung}</span>}
                    {r.diputuskan && <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">diputuskan</span>}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Widget>

      <div className="col-span-12 flex flex-col gap-3 xl:col-span-4">
        <Widget title="Tiga sinyal di balik prioritas">
          <div className="space-y-2 text-xs">
            {(
              [
                ["Aturan skrining", `${rows.filter((r) => r.skor_risiko >= 50).length} faskes skor ≥ 50`, "20 subkategori Efisiensi Risiko pada Fasilitas Kesehatan", "#3b82f6", null],
                ["Anomali ML", `${withMl} faskes dengan dokter anomali · ${kpi.pola_baru} pola baru`, "8 detektor tanpa label (termasuk GAN), suara dan Shapley", "#a78bfa", "anomali"],
                ["IoT alat medis", `${withIot} faskes dengan temuan`, "listrik alat vs klaim tindakan penunjang", "#14b8a6", "iot"],
              ] as [string, string, string, string, "anomali" | "iot" | null][]
            ).map(([h, v, d, c, page]) => (
              <button key={h} type="button" disabled={!page} onClick={() => page && onPage(page)} className="flex w-full items-start gap-2 rounded-md bg-ink p-2 text-left enabled:hover:bg-panel-2 disabled:cursor-default">
                <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c }} />
                <span className="min-w-0">
                  <span className="block font-medium">{h}</span>
                  <span className="block text-soft">{v}</span>
                  <span className="block text-[10.5px] text-muted">{d}</span>
                </span>
              </button>
            ))}
          </div>
        </Widget>
        <Widget title="Keputusan terakhir" caption="lewat action · tercatat di riwayat edit" bodyClass="p-0">
          <ul className="max-h-64 divide-y divide-line/50 overflow-y-auto text-xs">
            {(decisions ?? []).slice(0, 8).map((d, i) => (
              <li key={`${d.type_id}:${d.pk}:${i}`} className="px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <Badge text={TYPE_LABEL[d.type] ?? d.type} color="#f59e0b" />
                  <span className="min-w-0 flex-1 truncate font-medium">{d.title}</span>
                </div>
                <div className="mt-0.5 truncate text-[10.5px] text-muted">
                  {Object.entries(d.properties)
                    .filter(([k]) => !k.startsWith("catatan"))
                    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`)
                    .join(" · ")}
                </div>
              </li>
            ))}
            {decisions && decisions.length === 0 && <li className="px-3 py-4 text-center text-muted">Belum ada keputusan.</li>}
            {!decisions && <li className="px-3 py-4 text-center text-muted">Memuat…</li>}
          </ul>
        </Widget>
      </div>
    </div>
  );
}
