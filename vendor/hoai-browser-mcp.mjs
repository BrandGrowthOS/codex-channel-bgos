#!/usr/bin/env node
// HOAI Agent Browser stdio shim.
//
// Zero-dependency bridge from a stdio MCP client (Claude Code, Codex, Hermes,
// OpenClaw, Gobot: anything that can run a command MCP server) to the browser
// pane the Home of Agents desktop app hosts. Three modes, resolved on every
// request, first match wins:
//
//   local    ~/.hoai/agent-browser.json names the app's loopback endpoint and
//            token on THIS machine and the endpoint answers. Always preferred:
//            no account round trip, fastest.
//   relay    HOAI_RELAY_* credentials are set (a channel plugin hands over the
//            daemon's own HOAI credentials) and the owner's desktop app is
//            online somewhere. Every MCP message travels through the BGOS
//            backend to that app and back (docs/superpowers/plans/
//            2026-09-12-agent-browser-relay.md).
//   offline  one honest tool, hoai_browser_status, whose text says which of
//            the two doors is missing.
//
// Whenever the mode changes the shim sends notifications/tools/list_changed,
// so clients that honour it refresh the tool list; while relay credentials
// exist and the host is offline it probes the backend every 20 s so the tools
// appear the moment the owner opens the app.
//
// The app installs a copy at ~/.hoai/bin/hoai-browser-mcp.mjs; plugins ship
// their own copy. Source of truth: frontend/electron-app/agent-browser/shim/.
// The plugin's 0.72.0 copy leads it (BGOS mission 173: every browser_profile_*
// refusal in one plain sentence, a 409 is host_offline only when the relay says
// so, a desktop app the owner quit reads as not running, no profile question):
// BGOS takes this copy back byte for byte (docs/vendoring-the-hoai-browser-shim.md
// in the plugin).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const HOAI_DIR = process.env.HOAI_HOME ? path.join(process.env.HOAI_HOME, ".hoai") : path.join(os.homedir(), ".hoai");
const DISCOVERY = path.join(HOAI_DIR, "agent-browser.json");
const PROTOCOL_VERSION = "2025-06-18";
// The backend holds a relayed request open at most this long (nginx closes an
// idle upstream at 60 s), then answers 202 pending and the shim polls.
const RELAY_WAIT_MS = 45_000;
// Longer than any engine timeout (navigation 30 s, browser_wait_for 30 s).
const RELAY_TOTAL_MS = Number(process.env.HOAI_RELAY_TOTAL_MS) || 180_000;
const RELAY_PROBE_MS = Number(process.env.HOAI_RELAY_PROBE_MS) || 20_000;
// One status probe may hold back a refusal the agent is waiting for (a profile that is not active, the backend's
// browser_profile_writer_offline), so it is bounded; a probe that times out is a failed probe, never "offline".
const RELAY_PROBE_TIMEOUT_MS = Number(process.env.HOAI_RELAY_PROBE_TIMEOUT_MS) || 10_000;
const CANCEL_DELIVERY_MS = 5_000;
const RELAY_MCP_PATH = "/api/v1/integrations/browser/mcp";
const RELAY_HOST_PATH = "/api/v1/integrations/browser/host";
const PROFILE_PATH = "/api/v1/browser/profile-sync/rpc";
const PROFILE_FIELDS = ["profileId", "actingUserId", "assistantId", "endpointId", "bootId", "runtimeId", "sessionId", "writerEpoch", "revision", "contentKeyEpoch", "grantVersion", "keyFingerprint"];
const PROFILE_COUNTERS = new Set(["assistantId", "writerEpoch", "revision", "contentKeyEpoch", "grantVersion"]);
const PROFILE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const OFFLINE_TOOL = {
  name: "hoai_browser_status",
  description: "Status of the HOAI Agent Browser (the browser pane in the Home of Agents desktop app). When the app is not reachable this is the only tool; it tells you so.",
  inputSchema: { type: "object", properties: {} },
  annotations: { title: "Browser session status", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};
// The one tool while a profile refusal holds: the desktop may be running, so the words do not say it is unreachable.
const PROFILE_REFUSED_TOOL = { ...OFFLINE_TOOL, description: "Status of your HOAI Agent Browser. While your browser cannot be used this is the only tool; it tells you why." };
const OFFLINE_TEXT_LOCAL = "The HOAI Agent Browser is not available: the Home of Agents desktop app is not running on this computer (or the agent browser endpoint is off). Ask the owner to open Home of Agents; Cmd or Ctrl+Shift+B opens the Agent Browser. The browser tools appear here as soon as it is up.";
const OFFLINE_TEXT_RELAY = "The HOAI Agent Browser is not available: your owner's Home of Agents desktop app is not running or not signed in, and there is no desktop app on this machine. Ask them to open Home of Agents on their computer (Cmd or Ctrl+Shift+B opens the Agent Browser); the browser tools appear here as soon as it is online.";
// On a share recipient's turn (the signed managed context names someone other than the owner) the browser is
// theirs: the relay elects this agent's own host, else their own desktop app, and never the owner's desktop app
// (shared agents Phase 0, item 0.2; KC's decision D3). These words say so instead of the owner's.
const RECIPIENT_BROWSER_TEXT = "On this turn you act for a person this agent is shared with, not its owner: their browser runs on this agent's own host or on their own Home of Agents desktop app, never on the owner's desktop app.";
const OFFLINE_TEXT_RELAY_RECIPIENT = "The HOAI Agent Browser is not available for this turn: you act for a person this agent is shared with, so their browser runs on this agent's own host or on their own Home of Agents desktop app, never on the owner's desktop app, and neither is online. Ask them to open Home of Agents on their computer (Cmd or Ctrl+Shift+B opens the Agent Browser); the browser tools appear here as soon as it is online.";
const RELAY_ERROR_TEXT = {
  host_offline: OFFLINE_TEXT_RELAY,
  // The host was there and its connection dropped mid call (the backend's hostGone). The relay rides the desktop
  // window's socket, so a window reload does exactly this while the app keeps running; "not running or not signed
  // in" was false here, and it said nothing about the call that may already have happened. The host may be the
  // owner's desktop app OR the browser host on the agent's own machine (daemon placement), so these words name
  // neither: the relay's own sentence, appended by relayErrorText, says which one dropped.
  host_disconnected: "The browser's host dropped its connection while this call was running, so the call may or may not have run. Check the page with browser_snapshot before you retry, and never repeat a click, a purchase or a message without checking first. HOAI cannot tell a reload or a restart from a shutdown: if the host reconnects, the browser tools carry on; if it was shut down, they come back when it runs again.",
  host_timeout: "The owner's desktop app did not answer the browser call within 50 seconds. Say so and retry once; if it happens again, tell the owner their Home of Agents app looks stuck.",
  // The relay refuses BEFORE it sends anything to the host (agent-browser-relay.service.ts: assertInFlightRoom and
  // stampMinute run ahead of electHost), so nothing ran. It also refuses before any host is ELECTED, so the refusal
  // says nothing about the host: "your owner's desktop app is fine" was a claim the shim cannot know. The limits
  // themselves are the backend's, and its own sentence naming the one that was hit is appended (relayErrorText).
  rate_limited: "The HOAI relay refused this browser call because this agent made too many browser calls at once or in the last minute. Nothing ran. This refusal says nothing about whether the browser is online. Wait for your other browser calls to finish, or a minute after a burst, then retry.",
  // A 429 WITHOUT the relay's own code comes from a limit in front of the relay (the backend's global request
  // throttler, which sends a Retry-After, or the machine credential lookup ceiling), so it is not this agent's browser
  // calls that were counted. It runs earlier still, so it too says nothing about the host. Not a backend code: the
  // shim's own name.
  throttled: "The HOAI backend refused this browser call because too many requests came from this agent's connection in a short time (a general request limit, not the browser's own). Nothing ran. This refusal says nothing about whether the browser is online. Wait a little, then retry.",
  // A 429 on the COLLECT of a pending call (GET .../mcp/:rpcId, throttled by the global request guard) comes AFTER
  // the call was sent to the browser, so "Nothing ran" would be false: it may have run, or may still be running.
  // Not a backend code: the shim's own name.
  collect_throttled: "This browser call was sent to the browser, but the HOAI backend refused the request that collects its result because too many requests came from this agent's connection in a short time (a general request limit). The call may have run, or may still be running. Wait a little, then check the page with browser_snapshot before you retry, and never repeat a click, a purchase or a message without checking first.",
  browser_disabled: "The owner switched the Agent Browser off for this agent. Ask them before trying again.",
  payload_too_large: "That browser call was too large for the relay (the limit is 256 KB). Send less at once.",
  call_lost: "The relay lost track of that browser call (the result was not collected in time). Retry it once.",
};

const RELAY_UNSUPPORTED_TEXT = "This HOAI backend does not have the browser relay yet. Tell the owner to update Home of Agents.";

// Every browser_profile_* refusal an agent can meet, and the ONE plain sentence it is told (BGOS mission 173). The
// codes come from the backend (the legacy fence, storage), from the desktop (its admission answers
// browser_profile_<supervisor state>), from this agent's own browser host, and from the shim (the writer state that
// discovery reports, and a call the browser never confirmed). None of them says the desktop app is not running: a
// connected desktop refusing for its profile used to read as host_offline (RC4).
const PROFILE_CODE = /^browser_profile_[a-z0-9_]{1,80}$/;
// The legacy fence (409, or the bridge's 423) and the desktop's own admission send this code before a call runs and
// also after one ran (the fence withholds a collected result; the desktop rechecks its runtime once an action is
// done), so its words are true either way and never invite a blind repeat.
const PROFILE_OLDER_ROUTE = "Your browser's managed profile refused this call on the route it came by, and it may still have run; check the page with browser_snapshot before you repeat it, and ask your owner to open your browser in HOAI if this keeps happening.";
const PROFILE_REFUSAL_TEXT = {
  browser_profile_setup_required: "Your owner has not set up your browser yet; a Set up card is in your chat.",
  browser_profile_restart_review_required: "Your browser is closed and your owner needs to open it once in HOAI before you can use it again.",
  browser_profile_recovery_required: "Your browser needs your owner to look at it in HOAI before it can open again, so nothing ran.",
  browser_profile_outcome_unknown: "HOAI could not confirm your browser's last change, so your owner needs to check your browser in HOAI before you use it again.",
  browser_profile_return_pending: "Your browser is still moving back from another computer, so try again in a few minutes.",
  browser_profile_active_elsewhere: "Your browser is open on another computer right now, so it can only be used there until it is closed.",
  browser_profile_stopped_local_only: "Your browser closed but HOAI has not confirmed its last save yet, so your owner needs to open HOAI on that computer before you can use it.",
  browser_profile_closing: "Your browser is closing and saving right now, so try again in a minute.",
  browser_profile_authority_required: PROFILE_OLDER_ROUTE,
  browser_profile_managed: PROFILE_OLDER_ROUTE,
  browser_profile_unavailable: "Your browser could not be reached through HOAI just now, so nothing ran; try again in a moment, and if it repeats ask your owner to open your browser in HOAI.",
  browser_profile_unconfirmed: "Your browser did not confirm this action, so it may have run; check the page with browser_snapshot before you repeat it.",
  browser_profile_storage_full: "Your browser's storage in HOAI is full, so nothing new was saved or opened; ask your owner to free space for it in HOAI.",
  browser_profile_close_blocked: "Your browser could not close cleanly yet, so it is still open; try closing it again in a moment.",
  browser_profile_transition_absent: "HOAI could not find your browser's move between computers, so your owner needs to open your browser in HOAI to finish it.",
  // The backend's pre-dispatch browser_profile_writer_offline while the probe says a desktop app IS online (a relaunch
  // after a crash cannot take an earlier launch's browser; another computer may hold it). With no desktop online the
  // agent hears the offline words instead (profileSend).
  browser_profile_writer_offline: "Your browser's HOAI session is not connected right now (the app may be closed, or your browser is held by an earlier launch of the app or by another computer), so nothing ran; ask your owner to open your browser in HOAI on the computer they use, then try again.",
};
// A browser_profile_* code this copy does not know yet (a newer backend or desktop) still keeps its code. Its words
// cannot know whether the call ran, so they say to look first.
const PROFILE_UNKNOWN_TEXT = "Your browser could not take this call in HOAI; check the page with browser_snapshot before you repeat it, and ask your owner to open your browser in HOAI if this keeps happening.";
// The writer state discovery reports for a managed profile that is not active.
const PROFILE_STATE_CODE = {
  idle: "browser_profile_setup_required",
  stopped: "browser_profile_restart_review_required",
  staged: "browser_profile_restart_review_required",
  quiescing: "browser_profile_closing",
  fenced: "browser_profile_recovery_required",
};
// The backend refuses a managed profile call BEFORE dispatch with a 409 carrying this code when the authority is
// current, its writer is the owner's desktop app and no desktop socket is bound for it. Usually the owner quit the app
// (the profile row stays active by design), but a desktop relaunched after a crash cannot bind an earlier launch's
// writer either, and that app is open. So the shim asks the host probe: no desktop online is the fact host_offline
// says, and gets offline mode and its words, exactly as before the app ever ran; an online or failed probe gets the
// code's own sentence (nothing ran), which never says the app is not running (RC4).
const WRITER_OFFLINE_CODE = "browser_profile_writer_offline";
/** An answer that means the browser's host is not running (`offline` is set by the managed route only): offline mode. */
const hostAbsent = answer => answer.code === "host_offline" || answer.offline === true;

/** The browser_profile_* code a relay or profile answer carries, in its code or as the "<code>: " a host's refusal leads with, else null. */
function profileCodeOf(payload) {
  const code = payload && (payload.code || payload.error);
  if (typeof code === "string" && PROFILE_CODE.test(code)) return code;
  const carried = payload && typeof payload.message === "string" ? /^(browser_profile_[a-z0-9_]{1,80})(?::|$)/.exec(payload.message) : null;
  return carried ? carried[1] : null;
}

/** "<code>: <sentence>". On a share recipient's turn the browser is theirs, so the sentence names them, not the owner. */
function profileLine(code, context) {
  const sentence = Object.hasOwn(PROFILE_REFUSAL_TEXT, code) ? PROFILE_REFUSAL_TEXT[code] : PROFILE_UNKNOWN_TEXT;
  const words = context?.recipient ? sentence.replace(/\bYour owner\b/g, "The person you act for").replace(/\byour owner\b/g, "the person you act for") : sentence;
  return `${code}: ${words}`;
}

// The relay answers whose words name the owner's desktop app, as said on a share recipient's turn instead (item 0.2).
const RECIPIENT_RELAY_ERROR_TEXT = {
  host_offline: OFFLINE_TEXT_RELAY_RECIPIENT,
  host_timeout: "The browser's host did not answer the browser call within 50 seconds. On this turn you act for a person this agent is shared with: their browser runs on this agent's own host or on their own Home of Agents desktop app, never on the owner's desktop app. Say so and retry once; if it happens again, tell them their browser looks stuck.",
};

// A collect (GET .../mcp/:rpcId) that fails AFTER the call went pending: the call WAS SENT, so it may already have
// run (a click, a purchase, a message), and "Retry in a moment" or "Retry it once" invited a blind repeat.
const SENT_CALL_ADVICE = "The call may or may not have run, or may still be running. Check the page with browser_snapshot before you retry, and never repeat a click, a purchase or a message without checking first; if the page cannot tell you, ask your owner.";
function sentCallText(code, status, detail, error) {
  if (code === "relay_unreachable") return `This browser call was sent to the browser, but the HOAI relay could not be reached to collect its result (${error}). ${SENT_CALL_ADVICE}`;
  if (code === "call_lost") return `This browser call was sent to the browser, but the HOAI relay lost track of it before its result was collected. ${SENT_CALL_ADVICE}`;
  return `This browser call was sent to the browser, but the HOAI relay answered ${status}${detail ? `: ${detail}` : ""} when asked for its result. ${SENT_CALL_ADVICE}`;
}
// The collect failures that get the sent call's words; every other code keeps its own (collect_throttled already
// says the call was sent, host_disconnected that it may or may not have run).
const SENT_CALL_CODES = new Set(["relay_unreachable", "call_lost", "relay_error"]);

// A refusal met while CONNECTING: the shim's OWN initialize was refused, so the agent's call never left the shim.
// The call's own words ("while this call was running", "This browser call was sent", "did not answer the browser
// call") were false there; each code gets a reason true for a connection that could not be set up.
const CONNECT_LEAD = "The HOAI Agent Browser could not set up its connection to the browser, so your call was not sent. Nothing ran.";
const CONNECT_LEAD_INSTRUCTIONS = "The HOAI Agent Browser could not set up its connection to the browser.";
const CONNECT_REASON_TEXT = {
  rate_limited: "The HOAI relay refused the connection because this agent made too many browser calls at once or in the last minute. This says nothing about whether the browser is online. Wait for your other browser calls to finish, or a minute after a burst, then retry.",
  throttled: "The HOAI backend refused the connection because too many requests came from this agent's connection in a short time (a general request limit, not the browser's own). This says nothing about whether the browser is online. Wait a little, then retry.",
  // A pending answer proves only that the backend emitted the frame, not that the host received it (review round 3).
  collect_throttled: "The connection request was sent to the browser's host, but the HOAI backend refused the request that collects its answer because too many requests came from this agent's connection in a short time (a general request limit, not the browser's own). This says nothing about whether the browser is online. Wait a little, then retry.",
  host_disconnected: "The browser's host dropped its connection while the connection was being set up. HOAI cannot tell a reload or a restart from a shutdown: retry in a moment; if it keeps failing, the host was probably shut down, and the browser tools come back when it runs again.",
  host_timeout: "The browser's host did not answer the connection request in time. Retry once; if it happens again, tell your owner the browser looks stuck.",
  browser_disabled: RELAY_ERROR_TEXT.browser_disabled,
  relay_unsupported: RELAY_UNSUPPORTED_TEXT,
  call_lost: "The HOAI relay lost track of the connection request before its answer was collected. Retry in a moment; if it keeps happening, tell your owner.",
};

const CLIENT_ID = crypto.randomUUID(); // the MCP session key on the desktop side
const RELAY = readRelayCredentials(process.env);
const MANAGED_CONTEXT_REQUIRED = Object.hasOwn(process.env, "HOAI_RELAY_CONTEXT_FILE");
const PROFILE_DISCOVERY = process.env.HOAI_RELAY_PROFILE_SYNC === "1" && Boolean(RELAY?.headers["X-BGOS-Pairing"]);
const CONTEXT_REFUSAL = Object.freeze({ valid: false, code: "acting_context_unavailable", text: "This browser action was not sent because its current sender could not be verified. Send a new message in your HOAI chat and try again. Nothing ran." });

let mode = "offline"; // offline | local | relay
let upstream = null; // local: { url, token, sessionId, initialized, instructions }
const relayConnections = new Map(); // actor/chat/session clientId -> initialized relay
const profileScopes = new Map(); // verified client -> current exact authority
const managedNamespaces = new Set(); // No fallback after this process saw a namespace.
let clientInfo = null;
let clientProtocol = PROTOCOL_VERSION;
let initSeq = 0;

/**
 * Relay credentials, env only. A channel plugin that owns HOAI credentials
 * hands them to the shim (Codex through mcp_servers.hoai_browser.env, the
 * Claude Code plugin through its launcher); the shim never reads a plugin's
 * files. Two lanes: a pairing token (X-BGOS-Pairing) or, for legacy plugins,
 * an API key (X-API-Key). BOTH lanes name the assistant in the body:
 * HOAI_RELAY_ASSISTANT_ID is what the owner's rail shows as the agent that is
 * browsing, and the backend's RelayMcpDto requires it whichever header is
 * used (a pairing can back several assistants), so a pairing daemon that
 * leaves it out is answered 400 and never reaches the desktop app.
 */
function readRelayCredentials(env) {
  // The daemon's backend URL is accepted with or without the /api/v1 suffix
  // (server.ts normalises it), and the launcher hands us whatever it holds.
  // Every relay path below carries /api/v1 itself, so strip a trailing copy
  // here: with it left in, every probe went to /api/v1/api/v1/... and was
  // answered 404, which read as "host offline" for every Claude Code agent
  // whose config carried the suffix (all of them on 2026-09-13).
  const url = String(env.HOAI_RELAY_BACKEND_URL || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api\/v1$/i, "");
  if (!url) return null;
  const assistantId = String(env.HOAI_RELAY_ASSISTANT_ID || "").trim();
  const pairing = String(env.HOAI_RELAY_PAIRING_TOKEN || "").trim();
  if (pairing) return { backendUrl: url, headers: { "X-BGOS-Pairing": pairing }, assistantId: assistantId || null };
  const apiKey = String(env.HOAI_RELAY_API_KEY || "").trim();
  if (apiKey && assistantId) return { backendUrl: url, headers: { "X-API-Key": apiKey }, assistantId };
  return null;
}

function boundedJson(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0, count;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    return length <= maxBytes ? JSON.parse(bytes.subarray(0, length).toString("utf8")) : null;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// A managed shim may never infer the owner from absent or stale turn metadata.
// The synchronous marker closes the interval before the daemon processes a new
// prompt. Only the daemon signs the actor; marker contents alone grant nothing.
function readManagedContext() {
  if (!MANAGED_CONTEXT_REQUIRED) return null;
  try {
    const envelope = boundedJson(process.env.HOAI_RELAY_CONTEXT_FILE, 8192);
    const context = envelope?.context;
    const secret = RELAY?.headers["X-BGOS-Pairing"] || RELAY?.headers["X-API-Key"];
    if (!secret || !context || typeof envelope.signature !== "string" || !/^[a-f0-9]{64}$/.test(envelope.signature)) return CONTEXT_REFUSAL;
    const expected = crypto.createHmac("sha256", secret).update(JSON.stringify(context)).digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(envelope.signature, "hex"))) return CONTEXT_REFUSAL;
    const userId = value => typeof value === "string" && /^user_[A-Za-z0-9_-]{1,240}$/.test(value);
    const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value);
    const pid = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
    const age = Date.now() - context.updatedAt;
    if (context.schemaVersion !== 1 || context.live !== true || String(context.assistantId) !== RELAY.assistantId ||
        !userId(context.ownerUserId) || context.ownerUserId !== process.env.HOAI_RELAY_OWNER_USER_ID || !userId(context.actingUserId) ||
        !identifier(context.chatId) || !/^[1-9][0-9]*$/.test(context.chatId) || !identifier(context.turnId) || !identifier(context.sessionId) ||
        !pid(context.claudePid) || context.claudePid !== Number(process.env.HOAI_RELAY_CLIENT_PID) || !pid(context.pid) ||
        !Number.isFinite(context.updatedAt) || age < -5000 || age > 60000 ||
        typeof context.markerPath !== "string" || !context.markerPath || typeof context.promptHash !== "string" || !/^[a-f0-9]{64}$/.test(context.promptHash)) return CONTEXT_REFUSAL;
    process.kill(context.pid, 0);
    const marker = boundedJson(context.markerPath, 2048);
    if (marker?.schemaVersion !== 1 || marker.live !== true || marker.turnId !== context.turnId || marker.sessionId !== context.sessionId || marker.promptHash !== context.promptHash) return CONTEXT_REFUSAL;
    const clientId = crypto.createHash("sha256").update(JSON.stringify([CLIENT_ID, context.actingUserId, context.chatId, context.sessionId])).digest("hex");
    const recipient = context.actingUserId !== context.ownerUserId;
    const headers = recipient ? { "X-BGOS-Acting-User": context.actingUserId } : {};
    return Object.freeze({ valid: true, clientId, actingUserId: context.actingUserId, headers: Object.freeze(headers), recipient });
  } catch { return CONTEXT_REFUSAL; }
}
const relayClientId = context => context?.clientId || CLIENT_ID;

