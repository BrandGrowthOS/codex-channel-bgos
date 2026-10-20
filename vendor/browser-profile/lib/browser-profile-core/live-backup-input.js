"use strict";
const { KeyObject } = require("node:crypto");
const { exactAuthority } = require("./coordinator-client");
const MAX_BYTES = 16 * 1024 * 1024, HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const AUTHORITY_FIELDS = ["profileId", "actingUserId", "assistantId", "endpointId", "bootId", "runtimeId", "sessionId", "writerEpoch", "revision", "contentKeyEpoch", "grantVersion", "keyFingerprint"];
const fail = () => Object.assign(new Error("profile_live_input_invalid"), { code: "profile_live_input_invalid" });
function exact(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== fields.length) throw fail();
  for (const field of fields) { const descriptor = Object.getOwnPropertyDescriptor(value, field); if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw fail(); }
}
function identity(value) {
  exact(value, ["version", "endpointId", "signingPublicKey", "encryptionPublicKey"]);
  if (value.version !== 1 || typeof value.endpointId !== "string" || !UUID.test(value.endpointId) || [value.signingPublicKey, value.encryptionPublicKey].some(key => typeof key !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(key))) throw fail();
}
function endpoint(value) {
  exact(value, ["identity", "signingPrivateKey", "encryptionPrivateKey"]); identity(value.identity);
  if (![value.signingPrivateKey, value.encryptionPrivateKey].every(key => key instanceof KeyObject && key.type === "private")) throw fail();
}
function validateSealRequest(value) {
  exact(value, ["snapshotId", "sequence", "previousBundleHash", "source", "recipients", "contentKeyEpoch"]);
  if (typeof value.snapshotId !== "string" || !UUID.test(value.snapshotId) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !(value.previousBundleHash === null || typeof value.previousBundleHash === "string" && HASH.test(value.previousBundleHash))) throw fail();
  endpoint(value.source);
  if (!Array.isArray(value.recipients) || !value.recipients.length || value.recipients.length > 4 || Reflect.ownKeys(value.recipients).length !== value.recipients.length + 1) throw fail();
  for (let i = 0; i < value.recipients.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.recipients, String(i)); if (!descriptor || !Object.hasOwn(descriptor, "value")) throw fail();
    const recipient = descriptor.value; exact(recipient, ["identity", "keyFingerprint", "grantVersion"]); identity(recipient.identity);
    if (typeof recipient.keyFingerprint !== "string" || !HASH.test(recipient.keyFingerprint) || !Number.isSafeInteger(recipient.grantVersion) || recipient.grantVersion < 1) throw fail();
  }
  exact(value.contentKeyEpoch, ["epoch", "key"]);
  if (!Number.isSafeInteger(value.contentKeyEpoch.epoch) || value.contentKeyEpoch.epoch < 1 || !(value.contentKeyEpoch.key instanceof Uint8Array) || !(value.contentKeyEpoch.key.buffer instanceof ArrayBuffer) || value.contentKeyEpoch.key.byteLength !== 32) throw fail();
  return value;
}
// Bound aggregate native draft bytes/nodes before any clone or JSON parse.
// The worker still validates the full portable schema before encryption.
function preflightSealInput(value) {
  exact(value, ["draft", "authority", "request", "captureKind"]); exact(value.authority, AUTHORITY_FIELDS); exactAuthority(value.authority); validateSealRequest(value.request);
  if (value.captureKind !== "live-best-effort") throw fail(); exact(value.draft, ["cookies", "origins", "extras"]);
  if (!Array.isArray(value.draft.origins) || value.draft.origins.length > 100 || !Array.isArray(value.draft.cookies) || value.draft.cookies.length > 10000) throw fail();
  let bytes = 0, nodes = 0; const ancestors = new Set();
  const visit = (row, depth = 0) => {
    if (++nodes > 200000 || depth > 100) throw fail();
    if (typeof row === "string") bytes += Buffer.byteLength(row) + 2;
    else if (row === null || typeof row === "boolean" || typeof row === "number" && Number.isFinite(row)) bytes += 16;
    else {
      const array = Array.isArray(row);
      if (!row || !array && Object.getPrototypeOf(row) !== Object.prototype || ancestors.has(row) || array && row.length > 200000 - nodes) throw fail();
      const keys = Reflect.ownKeys(row); if (keys.length > 200000 - nodes + (array ? 1 : 0) || array && keys.length !== row.length + 1) throw fail();
      ancestors.add(row);
      for (const key of keys) {
        if (array && key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(row, key); if (typeof key !== "string" || !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw fail();
        bytes += Buffer.byteLength(key) + 4; visit(descriptor.value, depth + 1);
      }
      ancestors.delete(row);
    }
    if (bytes > MAX_BYTES) throw fail();
  };
  visit(value.draft); return value;
}
module.exports = { validateSealRequest, preflightSealInput, exact, identity };
