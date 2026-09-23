import { describe, expect, it, vi } from "vitest";
import { HOAI_TOOLS, HoaiTools, validateToolInput } from "../src/hoai-tools.js";
import { MissionControlLane } from "../src/mission-control.js";
import { normalizeMissionEvent } from "../src/mission-events.js";
const context = () => ({
  assistantId: 9,
  chatId: 17,
  userId: "owner",
  signal: new AbortController().signal,
});
describe("propose_plan", () => {
  /**
   * The one tool that asks the owner a question and does NOT block.
   *
   * The plan wait has no end: the answer arrives as a click that starts the
   * next turn. So this tool returns at once, and the turn ends. It is also the
   * reason `propose_plan` must stay out of OWNER_BLOCKING_TOOLS (pinned in
   * test/codex-host.spec.ts): a tool that parked the watchdog on an answer that
   * may come tomorrow would hold a 30 minute budget open forever.
   */
  it("posts through the lane and returns pending at once", async () => {
    const propose = vi.fn(async () => ({ messageId: 501 }));
    const enforcedIn = vi.fn(() => false);
    const tools = new HoaiTools(
      {} as any,
      () => "canon",
      undefined,
      { propose, enforcedIn } as any,
    );
    const result: any = await tools.handleRequest(
      "item/tool/call",
      {
        tool: "propose_plan",
        arguments: {
          chat_id: "17",
          title: "Add retry with backoff",
          summary: "The uploader retries nothing.",
          steps: [
            { text: "Add the helper", file: "src/upload.ts" },
            { text: "Wrap the call", check: "the new test fails without it" },
          ],
          files: ["src/upload.ts"],
          check: "The new unit test fails without the helper.",
        },
      },
      context(),
    );
    expect(result.success).toBe(true);
    expect(result.contentItems[0].text).toContain("pending");
    expect(result.contentItems[0].text).toContain("501");
    expect(propose).toHaveBeenCalledWith({
      assistantId: 9,
      chatId: 17,
      plan: expect.objectContaining({
        title: "Add retry with backoff",
        summary: "The uploader retries nothing.",
        files: ["src/upload.ts"],
        check: "The new unit test fails without the helper.",
        // The DEFAULT door is the agent deciding for itself: a tool call is
        // not the owner typing /plan, and it is not plan mode either.
        door: "decided",
        // ASKED OF THE LANE, per chat, and false here because this chat is
        // not holding the read only sandbox. It used to be the constant
        // `CODEX_PLAN_MODE_ENFORCED`, which could not tell a plan proposed
        // under `/plan` apart from one the model decided on mid coding.
        enforced: false,
      }),
    });
    expect(enforcedIn).toHaveBeenCalledWith(17);
    expect(propose.mock.calls[0]![0].plan.steps).toEqual([
      { text: "Add the helper", file: "src/upload.ts" },
      { text: "Wrap the call", check: "the new test fails without it" },
    ]);
    // The lane owns the plan's identity, never the model.
    expect(propose.mock.calls[0]![0].plan).not.toHaveProperty("planId");
    expect(propose.mock.calls[0]![0].plan).not.toHaveProperty("revision");
  });

  it("stamps the card with the LOCK THIS CHAT HAS, not a channel constant", () => {
    // The whole point of retiring `CODEX_PLAN_MODE_ENFORCED`. One daemon
    // plans under the read only sandbox in chat 17 and, at the same moment,
    // answers a plan it decided on inside the ordinary coding chat 18. A
    // constant gets one of those two wrong whichever value it takes, and the
    // wrong one is a sentence the app puts in front of the owner.
    return (async () => {
      const propose = vi.fn(async () => ({ messageId: 504 }));
      const enforcedIn = vi.fn((chatId: number) => chatId === 17);
      const tools = new HoaiTools(
        {} as any,
        () => "canon",
        undefined,
        { propose, enforcedIn } as any,
      );
      const call = (chatId: number): Promise<any> =>
        tools.handleRequest(
          "item/tool/call",
          {
            tool: "propose_plan",
            arguments: {
              chat_id: String(chatId),
              title: "Add retry",
              steps: [{ text: "Add the helper" }],
            },
          },
          { ...context(), chatId },
        );
      expect((await call(17)).success).toBe(true);
      expect((await call(18)).success).toBe(true);
      expect(propose.mock.calls[0]![0].plan.enforced).toBe(true);
      expect(propose.mock.calls[1]![0].plan.enforced).toBe(false);
    })();
  });

  it("carries a revision's supersedes, note and per step tags", async () => {
    const propose = vi.fn(async () => ({ messageId: 502 }));
    const enforcedIn = vi.fn(() => false);
    const tools = new HoaiTools(
      {} as any,
      () => "canon",
      undefined,
      { propose, enforcedIn } as any,
    );
    await tools.handleRequest(
      "item/tool/call",
      {
        tool: "propose_plan",
        arguments: {
          chat_id: "17",
          title: "Add retry, revised",
          door: "typed",
          supersedes: 501,
          note: "Dropped the test rewrite.",
          steps: [
            { text: "Add the helper", tag: "unchanged" },
            { text: "Rewrite the tests", tag: "dropped" },
          ],
        },
      },
      context(),
    );
    expect(propose.mock.calls[0]![0].plan).toMatchObject({
      door: "typed",
      supersedes: 501,
      note: "Dropped the test rewrite.",
    });
    expect(propose.mock.calls[0]![0].plan.steps[1]!.tag).toBe("dropped");
  });

  it("refuses a plan with no steps at the schema, before anything is posted", async () => {
    const propose = vi.fn(async () => ({ messageId: 503 }));
    const enforcedIn = vi.fn(() => false);
    const tools = new HoaiTools(
      {} as any,
      () => "canon",
      undefined,
      { propose, enforcedIn } as any,
    );
    const result: any = await tools.handleRequest(
      "item/tool/call",
      { tool: "propose_plan", arguments: { chat_id: "17", title: "No steps" } },
      context(),
    );
    expect(result.success).toBe(false);
    expect(propose).not.toHaveBeenCalled();
  });

  it("says so honestly on a connection that has no plan lane", async () => {
    const tools = new HoaiTools({} as any, () => "canon");
    const result: any = await tools.handleRequest(
      "item/tool/call",
      {
        tool: "propose_plan",
        arguments: {
          chat_id: "17",
          title: "Add retry",
          steps: [{ text: "Add the helper" }],
        },
      },
      context(),
    );
    expect(result.success).toBe(false);
    expect(result.contentItems[0].text).toMatch(/not available/i);
  });
});

