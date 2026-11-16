"use client";

/**
 * Dataset maintenance for a Parquet dataset in the Files details panel, like Foundry's "maintaining high
 * performance": a retention policy (which transaction copies are kept, abort empty writes) and projections
 * (optimized copies for fast filters and key lookups). Backend: api/dataset_retention.py and
 * api/dataset_projections.py, under /api/pipeline.
 */

import { useCallback, useEffect, useState } from "react";
import { API_URL, api } from "@/lib/api";
import { bytes, when } from "@/lib/format";
import { confirmDialog } from "@/lib/dialogs";
import { Icon } from "../Icon";
import { buttonClass } from "./ui";

export type RetentionPolicy = {
  keep_last: number | null;
  max_age_days: number | null;
  purge_history: boolean;
  abort_empty: boolean;
};
type TxSummary = {
  id: string;
  at: string;
  kind: string;
  rows: number | null;
  size: number | null;
  kept: boolean;
  rolled_back?: boolean;
};
export type RetentionView = {
  item_id: string;
  inherit: boolean;
  policy: RetentionPolicy;
  default: RetentionPolicy;
  stats: {
    deleted?: number;
    freed_bytes?: number;
    last_run?: string;
    aborted?: number;
    last_aborted?: { at: string };
  };
  transactions: {
    total: number;
    kept: number;
    kept_bytes: number;
    current: TxSummary | null;
  };
};
export type RetentionRun = {
  dry_run: boolean;
  deleted: TxSummary[];
  purged: TxSummary[];
  freed_bytes: number;
  transactions: number;
  kept_after: number;
};
export type Projection = {
  id: string;
  name: string;
  kind: "filter" | "join";
  columns: string[];
  status: "up_to_date" | "stale" | "building" | "failed";
  size: number;
  rows: number | null;
  row_groups?: number;
  built_at?: string;
  build_ms?: number;
  error?: string | null;
};
export type ProjectionQuery = {
  source: "projection" | "dataset";
  method: string;
  matched: number;
  rows: Record<string, unknown>[];
  ms: number;
  row_groups_read?: number;
  row_groups?: number;
  fallback_reason?: string | null;
};

