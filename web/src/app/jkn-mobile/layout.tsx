import type { Viewport } from "next";

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#0f766e" };

export default function JknMobileLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">{children}</div>;
}
