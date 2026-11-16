"use client";

import "katex/dist/katex.min.css";
import DOMPurify from "dompurify";
import katex from "katex";
import { marked } from "marked";
import { memo, useEffect, useRef, useState } from "react";
import type { MimeBundle, Output } from "@/lib/jupyterLab";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ------------------------------------------------------------------------------------------------ ANSI

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

function color256(n: number): string {
  if (n < 16) return ["#3e424d", "#e75c58", "#00a250", "#ddb62b", "#208ffb", "#d160c4", "#60c6c8", "#c5c1b4", "#282c36", "#b22b31", "#007427", "#b27d12", "#0065ca", "#a03196", "#258f8f", "#a1a6b2"][n];
  if (n < 232) {
    const v = n - 16;
    const c = (x: number) => (x ? x * 40 + 55 : 0);
    return `rgb(${c(Math.floor(v / 36))},${c(Math.floor(v / 6) % 6)},${c(v % 6)})`;
  }
  const g = (n - 232) * 10 + 8;
  return `rgb(${g},${g},${g})`;
}

/** Text with ANSI SGR escapes (IPython tracebacks, colored logs) as HTML spans, like JupyterLab's ansi_up. */
export function ansiToHtml(text: string): string {
  let out = "";
  let fg: string | null = null;
  let bg: string | null = null;
  let bold = false;
  let italic = false;
  let underline = false;
  const parts = text.split(/\x1b\[([\d;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const chunk = parts[i].replace(/\x1b\[[\d;?]*[A-Za-z]/g, "");
      if (!chunk) continue;
      const cls: string[] = [];
      const style: string[] = [];
      if (fg) {
        if (fg.startsWith("ansi")) cls.push(fg);
        else style.push(`color:${fg}`);
      }
      if (bg) {
        if (bg.startsWith("ansi")) cls.push(bg);
        else style.push(`background-color:${bg}`);
      }
      if (bold) cls.push("ansi-bold");
      if (italic) cls.push("ansi-italic");
      if (underline) cls.push("ansi-underline");
      out += cls.length || style.length ? `<span${cls.length ? ` class="${cls.join(" ")}"` : ""}${style.length ? ` style="${style.join(";")}"` : ""}>${esc(chunk)}</span>` : esc(chunk);
      continue;
    }
    const codes = parts[i] === "" ? [0] : parts[i].split(";").map(Number);
    for (let j = 0; j < codes.length; j++) {
      const c = codes[j];
      if (c === 0) [fg, bg, bold, italic, underline] = [null, null, false, false, false];
      else if (c === 1) bold = true;
      else if (c === 3) italic = true;
      else if (c === 4) underline = true;
      else if (c === 22) bold = false;
      else if (c === 23) italic = false;
      else if (c === 24) underline = false;
      else if (c >= 30 && c <= 37) fg = `ansi-${NAMES[c - 30]}${bold ? "-intense" : ""}-fg`;
      else if (c === 39) fg = null;
      else if (c >= 40 && c <= 47) bg = `ansi-${NAMES[c - 40]}-bg`;
      else if (c === 49) bg = null;
      else if (c >= 90 && c <= 97) fg = `ansi-${NAMES[c - 90]}-intense-fg`;
      else if (c >= 100 && c <= 107) bg = `ansi-${NAMES[c - 100]}-intense-bg`;
      else if ((c === 38 || c === 48) && codes[j + 1] === 5) {
        const v = color256(codes[j + 2] ?? 0);
        if (c === 38) fg = v;
        else bg = v;
        j += 2;
      } else if ((c === 38 || c === 48) && codes[j + 1] === 2) {
        const v = `rgb(${codes[j + 2] ?? 0},${codes[j + 3] ?? 0},${codes[j + 4] ?? 0})`;
        if (c === 38) fg = v;
        else bg = v;
        j += 4;
      }
    }
  }
  return out;
}

/** What a terminal shows for a stream with carriage returns and backspaces (progress bars). */
export function fixConsole(text: string): string {
  if (!text.includes("\r") && !text.includes("\b")) return text;
  let s = text.replace(/\r\n/g, "\n");
  while (/[^\n]\x08/.test(s)) s = s.replace(/[^\n]\x08/g, "");
  return s
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const segs = line.split("\r");
      let cur = "";
      for (const seg of segs) cur = seg + cur.slice(seg.length);
      return cur;
    })
    .join("\n");
}

// ------------------------------------------------------------------------------------------------ sanitizing

let hooked = false;
function purify(html: string): string {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noreferrer noopener");
      }
    });
  }
  return DOMPurify.sanitize(html, { ADD_TAGS: ["style"], FORBID_TAGS: ["script", "iframe", "object", "embed", "form"], ADD_ATTR: ["target"] });
}

