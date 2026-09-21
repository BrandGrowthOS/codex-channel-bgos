/**
 * What a command printed, on its way out of this machine.
 *
 * Two things are proven here and they are proven together, because the ORDER
 * is the contract: the mask runs over the WHOLE string, and only then is the
 * text cut to its tail. Cutting first hands the rules half a token, the
 * pattern no longer matches, and the half that ships is still a secret.
 *
 * MUTATION PROOFS (each test names the change that must turn it red):
 *  - keep the head instead of the tail -> "keeps the END" goes red
 *  - rename the slack_token rule -> "carries the backend's thirteen rules" goes red
 *  - make the openai rule never match -> "masks the shapes the backend masks" goes red
 *  - build the rule regex without the global flag -> "masks BOTH keys on one line" goes red
 *  - replace the whole match instead of the value group -> "keeps the scheme and the host" goes red
 *  - drop the placeholder allowlist -> "leaves a placeholder alone" goes red
 *  - rejoin the lines with a space -> "gives a clean line back" goes red
 *  - clip to the cap BEFORE masking -> "a secret straddling the cut" goes red
 *  - clip the text to any length BEFORE masking -> "a dense line of secrets" goes red
 *  - drop the private key block branch -> "the BODY of a private key" goes red
 *  - mask every value with maskSecret -> "a short value is hidden whole" goes red
 *  - drop the final tail clip -> "3000 characters come back at 2048" goes red
 *  - drop the line ceiling -> "400 lines come back at 200" goes red
 *  - coerce anything to a string -> "byte identical, and nothing for nothing" goes red
 */
import { describe, expect, it } from "vitest";

import {
  buildOutputTail,
  OUTPUT_LINES_MAX,
  OUTPUT_MAX,
  tailClip,
} from "../src/output-tail.js";
import { redactOutput, REDACT_RULE_IDS } from "../src/redact-output.js";

/** Halves of a surrogate pair with no partner. Postgres refuses these. */
function loneSurrogates(text: string): number {
  let lone = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) lone += 1;
      else i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) lone += 1;
  }
  return lone;
}

describe("tailClip", () => {
  it("keeps the END of the text, which is the part the owner is reading", () => {
    expect(tailClip("abcdef", 3)).toBe("def");
    expect(tailClip("abcdef", 6)).toBe("abcdef");
    expect(tailClip("abcdef", 99)).toBe("abcdef");
    expect(tailClip("abcdef", 0)).toBe("");
    expect(tailClip(undefined, 10)).toBe("");
    expect(tailClip(42, 10)).toBe("");
  });

  it("never leaves the dangling second half of a character at the front", () => {
    // "ab" + a two unit astral character + "cd": a tail of 3 lands between
    // the halves, so the low surrogate at the front is dropped.
    const text = "ab\u{1F600}cd";
    expect(tailClip(text, 3)).toBe("cd");
    expect(loneSurrogates(tailClip(text, 3))).toBe(0);
    // A tail of 4 keeps the whole pair.
    expect(tailClip(text, 4)).toBe("\u{1F600}cd");
    expect(loneSurrogates(tailClip(text, 4))).toBe(0);

    const astral = "\u{1F600}".repeat(200);
    for (const max of [1, 2, 3, 40, 199, 200]) {
      const clipped = tailClip(astral, max);
      expect(clipped.length).toBeLessThanOrEqual(max);
      expect(clipped.length).toBeGreaterThanOrEqual(max - 1);
      expect(loneSurrogates(clipped)).toBe(0);
    }
  });
});

