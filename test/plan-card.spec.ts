import { describe, expect, it } from "vitest";
import {
  CODEX_PLAN_MODE_ENFORCED,
  PLAN_CHIP_CHANGE,
  PLAN_CHIP_GO,
  PLAN_CHIP_NO,
  buildPlanCardMessage,
  parsePlanChip,
  parseProposedPlan,
  planCardFromMarkdown,
  planCardOptions,
  planCardPayload,
  planFromMarkdown,
  planPolicySentence,
  supersedePlanCardPatch,
} from "../src/plan-card.js";

/**
 * The plan card's shapes.
 *
 * Every fact here about what Codex actually emits was settled by a live probe
 * on 2026-09-23 against the vendored app server at 0.154.0
 * (docs/learnings/codex-plan-mode-wire.md). The plan arrives as an
 * `item/completed` of `item.type === "plan"` carrying the whole plan markdown,
 * and the runtime STRIPS the `<proposed_plan>` block out of the agent message,
 * which is why the block parser below is a fallback and not the main path.
 *
 * MUTATION PROOF, run against this tree: changing `PLAN_CHIP_GO` in
 * src/plan-card.ts to "plan:goo" turns the chip cases red; restoring it turns
 * them green and leaves the file's sha256 unchanged.
 */
describe("the plan card payload", () => {
  const base = {
    title: "Add retry with backoff to the uploader",
    steps: [{ text: "Read the uploader" }, { text: "Add the helper" }],
    door: "mode" as const,
    enforced: false,
    planId: "plan-1",
    revision: 1,
  };

  it("is a versioned plan_card with the caps applied", () => {
    const payload = planCardPayload({
      ...base,
      title: "T".repeat(200),
      summary: "S".repeat(700),
      check: "C".repeat(400),
      note: "N".repeat(400),
      steps: Array.from({ length: 40 }, (_, at) => ({
        text: `step ${at} ${"x".repeat(300)}`,
      })),
      files: Array.from({ length: 40 }, (_, at) => `src/file-${at}.ts`),
    });
    expect(payload.kind).toBe("plan_card");
    expect(payload.v).toBe(1);
    expect(payload.title).toHaveLength(120);
    expect(payload.summary).toHaveLength(500);
    expect(payload.check).toHaveLength(300);
    expect(payload.note).toHaveLength(300);
    expect(payload.steps).toHaveLength(30);
    expect(payload.steps[0]!.text).toHaveLength(200);
    expect(payload.files).toHaveLength(30);
  });

  it("clips a STEP's check at 200, which is not the card's 300", () => {
    // The two caps are different in the served schema
    // (backend/src/renderables/renderables-manifest.ts: steps.items.check is
    // maxLength 200, the card's own check is 300) and this builder used one
    // number for both, so a long per step check shipped a payload the served
    // schema calls invalid. Nothing on screen showed it, which is why it needs
    // a test rather than a look.
    const payload = planCardPayload({
      ...base,
      check: "C".repeat(400),
      steps: [{ text: "Rewrite it", check: "V".repeat(400) }],
    });
    expect(payload.steps[0]!.check).toHaveLength(200);
    expect(payload.check).toHaveLength(300);
  });

  it("refuses a plan with no title and one with no usable step", () => {
    expect(() => planCardPayload({ ...base, title: "   " })).toThrow(/title/i);
    expect(() =>
      planCardPayload({ ...base, steps: [{ text: "  " }] }),
    ).toThrow(/step/i);
  });

  it("keeps a step's file, check and revision tag, and dedupes the file list", () => {
    const payload = planCardPayload({
      ...base,
      steps: [
        { text: "Rewrite it", file: "src/a.ts", check: "tests pass", tag: "changed" },
        { text: "Leave it", tag: "unchanged" },
      ],
      files: ["src/a.ts", "src/a.ts", "src/b.ts"],
      supersedes: 42,
      state: "proposed",
    });
    expect(payload.steps[0]).toEqual({
      text: "Rewrite it",
      file: "src/a.ts",
      check: "tests pass",
      tag: "changed",
    });
    expect(payload.steps[1]!.tag).toBe("unchanged");
    expect(payload.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(payload.supersedes).toBe(42);
    expect(payload.state).toBe("proposed");
  });

  it("sends the three chip CODES with their tiers, and never the app's words as the contract", () => {
    expect(planCardOptions()).toEqual([
      { text: "Go ahead", callbackData: PLAN_CHIP_GO, style: "success" },
      {
        text: "Change the plan",
        callbackData: PLAN_CHIP_CHANGE,
        style: "default",
      },
      { text: "Don't do this", callbackData: PLAN_CHIP_NO, style: "danger" },
    ]);
    expect(PLAN_CHIP_GO).toBe("plan:go");
    expect(PLAN_CHIP_CHANGE).toBe("plan:change");
    expect(PLAN_CHIP_NO).toBe("plan:no");
  });

  it("reads a chip code back, and refuses anything that is not one", () => {
    expect(parsePlanChip("plan:go")).toBe("go");
    expect(parsePlanChip("plan:change")).toBe("change");
    expect(parsePlanChip("plan:no")).toBe("no");
    expect(parsePlanChip("ea:once:abc")).toBeNull();
    expect(parsePlanChip("plan:goodbye")).toBeNull();
    expect(parsePlanChip("__custom__")).toBeNull();
    expect(parsePlanChip(undefined)).toBeNull();
  });

  it("posts as an event with the renderable kind, inline chips and a readable fallback body", () => {
    const payload = planCardPayload({
      ...base,
      summary: "The uploader retries nothing today.",
      steps: [{ text: "Add a helper", file: "src/upload.ts" }],
      check: "The new test fails without the helper.",
    });
    const body = buildPlanCardMessage(payload, { assistantId: 7, chatId: 9 });
    expect(body.messageType).toBe("event");
    expect(body.renderMode).toBe("inline");
    expect(body.eventMeta?.payload.kind).toBe("plan_card");
    expect(body.eventMeta?.title).toBe("Plan");
    expect(body.options).toHaveLength(3);
    // The text is what a client that does not know the kind shows, so the
    // whole plan has to be in it.
    expect(body.text).toContain("Add retry with backoff to the uploader");
    expect(body.text).toContain("1. Add a helper");
    expect(body.text).toContain("src/upload.ts");
    expect(body.text).toContain("Nothing changes until you answer.");
  });

  it("titles a revision as a revision", () => {
    const payload = planCardPayload({ ...base, revision: 2 });
    expect(
      buildPlanCardMessage(payload, { assistantId: 1, chatId: 1 }).eventMeta
        ?.title,
    ).toBe("Plan · revised");
  });

  it("supersedes an older card by emptying its chips and dimming its payload", () => {
    const payload = planCardPayload(base);
    const patch = supersedePlanCardPatch(payload);
    expect(patch.options).toEqual([]);
    expect(patch.eventMeta?.payload.state).toBe("superseded");
    // The steps stay: the owner keeps what they already read.
    expect((patch.eventMeta?.payload as { steps: unknown[] }).steps).toHaveLength(2);
  });

  it("says plan mode is not enforced on this channel", () => {
    // A live probe wrote a workspace file with collaborationMode plan set and
    // raised no approval. If this ever flips to true, the probe has to say so
    // first.
    expect(CODEX_PLAN_MODE_ENFORCED).toBe(false);
  });
});

describe("reading the runtime's plan", () => {
  // The real shape, as the runtime's own plan mode instructions ask for it.
  const PLAN = [
    "## Add retry with backoff to the uploader",
    "",
    "### Summary",
    "The uploader retries nothing today.",
    "",
    "### Key changes",
    "1. Read every network call in `src/upload.ts`",
    "2. Add a backoff helper with three attempts",
    "3. Wrap the call and add a unit test in `test/upload.spec.ts`",
    "",
    "### Test plan",
    "The new unit test fails without the helper.",
  ].join("\n");

  it("takes the title, the summary, the numbered steps, the files and the check", () => {
    const read = planFromMarkdown(PLAN);
    expect(read.title).toBe("Add retry with backoff to the uploader");
    expect(read.summary).toBe("The uploader retries nothing today.");
    expect(read.steps).toHaveLength(3);
    expect(read.steps[0]!.file).toBe("src/upload.ts");
    expect(read.steps[0]!.text).toBe("Read every network call in");
    expect(read.steps[1]!.text).toBe("Add a backoff helper with three attempts");
    expect(read.files).toEqual(["src/upload.ts", "test/upload.spec.ts"]);
    expect(read.check).toBe("The new unit test fails without the helper.");
  });

  it("falls back to bullets, then to a paragraph, and never loses the text", () => {
    const bullets = planFromMarkdown("# Tidy up\n\n- Delete the dead file\n- Fix the import");
    expect(bullets.steps.map((s) => s.text)).toEqual([
      "Delete the dead file",
      "Fix the import",
    ]);
    const prose = planFromMarkdown("# One thing\n\nJust rename the module.");
    expect(prose.steps).toEqual([{ text: "Just rename the module." }]);
  });

  it("keeps a step that IS a path rather than emptying the row", () => {
    const read = planFromMarkdown("# Files\n\n1. `src/a.ts`");
    expect(read.steps[0]!.text).toBe("`src/a.ts`");
    expect(read.steps[0]!.file).toBe("src/a.ts");
  });

  it("hands planCardPayload a card input with no identity of its own", () => {
    const input = planCardFromMarkdown(PLAN, { door: "typed", enforced: false });
    expect(input).not.toHaveProperty("planId");
    expect(input).not.toHaveProperty("revision");
    expect(input.door).toBe("typed");
    const payload = planCardPayload({ ...input, planId: "p", revision: 1 });
    expect(payload.steps).toHaveLength(3);
  });
});

describe("the <proposed_plan> fallback", () => {
  it("takes the block out and leaves the sentence around it", () => {
    const parsed = parseProposedPlan(
      "I explored it.\n\n<proposed_plan>\n## Do the thing\n\n1. Step one\n</proposed_plan>\n\nTell me.",
    );
    expect(parsed?.plan).toBe("## Do the thing\n\n1. Step one");
    expect(parsed?.rest).toBe("I explored it.\n\nTell me.");
  });

  it("stays out of the way when there is no block, which is the normal case", () => {
    // The 0.154.0 runtime strips the block itself, so the ordinary plan mode
    // message has none. A fallback that fired here would turn every question
    // the agent asks in phase 2 into a plan card.
    expect(parseProposedPlan("Which database is this?")).toBeNull();
    expect(parseProposedPlan("<proposed_plan>\nunclosed")).toBeNull();
    expect(parseProposedPlan("<proposed_plan>\n \n</proposed_plan>")).toBeNull();
    expect(parseProposedPlan(null)).toBeNull();
  });
});

describe("the owner's plan level on the turn framing", () => {
  /**
   * WHAT THE WIRE ACTUALLY CARRIES, copied from the backend that sends it
   * (backend/src/services/plan-policy.ts: PLAN_POLICY_PREFIX plus the level's
   * own sentence). It is NOT the bare enum, and the key is absent entirely at
   * the default level, so these two strings and `undefined` are the only
   * three things a real envelope can hand this function.
   */
  const WIRE_RISKY =
    "Your owner's setting for when you show a plan before you change anything. " +
    "It applies in every chat and on every channel. Typing /plan always shows a " +
    "plan whatever this says, and this is a request about how you work rather " +
    "than something the platform can enforce: decide on your own to show a plan " +
    "first when a job touches several files or would be hard to undo, and " +
    "otherwise get on with the work.";

  it("passes the server's own labelled sentence through to the model", () => {
    // THE REGRESSION THIS PINS: the function switched on `risky_jobs` and
    // answered `undefined` for everything else, so the sentence above, which
    // is the only thing the wire sends, reached no turn at all.
    const line = planPolicySentence(WIRE_RISKY);
    expect(line).toContain("decide on your own to show a plan first");
    expect(line).toContain("propose_plan");
  });

  it("still says something the model can act on for a bare level", () => {
    expect(planPolicySentence("only_when_asked")).toMatch(/only when the owner asks/i);
    expect(planPolicySentence("risky_jobs")).toMatch(/propose_plan/);
    expect(planPolicySentence("always")).toMatch(/before you change a single file/i);
  });

  it("omits a level it was not given, rather than inventing one", () => {
    expect(planPolicySentence(undefined)).toBeUndefined();
    expect(planPolicySentence("")).toBeUndefined();
    expect(planPolicySentence("   ")).toBeUndefined();
  });
});
