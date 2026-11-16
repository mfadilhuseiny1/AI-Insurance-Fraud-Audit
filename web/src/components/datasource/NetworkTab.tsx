"use client";

import { useEffect, useState } from "react";
import { dcAgents, type DcAgent } from "./AgentsTab";
import { network, type EgressPolicy, type EgressPolicyIn, type NetworkSettings, type RouteCheck } from "@/lib/dataConnection";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { Icon } from "../Icon";
import { buttonClass, inputClass, Modal } from "../pipeline/Modal";
import { Field, Switch } from "../pipeline/ui";
import { useLoad } from "./DataSourceWizard";
import { EmptyState, ErrorLine, TabPage } from "./dcui";

const PROVIDER_LABEL: Record<string, string> = { aws: "AWS PrivateLink", azure: "Azure Private Link", gcp: "GCP Private Service Connect", other: "Other private endpoint" };
const ENDPOINT_HINT: Record<string, string> = {
  aws: "The VPC endpoint id, e.g. vpce-0a1b2c3d4e5f (for reference)",
  azure: "The private endpoint resource id, e.g. /subscriptions/…/privateEndpoints/… (for reference)",
  gcp: "The Private Service Connect endpoint, e.g. projects/…/forwardingRules/… (for reference)",
  other: "Any reference for the endpoint (optional)",
};

