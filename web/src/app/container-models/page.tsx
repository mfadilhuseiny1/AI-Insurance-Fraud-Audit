"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { missingText } from "@/components/LocationField";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type DriveItem } from "@/lib/api";
import { codeRepos, type RepoSummary } from "@/lib/codeRepos";
import { when } from "@/lib/format";
import { modelAssets, type ModelAsset, type ModelAssetDetail, type ModelVersion, type PredictResult, type VersionBody } from "@/lib/modelAssets";

/** Container models (palantir.com/docs/foundry/integrate-models/container-overview): a model resource owning a Docker
 *  Artifacts repository, model versions pairing pushed images with a container model adapter, test runs. */
export default function ContainerModelsPage() {
  return (
    <Suspense fallback={null}>
      <ContainerModels />
    </Suspense>
  );
}

function ContainerModels() {
  const router = useRouter();
  const params = useSearchParams();
  const [models, setModels] = useState<ModelAsset[] | null>(null);
  const [detail, setDetail] = useState<ModelAssetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const id = params.get("id") ?? models?.[0]?.id ?? null;
  const load = useCallback(() => {
    modelAssets.list("container").then(setModels, (e: Error) => setError(e.message));
  }, []);
  const loadDetail = useCallback(() => {
    if (!id) return;
    modelAssets.get(id).then(setDetail, (e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  useEffect(loadDetail, [loadDetail]);
  return (
    <div className="flex h-full flex-col">
      <AppHeader app="Container models" icon="server" href="/container-models" crumbs={detail ? [{ label: detail.name }] : []}>
        <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> Import containerized model
        </button>
      </AppHeader>
      {error && <p className="mx-6 mt-3 text-xs text-bad">{error}</p>}
      <div className="grid min-h-0 flex-1 grid-cols-[16rem_1fr]">
        <aside className="overflow-auto border-r border-line p-3 text-sm">
          {models?.length === 0 && <p className="text-xs text-muted">No container-backed models yet.</p>}
          {models?.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => router.replace(`/container-models?id=${m.id}`)}
              className={`mb-1 block w-full rounded-md px-2.5 py-2 text-left ${m.id === id ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}
            >
              <div className="truncate font-medium">{m.name}</div>
              <div className="text-[11px] text-muted">
                {m.versions} version{m.versions === 1 ? "" : "s"}
                {m.latest ? ` · latest ${m.latest}` : ""}
              </div>
            </button>
          ))}
        </aside>
        <main className="overflow-auto p-6">{detail && detail.id === id ? <ModelView key={detail.id} model={detail} onChanged={() => (loadDetail(), load())} /> : models?.length ? null : <Intro />}</main>
      </div>
      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(m) => {
            setCreating(false);
            load();
            router.replace(`/container-models?id=${m.id}`);
          }}
        />
      )}
    </div>
  );
}

function Intro() {
  return (
    <div className="mx-auto max-w-2xl space-y-2 text-sm text-soft">
      <h1 className="text-xl font-semibold text-white">Container-backed models</h1>
      <p>
        Package a container image with a model adapter: import a containerized model, push its images into the model&apos;s Docker repository, then create a model version choosing the images, their
        runtime settings and a <span className="font-mono">ContainerModelAdapter</span> from a code repository.
      </p>
      <p className="text-muted">Use a version from a Python transform with ModelInput(model, version), or test it here on rows you type.</p>
    </div>
  );
}

function ModelView({ model, onChanged }: { model: ModelAssetDetail; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<ModelVersion | null>(model.versions_detail[0] ?? null);
  const images = model.repository.images_detail.flatMap((i) => i.tags.map((t) => ({ image: i.name, ...t })));
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <div className="text-xs uppercase tracking-wider text-ocean">Container-backed model</div>
        <h1 className="mt-1 text-xl font-semibold">{model.name}</h1>
        {model.description && <p className="mt-1 text-sm text-muted">{model.description}</p>}
        <p className="mt-1 font-mono text-[11px] text-muted">{model.rid}</p>
      </div>

      <section className="rounded-xl border border-line bg-panel">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm font-medium">
          Container images
          <span className="text-xs font-normal text-muted">in {model.repository.name}</span>
          <Link href={`/containers?repo=${model.repo_id}&tab=build`} className="ml-auto text-xs font-normal text-ocean hover:underline">
            Push images →
          </Link>
        </div>
        {images.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted">No images yet: push a versioned linux/amd64 image with a numeric non-root USER (Push images shows the commands, or upload a docker save archive).</p>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {images.map((t) => (
                <tr key={`${t.image}:${t.tag}`} className="border-t border-line first:border-0">
                  <td className="px-4 py-2 font-mono">
                    {t.image}:{t.tag}
                  </td>
                  <td className="px-2 text-muted">user {t.user || "root"}</td>
                  <td className="px-2 text-muted">ports {t.ports?.join(", ") || "none"}</td>
                  <td className="px-2 text-muted">{when(t.pushed_at)}</td>
                  <td className="px-4 text-right">
                    {t.checks.some((c) => c.status === "fail") ? <span className="text-bad">fails the image requirements</span> : <span className="text-ok">runnable</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-xl border border-line bg-panel">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm font-medium">
          Model versions
          <button type="button" disabled={!images.length} onClick={() => setCreating(true)} className={`${buttonClass.secondary} ml-auto`}>
            <Icon name="plus" className="h-3.5 w-3.5" /> Create model version
          </button>
        </div>
        {model.versions_detail.length === 0 && <p className="px-4 py-3 text-xs text-muted">No versions yet.</p>}
        {model.versions_detail.map((v) => (
          <div key={v.id} className={`border-t border-line px-4 py-2.5 text-xs first:border-0 ${testing?.id === v.id ? "bg-ocean/5" : ""}`}>
            <div className="flex items-center gap-2">
              <span className="rounded bg-ocean/15 px-1.5 py-0.5 font-mono text-ocean">{v.version}</span>
              <span className="text-soft">{v.description || "No description"}</span>
              <span className="ml-auto text-muted">{when(v.created_at)}</span>
              <button type="button" onClick={() => setTesting(v)} className="text-ocean hover:underline">
                Test
              </button>
            </div>
            <div className="mt-1 text-muted">
              {v.images.map((i) => `${i.image}:${i.tag}${i.ports.length ? ` (port ${i.ports.join(", ")})` : ""}`).join(", ")} · adapter {v.adapter.class} in {v.adapter.file}
              {v.telemetry ? " · telemetry" : ""}
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-muted">{v.rid}</div>
          </div>
        ))}
      </section>

      {testing && <TestRun model={model} version={testing} />}

      {model.versions_detail[0] && (
        <section className="rounded-xl border border-line bg-panel p-4 text-xs">
          <div className="mb-2 text-sm font-medium">Use it in a Python transform</div>
          <pre className="overflow-auto rounded bg-ink p-3 font-mono text-[11px] text-soft">{`from transforms.api import transform, Input, Output
from palantir_models.transforms import ModelInput


@transform(
    output=Output("/path/to/output/output_dataset"),
    model=ModelInput(
        "${model.rid}",
        "${model.versions_detail[0].rid}"),
    source_df=Input("/path/to/input/input_dataset"),
)
def compute(model, source_df, output):
    model.transform_write(source_df, output)`}</pre>
        </section>
      )}
      {creating && (
        <VersionDialog
          model={model}
          images={images.map((t) => ({ image: t.image, tag: t.tag, ports: t.ports ?? [] }))}
          onClose={() => setCreating(false)}
          onCreated={(v) => {
            setCreating(false);
            setTesting(v);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function TestRun({ model, version }: { model: ModelAssetDetail; version: ModelVersion }) {
  const [input, setInput] = useState('{\n  "input_df": [{"text": "hello"}]\n}');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<PredictResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      setRes(await modelAssets.predict(model.id, version.id, JSON.parse(input)));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-xl border border-line bg-panel p-4 text-xs">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        Test version {version.version}
        <span className="text-xs font-normal text-muted">starts its containers, runs the adapter&apos;s predict on these inputs (by the names in its api()), then stops them</span>
      </div>
      <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={5} className={`${inputClass} font-mono text-xs`} spellCheck={false} />
      <button type="button" disabled={busy} onClick={run} className={`${buttonClass.primary} mt-2`}>
        <Icon name={busy ? "refresh" : "play"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Running…" : "Run"}
      </button>
      {err && <pre className="mt-2 whitespace-pre-wrap text-bad">{err}</pre>}
      {res && (
        <div className="mt-3 space-y-2">
          {Object.entries(res.outputs).map(([name, v]) => (
            <div key={name}>
              <div className="mb-1 text-muted">{name}</div>
              {Array.isArray(v) && v.length && typeof v[0] === "object" ? <Rows rows={v as Record<string, unknown>[]} /> : <pre className="rounded bg-ink p-2 font-mono">{JSON.stringify(v, null, 2)}</pre>}
            </div>
          ))}
          {res.logs && (
            <details>
              <summary className="cursor-pointer text-muted">Container logs</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-ink p-2 font-mono text-[10px] text-soft">{res.logs}</pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function Rows({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = Object.keys(rows[0]);
  return (
    <table className="w-full rounded border border-line-2 text-xs">
      <thead className="bg-panel-2 text-left text-muted">
        <tr>
          {cols.map((c) => (
            <th key={c} className="px-2 py-1 font-normal">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 200).map((r, i) => (
          <tr key={i} className="border-t border-line">
            {cols.map((c) => (
              <td key={c} className="px-2 py-1 font-mono">
                {typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c] ?? "")}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type ImageRow = { key: string; port: string; env: string; args: string; command: string; memory: string };

function VersionDialog({
  model,
  images,
  onClose,
  onCreated,
}: {
  model: ModelAssetDetail;
  images: { image: string; tag: string; ports: number[] }[];
  onClose: () => void;
  onCreated: (v: ModelVersion) => void;
}) {
  const prev = model.versions_detail[0];
  const [step, setStep] = useState(0);
  const [chosen, setChosen] = useState<ImageRow[]>(() =>
    (prev?.images ?? []).length
      ? prev!.images.map((i) => ({
          key: `${i.image}:${i.tag}`,
          port: i.port ? String(i.port) : "",
          env: Object.entries(i.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"),
          args: (i.args ?? []).join(" "),
          command: (i.command ?? []).join(" "),
          memory: i.memory ?? "",
        }))
      : [{ key: `${images[0].image}:${images[0].tag}`, port: images[0].ports[0] ? String(images[0].ports[0]) : "", env: "", args: "", command: "", memory: "" }],
  );
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [repoId, setRepoId] = useState(prev?.adapter.repo_id ?? "");
  const [file, setFile] = useState(prev?.adapter.file ?? "transforms-python/src/myproject/adapter.py");
  const [cls, setCls] = useState(prev?.adapter.class ?? "");
  const [bump, setBump] = useState<VersionBody["bump"]>("minor");
  const [description, setDescription] = useState("");
  const [telemetry, setTelemetry] = useState(prev?.telemetry ?? false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    codeRepos.list().then((rs) => {
      setRepos(rs);
      setRepoId((cur) => cur || rs[0]?.id || "");
    }, () => {});
  }, []);
  const set = (i: number, x: Partial<ImageRow>) => setChosen((c) => c.map((r, j) => (j === i ? { ...r, ...x } : r)));
  const split = (s: string) => s.trim().split(/\s+/).filter(Boolean);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body: VersionBody = {
        images: chosen.map((r) => {
          const [image, tag] = r.key.split(":");
          return {
            image,
            tag,
            port: r.port ? Number(r.port) : null,
            env: Object.fromEntries(
              r.env
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l.includes("="))
                .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
            ),
            args: split(r.args),
            command: r.command.trim() ? split(r.command) : null,
            memory: r.memory.trim() || null,
          };
        }),
        adapter_repo_id: repoId,
        adapter_file: file.trim(),
        adapter_class: cls.trim(),
        bump,
        description,
        telemetry,
      };
      onCreated(await modelAssets.createVersion(model.id, body));
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Configure model version" icon="server" onClose={onClose}>
      <div className="space-y-3 p-5 text-sm">
        <div className="flex gap-3 text-xs">
          {["Container images", "Model details", "Runtime"].map((s, i) => (
            <button key={s} type="button" onClick={() => setStep(i)} className={step === i ? "font-medium text-white" : "text-muted"}>
              {i + 1}. {s}
            </button>
          ))}
        </div>
        {step === 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted">The images in this version; each runs as one container, all started together when the model is used.</p>
            {chosen.map((r, i) => (
              <div key={i} className="flex gap-2">
                <select value={r.key} onChange={(e) => set(i, { key: e.target.value })} className={`${inputClass} font-mono`}>
                  {images.map((t) => (
                    <option key={`${t.image}:${t.tag}`} value={`${t.image}:${t.tag}`}>
                      {t.image}:{t.tag}
                    </option>
                  ))}
                </select>
                {chosen.length > 1 && (
                  <button type="button" onClick={() => setChosen((c) => c.filter((_, j) => j !== i))} className="text-muted hover:text-bad" aria-label="Remove image">
                    <Icon name="x" className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={() => setChosen((c) => [...c, { key: `${images[0].image}:${images[0].tag}`, port: "", env: "", args: "", command: "", memory: "" }])} className="text-xs text-ocean hover:underline">
              + Add an image
            </button>
          </div>
        )}
        {step === 1 && (
          <div className="space-y-2">
            <label className="block text-xs text-muted">
              Version change
              <select value={bump} onChange={(e) => setBump(e.target.value as VersionBody["bump"])} className={`${inputClass} mt-1`}>
                <option value="major">Major</option>
                <option value="minor">Minor</option>
                <option value="patch">Patch</option>
              </select>
            </label>
            <label className="block text-xs text-muted">
              Description
              <input value={description} onChange={(e) => setDescription(e.target.value)} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs text-muted">
              Model adapter repository
              <select value={repoId} onChange={(e) => setRepoId(e.target.value)} className={`${inputClass} mt-1`}>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-muted">
              Adapter file (on the default branch&apos;s last commit)
              <input value={file} onChange={(e) => setFile(e.target.value)} className={`${inputClass} mt-1 font-mono`} />
            </label>
            <label className="block text-xs text-muted">
              Adapter class (a palantir_models.ContainerModelAdapter: init_container, api, predict)
              <input value={cls} onChange={(e) => setCls(e.target.value)} placeholder="ExampleIdentityFunctionModelAdapter" className={`${inputClass} mt-1 font-mono`} />
            </label>
          </div>
        )}
        {step === 2 && (
          <div className="space-y-3">
            {chosen.map((r, i) => (
              <div key={i} className="space-y-1.5 rounded-lg border border-line p-3">
                <div className="font-mono text-xs">{r.key}</div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-muted">
                    Port it listens on
                    <input value={r.port} onChange={(e) => set(i, { port: e.target.value.replace(/\D/g, "") })} placeholder="the image's exposed ports" className={`${inputClass} mt-1`} />
                  </label>
                  <label className="text-xs text-muted">
                    Memory limit
                    <input value={r.memory} onChange={(e) => set(i, { memory: e.target.value })} placeholder="e.g. 2g" className={`${inputClass} mt-1`} />
                  </label>
                </div>
                <label className="block text-xs text-muted">
                  Environment variables (KEY=value per line)
                  <textarea value={r.env} onChange={(e) => set(i, { env: e.target.value })} rows={2} className={`${inputClass} mt-1 font-mono text-xs`} />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-muted">
                    Arguments
                    <input value={r.args} onChange={(e) => set(i, { args: e.target.value })} className={`${inputClass} mt-1 font-mono`} />
                  </label>
                  <label className="text-xs text-muted">
                    Exec command (replaces the image&apos;s)
                    <input value={r.command} onChange={(e) => set(i, { command: e.target.value })} className={`${inputClass} mt-1 font-mono`} />
                  </label>
                </div>
              </div>
            ))}
            <label className="flex items-center gap-2 text-xs text-soft">
              <input type="checkbox" checked={telemetry} onChange={(e) => setTelemetry(e.target.checked)} /> Enable telemetry (container logs in build logs and test runs; needs /bin/sh with set and tee)
            </label>
          </div>
        )}
        {err && <p className="whitespace-pre-wrap text-xs text-bad">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          {step < 2 ? (
            <button type="button" onClick={() => setStep(step + 1)} className={buttonClass.primary}>
              Next
            </button>
          ) : (
            <button type="button" disabled={busy || !repoId || !cls.trim()} onClick={submit} className={buttonClass.primary}>
              {busy ? "Creating…" : "Create version"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (m: ModelAssetDetail) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [projects, setProjects] = useState<DriveItem[]>([]);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(name.trim() ? [] : ["enter a name"]), ...(folder ? [] : ["choose a Project"])];
  const nameInvalid = tried && !name.trim();
  const projectInvalid = tried && !folder;
  useEffect(() => {
    api.drive.folder(null).then((f) => {
      const ps = f.items.filter((i) => i.kind === "project");
      setProjects(ps);
      setFolder((cur) => cur || ps[0]?.id || "");
    }, () => {});
  }, []);
  return (
    <Modal title="Import containerized model" icon="server" onClose={onClose}>
      <form
        className="space-y-3 p-5 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (missing.length) return;
          setBusy(true);
          setErr(null);
          try {
            onCreated(await modelAssets.create({ name: name.trim(), folder_id: folder, description }));
          } catch (ex) {
            setErr((ex as Error).message);
            setBusy(false);
          }
        }}
      >
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Model name <span className="text-bad" aria-hidden>*</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameInvalid} className={`${inputClass} mt-1 ${nameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} autoFocus />
          {nameInvalid && <span className="mt-1 block text-[11px] text-bad">Give it a name.</span>}
        </label>
        <label className="block text-xs text-muted">
          Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={`${inputClass} mt-1`} />
        </label>
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Project <span className="text-bad" aria-hidden>*</span></span>
          <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-invalid={projectInvalid} className={`${inputClass} mt-1 ${projectInvalid ? "border-bad ring-1 ring-bad/40" : ""}`}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {projectInvalid && <span className="mt-1 block text-[11px] text-bad">{projects.length ? "Choose the Project it is saved in." : "No Project to save it in: create or join one first."}</span>}
        </label>
        <p className="text-[11px] text-muted">The model gets its own Docker Artifacts repository in the Project: its viewers can use the model and pull the images, its editors push images and create versions.</p>
        {err && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</p>}
        <div className="flex items-center justify-end gap-2">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To create: {missingText(missing)}</span>}
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={buttonClass.primary}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
