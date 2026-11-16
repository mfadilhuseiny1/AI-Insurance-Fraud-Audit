"use client";

import { useState } from "react";
import { api, type DbConnection } from "@/lib/api";
import { connections, type Diagnosis } from "@/lib/dataConnection";
import { when } from "@/lib/format";
import { Icon } from "../Icon";
import { buttonClass } from "../pipeline/Modal";
import { Switch } from "../pipeline/ui";
import { ConnectorLogo } from "./ConnectorLogo";
import { useLoad } from "./DataSourceWizard";
import { EmptyState, ErrorLine, TabPage } from "./dcui";
import { FILE_KINDS, FileTools } from "./FileTools";
import { SAP_KINDS, SapTools } from "./SapTools";
import { confirmDialog } from "@/lib/dialogs";
import { ResourceMarkings } from "@/components/auth/ItemMarkings";

/** Connections: settings (exports, code imports) and troubleshooting. */
export function ConnectionsTab({ onNew }: { onNew: () => void }) {
  const list = useLoad("connections", () => api.dataSources.connections());
  const [diag, setDiag] = useState<Record<string, Diagnosis | "running" | { error: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = async (c: DbConnection, change: { exports_enabled?: boolean; code_imports?: boolean }) => {
    setBusy(c.id);
    setError(null);
    try {
      await connections.settings(c.id, change);
      list.retry();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const diagnose = async (c: DbConnection) => {
    setDiag((d) => ({ ...d, [c.id]: "running" }));
    try {
      const r = await connections.diagnose(c.id);
      setDiag((d) => ({ ...d, [c.id]: r }));
    } catch (e) {
      setDiag((d) => ({ ...d, [c.id]: { error: (e as Error).message } }));
    }
  };
  const remove = async (c: DbConnection) => {
    if (!(await confirmDialog(`Delete the connection "${c.name}"? Its saved credentials are deleted too.`))) return;
    try {
      await api.dataSources.deleteConnection(c.id);
      list.retry();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const rows = list.data ?? list.last;

  return (
    <TabPage
      title="Connections"
      description="How the platform reaches each database. Credentials are encrypted and never shown again. Enable exports before writing a dataset to a connection, and use Diagnose when a connection stops working."
      actions={
        <button type="button" onClick={onNew} className={buttonClass.primary}>
          <Icon name="plus" /> New connection
        </button>
      }
    >
      {error && <ErrorLine text={error} />}
      {list.error && <ErrorLine text={list.error} onRetry={list.retry} />}
      {!rows ? (
        !list.error && <p className="text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState icon="plug" title="No connections yet" text="A connection is created with your first data source: pick a database, enter its address and credentials, and test it." action={<button type="button" onClick={onNew} className={buttonClass.primary}><Icon name="plus" /> New connection</button>} />
      ) : (
        <div className="mt-2 space-y-3">
          {rows.map((c) => {
            const d = diag[c.id];
            return (
              <div key={c.id} className="rounded-xl border border-line bg-panel p-4">
                <div className="flex items-start gap-3">
                  <ConnectorLogo kind={c.kind} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-muted">
                      {c.kind_name}
                      {c.config.host ? ` · ${c.config.host}${c.config.port ? `:${c.config.port}` : ""}` : ""}
                      {c.config.database ? ` · ${c.config.database}` : ""}
                      {c.version ? ` · ${c.version}` : ""}
                      {c.tested_at ? ` · tested ${when(c.tested_at)}` : ""}
                    </div>
                  </div>
                  <button type="button" onClick={() => diagnose(c)} disabled={d === "running"} className={`${buttonClass.secondary} py-1 text-xs`}>
                    <Icon name={d === "running" ? "refresh" : "bug"} className={`h-3.5 w-3.5 ${d === "running" ? "animate-spin" : ""}`} /> Diagnose
                  </button>
                  <button type="button" onClick={() => remove(c)} className="rounded p-1.5 text-muted hover:text-bad" title="Delete connection">
                    <Icon name="trash" className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Switch
                    on={!!c.exports_enabled}
                    disabled={busy === c.id}
                    onChange={(on) => set(c, { exports_enabled: on })}
                    label="Enable exports to this source"
                    hint={FILE_KINDS.includes(c.kind) ? "Allows file exports to write datasets into this source." : SAP_KINDS.includes(c.kind) ? "Allows BAPI calls and write-back to SAP through the Palantir add-on." : "Allows table exports to write datasets into this database. The credentials need INSERT (and DELETE for truncating modes)."}
                  />
                  <Switch
                    on={!!c.code_imports}
                    disabled={busy === c.id}
                    onChange={(on) => set(c, { code_imports: on })}
                    label="Allow imports into code repositories"
                    hint="Code repositories that import this source can use its credentials in code."
                  />
                </div>
                {d && d !== "running" && "error" in d && <p className="mt-3 text-xs text-bad">{d.error}</p>}
                {d && d !== "running" && "steps" in d && (
                  <div className="mt-3 rounded-lg border border-line-2 p-3 text-xs">
                    <ol className="space-y-1">
                      {d.steps.map((s) => (
                        <li key={s.step} className="flex items-start gap-2">
                          <Icon name={s.ok ? "check" : "alert"} className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${s.ok ? "text-ok" : "text-bad"}`} />
                          <span className="w-44 shrink-0 font-medium text-soft">{s.step}</span>
                          <span className={`min-w-0 flex-1 break-words ${s.ok ? "text-muted" : "text-bad"}`}>{s.detail}</span>
                          <span className="shrink-0 tabular-nums text-muted">{s.ms} ms</span>
                        </li>
                      ))}
                    </ol>
                    {d.hint && <p className="mt-2 rounded bg-warn/10 p-2 text-warn">{d.hint}</p>}
                  </div>
                )}
                <ResourceMarkings kind="connection" id={c.id} className="mt-3" />
                {FILE_KINDS.includes(c.kind) && <FileTools connection={c} />}
                {SAP_KINDS.includes(c.kind) && <SapTools connection={c} />}
              </div>
            );
          })}
        </div>
      )}
    </TabPage>
  );
}
