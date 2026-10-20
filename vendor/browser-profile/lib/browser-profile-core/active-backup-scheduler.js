"use strict";
// Main only, opt-in composition. Dirty events are hints, never authority.
// Local files and backup metadata cannot stage, restore, or activate a browser.
const crypto = require("node:crypto");
const { validateSealRequest } = require("./live-backup-input");
const { checker } = require("./backup-journal");
const { scopeOf, authorityOf, sameAuthority, pinMap, preflightEncryptedBackup, freeze } = require("./active-backup-wire");
const largeTasks = new Set(), fail = code => Object.assign(new Error(code), { code });
const projection = metadata => metadata ? Object.freeze({ snapshotId: metadata.bundle.snapshotId, sequence: metadata.bundle.sequence, bundleHash: metadata.bundleHash, writerEpoch: metadata.bundle.sourceAuthority.writerEpoch }) : null;
function activeProfile(profile, authority) {
  return profile.writerState === "active" && profile.id === authority.profileId && profile.actingUserId === authority.actingUserId && profile.assistantId === authority.assistantId &&
    ["endpointId", "bootId", "runtimeId", "sessionId", "writerEpoch", "revision", "contentKeyEpoch"].every(key => profile[key] === authority[key]);
}
class ActiveBackupScheduler {
  constructor({ scope, currentContext, client, journal, debounceMs = 60000, timeoutMs = 15000, onStatus = () => {} }) {
    scope = scopeOf(scope);
    if (typeof currentContext !== "function" || typeof onStatus !== "function" || ["endpointHead", "upload", "whenDrained", "cancelPending"].some(name => typeof client?.[name] !== "function") ||
        ["inspect", "write", "markConfirmed", "whenDrained"].some(name => typeof journal?.[name] !== "function") || !Number.isSafeInteger(debounceMs) || debounceMs < 100 || debounceMs > 300000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail("profile_backup_scheduler_configuration");
    Object.assign(this, { scope, currentContext, client, journal, debounceMs, timeoutMs, onStatus }); this.running = false; this.epoch = 0; this.physical = null; this.timer = null; this.dirty = false; this.pendingCandidate = null; this.lastConfirmed = null; this.state = "idle"; this.reason = null; this.requestKey = null;
  }
  status() { return Object.freeze({ state: this.state, busy: this.physical !== null, captureKind: "live-best-effort", localDurable: this.pendingCandidate !== null || this.lastConfirmed !== null, uploadOutcome: this.pendingCandidate ? "unknown" : this.lastConfirmed ? "confirmed" : "none", pending: projection(this.pendingCandidate?.metadata), lastConfirmed: projection(this.lastConfirmed), reason: this.reason }); }
  _status(state, reason = null) { this.state = state; this.reason = reason; const value = this.status(); try { this.onStatus(value); } catch {} return value; }
  start() { if (this.running) return this.status(); this.running = true; this.epoch++; return this._status(this.pendingCandidate ? "unknown" : "idle"); }
  stop() { this.running = false; this.epoch++; this.dirty = false; clearTimeout(this.timer); this.timer = null; this.requestKey?.fill(0); this.client.cancelPending(); return this._status(this.pendingCandidate ? "unknown" : "stopped", "profile_backup_stopped"); }
  notify() { if (!this.running) return; this.dirty = true; if (this.physical || this.timer || this.pendingCandidate) return; this.timer = setTimeout(() => { this.timer = null; void this.captureNow().catch(() => {}); }, this.debounceMs); this.timer.unref?.(); }
  async _context(epoch, expired) {
    const local = () => { if (!this.running || this.epoch !== epoch || expired()) throw fail("profile_backup_context_changed"); };
    local(); const raw = await this.currentContext(); local(); const authority = authorityOf(raw?.authority), original = checker(raw?.assertCurrent); original();
    if (authority.profileId !== this.scope.profileId || authority.actingUserId !== this.scope.actingUserId || authority.assistantId !== this.scope.assistantId || !raw.capture || typeof raw.capture.capture !== "function" || typeof raw.capture.whenDrained !== "function" || !sameAuthority(authorityOf(raw.capture.authority), authority)) throw fail("profile_backup_context_changed");
    const check = () => { local(); original(); }, request = { snapshotId: crypto.randomUUID(), sequence: 1, previousBundleHash: null, source: raw.source, recipients: raw.recipients, contentKeyEpoch: raw.contentKeyEpoch };
    validateSealRequest(request); const pins = [...pinMap(raw.metadataPins).values()].map(row => row.identity);
    // Copy the 32-byte transient content key. Website plaintext stays inside
    // the existing native capture and seal worker ownership boundary.
    const snapshot = structuredClone(request); this.requestKey = snapshot.contentKeyEpoch.key;
    const capture = Object.freeze({ capture: raw.capture.capture.bind(raw.capture), whenDrained: raw.capture.whenDrained.bind(raw.capture) });
    return { authority, source: snapshot.source, pins, request: snapshot, capture, check, clientOptions: { scope: this.scope, pins, authority, endpoint: snapshot.source, assertCurrent: check } };
  }
  async _reconcile(context) {
    const candidate = this.pendingCandidate; if (!candidate) return null;
    context.check(); const head = await this.client.endpointHead({ ...context.clientOptions, writerEpoch: candidate.metadata.bundle.sourceAuthority.writerEpoch }); context.check();
    const confirmed = head.retained.find(row => row.bundleHash === candidate.metadata.bundleHash && row.bundle.snapshotId === candidate.metadata.bundle.snapshotId);
    if (!confirmed) return this._status("unknown", candidate.status === "prepared" ? "profile_backup_recovery_required" : "profile_backup_unconfirmed");
    await this.journal.markConfirmed(candidate.handle, { assertCurrent: context.check }); context.check(); this.lastConfirmed = candidate.metadata; this.pendingCandidate = null; return this._status("confirmed");
  }
  _run(reconcileOnly) {
    if (!this.running) return Promise.resolve(this.status());
    if (this.physical) return Promise.resolve(this.status());
    if (largeTasks.size) return Promise.resolve(this._status("skipped", "profile_backup_global_busy"));
    clearTimeout(this.timer); this.timer = null; this.dirty = false;
    const epoch = this.epoch, lease = {}; largeTasks.add(lease); let expired = false, timer, context;
    const work = Promise.resolve().then(async () => {
      context = await this._context(epoch, () => expired); context.check();
      const records = await this.journal.inspect({ scope: this.scope, pins: context.pins, assertCurrent: context.check }); context.check();
      const unresolved = records.filter(record => record.status !== "confirmed"); if (unresolved.length > 1) throw fail("profile_backup_recovery_required");
      if (!this.pendingCandidate && unresolved.length) this.pendingCandidate = unresolved[0];
      else if (this.pendingCandidate) { const current = unresolved.find(row => row.metadata.bundleHash === this.pendingCandidate.metadata.bundleHash); if (current) this.pendingCandidate = current; }
      if (this.pendingCandidate) return this._reconcile(context);
      if (reconcileOnly) return this.status();
      const head = await this.client.endpointHead(context.clientOptions); context.check();
      if (!activeProfile(head.profile, context.authority) || head.head && !sameAuthority(head.head.bundle.sourceAuthority, context.authority)) throw fail("profile_backup_writer_changed");
      context.request.sequence = head.head ? head.head.bundle.sequence + 1 : 1; context.request.previousBundleHash = head.head?.bundleHash ?? null;
      this._status("capturing"); context.check(); const captured = await context.capture.capture(context.request); await context.capture.whenDrained(); context.check();
      context.request.contentKeyEpoch.key.fill(0);
      if (captured?.state !== "captured") return this._status("skipped", typeof captured?.reason === "string" && /^profile_live_[a-z_]+$/.test(captured.reason) ? captured.reason : "profile_backup_capture_skipped");
      const metadata = preflightEncryptedBackup(captured.result, { scope: this.scope, pins: context.pins });
      const expected = context.request.recipients.map(row => ({ endpointId: row.identity.endpointId, keyFingerprint: row.keyFingerprint, grantVersion: row.grantVersion })).sort((a, b) => a.endpointId < b.endpointId ? -1 : 1);
      if (!sameAuthority(metadata.bundle.sourceAuthority, context.authority) || metadata.bundle.snapshotId !== context.request.snapshotId || metadata.bundle.sequence !== context.request.sequence || metadata.bundle.previousBundleHash !== context.request.previousBundleHash || metadata.bundle.recipients.length !== expected.length || expected.some((row, i) => ["endpointId", "keyFingerprint", "grantVersion"].some(key => row[key] !== metadata.bundle.recipients[i][key]))) throw fail("profile_backup_recipient_set_changed");
      context.check(); this._status("journaling"); context.check(); const saved = await this.journal.write({ backup: captured.result, scope: this.scope, pins: context.pins, assertCurrent: context.check });
      if (saved?.durability?.fileSynced !== true || saved.metadata?.bundleHash !== metadata.bundleHash) throw fail("profile_backup_not_durable"); this.pendingCandidate = { handle: saved.handle, metadata: saved.metadata, status: "prepared" };
      context.check(); this._status("uploading"); context.check(); await this.client.upload({ ...context.clientOptions, handle: saved.handle }); context.check(); return this._reconcile(context);
    }).catch(error => this._status(this.pendingCandidate ? "unknown" : "skipped", /^profile_(backup|live)_[a-z_]+$/.test(error?.code) ? error.code : "profile_backup_failed"))
      .finally(async () => {
        let cleanupFailed = false;
        try {
          const results = await Promise.allSettled([() => context?.capture.whenDrained(), () => this.client.whenDrained(), () => this.journal.whenDrained()].map(callback => Promise.resolve().then(callback)));
          cleanupFailed = results.some(value => value.status === "rejected"); if (cleanupFailed) this._status(this.pendingCandidate ? "unknown" : "skipped", "profile_backup_cleanup_unknown");
        } finally { this.requestKey?.fill(0); this.requestKey = null; if (!cleanupFailed) { largeTasks.delete(lease); if (this.physical === work) this.physical = null; } clearTimeout(timer); this._status(this.state, this.reason); if (this.dirty && this.running && !expired && !this.pendingCandidate && !cleanupFailed) this.notify(); }
      });
    this.physical = work;
    const timeout = new Promise(resolve => { timer = setTimeout(() => { expired = true; this.requestKey?.fill(0); this.client.cancelPending(); resolve(this._status(this.pendingCandidate ? "unknown" : "skipped", "profile_backup_timeout")); }, this.timeoutMs); });
    return Promise.race([work, timeout]).then(() => this.status()).finally(() => clearTimeout(timer));
  }
  captureNow() { return this._run(false); }
  reconcile() { return this._run(true); }
  async whenDrained() { if (this.physical) await this.physical; }
}
module.exports = { ActiveBackupScheduler };
