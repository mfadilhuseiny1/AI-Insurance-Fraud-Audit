"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, ErrorBox } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { API_URL } from "@/lib/api";

type Info = {
  enabled: boolean;
  host: string | null;
  port: number | null;
  database: string;
  error: string | null;
  user: string;
  auth: boolean;
  tls?: boolean;
  tls_required?: boolean;
  connections: number;
  queries: number;
  tables: { schema: string; table: string; kind: "dataset" | "object_type"; path?: string }[];
};
type QueryResult = { columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; tag: string };

async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(`${API_URL}/api/sql-bi${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    cache: "no-store",
    ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let m = res.statusText;
    try {
      const b = await res.json();
      m = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    throw new Error(m);
  }
  return res.json() as Promise<T>;
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }, () => undefined)} className="text-muted hover:text-white" title="Copy">
      <Icon name={done ? "check" : "copy"} className="h-3.5 w-3.5" />
    </button>
  );
}

function Snippet({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 p-2">
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted">{label}<Copy text={text} /></div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-soft">{text}</pre>
    </div>
  );
}

const GUIDES: { tool: string; steps: string[] }[] = [
  { tool: "Power BI Desktop", steps: ["Get data → PostgreSQL database.", "Server: HOST:PORT · Database: DB · Data Connectivity mode: Import (or DirectQuery).", "Database credentials: any user name, a personal API token as the password.", "If Power BI asks about encryption, choose to connect without it (the endpoint has no TLS)."] },
  { tool: "Tableau", steps: ["Connect → To a Server → PostgreSQL (install the PostgreSQL JDBC driver if Tableau asks).", "Server HOST, Port PORT, Database DB, Username any, Password a personal API token; leave Require SSL off.", "Tables appear per Project schema; object types are in the ontology schema."] },
  { tool: "Excel", steps: ["Data → Get Data → From Database → From PostgreSQL Database (or From Other Sources → ODBC with the psqlODBC driver).", "Server HOST:PORT, Database DB; Database credentials: a personal API token as the password.", "Or Data → From Web with the REST endpoint below (Power Query)."] },
  { tool: "Qlik Sense / MicroStrategy / Report Builder", steps: ["Use the tool's PostgreSQL connector (or an ODBC data source with the psqlODBC driver).", "Host HOST, port PORT, database DB, user any, password a personal API token, SSL off."] },
  { tool: "DBeaver, DataGrip and other JDBC tools", steps: ["New connection → PostgreSQL, then paste the JDBC URL below (or fill host / port / database).", "User any, password a personal API token."] },
];

export default function SqlBiPage() {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sql, setSql] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [qerr, setQerr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // the running query's id (Cancel interrupts it)
  const [running, setRunning] = useState<string | null>(null);
  const [branch, setBranch] = useState("");
  useEffect(() => {
    api<Info>("/info").then((i) => {
      setInfo(i);
      const first = i.tables.find((t) => t.kind === "dataset") ?? i.tables[0];
      if (first) setSql(`SELECT * FROM ${quote(first.schema)}.${quote(first.table)} LIMIT 100`);
    }, (e: Error) => setError(e.message));
  }, []);
  const tables = useMemo(() => (info?.tables ?? []).filter((t) => `${t.schema} ${t.table}`.toLowerCase().includes(filter.toLowerCase())), [info, filter]);
  const host = info?.host === "0.0.0.0" ? (typeof window !== "undefined" ? window.location.hostname : "localhost") : info?.host ?? "127.0.0.1";
  const port = info?.port ?? 5433;
  const db = info?.database ?? "foundry";
  const fill = (s: string) => s.replace(/HOST/g, host).replace(/PORT/g, String(port)).replace(/DB/g, db);

  return (
    <div className="flex-1 overflow-y-auto">
      <AppHeader app="SQL & BI connectivity" icon="database" href="/sql-bi" />
      <div className="mx-auto max-w-6xl space-y-5 p-6">
        <div>
          <h1 className="text-xl font-semibold">Connect BI tools with SQL</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Power BI, Tableau, Excel, Qlik Sense and any PostgreSQL ODBC / JDBC client query your datasets and Nexus objects read-only through a PostgreSQL-compatible endpoint.
            Sign in with any user name and a <Link href="/account" className="text-ocean hover:underline">personal API token</Link> as the password: queries see what the token&apos;s owner may see.
          </p>
        </div>
        <ErrorBox message={error} />
        {info && (
          <div className={`flex flex-wrap items-center gap-4 rounded-xl border p-4 text-sm ${info.enabled ? "border-good/40 bg-good/5" : "border-sand/40 bg-sand/10"}`}>
            <span className="flex items-center gap-2 font-medium"><span className={`h-2.5 w-2.5 rounded-full ${info.enabled ? "bg-good" : "bg-sand"}`} />{info.enabled ? "Endpoint running" : "Endpoint not running"}</span>
            {info.enabled ? <span className="font-mono text-xs">{host}:{port} · database {db}</span> : <span className="text-xs">{info.error}</span>}
            <span className="text-xs text-muted">{info.connections} open connection(s) · {info.queries} queries since start</span>
            {!info.auth && <span className="text-xs text-sand">Sign-in is off on this server: any password is accepted.</span>}
            <span className="w-full text-[11px] text-muted">
              {info.tls ? `TLS on${info.tls_required ? " and required" : ""}: connect with sslmode=require.` : "No TLS (set BLUESANDAI_SQL_TLS_CERT and BLUESANDAI_SQL_TLS_KEY to enable it)."} The endpoint listens on {info.host ?? "127.0.0.1"} only unless
              BLUESANDAI_SQL_HOST is set; BLUESANDAI_SQL_PORT changes the port (off disables it).
            </span>
          </div>
        )}

        <section className="grid gap-3 lg:grid-cols-2">
          <Snippet label="JDBC URL" text={fill("jdbc:postgresql://HOST:PORT/DB?sslmode=disable")} />
          <Snippet label="ODBC connection string (psqlODBC)" text={fill("Driver={PostgreSQL Unicode};Server=HOST;Port=PORT;Database=DB;Uid=analyst;Pwd=<API token>;SSLMode=disable")} />
          <Snippet label="psql" text={fill("psql \"host=HOST port=PORT dbname=DB user=analyst sslmode=disable\"   # password: your API token")} />
          <Snippet label="REST (Power Query From Web, scripts)" text={`POST ${API_URL}/api/sql-bi/query\nAuthorization: Bearer <API token>\n{"sql": "SELECT …", "format": "json" | "csv", "limit": 10000, "branch": "<optional>"}`} />
          <Snippet label="Branch (datasets from a branch, else master)" text={fill("jdbc:postgresql://HOST:PORT/DB?sslmode=disable&options=-c%20branch=my-branch\npsql \"host=HOST port=PORT dbname=DB options='-c branch=my-branch'\"\nSET branch = 'my-branch';   SHOW branch;")} />
        </section>

        <section className="grid gap-3 md:grid-cols-2">
          {GUIDES.map((g) => (
            <div key={g.tool} className="rounded-xl border border-line bg-panel p-4 text-sm">
              <h3 className="font-medium">{g.tool}</h3>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-soft">{g.steps.map((s, i) => <li key={i}>{fill(s)}</li>)}</ol>
            </div>
          ))}
        </section>

        <section className="grid gap-4 lg:grid-cols-[22rem_1fr]">
          <div className="rounded-xl border border-line bg-panel p-3 text-xs">
            <div className="mb-2 flex items-center justify-between"><span className="font-semibold">Tables ({info?.tables.length ?? "…"})</span></div>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className={`${inputClass} mb-2 w-full py-1 text-xs`} />
            <div className="max-h-[420px] space-y-0.5 overflow-y-auto">
              {tables.map((t) => (
                <button key={`${t.schema}.${t.table}`} type="button" onClick={() => setSql(`SELECT * FROM ${quote(t.schema)}.${quote(t.table)} LIMIT 100`)} className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-panel-2" title={t.path ?? `ontology.${t.table}`}>
                  <Icon name={t.kind === "dataset" ? "database" : "cube"} className="h-3 w-3 shrink-0 text-muted" />
                  <span className="truncate"><span className="text-muted">{t.schema}.</span>{t.table}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-muted">Datasets are &quot;Project&quot;.&quot;folder/name&quot; (or one quoted path like &quot;/Project/folder/name&quot;); object types are ontology.&quot;ApiName&quot; with a __primary_key column.</p>
          </div>
          <div className="min-w-0 space-y-2 rounded-xl border border-line bg-panel p-3">
            <div className="flex items-center justify-between text-xs"><span className="font-semibold">Try a query</span><span className="text-muted">DuckDB SQL (close to PostgreSQL), read-only</span></div>
            <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Branch (empty: master; datasets without it fall back to master)" className={`${inputClass} w-full text-xs`} />
            <textarea rows={5} value={sql} onChange={(e) => setSql(e.target.value)} className={`${inputClass} w-full font-mono text-xs`} spellCheck={false} />
            <button
              type="button"
              disabled={busy || !sql.trim()}
              className={buttonClass.primary}
              onClick={async () => {
                const queryId = `web-${crypto.randomUUID().slice(0, 12)}`;
                setBusy(true);
                setRunning(queryId);
                setQerr(null);
                try {
                  setResult(await api<QueryResult>("/query", { sql, limit: 500, query_id: queryId, timeout_seconds: 600, ...(branch.trim() ? { branch: branch.trim() } : {}) }));
                } catch (e) {
                  setQerr((e as Error).message);
                  setResult(null);
                } finally {
                  setBusy(false);
                  setRunning(null);
                }
              }}
            >
              <Icon name="play" className="h-3.5 w-3.5" /> {busy ? "Running…" : "Run"}
            </button>
            {running && (
              <button type="button" onClick={() => void api(`/queries/${running}`, undefined, "DELETE").catch(() => undefined)} className={`${buttonClass.ghost} ml-2`}>
                <Icon name="x" className="h-3.5 w-3.5" /> Cancel
              </button>
            )}
            {qerr && <p className="rounded bg-bad/10 p-2 text-xs text-bad">{qerr}</p>}
            {result && (
              <div className="max-h-[360px] overflow-auto">
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead className="sticky top-0 bg-panel-2 text-muted"><tr>{result.columns.map((c) => <th key={c.name} className="border-b border-line px-2 py-1" title={c.type}>{c.name}</th>)}</tr></thead>
                  <tbody>{result.rows.map((r, i) => <tr key={i}>{result.columns.map((c) => <td key={c.name} className="max-w-56 truncate border-b border-line px-2 py-1">{r[c.name] === null ? <span className="text-muted">null</span> : String(r[c.name])}</td>)}</tr>)}</tbody>
                </table>
                <p className="py-1 text-[10px] text-muted">{result.tag} · showing up to 500 rows</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
