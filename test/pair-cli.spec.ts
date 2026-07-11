/**
 * pair-cli: daemonVersion at pair-exchange, atomic secrets write, and the new
 * --token mode validating via GET /integrations/me (contracts C1 + C2).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pairBgos, pairBgosWithToken } from "../src/pair-cli.js";
import { getPackageVersion } from "../src/version.js";
import { PairingRevokedError } from "../src/types.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

describe("pair-cli", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  let secretsDir: string;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
    secretsDir = mkdtempSync(join(tmpdir(), "codex-pair-test-"));
  });
  afterEach(async () => {
    await server.stop();
    rmSync(secretsDir, { recursive: true, force: true });
  });

  function readSecrets(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(secretsDir, "bgos.json"), "utf8"));
  }

  it("pairBgos sends integration=codex + daemonVersion and writes secrets", async () => {
    server.stage("POST", "/api/v1/integrations/pair-exchange", 200, {
      pairing_token: "tok_" + "y".repeat(30),
      pairing_id: 5,
      user_id: "user_9",
    });
    const res = await pairBgos({ baseUrl, code: "ABC123", secretsDir });
    const body = server.requests.at(-1)!.body as Record<string, unknown>;
    expect(body.integration).toBe("codex");
    expect(body.daemonVersion).toBe(getPackageVersion());
    const secrets = readSecrets();
    expect(secrets.pairingToken).toBe("tok_" + "y".repeat(30));
    expect(secrets.pairingId).toBe(5);
    expect(secrets.userId).toBe("user_9");
    expect(res.pairing.pairing_id).toBe(5);
  });

  it("pairBgosWithToken validates via /integrations/me and writes secrets", async () => {
    server.stage("GET", "/api/v1/integrations/me", 200, {
      pairing_id: 7,
      user_id: "user_42",
      device_label: "Mac",
      integration: "codex",
      assistants: [],
    });
    const token = "tok_" + "z".repeat(30);
    const res = await pairBgosWithToken({ baseUrl, token, secretsDir });
    expect(res.pairing.pairing_id).toBe(7);
    expect(res.pairing.user_id).toBe("user_42");
    const secrets = readSecrets();
    expect(secrets.pairingToken).toBe(token);
    expect(secrets.pairingId).toBe(7);
    expect(secrets.userId).toBe("user_42");
    // GET, not POST, token mode does not consume a pair code.
    expect(server.requests.at(-1)!.method).toBe("GET");
  });

  it("pairBgosWithToken rejects an invalid token (401 -> PairingRevokedError)", async () => {
    server.stage("GET", "/api/v1/integrations/me", 401, { message: "nope" });
    await expect(
      pairBgosWithToken({ baseUrl, token: "tok_" + "b".repeat(30), secretsDir }),
    ).rejects.toBeInstanceOf(PairingRevokedError);
  });
});
