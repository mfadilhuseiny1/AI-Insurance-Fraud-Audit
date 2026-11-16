"use client";

import { useCallback, useEffect, useState } from "react";
import { lab, type Checkpoint, type Diff, type GitCommit, type GitStatus } from "@/lib/jupyterLab";
import { fileIcon, JpIcon } from "./icons";
import { DialogBox, relTime, useDialogs } from "./ui";

/** A unified diff, colored as jupyterlab-git shows it. */
export function DiffView({ diff }: { diff: Diff }) {
  if (diff.binary) return <p className="jp-Muted">Binary file: no text diff.</p>;
  if (!diff.lines.length) return <p className="jp-Muted">No differences.</p>;
  return (
    <div className="jp-Diff">
      <div className="jp-Diff-stats"><span className="jp-OkText">+{diff.added}</span> <span className="jp-ErrorText">−{diff.removed}</span>{diff.truncated && <span className="jp-Muted"> (truncated)</span>}</div>
      <pre>
        {diff.lines.map((l, i) => (
          <div key={i} className={l.startsWith("@@") ? "jp-Diff-hunk" : l.startsWith("+++") || l.startsWith("---") ? "jp-Diff-file" : l.startsWith("+") ? "jp-Diff-add" : l.startsWith("-") ? "jp-Diff-del" : undefined}>
            {l || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

function DiffDialog({ title, load, onClose }: { title: string; load: () => Promise<Diff>; onClose: () => void }) {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    load().then(setDiff, (e: Error) => setErr(e.message));
  }, [load]);
  return (
    <DialogBox title={title} width={900} onClose={onClose} footer={<button type="button" className="jp-Button jp-mod-accept" onClick={onClose}>Close</button>}>
      {err ? <p className="jp-ErrorText">{err}</p> : diff ? <DiffView diff={diff} /> : <p className="jp-Muted">Loading…</p>}
    </DialogBox>
  );
}

const KIND: Record<Checkpoint["kind"], string> = {
  save: "Saved", auto: "Autosaved", original: "Before the first save here", "before-restore": "Before a restore", "before-upload": "Before an upload", "before-delete": "Before it was deleted",
};

/** File → Revert to Checkpoint: the file's checkpoints of the last 30 days, compared with the current state. */
export function CheckpointsDialog({ wid, path, onClose, onRestored }: { wid: string; path: string; onClose: () => void; onRestored: () => void }) {
  const dialogs = useDialogs();
  const [cps, setCps] = useState<Checkpoint[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    lab.checkpoints(wid, path).then((c) => {
      setCps(c);
      setPick(c[0]?.id ?? null);
    }, (e: Error) => setErr(e.message));
  }, [wid, path]);
  useEffect(() => {
    if (!pick) return;
    let off = false;
    lab.checkpointDiff(wid, path, pick).then((d) => !off && setDiff(d.diff), () => {});
    return () => {
      off = true;
      setDiff(null);
    };
  }, [wid, path, pick]);
  const revert = async () => {
    if (!pick) return;
    const c = cps?.find((x) => x.id === pick);
    if (!(await dialogs.confirm("Revert to checkpoint?", `"${path.split("/").pop()}" goes back to its state of ${c ? new Date(c.at).toLocaleString() : "then"}. Its current state is kept as a checkpoint, so this can be undone.`, "Revert", true))) return;
    try {
      await lab.restoreCheckpoint(wid, path, pick);
      onClose();
      onRestored();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <DialogBox
      title="Revert to Checkpoint"
      width={940}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="jp-Button jp-mod-reject" onClick={onClose}>Cancel</button>
          <button type="button" className="jp-Button jp-mod-warn" disabled={!pick} onClick={() => void revert()}>Revert</button>
        </>
      }
    >
      <p style={{ margin: "0 0 8px" }}>Checkpoints of <b>{path}</b> are kept for 30 days: the state before the first save, every explicit save, an autosave every 10 minutes, and the state before a restore, an upload or a delete.</p>
      {err && <p className="jp-ErrorText">{err}</p>}
      {cps && cps.length === 0 && <p className="jp-Muted">No checkpoints yet. Save the file (Ctrl+S) to create one.</p>}
      {cps && cps.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 12, minHeight: 320 }}>
          <div style={{ border: "1px solid var(--jp-border-color2)", overflow: "auto", maxHeight: 440 }}>
            {cps.map((c) => (
              <button key={c.id} type="button" className={`jp-TOC-item${c.id === pick ? " jp-mod-active" : ""}`} style={{ whiteSpace: "normal", lineHeight: 1.35, padding: "6px 10px" }} onClick={() => setPick(c.id)}>
                <div>{new Date(c.at).toLocaleString()}</div>
                <div className="jp-Muted jp-Small">{KIND[c.kind] ?? c.kind}{c.by ? ` · ${c.by}` : ""} · {(c.size / 1024).toFixed(1)} KB</div>
              </button>
            ))}
          </div>
          <div style={{ minWidth: 0, overflow: "auto", maxHeight: 440 }}>
            <div className="jp-Small jp-Muted" style={{ marginBottom: 4 }}>Changes from the checkpoint to the current file</div>
            {diff ? <DiffView diff={diff} /> : <p className="jp-Muted">Loading…</p>}
          </div>
        </div>
      )}
    </DialogBox>
  );
}

