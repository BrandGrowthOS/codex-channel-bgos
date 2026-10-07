/**
 * Self update owned by the supervisor (design 2.2, decision D7): the PURE
 * decisions, table tested. The effects (registry read, npm, the runtime swap,
 * the restart) are in test/self-update-runtime.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { join as posixJoin } from "node:path/posix";
import { join as winJoin } from "node:path/win32";

import {
  CONFIRM_MAX_BOOTS,
  CONFIRM_WINDOW_MS,
  FIRST_CHECK_DELAY_MS,
  HEARTBEAT_FRESH_MS,
  LATEST_FRESH_MS,
  QUIET_WINDOW_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_JITTER_MAX_MS,
  autoUpdateEnabledFromEnv,
  decideApply,
  decideConfirmation,
  decideRollbackStop,
  decideSafeMoment,
  decideUpdate,
  emptyUpdateState,
  isCheckDue,
  isLatestFresh,
  nextCheckAt,
  npmCliCandidates,
  npmCliPath,
  resolveSupervised,
  stageInstallArgs,
  supervisorPidFromEnv,
  updateReportFromState,
  type ChildHeartbeat,
} from "../src/setup/self-update.js";

const NOW = Date.parse("2026-10-06T20:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("decideUpdate: which version to stage", () => {
  const base = {
    enabled: true,
    current: "0.19.0",
    latest: "0.19.2",
    rolledBack: [] as string[],
  };
  const table: Array<[string, Partial<typeof base> & { latest?: string | null }, unknown]> = [
    ["a newer patch on the same major", {}, { action: "stage", version: "0.19.2" }],
    ["a newer minor on the same major", { latest: "0.20.0" }, { action: "stage", version: "0.20.0" }],
    ["auto update switched off", { enabled: false }, { action: "none", reason: "disabled" }],
    ["registry answer unknown", { latest: null }, { action: "none", reason: "latest_unknown" }],
    ["registry answer not a plain version", { latest: "0.20.0-beta.1" }, { action: "none", reason: "latest_unknown" }],
    ["own version unreadable", { current: "0.0.0-dev" }, { action: "none", reason: "current_unknown" }],
    ["already on latest", { latest: "0.19.0" }, { action: "none", reason: "not_newer" }],
    ["never downgrade", { latest: "0.18.0" }, { action: "none", reason: "not_newer" }],
    ["same major only", { latest: "1.0.0" }, { action: "none", reason: "other_major" }],
    ["skip a version that was rolled back", { rolledBack: ["0.19.2"] }, { action: "none", reason: "rolled_back" }],
  ];
  for (const [name, change, expected] of table)
    it(name, () => {
      expect(decideUpdate({ ...base, ...change } as typeof base)).toEqual(expected);
    });
});

describe("autoUpdateEnabledFromEnv: CODEX_BGOS_AUTO_UPDATE=off disables", () => {
  const table: Array<[string | undefined, boolean]> = [
    [undefined, true],
    ["", true],
    ["on", true],
    ["off", false],
    [" OFF ", false],
    ["0", false],
    ["false", false],
    ["no", false],
  ];
  for (const [raw, expected] of table)
    it(`${JSON.stringify(raw)} -> ${expected}`, () => {
      expect(
        autoUpdateEnabledFromEnv(
          raw === undefined ? {} : { CODEX_BGOS_AUTO_UPDATE: raw },
        ),
      ).toBe(expected);
    });
});

describe("check schedule: every 24 h plus up to 6 h jitter", () => {
  it("the next check lands between 24 h and 30 h from now", () => {
    expect(nextCheckAt(NOW, () => 0)).toBe(NOW + UPDATE_CHECK_INTERVAL_MS);
    expect(nextCheckAt(NOW, () => 0.999999)).toBeLessThan(
      NOW + UPDATE_CHECK_INTERVAL_MS + UPDATE_JITTER_MAX_MS,
    );
    expect(nextCheckAt(NOW, () => 0.5)).toBe(
      NOW + UPDATE_CHECK_INTERVAL_MS + UPDATE_JITTER_MAX_MS / 2,
    );
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    expect(UPDATE_JITTER_MAX_MS).toBe(6 * 60 * 60 * 1000);
  });
  it("is due at the persisted time, and soon after a first boot with none", () => {
    const state = emptyUpdateState();
    expect(isCheckDue(state, NOW, NOW)).toBe(false);
    expect(isCheckDue(state, NOW + FIRST_CHECK_DELAY_MS, NOW)).toBe(true);
    state.nextCheckAt = iso(NOW + 1000);
    expect(isCheckDue(state, NOW, NOW - FIRST_CHECK_DELAY_MS)).toBe(false);
    expect(isCheckDue(state, NOW + 1000, NOW)).toBe(true);
    // A reboot does not reset the schedule into a fresh check.
    state.nextCheckAt = iso(NOW + UPDATE_CHECK_INTERVAL_MS);
    expect(isCheckDue(state, NOW + FIRST_CHECK_DELAY_MS, NOW)).toBe(false);
  });
});

describe("isLatestFresh: latest read recently enough to switch on (review F4)", () => {
  it("is fresh for LATEST_FRESH_MS after a read, and never without one", () => {
    expect(isLatestFresh({ checkedAt: null }, NOW)).toBe(false);
    expect(isLatestFresh({ checkedAt: "not a date" }, NOW)).toBe(false);
    expect(isLatestFresh({ checkedAt: iso(NOW) }, NOW)).toBe(true);
    expect(isLatestFresh({ checkedAt: iso(NOW) }, NOW + LATEST_FRESH_MS - 1)).toBe(true);
    expect(isLatestFresh({ checkedAt: iso(NOW) }, NOW + LATEST_FRESH_MS)).toBe(false);
  });
});

function heartbeat(change: Partial<ChildHeartbeat> = {}): ChildHeartbeat {
  return {
    ts: iso(NOW - 5_000),
    pid: 4242,
    version: "0.19.0",
    wsConnected: true,
    busy: false,
    lastActivityAt: iso(NOW - QUIET_WINDOW_MS - 1),
    ...change,
  };
}

describe("decideSafeMoment (finding 9: never restart mid job)", () => {
  const table: Array<[string, ChildHeartbeat | null, number | null, unknown]> = [
    ["fresh, idle and quiet for 10 minutes", heartbeat(), 4242, { safe: true }],
    ["no child running", heartbeat(), null, { safe: false, reason: "no_child" }],
    ["no heartbeat file", null, 4242, { safe: false, reason: "heartbeat_missing" }],
    ["a heartbeat from another process (the previous child)", heartbeat({ pid: 1 }), 4242, { safe: false, reason: "heartbeat_other_process" }],
    ["a stale heartbeat", heartbeat({ ts: iso(NOW - HEARTBEAT_FRESH_MS - 1) }), 4242, { safe: false, reason: "heartbeat_stale" }],
    ["an unreadable heartbeat time", heartbeat({ ts: "soon" }), 4242, { safe: false, reason: "heartbeat_stale" }],
    // Review F2: offline, a backend outage or a fatal latch looks idle and
    // quiet, but the new version could never confirm, so a good release
    // would be rolled back and latched for good.
    ["not connected to BGOS", heartbeat({ wsConnected: false }), 4242, { safe: false, reason: "disconnected" }],
    ["connection unknown (an old child)", heartbeat({ wsConnected: undefined }), 4242, { safe: false, reason: "disconnected" }],
    ["a chat is busy", heartbeat({ busy: true }), 4242, { safe: false, reason: "busy" }],
    ["busy unknown (an old child)", heartbeat({ busy: undefined }), 4242, { safe: false, reason: "busy" }],
    ["activity 9 minutes ago", heartbeat({ lastActivityAt: iso(NOW - 9 * 60_000) }), 4242, { safe: false, reason: "recent_activity" }],
    ["activity unknown", heartbeat({ lastActivityAt: undefined }), 4242, { safe: false, reason: "recent_activity" }],
  ];
  for (const [name, hb, childPid, expected] of table)
    it(name, () => {
      expect(decideSafeMoment({ heartbeat: hb, childPid, nowMs: NOW })).toEqual(expected);
    });
});

describe("decideApply: apply at a safe moment, otherwise wait", () => {
  const base = {
    enabled: true,
    supervised: "launchd" as const,
    managedRuntime: true,
    stagedVersion: "0.19.2" as string | null,
    latest: "0.19.2" as string | null,
    current: "0.19.0",
    rolledBack: [] as string[],
    safety: { safe: true } as ReturnType<typeof decideSafeMoment>,
  };
  const table: Array<[string, Partial<typeof base>, unknown]> = [
    ["staged and safe", {}, { action: "apply", version: "0.19.2" }],
    ["staged but busy", { safety: { safe: false, reason: "busy" } }, { action: "wait", reason: "busy" }],
    ["staged but recently active", { safety: { safe: false, reason: "recent_activity" } }, { action: "wait", reason: "recent_activity" }],
    ["nothing staged", { stagedVersion: null }, { action: "none", reason: "nothing_staged" }],
    ["auto update off", { enabled: false }, { action: "none", reason: "disabled" }],
    ["not under the installed service (nothing would restart it)", { supervised: "none" }, { action: "none", reason: "unsupervised" }],
    ["not a managed runtime (npx, global, dev checkout)", { managedRuntime: false }, { action: "none", reason: "unmanaged_runtime" }],
    ["the staged version was rolled back since", { rolledBack: ["0.19.2"] }, { action: "none", reason: "stale_stage" }],
    ["the staged version is no longer newer", { current: "0.19.2" }, { action: "none", reason: "stale_stage" }],
    // Review F4 (D7: latest is the curated pin): a release pulled by moving
    // latest back is never applied from an older stage.
    ["latest moved back from the staged version (a pulled release)", { latest: "0.19.0" }, { action: "none", reason: "stale_stage" }],
    ["latest moved to another major", { latest: "1.0.0" }, { action: "none", reason: "stale_stage" }],
    ["latest is no longer a plain version", { latest: null }, { action: "none", reason: "stale_stage" }],
  ];
  for (const [name, change, expected] of table)
    it(name, () => {
      expect(decideApply({ ...base, ...change })).toEqual(expected);
    });
});

describe("decideConfirmation: the new supervisor confirms health or rolls back", () => {
  const started = NOW - 30_000;
  const pending = {
    version: "0.19.2",
    previousVersion: "0.19.0",
    appliedAt: iso(started - 15_000),
    boots: 1,
  };
  const healthy = heartbeat({ version: "0.19.2", ts: iso(NOW - 1000) });
  const table: Array<[string, Partial<Parameters<typeof decideConfirmation>[0]>, unknown]> = [
    ["the new child connected", {}, "confirmed"],
    ["not connected yet, inside 3 minutes", { heartbeat: { ...healthy, wsConnected: false } }, "wait"],
    ["not connected after 3 minutes", { heartbeat: { ...healthy, wsConnected: false }, nowMs: started + CONFIRM_WINDOW_MS }, "rollback"],
    ["still the old version answering", { heartbeat: { ...healthy, version: "0.19.0" } }, "wait"],
    ["a heartbeat from before this supervisor started", { heartbeat: { ...healthy, ts: iso(started - 1) } }, "wait"],
    ["a heartbeat from another process", { heartbeat: { ...healthy, pid: 1 } }, "wait"],
    ["no heartbeat after 3 minutes", { heartbeat: null, nowMs: started + CONFIRM_WINDOW_MS }, "rollback"],
    ["a supervisor that keeps crashing before it can confirm", { pending: { ...pending, boots: CONFIRM_MAX_BOOTS + 1 } }, "rollback"],
    // Review F3: once a rollback was decided and failed, it is retried; a
    // child that connects in between never turns it into a confirmation.
    ["a rollback that failed once is tried again, even with a healthy child", { pending: { ...pending, rollbackFailures: 1 } }, "rollback"],
  ];
  for (const [name, change, expected] of table)
    it(name, () => {
      expect(
        decideConfirmation({
          pending,
          heartbeat: healthy,
          childPid: 4242,
          startedAtMs: started,
          nowMs: NOW,
          ...change,
        }),
      ).toBe(expected);
    });
});

describe("decideRollbackStop: a rollback never kills a busy child either", () => {
  const table: Array<[string, Parameters<typeof decideRollbackStop>[0], unknown]> = [
    ["the child agreed to stop", { reply: "stopping", heartbeat: heartbeat(), childPid: 4242, nowMs: NOW }, "proceed"],
    ["no child is running", { reply: "unavailable", heartbeat: null, childPid: null, nowMs: NOW }, "proceed"],
    ["the child is busy", { reply: "busy", heartbeat: heartbeat(), childPid: 4242, nowMs: NOW }, "wait"],
    ["silent child, its heartbeat says busy", { reply: "unavailable", heartbeat: heartbeat({ busy: true }), childPid: 4242, nowMs: NOW }, "wait"],
    ["silent child, nothing says it is busy", { reply: "unavailable", heartbeat: heartbeat(), childPid: 4242, nowMs: NOW }, "force"],
    ["silent child, a stale busy heartbeat", { reply: "unavailable", heartbeat: heartbeat({ busy: true, ts: iso(NOW - HEARTBEAT_FRESH_MS - 1) }), childPid: 4242, nowMs: NOW }, "force"],
  ];
  for (const [name, input, expected] of table)
    it(name, () => {
      expect(decideRollbackStop(input)).toBe(expected);
    });
});

describe("resolveSupervised: running under supervise with the service installed for this home", () => {
  const label = "ai.hoai.codex.0123456789abcdef";
  const marker = { CODEX_BGOS_SERVICE: label };
  const table: Array<[string, Parameters<typeof resolveSupervised>[0], unknown]> = [
    ["macOS LaunchAgent", { platform: "darwin", env: marker, label, serviceInstalled: true }, "launchd"],
    ["Linux systemd user unit", { platform: "linux", env: marker, label, serviceInstalled: true }, "systemd"],
    // The backend's enum has no 'runkey' (it would read as 'none'); a
    // supervise loop on an npm runtime is its 'supervise-npm'.
    ["Windows Run key", { platform: "win32", env: marker, label, serviceInstalled: true }, "supervise-npm"],
    ["started by hand (no service marker)", { platform: "darwin", env: {}, label, serviceInstalled: true }, "none"],
    ["another home's service", { platform: "darwin", env: { CODEX_BGOS_SERVICE: "ai.hoai.codex.other" }, label, serviceInstalled: true }, "none"],
    ["the service file was removed", { platform: "linux", env: marker, label, serviceInstalled: false }, "none"],
    ["an unsupported platform", { platform: "freebsd", env: marker, label, serviceInstalled: true }, "none"],
  ];
  for (const [name, input, expected] of table)
    it(name, () => {
      expect(resolveSupervised(input)).toBe(expected);
    });
});

describe("updateReportFromState: what the child puts on its heartbeat", () => {
  const state = {
    ...emptyUpdateState(),
    supervisorPid: 900,
    supervised: "launchd" as const,
    autoUpdateEnabled: true,
    latestKnownVersion: "0.19.2",
    stagedVersion: "0.19.2",
  };
  it("reports the supervisor's state when it is this child's supervisor", () => {
    expect(updateReportFromState(state, 900)).toEqual({
      latestKnownVersion: "0.19.2",
      updateReadiness: {
        supervised: "launchd",
        autoUpdateEnabled: true,
        rollbackLatched: false,
        pendingRestartVersion: "0.19.2",
      },
    });
  });
  it("latches when the newest version is one that was rolled back here", () => {
    expect(
      updateReportFromState({ ...state, stagedVersion: null, rolledBack: ["0.19.2"] }, 900)
        .updateReadiness.rollbackLatched,
    ).toBe(true);
    expect(
      updateReportFromState({ ...state, stagedVersion: null, rolledBack: ["0.19.1"] }, 900)
        .updateReadiness.rollbackLatched,
    ).toBe(false);
  });
  it("names no pending restart when auto update is off", () => {
    expect(
      updateReportFromState({ ...state, autoUpdateEnabled: false }, 900)
        .updateReadiness.pendingRestartVersion,
    ).toBeNull();
  });
  const unsupervised = {
    latestKnownVersion: null,
    updateReadiness: {
      supervised: "none",
      autoUpdateEnabled: false,
      rollbackLatched: false,
      pendingRestartVersion: null,
    },
  };
  it("a foreground daemon (no supervisor) reports none and an unknown latest", () => {
    expect(updateReportFromState(state, null)).toEqual(unsupervised);
    expect(updateReportFromState(null, 900)).toEqual(unsupervised);
  });
  it("never trusts a state file another (or a dead) supervisor left", () => {
    expect(updateReportFromState(state, 901)).toEqual(unsupervised);
  });
});

describe("npm next to node", () => {
  it("posix layout: <prefix>/bin/node -> <prefix>/lib/node_modules/npm/bin/npm-cli.js", () => {
    const expected = posixJoin("/opt/node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    expect(npmCliPath("/opt/node/bin/node", "darwin", (p) => p === expected)).toBe(expected);
    expect(npmCliPath("/opt/node/bin/node", "linux", (p) => p === expected)).toBe(expected);
  });
  it("win32 layout: <dir>\\node.exe -> <dir>\\node_modules\\npm\\bin\\npm-cli.js", () => {
    const expected = winJoin("C:\\HOAI\\node", "node_modules", "npm", "bin", "npm-cli.js");
    expect(npmCliPath("C:\\HOAI\\node\\node.exe", "win32", (p) => p === expected)).toBe(expected);
  });
  it("is null when npm is not there (never a PATH guess)", () => {
    expect(npmCliPath("/opt/node/bin/node", "darwin", () => false)).toBeNull();
  });

  // Homebrew's node runs from its keg (process.execPath is the resolved
  // /opt/homebrew/Cellar/node/<v>/bin/node), whose lib holds no npm: the
  // keg's bin/npm links to <brew prefix>/lib/node_modules/npm, and the
  // formula keeps its own copy in <keg>/libexec. Measured on this Mac
  // (node 25.6.1_1), 2026-10-07.
  const cli = ["npm", "bin", "npm-cli.js"];
  const KEG = "/opt/homebrew/Cellar/node/25.6.1_1";
  const BREW_NODE = `${KEG}/bin/node`;
  const KEG_LIB = posixJoin(KEG, "lib", "node_modules", ...cli);
  const BREW_PREFIX = posixJoin("/opt/homebrew", "lib", "node_modules", ...cli);
  const LIBEXEC = posixJoin(KEG, "libexec", "lib", "node_modules", ...cli);
  const DEBIAN = posixJoin("/usr", "share", "nodejs", ...cli);
  const table: Array<[string, string, string, string[], string | null]> = [
    ["a plain prefix (official installer, nvm, the HOAI private node)", "/opt/node/bin/node", "darwin", [posixJoin("/opt/node", "lib", "node_modules", ...cli)], posixJoin("/opt/node", "lib", "node_modules", ...cli)],
    ["Homebrew: the brew prefix's npm, the one the keg's bin/npm runs", BREW_NODE, "darwin", [BREW_PREFIX, LIBEXEC], BREW_PREFIX],
    ["Homebrew without the prefix copy (post install never ran): the keg's own libexec copy", BREW_NODE, "darwin", [LIBEXEC], LIBEXEC],
    ["Homebrew: an npm inside the keg itself still comes first", BREW_NODE, "darwin", [KEG_LIB, BREW_PREFIX, LIBEXEC], KEG_LIB],
    ["Intel Homebrew under /usr/local", "/usr/local/Cellar/node/22.9.0/bin/node", "darwin", [posixJoin("/usr/local", "lib", "node_modules", ...cli)], posixJoin("/usr/local", "lib", "node_modules", ...cli)],
    ["Linuxbrew", "/home/linuxbrew/.linuxbrew/Cellar/node/22.9.0/bin/node", "linux", [posixJoin("/home/linuxbrew/.linuxbrew", "lib", "node_modules", ...cli)], posixJoin("/home/linuxbrew/.linuxbrew", "lib", "node_modules", ...cli)],
    ["a node outside a Cellar never looks for a brew prefix", "/opt/x/node/25.6.1/bin/node", "darwin", [posixJoin("/opt", "lib", "node_modules", ...cli)], null],
    ["Windows: <dir>\\node_modules\\npm only", "C:\\HOAI\\node\\node.exe", "win32", [winJoin("C:\\HOAI\\node", "node_modules", ...cli)], winJoin("C:\\HOAI\\node", "node_modules", ...cli)],
    ["Homebrew with no npm anywhere", BREW_NODE, "darwin", [], null],
    // Debian 13, Ubuntu 25.10 and 26.04 (apt's nodejs and npm, node 20 or
    // newer, so the desktop installer keeps it): npm lives under
    // /usr/share/nodejs, and /usr/lib/node_modules holds nothing (review F8).
    ["Debian and Ubuntu apt: /usr/share/nodejs/npm", "/usr/bin/node", "linux", [DEBIAN], DEBIAN],
    ["an official layout under /usr still comes first", "/usr/bin/node", "linux", [posixJoin("/usr", "lib", "node_modules", ...cli), DEBIAN], posixJoin("/usr", "lib", "node_modules", ...cli)],
  ];
  for (const [name, execPath, platform, present, expected] of table)
    it(name, () => {
      expect(npmCliPath(execPath, platform, (p) => present.includes(p))).toBe(expected);
    });

  it("looks in a defined order, and only there", () => {
    expect(npmCliCandidates(BREW_NODE, "darwin")).toEqual([KEG_LIB, BREW_PREFIX, LIBEXEC]);
    expect(npmCliCandidates("/opt/node/bin/node", "linux")).toEqual([
      posixJoin("/opt/node", "lib", "node_modules", ...cli),
      posixJoin("/opt/node", "share", "nodejs", ...cli),
    ]);
    expect(npmCliCandidates("C:\\HOAI\\node\\node.exe", "win32")).toEqual([
      winJoin("C:\\HOAI\\node", "node_modules", ...cli),
    ]);
  });
  it("stages the new connector next to the codex version already installed", () => {
    expect(
      stageInstallArgs({
        npmCli: "/n/npm-cli.js",
        prefix: "/h/runtime.next",
        version: "0.19.2",
        codexVersion: "0.154.0",
      }),
    ).toEqual([
      "/n/npm-cli.js",
      "install",
      "--prefix",
      "/h/runtime.next",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "codex-channel-bgos@0.19.2",
      "@openai/codex@0.154.0",
    ]);
  });
});

describe("supervisorPidFromEnv: the child trusts only the pid supervise handed it", () => {
  const table: Array<[string | undefined, number | null]> = [
    ["4321", 4321],
    [undefined, null],
    ["", null],
    ["0", null],
    ["-5", null],
    ["12abc", null],
    ["99999999999", null],
  ];
  for (const [raw, expected] of table)
    it(`${JSON.stringify(raw)} -> ${expected}`, () => {
      expect(
        supervisorPidFromEnv(
          raw === undefined ? {} : { CODEX_BGOS_SUPERVISOR_PID: raw },
        ),
      ).toBe(expected);
    });
});
