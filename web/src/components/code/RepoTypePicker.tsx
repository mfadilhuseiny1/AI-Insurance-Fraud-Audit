"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";

/* "What are you building?": the first step of New repository. Five kinds of work, each with the repository templates
   that fit it and the apps that do the job better than a repository (a notebook, Model Studio, the Developer Console…).
   A template choice continues to the name/Project form; an app choice opens that app's create flow. */

export type RepoTemplateId =
  | "python" | "python-library" | "r" | "java" | "excel" | "udf" | "keyed_udf"
  | "model-training" | "model-adapter-library" | "model-evaluator-library" | "typescript-functions";

export type RepoOption = { key: string; label: string; hint: string; icon: IconName; template?: RepoTemplateId; name?: string; href?: string; badge?: string };
type Category = { key: string; label: string; hint: string; icon: IconName; options: RepoOption[] };

export const CATEGORIES: Category[] = [
  {
    key: "pipelines", label: "Pipelines", icon: "pipeline", hint: "Transform and integrate datasets using Python, SQL, Java and more.",
    options: [
      { key: "python", label: "Python", icon: "code", template: "python", name: "transforms-python", badge: "Recommended",
        hint: "Python transforms on Polars, pandas, DuckDB or Spark: a pipeline, an example transform and a pytest test." },
      { key: "java", label: "Java", icon: "code", template: "java", name: "transforms-java", hint: "Java transforms on Spark: a PipelineDefiner, transform samples and a JUnit test." },
      { key: "sql", label: "SQL", icon: "database", href: "/pipeline", hint: "SQL transforms as nodes in Pipeline Builder (or ad-hoc in SQL Studio)." },
      { key: "r", label: "R", icon: "code", template: "r", name: "transforms-r", hint: "Rscript transforms declared in .transforms YAML. Needs R installed on the host." },
      { key: "excel", label: "Excel parser", icon: "table", template: "excel", name: "excel-parser", hint: "Parse xls/xlsx/xlsm files in Java: tables with differing schemas, forms, an error output." },
      { key: "keyed_udf", label: "Streaming keyed process", icon: "signal", template: "keyed_udf", name: "udf-keyed-process",
        hint: "A stateful Java UDF for streaming pipelines: state and timers per key." },
      { key: "python-library", label: "Python library", icon: "layers", template: "python-library", name: "my-library", hint: "Shared Python code other repositories import: tag a version to publish it." },
    ],
  },
  {
    key: "functions", label: "Functions", icon: "logic", hint: "Write reusable code for Workshop, Pipeline Builder, Transforms and more.",
    options: [
      { key: "logic", label: "Business logic (template or AIP)", icon: "sparkle", href: "/functions?new=logic", badge: "Guided",
        hint: "KPIs, rules before an action, risk scores, SLAs, alerts on your object types: written for you, published, used in the apps." },
      { key: "python-functions", label: "Python functions", icon: "code", template: "python", name: "python-functions",
        hint: "Functions in python-functions/src with @function: on objects, queries with an API name, Nexus edits." },
      { key: "typescript-functions", label: "TypeScript functions", icon: "code", template: "typescript-functions", name: "ts-functions",
        hint: "TypeScript functions on the Nexus: a query, an OSDK where clause, an edit function and unit tests." },
      { key: "udf", label: "Pipeline Builder UDF", icon: "pipeline", template: "udf", name: "udf-definitions", hint: "Java user-defined functions Pipeline Builder calls row by row (the Multiply example)." },
    ],
  },
  {
    key: "analytics", label: "Analytics", icon: "wave", hint: "Analyze your datasets using your preferred data science and statistics environments.",
    options: [
      { key: "jupyter", label: "Jupyter notebook", icon: "code", href: "/code-workspaces?new=jupyter", hint: "JupyterLab on your datasets, with its own compute; models go to MLflow." },
      { key: "vscode", label: "VS Code", icon: "keyboard", href: "/code-workspaces?new=vscode", hint: "A full VS Code in the browser on a workspace folder." },
      { key: "code-workbook", label: "Code Workbook", icon: "split", href: "/code-workbook", hint: "A graph of Python, SQL and template nodes over datasets, run interactively." },
      { key: "sql-studio", label: "SQL worksheet", icon: "database", href: "/sql-studio", hint: "Query datasets and tables with SQL, chart the result." },
    ],
  },
  {
    key: "models", label: "Models", icon: "cpu", hint: "Create, test and train custom models for machine learning, forecasting, optimization and more.",
    options: [
      { key: "model-training", label: "Model training", icon: "cpu", template: "model-training", name: "model-training", badge: "MLflow",
        hint: "Train in a Python transform, publish to MLflow with an experiment, evaluation and inference transforms." },
      { key: "model-studio", label: "Model Studio (no code)", icon: "sliders", href: "/model-studio?new=1", hint: "Pick algorithms (random forest, ANN, SVM…) and their settings, benchmark them." },
      { key: "model-evaluator-library", label: "Model evaluator library", icon: "check", template: "model-evaluator-library", name: "model-evaluators",
        hint: "A custom evaluator for Modeling Objectives, published as a library." },
      { key: "model-adapter-library", label: "Model adapter library", icon: "plug", template: "model-adapter-library", name: "model-adapters",
        hint: "Adapters for externally hosted and container models, published as a library." },
    ],
  },
  {
    key: "applications", label: "Applications", icon: "device", hint: "Develop, preview and deploy interactive applications using Code Workspaces, Developer Console, OSDK and more.",
    options: [
      { key: "developer-console", label: "Developer Console (OSDK app)", icon: "keyboard", href: "/developer-console", hint: "Your own app on the Nexus: OAuth client, generated SDK, website hosting." },
      { key: "app-vscode", label: "Code Workspace", icon: "code", href: "/code-workspaces?new=vscode", hint: "Build and preview a web app in VS Code, then host it." },
      { key: "slate", label: "Slate", icon: "layers", href: "/slate", hint: "An HTML/JS application with widgets, queries and functions." },
      { key: "workshop", label: "Workshop", icon: "device", href: "/workshop", hint: "An operational app on object types without code." },
    ],
  },
];

