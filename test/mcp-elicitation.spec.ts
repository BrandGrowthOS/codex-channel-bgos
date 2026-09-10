import { describe, expect, it, vi } from "vitest";
import { answerElicitation } from "../src/mcp-elicitation.js";
const context = {
  assistantId: 1,
  chatId: 2,
  userId: "owner",
  signal: new AbortController().signal,
};
const form = (properties: any, required = Object.keys(properties)) => ({
  mode: "form",
  serverName: "QA",
  requestedSchema: { type: "object", properties, required },
});
describe("native MCP forms", () => {
  it.each([
    ["email", "not-an-email", "qa@example.test"],
    ["uri", "not a uri", "https://example.test/path"],
    ["date", "2026-02-30", "2026-09-11"],
    ["date-time", "today", "2026-09-11T10:00:00+04:00"],
  ])(
    "validates %s before returning an accepted form",
    async (format, invalid, valid) => {
      const ask = vi
        .fn()
        .mockResolvedValueOnce([{ free_text: invalid }])
        .mockResolvedValueOnce([{ free_text: valid }]);
      const result = await answerElicitation(
        { ask } as any,
        context,
        form({ value: { type: "string", format } }),
      );
      expect(result.content).toEqual({ value: valid });
      expect(ask).toHaveBeenCalledTimes(2);
    },
  );
  it("paginates native multi-select enums and validates bounds without sending labels", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce([{ picked_option_value: "done" }])
      .mockResolvedValueOnce([{ picked_option_value: "choice:0" }])
      .mockResolvedValueOnce([{ picked_option_value: "more" }])
      .mockResolvedValueOnce([{ picked_option_value: "choice:4" }])
      .mockResolvedValueOnce([{ picked_option_value: "done" }]);
    const result = await answerElicitation(
      { ask } as any,
      context,
      form({
        labels: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: {
            anyOf: ["a", "b", "c", "d", "e"].map((value) => ({
              const: value,
              title: `Label ${value}`,
            })),
          },
        },
      }),
    );
    expect(result.content).toEqual({ labels: ["a", "e"] });
    for (const call of ask.mock.calls)
      expect(call[1][0].options.length).toBeLessThanOrEqual(6);
  });
  it("cancels unsupported schemas before collecting answers", async () => {
    const ask = vi.fn();
    for (const schema of [
      { type: "string", format: "unknown" },
      { type: "object" },
      { type: "array", items: { type: "object" } },
    ]) {
      expect(
        (
          await answerElicitation(
            { ask } as any,
            context,
            form({ value: schema }),
          )
        ).action,
      ).toBe("cancel");
    }
    expect(ask).not.toHaveBeenCalled();
  });
  it("returns typed values and retries invalid input", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce([{ free_text: "wrong" }])
      .mockResolvedValueOnce([{ free_text: "3" }])
      .mockResolvedValueOnce([{ picked_option_value: "true" }]);
    expect(
      await answerElicitation(
        { ask } as any,
        context,
        form({
          count: { type: "integer", minimum: 1, maximum: 4 },
          include: { type: "boolean" },
        }),
      ),
    ).toEqual({
      action: "accept",
      content: { count: 3, include: true },
      _meta: null,
    });
    expect(ask).toHaveBeenCalledTimes(3);
  });
  it("cancels expired forms and never collects passwords or impersonates URL verification", async () => {
    const ask = vi.fn().mockResolvedValue([{ timed_out: true }]);
    for (const p of [
      form({ name: { type: "string" } }),
      form({ password: { type: "string" } }),
      { mode: "url", url: "https://example.com/auth" },
    ])
      expect((await answerElicitation({ ask } as any, context, p)).action).toBe(
        "cancel",
      );
    expect(ask).toHaveBeenCalledTimes(1);
  });
  it("honors optional skipped fields and returns enum values rather than their labels", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce([{ skipped: true }])
      .mockResolvedValueOnce([{ picked_option_value: "ready" }]);
    const result = await answerElicitation(
      { ask } as any,
      context,
      form(
        {
          note: { type: "string" },
          state: {
            type: "string",
            oneOf: [{ const: "ready", title: "Ready now" }],
          },
        },
        ["state"],
      ),
    );
    expect(result.content).toEqual({ state: "ready" });
  });
});
