import {
  execFile,
  type ExecFileException,
} from "node:child_process";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BgosApi } from "./bgos-api.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9@._\/-]{1,200}$/;
const LIST_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 120_000;
const PAGE_SIZE = 30;
const SEEN_RPC_LIMIT = 256;
const INSTALL_NOTE = "Installed for every Codex session on this computer";
const RESULT_RETRY_OFFSETS_MS = [0, 2_000, 5_000, 10_000] as const;
const RESULT_REQUEST_TIMEOUT_MS = 3_000;
const RESULT_DEADLINE_MS_BY_OP: Record<string, number> = {
  list_installed: 20_000,
  catalog: 20_000,
  remove: 30_000,
  install: 300_000,
};
const DEFAULT_RESULT_DEADLINE_MS = 20_000;

const TARGET_BY_RUNTIME: Record<string, string> = {
  "android:arm64": "aarch64-unknown-linux-musl",
  "android:x64": "x86_64-unknown-linux-musl",
  "darwin:arm64": "aarch64-apple-darwin",
  "darwin:x64": "x86_64-apple-darwin",
  "linux:arm64": "aarch64-unknown-linux-musl",
  "linux:x64": "x86_64-unknown-linux-musl",
  "win32:arm64": "aarch64-pc-windows-msvc",
  "win32:x64": "x86_64-pc-windows-msvc",
};

const PACKAGE_BY_TARGET: Record<string, string> = {
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
};

export interface SkillsRpcFrame {
  rpcId: string;
  op: string;
  assistantId: string;
  payload: {
    query?: string;
    page?: number;
    identifier?: string;
    name?: string;
  };
}

export interface SkillsRpcResultBody {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface SkillsHandlerDeps {
  api: Pick<
    BgosApi,
    "skillsRpcAck" | "skillsRpcProgress" | "skillsRpcResult"
  >;
  execFileImpl?: typeof execFile;
  codexBin?: string;
  log?: (message: string) => void;
  nowImpl?: () => number;
  readFileImpl?: ReadFileImpl;
  sleepImpl?: (delayMs: number) => Promise<void>;
}

type ReadFileImpl = (path: string, encoding: "utf8") => Promise<string>;

interface CommandOutput {
  stdout: string;
  stderr: string;
}

interface PluginEntry extends Record<string, unknown> {
  pluginId?: unknown;
  name?: unknown;
  marketplaceName?: unknown;
  version?: unknown;
  installed?: unknown;
  interface?: unknown;
  source?: unknown;
}

interface PluginManifestMetadata {
  description?: string;
  publisher?: string;
  category?: string;
}

type ManifestCache = Map<string, Promise<PluginManifestMetadata>>;

class CommandFailure extends Error {
  readonly stdout: string;
  readonly stderr: string;