function readDiscovery() {
  try {
    const doc = JSON.parse(fs.readFileSync(DISCOVERY, "utf8"));
    if (doc && typeof doc.url === "string" && typeof doc.token === "string") return doc;
  } catch {}
  return null;
}

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// With a refusal (the relay answered the connect with a limit, not an absence), its words; else the absence, in the
// words for whose turn it is (a share recipient's browser is never the owner's desktop app).
function offlineText(refusal, context) {
  if (refusal && refusal.text) return refusal.text;
  if (RELAY && context?.recipient) return OFFLINE_TEXT_RELAY_RECIPIENT;
  return RELAY ? OFFLINE_TEXT_RELAY : OFFLINE_TEXT_LOCAL;
}

function setMode(next) {
  if (next === mode) return;
  mode = next;
  write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
}

// ─── Local door (the loopback endpoint on this machine) ──────────────────────

async function post(body, { url, token, sessionId }, signal) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  const sid = res.headers.get("mcp-session-id");
  const ctype = res.headers.get("content-type") || "";
  let payload = null;
  if (res.status === 202 || res.status === 204) return { status: res.status, sid, payload: null };
  const text = await res.text();
  if (ctype.includes("text/event-stream")) {
    // Take the last JSON-RPC message in the stream (the response).
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        try {
          payload = JSON.parse(line.slice(5).trim());
        } catch {}
      }
    }
  } else if (text) {
    try {
      payload = JSON.parse(text);
    } catch {}
  }
  return { status: res.status, sid, payload };
}

