/**
 * Device stream pipelines: Node-RED style flows for IoT devices — sensors, cameras, PLCs — wired from
 * protocol inputs (MQTT, OPC-UA, Kafka, Modbus) through functions to outputs. Nodes are stored the way
 * Node-RED stores them ({ id, type, name, x, y, wires, …props }, x / y the node's centre, props named
 * as in Node-RED) so flows exported from Node-RED import here for the node types both have.
 */
import type { IconName } from "@/components/Icon";

export type FlowNode = {
  id: string;
  type: string;
  name?: string;
  /** centre of the node on the canvas, as in Node-RED */
  x: number;
  y: number;
  /** per output port, the ids of the nodes it is wired to */
  wires: string[][];
  /** disabled: kept in the flow but not deployed */
  d?: boolean;
  [prop: string]: unknown;
};
export type Flow = { nodes: FlowNode[] };

export type Option = { value: string; label: string };
export type FieldDef = {
  key: string;
  label: string;
  kind: "text" | "number" | "password" | "textarea" | "code" | "select" | "checkbox" | "switchRules" | "changeRules";
  options?: Option[];
  placeholder?: string;
  help?: string;
  /** only shown when this returns true for the node being edited */
  show?: (n: FlowNode) => boolean;
};

export type CategoryId = "common" | "devices" | "protocols" | "function" | "storage";
export const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: "common", label: "Common" },
  { id: "devices", label: "Devices" },
  { id: "protocols", label: "Protocols" },
  { id: "function", label: "Function" },
  { id: "storage", label: "Storage & alerts" },
];

export type NodeDef = {
  type: string;
  /** palette label */
  label: string;
  category: CategoryId;
  color: string;
  icon: IconName;
  inputs: 0 | 1;
  outputs: number | ((n: FlowNode) => number);
  defaults: Record<string, unknown>;
  fields: FieldDef[];
  /** shown in the Info sidebar */
  info: string;
  /** gateway nodes need a server-side bridge (TCP / binary protocols a browser cannot open) */
  runtime?: "browser" | "gateway";
  /** inject's trigger on the left, debug's on/off toggle on the right */
  button?: "left" | "right";
  /** the label on the canvas when the node has no name */
  labelOf?: (n: FlowNode) => string;
};

const opts = (...pairs: [string, string][]): Option[] => pairs.map(([value, label]) => ({ value, label }));
const TYPED = opts(["str", "string"], ["num", "number"], ["bool", "boolean"], ["json", "JSON"], ["date", "timestamp"], ["msg", "msg."]);
const SECONDS_HELP = "Seconds between readings";

export const SENSOR_METRICS: Record<string, { unit: string; base: number; amplitude: number; noise: number }> = {
  temperature: { unit: "°C", base: 22, amplitude: 3, noise: 0.3 },
  humidity: { unit: "%", base: 45, amplitude: 8, noise: 1 },
  pressure: { unit: "hPa", base: 1013, amplitude: 4, noise: 0.5 },
  vibration: { unit: "mm/s", base: 2.5, amplitude: 1.5, noise: 0.6 },
  power: { unit: "kW", base: 12, amplitude: 5, noise: 0.8 },
  co2: { unit: "ppm", base: 600, amplitude: 150, noise: 20 },
  level: { unit: "%", base: 60, amplitude: 25, noise: 1 },
  flow: { unit: "L/min", base: 120, amplitude: 30, noise: 4 },
};