describe("reply buttons carry a style", () => {
  /**
   * The canon has promised an optional `style` on reply buttons since its own
   * line 112, and neither plugin sent one: only the approval builders did. A
   * plan card posted as three plain chips renders three identical neutral
   * buttons, which is the whole reason the plan chips are CODES the app
   * relabels and tints.
   */
  it("passes the tier through to the option, and omits it when unset", async () => {
    const agentRequest = vi.fn(async () => ({ id: 1 }));
    const tools = new HoaiTools({ agentRequest } as any, () => "canon");
    await tools.handleRequest(
      "item/tool/call",
      {
        tool: "reply",
        arguments: {
          chat_id: "17",
          text: "Ship it?",
          buttons: [
            { label: "Ship", value: "ship", style: "success" },
            { label: "Wait", value: "wait" },
          ],
        },
      },
      context(),
    );
    const body = agentRequest.mock.calls[0]![3] as any;
    expect(body.options[0]).toMatchObject({ text: "Ship", style: "success" });
    expect(body.options[1]).not.toHaveProperty("style");
  });
});

describe("typed HOAI boundary", () => {
  it("accepts a native free-text form through the real dynamic tool schema", async () => {
    const tools = new HoaiTools({} as any, () => "canon");
    const ask = vi
      .spyOn(tools.interactions, "ask")
      .mockResolvedValue([{ question: "Which word?", free_text: "TOPAZ" }]);
    const questions = [
      { text: "Which word?", options: [], allow_free_text: true },
    ];
    const result: any = await tools.handleRequest(
      "item/tool/call",
      { tool: "ask_user_input", arguments: { chat_id: "17", questions } },
      context(),
    );
    expect(result.success).toBe(true);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 17 }),
      questions,
      undefined,
    );
    expect(result.contentItems[0].text).toContain("TOPAZ");
  });
  it("puts the turn's chat on a self reported mission, so it belongs to that chat", async () => {
    // A mission belongs to ONE chat now. The agent is never asked which one:
    // the host already knows it from the turn that produced the tool call.
    const agentRequest = vi.fn(async () => ({ ok: true, mission: { id: 5 } }));
    const tools = new HoaiTools({ agentRequest } as any, () => "canon");
    const result: any = await tools.handleRequest(
      "item/tool/call",
      {
        tool: "create_mission",
        arguments: {
          title: "Ship the strip",
          mini_goals: [
            { name: "Draw it", done_when: "the tag is filled" },
            { name: "Test it", done_when: "the render test passes" },
          ],
        },
      },
      context(),
    );
    expect(result.success).toBe(true);
    expect(agentRequest).toHaveBeenCalledWith(
      "POST",
      "assistants/9/missions",
      9,
      expect.objectContaining({ chatId: 17, title: "Ship the strip" }),
    );
  });

  it("omits the chat rather than sending a null one when the turn names none", async () => {
    const agentRequest = vi.fn(async () => ({ ok: true, mission: { id: 5 } }));
    const tools = new HoaiTools({ agentRequest } as any, () => "canon");
    await tools.handleRequest(
      "item/tool/call",
      {
        tool: "create_mission",
        arguments: {
          title: "Ship the strip",
          mini_goals: [
            { name: "Draw it", done_when: "the tag is filled" },
            { name: "Test it", done_when: "the render test passes" },
          ],
        },
      },
      { ...context(), chatId: 0 } as never,
    );
    const body = agentRequest.mock.calls[0]![3] as Record<string, unknown>;
    expect(body).not.toHaveProperty("chatId");
  });

  it("preserves useful Boards refusal bodies without request credentials", async () => {
    const api = {
      agentRequest: vi.fn(async () => {
        throw Object.assign(new Error("Request failed with status code 400"), {
          response: {
            status: 400,
            data: {
              message: "Board ledger signing key is not configured",
              operation: "boards.ledger_unconfigured",
            },
          },
          config: { headers: { secret: "NEVER_SHOW" } },
        });
      }),
    };
    const tools = new HoaiTools(api as any, () => "canon");
    const result: any = await tools.handleRequest(
      "item/tool/call",
      { tool: "boards_create", arguments: { name: "QA" } },
      context(),
    );
    expect(result.success).toBe(false);
    expect(result.contentItems[0].text).toContain(
      "Board ledger signing key is not configured",
    );
    expect(result.contentItems[0].text).toContain("boards.ledger_unconfigured");
    expect(result.contentItems[0].text).not.toContain("NEVER_SHOW");
  });
  it("does not infer group authorship from the chat carrier", async () => {
    const api = {
      agentRequest: vi.fn(),
      getMessages: vi.fn(async () => [
        { message: { id: 5, sender: "assistant", assistantId: 9 } },
      ]),
    };
    const tools = new HoaiTools(api as any, () => "canon");
    await expect(
      tools.call(
        "edit_message",
        { message_id: "5", text: "replacement" },
        { ...context(), chatKind: "room" },
      ),
    ).rejects.toThrow(/Only this agent/);
    expect(api.agentRequest).not.toHaveBeenCalled();
  });
  it("never lets model arguments select another assistant or chat", async () => {
    const api = { agentRequest: vi.fn(async () => ({ id: 1 })) };
    const tools = new HoaiTools(api as any, () => "canon");
    await expect(
      tools.call("reply", { chat_id: "18", text: "wrong chat" }, context()),
    ).rejects.toThrow(/current event/);
    await tools.call(
      "reply",
      { chat_id: "17", assistant_id: 777, text: "correct chat" },
      context(),
    );
    expect(api.agentRequest).toHaveBeenCalledWith(
      "POST",
      "messages",
      9,
      expect.objectContaining({ assistantId: 9, chatId: 17 }),
    );
  });
  it("routes ordinary replies through the meeting floor check", async () => {
    const api = { agentRequest: vi.fn(async () => ({ id: 1 })) };
    const tools = new HoaiTools(api as any, () => "canon");
    await tools.call(
      "reply",
      { chat_id: "17", text: "Contribution" },
      { ...context(), meetingId: 3 },
    );
    expect(api.agentRequest).toHaveBeenCalledWith(
      "POST",
      "meetings/3/messages",
      9,
      { text: "Contribution", asAssistantId: 9 },
    );
  });
  it("returns real backend refusal as a failed tool result", async () => {
    const api = {
      agentRequest: vi.fn(async () => {
        throw {
          response: { status: 403, data: { message: "requires_introduction" } },
          config: { headers: { secret: "never display" } },
        };
      }),
    };
    const tools = new HoaiTools(api as any, () => "canon");
    const result: any = await tools.handleRequest(
      "item/tool/call",
      { tool: "list_peers", arguments: {} },
      context(),
    );
    expect(result.success).toBe(false);
    expect(result.contentItems[0].text).toBe("HTTP 403: requires_introduction");
  });
  it("supports native component union schemas while rejecting invalid values", () => {
    const schema = { type: ["string", "object"] };
    expect(() => validateToolInput({ title: "Card" }, schema)).not.toThrow();
    expect(() => validateToolInput("Card", schema)).not.toThrow();
    expect(() => validateToolInput(5, schema)).toThrow();
    expect(() => validateToolInput(1.2, { type: "integer" })).toThrow();
  });
  it("blocks edits to a person's message", async () => {
    const api = {
      agentRequest: vi.fn(),
      getMessages: vi.fn(async () => [{ message: { id: 5, sender: "user" } }]),
    };
    const tools = new HoaiTools(api as any, () => "canon");
    await expect(
      tools.call(
        "edit_message",
        { message_id: "5", text: "replacement" },
        context(),
      ),
    ).rejects.toThrow(/Only this agent/);
    expect(api.agentRequest).not.toHaveBeenCalled();
  });
});

