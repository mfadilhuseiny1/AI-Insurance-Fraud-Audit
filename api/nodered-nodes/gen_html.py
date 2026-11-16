"""Writes bluesandai/bluesandai.html (the nodes' palette entries, edit dialogs and help) from NODES below:
python api/nodered-nodes/gen_html.py"""
import html
import json
from pathlib import Path

METRICS = ["temperature", "humidity", "pressure", "vibration", "power", "co2", "level", "flow"]
# type, palette label, color, icon, inputs, outputs, fields [(key, label, kind, default, options | help)], help, label (JS)
NODES = [
    ("dataset out", "dataset out", "#c7e9c0", "font-awesome/fa-database", 1, 0,
     [("dataset", "Dataset", "dataset", "telemetry", "A Parquet dataset in this Node-RED's folder (created on the first write)"),
      ("flushRows", "Write every (rows)", "number", 100, None), ("flushSeconds", "…or every (s)", "number", 30, None)],
     "<p>Appends messages to a <b>BluesandAI dataset</b> (Parquet, in Files &amp; Projects) with the columns <code>ts</code>, <code>topic</code>, "
     "<code>device</code>, <code>metric</code>, <code>value</code> (a number when the payload is one) and <code>payload</code> (JSON).</p>"
     "<p>Rows are written in batches. In a Device stream the dataset is an output of the pipeline (Data Lineage) and carries its markings.</p>",
     "this.name || ((this.dataset || 'dataset') + '.parquet')"),
    ("dataset in", "dataset in", "#c7e9c0", "font-awesome/fa-table", 1, 1,
     [("dataset", "Dataset", "dataset", "", "A dataset in this Node-RED's folder"), ("limit", "Rows (at most)", "number", 1000, None)],
     "<p>Reads a <b>BluesandAI dataset</b> when a message arrives: <code>msg.payload</code> is an array of rows (objects), <code>msg.columns</code> "
     "its columns. <code>msg.dataset</code> overrides the dataset.</p>",
     "this.name || this.dataset || 'dataset in'"),
    ("stream out", "stream out", "#9fd5e6", "font-awesome/fa-random", 1, 0,
     [("stream", "Ingest stream", "stream", "", "A stream of the Streaming app")],
     "<p>Pushes <code>msg.payload</code> to a <b>BluesandAI ingest stream</b>: an object is one record, an array several. A plain value becomes "
     "<code>{topic, device, metric, value, ts}</code>. <code>msg.stream</code> (a stream id) overrides the stream.</p>",
     "this.name || this.streamName || 'stream out'"),
    ("sensor", "sensor", "#7fd1c7", "font-awesome/fa-thermometer-half", 0, 1,
     [("device", "Device id", "text", "sensor-01", None), ("metric", "Metric", "select", "temperature", [(m, m) for m in METRICS]),
      ("interval", "Interval (s)", "number", 2, None), ("spike", "Anomaly rate (%)", "number", 2, "Share of readings with an injected spike, to test alarms"),
      ("format", "Payload", "select", "value", [("value", "the reading (number)"), ("object", "{ device, metric, value, unit, ts }")]),
      ("topicPrefix", "Topic prefix", "text", "devices", "Messages are sent on <prefix>/<device>/<metric>")],
     "<p>A simulated sensor: realistic readings (a slow wave, noise and optional spikes) so a flow can be built and tested before the real device "
     "is connected — then swap it for an <code>mqtt in</code>, OPC-UA or Modbus node.</p>",
     "this.name || ((this.device || 'sensor') + ' · ' + (this.metric || ''))"),
    ("camera", "camera", "#c0deed", "font-awesome/fa-camera", 1, 1,
     [("device", "Device id", "text", "camera-01", None), ("url", "Snapshot URL", "text", "", "http://camera.local/snapshot.jpg (JPEG / PNG)"),
      ("interval", "Frame every (s)", "number", 5, None), ("motion", "Only send frames with motion", "checkbox", False, None),
      ("threshold", "Motion threshold (%)", "number", 8, None)],
     "<p>A network camera: fetches a snapshot on an interval (or when a message arrives) and sends "
     "<code>msg.payload = { image (data URL), bytes, motion }</code>. Motion is a rough share of the image that changed since the last frame.</p>",
     "this.name || this.device || 'camera'"),
    ("telemetry", "telemetry", "#a8e0d0", "font-awesome/fa-tachometer", 1, 1,
     [("deviceFrom", "Device id from", "select", "topic", [("topic", "a topic level"), ("payload", "a payload property")]),
      ("level", "Topic level (0 = first)", "number", 1, None), ("deviceProp", "Payload property", "text", "device", None),
      ("split", "One message per metric", "checkbox", True, None)],
     "<p>Normalises device telemetry. A JSON payload like <code>{ temperature: 21.5, humidity: 40 }</code> becomes one message per metric: "
     "<code>msg.payload</code> = the value, with <code>msg.device</code>, <code>msg.metric</code>, <code>msg.ts</code> and "
     "<code>msg.topic</code> = &lt;device&gt;/&lt;metric&gt;.</p>",
     "this.name || 'telemetry'"),
    ("alarm", "alarm", "#f3b6b6", "font-awesome/fa-bell", 1, 1,
     [("property", "Property", "text", "payload", "msg property holding the value, e.g. payload or payload.value"),
      ("high", "High limit", "text", "30", "blank = none"), ("low", "Low limit", "text", "", "blank = none"),
      ("hysteresis", "Hysteresis", "number", 0.5, "How far back inside the limits the value must come to clear the alarm"),
      ("perTopic", "Track each topic separately", "checkbox", True, None)],
     "<p>Raises and clears alarms. Sends a message only when the state changes: <code>msg.payload = { state: high | low | normal, value, limit }</code>.</p>",
     "this.name || ([this.low !== '' && this.low !== undefined ? '< ' + this.low : '', this.high !== '' && this.high !== undefined ? '> ' + this.high : '']"
     ".filter(Boolean).join(' · ') || 'alarm')"),
    ("smooth", "smooth", "#e2d96e", "font-awesome/fa-line-chart", 1, 1,
     [("action", "Return", "select", "mean", [("mean", "moving average"), ("min", "minimum"), ("max", "maximum"), ("sd", "standard deviation"),
                                               ("low", "low-pass filter"), ("high", "high-pass filter")]),
      ("count", "Over the last (values) / filter factor", "number", 5, None), ("round", "Decimal places", "text", "", "blank = no rounding"),
      ("property", "Property", "text", "payload", None), ("perTopic", "Track each topic separately", "checkbox", True, None)],
     "<p>Smooths a noisy signal over the last N readings.</p>",
     "this.name || ((this.action || 'mean') + ' ' + (this.count || ''))"),
    ("window", "window", "#e2d96e", "font-awesome/fa-clock-o", 1, 1,
     [("mode", "Window", "select", "time", [("time", "every N seconds (tumbling)"), ("count", "every N messages")]),
      ("seconds", "Seconds", "number", 60, None), ("count", "Messages", "number", 10, None),
      ("property", "Property", "text", "payload", None), ("perTopic", "A window per topic", "checkbox", True, None)],
     "<p>Aggregates readings: at the end of each window sends <code>msg.payload = { count, mean, min, max, first, last, from, to }</code>.</p>",
     "this.name || (this.mode === 'count' ? 'window ' + this.count + ' msgs' : 'window ' + this.seconds + 's')"),
    ("alert", "alert", "#ffb8a8", "font-awesome/fa-exclamation-triangle", 1, 1,
     [("level", "Level", "select", "warning", [("info", "info"), ("warning", "warning"), ("critical", "critical")]),
      ("message", "Message", "text", "{{topic}}: {{payload}}", "{{payload}}, {{topic}}, {{payload.value}} … are filled in")],
     "<p>Raises an alert: shown in the Debug sidebar (warning yellow, critical red — a critical alert also reaches <code>catch</code> nodes) and "
     "passed on with <code>msg.alert = { level, text }</code>. Pair it with an alarm node.</p>",
     "this.name || ('alert · ' + (this.level || 'warning'))"),
]

