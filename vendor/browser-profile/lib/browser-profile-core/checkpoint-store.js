"use strict";

// Trusted main/host code only. This is an encrypted local recovery journal,
// never writer authority or evidence of the server's current head. Callers
// supply fresh authority and enrolled endpoint pins on every read and write.
// The containing user directory and OS account are trusted. Node has no
// portable dirfd-relative rename, and this is not an administrator/same-user
// isolation boundary. Windows requires the caller's private userData ACLs.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const codec = require("./crypto");
const MAX_RECORD_BYTES = codec.MAX_WIRE_BYTES + 16 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH = /^[a-f0-9]{64}$/;
const SCOPE = ["actingUserId", "assistantId", "profileId", "endpointId", "keyFingerprint", "grantVersion"];
const SOURCE = ["endpointId", "bootId", "runtimeId", "sessionId", "writerEpoch"];
const DESTINATION = ["endpointId", "bootId", "runtimeId", "sessionId", "grantVersion", "keyFingerprint"];
const fail = (code = "profile_checkpoint_refused") => Object.assign(new Error(code), { code });
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function authority(check) {
  if (typeof check !== "function") throw fail();
  try { if (await check() === false) throw fail(); }
  catch (error) { if (error?.code?.startsWith("profile_checkpoint_")) throw error; throw fail(); }
}

