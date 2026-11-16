export type ObjType = {
  id: string; name: string; plural: string; group: string; color: string;
  count: number; status: "Healthy" | "Degraded" | "Attention";
  desc: string; x: number; y: number;
  props: { name: string; type: string; value: string }[];
  pipeline: string; dataset: string; freshness: string;
  instances: { id: string; title: string; status: string; detail: string }[];
};

export const OBJECT_TYPES: ObjType[] = [
  { id:"outage", name:"Power Outage", plural:"Power Outages", group:"Operations", color:"#8b5cf6", count:1284, status:"Attention", desc:"Active and historical outage events detected from SCADA, AMI and customer reports.", x:400,y:250,
    props:[{name:"outage_id",type:"String",value:"OUT-8841"},{name:"cause",type:"String",value:"Vegetation / feeder fault"},{name:"customers_affected",type:"Integer",value:"342"},{name:"started_at",type:"Timestamp",value:"2026-10-20 08:14"},{name:"feeder",type:"Link · Feeder",value:"FDR-12 Bandung Timur"}],
    pipeline:"outage-detection-pipeline", dataset:"scada_outage_events", freshness:"2 min ago",
    instances:[{id:"OUT-8841",title:"Feeder FDR-12 outage — Bandung Timur",status:"Active",detail:"342 customers · 1h 06m"},{id:"OUT-8837",title:"Planned maintenance — Cimahi",status:"Scheduled",detail:"58 customers · tomorrow 09:00"},{id:"OUT-8829",title:"Momentary interruption — Arcamanik",status:"Restored",detail:"Restored in 14 min"}]},
  { id:"feeder", name:"Feeder", plural:"Feeders", group:"Grid Assets", color:"#3d8bfd", count:486, status:"Healthy", desc:"Distribution feeders with loading, topology and switching state.", x:560,y:150,
    props:[{name:"feeder_id",type:"String",value:"FDR-12"},{name:"voltage_kv",type:"Double",value:"20 kV"},{name:"loading_pct",type:"Double",value:"81.4%"},{name:"substation",type:"Link · Substation",value:"GI Cigereleng"}],
    pipeline:"grid-topology-pipeline", dataset:"ams_feeder_master", freshness:"6 min ago",
    instances:[{id:"FDR-12",title:"FDR-12 · Bandung Timur",status:"Loaded 81%",detail:"20 kV · 14.2 km"},{id:"FDR-09",title:"FDR-09 · Cimahi Utara",status:"Normal",detail:"20 kV · 11.8 km"}]},
  { id:"substation", name:"Substation", plural:"Substations", group:"Grid Assets", color:"#3d8bfd", count:92, status:"Healthy", desc:"Transmission and distribution substations (gardu induk).", x:650,y:270,
    props:[{name:"substation_id",type:"String",value:"GI-CLG"},{name:"name",type:"String",value:"GI Cigereleng"},{name:"capacity_mva",type:"Double",value:"120 MVA"}],
    pipeline:"grid-topology-pipeline", dataset:"ams_substation_master", freshness:"6 min ago",
    instances:[{id:"GI-CLG",title:"GI Cigereleng",status:"Normal",detail:"120 MVA · 6 feeders"},{id:"GI-CMH",title:"GI Cimahi",status:"Normal",detail:"90 MVA · 4 feeders"}]},
  { id:"workorder", name:"Work Order", plural:"Work Orders", group:"Operations", color:"#34c38f", count:3210, status:"Healthy", desc:"Field work dispatched to crews, linked to outages and assets.", x:250,y:140,
    props:[{name:"work_order_id",type:"String",value:"WO-55210"},{name:"priority",type:"String",value:"P1"},{name:"status",type:"String",value:"Dispatched"},{name:"crew",type:"Link · Crew",value:"Crew Alpha-3"}],
    pipeline:"work-orders-sync", dataset:"maximo_work_orders", freshness:"4 min ago",
    instances:[{id:"WO-55210",title:"Inspect FDR-12 span 44–51",status:"Dispatched",detail:"Crew Alpha-3 · ETA 25 min"},{id:"WO-55198",title:"Replace cut-out — pole P-881",status:"In progress",detail:"Crew Bravo-1"}]},
  { id:"crew", name:"Field Crew", plural:"Field Crews", group:"Operations", color:"#34c38f", count:148, status:"Healthy", desc:"Field crews with skills, location and current assignment.", x:130,y:250,
    props:[{name:"crew_id",type:"String",value:"CRW-A3"},{name:"name",type:"String",value:"Crew Alpha-3"},{name:"skill",type:"String",value:"OH line · drone certified"},{name:"status",type:"String",value:"En route"}],
    pipeline:"crew-roster-sync", dataset:"hr_crew_roster", freshness:"18 min ago",
    instances:[{id:"CRW-A3",title:"Crew Alpha-3",status:"En route",detail:"Drone certified · 4 members"},{id:"CRW-B1",title:"Crew Bravo-1",status:"On site",detail:"Pole P-881"}]},
  { id:"drone", name:"Drone Inspection", plural:"Drone Inspections", group:"Inspections", color:"#e2b866", count:864, status:"Degraded", desc:"Drone flights and imagery inspections over lines and assets.", x:250,y:370,
    props:[{name:"inspection_id",type:"String",value:"INS-3092"},{name:"media_set",type:"Media",value:"drone-footage/fdr12"},{name:"defects_found",type:"Integer",value:"3"},{name:"flown_at",type:"Timestamp",value:"2026-10-20 07:40"}],
    pipeline:"drone-media-pipeline", dataset:"media_drone_inspections", freshness:"22 min ago",
    instances:[{id:"INS-3092",title:"FDR-12 corridor flight",status:"3 defects",detail:"Vegetation encroachment · span 47"},{id:"INS-3088",title:"GI Cigereleng yard scan",status:"Clear",detail:"No defects"}]},
  { id:"asset", name:"Grid Asset", plural:"Grid Assets", group:"Grid Assets", color:"#3d8bfd", count:18420, status:"Healthy", desc:"Poles, transformers, switches and conductors under management.", x:540,y:380,
    props:[{name:"asset_id",type:"String",value:"TRF-2210"},{name:"type",type:"String",value:"Distribution transformer"},{name:"health",type:"Double",value:"0.87"},{name:"installed",type:"Date",value:"2019-04-11"}],
    pipeline:"ams-asset-pipeline", dataset:"ams_assets", freshness:"31 min ago",
    instances:[{id:"TRF-2210",title:"Transformer TRF-2210",status:"Health 0.87",detail:"160 kVA · FDR-12"},{id:"P-881",title:"Pole P-881",status:"Cut-out failed",detail:"Span 47 · FDR-12"}]},
  { id:"customer", name:"Customer", plural:"Customers", group:"Customers", color:"#8391a7", count:94210, status:"Healthy", desc:"Service points affected by outages and planned work.", x:400,y:90,
    props:[{name:"customer_id",type:"String",value:"CUST-77120"},{name:"tariff",type:"String",value:"R-1/TR 1300 VA"},{name:"feeder",type:"Link · Feeder",value:"FDR-12"}],
    pipeline:"billing-customer-sync", dataset:"billing_customers", freshness:"1 h ago",
    instances:[{id:"CUST-77120",title:"Service point 77120 — Arcamanik",status:"Affected",detail:"Outage OUT-8841"}]},
  { id:"alert", name:"Operational Alert", plural:"Alerts", group:"Operations", color:"#f0616d", count:237, status:"Attention", desc:"Alerts raised by Foundry Rules and AIP Logic over live objects.", x:130,y:110,
    props:[{name:"alert_id",type:"String",value:"ALR-991"},{name:"rule",type:"String",value:"Feeder loading > 80%"},{name:"severity",type:"String",value:"High"}],
    pipeline:"rules-evaluation", dataset:"alerts_operational", freshness:"1 min ago",
    instances:[{id:"ALR-991",title:"FDR-12 loading above 80%",status:"High",detail:"Sustained 22 min"}]},
  { id:"incident", name:"Incident Report", plural:"Incident Reports", group:"Inspections", color:"#e2b866", count:512, status:"Healthy", desc:"Structured findings from inspections, ready for work-plan generation.", x:400,y:410,
    props:[{name:"report_id",type:"String",value:"RPT-118"},{name:"finding",type:"String",value:"Vegetation encroachment"},{name:"confidence",type:"Double",value:"0.93"}],
    pipeline:"drone-media-pipeline", dataset:"inspection_reports", freshness:"22 min ago",
    instances:[{id:"RPT-118",title:"Vegetation at span 47 — FDR-12",status:"Confidence 0.93",detail:"Linked to INS-3092"}]},
  { id:"txline", name:"Transmission Line", plural:"Transmission Lines", group:"Grid Assets", color:"#e2b866", count:312, status:"Healthy", desc:"[Power Grid] 150 kV transmission lines with risk score per span — the COP / Work Planning layer.", x:610,y:90,
    props:[{name:"line_id",type:"String",value:"SUTT-150-CGR"},{name:"voltage_kv",type:"Double",value:"150 kV"},{name:"risk_score",type:"Double",value:"2.04 / 10"},{name:"from_substation",type:"Link · Substation",value:"GI Cigereleng"}],
    pipeline:"grid-topology-pipeline", dataset:"ams_transmission_lines", freshness:"6 min ago",
    instances:[{id:"SUTT-150-CGR",title:"SUTT 150 kV Cigereleng-Padalarang",status:"Risk 2.04",detail:"38 towers · 21 km"}]},
  { id:"material", name:"Material Order", plural:"Material Orders", group:"Operations", color:"#8391a7", count:740, status:"Healthy", desc:"[Power Grid] Material orders and availability for repairs (cut-outs, conductors, fuses).", x:90,y:370,
    props:[{name:"order_id",type:"String",value:"MO-8812"},{name:"material",type:"String",value:"Cut-out 100A"},{name:"qty_available",type:"Integer",value:"14"}],
    pipeline:"work-orders-sync", dataset:"erp_material_orders", freshness:"12 min ago",
    instances:[{id:"MO-8812",title:"Cut-out 100A — Gudang Cigereleng",status:"14 available",detail:"Reserved for WO-55210"}]},
  { id:"vendor", name:"Vendor", plural:"Vendors", group:"Operations", color:"#8391a7", count:64, status:"Healthy", desc:"[Power Grid] Vendors and contractors supporting grid work.", x:90,y:160,
    props:[{name:"vendor_id",type:"String",value:"VND-07"},{name:"name",type:"String",value:"PT Gardu Teknik Nusantara"},{name:"sla_pct",type:"Double",value:"98.1%"}],
    pipeline:"vendor-sync", dataset:"erp_vendors", freshness:"1 h ago",
    instances:[{id:"VND-07",title:"PT Gardu Teknik Nusantara",status:"SLA 98.1%",detail:"Vegetation + line crews"}]},
  { id:"vegrisk", name:"Vegetation Risk Area", plural:"Vegetation Risk Areas", group:"Inspections", color:"#34c38f", count:129, status:"Degraded", desc:"[Power Grid] Vegetation / wildfire risk per area (Terrain Clearance in the reference), scored from drone + satellite pixels.", x:320,y:455,
    props:[{name:"area_id",type:"String",value:"VEG-BDG-12"},{name:"risk",type:"String",value:"High"},{name:"clearance_m",type:"Double",value:"1.8 m"}],
    pipeline:"drone-media-pipeline", dataset:"veg_risk_areas", freshness:"22 min ago",
    instances:[{id:"VEG-BDG-12",title:"Span 44-51 FDR-12 corridor",status:"High risk",detail:"Clearance 1.8 m"}]},
];

