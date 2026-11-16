/** Artifact repositories (api/artifact_repos.py): Conda, PyPI and Maven packages next to the Docker images of an
 *  Artifacts repository (api/container_registry.py). */
import { API_URL } from "./api";

export type ArtifactFormat = "docker" | "conda" | "pypi" | "maven";
export type Recall = { reason: string | null; at: string; by: string } | null;
export type ArtifactVersion = {
  version: string;
  files: string[];
  size: number;
  published_at: string | null;
  published_by: string | null;
  recalled: Recall;
  depends?: string[];
};
export type Artifact = { format: ArtifactFormat; name: string; versions: ArtifactVersion[] };
export type ArtifactDetail = Artifact & { consumers: { repo_id: string; repo_name: string; requested: string }[] };
export type RepoOverview = {
  id: string;
  name: string;
  slug: string;
  rid: string;
  item_id: string;
  path: string;
  created_at: string;
  created_by: string;
  description: string;
  can_publish: boolean;
  counts: Record<ArtifactFormat, number>;
  versions: number;
  size: number;
};

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(API_URL + "/api/artifact-repos" + path, {
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

export const artifactRepos = {
  overview: (id: string) => req<RepoOverview>(`/${id}/overview`),
  artifacts: (id: string, format?: string, q?: string) =>
    req<Artifact[]>(`/${id}/artifacts?${new URLSearchParams(Object.entries({ format: format ?? "", q: q ?? "" }).filter(([, v]) => v)).toString()}`),
  artifact: (id: string, format: ArtifactFormat, name: string) => req<ArtifactDetail>(`/${id}/artifacts/${format}/${encodeURIComponent(name)}`),
  token: (id: string, format: ArtifactFormat) => req<{ token: string; expires_at: string | null; user: string; slug: string; note?: string }>(`/${id}/publish-token`, { method: "POST", json: { format } }),
  recall: (id: string, format: ArtifactFormat, name: string, version: string, reason: string) =>
    req<{ recalled: string[] }>(`/${id}/recall`, { method: "POST", json: { format, name, version, reason } }),
  unrecall: (id: string, format: ArtifactFormat, name: string, version: string) =>
    req<{ unrecalled: string[] }>(`/${id}/unrecall`, { method: "POST", json: { format, name, version } }),
  upload: (id: string, format: "conda" | "pypi" | "maven", file: File, opts: { subdir?: string; path?: string } = {}) =>
    req<Record<string, unknown>>(
      `/${id}/upload/${format}?${new URLSearchParams({ file: file.name, ...(opts.subdir ? { subdir: opts.subdir } : {}), ...(opts.path ? { path: opts.path } : {}) }).toString()}`,
      { method: "POST", body: file },
    ),
};

/** The base URL package clients use: this API's origin. */
export function apiOrigin(): string {
  try {
    return new URL(API_URL || (typeof window !== "undefined" ? window.location.origin : "http://localhost:8000")).origin;
  } catch {
    return "http://localhost:8000";
  }
}

export const FORMAT_LABEL: Record<ArtifactFormat, string> = { docker: "Docker", conda: "Conda", pypi: "PyPI", maven: "Maven" };

/** Publish instructions per format, with the token and parameters filled in. */
export function publishInstructions(format: ArtifactFormat, slug: string, host: string, user: string, token: string, param: string): { title: string; commands: string; details: string[] } {
  const origin = host.replace(/\/$/, "");
  const hostOnly = origin.replace(/^https?:\/\//, "");
  const withAuth = origin.replace(/^(https?:\/\/)/, `$1${encodeURIComponent(user)}:${token}@`);
  switch (format) {
    case "conda":
      return {
        title: "Upload a conda package (.tar.bz2 or .conda) into its subdir",
        commands: `conda build ${param || "recipe/"}\ncurl -u "${user}:${token}" -T <path to package>/noarch/<name>-<version>-<build>.tar.bz2 \\\n  ${origin}/artifacts/${slug}/conda/noarch/`,
        details: [`Consume: conda install -c ${withAuth}/artifacts/${slug}/conda <name>`, "Platform packages go to linux-64, osx-arm64, win-64… instead of noarch.", "Code Repositories: add this repository in Settings → Artifacts and list the package in conda_recipe/meta.yaml."],
      };
    case "pypi":
      return {
        title: "Upload wheels and source distributions with twine",
        commands: `python -m build ${param}\ntwine upload --repository-url ${origin}/artifacts/${slug}/pypi/ \\\n  -u ${user} -p ${token} dist/*`,
        details: [`Consume: pip install --index-url ${withAuth}/artifacts/${slug}/pypi/simple <name>`, "Code Repositories: add this repository in Settings → Artifacts; pure-Python wheels resolve in conda_recipe/meta.yaml."],
      };
    case "maven":
      return {
        title: "Publish with Gradle (maven-publish) or mvn deploy",
        commands: `// build.gradle
apply plugin: 'maven-publish'
publishing {
    publications { mavenJava(MavenPublication) { from components.java } }
    repositories {
        maven {
            url '${origin}/artifacts/${slug}/maven'
            credentials { username '${user}'; password '${token}' }
        }
    }
}
// then: ./gradlew publish${param ? ` ${param}` : ""}`,
        details: ["Files go to <group path>/<artifact>/<version>/; releases cannot be replaced (SNAPSHOT versions can).", "Java transforms: add this repository in Settings → Artifacts and compile 'group:artifact:version' in build.gradle."],
      };
    default:
      return {
        title: "Push a Docker image",
        commands: `docker login ${hostOnly} -u ${user} -p ${token}\ndocker tag <image>:<tag> ${hostOnly}/${slug}/<image>:<tag>\ndocker push ${hostOnly}/${slug}/<image>:<tag>${param ? `\n# ${param}` : ""}`,
        details: ["Images need a numeric non-root user, linux/amd64 and a tag other than latest (Containers → Image overview shows the checks)."],
      };
  }
}
