"use client";

import { ArchitectureView } from "@/components/demo/ArchitectureView";

/* The end-to-end architecture of JKN Healthcare System Intelligence, live (api/demo_jkn_arsitektur.py): the path a
   claim, a doctor's billing, a device's power or an identity takes. */
export default function ArchitecturePage() {
  return (
    <ArchitectureView
      endpoint="/api/demo/jkn/arsitektur"
      crumb={{ href: "/demo-jkn", label: "Demo JKN" }}
      links={[
        { href: "/lineage?graph=jknaudit", label: "Data lineage" },
        { href: "/orbis", label: "Bluesand Orbis" },
        { href: "/demo-jkn/audit", label: "Ruang Kerja Audit", primary: true },
      ]}
      intro="Tujuh lapisan dari kiri ke kanan: data mendarat, diolah, menjadi objek operasional, dinilai oleh aturan, model dan bukti IoT, lalu diputuskan di aplikasi. Pilih alur di atas atau klik sebuah blok."
    />
  );
}
