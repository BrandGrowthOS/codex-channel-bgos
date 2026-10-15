"use strict";
const crypto = require("node:crypto"), wire = require("./profile-file-wire"), files = require("./profile-file-crypto");
const { documentSignature } = require("./coordinator-client");
const physical = new Set(), META_MAX = 64 * 1024;
const fail = (code, statusCode) => Object.assign(new Error(code), { code, ...(statusCode ? { statusCode } : {}) });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
/** Main/agent only. One fixed HOAI origin, fresh single-principal capability,
 * irreversible upload/claim attempts and a positively drained physical slot. */
class ProfileFileClient {
  #pending = null; #cleanupUnknown = false; #closed = false; #controllers = new Set(); #records = new Map(); #handles = new WeakMap();
  constructor({ origin, principal, authorize, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000 }) {
    const url = new URL(origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)) || !["human", "paired"].includes(principal) || [authorize, fetchImpl, now].some(value => typeof value !== "function") || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw fail("profile_file_configuration_invalid");
    Object.defineProperties(this, { origin: { value: url.origin }, principal: { value: principal }, authorize: { value: authorize }, fetchImpl: { value: fetchImpl }, now: { value: now }, timeoutMs: { value: timeoutMs } });
  }
  #clock() { const value = this.now(); if (!Number.isSafeInteger(value) || value < 0) throw fail("profile_file_context_changed"); return value; }
  #admit() { if (this.#closed || this.#cleanupUnknown) throw fail(this.#cleanupUnknown ? "profile_file_cleanup_unconfirmed" : "profile_file_closed"); if (physical.size || this.#pending) throw fail("profile_file_busy"); }
  #context({ scope, pins, authority: rawAuthority, endpoint, assertCurrent, signal }) {
    const current = wire.scopeOf(scope), authority = wire.authorityOf(rawAuthority), reviewed = wire.pinsOf(pins), identity = wire.identityOf(endpoint?.identity), own = reviewed.get(identity.endpointId);
    if (!own || authority.profileId !== current.profileId || authority.actingUserId !== current.actingUserId || authority.assistantId !== current.assistantId || reviewed.get(authority.endpointId)?.keyFingerprint !== authority.keyFingerprint || reviewed.get(authority.endpointId)?.grantVersion !== authority.grantVersion || signal && (typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function" || typeof signal.aborted !== "boolean" || signal.aborted)) throw fail("profile_file_context_changed");
    const local = wire.endpointOf(endpoint, { endpointId: identity.endpointId, keyFingerprint: own.keyFingerprint }), started = this.#clock(); wire.checkCurrent(assertCurrent);
    return { scope: current, authority, pins: Object.freeze([...reviewed.values()].sort((left, right) => left.identity.endpointId.localeCompare(right.identity.endpointId)).map(value => Object.freeze({ identity: value.identity, grantVersion: value.grantVersion }))), endpoint: local, current: assertCurrent, signal, started };
  }
  #check(context) { if (this.#closed || context.signal?.aborted || this.#clock() < context.started) throw fail("profile_file_context_changed"); wire.checkCurrent(context.current); }
  #handle(handle, context) {
    const record = handle && typeof handle === "object" ? this.#handles.get(handle) : null;
    if (!record || this.#records.get(record.offer.fileId) !== record || !wire.same(record.scope, context.scope) || !wire.same(record.offer.authority, context.authority) || !wire.same(record.pins, context.pins) || ![record.offer.source.endpointId, record.offer.destination.endpointId].includes(context.endpoint.identity.endpointId)) throw fail("profile_file_handle_required");
    this.#check(context); return record;
  }
  #retain(offer, signature, context, previous) {
    const existing = this.#records.get(offer.fileId);
    if (existing) {
      if (!wire.same(existing.offer, offer) || existing.signature !== signature || !wire.same(existing.scope, context.scope) || !wire.same(existing.pins, context.pins)) throw fail("profile_file_offer_changed");
      return existing;
    }
    const now = this.#clock(); for (const [id, record] of this.#records) if (record.offer.expiresAt + 60_000 <= now) this.#records.delete(id);
    if (this.#records.size >= 64) throw fail("profile_file_inventory_capacity");
    const handle = Object.freeze(Object.create(null)), record = { offer, signature, scope: context.scope, pins: context.pins, status: previous ?? null, handle, createAttempted: false, consentAttempted: false, uploadAttempted: false, claimAttempted: false, cancelAttempted: false };
    this.#records.set(offer.fileId, record); this.#handles.set(handle, record); return record;
  }
  #status(raw, context, record) {
    const value = wire.statusOf(raw, { scope: context.scope, pins: context.pins, expectedOffer: record?.offer, expectedSignature: record?.signature, previous: record?.status });
    if (!wire.same(value.offer.authority, context.authority)) throw fail("profile_file_authority_changed");
    if (record) record.status = value; return value;
  }
  #effect(record) { if (!record.status || record.status.current !== true || record.status.state === "expired" || record.offer.expiresAt <= this.#clock()) throw fail("profile_file_current_status_required"); }
  async #http(context, { route, method = "POST", body, rawBody, binary = false, expectedBytes, expectedHash, mutating = false }) {
    this.#admit(); this.#check(context);
    let cancelled = false; const lease = {}, controller = new AbortController(), abort = () => { cancelled = true; controller.abort(); }; physical.add(lease); this.#controllers.add(abort);
    let expired = false, dispatched = false, signalBound = false, timer, reader, responseBody, upload, resultBytes;
    const chunks = [], check = () => { this.#check(context); if (expired || cancelled) throw fail(dispatched && mutating ? "profile_file_outcome_unknown" : "profile_file_unavailable"); };
    const work = Promise.resolve().then(async () => {
      try {
        if (context.signal) { signalBound = true; context.signal.addEventListener("abort", abort, { once: true }); }
        check(); const requestedScope = this.principal === "human" ? { actingUserId: context.scope.actingUserId, assistantId: context.scope.assistantId } : { purpose: "endpoint", actingUserId: context.scope.actingUserId, assistantId: context.scope.assistantId };
        const proof = await this.authorize(Object.freeze(requestedScope)); check();
        if (!proof || typeof proof.token !== "string" || !proof.token || proof.token.length > 16384 || /\s/.test(proof.token) || typeof proof.assertCurrent !== "function" || this.principal === "paired" && (!Number.isSafeInteger(proof.pairingId) || proof.pairingId < 1 || typeof proof.ownerUserId !== "string" || !wire.ID.test(proof.ownerUserId) || proof.assistantId !== context.scope.assistantId)) throw fail("profile_file_principal_required");
        const snapshot = { token: proof.token, assertCurrent: proof.assertCurrent, ...(this.principal === "paired" ? { pairingId: proof.pairingId, ownerUserId: proof.ownerUserId, assistantId: proof.assistantId } : {}) };
        const admitted = () => { check(); if (Object.keys(snapshot).some(key => proof[key] !== snapshot[key])) throw fail("profile_file_context_changed"); wire.checkCurrent(() => snapshot.assertCurrent.call(proof)); }; admitted();
        const headers = { [this.principal === "human" ? "Authorization" : "X-BGOS-Pairing"]: this.principal === "human" ? "Bearer " + snapshot.token : snapshot.token, Accept: binary ? "application/octet-stream" : "application/json", "Accept-Encoding": "identity" };
        let bytes;
        if (rawBody !== undefined) {
          if (!Buffer.isBuffer(rawBody) || rawBody.length !== expectedBytes || rawBody.length > files.MAX_CIPHER_BYTES) throw fail("profile_file_payload_changed");
          upload = Buffer.from(rawBody); if (hash(upload) !== expectedHash) throw fail("profile_file_payload_changed");
          const encoded = Buffer.from(JSON.stringify(body)); try { if (encoded.length > 6144) throw fail("profile_file_proof_too_large"); headers["X-HOAI-File-Proof"] = encoded.toString("base64url"); } finally { encoded.fill(0); }
          headers["Content-Type"] = "application/octet-stream"; headers["Content-Length"] = String(upload.length); bytes = upload;
        } else if (body !== undefined) { bytes = JSON.stringify(body); if (Buffer.byteLength(bytes) > META_MAX) throw fail("profile_file_proof_too_large"); headers["Content-Type"] = "application/json"; }
        admitted(); dispatched = true;
        const response = await this.fetchImpl(new URL("/api/v1/browser/profile-sync/" + route, this.origin).href, { method, headers, body: bytes, credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal });
        // Own even late/refused response bodies before checking their context.
        responseBody = response?.body; if (typeof responseBody?.getReader === "function") reader = responseBody.getReader(); admitted();
        if (!response || !Number.isInteger(response.status) || response.redirected || !reader || response.headers?.get("content-encoding") && response.headers.get("content-encoding") !== "identity") throw fail("profile_file_response_invalid");
        const successful = response.status >= 200 && response.status < 300, limit = binary && successful ? expectedBytes : META_MAX; let length = 0;
        for (;;) { const { value, done } = await reader.read(); admitted(); if (done) break; if (!(value instanceof Uint8Array) || (length += value.byteLength) > limit) throw fail("profile_file_response_too_large"); chunks.push(Buffer.from(value)); }
        admitted(); if (!successful) throw fail(mutating ? "profile_file_outcome_unknown" : "profile_file_refused", response.status);
        const joined = Buffer.concat(chunks, length);
        if (binary) {
          if (joined.length !== expectedBytes || response.headers?.get("content-type") !== "application/octet-stream" || response.headers?.get("content-length") !== String(expectedBytes) || response.headers?.get("x-hoai-file-hash") !== expectedHash || hash(joined) !== expectedHash) { joined.fill(0); throw fail("profile_file_response_invalid"); }
          resultBytes = joined; return joined;
        }
        try { return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(joined)); } catch { throw fail("profile_file_response_invalid"); } finally { joined.fill(0); }
      } finally {
        const cleanup = async work => { try { await work(); } catch { this.#cleanupUnknown = true; } };
        controller.abort(); await cleanup(() => reader ? reader.cancel() : responseBody?.cancel()); await cleanup(() => reader?.releaseLock());
        for (const chunk of chunks) chunk.fill(0); upload?.fill(0); if (signalBound) await cleanup(() => context.signal.removeEventListener("abort", abort)); this.#controllers.delete(abort);
        if (this.#cleanupUnknown) { resultBytes?.fill(0); throw fail("profile_file_cleanup_unconfirmed"); }
      }
    }).then(result => { try { check(); return result; } catch (error) { resultBytes?.fill(0); throw error; } }).catch(error => {
      resultBytes?.fill(0); if (error?.code === "profile_file_context_changed") throw error;
      throw fail(dispatched && mutating ? "profile_file_outcome_unknown" : this.#cleanupUnknown ? "profile_file_cleanup_unconfirmed" : error?.code?.startsWith("profile_file_") ? error.code : "profile_file_unavailable", error?.statusCode);
    }).finally(() => { if (!this.#cleanupUnknown) { physical.delete(lease); if (this.#pending === work) this.#pending = null; } });
    this.#pending = work; void work.catch(() => {});
    try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { expired = true; controller.abort(); reject(fail(dispatched && mutating ? "profile_file_outcome_unknown" : "profile_file_unavailable")); }, this.timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  #prepareOffer(options) {
    this.#admit(); const context = this.#context(options), sealed = wire.exact(options.sealed, ["offer", "signature", "payload"]), offer = files.parseOffer(sealed.offer);
    const initial = this.#status({ offer, signature: sealed.signature, offerHash: files.offerHash(offer, sealed.signature), consent: null, state: "offered", uploadAttemptedAt: null, claimedAt: null, current: true, uploadOutcome: "not-uploaded" }, context);
    files.fresh(offer, this.#clock()); if (offer.source.endpointId !== context.endpoint.identity.endpointId) throw fail("profile_file_source_required");
    const record = this.#retain(initial.offer, initial.signature, context); if (record.createAttempted) throw fail("profile_file_offer_spent");
    return { context, offer, record };
  }
  // Main/agent-only pre-dispatch capability. This neither creates a server row
  // nor grants consent; callers retain the exact handle before a possible write.
  prepareOffer(options) { return this.#prepareOffer(options).record.handle; }
  async offer(options) {
    const { context, offer, record } = this.#prepareOffer(options); record.createAttempted = true;
    try { const raw = await this.#http(context, { route: `profiles/${context.scope.profileId}/files`, body: { offer, signature: record.signature }, mutating: true }); return Object.freeze({ handle: record.handle, status: this.#status(raw, context, record) }); }
    catch (error) { if (!["profile_file_outcome_unknown", "profile_file_response_invalid", "profile_file_cleanup_unconfirmed"].includes(error?.code)) throw error; this.#check(context); return Object.freeze({ handle: record.handle, status: Object.freeze({ state: "outcome-unknown", current: null }) }); }
  }
  async #pendingRows(context, reviewedPeers) {
    let body, route, method = "POST";
    if (this.principal === "human") { route = `files/pending/${context.scope.assistantId}`; method = "GET"; }
    else {
      const authority = context.authority;
      if (authority.profileId !== context.scope.profileId || authority.actingUserId !== context.scope.actingUserId || authority.assistantId !== context.scope.assistantId) throw fail("profile_file_scope_changed");
      const document = { version: reviewedPeers ? 2 : 1, kind: "agent-browser-file-pending", authority, endpointId: context.endpoint.identity.endpointId, keyFingerprint: require("./crypto").identityFingerprint(context.endpoint.identity), queryNonce: crypto.randomBytes(32).toString("base64url"), expiresAt: this.#clock() + 30_000, ...(reviewedPeers ? { reviewedPeers } : {}) };
      body = { document, signature: documentSignature(context.endpoint, document) }; route = `profiles/${context.scope.profileId}/files/pending`;
    }
    const raw = await this.#http(context, { route, method, body }), value = wire.exact(raw, this.principal === "human" ? ["actingUserId", "assistantId", "files"] : ["endpointId", "queryNonce", "expiresAt", "files", ...(reviewedPeers ? ["version", "authority", "peers"] : [])]);
    if (this.principal === "human" ? value.actingUserId !== context.scope.actingUserId || value.assistantId !== context.scope.assistantId : value.endpointId !== body.document.endpointId || value.queryNonce !== body.document.queryNonce || value.expiresAt !== body.document.expiresAt) throw fail("profile_file_response_invalid");
    if (this.principal === "paired" && body.document.expiresAt <= this.#clock()) throw fail("profile_file_response_invalid");
    if (reviewedPeers && (value.version !== 2 || !wire.same(wire.authorityOf(value.authority), context.authority))) throw fail("profile_file_response_invalid");
    return { rows: wire.array(value.files, 4), peers: reviewedPeers ? wire.array(value.peers, 4) : null };
  }
  async pending(options) {
    this.#admit(); const context = this.#context(options), { rows } = await this.#pendingRows(context), output = [];
    const selected = new Set(context.pins.map(pin => pin.identity.endpointId));
    for (const rawStatus of rows) {
      // Human discovery covers all enrolled desktops. Parse scope before
      // filtering, but never accept or retain an unselected endpoint pair.
      const offered = files.parseOffer(wire.exact(rawStatus, ["offer", "signature", "offerHash", "consent", "state", "uploadAttemptedAt", "claimedAt", "current", "uploadOutcome"]).offer);
      if (offered.authority.profileId !== context.scope.profileId || offered.authority.actingUserId !== context.scope.actingUserId || offered.authority.assistantId !== context.scope.assistantId) throw fail("profile_file_scope_changed");
      if (![offered.source.endpointId, offered.destination.endpointId].includes(context.endpoint.identity.endpointId) || !selected.has(offered.source.endpointId) || !selected.has(offered.destination.endpointId)) continue;
      const status = this.#status(rawStatus, context), record = this.#retain(status.offer, status.signature, context); record.status = this.#status(rawStatus, context, record); output.push(Object.freeze({ handle: record.handle, status: record.status }));
    }
    if (new Set(output.map(row => row.status.offer.fileId)).size !== output.length) throw fail("profile_file_response_invalid"); return Object.freeze(output);
  }
  async pendingReviewed(options) {
    this.#admit(); if (this.principal !== "paired") throw fail("profile_file_role_required");
    const value = wire.exact(options, Object.hasOwn(options || {}, "signal") ? ["scope", "authority", "endpoint", "peerIdentities", "assertCurrent", "signal"] : ["scope", "authority", "endpoint", "peerIdentities", "assertCurrent"]), scope = wire.scopeOf(value.scope), authority = wire.authorityOf(value.authority), identity = wire.identityOf(value.endpoint?.identity);
    if (authority.profileId !== scope.profileId || authority.actingUserId !== scope.actingUserId || authority.assistantId !== scope.assistantId || identity.endpointId !== authority.endpointId || value.signal && (typeof value.signal.addEventListener !== "function" || typeof value.signal.removeEventListener !== "function" || typeof value.signal.aborted !== "boolean" || value.signal.aborted)) throw fail("profile_file_context_changed");
    const endpoint = wire.endpointOf(value.endpoint, authority), peers = wire.array(value.peerIdentities, 4).map(wire.identityOf).sort((left, right) => left.endpointId.localeCompare(right.endpointId));
    if (!peers.length || peers.some(peer => peer.endpointId === identity.endpointId) || new Set(peers.map(peer => peer.endpointId)).size !== peers.length) throw fail("profile_file_reviewed_pins_required");
    const context = { scope, authority, endpoint, current: value.assertCurrent, signal: value.signal, started: this.#clock() }; this.#check(context);
    const response = await this.#pendingRows(context, peers), output = [], currentPeers = response.peers.map(raw => {
      const metadata = wire.exact(raw, ["kind", "ownerUserId", "pairingId", "identity", "keyFingerprint", "grantVersion", "backgroundUse"]), identity = wire.identityOf(metadata.identity), reviewed = peers.find(peer => peer.endpointId === identity.endpointId);
      if (!reviewed || !wire.same(identity, reviewed) || metadata.kind !== "desktop" || metadata.ownerUserId !== scope.actingUserId || metadata.pairingId !== null || metadata.backgroundUse !== false || metadata.keyFingerprint !== require("./crypto").identityFingerprint(identity) || !Number.isSafeInteger(metadata.grantVersion) || metadata.grantVersion < 1) throw fail("profile_file_reviewed_pins_required");
      return Object.freeze({ identity, grantVersion: metadata.grantVersion });
    });
    if (new Set(currentPeers.map(peer => peer.identity.endpointId)).size !== currentPeers.length) throw fail("profile_file_response_invalid");
    for (const rawStatus of response.rows) {
      const raw = wire.exact(rawStatus, ["offer", "signature", "offerHash", "consent", "state", "uploadAttemptedAt", "claimedAt", "current", "uploadOutcome"]), offer = files.parseOffer(raw.offer);
      if (!wire.same(offer.authority, authority)) throw fail("profile_file_scope_changed");
      const own = [offer.source, offer.destination].find(party => party.endpointId === identity.endpointId), opposite = own === offer.source ? offer.destination : offer.source, peer = currentPeers.find(peer => peer.identity.endpointId === opposite.endpointId);
      if (!own || !peer) continue;
      const pins = Object.freeze([{ identity, grantVersion: authority.grantVersion }, peer].sort((left, right) => left.identity.endpointId.localeCompare(right.identity.endpointId)).map(Object.freeze));
      const selected = { ...context, pins }, status = this.#status(raw, selected);
      // HOAI is the current grant authority. Historical, false or unknown
      // current state cannot mint a retained delivery capability.
      if (status.current !== true) continue;
      const record = this.#retain(status.offer, status.signature, selected); record.status = this.#status(raw, selected, record); output.push(Object.freeze({ handle: record.handle, status: record.status, pins }));
    }
    if (new Set(output.map(row => row.status.offer.fileId)).size !== output.length) throw fail("profile_file_response_invalid"); return Object.freeze({ files: Object.freeze(output), peers: Object.freeze(currentPeers), authority });
  }
  #query(context, record, purpose) { const document = { version: 1, kind: "agent-browser-file-" + purpose, fileId: record.offer.fileId, offerHash: files.offerHash(record.offer, record.signature), endpointId: context.endpoint.identity.endpointId, keyFingerprint: require("./crypto").identityFingerprint(context.endpoint.identity), queryNonce: crypto.randomBytes(32).toString("base64url"), expiresAt: this.#clock() + 30_000 }; return { document, signature: documentSignature(context.endpoint, document) }; }
  async #operation(handle, options, purpose) {
    this.#admit(); const context = this.#context(options), record = this.#handle(handle, context), mutating = purpose !== "read";
    if (mutating) {
      this.#effect(record); if (record[purpose + "Attempted"]) throw fail("profile_file_attempt_spent");
      const human = record.offer.direction === "to-agent" ? record.offer.source : record.offer.destination;
      if (purpose === "consent" && (this.principal !== "human" || context.endpoint.identity.endpointId !== human.endpointId || record.status.state !== "offered" || record.status.consent !== null || !["allow_once", "deny"].includes(options.choice)) || purpose === "upload" && (context.endpoint.identity.endpointId !== record.offer.source.endpointId || record.status.state !== "allowed") || purpose === "claim" && (context.endpoint.identity.endpointId !== record.offer.destination.endpointId || record.status.state !== "available") || purpose === "cancel" && (this.principal !== "human" || context.endpoint.identity.endpointId !== human.endpointId || ["claimed", "denied", "cancelled"].includes(record.status.state))) throw fail("profile_file_role_required");
      record[purpose + "Attempted"] = true;
    }
    const base = `profiles/${context.scope.profileId}/files/${record.offer.fileId}`; let body = this.#query(context, record, purpose);
    if (purpose === "consent") { const document = { version: 1, kind: "agent-browser-file-consent", fileId: record.offer.fileId, offerHash: files.offerHash(record.offer, record.signature), endpointId: context.endpoint.identity.endpointId, keyFingerprint: require("./crypto").identityFingerprint(context.endpoint.identity), choice: options.choice, nonce: crypto.randomBytes(32).toString("base64url"), expiresAt: record.offer.expiresAt }; body = { document, signature: documentSignature(context.endpoint, document) }; }
    const raw = await this.#http(context, { route: base + (purpose === "upload" ? "/content" : "/" + purpose), body, ...(purpose === "upload" ? { rawBody: options.payload, expectedBytes: record.offer.ciphertextBytes, expectedHash: record.offer.ciphertextHash } : {}), ...(purpose === "claim" ? { binary: true, expectedBytes: record.offer.ciphertextBytes, expectedHash: record.offer.ciphertextHash } : {}), mutating });
    if (purpose === "claim") return raw; return this.#status(raw, context, record);
  }
  read(handle, options) { return this.#operation(handle, options, "read"); }
  consent(handle, options) { return this.#operation(handle, options, "consent"); }
  upload(handle, options) { return this.#operation(handle, options, "upload"); }
  claim(handle, options) { return this.#operation(handle, options, "claim"); }
  cancel(handle, options) { return this.#operation(handle, options, "cancel"); }
  metadata(handle) { const record = this.#handles.get(handle); if (!record || this.#records.get(record.offer.fileId) !== record) throw fail("profile_file_handle_required"); return Object.freeze({ offer: record.offer, signature: record.signature, status: record.status }); }
  activity() { return Object.freeze({ pendingPhysicalOperations: this.#pending ? 1 : 0, cleanupUnknown: this.#cleanupUnknown }); }
  cancelPending() { for (const abort of this.#controllers) abort(); }
  async whenDrained() { await this.#pending?.catch(() => {}); if (this.#cleanupUnknown) throw fail("profile_file_cleanup_unconfirmed"); }
  dispose() { this.#closed = true; this.cancelPending(); return this.whenDrained(); }
}
module.exports = { ProfileFileClient };
