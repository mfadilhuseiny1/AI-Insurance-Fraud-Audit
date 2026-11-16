"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { Icon, type IconName } from "@/components/Icon";
import { AUDIT_LABEL, auth, type AuditEntry, type Group, type Marking, type Organization, type PublicPolicy, type SecuritySettings, type User } from "@/lib/auth";

type OverviewData = {
  policy: PublicPolicy | null;
  settings: SecuritySettings | null;
  users: User[] | null;
  groups: Group[] | null;
  markings: Marking[] | null;
  organizations: Organization[] | null;
  audit: AuditEntry[] | null;
};
const INITIAL: OverviewData = { policy: null, settings: null, users: null, groups: null, markings: null, organizations: null, audit: null };

/** Security & Governance hub: shows verified platform posture and routes into the existing security workflows. */
export default function SecurityGovernancePage() {
  const { me, enabled } = useAuth();
  const [data, setData] = useState(INITIAL);
  const [loading, setLoading] = useState(true);
  const isAdmin = !enabled || me?.role === "admin";

  useEffect(() => {
    let live = true;
    const load = async () => {
      const policy = await auth.policy().catch(() => null);
      if (!live) return;
      setData((old) => ({ ...old, policy }));
      if (isAdmin) {
        const [settings, users, groups, markings, organizations, audit] = await Promise.all([
          auth.settings().catch(() => null),
          auth.users().catch(() => null),
          auth.groups().catch(() => null),
          auth.markings().catch(() => null),
          auth.organizations().catch(() => null),
          auth.audit({ limit: 8 }).catch(() => null),
        ]);
        if (live) setData({ policy, settings: settings?.settings ?? null, users, groups, markings, organizations, audit });
      }
      if (live) setLoading(false);
    };
    void load();
    return () => {
      live = false;
    };
  }, [isAdmin]);

  const activeUsers = data.users?.filter((user) => user.status === "active" && !user.disabled).length;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink">
      <header className="flex h-14 items-center justify-between border-b border-line bg-panel px-5">
        <div className="flex items-center gap-2 text-sm text-soft"><Icon name="grid" className="h-4 w-4 text-ocean" /> Platform Apps <Icon name="right" className="h-3.5 w-3.5 text-muted" /> Security &amp; Governance</div>
        <Link href="/apps" className="text-xs text-muted hover:text-white">All Platform Apps</Link>
      </header>
      <main className="mx-auto max-w-7xl space-y-6 p-5 md:p-8">
        <section className="relative overflow-hidden rounded-2xl border border-line bg-panel p-6 md:p-8">
          <div className="pointer-events-none absolute -right-16 -top-28 h-80 w-80 rounded-full border border-ocean/15" />
          <div className="pointer-events-none absolute -right-7 -top-20 h-64 w-64 rounded-full border border-ocean/20" />
          <div className="pointer-events-none absolute right-8 -top-12 h-48 w-48 rounded-full border border-ocean/25" />
          <div className="relative max-w-3xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-ocean/30 bg-ocean/10 px-3 py-1 text-xs text-ocean"><Icon name="eye" className="h-3.5 w-3.5" /> PLATFORM TRUST &amp; CONTROL</div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">Security &amp; Governance</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-soft">
              A single entry point for identity, access control, data protection, and security accountability across BluesandAI Platform Apps.
              Use the controls below to review current settings and manage who can access platform resources.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link href="/security-governance/getting-started" className="inline-flex items-center gap-2 rounded-md bg-ocean px-3.5 py-2 text-sm font-medium text-white hover:bg-ocean-deep">
                <Icon name="play" className="h-4 w-4" /> Get started
              </Link>
              <Link href={isAdmin ? "/control-panel?section=security" : "/account"} className="inline-flex items-center gap-2 rounded-md border border-line-2 bg-panel-2 px-3.5 py-2 text-sm text-soft hover:text-white">
                <Icon name="sliders" className="h-4 w-4" /> {isAdmin ? "Review security settings" : "Review your account"}
              </Link>
              <Link href="/security-governance/workspaces" className="inline-flex items-center gap-2 rounded-md border border-line-2 bg-panel-2 px-3.5 py-2 text-sm text-soft hover:text-white"><Icon name="grid" className="h-4 w-4" /> Governance applications</Link>
              <Link href="/security-governance/concepts" className="inline-flex items-center gap-2 rounded-md border border-line-2 bg-panel-2 px-3.5 py-2 text-sm text-soft hover:text-white"><Icon name="layers" className="h-4 w-4" /> Concepts</Link>
              <Link href="/security-governance/management" className="inline-flex items-center gap-2 rounded-md border border-line-2 bg-panel-2 px-3.5 py-2 text-sm text-soft hover:text-white"><Icon name="sliders" className="h-4 w-4" /> Management</Link>
              <Link href="/security-governance/third-party-applications" className="inline-flex items-center gap-2 rounded-md border border-line-2 bg-panel-2 px-3.5 py-2 text-sm text-soft hover:text-white"><Icon name="plug" className="h-4 w-4" /> Third-party apps</Link>
              <Link href="/security-governance/platform-security" className="inline-flex items-center gap-2 rounded-md border border-line-2 bg-panel-2 px-3.5 py-2 text-sm text-soft hover:text-white"><Icon name="database" className="h-4 w-4" /> Platform security</Link>
              {isAdmin && <Link href="/control-panel?section=activity" className="inline-flex items-center gap-2 rounded-md border border-line-2 bg-panel-2 px-3.5 py-2 text-sm text-soft hover:text-white"><Icon name="history" className="h-4 w-4" /> View sign-in activity</Link>}
            </div>
          </div>
        </section>

        {isAdmin ? (
          <section aria-label="Security posture metrics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric icon="project" label="Active users" value={loading ? "…" : activeUsers ?? "—"} detail="Enabled platform accounts" href="/control-panel?section=users" />
            <Metric icon="layers" label="Access groups" value={loading ? "…" : data.groups?.length ?? "—"} detail="Membership and inherited access" href="/control-panel?section=groups" />
            <Metric icon="eye" label="Markings" value={loading ? "…" : data.markings?.length ?? "—"} detail="Mandatory data access controls" href="/control-panel?section=markings" />
            <Metric icon="globe" label="Organizations" value={loading ? "…" : data.organizations?.length ?? "—"} detail="User and resource boundaries" href="/control-panel?section=organizations" />
          </section>
        ) : (
          <section className="grid gap-3 sm:grid-cols-3">
            <Metric icon="project" label="Your access" value={me?.role === "admin" ? "Administrator" : "User"} detail={me?.organization || "Organization not assigned"} href="/account" />
            <Metric icon="layers" label="Groups" value={me?.groups.length ?? 0} detail="Inherited group membership" href="/account" />
            <Metric icon="eye" label="Markings held" value={me?.markings.length ?? 0} detail="Required to open marked resources" href="/account" />
          </section>
        )}

        <section>
          <div className="mb-3 flex items-end justify-between gap-3">
            <div><h2 className="text-base font-semibold text-white">Security controls</h2><p className="mt-1 text-xs text-muted">Review the implemented safeguards and go directly to their management workflows.</p></div>
            {loading && <span className="text-xs text-muted">Refreshing platform status…</span>}
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            <ControlCard icon="sliders" title="Identity & sign-in" status={identityStatus(data, me?.mfa_enabled)} summary={identitySummary(data, me?.mfa_enabled)} href={isAdmin ? "/control-panel?section=security" : "/account"} action={isAdmin ? "Manage sign-in policy" : "Manage your account"} />
            <ControlCard icon="layers" title="Access management" status="Role-based" summary="Manage users, groups and organizations, then grant project roles. Mandatory markings are enforced alongside resource permissions." href={isAdmin ? "/control-panel?section=users" : "/account"} action={isAdmin ? "Manage users and access" : "Review your access"} />
            <ControlCard icon="eye" title="Data protection" status="Marking-aware" summary="Markings provide all-or-nothing access requirements. Files and supported resources can inherit markings from their inputs or parent folders." href={isAdmin ? "/control-panel?section=markings" : "/files"} action={isAdmin ? "Manage markings" : "Open Files & Projects"} />
            <ControlCard icon="history" title="Audit & accountability" status={isAdmin ? (data.audit?.length ? "Recent events" : "Audit trail") : "Available to administrators"} summary={isAdmin ? "Review sign-ins, failed attempts and security administration events. Use filters in the activity view to investigate a user or event." : "Sign-in activity and security administration logs are available to platform administrators."} href={isAdmin ? "/control-panel?section=activity" : "/account"} action={isAdmin ? "Open sign-in activity" : "Open account settings"} />
            <ControlCard icon="check" title="Governed changes" status="Review workflows" summary="Use ontology proposals and project access workflows to review changes before they are applied. Keep approvals and checkpoints with the associated work." href="/ontology/proposals" action="Review proposals" />
            <ControlCard icon="folder" title="Projects & resources" status="Resource-level" summary="Projects organize people and work. Review roles and resource markings at the point where datasets, pipelines and other files are managed." href="/files" action="Open Files & Projects" />
          </div>
        </section>

        {isAdmin && (
          <section className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
            <div className="rounded-xl border border-line bg-panel p-4">
              <div className="mb-3 flex items-center justify-between"><div><h2 className="font-semibold text-white">Recent security activity</h2><p className="mt-0.5 text-xs text-muted">Latest events recorded by the platform.</p></div><Link href="/control-panel?section=activity" className="text-xs text-ocean hover:underline">View all</Link></div>
              {data.audit === null ? <p className="rounded-lg border border-line bg-panel-2 p-4 text-sm text-muted">Activity could not be loaded. Open the activity page to retry.</p> : data.audit.length === 0 ? <p className="rounded-lg border border-line bg-panel-2 p-4 text-sm text-muted">No security activity has been recorded yet.</p> : (
                <div className="divide-y divide-line">
                  {data.audit.slice(0, 6).map((entry, index) => <div key={`${entry.at}-${entry.event}-${index}`} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <span className={`mt-0.5 rounded-md p-1.5 ${entry.event === "sign_in_failed" ? "bg-bad/15 text-bad" : "bg-ocean/10 text-ocean"}`}><Icon name={entry.event === "sign_in_failed" ? "alert" : "history"} className="h-3.5 w-3.5" /></span>
                    <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"><span className="font-medium text-soft">{AUDIT_LABEL[entry.event] ?? entry.event.replaceAll("_", " ")}</span><span className="text-xs text-muted">{entry.username || entry.actor || "System"}</span></div><p className="mt-0.5 truncate text-xs text-muted">{entry.detail || "—"}</p></div>
                    <time className="shrink-0 text-[11px] text-muted" dateTime={entry.at}>{formatTime(entry.at)}</time>
                  </div>)}
                </div>
              )}
            </div>
            <div className="rounded-xl border border-line bg-panel p-4">
              <h2 className="font-semibold text-white">Shared responsibility</h2>
              <p className="mt-1 text-xs leading-5 text-muted">Security is a shared operating model. This app exposes platform controls; it does not verify external infrastructure or organizational compliance.</p>
              <div className="mt-4 space-y-3">
                <Responsibility title="Platform controls" items={["Authentication policy and account safeguards", "Resource roles, groups and mandatory markings", "Application-level security activity"]} />
                <Responsibility title="Your organization" items={["Choose appropriate data and authorized purposes", "Manage user identities and least-privilege access", "Review activity and meet retention obligations"]} />
              </div>
              <p className="mt-3 border-t border-line pt-3 text-[11px] leading-5 text-muted">Hosting, network, encryption-at-rest and infrastructure monitoring depend on deployment configuration and should be verified with your platform operator.</p>
            </div>
          </section>
        )}

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-xs text-muted">
          <span>Security controls shown here reflect the capabilities exposed by this BluesandAI deployment.</span>
          <Link href="/apps" className="inline-flex items-center gap-1 text-ocean hover:underline">Browse Platform Apps <Icon name="right" className="h-3 w-3" /></Link>
        </footer>
      </main>
    </div>
  );
}

