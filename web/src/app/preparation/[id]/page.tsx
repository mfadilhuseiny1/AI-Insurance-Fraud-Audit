"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon, type IconName } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { datasetHref } from "@/lib/datasetPreview";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { contour } from "@/lib/contour";
import { describe, preparation, TYPES, type Change, type ColumnStats, type Focus, type Preparation, type PrepPreview } from "@/lib/preparation";

/** Preparation [Sunset] (palantir.com/docs/foundry/preparation): clean and prepare a dataset with column actions,
 *  a changelog (preview mode inserts changes in the middle), and saved datasets. api/preparation.py */
export default function PreparationEditor() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [prep, setPrep] = useState<Preparation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [previewAt, setPreviewAt] = useState<number | null>(null);
  const [data, setData] = useState<PrepPreview | null>(null);
  const [column, setColumn] = useState<string | null>(null);
  const [stats, setStats] = useState<ColumnStats | null>(null);
  const [focus, setFocus] = useState<Focus>(null);
  const [view, setView] = useState<"table" | "columns">("table");
  const [query, setQuery] = useState("");
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<null | "save-dataset" | "save-as" | "scope" | "input" | "versions">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    preparation.get(id).then(
      (p) => {
        setPrep(p);
        setChanges(p.changes);
      },
      (e: Error) => setError(e.message),
    );
  }, [id]);
  const upto = previewAt;
  useEffect(() => {
    if (!prep) return;
    let alive = true;
    preparation.preview(id, { upto, focus, changes }).then(
      (d) => {
        if (!alive) return;
        setData(d);
        setColumn((c) => (c && d.columns.some((x) => x.name === c) ? c : (d.columns[0]?.name ?? null)));
      },
      (e: Error) => alive && setMsg(e.message),
    );
    return () => {
      alive = false;
    };
  }, [id, prep, changes, upto, focus]);
  useEffect(() => {
    if (!prep || !column) return;
    let alive = true;
    preparation.stats(id, column, { upto, changes }).then((s) => alive && setStats(s), () => alive && setStats(null));
    return () => {
      alive = false;
    };
  }, [id, prep, column, changes, upto]);

  const persist = useCallback(
    async (next: Change[]) => {
      setChanges(next);
      setMsg(null);
      try {
        const p = await preparation.save(id, { changes: next });
        setPrep(p);
        setChanges(p.changes);
      } catch (e) {
        setMsg((e as Error).message);
      }
    },
    [id],
  );
  const add = (c: Change) => {
    if (!prep?.can_edit) return setMsg("You can view this preparation but not change it.");
    const at = previewAt ?? changes.length;
    const next = [...changes.slice(0, at), c, ...changes.slice(at)];
    if (previewAt !== null) setPreviewAt(previewAt + 1);
    setFocus(null);
    persist(next);
  };

  if (error) return <ApiError message={error} />;
  if (!prep) return <Loading />;
  const cols = data?.columns ?? [];
  const shownCols = cols.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
  const sel = cols.find((c) => c.name === column);
  const staged = Object.entries(renames).filter(([a, b]) => b && a !== b);
  const out = prep.outputs[0];
  const outOfDate = (o: Preparation["outputs"][number]) => o.mode === "updating" && (o.changes !== prep.changes.length || o.input_updated_at !== prep.input_item?.updated_at);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5">
        <Link href="/preparation" className="flex items-center gap-2 text-sm font-medium">
          <span className="rounded-md bg-sand/15 p-1.5 text-sand">
            <Icon name="transform" className="h-4 w-4" />
          </span>
          Preparation
        </Link>
        <button type="button" onClick={() => setDialog("save-as")} className="truncate text-xs text-muted hover:text-white" title="Save: name and location">
          {prep.name} · {prep.autosaved ? "Unsaved (Files › .auto-save)" : prep.path.join(" / ")}
        </button>
        <label className="flex items-center gap-1 text-xs text-muted" title="Output dataset branch: saved datasets go to this branch">
          <Icon name="split" className="h-3.5 w-3.5" />
          <select
            value={prep.branch}
            disabled={!prep.can_edit}
            onChange={async (e) => {
              const v = e.target.value;
              try {
                if (v === "__new__") {
                  const name = await promptDialog("Name of the new branch", "", { title: "Create branch" });
                  if (name?.trim()) setPrep(await preparation.createBranch(id, name.trim()));
                } else setPrep(await preparation.switchBranch(id, v));
              } catch (err) {
                setMsg((err as Error).message);
              }
            }}
            className="rounded border border-line-2 bg-ink px-1.5 py-1 text-xs text-soft"
          >
            {prep.branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
            <option value="__new__">+ Create branch…</option>
          </select>
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setDialog("scope")} className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs ${prep.scope.problems.length ? "border-warn/50 text-warn" : "border-line-2 text-soft hover:text-white"}`}>
            <Icon name="project" className="h-3.5 w-3.5" /> {prep.project_scoped ? `Project scope: ${prep.scope.project?.name ?? "?"}` : "Not Project-scoped"}
          </button>
          {out ? (
            <>
              <button
                type="button"
                onClick={() => contour.create(`${prep.name} analysis`, { kind: "dataset", id: out.item_id }).then((a) => router.push(`/analytics/${a.item.id}`), (e: Error) => window.alert(e.message))}
                className="flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white"
                title="Analyze the saved dataset in a new Contour analysis"
              >
                <Icon name="filter" className="h-3.5 w-3.5" /> Analyze
              </button>
              <Link href={`/sql-studio?sql=${encodeURIComponent(`SELECT *\nFROM \`ri.foundry.main.dataset.${out.item_id}\`\nLIMIT 100`)}&mode=data`} className="flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white" title="Query the saved dataset in SQL Studio">
                <Icon name="code" className="h-3.5 w-3.5" /> SQL
              </Link>
            </>
          ) : (
            <span className="flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-muted" title="Save a dataset first: Analyze opens it in Contour">
              <Icon name="globe" className="h-3.5 w-3.5" /> Analyze
            </span>
          )}
          {out && prep.can_edit && prep.branches.length > 1 && (
            <button
              type="button"
              onClick={async () => {
                const others = prep.branches.filter((b) => b !== prep.branch);
                const target = await promptDialog(`Save to another branch (${others.join(", ")})`, others[0] ?? "", { title: "Save to another branch" });
                if (!target?.trim()) return;
                if (!(await confirmDialog(`Write this preparation's result to the ${target.trim()} branch of the saved dataset?`))) return;
                try {
                  const r = await preparation.saveToBranch(id, out.item_id, target.trim());
                  setPrep(r);
                  setMsg(`Saved ${r.saved.rows.toLocaleString()} rows to ${r.saved.branch}`);
                } catch (err) {
                  setMsg((err as Error).message);
                }
              }}
              className="rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white"
            >
              Save to another branch
            </button>
          )}
          <button type="button" onClick={() => setDialog("versions")} className="rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white" disabled={!prep.saved_versions.length}>
            Saved versions ({prep.saved_versions.filter((v) => (v.branch ?? "master") === prep.branch).length})
          </button>
          <button
            type="button"
            onClick={async () => {
              const d = await preparation.duplicate(id);
              router.push(`/preparation/${d.id}`);
            }}
            className="rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white"
          >
            Duplicate
          </button>
          <button type="button" disabled={!prep.can_edit} onClick={() => setDialog("save-dataset")} className="flex items-center gap-1.5 rounded-md bg-ocean px-3 py-1.5 text-xs font-medium text-white hover:bg-ocean-deep disabled:opacity-50">
            <Icon name="save" className="h-3.5 w-3.5" /> Save as dataset
          </button>
        </div>
      </header>
      <div className="flex items-center gap-3 border-b border-line bg-warn/10 px-5 py-2 text-xs text-warn">
        <Icon name="alert" className="h-4 w-4 shrink-0" />
        <span>
          <strong>Preparation is in sunset.</strong> For new workflows, use Pipeline Builder to clean and prepare data. Existing preparations remain fully supported.
        </span>
        <Link href="/pipeline" className="ml-auto text-sand hover:underline">
          Open Pipeline Builder
        </Link>
      </div>
      {previewAt !== null && (
        <div className="flex items-center gap-3 border-b border-line bg-ocean/10 px-5 py-1.5 text-xs text-soft">
          <Icon name="eye" className="h-3.5 w-3.5 text-ocean" /> Preview mode: the data before change {previewAt + 1}. New changes are inserted here, above the later ones.
          <button type="button" onClick={() => setPreviewAt(null)} className="ml-auto text-ocean hover:underline">
            Cancel
          </button>
        </div>
      )}
      {msg && (
        <button type="button" onClick={() => setMsg(null)} className="border-b border-line bg-panel-2 px-5 py-1.5 text-left text-xs text-soft">
          {msg} <span className="text-muted">(dismiss)</span>
        </button>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
          <div className="border-b border-line p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-soft">Columns</span>
              <span className="text-[10px] text-muted">{cols.length} columns</span>
            </div>
            <div className="flex items-center gap-2 rounded-md border border-line-2 bg-ink px-2 py-1.5">
              <Icon name="search" className="h-3.5 w-3.5 text-muted" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search columns" className="w-full bg-transparent text-xs outline-none placeholder:text-muted" />
            </div>
          </div>
          <div className="flex border-b border-line p-2">
            {(["table", "columns"] as const).map((v) => (
              <button key={v} type="button" onClick={() => setView(v)} className={`flex-1 rounded px-2 py-1.5 text-xs ${view === v ? "bg-panel-2 text-white ring-1 ring-line-2" : "text-muted hover:text-white"}`}>
                {v === "table" ? "Table" : "Column"}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {shownCols.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() => (setColumn(c.name), setFocus(null))}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left ${column === c.name ? "bg-ocean/15 text-white ring-1 ring-ocean/30" : "text-soft hover:bg-panel-2"}`}
              >
                <Icon name={typeIcon(c.type)} className={`h-4 w-4 ${column === c.name ? "text-ocean" : "text-muted"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{c.name}</span>
                  <span className="block text-[10px] text-muted">{c.type}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="border-t border-line p-3 text-[10px] text-muted">
            Input dataset
            {prep.input_item ? (
              <Link href={datasetHref(prep.input_item.id)} className="mt-1 block truncate text-soft hover:underline">
                {[...prep.input_item.path, prep.input_item.name].join(" / ")}
              </Link>
            ) : (
              <div className="mt-1 text-bad">missing</div>
            )}
            {prep.can_edit && (
              <button type="button" onClick={() => setDialog("input")} className="mt-2 text-ocean hover:underline">
                Change dataset
              </button>
            )}
          </div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-line bg-panel-2 px-4 py-2 text-xs">
            <span className="font-medium text-white">{prep.input_item?.name ?? "?"}</span>
            <span className="text-muted">·</span>
            <span className="text-muted">
              {data ? `${data.row_count.toLocaleString()} rows` : "…"}
              {data?.focused_rows !== null && data?.focused_rows !== undefined ? ` · focused on ${data.focused_rows.toLocaleString()}` : ""}
              {data && data.rows.length < (data.focused_rows ?? data.row_count) ? ` · showing ${data.rows.length}` : ""}
            </span>
            {focus && (
              <button type="button" onClick={() => setFocus(null)} className="text-ocean hover:underline">
                Clear focus
              </button>
            )}
            {view === "columns" && staged.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  add({ type: "rename", params: { renames: Object.fromEntries(staged) } });
                  setRenames({});
                }}
                className={`${buttonClass.primary} ml-auto py-1`}
              >
                Apply {staged.length} rename{staged.length > 1 ? "s" : ""}
              </button>
            )}
          </div>
          {view === "table" ? (
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <table className="w-full min-w-[700px] border-collapse text-left">
                <thead>
                  <tr>
                    {cols.map((c) => (
                      <th
                        key={c.name}
                        onClick={() => (setColumn(c.name), setFocus(null))}
                        className={`cursor-pointer border border-line-2 px-3 py-2 text-xs font-medium ${column === c.name ? "bg-ocean/15 text-white" : "bg-panel text-soft"}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <Icon name={typeIcon(c.type)} className="h-3.5 w-3.5 text-muted" />
                          {c.name}
                        </div>
                        <div className="mt-1 text-[10px] font-normal text-muted">{c.type}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data?.rows.map((r, ri) => (
                    <tr key={ri}>
                      {r.map((v, ci) => (
                        <td key={ci} className={`whitespace-pre border border-line px-3 py-1.5 font-mono text-xs ${data.names[ci] === column ? "bg-ocean/5 text-white" : "text-soft"}`}>
                          {v === null ? <span className="italic text-muted">null</span> : String(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {shownCols.map((c) => {
                  const i = data?.names.indexOf(c.name) ?? -1;
                  const renamed = renames[c.name] !== undefined && renames[c.name] !== c.name;
                  return (
                    <div key={c.name} className={`rounded-lg border bg-panel p-3 ${column === c.name ? "border-ocean/50" : "border-line"}`} onClick={() => setColumn(c.name)}>
                      <input
                        value={renames[c.name] ?? c.name}
                        onChange={(e) => setRenames({ ...renames, [c.name]: e.target.value })}
                        className={`w-full rounded bg-transparent px-1 text-sm font-medium outline-none focus:ring-1 focus:ring-ocean ${renamed ? "text-ok" : "text-white"}`}
                        aria-label={`Rename ${c.name}`}
                      />
                      <div className="mt-0.5 px-1 text-[10px] text-muted">{c.type}</div>
                      <ul className="mt-2 space-y-0.5 px-1 font-mono text-[11px] text-soft">
                        {(data?.rows ?? []).slice(0, 5).map((r, ri) => (
                          <li key={ri} className="truncate">
                            {i >= 0 && r[i] !== null ? String(r[i]) : <span className="italic text-muted">null</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </main>
        <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-line bg-panel">
          {sel && stats && stats.column === sel.name && <ColumnPanel stats={stats} focus={focus} setFocus={setFocus} onChange={add} columns={cols.map((c) => c.name)} />}
          <Changelog
            changes={changes}
            errors={data?.errors ?? {}}
            applied={data?.applied ?? 0}
            previewAt={previewAt}
            setPreviewAt={setPreviewAt}
            onRemove={(i) => persist(changes.filter((_, j) => j !== i))}
            input={prep.input_item}
            onChangeInput={() => setDialog("input")}
            canEdit={prep.can_edit}
            onGlobal={add}
          />
          {prep.outputs.length > 0 && (
            <div className="border-t border-line p-3 text-xs">
              <div className="mb-2 font-semibold text-soft">Output datasets</div>
              {prep.outputs.map((o) => (
                <div key={o.item_id} className="mb-2 rounded-md border border-line-2 p-2">
                  <Link href={datasetHref(o.item_id)} className="text-ocean hover:underline">
                    Output: {o.rows.toLocaleString()} rows
                  </Link>
                  <div className="text-[10px] text-muted">
                    {o.mode === "updating" ? "updating" : "one-off"} · saved {when(o.saved_at)}
                  </div>
                  {outOfDate(o) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          setPrep(await preparation.update(id, o.item_id));
                          setMsg("Output updated.");
                        } catch (e) {
                          setMsg((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className={`${buttonClass.secondary} mt-1 py-0.5 text-xs`}
                    >
                      <Icon name="refresh" className="h-3 w-3" /> Update
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
      {dialog === "save-dataset" && (
        <DrivePicker
          title="Save as dataset"
          folder={{
            action: "Save here",
            busy,
            extra: <SaveDatasetExtra />,
            onPick: async (f) => {
              if (!f.id) return setMsg("Pick a Project or folder.");
              const name = (document.getElementById("prep-out-name") as HTMLInputElement | null)?.value || `${prep.input_item?.name.replace(/\.[^.]+$/, "") ?? "prepared"}_clean`;
              const mode = (document.getElementById("prep-out-mode") as HTMLSelectElement | null)?.value === "one_off" ? "one_off" : "updating";
              setBusy(true);
              try {
                const r = await preparation.saveDataset(id, { folder_id: f.id, name, mode });
                setPrep(r);
                setMsg(`Saved ${r.saved.rows.toLocaleString()} rows.`);
                setDialog(null);
              } catch (e) {
                setMsg((e as Error).message);
                setDialog(null);
              } finally {
                setBusy(false);
              }
            },
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "save-as" && (
        <DrivePicker
          title="Save preparation"
          folder={{
            action: "Save here",
            extra: <input id="prep-name" defaultValue={prep.name} className={`${inputClass} w-56 text-xs`} aria-label="Preparation name" />,
            onPick: async (f) => {
              if (!f.id) return setMsg("Pick a Project or folder.");
              const name = (document.getElementById("prep-name") as HTMLInputElement | null)?.value || prep.name;
              try {
                setPrep(await preparation.saveAs(id, name, f.id));
              } catch (e) {
                setMsg((e as Error).message);
              }
              setDialog(null);
            },
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "input" && (
        <DrivePicker
          title="Change the starting dataset"
          canPick={(i) => (i.kind === "file" && /\.(parquet|csv|tsv|json|jsonl)$/i.test(i.name) ? null : "Pick a dataset")}
          onPick={async (i) => {
            setDialog(null);
            try {
              const p = await preparation.save(id, { changes, input_item_id: i.id });
              setPrep(p);
              setMsg("Starting dataset changed: changes in red no longer apply; remove or fix them.");
            } catch (e) {
              setMsg((e as Error).message);
            }
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "scope" && <ScopeDialog prep={prep} onClose={() => setDialog(null)} onChanged={(p) => setPrep(p)} onMsg={setMsg} />}
      {dialog === "versions" && (
        <Modal title="Saved versions" icon="history" onClose={() => setDialog(null)}>
          <ul className="max-h-[60vh] space-y-2 overflow-y-auto p-4 text-xs">
            {prep.saved_versions.filter((v) => (v.branch ?? "master") === prep.branch).map((v) => (
              <li key={v.id} className="flex items-center gap-3 rounded-md border border-line-2 p-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-soft">
                    {when(v.at)} · {v.changes.length} changes · {v.branch ?? "master"}
                  </span>
                  <Link href={datasetHref(v.output_item_id)} className="text-ocean hover:underline">
                    the dataset it saved
                  </Link>
                </span>
                {prep.can_edit && (
                  <button
                    type="button"
                    onClick={async () => {
                      if (!(await confirmDialog("Restore this version's changelog? The current changes are replaced."))) return;
                      const p = await preparation.restore(id, v.id);
                      setPrep(p);
                      setChanges(p.changes);
                      setDialog(null);
                    }}
                    className={buttonClass.secondary}
                  >
                    Restore saved version
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}

function SaveDatasetExtra() {
  return (
    <div className="flex items-center gap-2">
      <input id="prep-out-name" placeholder="dataset name" className={`${inputClass} w-48 text-xs`} aria-label="Dataset name" />
      <select id="prep-out-mode" className={`${inputClass} w-44 text-xs`} aria-label="Kind" defaultValue="updating">
        <option value="updating">Updating dataset</option>
        <option value="one_off">One-off dataset</option>
      </select>
    </div>
  );
}

function typeIcon(t: string): IconName {
  return t === "String" ? "doc" : t === "Integer" || t === "Double" ? "gauge" : t === "Date" || t === "Timestamp" ? "clock" : t === "Boolean" ? "check" : "list";
}

function ColumnPanel({ stats, focus, setFocus, onChange, columns }: { stats: ColumnStats; focus: Focus; setFocus: (f: Focus) => void; onChange: (c: Change) => void; columns: string[] }) {
  const col = stats.column;
  const [action, setAction] = useState<string>("");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const selected = focus && focus.column === col ? focus.values : [];
  const toggle = (v: string | null) => {
    const cur = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    setFocus(cur.length ? { column: col, values: cur } : null);
  };
  const max = Math.max(1, ...stats.top.map((t) => t.count));
  const pct = (n: number) => (stats.rows ? `${Math.round((100 * n) / stats.rows)}%` : "0%");
  const apply = () => {
    const vals = selected.filter((v): v is string => v !== null);
    const nulls = selected.includes(null);
    const C = (type: Change["type"], params: Record<string, unknown>) => onChange({ type, params });
    if (action === "type") C("change_type", { column: col, to: a || "string" });
    if (action === "case") C("change_case", { column: col, case: a || "upper" });
    if (action === "value") C("new_value", { column: col, values: vals, nulls, value: a });
    if (action === "substring") C("extract", { column: col, kind: "substring", start: Number(a) || 1, end: Number(b) || 1, into: col });
    if (action === "regex") C("extract", { column: col, kind: "regex", pattern: a, group: Number(b) || 0, into: col });
    if (action === "expression") C("apply_expression", { column: col, expression: a });
    if (action === "split") C("split", { column: col, delimiter: a || " ", into: b.split(",").map((x) => x.trim()).filter(Boolean) });
    setAction("");
    setA("");
    setB("");
  };
  return (
    <div className="border-b border-line p-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold text-white">{col}</span>
        <span className="text-muted">{stats.type}</span>
      </div>
      <div className="mb-2 grid grid-cols-3 gap-1 text-[10px]">
        <Stat label="Null" value={`${stats.nulls} (${pct(stats.nulls)})`} onClick={() => setFocus({ column: col, values: [], nulls: true })} />
        <Stat label="Distinct" value={stats.distinct.toLocaleString()} />
        {stats.empty !== undefined && <Stat label="Empty" value={String(stats.empty)} onClick={() => setFocus({ column: col, values: [""] })} />}
        {stats.needs_trim !== undefined && <Stat label="Needs trim" value={String(stats.needs_trim)} />}
        {stats.uppercase !== undefined && <Stat label="Upper / lower / mixed" value={`${stats.uppercase} / ${stats.lowercase} / ${stats.mixed_case}`} />}
        {stats.numeric_like !== undefined && <Stat label="Numeric" value={String(stats.numeric_like)} />}
        {stats.min !== undefined && <Stat label="Min" value={String(stats.min)} />}
        {stats.max !== undefined && <Stat label="Max" value={String(stats.max)} />}
        {stats.mean !== undefined && stats.mean !== null && <Stat label="Mean" value={stats.mean.toFixed(2)} />}
      </div>
      {stats.flags.filter((f) => f.change).map((f) => (
        <div key={f.kind} className="mb-1 flex items-center gap-2 rounded-md bg-sand/10 px-2 py-1.5">
          <Icon name="sparkle" className="h-3.5 w-3.5 text-sand" />
          <span className="text-soft">
            {f.label}: {f.count}
          </span>
          <button type="button" onClick={() => onChange(f.change!)} className="ml-auto text-sand hover:underline">
            {f.action}
          </button>
        </div>
      ))}
      <div className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wide text-muted">Values (select to focus)</div>
      <ul className="max-h-48 space-y-0.5 overflow-y-auto">
        {stats.top.map((t) => (
          <li key={String(t.value)}>
            <button type="button" onClick={() => toggle(t.value)} className={`relative flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left ${selected.includes(t.value) ? "bg-ocean/20 text-white" : "text-soft hover:bg-panel-2"}`}>
              <span className="absolute inset-y-0 left-0 rounded bg-ocean/10" style={{ width: `${(100 * t.count) / max}%` }} />
              <span className="relative truncate font-mono">{t.value === null ? <span className="italic text-muted">null</span> : t.value === "" ? <span className="italic text-muted">(empty)</span> : t.value}</span>
              <span className="relative ml-auto text-muted">{t.count}</span>
            </button>
          </li>
        ))}
      </ul>
      {(selected.length > 0 || focus?.nulls) && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={() => onChange({ type: "remove_rows", params: { column: col, values: selected.filter((v) => v !== null), nulls: selected.includes(null) || !!focus?.nulls } })} className={buttonClass.secondary}>
            Remove rows
          </button>
          <button type="button" onClick={() => onChange({ type: "keep_rows", params: { column: col, values: selected.filter((v) => v !== null), nulls: selected.includes(null) || !!focus?.nulls } })} className={buttonClass.secondary}>
            Keep only these
          </button>
        </div>
      )}
      <div className="mb-1 mt-3 text-[10px] font-semibold uppercase tracking-wide text-muted">Actions</div>
      <div className="flex flex-wrap gap-1">
        {stats.type === "String" && (
          <>
            <Act label="Trim whitespace" onClick={() => onChange({ type: "trim", params: { column: col } })} />
            <Act label="Empty → null" onClick={() => onChange({ type: "empty_to_null", params: { column: col } })} />
            <Act label="Change case" onClick={() => (setAction("case"), setA("upper"))} />
            <Act label="Extract" onClick={() => (setAction("substring"), setA("1"), setB("5"))} />
            <Act label="Split" onClick={() => (setAction("split"), setA(" "), setB(`${col}_1, ${col}_2`))} />
          </>
        )}
        <Act label="Change type" onClick={() => (setAction("type"), setA("double"))} />
        <Act label={selected.length ? `New value (${selected.length} selected)` : "New value (all rows)"} onClick={() => (setAction("value"), setA("/NULL"))} />
        <Act label="Apply expression" onClick={() => (setAction("expression"), setA(`upper(${col})`))} />
        <Act label="Delete column" onClick={() => onChange({ type: "delete_columns", params: { columns: [col] } })} />
      </div>
      {action && (
        <div className="mt-2 space-y-1.5 rounded-md border border-line-2 p-2">
          {action === "type" && (
            <select value={a} onChange={(e) => setA(e.target.value)} className={`${inputClass} text-xs`}>
              {TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          )}
          {action === "case" && (
            <select value={a} onChange={(e) => setA(e.target.value)} className={`${inputClass} text-xs`}>
              <option value="upper">Uppercase</option>
              <option value="lower">Lowercase</option>
              <option value="title">Title case</option>
            </select>
          )}
          {action === "value" && <input value={a} onChange={(e) => setA(e.target.value)} className={`${inputClass} text-xs`} placeholder="/NULL for null" />}
          {(action === "substring" || action === "regex") && (
            <>
              <select value={action} onChange={(e) => setAction(e.target.value)} className={`${inputClass} text-xs`}>
                <option value="substring">Indexed substring</option>
                <option value="regex">Regex</option>
              </select>
              <div className="flex gap-1">
                <input value={a} onChange={(e) => setA(e.target.value)} className={`${inputClass} text-xs`} placeholder={action === "substring" ? "start (1-based)" : "pattern"} />
                <input value={b} onChange={(e) => setB(e.target.value)} className={`${inputClass} w-24 text-xs`} placeholder={action === "substring" ? "end" : "group"} />
              </div>
            </>
          )}
          {action === "expression" && <input value={a} onChange={(e) => setA(e.target.value)} className={`${inputClass} font-mono text-xs`} placeholder="Spark SQL, e.g. concat('https://x/', id)" />}
          {action === "split" && (
            <div className="flex gap-1">
              <input value={a} onChange={(e) => setA(e.target.value)} className={`${inputClass} w-20 text-xs`} placeholder="delimiter" />
              <input value={b} onChange={(e) => setB(e.target.value)} className={`${inputClass} text-xs`} placeholder="new columns, comma-separated" />
            </div>
          )}
          <div className="flex justify-end gap-1">
            <button type="button" onClick={() => setAction("")} className={buttonClass.secondary}>
              Cancel
            </button>
            <button type="button" onClick={apply} className={buttonClass.primary}>
              Apply
            </button>
          </div>
        </div>
      )}
      <p className="mt-2 text-[10px] text-muted">{columns.length} columns in this step.</p>
    </div>
  );
}

function Stat({ label, value, onClick }: { label: string; value: string; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick} className="rounded border border-line-2 px-1.5 py-1 text-left enabled:hover:border-ocean/50">
      <div className="text-muted">{label}</div>
      <div className="truncate text-soft">{value}</div>
    </button>
  );
}

function Act({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded border border-line-2 px-2 py-1 text-[11px] text-soft hover:border-ocean/50 hover:text-white">
      {label}
    </button>
  );
}

function Changelog({ changes, errors, applied, previewAt, setPreviewAt, onRemove, input, onChangeInput, canEdit, onGlobal }: {
  changes: Change[];
  errors: Record<string, string>;
  applied: number;
  previewAt: number | null;
  setPreviewAt: (n: number | null) => void;
  onRemove: (i: number) => void;
  input: Preparation["input_item"];
  onChangeInput: () => void;
  canEdit: boolean;
  onGlobal: (c: Change) => void;
}) {
  const [expr, setExpr] = useState<{ name: string; expression: string } | null>(null);
  return (
    <div className="flex-1 p-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold text-soft">Dataset changes</span>
        <span className="text-muted">{changes.length}</span>
      </div>
      {canEdit && (
        <div className="mb-2 flex flex-wrap gap-1">
          <Act label="Normalize strings" onClick={() => onGlobal({ type: "normalize_strings", params: { columns: [], ops: ["trim", "collapse_whitespace", "empty_to_null"] } })} />
          <Act label="Normalize column names" onClick={() => onGlobal({ type: "normalize_column_names", params: { style: "standard" } })} />
          <Act label="Add new column" onClick={() => setExpr({ name: "row_order", expression: "monotonically_increasing_id()" })} />
        </div>
      )}
      {expr && (
        <div className="mb-2 space-y-1 rounded-md border border-line-2 p-2">
          <input value={expr.name} onChange={(e) => setExpr({ ...expr, name: e.target.value })} className={`${inputClass} text-xs`} placeholder="column name" />
          <input value={expr.expression} onChange={(e) => setExpr({ ...expr, expression: e.target.value })} className={`${inputClass} font-mono text-xs`} placeholder="Spark SQL expression" />
          <div className="flex justify-end gap-1">
            <button type="button" onClick={() => setExpr(null)} className={buttonClass.secondary}>
              Cancel
            </button>
            <button type="button" onClick={() => (onGlobal({ type: "add_column", params: expr }), setExpr(null))} className={buttonClass.primary}>
              Add
            </button>
          </div>
        </div>
      )}
      <ol className="space-y-1">
        {changes.map((c, i) => {
          const err = c.id ? errors[c.id] : undefined;
          const skipped = !err && i >= applied && previewAt === null;
          return (
            <li key={c.id ?? i} className={`group rounded-md border px-2 py-1.5 ${err ? "border-bad/50 bg-bad/10" : previewAt === i ? "border-ocean bg-ocean/10" : "border-line-2"}`}>
              <div className="flex items-start gap-2">
                <span className="text-muted">{i + 1}.</span>
                <button type="button" onClick={() => setPreviewAt(previewAt === i ? null : i)} className={`min-w-0 flex-1 text-left ${skipped ? "text-muted" : "text-soft"}`} title="Preview the data before this change (and insert changes here)">
                  {describe(c)}
                </button>
                {canEdit && (
                  <button type="button" onClick={() => onRemove(i)} className="text-muted opacity-0 hover:text-bad group-hover:opacity-100" aria-label="Remove change">
                    <Icon name="x" className="h-3 w-3" />
                  </button>
                )}
              </div>
              {err && <p className="mt-1 text-[10px] text-bad">{err}</p>}
            </li>
          );
        })}
      </ol>
      <div className="mt-2 rounded-md border border-dashed border-line-2 px-2 py-1.5 text-muted">
        Starting dataset: <span className="text-soft">{input?.name ?? "missing"}</span>
        {canEdit && (
          <button type="button" onClick={onChangeInput} className="ml-2 text-ocean hover:underline">
            Change
          </button>
        )}
      </div>
    </div>
  );
}

function ScopeDialog({ prep, onClose, onChanged, onMsg }: { prep: Preparation; onClose: () => void; onChanged: (p: Preparation) => void; onMsg: (m: string) => void }) {
  const s = prep.scope;
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Project scope" icon="project" onClose={onClose}>
      <div className="space-y-3 p-5 text-xs">
        <p className="text-muted">
          A Project-scoped preparation saves datasets only when its input is in its Project ({s.project?.name ?? "?"}) or referenced there, and saves outputs into that Project.
        </p>
        <div className="rounded-md border border-line-2 p-2">
          <div className="text-soft">Input: {prep.input_item?.name}</div>
          <div className={s.input_in_scope ? "text-ok" : "text-warn"}>
            {s.input_in_scope ? "In scope" : `Out of scope (in ${s.input_project?.name ?? "another Project"})`}
          </div>
          {!s.input_in_scope && s.project && prep.input_item && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await preparation.addReference(s.project!.id, prep.input_item!.id);
                  onChanged(await preparation.get(prep.id));
                  onMsg(`Added ${prep.input_item!.name} as a reference to ${s.project!.name}.`);
                } catch (e) {
                  onMsg((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
              className={`${buttonClass.secondary} mt-1`}
            >
              Add a reference to {s.project.name}
            </button>
          )}
        </div>
        {s.problems.length > 0 && (
          <ul className="list-disc pl-5 text-warn">
            {s.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <label className="flex items-center gap-2 text-soft">
          <input
            type="checkbox"
            checked={prep.project_scoped}
            onChange={async (e) => {
              try {
                onChanged(await preparation.save(prep.id, { changes: prep.changes, project_scoped: e.target.checked }));
              } catch (ex) {
                onMsg((ex as Error).message);
              }
            }}
          />
          Project scoping enabled
        </label>
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
