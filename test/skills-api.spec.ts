import { describe, expect, it, vi } from "vitest";

import { BgosApi } from "../src/bgos-api.js";

type HttpPost = (
  url: string,
  body: unknown,
  config?: { timeout?: number },
) => Promise<{ data: unknown }>;

function makeApi() {
  return new BgosApi({
    baseUrl: "https://example.test",
    pairingToken: "pair-token",
  } as never);
}

describe("BgosApi skills RPC endpoints", () => {
  it("uses short per-request timeouts for control and result posts", async () => {
    const api = makeApi();
    const http = (api as unknown as { http: { post: HttpPost } }).http;
    const post = vi.spyOn(http, "post").mockResolvedValue({ data: {} });

    await api.skillsRpcAck("rpc/1");
    await api.skillsRpcProgress("rpc/1", { stage: "starting" });
    await api.skillsRpcResult("rpc/1", { ok: true, payload: {} });

    expect(post.mock.calls).toEqual([
      [
        "integrations/skills-rpc/rpc%2F1/ack",
        {},
        { timeout: 3_000 },
      ],
      [
        "integrations/skills-rpc/rpc%2F1/progress",
        { stage: "starting" },
        { timeout: 3_000 },
      ],
      [
        "integrations/skills-rpc/rpc%2F1/result",
        { ok: true, payload: {} },
        { timeout: 3_000 },
      ],
    ]);
  });
});