const LETTER: Record<string, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", conflict: "C" };

/** The Git panel (as jupyterlab-git): branch, changes with diffs, commit, history and restoring a file's version. */
export function GitPanel({ wid, refresh, isDirty, onRestored, onSwitched, onOpen }: {
  wid: string; refresh: number; isDirty: () => boolean; onRestored: (path: string) => void; onSwitched: () => void; onOpen: (path: string) => void;
}) {
  const dialogs = useDialogs();
  const [st, setSt] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitCommit[]>([]);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ sha: string; files: { status: string; path: string }[] } | null>(null);
  const [branchMenu, setBranchMenu] = useState(false);
  const load = useCallback(() => {
    lab.gitStatus(wid).then((s) => {
      setSt(s);
      setErr(null);
    }, (e: Error) => setErr(e.message));
    lab.gitLog(wid).then(setLog, () => {});
  }, [wid]);
  useEffect(load, [load, refresh]);
  useEffect(() => {
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      load();
    }
  };
  const showDiff = (path: string, sha?: string) =>
    dialogs.custom((close) => <DiffDialog title={sha ? `${path} · ${sha.slice(0, 7)}` : `${path} · uncommitted changes`} load={() => lab.gitDiff(wid, path, sha).then((d) => d.diff)} onClose={close} />);
  const switchTo = async (name: string, create: boolean) => {
    setBranchMenu(false);
    if (!create && isDirty()) return void dialogs.alert("Unsaved changes", "Save or close the edited tabs before switching branches: the branch's files replace the open ones.");
    await act(async () => {
      await lab.gitCheckout(wid, name, create);
      onSwitched();
    });
  };
  if (!st) return <div className="jp-PanelBody">{err ? <p className="jp-ErrorText">{err}</p> : <p className="jp-Muted">Loading…</p>}</div>;
  return (
    <div style={{ overflow: "auto", flex: 1 }}>
      <div className="jp-PanelSection">
        <div className="jp-PanelRow" style={{ position: "relative" }}>
          <span className="jp-PanelRow-muted">Current Branch</span>
          <button type="button" className="jp-ToolbarButton jp-ComputeButton" style={{ marginLeft: "auto" }} onClick={() => setBranchMenu((v) => !v)} disabled={busy}>
            <JpIcon name="git" /> {st.branch} <JpIcon name="caretDown" />
          </button>
          {branchMenu && (
            <div className="jp-Menu" style={{ position: "absolute", top: 28, right: 8, left: "auto", minWidth: 220 }}>
              {st.branches.map((b) => (
                <button key={b} type="button" className="jp-Menu-item" onClick={() => b !== st.branch && void switchTo(b, false)}>
                  <span className="jp-Menu-itemCheck">{b === st.branch && <JpIcon name="check" />}</span>
                  <span className="jp-Menu-itemLabel">{b}</span>
                </button>
              ))}
              {st.branches.length > 0 && <div className="jp-Menu-sep" />}
              <button type="button" className="jp-Menu-item" disabled={!st.has_commits} title={st.has_commits ? undefined : "Commit once first"}
                onClick={async () => {
                  setBranchMenu(false);
                  const name = await dialogs.prompt("Create a Branch", "", "Create Branch", `A new branch from ${st.branch}. Name`);
                  if (name?.trim()) await switchTo(name.trim(), true);
                }}>
                <span className="jp-Menu-itemCheck"><JpIcon name="add" /></span>
                <span className="jp-Menu-itemLabel">New Branch…</span>
              </button>
            </div>
          )}
        </div>
        {err && <div className="jp-PanelBody jp-ErrorText jp-Small">{err}</div>}
      </div>

      <div className="jp-PanelSection">
        <div className="jp-PanelSection-header">
          Changes ({st.changes.length})
          <button type="button" className="jp-ToolbarButton" title="Refresh" onClick={load}><JpIcon name="refresh" /></button>
        </div>
        {st.changes.length === 0 && <div className="jp-PanelRow jp-PanelRow-muted">Nothing to commit: the files match {st.has_commits ? st.branch : "the empty repository"}.</div>}
        {st.changes.map((c) => (
          <div key={c.path} className="jp-PanelRow" title={`${c.path} (${c.status})`} onDoubleClick={() => c.status !== "deleted" && onOpen(c.path)}>
            <JpIcon name={fileIcon(c.path, c.path.endsWith(".ipynb") ? "notebook" : "file")} />
            <span className="jp-PanelRow-label" style={c.status === "deleted" ? { textDecoration: "line-through" } : undefined}>{c.path}</span>
            <button type="button" className="jp-ToolbarButton" title="Diff this file" onClick={() => showDiff(c.path)}><JpIcon name="diff" /></button>
            <button type="button" className="jp-ToolbarButton" title={c.status === "untracked" ? "Discard: delete this new file (a checkpoint keeps it)" : "Discard changes (a checkpoint keeps them)"} disabled={busy}
              onClick={async () => {
                if (!(await dialogs.confirm("Discard changes?", `"${c.path}" goes back to its last committed state${c.status === "untracked" ? " (it is new, so it is removed)" : ""}. Its current state is kept as a checkpoint.`, "Discard", true))) return;
                await act(async () => {
                  await lab.gitRestore(wid, c.path);
                  onRestored(c.path);
                });
              }}>
              <JpIcon name="undo" />
            </button>
            <span className={`jp-GitStatus jp-GitStatus-${c.status}`}>{LETTER[c.status] ?? "M"}</span>
          </div>
        ))}
        <div className="jp-PanelBody">
          <textarea className="jp-GitMessage" placeholder="Summary (required)" rows={2} value={msg} onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && msg.trim() && st.changes.length) document.getElementById(`jp-commit-${wid}`)?.click();
            }} />
          <button id={`jp-commit-${wid}`} type="button" className="jp-Button jp-mod-accept" style={{ width: "100%", marginTop: 6 }} disabled={busy || !msg.trim() || !st.changes.length}
            onClick={() => act(async () => {
              await lab.gitCommit(wid, msg.trim());
              setMsg("");
            })}>
            Commit {st.changes.length ? `${st.changes.length} file${st.changes.length === 1 ? "" : "s"}` : ""} to {st.branch}
          </button>
          <p className="jp-Small jp-Muted">Saved files are only in the working copy until committed. Notebooks are saved with their outputs.</p>
        </div>
      </div>

      <div className="jp-PanelSection">
        <div className="jp-PanelSection-header">History</div>
        {log.length === 0 && <div className="jp-PanelRow jp-PanelRow-muted">No commits yet.</div>}
        {log.map((c) => (
          <div key={c.sha}>
            <button type="button" className={`jp-TOC-item${open?.sha === c.sha ? " jp-mod-active" : ""}`} style={{ whiteSpace: "normal", lineHeight: 1.35, padding: "5px 12px" }}
              onClick={() => (open?.sha === c.sha ? setOpen(null) : void lab.gitCommitFiles(wid, c.sha).then((r) => setOpen({ sha: c.sha, files: r.files }), (e: Error) => setErr(e.message)))}>
              <div>{c.message}</div>
              <div className="jp-Small jp-Muted"><span className="jp-Code">{c.short}</span> · {c.author} · {relTime(c.at)}</div>
            </button>
            {open?.sha === c.sha && open.files.map((f) => (
              <div key={f.path} className="jp-PanelRow" style={{ paddingLeft: 24 }}>
                <span className={`jp-GitStatus jp-GitStatus-${f.status}`}>{LETTER[f.status] ?? "M"}</span>
                <span className="jp-PanelRow-label" title={f.path}>{f.path}</span>
                <button type="button" className="jp-ToolbarButton" title="Diff in this commit" onClick={() => showDiff(f.path, c.sha)}><JpIcon name="diff" /></button>
                {f.status !== "deleted" && (
                  <button type="button" className="jp-ToolbarButton" title="Restore this version of the file" disabled={busy}
                    onClick={async () => {
                      if (!(await dialogs.confirm("Restore this version?", `"${f.path}" is replaced by its version in ${c.short} ("${c.message}"). Its current state is kept as a checkpoint; commit to keep the restored version.`, "Restore"))) return;
                      await act(async () => {
                        await lab.gitRestore(wid, f.path, c.sha);
                        onRestored(f.path);
                      });
                    }}>
                    <JpIcon name="history" />
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
