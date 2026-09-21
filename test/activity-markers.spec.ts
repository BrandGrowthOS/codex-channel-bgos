import { describe, expect, it } from "vitest";

import {
  childRowsFromCollabItem,
  entryFromItem,
  markerEventBody,
  markerFromNotification,
  rowFromProgressNotification,
  shortenPath,
  summarizeWorkerStates,
  turnContinuesAtEnd,
  workerWord,
} from "../src/activity-markers.js";

describe("entryFromItem (the Codex item table)", () => {
  it("maps a shell command, and reads the failure from the item", () => {
    expect(
      entryFromItem(
        {
          id: "c1",
          type: "commandExecution",
          command: "yarn test",
          status: "completed",
          aggregatedOutput: "2 passing\n",
          exitCode: 0,
          durationMs: 1500,
        },
        "completed",
      ),
    ).toEqual({
      itemId: "c1",
      card: {
        icon: "⚡",
        name: "shell",
        args: "yarn test",
        status: "done",
        kind: "tool",
        output: "2 passing\n",
        exitCode: 0,
        durationMs: 1500,
      },
    });

    expect(
      entryFromItem(
        { id: "c2", type: "commandExecution", command: "false", exitCode: 1 },
        "completed",
      )!.card.status,
    ).toBe("error");
    expect(
      entryFromItem({ id: "c3", type: "commandExecution" }, "started")!.card
        .status,
    ).toBe("running");
  });

  it("gives an edit row the file it touched, and never the diff", () => {
    const row = entryFromItem(
      {
        id: "fc1",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "src/a.ts", kind: { type: "update" }, diff: "-secret\n+key" },
          { path: "src/b.ts", kind: { type: "add" }, diff: "+more" },
        ],
      },
      "completed",
    );

    expect(row).toEqual({
      itemId: "fc1",
      card: {
        icon: "✏️",
        name: "edit",
        args: "src/a.ts +1",
        status: "done",
        kind: "tool",
        path: "src/a.ts",
        pathCount: 2,
        detail: "update",
        linesAdded: 2,
        linesRemoved: 1,
      },
    });
    expect(JSON.stringify(row)).not.toContain("secret");
    expect(JSON.stringify(row)).not.toContain("diff");
  });

  it("reads a change kind in either shape and never ships [object Object]", () => {
    for (const kind of ["update", { type: "update", move_path: "src/c.ts" }]) {
      const row = entryFromItem(
        {
          id: "fc2",
          type: "fileChange",
          status: "completed",
          changes: [{ path: "src/a.ts", kind, diff: "x" }],
        },
        "completed",
      )!;
      expect(row.card.detail).toBe("update");
      expect(row.card.args).toBe("src/a.ts");
      // One path, so no count: pathCount exists to say "+N more files".
      expect(row.card).not.toHaveProperty("pathCount");
      expect(JSON.stringify(row)).not.toContain("[object Object]");
    }
  });

  it("makes one subagent row per worker, keyed on the worker's thread", () => {
    const started = entryFromItem(
      {
        id: "sa1",
        type: "subAgentActivity",
        agentPath: "agents/reviewer.md",
        agentThreadId: "t9",
        kind: "started",
      },
      "started",
    );
    expect(started).toEqual({
      itemId: "t9",
      card: {
        icon: "👥",
        name: "reviewer.md",
        status: "running",
        kind: "subagent",
        detail: "started",
      },
    });

    const statuses = ["interacted", "interrupted", "completed"].map(
      (kind) =>
        entryFromItem(
          {
            id: "sa2",
            type: "subAgentActivity",
            agentPath: "reviewer",
            agentThreadId: "t9",
            kind,
          },
          "completed",
        )!.card.status,
    );
    expect(statuses).toEqual(["running", "error", "done"]);
  });

  it("carries the live worker states on a collab tool call", () => {
    const row = entryFromItem(
      {
        id: "col1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: ["t9", "t10"],
        status: "inProgress",
        agentsStates: {
          t9: { status: "running" },
          t10: { status: "completed" },
        },
      },
      "completed",
    );
    expect(row).toEqual({
      itemId: "col1",
      card: {
        icon: "👥",
        name: "spawnAgent",
        args: "2 workers",
        status: "running",
        detail: "1 running, 1 done",
      },
    });
    // A tool the agent called, never one of its helpers: the app builds the
    // helpers block out of every row whose kind is subagent, and the children
    // have their own rows.
    expect(row!.card.kind).toBeUndefined();

    const settled = entryFromItem(
      {
        id: "col2",
        type: "collabAgentToolCall",
        tool: "wait",
        status: "completed",
        agentsStates: { t9: { status: "completed" } },
      },
      "completed",
    )!;
    expect(settled.card.status).toBe("done");
    expect(settled.card.detail).toBe("1 done");
  });

  /**
   * The delegate call is a TOOL the agent called. Sent as a helper it was
   * counted as one: the app derives the helpers block from every row whose
   * kind is subagent, so one child read "2 helpers", and the spawn call
   * settles in milliseconds while its child works for minutes, so it read
   * "2 helpers, 1 done" over a single running child. A spawn, a wait and a
   * close about one child read "4 helpers, 3 done".
   *
   * MUTATION: put `kind: "subagent"` back on the call row and this goes red.
   */
  it("counts a one child collab item as exactly one helper", () => {
    const item = {
      id: "col1",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "inProgress",
      prompt: "Check the migration\nand report back",
      receiverThreadIds: ["t9"],
      agentsStates: { t9: { status: "running" } },
    };
    const rows = [
      entryFromItem(item, "started")!,
      ...childRowsFromCollabItem(
        item,
        "started",
        { startedAtMs: 1_700_000_000_000 },
        undefined,
        new Map(),
      ),
    ];

    expect(rows.filter((r) => r.card.kind === "subagent")).toHaveLength(1);
    expect(rows[0]!.card.kind).toBeUndefined();
    // The prompt's first line, which says what was delegated. The worker
    // count stays the fallback for a wait or a close, which carry no prompt.
    expect(rows[0]!.card.args).toBe("Check the migration");
    expect(rows[1]!.card).toMatchObject({ kind: "subagent", id: "t9" });
  });

  it("maps the rest of the table, and nothing it does not know", () => {
    const names = (
      [
        [{ id: "w", type: "webSearch", query: "codex app server" }, "started"],
        [
          { id: "m", type: "mcpToolCall", server: "bgos", tool: "reply" },
          "started",
        ],
        [{ id: "d", type: "dynamicToolCall", tool: "board" }, "started"],
        [{ id: "v", type: "imageView", path: "shot.png" }, "started"],
      ] as const
    ).map(([item, phase]) => entryFromItem(item as never, phase)!.card);

    expect(names.map((c) => c.name)).toEqual([
      "web_search",
      "reply",
      "board",
      "view_image",
    ]);
    expect(names[0]!.args).toBe("codex app server");
    expect(names[1]!.args).toBe("bgos.reply");
    expect(names[3]!.path).toBe("shot.png");
    expect(entryFromItem({ id: "r", type: "reasoning" }, "started")).toBeNull();
    expect(entryFromItem({ id: "x", type: "nonsense" }, "started")).toBeNull();
  });
});

