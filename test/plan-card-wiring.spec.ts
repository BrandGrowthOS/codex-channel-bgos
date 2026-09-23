/**
 * The plan card is WIRED, not merely written.
 *
 * `plan-card.spec.ts` and `plan-lane.spec.ts` cover the shapes and the lane.
 * These cases cover the four seams where the adapter has to call them, each of
 * which is one line that would leave every other file green if it were deleted:
 * the host callback that catches a proposed plan, the `<proposed_plan>`
 * fallback in the reply path, the three chips in the click path, and the
 * connect-time report of chats left in plan mode.
 *
 * MUTATION PROOF, run against this tree: deleting the `onPlanProposal`
 * callback from `executeAndReply` in src/adapter.ts turns the first cases red
 * (the plan reaches nobody, exactly as it does today); restoring it turns them
 * green and leaves the file's sha256 unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/adapter.js";
import { PlanLane } from "../src/plan-lane.js";

function planApi() {
  let next = 500;
  return {
    postMessage: vi.fn(async () => ({ id: ++next })),
    agentRequest: vi.fn(async () => ({})),
    setStatus: vi.fn(async () => {}),
    reportSessionMode: vi.fn(async () => {}),
  };
}

function fixture(runTurn: (callbacks: any) => Promise<unknown>) {
  const adapter = Object.create(CodexAdapter.prototype) as any;
  const api = planApi();
  Object.assign(adapter, {
    turnControllers: new Map(),
    planDoorHint: new Map(),
    planCardFailures: new Set(),
    lastInput: new Map(),
    lastNativeOptions: new Map(),
    ownerId: "owner-1",
    identityReady: true,
    assistantToRoute: new Map([[10, "codex"]]),
    chatToAssistant: new Map([[20, 10]]),
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
      sendAgentError: vi.fn(async () => {}),
      sendText: vi.fn(async () => ({ id: 1 })),
      sendButtons: vi.fn(async () => ({ id: 1 })),
    },
    api,
    planLane: new PlanLane(api as never),
    tools: { handleRequest: vi.fn(async () => ({})) },
    host: {
      runTurn: vi.fn(async (_chatId: number, _input: unknown, cb: any) =>
        runTurn(cb),
      ),
      updateSettings: vi.fn(async () => ({})),
      planModeChats: vi.fn(() => []),
    },
  });
  const reply = {
    sendTyping: vi.fn(async () => {}),
    finalizeTurn: vi.fn(async () => {}),
    sendText: vi.fn(async () => {}),
    sendButtons: vi.fn(async () => {}),
    sendFile: vi.fn(async () => {}),
    sendAskUserInput: vi.fn(async () => {}),
  };
  return { adapter, reply, api };
}

const PLAN = "## Add retry\n\n### Summary\nIt retries nothing.\n\n1. Add the helper\n2. Wrap the call";

describe("the plan a Codex turn proposes reaches the chat", () => {
  it("posts the plan item as a card, with chips, inside the turn", async () => {
    const { adapter, reply, api } = fixture(async (cb) => {
      await cb.onPlanProposal?.({ turnId: "t1", itemId: "t1-plan", text: PLAN });
      return {
        error: null,
        replyText: "I explored it. Here is the plan.",
        turnCompleted: true,
        sawPlanProposal: true,
      };
    });
    await adapter.executeAndReply(10, 20, "Plan it", reply);
    expect(api.postMessage).toHaveBeenCalledTimes(1);
    const body = api.postMessage.mock.calls[0]![0] as any;
    expect(body).toMatchObject({ assistantId: 10, chatId: 20, messageType: "event" });
    expect(body.eventMeta.payload.kind).toBe("plan_card");
    expect(body.eventMeta.payload.title).toBe("Add retry");
    expect(body.eventMeta.payload.steps).toHaveLength(2);
    // Plan mode is the door when the owner did not type /plan <task>.
    expect(body.eventMeta.payload.door).toBe("mode");
    expect(body.options.map((o: any) => o.callbackData)).toEqual([
      "plan:go",
      "plan:change",
      "plan:no",
    ]);
    // The turn's own sentence still lands, under the card.
    expect(reply.sendText).toHaveBeenCalledWith("I explored it. Here is the plan.");
  });

  it("spends the typed door that /plan <task> left behind, once", async () => {
    const { adapter, reply, api } = fixture(async (cb) => {
      await cb.onPlanProposal?.({ turnId: "t1", itemId: "p", text: PLAN });
      return { error: null, replyText: "", turnCompleted: true, sawPlanProposal: true };
    });
    adapter.planDoorHint.set(20, "typed");
    await adapter.executeAndReply(10, 20, "Plan it", reply);
    expect((api.postMessage.mock.calls[0]![0] as any).eventMeta.payload.door).toBe(
      "typed",
    );
    expect(adapter.planDoorHint.has(20)).toBe(false);
  });

  it("falls back to a <proposed_plan> block and says nothing wrong under it", async () => {
    const { adapter, reply, api } = fixture(async () => ({
      error: null,
      replyText: `Here it is.\n\n<proposed_plan>\n${PLAN}\n</proposed_plan>`,
      turnCompleted: true,
    }));
    await adapter.executeAndReply(10, 20, "Plan it", reply);
    expect(api.postMessage).toHaveBeenCalledTimes(1);
    expect(
      (api.postMessage.mock.calls[0]![0] as any).eventMeta.payload.title,
    ).toBe("Add retry");
    // The block is gone from the text, and what was around it is still said.
    expect(reply.sendText).toHaveBeenCalledWith("Here it is.");
    expect(reply.sendText).not.toHaveBeenCalledWith(
      expect.stringContaining("proposed_plan"),
    );
  });

  it("never says the turn had no reply when the plan card WAS the reply", async () => {
    const { adapter, reply } = fixture(async () => ({
      error: null,
      replyText: `<proposed_plan>\n${PLAN}\n</proposed_plan>`,
      turnCompleted: true,
    }));
    await adapter.executeAndReply(10, 20, "Plan it", reply);
    expect(reply.sendText).not.toHaveBeenCalled();
  });

  it("leaves an ordinary plan mode message alone, which is most of plan mode", async () => {
    // Phases 1 and 2 of Codex's plan mode are ordinary chat. A fallback that
    // fired on any message would turn every question into a plan card.
    const { adapter, reply, api } = fixture(async () => ({
      error: null,
      replyText: "Which database is this?",
      turnCompleted: true,
    }));
    await adapter.executeAndReply(10, 20, "Plan it", reply);
    expect(api.postMessage).not.toHaveBeenCalled();
    expect(reply.sendText).toHaveBeenCalledWith("Which database is this?");
  });
});

describe("the owner's answer to a plan card", () => {
  async function armed() {
    const f = fixture(async () => ({ error: null, replyText: "", turnCompleted: true }));
    f.adapter.runAndReply = vi.fn(async () => {});
    await f.adapter.planLane.propose({
      assistantId: 10,
      chatId: 20,
      plan: {
        title: "Add retry",
        steps: [{ text: "Add the helper" }],
        door: "mode" as const,
        enforced: false,
      },
    });
    f.api.setStatus.mockClear();
    return f;
  }

  it("Go ahead flips Codex back to coding, announces it and starts the work", async () => {
    const f = await armed();
    await f.adapter.handlePlanClick({
      assistantId: 10,
      chatId: 20,
      messageId: 501,
      callbackData: "plan:go",
      userId: "owner-1",
    });
    expect(f.adapter.host.updateSettings).toHaveBeenCalledWith(20, {
      mode: "default",
    });
    expect(f.api.reportSessionMode).toHaveBeenCalledWith(10, 20, {
      mode: "default",
      enforced: false,
    });
    expect(f.adapter.outbound.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Plan approved, switched from Plan to Code mode",
      }),
    );
    expect(f.adapter.runAndReply).toHaveBeenCalledTimes(1);
    expect(f.api.setStatus).toHaveBeenCalledWith(10, { statusText: null });
  });

  it("Change the plan stays in plan mode and carries the owner's typed words", async () => {
    const f = await armed();
    await f.adapter.handlePlanClick({
      assistantId: 10,
      chatId: 20,
      messageId: 501,
      callbackData: "plan:change",
      customText: "Skip the second step.",
      userId: "owner-1",
    });
    expect(f.adapter.host.updateSettings).not.toHaveBeenCalled();
    expect(f.api.reportSessionMode).toHaveBeenCalledWith(10, 20, {
      mode: "plan",
      enforced: false,
    });
    expect(f.adapter.runAndReply).toHaveBeenCalledTimes(1);
    const input = JSON.stringify(f.adapter.runAndReply.mock.calls[0]![2]);
    expect(input).toContain("Skip the second step.");
  });

  it("Don't do this settles the card and starts no turn at all", async () => {
    const f = await armed();
    await f.adapter.handlePlanClick({
      assistantId: 10,
      chatId: 20,
      messageId: 501,
      callbackData: "plan:no",
      userId: "owner-1",
    });
    expect(f.adapter.host.updateSettings).toHaveBeenCalledWith(20, {
      mode: "default",
    });
    expect(f.adapter.runAndReply).not.toHaveBeenCalled();
    // The chips come off: nothing else will take them off.
    expect(f.api.agentRequest).toHaveBeenCalledWith("PATCH", "messages/501", 10, {
      options: [],
    });
  });

  it("reads the armed composer's custom click on the card as Change the plan", async () => {
    // THE SHAPE THE WIRE CARRIES, end to end. Pressing "Change the plan" does
    // not post the option: the app arms the composer and Send posts
    // `{ sentinel: "custom", customText }`, which the backend stamps
    // `__custom__`. Routed on `parsePlanChip` alone, this arrived as an
    // ordinary typed reply: a plain coding turn on the owner's words, the
    // waiting line left up for its whole day, and no revised plan ever asked
    // for.
    const f = await armed();
    f.adapter.tools = { interactions: { handleClick: () => false } };
    f.adapter.handleInboundClick({
      assistantId: 10,
      chatId: 20,
      messageId: 501,
      optionId: 1,
      callbackData: "__custom__",
      customText: "Skip the second step.",
      userId: "owner-1",
    });
    await new Promise((r) => setImmediate(r));
    expect(f.api.setStatus).toHaveBeenCalledWith(10, { statusText: null });
    expect(f.adapter.host.updateSettings).not.toHaveBeenCalled();
    expect(f.api.reportSessionMode).toHaveBeenCalledWith(10, 20, {
      mode: "plan",
      enforced: false,
    });
    expect(f.adapter.runAndReply).toHaveBeenCalledTimes(1);
    const input = JSON.stringify(f.adapter.runAndReply.mock.calls[0]![2]);
    expect(input).toContain("Skip the second step.");
    // The revision prompt, not "The user selected: ...".
    expect(input).toContain("propose_plan");
    expect(input).toContain("supersedes");
  });

  it("leaves a custom reply on some OTHER message on the generic path", async () => {
    const f = await armed();
    f.adapter.tools = { interactions: { handleClick: () => false } };
    f.adapter.handleInboundClick({
      assistantId: 10,
      chatId: 20,
      messageId: 777,
      optionId: 2,
      callbackData: "__custom__",
      customText: "just a typed reply",
      userId: "owner-1",
    });
    await new Promise((r) => setImmediate(r));
    const input = JSON.stringify(f.adapter.runAndReply.mock.calls[0]![2]);
    expect(input).toContain("just a typed reply");
    expect(input).not.toContain("propose_plan");
    // The plan is still waiting: nothing answered it.
    expect(f.adapter.planLane.openPlan(20)?.messageId).toBe(501);
    expect(f.api.setStatus).not.toHaveBeenCalledWith(10, { statusText: null });
  });

  it("takes the three chips before the generic click path", async () => {
    const f = await armed();
    f.adapter.handlePlanClick = vi.fn(async () => {});
    f.adapter.tools = { interactions: { handleClick: () => false } };
    f.adapter.handleInboundClick({
      assistantId: 10,
      chatId: 20,
      messageId: 501,
      callbackData: "plan:go",
      userId: "owner-1",
    });
    expect(f.adapter.handlePlanClick).toHaveBeenCalledTimes(1);
  });
});

describe("a plan the AGENT decided to propose, in a chat that is not in plan mode", () => {
  /**
   * The `decided` door is `propose_plan` under a plan policy, raised inside an
   * ordinary coding chat. Answering it must not write a mode the chat never
   * had: `chats.session_mode` is PERSISTED, the app draws the Plan chip and
   * the gold pill off it, and `reportStoredPlanModes` only ever reports
   * `plan`, so a restart would not undo the lie either.
   */
  async function decided(answer: "go" | "no" | "change") {
    const f = fixture(async () => ({ error: null, replyText: "", turnCompleted: true }));
    f.adapter.runAndReply = vi.fn(async () => {});
    await f.adapter.planLane.propose({
      assistantId: 10,
      chatId: 20,
      plan: {
        title: "Add retry",
        steps: [{ text: "Add the helper" }],
        door: "decided" as const,
        enforced: false,
      },
    });
    f.api.setStatus.mockClear();
    await f.adapter.handlePlanClick({
      assistantId: 10,
      chatId: 20,
      messageId: 501,
      callbackData: answer === "change" ? "__custom__" : `plan:${answer}`,
      ...(answer === "change" ? { customText: "Skip step two." } : {}),
      userId: "owner-1",
    });
    return f;
  }

  it("Go ahead starts the work without touching the mode or announcing a switch", async () => {
    const f = await decided("go");
    expect(f.adapter.host.updateSettings).not.toHaveBeenCalled();
    expect(f.api.reportSessionMode).not.toHaveBeenCalled();
    expect(f.adapter.outbound.sendText).not.toHaveBeenCalled();
    // The work still starts, and the waiting line still clears.
    expect(f.adapter.runAndReply).toHaveBeenCalledTimes(1);
    expect(f.api.setStatus).toHaveBeenCalledWith(10, { statusText: null });
  });

  it("Change the plan never reports a plan mode this chat is not in", async () => {
    const f = await decided("change");
    expect(f.api.reportSessionMode).not.toHaveBeenCalled();
    expect(f.adapter.runAndReply).toHaveBeenCalledTimes(1);
  });

  it("Don't do this settles the card and leaves the mode alone", async () => {
    const f = await decided("no");
    expect(f.adapter.host.updateSettings).not.toHaveBeenCalled();
    expect(f.api.reportSessionMode).not.toHaveBeenCalled();
    expect(f.adapter.runAndReply).not.toHaveBeenCalled();
  });

  it("still flips the mode when the chat IS in plan mode, whatever the door says", async () => {
    // A model already in plan mode that calls `propose_plan` without naming a
    // door gets `decided` by default, so the payload alone is not enough: the
    // host's own persisted setting is the second half of the answer.
    const f = fixture(async () => ({ error: null, replyText: "", turnCompleted: true }));
    f.adapter.runAndReply = vi.fn(async () => {});
    f.adapter.host.planModeChats = vi.fn(() => [20]);
    await f.adapter.planLane.propose({
      assistantId: 10,
      chatId: 20,
      plan: {
        title: "Add retry",
        steps: [{ text: "Add the helper" }],
        door: "decided" as const,
        enforced: false,
      },
    });
    await f.adapter.handlePlanClick({
      assistantId: 10,
      chatId: 20,
      messageId: 501,
      callbackData: "plan:go",
      userId: "owner-1",
    });
    expect(f.adapter.host.updateSettings).toHaveBeenCalledWith(20, {
      mode: "default",
    });
    expect(f.adapter.outbound.sendText).toHaveBeenCalled();
  });
});

