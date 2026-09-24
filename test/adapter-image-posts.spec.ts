import { describe, expect, it, vi } from "vitest";

import { CodexAdapter } from "../src/adapter.js";
import type { GeneratedImage } from "../src/codex-host.js";
import { GOLD_PNG } from "./fixtures/image-generation.js";

/**
 * STAGE 4 (C-21): the pictures a Codex turn made post themselves, FIRST in the
 * reply, at the END of the turn.
 *
 * Why the end and never mid turn (gap 04, decided in the P5 ledger): the plugin
 * keeps one tool card per chat per turn, so every tool after the first is a
 * PATCH and nothing puts `working` back. A standard post mid turn therefore
 * marks the agent `done` for the WHOLE rest of the turn: the working line and
 * the Stop button go away, and both stall catchers go blind. The host keeps
 * the pictures on the turn and hands them back on the result; the adapter
 * posts them in publishTurnResult, before the words about them.
 *
 * The harness is the `Object.create(CodexAdapter.prototype)` one from
 * test/agent-activity.spec.ts, with only the fields these paths read.
 *
 * MUTATION PROOFS, recorded in docs/reports/2026-09-24-p5-s4-image-posts:
 *  - posting from an `onImage` callback inside the turn (the superseded plan)
 *    turns the decision guard red;
 *  - posting the pictures after the text turns the ask and buttons cases red;
 *  - counting ATTEMPTED posts instead of successful ones turns the "every
 *    picture failed" case red;
 *  - dropping the post from the error early return, or from the Stop branch,
 *    turns that case red.
 */

const PROMPT = "A plain gold circle centred on a dark charcoal background";
const SAVED =
  "C:\\Users\\owner\\.codex\\generated_images\\01a0d1b7-8827-74c2-8882-b5d8555d38e5\\ig_01a0d1ba2874.png";

function picture(patch: Partial<GeneratedImage> = {}): GeneratedImage {
  return {
    itemId: "ig_01a0d1ba2874",
    bytes: GOLD_PNG,
    mimeType: "image/png",
    fileName: "codex-image-ig_01a0d1ba2874.png",
    revisedPrompt: PROMPT,
    savedPath: SAVED,
    ...patch,
  };
}

function refused(patch: Partial<GeneratedImage> = {}): GeneratedImage {
  return {
    itemId: "ig_refused",
    failure: {
      type: "usageLimitExceeded",
      limitId: "image_generation",
      resetsAt: 1790240000,
    },
    ...patch,
  };
}

const LIMIT_LINE =
  "Codex could not make a picture because the image generation limit is used up. It resets 2026-09-24 08:53 UTC.";
const FALLBACK = "(Codex finished the turn without a text reply.)";

function fixture(runTurn: (callbacks: any) => Promise<unknown>) {
  const order: string[] = [];
  const adapter = Object.create(CodexAdapter.prototype) as any;
  Object.assign(adapter, {
    turnControllers: new Map(),
    planCardFailures: new Set(),
    ownerId: "owner-1",
    missionLane: {
      beginTurn: vi.fn(() => 1),
      finalizeTurn: vi.fn(async () => {}),
    },
    missionControl: {
      applyBulletin: (_chatId: number, input: unknown) => input,
    },
    stepsLane: {
      handlePlan: vi.fn(async () => {}),
      finalizeTurn: vi.fn(async () => {}),
    },
    toolProgress: {
      sendToolStart: vi.fn(async () => {}),
      noteTurnMeta: vi.fn(),
    },
    outbound: {
      sendAgentError: vi.fn(async () => {
        order.push("error");
      }),
    },
    api: {
      postMessage: vi.fn(async () => ({ id: 1 })),
      setStatus: vi.fn(async () => {}),
    },
    tools: { handleRequest: vi.fn(async () => ({})) },
    host: {
      runTurn: vi.fn(async (_chatId: number, _input: unknown, cb: any) =>
        runTurn(cb),
      ),
    },
  });
  const reply = {
    sendTyping: vi.fn(async () => {}),
    finalizeTurn: vi.fn(async () => {
      order.push("finalize");
    }),
    sendText: vi.fn(async (text: string) => {
      order.push(`text:${text}`);
      return { id: 2 };
    }),
    sendButtons: vi.fn(async () => {
      order.push("buttons");
      return { id: 3 };
    }),
    sendAskUserInput: vi.fn(async () => {
      order.push("ask");
      return { id: 4 };
    }),
    sendFile: vi.fn(async (path: string) => {
      order.push(`file:${path}`);
      return { id: 5 };
    }),
    sendImageBytes: vi.fn(async (_image: unknown, caption?: string) => {
      order.push(`image:${caption ?? ""}`);
      return { id: 6 };
    }),
  };
  return { adapter, reply, order };
}

