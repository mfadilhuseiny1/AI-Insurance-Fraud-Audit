"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { API_URL } from "@/lib/api";

/* Demo Grid "Akses per ULP" (api/demo_grid_akses.py): each demo.grid.* account against the demo's data, as Data
   Lineage colours it when viewed as that account (restricted views per ULP, object row policies, markings). */

type Akses = {
  built_at?: string | null;
  resources?: { id: string; name: string; kind: string }[];
  accounts?: { username: string; user_id: string; name: string; role: string; access: Record<string, { status: string; detail: string }> }[];
  portal_id?: string | null;
  pipeline_id?: string | null;
  portal_module?: string | null;
  request?: string | null;
  lineage?: string;
  password?: string;
};

const KIND: Record<string, string> = { restricted_view: "restricted view", object_type: "tipe objek Nexus", dataset: "dataset" };
const STATUS: Record<string, { label: string; cls: string }> = {
  view: { label: "terlihat", cls: "bg-ok/15 text-ok" },
  restricted_view: { label: "sebagian baris", cls: "bg-ocean/15 text-ocean" },
  no_data: { label: "0 baris", cls: "bg-amber-500/15 text-amber-500" },
  no_access: { label: "tertutup", cls: "bg-line/40 text-muted" },
};

const short = (s: string) => s.replace(/\s*\(demo\)\s*$/, "").replace(/\.parquet$/, "");

export function GridAksesSection() {
  const [d, setD] = useState<Akses | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch(`${API_URL}/api/demo/grid/akses`, { cache: "no-store", credentials: "include" })
      .then(async (r) => {
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof b.detail === "string" ? b.detail : r.statusText);
        return b as Akses;
      })
      .then(setD, (e: Error) => setErr(e.message));
  }, []);

  if (err) return <p className="rounded-xl border border-line bg-panel px-4 py-3 text-xs text-muted">Matriks akses: {err}</p>;
  if (!d) return <p className="text-xs text-muted">Memuat matriks akses…</p>;
  if (!d.accounts?.length || !d.resources?.length) return <p className="text-xs text-muted">Akses per ULP belum dibangun (langkah “akses” build demo).</p>;
  const resources = d.resources;
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="px-4 py-3 align-bottom font-medium text-muted">Akun demo</th>
              {resources.map((r) => (
                <th key={r.id} className="px-2 py-3 text-center align-bottom">
                  <div className="text-[11.5px] font-semibold">{short(r.name)}</div>
                  <div className="text-[10px] font-normal text-muted">{KIND[r.kind] ?? r.kind}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.accounts.map((a) => (
              <tr key={a.username} className="border-b border-line/50 last:border-0">
                <td className="px-4 py-2.5">
                  <div className="font-medium">{a.name}</div>
                  <div className="font-mono text-[10.5px] text-muted">{a.username}</div>
                  <div className="text-[10.5px] text-muted">{a.role}</div>
                </td>
                {resources.map((r) => {
                  const x = a.access[r.id];
                  const s = STATUS[x?.status ?? "no_access"] ?? STATUS.no_access;
                  return (
                    <td key={r.id} className="px-2 py-2.5 text-center" title={x?.detail}>
                      <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] ${s.cls}`}>
                        {x?.status === "no_access" && <Icon name="lock" className="h-3 w-3" />}
                        {s.label}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-line px-4 py-2 text-[11px] text-muted">
          Dihitung saat ini dari izin Project, penanda (PII, CEII, investigasi) dan kebijakan baris (atribut <span className="font-mono">kode_ulp</span> atau grup) — sama
          dengan warna Data Lineage mode Permissions saat “View as” akun tersebut. Arahkan kursor ke sel untuk alasannya.
          {d.password && <> Kata sandi semua akun demo: <span className="select-all font-mono">{d.password}</span>.</>}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {d.lineage && <Link href={d.lineage} className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 hover:border-ocean/60"><Icon name="layers" className="h-3.5 w-3.5 text-ocean" />Lineage (Permissions, View as)</Link>}
        {d.portal_module && <Link href={`/workshop/${d.portal_module}`} className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 hover:border-ocean/60"><Icon name="gauge" className="h-3.5 w-3.5 text-ocean" />Portal susut per ULP (Workshop)</Link>}
        {d.pipeline_id && <Link href={`/pipeline/${d.pipeline_id}`} className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 hover:border-ocean/60"><Icon name="code" className="h-3.5 w-3.5 text-ocean" />Pipeline akses per ULP</Link>}
        <Link href="/approvals" className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 hover:border-ocean/60"><Icon name="check" className="h-3.5 w-3.5 text-ocean" />Permintaan akses tamu (Approvals)</Link>
      </div>
    </div>
  );
}
