/**
 * SSRF + size-cap guard for inbound attachments (attachment-guard.ts).
 *
 * Regression coverage for the High finding: ingestBgosAttachment fetched a
 * server-controlled URL with no scheme/host allowlist and streamed it with no
 * byte cap. These tests pin the pure classification + capped-decode logic (no
 * network) so the guard cannot silently regress.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_ATTACHMENT_BYTES,
  AttachmentSizeError,
  AttachmentUrlError,
  assertDeclaredSizeOk,
  assertSafeDownloadUrl,
  decodeBase64Capped,
  isBlockedHostname,
  isPrivateOrReservedIp,
} from "../src/attachment-guard.js";

describe("isPrivateOrReservedIp", () => {
  it("flags loopback, link-local, RFC1918, CGNAT, unspecified, metadata", () => {
    for (const ip of [
      "127.0.0.1",
      "169.254.169.254", // cloud metadata
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1", // IPv4-mapped loopback
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "52.216.1.2", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(false);
    }
  });

  it("fails closed on malformed input", () => {
    expect(isPrivateOrReservedIp("999.1.1.1")).toBe(true);
    expect(isPrivateOrReservedIp("")).toBe(true);
  });
});

describe("isBlockedHostname", () => {
  it("blocks loopback names, mDNS, and private IP literals", () => {
    for (const h of ["localhost", "foo.localhost", "printer.local", "169.254.169.254", "127.0.0.1", ""]) {
      expect(isBlockedHostname(h), h).toBe(true);
    }
  });
  it("allows public hostnames and public IP literals", () => {
    for (const h of ["s3.amazonaws.com", "api.brandgrowthos.ai", "8.8.8.8"]) {
      expect(isBlockedHostname(h), h).toBe(false);
    }
  });
});

describe("assertSafeDownloadUrl", () => {
  const publicResolver = async () => [{ address: "52.216.1.2" }];
  const privateResolver = async () => [{ address: "10.0.0.9" }];

  it("rejects non-http(s) schemes", async () => {
    await expect(assertSafeDownloadUrl("file:///etc/passwd", publicResolver)).rejects.toBeInstanceOf(
      AttachmentUrlError,
    );
    await expect(assertSafeDownloadUrl("gopher://x/", publicResolver)).rejects.toBeInstanceOf(
      AttachmentUrlError,
    );
  });

  it("rejects cloud-metadata and loopback IP literals (the confirmed exploit)", async () => {
    await expect(
      assertSafeDownloadUrl("http://169.254.169.254/latest/meta-data/", publicResolver),
    ).rejects.toBeInstanceOf(AttachmentUrlError);
    await expect(assertSafeDownloadUrl("http://127.0.0.1:5432/", publicResolver)).rejects.toBeInstanceOf(
      AttachmentUrlError,
    );
  });

  it("rejects a public hostname that DNS-resolves to a private address", async () => {
    await expect(assertSafeDownloadUrl("https://evil.example/x", privateResolver)).rejects.toBeInstanceOf(
      AttachmentUrlError,
    );
  });

  it("allows a legitimate public https URL", async () => {
    const u = await assertSafeDownloadUrl("https://my-bucket.s3.amazonaws.com/key?sig=abc", publicResolver);
    expect(u.protocol).toBe("https:");
    expect(u.hostname).toBe("my-bucket.s3.amazonaws.com");
  });

  it("allows a public IP literal without resolving", async () => {
    const u = await assertSafeDownloadUrl("https://8.8.8.8/x", async () => {
      throw new Error("resolver must not be called for an IP literal");
    });
    expect(u.hostname).toBe("8.8.8.8");
  });
});

describe("assertDeclaredSizeOk", () => {
  it("accepts absent / small / in-range lengths", () => {
    expect(assertDeclaredSizeOk(null)).toBeNull();
    expect(assertDeclaredSizeOk("")).toBeNull();
    expect(assertDeclaredSizeOk("1024")).toBe(1024);
  });
  it("rejects an oversized declared length", () => {
    expect(() => assertDeclaredSizeOk(String(MAX_ATTACHMENT_BYTES + 1))).toThrow(AttachmentSizeError);
  });
});

describe("decodeBase64Capped", () => {
  it("decodes a small payload", () => {
    const b64 = Buffer.from("hello").toString("base64");
    expect(decodeBase64Capped(b64).toString()).toBe("hello");
  });
  it("rejects a payload whose decoded size exceeds the cap", () => {
    // A base64 string longer than 4/3 * cap decodes to > cap bytes.
    const oversized = "A".repeat(MAX_ATTACHMENT_BYTES * 2);
    expect(() => decodeBase64Capped(oversized)).toThrow(AttachmentSizeError);
  });
});
