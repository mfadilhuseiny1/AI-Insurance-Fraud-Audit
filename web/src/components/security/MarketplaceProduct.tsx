"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Icon } from "../Icon";
import { buttonClass, fieldClass } from "../pipeline/Modal";

/** Save a packaged Marketplace product (JSON) as a file. */
export function downloadProduct(name: string, product: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(product, null, 1)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^A-Za-z0-9 _-]+/g, "_")}.product.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Install a Marketplace product file (checkpoint configuration or Cipher channel) into a Project (or one of its
 * folders): reads the file, asks for the target and calls `install`.
 */
export function InstallProduct({ kind, label, install }: { kind: string; label: string; install: (product: Record<string, unknown>, projectId: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [product, setProduct] = useState<Record<string, unknown> | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [project, setProject] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (open) api.drive.folder(null).then((f) => setProjects(f.items.filter((i) => i.kind === "project").map((i) => ({ id: i.id, name: i.name }))), () => {});
  }, [open]);
  if (!open)
    return (
      <button type="button" className={buttonClass.secondary} onClick={() => setOpen(true)}>
        <Icon name="upload" className="h-4 w-4" />
        {label}
      </button>
    );
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <input
        type="file"
        accept=".json,application/json"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            const p = JSON.parse(await f.text());
            if (p.kind !== kind) throw new Error("This file is not that kind of product");
            setProduct(p);
            setMsg(null);
          } catch (er) {
            setMsg({ ok: false, text: (er as Error).message });
          }
        }}
      />
      <select value={project} onChange={(e) => setProject(e.target.value)} className={fieldClass}>
        <option value="">Install into Project…</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!product || !project}
        className={buttonClass.primary}
        onClick={() => install(product!, project).then(() => setMsg({ ok: true, text: "Installed" }), (e: Error) => setMsg({ ok: false, text: e.message }))}
      >
        Install
      </button>
      <button type="button" className={buttonClass.ghost} onClick={() => setOpen(false)}>
        Close
      </button>
      {msg && <span className={msg.ok ? "text-ok" : "text-bad"}>{msg.text}</span>}
    </span>
  );
}