function initializeParams() {
  return { protocolVersion: clientProtocol, capabilities: {}, clientInfo: clientInfo || { name: "hoai-browser-shim", version: "2" } };
}

async function ensureLocal(doc) {
  if (upstream && upstream.url === doc.url && upstream.token === doc.token && upstream.initialized) return upstream;
  const candidate = { url: doc.url, token: doc.token, sessionId: null, initialized: false };
  try {
    const init = await post({ jsonrpc: "2.0", id: `shim-init-${++initSeq}`, method: "initialize", params: initializeParams() }, candidate);
    if (!init.payload || init.payload.error) throw new Error("initialize failed");
    candidate.sessionId = init.sid;
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, candidate);
    candidate.initialized = true;
    candidate.instructions = init.payload.result?.instructions || "";
    upstream = candidate;
    return upstream;
  } catch {
    upstream = null;
    return null;
  }
}

// ─── Relay door (through the owner's HOAI account to their desktop app) ──────

async function relayFetch(method, pathname, body, signal, context) {
  const headers = { Accept: "application/json", ...RELAY.headers, ...context?.headers };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(RELAY.backendUrl + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {}
  }
  return { status: res.status, payload, retryAfter: res.headers.get("retry-after") };
}

// Caller-only typed wire stays self-contained: this shim is also installed as
// a single file. Endpoint key/signature handling remains in the paired host.
function profileAuthority(value, actor, assistantId, profileId) {
  if (!value || Object.keys(value).length !== PROFILE_FIELDS.length || PROFILE_FIELDS.some(key => PROFILE_COUNTERS.has(key) ?
      !Number.isSafeInteger(value[key]) || value[key] < (key === "revision" ? 0 : 1) : typeof value[key] !== "string" || !PROFILE_ID.test(value[key])) ||
      !PROFILE_UUID.test(value.profileId) || !PROFILE_UUID.test(value.endpointId) || !/^[a-f0-9]{64}$/.test(value.keyFingerprint) ||
      value.actingUserId !== actor || value.assistantId !== assistantId || value.profileId !== profileId) throw Error("profile_scope_refused");
  return Object.freeze(Object.fromEntries(PROFILE_FIELDS.map(key => [key, value[key]])));
}
async function profileFetch(route, body, signal, context, maximum = 64 * 1024) {
  const base = new URL(RELAY.backendUrl);
  if (base.username || base.password || !(base.protocol === "https:" || base.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(base.hostname))) throw Error("profile_endpoint_refused");
  // Pairing only: the backend refuses a profile call that also carries an account key, a session or an
  // Authorization header, so the pairing token (and the signed acting person on a recipient's turn) is all it gets.
  const pairing = RELAY.headers["X-BGOS-Pairing"];
  if (!pairing) throw Error("profile_pairing_required");
  const acting = context?.headers?.["X-BGOS-Acting-User"];
  const controller = new AbortController(), abort = () => controller.abort(), timer = setTimeout(abort, Math.max(1, Math.min(30000, RELAY_PROBE_MS)));
  signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  let reader;
  try {
    const response = await fetch(new URL(PROFILE_PATH + route, base.origin), { method: "POST", headers: { Accept: "application/json", "Accept-Encoding": "identity", "Content-Type": "application/json", "X-BGOS-Pairing": pairing, ...(acting ? { "X-BGOS-Acting-User": acting } : {}) },
      body: JSON.stringify(body), signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store" });
    reader = response.body.getReader(); const chunks = []; let length = 0;
    for (;;) { const { value, done } = await reader.read(); if (done) break; if ((length += value.byteLength) > maximum) { await reader.cancel(); throw Error("profile_response_too_large"); } chunks.push(value); }
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw Error("profile_response_refused");
    return { status: response.status, payload };
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); reader?.releaseLock(); controller.abort(); }
}
// A managed profile that cannot take this call. It never selects another browser; the text is its code and sentence.
function profileRefusal(code, context) {
  return { code, profile: true, text: profileLine(code, context) };
}
async function discoverProfile(context) {
  if (!PROFILE_DISCOVERY) return null;
  const clientId = relayClientId(context); profileScopes.delete(clientId);
  try {
    const assistantId = Number(RELAY.assistantId);
    if (!Number.isSafeInteger(assistantId) || assistantId < 1) throw Error("profile_assistant_refused");
    const response = await profileFetch("/resolve", { assistantId }, undefined, context), value = response.payload;
    if (response.status < 200 || response.status >= 300) throw Object.assign(Error("profile_discovery_refused"), { profileCode: profileCodeOf(value) });
    const actor = context?.actingUserId || process.env.HOAI_RELAY_OWNER_USER_ID || value.actingUserId;
    if (typeof actor !== "string" || !PROFILE_ID.test(actor) || value.actingUserId !== actor || value.assistantId !== assistantId) throw Error("profile_actor_refused");
    const namespace = JSON.stringify([actor, assistantId]);
    if (value.managed === false && Object.keys(value).length === 3) {
      if (managedNamespaces.has(namespace)) throw Error("profile_downgrade_refused");
      return null;
    }
    if (value.managed !== true || !PROFILE_UUID.test(value.profileId) || !["idle", "active", "quiescing", "stopped", "staged", "fenced"].includes(value.state) ||
        Object.keys(value).length !== (value.state === "active" ? 6 : 5)) throw Error("profile_namespace_refused");
    if (!managedNamespaces.has(namespace) && managedNamespaces.size >= 128) throw Error("profile_namespace_limit");
    managedNamespaces.add(namespace);
    if (value.state !== "active") return { failed: profileRefusal(PROFILE_STATE_CODE[value.state], context), state: value.state };
    const authority = profileAuthority(value.authority, actor, assistantId, value.profileId);
    profileScopes.set(clientId, authority); while (profileScopes.size > 32) profileScopes.delete(profileScopes.keys().next().value);
    return { authority };
  } catch (error) { return { failed: profileRefusal(error?.profileCode || "browser_profile_unavailable", context) }; }
}
async function profileSend(message, signal, context, authority, pending) {
  const clientId = relayClientId(context), scope = { assistantId: authority.assistantId, clientId, authority, waitMs: 0 };
  let sent = false, dispatched = false;
  try {
    signal?.throwIfAborted();
    const started = Date.now(); sent = true;
    let response = await profileFetch("/call", { ...scope, message }, signal, context, 8 * 1024 * 1024 + 64 * 1024);
    for (;;) {
      if (response.status >= 200 && response.status < 300 && response.payload.status === "done") return { ok: true, message: response.payload.message || {} };
      if (response.status >= 200 && response.status < 300 && response.payload.status === "pending" && PROFILE_UUID.test(response.payload.rpcId)) {
        const rpcId = response.payload.rpcId; pending?.(rpcId); dispatched = true;
        if (Date.now() - started > RELAY_TOTAL_MS) throw Error("profile_result_timeout");
        await sleep(Math.max(25, Math.min(2000, Number(response.payload.pollAfterMs) || 250)), signal);
        response = await profileFetch(`/${rpcId}/poll`, scope, signal, context, 8 * 1024 * 1024 + 64 * 1024); continue;
      }
      // A refusal that names its browser_profile_* code says so; anything else was not confirmed, and may have run.
      const refused = profileCodeOf(response.payload);
      // Refused before dispatch (the backend's 409): nothing ran. With no desktop app online the agent hears it is not
      // running; otherwise the code's sentence. A call that already went pending was sent, so the same code on its poll
      // (or on any other status) is a call that was not confirmed and may have run.
      if (refused === WRITER_OFFLINE_CODE) {
        if (!dispatched && response.status === 409) {
          const host = await relayHostOnline(context);
          if (!host || (!host.failed && !host.online)) return { ok: false, code: WRITER_OFFLINE_CODE, offline: true, sent: false, text: offlineText(null, context) };
          return { ok: false, code: WRITER_OFFLINE_CODE, profile: true, sent: false, text: profileLine(WRITER_OFFLINE_CODE, context) };
        }
      } else if (refused) return { ok: false, code: refused, profile: true, sent, text: profileLine(refused, context) };
      return { ok: false, code: "browser_profile_unconfirmed", sent, text: profileLine("browser_profile_unconfirmed", context) };
    }
  } catch {
    signal?.throwIfAborted();
    return { ok: false, code: "browser_profile_unconfirmed", sent, text: profileLine("browser_profile_unconfirmed", context) };
  }
}

function relayErrorCode(status, payload) {
  const profile = profileCodeOf(payload);
  if (profile) return profile;
  const code = payload && (payload.code || payload.error);
  if (typeof code === "string" && RELAY_ERROR_TEXT[code]) return code;
  // A 409 is host_offline only when the relay says so in its code (above). The profile fence answers 409 while the
  // desktop is connected, and so may any conflict a newer backend adds; neither means the desktop app is not running.
  if (status === 504) return "host_timeout";
  // Only a body that says rate_limited is the relay's own per agent limit (returned above); a bare 429 is not.
  if (status === 429) return "throttled";
  if (status === 403) return "browser_disabled";
  if (status === 413) return "payload_too_large";
  if (status === 404) return "call_lost";
  return "relay_error";
}

// The codes whose text is followed by the relay's own sentence: it names the limit that was hit with the backend's
// numbers, or whether a desktop app or an agent's own browser host dropped.
const RELAY_DETAIL_CODES = new Set(["rate_limited", "throttled", "host_disconnected"]);
// The codes whose text is followed by the backend's Retry-After, when it sends one.
const RETRY_AFTER_CODES = new Set(["rate_limited", "throttled", "collect_throttled"]);

/** Retry-After in whole seconds (the delta form; an HTTP date is ignored), or null. */
function retryAfterSeconds(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  return Math.ceil(Number(raw));
}

function relayDetail(payload) {
  return payload && typeof payload.message === "string" ? payload.message.slice(0, 300) : "";
}

// The relay's own sentence (for the codes that carry one) and its Retry-After (for the codes that honour one).
function relaySuffix(code, payload, retryAfter, saidAbout = "") {
  const detail = relayDetail(payload);
  let text = "";
  if (detail && RELAY_DETAIL_CODES.has(code)) text += ` The relay said${saidAbout}: "${detail}"`;
  const wait = RETRY_AFTER_CODES.has(code) ? retryAfterSeconds(retryAfter) : null;
  if (wait !== null) text += ` The relay asks you to wait ${wait} seconds before you retry.`;
  return text;
}

function relayErrorText(code, status, payload, retryAfter, context) {
  if (PROFILE_CODE.test(code)) return profileLine(code, context);
  if (RELAY_ERROR_TEXT[code]) return RELAY_ERROR_TEXT[code] + relaySuffix(code, payload, retryAfter);
  const detail = relayDetail(payload);
  return `The HOAI relay answered ${status}${detail ? `: ${detail}` : ""}. Retry once; if it persists, tell the owner.`;
}

/**
 * The reason a refusal met while CONNECTING gets, from the failed relaySend of the shim's own initialize (or the
 * host's JSON-RPC error to it). Without the lead: the tool result and the initialize instructions each put their own
 * in front.
 */
function connectReason(res) {
  if (res.code === "browser_profile_unconfirmed") return "The current managed browser did not confirm the connection. It was not replaced or retried. Open Browser in HOAI to review that session.";
  if (res.hostError) return `The browser's host answered the connection request with an error: ${String(res.hostError).slice(0, 300)}. Retry in a moment; if it keeps happening, tell your owner.`;
  const base = CONNECT_REASON_TEXT[res.code];
  if (base && res.code === "host_disconnected") return base + droppedHostSuffix(res.payload);
  if (base) return base + relaySuffix(res.code, res.payload, res.retryAfter, " about the connection request");
  if (res.code === "relay_unreachable") return `The HOAI relay could not be reached (${res.error}). Retry in a moment.`;
  const detail = relayDetail(res.payload);
  return `The HOAI relay answered ${res.status}${detail ? `: ${detail}` : ""} to the connection request. Retry in a moment; if it keeps happening, tell your owner.`;
}

/**
 * Who dropped, for a host_disconnected met while CONNECTING. The backend's hostGone sentence ("... disconnected while
 * running this call.") was written for a call in flight, and while connecting the agent's call never left the shim, so
 * it is not passed on (review round 3). Only the host it names is: the owner's desktop app, or the browser host on the
 * agent's own machine (daemon placement). A sentence that names neither adds nothing.
 */
function droppedHostSuffix(payload) {
  const detail = relayDetail(payload);
  if (/browser host for this agent/i.test(detail)) return " The relay reported that the host that dropped was the browser host on this agent's own machine.";
  if (/desktop app/i.test(detail)) return " The relay reported that the host that dropped was the Home of Agents desktop app.";
  return "";
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/**
 * Send one MCP message through the relay. Resolves { ok: true, message } with
 * the JSON-RPC response (an empty object for a notification), or
 * { ok: false, code, text, transport? } where transport marks a network
 * failure (the relay itself is unreachable) as opposed to an honest answer.
 */
async function relaySend(message, signal, context, pending) {
  signal?.throwIfAborted();
  const authority = profileScopes.get(relayClientId(context));
  if (authority) return profileSend(message, signal, context, authority, pending);
  const body = { clientId: relayClientId(context), message, waitMs: RELAY_WAIT_MS };
  if (RELAY.assistantId) body.assistantId = RELAY.assistantId;
  const startedAt = Date.now();
  let collecting = false; // true once the call went pending: from then on it was SENT, whatever the answer
  let r;
  try {
    r = await relayFetch("POST", RELAY_MCP_PATH, body, signal, context);
  } catch (e) {
    signal?.throwIfAborted();
    const error = String(e?.message || e);
    return { ok: false, code: "relay_unreachable", transport: true, error, text: `The HOAI relay is unreachable (${error}). Retry in a moment.` };
  }
  if (r.status === 404) return { ok: false, code: "relay_unsupported", text: RELAY_UNSUPPORTED_TEXT };
  for (;;) {
    // The ANSWER is the body's `status`, not the HTTP code: a NestJS POST
    // answers 201 by default, so a relayed message that worked comes back
    // 201 { status: "done" } and one that went long comes back
    // 201 { status: "pending" } (the plan's 200 / 202 are the shapes, not the
    // codes). Reading the code instead threw every successful relay away as
    // relay_error and told the agent the owner's desktop app was offline,
    // which is the whole relay lane. Errors DO carry their status (409, 504,
    // 429, 413, 403, 502, 404), so those still map by code below.
    const ok2xx = r.status >= 200 && r.status < 300;
    if (ok2xx && r.payload && r.payload.status === "done") return { ok: true, message: r.payload.message || {} };
    if (ok2xx && r.payload && r.payload.status === "pending" && r.payload.rpcId) {
      if (Date.now() - startedAt > RELAY_TOTAL_MS) return { ok: false, code: "host_timeout", text: RELAY_ERROR_TEXT.host_timeout };
      await sleep(Math.max(250, Number(r.payload.pollAfterMs) || 2000), signal);
      try {
        collecting = true;
        r = await relayFetch("GET", `${RELAY_MCP_PATH}/${encodeURIComponent(r.payload.rpcId)}`, undefined, signal, context);
      } catch (e) {
        signal?.throwIfAborted();
        // The collect never came back, but the call it collects WAS SENT.
        const error = String(e?.message || e);
        return { ok: false, code: "relay_unreachable", transport: true, sent: true, error, text: sentCallText("relay_unreachable", 0, "", error) };
      }
      continue;
    }
    // Any 429 on the collect is a limit on COLLECTING, never the relay refusing to send: the call already went.
    const code = collecting && r.status === 429 ? "collect_throttled" : relayErrorCode(r.status, r.payload);
    const text = collecting && SENT_CALL_CODES.has(code) ? sentCallText(code, r.status, relayDetail(r.payload), "") : relayErrorText(code, r.status, r.payload, r.retryAfter, context);
    return { ok: false, code, ...(PROFILE_CODE.test(code) ? { profile: true } : {}), sent: collecting, text, status: r.status, payload: r.payload, retryAfter: r.retryAfter };
  }
}

async function relayHostOnline(context) {
  try {
    // With an assistant configured, ask for THAT agent's host: the backend then answers with the agent's own
    // machine when the owner placed it there (hostKind "agent"), and only otherwise with the owner's desktop.
    // The plain probe answers for the desktop alone, so an agent on its own machine read as offline whenever the
    // owner's app was closed, which is the one time that placement exists for (Mission 25 goal 6, 2026-09-25).
    const probePath = RELAY.assistantId ? `${RELAY_HOST_PATH}?assistantId=${encodeURIComponent(RELAY.assistantId)}` : RELAY_HOST_PATH;
    const r = await relayFetch("GET", probePath, undefined, AbortSignal.timeout(RELAY_PROBE_TIMEOUT_MS), context);
    // A refused probe (a 429 from the global request throttler, a 5xx, a 401) says NOTHING about the desktop app:
    // it used to read as "no host", and the agent was told the app "is not running or not signed in".
    if (r.status !== 200) return { failed: probeFailure(r.status, r.retryAfter) };
    if (!r.payload) return null;
    return { online: !!r.payload.online, hostLabel: r.payload.hostLabel || null };
  } catch (e) {
    return { failed: { code: "relay_unreachable", text: `The HOAI relay is unreachable (${String(e?.message || e)}), so the browser's status could not be checked. Retry in a moment.` } };
  }
}

function probeFailure(status, retryAfter) {
  if (status === 404) return { code: "relay_unsupported", text: RELAY_UNSUPPORTED_TEXT };
  const wait = retryAfterSeconds(retryAfter);
  return {
    code: "host_probe_failed",
    text: `The HOAI Agent Browser could not check whether your browser is online: the HOAI backend answered ${status} to the status check, so this says nothing about whether it is running. Nothing ran. Try again in a moment; if it keeps happening, tell your owner.` + (wait !== null ? ` The backend asks you to wait ${wait} seconds first.` : ""),
  };
}

/**
 * Resolves { relay } when the relay session is up, else { relay: null, refusal }. `refusal` is the relay's own
 * answer to the initialize ({ code, text }) whenever the host WAS online and the relay said something other than
 * host_offline: a rate limit, a dropped connection, a switched off browser. It used to be swallowed into offline,
 * so a fresh shim whose initialize met the 60 a minute limit told its agent the owner's desktop app "is not running
 * or not signed in" while the app was up and driving (P3 stage 4 rig, R3 attempt 2).
 *
 * A connect refusal carries `reason`, a sentence true for a connection that could not be set up: the agent's call
 * has not left the shim, so the call's own words ("while this call was running", "was sent to the browser") were
 * false here (review round 2). `text` is the reason behind CONNECT_LEAD, which a tool result shows; the initialize
 * instructions put CONNECT_LEAD_INSTRUCTIONS in front instead, because no call of the agent's exists yet.
 */
async function ensureRelay(context) {
  const clientId = relayClientId(context);
  const profile = await discoverProfile(context);
  if (profile?.failed) {
    relayConnections.delete(clientId);
    // A managed profile that is not active says nothing about whether the desktop app runs, so the probe is asked
    // once: with the app closed (online false, or no payload) the agent hears it is not running, as before the app
    // ever ran. An online answer, or a probe that failed, keeps the state's own sentence.
    if (profile.state) {
      const host = await relayHostOnline(context);
      if (!host || (!host.failed && !host.online)) return { relay: null, refusal: null };
    }
    return { relay: null, refusal: profile.failed };
  }
  const existing = relayConnections.get(clientId);
  if (existing?.initialized && JSON.stringify(existing.profileAuthority || null) === JSON.stringify(profile?.authority || null)) return { relay: existing };
  const host = profile?.authority ? { online: true, hostLabel: "Managed browser through HOAI" } : await relayHostOnline(context);
  if (host && host.failed) return { relay: null, refusal: host.failed };
  if (!host || !host.online) return { relay: null, refusal: null };
  const init = await relaySend({ jsonrpc: "2.0", id: `shim-init-${++initSeq}`, method: "initialize", params: initializeParams() }, undefined, context);
  // A profile refusal is said as itself (its code and sentence), never as a connection that could not be set up; a
  // host that is not running (the relay's host_offline, the backend's browser_profile_writer_offline) is offline mode.
  if (!init.ok) return { relay: null, refusal: hostAbsent(init) ? null : init.profile ? { code: init.code, profile: true, text: init.text } : connectRefusal(init) };
  if (init.message && init.message.error) return { relay: null, refusal: connectRefusal({ code: "host_init_error", hostError: init.message.error.message || JSON.stringify(init.message.error) }) };
  if (!init.message) return { relay: null, refusal: null };
  await relaySend({ jsonrpc: "2.0", method: "notifications/initialized" }, undefined, context).catch(() => {});
  const relay = { initialized: true, instructions: init.message.result?.instructions || "", hostLabel: host.hostLabel, ...(profile?.authority ? { profileAuthority: profile.authority } : {}) };
  relayConnections.delete(clientId); relayConnections.set(clientId, relay);
  while (relayConnections.size > 32) relayConnections.delete(relayConnections.keys().next().value);
  return { relay };
}

function connectRefusal(res) {
  const reason = connectReason(res);
  return { code: res.code, connecting: true, reason, text: `${CONNECT_LEAD} ${reason}` };
}

function dropRelay(code, context) {
  // An honest host_offline, a dropped host (host_disconnected: the window
  // reloaded, so the desktop's session died with its socket) or a dead relay
  // means the session on the desktop is gone; the next call re-elects through
  // a fresh initialize.
  // A browser_profile_* refusal too: the next call discovers the profile afresh. The backend's
  // browser_profile_writer_offline means the session holding the browser is gone, forgotten as host_offline is.
  if (code === "host_offline" || code === WRITER_OFFLINE_CODE || code === "host_disconnected" || code === "relay_unreachable" || code === "relay_unsupported" || code === "call_lost" || PROFILE_CODE.test(code)) relayConnections.delete(relayClientId(context));
}

// ─── One browser per agent: no profile question (BGOS mission 173) ───────────
//
// KC, 2026-10-19: an agent opens its own browser and never asks its owner a profile question. A desktop before 5.22
// still offers "profile: preview or signed-in", preview by default, in its open tool, its close tool and its
// instructions, and this agent's own browser host listed the same choice, so the shim serves every host's words
// without it. On a HOAI route (relay or managed profile) it opens the agent's own browser itself: signed-in, the
// agent's persistent profile and the only one a managed desktop opens. On this machine's loopback door the owner's
// own default applies, which for a client it cannot verify is a temporary browser. A future host that drops the
// choice loses nothing else; its open tool still gets the one sentence.
const OWN_BROWSER_SENTENCE = "This opens your own browser, the one your owner set up for you; there is no profile to choose.";
// On the loopback door the desktop cannot verify the client, so it opens a temporary browser (desktop-host.js
// defaultProfileFor: preview unless verified).
const LOCAL_BROWSER_SENTENCE = "This opens a temporary browser on this computer; there is no profile to choose.";
const OWN_BROWSER_PROFILE = "signed-in";
// Sentences that offer, or report, a choice of profile.
const PROFILE_CHOICE = /\bpreview\b|\bprofile\s*:?\s*"?(?:preview|signed-in)\b/i;
// The 5.21 desktop's instructions, said without the choice but keeping what they tell the agent.
const INSTRUCTION_REWRITES = [
  [/,? and profile "preview" \([^()]*\) or "signed-in" \([^()]*\)/g, ""],
  [/ and profile "signed-in"/g, ""],
  [/\bSigned-in is per agent and remembered:/g, "Your browser is your own and remembered:"],
  [/\byour next signed-in session\b/g, "your next session"],
  [/\bIf you skip this, a verified HOAI agent opens its own signed-in profile by default; an unverified local client opens a preview\./g, "If you skip this, your first browser tool opens your own browser."],
  [/\bAn explicit preview or a verify session remains temporary\./g, "A verify session remains temporary."],
  [/\btemporary preview browser\b/g, "temporary browser"],
];
// The same instructions on this machine's loopback door, where nothing is remembered: the desktop cannot verify
// the client, so its browser is temporary.
const LOCAL_INSTRUCTION_REWRITES = [
  INSTRUCTION_REWRITES[0],
  INSTRUCTION_REWRITES[1],
  [/\bSigned-in is per agent and remembered:[^\n]*?still signed in\./g, "On this computer's direct connection your browser is temporary: nothing is remembered after it closes."],
  [/\bIf you skip this, a verified HOAI agent opens its own signed-in profile by default; an unverified local client opens a preview\./g, "If you skip this, your first browser tool opens it for you."],
  ...INSTRUCTION_REWRITES.slice(5),
];
// Split on a sentence end inside one line; "1. hoai_browser_open_session" is not one (no capital follows).
const SENTENCE_END = /(?<=[a-z0-9)"'\]][.!?])\s+(?=[A-Z])/;

function withoutProfileChoice(text, rewrites = []) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [pattern, replacement] of rewrites) out = out.replace(pattern, replacement);
  out = out.replace(/\s*\([^()]*\b(?:preview|signed-in)\b[^()]*\)/gi, "");
  return out.split("\n").map(line => line.split(SENTENCE_END).filter(sentence => !PROFILE_CHOICE.test(sentence)).join(" ")).join("\n");
}

/** A host's tool list with no profile choice: hoai_browser_open_session loses its profile argument and says why. */
function withoutProfileTools(message, route) {
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) return message;
  const served = tools.map(tool => {
    if (!tool || typeof tool.name !== "string" || !tool.name.startsWith("hoai_browser_")) return tool;
    const copy = { ...tool, description: withoutProfileChoice(tool.description) };
    if (tool.name === "hoai_browser_open_session") {
      const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object" };
      const { profile: _profile, ...kept } = schema.properties || {};
      // An argument's own words may report the choice too (the desktop's verify: "Always opens a Preview session.").
      const properties = Object.fromEntries(Object.entries(kept).map(([name, property]) => [name, property && typeof property.description === "string" ? { ...property, description: withoutProfileChoice(property.description) } : property]));
      copy.inputSchema = { ...schema, properties, ...(Array.isArray(schema.required) ? { required: schema.required.filter(name => name !== "profile") } : {}) };
      copy.description = [copy.description, route === "local" ? LOCAL_BROWSER_SENTENCE : OWN_BROWSER_SENTENCE].filter(Boolean).join(" ");
    }
    return copy;
  });
  return { ...message, result: { ...message.result, tools: served } };
}

