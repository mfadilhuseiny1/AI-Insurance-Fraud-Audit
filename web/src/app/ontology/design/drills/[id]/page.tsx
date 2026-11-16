"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, Card, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { design, ROLE_LABEL, STEP_LABEL, type Answer, type Drill, type Question, type Role, type Session, type Symptom } from "@/lib/design";
import { ontology, type ObjectType } from "@/lib/ontology";
import { DrillRace } from "@/components/ontology/DrillRace";

type Tab = "questions" | "race" | "record" | "results" | "sessions";
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const mins = (s: number | null) => (s === null ? "—" : s < 120 ? `${s}s` : `${Math.round(s / 60)} min`);
const blankAnswer = (q: Question): Answer => ({ question_id: q.id, correct: null, seconds: null, assisted: false, path: [], searched: [], symptoms: [], expected: "", notes: "", answer: "" });

/** A validation drill: questions, recording sessions (people and agents), results and the leaderboard. */
export default function DrillPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [d, setD] = useState<Drill | null>(null);
  const [tab, setTab] = useState<Tab>("questions");
  const [symptoms, setSymptoms] = useState<Symptom[]>([]);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [agentMode, setAgentMode] = useState<"query" | "plan">("query");
  const load = useCallback(() => {
    design.drill(id).then(setD, (e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    design.symptoms().then(setSymptoms, () => setSymptoms([]));
    ontology.objectTypes().then(setTypes, () => setTypes([]));
  }, []);
  if (error && !d) return <ApiError message={error} />;
  if (!d) return <Loading />;
  const save = async (body: Partial<Drill>) => {
    setError(null);
    try {
      setD(await design.saveDrill(d.id, { name: d.name, description: d.description, format: d.format, time_limit_minutes: d.time_limit_minutes, allowed_apps: d.allowed_apps, questions: d.questions, ...body }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="dot-grid flex-1 overflow-y-auto">
      <AppHeader app="Nexus Manager" icon="cube" href="/ontology" crumbs={[{ label: "Design review", href: "/ontology/design?tab=drills" }, { label: d.name }]}>
        <select value={agentMode} onChange={(e) => setAgentMode(e.target.value as "query" | "plan")} className={`${inputClass} w-44`} aria-label="Agent mode">
          <option value="query">Agent queries the data</option>
          <option value="plan">Agent plans from schema</option>
        </select>
        <button
          type="button"
          disabled={busy || d.questions.length === 0}
          title={agentMode === "query" ? "A language model queries the ontology (as you) step by step until it answers each question" : "Ask a language model to plan a path for each question from the ontology's schema only"}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setD(await design.agentRun(d.id, agentMode));
              setTab("sessions");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
          className={buttonClass.secondary}
        >
          <Icon name="sparkle" className="h-3.5 w-3.5" /> {busy ? "Agent running…" : "Run with an AI agent"}
        </button>
        <button
          type="button"
          onClick={async () => {
            if (await confirmDialog(`Delete the drill "${d.name}" and its sessions?`)) {
              await design.deleteDrill(d.id);
              router.push("/ontology/design?tab=drills");
            }
          }}
          className={buttonClass.secondary}
        >
          <Icon name="trash" className="h-3.5 w-3.5" />
        </button>
      </AppHeader>
      <div className="mx-auto max-w-6xl space-y-4 p-8">
        <div>
          <h1 className="text-xl font-semibold">{d.name}</h1>
          <p className="text-sm text-muted">
            {d.format === "quiz" ? "Quiz-style game" : "Timed drill-down"} · {d.questions.length} questions · {d.sessions.length} sessions
          </p>
        </div>
        <ErrorBox message={error} />
        <div className="flex gap-1 border-b border-line text-sm">
          {(
            [
              ["questions", "Setup & questions"],
              ["race", "Team race"],
              ["record", "Record a session"],
              ["results", "Results"],
              ["sessions", `Sessions (${d.sessions.length})`],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3 py-2 ${tab === k ? "border-ocean text-white" : "border-transparent text-muted hover:text-white"}`}>
              {label}
            </button>
          ))}
        </div>
        {tab === "questions" && <Setup d={d} setD={setD} save={save} />}
        {tab === "race" && (
          <DrillRace
            d={d}
            onFinished={(next) => {
              setD(next);
              setTab("results");
            }}
          />
        )}
        {tab === "record" && (
          <Recorder
            key={editing?.id ?? "new"}
            d={d}
            types={types}
            symptoms={symptoms}
            session={editing}
            onSaved={(next) => {
              setD(next);
              setEditing(null);
              setTab("results");
            }}
          />
        )}
        {tab === "results" && <Results d={d} />}
        {tab === "sessions" && (
          <Card title="Sessions" count={d.sessions.length}>
            <div className="divide-y divide-line text-sm">
              {d.sessions.map((s) => (
                <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Icon name={s.role === "agent" ? "sparkle" : "project"} className="h-4 w-4 text-muted" />
                  <span className="font-medium">{s.participant}</span>
                  <span className="text-xs text-muted">
                    {ROLE_LABEL[s.role]}
                    {s.team ? ` · team ${s.team}` : ""} · {s.answers.filter((a) => a.correct).length}/{s.answers.length} correct · {when(s.at)}
                    {s.model ? ` · ${s.model}` : ""}
                    {s.agent_mode ? ` · ${s.agent_mode === "query" ? "queried the data" : "planned from schema"}` : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(s);
                      setTab("record");
                    }}
                    className="ml-auto text-xs text-ocean hover:underline"
                  >
                    {s.role === "agent" ? "Judge answers" : "Edit"}
                  </button>
                  <button type="button" onClick={async () => (await confirmDialog("Delete this session?")) && setD(await design.deleteSession(d.id, s.id))} className="text-muted hover:text-bad">
                    <Icon name="trash" className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {d.sessions.length === 0 && <p className="px-4 py-3 text-xs text-muted">No sessions yet.</p>}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function Setup({ d, setD, save }: { d: Drill; setD: (d: Drill) => void; save: (b: Partial<Drill>) => Promise<void> }) {
  const qs = d.questions;
  const setQ = (i: number, c: Partial<Question>) => setD({ ...d, questions: qs.map((q, j) => (j === i ? { ...q, ...c } : q)) });
  return (
    <>
      <Card title="Setup" action={<button type="button" onClick={() => save({})} className={buttonClass.primary}>Save</button>}>
        <div className="grid gap-3 p-4 text-sm sm:grid-cols-2">
          <Field label="Name">
            <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Format">
            <select value={d.format} onChange={(e) => setD({ ...d, format: e.target.value as Drill["format"] })} className={inputClass}>
              <option value="quiz">Quiz-style game (breadth, teams race)</option>
              <option value="drilldown">Timed drill-down (depth, one investigation)</option>
            </select>
          </Field>
          <Field label="Description">
            <input value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} className={inputClass} />
          </Field>
          <Field label="Time limit (minutes)">
            <input type="number" value={d.time_limit_minutes ?? ""} onChange={(e) => setD({ ...d, time_limit_minutes: e.target.value ? Number(e.target.value) : null })} className={inputClass} />
          </Field>
          <Field label="Allowed applications" hint="General-purpose analytical apps only: purpose-built Workshop apps hide weak design">
            <input value={d.allowed_apps.join(", ")} onChange={(e) => setD({ ...d, allowed_apps: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} className={inputClass} />
          </Field>
        </div>
      </Card>
      <Card
        title="Questions"
        count={qs.length}
        action={
          <button type="button" onClick={() => setD({ ...d, questions: [...qs, { id: "", text: "", step: "situation", points: 1, expected_answer: "", source: "" }] })} className={buttonClass.secondary}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Question
          </button>
        }
      >
        <div className="space-y-3 p-4 text-sm">
          <p className="text-xs text-muted">
            Keep questions hidden until the drill begins. Start where a leader recognizes a condition, then trace the factors and assess the impact; give multi-step questions more points. Keep questions the ontology cannot answer: the failure is a result.
          </p>
          {qs.map((q, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-line-2 p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">Q{i + 1}</span>
                <input value={q.text} onChange={(e) => setQ(i, { text: e.target.value })} placeholder="Which facilities have output below plan this week, and why?" className={`${inputClass} flex-1`} />
                <button type="button" onClick={() => setD({ ...d, questions: qs.filter((_, j) => j !== i) })} className="text-muted hover:text-bad">
                  <Icon name="trash" className="h-4 w-4" />
                </button>
              </div>
              <div className="grid gap-2 sm:grid-cols-4">
                <select value={q.step} onChange={(e) => setQ(i, { step: e.target.value as Question["step"] })} className={`${fieldClass} text-xs`}>
                  {Object.entries(STEP_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <input type="number" min={1} value={q.points} onChange={(e) => setQ(i, { points: Number(e.target.value) || 1 })} className={`${fieldClass} text-xs`} title="Points" />
                <input value={q.expected_answer} onChange={(e) => setQ(i, { expected_answer: e.target.value })} placeholder="Expected answer (for judges)" className={`${fieldClass} text-xs`} />
                <input value={q.source} onChange={(e) => setQ(i, { source: e.target.value })} placeholder="Source (a recurring ask, a report…)" className={`${fieldClass} text-xs`} />
              </div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

function Recorder({ d, types, symptoms, session, onSaved }: { d: Drill; types: ObjectType[]; symptoms: Symptom[]; session: Session | null; onSaved: (d: Drill) => void }) {
  const [participant, setParticipant] = useState(session?.participant ?? "");
  const [role, setRole] = useState<Role>(session?.role ?? "new_user");
  const [team, setTeam] = useState(session?.team ?? "");
  const [format, setFormat] = useState<Session["assisted_format"]>(session?.assisted_format ?? "individual");
  const [answers, setAnswers] = useState<Answer[]>(() => d.questions.map((q) => session?.answers.find((a) => a.question_id === q.id) ?? blankAnswer(q)));
  const [timer, setTimer] = useState<{ i: number; start: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setA = (i: number, c: Partial<Answer>) => setAnswers(answers.map((a, j) => (j === i ? { ...a, ...c } : a)));
  const save = async () => {
    setError(null);
    const body = { participant, role, team, assisted_format: format, answers: answers.filter((a) => a.correct !== null || a.seconds !== null || a.symptoms.length || a.path.length || a.notes) };
    try {
      onSaved(session ? await design.saveSession(d.id, session.id, body) : await design.addSession(d.id, body));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      <Card title={session ? `Session: ${session.participant}` : "New session"}>
        <div className="grid gap-3 p-4 text-sm sm:grid-cols-4">
          <Field label="Participant">
            <input value={participant} onChange={(e) => setParticipant(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Role" hint="Domain experts who did not build the ontology give the strongest evidence">
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={inputClass}>
              {Object.entries(ROLE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Team">
            <input value={team} onChange={(e) => setTeam(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Format">
            <select value={format} onChange={(e) => setFormat(e.target.value as Session["assisted_format"])} className={inputClass}>
              <option value="individual">Individual</option>
              <option value="team">Team (unassisted attempt first)</option>
            </select>
          </Field>
        </div>
      </Card>
      {d.questions.map((q, i) => {
        const a = answers[i];
        const running = timer?.i === i;
        return (
          <Card key={q.id} title={`Q${i + 1} · ${q.points} pt${q.points === 1 ? "" : "s"}`}>
            <div className="space-y-3 p-4 text-sm">
              <p className="font-medium">{q.text}</p>
              {q.expected_answer && <p className="text-xs text-muted">Expected: {q.expected_answer}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (running) {
                      setA(i, { seconds: (a.seconds ?? 0) + Math.round((Date.now() - timer.start) / 1000) });
                      setTimer(null);
                    } else setTimer({ i, start: Date.now() });
                  }}
                  className={running ? buttonClass.primary : buttonClass.secondary}
                >
                  <Icon name={running ? "pause" : "play"} className="h-3.5 w-3.5" /> {running ? "Stop timer" : "Start timer"}
                </button>
                <input type="number" value={a.seconds ?? ""} onChange={(e) => setA(i, { seconds: e.target.value ? Number(e.target.value) : null })} placeholder="seconds" className={`${fieldClass} w-24 text-xs`} />
                <select value={a.correct === null ? "" : a.correct ? "yes" : "no"} onChange={(e) => setA(i, { correct: e.target.value === "" ? null : e.target.value === "yes" })} className={`${fieldClass} text-xs`}>
                  <option value="">Not judged</option>
                  <option value="yes">Correct, path shown</option>
                  <option value="no">Wrong or unsupported</option>
                </select>
                <label className="flex items-center gap-1 text-xs text-muted">
                  <input type="checkbox" checked={a.assisted} onChange={(e) => setA(i, { assisted: e.target.checked })} /> needed help
                </label>
              </div>
              <Field label="Path followed" hint="Object types and links in order">
                <div className="flex flex-wrap items-center gap-1.5">
                  {a.path.map((p, k) => (
                    <span key={k} className="flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5 text-xs ring-1 ring-line-2">
                      {k > 0 && <Icon name="right" className="h-3 w-3 text-muted" />}
                      {p}
                      <button type="button" onClick={() => setA(i, { path: a.path.filter((_, j) => j !== k) })} className="text-muted hover:text-bad">
                        <Icon name="x" className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <select value="" onChange={(e) => e.target.value && setA(i, { path: [...a.path, e.target.value] })} className={`${fieldClass} py-0.5 text-xs`}>
                    <option value="">+ object type…</option>
                    {types.map((t) => (
                      <option key={t.id} value={t.display_name}>
                        {t.display_name}
                      </option>
                    ))}
                  </select>
                </div>
              </Field>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Terms searched">
                  <input value={a.searched.join(", ")} onChange={(e) => setA(i, { searched: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="client, shipment delay" className={inputClass} />
                </Field>
                <Field label="When confused, what did they expect to find?">
                  <input value={a.expected} onChange={(e) => setA(i, { expected: e.target.value })} placeholder="A Shipment object type linked to Order" className={inputClass} />
                </Field>
              </div>
              <Field label="Observed">
                <div className="flex flex-wrap gap-1.5">
                  {symptoms.map((s) => {
                    const on = a.symptoms.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        title={`Review: ${s.review}`}
                        onClick={() => setA(i, { symptoms: on ? a.symptoms.filter((x) => x !== s.id) : [...a.symptoms, s.id] })}
                        className={`rounded-full px-2 py-0.5 text-xs ring-1 ${on ? "bg-warn/15 text-warn ring-warn/40" : "text-muted ring-line-2 hover:text-white"}`}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </Field>
              <Field label="Notes">
                <input value={a.notes} onChange={(e) => setA(i, { notes: e.target.value })} className={inputClass} />
              </Field>
            </div>
          </Card>
        );
      })}
      <ErrorBox message={error} />
      <div className="flex justify-end">
        <button type="button" disabled={!participant.trim()} onClick={save} className={buttonClass.primary}>
          Save session
        </button>
      </div>
    </div>
  );
}

function Results({ d }: { d: Drill }) {
  const r = d.results;
  return (
    <div className="space-y-4">
      <Card title="Per question">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Question</th>
              <th className="px-4 py-2 font-medium">Success</th>
              <th className="px-4 py-2 font-medium">Median time</th>
              {(["builder", "domain_expert", "new_user", "agent"] as Role[]).map((x) => (
                <th key={x} className="px-4 py-2 font-medium">
                  {ROLE_LABEL[x]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r.questions.map((qr, i) => {
              const q = d.questions.find((x) => x.id === qr.question_id);
              return (
                <tr key={qr.question_id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-2">
                    <div>
                      Q{i + 1}. {q?.text}
                    </div>
                    <div className="mt-1 space-y-0.5 text-xs text-muted">
                      {qr.people_vs_agents && <div className="text-soft">People vs agents: {qr.people_vs_agents.review}</div>}
                      {qr.paths.map((p) => (
                        <div key={p.path}>
                          Path ×{p.count}: {p.path}
                        </div>
                      ))}
                      {qr.searched.length > 0 && <div>Searched: {qr.searched.join(", ")}</div>}
                      {qr.expected.map((x) => (
                        <div key={x}>Expected to find: {x}</div>
                      ))}
                      {qr.assisted > 0 && <div>{qr.assisted} needed help</div>}
                    </div>
                  </td>
                  <td className="px-4 py-2 tabular-nums">{pct(qr.success)}</td>
                  <td className="px-4 py-2 tabular-nums">{mins(qr.median_seconds)}</td>
                  {(["builder", "domain_expert", "new_user", "agent"] as Role[]).map((x) => (
                    <td key={x} className="px-4 py-2 text-xs tabular-nums">
                      {qr.by_role[x].answers ? `${pct(qr.by_role[x].success)} · ${mins(qr.by_role[x].median_seconds)}` : "—"}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <div className="grid gap-4 md:grid-cols-[1fr_280px]">
        <Card title="What you observed → what to review">
          <div className="divide-y divide-line text-sm">
            {r.symptoms.map((s) => (
              <div key={s.id} className="flex gap-3 px-4 py-2.5">
                <span className="w-8 text-right tabular-nums text-muted">×{s.count}</span>
                <div className="flex-1">
                  <div className="font-medium">
                    {s.label} {s.systemic && <span className="ml-1 rounded bg-warn/15 px-1.5 text-[11px] text-warn">repeated: likely systemic</span>}
                  </div>
                  <div className="text-xs text-muted">Review: {s.review}</div>
                </div>
                {s.rule && (
                  <Link href="/ontology/design?tab=review" className="h-fit text-xs text-ocean hover:underline">
                    Design review
                  </Link>
                )}
              </div>
            ))}
            {r.symptoms.length === 0 && <p className="px-4 py-3 text-xs text-muted">No symptoms recorded.</p>}
          </div>
        </Card>
        <Card title="Leaderboard">
          <div className="divide-y divide-line text-sm">
            {r.leaderboard.map((x, i) => (
              <div key={x.team} className="flex items-center gap-2 px-4 py-2">
                <span className="w-5 text-muted">{i + 1}.</span> {x.team}
                <span className="ml-auto font-semibold tabular-nums">{x.points}</span>
              </div>
            ))}
            {r.leaderboard.length === 0 && <p className="px-4 py-3 text-xs text-muted">No points yet.</p>}
          </div>
        </Card>
      </div>
      <p className="text-xs text-muted">
        Not every difficult task needs an ontology change: first decide whether the constraint is in the model, the data, permissions, the application or training. Treat one failure as an edge case, repeated confusion around the same type or link as a design problem.
      </p>
    </div>
  );
}
