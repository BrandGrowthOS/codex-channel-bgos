/**
 * MUTATION PROOF, run against this tree: replacing
 * `supersedePlanCardPatch(previous.payload)` in src/plan-lane.ts with a bare
 * `{ options: [] }` turns the supersede case red (the older card loses its
 * steps and never reads superseded); restoring it turns it green and leaves
 * the file's sha256 unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import {
  PLAN_STATUS_TEXT,
  PLAN_STATUS_TTL_MINUTES,
  PlanLane,
  planAnswerPrompt,
  type PlanLaneApi,
} from "../src/plan-lane.js";

function lane() {
  let nextId = 100;
  const api = {
    postMessage: vi.fn(async () => ({ id: ++nextId })),
    agentRequest: vi.fn(async () => ({})),
    setStatus: vi.fn(async () => {}),
  };
  return { api, lane: new PlanLane(api as unknown as PlanLaneApi) };
}
const PLAN = {
  title: "Add retry with backoff",
  steps: [{ text: "Add the helper" }, { text: "Wrap the call" }],
  door: "mode" as const,
  enforced: false,
};

describe("the plan lane", () => {
  it("posts the card and leaves the chat waiting, with a status line that outlives the turn", async () => {
    const { api, lane: plans } = lane();
    const { messageId } = await plans.propose({
      assistantId: 7,
      chatId: 9,
      plan: PLAN,
    });
    expect(messageId).toBe(101);
    const body = api.postMessage.mock.calls[0]![0] as any;
    expect(body.messageType).toBe("event");
    expect(body.eventMeta.payload.revision).toBe(1);
    expect(body.eventMeta.payload.plan_id).toMatch(/^plan-/);
    expect(api.setStatus).toHaveBeenCalledWith(7, {
      statusText: PLAN_STATUS_TEXT,
      // A day, not the server's two hour default: an owner may answer a plan
      // tomorrow and the card is still live when they do.
      ttlMinutes: PLAN_STATUS_TTL_MINUTES,
    });
    expect(PLAN_STATUS_TTL_MINUTES).toBe(1440);
    expect(plans.openPlan(9)?.messageId).toBe(101);
    // Nothing armed a timer. The wait has no end by design.
    expect(api.agentRequest).not.toHaveBeenCalled();
  });

  it("supersedes the card the chat was already waiting on, keeping one plan identity", async () => {
    const { api, lane: plans } = lane();
    await plans.propose({ assistantId: 7, chatId: 9, plan: PLAN });
    const first = api.postMessage.mock.calls[0]![0] as any;
    await plans.propose({
      assistantId: 7,
      chatId: 9,
      plan: { ...PLAN, title: "Add retry, revised" },
    });
    const patch = api.agentRequest.mock.calls[0]!;
    expect(patch[0]).toBe("PATCH");
    expect(patch[1]).toBe("messages/101");
    expect((patch[3] as any).options).toEqual([]);
    expect((patch[3] as any).eventMeta.payload.state).toBe("superseded");
    const second = api.postMessage.mock.calls[1]![0] as any;
    expect(second.eventMeta.payload.plan_id).toBe(first.eventMeta.payload.plan_id);
    expect(second.eventMeta.payload.revision).toBe(2);
    expect(second.eventMeta.payload.supersedes).toBe(101);
    expect(plans.openPlan(9)?.messageId).toBe(102);
  });

  it("still posts the new card when the supersede PATCH fails", async () => {
    const { api, lane: plans } = lane();
    await plans.propose({ assistantId: 7, chatId: 9, plan: PLAN });
    api.agentRequest.mockRejectedValueOnce(new Error("410 gone"));
    await expect(
      plans.propose({ assistantId: 7, chatId: 9, plan: PLAN }),
    ).resolves.toEqual({ messageId: 102 });
  });

  it("refuses a card BGOS accepted without a message id, rather than remembering nothing", async () => {
    const { api, lane: plans } = lane();
    api.postMessage.mockResolvedValueOnce({ id: 0 } as never);
    await expect(
      plans.propose({ assistantId: 7, chatId: 9, plan: PLAN }),
    ).rejects.toThrow(/message id/i);
    expect(plans.openPlan(9)).toBeNull();
  });

  it("reads Go ahead, clears the line and forgets the card so a second tap cannot run twice", async () => {
    const { api, lane: plans } = lane();
    await plans.propose({ assistantId: 7, chatId: 9, plan: PLAN });
    const decision = await plans.answer({
      assistantId: 7,
      chatId: 9,
      messageId: 101,
      callbackData: "plan:go",
    });
    expect(decision?.answer).toBe("go");
    expect(decision?.plan?.payload.title).toBe("Add retry with backoff");
    expect(api.setStatus).toHaveBeenLastCalledWith(7, { statusText: null });
    expect(plans.openPlan(9)).toBeNull();
    // The chips are NOT retired on Go ahead: the app collapses them on the
    // answer it already wrote.
    expect(api.agentRequest).not.toHaveBeenCalled();
  });

  it("retires the chips when the owner turns the plan down", async () => {
    const { api, lane: plans } = lane();
    await plans.propose({ assistantId: 7, chatId: 9, plan: PLAN });
    const decision = await plans.answer({
      assistantId: 7,
      chatId: 9,
      messageId: 101,
      callbackData: "plan:no",
    });
    expect(decision?.answer).toBe("no");
    expect(api.agentRequest).toHaveBeenCalledWith("PATCH", "messages/101", 7, {
      options: [],
    });
  });

  it("carries the owner's typed words off the click, never a second message", async () => {
    const { lane: plans } = lane();
    await plans.propose({ assistantId: 7, chatId: 9, plan: PLAN });
    const decision = await plans.answer({
      assistantId: 7,
      chatId: 9,
      messageId: 101,
      callbackData: "plan:change",
      customText: "Do not touch the uploader tests.",
    });
    expect(decision?.customText).toBe("Do not touch the uploader tests.");
  });

  it("still answers a tap on a card this process never posted, with less to say", async () => {
    const { api, lane: plans } = lane();
    const decision = await plans.answer({
      assistantId: 7,
      chatId: 9,
      messageId: 55,
      callbackData: "plan:go",
    });
    // A daemon restart loses the payload, not the answer.
    expect(decision?.answer).toBe("go");
    expect(decision?.plan).toBeNull();
    expect(api.setStatus).toHaveBeenCalledWith(7, { statusText: null });
  });

  it("is not interested in a click that is not a plan chip", async () => {
    const { api, lane: plans } = lane();
    expect(
      await plans.answer({
        assistantId: 7,
        chatId: 9,
        callbackData: "ea:once:abc",
      }),
    ).toBeNull();
    expect(api.setStatus).not.toHaveBeenCalled();
  });
});

describe("what the agent is told when the owner answers", () => {
  const plan = {
    messageId: 101,
    assistantId: 7,
    payload: { title: "Add retry" } as never,
  };
  it("tells it to implement exactly what it proposed, without re-sending the plan", () => {
    const prompt = planAnswerPrompt({ answer: "go", plan });
    expect(prompt).toMatch(/Go ahead/);
    expect(prompt).toMatch(/Implement it now/);
    expect(prompt).toMatch(/"Add retry"/);
  });
  it("carries the owner's words into a revision and forbids starting the work", () => {
    const prompt = planAnswerPrompt({
      answer: "change",
      plan,
      customText: "Skip step two.",
    });
    expect(prompt).toContain("Skip step two.");
    expect(prompt).toMatch(/Do not start the work/);
    expect(prompt).toMatch(/supersedes/);
  });
  it("asks what to change when the owner typed nothing", () => {
    expect(planAnswerPrompt({ answer: "change", plan, customText: "   " })).toMatch(
      /Ask them what they want different/,
    );
  });
  it("starts NO turn when the owner turns the plan down", () => {
    expect(planAnswerPrompt({ answer: "no", plan })).toBeNull();
  });
});
