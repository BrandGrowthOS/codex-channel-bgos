// HOAI Agent Browser: the pure permission policy.
//
// Classifies every tool call the agent makes and decides allow / ask / deny
// from the session profile, the owner's grants and the tool class. This file
// has no Electron or Playwright dependency on purpose: the same rules run in
// the desktop host today and are meant to run on the backend tomorrow, with a
// parity test between the two copies. Keep it deterministic and side-effect
// free; the host owns the UI and the timers.
//
// Design source: docs/superpowers/specs/2026-09-11-hoai-agent-browser-design.md,
// section 7 (permission and safety model).

"use strict";

const SESSION_TOOLS = new Set([
  "hoai_browser_open_session",
  "hoai_browser_close_session",
  "hoai_browser_status",
]);

const READ_TOOLS = new Set([
  "browser_snapshot",
  "browser_find",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
  "browser_network_request",
  "browser_wait_for",
]);

const WRITE_TOOLS = new Set([
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_drag",
  "browser_handle_dialog",
  "browser_navigate_back",
  "browser_resize",
  "browser_close",
  "browser_check",
  "browser_uncheck",
  "browser_press_sequentially",
  "browser_keydown",
  "browser_keyup",
  "browser_reload",
  "browser_highlight",
  "browser_hide_highlight",
  "browser_annotate",
]);

// Tools that ENTER TEXT rather than actuate anything. Typing is inert until
// something submits it, and the something is a click, an Enter or a select,
// all of which are outside this set and gate on their own.
//
// Why the distinction exists, from a real session on 2026-09-21. The `element`
// argument is the AGENT'S OWN free-text description, not the page's label, so
// the sensitive heuristic reads the agent's prose. Typing the same words into
// the same textarea raised a sensitive gate when the agent called it "Media
// playback: Describe permission use field" and no gate at all when it called
// it "Media playback: the long description textarea". Two of two gates in that
// session came from the wording, not from the act, and a sensitive gate is
// never remembered, so the owner was asked again every time.
//
// A word heuristic over an agent's prose is good enough evidence to stop a
// CLICK on "Pay now" and too weak to stop TYPING into a box. Credentials are
// the exception and stay screened everywhere: typing a password IS the act.
const TEXT_ENTRY_TOOLS = new Set(["browser_type", "browser_press_sequentially", "browser_fill_form"]);

const UPLOAD_TOOLS = new Set(["browser_file_upload", "browser_drop"]);
const EVALUATE_TOOLS = new Set(["browser_evaluate"]);
const VISION_TOOLS = new Set([
  "browser_mouse_click_xy",
  "browser_mouse_drag_xy",
  "browser_mouse_move_xy",
  "browser_mouse_down",
  "browser_mouse_up",
  "browser_mouse_wheel",
]);
const PDF_TOOLS = new Set(["browser_pdf_save"]);

// Never reachable through HOAI, whatever the grants say. These either run code
// in the Playwright process, rewrite traffic, or read secrets wholesale.
const NEVER_TOOLS = new Set([
  "browser_run_code_unsafe",
  "browser_route",
  "browser_route_list",
  "browser_unroute",
  "browser_network_state_set",
  "browser_cookie_list",
  "browser_cookie_get",
  "browser_cookie_set",
  "browser_cookie_delete",
  "browser_cookie_clear",
  "browser_storage_state",
  "browser_set_storage_state",
  "browser_localstorage_list",
  "browser_localstorage_get",
  "browser_localstorage_set",
  "browser_localstorage_delete",
  "browser_localstorage_clear",
  "browser_sessionstorage_list",
  "browser_sessionstorage_get",
  "browser_sessionstorage_set",
  "browser_sessionstorage_delete",
  "browser_sessionstorage_clear",
  "browser_install",
  "browser_start_tracing",
  "browser_stop_tracing",
  "browser_start_recording",
  "browser_stop_recording",
  "browser_start_video",
  "browser_stop_video",
  "browser_video_chapter",
  "browser_video_show_actions",
  "browser_video_hide_actions",
  "browser_generate_locator",
  "browser_verify_element_visible",
  "browser_verify_text_visible",
  "browser_verify_list_visible",
  "browser_verify_value",
  "browser_get_config",
  "browser_resume",
]);

const DEFAULT_BLOCKED_CATEGORIES = ["finance", "adult", "piracy"];

// A small, honest category list. It is a floor, not a classifier: owners extend
// it in settings. Hostnames are matched by suffix.
const CATEGORY_HOSTS = {
  finance: [
    "paypal.com",
    "stripe.com",
    "wise.com",
    "revolut.com",
    "coinbase.com",
    "binance.com",
    "kraken.com",
    "robinhood.com",
    "chase.com",
    "bankofamerica.com",
    "wellsfargo.com",
    "hsbc.com",
    "barclays.co.uk",
    "emiratesnbd.com",
    "adcb.com",
    "mashreq.com",
    "fab.ae",
    "interactivebrokers.com",
    "ibkr.com",
  ],
  adult: ["pornhub.com", "xvideos.com", "onlyfans.com"],
  piracy: ["thepiratebay.org", "1337x.to", "rarbg.to"],
};