describe("redactOutput", () => {
  it("carries the backend's thirteen rules, by id and in order", () => {
    expect(REDACT_RULE_IDS).toEqual([
      "aws_access_key_id",
      "aws_secret_access_key",
      "anthropic_api_key",
      "openai_api_key",
      "github_token",
      "slack_token",
      "stripe_live_key",
      "google_api_key",
      "private_key_block",
      "jwt",
      "connection_string_password",
      "bearer_token",
      "generic_secret_assignment",
    ]);
  });

  it("masks the shapes the backend masks, to four characters and an ellipsis", () => {
    expect(redactOutput("key AKIAIOSFODNN7EXAMPLE here")).toBe(
      "key AKIA... here",
    );
    expect(redactOutput("sk-abcdefghijklmnopqrstuvwx")).toBe("sk-a...");
    expect(redactOutput("Bearer abcdefghijklmnopqrstuvwxyz")).toBe(
      "Bearer abcd...",
    );
    expect(redactOutput("API_KEY=abcdefghijklmnop")).toBe("API_KEY=abcd...");
    expect(redactOutput("xoxb-1234567890-abcdefghij")).toBe("xoxb...");
  });

  it("masks BOTH keys on one line, not only the first", () => {
    expect(
      redactOutput("AKIAIOSFODNN7EXAMPLE and AKIAJKLMNOPQRSTUVWXY"),
    ).toBe("AKIA... and AKIA...");
  });

  it("keeps the scheme and the host and loses only the password", () => {
    const masked = redactOutput(
      "postgres://bgos:hunter2andalongertail@db.internal/app",
    );
    expect(masked).toBe("postgres://bgos:hunt...@db.internal/app");
    expect(masked).not.toContain("hunter2andalongertail");
  });

  it("hides a short value whole, because four of five characters is the secret", () => {
    // The excerpt form is an excerpt: on a short value it writes most of the
    // secret straight back, so anything of eight characters or fewer is
    // replaced outright instead.
    const masked = redactOutput("postgres://bgos:hunter2@db.internal/app");
    expect(masked).toBe("postgres://bgos:[hidden]@db.internal/app");
    expect(masked).not.toContain("hunter2");

    const short = redactOutput("postgres://bgos:abc@db.internal/app");
    expect(short).toBe("postgres://bgos:[hidden]@db.internal/app");
    expect(short).not.toContain("abc");

    // Nine characters is long enough for the excerpt to still be an excerpt.
    expect(redactOutput("Bearer abcdefghijklmnopqrstuvwxyz")).toBe(
      "Bearer abcd...",
    );
  });

  it("removes the BODY of a private key block, not only its header line", () => {
    // A fake ed25519 shaped block: the header is masked by the rule, and the
    // base64 body is what the rules never matched, because the rules are line
    // anchored and a body line is just base64.
    const raw = [
      "reading id_ed25519",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz",
      "c2gtZWQyNTUxOQAAACBmYWtlZmFrZWZha2VmYWtlZmFrZWZha2VmYWtlZmFrZQAA",
      "-----END OPENSSH PRIVATE KEY-----",
      "done",
    ].join("\n");
    const out = redactOutput(raw);
    expect(out).not.toContain("b3BlbnNzaC1rZXktdjEA");
    expect(out).not.toContain("c2gtZWQyNTUxOQ");
    expect(out).toContain("[private key removed]");
    // The lines around the block are untouched.
    expect(out.startsWith("reading id_ed25519\n")).toBe(true);
    expect(out.endsWith("\ndone")).toBe(true);
    // The block collapses to one line: header, placeholder, and the text
    // that followed it.
    expect(out.split("\n")).toHaveLength(4);
  });

  it("masks everything after a private key header that never ends", () => {
    const out = redactOutput(
      [
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEowIBAAKCAQEAfakefakefakefakefakefakefakefakefakefakefakefake",
        "MIIEowIBAAKCAQEAotherfakebodylinethatmustnotsurvivethiscallatall",
      ].join("\n"),
    );
    expect(out).not.toContain("MIIEowIBAAKCAQEA");
    expect(out).toContain("[private key removed]");
  });

  it("leaves a placeholder alone, because noise is not a secret", () => {
    expect(redactOutput("api_key=${SOME_API_KEY_NAME}")).toBe(
      "api_key=${SOME_API_KEY_NAME}",
    );
    expect(redactOutput("token=<your-token-here>")).toBe(
      "token=<your-token-here>",
    );
  });

  it("gives a clean line back exactly as it came", () => {
    const clean = "total 2\n-rw-r--r-- 1 kc kc 12 Sep 21 out.txt";
    expect(redactOutput(clean)).toBe(clean);
  });
});

describe("buildOutputTail", () => {
  it("masks a secret straddling the cut, because the mask runs first", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    // Dots around the key, not letters: the rule is word anchored, and a key
    // buried inside a run of letters is not the case this test is about.
    const raw = ".".repeat(3000) + secret + ".".repeat(2040);
    const out = buildOutputTail(raw);
    expect(out).toContain("AKIA...");
    expect(out).not.toContain(secret);
    expect(out.length).toBe(OUTPUT_MAX);
  });

  it("masks a dense line of secrets whole, because nothing is cut first", () => {
    // 200 tokens on ONE line, far longer than any pre trim window. Masking
    // SHRINKS them, so a cut that ran first would land inside the line,
    // slice the `Bearer ` anchor off one token, and carry that token to the
    // wire in the clear while the rest of the line masked correctly.
    const tokens = Array.from({ length: 200 }, (_, i) =>
      i.toString(16).padStart(4, "0").repeat(16),
    );
    const raw = tokens.map((token) => `Bearer ${token}`).join(" ");
    expect(raw.length).toBeGreaterThan(4 * OUTPUT_MAX);
    expect(raw.split("\n")).toHaveLength(1);

    const out = buildOutputTail(raw);
    expect(out.length).toBeLessThanOrEqual(OUTPUT_MAX);
    for (const token of tokens) expect(out).not.toContain(token);
    // What comes back is masked excerpts and nothing else.
    expect(out).toContain("...");
    expect(redactOutput(out)).toBe(out);
  });

  it("brings 3000 characters back at 2048, and keeps the last of them", () => {
    const out = buildOutputTail("y".repeat(900) + "x".repeat(3000));
    expect(out).toBe("x".repeat(OUTPUT_MAX));
  });

  it("brings 400 lines back at 200, with the line breaks still there", () => {
    const raw = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const out = buildOutputTail(raw);
    const lines = out.split("\n");
    expect(lines).toHaveLength(OUTPUT_LINES_MAX);
    expect(lines[0]).toBe("line 200");
    expect(lines[199]).toBe("line 399");
    expect(out.length).toBeLessThanOrEqual(OUTPUT_MAX);
  });

  it("gives a short clean tail back byte identical, and nothing for nothing", () => {
    const clean = "total 2\n-rw-r--r-- 1 kc kc 12 Sep 21 out.txt\n";
    expect(buildOutputTail(clean)).toBe(clean);
    expect(buildOutputTail("")).toBe("");
    expect(buildOutputTail(null)).toBe("");
    expect(buildOutputTail(undefined)).toBe("");
  });
});
