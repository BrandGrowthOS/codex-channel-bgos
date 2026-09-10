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
