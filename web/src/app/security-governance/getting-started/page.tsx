"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { Icon, type IconName } from "@/components/Icon";
import { SecuritySectionNav } from "@/components/security/SecuritySectionNav";

const STEPS = [
  {
    id: "foundation",
    title: "Secure your data foundation",
    short: "Projects, groups & roles",
    status: "Available",
    statusKind: "ready",
    icon: "project" as IconName,
    summary: "Organize work into Projects, then use Groups and Project roles to give people consistent access across each part of the data pipeline.",
    actions: [
      { title: "Create or review Projects", detail: "Separate raw/source data, transformations, and curated ontology-ready data into projects with clear ownership.", href: "/files", cta: "Open Files & Projects" },
      { title: "Create access groups", detail: "Create Viewer, Editor, and Owner groups and assign people through group membership instead of one-off sharing.", href: "/control-panel?section=groups", cta: "Manage groups" },
      { title: "Grant project roles", detail: "In Files, select a Project and use its Roles panel. Keep project access separate from data-level Markings.", href: "/files", cta: "Review project roles" },
    ],
    callout: { title: "Recommended structure", text: "Use separate Projects for data ingestion, transformation, and curated/ontology data. Choose the least-privileged role each group needs; project roles alone do not override mandatory Markings." },
    image: { src: "/security-governance/project-foundation.png", width: 1869, height: 612, alt: "Reference screenshot of a project workspace with a project role panel", caption: "Reference: project workspace and role grants" },
    doc: "https://www.palantir.com/docs/foundry/security/securing-a-data-foundation/",
  },
  {
    id: "application",
    title: "Secure an operational application",
    short: "Nexus, Workshop & access",
    status: "Available",
    statusKind: "ready",
    icon: "device" as IconName,
    summary: "Keep application access and data access understandable. Operational users need access to the app and to the backing Nexus or datasets it uses.",
    actions: [
      { title: "Build the data model", detail: "Create or review the object and link types that represent the workflow and confirm their source data has the intended access controls.", href: "/ontology", cta: "Open Nexus Manager" },
      { title: "Build the application", detail: "Create the user-facing operational workflow in Workshop and place it in a Project with an appropriate editor group.", href: "/workshop", cta: "Open Workshop" },
      { title: "Separate consumer and editor access", detail: "Use distinct groups and Project roles when operators should use the app but not edit the application or its underlying data model.", href: "/control-panel?section=groups", cta: "Review access groups" },
    ],
    callout: { title: "Access has more than one layer", text: "A role on an Nexus or application project does not itself grant access to the backing data. Review the project roles and the permissions on the resources that supply the data." },
    image: { src: "/security-governance/business-application-access.png", width: 1863, height: 671, alt: "Reference screenshot illustrating application project access requirements", caption: "Reference: application project access requirements" },
    doc: "https://www.palantir.com/docs/foundry/security/securing-a-business-application/",
  },
  {
    id: "sensitive-data",
    title: "Protect sensitive data",
    short: "Markings & inheritance",
    status: "Available",
    statusKind: "ready",
    icon: "eye" as IconName,
    summary: "Use Markings for sensitive data such as personal or financial information. A Marking is an additional, mandatory access requirement—not a replacement for Project roles.",
    actions: [
      { title: "Define a Marking", detail: "Create a narrowly scoped Marking, document what it protects, and grant it only to the users and groups who need it.", href: "/control-panel?section=markings", cta: "Manage Markings" },
      { title: "Review resource protection", detail: "In Files, open an item and review its Markings. The item panel distinguishes Markings set directly from inherited Markings.", href: "/files", cta: "Open Files & Projects" },
      { title: "Trace downstream impact", detail: "Use Data Lineage to review the datasets and resources built from sensitive inputs before broadening access or changing protections.", href: "/lineage", cta: "Explore Data Lineage" },
    ],
    callout: { title: "Plan propagation before applying", text: "Markings can propagate through supported resource lineage. Check downstream consumers, remove or transform sensitive fields in the appropriate pipeline stage, then verify effective Markings on outputs." },
    image: { src: "/security-governance/sensitive-data-marking.png", width: 1148, height: 723, alt: "Reference screenshot of a centralized marking management interface", caption: "Reference: creating and managing a sensitive-data Marking" },
    doc: "https://www.palantir.com/docs/foundry/security/protecting-sensitive-data/",
  },
  {
    id: "organizations",
    title: "Plan organization collaboration",
    short: "Organization boundaries",
    status: "Partial support",
    statusKind: "partial",
    icon: "globe" as IconName,
    summary: "Organizations provide a strong boundary for users and resources. Decide whether partners belong in a separate Organization before setting up shared Projects.",
    actions: [
      { title: "Review Organization boundaries", detail: "Organizations are created and managed by administrators. Review the assignment for each account and resource that needs an Organization boundary.", href: "/control-panel?section=organizations", cta: "Manage Organizations" },
      { title: "Separate private and shared work", detail: "Use Projects and resource roles to scope work. Do not remove an Organization or Marking from inherited data until its sharing intent is reviewed.", href: "/files", cta: "Review Projects" },
      { title: "Coordinate identity and network setup", detail: "Partner identity providers, ingress/network rules, guest memberships, and mutual discoverability require deployment-level capabilities beyond this app.", href: "/control-panel?section=security", cta: "Review sign-in settings" },
    ],
    callout: { title: "Deployment limitation", text: "This deployment supports Organization administration and organization-based resource markings, but does not provide the full partner-federation flow (guest membership, cross-organization discovery, or shared-space setup). Do not treat this page as enabling external collaboration." },
    image: { src: "/security-governance/cross-organization-project.png", width: 786, height: 628, alt: "Reference screenshot illustrating a shared project in an organization collaboration scenario", caption: "Reference only: shared-project collaboration pattern" },
    doc: "https://www.palantir.com/docs/foundry/security/cross-organization-collaboration/",
  },
  {
    id: "permissions",
    title: "Review who can access a resource",
    short: "Roles, Markings & lineage",
    status: "Partial support",
    statusKind: "partial",
    icon: "search" as IconName,
    summary: "Inspect Project roles and effective Markings on a resource, and use lineage to understand inherited data protections before changing access.",
    actions: [
      { title: "Inspect a Project's roles", detail: "Open Files, select a Project, and review its Roles panel for direct or group-based grants.", href: "/files", cta: "Open Files & Projects" },
      { title: "Inspect effective Markings", detail: "On a supported Files item, review direct, inherited, and folder-level Markings in the resource details panel.", href: "/files", cta: "Review resource details" },
      { title: "Follow data lineage", detail: "Use Data Lineage to review source and downstream resources affected by inherited protections.", href: "/lineage", cta: "Open Data Lineage" },
    ],
    callout: { title: "Scope of the access check", text: "GET /api/auth/access?item_id=…(&user_id=… for administrators) gives the verdict: the role and operations on the Project (with the space's Organizations and inherited roles), the markings lacking for discovery and for the data, and whether the user can discover, read, download and edit. It does not cover downstream application logic (functions, exports) — treat it as a review aid, not an access certification." },
    image: { src: "/security-governance/permission-review.png", width: 1906, height: 897, alt: "Reference screenshot of a check-access panel on a resource", caption: "Reference: reviewing access requirements on a resource" },
    doc: "https://www.palantir.com/docs/foundry/security/checking-permissions/",
  },
  {
    id: "justification",
    title: "Require justifications for sensitive actions",
    short: "Checkpoints & review trail",
    status: "Available",
    statusKind: "guide",
    icon: "alert" as IconName,
    summary: "A checkpoint workflow can ask a user to explain a sensitive action and retain that justification for review. Configure them in the Checkpoints app: the platform asks for the justification before the interaction runs.",
    actions: [
      { title: "Identify actions that need explanation", detail: "Write down the operation, the reason a user should provide, the resource scope, and who will review the record.", href: "/security-auditing", cta: "Review audit events" },
      { title: "Configure the checkpoint", detail: "Choose checkpoint types (downloads, uploads, security changes, sign-in…), a scope and conditions, the prompt, and the justification kind.", href: "/checkpoints", cta: "Open Checkpoints" },
      { title: "Route access changes through Approvals", detail: "Requests for Project roles, groups and markings are reviewed by eligible users; required checkpoints are answered on the request.", href: "/approvals", cta: "Open Approvals" },
    ],
    callout: { title: "Audit logging is not a checkpoint", text: "audit.3 logs record what happened; a checkpoint asks why before it happens. Use both: records of submitted checkpoints are reviewable in Checkpoints and logged as userJustify." },
    image: { src: "/security-governance/checkpoint-prompt.png", width: 807, height: 579, alt: "Reference screenshot of a checkpoint justification prompt", caption: "Reference only: example justification prompt from the source guide" },
    doc: "https://www.palantir.com/docs/foundry/security/requesting-justification-for-sensitive-actions/",
  },
] as const;
const STORAGE_PREFIX = "bsai:security-governance:getting-started:v1:";

