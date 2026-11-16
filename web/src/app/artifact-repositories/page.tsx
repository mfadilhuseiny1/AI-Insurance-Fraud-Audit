"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { missingText } from "@/components/LocationField";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type DriveItem } from "@/lib/api";
import {
  apiOrigin,
  artifactRepos,
  FORMAT_LABEL,
  publishInstructions,
  type Artifact,
  type ArtifactDetail,
  type ArtifactFormat,
  type RepoOverview,
} from "@/lib/artifactRepos";
import { containers, type ArtifactsRepo } from "@/lib/containers";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { bytes, when } from "@/lib/format";

/** Artifact repositories (palantir.com/docs/foundry/code-repositories/artifact-repositories-nav): Search, Publish and
 *  Overview of an Artifacts repository's Docker images and Conda, PyPI and Maven packages. */
export default function ArtifactRepositoriesPage() {
  return (
    <Suspense fallback={null}>
      <ArtifactRepositories />
    </Suspense>
  );
}

type Tab = "search" | "publish" | "overview";
const TABS: [Tab, string][] = [
  ["search", "Search"],
  ["publish", "Publish"],
  ["overview", "Overview"],
];
const FORMATS: ArtifactFormat[] = ["conda", "pypi", "maven", "docker"];

function ArtifactRepositories() {
  const router = useRouter();
  const params = useSearchParams();
  const [repos, setRepos] = useState<ArtifactsRepo[] | null>(null);
  const [overview, setOverview] = useState<RepoOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const itemParam = params.get("item");
  const tab = (TABS.some(([k]) => k === params.get("tab")) ? params.get("tab") : "search") as Tab;
  const repoId = params.get("repo") ?? (itemParam ? null : (repos?.[0]?.id ?? null));

  const go = useCallback(
    (next: Record<string, string | null>) => {
      const q = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v === null) q.delete(k);
        else q.set(k, v);
      }
      router.replace(`/artifact-repositories?${q.toString()}`);
    },
    [params, router],
  );
  const loadRepos = useCallback(() => {
    containers.repositories().then(setRepos, (e: Error) => (setRepos([]), setError(e.message)));
  }, []);
  useEffect(() => {
    loadRepos();
  }, [loadRepos]);
  useEffect(() => {
    if (!itemParam) return;
    containers.byItem(itemParam).then((d) => go({ item: null, repo: d.id }), (e: Error) => setError(e.message));
  }, [itemParam, go]);
  const loadOverview = useCallback(() => {
    if (!repoId) return;
    artifactRepos.overview(repoId).then(setOverview, (e: Error) => setError(e.message));
  }, [repoId]);
  useEffect(() => {
    loadOverview();
  }, [loadOverview]);
  const shown = overview && overview.id === repoId ? overview : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="rounded-md bg-sand/15 p-1.5 text-sand">
            <Icon name="layers" className="h-4 w-4" />
          </span>
          Artifact repositories
        </div>
        <span className="text-xs text-muted">Conda, PyPI, Maven and Docker artifacts</span>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/artifacts" className="flex items-center gap-1 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white">
            <Icon name="layers" className="h-3.5 w-3.5" /> Artifacts
          </Link>
          <Link href="/containers" className="flex items-center gap-1 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white">
            <Icon name="server" className="h-3.5 w-3.5" /> Containers
          </Link>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-soft">Repositories</span>
            <button type="button" onClick={() => setCreating(true)} className="flex items-center gap-1 text-xs text-ocean hover:underline">
              <Icon name="plus" className="h-3.5 w-3.5" /> New
            </button>
          </div>
          {repos === null && <p className="text-xs text-muted">Loading…</p>}
          {repos?.length === 0 && <p className="text-xs text-muted">No Artifact repositories yet. Create one in a Project.</p>}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {repos?.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => go({ repo: r.id })}
                className={`w-full rounded-md px-3 py-2 text-left text-xs ${r.id === repoId ? "bg-ocean/15 text-white ring-1 ring-ocean/30" : "text-soft hover:bg-panel-2"}`}
              >
                <div className="truncate font-medium">{r.name}</div>
                <div className="truncate text-[11px] text-muted">{r.path}</div>
              </button>
            ))}
          </div>
        </aside>
        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          {error && <p className="mb-3 text-sm text-bad">{error}</p>}
          {shown && (
            <>
              <div className="mb-4 flex items-center gap-3">
                <h1 className="text-lg font-semibold">{shown.name}</h1>
                <span className="font-mono text-[11px] text-muted">{shown.rid}</span>
              </div>
              <div className="mb-5 flex gap-1 border-b border-line">
                {TABS.map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => go({ tab: id })}
                    className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === id ? "border-ocean text-white" : "border-transparent text-muted hover:text-soft"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {tab === "search" && <SearchTab repo={shown} onChanged={loadOverview} />}
              {tab === "publish" && <PublishTab repo={shown} onChanged={loadOverview} />}
              {tab === "overview" && <OverviewTab repo={shown} />}
            </>
          )}
          {!shown && !error && repos && repos.length > 0 && <p className="text-sm text-muted">Loading…</p>}
        </main>
      </div>
      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            loadRepos();
            go({ repo: id, tab: "publish" });
          }}
        />
      )}
    </div>
  );
}

