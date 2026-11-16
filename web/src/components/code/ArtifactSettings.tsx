"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ErrorBox } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { codeRepos, type ArtifactSettings, type SharedJavaRepo } from "@/lib/codeRepos";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy the build.gradle line"
      onClick={() => navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {})}
      className="flex min-w-0 items-center gap-1.5 rounded bg-panel-2 px-2 py-1 text-left font-mono text-[11px] text-soft hover:text-white"
    >
      <span className="truncate">{text}</span>
      <Icon name={copied ? "check" : "copy"} className="h-3 w-3 shrink-0" />
    </button>
  );
}

/** Settings → Artifacts: the shared Java repositories (backing repositories) this repository's build.gradle may
 *  reference with compile '<rid>:<subproject>:<version>'. Adding one also adds its own backing repositories. */
export function ArtifactSettingsSection({ repoId, readOnly = false }: { repoId: string; readOnly?: boolean }) {
  const [data, setData] = useState<ArtifactSettings | null>(null);
  const [adding, setAdding] = useState("");
  const [addingDocker, setAddingDocker] = useState("");
  const [libQuery, setLibQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    codeRepos.artifactSettings(repoId).then(setData, (e: Error) => setError(e.message));
  }, [repoId]);
  useEffect(load, [load]);
  const save = async (repos: string[]) => {
    setError(null);
    try {
      setData(await codeRepos.saveArtifactSettings(repoId, repos));
      setAdding("");
      setAddingDocker("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const ids = (data?.backing ?? []).map((b) => b.repo_id);
  return (
    <section className="rounded-xl border border-line bg-panel p-5 text-sm">
      <div className="mb-1 font-semibold">Artifacts</div>
      <p className="mb-3 text-xs text-muted">
        Shared Java code from other repositories. Add a repository here, then reference it in your subproject&apos;s <span className="font-mono">build.gradle</span> (for
        example <span className="font-mono">transforms-java/build.gradle</span>, not the root one). Each commit of its default branch whose checks pass publishes a new
        version: bump the version in your <span className="font-mono">compile</span> line to pick up changes.
      </p>
      <ErrorBox message={error} />
      {data === null && !error && <p className="text-xs text-muted">Loading…</p>}
      {data && (
        <>
          {data.backing.length === 0 && <p className="mb-3 text-xs text-muted">No backing repositories.</p>}
          <ul className="mb-3 space-y-2">
            {data.backing.map((b) => (
              <li key={b.repo_id} className="rounded-md border border-line-2 p-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <Icon name={b.docker ? "server" : "code"} className={`h-3.5 w-3.5 ${b.docker ? "text-ocean" : "text-sand"}`} />
                  {b.docker ? (
                    b.missing ? (
                      <span className="font-mono text-bad">{b.repo_id} (deleted or not visible)</span>
                    ) : (
                      <Link href={`/artifact-repositories?repo=${b.repo_id}`} className="font-medium text-soft hover:text-white hover:underline">
                        {b.name} <span className="font-normal text-muted">Artifacts repository · {b.path}</span>
                      </Link>
                    )
                  ) : b.builtin ? (
                    <span className="font-medium text-soft" title={b.description}>
                      {b.name} <span className="font-normal text-muted">(built-in library)</span>
                    </span>
                  ) : b.missing ? (
                    <span className="font-mono text-bad">{b.repo_id} (deleted)</span>
                  ) : (
                    <Link href={`/code-repositories/${b.repo_id}`} className="font-medium text-soft hover:text-white hover:underline">
                      {b.name}
                    </Link>
                  )}
                  {b.latest && <span className="rounded bg-ok/15 px-1.5 text-[11px] text-ok">{b.latest}</span>}
                  {b.docker ? (
                    <span className="truncate text-muted">
                      {[
                        b.images?.length ? `images: ${b.images.join(", ")}` : "",
                        b.packages?.conda ? `${b.packages.conda} Conda` : "",
                        b.packages?.pypi ? `${b.packages.pypi} PyPI` : "",
                        b.packages?.maven ? `${b.packages.maven} Maven` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ") || "nothing published yet"}
                    </span>
                  ) : b.referenced && b.referenced.length > 0 ? (
                    <span className="text-muted">used: {b.referenced.map((c) => c.split(":").slice(1).join(":")).join(", ")}</span>
                  ) : (
                    <span className="text-muted">not referenced in build.gradle</span>
                  )}
                  {!readOnly && (
                    <button
                      type="button"
                      title="Remove"
                      onClick={async () =>
                        (await confirmDialog(`Remove ${b.name}? Builds of transforms that use its code will fail until it is added back.`)) && save(ids.filter((x) => x !== b.repo_id))
                      }
                      className="ml-auto text-muted hover:text-bad"
                    >
                      <Icon name="trash" className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {b.compile && (
                  <div className="mt-1.5">
                    <CopyLine text={b.compile} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {readOnly && (
            <p className="text-xs text-muted" data-testid="artifacts-read-only">
              Read-only: the repository&apos;s owners add and remove backing repositories and libraries.
            </p>
          )}
          <fieldset disabled={readOnly} hidden={readOnly} className="m-0 min-w-0 border-0 p-0">
          <div className="flex items-center gap-2">
            <select value={adding} onChange={(e) => setAdding(e.target.value)} className={`${inputClass} max-w-xs text-xs`}>
              <option value="">Add a shared Java repository…</option>
              {data.available.map((r) => (
                <option key={r.repo_id} value={r.repo_id}>
                  {r.name}
                </option>
              ))}
            </select>
            <button type="button" disabled={!adding} onClick={() => save([...ids, adding])} className={buttonClass.secondary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Add
            </button>
            {data.available.length === 0 && <span className="text-xs text-muted">No other repositories with Java code.</span>}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <select value={addingDocker} onChange={(e) => setAddingDocker(e.target.value)} className={`${inputClass} max-w-xs text-xs`}>
              <option value="">Add an Artifacts repository…</option>
              {(data.docker_available ?? []).map((r) => (
                <option key={r.repo_id} value={r.repo_id}>
                  {r.name} ({r.path})
                </option>
              ))}
            </select>
            <button type="button" disabled={!addingDocker} onClick={() => save([...ids, addingDocker])} className={buttonClass.secondary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> Add
            </button>
            <span className="text-xs text-muted">
              Its Docker images run as <span className="font-mono">@sidecar</span> containers, its Conda and PyPI packages resolve in{" "}
              <span className="font-mono">meta.yaml</span>, its Maven artifacts in <span className="font-mono">build.gradle</span> (
              <Link href="/artifact-repositories" className="text-ocean hover:underline">Artifact repositories</Link>). Other Maven artifacts come from Maven Central.
            </span>
          </div>
          </fieldset>
          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-1 text-xs font-medium text-soft">Maven libraries</div>
            <input value={libQuery} onChange={(e) => setLibQuery(e.target.value)} placeholder="Search libraries, e.g. transforms-excel-parser" className={`${inputClass} max-w-md text-xs`} />
            <ul className="mt-2 space-y-2">
              {(data.libraries ?? [])
                .filter((l) => !libQuery.trim() || `${l.name} ${l.library ?? ""} ${l.description ?? ""}`.toLowerCase().includes(libQuery.trim().toLowerCase()))
                .map((l) => (
                  <li key={l.repo_id} className="rounded-md border border-line-2 p-2.5 text-xs">
                    <div className="flex items-center gap-2">
                      <Icon name="layers" className="h-3.5 w-3.5 text-ocean" />
                      <span className="font-mono text-soft">{l.library ?? l.name}</span>
                      <span className="rounded bg-ok/15 px-1.5 text-[11px] text-ok">{l.latest}</span>
                      {!readOnly && (
                        <button type="button" onClick={() => save([...ids, l.repo_id])} className={`${buttonClass.secondary} ml-auto py-0.5 text-xs`} title={`Adds ${l.name} as a backing repository`}>
                          <Icon name="plus" className="h-3.5 w-3.5" /> Add library
                        </button>
                      )}
                    </div>
                    {l.description && <p className="mt-1 text-muted">{l.description}</p>}
                    <p className="mt-1 text-muted">
                      Adds <span className="font-mono">{l.name}</span> as a backing repository; then add this line to <span className="font-mono">transforms-java/build.gradle</span>:
                    </p>
                    <div className="mt-1">
                      <CopyLine text={l.compile} />
                    </div>
                  </li>
                ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}

/** Artifacts app: shared Java repositories, their published versions and the repositories that use them. */
export function SharedJavaRepos({ repos }: { repos: (SharedJavaRepo & { builtin?: boolean; description?: string })[] }) {
  if (!repos.length)
    return (
      <p className="rounded-xl border-2 border-dashed border-line-2 py-10 text-center text-sm text-muted">
        No Java repositories yet. Create one from the Java template: each commit whose checks pass publishes its code.
      </p>
    );
  return (
    <div className="space-y-3">
      {repos.map((r) => (
        <div key={r.repo_id} className="rounded-xl border border-line bg-panel p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Icon name="code" className="h-4 w-4 text-sand" />
            {r.builtin ? (
              <span className="text-sm font-semibold text-soft">
                {r.name} <span className="text-xs font-normal text-muted">built-in library</span>
              </span>
            ) : (
              <Link href={`/code-repositories/${r.repo_id}`} className="text-sm font-semibold text-soft hover:text-white hover:underline">
                {r.name}
              </Link>
            )}
            {r.latest && <span className="rounded bg-ok/15 px-1.5 text-[11px] text-ok">{r.latest}</span>}
            <span className="font-mono text-[11px] text-muted">{r.subprojects.join(", ")}</span>
          </div>
          {r.description && <p className="mt-1 text-xs text-muted">{r.description}</p>}
          {r.compile && (
            <div className="mt-2 max-w-2xl">
              <CopyLine text={r.compile} />
            </div>
          )}
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Versions</div>
              <ul className="space-y-0.5 text-xs">
                {r.versions.slice(0, 10).map((v) => (
                  <li key={v.version} className="flex items-center gap-2" title={v.published ? "Compiled and published" : "Compiled the first time a repository needs it"}>
                    <span className={v.published ? "text-ok" : "text-muted"}>{v.published ? "✓" : "○"}</span>
                    <span className="font-mono text-soft">{v.version}</span>
                    <span className="font-mono text-muted">{v.commit.slice(0, 7)}</span>
                    <span className="truncate text-muted">{v.message}</span>
                    <span className="ml-auto shrink-0 text-muted">{v.at ? when(v.at) : ""}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Consumers</div>
              {!r.consumers?.length && <p className="text-xs text-muted">No repository has added it yet.</p>}
              <ul className="space-y-0.5 text-xs">
                {r.consumers?.map((c) => (
                  <li key={c.repo_id} className="flex items-center gap-2">
                    <Link href={`/code-repositories/${c.repo_id}`} className="text-ocean hover:underline">
                      {c.name}
                    </Link>
                    <span className="truncate font-mono text-muted">{c.coordinates.map((x) => x.split(":").slice(1).join(":")).join(", ") || "not referenced yet"}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