describe("rowFromProgressNotification (updates in place)", () => {
  it("recomputes an edit row from a live patch update", () => {
    expect(
      rowFromProgressNotification("item/fileChange/patchUpdated", {
        threadId: "thread-1",
        itemId: "fc1",
        changes: [
          { path: "src/a.ts", kind: "update", diff: "x" },
          { path: "src/b.ts", kind: "add", diff: "y" },
        ],
      }),
    ).toEqual({
      itemId: "fc1",
      card: {
        icon: "✏️",
        name: "edit",
        args: "src/a.ts +1",
        status: "running",
        kind: "tool",
        path: "src/a.ts",
        pathCount: 2,
        detail: "update",
      },
    });
  });

  it("adds an mcp progress line to a row it already knows, and only then", () => {
    const known = { name: "search", icon: "🔌" };
    expect(
      rowFromProgressNotification(
        "item/mcpToolCall/progress",
        { threadId: "thread-1", itemId: "m1", message: "page 2 of 9" },
        known,
      ),
    ).toEqual({
      itemId: "m1",
      card: {
        icon: "🔌",
        name: "search",
        status: "running",
        kind: "tool",
        detail: "page 2 of 9",
      },
    });
    expect(
      rowFromProgressNotification("item/mcpToolCall/progress", {
        threadId: "thread-1",
        itemId: "m1",
        message: "page 2 of 9",
      }),
    ).toBeNull();
  });
});

