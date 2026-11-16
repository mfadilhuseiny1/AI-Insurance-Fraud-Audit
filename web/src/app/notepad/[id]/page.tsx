"use client";

import { PresenceBar, type PresenceOther } from "@/components/Presence";
import Link from "next/link";
import { alertDialog } from "@/lib/dialogs";
import { notepadClip } from "@/lib/notepadClip";
import Image from "next/image";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Icon } from "@/components/Icon";
import { GenerateDialog, LinksPanel, TemplatePanel, VersionsPanel } from "@/components/notepad/Panels";
import { SectionHeader, WidgetConfigPanel, WidgetView } from "@/components/notepad/Widgets";
import { renderMarkdown } from "@/lib/markdown";
import {
  notepad,
  WIDGETS,
  ENVELOPE_WIDGETS,
  type HeadingBlock,
  type NotepadApp,
  type NotepadBlock,
  type NotepadDocument,
  type OpenNotepadDocument,
  type PageSettings,
  type TableBlock,
  type WidgetBlock,
  type WidgetData,
  type WidgetKind,
} from "@/lib/notepad";

const button = "inline-flex items-center justify-center gap-2 rounded-md border border-line-2 bg-panel px-3 py-2 text-sm font-medium text-soft shadow-sm transition hover:border-sky-400 hover:text-ocean disabled:cursor-not-allowed disabled:opacity-50";
const primary = "inline-flex items-center justify-center gap-2 rounded-md bg-sky-700 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-ocean-deep disabled:cursor-not-allowed disabled:opacity-50";
const menuItem = "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm hover:bg-panel-2";
const textArea = "w-full resize-y border-0 bg-transparent p-0 text-white outline-none placeholder:text-muted focus:ring-0";
const APP_LINKS: Record<NotepadApp, { label: string; href: string }> = {
  contour: { label: "Contour", href: "/analytics" },
  insight: { label: "Insight", href: "/insight" },
  quiver: { label: "Quiver", href: "/quiver" },
  object_explorer: { label: "Object Explorer", href: "/object-explorer" },
  code_workbook: { label: "Code Workbook", href: "/code-workbook" },
  workshop: { label: "Workshop", href: "/workshop" },
  map: { label: "Map", href: "/map" },
};
const CONTAINERS: WidgetKind[] = ["section_generator", "conditional_section"];
const uid = () => crypto.randomUUID();

type Target = { parent: string | null; after: string | null };
type Panel = "outline" | "inputs" | "versions" | "links";

function blockLabel(block: NotepadBlock) {
  if (block.type === "heading") return block.text || "Untitled heading";
  if (block.type === "paragraph") return block.text || "Paragraph";
  if (block.type === "table") return "Table";
  if (block.type === "image") return block.alt || "Image";
  if (block.type === "app_link") return `Link to ${APP_LINKS[block.app].label}`;
  if (block.type === "date") return `Date · ${block.date}`;
  if (block.type === "widget") return WIDGETS.find((w) => w.kind === block.kind)?.label ?? block.kind;
  return block.type === "page_break" ? "Page break" : "Divider";
}

// ---- nested block helpers (sections hold children)
function mapBlocks(blocks: NotepadBlock[], fn: (b: NotepadBlock) => NotepadBlock): NotepadBlock[] {
  return blocks.map((b) => {
    const next = fn(b);
    return next.type === "widget" && next.children ? { ...next, children: mapBlocks(next.children, fn) } : next;
  });
}
function removeBlock(blocks: NotepadBlock[], id: string): NotepadBlock[] {
  return blocks.filter((b) => b.id !== id).map((b) => (b.type === "widget" && b.children ? { ...b, children: removeBlock(b.children, id) } : b));
}
function insertBlock(blocks: NotepadBlock[], t: Target, block: NotepadBlock): NotepadBlock[] {
  const into = (list: NotepadBlock[]) => {
    const at = t.after ? list.findIndex((b) => b.id === t.after) : -1;
    const next = [...list];
    next.splice(at < 0 ? list.length : at + 1, 0, block);
    return next;
  };
  if (!t.parent) return into(blocks);
  return blocks.map((b) => (b.id === t.parent && b.type === "widget" ? { ...b, children: into(b.children ?? []) } : b.type === "widget" && b.children ? { ...b, children: insertBlock(b.children, t, block) } : b));
}
function moveIn(blocks: NotepadBlock[], id: string, delta: -1 | 1): NotepadBlock[] {
  const from = blocks.findIndex((b) => b.id === id);
  if (from >= 0) {
    const to = from + delta;
    if (to < 0 || to >= blocks.length) return blocks;
    const next = [...blocks];
    [next[from], next[to]] = [next[to], next[from]];
    return next;
  }
  return blocks.map((b) => (b.type === "widget" && b.children ? { ...b, children: moveIn(b.children, id, delta) } : b));
}
function* walk(blocks: NotepadBlock[], inGen = false): Generator<[NotepadBlock, boolean, string | null]> {
  for (const b of blocks) {
    yield [b, inGen, null];
    if (b.type === "widget" && b.children) for (const [x, g] of walk(b.children, inGen || b.kind === "section_generator")) yield [x, g, b.id];
  }
}
function parentOf(blocks: NotepadBlock[], id: string): string | null {
  for (const b of blocks) {
    if (b.type === "widget" && b.children) {
      if (b.children.some((c) => c.id === id)) return b.id;
      const p = parentOf(b.children, id);
      if (p) return p;
    }
  }
  return null;
}

