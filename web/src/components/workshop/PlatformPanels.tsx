"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { missingText } from "@/components/LocationField";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, API_URL, type DriveItem } from "@/lib/api";
import { workshop, type BranchState, type InstallParam, type LintResult, type Module, type ProductPackage, type RebaseConflict } from "@/lib/workshop";

const label = (unit: string) => {
  const [kind, ...rest] = unit.split(":");
  return `${{ widget: "Widget", variable: "Variable", page: "Page", overlay: "Overlay", derived: "Derived property", setting: "Setting", field: "Module" }[kind] ?? kind} ${rest.join(":")}`;
};
const OP_STYLE: Record<string, string> = { added: "text-ok", modified: "text-ocean", deleted: "text-bad", moved: "text-warn" };

async function ontologyBranches(): Promise<{ id: string; name: string; status: string }[]> {
  const r = await fetch(`${API_URL}/api/ontology/branches?status=open`, { credentials: "include" });
  return r.ok ? r.json() : [];
}
async function newBranch(name: string): Promise<{ id: string; name: string }> {
  const r = await fetch(`${API_URL}/api/ontology/branches`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description: "Workshop changes" }) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.detail ?? r.statusText);
  return body;
}

/** The branch the editor works on: main or an open global branch (new ones are created here). */
export function BranchControl({ mod, branchId, setBranchId }: { mod: Module; branchId: string | null; setBranchId: (b: string | null) => void }) {
  const [list, setList] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    ontologyBranches().then(setList, () => setList([]));
  }, [mod.id, branchId]);
  return (
    <span className="flex items-center gap-1" data-branch-control>
      <Icon name="split" className="h-3.5 w-3.5 text-muted" />
      <select
        value={branchId ?? ""}
        onChange={async (e) => {
          if (e.target.value === "__new") {
            const name = window.prompt("Name of the new branch");
            if (!name) return;
            try {
              const b = await newBranch(name);
              setList((l) => [...l, b]);
              setBranchId(b.id);
            } catch (x) {
              setError((x as Error).message);
            }
            return;
          }
          setBranchId(e.target.value || null);
        }}
        className={`${fieldClass} max-w-40 text-xs`}
        data-branch-select
      >
        <option value="">main</option>
        {list.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
        <option value="__new">+ New branch…</option>
      </select>
      {error && <span className="text-xs text-bad">{error}</span>}
    </span>
  );
}

