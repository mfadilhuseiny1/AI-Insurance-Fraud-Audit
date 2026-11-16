import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Binding IoT Faskes",
  description: "Binding device IoT ke pasien dengan scan QR gelang dan QR device.",
  appleWebApp: { capable: true, title: "Binding IoT", statusBarStyle: "black-translucent" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#0f766e" };

export default function FaskesLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">{children}</div>;
}
