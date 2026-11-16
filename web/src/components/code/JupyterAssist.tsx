"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Icon } from "@/components/Icon";
import {
  LabBridge,
  assistInfo,
  assistInspect,
  assistTurn,
  lineDiff,
  splitFences,
  type AssistInfo,
  type AssistantMessage,
  type LabContext,
  type NbCell,
  type NbSnapshot,
  type Neutral,
  type RunAll,
  type RunResult,
  type ToolCall,
  type TurnResult,
} from "@/lib/jupyterAssist";
import { renderMarkdown } from "@/lib/markdown";

/* The AI assistant beside JupyterLab (Docker), as Colab's Gemini panel is beside its notebook: ask it to write, edit,
   run or explain the open notebook's code (api/code_workspace_assist.py, DeepSeek). It works as Jupyter AI's Jupyternaut
   does — chat first, notebook tools when the user means the notebook — with its tools run in JupyterLab's own page by
   the bridge (api/jupyterlab_bridge/bridge.js). Reading the notebook happens by itself; every change (add, edit or
   delete a cell, run one) is a card with its preview that happens only on Apply, and can be undone. The conversation
   is kept per workspace in this browser tab. */

const MAX_ROUNDS = 12; // model turns for one message of the user
const MAX_REPEATS = 3; // calls repeated with the same arguments before the assistant is stopped (it is stuck)
const SHOWN = 40; // lines of a cell shown in a card before "show all"

type StepState = "pending" | "working" | "done" | "rejected" | "failed" | "skipped" | "undone";
type Step = {
  call: ToolCall;
  state: StepState;
  /** what went back to the model */
  result?: unknown;
  /** what the user reads on the card */
  outcome?: string;
  /** the notebook it was proposed for (it lands there even when another tab is in front by then), the cell it is about
   *  (its number when proposed) and its source then */
  path?: string;
  n?: number;
  before?: string;
  /** the cell changed since the proposal: Apply anyway overwrites it */
  conflict?: string;
  undo?: { op: string; args: Record<string, unknown> };
  ran?: RunResult;
  ranAll?: RunAll;
};
type UserItem = { kind: "user"; text: string };
type AssistantItem = { kind: "assistant"; text: string; steps: Step[]; message?: AssistantMessage; error?: string; note?: boolean };
type Item = UserItem | AssistantItem;
type How = "apply" | "run" | "force" | "reject";

const storeKey = (wid: string) => `bluesandai.jupyter-assist.${wid}`;

function load(wid: string): Item[] {
  try {
    const items = JSON.parse(sessionStorage.getItem(storeKey(wid)) ?? "[]") as Item[];
    // a proposal left open when the page went away is closed: the conversation the model reads stays whole
    return closeOpen(items, "The page was reloaded before the user decided.");
  } catch {
    return [];
  }
}

function store(wid: string, items: Item[]) {
  try {
    sessionStorage.setItem(storeKey(wid), JSON.stringify(items.slice(-40)));
  } catch {
    /* storage full or private window: the conversation stays in memory */
  }
}

function closeOpen(items: Item[], note: string): Item[] {
  return items.map((it) =>
    it.kind === "assistant" && it.steps.some((s) => s.state === "pending" || s.state === "working")
      ? { ...it, steps: it.steps.map((s) => (s.state === "pending" || s.state === "working" ? { ...s, state: "skipped" as const, conflict: undefined, result: { skipped: true, note }, outcome: "Not applied" } : s)) }
      : it,
  );
}

/** the conversation as the API takes it: each assistant turn as it came, then a result for each of its tool calls */
function conversation(items: Item[]): Neutral[] {
  const out: Neutral[] = [];
  for (const it of items) {
    if (it.kind === "user") out.push({ role: "user", text: it.text });
    else if (it.message) {
      out.push(it.message);
      for (const s of it.steps) out.push({ role: "tool", id: s.call.id, name: s.call.name, result: s.result ?? { skipped: true } });
    }
  }
  return out;
}

const fail = (error: string): Partial<Step> => ({ state: "failed", result: { error }, outcome: error });

/** a call's name and arguments, keys in order: the same call twice has the same key */
function callKey(call: ToolCall): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return `${call.name}:${JSON.stringify(canon(call.args ?? {}))}`;
}

/** the calls of this task (since the user's last message) made since the notebook last changed: one of them again
 *  would give the same result — a model repeating them is stuck (as OpenHands' stuck detector sees it) */
function seenCalls(items: Item[]): Map<string, unknown> {
  const keys = new Map<string, unknown>();
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") break;
    for (let j = it.steps.length - 1; j >= 0; j--) {
      const s = it.steps[j];
      if (s.call.change && s.state === "done") return keys;
      // the first answer of a call (a repeat's answer is the repeat notice)
      if (s.state !== "skipped") keys.set(callKey(s.call), s.result);
    }
  }
  return keys;
}

/** a proposal checked against the notebook as it is: what it is about, or why it cannot be (back to the model) */
type NewCell = { cell_type: "markdown" | "code"; content: string };
const newCells = (v: unknown): NewCell[] =>
  Array.isArray(v) ? v.filter((c): c is NewCell => !!c && typeof c === "object" && typeof (c as NewCell).content === "string").map((c) => ({ cell_type: c.cell_type === "markdown" ? "markdown" : "code", content: c.content })) : [];