/** Network: egress policies (direct and private link), ingress allowlists and a route checker. */
export function NetworkTab() {
  const [nonce, setNonce] = useState(0);
  const policies = useLoad(`net-policies:${nonce}`, () => network.policies());
  const settings = useLoad(`net-settings:${nonce}`, () => network.settings());
  const [editing, setEditing] = useState<EgressPolicy | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => setNonce((n) => n + 1);
  const s = settings.data ?? settings.last;
  const list = policies.data ?? policies.last;

  const save = async (change: Partial<Omit<NetworkSettings, "your_ip" | "routes">>) => {
    setError(null);
    try {
      await network.saveSettings(change);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <TabPage
      title="Network"
      description="Which external systems data connections may reach (egress), how private destinations are routed (private links), and which clients may reach the platform (ingress)."
      actions={
        <button type="button" onClick={() => setEditing("new")} className={buttonClass.primary}>
          <Icon name="plus" /> New egress policy
        </button>
      }
    >
      {error && <div className="mb-4"><ErrorLine text={error} /></div>}
      {(policies.error || settings.error) && <ErrorLine text={policies.error ?? settings.error ?? ""} />}

      {/* ---------------- egress ---------------- */}
      <section className="mb-8">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold">Egress policies</h2>
          <span className="text-xs text-muted">connections, syncs, exports, virtual tables, REST sources and webhooks</span>
        </div>
        {s && (
          <div className="mb-3 rounded-xl border border-line bg-panel p-4">
            <Switch
              on={s.enforce_egress}
              onChange={async (on) => {
                if (on && !(await confirmDialog({ message: "Enforce egress policies? Connections to destinations no policy allows will be refused (localhost stays reachable).", confirmLabel: "Enforce" })))
                  return;
                void save({ enforce_egress: on });
              }}
              label="Enforce egress policies"
              hint="Off: policies only add private link routes and document destinations. On: every destination must match a policy."
            />
          </div>
        )}
        {!list ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : list.length === 0 ? (
          <EmptyState
            icon="globe"
            title="No egress policies"
            text="Add a direct policy for each system connections may reach, or a private link to route a host name to a private endpoint (AWS PrivateLink, Azure Private Link, GCP Private Service Connect)."
            action={
              <button type="button" onClick={() => setEditing("new")} className={buttonClass.primary}>
                <Icon name="plus" /> New egress policy
              </button>
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="bg-panel text-left text-xs text-muted">
                <tr>
                  {["Name", "Type", "Destination", "Route", "Status", ""].map((h) => (
                    <th key={h} className="whitespace-nowrap px-4 py-2.5 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id} onClick={() => setEditing(p)} className="cursor-pointer border-t border-line hover:bg-panel/60">
                    <td className="px-4 py-2.5">
                      <span className="block font-medium">{p.name}</span>
                      {p.description && <span className="block max-w-xs truncate text-xs text-muted">{p.description}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      {p.kind === "agent_proxy" ? (
                        <span className="rounded bg-sand/15 px-1.5 py-0.5 text-sand">Agent proxy</span>
                      ) : p.kind === "private_link" ? (
                        <span className="rounded bg-ocean/15 px-1.5 py-0.5 text-ocean">{PROVIDER_LABEL[p.provider ?? "other"]}</span>
                      ) : (
                        <span className="rounded bg-panel-2 px-1.5 py-0.5 text-soft ring-1 ring-line-2">Direct connection</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {p.host}
                      <span className="text-muted">{p.ports.length ? `:${p.ports.join(",")}` : ":any"}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-soft">
                      {p.kind === "agent_proxy" ? (
                        <span>through an agent</span>
                      ) : p.kind === "private_link" ? (
                        <span className="font-mono">→ {p.target}</span>
                      ) : (
                        "as resolved"
                      )}
                      {p.endpoint_id && <span className="block truncate text-muted">{p.endpoint_id}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs">{p.enabled ? <span className="text-ok">● Active</span> : <span className="text-muted">○ Disabled</span>}</td>
                    <td className="px-4 py-2.5 text-right text-xs text-muted">updated {when(p.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <RouteChecker />
      </section>

      {/* ---------------- ingress ---------------- */}
      {s && (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-sm font-semibold">Ingress</h2>
            <span className="text-xs text-muted">
              your address: <code className="text-soft">{s.your_ip}</code>
            </span>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <CidrCard
              title="Platform API"
              hint="Clients allowed to reach the platform's API. Loopback (this machine, including the web app's server) is always allowed."
              enabled={s.enforce_ingress}
              cidrs={s.ingress_cidrs}
              yourIp={s.your_ip}
              onSave={(enforce_ingress, ingress_cidrs) => save({ enforce_ingress, ingress_cidrs })}
            />
            <CidrCard
              title="Listener endpoints"
              hint="Systems allowed to post events to listeners (/api/listen/…). Use the provider's published IP ranges, e.g. GitHub's hooks ranges."
              enabled={s.enforce_listener_ingress}
              cidrs={s.listener_cidrs}
              onSave={(enforce_listener_ingress, listener_cidrs) => save({ enforce_listener_ingress, listener_cidrs })}
            />
          </div>
          <div className="mt-4 rounded-xl border border-line bg-panel p-4">
            <div className="text-sm font-medium">Trusted proxies</div>
            <p className="mt-0.5 text-xs text-muted">
              When the platform is reached through a reverse proxy, a load balancer or a private link endpoint (ingress private link), list its addresses: the client address is then read from
              X-Forwarded-For instead of the proxy&apos;s own.
            </p>
            <ListEditor value={s.trusted_proxies} placeholder="10.0.0.5/32" onSave={(trusted_proxies) => save({ trusted_proxies })} />
          </div>
        </section>
      )}

      {editing && (
        <PolicyEditor
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </TabPage>
  );
}

function ListEditor({ value, placeholder, onSave }: { value: string[]; placeholder: string; onSave: (v: string[]) => void }) {
  const [text, setText] = useState(value.join("\n"));
  const dirty = text.split(/[\n,]/).map((x) => x.trim()).filter(Boolean).join("\n") !== value.join("\n");
  return (
    <div className="mt-2">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={placeholder} className={`${inputClass} font-mono text-xs`} />
      {dirty && (
        <button type="button" onClick={() => onSave(text.split(/[\n,]/).map((x) => x.trim()).filter(Boolean))} className={`${buttonClass.primary} mt-2 py-1 text-xs`}>
          Save
        </button>
      )}
    </div>
  );
}

function CidrCard({ title, hint, enabled, cidrs, yourIp, onSave }: { title: string; hint: string; enabled: boolean; cidrs: string[]; yourIp?: string; onSave: (enabled: boolean, cidrs: string[]) => void }) {
  const [text, setText] = useState(cidrs.join("\n"));
  const parsed = text.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  const dirty = parsed.join("\n") !== cidrs.join("\n");
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="text-sm font-medium">{title}</div>
      <p className="mt-0.5 text-xs text-muted">{hint}</p>
      <div className="mt-3">
        <Switch on={enabled} onChange={(on) => onSave(on, parsed)} label="Enforce the allowlist" hint={enabled ? "Only the addresses below (and loopback) are allowed." : "Off: every address is allowed."} />
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={"203.0.113.0/24\n198.51.100.7"} className={`${inputClass} mt-3 font-mono text-xs`} />
      <div className="mt-2 flex items-center gap-2">
        {yourIp && !yourIp.startsWith("127.") && yourIp !== "::1" && (
          <button type="button" onClick={() => setText([...parsed, `${yourIp}/32`].join("\n"))} className={`${buttonClass.ghost} py-0.5 text-xs`}>
            <Icon name="plus" className="h-3 w-3" /> Add my address
          </button>
        )}
        {dirty && (
          <button type="button" onClick={() => onSave(enabled, parsed)} className={`${buttonClass.primary} ml-auto py-1 text-xs`}>
            Save allowlist
          </button>
        )}
      </div>
    </div>
  );
}

function RouteChecker() {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("443");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<RouteCheck | { error: string } | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      setRes(await network.check(host.trim(), Number(port) || 443));
    } catch (e) {
      setRes({ error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 rounded-xl border border-line bg-panel p-4">
      <div className="text-sm font-medium">Check a destination</div>
      <p className="mt-0.5 text-xs text-muted">Which policy applies to a host and port, where its traffic is routed, and whether this server can open a connection to it.</p>
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="db.internal.example.com" className={`${inputClass} flex-1 font-mono text-xs`} />
        <input value={port} onChange={(e) => setPort(e.target.value)} className={`${inputClass} w-24 font-mono text-xs`} />
        <button type="submit" disabled={busy || !host.trim()} className={`${buttonClass.secondary} py-1 text-xs`}>
          <Icon name={busy ? "refresh" : "signal"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> Check
        </button>
      </form>
      {res &&
        ("host" in res ? (
          <dl className="mt-3 grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted">Policy</dt>
            <dd className={res.allowed ? "text-soft" : "text-bad"}>{res.policy ? res.policy.name : res.allowed ? "none (egress not enforced)" : "none — refused while egress is enforced"}</dd>
            <dt className="text-muted">Route</dt>
            <dd className="text-soft">{res.route === "private_link" ? `private link → ${res.target}` : "direct"}</dd>
            <dt className="text-muted">Addresses</dt>
            <dd className="font-mono text-soft">{res.addresses?.join(", ") ?? "—"}</dd>
            <dt className="text-muted">Connection</dt>
            <dd className={res.reachable ? "text-ok" : "text-bad"}>{res.reachable ? `connected in ${res.ms} ms` : res.error}</dd>
          </dl>
        ) : (
          <p className="mt-2 text-xs text-bad">{res.error}</p>
        ))}
    </div>
  );
}

function PolicyEditor({ initial, onClose, onSaved }: { initial: EgressPolicy | null; onClose: () => void; onSaved: () => void }) {
  const [p, setP] = useState<EgressPolicyIn>(
    initial
      ? { name: initial.name, kind: initial.kind, provider: initial.provider, host: initial.host, ports: initial.ports, target: initial.target, endpoint_id: initial.endpoint_id, description: initial.description, enabled: initial.enabled }
      : { name: "", kind: "direct", provider: null, host: "", ports: [], target: null, endpoint_id: null, description: "", enabled: true },
  );
  const [ports, setPorts] = useState(p.ports.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<EgressPolicyIn>) => setP({ ...p, ...patch });
  const link = p.kind === "private_link";
  const viaAgent = p.kind === "agent_proxy";
  const [agents, setAgents] = useState<DcAgent[]>([]);
  useEffect(() => {
    dcAgents.list().then(setAgents, () => {});
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body = { ...p, ports: ports.split(/[\s,]+/).filter(Boolean).map(Number), provider: link ? (p.provider ?? "other") : null };
    try {
      if (initial) await network.updatePolicy(initial.id, body);
      else await network.createPolicy(body);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? `Egress policy · ${initial.name}` : "New egress policy"} icon="globe" onClose={onClose} wide>
      <div className="max-h-[78vh] space-y-4 overflow-y-auto p-5 text-sm">
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ["direct", "Direct connection", "The destination is reachable from this server's network (the Internet, or a network it is routed to)."],
              ["private_link", "Private link", "Route a host name to a private endpoint in your cloud network — AWS PrivateLink, Azure Private Link, GCP Private Service Connect — without the public Internet."],
              ["agent_proxy", "Agent proxy", "Reach a host inside your network through a Data Connection agent: the agent opens the connection, nothing inbound is exposed."],
            ] as const
          ).map(([kind, label, hint]) => (
            <label key={kind} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${p.kind === kind ? "border-ocean bg-ocean/10" : "border-line-2 hover:bg-panel-2"}`}>
              <input type="radio" checked={p.kind === kind} onChange={() => set({ kind })} className="mt-0.5 accent-[var(--color-ocean)]" />
              <span>
                <span className="block font-medium">{label}</span>
                <span className="block text-xs text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required>
            <input value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder={link ? "Warehouse via PrivateLink" : "Snowflake account"} className={inputClass} />
          </Field>
          {link && (
            <Field label="Provider">
              <select value={p.provider ?? "aws"} onChange={(e) => set({ provider: e.target.value as EgressPolicyIn["provider"] })} className={inputClass}>
                {Object.entries(PROVIDER_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={link ? "Host name" : "Destination"} required hint={link ? "The name connections use, e.g. warehouse.internal.example.com." : "A host name, a wildcard (*.snowflakecomputing.com), an IP address or a CIDR block (10.20.0.0/16)."}>
            <input value={p.host} onChange={(e) => set({ host: e.target.value })} placeholder={link ? "warehouse.internal.example.com" : "*.example.com"} className={`${inputClass} font-mono`} />
          </Field>
          <Field label="Ports" hint="Comma-separated; empty allows every port.">
            <input value={ports} onChange={(e) => setPorts(e.target.value)} placeholder="443, 5432" className={`${inputClass} font-mono`} />
          </Field>
          {viaAgent && (
            <Field label="Agent" required hint="The agent inside the destination's network (Data Connection → Agents).">
              <select value={p.target ?? ""} onChange={(e) => set({ target: e.target.value || null })} className={inputClass}>
                <option value="">Choose an agent…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.status})
                  </option>
                ))}
              </select>
            </Field>
          )}
          {link && (
            <>
              <Field label="Private endpoint" required hint="The endpoint's private IP address or DNS name (e.g. the VPC endpoint's DNS name). TLS still uses the host name.">
                <input value={p.target ?? ""} onChange={(e) => set({ target: e.target.value })} placeholder="10.20.3.14 or vpce-0a1b….vpce-svc-….us-east-1.vpce.amazonaws.com" className={`${inputClass} font-mono`} />
              </Field>
              <Field label="Endpoint id" hint={ENDPOINT_HINT[p.provider ?? "aws"]}>
                <input value={p.endpoint_id ?? ""} onChange={(e) => set({ endpoint_id: e.target.value })} className={`${inputClass} font-mono`} />
              </Field>
            </>
          )}
        </div>
        <Field label="Description">
          <input value={p.description} onChange={(e) => set({ description: e.target.value })} className={inputClass} />
        </Field>
        <Switch on={p.enabled} onChange={(enabled) => set({ enabled })} label="Active" hint="A disabled policy neither allows nor routes." />
        {link && (
          <p className="rounded-lg bg-panel-2 p-3 text-xs text-muted ring-1 ring-line-2">
            Set up the endpoint in your cloud first (an interface VPC endpoint, an Azure private endpoint or a PSC endpoint) in a network this server can reach. Connections to{" "}
            <code className="text-soft">{p.host || "the host"}</code> are then sent to it, as a private DNS zone would do — for database drivers, HTTP sources and webhooks alike.
          </p>
        )}
        {error && <ErrorLine text={error} />}
        <div className="flex items-center justify-end gap-2">
          {initial && (
            <button
              type="button"
              onClick={async () => {
                if (!(await confirmDialog(`Delete the egress policy "${initial.name}"?`))) return;
                try {
                  await network.deletePolicy(initial.id);
                  onSaved();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
              className={`${buttonClass.secondary} mr-auto text-bad`}
            >
              <Icon name="trash" className="h-3.5 w-3.5" /> Delete
            </button>
          )}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={busy || !p.name.trim() || !p.host.trim() || ((link || viaAgent) && !p.target?.trim())} onClick={save} className={buttonClass.primary}>
            <Icon name="save" className="h-3.5 w-3.5" /> {busy ? "Saving…" : "Save policy"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
