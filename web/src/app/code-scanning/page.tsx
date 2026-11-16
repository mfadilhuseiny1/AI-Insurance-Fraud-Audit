"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { AppHeader, Card } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { API_URL } from "@/lib/api";
import { codeScanning, type CodeScanRule, type CodeScanSettings } from "@/lib/securityGov";

const TEMPLATE = `rules:
  - id: custom_python_no-eval
    languages:
      - python
    message: |
      Avoid eval() on untrusted input. Use ast.literal_eval() to evaluate literal values.
    severity: WARNING
    metadata:
      category: security
    pattern: eval(...)
`;

/** Code scanning: SAST on every commit of the repositories it covers, with built-in and custom (Semgrep-syntax) rules. */
export default function CodeScanningPage() {
  const [tab, setTab] = useState<"settings" | "rules">("settings");
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Code scanning" icon="code" href="/code-scanning" crumbs={[{ label: "Security & Governance", href: "/security-governance" }]} />
      <div className="flex shrink-0 gap-1 border-b border-line bg-panel px-4">
        {([["settings", "Settings", "sliders"], ["rules", "Rules", "list"]] as const).map(([id, label, icon]) => (
          <button key={id} type="button" onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm ${tab === id ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}><Icon name={icon} className="h-4 w-4" />{label}</button>
        ))}
      </div>
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
        <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">{tab === "settings" ? <Settings /> : <Rules />}</div>
      </main>
    </div>
  );
}

