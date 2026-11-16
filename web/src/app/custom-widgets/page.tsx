"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { WidgetFrame, type WidgetLog } from "@/components/customWidgets/WidgetFrame";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { missingText } from "@/components/LocationField";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { functions as fnRegistry, type FunctionRow } from "@/lib/actions";
import { api, type DriveItem } from "@/lib/api";
import { auth } from "@/lib/auth";
import { STARTER_WIDGET, widgetSets, type ParamDef, type SourceWidget, type WidgetSetDetail, type WidgetSetSummary } from "@/lib/customWidgets";
import { when } from "@/lib/format";
import { ontology, type ActionType } from "@/lib/ontology";
import { workshop, type ObjectTypeSource } from "@/lib/workshop";
import { downloadProduct, ProductInstallDialog } from "@/components/ProductInstallDialog";

/** Custom widgets (palantir.com/docs/foundry/custom-widgets): widget sets, releases, the playground, the SDK. */
export default function CustomWidgetsPage() {
  return (
    <Suspense fallback={null}>
      <CustomWidgets />
    </Suspense>
  );
}

type Tab = "overview" | "editor" | "releases" | "sdk" | "dev";

function CustomWidgets() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id");
  const [sets, setSets] = useState<WidgetSetSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    widgetSets.list().then(setSets, (e: Error) => setError(e.message));
  }, [nonce]);
  const dialogs = (
    <>
      {installing && (
        <ProductInstallDialog title="Install a widget set product" kind="bluesandai.widget-set.product" onClose={() => setInstalling(false)}
          install={async (body) => ({ id: (await widgetSets.install(body)).id })}
          onInstalled={(sid) => {
            setInstalling(false);
            setNonce((n) => n + 1);
            router.replace(`/custom-widgets?id=${sid}&tab=overview`);
          }} />
      )}
      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            setNonce((n) => n + 1);
            router.replace(`/custom-widgets?id=${s.id}&tab=editor`);
          }}
        />
      )}
    </>
  );
  const installButton = (
    <button type="button" onClick={() => setInstalling(true)} className={buttonClass.secondary} data-install-product>
      <Icon name="download" className="h-3.5 w-3.5" /> Install product
    </button>
  );
  if (!id)
    return (
      <>
        <AppHome
          app="Custom widgets"
          icon="grid"
          accent="#d946ef"
          href="/custom-widgets"
          tagline="Extend Workshop with your own frontend code: bespoke charts, object views, signature pads."
          description={
            <>
              <p>
                Extend Workshop with your own frontend code: bespoke charts, industry-specific views of objects, signature pads. A widget set holds versions of the code; each
                widget declares parameters (data from Workshop) and events (updates back).
              </p>
              <p className="mt-2">
                Write widgets here (HTML, CSS, JavaScript) or upload a production build (.zip with .palantir/widgets.config.json). Widgets run isolated: they reach the Nexus only
                through the host, with the viewer&apos;s permissions.
              </p>
            </>
          }
          headerActions={installButton}
          noun={["widget set", "widget sets"]}
          error={error}
          items={
            sets?.map((w) => ({
              id: w.id,
              href: `/custom-widgets?id=${w.id}`,
              title: w.name,
              path: Array.isArray(w.path) ? (w.path as { name?: string }[]).map((x) => x?.name ?? "").filter(Boolean) : undefined,
              updated_at: w.created_at,
              detail: w.description || (w.widgets.length ? w.widgets.join(", ") : undefined),
              badges: [w.latest ? { label: `v${w.latest}`, tone: "ok" as const } : { label: "not released", tone: "warn" as const }],
              meta: `${w.widgets.length} widget${w.widgets.length === 1 ? "" : "s"}`,
            })) ?? null
          }
          empty={{ title: "Create your first widget set", hint: "A widget set holds your widget code and its released versions, ready to place in Workshop.", steps: ["Create a widget set", "Write or upload the widget code", "Release it and add it in Workshop"] }}
          create={
            <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> New widget set
            </button>
          }
        />
        {dialogs}
      </>
    );
  return (
    <div className="flex h-full flex-col">
      <AppHeader app="Custom widgets" icon="grid" href="/custom-widgets">
        {id && (
          <button type="button" className={buttonClass.secondary} title="Download a Marketplace product package of the latest release" data-package
            onClick={() => widgetSets.package(id).then((pk) => downloadProduct(pk, "widget-set-product"), (e: Error) => setError(e.message))}>
            <Icon name="download" className="h-3.5 w-3.5" /> Package
          </button>
        )}
        {installButton}
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> New widget set
        </button>
      </AppHeader>
      {error && <p className="px-6 pt-3 text-sm text-bad">{error}</p>}
      <div className="grid min-h-0 flex-1 grid-cols-[16rem_1fr]">
        <aside className="overflow-auto border-r border-line p-3 text-sm">
          <Link href="/custom-widgets" className="mb-2 flex items-center gap-1 px-2 text-[11px] font-medium uppercase tracking-wider text-muted hover:text-strong">
            <Icon name="left" className="h-3 w-3" /> All widget sets
          </Link>
          {sets?.length === 0 && <p className="text-xs text-muted">No widget sets yet.</p>}
          {sets?.map((s) => (
            <button key={s.id} type="button" onClick={() => router.replace(`/custom-widgets?id=${s.id}`)} className={`mb-1 block w-full rounded-md px-2.5 py-2 text-left ${s.id === id ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}>
              <div className="truncate font-medium">{s.name}</div>
              <div className="text-[11px] text-muted">
                {s.latest ? `v${s.latest} · ${s.widgets.length} widget${s.widgets.length === 1 ? "" : "s"}` : "not released"}
              </div>
            </button>
          ))}
        </aside>
        <main className="overflow-auto p-6">
          <SetView key={`${id}:${nonce}`} id={id} onChanged={() => setNonce((n) => n + 1)} />
        </main>
      </div>
      {dialogs}
    </div>
  );
}

function SetView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get("tab") as Tab) || "overview";
  const [set, setSet] = useState<WidgetSetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    widgetSets.get(id).then(setSet, (e: Error) => setError(e.message));
  }, [id, nonce]);
  const reload = () => (setNonce((n) => n + 1), onChanged());
  if (error) return <p className="text-sm text-bad">{error}</p>;
  if (!set) return <p className="text-sm text-muted">Loading…</p>;
  const tabs: [Tab, string][] = [
    ["overview", "Overview & playground"],
    ["editor", "Editor"],
    ["releases", "Releases"],
    ["sdk", "SDK"],
    ["dev", "Dev mode"],
  ];
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <div className="text-xs uppercase tracking-wider text-ocean">Widget set</div>
        <h1 className="mt-1 text-xl font-semibold">{set.name}</h1>
        <p className="font-mono text-[11px] text-muted">{set.rid}</p>
      </div>
      <div className="flex gap-1 border-b border-line text-sm">
        {tabs
          .filter(([k]) => set.can_edit || k === "overview")
          .map(([k, l]) => (
            <button key={k} type="button" onClick={() => router.replace(`/custom-widgets?id=${id}&tab=${k}`)} className={`px-3 py-1.5 ${tab === k ? "border-b-2 border-ocean text-white" : "text-muted hover:text-white"}`}>
              {l}
            </button>
          ))}
      </div>
      {tab === "overview" && <Overview set={set} />}
      {tab === "editor" && <Editor set={set} onReleased={reload} />}
      {tab === "releases" && <Releases set={set} onChanged={reload} />}
      {tab === "sdk" && <Sdk set={set} onChanged={reload} />}
      {tab === "dev" && <Dev set={set} onChanged={reload} />}
    </div>
  );
}

function defaultValue(p: ParamDef): unknown {
  return p.type === "boolean" ? false : p.type === "number" ? 0 : p.type === "array" ? [] : p.type === "objectSet" ? null : "";
}

function Overview({ set }: { set: WidgetSetDetail }) {
  const [version, setVersion] = useState(set.latest ?? "");
  const rel = set.releases.find((r) => r.version === version) ?? set.releases[0];
  const widgets = rel ? Object.values(rel.manifest.widgets) : [];
  const [widgetId, setWidgetId] = useState(widgets[0]?.id ?? "");
  const w = rel?.manifest.widgets[widgetId];
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [log, setLog] = useState<WidgetLog[]>([]);
  const [granted, setGranted] = useState<string[]>([]);
  const [size, setSize] = useState({ w: 100, h: 320 });
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [types, setTypes] = useState<ObjectTypeSource[]>([]);
  useEffect(() => {
    workshop.sources().then((s) => setTypes(s.object_types), () => {});
  }, []);
  if (!rel) return <p className="text-sm text-muted">No release yet: write a widget in the Editor and release it, or upload a production build.</p>;
  const vals = w ? Object.fromEntries(Object.entries(w.parameters).map(([k, p]) => [k, k in values ? values[k] : defaultValue(p)])) : {};
  return (
    <div className="grid grid-cols-[18rem_1fr] gap-4">
      <div className="space-y-3 text-xs">
        <label className="block text-muted">
          Version
          <select value={rel.version} onChange={(e) => setVersion(e.target.value)} className={`${inputClass} mt-1`}>
            {set.releases.map((r) => (
              <option key={r.version}>{r.version}</option>
            ))}
          </select>
        </label>
        <label className="block text-muted">
          Widget
          <select value={widgetId} onChange={(e) => (setWidgetId(e.target.value), setValues({}), setLog([]))} className={`${inputClass} mt-1`}>
            {widgets.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        {w && (
          <>
            <p className="text-muted">{w.description}</p>
            <div className="font-medium">Parameters</div>
            {Object.entries(w.parameters).map(([k, p]) => (
              <label key={k} className="block text-muted">
                {p.displayName ?? k} <span className="font-mono text-[10px]">{k} · {p.type}{p.subType ? `<${p.subType}>` : ""}</span>
                {p.type === "boolean" ? (
                  <input type="checkbox" checked={!!vals[k]} onChange={(e) => setValues({ ...values, [k]: e.target.checked })} className="ml-2" />
                ) : p.type === "objectSet" ? (
                  <select value={(vals[k] as { objectType?: string } | null)?.objectType ?? ""} onChange={(e) => setValues({ ...values, [k]: e.target.value ? { objectType: e.target.value, filters: [] } : null })} className={`${inputClass} mt-1`}>
                    <option value="">No object set</option>
                    {types.map((t) => (
                      <option key={t.id} value={t.id}>
                        All {t.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={p.type === "array" ? JSON.stringify(vals[k]) : String(vals[k] ?? "")}
                    type={p.type === "number" ? "number" : p.type === "date" ? "date" : "text"}
                    onChange={(e) => {
                      let v: unknown = e.target.value;
                      if (p.type === "number") v = Number(e.target.value);
                      if (p.type === "array")
                        try {
                          v = JSON.parse(e.target.value);
                        } catch {
                          return;
                        }
                      setValues({ ...values, [k]: v });
                    }}
                    className={`${inputClass} mt-1 font-mono`}
                  />
                )}
              </label>
            ))}
            <div className="font-medium">Events</div>
            {Object.entries(w.events).map(([k, e]) => (
              <div key={k} className="text-muted">
                <span className="font-mono">{k}</span> updates {(e.parameterUpdateIds ?? []).join(", ") || "nothing"}
              </div>
            ))}
            {w.permissions.length > 0 && (
              <>
                <div className="font-medium">Requested permissions</div>
                {w.permissions.map((p) => (
                  <label key={p} className="flex items-center gap-2 text-muted">
                    <input type="checkbox" checked={granted.includes(p)} onChange={(e) => setGranted(e.target.checked ? [...granted, p] : granted.filter((x) => x !== p))} /> {p} (allow for testing)
                  </label>
                ))}
              </>
            )}
          </>
        )}
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-muted">
          Size
          <input type="range" min={30} max={100} value={size.w} onChange={(e) => setSize({ ...size, w: Number(e.target.value) })} /> {size.w}%
          <input type="range" min={120} max={800} value={size.h} onChange={(e) => setSize({ ...size, h: Number(e.target.value) })} /> {size.h}px
          <button type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="ml-auto rounded border border-line-2 px-2 py-0.5">
            {theme} theme
          </button>
        </div>
        <div style={{ width: `${size.w}%`, height: size.h }} className={`overflow-hidden rounded-lg border border-line ${theme === "light" ? "bg-white" : "bg-ink"}`}>
          {w && <WidgetFrame key={`${rel.version}:${w.id}:${granted.join(",")}`} setId={set.id} widgetId={w.id} version={rel.version} values={vals} granted={granted} theme={theme} onEvent={(_e, u) => setValues((v) => ({ ...v, ...u }))} onLog={(l) => setLog((x) => [l, ...x].slice(0, 100))} />}
        </div>
        <div className="max-h-48 overflow-auto rounded-lg border border-line bg-panel p-2 font-mono text-[11px]">
          <div className="mb-1 font-sans text-xs text-muted">Message log</div>
          {log.map((l, i) => (
            <div key={i} className={l.kind === "error" ? "text-bad" : l.kind === "event" ? "text-ocean" : "text-soft"}>
              {new Date(l.at).toLocaleTimeString()} {l.kind} {l.text}
            </div>
          ))}
          {!log.length && <div className="text-muted">Events and Nexus calls appear here.</div>}
        </div>
      </div>
    </div>
  );
}

function Editor({ set, onReleased }: { set: WidgetSetDetail; onReleased: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, SourceWidget>>(() => (Object.keys(set.drafts ?? {}).length ? set.drafts : { counter: STARTER_WIDGET }));
  const [sel, setSel] = useState(Object.keys(drafts)[0]);
  const [part, setPart] = useState<"js" | "html" | "css" | "config">("js");
  const [config, setConfig] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const next = (() => {
    const [a, b, c] = (set.latest ?? "0.0.0").split("-")[0].split(".").map(Number);
    return `${a}.${b}.${c + 1}`;
  })();
  const [version, setVersion] = useState(set.latest ? next : "1.0.0");
  const w = drafts[sel];
  const cfgText = useCallback((x: SourceWidget) => JSON.stringify({ name: x.name, description: x.description, parameters: x.parameters, events: x.events, permissions: x.permissions }, null, 2), []);
  const set1 = (patch: Partial<SourceWidget>) => setDrafts((d) => ({ ...d, [sel]: { ...d[sel], ...patch } }));
  const save = async () => {
    try {
      await widgetSets.saveDrafts(set.id, drafts);
      setMsg("Saved");
      return true;
    } catch (e) {
      setMsg((e as Error).message);
      return false;
    }
  };
  return (
    <div className="grid grid-cols-[12rem_1fr] gap-3 text-xs">
      <div className="space-y-1">
        {Object.entries(drafts).map(([k, x]) => (
          <button key={k} type="button" onClick={() => (setSel(k), setPart("js"))} className={`block w-full rounded px-2 py-1 text-left ${k === sel ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}>
            <div>{x.name}</div>
            <div className="font-mono text-[10px] text-muted">{k}</div>
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            const id = window.prompt("Widget id (camelCase)");
            if (!id || !/^[a-z][A-Za-z0-9]*$/.test(id) || drafts[id]) return;
            setDrafts({ ...drafts, [id]: { ...STARTER_WIDGET, name: id } });
            setSel(id);
          }}
          className="text-ocean"
        >
          + Add widget
        </button>
      </div>
      {w && (
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            {(["js", "html", "css", "config"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  if (p === "config") setConfig(cfgText(w));
                  setPart(p);
                }}
                className={`rounded px-2 py-0.5 ${part === p ? "bg-ocean/15 text-white" : "text-muted"}`}
              >
                {p === "js" ? "JavaScript" : p === "config" ? "Configuration" : p.toUpperCase()}
              </button>
            ))}
            {Object.keys(drafts).length > 1 && (
              <button type="button" onClick={() => {
                const d = { ...drafts };
                delete d[sel];
                setDrafts(d);
                setSel(Object.keys(d)[0]);
              }} className="ml-2 text-muted hover:text-bad">
                Remove widget
              </button>
            )}
            <span className="ml-auto text-muted">{msg}</span>
          </div>
          {part === "config" ? (
            <>
              <textarea
                value={config}
                onChange={(e) => {
                  setConfig(e.target.value);
                  try {
                    const c = JSON.parse(e.target.value);
                    set1({ name: c.name ?? w.name, description: c.description ?? "", parameters: c.parameters ?? {}, events: c.events ?? {}, permissions: c.permissions ?? [] });
                  } catch {}
                }}
                rows={22}
                className={`${inputClass} font-mono text-[11px]`}
                spellCheck={false}
              />
              <p className="text-muted">Parameters: boolean, date, number, string, timestamp, objectSet, scenario, array (with subType). Events list the parameters they update (parameterUpdateIds). Permissions: camera, microphone, autoplay, allow-downloads, allow-forms, allow-popups. IDs are camelCase; up to 50 each.</p>
            </>
          ) : (
            <textarea value={w[part]} onChange={(e) => set1({ [part]: e.target.value } as Partial<SourceWidget>)} rows={22} className={`${inputClass} font-mono text-[11px]`} spellCheck={false} />
          )}
          <div className="flex items-center gap-2">
            <button type="button" onClick={save} className={buttonClass.secondary}>
              Save draft
            </button>
            <input value={version} onChange={(e) => setVersion(e.target.value)} className={`${inputClass} w-28 font-mono`} />
            <button
              type="button"
              onClick={async () => {
                if (!(await save())) return;
                try {
                  const r = await widgetSets.release(set.id, version);
                  setMsg(`Released ${r.version}`);
                  onReleased();
                } catch (e) {
                  setMsg((e as Error).message);
                }
              }}
              className={buttonClass.primary}
            >
              Release version
            </button>
            <span className="text-muted">Releases are immutable; Workshop modules keep the version they chose.</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Releases({ set, onChanged }: { set: WidgetSetDetail; onChanged: () => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center gap-2">
        <input
          ref={ref}
          type="file"
          accept=".zip"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setBusy(true);
            setMsg(null);
            try {
              const r = await widgetSets.upload(set.id, f);
              setMsg(`Released ${r.version}: ${Object.keys(r.manifest.widgets).join(", ")}`);
              onChanged();
            } catch (ex) {
              setMsg((ex as Error).message);
            } finally {
              setBusy(false);
              e.target.value = "";
            }
          }}
        />
        <button type="button" disabled={busy} onClick={() => ref.current?.click()} className={buttonClass.primary}>
          <Icon name="upload" className="h-3.5 w-3.5" /> {busy ? "Uploading…" : "Upload release"}
        </button>
        {msg && <span className="text-soft">{msg}</span>}
      </div>
      <p className="text-muted">
        A .zip of a production build without a top folder (<span className="font-mono">cd dist && zip -r ../asset.zip .</span>): <span className="font-mono">.palantir/widgets.config.json</span> (version and widgets with entrypointJs /
        entrypointCss or html, parameters, events, permissions), <span className="font-mono">index.html</span>, <span className="font-mono">assets/…</span>. Widgets use <span className="font-mono">window.BluesandaiWidget</span> (injected into every page) for parameters, events and Nexus calls.
      </p>
      <table className="w-full rounded border border-line">
        <thead className="bg-panel-2 text-left text-muted">
          <tr>
            <th className="px-3 py-1.5 font-normal">Version</th>
            <th className="px-3 py-1.5 font-normal">Widgets</th>
            <th className="px-3 py-1.5 font-normal">Source</th>
            <th className="px-3 py-1.5 font-normal">Size</th>
            <th className="px-3 py-1.5 font-normal">Released</th>
          </tr>
        </thead>
        <tbody>
          {set.releases.map((r) => (
            <tr key={r.version} className="border-t border-line">
              <td className="px-3 py-1.5 font-mono">{r.version}</td>
              <td className="px-3 py-1.5">{Object.values(r.manifest.widgets).map((w) => w.name).join(", ")}</td>
              <td className="px-3 py-1.5 text-muted">{r.source === "editor" ? "editor" : ".zip upload"}</td>
              <td className="px-3 py-1.5 text-muted">{Math.round(r.size / 1024)} KB</td>
              <td className="px-3 py-1.5 text-muted">{when(r.released_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sdk({ set, onChanged }: { set: WidgetSetDetail; onChanged: () => void }) {
  const [types, setTypes] = useState<ObjectTypeSource[]>([]);
  const [actions, setActions] = useState<ActionType[]>([]);
  const [fns, setFns] = useState<FunctionRow[]>([]);
  const [admin, setAdmin] = useState(false);
  const [cfg, setCfg] = useState({ object_types: set.osdk.object_types, action_types: set.osdk.action_types, functions: set.osdk.functions });
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    workshop.sources().then((s) => setTypes(s.object_types), () => {});
    ontology.actionTypes().then(setActions, () => {});
    fnRegistry.list().then(setFns, () => {});
    auth.me().then((m) => setAdmin(m.role === "admin"), () => {});
  }, []);
  const pick = (kind: keyof typeof cfg, id: string, on: boolean) => setCfg({ ...cfg, [kind]: on ? [...cfg[kind], id] : cfg[kind].filter((x) => x !== id) });
  const col = (title: string, kind: keyof typeof cfg, items: { id: string; name: string }[]) => (
    <div>
      <div className="mb-1 font-medium">{title}</div>
      <div className="max-h-56 overflow-auto rounded border border-line p-2">
        {items.map((x) => (
          <label key={x.id} className="flex items-center gap-2">
            <input type="checkbox" checked={cfg[kind].includes(x.id)} onChange={(e) => pick(kind, x.id, e.target.checked)} /> {x.name}
          </label>
        ))}
      </div>
    </div>
  );
  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-3 gap-3">
        {col("Object types", "object_types", types.map((t) => ({ id: t.id, name: t.name })))}
        {col("Action types", "action_types", actions.map((a) => ({ id: a.id, name: a.display_name })))}
        {col("Functions", "functions", fns.map((f) => ({ id: f.id, name: f.name })))}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={async () => {
          try {
            await widgetSets.osdk(set.id, cfg);
            setMsg("SDK resources saved");
            onChanged();
          } catch (e) {
            setMsg((e as Error).message);
          }
        }} className={buttonClass.primary}>
          Save SDK resources
        </button>
        <span className={set.osdk.ontology_apis ? "text-ok" : "text-warn"}>Nexus APIs {set.osdk.ontology_apis ? "enabled" : "not enabled"}</span>
        {admin && (
          <button type="button" onClick={async () => {
            await widgetSets.ontologyApis(set.id, !set.osdk.ontology_apis);
            onChanged();
          }} className={buttonClass.secondary}>
            {set.osdk.ontology_apis ? "Disable" : "Enable"} Nexus APIs
          </button>
        )}
        {!admin && !set.osdk.ontology_apis && <span className="text-muted">An administrator (Information Security Officer) enables them.</span>}
        {msg && <span className="text-muted">{msg}</span>}
      </div>
      <div className="rounded border border-line bg-panel p-3">
        <div className="mb-1 font-medium">SDK docs</div>
        <pre className="overflow-auto rounded bg-ink p-2 font-mono text-[11px] text-soft">{`const { osdk } = window.BluesandaiWidget;
await osdk.currentUser();
await osdk.objects("${cfg.object_types[0] ?? "<object type id>"}", { filters: [{ column: "status", op: "eq", value: "open" }], orderBy: "created", descending: true, pageSize: 50 });
await osdk.object("${cfg.object_types[0] ?? "<object type id>"}", "<primary key>");
await osdk.objectSet(parameters.values.myObjectSet);       // an objectSet parameter
await osdk.applyAction("${cfg.action_types[0] ?? "<action type id>"}", { /* parameters */ });
await osdk.executeFunction("${cfg.functions[0] ?? "<function id>"}", { /* inputs */ });`}</pre>
        <p className="mt-1 text-muted">Calls run as the viewer, only on these resources; the widget itself cannot reach the network (its iframe has no origin and a strict content security policy).</p>
      </div>
    </div>
  );
}

function Dev({ set, onChanged }: { set: WidgetSetDetail; onChanged: () => void }) {
  const [url, setUrl] = useState(set.dev?.url ?? "http://localhost:5173");
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (u: string | null, paused = false) => {
    try {
      await widgetSets.dev(set.id, u, paused);
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="max-w-2xl space-y-3 text-xs">
      <p className="text-soft">Dev mode shows your development server&apos;s widgets to you only (others keep the published version) and expires after 24 hours. The server serves each widget at <span className="font-mono">&lt;url&gt;/&lt;widget id&gt;.html</span> and loads the widget client from the host page&apos;s bridge (<span className="font-mono">window.BluesandaiWidget</span>, include <span className="font-mono">/api/widget-assets/…/__bluesandai/widget-client.js</span> or the same protocol).</p>
      <div className="flex items-center gap-2">
        <input value={url} onChange={(e) => setUrl(e.target.value)} className={`${inputClass} w-80 font-mono`} />
        <button type="button" onClick={() => act(url)} className={buttonClass.primary}>
          {set.dev ? "Reapply dev mode" : "Start dev mode"}
        </button>
        {set.dev && (
          <>
            <button type="button" onClick={() => act(set.dev!.url, !set.dev!.paused)} className={buttonClass.secondary}>
              {set.dev.paused ? "Resume" : "Pause"}
            </button>
            <button type="button" onClick={() => act(null)} className={buttonClass.secondary}>
              Stop
            </button>
          </>
        )}
      </div>
      <p className="text-muted">
        {set.dev ? `${set.dev.paused ? "Paused" : "Enabled"} · ${set.dev.url} · expires ${new Date(set.dev.expires).toLocaleString()}` : "Disabled: you see the published version."}
      </p>
      {msg && <p className="text-bad">{msg}</p>}
    </div>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (s: WidgetSetDetail) => void }) {
  const [name, setName] = useState("");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [folder, setFolder] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(name.trim() ? [] : ["enter a name"]), ...(folder ? [] : ["choose a Project"])];
  const nameInvalid = tried && !name.trim();
  const projectInvalid = tried && !folder;
  useEffect(() => {
    api.drive.folder(null).then((f) => {
      const ps = f.items.filter((i) => i.kind === "project");
      setProjects(ps);
      setFolder((c) => c || ps[0]?.id || "");
    }, () => {});
  }, []);
  return (
    <Modal title="New widget set" icon="grid" onClose={onClose}>
      <form
        className="space-y-3 p-5 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (missing.length) return;
          try {
            onCreated(await widgetSets.create({ name: name.trim(), folder_id: folder }));
          } catch (ex) {
            setErr((ex as Error).message);
          }
        }}
      >
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Name <span className="text-bad" aria-hidden>*</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameInvalid} className={`${inputClass} mt-1 ${nameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} autoFocus />
          {nameInvalid && <span className="mt-1 block text-[11px] text-bad">Give it a name.</span>}
        </label>
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Project (the widget set inherits its permissions) <span className="text-bad" aria-hidden>*</span></span>
          <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-invalid={projectInvalid} className={`${inputClass} mt-1 ${projectInvalid ? "border-bad ring-1 ring-bad/40" : ""}`}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {projectInvalid && <span className="mt-1 block text-[11px] text-bad">{projects.length ? "Choose the Project it is saved in." : "No Project to save it in: create or join one first."}</span>}
        </label>
        {err && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</p>}
        <div className="flex items-center justify-end gap-2">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To create: {missingText(missing)}</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" className={buttonClass.primary}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