describe("a plan card that could not be posted", () => {
  it("never leaves the turn silent", async () => {
    const f = fixture(async (cb) => {
      await cb.onPlanProposal?.({ turnId: "t1", itemId: "p", text: PLAN });
      return { error: null, replyText: "", turnCompleted: true, sawPlanProposal: true };
    });
    f.api.postMessage.mockRejectedValue(new Error("503"));
    await f.adapter.executeAndReply(10, 20, "Plan it", f.reply);
    // `sawPlanProposal` says the runtime RAISED a plan, never that the card
    // reached the chat. Trusting it meant total silence.
    expect(f.reply.sendText).toHaveBeenCalledWith(
      expect.stringContaining("could not be posted"),
    );
  });

  it("keeps the plan in the text when the fallback's post fails", async () => {
    const f = fixture(async () => ({
      error: null,
      replyText: `Here it is.\n\n<proposed_plan>\n${PLAN}\n</proposed_plan>`,
      turnCompleted: true,
    }));
    f.api.postMessage.mockRejectedValue(new Error("503"));
    await f.adapter.executeAndReply(10, 20, "Plan it", f.reply);
    // Stripping the block after a failed post threw the plan away entirely.
    const said = f.reply.sendText.mock.calls.map((c: any[]) => String(c[0])).join("\n");
    expect(said).toContain("Add retry");
    expect(said).toContain("Wrap the call");
  });
});

