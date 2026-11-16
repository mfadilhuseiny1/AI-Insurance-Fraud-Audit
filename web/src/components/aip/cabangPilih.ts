/* AI Agent Swarm Branch: the project sidebar (ProyekCabang) and the branch report (SwarmCabangView) sit side by side and do not
   import each other. Picking an audit that has a run asks the report to show that run through a window event; the report may
   answer the other way when its own run picker changes, so the sidebar follows it.
     CABANG_PILIH_RUN   "cabang-pilih-run"   detail: the run id (runs.json id)   sidebar -> report
     CABANG_RUN_DIPILIH "cabang-run-dipilih" detail: the run id                  report -> sidebar (optional)
   The two load their lists at the same time, so a request can arrive before the report has its runs: runCabangTerakhir() is the
   last run asked for, for the report to prefer over its default (the newest run) once its list is in. */

export const CABANG_PILIH_RUN = "cabang-pilih-run";
export const CABANG_RUN_DIPILIH = "cabang-run-dipilih";

let terakhir: string | null = null;

/** Show this run's report in the branch tab. */
export function pilihRunCabang(runId: string): void {
  terakhir = runId;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<string>(CABANG_PILIH_RUN, { detail: runId }));
}

/** The last run the sidebar asked the report to show (null before any). */
export function runCabangTerakhir(): string | null {
  return terakhir;
}

/** For the report: say which run it now shows (its own picker), so the sidebar highlights that audit. */
export function umumkanRunCabang(runId: string): void {
  terakhir = runId;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<string>(CABANG_RUN_DIPILIH, { detail: runId }));
}
