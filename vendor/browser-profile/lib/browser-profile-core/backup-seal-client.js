"use strict";
const path = require("node:path"), { Worker } = require("node:worker_threads");
const { preflightSealInput } = require("./live-backup-input");
// One bounded worker per caller. Logical timeout never frees its physical slot.
class BackupSealWorker {
  constructor() { this.physical = null; }
  seal(value) {
    if (this.physical) return Promise.reject(new Error("profile_live_worker_busy"));
    try { preflightSealInput(value); } catch (error) { return Promise.reject(error); }
    const snapshot = structuredClone(value), key = snapshot?.request?.contentKeyEpoch?.key;
    const work = new Promise((resolve, reject) => {
      let result, failure;
      const worker = new Worker(path.join(__dirname, "backup-seal-worker.js"));
      worker.once("message", message => { if (message?.ok === true) result = message.result; else failure = new Error("profile_live_crypto_refused"); });
      worker.once("error", error => { failure = error; });
      worker.once("exit", code => { key?.fill(0); if (code !== 0 || failure || !result) reject(failure || new Error("profile_live_worker_failed")); else resolve(result); });
      try { worker.postMessage(snapshot); key?.fill(0); } catch (error) { key?.fill(0); failure = error; void worker.terminate(); }
    });
    this.physical = work; void work.finally(() => { key?.fill(0); if (this.physical === work) this.physical = null; }).catch(() => {}); return work;
  }
  async whenDrained() { if (this.physical) await this.physical.catch(() => {}); }
}
module.exports = { BackupSealWorker };