function done(patch: Record<string, unknown> = {}) {
  return {
    error: null,
    replyText: "",
    finalAgentMessageText: "",
    turnCompleted: true,
    threadId: "thread-20",
    ...patch,
  };
}

describe("a picture Codex made posts itself at the end of the turn", () => {
  it("posts AFTER runTurn resolved and BEFORE the reply text (the decision guard)", async () => {
    const { adapter, reply, order } = fixture(async (cb) => {
      await cb.onTool?.(
        { icon: "\u{1F5BC}\uFE0F", name: "image_generation", status: "running", kind: "tool" },
        "ig_01a0d1ba2874",
      );
      // The SUPERSEDED plan (gap 04): a host that also offered the picture
      // mid turn. An adapter that posts from such a callback posts before the
      // turn has ended, and the order below goes red.
      await cb.onImage?.(picture());
      order.push("turn resolved");
      return done({
        replyText: "Here is the gold circle.",
        finalAgentMessageText: "Here is the gold circle.",
        images: [picture()],
      });
    });

    await adapter.executeAndReply(10, 20, "Draw a gold circle", reply);

    expect(order).toEqual([
      "turn resolved",
      `image:Prompt: ${PROMPT}`,
      "text:Here is the gold circle.",
      "finalize",
    ]);
    expect(reply.sendImageBytes).toHaveBeenCalledTimes(1);
    expect(reply.sendImageBytes).toHaveBeenCalledWith(
      {
        bytes: GOLD_PNG,
        fileName: "codex-image-ig_01a0d1ba2874.png",
        mimeType: "image/png",
      },
      `Prompt: ${PROMPT}`,
    );
    const ran = adapter.host.runTurn.mock.invocationCallOrder[0]!;
    const posted = reply.sendImageBytes.mock.invocationCallOrder[0]!;
    const texted = reply.sendText.mock.invocationCallOrder[0]!;
    expect(ran).toBeLessThan(posted);
    expect(posted).toBeLessThan(texted);
  });

  it("posts every picture, in the order they finished, each with its own prompt", async () => {
    const { adapter, reply, order } = fixture(async () =>
      done({
        replyText: "Two circles.",
        images: [
          picture({ itemId: "exec-2", revisedPrompt: "second" }),
          picture({ itemId: "exec-1", revisedPrompt: undefined }),
        ],
      }),
    );
    await adapter.executeAndReply(10, 20, "Draw two", reply);
    expect(order.slice(0, 3)).toEqual([
      "image:Prompt: second",
      "image:",
      "text:Two circles.",
    ]);
    // No revised prompt, no caption at all: never a bare "Prompt:".
    expect(reply.sendImageBytes.mock.calls[1]![1]).toBeUndefined();
  });

  it("posts the picture before an ask, so the ask stays the last word", async () => {
    const { adapter, reply, order } = fixture(async () =>
      done({
        replyText: [
          "Which size do you want?",
          "[[BGOS_ASK]]",
          "Q: Size?",
          "Small | small",
          "Large | large",
          "[[/BGOS_ASK]]",
        ].join("\n"),
        images: [picture()],
      }),
    );
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(order.slice(0, 3)).toEqual([
      `image:Prompt: ${PROMPT}`,
      "text:Which size do you want?",
      "ask",
    ]);
  });

  it("posts the picture before buttons, so the chips stay on the last bubble", async () => {
    const { adapter, reply, order } = fixture(async () =>
      done({
        replyText:
          "Pick a style:\n[[BGOS_BUTTONS]]\nBold | bold\nSoft | soft\n[[/BGOS_BUTTONS]]",
        images: [picture()],
      }),
    );
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(order.slice(0, 2)).toEqual([`image:Prompt: ${PROMPT}`, "buttons"]);
  });

  it("adds no fallback line when a picture posted and the turn wrote no text", async () => {
    const { adapter, reply } = fixture(async () => done({ images: [picture()] }));
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(reply.sendImageBytes).toHaveBeenCalledTimes(1);
    expect(reply.sendText).not.toHaveBeenCalled();
  });

  it("still says the turn wrote nothing when every picture failed to post", async () => {
    const { adapter, reply } = fixture(async () =>
      done({ images: [picture(), picture({ itemId: "ig_2" })] }),
    );
    reply.sendImageBytes.mockRejectedValue(new Error("S3 PUT failed: HTTP 500"));
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(reply.sendImageBytes).toHaveBeenCalledTimes(2);
    expect(reply.sendText).toHaveBeenCalledWith(FALLBACK);
  });

  it("posts one plain line for a refused picture, naming the reset, and no fallback", async () => {
    const { adapter, reply } = fixture(async () =>
      done({ images: [refused(), refused({ itemId: "ig_refused_2" })] }),
    );
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(reply.sendImageBytes).not.toHaveBeenCalled();
    // Two pictures refused by the same limit read as ONE line.
    expect(reply.sendText.mock.calls).toEqual([[LIMIT_LINE]]);
  });

  it("posts nothing for a picture that finished with no usable bytes", async () => {
    const { adapter, reply } = fixture(async () =>
      done({
        replyText: "Done.",
        images: [{ itemId: "ig_empty", savedPath: SAVED }],
      }),
    );
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(reply.sendImageBytes).not.toHaveBeenCalled();
    expect(reply.sendText.mock.calls).toEqual([["Done."]]);
  });

  it("drops a MEDIA: line naming the picture it already posted", async () => {
    const { adapter, reply } = fixture(async () =>
      done({
        replyText: `Here it is.\nMEDIA:${SAVED}\nMEDIA:C:\\work\\notes.pdf`,
        images: [picture()],
      }),
    );
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(reply.sendImageBytes).toHaveBeenCalledTimes(1);
    expect(reply.sendFile.mock.calls).toEqual([["C:\\work\\notes.pdf"]]);
  });

  it("keeps that MEDIA: line when the picture itself could not be posted", async () => {
    const { adapter, reply } = fixture(async () =>
      done({ replyText: `Here it is.\nMEDIA:${SAVED}`, images: [picture()] }),
    );
    reply.sendImageBytes.mockRejectedValue(new Error("S3 PUT failed"));
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(reply.sendFile.mock.calls).toEqual([[SAVED]]);
  });

  it("still posts the picture when the turn then failed with no text", async () => {
    const { adapter, reply, order } = fixture(async () =>
      done({
        error: "Codex could not finish the turn.",
        turnCompleted: false,
        images: [picture()],
      }),
    );
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(order).toEqual([
      `image:Prompt: ${PROMPT}`,
      "finalize",
      "error",
    ]);
  });

  it("posts the pictures that finished before a Stop, and nothing else", async () => {
    const { adapter, reply, order } = fixture(async () => {
      for (const controller of adapter.turnControllers.get(20))
        controller.abort();
      return done({
        error: "Stopped by you.",
        replyText: "Late partial response",
        turnCompleted: false,
        images: [picture(), refused()],
      });
    });
    await adapter.executeAndReply(10, 20, "Draw", reply);
    // The picture exists and the quota is spent; "Stopped." already set done.
    // No text, no refusal line and no red error after an intentional stop.
    expect(order).toEqual([`image:Prompt: ${PROMPT}`, "finalize"]);
    expect(adapter.outbound.sendAgentError).not.toHaveBeenCalled();
  });
});