export default function SecurityGettingStartedPage() {
  const { me, enabled } = useAuth();
  const isAdmin = !enabled || me?.role === "admin";
  const [active, setActive] = useState(0);
  const [completed, setCompleted] = useState<string[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const step = STEPS[active];
  const storageKey = `${STORAGE_PREFIX}${me?.id ?? "anonymous"}`;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = localStorage.getItem(storageKey);
        setCompleted(saved ? (JSON.parse(saved) as string[]).filter((id) => STEPS.some((s) => s.id === id)) : []);
      } catch {
        setCompleted([]);
      }
      setLoadedKey(storageKey);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [storageKey]);

  useEffect(() => {
    if (loadedKey !== storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(completed));
    } catch {
      // Progress remains usable for this session if browser storage is unavailable.
    }
  }, [completed, loadedKey, storageKey]);

  const done = completed.includes(step.id);
  const toggleDone = () => setCompleted((old) => (old.includes(step.id) ? old.filter((id) => id !== step.id) : [...old, step.id]));
  const completedCount = completed.length;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-ink">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-panel px-5">
        <div className="flex min-w-0 items-center gap-2 text-sm text-soft"><Link href="/apps" className="text-muted hover:text-white">Platform Apps</Link><Icon name="right" className="h-3 w-3 text-muted" /><Link href="/security-governance" className="text-muted hover:text-white">Security &amp; Governance</Link><Icon name="right" className="h-3 w-3 text-muted" /><span className="truncate">Getting started</span></div>
        <Link href="/security-governance" className="ml-3 shrink-0 text-xs text-ocean hover:underline">Overview</Link>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl p-5 md:p-8">
          <div className="mb-5"><SecuritySectionNav active="Getting started" /></div>
          <section className="relative overflow-hidden rounded-2xl border border-line bg-panel p-6 md:p-8">
            <div className="pointer-events-none absolute -right-16 -top-28 h-80 w-80 rounded-full border border-ocean/15" />
            <div className="pointer-events-none absolute -right-7 -top-20 h-64 w-64 rounded-full border border-ocean/20" />
            <div className="relative flex flex-col justify-between gap-5 md:flex-row md:items-end">
              <div className="max-w-3xl">
                <span className="inline-flex items-center gap-2 rounded-full border border-ocean/30 bg-ocean/10 px-3 py-1 text-[11px] font-medium tracking-wide text-ocean"><Icon name="check" className="h-3.5 w-3.5" /> SECURITY ENABLEMENT</span>
                <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white md:text-3xl">Getting started with Security &amp; Governance</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-soft">Follow a practical path from project-level access to sensitive-data controls, application security, and permission reviews. Each step opens the relevant Platform App when that workflow is available.</p>
              </div>
              <div className="w-full max-w-xs rounded-xl border border-line bg-panel-2 p-3 md:w-60">
                <div className="flex items-center justify-between text-xs"><span className="text-muted">Your progress</span><span className="font-medium text-soft">{completedCount} / {STEPS.length}</span></div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink"><div className="h-full rounded-full bg-ocean transition-all" style={{ width: `${(completedCount / STEPS.length) * 100}%` }} /></div>
                <p className="mt-2 text-[10px] text-muted">Saved in this browser for your account.</p>
              </div>
            </div>
          </section>

          <div className="mt-5 grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
            <nav aria-label="Getting started steps" className="flex gap-2 overflow-x-auto pb-1 lg:block lg:space-y-1 lg:overflow-visible">
              {STEPS.map((item, index) => {
                const selected = index === active;
                const complete = completed.includes(item.id);
                return <button key={item.id} type="button" onClick={() => setActive(index)} aria-current={selected ? "step" : undefined} className={`flex min-w-56 items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors lg:w-full lg:min-w-0 ${selected ? "border-ocean/40 bg-ocean/10 text-white" : "border-transparent text-soft hover:border-line hover:bg-panel"}`}>
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs ${complete ? "bg-ok/15 text-ok" : selected ? "bg-ocean/20 text-ocean" : "bg-panel-2 text-muted"}`}>{complete ? <Icon name="check" className="h-4 w-4" /> : String(index + 1).padStart(2, "0")}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{item.title}</span><span className="mt-0.5 block truncate text-[10px] text-muted">{item.short}</span></span>
                  {item.statusKind !== "ready" && <span className="hidden rounded-full bg-warn/10 px-1.5 py-0.5 text-[9px] text-warn xl:inline">{item.status}</span>}
                </button>;
              })}
            </nav>

            <article className="min-w-0 overflow-hidden rounded-2xl border border-line bg-panel">
              <div className="border-b border-line p-5 md:p-6">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md border border-line bg-panel-2 p-2 text-ocean"><Icon name={step.icon} className="h-4 w-4" /></span>
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Step {active + 1} of {STEPS.length}</span>
                  <StatusBadge kind={step.statusKind} label={step.status} />
                </div>
                <h2 className="mt-3 text-xl font-semibold text-white">{step.title}</h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-soft">{step.summary}</p>
              </div>

              <div className="grid gap-5 p-5 md:p-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(280px,.85fr)]">
                <div className="space-y-4">
                  <div className="space-y-2">
                    {step.actions.map((action, index) => (
                      <div key={action.title} className="flex gap-3 rounded-xl border border-line bg-panel-2 p-3.5">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line-2 text-[10px] text-muted">{index + 1}</span>
                        <div className="min-w-0 flex-1">
                          <h3 className="text-sm font-medium text-soft">{action.title}</h3>
                          <p className="mt-1 text-xs leading-5 text-muted">{action.detail}</p>
                          {action.href.startsWith("/control-panel") && !isAdmin ? (
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]"><span className="rounded-full border border-warn/25 bg-warn/10 px-2 py-1 text-warn">Administrator access required</span><Link href="/account" className="text-ocean hover:underline">Review your account</Link></div>
                          ) : (
                            <Link href={action.href} target={"external" in action && action.external ? "_blank" : undefined} rel={"external" in action && action.external ? "noreferrer" : undefined} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-ocean hover:underline">{action.cta}<Icon name={"external" in action && action.external ? "external" : "right"} className="h-3 w-3" /></Link>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <section className={`rounded-xl border p-4 ${step.statusKind === "ready" ? "border-ocean/20 bg-ocean/5" : "border-warn/25 bg-warn/5"}`}>
                    <h3 className={`text-xs font-semibold ${step.statusKind === "ready" ? "text-ocean" : "text-warn"}`}>{step.callout.title}</h3>
                    <p className="mt-1.5 text-xs leading-5 text-soft">{step.callout.text}</p>
                  </section>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                    <a href={step.doc} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted hover:text-ocean">Read source guide <Icon name="external" className="h-3 w-3" /></a>
                    <div className="flex gap-2">
                      <button type="button" onClick={toggleDone} className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium ${done ? "border-ok/30 bg-ok/10 text-ok" : "border-line-2 bg-panel-2 text-soft hover:text-white"}`}><Icon name={done ? "check" : "plus"} className="h-3.5 w-3.5" />{done ? "Marked complete" : "Mark step complete"}</button>
                      {active < STEPS.length - 1 && <button type="button" onClick={() => setActive(active + 1)} className="inline-flex items-center gap-1 rounded-md bg-ocean px-3 py-2 text-xs font-medium text-white hover:bg-ocean-deep">Next step <Icon name="right" className="h-3 w-3" /></button>}
                    </div>
                  </div>
                </div>

                <figure className="min-w-0 self-start overflow-hidden rounded-xl border border-line bg-ink">
                  <div className="flex items-center justify-between border-b border-line bg-panel-2 px-3 py-2"><span className="text-[10px] font-medium uppercase tracking-wide text-muted">Reference UI</span><span className="text-[10px] text-muted">Illustrative screenshot</span></div>
                  <div className="relative flex min-h-48 items-center justify-center bg-white p-1">
                    <Image src={step.image.src} alt={step.image.alt} width={step.image.width} height={step.image.height} sizes="(max-width: 1279px) 100vw, 38vw" className="h-auto max-h-[390px] w-full object-contain" />
                  </div>
                  <figcaption className="px-3 py-2.5 text-[11px] leading-4 text-muted">{step.image.caption}. The screenshot is from the documentation reference and does not depict a live BluesandAI page.</figcaption>
                </figure>
              </div>

              <div className="flex items-center justify-between border-t border-line bg-panel-2/60 px-5 py-3 text-xs text-muted md:px-6">
                <button type="button" disabled={active === 0} onClick={() => setActive(Math.max(0, active - 1))} className="inline-flex items-center gap-1 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"><Icon name="left" className="h-3 w-3" />Previous</button>
                <span>{STEPS.filter((item) => completed.includes(item.id)).length} steps marked complete</span>
                <button type="button" disabled={active === STEPS.length - 1} onClick={() => setActive(Math.min(STEPS.length - 1, active + 1))} className="inline-flex items-center gap-1 hover:text-white disabled:cursor-not-allowed disabled:opacity-40">Next<Icon name="right" className="h-3 w-3" /></button>
              </div>
            </article>
          </div>
          <p className="mt-4 text-[11px] leading-5 text-muted">Completion is a personal checklist only. It does not grant permissions, apply Markings, configure external identity, or enforce a checkpoint.</p>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ kind, label }: { kind: string; label: string }) {
  const styles = kind === "ready" ? "border-ok/25 bg-ok/10 text-ok" : kind === "partial" ? "border-warn/25 bg-warn/10 text-warn" : "border-line-2 bg-panel-2 text-muted";
  return <span className={`rounded-full border px-2 py-1 text-[10px] ${styles}`}>{label}</span>;
}
