"use strict";
const crypto = require("node:crypto");
const { exactAuthority, canonical, sameAuthority } = require("./coordinator-client");
const { identityFingerprint, MAX_PLAINTEXT_BYTES, MAX_PACKET_BYTES } = require("./crypto");
const { encodePortableState, decodePortableState, SCHEMA } = require("./portable-state");
const { cookies } = require("./native-runtime");
const { preflightSealInput } = require("./live-backup-input");
const PURPOSE = "HOAI-PROFILE-ACTIVE-BACKUP-v1", MAX_RECIPIENTS = 4, MAX_BUNDLE_BYTES = 96 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = () => Object.assign(new Error("profile_live_crypto_refused"), { code: "profile_live_crypto_refused" });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys) => { if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) throw fail(); };
const publicKey = (encoded, type) => { if (typeof encoded !== "string" || encoded.length > 128) throw fail(); const key = crypto.createPublicKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "spki" }); if (key.asymmetricKeyType !== type || key.export({ format: "der", type: "spki" }).toString("base64url") !== encoded) throw fail(); return key; };
const aad = (context, role) => Buffer.concat([Buffer.from(`${PURPOSE}:${role}\0`), canonical(context)]);
const wrappingInfo = context => crypto.createHash("sha256").update(aad(context, "derive-wrap")).digest();
function encrypt(key, bytes, context, role) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad(context, role));
  return { iv: iv.toString("base64url"), ciphertext: Buffer.concat([cipher.update(bytes), cipher.final()]).toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
}
function decode(value, max, expected) {
  if (typeof value !== "string" || value.length > Math.ceil(max * 4 / 3) + 4 || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail();
  const bytes = Buffer.from(value, "base64url"); if (bytes.length > max || expected !== undefined && bytes.length !== expected || bytes.toString("base64url") !== value) throw fail(); return bytes;
}
function decrypt(key, envelope, context, role, max) {
  exact(envelope, ["iv", "ciphertext", "tag"]); const decipher = crypto.createDecipheriv("aes-256-gcm", key, decode(envelope.iv, 12, 12)); decipher.setAAD(aad(context, role)); decipher.setAuthTag(decode(envelope.tag, 16, 16));
  let update, final;
  try { update = decipher.update(decode(envelope.ciphertext, max)); final = decipher.final(); return Buffer.concat([update, final]); }
  finally { update?.fill(0); final?.fill(0); }
}
function assertSource(source, authority) {
  exact(source, ["identity", "signingPrivateKey", "encryptionPrivateKey"]);
  if (source.identity.endpointId !== authority.endpointId || identityFingerprint(source.identity) !== authority.keyFingerprint) throw fail();
  for (const [secret, field, type] of [["signingPrivateKey", "signingPublicKey", "ed25519"], ["encryptionPrivateKey", "encryptionPublicKey", "x25519"]]) {
    if (!(source[secret] instanceof crypto.KeyObject) || source[secret].type !== "private" || source[secret].asymmetricKeyType !== type || crypto.createPublicKey(source[secret]).export({ format: "der", type: "spki" }).toString("base64url") !== source.identity[field]) throw fail();
  }
}
function validateBase(base) {
  exact(base, ["version", "kind", "snapshotId", "sourceAuthority", "sequence", "previousBundleHash", "stateSchema", "captureKind"]);
  if (base.version !== 1 || base.kind !== "profile-active-backup" || typeof base.snapshotId !== "string" || !UUID.test(base.snapshotId) || !Number.isSafeInteger(base.sequence) || base.sequence < 1 || !(base.previousBundleHash === null || typeof base.previousBundleHash === "string" && HASH.test(base.previousBundleHash)) || base.stateSchema !== SCHEMA || base.captureKind !== "live-best-effort") throw fail();
  exactAuthority(base.sourceAuthority); return base;
}
function recipientOf(value) {
  exact(value, ["identity", "keyFingerprint", "grantVersion"]);
  if (identityFingerprint(value.identity) !== value.keyFingerprint || !Number.isSafeInteger(value.grantVersion) || value.grantVersion < 1) throw fail();
  return { endpointId: value.identity.endpointId, keyFingerprint: value.keyFingerprint, grantVersion: value.grantVersion };
}
function boundBackup(backup) {
  exact(backup, ["bundle", "bundleHash", "bundleSignature", "encryptedEnvelopes"]);
  const fields = ["version", "kind", "snapshotId", "sourceAuthority", "sequence", "previousBundleHash", "stateSchema", "captureKind"];
  exact(backup.bundle, [...fields, "recipients"]);
  const base = validateBase(Object.fromEntries(fields.map(field => [field, backup.bundle[field]]))), recipients = backup.bundle.recipients;
  if (typeof backup.bundleHash !== "string" || !HASH.test(backup.bundleHash) || typeof backup.bundleSignature !== "string" || backup.bundleSignature.length !== 86 || !Array.isArray(recipients) || !recipients.length || recipients.length > MAX_RECIPIENTS || Reflect.ownKeys(recipients).length !== recipients.length + 1 || !Array.isArray(backup.encryptedEnvelopes) || backup.encryptedEnvelopes.length !== recipients.length || Reflect.ownKeys(backup.encryptedEnvelopes).length !== recipients.length + 1) throw fail();
  let previous = "", total = 0;
  for (let index = 0; index < recipients.length; index++) {
    for (const array of [recipients, backup.encryptedEnvelopes]) { const descriptor = Object.getOwnPropertyDescriptor(array, String(index)); if (!descriptor || !Object.hasOwn(descriptor, "value")) throw fail(); }
    const row = recipients[index], envelope = backup.encryptedEnvelopes[index];
    exact(row, ["endpointId", "keyFingerprint", "grantVersion", "manifestHash", "ciphertextHash", "ciphertextBytes"]);
    if (typeof row.endpointId !== "string" || !UUID.test(row.endpointId) || row.endpointId <= previous || [row.keyFingerprint, row.manifestHash, row.ciphertextHash].some(value => typeof value !== "string" || !HASH.test(value)) || !Number.isSafeInteger(row.grantVersion) || row.grantVersion < 1 || !Number.isSafeInteger(row.ciphertextBytes) || row.ciphertextBytes < 1 || row.ciphertextBytes > MAX_PACKET_BYTES || (total += row.ciphertextBytes) > MAX_BUNDLE_BYTES) throw fail(); previous = row.endpointId;
    exact(envelope, ["manifest", "manifestSignature", "ciphertext"]);
    if (typeof envelope.ciphertext !== "string" || envelope.ciphertext.length > MAX_PACKET_BYTES * 4 / 3 + 4 || typeof envelope.manifestSignature !== "string" || envelope.manifestSignature.length !== 86) throw fail();
    exact(envelope.manifest, [...fields, "recipient", "ciphertextHash", "ciphertextBytes"]);
    const manifest = envelope.manifest;
    if (manifest.kind !== "profile-active-backup-envelope" || fields.some(field => field !== "kind" && field !== "sourceAuthority" && manifest[field] !== base[field]) || !sameAuthority(exactAuthority(manifest.sourceAuthority), base.sourceAuthority) || manifest.ciphertextHash !== row.ciphertextHash || manifest.ciphertextBytes !== row.ciphertextBytes) throw fail();
    exact(manifest.recipient, ["endpointId", "keyFingerprint", "grantVersion"]);
    if (manifest.recipient.endpointId !== row.endpointId || manifest.recipient.keyFingerprint !== row.keyFingerprint || manifest.recipient.grantVersion !== row.grantVersion) throw fail();
  }
  return base;
}
function sealActiveBackup({ draft, authority: rawAuthority, request, captureKind }) {
  let plaintext;
  try {
    preflightSealInput({ draft, authority: rawAuthority, request, captureKind });
    const authority = exactAuthority(rawAuthority); exact(request, ["snapshotId", "sequence", "previousBundleHash", "source", "recipients", "contentKeyEpoch"]);
    assertSource(request.source, authority);
    if (captureKind !== "live-best-effort" || !Array.isArray(request.recipients) || !request.recipients.length || request.recipients.length > MAX_RECIPIENTS || request.contentKeyEpoch?.epoch !== authority.contentKeyEpoch || !Buffer.isBuffer(request.contentKeyEpoch.key) && !(request.contentKeyEpoch.key instanceof Uint8Array) || request.contentKeyEpoch.key.length !== 32) throw fail();
    const key = Buffer.from(request.contentKeyEpoch.key);
    try {
      const base = validateBase({ version: 1, kind: "profile-active-backup", snapshotId: request.snapshotId, sourceAuthority: authority, sequence: request.sequence, previousBundleHash: request.previousBundleHash, stateSchema: SCHEMA, captureKind });
      exact(draft, ["cookies", "origins", "extras"]);
      if (!Array.isArray(draft.origins) || draft.origins.length > 100 || draft.origins.some(value => typeof value !== "string" || Buffer.byteLength(value) > MAX_PLAINTEXT_BYTES)) throw fail();
      const origins = draft.origins.map(value => JSON.parse(value));
      if (new Set(origins.map(value => value.origin)).size !== origins.length || origins.some(value => value.schema !== "hoai-origin-storage-v1")) throw fail();
      plaintext = encodePortableState({ schema: SCHEMA, cookies: cookies(draft.cookies), origins, ...draft.extras });
      const seen = new Set(), envelopes = [], recipients = []; let total = 0;
      for (const value of [...request.recipients].sort((a, b) => a.identity.endpointId < b.identity.endpointId ? -1 : a.identity.endpointId > b.identity.endpointId ? 1 : 0)) {
        const recipient = recipientOf(value); if (seen.has(recipient.endpointId)) throw fail(); seen.add(recipient.endpointId);
        const context = { ...base, kind: "profile-active-backup-envelope", recipient }, ephemeral = crypto.generateKeyPairSync("x25519"), salt = crypto.randomBytes(32), shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKey(value.identity.encryptionPublicKey, "x25519") });
        let wrapping;
        try {
          wrapping = Buffer.from(crypto.hkdfSync("sha256", shared, salt, wrappingInfo(context), 32));
          const packet = { version: 1, content: encrypt(key, plaintext, context, "content"), wrappedKey: { ephemeralPublicKey: ephemeral.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), salt: salt.toString("base64url"), ...encrypt(wrapping, key, context, "wrapped-key") } }, bytes = canonical(packet);
          if (bytes.length > MAX_PACKET_BYTES || (total += bytes.length) > MAX_BUNDLE_BYTES) throw fail();
          const manifest = { ...context, ciphertextHash: hash(bytes), ciphertextBytes: bytes.length }, manifestHash = hash(canonical(manifest));
          envelopes.push({ manifest, manifestSignature: crypto.sign(null, canonical(manifest), request.source.signingPrivateKey).toString("base64url"), ciphertext: bytes.toString("base64") });
          recipients.push({ ...recipient, manifestHash, ciphertextHash: manifest.ciphertextHash, ciphertextBytes: bytes.length });
        } finally { wrapping?.fill(0); shared.fill(0); }
      }
      const bundle = { ...base, recipients }, bundleHash = hash(canonical(bundle));
      return { bundle, bundleHash, bundleSignature: crypto.sign(null, canonical(bundle), request.source.signingPrivateKey).toString("base64url"), encryptedEnvelopes: envelopes };
    } finally { key.fill(0); }
  } catch { throw fail(); } finally { plaintext?.fill(0); }
}

