"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon, type IconName } from "@/components/Icon";
import { AppHeader, Card } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { fmtTime, posture, type Posture, type PostureCheck } from "@/lib/securityGov";

const ICON: Record<PostureCheck["status"], [IconName, string]> = { pass: ["check", "text-ok"], warn: ["alert", "text-warn"], fail: ["x", "text-bad"], manual: ["info", "text-muted"] };

/** Enterprise / Infrastructure security: the posture against the reference's best practices, with fixes and attestations. */
export function PosturePage({ kind }: { kind: "enterprise" | "infrastructure" }) {
  const [p, setP] = useState<Posture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attesting, setAttesting] = useState<PostureCheck | null>(null);
  const [filter, setFilter] = useState<"" | "todo">("");
  const load = useCallback(() => (kind === "enterprise" ? posture.enterprise() : posture.infrastructure()).then(setP, (e: Error) => setError(e.message)), [kind]);
  useEffect(() => {
    void load();
  }, [load]);
  const sections = useMemo(() => {
    const out: Record<string, PostureCheck[]> = {};
    for (const c of p?.checks ?? []) if (!filter || c.status !== "pass") (out[c.section] ??= []).push(c);
    return out;
  }, [p, filter]);
  const title = kind === "enterprise" ? "Enterprise security" : "Infrastructure security";
  if (error) return <ApiError message={error} />;
  if (!p) return <Loading />;
  const done = (msg: string) => { setNotice(msg); void load(); };
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app={title} icon={kind === "enterprise" ? "grid" : "server"} href={`/${kind}-security`} crumbs={[{ label: "Security & Governance", href: "/security-governance" }]} />
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
        <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold">{title}</h1>
              <p className="mt-1 max-w-3xl text-sm text-muted">
                {kind === "enterprise"
                  ? "Identity protection: strong MFA, short sessions, centrally managed identities, service accounts, tokens and audit monitoring — checked on this platform's live settings and data."
                  : "Protecting the installation and its data connectors: encryption in transit and at rest, network controls, malicious files, vulnerabilities and recovery. Controls outside the platform are attested by administrators and must be re-confirmed regularly."}
              </p>
            </div>
            <div className="rounded-lg border border-line bg-panel px-4 py-2 text-center">
              <div className="text-xs text-muted">Posture</div>
              <div className={`text-2xl font-semibold ${p.score >= 80 ? "text-ok" : p.score >= 50 ? "text-warn" : "text-bad"}`}>{p.score}%</div>
              <div className="text-[11px] text-muted">{p.counts.pass} pass · {p.counts.warn} warn · {p.counts.fail} fail · {p.counts.manual} to attest</div>
            </div>
          </div>
          {notice && <p className="rounded border border-ok/30 bg-ok/10 p-2 text-sm text-ok">{notice}</p>}
          <label className="flex items-center gap-2 text-sm text-soft"><input type="checkbox" checked={filter === "todo"} onChange={(e) => setFilter(e.target.checked ? "todo" : "")} />Only what needs attention</label>
          {Object.entries(sections).map(([section, list]) => (
            <Card key={section} title={section}>
              <ul className="divide-y divide-line">
                {list.map((c) => <CheckRow key={c.id} c={c} onAttest={() => setAttesting(c)} onDone={done} onError={setError} />)}
              </ul>
            </Card>
          ))}
          <p className="text-[11px] text-muted">Checked {fmtTime(p.at)}. Every change here is written to the audit log.</p>
        </div>
      </main>
      {attesting && <AttestDialog c={attesting} onClose={() => setAttesting(null)} onSaved={() => { setAttesting(null); done("Attestation recorded"); }} />}
    </div>
  );
}

