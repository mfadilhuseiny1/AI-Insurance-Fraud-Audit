"use client";

// System Architecture (the user, 2026-11-12: "tab baru namanya System Architecture, isinya ada arsitektur ML yg dipake sekarang
// sama ai agent swarm config", and the rule editor: "user bisa tambah rule pake bahasa manusia nanti AI analisis itu terus bisa
// integrasi ke rule engine ..."). Three parts: the ML v7 architecture with the rule engine in front (SysArchMl, its rule node opens the rule manager), the AI Agent Swarm config
// (SysArchSwarm, read-only) and the rule engine with its draft → test → approve flow (SysArchRules). A part is mounted the first
// time it is opened and kept, so a draft being written survives switching parts.

import { useCallback, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { SysArchMl } from "./SysArchMl";
import { SysArchRules } from "./SysArchRules";
import { SysArchSwarm } from "./SysArchSwarm";

type Bagian = "ml" | "swarm" | "rule";
const BAGIAN: [Bagian, string, IconName][] = [["ml", "Arsitektur ML v7", "cpu"], ["swarm", "AI Agent Swarm", "graph"], ["rule", "Rule engine", "logic"]];

export function SystemArchitectureView() {
  const [bagian, setBagian] = useState<Bagian>("ml");
  const [dibuka, setDibuka] = useState<Bagian[]>(["ml"]);
  // a rule changed in the ML v7 flow's rule manager: the full Rule engine page (if already opened) is remounted to read it again
  const [versiRule, setVersiRule] = useState(0);
  const pilih = (b: Bagian) => { setBagian(b); setDibuka((x) => (x.includes(b) ? x : [...x, b])); };
  const ruleBerubah = useCallback(() => setVersiRule((v) => v + 1), []);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/5 bg-[#1c2127] px-3 py-1.5 text-[11.5px]">
        {BAGIAN.map(([k, label, ikon]) => (
          <button key={k} onClick={() => pilih(k)} className={`flex items-center gap-1.5 rounded px-2 py-0.5 ${bagian === k ? "bg-white/10 text-white" : "text-[#abb3bf] hover:bg-white/5"}`}>
            <Icon name={ikon} className="h-3.5 w-3.5" />{label}
          </button>
        ))}
        <span className="ml-auto hidden text-[10.5px] text-[#8f99a8] md:inline">Sistem yang berjalan sekarang: model, agen, dan rule</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1500px] p-4 text-[12px]">
          {dibuka.includes("ml") && <div className={bagian === "ml" ? "" : "hidden"}><SysArchMl onBuka={pilih} onRuleBerubah={ruleBerubah} /></div>}
          {dibuka.includes("swarm") && <div className={bagian === "swarm" ? "" : "hidden"}><SysArchSwarm /></div>}
          {dibuka.includes("rule") && <div className={bagian === "rule" ? "" : "hidden"}><SysArchRules key={versiRule} /></div>}
        </div>
      </div>
    </div>
  );
}
