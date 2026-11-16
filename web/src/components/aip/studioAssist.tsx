"use client";

import type { AlgorithmSpec, Studio, StudioConfig, TrainerSpec } from "@/lib/modelStudio";
import type { AssistAdapter } from "./AipAssist";

/* AIP Assist in Model Studio: reads the studio (trainer, target, features and their types, the current candidates)
   and the last run's benchmark (every candidate's validation metrics), and proposes candidates — algorithm templates
   with their constants — for a new configuration, or starts a training run. Every proposal is checked against the
   algorithm catalog before Apply. */

export type StudioAssistDeps = {
  studio: Studio;
  trainer: TrainerSpec | null;
  columns: { name: string; type: string }[];
  /** the last run's candidates with their validation metrics */
  benchmark: { candidate: string; metrics: Record<string, number> }[] | null;
  saveConfig: (cfg: Omit<StudioConfig, "version" | "created_at" | "created_by">) => Promise<void>;
  startRun: () => Promise<void>;
};

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

/** A proposed candidate list checked against the catalog: the problems, or none. */
function check(catalog: AlgorithmSpec[], raw: unknown): { algos: { algorithm: string; params: Record<string, unknown> }[]; errors: string[] } {
  const errors: string[] = [];
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) errors.push("no candidate proposed");
  if (list.length > 12) errors.push("at most 12 candidates");
  const algos = list.slice(0, 12).map((x, i) => {
    const a = (x ?? {}) as { algorithm?: unknown; params?: unknown };
    const spec = catalog.find((c) => c.key === str(a.algorithm));
    const params = (a.params && typeof a.params === "object" ? a.params : {}) as Record<string, unknown>;
    if (!spec) errors.push(`candidate ${i + 1}: unknown algorithm "${str(a.algorithm)}"`);
    else
      for (const [k, v] of Object.entries(params)) {
        const p = spec.params.find((q) => q.key === k);
        if (!p) errors.push(`${spec.name}: no setting ${k}`);
        else if ((p.kind === "int" || p.kind === "float") && v !== null && v !== "") {
          const n = Number(v);
          if (Number.isNaN(n) || (p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max)) errors.push(`${spec.name}: ${k} must be ${p.min}–${p.max}`);
          else params[k] = p.kind === "int" ? Math.round(n) : n;
        } else if (p.kind === "select" && !(p.options ?? []).includes(str(v))) errors.push(`${spec.name}: ${k} is one of ${(p.options ?? []).join(", ")}`);
      }
    return { algorithm: str(a.algorithm), params };
  });
  return { algos, errors };
}