function CheckRow({ c, onAttest, onDone, onError }: { c: PostureCheck; onAttest: () => void; onDone: (m: string) => void; onError: (e: string) => void }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [contact, setContact] = useState("");
  const [icon, tone] = ICON[c.status];
  const a = c.action;
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-start gap-3">
        <Icon name={icon} className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{c.title}</div>
          <div className="text-xs text-muted">{c.detail}</div>
        </div>
        {a?.kind === "link" && a.href && <Link href={a.href} className={buttonClass.secondary}>{a.label}</Link>}
        {a?.kind === "attest" && <button type="button" className={buttonClass.secondary} onClick={onAttest}>{c.attestation ? "Update attestation" : "Attest"}</button>}
        {a?.kind === "contact" && <button type="button" className={buttonClass.secondary} onClick={() => setOpen((o) => !o)}>Set contact</button>}
        {a?.kind === "dependency_scan" && (
          <button type="button" className={buttonClass.secondary} title="Sends the platform's package names and versions to osv.dev"
            onClick={() => posture.scanDependencies().then((r) => onDone(`Checked ${r.packages} packages: ${r.vulnerable.length} with known vulnerabilities`), (e: Error) => onError(e.message))}>
            {a.label ?? "Check now"}
          </button>
        )}
        {!!c.items.length && a?.kind !== "contact" && <button type="button" className={buttonClass.ghost} onClick={() => setOpen((o) => !o)}>{open ? "Hide" : `Show ${c.items.length}`}</button>}
      </div>
      {open && a?.kind === "contact" && (
        <div className="mt-2 flex gap-2 pl-7">
          <input className={inputClass} placeholder="security@your-organization.example, or a ticket queue" value={contact} onChange={(e) => setContact(e.target.value)} />
          <button type="button" className={buttonClass.primary} disabled={!contact} onClick={() => posture.setContact(contact).then(() => onDone("Contact saved"), (e: Error) => onError(e.message))}>Save</button>
        </div>
      )}
      {open && !!c.items.length && (
        <div className="mt-2 space-y-2 pl-7">
          <div className="max-h-64 overflow-y-auto rounded border border-line">
            <table className="w-full text-left text-xs">
              <tbody>
                {c.items.map((it, i) => {
                  const id = String(it.id ?? i);
                  const selectable = ["revoke_tokens", "disable_inactive"].includes(a?.kind ?? "");
                  return (
                    <tr key={id} className="border-b border-line/60">
                      {selectable && <td className="w-6 px-2"><input type="checkbox" checked={sel.includes(id)} onChange={(e) => setSel((x) => (e.target.checked ? [...x, id] : x.filter((y) => y !== id)))} /></td>}
                      <td className="px-2 py-1.5">{Object.entries(it).filter(([k]) => k !== "id").map(([k, v]) => (
                        <span key={k} className="mr-3"><span className="text-muted">{k.replace(/_/g, " ")}:</span> {v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                      ))}</td>
                      {a?.kind === "review" && <td className="px-2"><button type="button" className="text-ocean hover:underline" onClick={() => posture.review(id, "reviewed").then(() => onDone("Service account review recorded"), (e: Error) => onError(e.message))}>Mark reviewed</button></td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {a?.kind === "revoke_tokens" && <button type="button" className={buttonClass.secondary} disabled={!sel.length} onClick={() => window.confirm(`Revoke ${sel.length} token(s)? Scripts using them stop working.`) && posture.revokeTokens(sel).then((r) => onDone(`${r.revoked} token(s) revoked`), (e: Error) => onError(e.message))}>Revoke selected tokens</button>}
          {a?.kind === "disable_inactive" && <button type="button" className={buttonClass.secondary} disabled={!sel.length} onClick={() => window.confirm(`Deactivate ${sel.length} account(s)? They can be reactivated in Control Panel.`) && posture.disableUsers(sel).then((r) => onDone(`${r.disabled} account(s) deactivated`), (e: Error) => onError(e.message))}>Deactivate selected accounts</button>}
        </div>
      )}
    </li>
  );
}

function AttestDialog({ c, onClose, onSaved }: { c: PostureCheck; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState<"yes" | "partial" | "no">((c.attestation?.status as "yes" | "partial" | "no") ?? "yes");
  const [note, setNote] = useState(c.attestation?.note ?? "");
  const [evidence, setEvidence] = useState<{ id: string; name: string } | null>(c.attestation?.evidence ? { id: c.attestation.evidence, name: "evidence" } : null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg space-y-3 rounded-xl border border-line bg-panel p-5 text-sm">
        <h2 className="font-semibold">{c.title}</h2>
        <div className="flex gap-3">{([["yes", "In place"], ["partial", "Partly"], ["no", "Not in place"]] as const).map(([k, l]) => <label key={k} className="flex items-center gap-1"><input type="radio" checked={status === k} onChange={() => setStatus(k)} />{l}</label>)}</div>
        <textarea className={`${inputClass} min-h-20`} placeholder="How it was checked, by whom, and what is left" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="button" className={buttonClass.secondary} onClick={() => setPicking(true)}><Icon name="doc" className="h-4 w-4" />{evidence ? `Evidence: ${evidence.name}` : "Attach evidence from Files (optional)"}</button>
        {error && <p className="text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.ghost} onClick={onClose}>Cancel</button>
          <button type="button" className={buttonClass.primary} onClick={() => posture.attest(c.action?.id ?? c.id.replace("attest:", ""), { status, note, evidence: evidence?.id ?? null }).then(onSaved, (e: Error) => setError(e.message))}>Record attestation</button>
        </div>
      </div>
      {picking && <DrivePicker title="Evidence" onClose={() => setPicking(false)} onPick={(it) => { setEvidence({ id: it.id, name: it.name }); setPicking(false); }} />}
    </div>
  );
}
