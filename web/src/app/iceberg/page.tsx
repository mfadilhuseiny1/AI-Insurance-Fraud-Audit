"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { NewTableDialog } from "@/components/dataset/iceberg/IcebergDataset";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon, type IconName } from "@/components/Icon";
import { LocationField, missingText, type PickedLocation } from "@/components/LocationField";
import { buttonClass, fieldClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { api, type DbConnection, type SourceTable } from "@/lib/api";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { iceberg, icebergHref, iecBytes, type ConnectInfo, type IcebergListing, type IcebergSync, type OAuthClient } from "@/lib/iceberg";

type Tab = "tables" | "connect" | "applications" | "syncs";
const TABS: [Tab, string, IconName][] = [
  ["tables", "Tables", "layers"],
  ["connect", "Connect clients", "plug"],
  ["applications", "OAuth2 applications", "eye"],
  ["syncs", "Data Connection syncs", "database"],
];

/** Iceberg tables: Foundry's Iceberg REST catalog — the tables in it, connecting external engines (PyIceberg, Spark,
 *  Snowflake), OAuth2 client credentials applications, and Data Connection syncs into Iceberg tables. */
export default function IcebergApp() {
  const [tab, setTab] = useState<Tab>(() => {
    const t = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab");
    return TABS.some(([k]) => k === t) ? (t as Tab) : "tables";
  });
  const pick = (t: Tab) => {
    setTab(t);
    window.history.replaceState(null, "", `/iceberg${t === "tables" ? "" : `?tab=${t}`}`);
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl p-8">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex-1">
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Icon name="layers" className="h-5 w-5 text-ocean" /> Iceberg tables
            </h1>
            <p className="mt-1 text-sm text-muted">
              Managed Apache Iceberg tables in Foundry&apos;s Iceberg REST catalog: row edits, changelogs, compaction, branch isolation, and any Iceberg engine can read and
              write them.
            </p>
          </div>
          <Link href="/control-panel?section=iceberg" className={buttonClass.secondary}>
            <Icon name="sliders" className="h-3.5 w-3.5" /> Iceberg table settings
          </Link>
        </div>
        <div className="mb-4 flex border-b border-line text-sm">
          {TABS.map(([k, l, icon]) => (
            <button key={k} type="button" onClick={() => pick(k)} className={`flex items-center gap-1.5 px-3 py-2 ${tab === k ? "border-b-2 border-ocean text-white" : "text-muted hover:text-white"}`}>
              <Icon name={icon} className="h-3.5 w-3.5" /> {l}
            </button>
          ))}
        </div>
        {tab === "tables" && <Tables />}
        {tab === "connect" && <Connect />}
        {tab === "applications" && <Applications />}
        {tab === "syncs" && <Syncs />}
      </div>
    </div>
  );
}

function Tables() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [list, setList] = useState<IcebergListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState<{ id: string | null; name: string } | null>(null);
  useEffect(() => {
    const h = setTimeout(() => iceberg.list(q).then(setList, (e: Error) => setError(e.message)), 200);
    return () => clearTimeout(h);
  }, [q]);
  if (error && !list) return <ApiError message={error} />;
  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-md border border-line-2 bg-ink px-2.5">
          <Icon name="search" className="h-4 w-4 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Iceberg tables" className="w-full bg-transparent py-2 text-sm outline-none" />
        </div>
        <button type="button" onClick={() => setPicking(true)} className={buttonClass.primary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New table
        </button>
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {list === null && <p className="p-6 text-center text-sm text-muted">Loading…</p>}
        {list && !list.length && (
          <p className="p-6 text-center text-sm text-muted">
            No Iceberg tables{q ? " match" : " yet"}. Create one here, write one from a Python transform (TableOutput), a Pipeline Builder output or a Data Connection sync, or
            from any Iceberg client.
          </p>
        )}
        {list?.map((t) => (
          <Link key={t.id} href={icebergHref(t.id)} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm last:border-0 hover:bg-panel-2">
            <Icon name="layers" className="h-4 w-4 shrink-0 text-ocean" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{t.name}</span>
              <span className="block truncate text-xs text-muted">
                {t.path.join(" / ")} · <span className="font-mono">{t.rid}</span>
              </span>
            </span>
            {t.protected && <Icon name="alert" className="h-3.5 w-3.5 text-warn" />}
            <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted">v{t.format_version ?? "?"}</span>
            <span className="w-24 text-right text-xs text-muted">{(t.records ?? 0).toLocaleString()} rows</span>
            <span className="w-20 text-right text-xs text-muted">{iecBytes(t.size)}</span>
            <span className="w-20 text-right text-xs text-muted">{t.snapshots ?? 0} snap.</span>
            <span className="w-28 text-right text-xs text-muted">{when(t.updated_at)}</span>
          </Link>
        ))}
      </div>
      {picking && (
        <DrivePicker
          title="New Iceberg table: pick its folder (namespace)"
          folder={{
            action: "Create table here",
            onPick: (f) => {
              setPicking(false);
              setCreating({ id: f.id, name: f.name });
            },
          }}
          onClose={() => setPicking(false)}
        />
      )}
      {creating && <NewTableDialog parentId={creating.id} parentName={creating.name} onClose={() => setCreating(null)} onCreated={(t) => router.push(icebergHref(t.id))} />}
    </>
  );
}