function SearchTab({ repo, onChanged }: { repo: RepoOverview; onChanged: () => void }) {
  const [format, setFormat] = useState<string>("");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Artifact[] | null>(null);
  const [open, setOpen] = useState<ArtifactDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    artifactRepos.artifacts(repo.id, format, q).then(setResults, (e: Error) => setErr(e.message));
  }, [repo.id, format, q]);
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);
  const openArtifact = (a: Artifact) => artifactRepos.artifact(repo.id, a.format, a.name).then(setOpen, (e: Error) => setErr(e.message));
  const refresh = async () => {
    if (open) await openArtifact(open);
    load();
    onChanged();
  };
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <div>
        <div className="mb-3 flex gap-2">
          <select value={format} onChange={(e) => setFormat(e.target.value)} className={`${inputClass} w-36`}>
            <option value="">All formats</option>
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABEL[f]}
              </option>
            ))}
          </select>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search artifacts…" className={inputClass} />
        </div>
        {err && <p className="mb-2 text-xs text-bad">{err}</p>}
        {results?.length === 0 && <p className="rounded-xl border-2 border-dashed border-line-2 py-8 text-center text-sm text-muted">No artifacts. Publish one from the Publish tab.</p>}
        <ul className="space-y-1.5">
          {results?.map((a) => (
            <li key={`${a.format}:${a.name}`}>
              <button
                type="button"
                onClick={() => openArtifact(a)}
                className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm ${open?.name === a.name && open.format === a.format ? "border-ocean/50 bg-ocean/10" : "border-line bg-panel hover:bg-panel-2"}`}
              >
                <span className="rounded bg-panel-2 px-1.5 text-[10px] uppercase tracking-wide text-muted">{FORMAT_LABEL[a.format]}</span>
                <span className="truncate font-mono text-soft">{a.name}</span>
                <span className="ml-auto text-xs text-muted">
                  {a.versions[0]?.version}
                  {a.versions.length > 1 && ` · ${a.versions.length} versions`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>
        {open ? (
          <ArtifactPanel repo={repo} a={open} onChanged={refresh} />
        ) : (
          <p className="text-sm text-muted">Select a search result to view its version history, size and creation date.</p>
        )}
      </div>
    </div>
  );
}

function ArtifactPanel({ repo, a, onChanged }: { repo: RepoOverview; a: ArtifactDetail; onChanged: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const recallable = a.format === "conda" || a.format === "pypi";
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="rounded bg-panel-2 px-1.5 text-[10px] uppercase tracking-wide text-muted">{FORMAT_LABEL[a.format]}</span>
        <span className="font-mono text-sm font-semibold text-soft">{a.name}</span>
      </div>
      {err && <p className="mb-2 text-xs text-bad">{err}</p>}
      <div className="mb-1 text-xs font-medium text-soft">Version history</div>
      <table className="mb-4 w-full text-left text-xs">
        <thead className="text-muted">
          <tr>
            <th className="py-1 font-normal">Version</th>
            <th className="py-1 font-normal">Size</th>
            <th className="py-1 font-normal">Published</th>
            <th className="py-1 font-normal">Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {a.versions.map((v) => (
            <tr key={v.version} className="border-t border-line align-top">
              <td className="py-1.5 font-mono text-soft" title={v.files.join("\n")}>
                {v.version}
              </td>
              <td className="py-1.5 text-muted">{bytes(v.size)}</td>
              <td className="py-1.5 text-muted">
                {v.published_at ? when(v.published_at) : "—"}
                {v.published_by && <span className="block text-[11px]">{v.published_by}</span>}
              </td>
              <td className="py-1.5">
                {v.recalled ? (
                  <span className="rounded bg-bad/15 px-1.5 text-[11px] text-bad" title={`${v.recalled.reason ?? ""} — ${v.recalled.by}, ${when(v.recalled.at)}`}>
                    Recalled
                  </span>
                ) : (
                  <span className="rounded bg-ok/15 px-1.5 text-[11px] text-ok">Available</span>
                )}
              </td>
              <td className="py-1.5 text-right">
                {recallable && repo.can_publish && (
                  <button
                    type="button"
                    className="text-[11px] text-ocean hover:underline"
                    onClick={async () => {
                      if (v.recalled) {
                        if (await confirmDialog(`Unrecall ${a.name} ${v.version}? Consumers can resolve it again.`)) act(() => artifactRepos.unrecall(repo.id, a.format, a.name, v.version));
                        return;
                      }
                      const reason = await promptDialog(`Recall ${a.name} ${v.version}: consumers stop compiling code with it. Have a patch version ready first.`, "", {
                        title: "Recall artifacts",
                        placeholder: "Reason for recalling",
                      });
                      if (reason?.trim()) act(() => artifactRepos.recall(repo.id, a.format, a.name, v.version, reason.trim()));
                    }}
                  >
                    {v.recalled ? "Unrecall" : "Recall"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {a.versions[0]?.depends && a.versions[0].depends.length > 0 && (
        <p className="mb-3 text-[11px] text-muted">
          Depends on <span className="font-mono">{a.versions[0].depends.join(", ")}</span>
        </p>
      )}
      {a.format !== "docker" && (
        <>
          <div className="mb-1 text-xs font-medium text-soft">&lt;/&gt; Consumers</div>
          {a.consumers.length === 0 ? (
            <p className="text-xs text-muted">No repository with this Artifact repository in Settings → Artifacts requires it.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {a.consumers.map((c) => (
                <li key={c.repo_id + c.requested}>
                  <Link href={`/code-repositories/${c.repo_id}`} className="text-ocean hover:underline">
                    {c.repo_name}
                  </Link>{" "}
                  <span className="font-mono text-muted">{c.requested}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function PublishTab({ repo, onChanged }: { repo: RepoOverview; onChanged: () => void }) {
  const [format, setFormat] = useState<ArtifactFormat>("conda");
  const [token, setToken] = useState<{ token: string; expires_at: string | null; user: string; note?: string } | null>(null);
  const [param, setParam] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [subdir, setSubdir] = useState("noarch");
  const [mavenPath, setMavenPath] = useState("");
  const [busy, setBusy] = useState(false);
  const ins = publishInstructions(format, repo.slug, apiOrigin(), token?.user ?? "<user>", token?.token ?? "<token>", param);
  if (!repo.can_publish) return <p className="text-sm text-muted">Publishing needs the Editor role on the Project holding this repository.</p>;
  return (
    <div className="max-w-3xl space-y-5">
      <section>
        <div className="mb-1 text-xs font-medium text-soft">Artifact type</div>
        <select value={format} onChange={(e) => (setFormat(e.target.value as ArtifactFormat), setParam(""))} className={`${inputClass} w-48`}>
          {FORMATS.map((f) => (
            <option key={f} value={f}>
              {FORMAT_LABEL[f]}
            </option>
          ))}
        </select>
      </section>
      <section>
        <div className="mb-1 text-xs font-medium text-soft">Token</div>
        <div className="flex items-center gap-2">
          <input readOnly value={token?.token ?? ""} placeholder="Generate a token to fill in the instructions" className={`${inputClass} font-mono text-xs`} />
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() =>
              artifactRepos.token(repo.id, format).then(
                (t) => (setToken(t), setErr(null)),
                (e: Error) => setErr(e.message),
              )
            }
          >
            Generate token
          </button>
        </div>
        {token && (
          <p className="mt-1 text-[11px] text-muted">
            {token.note ?? (token.expires_at ? `Valid until ${when(token.expires_at)} (a personal API token: Account → API tokens revokes it).` : "Valid until revoked.")}
          </p>
        )}
      </section>
      <section>
        <div className="mb-1 text-xs font-medium text-soft">Parameters</div>
        <input
          value={param}
          onChange={(e) => setParam(e.target.value)}
          placeholder={format === "conda" ? "recipe folder, e.g. conda_recipe/" : format === "maven" ? "extra Gradle arguments" : format === "pypi" ? "build arguments, e.g. --wheel" : "note"}
          className={inputClass}
        />
      </section>
      <section>
        <div className="mb-1 text-xs font-medium text-soft">Instructions — {ins.title}</div>
        <pre className="overflow-x-auto rounded-lg border border-line bg-ink p-3 font-mono text-[11px] text-soft">{ins.commands}</pre>
        <button type="button" className="mt-1 text-[11px] text-ocean hover:underline" onClick={() => navigator.clipboard?.writeText(ins.commands)}>
          Copy
        </button>
      </section>
      <section>
        <div className="mb-1 text-xs font-medium text-soft">Details</div>
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
          {ins.details.map((d) => (
            <li key={d} className="break-all">
              {d}
            </li>
          ))}
        </ul>
      </section>
      {format !== "docker" && (
        <section className="rounded-xl border border-line bg-panel p-4">
          <div className="mb-2 text-xs font-medium text-soft">Or upload a file from this computer</div>
          <div className="flex flex-wrap items-center gap-2">
            {format === "conda" && (
              <select value={subdir} onChange={(e) => setSubdir(e.target.value)} className={`${inputClass} w-36`}>
                {["noarch", "linux-64", "linux-aarch64", "osx-64", "osx-arm64", "win-64"].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            )}
            {format === "maven" && (
              <input value={mavenPath} onChange={(e) => setMavenPath(e.target.value)} placeholder="com/example/lib/1.0.0/lib-1.0.0.jar" className={`${inputClass} w-80 font-mono text-xs`} />
            )}
            <input
              type="file"
              disabled={busy}
              accept={format === "conda" ? ".bz2,.conda" : format === "pypi" ? ".whl,.gz,.zip" : ".jar,.pom,.aar,.zip"}
              className="text-xs text-muted"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                setBusy(true);
                setErr(null);
                setMsg(null);
                try {
                  await artifactRepos.upload(repo.id, format as "conda" | "pypi" | "maven", f, { subdir, path: mavenPath || undefined });
                  setMsg(`Published ${f.name}`);
                  onChanged();
                } catch (ex) {
                  setErr((ex as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </div>
        </section>
      )}
      {err && <p className="text-xs text-bad">{err}</p>}
      {msg && <p className="text-xs text-ok">{msg}</p>}
    </div>
  );
}

function OverviewTab({ repo }: { repo: RepoOverview }) {
  const [arts, setArts] = useState<Artifact[] | null>(null);
  useEffect(() => {
    artifactRepos.artifacts(repo.id).then(setArts, () => setArts([]));
  }, [repo.id]);
  return (
    <div className="space-y-5">
      <dl className="grid max-w-3xl grid-cols-[10rem_1fr] gap-y-1.5 text-sm">
        <dt className="text-muted">Resource ID</dt>
        <dd className="font-mono text-xs text-soft">{repo.rid}</dd>
        <dt className="text-muted">Parent folder</dt>
        <dd className="text-soft">{repo.path}</dd>
        <dt className="text-muted">Created</dt>
        <dd className="text-soft">
          {repo.created_at ? when(repo.created_at) : "—"} {repo.created_by && <span className="text-muted">by {repo.created_by}</span>}
        </dd>
        <dt className="text-muted">Artifacts</dt>
        <dd className="text-soft">
          {FORMATS.map((f) => `${repo.counts[f] ?? 0} ${FORMAT_LABEL[f]}`).join(" · ")} — {repo.versions} versions, {bytes(repo.size)}
        </dd>
        <dt className="text-muted">Delete</dt>
        <dd className="text-xs text-muted">
          Artifacts cannot be deleted one by one. Move the repository to the trash in Files (and Delete permanently there) to remove all of them — a breaking change for
          every consumer.
        </dd>
      </dl>
      <table className="w-full text-left text-xs">
        <thead className="text-muted">
          <tr>
            <th className="py-1 font-normal">Artifact</th>
            <th className="py-1 font-normal">Format</th>
            <th className="py-1 font-normal">Latest</th>
            <th className="py-1 font-normal">Versions</th>
            <th className="py-1 font-normal">Created</th>
          </tr>
        </thead>
        <tbody>
          {arts?.map((a) => (
            <tr key={a.format + a.name} className="border-t border-line">
              <td className="py-1.5 font-mono text-soft">{a.name}</td>
              <td className="py-1.5 text-muted">{FORMAT_LABEL[a.format]}</td>
              <td className="py-1.5 text-soft">{a.versions[0]?.version}</td>
              <td className="py-1.5 text-muted">{a.versions.length}</td>
              <td className="py-1.5 text-muted">{(() => {
                const first = [...a.versions].map((v) => v.published_at).filter(Boolean).sort()[0];
                return first ? when(first) : "—";
              })()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {arts?.length === 0 && <p className="text-sm text-muted">Nothing published yet.</p>}
    </div>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
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
      setFolder((cur) => cur || ps[0]?.id || "");
    }, () => {});
  }, []);
  return (
    <Modal title="New Artifact repository" icon="layers" onClose={onClose}>
      <form
        className="space-y-3 p-5 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (missing.length) return;
          setBusy(true);
          setErr(null);
          try {
            onCreated((await containers.create({ name: name.trim(), folder_id: folder })).id);
          } catch (ex) {
            setErr((ex as Error).message);
            setBusy(false);
          }
        }}
      >
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Name <span className="text-bad" aria-hidden>*</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameInvalid} className={`${inputClass} mt-1 ${nameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} placeholder="shared-libraries" autoFocus />
          {nameInvalid && <span className="mt-1 block text-[11px] text-bad">Give it a name.</span>}
        </label>
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Project <span className="text-bad" aria-hidden>*</span></span>
          <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-invalid={projectInvalid} className={`${inputClass} mt-1 ${projectInvalid ? "border-bad ring-1 ring-bad/40" : ""}`}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {projectInvalid && <span className="mt-1 block text-[11px] text-bad">{projects.length ? "Choose the Project it is saved in." : "No Project to save it in: create or join one first."}</span>}
        </label>
        <p className="text-[11px] text-muted">The Project&apos;s viewers can use its artifacts; editors can publish and recall them.</p>
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
