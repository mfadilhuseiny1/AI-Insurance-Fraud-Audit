"use client";

/** Slate widgets: each renders its resolved properties and reports the user's state (selection, text…) and its
 *  events to the runtime. */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { ActionForm } from "@/components/ontology/ActionForm";
import { BarChart, LineChart, PieChart } from "@/components/workshop/Charts";
import { renderMarkdown } from "@/lib/markdown";
import { ontology, type ActionType, type ObjectType, type OntologyObject } from "@/lib/ontology";
import type { SlateWidget } from "@/lib/slate";
import type { SlateRuntime } from "@/lib/slateRuntime";
import { MoreWidgetBody } from "./SlateWidgetsMore";

type P = Record<string, unknown>;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === null || v === undefined || v === "" ? [] : [v]);
const s = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

const field = "w-full rounded border border-line-2 bg-ink px-2 py-1 text-sm outline-none focus:border-ocean";

/** Column-oriented data ({col: [..]}) or rows ([{..}]) as rows. */
export function toRows(data: unknown): { cols: string[]; rows: P[] } {
  if (Array.isArray(data)) {
    const rows = data.map((r) => (r && typeof r === "object" ? (r as P) : { value: r }));
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return { cols, rows };
  }
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    const cols = Object.keys(o).filter((k) => Array.isArray(o[k]));
    const n = Math.max(0, ...cols.map((c) => (o[c] as unknown[]).length));
    return { cols, rows: Array.from({ length: n }, (_, i) => Object.fromEntries(cols.map((c) => [c, (o[c] as unknown[])[i]]))) };
  }
  return { cols: [], rows: [] };
}

