"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { missingText } from "@/components/LocationField";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { functions as fnRegistry, type FunctionRow } from "@/lib/actions";
import { api, API_URL, type DriveItem } from "@/lib/api";
import { auth } from "@/lib/auth";
import { devConsole, siteUrl, type DcApp, type ServiceUser } from "@/lib/developerConsole";
import { when } from "@/lib/format";
import { ontology, type ActionType } from "@/lib/ontology";
import { workshop, type ObjectTypeSource } from "@/lib/workshop";

/** Developer Console (palantir.com/docs/foundry/ontology-sdk-react-applications): applications on the Ontology SDK —
 *  OAuth2 clients, scopes, generated SDKs and website hosting. */
export default function DeveloperConsolePage() {
  return (
    <Suspense fallback={null}>
      <DeveloperConsole />
    </Suspense>
  );
}

type Tab = "overview" | "sdk" | "hosting" | "sharing";

function DeveloperConsole() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id");
  const [apps, setApps] = useState<DcApp[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    devConsole.list().then(setApps, (e: Error) => setError(e.message));
  }, [nonce]);
  const createDialog = creating && (
    <CreateDialog
      onClose={() => setCreating(false)}
      onCreated={(a) => {
        setCreating(false);
        setNonce((n) => n + 1);
        router.replace(`/developer-console?id=${a.id}`);
        if (a.client_secret) window.setTimeout(() => window.alert(`Client secret (shown once):\n\n${a.client_secret}`), 100);
      }}
    />
  );
  // the last time an application changed: created, an SDK generated or a website release uploaded
  const touched = (a: DcApp) => [a.created_at, ...a.sdk.map((x) => x.generated_at), ...a.hosting.releases.map((r) => r.uploaded_at)].filter(Boolean).sort().pop() ?? null;
  if (!id)
    return (
      <>
        <AppHome
          app="Developer Console"
          icon="keyboard"
          accent="#64748b"
          href="/developer-console"
          tagline="Your own applications on the Nexus: OAuth2 clients, scopes, generated SDKs and website hosting."
          description={
            <>
              <p>
                Build your own applications on the Nexus: create an application, choose the object types, actions and functions it may reach, generate its TypeScript SDK and
                sign users in with OAuth2. Host the built website here, or run it anywhere.
              </p>
              <p className="mt-2">Client-facing applications are public OAuth2 clients (authorization code with PKCE); backend applications hold a client secret and may use client credentials.</p>
            </>
          }
          noun={["application", "applications"]}
          error={error}
          items={
            apps?.map((a) => ({
              id: a.id,
              href: `/developer-console?id=${a.id}`,
              title: a.name,
              updated_at: touched(a),
              detail: a.description || undefined,
              badges: [
                { label: a.kind === "client" ? "client-facing" : "backend", tone: a.kind === "client" ? ("ocean" as const) : ("sand" as const) },
                ...(a.hosting.live ? [{ label: "hosted", tone: "ok" as const }] : []),
                ...(a.disabled ? [{ label: "disabled", tone: "bad" as const }] : []),
              ],
              meta: a.sdk.length ? `SDK ${a.sdk[a.sdk.length - 1].version}` : "no SDK yet",
            })) ?? null
          }
          empty={{ title: "Create your first application", hint: "An application is an OAuth2 client with its own scope of object types, actions and functions.", steps: ["Create a client-facing or backend app", "Choose what it may reach", "Generate its SDK and host the site"] }}
          create={
            <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> New application
            </button>
          }
        />
        {createDialog}
      </>
    );
  return (
    <div className="flex h-full flex-col">
      <AppHeader app="Developer Console" icon="keyboard" href="/developer-console">
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New application
        </button>
      </AppHeader>
      {error && <p className="px-6 pt-3 text-sm text-bad">{error}</p>}
      <div className="grid min-h-0 flex-1 grid-cols-[16rem_1fr]">
        <aside className="overflow-auto border-r border-line p-3 text-sm">
          <Link href="/developer-console" className="mb-2 flex items-center gap-1 px-2 text-[11px] font-medium uppercase tracking-wider text-muted hover:text-strong">
            <Icon name="left" className="h-3 w-3" /> All applications
          </Link>
          {apps?.length === 0 && <p className="text-xs text-muted">No applications yet.</p>}
          {apps?.map((a) => (
            <button key={a.id} type="button" onClick={() => router.replace(`/developer-console?id=${a.id}`)} className={`mb-1 block w-full rounded-md px-2.5 py-2 text-left ${a.id === id ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}>
              <div className="truncate font-medium">{a.name}</div>
              <div className="text-[11px] text-muted">
                {a.kind === "client" ? "client-facing" : "backend"} · {a.sdk.length ? `SDK ${a.sdk[a.sdk.length - 1].version}` : "no SDK yet"}
              </div>
            </button>
          ))}
        </aside>
        <main className="overflow-auto p-6">
          <AppView key={`${id}:${nonce}`} id={id} onChanged={() => setNonce((n) => n + 1)} />
        </main>
      </div>
      {createDialog}
    </div>
  );
}

function AppView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get("tab") as Tab) || "overview";
  const [app, setApp] = useState<DcApp | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    devConsole.get(id).then(setApp, (e: Error) => setError(e.message));
  }, [id]);
  if (error) return <p className="text-sm text-bad">{error}</p>;
  if (!app) return <p className="text-sm text-muted">Loading…</p>;
  const update = (a: DcApp) => {
    setApp(a);
    onChanged();
  };
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <div className="text-xs uppercase tracking-wider text-ocean">{app.kind === "client" ? "Client-facing application" : "Backend application"}</div>
        <h1 className="mt-1 text-xl font-semibold">{app.name}</h1>
        <p className="font-mono text-[11px] text-muted">{app.rid}</p>
      </div>
      <div className="flex gap-1 border-b border-line text-sm">
        {(
          [
            ["overview", "Overview & OAuth"],
            ["sdk", "Nexus SDK"],
            ["hosting", "Website hosting"],
            ["sharing", "Grants"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" onClick={() => router.replace(`/developer-console?id=${id}&tab=${k}`)} className={`px-3 py-1.5 ${tab === k ? "border-b-2 border-ocean text-white" : "text-muted hover:text-white"}`}>
            {l}
          </button>
        ))}
      </div>
      {tab === "overview" && <Overview app={app} onApp={update} />}
      {tab === "sdk" && <Sdk app={app} onApp={update} />}
      {tab === "hosting" && <Hosting app={app} onApp={update} />}
      {tab === "sharing" && <Grants app={app} />}
    </div>
  );
}

function Lines({ label, value, onSave, hint }: { label: string; value: string[]; onSave: (v: string[]) => Promise<void>; hint: string }) {
  const [text, setText] = useState(value.join("\n"));
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <label className="block text-xs text-muted">
      {label}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className={`${inputClass} mt-1 font-mono text-xs`} />
      <span className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={async () => {
            try {
              await onSave(text.split("\n").map((x) => x.trim()).filter(Boolean));
              setMsg("Saved");
            } catch (e) {
              setMsg((e as Error).message);
            }
          }}
          className={buttonClass.secondary}
        >
          Save
        </button>
        <span>{msg ?? hint}</span>
      </span>
    </label>
  );
}

function Overview({ app, onApp }: { app: DcApp; onApp: (a: DcApp) => void }) {
  const [secret, setSecret] = useState<string | null>(null);
  const meta = `<meta name="osdk-clientId" content="${app.client_id}" />
<meta name="osdk-redirectUrl" content="${app.redirect_uris[0] ?? "http://localhost:8080/auth/callback"}" />
<meta name="osdk-foundryUrl" content="${API_URL}" />
<meta name="osdk-ontologyRid" content="ri.ontology.main.ontology.default" />`;
  return (
    <div className="grid grid-cols-2 gap-4 text-xs">
      <div className="space-y-3">
        <About app={app} onApp={onApp} />
        <div className="rounded-lg border border-line bg-panel p-3">
          <div className="text-muted">Client ID</div>
          <div className="font-mono text-sm">{app.client_id}</div>
          {app.kind === "backend" && (
            <div className="mt-2">
              <button type="button" onClick={async () => setSecret((await devConsole.rotateSecret(app.id)).client_secret)} className={buttonClass.secondary}>
                Rotate client secret
              </button>
              {secret && <p className="mt-1 break-all font-mono text-ok">{secret} (copy it now: it is not shown again)</p>}
            </div>
          )}
        </div>
        <Lines label="Redirect URLs (where users return after signing in)" value={app.redirect_uris} onSave={async (v) => onApp(await devConsole.update(app.id, { redirect_uris: v }))} hint="https://…, or http://localhost for development" />
        <Lines label="Allowed origins (browser code calling the OSDK API and the token endpoint)" value={app.allowed_origins} onSave={async (v) => onApp(await devConsole.update(app.id, { allowed_origins: v }))} hint="scheme://host[:port]; the hosted site needs none" />
      </div>
      <div className="space-y-3">
        <div className="rounded-lg border border-line bg-panel p-3">
          <div className="mb-1 font-medium">index.html</div>
          <pre className="overflow-auto rounded bg-ink p-2 font-mono text-[10px] text-soft">{meta}</pre>
        </div>
        <div className="rounded-lg border border-line bg-panel p-3">
          <div className="mb-1 font-medium">OAuth2 endpoints</div>
          <div className="space-y-0.5 font-mono text-[11px] text-soft">
            <div>authorize: {API_URL}/api/oauth2/authorize</div>
            <div>token: {API_URL}/api/oauth2/token</div>
            <div>revoke: {API_URL}/api/oauth2/revoke</div>
            <div>OSDK API: {API_URL}/api/v2/ontologies/default/…</div>
          </div>
          <p className="mt-1 text-muted">{app.kind === "client" ? "Authorization code with PKCE (S256); refresh tokens for 30 days, access tokens for an hour." : "Authorization code with the secret, or client credentials (acting as the user who created the application)."}</p>
        </div>
      </div>
    </div>
  );
}

/** The application's name and description (shown in the Developer Console and to users granting it access). */
function About({ app, onApp }: { app: DcApp; onApp: (a: DcApp) => void }) {
  const [name, setName] = useState(app.name);
  const [description, setDescription] = useState(app.description ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const dirty = name.trim() !== app.name || description.trim() !== (app.description ?? "");
  return (
    <div className="space-y-2 rounded-lg border border-line bg-panel p-3">
      <label className="block text-muted">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className={`${inputClass} mt-1`} aria-label="Application name" />
      </label>
      <label className="block text-muted">
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} className={`${inputClass} mt-1`} aria-label="Application description" />
      </label>
      <span className="flex items-center gap-2">
        <button
          type="button"
          disabled={!dirty || !name.trim()}
          onClick={async () => {
            try {
              onApp(await devConsole.update(app.id, { name: name.trim(), description: description.trim() }));
              setMsg("Saved");
            } catch (e) {
              setMsg((e as Error).message);
            }
          }}
          className={buttonClass.secondary}
        >
          Save
        </button>
        {msg && <span className="text-muted">{msg}</span>}
      </span>
    </div>
  );
}

function Sdk({ app, onApp }: { app: DcApp; onApp: (a: DcApp) => void }) {
  const [types, setTypes] = useState<ObjectTypeSource[]>([]);
  const [actions, setActions] = useState<ActionType[]>([]);
  const [fns, setFns] = useState<FunctionRow[]>([]);
  const [cfg, setCfg] = useState(app.resources);
  const [msg, setMsg] = useState<string | null>(null);
  const [docs, setDocs] = useState<{ version: string; files: Record<string, string> } | null>(null);
  const [file, setFile] = useState("package/index.d.ts");
  useEffect(() => {
    workshop.sources().then((s) => setTypes(s.object_types), () => {});
    ontology.actionTypes().then(setActions, () => {});
    fnRegistry.list().then(setFns, () => {});
  }, []);
  const latest = app.sdk[app.sdk.length - 1];
  useEffect(() => {
    if (latest) devConsole.sdkFiles(app.id, latest.version).then(setDocs, () => {});
  }, [app.id, latest]);
  const dirty = JSON.stringify(cfg) !== JSON.stringify(app.resources);
  const pick = (kind: keyof DcApp["resources"], rid: string, on: boolean) => setCfg({ ...cfg, [kind]: on ? [...cfg[kind], rid] : cfg[kind].filter((x) => x !== rid) });
  // a filter per column (there can be thousands of functions); chosen ones always stay listed
  const [find, setFind] = useState<Record<string, string>>({});
  const col = (title: string, kind: keyof DcApp["resources"], items: { id: string; name: string }[]) => (
    <div>
      <div className="mb-1 font-medium">
        {title} <span className="font-normal text-muted">({cfg[kind].length})</span>
      </div>
      <input value={find[kind] ?? ""} onChange={(e) => setFind({ ...find, [kind]: e.target.value })} placeholder="Filter…" className={`${inputClass} mb-1 py-1 text-xs`} aria-label={`Filter ${kind}`} />
      <div className="max-h-56 overflow-auto rounded border border-line p-2" data-scope={kind}>
        {items.filter((x) => cfg[kind].includes(x.id) || !find[kind] || x.name.toLowerCase().includes(find[kind].toLowerCase())).slice(0, 300).map((x) => (
          <label key={x.id} className="flex items-center gap-2">
            <input type="checkbox" checked={cfg[kind].includes(x.id)} onChange={(e) => pick(kind, x.id, e.target.checked)} /> {x.name}
          </label>
        ))}
        {!items.length && <span className="text-muted">None</span>}
      </div>
    </div>
  );
  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-3 gap-3">
        {col("Object types", "object_types", types.map((t) => ({ id: t.id, name: t.name })))}
        {col("Action types (their object types come along)", "action_types", actions.map((a) => ({ id: a.id, name: a.display_name })))}
        {col("Functions (only those with an API name are in the SDK)", "functions", fns.map((f) => ({ id: f.id, name: f.api_name ? `${f.name} · ${f.api_name}` : `${f.name} (no API name)` })))}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" disabled={!dirty} onClick={async () => {
          try {
            const a = await devConsole.resources(app.id, cfg);
            setCfg(a.resources);
            onApp(a);
            setMsg("Scopes saved");
          } catch (e) {
            setMsg((e as Error).message);
          }
        }} className={buttonClass.secondary}>
          Save scopes
        </button>
        <button type="button" disabled={dirty} onClick={async () => {
          try {
            const v = await devConsole.generateSdk(app.id);
            setMsg(`Generated ${v.version}`);
            onApp(await devConsole.get(app.id));
          } catch (e) {
            setMsg((e as Error).message);
          }
        }} className={buttonClass.primary} title={dirty ? "Save the scopes first" : undefined}>
          Generate new SDK version
        </button>
        {msg && <span className="text-muted">{msg}</span>}
      </div>
      {app.sdk.length > 0 && (
        <table className="w-full rounded border border-line">
          <thead className="bg-panel-2 text-left text-muted">
            <tr>
              <th className="px-3 py-1.5 font-normal">Version</th>
              <th className="px-3 py-1.5 font-normal">Package</th>
              <th className="px-3 py-1.5 font-normal">Object types</th>
              <th className="px-3 py-1.5 font-normal">Generated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...app.sdk].reverse().map((s) => (
              <tr key={s.version} className="border-t border-line">
                <td className="px-3 py-1.5 font-mono">{s.version}</td>
                <td className="px-3 py-1.5 font-mono">{app.package}</td>
                <td className="px-3 py-1.5">{s.object_types}</td>
                <td className="px-3 py-1.5 text-muted">{when(s.generated_at)}</td>
                <td className="px-3 py-1.5 text-right">
                  <a href={devConsole.sdkUrl(app.id, s.version)} className="text-ocean hover:underline">
                    Download .tgz
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {docs && (
        <div className="rounded-lg border border-line bg-panel p-3">
          <div className="mb-2 flex gap-2">
            <span className="font-medium">SDK docs · {docs.version}</span>
            {Object.keys(docs.files).map((f) => (
              <button key={f} type="button" onClick={() => setFile(f)} className={`rounded px-2 py-0.5 font-mono ${file === f ? "bg-ocean/15 text-white" : "text-muted"}`}>
                {f.replace("package/", "")}
              </button>
            ))}
          </div>
          <pre className="max-h-96 overflow-auto rounded bg-ink p-2 font-mono text-[10px] text-soft">{docs.files[file]}</pre>
        </div>
      )}
    </div>
  );
}

function Hosting({ app, onApp }: { app: DcApp; onApp: (a: DcApp) => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [slug, setSlug] = useState(app.hosting.slug);
  const [domains, setDomains] = useState(app.hosting.csp_domains.join("\n"));
  const next = (() => {
    const last = app.hosting.releases[app.hosting.releases.length - 1]?.version;
    if (!last) return "1.0.0";
    const [a, b, c] = last.split(".").map(Number);
    return `${a}.${b}.${c + 1}`;
  })();
  const [version, setVersion] = useState(next);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-end gap-2">
        <label className="text-muted">
          Site name
          <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} className={`${inputClass} mt-1 w-56 font-mono`} />
        </label>
        <label className="flex-1 text-muted">
          Extra CSP domains (https://host, one per line; connect-src and img-src)
          <textarea value={domains} onChange={(e) => setDomains(e.target.value)} rows={1} className={`${inputClass} mt-1 font-mono`} />
        </label>
        <button type="button" onClick={async () => {
          try {
            onApp(await devConsole.hosting(app.id, { slug, csp_domains: domains.split("\n").map((x) => x.trim()).filter(Boolean) }));
            setMsg("Saved");
          } catch (e) {
            setMsg((e as Error).message);
          }
        }} className={buttonClass.secondary}>
          Save
        </button>
      </div>
      <p className="text-muted">
        The live version is served at{" "}
        <a href={app.hosting.url ?? siteUrl(app.hosting.slug)} target="_blank" rel="noreferrer" className="font-mono text-ocean hover:underline">
          {app.hosting.url ?? siteUrl(app.hosting.slug)}
        </a>{" "}
        (build with a relative base, e.g. Vite <span className="font-mono">base: &quot;./&quot;</span>; unknown paths serve index.html). It is served from a hosting origin of its own (never the platform&apos;s, so its scripts cannot use your session); it calls the OSDK API with OAuth tokens; add {app.hosting.url ?? siteUrl(app.hosting.slug)} as a redirect URL.
      </p>
      <div className="flex items-center gap-2">
        <input value={version} onChange={(e) => setVersion(e.target.value)} className={`${inputClass} w-28 font-mono`} />
        <input
          ref={ref}
          type="file"
          accept=".zip"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              onApp(await devConsole.uploadSite(app.id, version, f));
              setMsg(`Uploaded ${version}`);
            } catch (ex) {
              setMsg((ex as Error).message);
            }
            e.target.value = "";
          }}
        />
        <button type="button" onClick={() => ref.current?.click()} className={buttonClass.primary}>
          <Icon name="upload" className="h-3.5 w-3.5" /> Upload site version (.zip)
        </button>
        {msg && <span className="text-muted">{msg}</span>}
      </div>
      <table className="w-full rounded border border-line">
        <tbody>
          {[...app.hosting.releases].reverse().map((r) => (
            <tr key={r.version} className="border-t border-line first:border-0">
              <td className="px-3 py-1.5 font-mono">{r.version}</td>
              <td className="px-3 py-1.5 text-muted">
                {r.files} files · {Math.round(r.size / 1024)} KB · {when(r.uploaded_at)}
              </td>
              <td className="px-3 py-1.5 text-right">
                {app.hosting.live === r.version ? (
                  <span className="text-ok">live</span>
                ) : (
                  <button type="button" onClick={async () => onApp(await devConsole.setLive(app.id, r.version))} className="text-ocean hover:underline">
                    Make live
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Grants({ app }: { app: DcApp }) {
  const [g, setG] = useState<{ users: string[]; active_tokens: number; service_user: ServiceUser | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    devConsole.grants(app.id).then(setG, () => {});
  }, [app.id, nonce]);
  return (
    <div className="space-y-2 text-xs">
      <p className="text-soft">{g ? `${g.users.length} user${g.users.length === 1 ? "" : "s"} granted the application; ${g.active_tokens} access token${g.active_tokens === 1 ? "" : "s"} live.` : "Loading…"}</p>
      <button type="button" onClick={async () => (await devConsole.revokeGrants(app.id), setNonce((n) => n + 1))} className={buttonClass.secondary}>
        Revoke every token
      </button>
      {app.kind === "backend" && g && (
        <div className="rounded border border-line p-2" data-service-user>
          <div className="font-medium text-soft">Service user</div>
          {g.service_user ? (
            <p className="mt-1 text-soft">
              Client credentials tokens act as <span className="font-mono">{g.service_user.username}</span> ({g.service_user.display_name}). Grant it roles on the Projects and the markings the
              application needs, like any user.
            </p>
          ) : (
            <p className="mt-1 text-muted">Client credentials tokens act as the user who created the application. A service user gives the application its own identity and permissions.</p>
          )}
          <button type="button" className={`${buttonClass.secondary} mt-2`} data-service-user-toggle
            onClick={() => devConsole.setServiceUser(app.id, !g.service_user).then(() => (setErr(null), setNonce((n) => n + 1)), (e: Error) => setErr(e.message))}>
            {g.service_user ? "Remove the service user (act as the creator)" : "Create a service user"}
          </button>
          {err && <p className="mt-1 text-bad">{err}</p>}
        </div>
      )}
      {app.kind === "backend" && <AuditRead app={app} />}
      <Enablement app={app} />
      <p className="text-muted">The application itself is a Files item: its Project&apos;s roles decide who sees and edits it. Deleting it revokes its tokens.</p>
    </div>
  );
}

/**
 * Enablement settings (administrators): enable / disable (disabling revokes every authorization), Project and marking
 * restrictions on what the application's tokens reach, and organization level consent.
 */
function Enablement({ app }: { app: DcApp }) {
  const [f, setF] = useState({
    enabled: !app.disabled,
    project_scope: app.project_scope ?? null,
    marking_scope: app.marking_scope ?? null,
    org_consent: app.org_consent ?? [],
  });
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [markings, setMarkings] = useState<{ id: string; name: string }[]>([]);
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    api.drive.folder(null).then((r) => setProjects(r.items.filter((i) => i.kind === "project").map((i) => ({ id: i.id, name: i.name }))), () => {});
    auth.markings().then((m) => setMarkings(m.map((x) => ({ id: x.id, name: x.name }))), () => {});
    auth.organizations().then((o) => setOrgs(o.map((x) => ({ id: x.id, name: x.name }))), () => {});
  }, []);
  const toggle = (list: string[] | null, id: string) => ((list ?? []).includes(id) ? (list ?? []).filter((x) => x !== id) : [...(list ?? []), id]);
  return (
    <div className="space-y-2 rounded border border-line p-2" data-enablement>
      <div className="font-medium text-soft">Enablement settings</div>
      <label className="flex items-center gap-2 text-soft">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
        Enabled (disabling revokes every authorization: users authorize it again after it is re-enabled)
      </label>
      <div>
        <label className="flex items-center gap-2 text-soft">
          <input type="checkbox" checked={f.project_scope === null} onChange={(e) => setF({ ...f, project_scope: e.target.checked ? null : [] })} />
          Project access: unrestricted
        </label>
        {f.project_scope !== null && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-5">
            {projects.map((p) => (
              <label key={p.id} className="flex items-center gap-1">
                <input type="checkbox" checked={f.project_scope!.includes(p.id)} onChange={() => setF({ ...f, project_scope: toggle(f.project_scope, p.id) })} />
                {p.name}
              </label>
            ))}
          </div>
        )}
      </div>
      <div>
        <label className="flex items-center gap-2 text-soft">
          <input type="checkbox" checked={f.marking_scope === null} onChange={(e) => setF({ ...f, marking_scope: e.target.checked ? null : [] })} />
          Marking restrictions: unrestricted
        </label>
        {f.marking_scope !== null && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-5">
            {markings.map((m) => (
              <label key={m.id} className="flex items-center gap-1">
                <input type="checkbox" checked={f.marking_scope!.includes(m.id)} onChange={() => setF({ ...f, marking_scope: toggle(f.marking_scope, m.id) })} />
                {m.name}
              </label>
            ))}
            <span className="text-muted">(resources with other markings stay out of reach; unmarked ones remain usable)</span>
          </div>
        )}
      </div>
      <div>
        <div className="text-soft">Organization level consent (no consent screen for their users)</div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {orgs.map((o) => (
            <label key={o.id} className="flex items-center gap-1">
              <input type="checkbox" checked={f.org_consent.includes(o.id)} onChange={() => setF({ ...f, org_consent: toggle(f.org_consent, o.id) })} />
              {o.name}
            </label>
          ))}
          {orgs.length === 0 && <span className="text-muted">No organizations.</span>}
        </div>
      </div>
      <button
        type="button"
        className={buttonClass.secondary}
        onClick={() => devConsole.setEnablement(app.id, f).then(() => setMsg({ ok: true, text: "Saved" }), (e: Error) => setMsg({ ok: false, text: e.message }))}
      >
        Save enablement settings
      </button>
      {msg && <p className={msg.ok ? "text-ok" : "text-bad"}>{msg.text}</p>}
    </div>
  );
}

/** Audit-read access: the application's tokens carry api:audit-read for the audit log files API (a SIEM integration). */
function AuditRead({ app }: { app: DcApp }) {
  const [on, setOn] = useState(!!app.audit_read);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="rounded border border-line p-2" data-audit-read>
      <div className="font-medium text-soft">Audit log access (SIEM)</div>
      <p className="mt-1 text-muted">
        With audit-read access, tokens carry <span className="font-mono">api:audit-read</span> and can poll <span className="font-mono">/api/v2/audit/organizations/&lt;org&gt;/logFiles</span>. The
        application&apos;s user must also be an audit log reader of the organization (<Link href="/security-auditing?tab=delivery" className="text-ocean hover:underline">Security auditing → Delivery</Link>).
      </p>
      <label className="mt-2 flex items-center gap-2 text-soft">
        <input type="checkbox" checked={on}
          onChange={(e) => devConsole.setAuditRead(app.id, e.target.checked).then((r) => (setErr(null), setOn(r.audit_read)), (er: Error) => setErr(er.message))} />
        Audit-read access (administrators; existing tokens are revoked)
      </label>
      {err && <p className="mt-1 text-bad">{err}</p>}
    </div>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (a: DcApp) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"client" | "backend">("client");
  const [redirect, setRedirect] = useState("http://localhost:8080/auth/callback");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [folder, setFolder] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(name.trim() ? [] : ["enter a name"]), ...(folder ? [] : ["choose a Project"])];
  const nameInvalid = tried && !name.trim();
  const projectInvalid = tried && !folder;
  useEffect(() => {
    api.drive.folder(null).then((f) => {
      const ps = f.items.filter((i) => i.kind === "project");
      setProjects(ps);
      setFolder((c) => c || ps[0]?.id || "");
    }, () => {});
  }, []);
  return (
    <Modal title="New application" icon="keyboard" onClose={onClose}>
      <form
        className="space-y-3 p-5 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (missing.length) return;
          try {
            onCreated(await devConsole.create({ name: name.trim(), description: description.trim(), folder_id: folder, kind, redirect_uris: [redirect.trim()] }));
          } catch (ex) {
            setErr((ex as Error).message);
          }
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["client", "Client-facing application", "Runs in the browser (React): users sign in, PKCE, no secret."],
              ["backend", "Backend service", "Runs on a server: a client secret, client credentials."],
            ] as const
          ).map(([k, l, d]) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={`rounded-lg border p-3 text-left ${kind === k ? "border-ocean bg-ocean/10" : "border-line"}`}>
              <div className="font-medium">{l}</div>
              <div className="mt-1 text-[11px] text-muted">{d}</div>
            </button>
          ))}
        </div>
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Name <span className="text-bad" aria-hidden>*</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameInvalid} className={`${inputClass} mt-1 ${nameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} aria-label="Application name" autoFocus />
          {nameInvalid && <span className="mt-1 block text-[11px] text-bad">Give it a name.</span>}
        </label>
        <label className="block text-xs text-muted">
          Description
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} className={`${inputClass} mt-1`} aria-label="Application description" />
        </label>
        <label className="block text-xs text-muted">
          Redirect URL
          <input value={redirect} onChange={(e) => setRedirect(e.target.value)} className={`${inputClass} mt-1 font-mono`} />
        </label>
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Project <span className="text-bad" aria-hidden>*</span></span>
          <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-invalid={projectInvalid} className={`${inputClass} mt-1 ${projectInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} aria-label="Application project">
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {projectInvalid && <span className="mt-1 block text-[11px] text-bad">{projects.length ? "Choose the Project it is saved in." : "No Project to save it in: create or join one first."}</span>}
        </label>
        {err && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</p>}
        <div className="flex items-center justify-end gap-2">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To create: {missingText(missing)}</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" className={buttonClass.primary}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
