"use strict";
const { verify } = require("node:crypto");
const { exactAuthority, sameAuthority, canonical } = require("./coordinator-client");
const { identityFingerprint, verifyManifest, manifestHash } = require("./crypto");
const capabilities = new WeakMap(), fail = () => Object.assign(new Error("profile_stopped_head_stage_refused"), { code: "profile_stopped_head_stage_refused" });
const DOCUMENT_FIELDS = ["version", "kind", "profileId", "actingUserId", "assistantId", "transitionId", "expectedTransitionId", "manifestHash", "expectedRevision", "expectedWriterEpoch", "expectedKeyEpoch", "destination"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const equal = (a, b) => canonical(a).equals(canonical(b));
const destinationOf = value => Object.fromEntries(["endpointId", "bootId", "runtimeId", "sessionId", "grantVersion", "keyFingerprint"].map(key => [key, value[key]]));
const SOURCE = ["endpointId", "bootId", "runtimeId", "sessionId", "writerEpoch"];
const AUTHORITY = ["profileId", "actingUserId", "assistantId", "endpointId", "bootId", "runtimeId", "sessionId", "writerEpoch", "revision", "contentKeyEpoch", "grantVersion", "keyFingerprint"];
function exactData(value, fields) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], "value"))) throw fail();
}
function signed(document, signature, identity) {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  const bytes = Buffer.from(signature, "base64url");
  return bytes.length === 64 && bytes.toString("base64url") === signature && verify(null, canonical(document), { key: Buffer.from(identity.signingPublicKey, "base64url"), type: "spki", format: "der" }, bytes);
}
/** Cryptographic lineage only. This never proves a current server head. */
function verifyAgentRetirement({ agentRetirement, context, endpointIdentity }) {
  try {
    exactData(agentRetirement, ["document", "signature"]);
    const document = agentRetirement.document;
    exactData(document, ["version", "kind", "profileId", "authority", "transitionId", "manifestHash", "revision", "destination"]);
    exactData(document.authority, AUTHORITY); const old = exactAuthority(document.authority), pin = identityFingerprint(endpointIdentity);
    if (document.version !== 1 || document.kind !== "agent-runtime-retire" || document.profileId !== context.profileId || document.transitionId !== context.transitionId || document.revision !== context.revision ||
        old.profileId !== context.profileId || old.actingUserId !== context.actingUserId || old.assistantId !== context.assistantId || old.revision + 1 !== context.revision || old.contentKeyEpoch !== context.keyEpoch ||
        old.endpointId !== endpointIdentity.endpointId || old.endpointId !== context.source.endpointId || old.endpointId !== context.destination.endpointId || old.keyFingerprint !== pin || context.destination.keyFingerprint !== pin || old.grantVersion !== context.destination.grantVersion ||
        !equal(Object.fromEntries(SOURCE.map(key => [key, old[key]])), context.source) || !equal(document.destination, context.destination) || !signed(document, agentRetirement.signature, endpointIdentity)) return false;
    return true;
  } catch { return false; }
}
function current(callback) {
  const value = callback();
  if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail(); }
  if (value === false) throw fail();
}
function frozen(value) { if (value && typeof value === "object") { for (const item of Object.values(value)) frozen(item); Object.freeze(value); } return value; }

