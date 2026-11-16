"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { ActionMenu } from "@/components/kg/parts";
import { AppHome } from "@/components/AppHome";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { workshop, type Module } from "@/lib/workshop";
import { FolderPicker, InstallDialog } from "@/components/workshop/PlatformPanels";
import { alertDialog, confirmDialog } from "@/lib/dialogs";
import { promoteWorkshopApp, readPromotedWorkshopApps, unpromoteWorkshopApp } from "@/lib/platformApps";

export default function WorkshopPage() {
  const router = useRouter();
  const [items, setItems] = useState<Module[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [creating, setCreating] = useState(false);
  const [promotedIds, setPromotedIds] = useState<string[]>(() => (typeof window === "undefined" ? [] : readPromotedWorkshopApps().map((app) => app.id ?? "")));
  const load = useCallback(() => {
    workshop
      .modules()
      .then((ms) => {
        // opened from Files (?item=<Files item>): go to that module
        const item = new URLSearchParams(window.location.search).get("item");
        const hit = item ? ms.find((m) => m.item_id === item) : undefined;
        if (hit) router.replace(`/workshop/${hit.id}`);
        setItems(ms);
      })
      .catch((e: Error) => setError(e.message));
  }, [router]);
  useEffect(load, [load]);

  const create = async (name: string, folder: string) => {
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      const m = await workshop.create({ name: name.trim() || `Workshop module - ${stamp}`, ...(folder ? { folder_id: folder } : {}) });
      router.push(`/workshop/${m.id}?edit=1`);
    } catch (e) {
      void alertDialog((e as Error).message);
    }
  };

  const togglePromotion = (m: Module) => {
    const id = `workshop:${m.id}`;
    if (promotedIds.includes(id)) {
      unpromoteWorkshopApp(id);
      setPromotedIds((ids) => ids.filter((item) => item !== id));
    } else {
      promoteWorkshopApp({
        id,
        name: m.name,
        description: m.description || "A trusted operational application built with Workshop.",
        icon: "device",
        href: `/workshop/${m.id}`,
        owner: "BluesandAI",
        collection: "Workshop applications",
        tags: ["Workshop", "Operational"],
        trusted: true,
      });
      setPromotedIds((ids) => [...ids, id]);
    }
  };

  return (
    <div className="foundry-light flex min-h-0 flex-1 flex-col">
      <AppHome
        app="Workshop"
        icon="device"
        accent="#0ea5e9"
        href="/workshop"
        tagline="Dashboards and operational apps built by dragging widgets onto a grid."
        description={
          <>
            Build dashboards and operational apps by dragging tables, charts, metrics, filters and action buttons onto a grid. Widgets read{" "}
            <Link href="/pipeline" className="text-ocean hover:underline">
              pipeline datasets
            </Link>{" "}
            and{" "}
            <Link href="/ontology" className="text-ocean hover:underline">
              ontology objects
            </Link>
            .
          </>
        }
        noun={["module", "modules"]}
        items={
          items?.map((m) => {
            const promoted = promotedIds.includes(`workshop:${m.id}`);
            return {
              id: m.id,
              href: `/workshop/${m.id}`,
              title: m.name,
              path: m.path?.map((p) => p.name),
              updated_at: m.updated_at,
              detail: m.description || undefined,
              badges: [
                ...(m.favorite ? [{ label: "★ Favorite", tone: "warn" as const }] : []),
                ...(promoted ? [{ label: "Platform Apps", tone: "ocean" as const }] : []),
                ...(m.path ? [] : [{ label: "Not in a Project yet", tone: "muted" as const }]),
              ],
              meta: `${m.widgets.length} ${m.widgets.length === 1 ? "widget" : "widgets"}`,
              actions: (
                <ActionMenu
                  items={[
                    { label: "View", icon: "eye", onClick: () => router.push(`/workshop/${m.id}`) },
                    { label: "Edit", icon: "pencil", onClick: () => router.push(`/workshop/${m.id}?edit=1`) },
                    { label: promoted ? "Unpromote from Platform Apps" : "Promote to Platform Apps", icon: promoted ? "star" : "check", onClick: () => togglePromotion(m) },
                    "divider",
                    {
                      label: "Delete",
                      icon: "trash",
                      danger: true,
                      onClick: async () => {
                        if (!(await confirmDialog(`Delete "${m.name}"?`))) return;
                        await workshop.remove(m.id);
                        load();
                      },
                    },
                  ]}
                />
              ),
            };
          }) ?? null
        }
        error={error}
        empty={{
          title: "Create your first module",
          hint: "For example: monthly revenue by country, with a table of subscriptions.",
          steps: ["Name the module and pick its Project", "Drag tables, charts and filters onto the grid", "Wire variables and action buttons"],
        }}
        headerActions={
          <button type="button" onClick={() => setInstalling(true)} className={buttonClass.secondary} data-install>
            <Icon name="download" /> Install product
          </button>
        }
        create={
          <button type="button" onClick={() => setCreating(true)} className={buttonClass.primary} data-new-module>
            <Icon name="plus" /> New module
          </button>
        }
      />
      {creating && <NewModuleDialog onClose={() => setCreating(false)} onCreate={create} />}
      {installing && <InstallDialog onClose={() => setInstalling(false)} onInstalled={(m) => router.push(`/workshop/${m.id}?edit=1`)} />}
    </div>
  );
}

/** A new module: its name and where it lives — a Project (or a folder in it) the user edits; none: My Project. */
function NewModuleDialog({ onCreate, onClose }: { onCreate: (name: string, folder: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="New module" icon="device" onClose={onClose}>
      <form
        className="space-y-3 p-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void onCreate(name, folder).finally(() => setBusy(false));
        }}
        data-new-module-dialog
      >
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-soft">Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Workshop module" className={inputClass} data-new-module-name />
        </label>
        <div>
          <span className="mb-1 block text-xs font-medium text-soft">Location</span>
          <FolderPicker value={folder} onChange={setFolder} />
          <span className="mt-1 block text-[11px] text-muted">A Project you edit; none: My Project.</span>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={buttonClass.primary} data-new-module-create>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
