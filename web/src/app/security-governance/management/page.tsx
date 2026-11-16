"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { Icon, type IconName } from "@/components/Icon";
import { auth, type Group, type Marking, type Organization, type User } from "@/lib/auth";
import { SecuritySectionNav } from "@/components/security/SecuritySectionNav";

const CONTROL_CARDS = [
  { title: "Users & identity", icon: "project" as IconName, status: "Available", text: "Invite, update, deactivate, or review accounts; inspect group, Organization, and Marking assignments and authentication status.", href: "/control-panel?section=users", cta: "Manage users", admin: true },
  { title: "Groups", icon: "layers" as IconName, status: "Available · core", text: "Create groups, manage member lists, and grant Markings through a group. Nested or external realms, membership expiry, and access-request policies are not exposed.", href: "/control-panel?section=groups", cta: "Manage groups", admin: true },
  { title: "Organizations", icon: "globe" as IconName, status: "Available", text: "Create and manage Organization records, members, guest members, and the Apply organization / Expand access permissions; spaces take Organizations as access requirements.", href: "/control-panel?section=organizations", cta: "Manage Organizations", admin: true },
  { title: "Markings", icon: "eye" as IconName, status: "Available", text: "Marking categories (conjunctive, disjunctive, classification levels; visible or hidden), Markings with Manage / Apply / Remove permissions separate from membership. Apply resource Markings from the Files details panel.", href: "/control-panel?section=markings", cta: "Manage Markings", admin: true },
  { title: "Project roles & resources", icon: "folder" as IconName, status: "Available · in Files", text: "Review Project role grants for users or groups and inspect effective resource Markings. Roles and mandatory requirements are separate checks.", href: "/files", cta: "Open Files & Projects", admin: false },
  { title: "Sign-in policy & audit", icon: "history" as IconName, status: "Available to administrators", text: "Manage supported sign-in safeguards and review sign-ins, failed attempts, and administrative events from the audit trail.", href: "/control-panel?section=security", cta: "Open security settings", admin: true },
] as const;

const NOT_AVAILABLE = [
  "Group realms, nested groups and membership expirations (access requests go through Approvals)",
  "Restricted views on branches and their approval workflow (a restricted view reads the backing dataset's current version)",
  "Maximum Project classification (a Project's classification is required when the setting is on, not capped)",
  "Discoverability of resources across Organizations",
];

const REFERENCE_SHOTS = [
  { src: "/security-governance/reference/management-manage-organizations.png", width: 1221, height: 966, alt: "Reference screenshot of Organization management", caption: "Organization management" },
  { src: "/security-governance/reference/management-manage-users.png", width: 1206, height: 689, alt: "Reference screenshot of user management", caption: "User administration" },
  { src: "/security-governance/reference/management-manage-group-members.png", width: 1762, height: 1146, alt: "Reference screenshot of group membership management", caption: "Group membership" },
  { src: "/security-governance/reference/management-manage-markings.png", width: 1245, height: 785, alt: "Reference screenshot of Marking administration", caption: "Marking administration" },
  { src: "/security-governance/reference/management-manage-roles.png", width: 1200, height: 873, alt: "Reference screenshot of custom role administration", caption: "Custom roles · Control Panel → Roles" },
  { src: "/security-governance/reference/management-project-template-page.png", width: 3456, height: 1384, alt: "Reference screenshot of Project template administration", caption: "Project templates · Control Panel → Spaces and templates" },
] as const;

type Counts = { users: User[]; groups: Group[]; organizations: Organization[]; markings: Marking[] };

