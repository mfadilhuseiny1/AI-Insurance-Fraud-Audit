"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { AppHeader, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { agentsApi, TOOL_LABEL, type Agent, type ChatMessage, type Citation, type Session, type SessionSummary } from "@/lib/agents";
import { when } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import { ontology, type ActionType, type LlmModel, type LogicFunction, type ObjectType } from "@/lib/ontology";
import { confirmDialog } from "@/lib/dialogs";

type Side = "sessions" | "config";

export default function AgentPage() {
  const { id } = useParams<{ id: string }>();
  const editing = useSearchParams().get("edit");
  const [side, setSide] = useState<Side>(editing ? "config" : "sessions");
  const [agent, setAgent] = useState<Agent | null>(null);
  const [draft, setDraft] = useState<Agent | null>(null);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [actions, setActions] = useState<ActionType[]>([]);
  const [fns, setFns] = useState<LogicFunction[]>([]);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [info, setInfo] = useState(true);

  const loadSessions = useCallback(() => agentsApi.sessions(id).then(setSessions).catch(() => {}), [id]);
  useEffect(() => {
    Promise.all([agentsApi.get(id), ontology.objectTypes(), ontology.actionTypes(), ontology.logicList(), ontology.models().catch(() => [])])
      .then(([a, t, ac, f, m]) => {
        setAgent(a);
        setDraft(a);
        setTypes(t);
        setActions(ac);
        setFns(f);
        setModels(m);
      })
      .catch((e: Error) => setError(e.message));
    loadSessions();
  }, [id, loadSessions]);

  const dirty = !!agent && !!draft && JSON.stringify(agent) !== JSON.stringify(draft);
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { name, description, model, instructions, contexts, tools, citations, temperature, starters } = draft;
      const s = await agentsApi.save(id, { name, description, model, instructions, contexts, tools, citations, temperature, starters });
      setAgent(s);
      setDraft(s);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error) return <ApiError message={error} />;
  if (!agent || !draft) return <Loading />;
  const typeById = Object.fromEntries(types.map((t) => [t.id, t]));
  const modelLabel = models.find((m) => m.id === agent.model)?.label ?? agent.model;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="AIP Agent Studio" icon="sparkle" href="/agents" crumbs={[{ label: agent.name }]}>
        {saveError && <span className="max-w-sm truncate text-xs text-bad" title={saveError}>{saveError}</span>}
        <span className="text-xs text-muted">{dirty ? "Unsaved changes" : "Saved"}</span>
        <button type="button" onClick={save} disabled={!dirty || saving} className={buttonClass.primary}>
          <Icon name="save" className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Save"}
        </button>
      </AppHeader>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2">
          {(
            [
              ["sessions", "Session history", "history"],
              ["config", "Agent configuration", "sliders"],
            ] as [Side, string, IconName][]
          ).map(([k, label, icon]) => (
            <button
              key={k}
              type="button"
              title={label}
              onClick={() => setSide(k)}
              className={`rounded-md p-2 ${side === k ? "bg-ocean/15 text-ocean ring-1 ring-ocean/30" : "text-muted hover:bg-panel-2 hover:text-white"}`}
            >
              <Icon name={icon} className="h-4 w-4" />
            </button>
          ))}
        </nav>

        <aside className="flex w-[360px] shrink-0 flex-col border-r border-line bg-panel">
          {side === "sessions" ? (
            <Sessions
              sessions={sessions}
              active={session?.id}
              onOpen={(sid) => agentsApi.session(id, sid).then(setSession)}
              onNew={() => setSession(null)}
              onDelete={async (sid) => {
                await agentsApi.deleteSession(id, sid);
                if (session?.id === sid) setSession(null);
                loadSessions();
              }}
            />
          ) : (
            <Config draft={draft} onChange={setDraft} types={types} actions={actions} fns={fns} models={models} />
          )}
        </aside>

        <Chat
          agent={agent}
          dirty={dirty}
          session={session}
          onSession={(s) => {
            setSession(s);
            loadSessions();
          }}
          showInfo={!info ? () => setInfo(true) : undefined}
        />

        {info && (
          <aside className="w-72 shrink-0 overflow-y-auto border-l border-line bg-panel text-sm">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <Icon name="sparkle" className="h-4 w-4 text-ocean" />
              <span className="flex-1 truncate font-semibold">{agent.name}</span>
              <button type="button" onClick={() => setInfo(false)} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white" aria-label="Close">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="border-b border-line p-4">
              <div className="mb-1 text-xs font-semibold text-soft">Model</div>
              <div className="flex items-center gap-2">
                <Icon name="cpu" className="h-3.5 w-3.5 text-muted" /> {modelLabel}
              </div>
            </div>
            <div className="p-4">
              <div className="mb-2 text-xs font-semibold text-soft">Contexts</div>
              {agent.contexts.length === 0 && <p className="text-xs text-muted">No ontology context. Add object types in the configuration.</p>}
              {agent.contexts.length > 0 && (
                <div className="rounded-lg bg-panel-2 p-3 ring-1 ring-line-2">
                  <div className="font-medium">Nexus</div>
                  {agent.contexts.map((c) => (
                    <div key={c.object_type_id} className="mt-2">
                      <div className="text-[11px] text-muted">{c.mode === "full" ? "Full object retrieval" : "Tool retrieval"}</div>
                      <Link href={`/ontology/${c.object_type_id}?tab=objects`} className="flex items-center gap-1.5 text-ocean hover:underline">
                        <Icon name="cube" className="h-3.5 w-3.5" /> {typeById[c.object_type_id]?.display_name ?? "(deleted)"}
                      </Link>
                    </div>
                  ))}
                </div>
              )}
              {(agent.tools.actions.length > 0 || agent.tools.logic.length > 0) && (
                <>
                  <div className="mb-2 mt-4 text-xs font-semibold text-soft">Tools</div>
                  <ul className="space-y-1 text-xs text-soft">
                    {agent.tools.actions.map((a) => (
                      <li key={a} className="flex items-center gap-1.5">
                        <Icon name="edit" className="h-3 w-3 text-ok" /> {actions.find((x) => x.id === a)?.display_name}
                      </li>
                    ))}
                    {agent.tools.logic.map((f) => (
                      <li key={f} className="flex items-center gap-1.5">
                        <Icon name="logic" className="h-3 w-3 text-ocean" /> {fns.find((x) => x.id === f)?.name}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function Sessions({
  sessions,
  active,
  onOpen,
  onNew,
  onDelete,
}: {
  sessions: SessionSummary[];
  active?: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const shown = sessions.filter((s) => !q || s.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold">
        <span className="flex-1">Session history</span>
        <button type="button" onClick={onNew} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-white" title="New conversation">
          <Icon name="plus" className="h-4 w-4" />
        </button>
      </div>
      <div className="p-3">
        <div className="flex items-center gap-2 rounded-full border border-line-2 bg-ink px-3">
          <Icon name="search" className="h-3.5 w-3.5 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-full bg-transparent py-1.5 text-sm outline-none" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="px-2 pb-1 text-[11px] text-muted">Recent</div>
        {shown.length === 0 && <p className="px-2 text-xs text-muted">No conversations yet.</p>}
        {shown.map((s) => (
          <div key={s.id} className={`group flex items-start gap-2 rounded-md px-2 py-2 ${active === s.id ? "bg-ocean/15 ring-1 ring-ocean/30" : "hover:bg-panel-2"}`}>
            <button type="button" onClick={() => onOpen(s.id)} className="flex min-w-0 flex-1 items-start gap-2 text-left">
              <Icon name="comment" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="min-w-0">
                <span className="block truncate text-sm">{s.title}</span>
                <span className="block text-[11px] text-muted">{when(s.updated_at)}</span>
              </span>
            </button>
            <button
              type="button"
              onClick={async () => (await confirmDialog("Delete this conversation?")) && onDelete(s.id)}
              className="rounded p-1 text-muted opacity-0 hover:text-bad group-hover:opacity-100"
              aria-label="Delete"
            >
              <Icon name="trash" className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-4">
      <div className="mb-1 text-sm font-semibold">{title}</div>
      {hint && <p className="mb-3 text-xs text-muted">{hint}</p>}
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-soft">
      {label}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-ocean" : "bg-line-2"}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
      </button>
    </label>
  );
}

function Config({
  draft,
  onChange,
  types,
  actions,
  fns,
  models,
}: {
  draft: Agent;
  onChange: (a: Agent) => void;
  types: ObjectType[];
  actions: ActionType[];
  fns: LogicFunction[];
  models: LlmModel[];
}) {
  const set = (c: Partial<Agent>) => onChange({ ...draft, ...c });
  const setTools = (c: Partial<Agent["tools"]>) => set({ tools: { ...draft.tools, ...c } });
  const unused = types.filter((t) => !draft.contexts.some((c) => c.object_type_id === t.id));
  const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <>
      <div className="border-b border-line px-4 py-3 text-sm font-semibold">Agent configuration</div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Overview">
          <Field label="Name">
            <input value={draft.name} onChange={(e) => set({ name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Description">
            <input value={draft.description} onChange={(e) => set({ description: e.target.value })} className={inputClass} />
          </Field>
        </Section>
        <Section title="Model">
          <select value={draft.model} onChange={(e) => set({ model: e.target.value })} className={inputClass}>
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.available}>
                {m.label} · {m.vendor}
                {m.available ? "" : " (no API key)"}
              </option>
            ))}
          </select>
          <Field label={`Temperature · ${draft.temperature}`}>
            <input type="range" min={0} max={1} step={0.1} value={draft.temperature} onChange={(e) => set({ temperature: Number(e.target.value) })} className="w-full accent-[var(--color-ocean)]" />
          </Field>
        </Section>
        <Section title="System prompt" hint="Instructions the agent follows in every conversation.">
          <textarea
            rows={6}
            value={draft.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            placeholder="You help relationship managers understand their customers. Answer briefly, with numbers formatted with thousands separators."
            className={`${inputClass} text-xs`}
          />
        </Section>
        <Section title="Retrieval context" hint="Give your agent ontology data with every message.">
          {draft.contexts.map((c, i) => {
            const t = types.find((x) => x.id === c.object_type_id);
            return (
              <div key={c.object_type_id} className="rounded-lg border border-line-2 bg-panel-2 p-3">
                <div className="flex items-center gap-2 text-sm">
                  <Icon name="cube" className="h-4 w-4 text-ocean" />
                  <span className="flex-1 truncate font-medium">{t?.display_name ?? "(deleted)"}</span>
                  <span className="text-xs text-muted">{t?.object_count ?? 0} objects</span>
                  <button type="button" onClick={() => set({ contexts: draft.contexts.filter((_, j) => j !== i) })} className="rounded p-1 text-muted hover:text-bad" aria-label="Remove">
                    <Icon name="x" className="h-3.5 w-3.5" />
                  </button>
                </div>
                <select
                  value={c.mode}
                  onChange={(e) => set({ contexts: draft.contexts.map((x, j) => (j === i ? { ...x, mode: e.target.value as "full" | "tools" } : x)) })}
                  className={`${inputClass} mt-2 text-xs`}
                >
                  <option value="full">Full object retrieval (all objects in the prompt)</option>
                  <option value="tools">Tool retrieval (schema only; search with tools)</option>
                </select>
              </div>
            );
          })}
          {unused.length > 0 && (
            <select value="" onChange={(e) => e.target.value && set({ contexts: [...draft.contexts, { object_type_id: e.target.value, mode: "full" }] })} className={inputClass}>
              <option value="">+ Add retrieval context…</option>
              {unused.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name}
                </option>
              ))}
            </select>
          )}
          {types.length === 0 && (
            <p className="text-xs text-muted">
              No object types yet —{" "}
              <Link href="/ontology" className="text-ocean hover:underline">
                create one in Nexus Manager
              </Link>
              .
            </p>
          )}
        </Section>
        <Section title="Tools" hint="Give your agent tools to iteratively achieve tasks.">
          <Toggle label="Search objects (filters, sort, text search)" checked={draft.tools.search} onChange={(search) => setTools({ search })} />
          <Toggle label="Aggregate (count, sum, average, min, max, group by)" checked={draft.tools.aggregate} onChange={(aggregate) => setTools({ aggregate })} />
          {types.some((t) => t.properties.some((p) => p.type === "vector")) && (
            <div>
              <div className="mb-1 text-xs font-medium text-soft">Nexus semantic search (by meaning, over embeddings)</div>
              {types
                .filter((t) => t.properties.some((p) => p.type === "vector"))
                .map((t) => {
                  const cur = (draft.tools.semantic ?? []).find((x) => x.object_type_id === t.id);
                  const others = (draft.tools.semantic ?? []).filter((x) => x.object_type_id !== t.id);
                  return (
                    <div key={t.id} className="flex flex-wrap items-center gap-2 py-0.5 text-sm">
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={!!cur} onChange={(e) => setTools({ semantic: e.target.checked ? [...others, { object_type_id: t.id, k: 5, mode: "hybrid" }] : others })} />
                        {t.display_name}
                      </label>
                      {cur && (
                        <>
                          <select value={cur.mode ?? "hybrid"} onChange={(e) => setTools({ semantic: [...others, { ...cur, mode: e.target.value as "hybrid" }] })} className="rounded border border-line-2 bg-ink px-1.5 py-0.5 text-xs">
                            <option value="hybrid">Hybrid (embeddings + keywords)</option>
                            <option value="semantic">Embeddings only</option>
                            <option value="keyword">Keywords only</option>
                          </select>
                          <input type="number" min={1} max={50} value={cur.k ?? 5} onChange={(e) => setTools({ semantic: [...others, { ...cur, k: Number(e.target.value) || 5 }] })} className="w-16 rounded border border-line-2 bg-ink px-1.5 py-0.5 text-xs" title="Results" />
                        </>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
          {actions.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium text-soft">Actions the agent may apply</div>
              {actions.map((a) => (
                <label key={a.id} className="flex items-center gap-2 py-0.5 text-sm text-soft">
                  <input type="checkbox" checked={draft.tools.actions.includes(a.id)} onChange={() => setTools({ actions: toggleIn(draft.tools.actions, a.id) })} className="accent-[var(--color-ocean)]" />
                  <Icon name="edit" className="h-3.5 w-3.5 text-ok" /> {a.display_name}
                </label>
              ))}
            </div>
          )}
          {fns.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium text-soft">AIP Logic functions</div>
              {fns.map((f) => (
                <label key={f.id} className="flex items-center gap-2 py-0.5 text-sm text-soft">
                  <input type="checkbox" checked={draft.tools.logic.includes(f.id)} onChange={() => setTools({ logic: toggleIn(draft.tools.logic, f.id) })} className="accent-[var(--color-ocean)]" />
                  <Icon name="logic" className="h-3.5 w-3.5 text-ocean" /> {f.name}
                </label>
              ))}
              {draft.tools.logic.length > 0 && (
                <div className="mt-2">
                  <Toggle label="Apply the edits Logic functions make" checked={draft.tools.apply_logic_edits} onChange={(apply_logic_edits) => setTools({ apply_logic_edits })} />
                </div>
              )}
            </div>
          )}
        </Section>
        <Section title="Citations" hint="Answers link to the objects they are based on.">
          <Toggle label="Enable citations" checked={draft.citations} onChange={(citations) => set({ citations })} />
        </Section>
        <Section title="Conversation starters" hint="Suggested questions shown in an empty conversation, one per line.">
          <textarea
            rows={3}
            value={draft.starters.join("\n")}
            onChange={(e) => set({ starters: e.target.value.split("\n") })}
            onBlur={() => set({ starters: draft.starters.map((s) => s.trim()).filter(Boolean) })}
            className={`${inputClass} text-xs`}
          />
        </Section>
      </div>
    </>
  );
}

/** Markdown with [[Type:pk]] citations turned into chips that open the object type. */
function Answer({ text, citations }: { text: string; citations: Citation[] }) {
  const html = useMemo(() => {
    const marks: string[] = [];
    const src = text.replace(/\[\[([A-Za-z][A-Za-z0-9_]*):([^\]\n]{1,200})\]\]/g, (m, type: string, pk: string) => {
      marks.push(`${type}:${pk.trim()}`);
      return `CITE${marks.length - 1}`;
    });
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return renderMarkdown(src).replace(/CITE(\d+)/g, (_, i: string) => {
      const [type, ...rest] = marks[Number(i)].split(":");
      const pk = rest.join(":");
      const c = citations.find((x) => x.object_type === type && x.primary_key === pk);
      if (!c) return "";
      return `<a href="/ontology/${encodeURIComponent(c.object_type_id)}?tab=objects" title="${esc(`${c.type_name} · ${c.primary_key}`)}" class="cite">${Number(i) + 1} · ${esc(c.title.slice(0, 24))}</a>`;
    });
  }, [text, citations]);
  return <div className="md-body agent-answer text-sm leading-relaxed text-soft" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Steps({ msg }: { msg: ChatMessage }) {
  if (!msg.steps?.length) return null;
  return (
    <details className="mb-2 text-xs">
      <summary className="flex cursor-pointer items-center gap-1.5 text-muted hover:text-white">
        <Icon name="list" className="h-3.5 w-3.5" /> Used {msg.steps.length} tool{msg.steps.length === 1 ? "" : "s"}
        {msg.ms ? ` · ${(msg.ms / 1000).toFixed(1)} s` : ""}
      </summary>
      <div className="mt-2 space-y-1.5">
        {msg.steps.map((s, i) => (
          <details key={i} className="rounded-md border border-line bg-ink">
            <summary className="flex cursor-pointer items-center gap-2 px-2 py-1">
              <span className={s.ok ? "text-ok" : "text-bad"}>{s.ok ? "✓" : "✕"}</span>
              <span className="text-soft">{TOOL_LABEL[s.tool] ?? s.tool}</span>
              <span className="truncate font-mono text-muted">{JSON.stringify(s.arguments)}</span>
            </summary>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all border-t border-line p-2 font-mono text-[11px] text-muted">{s.result}</pre>
          </details>
        ))}
      </div>
    </details>
  );
}

function Chat({
  agent,
  dirty,
  session,
  onSession,
  showInfo,
}: {
  agent: Agent;
  dirty: boolean;
  session: Session | null;
  onSession: (s: Session) => void;
  showInfo?: () => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const messages = session?.messages ?? [];

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending]);

  const send = async (content: string) => {
    content = content.trim();
    if (!content || pending) return;
    setPending(content);
    setText("");
    setError(null);
    try {
      const s = session ?? (await agentsApi.newSession(agent.id));
      const reply = await agentsApi.send(agent.id, s.id, content);
      const now = new Date().toISOString();
      onSession({ ...s, title: s.messages.length ? s.title : content.slice(0, 80), messages: [...s.messages, { role: "user", content, at: now }, reply] });
    } catch (e) {
      setError((e as Error).message);
      setText(content);
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-ink">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 text-xs text-muted">
        {dirty && <span className="text-warn">Save the configuration to chat with your changes</span>}
        <span className="ml-auto" />
        {showInfo && (
          <button type="button" onClick={showInfo} className="rounded p-1 hover:bg-panel-2 hover:text-white" title="Agent details">
            <Icon name="info" className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
          {messages.length === 0 && !pending && (
            <div className="flex flex-col items-center py-20 text-center">
              <Icon name="sparkle" className="mb-2 h-6 w-6 text-muted" />
              <div className="text-lg font-semibold text-soft">{agent.name}</div>
              {agent.description && <p className="mt-1 max-w-md text-sm text-muted">{agent.description}</p>}
              {agent.starters.length > 0 && (
                <div className="mt-6 flex max-w-xl flex-wrap justify-center gap-2">
                  {agent.starters.map((s) => (
                    <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-line-2 bg-panel px-3 py-1.5 text-sm text-soft hover:border-ocean/60 hover:text-white">
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-xl bg-panel-2 px-4 py-2.5 text-sm ring-1 ring-line-2">{m.content}</div>
              </div>
            ) : (
              <div key={i}>
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  <Icon name="sparkle" className="h-3.5 w-3.5" /> {agent.name}
                </div>
                <Steps msg={m} />
                {m.error ? <ErrorBox message={m.error} /> : <Answer text={m.content} citations={m.citations ?? []} />}
                {!!m.citations?.length && (
                  <details className="mt-2 text-xs text-muted">
                    <summary className="cursor-pointer hover:text-white">Sources ({m.citations.length})</summary>
                    <ul className="mt-1 space-y-0.5">
                      {m.citations.map((c, j) => (
                        <li key={j}>
                          <Link href={`/ontology/${c.object_type_id}?tab=objects`} className="text-ocean hover:underline">
                            {c.type_name} · {c.title}
                          </Link>{" "}
                          <span className="font-mono">{c.primary_key}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <button type="button" onClick={() => navigator.clipboard.writeText(m.content)} className="mt-1 rounded p-1 text-muted hover:bg-panel-2 hover:text-white" title="Copy">
                  <Icon name="copy" className="h-3.5 w-3.5" />
                </button>
              </div>
            ),
          )}
          {pending && (
            <>
              <div className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-xl bg-panel-2 px-4 py-2.5 text-sm ring-1 ring-line-2">{pending}</div>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted">
                <Icon name="refresh" className="h-4 w-4 animate-spin" /> Retrieving context…
              </div>
            </>
          )}
          <div ref={bottom} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-6 pb-4">
        <ErrorBox message={error} />
        <div className="mt-2 rounded-xl border border-line-2 bg-panel p-2 focus-within:border-ocean">
          <textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
            placeholder="Ask a question…"
            className="w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted"
          />
          <div className="flex items-center justify-end">
            <button type="button" onClick={() => send(text)} disabled={!text.trim() || !!pending} className="rounded-md p-1.5 text-ocean hover:bg-panel-2 disabled:opacity-30" aria-label="Send">
              <Icon name="right" className="h-4 w-4" />
            </button>
          </div>
        </div>
        <p className="mt-1 text-center text-[11px] text-muted">Answers are generated by {agent.model}; check important numbers against the cited objects.</p>
      </div>
    </section>
  );
}