export const EDGES: [string,string,string][] = [
  ["outage","feeder","on feeder"],["outage","workorder","dispatches"],["outage","customer","affects"],
  ["feeder","substation","fed from"],["feeder","asset","contains"],["workorder","crew","assigned to"],
  ["drone","asset","inspects"],["drone","incident","produces"],["incident","workorder","creates"],
  ["alert","feeder","monitors"],["alert","outage","escalates to"],["drone","outage","investigates"],
];


export const AGENTS = [
  { id:"ops", name:"Operations Copilot", desc:"Investigates outages, retrieves linked objects and drafts work plans.", model:"AIP · ops-copilot", online:true },
  { id:"grid", name:"Grid Reliability Agent", desc:"N-1, loading and SAIDI/SAIFI analysis over feeders and substations.", model:"AIP · grid-reliability", online:true },
  { id:"field", name:"Field Dispatch Agent", desc:"Matches crews to work orders by skill, distance and availability.", model:"AIP · field-dispatch", online:false },
];
export const ACTIONS = [
  { name:"Create Work Order", on:"Power Outage", href:"/ontology" },
  { name:"Dispatch Crew", on:"Work Order", href:"/ontology" },
  { name:"Notify Affected Customers", on:"Power Outage", href:"/automate" },
  { name:"Escalate Alert", on:"Operational Alert", href:"/foundry-rules" },
  { name:"Close Outage", on:"Power Outage", href:"/ontology" },
];
export const LOGICS = [
  { name:"Outage Root-Cause Analysis", runs:184, href:"/logic" },
  { name:"Drone Defect Triage", runs:96, href:"/logic" },
  { name:"Crew Assignment Recommender", runs:231, href:"/logic" },
  { name:"Customer Impact Summary", runs:412, href:"/logic" },
];
export const FUNCTIONS = [
  { name:"estimateRestorationTime()", ver:"v12", href:"/functions" },
  { name:"customersAffectedByOutage()", ver:"v8", href:"/functions" },
  { name:"nearestAvailableCrew()", ver:"v5", href:"/functions" },
];
export const FILES = [
  { name:"outage-detection-pipeline", kind:"Pipeline", href:"/pipeline" },
  { name:"drone-media-pipeline", kind:"Pipeline", href:"/pipeline" },
  { name:"scada_outage_events", kind:"Dataset", href:"/datasets" },
  { name:"drone-footage/fdr12", kind:"Media set", href:"/media-sets" },
  { name:"GRID Cockpit (PLN Grid Monitoring Cockpit)", kind:"Workshop app", href:"/pln-cockpit" },
];
export const SUGGESTIONS = [
  "Investigate outage OUT-8841 and create a work plan",
  "Use drone footage to resolve power outages on FDR-12",
  "Which customers are affected and who should I notify?",
  "Find the nearest available crew for WO-55210",
];
export const byId = (id:string)=>OBJECT_TYPES.find(o=>o.id===id)!;
export const neighbors = (id:string)=>{
  const s=new Set<string>(); EDGES.forEach(([a,b])=>{ if(a===id)s.add(b); if(b===id)s.add(a); }); return s;
};
