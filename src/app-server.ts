/** Versioned Codex app-server transport. No shell, command interpolation or token logging. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";

export type RpcObject = Record<string, any>;
const require = createRequire(import.meta.url);

/**
 * The longest line this client holds: one JSON-RPC message from the runtime.
 *
 * ONE LINE OVER IT COSTS ONLY THAT LINE (stage 4, Round 7). The runtime sends
 * a generated picture's whole base64 `result` on one `item/completed` line,
 * so a picture over about 12 MiB is one line over this cap. The reader used to
 * fail every pending request and close the connection, which ended every live
 * turn in every chat on this daemon. Now it throws that line away up to its
 * newline and carries on: a reply fails only the request it answers, a
 * request from the runtime is answered with an error so nothing waits on it,
 * and a notification is dropped, except a picture's (Round 8, below).
 */
const LINE_CAP = 16 * 1024 * 1024;
/**
 * How much of an oversized line is kept to learn whose it was. The runtime
 * writes `id` first on a reply (`{"id":7,"result":...}`) and on a request
 * (`{"id":3,"method":...}`), and `method` first on a notification.
 */
const LINE_HEAD_KEPT = 256;
/**
 * How much of an oversized line's END is kept (Round 8). A picture's
 * `item/completed` puts the item FIRST and the ids after it (the probe's
 * raw.jsonl on 0.154.0: `params` is item, threadId, turnId, completedAtMs,
 * then `emittedAtMs` outside it), so the thread and turn a too large picture
 * belongs to sit behind its base64 `result`, in the line's last characters.
 */
const LINE_TAIL_KEPT = 256;

/** A notification's opening, up to a picture item's id, ids first or not. */
const IMAGE_COMPLETED_HEAD =
  /^\s*\{\s*"method"\s*:\s*"item\/completed"\s*,\s*"params"\s*:\s*\{\s*(?:"threadId"\s*:\s*"([^"\\]+)"\s*,\s*"turnId"\s*:\s*"([^"\\]+)"\s*,\s*)?"item"\s*:\s*\{\s*"type"\s*:\s*"imageGeneration"\s*,\s*"id"\s*:\s*"([^"\\]+)"/;
/**
 * The line's end when the ids follow the item: the item closes, then
 * threadId and turnId, any number fields (completedAtMs), `params` closes,
 * any number fields (emittedAtMs), and the line closes. Anchored on the end,
 * so nothing inside the item (a string cannot hold an unescaped quote) can
 * pass for it.
 */
const IMAGE_COMPLETED_TAIL =
  /\}\s*,\s*"threadId"\s*:\s*"([^"\\]+)"\s*,\s*"turnId"\s*:\s*"([^"\\]+)"(?:\s*,\s*"[A-Za-z]+"\s*:\s*-?\d+)*\s*\}(?:\s*,\s*"[A-Za-z]+"\s*:\s*-?\d+)*\s*\}\s*$/;

/**
 * The picture an oversized line finished, read off its two ends, or null
 * when they cannot say which picture of which turn it was (Round 8). The head
 * must open an `item/completed` notification for an `imageGeneration` item
 * and give its id; the thread and turn come from the head when the runtime
 * writes them first, else from the end. Anything else is not identified and
 * stays dropped in silence, as every other oversized notification is.
 */
function oversizedImage(
  head: string,
  tail: string,
): { itemId: string; threadId: string; turnId: string } | null {
  const opening = IMAGE_COMPLETED_HEAD.exec(head);
  if (!opening) return null;
  const itemId = opening[3]!;
  if (opening[1] && opening[2])
    return { itemId, threadId: opening[1], turnId: opening[2] };
  const end = IMAGE_COMPLETED_TAIL.exec(tail);
  if (!end) return null;
  return { itemId, threadId: end[1]!, turnId: end[2]! };
}

/** The last LINE_TAIL_KEPT characters of what was kept and what came next. */
function keepTail(kept: string, more: string): string {
  return more.length >= LINE_TAIL_KEPT
    ? more.slice(-LINE_TAIL_KEPT)
    : (kept + more).slice(-LINE_TAIL_KEPT);
}

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
  /** The two ends of a line past LINE_CAP, while the rest is thrown away. */
  private oversized: { head: string; tail: string } | null = null;
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
    this.oversized = null;
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
    let rest = chunk;
    while (rest.length > 0) {
      const end = rest.indexOf("\n");
      if (end < 0) {
        // Still inside a line: keep it, unless it is one being thrown away,
        // of which only the end is kept.
        if (this.oversized !== null) {
          this.oversized.tail = keepTail(this.oversized.tail, rest);
          return;
        }
        this.buffer += rest;
        if (this.buffer.length > LINE_CAP) {
          this.oversized = {
            head: this.buffer.slice(0, LINE_HEAD_KEPT),
            tail: this.buffer.slice(-LINE_TAIL_KEPT),
          };
          this.buffer = "";
        }
        return;
      }
      const piece = rest.slice(0, end);
      rest = rest.slice(end + 1);
      if (this.oversized !== null) {
        const { head, tail } = this.oversized;
        this.oversized = null;
        this.dropOversized(head, keepTail(tail, piece));
        continue;
      }
      const line = this.buffer + piece;
      this.buffer = "";
      if (line.length > LINE_CAP) {
        this.dropOversized(
          line.slice(0, LINE_HEAD_KEPT),
          line.slice(-LINE_TAIL_KEPT),
        );
        continue;
      }
      this.handleLine(line);
    }
  }
  private handleLine(line: string): void {
    if (!line.trim()) return;
    let value: RpcObject;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.method === "string") {
      if (value.id != null) void this.respond(value);
      else this.emit("notification", value.method, value.params ?? {});
    } else if (typeof value.id === "number") {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error)
        pending.reject(
          new Error(String(value.error.message ?? "Codex request failed")),
        );
      else pending.resolve(value.result);
    }
  }
  /**
   * A line past LINE_CAP, read only by its two ends. A reply fails the one
   * request it answers; a request from the runtime gets an error back, so the
   * runtime is not left waiting on an answer this client never read; a
   * notification is dropped. Nothing else is touched.
   *
   * Except a PICTURE (Round 8). The host records a picture on `item/completed`
   * only, so dropping that line lost the picture AND the plain line the served
   * canon promises ("If it cannot be shown, the chat says so in one plain
   * line"). When the two ends name the picture, its thread and its turn, the
   * host gets one `item/completed` in its place with no result and
   * `tooLarge: true`, and the "Codex made a picture, but it could not be shown
   * here." line posts (generated-images.ts). Not identified: dropped, as ever.
   */
  private dropOversized(head: string, tail: string): void {
    const picture = oversizedImage(head, tail);
    if (picture) {
      this.emit("notification", "item/completed", {
        item: { type: "imageGeneration", id: picture.itemId, tooLarge: true },
        threadId: picture.threadId,
        turnId: picture.turnId,
      });
      return;
    }
    const opening =
      /^\s*\{\s*"id"\s*:\s*(-?\d+|"(?:[^"\\]|\\.)*")\s*,\s*"(method|result|error)"/.exec(
        head,
      );
    if (!opening) return;
    let id: number | string;
    try {
      id = JSON.parse(opening[1]!);
    } catch {
      return;
    }
    if (opening[2] === "method") {
      const child = this.child;
      if (child && !child.stdin.destroyed)
        this.send({
          id,
          error: {
            code: -32600,
            message: "This request is too large for HOAI to read.",
          },
        });
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(new Error("Codex sent a reply too large to read."));
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
