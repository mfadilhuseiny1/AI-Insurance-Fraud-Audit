/** Ontology design (api/ontology_design.py): the design review linter and task-based validation drills. */
import { request } from "./ontology";

export type Severity = "high" | "medium" | "low";
export type Finding = {
  id: string;
  rule: string;
  anti_pattern: string;
  severity: Severity;
  resource_kind: "object_type" | "property" | "link_type" | "interface" | "action_type" | "automation";
  resource_id: string;
  resource_name: string;
  message: string;
  suggestion: string;
  related_id?: string;
  sparse?: string[];
  dismissed: { reason: string; by: string; at: string } | null;
  /** branch reviews: the finding is not on main */
  new_on_branch?: boolean;
};
export type Guideline = { id: string; title: string; description: string; rules: string[]; status: "pass" | "warn" | "fail" | "todo"; note: string };
export type Review = {
  settings?: { block_merge_on_high: boolean };
  score: number;
  findings: Finding[];
  guidelines: Guideline[];
  by_rule: Record<string, number>;
  anti_patterns: Record<string, string>;
  checked: { object_types: number; at: string };
  vs_main?: { new: string[]; resolved: string[] };
  branch?: { id: string; name: string; proposal_id: string | null };
};
export type ReviewSnapshot = {
  at: string;
  ontology_id: string | null;
  branch_id: string | null;
  branch_name: string | null;
  proposal_id: string | null;
  score: number;
  active: number;
  by_severity: Record<Severity, number>;
  added: { id: string; label: string }[];
  resolved: { id: string; label: string }[];
};

export type Question = { id: string; text: string; step: "situation" | "factors" | "impact"; points: number; expected_answer: string; source: string };
export type Answer = {
  question_id: string;
  correct: boolean | null;
  seconds: number | null;
  assisted: boolean;
  path: string[];
  searched: string[];
  symptoms: string[];
  expected: string;
  notes: string;
  answer: string;
};
export type Role = "builder" | "domain_expert" | "new_user" | "agent";
export type Session = { id: string; participant: string; role: Role; team: string; assisted_format: "individual" | "team"; answers: Answer[]; at: string; model?: string; agent_mode?: "query" | "plan" };
export type QuestionResult = {
  question_id: string;
  answers: number;
  success: number | null;
  median_seconds: number | null;
  assisted: number;
  by_role: Record<Role, { success: number | null; median_seconds: number | null; answers: number }>;
  people_vs_agents: { code: string; review: string } | null;
  paths: { path: string; count: number }[];
  searched: string[];
  expected: string[];
};
export type Drill = {
  id: string;
  name: string;
  description: string;
  format: "quiz" | "drilldown";
  time_limit_minutes: number | null;
  allowed_apps: string[];
  questions: Question[];
  sessions: Session[];
  ontology_id?: string | null;
  created_at: string;
  updated_at: string;
  results: {
    questions: QuestionResult[];
    symptoms: { id: string; label: string; review: string; rule: string | null; count: number; systemic: boolean }[];
    leaderboard: { team: string; points: number }[];
  };
};
export type DrillSummary = Pick<Drill, "id" | "name" | "description" | "format" | "created_at" | "updated_at"> & { questions: number; sessions: number };
export type Symptom = { id: string; label: string; review: string; rule: string | null };

export type RaceSubmission = {
  id: string;
  participant: string;
  team: string;
  question_id: string;
  answer: string;
  at: string;
  seconds: number;
  path: string[];
  searched: string[];
  correct: boolean | null;
  judged_by: string | null;
};
export type Race = {
  id: string;
  started_at: string;
  time_limit_minutes: number | null;
  teams: string[];
  participants: Record<string, { team: string; role: Role; joined_at: string }>;
  events: { participant: string; kind: "search" | "object_type" | "object" | "link"; label: string; at: string }[];
  submissions: RaceSubmission[];
  elapsed_seconds: number;
  remaining_seconds: number | null;
  time_up: boolean;
  scoreboard: { team: string; points: number; correct: number; answers: number }[];
};
export type PastRace = { id: string; started_at: string; finished_at: string; teams: string[]; participants: number; scoreboard: Race["scoreboard"] };

