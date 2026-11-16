"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { LISTENER_KINDS, listeners, type Listener, type ListenerIn, type ListenerKind } from "@/lib/dataConnection";
import { when } from "@/lib/format";
import { chooseDialog, confirmDialog } from "@/lib/dialogs";
import { FolderPicker } from "../drive/dialogs";
import { Icon } from "../Icon";
import { buttonClass, inputClass, Modal } from "../pipeline/Modal";
import { Field, Panel } from "../pipeline/ui";
import { useLoad } from "./DataSourceWizard";
import { CopyText, EmptyState, ErrorLine, JsonBlock, TabPage } from "./dcui";

const KIND_LABEL = Object.fromEntries(LISTENER_KINDS.map((k) => [k.id, k.label])) as Record<ListenerKind, string>;

/** HTTPS listeners: inbound webhooks from external systems, written to a stream. */
export function ListenersTab() {
  const list = useLoad("listeners", () => listeners.list());
  const [editing, setEditing] = useState<Listener | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const rows = list.data ?? list.last;
  const selected = rows?.find((l) => l.id === open) ?? null;
  return (
    <div className="flex min-h-0 flex-1">
      <TabPage
        title="Listeners"
        description="An endpoint URL that external systems (GitHub, Slack, Stripe, Jira…) post events to. Each request is verified with the sender's signing protocol and written to the listener's stream, ready for streaming pipelines or batch pipelines."
        actions={
          <button type="button" onClick={() => setEditing("new")} className={buttonClass.primary}>
            <Icon name="plus" /> New listener
          </button>
        }
      >
        {list.error && <ErrorLine text={list.error} onRetry={list.retry} />}
        {!rows ? (
          !list.error && <p className="text-sm text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <EmptyState icon="bell" title="No listeners yet" text="Use a listener when a system can only push webhooks and cannot authenticate with the platform's API." action={<button type="button" onClick={() => setEditing("new")} className={buttonClass.primary}><Icon name="plus" /> New listener</button>} />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="bg-panel text-left text-xs text-muted">
                <tr>
                  {["Name", "Type", "Status", "Events", "Last event"].map((h) => (
                    <th key={h} className="px-4 py-2.5 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} onClick={() => setOpen(l.id)} className={`cursor-pointer border-t border-line ${open === l.id ? "bg-ocean/10" : "hover:bg-panel/60"}`}>
                    <td className="px-4 py-2.5 font-medium">{l.name}</td>
                    <td className="px-4 py-2.5 text-xs text-soft">{KIND_LABEL[l.kind]}</td>
                    <td className="px-4 py-2.5 text-xs">{l.status === "active" ? <span className="text-ok">● Active</span> : <span className="text-muted">○ Inactive</span>}</td>
                    <td className="px-4 py-2.5 text-xs tabular-nums text-soft">{(l.stats.events ?? 0).toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-xs text-muted">{l.stats.last_event_at ? when(l.stats.last_event_at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </TabPage>
      {selected && <ListenerPanel key={selected.id} listener={selected} onClose={() => setOpen(null)} onChanged={list.retry} onEdit={() => setEditing(selected)} />}
      {editing && (
        <ListenerEditor
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(l) => {
            setEditing(null);
            setOpen(l.id);
            list.retry();
          }}
        />
      )}
    </div>
  );
}

/** Where a listener lives: its folder's path (whose Project roles and markings apply), or whose own it is. */
function ListenerHome({ l }: { l: Listener }) {
  const home = useLoad(l.item_id ? `home:${l.item_id}` : null, () => api.drive.folder(l.item_id));
  if (!l.item_id) {
    return <span>{l.created_by ? `${l.created_by_name ?? "its creator"}'s own listener (and administrators')` : "administrators only (made before listeners had access rules) — move it into a folder"}</span>;
  }
  const f = home.data?.folder;
  return <span>{f ? [...(f.path ?? []).map((p) => p.name), f.name].join(" / ") : home.error ? "a folder you cannot open" : "…"}</span>;
}

function ListenerPanel({ listener: row, onClose, onChanged, onEdit }: { listener: Listener; onClose: () => void; onChanged: () => void; onEdit: () => void }) {
  const [nonce, setNonce] = useState(0);
  // listings carry no endpoint tokens: the listener itself has them, for those who may change it
  const detail = useLoad(`listener:${row.id}:${row.updated_at}`, () => listeners.get(row.id));
  const l = detail.data ?? detail.last ?? row;
  const events = useLoad(`events:${l.id}:${nonce}`, () => listeners.events(l.id));
  const [error, setError] = useState<string | null>(null);
  const [expire, setExpire] = useState(24);
  const [moving, setMoving] = useState(false);
  // the test view follows incoming events while the listener is active
  useEffect(() => {
    if (l.status !== "active") return;
    const t = setInterval(() => setNonce((n) => n + 1), 3000);
    return () => clearInterval(t);
  }, [l.status]);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const live = l.endpoints.filter((e) => !e.expired);
  return (
    <Panel title={l.name} icon="bell" onClose={onClose} width="w-[28rem]">
      <div className="space-y-4 overflow-y-auto p-4 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">{KIND_LABEL[l.kind]}</span>
          <span className="flex-1" />
          {l.can_edit && (
            <>
              <button type="button" onClick={() => act(() => listeners.setActive(l.id, l.status !== "active"))} className={l.status === "active" ? buttonClass.secondary : buttonClass.primary}>
                <Icon name={l.status === "active" ? "pause" : "play"} className="h-3.5 w-3.5" /> {l.status === "active" ? "Stop" : "Start"}
              </button>
              <button type="button" onClick={onEdit} className={buttonClass.secondary}>
                <Icon name="edit" className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
        <div className="flex items-start gap-2 text-xs text-muted">
          <span className="flex-1">
            Location: <span className="text-soft"><ListenerHome l={l} /></span>
            {!l.can_edit && <span className="block">You can read its events; changing it needs the Editor role on its Project.</span>}
          </span>
          {l.can_edit && (
            <button type="button" onClick={() => setMoving(true)} className="underline hover:text-white">
              move…
            </button>
          )}
        </div>
        {moving && (
          <FolderPicker
            title={`Move "${l.name}" to…`}
            action="Move here"
            moving={[]}
            startAt={l.item_id}
            onClose={() => setMoving(false)}
            onPick={(folderId) => {
              setMoving(false);
              if (folderId) void act(() => listeners.move(l.id, folderId));
              else setError("Choose a folder or Project: a listener moves into one (its roles and markings then apply).");
            }}
          />
        )}
        {l.status !== "active" && <p className="rounded bg-warn/10 p-2 text-xs text-warn">Inactive: requests are refused until you start the listener.</p>}
        <div>
          <div className="mb-1 text-xs font-medium text-soft">Endpoints</div>
          <p className="mb-2 text-xs text-muted">
            {l.can_edit ? "Give this URL to the external system. It must be able to reach this server (configure ingress / a public address for production use)." : "The endpoint URLs are shown to those who may change the listener."}
          </p>
          <ul className="space-y-1.5">
            {l.endpoints.map((e, i) => (
              <li key={e.token ?? `${i}:${e.created_at}`} className="space-y-1">
                {e.url && <CopyText text={e.url} />}
                <div className="flex items-center gap-2 text-[11px] text-muted">
                  {e.expires_at ? (e.expired ? <span className="text-bad">expired {when(e.expires_at)}</span> : <span className="text-warn">expires {when(e.expires_at)}</span>) : <span className="text-ok">active endpoint</span>}
                  {e.expires_at && e.token && l.can_edit && (
                    <button type="button" onClick={() => act(() => listeners.deleteEndpoint(l.id, e.token!))} className="ml-auto underline hover:text-bad">
                      delete now
                    </button>
                  )}
                  {e.expires_at && !e.expired && e.token && l.can_edit && (
                    <button type="button" onClick={() => act(() => listeners.setExpiry(l.id, e.token!, new Date(Date.parse(e.expires_at!) + 24 * 3600_000).toISOString()))} className="underline hover:text-white">
                      extend 1 day
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {l.can_edit && live.length < 2 && (
            <div className="mt-2 flex items-center gap-2 text-xs">
              <span className="text-muted">Rotate: the current endpoint keeps working for</span>
              <select value={expire} onChange={(e) => setExpire(Number(e.target.value))} className={`${inputClass} w-28 py-0.5 text-xs`}>
                <option value={0}>no time (delete)</option>
                <option value={1}>1 hour</option>
                <option value={24}>1 day</option>
                <option value={168}>7 days</option>
              </select>
              <button
                type="button"
                onClick={async () => {
                  if (expire === 0 && !(await confirmDialog("The current endpoint stops working immediately. Rotate?"))) return;
                  void act(() => listeners.rotate(l.id, expire));
                }}
                className={`${buttonClass.secondary} py-0.5 text-xs`}
              >
                <Icon name="refresh" className="h-3 w-3" /> Rotate
              </button>
            </div>
          )}
        </div>
        {l.kind === "google_pubsub" && <p className="text-xs text-muted">Pub/Sub push subscription URL: append ?token=&lt;the shared secret&gt; to the endpoint.</p>}
        {l.kind === "custom" && l.config.auth === "query" && <p className="text-xs text-muted">Senders append ?token=&lt;the shared secret&gt; to the endpoint.</p>}
        <div className="text-xs text-muted">
          Events are written to the stream <code className="text-soft">{l.stream_id}</code> (Pipeline Builder → Add data → Stream). Limits: 1 MB per event, about 100 requests per second.
        </div>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div>
          <div className="mb-1 flex items-center text-xs font-medium text-soft">
            Recent events
            <button type="button" onClick={() => setNonce((n) => n + 1)} className="ml-auto text-muted hover:text-white" title="Refresh">
              <Icon name="refresh" className="h-3.5 w-3.5" />
            </button>
          </div>
          {(events.data ?? events.last)?.events.length ? (
            <ul className="space-y-2">
              {(events.data ?? events.last)!.events.slice(0, 20).map((ev) => {
                let body: unknown = ev.body;
                try {
                  body = JSON.parse(ev.body);
                } catch {}
                return (
                  <li key={ev.seq}>
                    <div className="mb-0.5 text-[11px] text-muted">
                      #{ev.seq} · {when(ev.received_at)}
                    </div>
                    <JsonBlock value={body} max={1500} />
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-muted">No events yet — send a test event from the external system.</p>
          )}
        </div>
        {l.can_edit && (
        <button
          type="button"
          onClick={async () => {
            const pick = await chooseDialog({
              title: `Delete the listener "${l.name}"?`,
              message: "Its endpoints stop accepting events. Choose what happens to the stream of events it received.",
              choices: [
                { id: "keep", label: "Delete, keep the stream" },
                { id: "all", label: "Delete with its stream", danger: true },
              ],
            });
            if (!pick) return;
            void act(() => listeners.remove(l.id, pick === "all")).then(onClose);
          }}
          className={`${buttonClass.secondary} text-bad`}
        >
          <Icon name="trash" className="h-3.5 w-3.5" /> Delete listener
        </button>
        )}
      </div>
    </Panel>
  );
}

function ListenerEditor({ initial, onClose, onSaved }: { initial: Listener | null; onClose: () => void; onSaved: (l: Listener) => void }) {
  const [form, setForm] = useState<ListenerIn>({
    name: initial?.name ?? "",
    kind: initial?.kind ?? "github",
    auth: (initial?.config.auth as ListenerIn["auth"]) ?? "header",
    header_name: initial?.config.header_name ?? "",
    algorithm: (initial?.config.algorithm as ListenerIn["algorithm"]) ?? "sha256",
    encoding: (initial?.config.encoding as ListenerIn["encoding"]) ?? "hex",
    prefix: initial?.config.prefix ?? "",
    secret: "",
    username: initial?.username ?? "",
    parent_id: null,
  });
  const [picking, setPicking] = useState(false);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<ListenerIn>) => setForm({ ...form, ...p });
  const kind = LISTENER_KINDS.find((k) => k.id === form.kind)!;
  const needsSecret = !(form.kind === "jira" || (form.kind === "custom" && form.auth === "none"));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(initial ? await listeners.update(initial.id, form) : await listeners.create(form));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={initial ? `Edit ${initial.name}` : "New listener"} icon="bell" onClose={onClose}>
      <div className="space-y-3 p-5 text-sm">
        <Field label="Name" required>
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="GitHub pull requests" className={inputClass} />
        </Field>
        {!initial && (
          <Field label="Location" hint="The folder or Project whose roles and markings apply to the listener and its stream: Viewers read its events, Editors change it. Without one it is yours alone (and administrators').">
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-soft">{form.parent_id ? folderName ?? form.parent_id : "Only me (no folder)"}</span>
              {form.parent_id && (
                <button type="button" onClick={() => set({ parent_id: null })} className="text-xs text-muted underline hover:text-white">
                  clear
                </button>
              )}
              <button type="button" onClick={() => setPicking(true)} className={`${buttonClass.secondary} py-0.5 text-xs`}>
                <Icon name="folder" className="h-3 w-3" /> Choose…
              </button>
            </div>
          </Field>
        )}
        {picking && (
          <FolderPicker
            title="Create the listener in…"
            action="Choose"
            moving={[]}
            startAt={form.parent_id ?? null}
            onClose={() => setPicking(false)}
            onPick={(folderId) => {
              setPicking(false);
              set({ parent_id: folderId });
              setFolderName(null);
              if (folderId) void api.drive.folder(folderId).then((d) => d.folder && setFolderName([...(d.folder.path ?? []).map((p) => p.name), d.folder.name].join(" / ")), () => undefined);
            }}
          />
        )}
        <Field label="Listener type" hint={kind.hint}>
          <select value={form.kind} disabled={!!initial} onChange={(e) => set({ kind: e.target.value as ListenerKind })} className={inputClass}>
            {LISTENER_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        {form.kind === "custom" && (
          <Field label="Authentication">
            <select value={form.auth} onChange={(e) => set({ auth: e.target.value as ListenerIn["auth"] })} className={inputClass}>
              <option value="header">Shared secret in a header</option>
              <option value="query">Shared secret in the token query parameter</option>
              <option value="basic">Basic authentication</option>
              <option value="none">None (anyone with the URL)</option>
            </select>
          </Field>
        )}
        {((form.kind === "custom" && form.auth === "header") || form.kind === "hmac") && (
          <Field label={form.kind === "hmac" ? "Signature header" : "Header name"} required>
            <input value={form.header_name} onChange={(e) => set({ header_name: e.target.value })} placeholder={form.kind === "hmac" ? "X-Signature" : "X-Webhook-Secret"} className={`${inputClass} font-mono`} />
          </Field>
        )}
        {form.kind === "hmac" && (
          <div className="grid grid-cols-3 gap-2">
            <Field label="Algorithm">
              <select value={form.algorithm} onChange={(e) => set({ algorithm: e.target.value as ListenerIn["algorithm"] })} className={inputClass}>
                <option value="sha256">HMAC-SHA256</option>
                <option value="sha1">HMAC-SHA1</option>
              </select>
            </Field>
            <Field label="Encoding">
              <select value={form.encoding} onChange={(e) => set({ encoding: e.target.value as ListenerIn["encoding"] })} className={inputClass}>
                <option value="hex">hex</option>
                <option value="base64">base64</option>
              </select>
            </Field>
            <Field label="Prefix">
              <input value={form.prefix} onChange={(e) => set({ prefix: e.target.value })} placeholder="sha256=" className={`${inputClass} font-mono`} />
            </Field>
          </div>
        )}
        {form.kind === "custom" && form.auth === "basic" && (
          <Field label="Username" required>
            <input value={form.username} onChange={(e) => set({ username: e.target.value })} className={inputClass} />
          </Field>
        )}
        {needsSecret || form.kind === "jira" ? (
          <Field
            label={form.kind === "custom" && form.auth === "basic" ? "Password" : form.kind === "slack" ? "Signing secret" : form.kind === "gitlab" ? "Secret token" : "Secret"}
            required={needsSecret && !initial}
            hint={initial ? "Saved — leave empty to keep it." : form.kind === "jira" ? "Optional: without one, Jira events are accepted unsigned." : "The value configured in the external system; kept encrypted."}
          >
            <input type="password" value={form.secret} onChange={(e) => set({ secret: e.target.value })} className={inputClass} />
          </Field>
        ) : null}
        <p className="text-xs text-muted">Palantir makes no guarantees about external protocols; restrict who can use the listener&apos;s stream, and keep the endpoint URL private.</p>
        {error && <ErrorLine text={error} />}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={busy || !form.name.trim()} onClick={save} className={buttonClass.primary}>
            <Icon name="save" className="h-3.5 w-3.5" /> {busy ? "Saving…" : initial ? "Save" : "Create listener"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
