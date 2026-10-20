"use strict";
// Main/worker only. Metadata verifies locally retained public pins. It never
// confers writer authority or turns an advisory backup into a stopped capsule.
const crypto = require("node:crypto");
const { exactAuthority, sameAuthority, canonical } = require("./coordinator-client");
const { identityFingerprint, MAX_PACKET_BYTES } = require("./crypto");
const { identity, exact } = require("./live-backup-input");
const { assertActiveBackupWireBounds } = require("./active-backup-crypto");
const { SCHEMA } = require("./portable-state");
const MAX_WIRE_BYTES = 128 * 1024 * 1024 + 64 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/, ID = /^[A-Za-z0-9_-]{1,128}$/, HASH = /^[a-f0-9]{64}$/;
const AUTHORITY = ["profileId", "actingUserId", "assistantId", "endpointId", "bootId", "runtimeId", "sessionId", "writerEpoch", "revision", "contentKeyEpoch", "grantVersion", "keyFingerprint"];
const BASE = ["version", "kind", "snapshotId", "sourceAuthority", "sequence", "previousBundleHash", "stateSchema", "captureKind"];
const fail = (code = "profile_backup_wire_invalid") => Object.assign(new Error(code), { code });
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const positive = value => Number.isSafeInteger(value) && value > 0, nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const isUuid = value => typeof value === "string" && UUID.test(value), isHash = value => typeof value === "string" && HASH.test(value);
function freeze(value) { if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
function array(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) throw fail();
  for (let i = 0; i < value.length; i++) { const descriptor = Object.getOwnPropertyDescriptor(value, String(i)); if (!descriptor || !Object.hasOwn(descriptor, "value")) throw fail(); }
  return value;
}
function scopeOf(value) {
  exact(value, ["profileId", "actingUserId", "assistantId"]);
  if (!isUuid(value.profileId) || typeof value.actingUserId !== "string" || !ID.test(value.actingUserId) || !positive(value.assistantId)) throw fail();
  return freeze({ ...value });
}
function authorityOf(value) { exact(value, AUTHORITY); return exactAuthority(value); }
function pinMap(pins) {
  const map = new Map();
  for (const pin of array(pins, 128)) { identity(pin); const fingerprint = identityFingerprint(pin); if (map.has(pin.endpointId)) throw fail(); map.set(pin.endpointId, { identity: freeze({ ...pin }), fingerprint }); }
  return map;
}
function validSignature(value, signature, pin) {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) throw fail();
  const bytes = Buffer.from(signature, "base64url");
  if (bytes.length !== 64 || bytes.toString("base64url") !== signature || !crypto.verify(null, canonical(value), crypto.createPublicKey({ key: Buffer.from(pin.signingPublicKey, "base64url"), format: "der", type: "spki" }), bytes)) throw fail();
}
function validateBackupMetadata(raw, { scope, pins }) {
  scope = scopeOf(scope); const approved = pinMap(pins);
  exact(raw, ["bundle", "bundleHash", "bundleSignature"]); exact(raw.bundle, [...BASE, "recipients"]);
  const bundle = raw.bundle, source = authorityOf(bundle.sourceAuthority);
  if (bundle.version !== 1 || bundle.kind !== "profile-active-backup" || !isUuid(bundle.snapshotId) || !positive(bundle.sequence) ||
      !(bundle.previousBundleHash === null || isHash(bundle.previousBundleHash)) || bundle.stateSchema !== SCHEMA || bundle.captureKind !== "live-best-effort" ||
      source.profileId !== scope.profileId || source.actingUserId !== scope.actingUserId || source.assistantId !== scope.assistantId || !isHash(raw.bundleHash)) throw fail();
  const recipients = array(bundle.recipients, 4); if (!recipients.length) throw fail(); let previous = "", total = 0;
  for (const row of recipients) {
    exact(row, ["endpointId", "keyFingerprint", "grantVersion", "manifestHash", "ciphertextHash", "ciphertextBytes"]);
    if (!isUuid(row.endpointId) || row.endpointId <= previous || !positive(row.grantVersion) || ![row.keyFingerprint, row.manifestHash, row.ciphertextHash].every(isHash) ||
        !positive(row.ciphertextBytes) || row.ciphertextBytes > MAX_PACKET_BYTES || (total += row.ciphertextBytes) > 96 * 1024 * 1024) throw fail(); previous = row.endpointId;
  }
  const pin = approved.get(source.endpointId); if (!pin || pin.fingerprint !== source.keyFingerprint) throw fail("profile_backup_source_pin_required");
  if (sha(canonical(bundle)) !== raw.bundleHash) throw fail(); validSignature(bundle, raw.bundleSignature, pin.identity);
  return freeze(structuredClone(raw));
}
function preflightEncryptedBackup(raw, options) {
  exact(raw, ["bundle", "bundleHash", "bundleSignature", "encryptedEnvelopes"]);
  const metadata = validateBackupMetadata({ bundle: raw.bundle, bundleHash: raw.bundleHash, bundleSignature: raw.bundleSignature }, options);
  for (const envelope of array(raw.encryptedEnvelopes, 4)) { exact(envelope, ["manifest", "manifestSignature", "ciphertext"]); exact(envelope.manifest, [...BASE, "recipient", "ciphertextHash", "ciphertextBytes"]); authorityOf(envelope.manifest.sourceAuthority); }
  assertActiveBackupWireBounds(raw); return metadata;
}
function validateEncryptedBackup(raw, options) {
  const metadata = preflightEncryptedBackup(raw, options), approved = pinMap(options.pins).get(metadata.bundle.sourceAuthority.endpointId);
  for (let i = 0; i < metadata.bundle.recipients.length; i++) {
    const row = metadata.bundle.recipients[i], envelope = raw.encryptedEnvelopes[i];
    if (sha(canonical(envelope.manifest)) !== row.manifestHash) throw fail(); validSignature(envelope.manifest, envelope.manifestSignature, approved.identity);
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    if (bytes.length !== row.ciphertextBytes || bytes.toString("base64") !== envelope.ciphertext || sha(bytes) !== row.ciphertextHash) throw fail();
  }
  return metadata;
}
function profileOf(value, scope) {
  exact(value, ["id", "actingUserId", "assistantId", "revision", "headManifestHash", "contentKeyEpoch", "writerEpoch", "writerState", "endpointId", "bootId", "runtimeId", "sessionId"]);
  if (value.id !== scope.profileId || value.actingUserId !== scope.actingUserId || value.assistantId !== scope.assistantId || !nonnegative(value.revision) || !positive(value.contentKeyEpoch) || !nonnegative(value.writerEpoch) ||
      !(value.headManifestHash === null || isHash(value.headManifestHash)) || !["idle", "active", "quiescing", "stopped", "staged", "fenced"].includes(value.writerState) ||
      !(value.endpointId === null || isUuid(value.endpointId)) || ["bootId", "runtimeId", "sessionId"].some(key => value[key] !== null && (typeof value[key] !== "string" || !ID.test(value[key])))) throw fail();
  return value;
}
function validateBackupHead(raw, { scope, pins, requestId, writerEpoch }) {
  scope = scopeOf(scope); exact(raw, ["profile", "head", "retained", ...(requestId === undefined ? [] : ["requestId"])]);
  if (requestId !== undefined && (!isUuid(requestId) || raw.requestId !== requestId)) throw fail();
  profileOf(raw.profile, scope); if (!nonnegative(writerEpoch) || raw.profile.writerEpoch < writerEpoch) throw fail();
  const retained = array(raw.retained, 2).map(value => validateBackupMetadata(value, { scope, pins }));
  if (new Set(retained.map(value => value.bundleHash)).size !== retained.length) throw fail();
  const head = raw.head === null ? null : validateBackupMetadata(raw.head, { scope, pins });
  if (head && (head.bundle.sourceAuthority.writerEpoch !== writerEpoch || !retained.some(value => value.bundleHash === head.bundleHash))) throw fail();
  return freeze({ ...(requestId === undefined ? {} : { requestId }), profile: { ...raw.profile }, head, retained });
}
function validateBackupContext(raw, { scope, pins, request }) {
  scope = scopeOf(scope); exact(request, ["version", "requestId", "sourceAuthority", "expiresAt"]);
  const authority = authorityOf(request.sourceAuthority);
  if (request.version !== 2 || !isUuid(request.requestId) || !positive(request.expiresAt) || request.expiresAt <= Date.now() || authority.profileId !== scope.profileId || authority.actingUserId !== scope.actingUserId || authority.assistantId !== scope.assistantId) throw fail();
  exact(raw, ["request", "profile", "head", "retained", "recipients"]); exact(raw.request, ["version", "requestId", "sourceAuthority", "expiresAt"]); authorityOf(raw.request.sourceAuthority);
  if (raw.request.version !== 2 || raw.request.requestId !== request.requestId || raw.request.expiresAt !== request.expiresAt || !sameAuthority(authorityOf(raw.request.sourceAuthority), authority)) throw fail();
  const head = validateBackupHead({ profile: raw.profile, head: raw.head, retained: raw.retained }, { scope, pins, writerEpoch: authority.writerEpoch });
  if (head.profile.writerState !== "active" || !["endpointId", "bootId", "runtimeId", "sessionId", "writerEpoch", "revision", "contentKeyEpoch"].every(key => head.profile[key] === authority[key])) throw fail("profile_backup_writer_changed");
  const recipients = array(raw.recipients, 4); let previous = "";
  if (!recipients.length) throw fail();
  for (const row of recipients) {
    exact(row, ["identity", "keyFingerprint", "grantVersion", "kind", "ownerUserId", "pairingId"]); identity(row.identity);
    if (identityFingerprint(row.identity) !== row.keyFingerprint || !positive(row.grantVersion) || row.identity.endpointId <= previous || !["desktop", "agent"].includes(row.kind) || typeof row.ownerUserId !== "string" || !ID.test(row.ownerUserId) || (row.kind === "desktop" ? row.ownerUserId !== scope.actingUserId || row.pairingId !== null : !positive(row.pairingId))) throw fail();
    previous = row.identity.endpointId;
  }
  const source = recipients.find(row => row.identity.endpointId === authority.endpointId);
  if (!source || source.keyFingerprint !== authority.keyFingerprint || source.grantVersion !== authority.grantVersion) throw fail("profile_backup_writer_changed");
  return freeze({ request: structuredClone(request), ...head, recipients: structuredClone(recipients) });
}
function validateUploadAck(raw, metadata) {
  exact(raw, ["profileId", "writerEpoch", "snapshotId", "sequence", "bundleHash", "stored", "retainedSnapshotIds"]);
  const ids = array(raw.retainedSnapshotIds, 2), bundle = metadata.bundle;
  if (raw.profileId !== bundle.sourceAuthority.profileId || raw.writerEpoch !== bundle.sourceAuthority.writerEpoch || raw.snapshotId !== bundle.snapshotId || raw.sequence !== bundle.sequence || raw.bundleHash !== metadata.bundleHash ||
      raw.stored !== true || !ids.length || !ids.every(isUuid) || new Set(ids).size !== ids.length || !ids.includes(bundle.snapshotId)) throw fail();
  return freeze(structuredClone(raw));
}
module.exports = { MAX_WIRE_BYTES, AUTHORITY, exact, array, scopeOf, authorityOf, freeze, sha, pinMap, preflightEncryptedBackup, validateBackupMetadata, validateEncryptedBackup, validateBackupHead, validateBackupContext, validateUploadAck, sameAuthority };
