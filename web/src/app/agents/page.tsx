"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { ActionMenu } from "@/components/kg/parts";
import { buttonClass } from "@/components/pipeline/Modal";
import { agentsApi, type Agent } from "@/lib/agents";
import { alertDialog, confirmDialog } from "@/lib/dialogs";

export default function AgentStudioPage() {
  const router = useRouter();
  const [items, setItems] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    agentsApi
      .list()
      .then(setItems)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const create = async () => {
    try {
      const a = await agentsApi.create({ name: "Untitled agent" });
      router.push(`/agents/${a.id}?edit=1`);
    } catch (e) {
      void alertDialog((e as Error).message);
    }
  };

  return (
    <AppHome
      app="AIP Agent Studio"
      icon="sparkle"
      accent="#a855f7"
      href="/agents"
      tagline="Assistants that answer questions about your data, cite the objects they used and act through tools."
      description={
        <>
          Assistants that answer questions about your{" "}
          <Link href="/ontology" className="text-ocean hover:underline">
            ontology
          </Link>{" "}
          data, with citations to the objects they used, and can apply actions and run AIP Logic as tools.
        </>
      }
      noun={["agent", "agents"]}
      items={
        items?.map((a) => ({
          id: a.id,
          href: `/agents/${a.id}`,
          title: a.name,
          updated_at: a.updated_at,
          detail: a.description || undefined,
          meta: `${a.contexts.length} object ${a.contexts.length === 1 ? "type" : "types"} · ${a.session_count} ${a.session_count === 1 ? "conversation" : "conversations"}`,
          actions: (
            <ActionMenu
              items={[
                { label: "Chat", icon: "comment", onClick: () => router.push(`/agents/${a.id}`) },
                { label: "Edit", icon: "sliders", onClick: () => router.push(`/agents/${a.id}?edit=1`) },
                "divider",
                {
                  label: "Delete",
                  icon: "trash",
                  danger: true,
                  onClick: async () => {
                    if (!(await confirmDialog(`Delete "${a.name}" and its conversations?`))) return;
                    await agentsApi.remove(a.id);
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
        title: "Create your first agent",
        hint: "Give it object types as context, then ask it about them.",
        steps: ["Name the agent and write its instructions", "Add object types, actions and Logic as tools", "Chat with it"],
      }}
      create={
        <button type="button" onClick={create} className={buttonClass.primary}>
          <Icon name="plus" /> New agent
        </button>
      }
    />
  );
}
