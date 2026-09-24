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
 * The hold is keyed on a MARKER, not on prose. It used to key on one sentence
 * of the RELEASE ORDER comment, so rewording that sentence, which is exactly
 * what someone revisiting a release hold does, retired the guard silently while
 * the hazard was still live. `HELD-FROM-LATEST: <version>` is a line you cannot
 * edit by accident, and the two lists have to agree.
 *
 * MUTATION PROOFS, run by hand against this tree:
 *  - dropping `--tag "${{ steps.ver.outputs.dist_tag }}"` back to a bare
 *    `npm publish --access public` turns case 1 red.
 *  - changing the default to `DIST_TAG=next` turns case 2 red.
 *  - emptying HELD_FROM_LATEST while the HELD-FROM-LATEST marker is still in
 *    src/interactions.ts turns case 3 red, and so does bumping package.json
 *    past a held version without revisiting the hold.
 *  - REWORDING the RELEASE ORDER prose around the marker leaves case 3 green
 *    and still asserting, which is the point of this shape.
 *  - removing the marker line from src/interactions.ts retires case 3 on its
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

  /** The versions the SOURCE says are held, off its own machine readable line.
   *  A prose edit cannot move this; deleting the line is the deliberate act
   *  that retires the hold. */
  function heldInSource(): string[] {
    return [
      ...readFileSync("src/interactions.ts", "utf8").matchAll(
        /^\s*\*?\s*HELD-FROM-LATEST:\s*(\S+)\s*$/gm,
      ),
    ].map((match) => match[1]);
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

  it("names EVERY held version in the README a human releasing will open", () => {
    // The drift this catches: the hold went from one version to two, the two
    // machine readable lists both moved, and the prose kept saying "0.10.1
    // only" with a single promote line. Nothing was red, because nothing read
    // the one copy a person actually follows at release time. So the README is
    // held to the same list as the other two.
    const held = heldInSource();
    if (held.length === 0) return;
    const readme = readFileSync("README.md", "utf8");
    for (const version of held) {
      expect(
        readme,
        `README.md does not name held version ${version}`,
      ).toContain(version);
      expect(
        readme,
        `README.md has no promote line for held version ${version}`,
      ).toContain(`npm dist-tag add codex-channel-bgos@${version} latest`);
    }
  });

  it("holds 0.14.0 for the live image turn in all three texts a release reads", () => {
    // Re-review item 1. 0.14.0 needs no backend, so nothing machine readable
    // can hold it past 0.13.0; what it waits for is one logged in live image
    // turn confirming the real item, which the offline probe could not see.
    // Promoted without it, a result shape the code does not read turns every
    // picture into a "could not be shown" line, while the served canon has
    // told the model not to resend it. So the condition is written wherever
    // someone promoting reads, beside "adds no hold of its own".
    if (!heldInSource().includes("0.14.0")) return;
    const flat = (text: string) =>
      text
        .split("\n")
        .map((line) => line.replace(/^\s*(?:#|\*)?\s?/, ""))
        .join(" ")
        .replace(/\s+/g, " ");
    const texts: Record<string, string> = {
      "publish.yml": flat(workflow),
      "src/interactions.ts": flat(readFileSync("src/interactions.ts", "utf8")),
      "README.md": flat(readFileSync("README.md", "utf8")),
    };
    for (const [name, text] of Object.entries(texts)) {
      expect(text, `${name} lost "adds no hold of its own"`).toMatch(
        /0\.14\.0[^.]*adds no hold of its own/i,
      );
      expect(
        text,
        `${name} does not hold 0.14.0 for the live image turn`,
      ).toContain(
        "only after one logged in live image turn confirms the real item (result bytes and their form, revisedPrompt, savedPath, the failure shape; probe.md, decision 7)",
      );
    }
  });

  it("keeps package-lock.json on the same version package.json is on", () => {
    // The stage bumped package.json to 0.11.0 and left the lock at 0.10.1, in
    // BOTH of its version fields. Every previous release in this repo moved the
    // two together, so this is a broken invariant rather than a repo that never
    // tracked one, and it is not cosmetic: `npm ci` is what both CI workflows
    // run, and the published tarball carries a lock naming the previous
    // release. Nothing read the lock until this case did.
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    expect(lock.version, "package-lock.json root version").toBe(version);
    expect(
      lock.packages?.[""]?.version,
      'package-lock.json packages[""].version',
    ).toBe(version);
    expect(lock.name).toBe(JSON.parse(readFileSync("package.json", "utf8")).name);
  });

  it("holds this version while its own source says the backend is not ready", () => {
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    const held = heldInSource();
    // No marker: the hold was retired on purpose, in the one place that says
    // so, and this case retires with it.
    if (held.length === 0) return;
    expect(
      heldFromLatest().slice().sort(),
      "the workflow's HELD_FROM_LATEST and the HELD-FROM-LATEST markers in src/interactions.ts disagree; they are one hold written twice",
    ).toEqual(held.slice().sort());
    expect(
      held,
      `src/interactions.ts still forbids latest, so ${version} belongs in HELD-FROM-LATEST and in HELD_FROM_LATEST`,
    ).toContain(version);
  });
});
