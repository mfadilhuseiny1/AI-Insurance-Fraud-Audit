"use client";

import Explorer from "@/components/orbis/Explorer";
import { ORBIS_GRID, setOrbisVariant } from "@/lib/orbis";

/* Bluesand Orbis on the grid demo (api/orbis_grid.py): the same explorer, its own graph and vector index orbis-grid-1. */
export default function OrbisGridPage() {
  setOrbisVariant(ORBIS_GRID);
  return (
    <div className="kg-root flex min-h-0 flex-1 flex-col">
      <Explorer key="grid" />
    </div>
  );
}
