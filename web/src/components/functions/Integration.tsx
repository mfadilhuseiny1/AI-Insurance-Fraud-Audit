"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api } from "@/lib/api";
import { functionIntegration, type CreatedLogic, type IntegratedFunction, type LogicTemplate } from "@/lib/functionIntegration";
import { ontology, type ObjectType } from "@/lib/ontology";
import { renderMarkdown } from "@/lib/markdown";

/* Function integration: business logic as functions, from a template or a description (AIP), published and put to
   work in the apps — action rules, Workshop, Pipeline Builder, Automate, the API gateway. The guide, the "New business
   logic" flow and where every published function is used. */

const STEPS: { n: number; title: string; icon: IconName; body: string }[] = [
  { n: 1, title: "Write", icon: "code", body: "Start from a business-logic template on your Nexus object type, or describe the rule and let AIP write it." },
  { n: 2, title: "Test", icon: "play", body: "Run it on real objects in Live preview or the function's Run tab before anyone depends on it." },
  { n: 3, title: "Publish", icon: "upload", body: "A release (0.1.0, 1.0.0…) makes it callable; breaking changes are caught between versions." },
  { n: 4, title: "Use in apps", icon: "layers", body: "Action rules, Workshop widgets and columns, Pipeline Builder row by row, Automate conditions, the API gateway." },
];

const USE_HREF: Record<string, (u: { id?: string; link?: string }) => string | undefined> = {
  action_type: (u) => (u.id ? `/ontology/action-types/${u.id}` : undefined),
  automation: (u) => (u.id ? `/automate/${u.id}` : undefined),
  workshop: (u) => (u.id ? `/workshop/${u.id}` : undefined),
};
const USE_LABEL: Record<string, string> = { action_type: "Action", automation: "Automate", workshop: "Workshop", pipeline: "Pipeline", vertex: "Vertex", map: "Map",
  module: "Workshop", osdk_app: "App", logic: "AIP Logic", agent: "AIP Agent", machinery: "Machinery" };

/** What to do next with a published function: where it plugs in, given its inputs and what already uses it. */
function nextStep(f: IntegratedFunction): { label: string; href: string } | null {
  const inputs = (f.signature as { type: string }[] | undefined) ?? [];
  const objectIn = inputs.some((i) => String(i.type).startsWith("object"));
  const used = new Set(f.used_by.map((u) => u.kind));
  if (f.kind === "edit") return used.has("action_type") ? null : { label: "Add as an action rule", href: "/ontology/action-types" };
  if (f.kind === "query") return used.size ? null : { label: "Call it from the API gateway or Workshop", href: "/workshop" };
  if (used.size) return null;
  return objectIn ? { label: "Show it in a Workshop module", href: "/workshop" } : { label: "Use it in Pipeline Builder, row by row", href: "/pipeline" };
}

