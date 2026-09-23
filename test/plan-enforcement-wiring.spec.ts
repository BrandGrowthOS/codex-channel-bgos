/**
 * The lock moving without the mode moving is REPORTED, not merely handled.
 *
 * `NativeCommands` calls `onPlanEnforcement` when `/permissions` changes the
 * sandbox of a chat that is still in plan mode, and `native-commands.spec.ts`
 * proves that it does. Neither of those proves the ADAPTER ever passes the
 * callback: it is optional, so dropping it from the deps literal compiles, and
 * every one of those cases stays green while the app goes on telling the owner
 * the chat is read only after they opened it back up. That is the defect this
 * whole stage keeps rediscovering in a new place (a prop passed at one of the
 * two mount points, a handler reading the wrong field), so the wire gets a
 * guard of its own.
 *
 * STRUCTURAL, NOT A GREP. It brace matches the `new NativeCommands({ ... })`
 * literal and asserts the keys are IN IT, so the word appearing in a comment
 * somewhere else in the file cannot keep it green.
 *
 * MUTATION PROOF, run against this tree: deleting the `onPlanEnforcement:`
 * entry from that literal in `src/adapter.ts` turns this case red; restoring
 * it turns it green and leaves the file's sha256 unchanged.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const ADAPTER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "adapter.ts",
);

/** The object literal `new NativeCommands({` opens, brace matched. */
function nativeCommandsDeps(source: string): string {
  const at = source.indexOf("new NativeCommands({");
  expect(at).toBeGreaterThan(-1);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("The NativeCommands deps literal is not brace balanced.");
}

describe("what the adapter hands the native command router", () => {
  const deps = nativeCommandsDeps(readFileSync(ADAPTER, "utf8"));

  it("passes the session mode report, so /plan and /code reach the app", () => {
    expect(deps).toMatch(/\bonSessionMode:/);
  });

  it("passes the enforcement report, so /permissions reaches it too", () => {
    // The one path where the sandbox moves and the mode does not. Without it
    // the plan chip keeps promising a read only chat that is not read only,
    // which is the single sentence this lane exists to make true.
    expect(deps).toMatch(/\bonPlanEnforcement:/);
  });

  it("keeps them apart, because the typed door must survive a /permissions", () => {
    // Routing the enforcement through onSessionMode would take its
    // `typedTask: false` arm and delete the door a `/plan <task>` left behind,
    // so the card would claim plan mode happened to be on.
    expect(deps).not.toMatch(/onPlanEnforcement:\s*this\.deps/);
    const enforcement = deps.slice(deps.indexOf("onPlanEnforcement:"));
    expect(enforcement).not.toMatch(/planDoorHint/);
  });
});
