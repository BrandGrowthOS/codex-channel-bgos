/**
 * Voice control-plane wire types + normalizer.
 *
 * In-app realtime voice (mint / consult / dispatch) is DEFERRED for the Codex
 * adapter v1 (parity with the Hermes / OpenClaw / Gobot decision to ship chat
 * first). We keep the frame types and the normalizer so the WS layer can accept
 * and safely drop `voice_rpc` frames, and so `bgos-api` can expose the ack /
 * result endpoints for a later voice build. No handler is wired: an unhandled
 * frame simply times out on the backend, which surfaces the failure to the app.
 *
 * Types mirror gobot-channel-bgos/src/voice-rpc.ts (originally the OpenClaw
 * normalizer) so a future voice module drops in without a wire change.
 */

export type VoiceRpcOp = "mint" | "consult" | "dispatch";

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
    r.op === "mint" || r.op === "consult" || r.op === "dispatch"
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
