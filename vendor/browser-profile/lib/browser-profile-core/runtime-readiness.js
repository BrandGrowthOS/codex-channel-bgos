"use strict";

// Main only. A validated response is historical metadata. It is never a fresh
// grant, live writer authority, proof of an inactive browser, or activation.
// The peer identity must come from the locally approved pin, not this response.
const { createHash, createPublicKey, verify } = require("node:crypto");
const { canonical } = require("./coordinator-client");
const { identityFingerprint } = require("./crypto");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/, HASH = /^[a-f0-9]{64}$/;
const EXPECTED = ["actingUserId", "assistantId", "profileId", "requestId", "purpose", "expectedWriterEpoch", "expectedRevision", "expectedHeadManifestHash", "contentKeyEpoch"];
const REQUEST = ["version", "kind", "requestId", "endpointId", "purpose", "expectedWriterEpoch", "expectedRevision", "expectedHeadManifestHash", "profileId", "actingUserId", "assistantId", "endpointOwnerUserId", "pairingId", "nonce", "expiresAt", "grantVersion", "keyFingerprint", "contentKeyEpoch"];
const TUPLE = ["bootId", "runtimeId", "sessionId"];
const DESTINATION = ["endpointId", ...TUPLE, "grantVersion", "keyFingerprint"];
const AUTHORITY = ["profileId", "actingUserId", "assistantId", "endpointId", ...TUPLE, "writerEpoch", "revision", "contentKeyEpoch", "grantVersion", "keyFingerprint"];
const validated = new WeakSet();
const fail = (code = "profile_runtime_request_invalid") => Object.assign(new Error(code), { code });
const isId = value => typeof value === "string" && ID.test(value);
const isUuid = value => typeof value === "string" && UUID.test(value);
const isHash = value => typeof value === "string" && HASH.test(value);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const equal = (a, b) => canonical(a).equals(canonical(b));
const hasFormat = value => !!value && typeof value === "object" && Object.hasOwn(value, "schemaVersion");
const formatFields = (value, fields) => hasFormat(value) ? [...fields, "schemaVersion", "sourceEndpoint"] : fields;
function exact(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== fields.length) throw fail();
  for (const key of fields) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw fail(); }
}
function sourceEndpoint(value, actor) {
  exact(value, ["kind", "ownerUserId", "pairingId", "identity", "keyFingerprint", "grantVersion"]);
  exact(value.identity, ["version", "endpointId", "signingPublicKey", "encryptionPublicKey"]);
  if (value.kind !== "desktop" || value.ownerUserId !== actor || value.pairingId !== null || !isUuid(value.identity.endpointId) ||
      !positive(value.grantVersion) || !isHash(value.keyFingerprint) || identityFingerprint(value.identity) !== value.keyFingerprint) throw fail();
}
function signatureValid(document, signature, publicKey) {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  const bytes = Buffer.from(signature, "base64url");
  return bytes.length === 64 && bytes.toString("base64url") === signature && verify(null, canonical(document), publicKey, bytes);
}
function startDocument(request, ready) {
  return { version: 1, kind: "session-start", profileId: request.profileId, actingUserId: request.actingUserId, assistantId: request.assistantId,
    endpointId: request.endpointId, bootId: ready.bootId, runtimeId: ready.runtimeId, sessionId: ready.sessionId,
    expectedWriterEpoch: request.expectedWriterEpoch, expectedRevision: request.expectedRevision, grantVersion: request.grantVersion, keyFingerprint: request.keyFingerprint };
}
function validateInputs(expected, peer, now) {
  exact(expected, formatFields(expected, EXPECTED)); exact(peer, ["identity", "keyFingerprint", "ownerUserId", "pairingId", "grantVersion"]);
  exact(peer.identity, ["version", "endpointId", "signingPublicKey", "encryptionPublicKey"]);
  if (!isId(expected.actingUserId) || !positive(expected.assistantId) || ![expected.profileId, expected.requestId, peer.identity.endpointId].every(isUuid) ||
      !["start", "receive-transfer"].includes(expected.purpose) || hasFormat(expected) && (expected.schemaVersion !== 2 || expected.purpose !== "receive-transfer") || ![expected.expectedWriterEpoch, expected.expectedRevision].every(nonnegative) ||
      !(expected.expectedHeadManifestHash === null || isHash(expected.expectedHeadManifestHash)) || !positive(expected.contentKeyEpoch) ||
      !isId(peer.ownerUserId) || !positive(peer.pairingId) || !positive(peer.grantVersion) || !isHash(peer.keyFingerprint) ||
      identityFingerprint(peer.identity) !== peer.keyFingerprint || !nonnegative(now)) throw fail();
  if (hasFormat(expected)) { sourceEndpoint(expected.sourceEndpoint, expected.actingUserId); if (expected.sourceEndpoint.identity.endpointId === peer.identity.endpointId) throw fail(); }
  return createPublicKey({ key: Buffer.from(peer.identity.signingPublicKey, "base64url"), type: "spki", format: "der" });
}
function parseStatus(raw, expected, peer, publicKey, now) {
  exact(raw, ["request", "state", "ready", "confirmation"]); const requestFields = formatFields(expected, REQUEST); exact(raw.request, requestFields);
  const request = raw.request;
  if (hasFormat(expected)) { sourceEndpoint(request.sourceEndpoint, expected.actingUserId); if (!equal(request.sourceEndpoint, expected.sourceEndpoint)) throw fail(); }
  if (request.version !== (hasFormat(expected) ? 2 : 1) || request.kind !== "agent-runtime-request" || formatFields(expected, EXPECTED).filter(key => key !== "sourceEndpoint").some(key => request[key] !== expected[key]) ||
      request.endpointId !== peer.identity.endpointId || request.endpointOwnerUserId !== peer.ownerUserId || request.pairingId !== peer.pairingId ||
      request.grantVersion !== peer.grantVersion || request.keyFingerprint !== peer.keyFingerprint || !isHash(request.nonce) ||
      !positive(request.expiresAt) || request.expiresAt > now + 305000 || !["pending", "ready", "confirmed", "expired"].includes(raw.state)) throw fail();
  if (raw.ready === null) {
    if (!["pending", "expired"].includes(raw.state) || raw.confirmation !== null) throw fail();
  } else {
    const ready = raw.ready; exact(ready, ["document", "signature", "startSignature", "readyHash"]); exact(ready.document, [...requestFields, ...TUPLE]);
    if (hasFormat(expected)) { sourceEndpoint(ready.document.sourceEndpoint, expected.actingUserId); if (!equal(ready.document.sourceEndpoint, expected.sourceEndpoint)) throw fail(); }
    if (ready.document.kind !== "agent-runtime-ready" || requestFields.filter(key => key !== "kind" && key !== "sourceEndpoint").some(key => ready.document[key] !== request[key]) ||
        !TUPLE.every(key => isId(ready.document[key])) || !signatureValid(ready.document, ready.signature, publicKey) || !isHash(ready.readyHash)) throw fail();
    if (request.purpose === "start") {
      if (!signatureValid(startDocument(request, ready.document), ready.startSignature, publicKey)) throw fail();
    } else if (ready.startSignature !== null) throw fail();
    if (createHash("sha256").update(canonical({ document: ready.document, signature: ready.signature, startSignature: ready.startSignature })).digest("hex") !== ready.readyHash || raw.state === "pending") throw fail();
  }
  if (raw.state === "confirmed") {
    if (!raw.ready) throw fail();
    const destination = Object.fromEntries(DESTINATION.map(key => [key, raw.ready.document[key]]));
    if (request.purpose === "start") {
      exact(raw.confirmation, ["authority"]); exact(raw.confirmation.authority, AUTHORITY);
      const authority = { ...destination, profileId: request.profileId, actingUserId: request.actingUserId, assistantId: request.assistantId,
        writerEpoch: request.expectedWriterEpoch + 1, revision: request.expectedRevision, contentKeyEpoch: request.contentKeyEpoch };
      if (!positive(authority.writerEpoch) || AUTHORITY.some(key => raw.confirmation.authority[key] !== authority[key])) throw fail();
    } else { exact(raw.confirmation, ["destination"]); exact(raw.confirmation.destination, DESTINATION); if (DESTINATION.some(key => raw.confirmation.destination[key] !== destination[key])) throw fail(); }
  } else if (raw.confirmation !== null) throw fail();
}
const freeze = value => { if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
function validateRuntimeRequestStatus(raw, expected, peer, previous = null, now = Date.now()) {
  try {
    const publicKey = validateInputs(expected, peer, now); parseStatus(raw, expected, peer, publicKey, now);
    if (previous !== null) {
      parseStatus(previous, expected, peer, publicKey, now);
      if (!equal(previous.request, raw.request) || previous.ready && !equal(previous.ready, raw.ready) ||
          previous.state === "confirmed" && (raw.state !== "confirmed" || !equal(previous.confirmation, raw.confirmation)) ||
          previous.state === "expired" && raw.state !== "expired") throw fail();
    }
    const status = freeze(structuredClone(raw)); validated.add(status); return status;
  } catch { throw fail(); }
}
function assertRuntimeRequestCurrent(status, now = Date.now()) {
  if (!validated.has(status) || !nonnegative(now)) throw fail();
  if (status.state === "expired" || status.request.expiresAt <= now) throw fail("profile_runtime_request_expired");
  return status;
}
module.exports = { validateRuntimeRequestStatus, assertRuntimeRequestCurrent };
