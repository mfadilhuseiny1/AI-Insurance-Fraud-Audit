"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api, type AppConfig, type FileMeta } from "@/lib/api";
import { amount, bytes, perPage } from "@/lib/format";
import { loadSavedSettings, saveSettings, tierBlocker } from "./ConfigPanel";
import { Dropzone } from "./Dropzone";
import { Icon } from "./Icon";

const LANGUAGES = [
  { code: "ind", label: "Indonesian" },
  { code: "ara", label: "Arabic" },
  { code: "eng", label: "English" },
  { code: "msa", label: "Malay" },
  { code: "fas", label: "Persian" },
  { code: "urd", label: "Urdu" },
];
const TEXT_LAYER_TIERS = ["fast", "cost_effective"];

/**
 * Set up a batch: the checklist of files (whole documents), one tier and settings for all of
 * them, and the estimate. Starting it creates one job per ticked file and opens the batch page.
 */
export function BatchSetup({
  config,
  files,
  onFiles,
  onCancel,
}: {
  config: AppConfig;
  files: FileMeta[];
  onFiles: (files: FileMeta[]) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const saved = useMemo(() => loadSavedSettings(), []);
  const firstUsable = config.tiers.find((t) => !tierBlocker(t, "pdf"))?.id ?? config.tiers[0].id;
  const [tier, setTier] = useState(saved.tier && config.tiers.some((t) => t.id === saved.tier) ? saved.tier : firstUsable);
  const [languages, setLanguages] = useState<string[]>(saved.languages ?? ["ind", "ara"]);
  const [instructions, setInstructions] = useState(saved.instructions ?? "");
  const [name, setName] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const t = config.tiers.find((x) => x.id === tier) ?? config.tiers[0];
  const blockedBy = (f: FileMeta) => tierBlocker(t, f.kind);
  const included = files.filter((f) => !excluded.has(f.id) && !blockedBy(f));
  const pages = included.reduce((n, f) => n + f.pages, 0);
  const estimate = pages * (t.price_per_page ?? 0);
  const allTicked = files.every((f) => !excluded.has(f.id));

  const add = (more: FileMeta[]) => onFiles([...files, ...more.filter((m) => !files.some((f) => f.id === m.id))]);
  const toggle = (id: string) =>
    setExcluded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      saveSettings({ tier, languages, instructions, pageFrom: 1, pageTo: 1 });
      const batch = await api.createBatch({
        file_ids: included.map((f) => f.id),
        tier,
        languages,
        instructions: tier.startsWith("agentic") ? instructions || undefined : undefined,
        name: name.trim() || undefined,
      });
      router.push(`/parse/batch/${batch.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-5 text-sm">
        <button type="button" onClick={onCancel} className="text-soft hover:text-white">
          Parse
        </button>
        <Icon name="right" className="h-3.5 w-3.5 text-muted" />
        <span>New batch</span>
        <span className="rounded bg-panel-2 px-1.5 py-0.5 text-xs text-muted ring-1 ring-line-2">{files.length} files</span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---------------------------------------------------- checklist */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="p-5">
            <div className="overflow-hidden rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead className="bg-panel text-left text-xs text-muted">
                  <tr>
                    <th className="w-10 px-3 py-2.5">
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={allTicked}
                        onChange={() => setExcluded(allTicked ? new Set(files.map((f) => f.id)) : new Set())}
                        className="accent-ocean"
                      />
                    </th>
                    {["File", "Type", "Pages", "Size", ""].map((h) => (
                      <th key={h} className="px-3 py-2.5 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {files.map((f) => {
                    const blocker = blockedBy(f);
                    const on = !excluded.has(f.id) && !blocker;
                    return (
                      <tr key={f.id} className={`border-t border-line ${on ? "" : "opacity-50"}`}>
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={!!blocker}
                            onChange={() => toggle(f.id)}
                            className="accent-ocean"
                            aria-label={`Include ${f.name}`}
                          />
                        </td>
                        <td className="max-w-md px-3 py-2">
                          <div className="flex items-center gap-2">
                            <Icon name={f.kind === "image" ? "image" : "doc"} className="h-4 w-4 shrink-0 text-ocean" />
                            <span className="truncate" title={f.name}>
                              {f.name}
                            </span>
                          </div>
                          {blocker && <div className="pl-6 text-[11px] text-bad">{t.label}: {blocker}</div>}
                        </td>
                        <td className="px-3 py-2 text-xs uppercase text-soft">{f.kind}</td>
                        <td className="px-3 py-2 tabular-nums text-soft">{f.pages}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-soft">{bytes(f.size)}</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => onFiles(files.filter((x) => x.id !== f.id))}
                            title="Remove from the batch"
                            className="rounded p-1 text-muted hover:bg-bad/10 hover:text-bad"
                          >
                            <Icon name="x" className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div className="px-5 pb-6 text-xs font-medium text-soft">Add more files</div>
          <Dropzone compact onUploaded={(m) => add([m])} onBatch={add} />
        </div>

        {/* ---------------------------------------------------- settings */}
        <aside className="flex w-96 shrink-0 flex-col border-l border-line bg-panel/40">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            <section>
              <h3 className="mb-2 text-sm font-semibold">Parse tier</h3>
              <div className="space-y-1.5">
                {config.tiers.map((x) => {
                  const unavailable = !x.available;
                  const cant = files.filter((f) => tierBlocker(x, f.kind)).length;
                  return (
                    <button
                      key={x.id}
                      type="button"
                      disabled={unavailable}
                      onClick={() => setTier(x.id)}
                      title={`Best for: ${x.best_for}. ${x.description}`}
                      className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm disabled:opacity-40 ${
                        tier === x.id ? "border-ocean bg-ocean/10" : "border-line-2 bg-panel-2 hover:border-ocean/50"
                      }`}
                    >
                      <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${tier === x.id ? "border-ocean" : "border-line-2"}`}>
                        {tier === x.id && <span className="h-1.5 w-1.5 rounded-full bg-ocean" />}
                      </span>
                      <span className="flex-1 font-medium">{x.label}</span>
                      {!unavailable && cant > 0 && <span className="text-[10.5px] text-sand">skips {cant}</span>}
                      <span className="rounded bg-ink px-1.5 py-0.5 font-mono text-[11px] text-soft">
                        {unavailable ? x.unavailable_reason ?? "Unavailable" : perPage(x.price_per_page)}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-soft">Best for: {t.best_for}</p>
              <p className="mt-0.5 text-xs text-muted">{t.description}</p>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Languages</h3>
              <div className="flex flex-wrap gap-1.5">
                {LANGUAGES.map((l) => {
                  const on = languages.includes(l.code);
                  return (
                    <button
                      key={l.code}
                      type="button"
                      disabled={TEXT_LAYER_TIERS.includes(tier)}
                      onClick={() => setLanguages(on ? languages.filter((x) => x !== l.code) : [...languages, l.code])}
                      className={`rounded-full border px-2.5 py-1 text-xs disabled:opacity-50 ${
                        on ? "border-ocean/60 bg-ocean/15 text-white" : "border-line-2 text-muted hover:text-white"
                      }`}
                    >
                      {l.label}
                    </button>
                  );
                })}
              </div>
              {TEXT_LAYER_TIERS.includes(tier) && <p className="mt-1.5 text-xs text-muted">Detected automatically for this tier.</p>}
            </section>

            {tier.startsWith("agentic") && (
              <section>
                <h3 className="mb-2 text-sm font-semibold">Instructions</h3>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={3}
                  placeholder="Optional, for every file"
                  className="w-full resize-y rounded-lg border border-line-2 bg-ink px-3 py-2 text-sm outline-none focus:border-ocean"
                />
              </section>
            )}

            <section>
              <h3 className="mb-2 text-sm font-semibold">Batch name</h3>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`${included.length} files · ${t.label}`}
                maxLength={120}
                className="w-full rounded-lg border border-line-2 bg-ink px-3 py-1.5 text-sm outline-none focus:border-ocean"
              />
            </section>
          </div>

          <div className="border-t border-line p-5">
            <div className="flex items-end justify-between">
              <div>
                <div className="text-xs text-muted">Estimated price</div>
                <div className="text-lg font-semibold tabular-nums">{amount(estimate)}</div>
                <div className="text-xs text-muted">
                  {included.length} files · {pages.toLocaleString()} pages · {perPage(t.price_per_page)}
                </div>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-muted">
              Every finished batch of pages is kept in the buffer, so any file can be paused or finished early without losing work.
            </p>
            {error && <p className="mt-2 text-xs text-bad">{error}</p>}
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={onCancel} className="rounded-md border border-line-2 px-3 py-2 text-sm text-soft hover:text-white">
                Cancel
              </button>
              <button
                type="button"
                onClick={start}
                disabled={busy || !included.length}
                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-ocean px-3 py-2 text-sm font-medium text-white hover:bg-ocean-deep disabled:opacity-40"
              >
                <Icon name="play" className="h-3.5 w-3.5" />
                {busy ? "Starting…" : `Parse ${included.length} file${included.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
