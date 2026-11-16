"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { governance, type DemoAkses } from "@/lib/governance";

/* "Akses per akun": the demo accounts against the demo's data — each cell is what Data Lineage shows when it is viewed
   as that account (blue: the account can view the data, red: it cannot), computed live from the rules. */

const CELL: Record<string, { bg: string; fg: string; label: string }> = {
  view: { bg: "#2f7fd6", fg: "#fff", label: "Dapat melihat" },
  no_access: { bg: "#e86a6a", fg: "#fff", label: "Tidak ada akses" },
  no_data: { bg: "#6b7586", fg: "#fff", label: "Tidak ada data" },
  unknown: { bg: "#c3ccd8", fg: "#1f2937", label: "Tidak diketahui" },
};
const KIND_LABEL: Record<string, string> = { restricted_view: "Restricted view", object_type: "Objek", dataset: "Dataset" };

/** The API's reasons (Data Lineage, in English) in the page's language. */
const why = (s: string) =>
  s
    .replace("no role with this permission on its Project", "tak punya peran di Project-nya")
    .replace(/^missing marking (.+)$/, "tak memegang penanda $1")
    .replace(/^the row policy leaves (\d+) of (\d+) rows$/, "kebijakan baris: $1 dari $2 baris")
    .replace(/^the object policy leaves (\d+) of (\d+) objects$/, "kebijakan objek: $1 dari $2 objek")
    .replace(/^(\d+) of (\d+) rows$/, "$1 dari $2 baris")
    .replace(/^(\d+) of (\d+) objects$/, "$1 dari $2 objek");

