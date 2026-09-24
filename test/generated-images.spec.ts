import { describe, expect, it } from "vitest";

import {
  IMAGE_BYTES_MAX,
  IMAGE_CAPTION_PROMPT_MAX,
  collectGeneratedImage,
  decodeImageResult,
  imageCaption,
  imageFailureLine,
  imageNotShownLine,
} from "../src/generated-images.js";
import { GOLD_PNG, imageItem } from "./fixtures/image-generation.js";

/**
 * Stage 4 (C-21): the pure half of a picture Codex made. Decoding happens at
 * COLLECTION time, so a turn holds a Buffer and never the base64 string (a
 * 1.9 MB PNG is about 2.6 MB of base64, held until the turn ends otherwise).
 */
describe("decodeImageResult", () => {
  it("decodes bare base64 and names the picture from its own bytes", () => {
    const decoded = decodeImageResult(GOLD_PNG.toString("base64"));
    expect(decoded?.bytes.equals(GOLD_PNG)).toBe(true);
    expect(decoded?.mimeType).toBe("image/png");
  });

  it("accepts a data: URI too, because the probe could not say which one arrives", () => {
    const decoded = decodeImageResult(
      `data:image/png;base64,${GOLD_PNG.toString("base64")}`,
    );
    expect(decoded?.bytes.equals(GOLD_PNG)).toBe(true);
    expect(decoded?.mimeType).toBe("image/png");
  });

  it("trusts the bytes over a data: URI's label", () => {
    const decoded = decodeImageResult(
      `data:image/jpeg;base64,${GOLD_PNG.toString("base64")}`,
    );
    expect(decoded?.mimeType).toBe("image/png");
  });

  it("refuses a real picture over the 10 MB image cap", () => {
    expect(IMAGE_BYTES_MAX).toBe(10 * 1024 * 1024);
    // A PNG header in front, so only the cap can refuse it: without the cap
    // this decodes and sniffs as a perfectly good picture.
    const tooBig = Buffer.concat([GOLD_PNG, Buffer.alloc(IMAGE_BYTES_MAX)]);
    expect(decodeImageResult(tooBig.toString("base64"))).toBeNull();
    const fits = Buffer.concat([GOLD_PNG, Buffer.alloc(1024)]);
    expect(decodeImageResult(fits.toString("base64"))?.bytes.length).toBe(
      fits.length,
    );
  });

  it.each([
    ["an empty string", ""],
    ["no string at all", undefined],
    ["bytes that are not a picture", Buffer.from("hello there").toString("base64")],
    // Its payload IS valid base64 of a real PNG, so only the ;base64 check
    // refuses it: a data: URI without it is percent encoded text.
    ["a data: URI that is not base64", `data:image/png,${GOLD_PNG.toString("base64")}`],
  ])("returns null for %s", (_label, raw) => {
    expect(decodeImageResult(raw)).toBeNull();
  });
});

