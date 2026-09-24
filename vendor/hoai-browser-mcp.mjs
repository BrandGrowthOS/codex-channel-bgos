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
  host_timeout: "The owner's desktop app did not answer the browser call within 50 seconds. Say so and retry once; if it happens again, tell the owner their Home of Agents app looks stuck.",
  rate_limited: "Too many browser calls in flight for this agent. Wait for the previous call to finish, then retry.",
  browser_disabled: "The owner switched the Agent Browser off for this agent. Ask them before trying again.",
  payload_too_large: "That browser call was too large for the relay (the limit is 256 KB). Send less at once.",
  call_lost: "The relay lost track of that browser call (the result was not collected in time). Retry it once.",
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

function offlineText() {
  return RELAY ? OFFLINE_TEXT_RELAY : OFFLINE_TEXT_LOCAL;
}

function setMode(next) {
  if (next === mode) return;
  mode = next;
  write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
}

// ─── Local door (the loopback endpoint on this machine) ──────────────────────

async function post(body, { url, token, sessionId }) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
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

async function relayFetch(method, pathname, body) {
  const headers = { Accept: "application/json", ...RELAY.headers };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(RELAY.backendUrl + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {}
  }
  return { status: res.status, payload };
}

function relayErrorCode(status, payload) {
  const code = payload && (payload.code || payload.error);
  if (typeof code === "string" && RELAY_ERROR_TEXT[code]) return code;
  if (status === 409) return "host_offline";
  if (status === 504) return "host_timeout";
  if (status === 429) return "rate_limited";
  if (status === 403) return "browser_disabled";
  if (status === 413) return "payload_too_large";
  if (status === 404) return "call_lost";
  return "relay_error";
}

function relayErrorText(code, status, payload) {
  if (RELAY_ERROR_TEXT[code]) return RELAY_ERROR_TEXT[code];
  const detail = payload && typeof payload.message === "string" ? payload.message : "";
  return `The HOAI relay answered ${status}${detail ? `: ${detail}` : ""}. Retry once; if it persists, tell the owner.`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send one MCP message through the relay. Resolves { ok: true, message } with
 * the JSON-RPC response (an empty object for a notification), or
 * { ok: false, code, text, transport? } where transport marks a network
 * failure (the relay itself is unreachable) as opposed to an honest answer.
 */
async function relaySend(message) {
  const body = { clientId: CLIENT_ID, message, waitMs: RELAY_WAIT_MS };
  if (RELAY.assistantId) body.assistantId = RELAY.assistantId;
  const startedAt = Date.now();
  let r;
  try {
    r = await relayFetch("POST", RELAY_MCP_PATH, body);
  } catch (e) {
    return { ok: false, code: "relay_unreachable", transport: true, text: `The HOAI relay is unreachable (${String(e?.message || e)}). Retry in a moment.` };
  }
  if (r.status === 404) return { ok: false, code: "relay_unsupported", text: "This HOAI backend does not have the browser relay yet. Tell the owner to update Home of Agents." };
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
      await sleep(Math.max(250, Number(r.payload.pollAfterMs) || 2000));
      try {
        r = await relayFetch("GET", `${RELAY_MCP_PATH}/${encodeURIComponent(r.payload.rpcId)}`);
      } catch (e) {
        return { ok: false, code: "relay_unreachable", transport: true, text: `The HOAI relay is unreachable (${String(e?.message || e)}). Retry in a moment.` };
      }
      continue;
    }
    const code = relayErrorCode(r.status, r.payload);
    return { ok: false, code, text: relayErrorText(code, r.status, r.payload) };
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
    if (r.status !== 200 || !r.payload) return null;
    return { online: !!r.payload.online, hostLabel: r.payload.hostLabel || null };
  } catch {
    return null;
  }
}

