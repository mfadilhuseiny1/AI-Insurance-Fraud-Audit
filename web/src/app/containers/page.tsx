"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { missingText } from "@/components/LocationField";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { api, type DriveItem } from "@/lib/api";
import { bytes, containers, registryHost, SIDECAR_PROFILES, type ArtifactsRepo, type ArtifactsRepoDetail, type RequirementCheck, type RuntimeInfo } from "@/lib/containers";
import { confirmDialog } from "@/lib/dialogs";
import { when } from "@/lib/format";

/** Containers (palantir.com/docs/foundry/transforms-container): Docker Artifacts repositories in the platform's
 *  registry, image requirement checks, and Spark sidecar transforms run on the container runtime. */
export default function ContainersPage() {
  return (
    <Suspense fallback={null}>
      <Containers />
    </Suspense>
  );
}

type Tab = "overview" | "build" | "transform";
const TABS: [Tab, string, IconName][] = [
  ["overview", "Image overview", "server"],
  ["build", "Build & push", "refresh"],
  ["transform", "Sidecar transform", "pipeline"],
];

function Containers() {
  const router = useRouter();
  const params = useSearchParams();
  const [repos, setRepos] = useState<ArtifactsRepo[] | null>(null);
  const [detail, setDetail] = useState<ArtifactsRepoDetail | null>(null);
  const [rt, setRt] = useState<RuntimeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const itemParam = params.get("item");
  const tab = (TABS.some(([k]) => k === params.get("tab")) ? params.get("tab") : "overview") as Tab;
  const repoId = params.get("repo") ?? (itemParam ? null : repos?.[0]?.id ?? null);

  const go = useCallback(
    (next: Record<string, string | null>) => {
      const q = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v === null) q.delete(k);
        else q.set(k, v);
      }
      router.replace(`/containers?${q.toString()}`);
    },
    [params, router],
  );
  const loadRepos = useCallback(() => {
    containers.repositories().then(setRepos, (e: Error) => (setRepos([]), setError(e.message)));
  }, []);
  useEffect(() => {
    loadRepos();
    containers.runtime().then(setRt, () => {});
  }, [loadRepos]);
  useEffect(() => {
    if (!itemParam) return;
    containers.byItem(itemParam).then((d) => go({ item: null, repo: d.id }), (e: Error) => setError(e.message));
  }, [itemParam, go]);
  const loadDetail = useCallback(() => {
    if (!repoId) return;
    containers.repository(repoId).then(setDetail, (e: Error) => setError(e.message));
  }, [repoId]);
  useEffect(() => {
    loadDetail();
  }, [loadDetail]);
  const shown = detail && detail.id === repoId ? detail : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="rounded-md bg-ocean/15 p-1.5 text-ocean">
            <Icon name="server" className="h-4 w-4" />
          </span>
          Containers
        </div>
        <span className="text-xs text-muted">Container transforms and Spark sidecars</span>
        <div className="ml-auto flex items-center gap-2">
          <RuntimePill rt={rt} />
          <Link href="/artifacts" className="flex items-center gap-1 rounded-md border border-line-2 px-2.5 py-1.5 text-xs text-soft hover:text-white">
            <Icon name="layers" className="h-3.5 w-3.5" /> Artifacts
          </Link>
        </div>
      </header>
      <div className="flex items-center gap-2 border-b border-line bg-panel px-4 py-2 text-xs text-muted">
        <span className="rounded bg-ocean/15 px-2 py-1 text-ocean">Sidecar transforms</span>
        <span>Package any containerized logic alongside Spark executors.</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel p-3">
          <div className="mb-3 text-xs font-semibold text-soft">Container workflow</div>
          {TABS.map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => go({ tab: id })}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs ${tab === id ? "bg-ocean/15 text-white ring-1 ring-ocean/30" : "text-soft hover:bg-panel-2"}`}
            >
              <Icon name={icon} className="h-4 w-4" />
              {label}
            </button>
          ))}
          <div className="mb-2 mt-5 flex items-center text-[10px] font-semibold uppercase tracking-wider text-muted">
            Docker repositories
            <button type="button" onClick={() => setCreating(true)} className="ml-auto text-muted hover:text-white" title="New Docker Artifacts repository" aria-label="New repository">
              <Icon name="plus" className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {repos === null && <p className="px-2 text-xs text-muted">Loading…</p>}
            {repos?.length === 0 && <p className="px-2 text-xs text-muted">No Docker repositories yet.</p>}
            {repos?.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => go({ repo: r.id })}
                className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-xs ${r.id === repoId ? "bg-panel-2 text-white ring-1 ring-line-2" : "text-soft hover:bg-panel-2"}`}
              >
                <Icon name="server" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ocean" />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{r.name}</span>
                  <span className="block truncate text-[10px] text-muted">
                    {r.images} image{r.images === 1 ? "" : "s"} · {r.path}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <RuntimeCard rt={rt} onRelay={async () => setRt(rt ? { ...rt, relay: await containers.startRelay() } : rt)} />
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          {error && <p className="mx-auto mb-4 max-w-5xl rounded-md bg-bad/10 p-2 text-xs text-bad">{error}</p>}
          {tab === "overview" && <Overview repo={shown} onChanged={() => (loadDetail(), loadRepos())} onCreate={() => setCreating(true)} hasRepos={!!repos?.length} />}
          {tab === "build" && <BuildPanel repo={shown} rt={rt} onChanged={() => (loadDetail(), loadRepos())} />}
          {tab === "transform" && <TransformPanel repo={shown} />}
        </main>
      </div>
      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(d) => {
            setCreating(false);
            loadRepos();
            go({ repo: d.id, tab: "build" });
          }}
        />
      )}
    </div>
  );
}

