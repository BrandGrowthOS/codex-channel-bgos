import { EventEmitter } from "node:events";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserContext, browserActorFromDelivery } from "../src/browser-context.js";
import { CodexHost } from "../src/codex-host.js";
import { BgosWs } from "../src/bgos-ws.js";
import { bundledShimPath } from "../src/browser-mcp.js";

const relay = { backendUrl: "http://127.0.0.1:1", pairingToken: "synthetic-context-secret", assistantId: 42, ownerUserId: "user_owner" };
const envKey = "mcp_servers.hoai_browser.env";
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
class Server extends EventEmitter {
  onRequest: any;
  next = 0;
  configs = new Map<string, any>();
  discoveries: any[] = [];
  starts: Array<{ thread: string; context: any }> = [];
  /** Threads whose MCP processes are running. Like Codex, a resume of one ignores the new config. */
  loaded = new Set<string>();
  start = vi.fn(async () => {});
  close = vi.fn(() => { this.loaded.clear(); this.emit("closed", new Error("closed")); });
  request = vi.fn(async (method: string, p: any) => {
    if (method === "thread/unsubscribe") { this.loaded.delete(p.threadId); return {}; }
    if (["thread/start", "thread/resume", "thread/fork"].includes(method)) {
      const id = method === "thread/resume" ? p.threadId : `thread-${++this.next}`;
      if (this.loaded.has(id)) return { thread: { id } };
      this.loaded.add(id);
      this.configs.set(id, p.config);
      this.discoveries.push(json(p.config[envKey].HOAI_RELAY_CONTEXT_FILE).context);
      return { thread: { id } };
    }
    if (method === "turn/start") {
      this.starts.push({ thread: p.threadId, context: json(this.configs.get(p.threadId)[envKey].HOAI_RELAY_CONTEXT_FILE) });
      return { turn: { id: `turn-${this.starts.length}` } };
    }
    if (method === "thread/read") return { thread: { id: p.threadId } };
    return {};
  });
  finish(id: string) { this.emit("notification", "turn/completed", { threadId: id, turn: { status: "completed" } }); }
}

describe("authenticated browser actors", () => {
  it("uses explicit human sender and reserved scheduler actor, never envelope owner or text", () => {
    expect(browserActorFromDelivery({ senderType: "user", sender_user_id: "user_recipient", userId: "user_owner" })).toBe("user_recipient");
    expect(browserActorFromDelivery({ senderType: "user", sender: { userId: "user_owner" } })).toBe("user_owner");
    expect(browserActorFromDelivery({ senderType: "system", eventMeta: { source: "scheduler", payload: { actingUserId: "user_recipient" } } })).toBe("user_recipient");
    for (const raw of [
      { senderType: "user", userId: "user_owner" },
      { senderType: "user", sender_user_id: "", userId: "user_owner" },
      { senderType: "agent", sender_user_id: "user_owner" },
      { senderType: "user", sender_user_id: "user_owner", peerConversationId: 5 },
      { senderType: "user", sender_user_id: "user_owner", chat_kind: "group" },
      { senderType: "user", sender_user_id: "user_owner", chatKind: "meeting" },
      { senderType: "system", sender_user_id: "user_owner" },
      { senderType: "system", eventMeta: { source: "agent", payload: { actingUserId: "user_owner" } } },
    ]) expect(browserActorFromDelivery(raw)).toBeNull();
  });
  it("admits an ordinary human delivery exactly as the BGOS backend sends it (no senderType)", () => {
    // WS lane: send-message.service.ts:3513-3541 emits `sender` from buildInboundSender
    // (sender-identity.ts:48 buildSenderBlock) and spreads senderType only when isSystemMsg.
    const ws = Object.create(BgosWs.prototype) as any;
    const live = {
      assistantId: 42, userId: "user_recipient", chatId: 9, messageId: 7, text: "open example.com", files: [],
      messageType: "standard", sender: { userId: "user_recipient", displayName: "Recipient A", relationship: "shared_recipient" },
      isSharedRecipient: true, shareOwnerUserId: "user_owner", sessionHandle: "h",
    };
    expect(browserActorFromDelivery(live)).toBe("user_recipient");
    expect(ws.normalizeInbound(live).browserActor).toBe("user_recipient");
    // Poll lane: integrations.controller.ts:1449-1461 sets senderType only for a2a or system rows,
    // and :1500-1503 carries the stored human author as sender_user_id. user_id is the owner.
    const polled = {
      id: 8, message_id: 8, chat_id: 9, text: "schedule a reminder", chat_kind: "main", message_type: "standard",
      assistant_id: 42, user_id: "user_owner", sender_user_id: "user_recipient", sender_display_name: "Recipient A",
      sender_relationship: "shared_recipient",
    };
    expect(browserActorFromDelivery(polled)).toBe("user_recipient");
    expect(ws.normalizeInbound(polled).browserActor).toBe("user_recipient");
    // A human delivery without an author block never falls back to the envelope owner.
    expect(browserActorFromDelivery({ ...polled, sender_user_id: undefined })).toBeNull();
    // Agent and peer deliveries stay refused even with a stale human block.
    expect(browserActorFromDelivery({ ...live, senderType: "agent", agentOrigin: { peerConversationId: 3 } })).toBeNull();
    expect(browserActorFromDelivery({ ...polled, agentOrigin: { peerConversationId: 3 }, peerConversationId: 3 })).toBeNull();
    expect(browserActorFromDelivery({ ...polled, senderType: "system" })).toBeNull();
  });
  it("normalizes live and backfilled metadata without inheriting the owner fallback", () => {
    const ws = Object.create(BgosWs.prototype) as any;
    const base = { assistantId: 42, chatId: 9, messageId: 1, userId: "user_owner", senderType: "user" };
    expect(ws.normalizeInbound({ ...base, sender_user_id: "user_recipient" }).browserActor).toBe("user_recipient");
    expect(ws.normalizeInbound(base).browserActor).toBeNull();
    expect(ws.normalizeInbound({ ...base, senderType: "system", eventMeta: { source: "scheduler", payload: { actingUserId: "user_recipient" } } }).browserActor).toBe("user_recipient");
  });
});

