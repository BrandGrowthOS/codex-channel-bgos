/**
 * Rewrite the secrets out of a command's output before it leaves this
 * machine.
 *
 * This is a PORT, not a new idea. The platform scans every agent pack with
 * thirteen rules in `backend/src/agent-handoffs/secret-scan.util.ts`, and the
 * same thirteen shapes are listed here in the same order with the same value
 * groups, the same placeholder allowlist and the same masked form (the first
 * four characters and an ellipsis), so a line this plugin sends and a line
 * the platform re reads are masked identically. `REDACT_RULE_IDS` is pinned
 * by the test beside this file: a rule that is dropped in the port is loud.
 *
 * Four differences from the scanner, every one of them deliberate:
 *
 *  1. The scanner RETURNS FINDINGS and never a rewritten string, because a
 *     finding blocks a pack. Output cannot be blocked: a shell row carrying
 *     a secret is masked and still drawn, because refusing it would cost the
 *     owner the whole row and would not un print what the process already
 *     printed.
 *  2. Every rule here is GLOBAL. The scanner takes the first match per line
 *     for the rules that have no placeholder allowlist, which is right when
 *     any single finding blocks the pack and wrong when the job is to mask:
 *     a line carrying two keys would keep the second one in the clear.
 *  3. A value of eight characters or fewer is replaced OUTRIGHT, because the
 *     excerpt form is an excerpt: four characters of a five character
 *     password is the password. `maskSecret` itself is unchanged, since the
 *     excerpt beside a finding is meant to be recognisable.
 *  4. A private key BLOCK is removed, not only its header line. Every rule
 *     is anchored to one line and a key body is plain base64, so the header
 *     masked and the body shipped is what a line by line pass does on its
 *     own. Once a BEGIN line is seen, everything up to and including the
 *     first line carrying an END marker becomes one placeholder line, and a
 *     header with no end masks the rest of the text.
 *
 * Line endings: the text is split on CR LF or LF and rejoined with LF, the
 * same normalisation the platform's own redactor performs, so a Windows
 * command's output reads the same on both sides of the wire.
 */

/**
 * Placeholder allowlist, case insensitive and whole value: env
 * interpolations, angle bracket templates, your-*, xxx runs, *** runs, TODO,
 * CHANGEME, REDACTED, EXAMPLE*. A template is not a secret, and masking one
 * turns a readable line into noise for no gain.
 */
const PLACEHOLDER_VALUE_RE =
  /^(\$\{?[A-Z_]+\}?|<[^>]+>|your[-_].*|xxx+|\*{3,}|TODO|CHANGEME|REDACTED|EXAMPLE.*)$/i;

export function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_VALUE_RE.test(value);
}

/** Mask a matched secret to its first 4 characters and an ellipsis. */
export function maskSecret(secret: string): string {
  return `${secret.slice(0, 4)}...`;
}

/** Length at or below which an excerpt would write the secret back. */
const SHORT_VALUE_MAX = 8;
/** What a short value is replaced with, whole. */
const HIDDEN_VALUE = "[hidden]";

/**
 * How the redaction pass writes a matched value back: the excerpt for a value
 * long enough that four characters are not most of it, and a fixed token for
 * anything shorter. A four character password masked to `maskSecret` comes
 * out as itself plus three dots.
 */
export function maskValue(secret: string): string {
  return secret.length <= SHORT_VALUE_MAX ? HIDDEN_VALUE : maskSecret(secret);
}

interface RedactRule {
  id: string;
  /** Global regex, evaluated per line. */
  pattern: RegExp;
  /** 0 = the whole match is the secret; 1 = capture group 1 is. */
  valueGroup: 0 | 1;
  /** Apply the placeholder allowlist to the extracted value. */
  placeholders: boolean;
}

