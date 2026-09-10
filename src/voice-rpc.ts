/**
 * Voice control-plane wire types + normalizer.
 *
 * v0.3 handles mint, invisible consult/compose, confirmed background dispatch,
 * per-chat stop, and cancellation in the adapter. Only server control frames
 * enter this lane; chat text never becomes a control-plane instruction.
 *
 * Types mirror gobot-channel-bgos/src/voice-rpc.ts (originally the OpenClaw
 * normalizer) so a future voice module drops in without a wire change.
 */

export type VoiceRpcOp =
  | "mint"
  | "consult"
  | "dispatch"
  | "stop_turn"
  | "cancel";

export interface VoiceRpcFrame {
  rpcId: string;
  op: VoiceRpcOp;
  assistantId: string | number;
  agentRoute: string;
  chatId: string | number | null;
  payload: Record<string, unknown>;
}

export interface VoiceRpcResultBody {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
}

/**
 * Validate a voice_rpc control frame. Backend emits camelCase:
 * {rpcId, op, assistantId, agentRoute, chatId, payload}. Ops are WHITELISTED,
 * anything else is dropped here.
 */
export function normalizeVoiceRpc(raw: unknown): VoiceRpcFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rpcId = typeof r.rpcId === "string" ? r.rpcId : "";
  const op =
    r.op === "mint" ||
    r.op === "consult" ||
    r.op === "dispatch" ||
    r.op === "stop_turn" ||
    r.op === "cancel"
      ? r.op
      : null;
  if (!rpcId || !op) return null;
  return {
    rpcId,
    op,
    assistantId:
      typeof r.assistantId === "number" || typeof r.assistantId === "string"
        ? r.assistantId
        : "",
    agentRoute: typeof r.agentRoute === "string" ? r.agentRoute : "",
    chatId:
      typeof r.chatId === "number" || typeof r.chatId === "string"
        ? r.chatId
        : null,
    payload:
      r.payload && typeof r.payload === "object"
        ? (r.payload as Record<string, unknown>)
        : {},
  };
}