describe("collectGeneratedImage", () => {
  it("keeps the bytes, the prompt and the saved path, and drops the base64", () => {
    const image = collectGeneratedImage(imageItem())!;
    expect(image.itemId).toBe("ig_01a0d1ba2874");
    expect(image.bytes?.equals(GOLD_PNG)).toBe(true);
    expect(image.mimeType).toBe("image/png");
    expect(image.fileName).toMatch(/^codex-image-[A-Za-z0-9_]+\.png$/);
    expect(image.revisedPrompt).toBe(
      "A plain gold circle centred on a dark charcoal background",
    );
    expect(image.savedPath).toMatch(/generated_images/);
    expect(image).not.toHaveProperty("result");
    expect(JSON.stringify(Object.keys(image))).not.toContain("result");
  });

  /**
   * Round 6 (premium item 2). The owner reads this name in four places: the
   * viewer strip, the chat's "View all photos" card, the Artifacts card and
   * the saved file on the download button. The last 24 of the id made it 40
   * characters, cut in the middle on a phone. The last 8 keep it whole, and
   * nothing keys on the name: the app keys on the row id, the upload is keyed
   * server side, and the MEDIA: dedupe is by real path and sha256.
   */
  it.each([
    ["an ig_ id", "ig_01a0d1ba2874", "codex-image-d1ba2874.png"],
    ["a code mode exec- id", "exec-8c1f3a52-5b7e-4d19-9a60-2e4b7c0d9f13", "codex-image-7c0d9f13.png"],
    ["an id shorter than 8", "ig_1", "codex-image-ig_1.png"],
    ["an id with nothing a file name can carry", "---", "codex-image-1.png"],
  ])("names the file codex-image and the last 8 of %s", (_label, id, name) => {
    const image = collectGeneratedImage(imageItem({ id }))!;
    expect(image.fileName).toBe(name);
    expect(image.fileName!.length).toBeLessThanOrEqual(24);
  });

  it("carries a refused picture with its failure and no bytes", () => {
    const image = collectGeneratedImage(
      imageItem({
        result: "",
        failure: {
          type: "usageLimitExceeded",
          limitId: "image_generation",
          resetsAt: 1790240000,
        },
      }),
    )!;
    expect(image.failure).toEqual({
      type: "usageLimitExceeded",
      limitId: "image_generation",
      resetsAt: 1790240000,
    });
    expect(image.bytes).toBeUndefined();
  });

  it("keeps a picture whose save failed, because the bytes are what posts", () => {
    const image = collectGeneratedImage(imageItem({ savedPath: null }))!;
    expect(image.bytes?.equals(GOLD_PNG)).toBe(true);
    expect(image.savedPath).toBeUndefined();
  });

  it("does not assume an ig_ style id: a code mode exec- id collects the same", () => {
    const image = collectGeneratedImage(
      imageItem({ id: "exec-01a0d1ba-2874-7e50-8e8d-e67f1b3b4fd6" }),
    )!;
    expect(image.itemId).toBe("exec-01a0d1ba-2874-7e50-8e8d-e67f1b3b4fd6");
    expect(image.bytes?.equals(GOLD_PNG)).toBe(true);
  });

  it("collects nothing from an item with no id, because it cannot be deduped", () => {
    expect(collectGeneratedImage(imageItem({ id: undefined }))).toBeNull();
  });

  /**
   * Round 5. A `result` that came back but will not decode (not a picture, or
   * over the image cap) is still the runtime handing something over: Codex
   * MADE it, this daemon just cannot draw it. Dropping that fact with the
   * base64 turned those into "Codex tried to make a picture", which is false.
   * So the collected image records that something came back, and never the
   * string itself.
   */
  it("records that the runtime returned something, when the result is not a picture", () => {
    const image = collectGeneratedImage(
      imageItem({
        result: Buffer.from("hello there").toString("base64"),
        savedPath: null,
      }),
    )!;
    expect(image.bytes).toBeUndefined();
    expect(image.savedPath).toBeUndefined();
    expect(image.returnedOutput).toBe(true);
    expect(JSON.stringify(Object.keys(image))).not.toContain("result");
  });

  it("records that the runtime returned something, when the picture is over the cap", () => {
    const tooBig = Buffer.concat([GOLD_PNG, Buffer.alloc(IMAGE_BYTES_MAX)]);
    const image = collectGeneratedImage(
      imageItem({ result: tooBig.toString("base64"), savedPath: null }),
    )!;
    expect(image.bytes).toBeUndefined();
    expect(image.returnedOutput).toBe(true);
  });

  it("records it for a picture that decoded too", () => {
    expect(collectGeneratedImage(imageItem())!.returnedOutput).toBe(true);
  });

  it.each([
    ["an empty result", ""],
    ["a result of only spaces", "  \n "],
    ["no result at all", undefined],
    ["a result that is not a string", 42],
  ])("records nothing returned for %s", (_label, result) => {
    const image = collectGeneratedImage(imageItem({ result, savedPath: null }))!;
    expect(image.bytes).toBeUndefined();
    expect(image.returnedOutput).toBeUndefined();
  });
});

