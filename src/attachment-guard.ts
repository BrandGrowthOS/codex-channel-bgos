/**
 * Inbound-attachment safety guard (SSRF + resource-exhaustion).
 *
 * SECURITY: `ingestBgosAttachment` (attachment-bridge.ts) turns a BGOS
 * `inbound_message` `files[]` entry into a local temp file. The `url`,
 * `fileData`, and `dataUri` fields are all set by the BGOS backend, and the
 * threat model treats a compromised or MITM'd backend as an in-scope adversary.
 * Without a guard, a hostile backend could:
 *   - point `url` at http://169.254.169.254/ (cloud metadata), http://127.0.0.1
 *     (a local service), or an RFC1918 host, making the victim daemon issue
 *     arbitrary internal requests (blind/read SSRF);
 *   - stream an unbounded body (or send a multi-hundred-MB base64 `fileData`)
 *     to exhaust the host's disk or memory.
 *
 * This module holds the PURE, unit-tested predicates (IP + hostname
 * classification, capped base64 decode) plus the redirect-revalidating fetch
 * used at the boundary. The byte cap matches BGOS's largest outbound media
 * ceiling (video, 100 MB) so a legitimate attachment is never rejected while an
 * unbounded stream is stopped. No em/en dashes (this file feeds no prompt, but
 * the repo convention is ASCII-only).
 */
import { lookup as dnsLookup } from "node:dns/promises";

/** Hard cap on bytes pulled from a single server-supplied attachment. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** Thrown when a server-supplied attachment URL is unsafe (SSRF guard). */
export class AttachmentUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentUrlError";
  }
}

/** Thrown when a server-supplied attachment exceeds the byte cap. */
export class AttachmentSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentSizeError";
  }
}

/**
 * Parse a single IPv4 numeral component per the same rules a numeric-address
 * evasion relies on: a 0x/0X prefix is hexadecimal, a bare leading zero (with
 * more digits after it) is octal, anything else is decimal. Returns null when
 * the token is not a valid numeral in its implied radix. Pure.
 */
function parseIpv4Component(part: string): number | null {
  if (part === "") return null;
  let radix = 10;
  let digits = part;
  if (digits.length > 1 && digits[0] === "0" && (digits[1] === "x" || digits[1] === "X")) {
    radix = 16;
    digits = digits.slice(2);
  } else if (digits.length > 1 && digits[0] === "0") {
    radix = 8;
    digits = digits.slice(1);
  }
  if (digits === "") return 0;
  const pattern = radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!pattern.test(digits)) return null;
  const value = parseInt(digits, radix);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Canonicalize a numeral-encoded IPv4 host (a bare decimal/hex/octal integer,
 * or a dotted form with 1 to 4 parts, e.g. "2130706433", "0x7f000001",
 * "0177.0.0.1", "127.1") into dotted-quad notation, per the same numeral
 * rules a raw socket connect (or a permissive DNS/HTTP client) would apply.
 * Returns:
 *   - the canonical "a.b.c.d" string when the host is a valid numeral form;
 *   - null when the host is not numeral shaped at all (an ordinary name);
 *   - "ambiguous" when the host LOOKS numeral shaped but fails to parse
 *     cleanly. Callers must fail closed (treat "ambiguous" as unsafe).
 * Pure.
 */
export function canonicalizeNumericIPv4(host: string): string | null | "ambiguous" {
  // Only characters a numeral IPv4 form can use; anything else (a real DNS
  // label with letters outside a-f) is an ordinary hostname, not a candidate.
  if (!/^[0-9a-fA-FxX.]+$/.test(host)) return null;
  if (!/\d/.test(host)) return null; // no digit at all -> not numeral shaped
  const parts = host.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  if (parts.some((p) => p === "")) return "ambiguous";
  const numbers: number[] = [];
  for (const part of parts) {
    const n = parseIpv4Component(part);
    if (n === null) return "ambiguous";
    numbers.push(n);
  }
  // All but the last component must fit a single octet; the last absorbs
  // the remaining bits (so "127.1" folds to 127.0.0.1).
  for (let i = 0; i < numbers.length - 1; i++) {
    if (numbers[i] > 255) return "ambiguous";
  }
  const last = numbers[numbers.length - 1];
  const maxLast = 256 ** (5 - numbers.length) - 1;
  if (last > maxLast || last < 0) return "ambiguous";
  let value = last;
  for (let i = 0; i < numbers.length - 1; i++) {
    value += numbers[i] * 256 ** (3 - i);
  }
  const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  return bytes.join(".");
}

/**
 * True when an IPv4/IPv6 literal is loopback, link-local, private (RFC1918),
 * carrier-grade NAT, unique-local, unspecified, or a known cloud-metadata
 * address. Malformed input is treated as unsafe (fail closed). Pure.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!addr) return true;
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) collapses to its v4 tail.
  const v4 = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  // A numeral-encoded IPv4 host (decimal integer, 0x-hex, octal, or a short
  // dotted form like "127.1") must be canonicalized before classification;
  // otherwise "2130706433" (127.0.0.1) or "0x7f000001" slips past the plain
  // dotted-quad regex below untouched. A host that looks numeral shaped but
  // fails to parse cleanly is unsafe (fail closed).
  const canon = canonicalizeNumericIPv4(v4);
  if (canon === "ambiguous") return true;
  const dotted = canon ?? v4;
  const m = dotted.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1, 5).map(Number);
    if (o.some((x) => x > 255)) return true; // malformed octet -> unsafe
    const [a, b] = o;
    if (a === 0) return true; // 0.0.0.0/8 unspecified
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local incl 169.254.169.254
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    return false;
  }
  // IPv6 forms.
  if (addr === "::" || addr === "::1") return true; // unspecified / loopback
  if (addr.startsWith("fe80")) return true; // link-local fe80::/10
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // ULA fc00::/7
  if (addr.startsWith("::ffff:")) return true; // mapped form we did not decode -> unsafe
  return false;
}

/**
 * True when a hostname must be refused before any DNS lookup: literal loopback
 * names, `.localhost` / `.local` (mDNS), an empty host, or a private/reserved
 * IP literal. Pure.
 */
