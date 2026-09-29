/**
 * The plan restart sweep is WIRED, not merely written.
 *
 * `sweepMissedPlanAnswers` is covered as a function in plan-lane.spec.ts, and
 * the approval lane's own sweep needed a case exactly like this one because
 * deleting its single line in `start()` left every other file green. The same
 * hole is here and the stake is higher: a plan answer arrives on one wire, the
 * WS click, and nothing replays it, so a daemon that never calls this leaves
 * the owner's Go ahead unheard, the "Waiting for your go ahead" line standing
 * for its whole day, and the chat read only because `/plan` took its sandbox.
 *
 * MUTATION PROOF, run against this tree: deleting `.then(() =>
 * this.sweepMissedPlanAnswers())` from `start()` in src/adapter.ts turns both
 * cases red; restoring it turns them green.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexAdapter } from "../src/adapter.js";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.CODEX_BGOS_HOME;
  home = mkdtempSync(join(tmpdir(), "codex-plan-sweep-"));
  process.env.CODEX_BGOS_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_BGOS_HOME;
  else process.env.CODEX_BGOS_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

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

/**
 * The real `start()` against a daemon made of stubs. Identity SUCCEEDS here,
 * unlike the approval sweep's fixture, because the plan sweep is chained
 * behind the connect time mode report and both live inside that branch.
 */
function fixture(row: Record<string, unknown>) {
  const adapter = Object.create(CodexAdapter.prototype) as any;
  const agentRequest = vi.fn(async () => ({}));
  const getMessages = vi.fn(async () => [{ message: row }]);
  const handlePlanClick = vi.fn(async () => {});
  const adopt = vi.fn(() => true);
  Object.assign(adapter, {
    started: false,
    fatalLatched: true,
    ownerId: "owner-1",
    host: { preflight: vi.fn(async () => {}) },
    ws: {
      on: vi.fn(),
      connect: vi.fn(async () => {}),
      triggerBackfill: vi.fn(async () => {}),
      connectedSince: null,
    },
    heartbeat: { start: vi.fn(), recordInbound: vi.fn() },
    outbound: {},
    toolProgress: {},
    api: { getMessages, agentRequest },
    planLane: { adopt },
    loadServedCapabilities: vi.fn(async () => {}),
    refreshIdentity: vi.fn(async () => true),
    startPollLoop: vi.fn(),
    reportStoredPlanModes: vi.fn(async () => {}),
    handlePlanClick,
    sweepOrphanedApprovals: vi.fn(async () => {}),
  });
  return { adapter, agentRequest, getMessages, handlePlanClick, adopt };
}

function seed(): void {
  writeFileSync(
    join(home, "bgos_pending_plans.json"),
    JSON.stringify([
      { id: 501, chatId: 20, assistantId: 10, userId: "owner-1", at: Date.now() },
    ]),
  );
}

describe("the daemon reads its plan cards back at start", () => {
  it("delivers an answer the owner gave while this daemon was down", async () => {
    seed();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { adapter, agentRequest, getMessages, handlePlanClick } = fixture(CARD);

    await adapter.start();
    // The sweep is chained behind the mode report and neither is awaited: a
    // chip is worth a request, never a slower boot. So wait for the effect.
    await vi.waitFor(() =>
      expect(handlePlanClick).toHaveBeenCalledWith(
        expect.objectContaining({
          assistantId: 10,
          chatId: 20,
          messageId: 501,
          callbackData: "plan:go",
        }),
      ),
    );
    // Read as the id the poll reads as, then retired as the assistant.
    expect(getMessages).toHaveBeenCalledWith(20, "owner-1", {
      beforeId: 502,
      limit: 1,
    });
    expect(agentRequest).toHaveBeenCalledWith("PATCH", "messages/501", 10, {
      options: [],
    });

    clearInterval(adapter.spoolTimer);
  });

  it("adopts a card nobody answered, and starts no turn for it", async () => {
    seed();
    const { adapter, handlePlanClick, adopt } = fixture({
      ...CARD,
      answeredAt: null,
      answerPayload: null,
    });

    await adapter.start();
    await vi.waitFor(() =>
      expect(adopt).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 20, messageId: 501, assistantId: 10 }),
      ),
    );
    expect(handlePlanClick).not.toHaveBeenCalled();

    clearInterval(adapter.spoolTimer);
  });
});