export default function NotepadDocumentPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  // embed mode (Workshop's Notepad: Embedded document widget): ?embed=1 shows the document only, &edit=1 adds a reduced
  // editor (edit / preview and save), &print=1 opens the print dialog once the document has loaded
  const query = useSearchParams();
  const embed = query.get("embed") === "1";
  const embedEdit = embed && query.get("edit") === "1";
  const embedPrint = embed && query.get("print") === "1";
  const [loadVersion, setLoadVersion] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; value: OpenNotepadDocument } | null>(null);
  const [loadFailure, setLoadFailure] = useState<{ key: string; message: string } | null>(null);
  const [draftState, setDraftState] = useState<{ key: string; document: NotepadDocument } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [selectedBlockId, setSelectedBlockId] = useState("");
  const [focusedTextId, setFocusedTextId] = useState("");
  const [previewChoice, setPreview] = useState<boolean | null>(null);
  const preview = previewChoice ?? embed;
  const [widgetMenuOpen, setWidgetMenuOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>("outline");
  const [data, setData] = useState<Record<string, WidgetData>>({});
  // envelope security: the document's markings banner
  const [banner, setBanner] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [assistOpen, setAssistOpen] = useState(false);
  const [genPreview, setGenPreview] = useState<{ document: NotepadDocument; widgets: Record<string, WidgetData> } | null>(null);
  const [linksTick, setLinksTick] = useState(0);
  const inputRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const imageInput = useRef<HTMLInputElement>(null);

  const requestKey = `${id}:${loadVersion}`;
  useEffect(() => {
    let cancelled = false;
    const key = requestKey;
    notepad.get(id).then((value) => {
      if (cancelled) return;
      setLoaded({ key, value });
      setDraftState({ key, document: value.document });
      setSelectedBlockId(value.document.blocks[0]?.id ?? "");
      setSaveError("");
    }).catch((error: Error) => {
      if (!cancelled) setLoadFailure({ key, message: error.message });
    });
    return () => { cancelled = true; };
  }, [id, requestKey]);

  const current = loaded?.key === requestKey ? loaded.value : null;
  const loadError = loadFailure?.key === requestKey ? loadFailure.message : "";
  const draft = draftState?.key === requestKey ? draftState.document : null;
  const dirty = Boolean(current && draft && JSON.stringify(current.document) !== JSON.stringify(draft));
  // live co-editing: where the others are, and their saves while this copy has no unsaved changes
  const [others, setOthers] = useState<PresenceOther[]>([]);
  const theirs: Record<string, string> = Object.fromEntries(others.filter((o) => o.at).map((o) => [o.at as string, o.name]));
  const othersEditing = others.some((o) => o.editing);
  const openedAt = current?.item.updated_at;
  useEffect(() => {
    if (!othersEditing || dirty || saving || !openedAt) return;
    const key = requestKey;
    const timer = window.setInterval(() => {
      notepad.get(id).then((value) => {
        if (value.item.updated_at === openedAt) return;
        setLoaded({ key, value });
        setDraftState({ key, document: value.document });
      }, () => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [id, requestKey, othersEditing, dirty, saving, openedAt]);
  const headings = useMemo(() => [...walk(draft?.blocks ?? [])].map(([b]) => b).filter((block): block is HeadingBlock => block.type === "heading"), [draft]);
  const widgetKey = useMemo(() => JSON.stringify([...walk(draft?.blocks ?? [])].filter(([b]) => b.type === "widget").map(([b]) => b)) + JSON.stringify(draft?.template?.inputs ?? []), [draft]);
  const loading = !current && !loadError;
  const isTemplate = !!draft?.template;
  const canEdit = true; // the API refuses saves without the editor role

  // embed + print (Workshop's export button, PDF): the print dialog opens once the widgets' data has settled
  const printed = useRef(false);
  useEffect(() => {
    if (!embedPrint || printed.current || !current) return;
    const timer = window.setTimeout(() => {
      printed.current = true;
      window.print();
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [embedPrint, current, data]);

  // widget data for the current draft (debounced): live data, locked snapshots, template preview values
  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(() => {
      notepad.resolve(id, draft).then((r) => (setData(r.widgets), setBanner(r.banner ?? null)), (e: Error) => setSaveError(e.message));
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, widgetKey]);

  function changeDraft(next: NotepadDocument | ((previous: NotepadDocument) => NotepadDocument)) {
    setDraftState((previous) => {
      if (!previous || previous.key !== requestKey) return previous;
      const document = typeof next === "function" ? next(previous.document) : next;
      return { ...previous, document };
    });
  }
  const setBlocks = (fn: (blocks: NotepadBlock[]) => NotepadBlock[]) => changeDraft((d) => ({ ...d, blocks: fn(d.blocks) }));

  function addBlock(block: NotepadBlock) {
    const t: Target = target ?? (selectedBlockId && draft ? { parent: parentOf(draft.blocks, selectedBlockId), after: selectedBlockId } : { parent: null, after: null });
    setBlocks((blocks) => insertBlock(blocks, t, block));
    setSelectedBlockId(block.id);
    setPreview(false);
    setWidgetMenuOpen(false);
    setTarget(null);
  }

  function addText(type: "paragraph" | "heading", level: 1 | 2 | 3 = 1) {
    const block: NotepadBlock = type === "paragraph" ? { id: uid(), type, text: "" } : { id: uid(), type, level, text: "" };
    addBlock(block);
    requestAnimationFrame(() => inputRefs.current[block.id]?.focus());
  }

  function addWidget(kind: WidgetKind) {
    const config =
      kind === "latex" ? { tex: "E = mc^2", display: true } : kind === "table_row_generator" ? { headers: ["Name"], cells: ["{{object.title}}"] } : kind === "object_property" ? { object: null } : {};
    addBlock({ id: uid(), type: "widget", kind, config, ...(CONTAINERS.includes(kind) ? { children: [{ id: uid(), type: "paragraph", text: kind === "section_generator" ? "{{object.title}}" : "" }] } : {}) });
  }

  function patchBlock(blockId: string, patch: Partial<NotepadBlock>) {
    setBlocks((blocks) => mapBlocks(blocks, (block) => (block.id === blockId ? ({ ...block, ...patch } as NotepadBlock) : block)));
  }

  function wrapSelection(marker: "**" | "_") {
    const textBlock = [...walk(draft?.blocks ?? [])].map(([b]) => b).find((block): block is Extract<NotepadBlock, { type: "paragraph" | "heading" }> => block.id === focusedTextId && (block.type === "paragraph" || block.type === "heading"));
    const control = inputRefs.current[focusedTextId];
    if (!textBlock || !control) return;
    const text = textBlock.text;
    const start = control.selectionStart;
    const end = control.selectionEnd;
    const selected = text.slice(start, end) || "text";
    patchBlock(textBlock.id, { text: `${text.slice(0, start)}${marker}${selected}${marker}${text.slice(end)}` });
    requestAnimationFrame(() => {
      control.focus();
      control.setSelectionRange(start + marker.length, start + marker.length + selected.length);
    });
  }

  function loadImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) return setSaveError("Choose a PNG, JPEG, GIF, or WebP image.");
    if (file.size > 1024 * 1024) return setSaveError("Embedded images are limited to 1 MB each.");
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        addBlock({ id: uid(), type: "image", src: reader.result, alt: file.name.replace(/\.[^.]+$/, ""), width: 100 });
        setSaveError("");
      }
    };
    reader.onerror = () => setSaveError("Could not read that image file.");
    reader.readAsDataURL(file);
  }

  async function save(): Promise<OpenNotepadDocument | null> {
    if (!current || !draft || saving) return null;
    if (!dirty) return current;
    setSaving(true);
    setSaveError("");
    try {
      const value = await notepad.save(id, current.item.updated_at, draft);
      setLoaded({ key: requestKey, value });
      setDraftState({ key: requestKey, document: value.document });
      setLinksTick((t) => t + 1);
      return value;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save the document");
      return null;
    } finally {
      setSaving(false);
    }
  }

  /** Server-side changes (lock data, publish, restore) apply to the saved document: save first, then reload it. */
  async function serverChange(fn: () => Promise<OpenNotepadDocument | unknown>) {
    if (dirty && !(await save())) return;
    try {
      await fn();
      const value = await notepad.get(id);
      setLoaded({ key: requestKey, value });
      setDraftState({ key: requestKey, document: value.document });
      setLinksTick((t) => t + 1);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }

  function onTextKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, block: NotepadBlock) {
    if (event.key === "/" && !event.currentTarget.value.trim()) {
      event.preventDefault();
      setSelectedBlockId(block.id);
      setWidgetMenuOpen(true);
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  }

  function renderStatic(block: NotepadBlock) {
    if (block.type === "paragraph" || block.type === "heading") {
      const tag = block.type === "heading" ? `h${block.level}` : "p";
      const html = renderMarkdown(block.text || " ");
      return <div className={`notepad-markdown ${block.type === "heading" ? `notepad-heading-${block.level}` : "notepad-paragraph"}`} dangerouslySetInnerHTML={{ __html: html || `<${tag}>&nbsp;</${tag}>` }} />;
    }
    if (block.type === "rule") return <hr className="my-6 border-0 border-t border-line-2" />;
    if (block.type === "page_break") return <div className="my-8 border-t-2 border-dashed border-line-2 py-2 text-center text-[10px] uppercase tracking-[0.16em] text-muted">Page break</div>;
    if (block.type === "image") return <figure className="my-5 text-center"><Image src={block.src} alt={block.alt} width={1200} height={800} unoptimized style={{ width: `${block.width}%`, height: "auto" }} className="mx-auto max-h-[720px] object-contain" /><figcaption className="mt-2 text-xs text-muted">{block.alt}</figcaption></figure>;
    if (block.type === "date") return <time dateTime={block.date} className="my-2 inline-block text-sm text-muted">{new Date(`${block.date}T00:00:00`).toLocaleDateString()}</time>;
    if (block.type === "app_link") return <a href={APP_LINKS[block.app].href} className="my-2 inline-flex items-center gap-2 rounded-md border border-ocean/30 bg-ocean/10 px-3 py-2 text-sm font-medium text-ocean hover:bg-ocean/15"><Icon name="external" />{block.label || APP_LINKS[block.app].label}</a>;
    if (block.type === "table") return <table className="my-5 w-full border-collapse text-sm"><tbody>{block.rows.map((row, rowIndex) => <tr key={`${block.id}-${rowIndex}`} className={rowIndex === 0 ? "bg-panel-2 font-semibold" : ""}>{row.map((cell, columnIndex) => <td key={`${block.id}-${rowIndex}-${columnIndex}`} className="border border-line-2 px-3 py-2 align-top">{cell}</td>)}</tr>)}</tbody></table>;
    return null;
  }

  function renderBlocks(blocks: NotepadBlock[], parent: string | null, widgetData: Record<string, WidgetData>, readOnly: boolean) {
    return blocks.map((block, index) => {
      const selected = selectedBlockId === block.id && !readOnly;
      const widget = block.type === "widget" ? block : null;
      return (
        <article key={block.id} id={`notepad-block-${block.id}`} onClick={(e) => { e.stopPropagation(); if (!readOnly) setSelectedBlockId(block.id); }} title={theirs[block.id] ? `${theirs[block.id]} is here` : undefined} className={`group relative rounded-md px-3 py-2 transition ${selected ? "ring-1 ring-sky-300" : theirs[block.id] ? "ring-1 ring-sand" : readOnly ? "" : "hover:bg-panel-2/70"} ${block.type === "page_break" ? "notepad-page-break" : ""}`}>
          {!readOnly && (
            <div className="notepad-ui-chrome absolute -left-10 top-2 flex flex-col gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
              <button className="rounded bg-panel p-1 text-xs text-muted shadow ring-1 ring-line hover:text-sky-700" onClick={(event) => { event.stopPropagation(); setBlocks((b) => moveIn(b, block.id, -1)); }} aria-label={`Move ${blockLabel(block)} up`} disabled={index === 0}>↑</button>
              <button className="rounded bg-panel p-1 text-xs text-muted shadow ring-1 ring-line hover:text-sky-700" onClick={(event) => { event.stopPropagation(); setBlocks((b) => moveIn(b, block.id, 1)); }} aria-label={`Move ${blockLabel(block)} down`} disabled={index === blocks.length - 1}>↓</button>
              <button className="rounded bg-panel p-1 text-xs text-muted shadow ring-1 ring-line hover:text-rose-700" onClick={(event) => { event.stopPropagation(); setBlocks((b) => removeBlock(b, block.id)); }} aria-label={`Delete ${blockLabel(block)}`}><Icon name="trash" className="h-3.5 w-3.5" /></button>
            </div>
          )}

          {(block.type === "paragraph" || block.type === "heading") && (readOnly ? renderStatic(block) : <textarea ref={(element) => { inputRefs.current[block.id] = element; }} rows={block.type === "heading" ? 1 : Math.max(3, Math.min(8, block.text.split("\n").length + 1))} value={block.text} placeholder={block.type === "heading" ? "Heading" : "Write something… ( / for widgets)"} onFocus={() => { setFocusedTextId(block.id); setSelectedBlockId(block.id); }} onKeyDown={(event) => onTextKeyDown(event, block)} onChange={(event) => patchBlock(block.id, { text: event.target.value })} className={`${textArea} ${block.type === "heading" ? block.level === 1 ? "text-3xl font-semibold tracking-tight" : block.level === 2 ? "text-2xl font-semibold" : "text-lg font-semibold" : "min-h-24 text-[15px] leading-7"}`} />)}
          {block.type === "rule" && (readOnly ? renderStatic(block) : <div className="py-2"><hr className="border-0 border-t border-line-2" /><p className="mt-1 text-[10px] uppercase tracking-widest text-muted">Horizontal rule</p></div>)}
          {block.type === "page_break" && (readOnly ? renderStatic(block) : <div className="py-2"><div className="border-t-2 border-dashed border-line-2" /><p className="mt-1 text-center text-[10px] uppercase tracking-widest text-muted">Page break</p></div>)}
          {block.type === "date" && (readOnly ? renderStatic(block) : <label className="flex flex-wrap items-center gap-2 py-2 text-xs text-muted">Date widget <input type="date" value={block.date} onChange={(event) => patchBlock(block.id, { date: event.target.value })} className="rounded border border-line bg-panel px-2 py-1 text-sm text-soft" /></label>)}
          {block.type === "app_link" && (readOnly ? renderStatic(block) : <div className="flex flex-wrap items-center gap-2 py-2"><select aria-label="Platform app" value={block.app} onChange={(event) => patchBlock(block.id, { app: event.target.value as NotepadApp })} className="rounded border border-line bg-panel px-2 py-2 text-sm text-soft">{Object.entries(APP_LINKS).map(([app, value]) => <option key={app} value={app}>{value.label}</option>)}</select><input aria-label="Link label" value={block.label} onChange={(event) => patchBlock(block.id, { label: event.target.value })} placeholder={`${APP_LINKS[block.app].label} workspace`} className="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-2 text-sm text-soft" /></div>)}
          {block.type === "image" && (readOnly ? renderStatic(block) : <figure className="py-2 text-center"><Image src={block.src} alt={block.alt} width={1200} height={800} unoptimized style={{ width: `${block.width}%`, height: "auto" }} className="mx-auto max-h-[600px] object-contain" /><input aria-label="Image description" value={block.alt} onChange={(event) => patchBlock(block.id, { alt: event.target.value })} placeholder="Add image description" className="mx-auto mt-2 block w-full max-w-md border-b border-line px-2 py-1 text-center text-xs text-muted outline-none focus:border-sky-400" /><label className="notepad-ui-chrome mx-auto mt-2 flex max-w-xs items-center gap-2 text-xs text-muted">Width <input type="range" min={20} max={100} value={block.width} onChange={(event) => patchBlock(block.id, { width: Number(event.target.value) })} className="flex-1 accent-sky-700" />{block.width}%</label></figure>)}
          {block.type === "table" && (readOnly ? renderStatic(block) : <TableEditor block={block} onChange={(rows) => patchBlock(block.id, { rows })} />)}

          {widget && (
            CONTAINERS.includes(widget.kind) ? (
              readOnly && !isTemplate ? renderBlocks(widget.children ?? [], widget.id, widgetData, true) : (
                <div className={`rounded-md border-l-4 py-1 pl-3 ${widget.kind === "conditional_section" ? (widgetData[widget.id]?.shown ? "border-good/60" : "border-bad/60") : "border-sand/60"}`}>
                  <SectionHeader b={widget} data={widgetData[widget.id]} />
                  {renderBlocks(widget.children ?? [], widget.id, widgetData, readOnly)}
                  {!readOnly && <button className="notepad-ui-chrome mt-1 text-xs text-muted hover:text-ocean" onClick={(e) => { e.stopPropagation(); setTarget({ parent: widget.id, after: null }); setWidgetMenuOpen(true); }}><Icon name="plus" className="h-3 w-3" /> Add to section</button>}
                </div>
              )
            ) : (
              <div className="relative">
                <WidgetView b={widget} data={widgetData[widget.id]} preview={readOnly} docId={id} />
                {widget.locked && <p className="notepad-ui-chrome mt-1 flex items-center gap-1 text-[11px] text-muted"><Icon name="lock" className="h-3 w-3" />Data locked {new Date(widget.locked.at).toLocaleString()}{widget.locked.by ? ` by ${widget.locked.by.name}` : ""}</p>}
                {selected && !["latex", "anchor_link", "value_embed", "table_row_generator", "quiver_dashboard"].includes(widget.kind) && !widgetData[widget.id]?.client && (
                  <button className="notepad-ui-chrome mt-1 inline-flex items-center gap-1 text-[11px] text-ocean hover:underline" onClick={(e) => { e.stopPropagation(); void serverChange(() => notepad.lock(id, !widget.locked, [widget.id])); }}>
                    <Icon name={widget.locked ? "unlock" : "lock"} className="h-3 w-3" />{widget.locked ? "Update data (unlock)" : "Lock data"}
                  </button>
                )}
              </div>
            )
          )}
        </article>
      );
    });
  }

  const selectedWidget = [...walk(draft?.blocks ?? [])].find(([b]) => b.id === selectedBlockId && b.type === "widget") as [WidgetBlock, boolean, string | null] | undefined;
  const settings: PageSettings = { size: "letter", orientation: "portrait", header: "", footer: "", ...(draft?.settings ?? {}) };
  const title = current?.item.name.replace(/\.notepad$/i, "") ?? "";

  return (
    <main className="notepad-shell flex min-h-0 flex-1 flex-col bg-panel-2 text-white">
      <style>{`@page { size: ${settings.size === "a4" ? "A4" : settings.size} ${settings.orientation}; }`}</style>
      {current && embedEdit && (
        <div className="notepad-ui-chrome flex shrink-0 items-center justify-end gap-2 border-b border-line bg-panel px-3 py-1.5">
          <span className="mr-auto truncate text-xs text-muted">{title}{dirty ? " · unsaved changes" : ""}</span>
          <button className={button} onClick={() => setPreview(!preview)}><Icon name={preview ? "edit" : "eye"} />{preview ? "Edit" : "Preview"}</button>
          <button className={primary} onClick={() => void save()} disabled={!dirty || saving}><Icon name="save" />{saving ? "Saving…" : "Save"}</button>
        </div>
      )}
      {current && !embed && <header className="notepad-ui-chrome flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2 sm:px-5">
        <Link href="/notepad" className="flex items-center gap-2 text-sm font-semibold text-white hover:text-sky-700"><span className="rounded-md bg-ocean/10 p-1.5 text-sky-700"><Icon name="doc" /></span><span className="hidden sm:inline">Notepad</span></Link>
        <Icon name="right" className="h-3.5 w-3.5 text-muted" />
        <span className="min-w-0 max-w-[32vw] truncate text-sm text-soft" title={current.item.name}>{title}</span>
        {isTemplate && <span className="rounded bg-sand/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-sand">Template</span>}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <PresenceBar itemId={id} editing={!preview} at={selectedBlockId || undefined} interval={5000} onOthers={setOthers} />
          <span className="hidden text-xs text-muted md:inline">{dirty ? "Unsaved changes" : `Saved ${new Date(current.item.updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}</span>
          {isTemplate && <button className={button} onClick={() => void serverChange(async () => setGenPreview(await notepad.generate(id, { inputs: {}, version: "draft", dry_run: true }) as never))}><Icon name="eye" />Preview generation</button>}
          {isTemplate && <button className={button} onClick={() => setGenerateOpen(true)}><Icon name="plus" />New from this template</button>}
          {!draft?.envelope && <button className={button} onClick={() => setAssistOpen(true)}><Icon name="sparkle" />AIP assist</button>}
          <button className={button} onClick={() => setPreview(!preview)}><Icon name="eye" />{preview ? "Edit" : "Preview"}</button>
          <div className="relative">
            <button className={button} onClick={() => setActionsOpen((v) => !v)}><Icon name="dots" />Actions</button>
            {actionsOpen && <div className="absolute right-0 top-full z-40 mt-2 w-56 rounded-lg border border-line bg-panel p-1 shadow-xl" onClick={() => setActionsOpen(false)}>
              <button className={menuItem} onClick={() => void serverChange(() => notepad.lock(id, true))}><Icon name="lock" className="h-4 w-4" />Lock data for all widgets</button>
              <button className={menuItem} onClick={() => void serverChange(() => notepad.lock(id, false))}><Icon name="unlock" className="h-4 w-4" />Update data for all widgets</button>
              <a className={menuItem} href={notepad.exportUrl(id, "docx")}><Icon name="download" className="h-4 w-4" />Export as DOCX</a>
              <a className={menuItem} href={notepad.exportUrl(id, "markdown")}><Icon name="download" className="h-4 w-4" />Export as Markdown</a>
              <button className={menuItem} onClick={() => window.print()}><Icon name="download" className="h-4 w-4" />Print / PDF</button>
              <button className={menuItem} onClick={() => setSettingsOpen(true)}><Icon name="sliders" className="h-4 w-4" />Page settings</button>
              {!isTemplate && <button className={menuItem} onClick={() => void serverChange(async () => { const r = await notepad.saveAsTemplate(id, `${title} template`); router.push(`/notepad/${r.item.id}`); })}><Icon name="copy" className="h-4 w-4" />Save as template</button>}
              {!isTemplate && <button className={menuItem} onClick={() => changeDraft((d) => ({ ...d, template: { inputs: [], published: [] } }))}><Icon name="edit" className="h-4 w-4" />Turn into a template</button>}
            </div>}
          </div>
          <button className={primary} onClick={() => void save()} disabled={!dirty || saving}><Icon name="save" />{saving ? "Saving…" : "Save"}</button>
        </div>
      </header>}

      {loading && <div className="grid flex-1 place-items-center text-sm text-muted">Loading document…</div>}
      {loadError && <div className="m-auto max-w-lg rounded-xl border border-bad/30 bg-panel p-6 text-center shadow-sm"><Icon name="alert" className="mx-auto h-7 w-7 text-rose-600" /><h1 className="mt-3 text-lg font-semibold text-white">Could not open document</h1><p className="mt-2 text-sm text-bad">{loadError}</p><div className="mt-5 flex justify-center gap-2"><Link href="/notepad" className={button}>Back to documents</Link><button className={primary} onClick={() => setLoadVersion((value) => value + 1)}>Retry</button></div></div>}

      {current && draft && <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className={embed ? "hidden" : "notepad-ui-chrome hidden w-64 shrink-0 flex-col border-r border-line bg-panel lg:flex"}>
          <div className="flex border-b border-line text-[11px]">
            {(["outline", ...(isTemplate ? ["inputs"] : []), "versions", "links"] as Panel[]).map((p) => (
              <button key={p} onClick={() => setPanel(p)} className={`flex-1 px-1 py-2 capitalize ${panel === p ? "border-b-2 border-ocean text-white" : "text-muted hover:text-soft"}`}>{p === "inputs" ? "Inputs" : p}</button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto">
            {panel === "outline" && <nav className="p-3" aria-label="Document outline">
              {headings.length ? headings.map((heading) => <button key={heading.id} onClick={() => document.getElementById(`notepad-block-${heading.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })} className={`mb-1 block w-full truncate rounded px-2 py-1.5 text-left text-xs text-soft transition hover:bg-ocean/10 hover:text-ocean ${heading.level > 1 ? "pl-5" : "font-medium"}`} title={heading.text}>{heading.text || "Untitled heading"}</button>) : <p className="px-2 py-2 text-xs leading-5 text-muted">Add headings to build an outline.</p>}
            </nav>}
            {panel === "inputs" && <TemplatePanel doc={draft} canEdit={canEdit} onChange={(inputs) => changeDraft((d) => ({ ...d, template: { ...(d.template ?? { published: [] }), inputs } }))} onPublish={(name) => void serverChange(() => notepad.publish(id, name))} />}
            {panel === "versions" && <VersionsPanel id={id} canEdit={canEdit} onRestored={() => { setDraftState(null); setLoaded(null); setLoadVersion((v) => v + 1); }} />}
            {panel === "links" && <LinksPanel id={id} tick={linksTick} />}
          </div>
          <div className="border-t border-line p-3 text-[11px] leading-5 text-muted">Document access follows the containing Drive project.</div>
        </aside>

        <section className="min-w-0 flex-1 overflow-y-auto" onClick={() => setTarget(null)}>
          <div className="notepad-ui-chrome sticky top-0 z-20 flex flex-wrap items-center gap-1 border-b border-line bg-panel/95 px-3 py-2 backdrop-blur sm:px-5">
            {!preview ? <>
              <button className={button} onClick={() => addText("paragraph")}><Icon name="plus" />Text</button>
              <button className={button} onClick={() => addText("heading", 1)}>Heading</button>
              <button className={button} onClick={() => wrapSelection("**")} disabled={!focusedTextId}><strong>B</strong></button>
              <button className={button} onClick={() => wrapSelection("_")} disabled={!focusedTextId}><em>I</em></button>
              <div className="relative">
                <button className={primary} onClick={(e) => { e.stopPropagation(); setWidgetMenuOpen((value) => !value); }} aria-expanded={widgetMenuOpen}><Icon name="plus" />Widget</button>
                {widgetMenuOpen && <div className="absolute left-0 top-full z-40 mt-2 max-h-[70vh] w-64 overflow-y-auto rounded-lg border border-line bg-panel p-2 shadow-xl" onClick={(e) => e.stopPropagation()}>
                  {target?.parent && <p className="px-3 pb-1 text-[11px] text-sand">Adding inside the section</p>}
                  <p className="px-3 pt-1 text-[10px] font-semibold uppercase tracking-widest text-muted">Text</p>
                  <button className={menuItem} onClick={() => addText("paragraph")}>Paragraph</button>
                  <button className={menuItem} onClick={() => addText("heading", 1)}>Large heading</button>
                  <button className={menuItem} onClick={() => addText("heading", 2)}>Medium heading</button>
                  <button className={menuItem} onClick={() => addBlock({ id: uid(), type: "table", rows: Array.from({ length: 3 }, () => ["", "", ""]) })}><Icon name="table" /> Table</button>
                  <button className={menuItem} onClick={() => imageInput.current?.click()}><Icon name="image" /> Image</button>
                  <button className={menuItem} onClick={() => addBlock({ id: uid(), type: "rule" })}>Horizontal rule</button>
                  <button className={menuItem} onClick={() => addBlock({ id: uid(), type: "page_break" })}>Page break</button>
                  <button className={menuItem} onClick={() => { const now = new Date(); addBlock({ id: uid(), type: "date", date: new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10) }); }}>Current date</button>
                  {!draft?.envelope && <button className={menuItem} onClick={() => addBlock({ id: uid(), type: "app_link", app: "contour", label: "" })}>Platform app link</button>}
                  <button
                    className={menuItem}
                    onClick={() => {
                      const clip = notepadClip();
                      if (!clip) return void alertDialog("Nothing copied: use Copy for Notepad in Contour, Quiver, Vertex or Code Workbook.");
                      addBlock({ id: uid(), type: "widget", kind: clip.kind, config: clip.config });
                    }}
                  >
                    <Icon name="copy" /> Paste copied widget
                  </button>
                  {(["Nexus", "Applications", "Native", "Template"] as const).map((g) => (
                    (g !== "Template" || isTemplate) && <div key={g}>
                      <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-widest text-muted">{g}</p>
                      {WIDGETS.filter((w) => w.group === g && (!draft?.envelope || ENVELOPE_WIDGETS.includes(w.kind))).map((w) => <button key={w.kind} className={menuItem} onClick={() => addWidget(w.kind)}>{w.label}</button>)}
                    </div>
                  ))}
                  {!isTemplate && <p className="px-3 pt-2 text-[11px] text-muted">Template widgets (generators, value embeds, conditional sections) appear in templates.</p>}
                </div>}
              </div>
              <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={loadImage} />
            </> : <span className="text-sm font-medium text-soft">Preview</span>}
            <span className="ml-auto hidden text-xs text-muted sm:inline">{[...walk(draft.blocks)].length} blocks</span>
          </div>

          {saveError && <div className="sticky top-[52px] z-10 mx-4 mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-sand/10 px-3 py-2 text-xs text-sand sm:mx-8"><Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" /><span className="flex-1">{saveError}</span>{saveError.includes("changed after it was opened") && <button className="shrink-0 font-semibold underline" onClick={() => { setDraftState(null); setLoaded(null); setLoadVersion((value) => value + 1); }}>Reload</button>}<button onClick={() => setSaveError("")} aria-label="Dismiss"><Icon name="x" className="h-3.5 w-3.5" /></button></div>}

          <div className="notepad-paper mx-auto my-6 min-h-[900px] w-[calc(100%-24px)] max-w-[850px] bg-panel px-6 py-10 shadow-md sm:my-8 sm:min-h-[1056px] sm:px-16 sm:py-14">
            {settings.header && <p className="mb-4 text-center text-[11px] text-muted">{settings.header}</p>}
            <div className="mb-7 border-b border-line pb-4"><h1 className="truncate text-2xl font-semibold tracking-tight text-white">{title}</h1><p className="mt-1 text-xs text-muted">{preview ? "Document preview" : isTemplate ? "Editing template — widgets show the inputs' preview values" : "Editing document"}</p></div>
            {draft.blocks.length === 0 && !preview && <button className="w-full rounded-lg border border-dashed border-line-2 p-8 text-sm text-muted hover:border-sky-400 hover:text-sky-700" onClick={() => addText("paragraph")}>Click to start writing or add a widget</button>}
            {banner && <div className="mb-2 rounded bg-sand/20 py-1 text-center text-xs font-semibold tracking-widest text-sand" title="Envelope security: the document's markings">{banner}</div>}
            <div className="space-y-2">{renderBlocks(draft.blocks, null, data, preview)}</div>
            {banner && <div className="mt-2 rounded bg-sand/20 py-1 text-center text-xs font-semibold tracking-widest text-sand">{banner}</div>}
            {!preview && <button className="notepad-ui-chrome mt-4 rounded-md px-3 py-2 text-sm text-muted hover:bg-panel-2 hover:text-ocean" onClick={() => { setSelectedBlockId(""); addText("paragraph"); }}><Icon name="plus" /> Add a paragraph</button>}
            {settings.footer && <p className="mt-8 text-center text-[11px] text-muted">{settings.footer}</p>}
          </div>
        </section>

        {selectedWidget && !preview && (
          <aside className="notepad-ui-chrome w-72 shrink-0 overflow-y-auto border-l border-line bg-panel p-3 text-xs">
            <div className="mb-2 flex items-center justify-between"><span className="font-semibold uppercase tracking-wide text-muted">Widget properties</span><span className="text-sand">{blockLabel(selectedWidget[0])}</span></div>
            <WidgetConfigPanel b={selectedWidget[0]} inputs={draft.template?.inputs ?? []} inGenerator={selectedWidget[1]} headings={headings} onChange={(config) => patchBlock(selectedWidget[0].id, { config } as Partial<NotepadBlock>)} />
          </aside>
        )}
      </div>}

      {generateOpen && current && draft?.template && <GenerateDialog template={{ id, name: current.item.name, versions: draft.template.published, inputs: draft.template.published[draft.template.published.length - 1] ? ((draft.template.published[draft.template.published.length - 1].document as { inputs?: typeof draft.template.inputs })?.inputs ?? draft.template.inputs) : draft.template.inputs }} onClose={() => setGenerateOpen(false)} />}

      {assistOpen && draft && (
        <AssistDialog
          id={id}
          document={draft}
          selected={[...walk(draft.blocks)].map(([b]) => b).find((b): b is Extract<NotepadBlock, { type: "paragraph" | "heading" }> => b.id === selectedBlockId && (b.type === "paragraph" || b.type === "heading")) ?? null}
          onInsert={(blocks) => {
            for (const b of [...blocks].reverse()) addBlock(b);
            setAssistOpen(false);
          }}
          onReplace={(blockId, blocks) => {
            setBlocks((list) => {
              const t: Target = { parent: parentOf(list, blockId), after: blockId };
              let next = list;
              for (const b of [...blocks].reverse()) next = insertBlock(next, t, b);
              return removeBlock(next, blockId);
            });
            setAssistOpen(false);
          }}
          onClose={() => setAssistOpen(false)}
        />
      )}
      {settingsOpen && draft && <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
        <div className="w-full max-w-sm space-y-2 rounded-xl border border-line bg-panel p-5 text-sm shadow-2xl">
          <h2 className="text-lg font-semibold">Page settings</h2>
          <label className="block text-xs">Page size<select value={settings.size} onChange={(e) => changeDraft((d) => ({ ...d, settings: { ...settings, size: e.target.value as PageSettings["size"] } }))} className="mt-1 w-full rounded border border-line bg-panel px-2 py-1"><option value="letter">Letter</option><option value="a4">A4</option><option value="legal">Legal</option></select></label>
          <label className="block text-xs">Orientation<select value={settings.orientation} onChange={(e) => changeDraft((d) => ({ ...d, settings: { ...settings, orientation: e.target.value as PageSettings["orientation"] } }))} className="mt-1 w-full rounded border border-line bg-panel px-2 py-1"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
          <label className="block text-xs">Header<input value={settings.header} onChange={(e) => changeDraft((d) => ({ ...d, settings: { ...settings, header: e.target.value } }))} className="mt-1 w-full rounded border border-line bg-panel px-2 py-1" /></label>
          <label className="block text-xs">Footer<input value={settings.footer} onChange={(e) => changeDraft((d) => ({ ...d, settings: { ...settings, footer: e.target.value } }))} className="mt-1 w-full rounded border border-line bg-panel px-2 py-1" /></label>
          <p className="text-[11px] text-muted">Used by Print / PDF and DOCX export; save the document to keep them.</p>
          <div className="flex justify-end"><button className={button} onClick={() => setSettingsOpen(false)}>Done</button></div>
        </div>
      </div>}

      {genPreview && <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && setGenPreview(null)}>
        <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-line bg-panel p-6 shadow-2xl">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">Generated with the preview values</h2><button onClick={() => setGenPreview(null)} aria-label="Close"><Icon name="x" /></button></div>
          <div className="space-y-2">{renderBlocks(genPreview.document.blocks, null, genPreview.widgets, true)}</div>
        </div>
      </div>}
    </main>
  );
}

