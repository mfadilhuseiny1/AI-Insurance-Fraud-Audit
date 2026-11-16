"use client";

import Explorer from "@/components/orbis/Explorer";
import { ORBIS_JKN, setOrbisVariant } from "@/lib/orbis";

export default function OrbisPage() {
  setOrbisVariant(ORBIS_JKN);
  return (
    <div className="kg-root flex min-h-0 flex-1 flex-col">
      <Explorer key="jkn" />
    </div>
  );
}
