import { describe, it, expect } from "vitest";
import { parseReply } from "../src/reply-markers.js";

describe("parseReply (outbound marker bridge)", () => {
  it("returns plain text unchanged when there are no markers", () => {
    const r = parseReply("Hello there.\nHow can I help?");
    expect(r.cleanText).toBe("Hello there.\nHow can I help?");
    expect(r.media).toEqual([]);
    expect(r.buttons).toBeNull();
    expect(r.ask).toBeNull();
    expect(r.status).toBeNull();
  });

  it("extracts a single MEDIA path and strips the marker line", () => {
    const r = parseReply("Here is the chart.\nMEDIA:/tmp/chart.png\nLet me know.");
    expect(r.media).toEqual(["/tmp/chart.png"]);
    expect(r.cleanText).toBe("Here is the chart.\nLet me know.");
  });

  it("extracts multiple MEDIA paths in order", () => {
    const r = parseReply("MEDIA:/a/one.png\nMEDIA:/a/two.pdf\nDone.");
    expect(r.media).toEqual(["/a/one.png", "/a/two.pdf"]);
    expect(r.cleanText).toBe("Done.");
  });

  it("parses a STATUS marker and strips it", () => {
    const r = parseReply("STATUS: deploying\nWorking on it.");
    expect(r.status).toEqual({ text: "deploying" });
    expect(r.cleanText).toBe("Working on it.");
  });

  it("treats an empty STATUS as a clear", () => {
    const r = parseReply("All done.\nSTATUS:");
    expect(r.status).toEqual({ text: "" });
    expect(r.cleanText).toBe("All done.");
  });

  it("parses a BGOS_BUTTONS block into options and strips it", () => {
    const r = parseReply(
      "Pick one:\n[[BGOS_BUTTONS]]\nYes | yes\nNo | no\n[[/BGOS_BUTTONS]]",
    );
    expect(r.buttons).toEqual({
      options: [
        { text: "Yes", callbackData: "yes" },
        { text: "No", callbackData: "no" },
      ],
    });
    expect(r.cleanText).toBe("Pick one:");
  });

  it("uses the label as callbackData when a button line has no pipe", () => {
    const r = parseReply("[[BGOS_BUTTONS]]\nRetry\n[[/BGOS_BUTTONS]]");
    expect(r.buttons?.options).toEqual([{ text: "Retry", callbackData: "Retry" }]);
  });

  it("caps buttons at 6 options", () => {
    const lines = ["[[BGOS_BUTTONS]]"];
    for (let i = 1; i <= 9; i++) lines.push(`Opt${i} | v${i}`);
    lines.push("[[/BGOS_BUTTONS]]");
    const r = parseReply(lines.join("\n"));
    expect(r.buttons?.options).toHaveLength(6);
  });

  it("parses a BGOS_ASK block with questions, options, and flags", () => {
    const r = parseReply(
      [
        "[[BGOS_ASK]]",
        "Q: What is your name?",
        "nofreetext",
        "Alice | alice",
        "Bob | bob",
        "Q: Continue?",
        "noskip",
        "Yes | yes",
        "[[/BGOS_ASK]]",
      ].join("\n"),
    );
    expect(r.ask).not.toBeNull();
    expect(r.ask?.questions).toHaveLength(2);
    expect(r.ask?.questions[0]).toEqual({
      text: "What is your name?",
      options: [
        { text: "Alice", callbackData: "alice" },
        { text: "Bob", callbackData: "bob" },
      ],
      allowFreeText: false,
      allowSkip: true,
    });
    expect(r.ask?.questions[1]).toEqual({
      text: "Continue?",
      options: [{ text: "Yes", callbackData: "yes" }],
      allowFreeText: true,
      allowSkip: false,
    });
    expect(r.cleanText).toBe("");
  });

  it("caps ask at 4 questions", () => {
    const lines = ["[[BGOS_ASK]]"];
    for (let i = 1; i <= 6; i++) lines.push(`Q: Question ${i}?`);
    lines.push("[[/BGOS_ASK]]");
    const r = parseReply(lines.join("\n"));
    expect(r.ask?.questions).toHaveLength(4);
  });

  it("collapses excess blank lines left behind after stripping markers", () => {
    const r = parseReply("Line one.\nMEDIA:/x/y.png\n\n\nLine two.");
    expect(r.cleanText).toBe("Line one.\n\nLine two.");
  });
});
