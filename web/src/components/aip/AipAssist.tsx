"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import { SIDEBAR_RAIL_EVENT } from "@/components/Sidebar";
import { renderMarkdown } from "@/lib/markdown";
import { aiText } from "@/lib/services";

/* AIP Assist: one docked assistant every app plugs into through an adapter. The adapter gives what the assistant may
   read (the selected nodes — the "area" you ask about — and a summary of the whole document) and the tools it may
   PROPOSE. The model answers in markdown and returns actions; each action is a card with a preview, applied only when
   you press Apply (nothing changes behind your back). Conversations are kept per document in this browser tab. */

export type AssistTool = {
  name: string;
  /** what the tool does and its arguments, for the model (compact) */
  description: string;
  /** changes nothing (select, show): allowed in read-only documents */
  safe?: boolean;
  /** a human summary of the proposal, and a check before applying: return { error } to block Apply */
  preview?: (args: Record<string, unknown>) => { text?: string; detail?: ReactNode; error?: string };
  /** apply the proposal; the returned text is shown as the outcome */
  run: (args: Record<string, unknown>) => string | void | Promise<string | void>;
};

export type AssistContext = {
  /** the selected area, as chips (id + label) */
  selection: { id: string; label: string }[];
  /** what the model reads: the selected nodes in detail, then the document in brief */
  text: string;
};

export type AssistAdapter = {
  /** app key + document id: the conversation is kept per document */
  key: string;
  app: string;
  /** the app's role for the model */
  system: string;
  context: (question: string) => AssistContext;
  tools: AssistTool[];
  suggestions: (hasSelection: boolean) => string[];
  /** how to select an area in this app */
  selectHint: string;
  onClearSelection?: () => void;
  /** read-only documents: actions are shown but cannot be applied */
  readOnly?: boolean;
};

type Action = { tool: string; title: string; args: Record<string, unknown>; state?: "applied" | "skipped" | "failed"; outcome?: string };
type Turn = { role: "user" | "assistant"; text: string; selection?: string[]; actions?: Action[]; error?: boolean };

const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    actions: {
      type: "array",
      items: { type: "object", properties: { tool: { type: "string" }, title: { type: "string" }, args_json: { type: "string" } }, required: ["tool", "title", "args_json"] },
    },
  },
  required: ["answer", "actions"],
};

function load(key: string): Turn[] {
  try {
    return JSON.parse(sessionStorage.getItem(`bluesandai.aip.${key}`) ?? "[]");
  } catch {
    return [];
  }
}

function store(key: string, turns: Turn[]) {
  try {
    sessionStorage.setItem(`bluesandai.aip.${key}`, JSON.stringify(turns.slice(-40)));
  } catch {
    /* storage full or private window: the conversation stays in memory */
  }
}

