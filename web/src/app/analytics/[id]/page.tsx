"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BoardEditor, BoardView, SourcePicker, SWITCHABLE, type Sources } from "@/components/contour/Boards";
import { EngineBadge, EngineSettingsField } from "@/components/contour/Engine";
import { Icon } from "@/components/Icon";
import { PresenceBar, type PresenceOther } from "@/components/Presence";
import { AppHeader, ErrorBox } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { alertDialog, confirmDialog, promptDialog } from "@/lib/dialogs";
import { copyForNotepad } from "@/lib/notepadClip";
import { when } from "@/lib/format";
import {
  BOARD_LABEL,
  contour,
  TRANSFORM_BOARDS,
  uid,
  VISUAL_BOARDS,
  type Analysis,
  type AnalysisView,
  type Board,
  type BoardType,
  type ContourParameter,
  type ContourPath,
  type DashItem,
  type PathResult,
} from "@/lib/contour";

const small = `${inputClass} py-1 text-xs`;
const DASH = "__dashboard";

export default function ContourAnalysis() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [view, setView] = useState<AnalysisView | null>(null);
  const [a, setA] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<string>("");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [results, setResults] = useState<Record<string, PathResult>>({});
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [sources, setSources] = useState<Sources>({ datasets: [], object_types: [] });
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // live co-editing: who else has it open; their saves load while this copy has no unsaved changes
  const [others, setOthers] = useState<PresenceOther[]>([]);
  const othersEditing = others.some((o) => o.editing);
  const loadedRev = a?.rev ?? 0;
  // the revision the next save builds on (updated by saves and reloads, also while a save is in flight)
  const rev = useRef(0);
  useEffect(() => {
    rev.current = loadedRev;
  }, [loadedRev]);
  useEffect(() => {
    if (!othersEditing || dirty || saving) return;
    const t = window.setInterval(() => {
      contour.get(id).then((v) => {
        if ((v.analysis.rev ?? 0) === loadedRev) return;
        setView(v);
        setA(v.analysis);
        setVersion((n) => n + 1);
      }, () => undefined);
    }, 5000);
    return () => window.clearInterval(t);
  }, [id, othersEditing, dirty, saving, loadedRev]);

  useEffect(() => {
    contour.get(id).then(
      (v) => {
        setView(v);
        setA(v.analysis);
        setTab(v.analysis.dashboard.tabs.some((t) => t.items.length) || !v.analysis.paths.length ? DASH : v.analysis.paths[0].id);
      },
      (e: Error) => setError(e.message),
    );
    contour.sources().then(setSources, () => undefined);
  }, [id]);

  // run the open path whenever it, the parameters or the saved analysis change
  useEffect(() => {
    if (!a || !tab || tab === DASH || !a.paths.some((p) => p.id === tab)) return;
    let stale = false;
    contour.run(id, tab, params).then(
      (r) => !stale && setResults((x) => ({ ...x, [tab]: r })),
      (e: Error) => !stale && setResults((x) => ({ ...x, [tab]: { source: { error: e.message }, boards: {} } })),
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, tab, params, version]);

  if (error && !a) return <ApiError message={error} />;
  if (!a || !view) return <Loading />;
  const canEdit = view.can_edit;

  /** Edit the analysis; it saves itself shortly after, then the open path runs again. */
  const change = (next: Analysis) => {
    setA(next);
    if (!canEdit) return;
    setDirty(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setSaving(true);
      contour.save(id, { ...next, rev: rev.current }).then(
        (v) => {
          setView(v);
          // the saved revision: the next save builds on it
          rev.current = v.analysis.rev ?? 0;
          setA((cur) => (cur ? { ...cur, rev: v.analysis.rev } : cur));
          setDirty(false);
          setSaving(false);
          setError(null);
          setVersion((n) => n + 1);
        },
        (e: Error) => {
          setSaving(false);
          if (e.message.includes("saved by someone else")) {
            // someone saved in between: take their version (this edit is dropped) and say so
            contour.get(id).then((v) => (setView(v), setA(v.analysis), setDirty(false), setVersion((n) => n + 1)), () => undefined);
            setNote(`${e.message}; your last change was not saved`);
            return;
          }
          setError(e.message);
        },
      );
    }, 700);
  };
  const setPath = (pid: string, p: Partial<ContourPath>) => change({ ...a, paths: a.paths.map((x) => (x.id === pid ? { ...x, ...p } : x)) });
  const path = a.paths.find((p) => p.id === tab);

  const addPath = (source?: ContourPath["source"]) => {
    const p: ContourPath = { id: uid(), name: `Path ${a.paths.length + 1}`, source: source ?? a.paths[0]?.source ?? { kind: "dataset", id: "" }, boards: [{ id: uid(), type: "table", config: {} }] };
    change({ ...a, paths: [...a.paths, p] });
    setTab(p.id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader app="Contour" icon="filter" href="/analytics" crumbs={[{ label: a.title }]}>
        <span className="ml-auto">
          <PresenceBar itemId={id} editing={canEdit} interval={5000} onOthers={setOthers} />
        </span>
        <span className="text-xs text-muted">{!canEdit ? "View only" : saving ? "Saving…" : dirty ? "Unsaved changes" : `Saved ${when(view.item.updated_at)}`}</span>
      </AppHeader>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-panel px-4 text-sm print:hidden">
        <TabButton active={tab === DASH} onClick={() => setTab(DASH)}><Icon name="grid" className="h-3.5 w-3.5" /> Dashboard</TabButton>
        {a.paths.map((p) => <TabButton key={p.id} active={tab === p.id} onClick={() => setTab(p.id)}>{p.name}</TabButton>)}
        {canEdit && <button type="button" onClick={() => addPath()} className="px-2 py-2 text-ocean hover:underline">+ Path</button>}
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 space-y-3 overflow-y-auto border-r border-line bg-panel p-3 text-xs print:hidden">
          {canEdit && (
            <input value={a.title} onChange={(e) => change({ ...a, title: e.target.value })} className={`${small} font-medium`} aria-label="Analysis title" />
          )}
          <Parameters a={a} id={id} canEdit={canEdit} values={params} setValues={setParams} onChange={(ps) => change({ ...a, parameters: ps })} sources={sources} />
          <label className="flex items-center gap-2 px-1 text-xs text-muted" title="Spark SQL: Contour's expression language (nvl, date_format, concat_ws, RLIKE, `backtick` columns), translated to DuckDB">
            Expressions in
            <select value={a.expression_dialect ?? "duckdb"} disabled={!canEdit} onChange={(e) => change({ ...a, expression_dialect: e.target.value as "spark" | "duckdb" })} className="rounded border border-line-2 bg-panel px-1.5 py-0.5">
              <option value="duckdb">DuckDB SQL</option>
              <option value="spark">Spark SQL (Contour)</option>
            </select>
          </label>
          <EngineSettingsField value={a.engine} disabled={!canEdit} onChange={(engine) => change({ ...a, engine })} />
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto p-5">
          <ErrorBox message={error} />
          {note && <p className="mb-3 rounded border border-ocean/40 bg-ocean/10 px-3 py-2 text-xs">{note}</p>}
          {tab === DASH ? (
            <Dashboard a={a} id={id} params={params} canEdit={canEdit} onChange={change} version={version} />
          ) : path ? (
            <PathView
              a={a}
              path={path}
              result={results[path.id]}
              canEdit={canEdit}
              sources={sources}
              open={open}
              setOpen={setOpen}
              onChange={(p) => setPath(path.id, p)}
              onDelete={() => {
                change({ ...a, paths: a.paths.filter((p) => p.id !== path.id), dashboard: { tabs: a.dashboard.tabs.map((t) => ({ ...t, items: t.items.filter((it) => it.kind !== "board" || it.path !== path.id) })) } });
                setTab(DASH);
              }}
              onBranch={() => addPath({ kind: "path", id: path.id })}
              onPin={(board) => change({ ...a, dashboard: { tabs: a.dashboard.tabs.map((t, i) => (i === 0 ? { ...t, items: [...t.items, { kind: "board", path: path.id, board, width: "half" }] } : t)) } })}
              actions={{
                saveDataset: async () => {
                  const name = await promptDialog("Dataset name", a.saved[path.id]?.name ?? `${a.title} - ${path.name}`);
                  if (!name) return;
                  try {
                    const s = await contour.saveDataset(id, path.id, name, params);
                    setA((x) => (x ? { ...x, saved: { ...x.saved, [path.id]: s } } : x));
                    setNote(`Saved ${s.rows} rows as the dataset "${s.name}".`);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                },
                build: async () => {
                  try {
                    const s = await contour.build(id, path.id);
                    setA((x) => (x ? { ...x, saved: { ...x.saved, [path.id]: s } } : x));
                    setNote(`Rebuilt "${s.name}" from the current inputs: ${s.rows} rows.`);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                },
                schedule: async (everyHours: number | null) => {
                  try {
                    const s = await contour.schedule(id, path.id, everyHours);
                    setA((x) => (x ? { ...x, saved: { ...x.saved, [path.id]: s } } : x));
                    setNote(everyHours ? `"${s.name}" now builds every ${everyHours} hour(s).` : `"${s.name}" builds by hand only.`);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                },
                sql: async () => {
                  try {
                    const s = await contour.sql(id, path.id, params);
                    const ask = s.single_source
                      ? "Create a pipeline that reads this path's dataset and runs the path as one SQL step (translated to SQLite, Pipeline Builder's SQL engine)?"
                      : `Create a pipeline with the ${s.inputs ?? ""} datasets this path reads as inputs, its joins and unions as join / union nodes and the boards between them as SQL steps (translated to SQLite, Pipeline Builder's SQL engine)?`;
                    if ((s.exportable ?? (s.single_source && s.source.kind !== "object_type")) && (await confirmDialog({ title: "Export to Pipeline Builder", message: ask, confirmLabel: "Create pipeline" }))) {
                      const made = await contour.toPipeline(id, path.id, params);
                      // what the export took from the data or wrote differently (a pivot's values, a union's column list)
                      if (made.notes?.length) await alertDialog({ title: "Exported to Pipeline Builder", message: made.notes.join("\n\n") });
                      router.push(`/pipeline/${made.item.id}`);
                      return;
                    }
                    await alertDialog({
                      title: "Path as SQL",
                      message: s.single_source
                        ? `Add a SQL transform on the path's input dataset in Pipeline Builder and paste this (the input reads as "input"):\n\n${s.sql}`
                        : `This path reads several inputs; this SQL shows its logic (CTEs per board):\n\n${s.sql}`,
                    });
                  } catch (e) {
                    setError((e as Error).message);
                  }
                },
              }}
              params={params}
              id={id}
            />
          ) : (
            <p className="text-sm text-muted">No path selected.</p>
          )}
        </main>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 ${active ? "border-ocean text-white" : "border-transparent text-muted hover:text-soft"}`}>
      {children}
    </button>
  );
}

function Parameters({ a, id, canEdit, values, setValues, onChange, sources }: {
  a: Analysis;
  id: string;
  canEdit: boolean;
  values: Record<string, unknown>;
  setValues: (v: Record<string, unknown>) => void;
  onChange: (p: ContourParameter[]) => void;
  sources: Sources;
}) {
  const [editing, setEditing] = useState(false);
  const [suggest, setSuggest] = useState<Record<string, unknown[]>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    for (const p of a.parameters) {
      if (!p.values?.length && !p.suggest?.column) continue;
      contour.suggestions(id, p.name).then((s) => setSuggest((x) => ({ ...x, [p.name]: s })), () => undefined);
    }
  }, [a.parameters, id]);
  const set = (i: number, p: Partial<ContourParameter>) => onChange(a.parameters.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const shown = (p: ContourParameter) => {
    const v = values[p.name] ?? p.default;
    return Array.isArray(v) ? v.join(", ") : v === undefined || v === null ? "" : String(v);
  };
  const apply = (p: ContourParameter, text: string) =>
    setValues({ ...values, [p.name]: p.multi ? text.split(",").map((s) => s.trim()).filter(Boolean) : text });
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-medium uppercase tracking-wide text-muted">Parameters</span>
        {canEdit && <button type="button" onClick={() => setEditing(!editing)} className="text-ocean hover:underline">{editing ? "Done" : "Edit"}</button>}
      </div>
      {!a.parameters.length && <p className="text-muted">Use $name in filters and expressions; viewers change values without editing the analysis.</p>}
      {!editing &&
        a.parameters.map((p) => (
          <label key={p.name} className="block">
            {p.name}
            {p.multi && <span className="text-muted"> (several, comma-separated)</span>}
            <input
              list={`sg-${p.name}`}
              type={p.type === "date" && !p.multi ? "date" : "text"}
              value={draft[p.name] ?? shown(p)}
              onChange={(e) => setDraft({ ...draft, [p.name]: e.target.value })}
              onBlur={(e) => {
                apply(p, e.target.value);
                setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== p.name)));
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              className={small}
            />
            <datalist id={`sg-${p.name}`}>{(suggest[p.name] ?? []).map((s) => <option key={String(s)} value={String(s)} />)}</datalist>
          </label>
        ))}
      {!editing && Object.keys(values).length > 0 && <button type="button" onClick={() => setValues({})} className="text-ocean hover:underline">Reset to defaults</button>}
      {editing && (
        <>
          {a.parameters.map((p, i) => (
            <div key={i} className="space-y-1 rounded border border-line p-2">
              <div className="flex gap-1">
                <input value={p.name} onChange={(e) => /^[A-Za-z0-9_]*$/.test(e.target.value) && set(i, { name: e.target.value })} className={`${small} font-mono`} aria-label="Name" />
                <button type="button" onClick={() => onChange(a.parameters.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Remove parameter"><Icon name="x" className="h-3.5 w-3.5" /></button>
              </div>
              <div className="flex gap-1">
                <select value={p.type} onChange={(e) => set(i, { type: e.target.value as ContourParameter["type"] })} className={small}>
                  <option value="string">String</option>
                  <option value="number">Number</option>
                  <option value="date">Date</option>
                </select>
                <label className="flex items-center gap-1"><input type="checkbox" checked={!!p.multi} onChange={(e) => set(i, { multi: e.target.checked })} />multi</label>
              </div>
              <input value={Array.isArray(p.default) ? p.default.join(", ") : String(p.default ?? "")} onChange={(e) => set(i, { default: p.multi ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean) : e.target.value || undefined })} placeholder="Default value" className={small} />
              <input value={(p.values ?? []).join(", ")} onChange={(e) => set(i, { values: e.target.value ? e.target.value.split(",").map((s) => s.trim()) : undefined })} placeholder="Suggested values (a, b, c)" className={small} />
              <SourcePicker value={p.suggest?.source} sources={sources} paths={a.paths} onChange={(s) => set(i, { suggest: { source: s, column: p.suggest?.column ?? "" } })} />
              {p.suggest && <input value={p.suggest.column} onChange={(e) => set(i, { suggest: { ...p.suggest!, column: e.target.value } })} placeholder="…values of column" className={small} />}
            </div>
          ))}
          <button type="button" onClick={() => onChange([...a.parameters, { name: `param${a.parameters.length + 1}`, type: "string" }])} className="text-ocean hover:underline">+ Parameter</button>
        </>
      )}
    </div>
  );
}

function PathView({ a, path, result, canEdit, sources, open, setOpen, onChange, onDelete, onBranch, onPin, actions, params, id }: {
  a: Analysis;
  path: ContourPath;
  result?: PathResult;
  canEdit: boolean;
  sources: Sources;
  open: string | null;
  setOpen: (b: string | null) => void;
  onChange: (p: Partial<ContourPath>) => void;
  onDelete: () => void;
  onBranch: () => void;
  onPin: (board: string) => void;
  actions: { saveDataset: () => void; build: () => void; sql: () => void; schedule: (everyHours: number | null) => void };
  params: Record<string, unknown>;
  id: string;
}) {
  const boards = path.boards;
  const setBoard = (bid: string, p: Partial<Board>) => onChange({ boards: boards.map((b) => (b.id === bid ? { ...b, ...p } : b)) });
  const add = (at: number, type: BoardType) => {
    const b: Board = { id: uid(), type, config: {} };
    onChange({ boards: [...boards.slice(0, at), b, ...boards.slice(at)] });
    setOpen(b.id);
  };
  const move = (i: number, d: number) => {
    const next = [...boards];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange({ boards: next });
  };
  const saved = a.saved[path.id];
  return (
    <div className="mx-auto max-w-5xl space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-3 text-xs">
        {canEdit ? <input value={path.name} onChange={(e) => onChange({ name: e.target.value })} className={`${small} w-48 font-medium`} aria-label="Path name" /> : <span className="font-medium">{path.name}</span>}
        <span className="text-muted">starts from</span>
        <div className="w-64">{canEdit ? <SourcePicker value={path.source} sources={sources} paths={a.paths} self={path.id} onChange={(s) => onChange({ source: s })} /> : <span>{path.source.kind}</span>}</div>
        <span className="text-muted">{result?.source.rows !== undefined ? `${result.source.rows.toLocaleString()} rows` : ""}</span>
        <EngineBadge report={result?.engine} />
        <div className="ml-auto flex flex-wrap gap-1">
          {canEdit && <button type="button" onClick={actions.saveDataset} className={buttonClass.secondary}><Icon name="save" className="h-3.5 w-3.5" /> Save as dataset</button>}
          {canEdit && saved && <button type="button" onClick={actions.build} className={buttonClass.secondary} title={`Built ${when(saved.built_at)}`}><Icon name="refresh" className="h-3.5 w-3.5" /> Build</button>}
          <button type="button" onClick={actions.sql} className={buttonClass.ghost}><Icon name="code" className="h-3.5 w-3.5" /> SQL</button>
          {canEdit && <button type="button" onClick={onBranch} className={buttonClass.ghost} title="A new path starting from this path's result"><Icon name="split" className="h-3.5 w-3.5" /> Branch</button>}
          {canEdit && <button type="button" onClick={onDelete} className={buttonClass.ghost} aria-label="Delete path"><Icon name="trash" className="h-3.5 w-3.5" /></button>}
        </div>
        {saved && (
          <div className="flex w-full flex-wrap items-center gap-2 text-muted">
            <span>
              Saved as <Link href={`/datasets/${saved.dataset_id}`} className="text-ocean hover:underline">{saved.name}</Link> · {saved.rows} rows · built {when(saved.built_at)}
            </span>
            {saved.last_status === "failed" && <span className="text-bad" title={saved.last_error ?? ""}>last scheduled build failed</span>}
            {canEdit && (
              <label className="ml-auto flex items-center gap-1">
                Build
                <select
                  value={saved.schedule?.every_hours ?? ""}
                  onChange={(e) => actions.schedule(e.target.value ? Number(e.target.value) : null)}
                  className={`${small} w-36`}
                  title="Scheduled builds run as you; your access is checked each time"
                >
                  <option value="">by hand</option>
                  <option value="1">every hour</option>
                  <option value="6">every 6 hours</option>
                  <option value="24">every day</option>
                  <option value="168">every week</option>
                </select>
              </label>
            )}
            {saved.schedule && <span>next {when(saved.schedule.next_at)}</span>}
          </div>
        )}
      </div>
      {result?.source.error && <p className="rounded border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{result.source.error}</p>}
      {boards.map((b, i) => {
        const r = result?.boards[b.id];
        const cols = (i === 0 ? result?.source.columns : result?.boards[boards[i - 1].id]?.columns) ?? [];
        const visual = (VISUAL_BOARDS as readonly string[]).includes(b.type);
        return (
          <div key={b.id}>
            {canEdit && <AddBoard onAdd={(t) => add(i, t)} />}
            <div className="rounded-lg border border-line bg-panel">
              <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs">
                <span className="rounded bg-ocean/15 px-1.5 py-0.5 text-ocean">{BOARD_LABEL[b.type]}</span>
                {canEdit ? <input value={b.title ?? ""} onChange={(e) => setBoard(b.id, { title: e.target.value || undefined })} placeholder="Title" className="min-w-0 flex-1 bg-transparent outline-none" /> : <span className="flex-1">{b.title}</span>}
                {r?.rows !== undefined && <span className="text-muted">{r.rows.toLocaleString()} rows after</span>}
                {visual && SWITCHABLE.includes(b.type) && canEdit && (
                  <label className="flex items-center gap-1 text-muted" title="Continue the path with this board's aggregated result instead of the rows">
                    <input type="checkbox" checked={!!b.config.switch} onChange={(e) => setBoard(b.id, { config: { ...b.config, switch: e.target.checked } })} />switch to result
                  </label>
                )}
                {visual && <a href={contour.csvUrl(id, path.id, b.id, params)} className="text-muted hover:text-white" title="Export CSV (100,000 rows)"><Icon name="download" className="h-3.5 w-3.5" /></a>}
                {visual && canEdit && <button type="button" onClick={() => onPin(b.id)} className="text-muted hover:text-white" title="Add to dashboard"><Icon name="grid" className="h-3.5 w-3.5" /></button>}
                {visual && (
                  <button
                    type="button"
                    onClick={() => copyForNotepad("contour_chart", { analysis_id: id, path_id: path.id, board_id: b.id, params: {} }, `${b.title || b.type} (Contour)`) && void alertDialog("Copied: in a Notepad document, Insert → Paste copied widget.")}
                    className="text-muted hover:text-white"
                    title="Copy for Notepad"
                  >
                    <Icon name="copy" className="h-3.5 w-3.5" />
                  </button>
                )}
                {canEdit && (
                  <>
                    <button type="button" onClick={() => setOpen(open === b.id ? null : b.id)} className="text-muted hover:text-white" aria-label="Settings"><Icon name="sliders" className="h-3.5 w-3.5" /></button>
                    <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="text-muted hover:text-white disabled:opacity-30" aria-label="Move up"><Icon name="left" className="h-3.5 w-3.5 rotate-90" /></button>
                    <button type="button" disabled={i === boards.length - 1} onClick={() => move(i, 1)} className="text-muted hover:text-white disabled:opacity-30" aria-label="Move down"><Icon name="down" className="h-3.5 w-3.5" /></button>
                    <button type="button" onClick={() => onChange({ boards: boards.filter((x) => x.id !== b.id) })} className="text-muted hover:text-bad" aria-label="Delete board"><Icon name="trash" className="h-3.5 w-3.5" /></button>
                  </>
                )}
              </div>
              {canEdit && open === b.id && (
                <div className="border-b border-line bg-panel-2/50 p-3 text-xs">
                  <BoardEditor b={b} cols={cols} a={a} sources={sources} path={path} onChange={(c) => setBoard(b.id, { config: c })} />
                </div>
              )}
              {(visual || r?.error) && (
                <div className="p-3">
                  <BoardView
                    b={b}
                    r={r}
                    onSelect={canEdit ? (k) => setBoard(b.id, { selection: k === null ? null : (b.selection ?? []).includes(k) ? (b.selection ?? []).filter((x) => x !== k) : [...(b.selection ?? []), k] }) : undefined}
                    onSelection={canEdit ? (s) => setBoard(b.id, { selection: s }) : undefined}
                  />
                </div>
              )}
            </div>
          </div>
        );
      })}
      {canEdit && <AddBoard onAdd={(t) => add(boards.length, t)} last />}
    </div>
  );
}

function AddBoard({ onAdd, last }: { onAdd: (t: BoardType) => void; last?: boolean }) {
  return (
    <div className={`flex justify-center ${last ? "py-2" : "py-1"}`}>
      <select value="" onChange={(e) => e.target.value && onAdd(e.target.value as BoardType)} className={`${small} w-44 ${last ? "" : "opacity-60 hover:opacity-100"}`} aria-label="Add a board">
        <option value="">+ Add board…</option>
        <optgroup label="Transform">{TRANSFORM_BOARDS.map((t) => <option key={t} value={t}>{BOARD_LABEL[t]}</option>)}</optgroup>
        <optgroup label="Visualize">{VISUAL_BOARDS.map((t) => <option key={t} value={t}>{BOARD_LABEL[t]}</option>)}</optgroup>
      </select>
    </div>
  );
}

function Dashboard({ a, id, params, canEdit, onChange, version }: { a: Analysis; id: string; params: Record<string, unknown>; canEdit: boolean; onChange: (a: Analysis) => void; version: number }) {
  const [tabId, setTabId] = useState(a.dashboard.tabs[0]?.id);
  const [selections, setSelections] = useState<Record<string, unknown[]>>({});
  const [data, setData] = useState<Record<string, PathResult> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let stale = false;
    contour.dashboard(id, params, selections).then(
      (r) => !stale && setData(r.paths),
      (e: Error) => !stale && setErr(e.message),
    );
    return () => {
      stale = true;
    };
  }, [id, params, selections, version]);
  const t = a.dashboard.tabs.find((x) => x.id === tabId) ?? a.dashboard.tabs[0];
  const setTab = (p: Partial<{ name: string; items: DashItem[] }>) => onChange({ ...a, dashboard: { tabs: a.dashboard.tabs.map((x) => (x.id === t.id ? { ...x, ...p } : x)) } });
  const subst = (s: string) => s.replace(/\$([A-Za-z_]\w*)/g, (m, n) => {
    const p = a.parameters.find((x) => x.name === n);
    if (!p) return m;
    const v = params[n] ?? p.default;
    return Array.isArray(v) ? v.join(", ") : String(v ?? "");
  });
  const visuals = a.paths.flatMap((p) => p.boards.filter((b) => (VISUAL_BOARDS as readonly string[]).includes(b.type)).map((b) => ({ p, b })));
  return (
    <div className="mx-auto max-w-6xl space-y-3">
      <div className="flex flex-wrap items-center gap-1 text-sm print:hidden">
        {a.dashboard.tabs.map((x) => <TabButton key={x.id} active={x.id === t?.id} onClick={() => setTabId(x.id)}>{x.name}</TabButton>)}
        {canEdit && editing && (
          <button type="button" onClick={() => { const nt = { id: uid(), name: `Tab ${a.dashboard.tabs.length + 1}`, items: [] }; onChange({ ...a, dashboard: { tabs: [...a.dashboard.tabs, nt] } }); setTabId(nt.id); }} className="px-2 text-xs text-ocean hover:underline">+ Tab</button>
        )}
        <div className="ml-auto flex gap-1">
          {Object.keys(selections).length > 0 && <button type="button" onClick={() => setSelections({})} className={buttonClass.ghost}>Clear selections</button>}
          <button type="button" onClick={() => window.print()} className={buttonClass.ghost}><Icon name="download" className="h-3.5 w-3.5" /> PDF</button>
          {canEdit && <button type="button" onClick={() => setEditing(!editing)} className={buttonClass.secondary}><Icon name="edit" className="h-3.5 w-3.5" /> {editing ? "Done" : "Edit dashboard"}</button>}
        </div>
      </div>
      {editing && t && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-3 text-xs print:hidden">
          <input value={t.name} onChange={(e) => setTab({ name: e.target.value })} className={`${small} w-40`} aria-label="Tab name" />
          <select value="" onChange={(e) => { const [path, board] = e.target.value.split("/"); if (path) setTab({ items: [...t.items, { kind: "board", path, board, width: "half" }] }); }} className={`${small} w-64`}>
            <option value="">+ Add a board…</option>
            {visuals.map(({ p, b }) => <option key={b.id} value={`${p.id}/${b.id}`}>{p.name} · {b.title || BOARD_LABEL[b.type]}</option>)}
          </select>
          <button type="button" onClick={() => setTab({ items: [...t.items, { kind: "text", text: "Notes with $parameter values.", width: "full" }] })} className="text-ocean hover:underline">+ Text</button>
          {a.dashboard.tabs.length > 1 && <button type="button" onClick={() => onChange({ ...a, dashboard: { tabs: a.dashboard.tabs.filter((x) => x.id !== t.id) } })} className="ml-auto text-bad hover:underline">Delete tab</button>}
        </div>
      )}
      {err && <ErrorBox message={err} />}
      {t && !t.items.length && <p className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-muted">{canEdit ? "Add boards from paths with “Edit dashboard” or the grid button on a board." : "This dashboard is empty."}</p>}
      <div className="grid grid-cols-2 gap-3">
        {t?.items.map((it, i) => {
          const span = it.width === "half" ? "col-span-2 md:col-span-1" : "col-span-2";
          const controls = editing && (
            <div className="flex gap-1 text-muted">
              <button type="button" onClick={() => setTab({ items: t.items.map((x, j) => (j === i ? { ...x, width: x.width === "half" ? "full" : "half" } : x)) })} className="hover:text-white" title="Width"><Icon name="fit" className="h-3.5 w-3.5" /></button>
              <button type="button" disabled={i === 0} onClick={() => { const n = [...t.items]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setTab({ items: n }); }} className="hover:text-white disabled:opacity-30" aria-label="Move earlier"><Icon name="left" className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={() => setTab({ items: t.items.filter((_, j) => j !== i) })} className="hover:text-bad" aria-label="Remove"><Icon name="x" className="h-3.5 w-3.5" /></button>
            </div>
          );
          if (it.kind === "text")
            return (
              <div key={i} className={`${span} rounded-lg border border-line bg-panel p-3 text-sm`}>
                <div className="flex justify-end">{controls}</div>
                {editing ? <textarea rows={3} value={it.text} onChange={(e) => setTab({ items: t.items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} className={small} /> : <p className="whitespace-pre-wrap">{subst(it.text)}</p>}
              </div>
            );
          const p = a.paths.find((x) => x.id === it.path);
          const b = p?.boards.find((x) => x.id === it.board);
          if (!p || !b) return <div key={i} className={`${span} rounded-lg border border-line p-3 text-xs text-muted`}>This board was removed. {controls}</div>;
          const shown = { ...b, selection: selections[b.id] ?? b.selection };
          return (
            <div key={i} className={`${span} break-inside-avoid rounded-lg border border-line bg-panel p-3`}>
              <div className="mb-2 flex items-center gap-2 text-xs">
                <span className="font-medium">{b.title || BOARD_LABEL[b.type]}</span>
                <span className="text-muted">{p.name}</span>
                <span className="ml-auto">{controls}</span>
              </div>
              <BoardView
                b={shown}
                r={data?.[p.id]?.boards[b.id] ?? (data ? { error: "Not computed: an earlier board failed." } : undefined)}
                onSelect={(k) =>
                  setSelections((s) => {
                    const cur = s[b.id] ?? (b.selection as unknown[] | undefined) ?? [];
                    const next = k === null ? [] : cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
                    return { ...s, [b.id]: next };
                  })
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
