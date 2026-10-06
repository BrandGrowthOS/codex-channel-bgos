/**
 * The SHARED machine id (design 2.2, Visibility): every agent daemon on one
 * computer, whatever its framework, and the computer's watcher report the
 * same `~/.bgos-agent/machine-id`. Without it the app files a Codex agent
 * under "unknown computer". The rules are the Claude Code plugin's
 * (lib/machine-id.mjs): uuid v4 minted on first read, persisted 0600, the
 * backend's `^[A-Za-z0-9-]{8,64}$` shape, a malformed file re-minted, an
 * unwritable home omitted, and never a fresh id per call.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MACHINE_ID_RE,
  ensureMachineId,
  machineIdPath,
} from "../src/machine-id.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) {
    try {
      chmodSync(join(home, ".bgos-agent"), 0o700);
    } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});
const tempHome = () => {
  const home = mkdtempSync(join(tmpdir(), "codex-machine-id-"));
  homes.push(home);
  return home;
};

describe("ensureMachineId", () => {
  it("mints a uuid v4 on first read, persists it 0600 and returns it on every later read", () => {
    const home = tempHome();
    const first = ensureMachineId({ home });
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(readFileSync(machineIdPath(home), "utf8").trim()).toBe(first);
    if (process.platform !== "win32")
      expect(statSync(machineIdPath(home)).mode & 0o777).toBe(0o600);
    // Never a fresh id per call: one laptop must not look like a fleet.
    expect(ensureMachineId({ home })).toBe(first);
    expect(
      ensureMachineId({ home, generateId: () => "another-0000-id" }),
    ).toBe(first);
  });

  it("reads the id another framework already wrote, trimmed", () => {
    const home = tempHome();
    mkdirSync(join(home, ".bgos-agent"), { recursive: true });
    writeFileSync(machineIdPath(home), "  plugin-written-id-1234\n");
    expect(ensureMachineId({ home })).toBe("plugin-written-id-1234");
  });

  it("re-mints a malformed file and tightens its mode", () => {
    const home = tempHome();
    mkdirSync(join(home, ".bgos-agent"), { recursive: true });
    writeFileSync(machineIdPath(home), "bad id with spaces!", { mode: 0o644 });
    const id = ensureMachineId({ home, generateId: () => "fresh-id-5678" });
    expect(id).toBe("fresh-id-5678");
    expect(readFileSync(machineIdPath(home), "utf8").trim()).toBe(id);
    if (process.platform !== "win32")
      expect(statSync(machineIdPath(home)).mode & 0o777).toBe(0o600);
  });

  it("omits the id (empty string) when nothing can be persisted", () => {
    const home = tempHome();
    const fs = {
      readFileSync: () => {
        throw Object.assign(new Error("absent"), { code: "ENOENT" });
      },
      mkdirSync: () => undefined,
      writeFileSync: () => {
        throw Object.assign(new Error("read only"), { code: "EROFS" });
      },
    };
    expect(ensureMachineId({ home, fs })).toBe("");
    // A malformed file on a home that has turned read only: the re-mint is
    // never returned, because it was never persisted.
    const malformed = {
      ...fs,
      readFileSync: () => "not valid!",
    };
    expect(ensureMachineId({ home, fs: malformed })).toBe("");
  });

  it("never returns a minted id the backend would refuse", () => {
    const home = tempHome();
    expect(ensureMachineId({ home, generateId: () => "short" })).toBe("");
    expect(MACHINE_ID_RE.test("short")).toBe(false);
  });

  it("returns the id on disk when another process minted first (no per process id)", () => {
    // Two daemons on one computer can mint at the same moment. The backend
    // keeps a pairing's FIRST machine id for life, so the loser must report
    // the winner's id, never its own.
    const home = tempHome();
    const fs = {
      readFileSync: (() => {
        let reads = 0;
        return (path: string) => {
          reads += 1;
          if (reads === 1)
            throw Object.assign(new Error("absent"), { code: "ENOENT" });
          return "winner-id-0001\n";
        };
      })(),
      mkdirSync: () => undefined,
      writeFileSync: (_path: string, _data: string, opts: { flag?: string }) => {
        if (opts.flag === "wx")
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
      },
    };
    expect(ensureMachineId({ home, fs, generateId: () => "loser-id-0002" })).toBe(
      "winner-id-0001",
    );
  });
});
