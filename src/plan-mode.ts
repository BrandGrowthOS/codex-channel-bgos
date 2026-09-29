/**
 * Plan mode's two knobs, and which one of them actually refuses a write.
 *
 * Codex has a real plan mode and it is NOT a lock. The live probe of
 * 2026-09-23 (`_tools-p2/probes/codex-plan-probe.js`, app server 0.154.0)
 * set `collaborationMode: { mode: "plan" }` on the thread AND on the turn,
 * and the model then ran `exec_command`, wrote a file inside the workspace,
 * and no approval was ever raised. `thread/settings/updated` says why in one
 * line: the mode fills `developer_instructions` with a strict 9 KB prompt and
 * leaves `sandboxPolicy` exactly where it was. See
 * docs/learnings/codex-plan-mode-wire.md.
 *
 * The only lock this daemon owns is the chat's own `permission`, because
 * `nativeSettings()` turns `read-only` into `sandboxPolicy: { type: "readOnly" }`
 * and that IS refused by the runtime. So plan mode here is two settings moved
 * together, and this file is the one place that knows which pair:
 *
 * - ON: `mode: "plan"` AND `permission: "read-only"`, with the permission the
 *   chat had BEFORE remembered so it can be given back.
 * - OFF: `mode: "default"` and the remembered permission restored, whatever it
 *   was. An owner who had already chosen read only keeps read only.
 *
 * WHY REMEMBER RATHER THAN ASSUME "workspace". Restoring a hardcoded default
 * would silently WIDEN a chat the owner had deliberately narrowed: they type
 * `/permissions read-only`, later type `/plan`, and Go ahead hands them a
 * writable workspace they never asked for. The remembered value lives in the
 * session settings file, so it also survives the daemon restarting mid plan.
 */
import type { SessionSettings } from "./session-settings.js";

export type ChatPermission = NonNullable<SessionSettings["permission"]>;

/** The sandbox plan mode holds a chat in. The one thing that refuses a write. */
export const PLAN_MODE_PERMISSION: ChatPermission = "read-only";

/** What a chat with no stored permission runs under (sessionSettings' default). */
export const DEFAULT_PERMISSION: ChatPermission = "workspace";

/**
 * The patch that turns plan mode ON for a chat.
 *
 * An already remembered permission is KEPT rather than overwritten: a second
 * `/plan` while plan mode is already on would otherwise remember `read-only`
 * as the owner's own choice and `/code` would never give the workspace back.
 */
export function planModeOn(current: SessionSettings): SessionSettings {
  return {
    mode: "plan",
    permission: PLAN_MODE_PERMISSION,
    permissionBeforePlan:
      current.permissionBeforePlan ?? current.permission ?? DEFAULT_PERMISSION,
  };
}

/**
 * The patch that turns plan mode OFF and gives the access back.
 *
 * Nothing remembered means nothing to restore, so the chat keeps the
 * permission it already has. That is the `/code` in a chat that was never in
 * plan mode, and it must not move anything.
 */
export function planModeOff(current: SessionSettings): SessionSettings {
  return {
    mode: "default",
    permission:
      current.permissionBeforePlan ?? current.permission ?? DEFAULT_PERMISSION,
    // Spent. `clean()` drops an undefined, which is how the field is cleared.
    permissionBeforePlan: undefined,
  };
}

/**
 * Is the plan wait actually ENFORCED for a chat in these settings?
 *
 * BOTH halves, and this is the whole point of the file. The mode alone is a
 * convention the runtime states in the model's instructions; the read only
 * sandbox alone is an owner's access choice with no wait behind it. Only the
 * pair means "this host genuinely cannot change a file before you answer",
 * which is the sentence the app puts in front of the owner off this bit.
 */
export function planWaitEnforced(settings: SessionSettings): boolean {
  return settings.mode === "plan" && settings.permission === PLAN_MODE_PERMISSION;
}