describe("imageCaption", () => {
  it("says Prompt: and the revised prompt", () => {
    expect(imageCaption("A plain gold circle")).toBe(
      "Prompt: A plain gold circle",
    );
  });

  it("has no caption without a revised prompt", () => {
    expect(imageCaption(undefined)).toBeUndefined();
    expect(imageCaption(null)).toBeUndefined();
    expect(imageCaption("   ")).toBeUndefined();
  });

  /**
   * Round 6 (premium item 5). A range dash read as a comma changes what the
   * prompt says: "2024, 2026" is two years, "3, 4 people" is a list. An en
   * dash with a digit on both sides and no space is a range, so it reads
   * "to", and that happens before every other dash becomes a comma.
   */
  it("reads an en dash between two digits as a range, to", () => {
    expect(
      imageCaption("Sales for 2024\u20132026, a table for 3\u20134 people, pages 1\u20132\u20133"),
    ).toBe("Prompt: Sales for 2024 to 2026, a table for 3 to 4 people, pages 1 to 2 to 3");
  });

  it("still makes a comma of a range next to an em dash elsewhere in the prompt", () => {
    const caption = imageCaption("A bar chart of 2024\u20132026 \u2014 bold colours")!;
    expect(caption).toBe("Prompt: A bar chart of 2024 to 2026, bold colours");
    expect(caption).not.toMatch(/[\u2013\u2014]/);
  });

  it("keeps a spaced en dash between numbers a pause, a comma, never a range", () => {
    // A spaced en dash is the parenthetical dash; a range is written closed.
    expect(imageCaption("A poster for 2026 \u2013 3 colours only")).toBe(
      "Prompt: A poster for 2026, 3 colours only",
    );
  });

  it("turns every other em and en dash in the model's prompt into a comma", () => {
    const caption = imageCaption(
      "A gold circle \u2014 centred \u2013 on dark slate\u2014softly lit",
    )!;
    expect(caption).toBe("Prompt: A gold circle, centred, on dark slate, softly lit");
    expect(caption).not.toMatch(/[\u2013\u2014]/);
  });

  it("never leaves a comma dangling where a dash opened or closed the prompt", () => {
    expect(imageCaption("\u2014 a gold circle \u2014")).toBe(
      "Prompt: a gold circle",
    );
  });

  it("clips a long prompt on a word boundary and marks the cut", () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const caption = imageCaption(words)!;
    const body = caption.slice("Prompt: ".length);
    expect(body.length).toBeLessThanOrEqual(IMAGE_CAPTION_PROMPT_MAX);
    expect(body.endsWith("\u2026")).toBe(true);
    // The cut lands between two words, never inside one.
    const kept = body.slice(0, -1).split(" ");
    expect(words.split(" ").slice(0, kept.length)).toEqual(kept);
  });

  /**
   * Round 6 (premium item 6). 280 was about nine lines at body weight on a
   * phone under every picture; 200 keeps the one or two sentences an image
   * model writes back, in two or three lines, so the caption never outweighs
   * the picture.
   */
  it("caps the prompt at 200, so a 240 character prompt is clipped", () => {
    expect(IMAGE_CAPTION_PROMPT_MAX).toBe(200);
    const words = Array.from({ length: 40 }, (_, i) => `w${String(i).padStart(4, "0")}`).join(" ");
    expect(words.length).toBe(239);
    const body = imageCaption(words)!.slice("Prompt: ".length);
    expect(body.endsWith("…")).toBe(true);
    expect(body.length).toBeLessThanOrEqual(200);
    expect(body.length).toBeGreaterThan(180);
  });

  it("folds the prompt onto one line", () => {
    expect(imageCaption("gold\n\ncircle\ton  slate")).toBe(
      "Prompt: gold circle on slate",
    );
  });
});

