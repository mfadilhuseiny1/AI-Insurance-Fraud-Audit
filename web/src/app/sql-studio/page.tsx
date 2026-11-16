"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { ActionMenu } from "@/components/kg/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { downloadCsv, ResultsPanel, selectionOf, SqlEditor } from "@/components/sql/SqlParts";
import { api, type DriveItem } from "@/lib/api";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { PREVIEW_LIMITS, sqlStudio, starterQuery, type SqlMode, type SqlResource, type SqlResult, type Worksheet } from "@/lib/sqlStudio";

/** SQL Studio (palantir.com/docs/foundry/sql-warehousing/sql-studio): worksheets of Spark SQL over datasets and Iceberg
 *  tables (data mode, Furnace) or object types (object mode, Ontology SQL), with results, charts, versions and AIP. */
export default function SqlStudioPage() {
  return (
    <Suspense fallback={null}>
      <SqlStudio />
    </Suspense>
  );
}

const KIND_ICON: Record<string, IconName> = { dataset: "table", View: "eye", "Iceberg table": "layers", "object type": "cube", "link type": "link" };
const LIMIT_KEY = "bluesand.sql.limit";

function SqlStudio() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<SqlMode>((params.get("mode") as SqlMode) || "data");
  const [sql, setSql] = useState(params.get("sql") ?? "");
  const [worksheet, setWorksheet] = useState<Worksheet | null>(null);
  const [savedSql, setSavedSql] = useState<string | null>(null);
  const [resources, setResources] = useState<SqlResource[] | null>(null);
  const [resourceQuery, setResourceQuery] = useState("");
  const [selected, setSelected] = useState<SqlResource | null>(null);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [dialog, setDialog] = useState<null | "open" | "save" | "history" | "publish">(null);
  // rendered on the client only (useSearchParams under Suspense), so the stored limit is read on first render
  const [limit, setLimit] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(LIMIT_KEY));
      if (PREVIEW_LIMITS.includes(saved as 1000 | 10000)) return saved;
    } catch {}
    return PREVIEW_LIMITS[0];
  });
  const editorRef = useRef<HTMLDivElement>(null);

  // the worksheet named in the URL (?worksheet=, or a Files item ?item=), else the scratchpad draft
  useEffect(() => {
    let alive = true;
    const wsId = params.get("worksheet");
    const itemId = params.get("item");
    const load = wsId ? sqlStudio.worksheet(wsId) : itemId ? sqlStudio.worksheetByItem(itemId) : null;
    if (load) {
      load.then(
        (w) => {
          if (!alive) return;
          setWorksheet(w);
          setSavedSql(w.sql);
          setSql(w.draft?.sql ?? w.sql);
          setMode(w.draft?.mode ?? w.mode);
        },
        (e: Error) => alive && setError(e.message),
      );
    } else if (!params.get("sql")) {
      sqlStudio.scratchpad().then((d) => {
        if (!alive) return;
        setSql(d.sql);
        if (d.sql) setMode(d.mode);
      }, () => {});
    }
    return () => {
      alive = false;
    };
  }, [params]);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => sqlStudio.resources(mode, resourceQuery).then((r) => alive && setResources(r), (e: Error) => alive && (setResources([]), setError(e.message))), 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [mode, resourceQuery]);

  // unsaved changes are kept between sessions (the scratchpad too)
  useEffect(() => {
    if (worksheet && sql === savedSql) return;
    const t = setTimeout(() => sqlStudio.saveDraft(worksheet?.id ?? "scratchpad", sql, mode).catch(() => {}), 1200);
    return () => clearTimeout(t);
  }, [sql, mode, worksheet, savedSql]);

  const run = useCallback(
    async (text?: string) => {
      const q = (text ?? sql).trim();
      if (!q) return;
      setRunning(true);
      setError(null);
      try {
        setResult(await sqlStudio.query(q, mode, limit));
      } catch (e) {
        setResult(null);
        setError((e as Error).message);
      } finally {
        setRunning(false);
      }
    },
    [sql, mode, limit],
  );
  const runSelectionOrAll = () => run(selectionOf(editorRef.current?.querySelector("textarea") ?? null) ?? sql);

  const changeMode = (next: SqlMode) => {
    if (next === mode) return;
    setMode(next);
    setSelected(null);
    setResult(null);
    setError(null);
  };
  const pick = (r: SqlResource) => {
    setSelected(r);
    if (!sql.trim() || (sql.trim().startsWith("SELECT *\nFROM `") && sql.trim().endsWith("LIMIT 100"))) setSql(starterQuery(r));
  };
  const insert = (text: string) => setSql((cur) => (cur.trim() ? `${cur.replace(/\s+$/, "")}\n${text}` : text));

  const format = async () => {
    try {
      setSql((await sqlStudio.format(sql)).sql);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const save = async () => {
    if (!worksheet) return setDialog("save");
    setSaving(true);
    try {
      const w = await sqlStudio.saveWorksheet(worksheet.id, { sql, mode });
      setWorksheet(w);
      setSavedSql(w.sql);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const newScratchpad = async () => {
    if (worksheet && sql !== savedSql && !(await confirmDialog("Leave this worksheet? Its unsaved changes stay as a draft."))) return;
    setWorksheet(null);
    setSavedSql(null);
    setSql("");
    setResult(null);
    setError(null);
    router.push("/sql-studio");
  };
  const setPreviewLimit = (n: number) => {
    setLimit(n);
    try {
      localStorage.setItem(LIMIT_KEY, String(n));
    } catch {}
  };

  const dirty = worksheet ? sql !== savedSql : false;
  const title = worksheet ? worksheet.name : "Scratchpad";
  const shown = useMemo(() => resources ?? [], [resources]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="rounded-md bg-ocean/15 p-1.5 text-ocean">
            <Icon name="database" className="h-4 w-4" />
          </span>
          SQL Studio
        </div>
        <span className="text-xs text-muted">/</span>
        <span className="truncate text-sm text-soft">
          {title}
          {dirty ? " •" : ""}
        </span>
        <span className="rounded-full border border-line-2 bg-panel-2 px-2 py-0.5 text-[10px] text-muted" title={worksheet?.path}>
          {!worksheet ? "Private · not saved" : worksheet.location === "project" ? `Project · ${worksheet.path ?? ""}` : "Private"}
        </span>
        {worksheet && <span className="text-[10px] text-muted">v{worksheet.version_count} · saved {when(worksheet.updated_at)}</span>}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAssistantOpen(!assistantOpen)}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs ${assistantOpen ? "border-ocean/60 bg-ocean/15 text-white" : "border-line-2 text-soft hover:text-white"}`}
          >
            <Icon name="sparkle" className="h-3.5 w-3.5 text-sand" /> AIP
          </button>
          <button
            type="button"
            disabled={saving || (!!worksheet && (!dirty || !worksheet.can_edit))}
            onClick={save}
            className="flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white disabled:opacity-40"
            title={worksheet && !worksheet.can_edit ? "You can read this worksheet but not edit it" : "Save a new version"}
          >
            <Icon name="save" className="h-3.5 w-3.5" /> {saving ? "Saving…" : worksheet ? (dirty ? "Save" : "Saved") : "Save"}
          </button>
          {mode === "object" && (
            <button
              type="button"
              disabled={!worksheet || worksheet.location !== "project" || !worksheet.can_edit || dirty}
              onClick={() => setDialog("publish")}
              className="flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white disabled:opacity-40"
              title={
                !worksheet || worksheet.location !== "project"
                  ? "Save the worksheet to a Project to publish it as an Nexus SQL function"
                  : dirty
                    ? "Save your changes first"
                    : "Publish this query as an Nexus SQL function"
              }
            >
              <Icon name="upload" className="h-3.5 w-3.5" /> Publish
            </button>
          )}
          <ActionMenu
            items={[
              { label: "New scratchpad", icon: "plus", onClick: newScratchpad },
              { label: "Open worksheet…", icon: "folder", onClick: () => setDialog("open") },
              { label: "Version history…", icon: "history", onClick: () => setDialog("history"), disabled: !worksheet },
              { label: worksheet?.location === "private" ? "Save into a project…" : "Save as a new worksheet…", icon: "project", onClick: () => setDialog("save") },
              {
                label: "Rename…",
                icon: "pencil",
                disabled: !worksheet?.can_edit,
                onClick: async () => {
                  if (!worksheet) return;
                  const name = await promptDialog("Worksheet name", worksheet.name);
                  if (!name) return;
                  const w = await sqlStudio.saveWorksheet(worksheet.id, { sql: savedSql ?? sql, mode, name }).catch((e: Error) => (setError(e.message), null));
                  if (w) setWorksheet(w);
                },
              },
              {
                label: limit === PREVIEW_LIMITS[0] ? "Preview up to 10,000 rows" : "Preview up to 1,000 rows",
                icon: "table",
                onClick: () => setPreviewLimit(limit === PREVIEW_LIMITS[0] ? PREVIEW_LIMITS[1] : PREVIEW_LIMITS[0]),
              },
              {
                label: "Delete worksheet",
                icon: "trash",
                disabled: !worksheet?.can_edit,
                onClick: async () => {
                  if (!worksheet || !(await confirmDialog(`Delete the worksheet "${worksheet.name}"?`))) return;
                  await sqlStudio.deleteWorksheet(worksheet.id).catch((e: Error) => setError(e.message));
                  newScratchpad();
                },
              },
            ]}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
          <div className="border-b border-line p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-soft">Resources</span>
            </div>
            <div className="flex items-center gap-2 rounded-md border border-line-2 bg-ink px-2 py-1.5">
              <Icon name="search" className="h-3.5 w-3.5 text-muted" />
              <input value={resourceQuery} onChange={(e) => setResourceQuery(e.target.value)} placeholder="Search resources" className="w-full bg-transparent text-xs outline-none placeholder:text-muted" />
            </div>
          </div>
          <div className="flex border-b border-line p-2">
            <ModeButton active={mode === "data"} onClick={() => changeMode("data")} label="Data" />
            <ModeButton active={mode === "object"} onClick={() => changeMode("object")} label="Object" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <div className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted">{mode === "data" ? "Tabular data" : "Nexus object types"}</div>
            {resources === null && <p className="px-2 py-4 text-xs text-muted">Loading…</p>}
            {shown.map((r) => (
              <div key={r.ref}>
                <button
                  type="button"
                  onClick={() => pick(r)}
                  onDoubleClick={() => insert(`\`${r.ref}\``)}
                  title={`${r.kind} · ${r.ref}\nDouble-click to insert the reference`}
                  className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left ${selected?.ref === r.ref ? "bg-ocean/15 text-white ring-1 ring-ocean/30" : "text-soft hover:bg-panel-2"}`}
                >
                  <Icon name={KIND_ICON[r.kind] ?? "table"} className={`mt-0.5 h-4 w-4 shrink-0 ${selected?.ref === r.ref ? "text-ocean" : "text-muted"}`} />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{r.name.replace(/\.parquet$/i, "")}</span>
                    <span className="block truncate text-[10px] text-muted">{r.path || r.kind}</span>
                  </span>
                </button>
                {selected?.ref === r.ref && <Columns resource={r} mode={mode} onInsert={insert} />}
              </div>
            ))}
            {resources !== null && !shown.length && <p className="px-2 py-4 text-xs text-muted">No resources found.</p>}
          </div>
          <div className="border-t border-line p-3 text-[10px] text-muted">
            <div className="mb-1 flex items-center gap-1.5 text-ok">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" /> {mode === "data" ? "Furnace connected" : "Nexus SQL connected"}
            </div>
            Preview limit: {limit.toLocaleString()} rows
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-end gap-1 border-b border-line bg-panel px-3">
            <div className="flex items-center gap-2 border-b-2 border-ocean px-3 pb-2 text-xs text-white">
              <Icon name="code" className="h-3.5 w-3.5 text-ocean" />
              {title}
            </div>
            <button type="button" onClick={newScratchpad} className="mb-1 ml-1 rounded p-1 text-muted hover:bg-panel-2 hover:text-white" aria-label="New query" title="New scratchpad">
              <Icon name="plus" className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-2 border-b border-line bg-panel-2 px-4 py-2 text-xs">
            <span className="text-muted">Mode</span>
            <span className="rounded-md bg-ocean/15 px-2 py-1 font-medium text-ocean">{mode === "data" ? "Data" : "Object"} mode</span>
            <span className="text-[10px] text-muted">{mode === "data" ? "Furnace · read queries over datasets and Iceberg tables" : "Nexus SQL · read-only, object types by RID or API name"}</span>
            <span className="ml-auto text-muted">
              {selected ? (
                <>
                  {selected.kind} · <span className="text-soft">{selected.name.replace(/\.parquet$/i, "")}</span>
                </>
              ) : (
                "Pick a resource to start"
              )}
            </span>
          </div>
          <section className="flex min-h-[270px] flex-1 flex-col bg-ink" ref={editorRef}>
            <div className="flex items-center gap-1 border-b border-line px-3 py-2">
              <button type="button" disabled={running} onClick={runSelectionOrAll} className="flex items-center gap-1.5 rounded-md bg-ocean px-3 py-1.5 text-xs font-medium text-white hover:bg-ocean-deep disabled:opacity-50" title="Run (Ctrl+Enter); runs only the selection when text is highlighted">
                <Icon name={running ? "refresh" : "play"} className={`h-3 w-3 ${running ? "animate-spin" : ""}`} /> Run
              </button>
              <button type="button" onClick={format} className="rounded-md px-2.5 py-1.5 text-xs text-soft hover:bg-panel-2 hover:text-white">
                Format
              </button>
              <span className="mx-1 h-4 w-px bg-line-2" />
              <button type="button" disabled={!worksheet || !dirty} onClick={() => savedSql !== null && setSql(savedSql)} className="rounded p-1.5 text-muted hover:bg-panel-2 hover:text-white disabled:opacity-40" aria-label="Revert to the saved version" title="Revert to the saved version">
                <Icon name="restore" className="h-3.5 w-3.5" />
              </button>
              <span className="ml-auto text-[10px] text-muted">{sql.split("\n").length} lines · Spark SQL</span>
            </div>
            <SqlEditor value={sql} onChange={setSql} onRun={(q) => run(q)} />
          </section>
          <ResultsPanel result={result} error={error} running={running} onDownload={result ? () => downloadCsv(result, title) : undefined} />
        </main>

        {assistantOpen && <Assistant mode={mode} sql={sql} error={error} selected={selected} onReplace={setSql} onAppend={insert} onClose={() => setAssistantOpen(false)} />}
      </div>

      {dialog === "open" && (
        <OpenDialog
          onClose={() => setDialog(null)}
          onOpen={(w) => {
            setDialog(null);
            router.push(`/sql-studio?worksheet=${w.id}`);
          }}
        />
      )}
      {dialog === "save" && (
        <SaveDialog
          worksheet={worksheet}
          onClose={() => setDialog(null)}
          onSave={async (name, folderId) => {
            const w =
              worksheet && worksheet.location === "private" && folderId
                ? await sqlStudio.saveWorksheet(worksheet.id, { sql, mode, name, folder_id: folderId })
                : await sqlStudio.createWorksheet({ name, sql, mode, folder_id: folderId });
            setDialog(null);
            setWorksheet(w);
            setSavedSql(w.sql);
            router.replace(`/sql-studio?worksheet=${w.id}`);
          }}
        />
      )}
      {dialog === "publish" && worksheet && <PublishFunctionDialog worksheetId={worksheet.id} defaultName={worksheet.name} onClose={() => setDialog(null)} />}
      {dialog === "history" && worksheet && (
        <HistoryDialog
          worksheet={worksheet}
          onClose={() => setDialog(null)}
          onRestore={async (v) => {
            const w = await sqlStudio.restore(worksheet.id, v);
            setWorksheet(w);
            setSavedSql(w.sql);
            setSql(w.sql);
            setMode(w.mode);
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function ModeButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} className={`flex-1 rounded px-2 py-1.5 text-xs ${active ? "bg-panel-2 font-medium text-white ring-1 ring-line-2" : "text-muted hover:text-white"}`}>
      {label}
    </button>
  );
}

function Columns({ resource, mode, onInsert }: { resource: SqlResource; mode: SqlMode; onInsert: (s: string) => void }) {
  const [cols, setCols] = useState(resource.columns ?? null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (resource.columns) return;
    let alive = true;
    sqlStudio.schema(resource.ref, mode).then((s) => alive && setCols(s.columns), (e: Error) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [resource, mode]);
  return (
    <div className="mb-1 ml-8 border-l border-line pl-2 text-[11px]">
      {err && <p className="py-1 text-bad">{err}</p>}
      {!cols && !err && <p className="py-1 text-muted">Loading columns…</p>}
      {cols?.map((c) => (
        <button key={c.name} type="button" onClick={() => onInsert(c.name)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-panel-2" title="Insert the column name">
          <span className="truncate font-mono text-soft">{c.name}</span>
          <span className="ml-auto shrink-0 text-[10px] text-muted">{c.type}</span>
        </button>
      ))}
    </div>
  );
}

type Turn = { role: "user" | "assistant"; content: string; sql?: string };

function Assistant({ mode, sql, error, selected, onReplace, onAppend, onClose }: {
  mode: SqlMode;
  sql: string;
  error: string | null;
  selected: SqlResource | null;
  onReplace: (s: string) => void;
  onAppend: (s: string) => void;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setPrompt("");
    setTurns((t) => [...t, { role: "user", content: q }]);
    setBusy(true);
    try {
      const a = await sqlStudio.assist({ prompt: q, sql, mode, refs: selected ? [selected.ref] : [], history: turns.map((t) => ({ role: t.role, content: t.sql ? `${t.content}\n${t.sql}` : t.content })), error });
      setTurns((t) => [...t, { role: "assistant", content: a.explanation || (a.sql ? "Here is a query:" : "No answer."), sql: a.sql || undefined }]);
    } catch (e) {
      setTurns((t) => [...t, { role: "assistant", content: `AIP could not answer: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="hidden w-80 shrink-0 border-l border-line bg-panel lg:flex lg:flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-medium">
        <Icon name="sparkle" className="h-4 w-4 text-sand" />
        AIP assistant
        <button type="button" onClick={onClose} className="ml-auto text-muted hover:text-white" aria-label="Close assistant">
          <Icon name="x" className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {!turns.length && (
          <>
            <p className="text-xs leading-5 text-soft">Ask AIP to generate, explain, or debug SQL using the current query and resource schema.</p>
            <div className="space-y-2">
              {["Explain this query", error ? "Fix the error" : "Add a filter for this month", "Find performance improvements"].map((s) => (
                <button key={s} type="button" onClick={() => ask(s)} className="w-full rounded-md border border-line-2 p-2 text-left text-xs text-soft hover:bg-panel-2">
                  {s}
                </button>
              ))}
            </div>
          </>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`rounded-lg p-2.5 text-xs ${t.role === "user" ? "ml-6 bg-ocean/15 text-white" : "border border-line bg-panel-2 text-soft"}`}>
            <p className="whitespace-pre-wrap leading-5">{t.content}</p>
            {t.sql && (
              <>
                <pre className="mt-2 max-h-56 overflow-auto rounded bg-ink p-2 font-mono text-[11px] text-soft">{t.sql}</pre>
                <div className="mt-1.5 flex gap-2">
                  <button type="button" onClick={() => onReplace(t.sql!)} className="text-[11px] text-ocean hover:underline">
                    Replace editor
                  </button>
                  <button type="button" onClick={() => onAppend(t.sql!)} className="text-[11px] text-ocean hover:underline">
                    Append
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
        {busy && <p className="text-xs text-muted">Thinking…</p>}
      </div>
      <form
        className="flex gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask(prompt);
        }}
      >
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Ask AIP about this query…" className={`${inputClass} text-xs`} />
        <button type="submit" disabled={busy || !prompt.trim()} className={`${buttonClass.primary} shrink-0 px-2 py-1 text-xs`}>
          Ask
        </button>
      </form>
      <div className="border-t border-line p-3 text-[10px] text-muted">AIP has access to the editor and selected schema.</div>
    </aside>
  );
}

function OpenDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (w: Worksheet) => void }) {
  const [list, setList] = useState<Worksheet[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    sqlStudio.worksheets().then(setList, (e: Error) => setErr(e.message));
  }, []);
  return (
    <Modal title="Open worksheet" icon="folder" onClose={onClose}>
      <div className="max-h-[60vh] space-y-1 overflow-y-auto p-4 text-sm">
        {err && <p className="text-xs text-bad">{err}</p>}
        {!list && !err && <p className="text-xs text-muted">Loading…</p>}
        {list?.length === 0 && <p className="text-xs text-muted">No saved worksheets yet.</p>}
        {list?.map((w) => (
          <button key={w.id} type="button" onClick={() => onOpen(w)} className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-panel-2">
            <Icon name="code" className="h-4 w-4 text-ocean" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{w.name}</span>
              <span className="block truncate text-[10px] text-muted">{w.location === "project" ? w.path : "Private"} · {w.mode} mode · v{w.version_count}</span>
            </span>
            <span className="text-[10px] text-muted">{when(w.updated_at)}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function SaveDialog({ worksheet, onClose, onSave }: { worksheet: Worksheet | null; onClose: () => void; onSave: (name: string, folderId: string | null) => Promise<void> }) {
  const [name, setName] = useState(worksheet?.name ?? "Untitled worksheet");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [folder, setFolder] = useState<string>(worksheet?.location === "private" ? "" : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.drive.folder(null).then((f) => setProjects(f.items.filter((i) => i.kind === "project")), () => {});
  }, []);
  return (
    <Modal title={worksheet ? (worksheet.location === "private" ? "Save into a project" : "Save as a new worksheet") : "Save worksheet"} icon="save" onClose={onClose}>
      <form
        className="space-y-3 p-5 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await onSave(name.trim(), folder || null);
          } catch (ex) {
            setErr((ex as Error).message);
            setBusy(false);
          }
        }}
      >
        <label className="block text-xs text-muted">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} mt-1`} autoFocus />
        </label>
        <label className="block text-xs text-muted">
          Location
          <select value={folder} onChange={(e) => setFolder(e.target.value)} className={`${inputClass} mt-1`}>
            <option value="">Private (only you)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                Project · {p.name}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[11px] text-muted">A project worksheet is a resource in the project: people with access to the project can open it (and edit it as editors).</p>
        {err && <p className="text-xs text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim()} className={buttonClass.primary}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function HistoryDialog({ worksheet, onClose, onRestore }: { worksheet: Worksheet; onClose: () => void; onRestore: (version: string) => Promise<void> }) {
  const versions = worksheet.versions ?? [];
  const [open, setOpen] = useState<string | null>(versions[0]?.id ?? null);
  const v = versions.find((x) => x.id === open);
  return (
    <Modal title="Version history" icon="history" onClose={onClose} wide>
      <div className="flex max-h-[65vh] min-h-[300px]">
        <ul className="w-56 shrink-0 overflow-y-auto border-r border-line p-2 text-xs">
          {versions.map((x, i) => (
            <li key={x.id}>
              <button type="button" onClick={() => setOpen(x.id)} className={`w-full rounded px-2 py-1.5 text-left ${open === x.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}>
                v{versions.length - i} · {when(x.at)}
                <span className="block text-[10px] text-muted">{x.mode} mode</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex min-w-0 flex-1 flex-col p-3">
          <pre className="min-h-0 flex-1 overflow-auto rounded border border-line bg-ink p-3 font-mono text-xs text-soft">{v?.sql}</pre>
          {v && v.id !== versions[0]?.id && worksheet.can_edit && (
            <div className="mt-2 flex justify-end">
              <button type="button" onClick={() => onRestore(v.id)} className={buttonClass.primary}>
                Restore this version
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function PublishFunctionDialog({ worksheetId, defaultName, onClose }: { worksheetId: string; defaultName: string; onClose: () => void }) {
  const [name, setName] = useState(defaultName);
  const [apiName, setApiName] = useState(defaultName.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^./, (c) => c.toLowerCase()));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ version: string; output: string; function_id: string } | null>(null);
  const [current, setCurrent] = useState<{ api_name: string; version: string } | null>(null);
  useEffect(() => {
    sqlStudio.publishedFunction(worksheetId).then(
      (r) => {
        if (r.function) {
          setCurrent(r.function);
          setName(r.function.name);
          setApiName(r.function.api_name);
        }
      },
      () => {},
    );
  }, [worksheetId]);
  return (
    <Modal title="Publish function" icon="upload" onClose={onClose}>
      <div className="space-y-3 p-5 text-sm">
        {done ? (
          <>
            <p>
              Published version <span className="font-mono">{done.version}</span>, returning <span className="font-mono">{done.output}</span>. Use it in Workshop, Actions,
              Automate or through <span className="font-mono">/api/functions/queries/{apiName}/execute</span>.
            </p>
            <div className="flex justify-end gap-2">
              <a href={`/functions/${done.function_id}`} className={buttonClass.secondary}>
                Open in Functions
              </a>
              <button type="button" onClick={onClose} className={buttonClass.primary}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            {current && <p className="text-xs text-muted">Published as {current.api_name} {current.version}: publishing again releases a new version.</p>}
            <label className="block text-xs text-muted">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-muted">
              API name
              <input value={apiName} onChange={(e) => setApiName(e.target.value)} className={`${inputClass} mt-1 font-mono`} placeholder="animalsByType" />
            </label>
            <p className="text-[11px] text-muted">DECLARE variables become the inputs; their values are the defaults used when testing. The function is read-only.</p>
            {err && <p className="text-xs text-bad">{err}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className={buttonClass.secondary}>
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !name.trim() || !apiName.trim()}
                className={buttonClass.primary}
                onClick={async () => {
                  setBusy(true);
                  setErr(null);
                  try {
                    setDone(await sqlStudio.publishFunction(worksheetId, { name: name.trim(), api_name: apiName.trim() }));
                  } catch (e) {
                    setErr((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Publishing…" : "Publish"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
