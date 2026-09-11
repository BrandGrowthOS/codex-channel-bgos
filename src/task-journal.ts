import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";

export type TaskResult =
  | { ok: true; payload: { text: string } }
  | { ok: false; error: { code: string; message: string } };
type RecordEntry = { startedAt: number; result?: TaskResult };
/** Claim before executing. A restart must not repeat an already authorized write. */
export class TaskJournal {
  private records: Record<string, RecordEntry> = {};
  constructor(private path: string) {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error(
          "The task journal could not be read. Restore it before resuming voice tasks.",
        );
      this.records = data;
    }
  }
  get(id: string): RecordEntry | undefined {
    return Object.hasOwn(this.records, id) ? this.records[id] : undefined;
  }
  begin(id: string): void {
    if (this.get(id)) throw new Error("Task was already started.");
    this.records[id] = { startedAt: Date.now() };
    this.save();
  }
  complete(id: string, result: TaskResult): TaskResult {
    const record = this.get(id);
    if (!record) throw new Error("Task was not claimed.");
    if (record.result) return record.result;
    record.result = result;
    this.save();
    return result;
  }
  private save(): void {
    // Keep the durable claim even when the delivery must be retried.
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.records), { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
