import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAllowedMediaPath, MediaPathError } from "../src/media-guard.js";

describe("media-guard.resolveAllowedMediaPath", () => {
  let root: string; // the allowed media root (realpath'd)
  let outside: string; // a sibling dir OUTSIDE the root
  const originalRoot = process.env.CODEX_BGOS_MEDIA_ROOT;

  beforeEach(() => {
    // realpathSync so macOS /var -> /private/var symlinking doesn't trip
    // the containment compare in the test itself.
    root = realpathSync(mkdtempSync(join(tmpdir(), "codex-media-root-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "codex-media-out-")));
    process.env.CODEX_BGOS_MEDIA_ROOT = root;
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.CODEX_BGOS_MEDIA_ROOT;
    else process.env.CODEX_BGOS_MEDIA_ROOT = originalRoot;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("allows a real file inside the configured root", () => {
    const f = join(root, "ok.png");
    writeFileSync(f, "x");
    expect(resolveAllowedMediaPath(f)).toBe(realpathSync(f));
  });

  it("rejects a path outside the root", () => {
    const f = join(outside, "secret.txt");
    writeFileSync(f, "x");
    expect(() => resolveAllowedMediaPath(f)).toThrow(MediaPathError);
    expect(() => resolveAllowedMediaPath(f)).toThrow(/outside the allowed/);
  });

  it("rejects path-traversal that escapes the root", () => {
    const f = join(outside, "escape.txt");
    writeFileSync(f, "x");
    // ../<outside-basename>/escape.txt expressed relative to the root.
    const traversal = join(root, "..", outside.split("/").pop()!, "escape.txt");
    expect(() => resolveAllowedMediaPath(traversal)).toThrow(MediaPathError);
  });

  it("rejects /etc/passwd as a sensitive location", () => {
    // Even with a permissive root, the sensitive-prefix deny wins. Point
    // the root at "/" to prove the second line of defense.
    process.env.CODEX_BGOS_MEDIA_ROOT = "/";
    expect(() => resolveAllowedMediaPath("/etc/passwd")).toThrow(
      /sensitive location/,
    );
  });

  it("rejects a symlink whose target escapes the root", () => {
    const target = join(outside, "real-secret.txt");
    writeFileSync(target, "x");
    const link = join(root, "innocent");
    symlinkSync(
      outside,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    // The link lives inside root, but realpath resolves to `outside`.
    expect(() =>
      resolveAllowedMediaPath(join(link, "real-secret.txt")),
    ).toThrow(MediaPathError);
  });

  it("allows a symlink that stays inside the root", () => {
    const directory = join(root, "original");
    mkdirSync(directory);
    const target = join(directory, "real.png");
    writeFileSync(target, "x");
    const link = join(root, "alias");
    symlinkSync(
      directory,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(resolveAllowedMediaPath(join(link, "real.png"))).toBe(
      realpathSync(target),
    );
  });

  it("rejects a non-existent file", () => {
    expect(() => resolveAllowedMediaPath(join(root, "nope.png"))).toThrow(
      /not found or unreadable/,
    );
  });

  it("rejects an empty path", () => {
    expect(() => resolveAllowedMediaPath("")).toThrow(/empty/);
  });

  it("rejects a NUL-byte path", () => {
    expect(() => resolveAllowedMediaPath("/tmp/a\0b.png")).toThrow(/NUL byte/);
  });

  it("does not treat a sibling dir sharing the root prefix as inside", () => {
    // `<root>` vs `<root>-evil` must NOT match (separator-terminated compare).
    const sibling = realpathSync(
      mkdtempSync(join(tmpdir(), "codex-media-root-evil-")),
    );
    try {
      const f = join(sibling, "x.txt");
      writeFileSync(f, "x");
      // Pin the root to the original (shorter) path; the sibling shares a
      // tmpdir prefix but is a distinct directory.
      process.env.CODEX_BGOS_MEDIA_ROOT = root;
      expect(() => resolveAllowedMediaPath(f)).toThrow(/outside the allowed/);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});