function Code({ title, code, note }: { title: string; code: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="rounded-xl border border-line bg-panel p-3">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium">
        {title}
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(code);
            setCopied(true);
          }}
          className="ml-auto text-xs text-muted hover:text-white"
        >
          <Icon name={copied ? "check" : "copy"} className="inline h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {note && <p className="mb-2 text-xs text-muted">{note}</p>}
      <pre className="overflow-x-auto rounded-md bg-ink p-2.5 font-mono text-[11px] leading-relaxed text-soft">{code}</pre>
    </section>
  );
}

function Connect() {
  const [c, setC] = useState<ConnectInfo | null>(null);
  useEffect(() => {
    iceberg.connect().then(setC, () => setC(null));
  }, []);
  if (!c) return <Loading />;
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-panel p-4 text-sm">
        <dl className="grid grid-cols-[11rem_1fr] gap-y-1.5 text-xs">
          <dt className="text-muted">REST catalog URI</dt>
          <dd className="font-mono">{c.uri}</dd>
          <dt className="text-muted">OAuth2 server URI</dt>
          <dd className="font-mono">{c.oauth2_server_uri}</dd>
          <dt className="text-muted">Namespaces</dt>
          <dd>
            Files paths: <span className="font-mono">Project.Folder</span> is /Project/Folder (levels separated by %1F in URLs). Tables can also be named by RID or, in Spark, by a
            back-ticked path.
          </dd>
          <dt className="text-muted">Authentication</dt>
          <dd>
            A personal API token (Account → API tokens) as <span className="font-mono">token</span>, or OAuth2 client credentials of an application (OAuth2 applications tab).
            {!c.auth_enabled && " Sign-in is off on this server: clients connect without credentials."}
          </dd>
          <dt className="text-muted">Storage access</dt>
          <dd>Credential vending (X-Iceberg-Access-Delegation: vended-credentials) for bring-your-own-bucket locations that allow it; never give clients bucket credentials.</dd>
        </dl>
      </div>
      <Code
        title="PyIceberg (~/.pyiceberg.yaml) — API token"
        code={`catalog:\n  foundry:\n    uri: ${c.uri}\n    token: <your API token>`}
        note="Tokens are long-lived and tied to your user: use OAuth2 for production."
      />
      <Code
        title="PyIceberg — OAuth2 client credentials"
        code={`catalog:\n  default:\n    uri: ${c.uri}\n    oauth2-server-uri: ${c.oauth2_server_uri}\n    credential: <client_id>:<client_secret>\n    scope: api:iceberg-read api:iceberg-write  # optional`}
      />
      <Code
        title="Local notebook (PyIceberg)"
        code={`from pyiceberg.catalog import load_rest\nfrom getpass import getpass\nimport pyarrow.parquet as pq\n\ncatalog = load_rest("foundry", {"uri": "${c.uri}", "token": getpass("Foundry token:")})\ndf = pq.read_table("example_data.parquet")\ntable = catalog.create_table("Project.Folder.example_data", schema=df.schema)\ntable.append(df)\ntable.scan().to_pandas()`}
      />
      <Code
        title="Spark"
        code={`spark = (\n    SparkSession.builder\n        .config("spark.jars.packages", "${c.spark_runtime}")\n        .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions")\n        .config("spark.sql.catalog.foundry", "org.apache.iceberg.spark.SparkCatalog")\n        .config("spark.sql.catalog.foundry.type", "rest")\n        .config("spark.sql.catalog.foundry.uri", "${c.uri}")\n        .config("spark.sql.catalog.foundry.default-namespace", "${c.default_namespace}")\n        .config("spark.sql.catalog.foundry.token", getpass("Foundry token:"))\n        .config("spark.sql.defaultCatalog", "foundry")\n        .getOrCreate()\n)\nspark.sql("SELECT * FROM \`/Project/Folder/taxis\`").show()`}
        note="Escape paths with spaces in back-ticks (Spark) or URL-encode them (PyIceberg)."
      />
      <Code
        title="Branches from external clients (X-PLTR-Branch)"
        code={`catalog = load_rest("foundry", {"uri": "${c.uri}", "token": "…", "header.X-PLTR-Branch": "my-branch"})\n# Spark: .config("spark.sql.catalog.foundry.header.X-PLTR-Branch", "my-branch")`}
        note="Reads and writes are scoped to the branch with Foundry's branch isolation: its schema changes leave main unchanged. dropNamespace, updateNamespace, dropTable, renameTable, commitTransaction and views cannot be called from a branch."
      />
      <Code
        title="Verify connectivity"
        code={`curl -sS "${c.uri}/v1/namespaces/<namespace>/tables/<table>" \\\n  -H "Authorization: Bearer <token>" \\\n  -H "X-Iceberg-Access-Delegation: vended-credentials" | jq '.metadata.location'`}
      />
      <Code
        title="Snowflake catalog integration"
        code={`CREATE CATALOG INTEGRATION foundry_iceberg\n  CATALOG_SOURCE = ICEBERG_REST\n  TABLE_FORMAT = ICEBERG\n  ENABLED = TRUE\n  CATALOG_NAMESPACE = 'Project.Folder'\n  REST_CONFIG = (\n    CATALOG_NAME = 'foundry'\n    CATALOG_URI = '${c.uri}'\n    CATALOG_API_TYPE = 'public'\n    ACCESS_DELEGATION_MODE = VENDED_CREDENTIALS\n  )\n  REST_AUTHENTICATION = (\n    TYPE = OAUTH\n    OAUTH_TOKEN_URI = '${c.oauth2_server_uri}'\n    OAUTH_CLIENT_ID = '<client_id>'\n    OAUTH_CLIENT_SECRET = '<client_secret>'\n    OAUTH_ALLOWED_SCOPES = ('api:iceberg-read', 'api:iceberg-write')\n  );\n\nSELECT SYSTEM$VERIFY_CATALOG_INTEGRATION('foundry_iceberg');\nCREATE OR REPLACE ICEBERG TABLE db.schema.orders\n  CATALOG = 'foundry_iceberg' CATALOG_TABLE_NAME = 'orders' CATALOG_NAMESPACE = 'Project.Folder' AUTO_REFRESH = TRUE;`}
        note="Snowflake reads Foundry-managed tables on bring-your-own-bucket storage, without client-side encryption."
      />
    </div>
  );
}

