"use client";

/** A media set's access patterns and their persistence policies (media set settings): the built-in patterns of
 *  its schema and the ones registered by API, each persisted, cached for a time or recomputed at every request. */
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ErrorBox } from "@/components/ontology/parts";
import { buttonClass, fieldClass } from "@/components/pipeline/Modal";
import { Loading } from "@/components/States";
import { confirmDialog } from "@/lib/dialogs";
import { API_URL } from "@/lib/api";
import { mediaSets, type AccessPatterns, type PatternParams, type Persistence, type PersistencePolicy } from "@/lib/mediaSets";

const UNITS = [
  ["seconds", 1],
  ["minutes", 60],
  ["hours", 3600],
  ["days", 86400],
] as const;
const POLICY_LABEL: Record<PersistencePolicy, string> = {
  persist: "Persist after first request",
  cache: "Cache for a time",
  recompute: "Recompute at every request",
};

export function AccessPatternsSection({ setId, schema }: { setId: string; schema: string }) {
  const [data, setData] = useState<AccessPatterns | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    mediaSets.accessPatterns(setId).then(setData, (e: Error) => setError(e.message));
  }, [setId]);
  useEffect(load, [load]);
  const save = async (name: string, persistence: Persistence) => {
    setError(null);
    try {
      setData(await mediaSets.updatePattern(setId, name, { persistence }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (name: string) => {
    if (!(await confirmDialog(`Remove the access pattern ${name}? Its stored outputs are dropped.`))) return;
    try {
      await mediaSets.removePattern(setId, name);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const example = data?.builtin.find((b) => b.pattern === "audio") ? { pattern: "audio", params: { channel: "0", format: "mp3" } } : { pattern: data?.builtin[0]?.pattern ?? "thumbnail", params: { width: 640 } };
  return (
    <section className="space-y-2">
      <h2 className="font-semibold">Access patterns</h2>
      <p className="text-xs text-muted">
        Transformations computed on request (previews, page renders, waveforms, {schema === "audio" || schema === "video" || schema === "multimodal" ? "channels, transcripts, HLS segments, " : ""}…). Each has a
        persistence policy: persist its output after the first request, cache it for a time, or recompute it at every request (never stored). Changing a policy drops the outputs stored so
        far.
      </p>
      <ErrorBox message={error} />
      {!data ? (
        <Loading />
      ) : (
        <div className="divide-y divide-line rounded-md border border-line-2">
          {data.builtin.map((b) => (
            <PatternRow key={`${b.pattern}:${b.persistence.policy}:${b.persistence.ttl_seconds}`} name={b.pattern} title={b.label} detail="Built-in" persistence={b.persistence} onSave={(p) => save(b.pattern, p)} />
          ))}
          {data.registered.map((r) => (
            <PatternRow
              key={`${r.name}:${r.persistence.policy}:${r.persistence.ttl_seconds}`}
              name={r.name}
              title={r.name}
              detail={`Registered · ${r.pattern}${paramText(r.params)}`}
              persistence={r.persistence}
              onSave={(p) => save(r.name, p)}
              onRemove={() => remove(r.name)}
            />
          ))}
        </div>
      )}
      <details className="text-xs text-muted">
        <summary className="cursor-pointer text-soft">Register an access pattern (API)</summary>
        <p className="mt-1">More patterns — a built-in transformation with fixed parameters under a name — are registered by API call, then read like the built-in ones:</p>
        <pre className="mt-1 overflow-x-auto rounded bg-ink p-2 text-[11px] text-soft">{`POST ${API_URL}/api/media-sets/${setId}/access-patterns
${JSON.stringify({ name: "my_pattern", ...example, persistence: { policy: "cache", ttl_seconds: 3600 } }, null, 2)}

GET ${API_URL}/api/media-sets/items/<media item>/access/my_pattern${data?.builtin.some((b) => b.pattern === "hls") ? `\nGET ${API_URL}/api/media-sets/items/<media item>/hls/playlist.m3u8?pattern=<an hls pattern>` : ""}`}</pre>
      </details>
    </section>
  );
}

function paramText(p: PatternParams) {
  const parts = Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => (k === "channel" ? (v === "mix" ? "mix-down" : v === "all" ? "all channels" : `channel ${Number(v) + 1}`) : `${k.replace("_", " ")} ${v}`));
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function splitTtl(s: number | null): [string, number] {
  if (!s) return ["", 3600];
  const unit = [...UNITS].reverse().find(([, n]) => s % n === 0) ?? UNITS[0];
  return [String(s / unit[1]), unit[1]];
}

function PatternRow({
  name,
  title,
  detail,
  persistence,
  onSave,
  onRemove,
}: {
  name: string;
  title: string;
  detail: string;
  persistence: Persistence;
  onSave: (p: Persistence) => Promise<void>;
  onRemove?: () => void;
}) {
  const [policy, setPolicy] = useState<PersistencePolicy>(persistence.policy);
  const [ttl, setTtl] = useState(splitTtl(persistence.ttl_seconds)[0]);
  const [unit, setUnit] = useState<number>(splitTtl(persistence.ttl_seconds)[1]);
  const [busy, setBusy] = useState(false);
  const seconds = policy === "cache" && ttl ? Math.round(Number(ttl) * unit) : null;
  const dirty = policy !== persistence.policy || (policy === "cache" && seconds !== persistence.ttl_seconds);
  const valid = policy !== "cache" || (seconds !== null && seconds >= 1);
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
      <div className="min-w-40 flex-1">
        <div className="font-medium text-soft">{title}</div>
        <div className="text-muted">
          {detail}
          {name !== title ? ` · ${name}` : ""}
        </div>
      </div>
      <select aria-label={`Persistence policy of ${name}`} value={policy} onChange={(e) => setPolicy(e.target.value as PersistencePolicy)} className={`${fieldClass} py-1 text-xs`}>
        {(Object.keys(POLICY_LABEL) as PersistencePolicy[]).map((p) => (
          <option key={p} value={p}>
            {POLICY_LABEL[p]}
          </option>
        ))}
      </select>
      {policy === "cache" && (
        <span className="flex items-center gap-1">
          <input
            type="number"
            min={1}
            step="any"
            aria-label={`Cache time of ${name}`}
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
            placeholder="1"
            className={`${fieldClass} w-16 py-1 text-xs`}
          />
          <select aria-label={`Cache time unit of ${name}`} value={unit} onChange={(e) => setUnit(Number(e.target.value))} className={`${fieldClass} py-1 text-xs`}>
            {UNITS.map(([l, n]) => (
              <option key={l} value={n}>
                {l}
              </option>
            ))}
          </select>
        </span>
      )}
      <button
        type="button"
        disabled={!dirty || !valid || busy}
        onClick={async () => {
          setBusy(true);
          await onSave({ policy, ttl_seconds: seconds });
          setBusy(false);
        }}
        className={`${buttonClass.secondary} px-2 py-1 text-xs`}
      >
        Save
      </button>
      {onRemove && (
        <button type="button" onClick={onRemove} className="text-muted hover:text-bad" aria-label={`Remove ${name}`}>
          <Icon name="trash" className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