export function isBlockedHostname(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "ip6-localhost" || h === "ip6-loopback") return true;
  if (h.endsWith(".local")) return true; // mDNS
  // IP literal? Dotted-quad, IPv6 (contains a colon), or a numeral-encoded
  // form (decimal integer, 0x-hex, octal, short dotted like "127.1") that
  // canonicalizes to an IPv4 address, or an ambiguous numeral that fails to
  // canonicalize cleanly (fail closed rather than falling through as a name).
  if (/^[0-9.]+$/.test(h) || h.includes(":") || canonicalizeNumericIPv4(h) !== null) {
    return isPrivateOrReservedIp(h);
  }
  return false;
}

/** Injectable DNS resolver (for tests). Returns candidate addresses. */
export type AttachmentResolver = (
  host: string,
) => Promise<Array<{ address: string }>>;

const defaultResolver: AttachmentResolver = (host) =>
  dnsLookup(host, { all: true });

/**
 * Validate a server-supplied download URL against SSRF: http/https only, and
 * neither the literal host nor any DNS-resolved address may be loopback,
 * link-local, private, CGNAT, unique-local, or cloud-metadata. Returns the
 * parsed URL on success; throws AttachmentUrlError otherwise. The resolver is
 * injectable so the classification logic is unit-testable without a network.
 */
export async function assertSafeDownloadUrl(
  raw: string,
  resolver: AttachmentResolver = defaultResolver,
): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AttachmentUrlError("malformed attachment URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new AttachmentUrlError(
      `unsupported attachment URL scheme: ${u.protocol}`,
    );
  }
  const host = u.hostname;
  if (isBlockedHostname(host)) {
    throw new AttachmentUrlError(
      `refusing to fetch attachment from a private or reserved host: ${host}`,
    );
  }
  const bare = host.replace(/^\[|\]$/g, "");
  const isIpLiteral =
    /^[0-9.]+$/.test(bare) || bare.includes(":") || canonicalizeNumericIPv4(bare) !== null;
  if (!isIpLiteral) {
    let addrs: Array<{ address: string }>;
    try {
      addrs = await resolver(host);
    } catch {
      throw new AttachmentUrlError(`could not resolve attachment host: ${host}`);
    }
    if (!addrs || addrs.length === 0) {
      throw new AttachmentUrlError(`attachment host did not resolve: ${host}`);
    }
    for (const a of addrs) {
      if (isPrivateOrReservedIp(a.address)) {
        throw new AttachmentUrlError(
          `attachment host ${host} resolves to a private or reserved address ${a.address}`,
        );
      }
    }
  }
  return u;
}

/**
 * Fetch a server-supplied URL with SSRF protection, re-validating every
 * redirect hop (a public host must not 30x-redirect into a private one).
 * Returns the terminal Response (body still unread) so the caller can stream it
 * under a byte cap. Bounded to a few hops.
 */
export async function fetchAttachmentGuarded(
  raw: string,
  resolver: AttachmentResolver = defaultResolver,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  let current = (await assertSafeDownloadUrl(raw, resolver)).toString();
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetchImpl(current, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) {
        throw new AttachmentUrlError("attachment redirect had no Location");
      }
      const next = new URL(loc, current).toString();
      current = (await assertSafeDownloadUrl(next, resolver)).toString();
      continue;
    }
    return res;
  }
  throw new AttachmentUrlError("attachment exceeded the redirect limit");
}

/**
 * Reject an already-declared Content-Length that exceeds the cap. Returns the
 * parsed length (or null when absent/unparseable). Pure.
 */
export function assertDeclaredSizeOk(
  contentLength: string | null,
  cap = MAX_ATTACHMENT_BYTES,
): number | null {
  if (contentLength == null || contentLength === "") return null;
  const n = Number(contentLength);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > cap) {
    throw new AttachmentSizeError(
      `attachment declares ${n} bytes, over the ${cap} byte cap`,
    );
  }
  return n;
}

/**
 * Decode a base64 payload with an up-front size cap so a hostile inline body
 * cannot force a multi-hundred-MB allocation. Throws AttachmentSizeError when
 * the decoded size would exceed the cap. Pure.
 */
export function decodeBase64Capped(
  b64: string,
  cap = MAX_ATTACHMENT_BYTES,
): Buffer {
  // 4 base64 chars decode to 3 bytes; this bounds size without allocating.
  const approxBytes = Math.floor((b64.length * 3) / 4);
  if (approxBytes > cap) {
    throw new AttachmentSizeError(
      `inline attachment (~${approxBytes} bytes) exceeds the ${cap} byte cap`,
    );
  }
  return Buffer.from(b64, "base64");
}
