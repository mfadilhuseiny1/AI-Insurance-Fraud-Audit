"use client";

import { ArchitectureView } from "@/components/demo/ArchitectureView";

/* The end-to-end architecture of Grid Management System Intelligence, live (api/demo_grid_arsitektur.py): the path a
   telemetry reading, a kWh, a meter's signal, a transformer's load or a customer's identity takes. */
export default function GridArchitecturePage() {
  return (
    <ArchitectureView
      endpoint="/api/demo/grid/arsitektur"
      crumb={{ href: "/demo-grid", label: "Demo Grid" }}
      links={[
        { href: "/lineage?graph=gridsusut", label: "Data lineage" },
        { href: "/orbis/grid", label: "Bluesand Orbis — Grid" },
        { href: "/demo-grid", label: "Ringkasan susut", primary: true },
      ]}
      intro="Tujuh lapisan dari kiri ke kanan: telemetri SCADA, meter AMR/AMI, tagihan dan hasil P2TL mendarat, diolah menjadi neraca energi, menjadi objek jaringan di Nexus, dinilai fisika, aturan dan model NTL, lalu diputuskan di aplikasi. OT ke IT hanya satu arah. Pilih alur di atas atau klik sebuah blok."
    />
  );
}
