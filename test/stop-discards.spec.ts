/**
 * The Stop pauses an owner discarded (P6 stage 3, C-32, review F4).
 *
 * /new and a Sessions resume leave the context a Stop paused, and no later
 * owner turn may resume that mission from it (spec 4.2, D25). The daemon's
 * memory of that ends with the process, so the discard is kept on disk: a
 * restart's first owner turn (D12) reads it before it resumes anything.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StopDiscards } from "../src/stop-discards.js";

describe("StopDiscards", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hoai-stop-discards-"));
    file = join(dir, "stop-discards.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("remembers a discard across a restart, and forgets it when told", () => {
    const before = new StopDiscards(file);
    expect(before.has(301)).toBe(false);
    before.add(301);
    expect(before.has(301)).toBe(true);

    const after = new StopDiscards(file);
    expect(after.has(301)).toBe(true);
    after.delete(301);
    expect(new StopDiscards(file).has(301)).toBe(false);
  });

  it("keeps only the newest, so the file cannot grow for ever", () => {
    const store = new StopDiscards(file, 3);
    for (const id of [1, 2, 3, 4]) store.add(id);
    const reread = new StopDiscards(file, 3);
    expect([1, 2, 3, 4].map((id) => reread.has(id))).toEqual([false, true, true, true]);
  });

  it("reads a missing, broken or foreign file as empty and never throws", () => {
    expect(new StopDiscards(file).has(1)).toBe(false);
    writeFileSync(file, "{not json");
    expect(new StopDiscards(file).has(1)).toBe(false);
    writeFileSync(file, JSON.stringify({ ids: [5, "6", -7, 1.5, 8] }));
    const store = new StopDiscards(file);
    expect([5, 6, 7, 8].map((id) => store.has(id))).toEqual([true, false, false, true]);
  });

  it("writes whole ids only, and a write that fails is logged, never thrown", () => {
    const store = new StopDiscards(file);
    store.add(9);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ids: [9] });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A file where the folder should be: every write fails at mkdir, before
    // anything is written.
    const blocked = new StopDiscards(join(file, "nested.json"));
    expect(() => blocked.add(10)).not.toThrow();
    expect(blocked.has(10)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("with no file it lives in memory, as the lane's default", () => {
    const store = new StopDiscards(null);
    store.add(11);
    expect(store.has(11)).toBe(true);
  });
});
