"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { SharedJavaRepos } from "@/components/code/ArtifactSettings";
import { codeRepos, type PublishedUdf, type PythonLibrary, type SharedJavaRepo } from "@/lib/codeRepos";
import { alertDialog, promptDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";

type Tab = "python" | "java" | "udfs";

/** Artifacts: libraries and artifacts published from Code Repositories — Python libraries (tagged versions whose
 *  checks passed, and the repositories that consume them) and Java UDF versions for Pipeline Builder. */
export default function ArtifactsPage() {
  const [data, setData] = useState<{ python_libraries: PythonLibrary[]; udfs: PublishedUdf[]; python: string; java_repositories: SharedJavaRepo[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("python");
  const load = () => codeRepos.artifacts().then(setData, (e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl p-8">
        <h1 className="mb-1 flex items-center gap-2 text-xl font-semibold">
          <Icon name="layers" className="h-5 w-5 text-ocean" /> Artifacts
        </h1>
        <p className="mb-5 text-sm text-muted">
          Libraries published from Code Repositories. A Python library repository publishes a version when you tag a commit and its checks pass; other repositories add the
          package to their <span className="font-mono">conda_recipe/meta.yaml</span> to import it. A Java repository publishes its compiled code with every commit of its
          default branch whose checks pass; other repositories add it in Settings → Artifacts and reference it in <span className="font-mono">build.gradle</span>. Java UDF
          versions are imported into Pipeline Builder.
        </p>
        <div className="mb-4 flex items-center gap-1">
          {(
            [
              ["python", "Python libraries", data?.python_libraries.length],
              ["java", "Shared Java code", data?.java_repositories.length],
              ["udfs", "Java UDFs", data?.udfs.length],
            ] as [Tab, string, number | undefined][]
          ).map(([id, label, n]) => (
            <button key={id} type="button" onClick={() => setTab(id)} className={`rounded-md px-3 py-1.5 text-sm ${tab === id ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:bg-panel-2"}`}>
              {label}
              {n !== undefined && <span className="ml-1.5 text-xs text-muted">{n}</span>}
            </button>
          ))}
          <Link href="/artifact-repositories" className="ml-auto text-sm text-ocean hover:underline">
            Artifact repositories →
          </Link>
          <Link href="/code-repositories" className="text-sm text-ocean hover:underline">
            New library repository →
          </Link>
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        {!data && !error && <p className="text-sm text-muted">Loading…</p>}
        {data && tab === "python" && <PythonLibraries libs={data.python_libraries} onChanged={load} />}
        {data && tab === "java" && <SharedJavaRepos repos={data.java_repositories} />}
        {data && tab === "udfs" && <Udfs udfs={data.udfs} />}
      </div>
    </div>
  );
}

function PythonLibraries({ libs, onChanged }: { libs: PythonLibrary[]; onChanged: () => void }) {
  if (!libs.length)
    return (
      <p className="rounded-xl border-2 border-dashed border-line-2 py-10 text-center text-sm text-muted">
        No Python libraries yet. Create a repository from the Python Library template, then tag a version.
      </p>
    );
  return (
    <div className="space-y-3">
      {libs.map((l) => {
        const published = l.versions.filter((v) => v.ok);
        return (
          <div key={l.name} className="rounded-xl border border-line bg-panel p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Icon name="layers" className="h-4 w-4 text-sand" />
              <span className="font-mono text-sm font-semibold text-soft">{l.name}</span>
              {published[0] && <span className="rounded bg-ok/15 px-1.5 text-[11px] text-ok">{published[0].version}</span>}
              <Link href={`/code-repositories/${l.repo_id}`} className="text-xs text-ocean hover:underline">
                {l.repo_name}
              </Link>
              <span className="ml-auto font-mono text-[11px] text-muted">
                meta.yaml run: - {l.name}
                {published[0] ? ` ${published[0].version}` : ""}
              </span>
            </div>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <div>
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Versions</div>
                {l.versions.length === 0 && <p className="text-xs text-muted">No tags yet.</p>}
                <ul className="space-y-0.5 text-xs">
                  {l.versions.map((v) => (
                    <li key={v.version} className="flex items-center gap-2">
                      <span className={v.ok ? "text-ok" : "text-muted"}>{v.ok ? "✓" : "○"}</span>
                      <span className="font-mono text-soft">{v.version}</span>
                      <span className="text-muted">{v.tagged_at ? when(v.tagged_at) : ""}</span>
                      <span className="text-muted">{v.ok ? `${v.files} files` : v.reason}</span>
                      {(v.ok || v.recalled) && (
                        <button
                          type="button"
                          className="ml-auto text-[11px] text-ocean hover:underline"
                          onClick={async () => {
                            try {
                              if (v.recalled) await codeRepos.unrecallLibrary(l.name, v.version);
                              else {
                                const reason = await promptDialog(`Recall ${l.name} ${v.version}? Repositories stop resolving it in meta.yaml (have a patch version ready).`, "", {
                                  title: "Recall artifacts",
                                  placeholder: "Reason for recalling",
                                });
                                if (!reason?.trim()) return;
                                await codeRepos.recallLibrary(l.name, v.version, reason.trim());
                              }
                              onChanged();
                            } catch (e) {
                              alertDialog((e as Error).message);
                            }
                          }}
                        >
                          {v.recalled ? "Unrecall" : "Recall"}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Consumers</div>
                {l.consumers.length === 0 && <p className="text-xs text-muted">No repository requires it yet.</p>}
                <ul className="space-y-0.5 text-xs">
                  {l.consumers.map((c) => (
                    <li key={c.repo_id}>
                      <Link href={`/code-repositories/${c.repo_id}`} className="text-ocean hover:underline">
                        {c.repo_name}
                      </Link>{" "}
                      <span className="font-mono text-muted">{c.requested}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Udfs({ udfs }: { udfs: PublishedUdf[] }) {
  if (!udfs.length) return <p className="rounded-xl border-2 border-dashed border-line-2 py-10 text-center text-sm text-muted">No Java UDFs yet.</p>;
  return (
    <table className="w-full rounded-xl border border-line bg-panel text-sm">
      <thead className="text-left text-xs text-muted">
        <tr className="border-b border-line">
          <th className="px-3 py-2">UDF</th>
          <th className="px-3 py-2">Repository</th>
          <th className="px-3 py-2">Version</th>
          <th className="px-3 py-2">Status</th>
        </tr>
      </thead>
      <tbody>
        {udfs.map((u, i) => (
          <tr key={`${u.repo_id}${u.tag}${u.name}${i}`} className="border-b border-line align-top text-xs last:border-0">
            <td className="px-3 py-2">
              <span className="font-medium text-soft">{u.name ?? "—"}</span>
              <div className="text-muted">{u.type === "flat_map" ? "flat map" : u.type === "keyed_process" ? `keyed process (by ${(u.key_columns ?? []).join(", ")})` : "row map"}{u.description ? ` · ${u.description}` : ""}</div>
            </td>
            <td className="px-3 py-2">
              <Link href={`/code-repositories/${u.repo_id}`} className="text-ocean hover:underline">
                {u.repo_name}
              </Link>
            </td>
            <td className="px-3 py-2 font-mono text-soft">{u.tag}</td>
            <td className="px-3 py-2">{u.published ? <span className="text-ok">Published</span> : <span className="text-muted">{u.reason ?? "not published"}</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
