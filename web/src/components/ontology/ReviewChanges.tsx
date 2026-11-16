"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { TypeIcon } from "@/components/ontology/Datasources";
import { buttonClass, Modal } from "@/components/pipeline/Modal";
import type { ObjectType } from "@/lib/ontology";
import type { Group } from "@/lib/ontologyModel";

/* Edits to an object type are staged on its Overview and saved together, as in Foundry's Ontology Manager: "N edits",
   Save → Review changes (all changes, warnings, errors) → Save to Nexus → a last confirmation. */

export type Staged = Partial<ObjectType> & { apply_status_to_properties?: boolean };

const LABEL: Record<string, string> = {
  display_name: "Display name",
  plural_name: "Plural display name",
  description: "Description",
  api_name: "API name",
  title_property: "Title property",
  status: "Status",
  visibility: "Visibility",
  aliases: "Aliases",
  groups: "Groups",
  deprecation: "Deprecation",
  apply_status_to_properties: "Apply the status to every property",
};

function show(key: string, v: unknown, t: ObjectType, groups: Group[]): string {
  if (v === null || v === undefined || v === "") return "—";
  if (key === "title_property") return t.properties.find((p) => p.api_name === v)?.display_name ?? String(v);
  if (key === "groups") return (v as string[]).map((g) => groups.find((x) => x.id === g)?.name ?? g).join(", ") || "—";
  if (Array.isArray(v)) return v.join(", ") || "—";
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).filter(([, x]) => x).map(([k, x]) => `${k}: ${x}`).join(" · ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

export function checks(t: ObjectType, staged: Staged): { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  if ("display_name" in staged && !String(staged.display_name ?? "").trim()) errors.push("The display name cannot be empty.");
  if ("api_name" in staged) {
    if (!/^[a-zA-Z][A-Za-z0-9_]*$/.test(String(staged.api_name ?? ""))) errors.push("The API name must start with a letter and hold only letters, digits and _.");
    else warnings.push(`Renaming the API name from ${t.api_name} to ${staged.api_name} breaks code, functions and OSDK apps that use the old name.`);
  }
  if (staged.status === "deprecated") warnings.push("Deprecating the object type warns everyone who uses it; plan the replacement.");
  if (staged.visibility === "hidden") warnings.push("A hidden object type no longer shows in Object Explorer and search.");
  if ("title_property" in staged && !t.properties.some((p) => p.api_name === staged.title_property)) errors.push("The title property must be one of the object type's properties.");
  return { warnings, errors };
}

export function ReviewChanges({ t, staged, groups, onDiscard, onClose, onSave }: { t: ObjectType; staged: Staged; groups: Group[]; onDiscard: () => void; onClose: () => void; onSave: () => Promise<boolean> }) {
  const [tab, setTab] = useState<"all" | "warnings" | "errors">("all");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const keys = Object.keys(staged) as (keyof Staged)[];
  const { warnings, errors } = checks(t, staged);
  return (
    <Modal title="Review changes" icon="check" onClose={onClose} xl>
      <div className="flex gap-5 border-b border-line px-5 pt-3 text-sm">
        {(
          [
            ["all", `All changes (${keys.length})`, "list"],
            ["warnings", `Warnings (${warnings.length})`, "alert"],
            ["errors", `Errors (${errors.length})`, "x"],
          ] as const
        ).map(([k, l, i]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`-mb-px flex items-center gap-1.5 border-b-2 pb-2 ${tab === k ? "border-ocean text-white" : "border-transparent text-muted hover:text-soft"}`}>
            <Icon name={i} className={`h-3.5 w-3.5 ${k === "errors" && errors.length ? "text-bad" : k === "warnings" && warnings.length ? "text-warn" : ""}`} /> {l}
          </button>
        ))}
      </div>
      <div className="max-h-[55vh] overflow-y-auto p-5">
        {tab === "all" ? (
          <div className="overflow-hidden rounded-xl border border-line">
            <div className="flex items-center gap-2 border-b border-line bg-panel-2/40 px-4 py-2.5">
              <TypeIcon t={t} className="h-4 w-4" />
              <span className="text-sm font-medium text-white">{t.display_name}</span>
              <span className="ml-auto rounded-full bg-sand/15 px-2 py-0.5 text-[10px] text-sand">Modified</span>
            </div>
            <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted">General information</div>
            {keys.map((k) => (
              <div key={k} className="grid grid-cols-[180px_1fr] items-start gap-3 border-t border-line/60 px-4 py-2 text-sm">
                <span className="text-muted">{LABEL[k] ?? k}</span>
                <span className="flex flex-wrap items-center gap-2">
                  {k !== "apply_status_to_properties" && (
                    <>
                      <span className="rounded bg-bad/10 px-1.5 py-0.5 text-xs text-bad line-through">{show(k, t[k as keyof ObjectType], t, groups)}</span>
                      <Icon name="right" className="h-3 w-3 text-muted" />
                    </>
                  )}
                  <span className="rounded bg-ok/10 px-1.5 py-0.5 text-xs text-ok">{show(k, staged[k], t, groups)}</span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <ul className="space-y-2">
            {(tab === "warnings" ? warnings : errors).map((m) => (
              <li key={m} className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${tab === "errors" ? "bg-bad/10 text-bad" : "bg-warn/10 text-warn"}`}>
                <Icon name={tab === "errors" ? "x" : "alert"} className="mt-0.5 h-4 w-4 shrink-0" /> {m}
              </li>
            ))}
            {!(tab === "warnings" ? warnings : errors).length && <li className="text-sm text-muted">None.</li>}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-5 py-3">
        <button type="button" onClick={onDiscard} className={buttonClass.secondary}>
          Discard
        </button>
        <span className="ml-auto text-xs text-muted">{errors.length ? "Fix the errors to save." : ""}</span>
        <button type="button" disabled={!!errors.length} onClick={() => setConfirming(true)} className="rounded-md bg-ok px-3 py-1.5 text-sm font-medium text-ink hover:brightness-110 disabled:opacity-50" data-save-to-nexus>
          Save to Nexus
        </button>
      </div>
      {confirming && (
        <Modal title="Save changes to Nexus" icon="save" onClose={() => setConfirming(false)}>
          <div className="space-y-4 p-5 text-sm">
            <p className="text-soft">Are you sure you want to save all changes to the Nexus?</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfirming(false)} className={buttonClass.secondary}>
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const ok = await onSave();
                  setBusy(false);
                  if (ok) setConfirming(false);
                }}
                className="rounded-md bg-ok px-3 py-1.5 text-sm font-medium text-ink hover:brightness-110 disabled:opacity-50"
                data-confirm-save
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