function Applications() {
  const [list, setList] = useState<OAuthClient[] | null>(null);
  const [name, setName] = useState("");
  const [write, setWrite] = useState(true);
  const [created, setCreated] = useState<OAuthClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    iceberg.clients().then(setList, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  const create = async () => {
    try {
      setCreated(await iceberg.createClient(name.trim(), write ? ["api:iceberg-read", "api:iceberg-write"] : ["api:iceberg-read"]));
      setName("");
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (c: OAuthClient) => {
    if (!(await confirmDialog({ title: "Delete application", message: `Delete ${c.name}? Clients using its credentials lose access.`, confirmLabel: "Delete", danger: true }))) return;
    await iceberg.deleteClient(c.client_id);
    load();
  };
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted">
        Third-party applications for the OAuth2 client credentials grant. An Iceberg client exchanges the client id and secret at the OAuth2 server URI for a short-lived token
        and refreshes it itself. The application acts with the permissions of the user who registered it, limited to its scopes (api:iceberg-read, api:iceberg-write).
      </p>
      <div className="flex items-end gap-2 rounded-xl border border-line bg-panel p-3">
        <label className="flex-1">
          <span className="text-xs text-muted">Application name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Snowflake integration" className={inputClass} />
        </label>
        <label className="flex items-center gap-1.5 pb-2 text-xs">
          <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} /> api:iceberg-write
        </label>
        <button type="button" disabled={!name.trim()} onClick={create} className={buttonClass.primary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> Register
        </button>
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {list?.map((c) => (
          <div key={c.client_id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-xs last:border-0">
            <Icon name="eye" className="h-4 w-4 text-ocean" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-soft">{c.name}</span>
              <span className="block font-mono text-muted">{c.client_id}</span>
            </span>
            <span className="text-muted">{c.scopes.join(" ")}</span>
            <span className="text-muted">by {c.owner}</span>
            <span className="w-32 text-right text-muted">{c.last_used_at ? `used ${when(c.last_used_at)}` : "never used"}</span>
            <button type="button" onClick={() => remove(c)} className="text-muted hover:text-bad">
              <Icon name="trash" className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {list && !list.length && <p className="p-5 text-center text-xs text-muted">No applications yet.</p>}
      </div>
      {created && (
        <Modal title="Application registered" icon="eye" onClose={() => setCreated(null)}>
          <div className="space-y-2 p-4 text-sm">
            <p className="text-xs text-warn">Copy the secret now: it is not shown again.</p>
            <dl className="grid grid-cols-[6rem_1fr] gap-y-1 text-xs">
              <dt className="text-muted">Client id</dt>
              <dd className="break-all font-mono">{created.client_id}</dd>
              <dt className="text-muted">Secret</dt>
              <dd className="break-all font-mono">{created.client_secret}</dd>
              <dt className="text-muted">credential</dt>
              <dd className="break-all font-mono">
                {created.client_id}:{created.client_secret}
              </dd>
            </dl>
            <div className="flex justify-end">
              <button type="button" onClick={() => setCreated(null)} className={buttonClass.primary}>
                Done
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

const SYNC_KINDS = ["postgresql", "sqlserver", "oracle", "snowflake", "jdbc", "custom_jdbc", "custom-jdbc"];

function Syncs() {
  const [list, setList] = useState<IcebergSync[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    iceberg.syncs().then(setList, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  const running = list?.some((s) => s.runs[0]?.status === "running");
  useEffect(() => {
    if (!running) return;
    const h = setInterval(load, 1500);
    return () => clearInterval(h);
  }, [running, load]);
  const run = async (s: IcebergSync) => {
    try {
      await iceberg.runSync(s.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (s: IcebergSync) => {
    if (!(await confirmDialog({ title: "Delete sync", message: `Delete the sync ${s.name}? The Iceberg table stays.`, confirmLabel: "Delete", danger: true }))) return;
    await iceberg.deleteSync(s.id);
    load();
  };
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-xs text-muted">
          Batch syncs from Custom JDBC, SQL Server, Oracle, PostgreSQL and Snowflake sources into Iceberg tables. Overwrite replaces every row (an overwrite snapshot), Append
          adds rows (an append snapshot), Update upserts by the primary key (an overwrite snapshot of the affected files). With a cursor column a sync only reads rows past
          the last value it synced. Changing the source table&apos;s schema fails the sync: create a new one.
        </p>
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New Iceberg sync
        </button>
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {list?.map((s) => {
          const last = s.runs[0];
          return (
            <div key={s.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-xs last:border-0">
              <Icon name="database" className="h-4 w-4 text-ocean" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-soft">{s.name}</span>
                <span className="block text-muted">
                  {s.connection} · {[s.database, s.schema, s.table].filter(Boolean).join(".")} →{" "}
                  <Link href={icebergHref(s.table_id)} className="text-ocean hover:underline">
                    {[...s.table_path, s.table_name].join(" / ")}
                  </Link>{" "}
                  · {s.write_mode}
                  {s.primary_key.length ? ` by ${s.primary_key.join(", ")}` : ""}
                  {s.cursor_column ? ` · incremental on ${s.cursor_column}` : ""}
                </span>
                {last?.error && <span className="block text-bad">{last.error}</span>}
              </span>
              <span className={last?.status === "failed" ? "text-bad" : last?.status === "running" ? "text-ocean" : "text-ok"}>{last ? `${last.status}${last.rows !== null ? ` · ${last.rows} rows` : ""}` : "never run"}</span>
              <span className="w-28 text-right text-muted">{last ? when(last.started_at) : ""}</span>
              <button type="button" onClick={() => run(s)} className={`${buttonClass.secondary} py-1 text-xs`}>
                <Icon name="play" className="h-3 w-3" /> Run
              </button>
              <button type="button" onClick={() => remove(s)} className="text-muted hover:text-bad">
                <Icon name="trash" className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
        {list && !list.length && <p className="p-5 text-center text-xs text-muted">No Iceberg syncs yet.</p>}
      </div>
      {creating && (
        <NewSync
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function NewSync({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [conns, setConns] = useState<DbConnection[] | null>(null);
  const [conn, setConn] = useState("");
  const [dbs, setDbs] = useState<string[]>([]);
  const [database, setDatabase] = useState("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState("");
  const [tables, setTables] = useState<SourceTable[]>([]);
  const [table, setTable] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<IcebergSync["write_mode"]>("overwrite");
  const [pk, setPk] = useState("");
  const [cursor, setCursor] = useState("");
  const [initial, setInitial] = useState("");
  const [folder, setFolder] = useState<PickedLocation | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.dataSources.connections().then((c) => setConns(c.filter((x) => SYNC_KINDS.includes(x.kind))), (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!conn) return;
    api.dataSources.databases(conn).then(setDbs, (e: Error) => setError(e.message));
  }, [conn]);
  useEffect(() => {
    if (!conn || !database) return;
    api.dataSources.schemas(conn, database).then(setSchemas, () => setSchemas([]));
  }, [conn, database]);
  useEffect(() => {
    if (!conn || !database) return;
    api.dataSources.tables(conn, database, schema).then(setTables, () => setTables([]));
  }, [conn, database, schema]);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [
    ...(conn ? [] : ["choose a source"]),
    ...(table ? [] : ["choose a table"]),
    ...(mode === "update" && !pk.trim() ? ["enter the primary key"] : []),
    ...(folder ? [] : ["choose a location"]),
  ];
  const bad = (on: boolean) => (tried && on ? "border-bad ring-1 ring-bad/40" : "");
  const create = async () => {
    setTried(true);
    if (missing.length || !folder) return;
    setBusy(true);
    setError(null);
    try {
      await iceberg.createSync({
        name: name.trim() || table,
        connection_id: conn,
        database,
        schema,
        table,
        write_mode: mode,
        primary_key: pk.split(",").map((x) => x.trim()).filter(Boolean),
        cursor_column: cursor.trim() || null,
        initial_value: initial.trim() || null,
        parent_id: folder.id,
      });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sel = `${fieldClass} w-full py-1 text-xs`;
  return (
    <Modal title="New Iceberg sync" icon="database" onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-3 p-4 text-sm">
        {conns && !conns.length && (
          <p className="col-span-2 text-xs text-warn">
            No PostgreSQL, SQL Server, Oracle, Snowflake or JDBC connection yet: add one in{" "}
            <Link href="/sources" className="underline">
              Data Connection
            </Link>
            .
          </p>
        )}
        <label>
          <span className="text-xs text-muted">Source <span className="text-bad" aria-hidden>*</span></span>
          <select value={conn} onChange={(e) => setConn(e.target.value)} aria-invalid={tried && !conn} className={`${sel} ${bad(!conn)}`}>
            <option value="">Choose…</option>
            {conns?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.kind_name})
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-xs text-muted">Database</span>
          <select value={database} onChange={(e) => setDatabase(e.target.value)} className={sel}>
            <option value="">Choose…</option>
            {dbs.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-xs text-muted">Schema</span>
          <select value={schema} onChange={(e) => setSchema(e.target.value)} className={sel}>
            <option value="">—</option>
            {schemas.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-xs text-muted">Table <span className="text-bad" aria-hidden>*</span></span>
          <select value={table} onChange={(e) => setTable(e.target.value)} aria-invalid={tried && !table} className={`${sel} ${bad(!table)}`}>
            <option value="">Choose…</option>
            {tables.map((t) => (
              <option key={t.name}>{t.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-xs text-muted">Write mode</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as IcebergSync["write_mode"])} className={sel}>
            <option value="overwrite">Overwrite</option>
            <option value="append">Append</option>
            <option value="update">Update (by primary key)</option>
          </select>
        </label>
        <label>
          <span className="text-xs text-muted">Primary key (update){mode === "update" && <span className="text-bad" aria-hidden> *</span>}</span>
          <input value={pk} onChange={(e) => setPk(e.target.value)} placeholder="id" disabled={mode !== "update"} aria-invalid={tried && mode === "update" && !pk.trim()} className={`${inputClass} py-1 text-xs ${bad(mode === "update" && !pk.trim())}`} />
        </label>
        <label>
          <span className="text-xs text-muted">Incremental cursor column (optional)</span>
          <input value={cursor} onChange={(e) => setCursor(e.target.value)} placeholder="updated_at" className={`${inputClass} py-1 text-xs`} />
        </label>
        <label>
          <span className="text-xs text-muted">Start after value (optional)</span>
          <input value={initial} onChange={(e) => setInitial(e.target.value)} disabled={!cursor.trim()} className={`${inputClass} py-1 text-xs`} />
        </label>
        <label>
          <span className="text-xs text-muted">Iceberg table name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={table || "table"} className={`${inputClass} py-1 text-xs`} />
        </label>
        <LocationField value={folder} onChange={setFolder} invalid={tried} label="Folder" hint="The folder (namespace) of the sync's Iceberg table." />
        {error && <p className="col-span-2 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>}
        <div className="col-span-2 flex items-center justify-end gap-2">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To create: {missingText(missing)}</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={create} className={buttonClass.primary}>
            {busy ? "Creating…" : "Create sync"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
