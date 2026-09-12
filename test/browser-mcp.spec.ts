import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  browserMcpConfigOverrides,
  browserRelayEnv,
  bundledShimPath,
  resolveBrowserShim,
  HOAI_BROWSER_SERVER,
} from "../src/browser-mcp.js";
import { CodexHost } from "../src/codex-host.js";

const home = join(sep, "home", "kc");
const installed = join(home, ".hoai", "bin", "hoai-browser-mcp.mjs");
const bundled = join(sep, "pkg", "vendor", "hoai-browser-mcp.mjs");
const ENV_KEY = `mcp_servers.${HOAI_BROWSER_SERVER}.env`;
// Shaped like a pairing token but meaningless: nothing here talks to HOAI.
const TOKEN = "pair-test-0123456789abcdefghij";

describe("resolveBrowserShim", () => {
  it("prefers the app-installed shim under ~/.hoai/bin", () => {
    expect(
      resolveBrowserShim({ home, exists: (p) => p === installed, bundled }),
    ).toBe(installed);
  });
  it("falls back to the bundled copy, then to null", () => {
    expect(
      resolveBrowserShim({ home, exists: (p) => p === bundled, bundled }),
    ).toBe(bundled);
    expect(resolveBrowserShim({ home, exists: () => false, bundled })).toBeNull();
  });
});

describe("browserRelayEnv", () => {
  it("needs both halves: either one missing means no relay env at all", () => {
    expect(browserRelayEnv()).toEqual({});
    expect(browserRelayEnv(null)).toEqual({});
    expect(
      browserRelayEnv({ backendUrl: "https://api.example.test", pairingToken: "" }),
    ).toEqual({});
    expect(browserRelayEnv({ backendUrl: "  ", pairingToken: TOKEN })).toEqual({});
  });
  it("trims trailing slashes off the backend url and whitespace off both", () => {
    expect(
      browserRelayEnv({
        backendUrl: "  https://api.example.test///  ",
        pairingToken: `  ${TOKEN}  `,
      }),
    ).toEqual({
      HOAI_RELAY_BACKEND_URL: "https://api.example.test",
      HOAI_RELAY_PAIRING_TOKEN: TOKEN,
    });
  });
});

describe("browserMcpConfigOverrides", () => {
  it("emits dotted mcp_servers overrides for the shim and nothing without one", () => {
    expect(browserMcpConfigOverrides(null)).toEqual({});
    expect(
      browserMcpConfigOverrides(null, "/usr/bin/node", {
        backendUrl: "https://api.example.test",
        pairingToken: TOKEN,
      }),
    ).toEqual({});
    const o = browserMcpConfigOverrides(installed, "/usr/bin/node");
    expect(o[`mcp_servers.${HOAI_BROWSER_SERVER}.command`]).toBe("/usr/bin/node");
    expect(o[`mcp_servers.${HOAI_BROWSER_SERVER}.args`]).toEqual([installed]);
    expect(o[`mcp_servers.${HOAI_BROWSER_SERVER}.startup_timeout_sec`]).toBe(20);
  });
  it("carries no env key at all without complete relay credentials", () => {
    expect(browserMcpConfigOverrides(installed, "/usr/bin/node")).not.toHaveProperty(
      ENV_KEY,
    );
    expect(
      browserMcpConfigOverrides(installed, "/usr/bin/node", null),
    ).not.toHaveProperty(ENV_KEY);
    expect(
      browserMcpConfigOverrides(installed, "/usr/bin/node", {
        backendUrl: "https://api.example.test",
        pairingToken: "",
      }),
    ).not.toHaveProperty(ENV_KEY);
  });
  it("hands the shim the relay env, trailing slash trimmed, and the token under exactly one key", () => {
    const o = browserMcpConfigOverrides(installed, "/usr/bin/node", {
      backendUrl: "https://api.brandgrowthos.test/",
      pairingToken: TOKEN,
    });
    expect(o[ENV_KEY]).toEqual({
      HOAI_RELAY_BACKEND_URL: "https://api.brandgrowthos.test",
      HOAI_RELAY_PAIRING_TOKEN: TOKEN,
    });
    const env = o[ENV_KEY] as Record<string, string>;
    expect(Object.keys(env).filter((k) => env[k] === TOKEN)).toEqual([
      "HOAI_RELAY_PAIRING_TOKEN",
    ]);
    const elsewhere = Object.entries(o).filter(
      ([key, value]) => key !== ENV_KEY && JSON.stringify(value).includes(TOKEN),
    );
    expect(elsewhere).toEqual([]);
  });
});

/** Same mock shape as codex-host.spec.ts, plus an answer for thread/fork. */
class Server extends EventEmitter {
  next = 0;
  start = vi.fn(async () => {});
  close = vi.fn(() => this.emit("closed", new Error("closed")));
  request = vi.fn(async (method: string, p: any) => {
    if (method === "thread/start")
      return { thread: { id: `thread-${++this.next}` } };
    if (method === "thread/fork") return { thread: { id: `fork-${++this.next}` } };
    if (method === "thread/resume") return { thread: { id: p.threadId } };
    if (method === "turn/start") return { turn: { id: `turn-${p.threadId}` } };
    return {};
  });
  finish(id: string, text: string) {
    this.emit("notification", "item/completed", {
      threadId: id,
      item: { id: "message", type: "agentMessage", text },
    });
    this.emit("notification", "turn/completed", {
      threadId: id,
      turn: { status: "completed" },
    });
  }
  paramsFor(method: string): any {
    const call = this.request.mock.calls.find(([m]) => m === method);
    return call?.[1];
  }
}

