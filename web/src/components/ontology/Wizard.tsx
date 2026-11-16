"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { TypeIcon } from "@/components/ontology/Datasources";
import { Modal } from "@/components/pipeline/Modal";
import type { ObjectType, Property } from "@/lib/ontology";
import { typeIcon } from "@/lib/ontology";

/* The frame of the Ontology Manager's creation wizards (object type, link type): numbered steps on the left, the
   current step's title and body on the right, Back / Next / Create at the bottom. */

export function WizardShell({
  title,
  icon,
  steps,
  step,
  onStep,
  canVisit,
  children,
  footer,
  onClose,
}: {
  title: string;
  icon: Parameters<typeof Icon>[0]["name"];
  steps: string[];
  step: number;
  onStep: (i: number) => void;
  canVisit: (i: number) => boolean;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal title={title} icon={icon} onClose={onClose} xl>
      <div className="grid min-h-[480px] md:grid-cols-[200px_minmax(0,1fr)]">
        <ol className="border-b border-line bg-panel-2/30 p-3 md:border-b-0 md:border-r">
          {steps.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                disabled={!canVisit(i)}
                onClick={() => onStep(i)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm disabled:cursor-not-allowed ${i === step ? "bg-ocean/15 text-white" : "text-muted hover:text-soft disabled:hover:text-muted"}`}
                data-wizard-step={i}
              >
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${i < step ? "bg-ok/25 text-ok" : i === step ? "bg-ocean text-white" : "bg-panel-2 text-muted"}`}>
                  {i < step ? <Icon name="check" className="h-3 w-3" /> : i + 1}
                </span>
                {s}
              </button>
            </li>
          ))}
        </ol>
        <div className="flex min-h-0 flex-col">
          <div className="max-h-[64vh] min-h-0 flex-1 overflow-y-auto p-5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Step {step + 1}</div>
            <h3 className="mb-4 text-lg font-semibold text-white">{steps[step]}</h3>
            {children}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
        </div>
      </div>
    </Modal>
  );
}

/** The English plural of a display name, keeping a trailing "(…)" after it: "Flight Alert (test)" → "Flight Alerts (test)". */
export function pluralOf(name: string): string {
  const m = name.trim().match(/^(.*?)(\s*\([^)]*\))?$/);
  const base = (m?.[1] ?? name).trim();
  const tail = m?.[2] ?? "";
  if (!base) return name;
  const plural = /(s|x|z|ch|sh)$/i.test(base) ? `${base}es` : /[^aeiou]y$/i.test(base) ? `${base.slice(0, -1)}ies` : `${base}s`;
  return `${plural}${tail}`;
}

/** A searchable object type picker: icon, name and object count. */
export function TypePicker({ types, value, onChange, placeholder = "Select object type", exclude }: { types: ObjectType[]; value: string; onChange: (id: string) => void; placeholder?: string; exclude?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const t = types.find((x) => x.id === value);
  // test object types ("(test)") last: they stay pickable
  const isTest = (x: ObjectType) => /\(test\)/i.test(x.display_name);
  const list = types
    .filter((x) => x.id !== exclude && (!q || x.display_name.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => Number(isTest(a)) - Number(isTest(b)))
    .slice(0, 200);
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded-md border border-line-2 bg-ink px-2.5 py-1.5 text-left text-sm hover:border-ocean/60" data-type-picker>
        {t ? <TypeIcon t={t} className="h-3.5 w-3.5" box="rounded p-0.5" /> : <Icon name="cube" className="h-3.5 w-3.5 text-muted" />}
        <span className={`min-w-0 flex-1 truncate ${t ? "text-white" : "text-muted"}`}>{t?.display_name ?? placeholder}</span>
        <Icon name="down" className="h-3 w-3 text-muted" />
      </button>
      {open && (
        <div className="absolute left-0 z-40 mt-1 w-full min-w-[18rem] overflow-hidden rounded-xl border border-line-2 bg-panel shadow-2xl">
          <div className="border-b border-line p-2">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-full rounded-md bg-panel-2 px-2 py-1.5 text-xs outline-none" />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {list.map((x) => (
              <button key={x.id} type="button" onClick={() => (onChange(x.id), setOpen(false), setQ(""))} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-panel-2" data-type-option={x.display_name}>
                <TypeIcon t={x} className="h-3.5 w-3.5" box="rounded p-0.5" />
                <span className="min-w-0 flex-1 truncate text-soft">{x.display_name}</span>
                <span className="text-[10px] text-muted">{(x.object_count ?? 0).toLocaleString()}</span>
              </button>
            ))}
            {!list.length && <p className="px-3 py-2 text-xs text-muted">No object type matches.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** A property picker with the property type icon. */
export function PropertyPicker({ props, value, onChange, placeholder = "Select a property" }: { props: Property[]; value: string; onChange: (api: string) => void; placeholder?: string }) {
  const p = props.find((x) => x.api_name === value);
  return (
    <div className="relative flex items-center">
      <Icon name={p ? typeIcon(p.type) : "doc"} className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted" />
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full appearance-none rounded-md border border-line-2 bg-ink py-1.5 pl-8 pr-6 text-sm outline-none hover:border-ocean/60">
        <option value="">{placeholder}</option>
        {props.map((x) => (
          <option key={x.api_name} value={x.api_name}>
            {x.display_name || x.api_name}
          </option>
        ))}
      </select>
      <Icon name="down" className="pointer-events-none absolute right-2 h-3 w-3 text-muted" />
    </div>
  );
}