/** the toolbar button that opens the assistant (Ctrl+Shift+U also toggles it) */
export function AipAssistButton({ open, onToggle, className = "" }: { open: boolean; onToggle: () => void; className?: string }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "u") {
        e.preventDefault();
        onToggle();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onToggle]);
  return (
    <button
      type="button"
      onClick={onToggle}
      title="AIP Assist — tanya & bangun dengan bahasa alami (Ctrl+Shift+U)"
      aria-pressed={open}
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${open ? "border-violet-400/70 bg-violet-500/20 text-violet-100" : "border-violet-400/40 bg-violet-500/10 text-violet-200 hover:border-violet-300"} ${className}`}
    >
      <Icon name="sparkle" className="h-3.5 w-3.5" /> AIP Assist
    </button>
  );
}

/** the docked assistant; a different document (adapter.key) gets its own conversation */
export function AipAssistPanel(props: { adapter: AssistAdapter; onClose: () => void }) {
  // docked on the left: a column between the sidebar (folded to its rail, and left folded on close) and the page
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const main = document.querySelector("body > main");
    const el = document.createElement("div");
    el.dataset.aipSlot = "";
    el.className = "contents";
    document.body.insertBefore(el, main);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the slot exists only once mounted in the document
    setSlot(el);
    window.dispatchEvent(new Event(SIDEBAR_RAIL_EVENT));
    return () => el.remove();
  }, []);
  return slot ? createPortal(<Panel key={props.adapter.key} {...props} />, slot) : null;
}

function Panel({ adapter, onClose }: { adapter: AssistAdapter; onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>(() => load(adapter.key));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const ctx = adapter.context("");
  const tools = useMemo(() => new Map(adapter.tools.map((t) => [t.name, t])), [adapter.tools]);
  useEffect(() => {
    store(adapter.key, turns);
  }, [adapter.key, turns]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns, busy]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const c = adapter.context(q);
    // a failed answer is not part of the conversation the model reads
    const history = turns.filter((t) => !t.error).slice(-8).map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}${t.actions?.length ? `\n(proposed: ${t.actions.map((a) => `${a.title} [${a.state ?? "pending"}]`).join("; ")})` : ""}`);
    const next: Turn[] = [...turns, { role: "user", text: q, selection: c.selection.map((s) => s.label) }];
    setTurns(next);
    setInput("");
    setBusy(true);
    try {
      const toolText = adapter.tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
      const prompt = [
        `# Context (${adapter.app})`,
        c.text,
        "",
        "# Tools you may propose (the user applies each one; args_json is a JSON object of the arguments)",
        toolText || "(none — answer only)",
        "",
        history.length ? `# Conversation so far\n${history.join("\n\n")}\n` : "",
        `# User\n${q}`,
      ].join("\n");
      const res = await aiText<{ answer: string; actions: { tool: string; title: string; args_json: string }[] }>(prompt, {
        system:
          `${adapter.system}\n\nYou are AIP Assist inside BluesandAI (${adapter.app}). Answer in the user's language, concisely, in markdown. ` +
          "The answer shows in a narrow side panel: short headings and bullet lists read best; use a table only for a few short columns, each row on one line. " +
          "Ground every statement in the context; say what is unknown rather than guessing. When the user asks to build, change or show " +
          "something, propose actions with the listed tools only (never invent tools or node ids — use ids exactly as in the context); " +
          "otherwise return an empty actions list. The user reviews and applies each action.",
        schema: SCHEMA,
        temperature: 0.1,
        // reasoning models think before the JSON: room for both, or the answer is cut off and fails
        maxTokens: 16000,
      });
      const actions: Action[] = (res.actions ?? [])
        .filter((a) => tools.has(a.tool))
        .map((a) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(a.args_json || "{}");
          } catch {
            /* shown with empty args; its preview reports the problem */
          }
          return { tool: a.tool, title: a.title, args };
        });
      setTurns([...next, { role: "assistant", text: res.answer || "(tanpa jawaban)", actions }]);
    } catch (e) {
      setTurns([...next, { role: "assistant", text: `AIP Assist tidak bisa menjawab: ${(e as Error).message}`, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const settle = (ti: number, ai: number, patch: Partial<Action>) =>
    setTurns((ts) => ts.map((t, i) => (i === ti ? { ...t, actions: t.actions?.map((a, j) => (j === ai ? { ...a, ...patch } : a)) } : t)));

  const apply = async (ti: number, ai: number, a: Action) => {
    const tool = tools.get(a.tool);
    if (!tool) return;
    try {
      const out = await tool.run(a.args);
      settle(ti, ai, { state: "applied", outcome: out || "Diterapkan" });
    } catch (e) {
      settle(ti, ai, { state: "failed", outcome: (e as Error).message });
    }
  };

  return (
    <aside className="fixed inset-0 z-50 flex flex-col border-r border-violet-400/30 bg-panel shadow-2xl md:static md:z-auto md:h-screen md:w-[400px] md:shrink-0 md:shadow-none" aria-label="AIP Assist">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="rounded-md bg-violet-500/20 p-1.5 text-violet-200">
          <Icon name="sparkle" className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">AIP Assist</div>
          <div className="truncate text-[11px] text-muted">{adapter.app}</div>
        </div>
        <button type="button" title="Percakapan baru" onClick={() => setTurns([])} className="rounded p-1 text-muted hover:text-white">
          <Icon name="refresh" className="h-4 w-4" />
        </button>
        <button type="button" title="Tutup (Ctrl+Shift+U)" onClick={onClose} className="rounded p-1 text-muted hover:text-white">
          <Icon name="x" className="h-4 w-4" />
        </button>
      </header>

      <div className="border-b border-line px-3 py-2 text-xs">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
          <Icon name="fit" className="h-3 w-3" /> Area yang ditanyakan
          {ctx.selection.length > 0 && adapter.onClearSelection && (
            <button type="button" onClick={adapter.onClearSelection} className="ml-auto normal-case tracking-normal text-ocean hover:underline">
              kosongkan
            </button>
          )}
        </div>
        {ctx.selection.length ? (
          <div className="flex max-h-20 flex-wrap gap-1 overflow-y-auto">
            {ctx.selection.slice(0, 30).map((s) => (
              <span key={s.id} className="max-w-[12rem] truncate rounded border border-violet-400/40 bg-violet-500/10 px-1.5 py-0.5 text-[11px] text-violet-100" title={s.label}>
                {s.label}
              </span>
            ))}
            {ctx.selection.length > 30 && <span className="text-muted">+{ctx.selection.length - 30}</span>}
          </div>
        ) : (
          <p className="text-muted">Seluruh dokumen. {adapter.selectHint}</p>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
        {!turns.length && (
          <div className="space-y-2">
            <p className="text-xs text-muted">Tanya, jelaskan, atau minta dibangunkan dengan bahasa alami. Usulan perubahan muncul sebagai kartu — tidak ada yang berubah sebelum kamu menekan Terapkan.</p>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Saran pertanyaan</div>
            {adapter.suggestions(ctx.selection.length > 0).map((s) => (
              <button key={s} type="button" onClick={() => ask(s)} className="block w-full rounded-md border border-line px-2.5 py-1.5 text-left text-xs text-soft hover:border-violet-400/60 hover:text-white">
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, ti) =>
          t.role === "user" ? (
            <div key={ti} className="ml-6 rounded-lg bg-ocean/15 px-3 py-2 text-sm">
              {t.text}
              {!!t.selection?.length && <div className="mt-1 truncate text-[10px] text-muted">area: {t.selection.slice(0, 6).join(", ")}{t.selection.length > 6 ? ` +${t.selection.length - 6}` : ""}</div>}
            </div>
          ) : (
            <div key={ti} className="space-y-2">
              <div className={`md-body text-sm ${t.error ? "text-bad" : "text-soft"}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(t.text) }} />
              {t.actions?.map((a, ai) => {
                const tool = tools.get(a.tool);
                const pv = tool?.preview?.(a.args) ?? {};
                const locked = adapter.readOnly && !tool?.safe;
                const blocked = !!pv.error || locked;
                return (
                  <div key={ai} className="rounded-lg border border-violet-400/40 bg-violet-500/5 p-2.5 text-xs">
                    <div className="flex items-center gap-1.5 font-medium text-violet-100">
                      <Icon name="bolt" className="h-3.5 w-3.5" /> {a.title}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-muted">{a.tool}</div>
                    {pv.text && <div className="mt-1 text-soft">{pv.text}</div>}
                    {pv.detail && <div className="mt-1.5">{pv.detail}</div>}
                    {pv.error && !a.state && <div className="mt-1 text-bad">{pv.error}</div>}
                    <details className="mt-1 text-[10px] text-muted">
                      <summary className="cursor-pointer">argumen</summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-ink p-1.5 font-mono" data-aip-args>{JSON.stringify(a.args, null, 1)}</pre>
                    </details>
                    {a.state ? (
                      <div className={`mt-1.5 ${a.state === "failed" ? "text-bad" : a.state === "skipped" ? "text-muted" : "text-emerald-300"}`}>
                        {a.state === "applied" ? "✓ " : a.state === "failed" ? "✕ " : ""}
                        {a.outcome ?? (a.state === "skipped" ? "Dilewati" : "")}
                      </div>
                    ) : (
                      <div className="mt-2 flex gap-1.5">
                        <button
                          type="button"
                          disabled={blocked}
                          title={locked ? "Dokumen ini hanya-baca" : pv.error}
                          onClick={() => apply(ti, ai, a)}
                          className="rounded-md bg-violet-500 px-2.5 py-1 font-medium text-white hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Terapkan
                        </button>
                        <button type="button" onClick={() => settle(ti, ai, { state: "skipped" })} className="rounded-md border border-line-2 px-2.5 py-1 text-soft hover:text-white">
                          Lewati
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Icon name="refresh" className="h-3.5 w-3.5 animate-spin" /> AIP Assist berpikir…
          </div>
        )}
        <div ref={end} />
      </div>

      <form
        className="border-t border-line p-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <div className="flex items-end gap-2 rounded-lg border border-line-2 bg-ink px-2 py-1.5 focus-within:border-violet-400/60">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            rows={2}
            placeholder={ctx.selection.length ? `Tanya tentang ${ctx.selection.length} item terpilih…` : "Tanya atau minta dibangunkan…"}
            className="max-h-40 min-h-[2.5rem] flex-1 resize-y bg-transparent text-sm outline-none placeholder:text-muted"
          />
          <button type="submit" disabled={!input.trim() || busy} className="rounded-md bg-violet-500 p-1.5 text-white disabled:opacity-40" aria-label="Kirim">
            <Icon name="right" className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-1 text-[10px] text-muted">Enter kirim · Shift+Enter baris baru · AI bisa keliru — periksa usulan sebelum menerapkan</div>
      </form>
    </aside>
  );
}