const RECENT_KEY = "bluesandai:repo-type-recent";
const ALL = CATEGORIES.flatMap((c) => c.options.map((o) => ({ ...o, category: c })));

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function remember(key: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...readRecent().filter((k) => k !== key)].slice(0, 4)));
  } catch {
    /* private mode: no recent list */
  }
}

export function RepoTypePicker({ onPick, onGuide, canRunCode = true }: { onPick: (o: RepoOption) => void; onGuide: () => void; canRunCode?: boolean }) {
  const [cat, setCat] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [recent] = useState(readRecent);
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? ALL.filter((o) => `${o.category.label} ${o.label} ${o.hint}`.toLowerCase().includes(s)) : [];
  }, [q]);
  const current = CATEGORIES.find((c) => c.key === cat) ?? null;
  const choose = (o: RepoOption) => {
    remember(o.key);
    onPick(o);
  };
  const option = (o: RepoOption & { category?: Category }) => {
    const body = (
      <>
        <span className="mt-0.5 rounded-md bg-ocean/15 p-1.5 text-ocean"><Icon name={o.icon} className="h-4 w-4" /></span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium text-white">
            {o.category && <span className="text-muted">{o.category.label} ›</span>}
            {o.label}
            {o.badge && <span className="rounded-full bg-ocean/15 px-1.5 py-px text-[10px] font-normal text-ocean">{o.badge}</span>}
            {o.href && <Icon name="external" className="h-3 w-3 text-muted" />}
            {!o.href && !canRunCode && <Icon name="lock" className="h-3 w-3 text-sand" />}
          </span>
          <span className="mt-0.5 block text-xs leading-5 text-muted">{o.hint}</span>
        </span>
      </>
    );
    const cls = "flex w-full items-start gap-3 rounded-xl border border-line bg-panel-2/40 p-3 text-left transition hover:border-ocean/60 hover:bg-panel-2";
    return o.href ? (
      <Link key={o.key} href={o.href} onClick={() => remember(o.key)} className={cls} data-repo-option={o.key}>{body}</Link>
    ) : (
      <button key={o.key} type="button" onClick={() => choose(o)} disabled={!canRunCode} data-repo-option={o.key}
        title={canRunCode ? undefined : "Creating a repository runs code: limited to administrators and the allowed groups (Control Panel → Security → Code execution)"}
        className={`${cls} disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line`}>{body}</button>
    );
  };
  return (
    <div className="space-y-5 p-5">
      <div className="flex items-center gap-4 border-b border-line text-sm">
        <button type="button" onClick={() => { setCat(null); setQ(""); }} className={`-mb-px border-b-2 pb-2 ${!cat && !q ? "border-ocean text-white" : "border-transparent text-muted hover:text-soft"}`}>All</button>
        <Link href="/code-workspaces?new=vscode" className="-mb-px border-b-2 border-transparent pb-2 text-muted hover:text-soft">VS Code</Link>
        <button type="button" onClick={onGuide} className="-mb-px border-b-2 border-transparent pb-2 text-muted underline-offset-4 hover:text-soft hover:underline">Learn more</button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex-1 text-xl font-semibold text-white">
          {current ? (
            <button type="button" onClick={() => setCat(null)} className="inline-flex items-center gap-2 hover:text-ocean"><Icon name="left" className="h-4 w-4" /> {current.label}</button>
          ) : "What are you building?"}
        </h2>
        <label className="relative w-full sm:w-80">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find and select repository type" data-repo-search
            className="w-full rounded-lg border border-ocean/50 bg-panel-2 py-2 pl-3 pr-9 text-sm text-white outline-none placeholder:text-ocean/70 focus:border-ocean" />
          <Icon name="search" className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-ocean" />
        </label>
      </div>
      {q.trim() ? (
        hits.length ? <div className="grid gap-2 md:grid-cols-2">{hits.map((o) => option(o))}</div> : <p className="text-sm text-muted">No repository type matches “{q}”.</p>
      ) : current ? (
        <>
          <p className="-mt-3 text-sm text-muted">{current.hint}</p>
          <div className="grid gap-2 md:grid-cols-2">{current.options.map((o) => option(o))}</div>
        </>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            {CATEGORIES.map((c) => (
              <button key={c.key} type="button" onClick={() => setCat(c.key)} data-repo-category={c.key}
                className="group flex min-h-[84px] items-start gap-3 rounded-xl border border-line bg-panel-2/30 p-4 text-left transition hover:border-ocean/60 hover:bg-panel-2">
                <span className="rounded-lg bg-ocean/10 p-2 text-ocean"><Icon name={c.icon} className="h-5 w-5" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-semibold text-white">{c.label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted">{c.hint}</span>
                </span>
                <Icon name="right" className="mt-1 h-4 w-4 text-muted transition group-hover:text-ocean" />
              </button>
            ))}
          </div>
          {recent.length > 0 && (
            <div>
              <h3 className="mb-2 text-base font-semibold text-white">or recent selection?</h3>
              <div className="flex flex-wrap gap-2">
                {recent.map((k) => ALL.find((o) => o.key === k)).filter((o): o is (typeof ALL)[number] => !!o).map((o) => {
                  const crumb = (
                    <span className="flex items-center gap-2 text-xs">
                      <span className="rounded bg-panel-2 px-2 py-1 text-soft">{o.category.label}</span>
                      <Icon name="right" className="h-3 w-3 text-muted" />
                      <span className="rounded bg-panel-2 px-2 py-1 text-soft">{o.label}</span>
                    </span>
                  );
                  const cls = "rounded-lg border border-line p-2.5 hover:border-ocean/60";
                  return o.href ? <Link key={o.key} href={o.href} className={cls}>{crumb}</Link>
                    : <button key={o.key} type="button" onClick={() => choose(o)} disabled={!canRunCode} className={`${cls} disabled:opacity-50`}>{crumb}</button>;
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
