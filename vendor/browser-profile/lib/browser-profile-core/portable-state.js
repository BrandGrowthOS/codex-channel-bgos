"use strict";

// Pure main/daemon-only wire codec. No filesystem, renderer or browser access.
// Cookie attributes and rich origin records retain their existing native
// import validators; this layer owns the envelope, vault and preference schema.
const SCHEMA = "hoai-portable-profile-state-v1";
const MAX_BYTES = 16 * 1024 * 1024, MAX_ROWS = 10000, MAX_ORIGINS = 100;
const ENGINES = Object.freeze(["google", "bing", "duckduckgo"]);
const VAULT_FIELDS = ["v", "entries", "neverOrigins"];
const ENTRY_FIELDS = ["id", "origin", "username", "password", "name", "createdAt", "updatedAt"];
const fail = () => Object.assign(new Error("profile_portable_state_invalid"), { code: "profile_portable_state_invalid" });
const plain = value => !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exact(value, fields) {
  if (!plain(value)) throw fail();
  if (Reflect.ownKeys(value).length !== fields.length) throw fail();
  for (const key of fields) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw fail(); }
}
function origin(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && url.origin === value; } catch { return false; }
}
// Reject values JSON would silently discard/coerce, getters, sparse arrays,
// cycles and unbounded trees before serializing a privileged secret snapshot.
function boundedJson(value) {
  let bytes = 0, nodes = 0; const ancestors = new Set();
  const walk = (row, depth) => {
    if (++nodes > 200000 || depth > 100) throw fail();
    if (row === null) bytes += 4;
    else if (typeof row === "boolean") bytes += row ? 4 : 5;
    else if (typeof row === "number") { if (!Number.isFinite(row) || Object.is(row, -0)) throw fail(); bytes += String(row).length; }
    else if (typeof row === "string") { if (row.length > MAX_BYTES) throw fail(); bytes += Buffer.byteLength(JSON.stringify(row)); }
    else {
      if ((!Array.isArray(row) && !plain(row)) || ancestors.has(row)) throw fail();
      const array = Array.isArray(row);
      if (array && row.length > 200000 - nodes) throw fail();
      const ownKeys = Reflect.ownKeys(row);
      if (ownKeys.length > 200000 - nodes + (array ? 1 : 0) || array && (ownKeys.length !== row.length + 1 || ownKeys.at(-1) !== "length")) throw fail();
      const keys = array ? ownKeys.slice(0, -1) : ownKeys;
      if (keys.some((key, index) => typeof key !== "string" || array && key !== String(index))) throw fail();
      ancestors.add(row);
      bytes += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(row, key); if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw fail(); if (!array) bytes += Buffer.byteLength(JSON.stringify(key)) + 1; walk(descriptor.value, depth + 1); }
      ancestors.delete(row);
    }
    if (bytes > MAX_BYTES) throw fail();
  };
  walk(value, 0); return value;
}
function validatePortableVault(value) {
  exact(value, VAULT_FIELDS);
  if (value.v !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ROWS || !Array.isArray(value.neverOrigins) || value.neverOrigins.length > MAX_ROWS) throw fail();
  boundedJson(value); const ids = new Set(), identities = new Set(), never = new Set();
  const entries = value.entries.map(entry => {
    exact(entry, ENTRY_FIELDS);
    if (typeof entry.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.id) || ids.has(entry.id) || !origin(entry.origin) || typeof entry.username !== "string" || entry.username.length > 1024 || entry.username.includes("\0") || typeof entry.password !== "string" || !entry.password || entry.password.length > 16384 || entry.password.includes("\0") || typeof entry.name !== "string" || entry.name.length > 256 || /[\u0000-\u001f\u007f]/.test(entry.name) || [entry.createdAt, entry.updatedAt].some(date => typeof date !== "string" || date.length > 40 || !Number.isFinite(Date.parse(date)))) throw fail();
    const identity = entry.origin + "\0" + entry.username; if (identities.has(identity)) throw fail(); ids.add(entry.id); identities.add(identity);
    return Object.fromEntries(ENTRY_FIELDS.map(key => [key, entry[key]]));
  });
  for (const item of value.neverOrigins) { if (!origin(item) || never.has(item)) throw fail(); never.add(item); }
  return { v: 1, entries, neverOrigins: [...never] };
}
function validatePreferences(value) {
  exact(value, ["v", "searchEngine"]);
  if (value.v !== 1 || !ENGINES.includes(value.searchEngine)) throw fail();
  return { v: 1, searchEngine: value.searchEngine };
}
function validatePortableBundle(value) {
  exact(value, ["passwordVault", "preferences"]); boundedJson(value);
  return { passwordVault: validatePortableVault(value.passwordVault), preferences: validatePreferences(value.preferences) };
}
function validatePortableState(value) {
  exact(value, ["schema", "cookies", "origins", "passwordVault", "preferences"]);
  if (value.schema !== SCHEMA || !Array.isArray(value.cookies) || value.cookies.length > MAX_ROWS || !Array.isArray(value.origins) || value.origins.length > MAX_ORIGINS) throw fail();
  boundedJson(value); const extras = validatePortableBundle({ passwordVault: value.passwordVault, preferences: value.preferences });
  return { schema: SCHEMA, cookies: structuredClone(value.cookies), origins: structuredClone(value.origins), ...extras };
}
function encodePortableState(value) {
  const validated = validatePortableState(value), bytes = Buffer.from(JSON.stringify(validated));
  if (bytes.length > MAX_BYTES) { bytes.fill(0); throw fail(); }
  return bytes;
}
function decodePortableState(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw fail();
  let value; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw fail(); }
  return validatePortableState(value);
}
module.exports = { SCHEMA, MAX_BYTES, validatePortableVault, validatePreferences, validatePortableBundle, validatePortableState, encodePortableState, decodePortableState };
