"use client";

import { useEffect, useState } from "react";
import { ActivityLog, GroupsAdmin, MarkingsAdmin, OrganizationsAdmin, UsersAdmin } from "@/components/auth/Admin";
import { CipherLicenses } from "@/components/auth/CipherLicenses";
import { RolesAdmin, SpacesAdmin } from "@/components/auth/GovernanceAdmin";
import { BackupsAdmin } from "@/components/auth/Backups";
import { SecurityAdmin } from "@/components/auth/Security";
import { IcebergSettings } from "@/components/iceberg/IcebergSettings";
import { useAuth } from "@/components/AuthGate";
import { Icon, type IconName } from "@/components/Icon";
import { buttonClass, fieldClass } from "@/components/pipeline/Modal";
import { alertDialog, confirmDialog } from "@/lib/dialogs";
import { streaming, type ProfilesInfo, type StreamingProfile } from "@/lib/streaming";

const SETTING_LABEL: Record<string, string> = {
  parallelism: "Parallelism",
  batch_records: "Records per poll",
  max_record_bytes: "Max record size (bytes)",
  buffer_records: "Buffered records",
  checkpoint_interval_s: "Checkpoint interval (s)",
  poll_timeout_s: "Poll timeout (s)",
};

type Section = "users" | "groups" | "organizations" | "markings" | "roles" | "spaces" | "security" | "backups" | "cipher" | "activity" | "streaming" | "iceberg" | "linter";
const SECTIONS: { group: string; items: { id: Section; label: string; icon: IconName; admin?: boolean }[] }[] = [
  {
    group: "Users and access",
    items: [
      { id: "users", label: "Users", icon: "project", admin: true },
      { id: "groups", label: "Groups", icon: "layers", admin: true },
      { id: "organizations", label: "Organizations", icon: "globe", admin: true },
      { id: "markings", label: "Markings", icon: "eye", admin: true },
      { id: "roles", label: "Roles", icon: "lock", admin: true },
      { id: "spaces", label: "Spaces and templates", icon: "layers", admin: true },
      { id: "security", label: "Security", icon: "alert", admin: true },
      { id: "backups", label: "Backups", icon: "download", admin: true },
      { id: "cipher", label: "Cipher licenses", icon: "eye", admin: true },
      { id: "activity", label: "Sign-in activity", icon: "history", admin: true },
    ],
  },
  {
    group: "Enrollment settings",
    items: [
      { id: "streaming", label: "Streaming profiles", icon: "wave" },
      { id: "iceberg", label: "Iceberg table settings", icon: "layers" },
      { id: "linter", label: "Linter configuration", icon: "bug", admin: true },
    ],
  },
];

/**
 * Control Panel: users, groups, organizations, markings, security settings and sign-in activity (administrators), the
 * enrollment's streaming profiles and its Iceberg table settings (storage, encryption, project overrides).
 */
