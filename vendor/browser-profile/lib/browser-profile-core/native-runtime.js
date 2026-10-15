"use strict";
const { randomUUID, sign } = require("node:crypto");
const { createStorageAdapter } = require("./storage");
const { consumeStoppedHeadStageAuthorization } = require("./stopped-head-stage");
const { sealCheckpoint, openCheckpoint, manifestHash, MAX_PLAINTEXT_BYTES } = require("./crypto");
const { validatePortableBundle, encodePortableState, decodePortableState, SCHEMA } = require("./portable-state");
const AUTHORITY = ["profileId", "actingUserId", "assistantId", "endpointId", "bootId", "runtimeId", "sessionId", "writerEpoch", "revision", "contentKeyEpoch", "grantVersion", "keyFingerprint"];
const COUNTERS = new Set(["assistantId", "writerEpoch", "revision", "contentKeyEpoch", "grantVersion"]);
const WORLD = 1007, MAX_ORIGINS = 100, MAX_MARKERS = 10000, MAX_COOKIES = 10000;
const fail = reason => Object.assign(new Error(reason), { reason, code: reason });
const freeze = value => { if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const canonical = value => JSON.stringify(sorted(value));
const tuple = value => {
  if (!value || AUTHORITY.some(key => COUNTERS.has(key) ? !Number.isSafeInteger(value[key]) || value[key] < (key === "revision" ? 0 : 1) : typeof value[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value[key])) || !/^[a-f0-9]{64}$/.test(value.keyFingerprint)) throw fail("profile_runtime_authority_invalid");
  return Object.freeze(Object.fromEntries(AUTHORITY.map(key => [key, value[key]])));
};
const matches = (a, b) => AUTHORITY.every(key => a?.[key] === b?.[key]);
const runtimeOf = value => Object.fromEntries(["endpointId", "bootId", "runtimeId", "sessionId", "writerEpoch"].map(key => [key, value[key]]));
const destinationOf = value => Object.fromEntries(["endpointId", "bootId", "runtimeId", "sessionId", "grantVersion", "keyFingerprint"].map(key => [key, value[key]]));
function syncCall(callback, receiver, value) {
  const result = callback.call(receiver, value);
  if (result?.then) { Promise.resolve(result).catch(() => {}); throw fail("profile_runtime_extras_must_be_synchronous"); }
  if (result === false) throw fail("profile_runtime_extras_refused");
  return result;
}
function originOf(value) {
  try { const url = new URL(value); return !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) ? url.origin : null; }
  catch { return null; }
}
function cookies(value) {
  if (!Array.isArray(value) || value.length > MAX_COOKIES) throw fail("profile_cookie_unsupported");
  const fields = new Set(["name", "value", "domain", "path", "expires", "size", "httpOnly", "secure", "session", "sameSite", "priority", "sameParty", "sourceScheme", "sourcePort", "partitionKey", "partitionKeyOpaque"]), seen = new Set();
  let measured = 0;
  return value.map(row => {
    if (!row || typeof row !== "object" || Object.keys(row).some(key => !fields.has(key)) ||
        ["name", "value", "domain", "path"].some(key => typeof row[key] !== "string" || row[key].length > 16384 || /[\0\r\n]/.test(row[key])) || !row.domain || !row.path.startsWith("/") ||
        !/^[.]?[a-zA-Z0-9_-]+(?:[.][a-zA-Z0-9_-]+)*$/.test(row.domain) ||
        ["httpOnly", "secure", "session"].some(key => typeof row[key] !== "boolean") || !Number.isFinite(row.expires) ||
        (row.session ? row.expires !== -1 : row.expires < 0) || !["Low", "Medium", "High"].includes(row.priority) ||
        !["Secure", "NonSecure"].includes(row.sourceScheme) || !Number.isInteger(row.sourcePort) || row.sourcePort < -1 || row.sourcePort > 65535 ||
        (row.sameSite !== undefined && !["Strict", "Lax", "None"].includes(row.sameSite)) || row.sameParty === true || row.partitionKeyOpaque === true ||
        (row.sameParty !== undefined && typeof row.sameParty !== "boolean") || (row.partitionKeyOpaque !== undefined && typeof row.partitionKeyOpaque !== "boolean") ||
        (row.size !== undefined && (!Number.isSafeInteger(row.size) || row.size < 0))) throw fail("profile_cookie_unsupported");
    measured += Buffer.byteLength(JSON.stringify(row)); if (measured > MAX_PLAINTEXT_BYTES) throw fail("profile_runtime_state_too_large");
    const result = Object.fromEntries(["name", "value", "domain", "path", "expires", "httpOnly", "secure", "session", "priority", "sourceScheme", "sourcePort"].map(key => [key, row[key]]));
    if (row.sameSite !== undefined) result.sameSite = row.sameSite;
    if (row.partitionKey !== undefined) {
      const key = row.partitionKey;
      if (!key || Object.keys(key).length !== 2 || typeof key.topLevelSite !== "string" || originOf(key.topLevelSite) !== key.topLevelSite || typeof key.hasCrossSiteAncestor !== "boolean") throw fail("profile_cookie_unsupported");
      result.partitionKey = { topLevelSite: key.topLevelSite, hasCrossSiteAncestor: key.hasCrossSiteAncestor };
    }
    const identity = canonical({ name: row.name, domain: row.domain, path: row.path, partitionKey: result.partitionKey || null });
    if (seen.has(identity)) throw fail("profile_cookie_unsupported"); seen.add(identity); return result;
  }).sort((a, b) => canonical(a).localeCompare(canonical(b)));
}
function cookieParams(row) {
  const result = { name: row.name, value: row.value, path: row.path, secure: row.secure, httpOnly: row.httpOnly, priority: row.priority,
    sourceScheme: row.sourceScheme, sourcePort: row.sourcePort };
  if (row.domain.startsWith(".")) result.domain = row.domain;
  else result.url = `${row.secure ? "https" : "http"}://${row.domain}${row.sourcePort > 0 ? ":" + row.sourcePort : ""}${row.path}`;
  if (!row.session) result.expires = row.expires;
  if (row.sameSite !== undefined) result.sameSite = row.sameSite;
  if (row.partitionKey) result.partitionKey = { ...row.partitionKey };
  return result;
}

