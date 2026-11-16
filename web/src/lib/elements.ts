import type { ParseElement } from "./api";

const RTL: Record<string, string> = { ara: "ar", fas: "fa", urd: "ur", heb: "he", pus: "ps", yid: "yi" };

export function rtlLang(el: ParseElement): string | null {
  const lang = el.metadata.languages?.[0];
  return lang ? RTL[lang] ?? null : null;
}

export function isPageFurniture(el: ParseElement): boolean {
  return el.type === "Header" || el.type === "Footer" || el.type === "PageNumber";
}

/** Same rules as unstructured's elements_to_md(rtl_aware=True). */
export function toMarkdown(elements: ParseElement[]): string {
  return elements
    .map((el) => {
      let md = el.text;
      if (el.type === "Title") md = `# ${el.text}`;
      else if (el.type === "Table" && el.metadata.text_as_html) md = el.metadata.text_as_html;
      const lang = rtlLang(el);
      return lang ? `<div dir="rtl" lang="${lang}">\n\n${md}\n\n</div>` : md;
    })
    .join("\n\n");
}

export function toText(elements: ParseElement[]): string {
  return elements
    .map((el) => el.text)
    .filter(Boolean)
    .join("\n\n");
}

export function groupByPage(elements: ParseElement[]): Map<number, ParseElement[]> {
  const pages = new Map<number, ParseElement[]>();
  for (const el of elements) {
    const p = el.metadata.page_number;
    if (!pages.has(p)) pages.set(p, []);
    pages.get(p)!.push(el);
  }
  return pages;
}

export function countBy<T>(items: T[], key: (item: T) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const TABLE_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col", "br"]);
const KEEP_ATTRS = new Set(["colspan", "rowspan"]);

/** Table HTML comes from model output: keep only table structure, no other tags or attributes. */
export function sanitizeTableHtml(html: string): string {
  if (typeof window === "undefined") return "";
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const clean = (node: Element) => {
    for (const child of [...node.children]) {
      const tag = child.tagName.toLowerCase();
      if (!TABLE_TAGS.has(tag)) {
        child.replaceWith(doc.createTextNode(child.textContent ?? ""));
        continue;
      }
      for (const attr of [...child.attributes]) {
        if (!KEEP_ATTRS.has(attr.name.toLowerCase())) child.removeAttribute(attr.name);
      }
      clean(child);
    }
  };
  const root = doc.body.firstElementChild!;
  clean(root);
  return root.innerHTML;
}