describe("markerFromNotification", () => {
  it("reads a compaction from the item and from the old notification alike", () => {
    const fromItem = markerFromNotification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "cc1", type: "contextCompaction" },
    });
    const fromNotification = markerFromNotification("thread/compacted", {
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(fromItem!.marker.kind).toBe("context_compacted");
    expect(fromItem!.marker.title).toBe("Context compacted");
    expect(fromItem!.marker.text.length).toBeGreaterThan(0);
    // One marker per turn, however many notifications announce it.
    expect(fromNotification!.dedupeKey).toBe(fromItem!.dedupeKey);
  });

  it("is null for every other notification", () => {
    expect(
      markerFromNotification("item/completed", {
        threadId: "thread-1",
        item: { id: "c1", type: "commandExecution" },
      }),
    ).toBeNull();
    expect(
      markerFromNotification("turn/completed", { threadId: "thread-1" }),
    ).toBeNull();
  });
});

describe("turnContinuesAtEnd", () => {
  it("marks only while a worker is still running or starting up", () => {
    expect(
      turnContinuesAtEnd({ t9: { status: "running" }, t10: { status: "completed" } })!
        .payload.what,
    ).toBe("1 subagent is still working");
    expect(
      turnContinuesAtEnd({
        t9: { status: "pendingInit" },
        t10: { status: "running" },
      })!.payload.what,
    ).toBe("2 subagents are still working");
    expect(
      turnContinuesAtEnd({ t9: { status: "completed" }, t10: { status: "errored" } }),
    ).toBeNull();
    expect(turnContinuesAtEnd(undefined)).toBeNull();
  });
});

describe("markerEventBody", () => {
  it("builds an ordinary event message the old app can still read", () => {
    const body = markerEventBody(
      turnContinuesAtEnd({ t9: { status: "running" } })!,
      { assistantId: 7, chatId: 20 },
    )!;
    expect(body).toMatchObject({
      assistantId: 7,
      chatId: 20,
      sender: "assistant",
      messageType: "event",
      eventMeta: {
        source: "agent",
        title: "Work continues",
        payload: { kind: "turn_continues", what: "1 subagent is still working" },
      },
    });
    expect(String(body.text)).toContain("still working");
  });

  it("refuses a body it cannot address", () => {
    const marker = turnContinuesAtEnd({ t9: { status: "running" } })!;
    expect(markerEventBody(marker, { assistantId: 0, chatId: 20 })).toBeNull();
    expect(markerEventBody(marker, { assistantId: 7, chatId: 0 })).toBeNull();
  });
});


describe("shortenPath (what a file path looks like on the wire)", () => {
  const ctx = { cwd: "/home/kc/code/bgos", home: "/home/kc" };

  it("is relative to the thread's own working directory when it sits inside", () => {
    expect(shortenPath("/home/kc/code/bgos/src/a.ts", ctx)).toBe("src/a.ts");
    expect(shortenPath("/home/kc/code/bgos/a.ts", ctx)).toBe("a.ts");
    // A sibling directory that merely shares a prefix is NOT inside it, so it
    // falls through to the home rule rather than being cut at "bgos".
    expect(shortenPath("/home/kc/code/bgos-old/a.ts", ctx)).toBe(
      "~/code/bgos-old/a.ts",
    );
  });

  it("turns a home directory prefix into ~", () => {
    expect(shortenPath("/home/kc/notes/todo.md", ctx)).toBe("~/notes/todo.md");
    expect(shortenPath("/home/kc/notes/todo.md", { home: "/home/kc" })).toBe(
      "~/notes/todo.md",
    );
  });

  it("falls back to the basename with one parent segment", () => {
    expect(shortenPath("/etc/nginx/sites-available/nest-api", ctx)).toBe(
      "sites-available/nest-api",
    );
    expect(shortenPath("/var/log/syslog", ctx)).toBe("log/syslog");
  });

  it("reads a Windows path, its separator and its case", () => {
    const win = { cwd: "C:\\Users\\Kc\\code\\bgos", home: "C:\\Users\\Kc" };
    expect(shortenPath("c:\\users\\kc\\code\\bgos\\src\\a.ts", win)).toBe(
      "src\\a.ts",
    );
    expect(shortenPath("C:\\Users\\Kc\\notes\\todo.md", win)).toBe(
      "~\\notes\\todo.md",
    );
    expect(shortenPath("D:\\shared\\team\\brief.docx", win)).toBe(
      "team\\brief.docx",
    );
  });

  it("leaves a path that is already relative alone, and clips at 200", () => {
    expect(shortenPath("src/a.ts", ctx)).toBe("src/a.ts");
    expect(shortenPath("a/b/c/d/e.ts", ctx)).toBe("a/b/c/d/e.ts");
    const deep = "/home/kc/code/bgos/" + "x".repeat(400) + "/a.ts";
    expect(shortenPath(deep, ctx)).toHaveLength(200);
    expect(shortenPath("", ctx)).toBe("");
    expect(shortenPath(undefined, ctx)).toBe("");
  });

  it("shortens the path an edit row and an image row put on the wire", () => {
    const edit = entryFromItem(
      {
        id: "fc9",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "/home/kc/code/bgos/src/a.ts", kind: "update", diff: "x" },
        ],
      },
      "completed",
      ctx,
    )!;
    expect(edit.card.path).toBe("src/a.ts");
    expect(edit.card.args).toBe("src/a.ts");

    const image = entryFromItem(
      { id: "im1", type: "imageView", path: "/home/kc/shots/one.png" },
      "started",
      ctx,
    )!;
    expect(image.card.path).toBe("~/shots/one.png");
  });
});