export function studioAssist(d: StudioAssistDeps): AssistAdapter {
  const { studio, trainer } = d;
  const cfg = studio.configs.at(-1);
  const catalog = trainer?.algorithms ?? [];
  const name = (k: string) => catalog.find((a) => a.key === k)?.name ?? k;
  return {
    key: `studio:${studio.id}`,
    app: `Model Studio — ${studio.name}`,
    selectHint: "AIP Assist reads the studio's configuration, the dataset columns and the last run's benchmark.",
    system:
      "You are an ML engineer helping a user of Model Studio (no-code training) choose algorithms and their hyperparameters. " +
      "Recommend candidates suited to the data (rows, feature types, class balance) and explain trade-offs briefly (accuracy, speed, interpretability, " +
      "overfitting). Use only algorithms and setting keys from the catalog, within their ranges. Propose 3–8 candidates for a benchmark, including a simple " +
      "baseline. When results exist, interpret them (which candidate wins on which metric, whether differences matter) and suggest the next configuration.",
    context: () => {
      const lines = [
        `Studio "${studio.name}", trainer: ${studio.trainer}. Output model: ${studio.model.name} (${studio.model.versions} version(s)).`,
        cfg
          ? `Current configuration v${cfg.version} "${cfg.name}": target ${cfg.target}; features ${(cfg.features.length ? cfg.features : d.columns.map((c) => c.name).filter((c) => c !== cfg.target && !cfg.ignored.includes(c))).join(", ")}; ` +
            `evaluation metric ${str((cfg.params as Record<string, unknown>).eval_metric) || "default"}; candidates: ${
              ((cfg.params as Record<string, unknown>).algorithms as { algorithm: string; params: Record<string, unknown> }[] | undefined)?.map((a) => `${name(a.algorithm)} ${JSON.stringify(a.params)}`).join("; ") ||
              "the built-in quick models (LR, KNN, GBM)"
            }.`
          : "Not configured yet (no dataset or target).",
        d.columns.length ? `Training dataset columns: ${d.columns.map((c) => `${c.name}:${c.type}`).join(", ")}.` : "",
        trainer ? `Evaluation metrics available: ${trainer.metrics.join(", ")}.` : "",
        d.benchmark?.length
          ? `Last run's benchmark (validation rows):\n${d.benchmark.map((b) => `- ${b.candidate}: ${Object.entries(b.metrics).map(([k, v]) => `${k} ${v.toFixed(4)}`).join(", ")}`).join("\n")}`
          : "No run results yet.",
        `\n## Algorithm catalog (key: name — settings key[kind default min..max | options])\n${catalog
          .map((a) => `${a.key}: ${a.name} — ${a.params.map((p) => `${p.key}[${p.kind} ${JSON.stringify(p.default)}${p.min !== undefined ? ` ${p.min}..${p.max}` : ""}${p.options ? ` ${p.options.join("|")}` : ""}]`).join(", ")}`)
          .join("\n")}`,
      ];
      return { selection: [], text: lines.filter(Boolean).join("\n") };
    },
    suggestions: () =>
      d.benchmark?.length
        ? ["Jelaskan hasil benchmark run terakhir", "Usulkan konfigurasi berikutnya untuk menaikkan skor", "Mana kandidat yang paling cocok untuk produksi?"]
        : ["Usulkan algoritma dan hyperparameter untuk data ini", "Buat benchmark Random Forest, ANN, SVM, XGBoost dan baseline", "Metrik evaluasi mana yang tepat untuk masalah ini?"],
    tools: catalog.length
      ? [
          {
            name: "set_candidates",
            description: 'args {"algorithms": [{"algorithm": catalog key, "params": {setting: value}}], "changelog": string, "eval_metric"?: one of the available metrics} — saves a new configuration with these candidates',
            preview: (a) => {
              const { algos, errors } = check(catalog, a.algorithms);
              if (!cfg) return { error: "Configure the studio first (dataset and target)" };
              if (a.eval_metric && trainer && !trainer.metrics.includes(str(a.eval_metric))) errors.push(`eval_metric is one of ${trainer.metrics.join(", ")}`);
              return {
                error: errors[0],
                detail: (
                  <ul className="space-y-0.5 text-[11px] text-soft">
                    {algos.map((x, i) => (
                      <li key={i}>
                        {i + 1}. {name(x.algorithm)} <span className="font-mono text-muted">{Object.entries(x.params).map(([k, v]) => `${k}=${String(v)}`).join(" ") || "defaults"}</span>
                      </li>
                    ))}
                    {a.eval_metric ? <li className="text-muted">metric: {str(a.eval_metric)}</li> : null}
                  </ul>
                ),
              };
            },
            run: async (a) => {
              const { algos, errors } = check(catalog, a.algorithms);
              if (!cfg || errors.length) throw new Error(errors[0] ?? "Configure the studio first");
              const { version: _v, created_at: _c, created_by: _b, ...rest } = cfg;
              void _v; void _c; void _b;
              await d.saveConfig({
                ...rest,
                name: `${cfg.name.replace(/ \(AIP\)$/, "")} (AIP)`,
                changelog: str(a.changelog) || "Candidates proposed by AIP Assist",
                params: { ...cfg.params, algorithms: algos, ...(a.eval_metric ? { eval_metric: str(a.eval_metric) } : {}) },
              });
              return `Configuration saved with ${algos.length} candidate(s): start a training run to benchmark them`;
            },
          },
          {
            name: "start_run",
            description: "args {} — starts a training run of the current configuration (every candidate is trained and compared)",
            preview: () => (cfg ? { text: `Train configuration v${cfg.version} "${cfg.name}"` } : { error: "Configure the studio first" }),
            run: async () => {
              await d.startRun();
              return "Training run started";
            },
          },
        ]
      : [],
  };
}
