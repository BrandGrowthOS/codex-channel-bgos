"use strict";
// Main only. The trusted private userData directory/OS account is the boundary,
// as with the stopped journal. Windows ACL and power-loss guarantees are not
// strengthened by POSIX mode bits. Only ciphertext and public metadata persist.
const path = require("node:path"), fs = require("node:fs"), { Worker } = require("node:worker_threads");
const { scopeOf, pinMap, preflightEncryptedBackup, validateBackupMetadata, freeze, MAX_WIRE_BYTES } = require("./active-backup-wire");
const jobs = new Set(), streams = new Set(), fail = code => Object.assign(new Error(code), { code });
function checker(callback) { if (typeof callback !== "function") throw fail("profile_backup_context_required"); const original = callback; return () => { const value = original(); if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail("profile_backup_context_changed"); } if (value === false) throw fail("profile_backup_context_changed"); }; }
class EncryptedBackupJournal {
  constructor({ directory, WorkerImpl = Worker, maxBytes = 512 * 1024 * 1024 }) {
    if (typeof directory !== "string" || !path.isAbsolute(directory) || typeof WorkerImpl !== "function" || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024 * 1024) throw fail("profile_backup_journal_configuration");
    this.directory = path.resolve(directory); this.WorkerImpl = WorkerImpl; this.maxBytes = maxBytes; this.handles = new WeakMap(); this.pending = new Set();
  }
  _job(kind, { scope, pins, assertCurrent }, fields = {}) {
    const check = checker(assertCurrent); check(); scope = scopeOf(scope); pins = [...pinMap(pins).values()].map(row => row.identity);
    if (jobs.size || streams.size) return Promise.reject(fail("profile_backup_journal_busy"));
    const lease = {}; jobs.add(lease);
    const work = new Promise((resolve, reject) => {
      let result, error, worker;
      try {
        worker = new this.WorkerImpl(path.join(__dirname, "backup-journal-worker.js"), { resourceLimits: { maxOldGenerationSizeMb: 512 } });
        worker.once("message", message => { if (message?.ok === true) result = message.result; else error = fail(/^profile_backup_[a-z_]+$/.test(message?.code) ? message.code : "profile_backup_journal_failed"); });
        worker.once("error", () => { error = fail("profile_backup_journal_failed"); });
        worker.once("exit", code => { if (code !== 0 || error || result === undefined) reject(error || fail("profile_backup_journal_failed")); else { try { check(); resolve(result); } catch (stale) { reject(stale); } } });
        check(); if (kind === "write") preflightEncryptedBackup(fields.backup, { scope, pins }); worker.postMessage({ kind, directory: this.directory, scope, pins, maxBytes: this.maxBytes, ...fields });
      } catch (failure) { if (worker) { error = failure; void worker.terminate(); } else reject(failure); }
    });
    this.pending.add(work); void work.finally(() => { jobs.delete(lease); this.pending.delete(work); }).catch(() => {}); return work;
  }
  _handle(record, context) {
    const metadata = validateBackupMetadata(record.metadata, context);
    if (typeof record.name !== "string" || record.name !== context.scope.profileId + "-" + metadata.bundle.snapshotId + ".backup" || !/^[a-f0-9]{64}$/.test(record.wireHash) || !Number.isSafeInteger(record.wireBytes) || record.wireBytes < 1 || record.wireBytes > MAX_WIRE_BYTES || !["prepared", "unknown", "confirmed"].includes(record.status)) throw fail("profile_backup_journal_result");
    const handle = Object.freeze({}); this.handles.set(handle, { ...record, metadata, scope: scopeOf(context.scope), pins: [...pinMap(context.pins).values()].map(row => row.identity) }); return handle;
  }
  metadata(handle) { const record = this.handles.get(handle); if (!record) throw fail("profile_backup_journal_handle"); return record.metadata; }
  status(handle) { const record = this.handles.get(handle); if (!record) throw fail("profile_backup_journal_handle"); return record.status; }
  write({ backup, scope, pins, assertCurrent }) {
    scope = scopeOf(scope); pins = [...pinMap(pins).values()].map(row => row.identity); preflightEncryptedBackup(backup, { scope, pins }); const context = { scope, pins, assertCurrent };
    return this._job("write", context, { backup }).then(record => { const handle = this._handle(record, context); return Object.freeze({ handle, metadata: this.metadata(handle), durability: freeze(record.durability) }); });
  }
  inspect({ scope, pins, assertCurrent }) { const context = { scope: scopeOf(scope), pins: [...pinMap(pins).values()].map(row => row.identity), assertCurrent }; return this._job("inspect", context).then(rows => { if (!Array.isArray(rows) || rows.length > 2) throw fail("profile_backup_journal_result"); return Object.freeze(rows.map(record => { const handle = this._handle(record, context); return Object.freeze({ handle, metadata: this.metadata(handle), status: record.status }); })); }); }
  _update(handle, kind, assertCurrent) {
    const record = this.handles.get(handle); if (!record) return Promise.reject(fail("profile_backup_journal_handle"));
    const context = { scope: record.scope, pins: record.pins, assertCurrent };
    return this._job(kind, context, { name: record.name, bundleHash: record.metadata.bundleHash, wireHash: record.wireHash }).then(next => { if (next.name !== record.name || next.wireHash !== record.wireHash || next.metadata?.bundleHash !== record.metadata.bundleHash || next.status !== kind) throw fail("profile_backup_journal_result"); this._handle(next, context); this.handles.set(handle, { ...record, ...next, metadata: record.metadata }); return Object.freeze({ status: next.status, durability: freeze(next.durability) }); });
  }
  markUnknown(handle, { assertCurrent }) { return this._update(handle, "unknown", assertCurrent); }
  markConfirmed(handle, { assertCurrent }) { return this._update(handle, "confirmed", assertCurrent); }
  openUpload(handle, options) { const work = this._openUpload(handle, options); this.pending.add(work); void work.finally(() => this.pending.delete(work)).catch(() => {}); return work; }
  async _openUpload(handle, { assertCurrent }) {
    const record = this.handles.get(handle), check = checker(assertCurrent); if (!record || record.status !== "unknown") throw fail("profile_backup_journal_handle"); check();
    const current = await this._job("verify", { scope: record.scope, pins: record.pins, assertCurrent: check }, { name: record.name, bundleHash: record.metadata.bundleHash, wireHash: record.wireHash }); check();
    if (current.status !== "unknown") throw fail("profile_backup_journal_state");
    if (jobs.size || streams.size) throw fail("profile_backup_journal_busy"); const lease = {}; streams.add(lease); let opened;
    try {
      const file = path.join(this.directory, record.name), before = await fs.promises.lstat(file); check();
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.dev !== current.stat.dev || before.ino !== current.stat.ino || before.size !== current.wireBytes || before.mtimeMs !== current.stat.mtimeMs) throw fail("profile_backup_journal_changed");
      opened = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); const after = await opened.stat(); check();
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw fail("profile_backup_journal_changed");
      const stream = opened.createReadStream(), drained = new Promise(resolve => stream.once("close", () => { streams.delete(lease); resolve(); })); stream.on("error", () => {}); opened = null;
      this.pending.add(drained); void drained.finally(() => this.pending.delete(drained));
      return Object.freeze({ stream, byteLength: current.wireBytes, close: () => stream.destroy(), whenDrained: () => drained });
    } catch (error) { try { await opened?.close(); } finally { streams.delete(lease); } throw error; }
  }
  async whenDrained() { while (this.pending.size) await Promise.allSettled([...this.pending]); }
}
module.exports = { EncryptedBackupJournal, checker };
