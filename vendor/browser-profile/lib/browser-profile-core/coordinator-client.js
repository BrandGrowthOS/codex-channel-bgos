"use strict";

// Main/daemon-only HTTP door. Renderer notifications are hints, never command
// authority. Every request uses a fresh principal capability and a fixed HOAI
// route. A failed write is never retried automatically.
const { createHash, sign } = require("node:crypto");
const { identityFingerprint } = require("./crypto");
const META_BYTES = 64 * 1024, CAPSULE_BYTES = 32 * 1024 * 1024 + 16 * 1024;
const AUTHORITY_KEYS = ["profileId", "actingUserId", "assistantId", "endpointId", "bootId", "runtimeId", "sessionId", "writerEpoch", "revision", "contentKeyEpoch", "grantVersion", "keyFingerprint"];
const COUNTERS = new Set(["assistantId", "writerEpoch", "revision", "contentKeyEpoch", "grantVersion"]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const fail = (code, statusCode) => Object.assign(new Error(code), { code, ...(statusCode ? { statusCode } : {}) });
function canonical(value) {
  const sorted = row => Array.isArray(row) ? row.map(sorted) : row && typeof row === "object" ? Object.fromEntries(Object.keys(row).sort().map(key => [key, sorted(row[key])])) : row;
  return Buffer.from(JSON.stringify(sorted(value)), "utf8");
}
function documentSignature(endpoint, document) { return sign(null, canonical(document), endpoint.signingPrivateKey).toString("base64url"); }
function exactAuthority(value) {
  if (!value || Object.keys(value).length !== AUTHORITY_KEYS.length || AUTHORITY_KEYS.some(key =>
    COUNTERS.has(key) ? !Number.isSafeInteger(value[key]) || value[key] < (key === "revision" ? 0 : 1) :
      typeof value[key] !== "string" || !ID.test(value[key])) || !UUID.test(value.profileId) || !UUID.test(value.endpointId) || !/^[a-f0-9]{64}$/.test(value.keyFingerprint)) throw fail("profile_runtime_authority_invalid");
  return Object.freeze(Object.fromEntries(AUTHORITY_KEYS.map(key => [key, value[key]])));
}
function scopeOf(scope) {
  if (!scope || typeof scope.actingUserId !== "string" || !ID.test(scope.actingUserId) || !Number.isSafeInteger(scope.assistantId) || scope.assistantId < 1) throw fail("profile_sync_scope_invalid");
  return Object.freeze({ actingUserId: scope.actingUserId, assistantId: scope.assistantId });
}
function sameAuthority(a, b) { return AUTHORITY_KEYS.every(key => a?.[key] === b?.[key]) && Object.keys(a || {}).length === AUTHORITY_KEYS.length && Object.keys(b || {}).length === AUTHORITY_KEYS.length; }
function identifier(value) { if (typeof value !== "string" || !UUID.test(value)) throw fail("profile_sync_identifier_invalid"); return value; }
function exactRuntimeRequestData(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== fields.length || fields.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value");
  })) throw fail("profile_sync_runtime_request_invalid");
}

