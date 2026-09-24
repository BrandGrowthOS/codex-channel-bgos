import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexAdapter } from "../src/adapter.js";
import type { GeneratedImage } from "../src/codex-host.js";
import {
  IMAGE_BYTES_MAX,
  collectGeneratedImage,
} from "../src/generated-images.js";
import { OutboundSpooledError } from "../src/outbound.js";
import { GOLD_PNG, imageItem } from "./fixtures/image-generation.js";

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
/**
 * Finding 3, and the re-review's item 2: a picture that never reached the
 * chat says so in one of two lines. "made" only when the runtime saved a copy
 * or handed over the bytes, and then naming the saved file when there is one
 * (shortened, the way every row shortens a path); "tried" when neither came
 * back, because a generation that failed without a failure object made
 * nothing and must not be said to have.
 *
 * The home directory is pinned per test (HOME and USERPROFILE both, so
 * `os.homedir()` answers the same on Windows, macOS and Linux), which is what
 * makes the shortened path below a fixed string.
 */
const OWNER_HOME = "C:\\Users\\owner";
const SAVED_SHORT =
  "~\\.codex\\generated_images\\01a0d1b7-8827-74c2-8882-b5d8555d38e5\\ig_01a0d1ba2874.png";
const NOT_SHOWN_SAVED = `Codex made a picture, but it could not be shown here. It is saved at ${SAVED_SHORT}.`;
const NOT_SHOWN_MADE = "Codex made a picture, but it could not be shown here.";
const NOT_SHOWN_TRIED =
  "Codex tried to make a picture, but it could not be shown here.";

function pinOwnerHome(): void {
  vi.stubEnv("HOME", OWNER_HOME);
  vi.stubEnv("USERPROFILE", OWNER_HOME);
}
afterEach(() => {
  vi.unstubAllEnvs();
});
const PLAN_LOST =
  "(Codex proposed a plan, but the card could not be posted. Ask it to write the plan out in chat.)";
const PLAN = "## Add retry\n\n1. Add the helper\n2. Wrap the call";