it("maps the Codex call tool fields to the shared outbound-call API without changing identity", async () => {
  const api = { agentRequest: vi.fn(async () => ({ callId: "c1", status: "ringing" })) };
  const tools = new HoaiTools(api as any, () => "canon");
  const result: any = await tools.handleRequest("item/tool/call", { tool: "call_owner", arguments: { reason: "Build ready.", context: "Build 42 passed.", opening_message: "Your build is ready." } }, context());
  expect(result.success).toBe(true);
  expect(api.agentRequest).toHaveBeenCalledWith("POST", "voice/outbound-call", 9, { assistantId: 9, chatId: 17, reason: "Build ready.", context: "Build 42 passed.", openingMessage: "Your build is ready." });
});
/**
 * The two mission tools that TARGET a mission: tick_mini_goal and
 * complete_mission.
 *
 * Two things have to be true of every write they make. It has to land on the
 * mission of THIS chat, because a mission belongs to one chat and the agent
 * is never asked which one, so an omitted mission_id resolved without the
 * chat would tick the agent's main chat card while it works another chat.
 * And it has to be STAMPED as this daemon's own write before it goes out: a
 * backend older than mission stage 5 sends no `cleared_by`, so the completion
 * the agent's own last tick triggers comes back unattributed and, unstamped,
 * is read as the owner ending the mission, told to the model as a falsehood
 * and steered into the very turn that ticked it.
 */
