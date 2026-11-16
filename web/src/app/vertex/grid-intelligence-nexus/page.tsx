"use client";

import { SemanticNexus, type NexusConfig } from "@/components/vertex/SemanticNexus";

/* Grid Intelligence Nexus — the grid demo's semantic knowledge graph in Vertex (api/grid_nexus.py). */

const GRID: NexusConfig = {
  api: "/api/grid-nexus",
  title: "Grid Intelligence Nexus",
  targetNames: [
    "Grid Primary Substation", "Grid Feeder", "Grid Distribution Substation", "Grid Customer",
    "Grid Substation Energy Balance", "Grid Feeder Energy Balance", "Grid Loss Finding", "Grid Meter Inspection P2TL",
    "Grid Feeder Outage", "Titik Ukur SCADA Grid", "Grid Work Order", "Transmission Line West Java (OSM)",
    "Transmission Substation West Java (OSM)", "Industrial Estate West Java (OSM)", "Grid P2TL Field Visit", "Grid Field Crew",
  ],
  termByName: {
    "Feeder from primary substation (grid demo)": "powered by", "Customer on distribution substation (grid demo)": "belongs to",
    "Customer on feeder (grid demo)": "supplied by", "Distribution substation on feeder (grid demo)": "fed by",
    "Feeder energy balance (grid demo)": "measures loss of", "Substation energy balance (grid demo)": "measures loss of",
    "Loss finding at substation (grid demo)": "flagged at", "Loss finding for customer (grid demo)": "suspects",
    "Loss finding on feeder (grid demo)": "flagged on", "Feeder outage (grid demo)": "interrupts",
    "P2TL meter inspection of customer (grid demo)": "inspects", "Feeder SCADA measurement point (grid demo)": "measures",
    "Work order from loss finding (grid demo)": "raised from", "Work order at substation (grid demo)": "executed at",
    "Primary substation supplied by EHV substation (grid demo)": "powered by", "Field visit by crew (grid demo)": "performed by",
    "Field visit for loss finding (grid demo)": "follows up", "Field visit to customer (grid demo)": "visits",
    "Line endpoints at substation (West Java, grid demo)": "ends at",
  },
  examples: [
    "Which objects contribute to non-technical losses?",
    "What is the relationship between a feeder and a customer?",
    "How does a loss finding become an inspection?",
    "What measures a feeder?",
  ],
  askPlaceholder: "Ask semantically: which objects contribute to non-technical losses?",
  hierarchyStart: "Grid Primary Substation",
  appLink: { href: "/pln-cockpit", label: "PLN Cockpit" },
};

export default function GridIntelligenceNexusPage() {
  return <SemanticNexus cfg={GRID} />;
}