// ------------------------------------------------------------------------------------------------ markdown + math

marked.setOptions({ gfm: true, breaks: false });

/** Markdown as JupyterLab renders it: GitHub-flavored, inline HTML (sanitized), $…$ and $$…$$ math with KaTeX,
 *  headings with ids (the table of contents and #links), attachment: images. */
export function renderMarkdown(src: string, attachments?: Record<string, MimeBundle>): string {
  const math: string[] = [];
  const keep = (tex: string, display: boolean) => {
    math.push(katex.renderToString(tex, { throwOnError: false, displayMode: display }));
    return `@@MATH${math.length - 1}@@`;
  };
  // fenced and inline code stay as they are; math is taken out before Markdown sees it
  const blocks: string[] = [];
  let text = src.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (m) => {
    blocks.push(m);
    return `@@CODE${blocks.length - 1}@@`;
  });
  text = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => keep(tex, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => keep(tex, true))
    .replace(/\\begin\{(equation|align|gather)\*?\}[\s\S]+?\\end\{\1\*?\}/g, (m) => keep(m, true))
    .replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (_, pre: string, tex: string) => pre + keep(tex, false))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex: string) => keep(tex, false));
  text = text.replace(/@@CODE(\d+)@@/g, (_, i: string) => blocks[Number(i)]);
  let html = marked.parse(text, { async: false }) as string;
  html = html.replace(/@@MATH(\d+)@@/g, (_, i: string) => math[Number(i)]);
  if (attachments)
    html = html.replace(/src="attachment:([^"]+)"/g, (m, name: string) => {
      const b = attachments[decodeURIComponent(name)];
      const mime = b && Object.keys(b).find((k) => k.startsWith("image/"));
      return mime ? `src="data:${mime};base64,${String(b[mime]).replace(/\s/g, "")}"` : m;
    });
  const clean = purify(html);
  // ids on headings, as JupyterLab adds them
  return clean.replace(/<(h[1-6])>([\s\S]*?)<\/\1>/g, (_, tag: string, inner: string) => {
    const id = inner.replace(/<[^>]+>/g, "").trim().replace(/\s+/g, "-");
    return `<${tag} id="${esc(id)}">${inner}</${tag}>`;
  });
}

export const MarkdownView = memo(function MarkdownView({ source, attachments, onDoubleClick }: { source: string; attachments?: Record<string, MimeBundle>; onDoubleClick?: () => void }) {
  const empty = !source.trim();
  return (
    <div
      className={`jp-MarkdownOutput jp-RenderedHTMLCommon${empty ? " jp-mod-empty" : ""}`}
      onDoubleClick={onDoubleClick}
      dangerouslySetInnerHTML={{ __html: empty ? `Type Markdown and LaTeX: ${katex.renderToString("\\alpha^2", { throwOnError: false })}` : renderMarkdown(source, attachments) }}
    />
  );
});

// ------------------------------------------------------------------------------------------------ outputs

const ORDER = [
  "application/vnd.vegalite.v5+json",
  "application/vnd.vegalite.v4+json",
  "application/vnd.vega.v5+json",
  "text/html",
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "text/markdown",
  "text/latex",
  "application/json",
  "text/plain",
];

