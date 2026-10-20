import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexEnvironment } from "../src/app-server.js";
import { BrowserContext } from "../src/browser-context.js";
import { browserMcpConfigOverrides, bundledShimPath } from "../src/browser-mcp.js";

type Mode = "active" | "unmanaged" | "resolve-error" | "rpc-error";
const profilePath = "/api/v1/browser/profile-sync/rpc";
const envKey = "mcp_servers.hoai_browser.env";

async function fixture(initial: Mode = "active") {
  let mode = initial;
  const home = mkdtempSync(join(tmpdir(), "codex-managed-caller-"));
  const calls: Array<{ path: string; actor: string; body: any; rpcId?: string }> = [];
  const pending = new Map<string, any>();
  const base = { profileId: randomUUID(), assistantId: 42, endpointId: randomUUID(), bootId: randomUUID(),
    runtimeId: randomUUID(), sessionId: randomUUID(), writerEpoch: 1, revision: 0, contentKeyEpoch: 1,
    grantVersion: 1, keyFingerprint: "a".repeat(64) };
  const backend = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {}, path = req.url!;
    const actor = String(req.headers["x-bgos-acting-user"] || "user_owner");
    calls.push({ path, actor, body });
    res.setHeader("Content-Type", "application/json");
    if (path === profilePath + "/resolve") {
      if (mode === "resolve-error") { res.statusCode = 404; return void res.end("{}"); }
      return void res.end(JSON.stringify(mode === "unmanaged" ? { managed: false, actingUserId: actor, assistantId: 42 } :
        { managed: true, actingUserId: actor, assistantId: 42, profileId: base.profileId, state: "active", authority: { ...base, actingUserId: actor } }));
    }
    if (path === profilePath + "/call") {
      expect(body.authority).toEqual({ ...base, actingUserId: actor });
      const message = { jsonrpc: "2.0", id: body.message.id, result: body.message.method === "initialize" ?
        { capabilities: {} } : { content: [{ type: "text", text: "managed-page" }] } };
      if (body.message.method === "initialize") return void res.end(JSON.stringify({ status: "done", message }));
      if (mode === "rpc-error") { res.statusCode = 503; return void res.end("{}"); }
      const rpcId = randomUUID(); pending.set(rpcId, { message, actor, clientId: body.clientId });
      calls.at(-1)!.rpcId = rpcId;
      return void res.end(JSON.stringify({ status: "pending", rpcId, pollAfterMs: 25 }));
    }
    if (path.startsWith(profilePath + "/") && path.endsWith("/poll")) {
      const saved = pending.get(path.split("/").at(-2)!);
      expect(saved.actor).toBe(actor); expect(saved.clientId).toBe(body.clientId);
      expect(body.authority).toEqual({ ...base, actingUserId: actor });
      return void res.end(JSON.stringify({ status: "done", message: saved.message }));
    }
    if (path.startsWith("/api/v1/integrations/browser/host?")) return void res.end(JSON.stringify({ online: true }));
    if (path === "/api/v1/integrations/browser/mcp") return void res.end(JSON.stringify({ status: "done", message: {
      jsonrpc: "2.0", id: body.message.id, result: body.message.method === "initialize" ? { capabilities: {} } : { content: [{ type: "text", text: "legacy-page" }] },
    } }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const relay = { backendUrl: `http://127.0.0.1:${(backend.address() as any).port}`, pairingToken: "synthetic-caller-pairing", assistantId: 42, ownerUserId: "user_owner" };
  const context = new BrowserContext(home, 9, relay);
  // These are the actual app-server filter and thread configuration functions.
  const config = browserMcpConfigOverrides(bundledShimPath(), process.execPath, relay, context.env);
  const child = spawn(config["mcp_servers.hoai_browser.command"] as string, config["mcp_servers.hoai_browser.args"] as string[], {
    env: { ...codexEnvironment(), HOME: home, USERPROFILE: home, ...config[envKey] as Record<string, string> }, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<number | null>(resolve => child.once("close", resolve));
  let next = 0, buffer = "";
  const replies = new Map<number, (value: any) => void>();
  child.stdout.on("data", chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const reply = JSON.parse(line); replies.get(reply.id)?.(reply); replies.delete(reply.id);
    }
  });
  child.stderr.resume();
  const call = () => new Promise<any>((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { replies.delete(id); reject(Error("managed caller timeout")); }, 5000);
    replies.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } }) + "\n");
  });
  return { calls, context, config, call, setMode: (value: Mode) => { mode = value; }, async close() {
    child.stdin.end(); const code = await closed; context.dispose();
    backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
    rmSync(home, { recursive: true, force: true }); expect(code).toBe(0);
  } };
}

describe("production Codex context selects the managed browser caller", () => {
  it("routes owner and recipient calls and pending results through exact protected authority", async () => {
    const f = await fixture();
    try {
      for (const actor of ["user_owner", "user_recipient"]) {
        f.context.begin(actor, "read the page");
        expect((await f.call()).result.content[0].text).toBe("managed-page");
      }
      const requests = f.calls.filter(c => c.path === profilePath + "/call" && c.body.message.method === "tools/call");
      expect(requests.map(c => c.actor)).toEqual(["user_owner", "user_recipient"]);
      expect(requests[0].body.clientId).not.toBe(requests[1].body.clientId);
      for (const request of requests) expect(f.calls.some(c => c.path === `${profilePath}/${request.rpcId}/poll`)).toBe(true);
      expect(f.calls.some(c => c.path.startsWith("/api/v1/integrations/"))).toBe(false);
      const count = f.calls.length; f.context.end(); expect((await f.call()).result.isError).toBe(true); expect(f.calls).toHaveLength(count);
    } finally { await f.close(); }
  });

  it.each(["resolve-error", "rpc-error", "downgrade"] as const)("refuses %s without selecting a legacy browser", async kind => {
    const f = await fixture(kind === "downgrade" ? "active" : kind);
    try {
      f.context.begin("user_recipient", "read the page");
      if (kind === "downgrade") { expect((await f.call()).result.content[0].text).toBe("managed-page"); f.setMode("unmanaged"); }
      expect((await f.call()).result.isError).toBe(true);
      expect(f.calls.some(c => c.path.startsWith("/api/v1/integrations/"))).toBe(false);
    } finally { await f.close(); }
  });

  it("keeps the legacy route only when discovery explicitly reports no managed profile", async () => {
    const f = await fixture("unmanaged");
    try { f.context.begin("user_recipient", "read the page"); expect((await f.call()).result.content[0].text).toBe("legacy-page");
      expect(f.calls.some(c => c.path === profilePath + "/resolve")).toBe(true);
      expect(f.calls.some(c => c.path === "/api/v1/integrations/browser/mcp")).toBe(true);
    } finally { await f.close(); }
  });
});