export function WidgetBody({ w, p, rt, children }: { w: SlateWidget; p: P; rt: SlateRuntime; children?: React.ReactNode }) {
  const set = (patch: P, event?: string, value?: unknown) => rt.setWidget(w.id, patch, event ? { name: event, value } : undefined);
  const values = arr(p.values);
  const display = (i: number) => s(arr(p.displayValues)[i] ?? values[i]);
  switch (w.type) {
    case "text":
      return p.markdown ? (
        <div className="md-body h-full overflow-auto text-sm" onClick={() => rt.fire(`${w.id}.click`, null)} dangerouslySetInnerHTML={{ __html: renderMarkdown(s(p.content)) }} />
      ) : (
        <div className="h-full overflow-auto whitespace-pre-wrap text-sm" onClick={() => rt.fire(`${w.id}.click`, null)}>
          {s(p.content)}
        </div>
      );
    case "html":
      return <SandboxedHtml html={s(p.html)} css={rt.doc.styles.css} />;
    case "button":
      return (
        <button
          type="button"
          disabled={!!p.disabled}
          onClick={() => rt.fire(`${w.id}.click`, null)}
          className={`h-full w-full rounded-md px-3 text-sm font-medium disabled:opacity-50 ${
            p.intent === "danger" ? "bg-bad text-white" : p.intent === "minimal" ? "border border-line-2 hover:bg-panel-2" : "bg-ocean text-white hover:bg-ocean-deep"
          }`}
        >
          {s(p.text)}
        </button>
      );
    case "dropdown":
      return (
        <select
          value={p.selectedValue === null || p.selectedValue === undefined ? "" : JSON.stringify(p.selectedValue)}
          onChange={(e) => {
            const v = e.target.value === "" ? null : JSON.parse(e.target.value);
            const i = values.findIndex((x) => JSON.stringify(x) === e.target.value);
            set({ selectedValue: v, selectedDisplayValue: i >= 0 ? display(i) : null }, "changed", v);
          }}
          className={field}
        >
          <option value="">{s(p.placeholder) || "Choose…"}</option>
          {values.map((v, i) => (
            <option key={i} value={JSON.stringify(v)}>
              {display(i)}
            </option>
          ))}
        </select>
      );
    case "multiselect":
    case "checkbox": {
      const sel = arr(p.selectedValues);
      const toggle = (v: unknown) => {
        const next = sel.some((x) => JSON.stringify(x) === JSON.stringify(v)) ? sel.filter((x) => JSON.stringify(x) !== JSON.stringify(v)) : [...sel, v];
        set({ selectedValues: next }, "changed", next);
      };
      return (
        <div className="h-full space-y-1 overflow-auto text-sm">
          {values.map((v, i) => (
            <label key={i} className="flex items-center gap-2">
              <input type="checkbox" checked={sel.some((x) => JSON.stringify(x) === JSON.stringify(v))} onChange={() => toggle(v)} /> {display(i)}
            </label>
          ))}
        </div>
      );
    }
    case "radio":
      return (
        <div className="h-full space-y-1 overflow-auto text-sm">
          {values.map((v, i) => (
            <label key={i} className="flex items-center gap-2">
              <input type="radio" name={w.id} checked={JSON.stringify(p.selectedValue) === JSON.stringify(v)} onChange={() => set({ selectedValue: v }, "changed", v)} /> {display(i)}
            </label>
          ))}
        </div>
      );
    case "input":
      return (
        <input
          type={s(p.inputType) || "text"}
          value={s(p.text)}
          placeholder={s(p.placeholder)}
          onChange={(e) => set({ text: e.target.value }, "changed", e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && rt.fire(`${w.id}.submitted`, s(p.text))}
          className={field}
        />
      );
    case "textarea":
      return <textarea value={s(p.text)} placeholder={s(p.placeholder)} onChange={(e) => set({ text: e.target.value }, "changed", e.target.value)} className={`${field} h-full resize-none`} />;
    case "toggle":
      return (
        <label className="flex h-full items-center gap-2 text-sm">
          <input type="checkbox" checked={!!p.value} onChange={(e) => set({ value: e.target.checked }, "changed", e.target.checked)} /> {s(p.label)}
        </label>
      );
    case "slider":
      return (
        <div className="flex h-full items-center gap-2 text-sm">
          <input type="range" min={Number(p.min ?? 0)} max={Number(p.max ?? 100)} step={Number(p.step ?? 1)} value={Number(p.value ?? 0)} onChange={(e) => set({ value: Number(e.target.value) }, "changed", Number(e.target.value))} className="flex-1" />
          <span className="w-12 text-right tabular-nums">{s(p.value)}</span>
        </div>
      );
    case "datepicker":
      return <input type="date" value={s(p.selectedDate).slice(0, 10)} onChange={(e) => set({ selectedDate: e.target.value }, "changed", e.target.value)} className={field} />;
    case "table":
      return <TableWidget w={w} p={p} set={set} />;
    case "chart": {
      const xs = arr(p.xValues);
      const ys = arr(p.yValues);
      const data = xs.map((x, i) => ({ key: x, value: ys[i] === null || ys[i] === undefined ? null : Number(ys[i]), count: 1 }));
      const C = p.renderer === "line" ? LineChart : BarChart;
      return <C data={data} metricLabel={s(p.seriesName) || "value"} onSelect={(k) => set({ selectedX: k }, "selected", k)} />;
    }
    case "pie": {
      const ls = arr(p.labels);
      const vs = arr(p.values);
      return <PieChart data={ls.map((l, i) => ({ key: l, value: Number(vs[i] ?? 0), count: 1 }))} metricLabel="value" onSelect={(k) => set({ selectedLabel: k }, "selected", k)} />;
    }
    case "container":
      return <div className={`flex h-full gap-2 ${p.flow === "row" ? "flex-row" : "flex-col"}`}>{children}</div>;
    case "tabs": {
      const tabs = arr(p.tabs).map(s);
      const sel = Number(p.selectedTab ?? 0);
      const kids = Array.isArray(children) ? children : children ? [children] : [];
      return (
        <div className="flex h-full flex-col">
          <div className="flex gap-1 border-b border-line text-xs">
            {tabs.map((t, i) => (
              <button key={i} type="button" onClick={() => set({ selectedTab: i }, "changed", i)} className={`px-3 py-1.5 ${i === sel ? "border-b-2 border-ocean text-white" : "text-muted"}`}>
                {t}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 pt-2">{kids[sel] ?? null}</div>
        </div>
      );
    }
    case "card":
      return (
        <div className="flex h-full cursor-pointer flex-col justify-center rounded-lg border border-line bg-panel-2 px-4" onClick={() => rt.fire(`${w.id}.click`, null)}>
          <div className="text-xs text-muted">{s(p.title)}</div>
          <div className="mt-1 truncate text-2xl font-semibold tabular-nums">{s(p.value)}</div>
          {s(p.subtitle) && <div className="text-[11px] text-muted">{s(p.subtitle)}</div>}
        </div>
      );
    case "list": {
      const items = arr(p.items);
      return (
        <ul className="h-full overflow-auto text-sm">
          {items.map((it, i) => (
            <li key={i}>
              <button type="button" onClick={() => set({ selectedIndex: i, selectedItem: it }, "selected", it)} className={`block w-full rounded px-2 py-1 text-left ${p.selectedIndex === i ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}>
                {s(it)}
              </button>
            </li>
          ))}
        </ul>
      );
    }
    case "timeline": {
      const ls = arr(p.labels);
      const ds = arr(p.dates);
      const pts = ds.map((d, i) => ({ t: new Date(s(d)).getTime(), label: s(ls[i]), i })).filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
      const lo = pts[0]?.t ?? 0;
      const hi = pts[pts.length - 1]?.t ?? 1;
      return (
        <div className="relative h-full">
          <div className="absolute left-2 right-2 top-1/2 h-px bg-line-2" />
          {pts.map((x) => (
            <button
              key={x.i}
              type="button"
              title={`${x.label} · ${new Date(x.t).toISOString().slice(0, 10)}`}
              onClick={() => set({ selectedIndex: x.i }, "selected", x.i)}
              style={{ left: `calc(${hi === lo ? 50 : ((x.t - lo) / (hi - lo)) * 100}% * 0.96 + 2%)` }}
              className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${p.selectedIndex === x.i ? "bg-warn" : "bg-ocean"}`}
            />
          ))}
        </div>
      );
    }
    case "image":
      // eslint-disable-next-line @next/next/no-img-element
      return s(p.src) ? <img src={s(p.src)} alt={s(p.alt)} onClick={() => rt.fire(`${w.id}.click`, null)} className="h-full w-full" style={{ objectFit: (s(p.fit) || "contain") as "contain" }} /> : <Empty text="Set the image source" />;
    case "iframe":
      return /^https?:\/\//.test(s(p.src)) || s(p.src).startsWith("/") ? <iframe src={s(p.src)} className="h-full w-full rounded border border-line" sandbox="allow-scripts allow-same-origin allow-forms" /> : <Empty text="Set an http(s) source" />;
    case "codesandbox":
      return <CodeSandbox w={w} p={p} rt={rt} />;
    case "fileimport":
      return <FileImport p={p} set={set} />;
    case "action":
      return <ActionWidget w={w} p={p} rt={rt} />;
    case "objectcard":
      return <ObjectCard typeId={s(p.objectTypeId)} pk={s(p.primaryKey)} onClick={() => rt.fire(`${w.id}.click`, null)} />;
    case "toast":
    case "dialog":
      return null;
    default:
      return MoreWidgetBody({ w, p, rt, set }) ?? <Empty text={`Unknown widget ${w.type}`} />;
  }
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center rounded border border-dashed border-line-2 text-xs text-muted">{text}</div>;
}

function TableWidget({ w, p, set }: { w: SlateWidget; p: P; set: (patch: P, event?: string, value?: unknown) => void }) {
  const { cols: all, rows } = useMemo(() => toRows(p.data), [p.data]);
  const cols = arr(p.columns).length ? arr(p.columns).map(s).filter((c) => all.includes(c)) : all;
  const [sort, setSort] = useState<{ c: string; d: boolean } | null>(null);
  const [page, setPage] = useState(0);
  const size = Number(p.pageSize ?? 50) || 50;
  const sorted = useMemo(() => {
    const idx = rows.map((r, i) => ({ r, i }));
    if (!sort) return idx;
    return [...idx].sort((a, b) => {
      const x = a.r[sort.c];
      const y = b.r[sort.c];
      const c = typeof x === "number" && typeof y === "number" ? x - y : s(x).localeCompare(s(y));
      return sort.d ? -c : c;
    });
  }, [rows, sort]);
  const sel = arr(p.selectedRowKeys).map(Number);
  const pick = (i: number) => {
    const multi = p.selectionMode === "multiple";
    const next = multi ? (sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i]) : sel.includes(i) ? [] : [i];
    const selectedRows = Object.fromEntries(all.map((c) => [c, next.map((k) => rows[k]?.[c])]));
    set({ selectedRowKeys: next, selectedRows, selectedIndex: next[0] ?? null }, "selectionChanged", selectedRows);
  };
  return (
    <div className="flex h-full flex-col text-xs">
      <div className="min-h-0 flex-1 overflow-auto rounded border border-line">
        <table className="w-full">
          <thead className="sticky top-0 bg-panel-2 text-left text-muted">
            <tr>
              {cols.map((c) => (
                <th key={c} className="cursor-pointer px-2 py-1 font-normal" onClick={() => setSort(sort?.c === c ? { c, d: !sort.d } : { c, d: false })}>
                  {c} {sort?.c === c ? (sort.d ? "↓" : "↑") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(page * size, page * size + size).map(({ r, i }) => (
              <tr key={i} onClick={() => p.selectionMode !== "none" && pick(i)} className={`border-t border-line ${sel.includes(i) ? "bg-ocean/15 text-white" : "hover:bg-panel-2"} ${p.selectionMode === "none" ? "" : "cursor-pointer"}`}>
                {cols.map((c) => (
                  <td key={c} className="max-w-64 truncate px-2 py-1">
                    {s(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="p-3 text-muted">No rows</div>}
      </div>
      {rows.length > size && (
        <div className="flex items-center justify-end gap-2 pt-1 text-muted">
          <button type="button" disabled={!page} onClick={() => setPage(page - 1)} className="disabled:opacity-40">
            ‹
          </button>
          {page + 1} / {Math.ceil(rows.length / size)}
          <button type="button" disabled={(page + 1) * size >= rows.length} onClick={() => setPage(page + 1)} className="disabled:opacity-40">
            ›
          </button>
          <span data-widget={w.id}>{rows.length} rows</span>
        </div>
      )}
    </div>
  );
}

/** HTML from the builder, isolated in a sandboxed iframe (no scripts, no access to the app). */
function SandboxedHtml({ html, css }: { html: string; css: string }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:13px system-ui;color:#d7e0ea;background:transparent}${css}</style></head><body>${html}</body></html>`;
  return <iframe sandbox="" srcDoc={doc} className="h-full w-full border-0" title="HTML" />;
}

/** Code Sandbox: the builder's HTML / CSS / JS in a sandboxed iframe; `slate.state` in, `slate.setState` and
 *  `slate.trigger` out (postMessage). */
function CodeSandbox({ w, p, rt }: { w: SlateWidget; p: P; rt: SlateRuntime }) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const token = useId();
  const stateJson = JSON.stringify(p.state ?? {});
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || e.data?.token !== token) return;
      if (e.data.kind === "setState") rt.setWidget(w.id, { state: { ...((p.state as P) ?? {}), ...(e.data.state ?? {}) } });
      if (e.data.kind === "trigger") rt.fire(`${w.id}.triggered`, e.data.value);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [rt, w.id, token, p.state]);
  useEffect(() => {
    ref.current?.contentWindow?.postMessage({ token, kind: "state", state: JSON.parse(stateJson) }, "*");
  }, [stateJson, token]);
  const src = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:13px system-ui;color:#d7e0ea}${s(p.css)}</style></head><body>${s(p.html)}<script>
const TOKEN=${JSON.stringify(token)};const slate={state:${stateJson},listeners:[],setState(x){parent.postMessage({token:TOKEN,kind:"setState",state:x},"*")},trigger(v){parent.postMessage({token:TOKEN,kind:"trigger",value:v},"*")},onStateChange(f){this.listeners.push(f)}};
addEventListener("message",e=>{if(e.data&&e.data.token===TOKEN&&e.data.kind==="state"){slate.state=e.data.state;slate.listeners.forEach(f=>f(slate.state))}});
try{${s(p.js).replace(/<\/script/gi, "<\\/script")}}catch(e){document.body.insertAdjacentHTML("beforeend","<pre style='color:#f87171'>"+e+"</pre>")}
</script></body></html>`;
  // the document only changes with the code: state goes in by postMessage
  const code = useMemo(() => src, [p.html, p.css, p.js, token]); // eslint-disable-line react-hooks/exhaustive-deps
  return <iframe ref={ref} sandbox="allow-scripts" srcDoc={code} className="h-full w-full rounded border border-line" title={w.id} />;
}

function parseCsv(text: string): Record<string, string[]> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [head = [], ...body] = rows.filter((r) => r.some((x) => x !== ""));
  return Object.fromEntries(head.map((h, j) => [h, body.map((r) => r[j] ?? "")]));
}

function FileImport({ p, set }: { p: P; set: (patch: P, event?: string, value?: unknown) => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="flex h-full flex-col items-start justify-center gap-1 text-xs">
      <input
        ref={ref}
        type="file"
        accept={s(p.accept)}
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setErr(null);
          try {
            if (f.size > 2_000_000) throw new Error("files up to 2 MB");
            const text = await f.text();
            const data = f.name.toLowerCase().endsWith(".json") || p.parse === "json" ? JSON.parse(text) : parseCsv(text);
            set({ data, fileName: f.name }, "imported", data);
          } catch (ex) {
            setErr((ex as Error).message);
          }
          e.target.value = "";
        }}
      />
      <button type="button" onClick={() => ref.current?.click()} className="inline-flex items-center gap-1.5 rounded-md border border-line-2 px-3 py-1.5 hover:border-ocean">
        <Icon name="upload" className="h-3.5 w-3.5" /> Import file
      </button>
      <span className="text-muted">{s(p.fileName) || "No file"}</span>
      {err && <span className="text-bad">{err}</span>}
    </div>
  );
}

function ActionWidget({ w, p, rt }: { w: SlateWidget; p: P; rt: SlateRuntime }) {
  const [action, setAction] = useState<ActionType | null>(null);
  const [type, setType] = useState<ObjectType | null>(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const id = s(p.actionTypeId);
  useEffect(() => {
    if (!id) return;
    ontology.actionType(id).then(
      (a) => {
        setAction(a);
        if (a.object_type_id) ontology.objectType(a.object_type_id).then(setType, () => {});
      },
      (e: Error) => setMsg(e.message),
    );
  }, [id]);
  // a submit action from an event applies the action with the configured parameters (no form)
  const submitAt = p.submitRequest as number | undefined;
  const params = JSON.stringify(p.parameters ?? {});
  useEffect(() => {
    if (!submitAt || !id) return;
    ontology.applyAction(id, JSON.parse(params)).then(
      (r) => {
        setMsg("Applied");
        rt.setWidget(w.id, { lastResult: r, submitRequest: undefined }, { name: "succeeded", value: r });
      },
      (e: Error) => {
        setMsg(e.message);
        rt.setWidget(w.id, { submitRequest: undefined }, { name: "failed", value: e.message });
      },
    );
  }, [submitAt]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!id) return <Empty text="Choose an action type" />;
  if (!action) return <Empty text={msg ?? "Loading the action…"} />;
  return (
    <div className="flex h-full flex-col justify-center gap-1 text-sm">
      {p.showForm !== false ? (
        <button type="button" onClick={() => setOpen(true)} className="self-start rounded-md bg-ocean px-3 py-1.5 font-medium text-white hover:bg-ocean-deep">
          {action.display_name}
        </button>
      ) : (
        <span className="text-xs text-muted">{action.display_name}: submitted by an event</span>
      )}
      {msg && <span className={`text-xs ${msg === "Applied" ? "text-ok" : "text-bad"}`}>{msg}</span>}
      {open && type && (
        <ActionForm
          action={action}
          objectType={type}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            setMsg("Applied");
            rt.fire(`${w.id}.succeeded`, null);
          }}
        />
      )}
    </div>
  );
}

function ObjectCard({ typeId, pk, onClick }: { typeId: string; pk: string; onClick: () => void }) {
  const [o, setO] = useState<OntologyObject | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!typeId || !pk) return;
    let stale = false;
    ontology.object(typeId, pk).then(
      (x) => !stale && setO(x),
      (e: Error) => !stale && setErr(e.message),
    );
    return () => {
      stale = true;
    };
  }, [typeId, pk]);
  if (!typeId || !pk) return <Empty text="Set the object type and primary key" />;
  if (err) return <Empty text={err} />;
  if (!o) return <Empty text="Loading…" />;
  return (
    <div onClick={onClick} className="h-full cursor-pointer overflow-auto rounded-lg border border-line bg-panel-2 p-3 text-xs">
      <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        <Icon name="cube" className="h-3.5 w-3.5 text-ocean" /> {o.title}
      </div>
      {Object.entries(o.properties)
        .slice(0, 12)
        .map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <span className="w-28 shrink-0 truncate text-muted">{k}</span>
            <span className="truncate">{s(v)}</span>
          </div>
        ))}
    </div>
  );
}
