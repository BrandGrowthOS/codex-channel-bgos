/** Per-HOAI-chat settings. Never modify the user's shared Codex config. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SessionSettings {
  model?: string;
  effort?: string;
  mode?: "default" | "plan";
  personality?: "none" | "friendly" | "pragmatic";
  permission?: "workspace" | "read-only";
  serviceTier?: string | null;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: Array<{
    reasoningEffort: string;
    description: string;
  }>;
  defaultReasoningEffort: string;
  supportsPersonality: boolean;
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  isDefault: boolean;
}

function clean(value: unknown): SessionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  const out: SessionSettings = {};
  if (typeof v.model === "string" && /^[\w./:-]{1,160}$/.test(v.model))
    out.model = v.model;
  if (typeof v.effort === "string" && /^[a-z]{1,20}$/.test(v.effort))
    out.effort = v.effort;
  if (v.mode === "default" || v.mode === "plan") out.mode = v.mode;
  if (
    v.personality === "none" ||
    v.personality === "friendly" ||
    v.personality === "pragmatic"
  )
    out.personality = v.personality;
  if (v.permission === "workspace" || v.permission === "read-only")
    out.permission = v.permission;
  if (
    v.serviceTier === null ||
    (typeof v.serviceTier === "string" && /^[\w-]{1,50}$/.test(v.serviceTier))
  )
    out.serviceTier = v.serviceTier;
  return out;
}

export class SessionSettingsStore {
  private values: Record<string, SessionSettings> = {};
  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [id, value] of Object.entries(parsed)) {
          if (/^[1-9]\d*$/.test(id)) this.values[id] = clean(value);
        }
      }
    } catch {
      /* No settings on the first run. */
    }
  }
  get(chatId: number): SessionSettings {
    return { ...this.values[String(chatId)] };
  }
  /**
   * Every chat this store has a setting for, cleaned. The daemon reports each
   * chat's session mode to BGOS at connect, and it cannot ask for a list it
   * has no way to enumerate.
   */
  entries(): Array<[number, SessionSettings]> {
    return Object.entries(this.values).map(([id, value]) => [
      Number(id),
      { ...value },
    ]);
  }
  set(chatId: number, value: SessionSettings): void {
    if (!Number.isSafeInteger(chatId) || chatId <= 0)
      throw new Error("Invalid chat identity.");
    const next = { ...this.values, [String(chatId)]: clean(value) };
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
    this.values = next;
  }
}

export function nativeSettings(
  settings: SessionSettings,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (settings.model) out.model = settings.model;
  if (settings.effort) out.effort = settings.effort;
  if (settings.personality) out.personality = settings.personality;
  if (settings.serviceTier !== undefined)
    out.serviceTier = settings.serviceTier;
  if (settings.permission) {
    out.approvalPolicy = "on-request";
    out.sandboxPolicy =
      settings.permission === "read-only"
        ? { type: "readOnly" }
        : {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          };
  }
  if (settings.mode && settings.model) {
    out.collaborationMode = {
      mode: settings.mode,
      settings: {
        model: settings.model,
        reasoning_effort: settings.effort ?? null,
        developer_instructions: null,
      },
    };
  }
  return out;
}

export function validateSettings(
  settings: SessionSettings,
  models: CodexModel[],
): SessionSettings {
  const model = models.find(
    (m) => m.model === settings.model || m.id === settings.model,
  );
  if (!model)
    throw new Error(
      "That model is not available in this Codex account. Open /model to choose one.",
    );
  const effort = settings.effort ?? model.defaultReasoningEffort;
  if (
    effort &&
    !model.supportedReasoningEfforts.some((e) => e.reasoningEffort === effort)
  ) {
    throw new Error(
      `This model supports: ${model.supportedReasoningEfforts.map((e) => e.reasoningEffort).join(", ")}.`,
    );
  }
  if (
    settings.personality &&
    settings.personality !== "none" &&
    !model.supportsPersonality
  ) {
    throw new Error("This model does not support personality settings.");
  }
  if (
    settings.serviceTier &&
    !model.serviceTiers.some((t) => t.id === settings.serviceTier)
  ) {
    throw new Error("That speed tier is not offered for this model.");
  }
  return { ...settings, model: model.model, effort };
}
