export type OsdkAppKind = "client-facing" | "backend";
export type OsdkAppStatus = "draft" | "workspace" | "checks" | "deployed";
export type OsdkReactApp = {
  id: string;
  name: string;
  description: string;
  kind: OsdkAppKind;
  ontology: string;
  repository: string;
  branch: string;
  sdkPackage: string;
  status: OsdkAppStatus;
  version: string;
  createdAt: string;
  updatedAt: string;
};

const KEY = "bluesandai.developer-console.osdk-react-apps";

function starter(): OsdkReactApp[] {
  return [{ id: "osdk-starter", name: "Operations React application", description: "A client-facing React application powered by the Nexus SDK.", kind: "client-facing", ontology: "Operations Nexus", repository: "operations-react-app", branch: "main", sdkPackage: "@operations-react-app/sdk", status: "workspace", version: "0.1.0", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
}

export function readOsdkApps(): OsdkReactApp[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) { const items = starter(); window.localStorage.setItem(KEY, JSON.stringify(items)); return items; }
    return JSON.parse(raw) as OsdkReactApp[];
  } catch { return []; }
}

export function saveOsdkApps(apps: OsdkReactApp[]) { if (typeof window !== "undefined") window.localStorage.setItem(KEY, JSON.stringify(apps)); }

export function newOsdkApp(name: string, kind: OsdkAppKind): OsdkReactApp {
  const id = `osdk-${crypto.randomUUID().slice(0, 8)}`;
  return { id, name, description: "", kind, ontology: "Operations Nexus", repository: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "react-app", branch: "main", sdkPackage: `@bluesandai/${id}/sdk`, status: "draft", version: "0.1.0", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

export const statusInfo: Record<OsdkAppStatus, { label: string; hint: string }> = {
  draft: { label: "Draft", hint: "Choose an application type and configure your project." },
  workspace: { label: "Workspace ready", hint: "Open the repository in a Code Workspace to edit and preview." },
  checks: { label: "Checks running", hint: "Build and lint checks are running for the selected release." },
  deployed: { label: "Deployed", hint: "The application is hosted and ready to share." },
};
