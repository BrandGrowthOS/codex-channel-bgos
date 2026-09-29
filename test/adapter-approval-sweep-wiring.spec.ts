/**
 * The restart sweep is WIRED, not merely written.
 *
 * `retireOrphanedApprovals` is well covered as a function (interactions.spec,
 * pending-approvals-store.spec), but until this case nothing asserted that the
 * daemon ever CALLS it. Deleting the one line in `start()` left all 64 files
 * green while every approval card an interrupted run had left behind stayed
 * tappable for up to half an hour: the owner taps Allow, the backend stamps it,
 * the card draws as answered, and nothing runs. A fix is not done until it
 * cannot recur silently, so the wiring gets a guard of its own.
 *
 * MUTATION PROOF, run by hand against this tree: deleting
 * `void this.sweepOrphanedApprovals();` from adapter.ts `start()` turns this
 * case red (the retiring PATCH is never issued); restoring it turns it green.
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
  home = mkdtempSync(join(tmpdir(), "codex-sweep-"));
  process.env.CODEX_BGOS_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_BGOS_HOME;
  else process.env.CODEX_BGOS_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * The real `start()` against a daemon made of stubs. Identity is refused and
 * the fatal latch is already set, so the method stops right after the sweep
 * rather than polling a backend this harness does not have.
 */
function fixture() {
  const adapter = Object.create(CodexAdapter.prototype) as any;
  const agentRequest = vi.fn(async () => ({}));
  const getMessages = vi.fn(async () => []);
  Object.assign(adapter, {
    started: false,
    fatalLatched: true,
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
    loadServedCapabilities: vi.fn(async () => {}),
    refreshIdentity: vi.fn(async () => false),
  });
  return { adapter, agentRequest, getMessages };
}

describe("the daemon retires the previous run's approval cards at start", () => {
  it("issues the retiring PATCH for a card the last run left open", async () => {
    writeFileSync(
      join(home, "bgos_pending_approvals.json"),
      JSON.stringify([
        {
          id: 77,
          chatId: 20,
          assistantId: 10,
          userId: "owner-1",
          at: Date.now(),
        },
      ]),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { adapter, agentRequest, getMessages } = fixture();

    await adapter.start();
    // start() fires the sweep with `void` on purpose: a card left tappable is a
    // real defect, a slow boot is a worse one. So wait for it rather than the
    // call returning.
    await vi.waitFor(() =>
      expect(agentRequest).toHaveBeenCalledWith("PATCH", "messages/77", 10, {
        options: [],
      }),
    );
    // Read as the id the poll reads as, before it is retired as the assistant.
    expect(getMessages).toHaveBeenCalledWith(20, "owner-1", {
      beforeId: 78,
      limit: 1,
    });

    clearInterval(adapter.spoolTimer);
  });
});
