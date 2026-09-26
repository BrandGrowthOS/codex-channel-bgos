/**
 * The chat to agent pairs this daemon has seen, kept on disk (P5 stage 7,
 * Phase B, decision 3).
 *
 * A daemon serving several agents learns which agent a chat belongs to only
 * from an event that names both, and its in memory map is empty at every
 * boot. The model and effort connect sweep needs the answer for every stored
 * chat, so the pair is written through to `chat-assistants.json` in
 * CODEX_BGOS_HOME and read back by the next process. A cache, never the
 * source of truth: the sweep still refuses a pair whose agent this daemon no
 * longer owns (adapter-session-report-wiring.spec.ts).
 *
 * No em or en dashes anywhere in this file.
 */
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHAT_ASSISTANTS_LIMIT,
  ChatAssistantStore,
} from "../src/chat-assistants.js";

let home: string;
let file: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-chat-assistants-"));
  file = join(home, "chat-assistants.json");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("ChatAssistantStore", () => {
  it("starts empty with no file, and answers null for a chat it never saw", () => {
    const store = new ChatAssistantStore(file);
    expect(store.get(20)).toBeNull();
  });

  it("writes a pair through and a new store over the same file reads it back", () => {
    new ChatAssistantStore(file).set(20, 11);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ 20: 11 });
    expect(new ChatAssistantStore(file).get(20)).toBe(11);
  });

  it("a pair that did not change costs no write", () => {
    const store = new ChatAssistantStore(file);
    store.set(20, 11);
    writeFileSync(file, JSON.stringify({ 20: 11, marker: 1 }));
    store.set(20, 11);
    // The marker survives: the unchanged pair did not rewrite the file.
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ 20: 11, marker: 1 });
    store.set(20, 12);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ 20: 12 });
  });

  it("ignores anything that is not a positive whole chat id and agent id", () => {
    writeFileSync(
      file,
      JSON.stringify({ 20: 11, abc: 3, 21: "x", 22: -1, 0: 4, 23: 1.5 }),
    );
    const store = new ChatAssistantStore(file);
    expect(store.get(20)).toBe(11);
    for (const chat of [21, 22, 0, 23]) expect(store.get(chat)).toBeNull();
    store.set(-5, 3);
    store.set(24, 0);
    expect(store.get(-5)).toBeNull();
    expect(store.get(24)).toBeNull();
  });

  it("a file that is not JSON reads as empty and never throws", () => {
    writeFileSync(file, "{not json");
    expect(() => new ChatAssistantStore(file)).not.toThrow();
    expect(new ChatAssistantStore(file).get(20)).toBeNull();
  });

  it("is bounded: the oldest pair goes first", () => {
    // The default bound is far above the chats one daemon serves; the rule
    // is shown on a small one, so the case writes the file six times, not
    // two thousand.
    expect(CHAT_ASSISTANTS_LIMIT).toBe(2000);
    const store = new ChatAssistantStore(file, 5);
    for (let chat = 1; chat <= 6; chat += 1) store.set(chat, 7);
    expect(store.get(1)).toBeNull();
    expect(store.get(2)).toBe(7);
    expect(store.get(6)).toBe(7);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual([
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
  });

  it("is written private to the owner, like threads.json", () => {
    new ChatAssistantStore(file).set(20, 11);
    if (process.platform !== "win32")
      expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain('"20": 11');
  });
});
