"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { auth, type Marking, type MarkingCategory } from "@/lib/auth";
import { governance, type Portfolio, type ProjectGovernance, type Space, type Template } from "@/lib/governanceModel";
import { useAuth } from "../AuthGate";
import { Icon } from "../Icon";
import { buttonClass, inputClass, Modal } from "../pipeline/Modal";
import { Field } from "../pipeline/ui";

/** The groups of a Project users may ask to join from its access request form (Owners hide some). */
function RequestForm({ projectId, g, onSaved }: { projectId: string; g: ProjectGovernance; onSaved: (g: ProjectGovernance) => void }) {
  const [groups, setGroups] = useState<{ id: string; name: string }[] | null>(null);
  const [owner, setOwner] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    auth.projectRoles(projectId).then(
      (r) => {
        setOwner(r.can_manage);
        setGroups(r.roles.filter((x) => x.principal_type === "group").map((x) => ({ id: x.principal_id, name: x.name ?? x.principal_id })));
      },
      () => setGroups([]),
    );
  }, [projectId]);
  if (!groups?.length) return null;
  const hidden = g.request_excluded_groups ?? [];
  return (
    <div>
      <span className="text-muted">Access request form </span>
      {groups.length - groups.filter((x) => hidden.includes(x.id)).length} of {groups.length} groups requestable{" "}
      <button type="button" onClick={() => setOpen(!open)} className="text-ocean hover:underline">
        {owner ? "Manage" : "View"}
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 rounded border border-line p-2">
          {groups.map((x) => (
            <label key={x.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                disabled={!owner}
                checked={hidden.includes(x.id)}
                onChange={() => governance.setRequestExcluded(projectId, hidden.includes(x.id) ? hidden.filter((h) => h !== x.id) : [...hidden, x.id]).then(onSaved, () => {})}
              />
              Hide {x.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** A Project's space, portfolio, constraints (and the files violating them) in Files → details. */
export function ProjectGovernancePanel({ projectId }: { projectId: string }) {
  const { enabled, me } = useAuth();
  const [g, setG] = useState<ProjectGovernance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [markings, setMarkings] = useState<Marking[]>([]);
  const [draft, setDraft] = useState<{ mode: ProjectGovernance["constraints"]["mode"]; markings: string[] }>({ mode: "none", markings: [] });
  const [spaces, setSpaces] = useState<Space[]>([]);
  const load = useCallback(() => governance.project(projectId).then((r) => (setG(r), setError(null)), (e: Error) => setError(e.message)), [projectId]);
  useEffect(() => {
    if (enabled) load();
  }, [load, enabled]);
  // the spaces to move to, loaded up front: loading them when the list opens left it empty on the first click
  useEffect(() => {
    if (enabled && me?.role === "admin") governance.spaces().then(setSpaces, () => {});
  }, [enabled, me?.role]);
  if (!enabled) return null;
  if (!g) return error ? <p className="text-xs text-bad">{error}</p> : <p className="text-xs text-muted">…</p>;
  const c = g.constraints;
  return (
    <div className="space-y-1 text-xs">
      <p>
        <span className="text-muted">Space </span>
        <span className="text-soft">{g.space.name}</span>
        {me?.role === "admin" && (
          <select
            value=""
            onChange={(e) => e.target.value && governance.moveProject(projectId, e.target.value).then(setG, (er: Error) => setError(er.message))}
            className="ml-1.5 rounded border border-line-2 bg-ink px-1 py-0.5"
            title="Move to another space"
          >
            <option value="">Move…</option>
            {spaces
              .filter((s) => s.id !== g.space.id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        )}
      </p>
      {g.marketplace && (
        <p className="rounded bg-warn/10 px-1.5 py-1 text-warn">
          <span className="inline-flex items-center gap-1">
            <Icon name="lock" className="h-3 w-3" /> Locked: installed from the Marketplace ({g.marketplace.name} {g.marketplace.version}); nobody edits it.
          </span>
          {me?.role === "admin" && (
            <button type="button" onClick={() => governance.unlockProject(projectId).then(setG, (er: Error) => setError(er.message))} className="ml-2 text-ocean hover:underline">
              Unlock
            </button>
          )}
        </p>
      )}
      {g.portfolio && (
        <p>
          <span className="text-muted">Portfolio </span>
          <Link href={`/compass?portfolio=${g.portfolio.id}`} className="text-ocean hover:underline">
            {g.portfolio.name}
          </Link>
        </p>
      )}
      <RequestForm projectId={projectId} g={g} onSaved={setG} />
      {!editing ? (
        <p>
          <span className="text-muted">Constraint </span>
          {c.mode === "none" ? "none" : `${c.mode === "allowed" ? "only" : "no"} ${c.marking_names?.join(", ") || "markings"}`}{" "}
          <button
            type="button"
            onClick={() => {
              setDraft({ mode: c.mode, markings: c.markings });
              auth.markings().then(setMarkings, () => {});
              setEditing(true);
            }}
            className="text-ocean hover:underline"
          >
            Change
          </button>
        </p>
      ) : (
        <div className="space-y-1.5 rounded border border-line p-2">
          <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as typeof draft.mode })} className="w-full rounded border border-line-2 bg-ink px-1 py-0.5">
            <option value="none">No constraint</option>
            <option value="allowed">Allowed markings only</option>
            <option value="prohibited">Prohibited markings</option>
          </select>
          {draft.mode !== "none" && (
            <div className="flex max-h-28 flex-wrap gap-x-3 gap-y-1 overflow-y-auto">
              {markings.map((m) => (
                <label key={m.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={draft.markings.includes(m.id)}
                    onChange={() => setDraft({ ...draft, markings: draft.markings.includes(m.id) ? draft.markings.filter((x) => x !== m.id) : [...draft.markings, m.id] })}
                  />
                  {m.name}
                </label>
              ))}
            </div>
          )}
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => governance.setConstraints(projectId, draft).then((r) => (setG(r), setEditing(false), setError(null)), (e: Error) => setError(e.message))}
              className="rounded bg-ocean px-2 py-0.5 text-white"
            >
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)} className="rounded border border-line-2 px-2 py-0.5">
              Cancel
            </button>
          </div>
        </div>
      )}
      {g.violations.length > 0 && (
        <div className="rounded border border-bad/40 bg-bad/10 p-2">
          <p className="font-medium text-bad">
            {g.violations.length} file{g.violations.length === 1 ? "" : "s"} violate the constraint (their builds fail until resolved)
          </p>
          <ul className="mt-1 space-y-0.5">
            {g.violations.slice(0, 8).map((v) => (
              <li key={v.id}>
                <Link href={`/files/${v.id}`} className="text-soft hover:underline">
                  {v.path ?? v.name}
                </Link>{" "}
                <span className="text-muted">· {v.marking_names.join(", ")}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-muted">Allow the marking, remove the inputs that bring it, or remove it upstream.</p>
        </div>
      )}
      <p>
        <Link href={`/restricted-views?project=${projectId}`} className="text-ocean hover:underline">
          Restricted views
        </Link>
      </p>
      {error && <p className="text-bad">{error}</p>}
    </div>
  );
}

/** Files → Move on a Project (administrators): the space it moves to. */
export function MoveProjectDialog({ project, onClose, onMoved }: { project: { id: string; name: string }; onClose: () => void; onMoved: () => void }) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    governance.spaces().then(setSpaces, (e: Error) => setError(e.message));
    governance.project(project.id).then((g) => setCurrent(g.space.id), () => {});
  }, [project.id]);
  return (
    <Modal title={`Move “${project.name}” to a space`} icon="project" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <Field label="Space" hint={current ? `Now in ${spaces.find((s) => s.id === current)?.name ?? current}. The new space's access requirements and inherited roles apply; the Project leaves its portfolio.` : undefined}>
          <select value={to} onChange={(e) => setTo(e.target.value)} className={inputClass}>
            <option value="">Choose a space…</option>
            {spaces
              .filter((s) => s.id !== current)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </Field>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!to} onClick={() => governance.moveProject(project.id, to).then(onMoved, (e: Error) => setError(e.message))} className={buttonClass.primary}>
            Move
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** New Project in a space, optionally from one of its templates (variables), into a portfolio, with a classification. */
export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [classes, setClasses] = useState<Marking[]>([]);
  const [f, setF] = useState({ name: "", space_id: "space-default", template_id: "", portfolio_id: "", classification: "" });
  const [vars, setVars] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    governance.spaces().then((s) => setSpaces(s.filter((x) => x.my_workflows?.includes("create_projects"))), (e: Error) => setError(e.message));
    Promise.all([auth.markings(), auth.markingCategories()]).then(
      ([ms, cats]: [Marking[], MarkingCategory[]]) => setClasses(ms.filter((m) => cats.find((c) => c.id === m.category_id)?.kind === "hierarchical")),
      () => {},
    );
  }, []);
  useEffect(() => {
    governance.templates(f.space_id).then(setTemplates, () => setTemplates([]));
    governance.portfolios(f.space_id).then(setPortfolios, () => setPortfolios([]));
  }, [f.space_id]);
  const tpl = templates.find((t) => t.id === f.template_id);
  const create = () => {
    setBusy(true);
    governance
      .createProject({ name: f.name.trim(), space_id: f.space_id, template_id: f.template_id || null, variables: vars, portfolio_id: f.portfolio_id || null, classification: f.classification || null })
      .then((p) => onCreated(p.id), (e: Error) => (setError(e.message), setBusy(false)));
  };
  return (
    <Modal title="New Project" icon="project" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <Field label="Name">
          <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Space">
          <select value={f.space_id} onChange={(e) => setF({ ...f, space_id: e.target.value, template_id: "", portfolio_id: "" })} className={inputClass}>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Template">
          <select value={f.template_id} onChange={(e) => setF({ ...f, template_id: e.target.value })} className={inputClass}>
            <option value="">Empty Project (you are its Owner)</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {tpl?.description && <p className="mt-1 text-xs text-muted">{tpl.description}</p>}
        </Field>
        {(tpl?.variables ?? []).map((v) => (
          <Field key={v} label={`Variable · ${v}`}>
            <input value={vars[v] ?? ""} onChange={(e) => setVars({ ...vars, [v]: e.target.value })} className={inputClass} />
          </Field>
        ))}
        {portfolios.length > 0 && (
          <Field label="Portfolio">
            <select value={f.portfolio_id} onChange={(e) => setF({ ...f, portfolio_id: e.target.value })} className={inputClass}>
              <option value="">None</option>
              {portfolios
                .filter((p) => p.can_curate)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        {classes.length > 0 && (
          <Field label="Classification">
            <select value={f.classification} onChange={(e) => setF({ ...f, classification: e.target.value })} className={inputClass}>
              <option value="">None</option>
              {classes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!f.name.trim() || busy} onClick={create} className={buttonClass.primary}>
            Create Project
          </button>
        </div>
      </div>
    </Modal>
  );
}
