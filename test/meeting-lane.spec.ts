import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeetingLane } from "../src/meeting-lane.js";
let home: string;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  home = mkdtempSync(join(tmpdir(), "hoai-meeting-"));
  const room = {
    id: 3,
    chatId: 17,
    status: "open",
    currentSpeakerId: 9,
    turnStartedAt: "now",
    participants: [{ assistantId: 9 }],
  };
  const api = {
    agentRequest: vi.fn(async (_method: string, path: string) =>
      path.endsWith("transcript")
        ? {
            messages: [{ message: { id: 1, sender: "user", text: "Discuss" } }],
          }
        : room,
    ),
  };
  const host = {
    runTurn: vi.fn(async () => ({
      replyText: "Contribution",
      finalAgentMessageText: "Contribution",
      error: null,
    })),
  };
  const tools = {
    call: vi.fn(async () => ({ id: 2 })),
    handleRequest: vi.fn(),
  };
  const deps = {
    api: api as any,
    host: host as any,
    tools: tools as any,
    owner: () => "owner",
    owned: () => [9],
    stateFile: join(home, "turns.json"),
    log: vi.fn(),
    noteChat: vi.fn(),
  };
  return { deps, room, host, tools, lane: new MeetingLane(deps) };
}
describe("meeting floor and resync", () => {
  // A meeting turn can be the first thread a chat ever gets, so the lane is
  // what tells the adapter whose chat it is. Without it the Agent Browser
  // relay cannot name the agent on a multi-agent daemon.
  it("tells the adapter which agent the meeting chat belongs to", async () => {
    const { lane, deps } = fixture();
    await lane.handle({ meetingId: 3 });
    expect(deps.noteChat).toHaveBeenCalledWith(17, 9);
  });
  it("duplicate live and resync events produce one contribution, including after restart", async () => {
    const { lane, host, tools, deps } = fixture();
    await Promise.all([
      lane.handle({ meetingId: 3 }),
      lane.handle({ meetingId: 3 }),
      lane.handle({ meetingId: 3, lastMessageId: 1 }),
    ]);
    expect(host.runTurn).toHaveBeenCalledTimes(1);
    expect(tools.call).toHaveBeenCalledWith(
      "meeting_reply",
      { meeting_id: 3, text: "Contribution" },
      expect.objectContaining({ assistantId: 9, chatId: 17, meetingId: 3 }),
    );
    await new MeetingLane(deps).handle({ meetingId: 3 });
    expect(host.runTurn).toHaveBeenCalledTimes(1);
  });
  it("a queued seat or stale grant cannot speak over another participant", async () => {
    const { lane, host, room } = fixture();
    room.currentSpeakerId = 10;
    await lane.handle({ meetingId: 3, currentSpeakerId: 9 });
    expect(host.runTurn).not.toHaveBeenCalled();
  });
  it("closed and removed memberships do no work", async () => {
    const { lane, host, room } = fixture();
    room.status = "closed";
    await lane.handle({ meetingId: 3 });
    room.status = "open";
    room.participants = [];
    await lane.handle({ meetingId: 3 });
    expect(host.runTurn).not.toHaveBeenCalled();
  });
});
