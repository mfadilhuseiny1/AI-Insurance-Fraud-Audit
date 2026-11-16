"use client";

/** Marketplace products as downloadable JSON packages: download one, and install one (a package file, a name, inputs for
 *  its parameters, its dependencies mapped to resources here, the Project or folder to install into). */
import { useState } from "react";
import { missingText } from "@/components/LocationField";
import { fieldClass, buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { FolderPicker } from "@/components/workshop/PlatformPanels";

export type GenericProduct = {
  kind: string;
  name: string;
  description?: string;
  dependencies?: Record<string, string[]>;
  names?: Record<string, string>;
  parameters?: { name: string; type: "string" | "boolean"; default?: unknown; description?: string }[];
};
export type InstallBody = { package: GenericProduct; folder_id: string; name: string; inputs: Record<string, string>; mapping: Record<string, string> };

/** Save a product package as a .json file. */
export function downloadProduct(pk: GenericProduct, suffix: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(pk, null, 1)], { type: "application/json" }));
  a.download = `${pk.name.replace(/[^\w .()-]+/g, "_")}.${suffix}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const MAPPED = ["object_type", "action_type", "link_type", "logic", "function", "dataset", "source", "module"];
const text = (v: unknown) => (typeof v === "string" ? v.replace(/^"|"$/g, "") : v === undefined || v === null ? "" : String(v));

export function ProductInstallDialog({ title, kind, install, onInstalled, onClose }: {
  title: string; kind: string; install: (body: InstallBody) => Promise<{ id: string }>; onInstalled: (id: string) => void; onClose: () => void;
}) {
  const [pk, setPk] = useState<GenericProduct | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  // Install stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(pk ? [] : ["choose a product package file"]), ...(folder ? [] : ["choose the Project to install into"])];
  const deps = pk ? Object.entries(pk.dependencies ?? {}).flatMap(([k, ids]) => (MAPPED.includes(k) ? ids.map((id) => ({ kind: k, id })) : [])) : [];
  return (
    <Modal title={title} icon="download" onClose={onClose} wide>
      <div className="space-y-3 p-4 text-sm" data-product-install={kind}>
        <input
          type="file"
          accept=".json,application/json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const p = JSON.parse(await f.text()) as GenericProduct;
              if (p.kind !== kind) throw new Error(`not a package of this kind (${kind})`);
              setPk(p);
              setName(p.name);
              setInputs(Object.fromEntries((p.parameters ?? []).map((x) => [x.name, text(x.default)])));
              setError(null);
            } catch (x) {
              setError((x as Error).message);
            }
          }}
          aria-invalid={tried && !pk}
          className={tried && !pk ? "rounded-md text-bad ring-1 ring-bad/40" : undefined}
          data-install-file
        />
        {pk && (
          <>
            {pk.description && <p className="text-xs text-muted">{pk.description}</p>}
            <label className="block text-xs text-muted">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
            </label>
            {(pk.parameters ?? []).length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Inputs</div>
                {pk.parameters!.map((x) => (
                  <label key={x.name} className="flex items-center gap-2 text-xs" title={x.description}>
                    <span className="w-40 truncate">{x.name}</span>
                    {x.type === "boolean" ? (
                      <input type="checkbox" checked={inputs[x.name] === "true"} onChange={(e) => setInputs({ ...inputs, [x.name]: String(e.target.checked) })} />
                    ) : (
                      <input value={inputs[x.name] ?? ""} onChange={(e) => setInputs({ ...inputs, [x.name]: e.target.value })} className={`${fieldClass} min-w-0 flex-1 text-xs`} data-install-input={x.name} />
                    )}
                  </label>
                ))}
              </div>
            )}
            {deps.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Dependencies (map to resources here; empty: the same)</div>
                {deps.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 text-xs">
                    <span className="w-56 truncate" title={d.id}>
                      {d.kind.replace("_", " ")} · {pk.names?.[d.id] ?? d.id}
                    </span>
                    <input value={mapping[d.id] ?? ""} onChange={(e) => setMapping({ ...mapping, [d.id]: e.target.value.trim() })} placeholder={d.id} className={`${fieldClass} min-w-0 flex-1 font-mono text-xs`} />
                  </label>
                ))}
              </div>
            )}
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">
              Install into <span className="text-bad" aria-hidden>*</span>
            </div>
            <div className={tried && !folder ? "rounded-md ring-1 ring-bad/40" : undefined}>
              <FolderPicker value={folder} onChange={setFolder} />
            </div>
            {tried && !folder && <span className="block text-[11px] text-bad">Choose the Project (and folder) to install into.</span>}
          </>
        )}
        {error && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad" data-install-error>{error}</p>}
        <div className="flex items-center justify-end gap-2">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To install: {missingText(missing)}</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setTried(true);
              if (missing.length || !pk) return;
              setBusy(true);
              setError(null);
              install({ package: pk, folder_id: folder, name, inputs, mapping }).then((r) => onInstalled(r.id), (e: Error) => (setError(e.message), setBusy(false)));
            }}
            className={buttonClass.primary}
            data-install-confirm
          >
            {busy ? "Installing…" : "Install"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
