"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { ActionForm } from "@/components/ontology/ActionForm";
import { Field } from "@/components/ontology/parts";
import { fieldClass, inputClass } from "@/components/pipeline/Modal";
import { actions } from "@/lib/actions";
import { agentsApi, type Agent, type AgentStep, type ChatMessage } from "@/lib/agents";
import { API_URL } from "@/lib/api";
import { renderMarkdown } from "@/lib/markdown";
import { ontology, type ActionType, type LogicFunction, type ObjectType, type OntologyObject } from "@/lib/ontology";
import { scenarios } from "@/lib/scenarios";
import { fillVars, sourceKey, type Column, type Module, type Sources, type Widget, type WidgetConfig } from "@/lib/workshop";
import { InlineActionTable } from "./InlineActionTable";
import { valueOf } from "./ModuleRuntime";
import type { ModuleState } from "./WidgetView";
import { EventsEditor } from "./WorkshopConfig";

async function call<T>(path: string, init?: { method?: string; json?: unknown; form?: FormData }): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init?.method ?? "GET",
    credentials: "include",
    headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.form ?? (init?.json !== undefined ? JSON.stringify(init.json) : undefined),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : res.statusText);
  return body as T;
}
/** A POST answered with server-sent events: each event to `on` as it arrives; resolves after the "result" event. */
export async function sse(path: string, body: unknown, on: (event: string, data: unknown) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${API_URL}${path}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const b = await res.json().catch(() => ({}));
    throw new Error(typeof b.detail === "string" ? b.detail : `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (\w+)/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!ev || data === undefined) continue;
      on(ev, JSON.parse(data));
      if (ev === "result") return;
    }
  }
  throw new Error("the stream ended without a result");
}

/** Whether a value fits a Workshop variable type (as api/agents.py check_variable_value): what an agent may set. */
export function fitsVariable(type: string | undefined, v: unknown): boolean {
  if (v === null) return !!type && WRITABLE.has(type);
  const key = (x: unknown) => typeof x === "string" || (typeof x === "number" && Number.isInteger(x));
  switch (type) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
    case "timestamp":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));
    case "object":
      return key(v);
    case "object_set":
      return Array.isArray(v) && v.every(key);
    case "array":
      return Array.isArray(v) && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x));
    case "struct":
      return typeof v === "object" && !Array.isArray(v);
    case "struct_array":
      return Array.isArray(v) && v.every((x) => x !== null && typeof x === "object" && !Array.isArray(x));
    default:
      return false;
  }
}
const WRITABLE = new Set(["string", "number", "boolean", "date", "timestamp", "object", "object_set", "array", "struct", "struct_array"]);

const Msg = ({ children }: { children: React.ReactNode }) => <div className="flex h-full items-center justify-center p-3 text-center text-xs text-muted">{children}</div>;
const ago = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The object a widget works on: object_pk ($var:, {{…}}) or the selected object of its object type source. */
function targetOf(widget: Widget, state: ModuleState): { typeId?: string; pk?: string } {
  const c = widget.config;
  const typeId = c.source?.kind === "object_type" ? c.source.id : undefined;
  const fromVar = c.object_pk ? valueOf(c.object_pk, state.variables) : undefined;
  const pk = fromVar !== undefined && fromVar !== null && fromVar !== "" ? String(fromVar) : typeId ? state.selection[sourceKey(c.source)] : undefined;
  return { typeId, pk };
}

// ------------------------------------------------------------------------------------------------
// Comments
// ------------------------------------------------------------------------------------------------

type Comment = { id: string; at: string; user: string; text: string; attachments: string[]; mentions: { username: string; user_id: string | null }[] };
type LogEntry = { action_type: string; rid: string; at: string; user: string; reverted: boolean };
const REF = /\[\[ref:([\w-]+):([^\]|]+)\|([^\]]*)\]\]/g;

/** The names of the people on an object's comment feed, by user id (the server resolves only the ids on the object). */
type People = Record<string, { username: string; display_name: string | null }>;
const personName = (people: People, id: string) => people[id]?.display_name || people[id]?.username || id;

function CommentText({ text, onRef, names }: { text: string; onRef: (typeId: string, pk: string) => void; names?: Record<string, string> }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(REF)) {
    parts.push(text.slice(last, m.index));
    const [, tid, pk, title] = m;
    parts.push(
      <button key={m.index} type="button" onClick={(e) => (e.stopPropagation(), onRef(tid, pk))} className="mx-0.5 rounded bg-ocean/15 px-1 text-ocean hover:bg-ocean/25" data-comment-ref={pk}>
        {title || pk}
      </button>,
    );
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(text.slice(last));
  return (
    <div className="whitespace-pre-wrap break-words">
      {parts.map((p, i) =>
        typeof p === "string"
          ? p.split(/(@[A-Za-z0-9_.-]+)/).map((x, j) =>
              // a mention shows the user's display name (the @username on hover) when it is a known user
              x.startsWith("@") ? (
                <b key={`${i}-${j}`} className="text-ocean" title={names?.[x.slice(1)] ? x : undefined} data-comment-mention={x.slice(1)}>
                  {names?.[x.slice(1)] ? `@${names[x.slice(1)]}` : x}
                </b>
              ) : (
                x
              ),
            )
          : p,
      )}
    </div>
  );
}

export function CommentsWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const { typeId, pk } = targetOf(widget, state);
  const [items, setItems] = useState<Comment[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [people, setPeople] = useState<People>({});
  const mentionNames = useMemo(() => Object.fromEntries(Object.values(people).filter((p) => p.display_name).map((p) => [p.username, p.display_name!])), [people]);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refQ, setRefQ] = useState<string | null>(null);
  const [refs, setRefs] = useState<OntologyObject[]>([]);
  const [nonce, setNonce] = useState(0);
  const base = typeId && pk ? `/api/ontology/object-types/${typeId}/objects/${encodeURIComponent(pk)}/comments` : null;
  useEffect(() => {
    if (!base || !typeId || !pk) return;
    let stale = false;
    call<Comment[]>(base).then((x) => !stale && (setItems(x), setError(null)), (e: Error) => !stale && setError(e.message));
    if (c.show_action_log) call<LogEntry[]>(`/api/ontology/actions/log-for/${typeId}/${encodeURIComponent(pk)}`).then((x) => !stale && setLog(x), () => !stale && setLog([]));
    // names for the user ids of the feed (authors, mentions, the action log); ids stay shown when this fails
    call<People>(`/api/workshop/comments/${typeId}/${encodeURIComponent(pk)}/people${c.show_action_log ? "?log=true" : ""}`).then(
      (x) => !stale && setPeople(x),
      () => !stale && setPeople({}),
    );
    return () => {
      stale = true;
    };
  }, [base, typeId, pk, c.show_action_log, nonce, state.version]);
  useEffect(() => {
    if (refQ === null || !c.ref_object_type_id) return;
    const t = setTimeout(() => ontology.objects(c.ref_object_type_id!, refQ).then((r) => setRefs(r.objects.slice(0, 8)), () => setRefs([])), 200);
    return () => clearTimeout(t);
  }, [refQ, c.ref_object_type_id]);
  if (c.source?.kind !== "object_type" && !c.object_pk) return <Msg>Choose the object type (source) whose objects are commented on</Msg>;
  if (!pk) return <Msg>Select an object to see its comments</Msg>;
  const feed = [...items.map((x) => ({ kind: "comment" as const, at: x.at, c: x })), ...log.map((x) => ({ kind: "log" as const, at: x.at, l: x }))].sort((a, b) => a.at.localeCompare(b.at));
  const onRef = (tid: string, rpk: string) => {
    state.select(sourceKey({ kind: "object_type", id: tid }), rpk);
    if (c.ref_events?.length) void state.runEvents?.(c.ref_events);
  };
  const post = async () => {
    if (!base || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const attachments: string[] = [];
      for (const f of files) {
        const fd = new FormData();
        fd.append("file", f);
        attachments.push((await call<{ id: string }>("/api/drive/files", { method: "POST", form: fd })).id);
      }
      // the Workshop route posts the comment and notifies the thread (Send default notifications)
      const posted = await call<Comment & { users_to_notify: string[]; notified: string[] }>(`/api/workshop/comments/${typeId}/${encodeURIComponent(pk)}`, {
        method: "POST",
        json: { text: text.trim(), attachments, notify: !c.comment_no_notify, module_id: state.moduleId },
      });
      setText("");
      setFiles([]);
      setNonce((n) => n + 1);
      // the action after commenting, with the comment's special values
      if (c.comment_action?.action_type_id) {
        const special: Record<string, unknown> = { "$comment:text": posted.text, "$comment:users": posted.users_to_notify, "$comment:object": pk, "$comment:author": posted.user };
        const params = Object.fromEntries(
          Object.entries(c.comment_action.parameters ?? {})
            .map(([k, v]) => [k, typeof v === "string" && v in special ? special[v] : valueOf(v, state.variables)])
            .filter(([, v]) => v !== undefined && v !== ""),
        );
        try {
          await actions.apply(c.comment_action.action_type_id, params);
          setActErr(null);
          state.bump();
        } catch (e) {
          setActErr(`The comment was posted; the action after commenting failed: ${(e as Error).message}`);
        }
      }
      if (c.comment_events?.length) void state.runEvents?.(c.comment_events);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full flex-col text-xs" data-comments={pk}>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {!feed.length && <p className="text-muted">No comments yet.</p>}
        {feed.map((f) =>
          f.kind === "log" ? (
            <div key={f.l.rid} className="flex items-center gap-2 text-[11px] text-muted" data-feed-log>
              <Icon name="bolt" className="h-3 w-3" />
              <span>
                <b className="text-soft" title={people[f.l.user] ? `@${people[f.l.user].username}` : undefined} data-feed-user={f.l.user}>
                  {personName(people, f.l.user)}
                </b>{" "}
                applied {f.l.action_type}
                {f.l.reverted ? " (reverted)" : ""} · {ago(f.l.at)}
              </span>
            </div>
          ) : (
            <div key={f.c.id} className="group rounded-md border border-line p-2" data-comment={f.c.id}>
              <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
                <b className="text-soft" title={people[f.c.user] ? `@${people[f.c.user].username}` : undefined} data-comment-author={f.c.user}>
                  {personName(people, f.c.user)}
                </b>{" "}
                {ago(f.c.at)}
                <button
                  type="button"
                  onClick={() => base && call(`${base}/${f.c.id}`, { method: "DELETE" }).then(() => setNonce((n) => n + 1), (e: Error) => setError(e.message))}
                  className="ml-auto hidden text-muted hover:text-bad group-hover:block"
                  title="Delete (your own comments)"
                >
                  <Icon name="trash" className="h-3 w-3" />
                </button>
              </div>
              <CommentText text={f.c.text} onRef={onRef} names={mentionNames} />
              {f.c.attachments.map((a, i) => (
                <a key={a} href={`${API_URL}/api/drive/items/${a}/content`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-ocean hover:underline">
                  <Icon name="doc" className="h-3 w-3" /> Attachment {i + 1}
                </a>
              ))}
            </div>
          ),
        )}
      </div>
      {error && <p className="mx-3 mb-1 text-bad">{error}</p>}
      {actErr && (
        <p className="mx-3 mb-1 text-bad" data-comment-action-error>
          {actErr}
        </p>
      )}
      <div className="relative shrink-0 border-t border-line p-2">
        {refQ !== null && (
          <div className="absolute bottom-full left-2 right-2 mb-1 rounded-lg border border-line-2 bg-panel p-1 shadow-xl">
            <input autoFocus value={refQ} onChange={(e) => setRefQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setRefQ(null)} placeholder="Search objects to reference…" className={`${fieldClass} mb-1 w-full text-xs`} />
            {refs.map((o) => (
              <button
                key={o.primary_key}
                type="button"
                onClick={() => {
                  setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}[[ref:${o.object_type_id}:${o.primary_key}|${o.title}]] `);
                  setRefQ(null);
                }}
                className="block w-full truncate rounded px-2 py-1 text-left hover:bg-panel-2"
              >
                {o.title}
              </button>
            ))}
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === "Enter" && void post()}
          disabled={editing || !!state.readOnly}
          rows={2}
          placeholder={`Comment… @username mentions notify${c.comment_no_notify ? "" : ", and everyone in the thread"}; Ctrl+Enter sends`}
          className={`${inputClass} text-xs`}
          data-comment-input
        />
        <div className="mt-1 flex items-center gap-2">
          {c.ref_object_type_id && (
            <button type="button" onClick={() => setRefQ(refQ === null ? "" : null)} className="text-ocean" title="Reference an object">
              # Reference
            </button>
          )}
          <label className="cursor-pointer text-ocean">
            <Icon name="upload" className="inline h-3 w-3" /> Attach
            <input type="file" multiple className="hidden" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
          </label>
          {files.length > 0 && <span className="text-muted">{files.length} file(s)</span>}
          <button type="button" onClick={post} disabled={busy || editing || !!state.readOnly || !text.trim()} className="ml-auto rounded bg-ocean px-2.5 py-1 text-white disabled:opacity-40" data-comment-send>
            {busy ? "Sending…" : "Comment"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Inline Action
// ------------------------------------------------------------------------------------------------

export function InlineActionWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const ids = useMemo(() => (c.action_ids?.length ? c.action_ids : c.action_type_id ? [c.action_type_id] : []), [c.action_ids, c.action_type_id]);
  const [pick, setPick] = useState(0);
  const [loaded, setLoaded] = useState<{ action: ActionType; type: ObjectType } | null>(null);
  const [obj, setObj] = useState<OntologyObject | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const id = ids[Math.min(pick, ids.length - 1)];
  // every tab shows its action's name (not only the open one)
  const [names, setNames] = useState<Record<string, string>>({});
  const idsKey = ids.join(",");
  useEffect(() => {
    if (!idsKey) return;
    let stale = false;
    Promise.all(idsKey.split(",").map((x) => ontology.actionType(x).then((a) => [x, a.display_name] as const, () => [x, ""] as const))).then(
      (r) => !stale && setNames(Object.fromEntries(r.filter(([, n]) => n))),
    );
    return () => {
      stale = true;
    };
  }, [idsKey]);
  useEffect(() => {
    if (!id) return;
    let stale = false;
    ontology
      .actionType(id)
      .then(async (a) => {
        const t = await ontology.objectType(a.object_type_id);
        if (!stale) setLoaded({ action: a, type: t });
      })
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [id]);
  // the selected object of the action's type fills its object parameter (modify / delete)
  const selPk = loaded ? state.selection[sourceKey({ kind: "object_type", id: loaded.action.object_type_id })] : undefined;
  useEffect(() => {
    if (!loaded || !selPk) return;
    let stale = false;
    ontology.object(loaded.action.object_type_id, selPk).then((o) => !stale && setObj(o), () => !stale && setObj(undefined));
    return () => {
      stale = true;
    };
  }, [loaded, selPk]);
  const defaults = useMemo(() => Object.fromEntries(Object.entries(c.action_defaults ?? {}).map(([k, v]) => [k, valueOf(v, state.variables)])), [c.action_defaults, state.variables]);
  const scenarioId = c.apply_to_scenario ? String(state.variables[c.apply_to_scenario] ?? "") || undefined : undefined;
  const [layoutPick, setLayoutPick] = useState<"form" | "table" | null>(null);
  const layout = (c.allow_layout_switch && layoutPick) || c.action_layout || "form";
  // pre-fill (table): the object set variable's objects, one row each in the object parameter
  const prefillRaw = c.prefill_variable ? state.variables[c.prefill_variable] : undefined;
  const prefillKeys = useMemo(
    () => (prefillRaw === undefined || prefillRaw === null ? [] : (Array.isArray(prefillRaw) ? prefillRaw : String(prefillRaw).split(",")).map((x) => String(x).trim()).filter(Boolean)),
    [prefillRaw],
  );
  // Inline Action form state if invalid: hidden — the action's submission criteria on the widget's starting values
  const objParam = loaded ? (loaded.action.parameters as unknown as { id: string; type: string; object_type_id?: string | null }[]).find((p) => p.type === "object" && (p.object_type_id || loaded.action.object_type_id) === loaded.action.object_type_id) : undefined;
  const startKey = JSON.stringify({ id, obj: loaded && loaded.action.kind !== "create" && objParam && selPk ? { [objParam.id]: selPk } : {}, defaults, scenarioId, v: state.version });
  const [validity, setValidity] = useState<{ key: string; passed: boolean } | null>(null);
  useEffect(() => {
    if (c.invalid_state !== "hidden" || !loaded || loaded.action.id !== id) return;
    let stale = false;
    const { obj: start } = JSON.parse(startKey) as { obj: Record<string, unknown> };
    const values = { ...start, ...Object.fromEntries(Object.entries(defaults).filter(([, v]) => v !== undefined && v !== null && v !== "")) };
    (scenarioId ? scenarios.form(scenarioId, id, values, Object.keys(values)) : actions.form(id, values, Object.keys(values))).then(
      (f) => !stale && setValidity({ key: startKey, passed: f.criteria.passed }),
      () => !stale && setValidity({ key: startKey, passed: true }),
    );
    return () => {
      stale = true;
    };
  }, [c.invalid_state, loaded, id, startKey, defaults, scenarioId]);
  if (!ids.length) return <Msg>Choose the action type(s) in the panel</Msg>;
  if (state.readOnly) return <Msg>Actions are off in kiosk mode (read-only)</Msg>;
  if (error) return <Msg>{error}</Msg>;
  if (!loaded || loaded.action.id !== id) return <Msg>Loading the action…</Msg>;
  if (c.invalid_state === "hidden" && !editing && (validity?.key !== startKey || !validity.passed))
    return <div className="h-full" data-inline={widget.id} data-inline-hidden={validity?.key === startKey ? "invalid" : "checking"} />;
  const needsObject = loaded.action.kind !== "create" && !(selPk && obj?.primary_key === selPk);
  const prefillParam = c.prefill_param || objParam?.id;
  return (
    <div className="flex h-full flex-col" data-inline={widget.id} data-inline-layout={layout}>
      {(ids.length > 1 || c.allow_layout_switch) && (
        <div className="flex shrink-0 gap-1 border-b border-line px-2 py-1">
          {ids.length > 1 &&
            ids.map((x, i) => (
              <button key={x} type="button" onClick={() => setPick(i)} className={`rounded px-2 py-0.5 text-xs ${i === pick ? "bg-ocean/15 text-ocean" : "text-muted hover:text-white"}`}>
                {i === pick ? loaded.action.display_name : names[x] ?? `Action ${i + 1}`}
              </button>
            ))}
          {c.allow_layout_switch && (
            <span className="ml-auto flex gap-0.5">
              {(["form", "table"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLayoutPick(l)}
                  className={`rounded px-1.5 py-0.5 ${layout === l ? "bg-ocean/15 text-ocean" : "text-muted hover:text-white"}`}
                  title={l === "form" ? "Form: one action at a time" : "Table: many rows applied together"}
                  data-layout-switch={l}
                >
                  <Icon name={l === "form" ? "list" : "table"} className="h-3.5 w-3.5" />
                </button>
              ))}
            </span>
          )}
        </div>
      )}
      <div className={`min-h-0 flex-1 ${editing ? "pointer-events-none opacity-70" : ""}`}>
        {layout === "table" ? (
          <InlineActionTable
            key={`${id}:${round}`}
            action={loaded.action}
            defaults={defaults}
            scenarioId={scenarioId}
            prefill={c.prefill_variable && prefillParam ? { param: prefillParam, keys: prefillKeys } : undefined}
            allowRows={c.allow_row_changes !== false}
            allowCsv={c.allow_csv_upload !== false}
            hideHeader={c.hide_header}
            title={c.action_title ? fillVars(c.action_title, state.variables) : undefined}
            onApplied={() => {
              state.bump();
              if (c.on_submit?.length) void state.runEvents?.(c.on_submit);
            }}
          />
        ) : needsObject && loaded.action.kind !== "create" && !selPk ? (
          <Msg>Select a {loaded.type.display_name} to {loaded.action.display_name.toLowerCase()}</Msg>
        ) : selPk && obj?.primary_key !== selPk && loaded.action.kind !== "create" ? (
          // the selected object is still loading: the form fills its object parameter when it mounts
          <Msg>Loading the {loaded.type.display_name}…</Msg>
        ) : (
          <ActionForm
            key={`${id}:${selPk ?? ""}:${obj?.primary_key ?? ""}:${round}:${JSON.stringify(defaults)}`}
            action={loaded.action}
            objectType={loaded.type}
            object={selPk && obj?.primary_key === selPk ? obj : undefined}
            inline
            defaults={defaults}
            title={c.action_title ? fillVars(c.action_title, state.variables) : undefined}
            hideHeader={c.hide_header}
            scenarioId={c.apply_to_scenario ? String(state.variables[c.apply_to_scenario] ?? "") || undefined : undefined}
            onClose={() => setRound((r) => r + 1)}
            onDone={() => {
              setRound((r) => r + 1);
              state.bump();
              if (c.on_submit?.length) void state.runEvents?.(c.on_submit);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// AIP Chatbot
// ------------------------------------------------------------------------------------------------

export function AipChatbotWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const [agent, setAgent] = useState<Agent | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<ChatMessage | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!c.agent_id) return;
    agentsApi.get(c.agent_id).then(setAgent, (e: Error) => setError(e.message));
  }, [c.agent_id]);
  useEffect(() => {
    // braces: scrollIntoView returns a promise in newer browsers, and an effect must not return one
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, busy, streaming]);
  // application state: each variable's value, description and type; read-and-write ones the agent may set
  const shared = (c.app_state ?? []).filter((x) => x.variable);
  const appState = () =>
    Object.fromEntries(
      shared.map((x) => {
        const type = state.variableTypes?.[x.variable];
        return [x.variable, { value: state.variables[x.variable] ?? null, description: x.description ?? "", ...(type ? { type } : {}), ...(x.access === "read_write" ? { writable: true } : {}) }];
      }),
    );
  // a value the agent set: only into a variable marked read and write, and only a value of the variable's type
  const write = (name: string, value: unknown): string | null => {
    const entry = shared.find((x) => x.variable === name);
    if (!entry || entry.access !== "read_write") return `${name} is not writable`;
    if (!fitsVariable(state.variableTypes?.[name], value)) return `${name}: the value does not fit a ${state.variableTypes?.[name] ?? "unknown"} variable`;
    state.setVariable(name, value);
    return null;
  };
  const send = async (content: string) => {
    if (!c.agent_id || !content.trim() || busy) return;
    setBusy(true);
    setError(null);
    setMessages((m) => [...m, { role: "user", content, at: new Date().toISOString() }]);
    setText("");
    try {
      const sid = session ?? (await agentsApi.newSession(c.agent_id)).id;
      setSession(sid);
      // streamed: the answer appears as it is written, tool calls as they happen
      const live: ChatMessage & { variables?: Record<string, unknown> } = { role: "assistant", content: "", at: new Date().toISOString(), steps: [] };
      const show = () => setStreaming({ ...live, steps: [...(live.steps ?? [])] });
      show();
      let reply: (ChatMessage & { variables?: Record<string, unknown> }) | null = null;
      const refused: string[] = [];
      await sse(`/api/agents/${c.agent_id}/sessions/${sid}/messages/stream`, shared.length ? { content, app_state: appState() } : { content }, (ev, data) => {
        if (ev === "chunk") live.content += String(data);
        else if (ev === "reset") live.content = "";
        else if (ev === "step") live.steps = [...(live.steps ?? []), data as AgentStep];
        else if (ev === "variable") {
          const d = data as { name: string; value: unknown };
          const why = write(d.name, d.value);
          if (why) refused.push(why);
        } else if (ev === "result") reply = data as ChatMessage;
        show();
      });
      const final = reply as (ChatMessage & { variables?: Record<string, unknown> }) | null;
      if (!final) throw new Error("no answer");
      setMessages((m) => [...m, { ...final, error: [final.error, ...refused].filter(Boolean).join(" · ") || null }]);
      if (c.answer_variable && !final.error) state.setVariable(c.answer_variable, final.content);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStreaming(null);
      setBusy(false);
    }
  };
  // the textbox variable: a value set from outside the widget (an event) is sent as a message
  const ext = c.textbox_variable ? String(state.variables[c.textbox_variable] ?? "") : "";
  const lastExt = useRef(ext);
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    if (!c.textbox_variable || ext === lastExt.current) return;
    lastExt.current = ext;
    if (ext.trim() && !editing) void sendRef.current(ext);
  }, [ext, c.textbox_variable, editing]);
  if (!c.agent_id) return <Msg>Choose an AIP Agent Studio agent in the panel</Msg>;
  // kiosk mode is read-only: an agent that can apply actions is off
  if (state.readOnly && agent?.tools?.actions?.length) return <Msg>This agent can apply actions, so it is off in kiosk mode</Msg>;
  return (
    <div className="flex h-full flex-col text-xs" data-chatbot={c.agent_id}>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {!messages.length && (
          <div className="space-y-2 text-muted">
            <p>{agent?.description || `Ask ${agent?.name ?? "the agent"}.`}</p>
            {(agent?.starters ?? []).map((s) => (
              <button key={s} type="button" onClick={() => void send(s)} disabled={editing} className="block rounded border border-line-2 px-2 py-1 text-left text-soft hover:border-ocean">
                {s}
              </button>
            ))}
          </div>
        )}
        {[...messages, ...(streaming ? [streaming] : [])].map((m, i) => (
          <div key={i} className={m.role === "user" ? "ml-8 rounded-lg bg-ocean/15 p-2" : "mr-4"} data-chat-role={m.role} data-chat-streaming={m === streaming ? "" : undefined}>
            {m.role === "assistant" ? (
              <>
                {(c.show_reasoning || m === streaming) && (m.steps?.length ?? 0) > 0 && (
                  <details className="mb-1 text-[11px] text-muted" open={m === streaming && !!c.show_reasoning}>
                    <summary className="cursor-pointer">
                      {m === streaming && !m.content ? "Working" : "Reasoning"} · {m.steps!.length} tool call(s)
                      {m === streaming && !m.content ? ` · ${m.steps![m.steps!.length - 1].tool}` : ""}
                    </summary>
                    {m.steps!.map((s, j) => (
                      <div key={j} className="mt-1 rounded bg-ink p-1 font-mono" data-chat-step={s.tool}>
                        {s.ok ? "✓" : "✗"} {s.tool} {JSON.stringify(s.arguments).slice(0, 160)}
                      </div>
                    ))}
                  </details>
                )}
                {m === streaming && !m.content ? (
                  <p className="text-muted">Thinking…</p>
                ) : (
                  <div className="md-body" data-chat-answer dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content.replace(/\[\[([A-Za-z][\w]*):([^\]\n]+)\]\]/g, "**$2**")) }} />
                )}
                {m.error && <p className="text-bad">{m.error}</p>}
                {Object.keys((m as { variables?: Record<string, unknown> }).variables ?? {}).length > 0 && (
                  <p className="mt-1 text-[11px] text-muted" data-chat-variables>
                    Set {Object.keys((m as { variables?: Record<string, unknown> }).variables!).join(", ")}
                  </p>
                )}
                {(m.citations?.length ?? 0) > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {m.citations!.map((x) => (
                      <button key={`${x.object_type_id}:${x.primary_key}`} type="button" onClick={() => state.select(sourceKey({ kind: "object_type", id: x.object_type_id }), x.primary_key)} className="rounded bg-ocean/15 px-1.5 py-0.5 text-ocean hover:bg-ocean/25" title={`Select this ${x.type_name}`} data-citation={x.primary_key}>
                        {x.title}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              m.content
            )}
          </div>
        ))}
        {busy && !streaming && <p className="text-muted">Thinking…</p>}
        {error && <p className="text-bad">{error}</p>}
        <div ref={end} />
      </div>
      <div className="flex shrink-0 gap-1 border-t border-line p-2">
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (c.textbox_variable) {
              lastExt.current = e.target.value;
              state.setVariable(c.textbox_variable, e.target.value);
            }
          }}
          onKeyDown={(e) => e.key === "Enter" && void send(text)}
          disabled={editing || busy}
          placeholder={`Message ${agent?.name ?? "the agent"}…`}
          className={`${inputClass} text-xs`}
          data-chat-input
        />
        <button type="button" onClick={() => void send(text)} disabled={editing || busy || !text.trim()} className="rounded bg-ocean px-2.5 text-white disabled:opacity-40">
          <Icon name="right" className="h-3.5 w-3.5" />
        </button>
        {session && (
          <button type="button" onClick={() => (setSession(null), setMessages([]))} title="New conversation" className="px-1 text-muted hover:text-white">
            <Icon name="refresh" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// AIP Generated Content
// ------------------------------------------------------------------------------------------------

export function AipContentWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const mode = c.content_mode ?? "llm";
  const prompt = mode === "llm" ? (c.prompt_variable ? String(state.variables[c.prompt_variable] ?? "") : fillVars(c.prompt ?? "", state.variables)) : "";
  const inputs = useMemo(() => Object.fromEntries(Object.entries(c.logic_inputs ?? {}).map(([k, v]) => [k, valueOf(v, state.variables)])), [c.logic_inputs, state.variables]);
  const [out, setOut] = useState<{ text: string; for: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const forKey = mode === "llm" ? prompt : JSON.stringify(inputs);
  const shown = out && (!c.clear_on_change || out.for === forKey) ? out.text : "";
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      let text = "";
      if (mode === "llm") {
        if (!prompt.trim()) throw new Error("The prompt is empty");
        // streamed: the response appears as the model writes it
        abort.current?.abort();
        const ctl = new AbortController();
        abort.current = ctl;
        let res: { ok: boolean; text?: string; error?: unknown } | null = null;
        setOut({ text: "", for: forKey });
        await sse(
          "/api/functions/llm/chat/stream",
          { prompt, model: c.model || undefined, temperature: c.temperature ?? undefined },
          (ev, data) => {
            if (ev === "chunk") text += String(data);
            else if (ev === "reset") text = "";
            else if (ev === "result") res = data as typeof res;
            if (ev !== "result") setOut({ text, for: forKey });
          },
          ctl.signal,
        );
        const r = res as { ok: boolean; text?: string; error?: unknown } | null;
        if (!r?.ok) throw new Error(typeof r?.error === "string" ? r.error : JSON.stringify(r?.error ?? "the model call failed"));
        text = r.text ?? text;
      } else {
        if (!c.logic_id) throw new Error("Choose an AIP Logic function");
        const r = await ontology.runLogic(c.logic_id, inputs, false);
        if (r.status === "failed") throw new Error(r.error ?? "the Logic run failed");
        text = typeof r.output === "string" ? r.output : JSON.stringify(r.output, null, 2);
      }
      setOut({ text, for: forKey });
      if (c.output_variable) state.setVariable(c.output_variable, text);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full flex-col p-3 text-sm" data-aip-content>
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <Icon name="sparkle" className="h-4 w-4 text-ocean" />
        <span className="flex-1 truncate font-semibold">{c.content_title || "AIP"}</span>
        <button type="button" onClick={run} disabled={editing || busy} className="rounded bg-ocean px-2.5 py-1 text-xs text-white disabled:opacity-40" data-aip-generate>
          {c.button_label || "Generate result using AIP"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-line p-2">
        {busy && shown ? (
          <div className="md-body text-xs" dangerouslySetInnerHTML={{ __html: renderMarkdown(shown) }} data-aip-output data-aip-streaming />
        ) : busy ? (
          c.spinner ? (
            <div className="flex h-full items-center justify-center">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-ocean border-t-transparent" />
            </div>
          ) : (
            <p className="text-muted">{c.loading_message || "Generating…"}</p>
          )
        ) : error ? (
          <p className="text-bad">{error}</p>
        ) : shown ? (
          <div className="md-body text-xs" dangerouslySetInnerHTML={{ __html: renderMarkdown(shown) }} data-aip-output />
        ) : (
          <p className="text-xs text-muted">{mode === "llm" ? (prompt ? `Prompt: ${prompt.slice(0, 160)}${prompt.length > 160 ? "…" : ""}` : "Write the prompt in the panel") : "Runs the AIP Logic function with the inputs from the panel"}</p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// configuration
// ------------------------------------------------------------------------------------------------

const COMMENT_VALUES: [string, string][] = [
  ["$comment:text", "Comment text"],
  ["$comment:users", "Users to notify"],
  ["$comment:object", "Parent object"],
  ["$comment:author", "Current user (the author)"],
];

/** Action to perform after commenting: an action type and its parameters from the comment's special values. */
function CommentActionConfig({ value, onChange }: { value: WidgetConfig["comment_action"]; onChange: (v: WidgetConfig["comment_action"]) => void }) {
  const [list, setList] = useState<ActionType[]>([]);
  const [on, setOn] = useState(!!value);
  useEffect(() => {
    if (on) ontology.actionTypes().then(setList, () => {});
  }, [on]);
  const action = list.find((a) => a.id === value?.action_type_id);
  const params = value?.parameters ?? {};
  return (
    <div className="space-y-2 rounded border border-line p-2 text-xs" data-comment-action-config>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            if (!e.target.checked) onChange(undefined);
          }}
        />
        Action to perform after commenting
      </label>
      {on && (
        <>
          <select value={value?.action_type_id ?? ""} onChange={(e) => onChange(e.target.value ? { action_type_id: e.target.value, parameters: {} } : undefined)} className={inputClass}>
            <option value="">Choose an action type…</option>
            {list.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name}
              </option>
            ))}
          </select>
          {action?.parameters.map((p) => {
            const v = params[p.id];
            const special = typeof v === "string" && COMMENT_VALUES.some(([k]) => k === v);
            return (
              <div key={p.id} className="flex items-center gap-1">
                <span className="w-24 truncate text-muted" title={p.id}>
                  {(p as { display_name?: string }).display_name ?? p.id}
                </span>
                <select
                  value={special ? String(v) : v === undefined ? "" : "value"}
                  onChange={(e) =>
                    onChange({ action_type_id: action.id, parameters: { ...params, [p.id]: e.target.value === "" ? undefined : e.target.value === "value" ? (special ? "" : v ?? "") : e.target.value } })
                  }
                  className={`${fieldClass} min-w-0 flex-1 text-xs`}
                >
                  <option value="">Not set</option>
                  {COMMENT_VALUES.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                  <option value="value">A value ($var:name allowed)…</option>
                </select>
                {!special && v !== undefined && (
                  <input value={String(v ?? "")} onChange={(e) => onChange({ action_type_id: action.id, parameters: { ...params, [p.id]: e.target.value } })} className={`${fieldClass} w-24 text-xs`} />
                )}
              </div>
            );
          })}
          <p className="text-[11px] text-muted">Users to notify: everyone who commented on or was mentioned in the thread, except the author. Turn the default notifications off when the action sends its own.</p>
        </>
      )}
    </div>
  );
}

export const AIP_TYPES = new Set(["comments", "inline_action", "aip_chatbot", "aip_content"]);

export function AipWidgetConfig({ widget, set, mod, sources }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module; cols: Column[]; sources: Sources }) {
  const c = widget.config;
  const t = widget.type;
  const vars = mod.variables ?? [];
  const [actionTypes, setActionTypes] = useState<ActionType[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [logic, setLogic] = useState<LogicFunction[]>([]);
  const [action, setAction] = useState<ActionType | null>(null);
  useEffect(() => {
    if (t === "inline_action") ontology.actionTypes().then(setActionTypes, () => {});
    if (t === "aip_chatbot") agentsApi.list().then(setAgents, () => {});
    if (t === "aip_content") ontology.logicList().then(setLogic, () => {});
  }, [t]);
  const first = c.action_ids?.[0] ?? c.action_type_id;
  useEffect(() => {
    if (t === "inline_action" && first) ontology.actionType(first).then(setAction, () => setAction(null));
  }, [t, first]);
  const varSelect = (value: string | undefined, onChange: (v: string | undefined) => void, types: string[], empty = "None") => (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={inputClass}>
      <option value="">{empty}</option>
      {vars.filter((v) => types.includes(v.type)).map((v) => (
        <option key={v.name}>{v.name}</option>
      ))}
    </select>
  );
  if (t === "comments")
    return (
      <div className="space-y-3">
        <Field label="Object (otherwise the selected object of the source)">
          <input value={String(c.object_pk ?? "")} onChange={(e) => set({ object_pk: e.target.value || undefined })} placeholder="$var:name or a primary key" className={inputClass} />
        </Field>
        <Field label="References: objects of this type can be mentioned (# Reference)">
          <select value={c.ref_object_type_id ?? ""} onChange={(e) => set({ ref_object_type_id: e.target.value || undefined })} className={inputClass}>
            <option value="">No references</option>
            {sources.object_types.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        {c.ref_object_type_id && <EventsEditor events={c.ref_events ?? []} mod={mod} onChange={(ev) => set({ ref_events: ev })} label="When a reference is selected (it is also selected in the module)" />}
        <EventsEditor events={c.comment_events ?? []} mod={mod} onChange={(ev) => set({ comment_events: ev })} label="After commenting" />
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!c.show_action_log} onChange={(e) => set({ show_action_log: e.target.checked })} /> Show the object&apos;s action log in the feed
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!c.comment_no_notify} onChange={(e) => set({ comment_no_notify: !e.target.checked || undefined })} data-comment-notify /> Send default notifications
          (everyone who commented or was mentioned on the object)
        </label>
        <CommentActionConfig value={c.comment_action} onChange={(v) => set({ comment_action: v })} />
        <p className="text-[11px] text-muted">Comments follow the object&apos;s permissions; @username mentions always notify the user.</p>
      </div>
    );
  if (t === "inline_action") {
    const ids = c.action_ids?.length ? c.action_ids : c.action_type_id ? [c.action_type_id] : [];
    const defaults = c.action_defaults ?? {};
    const params = (action?.parameters ?? []) as unknown as { id: string; display_name?: string; name?: string }[];
    return (
      <div className="space-y-3">
        <Field label="Action types (several: a menu above the form)">
          <div className="space-y-1">
            {ids.map((id, i) => (
              <div key={i} className="flex gap-1">
                <select value={id} onChange={(e) => set({ action_ids: ids.map((x, j) => (j === i ? e.target.value : x)), action_type_id: undefined })} className={inputClass}>
                  {actionTypes.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.display_name}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => set({ action_ids: ids.filter((_, j) => j !== i), action_type_id: undefined })} className="px-1 text-muted hover:text-bad">
                  ✕
                </button>
              </div>
            ))}
            <select value="" onChange={(e) => e.target.value && set({ action_ids: [...ids, e.target.value], action_type_id: undefined })} className={inputClass} data-inline-add>
              <option value="">+ Add an action type…</option>
              {actionTypes.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name}
                </option>
              ))}
            </select>
          </div>
        </Field>
        {params.length > 0 && (
          <Field label={`Parameter defaults of the first action ($var:name allowed)`}>
            <div className="space-y-1">
              {params.map((p) => (
                <div key={p.id} className="flex items-center gap-1 text-xs">
                  <span className="w-24 truncate text-muted" title={p.id}>
                    {p.display_name ?? p.name ?? p.id}
                  </span>
                  <input
                    value={String(defaults[p.id] ?? "")}
                    onChange={(e) => set({ action_defaults: { ...defaults, [p.id]: e.target.value || undefined } })}
                    placeholder="from the action type"
                    className={`${fieldClass} min-w-0 flex-1 text-xs`}
                  />
                </div>
              ))}
            </div>
          </Field>
        )}
        <Field label="Default layout">
          <select value={c.action_layout ?? "form"} onChange={(e) => set({ action_layout: e.target.value as "form" | "table" })} className={inputClass} data-inline-layout-select>
            <option value="form">Action form (one at a time)</option>
            <option value="table">Action table (rows applied together)</option>
          </select>
        </Field>
        <div className="space-y-1 text-xs">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!c.allow_layout_switch} onChange={(e) => set({ allow_layout_switch: e.target.checked || undefined })} /> Users switch the layout
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.allow_row_changes !== false} onChange={(e) => set({ allow_row_changes: e.target.checked ? undefined : false })} /> Table: users add and remove rows
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.allow_csv_upload !== false} onChange={(e) => set({ allow_csv_upload: e.target.checked ? undefined : false })} /> Table: CSV upload of rows
          </label>
        </div>
        <Field label="Pre-fill with variable (table: one row per object)">
          {varSelect(c.prefill_variable, (v) => set({ prefill_variable: v }), ["object_set"], "No pre-fill")}
        </Field>
        {c.prefill_variable && (
          <Field label="…into the object parameter">
            <select value={c.prefill_param ?? ""} onChange={(e) => set({ prefill_param: e.target.value || undefined })} className={inputClass}>
              <option value="">The action&apos;s object parameter</option>
              {(action?.parameters ?? [])
                .filter((p) => p.type === "object")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {(p as { display_name?: string }).display_name ?? p.id}
                  </option>
                ))}
            </select>
            {(() => {
              const def = vars.find((v) => v.name === c.prefill_variable)?.definition as { object_type_id?: string } | undefined;
              const p = (action?.parameters ?? []).find((x) => x.id === c.prefill_param) ?? (action?.parameters ?? []).find((x) => x.type === "object");
              const want = (p as { object_type_id?: string | null } | undefined)?.object_type_id || action?.object_type_id;
              return def?.object_type_id && want && def.object_type_id !== want ? <p className="mt-1 text-[11px] text-warn">The variable&apos;s object type is not the parameter&apos;s object type</p> : null;
            })()}
          </Field>
        )}
        <Field label="Inline Action form state if invalid (submission criteria not met)">
          <select value={c.invalid_state ?? "disabled"} onChange={(e) => set({ invalid_state: e.target.value === "hidden" ? "hidden" : undefined })} className={inputClass} data-inline-invalid>
            <option value="disabled">Disabled (shown, Submit off)</option>
            <option value="hidden">Hidden</option>
          </select>
        </Field>
        <Field label="Custom title ({{variables}})">
          <input value={c.action_title ?? ""} onChange={(e) => set({ action_title: e.target.value || undefined })} className={inputClass} />
        </Field>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!c.hide_header} onChange={(e) => set({ hide_header: e.target.checked })} /> Hide the header
        </label>
        <EventsEditor events={c.on_submit ?? []} mod={mod} onChange={(ev) => set({ on_submit: ev })} label="On successful submit" />
        <p className="text-[11px] text-muted">Modify and delete actions use the selected object of the action&apos;s type.</p>
      </div>
    );
  }
  if (t === "aip_chatbot") {
    const st = c.app_state ?? [];
    return (
      <div className="space-y-3">
        <Field label="Agent (AIP Agent Studio)">
          <select value={c.agent_id ?? ""} onChange={(e) => set({ agent_id: e.target.value || undefined })} className={inputClass}>
            <option value="">Choose…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!c.show_reasoning} onChange={(e) => set({ show_reasoning: e.target.checked })} /> Show the reasoning (tool calls)
        </label>
        <Field label="Application state: variables the agent sees, with descriptions">
          <div className="space-y-1">
            {st.map((x, i) => (
              <div key={i} className="space-y-1 rounded border border-line p-1.5">
                <div className="flex gap-1">
                  <div className="min-w-0 flex-1">{varSelect(x.variable, (v) => set({ app_state: st.map((y, j) => (j === i ? { ...y, variable: v ?? "" } : y)) }), ["string", "number", "boolean", "date", "timestamp", "array", "struct", "struct_array"], "Variable…")}</div>
                  <button type="button" onClick={() => set({ app_state: st.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                    ✕
                  </button>
                </div>
                <input value={x.description ?? ""} onChange={(e) => set({ app_state: st.map((y, j) => (j === i ? { ...y, description: e.target.value } : y)) })} placeholder="What it means, when to use it" className={`${fieldClass} w-full text-xs`} />
                <select
                  value={x.access ?? "read"}
                  onChange={(e) => set({ app_state: st.map((y, j) => (j === i ? { ...y, access: e.target.value === "read_write" ? "read_write" : undefined } : y)) })}
                  className={`${fieldClass} w-full text-xs`}
                  data-app-state-access={x.variable}
                >
                  <option value="read">Read only</option>
                  <option value="read_write">Read and write (the agent may set it)</option>
                </select>
              </div>
            ))}
            <button type="button" onClick={() => set({ app_state: [...st, { variable: "" }] })} className="text-xs text-ocean">
              + Variable
            </button>
          </div>
        </Field>
        <Field label="Textbox variable (set from an event: sends it as a message)">{varSelect(c.textbox_variable, (v) => set({ textbox_variable: v }), ["string"])}</Field>
        <Field label="Last answer into">{varSelect(c.answer_variable, (v) => set({ answer_variable: v }), ["string"])}</Field>
      </div>
    );
  }
  if (t === "aip_content") {
    const fn = logic.find((x) => x.id === c.logic_id);
    const li = c.logic_inputs ?? {};
    return (
      <div className="space-y-3">
        <Field label="Generate with">
          <select value={c.content_mode ?? "llm"} onChange={(e) => set({ content_mode: e.target.value as "llm" })} className={inputClass}>
            <option value="llm">Direct to an LLM</option>
            <option value="logic">An AIP Logic function</option>
          </select>
        </Field>
        {(c.content_mode ?? "llm") === "llm" ? (
          <>
            <Field label="Prompt from a string variable">{varSelect(c.prompt_variable, (v) => set({ prompt_variable: v }), ["string"], "No (write it below)")}</Field>
            {!c.prompt_variable && (
              <Field label="Prompt ({{variables}})">
                <textarea rows={5} value={c.prompt ?? ""} onChange={(e) => set({ prompt: e.target.value })} className={`${inputClass} text-xs`} />
              </Field>
            )}
            <Field label="Model (empty: the default)">
              <input value={c.model ?? ""} onChange={(e) => set({ model: e.target.value || undefined })} className={inputClass} />
            </Field>
            <Field label={`Temperature: ${c.temperature ?? 0} (0 focused … 1 random)`}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={c.temperature ?? 0}
                onChange={(e) => set({ temperature: Number(e.target.value) || undefined })}
                className="w-full"
                data-aip-temperature
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="AIP Logic function">
              <select value={c.logic_id ?? ""} onChange={(e) => set({ logic_id: e.target.value || undefined, logic_inputs: {} })} className={inputClass}>
                <option value="">Choose…</option>
                {logic.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Field>
            {fn?.inputs.map((inp) => (
              <div key={inp.name} className="flex items-center gap-1 text-xs">
                <span className="w-24 truncate text-muted">{inp.name}</span>
                <input value={String(li[inp.name] ?? "")} onChange={(e) => set({ logic_inputs: { ...li, [inp.name]: e.target.value } })} placeholder="$var:name or a value" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
              </div>
            ))}
          </>
        )}
        <Field label="Output variable">{varSelect(c.output_variable, (v) => set({ output_variable: v }), ["string"])}</Field>
        <div className="grid grid-cols-2 gap-2">
          <input value={c.content_title ?? ""} onChange={(e) => set({ content_title: e.target.value || undefined })} placeholder="Title" className={inputClass} />
          <input value={c.button_label ?? ""} onChange={(e) => set({ button_label: e.target.value || undefined })} placeholder="Button label" className={inputClass} />
          <input value={c.loading_message ?? ""} onChange={(e) => set({ loading_message: e.target.value || undefined })} placeholder="Loading message" className={inputClass} />
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={!!c.spinner} onChange={(e) => set({ spinner: e.target.checked })} /> Spinner
          </label>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!c.clear_on_change} onChange={(e) => set({ clear_on_change: e.target.checked })} /> Clear the output when the prompt changes
        </label>
      </div>
    );
  }
  return null;
}

