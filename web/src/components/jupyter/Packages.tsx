"use client";

import { useCallback, useEffect, useState } from "react";
import { lab, type Package, type PypiProject } from "@/lib/jupyterLab";
import { JpIcon } from "./icons";
import { DialogBox, useDialogs } from "./ui";

/** The Packages panel (Foundry's Libraries sidebar): the workspace's managed PyPI environment. */
export function PackagesPanel({ wid }: { wid: string }) {
  const dialogs = useDialogs();
  const [pkgs, setPkgs] = useState<Package[] | null>(null);
  const [uv, setUv] = useState(true);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<PypiProject | null>(null);
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => {
    lab.packages(wid).then((r) => {
      setPkgs(r.packages);
      setUv(r.uv);
    }, (e: Error) => setMsg({ ok: false, text: e.message }));
  }, [wid]);
  useEffect(load, [load]);

  const search = async () => {
    if (!q.trim()) return;
    setBusy("search");
    setMsg(null);
    setFound(null);
    try {
      const p = await lab.searchPackage(wid, q.trim());
      setFound(p);
      setVersion(p.latest ?? "");
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const install = async (name: string, v: string) => {
    setBusy(name);
    setMsg(null);
    try {
      const r = await lab.addPackage(wid, name, v);
      setMsg({ ok: true, text: `Installed ${r.installed}.${r.cloud_kernels ? ` Also installing in ${r.cloud_kernels} running cloud kernel${r.cloud_kernels === 1 ? "" : "s"}.` : ""} Restart a kernel that already imported it.` });
      setFound(null);
      setQ("");
      load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const showLock = () =>
    dialogs.custom((close) => <LockDialog wid={wid} onClose={close} />);

  return (
    <div style={{ overflow: "auto", flex: 1 }}>
      <div className="jp-PanelBody">
        <div className="jp-Small jp-Muted" style={{ marginBottom: 4 }} title="Conda is not available here: packages come from PyPI">Package manager: <b>PyPI</b> (uv)</div>
        <div style={{ display: "flex", gap: 6 }}>
          <input className="jp-mod-styled" style={{ flex: 1, minWidth: 0 }} placeholder="Package name, e.g. xgboost" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") void search(); }} />
          <button type="button" className="jp-Button jp-mod-small" style={{ height: 28 }} disabled={!q.trim() || busy === "search"} onClick={() => void search()}>Search</button>
        </div>
        {!uv && <p className="jp-WarnText jp-Small">uv is not installed on the server: packages cannot be installed on Local CPU.</p>}
        {found && (
          <div style={{ marginTop: 8, padding: 8, border: "1px solid var(--jp-border-color2)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <b>{found.name}</b>
              {found.home && <a href={found.home} target="_blank" rel="noreferrer" className="jp-Small" style={{ color: "var(--jp-content-link-color)" }}>home ↗</a>}
            </div>
            <p className="jp-Small jp-Muted" style={{ margin: "2px 0 6px" }}>{found.summary || "No description."}</p>
            {found.base && <p className="jp-Small jp-Muted" style={{ margin: "0 0 6px" }}>Already available without installing: {found.base}.</p>}
            <div style={{ display: "flex", gap: 6 }}>
              <select className="jp-mod-styled" value={version} onChange={(e) => setVersion(e.target.value)}>
                <option value="">Latest, unpinned (now {found.latest})</option>
                {found.versions.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
              <button type="button" className="jp-Button jp-mod-accept jp-mod-small" disabled={!!busy || !uv} onClick={() => void install(found.name, version)}>
                {busy === found.name ? "Installing…" : "Install"}
              </button>
            </div>
          </div>
        )}
        {busy && busy !== "search" && <p className="jp-Small jp-Muted">Installing {busy} with uv… dependencies are resolved too, this can take a minute.</p>}
        {msg && <p className={`jp-Small ${msg.ok ? "jp-OkText" : "jp-ErrorText"}`} style={{ whiteSpace: "pre-wrap" }}>{msg.text}</p>}
      </div>

      <div className="jp-PanelSection">
        <div className="jp-PanelSection-header">
          Workspace packages ({pkgs?.length ?? 0})
          <button type="button" className="jp-ToolbarButton" title="View the lockfile" onClick={showLock}><JpIcon name="file" /></button>
          <button type="button" className="jp-ToolbarButton" title="Install every package again (after a branch switch)" style={{ marginLeft: 0 }} disabled={!!busy}
            onClick={async () => {
              setBusy("sync");
              try {
                await lab.syncPackages(wid);
                setMsg({ ok: true, text: "The environment matches the workspace's packages." });
              } catch (e) {
                setMsg({ ok: false, text: (e as Error).message });
              } finally {
                setBusy(null);
                load();
              }
            }}>
            <JpIcon name="refresh" />
          </button>
        </div>
        {pkgs?.length === 0 && <div className="jp-PanelBody jp-Small jp-Muted">No packages added. The platform&apos;s environment already has pandas, numpy, scikit-learn, matplotlib, PyTorch and more; add what is missing.</div>}
        {pkgs?.map((p) => (
          <div key={p.name} className="jp-PanelRow" title={p.installed ? `installed ${p.installed}` : "not installed on Local CPU yet: sync"}>
            <JpIcon name="cube" />
            <span className="jp-PanelRow-label">{p.name}</span>
            <span className="jp-PanelRow-muted">{p.version ? `==${p.version}` : "latest"}{p.installed && p.installed !== p.version ? ` · ${p.installed}` : ""}</span>
            {!p.installed && <span className="jp-WarnText jp-Small">!</span>}
            <button type="button" className="jp-ToolbarButton" title="Remove from the workspace" disabled={!!busy}
              onClick={async () => {
                if (!(await dialogs.confirm("Remove package?", `${p.name} is removed from the workspace's packages and uninstalled from Local CPU. Cloud machines drop it when they restart.`, "Remove", true))) return;
                setBusy(p.name);
                try {
                  await lab.removePackage(wid, p.name);
                } catch (e) {
                  setMsg({ ok: false, text: (e as Error).message });
                } finally {
                  setBusy(null);
                  load();
                }
              }}>
              <JpIcon name="close" />
            </button>
          </div>
        ))}
        <div className="jp-PanelBody jp-Small jp-Muted">
          Kept in <code className="jp-Code">.bluesandai/packages.json</code> (versioned with Git). Installed into the workspace&apos;s own folder on Local CPU, and at start on cloud machines. <code className="jp-Code">%pip install</code> in a notebook adds here too.
        </div>
      </div>
    </div>
  );
}

function LockDialog({ wid, onClose }: { wid: string; onClose: () => void }) {
  const [lock, setLock] = useState<string | null>(null);
  useEffect(() => {
    lab.lockfile(wid).then((r) => setLock(r.lock || "(nothing installed)"), (e: Error) => setLock(e.message));
  }, [wid]);
  return (
    <DialogBox title="Lockfile" width={640} onClose={onClose} footer={<button type="button" className="jp-Button jp-mod-accept" onClick={onClose}>Close</button>}>
      <p className="jp-Small jp-Muted" style={{ margin: "0 0 6px" }}>What uv resolved in the workspace&apos;s package folder, dependencies included.</p>
      <pre className="jp-Snippet" style={{ maxHeight: 420, overflow: "auto" }}>{lock ?? "Loading…"}</pre>
    </DialogBox>
  );
}
