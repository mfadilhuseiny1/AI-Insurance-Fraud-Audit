"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { PlanView } from "@/components/solutionDesigner/Panels";
import { sd, type Diagram } from "@/lib/solutionDesigner";

/** AIP Critic's implementation plan as a page (printed to PDF by headless Chrome with ?embed=1&print=1). */
export default function PlanPage() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Diagram | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    sd.get(id).then(setD, (e: Error) => setErr(e.message));
  }, [id]);
  if (err) return <p className="p-8 text-sm text-bad">{err}</p>;
  if (!d) return <p className="p-8 text-sm text-muted">Loading…</p>;
  const plan = d.critic?.plan;
  return (
    <div className="h-full overflow-auto bg-ink">
      <style>{`@media print {
  .sd-plan-print, .sd-plan-print * { visibility: visible !important; color: #111 !important; border-color: #ccc !important; background: transparent !important; }
  .sd-plan-print { position: absolute !important; inset: 0 auto auto 0 !important; width: 100% !important; max-width: none !important; padding: 0.45in !important; background: white !important; }
  .sd-plan-print details { break-inside: avoid; }
}`}</style>
      <div className="sd-plan-print mx-auto max-w-3xl p-8" data-plan-page>
        <div className="mb-4 text-xs text-muted">Solution Designer · {d.name}</div>
        {plan ? <PlanView plan={plan} graph={d.graph} print /> : <p className="text-sm text-muted">No implementation plan yet: generate one from AIP Critic.</p>}
      </div>
    </div>
  );
}