export default function ControlPanel() {
  const { me, enabled } = useAuth();
  const admin = !enabled || me?.role === "admin";
  const [section, setSection] = useState<Section>(() => {
    if (typeof window === "undefined") return "streaming";
    const q = new URLSearchParams(window.location.search).get("section") as Section | null;
    return q && SECTIONS.some((g) => g.items.some((i) => i.id === q)) ? q : "users";
  });
  const shown: Section = !admin && section !== "streaming" && section !== "iceberg" ? "streaming" : section;
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-56 shrink-0 border-r border-line bg-panel p-3 text-sm">
        <div className="mb-3 flex items-center gap-1.5 font-medium">
          <Icon name="sliders" className="h-4 w-4 text-ocean" /> Control Panel
        </div>
        {SECTIONS.filter((g) => g.items.some((i) => admin || !i.admin)).map((g) => (
          <div key={g.group} className="mb-3">
            <div className="mb-1 px-2 text-[11px] uppercase tracking-wide text-muted">{g.group}</div>
            {g.items
              .filter((i) => admin || !i.admin)
              .map((i) => (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => {
                    setSection(i.id);
                    window.history.replaceState(null, "", `?section=${i.id}`);
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left ${shown === i.id ? "bg-ocean/15 text-white ring-1 ring-ocean/40" : "text-soft hover:bg-panel-2"}`}
                >
                  <Icon name={i.icon} className="h-3.5 w-3.5" /> {i.label}
                </button>
              ))}
          </div>
        ))}
        {!admin && <p className="px-2 text-xs text-muted">Users, groups and markings are managed by administrators.</p>}
      </aside>
      <div className="dot-grid min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl p-8">
          {shown === "users" && <UsersAdmin />}
          {shown === "groups" && <GroupsAdmin />}
          {shown === "organizations" && <OrganizationsAdmin />}
          {shown === "markings" && <MarkingsAdmin />}
          {shown === "roles" && <RolesAdmin />}
          {shown === "spaces" && <SpacesAdmin />}
          {shown === "backups" && <BackupsAdmin />}
          {shown === "security" && <SecurityAdmin />}
          {shown === "cipher" && <CipherLicenses />}
          {shown === "activity" && <ActivityLog />}
          {shown === "streaming" && <StreamingProfiles />}
          {shown === "iceberg" && <IcebergSettings />}
          {shown === "linter" && (
            <div className="max-w-2xl space-y-2 text-sm">
              <h1 className="text-xl font-semibold">Linter configuration</h1>
              <p className="text-muted">Sweep schedules define which Projects Linter sweeps and with which rules (presets, rules added, rules excluded), and how often.</p>
              <a href="/linter?view=sweeps" className="inline-flex items-center gap-1.5 text-ocean hover:underline">
                <Icon name="external" className="h-3.5 w-3.5" /> Open the sweep schedules
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StreamingProfiles() {
  const [info, setInfo] = useState<ProfilesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    streaming.profiles().then(setInfo, (e: Error) => setError(e.message));
  }, []);
  return (
    <>
      <h1 className="text-xl font-semibold">Streaming profiles</h1>
      <p className="mb-5 mt-1 text-sm text-muted">
        Profiles size streaming syncs and streaming pipelines. A Project must reference a profile before its jobs can use it; selecting a non-restricted profile imports
        it automatically, restricted profiles are imported here by an enrollment resource administrator.
      </p>
      {error && <p className="text-sm text-bad">{error}</p>}
      {!info ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="space-y-3">
          {info.profiles.map((p) => (
            <ProfileCard key={p.id} p={p} info={info} onChange={setInfo} />
          ))}
        </div>
      )}
    </>
  );
}

function ProfileCard({ p, info, onChange }: { p: StreamingProfile; info: ProfilesInfo; onChange: (i: ProfilesInfo) => void }) {
  const others = info.projects.filter((x) => !p.projects.some((y) => y.id === x.id));
  const [project, setProject] = useState("");
  const add = () => {
    const id = project || others[0]?.id;
    if (id) streaming.addReference(p.id, id, true).then(onChange, (e: Error) => alertDialog(e.message));
  };
  const remove = async (projectId: string, name: string) => {
    if (
      !(await confirmDialog({
        title: "Remove profile reference",
        message: `Remove "${p.name}" from ${name}? Streaming jobs in that Project using this profile stop and cannot restart until the profile is imported again.`,
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    streaming.removeReference(p.id, projectId).then(onChange, (e: Error) => alertDialog(e.message));
  };
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center gap-2">
        <span className="font-medium">{p.name}</span>
        <span className="font-mono text-xs text-muted">{p.id}</span>
        {p.restricted && (
          <span className="flex items-center gap-1 rounded-full bg-warn/15 px-2 py-0.5 text-xs text-warn">
            <Icon name="alert" className="h-3 w-3" /> Restricted
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">{p.description}</p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {Object.entries(p.settings).map(([k, v]) => (
          <span key={k}>
            <span className="text-muted">{SETTING_LABEL[k] ?? k}:</span> {Number(v).toLocaleString()}
          </span>
        ))}
        {Object.keys(p.settings).length === 0 && <span className="text-muted">Platform defaults</span>}
      </div>
      <div className="mt-3 text-xs text-muted">Projects referencing this profile</div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {p.projects.length === 0 && <span className="text-xs text-muted">None</span>}
        {p.projects.map((x) => (
          <span key={x.id} className="flex items-center gap-1 rounded-full bg-panel-2 px-2 py-0.5 text-xs">
            <Icon name="project" className="h-3 w-3 text-muted" /> {x.name}
            <button type="button" onClick={() => remove(x.id, x.name)} className="text-muted hover:text-bad">
              <Icon name="x" className="h-3 w-3" />
            </button>
          </span>
        ))}
        {others.length > 0 && (
          <span className="ml-2 flex items-center gap-1">
            <select value={project || others[0].id} onChange={(e) => setProject(e.target.value)} className={`${fieldClass} py-0.5 text-xs`}>
              {others.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={add} className={`${buttonClass.secondary} py-0.5 text-xs`}>
              <Icon name="plus" className="h-3 w-3" /> Import into Project
            </button>
          </span>
        )}
      </div>
    </section>
  );
}
