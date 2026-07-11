import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sanitizeFromAgent } from "../src/agent-identity.js";

describe("sanitizeFromAgent (inline-name spoofing gate)", () => {
  const original = process.env.CODEX_BGOS_ALLOW_INLINE_AGENT_NAME;

  beforeEach(() => {
    delete process.env.CODEX_BGOS_ALLOW_INLINE_AGENT_NAME;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CODEX_BGOS_ALLOW_INLINE_AGENT_NAME;
    else process.env.CODEX_BGOS_ALLOW_INLINE_AGENT_NAME = original;
  });

  it("returns undefined for undefined input", () => {
    expect(sanitizeFromAgent(undefined)).toBeUndefined();
  });

  it("drops name/avatarUrl/color by default but keeps the handles", () => {
    const out = sanitizeFromAgent({
      peerId: 7,
      assistantId: 3,
      externalId: "research",
      type: "codex",
      name: "Totally The CEO",
      color: "#FF0000",
      avatarUrl: "https://evil.example/ceo.png",
    });
    expect(out).toEqual({
      peerId: 7,
      assistantId: 3,
      externalId: "research",
      type: "codex",
    });
  });

  it("returns undefined when only free-form fields are present (off)", () => {
    expect(
      sanitizeFromAgent({ name: "Spoof", color: "#000", avatarUrl: "x" }),
    ).toBeUndefined();
  });

  it("passes everything through when the flag is enabled", () => {
    process.env.CODEX_BGOS_ALLOW_INLINE_AGENT_NAME = "1";
    const input = {
      peerId: 1,
      name: "Research",
      color: "#0EA5E9",
      avatarUrl: "https://example.com/r.png",
      type: "codex" as const,
    };
    expect(sanitizeFromAgent(input)).toEqual(input);
  });

  it("accepts truthy string spellings of the flag", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      process.env.CODEX_BGOS_ALLOW_INLINE_AGENT_NAME = v;
      expect(sanitizeFromAgent({ name: "X" })).toEqual({ name: "X" });
    }
  });

  it("treats other values as off", () => {
    for (const v of ["0", "false", "no", "off", "", "maybe"]) {
      process.env.CODEX_BGOS_ALLOW_INLINE_AGENT_NAME = v;
      expect(sanitizeFromAgent({ name: "X" })).toBeUndefined();
    }
  });
});
