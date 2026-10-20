"use strict";
const crypto = require("node:crypto");
const codec = require("./crypto");
const MAX_FILE_BYTES = 25 * 1024 * 1024, MAX_CIPHER_BYTES = MAX_FILE_BYTES + 29, FILE_TTL_MS = 10 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9_-]{1,128}$/;
const AUTHORITY = ["profileId", "actingUserId", "assistantId", "endpointId", "bootId", "runtimeId", "sessionId", "writerEpoch", "revision", "contentKeyEpoch", "grantVersion", "keyFingerprint"];
const PARTY = ["endpointId", "keyFingerprint", "grantVersion"];
const BASE = ["version", "kind", "fileId", "nonce", "direction", "authority", "source", "destination", "expiresAt", "plaintextBytes"];
const OFFER = [...BASE, "ephemeralPublicKey", "salt", "metadata", "ciphertextHash", "ciphertextBytes"];
const fail = () => Object.assign(new Error("profile_file_refused"), { code: "profile_file_refused" });
const positive = value => Number.isSafeInteger(value) && value > 0;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], "value") || !descriptors[key].enumerable)) throw fail();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function binary(value, max, length) {
  if (typeof value !== "string" || value.length > Math.ceil(max * 4 / 3) + 4 || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length > max || length !== undefined && bytes.length !== length || bytes.toString("base64url") !== value) throw fail();
  return bytes;
}
const sorted = value => value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const canonical = value => Buffer.from(JSON.stringify(sorted(value)), "utf8");
function authority(raw) {
  const value = exact(raw, AUTHORITY);
  if (!["profileId", "endpointId"].every(key => typeof value[key] === "string" && UUID.test(value[key])) ||
      !["actingUserId", "bootId", "runtimeId", "sessionId"].every(key => typeof value[key] === "string" && ID.test(value[key])) ||
      !["assistantId", "writerEpoch", "contentKeyEpoch", "grantVersion"].every(key => positive(value[key])) || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.keyFingerprint !== "string" || !HASH.test(value.keyFingerprint)) throw fail();
  return Object.freeze(value);
}
function party(raw) {
  const value = exact(raw, PARTY);
  if (typeof value.endpointId !== "string" || !UUID.test(value.endpointId) || typeof value.keyFingerprint !== "string" || !HASH.test(value.keyFingerprint) || !positive(value.grantVersion)) throw fail();
  return Object.freeze(value);
}
function context(raw) {
  const value = exact(raw, BASE);
  if (value.version !== 1 || value.kind !== "agent-browser-file-offer" || typeof value.fileId !== "string" || !UUID.test(value.fileId) || !["to-agent", "to-desktop"].includes(value.direction) || !positive(value.expiresAt) || !Number.isSafeInteger(value.plaintextBytes) || value.plaintextBytes < 0 || value.plaintextBytes > MAX_FILE_BYTES) throw fail();
  binary(value.nonce, 32, 32); value.authority = authority(value.authority); value.source = party(value.source); value.destination = party(value.destination);
  const writer = [value.source, value.destination].find(party => party.endpointId === value.authority.endpointId);
  if (value.source.endpointId === value.destination.endpointId || !writer || writer.keyFingerprint !== value.authority.keyFingerprint || writer.grantVersion !== value.authority.grantVersion) throw fail();
  return Object.freeze(value);
}
function publicKey(value, kind) {
  const bytes = binary(value, 44, 44), key = crypto.createPublicKey({ key: bytes, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== kind || key.export({ format: "der", type: "spki" }).toString("base64url") !== value) throw fail();
  return key;
}
function box(raw) {
  const value = exact(raw, ["iv", "ciphertext", "tag"]);
  binary(value.iv, 12, 12); binary(value.tag, 16, 16); if (!binary(value.ciphertext, 4096).length) throw fail();
  return Object.freeze(value);
}
function offerContext(raw) { const value = exact(raw, OFFER); return context(Object.fromEntries(BASE.map(key => [key, value[key]]))); }
function parseOffer(raw) {
  const value = exact(raw, OFFER), base = offerContext(value);
  publicKey(value.ephemeralPublicKey, "x25519"); binary(value.salt, 32, 32); value.metadata = box(value.metadata);
  if (typeof value.ciphertextHash !== "string" || !HASH.test(value.ciphertextHash) || value.ciphertextBytes !== base.plaintextBytes + 29 || value.ciphertextBytes > MAX_CIPHER_BYTES) throw fail();
  return Object.freeze({ ...value, ...base });
}
function fresh(offer, now = Date.now()) { if (!Number.isSafeInteger(now) || now < 0 || offer.expiresAt <= now || offer.expiresAt > now + FILE_TTL_MS) throw fail(); }
function validateFileName(value) {
  if (typeof value !== "string" || !value.length || value.length > 120 || /[\\/:<>"|?*\x00-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value) || /[. ]$/.test(value) || /^(?:\.|\.\.|con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) throw fail();
  return value;
}
function metadata(raw) {
  const value = exact(raw, ["fileName", "contentType", "plaintextHash"]); validateFileName(value.fileName);
  if (typeof value.contentType !== "string" || value.contentType.length > 128 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value.contentType) || typeof value.plaintextHash !== "string" || !HASH.test(value.plaintextHash)) throw fail();
  return value;
}
const associated = (base, purpose, extra) => Buffer.concat([Buffer.from("HOAI-BROWSER-FILE-v1\0" + purpose + "\0"), canonical(extra ? { base, metadata: extra } : base)]);
function keyOf(privateKey, peer, salt, base) {
  const shared = crypto.diffieHellman({ privateKey, publicKey: publicKey(peer, "x25519") });
  try { return Buffer.from(crypto.hkdfSync("sha256", shared, salt, crypto.createHash("sha256").update(associated(base, "key-derivation")).digest(), 32)); } finally { shared.fill(0); }
}
function encrypt(key, bytes, aad) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad);
  return { iv, ciphertext: Buffer.concat([cipher.update(bytes), cipher.final()]), tag: cipher.getAuthTag() };
}
function decrypt(key, packet, aad) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, packet.iv); decipher.setAAD(aad); decipher.setAuthTag(packet.tag);
  let updated, final;
  try { updated = decipher.update(packet.ciphertext); final = decipher.final(); return Buffer.concat([updated, final]); }
  finally { updated?.fill(0); final?.fill(0); }
}
function sealFile({ plaintext, fileName, contentType, context: raw, source, destinationIdentity }) {
  let key;
  try {
    const base = context(raw); fresh(base);
    if (!Buffer.isBuffer(plaintext) || plaintext.length !== base.plaintextBytes || codec.identityFingerprint(source.identity) !== base.source.keyFingerprint || source.identity.endpointId !== base.source.endpointId || codec.identityFingerprint(destinationIdentity) !== base.destination.keyFingerprint || destinationIdentity.endpointId !== base.destination.endpointId) throw fail();
    const ephemeral = crypto.generateKeyPairSync("x25519"), salt = crypto.randomBytes(32); key = keyOf(ephemeral.privateKey, destinationIdentity.encryptionPublicKey, salt, base);
    const label = encrypt(key, canonical(metadata({ fileName, contentType, plaintextHash: hash(plaintext) })), associated(base, "metadata"));
    const encryptedMetadata = Object.fromEntries(Object.entries(label).map(([name, bytes]) => [name, bytes.toString("base64url")]));
    const data = encrypt(key, plaintext, associated(base, "content", encryptedMetadata)), payload = Buffer.concat([Buffer.from([1]), data.iv, data.tag, data.ciphertext]);
    const offer = parseOffer({ ...base, ephemeralPublicKey: ephemeral.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), salt: salt.toString("base64url"), metadata: encryptedMetadata, ciphertextHash: hash(payload), ciphertextBytes: payload.length });
    return { offer, signature: crypto.sign(null, canonical(offer), source.signingPrivateKey).toString("base64url"), payload };
  } catch { throw fail(); } finally { key?.fill(0); }
}
function verifyOffer({ offer: raw, signature, expectedContext, sourceIdentity }) {
  try {
    const offer = parseOffer(raw), base = context(expectedContext);
    if (!canonical(offerContext(offer)).equals(canonical(base)) || sourceIdentity.endpointId !== base.source.endpointId || codec.identityFingerprint(sourceIdentity) !== base.source.keyFingerprint || !crypto.verify(null, canonical(offer), publicKey(sourceIdentity.signingPublicKey, "ed25519"), binary(signature, 64, 64))) throw fail();
    return offer;
  } catch { throw fail(); }
}
function openFileMetadata({ offer: raw, signature, expectedContext, sourceIdentity, destination }) {
  let key, bytes;
  try {
    const offer = verifyOffer({ offer: raw, signature, expectedContext, sourceIdentity }), base = offerContext(offer);
    if (destination.identity.endpointId !== base.destination.endpointId || codec.identityFingerprint(destination.identity) !== base.destination.keyFingerprint) throw fail();
    key = keyOf(destination.encryptionPrivateKey, offer.ephemeralPublicKey, binary(offer.salt, 32, 32), base);
    bytes = decrypt(key, Object.fromEntries(Object.entries(offer.metadata).map(([name, value]) => [name, binary(value, name === "ciphertext" ? 4096 : name === "iv" ? 12 : 16)])), associated(base, "metadata"));
    return metadata(JSON.parse(bytes.toString("utf8")));
  } catch { throw fail(); } finally { key?.fill(0); bytes?.fill(0); }
}
function openFile(options) {
  let key, plaintext;
  try {
    const offer = verifyOffer(options), base = offerContext(offer), label = openFileMetadata(options), payload = options.payload;
    if (!Buffer.isBuffer(payload) || payload.length !== offer.ciphertextBytes || payload.length > MAX_CIPHER_BYTES || payload[0] !== 1 || hash(payload) !== offer.ciphertextHash) throw fail();
    key = keyOf(options.destination.encryptionPrivateKey, offer.ephemeralPublicKey, binary(offer.salt, 32, 32), base);
    plaintext = decrypt(key, { iv: payload.subarray(1, 13), tag: payload.subarray(13, 29), ciphertext: payload.subarray(29) }, associated(base, "content", offer.metadata));
    if (plaintext.length !== base.plaintextBytes || hash(plaintext) !== label.plaintextHash) throw fail();
    return { plaintext, fileName: label.fileName, contentType: label.contentType };
  } catch { plaintext?.fill(0); throw fail(); } finally { key?.fill(0); }
}
function offerHash(offer, signature) { return hash(canonical({ offer: parseOffer(offer), signature: binary(signature, 64, 64).toString("base64url") })); }
module.exports = { MAX_FILE_BYTES, MAX_CIPHER_BYTES, FILE_TTL_MS, parseOffer, offerContext, offerHash, sealFile, verifyOffer, openFileMetadata, openFile, fresh, validateFileName };
