import type { IconName } from "@/components/Icon";
import { FAMILIES, familyOf, type LineageNode, type PermissionStatus, type Permissions } from "@/lib/lineage";
import type { ScheduleRole } from "@/lib/runtime";

export type ColorBy = "type" | "permissions" | "stale" | "build" | "built_at" | "project" | "rows" | "schedules" | "schedule" | "health" | "custom";

/** Node color options, in headed groups (the picker searches labels and headings). */
export const COLOR_OPTIONS: { id: ColorBy; label: string; group: string; icon: IconName }[] = [
  { id: "type", label: "Resource type", group: "Resources", icon: "layers" },
  { id: "project", label: "Project", group: "Resources", icon: "folder" },
  { id: "permissions", label: "Permissions", group: "Security", icon: "lock" },
  { id: "build", label: "Build status", group: "Dataset builds", icon: "refresh" },
  { id: "stale", label: "Out-of-date", group: "Dataset builds", icon: "alert" },
  { id: "built_at", label: "Time last built", group: "Dataset builds", icon: "clock" },
  { id: "health", label: "Data health", group: "Dataset builds", icon: "gauge" },
  { id: "rows", label: "Row count", group: "Dataset builds", icon: "table" },
  { id: "schedules", label: "Schedule count", group: "Schedules", icon: "clock" },
  { id: "schedule", label: "Resolved schedule", group: "Schedules", icon: "pipeline" },
  { id: "custom", label: "Custom color", group: "Other", icon: "palette" },
];

/** Permissions: blue = the account can view the data, red = it cannot (as in Data Lineage's permission colouring). */
export const PERMISSION_COLORS: Record<PermissionStatus, { color: string; label: string }> = {
  view: { color: "#2f7fd6", label: "View data" },
  no_access: { color: "#e86a6a", label: "No access" },
  no_data: { color: "#6b7586", label: "No data" },
  unknown: { color: "#c3ccd8", label: "Permissions unknown" },
};

/** The lineage's permission legend: every node is blue or red for the account viewed as (the server settles empty
 * datasets and nodes without a data permission of their own); "unknown" only where you lack that access yourself, so it
 * cannot be shown. No account picked: every node gray, no information. */
export function permissionLegend(nodes: LineageNode[], perms: Permissions | null): { status: PermissionStatus; label: string; color: string; count: number }[] {
  if (!perms) return [{ status: "unknown", label: "No account selected", color: PERMISSION_COLORS.unknown.color, count: nodes.length }];
  const count = (k: PermissionStatus) => nodes.filter((n) => (perms.nodes[n.id]?.status ?? "unknown") === k).length;
  return (["view", "no_access", "unknown"] as PermissionStatus[])
    .filter((k) => k !== "unknown" || count(k) > 0)
    .map((k) => ({ status: k, ...PERMISSION_COLORS[k], count: count(k) }));
}

