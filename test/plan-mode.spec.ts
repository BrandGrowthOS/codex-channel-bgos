/**
 * The pair plan mode moves, and which half of it refuses a write.
 *
 * The live probe of 2026-09-23 wrote a file inside `collaborationMode: plan`
 * with no approval raised, so the mode is a convention. The read only sandbox
 * is not, so `/plan` sets both and `/code` puts the chat back. These are the
 * pure transitions; `session-settings.spec.ts` drives them through the real
 * host and the file on disk.
 *
 * MUTATION PROOF, run against this tree: changing `planModeOn` to return
 * `{ mode: "plan" }` alone (the shape before this lane) turns the first two
 * cases red; restoring it turns them green and leaves the file's sha256
 * unchanged.
 */
import { describe, expect, it } from "vitest";
import {
  planModeOff,
  planModeOn,
  planWaitEnforced,
} from "../src/plan-mode.js";

describe("turning plan mode on", () => {
  it("takes the chat read only and remembers what it took", () => {
    expect(planModeOn({ permission: "workspace" })).toEqual({
      mode: "plan",
      permission: "read-only",
      permissionBeforePlan: "workspace",
    });
  });

  it("remembers the DEFAULT for a chat that never chose one", () => {
    // `sessionSettings()` hands a fresh chat `permission: "workspace"`, so a
    // chat with nothing stored is a workspace chat and must be given one back.
    expect(planModeOn({}).permissionBeforePlan).toBe("workspace");
  });

  it("does not overwrite the memory on a second /plan", () => {
    // Otherwise `/plan` twice remembers `read-only` as the owner's own choice
    // and `/code` never gives the workspace back.
    const once = planModeOn({ permission: "workspace" });
    expect(planModeOn(once).permissionBeforePlan).toBe("workspace");
  });

  it("keeps a read only chat read only, and says so", () => {
    const on = planModeOn({ permission: "read-only" });
    expect(on.permission).toBe("read-only");
    expect(on.permissionBeforePlan).toBe("read-only");
    expect(planModeOff(on).permission).toBe("read-only");
  });
});

describe("turning plan mode off", () => {
  it("gives back exactly what was taken, and spends the memory", () => {
    const off = planModeOff(planModeOn({ permission: "workspace" }));
    expect(off.mode).toBe("default");
    expect(off.permission).toBe("workspace");
    // Undefined is how the whitelist clears it: `clean()` drops it on write.
    expect(off.permissionBeforePlan).toBeUndefined();
  });

  it("moves nothing in a chat that was never planning", () => {
    // `/code` in an ordinary chat is a no-op on access. A hardcoded
    // "workspace" restore here would silently widen a chat the owner had
    // narrowed by hand.
    expect(planModeOff({ permission: "read-only" }).permission).toBe("read-only");
  });
});

describe("whether the wait is actually enforced", () => {
  it("needs BOTH halves, which is the whole point", () => {
    expect(planWaitEnforced({ mode: "plan", permission: "read-only" })).toBe(true);
    // The mode alone: a strict instruction the probe wrote a file straight
    // through.
    expect(planWaitEnforced({ mode: "plan", permission: "workspace" })).toBe(false);
    // The sandbox alone: an access choice with no plan waiting behind it.
    expect(planWaitEnforced({ mode: "default", permission: "read-only" })).toBe(
      false,
    );
    expect(planWaitEnforced({})).toBe(false);
  });
});
