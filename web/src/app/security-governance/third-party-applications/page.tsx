import Image from "next/image";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { SecuritySectionNav } from "@/components/security/SecuritySectionNav";

const CAPABILITIES = [
  { title: "Personal API tokens", status: "Available", tone: "ready", icon: "code" as const, text: "Create and revoke user-bound API tokens in Account. A token carries its owner's permissions and Markings; the secret is shown only once and may be assigned an expiry.", href: "/account#api-tokens", action: "Manage your tokens" },
  { title: "OAuth application registration", status: "Available", tone: "ready", icon: "plus" as const, text: "Developer Console registers public (Authorization Code with PKCE) and confidential (client credentials) applications with exact redirect URIs, allowed origins, one-time client secrets and rotation.", href: "/developer-console", action: "Open Developer Console" },
  { title: "Scopes & service users", status: "Partial support", tone: "limited", icon: "globe" as const, text: "An application's tokens reach only the object types, actions and functions it is scoped to (plus api:audit-read when an administrator allows it); backend applications can get their own service user. Per-Organization enablement and Organization-wide consent are not available.", href: "/developer-console", action: "Review application scopes" },
  { title: "User consent & authorized-app revocation", status: "Available", tone: "ready", icon: "check" as const, text: "Users approve an application on a consent page before it acts for them, and review or revoke the applications with access to their account in Account settings.", href: "/account", action: "Applications with access" },
] as const;

const FLOW = [
  { n: "01", title: "Define the integration", detail: "Document the purpose, data needed, actions taken, users, system owner, and external data handling before connecting an application." },
  { n: "02", title: "Choose the right credential", detail: "Personal API tokens are for an individual's scripts and controlled development—not a production app, shared service account, or committed secret." },
  { n: "03", title: "Keep access user-bound", detail: "The preferred OAuth authorization-code approach keeps API activity in each user's authorization context, with explicit consent and least privilege. Register the application in Developer Console." },
  { n: "04", title: "Minimize and protect data", detail: "Request the smallest scope, avoid copying or caching data outside its controls, and document any external retention and deletion obligations." },
] as const;

const REFERENCES = [
  { src: "/security-governance/reference/third-party-create-wizard.png", width: 1768, height: 943, alt: "Third-party OAuth client registration wizard reference", label: "OAuth client registration · reference only" },
  { src: "/security-governance/reference/third-party-3PA-registered-page.png", width: 1762, height: 948, alt: "Newly registered application and one-time client secret reference", label: "Registration and one-time secret · reference only" },
  { src: "/security-governance/reference/third-party-3PA-enablement-settings-page.png", width: 2559, height: 1327, alt: "Third-party application enablement with Project and Marking scopes", label: "Organization enablement & scopes · reference only" },
  { src: "/security-governance/reference/third-party-3PA-user-connection-dialog.png", width: 1063, height: 702, alt: "Example user consent dialog for a third-party app", label: "Per-user consent · reference only" },
  { src: "/security-governance/reference/third-party-3PA-user-view-details.png", width: 1500, height: 814, alt: "Reference details for a user's authorized application", label: "Review granted application access · reference only" },
  { src: "/security-governance/reference/third-party-3PA-user-revoke-access.png", width: 1494, height: 796, alt: "Reference confirmation dialog for revoking an authorized application", label: "Revoke third-party authorization · reference only" },
  { src: "/security-governance/reference/third-party-token_dashboard.png", width: 1073, height: 391, alt: "Reference screenshot of a personal API token dashboard", label: "Personal API token dashboard · reference" },
] as const;

