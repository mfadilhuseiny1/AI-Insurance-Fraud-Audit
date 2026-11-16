"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { forms } from "@/lib/forms";

type Row = Awaited<ReturnType<typeof forms.list>>[number];

/** Forms [Sunset]: guided data-entry forms written to Fusion or the Ontology. */
export default function FormsHome() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("Untitled form");
  useEffect(() => {
    forms.list().then(setRows, (e: Error) => setError(e.message));
  }, []);
  return (
    <AppHome
      app="Forms (Sunset)"
      icon="doc"
      accent="#f59e0b"
      href="/forms"
      tagline="Guided data entry written to a Fusion table or a Nexus object type — in sunset, Actions are preferred."
      description={
        <>
          Guided data entry with dynamic fields, validators, transforms and multiple entries, written to a Fusion table or an Nexus object type. Forms is in sunset: prefer{" "}
          <Link href="/ontology?tab=action-types" className="text-ocean hover:underline">
            Actions
          </Link>{" "}
          for new writeback workflows.
        </>
      }
      noun={["form", "forms"]}
      items={
        rows?.map((f) => ({
          id: f.id,
          href: `/forms/${f.id}`,
          title: f.name.replace(/\.form$/, ""),
          path: (f.path ?? []).map((p) => p.name),
          updated_at: f.updated_at,
          meta: `${f.responses} ${f.responses === 1 ? "response" : "responses"}`,
          actions: (
            <Link href={`/forms/${f.id}/fill`} className={buttonClass.secondary}>
              Fill
            </Link>
          ),
        })) ?? null
      }
      error={error}
      empty={{ title: "Build your first form", hint: "Forms is in sunset — for new writeback prefer Actions. A form still guides data entry into Fusion or Nexus.", steps: ["Name the form", "Add fields and validators", "Publish it and fill it"] }}
      create={
        <>
          <div className="w-64">
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} aria-label="Title" />
          </div>
          <button
            type="button"
            disabled={!title.trim()}
            onClick={async () => {
              try {
                const f = await forms.create(title.trim());
                router.push(`/forms/${f.item.id}`);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className={buttonClass.primary}
          >
            <Icon name="plus" className="h-3.5 w-3.5" /> New form
          </button>
        </>
      }
    />
  );
}