/** The open call as the shim sends it: the agent's own profile on a HOAI route, the owner's default on loopback. */
function ownBrowserCall(params, route) {
  if (params?.name !== "hoai_browser_open_session") return params;
  const { profile: _profile, ...args } = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  return { ...params, arguments: route === "local" ? args : { ...args, profile: OWN_BROWSER_PROFILE } };
}

/**
 * A host's tool refusal that names a browser_profile_* code (the desktop's "### Error\ntool_error: <code>" or
 * "### Error\n<code>: ...", or a JSON-RPC error saying it) is answered with that code and its one sentence.
 */
function withProfileRefusal(message, context) {
  const result = message?.result;
  const first = result?.isError === true && Array.isArray(result.content) ? result.content.find(item => item?.type === "text") : null;
  const lead = first ? /^### Error\n(?:tool_error: )?(browser_profile_[a-z0-9_]{1,80})(?::|\s|$)/.exec(String(first.text || "")) :
    message?.error ? /^(?:tool_error: )?(browser_profile_[a-z0-9_]{1,80})(?::|\s|$)/.exec(String(message.error.message || "")) : null;
  if (!lead) return message;
  const { error: _error, ...rest } = message;
  return { ...rest, result: { ...(result || {}), content: [{ type: "text", text: profileLine(lead[1], context) }], isError: true } };
}

