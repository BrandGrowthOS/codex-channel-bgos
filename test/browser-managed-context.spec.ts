import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { bundledShimPath } from "../src/browser-mcp.js";

// The canonical real-child cases are copied byte for byte into this helper.
// This proves the shipped shim contract, not a Codex context publisher.
it("enforces signed managed contexts in the bundled shim", async () => {
  const helper = fileURLToPath(new URL("./helpers/browser-managed-context.cjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ["--test", "--test-reporter=tap", helper], {
    env: { ...process.env, HOAI_SHIM_TEST_PATH: bundledShimPath() },
    timeout: 30_000,
  });
  expect(stdout).toMatch(/# tests 7\b/);
  expect(stdout).toMatch(/# pass 7\b/);
  expect(stdout).toMatch(/# fail 0\b/);
  expect(stdout).toMatch(/# skipped 0\b/);
}, 35_000);