  constructor(error: unknown, stdout: string, stderr: string) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "CommandFailure";
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveSdkAnchor(): string | undefined {
  if (typeof import.meta.resolve === "function") {
    try {
      return import.meta.resolve("@openai/codex-sdk");
    } catch {
      // Fall through to the module-path walk.
    }
  }

  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const packageJson = join(
      directory,
      "node_modules",
      "@openai",
      "codex-sdk",
      "package.json",
    );
    if (isFile(packageJson)) return packageJson;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Resolve the native CLI bundled by @openai/codex-sdk. */
export function resolveCodexBin(): string {
  const override = process.env.CODEX_BGOS_CODEX_BIN?.trim();
  if (override) return override;

  const target = TARGET_BY_RUNTIME[`${process.platform}:${process.arch}`];
  const platformPackage = target ? PACKAGE_BY_TARGET[target] : undefined;
  if (!target || !platformPackage) return "codex";

  try {
    const sdkAnchor = resolveSdkAnchor();
    if (!sdkAnchor) return "codex";
    const sdkRequire = createRequire(sdkAnchor);
    const codexPackageJson = sdkRequire.resolve("@openai/codex/package.json");
    const codexRequire = createRequire(codexPackageJson);
    const platformPackageJson = codexRequire.resolve(
      `${platformPackage}/package.json`,
    );
    const packageRoot = join(dirname(platformPackageJson), "vendor", target);
    const executable = process.platform === "win32" ? "codex.exe" : "codex";
    const current = join(packageRoot, "bin", executable);
    if (isFile(current) && isFile(join(packageRoot, "codex-package.json"))) {
      return current;
    }
    const legacy = join(packageRoot, "codex", executable);
    if (isFile(legacy)) return legacy;
  } catch {
    // A global codex executable remains a valid fallback.
  }
  return "codex";
}

/** Normalize a skills_rpc control frame without whitelisting its operation. */
export function normalizeSkillsRpc(raw: unknown): SkillsRpcFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const rpcId = typeof value.rpcId === "string" ? value.rpcId : "";
  if (!rpcId || typeof value.op !== "string") return null;
  return {
    rpcId,
    op: value.op,
    assistantId: String(value.assistantId ?? ""),
    payload:
      value.payload && typeof value.payload === "object"
        ? (value.payload as SkillsRpcFrame["payload"])
        : {},
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pluginId(entry: PluginEntry): string | undefined {
  return asString(entry.pluginId, entry.identifier);
}

function pluginName(entry: PluginEntry): string {
  return asString(entry.name, pluginId(entry)) ?? "";
}

function pluginDescription(entry: PluginEntry): string {
  const interfaceMetadata = asRecord(entry.interface);
  return (
    asString(
      interfaceMetadata?.description,
      interfaceMetadata?.shortDescription,
      interfaceMetadata?.short_description,
    ) ?? ""
  );
}

function manifestPath(entry: PluginEntry): string | undefined {
  const source = asRecord(entry.source);
  if (source?.source !== "local") return undefined;
  const path = asString(source.path);
  return path ? join(path, ".codex-plugin", "plugin.json") : undefined;
}

async function readManifestMetadata(
  path: string,
  readFileImpl: ReadFileImpl,
): Promise<PluginManifestMetadata> {
  try {
    const manifest = asRecord(JSON.parse(await readFileImpl(path, "utf8")));
    if (!manifest) return {};
    const interfaceMetadata = asRecord(manifest.interface);
    const author = asRecord(manifest.author);
    const description = asString(
      manifest.description,
      interfaceMetadata?.description,
      interfaceMetadata?.shortDescription,
    );
    const publisher = asString(
      manifest.publisher,
      interfaceMetadata?.publisher,
      interfaceMetadata?.developerName,
      manifest.author,
      author?.name,
    );
    const category = asString(
      manifest.category,
      interfaceMetadata?.category,
    );
    return {
      description: description ? truncate(description) : undefined,
      publisher,
      category,
    };
  } catch {
    return {};
  }
}

function manifestMetadata(
  entry: PluginEntry,
  cache: ManifestCache,
  readFileImpl: ReadFileImpl,
): Promise<PluginManifestMetadata> {
  const path = manifestPath(entry);
  if (!path) return Promise.resolve({});
  let metadata = cache.get(path);
  if (!metadata) {
    metadata = readManifestMetadata(path, readFileImpl);
    cache.set(path, metadata);
  }
  return metadata;
}

function parseJsonObject(stdout: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("invalid Codex plugin JSON response");
  }
  const object = asRecord(parsed);
  if (!object) throw new Error("invalid Codex plugin JSON response");
  return object;
}

function entriesAt(
  object: Record<string, unknown>,
  key: string,
): PluginEntry[] | null {
  const value = object[key];
  if (!Array.isArray(value)) return null;
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is PluginEntry => entry !== null);
}

function installedEntries(object: Record<string, unknown>): PluginEntry[] {
  const raw = object.installed;
  const entries = entriesAt(object, "installed");
  if (!Array.isArray(raw) || !entries || entries.length !== raw.length) {
    throw new Error("invalid Codex plugin list response");
  }
  return entries;
}

function installedIds(entries: PluginEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = pluginId(entry);
    if (id) ids.add(id);
  }
  return ids;
}

function catalogEntries(object: Record<string, unknown>): {
  entries: PluginEntry[];
  installed: Set<string>;
} {
  const installed = installedEntries(object);
  const explicitCatalog =
    entriesAt(object, "available") ??
    entriesAt(object, "items") ??
    entriesAt(object, "plugins") ??
    entriesAt(object, "catalog");

  if (!explicitCatalog) {
    return {
      entries: installed,
      installed: installedIds(
        installed.filter((entry) => entry.installed === true),
      ),
    };
  }

  const byId = new Map<string, PluginEntry>();
  for (const entry of [...explicitCatalog, ...installed]) {
    const id = pluginId(entry);
    if (id && !byId.has(id)) byId.set(id, entry);
  }
  return { entries: [...byId.values()], installed: installedIds(installed) };
}

function truncate(value: string): string {
  return value.slice(0, 300);
}

function errorDetail(error: unknown): string {
  if (error instanceof CommandFailure) {
    const detail = error.stderr.trim() || error.stdout.trim() || error.message;
    return truncate(detail || "Codex plugin command failed");
  }
  const detail = error instanceof Error ? error.message : String(error);
  return truncate(detail || "Codex plugin command failed");
}

function isNotFoundError(error: unknown): boolean {
  if (error instanceof CommandFailure) {
    return /not\s+found/i.test(error.stderr);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return /not\s+found/i.test(detail);
}

function failure(code: string, message: string): SkillsRpcResultBody {
  return { ok: false, error: { code, message: truncate(message) } };
}

function runCommand(
  execFileImpl: typeof execFile,
  bin: string,
  args: string[],
  timeout: number,
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    try {
      execFileImpl(
        bin,
        args,
        { timeout },
        (error: ExecFileException | null, stdout, stderr) => {
          const stdoutText = String(stdout);
          const stderrText = String(stderr);
          if (error) {
            reject(new CommandFailure(error, stdoutText, stderrText));
            return;
          }
          resolve({ stdout: stdoutText, stderr: stderrText });
        },
      );
    } catch (error) {
      reject(new CommandFailure(error, "", ""));
    }
  });
}

