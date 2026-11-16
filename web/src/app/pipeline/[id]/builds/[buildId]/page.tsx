"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { BuildDetails } from "@/components/pipeline/Builds";
import { BuildActions, BuildCompare } from "@/components/pipeline/BuildTools";
import { isActive, runtime, type BuildRecord } from "@/lib/runtime";

/** Build progress page: follow a build until its outputs are ready. */
export default function BuildPage() {
  const { id, buildId } = useParams<{ id: string; buildId: string }>();
  const [build, setBuild] = useState<BuildRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      runtime.get(buildId).then(
        (b) => {
          if (!live) return;
          setBuild(b);
          if (isActive(b)) timer = setTimeout(load, 1200);
        },
        (e: Error) => live && setError(e.message),
      );
    load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [buildId]);
  return (
    <div className="flex-1 overflow-y-auto">
      <header className="flex h-14 items-center gap-2 border-b border-line bg-panel px-5 text-sm">
        <Link href="/builds" className="text-muted hover:text-white">
          Builds
        </Link>
        <Icon name="right" className="h-3.5 w-3.5 text-muted" />
        <Link href={`/pipeline/${id}`} className="text-muted hover:text-white">
          {build?.pipeline_name ?? "Pipeline"}
        </Link>
        <Icon name="right" className="h-3.5 w-3.5 text-muted" />
        <span className="font-medium">Build progress</span>
        <span className="ml-2 font-mono text-xs text-muted">{buildId}</span>
      </header>
      <div className="mx-auto max-w-4xl p-6">
        {error && <p className="text-sm text-bad">{error}</p>}
        {!build && !error && <p className="text-sm text-muted">Loading…</p>}
        {build && (
          <BuildDetails
            build={build}
            onCancel={() =>
              runtime
                .cancel(build.id)
                .then(setBuild)
                .catch((e: Error) => setError(e.message))
            }
          />
        )}
        {build && !isActive(build) && build.status === "succeeded" && (
          <p className="mt-4 text-sm text-ok">
            <Icon name="check" className="mr-1 inline h-4 w-4" /> Your outputs are ready — open them from the paths above, or from Files &amp; Projects.
          </p>
        )}
        {build && (
          <div className="mt-6 space-y-4 border-t border-line pt-4">
            <BuildActions build={build} />
            {!build.streaming && (
              <div>
                <h2 className="mb-2 text-sm font-semibold">Compare with the last successful build</h2>
                <BuildCompare build={build} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
