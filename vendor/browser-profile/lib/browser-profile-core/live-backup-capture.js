"use strict";
const { exactAuthority } = require("./coordinator-client");
const { validatePortableBundle } = require("./portable-state");
const { validateSealRequest } = require("./live-backup-input");
const fail = code => Object.assign(new Error(code), { code });
function synchronous(callback) { const value = callback(); if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail("profile_live_async_proof"); } if (value === false) throw fail("profile_live_context_changed"); return value; }

// Main only. Advisory encrypted backup, never a stopped checkpoint or writer
// capability. The current document and its network remain active throughout.
class NativeLiveBackupCapture {
  constructor({ authority, openReadScope, readExtras, protection, assertCurrent, sealDraft, timeoutMs = 5000 }) {
    if ([openReadScope, readExtras, protection, assertCurrent, sealDraft].some(value => typeof value !== "function") || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new TypeError("profile_live_dependencies_required");
    this.authority = exactAuthority(authority); Object.assign(this, { openReadScope, readExtras, protection, assertCurrent, sealDraft, timeoutMs }); this.physical = null;
  }
  capture(request) {
    if (this.physical) return Promise.resolve(Object.freeze({ state: "skipped", reason: "busy" }));
    try { validateSealRequest(request); request = structuredClone(request); }
    catch { return Promise.resolve(Object.freeze({ state: "skipped", reason: "profile_live_input_invalid" })); }
    const assertCurrent = this.assertCurrent.bind(this), protection = this.protection.bind(this), openReadScope = this.openReadScope.bind(this), readExtras = this.readExtras.bind(this), sealDraft = this.sealDraft.bind(this);
    let scope, draft, timer;
    const physical = Promise.resolve().then(async () => {
      synchronous(assertCurrent); const protectedState = synchronous(protection);
      if (!protectedState || protectedState.blocked !== false || typeof protectedState.version !== "string" || !protectedState.version || protectedState.version.length > 256) throw fail("profile_live_credentials_protected");
      const version = protectedState.version;
      const current = () => { synchronous(assertCurrent); const value = synchronous(protection); if (!value || value.blocked !== false || value.version !== version) throw fail("profile_live_credentials_changed"); scope?.assertCurrent(); };
      scope = synchronous(() => openReadScope({ authority: this.authority, protection, assertCurrent, timeoutMs: this.timeoutMs }));
      if (!scope || ["assertCurrent", "readCookies", "readOrigin", "release", "whenDrained"].some(name => typeof scope[name] !== "function") || !Array.isArray(scope.origins) || scope.origins.length > 100) throw fail("profile_live_read_scope_invalid");
      current();
      // This is an immutable atomic read. No vault mutation lease survives
      // native I/O, worker encryption or a future network upload.
      const extras = validatePortableBundle(synchronous(readExtras)); current();
      draft = { cookies: await scope.readCookies(), origins: [], extras }; current();
      if (!Array.isArray(draft.cookies) || draft.cookies.length > 10000) throw fail("profile_live_size_limit");
      let bytes = 0;
      for (const cookie of draft.cookies) { for (const field of ["name", "value", "domain", "path"]) { if (typeof cookie?.[field] !== "string") throw fail("profile_live_cookie_unsupported"); bytes += Buffer.byteLength(cookie[field]); } bytes += 256; }
      for (const origin of scope.origins) { const value = await scope.readOrigin(origin); current(); if (typeof value !== "string" || (bytes += Buffer.byteLength(value)) > 16 * 1024 * 1024) throw fail("profile_live_size_limit"); draft.origins.push(value); }
      if (bytes > 16 * 1024 * 1024) throw fail("profile_live_size_limit");
      const result = await sealDraft({ request, authority: this.authority, draft, captureKind: "live-best-effort" }); current();
      return Object.freeze({ state: "captured", captureKind: "live-best-effort", result });
    }).catch(error => Object.freeze({ state: "skipped", reason: typeof error?.code === "string" && /^profile_live_[a-z_]+$/.test(error.code) ? error.code : "profile_live_capture_failed" }))
      .finally(async () => {
        draft = null; let cleanupFailed = false;
        try { if (typeof scope?.release === "function") scope.release(); } catch { cleanupFailed = true; }
        try { if (typeof scope?.whenDrained === "function") await scope.whenDrained(); } catch { cleanupFailed = true; }
        finally { request?.contentKeyEpoch?.key?.fill(0); if (!cleanupFailed && this.physical === physical) this.physical = null; }
        if (cleanupFailed) throw fail("profile_live_cleanup_unknown");
      }).catch(() => Object.freeze({ state: "skipped", reason: "profile_live_cleanup_unknown" }));
    this.physical = physical;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(Object.freeze({ state: "skipped", reason: "profile_live_timeout" })), this.timeoutMs); });
    return Promise.race([physical, timeout]).finally(() => clearTimeout(timer));
  }
  async whenDrained() { if (this.physical) await this.physical; }
}
module.exports = { NativeLiveBackupCapture };
