/**
 * The Sessions ops (P6 stage 3, C-32, spec sections 5.5 and 5.6).
 *
 * BGOS sends list_sessions, resume_session and rename_session on the same
 * voice_rpc control lane as stop_turn. This daemon answers them from the
 * threads THIS HOAI chat has used (the set /resume offers, D16), with the
 * answer shapes and refusal codes of the contract file. Every case here runs
 * the real frame handler over a real CodexHost; only the Codex app-server
 * and the BGOS HTTP calls are fakes.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexAdapter } from "../src/adapter.js";
import { CodexHost } from "../src/codex-host.js";
import {
  LIST_SESSIONS,
  RENAME_SESSION,
  RESUME_SESSION,
  SESSION_OPS,
  SESSION_RENAME_MAX,
} from "../src/session-controls-contract.js";
import { normalizeVoiceRpc } from "../src/voice-rpc.js";

/** /resume's own line, which the canon quotes to the model verbatim. */
const RESUMED_LINE =
  "Resumed the saved Codex conversation. Your HOAI messages remain in place.";

/** What the adapter wraps an owner message in before Codex records it. */
const envelope = (text: string) =>
  `HOAI event: assistant_id=10, chat_id=20, message_id=5, sender_type=user, sender_user_id=user_private_7, sender_relationship=owner.\n\nMessage:\n${text}`;

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** The Codex app-server, answering only what these ops send. */
class Server extends EventEmitter {
  onRequest: any;
  start = vi.fn(async () => {});
  close = vi.fn();
  /** Thread metadata by id. An id that is not here was deleted on disk. */
  threads: Record<string, any> = {};
  /** An older runtime that has no thread/name/set. */
  renameMissing = false;
  /** Any other refusal of a rename. */
  renameError: string | null = null;
  request = vi.fn(async (method: string, p: any): Promise<any> => {
    if (method === "thread/read") {
      const thread = this.threads[p.threadId];
      // The runtime's own words for a thread it has no rollout for.
      if (!thread)
        throw new Error(`no rollout found for thread id ${p.threadId}`);
      return { thread: { id: p.threadId, ...thread } };
    }
    if (method === "thread/resume") return { thread: { id: p.threadId } };
    if (method === "thread/name/set") {
      // Codex 0.154.0's answer to a method it does not know, as the app
      // server's error message carries it (probe recorded in
      // _tools-p6/evidence/s3/wave-e.rename-confirm.txt).
      if (this.renameMissing)
        throw new Error(
          "Invalid request: unknown variant `thread/name/set`, expected one of `initialize`, `thread/start`, `thread/resume`",
        );
      if (this.renameError) throw new Error(this.renameError);
      this.threads[p.threadId] = { ...this.threads[p.threadId], name: p.name };
      return {};
    }
    return {};
  });
}

/** threads.json (chat to its live thread) and previous-threads.json, oldest first. */
function seed(
  home: string,
  current: Record<string, string>,
  previous: Array<[number, string]>,
) {
  writeFileSync(join(home, "threads.json"), JSON.stringify(current));
  writeFileSync(
    join(home, "previous-threads.json"),
    JSON.stringify(
      Object.fromEntries(previous.map(([chat, id]) => [`${chat}:${id}`, id])),
    ),
  );
}

function adapterOver(host: CodexHost) {
  // The real frame handler, without a daemon, a socket or a model.
  const adapter = Object.create(CodexAdapter.prototype) as any;
  Object.assign(adapter, {
    getRouteForAssistant: vi.fn((id) => (id === 10 ? "codex" : undefined)),
    refreshScopeRateLimited: vi.fn(async () => {}),
    rpcSeen: new Set(),
    chatToAssistant: new Map<number, number>(),
    host,
    outbound: { sendText: vi.fn(async () => ({ id: 1 })) },
    missionLane: { clearStopMarker: vi.fn() },
    api: {
      postVoiceRpcAck: vi.fn(async () => {}),
      postVoiceRpcResult: vi.fn(async () => {}),
    },
  });
  return adapter;
}

let rpc = 0;
const frame = (
  op: string,
  payload: Record<string, unknown>,
  chatId: string | number = "20",
) => ({
  rpcId: `rpc-${++rpc}`,
  op,
  assistantId: "10",
  agentRoute: "codex",
  chatId,
  payload,
});

/** The one answer posted for a frame. */
function answerTo(adapter: any, f: { rpcId: string }) {
  const calls = adapter.api.postVoiceRpcResult.mock.calls.filter(
    (c: any[]) => c[0] === f.rpcId,
  );
  expect(calls).toHaveLength(1);
  return calls[0][1];
}

