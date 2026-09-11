import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { AppServer, codexEnvironment } from "../src/app-server.js";
const servers: AppServer[] = [];
const server = () => {
  const s = new AppServer({
    cwd: process.cwd(),
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./fixtures/app-server.cjs", import.meta.url)),
    ],
  });
  servers.push(s);
  return s;
};
afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
  vi.unstubAllEnvs();
});
describe("app-server process transport", () => {
  it("round-trips Unicode, quotes and backslashes through JSON without a shell", async () => {
    const s = server();
    await s.start();
    const value = {
      text: String.raw`C:\Agent Files\Renée's notes\$cash & more.md`,
    };
    expect(await s.request("echo", value)).toEqual(value);
  });
  it("returns host tools through the same request id", async () => {
    const s = server();
    s.onRequest = async (method, params) => ({
      method,
      args: params.arguments,
    });
    await s.start();
    const result = await s.request("requestTool", {
      tool: "reply",
      arguments: { text: "hello" },
    });
    expect(result).toEqual({
      id: "reverse",
      result: { method: "item/tool/call", args: { text: "hello" } },
    });
  });
  it("an unavailable host handler returns an error rather than implicit approval", async () => {
    const s = server();
    await s.start();
    const result = await s.request("requestTool", {});
    expect(result.error.code).toBe(-32603);
  });
  it("rejects a timed-out request and remains usable", async () => {
    const s = server();
    await s.start();
    await expect(s.request("never", {}, 30)).rejects.toThrow(/timed out/);
    expect(await s.request("echo", { alive: true })).toEqual({ alive: true });
  });
  it("a dead runtime rejects waiters and restarts on the next start", async () => {
    const s = server();
    await s.start();
    await expect(s.request("crash")).rejects.toThrow(/Codex stopped/);
    await s.start();
    expect(await s.request("echo", { restarted: true })).toEqual({
      restarted: true,
    });
  });
  it("never inherits HOAI credentials into the model process", () => {
    vi.stubEnv("BGOS_SETUP_CODE", "secret");
    vi.stubEnv("CODEX_BGOS_TOKEN", "secret");
    vi.stubEnv("OPENAI_API_KEY", "secret");
    const env = codexEnvironment();
    expect(env.BGOS_SETUP_CODE).toBeUndefined();
    expect(env.CODEX_BGOS_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(codexEnvironment("explicit-key").CODEX_API_KEY).toBe("explicit-key");
  });
});