function prepare(call: ToolCall, nb: NbSnapshot | null): Partial<Step> {
  const a = call.args;
  if (!a) {
    return fail(`The arguments of ${call.name} could not be read${call.args_error ? ` (${call.args_error})` : ""}: send them again as valid JSON.` +
      (call.name === "create_notebook" ? " For a long notebook, create it with its first cells and add the rest with add_cell." : ""));
  }
  // code that cannot compile is not shown to the user: it goes back to the model to fix
  if (call.syntax_error) return { ...fail(`The code has a Python syntax error (${call.syntax_error}): fix it and propose the change again.`), outcome: `Proposal had a syntax error (${call.syntax_error}): sent back to fix` };
  if (call.name === "create_notebook") {
    if (typeof a.name !== "string" || !a.name.trim()) return fail("create_notebook needs the file name.");
    const cells = newCells(a.cells);
    return cells.length ? { state: "pending", n: cells.length } : fail("create_notebook needs its cells, each with cell_type and content.");
  }
  if (!nb || nb.kind !== "notebook") return fail("No notebook is open in front in JupyterLab.");
  const path = nb.path;
  const byId = (id: unknown) => nb.cells.find((c) => c.cell_id === id);
  const missing = (id: unknown) => fail(`No cell with cell_id '${String(id)}': call read_notebook for the current ids.`);
  switch (call.name) {
    case "add_cell": {
      if (typeof a.content !== "string") return fail("add_cell needs the cell's content.");
      if (a.reference_cell_id && !byId(a.reference_cell_id)) return missing(a.reference_cell_id);
      const ref = byId(a.reference_cell_id) ?? byId(nb.active_cell_id) ?? nb.cells[nb.cells.length - 1];
      return { state: "pending", path, n: ref?.n };
    }
    case "edit_cell": {
      const c = byId(a.cell_id);
      if (!c) return missing(a.cell_id);
      if (typeof a.content !== "string") return fail("edit_cell needs the cell's new content.");
      if (a.content === c.source) return { state: "failed", n: c.n, result: { applied: false, note: "No change: the new source is the cell's current source." }, outcome: `No change to cell ${c.n}` };
      return { state: "pending", path, n: c.n, before: c.source };
    }
    case "delete_cell": {
      const c = byId(a.cell_id);
      return c ? { state: "pending", path, n: c.n, before: c.source } : missing(a.cell_id);
    }
    case "run_cell": {
      const c = byId(a.cell_id);
      if (!c) return missing(a.cell_id);
      return c.type === "code" ? { state: "pending", path, n: c.n, before: c.source } : fail(`Cell ${c.n} is a ${c.type} cell: only code cells run.`);
    }
    case "run_all_cells": {
      if (a.from_cell_id && !byId(a.from_cell_id)) return missing(a.from_cell_id);
      const from = byId(a.from_cell_id)?.n ?? 1;
      const code = nb.cells.filter((c) => c.n >= from && c.type === "code" && c.source.trim()).length;
      return code ? { state: "pending", path, n: code, before: nb.name } : fail("The notebook has no code cell to run.");
    }
  }
  return fail(`There is no tool ${call.name}.`);
}

/** a run as the model reads it */
const brief = (r: RunResult) => ({ status: r.status, cell: r.n, execution_count: r.execution_count, outputs: r.outputs ?? [], error: r.error, message: r.message });
const runText = (r: RunResult) =>
  r.status === "ok" ? " · ran ✓" : r.status === "error" ? ` · error: ${r.error?.ename ?? "Error"}${r.error?.evalue ? `: ${r.error.evalue}` : ""}` : r.status === "no-op" ? ` · nothing to run (${r.message})` : ` · ${r.status}`;
const allText = (r: RunAll) =>
  r.status === "ok" ? `ran all ${r.ran} code cells ✓` : `stopped at cell ${r.failed?.n}: ${r.failed?.error?.ename ?? r.status}${r.failed?.error?.evalue ? `: ${r.failed.error.evalue}` : ""} (${r.ran - 1} of ${r.of} ran before)`;

function title(s: Step): string {
  const a = s.call.args ?? {};
  switch (s.call.name) {
    case "add_cell":
      return `Add a ${a.cell_type === "markdown" ? "markdown" : "code"} cell${s.n ? ` ${a.position === "above" ? "above" : "below"} cell ${s.n}` : ""}`;
    case "edit_cell":
      return `Edit cell ${s.n ?? "?"}`;
    case "delete_cell":
      return `Delete cell ${s.n ?? "?"}`;
    case "run_cell":
      return `Run cell ${s.n ?? "?"}`;
    case "run_all_cells":
      return `Run all ${s.n ?? ""} code cells${s.before ? ` of ${s.before}` : ""}`;
    case "create_notebook":
      return `Create notebook ${String(a.name ?? "")}`;
    case "read_notebook":
      return "Read the notebook";
    case "read_cell":
      return `Read cell ${s.n ?? ""}`.trim();
    case "list_files":
      return `List ${String(a.path || "the workspace's files")}`;
    case "read_file":
      return `Read ${String(a.path ?? "")}`;
    case "inspect_data":
      return `Look into ${String(a.path ?? "")}`;
  }
  return s.call.name;
}

