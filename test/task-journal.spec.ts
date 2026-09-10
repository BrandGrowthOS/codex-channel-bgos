import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TaskJournal } from "../src/task-journal.js";
const homes: string[] = [];
const file = () => {
  const dir = mkdtempSync(join(tmpdir(), "hoai-journal-"));
  homes.push(dir);
  return join(dir, "tasks.json");
};
afterEach(() => {
  homes.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
it("retains unfinished claims across restart so writes cannot run twice", () => {
  const path = file();
  const one = new TaskJournal(path);
  one.begin("task-1");
  const restarted = new TaskJournal(path);
  expect(restarted.get("task-1")).toBeDefined();
  expect(() => restarted.begin("task-1")).toThrow();
});
it("persists results before delivery and never changes an already completed task", () => {
  const path = file();
  const journal = new TaskJournal(path);
  journal.begin("task-1");
  const result = { ok: true as const, payload: { text: "Done" } };
  journal.complete("task-1", result);
  expect(new TaskJournal(path).get("task-1")?.result).toEqual(result);
  expect(
    journal.complete("task-1", {
      ok: false,
      error: { code: "LATE_ERROR", message: "Delivery failed" },
    }),
  ).toEqual(result);
});
it("fails closed on a corrupted journal", () => {
  const path = file();
  writeFileSync(path, "not-json");
  expect(() => new TaskJournal(path)).toThrow();
});
