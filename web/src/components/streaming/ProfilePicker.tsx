"use client";

import { useEffect, useMemo, useState } from "react";
import { streaming, type ProfileSettings, type ProfilesInfo } from "@/lib/streaming";
import { Icon } from "../Icon";
import { fieldClass } from "../pipeline/Modal";

const SETTING_LABEL: Record<keyof ProfileSettings, string> = {
  parallelism: "Parallelism (consumers)",
  batch_records: "Records per poll",
  max_record_bytes: "Max record size (bytes)",
  buffer_records: "Buffered records",
  checkpoint_interval_s: "Checkpoint interval (s)",
  poll_timeout_s: "Poll timeout (s)",
};

export function compose(info: ProfilesInfo, ids: string[], advanced: Partial<ProfileSettings>): ProfileSettings {
  const out = { ...info.defaults };
  for (const id of ids.length ? ids : ["default"]) {
    const p = info.profiles.find((x) => x.id === id);
    for (const [k, v] of Object.entries(p?.settings ?? {})) {
      const key = k as keyof ProfileSettings;
      out[key] = Math.max(out[key], v as number);
    }
  }
  for (const [k, v] of Object.entries(advanced)) if (v) out[k as keyof ProfileSettings] = Math.max(1, Number(v));
  return out;
}

/**
 * Streaming profiles: built-in profiles combine (each setting takes the largest value) and the
 * Advanced option overrides single settings. Selecting a profile imports it into the Project;
 * restricted profiles must already be imported there by Control Panel.
 */
export function ProfilePicker({
  value,
  advanced,
  projectId,
  onChange,
}: {
  value: string[];
  advanced: Partial<ProfileSettings>;
  projectId?: string;
  onChange: (profiles: string[], advanced: Partial<ProfileSettings>) => void;
}) {
  const [info, setInfo] = useState<ProfilesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(Object.keys(advanced).length > 0);
  useEffect(() => {
    streaming.profiles().then(setInfo, (e: Error) => setError(e.message));
  }, []);
  const project = projectId ?? info?.default_project;
  const settings = useMemo(() => (info ? compose(info, value, advanced) : null), [info, value, advanced]);
  if (error) return <p className="text-xs text-bad">{error}</p>;
  if (!info || !settings) return <p className="text-xs text-muted">Loading streaming profiles…</p>;
  const toggle = (id: string) => {
    const next = value.includes(id) ? value.filter((x) => x !== id) : [...value.filter((x) => x !== "default" || id === "default"), id];
    onChange(next.length ? next : ["default"], advanced);
  };
  return (
    <div className="space-y-2 text-xs">
      <div className="grid gap-1.5 sm:grid-cols-2">
        {info.profiles.map((p) => {
          const imported = !!project && p.projects.some((x) => x.id === project);
          const blocked = p.restricted && !imported;
          return (
            <label
              key={p.id}
              title={blocked ? "Restricted: an enrollment resource administrator imports it into this Project in Control Panel → Streaming profiles" : p.description}
              className={`flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 ${value.includes(p.id) ? "border-ocean/60 bg-ocean/10" : "border-line-2"} ${blocked ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <input type="checkbox" disabled={blocked} checked={value.includes(p.id)} onChange={() => toggle(p.id)} className="mt-0.5 accent-[var(--color-ocean)]" />
              <span className="min-w-0">
                <span className="flex items-center gap-1 font-medium text-soft">
                  {p.name}
                  {p.restricted && <Icon name="alert" className="h-3 w-3 text-warn" />}
                  {imported && <span className="text-[10px] text-muted">· in Project</span>}
                </span>
                <span className="block text-muted">{p.description}</span>
              </span>
            </label>
          );
        })}
      </div>
      <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="text-ocean hover:underline">
        {showAdvanced ? "Hide" : "Show"} Advanced profile (combine single settings)
      </button>
      {showAdvanced && (
        <div className="grid gap-2 sm:grid-cols-3">
          {(Object.keys(SETTING_LABEL) as (keyof ProfileSettings)[]).map((k) => (
            <label key={k} className="block">
              <span className="mb-0.5 block text-muted">{SETTING_LABEL[k]}</span>
              <input
                type="number"
                min={1}
                value={advanced[k] ?? ""}
                placeholder={String(settings[k])}
                onChange={(e) => {
                  const next = { ...advanced };
                  if (e.target.value) next[k] = Number(e.target.value);
                  else delete next[k];
                  onChange(value, next);
                }}
                className={`${fieldClass} w-full`}
              />
            </label>
          ))}
        </div>
      )}
      <p className="text-muted">
        Resulting job: {settings.parallelism} consumer{settings.parallelism === 1 ? "" : "s"}, {settings.batch_records.toLocaleString()} records per poll, records up to{" "}
        {(settings.max_record_bytes / 1_048_576).toFixed(0)} MB, checkpoint every {settings.checkpoint_interval_s}s.
      </p>
    </div>
  );
}