// ─── Mode resolution: local, then relay, then offline ────────────────────────

const resolving = new Map();
function resolveMode(context = readManagedContext()) {
  if (context?.valid === false) { setMode("offline"); return Promise.resolve({ mode: "offline", refusal: context }); }
  const key = relayClientId(context);
  if (!resolving.has(key)) resolving.set(key, doResolveMode(context).finally(() => resolving.delete(key)));
  return resolving.get(key);
}

async function doResolveMode(context) {
  const doc = MANAGED_CONTEXT_REQUIRED ? null : readDiscovery();
  if (doc) {
    const up = await ensureLocal(doc);
    if (up) {
      setMode("local");
      return { mode: "local", up };
    }
  }
  upstream = null;
  let refusal = null;
  if (RELAY) {
    const r = await ensureRelay(context);
    if (r.relay) {
      setMode("relay");
      return { mode: "relay", relay: r.relay };
    }
    refusal = r.refusal;
  }
  relayConnections.delete(relayClientId(context));
  setMode("offline");
  return { mode: "offline", refusal };
}

// While a host is missing, look for it so the tools appear without a request.
const probe = setInterval(() => {
  if (mode !== "offline" || !clientInfo) return;
  if (!RELAY && !readDiscovery()) return;
  resolveMode().catch(() => {});
}, RELAY_PROBE_MS);
probe.unref();