describe("the relay env reaches every thread Codex starts", () => {
  let workdir: string, server: Server, host: CodexHost;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "hoai-browser-"));
    // No ~/.hoai/bin copy in this temp home, so the bundled vendor/ shim wins
    // and the resolved path does not depend on the developer's machine.
    vi.stubEnv("HOAI_HOME", workdir);
    vi.stubEnv("CODEX_BGOS_HOME", workdir);
    server = new Server();
    host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir,
      server: server as any,
      relay: () => ({
        backendUrl: "https://api.brandgrowthos.test/",
        pairingToken: TOKEN,
      }),
    });
  });
  afterEach(() => {
    host.close();
    vi.unstubAllEnvs();
    rmSync(workdir, { recursive: true, force: true });
  });

  it("puts it on thread/start and on the thread/fork a consult rides", async () => {
    const turn = host.runTurn(7, "hello");
    await vi.waitFor(() =>
      expect(server.request).toHaveBeenCalledWith(
        "turn/start",
        expect.objectContaining({ threadId: "thread-1" }),
      ),
    );
    expect(server.paramsFor("thread/start").config[ENV_KEY]).toEqual({
      HOAI_RELAY_BACKEND_URL: "https://api.brandgrowthos.test",
      HOAI_RELAY_PAIRING_TOKEN: TOKEN,
    });
    server.finish("thread-1", "hi");
    await turn;

    const consult = host.runDetached(7, "consult");
    await vi.waitFor(() =>
      expect(server.request).toHaveBeenCalledWith(
        "turn/start",
        expect.objectContaining({ threadId: "fork-2" }),
      ),
    );
    const forked = server.paramsFor("thread/fork").config;
    expect(forked[ENV_KEY]).toEqual({
      HOAI_RELAY_BACKEND_URL: "https://api.brandgrowthos.test",
      HOAI_RELAY_PAIRING_TOKEN: TOKEN,
    });
    expect(forked[`mcp_servers.${HOAI_BROWSER_SERVER}.args`]).toEqual([
      bundledShimPath(),
    ]);
    server.finish("fork-2", "consulted");
    await consult;
  });

  it("survives a resolver that throws, and then carries no relay env", async () => {
    host.close();
    server = new Server();
    host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir,
      server: server as any,
      relay: () => {
        throw new Error("secrets unreadable");
      },
    });
    const turn = host.runTurn(9, "hello");
    await vi.waitFor(() =>
      expect(server.request).toHaveBeenCalledWith(
        "turn/start",
        expect.objectContaining({ threadId: "thread-1" }),
      ),
    );
    const config = server.paramsFor("thread/start").config;
    expect(config[ENV_KEY]).toBeUndefined();
    expect(config[`mcp_servers.${HOAI_BROWSER_SERVER}.command`]).toBe(
      process.execPath,
    );
    server.finish("thread-1", "hi");
    await turn;
  });
});

/** A loopback port nothing is listening on, so the relay probe fails at once. */
async function deadPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    }),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Minimal stdio MCP client over the vendored shim; one request at a time. */
function shimClient(env: Record<string, string>) {
  const child = spawn(process.execPath, [bundledShimPath()], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  const pending = new Map<number, (msg: any) => void>();
  child.stderr.on("data", (d) => (stderr += String(d)));
  child.stdout.on("data", (d) => {
    buffer += String(d);
    let cut: number;
    while ((cut = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });
  let id = 0;
  const request = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      const timer = setTimeout(
        () => reject(new Error(`no reply to ${method} in 10 s; stderr: ${stderr}`)),
        10_000,
      );
      timer.unref();
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params }) + "\n",
      );
    });
  return { request, close: () => child.kill(), stderr: () => stderr };
}

describe("the vendored shim, offline but with relay credentials", () => {
  let temp: string;
  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "hoai-shim-"));
  });
  afterEach(() => {
    rmSync(temp, { recursive: true, force: true });
  });

  it("says the owner's desktop app is the thing that is missing, not this machine's", async () => {
    const port = await deadPort();
    const client = shimClient({
      // A home with no ~/.hoai/agent-browser.json, so there is no local door.
      HOAI_HOME: temp,
      HOAI_RELAY_BACKEND_URL: `http://127.0.0.1:${port}`,
      HOAI_RELAY_PAIRING_TOKEN: TOKEN,
      HOAI_RELAY_PROBE_MS: "60000",
    });
    try {
      const init = await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "codex", version: "test" },
      });
      expect(init.result.serverInfo.name).toBe("hoai-agent-browser");
      expect(init.result.instructions).toMatch(
        /owner's Home of Agents desktop app is not running or not signed in/,
      );
      const list = await client.request("tools/list");
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
        "hoai_browser_status",
      ]);
      const status = await client.request("tools/call", {
        name: "hoai_browser_status",
        arguments: {},
      });
      expect(status.result.isError).toBe(false);
      expect(status.result.content[0].text).toMatch(
        /owner's Home of Agents desktop app/,
      );
      // Offline is not a reason to invent a browser: a real call is an error.
      const nav = await client.request("tools/call", {
        name: "browser_navigate",
        arguments: { url: "https://example.test/" },
      });
      expect(nav.result.isError).toBe(true);
      expect(client.stderr()).not.toContain(TOKEN);
    } finally {
      client.close();
    }
  }, 20_000);
});
