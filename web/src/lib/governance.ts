/** Governance Center (api/governance_center.py) and the JKN demo's governance layer (api/demo_jkn_governance.py). */
import { API_URL } from "./api";

export type MarkingRef = { id: string; name: string; color: string };
export type Posture = { key: string; label: string; ok: boolean; detail: string; todo: string; link: string };

export type GovernanceOverview = {
  project: { id: string; name: string };
  datasets: number;
  posture: Posture[];
  discover: {
    scans: { id: string; name: string; schedule: string; active: boolean; scanned: number; matched: number; last_run?: string; status?: string; conditions: string[]; actions: { name: string; kind: string }[] }[];
    findings: { id: string; name: string; conditions: { name: string; columns: string[]; count: number }[] }[];
  };
  classify: {
    markings: { id: string; name: string; color: string; description: string; members: number; direct: { id: string; name: string }[]; inherited: { id: string; name: string }[]; total: number }[];
    marked_items: number;
    items: number;
  };
  protect: {
    channels: { id: string; name: string; algorithm: string; description: string; item_id: string; licenses: number }[];
    licenses: { id: string; rid: string; name: string; kind: string; operations: string[]; channel: string | null; rate_limit?: { count: number; minutes: number } | null; bypass_checkpoints?: boolean; expires_at?: string | null }[];
  };
  restrict: {
    object_types: { id: string; name: string; objects?: number; object_policy: boolean; object_markings: MarkingRef[]; row_level: boolean; property_policies: { name: string; properties: string[]; markings: MarkingRef[] }[] }[];
  };
  justify: {
    configs: { id: string; name: string; enabled: boolean; scope: string; types: string[]; justification: string; title: string; options: string[] }[];
    records_30d: number;
    recent: { at: string; user: string; type: string; justification: string }[];
  };
  retain: { policies: { id: string; name: string; type: string; deletion_date?: string | null; description: string; datasets: string[] }[] };
  account: { days: number; events: number; by_category: Record<string, number>; latest: { time: string; name: string; product: string; categories: string[]; user: string; result: string }[] };
  approvals: { pending: { id: string; title: string; status: string; created_at: string }[] };
};

export type AccessRow = {
  label: string;
  why: string;
  kind: "dataset" | "property" | "cipher";
  item_id?: string | null;
  type_id?: string;
  properties?: string[];
  needs: string[];
  access: Record<string, boolean>;
  checkpoint?: boolean;
};
export type DemoGovernance = GovernanceOverview & {
  ready: boolean;
  demo: { items: { raw?: string; pseudo?: string; scan?: string; repo?: string; folder?: string }; markings?: { phi: string; inv: string }; cipher?: { aes: string; sha: string; op_license: string }; transform?: string };
  matrix: { personas: { id: string; name: string; role: string; markings: string[] }[]; rows: AccessRow[] } | null;
  sample: { no_sep: string; pseudonim: string; nik_hash: string; kelompok_umur: string; kabupaten: string; asli: { nama: string; no_kartu: string; nik: string } | null }[] | null;
};

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { credentials: "include", cache: "no-store" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({ detail: r.statusText }))).detail ?? r.statusText);
  return r.json();
}

export const governance = {
  projects: () => get<{ id: string; name: string }[]>("/api/governance-center/projects"),
  project: (id: string) => get<GovernanceOverview>(`/api/governance-center/projects/${encodeURIComponent(id)}`),
  demo: () => get<DemoGovernance>("/api/demo/jkn/governance"),
  akses: () => get<DemoAkses>("/api/demo/jkn/akses"),
};

/** Demo JKN "Akses per akun" (api/demo_jkn_akses.py): each demo account against the demo's data, as Data Lineage
 * colours it when viewed as that account. */
export type DemoAkses = {
  built_at?: string;
  resources: { id: string; name: string; kind: string }[];
  accounts: { username: string; user_id: string; name: string; role: string; access: Record<string, { status: string; detail: string }> }[];
  governance?: { request_form?: string[]; request?: string; protected_view?: string; checkpoint?: string; space?: string; product?: string };
  portal_id?: string;
  pipeline_id?: string;
  portal_module?: string;
  graph: string;
  lineage: string;
  password: string;
};
