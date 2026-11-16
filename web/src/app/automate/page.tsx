"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { AutomationForm } from "@/components/ontology/AutomationForm";
import { AppHome, ago } from "@/components/AppHome";
import { buttonClass, Modal } from "@/components/pipeline/Modal";
import { describeCondition, describeEffect, ontology, type Automation, type LogicFunction, type ObjectType } from "@/lib/ontology";

function describeAutomation(a: Automation, types: Record<string, ObjectType>, fns: Record<string, LogicFunction>) {
  return `${describeCondition(a.condition, types)} → ${(a.effects?.length ? a.effects : [a.effect]).map((e) => describeEffect(e, fns)).join(", ")}`;
}

export default function AutomatePage() {
  // useSearchParams needs a Suspense boundary on a static page
  return (
    <Suspense>
      <Automations />
    </Suspense>
  );
}

function Automations() {
  const router = useRouter();
  const [items, setItems] = useState<Automation[] | null>(null);
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [fns, setFns] = useState<LogicFunction[]>([]);
  const [error, setError] = useState<string | null>(null);
  // ?new=<object type id> (from an object type's Automations tab) opens the new-automation form
  const newFor = useSearchParams().get("new");
  const [creating, setCreating] = useState<false | { objectType?: string }>(newFor ? { objectType: newFor } : false);

  const load = useCallback(() => {
    Promise.all([ontology.automations(), ontology.objectTypes(), ontology.logicList()])
      .then(([a, t, f]) => {
        setItems(a);
        setTypes(t);
        setFns(f);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const typeById = useMemo(() => Object.fromEntries(types.map((t) => [t.id, t])), [types]);
  const fnById = useMemo(() => Object.fromEntries(fns.map((f) => [f.id, f])), [fns]);

  return (
    <>
      <AppHome
        app="Automate"
        icon="bolt"
        accent="#84cc16"
        href="/automate"
        tagline="Run Logic or apply actions when objects change or on a schedule."
        description={
          <>
            When objects are added or modified, or on a schedule, run an{" "}
            <Link href="/logic" className="text-ocean hover:underline">
              AIP Logic
            </Link>{" "}
            function or apply an action.
          </>
        }
        noun={["automation", "automations"]}
        items={
          items?.map((a) => ({
            id: a.id,
            href: `/automate/${a.id}`,
            title: a.name,
            updated_at: a.updated_at,
            detail: describeAutomation(a, typeById, fnById),
            badges: [
              { label: a.enabled ? "Enabled" : "Paused", tone: a.enabled ? ("ok" as const) : ("muted" as const) },
              ...(a.last_run ? [{ label: `Last run ${a.last_run.status.replace("_", " ")} · ${ago(a.last_run.at)}`, tone: a.last_run.status === "failed" ? ("bad" as const) : a.last_run.status === "succeeded" ? ("ok" as const) : ("muted" as const) }] : []),
              ...(a.failed_runs ? [{ label: `${a.failed_runs} failed`, tone: "bad" as const }] : []),
            ],
            meta: `${a.run_count} ${a.run_count === 1 ? "run" : "runs"}`,
          })) ?? null
        }
        error={error}
        empty={{
          title: "Create your first automation",
          hint: "For example: run “AIP Logic – PDF Extract” whenever a PDF object is added.",
          steps: ["Pick a condition: objects added, modified or a schedule", "Choose the effect: a Logic function or an action", "Enable it and watch its runs"],
        }}
        create={
          <button type="button" onClick={() => setCreating({})} className={buttonClass.primary}>
            <Icon name="plus" /> New automation
          </button>
        }
      />
      {creating && (
        <Modal title="New automation" icon="bolt" onClose={() => setCreating(false)} wide>
          <div className="p-4">
            <AutomationForm initialObjectType={creating.objectType} onCancel={() => setCreating(false)} onSaved={(a) => router.push(`/automate/${a.id}`)} />
          </div>
        </Modal>
      )}
    </>
  );
}