// ─── The stdio side ──────────────────────────────────────────────────────────

// Track queued as well as dispatched requests. A cancellation never waits
// behind the very tool it is trying to stop. Map keys retain JSON-RPC ID type.
const requests = new Map();

async function cancelRequest(notification) {
  const entry = requests.get(notification.params?.requestId);
  // initialize is not cancellable in MCP. Unknown, completed and duplicate
  // cancellations are harmless, and never get forwarded to another session.
  if (!entry || entry.cancelled || entry.method === "initialize") return;
  entry.cancelled = true;
  const destination = entry.destination;
  entry.cancelling = !!destination;
  entry.controller.abort(new Error("Request cancelled by caller"));
  if (!destination) return; // Still queued/connecting: no tool was sent.
  const message = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: entry.id, reason: "Caller cancelled the request" } };
  try {
    // This notification has its own short deadline: aborting result collection
    // must not abort delivery of cancellation to the host's SDK AbortSignal.
    const signal = AbortSignal.timeout(CANCEL_DELIVERY_MS);
    if (destination.mode === "local") {
      const response = await post(message, destination.up, signal);
      if (response.status < 200 || response.status >= 300) throw new Error("Cancellation refused");
    } else if (destination.mode === "profile") {
      if (!destination.rpcId) throw Error("Cancellation outcome unknown");
      const response = await profileFetch(`/${destination.rpcId}/cancel`, { assistantId: destination.authority.assistantId, clientId: destination.clientId, authority: destination.authority, waitMs: 0 }, signal, destination.context);
      if (response.status < 200 || response.status >= 300) throw Error("Cancellation refused");
    } else {
      const response = await relaySend(message, signal, destination.context);
      if (!response.ok) throw new Error("Cancellation refused");
    }
  } catch {
    // No tokens, endpoint, page data, request arguments or caller reason.
    // Delivery failure never replays the original potentially mutating call.
    process.stderr.write("HOAI browser: cancellation delivery was not confirmed; the action may still be running.\n");
  } finally {
    entry.cancelling = false;
    if (entry.finished && requests.get(entry.id) === entry) requests.delete(entry.id);
  }
}

