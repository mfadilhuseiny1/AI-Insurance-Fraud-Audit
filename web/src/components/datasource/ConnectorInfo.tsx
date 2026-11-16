"use client";

import type { ConnectorCapability, ConnectorSpec } from "@/lib/api";
import { Icon } from "../Icon";
import { buttonClass, Modal } from "../pipeline/Modal";
import { ConnectorLogo, GROUP_LABEL } from "./ConnectorLogo";

const STATUS_LABEL: Record<ConnectorCapability["status"], string> = {
  ga: "Generally available",
  beta: "Beta",
  unavailable: "Not available",
  other: "",
};

function capabilityTitle(c: ConnectorCapability, available: boolean) {
  const status = [STATUS_LABEL[c.status], c.note].filter(Boolean).join(" ");
  const here = !available ? "connector not available here yet" : c.supported ? "supported here" : "not supported here yet";
  return `${c.name} — ${status ? `${status} in Foundry, ` : ""}${here}`;
}

/** A connector's capabilities as chips: solid when this server supports them, outlined when not. */
export function CapabilityBadges({ spec, limit }: { spec: ConnectorSpec; limit?: number }) {
  const caps = limit ? spec.capabilities.slice(0, limit) : spec.capabilities;
  const more = spec.capabilities.length - caps.length;
  return (
    <span className="flex flex-wrap gap-1">
      {caps.map((c) => (
        <span
          key={c.name}
          title={capabilityTitle(c, spec.available)}
          className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] leading-4 ${
            c.supported ? "border-ok/40 bg-ok/10 text-ok" : "border-line-2 text-muted"
          }`}
        >
          {c.name}
          {/* a connector in beta is marked once, next to its name */}
          {c.status === "beta" && !spec.beta && <span className="rounded bg-warn/20 px-1 text-[9px] font-medium uppercase text-warn">beta</span>}
        </span>
      ))}
      {more > 0 && <span className="px-1 text-[10px] leading-5 text-muted">+{more}</span>}
    </span>
  );
}

/** The catalog reference of a connector: capabilities, configuration properties and network domains. */
export function ConnectorInfoDialog({ spec, onClose, onConnect }: { spec: ConnectorSpec; onClose: () => void; onConnect?: () => void }) {
  return (
    <Modal title={spec.name} icon="info" onClose={onClose} wide>
      <div className="space-y-5 p-5 text-sm">
        <div className="flex items-start gap-3">
          <ConnectorLogo kind={spec.id} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {spec.name}
              {spec.beta && <span className="ml-2 rounded bg-warn/20 px-1.5 py-0.5 text-[10px] font-medium uppercase text-warn">Beta in Foundry</span>}
            </p>
            <p className="text-xs text-muted">
              {GROUP_LABEL[spec.group] ?? spec.group} · {spec.description}
            </p>
            <p className={`mt-1 text-xs ${spec.available ? "text-ok" : "text-warn"}`}>
              {spec.available ? "Available on this server" : spec.unavailable || "Not available on this server yet"}
            </p>
          </div>
          {spec.docs_url && (
            <a href={spec.docs_url} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 text-xs text-ocean hover:underline">
              Foundry docs <Icon name="external" className="h-3 w-3" />
            </a>
          )}
        </div>

        <section>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Capabilities</h4>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="py-1.5 pr-3 font-medium">Capability</th>
                <th className="py-1.5 pr-3 font-medium">Status in Foundry</th>
                <th className="py-1.5 font-medium">This server</th>
              </tr>
            </thead>
            <tbody>
              {spec.capabilities.map((c) => (
                <tr key={c.name} className="border-b border-line/60">
                  <td className="py-1.5 pr-3">{c.name}</td>
                  <td className="py-1.5 pr-3">
                    <span className={c.status === "ga" ? "text-ok" : c.status === "beta" ? "text-warn" : "text-muted"}>● </span>
                    {STATUS_LABEL[c.status] || "—"}
                    {c.note && <span className="text-muted"> {c.note}</span>}
                  </td>
                  <td className="py-1.5">
                    {c.supported ? (
                      <span className="inline-flex items-center gap-1 text-ok">
                        <Icon name="check" className="h-3 w-3" /> Supported
                      </span>
                    ) : (
                      <span className="text-muted">Not yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {spec.properties.length > 0 && (
          <section>
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Configuration in Foundry</h4>
            <div className="space-y-1.5">
              {spec.properties.map((p) => (
                <div key={p.name} className="rounded-md border border-line bg-panel-2 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <code className="font-mono text-soft">{p.name}</code>
                    <span className={p.required ? "text-warn" : "text-muted"}>{p.requirement || (p.required ? "Required" : "Optional")}</span>
                    {p.default && (
                      <span className="text-muted">
                        default <code className="font-mono">{p.default}</code>
                      </span>
                    )}
                  </div>
                  {p.description && <p className="mt-0.5 text-xs text-muted">{p.description}</p>}
                </div>
              ))}
            </div>
          </section>
        )}

        {spec.networking.length > 0 && (
          <section>
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Network domains</h4>
            <p className="mb-2 text-xs text-muted">Add an egress policy (Network tab) for each domain the connection must reach.</p>
            <table className="w-full text-xs">
              <tbody>
                {spec.networking.map((n) => (
                  <tr key={`${n.domain}|${n.when}`} className="border-b border-line/60">
                    <td className="py-1.5 pr-3 font-mono text-soft">{n.domain}</td>
                    <td className="py-1.5 text-muted">{n.when}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {onConnect && spec.available && (
          <div className="flex justify-end">
            <button type="button" onClick={onConnect} className={buttonClass.primary}>
              Connect {spec.name} <Icon name="right" className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
