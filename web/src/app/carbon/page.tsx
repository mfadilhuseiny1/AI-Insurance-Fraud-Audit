"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHome } from "@/components/AppHome";
import { missingText } from "@/components/LocationField";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type DriveItem } from "@/lib/api";
import { carbon, type WorkspaceSummary } from "@/lib/carbon";

/** Carbon (palantir.com/docs/foundry/carbon): curated workspaces for operational users. */
export default function CarbonPage() {
  const router = useRouter();
  const [list, setList] = useState<WorkspaceSummary[] | null>(null);
  const [org, setOrg] = useState<Awaited<ReturnType<typeof carbon.org>> | null>(null);
  const [mine, setMine] = useState<WorkspaceSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    carbon.list().then(setList, (e: Error) => setError(e.message));
    carbon.org().then(setOrg, () => {});
    carbon.me().then((m) => setMine(m.default), () => {});
  }, [nonce]);
  const move = async (i: number, d: number) => {
    if (!org) return;
    const p = [...org.promoted];
    const j = i + d;
    if (j < 0 || j >= p.length) return;
    [p[i], p[j]] = [p[j], p[i]];
    await carbon.putOrg({ promoted: p });
    setNonce((n) => n + 1);
  };
  return (
    <>
      <AppHome
        app="Carbon workspaces"
        icon="cube"
        accent="#10b981"
        href="/carbon"
        tagline="Curated workspaces that give operational users a focused landing page and the modules they need."
        description={<>A workspace gives a group of users a focused landing page and a menu of the modules they need. Promoted workspaces show in every workspace&apos;s Navigation Menu.</>}
        noun={["workspace", "workspaces"]}
        items={
          list?.map((w) => ({
            id: w.id,
            href: `/carbon/${w.id}`,
            title: w.title,
            updated_at: w.updated_at,
            detail: w.description || "No description",
            badges: [...(w.promoted ? [{ label: "promoted", tone: "ok" as const }] : []), ...(mine?.id === w.id ? [{ label: "your default", tone: "ocean" as const }] : [])],
            meta: `v${w.version}`,
          })) ?? null
        }
        stats={
          list
            ? [
                { label: "Workspaces", value: list.length.toLocaleString() },
                { label: "Promoted", value: list.filter((w) => w.promoted).length.toLocaleString() },
                { label: "Nav links", value: (org?.external_links.length ?? 0).toLocaleString() },
              ]
            : undefined
        }
        error={error}
        empty={{
          title: "Create your first workspace",
          hint: "A workspace gives a group of users a focused landing page and a menu of the modules they need.",
          steps: ["Name it and pick its Project", "Add the modules users need", "Promote it to the Navigation Menu"],
        }}
        create={
          <>
            <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Create workspace
            </button>
            {mine && (
              <span className="text-sm text-soft">
                Your default workspace:{" "}
                <Link href={`/carbon/${mine.id}`} className="font-medium hover:underline" style={{ color: "var(--app-accent)" }}>
                  {mine.title}
                </Link>
              </span>
            )}
          </>
        }
      >
          {org && (
            <section className="rounded-xl border border-line bg-panel p-4 text-sm">
              <h2 className="mb-2 font-semibold">Organization: Navigation Menu</h2>
              <p className="mb-2 text-xs text-muted">Promoted workspaces show in every workspace&apos;s Navigation Menu, in this order (users see the ones they can open). Promote a workspace from its Access settings.</p>
              {org.workspaces.map((w, i) => (
                <div key={w.id} className="flex items-center gap-2 border-t border-line py-1.5 text-xs first:border-0">
                  <span className="flex-1">{w.title}</span>
                  {org.can_admin && (
                    <>
                      <button type="button" onClick={() => move(i, -1)} className="text-muted hover:text-white" aria-label="Up">
                        ↑
                      </button>
                      <button type="button" onClick={() => move(i, 1)} className="text-muted hover:text-white" aria-label="Down">
                        ↓
                      </button>
                      <button type="button" onClick={async () => (await carbon.putOrg({ promoted: org.promoted.filter((x) => x !== w.id) }), setNonce((n) => n + 1))} className="text-muted hover:text-bad">
                        Demote
                      </button>
                    </>
                  )}
                </div>
              ))}
              {!org.workspaces.length && <p className="text-xs text-muted">None promoted.</p>}
              {org.can_admin && <OrgLinks org={org} onSaved={() => setNonce((n) => n + 1)} />}
            </section>
          )}
      </AppHome>
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={(id) => router.push(`/carbon/${id}?edit=1`)} />}
    </>
  );
}

function OrgLinks({ org, onSaved }: { org: { external_links: { title: string; url: string }[]; landing: boolean }; onSaved: () => void }) {
  const [text, setText] = useState(org.external_links.map((l) => `${l.title} | ${l.url}`).join("\n"));
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3 text-xs">
      <label className="block text-muted">
        External links in the Navigation Menu (title | URL per line)
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className={`${inputClass} mt-1 font-mono`} />
      </label>
      <label className="flex items-center gap-2 text-muted">
        <input type="checkbox" defaultChecked={org.landing} onChange={async (e) => (await carbon.putOrg({ landing: e.target.checked }), onSaved())} /> Carbon is the landing page for users with a default workspace
      </label>
      <button
        type="button"
        onClick={async () => {
          try {
            await carbon.putOrg({ external_links: text.split("\n").map((l) => l.split("|").map((x) => x.trim())).filter((x) => x[0] && x[1]).map(([title, url]) => ({ title, url })) });
            setMsg("Saved");
            onSaved();
          } catch (e) {
            setMsg((e as Error).message);
          }
        }}
        className={buttonClass.secondary}
      >
        Save links
      </button>
      {msg && <span className="ml-2 text-muted">{msg}</span>}
    </div>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [folder, setFolder] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(title.trim() ? [] : ["enter a name"]), ...(folder ? [] : ["choose a Project"])];
  const nameInvalid = tried && !title.trim();
  const projectInvalid = tried && !folder;
  useEffect(() => {
    api.drive.folder(null).then((f) => {
      const ps = f.items.filter((i) => i.kind === "project");
      setProjects(ps);
      setFolder((c) => c || ps[0]?.id || "");
    }, () => {});
  }, []);
  return (
    <Modal title="Create workspace" icon="cube" onClose={onClose}>
      <form
        className="space-y-3 p-5 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (missing.length) return;
          try {
            onCreated((await carbon.create({ title: title.trim(), folder_id: folder })).id);
          } catch (ex) {
            setErr((ex as Error).message);
          }
        }}
      >
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Name <span className="text-bad" aria-hidden>*</span></span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} aria-invalid={nameInvalid} className={`${inputClass} mt-1 ${nameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} autoFocus />
          {nameInvalid && <span className="mt-1 block text-[11px] text-bad">Give it a name.</span>}
        </label>
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Location (store it with the modules it links: one Project&apos;s permissions) <span className="text-bad" aria-hidden>*</span></span>
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
          <button type="submit" className={buttonClass.primary}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
