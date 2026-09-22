import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The publish workflow fires on a push to main that touches package.json, and
 * nothing in the repo read it until this file did. It is the one step that
 * reaches other people's machines, so the thing worth pinning is not that it
 * runs, it is WHICH npm dist tag it runs under.
 *
 * Background: 0.10.1 offers APPROVAL_HOLD_SECONDS (1800 s) on every approval
 * and relies on the BGOS backend clamping that offer to the owner's per agent
 * choice. Published as `latest` ahead of that backend, every Codex approval
 * becomes a thirty minute card with no setting anywhere to shorten it. The
 * source says so itself, above APPROVAL_HOLD_SECONDS in src/interactions.ts.
 *
 * MUTATION PROOFS, run by hand against this tree:
 *  - dropping `--tag "${{ steps.ver.outputs.dist_tag }}"` back to a bare
 *    `npm publish --access public` turns case 1 red.
 *  - changing the default to `DIST_TAG=next` turns case 2 red.
 *  - emptying HELD_FROM_LATEST while the RELEASE ORDER sentence is still in
 *    src/interactions.ts turns case 3 red, and so does bumping package.json
 *    past a held version without revisiting the hold.
 *  - removing that sentence from src/interactions.ts retires case 3 on its
 *    own, which is the intent: the hold exists only while the reason does.
 */
describe("the publish workflow never advertises a held version as latest", () => {
  const workflow = readFileSync(".github/workflows/publish.yml", "utf8");

  /** The versions the workflow refuses to publish under `latest`. */
  function heldFromLatest(): string[] {
    const line = workflow.match(/^\s*HELD_FROM_LATEST="([^"]*)"/m);
    expect(line, "HELD_FROM_LATEST is gone from publish.yml").not.toBeNull();
    return (line?.[1] ?? "").split(/\s+/).filter(Boolean);
  }

  /** Comment markers and wrapping removed, so a rewrap cannot hide a claim. */
  function prose(file: string): string {
    return readFileSync(file, "utf8")
      .replace(/^\s*\*\s?/gm, " ")
      .replace(/\s+/g, " ");
  }

  it("passes an explicit dist tag to npm publish", () => {
    expect(workflow).toContain(
      'npm publish --access public --tag "${{ steps.ver.outputs.dist_tag }}"',
    );
    // A bare publish is the defect: npm then writes `latest` silently.
    expect(workflow).not.toMatch(/npm publish --access public\s*$/m);
  });

  it("defaults to latest, so a hold cannot outlive the release it was written for", () => {
    expect(workflow).toMatch(/^\s*DIST_TAG=latest$/m);
    expect(workflow).toMatch(/^\s*for held in \$HELD_FROM_LATEST; do$/m);
    expect(workflow).toMatch(/^\s*echo "dist_tag=\$DIST_TAG" >> "\$GITHUB_OUTPUT"$/m);
  });

  it("holds this version while its own source says the backend is not ready", () => {
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    const stillHeld = prose("src/interactions.ts").includes(
      "This plugin version must not be tagged or advertised as latest ahead of that backend and its migration.",
    );
    if (!stillHeld) return;
    expect(
      heldFromLatest(),
      `src/interactions.ts still forbids latest for this release, so ${version} belongs in HELD_FROM_LATEST`,
    ).toContain(version);
  });
});