export default function ThirdPartyApplicationsPage() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink">
      <header className="flex h-14 items-center justify-between border-b border-line bg-panel px-5">
        <div className="flex items-center gap-2 text-sm text-soft"><Icon name="grid" className="h-4 w-4 text-ocean" /><span>Platform Apps</span><Icon name="right" className="h-3.5 w-3.5 text-muted" /><Link href="/security-governance" className="text-muted hover:text-white">Security &amp; Governance</Link><Icon name="right" className="h-3.5 w-3.5 text-muted" /><span>Third-party applications</span></div>
        <Link href="/security-governance" className="text-xs text-muted hover:text-white">Overview</Link>
      </header>
      <main className="mx-auto max-w-7xl space-y-5 p-5 md:p-8">
        <SecuritySectionNav active="Third-party apps" />
        <section className="relative overflow-hidden rounded-2xl border border-line bg-panel p-6 md:p-8">
          <div className="pointer-events-none absolute -right-16 -top-28 h-80 w-80 rounded-full border border-ocean/15" />
          <div className="relative max-w-3xl">
            <span className="inline-flex items-center gap-2 rounded-full border border-ocean/30 bg-ocean/10 px-3 py-1 text-[11px] font-medium tracking-wide text-ocean"><Icon name="plug" className="h-3.5 w-3.5" /> INTEGRATION SECURITY</span>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white md:text-3xl">Third-party applications &amp; API access</h1>
            <p className="mt-2 text-sm leading-6 text-soft">Review what is available for API credentials today, how to handle personal tokens safely, and how to register OAuth applications in Developer Console (and which controls of the source guide are still missing).</p>
          </div>
          <div className="relative mt-5 flex flex-wrap gap-2"><Pill tone="ready">Personal tokens: available</Pill><Pill tone="ready">OAuth applications &amp; consent: available</Pill><Pill tone="limited">Organization enablement: not available</Pill></div>
        </section>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {CAPABILITIES.map((item) => <article key={item.title} className="flex min-h-48 flex-col rounded-xl border border-line bg-panel p-4"><div className="flex items-start justify-between gap-3"><span className="rounded-lg border border-line bg-panel-2 p-2 text-ocean"><Icon name={item.icon} className="h-4 w-4" /></span><Pill tone={item.tone}>{item.status}</Pill></div><h2 className="mt-3 text-sm font-semibold text-white">{item.title}</h2><p className="mt-1 flex-1 text-xs leading-5 text-muted">{item.text}</p>{"href" in item && item.href && <Link href={item.href} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-ocean hover:underline">{item.action}<Icon name="right" className="h-3 w-3" /></Link>}</article>)}
        </div>

        <section className="grid gap-4 xl:grid-cols-[1.05fr_.95fr]">
          <div className="rounded-xl border border-warn/30 bg-warn/5 p-5">
            <div className="flex items-start gap-3"><Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0 text-warn" /><div><h2 className="text-sm font-semibold text-warn">Personal API tokens are credentials—not production app authorization</h2><p className="mt-2 text-xs leading-5 text-soft">Treat a token like a password: it acts as the user who created it, with that user&apos;s access and Markings. Keep it private, set an expiry, use environment-based secret storage for development, revoke unused credentials, and never commit a token to a repository.</p><p className="mt-2 text-xs leading-5 text-soft">The source guide recommends registered OAuth 2.0 authorization for production applications. Register production integrations as Developer Console applications (with consent, scopes and, for backends, a service user) instead of using a personal token.</p><Link href="/account#api-tokens" className="mt-3 inline-flex items-center gap-2 rounded-md bg-ocean px-3.5 py-2 text-xs font-medium text-white hover:bg-ocean-deep"><Icon name="code" className="h-3.5 w-3.5" />Open personal API tokens<Icon name="right" className="h-3 w-3" /></Link></div></div>
          </div>
          <div className="rounded-xl border border-line bg-panel p-5">
            <h2 className="text-sm font-semibold text-white">Integration review before connecting</h2><p className="mt-1 text-xs leading-5 text-muted">Use this checklist as design guidance; it does not configure, authorize, or approve an integration.</p>
            <ol className="mt-4 space-y-3">{FLOW.map((item) => <li key={item.n} className="flex gap-3"><span className="flex h-6 w-7 shrink-0 items-center justify-center rounded-md bg-ocean/10 text-[10px] font-medium text-ocean">{item.n}</span><span><span className="block text-xs font-medium text-soft">{item.title}</span><span className="mt-0.5 block text-[11px] leading-4 text-muted">{item.detail}</span></span></li>)}</ol>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-3">
          <article className="rounded-xl border border-line bg-panel p-4"><h2 className="text-xs font-semibold text-white">Public clients</h2><p className="mt-2 text-xs leading-5 text-muted">The reference OAuth model uses Authorization Code with PKCE for clients that cannot safely keep a secret, such as browser or native apps. Do not embed a client secret in a distributed app.</p></article>
          <article className="rounded-xl border border-line bg-panel p-4"><h2 className="text-xs font-semibold text-white">Confidential clients</h2><p className="mt-2 text-xs leading-5 text-muted">Client Credentials is only for a confidential, server-side app that can protect its secret; the application receives a service identity in the reference model. In Developer Console, give a backend application a service user so it does not act as the person who created it.</p></article>
          <article className="rounded-xl border border-warn/25 bg-warn/5 p-4"><h2 className="text-xs font-semibold text-warn">Scope &amp; consent</h2><p className="mt-2 text-xs leading-5 text-soft">Keep redirect URIs exact, narrow Project and Marking scope, and prefer explicit user consent. Organization-wide consent can bypass individual prompts and must not be treated as the default.</p></article>
        </section>

        <section className="rounded-xl border border-line bg-panel p-5">
          <div className="flex flex-wrap items-end justify-between gap-2"><div><h2 className="text-base font-semibold text-white">OAuth workflow references</h2><p className="mt-1 text-xs text-muted">Screenshots from the supplied reference guide. They illustrate the reference platform; BluesandAI&apos;s own controls are in Developer Console and Account.</p></div><a href="https://www.palantir.com/docs/foundry/platform-security-third-party/third-party-apps-overview/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-ocean hover:underline">Open source guide<Icon name="external" className="h-3 w-3" /></a></div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{REFERENCES.map((image) => <figure key={image.src} className="overflow-hidden rounded-lg border border-line bg-ink"><figcaption className="border-b border-line bg-panel-2 px-3 py-2 text-[10px] text-soft">{image.label}</figcaption><div className="flex min-h-36 items-center justify-center bg-white p-1"><Image src={image.src} alt={image.alt} width={image.width} height={image.height} sizes="(max-width: 1279px) 50vw, 30vw" className="h-auto max-h-52 w-full object-contain" /></div></figure>)}</div>
        </section>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-xs text-muted"><span>Integrations: OAuth applications in Developer Console; personal API tokens in Account for individual scripts.</span><Link href="/security-governance/management" className="inline-flex items-center gap-1 text-ocean hover:underline">Security management <Icon name="right" className="h-3 w-3" /></Link></footer>
      </main>
    </div>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone: string }) {
  const style = tone === "ready" ? "border-ok/25 bg-ok/10 text-ok" : tone === "limited" ? "border-warn/25 bg-warn/10 text-warn" : "border-line bg-panel-2 text-muted";
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] ${style}`}>{children}</span>;
}
