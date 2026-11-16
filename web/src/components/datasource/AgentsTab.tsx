"use client";

import { useCallback, useEffect, useState } from "react";
import { api, API_URL, type DriveItem } from "@/lib/api";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { Icon } from "../Icon";
import { buttonClass, inputClass, Modal } from "../pipeline/Modal";
import { EmptyState, ErrorLine, TabPage } from "./dcui";

export type DcAgent = {
  id: string;
  name: string;
  path: string[];
  status: "online" | "offline";
  connected_at: string | null;
  last_seen: string | null;
  created_at: string;
  created_by: string;
  host: { hostname?: string; os?: string; python?: string; agent_version?: string; allowlist?: string[] } | null;
  open_streams: number;
  can_manage: boolean;
  policies: { id: string; name: string; host: string; ports: number[]; enabled: boolean }[];
  token?: string;
};

async function req<T>(path: string, method = "GET", json?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/dc-agents${path}`, {
    method,
    cache: "no-store",
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const b = await res.json();
      msg = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export const dcAgents = { list: () => req<DcAgent[]>("") };

/** Data Connection → Agents (api/dc_agents.py): agents inside customer networks, for agent proxy egress policies. */
export function AgentsTab() {
  const [agents, setAgents] = useState<DcAgent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<DcAgent | null>(null);
  const load = useCallback(() => req<DcAgent[]>("").then(setAgents, (e: Error) => setErr(e.message)), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);
  return (
    <TabPage
      title="Agents"
      description={
        <>
          An agent runs inside your network and makes only an outbound connection to this platform. Sources reach systems in that network through it with an{" "}
          <strong>agent proxy</strong> egress policy (Network tab): TLS stays end to end and no inbound port is opened. Agent worker (running syncs on the agent) is legacy: syncs
          run here.
        </>
      }
      actions={
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New agent
        </button>
      }
    >
      {err && <ErrorLine text={err} />}
      {agents?.length === 0 && <EmptyState icon="server" title="No agents" text="Create an agent, install it on a host in your network and start it with its token." />}
      <div className="space-y-2">
        {agents?.map((a) => (
          <button key={a.id} type="button" onClick={() => setShown(a)} className="flex w-full items-center gap-3 rounded-xl border border-line bg-panel p-4 text-left hover:bg-panel-2">
            <span className={`h-2.5 w-2.5 rounded-full ${a.status === "online" ? "bg-ok" : "bg-muted"}`} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{a.name}</span>
              <span className="block text-xs text-muted">
                {a.path.join(" / ")} · {a.status === "online" ? `online since ${when(a.connected_at!)}` : a.last_seen ? `offline · last seen ${when(a.last_seen)}` : "never connected"}
                {a.host?.hostname ? ` · ${a.host.hostname} (${a.host.os})` : ""}
              </span>
            </span>
            <span className="text-xs text-muted">{a.policies.length} egress polic{a.policies.length === 1 ? "y" : "ies"}</span>
          </button>
        ))}
      </div>
      {creating && (
        <NewAgent
          onClose={() => setCreating(false)}
          onCreated={(a) => {
            setCreating(false);
            setShown(a);
            load();
          }}
        />
      )}
      {shown && <AgentDialog agent={shown} onClose={() => setShown(null)} onChanged={load} />}
    </TabPage>
  );
}

function NewAgent({ onClose, onCreated }: { onClose: () => void; onCreated: (a: DcAgent) => void }) {
  const [name, setName] = useState("");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [project, setProject] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.drive.folder(null).then((f) => {
      const ps = f.items.filter((i) => i.kind === "project");
      setProjects(ps);
      setProject((c) => c || ps[0]?.id || "");
    }, () => {});
  }, []);
  return (
    <Modal title="New agent" icon="server" onClose={onClose}>
      <div className="space-y-3 p-5 text-sm">
        <label className="block text-xs text-muted">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} mt-1`} placeholder="datacenter-agent-1" />
        </label>
        <label className="block text-xs text-muted">
          Project (who can see, manage and use the agent)
          <select value={project} onChange={(e) => setProject(e.target.value)} className={`${inputClass} mt-1`}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {err && <ErrorLine text={err} />}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim() || !project}
            onClick={() => req<DcAgent>("", "POST", { name: name.trim(), project_id: project }).then(onCreated, (e: Error) => setErr(e.message))}
            className={buttonClass.primary}
          >
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AgentDialog({ agent, onClose, onChanged }: { agent: DcAgent; onClose: () => void; onChanged: () => void }) {
  const [a, setA] = useState(agent);
  const [err, setErr] = useState<string | null>(null);
  const origin = (() => {
    try {
      return new URL(API_URL || window.location.origin).origin;
    } catch {
      return "http://localhost:8000";
    }
  })();
  return (
    <Modal title={`Agent · ${a.name}`} icon="server" onClose={onClose} wide>
      <div className="max-h-[78vh] space-y-4 overflow-y-auto p-5 text-sm">
        <dl className="grid grid-cols-[9rem_1fr] gap-y-1 text-xs">
          <dt className="text-muted">Status</dt>
          <dd className={a.status === "online" ? "text-ok" : "text-muted"}>
            {a.status}
            {a.status === "online" ? ` · ${a.open_streams} open connections` : ""}
          </dd>
          <dt className="text-muted">Host</dt>
          <dd className="text-soft">{a.host ? `${a.host.hostname} · ${a.host.os} · Python ${a.host.python} · agent ${a.host.agent_version}` : "not connected yet"}</dd>
          <dt className="text-muted">Allowlist</dt>
          <dd className="text-soft">{a.host?.allowlist?.length ? a.host.allowlist.join(", ") : "any destination the policies name"}</dd>
          <dt className="text-muted">Last seen</dt>
          <dd className="text-soft">{a.last_seen ? when(a.last_seen) : "—"}</dd>
          <dt className="text-muted">Egress policies</dt>
          <dd className="text-soft">{a.policies.map((p) => `${p.name} (${p.host}:${p.ports.join(",")}${p.enabled ? "" : ", disabled"})`).join("; ") || "none — add an agent proxy policy in the Network tab"}</dd>
        </dl>
        {a.token && (
          <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs">
            <p className="mb-1 font-medium text-warn">The agent&apos;s token is shown once: copy it now.</p>
            <code className="block break-all font-mono text-soft">{a.token}</code>
          </div>
        )}
        <div className="rounded-lg bg-panel-2 p-3 text-xs ring-1 ring-line-2">
          <p className="mb-1 font-medium text-soft">Install and start (on the agent host)</p>
          <pre className="overflow-x-auto font-mono text-[11px] text-soft">{`pip install websockets
python bluesandai_agent.py --url ${origin} --token ${a.token ?? "<agent token>"}
# optional: --allow db.internal:5432   --resolve db.internal=10.0.0.5`}</pre>
          <div className="mt-2 flex gap-3">
            <a href={`${API_URL}/api/dc-agents/${a.id}/download`} className="text-ocean hover:underline">
              Download bluesandai_agent.py
            </a>
            <span className="text-muted">The host only needs outbound access to {origin}. Run it under a service manager so it restarts.</span>
          </div>
        </div>
        {err && <ErrorLine text={err} />}
        {a.can_manage && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={async () => {
                if (!(await confirmDialog("Rotate the agent's token? The running agent disconnects until it is restarted with the new token."))) return;
                try {
                  setA(await req<DcAgent>(`/${a.id}/token`, "POST"));
                  onChanged();
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
              className={buttonClass.secondary}
            >
              Rotate token
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
