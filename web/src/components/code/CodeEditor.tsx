"use client";

import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";

const KEYWORDS =
  /\b(False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/;
const BUILTINS = /\b(print|len|range|list|dict|set|tuple|str|int|float|bool|sum|min|max|sorted|enumerate|zip|map|filter|isinstance|self)\b/;
const R_KEYWORDS = /\b(TRUE|FALSE|NULL|NA|NA_integer_|NA_real_|NA_character_|Inf|NaN|function|if|else|repeat|while|for|in|next|break)\b/;
const R_BUILTINS = /\b(library|require|source|data\.frame|read\.csv|write\.csv|c|list|print|nrow|ncol|names|subset|as\.data\.frame|is\.na|seq_len|stop|message|cat|paste0)\b/;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Lightweight Python/R and Markdown highlighting, line by line; good enough for transforms. */
function highlight(code: string, lang: "python" | "r" | "markdown" | "text"): string {
  if (lang === "text") return esc(code);
  if (lang === "markdown")
    return code
      .split("\n")
      .map((l) => (/^#{1,6} /.test(l) ? `<span class="tok-kw">${esc(l)}</span>` : /^\s*[-*] /.test(l) ? `<span class="tok-fn">${esc(l.slice(0, l.indexOf(" ") + 1))}</span>${esc(l.slice(l.indexOf(" ") + 1))}` : esc(l)))
      .join("\n");
  const token = /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*|@[A-Za-z_][\w.]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g;
  let out = "";
  let last = 0;
  let prev = "";
  for (const m of code.matchAll(token)) {
    out += esc(code.slice(last, m.index));
    const t = m[0];
    let cls = "";
    if (t.startsWith("#")) cls = "tok-com";
    else if (t.startsWith('"') || t.startsWith("'")) cls = "tok-str";
    else if (t.startsWith("@")) cls = "tok-dec";
    else if (/^\d/.test(t)) cls = "tok-num";
    else if ((lang === "r" ? R_KEYWORDS : KEYWORDS).test(t) && (lang === "r" ? R_KEYWORDS : KEYWORDS).exec(t)![0] === t) cls = "tok-kw";
    else if (prev === "def" || prev === "class") cls = "tok-fn";
    else if ((lang === "r" ? R_BUILTINS : BUILTINS).test(t) && (lang === "r" ? R_BUILTINS : BUILTINS).exec(t)![0] === t) cls = "tok-bi";
    out += cls ? `<span class="${cls}">${esc(t)}</span>` : esc(t);
    if (/^[A-Za-z_]/.test(t)) prev = t;
    last = (m.index ?? 0) + t.length;
  }
  return out + esc(code.slice(last));
}

export function langOf(path: string): "python" | "r" | "markdown" | "text" {
  return path.endsWith(".py") ? "python" : path.toLowerCase().endsWith(".r") ? "r" : path.endsWith(".md") ? "markdown" : "text";
}

export type EditorBreakpoint = { line: number; condition?: string | null; verified?: boolean | null; message?: string | null };

const LINE_PX = 20;
const PAD_PX = 8;

/** A textarea over a highlighted <pre>: line numbers, Tab = 4 spaces, Enter keeps the indent.
 * With onToggleBreakpoint, clicking a line number toggles a breakpoint (right-click: a condition);
 * currentLine is the debugger's paused line (highlighted and scrolled into view). */
export function CodeEditor({
  value,
  onChange,
  path,
  readOnly,
  highlightLine,
  breakpoints,
  onToggleBreakpoint,
  onEditBreakpoint,
  currentLine,
}: {
  value: string;
  onChange: (v: string) => void;
  path: string;
  readOnly?: boolean;
  highlightLine?: number;
  breakpoints?: EditorBreakpoint[];
  onToggleBreakpoint?: (line: number) => void;
  onEditBreakpoint?: (line: number) => void;
  currentLine?: number | null;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const html = useMemo(() => highlight(value, langOf(path)) + "\n", [value, path]);
  const lines = value.split("\n").length;
  const bpByLine = useMemo(() => new Map((breakpoints ?? []).map((b) => [b.line, b])), [breakpoints]);

  useEffect(() => {
    const el = area.current;
    if (!el || !currentLine) return;
    const top = (currentLine - 1) * LINE_PX;
    if (top < el.scrollTop || top + LINE_PX > el.scrollTop + el.clientHeight - PAD_PX * 2) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
      if (pre.current) pre.current.scrollTop = el.scrollTop;
      if (gutter.current) gutter.current.scrollTop = el.scrollTop;
    }
    if (mark.current) mark.current.style.transform = `translateY(${-el.scrollTop}px)`;
  }, [currentLine]);

  const edit = (text: string, start: number, end: number, caret: number) => {
    const el = area.current!;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = caret;
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (readOnly) return;
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: en, value: v } = el;
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        const lineStart = v.lastIndexOf("\n", s - 1) + 1;
        const remove = v.slice(lineStart, lineStart + 4).match(/^ {1,4}/)?.[0].length ?? 0;
        if (remove) edit("", lineStart, lineStart + remove, Math.max(lineStart, s - remove));
      } else edit("    ", s, en, s + 4);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const lineStart = v.lastIndexOf("\n", s - 1) + 1;
      const line = v.slice(lineStart, s);
      let indent = line.match(/^\s*/)?.[0] ?? "";
      if (/[:([{]\s*$/.test(line)) indent += "    ";
      edit("\n" + indent, s, en, s + 1 + indent.length);
    }
  };

  return (
    <div className="code-editor relative flex min-h-0 flex-1 overflow-hidden bg-ink font-mono text-[13px] leading-[20px]">
      <div ref={gutter} className={`${onToggleBreakpoint ? "w-14" : "w-12"} shrink-0 select-none overflow-hidden border-r border-line bg-panel py-2 pr-2 text-right text-muted`}>
        {Array.from({ length: lines }, (_, i) => {
          const line = i + 1;
          const bp = bpByLine.get(line);
          const cls = `${currentLine === line ? "bg-sand/20 text-white" : highlightLine === line ? "text-sand" : ""}`;
          if (!onToggleBreakpoint)
            return (
              <div key={i} className={cls}>
                {line}
              </div>
            );
          return (
            <div
              key={i}
              role="button"
              tabIndex={-1}
              title={bp ? (bp.message ?? (bp.condition ? `Breakpoint if ${bp.condition}` : "Breakpoint")) + " — click to remove, right-click for a condition" : "Click to add a breakpoint"}
              onClick={() => onToggleBreakpoint(line)}
              onContextMenu={(e) => {
                if (!onEditBreakpoint) return;
                e.preventDefault();
                onEditBreakpoint(line);
              }}
              className={`group relative cursor-pointer pl-4 hover:text-white ${cls}`}
            >
              <span
                className={`absolute left-1.5 top-[5px] h-2.5 w-2.5 rounded-full ${
                  bp ? (bp.verified === false ? "border border-bad bg-transparent" : bp.condition ? "bg-sand ring-1 ring-bad" : "bg-bad") : "bg-bad/0 group-hover:bg-bad/40"
                }`}
              />
              {line}
            </div>
          );
        })}
      </div>
      <div className="relative min-w-0 flex-1">
        {currentLine ? (
          <div
            ref={mark}
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 border-y border-sand/40 bg-sand/10"
            style={{ top: PAD_PX + (currentLine - 1) * LINE_PX, height: LINE_PX }}
          />
        ) : null}
        <pre
          ref={pre}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre px-3 py-2 text-soft"
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <textarea
          ref={area}
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          onScroll={(e) => {
            const t = e.currentTarget;
            if (pre.current) {
              pre.current.scrollTop = t.scrollTop;
              pre.current.scrollLeft = t.scrollLeft;
            }
            if (gutter.current) gutter.current.scrollTop = t.scrollTop;
            if (mark.current) mark.current.style.transform = `translateY(${-t.scrollTop}px)`;
          }}
          className="absolute inset-0 h-full w-full resize-none overflow-auto whitespace-pre bg-transparent px-3 py-2 text-transparent caret-white outline-none selection:bg-ocean/40"
        />
      </div>
    </div>
  );
}
