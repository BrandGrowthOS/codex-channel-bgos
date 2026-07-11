import { describe, it, expect } from "vitest";
import { buildCodexInput } from "../src/inbound-input.js";
import type { InboundFileForCodex } from "../src/inbound-input.js";

const img = (path: string): InboundFileForCodex => ({
  path,
  mime: "image/png",
  name: path.split("/").pop() ?? "img",
  isImage: true,
});
const doc = (path: string, mime = "application/pdf"): InboundFileForCodex => ({
  path,
  mime,
  name: path.split("/").pop() ?? "doc",
  isImage: false,
});

describe("buildCodexInput (BGOS inbound -> Codex Input)", () => {
  it("returns a plain string when there are no files", () => {
    expect(buildCodexInput("hello codex", [])).toBe("hello codex");
  });

  it("returns an array with a text part and a local_image for an image", () => {
    const input = buildCodexInput("look at this", [img("/tmp/a.png")]);
    expect(Array.isArray(input)).toBe(true);
    expect(input).toEqual([
      { type: "text", text: "look at this" },
      { type: "local_image", path: "/tmp/a.png" },
    ]);
  });

  it("injects a text line describing a non-image file and stays a string", () => {
    const input = buildCodexInput("here is the report", [doc("/tmp/r.pdf")]);
    expect(typeof input).toBe("string");
    expect(input).toContain("here is the report");
    expect(input).toContain("/tmp/r.pdf");
    expect(input).toContain("application/pdf");
  });

  it("emits only local_image parts when the text is empty", () => {
    const input = buildCodexInput("", [img("/tmp/only.png")]);
    expect(input).toEqual([{ type: "local_image", path: "/tmp/only.png" }]);
  });

  it("preserves the order of multiple images", () => {
    const input = buildCodexInput("two", [img("/tmp/1.png"), img("/tmp/2.png")]);
    expect(input).toEqual([
      { type: "text", text: "two" },
      { type: "local_image", path: "/tmp/1.png" },
      { type: "local_image", path: "/tmp/2.png" },
    ]);
  });

  it("mixes a document line into the text part alongside an image", () => {
    const input = buildCodexInput("mix", [doc("/tmp/d.pdf"), img("/tmp/i.png")]);
    expect(Array.isArray(input)).toBe(true);
    const arr = input as Array<{ type: string; text?: string; path?: string }>;
    const textPart = arr.find((p) => p.type === "text");
    expect(textPart?.text).toContain("mix");
    expect(textPart?.text).toContain("/tmp/d.pdf");
    expect(arr.some((p) => p.type === "local_image" && p.path === "/tmp/i.png")).toBe(true);
  });

  it("returns an empty string for empty text and no files", () => {
    expect(buildCodexInput("", [])).toBe("");
  });
});
