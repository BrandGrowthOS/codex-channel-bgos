/**
 * Which agent a relayed browser call is made as.
 *
 * The backend requires `assistantId` on every relayed MCP call (a pairing can
 * back several assistants and the owner's rail shows the agent's name), while a
 * Codex thread only knows its chat. The adapter is what closes that gap: it
 * remembers the pairs it sees on inbound events and answers per chat. When it
 * cannot name the agent it must answer null, because relay env without an
 * assistant id is a 400 that the agent only ever sees as "your owner's desktop
 * app is offline".
 *
 * Exercised on the real prototype methods with a hand-built instance, the same
 * way adapter-stop-control.spec.ts does, so no daemon, model or network runs.
 */
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapter.js";

const TOKEN = "pair-test-0123456789abcdefghij";

function adapterWith(
  owned: [number, string][],
  chats: [number, number][] = [],
  identityReady = true,
) {
  const adapter = Object.create(CodexAdapter.prototype) as any;
  Object.assign(adapter, {
    cfg: { baseUrl: "https://api.brandgrowthos.test" },
    currentToken: TOKEN,
    assistantToRoute: new Map<number, string>(owned),
    chatToAssistant: new Map<number, number>(chats),
    // The real adapter flips this after the first successful scope load.
    identityReady,
  });
  return adapter;
}

describe("the assistant a chat's browser calls are made as", () => {
  it("is the one the daemon owns when it owns exactly one, with no event needed", () => {
    const adapter = adapterWith([[10, "codex"]]);
    expect(adapter.assistantForChat(777)).toBe(10);
    expect(adapter.browserRelay(777)).toEqual({
      backendUrl: "https://api.brandgrowthos.test",
      pairingToken: TOKEN,
      assistantId: 10,
    });
  });

  it("is the remembered one for a multi-agent daemon, and null for a chat never served", () => {
    const adapter = adapterWith(
      [
        [10, "codex"],
        [11, "codex-2"],
      ],
      [[20, 11]],
    );
    expect(adapter.assistantForChat(20)).toBe(11);
    expect(adapter.browserRelay(20)!.assistantId).toBe(11);
    // Guessing here would browse as the wrong agent in the owner's rail.
    expect(adapter.assistantForChat(21)).toBeNull();
    expect(adapter.browserRelay(21)).toBeNull();
  });

  it("forgets an assistant this daemon no longer owns rather than relaying as it", () => {
    const adapter = adapterWith(
      [
        [10, "codex"],
        [11, "codex-2"],
      ],
      [[20, 99]],
    );
    expect(adapter.assistantForChat(20)).toBeNull();
  });

  it("still answers from a learned pair before the first scope load, when what we own is unknown rather than empty", () => {
    const adapter = adapterWith([], [[20, 11]], false);
    expect(adapter.assistantForChat(20)).toBe(11);
    expect(adapter.browserRelay(20)!.assistantId).toBe(11);
    // A chat no event ever named is still null: unknown is not a guess.
    expect(adapter.assistantForChat(21)).toBeNull();
  });

  it("learns the pair from an event and refuses the ids that cannot be one", () => {
    const adapter = adapterWith([
      [10, "codex"],
      [11, "codex-2"],
    ]);
    adapter.noteChatAssistant(20, 11);
    expect(adapter.assistantForChat(20)).toBe(11);
    for (const [chatId, assistantId] of [
      [0, 11],
      [-3, 11],
      [21, 0],
      [22, -1],
      [23, 1.5],
      [24, Number.NaN],
    ] as [number, number][])
      adapter.noteChatAssistant(chatId, assistantId);
    expect([...adapter.chatToAssistant.keys()]).toEqual([20]);
  });

  it("keeps the cache bounded, oldest first", () => {
    const adapter = adapterWith([
      [10, "codex"],
      [11, "codex-2"],
    ]);
    for (let chatId = 1; chatId <= 520; chatId += 1)
      adapter.noteChatAssistant(chatId, 10);
    expect(adapter.chatToAssistant.size).toBeLessThanOrEqual(500);
    expect(adapter.chatToAssistant.has(1)).toBe(false);
    expect(adapter.chatToAssistant.get(520)).toBe(10);
  });

  it("hands over the live token, so a re-pair does not leave the browser on a dead one", () => {
    const adapter = adapterWith([[10, "codex"]]);
    adapter.currentToken = "pair-rotated-zyxwvutsrqponmlkjihg";
    expect(adapter.browserRelay(5)!.pairingToken).toBe(
      "pair-rotated-zyxwvutsrqponmlkjihg",
    );
  });
});