class ProfileCoordinatorClient {
  constructor({ endpoint, authorize, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)) || typeof authorize !== "function" || typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw fail("profile_sync_configuration_invalid");
    this.origin = url.origin; this.authorize = authorize; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async _request(method, route, body, rawScope, maxResponse = META_BYTES) {
    const scope = scopeOf(rawScope), proof = await this.authorize(scope);
    if (!proof || typeof proof.assertCurrent !== "function" || typeof proof.token !== "string" || !proof.token || proof.token.length > 16384 || /\s/.test(proof.token)) throw fail("profile_sync_sign_in_required");
    const check = () => {
      const current = proof.assertCurrent();
      if (current?.then) { void Promise.resolve(current).catch(() => {}); throw fail("profile_sync_context_changed"); }
      if (current === false) throw fail("profile_sync_context_changed");
    };
    check();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let dispatched = false;
    try {
      const bytes = body === undefined ? undefined : JSON.stringify(body);
      if (bytes !== undefined && Buffer.byteLength(bytes) > (route.endsWith("/checkpoint") ? CAPSULE_BYTES : route.endsWith("/result") ? 11 * 1024 * 1024 + 16 * 1024 : META_BYTES)) throw fail("profile_sync_request_too_large");
      const url = new URL(`/api/v1/browser/profile-sync/${route}`, this.origin);
      check(); dispatched = true;
      const response = await this.fetchImpl(url.href, { method, headers: { Authorization: `Bearer ${proof.token}`, Accept: "application/json", "Accept-Encoding": "identity", ...(bytes === undefined ? {} : { "Content-Type": "application/json" }) },
        body: bytes, credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal });
      check();
      if (!response || !Number.isInteger(response.status) || !response.body?.getReader) throw fail("profile_sync_response_invalid");
      const reader = response.body.getReader(), chunks = []; let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); check(); if (done) break;
          if (!(value instanceof Uint8Array) || (length += value.byteLength) > maxResponse) { await reader.cancel(); throw fail("profile_sync_response_too_large"); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      check();
      let result;
      try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw fail("profile_sync_response_invalid"); }
      if (response.status < 200 || response.status >= 300) {
        const reason = typeof result?.code === "string" && /^[a-z][a-z0-9_]{1,79}$/.test(result.code) ? result.code : "profile_sync_request_refused";
        throw fail(reason, response.status);
      }
      if (!result || typeof result !== "object" || Array.isArray(result)) throw fail("profile_sync_response_invalid");
      return result;
    } catch (error) {
      check();
      if (error?.code?.startsWith("profile_") || error?.statusCode) throw error;
      throw fail(dispatched && method === "POST" ? "profile_sync_outcome_unknown" : "profile_sync_connection_unavailable");
    } finally { clearTimeout(timer); controller.abort(); }
  }
  context(scope) { const current = scopeOf(scope); return this._request("GET", `agents/${current.assistantId}/context`, undefined, current); }
  pendingRuntimePermissions(scope) { const current = scopeOf(scope); return this._request("GET", `runtime/permissions/pending/${current.assistantId}`, undefined, current); }
  runtimePermission(scope, gateId) { return this._request("GET", `runtime/permissions/${identifier(gateId)}`, undefined, scope); }
  answerRuntimePermission(scope, gateId, reviewed) {
    const current = scopeOf(scope); exactRuntimeRequestData(reviewed, ["authority", "requestNonce", "actionHash", "choice"]);
    exactRuntimeRequestData(reviewed.authority, AUTHORITY_KEYS); const authority = exactAuthority(reviewed.authority);
    if (authority.actingUserId !== current.actingUserId || authority.assistantId !== current.assistantId || typeof reviewed.requestNonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(reviewed.requestNonce) ||
        typeof reviewed.actionHash !== "string" || !/^[a-f0-9]{64}$/.test(reviewed.actionHash) || !["allow_once", "deny"].includes(reviewed.choice)) throw fail("profile_sync_permission_invalid");
    return this._request("POST", `runtime/permissions/${identifier(gateId)}/answer`, { authority, requestNonce: reviewed.requestNonce, actionHash: reviewed.actionHash, choice: reviewed.choice }, current);
  }
  endpointMetadata(scope, endpointId) { return this._request("GET", `endpoints/${identifier(endpointId)}`, undefined, scope); }
  create(scope) { return this._request("POST", "profiles", { assistantId: scopeOf(scope).assistantId }, scope); }
  read(scope, profileId) { return this._request("GET", `profiles/${identifier(profileId)}`, undefined, scope); }
  createReturnIntent(scope, profileId, endpoint, rawRequest) {
    const request = require("./return-intent").validateReturnIntentDocument(rawRequest), current = scopeOf(scope);
    if (request.sourceAuthority.profileId !== identifier(profileId) || request.sourceAuthority.actingUserId !== current.actingUserId || request.sourceAuthority.assistantId !== current.assistantId ||
        endpoint?.identity?.endpointId !== request.destination.endpointId || identityFingerprint(endpoint.identity) !== request.destination.keyFingerprint) throw fail("profile_sync_return_invalid");
    return this._request("POST", `profiles/${profileId}/return-intents`, { request, signature: documentSignature(endpoint, request) }, current);
  }
  returnIntent(scope, profileId, requestId) { return this._request("GET", `profiles/${identifier(profileId)}/return-intents/${identifier(requestId)}`, undefined, scope); }
  transition(scope, profileId, transitionId) { return this._request("GET", `profiles/${identifier(profileId)}/transfers/${identifier(transitionId)}`, undefined, scope); }
  quota(scope, profileId) { return this._request("GET", `profiles/${identifier(profileId)}/quota`, undefined, scope); }
  endpoints(scope, profileId, { after } = {}) {
    return this._request("GET", `profiles/${identifier(profileId)}/endpoints${after === undefined ? "" : `?after=${identifier(after)}`}`, undefined, scope);
  }
  retention(scope, profileId) { return this._request("GET", `profiles/${identifier(profileId)}/retention`, undefined, scope); }
  prune(scope, profileId, receipt, signature) {
    // The trusted retention workflow signs only after durable journal readback.
    // This HTTP door does not infer that proof from an advisory server head.
    return this._request("POST", `profiles/${identifier(profileId)}/checkpoints/prune`, { receipt, signature }, scope);
  }
  revoke(scope, profileId, endpointId) { return this._request("POST", `profiles/${identifier(profileId)}/grants/${identifier(endpointId)}/revoke`, {}, scope); }
  createEndpointOffer(scope, profileId, intentId) {
    if (typeof intentId !== "string" || !UUID.test(intentId)) throw fail("profile_sync_offer_invalid");
    return this._request("POST", `profiles/${identifier(profileId)}/endpoint-offers`, { intentId }, scope);
  }
  endpointOffer(scope, profileId, intentId) {
    if (typeof intentId !== "string" || !UUID.test(intentId)) throw fail("profile_sync_offer_invalid");
    return this._request("GET", `profiles/${identifier(profileId)}/endpoint-offers/${intentId}`, undefined, scope);
  }
  acceptEndpointOffer(scope, profileId, intentId, reviewed) {
    if (typeof intentId !== "string" || !UUID.test(intentId) || !reviewed || Object.keys(reviewed).length !== 2 ||
        !["offerHash", "keyFingerprint"].every(key => Object.hasOwn(reviewed, key) && typeof reviewed[key] === "string" && /^[a-f0-9]{64}$/.test(reviewed[key]))) throw fail("profile_sync_offer_invalid");
    return this._request("POST", `profiles/${identifier(profileId)}/endpoint-offers/${intentId}/accept`, { offerHash: reviewed.offerHash, keyFingerprint: reviewed.keyFingerprint }, scope);
  }
  createRuntimeRequest(scope, profileId, input) {
    const formatted = !!input && typeof input === "object" && Object.hasOwn(input, "schemaVersion");
    const fields = ["requestId", "endpointId", "purpose", "expectedWriterEpoch", "expectedRevision", "expectedHeadManifestHash", ...(formatted ? ["schemaVersion"] : [])];
    exactRuntimeRequestData(input, fields);
    if (![input.requestId, input.endpointId].every(value => typeof value === "string" && UUID.test(value)) || !["start", "receive-transfer"].includes(input.purpose) ||
        formatted && (input.schemaVersion !== 2 || input.purpose !== "receive-transfer") ||
        ![input.expectedWriterEpoch, input.expectedRevision].every(value => Number.isSafeInteger(value) && value >= 0) ||
        !(input.expectedHeadManifestHash === null || typeof input.expectedHeadManifestHash === "string" && /^[a-f0-9]{64}$/.test(input.expectedHeadManifestHash))) throw fail("profile_sync_runtime_request_invalid");
    const body = Object.fromEntries(fields.map(key => [key, input[key]]));
    return this._request("POST", `profiles/${identifier(profileId)}/runtime-requests`, body, scope);
  }
  runtimeRequest(scope, profileId, requestId) {
    return this._request("GET", `profiles/${identifier(profileId)}/runtime-requests/${identifier(requestId)}`, undefined, scope);
  }
  confirmRuntimeRequest(scope, profileId, requestId, reviewed) {
    exactRuntimeRequestData(reviewed, ["readyHash"]);
    if (typeof reviewed.readyHash !== "string" || !/^[a-f0-9]{64}$/.test(reviewed.readyHash)) throw fail("profile_sync_runtime_request_invalid");
    return this._request("POST", `profiles/${identifier(profileId)}/runtime-requests/${identifier(requestId)}/confirm`, { readyHash: reviewed.readyHash }, scope);
  }
  enrollDesktop(scope, endpoint, label) {
    const current = scopeOf(scope), identity = endpoint?.identity;
    identityFingerprint(identity); identifier(identity.endpointId);
    if (typeof label !== "string" || !label.trim() || label.length > 60) throw fail("profile_sync_endpoint_label_invalid");
    const document = { version: 1, kind: "endpoint-enrollment", endpointId: identity.endpointId, ownerUserId: current.actingUserId, endpointKind: "desktop", pairingId: null, signingPublicKey: identity.signingPublicKey, encryptionPublicKey: identity.encryptionPublicKey };
    return this._request("POST", "endpoints", { endpointId: identity.endpointId, kind: "desktop", label: label.trim(), signingPublicKey: identity.signingPublicKey, encryptionPublicKey: identity.encryptionPublicKey, signature: documentSignature(endpoint, document) }, current);
  }
  grant(scope, profileId, { endpointId, keyFingerprint, backgroundUse }) {
    if (!/^[a-f0-9]{64}$/.test(keyFingerprint) || typeof backgroundUse !== "boolean") throw fail("profile_sync_grant_invalid");
    return this._request("POST", `profiles/${identifier(profileId)}/grants`, { endpointId: identifier(endpointId), keyFingerprint, backgroundUse }, scope);
  }
  start(scope, profile, endpoint, grant, { bootId, runtimeId, sessionId }) {
    const current = scopeOf(scope), profileId = identifier(profile?.id), endpointId = identifier(endpoint?.identity?.endpointId), fingerprint = identityFingerprint(endpoint.identity);
    if (profile.actingUserId !== current.actingUserId || profile.assistantId !== current.assistantId || profile.writerState !== "idle" || !Number.isSafeInteger(profile.writerEpoch) || profile.writerEpoch < 0 || !Number.isSafeInteger(profile.revision) || profile.revision < 0 || grant?.profileId !== profileId || grant.endpointId !== endpointId || !Number.isSafeInteger(grant.generation) || grant.generation < 1 || grant.revokedAt || [bootId, runtimeId, sessionId].some(value => typeof value !== "string" || !ID.test(value) || value.length > 128)) throw fail("profile_sync_start_invalid");
    const body = { endpointId, bootId, runtimeId, sessionId, expectedWriterEpoch: profile.writerEpoch, expectedRevision: profile.revision };
    const document = { version: 1, kind: "session-start", profileId, actingUserId: current.actingUserId, assistantId: current.assistantId, ...body, grantVersion: grant.generation, keyFingerprint: fingerprint };
    return this._request("POST", `profiles/${profileId}/session`, { ...body, signature: documentSignature(endpoint, document) }, current).then(value => {
      const authority = exactAuthority(value);
      if (authority.profileId !== profileId || authority.actingUserId !== current.actingUserId || authority.assistantId !== current.assistantId || authority.endpointId !== endpointId || authority.bootId !== bootId || authority.runtimeId !== runtimeId || authority.sessionId !== sessionId || authority.writerEpoch !== profile.writerEpoch + 1 || authority.revision !== profile.revision || authority.contentKeyEpoch !== profile.contentKeyEpoch || authority.grantVersion !== grant.generation || authority.keyFingerprint !== fingerprint) throw fail("profile_sync_authority_mismatch");
      return authority;
    });
  }
  begin(scope, profileId, transfer) { return this._request("POST", `profiles/${identifier(profileId)}/transfers`, transfer, scope); }
  prepareStoppedHeadReaddress(scope, profileId, endpoint, request) {
    const current = scopeOf(scope), id = identifier(profileId);
    if (!request || Object.keys(request).length !== 7 || !["transitionId", "expectedTransitionId", "manifestHash", "expectedRevision", "expectedWriterEpoch", "expectedKeyEpoch", "destination"].every(key => Object.hasOwn(request, key)) ||
        !/^[a-f0-9]{64}$/.test(request.manifestHash) || [request.expectedRevision, request.expectedWriterEpoch, request.expectedKeyEpoch].some(value => !Number.isSafeInteger(value) || value < 1)) throw fail("profile_sync_readdress_invalid");
    const destination = request.destination;
    if (!destination || Object.keys(destination).length !== 6 || !["endpointId", "bootId", "runtimeId", "sessionId", "grantVersion", "keyFingerprint"].every(key => Object.hasOwn(destination, key)) ||
        identifier(destination.endpointId) !== endpoint?.identity?.endpointId || identityFingerprint(endpoint.identity) !== destination.keyFingerprint ||
        !Number.isSafeInteger(destination.grantVersion) || destination.grantVersion < 1 || [destination.bootId, destination.runtimeId, destination.sessionId].some(value => typeof value !== "string" || !ID.test(value) || value.length > 128)) throw fail("profile_sync_readdress_invalid");
    const body = { transitionId: identifier(request.transitionId), expectedTransitionId: identifier(request.expectedTransitionId), manifestHash: request.manifestHash,
      expectedRevision: request.expectedRevision, expectedWriterEpoch: request.expectedWriterEpoch, expectedKeyEpoch: request.expectedKeyEpoch, destination: Object.freeze({ ...destination }) };
    const document = Object.freeze({ version: 1, kind: "stopped-head-readdress", profileId: id, ...current, ...body });
    return Object.freeze({ document, body: Object.freeze({ ...body, signature: documentSignature(endpoint, document) }) });
  }
  readdressStopped(scope, profileId, endpoint, request) {
    const prepared = this.prepareStoppedHeadReaddress(scope, profileId, endpoint, request);
    return this._request("POST", `profiles/${identifier(profileId)}/stopped-head/readdress`, prepared.body, scope);
  }
  commit(scope, transitionId, checkpoint) { return this._request("POST", `transfers/${identifier(transitionId)}/checkpoint`, checkpoint, scope); }
  capsule(scope, transitionId, signature) { return this._request("POST", `transfers/${identifier(transitionId)}/capsule`, { signature }, scope, CAPSULE_BYTES); }
  staged(scope, transitionId, receipt, signature) { return this._request("POST", `transfers/${identifier(transitionId)}/staged`, { receipt, signature }, scope); }
  activate(scope, transitionId, expectedWriterEpoch, manifestHash) { return this._request("POST", `transfers/${identifier(transitionId)}/activate`, { expectedWriterEpoch, manifestHash }, scope); }
  dispatch(authority, endpoint, { rpcId, rpcNonce, socketId }) {
    const current = exactAuthority(authority);
    if (identityFingerprint(endpoint.identity) !== current.keyFingerprint || endpoint.identity.endpointId !== current.endpointId || typeof rpcNonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(rpcNonce) || typeof socketId !== "string" || !ID.test(socketId)) throw fail("profile_runtime_dispatch_invalid");
    const document = { version: 1, kind: "runtime-rpc-dispatch", rpcId: identifier(rpcId), rpcNonce, socketId, authority: current };
    return this._request("POST", `rpc/${document.rpcId}/dispatch`, { socketId, rpcNonce, authority: current, signature: documentSignature(endpoint, document) }, current, 256 * 1024 + 16 * 1024);
  }
  cancellation(authority, endpoint, { rpcId, rpcNonce, socketId }) {
    const current = exactAuthority(authority);
    if (identityFingerprint(endpoint.identity) !== current.keyFingerprint || endpoint.identity.endpointId !== current.endpointId || typeof rpcNonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(rpcNonce) || typeof socketId !== "string" || !ID.test(socketId)) throw fail("profile_runtime_cancellation_invalid");
    const document = { version: 1, kind: "runtime-rpc-cancellation", rpcId: identifier(rpcId), rpcNonce, socketId, authority: current };
    return this._request("POST", `rpc/${document.rpcId}/cancellation`, { socketId, rpcNonce, authority: current, signature: documentSignature(endpoint, document) }, current);
  }
  result(authority, endpoint, { rpcId, rpcNonce, socketId, payload }) {
    const current = exactAuthority(authority), bytes = canonical(payload);
    if (bytes.length > 8 * 1024 * 1024 || identityFingerprint(endpoint.identity) !== current.keyFingerprint || endpoint.identity.endpointId !== current.endpointId || typeof rpcNonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(rpcNonce) || typeof socketId !== "string" || !ID.test(socketId)) throw fail("profile_runtime_result_invalid");
    const document = { version: 1, kind: "runtime-rpc-result", rpcId: identifier(rpcId), rpcNonce, socketId, authority: current, payloadHash: createHash("sha256").update(bytes).digest("hex") };
    return this._request("POST", `rpc/${document.rpcId}/result`, { socketId, rpcNonce, authority: current, payload: bytes.toString("base64"), signature: documentSignature(endpoint, document) }, current);
  }
}
module.exports = { ProfileCoordinatorClient, exactAuthority, sameAuthority, documentSignature, canonical, META_BYTES, CAPSULE_BYTES };
