"use client";

import { useState } from "react";
import {
  BODY_TYPES,
  executeWebhook,
  INPUT_TYPES,
  METHODS,
  OUTPUT_TYPES,
  restSources,
  webhooks,
  type CallTrace,
  type DomainAuth,
  type RestDomain,
  type RestSource,
  type Webhook,
  type WebhookCall,
  type WebhookDef,
  type WebhookResult,
} from "@/lib/dataConnection";
import { API_URL } from "@/lib/api";
import { when } from "@/lib/format";
import { Icon } from "../Icon";
import { buttonClass, inputClass, Modal } from "../pipeline/Modal";
import { Field, Switch, Tabs } from "../pipeline/ui";
import { useLoad } from "./DataSourceWizard";
import { CopyText, EmptyState, ErrorLine, JsonBlock, PairsEditor, RunStatus, TabPage } from "./dcui";
import { confirmDialog } from "@/lib/dialogs";

const AUTH_LABEL: Record<DomainAuth, string> = {
  none: "No authentication",
  bearer: "Bearer token",
  basic: "Basic (username and password)",
  api_key_header: "API key in a header",
  api_key_query: "API key in a query parameter",
};

/** REST API sources and their webhooks. */
export function WebhooksTab() {
  const list = useLoad("rest-sources", () => restSources.list());
  const [editingSource, setEditingSource] = useState<RestSource | "new" | null>(null);
  const [openSource, setOpenSource] = useState<string | null>(null);
  const [editingHook, setEditingHook] = useState<{ source: RestSource; hook?: Webhook } | null>(null);
  const rows = list.data ?? list.last;
  const source = rows?.find((s) => s.id === openSource) ?? rows?.[0] ?? null;

  return (
    <TabPage
      title="Webhooks"
      description="A REST API source holds a system's domains, authentication and secrets; its webhooks are structured requests — or chains of requests — run on demand, with typed inputs and outputs parsed from the responses."
      actions={
        <button type="button" onClick={() => setEditingSource("new")} className={buttonClass.primary}>
          <Icon name="plus" /> New REST API source
        </button>
      }
    >
      {list.error && <ErrorLine text={list.error} onRetry={list.retry} />}
      {!rows ? (
        !list.error && <p className="text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState icon="globe" title="No REST API sources" text="Add the API's base URL and how it authenticates; then build webhooks on it, such as creating a record in another system." action={<button type="button" onClick={() => setEditingSource("new")} className={buttonClass.primary}><Icon name="plus" /> New REST API source</button>} />
      ) : (
        <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
          <ul className="space-y-1">
            {rows.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setOpenSource(s.id)}
                  className={`flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left ${source?.id === s.id ? "bg-ocean/10 ring-1 ring-ocean/40" : "hover:bg-panel"}`}
                >
                  <Icon name="globe" className="mt-0.5 h-4 w-4 shrink-0 text-ocean" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{s.name}</span>
                    <span className="block truncate text-xs text-muted">{s.domains.map((d) => d.url).join(", ")}</span>
                    <span className="block text-xs text-muted">
                      {s.webhooks.length} webhook{s.webhooks.length === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {source && (
            <SourceDetail
              key={source.id}
              source={source}
              onEdit={() => setEditingSource(source)}
              onChanged={list.retry}
              onNewHook={() => setEditingHook({ source })}
              onEditHook={(hook) => setEditingHook({ source, hook })}
            />
          )}
        </div>
      )}
      {editingSource && (
        <SourceEditor
          initial={editingSource === "new" ? null : editingSource}
          onClose={() => setEditingSource(null)}
          onSaved={(s) => {
            setEditingSource(null);
            setOpenSource(s.id);
            list.retry();
          }}
        />
      )}
      {editingHook && (
        <WebhookEditor
          source={editingHook.source}
          initial={editingHook.hook}
          onClose={() => setEditingHook(null)}
          onSaved={() => {
            setEditingHook(null);
            list.retry();
          }}
        />
      )}
    </TabPage>
  );
}

function SourceDetail({ source, onEdit, onChanged, onNewHook, onEditHook }: { source: RestSource; onEdit: () => void; onChanged: () => void; onNewHook: () => void; onEditHook: (h: Webhook) => void }) {
  const hooks = useLoad(`hooks:${source.id}:${source.updated_at}:${source.webhooks.length}`, () => webhooks.list(source.id));
  const [test, setTest] = useState<Awaited<ReturnType<typeof restSources.test>> | "running" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openHook, setOpenHook] = useState<string | null>(null);

  return (
    <div className="min-w-0 space-y-4">
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="font-medium">{source.name}</div>
            <div className="text-xs text-muted">{source.api_name ? `API name ${source.api_name}` : "No API name — set one to call its webhooks from functions"}</div>
          </div>
          <button
            type="button"
            onClick={async () => {
              setTest("running");
              try {
                setTest(await restSources.test(source.id));
              } catch (e) {
                setError((e as Error).message);
                setTest(null);
              }
            }}
            className={`${buttonClass.secondary} py-1 text-xs`}
          >
            <Icon name={test === "running" ? "refresh" : "signal"} className={`h-3.5 w-3.5 ${test === "running" ? "animate-spin" : ""}`} /> Test connection
          </button>
          <button type="button" onClick={onEdit} className={`${buttonClass.secondary} py-1 text-xs`}>
            <Icon name="edit" className="h-3.5 w-3.5" /> Edit
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!(await confirmDialog(`Delete "${source.name}" and its ${source.webhooks.length} webhooks?`))) return;
              try {
                await restSources.remove(source.id);
                onChanged();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className="rounded p-1.5 text-muted hover:text-bad"
            title="Delete source"
          >
            <Icon name="trash" className="h-4 w-4" />
          </button>
        </div>
        <ul className="mt-3 space-y-1 text-xs">
          {source.domains.map((d, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-soft">{d.url}</span>
              <span className="text-muted">{AUTH_LABEL[d.auth]}{d.key_name ? ` (${d.key_name})` : ""}</span>
              {test && test !== "running" && test.domains[i] && (
                <span className={test.domains[i].ok ? "text-ok" : "text-bad"}>
                  {test.domains[i].ok ? `reachable · HTTP ${test.domains[i].status}` : test.domains[i].error} · {test.domains[i].ms} ms
                </span>
              )}
            </li>
          ))}
        </ul>
        <div className="mt-2 text-xs text-muted">Additional secrets: {source.secrets.length ? source.secrets.map((s) => `{{secret.${s}}}`).join(", ") : "none"}</div>
        <div className="mt-3">
          <Switch
            on={source.code_imports}
            onChange={async (on) => {
              try {
                await restSources.settings(source.id, { code_imports: on });
                onChanged();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            label="Allow imports into code repositories"
            hint="External transforms can then use Source(…) to call this API with its credentials."
          />
          <Switch
            on={!!source.export_controls?.allow_foundry_inputs}
            onChange={async (on) => {
              try {
                const res = await fetch(`${API_URL}/api/code-repos/tools/sources/${source.id}/export-controls`, {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ allow_foundry_inputs: on }),
                });
                if (!res.ok) throw new Error((await res.json().catch(() => ({ detail: res.statusText }))).detail);
                onChanged();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            label="Export controls: allow transforms that read Foundry inputs"
            hint="Off: an external transform with Foundry inputs cannot use this source (its data could leave the platform). Administrators set this."
          />
        </div>
        {error && <p className="mt-2 text-xs text-bad">{error}</p>}
      </div>
      <div className="flex items-center">
        <h2 className="flex-1 text-sm font-semibold">Webhooks</h2>
        <button type="button" onClick={onNewHook} className={`${buttonClass.primary} py-1 text-xs`}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New webhook
        </button>
      </div>
      {hooks.error && <ErrorLine text={hooks.error} />}
      {(hooks.data ?? hooks.last ?? []).length === 0 ? (
        <p className="text-sm text-muted">No webhooks on this source yet.</p>
      ) : (
        <ul className="space-y-2">
          {(hooks.data ?? hooks.last ?? []).map((h) => (
            <li key={h.id} className="rounded-xl border border-line bg-panel">
              <button type="button" onClick={() => setOpenHook(openHook === h.id ? null : h.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                <Icon name={openHook === h.id ? "down" : "right"} className="h-3.5 w-3.5 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{h.name}</span>
                  <span className="block text-xs text-muted">
                    {h.api_name} · {h.calls.map((c) => `${c.method} /${c.path.replace(/^\//, "")}`).join(" → ")}
                  </span>
                </span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${h.kind === "write" ? "bg-warn/15 text-warn" : "bg-ok/15 text-ok"}`}>{h.kind === "write" ? "Write API" : "Read API"}</span>
                {h.function && <span className="rounded bg-ocean/15 px-1.5 py-0.5 text-[10px] text-ocean">function</span>}
                {h.last && <RunStatus status={h.last.status} at={h.last.at} />}
              </button>
              {openHook === h.id && <HookDetail hook={h} onEdit={() => onEditHook(h)} onChanged={hooks.retry} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HookDetail({ hook, onEdit, onChanged }: { hook: Webhook; onEdit: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<"test" | "history">("test");
  const [nonce, setNonce] = useState(0);
  const history = useLoad(tab === "history" ? `history:${hook.id}:${nonce}` : null, () => webhooks.history(hook.id));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="border-t border-line p-4">
      <div className="mb-3 flex items-center gap-2">
        <Tabs value={tab} onChange={setTab} tabs={[{ id: "test", label: "Test" }, { id: "history", label: "History" }]} />
        <span className="flex-1" />
        <button type="button" onClick={onEdit} className={`${buttonClass.secondary} py-1 text-xs`}>
          <Icon name="edit" className="h-3.5 w-3.5" /> Edit
        </button>
        <button
          type="button"
          onClick={async () => {
            try {
              await webhooks.duplicate(hook.id);
              onChanged();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
          className={`${buttonClass.secondary} py-1 text-xs`}
        >
          <Icon name="copy" className="h-3.5 w-3.5" /> Duplicate
        </button>
        <button
          type="button"
          onClick={async () => {
            if (!(await confirmDialog(`Delete the webhook "${hook.name}"?`))) return;
            try {
              await webhooks.remove(hook.id);
              onChanged();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
          className="rounded p-1.5 text-muted hover:text-bad"
        >
          <Icon name="trash" className="h-4 w-4" />
        </button>
      </div>
      {error && <p className="mb-2 text-xs text-bad">{error}</p>}
      {hook.function && hook.source.api_name && (
        <p className="mb-3 text-xs text-muted">
          Published as the function <code className="text-soft">{`${hook.source.api_name}.${hook.api_name}`}</code>.
        </p>
      )}
      {tab === "test" ? (
        <TestRunner hook={hook} onRan={() => setNonce((n) => n + 1)} />
      ) : history.loading && !history.last ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : (
        <ul className="space-y-1.5">
          {(history.data ?? history.last ?? []).length === 0 && <li className="text-xs text-muted">No executions yet.</li>}
          {(history.data ?? history.last ?? []).map((h) => (
            <li key={h.id} className="rounded-md border border-line-2 p-2 text-xs">
              <div className="flex items-center gap-2">
                <RunStatus status={h.status} at={h.at} error={h.error} />
                <span className="text-muted">{h.duration_ms} ms</span>
                {h.changed_external && <span className="rounded bg-warn/15 px-1.5 text-[10px] text-warn">external system may have changed</span>}
                <span className="ml-auto truncate text-muted">{JSON.stringify(h.inputs)}</span>
              </div>
              {h.error && <div className="mt-1 break-words text-bad">{h.error}</div>}
              <div className="mt-1 text-muted">{h.calls.map((c) => `${c.method} → ${c.status}`).join(" · ")}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Runs a webhook with test inputs; shows outputs and each call's response. */
function TestRunner({ hook, onRan, onResponse }: { hook: Pick<Webhook, "id" | "inputs">; onRan?: () => void; onResponse?: (calls: CallTrace[]) => void }) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<WebhookResult | null>(null);
  const [error, setError] = useState<{ message: string; calls?: CallTrace[]; changed?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const values = Object.fromEntries(hook.inputs.map((p) => [p.id, inputs[p.id] ?? ""]).filter(([, v]) => v !== ""));
      const r = await executeWebhook(hook.id, values);
      setResult(r);
      onResponse?.(r.calls);
    } catch (e) {
      const err = e as Error & { calls?: CallTrace[]; changed?: boolean };
      setError({ message: err.message, calls: err.calls, changed: err.changed });
      if (err.calls) onResponse?.(err.calls);
    } finally {
      setBusy(false);
      onRan?.();
    }
  };
  const calls = result?.calls ?? error?.calls ?? [];
  return (
    <div className="space-y-3">
      {hook.inputs.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {hook.inputs.map((p) => (
            <Field key={p.id} label={`${p.id} · ${p.type}${p.required ? "" : " (optional)"}`}>
              {p.options.length ? (
                <select value={inputs[p.id] ?? ""} onChange={(e) => setInputs({ ...inputs, [p.id]: e.target.value })} className={inputClass}>
                  <option value="">Choose…</option>
                  {p.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={inputs[p.id] ?? ""}
                  onChange={(e) => setInputs({ ...inputs, [p.id]: e.target.value })}
                  placeholder={p.type === "List" ? '["a", "b"]' : p.type === "Record" ? '{"key": "value"}' : p.type === "Boolean" ? "true / false" : ""}
                  className={`${inputClass} font-mono text-xs`}
                />
              )}
            </Field>
          ))}
        </div>
      )}
      <button type="button" disabled={busy} onClick={run} className={`${buttonClass.primary} py-1 text-xs`}>
        <Icon name={busy ? "refresh" : "play"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Running…" : "Run webhook"}
      </button>
      {error && (
        <div className="rounded-md bg-bad/10 p-2 text-xs text-bad">
          {error.message}
          {error.changed !== undefined && <div className="mt-1 text-soft">{error.changed ? "The external system may have been changed." : "The external system was not changed."}</div>}
        </div>
      )}
      {result && (
        <div>
          <div className="mb-1 text-xs font-medium text-ok">Outputs · {result.ms} ms</div>
          <JsonBlock value={result.outputs} />
        </div>
      )}
      {calls.map((c) => (
        <div key={c.id}>
          <div className="mb-1 flex items-center gap-2 text-xs">
            <span className="font-medium text-soft">{c.id}</span>
            <span className="font-mono text-muted">
              {c.method} {c.url}
            </span>
            <span className={c.status < 400 ? "text-ok" : "text-bad"}>HTTP {c.status}</span>
            <span className="text-muted">{c.ms} ms</span>
          </div>
          <JsonBlock value={c.response} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- REST API source editor

function SourceEditor({ initial, onClose, onSaved }: { initial: RestSource | null; onClose: () => void; onSaved: (s: RestSource) => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [apiName, setApiName] = useState(initial?.api_name ?? "");
  const [domains, setDomains] = useState<RestDomain[]>(initial?.domains ?? [{ url: "https://", auth: "none" }]);
  const [creds, setCreds] = useState<Record<string, Record<string, string>>>({});
  const [secrets, setSecrets] = useState<[string, string][]>((initial?.secrets ?? []).map((s) => [s, ""]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setCred = (i: number, k: string, v: string) => setCreds({ ...creds, [i]: { ...(creds[i] ?? {}), [k]: v } });
  const isSet = (i: number, k: string) => initial?.credentials_set[String(i)]?.includes(k);

  const save = async () => {
    setBusy(true);
    setError(null);
    const kept = new Set(secrets.map(([k]) => k));
    const body = {
      name: name.trim(),
      api_name: apiName.trim() || null,
      domains,
      credentials: creds,
      secrets: Object.fromEntries(secrets.filter(([k]) => k.trim())),
      remove_secrets: (initial?.secrets ?? []).filter((s) => !kept.has(s)),
    };
    try {
      onSaved(initial ? await restSources.update(initial.id, body) : await restSources.create(body));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? `Edit ${initial.name}` : "New REST API source"} icon="globe" onClose={onClose} wide>
      <div className="max-h-[75vh] space-y-4 overflow-y-auto p-5 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dictionary API" className={inputClass} />
          </Field>
          <Field label="API name" hint="Used to call the source's webhooks from functions and code.">
            <input value={apiName} onChange={(e) => setApiName(e.target.value)} placeholder="DictionaryApi" className={`${inputClass} font-mono`} />
          </Field>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-soft">Domains</div>
          <p className="mb-2 text-xs text-muted">Webhook calls only reach these base URLs (their paths are relative to them). Keep credentials here, never in calls.</p>
          <div className="space-y-2">
            {domains.map((d, i) => (
              <div key={i} className="rounded-lg border border-line-2 p-3">
                <div className="flex items-center gap-2">
                  <input value={d.url} onChange={(e) => setDomains(domains.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} placeholder="https://api.example.com/v1" className={`${inputClass} flex-1 font-mono text-xs`} />
                  <select value={d.auth} onChange={(e) => setDomains(domains.map((x, j) => (j === i ? { ...x, auth: e.target.value as DomainAuth } : x)))} className={`${inputClass} w-56 text-xs`}>
                    {Object.entries(AUTH_LABEL).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  {domains.length > 1 && (
                    <button type="button" onClick={() => setDomains(domains.filter((_, j) => j !== i))} className="rounded p-1 text-muted hover:text-bad">
                      <Icon name="trash" className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {d.auth === "bearer" && <input type="password" value={creds[i]?.token ?? ""} onChange={(e) => setCred(i, "token", e.target.value)} placeholder={isSet(i, "token") ? "Token saved — leave empty to keep" : "Token"} className={`${inputClass} text-xs`} />}
                  {d.auth === "basic" && (
                    <>
                      <input value={creds[i]?.username ?? ""} onChange={(e) => setCred(i, "username", e.target.value)} placeholder={isSet(i, "username") ? "Username saved" : "Username"} className={`${inputClass} text-xs`} />
                      <input type="password" value={creds[i]?.password ?? ""} onChange={(e) => setCred(i, "password", e.target.value)} placeholder={isSet(i, "password") ? "Password saved — leave empty to keep" : "Password"} className={`${inputClass} text-xs`} />
                    </>
                  )}
                  {(d.auth === "api_key_header" || d.auth === "api_key_query") && (
                    <>
                      <input value={d.key_name ?? ""} onChange={(e) => setDomains(domains.map((x, j) => (j === i ? { ...x, key_name: e.target.value } : x)))} placeholder={d.auth === "api_key_header" ? "Header name, e.g. X-API-Key" : "Query parameter, e.g. api_key"} className={`${inputClass} font-mono text-xs`} />
                      <input type="password" value={creds[i]?.api_key ?? ""} onChange={(e) => setCred(i, "api_key", e.target.value)} placeholder={isSet(i, "api_key") ? "Key saved — leave empty to keep" : "API key"} className={`${inputClass} text-xs`} />
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setDomains([...domains, { url: "https://", auth: "none" }])} className={`${buttonClass.ghost} mt-1 text-xs`}>
            <Icon name="plus" className="h-3 w-3" /> Add domain
          </button>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-soft">Additional secrets</div>
          <p className="mb-2 text-xs text-muted">Referenced in calls as {"{{secret.NAME}}"} (a client secret for a token endpoint, for example). Saved values are never shown; leave a value empty to keep it.</p>
          <PairsEditor value={secrets} onChange={setSecrets} keyLabel="NAME" valueLabel="value (hidden after saving)" add="Add secret" />
        </div>
        {error && <ErrorLine text={error} />}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={busy || !name.trim()} onClick={save} className={buttonClass.primary}>
            <Icon name="save" className="h-3.5 w-3.5" /> {busy ? "Saving…" : "Save source"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- webhook editor

const newCall = (n: number): WebhookCall => ({ id: `call${n}`, method: "GET", domain: 0, path: "", query: [], headers: [], body_type: "none", body: "", form: [], read_only: null });

/** Every key path in a JSON value (for picking outputs from a test response). */
function keyPaths(v: unknown, prefix: string[] = [], out: string[][] = [], depth = 0): string[][] {
  if (depth > 5 || out.length > 200) return out;
  if (Array.isArray(v)) {
    if (v.length) {
      out.push([...prefix, "0"]);
      keyPaths(v[0], [...prefix, "0"], out, depth + 1);
    }
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push([...prefix, k]);
      keyPaths(x, [...prefix, k], out, depth + 1);
    }
  }
  return out;
}

const typeOf = (v: unknown): WebhookDef["outputs"][number]["type"] =>
  Array.isArray(v) ? "List" : v && typeof v === "object" ? "Record" : typeof v === "boolean" ? "Boolean" : typeof v === "number" ? (Number.isInteger(v) ? "Long" : "Double") : "String";

function WebhookEditor({ source, initial, onClose, onSaved }: { source: RestSource; initial?: Webhook; onClose: () => void; onSaved: (h: Webhook) => void }) {
  const [def, setDef] = useState<WebhookDef>(() =>
    initial
      ? {
          source_id: source.id,
          name: initial.name,
          api_name: initial.api_name,
          description: initial.description,
          inputs: initial.inputs,
          calls: initial.calls,
          outputs: initial.outputs,
          limits: initial.limits,
          store_responses: initial.store_responses,
          function: initial.function,
          retryable_status_codes: initial.retryable_status_codes ?? [],
        }
      : { source_id: source.id, name: "", api_name: "", description: "", inputs: [], calls: [newCall(1)], outputs: [], limits: { timeout_s: 20, concurrency: null, rate_count: null, rate_per: "minute" }, store_responses: true, function: false, retryable_status_codes: [] },
  );
  const [saved, setSaved] = useState<Webhook | undefined>(initial);
  const [step, setStep] = useState<"config" | "test">("config");
  const [curl, setCurl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [responses, setResponses] = useState<CallTrace[]>([]);
  const set = (patch: Partial<WebhookDef>) => setDef({ ...def, ...patch });
  const setCall = (i: number, patch: Partial<WebhookCall>) => set({ calls: def.calls.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const safe = (c: WebhookCall) => (c.read_only ?? ["GET", "HEAD", "OPTIONS"].includes(c.method));
  const writes = def.calls.filter((c) => !safe(c)).length;

  const save = async (then: "close" | "test") => {
    setBusy(true);
    setError(null);
    try {
      const h = saved ? await webhooks.update(saved.id, def) : await webhooks.create(def);
      setSaved(h);
      if (then === "close") onSaved(h);
      else setStep("test");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? `Edit ${initial.name}` : `New webhook on ${source.name}`} icon="link" onClose={onClose} wide>
      <div className="max-h-[80vh] overflow-y-auto p-5 text-sm">
        <Tabs value={step} onChange={(s) => (s === "test" && !saved ? save("test") : setStep(s))} tabs={[{ id: "config", label: "Configure" }, { id: "test", label: "Test and outputs" }]} />
        {step === "config" ? (
          <div className="mt-4 space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name" required>
                <input value={def.name} onChange={(e) => set({ name: e.target.value })} placeholder="Create item" className={inputClass} />
              </Field>
              <Field label="API name" required hint="Unique within the source; how functions call it.">
                <input value={def.api_name} onChange={(e) => set({ api_name: e.target.value })} placeholder="createItem" className={`${inputClass} font-mono`} />
              </Field>
            </div>
            <Field label="Description">
              <input value={def.description} onChange={(e) => set({ description: e.target.value })} className={inputClass} />
            </Field>
            <section>
              <div className="mb-1 text-xs font-medium text-soft">Input parameters</div>
              <p className="mb-2 text-xs text-muted">Reference them anywhere in a call as {"{{id}}"}, or {"{{json id}}"} for the value as JSON (strings quoted and escaped).</p>
              <div className="space-y-1.5">
                {def.inputs.map((p, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input value={p.id} onChange={(e) => set({ inputs: def.inputs.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)) })} placeholder="id" className={`${inputClass} w-40 py-1 font-mono text-xs`} />
                    <select value={p.type} onChange={(e) => set({ inputs: def.inputs.map((x, j) => (j === i ? { ...x, type: e.target.value as typeof p.type } : x)) })} className={`${inputClass} w-32 py-1 text-xs`}>
                      {INPUT_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                    {p.type === "String" && (
                      <input
                        value={p.options.join(", ")}
                        onChange={(e) => set({ inputs: def.inputs.map((x, j) => (j === i ? { ...x, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : x)) })}
                        placeholder="allowed values (optional, comma-separated)"
                        className={`${inputClass} flex-1 py-1 text-xs`}
                      />
                    )}
                    <label className="flex items-center gap-1 text-xs text-muted">
                      <input type="checkbox" checked={p.required} onChange={(e) => set({ inputs: def.inputs.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })} /> required
                    </label>
                    <button type="button" onClick={() => set({ inputs: def.inputs.filter((_, j) => j !== i) })} className="rounded p-1 text-muted hover:text-bad">
                      <Icon name="trash" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <button type="button" onClick={() => set({ inputs: [...def.inputs, { id: `param${def.inputs.length + 1}`, type: "String", required: true, options: [], description: "" }] })} className={`${buttonClass.ghost} py-0.5 text-xs`}>
                  <Icon name="plus" className="h-3 w-3" /> Add input
                </button>
              </div>
            </section>
            <section>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-medium text-soft">Calls</span>
                <span className="text-xs text-muted">run in order; reference an earlier response as {"{{callId.key.0.key}}"}</span>
                <span className="flex-1" />
                <button type="button" onClick={() => setCurl("")} className={`${buttonClass.ghost} py-0.5 text-xs`}>
                  <Icon name="code" className="h-3 w-3" /> Import from cURL
                </button>
              </div>
              {writes > 1 && <p className="mb-2 rounded bg-warn/10 p-2 text-xs text-warn">At most one call may change the external system. Mark token or search calls as read-only.</p>}
              {curl !== null && (
                <div className="mb-3 rounded-lg border border-line-2 p-3">
                  <textarea value={curl} onChange={(e) => setCurl(e.target.value)} rows={3} placeholder={`curl -X POST '${source.domains[0]?.url ?? "https://api"}/items' -H 'Content-Type: application/json' -d '{"title": "x"}'`} className={`${inputClass} font-mono text-xs`} />
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const c = await webhooks.importCurl(source.id, curl);
                          set({ calls: [...def.calls.filter((x) => x.path || x.body), { ...newCall(def.calls.length + 1), ...c, id: `call${def.calls.length + 1}`, read_only: null }] });
                          setCurl(null);
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                      className={`${buttonClass.primary} py-1 text-xs`}
                    >
                      Import cURL
                    </button>
                    <button type="button" onClick={() => setCurl(null)} className={`${buttonClass.secondary} py-1 text-xs`}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              <div className="space-y-3">
                {def.calls.map((c, i) => (
                  <div key={i} className="rounded-lg border border-line-2 p-3">
                    <div className="flex items-center gap-1.5">
                      <input value={c.id} onChange={(e) => setCall(i, { id: e.target.value })} className={`${inputClass} w-24 py-1 font-mono text-xs`} title="Call id" />
                      <select value={c.method} onChange={(e) => setCall(i, { method: e.target.value as WebhookCall["method"] })} className={`${inputClass} w-24 py-1 text-xs`}>
                        {METHODS.map((m) => (
                          <option key={m}>{m}</option>
                        ))}
                      </select>
                      {source.domains.length > 1 ? (
                        <select value={c.domain} onChange={(e) => setCall(i, { domain: Number(e.target.value) })} className={`${inputClass} w-48 py-1 text-xs`}>
                          {source.domains.map((d, j) => (
                            <option key={j} value={j}>
                              {d.url}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="max-w-[14rem] truncate font-mono text-xs text-muted">{source.domains[0]?.url}/</span>
                      )}
                      <input value={c.path} onChange={(e) => setCall(i, { path: e.target.value })} placeholder="items/{{id}}" className={`${inputClass} flex-1 py-1 font-mono text-xs`} />
                      {def.calls.length > 1 && (
                        <button type="button" onClick={() => set({ calls: def.calls.filter((_, j) => j !== i) })} className="rounded p-1 text-muted hover:text-bad">
                          <Icon name="trash" className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="mt-2 grid gap-3 md:grid-cols-2">
                      <div>
                        <div className="mb-1 text-[11px] text-muted">Query parameters</div>
                        <PairsEditor value={c.query} onChange={(query) => setCall(i, { query })} add="Add parameter" />
                      </div>
                      <div>
                        <div className="mb-1 text-[11px] text-muted">Headers</div>
                        <PairsEditor value={c.headers} onChange={(headers) => setCall(i, { headers })} add="Add header" />
                      </div>
                    </div>
                    {!["GET", "HEAD", "OPTIONS"].includes(c.method) && (
                      <div className="mt-2">
                        <div className="mb-1 flex items-center gap-2">
                          <span className="text-[11px] text-muted">Body</span>
                          <select value={c.body_type} onChange={(e) => setCall(i, { body_type: e.target.value as WebhookCall["body_type"] })} className={`${inputClass} w-44 py-0.5 text-xs`}>
                            {BODY_TYPES.map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.label}
                              </option>
                            ))}
                          </select>
                          <label className="ml-auto flex items-center gap-1 text-xs text-muted" title="A request that does not change the external system (token endpoint, search) — the webhook may then make another write call">
                            <input type="checkbox" checked={!!c.read_only} onChange={(e) => setCall(i, { read_only: e.target.checked || null })} /> read-only call
                          </label>
                        </div>
                        {c.body_type === "form" || c.body_type === "form_urlencoded" ? (
                          <PairsEditor value={c.form} onChange={(form) => setCall(i, { form })} add="Add field" />
                        ) : c.body_type !== "none" ? (
                          <textarea value={c.body} onChange={(e) => setCall(i, { body: e.target.value })} rows={4} placeholder={c.body_type === "json" ? '{"title": {{json title}}, "count": {{count}}}' : ""} className={`${inputClass} font-mono text-xs`} />
                        ) : null}
                      </div>
                    )}
                  </div>
                ))}
                <button type="button" onClick={() => set({ calls: [...def.calls, newCall(def.calls.length + 1)] })} className={`${buttonClass.ghost} py-0.5 text-xs`}>
                  <Icon name="plus" className="h-3 w-3" /> Add call
                </button>
              </div>
            </section>
            <section className="grid gap-3 md:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-medium text-soft">Limits</div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <Field label="Time limit (seconds)" hint="Default 20, at most 180.">
                    <input type="number" min={1} max={180} value={def.limits.timeout_s} onChange={(e) => set({ limits: { ...def.limits, timeout_s: Math.max(1, Math.min(180, Number(e.target.value) || 20)) } })} className={inputClass} />
                  </Field>
                  <Field label="Concurrency limit">
                    <input type="number" min={1} value={def.limits.concurrency ?? ""} onChange={(e) => set({ limits: { ...def.limits, concurrency: e.target.value ? Number(e.target.value) : null } })} placeholder="none" className={inputClass} />
                  </Field>
                  <Field label="Rate limit">
                    <input type="number" min={1} value={def.limits.rate_count ?? ""} onChange={(e) => set({ limits: { ...def.limits, rate_count: e.target.value ? Number(e.target.value) : null } })} placeholder="none" className={inputClass} />
                  </Field>
                  <Field label="per">
                    <select value={def.limits.rate_per} onChange={(e) => set({ limits: { ...def.limits, rate_per: e.target.value as WebhookDef["limits"]["rate_per"] } })} className={inputClass}>
                      {["second", "minute", "hour", "day"].map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </Field>
                </div>
              </div>
              <div className="space-y-3">
                <div className="mb-1 text-xs font-medium text-soft">Storage and publishing</div>
                <Switch on={def.store_responses} onChange={(store_responses) => set({ store_responses })} label="Store responses in the history" hint="Turn off for webhooks that return sensitive data, such as tokens." />
                <Switch
                  on={def.function}
                  disabled={!!initial?.function}
                  onChange={(fn) => set({ function: fn })}
                  label="Publish as a function"
                  hint={source.api_name ? `Callable as ${source.api_name}.${def.api_name || "apiName"} — this cannot be undone.` : "Give the source an API name first."}
                />
                <Field label="Retry on status codes" hint="e.g. 429, 503 — retried up to twice within the time limit.">
                  <input
                    value={def.retryable_status_codes.join(", ")}
                    onChange={(e) => set({ retryable_status_codes: e.target.value.split(",").map((s) => Number(s.trim())).filter((n) => n >= 100 && n < 600) })}
                    className={inputClass}
                  />
                </Field>
              </div>
            </section>
          </div>
        ) : (
          <div className="mt-4 space-y-5">
            {saved && <TestRunner hook={{ id: saved.id, inputs: def.inputs }} onResponse={setResponses} />}
            <section>
              <div className="mb-1 text-xs font-medium text-soft">Output parameters</div>
              <p className="mb-2 text-xs text-muted">Values taken from a call&apos;s JSON response (by keys and list indexes), returned when the webhook runs. Run a test to pick them from the response.</p>
              <div className="space-y-1.5">
                {def.outputs.map((o, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input value={o.id} onChange={(e) => set({ outputs: def.outputs.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)) })} className={`${inputClass} w-36 py-1 font-mono text-xs`} />
                    <select value={o.type} onChange={(e) => set({ outputs: def.outputs.map((x, j) => (j === i ? { ...x, type: e.target.value as typeof o.type } : x)) })} className={`${inputClass} w-28 py-1 text-xs`}>
                      {OUTPUT_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                    <select value={o.call} onChange={(e) => set({ outputs: def.outputs.map((x, j) => (j === i ? { ...x, call: e.target.value } : x)) })} className={`${inputClass} w-28 py-1 text-xs`}>
                      {def.calls.map((c) => (
                        <option key={c.id}>{c.id}</option>
                      ))}
                    </select>
                    <input
                      value={o.path.join(".")}
                      onChange={(e) => set({ outputs: def.outputs.map((x, j) => (j === i ? { ...x, path: e.target.value ? e.target.value.split(".") : [] } : x)) })}
                      placeholder="results.unique_id (empty: whole response)"
                      className={`${inputClass} flex-1 py-1 font-mono text-xs`}
                    />
                    <button type="button" onClick={() => set({ outputs: def.outputs.filter((_, j) => j !== i) })} className="rounded p-1 text-muted hover:text-bad">
                      <Icon name="trash" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <button type="button" onClick={() => set({ outputs: [...def.outputs, { id: `output${def.outputs.length + 1}`, type: "String", call: def.calls[def.calls.length - 1].id, path: [] }] })} className={`${buttonClass.ghost} py-0.5 text-xs`}>
                  <Icon name="plus" className="h-3 w-3" /> Add output
                </button>
              </div>
              {responses.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1 text-[11px] text-muted">Suggested from the test response — click to add</div>
                  <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
                    {responses.flatMap((r) =>
                      keyPaths(r.response).map((p) => {
                        const value = p.reduce<unknown>((v, k) => (Array.isArray(v) ? v[Number(k)] : v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), r.response);
                        return (
                          <button
                            key={`${r.id}:${p.join(".")}`}
                            type="button"
                            onClick={() => set({ outputs: [...def.outputs, { id: p[p.length - 1].replace(/[^\w]/g, "_").replace(/^(\d)/, "_$1"), type: typeOf(value), call: r.id, path: p }] })}
                            className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-soft ring-1 ring-line-2 hover:text-white"
                          >
                            {r.id}.{p.join(".")}
                          </button>
                        );
                      }),
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
        {error && <div className="mt-4"><ErrorLine text={error} /></div>}
        <div className="mt-5 flex items-center justify-end gap-2">
          {saved && <span className="mr-auto text-xs text-muted">Saved {when(saved.updated_at)}{saved.function && source.api_name ? <> · function <CopyText text={`${source.api_name}.${saved.api_name}`} className="inline-flex" /></> : null}</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Close
          </button>
          {step === "config" && (
            <button type="button" disabled={busy || !def.name.trim() || !def.api_name.trim()} onClick={() => save("test")} className={buttonClass.secondary}>
              Save and test
            </button>
          )}
          <button type="button" disabled={busy || !def.name.trim() || !def.api_name.trim()} onClick={() => save("close")} className={buttonClass.primary}>
            <Icon name="save" className="h-3.5 w-3.5" /> {busy ? "Saving…" : "Save webhook"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
