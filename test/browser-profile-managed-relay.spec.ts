import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const codec = require("../vendor/browser-profile/lib/browser-profile-core/crypto.js");
type Row = Record<string, any>;

describe("the Codex managed Companion's actual MCP metadata", () => {
  it("initializes and lists managed tools through the production factory and typed Companion dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hoai-codex-managed-relay-"));
    const { createHost } = await import("../runtime/browser-profile-host.mjs");
    const { SESSION_TOOLS, WAIT_SECONDS_SCHEMA } = await import("../vendor/browser-profile/bin/hoai-browser-host.mjs");
    const loadBrowser = vi.fn(async () => { throw Error("metadata must not load a browser"); });
    const config = { backendUrl: "http://127.0.0.1:12345", pairingToken: "SYNTHETIC_PAIRING_TOKEN_0123456789", pairingId: 8,
      ownerUserId: "user_sharer", assistantIds: [42], directory, parentPid: process.pid };
    const host: any = createHost({ config, loadBrowser });
    const connection: Row = { pairing: { backendUrl: config.backendUrl, token: config.pairingToken,
      pairingId: config.pairingId, ownerUserId: config.ownerUserId, assistantIds: [42] }, bootId: randomUUID(),
      _stopped: false, socketId: "fixture-socket", socket: { connected: true } };
    const companion = host._createProfileCompanion(connection, host);
    const endpoint = codec.createEndpointIdentity(randomUUID());
    const scope = { profileId: randomUUID(), actingUserId: "user_recipient", assistantId: 42,
      endpointId: endpoint.identity.endpointId, keyFingerprint: codec.identityFingerprint(endpoint.identity),
      pairingId: config.pairingId, ownerUserId: config.ownerUserId };
    const authority = { ...Object.fromEntries(["profileId", "actingUserId", "assistantId", "endpointId", "keyFingerprint"].map(key => [key, scope[key as keyof typeof scope]])),
      bootId: connection.bootId, runtimeId: randomUUID(), sessionId: randomUUID(), writerEpoch: 1, revision: 0, contentKeyEpoch: 1, grantVersion: 1 };
    const entry = { profile: { ...authority, id: scope.profileId, writerState: "active", headManifestHash: null }, grant: { generation: 1, backgroundUse: true } };
    const rawRoster = structuredClone([...SESSION_TOOLS, { name: "browser_click", description: "Click the current page element.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, wait_seconds: WAIT_SECONDS_SCHEMA }, required: ["ref"] } }]);
    const originalRoster = structuredClone(rawRoster), callTool = vi.fn();
    const runtime: Row = { authority, context: { pages: () => [] }, state: "active", network: "active",
      assertCurrent() { expect(this.state).toBe("active"); return authority; }, activate: async () => {}, newPage: async () => {},
      dispose: async () => { runtime.state = "disposed"; runtime.network = "blocked"; } };
    companion.client = { discover: async () => ({ profiles: [entry] }) };
    companion.createEngine = async () => ({ roster: () => rawRoster, callTool, stop: async () => {} });
    companion.createBackups = () => null;
    const record: Row = { scope, identity: endpoint.identity, endpoint, runtime, entry,
      admission: "blocked", revoked: false, uncertain: false, engineTasks: new Set(), state: "saved" };
    companion.records.set(scope.endpointId, record);
    companion._prove = async () => { record.rpc.binding = { bindingId: randomUUID(), socketId: connection.socketId, authority }; };
    let frame: Row, payload: Row;
    companion.rpcClient.dispatch = async () => ({ frame: structuredClone(frame) });
    companion.rpcClient.result = async (_a: unknown, _e: unknown, input: Row) => { payload = input.payload; return { accepted: true }; };
    const request = async (method: string, params: Row = {}) => {
      const id = method === "notifications/initialized" ? undefined : randomUUID();
      frame = { event_type: "browser_profile_rpc", version: 1, rpcId: randomUUID(), rpcNonce: "a".repeat(43),
        bindingId: record.rpc.binding.bindingId, authority, clientId: "codex-managed-metadata", assistantId: 42,
        message: { jsonrpc: "2.0", ...(id ? { id } : {}), method, params }, deadlineAt: new Date(Date.now() + 120000).toISOString() };
      expect((await companion.receive(frame, connection.socketId)).completionAccepted).toBe(true);
      expect(payload!.ok).toBe(true); expect(payload!.message?.error).toBeUndefined();
      if (id) expect(payload!.message.id).toBe(id);
      return payload!.message?.result;
    };
    try {
      await companion._activate(record, authority);
      const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
      expect(initialized.protocolVersion).toBe("2025-06-18");
      expect(initialized.serverInfo.name).toBe("hoai-codex-profile");
      expect(initialized.instructions).toMatch(/^HOAI managed browser profile on Codex on /);
      expect(initialized.instructions).not.toMatch(/your own browser host|gate_parked|30 minutes/i);
      await request("notifications/initialized");
      const tools = (await request("tools/list")).tools;
      expect(tools.some((tool: Row) => tool.name === "hoai_browser_wait_gate")).toBe(false);
      expect(tools.find((tool: Row) => tool.name === "hoai_browser_open_session").description).toMatch(/managed/i);
      expect(tools.find((tool: Row) => tool.name === "hoai_browser_close_session").description).toMatch(/encrypted stopped checkpoint/);
      const wait = tools.find((tool: Row) => tool.name === "browser_click").inputSchema.properties.wait_seconds;
      expect(wait.maximum).toBe(1800); expect(wait.description).toMatch(/at most 60 seconds/);
      expect(wait.description).not.toMatch(/gate_parked|card in.*chat/);
      expect(rawRoster).toEqual(originalRoster);
      expect(loadBrowser).not.toHaveBeenCalled(); expect(callTool).not.toHaveBeenCalled();
    } finally {
      record.relay?.close(); record.rpc?.disconnect(); await companion._dispose(record);
      await host.stop(); rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
});
