import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "JKN Petugas", manifest: "/jkn-mobile/petugas.webmanifest",
  icons: { icon: "/jkn-mobile/petugas-192.png", apple: "/jkn-mobile/petugas-192.png" },
  appleWebApp: { capable: true, title: "JKN Petugas", statusBarStyle: "black-translucent" },
};
export const viewport: Viewport = { themeColor: "#0f766e" };
export default function Layout({ children }: { children: React.ReactNode }) { return children; }