describe("clips that cannot split a character", () => {
  it("never leaves a lone surrogate at the cut", () => {
    // 120 is the args limit; the astral pair straddles it.
    const args = "x".repeat(119) + "\u{1F600}" + "tail";
    const row = entryFromItem(
      { id: "c9", type: "commandExecution", command: args },
      "started",
    )!;
    expect(row.card.args).toHaveLength(119);
    expect(hasLoneSurrogate(row.card.args!)).toBe(false);
    expect(row.card.args!.endsWith("x")).toBe(true);

    // A pair that ends exactly at the limit survives whole.
    const exact = "y".repeat(118) + "\u{1F600}";
    expect(
      entryFromItem(
        { id: "c10", type: "commandExecution", command: exact },
        "started",
      )!.card.args,
    ).toBe(exact);

    // And the same guard on a path (200) and on a detail line (120).
    const path = "/tmp/" + "p".repeat(196) + "\u{1F600}.ts";
    const edit = entryFromItem(
      {
        id: "fc10",
        type: "fileChange",
        status: "completed",
        changes: [{ path, kind: "update", diff: "x" }],
      },
      "completed",
      { cwd: "/tmp", home: "/home/kc" },
    )!;
    expect(hasLoneSurrogate(edit.card.path!)).toBe(false);
    const message = "m".repeat(119) + "\u{1F600}";
    const progress = rowFromProgressNotification(
      "item/mcpToolCall/progress",
      { itemId: "m9", message },
      { name: "search", icon: "🔌" },
    )!;
    expect(hasLoneSurrogate(progress.card.detail!)).toBe(false);
  });
});

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

describe("a settled row is never re opened by a late refinement", () => {
  it("drops a progress notification for a row the card has closed", () => {
    for (const status of ["done", "error"] as const) {
      expect(
        rowFromProgressNotification(
          "item/mcpToolCall/progress",
          { itemId: "m1", message: "page 9 of 9" },
          { name: "search", icon: "🔌", status },
        ),
      ).toBeNull();
      expect(
        rowFromProgressNotification(
          "item/fileChange/patchUpdated",
          { itemId: "fc1", changes: [{ path: "src/a.ts", kind: "update" }] },
          { name: "edit", icon: "✏️", status },
        ),
      ).toBeNull();
    }
    // Still running: the refinement is exactly what it is for.
    expect(
      rowFromProgressNotification(
        "item/mcpToolCall/progress",
        { itemId: "m1", message: "page 2 of 9" },
        { name: "search", icon: "🔌", status: "running" },
      )!.card.detail,
    ).toBe("page 2 of 9");
    // A row the turn has never seen is not "settled", it is unknown, and a
    // patch update opens it.
    expect(
      rowFromProgressNotification("item/fileChange/patchUpdated", {
        itemId: "fc2",
        changes: [{ path: "src/a.ts", kind: "update" }],
      }),
    ).not.toBeNull();
  });
});

