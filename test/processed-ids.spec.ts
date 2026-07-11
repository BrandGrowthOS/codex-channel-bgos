import { describe, expect, it } from "vitest";

import { ProcessedIdsCache } from "../src/processed-ids.js";

describe("ProcessedIdsCache", () => {
  it("returns true the first time a messageId is seen", () => {
    const cache = new ProcessedIdsCache(100);
    expect(cache.markIfFirstTime(42)).toBe(true);
  });

  it("returns false (dup) the second time a messageId is seen", () => {
    const cache = new ProcessedIdsCache(100);
    expect(cache.markIfFirstTime(42)).toBe(true);
    expect(cache.markIfFirstTime(42)).toBe(false);
  });

  it("treats different messageIds as distinct", () => {
    const cache = new ProcessedIdsCache(100);
    expect(cache.markIfFirstTime(1)).toBe(true);
    expect(cache.markIfFirstTime(2)).toBe(true);
    expect(cache.markIfFirstTime(1)).toBe(false);
    expect(cache.markIfFirstTime(2)).toBe(false);
  });

  it("evicts the oldest entry when capacity is exceeded (FIFO)", () => {
    const cache = new ProcessedIdsCache(3);
    expect(cache.markIfFirstTime(1)).toBe(true);
    expect(cache.markIfFirstTime(2)).toBe(true);
    expect(cache.markIfFirstTime(3)).toBe(true);
    expect(cache.markIfFirstTime(4)).toBe(true); // evicts id=1
    expect(cache.markIfFirstTime(1)).toBe(true); // 1 was forgotten; evicts 2
    expect(cache.markIfFirstTime(3)).toBe(false);
    expect(cache.markIfFirstTime(4)).toBe(false);
  });

  it("re-marking an already-cached id does not promote it", () => {
    const cache = new ProcessedIdsCache(3);
    cache.markIfFirstTime(1);
    cache.markIfFirstTime(2);
    cache.markIfFirstTime(3);
    expect(cache.markIfFirstTime(1)).toBe(false);
    cache.markIfFirstTime(4); // evicts the oldest INSERTED entry, id=1
    expect(cache.markIfFirstTime(1)).toBe(true);
  });

  it("size() reports the current number of cached ids", () => {
    const cache = new ProcessedIdsCache(10);
    expect(cache.size()).toBe(0);
    cache.markIfFirstTime(1);
    cache.markIfFirstTime(2);
    expect(cache.size()).toBe(2);
    cache.markIfFirstTime(1);
    expect(cache.size()).toBe(2);
  });

  it("treats capacity <= 0 as 1", () => {
    const cache = new ProcessedIdsCache(0);
    expect(cache.markIfFirstTime(1)).toBe(true);
    expect(cache.size()).toBe(1);
  });
});
