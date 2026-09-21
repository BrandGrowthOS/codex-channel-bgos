import { describe, expect, it } from "vitest";

import {
  entryFromItem,
  markerEventBody,
  markerFromNotification,
  rowFromProgressNotification,
  shortenPath,
  turnContinuesAtEnd,
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
        kind: "subagent",
        detail: "1 running, 1 done",
      },
    });

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