function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key) ||
      !Object.hasOwn(descriptors[key], "value") || !descriptors[key].enumerable)) throw fail();
  return value;
}
function canonical(value) {
  const sort = object => object && typeof object === "object" ? Object.fromEntries(Object.keys(object).sort().map(key => [key, sort(object[key])])) : object;
  return JSON.stringify(sort(value));
}
function frozen(value) {
  if (value && typeof value === "object") { for (const item of Object.values(value)) frozen(item); Object.freeze(value); }
  return value;
}
function scopeOf(value) {
  exact(value, SCOPE);
  if (!["actingUserId", "profileId", "endpointId"].every(key => typeof value[key] === "string" && ID.test(value[key])) ||
      !positive(value.assistantId) || !positive(value.grantVersion) || typeof value.keyFingerprint !== "string" || !HASH.test(value.keyFingerprint)) throw fail();
  return frozen({ ...value });
}
function headOf(value) {
  exact(value, ["manifestHash", "revision", "keyEpoch"]);
  if (typeof value.manifestHash !== "string" || !HASH.test(value.manifestHash) || !positive(value.revision) || !positive(value.keyEpoch)) throw fail();
  return frozen({ ...value });
}
function binary(value, maximum, length) {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(maximum * 4 / 3) + 4 || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length > maximum || length !== undefined && bytes.length !== length || bytes.toString("base64url") !== value) throw fail();
  return bytes;
}
function encryptedPacket(checkpoint) {
  if (typeof checkpoint.ciphertext !== "string" || !checkpoint.ciphertext.length || checkpoint.ciphertext.length > codec.MAX_WIRE_BYTES ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(checkpoint.ciphertext)) throw fail();
  const bytes = Buffer.from(checkpoint.ciphertext, "base64");
  if (bytes.length > codec.MAX_PACKET_BYTES || bytes.toString("base64") !== checkpoint.ciphertext ||
      bytes.length !== checkpoint.manifest.ciphertextBytes || sha(bytes) !== checkpoint.manifest.ciphertextHash) throw fail();
  const packet = JSON.parse(bytes.toString("utf8"));
  exact(packet, ["version", "content", "wrappedKey"]);
  if (packet.version !== 1) throw fail();
  exact(packet.content, ["iv", "ciphertext", "tag"]);
  exact(packet.wrappedKey, ["ephemeralPublicKey", "salt", "iv", "ciphertext", "tag"]);
  for (const envelope of [packet.content, packet.wrappedKey]) { binary(envelope.iv, 12, 12); binary(envelope.tag, 16, 16); }
  binary(packet.content.ciphertext, codec.MAX_PLAINTEXT_BYTES);
  binary(packet.wrappedKey.ciphertext, 32, 32); binary(packet.wrappedKey.salt, 32, 32);
  const encoded = binary(packet.wrappedKey.ephemeralPublicKey, 44, 44);
  const key = crypto.createPublicKey({ key: encoded, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "x25519" || !key.export({ format: "der", type: "spki" }).equals(encoded)) throw fail();
  if (canonical(packet) !== bytes.toString("utf8")) throw fail();
}
function validateRecord(value, scope, expectedHead) {
  if (!value || typeof value !== "object") throw fail();
  const version = Object.getOwnPropertyDescriptor(value, "version")?.value;
  exact(value, ["version", "scope", "manifestHash", "checkpoint", "receipt", "receiptSignature", ...(version === 2 || version === 3 ? ["readdress"] : [])]);
  if (![1, 2, 3].includes(version) || canonical(scopeOf(value.scope)) !== canonical(scope)) throw fail();
  exact(value.checkpoint, ["manifest", "manifestSignature", "ciphertext"]);
  const manifest = value.checkpoint.manifest;
  if (codec.manifestHash(manifest) !== value.manifestHash || manifest.actingUserId !== scope.actingUserId ||
      manifest.profileId !== scope.profileId || manifest.assistantId !== scope.assistantId) throw fail();
  if (expectedHead && (value.manifestHash !== expectedHead.manifestHash || manifest.revision !== expectedHead.revision || manifest.keyEpoch !== expectedHead.keyEpoch)) throw fail("profile_checkpoint_stale");
  binary(value.checkpoint.manifestSignature, 64, 64); binary(value.receiptSignature, 64, 64);
  encryptedPacket(value.checkpoint);
  const receipt = value.receipt;
  const kind = receipt && Object.getOwnPropertyDescriptor(receipt, "kind");
  if (!kind || !Object.hasOwn(kind, "value")) throw fail();
  if (kind.value === "source-stopped") {
    if (version !== 1) throw fail();
    exact(receipt, ["version", "kind", "profileId", "transitionId", "manifestHash", "revision", "source", "stopped"]);
    exact(receipt.source, SOURCE);
    if (receipt.stopped !== true || canonical(receipt.source) !== canonical(manifest.source) || scope.endpointId !== manifest.source.endpointId) throw fail();
  } else if (kind.value === "destination-staged") {
    exact(receipt, ["version", "kind", "profileId", "transitionId", "manifestHash", "revision", "destination", "stagedInactive"]);
    exact(receipt.destination, DESTINATION);
    if (receipt.stagedInactive !== true || version === 1 && canonical(receipt.destination) !== canonical(manifest.destination) ||
        scope.endpointId !== manifest.destination.endpointId || scope.keyFingerprint !== manifest.destination.keyFingerprint ||
        scope.grantVersion !== manifest.destination.grantVersion) throw fail();
  } else throw fail();
  if (receipt.version !== 1 || receipt.profileId !== manifest.profileId || version === 1 && receipt.transitionId !== manifest.transitionId ||
      receipt.manifestHash !== value.manifestHash || receipt.revision !== manifest.revision) throw fail();
  if (version === 2 || version === 3) {
    exact(value.readdress, ["document", "signature", ...(version === 3 ? ["agentRetirement"] : [])]); binary(value.readdress.signature, 64, 64);
    const document = value.readdress.document;
    exact(document, ["version", "kind", "profileId", "actingUserId", "assistantId", "transitionId", "expectedTransitionId", "manifestHash", "expectedRevision", "expectedWriterEpoch", "expectedKeyEpoch", "destination"]);
    exact(document.destination, DESTINATION);
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    if (document.version !== 1 || document.kind !== (version === 3 ? "agent-stopped-head-readdress" : "stopped-head-readdress") || document.profileId !== manifest.profileId || document.actingUserId !== manifest.actingUserId || document.assistantId !== manifest.assistantId ||
        !uuid.test(document.transitionId) || !uuid.test(document.expectedTransitionId) || document.transitionId === document.expectedTransitionId || document.transitionId === manifest.transitionId ||
        document.transitionId !== receipt.transitionId || document.manifestHash !== value.manifestHash || document.expectedRevision !== manifest.revision || document.expectedKeyEpoch !== manifest.keyEpoch || document.expectedWriterEpoch !== manifest.source.writerEpoch ||
        canonical(document.destination) !== canonical(receipt.destination) || document.destination.endpointId !== scope.endpointId || document.destination.keyFingerprint !== scope.keyFingerprint || document.destination.grantVersion !== scope.grantVersion ||
        ["bootId", "runtimeId", "sessionId"].some(key => typeof document.destination[key] !== "string" || !ID.test(document.destination[key]) || document.destination[key].length > 128 || document.destination[key] === manifest.destination[key])) throw fail();
    if (version === 3) {
      exact(value.readdress.agentRetirement, ["document", "signature"]); binary(value.readdress.agentRetirement.signature, 64, 64);
      const retired = value.readdress.agentRetirement.document;
      exact(retired, ["version", "kind", "profileId", "authority", "transitionId", "manifestHash", "revision", "destination"]);
      if (retired.version !== 1 || retired.kind !== "agent-runtime-retire" || retired.profileId !== manifest.profileId || retired.transitionId !== manifest.transitionId || retired.manifestHash !== value.manifestHash || retired.revision !== manifest.revision || manifest.source.endpointId !== scope.endpointId || canonical(retired.destination) !== canonical(manifest.destination)) throw fail();
    }
  }
  return value;
}

class EncryptedCheckpointStore {
  constructor({ dir, verifyRecord, verifyAgentRecord = null, filesystem = fs.promises, platform = process.platform }) {
    if (typeof dir !== "string" || !path.isAbsolute(dir) || typeof verifyRecord !== "function" || verifyAgentRecord !== null && typeof verifyAgentRecord !== "function") throw fail();
    this.dir = path.resolve(dir); this.verifyRecord = verifyRecord; this.verifyAgentRecord = verifyAgentRecord; this.fs = filesystem; this.platform = platform; this.busy = new Set();
  }
  _paths(scope) {
    const directory = path.join(this.dir, sha(Buffer.from(canonical(scope))));
    return { directory, file: path.join(directory, "checkpoint.json") };
  }
  async _syncDirectory(directory) {
    // Node cannot promise atomic rename metadata durability after power loss on
    // Windows. Keep this limitation explicit even when the file was synced.
    if (this.platform === "win32") return false;
    let handle;
    try {
      handle = await this.fs.open(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
      await handle.sync(); return true;
    } catch (error) {
      if (["EINVAL", "ENOTSUP", "ENOSYS", "EISDIR"].includes(error?.code)) return false;
      throw error;
    } finally { await handle?.close(); }
  }
  _directoryStat(stat, privateDirectory) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
    if (privateDirectory && this.platform !== "win32" && ((stat.mode & 0o077) !== 0 || typeof process.getuid === "function" && stat.uid !== process.getuid())) throw fail();
  }
  async _directory(directory, create) {
    const root = path.parse(directory).root, parts = directory.slice(root.length).split(path.sep).filter(Boolean);
    let current = root, result, synced = true;
    for (const part of parts) {
      current = path.join(current, part);
      try { result = await this.fs.lstat(current); }
      catch (error) {
        if (error?.code !== "ENOENT" || !create) { if (error?.code === "ENOENT") return null; throw error; }
        try { await this.fs.mkdir(current, { mode: 0o700 }); } catch (raced) { if (raced?.code !== "EEXIST") throw raced; }
        result = await this.fs.lstat(current); synced = await this._syncDirectory(path.dirname(current)) && synced;
      }
      this._directoryStat(result, current === this.dir || path.dirname(current) === this.dir);
    }
    return { stat: result, synced };
  }
  _sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
  async _assertDirectory(directory, expected) {
    const current = await this._directory(directory, false);
    if (!current || !this._sameFile(current.stat, expected)) throw fail();
  }
  _fileStat(stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX_RECORD_BYTES ||
        this.platform !== "win32" && ((stat.mode & 0o077) !== 0 || typeof process.getuid === "function" && stat.uid !== process.getuid())) throw fail();
  }
  async _existing(file) {
    try { const stat = await this.fs.lstat(file); this._fileStat(stat); return stat; }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }
  async _verified(record, scope, expectedHead, assertCurrent) {
    validateRecord(record, scope, expectedHead);
    // Pin verification is injected by trusted code, never deserialized from the
    // record. Verify manifest/receipt and the v2 readdress request signatures
    // against fresh enrolled identities. A local request is not a server ACK.
    if (await this.verifyRecord({ record, scope, expectedHead: expectedHead || null }) !== true) throw fail();
    if (record.version === 3 && (typeof this.verifyAgentRecord !== "function" || await this.verifyAgentRecord({ record, scope, expectedHead: expectedHead || null }) !== true)) throw fail();
    await assertCurrent();
  }
  async _run(scope, check, work) {
    scope = scopeOf(scope);
    if (typeof check !== "function") throw fail();
    const paths = this._paths(scope);
    if (this.busy.has(paths.directory)) throw fail("profile_checkpoint_busy");
    this.busy.add(paths.directory);
    const current = () => authority(check);
    try { await current(); return await work(scope, paths, current); }
    catch (error) { if (error?.code?.startsWith("profile_checkpoint_")) throw error; throw fail(); }
    finally { this.busy.delete(paths.directory); }
  }
  async write({ scope, checkpoint, manifestHash, receipt, receiptSignature, readdress, assertCurrent }) {
    // Validate before JSON serialization so accessors or cyclic payloads cannot
    // run during the first asynchronous authority check.
    const version = readdress === undefined ? 1 : readdress && Object.getOwnPropertyDescriptor(readdress, "agentRetirement") ? 3 : 2;
    const raw = { version, scope: scopeOf(scope), checkpoint, manifestHash, receipt, receiptSignature, ...(readdress === undefined ? {} : { readdress }) };
    validateRecord(raw, raw.scope);
    const encoded = Buffer.from(canonical(raw));
    if (encoded.length > MAX_RECORD_BYTES) throw fail();
    const record = frozen(JSON.parse(encoded.toString("utf8")));
    return this._run(record.scope, assertCurrent, async (bound, paths, check) => {
      await this._verified(record, bound, null, check);
      const directory = await this._directory(paths.directory, true);
      await this._existing(paths.file); await check(); await this._assertDirectory(paths.directory, directory.stat);
      const temporary = path.join(paths.directory, `.checkpoint-${crypto.randomUUID()}.tmp`);
      let handle, renamed = false;
      try {
        handle = await this.fs.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        await handle.writeFile(encoded); await handle.sync(); await handle.close(); handle = null;
        await check(); await this._assertDirectory(paths.directory, directory.stat); await this._existing(paths.file);
        await this.fs.rename(temporary, paths.file); renamed = true;
        const directorySynced = await this._syncDirectory(paths.directory) && directory.synced;
        await check(); await this._assertDirectory(paths.directory, directory.stat);
        return { record, durability: Object.freeze({ fileSynced: true, directorySynced, powerLossDurability: directorySynced ? "filesystem-dependent" : "not-guaranteed" }) };
      } finally {
        await handle?.close();
        if (!renamed) { try { await this.fs.unlink(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
      }
    });
  }
  async read({ scope, expectedHead, assertCurrent }) {
    const head = headOf(expectedHead);
    return this._read(scope, head, assertCurrent);
  }
  async inspectCandidate({ scope, assertCurrent }) {
    // A signed local candidate can predate an uncertain HTTP write. Discovery
    // returns advisory metadata only and never supplies a current server head,
    // ciphertext, execution authority or permission to replay that write.
    const record = await this._read(scope, null, assertCurrent);
    await authority(assertCurrent);
    if (!record) return null;
    const manifest = record.checkpoint.manifest;
    return frozen({ kind: "verified-local-candidate", scope: record.scope, manifestHash: record.manifestHash,
      revision: manifest.revision, keyEpoch: manifest.keyEpoch, cryptoTransitionId: manifest.transitionId,
      coordinatorTransitionId: record.receipt.transitionId, receiptKind: record.receipt.kind,
      source: manifest.source, destination: manifest.destination });
  }
  async _read(scope, head, assertCurrent) {
    return this._run(scope, assertCurrent, async (bound, paths, check) => {
      const directory = await this._directory(paths.directory, false);
      if (!directory) { await check(); return null; }
      const before = await this._existing(paths.file);
      if (!before) { await check(); return null; }
      let handle;
      try {
        handle = await this.fs.open(paths.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = await handle.stat(); this._fileStat(stat);
        if (!this._sameFile(before, stat)) throw fail();
        const bytes = Buffer.alloc(stat.size + 1); let used = 0;
        while (used < bytes.length) { const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used); if (!bytesRead) break; used += bytesRead; }
        if (used !== stat.size) throw fail();
        const after = await handle.stat(); this._fileStat(after);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw fail();
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)), parsed = JSON.parse(text);
        // Only our canonical encrypted schema is a journal. Plaintext exports,
        // duplicate keys and incidental JSON files are never accepted.
        if (canonical(parsed) !== text) throw fail();
        const record = frozen(validateRecord(parsed, bound, head));
        await this._verified(record, bound, head, check);
        const current = await this._existing(paths.file);
        if (!current || !this._sameFile(stat, current) || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) throw fail();
        await this._assertDirectory(paths.directory, directory.stat); await check();
        return record;
      } finally { await handle?.close(); }
    });
  }
  async remove({ scope, assertRevoked }) {
    return this._run(scope, assertRevoked, async (_bound, paths, check) => {
      const directory = await this._directory(paths.directory, false);
      if (!directory) { await check(); return { removed: false }; }
      const existing = await this._existing(paths.file);
      if (!existing) { await check(); return { removed: false }; }
      await check(); await this._assertDirectory(paths.directory, directory.stat); await this.fs.unlink(paths.file);
      const directorySynced = await this._syncDirectory(paths.directory); await check();
      return { removed: true, directorySynced };
    });
  }
}

module.exports = { EncryptedCheckpointStore, MAX_RECORD_BYTES };
