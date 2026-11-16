"use client";

import { useMemo, useState } from "react";
import type { DictionaryEntry } from "@/lib/pipeline";
import { Icon } from "../Icon";
import { Modal, inputClass } from "./Modal";
import { Switch } from "./ui";

/**
 * The pipeline's data dictionary: every column it knows, what it means, where it comes from and how the source
 * anonymized it. Opened from a node, it starts on that node's columns; a search covers names, meanings and notes.
 */
export function DictionaryDialog({
  dictionary,
  columns,
  nodeName,
  onClose,
}: {
  dictionary: Record<string, DictionaryEntry>;
  /** the selected node's columns, in their order */
  columns?: string[];
  nodeName?: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [onlyNode, setOnlyNode] = useState(!!columns?.length);
  const [onlyAnon, setOnlyAnon] = useState(false);
  const rows = useMemo(() => {
    const names = onlyNode && columns?.length ? columns : Object.keys(dictionary);
    const q = query.trim().toLowerCase();
    return names
      .map((name) => ({ name, e: dictionary[name] as DictionaryEntry | undefined }))
      .filter(({ name, e }) => (!onlyAnon || !!e?.anonymized) && (!q || [name, e?.label, e?.note, e?.group].some((s) => s?.toLowerCase().includes(q))));
  }, [dictionary, columns, onlyNode, onlyAnon, query]);
  const groups = [...new Set(rows.map((r) => r.e?.group ?? ""))];
  const known = columns?.filter((c) => dictionary[c]).length ?? 0;

  return (
    <Modal title="Data dictionary" icon="info" onClose={onClose} xl>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-panel px-4 py-2.5">
        <div className="relative min-w-60 flex-1">
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a code (PSTV01), a name (biaya_tagih_rp) or a meaning…" className={`${inputClass} pl-8`} />
        </div>
        {columns?.length ? <Switch on={onlyNode} onChange={setOnlyNode} label={`Only ${nodeName ?? "this node"} (${known}/${columns.length} described)`} /> : null}
        <Switch on={onlyAnon} onChange={setOnlyAnon} label="Only anonymized" />
      </div>
      <div className="px-4 py-3 text-sm">
        {!rows.length && <p className="py-6 text-center text-muted">No column matches.</p>}
        {groups.map((g) => {
          const inGroup = rows.filter((r) => (r.e?.group ?? "") === g);
          // one source for the whole group: said once under its heading, not on every row
          const sources = new Set(inGroup.map((r) => r.e?.source ?? ""));
          const shared = sources.size === 1 ? [...sources][0] : "";
          return (
          <section key={g} className="mb-4">
            {g && <h3 className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted">{g}</h3>}
            {shared && (
              <p className="mb-1.5 flex items-start gap-1 text-[11px] text-ocean/80">
                <Icon name="doc" className="mt-px h-3 w-3 shrink-0" />
                <span>Sumber: {shared}</span>
              </p>
            )}
            <table className="w-full table-fixed text-left text-xs">
              <colgroup>
                <col className="w-56" />
                <col className="w-72" />
                <col />
              </colgroup>
              <tbody>
                {inGroup.map(({ name, e }) => (
                    <tr key={name} className="border-t border-line align-top">
                      <td className="py-1.5 pr-3 font-mono text-[11.5px] text-white">
                        <span className="break-all">{name}</span>
                        {e?.anonymized && (
                          <span className="ml-1.5 inline-flex items-center gap-0.5 rounded bg-warn/15 px-1 py-px align-middle font-sans text-[10px] text-warn" title={e.anonymized}>
                            <Icon name="lock" className="h-2.5 w-2.5" /> anonim
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-soft">{e?.label ?? <span className="text-muted">— not described</span>}</td>
                      <td className="py-1.5 text-muted">
                        {e?.note}
                        {e?.anonymized && <div className="mt-0.5 text-warn/90">{e.anonymized}</div>}
                        {e?.anonymizedSource && <div className="mt-0.5 text-[10.5px] text-warn/70">Dasar: {e.anonymizedSource}</div>}
                        {e?.source && !shared && (
                          <div className="mt-0.5 flex items-start gap-1 text-[10.5px] text-ocean/80">
                            <Icon name="doc" className="mt-px h-2.5 w-2.5 shrink-0" />
                            <span>Sumber: {e.source}</span>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
          );
        })}
      </div>
    </Modal>
  );
}