describe("the mission tools, per chat and stamped as our own", () => {
  function missionApi(
    responses: {
      active?: unknown;
      tick?: unknown;
      complete?: unknown;
    } = {},
  ) {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const agentRequest = vi.fn(
      async (method: string, path: string, _assistantId: number, body?: unknown) => {
        calls.push({ method, path, body });
        if (method === "GET") return responses.active ?? { mission: { id: 55 } };
        if (path.endsWith("/tick"))
          return (
            responses.tick ?? { ok: true, mission: { id: 55, status: "active" } }
          );
        return (
          responses.complete ?? { ok: true, mission: { id: 55, status: "completed" } }
        );
      },
    );
    return { agentRequest, calls };
  }

  function stamps() {
    const started: number[] = [];
    const spent: number[] = [];
    return {
      started,
      spent,
      sink: {
        starting: (missionId: number) => started.push(missionId),
        leftOpen: (missionId: number) => spent.push(missionId),
      },
    };
  }

  it("asks for THIS chat's open mission when no mission_id is passed", async () => {
    const api = missionApi();
    const tools = new HoaiTools(api as any, () => "canon");
    await tools.call("tick_mini_goal", { goal_id: 2, evidence: "URL returned 200" }, context());
    expect(api.calls[0]).toMatchObject({
      method: "GET",
      path: "assistants/9/missions/active?chatId=17",
    });
    expect(api.calls[1]).toMatchObject({
      method: "PATCH",
      path: "assistants/9/missions/55/tick",
      body: { goalId: 2, evidence: "URL returned 200" },
    });
  });

  it("asks for this chat's open mission on complete_mission too", async () => {
    const api = missionApi();
    const tools = new HoaiTools(api as any, () => "canon");
    await tools.call("complete_mission", { summary: "Shipped." }, context());
    expect(api.calls[0]!.path).toBe("assistants/9/missions/active?chatId=17");
    expect(api.calls[1]!.path).toBe("assistants/9/missions/55/complete");
  });

  it("makes no active read at all when the agent names the mission", async () => {
    const api = missionApi();
    const tools = new HoaiTools(api as any, () => "canon");
    await tools.call("tick_mini_goal", { goal_id: 1, mission_id: 77 }, context());
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({
      method: "PATCH",
      path: "assistants/9/missions/77/tick",
    });
  });

  it("falls back to the bare read when the turn names no chat", async () => {
    // Which is what a request made before the chat existed meant, and what
    // the backend still resolves to the agent's main chat.
    const api = missionApi();
    const tools = new HoaiTools(api as any, () => "canon");
    await tools.call(
      "tick_mini_goal",
      { goal_id: 1 },
      { ...context(), chatId: 0 } as never,
    );
    expect(api.calls[0]!.path).toBe("assistants/9/missions/active");
  });

  it("stamps the mission BEFORE the write goes out, so a racing frame is ours", async () => {
    const api = missionApi();
    const { started, sink } = stamps();
    const stampedAfter: number[] = [];
    const tools = new HoaiTools({
      agentRequest: async (...args: [string, string, number, unknown?]) => {
        const out = await api.agentRequest(...args);
        return out;
      },
    } as any, () => "canon", {
      starting: (missionId: number) => {
        sink.starting(missionId);
        stampedAfter.push(api.calls.length);
      },
      leftOpen: sink.leftOpen,
    });
    await tools.call("tick_mini_goal", { goal_id: 3 }, context());
    expect(started).toEqual([55]);
    // One request had been made when the stamp was taken: the active read.
    // The tick itself had not gone out yet, which is the whole point.
    expect(stampedAfter).toEqual([1]);
  });

  it("stamps a complete_mission write as well", async () => {
    const api = missionApi();
    const { started, sink } = stamps();
    const tools = new HoaiTools(api as any, () => "canon", sink);
    await tools.call("complete_mission", { mission_id: 12 }, context());
    expect(started).toEqual([12]);
  });

  it("spends the stamp of a tick that closed nothing", async () => {
    // Only the LAST tick completes a mission. Every other tick leaves a
    // stamp with no frame coming, and a stamp nobody consumes would be eaten
    // by the owner's next Set aside of that mission.
    const api = missionApi({ tick: { ok: true, mission: { id: 55, status: "active" } } });
    const { spent, sink } = stamps();
    const tools = new HoaiTools(api as any, () => "canon", sink);
    await tools.call("tick_mini_goal", { goal_id: 1 }, context());
    expect(spent).toEqual([55]);
  });

  it("keeps the stamp of a tick that completed the mission", async () => {
    const api = missionApi({
      tick: { ok: true, mission: { id: 55, status: "completed" } },
    });
    const { spent, sink } = stamps();
    const tools = new HoaiTools(api as any, () => "canon", sink);
    await tools.call("tick_mini_goal", { goal_id: 4 }, context());
    expect(spent).toEqual([]);
  });
});

