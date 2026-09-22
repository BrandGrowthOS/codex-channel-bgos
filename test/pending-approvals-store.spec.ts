import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearPendingApproval,
  loadPendingApprovals,
  recordPendingApproval,
} from "../src/pending-approvals-store.js";

/**
 * The disk half of the restart contract (see interactions.ts
 * retireOrphanedApprovals). What the boot sweep can retire is exactly what this
 * file survived with, so the cases worth pinning are the round trip, the
 * forgetting, and what a damaged file does.
 *
 * MUTATION PROOFS, run by hand against this tree:
 *  - dropping the `entries.some` guard in recordPendingApproval turns the
 *    idempotence case red (a re-recorded card would be retired twice).
 *  - dropping any field from the validator in loadPendingApprovals turns the
 *    half written case red: an entry with no chat or no assistant would come
 *    back and the sweep would PATCH against `undefined`.
 *  - returning something other than [] from a failed parse turns the damaged
 *    file case red, and a boot would throw on a file it should ignore.
 */
describe("the durable record of open approval cards", () => {
  let tempHome: string;
  const original = process.env.CODEX_BGOS_HOME;
  const entry = {
    id: 41,
    chatId: 17,
    assistantId: 9,
    userId: "owner",
    at: 1789932968000,
  };

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "codex-approvals-"));
    process.env.CODEX_BGOS_HOME = tempHome;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CODEX_BGOS_HOME;
    else process.env.CODEX_BGOS_HOME = original;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("reads back what it recorded, and records a card only once", () => {
    expect(loadPendingApprovals()).toEqual([]);
    recordPendingApproval(entry);
    recordPendingApproval({ ...entry, chatId: 99 });
    expect(loadPendingApprovals()).toEqual([entry]);
    const raw = readFileSync(
      join(tempHome, "bgos_pending_approvals.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual([entry]);
  });

  it("forgets one card without disturbing the others", () => {
    recordPendingApproval(entry);
    recordPendingApproval({ ...entry, id: 42 });
    clearPendingApproval(41);
    expect(loadPendingApprovals()).toEqual([{ ...entry, id: 42 }]);
  });

  it("drops a half written entry and ignores a damaged file", () => {
    writeFileSync(
      join(tempHome, "bgos_pending_approvals.json"),
      JSON.stringify([
        entry,
        // Missing ONLY the assistant, which is the field the retiring PATCH is
        // sent as: each clause of the validator is load bearing on its own.
        { id: 42, chatId: 17, userId: "owner", at: 1789932968000 },
        { ...entry, id: 43, chatId: 0 },
        { chatId: 17 },
      ]),
    );
    // A row missing the assistant or the chat cannot be retired, and a PATCH
    // aimed at a guess is worse than a card left alone.
    expect(loadPendingApprovals()).toEqual([entry]);
    writeFileSync(join(tempHome, "bgos_pending_approvals.json"), "{ not json");
    expect(loadPendingApprovals()).toEqual([]);
  });
});