describe("pathCount counts files, and only when there is more than one", () => {
  it("ignores a change that names no path at all", () => {
    const row = entryFromItem(
      {
        id: "fc3",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "src/a.ts", kind: "update", diff: "x" },
          { kind: "delete", diff: "y" },
        ],
      },
      "completed",
    )!;
    expect(row.card.args).toBe("src/a.ts");
    expect(row.card).not.toHaveProperty("pathCount");

    const two = entryFromItem(
      {
        id: "fc4",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "src/a.ts", kind: "update", diff: "x" },
          { kind: "delete", diff: "y" },
          { path: "src/b.ts", kind: "add", diff: "z" },
        ],
      },
      "completed",
    )!;
    expect(two.card.pathCount).toBe(2);
    expect(two.card.args).toBe("src/a.ts +1");
  });

  it("gives a single image path no count either", () => {
    const row = entryFromItem(
      { id: "im2", type: "imageGeneration", path: "out.png" },
      "completed",
    )!;
    expect(row.card.path).toBe("out.png");
    expect(row.card).not.toHaveProperty("pathCount");
  });
});

describe("durationMs comes from the envelope when the item has none", () => {
  it("times every kind of row, not only a shell row", () => {
    const span = { startedAtMs: 1_000, completedAtMs: 3_500 };
    const rows = [
      { id: "fc5", type: "fileChange", status: "completed", changes: [] },
      { id: "w1", type: "webSearch", query: "codex" },
      { id: "m2", type: "mcpToolCall", server: "bgos", tool: "reply" },
      {
        id: "col3",
        type: "collabAgentToolCall",
        tool: "wait",
        status: "completed",
        agentsStates: { t9: { status: "completed" } },
      },
    ].map((item) => entryFromItem(item as never, "completed", span)!);
    expect(rows.map((r) => r.card.durationMs)).toEqual([2500, 2500, 2500, 2500]);

    // The item's own number wins where it has one.
    expect(
      entryFromItem(
        { id: "c11", type: "commandExecution", command: "ls", durationMs: 42 },
        "completed",
        span,
      )!.card.durationMs,
    ).toBe(42);
    // Half an envelope, a backwards clock or a zero span: no duration at all.
    for (const partial of [
      { startedAtMs: 1_000 },
      { completedAtMs: 3_500 },
      { startedAtMs: 3_500, completedAtMs: 1_000 },
      { startedAtMs: 1_000, completedAtMs: 1_000 },
    ]) {
      expect(
        entryFromItem(
          { id: "w2", type: "webSearch", query: "codex" },
          "completed",
          partial,
        )!.card,
      ).not.toHaveProperty("durationMs");
    }
  });
});

/**
 * What a shell row carries out of the machine, added in stage 7.
 *
 * MUTATION PROOFS (each test names the change that must turn it red):
 *  - read item.aggregated_output -> "carries what the command printed" goes red
 *  - route the output through clip() -> "keeps the line breaks" goes red
 *  - guard exitCode with a falsy check -> "a successful zero" goes red
 *  - drop the minus one to 255 range guard -> "an exit code the wire cannot carry" goes red
 *  - copy aggregatedOutput straight onto the card -> "masks a secret" goes red
 */
