#!/usr/bin/env node
// HOAI Agent Browser stdio shim.
//
// Zero-dependency bridge from a stdio MCP client (Claude Code, Codex, Hermes,
// OpenClaw, Gobot: anything that can run a command MCP server) to the local
// HTTP MCP endpoint the Home of Agents desktop app serves. It reads the
// endpoint URL and bearer token from ~/.hoai/agent-browser.json on every
// request, so it works whether the app started before or after the agent.
//
// When the app is not running it still answers: initialize, and a tools/list
// with one tool, hoai_browser_status, whose answer says the desktop app is not
// running. When the app appears, the shim sends notifications/tools/list_changed
// so clients that honour it refresh the tool list.
//
// The app installs a copy at ~/.hoai/bin/hoai-browser-mcp.mjs; plugins ship
// their own copy. Source of truth: frontend/electron-app/agent-browser/shim/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const HOAI_DIR = process.env.HOAI_HOME ? path.join(process.env.HOAI_HOME, ".hoai") : path.join(os.homedir(), ".hoai");
const DISCOVERY = path.join(HOAI_DIR, "agent-browser.json");
const PROTOCOL_VERSION = "2025-06-18";
const OFFLINE_TOOL = {
  name: "hoai_browser_status",
  description: "Status of the HOAI Agent Browser (the browser pane in the Home of Agents desktop app). When the app is not running this is the only tool; it tells you so.",
  inputSchema: { type: "object", properties: {} },
  annotations: { title: "Browser session status", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};
const OFFLINE_TEXT = "The HOAI Agent Browser is not available: the Home of Agents desktop app is not running on this computer (or the agent browser endpoint is off). Ask the owner to open Home of Agents; Cmd or Ctrl+Shift+B opens the Agent Browser. The browser tools appear here as soon as it is up.";

let upstream = null; // { url, token, sessionId, initialized }
let online = false;
let clientInfo = null;
let clientProtocol = PROTOCOL_VERSION;

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

async function ensureUpstream() {
  const doc = readDiscovery();
  if (!doc) {
    if (online) {
      online = false;
      upstream = null;
      write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    return null;
  }
  if (upstream && upstream.url === doc.url && upstream.token === doc.token && upstream.initialized) return upstream;
  const candidate = { url: doc.url, token: doc.token, sessionId: null, initialized: false };
  try {
    const init = await post({ jsonrpc: "2.0", id: "shim-init", method: "initialize", params: { protocolVersion: clientProtocol, capabilities: {}, clientInfo: clientInfo || { name: "hoai-browser-shim", version: "1" } } }, candidate);
    if (!init.payload || init.payload.error) throw new Error("initialize failed");
    candidate.sessionId = init.sid;
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, candidate);
    candidate.initialized = true;
    candidate.instructions = init.payload.result?.instructions || "";
    upstream = candidate;
    if (!online) {
      online = true;
      write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    return upstream;
  } catch {
    if (online) {
      online = false;
      upstream = null;
      write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    return null;
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => write({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });
  if (method === "initialize") {
    clientInfo = params?.clientInfo || null;
    clientProtocol = params?.protocolVersion || PROTOCOL_VERSION;
    const up = await ensureUpstream();
    return reply({
      protocolVersion: clientProtocol,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "hoai-agent-browser", version: "shim-1" },
      instructions: up?.instructions || "HOAI Agent Browser: your default browser once the Home of Agents desktop app is running. " + OFFLINE_TEXT,
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled" || (method && method.startsWith("notifications/"))) return; // no reply to notifications
  if (method === "ping") return reply({});
  if (method === "tools/list") {
    const up = await ensureUpstream();
    if (!up) return reply({ tools: [OFFLINE_TOOL] });
    const r = await post({ jsonrpc: "2.0", id, method, params: params || {} }, up).catch(() => null);
    if (!r?.payload) {
      upstream = null;
      return reply({ tools: [OFFLINE_TOOL] });
    }
    return write({ ...r.payload, id });
  }
  if (method === "tools/call") {
    const up = await ensureUpstream();
    if (!up) return reply({ content: [{ type: "text", text: OFFLINE_TEXT }], isError: params?.name !== "hoai_browser_status" });
    const r = await post({ jsonrpc: "2.0", id, method, params }, up).catch(() => null);
    if (!r?.payload) {
      upstream = null;
      return reply({ content: [{ type: "text", text: "The HOAI Agent Browser stopped answering (the desktop app may have quit). " + OFFLINE_TEXT }], isError: true });
    }
    return write({ ...r.payload, id });
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