export function FunctionIntegration({ canRunCode }: { canRunCode: boolean }) {
  const [rows, setRows] = useState<IntegratedFunction[] | null>(null);
  const [hiddenTests, setHiddenTests] = useState(0);
  const [tests, setTests] = useState(false);
  const [q, setQ] = useState("");
  const [usedOnly, setUsedOnly] = useState(false);
  // ?new=logic (Code Repositories → Functions → Business logic) opens the dialog
  const params = useSearchParams();
  const [open, setOpen] = useState(() => canRunCode && params.get("new") === "logic");
  const load = () =>
    functionIntegration.overview(tests).then(
      (r) => {
        setRows(r.functions);
        setHiddenTests(r.hidden_tests);
      },
      () => setRows([]),
    );
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tests]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (rows ?? []).filter((f) => (!usedOnly || f.used_by.length) && (!s || `${f.name} ${f.doc} ${f.api_name ?? ""} ${f.used_by.map((u) => u.name).join(" ")}`.toLowerCase().includes(s)));
  }, [rows, q, usedOnly]);
  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-line bg-gradient-to-br from-sky-500/[0.07] via-panel to-panel p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-white">Put business logic into your apps</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              A function is a rule your organisation runs everywhere the same way: a KPI, a check before an action, a risk score, an SLA, an alert condition.
              Write it once, publish it, and every app uses the same version.
            </p>
          </div>
          <button type="button" onClick={() => setOpen(true)} disabled={!canRunCode} className={buttonClass.primary}
            title={canRunCode ? undefined : "Writing functions runs code: limited to administrators and the allowed groups (Control Panel → Security → Code execution)"}>
            <Icon name="sparkle" className="h-3.5 w-3.5" /> New business logic
          </button>
        </div>
        <ol className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {STEPS.map((s) => (
            <li key={s.n} className="rounded-xl border border-line bg-panel/70 p-3">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-sky-500/20 text-[11px] font-semibold text-sky-300">{s.n}</span>
                <Icon name={s.icon} className="h-4 w-4 text-soft" />
                <span className="text-sm font-medium text-white">{s.title}</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
      <div className="overflow-hidden rounded-2xl border border-line bg-panel">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="text-[13px] font-semibold">Functions in your apps</span>
          <span className="text-xs text-muted">{rows ? `${rows.length} published · ${rows.filter((f) => f.used_by.length).length} in use` : "…"}</span>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search functions or apps…" className={`${inputClass} !w-56 !py-1`} />
            <label className="flex items-center gap-1.5 text-soft"><input type="checkbox" checked={usedOnly} onChange={(e) => setUsedOnly(e.target.checked)} /> In use</label>
            {(hiddenTests > 0 || tests) && (
              <label className="flex items-center gap-1.5 text-muted" title="Functions of repositories named or filed under (test)">
                <input type="checkbox" checked={tests} onChange={(e) => setTests(e.target.checked)} /> Test items{hiddenTests && !tests ? ` (${hiddenTests})` : ""}
              </label>
            )}
          </div>
        </div>
        {!rows ? <div className="m-4 h-20 animate-pulse rounded-lg bg-panel-2/40" /> : shown.length === 0 ? (
          <p className="p-4 text-xs text-muted">{rows.length ? "No function matches." : "No published function yet: start with New business logic."}</p>
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-panel text-muted">
                <tr>{["Function", "Kind", "Used in", "Next step"].map((h) => <th key={h} className="px-4 py-2 text-left font-normal">{h}</th>)}</tr>
              </thead>
              <tbody>
                {shown.slice(0, 200).map((f) => {
                  const next = nextStep(f);
                  return (
                    <tr key={f.id} className="border-t border-line align-top hover:bg-panel-2/40">
                      <td className="max-w-[22rem] px-4 py-2.5">
                        <Link href={`/functions/${f.id}`} className="font-mono text-white hover:text-ocean">{f.name}</Link>
                        <div className="truncate text-[11px] text-muted" title={f.doc}>{f.doc || "—"}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${f.kind === "edit" ? "bg-amber-500/15 text-amber-300" : f.kind === "query" ? "bg-sky-500/15 text-sky-300" : "bg-panel-2 text-soft"}`}>
                          {f.kind === "edit" ? "edit" : f.kind === "query" ? `query${f.api_name ? ` · ${f.api_name}` : ""}` : "function"}
                        </span>
                        <span className="ml-1.5 font-mono text-[10px] text-muted">v{f.version}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        {f.used_by.length ? (
                          <div className="flex flex-wrap gap-1">
                            {f.used_by.slice(0, 6).map((u, i) => {
                              const href = u.link ?? USE_HREF[u.kind]?.(u);
                              const chip = <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200">{USE_LABEL[u.kind] ?? u.kind_label ?? u.kind} · {u.name}</span>;
                              return href ? <Link key={i} href={href} className="max-w-[16rem] truncate">{chip}</Link> : <span key={i}>{chip}</span>;
                            })}
                            {f.used_by.length > 6 && <span className="text-[10px] text-muted">+{f.used_by.length - 6}</span>}
                          </div>
                        ) : <span className="text-muted">not used yet</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        {next ? <Link href={next.href} className="inline-flex items-center gap-1 rounded-md bg-ocean/15 px-2 py-1 text-ocean hover:bg-ocean/25">{next.label} →</Link>
                          : <span className="inline-flex items-center gap-1 text-emerald-300"><Icon name="check" className="h-3 w-3" /> in use</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shown.length > 200 && <p className="border-t border-line px-4 py-2 text-[11px] text-muted">Showing 200 of {shown.length}: search to narrow.</p>}
          </div>
        )}
      </div>
      {open && <NewLogicDialog onClose={() => setOpen(false)} onCreated={load} />}
    </section>
  );
}

function NewLogicDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const router = useRouter();
  const [mode, setMode] = useState<"template" | "aip">("template");
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [typeId, setTypeId] = useState("");
  const [templates, setTemplates] = useState<LogicTemplate[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [aipTypes, setAipTypes] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [explanation, setExplanation] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("Business logic");
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [project, setProject] = useState("");
  const [publish, setPublish] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<CreatedLogic | null>(null);
  useEffect(() => {
    ontology.objectTypes().then((t) => setTypes([...t].sort((a, b) => a.display_name.localeCompare(b.display_name))), () => setTypes([]));
    api.drive.folder(null).then((f) => setProjects(f.items.filter((i) => i.kind === "project").map((i) => ({ id: i.id, name: i.name }))), () => setProjects([]));
  }, []);
  useEffect(() => {
    functionIntegration.templates(typeId || null).then((r) => setTemplates(r.templates), (e: Error) => setErr(e.message));
  }, [typeId]);
  const tpl = templates.find((t) => t.key === pick) ?? null;
  const groups = useMemo(() => [...new Set(templates.map((t) => t.category))], [templates]);
  const choose = (t: LogicTemplate) => {
    setPick(t.key);
    setCode(t.code);
    setName((n) => (n === "Business logic" || templates.some((x) => x.name === n) ? t.name : n));
  };
  const generate = async () => {
    setBusy("generate");
    setErr(null);
    try {
      const r = await functionIntegration.generate(prompt, aipTypes);
      setCode(r.code);
      setExplanation(r.explanation);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const create = async () => {
    setBusy("create");
    setErr(null);
    try {
      const r = await functionIntegration.create({ name: name.trim(), project_id: project || null, code, publish, description: tpl?.description ?? prompt.slice(0, 500) });
      setDone(r);
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal title="New business logic" icon="sparkle" onClose={onClose} xl>
      {done ? (
        <div className="space-y-4 p-5 text-sm">
          <div className="flex items-center gap-2 text-emerald-300"><Icon name="check" className="h-4 w-4" /> Repository created{done.published ? `, released v${done.version}` : ""}.</div>
          {done.publish_error && <p className="rounded-md bg-bad/10 p-2 text-xs text-bad">Not published: {done.publish_error}</p>}
          <div>
            <div className="mb-1 text-xs text-muted">Functions</div>
            <div className="flex flex-wrap gap-1.5">
              {(done.released ?? done.functions.map((n) => ({ id: "", name: n, kind: "" }))).map((f) => (
                f.id ? <Link key={f.name} href={`/functions/${f.id}`} className="rounded-full border border-line px-2.5 py-1 font-mono text-xs text-ocean hover:border-ocean">{f.name}</Link>
                  : <span key={f.name} className="rounded-full border border-line px-2.5 py-1 font-mono text-xs text-soft">{f.name}</span>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs text-muted">Use them in</div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {([["Action types", "/ontology/action-types", "play", "a function rule checks, then edits"], ["Workshop", "/workshop", "device", "columns, metrics, charts, buttons"],
                ["Pipeline Builder", "/pipeline", "pipeline", "Use function, row by row"], ["Automate", "/automate", "bolt", "conditions and effects"],
                ["API gateway", "/functions", "plug", "queries with an API name"], ["AIP Logic", "/logic", "logic", "tools for AI flows"]] as [string, string, IconName, string][]).map(([l, h, i, d]) => (
                <Link key={l} href={h} className="rounded-xl border border-line bg-panel-2/40 p-3 hover:border-ocean">
                  <div className="flex items-center gap-2 text-sm text-white"><Icon name={i} className="h-4 w-4 text-ocean" /> {l}</div>
                  <div className="mt-0.5 text-[11px] text-muted">{d}</div>
                </Link>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => router.push(`/code-repositories/${done.repo_id}?file=${encodeURIComponent(done.file)}`)} className={buttonClass.secondary}><Icon name="code" className="h-3.5 w-3.5" /> Open the code</button>
            <button type="button" onClick={onClose} className={buttonClass.primary}>Done</button>
          </div>
        </div>
      ) : (
        <div className="grid max-h-[75vh] gap-0 overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="min-h-0 space-y-3 overflow-y-auto border-r border-line p-4">
            <div className="inline-flex rounded-lg border border-line bg-panel-2/40 p-0.5 text-xs">
              {([["template", "From a template", "list"], ["aip", "Describe it (AIP)", "sparkle"]] as const).map(([k, l, i]) => (
                <button key={k} type="button" onClick={() => setMode(k)} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 ${mode === k ? "bg-ocean/20 text-white" : "text-muted hover:text-white"}`}>
                  <Icon name={i} className="h-3.5 w-3.5" /> {l}
                </button>
              ))}
            </div>
            {mode === "template" ? (
              <>
                <label className="block text-xs text-muted">Nexus object type (the templates are written for it)
                  <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={`${inputClass} mt-1`}>
                    <option value="">— generic (choose one for real properties) —</option>
                    {types.map((t) => <option key={t.id} value={t.id}>{t.display_name}</option>)}
                  </select>
                </label>
                {groups.map((g) => (
                  <div key={g}>
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{g}</div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {templates.filter((t) => t.category === g).map((t) => (
                        <button key={t.key} type="button" onClick={() => choose(t)}
                          className={`rounded-lg border p-2.5 text-left transition ${pick === t.key ? "border-ocean bg-ocean/10" : "border-line bg-panel-2/40 hover:border-ocean/60"}`}>
                          <div className="text-xs font-medium text-white">{t.name}</div>
                          <div className="mt-0.5 line-clamp-2 text-[10px] text-muted">{t.description}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {tpl && (
                  <div className="rounded-lg border border-line bg-panel-2/30 p-3">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Where it plugs in</div>
                    <ul className="list-disc space-y-0.5 pl-4 text-xs text-soft">{tpl.uses.map((u) => <li key={u}>{u}</li>)}</ul>
                  </div>
                )}
              </>
            ) : (
              <>
                <label className="block text-xs text-muted">The business rule, in plain words
                  <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} className={`${inputClass} mt-1`}
                    placeholder="e.g. A work order can only be closed when its findings are verified; flag gardu whose losses exceed 12% and whose load is above 80%; the expected recovery per customer is score × value × 3 months." />
                </label>
                <div>
                  <div className="mb-1 text-xs text-muted">Object types it works on ({aipTypes.length}/6)</div>
                  <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                    {types.map((t) => {
                      const on = aipTypes.includes(t.id);
                      return (
                        <button key={t.id} type="button" disabled={!on && aipTypes.length >= 6} onClick={() => setAipTypes(on ? aipTypes.filter((x) => x !== t.id) : [...aipTypes, t.id])}
                          className={`rounded-full border px-2 py-0.5 text-[11px] disabled:opacity-40 ${on ? "border-ocean bg-ocean/15 text-white" : "border-line text-soft hover:border-ocean/60"}`}>{t.display_name}</button>
                      );
                    })}
                  </div>
                </div>
                <button type="button" onClick={generate} disabled={prompt.trim().length < 3 || busy === "generate"} className={buttonClass.primary}>
                  <Icon name={busy === "generate" ? "refresh" : "sparkle"} className={`h-3.5 w-3.5 ${busy === "generate" ? "animate-spin" : ""}`} /> {busy === "generate" ? "Writing…" : "Write the functions"}
                </button>
                {explanation && <div className="md-body rounded-lg border border-violet-400/30 bg-violet-500/5 p-3 text-xs text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(explanation) }} />}
              </>
            )}
          </div>
          <div className="flex min-h-0 flex-col p-4">
            <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
              <span>Code (Python · functions.api) — edit freely</span>
              {code && <span className="font-mono text-[10px]">{(code.match(/@function/g) ?? []).length} function(s)</span>}
            </div>
            <textarea value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false}
              placeholder={mode === "template" ? "Pick a template on the left." : "Describe the rule and press Write the functions."}
              className="min-h-[260px] flex-1 resize-none rounded-lg border border-line-2 bg-ink p-3 font-mono text-[11px] leading-relaxed text-soft outline-none focus:border-ocean" />
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-muted">Repository name<input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} mt-1`} /></label>
              <label className="text-xs text-muted">Project
                <select value={project} onChange={(e) => setProject(e.target.value)} className={`${inputClass} mt-1`}>
                  <option value="">Default project</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs text-soft"><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish release 0.1.0 now (the apps can use it at once)</label>
            {err && <p className="mt-2 whitespace-pre-wrap rounded-md bg-bad/10 p-2 text-xs text-bad">{err}</p>}
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={onClose} className={buttonClass.ghost}>Cancel</button>
              <button type="button" onClick={create} disabled={!code.trim() || !name.trim() || busy === "create"} className={buttonClass.primary}>
                {busy === "create" ? "Creating…" : publish ? "Create and publish" : "Create repository"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
