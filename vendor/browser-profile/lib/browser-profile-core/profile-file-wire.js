"use strict";
const crypto = require("node:crypto"), codec = require("./crypto"), files = require("./profile-file-crypto");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/, ID = /^[A-Za-z0-9_-]{1,128}$/, HASH = /^[a-f0-9]{64}$/;
const fail = (code = "profile_file_wire_invalid") => Object.assign(new Error(code), { code });
const positive = value => Number.isSafeInteger(value) && value > 0;
function exact(value, fields) {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== fields.length || fields.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key); return !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
  })) throw fail();
  return Object.fromEntries(fields.map(key => [key, Object.getOwnPropertyDescriptor(value, key).value]));
}
function array(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) throw fail();
  return Array.from({ length: value.length }, (_, index) => { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw fail(); return descriptor.value; });
}
function scopeOf(raw) {
  const scope = exact(raw, ["actingUserId", "assistantId", "profileId"]);
  if (typeof scope.actingUserId !== "string" || !ID.test(scope.actingUserId) || !positive(scope.assistantId) || typeof scope.profileId !== "string" || !UUID.test(scope.profileId)) throw fail();
  return Object.freeze(scope);
}
function authorityOf(raw) { return exactAuthority(exact(raw, ["profileId", "actingUserId", "assistantId", "endpointId", "bootId", "runtimeId", "sessionId", "writerEpoch", "revision", "contentKeyEpoch", "grantVersion", "keyFingerprint"])); }
function identityOf(raw) {
  const identity = exact(raw, ["version", "endpointId", "signingPublicKey", "encryptionPublicKey"]);
  if (identity.version !== 1 || typeof identity.endpointId !== "string" || !UUID.test(identity.endpointId) || typeof identity.signingPublicKey !== "string" || typeof identity.encryptionPublicKey !== "string") throw fail();
  try { codec.identityFingerprint(identity); } catch { throw fail(); } return Object.freeze(identity);
}
function pinsOf(raw) {
  const pins = new Map();
  for (const value of array(raw, 2)) {
    const pin = exact(value, ["identity", "grantVersion"]), identity = identityOf(pin.identity);
    if (!positive(pin.grantVersion) || pins.has(identity.endpointId)) throw fail();
    pins.set(identity.endpointId, Object.freeze({ identity, grantVersion: pin.grantVersion, keyFingerprint: codec.identityFingerprint(identity) }));
  }
  if (pins.size !== 2) throw fail("profile_file_reviewed_pins_required"); return pins;
}
function endpointOf(raw, party) {
  const endpoint = exact(raw, ["identity", "signingPrivateKey", "encryptionPrivateKey"]), identity = identityOf(endpoint.identity);
  if (identity.endpointId !== party.endpointId || codec.identityFingerprint(identity) !== party.keyFingerprint) throw fail("profile_file_endpoint_changed");
  for (const [privateName, publicName, kind] of [["signingPrivateKey", "signingPublicKey", "ed25519"], ["encryptionPrivateKey", "encryptionPublicKey", "x25519"]]) {
    const key = endpoint[privateName]; if (!(key instanceof crypto.KeyObject) || key.type !== "private" || key.asymmetricKeyType !== kind || crypto.createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64url") !== identity[publicName]) throw fail("profile_file_endpoint_changed");
  }
  return Object.freeze({ ...endpoint, identity });
}
const { canonical, exactAuthority } = require("./coordinator-client");
const same = (left, right) => canonical(left).equals(canonical(right));
function signed(document, signature, identity) {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) throw fail(); const bytes = Buffer.from(signature, "base64url");
  if (bytes.length !== 64 || bytes.toString("base64url") !== signature || !crypto.verify(null, canonical(document), crypto.createPublicKey({ key: Buffer.from(identity.signingPublicKey, "base64url"), type: "spki", format: "der" }), bytes)) throw fail("profile_file_signature_invalid");
}
function consentOf(raw, offer, offerHash, human) {
  const input = exact(raw, ["document", "signature"]), document = exact(input.document, ["version", "kind", "fileId", "offerHash", "endpointId", "keyFingerprint", "choice", "nonce", "expiresAt"]);
  if (document.version !== 1 || document.kind !== "agent-browser-file-consent" || document.fileId !== offer.fileId || document.offerHash !== offerHash || document.endpointId !== human.identity.endpointId || document.keyFingerprint !== human.keyFingerprint || !["allow_once", "deny"].includes(document.choice) || typeof document.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(document.nonce) || Buffer.from(document.nonce, "base64url").toString("base64url") !== document.nonce || !positive(document.expiresAt) || document.expiresAt > offer.expiresAt) throw fail();
  signed(document, input.signature, human.identity); return Object.freeze({ document: Object.freeze(document), signature: input.signature });
}
function statusOf(raw, { scope: rawScope, pins: rawPins, expectedOffer, expectedSignature, previous }) {
  const scope = scopeOf(rawScope), pins = pinsOf(rawPins), value = exact(raw, ["offer", "signature", "offerHash", "consent", "state", "uploadAttemptedAt", "claimedAt", "current", "uploadOutcome"]), offer = files.parseOffer(value.offer);
  if (offer.authority.profileId !== scope.profileId || offer.authority.actingUserId !== scope.actingUserId || offer.authority.assistantId !== scope.assistantId) throw fail("profile_file_scope_changed");
  for (const party of [offer.source, offer.destination]) { const pin = pins.get(party.endpointId); if (!pin || pin.keyFingerprint !== party.keyFingerprint || pin.grantVersion !== party.grantVersion) throw fail("profile_file_reviewed_pins_required"); }
  const source = pins.get(offer.source.endpointId), human = pins.get((offer.direction === "to-agent" ? offer.source : offer.destination).endpointId);
  files.verifyOffer({ offer, signature: value.signature, expectedContext: files.offerContext(offer), sourceIdentity: source.identity });
  if (expectedOffer && !same(offer, files.parseOffer(expectedOffer)) || expectedSignature !== undefined && value.signature !== expectedSignature || value.offerHash !== files.offerHash(offer, value.signature)) throw fail("profile_file_offer_changed");
  const consent = value.consent === null ? null : consentOf(value.consent, offer, value.offerHash, human), timestamp = item => item === null || positive(item) && item <= offer.expiresAt;
  if (!["offered", "allowed", "denied", "uploading", "available", "claimed", "cancelled", "expired"].includes(value.state) || ![true, false, null].includes(value.current) || !["outcome-unknown", "confirmed", "not-uploaded"].includes(value.uploadOutcome) || !timestamp(value.uploadAttemptedAt) || !timestamp(value.claimedAt) || value.state === "offered" && consent !== null || ["allowed", "uploading", "available", "claimed"].includes(value.state) && consent?.document.choice !== "allow_once" || value.state === "denied" && consent?.document.choice !== "deny" || ["uploading", "available", "claimed"].includes(value.state) && value.uploadAttemptedAt === null || value.state === "claimed" && value.claimedAt === null || value.claimedAt !== null && !["claimed", "expired"].includes(value.state) || ["available", "claimed"].includes(value.state) && value.uploadOutcome !== "confirmed" || value.state === "uploading" && value.uploadOutcome !== "outcome-unknown") throw fail();
  if (previous) {
    if (!same(previous.offer, offer) || previous.signature !== value.signature || previous.consent && !same(previous.consent, consent) || previous.uploadAttemptedAt !== null && previous.uploadAttemptedAt !== value.uploadAttemptedAt || previous.claimedAt !== null && previous.claimedAt !== value.claimedAt) throw fail("profile_file_history_changed");
    const allowed = { offered: ["offered", "allowed", "denied", "uploading", "available", "claimed", "cancelled", "expired"], allowed: ["allowed", "uploading", "available", "claimed", "cancelled", "expired"], uploading: ["uploading", "available", "claimed", "cancelled", "expired"], available: ["available", "claimed", "cancelled", "expired"], claimed: ["claimed", "expired"], denied: ["denied", "expired"], cancelled: ["cancelled", "expired"], expired: ["expired"] };
    if (!allowed[previous.state]?.includes(value.state)) throw fail("profile_file_history_changed");
  }
  return Object.freeze({ ...value, offer, consent });
}
function checkCurrent(callback) {
  if (typeof callback !== "function") throw fail("profile_file_context_changed"); const result = callback();
  if (result?.then) { void Promise.resolve(result).catch(() => {}); throw fail("profile_file_context_changed"); } if (result === false) throw fail("profile_file_context_changed");
}
module.exports = { exact, array, scopeOf, authorityOf, identityOf, pinsOf, endpointOf, statusOf, same, signed, canonical, checkCurrent, UUID, ID, HASH };