describe("a shell row carries what the command printed", () => {
  const done = (item: Record<string, unknown>) =>
    entryFromItem({ id: "c20", type: "commandExecution", ...item }, "completed")!
      .card;

  it("carries what the command printed, and nothing while it still runs", () => {
    expect(
      done({ command: "ls", status: "completed", aggregatedOutput: "out.txt" })
        .output,
    ).toBe("out.txt");

    const running = entryFromItem(
      {
        id: "c21",
        type: "commandExecution",
        command: "ls",
        aggregatedOutput: "out.txt",
        exitCode: 0,
      },
      "started",
    )!.card;
    expect(running).not.toHaveProperty("output");
    expect(running).not.toHaveProperty("exitCode");

    // Nothing printed, nothing carried.
    expect(done({ command: "true", aggregatedOutput: null })).not.toHaveProperty(
      "output",
    );
    expect(done({ command: "true" })).not.toHaveProperty("output");
  });

  it("keeps the line breaks, so a stack trace is still a stack trace", () => {
    const trace = "Traceback:\n  File main.py, line 2\nZeroDivisionError";
    expect(done({ command: "python3 x.py", aggregatedOutput: trace }).output).toBe(
      trace,
    );
  });

  it("keeps a successful exit code of zero", () => {
    expect(done({ command: "true", exitCode: 0, status: "completed" })).toEqual(
      expect.objectContaining({ exitCode: 0, status: "done" }),
    );
    expect(done({ command: "false", exitCode: 1 }).exitCode).toBe(1);
    // Minus one is a signal death with no code of its own.
    expect(done({ command: "sleep 9", exitCode: -1 }).exitCode).toBe(-1);
  });

  it("leaves an exit code the wire cannot carry absent, rather than costing the card", () => {
    // Windows reports an access violation as 3221225477. The platform accepts
    // minus one to 255 and would refuse the whole PATCH for anything else, so
    // the row keeps its red colour and simply has no chip.
    const huge = done({ command: "crash.exe", exitCode: 3_221_225_477 });
    expect(huge).not.toHaveProperty("exitCode");
    expect(huge.status).toBe("error");
    for (const code of [-2, 256, 1.5, Number.NaN, "1"]) {
      expect(done({ command: "x", exitCode: code })).not.toHaveProperty(
        "exitCode",
      );
    }
  });

  it("masks a secret before the output ever reaches the card", () => {
    const card = done({
      command: "env",
      aggregatedOutput: "AWS_KEY=AKIAIOSFODNN7EXAMPLE\nHOME=/home/kc",
    });
    expect(card.output).toBe("AWS_KEY=AKIA...\nHOME=/home/kc");
    expect(JSON.stringify(card)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

/**
 * One row per CHILD agent, off the only per child datum the Codex protocol
 * carries: `collabAgentToolCall.agentsStates`, a map from the child's own
 * thread id to `{ status, message }`.
 *
 * Every case below names the mutation that must turn it red, because the
 * three defects this branch exists to prevent all pass a shallow reading:
 * the spawn CALL settles in milliseconds while its child runs for minutes,
 * the collab ITEM id changes between the spawn call and the later wait call
 * while the child's thread id does not, and a status message is model text
 * that must be masked over the WHOLE string before any cut.
 */
describe("childRowsFromCollabItem (one row per child agent)", () => {
  function collab(
    states: Record<string, { status: string; message?: string | null }>,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: "col1",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: "parent",
      receiverThreadIds: Object.keys(states),
      agentsStates: states,
      ...extra,
    };
  }

  // MUTATION: return `itemId: String(item.id)` instead of the child's thread
  // id and this goes red, which is the trap the whole branch exists for.
  it("makes one row per child state, keyed on the child's own thread", () => {
    const rows = childRowsFromCollabItem(
      collab({ t9: { status: "running" }, t10: { status: "completed" } }),
      "started",
      { startedAtMs: 1_700_000_000_000 },
      new Map([["t9", "reviewer"]]),
      new Map(),
    );

    expect(rows.map((r) => r.itemId)).toEqual(["t9", "t10"]);
    expect(rows[0]!.card).toEqual({
      icon: "👥",
      name: "reviewer",
      status: "running",
      kind: "subagent",
      id: "t9",
      startedAt: "2023-11-14T22:13:20.000Z",
      detail: "running",
    });
    // No name was supplied for this one, so it says what it is and no more.
    expect(rows[1]!.card).toEqual({
      icon: "👥",
      name: "helper",
      status: "done",
      kind: "subagent",
      id: "t10",
      startedAt: "2023-11-14T22:13:20.000Z",
    });
  });

  // MUTATION: map "completed" to "running" (or drop the table and default
  // everything to running) and the list below goes red.
  it("maps all seven child statuses, and an unknown one reads as running", () => {
    const seven = [
      "pendingInit",
      "running",
      "interrupted",
      "completed",
      "errored",
      "shutdown",
      "notFound",
    ];
    const states = Object.fromEntries(
      seven.map((status, i) => [`t${i}`, { status }]),
    );
    const rows = childRowsFromCollabItem(
      collab(states),
      "started",
      {},
      undefined,
      new Map(),
    );
    expect(rows.map((r) => r.card.status)).toEqual([
      "running",
      "running",
      "error",
      "done",
      "error",
      "error",
      "error",
    ]);

    const future = childRowsFromCollabItem(
      collab({ t9: { status: "somethingNew" } }),
      "started",
      {},
      undefined,
      new Map(),
    );
    expect(future[0]!.card.status).toBe("running");
  });

  // MUTATION: read the child's status from `item.status` (or hand the item to
  // `toolStatus`) and this goes red: the spawn CALL completed, the child did
  // not, and every helper on the card would read done the moment it started.
  it("draws a running child under a spawn call that has already completed", () => {
    const rows = childRowsFromCollabItem(
      collab({ t9: { status: "running" } }, { status: "completed" }),
      "completed",
      { startedAtMs: 1_000, completedAtMs: 5_000 },
      undefined,
      new Map(),
    );
    expect(rows[0]!.card.status).toBe("running");
    // Still working, so nothing has a duration yet.
    expect(rows[0]!.card).not.toHaveProperty("durationMs");
  });

  // MUTATION: set `detail` from the message at a terminal state too (or set
  // `result` while the child runs) and this goes red.
  it("puts the state message in detail while it runs and in result when it ends", () => {
    const seen = new Map<string, number>();
    const running = childRowsFromCollabItem(
      collab({ t9: { status: "running", message: "reading the spec" } }),
      "started",
      { startedAtMs: 1_000_000 },
      undefined,
      seen,
    )[0]!.card;
    expect(running.detail).toBe("reading the spec");
    expect(running).not.toHaveProperty("result");

    const settled = childRowsFromCollabItem(
      {
        ...collab({
          t9: { status: "completed", message: "ran 42 tests, all green" },
        }),
        id: "col2",
      },
      "completed",
      { startedAtMs: 1_000_000, completedAtMs: 1_012_000 },
      undefined,
      seen,
    )[0]!.card;
    expect(settled.result).toBe("ran 42 tests, all green");
    // The qualifier is gone, not stale: the card's merge clears a subagent
    // row's detail when the row reports none.
    expect(settled).not.toHaveProperty("detail");
    expect(settled.durationMs).toBe(12_000);
  });

  // MUTATION: clip the message before masking it (mask the clipped value) and
  // this goes red, because the cut lands inside the key and the rule that
  // would have matched it no longer does.
  it("masks a secret in the state message before the 240 character cut", () => {
    const message = "x".repeat(231) + " AKIAIOSFODNN7EXAMPLE tail";
    const card = childRowsFromCollabItem(
      collab({ t9: { status: "completed", message } }),
      "completed",
      {},
      undefined,
      new Map(),
    )[0]!.card;

    expect(card.result).toContain("AKIA...");
    expect(card.result).not.toContain("AKIAI");
    expect(JSON.stringify(card)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  // MUTATION: keep the LAST 240 characters (swap the head clip for
  // `tailClip`) and this goes red. A child answers at the start of its last
  // message, so the head is the half worth keeping.
  it("keeps the FIRST 240 characters of a long result", () => {
    const card = childRowsFromCollabItem(
      collab({
        t9: { status: "completed", message: "a".repeat(120) + "b".repeat(180) },
      }),
      "completed",
      {},
      undefined,
      new Map(),
    )[0]!.card;

    expect(card.result).toHaveLength(240);
    expect(card.result).toBe("a".repeat(120) + "b".repeat(120));
  });

  // MUTATION: record the first sight unconditionally (overwrite the map on
  // every item) and this goes red: the elapsed would jump backwards on every
  // later wait or list call about the same child.
  it("keeps the first sight of a child when a later collab item names it again", () => {
    const seen = new Map<string, number>();
    childRowsFromCollabItem(
      collab({ t9: { status: "running" } }),
      "started",
      { startedAtMs: 1_000 },
      undefined,
      seen,
    );
    const later = childRowsFromCollabItem(
      { ...collab({ t9: { status: "running" } }), id: "col2" },
      "started",
      { startedAtMs: 90_000 },
      undefined,
      seen,
    )[0]!.card;

    expect(later.startedAt).toBe(new Date(1_000).toISOString());
    expect(seen.get("t9")).toBe(1_000);
  });

  // MUTATION: draw a row for every entry of `receiverThreadIds` and this goes
  // red twice over: a wait call reports states for agents it did not spawn,
  // and it carries no receivers at all.
  it("reads the states map and never the receivers array", () => {
    const rows = childRowsFromCollabItem(
      {
        id: "col9",
        type: "collabAgentToolCall",
        tool: "wait",
        status: "completed",
        receiverThreadIds: [],
        agentsStates: { t42: { status: "running" } },
      },
      "completed",
      {},
      undefined,
      new Map(),
    );
    expect(rows.map((r) => r.itemId)).toEqual(["t42"]);
  });

  // MUTATION: return a row for a states map that is empty or missing and this
  // goes red. A runtime that reports no children draws no block at all.
  it("draws nothing at all where there is no child to draw", () => {
    const empty = { startedAtMs: 1 };
    expect(
      childRowsFromCollabItem(collab({}), "started", empty, undefined, new Map()),
    ).toEqual([]);
    expect(
      childRowsFromCollabItem(
        { id: "c1", type: "collabAgentToolCall", tool: "wait" },
        "started",
        empty,
        undefined,
        new Map(),
      ),
    ).toEqual([]);
    expect(
      childRowsFromCollabItem(
        { id: "x", type: "commandExecution", command: "ls" },
        "started",
        empty,
        undefined,
        new Map(),
      ),
    ).toEqual([]);
    expect(
      childRowsFromCollabItem(
        null as never,
        "started",
        empty,
        undefined,
        new Map(),
      ),
    ).toEqual([]);
    // An entry that is not a record at all is one child the card cannot
    // honestly draw, and the others still draw.
    const mixed = childRowsFromCollabItem(
      collab({ t1: null as never, t2: { status: "running" } }),
      "started",
      empty,
      undefined,
      new Map(),
    );
    expect(mixed.map((r) => r.itemId)).toEqual(["t2"]);
  });

  // MUTATION: key the child row on the collab item id and this goes red: a
  // child that produces both a subAgentActivity and a state entry would draw
  // two rows and the header would count it twice.
  it("keys a subAgentActivity and a collab state for one child on one row", () => {
    const activity = entryFromItem(
      {
        id: "sa1",
        type: "subAgentActivity",
        agentPath: "agents/reviewer.md",
        agentThreadId: "t9",
        kind: "started",
      },
      "started",
    )!;
    const child = childRowsFromCollabItem(
      collab({ t9: { status: "running" } }),
      "started",
      {},
      undefined,
      new Map(),
    )[0]!;

    expect(child.itemId).toBe(activity.itemId);
  });

  // MUTATION: pass the whole prompt to `args` and this goes red on the second
  // line; drop the names map and the first name goes red.
  it("names the child from the map it was given, and takes args from the prompt's first line", () => {
    const rows = childRowsFromCollabItem(
      collab(
        { t9: { status: "running" }, t10: { status: "running" } },
        { prompt: "Run the sign up tests\nand report back" },
      ),
      "started",
      {},
      new Map([["t9", "scout"]]),
      new Map(),
    );
    expect(rows.map((r) => r.card.name)).toEqual(["scout", "helper"]);
    expect(rows[0]!.card.args).toBe("Run the sign up tests");

    const noPrompt = childRowsFromCollabItem(
      collab({ t9: { status: "running" } }),
      "started",
      {},
      undefined,
      new Map(),
    )[0]!.card;
    expect(noPrompt).not.toHaveProperty("args");
  });

  // MUTATION: copy the state message into `output` as well and this goes red.
  // A child row is never a command row: it carries no output, so the app
  // draws it with no chevron and nothing to open.
  it("leaves every command field absent on a child row", () => {
    const card = childRowsFromCollabItem(
      collab(
        { t9: { status: "completed", message: "done" } },
        { prompt: "go" },
      ),
      "completed",
      { startedAtMs: 1_000, completedAtMs: 2_000 },
      undefined,
      new Map(),
    )[0]!.card;

    for (const field of [
      "output",
      "path",
      "pathCount",
      "exitCode",
      "linesAdded",
      "linesRemoved",
    ]) {
      expect(card).not.toHaveProperty(field);
    }
  });

  // MUTATION: give `workerWord` a table of its own with one word changed and
  // this goes red, which is why the header and the row read one table.
  it("falls back to the state word the folded header uses", () => {
    const rows = childRowsFromCollabItem(
      collab({
        t9: { status: "pendingInit" },
        t10: { status: "running", message: "   " },
      }),
      "started",
      {},
      undefined,
      new Map(),
    );
    expect(rows.map((r) => r.card.detail)).toEqual(["starting", "running"]);

    expect(workerWord("notFound")).toBe("gone");
    expect(workerWord("somethingNew")).toBe("");
    expect(summarizeWorkerStates({ a: { status: "pendingInit" } })).toBe(
      `1 ${workerWord("pendingInit")}`,
    );
  });
});