export default function SecurityManagementPage() {
  const { me, enabled } = useAuth();
  const isAdmin = !enabled || me?.role === "admin";
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(true);
  const [directoryError, setDirectoryError] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    void Promise.all([
      auth.users().catch(() => null as User[] | null),
      auth.groups().catch(() => null as Group[] | null),
      auth.organizations().catch(() => null as Organization[] | null),
      auth.markings().catch(() => null as Marking[] | null),
    ]).then(([users, groups, organizations, markings]) => {
      if (live) {
        if (users && groups && organizations && markings) setCounts({ users, groups, organizations, markings });
        else setDirectoryError(true);
        setLoading(false);
      }
    });
    return () => { live = false; };
  }, [isAdmin]);

  const metrics = isAdmin ? [
    { label: "Active accounts", value: loading ? "…" : counts ? counts.users.filter((u) => u.status === "active" && !u.disabled).length : directoryError ? "Unavailable" : "—", href: "/control-panel?section=users", icon: "project" as IconName },
    { label: "Groups", value: loading ? "…" : counts?.groups.length ?? (directoryError ? "Unavailable" : "—"), href: "/control-panel?section=groups", icon: "layers" as IconName },
    { label: "Organizations", value: loading ? "…" : counts?.organizations.length ?? (directoryError ? "Unavailable" : "—"), href: "/control-panel?section=organizations", icon: "globe" as IconName },
    { label: "Markings", value: loading ? "…" : counts?.markings.length ?? (directoryError ? "Unavailable" : "—"), href: "/control-panel?section=markings", icon: "eye" as IconName },
  ] : [
    { label: "Your role", value: me?.role === "admin" ? "Admin" : "User", href: "/account", icon: "project" as IconName },
    { label: "Your groups", value: me?.groups.length ?? 0, href: "/account", icon: "layers" as IconName },
    { label: "Markings held", value: me?.markings.length ?? 0, href: "/account", icon: "eye" as IconName },
    { label: "Organization", value: me?.organization || "Not assigned", href: "/account", icon: "globe" as IconName },
  ];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink">
      <header className="flex h-14 items-center justify-between border-b border-line bg-panel px-5">
        <div className="flex items-center gap-2 text-sm text-soft"><Icon name="grid" className="h-4 w-4 text-ocean" /><span>Platform Apps</span><Icon name="right" className="h-3.5 w-3.5 text-muted" /><Link href="/security-governance" className="text-muted hover:text-white">Security &amp; Governance</Link><Icon name="right" className="h-3.5 w-3.5 text-muted" /><span>Management</span></div>
        <Link href="/security-governance" className="text-xs text-muted hover:text-white">Overview</Link>
      </header>
      <main className="mx-auto max-w-7xl space-y-5 p-5 md:p-8">
        <SecuritySectionNav active="Management" />
        <section className="relative overflow-hidden rounded-2xl border border-line bg-panel p-6 md:p-8">
          <div className="pointer-events-none absolute -right-16 -top-28 h-80 w-80 rounded-full border border-ocean/15" />
          <div className="relative flex flex-col justify-between gap-5 md:flex-row md:items-end">
            <div className="max-w-3xl">
              <span className="inline-flex items-center gap-2 rounded-full border border-ocean/30 bg-ocean/10 px-3 py-1 text-[11px] font-medium tracking-wide text-ocean"><Icon name="sliders" className="h-3.5 w-3.5" /> CONTROL DIRECTORY</span>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white md:text-3xl">Security &amp; Governance management</h1>
              <p className="mt-2 text-sm leading-6 text-soft">Find the live administration controls for people, groups, Organizations, Markings, sign-in settings, and resource access. Each status reflects features exposed by this deployment—not every control described in the source Management guide.</p>
            </div>
            <div className="rounded-xl border border-line bg-panel-2 px-4 py-3 text-xs"><span className="text-muted">Access level</span><div className="mt-1 font-medium text-soft">{isAdmin ? "Administrator controls" : "Personal access view"}</div></div>
          </div>
        </section>

        {!isAdmin && <div className="flex gap-3 rounded-xl border border-warn/25 bg-warn/5 p-4"><Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0 text-warn" /><div><p className="text-sm font-medium text-warn">Management actions require an administrator</p><p className="mt-1 text-xs leading-5 text-soft">You can review your personal access summary below. Ask a platform administrator to use the directory and security settings.</p></div></div>}

        <section aria-label="Live security directory metrics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((metric) => <Link key={metric.label} href={metric.href} className="rounded-xl border border-line bg-panel p-4 transition-colors hover:border-line-2 hover:bg-panel-2"><div className="flex items-center justify-between text-xs text-muted"><span>{metric.label}</span><Icon name={metric.icon} className="h-4 w-4 text-ocean" /></div><div className="mt-2 text-2xl font-semibold tabular-nums text-white">{metric.value}</div><div className="mt-1 text-[10px] text-muted">{isAdmin ? "Live directory data" : "Your account"}</div></Link>)}
        </section>

        <section>
          <div className="mb-3"><h2 className="text-base font-semibold text-white">Available management workflows</h2><p className="mt-1 text-xs text-muted">Select a control to continue in its existing Platform App.</p></div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {CONTROL_CARDS.map((item) => {
              const locked = item.admin && !isAdmin;
              return <article key={item.title} className="flex min-h-48 flex-col rounded-xl border border-line bg-panel p-4 transition-colors hover:border-line-2">
                <div className="flex items-start justify-between gap-3"><span className="rounded-lg border border-line bg-panel-2 p-2 text-ocean"><Icon name={item.icon} className="h-4 w-4" /></span><span className={`rounded-full border px-2 py-1 text-[10px] ${item.status.startsWith("Available") ? "border-ok/25 bg-ok/10 text-ok" : "border-warn/25 bg-warn/10 text-warn"}`}>{item.status}</span></div>
                <h3 className="mt-3 text-sm font-semibold text-white">{item.title}</h3><p className="mt-1 flex-1 text-xs leading-5 text-muted">{item.text}</p>
                {locked ? <span className="mt-3 text-[11px] text-warn">Administrator access required</span> : <Link href={item.href} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-ocean hover:underline">{item.cta}<Icon name="right" className="h-3 w-3" /></Link>}
              </article>;
            })}
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.1fr_.9fr]">
          <div className="rounded-xl border border-line bg-panel p-5">
            <div className="flex items-center gap-2"><Icon name="info" className="h-4 w-4 text-warn" /><h2 className="text-sm font-semibold text-white">Not available in this deployment</h2></div>
            <p className="mt-1 text-xs leading-5 text-muted">Roles, spaces, Project templates and constraints, marking categories and restricted views are in Control Panel and Security &amp; Governance; these parts of the Management guide are not.</p>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">{NOT_AVAILABLE.map((item) => <li key={item} className="flex gap-2 rounded-lg border border-line bg-panel-2 p-2.5 text-[11px] leading-4 text-soft"><Icon name="x" className="mt-0.5 h-3 w-3 shrink-0 text-muted" />{item}</li>)}</ul>
          </div>
          <div className="rounded-xl border border-line bg-panel p-5">
            <h2 className="text-sm font-semibold text-white">Safe management sequence</h2>
            <p className="mt-1 text-xs leading-5 text-muted">Use the existing controls as separate layers, and review potential access changes before making them.</p>
            <ol className="mt-4 space-y-3">{[
              "Confirm the user's account state and Organization assignment.",
              "Use group membership to manage shared access; check the Project role granted to that group.",
              "Grant only the required Markings, then verify effective Markings on the affected resources.",
              "Review Data Lineage and the available sign-in/activity trail; the latter is not a complete access-certification record.",
            ].map((text, index) => <li key={text} className="flex gap-3 text-xs leading-5 text-soft"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ocean/10 text-[10px] text-ocean">{index + 1}</span>{text}</li>)}</ol>
            <Link href="/security-governance/concepts" className="mt-4 inline-flex items-center gap-1 text-xs text-ocean hover:underline">Review the security model <Icon name="right" className="h-3 w-3" /></Link>
          </div>
        </section>

        <section>
          <div className="mb-3"><h2 className="text-base font-semibold text-white">Management UI references</h2><p className="mt-1 text-xs text-muted">These screenshots illustrate workflows from the source documentation; they do not represent active controls in this deployment.</p></div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {REFERENCE_SHOTS.map((shot) => <figure key={shot.src} className="overflow-hidden rounded-xl border border-line bg-panel"><div className="flex items-center justify-between border-b border-line bg-panel-2 px-3 py-2"><span className="text-[10px] font-medium text-soft">{shot.caption}</span><span className="text-[9px] uppercase tracking-wide text-muted">Reference</span></div><div className="flex min-h-36 items-center justify-center bg-white p-1"><Image src={shot.src} alt={shot.alt} width={shot.width} height={shot.height} sizes="(max-width: 1279px) 50vw, 30vw" className="h-auto max-h-52 w-full object-contain" /></div></figure>)}
          </div>
        </section>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-xs text-muted"><span>Administrative changes affect real users and resource access. Confirm scope and policy before applying them.</span><Link href="/security-governance" className="inline-flex items-center gap-1 text-ocean hover:underline">Back to overview <Icon name="right" className="h-3 w-3" /></Link></footer>
      </main>
    </div>
  );
}
