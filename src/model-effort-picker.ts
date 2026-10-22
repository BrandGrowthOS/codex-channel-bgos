import type { CodexModel, SessionSettings } from "./session-settings.js";

export const MODEL_EFFORT_PICKER = "model_effort_picker";
export const PICKER_OPS = ["list_model_effort", "apply_model_effort"] as const;
export type PickerOp = (typeof PICKER_OPS)[number];
export class PickerRefusal extends Error {
  readonly code = "not_allowed";
}
const LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
export const pickerEffortLabel = (effort: string | null) => effort ? LABELS[effort] ?? effort : "Unknown";

export function modelFamily(name: string): string {
  return (
    name
      .replace(/\bGPT[ -]?\d+(?:\.\d+)*/gi, "GPT")
      .replace(/\b\d+(?:[.-]\d+)*\b/g, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim().replace(/\b[a-z]/g, letter => letter.toUpperCase()) || "Codex"
  );
}

export function buildPickerCatalog(
  models: CodexModel[],
  current: { model?: string | null; effort?: string | null } | null,
  sessionId: string,
) {
  return {
    runtime: "codex" as const,
    sessionId,
    current: current?.model
      ? { model: current.model, effort: current.effort ?? null }
      : null,
    models: models.slice(0, 100).map((model) => ({
      id: model.model,
      label: modelFamily(model.displayName),
      description: model.description.slice(0, 500),
      enabled: true,
      defaultEffort: model.defaultReasoningEffort,
      efforts: [
        ...new Map(
          model.supportedReasoningEfforts.map((e) => [e.reasoningEffort, e]),
        ).values(),
      ]
        .sort(
          (a, b) =>
            (LEVELS.indexOf(a.reasoningEffort) < 0
              ? 99
              : LEVELS.indexOf(a.reasoningEffort)) -
            (LEVELS.indexOf(b.reasoningEffort) < 0
              ? 99
              : LEVELS.indexOf(b.reasoningEffort)),
        )
        .slice(0, 20)
        .map((e) => ({
          id: e.reasoningEffort,
          label: LABELS[e.reasoningEffort] ?? e.reasoningEffort,
          enabled: LEVELS.includes(e.reasoningEffort),
          reason: LEVELS.includes(e.reasoningEffort)
            ? null
            : "Update the connector to use this effort level.",
        })),
    })),
  };
}

interface PickerHost {
  listModels(refresh?: boolean): Promise<CodexModel[]>;
  updateSettings(
    chatId: number,
    patch: SessionSettings,
    expectedSessionId?: string,
  ): Promise<SessionSettings>;
}

export async function applyPickerSelection(
  host: PickerHost,
  chatId: number,
  input: Record<string, unknown>,
) {
  const { sessionId, model, effort } = input;
  if (
    !Number.isSafeInteger(chatId) ||
    chatId <= 0 ||
    typeof sessionId !== "string" ||
    !sessionId ||
    sessionId.length > 200 ||
    typeof model !== "string" ||
    typeof effort !== "string"
  )
    throw new PickerRefusal(
      "Choose a model and effort from this session's picker.",
    );
  const available = (await host.listModels(true)).find(
    (m) => m.model === model,
  );
  if (
    !available ||
    !LEVELS.includes(effort) ||
    !available.supportedReasoningEfforts.some(
      (e) => e.reasoningEffort === effort,
    )
  )
    throw new PickerRefusal(
      "That model or effort is not allowed. Open the picker again.",
    );
  const applied = await host.updateSettings(
    chatId,
    { model, effort },
    sessionId,
  );
  return { model: applied.model!, effort: applied.effort ?? null };
}
