"use client";

import { useState } from "react";
import type { AppConfig, Tier } from "@/lib/api";
import { perPage } from "@/lib/format";
import { Icon, type IconName } from "./Icon";

export type ParseSettings = {
  tier: string;
  pageFrom: number;
  pageTo: number;
  languages: string[];
  instructions: string;
};

const STORAGE_KEY = "bluesandai.parse.settings";
const TIER_ICON: Record<string, IconName> = {
  fast: "bolt",
  cost_effective: "doc",
  precision: "fit",
  layout: "table",
  paddleocr: "globe",
  glmocr: "eye",
  unstructured: "extract",
  agentic: "sparkle",
  agentic_plus: "layers",
};
const LANGUAGE_OPTIONS = [
  { code: "ind", label: "Indonesian" },
  { code: "ara", label: "Arabic" },
  { code: "eng", label: "English" },
  { code: "msa", label: "Malay" },
  { code: "fas", label: "Persian" },
  { code: "urd", label: "Urdu" },
];

export function loadSavedSettings(): Partial<ParseSettings> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveSettings(s: ParseSettings): void {
  try {
    const { tier, languages, instructions } = s;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tier, languages, instructions }));
  } catch {}
}

/** Tiers that read a PDF's own text layer (PDF only, languages detected automatically). */
const TEXT_LAYER_TIERS = ["fast", "cost_effective"];

/** Why a tier can't be used for this file, or null if it can. */
export function tierBlocker(tier: Tier, fileKind: "pdf" | "image"): string | null {
  if (!tier.available) return tier.unavailable_reason ?? "Unavailable";
  if (TEXT_LAYER_TIERS.includes(tier.id) && fileKind !== "pdf") return "PDF only";
  return null;
}

export function ConfigPanel({
  config,
  pages,
  fileKind,
  value,
  onChange,
  readOnly,
}: {
  config: AppConfig;
  pages: number;
  fileKind: "pdf" | "image";
  value: ParseSettings;
  onChange: (next: ParseSettings) => void;
  readOnly?: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  const set = (patch: Partial<ParseSettings>) => !readOnly && onChange({ ...value, ...patch });
  const isAgentic = value.tier.startsWith("agentic");

  return (
    <div className="space-y-6 p-5">
      <section>
        <h3 className="mb-3 text-sm font-semibold">Parse tier</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {config.tiers.map((t) => {
            const selected = value.tier === t.id;
            const blocker = tierBlocker(t, fileKind);
            return (
              <button
                key={t.id}
                type="button"
                disabled={readOnly || blocker !== null}
                onClick={() => set({ tier: t.id })}
                className={`flex flex-col rounded-xl border p-3.5 text-left transition-colors ${
                  selected
                    ? "border-ocean bg-ocean/10 ring-1 ring-ocean/40"
                    : "border-line bg-panel-2 hover:border-line-2 disabled:hover:border-line"
                } ${blocker ? "opacity-45" : ""}`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                      selected ? "border-ocean" : "border-line-2"
                    }`}
                  >
                    {selected && <span className="h-2 w-2 rounded-full bg-ocean" />}
                  </span>
                  <Icon name={TIER_ICON[t.id] ?? "sparkle"} className="h-4 w-4 text-sand" />
                  <span className="font-semibold">{t.label}</span>
                  <span className="ml-auto whitespace-nowrap rounded-md bg-ink px-1.5 py-0.5 font-mono text-[11px] text-soft">
                    {blocker ?? perPage(t.price_per_page)}
                  </span>
                </span>
                <span className="mt-2 text-xs font-medium text-soft">Best for: {t.best_for}</span>
                <span className="mt-0.5 text-xs leading-relaxed text-muted">{t.description}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-line">
        <button
          type="button"
          onClick={() => setAdvanced(!advanced)}
          className="flex w-full items-center justify-between px-4 py-3 text-sm text-soft hover:text-white"
        >
          <span className="flex items-center gap-2">
            <Icon name="sliders" /> Advanced options
          </span>
          <Icon name={advanced ? "down" : "right"} />
        </button>
        {advanced && (
          <div className="space-y-5 border-t border-line p-4">
            <Field label="Pages" hint={`This file has ${pages} page${pages === 1 ? "" : "s"}.`}>
              <div className="flex items-center gap-2">
                <NumberInput value={value.pageFrom} min={1} max={value.pageTo} disabled={readOnly} onChange={(n) => set({ pageFrom: n })} />
                <span className="text-muted">to</span>
                <NumberInput value={value.pageTo} min={value.pageFrom} max={pages} disabled={readOnly} onChange={(n) => set({ pageTo: n })} />
                {!readOnly && (value.pageFrom !== 1 || value.pageTo !== pages) && (
                  <button type="button" onClick={() => set({ pageFrom: 1, pageTo: pages })} className="text-xs text-ocean hover:underline">
                    all pages
                  </button>
                )}
              </div>
            </Field>

            <Field
              label="Languages"
              hint={
                TEXT_LAYER_TIERS.includes(value.tier)
                  ? "Languages are detected automatically."
                  : "Guides language labels; Arabic elements render right-to-left."
              }
            >
              <div className="flex flex-wrap gap-1.5">
                {LANGUAGE_OPTIONS.map((l) => {
                  const on = value.languages.includes(l.code);
                  return (
                    <button
                      key={l.code}
                      type="button"
                      disabled={readOnly || TEXT_LAYER_TIERS.includes(value.tier)}
                      onClick={() =>
                        set({ languages: on ? value.languages.filter((x) => x !== l.code) : [...value.languages, l.code] })
                      }
                      className={`rounded-full border px-2.5 py-1 text-xs disabled:opacity-50 ${
                        on ? "border-ocean/60 bg-ocean/15 text-white" : "border-line-2 text-muted hover:text-white"
                      }`}
                    >
                      {l.label}
                    </button>
                  );
                })}
              </div>
            </Field>

            {isAgentic && (
              <Field label="Instructions" hint="Extra guidance for the AI reader, e.g. how this book marks hadith numbers.">
                <textarea
                  value={value.instructions}
                  disabled={readOnly}
                  onChange={(e) => set({ instructions: e.target.value })}
                  rows={3}
                  placeholder="Optional"
                  className="w-full resize-y rounded-lg border border-line-2 bg-ink px-3 py-2 text-sm outline-none focus:border-ocean"
                />
              </Field>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium">{label}</div>
      {children}
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (n: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
      }}
      className="w-20 rounded-lg border border-line-2 bg-ink px-2 py-1.5 text-sm tabular-nums outline-none focus:border-ocean"
    />
  );
}
