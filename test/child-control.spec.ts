/**
 * The supervisor never kills a busy child (finding 9). To update, it asks the
 * child over the IPC channel to stop IF it is idle; the child decides with
 * its own live state (every chat's turns and queues, then the background
 * terminals), checks its turns once more after the runtime answered, and only
 * then starts its own graceful shutdown. Silence is never consent.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  STOP_IF_IDLE,
  STOP_REPLY,
  attachChildControl,
  requestStopIfIdle,
} from "../src/child-control.js";

/** A connected pair: the supervisor's ChildProcess view and the child's process view. */
function pair() {
  const child = new EventEmitter() as EventEmitter & {
    send?: (m: unknown) => boolean;
    connected: boolean;
  };
  const proc = new EventEmitter() as EventEmitter & { send?: (m: unknown) => boolean };
  child.connected = true;
  child.send = (m) => {
    setImmediate(() => proc.emit("message", JSON.parse(JSON.stringify(m))));
    return true;
  };
  proc.send = (m) => {
    setImmediate(() => child.emit("message", JSON.parse(JSON.stringify(m))));
    return true;
  };
  return { child, proc };
}

describe("stop if idle, over the IPC channel", () => {
  it("an idle child agrees and starts its own shutdown", async () => {
    const { child, proc } = pair();
    const shutdown = vi.fn();
    attachChildControl({
      channel: proc,
      busyNow: () => false,
      backgroundJobs: async () => 0,
      shutdown,
    });
    expect(await requestStopIfIdle(child)).toBe("stopping");
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("a child with a turn running or queued refuses and keeps running", async () => {
    const { child, proc } = pair();
    const shutdown = vi.fn();
    const backgroundJobs = vi.fn(async () => 0);
    attachChildControl({ channel: proc, busyNow: () => true, backgroundJobs, shutdown });
    expect(await requestStopIfIdle(child)).toBe("busy");
    expect(shutdown).not.toHaveBeenCalled();
    expect(backgroundJobs).not.toHaveBeenCalled();
  });

  it("a background terminal is a job in flight", async () => {
    const { child, proc } = pair();
    const shutdown = vi.fn();
    attachChildControl({
      channel: proc,
      busyNow: () => false,
      backgroundJobs: async () => 1,
      shutdown,
    });
    expect(await requestStopIfIdle(child)).toBe("busy");
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("background terminals it cannot read count as busy", async () => {
    const { child, proc } = pair();
    const shutdown = vi.fn();
    attachChildControl({
      channel: proc,
      busyNow: () => false,
      backgroundJobs: async () => {
        throw new Error("timed out");
      },
      shutdown,
    });
    expect(await requestStopIfIdle(child)).toBe("busy");
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("a turn that started while the runtime answered still wins", async () => {
    const { child, proc } = pair();
    const shutdown = vi.fn();
    let busy = false;
    attachChildControl({
      channel: proc,
      busyNow: () => busy,
      backgroundJobs: async () => {
        busy = true; // a message arrived and its turn was queued meanwhile
        return 0;
      },
      shutdown,
    });
    expect(await requestStopIfIdle(child)).toBe("busy");
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("silence is never consent: no channel, no answer, or an exit read as unavailable", async () => {
    expect(await requestStopIfIdle(null)).toBe("unavailable");
    const mute = new EventEmitter() as any;
    mute.connected = true;
    mute.send = () => true;
    expect(await requestStopIfIdle(mute, 20)).toBe("unavailable");
    const gone = new EventEmitter() as any;
    gone.connected = false;
    gone.send = () => true;
    expect(await requestStopIfIdle(gone)).toBe("unavailable");
    const dying = new EventEmitter() as any;
    dying.connected = true;
    dying.send = () => {
      setImmediate(() => dying.emit("exit", 1, null));
      return true;
    };
    expect(await requestStopIfIdle(dying, 60_000)).toBe("unavailable");
  });

  it("ignores other messages and answers only the request it was asked", async () => {
    const { child, proc } = pair();
    const sent: unknown[] = [];
    const original = proc.send!;
    proc.send = (m) => {
      sent.push(m);
      return original(m);
    };
    attachChildControl({
      channel: proc,
      busyNow: () => true,
      backgroundJobs: async () => 0,
      shutdown: vi.fn(),
    });
    proc.emit("message", { type: "something-else" });
    proc.emit("message", null);
    await new Promise((r) => setImmediate(r));
    expect(sent).toEqual([]);
    expect(await requestStopIfIdle(child)).toBe("busy");
    expect(sent).toEqual([
      expect.objectContaining({ type: STOP_REPLY, result: "busy" }),
    ]);
    expect(STOP_IF_IDLE).not.toBe(STOP_REPLY);
  });
});
