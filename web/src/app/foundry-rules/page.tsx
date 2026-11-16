"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, Badge, Card, ErrorBox } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { BOARD_LABEL, FoundryRuleEditor, blankRule, show } from "@/components/workshop/FoundryRuleEditor";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { ontology, type ObjectType } from "@/lib/ontology";
import { om, type LinkType } from "@/lib/ontologyModel";
import { rulesApi, type Proposal, type Rule, type Workflow } from "@/lib/foundryRules";

/**
 * Foundry Rules: workflows of point-and-click rules over Ontology objects and datasets — rule logic blocks with
 * previews, permitted output values, proposals with diffs and review, and runs that write alert objects and datasets.
 */
export default function FoundryRulesPage() {
  const [list, setList] = useState<Workflow[] | null>(null);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [links, setLinks] = useState<LinkType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [wid, setWid] = useState<string | null>(null);
  const [tab, setTab] = useState<"rules" | "proposals" | "runs" | "configuration">("rules");
  const reload = useCallback(() => rulesApi.workflows().then(setList, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void reload();
    Promise.all([ontology.objectTypes(), om.linkTypes()]).then(([t, l]) => (setTypes(t), setLinks(l)), () => undefined);
  }, [reload]);
  if (error && !list) return <ApiError message={error} />;
  if (!list) return <Loading />;
  const w = list.find((x) => x.id === (wid ?? list[0]?.id));
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Foundry Rules" icon="sliders" href="/foundry-rules" crumbs={w ? [{ label: w.name }] : []}>
        {w && (
          <button
            type="button"
            onClick={async () => {
              try {
                await rulesApi.run(w.id);
                await reload();
                setTab("runs");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            <Icon name="play" className="h-3.5 w-3.5" /> Run workflow
          </button>
        )}
      </AppHeader>
      <div className="flex min-h-0 flex-1">
        <nav className="w-64 shrink-0 overflow-y-auto border-r border-line bg-panel p-2 text-sm">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Workflows</div>
          {list.map((x) => (
            <button key={x.id} type="button" onClick={() => setWid(x.id)} className={`mb-0.5 flex w-full flex-col rounded-md px-2 py-1.5 text-left ${w?.id === x.id ? "bg-ocean/15 text-white" : "text-soft hover:bg-panel-2"}`}>
              <span className="truncate">{x.name}</span>
              <span className="text-[11px] text-muted">
                {x.active_rules} active rules{x.open_proposals ? ` · ${x.open_proposals} open proposals` : ""}
              </span>
            </button>
          ))}
          <NewWorkflow types={types} onCreated={async (x) => (await reload(), setWid(x.id), setTab("configuration"))} />
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
          {!w ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">Create a workflow: its inputs, the output alerts are written to, and the fields rules must fill.</div>
          ) : (
            <div className="mx-auto max-w-6xl space-y-4 p-5">
              <div>
                <h1 className="text-xl font-semibold">{w.name}</h1>
                <p className="mt-1 text-xs text-muted">{w.description}</p>
              </div>
              <ErrorBox message={error} />
              <div className="flex gap-1 border-b border-line">
                {(["rules", "proposals", "runs", "configuration"] as const).map((t) => (
                  <button key={t} type="button" onClick={() => setTab(t)} className={`px-3 py-2 text-xs capitalize ${tab === t ? "border-b-2 border-ocean text-white" : "text-muted hover:text-white"}`}>
                    {t === "proposals" && w.open_proposals ? `Proposals (${w.open_proposals})` : t}
                  </button>
                ))}
              </div>
              {tab === "rules" && <RulesTab key={w.id} w={w} types={types} links={links} onChanged={reload} />}
              {tab === "proposals" && <ProposalsTab key={w.id} w={w} onChanged={reload} />}
              {tab === "runs" && <RunsTab w={w} types={types} />}
              {tab === "configuration" && <ConfigTab key={w.id} w={w} types={types} onSaved={reload} />}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function NewWorkflow({ types, onCreated }: { types: ObjectType[]; onCreated: (w: Workflow) => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-3 px-2">
      <button
        type="button"
        onClick={async () => {
          const name = await promptDialog("Workflow name", "", { title: "New Foundry Rules workflow" });
          if (!name || !types.length) return;
          try {
            onCreated(
              await rulesApi.createWorkflow({
                name,
                description: "",
                inputs: [{ kind: "object_type", id: types[0].id }],
                outputs: [{ id: "alerts", name: "Alerts", object_type_id: null, dataset_name: `${name} alerts`, dataset_id: null, fields: [{ name: "message", type: "string", required: true, column_values: "any", columns: [], static_values: "any", values: [], min: null, max: null, template: true, default: null }] }],
                custom_properties: [],
                boards: ["filter", "expression", "aggregation", "join", "window", "select", "union", "link"],
                editors: [],
                reviewers: [],
                require_proposals: true,
                schedule_minutes: null,
              }),
            );
          } catch (e) {
            setError((e as Error).message);
          }
        }}
        className={`${buttonClass.ghost} w-full`}
      >
        <Icon name="plus" className="h-3.5 w-3.5" /> New workflow
      </button>
      {error && <div className="text-xs text-bad">{error}</div>}
    </div>
  );
}

function RulesTab({ w, types, links, onChanged }: { w: Workflow; types: ObjectType[]; links: LinkType[]; onChanged: () => void }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => rulesApi.rules(w.id).then(setRules, () => setRules([])), [w.id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (editing)
    return (
      <FoundryRuleEditor
        w={w}
        rule={editing}
        types={types}
        links={links}
        submitLabel={w.require_proposals ? "Submit proposal" : "Save rule"}
        cancelLabel="Cancel"
        allowUnchanged
        onCancel={() => setEditing(null)}
        onSubmitted={(p) => {
          setEditing(null);
          setMsg(p.status === "open" ? "Proposal submitted: a reviewer approves it in Proposals." : "Saved.");
          void load();
          onChanged();
        }}
      />
    );
  return (
    <div className="space-y-3">
      {msg && <div className="rounded-md bg-ok/10 px-3 py-2 text-xs text-ok">{msg}</div>}
      <button type="button" onClick={() => setEditing(blankRule(w))} className={buttonClass.primary}>
        <Icon name="plus" className="h-3.5 w-3.5" /> New rule
      </button>
      <Card title="Rules" count={rules.length}>
        <div className="divide-y divide-line text-xs">
          {rules.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-2.5">
              <Badge status={r.status === "active" ? "active" : "deprecated"} label={r.status} />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{r.name}</div>
                <div className="text-muted">
                  {r.logic.blocks.map((b) => BOARD_LABEL[b.kind]).join(" → ")} · v{r.version} · {Object.entries(r.custom).map(([k, v]) => `${k}: ${show(v)}`).join(" · ")}
                </div>
              </div>
              <button type="button" onClick={() => setEditing(JSON.parse(JSON.stringify(r)))} className={buttonClass.ghost}>
                Edit
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (await confirmDialog({ message: `Propose deleting ${r.name}?`, danger: true, confirmLabel: "Propose delete" })) {
                    await rulesApi.proposeDelete(r.id!);
                    setMsg("Delete proposal submitted.");
                    onChanged();
                  }
                }}
                className="text-muted hover:text-bad"
                aria-label="Delete rule"
              >
                <Icon name="trash" className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {!rules.length && <div className="p-4 text-muted">No rules yet.</div>}
        </div>
      </Card>
    </div>
  );
}

function ProposalsTab({ w, onChanged }: { w: Workflow; onChanged: () => void }) {
  const [list, setList] = useState<Proposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => rulesApi.proposals(w.id).then(setList, (e: Error) => setError(e.message)), [w.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const decide = async (p: Proposal, decision: "approve" | "reject") => {
    try {
      await rulesApi.review(p.id, decision);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-3">
      <ErrorBox message={error} />
      {list.map((p) => (
        <Card
          key={p.id}
          title={`${p.kind} · ${p.new?.name ?? p.old?.name ?? p.rule_id}`}
          action={
            <span className="flex items-center gap-1.5">
              {p.stale && (
                <span className="rounded bg-bad/15 px-1.5 py-0.5 text-[11px] font-normal text-bad" title={p.stale_reason ?? undefined} data-fr-stale>
                  stale — rule changed since
                </span>
              )}
              <Badge status={p.status === "open" ? "in_review" : p.status === "approved" ? "active" : "deprecated"} label={p.status} />
            </span>
          }
        >
          <div className="space-y-2 p-4 text-xs">
            <div className="text-muted">
              By {p.author} · {new Date(p.created_at).toLocaleString()}
              {p.reviewer ? ` · reviewed by ${p.reviewer}` : ""}
              {p.review_comment ? ` — ${p.review_comment}` : ""}
            </div>
            {p.stale && (
              <div className="rounded-md border border-bad/40 bg-bad/5 px-2 py-1.5 text-bad" data-fr-stale-note>
                Stale{p.stale_reason ? ` — ${p.stale_reason}` : " — the rule changed since this proposal was made"}. Approving would overwrite the newer version: reject it and propose the change again from the current rule.
              </div>
            )}
            {p.diff.map((d) => (
              <div key={d.field} className="grid gap-2 md:grid-cols-[100px_1fr_1fr]">
                <span className="font-mono text-muted">{d.field}</span>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-bad/5 p-2 text-bad">{d.old === null || d.old === undefined ? "—" : typeof d.old === "string" ? d.old : JSON.stringify(d.old, null, 1)}</pre>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-ok/5 p-2 text-ok">{d.new === null || d.new === undefined ? "—" : typeof d.new === "string" ? d.new : JSON.stringify(d.new, null, 1)}</pre>
              </div>
            ))}
            {p.status === "open" && (
              <div className="flex gap-2">
                <button type="button" disabled={!!p.stale} title={p.stale ? "Stale: the rule changed since this proposal was made" : undefined} onClick={() => decide(p, "approve")} className={buttonClass.primary}>
                  Approve
                </button>
                <button type="button" onClick={() => decide(p, "reject")} className={buttonClass.secondary}>
                  Reject
                </button>
              </div>
            )}
          </div>
        </Card>
      ))}
      {!list.length && <div className="text-xs text-muted">No proposals.</div>}
    </div>
  );
}

function RunsTab({ w, types }: { w: Workflow; types: ObjectType[] }) {
  const runs = [...(w.runs ?? [])].reverse();
  if (!runs.length) return <div className="text-xs text-muted">Not run yet: Run workflow evaluates every active rule and replaces the outputs.</div>;
  return (
    <div className="space-y-3">
      {runs.map((r, i) => (
        <Card key={i} title={new Date(r.at).toLocaleString()} action={<span className="text-[11px] font-normal text-muted">{r.ms} ms · {r.by}</span>}>
          <div className="space-y-2 p-4 text-xs">
            {r.rules.map((x) => (
              <div key={x.rule_id} className="flex gap-2">
                <span className={x.status === "succeeded" ? "text-ok" : "text-bad"}>●</span>
                <span className="flex-1">{x.rule}</span>
                <span className="tabular-nums">{x.rows} rows</span>
                {x.error && <span className="text-bad">{x.error}</span>}
              </div>
            ))}
            <div className="border-t border-line pt-2">
              {r.outputs.map((o, j) => (
                <div key={j}>
                  {o.object_type_id ? (
                    <Link href={`/object-explorer?type=${o.object_type_id}`} className="text-ocean hover:underline">
                      {types.find((t) => t.id === o.object_type_id)?.display_name ?? o.output}: {o.objects} objects (+{o.created} ~{o.modified} −{o.deleted})
                    </Link>
                  ) : (
                    <Link href={`/datasets/${o.dataset_id}`} className="text-ocean hover:underline">
                      Dataset: {o.rows} rows
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function ConfigTab({ w, types, onSaved }: { w: Workflow; types: ObjectType[]; onSaved: () => void }) {
  const [text, setText] = useState(() =>
    JSON.stringify({ name: w.name, description: w.description, inputs: w.inputs, outputs: w.outputs, custom_properties: w.custom_properties, boards: w.boards, editors: w.editors, reviewers: w.reviewers, require_proposals: w.require_proposals, schedule_minutes: w.schedule_minutes }, null, 2),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <div className="space-y-3 text-xs">
      <div className="grid gap-3 md:grid-cols-3">
        <Card title="Inputs">
          <div className="space-y-1 p-3">
            {w.inputs.map((i) => (
              <div key={i.id}>{i.kind === "object_type" ? types.find((t) => t.id === i.id)?.display_name : `Dataset ${i.id}`}</div>
            ))}
          </div>
        </Card>
        <Card title="Outputs">
          <div className="space-y-1 p-3">
            {w.outputs.map((o) => (
              <div key={o.id}>
                {o.name}: {o.fields.map((f) => f.name).join(", ")}
              </div>
            ))}
          </div>
        </Card>
        <Card title="Settings">
          <div className="space-y-1 p-3">
            <div>Proposals: {w.require_proposals ? "required" : "off"}</div>
            <div>Boards: {w.boards.join(", ")}</div>
            <div>Schedule: {w.schedule_minutes ? `every ${w.schedule_minutes} min` : "manual"}</div>
          </div>
        </Card>
      </div>
      <Card title="Workflow configuration (JSON)">
        <div className="space-y-2 p-3">
          <p className="text-muted">
            Output fields: column_values any / none / selection (columns), static_values any / none / selection (values) / range (min, max) / users, required, template, default.
          </p>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={22} className={`${inputClass} font-mono text-[11px]`} />
          <ErrorBox message={error} />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                try {
                  await rulesApi.saveWorkflow(w.id, JSON.parse(text));
                  setError(null);
                  setSaved(true);
                  onSaved();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
              className={buttonClass.primary}
            >
              Save configuration
            </button>
            {saved && <span className="text-ok">Saved</span>}
          </div>
        </div>
      </Card>
    </div>
  );
}