/**
 * End to end, through the real control lane: the tool writes, the frame comes
 * back with no `cleared_by` (an older backend), and the model is told the
 * truth about who did it.
 */
describe("a tool mission write, told back to the model", () => {
  function frame(type: string, missionId: number) {
    return normalizeMissionEvent(type, {
      event_type: type,
      user_id: "owner",
      assistant_id: 9,
      chat_id: 17,
      mission: {
        id: missionId,
        assistantId: 9,
        chatId: 17,
        title: "Ship the strip",
        status: type === "mission_completed" ? "completed" : "abandoned",
        origin: "self_report",
        updatedAt: "2026-09-20T12:00:00.000Z",
      },
      timestamp: "2026-09-20T12:00:01.000Z",
    })!;
  }

  function wired(tickResponse: unknown) {
    const steer = vi.fn(async (_chatId: number, _text: string) => {});
    const control = new MissionControlLane({
      host: { steer },
      missionLane: {
        notePaused: vi.fn(),
        noteResumed: vi.fn(),
        noteClosed: vi.fn(),
      },
      chatsForAssistant: () => [17],
      isOwned: () => true,
    });
    const agentRequest = vi.fn(async (method: string, path: string) => {
      if (method === "GET") return { mission: { id: 55 } };
      if (path.endsWith("/tick")) return tickResponse;
      return { ok: true, mission: { id: 55, status: "completed" } };
    });
    const tools = new HoaiTools({ agentRequest } as any, () => "canon", {
      starting: (missionId: number) => control.noteSelfWrite(missionId),
      leftOpen: (missionId: number) => control.dropSelfWrite(missionId),
    });
    return {
      control,
      steer,
      tools,
      told: () => {
        const out = control.applyBulletin(17, "PROMPT");
        return out === "PROMPT" ? "" : String(out).replace(/\n\nPROMPT$/, "");
      },
    };
  }

  it("never narrates or steers the completion the agent's own last tick triggered", async () => {
    const { tools, control, steer, told } = wired({
      ok: true,
      mission: { id: 55, status: "completed" },
    });
    await tools.call("tick_mini_goal", { goal_id: 4, evidence: "all green" }, context());
    await control.handle(frame("mission_completed", 55));
    expect(steer).not.toHaveBeenCalled();
    expect(told()).toBe("");
  });

  it("still tells the model when the owner sets that mission aside after a tick", async () => {
    // The tick closed nothing, so its stamp answers for nothing: the owner's
    // Set aside reaches the model rather than being swallowed as our write.
    const { tools, control, steer, told } = wired({
      ok: true,
      mission: { id: 55, status: "active" },
    });
    await tools.call("tick_mini_goal", { goal_id: 1, evidence: "done" }, context());
    await control.handle(frame("mission_abandoned", 55));
    expect(steer).toHaveBeenCalledTimes(1);
    expect(String(steer.mock.calls[0]![1])).toContain(
      'set the mission "Ship the strip" aside',
    );
    // The steer landed on the live turn, so the queued note was consumed.
    expect(told()).toBe("");
  });
});

