// HOAI Agent Browser: whose browser this is.
//
// Pure helpers, no Electron and no file system: the stable key of the agent
// behind a session, the Always allow grants a session of that agent starts
// with, and how a new Always allow is recorded for that agent alone. host.js
// wires them; __tests__/profiles.test.js pins them.

"use strict";

const policy = require("./policy");

const MAX_KEY_PART = 64;
const SIGNED_IN_PARTITION_PREFIX = "persist:hoai-agent-browser-signed-in-";
// The one partition every agent shared in the first release. No longer used;
// its logins are not copied into any agent's profile, which would hand every
// agent every login.
const LEGACY_SIGNED_IN_PARTITION = "persist:hoai-agent-browser-signed-in";

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Lower case, [a-z0-9-] only, no leading, trailing or doubled dashes.
function sanitizeKeyPart(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_KEY_PART)
    .replace(/-+$/g, "");
}

// The stable key of the agent behind a session, or null when there is none
// (no id, "unknown"). A session with no key gets no persistent profile and
// keeps no Always allow past itself.
//
// local-mcp.js mints the two kinds of agent id:
//   relay:<assistantId>  the relay door. The backend resolved the assistant
//                        from the daemon's own pairing or API key, so this is
//                        the HOAI assistant itself: "assistant-<id>".
//   <client>@<version>   the loopback door: the MCP client's self reported
//                        name and version. The version is dropped so that a
//                        client update keeps its logins: "client-<name>".
// The two prefixes keep the doors apart: no client name on this machine can
// select an assistant's profile.
function agentProfileKey(agentId) {
  if (typeof agentId !== "string") return null;
  const id = agentId.trim();
  if (!id || id === "unknown") return null;
  if (id.startsWith("relay:")) {
    const digits = id.slice("relay:".length);
    if (!/^\d{1,18}$/.test(digits)) return null;
    const n = digits.replace(/^0+/, "");
    return n ? `assistant-${n}` : null;
  }
  const at = id.lastIndexOf("@");
  const name = sanitizeKeyPart(at > 0 ? id.slice(0, at) : id);
  if (!name || name === "unknown") return null;
  return `client-${name}`;
}

// The persistent partition that holds one agent's signed-in profile (its
// cookies, storage and cache, kept across sessions and app restarts), or null
// when the key is missing or not a sanitized key.
function signedInPartition(key) {
  if (typeof key !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(key)) return null;
  return SIGNED_IN_PARTITION_PREFIX + key;
}

function copyGrants(map) {
  const out = {};
  if (!isPlainObject(map)) return out;
  for (const [origin, grant] of Object.entries(map)) {
    if (isPlainObject(grant)) out[origin] = Object.assign({}, grant);
  }
  return out;
}

// The Always allow grants a session of this agent starts with: the grants of
// the first release (one global map, read as a fallback for every agent and
// never written again) overlaid, origin by origin, by the agent's own.
// Another agent's grants never appear.
function sessionGrants(settings, key) {
  const legacy = copyGrants(settings && settings.alwaysGrants);
  if (!key || !settings || !isPlainObject(settings.agentGrants)) return legacy;
  return Object.assign(legacy, copyGrants(settings.agentGrants[key]));
}

// Record one remembered answer for this agent only. The stored grant is what
// this agent already had on disk (legacy fallback included) plus this one
// answer, never the live session's grants: a write or an upload the owner
// allowed "for this session" must not turn permanent because another gate on
// the same origin got Always allow. Returns the new settings, or null when
// there is nothing to store (no agent key, no origin, or an answer that is
// never remembered, like Allow once, or any answer to a credential gate).
function withRememberedGrant(settings, key, { gate, origin, choice }) {
  if (!key || !origin) return null;
  const stored = sessionGrants(settings, key);
  const applied = policy.applyGateAnswer(stored, { gate, origin, choice });
  if (!applied.allowed || applied.oneShot || !isPlainObject(applied.grants[origin])) return null;
  const agentGrants = isPlainObject(settings.agentGrants) ? Object.assign({}, settings.agentGrants) : {};
  agentGrants[key] = Object.assign(copyGrants(agentGrants[key]), { [origin]: applied.grants[origin] });
  return Object.assign({}, settings, { v: 2, agentGrants });
}

// Always allow on one gate, for this agent alone.
function withAlwaysGrant(settings, key, { gate, origin }) {
  return withRememberedGrant(settings, key, { gate, origin, choice: "always_allow" });
}

// Trust this site: the owner's deliberate "this whole origin is mine", for
// this agent alone. It writes grant.trust and nothing else, so revoking it
// (withoutTrustGrant) puts the origin back exactly where it was.
function withTrustGrant(settings, key, { gate, origin }) {
  return withRememberedGrant(settings, key, { gate, origin, choice: "trust_site" });
}

// Take the trust off one origin for this agent. Returns the new settings, or
// null when this agent does not trust that origin, so a caller can tell the
// owner the difference between "revoked" and "there was nothing to revoke".
//
// It clears the trust in BOTH maps the session reads. The legacy global
// alwaysGrants is never written by this code, but sessionGrants still overlays
// the agent's grants ON it, so a trust that reached it by hand would survive a
// revoke that only touched the agent's map. A revoke that does not revoke is
// the one failure this feature cannot have.
function withoutTrustGrant(settings, key, origin) {
  if (!key || !origin || !isPlainObject(settings)) return null;
  const strip = (map) => {
    if (!isPlainObject(map) || !policy.isTrusted(map[origin])) return null;
    const grant = Object.assign({}, map[origin]);
    delete grant.trust;
    const next = copyGrants(map);
    // A grant that held nothing but the trust goes away with it.
    if (Object.keys(grant).length === 0) delete next[origin];
    else next[origin] = grant;
    return next;
  };
  const mine = strip(isPlainObject(settings.agentGrants) ? settings.agentGrants[key] : null);
  const legacy = strip(settings.alwaysGrants);
  if (!mine && !legacy) return null;
  const out = Object.assign({}, settings, { v: 2 });
  if (mine) {
    out.agentGrants = Object.assign({}, settings.agentGrants, { [key]: mine });
  }
  if (legacy) out.alwaysGrants = legacy;
  return out;
}

// The origins this agent trusts, as a session of it would honour them
// (sessionGrants: the legacy map overlaid by the agent's own). Sorted, so the
// owner's list does not reshuffle between reads.
function trustedOrigins(settings, key) {
  const grants = sessionGrants(settings, key);
  return Object.keys(grants)
    .filter((origin) => policy.isTrusted(grants[origin]))
    .sort();
}

module.exports = {
  SIGNED_IN_PARTITION_PREFIX,
  LEGACY_SIGNED_IN_PARTITION,
  agentProfileKey,
  sanitizeKeyPart,
  signedInPartition,
  sessionGrants,
  withRememberedGrant,
  withAlwaysGrant,
  withTrustGrant,
  withoutTrustGrant,
  trustedOrigins,
};
