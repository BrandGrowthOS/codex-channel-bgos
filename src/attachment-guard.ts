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
 * True when an IPv4/IPv6 literal is loopback, link-local, private (RFC1918),
 * carrier-grade NAT, unique-local, unspecified, or a known cloud-metadata
 * address. Malformed input is treated as unsafe (fail closed). Pure.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!addr) return true;
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) collapses to its v4 tail.
  const v4 = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
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
  // IP literal? (dotted-quad or contains a colon = IPv6)
  if (/^[0-9.]+$/.test(h) || h.includes(":")) return isPrivateOrReservedIp(h);
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
  const isIpLiteral = /^[0-9.]+$/.test(bare) || bare.includes(":");
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
