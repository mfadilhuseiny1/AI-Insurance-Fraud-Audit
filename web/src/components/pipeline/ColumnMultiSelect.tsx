"use client";

import { useEffect, useRef, useState } from "react";
import { COL_TYPES, type ColType, type Column } from "@/lib/pipeline";
import { Icon } from "../Icon";
import { TYPE_MARK } from "./DataPreview";

const toggleClass = (on: boolean) =>
  `flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${
    on ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-soft hover:border-ocean/50"
  }`;

/** Chips + search with a checklist of columns: type filter, selected / not selected, select all. */
export function ColumnMultiSelect({
  value,
  columns,
  onChange,
  placeholder = "Search columns…",
}: {
  /** selected column names, in the order chosen */
  value: string[];
  columns: Column[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<ColType[]>([]);
  const [show, setShow] = useState<"all" | "selected" | "unselected">("all");

  useEffect(() => {
    if (!open && !typesOpen) return;
    const close = (e: MouseEvent) => {
      if (box.current?.contains(e.target as Node)) return;
      setOpen(false);
      setTypesOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open, typesOpen]);

  const selected = new Set(value);
  const typeOf = (name: string) => columns.find((c) => c.name === name)?.type;
  const presentTypes = COL_TYPES.filter((t) => columns.some((c) => c.type === t));
  const visible = columns.filter(
    (c) =>
      c.name.toLowerCase().includes(query.toLowerCase()) &&
      (!types.length || types.includes(c.type)) &&
      (show === "all" || (show === "selected") === selected.has(c.name)),
  );

  const toggle = (name: string) => onChange(selected.has(name) ? value.filter((n) => n !== name) : [...value, name]);

  return (
    <div ref={box} className="relative">
      <div
        onClick={() => {
          setOpen(true);
          input.current?.focus();
        }}
        className={`flex min-h-8 cursor-text flex-wrap items-center gap-1.5 rounded-md border bg-ink px-1.5 py-1 ${
          open ? "border-ocean" : "border-line-2 hover:border-ocean/50"
        }`}
      >
        {value.map((name, i) => {
          const type = typeOf(name);
          return (
            <span
              key={`${i}:${name}`}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ring-1 ${
                type ? "bg-panel-2 ring-line-2" : "bg-bad/10 text-bad ring-bad/40"
              }`}
              title={type ? type : "Column not found"}
            >
              <span className="font-mono text-[10px] text-muted">{type ? TYPE_MARK[type] : "?"}</span>
              {name}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((n) => n !== name));
                }}
                className="text-muted hover:text-white"
              >
                <Icon name="x" className="h-3 w-3" />
              </button>
            </span>
          );
        })}
        <input
          ref={input}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !query && value.length) onChange(value.slice(0, -1));
            if (e.key === "Enter" && visible[0]) {
              e.preventDefault();
              toggle(visible[0].name);
              setQuery("");
            }
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder={value.length ? "" : placeholder}
          className="min-w-24 flex-1 bg-transparent px-1 text-xs outline-none placeholder:text-muted"
        />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setTypesOpen(!typesOpen);
            setOpen(false);
          }}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${types.length ? "text-ocean" : "text-muted hover:text-white"}`}
        >
          {types.length ? `${types.length} type${types.length > 1 ? "s" : ""}` : "Select types"}
          <Icon name="down" className="h-3 w-3" />
        </button>
        {value.length > 0 && (
          <button
            type="button"
            title="Clear selection"
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
            className="rounded p-0.5 text-muted hover:text-white"
          >
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {typesOpen && (
        <div className="absolute right-0 top-full z-30 mt-1 w-44 rounded-lg border border-line-2 bg-panel-2 py-1 text-xs shadow-xl">
          {presentTypes.map((t) => (
            <label key={t} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-panel">
              <input
                type="checkbox"
                checked={types.includes(t)}
                onChange={(e) => setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))}
                className="accent-[var(--color-ocean)]"
              />
              <span className="w-7 font-mono text-[10px] text-muted">{TYPE_MARK[t]}</span>
              {t}
            </label>
          ))}
          {types.length > 0 && (
            <button type="button" onClick={() => setTypes([])} className="w-full px-3 py-1.5 text-left text-ocean hover:bg-panel">
              Any type
            </button>
          )}
        </div>
      )}

      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-line-2 bg-panel-2 shadow-xl">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-2.5 py-1.5 text-xs">
            <span className="font-medium">
              {value.filter((n) => typeOf(n)).length} of {columns.length} columns selected
            </span>
            <button type="button" onClick={() => setShow(show === "selected" ? "all" : "selected")} className={toggleClass(show === "selected")}>
              <Icon name="check" className="h-3 w-3" /> Selected
            </button>
            <button
              type="button"
              onClick={() => setShow(show === "unselected" ? "all" : "unselected")}
              className={toggleClass(show === "unselected")}
            >
              <Icon name="x" className="h-3 w-3" /> Not selected
            </button>
            <span className="ml-auto flex overflow-hidden rounded border border-line-2">
              <button
                type="button"
                onClick={() => onChange([...value, ...visible.map((c) => c.name).filter((n) => !selected.has(n))])}
                className="px-2 py-0.5 text-ocean hover:bg-panel"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => {
                  const hide = new Set(visible.map((c) => c.name));
                  onChange(value.filter((n) => !hide.has(n)));
                }}
                className="border-l border-line-2 px-2 py-0.5 text-ocean hover:bg-panel"
              >
                Deselect all
              </button>
            </span>
          </div>
          <ul className="max-h-64 overflow-y-auto py-1 text-xs">
            {visible.length === 0 && <li className="px-3 py-2 text-muted">No matching columns.</li>}
            {visible.map((c) => {
              const on = selected.has(c.name);
              return (
                <li key={c.name}>
                  <button
                    type="button"
                    onClick={() => toggle(c.name)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel ${on ? "bg-ocean/10 text-ocean" : "text-soft"}`}
                  >
                    <span className="truncate">{c.name}</span>
                    <span className="ml-auto rounded bg-panel px-1.5 py-0.5 text-[10px] text-muted ring-1 ring-line-2">{c.type}</span>
                    <Icon name="check" className={`h-3.5 w-3.5 shrink-0 ${on ? "" : "invisible"}`} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