/** The Changelog panel on a branch: the module's changes, rebasing with conflict resolution, reviews and merging. */
export function ChangelogPanel({ mod, branchId, onChanged }: { mod: Module; branchId: string; onChanged: () => void }) {
  const st: BranchState | undefined = mod.branch;
  const [conflicts, setConflicts] = useState<RebaseConflict[] | null>(null);
  const [choice, setChoice] = useState<Record<string, "main" | "branch">>({});
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!st) return <p className="text-xs text-muted">Loading…</p>;
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setNote(null);
    try {
      await f();
      setNote(ok);
      onChanged();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const startRebase = () =>
    run(async () => {
      const r = await workshop.rebase(mod.id, branchId, { preview: true });
      if (!r.conflicts.length) {
        await workshop.rebase(mod.id, branchId, {});
        setConflicts(null);
      } else {
        setConflicts(r.conflicts);
        setChoice(Object.fromEntries(r.conflicts.map((c) => [c.unit, "branch"])));
      }
    }, "Rebased");
  return (
    <div className="space-y-3 text-xs" data-changelog>
      <div className="rounded border border-line p-2">
        <div className="font-semibold">Branch {st.branch_name}</div>
        <div className="text-muted">
          {st.on_branch ? `${st.changes.length} change${st.changes.length === 1 ? "" : "s"} · ${st.status}` : "No changes on this branch yet: save to add the module to it."}
          {st.by ? ` · by ${st.by}` : ""}
        </div>
      </div>
      {st.on_branch && (
        <>
          <div>
            <div className="mb-1 font-semibold uppercase tracking-wide text-muted">Changes</div>
            {st.changes.map((c) => (
              <div key={c.unit} className="flex items-center gap-2" data-change={c.unit}>
                <span className={`w-16 ${OP_STYLE[c.op]}`}>{c.op}</span>
                <span className="truncate">{label(c.unit)}</span>
                {st.conflicts.includes(c.unit) && <span className="ml-auto text-bad">conflict</span>}
              </div>
            ))}
          </div>
          {st.rebase_needed && !conflicts && (
            <div className="rounded border border-warn/50 bg-warn/10 p-2" data-rebase-needed>
              <div className="mb-1 text-warn">Main changed since this branch: rebase before merging{st.conflicts.length ? ` (${st.conflicts.length} conflict${st.conflicts.length === 1 ? "" : "s"})` : ""}.</div>
              <div className="flex gap-2">
                <button type="button" disabled={busy} onClick={startRebase} className={buttonClass.secondary} data-rebase>
                  Start rebasing
                </button>
                <button type="button" disabled={busy} onClick={() => run(() => workshop.rebase(mod.id, branchId, { keep_branch: true }), "Kept the branch version")} className="text-muted hover:text-white">
                  Reject all changes from main
                </button>
              </div>
            </div>
          )}
          {conflicts && (
            <div className="space-y-2 rounded border border-bad/50 p-2" data-conflicts>
              <div className="font-semibold text-bad">Resolve {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}</div>
              {conflicts.map((c) => (
                <div key={c.unit} className="space-y-1">
                  <div>{label(c.unit)}</div>
                  <div className="grid grid-cols-2 gap-1">
                    {(["main", "branch"] as const).map((side) => (
                      <button key={side} type="button" onClick={() => setChoice({ ...choice, [c.unit]: side })} className={`rounded border p-1 text-left ${choice[c.unit] === side ? "border-ocean bg-ocean/10" : "border-line-2"}`} data-resolve={`${c.unit}:${side}`}>
                        <div className="font-semibold">{side === "main" ? "Latest main" : "Current branch"}</div>
                        <pre className="max-h-24 overflow-auto whitespace-pre-wrap text-[10px] text-muted">{JSON.stringify(side === "main" ? c.main : c.branch, null, 1)?.slice(0, 600) ?? "(deleted)"}</pre>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <button type="button" disabled={busy} onClick={() => run(async () => { await workshop.rebase(mod.id, branchId, { resolutions: choice }); setConflicts(null); }, "Rebased with your resolutions")} className={buttonClass.primary} data-finish-rebase>
                Resolve and finish rebasing
              </button>
            </div>
          )}
          <div className="space-y-1">
            <div className="font-semibold uppercase tracking-wide text-muted">Review proposed changes</div>
            {Object.entries(st.reviews ?? {}).map(([who, r]) => (
              <div key={who} className={r.decision === "approve" ? "text-ok" : "text-bad"} data-review={who}>
                {r.decision === "approve" ? "✓ Approved" : "✗ Rejected"} by {who}
                {!r.counts && <span className="text-muted"> (does not count: the author or not an editor)</span>}
                {r.comment && <span className="text-muted"> — {r.comment}</span>}
              </div>
            ))}
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment (optional)" className={`${fieldClass} w-full text-xs`} />
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => run(() => workshop.review(mod.id, branchId, "approve", comment), "Approved")} className="text-ok" data-approve>
                Approve
              </button>
              <button type="button" disabled={busy} onClick={() => run(() => workshop.review(mod.id, branchId, "reject", comment), "Rejected")} className="text-bad" data-reject>
                Reject
              </button>
            </div>
          </div>
          <button
            type="button"
            disabled={busy || st.rebase_needed || !st.approved || st.status === "merged"}
            onClick={() => run(() => workshop.mergeBranch(mod.id, branchId), "Merged into main")}
            className={buttonClass.primary}
            title={st.rebase_needed ? "Rebase first" : !st.approved ? "Needs an approval" : undefined}
            data-merge
          >
            <Icon name="split" className="h-3.5 w-3.5" /> {st.status === "merged" ? "Merged" : "Merge into main"}
          </button>
          <p className="text-muted">Merging the global branch merges approved, rebased module changes too.</p>
        </>
      )}
      {note && <p className="text-muted" data-changelog-note>{note}</p>}
    </div>
  );
}

/** Protection, installation configuration (parameters), the packaging linter and the product package. */
export function PlatformSettings({ mod, setMod }: { mod: Module; setMod: (m: Module) => void }) {
  const st = mod.settings ?? {};
  const inst = st.installation ?? {};
  const params = inst.parameters ?? [];
  const [lint, setLint] = useState<LintResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setInst = (x: Partial<typeof inst>) => setMod({ ...mod, settings: { ...st, installation: { ...inst, ...x } } });
  const setP = (i: number, x: Partial<InstallParam>) => setInst({ parameters: params.map((p, j) => (j === i ? { ...p, ...x } : p)) });
  useEffect(() => {
    if (!inst.enabled) return;
    workshop.lint(mod.id).then(setLint, (e: Error) => setError(e.message));
  }, [inst.enabled, mod.id, mod.updated_at]);
  return (
    <div className="space-y-4 text-xs" data-platform-settings>
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-muted">Branching</div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!st.protected} onChange={(e) => setMod({ ...mod, settings: { ...st, protected: e.target.checked } })} data-protect /> Protected: changes go through a branch and an approved merge
        </label>
      </div>
      <div>
        <div className="mb-1 font-semibold uppercase tracking-wide text-muted">Marketplace</div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!inst.enabled} onChange={(e) => setInst({ enabled: e.target.checked })} data-installation /> Installation configuration (linter and parameters)
        </label>
        {inst.enabled && (
          <div className="mt-2 space-y-2">
            <div className="text-muted">Installation parameters (shown as inputs when installing)</div>
            {params.map((p, i) => (
              <div key={i} className="space-y-1 rounded border border-line p-1.5">
                <div className="flex gap-1">
                  <input value={p.name} onChange={(e) => setP(i, { name: e.target.value })} placeholder="name" className={`${fieldClass} min-w-0 flex-1 text-xs`} />
                  <select value={p.type} onChange={(e) => setP(i, { type: e.target.value as "string" })} className={`${fieldClass} text-xs`}>
                    <option value="string">string</option>
                    <option value="boolean">boolean</option>
                  </select>
                  <button type="button" onClick={() => setInst({ parameters: params.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad">
                    ✕
                  </button>
                </div>
                <div className="flex gap-1">
                  <select value={p.variable ?? ""} onChange={(e) => setP(i, { variable: e.target.value || undefined })} className={`${fieldClass} min-w-0 flex-1 text-xs`}>
                    <option value="">Variable…</option>
                    {(mod.variables ?? []).filter((v) => v.type === p.type).map((v) => (
                      <option key={v.name}>{v.name}</option>
                    ))}
                  </select>
                  <input value={p.default ?? ""} onChange={(e) => setP(i, { default: e.target.value || undefined })} placeholder="default" className={`${fieldClass} w-24 text-xs`} />
                </div>
              </div>
            ))}
            <button type="button" onClick={() => setInst({ parameters: [...params, { name: `param${params.length + 1}`, type: "string" }] })} className="text-ocean">
              + Parameter
            </button>
            <div className="text-muted">Packaging linter (of the saved module)</div>
            {error && <p className="text-bad">{error}</p>}
            {lint && (
              <div className="space-y-1" data-lint>
                {lint.errors.map((e, i) => (
                  <div key={i} className="text-bad">✗ {e.message}</div>
                ))}
                {lint.warnings.map((e, i) => (
                  <div key={i} className="text-warn">! {e.message}</div>
                ))}
                {!lint.errors.length && <div className="text-ok">✓ No packaging errors</div>}
                <div className="text-muted">
                  Dependencies: {Object.entries(lint.dependencies).filter(([, v]) => v.length).map(([k, v]) => `${v.length} ${k.replace("_", " ")}`).join(", ") || "none"}
                </div>
                <button
                  type="button"
                  disabled={!lint.packageable}
                  onClick={async () => {
                    try {
                      const pk = await workshop.package(mod.id);
                      const url = URL.createObjectURL(new Blob([JSON.stringify(pk, null, 1)], { type: "application/json" }));
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `${mod.name}.workshop-product.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                  className={buttonClass.secondary}
                  data-package
                >
                  <Icon name="download" className="h-3.5 w-3.5" /> Download product package
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Choose a Project (or a folder in it) the user edits. */
export function FolderPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [folders, setFolders] = useState<DriveItem[]>([]);
  const [project, setProject] = useState("");
  useEffect(() => {
    api.drive.folder(null).then((f) => setProjects(f.items.filter((i) => i.kind === "project")), () => setProjects([]));
  }, []);
  useEffect(() => {
    if (!project) return;
    api.drive.folder(project).then((f) => setFolders(f.items.filter((i) => i.kind === "folder")), () => setFolders([]));
  }, [project]);
  return (
    <div className="space-y-1">
      <select value={project} onChange={(e) => (setProject(e.target.value), onChange(e.target.value))} className={inputClass} data-pick-project>
        <option value="">Project…</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {project && folders.length > 0 && (
        <select value={value === project ? "" : value} onChange={(e) => onChange(e.target.value || project)} className={inputClass}>
          <option value="">The Project itself</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export function MoveDialog({ mod, onMoved, onClose }: { mod: Module; onMoved: (m: Module) => void; onClose: () => void }) {
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={mod.in_files ? "Move the module" : "Put the module in a Project"} icon="folder" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm" data-move-dialog>
        <p className="text-muted">The module becomes a Files item: opening it needs the Viewer role on its Project, changing it the Editor role (with the Project&apos;s markings).</p>
        <FolderPicker value={folder} onChange={setFolder} />
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!folder} onClick={() => workshop.move(mod.id, folder).then(onMoved, (e: Error) => setError(e.message))} className={buttonClass.primary} data-move-confirm>
            Move
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Install a product package: inputs for its parameters, dependencies mapped to resources here, a folder. */
export function InstallDialog({ onInstalled, onClose }: { onInstalled: (m: Module) => void; onClose: () => void }) {
  const [pk, setPk] = useState<ProductPackage | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  // Install stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(pk ? [] : ["choose a product package file"]), ...(folder ? [] : ["choose the Project to install into"])];
  const install = () => {
    setTried(true);
    if (missing.length || !pk) return;
    setBusy(true);
    setError(null);
    workshop
      .install({ package: pk, folder_id: folder, name, inputs, mapping })
      .then(onInstalled, (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const deps = pk ? Object.entries(pk.dependencies).flatMap(([k, ids]) => (["object_type", "action_type", "link_type", "logic", "module"].includes(k) ? ids.map((id) => ({ kind: k, id })) : [])) : [];
  return (
    <Modal title="Install a Workshop product" icon="download" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-sm" data-install-dialog>
        <input
          type="file"
          accept=".json,application/json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const p = JSON.parse(await f.text()) as ProductPackage;
              if (p.kind !== "bluesandai.workshop.product") throw new Error("not a Workshop product package");
              setPk(p);
              setName(p.name);
              setInputs(Object.fromEntries(p.parameters.map((x) => [x.name, x.default ?? ""])));
              setError(null);
            } catch (x) {
              setError((x as Error).message);
            }
          }}
          aria-invalid={tried && !pk}
          className={tried && !pk ? "rounded-md text-bad ring-1 ring-bad/40" : undefined}
          data-install-file
        />
        {pk && (
          <>
            <label className="block text-xs text-muted">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
            </label>
            {pk.parameters.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Inputs</div>
                {pk.parameters.map((x) => (
                  <label key={x.name} className="flex items-center gap-2 text-xs">
                    <span className="w-32 truncate">{x.name}</span>
                    {x.type === "boolean" ? (
                      <input type="checkbox" checked={String(inputs[x.name]) === "true"} onChange={(e) => setInputs({ ...inputs, [x.name]: String(e.target.checked) })} />
                    ) : (
                      <input value={inputs[x.name] ?? ""} onChange={(e) => setInputs({ ...inputs, [x.name]: e.target.value })} className={`${fieldClass} min-w-0 flex-1 text-xs`} data-install-input={x.name} />
                    )}
                  </label>
                ))}
              </div>
            )}
            {deps.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Dependencies (map to resources here; empty: the same)</div>
                {deps.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 text-xs">
                    <span className="w-48 truncate" title={d.id}>
                      {d.kind.replace("_", " ")} · {pk.names[d.id] ?? d.id}
                    </span>
                    <input value={mapping[d.id] ?? ""} onChange={(e) => setMapping({ ...mapping, [d.id]: e.target.value })} placeholder={d.id} className={`${fieldClass} min-w-0 flex-1 font-mono text-xs`} />
                  </label>
                ))}
              </div>
            )}
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">
              Install into <span className="text-bad" aria-hidden>*</span>
            </div>
            <div className={tried && !folder ? "rounded-md ring-1 ring-bad/40" : undefined}>
              <FolderPicker value={folder} onChange={setFolder} />
            </div>
            {tried && !folder && <span className="block text-[11px] text-bad">Choose the Project (and folder) to install into.</span>}
          </>
        )}
        {error && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To install: {missingText(missing)}</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={install} className={buttonClass.primary} data-install-confirm>
            {busy ? "Installing…" : "Install"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
