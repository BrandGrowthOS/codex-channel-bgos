"use strict";

// Main/daemon only. A signed intent is a human-selected destination, never a
// live grant or permission to skip local source-stop and activation checks.
const { createHash, createPublicKey, verify } = require("node:crypto");
const { canonical } = require("./coordinator-client");
const { identityFingerprint } = require("./crypto");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/, HASH = /^[a-f0-9]{64}$/;
const TUPLE = ["bootId", "runtimeId", "sessionId"];
const SOURCE = ["endpointId", ...TUPLE, "writerEpoch"];
const DESTINATION = ["endpointId", ...TUPLE, "grantVersion", "keyFingerprint"];
const AUTHORITY = ["profileId", "actingUserId", "assistantId", ...SOURCE, "revision", "contentKeyEpoch", "grantVersion", "keyFingerprint"];
const REQUEST = ["version", "kind", "requestId", "nonce", "sourceAuthority", "destination", "expectedHeadManifestHash", "expiresAt"];
const STATUS = ["request", "signature", "intentHash", "state", "manifestHash", "writeConsumed", "transitionPhase", "sourceStopped"];
const STATES = ["pending", "expired", "outcome-unknown", "quiescing", "checkpoint-committed", "staged", "activated", "recovery-required"];
const PHASES = ["awaiting_source", "checkpoint_committed", "staged", "activated", "superseded"];
const STOPPED = ["version", "kind", "profileId", "transitionId", "manifestHash", "revision", "source", "stopped"];
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const isUuid = value => typeof value === "string" && UUID.test(value);
const isHash = value => typeof value === "string" && HASH.test(value);
const isId = value => typeof value === "string" && ID.test(value);
const equal = (a, b) => canonical(a).equals(canonical(b));
const fail = (code = "profile_return_intent_invalid") => Object.assign(new Error(code), { code });
const freeze = value => { if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
function exact(value, fields) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== fields.length) throw fail();
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw fail();
  }
}
function binary(value, size) {
  if (typeof value !== "string" || !new RegExp(`^[A-Za-z0-9_-]{${Math.ceil(size * 4 / 3)}}$`).test(value)) throw fail();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== size || bytes.toString("base64url") !== value) throw fail();
  return bytes;
}
function authority(value) {
  exact(value, AUTHORITY);
  if (![value.profileId, value.endpointId].every(isUuid) || !isId(value.actingUserId) || !TUPLE.every(key => isId(value[key])) ||
      ![value.assistantId, value.writerEpoch, value.contentKeyEpoch, value.grantVersion].every(positive) || !nonnegative(value.revision) || !isHash(value.keyFingerprint)) throw fail();
  return value;
}
function destination(value) {
  exact(value, DESTINATION);
  if (!isUuid(value.endpointId) || !TUPLE.every(key => isId(value[key])) || !positive(value.grantVersion) || !isHash(value.keyFingerprint)) throw fail();
  return value;
}
function request(value) {
  const formatted = !!value && typeof value === "object" && Object.hasOwn(value, "schemaVersion");
  exact(value, formatted ? [...REQUEST, "schemaVersion"] : REQUEST);
  if (value.version !== (formatted ? 2 : 1) || formatted && value.schemaVersion !== 2 || value.kind !== "agent-browser-return-intent" || !isUuid(value.requestId) || !positive(value.expiresAt) ||
      !(value.expectedHeadManifestHash === null || isHash(value.expectedHeadManifestHash))) throw fail();
  binary(value.nonce, 32); authority(value.sourceAuthority); destination(value.destination);
  if ((value.sourceAuthority.revision === 0) !== (value.expectedHeadManifestHash === null)) throw fail();
  if (value.sourceAuthority.endpointId === value.destination.endpointId || TUPLE.some(key => value.sourceAuthority[key] === value.destination[key])) throw fail();
  return value;
}
function stopped(value, intent, manifestHash) {
  exact(value, ["receipt", "signature"]); exact(value.receipt, STOPPED); exact(value.receipt.source, SOURCE);
  const receipt = value.receipt, source = intent.sourceAuthority;
  if (receipt.version !== 1 || receipt.kind !== "source-stopped" || receipt.stopped !== true || receipt.profileId !== source.profileId ||
      receipt.transitionId !== intent.requestId || receipt.manifestHash !== manifestHash || receipt.revision !== source.revision + 1 ||
      !positive(receipt.revision) || SOURCE.some(key => receipt.source[key] !== source[key])) throw fail();
  binary(value.signature, 64); return value;
}
function status(value) {
  exact(value, STATUS); request(value.request); binary(value.signature, 64);
  if (!isHash(value.intentHash) || !STATES.includes(value.state) || !(value.manifestHash === null || isHash(value.manifestHash)) ||
      ![true, false, null].includes(value.writeConsumed) || !(value.transitionPhase === null || PHASES.includes(value.transitionPhase))) throw fail();
  if (["pending", "expired"].includes(value.state) && (value.writeConsumed !== false || value.manifestHash !== null || value.transitionPhase !== null)) throw fail();
  if (value.state === "outcome-unknown" && (value.writeConsumed === false || value.transitionPhase !== null)) throw fail();
  const expectedPhase = { quiescing: "awaiting_source", "checkpoint-committed": "checkpoint_committed", staged: "staged", activated: "activated" }[value.state];
  if (expectedPhase && (value.writeConsumed !== true || !isHash(value.manifestHash) || value.transitionPhase !== expectedPhase)) throw fail();
  if (value.state === "recovery-required" && (value.writeConsumed === null || value.writeConsumed === false && value.manifestHash !== null)) throw fail();
  if (value.sourceStopped !== null) {
    if (!["checkpoint-committed", "staged", "activated"].includes(value.state)) throw fail();
    stopped(value.sourceStopped, value.request, value.manifestHash);
  }
  if (returnIntentHash({ request: value.request, signature: value.signature }) !== value.intentHash) throw fail();
  return value;
}
function signingKey(identity) {
  exact(identity, ["version", "endpointId", "signingPublicKey", "encryptionPublicKey"]);
  const fingerprint = identityFingerprint(identity);
  return { fingerprint, key: createPublicKey({ key: Buffer.from(identity.signingPublicKey, "base64url"), type: "spki", format: "der" }) };
}
function signed(document, signature, key) { return verify(null, canonical(document), key, binary(signature, 64)); }
function validateReturnIntentDocument(value) { try { request(value); return freeze(structuredClone(value)); } catch { throw fail(); } }
function returnIntentHash(value) {
  try { exact(value, ["request", "signature"]); request(value.request); binary(value.signature, 64); return createHash("sha256").update(canonical(value)).digest("hex"); }
  catch { throw fail(); }
}
function validateReturnIntentStatus(value) { try { status(value); return freeze(structuredClone(value)); } catch { throw fail(); } }
function returnQueryDocument(value, read = false) {
  try {
    exact(value, ["endpointId", "keyFingerprint", "queryNonce", "expiresAt", ...(read ? ["requestId"] : [])]);
    if (typeof read !== "boolean" || !isUuid(value.endpointId) || !isHash(value.keyFingerprint) || !positive(value.expiresAt) || read && !isUuid(value.requestId)) throw fail();
    binary(value.queryNonce, 32);
    return freeze({ version: 1, kind: read ? "agent-browser-return-read" : "agent-browser-return-pending", ...structuredClone(value) });
  } catch { throw fail(); }
}
function returnCheckpointDocument(value) {
  try {
    exact(value, ["requestId", "intentHash", "authority", "manifestHash"]);
    if (!isUuid(value.requestId) || !isHash(value.intentHash) || !isHash(value.manifestHash)) throw fail(); authority(value.authority);
    return freeze({ version: 1, kind: "agent-browser-return-checkpoint", ...structuredClone(value) });
  } catch { throw fail(); }
}
function verifyReturnIntentStatus({ status: raw, sourceAuthority, destinationIdentity, sourceIdentity, now = Date.now(), requirePending = false, requireStopped = false }) {
  try {
    status(raw);
    if (!nonnegative(now) || typeof requirePending !== "boolean" || typeof requireStopped !== "boolean") throw fail();
    const target = signingKey(destinationIdentity), intent = raw.request, source = intent.sourceAuthority;
    if (destinationIdentity.endpointId !== intent.destination.endpointId || target.fingerprint !== intent.destination.keyFingerprint || !signed(intent, raw.signature, target.key)) throw fail();
    if (sourceAuthority !== undefined) { authority(sourceAuthority); if (!equal(sourceAuthority, source)) throw fail(); }
    let original;
    if (sourceIdentity !== undefined) {
      original = signingKey(sourceIdentity);
      if (sourceIdentity.endpointId !== source.endpointId || original.fingerprint !== source.keyFingerprint) throw fail();
    }
    if (requirePending && raw.state !== "pending") throw fail();
    if (requirePending && (intent.expiresAt <= now || intent.expiresAt > now + 5 * 60_000)) throw fail("profile_return_intent_expired");
    if (raw.sourceStopped && (!original || !signed(raw.sourceStopped.receipt, raw.sourceStopped.signature, original.key))) throw fail();
    if (requireStopped && (!original || !raw.sourceStopped || !["checkpoint-committed", "staged", "activated"].includes(raw.state))) throw fail("profile_return_stop_unconfirmed");
    return freeze(structuredClone(raw));
  } catch (error) { if (["profile_return_intent_expired", "profile_return_stop_unconfirmed"].includes(error?.code)) throw error; throw fail(); }
}
function verifyReturnSourceStopped(value) {
  try {
    exact(value, ["request", "manifestHash", "sourceStopped", "sourceIdentity"]); request(value.request);
    if (!isHash(value.manifestHash)) throw fail(); stopped(value.sourceStopped, value.request, value.manifestHash);
    const original = signingKey(value.sourceIdentity), source = value.request.sourceAuthority;
    if (value.sourceIdentity.endpointId !== source.endpointId || original.fingerprint !== source.keyFingerprint ||
        !signed(value.sourceStopped.receipt, value.sourceStopped.signature, original.key)) throw fail();
    return freeze(structuredClone(value.sourceStopped));
  } catch { throw fail("profile_return_stop_unconfirmed"); }
}
module.exports = { validateReturnIntentDocument, validateReturnIntentStatus, returnIntentHash, returnQueryDocument, returnCheckpointDocument, verifyReturnIntentStatus, verifyReturnSourceStopped };
