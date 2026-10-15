"use strict";
const { parentPort } = require("node:worker_threads");
const { sealActiveBackup } = require("./active-backup-crypto");
parentPort.once("message", value => {
  try { parentPort.postMessage({ ok: true, result: sealActiveBackup(value) }); }
  catch { parentPort.postMessage({ ok: false }); }
  finally { value?.request?.contentKeyEpoch?.key?.fill(0); parentPort.close(); }
});
