"use client";

import { confirmDialog } from "@/lib/dialogs";
import { useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { API_URL } from "@/lib/api";
import { devConsole, type DcApp } from "@/lib/developerConsole";
import { ontology, type ActionType, type ObjectType } from "@/lib/ontology";
import { workshop, type Module } from "@/lib/workshop";

type Fn = { id: string; name: string; doc?: string; repo_name?: string; kind?: string };
export type AgenticApp = { id: string; name: string; description: string; icon: IconName; href: string | null; kind: string; owner?: string; collection?: string; tags?: string[] };

const ICONS: IconName[] = ["cube", "table", "graph", "search", "alert", "gauge", "bolt", "sparkle", "doc", "globe", "layers", "logic"];

/**
 * A new integrated app (POST /api/agentic-apps/new): an OSDK app — a Developer Console application whose scopes
 * are the chosen object types, action types and functions — or a Workshop app on the Ontology; listed under
 * Agentic Apps in the Applications Portal as soon as it is made.
 */
export function NewAppDialog({ onClose, onMade }: { onClose: () => void; onMade: (app: AgenticApp) => void }) {
  const [kind, setKind] = useState<"osdk" | "workshop">("osdk");
  // "existing": list an app that is already built (a Developer Console application, a Workshop module or any page)
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [listKind, setListKind] = useState<"osdk" | "workshop" | "page">("osdk");
  const [resource, setResource] = useState("");
  const [href, setHref] = useState("");
  const [collection, setCollection] = useState("");
  const [dcApps, setDcApps] = useState<DcApp[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState<IconName>("cube");
  const [tags, setTags] = useState("");
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [actions, setActions] = useState<ActionType[]>([]);
  const [fns, setFns] = useState<Fn[]>([]);
  const [pickTypes, setPickTypes] = useState<string[]>([]);
  const [pickActions, setPickActions] = useState<string[]>([]);
  const [pickFns, setPickFns] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    ontology.objectTypes().then(setTypes, () => setTypes([]));
    ontology.actionTypes().then(setActions, () => setActions([]));
    fetch(`${API_URL}/api/functions`, { credentials: "include", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .then((x: Fn[]) => setFns(Array.isArray(x) ? x : []), () => setFns([]));
    devConsole.list().then(setDcApps, () => setDcApps([]));
    workshop.modules().then(setModules, () => setModules([]));
  }, []);
  const shownTypes = useMemo(() => types.filter((t) => !q || t.display_name.toLowerCase().includes(q.toLowerCase())), [types, q]);
  const shownActions = useMemo(() => actions.filter((a) => pickTypes.includes(a.object_type_id ?? "")), [actions, pickTypes]);
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const make = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (mode === "existing") {
        const send = (replace: boolean) =>
          fetch(`${API_URL}/api/agentic-apps${replace ? "?replace=true" : ""}`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: name.trim(), description: description.trim(), kind: listKind, icon, resource_id: listKind === "page" ? null : resource || null,
                                   href: href.trim() || null, collection: collection.trim() || null, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }),
          });
        let r = await send(false);
        // the same app (resource or link) is already listed: replacing it is the user's call
        if (r.status === 409) {
          const d = (await r.json().catch(() => ({}))).detail ?? {};
          if (!(await confirmDialog({ title: "Already listed", message: `${d.message ?? "This app is already listed."} Replace that listing with this one?`, confirmLabel: "Replace", danger: true }))) return;
          r = await send(true);
        }
        if (!r.ok) {
          const d = (await r.json().catch(() => ({ detail: r.statusText }))).detail ?? r.statusText;
          throw new Error(typeof d === "string" ? d : d.message ?? r.statusText);
        }
        onMade(await r.json());
        return;
      }
      const r = await fetch(`${API_URL}/api/agentic-apps/new`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), kind, icon, object_types: pickTypes, action_types: kind === "osdk" ? pickActions : [],
                               functions: kind === "osdk" ? pickFns : [], tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({ detail: r.statusText }))).detail ?? r.statusText);
      onMade(await r.json());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = "w-full rounded-md border border-line-2 bg-ink px-2.5 py-1.5 text-sm outline-none focus:border-ocean";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <Icon name="plus" className="h-4 w-4 text-ocean" />
          <h2 className="font-semibold">Aplikasi baru</h2>
          <span className="text-xs text-muted">terhubung ke Nexus · tampil di Agentic Apps</span>
          <button type="button" onClick={onClose} className="ml-auto text-muted hover:text-white" aria-label="Tutup"><Icon name="x" className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 text-sm">
          <div className="flex gap-1 text-xs">
            {([["new", "Buat aplikasi baru"], ["existing", "Daftarkan aplikasi yang sudah ada"]] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setMode(k)} data-mode={k} className={`rounded-md px-2.5 py-1 ${mode === k ? "bg-ocean/15 text-white ring-1 ring-ocean" : "text-muted hover:bg-panel-2"}`}>
                {l}
              </button>
            ))}
          </div>
          {mode === "existing" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="text-xs text-muted">Jenis</span>
                <select value={listKind} onChange={(e) => (setListKind(e.target.value as "osdk" | "workshop" | "page"), setResource(""))} className={field} aria-label="Jenis aplikasi">
                  <option value="osdk">Aplikasi OSDK (Developer Console)</option>
                  <option value="workshop">Aplikasi Workshop</option>
                  <option value="page">Halaman (tautan)</option>
                </select>
              </label>
              {listKind !== "page" && (
                <label className="block"><span className="text-xs text-muted">Resource</span>
                  <select value={resource} onChange={(e) => setResource(e.target.value)} className={field} aria-label="Resource aplikasi">
                    <option value="">Pilih…</option>
                    {(listKind === "osdk" ? dcApps.map((a) => ({ id: a.id, name: a.name })) : modules.map((m) => ({ id: m.id, name: m.name }))).map((x) => (
                      <option key={x.id} value={x.id}>{x.name}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="block"><span className="text-xs text-muted">Dibuka di (tautan, opsional)</span><input value={href} onChange={(e) => setHref(e.target.value)} placeholder={listKind === "page" ? "/demo-jkn/audit" : "kosong: situs / resource-nya"} className={field} aria-label="Tautan aplikasi" /></label>
              <label className="block"><span className="text-xs text-muted">Koleksi (opsional)</span><input value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="mis. Audit JKN" className={field} aria-label="Koleksi" /></label>
            </div>
          )}
          {mode === "new" && <div className="grid gap-2 sm:grid-cols-2">
            {([
              ["osdk", "Aplikasi OSDK (kode)", "UI kustom React di atas Nexus SDK. Dibuat di Developer Console dengan cakupan objek, action dan function yang dipilih; SDK dan website hosting tersedia di sana.", "keyboard"],
              ["workshop", "Aplikasi Workshop (tanpa kode)", "Disusun dari widget di atas objek, link dan action. Mulai dengan tabel dan detail objek tipe pertama yang dipilih.", "grid"],
            ] as const).map(([k, title, body, ic]) => (
              <button key={k} type="button" onClick={() => setKind(k)}
                className={`rounded-lg border p-3 text-left transition ${kind === k ? "border-ocean bg-ocean/10" : "border-line hover:border-line-2"}`}>
                <div className="flex items-center gap-2 font-medium"><Icon name={ic} className="h-4 w-4 text-ocean" /> {title}</div>
                <p className="mt-1 text-xs text-muted">{body}</p>
              </button>
            ))}
          </div>}
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="block"><span className="text-xs text-muted">Nama aplikasi</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="mis. Verifikasi Klaim Rawat Inap" className={field} aria-label="Nama aplikasi" /></label>
            <div>
              <span className="text-xs text-muted">Ikon</span>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {ICONS.map((ic) => (
                  <button key={ic} type="button" onClick={() => setIcon(ic)} className={`rounded p-1.5 ${icon === ic ? "bg-ocean/20 text-ocean ring-1 ring-ocean" : "text-muted hover:bg-panel-2"}`} aria-label={ic}>
                    <Icon name={ic} className="h-4 w-4" />
                  </button>
                ))}
              </div>
            </div>
          </div>
          <label className="block"><span className="text-xs text-muted">Deskripsi</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Untuk siapa dan apa yang dikerjakan di aplikasi ini" className={field} aria-label="Deskripsi aplikasi" /></label>
          <label className="block"><span className="text-xs text-muted">Tag (pisahkan dengan koma)</span><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="JKN, audit" className={field} aria-label="Tag" /></label>

          {mode === "new" && <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-line p-2">
              <div className="mb-1 flex items-center gap-2 text-xs font-medium">Object type <span className="text-muted">({pickTypes.length})</span></div>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari…" className={`${field} mb-1 py-1 text-xs`} />
              <div className="max-h-52 space-y-0.5 overflow-y-auto text-xs">
                {shownTypes.map((t) => (
                  <label key={t.id} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-panel-2">
                    <input type="checkbox" checked={pickTypes.includes(t.id)} onChange={() => toggle(pickTypes, setPickTypes, t.id)} />
                    <span className="truncate">{t.display_name}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className={`rounded-lg border border-line p-2 ${kind !== "osdk" ? "opacity-50" : ""}`}>
              <div className="mb-1 text-xs font-medium">Action type <span className="text-muted">({pickActions.length})</span></div>
              <div className="max-h-60 space-y-0.5 overflow-y-auto text-xs">
                {shownActions.length === 0 && <p className="text-muted">Pilih object type dulu.</p>}
                {shownActions.map((a) => (
                  <label key={a.id} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-panel-2">
                    <input type="checkbox" disabled={kind !== "osdk"} checked={pickActions.includes(a.id)} onChange={() => toggle(pickActions, setPickActions, a.id)} />
                    <span className="truncate">{a.display_name}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className={`rounded-lg border border-line p-2 ${kind !== "osdk" ? "opacity-50" : ""}`}>
              <div className="mb-1 text-xs font-medium">Function <span className="text-muted">({pickFns.length})</span></div>
              <div className="max-h-60 space-y-0.5 overflow-y-auto text-xs">
                {fns.length === 0 && <p className="text-muted">Belum ada function yang dipublikasikan.</p>}
                {fns.map((f) => (
                  <label key={f.id} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-panel-2" title={f.doc}>
                    <input type="checkbox" disabled={kind !== "osdk"} checked={pickFns.includes(f.id)} onChange={() => toggle(pickFns, setPickFns, f.id)} />
                    <span className="truncate font-mono">{f.name}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>}
          {err && <p className="text-xs text-bad">{err}</p>}
        </div>
        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          <span className="text-xs text-muted">{mode === "existing" ? "Hanya didaftarkan di Agentic Apps · resource-nya tidak berubah" : kind === "osdk" ? "Dibuat di project “Agentic Apps” · lanjutkan di Developer Console (SDK, hosting)" : "Dibuat di project “Agentic Apps” · lanjutkan di Workshop"}</span>
          <button type="button" onClick={onClose} className="ml-auto rounded-md border border-line-2 px-3 py-1.5 text-sm hover:border-ocean">Batal</button>
          <button type="button" disabled={busy || !name.trim() || (mode === "existing" && (listKind === "page" ? !href.trim() : !resource))} onClick={make} className="rounded-md bg-ocean px-3 py-1.5 text-sm font-medium text-white hover:bg-ocean-deep disabled:opacity-50">
            {busy ? "Membuat…" : mode === "existing" ? "Daftarkan" : "Buat aplikasi"}
          </button>
        </div>
      </div>
    </div>
  );
}
