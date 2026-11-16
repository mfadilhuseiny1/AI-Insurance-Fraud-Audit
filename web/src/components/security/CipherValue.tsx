"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { CIPHER_VALUE, cipherApi, type CipherLicense } from "@/lib/cipher";

/**
 * A Cipher-encrypted value (CIPHER::<channel>::…::CIPHER) shown masked; Decrypt asks the API with an Operational User
 * license of the value's channel (audited per value, rate limited; a checkpoint may ask for a justification first).
 */
export function CipherValue({ value: initial, context = "", edit }: { value: string; context?: string; edit?: { typeId: string; pk: string; property: string } }) {
  const [value, setValue] = useState(initial);
  const channel = CIPHER_VALUE.exec(value)?.[1];
  const [plain, setPlain] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const save = async () => {
    if (draft === null || !edit) return;
    setBusy(true);
    setError(null);
    try {
      const rows = (await cipherApi.licenses({ usable_for: "encrypt", channel })).filter((l) => l.kind === "operational");
      if (!rows.length) throw new Error("No Operational User license of this channel lets you encrypt");
      const r = await cipherApi.inlineEdit({ object_type_id: edit.typeId, primary_key: edit.pk, property: edit.property, value: draft, license: rows[0].rid, context });
      setValue(r.value);
      setPlain(draft);
      setDraft(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const [licenses, setLicenses] = useState<CipherLicense[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decrypt = async (lic?: CipherLicense) => {
    setBusy(true);
    setError(null);
    try {
      let use = lic;
      if (!use) {
        const rows = (await cipherApi.licenses({ usable_for: "decrypt", channel })).filter((l) => l.kind === "operational");
        if (!rows.length) throw new Error("No Operational User license of this channel lets you decrypt");
        if (rows.length > 1) {
          setLicenses(rows);
          return;
        }
        use = rows[0];
      }
      const r = await cipherApi.operate(use.rid, "decrypt", value, context);
      setPlain(r.value ?? "");
      setLicenses(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (draft !== null)
    return (
      <span className="inline-flex flex-wrap items-center gap-1" data-cipher-edit>
        <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} className="rounded border border-line-2 bg-ink px-1 text-xs" />
        <button type="button" disabled={busy} onClick={() => void save()} className="rounded px-1 text-[11px] text-ocean hover:bg-ocean/10">{busy ? "…" : "Encrypt and save"}</button>
        <button type="button" onClick={() => setDraft(null)} className="text-[11px] text-muted hover:text-white">Cancel</button>
        {error && <span className="text-[11px] text-bad" title={error}>{error.length > 60 ? `${error.slice(0, 60)}…` : error}</span>}
      </span>
    );
  if (plain !== null)
    return (
      <span className="inline-flex items-center gap-1" data-cipher-plain>
        <span className="break-all">{plain}</span>
        {edit && <button type="button" onClick={() => setDraft(plain)} className="text-[11px] text-ocean hover:underline">Edit</button>}
        <button type="button" onClick={() => setPlain(null)} className="text-muted hover:text-white" title="Hide"><Icon name="eye" className="h-3 w-3" /></button>
      </span>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-cipher-value>
      <span className="font-mono text-muted" title={channel ?? "Cipher text"}>••••••</span>
      {licenses ? (
        <select className="rounded border border-line-2 bg-ink px-1 text-[11px]" value="" onChange={(e) => { const l = licenses.find((x) => x.rid === e.target.value); if (l) void decrypt(l); }}>
          <option value="">License…</option>
          {licenses.map((l) => <option key={l.rid} value={l.rid}>{l.name}</option>)}
        </select>
      ) : (
        <button type="button" disabled={busy || !channel} onClick={(e) => { e.stopPropagation(); void decrypt(); }}
          className="inline-flex items-center gap-0.5 rounded px-1 text-[11px] text-ocean hover:bg-ocean/10 disabled:opacity-40">
          <Icon name="unlock" className="h-3 w-3" />{busy ? "…" : "Decrypt"}
        </button>
      )}
      {error && <span className="text-[11px] text-bad" title={error}>{error.length > 60 ? `${error.slice(0, 60)}…` : error}</span>}
    </span>
  );
}
