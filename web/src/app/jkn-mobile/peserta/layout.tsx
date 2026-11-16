import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "JKN Peserta", manifest: "/jkn-mobile/peserta.webmanifest",
  icons: { icon: "/jkn-mobile/peserta-192.png", apple: "/jkn-mobile/peserta-192.png" },
  appleWebApp: { capable: true, title: "JKN Saya", statusBarStyle: "black-translucent" },
};
export const viewport: Viewport = { themeColor: "#15803d" };
export default function Layout({ children }: { children: React.ReactNode }) { return children; }
