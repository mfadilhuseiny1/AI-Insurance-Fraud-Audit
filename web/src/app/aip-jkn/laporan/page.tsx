"use client";
import { useEffect, useState } from "react";
import { fraud } from "@/components/aip/fraudApi";
import { LaporanLengkap } from "@/components/aip/LaporanLengkap";

/* An engagement's long report on a page of its own (for reading, presenting, printing): ?run=<engagement>; without it,
   the last finished engagement the chat answers from. */
export default function LaporanPage() {
  const [run, setRun] = useState<string | null | undefined>(undefined);
  const [err, setErr] = useState("");
  const [print, setPrint] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const named = q.get("run");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the print mode named in the address, read once on entry
    setPrint(q.get("cetak") === "1");  // the print page (PDF): light, on A4; with embed=1 the app's shell is left out
    if (named) {
      setRun(named);
      return;
    }
    fraud.latest().then((l) => (l.ada && l.run ? setRun(l.run) : setErr("Belum ada penugasan AI Agent Swarm yang selesai.")))
      .catch((e) => setErr((e as Error).message));
  }, []);
  return (
    <main className={`min-h-screen overflow-y-auto text-[12px] ${print ? "bg-white" : "bg-[#12161b]"}`}>
      {run && <LaporanLengkap run={run} full print={print} />}
      {err && <p className="p-8 text-center text-[#ffb4b4]">{err}</p>}
    </main>
  );
}
