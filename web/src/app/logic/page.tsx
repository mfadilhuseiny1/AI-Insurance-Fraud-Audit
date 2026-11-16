"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { ActionMenu } from "@/components/kg/parts";
import { buttonClass } from "@/components/pipeline/Modal";
import { ontology, type LogicFunction } from "@/lib/ontology";
import { alertDialog, confirmDialog } from "@/lib/dialogs";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default function AipLogicPage() {
  const router = useRouter();
  const [items, setItems] = useState<LogicFunction[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    ontology
      .logicList()
      .then(setItems)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const create = async () => {
    try {
      const fn = await ontology.createLogic({ name: "Untitled Logic" });
      router.push(`/logic/${fn.id}`);
    } catch (e) {
      void alertDialog((e as Error).message);
    }
  };

  return (
    <AppHome
      app="AIP Logic"
      icon="logic"
      accent="#6366f1"
      href="/logic"
      tagline="No-code functions that read objects and documents, call LLMs and write back through actions."
      description={
        <>
          No-code functions that read objects and documents, call LLMs and write back to the ontology through actions. Run them by hand, or from{" "}
          <Link href="/automate" className="text-ocean hover:underline">
            Automate
          </Link>{" "}
          when objects change.
        </>
      }
      noun={["Logic function", "Logic functions"]}
      items={
        items?.map((fn) => ({
          id: fn.id,
          href: `/logic/${fn.id}`,
          title: fn.name,
          updated_at: fn.updated_at,
          detail: fn.description || undefined,
          badges: fn.last_run ? [{ label: `Last run ${fn.last_run.status.replace("_", " ")}`, tone: fn.last_run.status === "failed" ? ("bad" as const) : fn.last_run.status === "succeeded" ? ("ok" as const) : ("muted" as const) }] : [],
          meta: [plural(fn.inputs.length, "input"), plural(fn.blocks.length, "block"), plural(fn.run_count, "run")].join(" · "),
          actions: (
            <ActionMenu
              items={[
                { label: "Open", icon: "external", onClick: () => router.push(`/logic/${fn.id}`) },
                "divider",
                {
                  label: "Delete",
                  icon: "trash",
                  danger: true,
                  onClick: async () => {
                    if (!(await confirmDialog(`Delete "${fn.name}"? Automations that run it will fail.`))) return;
                    await ontology.deleteLogic(fn.id);
                    load();
                  },
                },
              ]}
            />
          ),
        })) ?? null
      }
      error={error}
      empty={{
        title: "Create your first Logic function",
        hint: "For example: extract a PDF's text and save it on the object.",
        steps: ["Declare the inputs: objects, documents, values", "Chain blocks: LLM calls, transforms, actions", "Run it by hand or from Automate"],
      }}
      create={
        <button type="button" onClick={create} className={buttonClass.primary}>
          <Icon name="plus" /> New Logic
        </button>
      }
    />
  );
}
