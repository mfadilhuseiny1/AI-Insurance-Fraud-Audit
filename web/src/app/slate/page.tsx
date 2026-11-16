"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHome } from "@/components/AppHome";
import { ActionMenu } from "@/components/kg/parts";
import { missingText } from "@/components/LocationField";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type DriveItem } from "@/lib/api";
import { promoteSlateApp, readPromotedApps, unpromotePlatformApp } from "@/lib/platformApps";
import { slate, type SlateAppSummary, type SlateAppType } from "@/lib/slate";
import { ImportDialog } from "@/components/slate/SlateImport";
import { ProductInstallDialog } from "@/components/ProductInstallDialog";

/** Slate (palantir.com/docs/foundry/slate): applications with pages, widgets, queries, functions and events. */
export default function SlatePage() {
  const router = useRouter();
  const [apps, setApps] = useState<SlateAppSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [promoted, setPromoted] = useState<string[]>(() => (typeof window === "undefined" ? [] : readPromotedApps().map((a) => a.id ?? "")));
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    slate.list().then((list) => {
      // opened from Files (?item=<Files item>): go to that application
      const item = new URLSearchParams(window.location.search).get("item");
      const hit = item ? list.find((a) => a.item_id === item) : undefined;
      if (hit) router.replace(`/slate/${hit.id}`);
      setApps(list);
    }, (e: Error) => setError(e.message));
  }, [router]);
  const toggle = (a: SlateAppSummary) => {
    const id = `slate:${a.id}`;
    if (promoted.includes(id)) {
      unpromotePlatformApp(id);
      setPromoted((p) => p.filter((x) => x !== id));
    } else {
      promoteSlateApp({ id, name: a.name, description: a.description || "A Slate application.", icon: "palette", href: `/slate/${a.id}`, owner: "Slate", collection: "Slate applications", tags: ["Slate", a.type === "public" ? "Public" : "Integrated"], trusted: true });
      setPromoted((p) => [...p, id]);
    }
  };
  return (
    <div className="foundry-light flex min-h-0 flex-1 flex-col">
      <AppHome
        app="Slate"
        icon="palette"
        accent="#d946ef"
        href="/slate"
        tagline="Operational applications and dashboards from widgets, queries, functions, events and your own CSS."
        description={
          <>
            <p>Build operational applications and dashboards with drag-and-drop widgets, queries over datasets and APIs, object sets, JavaScript functions, events and your own CSS.</p>
            <p className="mt-2">Public applications are reachable without an account, for forms and uploads from partners.</p>
          </>
        }
        noun={["application", "applications"]}
        items={
          apps?.map((a) => {
            const isPromoted = promoted.includes(`slate:${a.id}`);
            const link = a.type === "public" ? `/s/slate/${a.permalink}` : `/slate/${a.permalink}`;
            return {
              id: a.id,
              href: `/slate/${a.id}`,
              title: a.name,
              path: (a.path ?? []).map((p) => (typeof p === "string" ? p : p.name)),
              updated_at: a.updated_at,
              detail: [link, a.description].filter(Boolean).join(" — "),
              badges: [
                { label: a.type, tone: a.type === "public" ? ("warn" as const) : ("ocean" as const) },
                ...(isPromoted ? [{ label: "Platform Apps", tone: "sand" as const }] : []),
              ],
              meta: `v${a.latest} · ${a.published ? `v${a.published} published` : "not published"}`,
              footer: (
                <>
                  <button type="button" onClick={() => router.push(`/slate/${a.id}?edit=1`)} className="text-ocean hover:underline" data-slate-edit>
                    Edit
                  </button>
                  <Link href={`/slate/${a.id}`} className="text-ocean hover:underline">
                    View
                  </Link>
                  {a.type === "public" && a.published && (
                    <a href={`/s/slate/${a.permalink}`} target="_blank" rel="noreferrer" className="text-ocean hover:underline">
                      Public link
                    </a>
                  )}
                  <button type="button" onClick={() => toggle(a)} className="ml-auto text-muted hover:text-strong">
                    {isPromoted ? "Remove from Platform Apps" : "Add to Platform Apps"}
                  </button>
                </>
              ),
              actions: (
                  <ActionMenu
                    items={[
                      { label: "Edit", icon: "pencil", onClick: () => router.push(`/slate/${a.id}?edit=1`) },
                      { label: "View", icon: "eye", onClick: () => router.push(`/slate/${a.id}`) },
                      ...(a.type === "public" && a.published ? [{ label: "Public link", icon: "external" as const, onClick: () => void window.open(`/s/slate/${a.permalink}`, "_blank", "noreferrer") }] : []),
                      "divider" as const,
                      { label: isPromoted ? "Remove from Platform Apps" : "Add to Platform Apps", icon: isPromoted ? ("star" as const) : ("check" as const), onClick: () => toggle(a) },
                    ]}
                  />
              ),
            };
          }) ?? null
        }
        error={error}
        empty={{
          title: "Build your first Slate application",
          hint: "Integrated applications are for signed-in users; public ones serve forms and uploads to partners without an account.",
          steps: ["Create an application in a Project", "Add pages, widgets and queries", "Publish a version"],
        }}
        create={
          <>
            <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> New application
            </button>
            <button type="button" onClick={() => setImporting(true)} className={buttonClass.secondary}>
              <Icon name="upload" className="h-3.5 w-3.5" /> Import JSON
            </button>
            <button type="button" onClick={() => setInstalling(true)} className={buttonClass.secondary} data-install-product>
              <Icon name="download" className="h-3.5 w-3.5" /> Install product
            </button>
          </>
        }
      />
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={(id) => router.push(`/slate/${id}?edit=1`)} />}
      {installing && (
        <ProductInstallDialog title="Install a Slate product" kind="bluesandai.slate.product" onClose={() => setInstalling(false)}
          install={async (body) => ({ id: (await slate.install(body)).app.id })} onInstalled={(id) => router.push(`/slate/${id}`)} />
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} onImported={(r) => router.push(`/slate/${r.app.id}?edit=1`)} />}
    </div>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [type, setType] = useState<SlateAppType>("integrated");
  const [name, setName] = useState("");
  const [permalink, setPermalink] = useState("");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [folder, setFolder] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(name.trim() ? [] : ["enter a name"]), ...(folder ? [] : ["choose a Project"])];
  const nameInvalid = tried && !name.trim();
  const projectInvalid = tried && !folder;
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.drive.folder(null).then((f) => {
      const ps = f.items.filter((i) => i.kind === "project");
      setProjects(ps);
      setFolder((c) => c || ps[0]?.id || "");
    }, () => {});
  }, []);
  return (
    <Modal title="Create new application" icon="palette" onClose={onClose}>
      <form
        className="space-y-3 p-5 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (missing.length) return;
          setBusy(true);
          setErr(null);
          try {
            const r = await slate.create({ name: name.trim(), folder_id: folder, type, permalink: permalink.trim() || undefined });
            onCreated(r.app.id);
          } catch (ex) {
            setErr((ex as Error).message);
            setBusy(false);
          }
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["integrated", "Integrated application", "For signed-in users: objects, datasets, functions, actions and queries."],
              ["public", "Public application", "Anyone with the link, without an account: forms and secure uploads only. Administrators create them."],
            ] as const
          ).map(([k, l, d]) => (
            <button key={k} type="button" onClick={() => setType(k)} className={`rounded-lg border p-3 text-left ${type === k ? "border-ocean bg-ocean/10" : "border-line hover:border-line-2"}`}>
              <div className="font-medium">{l}</div>
              <div className="mt-1 text-[11px] text-muted">{d}</div>
            </button>
          ))}
        </div>
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Title <span className="text-bad" aria-hidden>*</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameInvalid} className={`${inputClass} mt-1 ${nameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} autoFocus />
          {nameInvalid && <span className="mt-1 block text-[11px] text-bad">Give it a name.</span>}
        </label>
        <label className="block text-xs text-muted">
          Permalink (optional; lowercase letters, digits and dashes)
          <input value={permalink} onChange={(e) => setPermalink(e.target.value.toLowerCase())} className={`${inputClass} mt-1 font-mono`} placeholder="jkn-claims-review" />
        </label>
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Location (Project) <span className="text-bad" aria-hidden>*</span></span>
          <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-invalid={projectInvalid} className={`${inputClass} mt-1 ${projectInvalid ? "border-bad ring-1 ring-bad/40" : ""}`}>
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
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
