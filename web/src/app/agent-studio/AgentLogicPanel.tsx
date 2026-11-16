"use client";
import { useState } from "react";
/* AIP Logic agent configuration, as in the reference (095628): Repair Agent for Power Outages. */
function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return <div className="grid gap-2 border-b border-[#e3e8ed] py-3.5 md:grid-cols-[220px_1fr]"><div><p className="text-[12.5px] font-semibold">{label}</p><p className="mt-0.5 text-[11px] leading-snug text-[#7a8794]">{hint}</p></div><div className="text-[12px]">{children}</div></div>;
}
export function AgentLogicPanel({ notify }: { notify: (m: string) => void }) {
  const [deploy, setDeploy] = useState<"Probation" | "Production">("Probation");
  const [reqs, setReqs] = useState(["99.9% SLA met for 24 hours", "80% customers receive notification", "No active crews on-site", "All crew reports submitted"]);
  const [newReq, setNewReq] = useState("");
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[#f4f6f8] text-[#263746]">
      <div className="mx-auto max-w-[880px] p-4">
        <p className="text-[11px] text-[#7a8794]">Ontology Logic › <span className="text-[#263746]">Power Outages</span></p>
        <h2 className="mt-1 flex items-center gap-2 text-[17px] font-semibold"><span className="flex h-7 w-7 items-center justify-center rounded bg-[#c62f3b] text-white">⏻</span>Power Outages <span className="text-[11px] font-normal text-[#7a8794]">AIP Logic · agent configuration</span></h2>
        <div className="mt-3 rounded border border-[#d5dce3] bg-white px-4">
          <Row label="Agent name" hint="This will help distinguish between agents."><span className="font-medium text-violet-700">ϟ Repair Agent 3</span><span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-800">PLN Grid · ULP Bandung Timur</span></Row>
          <Row label="Input selection" hint="Select the objects the agent will act on."><p>Select <b>⏻ Power Outages</b> that match</p><p className="mt-1 rounded bg-[#f4f6f8] px-2 py-1 font-mono text-[11px]">Status &nbsp;is equal to&nbsp; <b>Triaged</b></p></Row>
          <Row label="Goal" hint="Set the agent's goal."><p><span className="mr-1.5 rounded bg-[#eef1f4] px-2 py-1">Recommend</span>⏻ Power Outages from <b>Resolved to Closed</b></p><p className="mt-1.5"><span className="mr-1.5 rounded bg-[#eef1f4] px-2 py-1">Assign</span>◉ Outage Investigator</p></Row>
          <Row label="Requirements" hint="Set necessary conditions before any action can be made.">
            {reqs.map((r, i) => <p key={r} className="flex items-center gap-2 border-b border-[#eef1f4] py-1"><span className="text-[#5b84ae]">▸</span><span className="flex-1">{r}</span><button onClick={() => setReqs(reqs.filter((_, j) => j !== i))} className="text-[#7a8794] hover:text-red-600">✕</button></p>)}
            <div className="mt-1.5 flex gap-2"><input value={newReq} onChange={(e) => setNewReq(e.target.value)} placeholder="Add requirement…" className="flex-1 rounded border border-[#d5dce3] px-2 py-1 outline-none" /><button onClick={() => { if (newReq.trim()) { setReqs([...reqs, newReq.trim()]); setNewReq(""); } }} className="rounded bg-[#263746] px-2.5 py-1 text-white">+ Add</button></div>
          </Row>
          <Row label="Tools" hint="Set the actions available to the agent."><p className="space-y-1"><span className="block">ϟ Resend notification</span><span className="block">ϟ Get connection status</span><span className="block">ϟ Assign Outage Investigator</span><span className="block">ϟ Set Power Outage status <span className="text-[#7a8794]">(requires human approval)</span></span></p></Row>
          <Row label="Data Access" hint="Set what data the agent has access to."><p className="flex flex-wrap gap-1.5">{["⏻ Power Outages", "Facilities (GI / Feeder)", "Customer", "Terrain / Vegetation", "Weather forecast", "Transmission Lines", "Material Orders"].map((d) => <span key={d} className="rounded bg-[#eef1f4] px-2 py-1 text-[11px]">{d}</span>)}</p></Row>
          <Row label="Deployment" hint="Set deployment mode.">
            <div className="flex gap-1.5">{(["Probation", "Production"] as const).map((d) => <button key={d} onClick={() => { setDeploy(d); notify(`Deployment mode set to ${d}. ${d === "Probation" ? "Agent can only recommend and assign operators." : "Requires approval in Control Panel."}`); }} className={`rounded px-3 py-1.5 font-medium ${deploy === d ? "bg-[#2f6fb2] text-white" : "border border-[#b9c4cf]"}`}>{d}</button>)}</div>
            <p className="mt-1 text-[11px] text-[#7a8794]">{deploy === "Probation" ? "Agent can make recommendations and assign other operators — no consequential action without human approval." : "Agent may execute approved tools directly. All executions remain in the audit trail."}</p>
          </Row>
        </div>
        <div className="mt-3 flex gap-2"><button onClick={() => notify("Agent configuration saved to AIP Logic (Repair Agent 3).")} className="rounded bg-[#263746] px-3 py-1.5 text-[12px] font-medium text-white">Save agent</button><button onClick={() => notify("Test run queued in AIP Logic — results will appear in the AI copilot logs.")} className="rounded border border-[#b9c4cf] bg-white px-3 py-1.5 text-[12px]">Test run</button></div>
      </div>
    </div>
  );
}
