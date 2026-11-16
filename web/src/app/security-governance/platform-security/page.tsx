"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { SecuritySectionNav } from "@/components/security/SecuritySectionNav";

const PRINCIPLES = [
  ["Collection limitation", "Collect only data needed for a legitimate, defined purpose."],
  ["Data quality", "Keep information accurate, relevant, complete, and up to date."],
  ["Purpose specification", "Specify the reason for collection before processing begins."],
  ["Use limitation", "Use and disclose information only for approved purposes or another lawful basis."],
  ["Security safeguards", "Protect data against unauthorized access, loss, alteration, or disclosure."],
  ["Openness", "Make data practices, purposes, and responsible parties understandable."],
  ["Individual participation", "Plan how people can request access, correction, or deletion where applicable."],
  ["Accountability", "Assign owners and retain evidence that agreed controls are followed."],
] as const;

const REVIEW_ITEMS = [
  { id: "owner", label: "A data owner, governance contact, and escalation path are identified." },
  { id: "purpose", label: "Each data product has an approved, documented purpose and permitted use." },
  { id: "minimum", label: "Inputs and fields are minimized; unnecessary sensitive attributes are removed." },
  { id: "sensitivity", label: "Sensitive-data categories and required Project roles / Markings are reviewed." },
  { id: "lifecycle", label: "Retention periods, deletion eligibility, and rollback needs are defined before ingest." },
  { id: "exports", label: "Downloads, automated exports, webhooks, and other outbound copies are assessed." },
] as const;

const CONTROL_STATUS: { title: string; status: string; tone: string; icon: IconName; text: string; href?: string; cta?: string }[] = [
  { title: "Project roles & Markings", status: "Available · access controls", tone: "ready", icon: "eye", text: "Use least-privilege roles and mandatory Markings for resource access. This app does not expose a dedicated no-download role or per-operation download-policy editor.", href: "/control-panel?section=markings", cta: "Review Markings" },
  { title: "Dataset-version retention", status: "Available", tone: "ready", icon: "clock", text: "Dataset transaction retention policies can remove historical copies; open a dataset in Files, use its maintenance panel, and check the preview before applying.", href: "/files", cta: "Open Files & Projects" },
  { title: "Media-set retention", status: "Available", tone: "ready", icon: "database", text: "Media sets expose configurable retention for historical content. Review the policy in each set; retention is not a universal records-management schedule.", href: "/media-sets", cta: "Review Media Sets" },
  { title: "Authentication & session controls", status: "Available", tone: "ready", icon: "device", text: "Account settings support authenticator-based MFA, password policy, session review/revocation, and personal API tokens; administrators can review security settings.", href: "/control-panel?section=security", cta: "Open security settings" },
  { title: "Checkpoints & justifications", status: "Available", tone: "ready", icon: "lock", text: "Ask for an acknowledgment, a written or dropdown justification, or reauthentication before downloads, uploads, security changes, sign-in and other sensitive interactions; records are reviewable.", href: "/checkpoints", cta: "Configure checkpoints" },
  { title: "Cipher", status: "Available", tone: "ready", icon: "lock", text: "Encrypt, hash or decrypt values and columns with Cipher channels and licenses — in Pipeline Builder, Contour, Python transforms and object views (single values audited and rate limited).", href: "/cipher", cta: "Open Cipher" },
  { title: "Sensitive Data Scanner", status: "Available", tone: "ready", icon: "search", text: "Scan datasets and media sets for personal data (built-in PII, regex, overlap and language model conditions) and apply markings, create issues or obfuscate with Cipher. Matches are not a guarantee: review the conditions against your data.", href: "/sensitive-data-scanner", cta: "Open the scanner" },
  { title: "Data Lifetime", status: "Available", tone: "ready", icon: "clock", text: "Lineage-aware deletion policies: deletion dates set on root datasets flow to every dataset built from them, with overrides and a deletion log.", href: "/data-lifetime", cta: "Open Data Lifetime" },
  { title: "Export audit trail", status: "Available", tone: "ready", icon: "history", text: "audit.3 logs record every application's downloads and exports (dataExport with the size), loads, imports, shares and permission changes; detections alert on large, after-hours or marked exports.", href: "/security-auditing?categories=dataExport", cta: "Review exports" },
];

const SENSITIVE_TYPES = ["Names, contact details and identifiers", "Health records, diagnoses and treatment", "Financial records and account numbers", "Biometric images, templates or genetic data", "Birth dates, precise locations and device/activity identifiers", "Sensitive business data governed by contract or policy"];