describe("managed browser context lifecycle", () => {
  let home: string, server: Server, host: CodexHost;
  const contexts: BrowserContext[] = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "codex-private-browser-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
    vi.stubEnv("HOAI_HOME", home);
    server = new Server();
    host = new CodexHost({ auth: { ok: true, mode: "chatgpt", label: "fixture" }, workdir: home, server: server as any, relay: () => relay,
      onAdoptedTurn: () => ({ callbacks: {}, deliver: async () => {} }) });
  });
  afterEach(() => { host.close(); for (const scope of contexts.splice(0)) scope.end(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
  const state = (id: string) => json(server.configs.get(id)[envKey].HOAI_RELAY_CONTEXT_FILE).context;
  /** Revoked: the scope says not live, or its files are gone, which the shim also refuses. */
  const revoked = (id: string) => {
    const file = server.configs.get(id)[envKey].HOAI_RELAY_CONTEXT_FILE;
    return !existsSync(file) || json(file).context.live === false;
  };
  async function waitStarts(n: number) { await vi.waitFor(() => expect(server.starts).toHaveLength(n)); }
  async function finish(id: string, run: Promise<unknown>) {
    server.finish(id);
    expect(state(id).live).toBe(false);
    await run;
  }

  it("signs exact identities, refreshes freshness and invalidates on end without stale cleanup revoking the next turn", () => {
    vi.useFakeTimers();
    const scope = new BrowserContext(home, 9, relay); contexts.push(scope);
    expect(json(scope.env.HOAI_RELAY_CONTEXT_FILE).context.live).toBe(false);
    const oldEnd = scope.begin("user_owner", "first");
    const first = json(scope.env.HOAI_RELAY_CONTEXT_FILE);
    expect(first.signature).toBe(createHmac("sha256", relay.pairingToken).update(JSON.stringify(first.context)).digest("hex"));
    expect(first.context).toMatchObject({ actingUserId: "user_owner", ownerUserId: "user_owner", chatId: "9", assistantId: "42", claudePid: process.pid, pid: process.pid, live: true });
    vi.advanceTimersByTime(20_000);
    expect(json(scope.env.HOAI_RELAY_CONTEXT_FILE).context.updatedAt).toBeGreaterThan(first.context.updatedAt);
    const end = scope.begin("user_recipient", "next"); oldEnd();
    expect(json(scope.env.HOAI_RELAY_CONTEXT_FILE).context.actingUserId).toBe("user_recipient");
    end(); expect(json(scope.env.HOAI_RELAY_CONTEXT_FILE).context.live).toBe(false);
    expect(json(first.context.markerPath).live).toBe(false);
  });

  it("publishes before model work, isolates two actors, ends immediately and ignores an older installed shim", async () => {
    mkdirSync(join(home, ".hoai", "bin"), { recursive: true });
    writeFileSync(join(home, ".hoai", "bin", "hoai-browser-mcp.mjs"), "throw Error('old shim');");
    const one = host.runTurn(9, "owner", { browserActor: "user_owner" }); await waitStarts(1);
    expect(server.starts[0].context.context.actingUserId).toBe("user_owner");
    expect(server.discoveries[0].actingUserId).toBe("user_owner");
    expect(server.configs.get("thread-1")["mcp_servers.hoai_browser.args"]).toEqual([bundledShimPath()]);
    expect(server.configs.get("thread-1")[envKey].HOAI_RELAY_PROFILE_SYNC).toBe("1");
    await finish("thread-1", one); expect(state("thread-1").live).toBe(false);
    const two = host.runTurn(9, "recipient", { browserActor: "user_recipient" }); await waitStarts(2);
    expect(state("thread-1").actingUserId).toBe("user_recipient");
    await finish("thread-1", two);
    const unknown = host.runTurn(9, "unknown"); await waitStarts(3);
    expect(state("thread-1").live).toBe(false); await finish("thread-1", unknown);
  });

  it("goal continuations inherit only the last verified actor in this process and stop clears it", async () => {
    const run = host.runTurn(9, "recipient goal", { browserActor: "user_recipient" }); await waitStarts(1); await finish("thread-1", run);
    server.emit("notification", "turn/started", { threadId: "thread-1", turn: { id: "goal-2" } });
    expect(state("thread-1").actingUserId).toBe("user_recipient");
    await host.stopTurn(9); expect(state("thread-1").live).toBe(false);
    server.finish("thread-1"); await vi.waitFor(() => expect((host as any).active.size).toBe(0));
    server.emit("notification", "turn/started", { threadId: "thread-1", turn: { id: "goal-3" } });
    expect(state("thread-1").live).toBe(false);
  });

  it("resume after restart has a fresh denied context until a new attributed turn", async () => {
    const run = host.runTurn(9, "owner", { browserActor: "user_owner" }); await waitStarts(1); await finish("thread-1", run);
    const oldFile = server.configs.get("thread-1")[envKey].HOAI_RELAY_CONTEXT_FILE;
    host.close(); server = new Server();
    host = new CodexHost({ auth: { ok: true, mode: "chatgpt", label: "fixture" }, workdir: home, server: server as any, relay: () => relay, onAdoptedTurn: () => ({ callbacks: {}, deliver: async () => {} }) });
    await (host as any).ensureThread(9);
    expect(server.configs.get("thread-1")[envKey].HOAI_RELAY_CONTEXT_FILE).not.toBe(oldFile);
    server.emit("notification", "turn/started", { threadId: "thread-1", turn: { id: "goal-restart" } });
    expect(state("thread-1").live).toBe(false);
    expect(server.discoveries[0].live).toBe(false);
    server.finish("thread-1"); await vi.waitFor(() => expect((host as any).active.size).toBe(0));
    const next = host.runTurn(9, "recipient", { browserActor: "user_recipient" }); await waitStarts(1);
    expect(state("thread-1").actingUserId).toBe("user_recipient"); await finish("thread-1", next);
  });

  it("detached writable work has separate files and a read-only consult cannot inherit its actor", async () => {
    const main = host.runTurn(9, "owner", { browserActor: "user_owner" }); await waitStarts(1);
    const detached = host.runDetached(9, "recipient", { browserActor: "user_recipient" }, false); await waitStarts(2);
    expect(state("thread-1").actingUserId).toBe("user_owner");
    expect(state("thread-2").actingUserId).toBe("user_recipient");
    expect(server.discoveries[1].actingUserId).toBe("user_recipient");
    expect(state("thread-1").sessionId).not.toBe(state("thread-2").sessionId);
    const consult = host.runDetached(9, "invisible", { browserActor: "user_owner" }, true); await waitStarts(3);
    expect(state("thread-3").live).toBe(false);
    await finish("thread-3", consult); await finish("thread-2", detached); await finish("thread-1", main);
  });

  it("explicit fork and saved resume replace the scope instead of inheriting live owner authority", async () => {
    const run = host.runTurn(9, "owner", { browserActor: "user_owner" }); await waitStarts(1); await finish("thread-1", run);
    const fork = await host.forkThread(9);
    expect(server.configs.get(fork)[envKey].HOAI_RELAY_PROFILE_SYNC).toBe("1");
    expect(state(fork).live).toBe(false);
    expect(server.configs.get(fork)[envKey].HOAI_RELAY_CONTEXT_FILE).not.toBe(server.configs.get("thread-1")[envKey].HOAI_RELAY_CONTEXT_FILE);
    await host.resumeSavedThread(9, "thread-1");
    expect(state("thread-1").live).toBe(false);
    const next = host.runTurn(9, "recipient", { browserActor: "user_recipient" }); await waitStarts(2);
    expect(state("thread-1").actingUserId).toBe("user_recipient"); await finish("thread-1", next);
  });

  it("resuming the current conversation keeps the scope its running MCP process reads", async () => {
    const run = host.runTurn(9, "owner", { browserActor: "user_owner" }); await waitStarts(1); await finish("thread-1", run);
    await host.resumeSavedThread(9, "thread-1");
    expect(state("thread-1").live).toBe(false);
    const next = host.runTurn(9, "recipient", { browserActor: "user_recipient" }); await waitStarts(2);
    expect(server.starts[1].context.context).toMatchObject({ live: true, actingUserId: "user_recipient" });
    await finish("thread-1", next);
  });

  it("/new then resuming the previous conversation reuses the scope of its still loaded MCP process", async () => {
    const run = host.runTurn(9, "owner", { browserActor: "user_owner" }); await waitStarts(1); await finish("thread-1", run);
    host.resetChat(9); expect(state("thread-1").live).toBe(false);
    await host.resumeSavedThread(9, "thread-1");
    const next = host.runTurn(9, "recipient", { browserActor: "user_recipient" }); await waitStarts(2);
    expect(server.starts[1].thread).toBe("thread-1");
    expect(server.starts[1].context.context).toMatchObject({ live: true, actingUserId: "user_recipient" });
    await finish("thread-1", next);
  });

  it("removes each detached scope's directory when it ends and every scope on close", async () => {
    const root = () => dirname(dirname(server.configs.get("thread-1")[envKey].HOAI_RELAY_CONTEXT_FILE));
    const main = host.runTurn(9, "owner", { browserActor: "user_owner" }); await waitStarts(1); await finish("thread-1", main);
    for (let i = 0; i < 5; i += 1) {
      const consult = host.runDetached(9, "consult", {}, true); await waitStarts(2 + i);
      await finish(`thread-${2 + i}`, consult);
    }
    expect(readdirSync(root())).toHaveLength(1);
    const kept = root();
    host.close();
    expect(readdirSync(kept)).toHaveLength(0);
  });

  it("sweeps scope directories left by a dead daemon at startup and keeps live ones", () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    const root = join(home, "browser-context");
    for (const name of [`${dead}-stale`, `${process.pid}-mine`, `${process.ppid}-other`]) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "context.json"), "{}");
    }
    host.close();
    host = new CodexHost({ auth: { ok: true, mode: "chatgpt", label: "fixture" }, workdir: home, server: server as any, relay: () => relay, onAdoptedTurn: () => ({ callbacks: {}, deliver: async () => {} }) });
    expect(existsSync(join(root, `${dead}-stale`))).toBe(false);
    expect(existsSync(join(root, `${process.pid}-mine`))).toBe(true);
    expect(existsSync(join(root, `${process.ppid}-other`))).toBe(true);
  });

  it("abort, reset and daemon close invalidate active authority", async () => {
    const controller = new AbortController();
    const run = host.runTurn(9, "owner", { browserActor: "user_owner", signal: controller.signal }); await waitStarts(1);
    controller.abort(); expect(state("thread-1").live).toBe(false); await finish("thread-1", run);
    const again = host.runTurn(9, "owner", { browserActor: "user_owner" }); await waitStarts(2);
    host.resetChat(9); expect(state("thread-1").live).toBe(false); await finish("thread-1", again);
    const last = host.runTurn(9, "owner", { browserActor: "user_owner" }); await waitStarts(3);
    host.close(); await last; expect(revoked("thread-2")).toBe(true);
  });

  it("a failed thread startup revokes the context published for MCP discovery", async () => {
    const request = server.request.getMockImplementation()!;
    server.request.mockImplementation(async (method, params) => {
      const result = await request(method, params);
      if (method === "thread/start") throw new Error("synthetic startup failure");
      return result;
    });
    await expect(host.runTurn(9, "owner", { browserActor: "user_owner" })).rejects.toThrow("synthetic startup failure");
    expect(server.discoveries[0].actingUserId).toBe("user_owner");
    expect(revoked("thread-1")).toBe(true);
  });

  it("abort during thread startup revokes discovery authority before a goal can inherit it", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const request = server.request.getMockImplementation()!;
    server.request.mockImplementation(async (method, params) => {
      const result = await request(method, params);
      if (method === "thread/start") await held;
      return result;
    });
    const controller = new AbortController();
    const run = host.runTurn(9, "owner", { browserActor: "user_owner", signal: controller.signal });
    const rejected = expect(run).rejects.toThrow();
    await vi.waitFor(() => expect(server.discoveries).toHaveLength(1));
    controller.abort();
    expect(state("thread-1").live).toBe(false);
    release(); await rejected;
    expect(state("thread-1").live).toBe(false);
    server.emit("notification", "turn/started", { threadId: "thread-1", turn: { id: "after-abort" } });
    expect(state("thread-1").live).toBe(false);
  });

  it("a malformed startup response revokes the exact discovery scope", async () => {
    const request = server.request.getMockImplementation()!;
    server.request.mockImplementation(async (method, params) => {
      const result = await request(method, params);
      return method === "thread/start" ? { thread: {} } : result;
    });
    await expect(host.runTurn(9, "owner", { browserActor: "user_owner" })).rejects.toThrow("conversation identity");
    expect(revoked("thread-1")).toBe(true);
  });

  it("routes real bundled-shim calls through the publisher's admitted actor and refuses missing identity", async () => {
    const seen: Array<{ actor: string | null; client: string }> = [];
    const backend = createServer(async (req, res) => {
      let text = ""; for await (const part of req) text += part;
      const body = text ? JSON.parse(text) : {};
      res.setHeader("Content-Type", "application/json");
      if (req.url?.includes("/browser/host")) return void res.end(JSON.stringify({ online: true }));
      seen.push({ actor: req.headers["x-bgos-acting-user"] as string || null, client: body.clientId });
      const result = body.message.method === "initialize" ? { capabilities: {} } : { content: [{ type: "text", text: "synthetic-page" }] };
      res.end(JSON.stringify({ status: "done", message: { jsonrpc: "2.0", id: body.message.id, result } }));
    });
    await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
    const address = backend.address() as { port: number };
    const scope = new BrowserContext(home, 9, { ...relay, backendUrl: `http://127.0.0.1:${address.port}` }); contexts.push(scope);
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [bundledShimPath()], { env: {
      ...process.env, HOAI_RELAY_BACKEND_URL: `http://127.0.0.1:${address.port}`, HOAI_RELAY_PAIRING_TOKEN: relay.pairingToken,
      HOAI_RELAY_ASSISTANT_ID: String(relay.assistantId), ...scope.env,
    } });
    let buffer = "", next = 0;
    const replies = new Map<number, (reply: any) => void>();
    child.stdout.on("data", chunk => { buffer += chunk; let newline; while ((newline = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); try { const reply = JSON.parse(line); replies.get(reply.id)?.(reply); replies.delete(reply.id); } catch {} } });
    const call = () => new Promise<any>((resolve, reject) => { const id = ++next; const timeout = setTimeout(() => reject(new Error("shim timed out")), 3000); replies.set(id, value => { clearTimeout(timeout); resolve(value); }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } }) + "\n"); });
    try {
      scope.begin("user_owner", "owner"); expect((await call()).result.content[0].text).toBe("synthetic-page");
      const owner = seen.at(-1)!; expect(owner.actor).toBeNull();
      scope.begin("user_recipient", "recipient"); expect((await call()).result.content[0].text).toBe("synthetic-page");
      const recipient = seen.at(-1)!; expect(recipient.actor).toBe("user_recipient"); expect(recipient.client).not.toBe(owner.client);
      const count = seen.length; scope.begin(null, "unattributed");
      expect((await call()).result.isError).toBe(true); expect(seen).toHaveLength(count);
      scope.begin("user_owner", "owner again"); scope.dispose();
      expect(existsSync(scope.env.HOAI_RELAY_CONTEXT_FILE)).toBe(false);
      expect((await call()).result.isError).toBe(true); expect(seen).toHaveLength(count);
    } finally { child.kill(); await new Promise<void>(resolve => child.once("close", () => resolve())); await new Promise<void>(resolve => backend.close(() => resolve())); }
  });
});