function suggestions(ctx: LabContext | null): string[] {
  if (ctx?.kind !== "notebook") return ["Create a complete notebook that explores the data in this workspace", "What can you do in this workspace?"];
  const out: string[] = [];
  if (ctx.errors.length) out.push(`Fix the error in cell ${ctx.errors[0]}`);
  if (ctx.selection) out.push("Explain the selected code");
  if (ctx.active > 0) out.push(`Explain cell ${ctx.active}`);
  out.push("Summarize what this notebook does");
  if (ctx.active > 0) out.push(`Add a cell after cell ${ctx.active} that plots its result`);
  out.push("Create a complete notebook that explores the data in this workspace");
  return [...out.slice(0, 3), out[out.length - 1]];
}

export function JupyterAssist({ workspaceId, frame, loads, onClose }: { workspaceId: string; frame: RefObject<HTMLIFrameElement | null>; loads: number; onClose: () => void }) {
  const [info, setInfo] = useState<AssistInfo | null>(null);
  const [infoErr, setInfoErr] = useState<string | null>(null);
  const [ctx, setCtx] = useState<LabContext | null>(null);
  const [link, setLink] = useState<"connecting" | "ready" | "unavailable">("connecting");
  const [items, setItems] = useState<Item[]>(() => load(workspaceId));
  const itemsRef = useRef(items);
  const [live, setLive] = useState<string | null>(null);
  const [busy, setBusy] = useState<"model" | "tool" | null>(null);
  const busyRef = useRef(false);
  const [input, setInput] = useState("");
  const abort = useRef<AbortController | null>(null);
  const stopped = useRef(false);
  const rounds = useRef(0);
  const repeats = useRef(0);
  const nudge = useRef(false);
  const end = useRef<HTMLDivElement>(null);

  const bridge = useMemo(() => new LabBridge(() => frame.current, setCtx), [frame]);
  useEffect(() => {
    bridge.open();
    stopped.current = false;
    return () => {
      // the panel closed: the answer being written stops, and nothing goes on without it
      stopped.current = true;
      abort.current?.abort();
      bridge.close();
    };
  }, [bridge]);

  useEffect(() => {
    assistInfo(workspaceId).then(setInfo, (e: Error) => setInfoErr(e.message));
  }, [workspaceId]);

  // the bridge answers once JupyterLab's app has started in the frame (a reload of the frame starts again)
  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the frame (re)loaded: connect again
    setLink("connecting");
    (async () => {
      for (let i = 0; i < 40 && live; i++) {
        try {
          await bridge.call("hello", {}, 2_500);
          if (live) setLink("ready");
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 1_500));
        }
      }
      if (live) setLink("unavailable");
    })();
    return () => {
      live = false;
    };
  }, [bridge, loads]);

  useEffect(() => {
    store(workspaceId, items);
  }, [workspaceId, items]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [items, live]);

  const commit = useCallback((fn: (items: Item[]) => Item[]) => {
    itemsRef.current = fn(itemsRef.current);
    setItems(itemsRef.current);
  }, []);
  const patchStep = useCallback(
    (idx: number, si: number, patch: Partial<Step>) =>
      commit((its) => its.map((it, i) => (i === idx && it.kind === "assistant" ? { ...it, steps: it.steps.map((s, j) => (j === si ? { ...s, ...patch } : s)) } : it))),
    [commit],
  );
  const setWorking = (w: "model" | "tool" | null) => {
    busyRef.current = w !== null;
    setBusy(w);
  };

  const snapshot = () => bridge.call<NbSnapshot>("snapshot").catch(() => null);

  const read = async (call: ToolCall): Promise<Partial<Step>> => {
    try {
      if (call.name === "read_notebook") {
        const s = await bridge.call<NbSnapshot>("snapshot");
        return { state: "done", result: s, outcome: s.kind === "notebook" ? `Read ${s.name}: ${s.cells.length} cells` : "No notebook is open" };
      }
      if (call.name === "read_cell") {
        const c = await bridge.call<NbCell>("read_cell", { cell_id: call.args?.cell_id });
        return { state: "done", n: c.n, result: c, outcome: `Read cell ${c.n}` };
      }
      if (call.name === "list_files") {
        const r = await bridge.call<{ path: string; entries?: { name: string; type: string }[] }>("list_files", { path: call.args?.path ?? "" });
        return { state: "done", result: r, outcome: r.entries ? `Listed ${r.path === "/" ? "the workspace" : r.path}: ${r.entries.length} entries` : `${r.path} is a file` };
      }
      if (call.name === "read_file") {
        const r = await bridge.call<{ path: string; showing: string }>("read_file", { path: call.args?.path, start: call.args?.start, lines: call.args?.lines });
        return { state: "done", result: r, outcome: `Read ${r.path} (${r.showing})` };
      }
      if (call.name === "inspect_data") {
        const r = await assistInspect(workspaceId, String(call.args?.path ?? ""));
        return { state: "done", result: r, outcome: `Looked into ${r.path}: ${r.columns.length} columns${r.rows !== null ? `, ${r.rows.toLocaleString()} rows` : ""}` };
      }
      return fail(`There is no tool ${call.name}.`);
    } catch (e) {
      return fail((e as Error).message);
    }
  };

  const apply = async (s: Step, how: How): Promise<Partial<Step>> => {
    const a = s.call.args ?? {};
    const path = s.path;
    try {
      switch (s.call.name) {
        case "create_notebook": {
          const r = await bridge.call<{ path: string; name: string; cells: number }>("create_notebook", { name: a.name, cells: newCells(a.cells), directory: a.directory }, 120_000);
          const ranAll = how === "run" ? await bridge.call<RunAll>("run_all", { path: r.path }, 0) : undefined;
          return {
            state: "done", path: r.path, ranAll,
            result: { applied: true, path: r.path, cells: r.cells, opened: true, ...(ranAll ? { ran_all: ranAll } : {}) },
            outcome: `Created ${r.name} (${r.cells} cells) and opened it${ranAll ? ` · ${allText(ranAll)}` : ""}`,
          };
        }
        case "run_all_cells": {
          const ranAll = await bridge.call<RunAll>("run_all", { path, from_cell_id: a.from_cell_id }, 0);
          return { state: "done", ranAll, result: ranAll, outcome: `${allText(ranAll)[0].toUpperCase()}${allText(ranAll).slice(1)}` };
        }
        case "add_cell": {
          const r = await bridge.call<{ cell_id: string; n: number }>("add_cell", { ...a, path });
          const ran = how === "run" && a.cell_type !== "markdown" ? await bridge.call<RunResult>("run_cell", { cell_id: r.cell_id, path }, 0) : undefined;
          return {
            state: "done", n: r.n, ran, conflict: undefined, undo: { op: "delete_cell", args: { cell_id: r.cell_id, path } },
            result: { applied: true, cell_id: r.cell_id, cell: r.n, ...(ran ? { ran: brief(ran) } : {}) },
            outcome: `Added as cell ${r.n}${ran ? runText(ran) : ""}`,
          };
        }
        case "edit_cell": {
          const r = await bridge.call<{ cell_id: string; n: number; previous?: string; changed?: boolean }>("edit_cell", {
            cell_id: a.cell_id, content: a.content, expect: how === "force" ? undefined : s.before, path,
          });
          if (r.changed) return { state: "pending", conflict: `Cell ${r.n} changed after this was proposed: Apply anyway overwrites your edits.` };
          const ran = how === "run" ? await bridge.call<RunResult>("run_cell", { cell_id: r.cell_id, path }, 0) : undefined;
          return {
            state: "done", n: r.n, ran, conflict: undefined, undo: { op: "edit_cell", args: { cell_id: r.cell_id, content: r.previous ?? s.before ?? "", path } },
            result: { applied: true, cell_id: r.cell_id, cell: r.n, ...(ran ? { ran: brief(ran) } : {}) },
            outcome: `Applied to cell ${r.n}${ran ? runText(ran) : ""}`,
          };
        }
        case "delete_cell": {
          const r = await bridge.call<{ n: number; index: number; cell: unknown }>("delete_cell", { cell_id: a.cell_id, path });
          return { state: "done", undo: { op: "restore_cell", args: { index: r.index, cell: r.cell, path } }, result: { applied: true, deleted_cell: r.n }, outcome: `Deleted cell ${r.n}` };
        }
        case "run_cell": {
          const ran = await bridge.call<RunResult>("run_cell", { cell_id: a.cell_id, path }, 0);
          return { state: "done", n: ran.n, ran, result: brief(ran), outcome: `Ran cell ${ran.n}${runText(ran)}` };
        }
      }
      return fail(`There is no tool ${s.call.name}.`);
    } catch (e) {
      return fail((e as Error).message);
    }
  };

  /** one model turn: the answer, its reads done, its changes waiting. "again": go on; "wait": the user decides */
  const turn = async (): Promise<"again" | "wait" | "end"> => {
    const ctl = new AbortController();
    abort.current = ctl;
    setWorking("model");
    setLive("");
    let res: TurnResult;
    try {
      res = await assistTurn(workspaceId, { messages: conversation(itemsRef.current), notebook: await snapshot(), nudge: nudge.current }, setLive, ctl.signal);
      nudge.current = false;
    } catch (e) {
      res = ctl.signal.aborted ? { cancelled: true } : { error: (e as Error).message };
    } finally {
      setLive(null);
      setWorking(null);
      abort.current = null;
    }
    if ("cancelled" in res || stopped.current) return "end";
    if ("error" in res) {
      commit((its) => [...its, { kind: "assistant", text: "", steps: [], error: res.error }]);
      return "end";
    }
    const done = res;
    commit((its) => [...its, { kind: "assistant", text: done.text, message: done.message, steps: done.tool_calls.map((call) => ({ call, state: call.change ? "pending" : "working" })) }]);
    const idx = itemsRef.current.length - 1;
    if (!done.tool_calls.length) return "end";
    setWorking("tool");
    const nb = await snapshot();
    const seen = seenCalls(itemsRef.current.slice(0, idx));
    for (let si = 0; si < done.tool_calls.length; si++) {
      const call = done.tool_calls[si];
      const key = callKey(call);
      if (seen.has(key)) {
        repeats.current += 1;
        nudge.current = true;
        patchStep(idx, si, {
          state: "failed", outcome: "Same call again: not repeated",
          result: {
            error: `Repeated call: ${call.name} with these arguments was already made and nothing changed since. Do not call it again: here is its result once more — use it and take the next step.`,
            earlier_result: seen.get(key),
          },
        });
        continue;
      }
      const r = call.change ? prepare(call, nb) : await read(call);
      seen.set(key, r.result);
      patchStep(idx, si, r);
    }
    setWorking(null);
    if (repeats.current >= MAX_REPEATS) {
      commit((its) => [...closeOpen(its, "The assistant was stopped: it kept repeating the same calls."),
        { kind: "assistant", text: "Stopped: I kept repeating the same steps. Tell me more precisely what you want, or point me to the file or cell to use.", steps: [], note: true }]);
      return "end";
    }
    const steps = (itemsRef.current[idx] as AssistantItem).steps;
    return steps.some((s) => s.state === "pending") ? "wait" : "again";
  };

  const loop = async () => {
    while (rounds.current < MAX_ROUNDS) {
      if (stopped.current) return;
      rounds.current += 1;
      if ((await turn()) !== "again") return;
    }
    commit((its) => [...its, { kind: "assistant", text: `Stopped after ${MAX_ROUNDS} steps: ask me to go on if you want more.`, steps: [], note: true }]);
  };

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busyRef.current) return;
    setInput("");
    stopped.current = false;
    rounds.current = 0;
    repeats.current = 0;
    nudge.current = false;
    commit((its) => [...closeOpen(its, "The user wrote a new message instead of deciding."), { kind: "user", text: q }]);
    await loop();
  };

  const stop = () => {
    stopped.current = true;
    abort.current?.abort();
    commit((its) => closeOpen(its, "The user stopped the assistant."));
    setWorking(null);
  };

  /** the user's decision on proposals of the last answer; once none waits, the model goes on — unless all were rejected */
  const decide = async (idx: number, which: number[], how: How) => {
    if (busyRef.current) return;
    setWorking("tool");
    for (const si of which) {
      const it = itemsRef.current[idx];
      if (it.kind !== "assistant" || it.steps[si]?.state !== "pending") continue;
      if (how === "reject") {
        patchStep(idx, si, { state: "rejected", conflict: undefined, result: { rejected: true, note: "The user rejected this proposal." }, outcome: "Rejected" });
        continue;
      }
      patchStep(idx, si, { state: "working" });
      patchStep(idx, si, await apply(it.steps[si], how));
    }
    setWorking(null);
    const it = itemsRef.current[idx];
    // a Stop pressed while a change ran holds: the model does not go on by itself
    if (stopped.current || idx !== itemsRef.current.length - 1 || it.kind !== "assistant" || it.steps.some((s) => s.state === "pending" || s.state === "working")) return;
    if (it.steps.some((s) => s.call.change && s.state === "done")) await loop();
  };

  const undo = async (idx: number, si: number) => {
    const it = itemsRef.current[idx];
    const s = it.kind === "assistant" ? it.steps[si] : undefined;
    if (!s?.undo) return;
    try {
      await bridge.call(s.undo.op, s.undo.args);
      patchStep(idx, si, { state: "undone", undo: undefined, outcome: `${s.outcome} — undone`, result: { ...(s.result as object), undone_by_user: true } });
    } catch (e) {
      patchStep(idx, si, { outcome: `${s.outcome} — could not undo: ${(e as Error).message}` });
    }
  };

  const retry = async () => {
    if (busyRef.current) return;
    commit((its) => (its.length && its[its.length - 1].kind === "assistant" && (its[its.length - 1] as AssistantItem).error ? its.slice(0, -1) : its));
    stopped.current = false;
    await loop();
  };

  const insert = async (code: string, lang: string) => {
    const r = await bridge.call<{ n: number }>("add_cell", { content: code, cell_type: lang === "markdown" || lang === "md" ? "markdown" : "code" });
    return `Inserted as cell ${r.n}`;
  };

  const newChat = () => {
    if (busyRef.current) return;
    commit(() => []);
  };

  const name = info?.user || "";
  const chips = suggestions(ctx);

  return (
    <aside className="flex w-[400px] shrink-0 flex-col border-l border-violet-400/30 bg-panel" aria-label="AI Assistant" data-jupyter-assist>
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="rounded-md bg-violet-500/20 p-1.5 text-violet-200">
          <Icon name="sparkle" className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">AI Assistant</div>
          <div className="truncate text-[11px] text-muted">{info ? info.label : infoErr ?? "…"}</div>
        </div>
        <button type="button" title="New conversation" onClick={newChat} disabled={!!busy} className="rounded p-1 text-muted hover:text-strong disabled:opacity-40">
          <Icon name="refresh" className="h-4 w-4" />
        </button>
        <button type="button" title="Close" onClick={onClose} className="rounded p-1 text-muted hover:text-strong">
          <Icon name="x" className="h-4 w-4" />
        </button>
      </header>

      <div className="flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-[11px] text-muted" data-assist-context>
        {link === "connecting" ? (
          <>
            <Icon name="refresh" className="h-3 w-3 animate-spin" /> Connecting to JupyterLab…
          </>
        ) : link === "unavailable" ? (
          <span className="text-warn">Cannot reach the notebook in JupyterLab: reload the page. The assistant can still answer questions.</span>
        ) : ctx?.kind === "notebook" ? (
          <>
            <Icon name="doc" className="h-3 w-3 shrink-0" />
            <span className="truncate font-medium text-soft" title={ctx.path}>{ctx.name}</span>
            <span className="shrink-0">· cell {ctx.active}/{ctx.cells}</span>
            <span className="shrink-0">· {ctx.kernel_status || "no kernel"}</span>
            {ctx.errors.length > 0 && <span className="shrink-0 text-bad">· error in cell {ctx.errors.join(", ")}</span>}
          </>
        ) : (
          <span>{ctx?.kind === "other" ? `${ctx.title} is in front: open a notebook to work on its cells.` : "Open a notebook in JupyterLab to work on its cells."}</span>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
        {info && !info.ready && <p className="rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-xs text-warn">{info.label} is not enabled on this platform yet.</p>}
        {!items.length && live === null && (
          <div className="space-y-3 pt-6">
            <div className="text-center">
              <div className="bg-gradient-to-r from-violet-300 to-sky-300 bg-clip-text text-2xl font-semibold text-transparent">Hello{name ? `, ${name}` : ""}</div>
              <p className="mt-1 text-sm text-soft">How can I help with this notebook?</p>
              <p className="mt-2 text-[11px] text-muted">Ask me to write, edit, run or explain code. Changes come as cards: nothing in the notebook changes until you press Apply.</p>
            </div>
            <div className="space-y-1.5 pt-2">
              {chips.map((c) => (
                <button key={c} type="button" onClick={() => send(c)} disabled={!!busy} className="block w-full rounded-full border border-line px-3 py-1.5 text-left text-xs text-soft hover:border-violet-400/60 hover:text-strong">
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((it, idx) =>
          it.kind === "user" ? (
            <div key={idx} className="ml-8 whitespace-pre-wrap break-words rounded-lg bg-ocean/15 px-3 py-2 text-sm">
              {it.text}
            </div>
          ) : (
            <div key={idx} className="space-y-2">
              {it.error ? (
                <div className="rounded-md border border-bad/40 bg-bad/10 px-2.5 py-2 text-xs text-bad">
                  {it.error}
                  {idx === items.length - 1 && (
                    <button type="button" onClick={retry} disabled={!!busy} className="ml-2 underline">
                      Try again
                    </button>
                  )}
                </div>
              ) : it.text ? (
                <Answer text={it.text} muted={it.note} canInsert={link === "ready"} onInsert={insert} />
              ) : null}
              {it.steps.map((s, si) => (
                <StepCard
                  key={s.call.id || si}
                  step={s}
                  busy={!!busy}
                  // Undo changes one cell back: it may be pressed while the model writes, not while a cell runs
                  undoLocked={busy === "tool"}
                  onDecide={(how) => decide(idx, [si], how)}
                  onUndo={() => undo(idx, si)}
                />
              ))}
              {it.steps.filter((s) => s.state === "pending" && !s.conflict).length > 1 && (
                <div className="flex gap-1.5 text-xs">
                  <button type="button" disabled={!!busy} onClick={() => decide(idx, it.steps.map((s, si) => (s.state === "pending" ? si : -1)).filter((si) => si >= 0), "apply")}
                    className="rounded-md bg-violet-500 px-2.5 py-1 font-medium text-white hover:bg-violet-400 disabled:opacity-40">
                    Apply all
                  </button>
                  <button type="button" disabled={!!busy} onClick={() => decide(idx, it.steps.map((s, si) => (s.state === "pending" ? si : -1)).filter((si) => si >= 0), "reject")}
                    className="rounded-md border border-line-2 px-2.5 py-1 text-soft hover:text-strong disabled:opacity-40">
                    Reject all
                  </button>
                </div>
              )}
            </div>
          ),
        )}
        {live !== null && (live ? <Answer text={live} streaming canInsert={false} onInsert={insert} /> : <Thinking label={`${info?.label ?? "The assistant"} is thinking…`} />)}
        {busy === "tool" && live === null && <Thinking label="Working in the notebook…" />}
        <div ref={end} />
      </div>

      <form
        className="border-t border-line p-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <div className="flex items-end gap-2 rounded-xl border border-line-2 bg-ink px-2.5 py-2 focus-within:border-violet-400/60">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            rows={2}
            placeholder={ctx?.kind === "notebook" && ctx.active > 0 ? `Ask about cell ${ctx.active}, or what to build…` : "What can I help you build?"}
            className="max-h-40 min-h-[2.5rem] flex-1 resize-y bg-transparent text-sm outline-none placeholder:text-muted"
            data-assist-input
          />
          {busy ? (
            <button type="button" onClick={stop} className="rounded-md border border-line-2 p-1.5 text-soft hover:text-strong" aria-label="Stop" title="Stop">
              <Icon name="stop" className="h-4 w-4" />
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()} className="rounded-md bg-violet-500 p-1.5 text-white disabled:opacity-40" aria-label="Send" data-assist-send>
              <Icon name="right" className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-[10px] text-muted">
          <span>Enter sends · Shift+Enter new line</span>
          <span>{info?.label ?? "AI"} can be wrong: check changes before you apply them</span>
        </div>
      </form>
    </aside>
  );
}

function Thinking({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <Icon name="refresh" className="h-3.5 w-3.5 animate-spin" /> {label}
    </div>
  );
}

/** an answer: prose as markdown, code blocks with Copy and Insert as a cell */
function Answer({ text, streaming, muted, canInsert, onInsert }: { text: string; streaming?: boolean; muted?: boolean; canInsert: boolean; onInsert: (code: string, lang: string) => Promise<string> }) {
  const parts = useMemo(() => splitFences(text), [text]);
  return (
    <div className={`space-y-2 ${muted ? "text-muted" : "text-soft"}`}>
      {parts.map((p, i) =>
        p.kind === "md" ? (
          p.text.trim() ? <div key={i} className="md-body text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.text) }} /> : null
        ) : (
          <CodeBlock key={i} code={p.code} lang={p.lang} open={p.open || !!streaming} canInsert={canInsert} onInsert={onInsert} />
        ),
      )}
      {streaming && <span className="inline-block h-3 w-1.5 animate-pulse bg-violet-300 align-middle" />}
    </div>
  );
}

function CodeBlock({ code, lang, open, canInsert, onInsert }: { code: string; lang: string; open: boolean; canInsert: boolean; onInsert: (code: string, lang: string) => Promise<string> }) {
  const [note, setNote] = useState<string | null>(null);
  const flash = (t: string) => {
    setNote(t);
    setTimeout(() => setNote(null), 2_500);
  };
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-ink">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1 text-[10px] text-muted">
        <span className="font-mono">{lang || "code"}</span>
        {note && <span className="ml-2 text-emerald-300">{note}</span>}
        {!open && (
          <span className="ml-auto flex gap-1">
            <button type="button" onClick={() => navigator.clipboard.writeText(code).then(() => flash("Copied"), () => flash("Copy failed"))} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-line hover:text-strong">
              <Icon name="copy" className="h-3 w-3" /> Copy
            </button>
            {canInsert && (
              <button type="button" onClick={() => onInsert(code, lang).then(flash, (e: Error) => flash(e.message))} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-line hover:text-strong" data-assist-insert>
                <Icon name="plus" className="h-3 w-3" /> Insert as cell
              </button>
            )}
          </span>
        )}
      </div>
      <pre className="max-h-80 overflow-auto p-2 font-mono text-[11.5px] leading-snug text-strong"><code>{code}</code></pre>
    </div>
  );
}

/** the lines of a diff, long unchanged runs folded */
function Diff({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => {
    const lines = lineDiff(before, after);
    const out: ({ t: " " | "+" | "-"; s: string } | { fold: number })[] = [];
    for (let i = 0; i < lines.length; ) {
      if (lines[i].t !== " ") {
        out.push(lines[i++]);
        continue;
      }
      let j = i;
      while (j < lines.length && lines[j].t === " ") j++;
      const run = lines.slice(i, j);
      if (run.length > 6) out.push(...run.slice(0, i === 0 ? 0 : 2), { fold: run.length - (i === 0 ? 0 : 2) - (j === lines.length ? 0 : 2) }, ...run.slice(j === lines.length ? run.length : run.length - 2));
      else out.push(...run);
      i = j;
    }
    return out;
  }, [before, after]);
  return (
    <pre className="max-h-80 overflow-auto rounded bg-ink py-1 font-mono text-[11px] leading-snug" data-assist-diff>
      {rows.map((r, i) =>
        "fold" in r ? (
          <div key={i} className="px-2 text-muted">⋯ {r.fold} unchanged lines</div>
        ) : (
          <div key={i} className={`px-2 ${r.t === "+" ? "bg-emerald-500/15 text-emerald-200" : r.t === "-" ? "bg-rose-500/15 text-rose-200" : "text-soft"}`}>
            <span className="select-none pr-1.5 opacity-60">{r.t}</span>
            {r.s || " "}
          </div>
        ),
      )}
    </pre>
  );
}

function Source({ code, strike }: { code: string; strike?: boolean }) {
  const [all, setAll] = useState(false);
  const lines = code.split("\n");
  const shown = all ? code : lines.slice(0, SHOWN).join("\n");
  return (
    <div>
      <pre className={`max-h-80 overflow-auto rounded bg-ink p-2 font-mono text-[11px] leading-snug ${strike ? "text-rose-200/80 line-through" : "text-strong"}`}>{shown || " "}</pre>
      {lines.length > SHOWN && !all && (
        <button type="button" onClick={() => setAll(true)} className="mt-0.5 text-[10px] text-ocean hover:underline">
          show all {lines.length} lines
        </button>
      )}
    </div>
  );
}

function Outputs({ run }: { run: RunResult }) {
  const text = (run.outputs ?? [])
    .map((o) => (o.kind === "error" ? `${o.ename}: ${o.evalue}` : (o.text ?? "") + (o.media?.length ? `\n(${o.media.join(", ")})` : "")))
    .filter((t) => t.trim())
    .join("\n")
    .trim();
  if (!text) return null;
  return <pre className={`mt-1.5 max-h-40 overflow-auto rounded bg-ink p-1.5 font-mono text-[10.5px] ${run.status === "error" ? "text-rose-200" : "text-soft"}`}>{text.slice(0, 1500)}</pre>;
}

function StepCard({ step, busy, undoLocked, onDecide, onUndo }: { step: Step; busy: boolean; undoLocked: boolean; onDecide: (how: How) => void; onUndo: () => void }) {
  const a = step.call.args ?? {};
  if (!step.call.change) {
    // a read: one line, as it happened
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted" data-assist-step={step.call.name}>
        <Icon name={step.state === "failed" ? "alert" : step.state === "working" ? "refresh" : "eye"} className={`h-3 w-3 ${step.state === "working" ? "animate-spin" : ""}`} />
        {step.outcome ?? `${title(step)}…`}
      </div>
    );
  }
  const code = typeof a.content === "string" ? a.content : "";
  const name = step.call.name;
  const icon = name === "delete_cell" ? "trash" : name === "run_cell" || name === "run_all_cells" ? "play" : name === "edit_cell" ? "edit" : name === "create_notebook" ? "doc" : "plus";
  const isCode = name !== "add_cell" || a.cell_type !== "markdown";
  const verb = name === "delete_cell" ? "Delete" : name === "run_cell" ? "Run" : name === "run_all_cells" ? "Run all" : name === "create_notebook" ? "Create" : "Apply";
  const failed = step.ranAll?.failed;
  return (
    <div className={`rounded-lg border p-2.5 text-xs ${step.state === "pending" ? "border-violet-400/50 bg-violet-500/5" : "border-line bg-panel"}`} data-assist-step={step.call.name} data-assist-state={step.state}>
      <div className="flex items-center gap-1.5 font-medium text-violet-100">
        <Icon name={icon} className="h-3.5 w-3.5" /> {title(step)}
      </div>
      <div className="mt-1.5">
        {name === "edit_cell" && step.before !== undefined ? (
          <Diff before={step.before} after={code} />
        ) : name === "add_cell" ? (
          <Source code={code} />
        ) : name === "delete_cell" ? (
          <Source code={step.before ?? ""} strike />
        ) : name === "create_notebook" ? (
          <Outline cells={newCells(a.cells)} folder={typeof a.directory === "string" ? a.directory : ""} />
        ) : name === "run_all_cells" ? (
          <p className="text-soft">Runs the code cells top to bottom in the notebook&apos;s kernel and stops at the first error.</p>
        ) : (
          <Source code={(step.before ?? "").split("\n").slice(0, 6).join("\n")} />
        )}
      </div>
      {step.conflict && <div className="mt-1.5 text-warn">{step.conflict}</div>}
      {step.state === "pending" ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {step.conflict ? (
            <button type="button" disabled={busy} onClick={() => onDecide("force")} className="rounded-md bg-violet-500 px-2.5 py-1 font-medium text-white hover:bg-violet-400 disabled:opacity-40" data-assist-apply>
              Apply anyway
            </button>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => onDecide("apply")} className="rounded-md bg-violet-500 px-2.5 py-1 font-medium text-white hover:bg-violet-400 disabled:opacity-40" data-assist-apply>
                {verb}
              </button>
              {((name === "add_cell" || name === "edit_cell") && isCode || name === "create_notebook") && (
                <button type="button" disabled={busy} onClick={() => onDecide("run")} className="rounded-md border border-violet-400/60 px-2.5 py-1 font-medium text-violet-100 hover:bg-violet-500/20 disabled:opacity-40" data-assist-apply-run>
                  {name === "create_notebook" ? "Create & run all" : "Apply & run"}
                </button>
              )}
            </>
          )}
          <button type="button" disabled={busy} onClick={() => onDecide("reject")} className="rounded-md border border-line-2 px-2.5 py-1 text-soft hover:text-strong disabled:opacity-40" data-assist-reject>
            {name === "delete_cell" ? "Keep" : name === "run_cell" || name === "run_all_cells" ? "Skip" : "Reject"}
          </button>
        </div>
      ) : (
        <div className={`mt-1.5 flex items-center gap-2 ${step.state === "failed" ? "text-bad" : step.state === "done" ? "text-emerald-300" : "text-muted"}`} data-assist-outcome>
          {step.state === "working" ? <Icon name="refresh" className="h-3 w-3 animate-spin" /> : step.state === "done" ? <Icon name="check" className="h-3 w-3" /> : null}
          <span className="min-w-0 flex-1">{step.state === "working" ? (name === "run_cell" || name === "run_all_cells" ? "Running…" : name === "create_notebook" ? "Creating…" : "Applying…") : step.outcome}</span>
          {step.state === "done" && step.undo && (
            <button type="button" disabled={undoLocked} onClick={onUndo} className="shrink-0 text-ocean hover:underline disabled:opacity-40" data-assist-undo>
              Undo
            </button>
          )}
        </div>
      )}
      {step.ran && <Outputs run={step.ran} />}
      {failed && <Outputs run={{ cell_id: failed.cell_id, n: failed.n, status: "error", outputs: failed.outputs, error: failed.error }} />}
    </div>
  );
}

/** a new notebook's cells, one line each; a click shows a cell whole */
function Outline({ cells, folder }: { cells: NewCell[]; folder: string }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="space-y-0.5" data-assist-outline>
      <div className="text-[10px] text-muted">{cells.length} cells{folder ? ` · in ${folder}` : ""} · click a cell to read it</div>
      <ol className="max-h-80 overflow-y-auto rounded bg-ink py-1">
        {cells.map((c, i) => (
          <li key={i}>
            <button type="button" onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-baseline gap-1.5 px-2 py-0.5 text-left hover:bg-line/50">
              <span className="w-5 shrink-0 text-right font-mono text-[10px] text-muted">{i + 1}</span>
              <span className={`shrink-0 rounded px-1 text-[9px] uppercase ${c.cell_type === "markdown" ? "bg-sky-500/15 text-sky-200" : "bg-violet-500/15 text-violet-200"}`}>{c.cell_type === "markdown" ? "md" : "code"}</span>
              <span className="min-w-0 truncate font-mono text-[11px] text-soft">{c.content.trim().split("\n")[0] || "(empty)"}</span>
            </button>
            {open === i && <div className="px-2 pb-1"><Source code={c.content} /></div>}
          </li>
        ))}
      </ol>
    </div>
  );
}
