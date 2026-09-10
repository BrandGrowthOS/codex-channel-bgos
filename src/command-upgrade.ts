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
    const file = join(
      this.home,
      "command-upgrades",
      `${assistantId}-native-v1`,
    );
    if (existsSync(file)) return;
    await this.api.mergeCommands(assistantId, commands);
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, "1", { mode: 0o600 });
    renameSync(temp, file);
  }
}
