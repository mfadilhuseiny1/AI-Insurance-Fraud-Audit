"use client";

import { SemanticNexus, type NexusConfig } from "@/components/vertex/SemanticNexus";

/* JKN Intelligence Nexus — the JKN healthcare-audit demo's semantic knowledge graph in Vertex (api/jkn_nexus.py). */

const JKN: NexusConfig = {
  api: "/api/jkn-nexus",
  title: "JKN Intelligence Nexus",
  targetNames: [
    "Wilayah JKN", "Kantor Cabang JKN", "Faskes Audit JKN", "RS Jejaring IoT JKN", "Faskes JKN",
    "Dokter Audit JKN", "Klaim JKN", "Tarif INA-CBG", "Tindakan Penunjang Diklaim JKN",
    "Kasus Rujukan Berisiko JKN", "Peringatan Risiko JKN", "Temuan Aturan JKN", "Temuan Risiko JKN", "Kategori Risiko JKN",
    "Alat Medis IoT JKN", "Temuan IoT JKN", "Jadwal Audit Klaim", "Verifikator JKN",
  ],
  termByName: {
    "Klaim di faskes (demo)": "billed by", "Peringatan untuk klaim (demo)": "flags", "Temuan aturan untuk klaim (demo)": "flags",
    "Audit oleh verifikator (demo)": "assigned to", "Rujukan antar faskes (demo)": "refers to", "Faskes di kantor cabang (demo)": "served by",
    "Temuan per kategori (demo)": "classified as", "Audit per kategori (demo)": "classified as", "Temuan di faskes (demo)": "found at",
    "Kasus ke faskes (demo)": "referred to", "DPJP kasus (demo)": "treated by", "Kasus dari faskes (demo)": "referred from",
    "Dokter perujuk kasus (demo)": "referred by", "Dokter praktik di faskes (demo)": "practises at", "Klaim JKN di faskes audit (demo)": "billed by",
    "Tindakan diklaim pada temuan IoT (demo)": "reconciled in", "Temuan IoT pada alat (demo)": "measured on", "Alat medis IoT di faskes (demo)": "installed at",
    "Tindakan penunjang oleh dokter (demo)": "requested by", "Temuan IoT di faskes (demo)": "found at", "Wilayah induk (demo)": "part of",
    "RS di kabupaten/kota (demo)": "located in", "RS jejaring = faskes audit (demo)": "same as", "Temuan IoT di RS jejaring (demo)": "found at",
    "Alat di RS jejaring (demo)": "installed at", "Temuan IoT di kabupaten/kota (demo)": "located in",
    "Klaim dibayar per tarif INA-CBG (demo)": "paid at", "Deret waktu faskes (demo)": "trend of",
  },
  examples: [
    "Which objects show a fraud indication at a facility?",
    "How does a risky referral connect facilities and doctors?",
    "How does IoT device usage verify claimed procedures?",
    "Who audits a risky claim?",
  ],
  askPlaceholder: "Ask semantically: how does IoT device usage verify claimed procedures?",
  hierarchyStart: "Wilayah JKN",
  appLink: { href: "/demo-jkn", label: "JKN demo" },
  edgeLabels: {
    physical_asset: "Device installed at",
    electrical_topology: "Organisation & geography",
    operational_dependency: "Audit & case workflow",
    data_lineage: "Claim & device evidence",
    logical: "Risk analytics",
  },
};

export default function JknIntelligenceNexusPage() {
  return <SemanticNexus cfg={JKN} />;
}
