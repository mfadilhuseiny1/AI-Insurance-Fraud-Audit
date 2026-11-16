"use client";

import { useEffect, useState } from "react";
import { api, API_URL, type DbConnection } from "@/lib/api";
import { Icon } from "../Icon";
import { LocationField, missingText, type PickedLocation } from "../LocationField";
import { buttonClass, inputClass, Modal } from "../pipeline/Modal";
import { useLoad } from "./DataSourceWizard";
import { EmptyState, ErrorLine, TabPage } from "./dcui";

type VirtualTable = {
  id: string;
  name: string;
  rid: string;
  path: { id: string; name: string }[];
  virtual_table: { locator: Record<string, string>; database: string; schema: string; table: string };
  connection: { id: string; name: string; kind: string | null };
};
const KINDS = ["snowflake", "bigquery", "databricks", "iceberg-rest", "s3", "filesystem"];

async function call<T>(path: string, method = "GET", json?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/virtual-tables${path}`, {
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

/** Virtual tables (api/virtual_tables.py): tables of a source registered in Files without copying them, for Python transforms. */
export function VirtualTablesTab() {
  const list = useLoad("virtual-tables", () => call<VirtualTable[]>(""));
  const [adding, setAdding] = useState(false);
  const rows = list.data ?? list.last;
  return (
    <TabPage
      title="Virtual tables"
      description="A virtual table names a table in Snowflake, BigQuery, Databricks, an Iceberg catalog or a folder of files in S3 / a filesystem source, without copying it. Python transforms read it with TableInput and write one with TableOutput(path, source, locator) on Foundry-native compute."
      actions={
        <button type="button" onClick={() => setAdding(true)} className={buttonClass.primary}>
          <Icon name="plus" /> Register virtual table
        </button>
      }
    >
      {list.error && <ErrorLine text={list.error} onRetry={list.retry} />}
      {!rows ? (
        !list.error && <p className="text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState icon="table" title="No virtual tables yet" text="Register a source's table, or let a transform's TableOutput create one on its first build." />
      ) : (
        <ul className="space-y-2">
          {rows.map((v) => (
            <li key={v.id} className="rounded-xl border border-line bg-panel px-4 py-3 text-sm">
              <div className="flex items-center gap-2">
                <Icon name="table" className="h-4 w-4 text-ocean" />
                <span className="font-medium text-soft">{v.name}</span>
                <span className="text-xs text-muted">{v.path.map((p) => p.name).join(" / ")}</span>
                <span className="ml-auto font-mono text-xs text-muted">{v.rid}</span>
              </div>
              <div className="mt-1 text-xs text-muted">
                {v.connection.name} ({v.connection.kind}) · <span className="font-mono">{v.virtual_table.locator.type}</span> {v.virtual_table.database} /{" "}
                {v.virtual_table.schema} / {v.virtual_table.table} ·{" "}
                <span className="font-mono">TableInput(&quot;{["", ...v.path.map((p) => p.name), v.name].join("/")}&quot;)</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding && <RegisterDialog onClose={() => setAdding(false)} onDone={() => (setAdding(false), list.retry())} />}
    </TabPage>
  );
}

function RegisterDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [conns, setConns] = useState<DbConnection[]>([]);
  const [conn, setConn] = useState("");
  const [dbs, setDbs] = useState<string[]>([]);
  const [db, setDb] = useState("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState("");
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState("");
  const [folder, setFolder] = useState<PickedLocation | null>(null);
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.dataSources.connections().then((cs) => setConns(cs.filter((c) => KINDS.includes(c.kind))), (e: Error) => setErr(e.message));
  }, []);
  const pickConn = (id: string) => {
    setConn(id);
    setDb("");
    setSchema("");
    setTable("");
    setSchemas([]);
    setTables([]);
    if (id) api.dataSources.databases(id).then(setDbs, (e: Error) => setErr(e.message));
  };
  const pickDb = (d: string) => {
    setDb(d);
    setSchema("");
    setTable("");
    setTables([]);
    if (d) api.dataSources.schemas(conn, d).then(setSchemas, (e: Error) => setErr(e.message));
  };
  const pickSchema = (s: string) => {
    setSchema(s);
    setTable("");
    if (s) api.dataSources.tables(conn, db, s).then((ts) => setTables(ts.map((t) => t.name)), (e: Error) => setErr(e.message));
  };
  // Register stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [
    ...(conn ? [] : ["choose a source"]),
    ...(db ? [] : ["choose a database"]),
    ...(schema ? [] : ["choose a schema"]),
    ...(table ? [] : ["choose a table"]),
    ...(folder ? [] : ["choose a location"]),
  ];
  const bad = (on: boolean) => (tried && on ? "border-bad ring-1 ring-bad/40" : "");
  const submit = () => {
    setTried(true);
    if (missing.length || !folder) return;
    setBusy(true);
    setErr(null);
    call("/from-source", "POST", { folder_id: folder.id, name: name || table.replace(/\/$/, ""), connection_id: conn, database: db, schema, table })
      .then(onDone, (e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  const select = (label: string, value: string, options: string[], onChange: (v: string) => void) => (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label} <span className="text-bad" aria-hidden>*</span></span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={tried && !value} className={`${inputClass} ${bad(!value)}`}>
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Modal title="Register virtual table" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Source <span className="text-bad" aria-hidden>*</span></span>
          <select value={conn} onChange={(e) => pickConn(e.target.value)} aria-invalid={tried && !conn} className={`${inputClass} ${bad(!conn)}`}>
            <option value="">Choose…</option>
            {conns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.kind_name})
              </option>
            ))}
          </select>
        </label>
        {conn && select("Database / catalog", db, dbs, pickDb)}
        {db && select("Schema / namespace / folder", schema, schemas, pickSchema)}
        {schema && select("Table", table, tables, setTable)}
        <LocationField value={folder} onChange={setFolder} invalid={tried} label="Location in Files" hint="Where to register the virtual table." />
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={table.replace(/\/$/, "") || "virtual table"} className={inputClass} />
        </label>
        {err && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</p>}
        <div className="flex items-center justify-end gap-2">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To register: {missingText(missing)}</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={submit} className={buttonClass.primary}>
            {busy ? "Registering…" : "Register"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