function rememberRpc(seen: Set<string>, rpcId: string): boolean {
  if (seen.has(rpcId)) return false;
  seen.add(rpcId);
  if (seen.size > SEEN_RPC_LIMIT) {
    const oldest = seen.values().next().value as string | undefined;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

/** Build a non-throwing handler for pairing-room skills_rpc frames. */
export function createSkillsHandler(deps: SkillsHandlerDeps) {
  const execFileImpl = deps.execFileImpl ?? execFile;
  const bin = deps.codexBin ?? resolveCodexBin();
  const nowImpl = deps.nowImpl ?? Date.now;
  const readFileImpl: ReadFileImpl =
    deps.readFileImpl ??
    ((path: string, encoding: "utf8") => readFile(path, encoding));
  const sleepImpl =
    deps.sleepImpl ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const seen = new Set<string>();

  const report = (message: string): void => {
    try {
      deps.log?.(truncate(message));
    } catch {
      // Logging must not affect control-plane handling.
    }
  };

  const postProgress = async (
    rpcId: string,
    stage: "starting" | "installing" | "verifying",
  ): Promise<void> => {
    try {
      await deps.api.skillsRpcProgress(rpcId, { stage });
    } catch (error) {
      report(`skills_rpc progress failed: ${errorDetail(error)}`);
    }
  };

  const listInstalled = async (): Promise<PluginEntry[]> => {
    const output = await runCommand(
      execFileImpl,
      bin,
      ["plugin", "list", "--json"],
      LIST_TIMEOUT_MS,
    );
    return installedEntries(parseJsonObject(output.stdout));
  };

  const handleListInstalled = async (): Promise<SkillsRpcResultBody> => {
    const entries = await listInstalled();
    const manifestCache: ManifestCache = new Map();
    const skills = await Promise.all(
      entries.map(async (entry) => {
        const manifest = await manifestMetadata(
          entry,
          manifestCache,
          readFileImpl,
        );
        const interfaceMetadata = asRecord(entry.interface);
        const skill: Record<string, unknown> = {
          name: truncate(pluginName(entry)),
          description: truncate(
            asString(pluginDescription(entry), manifest.description) ?? "",
          ),
          provenance: "plugin",
          removable: true,
        };
        const id = pluginId(entry);
        const publisher = asString(
          entry.publisher,
          interfaceMetadata?.publisher,
          interfaceMetadata?.developerName,
          manifest.publisher,
          entry.marketplaceName,
        );
        const category = asString(
          entry.category,
          interfaceMetadata?.category,
          manifest.category,
        );
        const version = asString(entry.version);
        if (id) {
          skill.identifier = truncate(id);
          skill.source = truncate(id);
        }
        if (publisher) skill.publisher = truncate(publisher);
        if (category) skill.category = truncate(category);
        if (version) skill.version = truncate(version);
        return skill;
      }),
    );
    return { ok: true, payload: { skills } };
  };

  const handleCatalog = async (
    payload: SkillsRpcFrame["payload"],
  ): Promise<SkillsRpcResultBody> => {
    const output = await runCommand(
      execFileImpl,
      bin,
      ["plugin", "list", "--available", "--json"],
      LIST_TIMEOUT_MS,
    );
    const catalog = catalogEntries(parseJsonObject(output.stdout));
    const manifestCache: ManifestCache = new Map();
    const mapped = (
      await Promise.all(
        catalog.entries.map(async (entry) => {
          const identifier = pluginId(entry);
          if (!identifier || !IDENTIFIER_PATTERN.test(identifier)) return [];
          const manifest = await manifestMetadata(
            entry,
            manifestCache,
            readFileImpl,
          );
          const item: Record<string, unknown> = {
            identifier,
            name: truncate(pluginName(entry)),
            description: truncate(
              asString(pluginDescription(entry), manifest.description) ?? "",
            ),
            source: truncate(asString(entry.marketplaceName) ?? ""),
            installed:
              entry.installed === true || catalog.installed.has(identifier),
          };
          const metadata = asRecord(entry.interface);
          const publisher = asString(
            entry.publisher,
            metadata?.publisher,
            metadata?.developerName,
            manifest.publisher,
          );
          const category = asString(
            entry.category,
            metadata?.category,
            manifest.category,
          );
          const trust = asString(entry.trust, metadata?.trust);
          if (publisher) item.publisher = truncate(publisher);
          if (category) item.category = truncate(category);
          if (trust) item.trust = truncate(trust);
          return [item];
        }),
      )
    ).flat();
    const query = payload.query?.trim().toLowerCase() ?? "";
    const filtered = query
      ? mapped.filter((item) =>
          `${String(item.name)} ${String(item.description)}`
            .toLowerCase()
            .includes(query),
        )
      : mapped;
    const requestedPage = payload.page;
    const page =
      typeof requestedPage === "number" &&
      Number.isFinite(requestedPage) &&
      requestedPage >= 1
        ? Math.floor(requestedPage)
        : 1;
    const total = filtered.length;
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const start = (page - 1) * PAGE_SIZE;
    return {
      ok: true,
      payload: {
        items: filtered.slice(start, start + PAGE_SIZE),
        page,
        totalPages,
        total,
      },
    };
  };

  const handleInstall = async (
    rpcId: string,
    payload: SkillsRpcFrame["payload"],
  ): Promise<SkillsRpcResultBody> => {
    const identifier = payload.identifier;
    if (typeof identifier !== "string" || !IDENTIFIER_PATTERN.test(identifier)) {
      return failure("install_failed", "invalid identifier");
    }

    await postProgress(rpcId, "starting");
    const before = await listInstalled();
    if (installedIds(before).has(identifier)) {
      return failure("already_installed", "plugin is already installed");
    }

    await postProgress(rpcId, "installing");
    let addOutput: CommandOutput;
    try {
      addOutput = await runCommand(
        execFileImpl,
        bin,
        ["plugin", "add", identifier, "--json"],
        INSTALL_TIMEOUT_MS,
      );
    } catch (error) {
      const message = errorDetail(error);
      return failure(
        isNotFoundError(error) ? "not_found" : "install_failed",
        message,
      );
    }

    const added = parseJsonObject(addOutput.stdout);
    const expectedId = asString(added.pluginId) ?? identifier;
    await postProgress(rpcId, "verifying");
    const after = await listInstalled();
    const verified = after.find((entry) => pluginId(entry) === expectedId);
    if (!verified) {
      return failure("install_failed", "plugin verification failed");
    }

    const resultPayload: Record<string, unknown> = { note: INSTALL_NOTE };
    const name = asString(added.name, verified.name);
    if (name) resultPayload.name = truncate(name);
    return { ok: true, payload: resultPayload };
  };

  const handleRemove = async (
    payload: SkillsRpcFrame["payload"],
  ): Promise<SkillsRpcResultBody> => {
    let target: string;
    if (payload.identifier !== undefined) {
      if (
        typeof payload.identifier !== "string" ||
        !IDENTIFIER_PATTERN.test(payload.identifier)
      ) {
        return failure("install_failed", "invalid identifier");
      }
      target = payload.identifier;
    } else {
      const name = payload.name;
      if (typeof name !== "string" || name.length === 0) {
        return failure("install_failed", "installed plugin name is required");
      }
      const installed = await listInstalled();
      const matching = installed.filter(
        (entry) => truncate(pluginName(entry)) === name,
      );
      if (matching.length === 0) {
        return failure("install_failed", "installed plugin name was not found");
      }
      const identifiers = matching.map((entry) => pluginId(entry));
      if (
        identifiers.some((id) => !id || !IDENTIFIER_PATTERN.test(id)) ||
        new Set(identifiers).size !== 1
      ) {
        return failure(
          "install_failed",
          "installed plugin name did not resolve to one identifier",
        );
      }
      target = identifiers[0] as string;
    }
    await runCommand(
      execFileImpl,
      bin,
      ["plugin", "remove", target],
      LIST_TIMEOUT_MS,
    );
    const after = await listInstalled();
    if (installedIds(after).has(target)) {
      return failure("install_failed", "plugin removal verification failed");
    }
    return { ok: true, payload: {} };
  };

  const execute = async (
    frame: SkillsRpcFrame,
  ): Promise<SkillsRpcResultBody> => {
    switch (frame.op) {
      case "list_installed":
        return handleListInstalled();
      case "catalog":
        return handleCatalog(frame.payload);
      case "install":
        return handleInstall(frame.rpcId, frame.payload);
      case "remove":
        return handleRemove(frame.payload);
      default:
        return failure("install_failed", "unsupported op");
    }
  };

  const postResult = async (
    rpcId: string,
    result: SkillsRpcResultBody,
    deadlineAt: number,
  ): Promise<void> => {
    const startedAt = nowImpl();
    let lastError: unknown;
    for (const [attempt, offsetMs] of RESULT_RETRY_OFFSETS_MS.entries()) {
      const targetAt = startedAt + offsetMs;
      if (
        attempt > 0 &&
        Math.max(targetAt, nowImpl()) + RESULT_REQUEST_TIMEOUT_MS >= deadlineAt
      ) {
        break;
      }
      const delayMs = Math.max(0, targetAt - nowImpl());
      if (delayMs > 0) await sleepImpl(delayMs);
      if (
        attempt > 0 &&
        nowImpl() + RESULT_REQUEST_TIMEOUT_MS >= deadlineAt
      ) {
        break;
      }
      try {
        await deps.api.skillsRpcResult(rpcId, result);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    report(`skills_rpc result failed: ${errorDetail(lastError)}`);
  };

  return async (frame: SkillsRpcFrame): Promise<void> => {
    const receivedAt = nowImpl();
    try {
      if (!rememberRpc(seen, frame.rpcId)) return;
      try {
        await deps.api.skillsRpcAck(frame.rpcId);
      } catch (error) {
        report(`skills_rpc ack failed: ${errorDetail(error)}`);
      }

      let result: SkillsRpcResultBody;
      try {
        result = await execute(frame);
      } catch (error) {
        result = failure("install_failed", errorDetail(error));
      }

      const deadlineAt =
        receivedAt +
        (RESULT_DEADLINE_MS_BY_OP[frame.op] ?? DEFAULT_RESULT_DEADLINE_MS);
      await postResult(frame.rpcId, result, deadlineAt);
    } catch (error) {
      report(`skills_rpc handler failed: ${errorDetail(error)}`);
    }
  };
}