// Main-only foundation. Platform qualification is separate from these unit
// contracts. Host code must supply physical admission/drain and serialized CDP.
class NativeProfileRuntime {
  constructor({ electron, authority, closeAndDrain, checkpoint, authorizeActivation, assertNoWorkers, sendCdp, createExporter, observeRequest, assertSourceTransferReady, preflightExtras, captureExtras, commitExtras, onFrame = () => {}, destroyTimeoutMs = 5000, workerTimeoutMs = 5000 }) {
    if (!electron?.session?.fromPartition || !electron.app?.on || !electron.webContents?.getAllWebContents || typeof closeAndDrain !== "function" || typeof checkpoint !== "function" || typeof authorizeActivation !== "function") throw new TypeError("profile_runtime_dependencies_required");
    if ([preflightExtras, captureExtras, commitExtras].some(callback => typeof callback !== "function")) throw new TypeError("profile_runtime_extras_dependencies_required");
    Object.assign(this, { electron, closeAndDrain, checkpoint, authorizeActivation, onFrame, assertNoWorkers, observeRequest, preflightExtras, captureExtras, commitExtras });
    this._assertSourceTransferReady = assertSourceTransferReady;
    this.destroyTimeoutMs = Math.max(1, Math.min(10000, destroyTimeoutMs));
    this.workerTimeoutMs = Math.max(1, Math.min(10000, workerTimeoutMs));
    this.authority = tuple(authority); this.state = "new"; this.partition = `profile-sync-${randomUUID()}`;
    this.session = electron.session.fromPartition(this.partition, { cache: false });
    this.session.setPermissionRequestHandler?.((_wc, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler?.(() => false); this.session.setDevicePermissionHandler?.(() => false);
    this.session.setDisplayMediaRequestHandler?.((_request, callback) => callback({}));
    this.views = new Map(); this.markers = new Map(); this.knownOrigins = new Set(); this.exporters = new Set(); this.exporterViews = new Set(); this.privateURLs = new Map(); this.sequence = 0; this.network = "blocked"; this.protocols = false; this.operation = null;
    this.sendCdp = sendCdp || (async (wc, method, params = {}) => { if (!wc.debugger.isAttached()) wc.debugger.attach("1.3"); return wc.debugger.sendCommand(method, params); });
    this.createExporter = createExporter || (() => new electron.WebContentsView({ webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, backgroundThrottling: false } }));
    this.created = (_event, wc) => {
      if (wc.session !== this.session) return;
      if (this.creatingExporter) this.exporters.add(wc);
      else { try { this.registerView(wc); } catch { this.inventoryFailure = "profile_inventory_untracked_view"; wc.destroy(); } }
    };
    electron.app.on("web-contents-created", this.created);
    this.session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const allowed = this.network === "active" || this.network === "private" && this.privateURLs.get(details.webContentsId) === details.url;
      try {
        const observed = this.observeRequest?.({ details, allowed, network: this.network });
        if (observed === false || observed?.then) throw fail("profile_runtime_activity_unqualified");
      } catch { this.activityFailure = true; callback({ cancel: true }); return; }
      callback({ cancel: !allowed });
    });
  }
  _admit(name, states) {
    if (this.operation || !states.includes(this.state)) throw fail("profile_runtime_state_refused");
    const token = Symbol(name); this.operation = token; return token;
  }
  _current(token) { if (this.operation !== token || this.state === "disposed") throw fail("profile_runtime_operation_revoked"); }
  registerView(view) {
    const wc = view?.webContents || view;
    if (!wc || wc.session !== this.session || wc.isDestroyed() || this.operation || !["new", "active"].includes(this.state)) throw fail("profile_runtime_view_refused");
    if (this.views.has(wc)) return;
    const observe = (event, url, _status, _text, isMainFrame, processId, routingId) => {
      const value = event?.url || url;
      if (value === "about:blank" && !(event?.frame?.origin && event.frame.origin !== "null")) return;
      const marker = Object.freeze({ id: ++this.sequence, wc, url: value, origin: originOf(value), topLevelOrigin: originOf(wc.getURL()),
        isMainFrame: event?.isMainFrame ?? isMainFrame, processId: event?.frameProcessId ?? processId, routingId: event?.frameRoutingId ?? routingId });
      this.markers.set(marker.id, { marker, qualified: false });
      if (this.markers.size > MAX_MARKERS) this.inventoryFailure = "profile_inventory_limit";
      try { Promise.resolve(this.onFrame(wc, marker)).catch(() => {}); } catch {}
    };
    this.views.set(wc, { observe }); wc.on("did-frame-navigate", observe);
    if (wc.getURL() && wc.getURL() !== "about:blank") observe({ url: wc.getURL(), isMainFrame: true });
  }
  qualifyFrame(marker, { url, storageKey, topLevelOrigin, assertCurrent }) {
    const record = this.markers.get(marker?.id);
    if (!record || record.marker !== marker || typeof assertCurrent !== "function") throw fail("profile_inventory_unqualified");
    assertCurrent();
    // First-party, nonopaque keys only. Other serialization/partition forms
    // require an explicit qualification change, never a best-effort fallback.
    if (!marker.origin || marker.url !== url || marker.origin !== topLevelOrigin || marker.topLevelOrigin !== topLevelOrigin || storageKey !== marker.origin + "/") throw fail("profile_partitioned_origin_unsupported");
    record.qualified = true;
  }
  _allViews() { return this.electron.webContents.getAllWebContents().filter(wc => wc.session === this.session && !wc.isDestroyed()); }
  _inventory() {
    if (this.inventoryFailure) throw fail(this.inventoryFailure);
    for (const wc of this._allViews()) if (!this.views.has(wc) && !this.exporters.has(wc)) throw fail("profile_inventory_untracked_view");
    const origins = new Set(this.knownOrigins);
    for (const { marker, qualified } of this.markers.values()) {
      if (!qualified) throw fail("profile_inventory_unqualified");
      origins.add(marker.origin);
    }
    if (origins.size > MAX_ORIGINS) throw fail("profile_inventory_limit");
    return [...origins].sort();
  }
  assertMovable() { return { origins: this._inventory() }; }
  assertCurrent() {
    if (this.state !== "active" || this.network !== "active" || !this.activeProof) throw fail("profile_runtime_authority_inactive");
    this.activeProof.assertCurrent(); return this.authority;
  }
  async _privateMode(token) {
    this._current(token);
    this.network = "private";
    if (this.protocols) return;
    const handle = request => {
      if (![...this.privateURLs.values()].includes(request.url)) return new Response("", { status: 403 });
      return new Response("<!doctype html><meta charset=utf-8><title>Private profile storage</title>", { headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'none'; worker-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'" } });
    };
    for (const scheme of ["http", "https"]) { await this.session.protocol.handle(scheme, handle); this._current(token); }
    this.protocols = true;
  }
  async _exporter(origin, token) {
    this._current(token);
    this.creatingExporter = true; let view;
    try { view = this.createExporter({ session: this.session }); } finally { this.creatingExporter = false; }
    if (view && typeof view.then === "function") throw fail("profile_exporter_must_be_synchronous");
    const wc = view?.webContents || view;
    if (!wc || wc.session !== this.session || wc.isDestroyed()) throw fail("profile_exporter_invalid");
    this.exporters.add(wc); this.exporterViews.add(view);
    const url = `${origin}/.well-known/hoai-private-profile/${randomUUID()}`; this.privateURLs.set(wc.id, url);
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    for (const event of ["will-navigate", "will-redirect", "will-attach-webview"]) wc.on(event, event => event.preventDefault());
    await wc.loadURL(url); this._current(token);
    if (wc.getURL() !== url) throw fail("profile_exporter_invalid");
    await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `globalThis.__hoaiProfileStorage = (${createStorageAdapter.toString()})(); true` }]); this._current(token);
    return wc;
  }
  async _storage(wc, method, value, token) {
    this._current(token);
    const code = method === "read" ? "globalThis.__hoaiProfileStorage.read()" : `globalThis.__hoaiProfileStorage.restore(JSON.parse(${JSON.stringify(JSON.stringify(value))}))`;
    const result = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]); this._current(token); return result;
  }
  async _destroyAll() {
    const outcomes = await Promise.allSettled(this._allViews().map(wc => new Promise((resolve, reject) => {
      let timer;
      const finish = error => { clearTimeout(timer); wc.removeListener("destroyed", destroyed); error ? reject(error) : resolve(); };
      const destroyed = () => finish();
      wc.once("destroyed", destroyed);
      timer = setTimeout(() => finish(fail("profile_runtime_stop_failed")), this.destroyTimeoutMs);
      try { wc.destroy(); if (wc.isDestroyed()) finish(); } catch { finish(fail("profile_runtime_stop_failed")); }
    })));
    // The initial snapshot cannot cover a late-created view. Re-enumerate the
    // exact native Session and refuse any survivor instead of capturing early.
    if (outcomes.some(value => value.status === "rejected") || this._allViews().length) throw fail("profile_runtime_stop_failed");
    this.privateURLs.clear(); this.exporters.clear(); this.exporterViews.clear();
  }
  async _stopBackground(token) {
    await this.session.closeAllConnections(); this._current(token);
    await this.session.clearStorageData({ storages: ["serviceworkers", "cachestorage"] }); this._current(token); await this.session.clearCache(); this._current(token);
    await this._assertBackgroundStopped(); this._current(token);
  }
  // Disposal has already invalidated every operation token. It still needs the
  // same bounded physical target proof before reporting completed revocation.
  async _assertBackgroundStopped() {
    if (typeof this.assertNoWorkers !== "function") throw fail("profile_worker_inventory_unavailable");
    let timer, workers;
    try {
      workers = await Promise.race([Promise.resolve().then(() => this.assertNoWorkers({ session: this.session, authority: this.authority })),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(fail("profile_worker_inventory_timeout")), this.workerTimeoutMs); })]);
    } finally { clearTimeout(timer); }
    if (!workers || ["serviceWorkers", "sharedWorkers", "dedicatedWorkers"].some(key => workers[key] !== 0) || Object.keys(this.session.serviceWorkers.getAllRunning()).length) throw fail("profile_runtime_workers_running");
  }
  _manifestContext(context, direction) {
    const authority = this.authority;
    if (!context || context.profileId !== authority.profileId || context.actingUserId !== authority.actingUserId || context.assistantId !== authority.assistantId || context.keyEpoch !== authority.contentKeyEpoch ||
        context.revision !== authority.revision + (direction === "source" ? 1 : 0)) throw fail("profile_runtime_context_mismatch");
    const expected = direction === "source" ? runtimeOf(authority) : destinationOf(authority);
    if (Object.keys(expected).some(key => context[direction]?.[key] !== expected[key])) throw fail("profile_runtime_context_mismatch");
  }
  async activate(grant) {
    if (this.state === "new" && this.authority.revision !== 0) throw fail("profile_runtime_checkpoint_required");
    const token = this._admit("activate", ["new", "staged"]);
    try {
    if (this.extrasCommitFailure) throw fail("profile_runtime_extras_commit_uncertain");
    const proof = await this.authorizeActivation({ authority: this.authority, receipt: this.stagedReceipt || null, grant });
    this._current(token);
    if (!proof || !matches(tuple(proof.authority), this.authority) || typeof proof.assertCurrent !== "function") throw fail("profile_runtime_activation_refused");
    const assertProof = proof.assertCurrent.bind(proof), assertActivationCurrent = () => syncCall(assertProof, undefined);
    assertActivationCurrent();
    this._current(token); this._inventory();
    if (this.state === "staged" && !this.extrasCommitted) {
      try {
        const committed = syncCall(this.commitExtras, this, { authority: this.authority, receipt: this.stagedReceipt, bundle: this.stagedExtras, grant });
        if (committed?.committed !== true) throw fail("profile_runtime_extras_commit_unproved");
        this.extrasCommitted = true; this.stagedExtras = null;
      } catch (error) { this.extrasCommitFailure = true; this.network = "blocked"; throw error; }
    }
    assertActivationCurrent(); this._current(token);
    if (this.protocols) { for (const scheme of ["http", "https"]) this.session.protocol.unhandle(scheme); this.protocols = false; }
    assertActivationCurrent(); this._current(token); this._inventory();
    this.activeProof = Object.freeze({ assertCurrent: assertActivationCurrent }); this.network = "active"; this.state = "active";
    return { state: this.state, authority: this.authority };
    } finally { if (this.operation === token) this.operation = null; }
  }
  assertSourceTransferReady() {
    // Check native activity synchronously before closing admission or changing
    // state. Aborting a provider POST can rotate credentials remotely while
    // losing its response, so an in-flight request is not a drain proof.
    if (this.state !== "active" || this.network !== "active") throw fail("profile_runtime_state_refused");
    this._inventory();
    if (this.activityFailure || typeof this.observeRequest !== "function" || typeof this._assertSourceTransferReady !== "function") throw fail("profile_runtime_activity_unqualified");
    const ready = this._assertSourceTransferReady({ authority: this.authority, session: this.session });
    if (ready === false || ready?.then) throw fail("profile_runtime_activity_unqualified");
    validatePortableBundle(syncCall(this.preflightExtras, this, { authority: this.authority }));
    return true;
  }
  async finalize({ context, source, destinationIdentity, contentKeyEpoch }) {
    this.assertSourceTransferReady();
    context = freeze(structuredClone(context));
    this._inventory();
    this._manifestContext(context, "source"); const token = this._admit("finalize", ["active"]); this.state = "quiescing"; this.network = "blocked";
    let plaintext, extrasBarrier, releaseExtras;
    try {
      const barrier = await this.closeAndDrain(this.authority); this._current(token);
      if (barrier?.admissionClosed !== true || barrier?.drained !== true) throw fail("profile_runtime_drain_unproved");
      const origins = this._inventory(); await this._destroyAll(); await this._stopBackground(token); this._inventory();
      // Old unload handlers and workers are gone before any state capture.
      extrasBarrier = syncCall(this.captureExtras, this, { authority: this.authority });
      if (typeof extrasBarrier?.release === "function") releaseExtras = extrasBarrier.release.bind(extrasBarrier);
      if (!extrasBarrier || Object.keys(extrasBarrier).length !== 3 || typeof extrasBarrier.assertCurrent !== "function" || !releaseExtras) throw fail("profile_runtime_extras_barrier_invalid");
      const assertExtrasCurrent = extrasBarrier.assertCurrent.bind(extrasBarrier), extras = validatePortableBundle(extrasBarrier.bundle);
      syncCall(assertExtrasCurrent, undefined);
      await this._privateMode(token);
      const control = await this._exporter(origins[0] || "https://hoai-profile.invalid", token), capturedCookies = cookies((await this.sendCdp(control, "Network.getAllCookies")).cookies); this._current(token);
      const storage = [];
      for (const origin of origins) {
        const wc = origin === origins[0] ? control : await this._exporter(origin, token), state = await this._storage(wc, "read", undefined, token);
        if (state?.origin !== origin || state?.schema !== "hoai-origin-storage-v1") throw fail("profile_storage_origin_mismatch");
        storage.push(state);
      }
      plaintext = encodePortableState({ schema: SCHEMA, cookies: capturedCookies, origins: storage, ...extras });
      await this._destroyAll(); await this._stopBackground(token); this.network = "blocked"; this.state = "stopped";
      syncCall(assertExtrasCurrent, undefined);
      const sealed = freeze(sealCheckpoint({ plaintext, context, source, destinationIdentity, contentKeyEpoch })), hash = manifestHash(sealed.manifest);
      const receipt = Object.freeze({ version: 1, kind: "source-stopped", profileId: context.profileId, transitionId: context.transitionId, manifestHash: hash,
        revision: context.revision, source: Object.freeze(runtimeOf(this.authority)), stopped: true });
      const signature = sign(null, Buffer.from(canonical(receipt)), source.signingPrivateKey).toString("base64url");
      this.stoppedCheckpoint = Object.freeze({ checkpoint: sealed, receipt, signature });
      const saved = await this.checkpoint(this.stoppedCheckpoint); this._current(token);
      syncCall(assertExtrasCurrent, undefined);
      if (saved?.durable !== true || saved.manifestHash !== hash) throw fail("profile_checkpoint_not_durable");
      return this.stoppedCheckpoint;
    } catch (error) {
      this.network = "blocked";
      try { await this._destroyAll(); await this.session.closeAllConnections(); } catch {}
      throw error;
    } finally {
      plaintext?.fill(0);
      try { if (releaseExtras) syncCall(releaseExtras, undefined); }
      finally { if (this.operation === token) this.operation = null; }
    }
  }
  async stage({ checkpoint, expectedContext, sourceIdentity, destination }) {
    if (this._allViews().length) throw fail("profile_runtime_state_refused");
    this._manifestContext(expectedContext, "destination");
    return this._stageImported({ checkpoint, expectedContext, sourceIdentity, destination, receiptTransitionId: expectedContext.transitionId });
  }
  async stageStoppedHead({ checkpoint, originalContext, sourceIdentity, destination, authorization }) {
    if (this._allViews().length) throw fail("profile_runtime_state_refused");
    const proof = consumeStoppedHeadStageAuthorization(authorization, { authority: this.authority, checkpoint, originalContext, sourceIdentity, destination });
    return this._stageImported({ checkpoint, expectedContext: originalContext, sourceIdentity, destination,
      receiptTransitionId: proof.transitionId, stageCheck: proof.assertCurrent, readdress: proof.binding });
  }
  async _stageImported({ checkpoint, expectedContext, sourceIdentity, destination, receiptTransitionId, stageCheck = () => {}, readdress }) {
    checkpoint = freeze(structuredClone(checkpoint)); expectedContext = freeze(structuredClone(expectedContext));
    sourceIdentity = freeze(structuredClone(sourceIdentity));
    destination = Object.freeze({ ...destination, identity: freeze(structuredClone(destination.identity)) });
    syncCall(stageCheck, undefined);
    const token = this._admit("stage", ["new"]);
    const current = () => { this._current(token); syncCall(stageCheck, undefined); };
    let opened;
    try {
      opened = openCheckpoint({ checkpoint, expectedContext, sourceIdentity, destination });
      const payload = decodePortableState(opened.plaintext);
      const restoredCookies = cookies(payload.cookies), origins = new Set();
      for (const state of payload.origins) if (!state || !originOf(state.origin) || state.origin !== originOf(state.origin) || origins.has(state.origin)) throw fail("profile_runtime_payload_invalid"); else origins.add(state.origin);
      await this._stopBackground(token); current(); await this._privateMode(token); current();
      const control = await this._exporter([...origins][0] || "https://hoai-profile.invalid", token);
      current();
      if ((await this.sendCdp(control, "Network.getAllCookies")).cookies?.length) throw fail("profile_runtime_destination_not_empty");
      current();
      for (const state of payload.origins) {
        const wc = state.origin === [...origins][0] ? control : await this._exporter(state.origin, token);
        current();
        if (await this._storage(wc, "restore", state, token) !== true) throw fail("profile_runtime_storage_import_failed");
        current();
      }
      await this.sendCdp(control, "Network.setCookies", { cookies: restoredCookies.map(cookieParams) });
      current();
      if (canonical(cookies((await this.sendCdp(control, "Network.getAllCookies")).cookies)) !== canonical(restoredCookies)) throw fail("profile_runtime_cookie_import_mismatch");
      current(); await this._destroyAll(); current(); await this._stopBackground(token); current(); this.network = "blocked";
      const receipt = Object.freeze({ version: 1, kind: "destination-staged", profileId: expectedContext.profileId, transitionId: receiptTransitionId,
        manifestHash: manifestHash(checkpoint.manifest), revision: expectedContext.revision, destination: Object.freeze(destinationOf(this.authority)), stagedInactive: true });
      this.stagedReceipt = receipt; this.stagedExtras = freeze(validatePortableBundle({ passwordVault: payload.passwordVault, preferences: payload.preferences }));
      this.stagedReaddress = readdress || null;
      this.extrasCommitted = false; this.knownOrigins = origins; this.contentKeyEpoch = opened.contentKeyEpoch; opened.plaintext.fill(0); opened = null; this.state = "staged";
      return { receipt, signature: sign(null, Buffer.from(canonical(receipt)), destination.signingPrivateKey).toString("base64url"), ...(readdress ? { readdress } : {}) };
    } catch (error) { await this.dispose(); throw error; }
    finally { opened?.plaintext.fill(0); opened?.contentKeyEpoch.key.fill(0); if (this.operation === token) this.operation = null; }
  }
  async dispose() {
    this.network = "blocked"; this.state = "disposed"; this.operation = null; this.activeProof = null; this.stagedExtras = null; this.stagedReaddress = null;
    this.electron.app.removeListener("web-contents-created", this.created);
    const failures = [];
    try {
      for (const cleanup of [() => this._destroyAll(), () => this.session.closeAllConnections(), () => this.session.clearStorageData(), () => this.session.clearCache(), () => this._assertBackgroundStopped()]) {
        try { await cleanup(); } catch (error) { failures.push(error); }
      }
    } finally { this.contentKeyEpoch?.key.fill(0); this.contentKeyEpoch = null; }
    if (failures.length) throw fail("profile_runtime_dispose_failed");
  }
}
module.exports = { NativeProfileRuntime, cookies, cookieParams };