export const ROLE_LABEL: Record<Role, string> = { builder: "Builder", domain_expert: "Domain expert", new_user: "New user", agent: "AI agent" };
export const STEP_LABEL: Record<Question["step"], string> = { situation: "Establish the situation", factors: "Trace contributing factors", impact: "Assess the impact" };

export const design = {
  review: (ontologyId?: string, branchId?: string) =>
    request<Review>(`/design/review?${new URLSearchParams(Object.entries({ ontology_id: ontologyId ?? "", branch_id: branchId ?? "" }).filter(([, v]) => v)).toString()}`),
  settings: (body: { block_merge_on_high: boolean }) => request<{ block_merge_on_high: boolean }>("/design/settings", { method: "PUT", json: body }),
  history: (branchId?: string) => request<ReviewSnapshot[]>(`/design/review/history${branchId ? `?branch_id=${branchId}` : ""}`),
  dismiss: (id: string, reason: string) => request<unknown>(`/design/review/${id}/dismiss`, { method: "POST", json: { reason } }),
  restore: (id: string) => request<unknown>(`/design/review/${id}/dismiss`, { method: "DELETE" }),
  drills: () => request<DrillSummary[]>("/design/drills"),
  drill: (id: string) => request<Drill>(`/design/drills/${id}`),
  createDrill: (body: Partial<Drill>) => request<Drill>("/design/drills", { method: "POST", json: body }),
  saveDrill: (id: string, body: Partial<Drill>) => request<Drill>(`/design/drills/${id}`, { method: "PUT", json: body }),
  deleteDrill: (id: string) => request<unknown>(`/design/drills/${id}`, { method: "DELETE" }),
  addSession: (id: string, body: Partial<Session>) => request<Drill>(`/design/drills/${id}/sessions`, { method: "POST", json: body }),
  saveSession: (id: string, sid: string, body: Partial<Session>) => request<Drill>(`/design/drills/${id}/sessions/${sid}`, { method: "PUT", json: body }),
  deleteSession: (id: string, sid: string) => request<Drill>(`/design/drills/${id}/sessions/${sid}`, { method: "DELETE" }),
  agentRun: (id: string, mode: "query" | "plan" = "query") => request<Drill>(`/design/drills/${id}/agent-run`, { method: "POST", json: { mode } }),
  symptoms: () => request<Symptom[]>("/design/symptoms"),
  race: (id: string) => request<{ race: Race | null; past: PastRace[] }>(`/design/drills/${id}/race`),
  startRace: (id: string, body: { teams: string[]; time_limit_minutes?: number | null }) => request<{ race: Race }>(`/design/drills/${id}/race`, { method: "POST", json: body }),
  joinRace: (id: string, body: { participant: string; team: string; role: Role }) =>
    request<{ drill_id: string; race_id: string; participant: string; team: string }>(`/design/drills/${id}/race/join`, { method: "POST", json: body }),
  raceAnswer: (id: string, body: { participant: string; question_id: string; answer: string }) =>
    request<{ submission: RaceSubmission; race: Race }>(`/design/drills/${id}/race/answer`, { method: "POST", json: body }),
  judge: (id: string, submission_id: string, correct: boolean | null) => request<{ race: Race }>(`/design/drills/${id}/race/judge`, { method: "POST", json: { submission_id, correct } }),
  finishRace: (id: string) => request<Drill & { sessions_created: number }>(`/design/drills/${id}/race/finish`, { method: "POST" }),
};

/** Where a finding's resource is edited. */
export function findingHref(f: Pick<Finding, "resource_kind" | "resource_id">): string {
  switch (f.resource_kind) {
    case "object_type":
      return `/ontology/${f.resource_id}`;
    case "property":
      return `/ontology/${f.resource_id}?tab=properties`;
    case "link_type":
      return `/ontology?tab=link-types`;
    case "interface":
      return `/ontology/interfaces/${f.resource_id}`;
    case "action_type":
      return `/ontology/action-types/${f.resource_id}`;
    case "automation":
      return `/automate/${f.resource_id}`;
  }
}

