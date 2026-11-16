/**
 * Trained models in a pipeline: train simple models on a node's output (linear / logistic regression,
 * k-means), import them as JSON, or register a REST endpoint; the model node runs their inference
 * over the rows. REST models go through Services like LLM calls (answers looked up by key).
 */
import { hashKey } from "./llm";
import { type Cell, type EvalOptions, type ModelNode, type NodeResult, type Row, type Table, type TrainedModel, uid } from "./pipeline";

const num = (v: Cell): number | null => {
  if (v === null || v === "" || typeof v === "boolean") return v === true ? 1 : v === false ? 0 : null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The numeric feature vector of a row (categorical features one-hot encoded by their known categories). */
function vector(m: TrainedModel & { categories?: Record<string, string[]> }, row: Row, columns: string[]): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < m.features.length; i++) {
    const f = m.features[i];
    const v = row[columns[i]] ?? null;
    if (f.type === "categorical") {
      const cats = m.categories?.[f.name] ?? [];
      // the first category is the baseline (dropped) column
      for (const c of cats.slice(1)) out.push(String(v) === c ? 1 : 0);
    } else {
      const n = num(v);
      if (n === null) return null;
      out.push(n);
    }
  }
  return out;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function computeModel(t: Table, node: ModelNode, opts: EvalOptions): NodeResult {
  if (t.files) throw new Error("Extract rows from the files before running a model");
  const m = node.model;
  if (!m) throw new Error("Choose a model");
  if (node.features.length !== (m.algorithm === "rest" ? node.features.length : m.features.length))
    throw new Error("Map a column to every model feature");
  for (const c of node.features) if (!t.columns.some((x) => x.name === c)) throw new Error(`Column "${c}" not found`);
  const out = node.output.trim() || "prediction";
  let pending = 0;
  const rows = t.rows.map((row) => {
    let pred: Cell = null;
    let prob: Cell = null;
    if (m.algorithm === "rest") {
      const features = Object.fromEntries(node.features.map((c, i) => [m.features[i]?.name ?? c, row[c] ?? null]));
      const key = `model:${hashKey(m.url + JSON.stringify(features))}`;
      const a = opts.services?.get(key);
      if (!a) {
        pending++;
        opts.services?.request({ key, kind: "model", payload: { url: m.url, headers: m.headers ?? {}, features } });
      } else if ("value" in a) pred = typeof a.value === "object" ? JSON.stringify(a.value) : (a.value as Cell);
    } else {
      const x = vector(m, row, node.features);
      if (x) {
        if (m.algorithm === "linear") pred = m.intercept + x.reduce((s, v, i) => s + v * (m.coefficients[i] ?? 0), 0);
        else if (m.algorithm === "logistic") {
          const p = sigmoid(m.intercept + x.reduce((s, v, i) => s + v * (m.coefficients[i] ?? 0), 0));
          prob = Math.round(p * 1e6) / 1e6;
          pred = p >= 0.5 ? m.classes[1] : m.classes[0];
        } else {
          const z = m.scale ? x.map((v, i) => (v - m.scale!.mean[i]) / (m.scale!.std[i] || 1)) : x;
          let best = 0;
          let bestD = Infinity;
          m.centroids.forEach((c, k) => {
            const d = c.reduce((s, cv, i) => s + (cv - z[i]) ** 2, 0);
            if (d < bestD) {
              bestD = d;
              best = k;
            }
          });
          pred = best;
        }
      }
    }
    const r: Row = { ...row, [out]: pred };
    if (m.algorithm === "logistic") r[`${out}_probability`] = prob;
    return r;
  });
  const predType = m.algorithm === "linear" ? "Double" : m.algorithm === "kmeans" ? "Integer" : "String";
  const columns = [...t.columns.filter((c) => c.name !== out && c.name !== `${out}_probability`), { name: out, type: predType } as const];
  if (m.algorithm === "logistic") columns.push({ name: `${out}_probability`, type: "Double" });
  if (m.algorithm === "rest" && !opts.services) return { error: "REST models run when the pipeline runs" };
  return { table: { columns: [...columns], rows }, pending };
}

// ---------------------------------------------------------------- training