/**
 * Round 6 (premium item 1). The reset is said RELATIVE to the moment the line
 * posts, never as a clock time: the plugin cannot know the viewer's zone, and
 * the daemon's clock zone is the host's, so "08:53 UTC" made a Dubai owner do
 * arithmetic in a line they never asked for. The bubble's own timestamp
 * anchors "in about 2 hours", as it does any "in 10 minutes" in a chat.
 * `/usage` keeps its UTC readout: the owner typed a command for that one.
 */
describe("imageFailureLine", () => {
  const RESET = 1790240000; // 2026-09-24 08:53:20 UTC, in seconds
  const MIN = 60;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const USED_UP = "Codex has used up its picture limit for now.";
  /** The line with the clock `secondsLeft` before the reset. */
  const lineAt = (secondsLeft: number, resetsAt: number = RESET): string =>
    imageFailureLine(
      { type: "usageLimitExceeded", limitId: "image_generation", resetsAt },
      { now: (RESET - secondsLeft) * 1000 },
    );

  it("says the limit is used up for now and when it resets, relative to now", () => {
    expect(lineAt(2 * HOUR)).toBe(
      "Codex has used up its picture limit for now. It resets in about 2 hours.",
    );
  });

  it.each([
    ["one second", "in a moment", 1],
    ["59 seconds", "in a moment", 59],
    ["one minute", "in about 1 minute", MIN],
    ["twelve minutes", "in about 12 minutes", 12 * MIN],
    ["59 minutes 40 seconds (never 60 minutes)", "in about 1 hour", 59 * MIN + 40],
    ["an hour and a quarter", "in about 1 hour", 75 * MIN],
    ["47 hours", "in about 47 hours", 47 * HOUR],
    ["47 hours 40 minutes (never 48 hours)", "in about 2 days", 47 * HOUR + 40 * MIN],
    ["three days", "in about 3 days", 3 * DAY],
    ["ten days and five hours", "in about 10 days", 10 * DAY + 5 * HOUR],
  ])("reads %s left as: %s", (_label, phrase, left) => {
    expect(lineAt(left)).toBe(`${USED_UP} It resets ${phrase}.`);
  });

  it("reads a reset time given in milliseconds the same way", () => {
    expect(lineAt(2 * HOUR, RESET * 1000)).toBe(
      "Codex has used up its picture limit for now. It resets in about 2 hours.",
    );
  });

  it.each([
    ["already past", -5 * MIN],
    ["exactly now", 0],
  ])("ends after for now when the reset is %s", (_label, left) => {
    expect(lineAt(left)).toBe(USED_UP);
  });

  it.each([
    ["none", null],
    ["absent", undefined],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["negative", -1],
  ])("ends after for now when the runtime's reset is %s", (_label, resetsAt) => {
    expect(
      imageFailureLine(
        { type: "usageLimitExceeded", resetsAt: resetsAt as unknown as number },
        { now: RESET * 1000 },
      ),
    ).toBe(USED_UP);
  });

  it("measures from this machine's clock when it is given no time", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * HOUR + MIN;
    expect(imageFailureLine({ type: "usageLimitExceeded", resetsAt })).toBe(
      "Codex has used up its picture limit for now. It resets in about 3 hours.",
    );
  });

  it("names no clock time, no date and no zone", () => {
    for (const left of [30, 12 * MIN, 2 * HOUR, 3 * DAY])
      expect(lineAt(left)).not.toMatch(/UTC|GMT|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}/);
  });

  it("says something plain about a failure kind this build does not know", () => {
    expect(imageFailureLine({ type: "somethingNew" })).toBe(
      "Codex could not make a picture.",
    );
  });

  it("carries no em dash and no en dash in any line", () => {
    for (const line of [
      lineAt(30),
      lineAt(12 * MIN),
      lineAt(2 * HOUR),
      lineAt(3 * DAY),
      lineAt(-MIN),
      imageFailureLine({ type: "usageLimitExceeded" }),
      imageFailureLine({ type: "x" }),
    ])
      expect(line).not.toMatch(/[\u2013\u2014]/);
  });
});

