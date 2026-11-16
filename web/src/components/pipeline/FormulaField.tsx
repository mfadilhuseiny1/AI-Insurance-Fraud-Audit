"use client";

import { useRef, useState } from "react";
import { FORMULA_FUNCTIONS, type Column } from "@/lib/pipeline";
import { TYPE_MARK } from "./DataPreview";
import { inputClass } from "./Modal";

const NUMERIC = new Set(["Integer", "Double"]);

/** Formula editor: monospace input plus chips that insert columns and functions at the cursor. */
export function FormulaField({
  value,
  columns,
  placeholder,
  onChange,
}: {
  value: string;
  columns: Column[];
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [showAll, setShowAll] = useState(false);

  const insert = (text: string, cursorBack = 0) => {
    const el = input.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + text.length - cursorBack;
      el.setSelectionRange(pos, pos);
    });
  };

  // numeric columns first; text columns still work when their values are numbers
  const ordered = [...columns].sort((a, b) => Number(NUMERIC.has(b.type)) - Number(NUMERIC.has(a.type)));
  const shown = showAll ? ordered : ordered.slice(0, 12);

  return (
    <div className="space-y-1.5">
      <textarea
        ref={input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        spellCheck={false}
        placeholder={placeholder}
        className={`${inputClass} font-mono`}
      />
      <div className="flex flex-wrap items-center gap-1 text-[11px]">
        <span className="mr-0.5 text-muted">Columns</span>
        {shown.map((c) => (
          <button
            key={c.name}
            type="button"
            title={`${c.type} — click to insert`}
            onClick={() => insert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name) ? c.name : `\`${c.name}\``)}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 ring-1 hover:ring-ocean ${
              NUMERIC.has(c.type) ? "bg-panel-2 ring-line-2" : "bg-panel-2/50 text-muted ring-line"
            }`}
          >
            <span className="font-mono text-[9px] text-muted">{TYPE_MARK[c.type]}</span>
            {c.name}
          </button>
        ))}
        {ordered.length > 12 && (
          <button type="button" onClick={() => setShowAll(!showAll)} className="px-1 text-ocean hover:underline">
            {showAll ? "fewer" : `+${ordered.length - 12} more`}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[11px]">
        <span className="mr-0.5 text-muted">Functions</span>
        {Object.entries(FORMULA_FUNCTIONS).map(([name, fn]) => (
          <button
            key={name}
            type="button"
            title={fn.help}
            onClick={() => insert(`${name}()`, 1)}
            className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-sand ring-1 ring-line-2 hover:ring-ocean"
          >
            {name}
          </button>
        ))}
        {["^", "pi", "e"].map((s) => (
          <button
            key={s}
            type="button"
            title={s === "^" ? "power, e.g. x^2" : s === "pi" ? "π" : "Euler's number"}
            onClick={() => insert(s)}
            className="rounded bg-panel-2 px-1.5 py-0.5 font-mono ring-1 ring-line-2 hover:ring-ocean"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
