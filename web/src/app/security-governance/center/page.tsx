"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ControlDetails, PostureScore, ProtectionFlow } from "@/components/governance/GovernanceView";
import { governance, type GovernanceOverview } from "@/lib/governance";

/** Governance Center: one Project's data protection end to end, read from every security application at once. */
export default function GovernanceCenterPage() {
  return (
    <Suspense>
      <Center />
    </Suspense>
  );
}

function Center() {
  const params = useSearchParams();
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [pid, setPid] = useState<string | null>(params.get("project"));
  const [d, setD] = useState<GovernanceOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    governance.projects().then(
      (ps) => {
        setProjects(ps);
        setPid((cur) => cur ?? ps.find((p) => p.name === "JKN Healthcare System Intelligence")?.id ?? ps[0]?.id ?? null);
      },
      (e: Error) => setErr(e.message),
    );
  }, []);
  useEffect(() => {
    if (!pid) return;
    let alive = true;
    governance.project(pid).then(
      (x) => alive && (setD(x), setErr(null), setLoadedFor(pid)),
      (e: Error) => alive && (setErr(e.message), setLoadedFor(pid)),
    );
    const u = new URL(window.location.href);
    u.searchParams.set("project", pid);
    window.history.replaceState(null, "", u.toString());
    return () => {
      alive = false;
    };
  }, [pid]);
  const loading = pid !== loadedFor;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink">
      <header className="flex h-14 items-center gap-2 border-b border-line bg-panel px-5 text-sm text-soft">
        <Icon name="grid" className="h-4 w-4 text-ocean" />
        <Link href="/apps" className="hover:text-white">Platform Apps</Link>
        <Icon name="right" className="h-3.5 w-3.5 text-muted" />
        <Link href="/security-governance" className="hover:text-white">Security &amp; Governance</Link>
        <Icon name="right" className="h-3.5 w-3.5 text-muted" />
        <span className="text-white">Governance Center</span>
      </header>
      <main className="mx-auto max-w-[1500px] space-y-5 p-5 md:p-6">
        <section className="flex flex-wrap items-center gap-4 rounded-2xl border border-line bg-panel p-5">
          {d && !loading ? <PostureScore data={d} /> : <div className="h-16 w-16 animate-pulse rounded-full bg-line/40" />}
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold">Governance Center</h1>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted">
              Perlindungan data satu Project, dari hulu ke hilir: apa yang menemukan data sensitif, siapa yang boleh membukanya, bagaimana identitas disamarkan, kapan
              alasan diminta, kapan data dihapus, dan apa yang tercatat. Setiap kotak membaca aplikasi keamanan yang sebenarnya dan menautkan ke sana.
            </p>
          </div>
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            Project
            <select value={pid ?? ""} onChange={(e) => setPid(e.target.value)} className="min-w-64 rounded-md border border-line-2 bg-ink px-2 py-1.5 text-sm text-white">
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        </section>
        {err && <p className="rounded border border-bad/40 bg-bad/5 p-2 text-xs text-bad">{err}</p>}
        {loading && !err && (
          <div className="flex items-center justify-center gap-3 py-16 text-sm text-muted">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-line-2 border-t-ocean" /> Membaca kontrol keamanan Project…
          </div>
        )}
        {d && !loading && (
          <>
            <section>
              <div className="mb-2 flex items-baseline gap-2">
                <h2 className="text-[14px] font-semibold">{d.project.name}</h2>
                <span className="text-[11px] text-muted">{d.datasets} dataset</span>
                {d.approvals.pending.length > 0 && (
                  <Link href="/approvals" className="ml-auto text-[11px] text-warn hover:underline">{d.approvals.pending.length} permintaan akses menunggu →</Link>
                )}
              </div>
              <ProtectionFlow data={d} />
            </section>
            <ControlDetails data={d} />
          </>
        )}
      </main>
    </div>
  );
}