export const NODE_DEFS: NodeDef[] = [
  // ------------------------------------------------------------ common
  {
    type: "inject",
    label: "inject",
    category: "common",
    color: "#a6bbcf",
    icon: "play",
    inputs: 0,
    outputs: 1,
    button: "left",
    defaults: { payload: "", payloadType: "date", topic: "", repeat: "", once: false },
    fields: [
      { key: "payloadType", label: "Payload type", kind: "select", options: TYPED.filter((o) => o.value !== "msg") },
      { key: "payload", label: "Payload", kind: "text", show: (n) => n.payloadType !== "date" },
      { key: "topic", label: "Topic", kind: "text" },
      { key: "repeat", label: "Repeat every (s)", kind: "number", placeholder: "blank = no repeat" },
      { key: "once", label: "Inject once after deploy", kind: "checkbox" },
    ],
    info: "Sends a message into the flow when its button is clicked, once after deploy, or on an interval.",
    labelOf: (n) => (n.payloadType === "date" ? "timestamp" : String(n.payload ?? "") || "inject") + (n.repeat ? " ↻" : ""),
  },
  {
    type: "debug",
    label: "debug",
    category: "common",
    color: "#87a980",
    icon: "bug",
    inputs: 1,
    outputs: 0,
    button: "right",
    defaults: { active: true, complete: "payload" },
    fields: [{ key: "complete", label: "Output", kind: "select", options: opts(["payload", "msg.payload"], ["true", "complete msg object"]) }],
    info: "Shows messages in the Debug sidebar. Toggle it with the button on its right.",
    labelOf: (n) => (n.complete === "true" ? "msg" : "msg.payload"),
  },
  {
    type: "comment",
    label: "comment",
    category: "common",
    color: "#ffffff",
    icon: "comment",
    inputs: 0,
    outputs: 0,
    defaults: { info: "" },
    fields: [{ key: "info", label: "Notes", kind: "textarea" }],
    info: "A note on the canvas. Does nothing when deployed.",
    labelOf: () => "comment",
  },

  // ------------------------------------------------------------ devices
  {
    type: "sensor",
    label: "sensor",
    category: "devices",
    color: "#7fd1c7",
    icon: "thermometer",
    inputs: 0,
    outputs: 1,
    defaults: { device: "sensor-01", metric: "temperature", interval: 2, source: "simulate", spike: 2, format: "value", topicPrefix: "devices" },
    fields: [
      { key: "device", label: "Device id", kind: "text" },
      { key: "metric", label: "Metric", kind: "select", options: Object.keys(SENSOR_METRICS).map((m) => ({ value: m, label: m })) },
      { key: "source", label: "Source", kind: "select", options: opts(["simulate", "simulated readings"]) },
      { key: "interval", label: "Interval (s)", kind: "number", help: SECONDS_HELP },
      { key: "spike", label: "Anomaly rate (%)", kind: "number", help: "Share of readings with an injected spike, to test alarms" },
      { key: "format", label: "Payload", kind: "select", options: opts(["value", "the reading (number)"], ["object", "{ device, metric, value, unit, ts }"]) },
      { key: "topicPrefix", label: "Topic prefix", kind: "text", help: "Messages are sent on <prefix>/<device>/<metric>" },
    ],
    info:
      "A sensor device. Simulates realistic readings (a daily-style wave, noise and optional spikes) so a flow can be built and tested before the real device is connected — then swap it for an MQTT, OPC-UA or Modbus input.",
    labelOf: (n) => `${n.device ?? "sensor"} · ${n.metric ?? ""}`,
  },
  {
    type: "camera",
    label: "camera",
    category: "devices",
    color: "#c0deed",
    icon: "camera",
    inputs: 0,
    outputs: 1,
    defaults: { device: "camera-01", source: "webcam", url: "", interval: 5, width: 320, motion: false, threshold: 8 },
    fields: [
      { key: "device", label: "Device id", kind: "text" },
      { key: "source", label: "Source", kind: "select", options: opts(["webcam", "this computer's camera"], ["url", "snapshot URL (JPEG / PNG)"], ["rtsp", "RTSP / ONVIF stream (gateway)"]) },
      { key: "url", label: "URL", kind: "text", placeholder: "http://camera.local/snapshot.jpg", show: (n) => n.source !== "webcam" },
      { key: "interval", label: "Frame every (s)", kind: "number" },
      { key: "width", label: "Frame width (px)", kind: "number" },
      { key: "motion", label: "Only send frames with motion", kind: "checkbox" },
      { key: "threshold", label: "Motion threshold (%)", kind: "number", show: (n) => !!n.motion },
    ],
    info:
      "A camera device. Sends a JPEG frame on an interval: msg.payload = { image (data URL), width, height, motion }. Motion is the share of pixels that changed since the last frame; turn on the filter to send only frames above the threshold. Snapshot URLs must allow cross-origin requests.",
    labelOf: (n) => `${n.device ?? "camera"}`,
  },
  {
    type: "telemetry",
    label: "telemetry",
    category: "devices",
    color: "#a8e0d0",
    icon: "gauge",
    inputs: 1,
    outputs: 1,
    defaults: { deviceFrom: "topic", level: 1, deviceProp: "device", split: true },
    fields: [
      { key: "deviceFrom", label: "Device id from", kind: "select", options: opts(["topic", "a topic level"], ["payload", "a payload property"]) },
      { key: "level", label: "Topic level (0 = first)", kind: "number", show: (n) => n.deviceFrom !== "payload" },
      { key: "deviceProp", label: "Payload property", kind: "text", show: (n) => n.deviceFrom === "payload" },
      { key: "split", label: "One message per metric", kind: "checkbox" },
    ],
    info:
      "Normalises device telemetry. A JSON payload like { temperature: 21.5, humidity: 40 } becomes one message per metric: msg.payload = the value, with msg.device, msg.metric, msg.ts and msg.topic = <device>/<metric> — ready for alarms, windows and the Devices sidebar.",
  },
  {
    type: "alarm",
    label: "alarm",
    category: "devices",
    color: "#f3b6b6",
    icon: "bell",
    inputs: 1,
    outputs: 1,
    defaults: { property: "payload", high: 30, low: "", hysteresis: 0.5, perTopic: true },
    fields: [
      { key: "property", label: "Property", kind: "text", help: "msg property holding the value, e.g. payload or payload.value" },
      { key: "high", label: "High limit", kind: "number", placeholder: "blank = none" },
      { key: "low", label: "Low limit", kind: "number", placeholder: "blank = none" },
      { key: "hysteresis", label: "Hysteresis", kind: "number", help: "How far back inside the limits the value must come to clear the alarm" },
      { key: "perTopic", label: "Track each topic separately", kind: "checkbox" },
    ],
    info: "Raises and clears alarms. Sends a message only when the state changes: msg.payload = { state: high | low | normal, value, limit }.",
    labelOf: (n) => [n.low !== "" && n.low !== undefined ? `< ${n.low}` : "", n.high !== "" && n.high !== undefined ? `> ${n.high}` : ""].filter(Boolean).join(" · ") || "alarm",
  },

  // ------------------------------------------------------------ protocols
  {
    type: "mqtt in",
    label: "mqtt in",
    category: "protocols",
    color: "#d8bfd8",
    icon: "signal",
    inputs: 0,
    outputs: 1,
    defaults: { broker: "wss://broker.hivemq.com:8884/mqtt", topic: "devices/#", qos: "0", datatype: "auto", username: "", password: "" },
    fields: [
      { key: "broker", label: "Broker (WebSocket URL)", kind: "text", placeholder: "ws://localhost:9001", help: "The broker's WebSocket listener — mqtt:// TCP ports cannot be reached from a browser" },
      { key: "topic", label: "Topic", kind: "text", help: "+ matches one level, # the rest" },
      { key: "qos", label: "QoS", kind: "select", options: opts(["0", "0"], ["1", "1"]) },
      { key: "datatype", label: "Output", kind: "select", options: opts(["auto", "auto-detect (JSON / number / string)"], ["json", "parsed JSON"], ["utf8", "string"], ["buffer", "bytes"]) },
      { key: "username", label: "Username", kind: "text" },
      { key: "password", label: "Password", kind: "password", help: "Stored in the pipeline file" },
    ],
    info: "Subscribes to an MQTT topic and sends each message received: msg.topic, msg.payload, msg.qos, msg.retain.",
    runtime: "browser",
    labelOf: (n) => String(n.topic || "mqtt in"),
  },
  {
    type: "mqtt out",
    label: "mqtt out",
    category: "protocols",
    color: "#d8bfd8",
    icon: "signal",
    inputs: 1,
    outputs: 0,
    defaults: { broker: "wss://broker.hivemq.com:8884/mqtt", topic: "", qos: "0", retain: false, username: "", password: "" },
    fields: [
      { key: "broker", label: "Broker (WebSocket URL)", kind: "text", placeholder: "ws://localhost:9001" },
      { key: "topic", label: "Topic", kind: "text", placeholder: "blank = msg.topic" },
      { key: "qos", label: "QoS", kind: "select", options: opts(["0", "0"], ["1", "1"]) },
      { key: "retain", label: "Retain", kind: "checkbox" },
      { key: "username", label: "Username", kind: "text" },
      { key: "password", label: "Password", kind: "password", help: "Stored in the pipeline file" },
    ],
    info: "Publishes msg.payload to an MQTT topic (objects are sent as JSON) — e.g. commands back to devices.",
    runtime: "browser",
    labelOf: (n) => String(n.topic || "mqtt out"),
  },
  {
    type: "opcua in",
    label: "opc-ua read",
    category: "protocols",
    color: "#b9d7f0",
    icon: "cpu",
    inputs: 0,
    outputs: 1,
    defaults: { endpoint: "opc.tcp://localhost:4840", nodeId: "ns=2;s=Machine1.Temperature", interval: 1, security: "None" },
    fields: [
      { key: "endpoint", label: "Endpoint", kind: "text" },
      { key: "nodeId", label: "Node id", kind: "text", help: "One node id per line to read several tags" },
      { key: "interval", label: "Sampling interval (s)", kind: "number" },
      { key: "security", label: "Security", kind: "select", options: opts(["None", "None"], ["Sign", "Sign"], ["SignAndEncrypt", "Sign & encrypt"]) },
    ],
    info: "Reads (subscribes to) OPC-UA tags on a PLC or SCADA server. Runs on the device gateway: opc.tcp is not reachable from a browser.",
    runtime: "gateway",
    labelOf: (n) => String(n.nodeId || "opc-ua read").split("\n")[0],
  },
  {
    type: "opcua out",
    label: "opc-ua write",
    category: "protocols",
    color: "#b9d7f0",
    icon: "cpu",
    inputs: 1,
    outputs: 0,
    defaults: { endpoint: "opc.tcp://localhost:4840", nodeId: "", dataType: "Double" },
    fields: [
      { key: "endpoint", label: "Endpoint", kind: "text" },
      { key: "nodeId", label: "Node id", kind: "text", placeholder: "blank = msg.topic" },
      { key: "dataType", label: "Data type", kind: "select", options: opts(["Double", "Double"], ["Float", "Float"], ["Int32", "Int32"], ["Boolean", "Boolean"], ["String", "String"]) },
    ],
    info: "Writes msg.payload to an OPC-UA tag. Runs on the device gateway.",
    runtime: "gateway",
  },
  {
    type: "kafka in",
    label: "kafka in",
    category: "protocols",
    color: "#d1d1d1",
    icon: "wave",
    inputs: 0,
    outputs: 1,
    defaults: { brokers: "localhost:9092", topic: "telemetry", groupId: "bluesand", fromBeginning: false },
    fields: [
      { key: "brokers", label: "Bootstrap servers", kind: "text" },
      { key: "topic", label: "Topic", kind: "text" },
      { key: "groupId", label: "Consumer group", kind: "text" },
      { key: "fromBeginning", label: "Read from the beginning", kind: "checkbox" },
    ],
    info: "Consumes a Kafka topic. Runs on the device gateway: Kafka's protocol is not reachable from a browser.",
    runtime: "gateway",
    labelOf: (n) => String(n.topic || "kafka in"),
  },
  {
    type: "kafka out",
    label: "kafka out",
    category: "protocols",
    color: "#d1d1d1",
    icon: "wave",
    inputs: 1,
    outputs: 0,
    defaults: { brokers: "localhost:9092", topic: "telemetry", key: "" },
    fields: [
      { key: "brokers", label: "Bootstrap servers", kind: "text" },
      { key: "topic", label: "Topic", kind: "text" },
      { key: "key", label: "Message key", kind: "text", placeholder: "blank = msg.key" },
    ],
    info: "Produces msg.payload to a Kafka topic. Runs on the device gateway.",
    runtime: "gateway",
    labelOf: (n) => String(n.topic || "kafka out"),
  },
  {
    type: "modbus read",
    label: "modbus read",
    category: "protocols",
    color: "#e2c99e",
    icon: "server",
    inputs: 0,
    outputs: 1,
    defaults: { host: "192.168.1.10", port: 502, unitId: 1, fc: "holding", address: 0, quantity: 1, interval: 1 },
    fields: [
      { key: "host", label: "Host", kind: "text" },
      { key: "port", label: "Port", kind: "number" },
      { key: "unitId", label: "Unit id", kind: "number" },
      { key: "fc", label: "Read", kind: "select", options: opts(["coils", "coils"], ["inputs", "discrete inputs"], ["holding", "holding registers"], ["input", "input registers"]) },
      { key: "address", label: "Start address", kind: "number" },
      { key: "quantity", label: "Quantity", kind: "number" },
      { key: "interval", label: "Poll every (s)", kind: "number" },
    ],
    info: "Polls Modbus TCP registers on a PLC or meter. Runs on the device gateway.",
    runtime: "gateway",
  },
  {
    type: "http request",
    label: "http request",
    category: "protocols",
    color: "#e7e7ae",
    icon: "globe",
    inputs: 1,
    outputs: 1,
    defaults: { method: "GET", url: "", ret: "obj" },
    fields: [
      { key: "method", label: "Method", kind: "select", options: opts(["GET", "GET"], ["POST", "POST"], ["PUT", "PUT"], ["DELETE", "DELETE"], ["use", "- set by msg.method -"]) },
      { key: "url", label: "URL", kind: "text", placeholder: "blank = msg.url · {{payload.id}} is filled in" },
      { key: "ret", label: "Return", kind: "select", options: opts(["obj", "parsed JSON"], ["txt", "a string"]) },
    ],
    info: "Calls an HTTP API (a device REST endpoint, a webhook…). msg.payload is the body sent; the response replaces it, with msg.statusCode. The server must allow cross-origin requests.",
    runtime: "browser",
  },

  // ------------------------------------------------------------ function
  {
    type: "function",
    label: "function",
    category: "function",
    color: "#fdd0a2",
    icon: "code",
    inputs: 1,
    outputs: (n) => Math.max(0, Number(n.outputs ?? 1)),
    defaults: { func: "\nreturn msg;", outputs: 1 },
    fields: [
      { key: "func", label: "On message", kind: "code", help: "Return msg, an array (one per output), or null. node.send(), node.warn(), node.status() and context / flow .get() / .set() are available." },
      { key: "outputs", label: "Outputs", kind: "number" },
    ],
    info: "Runs JavaScript on each message, as in Node-RED.",
  },
  {
    type: "change",
    label: "change",
    category: "function",
    color: "#e2d96e",
    icon: "edit",
    inputs: 1,
    outputs: 1,
    defaults: { rules: [{ t: "set", p: "payload", pt: "msg", to: "", tot: "str" }] },
    fields: [{ key: "rules", label: "Rules", kind: "changeRules" }],
    info: "Sets, deletes or moves message properties.",
  },
  {
    type: "switch",
    label: "switch",
    category: "function",
    color: "#e2d96e",
    icon: "split",
    inputs: 1,
    outputs: (n) => Math.max(1, (n.rules as unknown[] | undefined)?.length ?? 1),
    defaults: { property: "payload", propertyType: "msg", rules: [{ t: "gt", v: "30", vt: "num" }, { t: "else" }], checkall: "true" },
    fields: [
      { key: "property", label: "Property", kind: "text", help: "msg property to test" },
      { key: "rules", label: "Rules — one output each", kind: "switchRules" },
      { key: "checkall", label: "When several match", kind: "select", options: opts(["true", "send to every matching output"], ["false", "stop at the first match"]) },
    ],
    info: "Routes messages to an output per rule.",
    labelOf: (n) => `switch ${n.property ?? "payload"}`,
  },
  {
    type: "range",
    label: "range",
    category: "function",
    color: "#e2d96e",
    icon: "sliders",
    inputs: 1,
    outputs: 1,
    defaults: { minin: 0, maxin: 4095, minout: 0, maxout: 100, action: "scale", round: false, property: "payload" },
    fields: [
      { key: "property", label: "Property", kind: "text" },
      { key: "action", label: "Action", kind: "select", options: opts(["scale", "scale"], ["clamp", "scale and clamp to the target range"], ["roll", "scale and wrap within the target range"]) },
      { key: "minin", label: "Input from", kind: "number" },
      { key: "maxin", label: "Input to", kind: "number" },
      { key: "minout", label: "Target from", kind: "number" },
      { key: "maxout", label: "Target to", kind: "number" },
      { key: "round", label: "Round to the nearest integer", kind: "checkbox" },
    ],
    info: "Maps a raw value (an ADC count, 4–20 mA…) to engineering units.",
  },
  {
    type: "rbe",
    label: "filter",
    category: "function",
    color: "#e2d96e",
    icon: "filter",
    inputs: 1,
    outputs: 1,
    defaults: { func: "deadband", gap: 0.5, property: "payload", perTopic: true },
    fields: [
      { key: "func", label: "Mode", kind: "select", options: opts(["rbe", "block unless the value changes"], ["deadband", "block unless the value changes by more than"], ["narrowband", "block if the value changes by more than"]) },
      { key: "gap", label: "Change", kind: "text", help: "A number, or a percentage such as 5%", show: (n) => n.func !== "rbe" },
      { key: "property", label: "Property", kind: "text" },
      { key: "perTopic", label: "Track each topic separately", kind: "checkbox" },
    ],
    info: "Report by exception: passes a reading only when it changes enough — cuts telemetry volume without losing events.",
    labelOf: (n) => (n.func === "rbe" ? "rbe" : `${n.func} ${n.gap}`),
  },
  {
    type: "smooth",
    label: "smooth",
    category: "function",
    color: "#e2d96e",
    icon: "wave",
    inputs: 1,
    outputs: 1,
    defaults: { action: "mean", count: 5, round: "", property: "payload", perTopic: true },
    fields: [
      { key: "action", label: "Return", kind: "select", options: opts(["mean", "moving average"], ["min", "minimum"], ["max", "maximum"], ["sd", "standard deviation"], ["low", "low-pass filter"], ["high", "high-pass filter"]) },
      { key: "count", label: "Over the last (values) / filter factor", kind: "number" },
      { key: "round", label: "Decimal places", kind: "number", placeholder: "blank = no rounding" },
      { key: "property", label: "Property", kind: "text" },
      { key: "perTopic", label: "Track each topic separately", kind: "checkbox" },
    ],
    info: "Smooths a noisy signal over the last N readings.",
    labelOf: (n) => `${n.action} ${n.count}`,
  },
  {
    type: "window",
    label: "window",
    category: "function",
    color: "#e2d96e",
    icon: "clock",
    inputs: 1,
    outputs: 1,
    defaults: { mode: "time", seconds: 60, count: 10, property: "payload", perTopic: true },
    fields: [
      { key: "mode", label: "Window", kind: "select", options: opts(["time", "every N seconds (tumbling)"], ["count", "every N messages"]) },
      { key: "seconds", label: "Seconds", kind: "number", show: (n) => n.mode !== "count" },
      { key: "count", label: "Messages", kind: "number", show: (n) => n.mode === "count" },
      { key: "property", label: "Property", kind: "text" },
      { key: "perTopic", label: "A window per topic", kind: "checkbox" },
    ],
    info: "Aggregates readings: at the end of each window sends msg.payload = { count, mean, min, max, first, last, from, to }.",
    labelOf: (n) => (n.mode === "count" ? `window ${n.count} msgs` : `window ${n.seconds}s`),
  },
  {
    type: "delay",
    label: "delay",
    category: "function",
    color: "#e6e0f8",
    icon: "clock",
    inputs: 1,
    outputs: 1,
    defaults: { pauseType: "delay", timeout: 1, timeoutUnits: "seconds", rate: 1, rateUnits: "second", drop: true },
    fields: [
      { key: "pauseType", label: "Action", kind: "select", options: opts(["delay", "delay each message"], ["rate", "rate limit"]) },
      { key: "timeout", label: "For", kind: "number", show: (n) => n.pauseType !== "rate" },
      { key: "timeoutUnits", label: "Units", kind: "select", options: opts(["milliseconds", "milliseconds"], ["seconds", "seconds"], ["minutes", "minutes"]), show: (n) => n.pauseType !== "rate" },
      { key: "rate", label: "Messages", kind: "number", show: (n) => n.pauseType === "rate" },
      { key: "rateUnits", label: "Per", kind: "select", options: opts(["second", "second"], ["minute", "minute"], ["hour", "hour"]), show: (n) => n.pauseType === "rate" },
      { key: "drop", label: "Drop the messages over the rate", kind: "checkbox", show: (n) => n.pauseType === "rate" },
    ],
    info: "Delays messages or limits their rate.",
    labelOf: (n) => (n.pauseType === "rate" ? `limit ${n.rate} msg/${String(n.rateUnits).slice(0, 1)}` : `delay ${n.timeout} ${String(n.timeoutUnits).slice(0, 1)}`),
  },
  {
    type: "json",
    label: "json",
    category: "function",
    color: "#debed7",
    icon: "code",
    inputs: 1,
    outputs: 1,
    defaults: { action: "", property: "payload" },
    fields: [
      { key: "action", label: "Action", kind: "select", options: opts(["", "convert both ways"], ["str", "always to a JSON string"], ["obj", "always to an object"]) },
      { key: "property", label: "Property", kind: "text" },
    ],
    info: "Converts between a JSON string and an object.",
  },

  // ------------------------------------------------------------ storage & alerts
  {
    type: "dataset out",
    label: "dataset",
    category: "storage",
    color: "#c7e9c0",
    icon: "database",
    inputs: 1,
    outputs: 0,
    defaults: { dataset: "telemetry", flushRows: 100, flushSeconds: 30 },
    fields: [
      { key: "dataset", label: "Dataset name", kind: "text", help: "A Parquet file in the pipeline's folder; batch pipelines can add it as input data" },
      { key: "flushRows", label: "Write every (rows)", kind: "number" },
      { key: "flushSeconds", label: "…or every (s)", kind: "number" },
    ],
    info: "Appends messages to a Parquet dataset in Files & Projects with columns ts, topic, device, metric, value and payload (JSON).",
    labelOf: (n) => `${n.dataset ?? "dataset"}.parquet`,
  },
  {
    type: "alert",
    label: "alert",
    category: "storage",
    color: "#ffb8a8",
    icon: "alert",
    inputs: 1,
    outputs: 0,
    defaults: { level: "warning", message: "{{topic}}: {{payload}}", notify: false },
    fields: [
      { key: "level", label: "Level", kind: "select", options: opts(["info", "info"], ["warning", "warning"], ["critical", "critical"]) },
      { key: "message", label: "Message", kind: "text", help: "{{payload}}, {{topic}}, {{payload.value}} … are filled in" },
      { key: "notify", label: "Also show a desktop notification", kind: "checkbox" },
    ],
    info: "Raises an alert in the editor and the Debug sidebar — pair it with an alarm node.",
    labelOf: (n) => `alert · ${n.level}`,
  },
];

