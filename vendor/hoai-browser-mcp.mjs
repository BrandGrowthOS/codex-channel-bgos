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
const CANCEL_DELIVERY_MS = 5_000;
const RELAY_MCP_PATH = "/api/v1/integrations/browser/mcp";
const RELAY_HOST_PATH = "/api/v1/integrations/browser/host";

const OFFLINE_TOOL = {
  name: "hoai_browser_status",
  description: "Status of the HOAI Agent Browser (the browser pane in the Home of Agents desktop app). When the app is not reachable this is the only tool; it tells you so.",
  inputSchema: { type: "object", properties: {} },
  annotations: { title: "Browser session status", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};
const OFFLINE_TEXT_LOCAL = "The HOAI Agent Browser is not available: the Home of Agents desktop app is not running on this computer (or the agent browser endpoint is off). Ask the owner to open Home of Agents; Cmd or Ctrl+Shift+B opens the Agent Browser. The browser tools appear here as soon as it is up.";
const OFFLINE_TEXT_RELAY = "The HOAI Agent Browser is not available: your owner's Home of Agents desktop app is not running or not signed in, and there is no desktop app on this machine. Ask them to open Home of Agents on their computer (Cmd or Ctrl+Shift+B opens the Agent Browser); the browser tools appear here as soon as it is online.";
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

let mode = "offline"; // offline | local | relay
let upstream = null; // local: { url, token, sessionId, initialized, instructions }
let relay = null; // relay: { initialized, instructions, hostLabel }
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

// With a refusal (the relay answered the connect with a limit, not an absence), its words; else the absence.
function offlineText(refusal) {
  if (refusal && refusal.text) return refusal.text;
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

async function relayFetch(method, pathname, body, signal) {
  const headers = { Accept: "application/json", ...RELAY.headers };
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

function relayErrorCode(status, payload) {
  const code = payload && (payload.code || payload.error);
  if (typeof code === "string" && RELAY_ERROR_TEXT[code]) return code;
  if (status === 409) return "host_offline";
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

function relayErrorText(code, status, payload, retryAfter) {
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
async function relaySend(message, signal) {
  signal?.throwIfAborted();
  const body = { clientId: CLIENT_ID, message, waitMs: RELAY_WAIT_MS };
  if (RELAY.assistantId) body.assistantId = RELAY.assistantId;
  const startedAt = Date.now();
  let collecting = false; // true once the call went pending: from then on it was SENT, whatever the answer
  let r;
  try {
    r = await relayFetch("POST", RELAY_MCP_PATH, body, signal);
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
        r = await relayFetch("GET", `${RELAY_MCP_PATH}/${encodeURIComponent(r.payload.rpcId)}`, undefined, signal);
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
    const text = collecting && SENT_CALL_CODES.has(code) ? sentCallText(code, r.status, relayDetail(r.payload), "") : relayErrorText(code, r.status, r.payload, r.retryAfter);
    return { ok: false, code, sent: collecting, text, status: r.status, payload: r.payload, retryAfter: r.retryAfter };
  }
}

async function relayHostOnline() {
  try {
    // With an assistant configured, ask for THAT agent's host: the backend then answers with the agent's own
    // machine when the owner placed it there (hostKind "agent"), and only otherwise with the owner's desktop.
    // The plain probe answers for the desktop alone, so an agent on its own machine read as offline whenever the
    // owner's app was closed, which is the one time that placement exists for (Mission 25 goal 6, 2026-09-25).
    const probePath = RELAY.assistantId ? `${RELAY_HOST_PATH}?assistantId=${encodeURIComponent(RELAY.assistantId)}` : RELAY_HOST_PATH;
    const r = await relayFetch("GET", probePath);
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
async function ensureRelay() {
  if (relay && relay.initialized) return { relay };
  const host = await relayHostOnline();
  if (host && host.failed) return { relay: null, refusal: host.failed };
  if (!host || !host.online) return { relay: null, refusal: null };
  const init = await relaySend({ jsonrpc: "2.0", id: `shim-init-${++initSeq}`, method: "initialize", params: initializeParams() });
  if (!init.ok) return { relay: null, refusal: init.code === "host_offline" ? null : connectRefusal(init) };
  if (init.message && init.message.error) return { relay: null, refusal: connectRefusal({ code: "host_init_error", hostError: init.message.error.message || JSON.stringify(init.message.error) }) };
  if (!init.message) return { relay: null, refusal: null };
  await relaySend({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
  relay = { initialized: true, instructions: init.message.result?.instructions || "", hostLabel: host.hostLabel };
  return { relay };
}

function connectRefusal(res) {
  const reason = connectReason(res);
  return { code: res.code, connecting: true, reason, text: `${CONNECT_LEAD} ${reason}` };
}

function dropRelay(code) {
  // An honest host_offline, a dropped host (host_disconnected: the window
  // reloaded, so the desktop's session died with its socket) or a dead relay
  // means the session on the desktop is gone; the next call re-elects through
  // a fresh initialize.
  if (code === "host_offline" || code === "host_disconnected" || code === "relay_unreachable" || code === "relay_unsupported" || code === "call_lost") relay = null;
}

// ─── Mode resolution: local, then relay, then offline ────────────────────────

let resolving = null;
function resolveMode() {
  if (!resolving) resolving = doResolveMode().finally(() => {
    resolving = null;
  });
  return resolving;
}

async function doResolveMode() {
  const doc = readDiscovery();
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
    const r = await ensureRelay();
    if (r.relay) {
      setMode("relay");
      return { mode: "relay", relay: r.relay };
    }
    refusal = r.refusal;
  }
  relay = null;
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
    } else {
      const response = await relaySend(message, signal);
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
  const resolveRequestMode = async () => {
    signal?.throwIfAborted();
    const resolved = await resolveMode();
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
    if (entry) entry.destination = { mode: "relay" };
    return relaySend(body, signal);
  };
  if (method === "initialize") {
    clientInfo = params?.clientInfo || null;
    clientProtocol = params?.protocolVersion || PROTOCOL_VERSION;
    const r = await resolveRequestMode();
    const instructions = r.mode === "local" ? r.up.instructions : r.mode === "relay" ? r.relay.instructions : "";
    return reply({
      protocolVersion: clientProtocol,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "hoai-agent-browser", version: "shim-2" },
      instructions: instructions || "HOAI Agent Browser: your default browser once the Home of Agents desktop app is reachable. " + (r.refusal && r.refusal.connecting ? `${CONNECT_LEAD_INSTRUCTIONS} ${r.refusal.reason}` : offlineText(r.refusal)),
    });
  }
  if (method && method.startsWith("notifications/")) return; // no reply to notifications
  if (method === "ping") return reply({});
  if (method === "tools/list") {
    const r = await resolveRequestMode();
    if (r.mode === "offline") return reply({ tools: [OFFLINE_TOOL] });
    if (r.mode === "local") {
      const res = await localRequest({ jsonrpc: "2.0", id, method, params: params || {} }, r.up);
      if (!res?.payload) {
        upstream = null;
        return reply({ tools: [OFFLINE_TOOL] });
      }
      return send({ ...res.payload, id });
    }
    const res = await relayRequest({ jsonrpc: "2.0", id, method, params: params || {} });
    if (!res.ok || !res.message || !res.message.result) {
      dropRelay(res.code);
      if (!relay) setMode("offline");
      return reply({ tools: [OFFLINE_TOOL] });
    }
    return send({ ...res.message, id });
  }
  if (method === "tools/call") {
    const r = await resolveRequestMode();
    if (r.mode === "offline") return reply({ content: [{ type: "text", text: offlineText(r.refusal) }], isError: params?.name !== "hoai_browser_status" });
    if (r.mode === "local") {
      const res = await localRequest({ jsonrpc: "2.0", id, method, params }, r.up);
      if (!res?.payload) {
        upstream = null;
        return reply({ content: [{ type: "text", text: "The HOAI Agent Browser stopped answering (the desktop app may have quit). " + offlineText() }], isError: true });
      }
      return send({ ...res.payload, id });
    }
    const res = await relayRequest({ jsonrpc: "2.0", id, method, params });
    if (!res.ok) {
      dropRelay(res.code);
      if (!relay) setMode("offline");
      return reply({ content: [{ type: "text", text: res.text }], isError: params?.name !== "hoai_browser_status" || res.code !== "host_offline" });
    }
    if (params?.name === "hoai_browser_status" && res.message?.result && !res.message.result.isError && r.relay.hostLabel) {
      // Say WHERE the browser is and claim nothing about WHOSE it is. This
      // used to read "Reached through your owner's account on <host>", which
      // was already loose about an account versus an app and became wrong
      // outright when the acting-principal election shipped (#1846): the
      // backend elects a desktop belonging to the ACTING human, and
      // desktop-host.js refuses a `user-` principal that is not that
      // desktop's signed-in owner. So for a shared agent the page does not run
      // on the owner's machine at all, and the old sentence could name the
      // wrong person. The host label answers the question the line exists for,
      // which is which computer, since a person may have several.
      const result = res.message.result;
      const content = Array.isArray(result.content) ? result.content : [];
      return send({ ...res.message, id, result: { ...result, content: [...content, { type: "text", text: `Reached on ${r.relay.hostLabel}.` }] } });
    }
    return send({ ...res.message, id });
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
  const entry = hasId ? { id: msg.id, method: msg.method, controller: new AbortController(), destination: null, cancelled: false } : null;
  if (entry) requests.set(msg.id, entry);
  chain = chain.then(() => { if (!entry?.cancelled) return handle(msg, entry); }).catch((e) => {
    if (hasId && !entry.cancelled) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e?.message || e) } });
  }).finally(() => {
    if (entry) entry.finished = true;
    if (entry && !entry.cancelling && requests.get(msg.id) === entry) requests.delete(msg.id);
  });
});
rl.on("close", () => process.exit(0));
