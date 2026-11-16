"use client";

import { PresenceBar, type PresenceOther } from "@/components/Presence";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, ErrorBox } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { newWidget, ParametersEditor, useSources, WidgetEditor } from "@/components/reports/ReportEditor";
import { ApiError, Loading } from "@/components/States";
import { BoardView } from "@/components/contour/Boards";
import { TableCardDashboard } from "@/components/quiver/TableCards";
import { QuiverDashboard } from "@/components/timeseries/Quiver";
import type { Analysis as QuiverAnalysis } from "@/lib/timeseries";
import { cellText } from "@/lib/quiverTables";
import { BarChart, LineChart, PieChart } from "@/components/workshop/Charts";
import { renderMarkdown } from "@/lib/markdown";
import { MergeDialog } from "@/components/reports/MergeDialog";
import { HistoryPanel } from "@/components/reports/HistoryPanel";
import { reports, ReportsError, type MergeConflicts, type Report, type ReportData, type ReportRevision, type ReportView, type ReportWidget, type Resolution, type SaveView, type WidgetKind } from "@/lib/reports";

export default function ReportPage() {
  return (
    <Suspense>
      <ReportScreen />
    </Suspense>
  );
}

function ReportScreen() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const printing = search.get("print") === "1";
  const [view, setView] = useState<ReportView | null>(null);
  const [rep, setRep] = useState<Report | null>(null);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [data, setData] = useState<ReportData | null>(null);
  const [edit, setEdit] = useState(search.get("edit") === "1");
  const [sel, setSel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [suggest, setSuggest] = useState<Record<string, unknown[]>>({});
  const [note, setNote] = useState<string | null>(null);
  const sources = useSources();
  // a save from an older revision is merged on the server; its conflicts are settled here, then saved
  const [merge, setMerge] = useState<MergeConflicts | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  // revision history; a restore is a save too: its conflicts settle in the same dialog (mergeRestore: the revision)
  const [history, setHistory] = useState(false);
  const [mergeRestore, setMergeRestore] = useState<number | null>(null);
  // a read-only preview of a kept revision (its layout on today's data) shown in place of the report; the copy on
  // screen, with any unsaved changes, stays as it is underneath
  const [preview, setPreview] = useState<{ rev: number; at: string; by: string; report: Report } | null>(null);
  // keyed by revision and parameter values: an answer for another revision / values is not shown
  const [previewData, setPreviewData] = useState<{ key: string; data: ReportData } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // co-editing: others' saves load while this copy has no unsaved changes
  const [others, setOthers] = useState<PresenceOther[]>([]);
  const othersEditing = others.some((o) => o.editing);
  const loadedRev = rep?.rev ?? 0;
  useEffect(() => {
    if (!othersEditing || dirty) return;
    const t = window.setInterval(() => {
      reports.get(id).then((v) => {
        if ((v.report.rev ?? 0) === loadedRev) return;
        setView(v);
        setRep(v.report);
      }, () => undefined);
    }, 5000);
    return () => window.clearInterval(t);
  }, [id, othersEditing, dirty, loadedRev]);

  useEffect(() => {
    reports.get(id).then((v) => (setView(v), setRep(v.report)), (e: Error) => setError(e.message));
  }, [id]);
  const pkey = JSON.stringify(params);
  const reload = useCallback(() => {
    reports.data(id, JSON.parse(pkey) as Record<string, unknown>).then(setData, (e: Error) => setError(e.message));
  }, [id, pkey]);
  useEffect(() => {
    if (view) reload();
  }, [view, reload]);
  const previewRev = preview?.rev ?? null;
  useEffect(() => {
    if (previewRev === null) return;
    let live = true;
    reports.revisionData(id, previewRev, JSON.parse(pkey) as Record<string, unknown>).then(
      (d) => live && (setPreviewData({ key: `${previewRev}|${pkey}`, data: d }), setPreviewError(null)),
      (e: Error) => live && setPreviewError(e.message),
    );
    return () => {
      live = false;
    };
  }, [id, previewRev, pkey]);
  useEffect(() => {
    for (const p of view?.report.parameters ?? [])
      if (p.suggest || p.values) reports.suggestions(id, p.id).then((v) => setSuggest((s) => ({ ...s, [p.id]: v })), () => undefined);
  }, [id, view]);

  if (error && !view) return <ApiError message={error} />;
  if (!view || !rep) return <Loading />;
  const saved = (v: SaveView) => {
    setView(v);
    setRep(v.report);
    setDirty(false);
    setError(null);
    setMerge(null);
    setMergeError(null);
    setMergeRestore(null);
    setPreview(null);
    if (v.merge)
      flash(v.merge.resolved.length
        ? `Saved, merged with the changes others saved (${v.merge.resolved.length} conflict${v.merge.resolved.length === 1 ? "" : "s"} settled)`
        : "Saved, merged with the changes others saved since you opened the report");
  };
  const save = async (): Promise<boolean> => {
    try {
      saved(await reports.save(id, rep));
      return true;
    } catch (e) {
      const conflicts = e instanceof ReportsError ? e.conflicts : null;
      if (conflicts) {
        // changes that conflict with others' saves: choose per conflict (the copy stays on screen meanwhile)
        setMergeError(null);
        setMerge(conflicts);
        return false;
      }
      const m = (e as Error).message;
      if (m.includes("saved by someone else")) {
        // no base revision to merge from: keep this copy on screen so nothing is lost; reloading shows theirs
        setError(`${m}. Your changes are still here: copy what you need, then reload.`);
        return false;
      }
      setError(m);
      return false;
    }
  };
  const settle = async (resolutions: Record<string, Resolution>) => {
    if (!merge) return;
    setMergeBusy(true);
    try {
      const settleWith = { resolutions, resolveRev: merge.theirs_rev };
      if (mergeRestore !== null) {
        const from = mergeRestore;
        const v = await reports.restore(id, from, rep.rev ?? 0, settleWith);
        saved(v);
        flash(`Restored revision ${from} as revision ${v.report.rev ?? ""}, merged with the changes others saved`);
      } else saved(await reports.save(id, rep, settleWith));
      reload();
    } catch (e) {
      const conflicts = e instanceof ReportsError ? e.conflicts : null;
      if (conflicts) {
        setMerge(conflicts);
        setMergeError("The report was saved again meanwhile: the conflicts below are against the newest version.");
      } else setMergeError((e as Error).message);
    } finally {
      setMergeBusy(false);
    }
  };
  const restore = async (from: number) => {
    try {
      const v = await reports.restore(id, from, rep.rev ?? 0);
      saved(v);
      flash(`Restored revision ${from} as revision ${v.report.rev ?? ""}${v.merge ? ", merged with the changes others saved" : ""}`);
    } catch (e) {
      const conflicts = e instanceof ReportsError ? e.conflicts : null;
      if (conflicts) {
        setMergeError(null);
        setMergeRestore(from);
        setMerge(conflicts);
      } else setError((e as Error).message);
    }
  };
  const change = (r: Report) => {
    setRep(r);
    setDirty(true);
  };
  const setWidget = (wid: string, p: Partial<ReportWidget>) => change({ ...rep, widgets: rep.widgets.map((w) => (w.id === wid ? { ...w, ...p } : w)) });
  const move = (i: number, d: number) => {
    const ws = [...rep.widgets];
    const j = i + d;
    if (j < 0 || j >= ws.length) return;
    [ws[i], ws[j]] = [ws[j], ws[i]];
    change({ ...rep, widgets: ws });
  };
  const flash = (m: string) => {
    setNote(m);
    window.setTimeout(() => setNote(null), 3000);
  };
  const openPreview = async (r: ReportRevision | null) => {
    if (!r) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    try {
      const content = await reports.revision(id, r.rev);
      setPreview({ rev: r.rev, at: r.at, by: r.by, report: content });
      setPreviewError(null);
    } catch (e) {
      setPreviewError((e as Error).message);
    }
  };
  // while a revision is previewed the page shows it read-only (exports and CSV stay the current report's)
  const editing = edit && !preview;
  const shownRep = preview?.report ?? rep;
  const shownData = preview ? (previewData?.key === `${preview.rev}|${pkey}` ? previewData.data : null) : data;
  const values = data?.params ?? params;
  const shown = (editing ? rep.widgets : shownRep.widgets.filter((w) => !w.hidden));
  const selected = rep.widgets.find((w) => w.id === sel);

  return (
    <div className="flex-1 overflow-y-auto">
      {!printing && (
        <AppHeader app="Reports (Sunset)" icon="doc" href="/reports" crumbs={[{ label: rep.title }]}>
          <PresenceBar itemId={id} editing={edit} interval={5000} onOthers={setOthers} />
          {view.can_edit && (
            <button type="button" onClick={() => (preview ? (setPreview(null), setEdit(true)) : edit && dirty ? save().then((done) => done && setEdit(false)) : setEdit(!edit))} className={editing ? buttonClass.primary : buttonClass.secondary}>
              {editing ? (dirty ? "Save and view" : "View") : "Edit"}
            </button>
          )}
          <button type="button" onClick={() => setHistory(!history)} aria-pressed={history} className={buttonClass.ghost} title="Revisions: who saved what, compare, restore">
            <Icon name="history" className="h-3.5 w-3.5" /> History
          </button>
          <button type="button" onClick={async () => { const v = await reports.duplicate(id); router.push(`/reports/${v.item.id}`); }} className={buttonClass.ghost}>
            <Icon name="copy" className="h-3.5 w-3.5" /> Duplicate
          </button>
          <a href={reports.pdfUrl(id)} className={buttonClass.ghost}>PDF</a>
          <button type="button" onClick={async () => { try { const b = await reports.pptx(id, values); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `${rep.title}.pptx`; a.click(); } catch (e) { setError((e as Error).message); } }} className={buttonClass.ghost}>
            PowerPoint
          </button>
          <button type="button" onClick={async () => { const m = await reports.markdown(id, values); await navigator.clipboard?.writeText(m.markdown).catch(() => undefined); flash("Copied the report as Markdown"); }} className={buttonClass.ghost}>
            Copy as Markdown
          </button>
          <button type="button" onClick={async () => { const r = await reports.toNotepad(id, values); router.push(`/notepad/${r.notepad_id}`); }} className={buttonClass.ghost}>
            Convert to Notepad
          </button>
          <button type="button" onClick={async () => { try { const r = await reports.toContour(id); router.push(`/analytics/${r.item.id}`); } catch (e) { setError((e as Error).message); } }} className={buttonClass.ghost} title="A Contour analysis with the report's parameters, a path per data widget and the boards on its dashboard">
            Convert to Contour
          </button>
          <Link href={`/recipes?source=report&item=${id}`} className={buttonClass.ghost} title="Email on a schedule (Recipes)">
            <Icon name="bell" className="h-3.5 w-3.5" />
          </Link>
        </AppHeader>
      )}
      {/* the History panel (fixed, 28rem on the right) would cover the report's right side — the preview banner's
          Restore / Back to current among it: the report moves left of the panel while it is open */}
      <div className={`mx-auto ${editing ? "max-w-7xl" : "max-w-5xl"} p-6 ${history && !printing ? "md:mr-[28rem]" : ""}`}>
        <ErrorBox message={error} />
        {merge && (
          <MergeDialog key={merge.theirs_rev} merge={merge} busy={mergeBusy} error={mergeError} onSave={settle}
            onCancel={() => { setMerge(null); setMergeError(null); setMergeRestore(null); }} />
        )}
        {history && !printing && (
          <HistoryPanel id={id} currentRev={rep.rev ?? 0} dirty={dirty} canEdit={view.can_edit} previewRev={preview?.rev ?? null} onPreview={openPreview} onRestore={restore} onClose={() => setHistory(false)} />
        )}
        {note && <div className="mb-3 rounded border border-ok/40 bg-ok/10 px-3 py-2 text-xs text-ok">{note}</div>}
        {previewError && <div className="mb-3 rounded border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">Preview: {previewError}</div>}
        {preview && (
          <div role="status" aria-label="Revision preview" className="mb-3 flex flex-wrap items-center gap-2 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs print:hidden">
            <Icon name="eye" className="h-3.5 w-3.5 text-warn" />
            <span className="font-semibold text-soft">Revision {preview.rev}, read-only</span>
            <span className="text-muted">saved by {preview.by} · {new Date(preview.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · its layout on today&apos;s data</span>
            <span className="ml-auto flex gap-2">
              {view.can_edit && (
                <button type="button" disabled={dirty} onClick={() => restore(preview.rev)} className={buttonClass.secondary}
                  title={dirty ? "Save your changes first" : `Save revision ${preview.rev}'s content as a new revision`}>
                  <Icon name="restore" className="h-3.5 w-3.5" /> Restore this revision
                </button>
              )}
              <button type="button" onClick={() => openPreview(null)} className={buttonClass.primary}>Back to current</button>
            </span>
          </div>
        )}
        <div className={editing ? "grid gap-4 md:grid-cols-[1fr_360px]" : ""}>
          <div className="space-y-4">
            {editing ? (
              <input value={rep.title} onChange={(e) => change({ ...rep, title: e.target.value })} className={`${inputClass} text-lg font-semibold`} aria-label="Title" />
            ) : (
              <h1 className="text-2xl font-semibold">{shownRep.title}</h1>
            )}
            {shownRep.parameters.length > 0 && (
              <div className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-panel p-3 print:hidden">
                {shownRep.parameters.map((p) => (
                  <label key={p.id} className="text-xs text-muted">
                    {p.name}
                    <input
                      list={`sugg-${p.id}`}
                      type={p.type === "number" ? "number" : p.type === "date" ? "date" : "text"}
                      value={String(params[p.id] ?? p.default ?? "")}
                      onChange={(e) => setParams((x) => ({ ...x, [p.id]: e.target.value }))}
                      className={`${inputClass} w-44`}
                    />
                    <datalist id={`sugg-${p.id}`}>{(suggest[p.id] ?? []).map((v) => <option key={String(v)} value={String(v)} />)}</datalist>
                  </label>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              {shown.map((w, i) => (
                <WidgetBox key={w.id} w={w} d={shownData?.widgets[w.id]} edit={editing} selected={sel === w.id} onSelect={() => setSel(w.id)}
                  onMove={(d) => move(i, d)} onDelete={() => change({ ...rep, widgets: rep.widgets.filter((x) => x.id !== w.id) })}
                  csv={preview ? "" : reports.csvUrl(id, w.id, values)} />
              ))}
            </div>
            {editing && (
              <select value="" onChange={(e) => { if (!e.target.value) return; const w = newWidget(e.target.value as WidgetKind); change({ ...rep, widgets: [...rep.widgets, w] }); setSel(w.id); }} className={`${inputClass} w-56`} aria-label="Add content">
                <option value="">+ Add content…</option>
                {["text", "table", "chart", "metric", "object_table", "image", "divider", "page_break"].map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}
              </select>
            )}
          </div>
          {editing && (
            <aside className="h-fit space-y-4 rounded-xl border border-line bg-panel p-4">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{selected ? "Widget" : "Parameters"}</span>
                {selected && <button type="button" onClick={() => setSel(null)} className="ml-auto text-xs text-ocean hover:underline">Parameters</button>}
                <button type="button" disabled={!dirty} onClick={async () => { await save(); reload(); }} className={`${buttonClass.primary} ${selected ? "" : "ml-auto"}`}>
                  {dirty ? "Save" : "Saved"}
                </button>
              </div>
              {selected ? (
                <WidgetEditor w={selected} report={rep} sources={sources} onChange={(p) => setWidget(selected.id, p)} />
              ) : (
                <ParametersEditor report={rep} sources={sources} onChange={(parameters) => change({ ...rep, parameters })} />
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

function WidgetBox({ w, d, edit, selected, onSelect, onMove, onDelete, csv }: {
  w: ReportWidget; d?: ReportData["widgets"][string]; edit: boolean; selected: boolean; onSelect: () => void; onMove: (d: number) => void; onDelete: () => void; csv: string;
}) {
  const span = w.width === "half" ? "col-span-2 sm:col-span-1" : "col-span-2";
  if (w.kind === "page_break") return <div className={`${span} ${edit ? "border-t-2 border-dashed border-line py-1 text-center text-[10px] text-muted" : ""}`} style={{ breakAfter: "page" }}>{edit ? "Page break" : null}</div>;
  if (w.kind === "divider") return <hr className={`${span} border-line`} />;
  const data = d?.data;
  return (
    <section onClick={edit ? onSelect : undefined} style={{ minHeight: w.height }}
      className={`${span} rounded-xl border bg-panel p-4 ${edit ? "cursor-pointer" : ""} ${selected ? "border-ocean" : "border-line"} ${w.hidden ? "opacity-50" : ""}`}>
      {(d?.title || edit) && (
        <div className="mb-2 flex items-center gap-2">
          <h2 className="font-semibold">{d?.title ?? w.title}</h2>
          {["table", "chart", "metric", "object_table", "contour_board", "quiver_card"].includes(w.kind) && !edit && csv && (
            <a href={csv} className="ml-auto text-[11px] text-muted hover:text-ocean print:hidden">CSV</a>
          )}
          {edit && (
            <span className="ml-auto flex gap-1">
              <button type="button" onClick={(e) => { e.stopPropagation(); onMove(-1); }} className="text-muted hover:text-white" aria-label="Move up"><Icon name="left" className="h-3 w-3 rotate-90" /></button>
              <button type="button" onClick={(e) => { e.stopPropagation(); onMove(1); }} className="text-muted hover:text-white" aria-label="Move down"><Icon name="down" className="h-3 w-3" /></button>
              <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(); }} className="text-muted hover:text-bad" aria-label="Delete"><Icon name="trash" className="h-3.5 w-3.5" /></button>
            </span>
          )}
        </div>
      )}
      {d?.error && <p className="text-xs text-bad">{d.error}</p>}
      {w.kind === "text" && <div className="md-body text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(d?.text ?? w.text ?? "") }} />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {w.kind === "image" && w.src && <img src={w.src} alt={w.title ?? ""} className="max-h-96 rounded" />}
      {w.kind === "contour_board" && !!data?.board && (
        <>
          <p className="mb-1 text-[11px] text-muted">Contour · {String(data.source_name ?? "")}</p>
          <BoardView b={data.board as never} r={data.result as never} />
        </>
      )}
      {w.kind === "quiver_card" && !!data?.card && (
        <>
          <p className="mb-1 text-[11px] text-muted">Quiver · {String(data.source_name ?? "")}</p>
          <TableCardDashboard card={data.card as never} results={(data.results ?? {}) as never} />
        </>
      )}
      {w.kind === "quiver_card" && !!data?.client && (
        <>
          <p className="mb-1 text-[11px] text-muted">Quiver · {String(data.source_name ?? "")}</p>
          <QuiverDashboard analysis={{ ...(data.analysis as QuiverAnalysis), dashboard: { cards: [String(data.card_id)], inputs: [] } }} editableInputs={false} />
        </>
      )}
      {w.kind === "metric" && data && <div className="text-4xl font-semibold tabular-nums">{data.value === null || data.value === undefined ? "—" : Number(data.value).toLocaleString()}</div>}
      {w.kind === "chart" && data?.groups && (
        <div className="h-64">
          {w.chart === "pie" ? <PieChart data={data.groups} metricLabel={w.metric ?? "count"} /> : w.chart === "line" ? <LineChart data={data.groups} metricLabel={w.metric ?? "count"} /> : <BarChart data={data.groups} metricLabel={w.metric ?? "count"} />}
        </div>
      )}
      {(w.kind === "table" || w.kind === "object_table") && data?.rows && (
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-panel text-left text-muted">
              <tr>{(data.columns ?? []).map((c) => <th key={c.name} className="px-2 py-1 font-medium">{c.name}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.rows.map((r, i) => (
                <tr key={i}>
                  {(data.columns ?? []).map((c, j) => (
                    <td key={c.name} className="px-2 py-1">
                      {w.kind === "object_table" && j === 0 && r.__pk !== undefined && w.source ? (
                        <Link href={`/ontology/objects/${w.source.id}/${encodeURIComponent(String(r.__pk))}`} className="text-ocean hover:underline">{String(r[c.name] ?? "")}</Link>
                      ) : typeof r[c.name] === "number" ? (r[c.name] as number).toLocaleString() : cellText(r[c.name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {data.total !== undefined && data.total > data.rows.length && <p className="mt-1 text-[11px] text-muted">{data.rows.length} of {data.total.toLocaleString()} rows</p>}
        </div>
      )}
    </section>
  );
}
