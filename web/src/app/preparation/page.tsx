"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { buttonClass } from "@/components/pipeline/Modal";
import { when } from "@/lib/format";
import { preparation } from "@/lib/preparation";

/** Preparation [Sunset]: the preparations you can open, and "Select a dataset…" to start one. */
export default function PreparationHome() {
  const router = useRouter();
  const [list, setList] = useState<Awaited<ReturnType<typeof preparation.list>> | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    preparation.list().then(setList, (e: Error) => (setList([]), setError(e.message)));
  }, []);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="rounded-md bg-sand/15 p-1.5 text-sand">
            <Icon name="transform" className="h-4 w-4" />
          </span>
          Preparation
        </div>
        <span className="text-xs text-muted">Clean and prepare datasets</span>
        <button type="button" onClick={() => setPicking(true)} className={`${buttonClass.primary} ml-auto`}>
          <Icon name="plus" className="h-3.5 w-3.5" /> Select a dataset…
        </button>
      </header>
      <div className="flex items-center gap-3 border-b border-line bg-warn/10 px-5 py-2 text-xs text-warn">
        <Icon name="alert" className="h-4 w-4 shrink-0" />
        <span>
          <strong>Preparation is in sunset.</strong> For new workflows, use Pipeline Builder to clean and prepare data. Existing preparations remain fully supported.
        </span>
        <Link href="/pipeline" className="ml-auto text-sand hover:underline">
          Open Pipeline Builder
        </Link>
      </div>
      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl">
          {error && <p className="mb-3 text-xs text-bad">{error}</p>}
          {list === null && <p className="text-sm text-muted">Loading…</p>}
          {list?.length === 0 && (
            <div className="rounded-xl border-2 border-dashed border-line-2 p-12 text-center text-sm text-muted">
              No preparations yet. Select a dataset, or choose Clean in Preparation on a dataset in Dataset Preview.
            </div>
          )}
          <div className="space-y-2">
            {list?.map((p) => (
              <Link key={p.id} href={`/preparation/${p.id}`} className="flex items-center gap-3 rounded-lg border border-line bg-panel p-3 hover:border-ocean/50">
                <Icon name="transform" className="h-4 w-4 text-sand" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-soft">{p.name}</span>
                  <span className="block truncate text-[11px] text-muted">
                    {p.autosaved ? "Unsaved · Files › .auto-save" : p.path.join(" / ")} · {p.changes} changes · {p.outputs} output{p.outputs === 1 ? "" : "s"}
                  </span>
                </span>
                <span className="text-[11px] text-muted">{when(p.updated_at)}</span>
              </Link>
            ))}
          </div>
        </div>
      </main>
      {picking && (
        <DrivePicker
          title="Select a dataset to clean"
          canPick={(i) => (i.kind === "file" && /\.(parquet|csv|tsv|json|jsonl)$/i.test(i.name) ? null : "Pick a dataset")}
          onPick={async (i) => {
            setPicking(false);
            try {
              const p = await preparation.create(i.id);
              router.push(`/preparation/${p.id}`);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
