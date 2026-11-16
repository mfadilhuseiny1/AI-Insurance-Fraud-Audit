"use client";

import { useEffect, useState } from "react";
import { cipherApi, type CipherLicense } from "@/lib/cipher";

/** A Cipher license the user can use for an operation (Data Manager / Admin for columns, Operational for values). */
export function CipherLicenseSelect({ value, onChange, operation, kinds, className }: {
  value?: string;
  onChange: (rid: string) => void;
  operation: "encrypt" | "decrypt" | "hash";
  kinds: CipherLicense["kind"][];
  className?: string;
}) {
  const [rows, setRows] = useState<CipherLicense[] | null>(null);
  useEffect(() => {
    cipherApi.licenses({ usable_for: operation }).then((r) => setRows(r.filter((l) => kinds.includes(l.kind))), () => setRows([]));
  }, [operation, kinds]);
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={className} aria-label="Cipher license">
      <option value="">{rows === null ? "Loading licenses…" : rows.length ? "Choose a Cipher license…" : "No usable Cipher license"}</option>
      {rows?.map((l) => <option key={l.rid} value={l.rid}>{l.name} · {l.channel?.name} ({l.channel?.algorithm})</option>)}
      {value && rows && !rows.some((l) => l.rid === value) && <option value={value}>{value}</option>}
    </select>
  );
}
