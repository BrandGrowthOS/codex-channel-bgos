import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AppServer, codexEnvironment, codexExecutable } from "../app-server.js";
import { pairBgos } from "../pair-cli.js";
import { BgosApi } from "../bgos-api.js";
import {
  agentHome,
  saveSettings,
  validateSettings,
  settingsForSetup,
} from "./settings.js";
import { installBackgroundService } from "./background-service.js";
import { verifyModel } from "./verify-model.js";

export function progress(
  stage: string,
  extra: Record<string, unknown> = {},
): void {
  process.stdout.write(
    `::hoai-codex::${JSON.stringify({ stage, ...extra })}\n`,
  );
}
export async function setupAgent(): Promise<void> {
  const phase = process.env.BGOS_CODEX_SETUP_PHASE ?? "all";
  if (!["all", "prepare", "finish"].includes(phase))
    throw new Error("Unknown setup phase.");
  const raw = JSON.parse(process.env.BGOS_CODEX_SETUP ?? "null");
  const requested = validateSettings(raw);
  const code = process.env.BGOS_SETUP_CODE;
  delete process.env.BGOS_SETUP_CODE;
  const home = process.env.CODEX_BGOS_HOME || agentHome(requested.assistantId);
  const settings = settingsForSetup(raw, home);
  process.env.CODEX_BGOS_HOME = home;
  settings.executable = codexExecutable(
    process.platform,
    process.arch,
    join(home, "runtime"),
  );
  mkdirSync(settings.workdir, { recursive: true });
  if (phase !== "finish") {
    progress("signin");
    const server = new AppServer({
      cwd: settings.workdir,
      env: codexEnvironment(),
      command: settings.executable,
    });
    const close = () => {
      server.close();
      process.exit(130);
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
    try {
      await server.start();
      const account = await server.request("account/read", {
        refreshToken: true,
      });
      if (!account.account) {
        let finish: (err?: Error) => void = () => {};
        const loggedIn = new Promise<void>((resolve, reject) => {
          finish = (err) => (err ? reject(err) : resolve());
        });
        // Install listener before starting OAuth: a fast existing browser login cannot be lost.
        const listener = (method: string, params: Record<string, unknown>) => {
          if (method === "account/login/completed")
            finish(
              params.success
                ? undefined
                : new Error("Codex sign-in did not complete. Try again."),
            );
        };
        server.on("notification", listener);
        const timer = setTimeout(
          () =>
            finish(new Error("Sign-in timed out. Retry when you are ready.")),
          10 * 60_000,
        );
        try {
          const login = await server.request("account/login/start", {
            type: "chatgpt",
          });
          progress("signin", { authUrl: login.authUrl });
          await loggedIn;
        } finally {
          clearTimeout(timer);
          server.off("notification", listener);
        }
      }
      progress("checking");
      await server.request("model/list", {});
      await verifyModel(server, settings.model);
    } finally {
      server.close();
      process.off("SIGTERM", close);
      process.off("SIGINT", close);
    }
  }
  saveSettings(home, settings);
  if (phase === "prepare") {
    progress("prepared", { assistantId: settings.assistantId });
    return;
  }
  progress("pairing");
  const secrets = join(home, "secrets", "bgos.json");
  let paired = false;
  try {
    const saved = JSON.parse(readFileSync(secrets, "utf8"));
    if (saved.baseUrl === settings.baseUrl) {
      const api = new BgosApi({
        baseUrl: saved.baseUrl,
        pairingToken: saved.pairingToken,
        reconnect: { initialDelayMs: 1000, maxDelayMs: 30000 },
      });
      const me = await api.whoami();
      paired =
        me.assistants?.length === 1 &&
        me.assistants[0].assistant_id === settings.assistantId;
    }
  } catch {}
  if (!paired) {
    if (!code || !/^BGOS-[A-Z0-9-]+$/.test(code))
      throw new Error("The pairing code is missing. Retry setup in HOAI.");
    await pairBgos({
      baseUrl: settings.baseUrl,
      code,
      assistantId: settings.assistantId,
      deviceLabel: `${settings.name} (Codex)`,
      agentCatalog: [
        { agent_route: `codex-${settings.assistantId}`, name: settings.name },
      ],
      secretsDir: join(home, "secrets"),
    });
  }
  // Never start a service for the wrong assistant, even if a server returned success.
  const saved = JSON.parse(readFileSync(secrets, "utf8"));
  const api = new BgosApi({
    baseUrl: settings.baseUrl,
    pairingToken: saved.pairingToken,
    reconnect: { initialDelayMs: 1000, maxDelayMs: 30000 },
  });
  const me = await api.whoami();
  if (
    me.assistants?.length !== 1 ||
    me.assistants[0].assistant_id !== settings.assistantId
  )
    throw new Error(
      "Pairing did not return the selected agent. Setup stopped without starting a service.",
    );
  settings.route =
    me.assistants[0].agent_route ?? `codex-${settings.assistantId}`;
  saveSettings(home, settings);
  progress("starting");
  const startedAt = Date.now();
  await installBackgroundService(home);
  progress("verifying");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const heartbeat = JSON.parse(
        readFileSync(join(home, "bgos_heartbeat.json"), "utf8"),
      );
      if (
        heartbeat.wsConnected &&
        Date.parse(heartbeat.ts) >= startedAt &&
        heartbeat.pairingId === me.pairing_id &&
        !heartbeat.lastError
      ) {
        progress("ready", {
          assistantId: settings.assistantId,
          workdir: settings.workdir,
        });
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    "Codex is installed but did not connect to HOAI. Check the connection and retry; your agent and folder are preserved.",
  );
}