export function AccessPerAccount() {
  const [d, setD] = useState<DemoAkses | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    governance.akses().then(setD, (e: Error) => setErr(e.message));
  }, []);
  if (err) return <p className="rounded border border-line p-2 text-[11px] text-muted">Akses per akun: {err}</p>;
  if (!d) return <p className="py-6 text-center text-xs text-muted">Menghitung akses tiap akun…</p>;
  if (!d.accounts?.length)
    return <p className="rounded-lg border border-dashed border-line-2 p-4 text-center text-xs text-muted">Akun demo belum dibuat. Jalankan langkah “akses” pada build demo JKN.</p>;
  const g = d.governance ?? {};
  const flow: [string, string, IconName][] = [
    ["Pipeline audit", "clean/ — faskes, kasus, klaim, tren", "pipeline"],
    ["Pipeline akses berlapis", "tiap baris diberi kantor cabang pemiliknya", "pipeline"],
    ["akses/*_per_kc", "tetap di Project audit — akun demo tidak punya peran", "table"],
    ["Restricted view", "Portal: baris kantor cabang sendiri (atribut), semua baris bagi tim nasional", "lock"],
    ["Portal & objek", "Workshop portal, objek Faskes Audit (kebijakan objek + nilai rupiah berpenanda)", "cube"],
  ];
  const controls: { title: string; text: string; href: string; icon: IconName }[] = [
    { title: "Minta akses", text: `Formulir Request access menawarkan peran (${(g.request_form ?? []).join(", ")}); akun tamu sudah meminta bergabung — menunggu di Approvals.`, href: g.request ? `/approvals/${g.request}` : "/approvals", icon: "comment" },
    { title: "Keanggotaan sementara & 2 persetujuan", text: "Tim investigasi nasional: keanggotaan maks 90 hari, bergabung perlu 2 persetujuan, kontak email kelompok.", href: "/control-panel?section=groups", icon: "clock" },
    { title: "Restricted view terlindungi", text: `${g.protected_view ?? "Kasus per kantor cabang"}: kebijakannya hanya berubah lewat global branch dan review.`, href: "/restricted-views", icon: "lock" },
    { title: "Checkpoint ekspor portal", text: "Auditor KC dan analis memilih tujuan sebelum menyimpan data portal (ekspor dari browser).", href: "/checkpoints", icon: "download" },
    { title: "Ruang & peran ruang", text: `${g.space ?? "Ruang Audit Kantor Cabang"} dengan peran kustom “Koordinator portal” bagi tim nasional.`, href: "/control-panel?section=spaces", icon: "layers" },
    { title: "Marketplace", text: `${g.product ?? "Kebijakan baris per kantor cabang"}: kebijakan baris siap dipasang di wilayah lain.`, href: "/marketplace", icon: "folder" },
  ];
  return (
    <div className="space-y-3">
      <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {flow.map(([h, t, icon], i) => (
          <li key={h} className="relative rounded-lg border border-line bg-panel p-3">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-soft">
              <Icon name={icon} className="h-3.5 w-3.5 text-ocean" /> {h}
            </span>
            <p className="mt-1 text-[11px] leading-snug text-muted">{t}</p>
            {i < flow.length - 1 && <span className="absolute -right-2 top-1/2 hidden -translate-y-1/2 text-muted xl:block">›</span>}
          </li>
        ))}
      </ol>

      <div className="overflow-x-auto rounded-xl border border-line bg-panel" data-akses-matrix>
        <table className="w-full min-w-[56rem] text-[11px]">
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th className="px-3 py-2 font-medium">Akun (masuk dengan kata sandi di bawah)</th>
              {d.resources.map((r) => (
                <th key={r.id} className="px-2 py-2 font-medium">
                  <span className="block text-[9.5px] uppercase tracking-wide">{KIND_LABEL[r.kind] ?? r.kind}</span>
                  {r.name.replace(" (demo)", "")}
                </th>
              ))}
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {d.accounts.map((a) => (
              <tr key={a.username} className="border-b border-line last:border-0">
                <td className="px-3 py-2 align-top">
                  <div className="font-medium text-soft">{a.name}</div>
                  <div className="font-mono text-[10px] text-muted">{a.username}</div>
                  <div className="text-[10px] text-muted">{a.role}</div>
                </td>
                {d.resources.map((r) => {
                  const c = a.access[r.id] ?? { status: "unknown", detail: "" };
                  const s = CELL[c.status] ?? CELL.unknown;
                  return (
                    <td key={r.id} className="px-1.5 py-1.5 align-top">
                      <div className="rounded px-1.5 py-1" style={{ background: s.bg, color: s.fg }} title={c.detail || s.label}>
                        <div className="font-medium">{s.label}</div>
                        {c.detail && <div className="text-[10px] opacity-90">{why(c.detail)}</div>}
                      </div>
                    </td>
                  );
                })}
                <td className="px-2 py-2 align-top">
                  <Link href={`/lineage?graph=${d.graph}&viewAs=${a.user_id}`} className="whitespace-nowrap text-ocean hover:underline">
                    Lihat sebagai akun ini →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[11px]">
        {Object.values(CELL).map((c) => (
          <span key={c.label} className="flex items-center gap-1.5 text-muted">
            <span className="h-3 w-3 rounded-sm" style={{ background: c.bg }} /> {c.label}
          </span>
        ))}
        <span className="ml-auto rounded border border-line bg-ink px-2 py-1 text-soft">
          Kata sandi semua akun demo: <code className="font-mono">{d.password}</code>
        </span>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <Link href={`/lineage?graph=${d.graph}`} className="rounded-md border border-ocean/60 bg-ocean/10 px-3 py-1.5 text-white hover:bg-ocean/20">
          Data Lineage · warna Permissions, View as →
        </Link>
        {d.portal_module && (
          <Link href={`/workshop/${d.portal_module}`} className="rounded-md border border-line-2 px-3 py-1.5 text-soft hover:border-ocean hover:text-white">
            Portal Workshop per kantor cabang →
          </Link>
        )}
        {d.pipeline_id && (
          <Link href={`/pipeline/${d.pipeline_id}`} className="rounded-md border border-line-2 px-3 py-1.5 text-soft hover:border-ocean hover:text-white">
            Pipeline akses berlapis →
          </Link>
        )}
        <Link href="/restricted-views" className="rounded-md border border-line-2 px-3 py-1.5 text-soft hover:border-ocean hover:text-white">
          Restricted views →
        </Link>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {controls.map((c) => (
          <Link key={c.title} href={c.href} className="flex gap-2 rounded-lg border border-line bg-ink p-3 hover:border-ocean">
            <Icon name={c.icon} className="mt-0.5 h-4 w-4 shrink-0 text-ocean" />
            <span>
              <span className="block text-xs font-medium">{c.title}</span>
              <span className="text-[10.5px] text-muted">{c.text}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
