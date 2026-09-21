/**
 * Does `/goal` actually reach an owner's slash picker (mission program stage 6).
 *
 * Adding a command to the catalog is only half of shipping it. Every agent
 * paired before this release already carries the one time upgrade marker, and
 * `CommandUpgrade.apply` returns the moment it sees one, so a new command
 * lands for new agents and silently never appears for anyone else. The seed
 * path is no help either: it only fires for an agent with no commands at all.
 * The sentinel name is therefore part of the feature, and this pins it.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandUpgrade } from "../src/command-upgrade.js";
import { DEFAULT_COMMANDS } from "../src/default-commands.js";

const homes: string[] = [];
function home(): string {
  const path = mkdtempSync(join(tmpdir(), "codex-goal-catalog-"));
  homes.push(path);
  return path;
}
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("the goal command in the catalog pushed to BGOS", () => {
  it("is published, so the app's own slash door hands a typed goal straight to the daemon", () => {
    const goal = DEFAULT_COMMANDS.find((c) => c.command === "goal");
    expect(goal).toBeTruthy();
    expect(goal!.description).toBe(
      "Set a condition Codex works toward until it is met",
    );
  });

  it("carries no em dash and no en dash in any description", () => {
    for (const entry of DEFAULT_COMMANDS) {
      expect(entry.description, entry.command).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("reaches an agent that was already upgraded by an earlier release", async () => {
    const dir = home();
    // Exactly what a daemon before this release left behind.
    mkdirSync(join(dir, "command-upgrades"), { recursive: true });
    writeFileSync(join(dir, "command-upgrades", "12-native-v1"), "1");
    const mergeCommands = vi.fn().mockResolvedValue([]);

    await new CommandUpgrade(dir, { mergeCommands }).apply(12, [
      ...DEFAULT_COMMANDS,
    ]);

    expect(mergeCommands).toHaveBeenCalledTimes(1);
    expect(mergeCommands.mock.calls[0]![1]).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "goal" })]),
    );
  });

  it("still upgrades each agent only once, so a deleted command stays deleted", async () => {
    const dir = home();
    const mergeCommands = vi.fn().mockResolvedValue([]);
    await new CommandUpgrade(dir, { mergeCommands }).apply(12, []);
    await new CommandUpgrade(dir, { mergeCommands }).apply(12, []);
    expect(mergeCommands).toHaveBeenCalledTimes(1);
  });
});
