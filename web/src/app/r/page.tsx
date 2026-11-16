"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { codeRepos, type BuildRecord, type Check, type Repo, type TransformInfo } from "@/lib/codeRepos";
import { alertDialog, promptDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { lockedPackages, rTransforms, usedPackages, type RPackage, type RRepository, type RRuntime } from "@/lib/rTransforms";

/** R transforms (palantir.com/docs/foundry/transforms-r): repositories of `.transforms/*.yml` specs and R scripts that
 *  run on one node with the Palantir R SDK (`datasets.read_table` / `write_table` / `upload_files`), packages from
 *  CRAN / Posit Package Manager / Bioconductor and renv. Builds and checks are Code Repositories'. */
export default function RTransformsPage() {
  return (
    <Suspense fallback={null}>
      <RWorkspace />
    </Suspense>
  );
}

type Tab = "code" | "spec" | "packages";
type Loaded = { r: Repo; checks: Check[]; all: BuildRecord[] };

async function fetchRepo(id: string, branch?: string): Promise<Loaded> {
  const r = await codeRepos.get(id, branch);
  const [checks, all] = await Promise.all([codeRepos.checks(id, r.branch.name).catch(() => [] as Check[]), codeRepos.builds(id).catch(() => [] as BuildRecord[])]);
  return { r, checks, all };
}

const NEW_SCRIPT = `library(foundry)

input <- datasets.read_table("input_alias")
datasets.write_table(input, "output_alias")
`;
const NEW_SPEC = (script: string) => `inputs:
- alias: "input_alias"
  properties:
    type: "dataset"
    dataset:
      rid: "<input dataset path or id>"
outputs:
- alias: "output_alias"
  properties:
    type: "dataset"
    dataset:
      rid: "output_alias"
runtime:
  type: "rscript"
  rscript:
    identifier: "R.4.1.x"
    filePath: "${script}"
`;

function RWorkspace() {
  const router = useRouter();
  const params = useSearchParams();
  const repoId = params.get("repo");
  const [repos, setRepos] = useState<RRepository[] | null>(null);
  const [runtime, setRuntime] = useState<RRuntime | null>(null);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [active, setActive] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("code");
  const [check, setCheck] = useState<Check | null>(null);
  const [builds, setBuilds] = useState<BuildRecord[]>([]);
  const [busy, setBusy] = useState<null | "save" | "checks" | "build" | "commit">(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad" | "muted"; text: string } | null>(null);

  useEffect(() => {
    rTransforms.runtime().then(setRuntime, () => setRuntime(null));
    rTransforms.repositories().then(setRepos, (e: Error) => {
      setRepos([]);
      setMessage({ tone: "bad", text: e.message });
    });
  }, []);
  useEffect(() => {
    if (!repoId && repos?.length) router.replace(`/r?repo=${repos[0].id}`);
  }, [repoId, repos, router]);

  const apply = useCallback(({ r, checks, all }: Loaded) => {
    setRepo(r);
    setBranch(r.branch.name);
    setFiles(r.files);
    setSaved(r.files);
    setActive((cur) => (cur && cur in r.files ? cur : (Object.keys(r.files).find((p) => /\.r$/i.test(p)) ?? Object.keys(r.files)[0] ?? null)));
    setCheck(checks[0] ?? null);
    setBuilds(all.filter((x) => (x.branch ?? r.default_branch) === r.branch.name));
  }, []);
  const load = useCallback((id: string, b?: string) => fetchRepo(id, b).then(apply), [apply]);
  useEffect(() => {
    if (!repoId) return;
    let alive = true;
    fetchRepo(repoId).then(
      (d) => alive && apply(d),
      (e: Error) => alive && setMessage({ tone: "bad", text: e.message }),
    );
    return () => {
      alive = false;
    };
  }, [repoId, apply]);

  const changed = useMemo(() => Object.keys(files).filter((p) => files[p] !== saved[p]), [files, saved]);
  const specs = useMemo(() => Object.keys(files).filter((p) => p.startsWith(".transforms/") && /\.ya?ml$/.test(p)).sort(), [files]);
  const rTransformsOf = useMemo(() => (check?.transforms ?? []).filter((t) => t.language === "r"), [check]);
  const [buildTarget, setBuildTarget] = useState<string>("");
  const target = buildTarget || specs[0] || "";

  const save = async (): Promise<boolean> => {
    if (!repo || !branch || !changed.length) return true;
    setBusy("save");
    try {
      await codeRepos.saveFiles(repo.id, branch, Object.fromEntries(changed.map((p) => [p, files[p]])));
      setSaved({ ...saved, ...Object.fromEntries(changed.map((p) => [p, files[p]])) });
      return true;
    } catch (e) {
      setMessage({ tone: "bad", text: (e as Error).message });
      return false;
    } finally {
      setBusy(null);
    }
  };
  const runChecks = async () => {
    if (!repo || !branch || !(await save())) return;
    setBusy("checks");
    setMessage({ tone: "muted", text: "Running checks: the transform specs resolve, the R files parse…" });
    try {
      const c = await codeRepos.runChecks(repo.id, branch);
      setCheck(c);
      const failed = c.tests.filter((t) => !t.ok && !t.skipped).length + c.errors.filter((e) => !("warning" in e && (e as { warning?: boolean }).warning)).length;
      setMessage(c.status === "passed" ? { tone: "ok", text: "Checks passed · inputs and outputs resolved" } : { tone: "bad", text: c.error ?? `Checks failed (${failed} problem${failed === 1 ? "" : "s"})` });
    } catch (e) {
      setMessage({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const build = async () => {
    if (!repo || !branch || !target || !(await save())) return;
    setBusy("build");
    setMessage({ tone: "muted", text: `Building ${target}… (the first build of new packages installs them)` });
    try {
      const out = await codeRepos.build(repo.id, branch, { transform: target });
      const b = out[0];
      setBuilds((prev) => [...out, ...prev]);
      setMessage(b?.status === "succeeded" ? { tone: "ok", text: `Build succeeded · ${b.outputs?.length ?? (b.output ? 1 : 0)} output(s) written` } : { tone: "bad", text: b?.error ?? "Build failed" });
    } catch (e) {
      setMessage({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const commit = async () => {
    if (!repo || !branch || !(await save())) return;
    const msg = await promptDialog("Commit message", changed.length ? `Update ${changed.slice(0, 2).join(", ")}` : "", { title: "Commit" });
    if (!msg) return;
    setBusy("commit");
    try {
      await codeRepos.commit(repo.id, branch, msg);
      await load(repo.id, branch);
      setMessage({ tone: "ok", text: "Committed: checks run on the commit" });
    } catch (e) {
      setMessage({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const newRepository = async () => {
    const name = await promptDialog("Name of the new R repository", "r-transforms", { title: "New R repository" });
    if (!name) return;
    try {
      const r = await codeRepos.create(name, "R transforms", "r");
      setRepos(await rTransforms.repositories());
      router.push(`/r?repo=${r.id}`);
    } catch (e) {
      void alertDialog((e as Error).message);
    }
  };
  const newFile = async (kind: "script" | "spec") => {
    const path = await promptDialog(kind === "script" ? "Path of the new R script" : "Path of the new transform spec", kind === "script" ? "project/src/new_transform.R" : ".transforms/new_transform.yml", {
      title: kind === "script" ? "New R script" : "New transform spec",
    });
    if (!path) return;
    if (files[path] !== undefined) return void alertDialog(`${path} already exists`);
    const script = Object.keys(files).find((p) => /\.r$/i.test(p)) ?? "project/src/new_transform.R";
    setFiles({ ...files, [path]: kind === "script" ? NEW_SCRIPT : NEW_SPEC(script) });
    setActive(path);
    setTab("code");
  };

  const status = runtime?.available ? (
    <span className="flex items-center gap-1.5 text-xs text-ok" title={runtime.executable ?? undefined}>
      <span className="h-1.5 w-1.5 rounded-full bg-ok" />R {runtime.version}
    </span>
  ) : (
    <span className="flex items-center gap-1.5 text-xs text-bad" title={runtime?.error ?? undefined}>
      <span className="h-1.5 w-1.5 rounded-full bg-bad" />
      {runtime ? "Rscript not found" : "R runtime…"}
    </span>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="rounded-md bg-ocean/15 p-1.5 text-ocean">
            <Icon name="code" className="h-4 w-4" />
          </span>
          R transforms
        </div>
        <select
          value={repoId ?? ""}
          onChange={(e) => e.target.value && router.push(`/r?repo=${e.target.value}`)}
          className="max-w-[14rem] rounded-md border border-line-2 bg-ink px-2 py-1 text-xs text-soft outline-none"
          aria-label="R repository"
        >
          {!repos?.length && <option value="">{repos ? "No R repositories" : "Loading…"}</option>}
          {repos?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={newRepository} className="flex items-center gap-1 text-xs text-ocean hover:underline" title="A new Code Repositories repository from the R template">
          <Icon name="plus" className="h-3.5 w-3.5" /> New
        </button>
        {repo && active && <span className="truncate text-xs text-muted">{repo.name} · {active}</span>}
        <div className="ml-auto flex items-center gap-2">
          {status}
          {repo && (
            <Link href={`/code-repositories/${repo.id}?branch=${encodeURIComponent(branch ?? "")}`} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted hover:text-white" title="Open in Code Repositories (pull requests, history, schedules)">
              <Icon name="external" className="h-3.5 w-3.5" /> Code Repositories
            </Link>
          )}
          <button type="button" disabled={!repo || !changed.length || !!busy} onClick={() => void save()} className="flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white disabled:opacity-40">
            <Icon name="save" className="h-3.5 w-3.5" /> {busy === "save" ? "Saving…" : changed.length ? `Save (${changed.length})` : "Saved"}
          </button>
          <button type="button" disabled={!repo || !!busy} onClick={commit} className="flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white disabled:opacity-40">
            <Icon name="check" className="h-3.5 w-3.5" /> Commit
          </button>
          <button type="button" disabled={!repo || !!busy} onClick={runChecks} className="flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white disabled:opacity-40">
            <Icon name="refresh" className={`h-3.5 w-3.5 ${busy === "checks" ? "animate-spin" : ""}`} /> {busy === "checks" ? "Checking…" : "Run checks"}
          </button>
          <div className="flex items-center">
            {specs.length > 1 && (
              <select value={target} onChange={(e) => setBuildTarget(e.target.value)} className="rounded-l-md border border-r-0 border-line-2 bg-ink px-2 py-1.5 text-xs text-soft outline-none" aria-label="Transform to build">
                {specs.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/^\.transforms\//, "")}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              disabled={!repo || !target || !!busy || !runtime?.available}
              onClick={build}
              title={!runtime?.available ? runtime?.error ?? undefined : `Build ${target}`}
              className={`flex items-center gap-1.5 bg-ocean px-3 py-1.5 text-xs font-medium text-white hover:bg-ocean-deep disabled:opacity-40 ${specs.length > 1 ? "rounded-r-md" : "rounded-md"}`}
            >
              <Icon name="play" className="h-3.5 w-3.5" /> {busy === "build" ? "Building…" : "Build"}
            </button>
          </div>
        </div>
      </header>
      {!repos?.length && repos !== null ? (
        <Empty onNew={newRepository} runtime={runtime} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
            <div className="border-b border-line p-3">
              <div className="text-xs font-semibold text-soft">Repository</div>
              <div className="mt-1 text-[10px] text-muted">{repo ? `${Object.keys(files).length} files · ${specs.length} transform spec${specs.length === 1 ? "" : "s"}` : "R transform project"}</div>
            </div>
            <FileTree files={files} active={active} changed={changed} onOpen={(p) => (setActive(p), setTab("code"))} />
            <div className="flex gap-2 border-t border-line px-3 py-2 text-[11px]">
              <button type="button" onClick={() => newFile("script")} className="flex items-center gap-1 text-ocean hover:underline" disabled={!repo}>
                <Icon name="plus" className="h-3 w-3" /> R script
              </button>
              <button type="button" onClick={() => newFile("spec")} className="flex items-center gap-1 text-ocean hover:underline" disabled={!repo}>
                <Icon name="plus" className="h-3 w-3" /> Transform spec
              </button>
            </div>
            <div className="border-t border-line p-3 text-[10px] text-muted">
              <div className="mb-1 text-soft">Branch</div>
              <select
                value={branch ?? ""}
                onChange={(e) => repo && load(repo.id, e.target.value).catch((err: Error) => setMessage({ tone: "bad", text: err.message }))}
                className="w-full rounded bg-panel-2 px-2 py-1 font-mono text-[11px] text-soft outline-none"
                aria-label="Branch"
              >
                {(repo?.branches ?? []).map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-11 shrink-0 items-end gap-1 border-b border-line bg-panel px-3">
              {(
                [
                  ["code", active ? active.split("/").pop() : "Editor"],
                  ["spec", "Transform spec"],
                  ["packages", "Packages"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" onClick={() => setTab(id)} className={`border-b-2 px-3 pb-2.5 text-xs ${tab === id ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>
                  {label}
                  {id === "code" && active && changed.includes(active) ? " •" : ""}
                </button>
              ))}
            </div>
            {tab === "code" && (
              <Editor
                path={active}
                value={active ? (files[active] ?? "") : ""}
                onChange={(v) => active && setFiles({ ...files, [active]: v })}
                message={message}
                check={check}
              />
            )}
            {tab === "spec" && <SpecTab specs={specs} files={files} transforms={rTransformsOf} checked={!!check} onEdit={(p) => (setActive(p), setTab("code"))} onRunChecks={runChecks} />}
            {tab === "packages" && repo && branch && (
              <PackagesTab repo={repo} branch={branch} files={files} runtime={runtime} onLockWritten={() => load(repo.id, branch)} onOpen={(p) => (setActive(p), setTab("code"))} />
            )}
          </main>
          <aside className="hidden w-72 shrink-0 border-l border-line bg-panel lg:flex lg:flex-col">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-medium">
              <Icon name="output" className="h-4 w-4 text-ocean" /> Transform outputs
            </div>
            <Outputs builds={builds} transforms={rTransformsOf} />
          </aside>
        </div>
      )}
    </div>
  );
}

function Empty({ onNew, runtime }: { onNew: () => void; runtime: RRuntime | null }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md rounded-xl border border-line bg-panel p-6 text-center">
        <Icon name="code" className="mx-auto h-8 w-8 text-ocean" />
        <h2 className="mt-3 text-sm font-semibold">No R repositories yet</h2>
        <p className="mt-1 text-xs text-muted">
          An R repository holds transform specs in <span className="font-mono">.transforms/</span> and the R scripts they run, on a single node with the Palantir R SDK.
        </p>
        {runtime && !runtime.available && <p className="mt-3 rounded bg-bad/10 p-2 text-xs text-bad">{runtime.error}</p>}
        <button type="button" onClick={onNew} className="mt-4 rounded-md bg-ocean px-3 py-2 text-xs font-medium text-white hover:bg-ocean-deep">
          New R repository
        </button>
      </div>
    </div>
  );
}

function fileIcon(path: string): IconName {
  if (/\.r$/i.test(path)) return "code";
  if (path.startsWith(".transforms/")) return "list";
  return "doc";
}

function FileTree({ files, active, changed, onOpen }: { files: Record<string, string>; active: string | null; changed: string[]; onOpen: (p: string) => void }) {
  const paths = Object.keys(files).sort((a, b) => (a.split("/").length === 1) === (b.split("/").length === 1) ? a.localeCompare(b) : a.split("/").length === 1 ? 1 : -1);
  const folders = [...new Set(paths.filter((p) => p.includes("/")).map((p) => p.slice(0, p.lastIndexOf("/"))))].sort();
  const top = paths.filter((p) => !p.includes("/"));
  const row = (p: string, depth: number) => (
    <button
      key={p}
      type="button"
      onClick={() => onOpen(p)}
      style={{ paddingLeft: 8 + depth * 12 }}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${active === p ? "bg-panel-2 text-white" : "text-soft hover:bg-panel-2"}`}
    >
      <Icon name={fileIcon(p)} className={`h-3.5 w-3.5 ${active === p ? "text-ocean" : "text-muted"}`} />
      <span className="truncate">{p.split("/").pop()}</span>
      {changed.includes(p) && <span className="ml-auto text-ocean">•</span>}
    </button>
  );
  return (
    <div className="flex-1 overflow-y-auto p-2 text-xs">
      {folders.map((f) => (
        <div key={f}>
          <div className="mt-1 flex items-center gap-2 px-2 py-1.5 text-muted" style={{ paddingLeft: 8 + (f.split("/").length - 1) * 12 }}>
            <Icon name="folder" className="h-3.5 w-3.5 text-ocean" /> {f.split("/").pop()}
          </div>
          {paths.filter((p) => p.slice(0, p.lastIndexOf("/")) === f).map((p) => row(p, f.split("/").length))}
        </div>
      ))}
      {top.map((p) => row(p, 0))}
    </div>
  );
}

function Editor({ path, value, onChange, message, check }: { path: string | null; value: string; onChange: (v: string) => void; message: { tone: "ok" | "bad" | "muted"; text: string } | null; check: Check | null }) {
  const lines = value.split("\n").length;
  const kind = path && /\.r$/i.test(path) ? "R" : path?.endsWith(".yml") || path?.endsWith(".yaml") ? "YAML" : path?.endsWith(".lock") ? "JSON" : "Text";
  const problems = check ? [...check.errors.map((e) => ({ file: e.file, text: e.error })), ...check.tests.filter((t) => !t.ok && !t.skipped).map((t) => ({ file: t.file, text: t.error ?? "failed" }))] : [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-[10px] text-muted">
        <span className="rounded bg-panel-2 px-2 py-1 text-ocean">{kind}</span>
        {kind === "R" ? "R script · single-node execution" : kind === "YAML" ? "Transform spec" : path ?? ""}
        <span className="ml-auto">UTF-8 · {lines} lines</span>
      </div>
      {path ? (
        <div className="flex min-h-0 flex-1 overflow-auto bg-ink">
          <div className="select-none border-r border-line px-3 py-3 text-right font-mono text-xs leading-6 text-muted">
            {value.split("\n").map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            className="min-h-[400px] flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[13px] leading-6 text-soft outline-none"
            aria-label="File editor"
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted">Choose a file</div>
      )}
      <div className="border-t border-line bg-panel p-3">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Icon name={message?.tone === "ok" ? "check" : message?.tone === "bad" ? "alert" : "info"} className={`h-4 w-4 ${message?.tone === "ok" ? "text-ok" : message?.tone === "bad" ? "text-bad" : "text-muted"}`} />
          <span className={`min-w-0 flex-1 truncate ${message?.tone === "bad" ? "text-bad" : ""}`} title={message?.text}>
            {message?.text ?? (check ? `Last checks ${check.status} · ${when(check.at)}` : "Run checks to validate the transform specs and R files")}
          </span>
          <span className="ml-auto text-[10px] text-muted">Working directory: repository root</span>
        </div>
        {problems.length > 0 && (
          <ul className="mt-2 max-h-28 space-y-0.5 overflow-y-auto text-[11px]">
            {problems.slice(0, 20).map((p, i) => (
              <li key={i} className="font-mono text-bad">
                {p.file}: <span className="whitespace-pre-wrap">{p.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SpecTab({ specs, files, transforms, checked, onEdit, onRunChecks }: { specs: string[]; files: Record<string, string>; transforms: TransformInfo[]; checked: boolean; onEdit: (p: string) => void; onRunChecks: () => void }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-ink p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Transform specs</h2>
          <p className="mt-1 text-xs text-muted">YAML in the .transforms folder: dataset inputs and outputs by alias, and the rscript runtime.</p>
        </div>
        {!checked && (
          <button type="button" onClick={onRunChecks} className="rounded-md border border-line-2 px-3 py-1.5 text-xs text-soft hover:text-white">
            Run checks to resolve them
          </button>
        )}
      </div>
      {specs.length === 0 && <p className="text-xs text-muted">No transform specs yet: add one from the file tree.</p>}
      {specs.map((s) => {
        const t = transforms.find((x) => x.key === s);
        return (
          <section key={s} className="mb-5">
            <div className="mb-2 flex items-center gap-2">
              <span className="font-mono text-xs text-soft">{s}</span>
              {t ? <span className="rounded bg-ok/15 px-1.5 text-[10px] text-ok">resolved</span> : checked && <span className="rounded bg-bad/15 px-1.5 text-[10px] text-bad">not loaded (see checks)</span>}
              <button type="button" onClick={() => onEdit(s)} className="ml-auto rounded-md border border-line-2 px-3 py-1 text-xs text-soft hover:text-white">
                Edit
              </button>
            </div>
            {t && (
              <div className="mb-3 grid gap-3 sm:grid-cols-3">
                <Info label="Inputs" value={`${Object.keys(t.inputs).length} dataset${Object.keys(t.inputs).length === 1 ? "" : "s"}`} detail={Object.entries(t.inputs).map(([a, rid]) => `${a} ← ${rid}`).join("\n")} />
                <Info label="Outputs" value={`${Object.keys(t.outputs ?? {}).length} dataset${Object.keys(t.outputs ?? {}).length === 1 ? "" : "s"}`} detail={Object.keys(t.outputs ?? {}).join("\n")} />
                <Info label="Runtime" value={t.runtime?.identifier ?? "rscript"} detail={t.runtime?.filePath} />
              </div>
            )}
            <pre className="rounded-xl border border-line bg-panel p-4 font-mono text-xs leading-6 text-soft">{files[s]}</pre>
          </section>
        );
      })}
    </div>
  );
}

function PackagesTab({ repo, branch, files, runtime, onLockWritten, onOpen }: { repo: Repo; branch: string; files: Record<string, string>; runtime: RRuntime | null; onLockWritten: () => void; onOpen: (p: string) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<RPackage[] | null>(null);
  const [installed, setInstalled] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const used = useMemo(() => usedPackages(files), [files]);
  const locked = useMemo(() => lockedPackages(files), [files]);
  useEffect(() => {
    if (runtime?.available) rTransforms.installed().then(setInstalled, () => {});
  }, [runtime]);
  useEffect(() => {
    const term = q.trim();
    if (!term) return;
    const t = setTimeout(() => rTransforms.search(term).then(setResults, (e: Error) => setNote({ tone: "bad", text: e.message })), 300);
    return () => clearTimeout(t);
  }, [q]);
  const install = async (pkg: string, repository: RPackage["repository"] = "CRAN") => {
    setBusy(pkg);
    setNote(null);
    try {
      const r = await rTransforms.install(repo.id, [pkg], repository);
      setInstalled({ ...installed, ...(Object.fromEntries(Object.entries(r.installed).filter(([, v]) => v)) as Record<string, string>) });
      setNote({ tone: "ok", text: `${pkg} ${r.installed[pkg] ?? ""} installed in the shared R library` });
    } catch (e) {
      setNote({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const snapshot = async () => {
    setBusy("snapshot");
    setNote(null);
    try {
      const r = await rTransforms.snapshot(repo.id, branch);
      setNote({ tone: "ok", text: `renv.lock written with ${r.locked.length} package${r.locked.length === 1 ? "" : "s"} (uncommitted): commit it to restore the environment later` });
      onLockWritten();
    } catch (e) {
      setNote({ tone: "bad", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => setNote({ tone: "ok", text: `Copied: ${text}` }), () => {});
  const term = q.trim();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">R packages</h2>
          <p className="mt-1 text-xs text-muted">
            CRAN through Posit Package Manager and Bioconductor; installed once into the shared R library every R transform sees. Lock them with renv: renv.lock can be restored with{" "}
            <span className="font-mono">renv::restore()</span> in .Rprofile.
          </p>
        </div>
        <button type="button" disabled={!!busy || !runtime?.available} onClick={snapshot} className="shrink-0 rounded-md bg-ocean px-3 py-2 text-xs text-white hover:bg-ocean-deep disabled:opacity-40" title="renv::snapshot() of the packages the R code loads">
          {busy === "snapshot" ? "Snapshotting…" : "Snapshot environment"}
        </button>
      </div>
      {note && <p className={`mb-3 whitespace-pre-wrap rounded p-2 text-xs ${note.tone === "ok" ? "bg-ok/10 text-ok" : "bg-bad/10 text-bad"}`}>{note.text}</p>}
      {!runtime?.available && runtime && <p className="mb-3 rounded bg-bad/10 p-2 text-xs text-bad">{runtime.error}</p>}
      <div className="flex items-center gap-2 rounded-md border border-line-2 bg-ink px-3 py-2">
        <Icon name="search" className="h-3.5 w-3.5 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search CRAN, Posit, or Bioconductor packages" className="w-full bg-transparent text-xs outline-none placeholder:text-muted" />
      </div>
      {term && results && (
        <div className="mt-3 space-y-2">
          {results.length === 0 && <p className="text-xs text-muted">No package named like “{term}”.</p>}
          {results.map((p) => (
            <div key={`${p.repository}${p.name}`} className="flex items-center gap-3 rounded-lg border border-line bg-panel p-3">
              <Icon name="cube" className="h-4 w-4 text-ocean" />
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-medium">
                  {p.name} <span className="font-normal text-muted">{p.version}</span>
                  <span className="rounded bg-panel-2 px-1.5 text-[10px] font-normal text-muted">{p.repository}</span>
                </div>
                {(p.imports || p.license) && <div className="truncate text-[10px] text-muted">{[p.license, p.imports && `imports ${p.imports}`].filter(Boolean).join(" · ")}</div>}
              </div>
              <span className="ml-auto shrink-0 text-[10px] text-muted">{p.installed ? `Installed ${p.installed}` : ""}</span>
              <button type="button" onClick={() => copy(`renv::install("${p.repository === "Bioconductor" ? `bioc::${p.name}` : p.name}")`)} className="shrink-0 text-[10px] text-ocean hover:underline" title="The R code that installs it with renv">
                Copy code
              </button>
              {!p.installed && (
                <button type="button" disabled={!!busy || !runtime?.available} onClick={() => install(p.name, p.repository)} className="shrink-0 rounded-md border border-line-2 px-2 py-1 text-[10px] text-soft hover:text-white disabled:opacity-40">
                  {busy === p.name ? "Installing…" : "Install"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <h3 className="mt-6 mb-2 text-xs font-semibold text-soft">Used by this repository</h3>
      {used.length === 0 && <p className="text-xs text-muted">The R code loads no packages besides foundry and base R.</p>}
      <div className="space-y-2">
        {used.map((pkg) => (
          <div key={pkg} className="flex items-center gap-3 rounded-lg border border-line bg-panel p-3">
            <Icon name="cube" className="h-4 w-4 text-ocean" />
            <span className="text-xs font-medium">{pkg}</span>
            <span className="ml-auto text-[10px] text-muted">
              {installed[pkg] ? `Installed ${installed[pkg]}` : "Not installed"}
              {locked[pkg]?.Version ? ` · renv.lock ${locked[pkg].Version}` : ""}
            </span>
            {!installed[pkg] && (
              <button type="button" disabled={!!busy || !runtime?.available} onClick={() => install(pkg)} className="rounded-md border border-line-2 px-2 py-1 text-[10px] text-soft hover:text-white disabled:opacity-40">
                {busy === pkg ? "Installing…" : "Install"}
              </button>
            )}
          </div>
        ))}
      </div>
      {Object.keys(locked).length > 0 && (
        <>
          <h3 className="mt-6 mb-2 flex items-center gap-2 text-xs font-semibold text-soft">
            renv.lock
            <button type="button" onClick={() => onOpen("renv.lock")} className="font-normal text-ocean hover:underline">
              open
            </button>
          </h3>
          <div className="grid gap-1 text-[11px] sm:grid-cols-2">
            {Object.entries(locked).map(([name, p]) => (
              <div key={name} className="flex items-center gap-2 rounded border border-line bg-panel px-2 py-1">
                <span className="font-mono text-soft">{name}</span>
                <span className="text-muted">{p.Version}</span>
                <span className="ml-auto text-muted">{p.Repository ?? p.Source}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Outputs({ builds, transforms }: { builds: BuildRecord[]; transforms: TransformInfo[] }) {
  const latest = new Map<string, BuildRecord>();
  for (const b of builds) if (b.language === "r" && !latest.has(b.transform)) latest.set(b.transform, b);
  const declared = transforms.flatMap((t) => Object.keys(t.outputs ?? {}).map((alias) => ({ spec: t.key, alias })));
  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-4">
      {latest.size === 0 && declared.length === 0 && <p className="text-xs text-muted">Build a transform to write its outputs.</p>}
      {[...latest.values()].map((b) => (
        <div key={b.id} className="space-y-2">
          <div className="flex items-center gap-2 text-[11px]">
            <span className={b.status === "succeeded" ? "text-ok" : "text-bad"}>{b.status === "succeeded" ? "✓" : "✕"}</span>
            <span className="truncate font-mono text-soft">{b.transform.replace(/^\.transforms\//, "")}</span>
            <span className="ml-auto shrink-0 text-muted">{when(b.at)}</span>
          </div>
          {b.status === "failed" && <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-bad/10 p-2 text-[10px] text-bad">{b.error}</pre>}
          {(b.outputs ?? (b.output ? [{ param: b.output.name, item_id: b.output.item_id, name: b.output.name, path: b.output.path, rows: b.output.rows, mode: "SNAPSHOT" as const }] : [])).map((o) => (
            <Link key={o.param} href={o.files ? `/files/${o.item_id}` : `/datasets/${o.item_id}`} className="block rounded-lg border border-line bg-panel-2 p-3 hover:border-ocean/50">
              <div className="flex items-center gap-2 text-xs font-medium">
                <Icon name={o.files ? "folder" : "table"} className="h-4 w-4 text-ok" />
                <span className="truncate">{o.param}</span>
              </div>
              <div className="mt-1 text-[10px] text-muted">
                {o.files ? `Unstructured files · ${o.rows ?? 0} file(s)` : `Tabular dataset · ${o.rows?.toLocaleString() ?? "?"} rows`} · {[...o.path, o.name].join(" / ")}
              </div>
            </Link>
          ))}
        </div>
      ))}
      {declared
        .filter((d) => !latest.has(d.spec))
        .map((d) => (
          <div key={`${d.spec}${d.alias}`} className="rounded-lg border border-dashed border-line-2 p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-soft">
              <Icon name="table" className="h-4 w-4 text-muted" />
              {d.alias}
            </div>
            <div className="mt-1 text-[10px] text-muted">Not built yet · {d.spec.replace(/^\.transforms\//, "")}</div>
          </div>
        ))}
      <div className="rounded-lg border border-line bg-panel-2 p-3 text-xs">
        <div className="text-muted">Execution model</div>
        <div className="mt-1 text-soft">Single node · no Spark reads/writes</div>
      </div>
    </div>
  );
}

function Info({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-3" title={detail}>
      <div className="text-[10px] text-muted">{label}</div>
      <div className="mt-1 text-sm font-semibold text-soft">{value}</div>
      {detail && <div className="mt-1 truncate font-mono text-[10px] text-muted">{detail.split("\n")[0]}</div>}
    </div>
  );
}
