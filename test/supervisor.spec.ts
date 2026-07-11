import { describe, it, expect } from "vitest";
import {
  pickSupervisor,
  renderLaunchdPlist,
  renderSystemdUnit,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
} from "../src/setup/supervisor.js";

const opts = {
  nodePath: "/usr/local/bin/node",
  cliEntry: "/opt/pkg/dist/cli.js",
  home: "/home/kc/.codex-bgos",
};

describe("supervisor rendering", () => {
  it("picks launchd on darwin, systemd on linux, manual elsewhere", () => {
    expect(pickSupervisor("darwin")).toBe("launchd");
    expect(pickSupervisor("linux")).toBe("systemd");
    expect(pickSupervisor("win32")).toBe("manual");
  });

  it("renders a launchd plist that runs `node cli.js start` and keeps alive", () => {
    const plist = renderLaunchdPlist(opts);
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/opt/pkg/dist/cli.js</string>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("/home/kc/.codex-bgos/logs/codex-bgos.log");
  });

  it("renders a systemd unit with ExecStart, Restart=always and default target", () => {
    const unit = renderSystemdUnit(opts);
    expect(unit).toContain(
      "ExecStart=/usr/local/bin/node /opt/pkg/dist/cli.js start",
    );
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(SYSTEMD_UNIT).toBe("codex-bgos.service");
  });

  it("does not use the OpenAI codex home path for its label (no collision)", () => {
    expect(LAUNCHD_LABEL).toContain("codex-bgos");
    expect(LAUNCHD_LABEL).not.toBe("codex");
  });
});
