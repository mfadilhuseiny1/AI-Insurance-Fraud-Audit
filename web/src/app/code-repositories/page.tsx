"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { Icon } from "@/components/Icon";
import { ActionMenu } from "@/components/kg/parts";
import { AppHome, type AppHomeItem } from "@/components/AppHome";
import { ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { RepoTypePicker, type RepoOption } from "@/components/code/RepoTypePicker";
import { codeRepos, type Repo, type RepoSummary } from "@/lib/codeRepos";
import { when } from "@/lib/format";
import { confirmDialog } from "@/lib/dialogs";

export default function CodeRepositoriesPage() {
  const router = useRouter();
  // Control Panel → Security → Code execution: a user who may not run code cannot create, edit or build repositories
  const noCode = useAuth().me?.can_run_code === false;
  const [items, setItems] = useState<RepoSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ?new=1 (Files → New → Repository) opens "What are you building?"
  // ?new=1 opens "What are you building?"
  const params = useSearchParams();
  const [creating, setCreating] = useState(() => params.get("new") === "1");
  const [guideOpen, setGuideOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "attention">("all");
  const load = useCallback(() => {
    codeRepos
      .list()
      .then(setItems)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const attention = (repo: RepoSummary) => repo.dirty || repo.last_build?.status === "failed";
  const byId = useMemo(() => new Map((items ?? []).map((r) => [r.id, r])), [items]);
  const statusFilter = useMemo(() => {
    if (filter === "all") return undefined;
    return (i: AppHomeItem) => {
      const repo = byId.get(i.id);
      return !!repo && (filter === "active" ? repo.last_build?.status === "succeeded" : attention(repo));
    };
  }, [filter, byId]);

  return (
    <>
      <AppHome
        app="Code Repositories"
        icon="code"
        accent="#ef4444"
        href="/code-repositories"
        tagline="Production-ready code with Git workflows, checks, previews, builds and pull requests, in a web IDE."
        description={
          <>
            Write and collaborate on production-ready code with Git workflows, integrated checks, previews, builds, and pull requests. Supported repository types include
            transforms, Functions, model development, and shared libraries. Transforms read datasets from Files (for example{" "}
            <Link href="/pipeline" className="text-ocean hover:underline">
              pipeline
            </Link>{" "}
            outputs) as pandas DataFrames and build new datasets; every build is tracked in{" "}
            <Link href="/lineage" className="text-ocean hover:underline">
              Data Lineage
            </Link>
            .
          </>
        }
        noun={["repository", "repositories"]}
        stats={
          items
            ? [
                { label: "Repositories", value: String(items.length) },
                { label: "Open PRs", value: String(items.reduce((sum, repo) => sum + repo.open_prs, 0)) },
                { label: "Builds", value: String(items.reduce((sum, repo) => sum + repo.build_count, 0)) },
                { label: "Needs attention", value: String(items.filter(attention).length) },
              ]
            : [
                { label: "Repositories", value: "" },
                { label: "Open PRs", value: "" },
                { label: "Builds", value: "" },
                { label: "Needs attention", value: "" },
              ]
        }
        items={
          items?.map((r) => ({
            id: r.id,
            href: `/code-repositories/${r.id}`,
            title: r.name,
            updated_at: r.updated_at,
            detail: [r.description, r.last_commit ? `Last commit on ${r.default_branch}: ${r.last_commit.message} · ${when(r.last_commit.at)}` : ""].filter(Boolean).join(" — ") || undefined,
            badges: [
              ...(r.dirty ? [{ label: "uncommitted", tone: "warn" as const }] : []),
              r.last_build
                ? { label: `Build ${r.last_build.status.replace("_", " ")}`, tone: r.last_build.status === "failed" ? ("bad" as const) : r.last_build.status === "succeeded" ? ("ok" as const) : ("warn" as const) }
                : { label: "Never built", tone: "muted" as const },
            ],
            meta: `${r.project_name ? `${r.project_name} · ` : ""}${r.branch_count} branches · ${r.open_prs} open PRs · ${r.file_count} files`,
            actions: (
              <ActionMenu
                items={[
                  { label: "Open", icon: "external", onClick: () => router.push(`/code-repositories/${r.id}`) },
                  // deleting a repository is for Owners of its Project
                  ...(r.my_role === "owner"
                    ? [
                        "divider" as const,
                        {
                          label: "Delete",
                          icon: "trash" as const,
                          danger: true,
                          onClick: async () => {
                            if (!(await confirmDialog(`Delete the repository "${r.name}"? Datasets its builds wrote stay in Files.`))) return;
                            try {
                              await codeRepos.remove(r.id);
                            } catch (e) {
                              setError((e as Error).message);
                            }
                            load();
                          },
                        },
                      ]
                    : []),
                ]}
              />
            ),
          })) ?? null
        }
        error={error}
        filter={statusFilter}
        toolbar={
          <div className="flex items-center gap-1 rounded-lg border border-line bg-panel p-0.5 text-xs">
            {(
              [
                ["all", "All"],
                ["active", "Healthy builds"],
                ["attention", "Needs attention"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" onClick={() => setFilter(value)} className={`rounded-md px-2.5 py-1 ${filter === value ? "bg-panel-2 text-strong" : "text-muted hover:text-soft"}`}>
                {label}
              </button>
            ))}
          </div>
        }
        empty={{
          title: "Create your first repository",
          hint: "It starts with an example transform you can build right away.",
          steps: ["Pick a language template", "Edit on a branch and run the checks", "Build the output datasets"],
        }}
        headerActions={
          <button type="button" onClick={() => setGuideOpen(true)} className={buttonClass.ghost}>
            <Icon name="info" /> Repository guide
          </button>
        }
        create={
          <>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className={buttonClass.primary}
            >
              <Icon name="plus" /> New repository
            </button>
            <span className="rounded-full bg-ocean/15 px-2.5 py-1 text-xs text-ocean">Web IDE</span>
            {noCode && (
              <div data-testid="no-code-execution" className="flex w-full items-start gap-2 rounded-lg border border-sand/30 bg-sand/10 p-3 text-xs text-soft">
                <Icon name="eye" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sand" />
                <span>
                  You can read repositories but not create, change or build them: running code on the BluesandAI host is limited to administrators and the allowed groups
                  (Control Panel → Security → Code execution). Ask an administrator to add one of your groups.
                </span>
              </div>
            )}
          </>
        }
      />
      {creating && <NewRepoDialog canRunCode={!noCode} onClose={() => setCreating(false)} onGuide={() => (setCreating(false), setGuideOpen(true))} onCreated={(r) => router.push(`/code-repositories/${r.id}`)} />}
      {guideOpen && <RepositoryGuide onClose={() => setGuideOpen(false)} />}
    </>
  );
}

function RepositoryGuide({ onClose }: { onClose: () => void }) {
  const sections = [
    ["Author", "Use the Code tab as a web IDE with file navigation, autocomplete, linting, error checking, SQL scratchpad, Foundry Explorer, Problems, Preview, Tests, Build, Debugger, and Docs helpers.", "code"],
    ["Collaborate", "Work from a sandbox or global branch, commit changes, create tags, and propose a pull request for review before merging into a protected branch.", "split"],
    ["Validate", "Run checks and unit tests, preview transforms against sample data, inspect errors, compare file changes, and analyze downstream impact before building.", "check"],
    ["Publish", "Build output datasets, manage schedules, pin runtime modules, configure Spark profiles, publish libraries and artifacts, and package dataset transformations for Marketplace.", "layers"],
    ["Administer", "Manage repository settings, branch protection, upgrade prompts, permissions, artifact repositories, ontology imports, compute usage, and AIP features.", "sliders"],
  ] as const;
  return <Modal title="Code Repositories guide" icon="info" onClose={onClose} wide><div className="p-5"><div className="rounded-lg border border-ocean/25 bg-ocean/10 p-3 text-xs leading-5 text-soft"><strong className="text-ocean">Production-ready collaboration.</strong> Code Repositories combines a browser IDE with Git, checks, data previews, builds, and review workflows. Python transforms are legacy where VS Code workspaces are available; Java and SQL transforms remain supported here.</div><div className="mt-5 grid gap-3 md:grid-cols-2">{sections.map(([title, description, icon]) => <div key={title} className="rounded-lg border border-line bg-panel-2 p-4"><div className="flex items-center gap-2 text-sm font-medium"><span className="rounded-md bg-ocean/15 p-1.5 text-ocean"><Icon name={icon} className="h-4 w-4" /></span>{title}</div><p className="mt-2 text-xs leading-5 text-muted">{description}</p></div>)}</div><div className="mt-5 flex items-center justify-between rounded-lg border border-line bg-panel-2 p-3 text-xs"><span className="text-muted">Start with a repository template for Python, R, Java, SQL, Functions, or shared libraries.</span><button onClick={onClose} className={buttonClass.primary}>Open repository workspace</button></div></div></Modal>;
}

const TEMPLATES = [
  { id: "python", label: "Python", name: "transforms-python", hint: "Python transforms (single node on Polars, pandas and DuckDB, or Spark): a pipeline, setup.py, meta.yaml, an example transform and a pytest test." },
  { id: "r", label: "R", name: "transforms-r", hint: "Rscript transforms declared in .transforms YAML, with a local Foundry-style dataset bridge. Requires R installed on this machine." },
  {
    id: "typescript-functions",
    label: "TypeScript functions",
    name: "ts-functions",
    hint: "TypeScript functions on the Ontology (v2, and v1 decorated classes): an API-named query, a read function with an OSDK where clause, an Ontology edit function and unit tests run by the checks, in ts-functions/src. Publish them from Functions.",
  },
  { id: "python-library", label: "Python Library", name: "my-library", hint: "Shared Python code: tag a version to publish it; other repositories add it to their meta.yaml and import it." },
  { id: "model-training", label: "Model Training", name: "model-training", hint: "Train a model in a Python transform: a model adapter, a training transform publishing to a ModelOutput (with an experiment), and inference and evaluation transforms with a ModelInput." },
  { id: "model-evaluator-library", label: "Model Evaluator Library", name: "model-evaluators", hint: "A custom evaluator for Modeling Objectives: Evaluator.apply_spark with its parameters and metrics in the docstring. Tag a version to publish it." },
  { id: "model-adapter-library", label: "Model Adapter Library", name: "model-adapters", hint: "Model adapters for externally hosted and container models, published as a library (tag a version)." },
  { id: "java", label: "Java", name: "transforms-java", hint: "Java transforms on Spark: a PipelineDefiner, high- and low-level transform samples (commented out) and a JUnit test." },
  {
    id: "excel",
    label: "Java · Excel parser",
    name: "excel-parser",
    hint: "Parse Excel files (xls, xlsx, xlsm, …) in Java with transforms-excel-parser: a table example (inconsistent schemas combined, an error output) and a form example. The library is already added.",
  },
  { id: "udf", label: "Map UDF Definition/Implementation", name: "udf-definitions", hint: "Java user-defined functions for Pipeline Builder: the Multiply example definition, implementation and examples." },
  {
    id: "keyed_udf",
    label: "Keyed Process UDF",
    name: "udf-keyed-process",
    hint: "A stateful Java UDF for streaming pipelines: records partitioned by key columns, state and event-time / processing-time timers per key (the SensorWindow example).",
  },
] as const;

// a user who may not run code still sees what can be built (and opens the apps); the repository templates are locked
function NewRepoDialog({ onClose, onCreated, onGuide, canRunCode }: { onClose: () => void; onCreated: (r: Repo) => void; onGuide: () => void; canRunCode: boolean }) {
  // first "What are you building?", then the name and Project of the chosen repository type
  const [picked, setPicked] = useState<RepoOption | null>(null);
  const [template, setTemplate] = useState<(typeof TEMPLATES)[number]["id"]>("python");
  const [name, setName] = useState("transforms-python");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projects, setProjects] = useState<{ id: string; name: string; default: boolean }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // the API's rule (code_repos.PATH_OK): told while typing, not after Create
  const nameOk = !name.trim() || /^[A-Za-z0-9_.\- ]+$/.test(name.trim());
  useEffect(() => {
    // every repository is in a Project: the ones the user is an Editor or Owner of; the default Project last
    codeRepos
      .projects()
      .then((r) => {
        const list = [...r.projects.filter((p) => !p.default), ...r.projects.filter((p) => p.default)];
        setProjects(list);
        setProjectId((cur) => cur || list[0]?.id || "");
      })
      .catch(() => setProjects([]));
  }, []);
  if (!picked)
    return (
      <Modal title="New repository" icon="code" onClose={onClose} xl>
        <RepoTypePicker
          canRunCode={canRunCode}
          onGuide={onGuide}
          onPick={(o) => {
            setPicked(o);
            if (o.template) setTemplate(o.template);
            if (o.name) setName(o.name);
          }}
        />
      </Modal>
    );
  const chosen = TEMPLATES.find((t) => t.id === template);
  return (
    <Modal title="New repository" icon="code" onClose={onClose}>
      <form
        className="space-y-4 p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            onCreated(await codeRepos.create(name.trim(), description.trim(), template, projectId || null));
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <Field label="Name" hint={nameOk ? undefined : "A repository name may hold letters, digits, spaces, - _ and . (no dashes like —, brackets or commas)"}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!nameOk} className={inputClass} />
        </Field>
        <Field label="Description (optional)">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </Field>
        <Field
          label="Project (its roles: Viewers read, Editors change and build, Owners manage settings and delete)"
          hint={projects && !projects.length ? "You are not an Editor of any Project: ask a Project Owner for the Editor role" : undefined}
        >
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={!projects?.length} className={inputClass}>
            {!projects && <option value="">Loading Projects…</option>}
            {projects?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex items-start gap-3 rounded-lg border border-ocean/40 bg-ocean/10 p-3 text-xs">
          <span className="rounded-md bg-ocean/15 p-1.5 text-ocean">
            <Icon name={picked.icon} className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-white">{picked.label}</span>
            <span className="block text-muted">{picked.hint || chosen?.hint}</span>
          </span>
          <button type="button" onClick={() => setPicked(null)} className="text-ocean hover:underline">
            Change
          </button>
        </div>
        <ErrorBox message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim() || !nameOk || !projectId} className={buttonClass.primary}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