async function call<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}/api/pipeline${path}`, {
    method,
    cache: "no-store",
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const b = await res.json();
      message =
        typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

const enc = encodeURIComponent;
export const maintenanceApi = {
  retention: (id: string) =>
    call<RetentionView>(`/datasets/${enc(id)}/retention`),
  saveRetention: (id: string, body: RetentionPolicy | { inherit: true }) =>
    call<RetentionView>(`/datasets/${enc(id)}/retention`, "PUT", body),
  applyRetention: (id: string, dryRun: boolean, policy?: RetentionPolicy) =>
    call<RetentionRun>(`/datasets/${enc(id)}/retention/apply`, "POST", {
      dry_run: dryRun,
      policy,
    }),
  projections: (id: string) =>
    call<Projection[]>(`/datasets/${enc(id)}/projections`),
  createProjection: (id: string, kind: Projection["kind"], columns: string[]) =>
    call<Projection>(`/datasets/${enc(id)}/projections`, "POST", {
      kind,
      columns,
    }),
  deleteProjection: (id: string, pid: string) =>
    call<{ ok: boolean }>(
      `/datasets/${enc(id)}/projections/${enc(pid)}`,
      "DELETE",
    ),
  rebuildProjection: (id: string, pid: string) =>
    call<Projection>(
      `/datasets/${enc(id)}/projections/${enc(pid)}/build`,
      "POST",
    ),
  queryProjection: (id: string, pid: string, eq: Record<string, unknown>) =>
    call<ProjectionQuery>(
      `/datasets/${enc(id)}/projections/${enc(pid)}/query`,
      "POST",
      { eq, limit: 5 },
    ),
};

export function DatasetMaintenance({ itemId }: { itemId: string }) {
  const [columns, setColumns] = useState<string[]>([]);
  useEffect(() => {
    api.pipelineData
      .table(itemId, 1)
      .then((t) => setColumns(t.columns.map((c) => c.name)))
      .catch(() => {});
  }, [itemId]);
  return (
    <div className="border-t border-line">
      <Section title="Retention" icon="clock">
        <RetentionPanel itemId={itemId} />
      </Section>
      <Section title="Projections" icon="layers">
        <ProjectionsPanel itemId={itemId} columns={columns} />
      </Section>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: "clock" | "layers";
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-line">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted hover:text-white"
      >
        <Icon name={icon} className="h-3.5 w-3.5" />
        <span className="flex-1 text-left">{title}</span>
        <Icon name={open ? "down" : "right"} className="h-3.5 w-3.5" />
      </button>
      {open && <div className="px-4 pb-4 text-xs">{children}</div>}
    </div>
  );
}

const inputClass =
  "w-full rounded border border-line-2 bg-ink px-2 py-1 text-xs outline-none focus:border-ocean";

function numberOrNull(v: string): number | null {
  const n = Number(v);
  return v.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n;
}

function RetentionPanel({ itemId }: { itemId: string }) {
  const [view, setView] = useState<RetentionView | null>(null);
  const [draft, setDraft] = useState<RetentionPolicy | null>(null);
  const [inherit, setInherit] = useState(true);
  const [run, setRun] = useState<RetentionRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = useCallback((v: RetentionView) => {
    setView(v);
    setDraft(v.policy);
    setInherit(v.inherit);
  }, []);

  useEffect(() => {
    maintenanceApi
      .retention(itemId)
      .then(show)
      .catch((e: Error) => setError(e.message));
  }, [itemId, show]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !view) return <p className="text-bad">{error}</p>;
  if (!view || !draft) return <p className="text-muted">Loading…</p>;
  const policy = inherit ? view.default : draft;
  const dirty =
    inherit !== view.inherit ||
    (!inherit && JSON.stringify(draft) !== JSON.stringify(view.policy));
  const t = view.transactions;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted">
        {t.total} transaction{t.total === 1 ? "" : "s"}, {t.kept} with data kept
        ({bytes(t.kept_bytes)}). The current transaction is never deleted.
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={inherit}
          onChange={(e) => setInherit(e.target.checked)}
        />
        Use the default policy
      </label>
      <div className="grid grid-cols-[1fr_5rem] items-center gap-x-2 gap-y-2">
        <span className={inherit ? "text-muted" : ""}>
          Keep last N transactions
        </span>
        <input
          className={inputClass}
          type="number"
          min={1}
          disabled={inherit}
          value={policy.keep_last ?? ""}
          placeholder="all"
          onChange={(e) =>
            setDraft({ ...draft, keep_last: numberOrNull(e.target.value) })
          }
        />
        <span className={inherit ? "text-muted" : ""}>
          Delete older than (days)
        </span>
        <input
          className={inputClass}
          type="number"
          min={1}
          disabled={inherit}
          value={policy.max_age_days ?? ""}
          placeholder="never"
          onChange={(e) =>
            setDraft({ ...draft, max_age_days: numberOrNull(e.target.value) })
          }
        />
      </div>
      <label
        className={`flex items-start gap-2 ${inherit ? "text-muted" : ""}`}
      >
        <input
          type="checkbox"
          disabled={inherit}
          checked={policy.purge_history}
          onChange={(e) =>
            setDraft({ ...draft, purge_history: e.target.checked })
          }
        />
        Also remove deleted transactions from the history
      </label>
      <label
        className={`flex items-start gap-2 ${inherit ? "text-muted" : ""}`}
      >
        <input
          type="checkbox"
          disabled={inherit}
          checked={policy.abort_empty}
          onChange={(e) =>
            setDraft({ ...draft, abort_empty: e.target.checked })
          }
        />
        Abort empty transactions (writes with 0 rows are skipped and trigger
        nothing downstream)
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !dirty}
          className={buttonClass.outline}
          onClick={() =>
            act(async () => {
              show(
                await maintenanceApi.saveRetention(
                  itemId,
                  inherit ? { inherit: true } : draft,
                ),
              );
              setRun(null);
            })
          }
        >
          <Icon name="save" className="h-3.5 w-3.5" /> Save
        </button>
        <button
          type="button"
          disabled={busy}
          className={buttonClass.outline}
          onClick={() =>
            act(async () =>
              setRun(
                await maintenanceApi.applyRetention(
                  itemId,
                  true,
                  dirty ? policy : undefined,
                ),
              ),
            )
          }
        >
          <Icon name="eye" className="h-3.5 w-3.5" /> Dry run
        </button>
        <button
          type="button"
          disabled={busy || dirty}
          title={
            dirty
              ? "Save the policy first"
              : "Delete the transactions the policy no longer keeps"
          }
          className={buttonClass.outline}
          onClick={() =>
            act(async () => {
              const preview = await maintenanceApi.applyRetention(itemId, true);
              if (preview.deleted.length === 0 && preview.purged.length === 0) {
                setRun(preview);
                return;
              }
              const ok = await confirmDialog({
                title: "Apply retention policy?",
                message: `${preview.deleted.length} transaction copies (${bytes(preview.freed_bytes)}) will be deleted. They can no longer be rolled back to.`,
                confirmLabel: "Delete",
                danger: true,
              });
              if (!ok) return;
              setRun(await maintenanceApi.applyRetention(itemId, false));
              show(await maintenanceApi.retention(itemId));
            })
          }
        >
          <Icon name="trash" className="h-3.5 w-3.5" /> Apply now
        </button>
      </div>
      {error && <p className="text-bad">{error}</p>}
      {run && (
        <div className="rounded-md border border-line bg-ink p-2">
          <div className="mb-1 font-medium">
            {run.dry_run ? "Would delete" : "Deleted"} {run.deleted.length}{" "}
            transaction{run.deleted.length === 1 ? "" : "s"}
            {run.deleted.length > 0 && ` · ${bytes(run.freed_bytes)}`}
            {run.purged.length > 0 &&
              ` · ${run.purged.length} removed from history`}
          </div>
          {run.deleted.length === 0 ? (
            <p className="text-muted">
              Nothing to delete: every kept transaction is within the policy.
            </p>
          ) : (
            <ul className="max-h-40 overflow-y-auto">
              {run.deleted.map((tx) => (
                <li
                  key={tx.id}
                  className="flex justify-between gap-2 py-0.5 tabular-nums"
                >
                  <span className="truncate">
                    {when(tx.at)} · {tx.kind}
                  </span>
                  <span className="shrink-0 text-muted">
                    {tx.rows?.toLocaleString() ?? "?"} rows ·{" "}
                    {bytes(tx.size ?? 0)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-muted">
            {run.kept_after} transaction copies kept afterwards.
          </p>
        </div>
      )}
      {(view.stats.deleted || view.stats.aborted) && (
        <p className="text-muted">
          {view.stats.deleted
            ? `Retention deleted ${view.stats.deleted} so far (${bytes(view.stats.freed_bytes ?? 0)})`
            : ""}
          {view.stats.deleted && view.stats.aborted ? " · " : ""}
          {view.stats.aborted
            ? `${view.stats.aborted} empty write${view.stats.aborted === 1 ? "" : "s"} aborted`
            : ""}
        </p>
      )}
    </div>
  );
}

const STATUS: Record<
  Projection["status"],
  { label: string; className: string }
> = {
  up_to_date: { label: "Up to date", className: "text-ok" },
  stale: { label: "Stale", className: "text-sand" },
  building: { label: "Building…", className: "text-ocean" },
  failed: { label: "Failed", className: "text-bad" },
};

function ProjectionsPanel({
  itemId,
  columns,
}: {
  itemId: string;
  columns?: string[];
}) {
  const [list, setList] = useState<Projection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<Projection["kind"]>("filter");
  const [chosen, setChosen] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(
    () =>
      maintenanceApi
        .projections(itemId)
        .then((l) => {
          setList(l);
          setError(null);
        })
        .catch((e: Error) => setError(e.message)),
    [itemId],
  );

  useEffect(() => {
    load();
  }, [load]);

  const building = list?.some((p) => p.status === "building") ?? false;
  useEffect(() => {
    if (!building) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [building, load]);

  const cols =
    columns && columns.length > 0
      ? chosen
      : typed
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await maintenanceApi.createProjection(itemId, kind, cols);
      setChosen([]);
      setTyped("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: Projection) => {
    if (
      !(await confirmDialog({
        title: "Delete projection?",
        message: `"${p.name}" (${bytes(p.size)}) will be deleted. Reads fall back to the dataset.`,
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    try {
      await maintenanceApi.deleteProjection(itemId, p.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rebuild = async (p: Projection) => {
    try {
      await maintenanceApi.rebuildProjection(itemId, p.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted">
        Optimized copies for faster reads, rebuilt after every new transaction.{" "}
        <b>Filter</b>: sorted by the columns, for equality or range filters on a
        prefix of them. <b>Join</b>: also a hash index for exact key lookups on
        all the columns.
      </p>
      {list === null && !error && <p className="text-muted">Loading…</p>}
      {list && list.length === 0 && (
        <p className="text-muted">No projections yet.</p>
      )}
      {list?.map((p) => (
        <div key={p.id} className="rounded-md border border-line p-2">
          <div className="flex items-start gap-2">
            <Icon
              name={p.kind === "join" ? "join" : "filter"}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ocean"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium" title={p.name}>
                {p.name}
              </div>
              <div className="text-muted">
                <span className={STATUS[p.status].className}>
                  {STATUS[p.status].label}
                </span>
                {p.size > 0 && ` · ${bytes(p.size)}`}
                {p.rows !== null && ` · ${p.rows.toLocaleString()} rows`}
                {p.row_groups ? ` · ${p.row_groups} groups` : ""}
              </div>
              {p.built_at && (
                <div className="text-muted">
                  Built {when(p.built_at)}
                  {p.build_ms !== undefined && ` in ${p.build_ms} ms`}
                </div>
              )}
              {p.error && <div className="break-words text-bad">{p.error}</div>}
            </div>
            <button
              type="button"
              title="Test a lookup"
              onClick={() => setTesting(testing === p.id ? null : p.id)}
              className="rounded p-0.5 text-muted hover:text-white"
            >
              <Icon name="search" className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="Rebuild now"
              disabled={p.status === "building"}
              onClick={() => rebuild(p)}
              className="rounded p-0.5 text-muted hover:text-white disabled:opacity-40"
            >
              <Icon name="refresh" className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="Delete"
              onClick={() => remove(p)}
              className="rounded p-0.5 text-muted hover:text-bad"
            >
              <Icon name="trash" className="h-3.5 w-3.5" />
            </button>
          </div>
          {testing === p.id && (
            <ProjectionTest itemId={itemId} projection={p} />
          )}
        </div>
      ))}

      <div className="flex flex-col gap-2 rounded-md border border-dashed border-line-2 p-2">
        <div className="flex gap-2">
          {(["filter", "join"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded px-2 py-0.5 ${kind === k ? "bg-ocean/20 text-white" : "text-muted hover:text-white"}`}
            >
              {k === "filter" ? "Filter-optimized" : "Join-optimized"}
            </button>
          ))}
        </div>
        {columns && columns.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {columns.map((c) => {
              const at = chosen.indexOf(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() =>
                    setChosen(
                      at >= 0 ? chosen.filter((x) => x !== c) : [...chosen, c],
                    )
                  }
                  className={`rounded border px-1.5 py-0.5 ${at >= 0 ? "border-ocean text-white" : "border-line-2 text-muted hover:text-white"}`}
                >
                  {at >= 0 && kind === "filter" && (
                    <span className="mr-1 text-ocean">{at + 1}</span>
                  )}
                  {c}
                </button>
              );
            })}
          </div>
        ) : (
          <input
            className={inputClass}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Columns, comma separated (in order)"
          />
        )}
        <button
          type="button"
          disabled={busy || cols.length === 0}
          onClick={create}
          className={buttonClass.outline}
        >
          <Icon name="plus" className="h-3.5 w-3.5" /> Create projection
        </button>
      </div>
      {error && <p className="break-words text-bad">{error}</p>}
    </div>
  );
}

