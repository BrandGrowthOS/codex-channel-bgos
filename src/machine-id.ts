/**
 * The machine id this computer's agents share (design 2.2, Visibility).
 *
 * Every agent daemon on one computer, whatever its framework, and the
 * computer's watcher report the same `machineId` in their heartbeat env. It is
 * the only thing that lets the backend group pairings into one computer, so a
 * Codex agent that reports none is filed under "unknown computer" and the
 * computer's Keep agents running switch cannot see it.
 *
 * The rules are the Claude Code plugin's, exactly (lib/machine-id.mjs), so the
 * two read and write ONE file: `~/.bgos-agent/machine-id`, a uuid v4 minted on
 * first read and persisted 0600; a value outside the backend's
 * `^[A-Za-z0-9-]{8,64}$` is re-minted rather than sent; an unwritable home
 * yields '' and the heartbeat simply omits the field; nothing here throws.
 * A fresh id per call would make one laptop look like a fleet, so an id is
 * never returned unless it was persisted.
 *
 * One addition, which changes no rule: the first mint uses an exclusive
 * create, and a process that loses that race returns the winner's id. The
 * backend keeps a pairing's FIRST machine id for life (machineId is write
 * once per pairing), so two daemons minting at the same moment must not each
 * report their own.
 */
import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** File name under ~/.bgos-agent/. */
export const MACHINE_ID_FILE = "machine-id";

/** The backend's HeartbeatEnvDto.machineId shape (MACHINE_ID_REGEX). */
export const MACHINE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export interface MachineIdFs {
  readFileSync: (path: string, encoding: "utf8") => string;
  mkdirSync: (path: string, opts: { recursive: boolean }) => unknown;
  writeFileSync: (
    path: string,
    data: string,
    opts: { mode: number; flag?: string },
  ) => void;
  chmodSync?: (path: string, mode: number) => void;
}

let cachedMachineId = "";

/**
 * This user's machine id, read (or minted) once per process. '' is not cached,
 * so a home that becomes writable later is tried again on the next beat.
 */
export function sharedMachineId(): string {
  if (!cachedMachineId) cachedMachineId = ensureMachineId();
  return cachedMachineId;
}

/** <home>/.bgos-agent/machine-id */
export function machineIdPath(home: string): string {
  return join(home, ".bgos-agent", MACHINE_ID_FILE);
}

/** Trim and validate a candidate id; null for anything the backend would refuse. */
export function normalizeMachineId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return MACHINE_ID_RE.test(value) ? value : null;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * Read the persisted machine id, minting and persisting one when absent or
 * malformed. Returns '' when nothing could be persisted.
 */
export function ensureMachineId({
  home = homedir(),
  fs = nodeFs as unknown as MachineIdFs,
  generateId = randomUUID,
}: {
  home?: string;
  fs?: MachineIdFs;
  generateId?: () => string;
} = {}): string {
  const path = machineIdPath(home);
  let absent = false;
  try {
    const existing = normalizeMachineId(fs.readFileSync(path, "utf8"));
    if (existing) return existing;
  } catch (error) {
    absent = errorCode(error) === "ENOENT";
  }
  let minted: string | null = null;
  try {
    minted = normalizeMachineId(generateId());
  } catch {
    minted = null;
  }
  if (!minted) return "";
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    if (absent) {
      try {
        fs.writeFileSync(path, `${minted}\n`, { mode: 0o600, flag: "wx" });
        return minted;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") return "";
        // Another daemon minted between our read and our write: its id is
        // the computer's id, as long as it is one the backend accepts.
        try {
          const winner = normalizeMachineId(fs.readFileSync(path, "utf8"));
          if (winner) return winner;
        } catch {}
      }
    }
    fs.writeFileSync(path, `${minted}\n`, { mode: 0o600 });
    // A re-mint over an existing malformed file keeps that file's mode, so
    // tighten it explicitly; a no-op on win32 and best effort everywhere.
    try {
      fs.chmodSync?.(path, 0o600);
    } catch {}
    return minted;
  } catch {
    return "";
  }
}
