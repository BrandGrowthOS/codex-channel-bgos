"use strict";

// Main/host-only primitives. Enrollment, freshness, grant revocation, writer
// authority and filesystem durability belong to their respective coordinators.
const crypto = require("node:crypto");
const MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;
const MAX_PACKET_BYTES = 24 * 1024 * 1024;
const MAX_WIRE_BYTES = 32 * 1024 * 1024;
const MAX_KEY_RECORD_BYTES = 8192;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH = /^[a-f0-9]{64}$/;
const CONTEXT_KEYS = ["version", "profileId", "actingUserId", "assistantId", "transitionId", "revision",
  "previousManifestHash", "keyEpoch", "source", "destination", "schemaVersion"];
const SOURCE_KEYS = ["endpointId", "bootId", "runtimeId", "sessionId", "writerEpoch"];
const DESTINATION_KEYS = ["endpointId", "bootId", "runtimeId", "sessionId", "grantVersion", "keyFingerprint"];
const IDENTITY_KEYS = ["version", "endpointId", "signingPublicKey", "encryptionPublicKey"];
const fail = () => Object.assign(new Error("profile_sync_crypto_refused"), { code: "profile_sync_crypto_refused" });
const positive = value => Number.isSafeInteger(value) && value > 0;
const identifier = value => typeof value === "string" && ID.test(value);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key =>
    !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], "value") || !descriptors[key].enumerable)) throw fail();
  return value;
}

function decode(value, max, length) {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(max * 4 / 3) + 4 ||
      !/^[A-Za-z0-9_-]+$/.test(value)) throw fail();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length > max || (length !== undefined && bytes.length !== length) || bytes.toString("base64url") !== value) throw fail();
  return bytes;
}

function decodeWire(value) {
  if (typeof value !== "string" || !value.length || value.length > MAX_WIRE_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw fail();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_PACKET_BYTES || bytes.toString("base64") !== value) throw fail();
  return bytes;
}

// The strict manifest schema uses ASCII strings and safe integers only. This
// deterministic JSON codec is deliberately not a general-purpose JCS library.
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  return value;
}
const canonical = value => Buffer.from(JSON.stringify(sorted(value)), "utf8");

function validateContext(value) {
  exact(value, CONTEXT_KEYS);
  if (value.version !== 1 || value.schemaVersion !== 1 ||
      !["profileId", "actingUserId", "transitionId"].every(key => identifier(value[key])) ||
      !["assistantId", "revision", "keyEpoch"].every(key => positive(value[key])) ||
      !(value.previousManifestHash === null || typeof value.previousManifestHash === "string" && HASH.test(value.previousManifestHash))) throw fail();
  exact(value.source, SOURCE_KEYS); exact(value.destination, DESTINATION_KEYS);
  for (const party of [value.source, value.destination]) {
    if (!["endpointId", "bootId", "runtimeId", "sessionId"].every(key => identifier(party[key]))) throw fail();
  }
  if (!positive(value.source.writerEpoch) || !positive(value.destination.grantVersion) ||
      typeof value.destination.keyFingerprint !== "string" || !HASH.test(value.destination.keyFingerprint)) throw fail();
  return value;
}

function contextOf(manifest) {
  return Object.fromEntries(CONTEXT_KEYS.map(key => [key, manifest[key]]));
}

function validateManifest(value) {
  exact(value, [...CONTEXT_KEYS, "ciphertextHash", "ciphertextBytes"]);
  validateContext(contextOf(value));
  if (typeof value.ciphertextHash !== "string" || !HASH.test(value.ciphertextHash) ||
      !positive(value.ciphertextBytes) || value.ciphertextBytes > MAX_PACKET_BYTES) throw fail();
  return value;
}

