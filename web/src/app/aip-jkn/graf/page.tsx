"use client";
import { GrafAgen } from "@/components/aip/GrafAgen";

/* Every agent of AIP JKN in one graph, on a page of its own: the whole screen to explore it. */
export default function GrafAgenPage() {
  return (
    <main className="flex h-screen flex-col bg-[#14181d]">
      <GrafAgen full />
    </main>
  );
}