export default function PlatformSecurityPage() {
  const [reviewed, setReviewed] = useState<string[]>([]);
  const toggle = (id: string) => setReviewed((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink">
      <header className="flex h-14 items-center justify-between border-b border-line bg-panel px-5">
        <div className="flex items-center gap-2 text-sm text-soft"><Icon name="grid" className="h-4 w-4 text-ocean" /><span>Platform Apps</span><Icon name="right" className="h-3.5 w-3.5 text-muted" /><Link href="/security-governance" className="text-muted hover:text-white">Security &amp; Governance</Link><Icon name="right" className="h-3.5 w-3.5 text-muted" /><span>Platform security</span></div>
        <Link href="/security-governance" className="text-xs text-muted hover:text-white">Overview</Link>
      </header>
      <main className="mx-auto max-w-7xl space-y-5 p-5 md:p-8">
        <SecuritySectionNav active="Platform security" />
        <section className="relative overflow-hidden rounded-2xl border border-line bg-panel p-6 md:p-8">
          <div className="pointer-events-none absolute -right-16 -top-28 h-80 w-80 rounded-full border border-ocean/15" />
          <div className="relative max-w-3xl">
            <span className="inline-flex items-center gap-2 rounded-full border border-ocean/30 bg-ocean/10 px-3 py-1 text-[11px] font-medium tracking-wide text-ocean"><Icon name="database" className="h-3.5 w-3.5" /> DATA PROTECTION &amp; GOVERNANCE</span>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white md:text-3xl">Platform security &amp; responsible data use</h1>
            <p className="mt-2 text-sm leading-6 text-soft">Plan how sensitive information is collected, used, protected, exported, and retired. This guide connects data-governance practices to current BluesandAI controls while making capability gaps visible.</p>
          </div>
          <div className="relative mt-5 flex flex-wrap gap-2"><Pill tone="ready">Access controls &amp; retention: available</Pill><Pill tone="limited">Download restrictions: by markings and checkpoints</Pill><Pill tone="ready">Checkpoints, Cipher &amp; scanning: available</Pill></div>
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.05fr_.95fr]">
          <div className="rounded-xl border border-line bg-panel p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-semibold text-white">Governance review checklist</h2><p className="mt-1 text-xs leading-5 text-muted">A discussion aid for the data owner, privacy, legal, security, and compliance teams.</p></div><span className="rounded-full border border-line bg-panel-2 px-2.5 py-1 text-[10px] text-muted">{reviewed.length} / {REVIEW_ITEMS.length} reviewed</span></div>
            <div className="mt-4 space-y-2">{REVIEW_ITEMS.map((item) => <label key={item.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-panel-2 p-3 hover:border-line-2"><input type="checkbox" checked={reviewed.includes(item.id)} onChange={() => toggle(item.id)} className="mt-0.5 h-3.5 w-3.5 accent-cyan-500" /><span className={`text-xs leading-5 ${reviewed.includes(item.id) ? "text-muted line-through" : "text-soft"}`}>{item.label}</span></label>)}</div>
            <p className="mt-3 text-[10px] leading-4 text-muted">Selections last only while this page remains open. This is not an approval, attestation, compliance assessment, or audit record. Consult your organization’s responsible experts and legal counsel for applicable requirements.</p>
          </div>
          <div className="rounded-xl border border-line bg-panel p-5">
            <h2 className="text-sm font-semibold text-white">Examples of sensitive data</h2><p className="mt-1 text-xs leading-5 text-muted">Sensitivity depends on context, purpose, jurisdiction, contractual terms, and organizational policy. This list is illustrative, not exhaustive or a legal classification.</p>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">{SENSITIVE_TYPES.map((item) => <li key={item} className="flex gap-2 rounded-lg border border-line bg-panel-2 p-2.5 text-[11px] leading-4 text-soft"><Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />{item}</li>)}</ul>
            <Link href="/control-panel?section=markings" className="mt-4 inline-flex items-center gap-1 text-xs text-ocean hover:underline">Review configured Markings<Icon name="right" className="h-3 w-3" /></Link>
          </div>
        </section>

        <section className="rounded-xl border border-line bg-panel p-5">
          <div className="mb-4"><h2 className="text-base font-semibold text-white">Data protection principles</h2><p className="mt-1 text-xs text-muted">A practical summary of the Fair Information Practice Principles (FIPPs) described in the reference guide.</p></div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{PRINCIPLES.map(([title, text], index) => <article key={title} className="rounded-lg border border-line bg-panel-2 p-3"><div className="flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-ocean/10 text-[10px] text-ocean">{index + 1}</span><h3 className="text-xs font-medium text-soft">{title}</h3></div><p className="mt-2 text-[11px] leading-4 text-muted">{text}</p></article>)}</div>
        </section>

        <section>
          <div className="mb-3"><h2 className="text-base font-semibold text-white">Controls available in this deployment</h2><p className="mt-1 text-xs text-muted">Use a control only for what it actually enforces; the matrix distinguishes active capabilities from source-guide references.</p></div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{CONTROL_STATUS.map((item) => <article key={item.title} className="flex min-h-44 flex-col rounded-xl border border-line bg-panel p-4"><div className="flex items-start justify-between gap-3"><span className="rounded-lg border border-line bg-panel-2 p-2 text-ocean"><Icon name={item.icon} className="h-4 w-4" /></span><Pill tone={item.tone}>{item.status}</Pill></div><h3 className="mt-3 text-sm font-semibold text-white">{item.title}</h3><p className="mt-1 flex-1 text-xs leading-5 text-muted">{item.text}</p>{item.href && item.cta && <Link href={item.href} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-ocean hover:underline">{item.cta}<Icon name="right" className="h-3 w-3" /></Link>}</article>)}</div>
        </section>

        <section className="rounded-xl border border-warn/25 bg-warn/5 p-5">
          <div className="flex items-start gap-3"><Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0 text-warn" /><div><h2 className="text-sm font-semibold text-warn">Download controls are only one layer</h2><p className="mt-1 text-xs leading-5 text-soft">Project access controls and Markings help limit who can open protected resources, but this application does not provide a configurable “view without download” permission. Controls on downloads do not cover every transfer path: external exports, webhooks, API clients, copy/paste, screenshots, and printing each need separate governance. Avoid describing this deployment as preventing data exfiltration.</p><p className="mt-2 text-xs leading-5 text-soft">Dataset and Media Set retention controls apply to stored history/content in their specific products. Review a dry-run or impact summary and retention obligations before applying destructive lifecycle changes.</p></div></div>
        </section>

        <section className="rounded-xl border border-line bg-panel p-5">
          <div className="flex flex-wrap items-end justify-between gap-2"><div><h2 className="text-base font-semibold text-white">Reference interface examples</h2><p className="mt-1 text-xs text-muted">Illustrations from the supplied platform documentation—not live BluesandAI enforcement screens.</p></div><div className="flex flex-wrap gap-3"><a href="https://www.palantir.com/docs/foundry/security/data-protection-and-governance/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-ocean hover:underline">Read data-governance guide<Icon name="external" className="h-3 w-3" /></a><a href="https://www.palantir.com/docs/foundry/security/download-controls/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-ocean hover:underline">Read download-controls guide<Icon name="external" className="h-3 w-3" /></a></div></div>
          <div className="mt-4 grid gap-3 md:grid-cols-2"><ReferenceImage src="/security-governance/reference/platform-security-markings.png" width={1148} height={723} alt="Reference UI screenshot of configured PII Marking controls" caption="Example Marking administration for sensitive information" /><ReferenceImage src="/security-governance/reference/platform-security-checkpoints.png" width={3740} height={1946} alt="Reference UI screenshot of a Checkpoints application review workflow" caption="Checkpoints review example · Checkpoints are not integrated in this deployment" /></div>
        </section>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-xs text-muted"><span>Governance status depends on your data, agreements, users, and jurisdiction; this page does not certify compliance.</span><Link href="/security-governance/third-party-applications" className="inline-flex items-center gap-1 text-ocean hover:underline">Third-party application security<Icon name="right" className="h-3 w-3" /></Link></footer>
      </main>
    </div>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone: string }) {
  const style = tone === "ready" ? "border-ok/25 bg-ok/10 text-ok" : tone === "limited" ? "border-warn/25 bg-warn/10 text-warn" : "border-line bg-panel-2 text-muted";
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] ${style}`}>{children}</span>;
}
function ReferenceImage({ src, width, height, alt, caption }: { src: string; width: number; height: number; alt: string; caption: string }) {
  return <figure className="overflow-hidden rounded-lg border border-line bg-ink"><figcaption className="border-b border-line bg-panel-2 px-3 py-2 text-[10px] text-soft">{caption}</figcaption><div className="flex min-h-36 items-center justify-center bg-white p-1"><Image src={src} alt={alt} width={width} height={height} sizes="(max-width: 1279px) 100vw, 50vw" className="h-auto max-h-64 w-full object-contain" /></div></figure>;
}