function RuntimePill({ rt }: { rt: RuntimeInfo | null }) {
  if (!rt) return <span className="text-xs text-muted">Checking the runtime…</span>;
  const on = rt.kind !== "off";
  return (
    <span className={`flex items-center gap-1.5 text-xs ${on ? "text-ok" : "text-warn"}`} title={rt.error ?? `Docker ${rt.version}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-ok" : "bg-warn"}`} />
      {on ? `Registry connected · Docker ${rt.version}${rt.kind === "wsl" ? " (WSL)" : ""}` : "No container runtime"}
    </span>
  );
}

function RuntimeCard({ rt, onRelay }: { rt: RuntimeInfo | null; onRelay: () => void }) {
  return (
    <div className="mt-3 rounded-lg border border-line bg-panel-2 p-3 text-[10px] text-muted">
      <div className="mb-1 text-soft">Container runtime</div>
      {!rt ? (
        "…"
      ) : rt.kind === "off" ? (
        <span className="text-warn">{rt.error}</span>
      ) : (
        <>
          <div>
            Docker {rt.version} · {rt.kind === "wsl" ? `WSL (${rt.distro})` : "this machine"}
          </div>
          <div>{rt.sidecars?.length ?? 0} sidecar containers running</div>
          {rt.relay.needed && (
            <div className="mt-1.5">
              {rt.relay.running ? (
                <span className="text-ok">Push relay on {rt.relay.address}</span>
              ) : (
                <button type="button" onClick={onRelay} className="text-ocean hover:underline">
                  Start the push relay (docker push from WSL)
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const STATUS_STYLE: Record<RequirementCheck["status"], [string, IconName]> = {
  pass: ["text-ok", "check"],
  fail: ["text-bad", "x"],
  warn: ["text-warn", "alert"],
  pending: ["text-muted", "refresh"],
};

function Overview({ repo, onChanged, onCreate, hasRepos }: { repo: ArtifactsRepoDetail | null; onChanged: () => void; onCreate: () => void; hasRepos: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <div className="text-xs uppercase tracking-wider text-ocean">Image requirements</div>
        <h1 className="mt-1 text-xl font-semibold">{repo ? repo.name : "Container images"}</h1>
        <p className="mt-1 text-sm text-muted">
          Images pushed to the registry are checked against the requirements: a numeric non-root user, linux/amd64, a tag other than latest, layers under ~10 GB and exposed ports between 1024 and 65535
          (telemetry needs /bin/sh with set and tee). An image that fails one does not run.
        </p>
      </div>
      {!hasRepos && (
        <div className="rounded-xl border-2 border-dashed border-line-2 p-10 text-center text-sm text-muted">
          Create a Docker Artifacts repository in a Project, then push an image to it.
          <div className="mt-3">
            <button type="button" onClick={onCreate} className={buttonClass.primary}>
              <Icon name="plus" className="h-3.5 w-3.5" /> New Docker repository
            </button>
          </div>
        </div>
      )}
      {repo && (
        <section className="overflow-hidden rounded-xl border border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-xs">
            <span className="font-medium">Images</span>
            <span className="text-muted">
              {repo.path}/{repo.name}.artifacts · {repo.tags} tags · {bytes(repo.size)}
            </span>
          </div>
          {repo.images_detail.length === 0 && <p className="p-4 text-xs text-muted">No images yet: see Build & push.</p>}
          {repo.images_detail.map((img) =>
            img.tags.map((t) => {
              const key = `${img.name}:${t.tag}`;
              const failed = t.checks.filter((c) => c.status === "fail").length;
              return (
                <div key={key} className="border-b border-line last:border-0">
                  <button type="button" onClick={() => setOpen(open === key ? null : key)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-xs hover:bg-panel-2">
                    <Icon name={open === key ? "down" : "right"} className="h-3.5 w-3.5 text-muted" />
                    <span className="font-mono text-soft">{key}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${failed ? "bg-bad/15 text-bad" : "bg-ok/15 text-ok"}`}>{failed ? `${failed} requirement${failed > 1 ? "s" : ""} not met` : "runnable"}</span>
                    <span className="ml-auto text-muted">
                      {t.platform} · {bytes(t.size_total)} · pushed {when(t.pushed_at)}
                    </span>
                  </button>
                  {open === key && (
                    <div className="space-y-2 px-11 pb-4 text-xs">
                      <ul className="space-y-1">
                        {t.checks.map((c) => (
                          <li key={c.id} className="flex items-center gap-2">
                            <Icon name={STATUS_STYLE[c.status][1]} className={`h-3.5 w-3.5 ${STATUS_STYLE[c.status][0]}`} />
                            <span className="text-soft">{c.label}</span>
                            <span className="text-muted">{c.detail}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="font-mono text-[11px] text-muted">{t.digest}</div>
                      {repo.can_push && (
                        <button
                          type="button"
                          onClick={async () => {
                            if (!(await confirmDialog(`Delete the tag ${key}? Transforms using it stop running.`))) return;
                            await containers.deleteTag(repo.id, img.name, t.tag);
                            onChanged();
                          }}
                          className="text-bad hover:underline"
                        >
                          Delete tag
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            }),
          )}
        </section>
      )}
      <div className="rounded-xl border border-line bg-panel">
        <div className="border-b border-line p-4 text-sm font-medium">Spark sidecar architecture</div>
        <div className="flex items-center justify-center gap-4 overflow-auto p-8">
          <Node icon="database" label="Input dataset" />
          <Arrow />
          <Node icon="pipeline" label="Spark executor" />
          <Arrow />
          <Node icon="server" label="Sidecar container" />
          <Arrow />
          <Node icon="output" label="Output dataset" />
        </div>
        <div className="border-t border-line px-4 py-3 text-[10px] text-muted">
          One container per executor (and one next to the driver). Shared volume: <span className="font-mono text-soft">/opt/palantir/sidecars/shared-volumes/&lt;name&gt;</span>; exposed
          ports are on <span className="font-mono text-soft">localhost</span>.
        </div>
      </div>
    </div>
  );
}

function Node({ icon, label }: { icon: IconName; label: string }) {
  return (
    <div className="flex w-32 shrink-0 flex-col items-center gap-2 rounded-xl border border-line bg-panel-2 p-4 text-center">
      <span className="rounded-lg bg-ocean/15 p-2 text-ocean">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <span className="text-xs text-soft">{label}</span>
    </div>
  );
}

function Arrow() {
  return <Icon name="right" className="h-5 w-5 shrink-0 text-muted" />;
}

function Code({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-xs font-medium">
        <Icon name="code" className="h-4 w-4 text-ocean" />
        {title}
        <button type="button" onClick={() => navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {})} className="ml-auto text-muted hover:text-white" aria-label="Copy">
          <Icon name={copied ? "check" : "copy"} className="h-3.5 w-3.5" />
        </button>
      </div>
      <pre className="overflow-auto p-4 font-mono text-xs leading-5 text-soft">{text}</pre>
    </div>
  );
}

function BuildPanel({ repo, rt, onChanged }: { repo: ArtifactsRepoDetail | null; rt: RuntimeInfo | null; onChanged: () => void }) {
  const [image, setImage] = useState("simple-example:0.0.1");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const host = registryHost(rt);
  const target = repo ? `${host}/${repo.slug}/${image}` : `${host}/<repository>/${image}`;
  const latest = image.endsWith(":latest") || !image.includes(":");
  const upload = async (f: File) => {
    if (!repo) return;
    setBusy(true);
    setMsg(null);
    try {
      const [name, tag] = image.split(":");
      const r = await containers.upload(repo.id, f, name, tag);
      setMsg(`Stored ${r.stored.map((s) => `${s.image}:${s.tag}`).join(", ")}`);
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <div className="text-xs uppercase tracking-wider text-ocean">Artifacts repository</div>
        <h1 className="mt-1 text-xl font-semibold">Build and push an image</h1>
        <p className="mt-1 text-sm text-muted">Build for linux/amd64 with a numeric non-root USER, then push a versioned tag (not latest) to {repo ? repo.name : "a Docker repository"}.</p>
      </div>
      {!repo && <p className="rounded-lg border border-line bg-panel p-3 text-xs text-muted">Pick or create a Docker repository on the left.</p>}
      <label className="block text-xs text-muted">
        Image name and tag
        <input value={image} onChange={(e) => setImage(e.target.value.trim())} className={`${inputClass} mt-1 font-mono`} />
      </label>
      {latest && <p className="text-xs text-warn">Use a versioned tag: images tagged latest (or without a tag) are not run.</p>}
      {rt?.kind === "wsl" && !rt.relay.running && (
        <p className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-xs text-warn">
          Docker runs in WSL here: start the push relay (bottom left) so <span className="font-mono">docker push</span> from WSL reaches this registry at {host}.
        </p>
      )}
      <Code
        title="1. Log in (the password is a personal API token: Account → API tokens)"
        text={`docker login ${host} --username <your username> --password-stdin <<< "<API token>"`}
      />
      <Code title="2. Build" text={`docker build . --tag ${target} --platform linux/amd64`} />
      <Code title="3. Push" text={`docker push ${target}`} />
      <p className="text-[11px] text-muted">
        {rt?.kind === "wsl"
          ? `Run these in the WSL distribution (${rt.distro}); 127.0.0.1 registries need no TLS.`
          : "A registry other than localhost needs TLS, or an insecure-registries entry in the Docker daemon settings."}
      </p>
      {repo?.can_push && (
        <div className="rounded-xl border border-line bg-panel p-4 text-xs">
          <div className="mb-1 font-medium">Or upload a docker save archive</div>
          <p className="mb-2 text-muted">
            <span className="font-mono">docker save -o image.tar {image}</span>, then upload it: it is stored as {repo.slug}/{image}.
          </p>
          <input ref={fileRef} type="file" accept=".tar,.tar.gz,.tgz" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <button type="button" disabled={busy || latest} onClick={() => fileRef.current?.click()} className={buttonClass.secondary}>
            <Icon name={busy ? "refresh" : "upload"} className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "Uploading…" : "Upload archive"}
          </button>
          {msg && <p className="mt-2 text-soft">{msg}</p>}
        </div>
      )}
      <Code
        title="Example Dockerfile (a sidecar running as a server)"
        text={`FROM python:3.8-slim\nWORKDIR /usr/src/app\nCOPY requirements.txt ./\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\nEXPOSE 1234\nCMD ["python", "app.py"]\nUSER 1234`}
      />
    </div>
  );
}

const SERVER_TRANSFORM = `import requests

from transforms.api import Output, transform_df
from transforms.sidecar import sidecar


@sidecar(image='simple-example', tag='0.0.1')
@transform_df(
    Output("<output dataset>"),
)
def compute(ctx):
    response = requests.get('http://localhost:1234/hello')
    return ctx.spark_session.createDataFrame([(response.text,)], ["response_text"])`;

const CLI_TRANSFORM = `from transforms.api import transform, Input, Output, configure
from transforms.sidecar import sidecar, Volume
from myproject.datasets.utils import copy_start_flag, wait_for_done_flag, copy_close_flag
from myproject.datasets.utils import write_this_row_as_a_csv_with_one_row, copy_out_a_row_from_the_output_csv


@configure(["EXECUTOR_CORES_EXTRA_SMALL", "NUM_EXECUTORS_4"])
@sidecar(image='simple-example', tag='0.0.1', volumes=[Volume("shared")], resource_profile="SMALL_CPU_SMALL_MEMORY")
@transform(
    output_rows=Output("<output dataset>"),
    source=Input("<input dataset>"),
)
def compute(output_rows, source, ctx):
    def user_defined_function(row):
        write_this_row_as_a_csv_with_one_row(row)
        copy_start_flag()
        wait_for_done_flag()
        outdata1, outdata2, outdata3 = copy_out_a_row_from_the_output_csv()
        copy_close_flag()
        return (row.data1, row.data2, row.data3, "success", outdata1, outdata2, outdata3)

    results = source.dataframe().repartition(4).rdd.map(user_defined_function)
    output_rows.write_dataframe(results.toDF(["data1", "data2", "data3", "success", "outdata1", "outdata2", "outdata3"]))`;

function TransformPanel({ repo }: { repo: ArtifactsRepoDetail | null }) {
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <div className="text-xs uppercase tracking-wider text-ocean">Python transforms</div>
        <h1 className="mt-1 text-xl font-semibold">Write a Spark sidecar transform</h1>
        <p className="mt-1 text-sm text-muted">
          <span className="font-mono">@sidecar</span> launches one container of the image next to each Spark executor (and the driver). Executor and container share volumes under{" "}
          <span className="font-mono">/opt/palantir/sidecars/shared-volumes/</span> and the container&apos;s ports on localhost.
        </p>
      </div>
      <ol className="list-decimal space-y-1 rounded-xl border border-line bg-panel p-4 pl-8 text-xs text-soft">
        <li>
          Create a Python repository in <Link href="/code-repositories" className="text-ocean hover:underline">Code Repositories</Link>.
        </li>
        <li>
          Add <span className="font-mono">transforms-sidecar</span> to <span className="font-mono">conda_recipe/meta.yaml</span> (it is built in: nothing is installed).
        </li>
        <li>
          Under <b>Settings → Libraries → Artifacts</b>, add the Docker repository{repo ? ` (${repo.name})` : ""} holding the image.
        </li>
        <li>Author the transform; Preview and Build run its containers on the platform&apos;s container runtime. Container logs are added to the build logs.</li>
      </ol>
      <Code title="Example 1: sidecar running as a server" text={SERVER_TRANSFORM} />
      <Code title="Example 2: sidecar wrapping a CLI, one container per executor" text={CLI_TRANSFORM} />
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="border-b border-line px-4 py-2.5 text-xs font-medium">Resource profiles (resource_profile=…)</div>
        <table className="w-full text-left text-xs">
          <thead className="border-b border-line text-[10px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2">Profile</th>
              <th className="px-4 py-2">CPU cores</th>
              <th className="px-4 py-2">Memory</th>
              <th className="px-4 py-2">GPU</th>
              <th className="px-4 py-2">Shared memory</th>
            </tr>
          </thead>
          <tbody>
            {SIDECAR_PROFILES.map(([p, cpu, mem, gpu, shm]) => (
              <tr key={p} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-mono text-soft">{p}</td>
                <td className="px-4 py-2 text-muted">{cpu}</td>
                <td className="px-4 py-2 text-muted">{mem}</td>
                <td className="px-4 py-2 text-muted">{gpu}</td>
                <td className="px-4 py-2 text-muted">{shm}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-line px-4 py-2.5 text-[11px] text-muted">
          Applied as docker limits (--cpus, --memory, --shm-size, --gpus); CPU is capped at this machine&apos;s cores. GPU profiles need a GPU in the container runtime.
        </p>
      </div>
    </div>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (d: ArtifactsRepoDetail) => void }) {
  const [name, setName] = useState("");
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
    <Modal title="New Docker Artifacts repository" icon="server" onClose={onClose}>
      <form
        className="space-y-3 p-5 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setTried(true);
          if (missing.length) return;
          setBusy(true);
          setErr(null);
          try {
            onCreated(await containers.create({ name: name.trim(), folder_id: folder }));
          } catch (ex) {
            setErr((ex as Error).message);
            setBusy(false);
          }
        }}
      >
        <label className="block text-xs text-muted">
          <span className="flex items-center gap-1">Name <span className="text-bad" aria-hidden>*</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameInvalid} className={`${inputClass} mt-1 ${nameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} placeholder="sidecar-images" autoFocus />
          {nameInvalid && <span className="mt-1 block text-[11px] text-bad">Give it a name.</span>}
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
        <p className="text-[11px] text-muted">Type: Docker. The Project&apos;s viewers can pull its images and use them in transforms; editors can push.</p>
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
