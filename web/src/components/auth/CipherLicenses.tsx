"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { API_URL } from "@/lib/api";

type License = { id: string; rid: string; name: string; description: string; operations: ("encrypt" | "decrypt")[]; users: string[]; created_at: string; created_by: string };

async function call<T>(path: string, method = "GET", json?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/cipher${path}`, {
    method,
    cache: "no-store",
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const b = await res.json();
      msg = typeof b.detail === "string" ? b.detail : JSON.stringify(b.detail);
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

/** Control Panel → Cipher licenses (api/cipher.py): the keys media transforms encrypt and decrypt image regions with. */
export function CipherLicenses() {
  const [rows, setRows] = useState<License[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [ops, setOps] = useState<("encrypt" | "decrypt")[]>(["encrypt", "decrypt"]);
  const [users, setUsers] = useState("");
  const load = useCallback(() => call<License[]>("/licenses").then(setRows, (e: Error) => setErr(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const create = () =>
    call<License>("/licenses", "POST", { name, operations: ops, users: split(users) }).then(
      () => (setName(""), setUsers(""), setErr(null), load()),
      (e: Error) => setErr(e.message),
    );
  const update = (l: License, change: Partial<License>) => call<License>(`/licenses/${l.id}`, "PATCH", change).then(load, (e: Error) => setErr(e.message));
  const toggle = (list: ("encrypt" | "decrypt")[], op: "encrypt" | "decrypt") => (list.includes(op) ? list.filter((x) => x !== op) : [...list, op]);
  return (
    <div className="space-y-4 text-sm">
      <div>
        <h1 className="text-xl font-semibold">Cipher licenses</h1>
        <p className="text-muted">
          Keys for <span className="font-mono">encrypt()</span> / <span className="font-mono">decrypt()</span> of image regions in media set transforms. A license allows
          some operations to some users (empty: every signed-in user); builds get the key as the user who started them, and every key request is in the sign-in activity log.
          Keys never leave the server otherwise.
        </p>
      </div>
      {err && <p className="text-xs text-bad">{err}</p>}
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <table className="w-full text-xs">
          <thead className="text-left text-muted">
            <tr>
              {["Name", "RID", "Operations", "Granted to", "Created"].map((h) => (
                <th key={h} className="border-b border-line px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows?.map((l) => (
              <tr key={l.id}>
                <td className="border-b border-line-2 px-3 py-1.5 font-medium text-soft">{l.name}</td>
                <td className="border-b border-line-2 px-3 py-1.5 font-mono text-muted">{l.rid}</td>
                <td className="border-b border-line-2 px-3 py-1.5">
                  {(["encrypt", "decrypt"] as const).map((op) => (
                    <label key={op} className="mr-3 inline-flex items-center gap-1">
                      <input type="checkbox" checked={l.operations.includes(op)} onChange={() => update(l, { operations: toggle(l.operations, op) })} /> {op}
                    </label>
                  ))}
                </td>
                <td className="border-b border-line-2 px-3 py-1.5">
                  <input
                    defaultValue={l.users.join(", ")}
                    onBlur={(e) => e.target.value !== l.users.join(", ") && update(l, { users: split(e.target.value) })}
                    placeholder="every signed-in user"
                    className={`${inputClass} text-xs`}
                  />
                </td>
                <td className="border-b border-line-2 px-3 py-1.5 text-muted">
                  {l.created_at.slice(0, 10)} · {l.created_by}
                </td>
              </tr>
            ))}
            {rows && !rows.length && (
              <tr>
                <td colSpan={5} className="px-3 py-3 text-muted">
                  No Cipher licenses yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-panel p-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Patient data" className={inputClass} />
        </label>
        <div className="pb-1.5 text-xs">
          {(["encrypt", "decrypt"] as const).map((op) => (
            <label key={op} className="mr-3 inline-flex items-center gap-1">
              <input type="checkbox" checked={ops.includes(op)} onChange={() => setOps(toggle(ops, op))} /> {op}
            </label>
          ))}
        </div>
        <label className="block min-w-64 flex-1">
          <span className="mb-1 block text-xs text-muted">Granted to (user names or ids, comma separated)</span>
          <input value={users} onChange={(e) => setUsers(e.target.value)} placeholder="every signed-in user" className={inputClass} />
        </label>
        <button type="button" disabled={!name.trim() || !ops.length} onClick={create} className={buttonClass.primary}>
          <Icon name="plus" className="h-3.5 w-3.5" /> Create license
        </button>
      </div>
    </div>
  );
}
