/**
 * MUTATION PROOF, run against this tree: replacing
 * `supersedePlanCardPatch(previous.payload)` in src/plan-lane.ts with a bare
 * `{ options: [] }` turns the supersede case red (the older card loses its
 * steps and never reads superseded); restoring it turns it green and leaves
 * the file's sha256 unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import {
  FORGET_PLAN_AFTER_MS,
  PLAN_STATUS_TEXT,
  PLAN_STATUS_TTL_MINUTES,
  PlanLane,
  planAnswerPrompt,
  sweepMissedPlanAnswers,
  type PlanLaneApi,
} from "../src/plan-lane.js";
import type {
  PendingPlanEntry,
  PendingPlanStore,
} from "../src/pending-plans-store.js";

/** The durable set, in memory. The real one is a file; the contract is this. */
function memoryStore(seed: PendingPlanEntry[] = []): PendingPlanStore & {
  rows: PendingPlanEntry[];
} {
  const rows = [...seed];
  return {
    rows,
    load: () => [...rows],
    record(entry) {
      if (!rows.some((r) => r.id === entry.id)) rows.push(entry);
    },
    clear(id) {
      const at = rows.findIndex((r) => r.id === id);
      if (at >= 0) rows.splice(at, 1);
    },
  };
}

function lane(store: PendingPlanStore = memoryStore()) {
  let nextId = 100;
  const api = {
    postMessage: vi.fn(async () => ({ id: ++nextId })),
    agentRequest: vi.fn(async () => ({})),
    setStatus: vi.fn(async () => {}),
  };
  return {
    api,
    store,
    lane: new PlanLane(
      api as unknown as PlanLaneApi,
      () => false,
      () => false,
      store,
      () => "owner-1",
    ),
  };
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

  it("reads the ARMED composer's custom click on the open card as Change the plan", async () => {
    // THE SHAPE THE WIRE ACTUALLY CARRIES. The app never posts the
    // `plan:change` option: it arms the composer and Send posts
    // `{ sentinel: "custom", customText }`, which the backend stamps as
    // `__custom__`. A lane that only knew `plan:change` read this as no plan
    // answer at all.
    const { api, lane: plans } = lane();
    await plans.propose({ assistantId: 7, chatId: 9, plan: PLAN });
    const decision = await plans.answer({
      assistantId: 7,
      chatId: 9,
      messageId: 101,
      callbackData: "__custom__",
      customText: "Skip the second step.",
    });
    expect(decision?.answer).toBe("change");
    expect(decision?.customText).toBe("Skip the second step.");
    expect(api.setStatus).toHaveBeenLastCalledWith(7, { statusText: null });
  });

  it("leaves an ordinary custom reply on some OTHER message alone", async () => {
    const { api, lane: plans } = lane();
    await plans.propose({ assistantId: 7, chatId: 9, plan: PLAN });
    api.setStatus.mockClear();
    expect(
      await plans.answer({
        assistantId: 7,
        chatId: 9,
        messageId: 999,
        callbackData: "__custom__",
        customText: "no, the other one",
      }),
    ).toBeNull();
    // The plan is untouched and the waiting line stays up.
    expect(plans.openPlan(9)?.messageId).toBe(101);
    expect(api.setStatus).not.toHaveBeenCalled();
  });

  it("keeps the card open on Change, so the revision that follows IS a revision", async () => {
    const { api, lane: plans } = lane();
    await plans.propose({ assistantId: 7, chatId: 9, plan: PLAN });
    const first = api.postMessage.mock.calls[0]![0] as any;
    await plans.answer({
      assistantId: 7,
      chatId: 9,
      messageId: 101,
      callbackData: "__custom__",
      customText: "Skip the second step.",
    });
    expect(plans.openPlan(9)?.messageId).toBe(101);
    await plans.propose({
      assistantId: 7,
      chatId: 9,
      plan: { ...PLAN, title: "Add retry, without step two" },
    });
    const second = api.postMessage.mock.calls[1]![0] as any;
    expect(second.eventMeta.payload.revision).toBe(2);
    expect(second.eventMeta.payload.plan_id).toBe(first.eventMeta.payload.plan_id);
    expect(second.eventMeta.payload.supersedes).toBe(101);
    expect(second.eventMeta.title).toBe("Plan \u00b7 revised");
    // Exactly one supersede PATCH, and it dims the card the owner answered.
    const patches = api.agentRequest.mock.calls.filter((c) => c[0] === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]![1]).toBe("messages/101");
    expect((patches[0]![3] as any).eventMeta.payload.state).toBe("superseded");
  });

  it("retires the chips of a card the model names but this process no longer holds", async () => {
    // A restart loses the payload, so the full supersede PATCH (which needs
    // it) cannot be written. The chips still have to come off, or the old row
    // stays answerable for ever.
    const { api, lane: plans } = lane();
    await plans.propose({
      assistantId: 7,
      chatId: 9,
      plan: { ...PLAN, supersedes: 88 },
    });
    expect(api.agentRequest).toHaveBeenCalledWith("PATCH", "messages/88", 7, {
      options: [],
    });
    expect(
      (api.postMessage.mock.calls[0]![0] as any).eventMeta.payload.supersedes,
    ).toBe(88);
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

describe("a plan answered while this daemon was DOWN", () => {
  /**
   * THE FINDING. `PlanLane.open` is in memory and a plan answer arrives on one
   * wire, the WS `inbound_click` event. `triggerBackfill` replays new ROWS
   * (`GET integrations/inbound?since_message_id=`), and an answer is an
   * `answered_at` UPDATE to a row that already existed, so nothing replays it.
   * The wait is a day long by design, so a daemon restarting across it is the
   * ordinary case, not an edge. And because `/plan` now holds the chat's
   * sandbox read only too, the cost was not one missed turn: the status line
   * stood for its whole day and the chat stayed read only until somebody hand
   * typed `/code`, so the agent could not do the work it was just approved for.
   *
   * The approval lane in this same tree already had both halves
   * (pending-approvals-store.ts and retireOrphanedApprovals); the asymmetry was
   * inside one plugin.
   *
   * MUTATION PROOF, run against this tree: deleting the `store.record(...)`
   * block from `propose` turns the first two cases red (nothing is ever read
   * back), and restoring it turns them green.
   */
  const CARD = {
    id: 501,
    answeredAt: "2026-09-23T10:00:00.000Z",
    answerPayload: { callbackData: "plan:go", buttonText: "Go ahead" },
    eventMeta: {
      payload: {
        kind: "plan_card",
        v: 1,
        title: "Add retry",
        steps: [{ text: "Add the helper" }],
        door: "mode",
        enforced: true,
        plan_id: "plan-abc",
        revision: 1,
      },
    },
  };

  function seeded(overrides: Record<string, unknown> = {}) {
    const store = memoryStore([
      { id: 501, chatId: 9, assistantId: 7, userId: "owner-1", at: Date.now() },
    ]);
    const api = {
      agentRequest: vi.fn(async () => ({})),
      getMessages: vi.fn(async () => [{ message: { ...CARD, ...overrides } }]),
    };
    const adopted: unknown[] = [];
    const fakeLane = { adopt: vi.fn((plan: unknown) => (adopted.push(plan), true)) };
    return { api, store, fakeLane, adopted };
  }

  it("is recorded on disk the moment the card is posted", async () => {
    const { store, lane: plans } = lane();
    await plans.propose({ assistantId: 7, chatId: 9, plan: PLAN });
    expect((store as any).rows).toEqual([
      expect.objectContaining({ id: 101, chatId: 9, assistantId: 7, userId: "owner-1" }),
    ]);
  });

  it("is read back at the next boot and handed over exactly once", async () => {
    const { api, store, fakeLane } = seeded();
    const missed = await sweepMissedPlanAnswers(api as never, fakeLane as never, store);
    expect(missed).toHaveLength(1);
    expect(missed[0]!.callbackData).toBe("plan:go");
    expect(missed[0]!.entry).toMatchObject({ id: 501, chatId: 9, assistantId: 7 });
    // THE CHIPS COME OFF FIRST, then the entry goes. A failed strip costs one
    // delayed delivery; a failed strip after a successful delivery would let
    // the next boot deliver the same answer again.
    expect(api.agentRequest).toHaveBeenCalledWith("PATCH", "messages/501", 7, {
      options: [],
    });
    expect((store as any).rows).toEqual([]);
    // Idempotent: a second boot finds nothing.
    expect(
      await sweepMissedPlanAnswers(api as never, fakeLane as never, store),
    ).toEqual([]);
  });

  it("carries the armed composer's typed words, which is the whole revision", async () => {
    const { api, store, fakeLane } = seeded({
      answerPayload: { callbackData: "__custom__", customText: "Skip step two." },
    });
    const missed = await sweepMissedPlanAnswers(api as never, fakeLane as never, store);
    expect(missed[0]).toMatchObject({
      callbackData: "__custom__",
      customText: "Skip step two.",
    });
  });

  it("ADOPTS a card nobody answered, which is what lets a later tap resolve", async () => {
    // The half that matters even when nothing was answered. Without it `open`
    // is empty after a restart, so the armed composer's `__custom__` is not
    // recognised as this card's Change the plan and a revision comes back as a
    // brand new plan at revision 1 with the old row still live.
    const { api, store, fakeLane, adopted } = seeded({
      answeredAt: null,
      answerPayload: null,
    });
    const missed = await sweepMissedPlanAnswers(api as never, fakeLane as never, store);
    expect(missed).toEqual([]);
    expect(adopted[0]).toMatchObject({ chatId: 9, messageId: 501, assistantId: 7 });
    // Still open, so the entry STAYS: the owner may answer tomorrow.
    expect((store as any).rows).toHaveLength(1);
    // And nothing was retired.
    expect(api.agentRequest).not.toHaveBeenCalled();
  });

  it("keeps the entry when the row cannot be read, and when the strip fails", async () => {
    const unreadable = seeded();
    unreadable.api.getMessages = vi.fn(async () => {
      throw new Error("503");
    });
    expect(
      await sweepMissedPlanAnswers(
        unreadable.api as never,
        unreadable.fakeLane as never,
        unreadable.store,
      ),
    ).toEqual([]);
    expect((unreadable.store as any).rows).toHaveLength(1);

    const stubborn = seeded();
    stubborn.api.agentRequest = vi.fn(async () => {
      throw new Error("503");
    });
    expect(
      await sweepMissedPlanAnswers(
        stubborn.api as never,
        stubborn.fakeLane as never,
        stubborn.store,
      ),
    ).toEqual([]);
    expect((stubborn.store as any).rows).toHaveLength(1);
  });

  it("forgets a card older than the day its own status line lasts", async () => {
    const { api, store, fakeLane } = seeded();
    const swept = await sweepMissedPlanAnswers(
      api as never,
      fakeLane as never,
      store,
      Date.now() + FORGET_PLAN_AFTER_MS + 1,
    );
    expect(swept).toEqual([]);
    expect((store as any).rows).toEqual([]);
    expect(api.getMessages).not.toHaveBeenCalled();
  });

  it("forgets the entry on every answer, a revision included", async () => {
    // The ROW has been answered on a change too, and the sweep keys on exactly
    // that, so leaving the entry would deliver the same answer again at the
    // next boot. The lane's own open entry is a different question, and a
    // change keeps it so the revision inherits the plan's identity.
    const { store, lane: plans } = lane();
    await plans.propose({ assistantId: 7, chatId: 9, plan: PLAN });
    expect((store as any).rows).toHaveLength(1);
    await plans.answer({
      assistantId: 7,
      chatId: 9,
      messageId: 101,
      callbackData: "plan:change",
      customText: "Skip step two.",
    });
    expect((store as any).rows).toEqual([]);
    expect(plans.openPlan(9)?.messageId).toBe(101);
  });

  it("forgets a card it has just superseded", async () => {
    const { store, lane: plans } = lane();
    await plans.propose({ assistantId: 7, chatId: 9, plan: PLAN });
    await plans.propose({ assistantId: 7, chatId: 9, plan: PLAN });
    expect((store as any).rows.map((r: any) => r.id)).toEqual([102]);
  });

  it("adopt never displaces a card this process is already holding", async () => {
    const { lane: plans } = lane();
    await plans.propose({ assistantId: 7, chatId: 9, plan: PLAN });
    expect(
      plans.adopt({
        chatId: 9,
        messageId: 999,
        assistantId: 7,
        payload: { title: "stale" } as never,
      }),
    ).toBe(false);
    expect(plans.openPlan(9)?.messageId).toBe(101);
  });

  it("records nothing when the lane cannot name the user the row is read as", async () => {
    // A read aimed at a guessed user is worse than a card left alone, and a
    // lane with no identity yet (the tools' no-op poster) is exactly that.
    const store = memoryStore();
    const api = {
      postMessage: vi.fn(async () => ({ id: 101 })),
      agentRequest: vi.fn(async () => ({})),
      setStatus: vi.fn(async () => {}),
    };
    const plans = new PlanLane(
      api as unknown as PlanLaneApi,
      () => false,
      () => false,
      store,
      () => "",
    );
    await plans.propose({ assistantId: 7, chatId: 9, plan: PLAN });
    expect((store as any).rows).toEqual([]);
  });
});
