import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserRelayCredentials } from "./browser-mcp.js";

const validUser = (value: unknown): value is string =>
  typeof value === "string" && /^user_[A-Za-z0-9_-]+$/.test(value);

/** Read authenticated delivery metadata only. The envelope owner is not a sender. */
export function browserActorFromDelivery(raw: Record<string, any>): string | null {
  if (raw.peerConversationId || raw.peer_conversation_id || raw.agentOrigin || raw.agent_origin) return null;
  const kind = raw.chatKind ?? raw.chat_kind ?? raw.groupContext?.chatKind;
  if (kind && !["main", "side", "agent", "dm"].includes(kind)) return null;
  const type = raw.senderType ?? raw.sender_type;
  if (type === "agent") return null;
  if (type === "system") {
    const event = raw.eventMeta ?? raw.event_meta;
    const actor = event?.source === "scheduler" ? event.payload?.actingUserId : null;
    return validUser(actor) ? actor : null;
  }
  // BGOS sends no senderType on an ordinary human turn (agent and peer
  // deliveries were refused above), so absent means the authored human.
  if (type != null && type !== "user") return null;
  const actor = raw.senderUserId ?? raw.sender_user_id ?? raw.sender?.userId;
  return validUser(actor) ? actor : null;
}

function writeJson(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}

/** One MCP process scope. Never share its files with detached or forked work. */
export class BrowserContext {
  readonly env: Record<string, string>;
  readonly sessionId = randomUUID();
  private readonly path: string;
  private readonly markerPath: string;
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  private lastActor: string | null = null;

  constructor(root: string, private readonly chatId: number, readonly relay: BrowserRelayCredentials | null) {
    const dir = join(root, `${process.pid}-${this.sessionId}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, "context.json");
    this.markerPath = join(dir, "marker.json");
    this.env = {
      HOAI_RELAY_CONTEXT_FILE: this.path,
      HOAI_RELAY_OWNER_USER_ID: relay?.ownerUserId ?? "",
      HOAI_RELAY_CLIENT_PID: String(process.pid),
    };
    this.invalidate();
  }

  private invalidate(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    writeJson(this.markerPath, { schemaVersion: 1, live: false });
    writeJson(this.path, { context: { live: false } });
  }

  begin(actor: string | null | undefined, input: unknown): (forgetActor?: boolean) => void {
    const generation = ++this.generation;
    this.invalidate();
    this.lastActor = validUser(actor) ? actor : null;
    if (!this.lastActor || !validUser(this.relay?.ownerUserId) || !this.relay?.pairingToken) return () => {};
    const turnId = randomUUID();
    const promptHash = createHash("sha256").update(JSON.stringify(input) ?? "").digest("hex");
    const marker = { schemaVersion: 1, turnId, sessionId: this.sessionId, promptHash, live: true };
    writeJson(this.markerPath, marker);
    const publish = () => {
      const context = {
        schemaVersion: 1, assistantId: String(this.relay!.assistantId),
        ownerUserId: this.relay!.ownerUserId, actingUserId: this.lastActor,
        chatId: String(this.chatId), turnId, sessionId: this.sessionId,
        claudePid: process.pid, pid: process.pid, updatedAt: Date.now(), live: true,
        markerPath: this.markerPath, promptHash,
      };
      const signature = createHmac("sha256", this.relay!.pairingToken).update(JSON.stringify(context)).digest("hex");
      writeJson(this.path, { context, signature });
    };
    publish();
    this.timer = setInterval(() => { try { publish(); } catch { this.end(); } }, 20_000);
    this.timer.unref();
    return (forgetActor = false) => {
      if (this.generation !== generation) return;
      if (forgetActor) this.lastActor = null;
      this.invalidate();
    };
  }

  /** A continuation inherits only this process's last admitted thread actor. */
  continue(): () => void { return this.begin(this.lastActor, "Goal continuation"); }

  suspend(): void { ++this.generation; this.invalidate(); }

  continuationActor(): string | null { return this.lastActor; }

  end(): void { ++this.generation; this.lastActor = null; this.invalidate(); }
}