/** Status roles are fixed and always shown with an icon and a label. */
const STATUS = { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" };
const NEUTRAL = "#4a5568";
/** One hue (blue) for ordered magnitudes; brighter = more (more recent, more rows). Never darker than step 600 on dark. */
const RAMP = ["#184f95", "#256abf", "#5598e7", "#9ec5f4"];
/** Projects: the three categorical slots that pass all-pairs, then "Other". */
const CATEGORICAL = ["#3987e5", "#d95926", "#199e70"];
export const CUSTOM_SWATCHES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"];

export type LegendEntry = { label: string; color: string; icon?: IconName };
export type Coloring = { color: (n: LineageNode) => string; legend: LegendEntry[] };

const hoursSince = (at?: string) => (at ? (Date.now() - new Date(at).getTime()) / 3_600_000 : null);

/** A resolved schedule's roles: what it reads, builds on the way, builds as targets, and leaves out. */
const ROLE: Record<ScheduleRole, { label: string; color: string; icon: IconName }> = {
  input: { label: "Input (read, not built)", color: CATEGORICAL[0], icon: "download" },
  job: { label: "Job (the pipeline)", color: "#9085e9", icon: "pipeline" },
  intermediate: { label: "Intermediate (built, feeds a target)", color: "#c98500", icon: "layers" },
  output: { label: "Target output (built)", color: CATEGORICAL[2], icon: "output" },
  excluded: { label: "Excluded (never built)", color: STATUS.critical, icon: "x" },
};

export function coloring(mode: ColorBy, nodes: LineageNode[], custom: Record<string, string>, roles: Record<string, ScheduleRole> = {}, perms: Permissions | null = null): Coloring {
  switch (mode) {
    case "permissions":
      return {
        color: (n) => PERMISSION_COLORS[perms?.nodes[n.id]?.status ?? "unknown"].color,
        legend: permissionLegend(nodes, perms).map((e) => ({ label: `${e.label} (${e.count})`, color: e.color })),
      };
    case "schedule":
      return {
        color: (n) => (roles[n.id] ? ROLE[roles[n.id]].color : NEUTRAL),
        legend: [...(Object.keys(ROLE) as ScheduleRole[]).map((k) => ROLE[k]), { label: "Not part of the schedule", color: NEUTRAL, icon: "minus" as IconName }],
      };
    case "stale":
      return {
        color: (n) => (n.missing ? STATUS.critical : n.stale ? STATUS.warning : n.producers?.length ? STATUS.good : NEUTRAL),
        legend: [
          { label: "Up to date with its inputs", color: STATUS.good, icon: "check" },
          { label: "Out of date with a parent", color: STATUS.warning, icon: "alert" },
          { label: "Deleted but referenced", color: STATUS.critical, icon: "x" },
          { label: "Not built (source or app)", color: NEUTRAL, icon: "minus" },
        ],
      };
    case "build":
      return {
        color: (n) => {
          const s = n.last_build?.status;
          return !s ? NEUTRAL : s === "succeeded" ? STATUS.good : s === "running" || s === "queued" ? "#3d8bfd" : STATUS.critical;
        },
        legend: [
          { label: "Last build succeeded", color: STATUS.good, icon: "check" },
          { label: "Running or queued", color: "#3d8bfd", icon: "refresh" },
          { label: "Last build failed", color: STATUS.critical, icon: "x" },
          { label: "No builds", color: NEUTRAL, icon: "minus" },
        ],
      };
    case "built_at": {
      const bins: [number, string][] = [
        [1, "Within the last hour"],
        [24, "Within a day"],
        [24 * 7, "Within a week"],
        [Infinity, "Over a week ago"],
      ];
      return {
        color: (n) => {
          const h = hoursSince(n.last_build?.at ?? (n.producers?.length ? n.updated_at : undefined));
          if (h === null) return NEUTRAL;
          const i = bins.findIndex(([lim]) => h <= lim);
          return RAMP[RAMP.length - 1 - i];
        },
        legend: [...bins.map(([, label], i) => ({ label, color: RAMP[RAMP.length - 1 - i] })), { label: "Never built", color: NEUTRAL, icon: "minus" as IconName }],
      };
    }
    case "rows": {
      const bins: [number, string][] = [
        [1_000, "Under 1,000 rows"],
        [100_000, "Under 100,000"],
        [1_000_000, "Under 1 million"],
        [Infinity, "1 million or more"],
      ];
      return {
        color: (n) => {
          if (n.rows === undefined || n.rows === null) return NEUTRAL;
          return RAMP[bins.findIndex(([lim]) => (n.rows as number) < lim)];
        },
        legend: [...bins.map(([, label], i) => ({ label, color: RAMP[i] })), { label: "No row count", color: NEUTRAL, icon: "minus" as IconName }],
      };
    }
    case "project": {
      const counts = new Map<string, number>();
      for (const n of nodes) if (n.project) counts.set(n.project, (counts.get(n.project) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, CATEGORICAL.length).map(([p]) => p);
      return {
        color: (n) => (!n.project ? NEUTRAL : top.includes(n.project) ? CATEGORICAL[top.indexOf(n.project)] : "#6b7586"),
        legend: [
          ...top.map((p, i) => ({ label: p, color: CATEGORICAL[i] })),
          ...(counts.size > top.length ? [{ label: `Other projects (${counts.size - top.length})`, color: "#6b7586" }] : []),
          { label: "Not in Files", color: NEUTRAL, icon: "minus" as IconName },
        ],
      };
    }
    case "schedules":
      return {
        color: (n) => ((n.schedule_count ?? 0) > 0 || n.schedule ? "#5598e7" : NEUTRAL),
        legend: [
          { label: "Has an active schedule", color: "#5598e7", icon: "clock" },
          { label: "No schedule", color: NEUTRAL, icon: "minus" },
        ],
      };
    case "health":
      return {
        color: (n) => (!n.health ? NEUTRAL : n.health.status === "passing" ? STATUS.good : STATUS.critical),
        legend: [
          { label: "Health checks passing", color: STATUS.good, icon: "check" },
          { label: "A health check failing", color: STATUS.critical, icon: "alert" },
          { label: "No health checks", color: NEUTRAL, icon: "minus" },
        ],
      };
    case "custom":
      return {
        color: (n) => custom[n.id] ?? NEUTRAL,
        legend: [{ label: "Select nodes, then pick a colour in Properties", color: NEUTRAL }],
      };
    default:
      return {
        color: (n) => familyOf(n.kind).color,
        legend: FAMILIES.map((f) => ({ label: f.label, color: f.color })),
      };
  }
}

export const STATUS_COLORS = STATUS;