export const DEF = new Map(NODE_DEFS.map((d) => [d.type, d]));

/** For types this editor does not know (from an imported Node-RED flow). */
export const UNKNOWN_DEF: NodeDef = {
  type: "unknown",
  label: "unknown",
  category: "common",
  color: "#ffffff",
  icon: "alert",
  inputs: 1,
  outputs: 1,
  defaults: {},
  fields: [],
  info: "This node type is not available here. It is kept in the flow so the wiring survives, but does nothing when deployed.",
};

export const defOf = (n: Pick<FlowNode, "type">) => DEF.get(n.type) ?? UNKNOWN_DEF;
export const outputCount = (n: FlowNode) => {
  const d = defOf(n);
  return d === UNKNOWN_DEF ? Math.max(1, n.wires.length) : typeof d.outputs === "function" ? d.outputs(n) : d.outputs;
};
export const inputCount = (n: FlowNode) => (defOf(n) === UNKNOWN_DEF ? 1 : defOf(n).inputs);

export function labelOf(n: FlowNode): string {
  if (n.name) return n.name;
  const d = defOf(n);
  return d === UNKNOWN_DEF ? n.type : (d.labelOf?.(n) ?? d.label);
}

// ---------------------------------------------------------------- geometry (Node-RED's)

export const NODE_HEIGHT = 30;
export const PORT = 10;
export const GRID = 20;

