"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppHome } from "@/components/AppHome";
import { Icon, type IconName } from "@/components/Icon";
import { NewMediaSetDialog } from "@/components/media/NewMediaSetDialog";
import { buttonClass } from "@/components/pipeline/Modal";
import { bytes, mediaSets, SCHEMA_ICON, type MediaSet } from "@/lib/mediaSets";

/** Media sets: store, transform and work with media files (images, documents, audio, video, DICOM, email,
 *  spreadsheets, or any format in a multimodal set). */
export default function MediaSetsPage() {
  const router = useRouter();
  const [items, setItems] = useState<MediaSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    mediaSets.list().then(setItems, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  return (
    <>
      <AppHome
        app="Media sets"
        icon="image"
        accent="#ec4899"
        href="/media-sets"
        tagline="Store, convert and work with media files: images, documents, audio, video, DICOM, email and more."
        description={
          <>
            Store and work with media files. A media set has a schema (documents, images, audio, video, DICOM, email, spreadsheets — or any format when multimodal) and a primary format;
            additional input formats are converted on upload. Use media sets as inputs and outputs in{" "}
            <Link href="/pipeline" className="text-ocean hover:underline">
              Pipeline Builder
            </Link>{" "}
            and{" "}
            <Link href="/code-repositories" className="text-ocean hover:underline">
              Code Repositories
            </Link>
            , as media reference properties in the{" "}
            <Link href="/ontology" className="text-ocean hover:underline">
              Nexus
            </Link>{" "}
            and in{" "}
            <Link href="/workshop" className="text-ocean hover:underline">
              Workshop
            </Link>
            .
          </>
        }
        headerActions={
          <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary}>
            <Icon name="plus" /> New media set
          </button>
        }
        noun={["media set", "media sets"]}
        items={
          items?.map((m) => ({
            id: m.id,
            href: `/media-sets/${m.id}`,
            title: m.name,
            path: m.path,
            updated_at: m.updated_at,
            icon: SCHEMA_ICON[m.schema] as IconName,
            badges: [
              { label: `${m.schema}${m.primary_format ? ` · .${m.primary_format}` : ""}`, tone: "ocean" as const },
              { label: m.transaction_policy, tone: "muted" as const },
              ...(m.virtual ? [{ label: "virtual", tone: "sand" as const }] : []),
              ...(m.built_by ? [{ label: `built by ${m.built_by === "code" ? "Code Repositories" : "Pipeline Builder"}`, tone: "muted" as const }] : []),
            ],
            meta: `${m.items.toLocaleString()} ${m.items === 1 ? "item" : "items"} · ${bytes(m.size)}`,
          })) ?? null
        }
        error={error}
        empty={{ title: "Create your first media set", hint: "Choose the kind of media it holds, then drag files into it.", steps: ["Click New media set", "Pick a schema and primary format", "Drag files into it"] }}
      />
      {creating && <NewMediaSetDialog onClose={() => setCreating(false)} onCreated={(m) => router.push(`/media-sets/${m.id}`)} />}
    </>
  );
}
