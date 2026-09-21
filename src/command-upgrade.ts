import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BgosApi } from "./bgos-api.js";
import type { CommandManifestEntry } from "./types.js";

/** One-time append. Subsequent user deletions stay deleted across restarts. */
export class CommandUpgrade {
  constructor(
    private readonly home: string,
    private readonly api: Pick<BgosApi, "mergeCommands">,
  ) {}
  async apply(
    assistantId: number,
    commands: CommandManifestEntry[],
  ): Promise<void> {
    if (!Number.isSafeInteger(assistantId) || assistantId <= 0)
      throw new Error("Invalid assistant id.");
    // The sentinel NAME is part of shipping a new command, not bookkeeping.
    // Every agent paired before this release already carries the v1 marker
    // and this method returns the moment it sees one, so a command added to
    // the catalog would reach new agents and silently never appear in an
    // existing owner's slash picker. v2 adds /goal, the native goal control.
    const file = join(
      this.home,
      "command-upgrades",
      `${assistantId}-native-v2`,
    );
    if (existsSync(file)) return;
    await this.api.mergeCommands(assistantId, commands);
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, "1", { mode: 0o600 });
    renameSync(temp, file);
  }
}
