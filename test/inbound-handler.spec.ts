import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInboundHandler } from "../src/inbound-handler.js";
describe("attachment delivery", () => {
  let home: string,
    downloaded: string[] = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-inbound-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const path of downloaded.splice(0)) rmSync(path, { force: true });
    rmSync(home, { recursive: true, force: true });
  });
  it("delivers actual inline file bytes and literal paths to the native host", async () => {
    const dispatch = vi.fn(async (args) => {
      downloaded.push(...args.attachments.map((a: any) => a.localPath));
    });
    const outbound = { sendAgentError: vi.fn() };
    const handle = createInboundHandler({
      outbound: outbound as any,
      getRouteForAssistant: () => "codex-9",
      getDispatch: () => dispatch,
    });
    const text = String.raw`C:\Users\QA\notes.md`;
    await handle({
      assistantId: 9,
      userId: "test",
      chatId: 1,
      messageId: 1,
      text: "Read this file",
      messageType: "standard",
      files: [
        {
          id: 1,
          filename: "notes.md",
          mime: "text/markdown",
          dataUri:
            "data:text/markdown;base64," + Buffer.from(text).toString("base64"),
        },
      ],
    });
    expect(readFileSync(downloaded[0], "utf8")).toBe(text);
    expect(dispatch.mock.calls[0][0].attachments[0].fileName).toBe("notes.md");
    expect(outbound.sendAgentError).not.toHaveBeenCalled();
  });
  it("discloses a missing file without dropping the user's text or claiming to read it", async () => {
    const dispatch = vi.fn(async () => {}),
      sendAgentError = vi.fn(async () => {});
    const handle = createInboundHandler({
      outbound: { sendAgentError } as any,
      getRouteForAssistant: () => "codex-9",
      getDispatch: () => dispatch,
    });
    await handle({
      assistantId: 9,
      userId: "test",
      chatId: 1,
      messageId: 2,
      text: "Read this file",
      messageType: "standard",
      files: [{ id: 1, filename: "notes.md", mime: "text/markdown" }],
    });
    expect(sendAgentError).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [],
        text: expect.stringContaining(
          "Read this file\n\n[Attachment delivery notice:",
        ),
      }),
    );
  });
});

describe("the owner's plan level on the envelope", () => {
  /**
   * The level is the server's to decide and the daemon's to repeat. It rides
   * the inbound envelope for the same reason the share guardrail does: a
   * daemon that read the assistant row would be the first breach of "the
   * daemon offers, the server decides" (and there is a standing source guard
   * against reading the LAST per agent setting, in agent-activity.spec.ts).
   */
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-plan-envelope-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  async function dispatched(event: Record<string, unknown>) {
    const dispatch = vi.fn(async () => {});
    const handle = createInboundHandler({
      outbound: { sendAgentError: vi.fn() } as any,
      getRouteForAssistant: () => "codex-9",
      getDispatch: () => dispatch,
    });
    await handle({
      assistantId: 9,
      userId: "test",
      chatId: 1,
      messageId: 3,
      text: "do it",
      messageType: "standard",
      files: [],
      ...event,
    } as never);
    return dispatch.mock.calls[0]![0] as { planPolicy?: string };
  }

  it("carries the level through to the turn", async () => {
    expect((await dispatched({ planPolicy: "risky_jobs" })).planPolicy).toBe(
      "risky_jobs",
    );
  });

  it("drops it on a peer agent's message, exactly as the guardrail is dropped", async () => {
    // The level is the OWNER's instruction about the owner's work. Another
    // agent's message is not the owner speaking.
    expect(
      (await dispatched({ planPolicy: "always", senderType: "agent" }))
        .planPolicy,
    ).toBeUndefined();
  });

  it("omits it when the server sent none", async () => {
    expect((await dispatched({})).planPolicy).toBeUndefined();
  });
});
