/* The worker behind runtime.syncCall: runs one Ontology read at a time for a waiting TypeScript v1 function. */
"use strict";
const { workerData, parentPort } = require("worker_threads");
const rt = require("./runtime.js");

parentPort.on("message", async ({ op, args, staged }) => {
  let reply;
  try {
    rt.setStagedSid(staged);
    reply = { ok: true, value: await rt.SYNC_OPS[op](...(args || [])) };
  } catch (e) {
    reply = { ok: false, error: (e && e.message) || String(e), name: e && e.name };
  }
  workerData.port.postMessage(reply);
  Atomics.store(workerData.signal, 0, 1);
  Atomics.notify(workerData.signal, 0);
});
