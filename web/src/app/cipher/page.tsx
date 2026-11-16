"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DrivePicker } from "@/components/DrivePicker";
import { Icon } from "@/components/Icon";
import { LocationField, missingText, type PickedLocation } from "@/components/LocationField";
import { AppHeader, Card } from "@/components/ontology/parts";
import { buttonClass, fieldClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError, Loading } from "@/components/States";
import { ALGORITHM_LABEL, cipherApi, KIND_LABEL, type CipherAlgorithm, type CipherChannel, type CipherLicense } from "@/lib/cipher";
import { fmtTime } from "@/lib/securityGov";
import { datasetPreview } from "@/lib/datasetPreview";
import { downloadProduct, InstallProduct } from "@/components/security/MarketplaceProduct";
import { ItemMarkingsPanel } from "@/components/auth/ItemMarkings";
import { api } from "@/lib/api";

/** Cipher: channels (algorithm and key) and the licenses that grant their operations. */
export default function CipherPage() {
  const [channels, setChannels] = useState<CipherChannel[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => cipherApi.channels().then(setChannels, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Cipher" icon="lock" href="/cipher" crumbs={[{ label: "Security & Governance", href: "/security-governance" }, ...(open ? [{ label: channels?.find((c) => c.id === open)?.name ?? "Channel" }] : [])]}>
        <InstallProduct kind="bluesandai.cipher.product" label="Install channel product" install={(p, project) => cipherApi.installChannel(p, project).then(load)} />
        <button type="button" className={buttonClass.primary} onClick={() => setCreating(true)}><Icon name="plus" className="h-4 w-4" />New Cipher Channel</button>
      </AppHeader>
      <main className="min-w-0 flex-1 overflow-y-auto bg-ink">
        <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
          {error && <ApiError message={error} />}
          {open ? <ChannelView id={open} onBack={() => { setOpen(null); void load(); }} /> : (
            <>
              <div>
                <h1 className="text-xl font-semibold">Cipher</h1>
                <p className="mt-1 max-w-3xl text-sm text-muted">
                  A channel holds an algorithm and its key; licenses grant its operations to whoever can view them. Operational User licenses decrypt single values in
                  Object Explorer and Workshop (audited per value, optionally rate limited, Checkpoints apply); Data Manager licenses work on columns in Pipeline Builder
                  and Contour; Admin licenses work in Python transforms and effectively grant key access.
                </p>
              </div>
              <Card title="Channels" count={channels?.length}>
                {!channels ? <Loading /> : !channels.length ? <p className="p-4 text-sm text-muted">No Cipher channels you can see.</p> : (
                  <ul className="divide-y divide-line">
                    {channels.map((c) => (
                      <li key={c.id}>
                        <button type="button" onClick={() => setOpen(c.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-panel-2">
                          <Icon name="lock" className="h-4 w-4 text-ocean" />
                          <span className="min-w-0 flex-1"><span className="font-medium">{c.name}</span>
                            <span className="block text-xs text-muted">{ALGORITHM_LABEL[c.algorithm]} · {String(c.licenses ?? 0)} license(s) · {c.created_by} · {fmtTime(c.created_at)}</span></span>
                          <Icon name="right" className="h-4 w-4 text-muted" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Playground />
              <p className="text-xs text-muted">Media transforms&apos; image-region licenses (made before channels) are in <Link href="/control-panel?section=cipher" className="text-ocean hover:underline">Control Panel → Cipher licenses</Link>.</p>
            </>
          )}
        </div>
      </main>
      {creating && <NewChannel onClose={() => setCreating(false)} onCreated={(c) => { setCreating(false); void load(); setOpen(c.id); }} />}
    </div>
  );
}

function NewChannel({ onClose, onCreated }: { onClose: () => void; onCreated: (c: CipherChannel) => void }) {
  const [name, setName] = useState("");
  const [algorithm, setAlgorithm] = useState<CipherAlgorithm>("AES_SIV");
  const [mode, setMode] = useState<"derived" | "single">("derived");
  const [secret, setSecret] = useState("");
  const [description, setDescription] = useState("");
  const [folder, setFolder] = useState<PickedLocation | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(name.trim() ? [] : ["enter a channel name"]), ...(folder ? [] : ["choose a location"])];
  const nameInvalid = tried && !name.trim();
  const generate = () => {
    const b = new Uint8Array(algorithm === "AES_SIV" && mode === "single" ? 64 : 32);
    crypto.getRandomValues(b);
    setSecret(algorithm === "VISUAL" ? String(BigInt(`0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`)) : btoa(String.fromCharCode(...b)));
  };
  const create = async () => {
    setTried(true);
    if (missing.length || !folder) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await cipherApi.createChannel({ name, folder_id: folder.id, algorithm, key_mode: mode, secret, description }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const encryption = algorithm === "AES_SIV" || algorithm === "AES_GCM_SIV";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg space-y-3 rounded-xl border border-line bg-panel p-5 text-sm">
        <h2 className="text-base font-semibold">New Cipher Channel</h2>
        <label className="block">
          <span className="mb-1 flex items-center gap-1 text-xs font-medium text-soft">Channel name <span className="text-bad" aria-hidden>*</span></span>
          <input className={`${inputClass} ${nameInvalid ? "border-bad ring-1 ring-bad/40" : ""}`} aria-invalid={nameInvalid} placeholder="Channel name" value={name} onChange={(e) => setName(e.target.value)} />
          {nameInvalid && <span className="mt-1 block text-[11px] text-bad">Give the channel a name.</span>}
        </label>
        <input className={inputClass} placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
        <LocationField value={folder} onChange={setFolder} invalid={tried} hint="The Project folder the channel goes in; its Project roles decide who sees it." />
        <div className="space-y-1">
          {(Object.keys(ALGORITHM_LABEL) as CipherAlgorithm[]).map((a) => (
            <label key={a} className="flex items-start gap-2"><input type="radio" className="mt-1" checked={algorithm === a} onChange={() => setAlgorithm(a)} />{ALGORITHM_LABEL[a]}</label>
          ))}
          <p className="text-xs text-muted">Encrypted values can be decrypted with the right license; hashed values cannot. Deterministic algorithms allow joins on encrypted values; probabilistic ones resist dictionary attacks on low-cardinality data.</p>
        </div>
        {encryption && (
          <select className={inputClass} value={mode} onChange={(e) => setMode(e.target.value as "derived" | "single")}>
            <option value="derived">Stretching key derivation from a secret (recommended)</option>
            <option value="single">Single key (base64: {algorithm === "AES_SIV" ? "64" : "32"} bytes)</option>
          </select>
        )}
        <div className="flex gap-2">
          <input className={`${inputClass} font-mono`} placeholder={algorithm === "VISUAL" ? "Scrambling seed (a long random number)" : encryption ? (mode === "single" ? "Base64 key" : "Secret") : "Hash secret (at least 14 characters)"}
            value={secret} onChange={(e) => setSecret(e.target.value)} />
          <button type="button" className={buttonClass.secondary} onClick={generate} title="Generate randomly"><Icon name="refresh" className="h-4 w-4" /></button>
        </div>
        <p className="text-xs text-muted">Left empty, a random secret is generated. The key is kept sealed on the platform and never shown again.</p>
        {error && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To create: {missingText(missing)}</span>}
          <button type="button" className={buttonClass.ghost} onClick={onClose}>Cancel</button>
          <button type="button" className={buttonClass.primary} disabled={busy} onClick={create}>{busy ? "Creating…" : "Create cipher channel"}</button>
        </div>
      </div>
    </div>
  );
}

function ChannelView({ id, onBack }: { id: string; onBack: () => void }) {
  const [c, setC] = useState<(CipherChannel & { licenses: CipherLicense[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [pipelineFor, setPipelineFor] = useState<CipherLicense | null>(null);
  // the folder holding the channel and its licenses (Files opens folders, not the items themselves)
  const [folder, setFolder] = useState<string | null>(null);
  const load = () => cipherApi.channel(id).then(setC, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (c?.item_id) api.drive.item(c.item_id).then((i) => setFolder(i.parent_id ?? null), () => {});
  }, [c?.item_id]);
  if (error) return <ApiError message={error} />;
  if (!c) return <Loading />;
  const hashing = c.algorithm === "SHA256" || c.algorithm === "SHA512";
  return (
    <>
      <button type="button" className={buttonClass.ghost} onClick={onBack}><Icon name="left" className="h-4 w-4" />Channels</button>
      <Card title={c.name}>
        <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 p-4 text-xs">
          {c.description && <><dt className="text-muted">Description</dt><dd>{c.description}</dd></>}
          <dt className="text-muted">Algorithm</dt><dd>{ALGORITHM_LABEL[c.algorithm]}</dd>
          <dt className="text-muted">Key</dt><dd>{c.key_mode === "derived" ? "Derived from a secret (scrypt)" : c.key_mode === "single" ? "Single key" : c.key_mode === "pepper" ? "Hash pepper" : "Scrambling seed"} — sealed</dd>
          <dt className="text-muted">Channel RID</dt><dd className="font-mono">{c.rid}</dd>
          {c.item_id && <><dt className="text-muted">In Files</dt><dd>{folder ? <Link href={`/files/${folder}`} className="text-ocean hover:underline">Open the channel&apos;s folder</Link> : "…"} (its Project roles decide who sees it)</dd></>}
          {c.item_id && <><dt className="text-muted">Markings</dt><dd><ItemMarkingsPanel itemId={c.item_id} compact /></dd></>}
        </dl>
      </Card>
      <Card title="Licenses" count={c.licenses.length} action={c.can_manage ? (
        <span className="flex gap-2">
          <button type="button" className={buttonClass.secondary} title="Package the channel and its licenses (a new key is made at installation)" onClick={() => cipherApi.packageChannel(c.id).then((p) => downloadProduct(c.name, p), (e: Error) => setError(e.message))}><Icon name="download" className="h-4 w-4" />Package</button>
          <button type="button" className={buttonClass.primary} onClick={() => setIssuing(true)}><Icon name="plus" className="h-4 w-4" />Create new Cipher License</button>
        </span>
      ) : undefined}>
        {issuing && <IssueLicense channel={c} onDone={() => { setIssuing(false); void load(); }} />}
        {pipelineFor && <CreatePipeline license={pipelineFor} onClose={() => setPipelineFor(null)} />}
        {!c.licenses.length ? <p className="p-4 text-sm text-muted">No licenses yet. Give users View access to a license to grant its operations.</p> : (
          <ul className="divide-y divide-line">
            {c.licenses.map((l) => {
              const expired = !!l.expires_at && l.expires_at < new Date().toISOString();
              return (
                <li key={l.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{l.name}</span> <span className="text-xs text-muted">{KIND_LABEL[l.kind]}</span>
                    <span className="block text-xs text-muted">
                      {l.operations.map((o) => (o === "encrypt" && hashing ? "hash" : o)).join(" + ")}
                      {l.rate_limit ? ` · ${l.rate_limit.count} per ${l.rate_limit.minutes} min` : ""}{l.bypass_checkpoints ? " · bypasses checkpoints" : ""}
                      {l.expires_at ? ` · ${expired ? "expired" : "expires"} ${fmtTime(l.expires_at)}` : ""}
                    </span>
                    {l.description && <span className="block text-xs text-soft">{l.description}</span>}
                    <span className="block font-mono text-[11px] text-muted">{l.rid}</span>
                    {l.item_id && <span className="mt-1 block" data-license-markings={l.id}><ItemMarkingsPanel itemId={l.item_id} compact /></span>}
                  </span>
                  <button type="button" className={buttonClass.ghost} onClick={() => navigator.clipboard?.writeText(l.rid)}><Icon name="copy" className="h-4 w-4" />Copy RID</button>
                  {l.kind === "data_manager" && l.operations.includes("encrypt") && !hashing && !expired && (
                    <button type="button" className={buttonClass.ghost} onClick={() => setPipelineFor(l)}><Icon name="plus" className="h-4 w-4" />Create pipeline</button>
                  )}
                  {l.item_id && folder && <Link href={`/files/${folder}`} className={buttonClass.ghost}><Icon name="eye" className="h-4 w-4" />Sharing</Link>}
                  {c.can_manage && !expired && <button type="button" className={buttonClass.secondary} onClick={() => cipherApi.updateLicense(l.id, { revoked: true }).then(load, (e: Error) => setError(e.message))}>Revoke</button>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card title="Use it">
        <div className="space-y-2 p-4 text-xs text-soft">
          <p><b>Pipeline Builder</b>: add the <i>Cipher encrypt</i>, <i>Cipher decrypt</i> or <i>Cipher hash</i> step with a Data Manager or Admin license RID (previews show a placeholder; data changes at build time).</p>
          <p><b>Contour</b>: add a <i>Cipher</i> board, choose the columns, the operation and the license.</p>
          <p><b>Python transforms</b> (Admin license):</p>
          <pre className="overflow-x-auto rounded bg-ink p-3 text-[11px]">{`from transforms.api import transform, Input, Output
from bellaso_python_lib.encryption.encrypter_input import EncrypterInput

@transform(
    encrypter=EncrypterInput("${c.licenses.find((l) => l.kind === "admin")?.rid ?? "<ADMIN_LICENSE_RID>"}"),
    output=Output("/path/to/output"),
    source=Input("/path/to/input"),
)
def compute(source, output, encrypter):
    df = source.dataframe()
    df["name"] = encrypter.dataframe().${hashing ? "hash_column" : "encrypt_column"}(df["name"])
    output.write_dataframe(df)`}</pre>
          <p><b>Nexus</b>: give a property the <i>Cipher text</i> type; Object Explorer and Workshop show its values masked with <i>Decrypt</i> for users with an Operational User license.</p>
        </div>
      </Card>
    </>
  );
}

/** Cipher's Create pipeline: a dataset, one String column to encrypt and a folder; Pipeline Builder opens on the new pipeline. */
function CreatePipeline({ license, onClose }: { license: CipherLicense; onClose: () => void }) {
  const [dataset, setDataset] = useState<{ id: string; name: string } | null>(null);
  const [folder, setFolder] = useState<PickedLocation | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [column, setColumn] = useState("");
  const [picking, setPicking] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; name: string } | null>(null);
  // Create stays clickable: a click with something missing says what, next to the button and on the field
  const missing = [...(dataset ? [] : ["choose an input dataset"]), ...(!dataset || column ? [] : ["choose a String column"]), ...(folder ? [] : ["choose a location"])];
  const create = () => {
    setTried(true);
    if (missing.length || !dataset || !folder) return;
    setBusy(true);
    setError(null);
    cipherApi
      .createPipeline(license.rid, { dataset_item_id: dataset.id, column, folder_id: folder.id })
      .then((r) => setDone(r.pipeline), (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    if (!dataset) return;
    datasetPreview.summary(dataset.id).then((s) => {
      const cols = s.columns.filter((x) => /string/i.test(String(x.type))).map((x) => x.name);
      setColumns(cols);
      setColumn(cols[0] ?? "");
    }, (e: Error) => setError(e.message));
  }, [dataset]);
  return (
    <div className="space-y-2 border-b border-line bg-panel-2 p-4 text-sm">
      <p className="font-medium">Create pipeline with {license.name}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-soft">Input <span className="text-bad" aria-hidden>*</span></span>
        <button type="button" className={`${buttonClass.secondary} ${tried && !dataset ? "border-bad ring-1 ring-bad/40" : ""}`} onClick={() => setPicking(true)}><Icon name="table" className="h-4 w-4" />{dataset ? dataset.name : "Input dataset…"}</button>
        {dataset && (
          <select className={`${fieldClass} ${tried && !column ? "border-bad ring-1 ring-bad/40" : ""}`} value={column} onChange={(e) => setColumn(e.target.value)}>
            {columns.length === 0 && <option value="">No String columns</option>}
            {columns.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        )}
      </div>
      <div className="max-w-md">
        <LocationField value={folder} onChange={setFolder} invalid={tried} hint="The folder the pipeline is saved in." />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass.primary} disabled={busy} onClick={create}>
          {busy ? "Creating…" : "Create pipeline"}
        </button>
        <button type="button" className={buttonClass.ghost} onClick={onClose}>Close</button>
        {missing.length > 0 && <span className={`text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To create: {missingText(missing)}</span>}
      </div>
      <p className="text-xs text-muted">Only String columns can be encrypted (cast others to String first). The pipeline replaces the column with its encrypted values and writes a copy into the folder.</p>
      {done && <p className="text-xs text-ok">Created <Link href={`/pipeline/${done.id}`} className="underline">{done.name}</Link>: open it in Pipeline Builder and deploy it.</p>}
      {error && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>}
      {picking && (
        <DrivePicker title="Input dataset" canPick={(i) => (i.kind === "file" ? null : "choose a dataset")} onClose={() => setPicking(false)} onPick={(i) => (setDataset({ id: i.id, name: i.name }), setPicking(false))} />
      )}
    </div>
  );
}

function IssueLicense({ channel, onDone }: { channel: CipherChannel; onDone: () => void }) {
  const hashing = channel.algorithm === "SHA256" || channel.algorithm === "SHA512";
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"operational" | "data_manager" | "admin">("operational");
  const [ops, setOps] = useState<string[]>(["decrypt"]);
  const [rate, setRate] = useState({ count: "", minutes: "60" });
  const [bypass, setBypass] = useState(false);
  const [expires, setExpires] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toggle = (o: string) => setOps((x) => (x.includes(o) ? x.filter((y) => y !== o) : [...x, o]));
  const issue = async () => {
    try {
      await cipherApi.issue(channel.id, {
        name, description, kind, operations: hashing ? ["encrypt"] : ops, bypass_checkpoints: bypass, expires_at: expires ? new Date(expires).toISOString() : null,
        rate_limit: kind === "operational" && rate.count ? { count: Number(rate.count), minutes: Number(rate.minutes) || 60 } : null,
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-3 border-b border-line p-4 text-sm">
      <div className="grid gap-2 md:grid-cols-3">
        {(["operational", "data_manager", "admin"] as const).map((k) => (
          <label key={k} className={`cursor-pointer rounded-lg border p-2 text-xs ${kind === k ? "border-ocean bg-ocean/10" : "border-line"}`}>
            <input type="radio" className="mr-1" checked={kind === k} onChange={() => setKind(k)} />
            <b>{KIND_LABEL[k]}</b>
            <span className="mt-1 block text-muted">{k === "operational" ? "Single values in Object Explorer, Workshop and functions; audited per value; rate limit." : k === "data_manager" ? "Columns in Pipeline Builder and Contour." : "Columns in Python transforms — effectively grants access to the key."}</span>
          </label>
        ))}
      </div>
      <input className={inputClass} placeholder="License name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className={inputClass} placeholder="Description (optional): what the license is for" value={description} onChange={(e) => setDescription(e.target.value)} />
      {!hashing && (
        <div className="flex gap-4">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={ops.includes("encrypt")} onChange={() => toggle("encrypt")} />Encrypt</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={ops.includes("decrypt")} onChange={() => toggle("decrypt")} />Decrypt</label>
        </div>
      )}
      {hashing && <p className="text-xs text-muted">A hashing channel&apos;s licenses hash (hashes cannot be reversed).</p>}
      {kind === "operational" && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          Rate limit <input className={`${fieldClass} w-20`} placeholder="none" value={rate.count} onChange={(e) => setRate({ ...rate, count: e.target.value.replace(/\D/g, "") })} /> operations per
          <input className={`${fieldClass} w-16`} value={rate.minutes} onChange={(e) => setRate({ ...rate, minutes: e.target.value.replace(/\D/g, "") })} /> minutes
          <label className="ml-4 flex items-center gap-1.5"><input type="checkbox" checked={bypass} onChange={(e) => setBypass(e.target.checked)} />Bypass checkpoints (functions and API calls)</label>
        </div>
      )}
      <label className="flex items-center gap-2 text-xs">Expires (optional) <input type="date" className={fieldClass} value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
      {kind === "admin" && <p className="rounded border border-warn/30 bg-warn/10 p-2 text-xs text-warn">Admin licenses let transforms read the channel&apos;s key: share them only with users who may hold it.</p>}
      {error && <p className="text-bad">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className={buttonClass.primary} disabled={!name || (!hashing && !ops.length)} onClick={issue}>Issue license</button>
        <button type="button" className={buttonClass.ghost} onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function Playground() {
  const [licenses, setLicenses] = useState<CipherLicense[]>([]);
  const [lic, setLic] = useState("");
  const [op, setOp] = useState<"encrypt" | "decrypt" | "hash">("encrypt");
  const [value, setValue] = useState("");
  const [out, setOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    cipherApi.licenses({ kind: "operational" }).then(setLicenses, () => {});
  }, []);
  if (!licenses.length) return null;
  const run = async () => {
    setError(null);
    try {
      setOut((await cipherApi.operate(lic, op, value, "Cipher playground")).value);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card title="Try a value (Operational User licenses)">
      <div className="flex flex-wrap items-center gap-2 p-4 text-sm">
        <select className={fieldClass} value={lic} onChange={(e) => setLic(e.target.value)}>
          <option value="">License…</option>
          {licenses.map((l) => <option key={l.rid} value={l.rid}>{l.name} ({l.channel?.name})</option>)}
        </select>
        <select className={fieldClass} value={op} onChange={(e) => setOp(e.target.value as "encrypt" | "decrypt" | "hash")}>
          <option value="encrypt">Encrypt</option><option value="decrypt">Decrypt</option><option value="hash">Hash</option>
        </select>
        <input className={`${fieldClass} min-w-60 flex-1 font-mono`} placeholder="Value" value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="button" className={buttonClass.primary} disabled={!lic} onClick={run}>Run</button>
        {out !== null && <code className="w-full break-all rounded bg-ink p-2 text-xs">{out}</code>}
        {error && <p className="w-full text-bad">{error}</p>}
      </div>
    </Card>
  );
}
