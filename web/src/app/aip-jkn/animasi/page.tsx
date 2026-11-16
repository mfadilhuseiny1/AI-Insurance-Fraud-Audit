"use client";
import { useEffect, useState } from "react";
import { AnimasiAgen } from "@/components/aip/AnimasiAgen";

/* The multi-agent animation on a page of its own (for presenting): ?run=<engagement> replays that engagement. */
export default function AnimasiAgenPage() {
  const [run, setRun] = useState<string | null | undefined>(undefined);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the engagement named in the address, read once on entry
  useEffect(() => { setRun(new URLSearchParams(window.location.search).get("run")); }, []);
  return (
    <main className="flex h-screen flex-col bg-[#12161b]">
      {run !== undefined && <AnimasiAgen full initialRun={run} />}
    </main>
  );
}