function Metric({ icon, label, value, detail, href }: { icon: IconName; label: string; value: string | number; detail: string; href: string }) {
  return <Link href={href} className="rounded-xl border border-line bg-panel p-4 transition-colors hover:border-line-2 hover:bg-panel-2"><div className="flex items-center justify-between"><span className="text-xs text-muted">{label}</span><Icon name={icon} className="h-4 w-4 text-ocean" /></div><div className="mt-2 text-2xl font-semibold tabular-nums text-white">{value}</div><div className="mt-1 text-[11px] text-muted">{detail}</div></Link>;
}

function ControlCard({ icon, title, status, summary, href, action }: { icon: IconName; title: string; status: string; summary: string; href: string; action: string }) {
  return <article className="flex min-h-44 flex-col rounded-xl border border-line bg-panel p-4 transition-colors hover:border-line-2"><div className="flex items-start justify-between gap-2"><span className="rounded-lg border border-line bg-panel-2 p-2 text-ocean"><Icon name={icon} className="h-4 w-4" /></span><span className="rounded-full border border-line bg-panel-2 px-2 py-1 text-[10px] text-muted">{status}</span></div><h3 className="mt-3 text-sm font-semibold text-white">{title}</h3><p className="mt-1 flex-1 text-xs leading-5 text-muted">{summary}</p><Link href={href} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-ocean hover:underline">{action}<Icon name="right" className="h-3 w-3" /></Link></article>;
}

