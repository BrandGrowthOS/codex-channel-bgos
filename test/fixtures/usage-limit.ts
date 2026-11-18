/**
 * A Codex turn refused by the account's usage limit, as the app server sends
 * it, and the account read that follows it.
 *
 * The message words are the runtime's own: the 0.166.0 binary carries
 * "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro),
 * visit https://chatgpt.com/settings/usage to purchase more credits" and the
 * "or try again at <time>" tail its error display adds. The turn shape is the
 * `TurnError` of `codex app-server generate-ts` (message, codexErrorInfo,
 * additionalDetails, misalignment), the same shape as the probe's 401 turn in
 * image-generation.ts. The account read is `GetAccountRateLimitsResponse`:
 * `resetsAt` is epoch SECONDS, `usedPercent` 0 to 100, and a window of 300
 * minutes is the five hour session window, 10080 the weekly one.
 */

export const USAGE_LIMIT_RAW =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:04 PM.";

/** The refused turn's `turn/completed` params. */
export function usageLimitTurn(
  threadId = "thread-1",
  error: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    threadId,
    turn: {
      id: `turn-${threadId}`,
      items: [],
      itemsView: "notLoaded",
      status: "failed",
      error: {
        message: USAGE_LIMIT_RAW,
        codexErrorInfo: "usageLimitExceeded",
        additionalDetails: null,
        misalignment: null,
        ...error,
      },
      startedAt: 1790224861,
      completedAt: 1790224862,
      durationMs: 1203,
    },
  };
}

interface Window {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

function snapshot(primary: Window | null, secondary: Window | null) {
  return {
    limitId: "codex",
    limitName: null,
    normalModelSlug: null,
    primary,
    secondary,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: "plus",
    rateLimitReachedType: "rate_limit_reached",
  };
}

/**
 * The account read after the refusal. `session` and `weekly` are the two
 * windows; leave one out (null) to read an account that reports only one.
 */
export function rateLimitsRead(opts: {
  session?: Window | null;
  weekly?: Window | null;
}): Record<string, unknown> {
  const rateLimits = snapshot(opts.session ?? null, opts.weekly ?? null);
  return {
    ordinaryUsageAllowed: false,
    rateLimits,
    rateLimitsByLimitId: { codex: rateLimits },
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: { cta_url: "https://chatgpt.com/explore/pro" },
  };
}

export function sessionWindow(usedPercent: number, resetsAt: number | null): Window {
  return { usedPercent, windowDurationMins: 300, resetsAt };
}

export function weeklyWindow(usedPercent: number, resetsAt: number | null): Window {
  return { usedPercent, windowDurationMins: 10080, resetsAt };
}
