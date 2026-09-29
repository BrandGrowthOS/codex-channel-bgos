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

  /** Round 7: the one promote order for 0.14.0 that cannot leave latest on 0.13.0. */
  const ORDER = "only after 0.13.0 is on latest, never before or in the same step";
  const MOVES_BACK = /promoting an older version after 0\.14\.0 moves latest back/i;
  /**
   * Round 8, the last check's second gap. The live image turn also records
   * how big the picture's `result` is: a line over the transport's 16 MiB cap
   * (a picture over about 12 MiB) never posts, only its "could not be shown"
   * line does. So the checklist names the size and the cap, in every text a
   * release reads and in the printed warning.
   */
  const SIZE = "the result size (under 12 MiB, the line cap)";
  const LIVE_TURN =
    "only after one logged in live image turn confirms the real item (result bytes and their form, the result size (under 12 MiB, the line cap), revisedPrompt, savedPath, the failure shape; probe.md, decision 7)";

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
      // Round 7, the final review's low item. `npm dist-tag add` points latest
      // at whichever version ran LAST, so "with 0.13.0 or after it" let one
      // sitting run the 0.14.0 command and then the 0.13.0 one, leaving latest
      // on 0.13.0 while the BGOS merge gate reads "0.14.0 on latest". Both
      // places in each file say the order that cannot end that way, and one
      // line says what promoting an older version afterwards does.
      expect(
        text.split(ORDER).length - 1,
        `${name} does not say "${ORDER}" in both places`,
      ).toBeGreaterThanOrEqual(2);
      expect(text, `${name} still says "0.13.0 or after it"`).not.toMatch(
        /0\.13\.0 or after it/i,
      );
      expect(
        text,
        `${name} does not say that promoting an older version after 0.14.0 moves latest back`,
      ).toMatch(MOVES_BACK);
      expect(
        text,
        `${name} does not ask the live image turn for ${SIZE}`,
      ).toContain(SIZE);
      expect(
        text,
        `${name} does not hold 0.14.0 for the live image turn`,
      ).toContain(LIVE_TURN);
    }
  });

  /**
   * P5 stage 5 (C-27, Build C): 0.15.0 is the steer fallback. It needs no
   * backend of its own (a steer with nothing to steer runs as an ordinary
   * message, and a landed steer posts nothing), and it is held only because it
   * carries every hold before it, 0.14.0's included. So the one order that
   * cannot leave latest behind is the same rule 0.14.0 set, one step on:
   * promote it only after 0.14.0 is on latest, never before or in the same
   * step, and say what promoting an older version afterwards does. The HOAI
   * app steers only daemons at or past 0.15.0, so a host on latest keeps plain
   * sends until this is promoted; that is the floor working, not a gap.
   */
  const ORDER_15 = "only after 0.14.0 is on latest, never before or in the same step";
  const MOVES_BACK_15 = /promoting an older version after 0\.15\.0 moves latest back/i;

  it("holds 0.15.0 behind 0.14.0 in all three texts a release reads", () => {
    if (!heldInSource().includes("0.15.0")) return;
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
      expect(text, `${name} lost "0.15.0 adds no hold of its own"`).toMatch(
        /0\.15\.0[^.]*adds no hold of its own/i,
      );
      expect(
        text.split(ORDER_15).length - 1,
        `${name} does not say "${ORDER_15}" in both places`,
      ).toBeGreaterThanOrEqual(2);
      expect(
        text,
        `${name} does not say that promoting an older version after 0.15.0 moves latest back`,
      ).toMatch(MOVES_BACK_15);
    }
  });

  it("prints 0.15.0's own condition before the promote command when it lands on next", () => {
    if (!heldFromLatest().includes("0.15.0")) return;
    const printed = printedBy("Held from latest");
    const command = printed.findIndex((line) =>
      line.text.includes("npm dist-tag add codex-channel-bgos@"),
    );
    const own = printed.findIndex(
      (line) =>
        line.only === "0.15.0" &&
        line.text.startsWith("::warning::") &&
        line.text.includes(ORDER_15),
    );
    const back = printed.findIndex(
      (line) =>
        line.only === "0.15.0" &&
        line.text.startsWith("::warning::") &&
        MOVES_BACK_15.test(line.text),
    );
    expect(own, `the warning does not name 0.15.0's condition: ${ORDER_15}`).toBeGreaterThanOrEqual(0);
    expect(
      back,
      "the 0.15.0 warning does not say that promoting an older version after it moves latest back",
    ).toBeGreaterThanOrEqual(0);
    expect(own, "the promote command is printed before 0.15.0's condition").toBeLessThan(command);
    expect(back, "the promote command is printed before the line about moving latest back").toBeLessThan(command);
  });

  /**
   * What one step PRINTS, not its comments: every `echo "..."` line, with the
   * version its `if [ "$VERSION" = "<v>" ]; then ... fi` branch is for (null
   * outside a branch), in order. The printed text is the only thing a person
   * reading a publish run sees.
   */
  function printedBy(stepName: string): { text: string; only: string | null }[] {
    const lines = workflow.split(/\r?\n/);
    const start = lines.findIndex((line) =>
      new RegExp(`^\\s*- name: ${stepName}\\s*$`).test(line),
    );
    expect(start, `publish.yml lost its "${stepName}" step`).toBeGreaterThanOrEqual(0);
    const out: { text: string; only: string | null }[] = [];
    let only: string | null = null;
    for (const line of lines.slice(start + 1)) {
      if (/^\s*- name: /.test(line)) break;
      const branch = line.match(/^\s*if \[ "\$VERSION" = "([^"]+)" \]; then\s*$/);
      if (branch) {
        only = branch[1]!;
        continue;
      }
      if (/^\s*fi\s*$/.test(line)) {
        only = null;
        continue;
      }
      const echo = line.match(/^\s*echo "(.*)"\s*$/);
      if (echo) out.push({ text: echo[1]!, only });
    }
    return out;
  }

  it("never hands anyone a bare promote command when a held version lands on next", () => {
    // Round 5. The "Held from latest" step printed ONE version's reason (the
    // backend that clamps the approval hold, 0.10.1's) as every version's,
    // then the promote command. For 0.14.0, which needs no backend at all,
    // that reads as "promote now", with nothing about 0.13.0 or the live
    // image turn the release is waiting for. So the step must say to promote
    // only when THAT version's reason is met, point at where the reason is
    // written, name 0.14.0's own condition, and say all of it BEFORE the
    // command, in a ::warning:: annotation a run summary shows.
    const printed = printedBy("Held from latest");
    const command = printed.findIndex((line) =>
      line.text.includes("npm dist-tag add codex-channel-bgos@"),
    );
    const everyVersion = printed.filter((line) => line.only === null);
    const general = printed.findIndex(
      (line) =>
        line.only === null &&
        line.text.startsWith("::warning::") &&
        /\bonly when the reason it is held is met\b/i.test(line.text) &&
        line.text.includes("HELD_FROM_LATEST comment") &&
        /\bpromote block of the README\b/.test(line.text),
    );
    expect(
      general,
      "the warning does not say to promote only when this version's own reason, in the HELD_FROM_LATEST comment and the README promote block, is met",
    ).toBeGreaterThanOrEqual(0);
    if (command >= 0)
      expect(
        general,
        "the promote command is printed before the condition that gates it",
      ).toBeLessThan(command);
    // One version's reason printed for every version is the defect itself.
    for (const line of everyVersion)
      expect(
        line.text,
        "a line printed for every held version names one version's backend",
      ).not.toMatch(/approval hold|clamps/i);

    if (!heldFromLatest().includes("0.14.0")) return;
    const own = printed.findIndex(
      (line) =>
        line.only === "0.14.0" &&
        line.text.startsWith("::warning::") &&
        line.text.includes(ORDER) &&
        line.text.includes(LIVE_TURN),
    );
    expect(
      own,
      `the warning does not name 0.14.0's condition: ${ORDER}, and ${LIVE_TURN}`,
    ).toBeGreaterThanOrEqual(0);
    // Round 7: what a later promote of an older version does, said in the
    // run summary too, where the person holding the promote command reads.
    const back = printed.findIndex(
      (line) =>
        line.only === "0.14.0" &&
        line.text.startsWith("::warning::") &&
        MOVES_BACK.test(line.text),
    );
    expect(
      back,
      "the 0.14.0 warning does not say that promoting an older version after it moves latest back",
    ).toBeGreaterThanOrEqual(0);
    if (command >= 0) {
      expect(
        own,
        "the promote command is printed before 0.14.0's condition",
      ).toBeLessThan(command);
      expect(
        back,
        "the promote command is printed before the line about moving latest back",
      ).toBeLessThan(command);
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
