"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { codeRepos, type Repo, type RepoSummary } from "@/lib/codeRepos";
import { exportPipelineCode } from "@/lib/exportCode";
import type { Pipeline } from "@/lib/pipeline";
import { Icon } from "../Icon";
import { buttonClass, inputClass, Modal } from "./Modal";

/** Settings → Export code: the pipeline as Python transforms, committed to a Code Repository. */
export function ExportCodeDialog({ pipeline, branch, onClose }: { pipeline: Pipeline; branch: string; onClose: () => void }) {
  const code = useMemo(() => exportPipelineCode(pipeline), [pipeline]);
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [target, setTarget] = useState<string>("new");
  const [newName, setNewName] = useState(`${pipeline.name} export`.slice(0, 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ repo: Repo; replaced: number } | null>(null);
  useEffect(() => {
    let live = true;
    codeRepos.list().then(
      (r) => live && setRepos(r),
      (e: Error) => live && (setRepos([]), setError(e.message)),
    );
    return () => {
      live = false;
    };
  }, []);
  const dir = `src/${code.package}/`;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const repo = target === "new" ? await codeRepos.create(newName.trim()) : await codeRepos.get(target);
      const files = repo.files ?? {};
      // the export owns its package folder: files left there by an earlier export are replaced
      const kept = Object.fromEntries(Object.entries(files).filter(([f]) => !f.startsWith(dir)));
      const replaced = Object.keys(files).length - Object.keys(kept).length;
      // commit on the default branch, or on a new branch when it is protected (then propose it in a pull request)
      let onBranch = repo.branch.name;
      if (repo.branch.protected) {
        onBranch = `export/${pipeline.name.replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase()}-${Date.now().toString(36)}`;
        await codeRepos.createBranch(repo.id, onBranch, repo.branch.name);
      }
      await codeRepos.saveFiles(repo.id, onBranch, { ...kept, ...code.files });
      await codeRepos.commit(repo.id, onBranch, `Export pipeline code from Pipeline Builder: ${pipeline.name} (${branch})`);
      setDone({ repo, replaced });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Export pipeline code" icon="code" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        {done ? (
          <>
            <p className="flex items-center gap-1.5 text-ok">
              <Icon name="check" className="h-4 w-4" /> Exported to {done.repo.name} and committed.
            </p>
            <p className="text-xs text-muted">
              {dir}pipeline_logic.py and pipeline_outputs.py{done.replaced ? ` replace the ${done.replaced} files of the previous export` : ""}. Run Checks in the repository, then build each output.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className={buttonClass.secondary}>
                Close
              </button>
              <Link href={`/code-repositories/${done.repo.id}`} className={buttonClass.primary}>
                <Icon name="external" className="h-3.5 w-3.5" /> Open repository
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-muted">
              Converts the pipeline on <b className="text-soft">{branch}</b> into Python transforms (pandas) in <code>{dir}</code>: one function per node and one transform per output. The export is one-way —
              changes to the code cannot be brought back into the pipeline.
            </p>
            <label className="block text-xs">
              <span className="mb-1 block font-medium text-soft">Target repository</span>
              <select value={target} onChange={(e) => setTarget(e.target.value)} className={inputClass} disabled={!repos}>
                <option value="new">New repository…</option>
                {(repos ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            {target === "new" ? (
              <label className="block text-xs">
                <span className="mb-1 block font-medium text-soft">Repository name</span>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} className={inputClass} />
              </label>
            ) : (
              <p className="rounded bg-warn/10 p-2 text-xs text-warn">Files in {dir} of the repository are replaced; its other files are kept. The previous version stays in the repository&apos;s commit history.</p>
            )}
            <div className="rounded-md border border-line-2 p-2 text-xs">
              <div className="font-medium text-soft">
                {code.outputs} output{code.outputs === 1 ? "" : "s"} · {Object.keys(code.files).length} files
              </div>
              {code.todos.length ? (
                <>
                  <p className="mt-1 text-warn">
                    {code.todos.length} part{code.todos.length === 1 ? "" : "s"} cannot be converted and become todo blocks to write by hand:
                  </p>
                  <ul className="mt-1 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-4 text-muted">
                    {code.todos.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="mt-1 text-ok">Every node converts to code.</p>
              )}
              <p className="mt-1 text-muted">pandas differs from the pipeline engine in edge cases: check the outputs against the pipeline&apos;s.</p>
            </div>
            {error && <p className="text-xs text-bad">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className={buttonClass.secondary}>
                Cancel
              </button>
              <button type="button" disabled={busy || !repos || (target === "new" && !newName.trim())} onClick={run} className={buttonClass.primary}>
                <Icon name={busy ? "refresh" : "code"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Exporting…" : "Export"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
