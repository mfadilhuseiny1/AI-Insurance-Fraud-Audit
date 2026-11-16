"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { SecuritySectionNav } from "@/components/security/SecuritySectionNav";

const CONCEPTS = [
  {
    id: "organizations",
    title: "Organizations & spaces",
    short: "Identity boundaries",
    status: "Partial support",
    kind: "partial",
    icon: "globe" as const,
    lead: "Organizations are mandatory boundaries for people and shared resources. They are distinct from groups: a user belongs to at most one Organization here, while groups collect users for access administration.",
    points: [
      "An Organization is also an access requirement on supported resources; the user must belong to the Organization attached to the resource.",
      "Guest members of an Organization hold its access requirement too; Apply organization and Expand access permissions decide who may add it to resources or remove it (Control Panel → Organizations).",
      "Every Project is in a space: a space's Organizations are its access requirements (any one of them), its inherited roles apply to all its Projects and its role set limits the roles they grant (Control Panel → Spaces and templates).",
    ],
    image: { src: "/security-governance/reference/concepts-namespace-org-projects-diagram.png", width: 2660, height: 1584, alt: "Reference diagram showing an organization-bounded shared space and projects", caption: "Reference-only model for Organizations, Spaces, and Projects" },
    href: "/control-panel?section=organizations",
    action: "Manage Organizations",
    doc: "https://www.palantir.com/docs/foundry/security/orgs-and-spaces/",
  },
  {
    id: "projects",
    title: "Projects & roles",
    short: "Discretionary access",
    status: "Available",
    kind: "ready",
    icon: "project" as const,
    lead: "Projects organize work and define the main boundary for discretionary permissions. A Project role answers what a person or group may do in that workspace; mandatory data controls still apply alongside it.",
    points: [
      "The Files workflow supports Project roles for users and groups: Viewer, Editor, and Owner.",
      "Project roles govern resource operations; use a group role where several people should share the same access, and keep grants as narrow as the task allows.",
      "A role is not a substitute for a Marking or Organization membership. A person must satisfy all applicable layers to open a protected resource.",
    ],
    image: { src: "/security-governance/reference/concepts-project-containment.png", width: 1928, height: 1320, alt: "Reference diagram of a project containing work and its outputs", caption: "Reference: keep a project's work and outputs together" },
    href: "/files",
    action: "Review Projects & roles",
    doc: "https://www.palantir.com/docs/foundry/security/projects-and-roles/",
  },
  {
    id: "groups",
    title: "Users & groups",
    short: "Manage people together",
    status: "Available",
    kind: "ready",
    icon: "layers" as const,
    lead: "Groups are a practical way to assign Project roles and Markings to people as a unit. User, Group, and Organization records can be administered in Control Panel by a platform administrator.",
    points: [
      "The current Group workflow supports creating a group, choosing its members, and granting the group Markings.",
      "The user directory shows account state, Organization, groups, Markings, admin role, MFA state, and recent sign-in details.",
      "The advanced management features in the reference guide—nested/external realms, membership expiry, custom access-request forms, and approval policies—are not exposed in this deployment.",
    ],
    image: { src: "/security-governance/reference/management-manage-group-members.png", width: 1762, height: 1146, alt: "Reference screenshot of group members and group administration", caption: "Reference UI for group membership administration" },
    href: "/control-panel?section=groups",
    action: "Manage Groups",
    doc: "https://www.palantir.com/docs/foundry/security/users-and-groups/",
  },
  {
    id: "markings",
    title: "Markings",
    short: "Mandatory data controls",
    status: "Available",
    kind: "ready",
    icon: "eye" as const,
    lead: "Markings are mandatory access requirements. A user needs every effective Marking on a resource in addition to a suitable Project role. A role grant never overrides a missing Marking.",
    points: [
      "Markings may be granted directly to a user or through a group; Organization membership supplies its corresponding Organization control.",
      "Resource Markings can be reviewed in Files. The details view distinguishes Markings applied directly from those inherited through supported paths.",
      "Before applying or changing a Marking, consider affected files and downstream consumers. It can reduce access to derived data as well as its source.",
    ],
    image: { src: "/security-governance/reference/concepts-marking-file-inheritance.png", width: 1865, height: 940, alt: "Reference diagram showing a Marking inherited through a file hierarchy", caption: "Reference: inherited Marking along a file hierarchy" },
    href: "/control-panel?section=markings",
    action: "Manage Markings",
    doc: "https://www.palantir.com/docs/foundry/security/markings/",
  },
  {
    id: "propagation",
    title: "Inheritance & propagation",
    short: "Controls along the data path",
    status: "Available · partial model",
    kind: "partial",
    icon: "graph" as const,
    lead: "This deployment models the difference between access to a workspace and mandatory controls carried by data. Supported Markings can be inherited through folders and data dependencies; inspect lineage before changing them.",
    points: [
      "Folder-level Markings can affect resources below that folder; derived resources can inherit protection from supported pipeline/data inputs.",
      "Project roles and Markings are evaluated separately. A dataset's own and folder Markings decide whether it can be discovered; Markings inherited from its inputs also decide whether its data can be read.",
      "Classification Markings (a hierarchical category) satisfy every lower level; restricted views and object / property security policies filter rows and properties at read time and do not follow the data downstream.",
    ],
    image: { src: "/security-governance/reference/concepts-file-data-classifications-inheritance.png", width: 1951, height: 917, alt: "Reference diagram about classification values propagating from data inputs", caption: "Reference: a classification-control propagation example; classification controls are not exposed here" },
    href: "/lineage",
    action: "Explore Data Lineage",
    doc: "https://www.palantir.com/docs/foundry/security/access-control-propagation/",
  },
  {
    id: "advanced",
    title: "Advanced controls",
    short: "Spaces, constraints, restricted views, emulation",
    status: "Available",
    kind: "guide",
    icon: "alert" as const,
    lead: "The rest of the Concepts guide is implemented: spaces with role sets, Portfolios in Compass, Project constraints and templates, restricted views with granular row policies, classification-based access controls and emulation mode.",
    points: [
      "Project constraints (Files → a Project's details → Governance) refuse violating markings; a build whose output inherits one fails, with the marking still applied.",
      "Restricted views (Security & Governance → Restricted views) show each reader only the rows the policy lets them see; they cannot be pipeline inputs.",
      "Emulation mode (account menu) scopes your session to chosen groups and markings, without administrator powers, to test what others would see.",
    ],
    image: { src: "/security-governance/reference/concepts-emulation-mode-groups-step.png", width: 1310, height: 1390, alt: "Reference screenshot of a permission-emulation group selection dialog", caption: "Reference only: emulation mode is not available in this deployment" },
    href: "/security-governance/management",
    action: "See management availability",
    doc: "https://www.palantir.com/docs/foundry/security/",
  },
] as const;