function ProjectionTest({
  itemId,
  projection,
}: {
  itemId: string;
  projection: Projection;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ProjectionQuery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keyCols =
    projection.kind === "join"
      ? projection.columns
      : projection.columns.slice(0, 1);

  const run = async () => {
    setError(null);
    try {
      const eq: Record<string, unknown> = {};
      for (const c of keyCols) {
        const v = values[c] ?? "";
        const n = Number(v);
        eq[c] = v.trim() !== "" && Number.isFinite(n) ? n : v;
      }
      setResult(
        await maintenanceApi.queryProjection(itemId, projection.id, eq),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-1.5 border-t border-line pt-2">
      {keyCols.map((c) => (
        <input
          key={c}
          className={inputClass}
          placeholder={`${c} =`}
          value={values[c] ?? ""}
          onChange={(e) => setValues({ ...values, [c]: e.target.value })}
        />
      ))}
      <button type="button" onClick={run} className={buttonClass.outline}>
        <Icon name="play" className="h-3.5 w-3.5" /> Look up
      </button>
      {error && <p className="break-words text-bad">{error}</p>}
      {result && (
        <div className="text-muted">
          {result.matched.toLocaleString()} matching rows in {result.ms} ms via{" "}
          {result.source === "projection" ? "the projection" : "the dataset"} (
          {result.method}
          {result.row_groups !== undefined &&
            `, read ${result.row_groups_read} of ${result.row_groups} row groups`}
          )
          {result.fallback_reason && (
            <div>Not used: {result.fallback_reason}</div>
          )}
          {result.rows.length > 0 && (
            <pre className="mt-1 max-h-32 overflow-auto rounded bg-ink p-1.5 text-[10px] text-soft">
              {JSON.stringify(result.rows.slice(0, 3), null, 1)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
