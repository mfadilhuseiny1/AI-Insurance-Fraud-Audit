"use client";

import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { COMMON_DATE_FORMATS, compileDateFormat, rankDateFormats } from "@/lib/pipeline";
import { Icon } from "../Icon";
import { inputClass } from "./Modal";

const FALLBACK_ZONES = ["UTC", "Asia/Jakarta", "Asia/Singapore", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles"];

export function timeZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? FALLBACK_ZONES;
  } catch {
    return FALLBACK_ZONES;
  }
}

export function TimezoneField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const zones = useMemo(() => timeZones(), []);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
      <option value="">Select a value (defaults to UTC)</option>
      {value && !zones.includes(value) && <option value={value}>{value}</option>}
      {zones.map((z) => (
        <option key={z}>{z}</option>
      ))}
    </select>
  );
}

const SYMBOLS: [string, string, string][] = [
  ["yyyy / yy", "year", "2024 / 24"],
  ["MM / MMM / MMMM", "month", "01 / Jan / January"],
  ["dd / d", "day of month", "05 / 5"],
  ["EEE / EEEE", "day of week (ignored)", "Thu / Thursday"],
  ["HH / H", "hour 0–23", "07 / 7"],
  ["hh / h + a", "hour 1–12 with AM/PM", "07 PM"],
  ["mm", "minute", "21"],
  ["ss", "second", "01"],
  ["SSS", "fraction of a second", "678"],
  ["Z / XXX", "offset", "+0100 / +01:00 / Z"],
  ["z / zzzz", "zone name (offset taken from Z or the time zone)", "GMT / Greenwich Mean Time"],
  ["'text'", "literal text", "'T' 'GMT'"],
];

/** Choose formats greedily: each added format must parse samples the earlier ones could not. */
function cover(candidates: string[], samples: string[], max = 3): string[] {
  const chosen: string[] = [];
  let left = samples;
  for (const { format } of rankDateFormats(candidates, samples)) {
    if (!left.length || chosen.length >= max) break;
    const parse = compileDateFormat(format);
    const parsed = left.filter((s) => parse(s));
    if (!parsed.length) continue;
    chosen.push(format);
    left = left.filter((s) => !parse(s));
  }
  return chosen;
}

export function FormatsField({
  value,
  samples,
  type,
  onChange,
  onSuggest,
}: {
  value: string[];
  /** distinct sample values of the column being cast */
  samples: string[];
  type: "Date" | "Timestamp";
  onChange: (v: string[]) => void;
  /** generated formats, with the time zone the AI suggested (if any) */
  onSuggest: (formats: string[], zone: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [symbols, setSymbols] = useState(false);

  const stats = useMemo(() => {
    const parsers = value.map((f) => {
      if (!f.trim()) return null;
      try {
        return compileDateFormat(f);
      } catch (e) {
        return (e as Error).message;
      }
    });
    const matches = parsers.map((p) => (typeof p === "function" ? samples.filter((s) => p(s)).length : null));
    const all = samples.filter((s) => parsers.some((p) => typeof p === "function" && p(s))).length;
    return { parsers, matches, all };
  }, [value, samples]);

  const generate = async () => {
    setBusy(true);
    setNote(null);
    try {
      const ai = await api.suggestDatetimeFormats(samples, type);
      const usable = cover(ai.formats, samples);
      if (!usable.length) throw new Error("the suggested formats did not match the data");
      onSuggest(usable, ai.timezone);
      setNote({ text: `✨ Suggested by AI${ai.timezone ? ` · time zone ${ai.timezone}` : ""}` });
    } catch (e) {
      const local = cover(COMMON_DATE_FORMATS, samples);
      if (local.length) {
        onSuggest(local, null);
        setNote({ text: `AI unavailable (${(e as Error).message}) — picked from common formats instead.` });
      } else setNote({ text: `AI unavailable (${(e as Error).message}) and no common format matches — enter one by hand.`, bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <p className="rounded-md bg-ocean/10 px-2.5 py-2 text-xs text-soft ring-1 ring-ocean/30">
        Casting strings to a {type.toLowerCase()} needs the format they are written in, e.g. &quot;2020-10-05&quot; is{" "}
        <code className="text-white">yyyy-MM-dd</code>. With several formats the first that matches is used; values no format
        matches become null.
      </p>
      {value.map((f, i) => {
        const p = stats.parsers[i];
        const m = stats.matches[i];
        return (
          <div key={i} className="flex items-center gap-1.5">
            <input
              value={f}
              onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))}
              placeholder="e.g. yyyy-MM-dd'T'HH:mm:ss.SSSXXX"
              spellCheck={false}
              className={`${inputClass} font-mono ${typeof p === "string" ? "border-bad/60" : ""}`}
            />
            {m !== null && samples.length > 0 && (
              <span
                title={`Parses ${m} of ${samples.length} sample values`}
                className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] tabular-nums ${m ? "bg-ok/15 text-ok" : "bg-bad/10 text-bad"}`}
              >
                {m}/{samples.length}
              </span>
            )}
            <button
              type="button"
              title="Remove"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className="rounded p-1 text-muted hover:bg-bad/10 hover:text-bad"
            >
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      {stats.parsers.map((p, i) => typeof p === "string" && <p key={i} className="text-xs text-bad">{p}</p>)}

      <div className="flex items-center gap-2 text-xs">
        <button type="button" onClick={() => setSymbols(!symbols)} className="text-ocean underline decoration-dotted underline-offset-2">
          View available format symbols
        </button>
        {value.some((f) => f.trim()) && samples.length > 0 && (
          <span className={stats.all === samples.length ? "text-ok" : "text-warn"}>
            Parses {stats.all} of {samples.length} sample values
          </span>
        )}
      </div>
      {symbols && (
        <table className="w-full text-xs">
          <tbody>
            {SYMBOLS.map(([sym, what, eg]) => (
              <tr key={sym} className="border-t border-line">
                <td className="py-1 pr-3 font-mono text-white">{sym}</td>
                <td className="py-1 pr-3 text-soft">{what}</td>
                <td className="py-1 font-mono text-muted">{eg}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex items-center justify-center border-t border-line pt-1.5">
        <div className="flex overflow-hidden rounded-md border border-line-2 text-xs">
          <button type="button" onClick={() => onChange([...value, ""])} className="flex items-center gap-1 px-2.5 py-1 text-soft hover:bg-panel-2 hover:text-white">
            <Icon name="plus" className="h-3.5 w-3.5" /> Add value
          </button>
          <button
            type="button"
            disabled={!value.length}
            onClick={() => onChange([])}
            className="border-l border-line-2 px-2.5 py-1 text-soft hover:bg-panel-2 hover:text-white disabled:opacity-40"
          >
            Clear all
          </button>
          <button
            type="button"
            disabled={busy || !samples.length}
            title={samples.length ? "Suggest formats from the column's values with AI" : "Choose a column with text values first"}
            onClick={generate}
            className="flex items-center gap-1 border-l border-line-2 px-2.5 py-1 text-ocean hover:bg-panel-2 disabled:opacity-40"
          >
            <Icon name="sparkle" className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Generating…" : "Generate"}
          </button>
        </div>
      </div>
      {note && <p className={`text-xs ${note.bad ? "text-bad" : "text-muted"}`}>{note.text}</p>}
    </div>
  );
}
