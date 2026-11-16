"use client";

import { PresenceBar, type PresenceOther } from "@/components/Presence";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/Icon";
import { FusionPanel } from "@/components/fusion/Panels";
import { AppHeader, ErrorBox } from "@/components/ontology/parts";
import { buttonClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { FusionChart } from "@/components/fusion/Chart";
import { addr, colLetters, conditionalStyle, errorText, formatValue, fusion, httpUrl, labelIcon, parseAddr, shiftFormula, tableAt, type CellFormat, type CellValue, type ChartValue, type FusionView, type RichValue, type Sheet } from "@/lib/fusion";
import { chartSize } from "@/lib/fusionChart";
import { renderMarkdown } from "@/lib/markdown";

type Pos = { r: number; c: number };
type PanelKind = "data" | "sources" | "history" | "conditional" | "indexes" | null;

/** The value a cell shows: a spilled 2-D result's first cell holds the whole result, and shows its top-left value. */
function shown(v: CellValue | undefined): CellValue | undefined {
  const raw = v?.v as { __kind__?: string; rows?: unknown[][] } | null | undefined;
  return v && raw && typeof raw === "object" && raw.__kind__ === "matrix" ? { d: v.d, v: raw.rows?.[0]?.[0] } : v;
}

/** A datepicker cell: the date is written when the field loses focus (or Enter), not on every keystroke. */
function DateCell({ value, precision, disabled, onPick }: { value: string | null; precision: "NONE" | "MINUTE" | "SECOND"; disabled: boolean; onPick: (v: string | null) => void }) {
  const current = value ? (precision === "NONE" ? value.slice(0, 10) : value.replace(" ", "T").slice(0, precision === "MINUTE" ? 16 : 19)) : "";
  return (
    <input
      key={current}
      type={precision === "NONE" ? "date" : "datetime-local"}
      step={precision === "SECOND" ? 1 : undefined}
      defaultValue={current}
      disabled={disabled}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      onBlur={(e) => {
        if (e.target.value !== current) onPick(e.target.value || null);
      }}
      className="h-full w-full bg-transparent text-xs outline-none"
      aria-label="Date"
    />
  );
}

export default function FusionSheetPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [view, setView] = useState<FusionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetId, setSheetId] = useState("");
  const [sel, setSel] = useState<Pos>({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState<Pos | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelKind>(null);
  const [toasts, setToasts] = useState<{ id: number; message: string; intent: string }[]>([]);
  const [clip, setClip] = useState<{ from: Pos; rows: (string | undefined)[][] } | null>(null);
  const [editTemplate, setEditTemplate] = useState(false);
  // the side panel action.open_markdown_panel opens
  const [markdown, setMarkdown] = useState<{ title: string; markdown: string } | null>(null);
  // the fill handle: dragging the selection's corner to this cell
  const [fillTo, setFillTo] = useState<Pos | null>(null);
  // live co-editing: who else is here and where; their edits are fetched while one of them is editing
  const [others, setOthers] = useState<PresenceOther[]>([]);
  const othersEditing = others.some((o) => o.editing);
  const idle = draft === null;
  // edits can overlap (typing on while a recalculation is saved): a response older than one already shown is dropped
  const issued = useRef(0);
  const applied = useRef(0);
  // edits sent and not answered yet: a co-editors' poll is not shown meanwhile (it may have read older content)
  const inflight = useRef(0);
  useEffect(() => {
    if (!othersEditing || !idle) return;
    const timer = window.setInterval(() => {
      const q = Object.fromEntries(new URLSearchParams(window.location.search));
      // an edit of this page sent before the answer arrives answers with newer content: this read is not shown
      const n0 = issued.current;
      if (inflight.current) return;
      fusion.get(id, q).then((v) => {
        if (issued.current !== n0 || inflight.current) return;
        setView((cur) => (cur && cur.item.updated_at === v.item.updated_at && cur.revision === v.revision ? cur : v));
      }, () => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [id, othersEditing, idle]);
  const gridRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // the page's URL parameters reach query_params(name)
    const q = Object.fromEntries(new URLSearchParams(window.location.search));
    fusion.get(id, q).then(setView, (e: Error) => setError(e.message));
  }, [id]);

  const sheet: Sheet | undefined = view ? (view.document.sheets.find((s) => s.id === sheetId) ?? view.document.sheets[0]) : undefined;
  const vals = (sheet && view?.values[sheet.id]) || {};
  const size = useMemo(() => {
    let r = 0;
    let c = 0;
    // the cells that hold something, and the cells 2-D results spill over (they have values but no input)
    for (const a of [...Object.keys(sheet?.cells ?? {}), ...Object.keys((sheet && view?.values[sheet.id]) || {})]) {
      const [ri, ci] = parseAddr(a);
      r = Math.max(r, ri);
      c = Math.max(c, ci);
    }
    return { rows: Math.max(40, r + 15), cols: Math.min(52, Math.max(12, c + 4)) };
  }, [sheet, view]);

  const toast = useCallback((message: string, intent = "primary") => {
    const tid = Date.now() + Math.random();
    setToasts((t) => [...t, { id: tid, message, intent }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== tid)), 3500);
  }, []);
  const latest = useCallback((n: number, v: FusionView) => {
    if (n < applied.current) return false;
    applied.current = n;
    setView(v);
    return true;
  }, []);
  const run = useCallback(
    async (fn: () => Promise<FusionView>) => {
      setError(null);
      const n = ++issued.current;
      inflight.current++;
      try {
        const v = await fn();
        if (!latest(n, v)) return v;
        for (const s of v.synced ?? []) toast(`Synced ${s.table} to its dataset (${s.rows} rows)`, "success");
        return v;
      } catch (e) {
        setError((e as Error).message);
        return null;
      } finally {
        inflight.current--;
      }
    },
    [toast, latest],
  );

  if (error && !view) return <ApiError message={error} />;
  if (!view || !sheet) return <Loading />;
  const doc = view.document;
  const editable = view.can_edit && !doc.settings.presentation;
  const selAddr = addr(sel.r, sel.c);
  // other users' selected cells on this sheet
  const cursors: Record<string, string> = Object.fromEntries(others.filter((o) => o.at?.startsWith(`${sheet.id}!`)).map((o) => [o.at!.slice(sheet.id.length + 1), o.name]));
  const range = (() => {
    const a = anchor ?? sel;
    return { r1: Math.min(a.r, sel.r), r2: Math.max(a.r, sel.r), c1: Math.min(a.c, sel.c), c2: Math.max(a.c, sel.c) };
  })();
  const inRange = (r: number, c: number) => r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;
  const rangeAddrs = () => {
    const out: string[] = [];
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) out.push(addr(r, c));
    return out;
  };
  const selCell = sheet.cells[selAddr];
  const barValue = draft ?? selCell?.input ?? "";
  const selTable = tableAt(sheet, sel.r, sel.c);

  /** Fill handle: repeat the selection down or right, shifting formulas; numbers with a constant step continue as a series. */
  const fill = async (to: Pos) => {
    const down = to.r > range.r2;
    const right = !down && to.c > range.c2;
    if (!down && !right) return;
    const h = range.r2 - range.r1 + 1;
    const w = range.c2 - range.c1 + 1;
    const cells: Record<string, string | null> = {};
    const series = (vals: (string | undefined)[]) => {
      const ns = vals.map((v) => (v !== undefined && v.trim() !== "" && !v.startsWith("=") && !Number.isNaN(Number(v)) ? Number(v) : null));
      if (ns.length < 2 || ns.some((x) => x === null)) return null;
      const step = (ns[1] as number) - (ns[0] as number);
      return ns.every((x, i) => i === 0 || Math.abs((x as number) - (ns[i - 1] as number) - step) < 1e-9) ? { last: ns[ns.length - 1] as number, step } : null;
    };
    if (down) {
      for (let c = range.c1; c <= range.c2; c++) {
        const src = Array.from({ length: h }, (_, i) => sheet.cells[addr(range.r1 + i, c)]?.input);
        const ser = series(src);
        for (let r = range.r2 + 1; r <= to.r; r++) {
          const i = (r - range.r1) % h;
          cells[addr(r, c)] = ser ? String(ser.last + ser.step * (r - range.r2)) : shiftFormula(src[i], r - (range.r1 + i), 0) ?? null;
        }
      }
    } else {
      for (let r = range.r1; r <= range.r2; r++) {
        const src = Array.from({ length: w }, (_, j) => sheet.cells[addr(r, range.c1 + j)]?.input);
        const ser = series(src);
        for (let c = range.c2 + 1; c <= to.c; c++) {
          const j = (c - range.c1) % w;
          cells[addr(r, c)] = ser ? String(ser.last + ser.step * (c - range.c2)) : shiftFormula(src[j], 0, c - (range.c1 + j)) ?? null;
        }
      }
    }
    await run(() => fusion.cells(id, { sheet: sheet.id, cells }));
    setAnchor({ r: range.r1, c: range.c1 });
    setSel(down ? { r: to.r, c: range.c2 } : { r: range.r2, c: to.c });
  };
  const inFill = (r: number, c: number) =>
    !!fillTo && ((fillTo.r > range.r2 && r > range.r2 && r <= fillTo.r && c >= range.c1 && c <= range.c2) || (fillTo.r <= range.r2 && fillTo.c > range.c2 && c > range.c2 && c <= fillTo.c && r >= range.r1 && r <= range.r2));

  const commit = async (text: string | null, at = selAddr) => {
    setDraft(null);
    if ((sheet.cells[at]?.input ?? "") === (text ?? "")) return;
    await run(() => fusion.cells(id, { sheet: sheet.id, cells: { [at]: text || null } }));
  };
  const move = (dr: number, dc: number, extend = false) => {
    if (extend) setAnchor((a) => a ?? sel);
    else setAnchor(null);
    setSel((s) => ({ r: Math.max(0, s.r + dr), c: Math.max(0, Math.min(size.cols - 1, s.c + dc)) }));
  };
  const format = (patch: Partial<CellFormat> | null) => run(() => fusion.cells(id, { sheet: sheet.id, formats: Object.fromEntries(rangeAddrs().map((a) => [a, patch ? { ...(sheet.cells[a]?.format ?? {}), ...patch } : null])) }));
  const saveDoc = (patch: (d: typeof doc) => typeof doc) => run(() => fusion.save(id, patch(structuredClone(doc))));

  const onKey = async (e: KeyboardEvent<HTMLDivElement>) => {
    if (draft !== null) return;
    const k = e.key;
    if (k.startsWith("Arrow")) {
      e.preventDefault();
      move(k === "ArrowUp" ? -1 : k === "ArrowDown" ? 1 : 0, k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : 0, e.shiftKey);
    } else if (k === "Tab") {
      e.preventDefault();
      move(0, e.shiftKey ? -1 : 1);
    } else if (k === "Enter" && editable) {
      e.preventDefault();
      setDraft(selCell?.input ?? "");
      barRef.current?.focus();
    } else if ((k === "Delete" || k === "Backspace") && editable) {
      e.preventDefault();
      await run(() => fusion.cells(id, { sheet: sheet.id, cells: Object.fromEntries(rangeAddrs().filter((a) => sheet.cells[a]?.input).map((a) => [a, null])) }));
    } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "c") {
      const rows: (string | undefined)[][] = [];
      for (let r = range.r1; r <= range.r2; r++) {
        const row: (string | undefined)[] = [];
        for (let c = range.c1; c <= range.c2; c++) row.push(sheet.cells[addr(r, c)]?.input);
        rows.push(row);
      }
      setClip({ from: { r: range.r1, c: range.c1 }, rows });
      void navigator.clipboard?.writeText(rows.map((row) => row.map((x) => x ?? "").join("\t")).join("\n")).catch(() => undefined);
    } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "v" && editable) {
      e.preventDefault();
      let rows = clip?.rows;
      let from = clip?.from ?? sel;
      if (!rows) {
        const text = await navigator.clipboard?.readText().catch(() => "");
        rows = (text ?? "").split(/\r?\n/).filter((l, i, all) => l !== "" || i < all.length - 1).map((l) => l.split("\t"));
        from = sel;
      }
      const cells: Record<string, string | null> = {};
      rows.forEach((row, i) => row.forEach((v, j) => (cells[addr(sel.r + i, sel.c + j)] = shiftFormula(v, sel.r - from.r, sel.c - from.c) ?? null)));
      await run(() => fusion.cells(id, { sheet: sheet.id, cells }));
    } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && editable) {
      setDraft(k);
      barRef.current?.focus();
      e.preventDefault();
    }
  };

  const clickAction = async (a: string) => {
    setError(null);
    const n = ++issued.current;
    inflight.current++;
    try {
      const res = await fusion.action(id, sheet.id, a);
      latest(n, res);
      for (const t of res.toasts) toast(t.message, t.intent);
      for (const x of res.applied) toast(`${x.action_type}: ${x.edits} edits applied`, "success");
      if (!res.ok) toast(res.error ?? "The action failed", "danger");
      for (const fx of res.effects ?? []) {
        if (fx.type === "markdown_panel") {
          setPanel(null);
          setMarkdown({ title: fx.title, markdown: fx.markdown });
        } else if (fx.type === "open_url") {
          // http and https only (the server checks too); a new tab never gets a handle on this page
          const url = httpUrl(fx.url);
          if (!url) toast("The address was not opened: only http and https addresses are", "danger");
          else if (fx.redirect) window.location.assign(url);
          else window.open(url, "_blank", "noopener,noreferrer");
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inflight.current--;
    }
  };

  const renderCell = (r: number, c: number) => {
    const a = addr(r, c);
    const cell = sheet.cells[a];
    const v = vals[a];
    // a spilled result's first cell shows its top-left value (an error there shows as one)
    const top = shown(v)?.v;
    const rich = top && typeof top === "object" && !Array.isArray(top) && "__kind__" in (top as object) ? (top as RichValue) : null;
    const fmt = cell?.format;
    if (rich?.__kind__ === "dropdown")
      return (
        <select
          value={rich.multi ? undefined : String(rich.value ?? "")}
          multiple={rich.multi}
          disabled={!view.can_edit}
          onChange={(e) =>
            run(() =>
              fusion.cells(id, { sheet: sheet.id, selected: { [a]: rich.multi ? [...e.target.selectedOptions].map((o) => rich.options.find((x) => String(x) === o.value)) : rich.options.find((x) => String(x) === e.target.value) ?? null } }),
            )
          }
          onClick={(e) => e.stopPropagation()}
          className="h-full w-full bg-transparent text-xs outline-none"
        >
          <option value="">{rich.placeholder || "—"}</option>
          {rich.options.map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      );
    if (rich?.__kind__ === "action" || rich?.__kind__ === "validation") {
      const label = rich.__kind__ === "action" ? (rich.label?.text ?? "▶") : "Validate";
      const intent = rich.__kind__ === "action" ? rich.label?.intent : "primary";
      // action.label(type, …): a button (the default), a link or a tag
      const kind = rich.__kind__ === "action" ? (rich.label?.type ?? "button") : "button";
      const icon = rich.__kind__ === "action" ? labelIcon(rich.label?.icon) : null;
      const tone = intent === "success" ? "text-ok" : intent === "danger" ? "text-bad" : intent === "warning" ? "text-warn" : "text-ocean";
      const fill = intent === "success" ? "bg-ok/20" : intent === "danger" ? "bg-bad/20" : intent === "warning" ? "bg-warn/20" : "bg-ocean/20";
      return (
        <button
          type="button"
          disabled={!view.can_edit}
          onClick={(e) => {
            e.stopPropagation();
            void clickAction(a);
          }}
          data-label-type={kind}
          className={kind === "link" ? `w-full truncate px-1 py-0.5 text-left text-[11px] font-medium underline ${tone}` : `${kind === "tag" ? "rounded-full" : "w-full rounded"} px-2 py-0.5 text-[11px] font-medium ${fill} ${tone}`}
        >
          <span className={`inline-flex max-w-full items-center gap-1 ${kind === "link" ? "" : "justify-center"}`}>
            {icon && <Icon name={icon} className="h-3 w-3 shrink-0" />}
            <span className="truncate">{label}</span>
          </span>
        </button>
      );
    }
    if (rich?.__kind__ === "checkbox")
      return (
        <label className="flex h-full items-center gap-1.5" onMouseDown={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={!!rich.value}
            disabled={!view.can_edit || !!cell?.locked}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => run(() => fusion.control(id, sheet.id, a, e.target.checked))}
          />
          {rich.label && <span className="truncate">{rich.label}</span>}
        </label>
      );
    if (rich?.__kind__ === "datepicker")
      return <DateCell value={rich.value} precision={rich.precision} disabled={!view.can_edit || !!cell?.locked} onPick={(value) => void run(() => fusion.control(id, sheet.id, a, value))} />;
    if (rich?.__kind__ === "chart") return <FusionChart chart={rich} />;
    if (rich?.__kind__ === "object")
      return (
        <a
          href={`/ontology/objects/${encodeURIComponent(rich.object_type_id)}/${encodeURIComponent(rich.primary_key)}`}
          title={`${rich.object_type} · ${rich.primary_key}`}
          onClick={(e) => e.stopPropagation()}
          className="flex min-w-0 items-center gap-1 text-ocean hover:underline"
        >
          <Icon name="cube" className="h-3 w-3 shrink-0" />
          <span className="truncate">{rich.title}</span>
        </a>
      );
    if (rich?.__kind__ === "property")
      return <span title={`${rich.property} of ${rich.rid}`}>{formatValue({ d: v?.d ?? "", v: rich.value }, fmt)}</span>;
    if (rich?.__kind__ === "url")
      return (
        <a href={rich.href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-ocean underline">
          {rich.value}
        </a>
      );
    if (rich?.__kind__ === "timeseries") {
      // a sparkline of the numeric points (the latest 200)
      const pts = rich.points.filter((p) => typeof p[1] === "number").slice(-200) as [number, number][];
      const lo = Math.min(...pts.map((p) => p[1]));
      const hi = Math.max(...pts.map((p) => p[1]));
      const d = pts.map((p, i) => `${i ? "L" : "M"}${pts.length > 1 ? (i / (pts.length - 1)) * 100 : 50},${hi > lo ? 18 - ((p[1] - lo) / (hi - lo)) * 16 : 10}`).join(" ");
      return (
        <span className="flex items-center gap-1" title={`${rich.label}: ${rich.points.length} points`}>
          {pts.length > 0 && <svg viewBox="0 0 100 20" preserveAspectRatio="none" className="h-4 w-16 shrink-0"><path d={d} className="fill-none stroke-ocean" strokeWidth={1.5} vectorEffect="non-scaling-stroke" /></svg>}
          <span className="truncate">{pts.length ? String(pts[pts.length - 1][1]) : `${rich.points.length} points`}</span>
        </span>
      );
    }
    if (rich?.__kind__ === "error")
      return (
        <span className="text-bad" title={rich.message}>
          {errorText(rich.code)}
        </span>
      );
    const text = formatValue(shown(v), fmt);
    return (
      <span title={rich?.__kind__ === "styled" ? (rich.tooltip ?? undefined) : undefined} style={rich?.__kind__ === "styled" && rich.color ? { color: rich.color } : undefined}>
        {text}
      </span>
    );
  };

  const isTemplateGate = doc.template && !editTemplate;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <AppHeader app="Fusion" icon="table" href="/fusion" crumbs={[{ label: view.item.name.replace(/\.fusion$/, "") }]}>
        <PresenceBar itemId={id} editing={editable} at={`${sheet.id}!${selAddr}`} interval={4000} onOthers={setOthers} />
        <button type="button" onClick={() => setPanel(panel === "data" ? null : "data")} className={buttonClass.secondary}>
          <Icon name="database" className="h-3.5 w-3.5" /> Find and use data
        </button>
        <button type="button" onClick={() => setPanel(panel === "sources" ? null : "sources")} className={buttonClass.ghost}>
          <Icon name="link" className="h-3.5 w-3.5" /> Sources ({view.sources.length})
        </button>
        <button type="button" onClick={() => setPanel(panel === "indexes" ? null : "indexes")} className={buttonClass.ghost} title="Indexed datasets: indexes for lookups">
          <Icon name="bolt" className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => setPanel(panel === "conditional" ? null : "conditional")} className={buttonClass.ghost} title="Conditional formatting">
          <Icon name="palette" className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => setPanel(panel === "history" ? null : "history")} className={buttonClass.ghost} title="Edit history">
          <Icon name="history" className="h-4 w-4" />
        </button>
        <select
          value={doc.settings.presentation ? "presentation" : "spreadsheet"}
          onChange={(e) => saveDoc((d) => ({ ...d, settings: { ...d.settings, presentation: e.target.value === "presentation" } }))}
          disabled={!view.can_edit}
          className="rounded-md border border-line-2 bg-ink px-2 py-1.5 text-xs"
          aria-label="View"
        >
          <option value="spreadsheet">Spreadsheet view</option>
          <option value="presentation">Presentation view</option>
        </select>
      </AppHeader>
      {isTemplateGate && (
        <div className="flex items-center gap-3 border-b border-warn/40 bg-warn/10 px-4 py-2 text-sm">
          <Icon name="copy" className="h-4 w-4 text-warn" /> This spreadsheet is a template: opening it makes a copy.
          <button type="button" onClick={async () => { const v = await run(() => fusion.copy(id)); if (v) router.push(`/fusion/${v.item.id}`); }} className={buttonClass.primary}>
            Make a copy
          </button>
          {view.can_edit && (
            <button type="button" onClick={() => setEditTemplate(true)} className={buttonClass.ghost}>
              Edit the template
            </button>
          )}
        </div>
      )}
      {!doc.settings.presentation && (
        <div className="flex flex-wrap items-center gap-1 border-b border-line bg-panel px-3 py-1.5 text-xs">
          <button type="button" disabled={!editable} onClick={() => format({ bold: !selCell?.format?.bold })} className="rounded px-2 py-1 font-bold hover:bg-panel-2">B</button>
          <button type="button" disabled={!editable} onClick={() => format({ italic: !selCell?.format?.italic })} className="rounded px-2 py-1 italic hover:bg-panel-2">I</button>
          <select disabled={!editable} value={selCell?.format?.number ?? "general"} onChange={(e) => format({ number: e.target.value as CellFormat["number"] })} className="rounded border border-line bg-ink px-1 py-1" aria-label="Number format">
            <option value="general">General</option>
            <option value="0.00">0.00</option>
            <option value="currency">Currency</option>
            <option value="percent">Percent</option>
          </select>
          <select disabled={!editable} value={selCell?.format?.fill ?? ""} onChange={(e) => format({ fill: e.target.value || undefined })} className="rounded border border-line bg-ink px-1 py-1" aria-label="Fill">
            <option value="">No fill</option>
            <option value="rgba(59,130,246,0.18)">Blue</option>
            <option value="rgba(34,197,94,0.18)">Green</option>
            <option value="rgba(234,179,8,0.2)">Yellow</option>
            <option value="rgba(239,68,68,0.18)">Red</option>
          </select>
          <button type="button" disabled={!editable} onClick={() => format(null)} className="rounded px-2 py-1 hover:bg-panel-2">Clear format</button>
          <span className="mx-1 h-4 w-px bg-line" />
          <button type="button" disabled={!view.can_edit} onClick={() => run(() => fusion.cells(id, { sheet: sheet.id, locks: Object.fromEntries(rangeAddrs().map((a) => [a, !selCell?.locked])) }))} className="rounded px-2 py-1 hover:bg-panel-2">
            <Icon name={selCell?.locked ? "unlock" : "lock"} className="mr-1 inline h-3 w-3" /> {selCell?.locked ? "Unlock" : "Lock"}
          </button>
          <span className="mx-1 h-4 w-px bg-line" />
          {!selTable ? (
            <button
              type="button"
              disabled={!editable}
              onClick={async () => {
                const name = await promptDialog("Name of the table region (the first selected row is its header)", `Table${sheet.tables.length + 1}`);
                if (name) await run(() => fusion.createTable(id, { sheet: sheet.id, name, start: addr(range.r1, range.c1), columns: range.c2 - range.c1 + 1, rows: range.r2 - range.r1 }));
              }}
              className="rounded px-2 py-1 hover:bg-panel-2"
            >
              <Icon name="table" className="mr-1 inline h-3 w-3" /> Create table
            </button>
          ) : (
            <>
              <span className="text-muted">Table {selTable.table.name}:</span>
              {(["asc", "desc"] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  disabled={!editable}
                  onClick={() => {
                    const [r0] = parseAddr(selTable.table.start);
                    return run(() => fusion.sortTable(id, selTable.table.name, vals[addr(r0, sel.c)]?.d || colLetters(sel.c), o === "desc"));
                  }}
                  className="rounded px-2 py-1 hover:bg-panel-2"
                >
                  Sort {o === "asc" ? "A→Z" : "Z→A"}
                </button>
              ))}
              <button type="button" disabled={!editable} onClick={() => run(() => fusion.appendRow(id, selTable.table.name))} className="rounded px-2 py-1 hover:bg-panel-2">
                + Row
              </button>
              <button
                type="button"
                disabled={!editable}
                onClick={async () => {
                  if (selTable.table.sync) {
                    if (await confirmDialog(`Stop syncing ${selTable.table.name} to its dataset?`)) await run(() => fusion.syncTable(id, selTable.table.name, { enabled: false }));
                    return;
                  }
                  const name = await promptDialog("Dataset name (created next to this spreadsheet)", selTable.table.name);
                  if (name) await run(() => fusion.syncTable(id, selTable.table.name, { name }));
                }}
                className="rounded px-2 py-1 hover:bg-panel-2"
              >
                <Icon name="database" className="mr-1 inline h-3 w-3" /> {selTable.table.sync ? `Synced (${selTable.table.sync.rows ?? 0} rows) · stop` : "Sync to dataset"}
              </button>
            </>
          )}
          <span className="mx-1 h-4 w-px bg-line" />
          <label className="flex items-center gap-1 text-muted">
            <input type="checkbox" checked={!!doc.settings.hide_grid} disabled={!view.can_edit} onChange={(e) => saveDoc((d) => ({ ...d, settings: { ...d.settings, hide_grid: e.target.checked } }))} /> Hide grid
          </label>
          <label className="flex items-center gap-1 text-muted">
            <input type="checkbox" checked={!!doc.template} disabled={!view.can_edit} onChange={(e) => saveDoc((d) => ({ ...d, template: e.target.checked }))} /> Template
          </label>
        </div>
      )}
      {!doc.settings.presentation && (
        <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
          <div className="w-16 rounded border border-line bg-ink px-2 py-1 font-mono text-xs text-soft">{range.r1 !== range.r2 || range.c1 !== range.c2 ? `${addr(range.r1, range.c1)}:${addr(range.r2, range.c2)}` : selAddr}</div>
          <span className="font-serif italic text-muted">ƒx</span>
          <input
            ref={barRef}
            value={barValue}
            readOnly={!editable || !!selCell?.locked}
            onChange={(e) => setDraft(e.target.value)}
            // functional: typing on a selected cell sets the draft to that character and focuses the bar in one go —
            // this handler's `draft` is still the previous render's null then, and would overwrite the character
            onFocus={() => setDraft((d) => d ?? selCell?.input ?? "")}
            onKeyDown={async (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                await commit(draft ?? "");
                move(1, 0);
                gridRef.current?.focus();
              } else if (e.key === "Escape") {
                setDraft(null);
                gridRef.current?.focus();
              } else if (e.key === "Tab") {
                e.preventDefault();
                await commit(draft ?? "");
                move(0, 1);
                gridRef.current?.focus();
              }
            }}
            onBlur={() => draft !== null && commit(draft)}
            placeholder={selCell?.locked ? "Locked" : "Type a value or a formula: =sum(A1:A3), =lookup('dataset', 'column', 'filter column', A1)"}
            className="min-w-0 flex-1 rounded border border-line bg-ink px-3 py-1 font-mono text-xs text-soft outline-none focus:border-ocean"
          />
          {!!vals[selAddr]?.v && typeof vals[selAddr].v === "object" && (vals[selAddr].v as RichValue).__kind__ === "error" && (
            <span className="max-w-xs truncate text-xs text-bad" title={(vals[selAddr].v as { message: string }).message}>
              {(vals[selAddr].v as { message: string }).message}
            </span>
          )}
        </div>
      )}
      <ErrorBox message={error} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div ref={gridRef} tabIndex={0} onKeyDown={onKey} className="min-h-0 flex-1 overflow-auto outline-none">
          <table className="border-collapse text-xs">
            {!doc.settings.presentation && (
              <thead className="sticky top-0 z-20">
                <tr>
                  <th className="sticky left-0 z-30 h-6 w-10 border border-line bg-panel-2" />
                  {Array.from({ length: size.cols }, (_, c) => (
                    <th key={c} className={`h-6 min-w-[110px] border border-line bg-panel-2 font-medium text-muted ${c >= range.c1 && c <= range.c2 ? "text-ocean" : ""}`}>
                      {colLetters(c)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {Array.from({ length: size.rows }, (_, r) => (
                <tr key={r}>
                  {!doc.settings.presentation && (
                    <th className={`sticky left-0 z-10 h-7 border border-line bg-panel-2 px-1 text-right font-normal text-muted ${r >= range.r1 && r <= range.r2 ? "text-ocean" : ""}`}>{r + 1}</th>
                  )}
                  {Array.from({ length: size.cols }, (_, c) => {
                    const a = addr(r, c);
                    const cell = sheet.cells[a];
                    const t = tableAt(sheet, r, c);
                    const v = shown(vals[a])?.v;
                    const numeric = typeof v === "number";
                    // a chart with a size of its own is drawn over the cells beside and below its cell
                    const sized = !!v && typeof v === "object" && (v as RichValue).__kind__ === "chart" && !!chartSize(v as ChartValue);
                    const selected = sel.r === r && sel.c === c;
                    const grid = doc.settings.hide_grid || doc.settings.presentation ? "border-transparent" : "border-line";
                    return (
                      <td
                        key={c}
                        onMouseDown={(e) => {
                          if (draft !== null) void commit(draft);
                          if (e.shiftKey) setAnchor((x) => x ?? sel);
                          else setAnchor(null);
                          setSel({ r, c });
                          gridRef.current?.focus();
                        }}
                        onMouseEnter={() => fillTo && setFillTo({ r, c })}
                        onMouseUp={() => {
                          if (!fillTo) return;
                          const to = fillTo;
                          setFillTo(null);
                          void fill(to);
                        }}
                        onDoubleClick={() => {
                          if (!editable || cell?.locked) return;
                          setDraft(cell?.input ?? "");
                          barRef.current?.focus();
                        }}
                        style={{ background: cell?.format?.fill, fontWeight: cell?.format?.bold || t?.header ? 600 : undefined, fontStyle: cell?.format?.italic ? "italic" : undefined, ...(sheet.conditional?.length ? conditionalStyle(sheet, vals, a) : {}) }}
                        className={`relative h-7 min-w-[110px] max-w-[260px] ${sized ? "overflow-visible" : "truncate"} border ${grid} px-1.5 ${numeric ? "text-right tabular-nums" : ""} ${t ? (t.header ? "bg-ocean/10" : "bg-ocean/[0.03]") : ""} ${
                          inRange(r, c) && !selected ? "bg-ocean/10" : ""
                        } ${selected ? "outline outline-2 -outline-offset-1 outline-ocean" : ""} ${inFill(r, c) ? "outline-dashed outline-1 -outline-offset-1 outline-ocean" : ""} ${!selected && cursors[a] ? "outline outline-2 -outline-offset-1 outline-sand" : ""}`}
                        title={cursors[a] ? `${cursors[a]} is here` : undefined}
                      >
                        {cell?.locked && !doc.settings.presentation && <Icon name="lock" className="absolute right-0.5 top-0.5 h-2.5 w-2.5 text-muted" />}
                        {editable && !doc.settings.presentation && r === range.r2 && c === range.c2 && (
                          <span
                            title="Drag to fill"
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              setFillTo({ r, c });
                            }}
                            className="absolute -bottom-1 -right-1 z-10 h-2 w-2 cursor-crosshair border border-white bg-ocean"
                          />
                        )}
                        {renderCell(r, c)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {markdown && !panel && (
          <aside className="w-[380px] shrink-0 overflow-y-auto border-l border-line bg-panel p-4 text-sm">
            <div className="mb-3 flex items-center gap-2 border-b border-line pb-2">
              <Icon name="doc" className="h-4 w-4 text-ocean" />
              <span className="min-w-0 truncate font-semibold">{markdown.title}</span>
              <button type="button" onClick={() => setMarkdown(null)} className="ml-auto rounded p-1 text-muted hover:text-white" aria-label="Close">
                <Icon name="x" className="h-4 w-4" />
              </button>
            </div>
            {/* renderMarkdown escapes HTML first: the panel never shows raw HTML from a cell */}
            <div
              className="fusion-markdown-panel space-y-2 text-soft [&_a]:text-ocean [&_a]:underline [&_code]:rounded [&_code]:bg-panel-2 [&_code]:px-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:ml-5 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-panel-2 [&_pre]:p-2 [&_ul]:ml-5 [&_ul]:list-disc"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown.markdown) }}
            />
          </aside>
        )}
        {panel && (
          <FusionPanel
            kind={panel}
            view={view}
            sheet={sheet}
            target={selAddr}
            onClose={() => setPanel(null)}
            onInsert={(formula) => commit(formula)}
            onView={setView}
            run={run}
          />
        )}
      </div>
      <div className="flex items-center gap-1 border-t border-line bg-panel px-3 py-1.5 text-xs">
        {doc.sheets.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              setSheetId(s.id);
              setSel({ r: 0, c: 0 });
              setAnchor(null);
            }}
            onDoubleClick={async () => {
              if (!view.can_edit) return;
              const name = await promptDialog("Rename the sheet", s.name);
              if (name && name !== s.name) await saveDoc((d) => ({ ...d, sheets: d.sheets.map((x) => (x.id === s.id ? { ...x, name } : x)) }));
            }}
            className={`rounded px-3 py-1 ${s.id === sheet.id ? "bg-ocean/15 font-medium text-ocean" : "text-muted hover:bg-panel-2"}`}
          >
            {s.name}
          </button>
        ))}
        {view.can_edit && (
          <button type="button" onClick={async () => { const v = await run(() => fusion.addSheet(id)); if (v) setSheetId(v.document.sheets[v.document.sheets.length - 1].id); }} className="rounded p-1 text-muted hover:bg-panel-2" aria-label="Add sheet">
            <Icon name="plus" className="h-3.5 w-3.5" />
          </button>
        )}
        <span className="ml-auto text-muted">
          {Object.keys(sheet.cells).length} cells · {sheet.tables.length} tables{!view.can_edit ? " · read only" : ""}
        </span>
      </div>
      <div className="pointer-events-none fixed left-1/2 top-16 z-50 flex -translate-x-1/2 flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`rounded-lg border px-4 py-2 text-xs shadow-lg ${t.intent === "danger" ? "border-bad/40 bg-bad/15 text-bad" : t.intent === "success" ? "border-ok/40 bg-ok/15 text-ok" : "border-ocean/40 bg-ocean/15 text-ocean"}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
