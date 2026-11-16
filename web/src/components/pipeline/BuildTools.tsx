"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { when } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import { isActive, runtime, type BuildComparison, type BuildRecord, type LogicVersion } from "@/lib/runtime";
import { Icon } from "../Icon";
import { StatusBadge } from "./Builds";
import { buttonClass, Modal } from "./Modal";

/** Debugging a build: download its logs, rerun it (optionally with an earlier logic version), explain a failure with AI. */
export function BuildActions({ build }: { build: BuildRecord }) {
  const router = useRouter();
  const [rerunOpen, setRerunOpen] = useState(false);
  const [explain, setExplain] = useState<{ busy: boolean; answer?: string; error?: string } | null>(null);
  const failed = build.status === "failed";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <a href={runtime.logsUrl(build.id)} download className={`${buttonClass.secondary} py-1 text-xs`}>
        <Icon name="download" className="h-3.5 w-3.5" /> Download logs
      </a>
      {!isActive(build) && (
        <button type="button" onClick={() => setRerunOpen(true)} className={`${buttonClass.secondary} py-1 text-xs`}>
          <Icon name="refresh" className="h-3.5 w-3.5" /> Rerun…
        </button>
      )}
      {failed && (
        <button
          type="button"
          disabled={explain?.busy}
          onClick={() => {
            setExplain({ busy: true });
            runtime.explain(build.id).then(
              (r) => setExplain({ busy: false, answer: r.answer }),
              (e: Error) => setExplain({ busy: false, error: e.message }),
            );
          }}
          className={`${buttonClass.secondary} py-1 text-xs`}
        >
          <Icon name={explain?.busy ? "refresh" : "sparkle"} className={`h-3.5 w-3.5 ${explain?.busy ? "animate-spin" : ""}`} /> {explain?.busy ? "Explaining…" : "Explain this error"}
        </button>
      )}
      {explain && !explain.busy && (
        <div className="w-full rounded-md border border-ocean/40 bg-ocean/5 p-3 text-sm">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ocean">
            <Icon name="sparkle" className="h-3.5 w-3.5" /> AIP Assist
            <button type="button" onClick={() => setExplain(null)} className="ml-auto text-muted hover:text-white">
              <Icon name="x" className="h-3.5 w-3.5" />
            </button>
          </div>
          {explain.error ? <p className="text-xs text-bad">{explain.error}</p> : <div className="md-body text-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(explain.answer ?? "") }} />}
        </div>
      )}
      {rerunOpen && (
        <RerunDialog
          build={build}
          onClose={() => setRerunOpen(false)}
          onStarted={(b) => {
            setRerunOpen(false);
            router.push(`/pipeline/${b.pipeline_id}/builds/${b.id}`);
          }}
        />
      )}
    </div>
  );
}

function RerunDialog({ build, onClose, onStarted }: { build: BuildRecord; onClose: () => void; onStarted: (b: BuildRecord) => void }) {
  const [versions, setVersions] = useState<LogicVersion[] | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    runtime.logicVersions(build.id).then(setVersions, (e: Error) => setError(e.message));
  }, [build.id]);
  return (
    <Modal title="Rerun build" icon="refresh" onClose={onClose}>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-xs text-muted">
          Builds the same outputs on <b className="text-soft">{build.branch || "main"}</b> from the latest input data
          {build.run_setup ? ` (run setup ${build.run_setup.name})` : ""}. Pick an earlier saved version to build the logic as it was then — for example to check whether a change caused a failure.
        </p>
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          <li>
            <label className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs ${chosen === "" ? "border-ocean bg-ocean/10" : "border-line-2"}`}>
              <input type="radio" checked={chosen === ""} onChange={() => setChosen("")} className="mt-0.5 accent-[var(--color-ocean)]" />
              <span>
                <span className="block text-soft">Latest logic</span>
                <span className="block text-muted">What a deploy would build now</span>
              </span>
            </label>
          </li>
          {versions?.map((v) => (
            <li key={v.id}>
              <label className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs ${chosen === v.id ? "border-ocean bg-ocean/10" : "border-line-2"}`}>
                <input type="radio" checked={chosen === v.id} onChange={() => setChosen(v.id)} className="mt-0.5 accent-[var(--color-ocean)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-soft">{v.message || "Saved"}</span>
                  <span className="block text-muted">
                    {v.author} · {when(v.at)}
                    {v.latest ? " · latest" : ""}
                    {v.used_by_build ? " · this build's version" : ""}
                  </span>
                </span>
              </label>
            </li>
          ))}
          {versions?.length === 0 && <li className="text-xs text-muted">No saved versions on this branch: only the latest logic can be built.</li>}
        </ul>
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              runtime.rerun(build.id, chosen || undefined).then(onStarted, (e: Error) => {
                setError(e.message);
                setBusy(false);
              });
            }}
            className={buttonClass.primary}
          >
            <Icon name="play" className="h-3.5 w-3.5" /> Rerun
          </button>
        </div>
      </div>
    </Modal>
  );
}