/** The platform's rules_version 1 detectors, in the platform's order. */
const RULES: readonly RedactRule[] = [
  // AWS access key id: AKIA and 16 uppercase alphanumerics.
  {
    id: "aws_access_key_id",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    valueGroup: 0,
    placeholders: false,
  },
  // An aws-ish assignment whose value is exactly a 40 character base64ish
  // token. The word "secret" is not required: real code writes aws_key.
  {
    id: "aws_secret_access_key",
    pattern: /\baws.{0,30}?['"=:\s]([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    valueGroup: 1,
    placeholders: true,
  },
  {
    id: "anthropic_api_key",
    pattern: /\bsk-ant-[A-Za-z0-9-]{20,}/g,
    valueGroup: 0,
    placeholders: false,
  },
  // OpenAI: sk-proj- project keys and classic sk- keys.
  {
    id: "openai_api_key",
    pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{20,}/g,
    valueGroup: 0,
    placeholders: false,
  },
  {
    id: "github_token",
    pattern: /\b(?:gh[posu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    valueGroup: 0,
    placeholders: false,
  },
  {
    id: "slack_token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    valueGroup: 0,
    placeholders: false,
  },
  {
    id: "stripe_live_key",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{10,}/g,
    valueGroup: 0,
    placeholders: false,
  },
  {
    id: "google_api_key",
    pattern: /\bAIza[0-9A-Za-z_-]{30,}/g,
    valueGroup: 0,
    placeholders: false,
  },
  // The BEGIN line of any PEM private key block, and the PGP variant.
  {
    id: "private_key_block",
    pattern: /-----BEGIN\s+(?:[A-Z0-9]+\s+)*PRIVATE\s+KEY(?:\s+BLOCK)?-----/g,
    valueGroup: 0,
    placeholders: false,
  },
  // JWT: three base64url segments, the first starting with eyJ.
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}/g,
    valueGroup: 0,
    placeholders: false,
  },
  // A connection string with an inline password. The PASSWORD is the secret,
  // not the scheme and not the host, so the line stays readable.
  {
    id: "connection_string_password",
    pattern:
      /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:([^\s@/]+)@/gi,
    valueGroup: 1,
    placeholders: true,
  },
  {
    id: "bearer_token",
    pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g,
    valueGroup: 1,
    placeholders: true,
  },
  // A keyish name, : or =, then 16 or more non space, non quote characters.
  {
    id: "generic_secret_assignment",
    pattern:
      /(?:api[_-]?key|secret|token|passwd|password|authorization)['"]?\s*[:=]\s*['"]?([^'"\s]{16,})/gi,
    valueGroup: 1,
    placeholders: true,
  },
];

/** The rule ids, in evaluation order. Pinned by the test beside this file. */
export const REDACT_RULE_IDS: readonly string[] = RULES.map((rule) => rule.id);

/** One line, every rule, every match. */
function redactLine(line: string): string {
  let text = line;
  for (const rule of RULES) {
    // A fresh regex per line: a global one carries lastIndex between calls.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    text = text.replace(pattern, (whole: string, ...rest: unknown[]) => {
      const secret =
        rule.valueGroup === 0 ? whole : (rest[0] as string | undefined);
      if (typeof secret !== "string" || secret.length === 0) return whole;
      if (rule.placeholders && isPlaceholderValue(secret)) return whole;
      // The VALUE is replaced and never the whole match, so a connection
      // string keeps its scheme and its host and loses only the password.
      const at = whole.lastIndexOf(secret);
      if (at < 0) return whole;
      return whole.slice(0, at) + maskValue(secret) + whole.slice(at + secret.length);
    });
  }
  return text;
}

/** The BEGIN line of a private key block, on a line of its own. */
const PRIVATE_KEY_BEGIN_RE =
  /-----BEGIN\s+(?:[A-Z0-9]+\s+)*PRIVATE\s+KEY(?:\s+BLOCK)?-----/;
/** Any END marker closes the block, whatever the key type says. */
const PRIVATE_KEY_END = "-----END";
/** The one line a key body becomes. */
const PRIVATE_KEY_BODY = "[private key removed]";

/**
 * The text with every matched secret masked, and the body of any private key
 * block removed. A clean string comes back exactly as it went in, apart from
 * CR LF becoming LF.
 */
export function redactOutput(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  if (text.length === 0) return "";
  const out: string[] = [];
  // Set by a BEGIN line and cleared by the first END line after it. While it
  // is set, every line is dropped and the block stands as one placeholder.
  let insideKey = false;
  let placeheld = false;
  for (const line of text.split(/\r?\n/)) {
    if (insideKey) {
      if (!placeheld) {
        out.push(PRIVATE_KEY_BODY);
        placeheld = true;
      }
      if (line.includes(PRIVATE_KEY_END)) insideKey = false;
      continue;
    }
    out.push(redactLine(line));
    if (PRIVATE_KEY_BEGIN_RE.test(line)) {
      insideKey = true;
      placeheld = false;
    }
  }
  return out.join("\n");
}