/** Solves A x = b by Gaussian elimination with partial pivoting (small systems). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) M[c][c] = 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

export type TrainSpec = {
  name: string;
  algorithm: "linear" | "logistic" | "kmeans";
  features: string[];
  target?: string;
  k?: number;
};

function design(t: Table, features: string[]) {
  const types = features.map((f) => {
    const c = t.columns.find((x) => x.name === f);
    if (!c) throw new Error(`Column "${f}" not found`);
    return c.type === "String" || c.type === "Boolean" ? ("categorical" as const) : ("numeric" as const);
  });
  const categories: Record<string, string[]> = {};
  features.forEach((f, i) => {
    if (types[i] === "categorical") categories[f] = [...new Set(t.rows.map((r) => String(r[f] ?? "")))].sort().slice(0, 50);
  });
  return { types, categories };
}

/** Trains a model on a table (what "Train model" on a node does). */
export function trainModel(t: Table, spec: TrainSpec): TrainedModel {
  if (!spec.features.length) throw new Error("Choose the feature columns");
  const { types, categories } = design(t, spec.features);
  const base = {
    id: uid(),
    name: spec.name.trim() || "Model",
    createdAt: new Date().toISOString(),
    features: spec.features.map((name, i) => ({ name, type: types[i] })),
  };
  const proto = { ...base, algorithm: "linear" as const, intercept: 0, coefficients: [], categories };
  const rows = t.rows.map((r) => ({ x: vector(proto, r, spec.features), y: spec.target ? r[spec.target] ?? null : null })).filter((r) => r.x);
  if (rows.length < 2) throw new Error("Not enough rows with values in every feature");

  if (spec.algorithm === "kmeans") {
    const k = Math.max(1, Math.min(spec.k ?? 3, rows.length));
    const X = rows.map((r) => r.x!);
    const dims = X[0].length;
    const mean = Array.from({ length: dims }, (_, i) => X.reduce((s, x) => s + x[i], 0) / X.length);
    const std = Array.from({ length: dims }, (_, i) => Math.sqrt(X.reduce((s, x) => s + (x[i] - mean[i]) ** 2, 0) / X.length) || 1);
    const Z = X.map((x) => x.map((v, i) => (v - mean[i]) / std[i]));
    // k-means++ style deterministic init: spread picks across the data
    let centroids = Array.from({ length: k }, (_, j) => [...Z[Math.floor((j * Z.length) / k)]]);
    let inertia = 0;
    for (let iter = 0; iter < 50; iter++) {
      const sums = centroids.map(() => new Array(dims).fill(0));
      const counts = new Array(k).fill(0);
      inertia = 0;
      for (const z of Z) {
        let best = 0;
        let bestD = Infinity;
        centroids.forEach((c, j) => {
          const d = c.reduce((s, cv, i) => s + (cv - z[i]) ** 2, 0);
          if (d < bestD) [best, bestD] = [j, d];
        });
        inertia += bestD;
        counts[best]++;
        z.forEach((v, i) => (sums[best][i] += v));
      }
      const next = sums.map((s, j) => (counts[j] ? s.map((v: number) => v / counts[j]) : centroids[j]));
      const moved = next.some((c, j) => c.some((v: number, i: number) => Math.abs(v - centroids[j][i]) > 1e-9));
      centroids = next;
      if (!moved) break;
    }
    return { ...base, algorithm: "kmeans", centroids, scale: { mean, std }, metrics: { inertia: Math.round(inertia * 1000) / 1000, k } };
  }

  if (!spec.target) throw new Error("Choose the target column");
  if (spec.algorithm === "linear") {
    const data = rows.map((r) => ({ x: r.x!, y: num(r.y) })).filter((r): r is { x: number[]; y: number } => r.y !== null);
    if (data.length < 2) throw new Error("The target needs numbers");
    const d = data[0].x.length + 1;
    const A = Array.from({ length: d }, () => new Array(d).fill(0));
    const b = new Array(d).fill(0);
    for (const { x, y } of data) {
      const v = [1, ...x];
      for (let i = 0; i < d; i++) {
        b[i] += v[i] * y;
        for (let j = 0; j < d; j++) A[i][j] += v[i] * v[j];
      }
    }
    for (let i = 1; i < d; i++) A[i][i] += 1e-8; // ridge for collinear features
    const w = solve(A, b);
    const mean = data.reduce((s, r) => s + r.y, 0) / data.length;
    const sse = data.reduce((s, r) => s + (r.y - (w[0] + r.x.reduce((a, v, i) => a + v * w[i + 1], 0))) ** 2, 0);
    const sst = data.reduce((s, r) => s + (r.y - mean) ** 2, 0) || 1;
    return {
      ...base,
      target: spec.target,
      algorithm: "linear",
      intercept: w[0],
      coefficients: w.slice(1),
      categories,
      metrics: { r2: Math.round((1 - sse / sst) * 10000) / 10000, rmse: Math.round(Math.sqrt(sse / data.length) * 10000) / 10000, rows: data.length },
    };
  }

  // logistic: two classes, gradient descent on standardized-ish features
  const labels = [...new Set(rows.map((r) => String(r.y ?? "")).filter(Boolean))].sort();
  if (labels.length !== 2) throw new Error(`Logistic regression needs a target with exactly two values (found ${labels.length})`);
  const data = rows.filter((r) => labels.includes(String(r.y))).map((r) => ({ x: r.x!, y: String(r.y) === labels[1] ? 1 : 0 }));
  const d = data[0].x.length;
  let w0 = 0;
  const w = new Array(d).fill(0);
  const scale = Array.from({ length: d }, (_, i) => Math.max(1e-9, ...data.map((r) => Math.abs(r.x[i]))));
  const lr = 0.5;
  for (let iter = 0; iter < 2000; iter++) {
    let g0 = 0;
    const g = new Array(d).fill(0);
    for (const r of data) {
      const p = sigmoid(w0 + r.x.reduce((s, v, i) => s + (v / scale[i]) * w[i], 0));
      const e = p - r.y;
      g0 += e;
      r.x.forEach((v, i) => (g[i] += e * (v / scale[i])));
    }
    w0 -= (lr * g0) / data.length;
    for (let i = 0; i < d; i++) w[i] -= (lr * (g[i] / data.length + 1e-4 * w[i]));
  }
  const coefficients = w.map((v, i) => v / scale[i]);
  const correct = data.filter((r) => (sigmoid(w0 + r.x.reduce((s, v, i) => s + v * coefficients[i], 0)) >= 0.5 ? 1 : 0) === r.y).length;
  return {
    ...base,
    target: spec.target,
    algorithm: "logistic",
    intercept: w0,
    coefficients,
    classes: [labels[0], labels[1]],
    categories,
    metrics: { accuracy: Math.round((correct / data.length) * 10000) / 10000, rows: data.length },
  };
}