function publicKey(encoded, type) {
  const key = crypto.createPublicKey({ key: decode(encoded, 44, 44), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== type || key.export({ format: "der", type: "spki" }).toString("base64url") !== encoded) throw fail();
  return key;
}

function validateIdentity(value) {
  exact(value, IDENTITY_KEYS);
  if (value.version !== 1 || !identifier(value.endpointId)) throw fail();
  publicKey(value.signingPublicKey, "ed25519"); publicKey(value.encryptionPublicKey, "x25519");
  return value;
}

function identityFingerprint(identity) { validateIdentity(identity); return hash(canonical(identity)); }
function canonicalManifest(manifest) { return canonical(validateManifest(manifest)); }
function manifestHash(manifest) { return hash(canonicalManifest(manifest)); }

function validateEndpoint(endpoint) {
  exact(endpoint, ["identity", "signingPrivateKey", "encryptionPrivateKey"]);
  validateIdentity(endpoint.identity);
  for (const [field, publicField, type] of [["signingPrivateKey", "signingPublicKey", "ed25519"], ["encryptionPrivateKey", "encryptionPublicKey", "x25519"]]) {
    const key = endpoint[field];
    if (!(key instanceof crypto.KeyObject) || key.type !== "private" || key.asymmetricKeyType !== type ||
        crypto.createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64url") !== endpoint.identity[publicField]) throw fail();
  }
  return endpoint;
}

function createEndpointIdentity(endpointId) {
  if (!identifier(endpointId)) throw fail();
  const signing = crypto.generateKeyPairSync("ed25519"), encryption = crypto.generateKeyPairSync("x25519");
  return { identity: Object.freeze({ version: 1, endpointId,
    signingPublicKey: signing.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    encryptionPublicKey: encryption.publicKey.export({ format: "der", type: "spki" }).toString("base64url") }),
  signingPrivateKey: signing.privateKey, encryptionPrivateKey: encryption.privateKey };
}

function createContentKeyEpoch(epoch) {
  if (!positive(epoch)) throw fail();
  return { epoch, key: crypto.randomBytes(32) };
}
function validateContentKey(value) {
  exact(value, ["epoch", "key"]);
  if (!positive(value.epoch) || !Buffer.isBuffer(value.key) || value.key.length !== 32) throw fail();
  return value;
}
function rotateContentKeyEpoch(previous, nextEpoch) {
  validateContentKey(previous);
  if (!positive(nextEpoch) || nextEpoch <= previous.epoch) throw fail();
  return createContentKeyEpoch(nextEpoch);
}

function aad(context, kind) {
  return Buffer.concat([Buffer.from(`HOAI-PROFILE-SYNC-v1:${kind}\0`), canonical(context)]);
}
function encrypt(key, plaintext, associated) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associated);
  return { iv: iv.toString("base64url"), ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
}
function decrypt(key, envelope, associated, max, length) {
  exact(envelope, ["iv", "ciphertext", "tag"]);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, decode(envelope.iv, 12, 12));
  decipher.setAAD(associated); decipher.setAuthTag(decode(envelope.tag, 16, 16));
  let update, final;
  try {
    update = decipher.update(decode(envelope.ciphertext, max, length));
    final = decipher.final();
    return Buffer.concat([update, final]);
  } finally { update?.fill(0); final?.fill(0); }
}
function wrappingKey(privateKey, peer, salt, context) {
  const shared = crypto.diffieHellman({ privateKey, publicKey: publicKey(peer, "x25519") });
  try { return Buffer.from(crypto.hkdfSync("sha256", shared, salt, aad(context, "key-derivation"), 32)); }
  finally { shared.fill(0); }
}

function sealCheckpoint({ plaintext, context, source, destinationIdentity, contentKeyEpoch }) {
  let wrapping;
  try {
    validateContext(context); validateEndpoint(source); validateIdentity(destinationIdentity); validateContentKey(contentKeyEpoch);
    if (!Buffer.isBuffer(plaintext) || !plaintext.length || plaintext.length > MAX_PLAINTEXT_BYTES ||
        source.identity.endpointId !== context.source.endpointId || destinationIdentity.endpointId !== context.destination.endpointId ||
        identityFingerprint(destinationIdentity) !== context.destination.keyFingerprint || contentKeyEpoch.epoch !== context.keyEpoch) throw fail();
    const ephemeral = crypto.generateKeyPairSync("x25519"), salt = crypto.randomBytes(32);
    wrapping = wrappingKey(ephemeral.privateKey, destinationIdentity.encryptionPublicKey, salt, context);
    const packet = { version: 1, content: encrypt(contentKeyEpoch.key, plaintext, aad(context, "content")),
      wrappedKey: { ephemeralPublicKey: ephemeral.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
        salt: salt.toString("base64url"), ...encrypt(wrapping, contentKeyEpoch.key, aad(context, "wrapped-key")) } };
    const bytes = canonical(packet);
    if (bytes.length > MAX_PACKET_BYTES) throw fail();
    const manifest = structuredClone({ ...context, ciphertextHash: hash(bytes), ciphertextBytes: bytes.length });
    const manifestSignature = crypto.sign(null, canonicalManifest(manifest), source.signingPrivateKey).toString("base64url");
    return { manifest, manifestSignature, ciphertext: bytes.toString("base64") };
  } catch { throw fail(); }
  finally { wrapping?.fill(0); }
}

function verifyManifest({ manifest, manifestSignature, sourceIdentity, expectedContext }) {
  try {
    validateManifest(manifest); validateIdentity(sourceIdentity); validateContext(expectedContext);
    if (manifest.source.endpointId !== sourceIdentity.endpointId || !canonical(contextOf(manifest)).equals(canonical(expectedContext))) return false;
    return crypto.verify(null, canonicalManifest(manifest), publicKey(sourceIdentity.signingPublicKey, "ed25519"), decode(manifestSignature, 64, 64));
  } catch { return false; }
}