function Responsibility({ title, items }: { title: string; items: string[] }) {
  return <div className="rounded-lg border border-line bg-panel-2 p-3"><h3 className="text-xs font-semibold text-soft">{title}</h3><ul className="mt-2 space-y-1.5">{items.map((item) => <li key={item} className="flex gap-2 text-[11px] leading-4 text-muted"><Icon name="check" className="mt-0.5 h-3 w-3 shrink-0 text-ok" />{item}</li>)}</ul></div>;
}

function identityStatus(data: OverviewData, mfaEnabled?: boolean) {
  if (data.settings) return data.settings.mfa_required_all ? "MFA required" : data.settings.mfa_required_admins ? "Admin MFA" : data.settings.password_login ? "Policy configured" : "SSO only";
  return mfaEnabled ? "MFA enabled for you" : "Account protected";
}
function identitySummary(data: OverviewData, mfaEnabled?: boolean) {
  if (data.settings) {
    const providers = data.policy?.sso.length ?? 0;
    return `${data.settings.password_login ? "Password sign-in is enabled" : "Password sign-in is disabled"}; ${providers} single sign-on provider${providers === 1 ? "" : "s"} configured. Sessions and password policy are managed centrally.`;
  }
  return `Your account ${mfaEnabled ? "has two-factor authentication enabled" : "uses platform sign-in controls"}. Administrators manage the organization-wide sign-in policy.`;
}
function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
