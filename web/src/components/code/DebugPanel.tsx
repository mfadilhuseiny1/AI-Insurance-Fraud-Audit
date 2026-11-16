"use client";

/** Code Repositories debugger and console (api/code_debug.py): breakpoints in the editor gutter, a transform run in
 * preview under a debugger (call stack, variables with DataFrames as tables, watch expressions, a console in the paused frame,
 * step over / into / out, continue, pause, stop), and a Python console with the transform's inputs preloaded. */

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Icon, type IconName } from "@/components/Icon";
import {
  codeDebug,
  type DebugAction,
  type DebugBreakpoint,
  type DebugEval,
  type DebugSession,
  type DebugValue,
} from "@/lib/codeRepos";
import { promptDialog } from "@/lib/dialogs";
import type { EditorBreakpoint } from "./CodeEditor";

type Entry = {
  key: number;
  code: string;
  id?: string;
  result?: DebugEval;
  pending: boolean;
  error?: string;
};
type BpMap = Record<string, EditorBreakpoint[]>;

const OUTPUT_KEEP = 200_000;
const storeKey = (repoId: string) => `code-debug-breakpoints:${repoId}`;

function loadBps(repoId: string): BpMap {
  try {
    const raw = window.localStorage.getItem(storeKey(repoId));
    const parsed = raw ? (JSON.parse(raw) as BpMap) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveBps(repoId: string, bps: BpMap) {
  try {
    window.localStorage.setItem(storeKey(repoId), JSON.stringify(bps));
  } catch {}
}

const watchKey = (repoId: string) => `code-debug-watches:${repoId}`;
function loadWatches(repoId: string): string[] {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(watchKey(repoId)) ?? "[]",
    ) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}
function saveWatches(repoId: string, w: string[]) {
  try {
    window.localStorage.setItem(watchKey(repoId), JSON.stringify(w));
  } catch {}
}

const flatten = (bps: BpMap): DebugBreakpoint[] =>
  Object.entries(bps).flatMap(([file, list]) =>
    list.map((b) => ({ file, line: b.line, condition: b.condition || null })),
  );

const isLive = (s: DebugSession | null) =>
  !!s && s.alive && !["finished", "error", "stopped"].includes(s.status);

/** Debugger state for a repository branch: breakpoints (kept in this browser), the session, console history.
 * onPaused is called with the file the debugger stopped in (to open it in the editor). */
export function useDebugger(
  repoId: string,
  branch: string,
  onPaused?: (file: string, line: number) => void,
) {
  const [bps, setBps] = useState<BpMap>(() =>
    typeof window === "undefined" ? {} : loadBps(repoId),
  );
  const [watches, setWatchList] = useState<string[]>(() =>
    typeof window === "undefined" ? [] : loadWatches(repoId),
  );
  const [session, setSession] = useState<DebugSession | null>(null);
  const [output, setOutput] = useState("");
  const outEnd = useRef(0);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [starting, setStarting] = useState<null | "debug" | "console">(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const sessionRef = useRef<DebugSession | null>(null);
  const pausedRef = useRef<typeof onPaused>(undefined);
  useEffect(() => {
    pausedRef.current = onPaused;
  });

  const apply = useCallback((st: DebugSession) => {
    // answers can arrive out of order (a watch list answered after a later one): never go back to an older state
    const cur = sessionRef.current;
    if (cur && cur.id === st.id && st.version < cur.version) return;
    // output arrives as slices from an offset: append, or replace when older output was dropped
    // (a state without output — eval / frame answers — leaves the output as it is)
    const have = outEnd.current;
    if (st.output_from > have && st.output) {
      const text = st.output;
      setOutput((o) =>
        (have === 0 ? text : `${o}\n[…]\n${text}`).slice(-OUTPUT_KEEP),
      );
      outEnd.current = st.output_end;
    } else if (st.output_from <= have && st.output_end > have) {
      const add = st.output.slice(have - st.output_from);
      setOutput((o) => (o + add).slice(-OUTPUT_KEEP));
      outEnd.current = st.output_end;
    }
    setEntries((list) =>
      list.some((e) => e.pending && e.id && st.evals[e.id])
        ? list.map((e) =>
            e.pending && e.id && st.evals[e.id]
              ? { ...e, pending: false, result: st.evals[e.id] }
              : e,
          )
        : list,
    );
    const prev = sessionRef.current;
    const at =
      st.status === "paused" && st.paused
        ? st.paused.stack[st.paused.frame]
        : null;
    const before =
      prev?.status === "paused" && prev.paused
        ? prev.paused.stack[prev.paused.frame]
        : null;
    if (at && (!before || before.file !== at.file || before.line !== at.line))
      pausedRef.current?.(at.file, at.line);
    setSession(st);
    sessionRef.current = st;
    setTick((t) => t + 1);
  }, []);

  // long-poll while the transform runs (or a console command is still running)
  const sid = session?.id;
  const version = session?.version;
  const active =
    !!session &&
    session.alive &&
    (session.status === "starting" ||
      session.status === "running" ||
      session.busy ||
      // watch values still on their way (each may take up to 3 s)
      (session.status === "paused" &&
        (session.watches ?? []).some((w) => w.ok === null)));
  useEffect(() => {
    if (!sid || !active) return;
    let cancelled = false;
    codeDebug
      .state(repoId, sid, { version, wait: 10, outputFrom: outEnd.current })
      .then((st) => !cancelled && apply(st))
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setSession((s) =>
          s
            ? {
                ...s,
                alive: false,
                status:
                  s.status === "starting" || s.status === "running"
                    ? "stopped"
                    : s.status,
              }
            : s,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, sid, version, active, tick, apply]);

  // a session ends with the page (or the branch)
  useEffect(
    () => () => {
      const s = sessionRef.current;
      if (s && isLive(s)) codeDebug.stop(repoId, s.id).catch(() => {});
    },
    [repoId],
  );

  const updateBps = (next: BpMap) => {
    setBps(next);
    saveBps(repoId, next);
    const s = sessionRef.current;
    if (s && isLive(s) && s.mode === "debug")
      codeDebug
        .setBreakpoints(repoId, s.id, flatten(next))
        .then(apply)
        .catch(() => {});
  };
  const toggle = (file: string, line: number) => {
    const list = bps[file] ?? [];
    const next = list.some((b) => b.line === line)
      ? list.filter((b) => b.line !== line)
      : [...list, { line }].sort((a, b) => a.line - b.line);
    updateBps({ ...bps, [file]: next });
  };
  const editCondition = async (file: string, line: number) => {
    const cur = (bps[file] ?? []).find((b) => b.line === line);
    const cond = await promptDialog(
      `Condition for the breakpoint at line ${line} (a Python expression; empty = always stop)`,
      cur?.condition ?? "",
      {
        title: "Conditional breakpoint",
        placeholder: "len(df) > 0",
      },
    );
    if (cond === null) return;
    const rest = (bps[file] ?? []).filter((b) => b.line !== line);
    updateBps({
      ...bps,
      [file]: [...rest, { line, condition: cond.trim() || null }].sort(
        (a, b) => a.line - b.line,
      ),
    });
  };
  const removeBp = (file: string, line: number) =>
    updateBps({
      ...bps,
      [file]: (bps[file] ?? []).filter((b) => b.line !== line),
    });
  const clearBps = () => updateBps({});

  const updateWatches = (next: string[]) => {
    setWatchList(next);
    saveWatches(repoId, next);
    const s = sessionRef.current;
    if (s && isLive(s) && s.mode === "debug")
      codeDebug
        .setWatches(repoId, s.id, next)
        .then(apply)
        .catch((e: Error) => setError(e.message));
  };
  const addWatch = (expr: string) => {
    const e = expr.trim();
    if (e && !watches.includes(e)) updateWatches([...watches, e]);
  };
  const removeWatch = (i: number) =>
    updateWatches(watches.filter((_, j) => j !== i));
  const editWatch = (i: number, expr: string) => {
    const e = expr.trim();
    if (!e) removeWatch(i);
    else updateWatches(watches.map((w, j) => (j === i ? e : w)));
  };
  /** each watch expression with its value from the session (when it has evaluated it) */
  const watchValues = watches.map(
    (expr) =>
      session?.watches?.find((w) => w.expr === expr) ?? {
        expr,
        ok: null,
      },
  );

  /** the editor's breakpoints for a file, with the debugger's verdict (verified / why not) when a session has one */
  const forFile = (file: string): EditorBreakpoint[] =>
    (bps[file] ?? []).map((b) => {
      const v = session?.breakpoints.find(
        (x) => x.file === file && x.line === b.line,
      );
      return v && v.verified !== null && v.verified !== undefined
        ? { ...b, verified: v.verified, message: v.message }
        : b;
    });

  const start = async (mode: "debug" | "console", transform: string) => {
    setStarting(mode);
    setError(null);
    try {
      const old = sessionRef.current;
      if (old && isLive(old))
        await codeDebug.stop(repoId, old.id).catch(() => {});
      outEnd.current = 0;
      setOutput("");
      setEntries([]);
      setSession(null);
      sessionRef.current = null;
      apply(
        await codeDebug.start(repoId, {
          branch,
          transform,
          mode,
          breakpoints: flatten(bps),
          watches,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(null);
    }
  };
  const command = async (action: DebugAction) => {
    const s = sessionRef.current;
    if (!s) return;
    setError(null);
    try {
      apply(await codeDebug.command(repoId, s.id, action));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const evaluate = async (code: string) => {
    const s = sessionRef.current;
    if (!s || !code.trim()) return;
    const key = ++seq.current;
    setEntries((list) => [...list, { key, code, pending: true }]);
    try {
      const r = await codeDebug.evaluate(
        repoId,
        s.id,
        code,
        s.paused?.frame ?? 0,
      );
      setEntries((list) =>
        list.map((e) =>
          e.key === key
            ? {
                ...e,
                id: r.id,
                pending: r.pending,
                result: r.result ?? undefined,
              }
            : e,
        ),
      );
      apply(r.state);
    } catch (e) {
      setEntries((list) =>
        list.map((x) =>
          x.key === key
            ? { ...x, pending: false, error: (e as Error).message }
            : x,
        ),
      );
    }
  };
  const selectFrame = async (i: number) => {
    const s = sessionRef.current;
    if (!s) return;
    try {
      apply(await codeDebug.frame(repoId, s.id, i));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const pausedAt =
    session?.status === "paused" && session.paused
      ? (session.paused.stack[session.paused.frame] ?? null)
      : null;
  return {
    session,
    output,
    entries,
    starting,
    error,
    breakpoints: bps,
    pausedAt,
    forFile,
    toggle,
    editCondition,
    removeBp,
    clearBps,
    watches: watchValues,
    addWatch,
    removeWatch,
    editWatch,
    start,
    command,
    evaluate,
    selectFrame,
    clearConsole: () => setEntries([]),
  };
}

export type Debugger = ReturnType<typeof useDebugger>;

/* ------------------------------------------------------------------------------------------- */

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** A DataFrame / Series as a small table: index, columns with dtypes, first rows. */
export function ValueTable({ value }: { value: DebugValue }) {
  if (!value.columns || !value.rows) return null;
  const total = value.kind === "series" ? value.length : value.shape?.[0];
  return (
    <div className="my-1 max-w-full overflow-auto rounded border border-line">
      <table className="min-w-full font-mono text-[11px]">
        <thead className="sticky top-0 bg-panel-2">
          <tr>
            <th className="border-b border-line px-2 py-1 text-left font-normal text-muted" />
            {value.columns.map((c, i) => (
              <th
                key={i}
                className="whitespace-nowrap border-b border-line px-2 py-1 text-left font-medium text-soft"
              >
                {c.name}
                <span className="ml-1 font-normal text-muted">{c.type}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {value.rows.map((r, i) => (
            <tr key={i} className="odd:bg-ink/40">
              <td className="whitespace-nowrap px-2 py-0.5 text-muted">
                {fmtCell(value.index?.[i])}
              </td>
              {r.map((c, j) => (
                <td
                  key={j}
                  className={`max-w-[18rem] truncate whitespace-nowrap px-2 py-0.5 ${c === null ? "text-muted" : "text-soft"}`}
                  title={fmtCell(c)}
                >
                  {fmtCell(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-line px-2 py-0.5 text-[10px] text-muted">
        {value.rows.length < (total ?? 0)
          ? `first ${value.rows.length} of ${(total ?? 0).toLocaleString()} rows`
          : `${(total ?? 0).toLocaleString()} rows`}
        {value.kind === "dataframe" && value.shape
          ? ` · ${value.shape[1]} columns`
          : ""}
        {value.truncated_columns ? " (first 50 shown)" : ""}
        {value.note ? ` · ${value.note}` : ""}
      </div>
    </div>
  );
}

function summary(v: DebugValue): string {
  if (v.kind === "dataframe") return v.repr;
  if (v.kind === "series") return v.repr;
  if (v.kind === "array")
    return `shape ${JSON.stringify(v.shape)} · ${v.dtype} — ${v.repr}`;
  if (v.kind === "dict" || v.kind === "sequence")
    return `${v.length} item${v.length === 1 ? "" : "s"} — ${v.repr}`;
  return v.repr;
}

function Variables({
  vars,
  empty,
}: {
  vars: (DebugValue & { name: string })[];
  empty: string;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (!vars.length) return <p className="p-2 text-muted">{empty}</p>;
  return (
    <table className="w-full table-fixed">
      <thead className="sticky top-0 z-10 bg-panel text-left text-[10px] uppercase tracking-wide text-muted">
        <tr>
          <th className="w-[28%] px-2 py-1 font-medium">Name</th>
          <th className="w-[18%] px-2 py-1 font-medium">Type</th>
          <th className="px-2 py-1 font-medium">Value</th>
        </tr>
      </thead>
      <tbody>
        {vars.map((v) => {
          const table = !!v.rows && !!v.columns;
          const isOpen = open.has(v.name);
          return (
            <Fragment key={v.name}>
              <tr
                className={`border-t border-line/60 align-top ${table ? "cursor-pointer hover:bg-panel-2" : ""}`}
                onClick={() => {
                  if (!table) return;
                  const s = new Set(open);
                  if (s.has(v.name)) s.delete(v.name);
                  else s.add(v.name);
                  setOpen(s);
                }}
              >
                <td
                  className="truncate px-2 py-1 font-mono text-white"
                  title={v.name}
                >
                  {table && (
                    <Icon
                      name={isOpen ? "down" : "right"}
                      className="mr-1 inline h-3 w-3 text-muted"
                    />
                  )}
                  {v.name}
                </td>
                <td className="truncate px-2 py-1 text-muted" title={v.type}>
                  {v.type}
                </td>
                <td
                  className="truncate px-2 py-1 font-mono text-soft"
                  title={v.repr}
                >
                  {summary(v)}
                </td>
              </tr>
              {table && isOpen && (
                <tr>
                  <td colSpan={3} className="px-2 pb-2">
                    <ValueTable value={v} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/** Watch expressions: evaluated in the selected frame at every pause (kept in this browser, per repository). */
function Watches({ dbg, paused }: { dbg: Debugger; paused: boolean }) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const commitEdit = () => {
    if (editing !== null) dbg.editWatch(editing, editText);
    setEditing(null);
  };
  return (
    <div className="shrink-0 border-b border-line" data-debug-watches>
      <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted">
        Watch
      </div>
      {dbg.watches.map((w, i) => {
        const v = w.ok ? w.value : null;
        const table = !!v?.rows && !!v?.columns;
        const isOpen = open.has(w.expr);
        return (
          <div key={`${i}:${w.expr}`} data-watch={w.expr} className="group">
            <div
              className={`flex items-start gap-2 px-2 py-0.5 hover:bg-panel-2 ${table ? "cursor-pointer" : ""}`}
              onClick={() => {
                if (!table) return;
                const s = new Set(open);
                if (s.has(w.expr)) s.delete(w.expr);
                else s.add(w.expr);
                setOpen(s);
              }}
            >
              {editing === i ? (
                <input
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitEdit();
                    else if (e.key === "Escape") setEditing(null);
                  }}
                  className="w-[28%] shrink-0 rounded border border-line-2 bg-ink px-1 font-mono text-white outline-none focus:border-ocean"
                />
              ) : (
                <span
                  className="w-[28%] shrink-0 truncate font-mono text-white"
                  title={`${w.expr} (double-click to edit)`}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditing(i);
                    setEditText(w.expr);
                  }}
                >
                  {table && (
                    <Icon
                      name={isOpen ? "down" : "right"}
                      className="mr-1 inline h-3 w-3 text-muted"
                    />
                  )}
                  {w.expr}
                </span>
              )}
              <span
                data-watch-value
                className={`min-w-0 flex-1 truncate font-mono ${w.ok === false ? "text-bad" : w.ok ? "text-soft" : "text-muted"}`}
                title={
                  w.ok === false
                    ? (w.error ?? "")
                    : v
                      ? `${v.type}: ${v.repr}`
                      : "evaluated when the transform pauses"
                }
              >
                {w.ok === false ? w.error : v ? summary(v) : paused ? "…" : "—"}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  dbg.removeWatch(i);
                }}
                className="text-muted opacity-0 hover:text-bad group-hover:opacity-100"
                title="Remove the watch"
                data-watch-remove
              >
                <Icon name="x" className="h-3 w-3" />
              </button>
            </div>
            {table && isOpen && v && (
              <div className="px-2 pb-1">
                <ValueTable value={v} />
              </div>
            )}
          </div>
        );
      })}
      <div className="px-2 pb-1.5 pt-0.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              dbg.addWatch(draft);
              setDraft("");
            }
          }}
          spellCheck={false}
          placeholder="Add an expression to watch (Enter)"
          aria-label="Add a watch expression"
          className="w-full rounded border border-line-2 bg-ink px-2 py-0.5 font-mono text-[11px] text-white outline-none focus:border-ocean"
        />
      </div>
    </div>
  );
}

function EntryView({ e }: { e: Entry }) {
  const r = e.result;
  return (
    <div className="border-b border-line/50 py-1.5">
      <pre className="whitespace-pre-wrap font-mono text-ocean">
        {e.code
          .split("\n")
          .map((l, i) => `${i ? "... " : ">>> "}${l}`)
          .join("\n")}
      </pre>
      {e.pending && (
        <div className="mt-0.5 text-muted">running… (Interrupt stops it)</div>
      )}
      {e.error && (
        <pre className="mt-0.5 whitespace-pre-wrap text-bad">{e.error}</pre>
      )}
      {r?.output && (
        <pre className="mt-0.5 whitespace-pre-wrap font-mono text-soft">
          {r.output}
        </pre>
      )}
      {r && !r.ok && r.error && (
        <pre className="mt-0.5 whitespace-pre-wrap font-mono text-bad">
          {r.error}
        </pre>
      )}
      {r?.ok &&
        r.value &&
        (r.value.rows && r.value.columns ? (
          <ValueTable value={r.value} />
        ) : (
          <pre className="mt-0.5 whitespace-pre-wrap font-mono text-white">
            {r.value.repr}
          </pre>
        ))}
    </div>
  );
}

function Console({
  dbg,
  enabled,
  placeholder,
}: {
  dbg: Debugger;
  enabled: boolean;
  placeholder: string;
}) {
  const [code, setCode] = useState("");
  const [hist, setHist] = useState<string[]>([]);
  const [pos, setPos] = useState<number | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const busy = dbg.entries.some((e) => e.pending);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [dbg.entries]);
  const run = () => {
    if (!code.trim() || busy || !enabled) return;
    dbg.evaluate(code);
    setHist((h) => [...h.filter((x) => x !== code), code].slice(-100));
    setPos(null);
    setCode("");
  };
  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      run();
    } else if (e.key === "ArrowUp" && !code.includes("\n") && hist.length) {
      e.preventDefault();
      const p = pos === null ? hist.length - 1 : Math.max(0, pos - 1);
      setPos(p);
      setCode(hist[p]);
    } else if (e.key === "ArrowDown" && pos !== null && !code.includes("\n")) {
      e.preventDefault();
      const p = pos + 1;
      if (p >= hist.length) {
        setPos(null);
        setCode("");
      } else {
        setPos(p);
        setCode(hist[p]);
      }
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-2">
        {!dbg.entries.length && (
          <p className="py-2 text-muted">{placeholder}</p>
        )}
        {dbg.entries.map((e) => (
          <EntryView key={e.key} e={e} />
        ))}
        <div ref={end} />
      </div>
      <div className="flex items-start gap-1 border-t border-line p-1.5">
        <span className="pt-1 font-mono text-ocean">&gt;&gt;&gt;</span>
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={onKey}
          disabled={!enabled}
          rows={Math.min(6, code.split("\n").length)}
          spellCheck={false}
          placeholder={
            enabled
              ? "Python — Enter runs, Shift+Enter adds a line, ↑ history"
              : "Pause the transform to evaluate here"
          }
          className="min-w-0 flex-1 resize-none rounded border border-line-2 bg-ink px-2 py-1 font-mono text-[12px] text-white outline-none focus:border-ocean disabled:opacity-50"
        />
        <button
          type="button"
          onClick={run}
          disabled={!enabled || busy || !code.trim()}
          className="rounded p-1.5 text-muted hover:bg-panel-2 hover:text-white disabled:opacity-40"
          title="Run (Enter)"
        >
          <Icon name="play" className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

const STATUS_TEXT: Record<string, [string, string]> = {
  starting: ["Starting…", "text-muted"],
  running: ["Running", "text-ocean"],
  paused: ["Paused", "text-sand"],
  ready: ["Ready", "text-ok"],
  finished: ["Finished", "text-ok"],
  error: ["Failed", "text-bad"],
  stopped: ["Stopped", "text-muted"],
};
const REASON: Record<string, string> = {
  breakpoint: "at a breakpoint",
  step: "after a step",
  pause: "paused",
  entry: "at the transform's first line",
  exception: "on an exception",
};

function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  kbd,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  kbd?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={kbd ? `${label} (${kbd})` : label}
      className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-soft hover:bg-panel-2 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
    >
      <Icon name={icon} className="h-3.5 w-3.5" />
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

/** The Debug tab of the repository editor's bottom panel. */
export function DebugPanel({
  dbg,
  transform,
  transformLabel,
  onStart,
  onOpenFile,
}: {
  dbg: Debugger;
  /** the transform the Debug / Console buttons run (null: the open file has none) */
  transform: string | null;
  transformLabel: string | null;
  onStart: (mode: "debug" | "console") => void;
  onOpenFile: (file: string) => void;
}) {
  const s = dbg.session;
  const [right, setRight] = useState<"console" | "output">("console");
  const paused = s?.mode === "debug" && s.status === "paused";
  const running = s?.status === "running" || s?.status === "starting";
  const live = isLive(s);
  const debugging = s?.mode === "debug";

  const { command } = dbg;
  useEffect(() => {
    if (!s || s.mode !== "debug" || !live) return;
    const onKey = (e: KeyboardEvent) => {
      const map: Record<string, DebugAction | undefined> = {
        F8: "continue",
        F10: "next",
        F11: e.shiftKey ? "return" : "step",
      };
      const a = map[e.key];
      if (!a || !paused) return;
      e.preventDefault();
      command(a);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s, live, paused, command]);

  const allBps = useMemo(
    () =>
      Object.entries(dbg.breakpoints).flatMap(([file, list]) =>
        list.map((b) => ({ file, ...b })),
      ),
    [dbg.breakpoints],
  );
  const [label, color] = STATUS_TEXT[s?.status ?? ""] ?? [
    "Not started",
    "text-muted",
  ];

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1">
        <button
          type="button"
          onClick={() => onStart("debug")}
          disabled={!transform || !!dbg.starting}
          className="inline-flex items-center gap-1 rounded-md bg-ocean px-2 py-1 font-medium text-white hover:bg-ocean-deep disabled:opacity-40"
          title={
            transform
              ? `Run ${transformLabel} in preview under the debugger (nothing is written)`
              : "Open a file with a Python transform"
          }
        >
          <Icon name="bug" className="h-3.5 w-3.5" />{" "}
          {dbg.starting === "debug"
            ? "Starting…"
            : live && debugging
              ? "Restart"
              : "Debug"}
        </button>
        <button
          type="button"
          onClick={() => onStart("console")}
          disabled={!transform || !!dbg.starting}
          className="inline-flex items-center gap-1 rounded-md border border-line-2 bg-panel-2 px-2 py-1 text-soft hover:text-white disabled:opacity-40"
          title="A Python console with this transform's inputs loaded as variables"
        >
          <Icon name="keyboard" className="h-3.5 w-3.5" />{" "}
          {dbg.starting === "console" ? "Starting…" : "Console"}
        </button>
        <span className="mx-1 h-4 w-px bg-line" />
        {debugging && (
          <>
            <ToolButton
              icon="play"
              label="Continue"
              kbd="F8"
              onClick={() => dbg.command("continue")}
              disabled={!paused || s?.busy}
            />
            <ToolButton
              icon="right"
              label="Step over"
              kbd="F10"
              onClick={() => dbg.command("next")}
              disabled={!paused || s?.busy || s?.reason === "exception"}
            />
            <ToolButton
              icon="down"
              label="Step into"
              kbd="F11"
              onClick={() => dbg.command("step")}
              disabled={!paused || s?.busy || s?.reason === "exception"}
            />
            <ToolButton
              icon="external"
              label="Step out"
              kbd="Shift+F11"
              onClick={() => dbg.command("return")}
              disabled={!paused || s?.busy || s?.reason === "exception"}
            />
            <ToolButton
              icon="pause"
              label="Pause"
              onClick={() => dbg.command("pause")}
              disabled={!running}
            />
          </>
        )}
        {s?.busy && (
          <ToolButton
            icon="x"
            label="Interrupt"
            onClick={() => dbg.command("pause")}
          />
        )}
        {live && (
          <ToolButton
            icon="stop"
            label="Stop"
            onClick={() => dbg.command("stop")}
          />
        )}
        <span className={`ml-2 font-medium ${color}`}>{label}</span>
        {s?.status === "paused" && s.paused && (
          <button
            type="button"
            onClick={() => onOpenFile(s.paused!.file)}
            className="truncate font-mono text-soft hover:underline"
          >
            {REASON[s.reason ?? ""] ?? ""} · {s.paused.file}:{s.paused.line} in{" "}
            {s.paused.function}
          </button>
        )}
        {s && (
          <span className="ml-auto truncate text-muted" title={s.transform}>
            {s.mode === "console" ? "Console" : "Debugging"} {s.function} on{" "}
            {s.branch}
            {Object.keys(s.input_rows ?? {}).length
              ? ` · inputs: ${Object.entries(s.input_rows)
                  .map(([k, n]) => `${k} (${n.toLocaleString()} rows)`)
                  .join(", ")}`
              : ""}
          </span>
        )}
      </div>
      {dbg.error && (
        <div className="shrink-0 border-b border-bad/30 bg-bad/10 px-3 py-1 text-bad">
          {dbg.error}
        </div>
      )}

      {!s ? (
        <div className="space-y-1.5 p-3 text-muted">
          <p>
            <span className="text-soft">Debug</span> runs{" "}
            {transformLabel ? (
              <span className="font-mono text-soft">{transformLabel}</span>
            ) : (
              "the open file's transform"
            )}{" "}
            in preview against its real inputs — nothing is written — and stops
            at your breakpoints (or at its first line when its file has none).
          </p>
          <p>
            Click a line number in the editor to add a breakpoint; right-click
            it to give it a condition. F8 continues, F10 steps over, F11 steps
            into, Shift+F11 steps out.
          </p>
          <p>
            <span className="text-soft">Console</span> opens a Python console
            that keeps its state between commands, with the transform&apos;s
            inputs loaded as variables named after its parameters.
          </p>
          {allBps.length > 0 && (
            <BreakpointList dbg={dbg} onOpenFile={onOpenFile} />
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {debugging && (
            <div className="flex w-56 shrink-0 flex-col overflow-auto border-r border-line">
              <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted">
                Call stack
              </div>
              {paused && s.paused ? (
                s.paused.stack.map((f) => (
                  <button
                    key={f.index}
                    type="button"
                    data-frame={f.index}
                    onClick={() => {
                      dbg.selectFrame(f.index);
                      onOpenFile(f.file);
                    }}
                    disabled={s.busy}
                    title={`${f.file}:${f.line}`}
                    className={`flex w-full flex-col px-2 py-1 text-left hover:bg-panel-2 ${f.index === s.paused!.frame ? "bg-ocean/15 text-white" : "text-soft"}`}
                  >
                    <span className="font-mono">{f.function}</span>
                    <span className="truncate text-[10px] text-muted">
                      {f.file.split("/").pop()}:{f.line}
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-2 text-muted">{running ? "Running…" : "—"}</p>
              )}
              <div className="mt-2 flex items-center px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
                Breakpoints
                {allBps.length > 0 && (
                  <button
                    type="button"
                    onClick={dbg.clearBps}
                    className="ml-auto normal-case tracking-normal hover:text-white"
                  >
                    clear all
                  </button>
                )}
              </div>
              <BreakpointList dbg={dbg} onOpenFile={onOpenFile} compact />
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col overflow-auto">
            {s.status === "error" && s.error && (
              <pre className="m-2 whitespace-pre-wrap rounded-md bg-bad/10 p-2 font-mono text-bad">
                {s.error}
              </pre>
            )}
            {s.paused?.exception && s.status === "paused" && (
              <pre className="m-2 whitespace-pre-wrap rounded-md bg-bad/10 p-2 font-mono text-bad">
                {s.paused.exception}
              </pre>
            )}
            {s.status === "finished" && s.result && (
              <FinishedResult result={s.result} />
            )}
            {debugging && <Watches dbg={dbg} paused={paused} />}
            {(s.status === "paused" || s.mode === "console") && (
              <Variables
                vars={s.variables}
                empty={
                  s.mode === "console"
                    ? s.status === "starting"
                      ? "Loading inputs…"
                      : "No variables yet"
                    : "No local variables"
                }
              />
            )}
            {s.status === "running" && s.mode === "debug" && (
              <p className="p-3 text-muted">
                Running… it stops at the next breakpoint. Pause shows where it
                is now (e.g. in a loop that never ends).
              </p>
            )}
            {s.status === "starting" && (
              <p className="p-3 text-muted">
                Loading the repository and its inputs…
              </p>
            )}
          </div>
          <div className="flex w-[42%] min-w-[18rem] shrink-0 flex-col border-l border-line">
            <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
              {(
                [
                  ["console", "Console"],
                  ["output", `Output${dbg.output ? "" : " (empty)"}`],
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setRight(k)}
                  className={`rounded px-2 py-0.5 ${right === k ? "bg-panel-2 text-white" : "text-muted hover:text-white"}`}
                >
                  {l}
                </button>
              ))}
              {s.mode === "console" && s.preloaded.length > 0 && (
                <span className="ml-2 truncate text-muted">
                  loaded: {s.preloaded.join(", ")}
                </span>
              )}
              {right === "console" && dbg.entries.length > 0 && (
                <button
                  type="button"
                  onClick={dbg.clearConsole}
                  className="ml-auto text-muted hover:text-white"
                >
                  clear
                </button>
              )}
            </div>
            {right === "console" ? (
              <Console
                dbg={dbg}
                enabled={
                  !!s &&
                  ((s.mode === "debug" && s.status === "paused") ||
                    (s.mode === "console" && s.status === "ready")) &&
                  !s.busy
                }
                placeholder={
                  s.mode === "console"
                    ? `Variables persist between commands. Try ${s.preloaded[0] ? `${s.preloaded[0]}.head()` : "1 + 1"}${s.function ? ` or ${s.function}(…)` : ""}.`
                    : "When paused, evaluate expressions or run statements in the selected frame (assignments change the frame's variables)."
                }
              />
            ) : (
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-2 font-mono text-soft">
                {dbg.output ||
                  "print() output from the transform appears here."}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type DebugTable = {
  rows: number;
  columns: { name: string; type: string }[];
  preview: Record<string, unknown>[];
};
/** One output a @transform.using / .spark.using transform wrote (code_runner._output_previews). */
type DebugOutput = DebugTable & { kind?: "dataframe" | "files" };

function tableValue(t: DebugTable): DebugValue {
  return {
    type: "DataFrame",
    kind: "dataframe",
    repr: "",
    shape: [t.rows, t.columns.length],
    columns: t.columns,
    index: t.preview.slice(0, 50).map((_, i) => i),
    rows: t.preview.slice(0, 50).map((r) => t.columns.map((c) => r[c.name])),
  };
}

const plural = (n: number, one: string) =>
  `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`;

/** A finished run: its dataset, or each output of a multi-output transform with its row count and first rows. */
function FinishedResult({ result }: { result: NonNullable<DebugSession["result"]> }) {
  const outputs = Object.entries(
    ((result as { outputs?: Record<string, DebugOutput> }).outputs ?? {}) as Record<string, DebugOutput>,
  );
  const [pick, setPick] = useState<string | null>(null);
  if (!outputs.length) {
    return (
      <div className="p-2">
        <div className="mb-1 text-ok">
          ✓ Finished: {plural(result.rows, "row")},{" "}
          {plural(result.columns.length, "column")} (preview only, not written)
        </div>
        {result.dataset_output && <ValueTable value={tableValue(result)} />}
      </div>
    );
  }
  const name = pick && outputs.some(([k]) => k === pick) ? pick : outputs[0][0];
  const cur = outputs.find(([k]) => k === name)![1];
  return (
    <div className="p-2">
      <div className="mb-1 text-ok">
        ✓ Finished: {plural(outputs.length, "output")} (preview only, not written)
      </div>
      <div className="mb-1 flex flex-wrap gap-1" role="tablist">
        {outputs.map(([k, o]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={k === name}
            data-debug-output={k}
            onClick={() => setPick(k)}
            className={`rounded px-1.5 py-0.5 font-mono ${
              k === name ? "bg-ocean/20 text-ocean" : "bg-ink/40 hover:bg-ink/60"
            }`}
          >
            {k}: {plural(o.rows, o.kind === "files" ? "file" : "row")}
          </button>
        ))}
      </div>
      <ValueTable value={tableValue(cur)} />
    </div>
  );
}

function BreakpointList({
  dbg,
  onOpenFile,
  compact,
}: {
  dbg: Debugger;
  onOpenFile: (file: string) => void;
  compact?: boolean;
}) {
  const files = Object.entries(dbg.breakpoints).filter(([, l]) => l.length);
  if (!files.length)
    return (
      <p className={`${compact ? "px-2" : ""} text-muted`}>
        None: click a line number in the editor.
      </p>
    );
  return (
    <div className={compact ? "" : "max-w-xl"}>
      {files.flatMap(([file]) =>
        dbg.forFile(file).map((b) => (
          <div
            key={`${file}:${b.line}`}
            className="group flex items-center gap-1.5 px-2 py-0.5 hover:bg-panel-2"
            title={b.message ?? undefined}
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${b.verified === false ? "border border-bad" : b.condition ? "bg-sand" : "bg-bad"}`}
            />
            <button
              type="button"
              onClick={() => onOpenFile(file)}
              className="min-w-0 flex-1 truncate text-left font-mono text-soft hover:underline"
            >
              {file.split("/").pop()}:{b.line}
              {b.condition ? (
                <span className="text-sand"> if {b.condition}</span>
              ) : null}
              {b.verified === false ? (
                <span className="text-bad"> ({b.message})</span>
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => dbg.editCondition(file, b.line)}
              className="text-muted opacity-0 hover:text-white group-hover:opacity-100"
              title="Condition"
            >
              <Icon name="pencil" className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => dbg.removeBp(file, b.line)}
              className="text-muted opacity-0 hover:text-bad group-hover:opacity-100"
              title="Remove"
            >
              <Icon name="x" className="h-3 w-3" />
            </button>
          </div>
        )),
      )}
    </div>
  );
}