// This decoder returns advisory portable bytes only. It deliberately produces
// no stopped receipt, staged acknowledgement, content-key grant or runtime.
function openActiveBackup({ backup, sourceIdentity, recipient, expected }) {
  let wrapping, shared, key, plaintext;
  try {
    const base = boundBackup(backup), recipients = backup.bundle.recipients;
    exact(expected, ["sourceAuthority", "snapshotId", "sequence", "previousBundleHash", "recipient"]);
    if (!sameAuthority(base.sourceAuthority, exactAuthority(expected.sourceAuthority)) || base.snapshotId !== expected.snapshotId || base.sequence !== expected.sequence || base.previousBundleHash !== expected.previousBundleHash || identityFingerprint(sourceIdentity) !== base.sourceAuthority.keyFingerprint || sourceIdentity.endpointId !== base.sourceAuthority.endpointId || hash(canonical(backup.bundle)) !== backup.bundleHash) throw fail();
    if (!Array.isArray(recipients) || !recipients.length || recipients.length > MAX_RECIPIENTS || !Array.isArray(backup.encryptedEnvelopes) || backup.encryptedEnvelopes.length !== recipients.length || !crypto.verify(null, canonical(backup.bundle), publicKey(sourceIdentity.signingPublicKey, "ed25519"), decode(backup.bundleSignature, 64, 64))) throw fail();
    exact(expected.recipient, ["endpointId", "keyFingerprint", "grantVersion"]);
    const wanted = recipientOf({ identity: recipient.identity, keyFingerprint: expected.recipient.keyFingerprint, grantVersion: expected.recipient.grantVersion });
    if (wanted.endpointId !== expected.recipient.endpointId) throw fail();
    assertSource(recipient, { endpointId: wanted.endpointId, keyFingerprint: wanted.keyFingerprint });
    let previous = "", total = 0;
    for (let index = 0; index < recipients.length; index++) {
      const row = recipients[index], envelope = backup.encryptedEnvelopes[index]; exact(row, ["endpointId", "keyFingerprint", "grantVersion", "manifestHash", "ciphertextHash", "ciphertextBytes"]); exact(envelope, ["manifest", "manifestSignature", "ciphertext"]);
      if (typeof row.endpointId !== "string" || row.endpointId <= previous || !HASH.test(row.keyFingerprint) || !Number.isSafeInteger(row.grantVersion) || row.grantVersion < 1 || !HASH.test(row.manifestHash) || !HASH.test(row.ciphertextHash) || !Number.isSafeInteger(row.ciphertextBytes) || row.ciphertextBytes < 1 || row.ciphertextBytes > MAX_PACKET_BYTES || (total += row.ciphertextBytes) > MAX_BUNDLE_BYTES || typeof envelope.ciphertext !== "string" || envelope.ciphertext.length > MAX_PACKET_BYTES * 4 / 3 + 4) throw fail(); previous = row.endpointId;
      const manifest = { ...base, kind: "profile-active-backup-envelope", recipient: { endpointId: row.endpointId, keyFingerprint: row.keyFingerprint, grantVersion: row.grantVersion }, ciphertextHash: row.ciphertextHash, ciphertextBytes: row.ciphertextBytes };
      if (!canonical(envelope.manifest).equals(canonical(manifest)) || hash(canonical(manifest)) !== row.manifestHash || !crypto.verify(null, canonical(manifest), publicKey(sourceIdentity.signingPublicKey, "ed25519"), decode(envelope.manifestSignature, 64, 64))) throw fail();
      const bytes = Buffer.from(envelope.ciphertext, "base64"); if (bytes.length !== row.ciphertextBytes || bytes.toString("base64") !== envelope.ciphertext || hash(bytes) !== row.ciphertextHash) throw fail();
      if (row.endpointId !== wanted.endpointId) continue;
      if (row.grantVersion !== wanted.grantVersion || row.keyFingerprint !== wanted.keyFingerprint) throw fail();
      const { ciphertextHash, ciphertextBytes, ...context } = manifest, packet = JSON.parse(bytes); exact(packet, ["version", "content", "wrappedKey"]); if (packet.version !== 1) throw fail(); exact(packet.wrappedKey, ["ephemeralPublicKey", "salt", "iv", "ciphertext", "tag"]);
      shared = crypto.diffieHellman({ privateKey: recipient.encryptionPrivateKey, publicKey: publicKey(packet.wrappedKey.ephemeralPublicKey, "x25519") });
      wrapping = Buffer.from(crypto.hkdfSync("sha256", shared, decode(packet.wrappedKey.salt, 32, 32), wrappingInfo(context), 32));
      const { ephemeralPublicKey, salt, ...wrapped } = packet.wrappedKey; key = decrypt(wrapping, wrapped, context, "wrapped-key", 32); if (key.length !== 32) throw fail(); plaintext = decrypt(key, packet.content, context, "content", MAX_PLAINTEXT_BYTES);
    }
    if (!plaintext) throw fail(); const state = decodePortableState(plaintext); return { kind: "live-best-effort", state };
  } catch { throw fail(); } finally { wrapping?.fill(0); shared?.fill(0); key?.fill(0); plaintext?.fill(0); }
}
module.exports = { sealActiveBackup, openActiveBackup, assertActiveBackupWireBounds: boundBackup, MAX_RECIPIENTS, MAX_BUNDLE_BYTES, PURPOSE };
