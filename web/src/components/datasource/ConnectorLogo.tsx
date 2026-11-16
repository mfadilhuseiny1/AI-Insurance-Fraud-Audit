/** A connector's badge: a monogram in the database's brand colour (no third-party logo files). */
const BADGES: Record<string, { text: string; bg: string; fg?: string }> = {
  postgresql: { text: "Pg", bg: "#336791" },
  mysql: { text: "My", bg: "#00758f" },
  mariadb: { text: "Ma", bg: "#c0765a" },
  sqlserver: { text: "SS", bg: "#cc2927" },
  oracle: { text: "Or", bg: "#c74634" },
  bigquery: { text: "BQ", bg: "#4285f4" },
  snowflake: { text: "Sf", bg: "#29b5e8" },
  databricks: { text: "Db", bg: "#ff3621" },
  redshift: { text: "Rs", bg: "#8c4fff" },
  influxdb: { text: "In", bg: "#22adf6" },
  timescaledb: { text: "Ts", bg: "#fdb515", fg: "#1b1b1b" },
  clickhouse: { text: "CH", bg: "#faff69", fg: "#1b1b1b" },
  mongodb: { text: "Mg", bg: "#47a248" },
  alloydb: { text: "Al", bg: "#4285f4" },
  "azure-synapse": { text: "Sy", bg: "#0078d4" },
  "amazon-s3": { text: "S3", bg: "#3f8624" },
  filesystem: { text: "FS", bg: "#64748b" },
  "amazon-dynamodb": { text: "Dy", bg: "#4053d6" },
  "apache-couchdb": { text: "Co", bg: "#e42528" },
  airtable: { text: "At", bg: "#fcb400", fg: "#1b1b1b" },
  salesforce: { text: "Sf", bg: "#00a1e0" },
  hubspot: { text: "Hs", bg: "#ff7a59" },
  "apache-hive": { text: "Hv", bg: "#fdee21", fg: "#1b1b1b" },
  "apache-phoenix": { text: "Ph", bg: "#f15a24" },
  "apache-hbase": { text: "HB", bg: "#be160c" },
  "azure-cosmos-db": { text: "Cs", bg: "#0078d4" },
  "azure-table-storage": { text: "AT", bg: "#0078d4" },
  "azure-active-directory": { text: "AD", bg: "#0078d4" },
  "azure-data-catalog": { text: "DC", bg: "#0078d4" },
  "azure-devops": { text: "DO", bg: "#0078d4" },
  "act-crm": { text: "Ac", bg: "#d6232b" },
  "act-on": { text: "AO", bg: "#ef7d22" },
  activecampaign: { text: "AC", bg: "#356ae6" },
  "adobe-analytics": { text: "Aa", bg: "#eb1000" },
  "adobe-commerce": { text: "Am", bg: "#eb1000" },
  asana: { text: "As", bg: "#f06a6a" },
  basecamp: { text: "Bc", bg: "#1d2d35" },
  bigcommerce: { text: "BC", bg: "#121118" },
  "blackbaud-raisers-edge-nxt": { text: "RE", bg: "#00a4e3" },
  bugzilla: { text: "Bz", bg: "#5d6d7e" },
  acumatica: { text: "Ac", bg: "#1b70b7" },
  adp: { text: "AP", bg: "#d0271d" },
  "authorize-net": { text: "AN", bg: "#1c3141" },
  avalara: { text: "Av", bg: "#fc6600" },
  "netsuite-suiteanalytics": { text: "NS", bg: "#125580" },
  "netsuite-suiteql": { text: "NQ", bg: "#125580" },
  "netsuite-suitetalk": { text: "NT", bg: "#125580" },
};

const SAP = { text: "SAP", bg: "#0a6ed1" };

export function ConnectorLogo({ kind, size = "md" }: { kind: string; size?: "sm" | "md" | "lg" }) {
  const b = BADGES[kind] ?? (kind.startsWith("sap-") ? SAP : { text: kind.slice(0, 2), bg: "#475569" });
  const box = size === "sm" ? "h-6 w-6 text-[10px]" : size === "lg" ? "h-10 w-10 text-sm" : "h-8 w-8 text-xs";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-bold tracking-tight shadow-sm ${box}`}
      style={{ background: b.bg, color: b.fg ?? "#fff" }}
      aria-hidden
    >
      {b.text}
    </span>
  );
}

export const GROUP_LABEL: Record<string, string> = {
  sql: "SQL",
  warehouse: "Data Warehouse",
  timeseries: "Time Series",
  nosql: "NoSQL",
  storage: "Files & Object Storage",
  apps: "Business Applications",
  erp: "ERP & Finance",
  sap: "SAP",
};

export const FREQUENCY_LABEL: Record<string, string> = {
  manual: "Manual",
  "15m": "Every 15 minutes",
  hourly: "Every hour",
  "6h": "Every 6 hours",
  daily: "Every day",
};

export const approx = (n: number | null | undefined) => {
  if (n === null || n === undefined) return "unknown";
  if (n < 10_000) return n.toLocaleString();
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [v, u] of units) if (n >= v) return `~${(n / v).toFixed(n >= v * 100 ? 0 : 2).replace(/\.?0+$/, "")}${u}`;
  return n.toLocaleString();
};
