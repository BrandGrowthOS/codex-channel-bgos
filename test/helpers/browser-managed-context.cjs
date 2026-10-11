"use strict";
// Real stdio shim and disposable HTTP endpoints. No account or live browser.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const SHIM = process.env.HOAI_SHIM_TEST_PATH || path.join(__dirname, "../shim/hoai-browser-mcp.mjs");
const SECRET = "managed-context-fixture-pairing";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 250; i++) { if (check()) return; await wait(10); } assert.fail("Fixture did not settle"); }

async function rig(t, { managed = true, credential = "pairing", env: overrides = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoai-managed-context-"));
  const contextFile = path.join(home, "context.json"), markerFile = path.join(home, "marker.json");
  const seen = [], pending = new Map();
  const state = { collectDone: false, holdInitialize: false, local: 0 };
  const server = http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const frame = { method: req.method, url: req.url, actor: req.headers["x-bgos-acting-user"] || null, body };
    seen.push(frame);
    const answer = value => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    const msg = body?.message;
    if (req.url === "/local") {
      state.local++; const local = body;
      return answer(local.id === undefined ? {} : { jsonrpc: "2.0", id: local.id, result: local.method === "initialize" ? { instructions: "Local fixture" } : { tools: [{ name: "local_fixture" }] } });
    }
    if (req.url.startsWith("/api/v1/integrations/browser/host")) return answer({ online: true, hostLabel: "Synthetic host" });
    if (req.method === "GET") {
      const rpcId = req.url.split("/").pop();
      return answer(state.collectDone ? { status: "done", message: pending.get(rpcId) } : { status: "pending", rpcId, pollAfterMs: 250 });
    }
    const result = msg?.method === "initialize" ? { instructions: "Relay fixture" } : msg?.method === "tools/list" ? { tools: [{ name: "browser_snapshot" }] } : { content: [{ type: "text", text: "Synthetic result" }] };
    const message = { jsonrpc: "2.0", id: msg?.id, result };
    if (msg?.method === "initialize" && state.holdInitialize || msg?.method === "tools/call" && msg.params.name === "held") {
      const rpcId = "pending-" + String(msg.id); pending.set(rpcId, message);
      return answer({ status: "pending", rpcId, pollAfterMs: 250 });
    }
    return answer({ status: "done", message });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(path.join(home, ".hoai"));
  fs.writeFileSync(path.join(home, ".hoai/agent-browser.json"), JSON.stringify({ url: url + "/local", token: "fixture-local-token" }));
  function publish(patch = {}, markerPatch = {}, { sign = true } = {}) {
    const context = { schemaVersion: 1, assistantId: "42", ownerUserId: "user_owner", actingUserId: "user_recipient_a", chatId: "11", turnId: "turn-a", sessionId: "claude-session", claudePid: process.pid, pid: process.pid, updatedAt: Date.now(), live: true, markerPath: markerFile, promptHash: "a".repeat(64), ...patch };
    const marker = { schemaVersion: 1, turnId: context.turnId, sessionId: context.sessionId, promptHash: context.promptHash, live: true, ...markerPatch };
    fs.writeFileSync(markerFile, JSON.stringify(marker));
    fs.writeFileSync(contextFile, JSON.stringify({ context, signature: sign ? crypto.createHmac("sha256", SECRET).update(JSON.stringify(context)).digest("hex") : "0".repeat(64) }));
    return context;
  }
  publish();
  const env = { ...process.env, HOAI_HOME: home, HOAI_RELAY_BACKEND_URL: url, HOAI_RELAY_ASSISTANT_ID: "42", HOAI_RELAY_PAIRING_TOKEN: credential === "pairing" ? SECRET : "", HOAI_RELAY_API_KEY: credential === "api" ? SECRET : "", HOAI_RELAY_PROBE_MS: "600000" };
  delete env.HOAI_RELAY_CONTEXT_FILE; delete env.HOAI_RELAY_OWNER_USER_ID; delete env.HOAI_RELAY_CLIENT_PID;
  if (managed) Object.assign(env, { HOAI_RELAY_CONTEXT_FILE: contextFile, HOAI_RELAY_OWNER_USER_ID: "user_owner", HOAI_RELAY_CLIENT_PID: String(process.pid) });
  Object.assign(env, overrides);
  const child = spawn(process.execPath, [SHIM], { env, stdio: ["pipe", "pipe", "pipe"] });
  const responses = []; let buffer = "", stderr = "", nextId = 1;
  child.stdout.on("data", data => { buffer += data; const lines = buffer.split("\n"); buffer = lines.pop(); for (const line of lines.filter(Boolean)) responses.push(JSON.parse(line)); });
  child.stderr.on("data", data => { stderr += data; });
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const response = async id => { await until(() => responses.some(row => row.id === id)); return responses.find(row => row.id === id); };
  const request = async (method = "tools/call", params = { name: "browser_snapshot", arguments: {} }) => { const id = nextId++; send({ id, method, params }); return response(id); };
  t.after(async () => { if (child.exitCode === null) { const exit = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exit; } server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { seen, state, send, response, request, publish, contextFile, markerFile, responses, stderr: () => stderr };
}

for (const credential of ["pairing", "api"]) test(`managed ${credential} contexts force relay and partition personal clients by actor, chat and session`, async t => {
  const r = await rig(t, { credential });
  assert.equal((await r.request()).result.isError, undefined);
  assert.equal(r.state.local, 0);
  const first = r.seen.filter(row => row.body?.message);
  assert.ok(first.length >= 3);
  assert.ok(r.seen.every(row => row.actor === "user_recipient_a"));
  const a = first[0].body.clientId;
  assert.ok(first.every(row => row.body.clientId === a && row.body.assistantId === "42"));
  assert.ok(first.every(row => !Object.hasOwn(row.body, "roomChatId") && !Object.hasOwn(row.body, "chatId")));
  r.publish({ actingUserId: "user_recipient_b" }); await r.request();
  const b = r.seen.filter(row => row.body?.message).at(-1).body.clientId; assert.notEqual(b, a);
  r.publish({ actingUserId: "user_owner" }); await r.request();
  assert.equal(r.seen.at(-1).actor, null);
  r.publish({ turnId: "turn-next" }); await r.request();
  assert.equal(r.seen.at(-1).body.clientId, a, "same actor/chat/session can reuse its initialized client across turns");
  r.publish({ chatId: "22" }); await r.request(); assert.notEqual(r.seen.at(-1).body.clientId, a);
  r.publish({ sessionId: "new-session" }); await r.request(); assert.notEqual(r.seen.at(-1).body.clientId, a);
  assert.equal(r.state.local, 0);
});

test("a missing, invalid or stale managed claim never inherits an owner or falls back to local", async t => {
  const r = await rig(t);
  const cases = [
    [{}, {}, { sign: false }], [{ assistantId: "99" }], [{ ownerUserId: "user_other" }], [{ actingUserId: "" }],
    [{ live: false }], [{ pid: 0 }], [{ pid: 2147483647 }], [{ claudePid: process.pid + 1 }],
    [{ updatedAt: Date.now() - 61000 }], [{ updatedAt: Date.now() + 10000 }], [{ updatedAt: "now" }],
    [{ chatId: "" }], [{ turnId: "" }], [{ sessionId: "" }], [{}, { live: false }], [{}, { turnId: "new-prompt" }],
    [{}, { sessionId: "different-session" }], [{}, { promptHash: "b".repeat(64) }],
  ];
  for (const values of cases) {
    r.publish(...values); const result = await r.request();
    assert.equal(result.result.isError, true); assert.match(result.result.content[0].text, /current sender could not be verified/);
    assert.equal(r.seen.length, 0, JSON.stringify(values));
  }
  for (const [file, size] of [[r.contextFile, 8193], [r.markerFile, 2049]]) {
    r.publish(); fs.writeFileSync(file, " ".repeat(size)); assert.equal((await r.request()).result.isError, true); assert.equal(r.seen.length, 0);
  }
  r.publish(); fs.unlinkSync(r.contextFile); assert.equal((await r.request()).result.isError, true); assert.equal(r.seen.length, 0);
  assert.equal(r.stderr(), "");
});

test("an empty managed file env refuses while absent env preserves the standalone local door", async t => {
  const empty = await rig(t, { env: { HOAI_RELAY_CONTEXT_FILE: "" } });
  assert.equal((await empty.request()).result.isError, true); assert.equal(empty.seen.length, 0);
  const standalone = await rig(t, { managed: false });
  await standalone.request("tools/list", {});
  assert.ok(standalone.state.local >= 2); assert.ok(standalone.seen.every(row => row.url === "/local" && row.actor === null));
});

test("a changed prompt marker blocks new work until a matching signed turn is published", async t => {
  const r = await rig(t); await r.request(); const count = r.seen.length;
  fs.writeFileSync(r.markerFile, JSON.stringify({ schemaVersion: 1, turnId: "unattributed-system-wake", sessionId: "claude-session", promptHash: "b".repeat(64), live: true }));
  assert.equal((await r.request()).result.isError, true); assert.equal(r.seen.length, count);
  r.publish({ live: false, actingUserId: null }); assert.equal((await r.request()).result.isError, true); assert.equal(r.seen.length, count);
  r.publish({ actingUserId: "user_recipient_b", turnId: "scheduled-delivery", promptHash: "b".repeat(64) });
  assert.equal((await r.request()).result.isError, undefined); assert.equal(r.seen.at(-1).actor, "user_recipient_b");
});

test("initialize, original request and polling retain the context admitted before a turn changes", async t => {
  const r = await rig(t); r.state.holdInitialize = true;
  r.send({ id: "frozen", method: "tools/call", params: { name: "browser_snapshot", arguments: {} } });
  await until(() => r.seen.some(row => row.body?.message?.method === "initialize"));
  r.publish({ actingUserId: "user_recipient_b" }); r.state.collectDone = true;
  assert.equal((await r.response("frozen")).result.isError, undefined);
  assert.ok(r.seen.every(row => row.actor === "user_recipient_a"));
  assert.equal(new Set(r.seen.filter(row => row.body?.message).map(row => row.body.clientId)).size, 1);
  r.state.holdInitialize = false; await r.request(); assert.equal(r.seen.at(-1).actor, "user_recipient_b");
});

test("pending collection and late cancellation retain the original actor and client without replay", async t => {
  const r = await rig(t);
  r.send({ id: "held-a", method: "tools/call", params: { name: "held", arguments: {} } });
  await until(() => r.seen.some(row => row.body?.message?.id === "held-a"));
  const original = r.seen.find(row => row.body?.message?.id === "held-a");
  r.publish({ actingUserId: "user_recipient_b" });
  await until(() => r.seen.some(row => row.method === "GET" && row.url.includes("/mcp/")));
  const polls = r.seen.filter(row => row.method === "GET" && row.url.includes("/mcp/"));
  assert.ok(polls.every(row => row.actor === "user_recipient_a"));
  r.send({ method: "notifications/cancelled", params: { requestId: "held-a" } });
  await until(() => r.seen.some(row => row.body?.message?.method === "notifications/cancelled"));
  const cancellation = r.seen.find(row => row.body?.message?.method === "notifications/cancelled");
  assert.equal(cancellation.actor, "user_recipient_a"); assert.equal(cancellation.body.clientId, original.body.clientId);
  await r.request(); assert.equal(r.seen.at(-1).actor, "user_recipient_b");
  assert.equal(r.seen.filter(row => row.body?.message?.id === "held-a").length, 1);
  assert.equal(r.responses.some(row => row.id === "held-a"), false);
  assert.equal(r.stderr(), "");
});
