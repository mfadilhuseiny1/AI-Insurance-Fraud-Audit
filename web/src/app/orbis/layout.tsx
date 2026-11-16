import type { Metadata } from "next";

import "./orbis.css";

export const metadata: Metadata = {
  title: "Bluesand Orbis — graf pengetahuan operasional",
  description: "Graf pengetahuan operasional demo JKN: dataset, pipeline, objek Nexus, machine learning dan rujukannya, regulasi, keputusan dan aplikasi.",
};

export default function OrbisLayout({ children }: { children: React.ReactNode }) {
  return children;
}
