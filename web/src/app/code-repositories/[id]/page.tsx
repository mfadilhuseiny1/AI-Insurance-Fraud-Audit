"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CodeEditor } from "@/components/code/CodeEditor";
import { DebugPanel, useDebugger, type Debugger } from "@/components/code/DebugPanel";
import { AiPanel, ChangesPanel, LibrariesPanel, SchedulesPanel, SqlPanel, TemplateWizard, TestsView, type AiRequest } from "@/components/code/Helpers";
import { BuildMetricsView, ExpectationsList, TaskRunnerDialog, UpgradeDialog } from "@/components/code/PythonPanels";
import { BranchesTab, ChecksTab, NewBranchDialog, ProposeDialog, PullsTab, SettingsTab, TagsTab } from "@/components/code/RepoTabs";
import { useAuth } from "@/components/AuthGate";
import { Icon, type IconName } from "@/components/Icon";
import { ActionMenu } from "@/components/kg/parts";
import { AppHeader, Badge, ErrorBox } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { PublishedModel } from "@/components/models/TrainingResults";
import { codeRepos, type BuildRecord, type Check, type Commit, type IncrementalInfo, type PreviewResult, type Repo, type TestResult } from "@/lib/codeRepos";
import { when } from "@/lib/format";
import { fmt, workshop, type DatasetSource } from "@/lib/workshop";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { API_URL } from "@/lib/api";

type Top = "code" | "branches" | "tags" | "pulls" | "checks" | "settings";
type Side = "files" | "datasets" | "libraries" | "history" | "schedules";
type Bottom = "problems" | "preview" | "tests" | "build" | "changes" | "sql" | "builds" | "debug";