const CHANGE_TONE = { added: "text-ok", removed: "text-bad", changed: "text-warn", same: "text-muted" } as const;
const short = (v?: string | null) => (v ? (v.length > 24 ? `${v.slice(0, 22)}…` : v) : "—");

/** The build next to the last successful build of the same pipeline and branch: inputs, logic, rows. */
export function BuildCompare({ build }: { build: BuildRecord }) {
  const [cmp, setCmp] = useState<BuildComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = !isActive(build);
  useEffect(() => {
    if (!done) return;
    runtime.compare(build.id).then(setCmp, (e: Error) => setError(e.message));
  }, [build.id, done]);
  if (!done) return null;
  if (error) return <p className="text-xs text-bad">{error}</p>;
  if (!cmp) return <p className="text-xs text-muted">Comparing with the last successful build…</p>;
  if (!cmp.previous) return <p className="text-xs text-muted">No earlier successful build of this pipeline on {build.branch || "main"} to compare with.</p>;
  const p = cmp.previous;
  const changedInputs = (cmp.inputs ?? []).filter((i) => i.change !== "same");
  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted">Compared with the last successful build</span>
        <Link href={`/pipeline/${p.pipeline_id}/builds/${p.id}`} className="font-mono text-ocean hover:underline">
          {p.id.slice(6)}
        </Link>
        <StatusBadge status={p.status} spin={false} />
        <span className="text-muted">{when(p.created_at)}</span>
        {cmp.seconds?.now !== null && cmp.seconds?.previous !== null && (
          <span className="ml-auto text-muted">
            duration {cmp.seconds?.now}s vs {cmp.seconds?.previous}s
          </span>
        )}
      </div>
      <div className="rounded-md border border-line-2 p-2">
        <div className="mb-1 font-medium text-soft">Logic</div>
        {cmp.logic?.changed ? (
          <>
            <p className="text-warn">
              Changed since that build ({short(cmp.logic.previous_hash)} → {short(cmp.logic.hash)})
              {cmp.logic.version && ` · this build used the version saved ${when(cmp.logic.version.at)}`}
            </p>
            <ul className="mt-1 space-y-0.5">
              {cmp.logic.changes.map((c, i) => (
                <li key={i} className={CHANGE_TONE[c.change]}>
                  {c.change} {c.kind} <span className="text-soft">{c.name}</span>
                </li>
              ))}
              {!cmp.logic.changes.length && <li className="text-muted">The changed nodes are unknown: one of the builds ran from an unsaved working copy.</li>}
            </ul>
          </>
        ) : (
          <p className="text-ok">Same logic ({short(cmp.logic?.hash)})</p>
        )}
      </div>
      <div className="rounded-md border border-line-2 p-2">
        <div className="mb-1 font-medium text-soft">Input versions</div>
        {!changedInputs.length ? (
          <p className="text-ok">No input changed ({cmp.inputs?.length ?? 0} inputs)</p>
        ) : (
          <table className="w-full">
            <tbody>
              {changedInputs.map((i) => (
                <tr key={i.id} className="border-t border-line first:border-0">
                  <td className="py-0.5 pr-2 text-soft">{i.name}</td>
                  <td className="pr-2 text-muted">{i.kind}</td>
                  <td className={`pr-2 ${CHANGE_TONE[i.change]}`}>{i.change}</td>
                  <td className="font-mono text-muted" title={`${i.previous ?? ""} → ${i.version ?? ""}`}>
                    {short(i.previous)} → {short(i.version)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!!cmp.parameters?.some((x) => x.value !== x.previous) && (
        <div className="rounded-md border border-line-2 p-2">
          <div className="mb-1 font-medium text-soft">Parameters</div>
          {cmp.parameters
            .filter((x) => x.value !== x.previous)
            .map((x) => (
              <p key={x.name} className="text-warn">
                {x.name}: {x.previous ?? "default"} → {x.value ?? "default"}
              </p>
            ))}
        </div>
      )}
      <div className="rounded-md border border-line-2 p-2">
        <div className="mb-1 font-medium text-soft">Outputs</div>
        <table className="w-full">
          <thead className="text-left text-muted">
            <tr>
              <th className="font-normal">Output</th>
              <th className="font-normal">This build</th>
              <th className="font-normal">Last successful</th>
              <th className="text-right font-normal">Rows Δ</th>
            </tr>
          </thead>
          <tbody>
            {(cmp.outputs ?? []).map((o) => (
              <tr key={o.id} className="border-t border-line">
                <td className="py-0.5 pr-2 text-soft">{o.name}</td>
                <td className="pr-2">{o.now ? `${o.now.status}${o.now.rows !== undefined ? ` · ${o.now.rows.toLocaleString()} rows` : ""}` : "—"}</td>
                <td className="pr-2 text-muted">{o.previous ? `${o.previous.status}${o.previous.rows !== undefined ? ` · ${o.previous.rows.toLocaleString()} rows` : ""}` : "—"}</td>
                <td className={`text-right ${o.rows_delta ? (o.rows_delta > 0 ? "text-ok" : "text-warn") : "text-muted"}`}>
                  {o.rows_delta === null ? "—" : `${o.rows_delta > 0 ? "+" : ""}${o.rows_delta.toLocaleString()}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