export default function SecurityConceptsPage() {
  const [activeId, setActiveId] = useState<(typeof CONCEPTS)[number]["id"]>("organizations");
  const concept = CONCEPTS.find((item) => item.id === activeId) ?? CONCEPTS[0];
  const activeIndex = CONCEPTS.findIndex((item) => item.id === concept.id);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink">
      <header className="flex h-14 items-center justify-between border-b border-line bg-panel px-5">
        <div className="flex items-center gap-2 text-sm text-soft"><Icon name="grid" className="h-4 w-4 text-ocean" /><span>Platform Apps</span><Icon name="right" className="h-3.5 w-3.5 text-muted" /><Link href="/security-governance" className="text-muted hover:text-white">Security &amp; Governance</Link><Icon name="right" className="h-3.5 w-3.5 text-muted" /><span>Concepts</span></div>
        <Link href="/security-governance" className="text-xs text-muted hover:text-white">Overview</Link>
      </header>
      <main className="mx-auto max-w-7xl space-y-5 p-5 md:p-8">
        <SecuritySectionNav active="Concepts" />
        <section className="relative overflow-hidden rounded-2xl border border-line bg-panel p-6 md:p-8">
          <div className="pointer-events-none absolute -right-16 -top-28 h-80 w-80 rounded-full border border-ocean/15" />
          <div className="relative max-w-3xl">
            <span className="inline-flex items-center gap-2 rounded-full border border-ocean/30 bg-ocean/10 px-3 py-1 text-[11px] font-medium tracking-wide text-ocean"><Icon name="layers" className="h-3.5 w-3.5" /> SECURITY MODEL</span>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white md:text-3xl">Security &amp; Governance concepts</h1>
            <p className="mt-2 text-sm leading-6 text-soft">Learn how identities, Project roles, and mandatory Markings work together—and where the reference security model extends beyond the controls implemented in this platform.</p>
          </div>
          <div className="relative mt-6 grid gap-2 sm:grid-cols-3">
            <FormulaCard icon="project" title="1 · Resource role" text="Is this user allowed to perform the requested operation here?" />
            <FormulaCard icon="eye" title="2 · Required Markings" text="Does the user hold every mandatory data control on the resource?" />
            <FormulaCard icon="globe" title="3 · Organization" text="Does the resource's Organization boundary admit this user?" />
          </div>
          <p className="relative mt-3 text-[11px] text-muted">Access requires each applicable layer to be satisfied. This is a conceptual guide, not a complete permission simulation.</p>
        </section>

        <div className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
          <nav role="tablist" aria-label="Security concepts" className="flex gap-2 overflow-x-auto pb-1 lg:block lg:space-y-1 lg:overflow-visible">
            {CONCEPTS.map((item) => {
              const selected = item.id === concept.id;
              return <button key={item.id} type="button" role="tab" aria-selected={selected} aria-controls="concept-panel" onClick={() => setActiveId(item.id)} className={`flex min-w-56 items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors lg:w-full lg:min-w-0 ${selected ? "border-ocean/40 bg-ocean/10 text-white" : "border-transparent text-soft hover:border-line hover:bg-panel"}`}>
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${selected ? "bg-ocean/20 text-ocean" : "bg-panel-2 text-muted"}`}><Icon name={item.icon} className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{item.title}</span><span className="mt-0.5 block truncate text-[10px] text-muted">{item.short}</span></span>
              </button>;
            })}
          </nav>

          <article id="concept-panel" role="tabpanel" className="min-w-0 overflow-hidden rounded-2xl border border-line bg-panel">
            <div className="border-b border-line p-5 md:p-6">
              <div className="flex flex-wrap items-center gap-2"><span className="rounded-md border border-line bg-panel-2 p-2 text-ocean"><Icon name={concept.icon} className="h-4 w-4" /></span><StatusBadge kind={concept.kind} label={concept.status} /></div>
              <h2 className="mt-3 text-xl font-semibold text-white">{concept.title}</h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-soft">{concept.lead}</p>
            </div>
            <div className="grid gap-5 p-5 md:p-6 xl:grid-cols-[minmax(0,1fr)_minmax(280px,.85fr)]">
              <div className="space-y-4">
                <section className="rounded-xl border border-line bg-panel-2 p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">What to know</h3>
                  <ul className="mt-3 space-y-3">{concept.points.map((point) => <li key={point} className="flex gap-2.5 text-xs leading-5 text-soft"><Icon name="check" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ocean" />{point}</li>)}</ul>
                </section>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                  <a href={concept.doc} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted hover:text-ocean">Read source guide <Icon name="external" className="h-3 w-3" /></a>
                  <Link href={concept.href} className="inline-flex items-center gap-2 rounded-md bg-ocean px-3.5 py-2 text-xs font-medium text-white hover:bg-ocean-deep">{concept.action}<Icon name="right" className="h-3 w-3" /></Link>
                </div>
              </div>
              <figure className="min-w-0 self-start overflow-hidden rounded-xl border border-line bg-ink">
                <div className="flex items-center justify-between border-b border-line bg-panel-2 px-3 py-2"><span className="text-[10px] font-medium uppercase tracking-wide text-muted">Reference UI</span><span className="text-[10px] text-muted">{activeIndex + 1} / {CONCEPTS.length}</span></div>
                <div className="relative flex min-h-48 items-center justify-center bg-white p-1"><Image src={concept.image.src} alt={concept.image.alt} width={concept.image.width} height={concept.image.height} sizes="(max-width: 1279px) 100vw, 38vw" className="h-auto max-h-[380px] w-full object-contain" /></div>
                <figcaption className="px-3 py-2.5 text-[11px] leading-4 text-muted">{concept.image.caption}. Illustrative screenshot from the source documentation, not a live app screen.</figcaption>
              </figure>
            </div>
          </article>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-xs text-muted"><span>Use current platform controls for enforcement; use the reference documentation for concepts beyond this deployment.</span><Link href="/security-governance/management" className="inline-flex items-center gap-1 text-ocean hover:underline">Management availability <Icon name="right" className="h-3 w-3" /></Link></footer>
      </main>
    </div>
  );
}

function FormulaCard({ icon, title, text }: { icon: "project" | "eye" | "globe"; title: string; text: string }) {
  return <div className="rounded-xl border border-line bg-panel-2 p-3"><div className="flex items-center gap-2 text-xs font-medium text-soft"><Icon name={icon} className="h-3.5 w-3.5 text-ocean" />{title}</div><p className="mt-1.5 text-[11px] leading-4 text-muted">{text}</p></div>;
}
function StatusBadge({ kind, label }: { kind: string; label: string }) {
  const styles = kind === "ready" ? "border-ok/25 bg-ok/10 text-ok" : kind === "partial" ? "border-warn/25 bg-warn/10 text-warn" : "border-line-2 bg-panel-2 text-muted";
  return <span className={`rounded-full border px-2 py-1 text-[10px] ${styles}`}>{label}</span>;
}