/**
 * Re-review item 2: the line a picture posts in its place when it never
 * reached the chat. Two claims have to be earned: "made" only when the
 * runtime saved a copy or handed over the bytes, and the saved file named when
 * there is one, shortened by the same `shortenPath` every activity row uses
 * (the Codex home copy sits outside the media root, so the line is the only
 * place the owner learns where it is).
 */
describe("imageNotShownLine", () => {
  const HOME = "C:\\Users\\owner";
  const SAVED =
    "C:\\Users\\owner\\.codex\\generated_images\\thread-1\\ig_1.png";

  it("names the saved file, shortened under the home directory", () => {
    expect(imageNotShownLine({ savedPath: SAVED }, { home: HOME })).toBe(
      "Codex made a picture, but it could not be shown here. It is saved at ~\\.codex\\generated_images\\thread-1\\ig_1.png.",
    );
  });

  it("names the file and its folder when the saved copy is outside the home directory", () => {
    expect(
      imageNotShownLine(
        { savedPath: "/srv/codex/generated_images/thread-1/ig_1.png" },
        { home: "/home/owner" },
      ),
    ).toBe(
      "Codex made a picture, but it could not be shown here. It is saved at thread-1/ig_1.png.",
    );
  });

  it("says made, with no place, when the bytes came back and no copy was saved", () => {
    expect(imageNotShownLine({ bytes: GOLD_PNG }, { home: HOME })).toBe(
      "Codex made a picture, but it could not be shown here.",
    );
  });

  // Round 6 (premium item 3): "could not be shown" implies a picture exists
  // that the chat cannot draw, and this is exactly the case where nothing
  // came back. So the tried line says what happened.
  it("says only tried when neither the bytes nor a saved copy came back", () => {
    const line = imageNotShownLine({}, { home: HOME });
    expect(line).toBe(
      "Codex tried to make a picture, but nothing came back.",
    );
    expect(line).not.toMatch(/\bmade\b/);
    expect(line).not.toContain("could not be shown");
  });

  it("says made when the runtime returned something it could not decode", () => {
    expect(imageNotShownLine({ returnedOutput: true }, { home: HOME })).toBe(
      "Codex made a picture, but it could not be shown here.",
    );
  });

  // Round 5, end to end through collection: both items came back with a non
  // empty result and no saved copy. Codex made them; it never only tried.
  it.each([
    ["a result that is not a picture", () => Buffer.from("hello there").toString("base64")],
    [
      "a picture over the image cap",
      () => Buffer.concat([GOLD_PNG, Buffer.alloc(IMAGE_BYTES_MAX)]).toString("base64"),
    ],
  ])("says made, never tried, for %s with no saved file", (_label, result) => {
    const image = collectGeneratedImage(
      imageItem({ result: result(), savedPath: null }),
    )!;
    const line = imageNotShownLine(image, { home: HOME });
    expect(line).toBe("Codex made a picture, but it could not be shown here.");
    expect(line).not.toMatch(/\btried\b/);
  });

  it("still says only tried for an empty or absent result with no saved file", () => {
    for (const result of ["", undefined]) {
      const image = collectGeneratedImage(imageItem({ result, savedPath: null }))!;
      expect(imageNotShownLine(image, { home: HOME })).toBe(
        "Codex tried to make a picture, but nothing came back.",
      );
    }
  });

  it("carries no em dash and no en dash", () => {
    for (const line of [
      imageNotShownLine({ savedPath: SAVED }, { home: HOME }),
      imageNotShownLine({ bytes: GOLD_PNG }),
      imageNotShownLine({ returnedOutput: true }),
      imageNotShownLine({}),
    ])
      expect(line).not.toMatch(/[\u2013\u2014]/);
  });
});