function VegaView({ spec }: { spec: unknown }) {
  const el = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let done = false;
    let finalize: (() => void) | undefined;
    import("vega-embed")
      .then(({ default: embed }) => embed(el.current!, spec as never, { actions: { export: true, source: false, compiled: false, editor: false } }))
      .then((r) => {
        if (done) r.finalize();
        else finalize = () => r.finalize();
      })
      .catch((e: Error) => setErr(e.message));
    return () => {
      done = true;
      finalize?.();
    };
  }, [spec]);
  return err ? <pre className="jp-ErrorText">{err}</pre> : <div ref={el} />;
}

function size(md: Record<string, unknown>, mime: string): React.CSSProperties {
  const m = (md[mime] as Record<string, unknown>) ?? md;
  const out: React.CSSProperties = {};
  if (typeof m.width === "number") out.width = m.width;
  if (typeof m.height === "number") out.height = m.height;
  return out;
}

function MimeView({ data, metadata }: { data: MimeBundle; metadata: Record<string, unknown> }) {
  const mime = ORDER.find((m) => data[m] !== undefined) ?? Object.keys(data).find((k) => k !== "text/plain") ?? "text/plain";
  const v = data[mime];
  if (mime.includes("vegalite") || mime.includes("vega.")) return <VegaView spec={v} />;
  if (mime === "text/html") return <div className="jp-RenderedHTMLCommon jp-RenderedHTML" dangerouslySetInnerHTML={{ __html: purify(String(v)) }} />;
  if (mime === "image/svg+xml")
    // eslint-disable-next-line @next/next/no-img-element -- kernel output is a data URI
    return <img alt="" style={size(metadata, mime)} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(String(v))}`} />;
  if (mime.startsWith("image/"))
    // eslint-disable-next-line @next/next/no-img-element -- kernel output is a data URI
    return <img alt="" className={mime === "image/png" ? "jp-mod-png" : undefined} style={size(metadata, mime)} src={`data:${mime};base64,${String(v).replace(/\s/g, "")}`} />;
  if (mime === "text/markdown") return <div className="jp-RenderedHTMLCommon" dangerouslySetInnerHTML={{ __html: renderMarkdown(String(v)) }} />;
  if (mime === "text/latex") {
    const tex = String(v).replace(/^\$\$?|\$\$?$/g, "");
    return <div className="jp-RenderedHTMLCommon" dangerouslySetInnerHTML={{ __html: katex.renderToString(tex, { throwOnError: false, displayMode: true }) }} />;
  }
  if (mime.includes("json")) return <pre className="jp-RenderedJSON">{JSON.stringify(v, null, 2)}</pre>;
  return (
    <div className="jp-RenderedText">
      <pre dangerouslySetInnerHTML={{ __html: ansiToHtml(String(v ?? "")) }} />
    </div>
  );
}

export const OutputView = memo(function OutputView({ output }: { output: Output }) {
  if (output.output_type === "stream")
    return (
      <div className={`jp-OutputArea-output jp-RenderedText${output.name === "stderr" ? " jp-mod-stderr" : ""}`}>
        <pre dangerouslySetInnerHTML={{ __html: ansiToHtml(fixConsole(output.text)) }} />
      </div>
    );
  if (output.output_type === "error")
    return (
      <div className="jp-OutputArea-output jp-RenderedText jp-mod-error">
        <pre dangerouslySetInnerHTML={{ __html: ansiToHtml((output.traceback.length ? output.traceback : [`${output.ename}: ${output.evalue}`]).join("\n")) }} />
      </div>
    );
  return (
    <div className="jp-OutputArea-output">
      <MimeView data={output.data} metadata={output.metadata ?? {}} />
    </div>
  );
});

/** The tooltip of Shift+Tab: the kernel's inspection (signature and docstring). */
export function InspectTooltip({ data, at, onClose }: { data: MimeBundle; at: { x: number; y: number }; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    const t = setTimeout(() => {
      window.addEventListener("mousedown", close);
      window.addEventListener("keydown", close);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [onClose]);
  const text = String(data["text/plain"] ?? "");
  return (
    <div className="jp-Tooltip" style={{ left: Math.min(at.x, window.innerWidth - 740), top: at.y + 4 }}>
      <pre dangerouslySetInnerHTML={{ __html: ansiToHtml(text) }} />
    </div>
  );
}
