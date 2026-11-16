/** The R transforms app (api/code_r_tools.py): the R runtime, R repositories, CRAN / Bioconductor packages and renv.
 *  R transforms build and check through Code Repositories (lib/codeRepos.ts). */
import { API_URL } from "./api";

export type RRuntime = { available: boolean; version: string | null; executable: string | null; error: string | null; library: string | null; cran: string; bioconductor: string };
export type RRepository = { id: string; name: string; description: string; default_branch: string; branches: string[]; specs: number; updated_at: string | null };
export type RPackage = { name: string; version: string | null; license: string; repository: "CRAN" | "Bioconductor"; depends: string; imports: string; installed: string | null };

async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/code-repos" + path, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

export const rTransforms = {
  runtime: () => request<RRuntime>("/tools/r/runtime"),
  repositories: () => request<RRepository[]>("/tools/r/repositories"),
  search: (q: string) => request<RPackage[]>(`/tools/r/packages?q=${encodeURIComponent(q)}`),
  /** {package: version} R can load: the shared library, base and recommended packages */
  installed: () => request<Record<string, string>>("/tools/r/installed"),
  /** install into the shared R library every R transform sees */
  install: (repoId: string, packages: string[], repository: RPackage["repository"] = "CRAN") =>
    request<{ ok: boolean; installed: Record<string, string | null>; log: string }>(`/${repoId}/r/install`, { method: "POST", json: { packages, repository } }),
  /** renv::snapshot() of the packages the R code uses: renv.lock on the branch (uncommitted) */
  snapshot: (repoId: string, branch: string) =>
    request<{ ok: boolean; file: string; packages: string[]; locked: string[] }>(`/${repoId}/r/snapshot`, { method: "POST", json: { branch } }),
};

/** Packages the R code loads: library(x), require(x), requireNamespace("x") and x::f (as api/code_r_tools.py). */
export function usedPackages(files: Record<string, string>): string[] {
  const base = new Set(["foundry", "base", "stats", "utils", "methods", "graphics", "grDevices", "datasets", "tools", "parallel", "grid", "splines", "stats4", "tcltk", "compiler"]);
  const found = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    if (!/\.r$/i.test(path) && !path.endsWith(".Rprofile")) continue;
    const code = text.replace(/#[^\n]*/g, "");
    for (const m of code.matchAll(/\b(?:library|require|requireNamespace)\s*\(\s*['"]?([A-Za-z][A-Za-z0-9.]*)/g)) found.add(m[1]);
    for (const m of code.matchAll(/\b([A-Za-z][A-Za-z0-9.]*):::?[A-Za-z._]/g)) found.add(m[1]);
  }
  return [...found].filter((p) => !base.has(p)).sort();
}

/** renv.lock's packages: {name: {Version, Source, Repository}} (an empty map without one). */
export function lockedPackages(files: Record<string, string>): Record<string, { Version?: string; Source?: string; Repository?: string }> {
  try {
    return JSON.parse(files["renv.lock"] ?? "{}").Packages ?? {};
  } catch {
    return {};
  }
}