// Words in the agent's own description of an element that mark an action as
// sensitive. The description is the `element` argument every Playwright action
// tool carries ("Pay now button"), plus typed text for browser_type. Heuristic
// by design; the owner is asked, never silently blocked.
//
// TWO FAMILIES, because one of them is never covered by a trusted site.
// CREDENTIAL_PATTERNS is the family the owner types himself: passwords,
// passcodes, PINs, one time codes, OTP, 2FA, two factor, verification and
// security codes, CVV, card numbers. An action naming one of those is kind
// "credential", it asks every time, and Trust this site does not cover it and
// is not even offered on its gate (gateChoices). SENSITIVE_PATTERNS is
// everything else that deserves an ask on an untrusted site and that a
// deliberate Trust may cover. classifyToolCall tests CREDENTIAL first, which
// matters for the strings that match both families ("Send verification code"
// hits the send pattern and the credential one; "Delete saved passwords" hits
// the delete pattern and the credential one): those are credentials, and the
// safe direction is the narrower, never remembered gate.
//
// FORMS. Every noun matches its plural ("Change permissions", "Manage roles",
// "Payments", "Saved passwords", "Pending invites", "Verification codes") and
// every verb its -s and -ing forms ("Deletes the file", "Sending the invoice").
// Each form is spelled out between word boundaries, so no unrelated word rides
// along: payload, payroll, postal, poster, passport, wireless, sender,
// publisher and roleplay stay ordinary writes. This matters most on a
// pre-approved site, where a form the patterns miss runs with no prompt at
// all. Two kinds of form are left out on purpose, because they label a list or
// a state rather than an action the click performs, and a sensitive gate asks
// every time with only Allow once or Deny: past forms (the Sent folder,
// Deleted items, Shared with me, Published, Paid) and the -s forms of post,
// tweet and reply (the Posts, Tweets and Replies tabs of every social site and
// CMS). A word heuristic cannot tell homographs apart, so "Job posting",
// "Buying guide" and "Wiring diagram" ask too. Pinned in
// __tests__/policy.sensitive-forms.test.js.
const CREDENTIAL_PATTERNS = [
  /\b(passwords?|passcodes?|pin codes?|one[- ]?time codes?|otps?|2fa|two[- ]factor|verification codes?|security codes?|cvvs?|card numbers?)\b/i,
  // The rest of the family, added when trust made the gap silent instead of
  // merely conservative: before a trusted site existed, each of these still
  // raised a write gate and the owner saw it go by.
  /\b(authenticator|sms codes?|text message codes?|backup codes?|recovery codes?|auth codes?|access tokens?|api keys?|secret keys?|private keys?|client secrets?|secrets?|credentials?|security (?:questions?|answers?)|seed phrases?|recovery phrases?|mnemonics?)\b/i,
  // "PIN" on its own is a credential; "Pin" is also the commonest verb in
  // every chat and board UI there is, including this one. The lookahead keeps
  // the noun and drops the verb, so "Enter PIN" asks and "Pin the message"
  // stays an ordinary write. "Pinned" and "Unpin" never match: \b sees to that.
  /\bpins?(?!\s+(?:to|the|it|this|that|these|those|message|messages|chat|chats|post|posts|tab|tabs|board|boards|item|items|card|cards|note|notes|top|here))\b/i,
];

const SENSITIVE_PATTERNS = [
  /\b(pay|pays|paying|payments?|checkouts?|purchas(?:e|es|ing)|buy|buys|buying|plac(?:e|es|ing) orders?|order now|subscrib(?:e|es|ing)|donat(?:e|es|ing)|transfers?|transferring|wir(?:e|es|ing))\b/i,
  /\b(send|sends|sending|post|posting|publish|publishes|publishing|tweet|tweeting|reply|replying|submit(?:s|ting)? applications?|apply now)\b/i,
  /\b(delet(?:e|es|ing)|remov(?:e|es|ing)|eras(?:e|es|ing)|clos(?:e|es|ing) (my )?accounts?|deactivat(?:e|es|ing)|unsubscrib(?:e|es|ing)|cancel(?:s|ling|ing)? subscriptions?)\b/i,
  /\b(permissions?|roles?|shar(?:e|es|ing) with|mak(?:e|es|ing) public|grant(?:s|ing)? access|invit(?:e|es|ing))\b/i,
];