/**
 * What the model is told about missions in the tool catalogue itself. A
 * mission belongs to one chat now, so the old "one active mission per agent"
 * line would have the model believe a mission it starts in one chat ends the
 * mission in another.
 */
describe("the mission tool descriptions", () => {
  const describeOf = (name: string) =>
    HOAI_TOOLS.find((tool) => tool.name === name)!.description;

  it("says one open mission per chat, not one per agent", () => {
    expect(describeOf("create_mission")).toContain("One open mission per CHAT");
    expect(describeOf("create_mission")).not.toContain("active mission per agent");
  });

  it("tells the agent the host stamps the chat, so it never sends one", () => {
    expect(describeOf("create_mission")).toContain("stamps the chat of this turn");
  });

  it("points tick and complete at this chat's open mission", () => {
    expect(describeOf("tick_mini_goal")).toContain("Targets this chat's open mission");
    expect(describeOf("complete_mission")).toContain("Targets this chat's open mission");
  });
});

describe("the shared tool declarations", () => {
  /**
   * The Claude plugin declares these schemas inline in server.ts and this repo
   * re-declares the same set in src/hoai-shared/tool-declarations.ts. A tool
   * added to one and not the other means the two channels advertise different
   * capabilities to the same owner, so the shape is pinned here rather than
   * trusted to a reviewer noticing.
   */
  const propose = HOAI_TOOLS.find((t) => t.name === "propose_plan");
  const reply = HOAI_TOOLS.find((t) => t.name === "reply");

  it("declares propose_plan with the card's fields and nothing the model must guess", () => {
    expect(propose).toBeDefined();
    const schema = propose!.inputSchema as any;
    expect(schema.required).toEqual(["chat_id", "title", "steps"]);
    expect(Object.keys(schema.properties)).toEqual([
      "chat_id",
      "title",
      "summary",
      "steps",
      "files",
      "check",
      "door",
      "supersedes",
      "note",
    ]);
    expect(schema.properties.steps.maxItems).toBe(30);
    expect(schema.properties.files.maxItems).toBe(30);
    expect(schema.properties.steps.items.required).toEqual(["text"]);
    expect(schema.properties.steps.items.properties.tag.enum).toEqual([
      "unchanged",
      "changed",
      "dropped",
    ]);
    expect(schema.properties.door.enum).toEqual(["typed", "decided", "mode"]);
  });

  it("tells the model the tool does not block, and which chats the wait is real in", () => {
    // Both are load bearing. A model that waits on this tool wedges its turn;
    // a model told the wait is always enforced would believe a lock it does
    // not have in a coding chat, and one told it NEVER is would be surprised
    // by a denied write inside plan mode. The answer is per chat and the
    // description now says which is which (see src/plan-mode.ts).
    expect(propose!.description).toMatch(/RETURNS IMMEDIATELY/);
    expect(propose!.description).toMatch(/end your turn/i);
    expect(propose!.description).toMatch(/WHETHER THAT IS ENFORCED DEPENDS ON THE CHAT/);
    expect(propose!.description).toMatch(/holds your files read only/);
    expect(propose!.description).toMatch(
      /ordinary coding chat nothing enforces the wait at all/,
    );
    // And it never claims the blanket lock the probe refused.
    expect(propose!.description).not.toMatch(/plan mode prevents/i);
  });

  it("offers an optional style on reply buttons, as the canon has promised", () => {
    const button = (reply!.inputSchema as any).properties.buttons.items;
    expect(button.properties.style.enum).toEqual([
      "default",
      "success",
      "danger",
      "primary",
    ]);
    // Optional: a daemon that sends no tier is the normal case.
    expect(button.required).toEqual(["label", "value"]);
  });
});