// Main-only, one-use admission for the same enrolled endpoint after a verified
// stopped head was readdressed to this new process. A signed request alone is
// advisory; the caller supplies its freshly acknowledged HOAI response and a
// synchronous owner/epoch capability. Neither is accepted through renderer IPC.
function createAuthorization({ authority: rawAuthority, document, signature, response, checkpoint, sourceIdentity, destination, assertCurrent }, purpose) {
  const authority = exactAuthority(rawAuthority);
  if (typeof assertCurrent !== "function") throw fail();
  current(assertCurrent);
  document = frozen(structuredClone(document)); response = frozen(structuredClone(response));
  const profile = response.profile, transition = response.transition, context = response.originalContext, hash = manifestHash(checkpoint?.manifest);
  const target = destinationOf(authority);
  if (!document || Object.keys(document).length !== DOCUMENT_FIELDS.length || DOCUMENT_FIELDS.some(key => !Object.hasOwn(document, key)) || document.version !== 1 || document.kind !== purpose ||
      !UUID.test(document.transitionId) || !UUID.test(document.expectedTransitionId) || document.transitionId === document.expectedTransitionId ||
      document.profileId !== authority.profileId || document.actingUserId !== authority.actingUserId || document.assistantId !== authority.assistantId ||
      !equal(document.destination, target) || document.manifestHash !== hash || document.expectedRevision !== authority.revision ||
      document.expectedKeyEpoch !== authority.contentKeyEpoch || document.expectedWriterEpoch + 1 !== authority.writerEpoch ||
      profile?.id !== authority.profileId || profile.actingUserId !== authority.actingUserId || profile.assistantId !== authority.assistantId || profile.writerState !== "stopped" ||
      profile.headManifestHash !== hash || profile.revision !== authority.revision || profile.contentKeyEpoch !== authority.contentKeyEpoch || profile.writerEpoch !== document.expectedWriterEpoch ||
      transition?.id !== document.transitionId || transition.profileId !== authority.profileId || transition.kind !== "stopped_head_readdress" || transition.phase !== "checkpoint_committed" ||
      transition.supersedesTransitionId !== document.expectedTransitionId || transition.capsuleTransitionId !== context?.transitionId || transition.capsuleTransitionId === transition.id || transition.supersededByTransitionId !== null ||
      transition.manifestHash !== hash || transition.sourceRevision + 1 !== authority.revision || transition.contentKeyEpoch !== authority.contentKeyEpoch ||
      !equal(transition.destination, target) || !equal(transition.source, context.source) || transition.sourceManifestHash !== context.previousManifestHash ||
      context.profileId !== authority.profileId || context.actingUserId !== authority.actingUserId || context.assistantId !== authority.assistantId || context.revision !== authority.revision || context.keyEpoch !== authority.contentKeyEpoch ||
      context.source.writerEpoch !== document.expectedWriterEpoch || context.destination.endpointId !== authority.endpointId || context.destination.keyFingerprint !== authority.keyFingerprint || context.destination.grantVersion !== authority.grantVersion ||
      ["endpointId", "bootId", "runtimeId", "sessionId"].some(key => profile[key] !== context.source[key]) ||
      ["bootId", "runtimeId", "sessionId"].some(key => context.destination[key] === target[key]) ||
      destination?.identity?.endpointId !== authority.endpointId || identityFingerprint(destination.identity) !== authority.keyFingerprint ||
      sourceIdentity?.endpointId !== context.source.endpointId || !verifyManifest({ ...checkpoint, sourceIdentity, expectedContext: context }) ||
      typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature) || !verify(null, canonical(document), { key: Buffer.from(destination.identity.signingPublicKey, "base64url"), type: "spki", format: "der" }, Buffer.from(signature, "base64url"))) throw fail();
  current(assertCurrent);
  const capability = Object.freeze({ kind: "stopped-head-readdress-stage" });
  capabilities.set(capability, { authority, context, hash, sourcePin: identityFingerprint(sourceIdentity), destinationPin: authority.keyFingerprint,
    transitionId: transition.id, assertCurrent, binding: frozen({ document, signature, ...(purpose === "agent-stopped-head-readdress" ? { agentRetirement: response.agentRetirement } : {}) }) });
  return capability;
}
function createStoppedHeadStageAuthorization(options) { return createAuthorization(options, "stopped-head-readdress"); }
function createAgentStoppedHeadStageAuthorization(options) {
  const input = { ...options, document: structuredClone(options.document), response: structuredClone(options.response) };
  exactData(input.authority, AUTHORITY);
  if (!verifyAgentRetirement({ agentRetirement: input.response?.agentRetirement, context: input.response?.originalContext, endpointIdentity: input.destination?.identity }) ||
      input.response.agentRetirement.document.manifestHash !== manifestHash(input.checkpoint?.manifest) || identityFingerprint(input.sourceIdentity) !== identityFingerprint(input.destination?.identity)) throw fail();
  return createAuthorization(input, "agent-stopped-head-readdress");
}
/** Explicit v3 journal verification against a main-owned endpoint pin. */
function verifyAgentStoppedHeadJournalRecord({ record, endpointIdentity }) {
  try {
    if (record?.version !== 3) return false;
    exactData(record, ["version", "scope", "manifestHash", "checkpoint", "receipt", "receiptSignature", "readdress"]);
    exactData(record.scope, ["actingUserId", "assistantId", "profileId", "endpointId", "keyFingerprint", "grantVersion"]);
    exactData(record.readdress, ["document", "signature", "agentRetirement"]);
    const context = Object.fromEntries(Object.entries(record.checkpoint.manifest).filter(([key]) => !["ciphertextHash", "ciphertextBytes"].includes(key))), hash = manifestHash(record.checkpoint.manifest);
    const document = record.readdress.document, receipt = record.receipt, scope = record.scope;
    exactData(document, DOCUMENT_FIELDS);
    exactData(receipt, ["version", "kind", "profileId", "transitionId", "manifestHash", "revision", "destination", "stagedInactive"]);
    exactData(document.destination, ["endpointId", "bootId", "runtimeId", "sessionId", "grantVersion", "keyFingerprint"]);
    exactData(receipt.destination, ["endpointId", "bootId", "runtimeId", "sessionId", "grantVersion", "keyFingerprint"]);
    return document.version === 1 && document.kind === "agent-stopped-head-readdress" && receipt.version === 1 && receipt.kind === "destination-staged" && receipt.stagedInactive === true &&
      UUID.test(document.transitionId) && UUID.test(document.expectedTransitionId) && document.transitionId !== document.expectedTransitionId && document.transitionId !== context.transitionId &&
      document.profileId === context.profileId && document.actingUserId === context.actingUserId && document.assistantId === context.assistantId &&
      document.manifestHash === hash && document.expectedRevision === context.revision && document.expectedWriterEpoch === context.source.writerEpoch && document.expectedKeyEpoch === context.keyEpoch &&
      receipt.profileId === context.profileId && receipt.transitionId === document.transitionId && receipt.manifestHash === hash && receipt.revision === context.revision && equal(receipt.destination, document.destination) &&
      ["profileId", "actingUserId", "assistantId"].every(key => scope[key] === context[key]) && scope.grantVersion === context.destination.grantVersion &&
      document.destination.endpointId === scope.endpointId && document.destination.keyFingerprint === scope.keyFingerprint && document.destination.grantVersion === scope.grantVersion &&
      ["bootId", "runtimeId", "sessionId"].every(key => typeof document.destination[key] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(document.destination[key]) && document.destination[key] !== context.destination[key]) &&
      record.manifestHash === hash && record.readdress.agentRetirement.document.manifestHash === hash &&
      identityFingerprint(endpointIdentity) === scope.keyFingerprint && endpointIdentity.endpointId === scope.endpointId &&
      verifyManifest({ ...record.checkpoint, sourceIdentity: endpointIdentity, expectedContext: context }) &&
      signed(record.receipt, record.receiptSignature, endpointIdentity) && signed(record.readdress.document, record.readdress.signature, endpointIdentity) &&
      verifyAgentRetirement({ agentRetirement: record.readdress.agentRetirement, context, endpointIdentity });
  } catch { return false; }
}
function consumeStoppedHeadStageAuthorization(authorization, { authority, checkpoint, originalContext, sourceIdentity, destination }) {
  const entry = capabilities.get(authorization); if (!entry) throw fail(); capabilities.delete(authorization);
  current(entry.assertCurrent);
  if (!sameAuthority(authority, entry.authority) || !equal(originalContext, entry.context) || manifestHash(checkpoint?.manifest) !== entry.hash ||
      identityFingerprint(sourceIdentity) !== entry.sourcePin || identityFingerprint(destination?.identity) !== entry.destinationPin) throw fail();
  return Object.freeze({ transitionId: entry.transitionId, binding: entry.binding, assertCurrent: () => current(entry.assertCurrent) });
}
module.exports = { createStoppedHeadStageAuthorization, createAgentStoppedHeadStageAuthorization, consumeStoppedHeadStageAuthorization, verifyAgentRetirement, verifyAgentStoppedHeadJournalRecord };
