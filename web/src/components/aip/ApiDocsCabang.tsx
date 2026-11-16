"use client";

// API Documentation · the AI Agent Swarm Branch API v1's lifecycle and IoT lane for its overview pages, as plain text (the user,
// 2026-11-15: "api jangan visual banget ... bikin professional api docs gaya Runpod, OpenAI, Palantir"):
//   - the audit lifecycle: the orchestrator, then KC → kirim klaim → skoring ML v7 → indikasi → Box Karantina → AI Agent Swarm
//     → laporan → putusan (Box Karantina right after Indikasi, as in the branch system chart), one numbered row per stage that
//     opens its first endpoint;
//   - the IoT lane: alat medis (current clamp) → gateway RS → API → Indikasi, and the binding alat ↔ sesi ↔ pasien/kunjungan ↔
//     klaim with its two rules (the user, 2026-11-15: "IoT binding — device ID and patient ID and session").
// No vendor names: the LLM is "Model AI".

import type { ReactNode } from "react";
import type { CabangTahapKey } from "./ApiDocsTypes";
import type { Resource } from "./ApiDocsModel";
import { Kode } from "./ApiDocsShared";

const LAJUR: CabangTahapKey[] = ["audit", "akses", "klaim", "skor", "indikasi", "box", "swarm", "laporan", "putusan"];

function Baris({ no, judul, ket, kanan, onClick }: { no: string; judul: string; ket: ReactNode; kanan?: string; onClick?: () => void }) {
  return (
    <li className="flex min-w-0 gap-4 border-t border-white/[.06] py-3 first:border-t-0">
      <span className="w-5 shrink-0 pt-[1px] text-right font-mono text-[12px] text-[#6f7a88]">{no}</span>
      <span className="min-w-0 flex-1">
        {onClick
          ? <button type="button" onClick={onClick} className="text-left text-[14px] font-medium text-[#eef0f3] underline decoration-white/20 underline-offset-[5px] hover:text-[#c9bfff] hover:decoration-[#9d8cff]">{judul}</button>
          : <span className="text-[14px] font-medium text-[#eef0f3]">{judul}</span>}
        <span className="mt-0.5 block text-[13.5px] leading-[1.6] text-[#a3acb9]">{ket}</span>
      </span>
      {kanan && <span className="shrink-0 pt-[2px] text-[12px] text-[#6f7a88]">{kanan}</span>}
    </li>
  );
}

export function SiklusAudit({ resources, onNav }: { resources: Resource[]; onNav: (id: string) => void }) {
  const by = new Map(resources.map((r) => [r.key, r]));
  let no = 0;
  return (
    <ol className="mt-4">
      {LAJUR.map((k) => {
        const r = by.get(k);
        if (!r) return null;
        const label = k === "audit" ? "·" : String(++no);
        const ket = k === "audit" ? `Menjalankan tahap di bawah ini satu per satu: ${r.ket}.` : r.ket;
        return <Baris key={k} no={label} judul={r.nama} ket={ket} kanan={`${r.eps.length} endpoint`} onClick={() => onNav(r.eps[0].id)} />;
      })}
    </ol>
  );
}

export function AlurIot({ onSesi, onCek }: { onSesi?: () => void; onCek?: () => void }) {
  return (
    <>
      <ol className="mt-4">
        <Baris no="1" judul="Alat medis" ket="Sensor clamp di kabel daya membaca pola daya (jalan / siaga / mati) dan durasinya, tanpa membuka alat dan tanpa tanda vital." />
        <Baris no="2" judul="Gateway RS (AIoT)" ket="Menandatangani bacaan, mencatat sesi pemakaian, dan memanggil API dengan kunci gateway." />
        <Baris no="3" judul="Branch API · IoT" ket="Binding alat ke pasien dan kunjungan, bacaan, jangkar episode, dan cek tagihan dibanding pemakaian." onClick={onCek} />
        <Baris no="4" judul="Indikasi" ket="Tagihan yang tidak sesuai pemakaian terukur menjadi tag Indikasi untuk tahap berikutnya." />
      </ol>
      <p className="mt-6 text-[14.5px] leading-[1.75] text-[#a3acb9]">
        Satu <span className="font-medium text-[#eef0f3]">binding</span> mengikat empat hal selama satu jendela waktu:
      </p>
      <div className="mt-3 overflow-hidden rounded-lg border border-white/[.08]">
        {([["alat", "DV-029-VNT-02", "id alat di registri RS"], ["sesi", "ses_e06d6b23ff9a", "jendela pemakaian, dibuka dan ditutup gateway"],
          ["pasien · kunjungan", "ptk_… · KLM-000734", "token HMAC pasien (identitas asli tidak dikirim) dan kunjungan"], ["klaim", "blok iot", "hasil cek yang menempel di klaim"]] as const).map(([k, v, ket]) => (
          <div key={k} className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 border-t border-white/[.06] px-4 py-2.5 first:border-t-0">
            <span className="w-36 shrink-0 font-mono text-[12.5px] font-semibold text-[#eef0f3]">{k}</span>
            <span className="w-40 shrink-0 font-mono text-[12px] text-[#b9b0f0]">{v}</span>
            <span className="min-w-0 flex-1 text-[13px] text-[#8a94a3]">{ket}</span>
          </div>
        ))}
      </div>
      <ul className="mt-4 space-y-1.5 text-[13.5px] leading-[1.65] text-[#a3acb9]">
        <li>· Satu alat terikat ke satu pasien pada satu waktu; satu kunjungan boleh memakai banyak alat.</li>
        <li>· Bacaan di luar binding dicatat <Kode>tanpa_pasien</Kode>; setiap peristiwa binding di-hash ke akar Merkle episode.</li>
      </ul>
      {onSesi && (
        <p className="mt-4 text-[14px]">
          <button type="button" onClick={onSesi} className="font-medium text-[#c9bfff] underline decoration-[#9d8cff]/40 underline-offset-[5px] hover:text-white">Mulai binding: POST /iot/sesi →</button>
        </p>
      )}
    </>
  );
}
