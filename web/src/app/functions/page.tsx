"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppHome, type AppHomeItem } from "@/components/AppHome";
import { useAuth } from "@/components/AuthGate";
import { Icon } from "@/components/Icon";
import { FunctionIntegration } from "@/components/functions/Integration";
import { KIND_LABEL, ResultView, signature } from "@/components/functions/parts";
import { Card, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { ApiError } from "@/components/States";
import { functions, type FnSignature, type FunctionRow, type Release } from "@/lib/actions";
import { codeRepos, type RepoSummary } from "@/lib/codeRepos";

type Tab = "gateway" | "preview";

/** Functions: the registry of published Python functions, the API gateway of queries and a live preview of unpublished code. */
export default function FunctionsPage() {
  const [rows, setRows] = useState<FunctionRow[] | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [tab, setTab] = useState<Tab | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const noCode = useAuth().me?.can_run_code === false;
  const load = useCallback(() => {
    functions.list(q).then(setRows, (e: Error) => setError(e.message));
  }, [q]);
  useEffect(() => {
    load();
  }, [load]);
  const kindOf = useMemo(() => new Map((rows ?? []).map((f) => [f.id, f.kind])), [rows]);
  const kindFilter = useMemo(() => (kind ? (i: AppHomeItem) => kindOf.get(i.id) === kind : undefined), [kind, kindOf]);

  if (error && !rows) return <ApiError message={error} />;
  const publish = (
    <button
      type="button"
      onClick={() => setPublishing(true)}
      disabled={noCode}
      title={noCode ? "Publishing functions runs code: limited to administrators and the allowed groups (Control Panel → Security → Code execution)" : undefined}
      className={buttonClass.primary}
    >
      <Icon name="upload" /> Publish
    </button>
  );
  return (
    <>
      <AppHome
        app="Functions"
        icon="code"
        accent="#0ea5e9"
        href="/functions"
        tagline="Published Python functions and queries, versioned by release and callable across the platform."
        description={
          <>
            Python functions written in{" "}
            <Link href="/code-repositories" className="text-ocean hover:underline">
              Code Repositories
            </Link>{" "}
            and published by tagging a release. Use them in action types, Automate, Workshop and through the API gateway.
          </>
        }
        noun={["function", "functions"]}
        error={error}
        onSearch={setQ}
        items={
          rows?.map((f) => ({
            id: f.id,
            href: `/functions/${f.id}`,
            title: f.name,
            updated_at: f.released_at,
            detail: [f.doc?.split("\n")[0], signature(f)].filter(Boolean).join(" — "),
            badges: [
              { label: KIND_LABEL[f.kind], tone: f.kind === "query" ? ("ocean" as const) : f.kind === "edit" ? ("sand" as const) : ("muted" as const) },
              ...(f.source === "model" ? [{ label: "Model", tone: "ocean" as const }] : []),
              { label: `v${f.version}`, tone: "muted" as const },
              ...(f.failed ? [{ label: `${f.failed} failed`, tone: "bad" as const }] : []),
            ],
            meta: `${f.succeeded ?? 0} runs (30d)${f.api_name ? ` · ${f.api_name}` : ""}`,
          })) ?? null
        }
        stats={[
          { label: "Functions", value: (rows?.length ?? 0).toLocaleString() },
          { label: "Queries", value: (rows ?? []).filter((f) => f.kind === "query").length.toLocaleString() },
          { label: "Runs (30d)", value: (rows ?? []).reduce((n, f) => n + (f.succeeded ?? 0), 0).toLocaleString() },
          { label: "Failed (30d)", value: (rows ?? []).reduce((n, f) => n + (f.failed ?? 0), 0).toLocaleString() },
        ]}
        toolbar={
          <div className="w-40">
            <select value={kind} onChange={(e) => setKind(e.target.value)} className={`${inputClass} py-1.5 text-xs`} aria-label="Kind">
              <option value="">All kinds</option>
              {Object.entries(KIND_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        }
        filter={kindFilter}
        lead={<FunctionIntegration canRunCode={!noCode} />}
        empty={{ title: "Publish your first functions", hint: "Decorate Python code with @function, then tag a release of the repository (for example 1.0.0).", steps: ["Write @function code in a repository", "Tag a release or press Publish", "Use it in actions, Automate and Workshop"] }}
        create={
          <>
            {publish}
            <button type="button" onClick={() => setTab("gateway")} className={buttonClass.secondary}>
              <Icon name="plug" className="h-3.5 w-3.5" /> API gateway
            </button>
            <button type="button" onClick={() => setTab("preview")} className={buttonClass.secondary}>
              <Icon name="play" className="h-3.5 w-3.5" /> Live preview
            </button>
            <Link href="/code-repositories" className={buttonClass.secondary}>
              <Icon name="code" className="h-3.5 w-3.5" /> Code Repositories
            </Link>
          </>
        }
      />
      {tab && (
        <Modal title={tab === "gateway" ? "API gateway" : "Live preview"} icon={tab === "gateway" ? "plug" : "play"} onClose={() => setTab(null)} xl>
          <div className="max-h-[75vh] overflow-y-auto px-5 pb-5">
            {tab === "gateway" ? <Gateway /> : <Preview />}
          </div>
        </Modal>
      )}
      {publishing && (
        <PublishDialog
          onClose={() => setPublishing(false)}
          onDone={() => {
            setPublishing(false);
            load();
          }}
        />
      )}
    </>
  );
}

function PublishDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [repo, setRepo] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [strict, setStrict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [release, setRelease] = useState<Release | null>(null);
  const [previous, setPrevious] = useState<Release[]>([]);
  useEffect(() => {
    codeRepos.list().then(
      (r) => {
        setRepos(r);
        if (r[0]) setRepo((cur) => cur || r[0].id);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(() => {
    if (repo) functions.releases(repo).then(setPrevious, () => setPrevious([]));
  }, [repo]);
  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      setRelease(await functions.publish(repo, version.trim(), undefined, strict));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Publish functions" icon="upload" onClose={onClose}>
      {release ? (
        <div className="space-y-3 p-4 text-sm">
          <div className="rounded-md bg-ok/10 px-3 py-2 text-ok">
            Published {release.functions.length} function{release.functions.length === 1 ? "" : "s"} at version {release.version}.
          </div>
          {release.breaking.length > 0 && (
            <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
              Breaking changes without a major version bump:
              <ul className="mt-1 list-disc pl-4">
                {release.breaking.map((b) => (
                  <li key={`${b.function}:${b.change}`}>
                    {b.function}: {b.change}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ul className="space-y-1 font-mono text-xs text-soft">
            {release.functions.map((f) => (
              <li key={f.id}>{signature(f)}</li>
            ))}
          </ul>
          <div className="flex justify-end">
            <button type="button" onClick={onDone} className={buttonClass.primary}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            publish();
          }}
        >
          <p className="text-sm text-muted">Tagging a release in Code Repositories publishes automatically. Here you can publish the default branch&apos;s head directly.</p>
          <Field label="Repository">
            <select value={repo} onChange={(e) => setRepo(e.target.value)} className={inputClass}>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Version" hint={previous[0] ? `Latest: ${previous[0].version}. Semantic versions; -rc.1 style suffixes publish pre-releases.` : "Semantic version, e.g. 1.0.0 or 1.1.0-rc.1"}>
            <input value={version} onChange={(e) => setVersion(e.target.value)} className={`${inputClass} font-mono`} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} /> Fail on breaking changes without a major version bump
          </label>
          <ErrorBox message={error} />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={buttonClass.secondary}>
              Cancel
            </button>
            <button type="submit" disabled={busy || !repo || !version.trim()} className={buttonClass.primary}>
              {busy ? "Publishing…" : "Publish"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function Gateway() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof functions.queries>> | null>(null);
  useEffect(() => {
    functions.queries().then(setRows, () => setRows([]));
  }, []);
  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm text-muted">
        Queries with an API name are callable over HTTP: <code className="rounded bg-panel-2 px-1">POST /api/functions/queries/&lt;api name&gt;/execute</code> with{" "}
        <code className="rounded bg-panel-2 px-1">{`{"inputs": {...}, "version": "^1.0.0"}`}</code>, from the Nexus SDK in code and from external applications.
      </p>
      <Card title="Queries" count={rows?.length}>
        <div className="divide-y divide-line text-sm">
          {rows?.map((r) => (
            <Link key={r.api_name} href={`/functions/${r.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-panel-2">
              <span className="font-mono text-ocean">{r.api_name}</span>
              <span className="truncate font-mono text-xs text-soft">{signature(r)}</span>
              <span className="ml-auto font-mono text-xs text-muted">{r.version}</span>
            </Link>
          ))}
          {rows?.length === 0 && <p className="px-4 py-4 text-sm text-muted">No queries yet. Give a function an API name with @query(api_name=&quot;…&quot;).</p>}
        </div>
      </Card>
    </div>
  );
}

function Preview() {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [fns, setFns] = useState<FnSignature[] | null>(null);
  const [fn, setFn] = useState<FnSignature | null>(null);
  const [inputs, setInputs] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<Awaited<ReturnType<typeof functions.preview>> | null>(null);
  useEffect(() => {
    codeRepos.list().then((r) => setRepos(r), () => setRepos([]));
  }, []);
  const discover = async () => {
    setBusy(true);
    setError(null);
    setFn(null);
    setOut(null);
    try {
      const r = await functions.preview({ repo_id: repo, branch: branch || undefined });
      setFns(r.functions ?? []);
      if (r.error) setError(r.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    if (!fn) return;
    setBusy(true);
    setError(null);
    try {
      setOut(await functions.preview({ repo_id: repo, branch: branch || undefined, file: fn.file, function: fn.name, inputs: JSON.parse(inputs || "{}") }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm text-muted">Run the functions on a branch&apos;s latest commit before publishing. Nexus edits are returned, not applied.</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Repository">
          <select value={repo} onChange={(e) => setRepo(e.target.value)} className={`${inputClass} w-64`}>
            <option value="">Pick a repository…</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Branch">
          <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={repos.find((r) => r.id === repo)?.default_branch ?? "master"} className={`${inputClass} w-48`} />
        </Field>
        <button type="button" disabled={!repo || busy} onClick={discover} className={buttonClass.secondary}>
          <Icon name="search" className="h-3.5 w-3.5" /> Discover functions
        </button>
      </div>
      {fns && (
        <div className="grid gap-4 md:grid-cols-[280px_1fr]">
          <Card title="Functions" count={fns.length}>
            <div className="divide-y divide-line text-sm">
              {fns.map((f) => (
                <button
                  key={`${f.file}:${f.name}`}
                  type="button"
                  onClick={() => {
                    setFn(f);
                    setOut(null);
                    setInputs(JSON.stringify(Object.fromEntries(f.inputs.map((i) => [i.name, i.default ?? null])), null, 2));
                  }}
                  className={`block w-full px-4 py-2 text-left hover:bg-panel-2 ${fn?.name === f.name && fn.file === f.file ? "bg-panel-2" : ""}`}
                >
                  <div className="font-medium">{f.name}</div>
                  <div className="text-xs text-muted">
                    {f.file}:{f.line} · {KIND_LABEL[f.kind]}
                  </div>
                </button>
              ))}
              {fns.length === 0 && <p className="px-4 py-3 text-xs text-muted">No decorated functions on this branch.</p>}
            </div>
          </Card>
          {fn && (
            <Card title={fn.name}>
              <div className="space-y-3 p-4 text-sm">
                <div className="font-mono text-xs text-soft">{signature(fn)}</div>
                <Field label="Inputs (JSON)">
                  <textarea value={inputs} onChange={(e) => setInputs(e.target.value)} rows={6} className={`${inputClass} font-mono text-xs`} />
                </Field>
                <button type="button" disabled={busy} onClick={run} className={buttonClass.primary}>
                  <Icon name="play" className="h-3.5 w-3.5" /> {busy ? "Running…" : "Run"}
                </button>
                {out && <ResultView ok={!!out.ok} value={out.value} edits={out.edits} error={out.error} logs={out.logs} />}
              </div>
            </Card>
          )}
        </div>
      )}
      <ErrorBox message={error} />
    </div>
  );
}
