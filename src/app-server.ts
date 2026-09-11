/** Versioned Codex app-server transport. No shell, command interpolation or token logging. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";

export type RpcObject = Record<string, any>;
const require = createRequire(import.meta.url);

export function codexExecutable(
  platform = process.platform,
  arch = process.arch,
  packageRoot?: string,
): string {
  const target =
    platform === "win32"
      ? `${arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`
      : platform === "darwin"
        ? `${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
        : `${arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`;
  if (
    !["win32", "darwin", "linux"].includes(platform) ||
    !["x64", "arm64"].includes(arch)
  ) {
    throw new Error(`Codex does not support ${platform}/${arch}.`);
  }
  const resolver = packageRoot
    ? createRequire(join(packageRoot, "package.json"))
    : require;
  const codexPackage = resolver.resolve("@openai/codex/package.json");
  const pkg = createRequire(codexPackage).resolve(
    `@openai/codex-${platform}-${arch}/package.json`,
  );
  const binary = join(
    dirname(pkg),
    "vendor",
    target,
    "bin",
    platform === "win32" ? "codex.exe" : "codex",
  );
  if (!existsSync(binary))
    throw new Error(
      "The Codex runtime is missing. Repair this agent to reinstall it.",
    );
  return binary;
}

export function codexEnvironment(apiKey?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !/^(BGOS_|CODEX_BGOS_|HOAI_|OPENAI_API_KEY$|CODEX_API_KEY$)/.test(key)
    )
      env[key] = value;
  }
  if (apiKey) env.CODEX_API_KEY = apiKey;
  return env;
}

export class AppServer extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private boot: Promise<void> | null = null;
  private buffer = "";
  private stderr = "";
  onRequest?: (method: string, params: RpcObject) => Promise<unknown>;

  constructor(
    private options: {
      cwd: string;
      env?: Record<string, string>;
      command?: string;
      args?: string[];
    },
  ) {
    super();
  }

  start(): Promise<void> {
    if (this.boot) return this.boot;
    this.boot = this.startInternal().catch((error) => {
      this.close();
      throw error;
    });
    return this.boot;
  }

  private async startInternal(): Promise<void> {
    this.buffer = "";
    this.stderr = "";
    const child = spawn(
      this.options.command ?? codexExecutable(),
      this.options.args ?? ["app-server"],
      {
        cwd: this.options.cwd,
        env: this.options.env ?? codexEnvironment(),
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000);
    });
    child.on("error", (error) => this.fail(error));
    child.stdin.on("error", (error) => {
      if (this.child === child) this.fail(error);
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.boot = null;
      this.fail(
        new Error(
          `Codex stopped (exit ${code ?? "signal"}). Reconnect or repair the agent.`,
        ),
      );
    });
    await this.request("initialize", {
      clientInfo: {
        name: "hoai_codex",
        title: "Home of Agents",
        version: "0.3.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  request<T = any>(
    method: string,
    params: unknown = {},
    timeout = 30_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }
  private send(payload: unknown): void {
    if (!this.child || this.child.stdin.destroyed)
      throw new Error("Codex is not connected.");
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }
  private read(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.fail(new Error("Codex sent an oversized event."));
      this.close();
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let value: RpcObject;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object") continue;
      if (typeof value.method === "string") {
        if (value.id != null) void this.respond(value);
        else this.emit("notification", value.method, value.params ?? {});
      } else if (typeof value.id === "number") {
        const pending = this.pending.get(value.id);
        if (!pending) continue;
        this.pending.delete(value.id);
        clearTimeout(pending.timer);
        if (value.error)
          pending.reject(
            new Error(String(value.error.message ?? "Codex request failed")),
          );
        else pending.resolve(value.result);
      }
    }
  }
  private async respond(message: RpcObject): Promise<void> {
    const child = this.child;
    let response: unknown;
    try {
      if (!this.onRequest)
        throw new Error("This request is not supported by HOAI.");
      response = {
        id: message.id,
        result: await this.onRequest(message.method, message.params ?? {}),
      };
    } catch (error) {
      response = {
        id: message.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Request failed",
        },
      };
    }
    if (child && this.child === child && !child.stdin.destroyed)
      this.send(response);
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }
  close(): void {
    const child = this.child;
    this.child = null;
    this.boot = null;
    this.fail(new Error("Codex connection closed."));
    child?.stdin.end();
    child?.kill();
  }
}