describe("chats left in plan mode", () => {
  it("are reported at connect, so the chip is there before the owner types", async () => {
    const f = fixture(async () => ({}));
    f.adapter.host.planModeChats = vi.fn(() => [20, 21]);
    // Two agents on this pairing, so the daemon cannot fall back to "the only
    // one it owns": chat 21 belongs to nobody it can name.
    f.adapter.assistantToRoute = new Map([
      [10, "codex"],
      [11, "codex"],
    ]);
    f.adapter.chatToAssistant = new Map([[20, 10]]);
    await f.adapter.reportStoredPlanModes();
    // 21 is skipped rather than reported against a guessed agent.
    expect(f.api.reportSessionMode).toHaveBeenCalledTimes(1);
    expect(f.api.reportSessionMode).toHaveBeenCalledWith(10, 20, {
      mode: "plan",
      enforced: false,
    });
  });
});

describe("the owner's plan level reaches the model", () => {
  /**
   * The level rides the inbound ENVELOPE and is rendered into the turn's
   * framing beside the share guardrail, so the daemon never reads the
   * assistant row: the server decides, the daemon repeats. A level delivered
   * only as a meta field would be a field nobody prompts on.
   */
  async function framingFor(planPolicy?: string) {
    const f = fixture(async () => ({}));
    f.adapter.runAndReply = vi.fn(async () => {});
    f.adapter.noteChatAssistant = vi.fn();
    f.adapter.meetings = { inbound: vi.fn(async () => {}) };
    f.adapter.nativeCommands = { handle: vi.fn(async () => false) };
    f.adapter.commandsSync = { known: () => new Set<string>() };
    await f.adapter.codexDispatch({
      assistantId: 10,
      chatId: 20,
      messageId: 77,
      userId: "owner-1",
      text: "add retry to the uploader",
      attachments: [],
      replyHandle: f.reply,
      ...(planPolicy ? { planPolicy } : {}),
    });
    return JSON.stringify(f.adapter.runAndReply.mock.calls[0]![2]);
  }

  it("puts the level in the turn framing, in words the model can act on", async () => {
    const framing = await framingFor("always");
    expect(framing).toContain("Plan policy");
    expect(framing).toContain("propose_plan");
    expect(framing).toContain("add retry to the uploader");
  });

  it("says nothing about plans when the server sent no level", async () => {
    expect(await framingFor()).not.toContain("Plan policy");
  });

  it("invents nothing from a level it does not know", async () => {
    expect(await framingFor("aggressive")).not.toContain("Plan policy");
  });
});
