import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "JKN Rumah Sakit", manifest: "/jkn-mobile/rs.webmanifest",
  icons: { icon: "/jkn-mobile/rs-192.png", apple: "/jkn-mobile/rs-192.png" },
  appleWebApp: { capable: true, title: "JKN RS", statusBarStyle: "black-translucent" },
};
export const viewport: Viewport = { themeColor: "#1d4ed8" };
export default function Layout({ children }: { children: React.ReactNode }) { return children; }
