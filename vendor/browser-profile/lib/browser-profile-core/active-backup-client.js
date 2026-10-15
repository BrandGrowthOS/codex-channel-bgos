"use strict";
// Fixed human or paired-principal HOAI routes. These requests never include browser
// cookies, an acting-user override, endpoint private keys or portable plaintext.
const crypto = require("node:crypto");
const { documentSignature } = require("./coordinator-client");
const { checker } = require("./backup-journal");
const { scopeOf, pinMap, authorityOf, sameAuthority, validateBackupHead, validateBackupContext, validateUploadAck, MAX_WIRE_BYTES } = require("./active-backup-wire");
const fail = (code, statusCode) => Object.assign(new Error(code), { code, ...(statusCode ? { statusCode } : {}) });
const uploads = new Set();
const PAIRED = Symbol("paired active backup");
const ID = /^[A-Za-z0-9_-]{1,128}$/;
function snapshot(options) {
  const scope = scopeOf(options.scope), pins = [...pinMap(options.pins).values()].map(row => row.identity), check = checker(options.assertCurrent); check(); return { scope, pins, check };
}
function endpointOf(endpoint, authority) {
  const identity = [...pinMap([endpoint?.identity]).values()][0];
  const key = endpoint?.signingPrivateKey;
  if (identity.identity.endpointId !== authority.endpointId || identity.fingerprint !== authority.keyFingerprint || !(key instanceof crypto.KeyObject) || key.type !== "private" || key.asymmetricKeyType !== "ed25519" || crypto.createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64url") !== identity.identity.signingPublicKey) throw fail("profile_backup_endpoint_invalid");
  return Object.freeze({ identity: identity.identity, signingPrivateKey: key });
}
class ActiveBackupClient {
  #cleanupUnknown = false;
  #paired;
  constructor({ endpoint, authorize, journal, fetchImpl = globalThis.fetch, timeoutMs = 8000 }, principal) {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)) || typeof authorize !== "function" || typeof fetchImpl !== "function" || !journal || ["metadata", "markUnknown", "openUpload"].some(name => typeof journal[name] !== "function") || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw fail("profile_backup_configuration_invalid");
    this.#paired = principal === PAIRED;
    this.origin = url.origin; this.authorize = authorize; this.journal = journal; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.pending = new Set(); this.controllers = new Set(); this.activeUploads = new Set();
  }
  _track(work) { this.pending.add(work); void work.finally(() => this.pending.delete(work)).catch(() => {}); return work; }
  async _request(method, route, context, bodyFactory) {
    if (this.#cleanupUnknown) throw fail("profile_backup_cleanup_unknown");
    if (this.#paired && method !== "POST") throw fail("profile_backup_pairing_required");
    const authorize = this.authorize.bind(this), fetchImpl = this.fetchImpl.bind(this);
    const requestedScope = this.#paired ? Object.freeze({ purpose: "endpoint", ...context.scope }) : context.scope;
    const proof = await authorize(requestedScope); context.check();
    const token = proof?.token, originalCheck = proof?.assertCurrent;
    if (typeof token !== "string" || !token || token.length > 16384 || /\s/.test(token) || typeof originalCheck !== "function") throw fail("profile_backup_sign_in_required");
    const binding = this.#paired ? { token, assertCurrent: originalCheck, pairingId: proof.pairingId, ownerUserId: proof.ownerUserId, assistantId: proof.assistantId } : null;
    if (binding && (!Number.isSafeInteger(binding.pairingId) || binding.pairingId < 1 || typeof binding.ownerUserId !== "string" || !ID.test(binding.ownerUserId) || binding.assistantId !== context.scope.assistantId)) throw fail("profile_backup_pairing_required");
    let controller;
    const principalCheck = checker(originalCheck.bind(proof)), check = () => { context.check(); if (binding && Object.keys(binding).some(key => proof[key] !== binding[key])) throw fail("profile_backup_context_changed"); principalCheck(); if (this.#cleanupUnknown) throw fail("profile_backup_cleanup_unknown"); if (controller?.signal.aborted) throw fail("profile_backup_cancelled"); }; check();
    let upload, dispatched = false, response, reader; controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      this.controllers.add(controller); const body = bodyFactory ? await bodyFactory(check) : undefined; upload = body?.upload; if (upload) this.activeUploads.add(upload); check();
      const headers = { [this.#paired ? "X-BGOS-Pairing" : "Authorization"]: this.#paired ? token : `Bearer ${token}`, Accept: "application/json", "Accept-Encoding": "identity", ...(body ? { "Content-Type": "application/json" } : {}) };
      if (upload) { if (!Number.isSafeInteger(upload.byteLength) || upload.byteLength < 1 || upload.byteLength > MAX_WIRE_BYTES) throw fail("profile_backup_request_too_large"); headers["Content-Length"] = String(upload.byteLength); }
      const bytes = upload ? upload.stream : body?.json;
      if (!upload && bytes !== undefined && (typeof bytes !== "string" || Buffer.byteLength(bytes) > 64 * 1024)) throw fail("profile_backup_request_too_large");
      check(); dispatched = true;
      response = await fetchImpl(new URL(`/api/v1/browser/profile-sync/${route}`, this.origin).href, { method, headers, body: bytes, ...(upload ? { duplex: "half" } : {}), redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal }); check();
      if (!response || !Number.isInteger(response.status) || !response.body?.getReader || response.headers?.get("content-encoding") && response.headers.get("content-encoding") !== "identity") throw fail("profile_backup_response_invalid");
      reader = response.body.getReader(); const chunks = []; let length = 0;
      try {
        for (;;) { const { value, done } = await reader.read(); check(); if (done) break; if (!(value instanceof Uint8Array) || (length += value.byteLength) > 64 * 1024) throw fail("profile_backup_response_too_large"); chunks.push(Buffer.from(value)); }
        const joined = Buffer.concat(chunks);
        try {
          const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(joined)); check();
          if (response.status < 200 || response.status >= 300) throw fail("profile_backup_request_refused", response.status);
          return value;
        } finally { joined.fill(0); }
      } finally { for (const chunk of chunks) chunk.fill(0); }
    } catch (error) {
      let stale; try { check(); } catch (changed) { stale = changed; }
      if (dispatched && upload) throw fail("profile_backup_outcome_unknown", error?.statusCode); if (stale) throw stale;
      if (error?.code?.startsWith("profile_backup_")) throw error;
      throw fail("profile_backup_connection_unavailable");
    } finally {
      clearTimeout(timer); controller.abort();
      // Every independent cleanup must run, but only positive completion can
      // release physical capacity. A settled request is not a drain receipt.
      const cleanup = async callback => { try { await callback(); } catch { this.#cleanupUnknown = true; } };
      await cleanup(() => reader ? reader.cancel() : response?.body?.cancel());
      await cleanup(() => reader?.releaseLock());
      if (upload) { await cleanup(() => upload.close()); await cleanup(() => upload.whenDrained()); }
      this.activeUploads.delete(upload); this.controllers.delete(controller);
      if (this.#cleanupUnknown) throw fail(dispatched && upload ? "profile_backup_outcome_unknown" : "profile_backup_cleanup_unknown");
    }
  }
  humanHead(options) {
    if (this.#paired) return Promise.reject(fail("profile_backup_pairing_required"));
    const context = snapshot(options), writerEpoch = options.writerEpoch;
    if (!Number.isSafeInteger(writerEpoch) || writerEpoch < 0) return Promise.reject(fail("profile_backup_scope_invalid"));
    return this._track(this._request("GET", `profiles/${context.scope.profileId}/backups/head`, context).then(raw => validateBackupHead(raw, { ...context, writerEpoch })));
  }
  endpointHead(options) {
    const context = snapshot(options), authority = authorityOf(options.authority), endpoint = endpointOf(options.endpoint, authority), writerEpoch = options.writerEpoch ?? authority.writerEpoch;
    if (authority.profileId !== context.scope.profileId || authority.actingUserId !== context.scope.actingUserId || authority.assistantId !== context.scope.assistantId || !Number.isSafeInteger(writerEpoch) || writerEpoch < 0 || writerEpoch > authority.writerEpoch) return Promise.reject(fail("profile_backup_scope_invalid"));
    const request = { requestId: crypto.randomUUID(), ...context.scope, endpointId: authority.endpointId, keyFingerprint: authority.keyFingerprint, grantVersion: authority.grantVersion, writerEpoch, expiresAt: Date.now() + 9000 };
    const signature = documentSignature(endpoint, { version: 1, kind: "active-backup-head-read", ...request });
    return this._track(this._request("POST", `profiles/${context.scope.profileId}/backups/head`, context, () => ({ json: JSON.stringify({ ...request, signature }) })).then(raw => validateBackupHead(raw, { ...context, writerEpoch, requestId: request.requestId })));
  }
  endpointContext(options) {
    const context = snapshot(options), authority = authorityOf(options.authority), endpoint = endpointOf(options.endpoint, authority);
    if (authority.profileId !== context.scope.profileId || authority.actingUserId !== context.scope.actingUserId || authority.assistantId !== context.scope.assistantId) return Promise.reject(fail("profile_backup_scope_invalid"));
    const request = Object.freeze({ version: 2, requestId: crypto.randomUUID(), sourceAuthority: authority, expiresAt: Date.now() + 9000 });
    const signature = documentSignature(endpoint, { kind: "active-backup-context-read", ...request });
    return this._track(this._request("POST", `profiles/${context.scope.profileId}/backups/head`, context, () => ({ json: JSON.stringify({ ...request, signature }) })).then(raw => validateBackupContext(raw, { ...context, request })));
  }
  upload(options) {
    if (this.#cleanupUnknown) return Promise.reject(fail("profile_backup_cleanup_unknown"));
    const context = snapshot(options), metadata = this.journal.metadata(options.handle), handle = options.handle, authority = authorityOf(options.authority);
    if (!sameAuthority(metadata.bundle.sourceAuthority, authority) || authority.profileId !== context.scope.profileId || authority.actingUserId !== context.scope.actingUserId || authority.assistantId !== context.scope.assistantId) return Promise.reject(fail("profile_backup_scope_invalid"));
    if (uploads.size) return Promise.reject(fail("profile_backup_upload_busy")); const lease = {}; uploads.add(lease);
    const markUnknown = this.journal.markUnknown.bind(this.journal), openUpload = this.journal.openUpload.bind(this.journal);
    const work = this._request("POST", `profiles/${context.scope.profileId}/backups`, context, async check => { await markUnknown(handle, { assertCurrent: check }); check(); return { upload: await openUpload(handle, { assertCurrent: check }) }; }).then(raw => { try { return validateUploadAck(raw, metadata); } catch { throw fail("profile_backup_outcome_unknown"); } }).finally(() => { if (!this.#cleanupUnknown) uploads.delete(lease); });
    return this._track(work);
  }
  async whenDrained() { while (this.pending.size) await Promise.allSettled([...this.pending]); if (this.#cleanupUnknown) throw fail("profile_backup_cleanup_unknown"); }
  cancelPending() { for (const controller of this.controllers) { try { controller.abort(); } catch { this.#cleanupUnknown = true; } } for (const upload of this.activeUploads) { try { upload.close(); } catch { this.#cleanupUnknown = true; } } }
}
class HumanActiveBackupClient extends ActiveBackupClient {
  constructor(options) { super(options); }
}
class PairedActiveBackupClient extends ActiveBackupClient {
  constructor({ authorizePairing, ...options }) {
    if (options.authorize !== undefined) throw fail("profile_backup_configuration_invalid");
    super({ ...options, authorize: authorizePairing }, PAIRED);
  }
}
module.exports = { HumanActiveBackupClient, PairedActiveBackupClient };