export function nodeSize(n: FlowNode): { w: number; h: number } {
  const w = Math.max(100, Math.min(300, Math.ceil((labelOf(n).length * 7 + 50) / GRID) * GRID));
  return { w, h: Math.max(NODE_HEIGHT, outputCount(n) * 15 + 6) };
}

/** Port centres in canvas coordinates. */
export function inPort(n: FlowNode) {
  const { w } = nodeSize(n);
  return { x: n.x - w / 2, y: n.y };
}
export function outPort(n: FlowNode, i: number) {
  const { w, h } = nodeSize(n);
  const count = outputCount(n);
  return { x: n.x + w / 2, y: count <= 1 ? n.y : n.y - h / 2 + ((i + 0.5) * h) / count };
}

/** Node-RED's wire curve. */
export function wirePath(x1: number, y1: number, x2: number, y2: number) {
  const dx = Math.max(Math.abs(x2 - x1) * 0.5, 40);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

export const snap = (v: number) => Math.round(v / (GRID / 2)) * (GRID / 2);

// ---------------------------------------------------------------- creating / importing

export const flowId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

export function newNode(type: string, x: number, y: number): FlowNode {
  const d = defOf({ type });
  const n: FlowNode = { id: flowId(), type, x: snap(x), y: snap(y), wires: [], ...structuredClone(d.defaults) };
  n.wires = Array.from({ length: outputCount(n) }, () => []);
  return n;
}

/** Wires trimmed or padded to the node's number of outputs (after rules or outputs change). */
export function fitWires(n: FlowNode): FlowNode {
  const count = outputCount(n);
  if (n.wires.length === count) return n;
  return { ...n, wires: Array.from({ length: count }, (_, i) => n.wires[i] ?? []) };
}

/** Copies of nodes with fresh ids; wires to nodes outside the set are dropped. */
export function cloneNodes(nodes: FlowNode[], dx = 40, dy = 40): FlowNode[] {
  const ids = new Map(nodes.map((n) => [n.id, flowId()]));
  return nodes.map((n) => ({
    ...structuredClone(n),
    id: ids.get(n.id)!,
    x: n.x + dx,
    y: n.y + dy,
    wires: n.wires.map((port) => port.filter((t) => ids.has(t)).map((t) => ids.get(t)!)),
  }));
}

/** Nodes from Node-RED export JSON (or this editor's): tabs, groups and config nodes are left out. */
export function importNodes(text: string): { nodes: FlowNode[]; skipped: number } {
  const raw = JSON.parse(text) as unknown;
  const list = (Array.isArray(raw) ? raw : (raw as { nodes?: unknown[] })?.nodes) as Record<string, unknown>[] | undefined;
  if (!Array.isArray(list)) throw new Error("Expected a JSON array of nodes, as exported from Node-RED");
  const nodes: FlowNode[] = [];
  let skipped = 0;
  for (const r of list) {
    if (typeof r?.id !== "string" || typeof r?.type !== "string" || typeof r.x !== "number" || typeof r.y !== "number") {
      skipped++; // tabs, groups, config nodes (mqtt-broker…)
      continue;
    }
    const { z: _z, g: _g, ...rest } = r;
    void _z;
    void _g;
    const n = { ...(DEF.get(r.type)?.defaults ?? {}), ...rest, wires: Array.isArray(r.wires) ? (r.wires as string[][]) : [] } as FlowNode;
    // Node-RED points mqtt nodes at an mqtt-broker config node; here the broker is a WebSocket URL
    if ((n.type === "mqtt in" || n.type === "mqtt out") && typeof n.broker === "string" && !/^wss?:\/\//.test(n.broker)) {
      const cfg = list.find((c) => c.id === n.broker);
      n.broker = cfg?.broker ? `ws://${cfg.broker}:9001` : String(DEF.get(n.type)!.defaults.broker);
    }
    if (n.type === "rbe" && n.inout === undefined) n.perTopic = r.septopics !== false;
    nodes.push(n);
  }
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes: nodes.map((n) => fitWires({ ...n, wires: n.wires.map((p) => (p ?? []).filter((t) => ids.has(t))) })), skipped };
}

/** Example flow for a new device pipeline: two simulated sensors through a filter to an alarm and a dataset. */
export function starterFlow(): Flow {
  const a = newNode("sensor", 140, 100);
  const b = { ...newNode("sensor", 140, 180), device: "sensor-02", metric: "vibration" };
  const filter = newNode("rbe", 340, 140);
  const alarm = { ...newNode("alarm", 540, 100), property: "payload", high: 25 };
  const alert = { ...newNode("alert", 740, 100), message: "{{device}} {{metric}} {{payload.state}}: {{payload.value}} (limit {{payload.limit}})" };
  const debug = newNode("debug", 540, 180);
  const store = newNode("dataset out", 540, 240);
  const note = { ...newNode("comment", 160, 40), name: "Swap the simulated sensors for mqtt in / opc-ua read once devices are connected" };
  a.wires = [[filter.id]];
  b.wires = [[filter.id]];
  filter.wires = [[alarm.id, debug.id, store.id]];
  alarm.wires = [[alert.id]];
  return { nodes: [note, a, b, filter, alarm, alert, debug, store] };
}
