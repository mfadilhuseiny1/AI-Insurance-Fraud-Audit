export type PKind = "dataset" | "join" | "union" | "transform" | "metadata" | "function" | "output";
export type PNode = { id: string; label: string; kind: PKind; group: string; color: string; x: number; y: number; cols: number; desc: string; proposed?: boolean };
export type PEdge = { from: string; to: string };
export const KIND_LABEL: Record<PKind, string> = { dataset: "Dataset", join: "Join", union: "Union", transform: "Transform", metadata: "Metadata", function: "Function", output: "Object output" };
export const INITIAL_NODES: PNode[] = [
  { id: "vA", label: "Video Source A", kind: "dataset", group: "Aerial Photography", color: "#7c6bb0", x: 20, y: 30, cols: 6, desc: "Drone video ingest A" },
  { id: "vB", label: "Video Source B", kind: "dataset", group: "Aerial Photography", color: "#7c6bb0", x: 20, y: 110, cols: 6, desc: "Drone video ingest B" },
  { id: "meta", label: "Metadata", kind: "metadata", group: "Aerial Photography", color: "#7c6bb0", x: 20, y: 200, cols: 3, desc: "Flight metadata" },
  { id: "union1", label: "Union by name", kind: "union", group: "Aerial Photography", color: "#ffffff", x: 210, y: 70, cols: 8, desc: "Union by name · 8 columns" },
  { id: "join1", label: "Left join", kind: "join", group: "Aerial Photography", color: "#ffffff", x: 400, y: 60, cols: 9, desc: "Left dataset / Right dataset" },
  { id: "qual", label: "Quality", kind: "dataset", group: "Aerial Photography", color: "#7c6bb0", x: 390, y: 190, cols: 2, desc: "Image quality scores" },
  { id: "join2", label: "Left join", kind: "join", group: "Aerial Photography", color: "#ffffff", x: 590, y: 130, cols: 11, desc: "Left dataset / Right dataset" },
  { id: "thumb", label: "Thumbnails", kind: "metadata", group: "Aerial Photography", color: "#7c6bb0", x: 580, y: 250, cols: 3, desc: "Generated thumbnails" },
  { id: "tpath", label: "Transform path", kind: "transform", group: "Aerial Photography", color: "#ffffff", x: 790, y: 140, cols: 12, desc: "AI-generated transform path" },
  { id: "aerial", label: "Aerial Photography", kind: "output", group: "Aerial Photography", color: "#7c6bb0", x: 985, y: 140, cols: 12, desc: "Object output · Deployed" },
  { id: "outBack", label: "Outages Backfill", kind: "dataset", group: "Power Outage", color: "#a31621", x: 20, y: 330, cols: 14, desc: "Historical outages" },
  { id: "outages", label: "Outages", kind: "dataset", group: "Power Outage", color: "#a31621", x: 20, y: 405, cols: 14, desc: "Live outage feed" },
  { id: "preUnion", label: "Pre Union transform", kind: "transform", group: "Power Outage", color: "#a31621", x: 210, y: 330, cols: 14, desc: "Normalize schema" },
  { id: "union2", label: "Union", kind: "union", group: "Power Outage", color: "#a31621", x: 400, y: 365, cols: 14, desc: "Union outages" },
  { id: "trans1", label: "Transform", kind: "transform", group: "Power Outage", color: "#a31621", x: 590, y: 365, cols: 14, desc: "Clean + enrich" },
  { id: "notif", label: "Notifications", kind: "join", group: "Power Outage", color: "#ffffff", x: 780, y: 365, cols: 17, desc: "Left dataset / Right dataset" },
  { id: "trans2", label: "Transform", kind: "transform", group: "Power Outage", color: "#a31621", x: 960, y: 365, cols: 14, desc: "Final shaping" },
  { id: "pOutage", label: "Power Outage", kind: "output", group: "Power Outage", color: "#a31621", x: 1120, y: 365, cols: 14, desc: "Object output · Deployed" },
  { id: "notifRaw", label: "notification_raw", kind: "dataset", group: "Customer Notification", color: "#c94f9e", x: 210, y: 500, cols: 6, desc: "Raw notifications" },
  { id: "union3", label: "Union", kind: "union", group: "Customer Notification", color: "#c94f9e", x: 400, y: 500, cols: 6, desc: "Union notifications" },
  { id: "notifClean", label: "Notifications clean", kind: "transform", group: "Customer Notification", color: "#c94f9e", x: 590, y: 500, cols: 6, desc: "Deduplicate + clean" },
  { id: "custNotif", label: "Customer Notification", kind: "output", group: "Customer Notification", color: "#c94f9e", x: 790, y: 500, cols: 7, desc: "Object output · Deployed" },
  { id: "weather", label: "Weather", kind: "dataset", group: "Weather", color: "#5b84ae", x: 210, y: 590, cols: 4, desc: "Weather observations" },
  { id: "wComplete", label: "Weather Complete", kind: "join", group: "Weather", color: "#ffffff", x: 400, y: 590, cols: 4, desc: "Join forecast + observed" },
  { id: "wOut", label: "Weather", kind: "output", group: "Weather", color: "#5b84ae", x: 590, y: 590, cols: 4, desc: "Object output · Deployed" },
  { id: "repair", label: "Repair", kind: "dataset", group: "Line Repair", color: "#c78f1b", x: 210, y: 665, cols: 4, desc: "Repair records" },
  { id: "repairT", label: "Transform", kind: "transform", group: "Line Repair", color: "#c78f1b", x: 400, y: 665, cols: 4, desc: "Shape repairs" },
  { id: "lineRepair", label: "Line Repair", kind: "output", group: "Line Repair", color: "#c78f1b", x: 590, y: 665, cols: 4, desc: "Object output · Deployed" },
];
export const INITIAL_EDGES: PEdge[] = [
  { from: "vA", to: "union1" }, { from: "vB", to: "union1" }, { from: "meta", to: "join1" }, { from: "union1", to: "join1" },
  { from: "join1", to: "join2" }, { from: "qual", to: "join2" }, { from: "join2", to: "tpath" }, { from: "thumb", to: "tpath" }, { from: "tpath", to: "aerial" },
  { from: "outBack", to: "preUnion" }, { from: "preUnion", to: "union2" }, { from: "outages", to: "union2" }, { from: "union2", to: "trans1" },
  { from: "trans1", to: "notif" }, { from: "notif", to: "trans2" }, { from: "trans2", to: "pOutage" },
  { from: "notifRaw", to: "union3" }, { from: "union3", to: "notifClean" }, { from: "notifClean", to: "custNotif" },
  { from: "weather", to: "wComplete" }, { from: "wComplete", to: "wOut" }, { from: "repair", to: "repairT" }, { from: "repairT", to: "lineRepair" },
];
export const AI_NODES: PNode[] = [
  { id: "aiJoin", label: "Left join · drone ↔ outage", kind: "join", group: "Aerial Photography", color: "#ffffff", x: 790, y: 30, cols: 13, desc: "AI-generated · join on feeder + timestamp", proposed: true },
  { id: "aiDefect", label: "Detect defects (AI)", kind: "function", group: "Aerial Photography", color: "#8b5cf6", x: 985, y: 30, cols: 5, desc: "Custom function · droneDefectTriage()", proposed: true },
];
export const LEGEND = [
  { group: "Power Outage", color: "#a31621", count: 11 }, { group: "Customer Notification", color: "#c94f9e", count: 11 },
  { group: "Weather", color: "#5b84ae", count: 5 }, { group: "Line Repair", color: "#c78f1b", count: 4 },
  { group: "Aerial Photography", color: "#7c6bb0", count: 8 }, { group: "Terrain Clearance", color: "#1f7a4d", count: 6 },
];
export const HISTORY = [
  { v: "v42", what: "Deployed proposal “Add Drone Footage” to main", who: "s.rahman", at: "Today 09:12", state: "Deployed" },
  { v: "v41", what: "Added Weather Complete join", who: "a.pratama", at: "Yesterday 16:40", state: "Deployed" },
  { v: "v40", what: "Proposal “Customer notification dedupe” rejected in review", who: "m.lee", at: "Yesterday 11:03", state: "Rejected" },
  { v: "v39", what: "Backfill Outages Backfill (14 columns)", who: "system", at: "Mon 08:00", state: "Succeeded" },
];
