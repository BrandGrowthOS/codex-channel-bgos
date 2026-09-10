import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandUpgrade } from "../src/command-upgrade.js";

const homes: string[] = [];
const home = () => {
  const p = mkdtempSync(join(tmpdir(), "codex-command-upgrade-"));
  homes.push(p);
  return p;
};
afterEach(() => {
  for (const p of homes.splice(0)) rmSync(p, { recursive: true, force: true });
});
describe("one-time native command migration", () => {
  it("does not re-add commands the user deleted after a successful upgrade", async () => {
    const dir = home();
    const mergeCommands = vi.fn().mockResolvedValue([]);
    await new CommandUpgrade(dir, { mergeCommands }).apply(12, []);
    await new CommandUpgrade(dir, { mergeCommands }).apply(12, []);
    expect(mergeCommands).toHaveBeenCalledTimes(1);
  });
  it("retries a failed API request rather than recording a false success", async () => {
    const mergeCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([]);
    const upgrade = new CommandUpgrade(home(), { mergeCommands });
    await expect(upgrade.apply(12, [])).rejects.toThrow("offline");
    await upgrade.apply(12, []);
    expect(mergeCommands).toHaveBeenCalledTimes(2);
  });
  it("keeps the migration marker scoped to the agent", async () => {
    const mergeCommands = vi.fn().mockResolvedValue([]);
    const upgrade = new CommandUpgrade(home(), { mergeCommands });
    await upgrade.apply(12, []);
    await upgrade.apply(13, []);
    expect(mergeCommands).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid identities before calling the backend", async () => {
    const mergeCommands = vi.fn();
    await expect(
      new CommandUpgrade(home(), { mergeCommands }).apply(-1, []),
    ).rejects.toThrow();
    expect(mergeCommands).not.toHaveBeenCalled();
  });
});