async function handle(msg, entry) {
  const { id, method, params } = msg;
  const send = response => { if (!entry?.cancelled) write(response); };
  const reply = (result) => send({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const signal = entry?.controller.signal;
  const context = entry?.context ?? readManagedContext();
  const resolveRequestMode = async () => {
    signal?.throwIfAborted();
    const resolved = await resolveMode(context);
    signal?.throwIfAborted();
    return resolved;
  };
  const localRequest = async (body, up) => {
    signal?.throwIfAborted();
    if (entry) entry.destination = { mode: "local", up: { ...up } };
    return post(body, up, signal).catch(() => { signal?.throwIfAborted(); return null; });
  };
  const relayRequest = async body => {
    signal?.throwIfAborted();
    const authority = profileScopes.get(relayClientId(context));
    if (entry) entry.destination = authority ? { mode: "profile", context, authority, clientId: relayClientId(context), rpcId: null } : { mode: "relay", context };
    return relaySend(body, signal, context, rpcId => { if (entry?.destination?.mode === "profile" && entry.destination.authority === authority) entry.destination.rpcId = rpcId; });
  };
  if (method === "initialize") {
    clientInfo = params?.clientInfo || null;
    clientProtocol = params?.protocolVersion || PROTOCOL_VERSION;
    const r = await resolveRequestMode();
    const instructions = r.mode === "local" ? withoutProfileChoice(r.up.instructions, LOCAL_INSTRUCTION_REWRITES) : r.mode === "relay" ? withoutProfileChoice(r.relay.instructions, INSTRUCTION_REWRITES) : "";
    // A profile refusal comes from a browser that answered, so it is not told as an unreachable desktop app.
    const lead = r.refusal?.profile ? "HOAI Agent Browser: your default browser. " : "HOAI Agent Browser: your default browser once the Home of Agents desktop app is reachable. ";
    return reply({
      protocolVersion: clientProtocol,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "hoai-agent-browser", version: "shim-2" },
      instructions: instructions || lead + (r.refusal && r.refusal.connecting ? `${CONNECT_LEAD_INSTRUCTIONS} ${r.refusal.reason}` : offlineText(r.refusal, context)),
    });
  }
  if (method && method.startsWith("notifications/")) return; // no reply to notifications
  if (method === "ping") return reply({});
  if (method === "tools/list") {
    const r = await resolveRequestMode();
    if (r.mode === "offline") return reply({ tools: [r.refusal?.profile ? PROFILE_REFUSED_TOOL : OFFLINE_TOOL] });
    if (r.mode === "local") {
      const res = await localRequest({ jsonrpc: "2.0", id, method, params: params || {} }, r.up);
      if (!res?.payload) {
        upstream = null;
        return reply({ tools: [OFFLINE_TOOL] });
      }
      return send({ ...withoutProfileTools(res.payload, "local"), id });
    }
    const res = await relayRequest({ jsonrpc: "2.0", id, method, params: params || {} });
    if (!res.ok || !res.message || !res.message.result) {
      dropRelay(res.code, context);
      if (!relayConnections.has(relayClientId(context))) setMode("offline");
      return reply({ tools: [OFFLINE_TOOL] });
    }
    return send({ ...withoutProfileTools(res.message, "relay"), id });
  }
  if (method === "tools/call") {
    const r = await resolveRequestMode();
    if (r.mode === "offline") return reply({ content: [{ type: "text", text: offlineText(r.refusal, context) }], isError: params?.name !== "hoai_browser_status" });
    if (r.mode === "local") {
      const res = await localRequest({ jsonrpc: "2.0", id, method, params: ownBrowserCall(params, "local") }, r.up);
      if (!res?.payload) {
        upstream = null;
        return reply({ content: [{ type: "text", text: "The HOAI Agent Browser stopped answering (the desktop app may have quit). " + offlineText(undefined, context) }], isError: true });
      }
      return send({ ...withProfileRefusal(res.payload, context), id });
    }
    const res = await relayRequest({ jsonrpc: "2.0", id, method, params: ownBrowserCall(params, "relay") });
    if (!res.ok) {
      dropRelay(res.code, context);
      if (!relayConnections.has(relayClientId(context))) setMode("offline");
      const text = context?.recipient && Object.hasOwn(RECIPIENT_RELAY_ERROR_TEXT, res.code) ? RECIPIENT_RELAY_ERROR_TEXT[res.code] : res.text;
      return reply({ content: [{ type: "text", text }], isError: params?.name !== "hoai_browser_status" || !hostAbsent(res) });
    }
    if (params?.name === "hoai_browser_status" && res.message?.result && !res.message.result.isError && r.relay.hostLabel) {
      // Say WHERE the browser is. This used to read "Reached through your
      // owner's account on <host>", which was already loose about an account
      // versus an app and became wrong outright when the acting-principal
      // election shipped (#1846): the backend elects a desktop belonging to the
      // ACTING human, and desktop-host.js refuses a `user-` principal that is
      // not that desktop's signed-in owner. The host label answers which
      // computer, since a person may have several.
      //
      // On a share recipient's turn it also says WHOSE browser this is, or the
      // agent assumes the owner's (shared agents Phase 0, item 0.2; KC's
      // decision D3): the relay elects this agent's own host, which for a
      // daemon placed agent is the owner's computer and a recipient may browse
      // on, else the recipient's own desktop app, and never the owner's
      // desktop app. On the owner's own turn the line is unchanged.
      const result = res.message.result;
      const content = Array.isArray(result.content) ? result.content : [];
      const where = `Reached on ${r.relay.hostLabel}.` + (context?.recipient ? ` ${RECIPIENT_BROWSER_TEXT}` : "");
      return send({ ...res.message, id, result: { ...result, content: [...content, { type: "text", text: where }] } });
    }
    return send({ ...withProfileRefusal(res.message, context), id });
  }
  return fail(-32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  if (msg.method === "notifications/cancelled" && msg.id === undefined) {
    void cancelRequest(msg);
    return;
  }
  const hasId = typeof msg.id === "string" || (typeof msg.id === "number" && Number.isFinite(msg.id));
  if (hasId && requests.has(msg.id)) {
    write({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "Request ID is already in flight" } });
    return;
  }
  const entry = hasId ? { id: msg.id, method: msg.method, context: readManagedContext(), controller: new AbortController(), destination: null, cancelled: false } : null;
  if (entry) requests.set(msg.id, entry);
  chain = chain.then(() => { if (!entry?.cancelled) return handle(msg, entry); }).catch((e) => {
    if (hasId && !entry.cancelled) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e?.message || e) } });
  }).finally(() => {
    if (entry) entry.finished = true;
    if (entry && !entry.cancelling && requests.get(msg.id) === entry) requests.delete(msg.id);
  });
});
rl.on("close", () => process.exit(0));
