"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/Icon";
import { Card, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { design, ROLE_LABEL, type Drill, type PastRace, type Race, type Role } from "@/lib/design";
import { captureSnapshot, onCaptureChange, setCapture, type Capture } from "@/lib/drillCapture";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Team race: the judge starts a race with teams and a time limit; participants join (this browser then records the
 * path they take in Object Explorer and object views) and answer against the clock; the judge marks answers and the
 * scoreboard updates; finishing turns the answers into drill sessions.
 */
export function DrillRace({ d, onFinished }: { d: Drill; onFinished: (d: Drill) => void }) {
  const [race, setRace] = useState<Race | null>(null);
  const [past, setPast] = useState<PastRace[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const load = useCallback(
    () =>
      design.race(d.id).then(
        (r) => {
          setRace(r.race);
          setPast(r.past);
          setLoaded(true);
        },
        (e: Error) => setError(e.message),
      ),
    [d.id],
  );
  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 5000);
    const second = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(second);
    };
  }, [load]);
  const run = async (fn: () => Promise<{ race: Race } | unknown>) => {
    setError(null);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "race" in r) setRace((r as { race: Race }).race);
      else await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!loaded) return <ErrorBox message={error} />;
  return (
    <div className="space-y-4">
      <ErrorBox message={error} />
      {race ? <Running d={d} race={race} tick={tick} run={run} onFinished={onFinished} /> : <Start d={d} run={run} />}
      {past.length > 0 && (
        <Card title="Past races" count={past.length}>
          <div className="divide-y divide-line text-sm">
            {[...past].reverse().map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="text-xs text-muted">{when(p.finished_at)}</span>
                <span>{p.participants} participants</span>
                <span className="ml-auto text-xs">{p.scoreboard.map((s, i) => `${i + 1}. ${s.team} (${s.points})`).join(" · ")}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function Start({ d, run }: { d: Drill; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [teams, setTeams] = useState("");
  const [limit, setLimit] = useState(String(d.time_limit_minutes ?? 20));
  return (
    <Card title="Start a team race">
      <div className="space-y-3 p-4 text-sm">
        <p className="text-muted">
          Teams answer the drill&apos;s questions against the clock. Each participant joins from their own browser; what they open in Object Explorer and object views is recorded as their path. You judge
          the answers (an answer equal to the expected answer is marked correct automatically).
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Teams" hint="Comma separated; people can also join under a new team">
            <input value={teams} onChange={(e) => setTeams(e.target.value)} placeholder="Tim Verifikasi, Tim Klaim" className={inputClass} />
          </Field>
          <Field label="Time limit (minutes)">
            <input type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} className={inputClass} />
          </Field>
        </div>
        <button
          type="button"
          disabled={!d.questions.length}
          onClick={() => run(() => design.startRace(d.id, { teams: teams.split(",").map((t) => t.trim()).filter(Boolean), time_limit_minutes: Number(limit) || null }))}
          className={buttonClass.primary}
        >
          <Icon name="play" className="h-3.5 w-3.5" /> Start race
        </button>
      </div>
    </Card>
  );
}

function Running({ d, race, tick, run, onFinished }: { d: Drill; race: Race; tick: number; run: (fn: () => Promise<unknown>) => Promise<void>; onFinished: (d: Drill) => void }) {
  const raw = useSyncExternalStore(onCaptureChange, captureSnapshot, () => "null");
  const me = JSON.parse(raw) as Capture | null;
  const joined = me && me.race_id === race.id ? me : null;
  // the server's elapsed time when last polled, advanced by the local one-second tick
  const [base] = useState(() => ({ elapsed: race.elapsed_seconds, tick }));
  const elapsed = Math.max(race.elapsed_seconds, base.elapsed + (tick - base.tick));
  const remaining = race.time_limit_minutes ? Math.max(0, race.time_limit_minutes * 60 - elapsed) : null;
  const q = (id: string) => d.questions.find((x) => x.id === id);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-panel p-4">
          <div className={`text-3xl font-semibold tabular-nums ${remaining !== null && remaining < 60 ? "text-bad" : ""}`}>{remaining !== null ? clock(remaining) : clock(elapsed)}</div>
          <div className="text-xs text-muted">{remaining !== null ? (remaining === 0 ? "Time is up" : "Remaining") : "Elapsed"} · started {when(race.started_at)}</div>
        </div>
        <div className="rounded-xl border border-line bg-panel p-4 sm:col-span-2">
          <div className="mb-1 text-xs text-muted">Scoreboard</div>
          {race.scoreboard.map((s, i) => (
            <div key={s.team} className="flex items-center gap-2 text-sm">
              <span className="w-5 text-muted">{i + 1}.</span>
              <span className="font-medium">{s.team}</span>
              <span className="ml-auto tabular-nums">{s.points} pts</span>
              <span className="w-28 text-right text-xs text-muted">
                {s.correct} correct / {s.answers}
              </span>
            </div>
          ))}
          {race.scoreboard.length === 0 && <div className="text-xs text-muted">No teams yet.</div>}
        </div>
      </div>
      {joined ? <AnswerForm d={d} me={joined} run={run} disabled={race.time_up} /> : <JoinForm d={d} race={race} run={run} />}
      <Card
        title="Answers"
        count={race.submissions.length}
        action={
          <button
            type="button"
            onClick={async () => {
              if (!(await confirmDialog("Finish the race? Every participant's answers become drill sessions."))) return;
              try {
                const next = await design.finishRace(d.id);
                if (joined) setCapture(null);
                onFinished(next);
              } catch (e) {
                await run(() => Promise.reject(e));
              }
            }}
            className={buttonClass.secondary}
          >
            Finish race
          </button>
        }
      >
        <div className="divide-y divide-line text-sm">
          {[...race.submissions].reverse().map((s) => (
            <div key={s.id} className="flex gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div>
                  <span className="font-medium">{s.participant}</span> <span className="text-xs text-muted">({s.team})</span> · {q(s.question_id)?.text ?? s.question_id}
                </div>
                <div className="text-soft">“{s.answer}”</div>
                <div className="text-xs text-muted">
                  {s.seconds}s · path: {s.path.length ? s.path.join(" → ") : "none recorded"}
                  {s.searched.length > 0 && ` · searched: ${s.searched.join(", ")}`}
                  {q(s.question_id)?.expected_answer && ` · expected: ${q(s.question_id)?.expected_answer}`}
                </div>
              </div>
              <div className="flex h-fit items-center gap-1 text-xs">
                {s.judged_by === "auto" && <span className="text-muted">auto</span>}
                <button type="button" onClick={() => run(() => design.judge(d.id, s.id, true))} className={`rounded px-2 py-1 ${s.correct === true ? "bg-ok/20 text-ok" : "text-muted hover:text-ok"}`}>
                  <Icon name="check" className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => run(() => design.judge(d.id, s.id, false))} className={`rounded px-2 py-1 ${s.correct === false ? "bg-bad/20 text-bad" : "text-muted hover:text-bad"}`}>
                  <Icon name="x" className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
          {race.submissions.length === 0 && <p className="px-4 py-3 text-xs text-muted">No answers yet.</p>}
        </div>
      </Card>
    </>
  );
}

function JoinForm({ d, race, run }: { d: Drill; race: Race; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [participant, setParticipant] = useState("");
  const [team, setTeam] = useState(race.teams[0] ?? "");
  const [role, setRole] = useState<Role>("new_user");
  return (
    <Card title="Join the race (from this browser)">
      <div className="space-y-3 p-4 text-sm">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Your name">
            <input value={participant} onChange={(e) => setParticipant(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Team">
            <input list="race-teams" value={team} onChange={(e) => setTeam(e.target.value)} className={inputClass} />
            <datalist id="race-teams">
              {race.teams.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>
          <Field label="Role">
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={inputClass}>
              {(["new_user", "domain_expert", "builder"] as Role[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <button
          type="button"
          disabled={!participant.trim()}
          onClick={() =>
            run(async () => {
              const j = await design.joinRace(d.id, { participant: participant.trim(), team: team.trim(), role });
              setCapture({ drill_id: d.id, drill_name: d.name, race_id: j.race_id, participant: j.participant, team: j.team });
            })
          }
          className={buttonClass.primary}
        >
          Join and record my path
        </button>
      </div>
    </Card>
  );
}

function AnswerForm({ d, me, run, disabled }: { d: Drill; me: Capture; run: (fn: () => Promise<unknown>) => Promise<void>; disabled: boolean }) {
  const [qid, setQid] = useState(d.questions[0]?.id ?? "");
  const [answer, setAnswer] = useState("");
  return (
    <Card title={`Answer as ${me.participant} (${me.team})`}>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted">
          Find the answer in{" "}
          <Link href="/object-explorer" target="_blank" className="text-ocean hover:underline">
            Object Explorer
          </Link>{" "}
          (opens in a new tab): the object types you open, the links you follow and what you search are recorded until you submit.
        </p>
        <select value={qid} onChange={(e) => setQid(e.target.value)} className={inputClass}>
          {d.questions.map((q) => (
            <option key={q.id} value={q.id}>
              {q.text} ({q.points} pts)
            </option>
          ))}
        </select>
        <textarea rows={2} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" className={inputClass} />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={disabled || !qid || !answer.trim()}
            onClick={() =>
              run(async () => {
                const r = await design.raceAnswer(d.id, { participant: me.participant, question_id: qid, answer });
                setAnswer("");
                return r;
              })
            }
            className={buttonClass.primary}
          >
            Submit answer
          </button>
          <button type="button" onClick={() => setCapture(null)} className={buttonClass.ghost}>
            Leave (stop recording)
          </button>
        </div>
      </div>
    </Card>
  );
}