describe("an adopted goal turn posts its pictures through the same path", () => {
  it("hands the result's pictures to the chat on deliver", async () => {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    const order: string[] = [];
    Object.assign(adapter, {
      ownerId: "owner-1",
      identityReady: false,
      planCardFailures: new Set<number>(),
      chatToAssistant: new Map<number, number>([[20, 10]]),
      assistantToRoute: new Map<number, string>(),
      goalLane: {
        owns: () => true,
        noteTurnStarted: vi.fn(),
        noteTurnFinished: vi.fn(async () => {}),
      },
      stepsLane: {
        handlePlan: vi.fn(async () => {}),
        finalizeTurn: vi.fn(async () => {}),
      },
      toolProgress: {
        sendToolStart: vi.fn(async () => {}),
        finalizeTurn: vi.fn(async () => {}),
        noteTurnMeta: vi.fn(),
      },
      outbound: {
        sendText: vi.fn(async () => {
          order.push("text");
          return { id: 1 };
        }),
        sendImageBytes: vi.fn(async () => {
          order.push("image");
          return { id: 2 };
        }),
        sendAgentError: vi.fn(async () => {}),
      },
      tools: { handleRequest: vi.fn(async () => ({})) },
      api: { setStatus: vi.fn(async () => {}) },
    });
    const adopted = adapter.adoptGoalTurn(20)!;

    await adopted.deliver(
      done({
        replyText: "The logo is ready.",
        finalAgentMessageText: "The logo is ready.",
        images: [picture()],
      }),
    );

    expect(adapter.outbound.sendImageBytes).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantId: 10,
        chatId: 20,
        bytes: GOLD_PNG,
        fileName: "codex-image-ig_01a0d1ba2874.png",
        mimeType: "image/png",
        caption: `Prompt: ${PROMPT}`,
      }),
    );
    expect(order).toEqual(["image", "text"]);
  });
});
