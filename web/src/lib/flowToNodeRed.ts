/**
 * A built-in device-stream flow (lib/flow.ts) as a Node-RED flow, for moving a Device stream to real Node-RED.
 * Node-RED's own nodes (inject, debug, function, switch, change, range, rbe, delay, json, http request, mqtt) map to
 * its core nodes; the device and platform nodes to the BluesandAI nodes (api/nodered-nodes); OPC-UA, Kafka and Modbus
 * need a palette plugin, so they become comments that say which one (a flow with a missing node type does not start).
 */
import type { Flow, FlowNode } from "./flow";

export type NodeRedNode = { id: string; type: string; z?: string; [prop: string]: unknown };

const BLUESANDAI = new Set(["sensor", "camera", "telemetry", "alarm", "smooth", "window", "alert", "dataset out"]);
const PLUGINS: Record<string, string> = {
  "opcua in": "node-red-contrib-opcua (OpcUa-Client)",
  "opcua out": "node-red-contrib-opcua (OpcUa-Client)",
  "kafka in": "node-red-contrib-kafkajs or node-red-contrib-kafka-manager",
  "kafka out": "node-red-contrib-kafkajs or node-red-contrib-kafka-manager",
  "modbus read": "node-red-contrib-modbus (Modbus-Read)",
};

const rid = () => Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);

export function toNodeRed(flow: Flow, label: string, info = ""): { nodes: NodeRedNode[]; notes: string[] } {
  const tab = rid();
  const out: NodeRedNode[] = [{ id: tab, type: "tab", label, disabled: false, info }];
  const notes: string[] = [];
  const brokers = new Map<string, string>();
  const broker = (n: FlowNode) => {
    const url = String(n.broker || "");
    const key = `${url}|${n.username ?? ""}`;
    if (!brokers.has(key)) {
      const id = rid();
      brokers.set(key, id);
      out.push({
        id,
        type: "mqtt-broker",
        name: url.replace(/^\w+:\/\//, ""),
        // a URL broker (mqtt://, mqtts://, ws://, wss://) carries its own port and transport
        broker: url,
        port: "",
        usetls: /^(wss|mqtts):/.test(url),
        protocolVersion: "4",
        keepalive: "60",
        cleansession: true,
        autoConnect: true,
        ...(n.username ? { credentials: { user: String(n.username), password: String(n.password ?? "") } } : {}),
      });
    }
    return brokers.get(key)!;
  };

  for (const n of flow.nodes) {
    const { id, type, name, x, y, wires, d, ...props } = n;
    const base = { id, z: tab, name: name ?? "", x, y, wires: wires ?? [], ...(d ? { d: true } : {}) };
    if (BLUESANDAI.has(type)) {
      if (type === "camera" && props.source !== "url") {
        notes.push(`${name || "camera"}: a ${props.source === "rtsp" ? "RTSP stream" : "browser webcam"} cannot run on the server — set a snapshot URL`);
      }
      out.push({ ...base, ...props, type: `bluesandai ${type}`, wires: type === "dataset out" ? [] : type === "alert" ? [[]] : base.wires });
      continue;
    }
    if (PLUGINS[type]) {
      notes.push(`${name || type}: install ${PLUGINS[type]} from Manage palette and replace the comment`);
      out.push({ id, z: tab, x, y, type: "comment", name: `${type} → install ${PLUGINS[type]}`, info: JSON.stringify(props, null, 2), wires: [] });
      continue;
    }
    switch (type) {
      case "inject":
        out.push({
          ...base,
          type,
          props: [{ p: "payload" }, { p: "topic", vt: "str" }],
          payload: props.payload ?? "",
          payloadType: props.payloadType ?? "date",
          topic: props.topic ?? "",
          repeat: props.repeat ? String(props.repeat) : "",
          crontab: "",
          once: !!props.once,
          onceDelay: 0.1,
        });
        break;
      case "debug":
        out.push({ ...base, type, active: props.active !== false, tosidebar: true, console: false, tostatus: false, complete: String(props.complete ?? "payload"), targetType: props.complete === "true" ? "full" : "msg", wires: [] });
        break;
      case "rbe":
        out.push({ ...base, type, func: props.func ?? "rbe", gap: String(props.gap ?? ""), start: "", inout: "out", septopics: props.perTopic !== false, property: props.property ?? "payload", topi: "topic" });
        break;
      case "mqtt in":
        out.push({ ...base, type, topic: props.topic ?? "#", qos: String(props.qos ?? "0"), datatype: props.datatype ?? "auto", broker: broker(n), nl: false, rap: true, rh: 0, inputs: 0 });
        break;
      case "mqtt out":
        out.push({ ...base, type, topic: props.topic ?? "", qos: String(props.qos ?? "0"), retain: props.retain ? "true" : "", broker: broker(n), wires: [] });
        break;
      case "delay":
        out.push({ ...base, type, nbRateUnits: "1", ...props });
        break;
      default:
        // comment, function, change, switch, range, json, http request, and types imported from Node-RED: stored the way Node-RED stores them
        out.push({ ...base, ...props, type });
    }
  }
  // Node-RED draws nodes (comments especially) wider than the built-in editor: shift right so none starts off the canvas
  const half = (n: NodeRedNode) => Math.min(400, (String(n.name || n.type).length * 7 + 50) / 2);
  const placed = out.filter((n) => typeof n.x === "number");
  const shift = Math.max(0, ...placed.map((n) => half(n) + 20 - (n.x as number)));
  if (shift) placed.forEach((n) => (n.x = (n.x as number) + Math.ceil(shift)));
  return { nodes: out, notes };
}