function fixture(runTurn: (callbacks: any) => Promise<unknown>) {
  const order: string[] = [];
  const adapter = Object.create(CodexAdapter.prototype) as any;
  Object.assign(adapter, {
    turnControllers: new Map(),
    planCardFailures: new Set(),
    planDoorHint: new Map(),
    generations: new Map(),
    replyQueues: new Map(),
    chatToAssistant: new Map(),
    ownerId: "owner-1",
    // The plan card's one post, recorded in the same order list as every
    // other post, so "the picture before the card" is one assertion.
    planLane: {
      propose: vi.fn(async () => {
        order.push("card");
      }),
      planModeIn: vi.fn(() => false),
    },
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
      planWaitEnforcedIn: vi.fn(() => false),
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

  it("says a picture could not be shown when its upload failed, names its saved file, once, and no fallback", async () => {
    // Finding 3. The runtime told the model the picture is "already displayed
    // to the user"; without this line the owner never learns one was made,
    // and the generic fallback line would say Codex made nothing at all. The
    // saved copy sits under the Codex home, outside the media root, so the
    // line is the only place the owner learns where it is.
    pinOwnerHome();
    const { adapter, reply } = fixture(async () =>
      done({ images: [picture(), picture({ itemId: "ig_2" })] }),
    );
    reply.sendImageBytes.mockRejectedValue(new Error("S3 PUT failed: HTTP 500"));
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(reply.sendImageBytes).toHaveBeenCalledTimes(2);
    // Two pictures that could not be shown, saved at one place, read as ONE line.
    expect(reply.sendText.mock.calls).toEqual([[NOT_SHOWN_SAVED]]);
  });

  it("says Codex made a picture when its upload failed and the runtime saved no copy", async () => {
    // The bytes came back, so a picture WAS made; there is just no file to name.
    const { adapter, reply } = fixture(async () =>
      done({ images: [picture({ savedPath: undefined })] }),
    );
    reply.sendImageBytes.mockRejectedValue(new Error("S3 PUT failed: HTTP 500"));
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(reply.sendText.mock.calls).toEqual([[NOT_SHOWN_MADE]]);
  });

  it("says Codex only TRIED when an item came back with no picture and no saved file", async () => {
    // Status failed, an empty result, no failure object: nothing was made,
    // and the chat must not say a picture was.
    const { adapter, reply } = fixture(async () =>
      done({ replyText: "Done.", images: [{ itemId: "ig_nothing" }] }),
    );
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(reply.sendImageBytes).not.toHaveBeenCalled();
    expect(reply.sendText.mock.calls).toEqual([[NOT_SHOWN_TRIED], ["Done."]]);
    expect(reply.sendText.mock.calls[0]![0]).not.toMatch(/\bmade\b/);
  });

  it("says Codex MADE a picture when a result came back but could not be drawn, never tried", async () => {
    // Round 5. Both items came back with a non empty result and no saved
    // copy: one is not a picture, one is over the image cap. The runtime
    // handed something over, so Codex made it; "tried" would be false. Both
    // are collected by the real code, so the fact survives the base64 being
    // dropped. One line, because the two lines are the same line.
    const notPicture = collectGeneratedImage(
      imageItem({
        id: "ig_not_picture",
        result: Buffer.from("hello there").toString("base64"),
        savedPath: null,
      }),
    )!;
    const overCap = collectGeneratedImage(
      imageItem({
        id: "ig_over_cap",
        result: Buffer.concat([GOLD_PNG, Buffer.alloc(IMAGE_BYTES_MAX)]).toString(
          "base64",
        ),
        savedPath: null,
      }),
    )!;
    const { adapter, reply } = fixture(async () =>
      done({ replyText: "Done.", images: [notPicture, overCap] }),
    );
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(reply.sendImageBytes).not.toHaveBeenCalled();
    expect(reply.sendText.mock.calls).toEqual([[NOT_SHOWN_MADE], ["Done."]]);
    for (const [line] of reply.sendText.mock.calls)
      expect(line).not.toMatch(/\btried\b/);
  });

  it("counts a picture the outbox took as posted: it will land, so no line", async () => {
    // Finding 8. A retriable failure is spooled and replayed; saying "could
    // not be shown", or "finished without a text reply", would be false.
    const { adapter, reply } = fixture(async () => done({ images: [picture()] }));
    reply.sendImageBytes.mockRejectedValue(
      new OutboundSpooledError(
        Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
      ),
    );
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(reply.sendImageBytes).toHaveBeenCalledTimes(1);
    expect(reply.sendText).not.toHaveBeenCalled();
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

  it("names the saved file when only the saved copy came back, first in the reply", async () => {
    // The savedPath only shape (ledger decision 3's open question, still not
    // seen live): the owner is told where the picture is.
    pinOwnerHome();
    const { adapter, reply } = fixture(async () =>
      done({
        replyText: "Done.",
        images: [{ itemId: "ig_empty", savedPath: SAVED }],
      }),
    );
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(reply.sendImageBytes).not.toHaveBeenCalled();
    expect(reply.sendText.mock.calls).toEqual([[NOT_SHOWN_SAVED], ["Done."]]);
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
        images: [
          picture(),
          refused(),
          { itemId: "ig_empty", savedPath: SAVED },
          { itemId: "ig_nothing" },
        ],
      });
    });
    await adapter.executeAndReply(10, 20, "Draw", reply);
    // The picture exists and the quota is spent; "Stopped." already set done.
    // No text, no refusal line, no not shown line of either kind, and no red
    // error after an intentional stop.
    // Finding 6: the mission and the card close first, and the picture
    // follows without holding them.
    await vi.waitFor(() =>
      expect(order).toEqual(["finalize", `image:Prompt: ${PROMPT}`]),
    );
    // Wait for the background post to finish, so a line posted after the
    // picture would be in the order below and not merely late.
    await vi.waitFor(() => expect(adapter.pictureTails?.get(20)).toBeUndefined());
    expect(order).toEqual(["finalize", `image:Prompt: ${PROMPT}`]);
    expect(
      adapter.missionLane.finalizeTurn.mock.invocationCallOrder[0],
    ).toBeLessThan(reply.sendImageBytes.mock.invocationCallOrder[0]!);
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

  it("posts the pictures before a card the goal turn raises, and never again", async () => {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    const order: string[] = [];
    Object.assign(adapter, {
      ownerId: "owner-1",
      identityReady: false,
      planCardFailures: new Set<number>(),
      planDoorHint: new Map(),
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
      planLane: {
        propose: vi.fn(async () => {
          order.push("card");
        }),
        planModeIn: vi.fn(() => false),
      },
      host: { planWaitEnforcedIn: vi.fn(() => false) },
      outbound: {
        sendText: vi.fn(async () => ({ id: 1 })),
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
    await adopted.callbacks.onPlanProposal({
      turnId: "t1",
      itemId: "plan-1",
      text: PLAN,
      images: [picture()],
    });
    await adopted.deliver(done({ sawPlanProposal: true, images: [picture()] }));
    expect(order).toEqual(["image", "card"]);
  });
});

/**
 * Findings 2 and 7: first in the reply means before EVERY card. A plan card is
 * an event with chips, which the backend reads as blocked ("Waiting on your go
 * ahead"); a picture is a standard post, which it reads as done, and a done
 * that lands after the card closes the owner's Needs you while the plan still
 * waits. And a picture answers the turn, but it never stands in for a plan
 * whose card was lost.
 *
 * MUTATION PROOFS: post the pictures after the fallback card, or leave the
 * mid turn card without its flush, and the order cases go red; drop the
 * `planCardFailed ||` from the fallback guard and the lost plan cases go red.
 */
describe("a picture never runs done over a plan card, and never hides a lost one", () => {
  it("posts the picture before a fallback plan card", async () => {
    const { adapter, reply, order } = fixture(async () =>
      done({
        replyText: `Here is the plan.\n\n<proposed_plan>\n${PLAN}\n</proposed_plan>`,
        images: [picture()],
      }),
    );
    await adapter.executeAndReply(10, 20, "Plan it", reply);
    expect(order.slice(0, 2)).toEqual([`image:Prompt: ${PROMPT}`, "card"]);
  });

  it("posts the pictures finished so far before a card raised mid turn, and never again", async () => {
    const { adapter, reply, order } = fixture(async (cb) => {
      await cb.onPlanProposal?.({
        turnId: "t1",
        itemId: "plan-1",
        text: PLAN,
        images: [picture()],
      });
      return done({ sawPlanProposal: true, images: [picture()] });
    });
    await adapter.executeAndReply(10, 20, "Plan it", reply);
    expect(order).toEqual([`image:Prompt: ${PROMPT}`, "card", "finalize"]);
    expect(reply.sendImageBytes).toHaveBeenCalledTimes(1);
  });

  it("still says the plan's card was lost when a picture posted", async () => {
    const { adapter, reply } = fixture(async () =>
      done({ sawPlanProposal: true, images: [picture()] }),
    );
    adapter.planCardFailures.add(20);
    await adapter.executeAndReply(10, 20, "Plan it", reply);
    expect(reply.sendImageBytes).toHaveBeenCalledTimes(1);
    expect(reply.sendText.mock.calls).toEqual([[PLAN_LOST]]);
  });

  it("still says the plan's card was lost when the picture was refused", async () => {
    const { adapter, reply } = fixture(async () =>
      done({ sawPlanProposal: true, images: [refused()] }),
    );
    adapter.planCardFailures.add(20);
    await adapter.executeAndReply(10, 20, "Plan it", reply);
    expect(reply.sendText.mock.calls).toEqual([[LIMIT_LINE], [PLAN_LOST]]);
  });
});

/**
 * Finding 6: after a Stop, the tool card, the mission and the next message the
 * owner sends never wait on a picture's upload (a presigned PUT, up to 120 s).
 * The stopped turn's pictures still post, AFTER the stop line, and before any
 * post of the turn that follows, so that turn's own status is never run over.
 *
 * MUTATION PROOFS: await the pictures in the Stop branch again and both cases
 * go red; drop the wait for the stop line and the first goes red; drop the
 * next turn's wait for them and the second goes red.
 */
describe("a stopped turn's pictures hold nothing up", () => {
  it("closes the card at once, then posts the picture after the Stopped line", async () => {
    let release!: (value: unknown) => void;
    const { adapter, reply, order } = fixture(
      () => new Promise((resolve) => (release = resolve)),
    );
    let answered!: () => void;
    adapter.host.stopTurn = vi.fn(
      () => new Promise<void>((resolve) => (answered = resolve)),
    );
    adapter.host.resetChat = vi.fn();
    adapter.nativeCommands = {
      handle: vi.fn(async () => false),
      cancel: vi.fn(() => false),
    };
    const turn = adapter.runAndReply(10, 20, "Draw", reply);
    await vi.waitFor(() => expect(adapter.host.runTurn).toHaveBeenCalled());
    const stop = adapter.codexDispatch({
      chatId: 20,
      assistantId: 10,
      messageId: 7,
      userId: "owner-1",
      senderType: "user",
      text: "/stop",
      command: { name: "stop", args: "" },
      replyHandle: reply,
    });
    await vi.waitFor(() => expect(adapter.host.stopTurn).toHaveBeenCalled());
    // The runtime ends the turn before the interrupt's own answer is back:
    // the race in which an upload could beat "Stopped." to the chat.
    release(
      done({
        error: "Stopped by you.",
        turnCompleted: false,
        images: [picture()],
      }),
    );
    await turn;
    expect(order).toEqual(["finalize"]);
    expect(adapter.missionLane.finalizeTurn).toHaveBeenCalledTimes(1);
    expect(reply.sendImageBytes).not.toHaveBeenCalled();
    answered();
    await stop;
    await vi.waitFor(() =>
      expect(order).toEqual([
        "finalize",
        "text:Stopped.",
        `image:Prompt: ${PROMPT}`,
      ]),
    );
  });

  it("runs the next message at once, and keeps its reply after the picture", async () => {
    let turnNo = 0;
    const { adapter, reply, order } = fixture(async () => {
      turnNo += 1;
      if (turnNo === 1) {
        for (const controller of adapter.turnControllers.get(20))
          controller.abort();
        return done({
          error: "Stopped by you.",
          turnCompleted: false,
          images: [picture()],
        });
      }
      order.push("second turn ran");
      return done({ replyText: "Second answer." });
    });
    let land!: () => void;
    reply.sendImageBytes.mockImplementation(
      async (_image: unknown, caption?: string) => {
        await new Promise<void>((resolve) => (land = resolve));
        order.push(`image:${caption ?? ""}`);
        return { id: 6 };
      },
    );
    const first = adapter.runAndReply(10, 20, "Draw", reply);
    const second = adapter.runAndReply(10, 20, "And the next thing", reply);
    await vi.waitFor(() => expect(order).toContain("second turn ran"));
    await first;
    expect(order).not.toContain("text:Second answer.");
    await vi.waitFor(() => expect(reply.sendImageBytes).toHaveBeenCalled());
    land();
    await second;
    expect(order).toEqual([
      "finalize",
      "second turn ran",
      `image:Prompt: ${PROMPT}`,
      "text:Second answer.",
      "finalize",
    ]);
  });
});

/**
 * Re-review item 3: the next turn's REQUESTS wait for a stopped turn's
 * pictures too. An approval card and an ask_user_input carousel are both read
 * as blocked; the stopped picture's standard post is read as done, and landing
 * after the card it would close the owner's Needs you while the approval still
 * waits. The next turn still STARTS at once; only what it posts waits.
 *
 * MUTATION PROOF: pass `this.tools.handleRequest` straight through again (no
 * `await earlier`) and this case goes red.
 */
describe("a stopped turn's pictures land before the next turn's requests", () => {
  it("holds the next turn's approval card until the stopped picture has posted", async () => {
    let turnNo = 0;
    const { adapter, reply, order } = fixture(async (cb) => {
      turnNo += 1;
      if (turnNo === 1) {
        for (const controller of adapter.turnControllers.get(20))
          controller.abort();
        return done({
          error: "Stopped by you.",
          turnCompleted: false,
          images: [picture()],
        });
      }
      order.push("second turn ran");
      // The new turn's first command needs the owner's approval.
      await cb.onRequest?.("item/commandExecution/requestApproval", {
        threadId: "thread-20",
        turnId: "turn-2",
        itemId: "cmd-1",
        command: "npm run deploy",
      });
      return done({ replyText: "Deployed." });
    });
    adapter.tools.handleRequest = vi.fn(async () => {
      order.push("approval card");
      return { decision: "accept" };
    });
    let land!: () => void;
    reply.sendImageBytes.mockImplementation(
      async (_image: unknown, caption?: string) => {
        await new Promise<void>((resolve) => (land = resolve));
        order.push(`image:${caption ?? ""}`);
        return { id: 6 };
      },
    );
    const first = adapter.runAndReply(10, 20, "Draw", reply);
    const second = adapter.runAndReply(10, 20, "Deploy it", reply);
    // The next turn starts at once, while the picture is still uploading.
    await vi.waitFor(() => expect(order).toContain("second turn ran"));
    await first;
    await vi.waitFor(() => expect(reply.sendImageBytes).toHaveBeenCalled());
    expect(order).not.toContain("approval card");
    land();
    await second;
    expect(order).toEqual([
      "finalize",
      "second turn ran",
      `image:Prompt: ${PROMPT}`,
      "approval card",
      "text:Deployed.",
      "finalize",
    ]);
  });
});

/**
 * Finding 9: the runtime tells the model to COPY a picture it needs somewhere
 * else, so the second copy that can really post is a workspace copy under
 * another name, which the savedPath string never matched. A MEDIA: line is
 * now dropped when its file IS the posted picture's saved copy (by real path)
 * or holds the same bytes (sha256); a different picture under a similar name
 * still posts.
 *
 * MUTATION PROOFS: skip the hash and the copy case goes red; skip the real
 * path and the respelled path case goes red; hash every file whatever its
 * bytes and the control goes red.
 */
describe("a MEDIA: line that is the posted picture again is dropped", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hoai-media-dedupe-"));
    mkdirSync(join(root, "assets"), { recursive: true });
    mkdirSync(join(root, "generated"), { recursive: true });
    vi.stubEnv("CODEX_BGOS_MEDIA_ROOT", root);
    vi.stubEnv("CODEX_BGOS_WORKDIR", root);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("drops a workspace copy with the same bytes under another name", async () => {
    const copy = join(root, "assets", "logo.png");
    writeFileSync(copy, GOLD_PNG);
    const { adapter, reply } = fixture(async () =>
      done({ replyText: `Saved it.\nMEDIA:${copy}`, images: [picture()] }),
    );
    await adapter.executeAndReply(10, 20, "Draw and save", reply);
    expect(reply.sendImageBytes).toHaveBeenCalledTimes(1);
    expect(reply.sendFile).not.toHaveBeenCalled();
  });

  it("drops the saved copy named by another spelling of its path", async () => {
    // Different bytes on disk, so only the real path can match.
    const saved = join(root, "generated", "ig_1.png");
    writeFileSync(saved, Buffer.from("not the posted bytes"));
    const { adapter, reply } = fixture(async () =>
      done({
        replyText: "Here.\nMEDIA:./generated/../generated/ig_1.png",
        images: [picture({ savedPath: saved })],
      }),
    );
    await adapter.executeAndReply(10, 20, "Draw", reply);
    expect(reply.sendFile).not.toHaveBeenCalled();
  });

  it("still posts a different picture that only looks like a copy", async () => {
    const other = join(root, "assets", "logo.png");
    writeFileSync(other, Buffer.concat([GOLD_PNG, Buffer.from([0])]));
    const { adapter, reply } = fixture(async () =>
      done({ replyText: `Two.\nMEDIA:${other}`, images: [picture()] }),
    );
    await adapter.executeAndReply(10, 20, "Draw two", reply);
    expect(reply.sendFile.mock.calls).toEqual([[other]]);
  });
});