function openCheckpoint({ checkpoint, expectedContext, sourceIdentity, destination }) {
  let wrapping, key, plaintext;
  try {
    exact(checkpoint, ["manifest", "manifestSignature", "ciphertext"]); validateEndpoint(destination); validateContext(expectedContext);
    const { manifest, manifestSignature, ciphertext } = checkpoint;
    if (!verifyManifest({ manifest, manifestSignature, sourceIdentity, expectedContext }) ||
        destination.identity.endpointId !== expectedContext.destination.endpointId ||
        identityFingerprint(destination.identity) !== expectedContext.destination.keyFingerprint) throw fail();
    const bytes = decodeWire(ciphertext);
    if (bytes.length !== manifest.ciphertextBytes || hash(bytes) !== manifest.ciphertextHash) throw fail();
    const packet = JSON.parse(bytes.toString("utf8"));
    exact(packet, ["version", "content", "wrappedKey"]);
    if (packet.version !== 1) throw fail();
    exact(packet.wrappedKey, ["ephemeralPublicKey", "salt", "iv", "ciphertext", "tag"]);
    wrapping = wrappingKey(destination.encryptionPrivateKey, packet.wrappedKey.ephemeralPublicKey, decode(packet.wrappedKey.salt, 32, 32), expectedContext);
    const wrapped = { iv: packet.wrappedKey.iv, ciphertext: packet.wrappedKey.ciphertext, tag: packet.wrappedKey.tag };
    key = decrypt(wrapping, wrapped, aad(expectedContext, "wrapped-key"), 32, 32);
    plaintext = decrypt(key, packet.content, aad(expectedContext, "content"), MAX_PLAINTEXT_BYTES);
    return { plaintext, contentKeyEpoch: { epoch: manifest.keyEpoch, key } };
  } catch { key?.fill(0); plaintext?.fill(0); throw fail(); }
  finally { wrapping?.fill(0); }
}

function assertSecureStorage(safeStorage, platform) {
  if (!safeStorage || safeStorage.isEncryptionAvailable?.() !== true ||
      typeof safeStorage.encryptString !== "function" || typeof safeStorage.decryptString !== "function") throw fail();
  const backend = safeStorage.getSelectedStorageBackend?.();
  if (backend === "basic_text" || platform === "linux" && !["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(backend)) throw fail();
}

// Return only an encrypted record; callers own private-directory/atomic IO.
function protectEndpointKeys({ endpoint, safeStorage, platform = process.platform }) {
  let signing, encryption;
  try {
    assertSecureStorage(safeStorage, platform); validateEndpoint(endpoint);
    signing = endpoint.signingPrivateKey.export({ format: "der", type: "pkcs8" });
    encryption = endpoint.encryptionPrivateKey.export({ format: "der", type: "pkcs8" });
    const body = JSON.stringify({ version: 1, identity: endpoint.identity, signingPrivateKey: signing.toString("base64url"), encryptionPrivateKey: encryption.toString("base64url") });
    const protectedBytes = safeStorage.encryptString(body);
    if (!Buffer.isBuffer(protectedBytes) || !protectedBytes.length || protectedBytes.length > MAX_KEY_RECORD_BYTES) throw fail();
    return { version: 1, identityFingerprint: identityFingerprint(endpoint.identity), ciphertext: protectedBytes.toString("base64url") };
  } catch { throw fail(); }
  finally { signing?.fill(0); encryption?.fill(0); }
}

function restoreEndpointKeys({ record, pinnedIdentity, safeStorage, platform = process.platform }) {
  let signing, encryption;
  try {
    assertSecureStorage(safeStorage, platform); validateIdentity(pinnedIdentity);
    exact(record, ["version", "identityFingerprint", "ciphertext"]);
    if (record.version !== 1 || record.identityFingerprint !== identityFingerprint(pinnedIdentity)) throw fail();
    const body = safeStorage.decryptString(decode(record.ciphertext, MAX_KEY_RECORD_BYTES));
    if (typeof body !== "string" || Buffer.byteLength(body) > MAX_KEY_RECORD_BYTES) throw fail();
    const data = JSON.parse(body);
    exact(data, ["version", "identity", "signingPrivateKey", "encryptionPrivateKey"]);
    if (data.version !== 1 || identityFingerprint(data.identity) !== identityFingerprint(pinnedIdentity)) throw fail();
    signing = decode(data.signingPrivateKey, 48, 48); encryption = decode(data.encryptionPrivateKey, 48, 48);
    const endpoint = { identity: Object.freeze({ ...pinnedIdentity }),
      signingPrivateKey: crypto.createPrivateKey({ key: signing, format: "der", type: "pkcs8" }),
      encryptionPrivateKey: crypto.createPrivateKey({ key: encryption, format: "der", type: "pkcs8" }) };
    return validateEndpoint(endpoint);
  } catch { throw fail(); }
  finally { signing?.fill(0); encryption?.fill(0); }
}

module.exports = { MAX_PLAINTEXT_BYTES, MAX_PACKET_BYTES, MAX_WIRE_BYTES, createEndpointIdentity, identityFingerprint,
  createContentKeyEpoch, rotateContentKeyEpoch, canonicalManifest, manifestHash, verifyManifest,
  sealCheckpoint, openCheckpoint, protectEndpointKeys, restoreEndpointKeys };
