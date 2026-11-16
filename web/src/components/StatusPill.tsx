import type { Job } from "@/lib/api";

const STYLES: Record<Job["status"], string> = {
  queued: "text-muted ring-line-2",
  running: "text-ocean ring-ocean/40",
  paused: "text-sand ring-sand/40",
  stopped: "text-soft ring-line-2",
  completed: "text-ok ring-ok/40",
  failed: "text-bad ring-bad/40",
};

export function StatusPill({ job }: { job: Job }) {
  const halting = job.halt && (job.status === "running" || job.status === "queued");
  const label = halting
    ? `${job.halt === "pause" ? "Pausing" : "Finishing"} ${job.pages_done}/${job.pages_total}`
    : job.status === "running"
      ? `Running ${job.pages_done}/${job.pages_total}`
      : job.status === "paused" || job.status === "stopped"
        ? `${job.status === "paused" ? "Paused" : "Stopped"} ${job.pages_done}/${job.pages_total}`
        : job.status === "completed" && job.partial
          ? "Completed (partial)"
          : job.status[0].toUpperCase() + job.status.slice(1);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${STYLES[job.status]}`}>
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${job.status === "running" ? "animate-pulse" : ""}`} />
      {label}
    </span>
  );
}
