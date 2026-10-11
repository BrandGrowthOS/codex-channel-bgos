import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BgosApi } from "../src/bgos-api.js";
import { HoaiTools } from "../src/hoai-tools.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

describe("private schedules through the actual tool and HTTP transport", () => {
  let server: MockBgosServer, tools: HoaiTools;
  const context = (actor?: string | null) => ({ assistantId: 42, chatId: 17, userId: "user_owner", privateActor: actor, signal: new AbortController().signal });
  beforeEach(async () => {
    server = new MockBgosServer();
    tools = new HoaiTools(new BgosApi({ baseUrl: await server.start(), pairingToken: "synthetic-pairing", reconnect: { initialDelayMs: 100, maxDelayMs: 1000 } }), () => "canon");
  });
  afterEach(async () => { await server.stop(); });

  it("binds owner and two recipients separately on create, list and cancel, preserving the admitted chat", async () => {
    for (const actor of ["user_owner", "user_recipient_a", "user_recipient_b"]) {
      server.stage("POST", "/api/v1/scheduled-tasks/agent", 200, { id: 7 });
      await tools.call("schedule", { kind: "wake", topic: "Synthetic reminder", when: { everyHours: 1 } }, context(actor));
      expect(server.requests.at(-1)!.body).toMatchObject({ chatId: 17 });
      server.stage("GET", "/api/v1/scheduled-tasks/agent", 200, []);
      await tools.call("list_schedules", {}, context(actor));
      server.stage("DELETE", "/api/v1/scheduled-tasks/agent/7", 200, { cancelled: true });
      await tools.call("cancel_schedule", { schedule_id: "7" }, context(actor));
      for (const request of server.requests.slice(-3)) {
        expect(request.headers["x-bgos-acting-user"]).toBe(actor);
        expect(request.headers["x-caller-assistant-id"]).toBe("42");
      }
    }
  });

  it("refuses unknown, unattributed system and invalid actors before any HTTP request", async () => {
    for (const actor of [undefined, null, "", "owner", "user_bad\nheader"]) {
      for (const [name, args] of [["schedule", { kind: "wake", topic: "Reminder", when: { everyHours: 1 } }], ["list_schedules", {}], ["cancel_schedule", { schedule_id: "7" }]] as const)
        await expect(tools.call(name, args, context(actor))).rejects.toThrow("verified current sender");
    }
    expect(server.requests).toHaveLength(0);
  });

  it("retains the recipient header on a refused cross-account cancellation without an owner retry", async () => {
    server.stage("DELETE", "/api/v1/scheduled-tasks/agent/7", 404, { error: "not_found" });
    await expect(tools.call("cancel_schedule", { schedule_id: "7" }, context("user_recipient"))).rejects.toThrow();
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].headers["x-bgos-acting-user"]).toBe("user_recipient");
  });

  it("isolates overlapping Boards and schedule calls for owner and recipients", async () => {
    const actors = ["user_owner", "user_recipient_a", "user_recipient_b"];
    for (const actor of actors) {
      server.stage("GET", "/api/v1/integrations/assistants/42/boards", 200, { boards: [] });
      server.stage("GET", "/api/v1/scheduled-tasks/agent", 200, []);
    }
    await Promise.all(actors.flatMap(actor => [tools.call("boards_list", {}, context(actor)), tools.call("list_schedules", {}, context(actor))]));
    for (const actor of actors) {
      const calls = server.requests.filter(request => request.headers["x-bgos-acting-user"] === actor);
      expect(calls).toHaveLength(2);
      expect(calls.some(request => request.url.includes("/boards"))).toBe(true);
      expect(calls.some(request => request.url.includes("/scheduled-tasks/agent"))).toBe(true);
    }
  });

  it("refuses unknown Boards readers and writers before any HTTP request", async () => {
    for (const actor of [undefined, null, "owner"]) {
      await expect(tools.call("boards_list", {}, context(actor))).rejects.toThrow("verified current sender");
      await expect(tools.call("boards_create", { name: "Synthetic" }, context(actor))).rejects.toThrow("verified current sender");
    }
    expect(server.requests).toHaveLength(0);
  });
});
