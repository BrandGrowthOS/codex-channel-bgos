// HOAI Agent Browser: the owner's settings file, <hoaiDir>/agent-browser.settings.json.
//
// It holds the Always allow grants and the hand edited switches (default
// profile, vision, evaluate, blocked categories). Three rules keep a grant
// from quietly disappearing, each learned from the first release, which lost
// one (docs/learnings/agent-browser-grants-and-logins-must-outlive-the-app.md):
//
//   1. Every change is read, merged and written in one step from the file on
//      disk, never from a snapshot taken at startup, so a second host sharing
//      the folder (the dev harness, a side by side test build) cannot erase a
//      grant the other one wrote.
//   2. Writes go to a temporary file that is flushed and then renamed over the
//      real one, so a crash mid write leaves the old file or the new one,
//      never half of either.
//   3. A file that exists but cannot be parsed is reported and kept aside
//      byte for byte before anything new is written; a file that cannot be
//      read at all is never overwritten. Failures throw to the caller, which
//      logs them: nothing here is swallowed.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const policy = require("./policy");

const SETTINGS_FILE = "agent-browser.settings.json";

function defaultSettings() {
  return {
    v: 1,
    defaultProfile: "preview",
    allowVision: false,
    allowEvaluate: false,
    blockedCategories: policy.DEFAULT_BLOCKED_CATEGORIES,
    alwaysGrants: {},
  };
}

function settingsPath(dir) {
  return path.join(dir, SETTINGS_FILE);
}

// { settings, error, corrupt }. A missing file is the normal first run (no
// error). corrupt means the bytes are there but are not a JSON object.
function readSettings(dir) {
  let text;
  try {
    text = fs.readFileSync(settingsPath(dir), "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { settings: defaultSettings(), error: null, corrupt: false };
    return { settings: defaultSettings(), error: e, corrupt: false };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the file is not a JSON object");
    return { settings: Object.assign(defaultSettings(), parsed), error: null, corrupt: false };
  } catch (e) {
    return { settings: defaultSettings(), error: e, corrupt: true };
  }
}

function writeSettingsAtomic(dir, settings) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = settingsPath(dir);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(settings, null, 2) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

// Read the file as it is on disk now, apply change(settings) to it, write the
// result. Returns { settings, keptAside }: keptAside names the copy of an
// unparseable file that was moved out of the way first, or null.
function updateSettings(dir, change, { now = Date.now } = {}) {
  const read = readSettings(dir);
  if (read.error && !read.corrupt) {
    throw new Error(`could not read ${SETTINGS_FILE} (${read.error.code || read.error.message}), so it was not overwritten`);
  }
  let keptAside = null;
  if (read.corrupt) {
    keptAside = `${settingsPath(dir)}.unreadable-${now()}`;
    fs.renameSync(settingsPath(dir), keptAside);
  }
  const next = change(read.settings);
  writeSettingsAtomic(dir, next);
  return { settings: next, keptAside };
}

module.exports = { SETTINGS_FILE, defaultSettings, settingsPath, readSettings, writeSettingsAtomic, updateSettings };
