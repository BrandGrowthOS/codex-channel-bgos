"use strict";
const { createHash } = require("node:crypto");
const { exactAuthority, sameAuthority, documentSignature, canonical } = require("./coordinator-client");
const { identityFingerprint } = require("./crypto");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const METHODS = new Set(["initialize", "notifications/initialized", "tools/list", "tools/call", "ping"]);
const fail = code => Object.assign(new Error(code), { code });
const validId = value => typeof value === "string" && ID.test(value);
const plain = value => value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exact(value, fields) {
  if (!plain(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === fields.length && fields.every(field => Object.hasOwn(descriptors, field) && Object.hasOwn(descriptors[field], "value") && descriptors[field].enumerable);
}
function bindFrame(frame, binding, authority, hint) {
  if (!exact(frame, ["event_type", "version", "rpcId", "rpcNonce", "bindingId", "authority", "clientId", "assistantId", "message", "deadlineAt"]) || frame.event_type !== "browser_profile_rpc" || frame.version !== 1 || frame.rpcId !== hint.rpcId || frame.rpcNonce !== hint.rpcNonce || frame.bindingId !== binding.bindingId || !sameAuthority(frame.authority, authority) || frame.assistantId !== authority.assistantId || typeof frame.clientId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(frame.clientId) || !plain(frame.message) || frame.message.jsonrpc !== "2.0" || !METHODS.has(frame.message.method) || !(frame.message.id === undefined || frame.message.id === null || typeof frame.message.id === "string" || typeof frame.message.id === "number" && Number.isFinite(frame.message.id)) || canonical(frame.message).length > 256 * 1024 || typeof frame.deadlineAt !== "string" || !Number.isFinite(Date.parse(frame.deadlineAt))) throw fail("profile_runtime_dispatch_mismatch");
  return Object.freeze(structuredClone(frame));
}

// Main/daemon-owned endpoint for a SINGLE exact runtime. execute must retain
// its promise through physical command drain, including after a caller cancel.
// This object never executes renderer-carried message bodies. Signed dispatch
// fetches the stored command from HOAI and completion goes directly to HOAI.
class ProfileRuntimeEndpoint {
  constructor({ authority, endpoint, client, assertCurrent, execute, now = Date.now, maxEntries = 4096, exchangeTimeoutMs = 8000 }) {
    this.authority = exactAuthority(authority);
    if (endpoint?.identity?.endpointId !== authority.endpointId || identityFingerprint(endpoint.identity) !== authority.keyFingerprint || typeof client?.dispatch !== "function" || typeof client?.cancellation !== "function" || typeof client?.result !== "function" || typeof assertCurrent !== "function" || typeof execute !== "function" || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096) throw fail("profile_runtime_endpoint_invalid");
    if (!Number.isSafeInteger(exchangeTimeoutMs) || exchangeTimeoutMs < 1 || exchangeTimeoutMs > 8000) throw fail("profile_runtime_endpoint_invalid");
    Object.assign(this, { endpoint, client, assertCurrent, execute, now, maxEntries, exchangeTimeoutMs });
    this.binding = null; this.exchange = null; this.generation = 0; this.entries = new Map(); this.commands = new Map(); this.physical = null; this.proving = null; this.closed = false;
  }
  _check(generation = this.generation) {
    if (this.closed || generation !== this.generation) throw fail("profile_runtime_endpoint_changed");
    const value = this.assertCurrent(); if (value === false || value?.then) throw fail("profile_runtime_endpoint_changed");
  }
  async _ask(exchange, event, body) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(() => exchange(event, body)), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(fail("profile_runtime_proof_timeout")), this.exchangeTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async prove({ socketId, exchange }) {
    this._check();
    if (!validId(socketId) || typeof exchange !== "function" || this.proving || this.physical) throw fail("profile_runtime_proof_busy");
    if (this.binding && this.binding.socketId !== socketId) throw fail("profile_runtime_socket_changed");
    const generation = this.generation, token = Symbol("proof"); this.proving = token;
    try {
      const response = await this._ask(exchange, "browser_profile_challenge", { authority: this.authority }); this._check(generation);
      const challenge = response?.ok === true ? response.challenge : null;
      if (!exact(challenge, ["version", "kind", "challengeId", "nonce", "socketId", "expiresAt", "authority"]) || challenge.version !== 1 || challenge.kind !== "runtime-socket-binding" || !UUID.test(challenge.challengeId) || !NONCE.test(challenge.nonce) || challenge.socketId !== socketId || !sameAuthority(challenge.authority, this.authority) || !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt <= this.now() || challenge.expiresAt > this.now() + 31000) throw fail("profile_runtime_challenge_invalid");
      const accepted = await this._ask(exchange, "browser_profile_bind", { challengeId: challenge.challengeId, signature: documentSignature(this.endpoint, challenge) }); this._check(generation);
      const binding = accepted?.ok === true ? accepted.binding : null;
      if (!binding || !UUID.test(binding.bindingId) || binding.socketId !== socketId || !sameAuthority(binding.authority, this.authority)) throw fail("profile_runtime_binding_invalid");
      this.binding = Object.freeze({ bindingId: binding.bindingId, socketId, authority: this.authority }); this.exchange = exchange;
      return this.binding;
    } finally { if (this.proving === token) this.proving = null; }
  }
  _hint(hint) {
    this._check(); const binding = this.binding;
    if (!binding || !plain(hint) || !UUID.test(hint.rpcId) || !NONCE.test(hint.rpcNonce) || hint.socketId !== binding.socketId || hint.bindingId !== binding.bindingId || !sameAuthority(hint.authority, this.authority)) throw fail("profile_runtime_hint_invalid");
    return Object.freeze({ rpcId: hint.rpcId, rpcNonce: hint.rpcNonce, socketId: binding.socketId, bindingId: binding.bindingId, authority: this.authority });
  }
  receive(rawHint) {
    const hint = this._hint(rawHint), old = this.entries.get(hint.rpcId);
    if (old) {
      if (old.hint.rpcNonce !== hint.rpcNonce || old.hint.bindingId !== hint.bindingId || old.hint.socketId !== hint.socketId) throw fail("profile_runtime_duplicate_mismatch");
      return old.task.then(() => ({ accepted: true, duplicate: true }));
    }
    // Never evict a dedup tombstone while this authority can still dispatch it.
    // A full runtime needs explicit fresh authority, not replay after expiry.
    if (this.physical || this.entries.size >= this.maxEntries) throw fail("profile_runtime_endpoint_busy");
    const entry = { hint, generation: this.generation, binding: this.binding, abort: new AbortController(), task: null, executed: false, completion: null };
    this.entries.set(hint.rpcId, entry); this.physical = entry;
    entry.task = this._run(entry).finally(() => { if (this.physical === entry) this.physical = null; });
    return entry.task;
  }
  async _run(entry) {
    let payload;
    try {
      const fetched = await this.client.dispatch(this.authority, this.endpoint, entry.hint);
      this._check(entry.generation); entry.abort.signal.throwIfAborted();
      if (this.binding !== entry.binding) throw fail("profile_runtime_endpoint_changed");
      const frame = bindFrame(fetched?.frame, entry.binding, this.authority, entry.hint);
      if (Date.parse(frame.deadlineAt) <= this.now()) throw fail("profile_runtime_dispatch_expired");
      if (frame.message.method === "tools/call" && (frame.message.id === undefined || frame.message.id === null)) throw fail("profile_runtime_request_id_required");
      const commandKey = JSON.stringify([frame.clientId, typeof frame.message.id, frame.message.id ?? null, frame.message.id == null ? frame.message.method : null]);
      const digest = createHash("sha256").update(canonical(frame.message)).digest("hex");
      // A server restart may mint a new rpcId for the original JSON-RPC id.
      // Never replay that command or disclose its retained private output.
      if (this.commands.has(commandKey)) throw fail(this.commands.get(commandKey) === digest ? "profile_runtime_command_uncertain" : "profile_runtime_duplicate_mismatch");
      if (this.commands.size >= this.maxEntries) throw fail("profile_runtime_endpoint_busy");
      this.commands.set(commandKey, digest);
      entry.executed = true;
      // No response timeout may settle this physical promise early.
      payload = await this.execute({ frame, signal: entry.abort.signal, assertCurrent: () => this._check(entry.generation) });
      this._check(entry.generation);
      if (entry.abort.signal.aborted) throw fail("profile_runtime_command_cancelled");
      if (!plain(payload) || typeof payload.ok !== "boolean" || payload.ok && (!plain(payload.message) || frame.message.id !== undefined && frame.message.id !== null && (payload.message.jsonrpc !== "2.0" || payload.message.id !== frame.message.id))) throw fail("profile_runtime_response_invalid");
    } catch {
      // Refuse data from a changed context. Never include arbitrary page or
      // driver error text in a failure completion.
      payload = { ok: false, error: { code: "browser_runtime_command_uncertain", message: "The browser action could not be confirmed. Inspect its original page before deciding what to do next." } };
    }
    try {
      entry.completion = await this.client.result(this.authority, this.endpoint, { ...entry.hint, payload });
      return { accepted: true, executed: entry.executed, completionAccepted: entry.completion?.accepted === true };
    } catch { return { accepted: true, executed: entry.executed, completionAccepted: false }; }
  }
  async cancel(rawHint) {
    const hint = this._hint(rawHint), entry = this.entries.get(hint.rpcId);
    if (!entry || this.physical !== entry || entry.hint.rpcNonce !== hint.rpcNonce || entry.hint.bindingId !== hint.bindingId) return { requested: false };
    if (entry.cancelling) return entry.cancelling;
    const work = (async () => {
      try {
        const proof = await this.client.cancellation(this.authority, this.endpoint, hint); this._check(entry.generation);
        if (proof?.requested !== true || this.binding !== entry.binding || this.physical !== entry) return { requested: false };
        entry.abort.abort(fail("profile_runtime_command_cancelled")); return { requested: true };
      } catch { return { requested: false }; }
    })();
    entry.cancelling = work;
    void work.finally(() => { if (entry.cancelling === work) entry.cancelling = null; });
    return entry.cancelling;
  }
  whenDrained() { return this.physical?.task.then(() => undefined, () => undefined) || Promise.resolve(); }
  disconnect() {
    this.generation++; this.binding = null; this.exchange = null;
    this.physical?.abort.abort(fail("profile_runtime_socket_changed"));
  }
  async close() {
    if (this.closed) return this.whenDrained();
    const binding = this.binding, exchange = this.exchange;
    this.disconnect(); this.closed = true;
    // Routing release is not physical completion. Keep the active promise.
    if (binding && exchange) { try { await this._ask(exchange, "browser_profile_release", { bindingId: binding.bindingId }); } catch {} }
    await this.whenDrained();
  }
}
module.exports = { ProfileRuntimeEndpoint, bindFrame };