function originOf(url) {
  if (typeof url !== "string" || !url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

function hostOf(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isLocalOrigin(origin) {
  const host = hostOf(origin);
  if (!host) return false;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".localhost")
  );
}

function isPrivateNetworkOrigin(origin) {
  const host = hostOf(origin);
  if (!host) return false;
  if (isLocalOrigin(origin)) return false;
  // RFC1918 and link-local, plus the .local and .internal suffixes.
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(host)) return true;
  if (/^0\.0\.0\.0$/.test(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  return false;
}

function categoryOf(origin, blockedCategories = DEFAULT_BLOCKED_CATEGORIES) {
  const host = hostOf(origin);
  if (!host) return null;
  for (const category of blockedCategories) {
    const hosts = CATEGORY_HOSTS[category] || [];
    for (const suffix of hosts) {
      if (host === suffix || host.endsWith("." + suffix)) return category;
    }
  }
  return null;
}

// How much typed text is screened. Text is only ever READ here, never logged
// or summarised (summarizeToolCall deliberately carries none of it), so the
// bound exists to keep a pathological paste cheap to scan, not to protect
// anything. It was 200, which meant a password after a long preamble was
// invisible to the screen.
const SCREENED_TEXT_MAX = 2000;

// Everything the agent said about what it is touching: the element
// description, the text it is typing, and the names AND VALUES of the form
// fields it is filling. One builder, so the two predicates below screen the
// same words.
//
// Only reached from the WRITE_TOOLS branch of classifyToolCall, so `text` here
// is always text being typed into the page: browser_type and
// browser_press_sequentially both carry it, and screening it for one tool and
// not the other let "my password is ..." through press_sequentially. A form
// field's VALUE is screened for the same reason: a field the page named
// "Field 3" says nothing, and what is being typed into it says everything.
function screenedText(name, args = {}) {
  const parts = [];
  if (typeof args.element === "string") parts.push(args.element);
  if (typeof args.text === "string") parts.push(args.text.slice(0, SCREENED_TEXT_MAX));
  if (Array.isArray(args.fields)) {
    for (const f of args.fields) {
      if (!f) continue;
      if (typeof f.name === "string") parts.push(f.name);
      if (typeof f.value === "string") parts.push(f.value.slice(0, SCREENED_TEXT_MAX));
    }
  }
  if (typeof args.startElement === "string") parts.push(args.startElement);
  if (typeof args.endElement === "string") parts.push(args.endElement);
  return parts.join(" \n ");
}

// Drop the word a negation governs, so a description that says an action does
// NOT do the sensitive thing stops reading as the sensitive thing. From a real
// session on 2026-09-21: an agent described a button as "Save, does not send
// for review", the word "send" matched, and clicking Save raised a sensitive
// gate that is never remembered, so it asked again every time.
//
// It removes exactly one word after the negation, which is the verb the
// negation applies to. It is deliberately NOT applied to the credential
// family: "will not show password" still reads as a password, because that
// promise is not one a turn of phrase should be able to talk its way out of.
//
// This is not a defence against a hostile agent, and it is not weakened by
// being one: an agent that wants to dodge the heuristic can already call a Pay
// button "the blue one". The heuristic serves an HONEST agent's wording, and
// an honest agent's negation means what it says.
const NEGATIONS = /\b(?:does not|doesn't|do not|don't|did not|didn't|will not|won't|would not|wouldn't|shall not|should not|shouldn't|cannot|can't|is not|isn't|are not|aren't|never|without)\s+\S+/gi;

function withoutNegations(haystack) {
  return haystack.replace(NEGATIONS, " ");
}

// The family the owner types himself. Never remembered, never covered by a
// trusted site, on any origin, whatever the grants say.
function isCredential(name, args = {}) {
  const haystack = screenedText(name, args);
  if (!haystack) return false;
  return CREDENTIAL_PATTERNS.some((re) => re.test(haystack));
}

// A consequential action in the narrower sense: everything the owner should be
// asked about on an untrusted site that a deliberate Trust may later cover.
function isActionSensitive(name, args = {}) {
  const haystack = withoutNegations(screenedText(name, args));
  if (!haystack.trim()) return false;
  return SENSITIVE_PATTERNS.some((re) => re.test(haystack));
}

// Sensitive in the wide sense: credentials included. This is what the
// pre-approved-site rules and the older tests mean by "sensitive".
function isSensitive(name, args = {}) {
  return isCredential(name, args) || isActionSensitive(name, args);
}

// Classify a tool call. `context.currentOrigin` is the origin of the active
// tab, used for write actions; navigation takes its origin from the URL.
function classifyToolCall(name, args = {}, context = {}) {
  const currentOrigin = context.currentOrigin || null;
  if (SESSION_TOOLS.has(name)) return { kind: "session", origin: null };
  if (NEVER_TOOLS.has(name)) return { kind: "never", origin: null };
  if (name === "browser_navigate") {
    const origin = originOf(args.url);
    return { kind: "navigate", origin, invalidUrl: origin === null };
  }
  if (name === "browser_tabs") {
    const action = args.action;
    if (action === "list") return { kind: "read", origin: currentOrigin };
    if (action === "new") {
      if (args.url) {
        const origin = originOf(args.url);
        return { kind: "navigate", origin, invalidUrl: origin === null };
      }
      return { kind: "write", origin: currentOrigin };
    }
    return { kind: "write", origin: currentOrigin };
  }
  if (READ_TOOLS.has(name) || PDF_TOOLS.has(name)) return { kind: "read", origin: currentOrigin };
  if (UPLOAD_TOOLS.has(name)) return { kind: "upload", origin: currentOrigin };
  if (EVALUATE_TOOLS.has(name)) return { kind: "evaluate", origin: currentOrigin };
  if (VISION_TOOLS.has(name)) return { kind: "vision", origin: currentOrigin };
  if (WRITE_TOOLS.has(name)) {
    // Credential first: a string in both families is a credential, which is
    // the narrower gate and the one Trust this site never covers. This runs
    // for every write tool, text entry included: typing a password is the act.
    if (isCredential(name, args)) return { kind: "credential", origin: currentOrigin };
    // Text entry does not escalate on the agent's wording alone. `submit` is
    // the exception the tool itself declares: browser_type with submit:true
    // presses Enter when it is done, which actuates, so it is judged like a
    // click. See TEXT_ENTRY_TOOLS for the session that prompted this.
    const entersTextOnly = TEXT_ENTRY_TOOLS.has(name) && args.submit !== true;
    return {
      kind: !entersTextOnly && isActionSensitive(name, args) ? "sensitive" : "write",
      origin: currentOrigin,
    };
  }
  // Unknown tool names are treated as writes: the conservative reading.
  return { kind: "write", origin: currentOrigin, unknownTool: true };
}

// ─── Pre-approved sites ────────────────────────────────────────────────────
// The owner's per-agent list of origins an agent opens without a permission
// request (assistants.browser_allowed_sites, edited in the app, pushed into
// the host by the renderer). THE THIRD COPY of the rule: the backend's
// (backend/src/services/browser-allowed-sites.ts) is the authority on what is
// stored, the app's (frontend/expo-app/src/agent-browser/browserAllowedSites.ts)
// validates the editor, and all three run ONE case table,
// backend/src/services/browser-allowed-sites.cases.json. The same hand-written
// grammar everywhere, no URL parser: exactly https://host or https://host:port,
// lowercased, default port and one trailing slash dropped, no path, query,
// fragment or credentials, ASCII host labels only. EXACT ORIGINS ONLY: a * is
// refused (has_wildcard), so a *.domain entry that reached this host anyway is
// dropped by sanitizeAllowedSites and matches nothing here. On a public suffix
// or a multi-tenant host (*.co.uk, *.sharepoint.com, *.vercel.app) such an
// entry would pre-approve subdomains anyone can register, and with them a
// page's injected instruction to navigate there.
//
// What a listed origin satisfies: the navigate gate and the write gate, and
// nothing else. decide() below keeps every hard deny (private network, blocked
// categories, the owner's own Deny) ahead of it, and never consults it for a
// sensitive action, an upload, evaluate, a vision click (a coordinate cannot
// be screened for a sensitive action) or a tool it does not know. Downloads
// are the host's will-download handler, which never consults it either.

const ALLOWED_SITES_MAX = 50;
const ALLOWED_SITE_MAX_LENGTH = 300;
const ALLOWED_HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// One owner-typed site, to its canonical form: { ok: true, site } or
// { ok: false, reason }, the reasons the backend returns.
function parseAllowedSite(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "not_a_string" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed.length > ALLOWED_SITE_MAX_LENGTH) return { ok: false, reason: "too_long" };
  const lowered = trimmed.toLowerCase();
  if (!lowered.startsWith("https://")) return { ok: false, reason: "not_https" };
  let rest = lowered.slice("https://".length);
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  if (/[/?#]/.test(rest)) return { ok: false, reason: "has_path" };
  if (rest.includes("@")) return { ok: false, reason: "has_credentials" };
  if (rest.includes("*")) return { ok: false, reason: "has_wildcard" };
  let host = rest;
  let port = "";
  const colon = rest.lastIndexOf(":");
  if (colon !== -1) {
    host = rest.slice(0, colon);
    const digits = rest.slice(colon + 1);
    if (!/^[0-9]{1,5}$/.test(digits)) return { ok: false, reason: "invalid_host" };
    const n = Number(digits);
    if (n < 1 || n > 65535) return { ok: false, reason: "invalid_host" };
    port = n === 443 ? "" : String(n);
  }
  if (host.length > 253 || !ALLOWED_HOSTNAME_RE.test(host)) return { ok: false, reason: "invalid_host" };
  return { ok: true, site: `https://${host}${port ? `:${port}` : ""}` };
}

// A pushed list, reduced to valid canonical entries (deduped, capped). Never
// repairs or widens an entry: one that fails the rule is dropped.
function sanitizeAllowedSites(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    const parsed = parseAllowedSite(entry);
    if (parsed.ok && !out.includes(parsed.site)) out.push(parsed.site);
    if (out.length >= ALLOWED_SITES_MAX) break;
  }
  return out;
}

// Does one pattern cover a page origin (originOf's WHATWG origin: lowercase,
// punycode, default port dropped)? Exactly that origin: never a subdomain,
// another port or http. An invalid pattern, a wildcard included, matches
// nothing.
function allowedSiteMatches(pattern, origin) {
  const parsed = parseAllowedSite(pattern);
  if (!parsed.ok || typeof origin !== "string") return false;
  return origin.toLowerCase() === parsed.site;
}

function isPreapproved(origin, patterns) {
  if (!origin || !Array.isArray(patterns) || patterns.length === 0) return false;
  return patterns.some((p) => allowedSiteMatches(p, origin));
}

function grantFor(grants, origin) {
  if (!grants || !origin) return null;
  return grants[origin] || null;
}

// True for a tool that can stop and ask the owner: every tool but the session
// tools, the pure reads and the never-exposed set. These are the tools whose
// input schema carries wait_seconds (local-mcp.js withWaitSeconds).
function mayRaiseGate(name) {
  const kind = classifyToolCall(name, {}).kind;
  return kind !== "session" && kind !== "read" && kind !== "never";
}

// THE ONE CHOICE FUNCTION. The pane (ui/pane.html), the rail (the app's
// AgentBrowserRail through the gate document the host sends) and the chat card
// (the backend writes the card's buttons from this list) all read the choices
// a gate offers from here, so the three surfaces cannot disagree again (the
// pane and the rail's own model did, on sensitive actions, until 2026-09-14).
//
// Canon: Allow once, Allow for this session, Always allow, Trust this site,
// Deny.
//   trust_site: the widest answer there is, and the reason it has its own
//              button rather than riding on Always allow. Always allow answers
//              ONE gate for one origin (navigate, or writes, or uploads); the
//              owner then gets asked again at the first gate of the next kind,
//              and forever at every sensitive one, because a sensitive gate
//              remembers nothing. Trust this site answers the SITE: every kind
//              of gate on that origin for this agent, until the owner revokes
//              it. It is never a side effect of any other answer
//              (applyGateAnswer sets grant.trust for this choice alone).
//   sensitive: Allow once, Trust this site, or Deny. Still no "for this
//              session" and no "Always allow": a session grant on a sensitive
//              action covers exactly one call (applyGateAnswer), so offering
//              either would be a lie. Trust is the honest way to stop being
//              asked, and it says plainly that it covers the whole site.
//   credential: Allow once or Deny, and nothing else, ever. A password, a
//              passcode, an OTP, a 2FA or verification code, a CVV or a card
//              number is the one thing the owner types himself, so Trust this
//              site is not offered here and does not cover it (decide).
//   download:  no Always allow, as before: nothing about a download is
//              remembered across sessions BY THAT ANSWER. Trust this site is
//              offered, and a trusted origin does cover its downloads, because
//              the owner said the whole site is his.
//   unknown:   the tightest set, never the widest.
const GATE_CHOICE_ORDER = ["allow_once", "allow_session", "always_allow", "trust_site", "deny"];
function gateChoices(kind) {
  switch (kind) {
    case "navigate":
    case "write":
    case "upload":
    case "evaluate":
      return [...GATE_CHOICE_ORDER];
    case "download":
      return ["allow_once", "allow_session", "trust_site", "deny"];
    case "sensitive":
      return ["allow_once", "trust_site", "deny"];
    case "credential":
    default:
      return ["allow_once", "deny"];
  }
}

// ─── Trusted sites ─────────────────────────────────────────────────────────
// The owner's deliberate "this whole site is mine" for one origin and one
// agent, recorded as grant.trust === "allow" and persisted beside the Always
// allow grants (profiles.withTrustGrant). What it covers and what still beats
// it, in one place so no branch of decide() can quietly widen it:
//
//   BEATEN BY, always: the owner's own Deny on the origin, a private network
//   origin, a blocked category, the vision and evaluate kill switches, and the
//   never-exposed tool set. Those are checked before trust is consulted and
//   again inside trustCovers, so a trust written before a category was blocked
//   cannot outlive the block.
//
//   NOT COVERED: a credential action, on any origin (see CREDENTIAL_PATTERNS),
//   and an unknown tool, for the same reason the pre-approved list refuses one:
//   a tool the policy cannot name is a tool it cannot screen for a credential,
//   so the carve-out above would be unenforceable on it.
//
//   COVERED: navigate, write, sensitive, upload, evaluate, download, and a
//   vision click when the owner has vision switched on.
// THE ONE READING OF "TRUSTED". host.js and profiles.js call this too, rather
// than spelling the field test out again: the pane and the rail once drifted
// apart on sensitive actions for exactly that reason, and the learning
// (docs/learnings/agent-browser-gate-card.md) says to keep the rule at the
// producer.
function isTrusted(grant) {
  return !!grant && grant.trust === "allow";
}

function trustCovers(origin, grant, blockedCategories) {
  if (!origin || !isTrusted(grant)) return false;
  if (grant.access === "deny") return false;
  if (isPrivateNetworkOrigin(origin)) return false;
  if (categoryOf(origin, blockedCategories)) return false;
  return true;
}

// Decide allow / ask / deny. Returns { verdict, gate?, reason }, plus
// preapprovedGate ("navigate" | "write") when the owner's pre-approved list is
// what let it through (reason "preapproved"), so the host can log it.
//   profile: "preview" | "signed-in"
//   classification: from classifyToolCall
//   grants: { [origin]: { access, write, downloads, uploads, evaluate, trust } }
//           merged (session grants over always grants; the host merges before
//           calling). `trust` is the owner's deliberate Trust this site.
//   settings: { allowVision, allowEvaluate, blockedCategories }
//   preapproved: the calling agent's pre-approved sites, or nothing. The host
//           passes a list ONLY for a verified calling assistant.
function decide({ profile, classification, grants, settings, preapproved }) {
  const s = Object.assign(
    { allowVision: false, allowEvaluate: false, blockedCategories: DEFAULT_BLOCKED_CATEGORIES },
    settings || {},
  );
  const { kind, origin } = classification;
  const grant = grantFor(grants, origin);
  const signedIn = profile === "signed-in";

  if (kind === "session" || kind === "read") return { verdict: "allow", reason: kind };
  if (kind === "never") return { verdict: "deny", reason: "not_exposed" };

  // THE HARD DENIES, for every kind and not only for navigation. These used to
  // sit inside the navigate branch alone, so an agent already on a blocked
  // category page (a redirect, a popup, a session that started before the
  // owner blocked it) could still raise a write, upload, sensitive or download
  // gate there, and the owner could answer Allow once. Trust never beat them,
  // but "blocked" ought to mean blocked. An origin the policy cannot read
  // (null, an invalid navigate URL) matches neither and falls through to its
  // branch as before.
  if (isPrivateNetworkOrigin(origin)) return { verdict: "deny", reason: "private_network" };
  const blockedCategory = categoryOf(origin, s.blockedCategories);
  if (blockedCategory) return { verdict: "deny", reason: "blocked_category", category: blockedCategory };

  // The owner's deliberate Trust for this origin, already checked against
  // everything that beats it. Consulted inside each branch below, always
  // after that branch's own denies.
  const trusted = trustCovers(origin, grant, s.blockedCategories);

  if (kind === "navigate") {
    if (classification.invalidUrl) return { verdict: "deny", reason: "invalid_url" };
    if (isLocalOrigin(origin) && !signedIn) return { verdict: "allow", reason: "localhost_preview" };
    if (grant && grant.access === "deny") return { verdict: "deny", reason: "denied_by_owner" };
    if (grant && grant.access === "allow") return { verdict: "allow", reason: "granted" };
    if (trusted) return { verdict: "allow", reason: "trusted_site", trustedOrigin: origin };
    if (isPreapproved(origin, preapproved)) return { verdict: "allow", reason: "preapproved", preapprovedGate: "navigate" };
    return { verdict: "ask", gate: "navigate", reason: "new_origin" };
  }

  if (kind === "vision" && !s.allowVision) return { verdict: "deny", reason: "vision_disabled" };

  if (kind === "write" || kind === "vision") {
    if (!origin) return { verdict: "allow", reason: "no_page" };
    if (grant && grant.access === "deny") return { verdict: "deny", reason: "denied_by_owner" };
    // The list covers element-described writes only: a vision click is a
    // coordinate and an unknown tool is unknown, so neither can be screened
    // for a sensitive action, and the list never waves them through.
    const listed = kind === "write" && !classification.unknownTool && isPreapproved(origin, preapproved);
    // Trust covers a vision click (the owner had to switch vision on first)
    // but NOT an unknown tool, for the pre-approved list's own reason: a tool
    // the policy cannot name cannot be screened for a credential, so the
    // credential carve-out could not be honoured on it.
    const trustedHere = trusted && !classification.unknownTool;
    if (!signedIn) {
      if (isLocalOrigin(origin)) return { verdict: "allow", reason: "localhost_preview" };
      if (grant && grant.access === "allow") return { verdict: "allow", reason: "granted" };
      if (trustedHere) return { verdict: "allow", reason: "trusted_site", trustedOrigin: origin };
      if (listed) return { verdict: "allow", reason: "preapproved", preapprovedGate: "navigate" };
      return { verdict: "ask", gate: "navigate", reason: "origin_not_granted" };
    }
    if (grant && grant.write === "allow") return { verdict: "allow", reason: "write_granted" };
    if (trustedHere) return { verdict: "allow", reason: "trusted_site", trustedOrigin: origin };
    if (listed) return { verdict: "allow", reason: "preapproved", preapprovedGate: "write" };
    return { verdict: "ask", gate: "write", reason: "signed_in_write" };
  }

  if (kind === "sensitive") {
    if (grant && grant.access === "deny") return { verdict: "deny", reason: "denied_by_owner" };
    if (trusted) return { verdict: "allow", reason: "trusted_site", trustedOrigin: origin };
    return { verdict: "ask", gate: "sensitive", reason: "sensitive_action" };
  }

  // A password, a passcode, an OTP, a 2FA or verification code, a CVV or a
  // card number. The owner types these himself, so this asks on every origin,
  // trusted or not, pre-approved or not, and its gate offers Allow once or
  // Deny and nothing else (gateChoices).
  if (kind === "credential") {
    if (grant && grant.access === "deny") return { verdict: "deny", reason: "denied_by_owner" };
    return { verdict: "ask", gate: "credential", reason: "credential_action" };
  }

  if (kind === "upload") {
    // The owner's Deny on the origin outranks an older per-kind allow, the way
    // it does on every other kind. It did not, and "Deny beats everything" was
    // quietly false here.
    if (grant && grant.access === "deny") return { verdict: "deny", reason: "denied_by_owner" };
    if (grant && grant.uploads === "deny") return { verdict: "deny", reason: "upload_denied" };
    if (grant && grant.uploads === "allow") return { verdict: "allow", reason: "upload_granted" };
    if (trusted) return { verdict: "allow", reason: "trusted_site", trustedOrigin: origin };
    return { verdict: "ask", gate: "upload", reason: "upload" };
  }

  if (kind === "evaluate") {
    if (!s.allowEvaluate) return { verdict: "deny", reason: "evaluate_disabled" };
    if (grant && grant.access === "deny") return { verdict: "deny", reason: "denied_by_owner" };
    if (grant && grant.evaluate === "allow") return { verdict: "allow", reason: "evaluate_granted" };
    if (trusted) return { verdict: "allow", reason: "trusted_site", trustedOrigin: origin };
    return { verdict: "ask", gate: "evaluate", reason: "evaluate" };
  }

  // A file the page started downloading. The host used to read the grant
  // field by field here (host.js _onDownload); it now asks this function, so
  // Deny and Trust mean the same thing for a download as for everything else.
  if (kind === "download") {
    if (grant && grant.access === "deny") return { verdict: "deny", reason: "denied_by_owner" };
    if (grant && grant.downloads === "deny") return { verdict: "deny", reason: "download_denied" };
    if (grant && grant.downloads === "allow") return { verdict: "allow", reason: "download_granted" };
    if (trusted) return { verdict: "allow", reason: "trusted_site", trustedOrigin: origin };
    return { verdict: "ask", gate: "download", reason: "download" };
  }

  return { verdict: "ask", gate: "write", reason: "unclassified" };
}

// Apply an owner's answer to a gate. Returns { grants, oneShot } where grants
// is a NEW object (the input is never mutated) and oneShot is true when the
// answer covered only this call.
//
// TRUST IS DELIBERATE. grant.trust is set by choice "trust_site" and by
// nothing else: not by Always allow, not by Allow for this session, on any
// gate. An owner who waves through one navigate or one write has not trusted
// the site, and a test pins that for every gate kind. The reverse also holds:
// Trust this site sets `trust` alone, so revoking it (profiles.withoutTrust)
// puts the origin back to asking instead of leaving a half-grant behind.
function applyGateAnswer(grants, { gate, origin, choice }) {
  const next = Object.assign({}, grants || {});
  const current = Object.assign({}, next[origin] || {});
  if (choice === "deny") {
    if (origin) next[origin] = Object.assign(current, { access: "deny" });
    return { grants: next, oneShot: false, allowed: false };
  }
  if (choice === "allow_once") return { grants: next, oneShot: true, allowed: true };
  if (choice === "trust_site") {
    // THE SECOND BELT. gateChoices never offers Trust on a credential gate and
    // host.answerGate refuses an answer outside a gate's own list, but every
    // other never-remembered rule here is enforced twice, and this one is the
    // rule the whole feature rests on. A credential is never remembered, by
    // any answer, on any origin.
    if (gate === "credential") return { grants: next, oneShot: true, allowed: true };
    // A gate with no origin has no site to trust, so this covers the one call.
    if (!origin) return { grants: next, oneShot: true, allowed: true };
    current.trust = "allow";
    next[origin] = current;
    return { grants: next, oneShot: false, allowed: true };
  }
  if (choice !== "allow_session" && choice !== "always_allow") {
    return { grants: next, oneShot: false, allowed: false };
  }
  if (!origin) return { grants: next, oneShot: true, allowed: true };
  if (gate === "navigate") current.access = "allow";
  if (gate === "write") {
    current.access = "allow";
    current.write = "allow";
  }
  if (gate === "upload") {
    current.access = current.access || "allow";
    current.uploads = "allow";
  }
  if (gate === "evaluate") {
    current.access = current.access || "allow";
    current.evaluate = "allow";
  }
  // A download is remembered as a download grant and nothing more: the file
  // often comes from a host the agent never navigates to. The grant is real
  // (the host's will-download handler reads grant.downloads); it used to fall
  // through with nothing set, so "Allow for this session" on a download
  // silently behaved as "once".
  if (gate === "download") current.downloads = "allow";
  // A sensitive or credential action is never remembered by these answers:
  // "always allow" is not offered for either, and even "allow for this
  // session" only covers this one call. The way to stop being asked on a
  // sensitive action is Trust this site, handled above; there is no way to
  // stop being asked on a credential one, by design.
  if (gate === "sensitive" || gate === "credential") return { grants: next, oneShot: true, allowed: true };
  next[origin] = current;
  return { grants: next, oneShot: false, allowed: true };
}

function summarizeToolCall(name, args = {}) {
  const el = typeof args.element === "string" ? args.element : "";
  switch (name) {
    case "browser_navigate":
      return `Opened ${args.url || ""}`.trim();
    case "browser_navigate_back":
      return "Went back";
    case "browser_click":
      return `Clicked ${el || "an element"}`;
    case "browser_type":
      return `Typed in ${el || "a field"}`;
    case "browser_fill_form":
      return `Filled ${Array.isArray(args.fields) ? args.fields.length : "some"} form fields`;
    case "browser_select_option":
      return `Selected ${Array.isArray(args.values) ? args.values.join(", ") : ""} in ${el || "a dropdown"}`;
    case "browser_press_key":
      return `Pressed ${args.key || "a key"}`;
    case "browser_hover":
      return `Hovered ${el || "an element"}`;
    case "browser_snapshot":
      return "Read the page";
    case "browser_find":
      return `Looked for ${args.text || args.regex || ""}`.trim();
    case "browser_take_screenshot":
      return "Took a screenshot";
    case "browser_wait_for":
      return args.text ? `Waited for "${args.text}"` : args.textGone ? `Waited for "${args.textGone}" to go` : `Waited ${args.time || ""}s`;
    case "browser_tabs":
      return `Tabs: ${args.action || "list"}`;
    case "browser_handle_dialog":
      return args.accept ? "Accepted a dialog" : "Dismissed a dialog";
    case "browser_file_upload":
      return "Uploaded a file";
    case "browser_evaluate":
      return "Ran a script";
    case "browser_pdf_save":
      return "Saved a PDF";
    case "browser_console_messages":
      return "Read the console";
    case "browser_network_requests":
    case "browser_network_request":
      return "Read network requests";
    case "browser_resize":
      return `Resized to ${args.width}x${args.height}`;
    default:
      return name.replace(/^browser_/, "").replace(/_/g, " ");
  }
}

// ─── The truthful trail ────────────────────────────────────────────────────
// A call that did not run must never read as done. summarizeToolCall above is
// the SUCCESS wording ("Opened https://example.com/help") and stays exactly as
// it is; everything else composes its sentence here, over the intent phrase
// the gate strip prints after "Data wants to". Spec: docs/superpowers/specs/
// 2026-09-24-p3-browsing-card-design.md, decision 6.

// The bare imperative of a tool call, lower case, carrying nothing the agent
// typed (the same rule as summarizeToolCall: no text, no values of a form).
function imperativeOf(name, args = {}) {
  const a = args || {};
  const el = typeof a.element === "string" ? a.element : "";
  switch (name) {
    case "browser_navigate":
      return `open ${a.url || "an address"}`;
    case "browser_navigate_back":
      return "go back";
    case "browser_click":
      return `click ${el || "an element"}`;
    case "browser_type":
      return `type in ${el || "a field"}`;
    case "browser_fill_form":
      return `fill ${Array.isArray(a.fields) ? a.fields.length : "some"} form fields`;
    case "browser_select_option":
      return `select ${Array.isArray(a.values) ? a.values.join(", ") : ""} in ${el || "a dropdown"}`;
    case "browser_press_key":
      return `press ${a.key || "a key"}`;
    case "browser_hover":
      return `hover ${el || "an element"}`;
    case "browser_snapshot":
      return "read the page";
    case "browser_find":
      return `look for ${a.text || a.regex || "something"}`;
    case "browser_take_screenshot":
      return "take a screenshot";
    case "browser_wait_for":
      return a.text ? `wait for "${a.text}"` : a.textGone ? `wait for "${a.textGone}" to go` : `wait ${a.time || ""}s`;
    case "browser_tabs":
      if (a.action === "new") return "open a new tab";
      if (a.action === "close") return "close a tab";
      if (a.action === "select") return "switch tabs";
      return "list the tabs";
    case "browser_handle_dialog":
      return a.accept ? "accept a dialog" : "dismiss a dialog";
    case "browser_file_upload":
      return "upload a file";
    case "browser_evaluate":
      return "run a script";
    case "browser_pdf_save":
      return "save a PDF";
    case "browser_console_messages":
      return "read the console";
    case "browser_network_requests":
    case "browser_network_request":
      return "read network requests";
    case "browser_resize":
      return `resize to ${a.width}x${a.height}`;
    default:
      return String(name || "").replace(/^browser_/, "").replace(/_/g, " ");
  }
}

// The intent phrase: the imperative the gate strip prints after "Data wants
// to", and the one the trail's "Not done" and "Failed" rows repeat, so the
// owner reads the same words at the gate and in the record. The host builds
// the strip's summary with this function (host.js callTool), so the two
// cannot drift.
//   context.kind: the gate the call raised, or the call's classification
//                 kind when it raised none. A NAVIGATE gate names the origin
//                 alone (the grant it asks for is per origin, and a path or a
//                 query is never repeated into a gate or a stored sentence),
//                 including the navigate gate a preview write raises on a
//                 page's origin. Anything else names the action and the host.
//   context.origin: the classification's origin (the URL's for a navigation,
//                 the active tab's for everything else).
function intentPhrase(name, args = {}, context = {}) {
  const a = args || {};
  const ctx = context || {};
  const kind = ctx.kind || classifyToolCall(name, a, { currentOrigin: ctx.origin || null }).kind;
  if (kind === "navigate") {
    const origin = ctx.origin !== undefined && ctx.origin !== null ? ctx.origin : originOf(a.url);
    if (origin) return `open ${origin}`;
    const raw = typeof a.url === "string" ? a.url.trim() : "";
    return `open ${raw || "an address"}`;
  }
  // The host with its port, as the strip has always printed it
  // ("127.0.0.1:8823"); "this page" when there is none.
  let where = "";
  try {
    where = ctx.origin ? new URL(ctx.origin).host : "";
  } catch {}
  return `${imperativeOf(name, a)} on ${where || "this page"}`;
}

// The trail sentence for a call, by what happened to it.
//   outcome: "ok" (or nothing) keeps today's success wording; "denied" and
//            "error" never read as done.
//   reason:  the host's reason code (decide()'s, or the gate's
//            denied_by_owner, gate_timeout, session_closed).
//   atGate:  true when the owner's "no" was an answer at the gate, false for
//            a saved "no" the policy applied outright.
//   intent:  the phrase to repeat; built with intentPhrase when absent.
//   kind, origin: the call's classification. Only the private network row
//            reads them: a navigation keeps "open http://10.0.0.5 is a
//            private network address", any other call names its action and
//            then the host ("click Submit on 10.0.0.5, 10.0.0.5 is a private
//            network address"), because "click Submit on 10.0.0.5 is a
//            private network address" says the click is the address.
function summarizeOutcome(name, args = {}, { outcome, reason, category, intent, atGate, kind, origin } = {}) {
  if (!outcome || outcome === "ok") return summarizeToolCall(name, args || {});
  const what = intent || intentPhrase(name, args, { kind, origin });
  if (outcome !== "denied") return `Failed: ${what}`;
  switch (reason) {
    case "denied_by_owner":
      return atGate ? `Not done, you said no: ${what}` : `Not done, you said no to this site before: ${what}`;
    case "gate_timeout":
      return `Not done, nobody answered: ${what}`;
    case "session_closed":
      return `Not done, the session closed first: ${what}`;
    case "private_network": {
      const navigates = (kind || classifyToolCall(name, args || {}).kind) === "navigate";
      if (navigates) return `Not done, blocked: ${what} is a private network address`;
      return `Not done, blocked: ${what}, ${hostWithPort(origin) || "this page"} is a private network address`;
    }
    case "blocked_category":
      return category ? `Not done, blocked: ${what}, ${category} sites are blocked` : `Not done, blocked: ${what}`;
    case "invalid_url":
      return `Not done, the address is not valid: ${what}`;
    // not_exposed, vision_disabled, evaluate_disabled, upload_denied and any
    // reason added later: a tool or an act the owner has not allowed.
    default:
      return `Not done, not allowed: ${what}`;
  }
}

// The host with its port, as the strip prints it ("127.0.0.1:8823"), or "".
function hostWithPort(origin) {
  try {
    return origin ? new URL(origin).host : "";
  } catch {
    return "";
  }
}

// The trail row for the owner's answer at a gate, in plain words (the ledger's
// decision on the slice (a) review). One row per answer, never the machine
// code ("Allowed (allow session): ..."):
//   an allow on a navigation names the site, as the mockup's trail does:
//     "You allowed status.acmehosting.com for this session";
//   an allow on anything else names the action: "You allowed this once:
//     click Pay AED 120 button on 127.0.0.1:8823";
//   a deny returns null: the held action writes its own "Not done, you said
//     no" row, and the host writes that same sentence for a gate that holds
//     no action, so a deny is one row, not two;
//   Trust this site returns null: the trust row that follows says it.
const ANSWER_SCOPES = { allow_once: "once", allow_session: "for this session", always_allow: "from now on" };
function gateAnswerSummary(gate, choice) {
  const scope = ANSWER_SCOPES[choice];
  if (!scope) return null;
  const g = gate || {};
  const site = g.kind === "navigate" ? hostWithPort(g.origin) : "";
  if (site) return `You allowed ${site} ${scope}`;
  return `You allowed this ${scope}: ${g.summary || "this action"}`;
}

// The closing row, keyed on the session's end reason. The same six endings
// the rail names (agentBrowserPaneModel endReasonLabel), in the trail's own
// sentence case. Anything else (a dev close, a reason added later) reads as
// the agent's plain close, never as a code in brackets.
const CLOSING_ROWS = {
  closed_by_agent: "Closed browser",
  stopped_by_owner: "Stopped by you",
  idle_timeout: "Closed after 30 minutes idle",
  hard_timeout: "Closed at the 4 hour limit",
  window_closed: "Closed with the window",
  app_quit: "Closed with the window",
  start_failed: "The browser could not start",
};
function closingRowSummary(endReason) {
  return Object.prototype.hasOwnProperty.call(CLOSING_ROWS, endReason) ? CLOSING_ROWS[endReason] : CLOSING_ROWS.closed_by_agent;
}

module.exports = {
  DEFAULT_BLOCKED_CATEGORIES,
  NEVER_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
  SESSION_TOOLS,
  originOf,
  isLocalOrigin,
  isPrivateNetworkOrigin,
  categoryOf,
  isSensitive,
  isActionSensitive,
  isCredential,
  isTrusted,
  trustCovers,
  classifyToolCall,
  decide,
  applyGateAnswer,
  summarizeToolCall,
  summarizeOutcome,
  intentPhrase,
  closingRowSummary,
  gateAnswerSummary,
  mayRaiseGate,
  gateChoices,
  GATE_CHOICE_ORDER,
  ALLOWED_SITES_MAX,
  parseAllowedSite,
  sanitizeAllowedSites,
  allowedSiteMatches,
  isPreapproved,
};