function Settings() {
  const [s, setS] = useState<CodeScanSettings | null>(null);
  const [repos, setRepos] = useState<{ id: string; name: string; scanned: boolean; why: string }[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState<"always_projects" | "never_projects" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    codeScanning.settings().then(setS, (e: Error) => setError(e.message));
    codeScanning.repositories().then((r) => { setRepos(r); setNames((n) => ({ ...n, ...Object.fromEntries(r.map((x) => [x.id, x.name])) })); }, () => {});
  }, []);
  useEffect(load, [load]);
  const save = (x: Partial<CodeScanSettings>) => codeScanning.saveSettings(x).then((v) => { setS(v); codeScanning.repositories().then(setRepos, () => {}); }, (e: Error) => setError(e.message));
  if (error) return <ApiError message={error} />;
  if (!s) return <Loading />;
  const list = (k: "always_projects" | "never_projects" | "always_repos" | "never_repos", label: string) => (
    <div className="space-y-1">
      <div className="text-xs font-semibold text-soft">{label}</div>
      <div className="flex flex-wrap items-center gap-1">
        {s[k].map((id) => <button key={id} type="button" className="rounded-full bg-panel-2 px-2 py-0.5 text-xs ring-1 ring-line-2 hover:text-bad" onClick={() => save({ [k]: s[k].filter((x) => x !== id) })}>{names[id] ?? id} ×</button>)}
        {k.endsWith("projects") ? (
          <button type="button" className={`${buttonClass.ghost} text-xs`} onClick={() => setPicking(k as "always_projects" | "never_projects")}><Icon name="plus" className="h-3.5 w-3.5" />Add Project</button>
        ) : (
          <select className={`${fieldClass} text-xs`} value="" onChange={(e) => e.target.value && save({ [k]: [...new Set([...s[k], e.target.value])] })}>
            <option value="">Add repository…</option>
            {repos.filter((r) => !s[k].includes(r.id)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
      </div>
    </div>
  );
  return (
    <>
      <Card title="Code scanning">
        <div className="space-y-3 p-4 text-sm">
          <p className="text-xs text-muted">Every commit of a covered repository is scanned before its checks run. Findings appear in the commit&apos;s Checks (the &ldquo;Code scan&rdquo; task) with a downloadable JSON report.</p>
          <label className="flex items-center gap-2"><input type="checkbox" checked={s.enabled} onChange={(e) => save({ enabled: e.target.checked })} />Scan every repository in the enrollment</label>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-start gap-2"><input type="radio" className="mt-1" checked={s.mode === "error"} onChange={() => save({ mode: "error" })} /><span><b>Error</b><span className="block text-xs text-muted">Checks fail when vulnerabilities are found; fix them and re-run.</span></span></label>
            <label className="flex items-start gap-2"><input type="radio" className="mt-1" checked={s.mode === "warn"} onChange={() => save({ mode: "warn" })} /><span><b>Warn</b><span className="block text-xs text-muted">Checks go on; findings are reported only.</span></span></label>
          </div>
        </div>
      </Card>
      <Card title="Scanning overrides (the most specific wins: repository, then Project, then the enrollment)">
        <div className="grid gap-4 p-4 md:grid-cols-2">
          {list("always_projects", "Always scan projects")}
          {list("never_projects", "Never scan projects")}
          {list("always_repos", "Always scan repositories")}
          {list("never_repos", "Never scan repositories")}
        </div>
      </Card>
      <Card title="Repositories" count={repos.length}>
        <ul className="divide-y divide-line text-sm">
          {repos.map((r) => <li key={r.id} className="flex items-center gap-2 px-4 py-2"><Icon name={r.scanned ? "check" : "x"} className={`h-4 w-4 ${r.scanned ? "text-ok" : "text-muted"}`} /><span className="flex-1">{r.name}</span><span className="text-xs text-muted">{r.why}</span></li>)}
          {!repos.length && <li className="px-4 py-3 text-muted">No repositories.</li>}
        </ul>
      </Card>
      {picking && <DrivePicker title="Project" onClose={() => setPicking(null)}
        folder={{ action: "Use this Project", onPick: (f) => { if (f.id) { const id = f.id; setNames((n) => ({ ...n, [id]: f.name })); void save({ [picking]: [...new Set([...s[picking], id])] }); } setPicking(null); } }} />}
    </>
  );
}

function Rules() {
  const [type, setType] = useState<"builtin" | "custom">("builtin");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<CodeScanRule[] | null>(null);
  const [sel, setSel] = useState<{ rule: CodeScanRule | null; text: string; dirty: boolean } | null>(null);
  const [tryCode, setTryCode] = useState("result = eval(user_input)\n");
  const [tryOut, setTryOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => codeScanning.rules({ type, status: status || undefined, q: q || undefined }).then(setRows, (e: Error) => setError(e.message)), [type, status, q]);
  useEffect(() => {
    void load();
  }, [load]);
  const pick = (r: CodeScanRule) => setSel({ rule: r, text: r.definition, dirty: false });
  const ruleId = useMemo(() => /id:\s*([A-Za-z0-9._-]+)/.exec(sel?.text ?? "")?.[1] ?? "", [sel?.text]);
  const save = async () => {
    if (!sel) return;
    try {
      const out = sel.rule?.type === "custom" ? await codeScanning.update(sel.rule.id, sel.text) : await codeScanning.create(sel.text);
      setType("custom");
      setSel({ rule: out, text: out.definition, dirty: false });
      setError(null);
      void load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const upload = (file: File) => file.text().then((text) => setSel({ rule: null, text, dirty: true }));
  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
      <Card title="Rules" count={rows?.length} action={
        <span className="flex gap-1">
          <label className={`${buttonClass.ghost} cursor-pointer text-xs`}><Icon name="upload" className="h-3.5 w-3.5" />Upload<input type="file" accept=".yml,.yaml" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} /></label>
          <button type="button" className={`${buttonClass.ghost} text-xs`} onClick={() => { setType("custom"); setSel({ rule: null, text: TEMPLATE, dirty: true }); }}><Icon name="plus" className="h-3.5 w-3.5" />New rule</button>
        </span>}>
        <div className="space-y-2 border-b border-line p-3">
          <div className="flex gap-1">{(["builtin", "custom"] as const).map((t) => <button key={t} type="button" onClick={() => setType(t)} className={`rounded-md px-3 py-1 text-xs ${type === t ? "bg-ocean/15 text-white" : "text-muted"}`}>{t === "builtin" ? "Built-in" : "Custom"}</button>)}</div>
          <div className="flex gap-1">
            <input className={`${fieldClass} min-w-0 flex-1 text-xs`} placeholder="Search rules" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className={`${fieldClass} text-xs`} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select>
          </div>
        </div>
        {error && !sel && <p className="p-3 text-xs text-bad">{error}</p>}
        {!rows ? <Loading /> : (
          <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto">
            {rows.map((r) => (
              <li key={`${r.type}:${r.id}`}>
                <button type="button" onClick={() => pick(r)} className={`w-full px-3 py-2 text-left text-xs hover:bg-panel-2 ${sel?.rule?.id === r.id && sel.rule.type === r.type ? "bg-ocean/10" : ""}`}>
                  <span className="block truncate font-mono text-soft">{r.id}</span>
                  <span className="text-muted">{r.severity} · {(r.languages ?? []).join(", ")} · </span><span className={r.enabled ? "text-ok" : "text-muted"}>{r.enabled ? "Enabled" : "Disabled"}</span>
                </button>
              </li>
            ))}
            {!rows.length && <li className="p-3 text-xs text-muted">No rules.</li>}
          </ul>
        )}
      </Card>
      {sel ? (
        <Card title={sel.rule ? sel.rule.id : "New custom rule"} action={sel.dirty ? <span className="text-xs text-warn">Unsaved</span> : undefined}>
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap gap-2">
              {sel.rule && (
                <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={sel.rule.enabled}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    if (!enabled && !window.confirm("Disable this rule in every repository of the enrollment? Earlier findings stay in completed scans.")) return;
                    void codeScanning.toggle(sel.rule!.id, enabled).then(() => { setSel({ ...sel, rule: { ...sel.rule!, enabled } }); void load(); }, (er: Error) => setError(er.message));
                  }} />Enabled</label>
              )}
              {sel.rule && <button type="button" className={buttonClass.secondary} onClick={() => setSel({ rule: null, text: sel.text.replace(/id:\s*([A-Za-z0-9._-]+)/, (_m, id: string) => `id: ${id}-copy`), dirty: true })}><Icon name="copy" className="h-4 w-4" />Duplicate</button>}
              {sel.rule && <a className={buttonClass.secondary} href={`${API_URL}/api/code-scanning/rules/${encodeURIComponent(sel.rule.id)}/download?type=${sel.rule.type}`}><Icon name="download" className="h-4 w-4" />Download</a>}
              {sel.rule?.type === "custom" && <button type="button" className={buttonClass.ghost} onClick={() => window.confirm("Delete this custom rule permanently?") && codeScanning.remove(sel.rule!.id).then(() => { setSel(null); void load(); }, (e: Error) => setError(e.message))}><Icon name="trash" className="h-4 w-4" />Delete</button>}
            </div>
            <textarea className={`${inputClass} min-h-72 font-mono text-xs`} value={sel.text} readOnly={sel.rule?.type === "builtin"}
              onChange={(e) => setSel({ ...sel, text: e.target.value, dirty: true })} spellCheck={false} />
            {sel.rule?.type === "builtin" && <p className="text-xs text-muted">Built-in rules cannot be edited: duplicate this one, edit the copy, then disable the original.</p>}
            {sel.rule?.type !== "builtin" && (
              <div className="flex gap-2">
                <button type="button" className={buttonClass.primary} disabled={!sel.dirty || !ruleId} onClick={save}>Save</button>
                {sel.dirty && sel.rule && <button type="button" className={buttonClass.ghost} onClick={() => setSel({ ...sel, text: sel.rule!.definition, dirty: false })}>Cancel</button>}
              </div>
            )}
            {error && <p className="text-sm text-bad">{error}</p>}
            <div className="space-y-1 rounded border border-line p-3">
              <div className="text-xs font-semibold text-soft">Try it on code</div>
              <textarea className={`${inputClass} min-h-20 font-mono text-xs`} value={tryCode} onChange={(e) => setTryCode(e.target.value)} spellCheck={false} />
              <button type="button" className={buttonClass.secondary} onClick={() => codeScanning.tryRule(sel.text, /languages:[\s\S]*?-\s*java\b/.test(sel.text) ? "Example.java" : /languages:[\s\S]*?-\s*(javascript|typescript|js)\b/.test(sel.text) ? "example.js" : "example.py", tryCode)
                .then((r) => setTryOut(r.findings.length ? r.findings.map((f) => `line ${f.line}:${f.column} ${f.snippet}`).join("\n") : "No findings"), (e: Error) => setTryOut(e.message))}><Icon name="play" className="h-4 w-4" />Run</button>
              {tryOut && <pre className="whitespace-pre-wrap text-xs text-soft">{tryOut}</pre>}
            </div>
            <p className="text-[11px] text-muted">Rules use the Semgrep rule syntax (pattern with ... and $METAVARIABLES, patterns, pattern-either, pattern-not, pattern-inside, pattern-regex). Semgrep is not installed here: patterns run on the platform&apos;s matcher for that syntax.</p>
          </div>
        </Card>
      ) : <Card title="Rule"><p className="p-4 text-sm text-muted">Select a rule to view its definition.</p></Card>}
    </div>
  );
}
