import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadLastId, saveLastId } from "../src/last-id-store.js";

describe("last-id-store", () => {
  let tempHome: string;
  const originalCodexBgosHome = process.env.CODEX_BGOS_HOME;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "codex-channel-test-"));
    process.env.CODEX_BGOS_HOME = tempHome;
  });

  afterEach(() => {
    if (originalCodexBgosHome === undefined) {
      delete process.env.CODEX_BGOS_HOME;
    } else {
      process.env.CODEX_BGOS_HOME = originalCodexBgosHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("loadLastId returns 0 when the file does not exist", () => {
    expect(loadLastId()).toBe(0);
  });

  it("saveLastId persists, loadLastId reads it back", () => {
    saveLastId(42);
    expect(loadLastId()).toBe(42);
    // Sanity-check the on-disk format.
    const raw = readFileSync(join(tempHome, "bgos_last_id"), "utf8");
    expect(raw).toBe("42");
  });

  it("saveLastId never regresses (cursor must advance monotonically)", () => {
    saveLastId(100);
    saveLastId(50); // attempt to regress
    expect(loadLastId()).toBe(100);
  });

  it("saveLastId rejects 0 / negative / non-integer ids", () => {
    saveLastId(0);
    saveLastId(-5);
    saveLastId(3.14);
    saveLastId(NaN);
    expect(loadLastId()).toBe(0);
  });

  it("loadLastId tolerates a corrupted file (returns 0)", () => {
    writeFileSync(join(tempHome, "bgos_last_id"), "not-a-number", "utf8");
    expect(loadLastId()).toBe(0);
  });

  it("loadLastId tolerates an empty file (returns 0)", () => {
    writeFileSync(join(tempHome, "bgos_last_id"), "", "utf8");
    expect(loadLastId()).toBe(0);
  });

  it("saveLastId is atomic: subsequent loads see the new value", () => {
    saveLastId(7);
    saveLastId(8);
    saveLastId(9);
    expect(loadLastId()).toBe(9);
  });
});