async function ensureRelay() {
  if (relay && relay.initialized) return relay;
  const host = await relayHostOnline();
  if (!host || !host.online) return null;
  const init = await relaySend({ jsonrpc: "2.0", id: `shim-init-${++initSeq}`, method: "initialize", params: initializeParams() });
  if (!init.ok || !init.message || init.message.error) return null;
  await relaySend({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
  relay = { initialized: true, instructions: init.message.result?.instructions || "", hostLabel: host.hostLabel };
  return relay;
}

function dropRelay(code) {
  // An honest host_offline (or a dead relay) means the session on the desktop
  // is gone; the next call re-elects through a fresh initialize.
  if (code === "host_offline" || code === "relay_unreachable" || code === "relay_unsupported" || code === "call_lost") relay = null;
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
  if (RELAY) {
    const r = await ensureRelay();
    if (r) {
      setMode("relay");
      return { mode: "relay", relay: r };
    }
  }
  relay = null;
  setMode("offline");
  return { mode: "offline" };
}

// While a host is missing, look for it so the tools appear without a request.
const probe = setInterval(() => {
  if (mode !== "offline" || !clientInfo) return;
  if (!RELAY && !readDiscovery()) return;
  resolveMode().catch(() => {});
}, RELAY_PROBE_MS);
probe.unref();

// ─── The stdio side ──────────────────────────────────────────────────────────

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => write({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });
  if (method === "initialize") {
    clientInfo = params?.clientInfo || null;
    clientProtocol = params?.protocolVersion || PROTOCOL_VERSION;
    const r = await resolveMode();
    const instructions = r.mode === "local" ? r.up.instructions : r.mode === "relay" ? r.relay.instructions : "";
    return reply({
      protocolVersion: clientProtocol,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "hoai-agent-browser", version: "shim-2" },
      instructions: instructions || "HOAI Agent Browser: your default browser once the Home of Agents desktop app is reachable. " + offlineText(),
    });
  }
  if (method && method.startsWith("notifications/")) return; // no reply to notifications
  if (method === "ping") return reply({});
  if (method === "tools/list") {
    const r = await resolveMode();
    if (r.mode === "offline") return reply({ tools: [OFFLINE_TOOL] });
    if (r.mode === "local") {
      const res = await post({ jsonrpc: "2.0", id, method, params: params || {} }, r.up).catch(() => null);
      if (!res?.payload) {
        upstream = null;
        return reply({ tools: [OFFLINE_TOOL] });
      }
      return write({ ...res.payload, id });
    }
    const res = await relaySend({ jsonrpc: "2.0", id, method, params: params || {} });
    if (!res.ok || !res.message || !res.message.result) {
      dropRelay(res.code);
      if (!relay) setMode("offline");
      return reply({ tools: [OFFLINE_TOOL] });
    }
    return write({ ...res.message, id });
  }
  if (method === "tools/call") {
    const r = await resolveMode();
    if (r.mode === "offline") return reply({ content: [{ type: "text", text: offlineText() }], isError: params?.name !== "hoai_browser_status" });
    if (r.mode === "local") {
      const res = await post({ jsonrpc: "2.0", id, method, params }, r.up).catch(() => null);
      if (!res?.payload) {
        upstream = null;
        return reply({ content: [{ type: "text", text: "The HOAI Agent Browser stopped answering (the desktop app may have quit). " + offlineText() }], isError: true });
      }
      return write({ ...res.payload, id });
    }
    const res = await relaySend({ jsonrpc: "2.0", id, method, params });
    if (!res.ok) {
      dropRelay(res.code);
      if (!relay) setMode("offline");
      return reply({ content: [{ type: "text", text: res.text }], isError: params?.name !== "hoai_browser_status" || res.code !== "host_offline" });
    }
    if (params?.name === "hoai_browser_status" && res.message?.result && !res.message.result.isError && r.relay.hostLabel) {
      // Say where the browser is: the owner may have more than one computer.
      const result = res.message.result;
      const content = Array.isArray(result.content) ? result.content : [];
      return write({ ...res.message, id, result: { ...result, content: [...content, { type: "text", text: `Reached through your owner's account on ${r.relay.hostLabel}.` }] } });
    }
    return write({ ...res.message, id });
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
  chain = chain.then(() => handle(msg)).catch((e) => {
    if (msg.id !== undefined) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e?.message || e) } });
  });
});
rl.on("close", () => process.exit(0));
