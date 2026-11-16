"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppHome, type AppHomeItem } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { codeRepos, type RepoSummary } from "@/lib/codeRepos";
import { codeWorkbooks } from "@/lib/codeWorkbook";
import { contour } from "@/lib/contour";

type WorkbookRow = Awaited<ReturnType<typeof codeWorkbooks.list>>[number];
type Show = "all" | "workbooks" | "repositories";

/** Code Workbook home: the workbooks (Files items, with a form for a new one from imported datasets) and the
 *  repositories whose transforms open as graphs. */
export default function CodeWorkbookHomePage() {
  const router = useRouter();
  const [loadVersion, setLoadVersion] = useState(0);
  const [result, setResult] = useState<{ version: number; repositories: RepoSummary[] } | null>(null);
  const [failure, setFailure] = useState<{ version: number; message: string } | null>(null);
  const [workbooks, setWorkbooks] = useState<WorkbookRow[] | null>(null);
  const [wbError, setWbError] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [title, setTitle] = useState("Untitled workbook");
  const [picked, setPicked] = useState<string[]>([]);
  const [show, setShow] = useState<Show>("all");

  const load = useCallback(() => setLoadVersion((version) => version + 1), []);
  useEffect(() => {
    let cancelled = false;
    const version = loadVersion;
    codeRepos.list().then((repositories) => {
      if (!cancelled) setResult({ version, repositories });
    }).catch((e: Error) => {
      if (!cancelled) setFailure({ version, message: e.message });
    });
    return () => { cancelled = true; };
  }, [loadVersion]);
  useEffect(() => {
    codeWorkbooks.list().then(setWorkbooks, (e: Error) => (setWorkbooks([]), setWbError(e.message)));
    contour.sources().then((s) => setDatasets(s.datasets), () => undefined);
  }, []);

  const repositories = result?.version === loadVersion ? result.repositories : null;
  const error = failure?.version === loadVersion ? failure.message : null;

  const items = useMemo<AppHomeItem[] | null>(() => {
    if (workbooks === null || (repositories === null && !error)) return null;
    return [
      ...workbooks.map((r) => ({
        id: `wb:${r.id}`,
        href: `/code-workbook/workbooks/${r.id}`,
        title: r.name.replace(/\.codeworkbook$/, ""),
        path: (r.path ?? []).map((x) => x.name),
        updated_at: r.updated_at,
        icon: "graph" as const,
        badges: [{ label: "Workbook", tone: "ocean" as const }],
      })),
      ...(repositories ?? []).map((repo) => ({
        id: `repo:${repo.id}`,
        href: `/code-workbook/${encodeURIComponent(repo.id)}`,
        title: repo.name,
        detail: repo.description || "Code transformation repository",
        updated_at: repo.updated_at,
        icon: "code" as const,
        badges: [
          { label: "Repository", tone: "muted" as const },
          ...(repo.last_build ? [{ label: `Build ${repo.last_build.status}`, tone: repo.last_build.status === "succeeded" ? ("ok" as const) : ("bad" as const) }] : []),
        ],
        meta: `${repo.branch_count} branches · ${repo.file_count} files · ${repo.default_branch}`,
      })),
    ];
  }, [workbooks, repositories, error]);
  const filter = useMemo(() => (show === "all" ? undefined : (i: AppHomeItem) => i.id.startsWith(show === "workbooks" ? "wb:" : "repo:")), [show]);

  return (
    <AppHome
      app="Code Workbook"
      icon="graph"
      accent="#10b981"
      href="/code-workbook"
      tagline="Graphs of Python, SQL, manual-entry and template nodes over datasets, run interactively."
      description={
        <>
          Workbooks: graphs of Python, SQL, manual-entry and template nodes over datasets, run interactively with a console, saved as datasets, branched and merged,
          and exported to Code Repositories. Below them, repository transforms shown as graphs — open a repository to discover its transforms; preview and build run
          through the repository&apos;s existing execution API. Only repositories visible to your account are listed. (Legacy.)
        </>
      }
      headerActions={
        <Link href="/code-repositories" className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-xs text-soft hover:bg-panel-2">
          <Icon name="code" /> Code Repositories
        </Link>
      }
      noun={["workbook or repository", "workbooks and repositories"]}
      error={error ?? wbError}
      items={items}
      stats={[
        { label: "Workbooks", value: (workbooks?.length ?? 0).toLocaleString() },
        { label: "Repositories", value: repositories ? repositories.length.toLocaleString() : "—" },
        { label: "Built repos", value: repositories ? repositories.filter((r) => r.last_build).length.toLocaleString() : "—" },
        { label: "Execution", value: "Preview · Build" },
      ]}
      toolbar={
        <div className="flex items-center gap-1 rounded-lg border border-line bg-panel p-0.5 text-xs">
          {(["all", "workbooks", "repositories"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setShow(k)} className={`rounded-md px-2.5 py-1 ${show === k ? "bg-panel-2 text-strong" : "text-muted hover:text-soft"}`}>
              {k === "all" ? "All" : k === "workbooks" ? "Workbooks" : "Repositories"}
            </button>
          ))}
          {error && (
            <button type="button" onClick={load} className="rounded-md px-2.5 py-1 text-bad underline">
              Retry
            </button>
          )}
        </div>
      }
      filter={filter}
      empty={{ title: "Start your first workbook", hint: "Import datasets into a new workbook, or create a Code Repository: its transforms appear here after checks discover them.", steps: ["Name the workbook", "Pick datasets to import", "Add Python and SQL nodes"] }}
      create={
        <>
          <div className="w-56">
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputClass} py-1.5 text-sm`} aria-label="Workbook title" />
          </div>
          <div className="w-64">
            <select multiple value={picked} onChange={(e) => setPicked([...e.target.selectedOptions].map((o) => o.value))} className={`${inputClass} h-16 text-xs`} aria-label="Datasets to import" title="Datasets to import (Ctrl+click for several)">
              {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <button
            type="button"
            disabled={!title.trim()}
            className={buttonClass.primary}
            onClick={async () => {
              try {
                const w = await codeWorkbooks.create(title.trim(), picked);
                router.push(`/code-workbook/workbooks/${w.item.id}`);
              } catch (e) {
                setWbError((e as Error).message);
              }
            }}
          >
            <Icon name="plus" className="h-3.5 w-3.5" /> New workbook
          </button>
          <Link href="/code-repositories" className={buttonClass.secondary}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Create or manage repositories
          </Link>
        </>
      }
    />
  );
}