describe("the voice_rpc normalizer admits the Sessions ops", () => {
  it.each(SESSION_OPS)("admits %s, spelled by the contract file", (op) => {
    const normalized = normalizeVoiceRpc({
      rpcId: "r1",
      op,
      assistantId: 10,
      agentRoute: "codex",
      chatId: 20,
      payload: { sessionId: "t-1" },
    });
    expect(normalized).toEqual({
      rpcId: "r1",
      op,
      assistantId: 10,
      agentRoute: "codex",
      chatId: 20,
      payload: { sessionId: "t-1" },
    });
  });

  it("still drops an op nobody declared", () => {
    for (const op of ["delete_session", "list_session", "LIST_SESSIONS"])
      expect(
        normalizeVoiceRpc({ rpcId: "r1", op, assistantId: 10, chatId: 20 }),
      ).toBeNull();
  });
});

describe("the Sessions ops on the control lane", () => {
  let home: string, server: Server, host: CodexHost, adapter: any;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-sessions-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
    server = new Server();
    server.threads = {
      "t-current": {
        name: null,
        preview: envelope("Fix the login page"),
        createdAt: 1789000000,
        updatedAt: 1789500000,
        gitInfo: { sha: "abc", branch: "fix/login", originUrl: null },
      },
      "t-old1": {
        name: "Invoice export",
        preview: envelope("Build the invoice CSV export"),
        createdAt: 1788000000,
        updatedAt: 1788100000,
        gitInfo: null,
      },
      "t-old2": {
        name: null,
        preview: envelope("Draft the release notes"),
        createdAt: 1787000000,
      },
      "t-bare": { name: null, preview: "" },
      "t-other": { name: "Another chat's work", preview: "", createdAt: 1 },
    };
    // Chat 20 used t-bare, t-old1, t-gone (since deleted) and t-old2, in
    // that order, and runs on t-current now. Chat 21 owns t-other.
    seed(home, { "20": "t-current", "21": "t-other" }, [
      [20, "t-bare"],
      [20, "t-old1"],
      [20, "t-gone"],
      [21, "t-other"],
      [20, "t-old2"],
    ]);
    host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: server as any,
    });
    adapter = adapterOver(host);
  });

  afterEach(() => {
    host.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  describe("list_sessions", () => {
    it("lists this chat's threads with title, preview, last activity, branch and Current, newest first", async () => {
      const f = frame(LIST_SESSIONS, { limit: 50 });
      await adapter.handleControl(f);
      expect(adapter.api.postVoiceRpcAck).toHaveBeenCalledWith(f.rpcId);
      const answer = answerTo(adapter, f);
      expect(answer.ok).toBe(true);
      expect(answer.payload.runtime).toBe("codex");
      expect(answer.payload.abilities).toEqual({ resume: true, rename: true });
      expect(answer.payload.truncated).toBe(false);
      const rows = answer.payload.sessions;
      // The live thread first, then the saved ones newest first; the thread
      // deleted on disk is skipped, never listed as a dead row.
      expect(rows.map((r: any) => r.id)).toEqual([
        "t-current",
        "t-old2",
        "t-old1",
        "t-bare",
      ]);
      expect(rows[0]).toEqual({
        id: "t-current",
        title: "Fix the login page",
        // The title already IS the first message, so it is not repeated.
        preview: null,
        lastActivityAt: iso(1789500000),
        branch: "fix/login",
        current: true,
      });
      expect(rows[1]).toEqual({
        id: "t-old2",
        title: "Draft the release notes",
        preview: null,
        // No updatedAt from the runtime: the thread's creation instead.
        lastActivityAt: iso(1787000000),
        branch: null,
        current: false,
      });
      expect(rows[2]).toEqual({
        id: "t-old1",
        title: "Invoice export",
        // A thread with its own name shows its first message under it.
        preview: "Build the invoice CSV export",
        lastActivityAt: iso(1788100000),
        branch: null,
        current: false,
      });
      expect(rows[3]).toEqual({
        id: "t-bare",
        title: "Saved conversation",
        preview: null,
        lastActivityAt: null,
        branch: null,
        current: false,
      });
      expect(rows.filter((r: any) => r.current)).toHaveLength(1);
    });

    it("never lists another chat's thread, and never lets the routing envelope out", async () => {
      const f = frame(LIST_SESSIONS, { limit: 50 });
      await adapter.handleControl(f);
      const text = JSON.stringify(answerTo(adapter, f));
      expect(text).not.toContain("t-other");
      expect(text).not.toContain("HOAI event");
      expect(text).not.toContain("user_private_7");
    });

    it("lists at most 30 (the set /resume offers), newest first, and says truncated when the chat has more", async () => {
      const previous: Array<[number, string]> = [];
      for (let i = 0; i < 40; i++) {
        server.threads[`t-${i}`] = { name: `Task ${i}`, preview: "" };
        previous.push([30, `t-${i}`]);
      }
      seed(home, {}, previous);
      const f = frame(LIST_SESSIONS, { limit: 50 }, 30);
      await adapter.handleControl(f);
      const { payload } = answerTo(adapter, f);
      expect(payload.sessions).toHaveLength(30);
      expect(payload.sessions[0].id).toBe("t-39");
      expect(payload.sessions[29].id).toBe("t-10");
      expect(payload.truncated).toBe(true);
      // Exactly 30 is the whole set, not a truncated one.
      seed(home, {}, previous.slice(10));
      const g = frame(LIST_SESSIONS, { limit: 50 }, 30);
      await adapter.handleControl(g);
      expect(answerTo(adapter, g).payload.truncated).toBe(false);
      expect(answerTo(adapter, g).payload.sessions).toHaveLength(30);
    });

    it("filters by query BEFORE the cap, on title and preview, ignoring case and accents", async () => {
      const previous: Array<[number, string]> = [];
      for (let i = 0; i < 40; i++) {
        server.threads[`t-${i}`] = { name: `Task ${i}`, preview: "" };
        previous.push([30, `t-${i}`]);
      }
      // Both older than the latest 30, so only a search before the cap finds them.
      server.threads["t-3"] = { name: "Quarterly café budget", preview: "" };
      server.threads["t-5"] = {
        name: null,
        preview: envelope("Refactor the PAYMENTS module"),
      };
      seed(home, {}, previous);
      const cafe = frame(LIST_SESSIONS, { limit: 50, query: "CAFE" }, 30);
      await adapter.handleControl(cafe);
      expect(answerTo(adapter, cafe).payload.sessions.map((r: any) => r.id)).toEqual(["t-3"]);
      expect(answerTo(adapter, cafe).payload.truncated).toBe(false);
      const payments = frame(LIST_SESSIONS, { limit: 50, query: " payments " }, 30);
      await adapter.handleControl(payments);
      expect(answerTo(adapter, payments).payload.sessions).toEqual([
        {
          id: "t-5",
          title: "Refactor the PAYMENTS module",
          preview: null,
          lastActivityAt: null,
          branch: null,
          current: false,
        },
      ]);
      // A search with more than 30 matches is capped and says so.
      const many = frame(LIST_SESSIONS, { limit: 50, query: "task" }, 30);
      await adapter.handleControl(many);
      expect(answerTo(adapter, many).payload.sessions).toHaveLength(30);
      expect(answerTo(adapter, many).payload.truncated).toBe(true);
    });

    it("a search reads at most the 200 newest of this chat's threads, and says truncated beyond them", async () => {
      const previous: Array<[number, string]> = [];
      for (let i = 0; i < 250; i++) {
        server.threads[`t-${i}`] = { name: `Task ${i}`, preview: "" };
        previous.push([30, `t-${i}`]);
      }
      server.threads["t-10"] = { name: "Needle", preview: "" };
      server.threads["t-100"] = { name: "Needle too", preview: "" };
      seed(home, {}, previous);
      const f = frame(LIST_SESSIONS, { limit: 50, query: "needle" }, 30);
      await adapter.handleControl(f);
      const { payload } = answerTo(adapter, f);
      expect(payload.sessions.map((r: any) => r.id)).toEqual(["t-100"]);
      expect(payload.truncated).toBe(true);
      const reads = server.request.mock.calls.filter(
        (c: any[]) => c[0] === "thread/read",
      );
      expect(reads).toHaveLength(200);
    });

    it("honours a smaller limit and says truncated", async () => {
      const f = frame(LIST_SESSIONS, { limit: 2 });
      await adapter.handleControl(f);
      const { payload } = answerTo(adapter, f);
      expect(payload.sessions.map((r: any) => r.id)).toEqual(["t-current", "t-old2"]);
      expect(payload.truncated).toBe(true);
    });

    it("refuses a query that is not text or is over 80 characters as invalid", async () => {
      for (const query of [42, { q: "x" }, "x".repeat(81)]) {
        const f = frame(LIST_SESSIONS, { limit: 50, query });
        await adapter.handleControl(f);
        expect(answerTo(adapter, f)).toEqual({
          ok: false,
          error: { code: "invalid", message: expect.any(String) },
        });
      }
      expect(server.request).not.toHaveBeenCalled();
    });

    it("answers failed when Codex cannot be reached", async () => {
      server.start.mockRejectedValueOnce(new Error("Codex is not connected."));
      const f = frame(LIST_SESSIONS, { limit: 50 });
      await adapter.handleControl(f);
      expect(answerTo(adapter, f)).toEqual({
        ok: false,
        error: { code: "failed", message: "Codex is not connected." },
      });
    });

    it("answers a frame the broker delivered twice only once (rpcId dedupe)", async () => {
      const f = frame(LIST_SESSIONS, { limit: 50 });
      await adapter.handleControl(f);
      await adapter.handleControl(f);
      expect(adapter.api.postVoiceRpcResult).toHaveBeenCalledTimes(1);
    });

    it("does not answer for an agent this daemon does not serve", async () => {
      const f = { ...frame(LIST_SESSIONS, { limit: 50 }), assistantId: "99" };
      await adapter.handleControl(f);
      expect(adapter.api.postVoiceRpcResult).not.toHaveBeenCalled();
      expect(server.request).not.toHaveBeenCalled();
    });
  });

  describe("resume_session", () => {
    it("binds the saved thread to the chat, posts /resume's own line, clears the Stop marker and answers with the title", async () => {
      const f = frame(RESUME_SESSION, { sessionId: "t-old1" });
      await adapter.handleControl(f);
      expect(server.request).toHaveBeenCalledWith(
        "thread/resume",
        expect.objectContaining({ threadId: "t-old1" }),
      );
      expect(
        JSON.parse(readFileSync(join(home, "threads.json"), "utf8"))["20"],
      ).toBe("t-old1");
      expect(adapter.outbound.sendText).toHaveBeenCalledTimes(1);
      expect(adapter.outbound.sendText).toHaveBeenCalledWith({
        assistantId: 10,
        chatId: 20,
        text: RESUMED_LINE,
      });
      // The context a Stop paused belongs to the thread just left, as on /new.
      expect(adapter.missionLane.clearStopMarker).toHaveBeenCalledWith(20);
      expect(answerTo(adapter, f)).toEqual({
        ok: true,
        payload: { resumed: true, sessionId: "t-old1", title: "Invoice export" },
      });
      // The Current tag moves, and the thread left behind stays listed.
      const list = frame(LIST_SESSIONS, { limit: 50 });
      await adapter.handleControl(list);
      const rows = answerTo(adapter, list).payload.sessions;
      expect(rows.find((r: any) => r.current).id).toBe("t-old1");
      expect(rows.map((r: any) => r.id)).toContain("t-current");
    });

    it("answers busy while a turn runs, and changes nothing", async () => {
      vi.spyOn(host, "isBusy").mockReturnValue(true);
      const f = frame(RESUME_SESSION, { sessionId: "t-old1" });
      await adapter.handleControl(f);
      expect(answerTo(adapter, f)).toEqual({
        ok: false,
        error: {
          code: "busy",
          message: "Stop the current response before changing this conversation.",
        },
      });
      expect(server.request).not.toHaveBeenCalledWith("thread/resume", expect.anything());
      expect(adapter.outbound.sendText).not.toHaveBeenCalled();
      expect(adapter.missionLane.clearStopMarker).not.toHaveBeenCalled();
    });

    it("answers not_found for another chat's thread and for one deleted on disk", async () => {
      for (const sessionId of ["t-other", "t-gone", "t-never"]) {
        const f = frame(RESUME_SESSION, { sessionId });
        await adapter.handleControl(f);
        expect(answerTo(adapter, f)).toEqual({
          ok: false,
          error: { code: "not_found", message: expect.stringContaining("does not belong") },
        });
      }
      expect(server.request).not.toHaveBeenCalledWith("thread/resume", expect.anything());
      expect(adapter.outbound.sendText).not.toHaveBeenCalled();
      expect(adapter.missionLane.clearStopMarker).not.toHaveBeenCalled();
    });

    it("answers invalid for a missing or malformed session id", async () => {
      for (const payload of [{}, { sessionId: "" }, { sessionId: "../threads" }, { sessionId: 7 }]) {
        const f = frame(RESUME_SESSION, payload);
        await adapter.handleControl(f);
        expect(answerTo(adapter, f).error.code).toBe("invalid");
      }
      const noChat = frame(RESUME_SESSION, { sessionId: "t-old1" }, "0");
      await adapter.handleControl(noChat);
      expect(answerTo(adapter, noChat).error.code).toBe("invalid");
      expect(server.request).not.toHaveBeenCalledWith("thread/resume", expect.anything());
    });

    it("resumes a thread older than the latest 30 that a search found", async () => {
      const previous: Array<[number, string]> = [];
      for (let i = 0; i < 40; i++) {
        server.threads[`t-${i}`] = { name: `Task ${i}`, preview: "" };
        previous.push([30, `t-${i}`]);
      }
      seed(home, {}, previous);
      const f = frame(RESUME_SESSION, { sessionId: "t-3" }, 30);
      await adapter.handleControl(f);
      expect(answerTo(adapter, f)).toEqual({
        ok: true,
        payload: { resumed: true, sessionId: "t-3", title: "Task 3" },
      });
    });

    it("still answers resumed when the chat line could not be posted: the switch happened", async () => {
      adapter.outbound.sendText.mockRejectedValueOnce(new Error("network"));
      const f = frame(RESUME_SESSION, { sessionId: "t-old1" });
      await adapter.handleControl(f);
      expect(answerTo(adapter, f).ok).toBe(true);
    });
  });

  describe("rename_session", () => {
    it("renames through thread/name/set, answers with the new title, and the next list shows it", async () => {
      const f = frame(RENAME_SESSION, { sessionId: "t-old2", title: "  Release notes, draft two  " });
      await adapter.handleControl(f);
      expect(server.request).toHaveBeenCalledWith("thread/name/set", {
        threadId: "t-old2",
        name: "Release notes, draft two",
      });
      expect(answerTo(adapter, f)).toEqual({
        ok: true,
        payload: { renamed: true, sessionId: "t-old2", title: "Release notes, draft two" },
      });
      const list = frame(LIST_SESSIONS, { limit: 50 });
      await adapter.handleControl(list);
      const row = answerTo(adapter, list).payload.sessions.find((r: any) => r.id === "t-old2");
      expect(row.title).toBe("Release notes, draft two");
      // Now that it has its own name, its first message shows under it.
      expect(row.preview).toBe("Draft the release notes");
    });

    it("renames even while a turn runs: a name is not the conversation", async () => {
      vi.spyOn(host, "isBusy").mockReturnValue(true);
      const f = frame(RENAME_SESSION, { sessionId: "t-current", title: "Login fix" });
      await adapter.handleControl(f);
      expect(answerTo(adapter, f).ok).toBe(true);
    });

    it("answers not_found for another chat's thread and never calls Codex", async () => {
      const f = frame(RENAME_SESSION, { sessionId: "t-other", title: "Mine now" });
      await adapter.handleControl(f);
      expect(answerTo(adapter, f).error.code).toBe("not_found");
      expect(server.request).not.toHaveBeenCalledWith("thread/name/set", expect.anything());
    });

    it("answers invalid for an empty, too long, multi line or missing title", async () => {
      for (const title of ["", "   ", "x".repeat(SESSION_RENAME_MAX + 1), "two\nlines", "tab\there", undefined, 5]) {
        const f = frame(RENAME_SESSION, { sessionId: "t-old1", title });
        await adapter.handleControl(f);
        expect(answerTo(adapter, f).error.code).toBe("invalid");
      }
      const ok = frame(RENAME_SESSION, { sessionId: "t-old1", title: "x".repeat(SESSION_RENAME_MAX) });
      await adapter.handleControl(ok);
      expect(answerTo(adapter, ok).ok).toBe(true);
    });

    it("method not found gives unsupported and turns the rename ability off for the life of the process", async () => {
      server.renameMissing = true;
      const f = frame(RENAME_SESSION, { sessionId: "t-old1", title: "New name" });
      await adapter.handleControl(f);
      expect(answerTo(adapter, f)).toEqual({
        ok: false,
        error: { code: "unsupported", message: expect.any(String) },
      });
      const list = frame(LIST_SESSIONS, { limit: 50 });
      await adapter.handleControl(list);
      expect(answerTo(adapter, list).payload.abilities).toEqual({ resume: true, rename: false });
      // A second rename does not ask Codex again.
      const again = frame(RENAME_SESSION, { sessionId: "t-old1", title: "Other" });
      await adapter.handleControl(again);
      expect(answerTo(adapter, again).error.code).toBe("unsupported");
      expect(
        server.request.mock.calls.filter((c: any[]) => c[0] === "thread/name/set"),
      ).toHaveLength(1);
    });

    it("any other rename failure answers failed and keeps the ability on", async () => {
      server.renameError = "no rollout found for thread id t-old1";
      const f = frame(RENAME_SESSION, { sessionId: "t-old1", title: "New name" });
      await adapter.handleControl(f);
      expect(answerTo(adapter, f).error.code).toBe("failed");
      const list = frame(LIST_SESSIONS, { limit: 50 });
      await adapter.handleControl(list);
      expect(answerTo(adapter, list).payload.abilities).toEqual({ resume: true, rename: true });
    });
  });
});
