import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  renderLaunchAgent,
  renderWindowsLauncher,
  serviceLabel,
} from "../src/setup/background-service.js";
import {
  validateSettings,
  saveSettings,
  readSettings,
  settingsForSetup,
} from "../src/setup/settings.js";
let directories: string[] = [];
afterEach(() => {
  directories
    .splice(0)
    .forEach((p) => rmSync(p, { recursive: true, force: true }));
});
const dir = () => {
  const p = mkdtempSync(join(tmpdir(), "HOAI Renée & Co "));
  directories.push(p);
  return p;
};
describe("desktop setup persistence", () => {
  it("repairs the same agent without changing its custom workspace or model", () => {
    const home = dir(),
      workdir = dir();
    saveSettings(
      home,
      validateSettings({
        assistantId: 9,
        name: "Before",
        workdir,
        model: "chosen-model",
        baseUrl: "https://api.example.com",
      }),
    );
    expect(
      settingsForSetup(
        {
          assistantId: 9,
          name: "After",
          workdir: "",
          baseUrl: "https://api.example.com",
        },
        home,
      ),
    ).toMatchObject({ name: "After", workdir, model: "chosen-model" });
    expect(() =>
      settingsForSetup({ assistantId: 10, name: "Other" }, home),
    ).toThrow("another agent");
  });
  it("stores literal folder names and keeps agent identities isolated", () => {
    const home = dir();
    const settings = validateSettings({
      assistantId: 9,
      name: "Renée & Co",
      workdir: home,
      baseUrl: "http://127.0.0.1:58080/api/v1",
    });
    saveSettings(home, settings);
    expect(readSettings(home)).toEqual(settings);
    expect(settings.baseUrl).toBe("http://127.0.0.1:58080");
    expect(serviceLabel(home)).not.toBe(serviceLabel(home + "-other"));
  });
  it("refuses invalid identity, relative folders and credential-bearing server URLs", () => {
    const base = {
      assistantId: 9,
      name: "Agent",
      workdir: dir(),
      baseUrl: "https://api.example.com",
    };
    for (const change of [
      { assistantId: 0 },
      { assistantId: "../escape" },
      { workdir: "relative" },
      { baseUrl: "https://user:secret@example.com" },
      { name: "name\ncommand" },
    ])
      expect(() => validateSettings({ ...base, ...change })).toThrow();
  });
  it("reports malformed saved settings instead of silently starting in another workspace", () => {
    const home = dir();
    writeFileSync(join(home, "agent.json"), "invalid");
    expect(() => readSettings(home)).toThrow();
  });
  it("renders Mac arguments as separate escaped XML strings", () => {
    const plist = renderLaunchAgent(
      "/opt/My Runtime/node",
      "/Users/Renée & Co/agent.js",
      "/Users/Renée & Co/.codex-bgos/agents/9",
    );
    expect(plist).toContain(
      "Renée &amp; Co/agent.js</string><string>supervise</string><string>--home</string>",
    );
    expect(plist).toContain("/agents/9/logs/service.log");
    if (process.platform === "darwin") {
      const path = join(dir(), "agent.plist");
      writeFileSync(path, plist);
      expect(spawnSync("plutil", ["-lint", path]).status).toBe(0);
    }
  });
  it.skipIf(process.platform !== "win32")(
    "Windows hidden launcher preserves Unicode and spaces in actual process arguments",
    async () => {
      const home = dir(),
        cli = join(home, "test agent.cjs"),
        out = join(home, "arguments.json"),
        vbs = join(home, "launch.vbs");
      writeFileSync(
        cli,
        "require('fs').writeFileSync(require('path').join(__dirname,'arguments.json'),JSON.stringify(process.argv.slice(2)))",
      );
      writeFileSync(
        vbs,
        Buffer.from(
          "\ufeff" + renderWindowsLauncher(process.execPath, cli, home),
          "utf16le",
        ),
      );
      expect(
        spawnSync("wscript.exe", [vbs], { windowsHide: true }).status,
      ).toBe(0);
      const deadline = Date.now() + 5000;
      while (!existsSync(out) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([
        "supervise",
        "--home",
        home,
      ]);
    },
  );
});
