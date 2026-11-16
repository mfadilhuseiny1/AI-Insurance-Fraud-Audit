/** Workshop's Markdown widget on top of the shared renderer (lib/markdown.ts): pipe tables with alignment,
 * ==highlights== and object references — :objectreference[text]{objectType="…" primaryKey="…"} — rendered as
 * selectable spans (data-ref-type / data-ref-pk). HTML in the source stays text, as in Workshop. */

import { renderMarkdown } from "./markdown";

const REF = /:objectreference\[([^\]]*)\]\{\s*objectType="([^"]+)"\s+primaryKey="([^"]*)"\s*\}/g;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type MdRef = { type: string; pk: string; text: string };

/** The object references in a Markdown text. */
export const mdRefs = (src: string): MdRef[] => [...src.matchAll(REF)].map((m) => ({ text: m[1], type: m[2], pk: m[3] }));

function inlineCell(s: string): string {
  // a cell's Markdown, without the paragraph the renderer wraps it in
  return renderMarkdown(s).replace(/^<p>/, "").replace(/<\/p>$/, "");
}

function table(lines: string[]): string {
  const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => x.trim());
  const head = cells(lines[0]);
  const align = cells(lines[1]).map((a) => (a.startsWith(":") && a.endsWith(":") ? "center" : a.endsWith(":") ? "right" : "left"));
  const row = (cs: string[], tag: "th" | "td") => `<tr>${cs.map((c, i) => `<${tag} style="text-align:${align[i] ?? "left"}">${inlineCell(c)}</${tag}>`).join("")}</tr>`;
  return `<table class="md-table"><thead>${row(head, "th")}</thead><tbody>${lines.slice(2).map((l) => row(cells(l), "td")).join("")}</tbody></table>`;
}

export function renderWorkshopMarkdown(src: string, colors: Record<string, string> = {}, selected?: { type: string; pk: string } | null): string {
  const refs: MdRef[] = [];
  // references become tokens the renderer leaves alone, then spans
  let text = src.replace(/\r\n?/g, "\n").replace(REF, (_, t: string, type: string, pk: string) => {
    refs.push({ text: t, type, pk });
    return `\u0001R${refs.length - 1}\u0001`;
  });
  const tables: string[] = [];
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|.*\|\s*$/.test(lines[i]) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const block = [lines[i], lines[i + 1]];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) block.push(lines[i]);
      i--;
      tables.push(table(block));
      kept.push("", `\u0002T${tables.length - 1}\u0002`, "");
    } else kept.push(lines[i]);
  }
  text = kept.join("\n");
  let html = renderMarkdown(text);
  html = html.replace(/<p>\u0002T(\d+)\u0002<\/p>|\u0002T(\d+)\u0002/g, (_, a: string, b: string) => tables[Number(a ?? b)]);
  html = html.replace(/==([^=<\n][^=<]*?)==/g, "<mark>$1</mark>");
  html = html.replace(/\u0001R(\d+)\u0001/g, (_, i: string) => {
    const r = refs[Number(i)];
    const color = colors[r.type];
    const on = !!selected && selected.type === r.type && selected.pk === r.pk;
    return `<span class="ws-ref${on ? " ws-ref-on" : ""}" role="button" tabindex="0" data-ref-type="${esc(r.type)}" data-ref-pk="${esc(r.pk)}"${color ? ` style="--ref:${esc(color)}"` : ""}>${esc(r.text)}</span>`;
  });
  return html;
}

export const WS_MARKDOWN_CSS = `
.md-table { border-collapse: collapse; margin: 6px 0; font-size: 12px; }
.md-table th, .md-table td { border: 1px solid var(--color-line); padding: 3px 8px; }
.md-table th { background: var(--color-panel-2); }
.md-body mark { background: color-mix(in srgb, #e3b341 45%, transparent); color: inherit; border-radius: 2px; padding: 0 2px; }
.ws-ref { cursor: pointer; border-radius: 3px; padding: 0 3px; background: color-mix(in srgb, var(--ref, #1f6feb) 22%, transparent); color: var(--ref, var(--color-ocean)); border-bottom: 1px solid var(--ref, #1f6feb); }
.ws-ref:hover, .ws-ref-on { background: color-mix(in srgb, var(--ref, #1f6feb) 40%, transparent); }
.ws-annot { border-radius: 2px; cursor: pointer; }
`;