function TableEditor({ block, onChange }: { block: TableBlock; onChange: (rows: string[][]) => void }) {
  const cols = block.rows[0]?.length ?? 0;
  return (
    <div className="overflow-x-auto py-2">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span className="font-semibold">Table</span>
        <button className="rounded border border-line px-2 py-1 hover:bg-panel-2" disabled={block.rows.length >= 1000} onClick={() => onChange([...block.rows, Array.from({ length: cols || 3 }, () => "")])}>+ Row</button>
        <button className="rounded border border-line px-2 py-1 hover:bg-panel-2" disabled={cols >= 20} onClick={() => onChange(block.rows.map((row) => [...row, ""]))}>+ Column</button>
        <button className="rounded border border-line px-2 py-1 hover:bg-panel-2 disabled:opacity-40" disabled={block.rows.length <= 1} onClick={() => onChange(block.rows.slice(0, -1))}>− Row</button>
        <button className="rounded border border-line px-2 py-1 hover:bg-panel-2 disabled:opacity-40" disabled={cols <= 1} onClick={() => onChange(block.rows.map((row) => row.slice(0, -1)))}>− Column</button>
      </div>
      <table className="w-full border-collapse text-sm">
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={`${block.id}-${r}`} className={r === 0 ? "bg-panel-2" : ""}>
              {row.map((cell, c) => (
                <td key={`${block.id}-${r}-${c}`} className="min-w-24 border border-line-2 p-0">
                  <input value={cell} onChange={(event) => { const rows = block.rows.map((existing) => [...existing]); rows[r][c] = event.target.value; onChange(rows); }} aria-label={`Table row ${r + 1}, column ${c + 1}`} className={`w-full min-w-24 bg-transparent px-2 py-2 text-sm text-white outline-none focus:bg-ocean/10 ${r === 0 ? "font-semibold" : ""}`} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Markdown from AIP assist as Notepad blocks: headings, and paragraphs (lists stay in one paragraph block). */
function markdownBlocks(md: string): NotepadBlock[] {
  const out: NotepadBlock[] = [];
  for (const part of md.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = part.split("\n");
    let para: string[] = [];
    const flush = () => {
      if (para.join("").trim()) out.push({ id: uid(), type: "paragraph", text: para.join("\n").trim() });
      para = [];
    };
    for (const line of lines) {
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) {
        flush();
        out.push({ id: uid(), type: "heading", level: h[1].length as 1 | 2 | 3, text: h[2].trim() });
      } else para.push(line);
    }
    flush();
  }
  return out;
}

/** AIP assist: write new content, rewrite the selected text block, or summarize the document, with a language model. */
function AssistDialog({ id, document: draft, selected, onInsert, onReplace, onClose }: {
  id: string;
  document: NotepadDocument;
  selected: Extract<NotepadBlock, { type: "paragraph" | "heading" }> | null;
  onInsert: (blocks: NotepadBlock[]) => void;
  onReplace: (blockId: string, blocks: NotepadBlock[]) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"write" | "rewrite" | "summarize">(selected ? "rewrite" : "write");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ markdown: string; model: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await notepad.assist(id, { mode, instruction, selection: mode === "rewrite" ? selected?.text ?? null : null, document: draft }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-2xl space-y-3 rounded-xl border border-line bg-panel p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <Icon name="sparkle" className="h-4 w-4 text-ocean" />
          <h2 className="flex-1 font-semibold text-white">AIP assist</h2>
          <button type="button" onClick={onClose} className="text-muted hover:text-white" aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="flex gap-1 text-sm">
          {([["write", "Write new content"], ["rewrite", "Rewrite the selected block"], ["summarize", "Summarize the document"]] as const).map(([k, label]) => (
            <button key={k} type="button" disabled={k === "rewrite" && !selected} onClick={() => setMode(k)} className={`rounded-md px-3 py-1.5 ${mode === k ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:text-white"} disabled:opacity-40`}>
              {label}
            </button>
          ))}
        </div>
        {mode === "rewrite" && selected && <p className="max-h-24 overflow-y-auto rounded border border-line bg-panel-2 p-2 text-xs text-soft">{selected.text}</p>}
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={3}
          placeholder={mode === "write" ? "What to write, e.g. an introduction stating the findings above" : mode === "rewrite" ? "How, e.g. more formal, shorter" : "Optional: what to focus on"}
          className="w-full rounded-md border border-line-2 bg-panel-2 px-3 py-2 text-sm text-white"
        />
        <p className="text-xs text-muted">The document&apos;s text and its widgets&apos; current data go to the language model as context.</p>
        <div className="flex gap-2">
          <button type="button" className={primary} disabled={busy || (mode !== "summarize" && !instruction.trim())} onClick={() => void run()}>
            <Icon name="sparkle" />{busy ? "Writing…" : result ? "Try again" : "Generate"}
          </button>
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        {result && (
          <>
            <div className="max-h-72 overflow-y-auto rounded-md border border-line bg-panel-2 p-3 text-sm text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(result.markdown) }} />
            <div className="flex items-center gap-2">
              <span className="flex-1 text-xs text-muted">{result.model}</span>
              {mode === "rewrite" && selected && (
                <button type="button" className={primary} onClick={() => onReplace(selected.id, markdownBlocks(result.markdown))}>Replace the block</button>
              )}
              <button type="button" className={mode === "rewrite" ? button : primary} onClick={() => onInsert(markdownBlocks(result.markdown))}>Insert below</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
