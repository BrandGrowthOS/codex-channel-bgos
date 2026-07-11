/**
 * Classify an outbound send failure (contract C3 outbound).
 *
 * Retry (backoff 1s/5s/25s) ONLY for the provably-undelivered network-error
 * class, because the backend message insert is NOT idempotent:
 *   - connection-level errors that fail BEFORE the request reaches the server
 *     (ECONNREFUSED, ENOTFOUND, EAI_AGAIN, EHOSTUNREACH, ENETUNREACH,
 *     socket-hang-up-before-response)
 *   - HTTP 429 (honor Retry-After)
 *
 * Everything else is AMBIGUOUS (the request may have been applied server-side):
 * request timeouts (ECONNABORTED) and 5xx get NO retry, and every other 4xx is
 * a caller error. Ambiguous failures reject to the caller and set a heartbeat
 * lastError, but are never retried or spooled.
 */

const SAFE_CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

export interface OutboundErrorClass {
  retriable: boolean;
  /** When set (429 Retry-After), wait exactly this long instead of backoff. */
  retryAfterMs?: number;
}

interface AxiosLikeError {
  code?: string;
  message?: string;
  response?: { status?: number; headers?: Record<string, unknown> };
}

function parseRetryAfterMs(headers: Record<string, unknown> | undefined):
  | number
  | undefined {
  if (!headers) return undefined;
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  // Numeric seconds form.
  if (/^\d+$/.test(s)) {
    return Number(s) * 1000;
  }
  // HTTP-date form.
  const when = Date.parse(s);
  if (!Number.isNaN(when)) {
    return Math.max(0, when - Date.now());
  }
  return undefined;
}

export function classifyOutboundError(err: unknown): OutboundErrorClass {
  const e = (err ?? {}) as AxiosLikeError;
  const status = e.response?.status;

  // HTTP 429, rate limited, safe to retry, honor Retry-After.
  if (status === 429) {
    return {
      retriable: true,
      retryAfterMs: parseRetryAfterMs(e.response?.headers),
    };
  }

  // Any other HTTP response means the request DID reach the server:
  // 5xx and other 4xx are ambiguous (do not retry).
  if (typeof status === "number") {
    return { retriable: false };
  }

  // No HTTP response, connection-level failure.
  const code = e.code;
  if (code && SAFE_CONNECTION_CODES.has(code)) {
    return { retriable: true };
  }

  // socket hang up before any response bytes: retriable. A hang-up that
  // arrives WITH a response is impossible (no status here), so this only
  // fires pre-response.
  const message = e.message ?? "";
  if (
    code === "ECONNRESET" &&
    /socket hang up/i.test(message)
  ) {
    return { retriable: true };
  }

  // Request timeout (ECONNABORTED) is AMBIGUOUS: the server may have applied
  // the write. No retry.
  return { retriable: false };
}

/** Backoff schedule for the safe class (contract C3). */
export const OUTBOUND_BACKOFFS_MS = [1000, 5000, 25000] as const;
