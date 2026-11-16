"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { datasetHref } from "@/lib/datasetPreview";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";
import { DAYS, describeSchedule, describeTrigger, recipes, type Recipe, type RecipeBody, type RecipeFilter, type RecipeSource } from "@/lib/recipes";

/** Recipes [Sunset] (palantir.com/docs/foundry/recipes): monitor a dataset for a condition and notify recipients with
 *  a preview; expiration, run history, mute / pause, notification settings. api/recipes.py */
export default function RecipesPage() {
  return (
    <Suspense fallback={null}>
      <Recipes />
    </Suspense>
  );
}

const STATUS_STYLE: Record<string, string> = { active: "bg-ok/15 text-ok", paused: "bg-warn/15 text-warn", expired: "bg-panel-2 text-muted" };
const RUN_STYLE: Record<string, string> = { success: "text-ok", success_with_exceptions: "text-warn", skipped: "text-muted", failed: "text-bad" };

function Recipes() {
  const router = useRouter();
  const params = useSearchParams();
  const [tab, setTab] = useState<"mine" | "all">("mine");
  const [query, setQuery] = useState("");
  const [list, setList] = useState<Recipe[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(params.get("recipe"));
  const [editing, setEditing] = useState<Recipe | "new" | null>(params.get("new") ? "new" : null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [people, setPeople] = useState<{ id: string; label: string }[]>([]);
  const load = useCallback(() => {
    recipes.list(tab, query).then(setList, (e: Error) => (setList([]), setMsg(e.message)));
  }, [tab, query]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    recipes.people().then(setPeople, () => {});
  }, []);
  const selected = selectedId ? (list?.find((r) => r.id === selectedId) ?? list?.[0] ?? null) : null;
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setMsg(null);
    try {
      await fn();
      if (done) setMsg(done);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const expiringSoon = (r: Recipe) => r.expiring_soon;
  const dialogs = (
    <>
      {editing && (
        <Editor
          recipe={editing === "new" ? null : editing}
          itemId={editing === "new" ? params.get("new") : null}
          source={(params.get("source") as RecipeSource | null) ?? undefined}
          people={people}
          onClose={() => setEditing(null)}
          onSaved={(r) => {
            setEditing(null);
            setSelectedId(r.id);
            router.replace(`/recipes?recipe=${r.id}`);
            load();
          }}
        />
      )}
      {prefsOpen && <Prefs onClose={() => setPrefsOpen(false)} />}
    </>
  );
  // the home: every recipe; one opens in place (/recipes?recipe=…)
  if (!selectedId)
    return (
      <>
        <AppHome
          app="Recipes"
          icon="bell"
          accent="#f43f5e"
          href="/recipes"
          tagline="Sunset: monitor a dataset for a condition and notify recipients with a preview of the rows."
          description={
            <>
              <strong>Recipes is in sunset.</strong> Use{" "}
              <Link href="/automate" className="text-ocean hover:underline">
                Automate
              </Link>
              , Monitoring Views (Data Health) or Workshop for new monitoring workflows. A recipe checks its dataset on a schedule, notifies its recipients by email or
              notification, expires unless extended, and can be muted per person or paused for everyone.
            </>
          }
          headerActions={
            <button type="button" onClick={() => setPrefsOpen(true)} className="flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white">
              <Icon name="sliders" className="h-3.5 w-3.5" /> Notification settings
            </button>
          }
          noun={["recipe", "recipes"]}
          onSearch={setQuery}
          items={
            list?.map((r) => ({
              id: r.id,
              href: `/recipes?recipe=${r.id}`,
              title: r.name,
              path: [...r.resource.path, r.resource.name],
              updated_at: r.last_run?.at ?? r.created_at,
              detail: `${describeTrigger(r)} · ${describeSchedule(r.schedule)}`,
              badges: [
                r.muted_by_me
                  ? { label: "Muted", tone: "muted" as const }
                  : expiringSoon(r)
                    ? { label: "Expiring soon", tone: "warn" as const }
                    : { label: r.status[0].toUpperCase() + r.status.slice(1), tone: r.status === "active" ? ("ok" as const) : r.status === "paused" ? ("warn" as const) : ("muted" as const) },
                ...(r.last_run ? [{ label: `Last run ${r.last_run.status.replace(/_/g, " ")}`, tone: r.last_run.status === "failed" ? ("bad" as const) : r.last_run.status === "success" ? ("ok" as const) : ("muted" as const) }] : []),
              ],
              meta: `expires ${when(r.expires_at)}`,
            })) ?? null
          }
          toolbar={
            <div className="flex items-center gap-1 rounded-lg border border-line bg-panel p-0.5 text-xs">
              {(["mine", "all"] as const).map((t) => (
                <button key={t} type="button" onClick={() => setTab(t)} className={`rounded-md px-2.5 py-1 ${tab === t ? "bg-panel-2 text-strong" : "text-muted hover:text-soft"}`}>
                  {t === "mine" ? "Your recipes" : "All recipes"}
                </button>
              ))}
            </div>
          }
          empty={{ title: "No recipes", hint: "Create one here or from a dataset's All actions menu.", steps: ["Pick the dataset to monitor", "Set the condition and schedule", "Choose who is notified"] }}
          create={
            <>
              <button type="button" onClick={() => setEditing("new")} className={buttonClass.primary}>
                <Icon name="plus" className="h-3.5 w-3.5" /> New recipe
              </button>
              <span className="flex items-center gap-1.5 rounded-md bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
                <Icon name="alert" className="h-3.5 w-3.5" /> In sunset ·{" "}
                <Link href="/automate" className="text-sand hover:underline">
                  Open Automate
                </Link>
              </span>
              {msg && (
                <button type="button" onClick={() => setMsg(null)} className="text-left text-xs text-soft">
                  {msg} <span className="text-muted">(dismiss)</span>
                </button>
              )}
            </>
          }
        />
        {dialogs}
      </>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="rounded-md bg-sand/15 p-1.5 text-sand">
            <Icon name="bell" className="h-4 w-4" />
          </span>
          Recipes
        </div>
        <span className="text-xs text-muted">Monitoring and notifications</span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setPrefsOpen(true)} className="flex items-center gap-1.5 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white">
            <Icon name="sliders" className="h-3.5 w-3.5" /> Notification settings
          </button>
          <button type="button" onClick={() => setEditing("new")} className="flex items-center gap-1.5 rounded-md bg-ocean px-3 py-1.5 text-xs font-medium text-white hover:bg-ocean-deep">
            <Icon name="plus" className="h-3.5 w-3.5" /> New recipe
          </button>
        </div>
      </header>
      <div className="flex items-center gap-3 border-b border-line bg-warn/10 px-5 py-2 text-xs text-warn">
        <Icon name="alert" className="h-4 w-4 shrink-0" />
        <span>
          <strong>Recipes is in sunset.</strong> Use Automate, Monitoring Views (Data Health) or Workshop for new monitoring workflows.
        </span>
        <Link href="/automate" className="ml-auto text-sand hover:underline">
          Open Automate
        </Link>
      </div>
      {msg && (
        <button type="button" onClick={() => setMsg(null)} className="border-b border-line bg-panel-2 px-5 py-1.5 text-left text-xs text-soft">
          {msg} <span className="text-muted">(dismiss)</span>
        </button>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-panel p-3">
          <button type="button" onClick={() => (setSelectedId(null), router.replace("/recipes"))} className="mb-2 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-strong">
            <Icon name="left" className="h-3 w-3" /> All recipes
          </button>
          <div className="mb-2 text-xs font-semibold text-soft">Recipe management</div>
          <div className="flex items-center gap-2 rounded-md border border-line-2 bg-ink px-2 py-1.5">
            <Icon name="search" className="h-3.5 w-3.5 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search recipes" className="w-full bg-transparent text-xs outline-none placeholder:text-muted" />
          </div>
          <div className="mt-2 flex gap-1 rounded-md border border-line-2 bg-ink p-1 text-xs">
            {(["mine", "all"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)} className={`flex-1 rounded px-2 py-1 ${tab === t ? "bg-panel-2 text-white" : "text-muted hover:text-white"}`}>
                {t === "mine" ? "Your recipes" : "All recipes"}
              </button>
            ))}
          </div>
          <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto">
            {list === null && <p className="p-4 text-center text-xs text-muted">Loading…</p>}
            {list?.length === 0 && <p className="p-4 text-center text-xs text-muted">No recipes. Create one here or from a dataset&apos;s All actions menu.</p>}
            {list?.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => (setSelectedId(r.id), router.replace(`/recipes?recipe=${r.id}`))}
                className={`w-full rounded-lg border p-3 text-left ${selected?.id === r.id ? "border-ocean/50 bg-ocean/10" : "border-transparent hover:bg-panel-2"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-xs font-medium text-white">{r.name}</span>
                  <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] ${expiringSoon(r) ? "bg-warn/15 text-warn" : STATUS_STYLE[r.status]}`}>
                    {r.muted_by_me ? "Muted" : expiringSoon(r) ? "Expiring soon" : r.status[0].toUpperCase() + r.status.slice(1)}
                  </span>
                </div>
                <div className="mt-1 truncate text-[10px] text-muted">{r.resource.name}</div>
                <div className="mt-1 truncate text-[10px] text-soft">{describeTrigger(r)} · {describeSchedule(r.schedule)}</div>
              </button>
            ))}
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          {selected ? (
            <div className="mx-auto max-w-4xl space-y-4">
              <div className="rounded-xl border border-line bg-panel">
                <div className="flex items-start gap-4 border-b border-line p-5">
                  <span className="rounded-lg bg-sand/15 p-3 text-sand">
                    <Icon name="bell" className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs text-muted">
                      <span className={`rounded-full px-2 py-0.5 ${STATUS_STYLE[selected.status]}`}>{selected.status}</span>
                      <span>by {selected.recipient_labels[selected.author] ?? selected.author}</span>
                      <span>· expires {when(selected.expires_at)}</span>
                    </div>
                    <h2 className="mt-1 text-lg font-semibold text-white">{selected.name}</h2>
                    <p className="mt-1 text-sm text-soft">
                      Monitors{" "}
                      <Link href={selected.resource.link ?? datasetHref(selected.resource.id)} className="text-ocean hover:underline">
                        {[...selected.resource.path, selected.resource.name].join(" / ")}
                      </Link>
                    </p>
                  </div>
                </div>
                <dl className="grid gap-4 border-b border-line p-5 text-xs md:grid-cols-2">
                  <Row label="Condition" value={describeTrigger(selected)} />
                  <Row label="Schedule" value={describeSchedule(selected.schedule)} />
                  <Row label="Preview columns" value={selected.columns.join(", ") || "the first five"} />
                  <Row label="Sent as" value={selected.channels.map((c) => (c === "email" ? "Email" : "Notification")).join(" and ")} />
                  <Row label="Recipients" value={selected.recipients.map((u) => selected.recipient_labels[u] ?? u).join(", ")} />
                  <Row label="Message" value={selected.message || "—"} />
                </dl>
                <div className="flex flex-wrap items-center gap-2 p-4">
                  {selected.can_manage && (
                    <button type="button" onClick={() => setEditing(selected)} className={buttonClass.secondary}>
                      Edit
                    </button>
                  )}
                  <button type="button" onClick={() => act(() => recipes.status(selected.id, selected.muted_by_me ? "unmute" : "mute"), selected.muted_by_me ? "Unmuted." : "Muted for you.")} className={buttonClass.secondary}>
                    {selected.muted_by_me ? "Unmute" : "Mute"}
                  </button>
                  {selected.can_manage && (
                    <>
                      <button type="button" onClick={() => act(() => recipes.status(selected.id, selected.paused ? "resume" : "pause"), selected.paused ? "Resumed." : "Paused for all recipients.")} className={buttonClass.secondary}>
                        {selected.paused ? "Resume" : "Pause for all"}
                      </button>
                      <button type="button" onClick={() => act(() => recipes.status(selected.id, selected.status === "expired" ? "resume" : "extend", 90), "Extended by 90 days.")} className={buttonClass.secondary}>
                        {selected.status === "expired" ? "Resume" : "Extend"}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          act(async () => {
                            const r = await recipes.run(selected.id);
                            setMsg(`Run: ${r.status.replace(/_/g, " ")}${r.reason ? ` (${r.reason})` : ""}${r.error ? `: ${r.error}` : ""}`);
                          })
                        }
                        className={buttonClass.secondary}
                      >
                        <Icon name="play" className="h-3.5 w-3.5" /> Run now
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={async () => (await confirmDialog(`Delete the recipe ${selected.name}? It stops for every recipient.`)) && act(() => recipes.remove(selected.id), "Deleted.")}
                    className="ml-auto text-xs text-muted hover:text-bad"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="rounded-xl border border-line bg-panel">
                <div className="border-b border-line px-4 py-3 text-sm font-medium">Run history</div>
                {selected.runs.length === 0 && <p className="p-4 text-xs text-muted">No runs yet.</p>}
                <ul className="divide-y divide-line text-xs">
                  {selected.runs.map((r) => (
                    <li key={r.id} className="px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        <span className={`w-40 font-medium ${RUN_STYLE[r.status]}`}>{r.status.replace(/_/g, " ")}</span>
                        <span className="text-muted">{when(r.at)}</span>
                        <span className="text-muted">{r.trigger}</span>
                        {r.matched !== undefined && <span className="text-muted">{r.matched} of {r.total} rows matched</span>}
                        <span className="ml-auto text-muted">{r.delivered.length} notified</span>
                      </div>
                      {r.reason && <p className="mt-0.5 text-muted">{r.reason}</p>}
                      {r.error && <pre className="mt-1 whitespace-pre-wrap text-bad">{r.error}</pre>}
                      {r.exceptions.map((x, i) => (
                        <p key={i} className="mt-0.5 text-warn">
                          {selected.recipient_labels[x.user] ?? x.user}: {x.reason}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-4xl rounded-xl border-2 border-dashed border-line-2 p-12 text-center text-sm text-muted">Select or create a recipe.</div>
          )}
        </main>
      </div>
      {dialogs}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5 text-soft">{value}</dd>
    </div>
  );
}

function Prefs({ onClose }: { onClose: () => void }) {
  const [channel, setChannel] = useState<"email" | "web" | "none">("web");
  useEffect(() => {
    recipes.preference().then((p) => setChannel(p.channel), () => {});
  }, []);
  return (
    <Modal title="Notification settings · Recipes" icon="sliders" onClose={onClose}>
      <div className="space-y-3 p-5 text-xs">
        <p className="text-muted">As an author you are notified when your recipes fail, succeed with exceptions, or are about to expire.</p>
        {(["email", "web", "none"] as const).map((c) => (
          <label key={c} className="flex items-center gap-2 text-soft">
            <input type="radio" checked={channel === c} onChange={() => recipes.setPreference(c).then(() => setChannel(c), () => {})} />
            {c === "email" ? "Email and web" : c === "web" ? "Web notifications" : "None"}
          </label>
        ))}
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

const SOURCE_LABEL: Record<RecipeSource, string> = { dataset: "Dataset", object_type: "Object type", time_series: "Time series", report: "Report" };

function Editor({
  recipe,
  itemId,
  source,
  people,
  onClose,
  onSaved,
}: {
  recipe: Recipe | null;
  itemId: string | null;
  source?: RecipeSource;
  people: { id: string; label: string }[];
  onClose: () => void;
  onSaved: (r: Recipe) => void;
}) {
  const initialSource: RecipeSource = recipe?.source ?? source ?? "dataset";
  const [body, setBody] = useState<RecipeBody>(
    recipe ?? {
      name: "",
      source: initialSource,
      item_id: itemId ?? "",
      lookback_hours: 24,
      attachment: "pdf",
      message: "",
      columns: [],
      filters: [{ column: "", op: "<", value: "" }],
      when: initialSource === "report" ? "always" : "condition",
      schedule: { kind: initialSource === "report" ? "weekly" : "on_update", every_hours: 24, days: [1], time: "09:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" },
      channels: initialSource === "report" ? ["email"] : ["notification"],
      recipients: [],
      expires_in_days: 90,
    },
  );
  const [cols, setCols] = useState<{ name: string; type: string }[]>([]);
  const src: RecipeSource = body.source ?? "dataset";
  const isReport = src === "report";
  const [picking, setPicking] = useState(!body.item_id);
  const [driveOpen, setDriveOpen] = useState(false);
  const [options, setOptions] = useState<{ id: string; name: string; series_id?: string }[]>([]);
  const [itemName, setItemName] = useState<string>(recipe?.resource.name ?? "");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!body.item_id || isReport) return;
    recipes.columns(body.item_id, src).then(setCols, (e: Error) => setErr(e.message));
  }, [body.item_id, src, isReport]);
  useEffect(() => {
    if (src === "dataset") return;
    recipes.sources(src).then(
      (o) => {
        setOptions(o);
        const hit = o.find((x) => x.id === body.item_id && (src !== "time_series" || x.series_id === body.series_id));
        if (hit) setItemName(hit.name);
      },
      (e: Error) => setErr(e.message),
    );
  }, [src, body.item_id, body.series_id]);
  const pickSource = (s: RecipeSource) =>
    setBody({
      ...body,
      source: s,
      item_id: "",
      series_id: null,
      columns: [],
      when: s === "report" ? "always" : body.when,
      channels: s === "report" ? ["email"] : body.channels,
      schedule: s === "report" && body.schedule.kind === "on_update" ? { ...body.schedule, kind: "weekly" } : body.schedule,
    });
  const setF = (i: number, f: Partial<RecipeFilter>) => setBody({ ...body, filters: body.filters.map((x, j) => (j === i ? { ...x, ...f } : x)) });
  const save = async () => {
    setErr(null);
    try {
      const clean = { ...body, filters: body.when === "condition" ? body.filters.filter((f) => f.column) : [] };
      onSaved(recipe ? await recipes.update(recipe.id, clean) : await recipes.create(clean));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  if (driveOpen)
    return (
      <DrivePicker
        title="Choose a dataset to monitor"
        canPick={(i) => (i.kind === "file" && /\.(parquet|csv|tsv|json|jsonl)$/i.test(i.name) ? null : "Pick a dataset")}
        onPick={(i) => {
          setBody({ ...body, item_id: i.id, name: body.name || `${i.name.replace(/\.[^.]+$/, "")} recipe` });
          setItemName(i.name);
          setDriveOpen(false);
          setPicking(false);
        }}
        onClose={() => setDriveOpen(false)}
      />
    );
  if (picking)
    return (
      <Modal title="What should the recipe watch?" icon="bell" onClose={() => (body.item_id ? setPicking(false) : onClose())}>
        <div className="space-y-3 p-5 text-xs">
          <div className="flex gap-1">
            {(Object.keys(SOURCE_LABEL) as RecipeSource[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => pickSource(s)}
                className={`rounded-md border px-2.5 py-1.5 ${src === s ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-soft hover:text-white"}`}
              >
                {SOURCE_LABEL[s]}
              </button>
            ))}
          </div>
          <p className="text-muted">
            {src === "dataset"
              ? "Rows of a dataset that match a condition."
              : src === "object_type"
                ? "Objects of a type whose properties match a condition."
                : src === "time_series"
                  ? "Points of a series in the last hours (timestamp, value), e.g. value > 90."
                  : "A report sent on a schedule as an attached PDF or an in-email image."}
          </p>
          {src === "dataset" ? (
            <button type="button" onClick={() => setDriveOpen(true)} className={buttonClass.secondary}>
              Choose a dataset…
            </button>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {options.map((o) => (
                <li key={o.id + (o.series_id ?? "")}>
                  <button
                    type="button"
                    onClick={() => {
                      setBody({ ...body, item_id: o.id, series_id: o.series_id ?? null, name: body.name || `${o.name} recipe` });
                      setItemName(o.name);
                      setPicking(false);
                    }}
                    className="w-full rounded border border-line px-2 py-1.5 text-left text-soft hover:border-ocean"
                  >
                    {o.name}
                  </button>
                </li>
              ))}
              {!options.length && <li className="text-muted">Nothing to watch yet.</li>}
            </ul>
          )}
        </div>
      </Modal>
    );
  return (
    <Modal title={recipe ? "Edit recipe" : "New recipe"} icon="bell" onClose={onClose} wide>
      <div className="max-h-[72vh] space-y-4 overflow-y-auto p-5 text-xs">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-muted">
            Name
            <input value={body.name} onChange={(e) => setBody({ ...body, name: e.target.value })} className={`${inputClass} mt-1`} />
          </label>
          <div className="text-muted">
            Monitored {SOURCE_LABEL[src].toLowerCase()}
            <div className="mt-1 flex items-center gap-2">
              <span className="truncate text-soft">{itemName || body.item_id}</span>
              {!recipe && (
                <button type="button" onClick={() => setPicking(true)} className="text-ocean hover:underline">
                  Change
                </button>
              )}
            </div>
          </div>
        </div>
        {isReport && (
          <div>
            <div className="mb-1 font-semibold text-soft">Send the report as</div>
            <div className="flex gap-3">
              {(["pdf", "image"] as const).map((a) => (
                <label key={a} className="flex items-center gap-1.5 text-soft">
                  <input type="radio" checked={(body.attachment ?? "pdf") === a} onChange={() => setBody({ ...body, attachment: a })} /> {a === "pdf" ? "An attached PDF" : "An in-email image"}
                </label>
              ))}
            </div>
            <p className="mt-1 text-muted">Rendered as you see it when the recipe runs, and emailed to the recipients.</p>
          </div>
        )}
        {src === "time_series" && (
          <label className="block text-muted">
            Look at the points of the last (hours)
            <input type="number" min={1} max={744} value={body.lookback_hours ?? 24} onChange={(e) => setBody({ ...body, lookback_hours: Number(e.target.value) || 24 })} className={`${inputClass} mt-1 w-24 text-xs`} />
          </label>
        )}
        {!isReport && (
        <div>
          <div className="mb-1 font-semibold text-soft">When to send</div>
          <div className="flex gap-3">
            <label className="flex items-center gap-1.5 text-soft">
              <input type="radio" checked={body.when === "condition"} onChange={() => setBody({ ...body, when: "condition" })} /> When rows match
            </label>
            <label className="flex items-center gap-1.5 text-soft">
              <input type="radio" checked={body.when === "always"} onChange={() => setBody({ ...body, when: "always" })} /> Every run
            </label>
          </div>
          {body.when === "condition" && (
            <div className="mt-2 space-y-1">
              {body.filters.map((f, i) => (
                <div key={i} className="flex gap-1">
                  <select value={f.column} onChange={(e) => setF(i, { column: e.target.value })} className={`${inputClass} text-xs`}>
                    <option value="">column…</option>
                    {cols.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <select value={f.op} onChange={(e) => setF(i, { op: e.target.value as RecipeFilter["op"] })} className={`${inputClass} w-32 text-xs`}>
                    {["=", "!=", "<", "<=", ">", ">=", "contains", "is null", "is not null"].map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                  {!f.op.startsWith("is") && <input value={f.value ?? ""} onChange={(e) => setF(i, { value: e.target.value })} className={`${inputClass} text-xs`} placeholder="value" />}
                  <button type="button" onClick={() => setBody({ ...body, filters: body.filters.filter((_, j) => j !== i) })} className="text-muted hover:text-bad" aria-label="Remove filter">
                    <Icon name="x" className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => setBody({ ...body, filters: [...body.filters, { column: "", op: "=", value: "" }] })} className="text-ocean hover:underline">
                + Add a filter (all must hold)
              </button>
            </div>
          )}
        </div>
        )}
        {!isReport && (
        <div>
          <div className="mb-1 font-semibold text-soft">Preview columns (up to 5)</div>
          <div className="flex flex-wrap gap-1">
            {cols.map((c) => (
              <button
                key={c.name}
                type="button"
                disabled={!body.columns.includes(c.name) && body.columns.length >= 5}
                onClick={() => setBody({ ...body, columns: body.columns.includes(c.name) ? body.columns.filter((x) => x !== c.name) : [...body.columns, c.name] })}
                className={`rounded-full border px-2 py-0.5 disabled:opacity-40 ${body.columns.includes(c.name) ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-soft"}`}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 font-semibold text-soft">Schedule</div>
            <select value={body.schedule.kind} onChange={(e) => setBody({ ...body, schedule: { ...body.schedule, kind: e.target.value as RecipeBody["schedule"]["kind"] } })} className={`${inputClass} text-xs`}>
              {!isReport && <option value="on_update">When the {SOURCE_LABEL[src].toLowerCase()} updates</option>}
              <option value="hours">Every N hours</option>
              <option value="weekly">On days of the week</option>
            </select>
            {body.schedule.kind === "hours" && (
              <input type="number" min={1} value={body.schedule.every_hours} onChange={(e) => setBody({ ...body, schedule: { ...body.schedule, every_hours: Number(e.target.value) || 24 } })} className={`${inputClass} mt-1 text-xs`} />
            )}
            {body.schedule.kind === "weekly" && (
              <div className="mt-1 space-y-1">
                <div className="flex flex-wrap gap-1">
                  {DAYS.map((d, i) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setBody({ ...body, schedule: { ...body.schedule, days: body.schedule.days.includes(i) ? body.schedule.days.filter((x) => x !== i) : [...body.schedule.days, i].sort() } })}
                      className={`rounded border px-1.5 py-0.5 ${body.schedule.days.includes(i) ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-soft"}`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1">
                  <input type="time" value={body.schedule.time} onChange={(e) => setBody({ ...body, schedule: { ...body.schedule, time: e.target.value } })} className={`${inputClass} w-28 text-xs`} />
                  <input value={body.schedule.timezone} onChange={(e) => setBody({ ...body, schedule: { ...body.schedule, timezone: e.target.value } })} className={`${inputClass} text-xs`} aria-label="Time zone" />
                </div>
              </div>
            )}
          </div>
          <div>
            <div className="mb-1 font-semibold text-soft">Send as</div>
            {(["notification", "email"] as const).map((c) => (
              <label key={c} className="flex items-center gap-1.5 text-soft">
                <input
                  type="checkbox"
                  checked={body.channels.includes(c)}
                  onChange={() => setBody({ ...body, channels: body.channels.includes(c) ? body.channels.filter((x) => x !== c) : [...body.channels, c] })}
                />
                {c === "email" ? "Email" : "Notification"}
              </label>
            ))}
            {!recipe && (
              <label className="mt-2 block text-muted">
                Expires in (days)
                <input type="number" min={1} max={365} value={body.expires_in_days ?? 90} onChange={(e) => setBody({ ...body, expires_in_days: Number(e.target.value) || 90 })} className={`${inputClass} mt-1 w-24 text-xs`} />
              </label>
            )}
          </div>
        </div>
        <div>
          <div className="mb-1 font-semibold text-soft">Recipients (up to 25; you if none)</div>
          <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
            {people.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={!body.recipients.includes(p.id) && body.recipients.length >= 25}
                onClick={() => setBody({ ...body, recipients: body.recipients.includes(p.id) ? body.recipients.filter((x) => x !== p.id) : [...body.recipients, p.id] })}
                className={`rounded-full border px-2 py-0.5 disabled:opacity-40 ${body.recipients.includes(p.id) ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-soft"}`}
              >
                {p.label}
              </button>
            ))}
            {!people.length && <span className="text-muted">You (people are listed when sign-in is on).</span>}
          </div>
          <p className="mt-1 text-muted">Recipients without Viewer access to the dataset get the notification with a link only, without the preview.</p>
        </div>
        <label className="block text-muted">
          Message
          <textarea value={body.message} onChange={(e) => setBody({ ...body, message: e.target.value })} rows={3} className={`${inputClass} mt-1`} />
        </label>
        {err && <p className="text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="button" disabled={!body.name.trim() || !body.item_id || !body.channels.length} onClick={save} className={buttonClass.primary}>
            {recipe ? "Save" : "Create recipe"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
