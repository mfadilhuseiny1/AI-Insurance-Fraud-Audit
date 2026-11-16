"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, fieldClass } from "@/components/pipeline/Modal";
import { API_URL, api, type SearchKey, type VectorConfig, type VectorIndex, type VectorSettings } from "@/lib/api";
import { usd, when } from "@/lib/format";
import { useConfig } from "@/lib/useConfig";
import { CreateIndexDialog } from "./CreateIndexDialog";
import { alertDialog, confirmDialog } from "@/lib/dialogs";

const selectClass = `${fieldClass} w-auto`;

/** "tenant=acme, access_level=internal" → {tenant: "acme", access_level: "internal"}; null if malformed */
export function parseFilter(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 1 || !part.slice(eq + 1).trim()) return null;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Per-index settings, all off until turned on: auto-embed of new parses, a spending limit,
 * auto-retry of failed runs, re-embedding into another index, and search keys for other apps.
 */
export function IndexSettings({
  config,
  index,
  indexes,
  settings,
  documents,
  failed,
  onSettings,
  onChanged,
}: {
  config: VectorConfig;
  index: VectorIndex;
  indexes: VectorIndex[];
  settings: VectorSettings | null;
  /** embedded documents and failed runs in this index */
  documents: number;
  failed: number;
  onSettings: (s: VectorSettings) => void;
  onChanged: () => void;
}) {
  const { config: app } = useConfig();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [budget, setBudget] = useState<string | null>(null); // the input while editing
  const [target, setTarget] = useState("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!settings) return <p className="p-4 text-sm text-muted">Loading settings…</p>;

  const act = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const save = (what: string, patch: Parameters<typeof api.vectors.updateSettings>[1]) =>
    act(what, async () => onSettings(await api.vectors.updateSettings(index.name, patch)));

  const opts = settings.auto_embed_options;
  const optionSummary = !opts
    ? "default settings (parse chunks, no header, no filtering, no tags)"
    : [
        opts.chunking === "custom" ? `re-chunked at ${opts.max_chars} chars, ${opts.overlap} overlap` : "parse chunks",
        opts.context_header && "contextual header",
        opts.dedupe && "repeated chunks left out",
        opts.min_chars > 0 && `chunks under ${opts.min_chars} chars left out`,
        Object.keys(opts.metadata).length > 0 && `tags ${Object.entries(opts.metadata).map(([k, v]) => `${k}=${v}`).join(", ")}`,
      ]
        .filter(Boolean)
        .join(" · ");
  const tiers = app?.tiers ?? [];
  const pct = settings.budget_usd ? Math.min(1, settings.spent_usd / settings.budget_usd) : 0;
  const targets = indexes.filter((i) => i.name !== index.name && i.model);

  return (
    <div className="divide-y divide-line">
      {(error || message) && (
        <p className={`px-4 py-2 text-xs ${error ? "text-bad" : "text-ok"}`}>
          {error ?? message}
        </p>
      )}

      {/* ---------------------------------------------------------- auto-embed */}
      <Row
        title="Auto-embed new parses"
        note="Every document parsed from now on is embedded into this index as soon as its parse completes. Off by default."
        control={<Toggle on={settings.auto_embed} disabled={busy === "auto"} onChange={(v) => save("auto", { auto_embed: v })} />}
      >
        {settings.auto_embed && (
          <div className="mt-3 space-y-2 text-xs">
            <div>
              <span className="text-soft">Tiers: </span>
              <span className="inline-flex flex-wrap gap-1 align-middle">
                {tiers.map((t) => {
                  const on = settings.auto_embed_tiers.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() =>
                        save("tiers", {
                          auto_embed_tiers: on ? settings.auto_embed_tiers.filter((x) => x !== t.id) : [...settings.auto_embed_tiers, t.id],
                        })
                      }
                      className={`rounded-full border px-2 py-0.5 ${on ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-muted hover:text-white"}`}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </span>
              <span className="ml-2 text-muted">
                {settings.auto_embed_tiers.length ? "only these tiers" : "none picked = every tier"}
              </span>
            </div>
            <div className="text-muted">
              With: <span className="text-soft">{optionSummary}</span>. To change these, embed documents from the Parse tab with
              &ldquo;Auto-embed future parses&rdquo; ticked.
            </div>
          </div>
        )}
      </Row>

      {/* ---------------------------------------------------------- budget */}
      <Row
        title="Spending limit"
        note="Embedding, queries and AI re-ranking are paid to OpenRouter. With a limit, runs that would go over it are refused, and a run stops when the limit is reached."
        control={
          <span className="text-right text-xs">
            <span className="block text-base font-semibold tabular-nums">{usd(settings.spent_usd)}</span>
            <span className="text-muted">{settings.budget_usd != null ? `of ${usd(settings.budget_usd)}` : "spent · no limit"}</span>
          </span>
        }
      >
        {settings.budget_usd != null && (
          <div className="mt-2 h-1.5 rounded-full bg-line">
            <div className={`h-full rounded-full ${pct >= 1 ? "bg-bad" : pct > 0.8 ? "bg-sand" : "bg-ocean"}`} style={{ width: `${pct * 100}%` }} />
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-soft">Limit</span>
          <span className="relative">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted">$</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={budget ?? (settings.budget_usd ?? "")}
              placeholder="none"
              onChange={(e) => setBudget(e.target.value)}
              className={`${selectClass} w-28 py-1 pl-5 font-mono text-xs`}
            />
          </span>
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={budget == null || busy === "budget" || (budget !== "" && !(Number(budget) >= 0))}
            onClick={() => save("budget", { budget_usd: budget === "" ? null : Number(budget) }).then(() => setBudget(null))}
          >
            Save
          </button>
          {settings.budget_usd != null && (
            <button type="button" className={buttonClass.ghost} onClick={() => save("budget", { budget_usd: null }).then(() => setBudget(null))}>
              Remove limit
            </button>
          )}
          <button
            type="button"
            className={`${buttonClass.ghost} ml-auto`}
            onClick={async () => (await confirmDialog(`Count spending on ${index.name} from $0 again?`)) && save("reset", { reset_spent: true })}
          >
            <Icon name="refresh" className="h-3.5 w-3.5" /> Reset counter
          </button>
        </div>
      </Row>

      {/* ---------------------------------------------------------- retry */}
      <Row
        title="Auto-retry failed runs"
        note="Every 10 minutes, failed embedding runs are run again with their own settings, up to 3 times each. Runs stopped by the spending limit are left alone."
        control={<Toggle on={settings.auto_retry} disabled={busy === "retry-toggle"} onChange={(v) => save("retry-toggle", { auto_retry: v })} />}
      >
        <button
          type="button"
          className={`${buttonClass.secondary} mt-3`}
          disabled={!failed || !index.model || busy === "retry"}
          onClick={() =>
            act("retry", async () => {
              const rows = await api.vectors.retry(index.name);
              setMessage(`Retrying ${rows.length} run${rows.length === 1 ? "" : "s"}.`);
              onChanged();
            })
          }
        >
          <Icon name="refresh" className="h-3.5 w-3.5" /> Retry failed now{failed ? ` (${failed})` : ""}
        </button>
      </Row>

      {/* ---------------------------------------------------------- copy */}
      <Row
        title="Re-embed into another index"
        note="For moving to another embedding model or dimension: every document in this index is embedded into the target with the settings it was embedded with here. This index stays as it is."
      >
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <select value={target} onChange={(e) => setTarget(e.target.value)} className={`${selectClass} py-1 text-xs`}>
            <option value="">Choose target index…</option>
            {targets.map((i) => (
              <option key={i.name} value={i.name}>
                {i.name} · {i.model} · {i.dimension}d · {i.metric}
              </option>
            ))}
          </select>
          <button type="button" className={buttonClass.ghost} onClick={() => setCreating(true)}>
            <Icon name="plus" className="h-3.5 w-3.5" /> New index
          </button>
          <button
            type="button"
            className={`${buttonClass.primary} ml-auto`}
            disabled={!target || !documents || busy === "copy"}
            onClick={async () =>
              (await confirmDialog(`Embed all ${documents} documents of ${index.name} into ${target}? Documents already there are replaced.`)) &&
              act("copy", async () => {
                const res = await api.vectors.copyTo(index.name, target);
                setMessage(`Embedding ${res.started} documents into ${res.target}; follow it in that index's Documents tab.`);
                onChanged();
              })
            }
          >
            <Icon name="sparkle" className="h-3.5 w-3.5" /> Re-embed {documents} documents
          </button>
        </div>
      </Row>

      {/* ---------------------------------------------------------- keys */}
      <SearchKeys index={index} keys={settings.keys} onChanged={() => api.vectors.settings(index.name).then(onSettings)} />

      {creating && (
        <CreateIndexDialog
          config={config}
          taken={indexes.map((i) => i.name)}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setTarget(created.name);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function SearchKeys({ index, keys, onChanged }: { index: VectorIndex; keys: SearchKey[]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [filter, setFilter] = useState("");
  const [created, setCreated] = useState<{ key: SearchKey; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const parsed = parseFilter(filter);

  const create = async () => {
    setError(null);
    try {
      setCreated(await api.vectors.createKey(index.name, name.trim(), parsed ?? {}));
      setName("");
      setFilter("");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const revoke = async (k: SearchKey) => {
    if (!(await confirmDialog(`Revoke "${k.name}"? Apps using it stop working immediately.`))) return;
    try {
      await api.vectors.revokeKey(index.name, k.id);
      onChanged();
    } catch (e) {
      void alertDialog((e as Error).message);
    }
  };

  const curl = created
    ? `curl -X POST ${API_URL}/api/vectors/v1/search \\\n  -H "Authorization: Bearer ${created.token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"q": "your question", "top_k": 5, "mode": "hybrid"}'`
    : "";

  return (
    <Row
      title="Search keys"
      note="For other applications: a key searches only this index through /api/vectors/v1/search, and its filter is always applied by the server. A request can narrow results further but never see past the key, so a key with tenant=acme only ever returns acme's documents."
    >
      {created && (
        <div className="mt-3 rounded-lg border border-ok/40 bg-ok/10 p-3 text-xs">
          <div className="mb-1 font-medium text-ok">Key &ldquo;{created.key.name}&rdquo; created. Copy it now: it won&apos;t be shown again.</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-ink px-2 py-1 font-mono text-[11px]">{created.token}</code>
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => {
                navigator.clipboard.writeText(created.token).then(() => setCopied(true));
              }}
            >
              <Icon name={copied ? "check" : "copy"} className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" className="text-muted hover:text-white" onClick={() => setCreated(null)} title="Hide">
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          </div>
          <pre className="mt-2 overflow-x-auto rounded bg-ink px-2 py-1.5 font-mono text-[10.5px] text-soft">{curl}</pre>
        </div>
      )}

      {keys.length > 0 && (
        <table className="mt-3 w-full text-xs">
          <thead className="text-left text-muted">
            <tr>
              {["Name", "Key", "Filter (enforced)", "Created", "Last used", ""].map((h) => (
                <th key={h} className="py-1 pr-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className="border-t border-line">
                <td className="py-1.5 pr-3">{k.name}</td>
                <td className="py-1.5 pr-3 font-mono text-muted">{k.prefix}…</td>
                <td className="py-1.5 pr-3 font-mono">
                  {Object.keys(k.filter).length ? (
                    Object.entries(k.filter).map(([a, b]) => `${a}=${b}`).join(", ")
                  ) : (
                    <span className="text-sand">none: the whole index</span>
                  )}
                </td>
                <td className="whitespace-nowrap py-1.5 pr-3 text-soft">{when(k.created_at)}</td>
                <td className="whitespace-nowrap py-1.5 pr-3 text-soft">{k.last_used_at ? when(k.last_used_at) : "never"}</td>
                <td className="py-1.5 text-right">
                  <button type="button" onClick={() => revoke(k)} className="rounded p-1 text-muted hover:bg-bad/10 hover:text-bad" title="Revoke">
                    <Icon name="trash" className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name, e.g. Acme chatbot" className={`${selectClass} w-52 py-1 text-xs`} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="tenant=acme, access_level=internal"
          className={`${selectClass} w-72 py-1 font-mono text-xs`}
        />
        <button type="button" className={buttonClass.secondary} disabled={!name.trim() || !parsed || !index.model} onClick={create}>
          <Icon name="plus" className="h-3.5 w-3.5" /> Create key
        </button>
        {!parsed && <span className="text-xs text-bad">Write the filter as key=value, separated by commas.</span>}
        {parsed && !Object.keys(parsed).length && name.trim() && (
          <span className="text-xs text-sand">Without a filter the key can search everything in the index.</span>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
    </Row>
  );
}

function Row({ title, note, control, children }: { title: string; note: string; control?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className="px-4 py-4">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{title}</div>
          <p className="mt-0.5 max-w-2xl text-xs text-soft">{note}</p>
        </div>
        {control}
      </div>
      {children}
    </section>
  );
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-ocean" : "bg-line-2"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}
