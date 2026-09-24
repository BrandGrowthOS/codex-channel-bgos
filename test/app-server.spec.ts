import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { AppServer, codexEnvironment } from "../src/app-server.js";
import {
  PROBE_THREAD,
  PROBE_TURN,
  oversizedImageCompleted,
} from "./fixtures/image-generation.js";
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
  /**
   * Round 7, the final review's low item on src/app-server.ts. The runtime
   * sends a generated picture's whole base64 `result` on one `item/completed`
   * line, so a picture over about 12 MiB makes ONE line longer than the 16 MiB
   * cap. The reader used to fail every pending request and close the
   * connection, ending every live turn in every chat with "Codex sent an
   * oversized event.". Now it throws that one line away, up to its newline,
   * and fails only the request the line would have answered.
   *
   * MUTATION PROOFS (Round 7 in red-proofs.md): close the connection again on
   * an oversized line and all three go red; fail every pending request and the
   * first goes red; leave an oversized request from the runtime unanswered and
   * the third goes red.
   */
  describe("one line over the cap costs only that line", () => {
    it("fails only the request an oversized reply answers, and stays connected", async () => {
      const s = server();
      await s.start();
      const closed = vi.fn();
      s.on("closed", closed);
      const parked = s.request("park", {}, 20_000);
      const big = s.request("big", {}, 20_000);
      await expect(big).rejects.toThrow(/too large/);
      await expect(parked).resolves.toEqual({ parked: true });
      expect(await s.request("echo", { alive: true })).toEqual({ alive: true });
      expect(closed).not.toHaveBeenCalled();
    });
    it("drops an oversized notification and keeps the lines after it", async () => {
      const s = server();
      await s.start();
      const closed = vi.fn();
      s.on("closed", closed);
      const seen: Array<[string, unknown]> = [];
      s.on("notification", (method: string, params: unknown) =>
        seen.push([method, params]),
      );
      expect(await s.request("bigNotify", {}, 20_000)).toEqual({ ok: true });
      expect(seen).toEqual([["tick", { n: 1 }]]);
      expect(closed).not.toHaveBeenCalled();
    });
    it("answers an oversized request from the runtime with an error, never leaves it waiting", async () => {
      const s = server();
      s.onRequest = vi.fn(async () => ({ handled: true }));
      await s.start();
      const answer = await s.request("bigRequest", {}, 20_000);
      expect(answer).toMatchObject({
        id: "huge-1",
        error: { code: -32600, message: expect.stringMatching(/too large/) },
      });
      expect(s.onRequest).not.toHaveBeenCalled();
      expect(await s.request("echo", { alive: true })).toEqual({ alive: true });
    });
  });
  /**
   * Round 8, the last check's finding on Round 7. The runtime sends a
   * generated picture's whole base64 `result` on its `item/completed` line,
   * and the host records a picture on `item/completed` only. So a picture
   * over about 12 MiB was dropped with its line: no picture, and no plain line
   * either, which broke the served canon's "If it cannot be shown, the chat
   * says so in one plain line".
   *
   * Now the transport reads such a line by its two ends. The head (the first
   * 256 characters) must say it is an `item/completed` for an
   * `imageGeneration` item and give the item id. The ids come from the head
   * when the runtime writes them first, and otherwise from the line's last
   * characters, which is where the real 0.154.0 runtime writes them: the
   * probe's raw.jsonl has `params` in the order item, threadId, turnId,
   * completedAtMs, so a head alone never holds the thread. Then the host gets
   * one `item/completed` with no result and `tooLarge`, records the picture,
   * and the "Codex made a picture, but it could not be shown here." line
   * posts. A line that cannot be identified is still dropped in silence.
   */
  describe("a picture too large to read still reaches the host as made", () => {
    const seenBy = (s: AppServer) => {
      const seen: Array<[string, unknown]> = [];
      s.on("notification", (method: string, params: unknown) =>
        seen.push([method, params]),
      );
      return seen;
    };
    it("hands the host the picture, from the ids at the line's end (the real order)", async () => {
      const s = server();
      await s.start();
      const closed = vi.fn();
      s.on("closed", closed);
      const seen = seenBy(s);
      expect(await s.request("bigImage", { shape: "tail" }, 20_000)).toEqual({ ok: true });
      expect(seen).toEqual([
        ["item/completed", oversizedImageCompleted("ig_big_1")],
        ["tick", { n: 1 }],
      ]);
      expect(closed).not.toHaveBeenCalled();
    });
    it("hands the host the picture when the ids come first", async () => {
      const s = server();
      await s.start();
      const seen = seenBy(s);
      expect(await s.request("bigImage", { shape: "head" }, 20_000)).toEqual({ ok: true });
      expect(seen).toEqual([
        ["item/completed", oversizedImageCompleted("ig_big_1")],
        ["tick", { n: 1 }],
      ]);
    });
    it("still drops a picture line that names no thread, in silence", async () => {
      const s = server();
      await s.start();
      const seen = seenBy(s);
      expect(await s.request("bigImage", { shape: "none" }, 20_000)).toEqual({ ok: true });
      expect(seen).toEqual([["tick", { n: 1 }]]);
    });
    it("still drops any other item's line over the cap, in silence", async () => {
      const s = server();
      await s.start();
      const seen = seenBy(s);
      expect(await s.request("bigImage", { shape: "notImage" }, 20_000)).toEqual({ ok: true });
      expect(seen).toEqual([["tick", { n: 1 }]]);
    });
    it("reads the ids however the line is cut into chunks, even through the turn id", () => {
      // The pipe decides the chunks, so the two cuts that matter are made by
      // hand here: the whole line in one chunk (the line is over the cap when
      // its newline arrives), and 64 KiB chunks with the last one starting
      // inside "turnId" (the cap is passed mid line, and the end has to be
      // stitched across chunks).
      const s = new AppServer({ cwd: process.cwd() });
      const seen = seenBy(s);
      const read = (chunk: string) => (s as any).read(chunk);
      const line = JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "imageGeneration",
            id: "ig_big_2",
            status: "completed",
            revisedPrompt: "A gold circle",
            result: "A".repeat(17 * 1024 * 1024),
            transparentBackground: false,
            failure: null,
            savedPath: null,
          },
          threadId: PROBE_THREAD,
          turnId: PROBE_TURN,
          completedAtMs: 1790224861752,
        },
        emittedAtMs: 1790224861757,
      });
      const tick = JSON.stringify({ method: "tick", params: { n: 1 } });
      read(`${line}\n${tick}\n`);
      const cut = line.lastIndexOf('"turnId"') + 4;
      for (let at = 0; at < cut; at += 65536)
        read(line.slice(at, Math.min(at + 65536, cut)));
      read(`${line.slice(cut)}\n${tick}\n`);
      expect(seen).toEqual([
        ["item/completed", oversizedImageCompleted("ig_big_2")],
        ["tick", { n: 1 }],
        ["item/completed", oversizedImageCompleted("ig_big_2")],
        ["tick", { n: 1 }],
      ]);
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