export default function RepositoryPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const top = (params.get("tab") as Top) || "code";
  const branchParam = params.get("branch") || undefined;
  const prParam = params.get("pr");
  const [repo, setRepo] = useState<Repo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState(false);

  const go = useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(changes)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      router.replace(`/code-repositories/${id}?${next.toString()}`);
    },
    [params, router, id],
  );

  const load = useCallback(() => {
    codeRepos
      .get(id, branchParam)
      .then((r) => {
        setRepo(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [id, branchParam]);
  useEffect(load, [load]);

  if (error && !repo) return <ApiError message={error} />;
  if (!repo) return <Loading />;

  const tabs: [Top, string, IconName, number?][] = [
    ["code", "Code", "code"],
    ["branches", "Branches", "split", repo.branch_count],
    ["tags", "Tags", "link", repo.tag_count],
    ["pulls", "Pull requests", "transform", repo.open_prs],
    ["checks", "Checks", "check"],
    ["settings", "Settings", "sliders"],
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Code Repositories" icon="code" href="/code-repositories" crumbs={[{ label: repo.name }]}>
        <nav className="flex items-center gap-0.5">
          {tabs.map(([k, label, icon, count]) => (
            <button
              key={k}
              type="button"
              onClick={() => go({ tab: k === "code" ? null : k, pr: null })}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs ${top === k ? "bg-panel-2 text-white ring-1 ring-line-2" : "text-muted hover:text-white"}`}
            >
              <Icon name={icon} className="h-3.5 w-3.5" /> {label}
              {!!count && <span className="rounded-full bg-ink px-1.5 text-[10px] text-muted">{count}</span>}
            </button>
          ))}
          <button type="button" onClick={() => setLocal(true)} title="Work locally: clone with Git" className="ml-1 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted hover:text-white">
            <Icon name="device" className="h-3.5 w-3.5" /> Work locally
          </button>
        </nav>
      </AppHeader>
      {local && <WorkLocallyDialog repoId={repo.id} onClose={() => setLocal(false)} />}
      {top === "code" ? (
        <Workspace key={repo.branch.name} repo={repo} onReload={load} onBranch={(b) => go({ branch: b })} onPropose={(pr) => go({ tab: "pulls", pr })} />
      ) : (
        <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
          {top === "branches" && <BranchesTab repo={repo} onChanged={load} onOpenBranch={(b) => go({ tab: null, branch: b })} onPropose={() => go({ tab: "pulls" })} />}
          {top === "tags" && <TagsTab repo={repo} />}
          {top === "pulls" && <PullsTab repo={repo} openId={prParam} onOpen={(pr) => go({ pr })} onChanged={load} />}
          {top === "checks" && <ChecksTab repo={repo} />}
          {top === "settings" && <SettingsTab repo={repo} onChanged={load} />}
        </div>
      )}
    </div>
  );
}

function Workspace({ repo, onReload, onBranch, onPropose }: { repo: Repo; onReload: () => void; onBranch: (b: string) => void; onPropose: (pr: string) => void }) {
  const branch = repo.branch.name;
  const { me } = useAuth();
  // code actions the API would refuse: running code is not allowed for this user (Control Panel → Security → Code
  // execution), or they are only a Viewer on the repository's Project; a protected branch is edited on a new branch
  const noCode = me?.can_run_code === false;
  const viewOnly = !!repo.project_id && !!me && me.role !== "admin" && !["editor", "owner"].includes(repo.my_role ?? "");
  const cannotRun = noCode || viewOnly;
  const runBlocked = noCode
    ? "Running code is limited to administrators and the allowed groups (Control Panel → Security → Code execution)"
    : viewOnly
      ? "You need the Editor role on this repository's Project to change or build it"
      : null;
  const readOnly = repo.branch.protected || cannotRun;
  const [files, setFiles] = useState<Record<string, string>>(repo.files);
  const [savedFiles, setSavedFiles] = useState<Record<string, string>>(repo.files);
  // ?file=<path> (links from Data Lineage, e.g. a model's training code) opens that file first
  const wanted = useSearchParams().get("file");
  const firstFile = (wanted && wanted in repo.files ? wanted : null) ?? Object.keys(repo.files).find((p) => p.endsWith(".py") && repo.files[p].includes("@transform")) ?? Object.keys(repo.files).find((p) => p.toLowerCase().endsWith(".r")) ?? Object.keys(repo.files).find((p) => p === "ts-functions/src/index.ts") ?? Object.keys(repo.files)[0] ?? null;
  const [open, setOpen] = useState<string[]>(firstFile ? [firstFile] : []);
  const [active, setActive] = useState<string | null>(firstFile);
  const [side, setSide] = useState<Side>("files");
  const [bottom, setBottom] = useState<Bottom>("problems");
  const [bottomOpen, setBottomOpen] = useState(true);
  const [checks, setChecks] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [builds, setBuilds] = useState<BuildRecord[] | null>(null);
  const [tests, setTests] = useState<{ tests: TestResult[]; error: string | null } | null>(null);
  const [running, setRunning] = useState<null | "preview" | "build" | "test">(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [transform, setTransform] = useState("");
  const [dialog, setDialog] = useState<null | "commit" | "branch" | "propose" | "template" | "merge" | "tasks" | "upgrade">(null);
  // a repository upgrade is available for this branch (template version behind the current one)
  const [upgradeFrom, setUpgradeFrom] = useState<{ current: number; latest: number } | null>(null);
  useEffect(() => {
    let alive = true;
    codeRepos.upgradePlan(repo.id, repo.branch.name).then(
      (p) => alive && setUpgradeFrom(p.available && !p.pull_request && p.current !== undefined && p.latest !== undefined ? { current: p.current, latest: p.latest } : null),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [repo.id, repo.branch.name]);
  const [ai, setAi] = useState<AiRequest | null | false>(false);
  const [version, setVersion] = useState(0);

  const runChecks = useCallback(async () => {
    setChecking(true);
    try {
      setChecks(await codeRepos.runChecks(repo.id, branch));
    } catch (e) {
      setChecks({ id: "", commit: null, branch, at: "", status: "failed", ms: 0, transforms: [], errors: [], error: (e as Error).message, tests: [], logs: "" });
    } finally {
      setChecking(false);
    }
  }, [repo.id, branch]);

  useEffect(() => {
    let stale = false;
    codeRepos
      .runChecks(repo.id, branch)
      .then((c) => !stale && setChecks(c))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [repo.id, branch]);

  const dirtyFiles = JSON.stringify(files) !== JSON.stringify(savedFiles);
  // an autosave leaves uncommitted changes on the branch: Commit stays enabled until the repository is reloaded
  // (after a commit), not only while an edit is unsaved
  const [savedFor, setSavedFor] = useState<Repo | null>(null);
  useEffect(() => {
    if (!dirtyFiles || readOnly) return;
    const t = setTimeout(async () => {
      try {
        await codeRepos.saveFiles(repo.id, branch, files);
        setSavedFiles(files);
        setSavedFor(repo);
        setVersion((v) => v + 1);
        runChecks();
      } catch (e) {
        setRunError((e as Error).message);
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [files, dirtyFiles, readOnly, repo, branch, runChecks]);

  const fileTransforms = useMemo(() => (checks?.transforms ?? []).filter((t) => t.file === active), [checks, active]);
  const chosen = fileTransforms.find((t) => t.key === transform) ?? fileTransforms[0] ?? null;
  const isTestFile = !!active && /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(active);
  const problems = (checks?.errors.length ?? 0) + (checks?.error ? 1 : 0);
  // the debugger and console run Python transforms (@transform_df / @transform / @transform.using / @transform.spark.using)
  const debugTransform =
    chosen && (chosen.language ?? "python") === "python" && ["df", "transform", "lightweight", "spark"].includes(chosen.kind ?? "") && !chosen.blocked ? chosen : null;
  const dbg = useDebugger(repo.id, branch, (file) => {
    if (files[file] === undefined) return;
    setOpen((o) => (o.includes(file) ? o : [...o, file]));
    setActive(file);
  });
  const pausedAt = dbg.pausedAt;

  const flush = async () => {
    if (dirtyFiles && !readOnly) {
      await codeRepos.saveFiles(repo.id, branch, files);
      setSavedFiles(files);
      setSavedFor(repo);
    }
  };
  const run = async (mode: "preview" | "build" | "test", forceSnapshot = false) => {
    setRunning(mode);
    setRunError(null);
    setBottomOpen(true);
    setBottom(mode === "test" ? "tests" : mode);
    try {
      await flush();
      if (mode === "preview" && chosen) setPreview(await codeRepos.preview(repo.id, branch, chosen.key));
      else if (mode === "build" && active) {
        setBuilds(await codeRepos.build(repo.id, branch, { file: active, force_snapshot: forceSnapshot || undefined }));
        onReload();
      } else if (mode === "test") setTests(await codeRepos.tests(repo.id, branch, isTestFile ? active! : undefined));
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunning(null);
    }
  };
  const startDebug = async (mode: "debug" | "console") => {
    if (!debugTransform) return;
    setBottom("debug");
    setBottomOpen(true);
    try {
      await flush();
    } catch (e) {
      setRunError((e as Error).message);
      return;
    }
    await dbg.start(mode, debugTransform.key);
  };
  const openFile = (p: string) => {
    if (!open.includes(p)) setOpen([...open, p]);
    setActive(p);
  };
  const closeFile = (p: string) => {
    const next = open.filter((x) => x !== p);
    setOpen(next);
    if (active === p) setActive(next[next.length - 1] ?? null);
  };
  const explain = (err: string) => setAi({ mode: "error", error: err });
  const isDirty = repo.branch.dirty || dirtyFiles || savedFor === repo;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-xs">
        <Icon name="split" className="h-3.5 w-3.5 text-muted" />
        <select value={branch} onChange={(e) => onBranch(e.target.value)} className="rounded-md border border-line-2 bg-ink px-2 py-1 font-mono">
          {repo.branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
              {b.protected ? " (protected)" : ""}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setDialog("branch")} disabled={cannotRun} title={runBlocked ?? "New branch"} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white disabled:opacity-40">
          <Icon name="plus" className="h-3.5 w-3.5" />
        </button>
        {readOnly && (
          <span className="flex items-center gap-1 rounded bg-sand/15 px-2 py-0.5 text-sand" title={runBlocked ?? undefined} data-testid="repo-read-only">
            <Icon name="eye" className="h-3 w-3" /> {cannotRun ? (noCode ? "Read only: you may not run code" : "Read only: Viewer on the Project") : "Protected: create a branch to edit"}
          </span>
        )}
        {fileTransforms.length > 1 && (
          <select value={chosen?.key ?? ""} onChange={(e) => setTransform(e.target.value)} className="rounded-md border border-line-2 bg-ink px-2 py-1">
            {fileTransforms.map((t) => (
              <option key={t.key} value={t.key}>
                {t.function} → {t.output.name}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={runChecks} disabled={checking || cannotRun} className={buttonClass.ghost} title={runBlocked ?? "Compile, load transforms, run tests"}>
            <Icon name={checks?.status === "passed" ? "check" : "alert"} className={`h-3.5 w-3.5 ${checks?.status === "passed" ? "text-ok" : checks ? "text-warn" : ""}`} />
            {checking ? "Checking…" : "Checks"}
          </button>
          <button type="button" onClick={() => run("test")} disabled={!!running || cannotRun} title={runBlocked ?? undefined} className={buttonClass.secondary}>
            <Icon name="check" className="h-3.5 w-3.5" /> {running === "test" ? "Testing…" : "Test"}
          </button>
          <button type="button" onClick={() => run("preview")} disabled={!chosen || !!running || cannotRun} className={buttonClass.secondary} title={runBlocked ?? (chosen ? `Preview ${chosen.function}` : "Open a file with a transform")}>
            <Icon name="eye" className="h-3.5 w-3.5" /> {running === "preview" ? "Running…" : "Preview"}
          </button>
          <button
            type="button"
            onClick={() => startDebug("debug")}
            disabled={!debugTransform || !!dbg.starting || cannotRun}
            className={buttonClass.secondary}
            title={runBlocked ?? (debugTransform ? `Debug ${debugTransform.function}: run it in preview, stopping at breakpoints (click line numbers to add them)` : "Open a file with a Python transform")}
          >
            <Icon name="bug" className="h-3.5 w-3.5" /> {dbg.starting === "debug" ? "Starting…" : "Debug"}
          </button>
          <button type="button" onClick={() => run("build")} disabled={!fileTransforms.length || !!running || cannotRun} className={buttonClass.secondary} title={runBlocked ?? "Build every output of the open file"}>
            <Icon name="play" className="h-3.5 w-3.5" /> {running === "build" ? "Building…" : "Build"}
          </button>
          <button type="button" onClick={() => setDialog("commit")} disabled={!isDirty || readOnly} title={runBlocked ?? undefined} className={buttonClass.primary}>
            <Icon name="check" className="h-3.5 w-3.5" /> Commit
          </button>
          {!repo.branch.default && (
            <button type="button" onClick={() => (repo.branch.pull_request ? onPropose(repo.branch.pull_request.id) : setDialog("propose"))} className={buttonClass.secondary}>
              <Icon name="transform" className="h-3.5 w-3.5" /> {repo.branch.pull_request ? `PR #${repo.branch.pull_request.id}` : "Propose changes"}
            </button>
          )}
          <button type="button" onClick={() => setAi(ai === false ? null : false)} className={`${buttonClass.ghost} ${ai !== false ? "text-ocean" : ""}`} title="AIP Assist">
            <Icon name="sparkle" className="h-3.5 w-3.5" /> AIP
          </button>
          <ActionMenu
            items={[
              {
                label: "Build as snapshot",
                icon: "play",
                onClick: () => run("build", true),
                disabled: !fileTransforms.some((t) => t.incremental) || !!running || cannotRun,
              },
              { label: "Python console (inputs loaded)", icon: "keyboard", onClick: () => startDebug("console"), disabled: !debugTransform || !!dbg.starting || cannotRun },
              { label: "Task Runner…", icon: "keyboard", onClick: () => setDialog("tasks"), disabled: cannotRun },
              { label: "Upgrade…", icon: "refresh", onClick: () => setDialog("upgrade"), disabled: cannotRun },
              { label: "Merge another branch…", icon: "split", onClick: () => setDialog("merge"), disabled: readOnly },
              {
                label: "Reset uncommitted changes",
                icon: "restore",
                disabled: readOnly || !isDirty,
                onClick: async () => {
                  if (!(await confirmDialog("Discard every uncommitted change on this branch?"))) return;
                  await codeRepos.reset(repo.id, branch);
                  window.location.reload();
                },
              },
            ]}
          />
        </div>
      </div>
      {upgradeFrom && (
        <div className="flex items-center gap-2 border-b border-line bg-ocean/10 px-4 py-1.5 text-xs">
          <Icon name="refresh" className="h-3.5 w-3.5 text-ocean" />
          <span className="text-soft">
            An upgrade is available: template version {upgradeFrom.current} → {upgradeFrom.latest}.
          </span>
          <button type="button" onClick={() => setDialog("upgrade")} className="text-ocean hover:underline">
            Upgrade…
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2">
          {(
            [
              ["files", "Files", "doc"],
              ["datasets", "Datasets", "database"],
              ["libraries", "Libraries", "layers"],
              ["history", "Commits", "history"],
              ["schedules", "Schedules", "clock"],
            ] as [Side, string, IconName][]
          ).map(([k, label, icon]) => (
            <button key={k} type="button" title={label} onClick={() => setSide(k)} className={`rounded-md p-2 ${side === k ? "bg-ocean/15 text-ocean ring-1 ring-ocean/30" : "text-muted hover:bg-panel-2 hover:text-white"}`}>
              <Icon name={icon} className="h-4 w-4" />
            </button>
          ))}
        </nav>
        <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
          {side === "files" && (
            <FileTree
              files={files}
              active={active}
              readOnly={readOnly}
              errors={checks?.errors ?? []}
              onOpen={openFile}
              onChange={setFiles}
              onClosed={closeFile}
              onTemplate={() => setDialog("template")}
            />
          )}
          {side === "datasets" && <DatasetsPanel />}
          {side === "libraries" && (
            <LibrariesPanel
              repoId={repo.id}
              branch={branch}
              readOnly={readOnly}
              beforeAdd={flush}
              files={files}
              onAddImport={readOnly || !active?.endsWith(".py") ? undefined : (mod) => setFiles({ ...files, [active!]: `import ${mod}\n${files[active!]}` })}
            />
          )}
          {side === "history" && (
            <History
              repo={repo}
              onRestore={async (cid) => {
                if (!(await confirmDialog("Replace the working copy with this commit's files? Commit afterwards to record it."))) return;
                await codeRepos.restore(repo.id, cid, branch);
                window.location.reload();
              }}
            />
          )}
          {side === "schedules" && <SchedulesPanel repoId={repo.id} transforms={checks?.transforms ?? []} schedules={repo.schedules} onChanged={onReload} protectedDefault={repo.default_branch} />}
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-end overflow-x-auto border-b border-line bg-panel">
            {open.map((p) => (
              <div key={p} className={`group flex h-full shrink-0 items-center gap-1.5 border-r border-line px-3 text-xs ${active === p ? "bg-ink text-white" : "text-muted hover:text-white"}`}>
                <button type="button" onClick={() => setActive(p)} title={p}>
                  {p.split("/").pop()}
                  {files[p] !== savedFiles[p] ? " •" : ""}
                </button>
                <button type="button" onClick={() => closeFile(p)} className="opacity-0 group-hover:opacity-100" aria-label="Close">
                  <Icon name="x" className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          {active && files[active] !== undefined ? (
            <CodeEditor
              key={`${branch}:${active}`}
              path={active}
              value={files[active]}
              readOnly={readOnly}
              onChange={(v) => setFiles({ ...files, [active]: v })}
              highlightLine={chosen?.line}
              breakpoints={active.endsWith(".py") ? dbg.forFile(active) : undefined}
              onToggleBreakpoint={active.endsWith(".py") ? (line) => dbg.toggle(active, line) : undefined}
              onEditBreakpoint={active.endsWith(".py") ? (line) => dbg.editCondition(active, line) : undefined}
              currentLine={pausedAt && pausedAt.file === active ? pausedAt.line : null}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center bg-ink text-sm text-muted">Open a file from the tree</div>
          )}
          {chosen && (
            <div className="flex shrink-0 items-center gap-3 border-t border-line bg-panel px-3 py-1.5 text-xs text-muted">
              <Icon name="transform" className="h-3.5 w-3.5 text-ocean" />
              <span className="font-mono text-soft">{chosen.function}</span>
              <span className="truncate">inputs: {Object.entries(chosen.inputs).map(([k, v]) => `${k} ← ${v}`).join(", ") || "none"}</span>
              <span className="ml-auto shrink-0">
                output → {chosen.output.folder ? `${chosen.output.folder}/` : `My Project/Code Repositories/${repo.name}/`}
                {branch !== repo.default_branch ? `_branches/${branch}/` : ""}
                {chosen.output.name}
              </span>
            </div>
          )}
          <BottomPanel
            open={bottomOpen}
            onToggle={() => setBottomOpen(!bottomOpen)}
            tab={bottom}
            onTab={(t) => {
              setBottom(t);
              setBottomOpen(true);
            }}
            problems={problems}
            checks={checks}
            preview={preview}
            builds={builds}
            tests={tests}
            running={running}
            error={runError}
            repo={repo}
            branch={branch}
            version={version}
            active={active}
            onOpenFile={openFile}
            onExplain={explain}
            dbg={dbg}
            debugTransform={debugTransform ? { key: debugTransform.key, label: debugTransform.function } : null}
            onDebug={startDebug}
          />
        </section>
        {ai !== false && <AiPanel code={active ? (files[active] ?? "") : ""} path={active ?? ""} request={ai} onClose={() => setAi(false)} />}
      </div>

      {dialog === "commit" && (
        <CommitDialog
          files={files}
          required={repo.settings.require_commit_message}
          branch={branch}
          onClose={() => setDialog(null)}
          onDone={async (message) => {
            await flush();
            await codeRepos.commit(repo.id, branch, message);
            setDialog(null);
            onReload();
            setTimeout(runChecks, 300);
          }}
        />
      )}
      {dialog === "branch" && (
        <NewBranchDialog
          repo={repo}
          from={branch}
          onClose={() => setDialog(null)}
          onDone={(name) => {
            setDialog(null);
            onBranch(name);
          }}
        />
      )}
      {dialog === "propose" && (
        <ProposeDialog
          repo={repo}
          source={branch}
          onClose={() => setDialog(null)}
          onDone={(pr) => {
            setDialog(null);
            onPropose(pr.id);
          }}
        />
      )}
      {dialog === "template" && (
        <TemplateWizard
          existing={files}
          onClose={() => setDialog(null)}
          onCreate={(path, content) => {
            setFiles({ ...files, [path]: content });
            openFile(path);
            setDialog(null);
          }}
        />
      )}
      {dialog === "merge" && <MergeDialog repo={repo} branch={branch} onClose={() => setDialog(null)} onDone={() => window.location.reload()} />}
      {dialog === "upgrade" && (
        <UpgradeDialog
          repoId={repo.id}
          branch={branch}
          onClose={() => setDialog(null)}
          onOpened={(prId) => {
            setDialog(null);
            onPropose(prId);
          }}
        />
      )}
      {dialog === "tasks" && (
        <TaskRunnerDialog
          repoId={repo.id}
          branch={branch}
          readOnly={readOnly}
          python={Object.keys(files).some((f) => f.endsWith(".py") || f.endsWith("meta.yaml"))}
          java={Object.keys(files).some((f) => f.endsWith(".java") || f.endsWith("build.gradle"))}
          beforeRun={flush}
          onClose={() => setDialog(null)}
          onFilesChanged={() => window.location.reload()}
        />
      )}
    </div>
  );
}

type TreeNode = { name: string; path: string; children: Map<string, TreeNode>; file: boolean };

function FileTree({
  files,
  active,
  readOnly,
  errors,
  onOpen,
  onChange,
  onClosed,
  onTemplate,
}: {
  files: Record<string, string>;
  active: string | null;
  readOnly: boolean;
  errors: { file: string }[];
  onOpen: (p: string) => void;
  onChange: (f: Record<string, string>) => void;
  onClosed: (p: string) => void;
  onTemplate: () => void;
}) {
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const bad = new Set(errors.map((e) => e.file));
  const tree = useMemo(() => {
    const root: TreeNode = { name: "", path: "", children: new Map(), file: false };
    for (const p of Object.keys(files).sort()) {
      if (q && !p.toLowerCase().includes(q.toLowerCase())) continue;
      let node = root;
      p.split("/").forEach((part, i, parts) => {
        const path = parts.slice(0, i + 1).join("/");
        if (!node.children.has(part)) node.children.set(part, { name: part, path, children: new Map(), file: i === parts.length - 1 });
        node = node.children.get(part)!;
      });
    }
    return root;
  }, [files, q]);

  const addFile = async () => {
    const path = (await promptDialog("New file path", "src/myproject/datasets/new_file.py"))?.trim();
    if (!path) return;
    if (files[path] === undefined) onChange({ ...files, [path]: "" });
    onOpen(path);
  };
  const render = (node: TreeNode, depth: number): React.ReactNode =>
    [...node.children.values()]
      .sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name))
      .map((c) =>
        c.file ? (
          <div key={c.path} data-repo-file={c.path} className={`group flex items-center gap-1.5 rounded py-1 pr-1 text-sm ${active === c.path ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`} style={{ paddingLeft: depth * 12 + 8 }}>
            <button type="button" onClick={() => onOpen(c.path)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
              <Icon name={c.name.endsWith(".py") || c.name.toLowerCase().endsWith(".r") || c.name.endsWith(".ts") ? "code" : "doc"} className={`h-3.5 w-3.5 shrink-0 ${bad.has(c.path) ? "text-bad" : "text-muted"}`} />
              <span className="truncate">{c.name}</span>
            </button>
            {!readOnly && (
              <>
                <button
                  type="button"
                  title="Rename"
                  onClick={async () => {
                    const to = (await promptDialog("Rename to", c.path))?.trim();
                    if (!to || to === c.path || files[to] !== undefined) return;
                    const next = { ...files, [to]: files[c.path] };
                    delete next[c.path];
                    onChange(next);
                    onClosed(c.path);
                    onOpen(to);
                  }}
                  className="rounded p-0.5 text-muted opacity-0 hover:text-white group-hover:opacity-100"
                >
                  <Icon name="pencil" className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  title="Delete"
                  onClick={async () => {
                    if (!(await confirmDialog(`Delete ${c.path}?`))) return;
                    const next = { ...files };
                    delete next[c.path];
                    onChange(next);
                    onClosed(c.path);
                  }}
                  className="rounded p-0.5 text-muted opacity-0 hover:text-bad group-hover:opacity-100"
                >
                  <Icon name="trash" className="h-3 w-3" />
                </button>
              </>
            )}
          </div>
        ) : (
          <div key={c.path}>
            <button
              type="button"
              onClick={() => {
                const s = new Set(collapsed);
                if (s.has(c.path)) s.delete(c.path);
                else s.add(c.path);
                setCollapsed(s);
              }}
              className="flex w-full items-center gap-1 rounded py-1 text-left text-sm text-soft hover:bg-panel-2"
              style={{ paddingLeft: depth * 12 + 4 }}
            >
              <Icon name={collapsed.has(c.path) ? "right" : "down"} className="h-3 w-3 text-muted" />
              <Icon name="folder" className="h-3.5 w-3.5 text-sand" /> {c.name}
            </button>
            {!collapsed.has(c.path) && render(c, depth + 1)}
          </div>
        ),
      );
  return (
    <>
      <div className="flex items-center gap-1 border-b border-line px-3 py-2 text-sm font-semibold">
        <span className="flex-1">Files</span>
        {!readOnly && (
          <ActionMenu
            items={[
              { label: "New file from template…", icon: "sparkle", onClick: onTemplate },
              { label: "New empty file…", icon: "doc", onClick: addFile },
            ]}
          />
        )}
      </div>
      <div className="p-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search file names…" className={`${inputClass} text-xs`} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">{render(tree, 0)}</div>
    </>
  );
}

function DatasetsPanel() {
  const [items, setItems] = useState<DatasetSource[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    workshop
      .sources()
      .then((s) => setItems(s.datasets))
      .catch(() => setItems([]));
  }, []);
  return (
    <>
      <div className="border-b border-line px-3 py-2.5 text-sm font-semibold">Datasets</div>
      <p className="px-3 pt-2 text-[11px] text-muted">Click to copy an Input(...) for a dataset in Files. The arrow opens it in Data Lineage.</p>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {items === null && <p className="p-2 text-xs text-muted">Loading…</p>}
        {items?.length === 0 && <p className="p-2 text-xs text-muted">No datasets yet.</p>}
        {items?.map((d) => {
          const path = [...d.path, d.name].join("/");
          return (
            <div key={d.id} className="group mb-1 flex items-start rounded-md hover:bg-panel-2">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(`Input("${path}")`);
                  setCopied(d.id);
                  setTimeout(() => setCopied(null), 1500);
                }}
                className="min-w-0 flex-1 px-2 py-1.5 text-left"
              >
                <span className="flex items-center gap-1.5 text-sm text-soft">
                  <Icon name="table" className="h-3.5 w-3.5 text-ocean" /> <span className="truncate">{d.name}</span>
                  {copied === d.id && <span className="ml-auto text-[10px] text-ok">Copied</span>}
                </span>
                <span className="block truncate pl-5 text-[11px] text-muted">{d.path.join(" / ")}</span>
              </button>
              <Link href={`/lineage?node=${encodeURIComponent(`dataset:${d.id}`)}`} target="_blank" title="Explore data lineage" className="p-1.5 text-muted opacity-0 hover:text-white group-hover:opacity-100">
                <Icon name="split" className="h-3.5 w-3.5" />
              </Link>
            </div>
          );
        })}
      </div>
    </>
  );
}

function History({ repo, onRestore }: { repo: Repo; onRestore: (cid: string) => void }) {
  const [commits, setCommits] = useState<Commit[] | null>(null);
  useEffect(() => {
    codeRepos
      .commits(repo.id, repo.branch.name)
      .then(setCommits)
      .catch(() => setCommits([]));
  }, [repo.id, repo.branch.name]);
  return (
    <>
      <div className="border-b border-line px-3 py-2.5 text-sm font-semibold">Commits · {repo.branch.name}</div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {repo.branch.dirty && <div className="mb-2 rounded-md bg-warn/10 px-2 py-1.5 text-xs text-warn">Uncommitted changes in the working copy</div>}
        {commits === null && <p className="p-2 text-xs text-muted">Loading…</p>}
        {commits?.map((c, i) => (
          <div key={c.id} className="group mb-1 rounded-md px-2 py-1.5 hover:bg-panel-2">
            <div className="flex items-center gap-1.5 text-sm">
              <span className={`h-2 w-2 shrink-0 rounded-full ${i === 0 ? "bg-ocean" : "bg-line-2"}`} />
              <span className="truncate">{c.message}</span>
            </div>
            <div className="flex items-center gap-2 pl-3.5 text-[11px] text-muted">
              <span className="font-mono">{c.id.slice(0, 7)}</span> {when(c.at)}
              {c.parents.length > 1 && <span className="text-violet-400">merge</span>}
              {!repo.branch.protected && (
                <button type="button" onClick={() => onRestore(c.id)} className="ml-auto text-ocean opacity-0 hover:underline group-hover:opacity-100">
                  Restore
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function CommitDialog({ files, required, branch, onClose, onDone }: { files: Record<string, string>; required: boolean; branch: string; onClose: () => void; onDone: (message: string) => Promise<void> }) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Commit to ${branch}`} icon="check" onClose={onClose}>
      <form
        className="space-y-3 p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onDone(message.trim());
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <textarea autoFocus rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={required ? "What changed and why" : "Optional: a message is generated from the changed files"} className={inputClass} />
        <p className="text-xs text-muted">{Object.keys(files).length} files. Checks run on the commit; builds record the commit they ran on.</p>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" disabled={busy || (required && !message.trim())} className={buttonClass.primary}>
            Commit
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MergeDialog({ repo, branch, onClose, onDone }: { repo: Repo; branch: string; onClose: () => void; onDone: () => void }) {
  const [source, setSource] = useState(repo.branches.find((b) => b.name !== branch)?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Merge into ${branch}`} icon="split" onClose={onClose}>
      <div className="space-y-3 p-4">
        <select value={source} onChange={(e) => setSource(e.target.value)} className={`${inputClass} font-mono`}>
          {repo.branches
            .filter((b) => b.name !== branch)
            .map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
        </select>
        <p className="text-xs text-muted">Brings the committed changes of that branch into this one with a merge commit. Commit or reset your own changes first.</p>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!source}
            onClick={async () => {
              try {
                await codeRepos.merge(repo.id, branch, source);
                onDone();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            Merge
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ResultTable({ columns, rows }: { columns: { name: string; type: string }[]; rows: Record<string, unknown>[] }) {
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-panel text-left text-muted">
        <tr className="border-b border-line">
          {columns.map((c) => (
            <th key={c.name} className="whitespace-nowrap px-3 py-1.5 font-medium">
              {c.name} <span className="font-normal text-muted/70">{c.type}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="font-mono">
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-line">
            {columns.map((c) => (
              <td key={c.name} className="max-w-64 truncate whitespace-nowrap px-3 py-1 text-soft">
                {fmt(r[c.name])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExplainButton({ text, onExplain }: { text: string; onExplain: (t: string) => void }) {
  return (
    <button type="button" onClick={() => onExplain(text)} className="inline-flex items-center gap-1 rounded border border-ocean/40 px-2 py-0.5 text-[11px] text-ocean hover:bg-ocean/10">
      <Icon name="sparkle" className="h-3 w-3" /> Explain error
    </button>
  );
}

function BottomPanel({
  open,
  onToggle,
  tab,
  onTab,
  problems,
  checks,
  preview,
  builds,
  tests,
  running,
  error,
  repo,
  branch,
  version,
  active,
  onOpenFile,
  onExplain,
  dbg,
  debugTransform,
  onDebug,
}: {
  open: boolean;
  onToggle: () => void;
  tab: Bottom;
  onTab: (t: Bottom) => void;
  problems: number;
  checks: Check | null;
  preview: PreviewResult | null;
  builds: BuildRecord[] | null;
  tests: { tests: TestResult[]; error: string | null } | null;
  running: null | "preview" | "build" | "test";
  error: string | null;
  repo: Repo;
  branch: string;
  version: number;
  active: string | null;
  onOpenFile: (p: string) => void;
  onExplain: (t: string) => void;
  dbg: Debugger;
  debugTransform: { key: string; label: string } | null;
  onDebug: (mode: "debug" | "console") => void;
}) {
  const [history, setHistory] = useState<BuildRecord[] | null>(null);
  useEffect(() => {
    if (tab === "builds" && open) codeRepos.builds(repo.id).then(setHistory).catch(() => setHistory([]));
  }, [tab, open, repo.id, builds]);
  const failedTests = checks?.tests.filter((t) => !t.ok).length ?? 0;
  return (
    <div className={`flex shrink-0 flex-col border-t border-line bg-panel ${open ? (tab === "debug" ? "h-[26rem]" : "h-72") : ""}`}>
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto px-2 text-xs">
        {(
          [
            ["problems", `Problems${problems + failedTests ? ` (${problems + failedTests})` : ""}`, "alert"],
            ["preview", "Preview", "eye"],
            ["tests", "Tests", "check"],
            ["build", "Build", "play"],
            ["changes", "File changes", "edit"],
            ["sql", "SQL", "database"],
            ["builds", "Build history", "history"],
            ["debug", `Debug${dbg.session?.status === "paused" ? " (paused)" : dbg.session?.status === "running" ? " (running)" : ""}`, "bug"],
          ] as [Bottom, string, IconName][]
        ).map(([k, label, icon]) => (
          <button key={k} type="button" onClick={() => onTab(k)} className={`flex shrink-0 items-center gap-1.5 rounded px-2 py-1 ${tab === k && open ? "bg-panel-2 text-white" : "text-muted hover:text-white"}`}>
            <Icon name={icon} className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
        <button type="button" onClick={onToggle} className="ml-auto rounded p-1 text-muted hover:text-white" aria-label="Toggle panel">
          <Icon name="down" className={`h-3.5 w-3.5 ${open ? "" : "rotate-180"}`} />
        </button>
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-auto border-t border-line">
          {error && (
            <div className="flex items-start gap-2 p-3">
              <div className="flex-1">
                <ErrorBox message={error} />
              </div>
              <ExplainButton text={error} onExplain={onExplain} />
            </div>
          )}
          {tab === "debug" && <DebugPanel dbg={dbg} transform={debugTransform?.key ?? null} transformLabel={debugTransform?.label ?? null} onStart={onDebug} onOpenFile={onOpenFile} />}
          {tab === "problems" &&
            (!checks ? (
              <p className="p-3 text-xs text-muted">Running checks…</p>
            ) : (
              <div className="space-y-2 p-3 text-xs">
                {checks.error && (
                  <div>
                    <pre className="whitespace-pre-wrap rounded-md bg-bad/10 p-2 text-bad">{checks.error}</pre>
                    <ExplainButton text={checks.error} onExplain={onExplain} />
                  </div>
                )}
                {checks.errors.map((e, i) => (
                  <div key={i} className="rounded-md border border-bad/30 bg-bad/5 p-2">
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => e.file && onOpenFile(e.file)} className="font-mono text-bad hover:underline">
                        {e.file || "repository"}
                      </button>
                      <span className="ml-auto">
                        <ExplainButton text={e.error} onExplain={onExplain} />
                      </span>
                    </div>
                    <pre className="mt-1 whitespace-pre-wrap text-soft">{e.error}</pre>
                  </div>
                ))}
                {checks.tests
                  .filter((t) => !t.ok)
                  .map((t) => (
                    <div key={t.name} className="rounded-md border border-bad/30 bg-bad/5 p-2">
                      <button type="button" onClick={() => onOpenFile(t.file)} className="font-mono text-bad hover:underline">
                        {t.file}::{t.name}
                      </button>
                      <pre className="mt-1 whitespace-pre-wrap text-soft">{t.error}</pre>
                    </div>
                  ))}
                {!problems && !failedTests && (
                  <div className="text-ok">
                    ✓ All files load. {checks.transforms.length} transforms, {checks.tests.length} tests passing.
                  </div>
                )}
                {checks.transforms.map((t) => (
                  <button key={t.key} type="button" onClick={() => onOpenFile(t.file)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-panel-2">
                    <Icon name="transform" className="h-3.5 w-3.5 text-ocean" />
                    <span className="font-mono text-soft">
                      {t.file}::{t.function}
                    </span>
                    <span className="text-muted">→ {t.output.name}</span>
                  </button>
                ))}
              </div>
            ))}
          {tab === "preview" &&
            (running === "preview" ? (
              <p className="p-3 text-xs text-muted">Running the transform on its inputs…</p>
            ) : !preview ? (
              <p className="p-3 text-xs text-muted">Preview runs the transform in the open file without writing its output or committing.</p>
            ) : preview.ok ? (
              <PreviewView preview={preview} />
            ) : (
              <div className="p-3">
                <ExplainButton text={preview.error ?? ""} onExplain={onExplain} />
                {preview.expectations && preview.expectations.length > 0 && (
                  <div className="mt-2">
                    <ExpectationsList items={preview.expectations} />
                  </div>
                )}
                <pre className="mt-2 whitespace-pre-wrap text-xs text-bad">
                  {preview.error}
                  {preview.logs ? `\n\n${preview.logs}` : ""}
                </pre>
              </div>
            ))}
          {tab === "tests" && (running === "test" ? <p className="p-3 text-xs text-muted">Running tests…</p> : <TestsView tests={tests?.tests ?? null} error={tests?.error} onOpen={onOpenFile} />)}
          {tab === "build" &&
            (running === "build" ? (
              <p className="p-3 text-xs text-muted">Building every output of the open file…</p>
            ) : !builds ? (
              <p className="p-3 text-xs text-muted">Build runs every transform in the open file and writes their outputs to Files.</p>
            ) : (
              builds.map((b) => <BuildView key={b.id} b={b} onExplain={onExplain} />)
            ))}
          {tab === "changes" && <ChangesPanel repoId={repo.id} branch={branch} version={version} active={active} />}
          {tab === "sql" && <SqlPanel />}
          {tab === "builds" && (
            <div className="divide-y divide-line">
              {history?.length === 0 && <p className="p-3 text-xs text-muted">No builds yet.</p>}
              {history?.map((b) => (
                <details key={b.id}>
                  <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs">
                    <Badge status={b.status} />
                    {b.aborted && <span className="rounded bg-panel-2 px-1.5 text-[10px] text-muted">aborted</span>}
                    <span className="font-mono text-soft">{b.transform.split("::").pop()}</span>
                    <span className="text-muted">{b.outputs && b.outputs.length > 1 ? `→ ${b.outputs.length} outputs` : b.output ? `→ ${b.output.name}` : ""}</span>
                    <span className="rounded bg-panel-2 px-1.5 font-mono text-[10px] text-muted">{b.branch ?? repo.default_branch}</span>
                    {b.trigger && b.trigger !== "manual" && <span className="text-[10px] text-sand">{b.trigger}</span>}
                    <span className="ml-auto text-muted">
                      {b.commit ? b.commit.slice(0, 7) : "uncommitted"} · {when(b.at)}
                    </span>
                  </summary>
                  <BuildView b={b} onExplain={onExplain} />
                </details>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A preview: the rows of the transform's output — or, for a multi-output transform, of the output picked. */
function PreviewView({ preview }: { preview: PreviewResult }) {
  const outs = preview.output_previews ?? {};
  const names = Object.keys(outs);
  const [pick, setPick] = useState(preview.transform.output_param ?? names[0] ?? "");
  const shown = names.length > 1 && outs[pick] ? outs[pick] : null;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 px-3 py-1.5 text-xs text-muted">
        {preview.aborted ? (
          <span className="text-muted">ctx.abort_job(): nothing would be committed</span>
        ) : (
          <span className="text-ok">✓ {(shown?.rows ?? preview.rows)?.toLocaleString()} {shown?.kind === "files" ? "files" : "rows"}</span>
        )}
        {names.length > 1 && (
          <select value={pick} onChange={(e) => setPick(e.target.value)} className="rounded border border-line-2 bg-ink px-1.5 py-0.5 font-mono text-[11px] text-soft" aria-label="Output">
            {names.map((n) => (
              <option key={n} value={n}>
                {n} → {preview.transform.outputs?.[n]?.name ?? n}
              </option>
            ))}
          </select>
        )}
        {preview.incremental && <IncrementalNote info={preview.incremental} />}
        {Object.entries(preview.input_rows ?? {}).map(([k, v]) =>
          v === null ? null : (
            <span key={k}>
              {k}: {v.toLocaleString()} rows in
            </span>
          ),
        )}
      </div>
      {preview.expectations && preview.expectations.length > 0 && (
        <div className="px-3 pb-2">
          <ExpectationsList items={preview.expectations} />
        </div>
      )}
      {preview.logs && <pre className="mx-3 mb-2 max-h-24 overflow-auto rounded bg-ink p-2 text-[11px] text-muted">{preview.logs}</pre>}
      <ResultTable columns={shown?.columns ?? preview.columns ?? []} rows={shown?.preview ?? preview.preview ?? []} />
    </div>
  );
}

/** Whether an incremental transform ran incrementally (and why not), the rows each input added and the rows written. */
function IncrementalNote({ info }: { info: IncrementalInfo }) {
  return (
    <span className={info.mode === "incremental" ? "text-ocean" : "text-warn"} title={info.reason ?? undefined}>
      {info.mode === "incremental" ? "incremental" : `snapshot (${info.reason})`}
      {" · added "}
      {Object.entries(info.added_rows)
        .map(([k, v]) => `${k} ${v.toLocaleString()}`)
        .join(", ")}
      {info.written_rows !== null && ` · wrote ${info.written_rows.toLocaleString()} rows (${info.output_mode === "modify" ? "appended" : "replaced"})`}
      {info.modification_types && ` · inputs ${Object.entries(info.modification_types).map(([k, v]) => `${k} ${v}`).join(", ")}`}
      {info.added_media_items && ` · new media items ${Object.entries(info.added_media_items).map(([k, v]) => `${k} ${v}`).join(", ")}`}
      {info.ranges &&
        Object.entries(info.ranges).map(([k, r]) => (
          <span key={k} title={`current view ${r.current_view.join(" … ")}; rows ${r.rows[0]}–${r.rows[1]}`}>
            {` · ${k}: ${r.processed_batch ? `transactions ${r.processed_batch[0] === r.processed_batch[1] ? r.processed_batch[0] : r.processed_batch.join(" … ")}` : "no new transactions"} (limit ${r.limit})`}
            {r.remaining > 0 ? `, ${r.remaining} left` : ""}
          </span>
        ))}
      {info.up_to_date === false && <span className="text-warn"> · not up to date</span>}
      {info.notes && info.notes.length > 0 && ` · ${info.notes.join("; ")}`}
    </span>
  );
}

function BuildView({ b, onExplain }: { b: BuildRecord; onExplain: (t: string) => void }) {
  return (
    <div className="space-y-2 border-b border-line p-3 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <Badge status={b.status} />
        <span className="font-mono text-soft">{b.transform.split("::").pop()}</span>
        {b.language && b.language !== "python" && <span className="rounded bg-panel-2 px-1.5 text-[10px] uppercase text-muted">{b.language}</span>}
        {(b.kind === "lightweight" || b.kind === "spark") && <span className="rounded bg-panel-2 px-1.5 text-[10px] text-muted">{b.kind === "spark" ? "Spark" : "single node"}</span>}
        {b.aborted && <span className="rounded bg-panel-2 px-1.5 text-[10px] text-muted">aborted</span>}
        <span className="text-muted">{(b.ms / 1000).toFixed(1)} s</span>
        {b.version && <span className="font-mono text-[10px] text-muted" title="Transform logic version">v {b.version.slice(0, 8)}</span>}
        <span className="text-muted">{b.commit ? `commit ${b.commit.slice(0, 7)}` : "uncommitted changes"}</span>
        {b.output && (
          <Link href={`/lineage?node=${encodeURIComponent(`dataset:${b.output.item_id}`)}`} className="text-ocean hover:underline">
            View in Data Lineage
          </Link>
        )}
        {b.error && <ExplainButton text={b.error} onExplain={onExplain} />}
      </div>
      <div className="text-soft">
        Inputs:{" "}
        {b.inputs.map((i) => (
          <span key={i.name} className="mr-2">
            <span className="font-mono">{i.name}</span> ← {i.item_name}
          </span>
        ))}
      </div>
      {b.incremental && (
        <div>
          <IncrementalNote info={b.incremental} />
        </div>
      )}
      {b.outputs && b.outputs.length > 1 ? (
        b.outputs.map((o) => (
          <div key={o.param} className="text-soft">
            Output {o.param === "$return" ? "" : <span className="font-mono">{o.param}</span>}: <span className="font-medium">{[...o.path, o.name].join(" / ")}</span> ·{" "}
            {o.aborted ? (
              <span className="text-muted">aborted: nothing committed, keeps its last data</span>
            ) : (
              <>
                {o.files ? `${o.rows} files` : `${o.rows?.toLocaleString()} rows`} · {o.mode === "UPDATE" ? "appended (UPDATE)" : "replaced (SNAPSHOT)"}
              </>
            )}
          </div>
        ))
      ) : b.output && !b.output.media_set && (
        <div className="text-soft">
          Output: <span className="font-medium">{[...b.output.path, b.output.name].join(" / ")}</span> · {b.output.rows?.toLocaleString()} rows · {b.output.columns?.length} columns
        </div>
      )}
      {b.media_outputs?.map((m) => (
        <div key={m.param} className="text-soft">
          Media set: <span className="font-medium">{[...m.path, m.name].join(" / ")}</span> · {m.written} items written ({m.items} in the set)
        </div>
      ))}
      {b.model_versions?.map((m) => <PublishedModel key={m.version_rid} modelId={m.model_id} model={m.model} version={m.version} />)}
      {b.aborted_empty && <div className="text-warn">The transform wrote no rows and the output aborts empty transactions: nothing was committed.</div>}
      {b.aborted && <div className="text-muted">The transform called ctx.abort_job(): the job succeeded and nothing was committed (downstream datasets stay up to date).</div>}
      {b.expectations && b.expectations.length > 0 && <ExpectationsList items={b.expectations} />}
      {b.error && <pre className="whitespace-pre-wrap rounded-md bg-bad/10 p-2 text-bad">{b.error}</pre>}
      {b.metrics && <BuildMetricsView metrics={b.metrics} />}
      {b.logs && <pre className="max-h-40 overflow-auto rounded-md bg-ink p-2 text-muted">{b.logs}</pre>}
    </div>
  );
}

/** "Work locally": the repository's Git remote URL and a clone token that expires in 7 days (api/code_git.py). */
function WorkLocallyDialog({ repoId, onClose }: { repoId: string; onClose: () => void }) {
  const [info, setInfo] = useState<{ url: string; token: string | null; expires_at: string | null; username?: string; clone: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const create = () =>
    fetch(`${API_URL}/api/git/${repoId}/clone-token`, { method: "POST", cache: "no-store" })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).detail ?? r.statusText))))
      .then(setInfo, (e: Error) => setErr(e.message));
  return (
    <Modal title="Work locally" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted">
          Clone the repository with Git, work on a branch, and push it back: each pushed commit becomes a commit here and its checks run. Protected branches take changes
          through pull requests only. The clone URL carries a personal API token that expires in 7 days (it is listed under Account → API tokens).
        </p>
        {!info ? (
          <button type="button" onClick={create} className={buttonClass.primary}>
            Create clone URL
          </button>
        ) : (
          <>
            <div>
              <div className="mb-1 text-xs text-muted">Clone command</div>
              <pre className="whitespace-pre-wrap break-all rounded-md border border-line bg-ink p-2 font-mono text-xs text-soft">{info.clone}</pre>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(info.clone).then(() => setCopied(true))}
                className={`${buttonClass.secondary} mt-1`}
              >
                <Icon name="copy" className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="text-xs text-muted">
              Remote URL: <span className="font-mono">{info.url}</span>
              {info.token && (
                <>
                  <br />
                  If Git asks for credentials: user name <span className="font-mono">{info.username}</span>, password the token (shown once, expires {info.expires_at?.slice(0, 10)}).
                </>
              )}
            </div>
            <div className="text-xs text-muted">
              To bring an existing local repository: <span className="font-mono">git remote add origin &lt;URL&gt;</span>, <span className="font-mono">git merge master --allow-unrelated-histories</span>,
              then push a new branch.
            </div>
          </>
        )}
        {err && <p className="text-xs text-bad">{err}</p>}
      </div>
    </Modal>
  );
}
