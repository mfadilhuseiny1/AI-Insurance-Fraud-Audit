"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type DriveItem } from "@/lib/api";
import { auth } from "@/lib/auth";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { linter, MODES, RESOURCE_LABEL, type Impact, type LinterMode, type LinterRule, type Recommendation, type ScheduleBody, type SweepSchedule } from "@/lib/linter";

/** Linter (palantir.com/docs/foundry/linter): recommendations from sweeps of the platform's state, by mode, with
 *  context, snoozing, assignment and fix proposals; impact tracking; sweep schedules. */
export default function LinterPage() {
  const [view, setView] = useState<"recommendations" | "impact" | "sweeps">(() => {
    const v = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("view");
    return v === "impact" || v === "sweeps" ? v : "recommendations";
  });
  const [mode, setMode] = useState<LinterMode>("resource_savings");
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [rules, setRules] = useState<LinterRule[]>([]);
  const [presets, setPresets] = useState<Record<string, string>>({});
  const [schedules, setSchedules] = useState<SweepSchedule[]>([]);
  const [people, setPeople] = useState<{ id: string; label: string }[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    linter.recommendations().then(setRecs, (e: Error) => (setRecs([]), setError(e.message)));
    linter.schedules().then(setSchedules, () => {});
  }, []);
  useEffect(() => {
    load();
    linter.rules().then((r) => (setRules(r.rules), setPresets(r.presets)), () => {});
    linter.assignees().then(setPeople, () => {});
    auth.me().then((m) => setMe(m.id), () => {});
  }, [load]);
  const last = schedules
    .map((s) => s.last_sweep?.finished_at)
    .filter(Boolean)
    .sort()
    .pop();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="rounded-md bg-ocean/15 p-1.5 text-ocean">
            <Icon name="bug" className="h-4 w-4" />
          </span>
          Linter
        </div>
        <span className="text-xs text-muted">Enrollment recommendations</span>
        <div className="ml-auto flex items-center gap-2">
          <span className={`flex items-center gap-1.5 text-xs ${last ? "text-ok" : "text-muted"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${last ? "bg-ok" : "bg-muted"}`} />
            {last ? `Last sweep ${when(last)}` : "No sweep yet"}
          </span>
          {(["recommendations", "impact", "sweeps"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs ${view === v ? "border-ocean/50 bg-ocean/10 text-white" : "border-line-2 text-soft hover:text-white"}`}
            >
              <Icon name={v === "recommendations" ? "list" : v === "impact" ? "gauge" : "clock"} className="h-3.5 w-3.5" />
              {v === "recommendations" ? "Recommendations" : v === "impact" ? "Impact tracking" : "Sweep schedules"}
            </button>
          ))}
        </div>
      </header>
      {error && <p className="border-b border-line bg-bad/10 px-5 py-2 text-xs text-bad">{error}</p>}
      {view === "recommendations" && (
        <Recommendations mode={mode} setMode={setMode} recs={recs} rules={rules} people={people} me={me} onChanged={load} onSweeps={() => setView("sweeps")} />
      )}
      {view === "impact" && <ImpactView rules={rules} />}
      {view === "sweeps" && <SweepsView schedules={schedules} rules={rules} presets={presets} onChanged={load} />}
    </div>
  );
}

const SNOOZES: [string, number][] = [
  ["1 day", 1],
  ["1 week", 7],
  ["1 month", 30],
  ["3 months", 90],
];

function Recommendations({ mode, setMode, recs, rules, people, me, onChanged, onSweeps }: {
  mode: LinterMode;
  setMode: (m: LinterMode) => void;
  recs: Recommendation[] | null;
  rules: LinterRule[];
  people: { id: string; label: string }[];
  me: string | null;
  onChanged: () => void;
  onSweeps: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [kind, setKind] = useState("");
  const [ruleF, setRuleF] = useState("");
  const [project, setProject] = useState("");
  const [assigneeF, setAssigneeF] = useState("");
  const [showSnoozed, setShowSnoozed] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<(Recommendation & { rule_info: LinterRule }) | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [snoozing, setSnoozing] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const all = useMemo(() => (recs ?? []).filter((r) => r.mode === mode), [recs, mode]);
  const projects = useMemo(() => [...new Map(all.flatMap((r) => r.projects).map((p) => [p.id, p])).values()], [all]);
  const shown = all.filter(
    (r) =>
      (!kind || r.resource.type === kind) &&
      (!ruleF || r.rule === ruleF) &&
      (!project || r.projects.some((p) => p.id === project)) &&
      (!assigneeF || (assigneeF === "me" ? r.assignee === me : assigneeF === "none" ? !r.assignee : r.assignee === assigneeF)) &&
      (showSnoozed || r.state !== "snoozed") &&
      `${r.title} ${r.resource.name} ${r.resource.subtitle ?? ""} ${r.detail} ${r.projects.map((p) => p.name).join(" ")}`.toLowerCase().includes(query.toLowerCase()),
  );
  const select = async (r: Recommendation) => {
    setSelectedId(r.id);
    setMsg(null);
    try {
      setDetail(await linter.open(r.id));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setMsg(null);
    try {
      await fn();
      if (done) setMsg(done);
      onChanged();
      if (selectedId) setDetail(await linter.open(selectedId));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const label = (id: string | null) => (id ? (people.find((p) => p.id === id)?.label ?? id) : "Unassigned");
  const sel = detail && detail.id === selectedId ? detail : null;
  const total = shown.reduce((n, r) => n + (r.impact?.compute_hours_month ?? 0), 0);
  return (
    <>
      <div className="flex items-center border-b border-line bg-panel px-5 py-3">
        <div className="flex gap-1 rounded-lg border border-line-2 bg-ink p-1">
          {MODES.map(([value, name]) => (
            <button
              key={value}
              type="button"
              onClick={() => (setMode(value), setSelectedId(null), setChecked(new Set()))}
              className={`rounded-md px-3 py-1.5 text-xs ${mode === value ? "bg-ocean/15 font-medium text-white ring-1 ring-ocean/40" : "text-muted hover:text-white"}`}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {checked.size > 0 && (
            <div className="flex items-center gap-2 rounded-md border border-ocean/40 bg-ocean/10 px-2 py-1 text-xs">
              <span className="text-soft">{checked.size} selected</span>
              <button type="button" onClick={() => setSnoozing([...checked])} className="text-ocean hover:underline">
                Snooze
              </button>
              <button type="button" onClick={() => act(() => linter.bulk({ ids: [...checked], action: "unsnooze" }))} className="text-ocean hover:underline">
                Unsnooze
              </button>
              <select
                value=""
                onChange={(e) => e.target.value && act(() => linter.bulk({ ids: [...checked], action: "assign", assignee: e.target.value === "-" ? null : e.target.value }))}
                className="rounded border border-line-2 bg-ink px-1 py-0.5 text-soft outline-none"
              >
                <option value="">Assign…</option>
                <option value="-">Unassigned</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setChecked(new Set())} className="text-muted hover:text-white" aria-label="Clear selection">
                <Icon name="x" className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <span className="text-xs text-muted">
            {shown.length} recommendations{mode === "resource_savings" && total > 0 ? ` · ~${total.toFixed(1)} compute-hours / month` : ""}
          </span>
          <button
            type="button"
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs ${filtersOpen ? "border-ocean/50 bg-ocean/10 text-white" : "border-line-2 text-soft hover:text-white"}`}
          >
            <Icon name="filter" className="h-3.5 w-3.5" /> Filters
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-panel p-3">
          <div className="mb-2 text-xs font-semibold text-soft">Recommendations</div>
          <div className="flex items-center gap-2 rounded-md border border-line-2 bg-ink px-2 py-1.5">
            <Icon name="search" className="h-3.5 w-3.5 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search recommendations" className="w-full bg-transparent text-xs outline-none placeholder:text-muted" />
          </div>
          {filtersOpen && (
            <div className="mt-3 space-y-2 rounded-lg border border-line bg-panel-2 p-3 text-xs">
              <Filter label="Resource type" value={kind} onChange={setKind} options={[...new Set(all.map((r) => r.resource.type))].map((t) => [t, RESOURCE_LABEL[t] ?? t])} />
              <Filter label="Rule" value={ruleF} onChange={setRuleF} options={[...new Set(all.map((r) => r.rule))].map((id) => [id, rules.find((x) => x.id === id)?.name ?? id])} />
              <Filter label="Project" value={project} onChange={setProject} options={projects.map((p) => [p.id, p.name])} />
              <Filter label="Assignee" value={assigneeF} onChange={setAssigneeF} options={[["me", "Assigned to me"], ["none", "Unassigned"], ...people.map((p) => [p.id, p.label] as [string, string])]} />
              <label className="flex gap-2 text-soft">
                <input type="checkbox" checked={showSnoozed} onChange={(e) => setShowSnoozed(e.target.checked)} /> Show snoozed
              </label>
            </div>
          )}
          <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto">
            {recs === null && <p className="p-4 text-center text-xs text-muted">Loading…</p>}
            {shown.map((r) => (
              <div key={r.id} className={`flex gap-2 rounded-lg border p-3 ${selectedId === r.id ? "border-ocean/50 bg-ocean/10" : "border-transparent hover:bg-panel-2"}`}>
                <input
                  type="checkbox"
                  checked={checked.has(r.id)}
                  onChange={(e) => {
                    const n = new Set(checked);
                    if (e.target.checked) n.add(r.id);
                    else n.delete(r.id);
                    setChecked(n);
                  }}
                  className="mt-0.5"
                  aria-label="Select"
                />
                <button type="button" onClick={() => select(r)} className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${r.state === "snoozed" ? "bg-warn" : r.status === "under_investigation" ? "bg-sand" : "bg-ocean"}`} />
                    <span className="truncate text-xs font-medium text-white">{r.title}</span>
                  </div>
                  <div className="mt-1 truncate text-[10px] text-muted">
                    {r.resource.name} · {r.projects.map((p) => p.name).join(", ") || "no project"}
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[10px]">
                    <span className="text-sand">{r.impact ? `${r.impact.compute_hours_month} compute-h / month` : RESOURCE_LABEL[r.resource.type] ?? r.resource.type}</span>
                    {r.state === "snoozed" && (
                      <span className="flex items-center gap-1 text-warn">
                        <Icon name="clock" className="h-3 w-3" /> Snoozed
                      </span>
                    )}
                    {r.state === "snooze_expired" && <span className="text-muted">Snooze expired</span>}
                    {r.assignee && <span className="text-muted">{label(r.assignee)}</span>}
                  </div>
                </button>
              </div>
            ))}
            {recs !== null && !shown.length && (
              <p className="p-4 text-center text-xs text-muted">
                {all.length ? "No recommendations match your filters." : "No recommendations in this mode. "}
                {!all.length && (
                  <button type="button" onClick={onSweeps} className="text-ocean hover:underline">
                    Run a sweep
                  </button>
                )}
              </p>
            )}
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-4xl">
            <div className="mb-5">
              <div className="text-xs uppercase tracking-wider text-ocean">{MODES.find(([m]) => m === mode)?.[1]}</div>
              <h1 className="mt-1 text-xl font-semibold">Recommendations</h1>
              <p className="mt-1 text-sm text-muted">
                {mode === "resource_savings"
                  ? "Reduce compute by not running what does not deliver an outcome. Estimates come from what ran in the last 30 days; validate them in Resource Management."
                  : "Make the pipelines that back critical workflows more stable and easier to debug."}
              </p>
            </div>
            {msg && <p className="mb-3 rounded-md border border-line bg-panel-2 p-2 text-xs text-soft">{msg}</p>}
            {sel ? (
              <div className="rounded-xl border border-line bg-panel">
                <div className="flex items-start gap-4 border-b border-line p-5">
                  <span className="rounded-lg bg-ocean/15 p-3 text-ocean">
                    <Icon name="alert" className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span>{RESOURCE_LABEL[sel.resource.type] ?? sel.resource.type}</span>
                      <span>·</span>
                      <span>first seen {when(sel.first_seen)}</span>
                      <span className={`rounded-full px-2 py-0.5 ${sel.state === "snoozed" ? "bg-warn/15 text-warn" : "bg-ocean/15 text-ocean"}`}>
                        {sel.state === "snoozed" ? `Snoozed until ${sel.snooze?.until.slice(0, 10)}` : sel.state === "snooze_expired" ? "Snooze expired" : "Default"}
                      </span>
                      {sel.status === "under_investigation" && <span className="rounded-full bg-sand/15 px-2 py-0.5 text-sand">Under investigation</span>}
                    </div>
                    <h2 className="mt-1 text-lg font-semibold text-white">{sel.title}</h2>
                    <p className="mt-1 text-sm text-soft">
                      {sel.resource.href ? (
                        <Link href={sel.resource.href} className="hover:underline">
                          {sel.resource.name}
                        </Link>
                      ) : (
                        sel.resource.name
                      )}{" "}
                      <span className="text-muted">
                        {sel.resource.subtitle ? `· ${sel.resource.subtitle} ` : ""}in {sel.projects.map((p) => p.name).join(", ") || "no project"}
                      </span>
                    </p>
                  </div>
                </div>
                <div className="grid gap-5 border-b border-line p-5 md:grid-cols-[1fr_240px]">
                  <div className="space-y-3 text-sm">
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">What was found</h3>
                      <p className="mt-1 text-soft">{sel.detail}</p>
                      {sel.evidence.length > 0 && (
                        <ul className="mt-1 list-disc pl-5 text-xs text-muted">
                          {sel.evidence.map((e) => (
                            <li key={e}>{e}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Logic</h3>
                      <p className="mt-1 text-xs leading-5 text-soft">{sel.rule_info.logic}</p>
                    </div>
                    {sel.rule_info.why && (
                      <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Why this appeared</h3>
                        <p className="mt-1 text-xs leading-5 text-soft">{sel.rule_info.why}</p>
                      </div>
                    )}
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Recommendation</h3>
                      <p className="mt-1 text-xs leading-5 text-soft">{sel.rule_info.recommendation}</p>
                    </div>
                    {sel.impact && (
                      <div className="rounded-lg border border-sand/25 bg-sand/10 p-3 text-xs text-soft">
                        <div className="flex items-center gap-2 font-medium text-sand">
                          <Icon name="gauge" className="h-4 w-4" /> Estimated impact: {sel.impact.compute_hours_month} compute-hours / month
                        </div>
                        <p className="mt-1">{sel.rule_info.savings} Validate actual savings in Resource Management after applying the change.</p>
                      </div>
                    )}
                    {sel.fixed && <p className="rounded-md bg-ok/10 p-2 text-xs text-ok">Fix applied {when(sel.fixed.at)}: {sel.fixed.result}. The next sweep confirms it.</p>}
                  </div>
                  <div className="space-y-3 rounded-lg border border-line bg-panel-2 p-3 text-xs">
                    <div>
                      <div className="text-muted">Rule</div>
                      <div className="mt-1 text-soft">{sel.rule_info.name}</div>
                    </div>
                    <div>
                      <div className="text-muted">Assignee</div>
                      <select
                        value={sel.assignee ?? ""}
                        onChange={(e) => act(() => linter.bulk({ ids: [sel.id], action: "assign", assignee: e.target.value || null }))}
                        className={`${inputClass} mt-1 text-xs`}
                      >
                        <option value="">Unassigned</option>
                        {people.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    {sel.snooze && sel.state === "snoozed" && (
                      <div>
                        <div className="text-muted">Snooze reason</div>
                        <div className="mt-1 text-soft">{sel.snooze.reason || "—"}</div>
                      </div>
                    )}
                    <div>
                      <div className="text-muted">Last seen</div>
                      <div className="mt-1 text-soft">{when(sel.last_seen)}</div>
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 p-4">
                  {sel.fix && !sel.fixed && (
                    <button
                      type="button"
                      onClick={async () => (await confirmDialog(`Apply the fix to ${sel.resource.name}? ${sel.rule_info.recommendation}`)) && act(async () => setMsg((await linter.fix(sel.id)).applied))}
                      className="rounded-md bg-ocean px-3 py-2 text-xs font-medium text-white hover:bg-ocean-deep"
                    >
                      Accept fix proposal
                    </button>
                  )}
                  {sel.resource.href && (
                    <Link href={sel.resource.href} className="flex items-center gap-1.5 rounded-md border border-line-2 px-3 py-2 text-xs text-soft hover:text-white">
                      <Icon name="external" className="h-3.5 w-3.5" /> Open {RESOURCE_LABEL[sel.resource.type]?.toLowerCase() ?? "resource"}
                    </Link>
                  )}
                  {sel.state === "snoozed" ? (
                    <button type="button" onClick={() => act(() => linter.bulk({ ids: [sel.id], action: "unsnooze" }))} className="flex items-center gap-1.5 rounded-md border border-line-2 px-3 py-2 text-xs text-soft hover:text-white">
                      <Icon name="clock" className="h-3.5 w-3.5" /> Unsnooze
                    </button>
                  ) : (
                    <button type="button" onClick={() => setSnoozing([sel.id])} className="flex items-center gap-1.5 rounded-md border border-line-2 px-3 py-2 text-xs text-soft hover:text-white">
                      <Icon name="clock" className="h-3.5 w-3.5" /> Snooze
                    </button>
                  )}
                  <span className="ml-auto text-[10px] text-muted">A new sweep confirms whether this recommendation is resolved.</span>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border-2 border-dashed border-line-2 p-12 text-center text-sm text-muted">Select a recommendation to inspect its context.</div>
            )}
          </div>
        </main>
      </div>
      {snoozing && (
        <SnoozeDialog
          count={snoozing.length}
          onClose={() => setSnoozing(null)}
          onSnooze={async (days, reason) => {
            const until = new Date(Date.now() + days * 86400_000).toISOString();
            await act(() => linter.bulk({ ids: snoozing, action: "snooze", until, reason }));
            setSnoozing(null);
            setChecked(new Set());
          }}
        />
      )}
    </>
  );
}

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded border border-line-2 bg-ink px-2 py-1.5 text-xs text-soft outline-none">
        <option value="">All</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function SnoozeDialog({ count, onClose, onSnooze }: { count: number; onClose: () => void; onSnooze: (days: number, reason: string) => Promise<void> }) {
  const [days, setDays] = useState(7);
  const [reason, setReason] = useState("");
  return (
    <Modal title={`Snooze ${count} recommendation${count > 1 ? "s" : ""}`} icon="clock" onClose={onClose}>
      <div className="space-y-3 p-5 text-sm">
        <label className="block text-xs text-muted">
          Until
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={`${inputClass} mt-1`}>
            {SNOOZES.map(([l, d]) => (
              <option key={d} value={d}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-muted">
          Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} className={`${inputClass} mt-1`} placeholder="Why it cannot be done now" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" onClick={() => onSnooze(days, reason)} className={buttonClass.primary}>
            Snooze
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ImpactView({ rules }: { rules: LinterRule[] }) {
  const [days, setDays] = useState(90);
  const [rule, setRule] = useState("");
  const [data, setData] = useState<Impact | null>(null);
  useEffect(() => {
    linter.impact({ days, rule: rule || undefined }).then(setData, () => {});
  }, [days, rule]);
  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <div>
          <div className="text-xs uppercase tracking-wider text-ocean">Impact tracking</div>
          <h1 className="mt-1 text-xl font-semibold">Actioned recommendations</h1>
          <p className="mt-1 text-sm text-muted">
            Recommendations become tracked when someone opens them. Verified impact compares the compute of the week before the fix with the week after, normalized to 30 days (available a week after
            the fix).
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded border border-line-2 bg-ink px-2 py-1 text-soft outline-none">
            {[30, 90, 180, 365].map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
          <select value={rule} onChange={(e) => setRule(e.target.value)} className="rounded border border-line-2 bg-ink px-2 py-1 text-soft outline-none">
            <option value="">All rules</option>
            {rules
              .filter((r) => r.applicable)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Recommendation count" value={data ? `${data.resolved}` : "…"} sub={data ? `resolved · ${data.under_investigation} under investigation` : ""} />
          <Metric label="Estimated impact" value={data ? `${data.estimated_hours} h` : "…"} sub="compute-hours per month, predicted before the fix" />
          <Metric label="Verified impact" value={data ? `${data.verified_hours} h` : "…"} sub={data ? `per month · ${data.pending_verification} awaiting a week of data` : ""} />
        </div>
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-line text-[10px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5">Recommendation</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Estimated</th>
                <th className="px-4 py-2.5">Verified</th>
              </tr>
            </thead>
            <tbody>
              {data?.recommendations.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-muted">
                    Nothing tracked yet.
                  </td>
                </tr>
              )}
              {data?.recommendations.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="text-soft">{r.title}</div>
                    <div className="text-muted">{r.resource.name}</div>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{r.status === "resolved" ? `Resolved ${when(r.resolved_at!)}` : `Under investigation since ${when(r.investigated_at!)}`}</td>
                  <td className="px-4 py-2.5 text-muted">{r.snapshot?.impact ? `${r.snapshot.impact.compute_hours_month} h` : "—"}</td>
                  <td className="px-4 py-2.5 text-muted">{r.verified ? `${r.verified.monthly_hours} h` : r.status === "resolved" ? "pending" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-soft">{value}</div>
      <div className="mt-1 text-[11px] text-muted">{sub}</div>
    </div>
  );
}

function SweepsView({ schedules, rules, presets, onChanged }: { schedules: SweepSchedule[]; rules: LinterRule[]; presets: Record<string, string>; onChanged: () => void }) {
  const [editing, setEditing] = useState<SweepSchedule | "new" | null>(null);
  const [recent, setRecent] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg(done);
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex items-end">
          <div>
            <div className="text-xs uppercase tracking-wider text-ocean">Linter configuration</div>
            <h1 className="mt-1 text-xl font-semibold">Sweep schedules</h1>
            <p className="mt-1 text-sm text-muted">
              A sweep schedule runs a rule scope (presets, then rules added, then rules excluded) over a resource scope (every Project, or chosen ones). Administrators change them.
            </p>
          </div>
          <button type="button" onClick={() => setEditing("new")} className={`${buttonClass.primary} ml-auto`}>
            <Icon name="plus" className="h-3.5 w-3.5" /> New sweep schedule
          </button>
        </div>
        {msg && <p className="rounded-md border border-line bg-panel-2 p-2 text-xs text-soft">{msg}</p>}
        {schedules.map((s) => (
          <div key={s.id} className="rounded-xl border border-line bg-panel">
            <div className="flex items-center gap-3 p-4">
              <span className="rounded-md bg-ocean/15 p-2 text-ocean">
                <Icon name="refresh" className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-white">
                  {s.name} {s.paused && <span className="ml-2 rounded bg-warn/15 px-1.5 text-[10px] text-warn">paused</span>}
                </div>
                <div className="truncate text-xs text-muted">
                  {s.projects.length ? `${s.projects.length} Project${s.projects.length > 1 ? "s" : ""}` : "All Projects"} · {s.rule_scope?.length ?? 0} rules · every {s.interval_hours} h
                  {s.last_sweep ? ` · last sweep ${when(s.last_sweep.finished_at)} (${s.last_sweep.status}, ${s.last_sweep.found} found)` : " · never swept"}
                </div>
              </div>
              <button type="button" onClick={() => act(() => linter.runSchedule(s.id), `Sweep of ${s.name} started: refresh in a moment.`)} className={buttonClass.secondary}>
                <Icon name="play" className="h-3.5 w-3.5" /> Trigger
              </button>
              <button type="button" onClick={() => setRecent(recent === s.id ? null : s.id)} className={buttonClass.secondary}>
                Recent sweeps
              </button>
              <button type="button" onClick={() => setEditing(s)} className={buttonClass.secondary}>
                Edit
              </button>
              <button
                type="button"
                onClick={() => act(() => linter.updateSchedule(s.id, { ...s, paused: !s.paused }), s.paused ? "Resumed." : "Paused.")}
                className={buttonClass.secondary}
              >
                {s.paused ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                onClick={async () => (await confirmDialog(`Delete the sweep schedule ${s.name}?`)) && act(() => linter.deleteSchedule(s.id), "Deleted.")}
                className="text-muted hover:text-bad"
                aria-label="Delete"
              >
                <Icon name="trash" className="h-4 w-4" />
              </button>
            </div>
            {recent === s.id && (
              <table className="w-full border-t border-line text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Queued</th>
                    <th className="px-4 py-2">Finished</th>
                    <th className="px-4 py-2">Found</th>
                    <th className="px-4 py-2">New / removed / resolved</th>
                    <th className="px-4 py-2">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {(s.recent_sweeps ?? []).map((w) => (
                    <tr key={w.id} className="border-t border-line">
                      <td className={`px-4 py-2 ${w.status === "failed" ? "text-bad" : w.status === "running" ? "text-ocean" : "text-ok"}`}>{w.status}</td>
                      <td className="px-4 py-2 text-muted">{when(w.queued_at)}</td>
                      <td className="px-4 py-2 text-muted">{w.finished_at ? when(w.finished_at) : "—"}</td>
                      <td className="px-4 py-2 text-muted">{w.found}</td>
                      <td className="px-4 py-2 text-muted">
                        {w.new} / {w.removed} / {w.resolved}
                      </td>
                      <td className="max-w-xs truncate px-4 py-2 text-bad" title={[w.error, ...Object.entries(w.rule_errors).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join("\n")}>
                        {w.error ?? (Object.keys(w.rule_errors).length ? `${Object.keys(w.rule_errors).length} rule(s) failed` : "")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
        <RulesCatalog rules={rules} />
      </div>
      {editing && (
        <ScheduleEditor
          schedule={editing === "new" ? null : editing}
          rules={rules}
          presets={presets}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            if (editing === "new") await linter.createSchedule(body);
            else await linter.updateSchedule(editing.id, body);
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </main>
  );
}

function RulesCatalog({ rules }: { rules: LinterRule[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-line bg-panel">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 p-4 text-left text-sm font-medium">
        <Icon name={open ? "down" : "right"} className="h-3.5 w-3.5 text-muted" /> Available rules ({rules.filter((r) => r.applicable).length} applicable, {rules.filter((r) => !r.applicable).length} not
        applicable here)
      </button>
      {open && (
        <ul className="divide-y divide-line border-t border-line text-xs">
          {rules.map((r) => (
            <li key={r.id} className="px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className={r.applicable ? "font-medium text-soft" : "text-muted line-through"}>{r.name}</span>
                <span className="text-[10px] text-muted">{MODES.find(([m]) => m === r.mode)?.[1]}</span>
                {r.fix && <span className="rounded bg-ok/15 px-1 text-[10px] text-ok">fix proposal</span>}
              </div>
              <p className="mt-0.5 text-muted">{r.applicable ? r.logic : `Not applicable: ${r.not_applicable}`}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ScheduleEditor({ schedule, rules, presets, onClose, onSave }: {
  schedule: SweepSchedule | null;
  rules: LinterRule[];
  presets: Record<string, string>;
  onClose: () => void;
  onSave: (body: ScheduleBody) => Promise<void>;
}) {
  const [body, setBody] = useState<ScheduleBody>(
    schedule ?? { name: "", description: "", projects: [], presets: ["ALL_RULES"], rules: [], exclude: [], interval_hours: 24, paused: false },
  );
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.drive.folder(null).then((f) => setProjects(f.items.filter((i) => i.kind === "project")), () => {});
  }, []);
  const toggle = (key: "projects" | "presets" | "rules" | "exclude", v: string) =>
    setBody((b) => ({ ...b, [key]: b[key].includes(v) ? b[key].filter((x) => x !== v) : [...b[key], v] }));
  const applicable = rules.filter((r) => r.applicable);
  return (
    <Modal title={schedule ? "Edit sweep schedule" : "New sweep schedule"} icon="clock" onClose={onClose} wide>
      <div className="max-h-[70vh] space-y-4 overflow-y-auto p-5 text-xs">
        <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
          <label className="block text-muted">
            Name
            <input value={body.name} onChange={(e) => setBody({ ...body, name: e.target.value })} className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-muted">
            Every (hours)
            <input type="number" min={1} value={body.interval_hours} onChange={(e) => setBody({ ...body, interval_hours: Number(e.target.value) || 24 })} className={`${inputClass} mt-1`} />
          </label>
        </div>
        <label className="block text-muted">
          Description
          <input value={body.description} onChange={(e) => setBody({ ...body, description: e.target.value })} className={`${inputClass} mt-1`} />
        </label>
        <div>
          <div className="mb-1 font-semibold text-soft">Resource scope</div>
          <p className="mb-1 text-muted">No Project selected: every Project.</p>
          <div className="flex flex-wrap gap-1.5">
            {projects.map((p) => (
              <button key={p.id} type="button" onClick={() => toggle("projects", p.id)} className={`rounded-full border px-2 py-0.5 ${body.projects.includes(p.id) ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-soft"}`}>
                {p.name}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 font-semibold text-soft">Rule scope · 1. presets</div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(presets).map(([k, v]) => (
              <button key={k} type="button" title={v} onClick={() => toggle("presets", k)} className={`rounded-full border px-2 py-0.5 font-mono ${body.presets.includes(k) ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-soft"}`}>
                {k}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <RulePick title="2. Rules added" rules={applicable} picked={body.rules} onToggle={(id) => toggle("rules", id)} />
          <RulePick title="3. Rules excluded" rules={applicable} picked={body.exclude} onToggle={(id) => toggle("exclude", id)} />
        </div>
        {err && <p className="text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!body.name.trim()}
            onClick={async () => {
              setErr(null);
              try {
                await onSave(body);
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RulePick({ title, rules, picked, onToggle }: { title: string; rules: LinterRule[]; picked: string[]; onToggle: (id: string) => void }) {
  return (
    <div>
      <div className="mb-1 font-semibold text-soft">{title}</div>
      <div className="max-h-48 space-y-0.5 overflow-y-auto rounded border border-line-2 p-2">
        {rules.map((r) => (
          <label key={r.id} className="flex items-center gap-2 text-soft">
            <input type="checkbox" checked={picked.includes(r.id)} onChange={() => onToggle(r.id)} /> {r.name}
          </label>
        ))}
      </div>
    </div>
  );
}
