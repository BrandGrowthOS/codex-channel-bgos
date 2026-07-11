import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  threadsPath,
  loadThreadMap,
  getThreadId,
  setThreadId,
  resetChat,
} from "../src/thread-map.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-threads-"));
  path = threadsPath(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("thread-map (chat -> Codex thread persistence)", () => {
  it("loads an empty map when the file does not exist", () => {
    expect(loadThreadMap(path)).toEqual({});
  });

  it("persists a thread id and reads it back after reload", () => {
    const map = loadThreadMap(path);
    setThreadId(path, map, 42, "thread_abc");
    expect(getThreadId(map, 42)).toBe("thread_abc");
    // fresh reload from disk sees it too
    expect(getThreadId(loadThreadMap(path), 42)).toBe("thread_abc");
  });

  it("normalizes numeric and string chat ids to the same key", () => {
    const map = loadThreadMap(path);
    setThreadId(path, map, 7, "thread_seven");
    expect(getThreadId(map, "7")).toBe("thread_seven");
  });

  it("returns undefined for an unknown chat", () => {
    expect(getThreadId(loadThreadMap(path), 999)).toBeUndefined();
  });

  it("resetChat removes the mapping and persists the removal", () => {
    const map = loadThreadMap(path);
    setThreadId(path, map, 5, "thread_five");
    resetChat(path, map, 5);
    expect(getThreadId(map, 5)).toBeUndefined();
    expect(getThreadId(loadThreadMap(path), 5)).toBeUndefined();
  });

  it("overwrites an existing mapping", () => {
    const map = loadThreadMap(path);
    setThreadId(path, map, 1, "thread_old");
    setThreadId(path, map, 1, "thread_new");
    expect(getThreadId(loadThreadMap(path), 1)).toBe("thread_new");
  });

  it("keeps distinct chats independent", () => {
    const map = loadThreadMap(path);
    setThreadId(path, map, 1, "t1");
    setThreadId(path, map, 2, "t2");
    const fresh = loadThreadMap(path);
    expect(getThreadId(fresh, 1)).toBe("t1");
    expect(getThreadId(fresh, 2)).toBe("t2");
  });

  it("returns an empty map (no throw) on corrupt JSON", () => {
    writeFileSync(path, "{ this is not json");
    expect(loadThreadMap(path)).toEqual({});
  });
});
