import { describe, it, expect } from "vitest";
import { resolveAuthMode } from "../src/auth-mode.js";

describe("resolveAuthMode (D7: prefer codex login, OPENAI_API_KEY fallback)", () => {
  it("auto: prefers the codex login when auth.json exists and no key", () => {
    const r = resolveAuthMode({ authJsonExists: true, openaiKey: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("chatgpt");
    expect(r.apiKey).toBeUndefined();
    expect(r.label.toLowerCase()).toContain("login");
  });

  it("auto: prefers the codex login even when a key is ALSO present", () => {
    const r = resolveAuthMode({ authJsonExists: true, openaiKey: "sk-abc" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("chatgpt");
    expect(r.apiKey).toBeUndefined();
  });

  it("auto: falls back to OPENAI_API_KEY when there is no login", () => {
    const r = resolveAuthMode({ authJsonExists: false, openaiKey: "sk-abc" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("apikey");
    expect(r.apiKey).toBe("sk-abc");
  });

  it("auto: refuses with a plain-language error naming BOTH remedies when neither is present", () => {
    const r = resolveAuthMode({ authJsonExists: false, openaiKey: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/codex login/i);
    expect(r.error).toMatch(/OPENAI_API_KEY/);
  });

  it("forced apikey: uses the key even when a login exists", () => {
    const r = resolveAuthMode({ authJsonExists: true, openaiKey: "sk-xyz", forced: "apikey" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("apikey");
    expect(r.apiKey).toBe("sk-xyz");
  });

  it("forced apikey: errors when no key is available", () => {
    const r = resolveAuthMode({ authJsonExists: true, openaiKey: null, forced: "apikey" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/OPENAI_API_KEY/);
  });

  it("forced chatgpt: uses the login when present", () => {
    const r = resolveAuthMode({ authJsonExists: true, openaiKey: "sk-abc", forced: "chatgpt" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("chatgpt");
  });

  it("forced chatgpt: errors when there is no login", () => {
    const r = resolveAuthMode({ authJsonExists: false, openaiKey: "sk-abc", forced: "chatgpt" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/codex login/i);
  });

  it("treats an empty-string key as absent", () => {
    const r = resolveAuthMode({ authJsonExists: false, openaiKey: "   " });
    expect(r.ok).toBe(false);
  });
});