PICKER = """<script type="text/javascript">
(function () {
  // dataset / stream pickers filled from the platform; typing a name stays possible
  window.bluesandaiPick = function (input, what) {
    var id = input.attr("id") + "-list";
    $("#" + id).remove();
    var list = $("<datalist>").attr("id", id).insertAfter(input);
    input.attr("list", id);
    $.getJSON("bluesandai/" + what).done(function (items) {
      (items || []).forEach(function (i) { $("<option>").attr("value", i.value).text(i.label).appendTo(list); });
    });
  };
})();
</script>"""


def node_html(t, label, color, icon, ins, outs, fields, help_, lab) -> str:
    typ = f"bluesandai {t}"
    defaults = {"name": {"value": ""}}
    for k, _, _kind, d, _o in fields:
        defaults[k] = {"value": d}
    if t == "stream out":
        defaults["streamName"] = {"value": ""}
    rows = ['<div class="form-row"><label for="node-input-name"><i class="fa fa-tag"></i> Name</label>'
            '<input type="text" id="node-input-name" placeholder="Name" style="width:70%"></div>']
    prep = []
    for k, lbl, kind, _d, o in fields:
        hid = f"node-input-{k}"
        if kind == "select":
            opts = "".join(f'<option value="{html.escape(v)}">{html.escape(x)}</option>' for v, x in o)
            ctl = f'<select id="{hid}" style="width:70%">{opts}</select>'
        elif kind == "checkbox":
            ctl = f'<input type="checkbox" id="{hid}" style="width:auto;vertical-align:top">'
        else:
            ph = f' placeholder="{html.escape(o)}"' if isinstance(o, str) and kind == "text" else ""
            ctl = f'<input type="{"number" if kind == "number" else "text"}" id="{hid}" style="width:70%"{ph}>'
        rows.append(f'<div class="form-row"><label for="{hid}">{html.escape(lbl)}</label>{ctl}</div>')
        if isinstance(o, str) and kind != "text":
            rows.append(f'<div class="form-tips" style="margin-bottom:12px">{html.escape(o)}</div>')
        if kind in ("dataset", "stream"):
            prep.append(f'bluesandaiPick($("#{hid}"), "{kind}s");')
    save = ""
    if t == "stream out":
        save = ('  oneditsave: function () { var v = $("#node-input-stream").val(); '
                'var o = $("#node-input-stream-list option").filter(function () { return this.value === v; }); '
                'this.streamName = o.length ? o.text() : ""; },\n')
    return f"""<script type="text/javascript">
RED.nodes.registerType({json.dumps(typ)}, {{
  category: "BluesandAI",
  color: {json.dumps(color)},
  defaults: {json.dumps(defaults, ensure_ascii=False)},
  inputs: {ins},
  outputs: {outs},
  icon: {json.dumps(icon)},
  paletteLabel: {json.dumps(label)},
{"  align: 'right'," + chr(10) if outs == 0 else ""}  label: function () {{ return {lab}; }},
  oneditprepare: function () {{ {" ".join(prep)} }},
{save}}});
</script>
<script type="text/html" data-template-name={json.dumps(typ)}>
{chr(10).join(rows)}
</script>
<script type="text/html" data-help-name={json.dumps(typ)}>
{help_}
</script>"""


if __name__ == "__main__":
    parts = ["<!-- generated by api/nodered-nodes/gen_html.py: edit there -->", PICKER, *(node_html(*n) for n in NODES)]
    Path(__file__).resolve().with_name("bluesandai").joinpath("bluesandai.html").write_text("\n".join(parts) + "\n", "utf-8")
    print("wrote", len(NODES), "nodes")
