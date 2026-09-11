import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

export interface AgentSettings {
  assistantId: number;
  name: string;
  workdir: string;
  baseUrl: string;
  model?: string;
  executable?: string;
  route?: string;
}
export function agentHome(assistantId: number): string {
  return join(homedir(), ".codex-bgos", "agents", String(assistantId));
}
export function validateSettings(raw: unknown): AgentSettings {
  const value = raw as Partial<AgentSettings> | null;
  if (
    !value ||
    !Number.isSafeInteger(value.assistantId) ||
    value.assistantId! < 1
  )
    throw new Error("Choose an agent before starting setup.");
  if (
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 60 ||
    /[\x00-\x1f]/.test(value.name)
  )
    throw new Error("Use an agent name between 1 and 60 characters.");
  const root = agentHome(value.assistantId!);
  const workdir = value.workdir || join(root, "workspace");
  if (!isAbsolute(workdir) || /[\x00-\x1f]/.test(workdir))
    throw new Error("Choose an absolute folder path.");
  const url = new URL(value.baseUrl ?? "https://api.brandgrowthos.ai");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("Use HTTPS for the HOAI server.");
  if (
    value.executable &&
    (!isAbsolute(value.executable) || /[\x00-\x1f]/.test(value.executable))
  )
    throw new Error("Invalid Codex runtime path.");
  if (value.route && !/^[a-zA-Z0-9_-]{1,128}$/.test(value.route))
    throw new Error("Invalid agent route.");
  return {
    assistantId: value.assistantId!,
    name: value.name.trim(),
    workdir: resolve(workdir),
    baseUrl: url.href.replace(/\/api\/v1\/?$/, "").replace(/\/$/, ""),
    ...(value.model ? { model: value.model } : {}),
    ...(value.executable ? { executable: value.executable } : {}),
    ...(value.route ? { route: value.route } : {}),
  };
}
export function readSettings(home: string): AgentSettings | null {
  const path = join(home, "agent.json");
  if (!existsSync(path)) return null;
  return validateSettings(JSON.parse(readFileSync(path, "utf8")));
}
/** A repair with no new folder keeps the existing workspace and model. */
export function settingsForSetup(raw: unknown, home: string): AgentSettings {
  const requested = validateSettings(raw);
  const previous = readSettings(home);
  if (previous && previous.assistantId !== requested.assistantId)
    throw new Error("This installation belongs to another agent.");
  const input = raw as Partial<AgentSettings>;
  return validateSettings({
    ...previous,
    ...input,
    workdir: input.workdir || previous?.workdir || requested.workdir,
  });
}
export function saveSettings(home: string, settings: AgentSettings): void {
  mkdirSync(home, { recursive: true });
  const target = join(home, "agent.json"),
    temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  renameSync(temp, target);
}
