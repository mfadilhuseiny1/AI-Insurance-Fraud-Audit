"use client";

import { useCallback, useEffect, useState } from "react";
import { LocationField, missingText } from "@/components/LocationField";
import { Icon } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { Field } from "@/components/pipeline/ui";
import { ApiError, Loading } from "@/components/States";
import { api, API_URL } from "@/lib/api";
import { when } from "@/lib/format";
import { governance, type Space } from "@/lib/governanceModel";

type Kind = { kind: string; label: string; resource: string };
type Product = {
  id: string;
  kind: string;
  label: string;
  name: string;
  description: string;
  latest: string | null;
  versions: { version: string; published_at: string; published_by: string }[];
  dependencies: Record<string, string[]>;
  parameters: { name: string; type?: string; default?: unknown }[];
  inputs: string[];
  installs: number;
  can_maintain: boolean;
  updated_at: string;
};

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? res.statusText));
  return body as T;
}

/** Where each kind's resources are listed, for "Publish": [endpoint, id key, name key]. */
const RESOURCES: Record<string, [string, string, string]> = {
  "bluesandai.workshop.product": ["/api/workshop/modules", "id", "name"],
  "bluesandai.slate.product": ["/api/slate/apps", "id", "name"],
  "bluesandai.widget-set.product": ["/api/widget-sets", "id", "name"],
  "bluesandai.checkpoints.product": ["/api/checkpoints/configs", "id", "name"],
  "bluesandai.cipher.product": ["/api/cipher/channels", "id", "name"],
  "bluesandai.restricted-view.product": ["/api/restricted-views", "id", "name"],
};

