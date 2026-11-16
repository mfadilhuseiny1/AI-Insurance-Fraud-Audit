"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL } from "@/lib/api";
import { when } from "@/lib/format";
import { Icon } from "../Icon";
import { buttonClass, inputClass } from "../pipeline/Modal";
import { Field } from "../pipeline/ui";

type Settings = { enabled: boolean; interval_hours: number; keep: number; folder: string; exclude: string[]; include_database: boolean };
type Run = { at: string; trigger?: string; ok: boolean; file?: string; size?: number; files?: number; database?: boolean; note?: string; error?: string; seconds?: number };
type Overview = {
  settings: Settings;
  backups: { name: string; size: number; at: string }[];
  runs: Run[];
  verifications: (Run & { users?: number; database_objects?: number })[];
  running: boolean;
  pg_dump: string | null;
  database: boolean;
};

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`${API_URL}/api/backups${path}`, {
    credentials: "include",
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : res.statusText);
  return body as T;
}

const mb = (n?: number) => (n === undefined ? "" : `${(n / 1e6).toFixed(1)} MB`);

/** Control Panel → Backups: encrypted, scheduled backups of the platform (api/backups.py), restore tests. */
export function BackupsAdmin() {
  const [o, setO] = useState<Overview | null>(null);
  const [f, setF] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      call<Overview>("").then(
        (r) => (setO(r), setF((cur) => cur ?? r.settings)),
        (e: Error) => setMsg({ ok: false, text: e.message }),
      ),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  if (!o || !f) return msg ? <p className="text-sm text-bad">{msg.text}</p> : <p className="text-sm text-muted">Loading…</p>;
  const act = (p: Promise<Run>, label: string) => {
    setBusy(true);
    p.then(
      (r) => setMsg(r.ok ? { ok: true, text: `${label}: done${r.seconds ? ` in ${r.seconds} s` : ""}${r.note ? ` (${r.note})` : ""}` } : { ok: false, text: r.error ?? "failed" }),
      (e: Error) => setMsg({ ok: false, text: e.message }),
    ).finally(() => (setBusy(false), load()));
  };
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Backups</h1>
        <p className="mt-1 text-sm text-muted">
          Encrypted backups of the platform&apos;s metadata (the data folder less uploads and caches), the sign-in store and the PostgreSQL database. They are encrypted with a key derived from
          the platform&apos;s secret key (BLUESANDAI_SECRET_KEY or secrets/connections.key): keep that key somewhere else, or the backups cannot be read. Restore with the API stopped:
          <code className="mx-1 text-soft">python api/backups.py restore &lt;file&gt; &lt;empty folder&gt;</code>.
        </p>
      </div>
      <section className="grid gap-3 rounded-xl border border-line bg-panel p-4 md:grid-cols-2">
        <label className="flex items-center gap-2 text-sm md:col-span-2">
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
          Take backups on a schedule
        </label>
        <Field label="Every (hours)">
          <input type="number" min={1} value={f.interval_hours} onChange={(e) => setF({ ...f, interval_hours: Number(e.target.value) })} className={inputClass} />
        </Field>
        <Field label="Keep the newest">
          <input type="number" min={1} value={f.keep} onChange={(e) => setF({ ...f, keep: Number(e.target.value) })} className={inputClass} />
        </Field>
        <Field label="Folder (outside the data folder; ideally another disk)">
          <input value={f.folder} onChange={(e) => setF({ ...f, folder: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Data folders left out (comma separated)">
          <input value={f.exclude.join(", ")} onChange={(e) => setF({ ...f, exclude: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} className={inputClass} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.include_database} onChange={(e) => setF({ ...f, include_database: e.target.checked })} />
          Include the PostgreSQL database {o.database ? (o.pg_dump ? "(pg_dump found)" : "(pg_dump not found: set PG_DUMP)") : "(none configured)"}
        </label>
        <div className="flex gap-2 md:col-span-2">
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => call<Overview>("/settings", { method: "PUT", json: f }).then((r) => (setO(r), setMsg({ ok: true, text: "Saved" })), (e: Error) => setMsg({ ok: false, text: e.message }))}
          >
            Save settings
          </button>
          <button type="button" disabled={busy || o.running} className={buttonClass.primary} onClick={() => act(call<Run>("/run", { method: "POST" }), "Backup")}>
            <Icon name="download" className="h-4 w-4" />
            {busy || o.running ? "Working…" : "Back up now"}
          </button>
        </div>
        {msg && <p className={`text-xs md:col-span-2 ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
      </section>
      <section className="rounded-xl border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-2 text-sm font-medium">Backups in {o.settings.folder}</h2>
        <ul className="divide-y divide-line text-sm">
          {o.backups.map((b) => {
            const v = o.verifications.find((x) => x.file?.endsWith(b.name));
            return (
              <li key={b.name} className="flex flex-wrap items-center gap-3 px-4 py-2">
                <span className="font-mono text-xs">{b.name}</span>
                <span className="text-xs text-muted">{mb(b.size)} · {when(b.at)}</span>
                {v && <span className={`text-xs ${v.ok ? "text-ok" : "text-bad"}`}>{v.ok ? `restore test passed ${when(v.at)}` : `restore test failed: ${v.error}`}</span>}
                <button type="button" disabled={busy} className={`${buttonClass.ghost} ml-auto`} onClick={() => act(call<Run>("/verify", { method: "POST", json: { name: b.name } }), "Restore test")}>
                  Test restore
                </button>
              </li>
            );
          })}
          {o.backups.length === 0 && <li className="px-4 py-3 text-xs text-muted">No backups yet.</li>}
        </ul>
      </section>
      {o.runs.some((r) => !r.ok) && (
        <section className="rounded-xl border border-bad/40 bg-bad/10 p-3 text-xs">
          {o.runs
            .filter((r) => !r.ok)
            .slice(0, 3)
            .map((r) => (
              <p key={r.at}>
                {when(r.at)}: {r.error}
              </p>
            ))}
        </section>
      )}
    </div>
  );
}
