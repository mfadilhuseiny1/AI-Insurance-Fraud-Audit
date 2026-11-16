"use client";

import { useEffect, useState } from "react";
import { LocationField, missingText, type PickedLocation } from "@/components/LocationField";
import { buttonClass, inputClass, Modal } from "@/components/pipeline/Modal";
import { codeRepos, type RepoSummary } from "@/lib/codeRepos";
import { trainedModels, type ExternalInput, type TrainedModel, type TrainedVersion } from "@/lib/modelAssets";

const pairs = (text: string) =>
  Object.fromEntries(text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => [l.slice(0, l.indexOf("=") < 0 ? l.length : l.indexOf("=")).trim(), l.includes("=") ? l.slice(l.indexOf("=") + 1).trim() : ""]));

/** Connect an externally hosted model (palantir.com/docs/foundry/integrate-models/external-model-connection), or (with
 *  `model`) create a new version of one: the URL, unencrypted configuration, encrypted credentials and the adapter. */
export function ExternalModelForm({ model, version, onClose, onSaved }: { model?: TrainedModel; version?: TrainedVersion; onClose: () => void; onSaved: (m: TrainedModel) => void }) {
  const ext = version?.external;
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<PickedLocation | null>(null);
  const [tried, setTried] = useState(false);
  const [url, setUrl] = useState(ext?.base_url ?? "");
  const [config, setConfig] = useState(Object.entries(ext?.configuration ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"));
  const [creds, setCreds] = useState((ext?.credential_keys ?? []).map((k) => `${k}=`).join("\n"));
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [repoId, setRepoId] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState("");
  const [cls, setCls] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { codeRepos.list().then(setRepos, () => {}); }, []);
  useEffect(() => {
    if (!repoId) return;
    codeRepos.get(repoId).then((r) => setFiles(Object.keys(r.files).filter((f) => f.endsWith(".py") && f.includes("src/")).sort()), () => setFiles([]));
  }, [repoId]);
  // the save button stays clickable: a click with something missing says what, next to the button and on the fields
  const missing = [
    ...(!model && !name.trim() ? ["enter a model name"] : []),
    ...(!model && !folder ? ["choose a save location"] : []),
    ...(!model && !repoId ? ["choose the adapter's Code Repository"] : []),
    ...((!model || repoId) && !file ? ["choose the adapter file"] : []),
    ...((!model || repoId) && !cls.trim() ? ["enter the adapter class name"] : []),
  ];
  const bad = (on: boolean) => (tried && on ? "border-bad ring-1 ring-bad/40" : "");
  const save = async () => {
    setTried(true);
    if (missing.length) return;
    setBusy(true);
    setErr(null);
    const body: ExternalInput = { base_url: url, configuration: pairs(config), credentials: pairs(creds), note, ...(repoId ? { adapter_repo_id: repoId, adapter_file: file, adapter_class: cls } : {}) };
    try {
      onSaved(model ? await trainedModels.externalVersion(model.id, body) : await trainedModels.createExternal({ ...body, name, folder_id: folder?.id }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={model ? `New version of ${model.name}` : "Connect an externally hosted model"} icon="plug" onClose={onClose} wide>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto p-5 text-sm">
        {!model && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 flex items-center gap-1 text-xs font-medium text-soft">Model name <span className="text-bad" aria-hidden>*</span></span>
              <input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={tried && !name.trim()} className={`${inputClass} ${bad(!name.trim())}`} />
              {tried && !name.trim() && <span className="mt-1 block text-[11px] text-bad">Give the model a name.</span>}
            </label>
            <LocationField value={folder} onChange={setFolder} invalid={tried} label="Save location" hint="Where the model goes." />
          </div>
        )}
        <label className="block text-xs text-muted">URL given to the adapter (the model&apos;s inference endpoint)<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className={`${inputClass} mt-1`} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-muted">Connection configuration (key=value per line, stored unencrypted)<textarea rows={4} value={config} onChange={(e) => setConfig(e.target.value)} placeholder="model_name=risk-v2" className={`${inputClass} mt-1 font-mono text-xs`} /></label>
          <label className="text-xs text-muted">Credentials (key=value per line, encrypted{model ? "; an empty value keeps the current one" : ""})<textarea rows={4} value={creds} onChange={(e) => setCreds(e.target.value)} placeholder="api_key=…" className={`${inputClass} mt-1 font-mono text-xs`} /></label>
        </div>
        <div className="rounded border border-line bg-panel-2 p-3 text-xs">
          <div className="mb-2 text-muted">Model adapter{!model && <span className="text-bad" aria-hidden> *</span>}: a <code>pm.ExternalModelAdapter</code> class whose <code>init_external(external_context)</code> reads <code>base_url</code>, <code>connection_config</code> and <code>resolved_credentials</code>{model ? " (empty: keep the current adapter)" : ""}.</div>
          <div className="grid gap-2 sm:grid-cols-3">
            <select value={repoId} onChange={(e) => { setRepoId(e.target.value); setFile(""); }} className={`${inputClass} text-xs ${bad(!model && !repoId)}`}><option value="">Code Repository…</option>{repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
            <select value={file} onChange={(e) => setFile(e.target.value)} className={`${inputClass} text-xs ${bad((!model || !!repoId) && !file)}`}><option value="">File…</option>{files.map((f) => <option key={f}>{f}</option>)}</select>
            <input value={cls} onChange={(e) => setCls(e.target.value)} placeholder="Class name" className={`${inputClass} font-mono text-xs ${bad((!model || !!repoId) && !cls.trim())}`} />
          </div>
        </div>
        <label className="block text-xs text-muted">Version notes<input value={note} onChange={(e) => setNote(e.target.value)} className={`${inputClass} mt-1`} /></label>
        <p className="text-[11px] text-muted">The adapter is loaded once to check it and record its API. Network access from models is not restricted by egress policies here.</p>
        {err && <pre className="whitespace-pre-wrap rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</pre>}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
        {missing.length > 0 && <span className={`mr-auto text-xs ${tried ? "text-bad" : "text-muted"}`} data-create-missing>To {model ? "create" : "connect"}: {missingText(missing)}</span>}
        <button type="button" onClick={onClose} className={buttonClass.ghost}>Cancel</button>
        <button type="button" disabled={busy} onClick={save} className={buttonClass.primary}>
          {busy ? "Checking the adapter…" : model ? "Create version" : "Connect model"}
        </button>
      </div>
    </Modal>
  );
}
