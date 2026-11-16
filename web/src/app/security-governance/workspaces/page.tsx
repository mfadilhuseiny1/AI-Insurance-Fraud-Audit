"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { SecuritySectionNav } from "@/components/security/SecuritySectionNav";

/** The governance applications (each a working app; this page used to hold mockups of them). */
const GOVERNANCE_APPS: { id: string; name: string; href: string; icon: IconName; text: string }[] = [
  { id: "approvals", name: "Approvals", href: "/approvals", icon: "check", text: "Request Project access, group membership and markings; eligible reviewers approve and the change is applied." },
  { id: "checkpoints", name: "Checkpoints", href: "/checkpoints", icon: "lock", text: "Ask for a justification before downloads, uploads, security changes, sign-in and more; review the records." },
  { id: "cipher", name: "Cipher", href: "/cipher", icon: "lock", text: "Channels and licenses to encrypt, hash and decrypt values and columns across the platform." },
  { id: "compass", name: "Compass", href: "/compass", icon: "folder", text: "Quicksearch, tags, promoted items, Project cover pages, activity, access graphs and the Data Catalog." },
  { id: "sensitive-data-scanner", name: "Sensitive Data Scanner", href: "/sensitive-data-scanner", icon: "search", text: "Find personal data in datasets and media sets; apply markings, create issues or obfuscate." },
  { id: "data-lifetime", name: "Data Lifetime", href: "/data-lifetime", icon: "clock", text: "Lineage-aware deletion policies with overrides and a deletion log." },
  { id: "security-auditing", name: "Security auditing", href: "/security-auditing", icon: "history", text: "audit.3 logs of every application, detections and alerts, baselines, SIEM delivery and export datasets." },
  { id: "enterprise-security", name: "Enterprise security", href: "/enterprise-security", icon: "grid", text: "Identity posture: MFA, sessions, service accounts, tokens, ingress and audit monitoring." },
  { id: "infrastructure-security", name: "Infrastructure security", href: "/infrastructure-security", icon: "server", text: "Installation posture: encryption, network controls, connectors, malicious files, patching and backups." },
  { id: "code-scanning", name: "Code scanning", href: "/code-scanning", icon: "code", text: "SAST on every commit with built-in and custom rules; findings in Checks." },
];

export default function GovernanceAppsPage() {
  const router = useRouter();
  useEffect(() => {
    // links from before: /security-governance/workspaces?product=<id>
    const id = new URLSearchParams(window.location.search).get("product");
    const app = GOVERNANCE_APPS.find((a) => a.id === id);
    if (app) router.replace(app.href);
  }, [router]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink">
      <main className="mx-auto max-w-7xl space-y-5 p-5 md:p-8">
        <SecuritySectionNav active="Governance apps" />
        <div>
          <h1 className="text-2xl font-semibold">Governance applications</h1>
          <p className="mt-1 text-sm text-muted">The Security &amp; Governance products, each working on the platform&apos;s own data and permissions.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {GOVERNANCE_APPS.map((a) => (
            <Link key={a.id} href={a.href} className="flex gap-3 rounded-xl border border-line bg-panel p-4 hover:border-ocean/50">
              <span className="h-fit rounded-lg border border-line bg-panel-2 p-2 text-ocean"><Icon name={a.icon} className="h-4 w-4" /></span>
              <span><span className="block text-sm font-semibold text-white">{a.name}</span><span className="mt-1 block text-xs leading-5 text-muted">{a.text}</span></span>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
