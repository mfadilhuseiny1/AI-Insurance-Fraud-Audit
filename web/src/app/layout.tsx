import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Naskh_Arabic } from "next/font/google";
import { AuthGate } from "@/components/AuthGate";
import DialogHost from "@/components/DialogHost";
import { AccessRequestHost } from "@/components/security/AccessRequestHost";
import { CheckpointHost } from "@/components/security/CheckpointForm";
import { QuickSearch } from "@/components/security/QuickSearch";
import { Sidebar } from "@/components/Sidebar";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// Arabic with full harakat needs a Naskh face to stay legible.
const naskh = Noto_Naskh_Arabic({ variable: "--font-naskh", subsets: ["arabic"], weight: ["400", "600"] });

export const metadata: Metadata = {
  title: "BluesandAI Parse",
  description: "Turn scanned books and documents into structured JSON and Markdown.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${naskh.variable} antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      {/* AI JKN Audit: no left panel, the thin top bar (Sidebar.tsx, off on AIP JKN) above the page at every width */}
      <body className="flex h-screen flex-col overflow-hidden">
        <AuthGate sidebar={<Sidebar />}>
          {children}
          <AccessRequestHost />
          <QuickSearch />
        </AuthGate>
        <DialogHost />
        <CheckpointHost />
      </body>
    </html>
  );
}
