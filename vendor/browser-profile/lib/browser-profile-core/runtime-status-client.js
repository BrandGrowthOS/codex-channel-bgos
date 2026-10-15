"use strict";

// Main-only possession proof read. No human token, pairing token or renderer
// command is accepted here. An unavailable read is unknown, never revocation.
const { randomUUID } = require("node:crypto");
const { identityFingerprint } = require("./crypto");
const { documentSignature, exactAuthority, sameAuthority, isRuntimeSocketId } = require("./coordinator-client");
const META_BYTES = 64 * 1024, VALID_MS = 10_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = code => Object.assign(new Error(code), { code });
const checkCapability = check => { if (typeof check !== "function") throw fail("profile_runtime_status_capability_required"); const value = check(); if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail("profile_runtime_status_context_changed"); } if (value === false) throw fail("profile_runtime_status_context_changed"); };

class ProfileRuntimeStatusClient {
  constructor({ origin, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
    const url = new URL(origin);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)) || typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) throw fail("profile_runtime_status_configuration_invalid");
    this.origin = url.origin; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.physical = null;
  }
  async status({ authority: raw, endpoint, bindingId, socketId, assertCurrent }) {
    const authority = exactAuthority(raw); checkCapability(assertCurrent);
    if (!UUID.test(bindingId) || !isRuntimeSocketId(socketId) || endpoint?.identity?.endpointId !== authority.endpointId || identityFingerprint(endpoint.identity) !== authority.keyFingerprint) throw fail("profile_runtime_status_scope_invalid");
    if (this.physical) throw fail("profile_runtime_status_read_in_flight");
    const document = Object.freeze({ version: 1, kind: "runtime-current-status", requestId: randomUUID(), bindingId, socketId, authority, expiresAt: Date.now() + VALID_MS });
    const { version: _version, kind: _kind, ...echo } = document;
    const body = JSON.stringify({ ...echo, signature: documentSignature(endpoint, document) });
    const controller = new AbortController(); let timer;
    // Keep a physically unresolved fetch/stream reserved after response timeout.
    // Consumers may close admission, but this read never disposes a runtime.
    const physical = Promise.resolve().then(async () => {
      checkCapability(assertCurrent);
      const response = await this.fetchImpl(new URL("/api/v1/browser/profile-sync/runtime/status", this.origin).href, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "Accept-Encoding": "identity" }, body, credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal });
      checkCapability(assertCurrent);
      if (response?.status !== 201 && response?.status !== 200 || !response.body?.getReader || response.headers?.get("content-encoding") && response.headers.get("content-encoding").toLowerCase() !== "identity") throw fail("profile_runtime_status_unknown");
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); checkCapability(assertCurrent); if (done) break;
          if (!(value instanceof Uint8Array) || (size += value.byteLength) > META_BYTES) { await reader.cancel(); throw fail("profile_runtime_status_response_invalid"); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      checkCapability(assertCurrent);
      let result; try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw fail("profile_runtime_status_response_invalid"); }
      if (!result || Object.keys(result).length !== 6 || !["requestId", "bindingId", "socketId", "authority", "expiresAt", "current"].every(key => Object.hasOwn(result, key))) throw fail("profile_runtime_status_response_invalid");
      if (typeof result.current !== "boolean" || result.requestId !== document.requestId || result.bindingId !== bindingId || result.socketId !== socketId || result.expiresAt !== document.expiresAt || Date.now() >= document.expiresAt || !sameAuthority(exactAuthority(result.authority), authority)) throw fail("profile_runtime_status_response_invalid");
      checkCapability(assertCurrent); return Object.freeze({ ...echo, current: result.current });
    });
    this.physical = physical;
    const tracked = physical.finally(() => { if (this.physical === physical) this.physical = null; });
    try { return await Promise.race([tracked, new Promise((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail("profile_runtime_status_unknown")); }, this.timeoutMs); timer.unref?.(); })]); }
    catch (error) { checkCapability(assertCurrent); if (error?.code?.startsWith("profile_runtime_status_")) throw error; throw fail("profile_runtime_status_unknown"); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
module.exports = { ProfileRuntimeStatusClient, META_BYTES, VALID_MS };
