/**
 * Where the mission bulletin joins a turn, and where it must NOT.
 *
 * Two orderings carry this. The bulletin is prefixed AFTER
 * missionLane.beginTurn, because beginTurn's prompt feeds titleFromPrompt,
 * which takes the FIRST LINE: prefix before it and every derived mission in a
 * turn that carried a bulletin is titled "HOAI mission update: ...". And the
 * drain happens in executeAndReply, not at compose time, because the composed
 * input is stored as `lastInput` and a note baked in there is re delivered on
 * every /retry and every button click resume.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { Input, UserInput } from "@openai/codex-sdk";

import { CodexAdapter } from "../src/adapter.js";
import { MissionControlLane } from "../src/mission-control.js";
import { normalizeMissionEvent } from "../src/mission-events.js";

function missionControl(steerThrows = true) {
  return new MissionControlLane({
    host: {
      steer: async () => {
        if (steerThrows) throw new Error("no live turn");
      },
    },
    missionLane: { notePaused: vi.fn(), noteResumed: vi.fn(), noteClosed: vi.fn() },
    chatsForAssistant: () => [],
    isOwned: () => true,
  });
}

function fixture(control: MissionControlLane) {
  const adapter = Object.create(CodexAdapter.prototype) as any;
  const runTurn = vi.fn(async () => ({
    error: null,
    replyText: "done",
    turnCompleted: true,
  }));
  const beginTurn = vi.fn(() => 1);
  Object.assign(adapter, {
    turnControllers: new Map(),
    lastInput: new Map<number, Input>(),
    ownerId: "owner-1",
    missionLane: { beginTurn, finalizeTurn: vi.fn(async () => {}) },
    stepsLane: { handlePlan: vi.fn(async () => {}), finalizeTurn: vi.fn(async () => {}) },
    missionControl: control,
    toolProgress: { sendToolStart: vi.fn(async () => {}) },
    outbound: { sendAgentError: vi.fn(async () => {}) },
    api: {},
    tools: { handleRequest: vi.fn(async () => ({})) },
    host: { runTurn },
  });
  const reply = {
    sendTyping: vi.fn(async () => {}),
    finalizeTurn: vi.fn(async () => {}),
    sendText: vi.fn(async () => {}),
  };
  return { adapter, reply, runTurn, beginTurn };
}

function pausedFrame(chatId: number) {
  return normalizeMissionEvent("mission_paused", {
    event_type: "mission_paused",
    user_id: "owner-1",
    assistant_id: 10,
    chat_id: chatId,
    mission: {
      id: 91,
      assistantId: 10,
      title: "Ship the strip",
      status: "paused",
      origin: "derived",
      pausedReason: "waiting on design",
      updatedAt: "2026-09-20T12:00:00.000Z",
    },
    timestamp: `2026-09-20T12:00:0${chatId % 9}.000Z`,
  })!;
}

describe("the adapter's mission bulletin wiring", () => {
  it("gives beginTurn the ORIGINAL prompt and runTurn the PREFIXED input", async () => {
    const control = missionControl();
    const { adapter, reply, runTurn, beginTurn } = fixture(control);
    await control.handle(pausedFrame(20));

    await adapter.executeAndReply(10, 20, "Fix the login bug\nsecond line", reply);

    expect(beginTurn).toHaveBeenCalledWith({
      assistantId: 10,
      chatId: 20,
      prompt: "Fix the login bug\nsecond line",
    });
    const sent = runTurn.mock.calls[0]![1] as string;
    expect(sent.startsWith("HOAI mission update:")).toBe(true);
    expect(sent).toContain("paused the mission");
    expect(sent.endsWith("Fix the login bug\nsecond line")).toBe(true);
  });

  it("hands runTurn the input unchanged BY IDENTITY when nothing is queued", async () => {
    const { adapter, reply, runTurn } = fixture(missionControl());
    const input: Input = "Plain work";
    await adapter.executeAndReply(10, 20, input, reply);
    expect(runTurn.mock.calls[0]![1]).toBe(input);
  });

  it("consumes the bulletin exactly once", async () => {
    const control = missionControl();
    const { adapter, reply, runTurn } = fixture(control);
    await control.handle(pausedFrame(20));

    await adapter.executeAndReply(10, 20, "First", reply);
    await adapter.executeAndReply(10, 20, "Second", reply);

    expect(String(runTurn.mock.calls[0]![1])).toContain("HOAI mission update:");
    expect(runTurn.mock.calls[1]![1]).toBe("Second");
  });

  it("leaves lastInput clean, so a /retry replay never re delivers a note", async () => {
    const control = missionControl();
    const { adapter, reply, runTurn } = fixture(control);
    const composed: Input = "HOAI event: assistant_id=10\n\nMessage:\nfix it";
    adapter.lastInput.set(20, composed);
    await control.handle(pausedFrame(20));

    await adapter.executeAndReply(10, 20, composed, reply);
    expect(String(runTurn.mock.calls[0]![1])).toContain("HOAI mission update:");
    // The stored input is what /retry replays. It must be the clean one.
    expect(adapter.lastInput.get(20)).toBe(composed);

    await adapter.executeAndReply(10, 20, adapter.lastInput.get(20), reply);
    expect(runTurn.mock.calls[1]![1]).toBe(composed);
  });

  it("keeps the image parts of a turn that carries a bulletin", async () => {
    const control = missionControl();
    const { adapter, reply, runTurn } = fixture(control);
    await control.handle(pausedFrame(20));
    const input: UserInput[] = [
      { type: "text", text: "look" },
      { type: "local_image", path: "/tmp/a.png" },
    ];

    await adapter.executeAndReply(10, 20, input, reply);

    const sent = runTurn.mock.calls[0]![1] as UserInput[];
    expect(sent).toHaveLength(3);
    expect(sent[0]!.type).toBe("text");
    expect(String((sent[0] as { text: string }).text)).toContain("HOAI mission update:");
    expect(sent[2]).toEqual({ type: "local_image", path: "/tmp/a.png" });
  });
});

describe("which assistants a mission frame is accepted for", () => {
  function owner(fields: Record<string, unknown>) {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    Object.assign(adapter, { assistantToRoute: new Map<number, string>(), ...fields });
    return (assistantId: number): boolean => adapter.ownsAssistantForMission(assistantId);
  }

  it("accepts a frame before the first scope load, because we do not yet KNOW what we own", () => {
    // The same exception assistantForChat makes: an empty assistantToRoute
    // before identity means unloaded, not empty, and a frame the backend
    // routed to this pairing is better evidence than an unloaded map.
    expect(owner({ identityReady: false })(7)).toBe(true);
  });

  it("refuses a frame for an assistant this daemon does not own once the scope is in", () => {
    const isOwned = owner({
      identityReady: true,
      assistantToRoute: new Map([[7, "codex"]]),
    });
    expect(isOwned(7)).toBe(true);
    expect(isOwned(8)).toBe(false);
  });
});

/**
 * The typed mission tools must reach the control lane's self write stamp.
 *
 * It is a constructor argument, so nothing else in the suite can notice it
 * going missing: an unstamped tool write comes back from a backend older than
 * stage 5 with no `cleared_by`, is read as the owner ending the mission, and
 * is narrated and steered into the very turn that made it. This reads the
 * wiring itself, the way the Claude plugin pins its own.
 */
describe("the mission self write wiring of the typed tools", () => {
  const source = readFileSync(
    new URL("../src/adapter.ts", import.meta.url),
    "utf8",
  );

  it("hands HoaiTools both halves of the stamp", () => {
    const start = source.indexOf("new HoaiTools(");
    expect(start).toBeGreaterThan(0);
    const construction = source.slice(start, source.indexOf("});", start));
    expect(construction).toContain("missionControl.noteSelfWrite");
    expect(construction).toContain("missionControl.dropSelfWrite");
  });
});
