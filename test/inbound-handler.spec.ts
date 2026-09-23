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
   *
   * THE FIXTURE IS THE SERVER'S SENTENCE, NOT THE ENUM, and that is the whole
   * reason it is spelled out here. These tests fed `risky_jobs` and `always`,
   * three-word values the wire has never carried, which is the same fixture
   * shape that kept the `planPolicySentence` defect green next door
   * (test/plan-card.spec.ts's WIRE_RISKY has the account). A pass through is
   * only proven by passing through what is actually sent.
   */
  const WIRE_ALWAYS =
    "Your owner's setting for when you show a plan before you change " +
    "anything. It applies in every chat and on every channel. Typing /plan " +
    "always shows a plan whatever this says, and this is a request about how " +
    "you work rather than something the platform can enforce: show a plan " +
    "first, every time, before you change a single file.";

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
    return dispatch.mock.calls[0]![0] as {
      planPolicy?: string;
      senderGuardrail?: string;
    };
  }

  it("carries the level through to the turn", async () => {
    expect((await dispatched({ planPolicy: WIRE_ALWAYS })).planPolicy).toBe(
      WIRE_ALWAYS,
    );
  });

  it("carries it on a peer agent's message too, unlike the guardrail", async () => {
    // NOT the guardrail's rule, and this used to be branched as if it were.
    // The guardrail is a term a human share recipient agreed to, so an agent
    // turn has none. The plan level describes the agent RECEIVING the turn:
    // an agent asked by a peer to change twelve files still proposes first if
    // that is what its owner set. The backend is explicit about the asymmetry
    // (its emitter deletes senderGuardrail inside the senderType === 'agent'
    // branch and carries a paragraph saying planPolicy is deliberately left
    // alone there), and peers.service.ts stamps the RECEIVING agent's level
    // onto the a2a envelope that is itself senderType 'agent'. Dropping it
    // here left one owner setting reaching Claude's peer turns and not ours.
    const dispatched_ = await dispatched({
      planPolicy: WIRE_ALWAYS,
      senderGuardrail: "Never touch prod.",
      senderType: "agent",
    });
    expect(dispatched_.planPolicy).toBe(WIRE_ALWAYS);
    // The guardrail IS still dropped there. That is the real precedent.
    expect(dispatched_.senderGuardrail).toBeUndefined();
  });

  it("omits it when the server sent none", async () => {
    expect((await dispatched({})).planPolicy).toBeUndefined();
  });
});
