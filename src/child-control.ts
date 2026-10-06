/**
 * The one question the supervisor asks its child before an update: "stop if
 * you are idle" (design 2.2; finding 9: never restart an agent mid job, never
 * kill a busy child).
 *
 * The heartbeat file's `busy` is written on every change, but a file read and
 * a kill are two moments, and a message can land between them. So the
 * decision is the CHILD's, over the IPC channel `supervise` opens to it, made
 * with its live state: any chat's turn running or queued, then the Codex
 * background terminals (a live monitor a turn left running), then the turns
 * once more, because a message may have been queued while the runtime
 * answered. Only then does the child reply "stopping" and start its own
 * graceful shutdown, in the same tick. The supervisor treats no answer, a
 * closed channel or an exit as "unavailable", never as consent.
 */
import { randomUUID } from "node:crypto";

import type { ChildStopReply } from "./setup/self-update.js";

export const STOP_IF_IDLE = "codex-bgos:stop-if-idle";
export const STOP_REPLY = "codex-bgos:stop-reply";
/** How long the child gives the runtime to list background terminals. */
const BACKGROUND_CHECK_TIMEOUT_MS = 10_000;
/** How long the supervisor waits for the child's answer. */
export const STOP_REPLY_TIMEOUT_MS = 20_000;

interface ChildChannel {
  on(event: "message", listener: (message: unknown) => void): unknown;
  send?: (message: unknown) => boolean;
}

/** Child side: answer the supervisor's stop request from live state. */
export function attachChildControl(opts: {
  channel: ChildChannel;
  /** Any chat's turn running or queued (CodexHost.isAnyBusy). */
  busyNow: () => boolean;
  /** Background terminals still running; throws when it cannot tell. */
  backgroundJobs: () => Promise<number>;
  /** Begin the graceful shutdown (the same path as SIGTERM). */
  shutdown: () => void;
  log?: (message: string) => void;
}): void {
  opts.channel.on("message", (message) => {
    const request = message as { type?: unknown; id?: unknown } | null;
    if (!request || request.type !== STOP_IF_IDLE) return;
    const reply = (result: ChildStopReply, reason?: string) => {
      try {
        opts.channel.send?.({
          type: STOP_REPLY,
          id: request.id,
          result,
          ...(reason ? { reason } : {}),
        });
      } catch {}
    };
    void (async () => {
      if (opts.busyNow()) return reply("busy", "turn");
      let jobs: number;
      try {
        jobs = await Promise.race([
          opts.backgroundJobs(),
          new Promise<number>((_, reject) =>
            setTimeout(
              () => reject(new Error("background terminal check timed out")),
              BACKGROUND_CHECK_TIMEOUT_MS,
            ).unref?.(),
          ),
        ]);
      } catch (error) {
        opts.log?.(
          `update waits: background terminals unknown (${error instanceof Error ? error.message : String(error)})`,
        );
        return reply("busy", "background_unknown");
      }
      if (jobs > 0) return reply("busy", "background_job");
      if (opts.busyNow()) return reply("busy", "turn");
      reply("stopping");
      opts.shutdown();
    })();
  });
}

/**
 * attachChildControl, but only for a child of `supervise`: Node gives a
 * process `send` only when its parent opened an IPC channel. A foreground
 * start has no supervisor to answer, so it gets no stop channel at all.
 */
export function attachChildControlIfSupervised(
  opts: Parameters<typeof attachChildControl>[0],
): boolean {
  if (typeof opts.channel.send !== "function") return false;
  attachChildControl(opts);
  return true;
}

interface SupervisedChild {
  // Method syntax: the send of a ChildProcess takes a narrower Serializable.
  send?(message: object): boolean;
  connected?: boolean;
  on(event: "message" | "exit", listener: (...args: any[]) => void): unknown;
  off(event: "message" | "exit", listener: (...args: any[]) => void): unknown;
}

/** Supervisor side: ask, and read anything but a clear answer as unavailable. */
export function requestStopIfIdle(
  child: SupervisedChild | null | undefined,
  timeoutMs = STOP_REPLY_TIMEOUT_MS,
): Promise<ChildStopReply> {
  return new Promise((resolve) => {
    if (!child || typeof child.send !== "function" || child.connected === false)
      return resolve("unavailable");
    const id = randomUUID();
    let settled = false;
    const done = (result: ChildStopReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      resolve(result);
    };
    const onMessage = (message: unknown) => {
      const answer = message as { type?: unknown; id?: unknown; result?: unknown } | null;
      if (!answer || answer.type !== STOP_REPLY || answer.id !== id) return;
      done(answer.result === "stopping" ? "stopping" : answer.result === "busy" ? "busy" : "unavailable");
    };
    const onExit = () => done("unavailable");
    const timer = setTimeout(() => done("unavailable"), timeoutMs);
    child.on("message", onMessage);
    child.on("exit", onExit);
    try {
      if (!child.send({ type: STOP_IF_IDLE, id })) done("unavailable");
    } catch {
      done("unavailable");
    }
  });
}
