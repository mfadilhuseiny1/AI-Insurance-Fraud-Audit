"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, Badge, Card, EMPTY_BOX, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { promptDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { design, findingHref, type DrillSummary, type Finding, type Review, type ReviewSnapshot, type Severity } from "@/lib/design";
import { om, type BranchRow } from "@/lib/ontologyModel";

type Tab = "review" | "guidelines" | "drills";
const SEV_CLASS: Record<Severity, string> = { high: "bg-bad/15 text-bad", medium: "bg-warn/15 text-warn", low: "bg-panel-2 text-soft" };
const STATUS_ICON = { pass: ["check", "text-ok"], warn: ["alert", "text-warn"], fail: ["x", "text-bad"], todo: ["clock", "text-muted"] } as const;

export default function DesignPage() {
  return (
    <Suspense>
      <Design />
    </Suspense>
  );
}

/** Ontology design: a design review of anti-patterns, the design guidelines checklist and task-based validation drills. */
function Design() {
  const params = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>((params.get("tab") as Tab) || "review");
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branchId, setBranchId] = useState(params.get("branch") ?? "");
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const load = useCallback(() => {
    design.review(undefined, branchId || undefined).then(setReview, (e: Error) => setError(e.message));
  }, [branchId]);
  useEffect(load, [load]);
  useEffect(() => {
    om.branches({ status: "open" }).then(setBranches, () => setBranches([]));
  }, []);
  if (error && !review) return <ApiError message={error} />;
  return (
    <div className="dot-grid flex-1 overflow-y-auto">
      <AppHeader app="Nexus Manager" icon="cube" href="/ontology" crumbs={[{ label: "Design review" }]}>
        <select
          value={branchId}
          onChange={(e) => {
            setBranchId(e.target.value);
            router.replace(`/ontology/design?tab=${tab}${e.target.value ? `&branch=${e.target.value}` : ""}`);
          }}
          className={`${inputClass} w-56`}
          aria-label="Branch"
        >
          <option value="">Main</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              Branch: {b.name}
            </option>
          ))}
        </select>
        {review?.settings && (
          <label className="flex items-center gap-1.5 text-xs text-muted" title="Proposals cannot merge while their branch introduces high-severity findings (ontology owners change this)">
            <input
              type="checkbox"
              checked={review.settings.block_merge_on_high}
              onChange={(e) => design.settings({ block_merge_on_high: e.target.checked }).then((st) => setReview({ ...review, settings: st }), (er: Error) => setError(er.message))}
            />
            Block merges on new high findings
          </label>
        )}
        <button type="button" onClick={load} className={buttonClass.secondary}>
          <Icon name="refresh" className="h-3.5 w-3.5" /> Re-run review
        </button>
      </AppHeader>
      <div className="mx-auto max-w-6xl p-8">
        <h1 className="text-xl font-semibold">Nexus design</h1>
        <p className="mt-1 text-sm text-muted">
          Model reality, not systems. The review checks the ontology against the core design principles and the common anti-patterns; drills test it against real business questions with people and agents.
        </p>
        <div className="mt-5 flex gap-1 border-b border-line text-sm">
          {(
            [
              ["review", "Design review"],
              ["guidelines", "Guidelines"],
              ["drills", "Validation drills"],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setTab(k);
                router.replace(`/ontology/design?tab=${k}`);
              }}
              className={`-mb-px border-b-2 px-3 py-2 ${tab === k ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {!review ? <Loading /> : tab === "review" ? <ReviewTab key={branchId} review={review} reload={load} branchId={branchId} /> : tab === "guidelines" ? <Guidelines review={review} /> : <Drills />}
      </div>
    </div>
  );
}

function ReviewTab({ review, reload, branchId }: { review: Review; reload: () => void; branchId: string }) {
  const [rule, setRule] = useState("");
  const [sev, setSev] = useState("");
  const [showDismissed, setShowDismissed] = useState(false);
  const [onlyNew, setOnlyNew] = useState(false);
  const shown = review.findings.filter((f) => (!rule || f.rule === rule) && (!sev || f.severity === sev) && (showDismissed || !f.dismissed) && (!onlyNew || f.new_on_branch));
  const active = review.findings.filter((f) => !f.dismissed);
  const grouped = useMemo(() => {
    const m = new Map<string, Finding[]>();
    for (const f of shown) m.set(f.anti_pattern, [...(m.get(f.anti_pattern) ?? []), f]);
    return [...m.entries()];
  }, [shown]);
  const counts = { high: active.filter((f) => f.severity === "high").length, medium: active.filter((f) => f.severity === "medium").length, low: active.filter((f) => f.severity === "low").length };
  return (
    <div className="mt-5 space-y-4">
      {review.vs_main && review.branch && (
        <div className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-sm">
          <Icon name="split" className="h-4 w-4 text-ocean" />
          <span>
            Branch <Link href={`/ontology/branches/${review.branch.id}`} className="text-ocean hover:underline">{review.branch.name}</Link> compared with main:{" "}
            <span className="text-bad">+{review.vs_main.new.length} new</span> · <span className="text-ok">−{review.vs_main.resolved.length} resolved</span>
          </span>
          <label className="ml-auto flex items-center gap-2 text-xs text-soft">
            <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> Only new on this branch
          </label>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-line bg-panel p-4">
          <div className={`text-3xl font-semibold tabular-nums ${review.score >= 80 ? "text-ok" : review.score >= 50 ? "text-warn" : "text-bad"}`}>{review.score}</div>
          <div className="text-xs text-muted">Design score · {review.checked.object_types} object types</div>
        </div>
        {(["high", "medium", "low"] as Severity[]).map((s) => (
          <button key={s} type="button" onClick={() => setSev(sev === s ? "" : s)} className={`rounded-xl border bg-panel p-4 text-left ${sev === s ? "border-ocean" : "border-line"}`}>
            <div className="text-3xl font-semibold tabular-nums">{counts[s]}</div>
            <div className="text-xs capitalize text-muted">{s} severity</div>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select value={rule} onChange={(e) => setRule(e.target.value)} className={`${inputClass} w-72`}>
          <option value="">All anti-patterns and principles</option>
          {Object.entries(review.anti_patterns).map(([k, v]) => (
            <option key={k} value={k}>
              {v} ({review.by_rule[k] ?? 0})
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-soft">
          <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} /> Show dismissed
        </label>
        <span className="ml-auto text-xs text-muted">Checked {when(review.checked.at)}</span>
      </div>
      {grouped.length === 0 && (
        <div className="rounded-xl border border-line bg-panel p-8 text-center text-sm text-muted">
          <Icon name="check" className="mx-auto mb-2 h-6 w-6 text-ok" />
          No findings. Validate the design with a drill next.
        </div>
      )}
      {grouped.map(([ap, fs]) => (
        <Card key={ap} title={ap} count={fs.length}>
          <div className="divide-y divide-line">
            {fs.map((f) => (
              <div key={f.id} className={`flex gap-3 px-4 py-3 text-sm ${f.dismissed ? "opacity-60" : ""}`}>
                <span className={`h-fit rounded px-1.5 py-0.5 text-[11px] font-medium capitalize ${SEV_CLASS[f.severity]}`}>{f.severity}</span>
                <div className="min-w-0 flex-1">
                  <Link href={findingHref(f)} className="font-medium text-ocean hover:underline">
                    {f.resource_name}
                  </Link>
                  <span className="ml-2 text-xs text-muted">{f.resource_kind.replace("_", " ")}</span>
                  {f.new_on_branch && <span className="ml-2 rounded bg-warn/15 px-1.5 py-0.5 text-[11px] text-warn">new on branch</span>}
                  <p className="mt-0.5 text-soft">{f.message}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    <Icon name="sparkle" className="mr-1 inline h-3 w-3" />
                    {f.suggestion}
                  </p>
                  {f.dismissed && (
                    <p className="mt-1 text-xs text-muted">
                      Dismissed by {f.dismissed.by}: “{f.dismissed.reason}”
                    </p>
                  )}
                </div>
                {f.dismissed ? (
                  <button type="button" onClick={() => design.restore(f.id).then(reload)} className="h-fit text-xs text-ocean hover:underline">
                    Restore
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      const reason = await promptDialog("Why is this acceptable here? (a pragmatic tradeoff)", "", { title: "Dismiss finding" });
                      if (reason) await design.dismiss(f.id, reason).then(reload);
                    }}
                    className="h-fit text-xs text-muted hover:text-white"
                  >
                    Dismiss
                  </button>
                )}
              </div>
            ))}
          </div>
        </Card>
      ))}
      <History branchId={branchId} at={review.checked.at} />
    </div>
  );
}

/** Snapshots of the review (taken when its findings change): score, counts, findings added and resolved. */
function History({ branchId, at }: { branchId: string; at: string }) {
  const [rows, setRows] = useState<ReviewSnapshot[] | null>(null);
  useEffect(() => {
    design.history(branchId || undefined).then(setRows, () => setRows([]));
  }, [branchId, at]);
  if (!rows?.length) return null;
  return (
    <Card title={branchId ? "Review history of this branch" : "Review history"} count={rows.length}>
      <table className="w-full text-sm">
        <thead className="border-b border-line text-left text-xs text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">When</th>
            <th className="px-4 py-2 font-medium">Score</th>
            <th className="px-4 py-2 font-medium">High / medium / low</th>
            <th className="px-4 py-2 font-medium">Changes since the previous snapshot</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((h) => (
            <tr key={h.at} className="align-top">
              <td className="px-4 py-2 text-xs text-muted">
                {when(h.at)}
                {h.proposal_id && <div>proposal {h.proposal_id}</div>}
              </td>
              <td className="px-4 py-2 tabular-nums">{h.score}</td>
              <td className="px-4 py-2 tabular-nums text-xs">
                {h.by_severity.high} / {h.by_severity.medium} / {h.by_severity.low}
              </td>
              <td className="px-4 py-2 text-xs">
                {!h.added.length && !h.resolved.length && <span className="text-muted">First snapshot</span>}
                {h.added.slice(0, 5).map((a) => (
                  <div key={a.id} className="text-bad">
                    + {a.label}
                  </div>
                ))}
                {h.resolved.slice(0, 5).map((a) => (
                  <div key={a.id} className="text-ok">
                    − {a.label}
                  </div>
                ))}
                {h.added.length + h.resolved.length > 10 && <div className="text-muted">and more ({h.added.length} added, {h.resolved.length} resolved)</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Guidelines({ review }: { review: Review }) {
  return (
    <div className="mt-5 space-y-4">
      <Card title="Design guidelines">
        <div className="divide-y divide-line">
          {review.guidelines.map((g, i) => {
            const [icon, cls] = STATUS_ICON[g.status];
            return (
              <div key={g.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                <span className="w-5 text-right text-xs text-muted">{i + 1}.</span>
                <Icon name={icon} className={`mt-0.5 h-4 w-4 ${cls}`} />
                <div className="flex-1">
                  <div className="font-medium">{g.title}</div>
                  <div className="text-xs text-muted">{g.description}</div>
                </div>
                <span className="text-xs text-soft">{g.note}</span>
              </div>
            );
          })}
        </div>
      </Card>
      <Card title="Core design principles (in priority order)">
        <table className="w-full text-sm">
          <tbody>
            {[
              ["Domain-driven design", "Model the real world, not the source data.", "system_silos"],
              ["Do not repeat yourself", "If you built the same thing three times, refactor.", "dry"],
              ["Open for extension, closed for modification", "Protect core models. Enable builders to extend them.", ""],
              ["Composition over deep hierarchies", "Favor multiple inheritance via interfaces. Keep things pluggable.", "composition"],
            ].map(([p, idea, rule], i) => (
              <tr key={p} className="border-b border-line last:border-0">
                <td className="w-10 px-4 py-2 text-muted">{i + 1}</td>
                <td className="px-4 py-2 font-medium">{p}</td>
                <td className="px-4 py-2 text-soft">{idea}</td>
                <td className="px-4 py-2 text-right text-xs text-muted">{rule ? `${review.by_rule[rule] ?? 0} findings` : "Use statuses, branches and proposals"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="text-xs text-muted">
        Practical considerations always factor in: dismiss a finding with the reason when a tradeoff is deliberate. Naming rules: singular concrete nouns for object types, self-evident property names without encoded types, links named by relationship from each side, one date convention, qualified
        ambiguous terms.
      </p>
    </div>
  );
}

function Drills() {
  const router = useRouter();
  const [rows, setRows] = useState<DrillSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [format, setFormat] = useState<"quiz" | "drilldown">("quiz");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    design.drills().then(setRows, (e: Error) => setError(e.message));
  }, []);
  return (
    <div className="mt-5 space-y-4">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-sm text-muted">
          A structural review cannot confirm anyone can use the ontology. Drills test it with business questions participants have not seen, using only general-purpose apps (Object Explorer, Quiver), and record how long each answer takes and where people get stuck.
        </p>
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" /> New drill
        </button>
      </div>
      <ErrorBox message={error} />
      {rows?.length === 0 ? (
        <button type="button" onClick={() => setCreating(true)} className={EMPTY_BOX}>
          <span className="mb-3 rounded-full bg-panel-2 p-3 text-sand ring-1 ring-line-2">
            <Icon name="check" className="h-6 w-6" />
          </span>
          <span className="font-semibold">Create a validation drill</span>
          <span className="mt-1 text-sm text-muted">Source questions from what leaders repeatedly ask, what teams need from each other, and the reports that exist because answers are hard to assemble.</span>
        </button>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rows?.map((d) => (
            <Link key={d.id} href={`/ontology/design/drills/${d.id}`} className="rounded-xl border border-line bg-panel p-4 hover:border-ocean/50">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{d.name}</span>
                <Badge status="active" label={d.format === "quiz" ? "Quiz-style game" : "Timed drill-down"} />
              </div>
              {d.description && <p className="mt-1 text-xs text-muted">{d.description}</p>}
              <div className="mt-2 text-xs text-soft">
                {d.questions} questions · {d.sessions} sessions · updated {when(d.updated_at)}
              </div>
            </Link>
          ))}
        </div>
      )}
      {creating && (
        <Modal title="New validation drill" icon="check" onClose={() => setCreating(false)}>
          <form
            className="space-y-3 p-4"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const d = await design.createDrill({ name, format, questions: [] });
                router.push(`/ontology/design/drills/${d.id}`);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Supply chain drill, Q3" className={inputClass} />
            </Field>
            <Field label="Format">
              <select value={format} onChange={(e) => setFormat(e.target.value as "quiz" | "drilldown")} className={inputClass}>
                <option value="quiz">Quiz-style game: many independent questions, teams race (breadth)</option>
                <option value="drilldown">Timed drill-down: one connected investigation (depth)</option>
              </select>
            </Field>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCreating(false)} className={buttonClass.secondary}>
                Cancel
              </button>
              <button type="submit" disabled={!name.trim()} className={buttonClass.primary}>
                Create
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