/** Marketplace: products other users install (Workshop modules, Slate apps, widget sets, checkpoints, Cipher channels). */
export default function MarketplacePage() {
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [rows, setRows] = useState<Product[] | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<Product | true | null>(null);
  const [installing, setInstalling] = useState<Product | null>(null);
  const load = useCallback(() => call<Product[]>(`/api/marketplace/products?q=${encodeURIComponent(q)}`).then(setRows, (e: Error) => setError(e.message)), [q]);
  useEffect(() => {
    call<Kind[]>("/api/marketplace/kinds").then(setKinds, () => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Marketplace" icon="layers" href="/marketplace">
        <button type="button" className={buttonClass.primary} onClick={() => setPublishing(true)}>
          <Icon name="upload" className="h-4 w-4" />
          Publish a product
        </button>
      </AppHeader>
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
        <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products" className={`${inputClass} max-w-sm`} />
          {error && <ApiError message={error} />}
          {!rows ? (
            <Loading />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rows.map((p) => (
                <div key={p.id} className="flex flex-col rounded-xl border border-line bg-panel p-4 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    <span className="ml-auto rounded bg-panel-2 px-1.5 text-[11px] text-muted">{p.label}</span>
                  </div>
                  {p.description && <p className="mt-1 text-xs text-muted">{p.description}</p>}
                  <p className="mt-2 text-xs text-muted">
                    v{p.latest} · {p.versions.length} version{p.versions.length === 1 ? "" : "s"} · {p.installs} install{p.installs === 1 ? "" : "s"} · {when(p.updated_at)}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" className={buttonClass.primary} onClick={() => setInstalling(p)}>
                      Install
                    </button>
                    {p.can_maintain && (
                      <>
                        <button type="button" className={buttonClass.secondary} onClick={() => setPublishing(p)}>
                          New version
                        </button>
                        <button
                          type="button"
                          className={buttonClass.ghost}
                          onClick={() => call(`/api/marketplace/products/${p.id}`, { method: "DELETE" }).then(load, (e: Error) => setError(e.message))}
                        >
                          <Icon name="trash" className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
              {rows.length === 0 && <p className="text-sm text-muted">No products yet: publish a Workshop module, Slate app, widget set, checkpoint configuration or Cipher channel.</p>}
            </div>
          )}
        </div>
      </main>
      {publishing && <PublishDialog kinds={kinds} product={publishing === true ? null : publishing} onClose={() => setPublishing(null)} onDone={() => (setPublishing(null), load())} />}
      {installing && <InstallDialog product={installing} onClose={() => setInstalling(null)} onDone={() => (setInstalling(null), load())} />}
    </div>
  );
}

function PublishDialog({ kinds, product, onClose, onDone }: { kinds: Kind[]; product: Product | null; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState(product?.kind ?? kinds[0]?.kind ?? "");
  const [resources, setResources] = useState<{ id: string; name: string }[]>([]);
  const [resource, setResource] = useState("");
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [version, setVersion] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const r = RESOURCES[kind];
    if (!r) return;
    call<Record<string, unknown>[]>(r[0]).then(
      (rows) => setResources((Array.isArray(rows) ? rows : []).map((x) => ({ id: String(x[r[1]]), name: String(x[r[2]] ?? x[r[1]]) }))),
      () => setResources([]),
    );
  }, [kind]);
  return (
    <Modal title={product ? `New version of ${product.name}` : "Publish a product"} icon="upload" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <Field label="Kind">
          <select value={kind} disabled={!!product} onChange={(e) => (setKind(e.target.value), setResource(""))} className={inputClass}>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="What to package">
          <select value={resource} onChange={(e) => setResource(e.target.value)} className={inputClass}>
            <option value="">Choose…</option>
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        {!product && (
          <Field label="Product name">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </Field>
        )}
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Version (optional)">
          <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="e.g. 1.2.0" className={inputClass} />
        </Field>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!resource}
            className={buttonClass.primary}
            onClick={() =>
              call("/api/marketplace/products", {
                method: "POST",
                json: { kind, resource_id: resource, name: name || undefined, description, version: version || undefined, product_id: product?.id },
              }).then(onDone, (e: Error) => setError(e.message))
            }
          >
            Publish
          </button>
        </div>
      </div>
    </Modal>
  );
}

function InstallDialog({ product, onClose, onDone }: { product: Product; onClose: () => void; onDone: () => void }) {
  const [version, setVersion] = useState(product.latest ?? "");
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // a new locked Project (the space's inherited roles for Marketplace Projects; nobody edits it) instead of a target
  const [fresh, setFresh] = useState<{ name: string; space_id: string } | null>(null);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const projectTarget = product.kind === "bluesandai.checkpoints.product" || product.kind === "bluesandai.restricted-view.product";
  useEffect(() => {
    if (projectTarget) api.drive.folder(null).then((f) => setProjects(f.items.filter((i) => i.kind === "project").map((i) => ({ id: i.id, name: i.name }))), () => {});
    governance.spaces().then((s) => setSpaces(s.filter((x) => x.my_workflows?.includes("create_projects"))), () => {});
  }, [projectTarget]);
  const deps = Object.entries(product.dependencies ?? {}).flatMap(([k, ids]) => (ids ?? []).map((id) => ({ kind: k, id })));
  // Install stays clickable: a click with something missing says what, next to the button and on the field
  const missing = fresh
    ? [...(fresh.name.trim() ? [] : ["enter a Project name"]), ...(fresh.space_id ? [] : ["choose a space"])]
    : target ? [] : [projectTarget ? "choose a Project" : "choose a folder"];
  const install = () => {
    setTried(true);
    if (missing.length || (!fresh && !target)) return;
    setBusy(true);
    setError(null);
    call(`/api/marketplace/products/${product.id}/install`, {
      method: "POST",
      json: {
        version,
        ...(fresh ? { new_project: fresh } : { target_id: target!.id }),
        name: name || null,
        inputs,
        mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)),
      },
    })
      .then(() => (setDone(true), onDone()), (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const bad = (on: boolean) => (tried && on ? "border-bad ring-1 ring-bad/40" : "");
  const toMap = [...deps.map((d) => ({ id: d.id, label: `${d.kind.replace(/_/g, " ")} ${d.id}` })), ...(product.inputs ?? []).map((i) => ({ id: i, label: `location ${i}` }))];
  return (
    <Modal title={`Install ${product.name}`} icon="download" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <Field label="Version">
          <select value={version} onChange={(e) => setVersion(e.target.value)} className={inputClass}>
            {[...product.versions].reverse().map((v) => (
              <option key={v.version} value={v.version}>
                {v.version} · {when(v.published_at)}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex gap-4 text-xs">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={!fresh} onChange={() => setFresh(null)} />
            Into an existing {projectTarget ? "Project" : "folder"}
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={!!fresh} disabled={!spaces.length} onChange={() => setFresh({ name: product.name, space_id: spaces[0]?.id ?? "" })} />
            Into a new locked Project
          </label>
        </div>
        {fresh ? (
          <div className="grid gap-2 md:grid-cols-2">
            <Field label="Project name" required>
              <input value={fresh.name} onChange={(e) => setFresh({ ...fresh, name: e.target.value })} aria-invalid={tried && !fresh.name.trim()} className={`${inputClass} ${bad(!fresh.name.trim())}`} />
            </Field>
            <Field label="Space" required>
              <select value={fresh.space_id} onChange={(e) => setFresh({ ...fresh, space_id: e.target.value })} className={`${inputClass} ${bad(!fresh.space_id)}`}>
                {spaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-xs text-muted md:col-span-2">
              The Project is managed by the Marketplace: it takes the space&apos;s inherited roles for locked Marketplace Projects, and nobody edits it until an administrator unlocks it.
            </p>
          </div>
        ) : projectTarget ? (
          <Field label="Into Project" required hint={tried && !target ? <span className="text-bad">Choose the Project to install into.</span> : undefined}>
            <select value={target?.id ?? ""} onChange={(e) => setTarget(projects.find((p) => p.id === e.target.value) ?? null)} aria-invalid={tried && !target} className={`${inputClass} ${bad(!target)}`}>
              <option value="">Choose…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <LocationField value={target} onChange={setTarget} invalid={tried} label="Into folder" hint="The Project or folder the product is installed into." />
        )}
        {!projectTarget && (
          <Field label="Name (optional)">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </Field>
        )}
        {(product.parameters ?? []).map((prm) => (
          <Field key={prm.name} label={`Parameter · ${prm.name}`}>
            <input value={inputs[prm.name] ?? String(prm.default ?? "")} onChange={(e) => setInputs({ ...inputs, [prm.name]: e.target.value })} className={inputClass} />
          </Field>
        ))}
        {toMap.length > 0 && (
          <Field label="Map dependencies to resources here (id; empty keeps the packaged one)">
            <div className="space-y-1">
              {toMap.map((d) => (
                <div key={d.id} className="flex items-center gap-2 text-xs">
                  <span className="w-48 truncate text-muted">{d.label}</span>
                  <input value={mapping[d.id] ?? ""} onChange={(e) => setMapping({ ...mapping, [d.id]: e.target.value })} className={`${inputClass} text-xs`} />
                </div>
              ))}
            </div>
          </Field>
        )}
        {error && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>}
        {done && <p className="text-xs text-ok">Installed.</p>}
        <div className="flex items-center justify-end gap-2">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To install: {missingText(missing)}</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Close
          </button>
          <button type="button" disabled={busy} className={buttonClass.primary} onClick={install}>
            {busy ? "Installing…" : "Install"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
