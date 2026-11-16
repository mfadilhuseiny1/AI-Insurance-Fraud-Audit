"use client";

import { useEffect, useMemo, useState } from "react";
import { api, downloadUrl, type Chunk, type Job, type ParseElement } from "@/lib/api";
import { chunkColor } from "@/lib/chunks";
import { countBy, isPageFurniture, rtlLang, sanitizeTableHtml, toMarkdown, toText } from "@/lib/elements";
import { pageRanges } from "@/lib/format";
import { Icon, type IconName } from "./Icon";
import { RESULT_FORMATS, SaveToFiles } from "./SaveToFiles";

type View = "rendered" | "markdown" | "text" | "json";
const VIEWS: { id: View; label: string; icon: IconName }[] = [
  { id: "rendered", label: "Rendered", icon: "doc" },
  { id: "markdown", label: "Markdown", icon: "code" },
  { id: "text", label: "Text", icon: "parse" },
  { id: "json", label: "JSON", icon: "layers" },
];

export function ResultsPanel({
  job,
  page,
  onPage,
  standalone = false,
  activeChunk = null,
  onActiveChunk,
}: {
  job: Job;
  page: number;
  onPage: (page: number) => void;
  /** true on the full-page result view, which hides the "open in new tab" button */
  standalone?: boolean;
  /** the chunk highlighted here and on the page preview */
  activeChunk?: number | null;
  onActiveChunk?: (chunk: number | null) => void;
}) {
  // ?view=markdown etc. opens a specific view (shareable links)
  const [view, setView] = useState<View>(() => {
    const v = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("view");
    return VIEWS.some((x) => x.id === v) ? (v as View) : "rendered";
  });
  const [allPages, setAllPages] = useState(false);
  const [hideFurniture, setHideFurniture] = useState(false);
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState(false);
  // results are fetched per page (small), and the whole document only when "All pages" is chosen
  const [pages, setPages] = useState<Record<number, ParseElement[]>>({});
  const [all, setAll] = useState<ParseElement[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // RAG chunks, shown in the Text and Markdown views so users can see where the text is split
  const [showChunks, setShowChunks] = useState(true);
  const [pageChunks, setPageChunks] = useState<Record<number, Chunk[]>>({});
  const [allChunks, setAllChunks] = useState<Chunk[] | null>(null);
  const inRange = page >= job.page_from && page <= job.page_to;
  const chunkMode = showChunks && (view === "text" || view === "markdown");

  useEffect(() => {
    if (!chunkMode) return;
    let stale = false;
    if (allPages && allChunks === null) {
      api
        .chunks(job.id)
        .then((r) => !stale && setAllChunks(r))
        .catch((e: Error) => !stale && setLoadError(e.message));
    } else if (!allPages && inRange && pageChunks[page] === undefined) {
      api
        .chunks(job.id, page)
        .then((r) => !stale && setPageChunks((p) => ({ ...p, [page]: r })))
        .catch((e: Error) => !stale && setLoadError(e.message));
    }
    return () => {
      stale = true;
    };
  }, [chunkMode, allPages, allChunks, page, pageChunks, inRange, job.id]);

  const chunks = (allPages ? allChunks : pageChunks[page]) ?? null;

  useEffect(() => {
    let stale = false;
    if (allPages && all === null) {
      api
        .result(job.id)
        .then((r) => !stale && setAll(r))
        .catch((e: Error) => !stale && setLoadError(e.message));
    } else if (!allPages && inRange && pages[page] === undefined) {
      api
        .page(job.id, page)
        .then((r) => !stale && setPages((p) => ({ ...p, [page]: r })))
        .catch((e: Error) => !stale && setLoadError(e.message));
    }
    return () => {
      stale = true;
    };
  }, [allPages, all, page, pages, inRange, job.id]);

  const loading = chunkMode
    ? (allPages || inRange) && chunks === null
    : allPages
      ? all === null
      : inRange && pages[page] === undefined;
  const scoped = useMemo(() => {
    const els = (allPages ? all : pages[page]) ?? [];
    return hideFurniture ? els.filter((e) => !isPageFurniture(e)) : els;
  }, [allPages, all, pages, page, hideFurniture]);

  const asString = () =>
    chunkMode && chunks
      ? chunks
          .map((c) => `===== Chunk ${c.index + 1} · ${pageLabel(c.page_numbers)} =====\n\n${view === "markdown" ? c.markdown : c.text}`)
          .join("\n\n")
      : view === "markdown" || view === "rendered"
        ? toMarkdown(scoped)
        : view === "text"
          ? toText(scoped)
          : JSON.stringify(scoped, null, 2);

  const copy = async () => {
    await navigator.clipboard.writeText(asString());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <div className="flex rounded-lg border border-line bg-ink p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setView(v.id)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${
                view === v.id ? "bg-panel-2 text-white ring-1 ring-line-2" : "text-muted hover:text-white"
              }`}
            >
              <Icon name={v.icon} className="h-3.5 w-3.5" />
              {v.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 text-xs">
          <button
            type="button"
            onClick={() => setAllPages(false)}
            className={`rounded-md px-2 py-1 ${!allPages ? "text-white" : "text-muted hover:text-white"}`}
          >
            This page
          </button>
          <button
            type="button"
            onClick={() => setAllPages(true)}
            className={`rounded-md px-2 py-1 ${allPages ? "text-white" : "text-muted hover:text-white"}`}
          >
            All pages
          </button>
        </div>

        {!allPages && (
          <div className="flex items-center gap-1 text-xs text-soft">
            <button type="button" onClick={() => onPage(page - 1)} disabled={page <= job.page_from} className="rounded p-1 hover:bg-panel-2 disabled:opacity-30">
              <Icon name="left" className="h-3.5 w-3.5" />
            </button>
            <span className="tabular-nums">
              {page} / {job.page_to}
            </span>
            <button type="button" onClick={() => onPage(page + 1)} disabled={page >= job.page_to} className="rounded p-1 hover:bg-panel-2 disabled:opacity-30">
              <Icon name="right" className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {view === "text" || view === "markdown" ? (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={showChunks} onChange={(e) => setShowChunks(e.target.checked)} className="accent-ocean" />
            Show chunks
          </label>
        ) : null}
        {!chunkMode && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={hideFurniture} onChange={(e) => setHideFurniture(e.target.checked)} className="accent-ocean" />
            Hide headers/footers
          </label>
        )}

        <div className="relative ml-auto flex items-center gap-1">
          {!standalone && (
            <a
              href={`/parse/${job.id}/result?view=${view}${allPages ? "" : `&page=${page}`}`}
              target="_blank"
              rel="noopener"
              title="Open results in a new tab"
              className="rounded-md border border-line p-1.5 text-soft hover:text-white"
            >
              <Icon name="external" className="h-3.5 w-3.5" />
            </a>
          )}
          <button type="button" onClick={copy} title="Copy" className="rounded-md border border-line p-1.5 text-soft hover:text-white">
            <Icon name={copied ? "check" : "copy"} className="h-3.5 w-3.5" />
          </button>
          <SaveToFiles
            title={`Save results of ${job.file_name} to Files`}
            formats={RESULT_FORMATS}
            save={(formats, parentId) => api.saveToFiles(job.id, formats, parentId)}
          />
          <button
            type="button"
            onClick={() => setMenu(!menu)}
            className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-soft hover:text-white"
          >
            <Icon name="download" className="h-3.5 w-3.5" /> Download
          </button>
          {menu && (
            <div className="absolute right-0 top-9 z-10 w-44 overflow-hidden rounded-lg border border-line-2 bg-panel-2 py-1 shadow-xl">
              {(["json", "md", "txt"] as const).map((fmt) => (
                <a
                  key={fmt}
                  href={downloadUrl(job.id, fmt)}
                  onClick={() => setMenu(false)}
                  className="block px-3 py-1.5 text-sm hover:bg-line"
                >
                  {{ json: "JSON (elements)", md: "Markdown", txt: "Plain text" }[fmt]}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      <NotParsedNotice job={job} />

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {!allPages && !inRange ? (
          <Empty text={`Page ${page} was not part of this job (pages ${job.page_from}–${job.page_to}).`} />
        ) : loadError ? (
          <Empty text={`Could not load the results: ${loadError}`} />
        ) : loading ? (
          <Empty text={allPages ? "Loading all pages…" : `Loading page ${page}…`} />
        ) : chunkMode && chunks && chunks.length > 0 ? (
          <ChunkList
            chunks={chunks}
            total={job.chunks}
            chunking={job.chunking ?? null}
            markdown={view === "markdown"}
            page={allPages ? null : page}
            active={activeChunk}
            onActive={onActiveChunk}
          />
        ) : (chunkMode ? !chunks?.length : scoped.length === 0) ? (
          <Empty
            text={
              job.pages_not_parsed.includes(page)
                ? `Page ${page} could not be parsed and was not charged.`
                : job.tier === "fast" || job.tier === "cost_effective"
                  ? `Page ${page} has no text layer — it is probably an image, such as a cover or a scan. ${job.tier_label} reads only the text inside a PDF; use Agentic to read images.`
                  : `No text was found on page ${page}.`
            }
          />
        ) : view === "rendered" ? (
          <Rendered elements={scoped} showPageBreaks={allPages} />
        ) : view === "json" ? (
          <JsonView elements={scoped} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-soft">
            {view === "markdown" ? toMarkdown(scoped) : toText(scoped)}
          </pre>
        )}
      </div>
    </div>
  );
}

function pageLabel(pages: number[]): string {
  if (!pages.length) return "";
  const first = pages[0];
  const last = pages[pages.length - 1];
  return first === last ? `page ${first}` : `pages ${first}–${last}`;
}

/** Each RAG chunk as its own block, so the split points are visible. */
function ChunkList({
  chunks,
  total,
  chunking,
  markdown,
  page,
  active,
  onActive,
}: {
  chunks: Chunk[];
  total: number | null;
  chunking: "semantic" | "heading" | null;
  markdown: boolean;
  page: number | null;
  active: number | null;
  onActive?: (chunk: number | null) => void;
}) {
  return (
    <div className="space-y-4">
      {chunking && (
        <p className="text-xs text-muted">
          {chunking === "semantic" ? "Split by topic (semantic chunking)." : "Split at headings."}
        </p>
      )}
      {chunks.map((c) => {
        const first = c.page_numbers[0];
        const last = c.page_numbers[c.page_numbers.length - 1];
        const color = chunkColor(c.index);
        return (
          <section
            key={c.index}
            id={`chunk-${c.index}`}
            onMouseEnter={() => onActive?.(c.index)}
            onMouseLeave={() => onActive?.(null)}
            className={`scroll-mt-4 overflow-hidden rounded-lg border border-l-4 border-line transition-shadow ${
              active === c.index ? "ring-1 ring-line-2" : ""
            }`}
            style={{ borderLeftColor: color }}
          >
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel-2 px-3 py-1.5 text-[11px] text-muted">
              <span className="font-semibold" style={{ color }}>
                Chunk {c.index + 1}
                {total ? <span className="font-normal text-muted"> / {total}</span> : null}
              </span>
              <span>{pageLabel(c.page_numbers)}</span>
              <span>{c.text.length.toLocaleString("id-ID")} chars</span>
              {page !== null && first < page && <span className="text-soft">↑ continues from page {first}</span>}
              {page !== null && last > page && <span className="text-soft">↓ continues on page {last}</span>}
            </header>
            <pre dir="auto" className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[13px] leading-relaxed text-soft">
              {markdown ? c.markdown : c.text}
            </pre>
          </section>
        );
      })}
    </div>
  );
}

function NotParsedNotice({ job }: { job: Job }) {
  const pages = job.pages_not_parsed;
  if (!pages.length) return null;
  return (
    <div className="flex items-center gap-2 border-b border-line bg-bad/10 px-4 py-2 text-xs text-bad">
      <Icon name="alert" className="h-3.5 w-3.5" />
      {pages.length} page{pages.length === 1 ? "" : "s"} could not be parsed ({pageRanges(pages)}).
    </div>
  );
}

function Rendered({ elements, showPageBreaks }: { elements: ParseElement[]; showPageBreaks: boolean }) {
  return (
    <article className="mx-auto max-w-3xl space-y-3 text-[15px] leading-relaxed">
      {elements.map((el, i) => {
        const lang = rtlLang(el);
        const pageBreak =
          showPageBreaks && (i === 0 || elements[i - 1].metadata.page_number !== el.metadata.page_number);
        return (
          // index in the key: results from older jobs may repeat an element id
          <div key={`${el.element_id}-${i}`}>
            {pageBreak && (
              <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wider text-muted">
                <span className="h-px flex-1 bg-line" /> page {el.metadata.page_number} <span className="h-px flex-1 bg-line" />
              </div>
            )}
            <ElementBlock el={el} lang={lang} />
          </div>
        );
      })}
    </article>
  );
}

function ElementBlock({ el, lang }: { el: ParseElement; lang: string | null }) {
  const dir = lang ? { dir: "rtl" as const, lang } : {};

  if (isPageFurniture(el)) {
    return (
      <div className="text-xs text-muted" {...dir}>
        <span className="mr-2 rounded bg-line px-1 py-0.5 text-[10px] uppercase">{el.type}</span>
        {el.text}
      </div>
    );
  }
  if (el.metadata.is_footnote) {
    return (
      <p className="border-l-2 border-line-2 pl-3 text-[13px] text-soft" {...dir}>
        {el.text}
        
      </p>
    );
  }
  switch (el.type) {
    case "Title":
      return (
        <h3 className="pt-2 text-lg font-semibold text-white" {...dir}>
          {el.text}
          
        </h3>
      );
    case "ListItem":
      return (
        <p className="flex gap-2 text-soft" {...dir}>
          <span className="text-ocean">•</span>
          <span>
            {el.text}
            
          </span>
        </p>
      );
    case "Table":
      return el.metadata.text_as_html ? (
        <div className="result-table overflow-x-auto" dangerouslySetInnerHTML={{ __html: sanitizeTableHtml(el.metadata.text_as_html) }} />
      ) : (
        <pre className="whitespace-pre-wrap text-sm">{el.text}</pre>
      );
    case "Image": {
      // Fast tier: caption and description written by a vision model
      const image = el.metadata.image as { caption?: string; description?: string } | undefined;
      return image?.caption || image?.description ? (
        <figure className="rounded-lg border border-line bg-panel-2 px-4 py-3" {...dir}>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted">
            <Icon name="doc" className="h-3 w-3" /> Image
          </div>
          {image.caption && <figcaption className="font-medium text-white">{image.caption}</figcaption>}
          {image.description && <p className="mt-1 text-sm text-soft">{image.description}</p>}
        </figure>
      ) : (
        <p className="text-sm italic text-muted">{el.text || "[image]"}</p>
      );
    }
    default:
      return (
        <p className={lang ? "text-xl text-white" : "text-soft"} {...dir}>
          {el.text}
          
        </p>
      );
  }
}

function JsonView({ elements }: { elements: ParseElement[] }) {
  const types = countBy(elements, (e) => e.type);
  const langs = countBy(elements, (e) => e.metadata.languages?.join("+") ?? "–");
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg border border-line text-sm">
        <Row label="elements" value={`${elements.length}`} />
        <Row label="types" value={types.map(([t, n]) => `${t} ${n}`).join(" · ")} />
        <Row label="languages" value={langs.map(([l, n]) => `${l} ${n}`).join(" · ")} />
        <Row label="footnotes" value={`${elements.filter((e) => e.metadata.is_footnote).length}`} />
      </div>
      <pre className="overflow-x-auto rounded-lg border border-line bg-ink p-4 font-mono text-[12px] leading-relaxed text-soft">
        {JSON.stringify(elements, null, 2)}
      </pre>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[140px_1fr] border-b border-line last:border-0">
      <span className="bg-panel-2 px-3 py-2 font-mono text-xs text-muted">{label}</span>
      <span className="px-3 py-2 text-soft">{value}</span>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-40 items-center justify-center px-6 text-center text-sm leading-relaxed text-muted">
      <p className="max-w-md">{text}</p>
    </div>
  );
}
