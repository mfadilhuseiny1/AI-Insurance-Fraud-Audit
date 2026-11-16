import type { IconName } from "@/components/Icon";

// AIP JKN's tab bar, one list for /aip-jkn and the /swarm-x demo (the user, 2026-11-16: "di swarm-x gaada tab2 ini": its copy of the
// bar had fallen behind). Its history, from /aip-jkn:
// Mission Control and the Map left the bar, and the rules of the indications moved into Box Karantina (the user,
// 2026-10-28: "hapus tab yang ga berguna … atau di merge"); an old ?tab=aturan link opens them there
// Pipeline Produksi left the bar (the user, 2026-10-28: "tab ini hapus aja"); its pipeline and POST /verify run on
// behind the API
// Realtime Fraud (2026-11-09, the user: "realtime fraud detection system ... integrated to audit system", after Quantexa)
// System Architecture (2026-11-12, the user: the ML architecture in use, the AI Agent Swarm config, and the rule editor)
// API Documentation (2026-11-13, the user: "bikin tab baru namanya API Documentation", visual, from the API's own OpenAPI spec)
export type TabAip = "agents" | "ml" | "arsitektur" | "apidocs" | "konsultan" | "cabang" | "realtime" | "karantina" | "kontrol" | "akses" | "sensor" | "objects" | "lineage" | "pipeline";
export const TABS_AIP: [TabAip, string, IconName][] = [["konsultan", "AI Agent Swarm", "graph"], ["cabang", "AI Agent Swarm Branch", "constellation"], ["realtime", "Realtime Fraud", "bolt"], ["agents", "Agen", "sparkle"],
  ["ml", "ML Studio", "cpu"], ["arsitektur", "System Architecture", "layers"], ["apidocs", "API Documentation", "code"], ["karantina", "Box Karantina", "lock"], ["kontrol", "Evaluasi Swarm", "sliders"],
  ["akses", "Keamanan & Akses", "eye"], ["sensor", "IoT · IoMT · Blockchain", "device"], ["objects", "Nexus · Object Explorer", "cube"],
  ["lineage", "Data Lineage", "split"], ["pipeline", "Pipeline Builder", "pipeline"]];
