"use client";

import { useState } from "react";
import { Icon, type IconName } from "../Icon";
import { AgentsTab } from "./AgentsTab";
import { ConnectionsTab } from "./ConnectionsTab";
import DataSources from "./DataSources";
import { DataSourceWizard } from "./DataSourceWizard";
import { StreamingSyncs } from "../streaming/StreamingSyncs";
import { ExportsTab } from "./ExportsTab";
import { HyperAutoTab } from "./HyperAutoTab";
import { ListenersTab } from "./ListenersTab";
import { NetworkTab } from "./NetworkTab";
import { ViewsTab } from "./ViewsTab";
import { VirtualTablesTab } from "./VirtualTablesTab";
import { WebhooksTab } from "./WebhooksTab";

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "syncs", label: "Syncs", icon: "database" },
  { id: "streaming", label: "Streaming syncs", icon: "wave" },
  { id: "connections", label: "Connections", icon: "plug" },
  { id: "exports", label: "Exports", icon: "upload" },
  { id: "webhooks", label: "Webhooks", icon: "globe" },
  { id: "listeners", label: "Listeners", icon: "bell" },
  { id: "views", label: "Views", icon: "eye" },
  { id: "virtual", label: "Virtual tables", icon: "table" },
  { id: "hyperauto", label: "HyperAuto", icon: "bolt" },
  { id: "agents", label: "Agents", icon: "server" },
  { id: "network", label: "Network", icon: "globe" },
];
type Tab = "syncs" | "streaming" | "connections" | "exports" | "webhooks" | "listeners" | "views" | "virtual" | "hyperauto" | "agents" | "network";

/** Data Connection: syncs in, exports out, webhooks, listeners, Views and HyperAuto. */
export default function DataConnection() {
  // a link to an export (/sources?export=<id>, from a sync check notification) opens the Exports tab
  const [tab, setTab] = useState<Tab>(() => (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("export") ? "exports" : "syncs"));
  const [wizard, setWizard] = useState(false);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-panel px-3 text-sm">
        <span className="mr-3 flex items-center gap-1.5 font-medium">
          <Icon name="plug" className="h-4 w-4 text-ocean" /> Data Connection
        </span>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 ${tab === t.id ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-muted hover:bg-panel-2 hover:text-white"}`}
          >
            <Icon name={t.icon} className="h-3.5 w-3.5" /> {t.label}
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 flex-1">
        {tab === "syncs" && <DataSources />}
        {tab === "streaming" && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-6xl p-6">
              <StreamingSyncs />
            </div>
          </div>
        )}
        {tab === "connections" && <ConnectionsTab onNew={() => setWizard(true)} />}
        {tab === "exports" && <ExportsTab />}
        {tab === "webhooks" && <WebhooksTab />}
        {tab === "listeners" && <ListenersTab />}
        {tab === "views" && <ViewsTab />}
        {tab === "virtual" && <VirtualTablesTab />}
        {tab === "hyperauto" && <HyperAutoTab />}
        {tab === "agents" && <AgentsTab />}
        {tab === "network" && <NetworkTab />}
      </div>
      {wizard && <DataSourceWizard onClose={() => setWizard(false)} />}
    </div>
  );
}
