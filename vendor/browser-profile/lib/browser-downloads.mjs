/**
 * DOWNLOADS IN THE AGENT'S OWN BROWSER (HOAI board row 67562770).
 *
 * WHAT WAS WRONG. Measured on main 0a4c96a with the host started the way the
 * daemon starts it: Chrome raised the download over CDP, Playwright saved it
 * into a playwright-artifacts folder in the system temp folder (outside the
 * agent's folder) and its MCP tab code copied it into the agent's output
 * folder and printed the path to the agent. Nobody was asked, although the
 * host's own agent text said a download is asked for.
 *
 * THE RULES ARE THE DESKTOP APP'S (BGOS #2198), on this host:
 *   - a download is ASKED for like any gated action, with the same choices
 *     (policy.gateChoices('download')), for 60 seconds whatever wait the click
 *     carried, and while the owner decides it keeps arriving into a private
 *     held folder inside the agent's own folder;
 *   - Allow puts it where the ask said: the agent's browser output folder,
 *     under its own name, never over another file, and the agent is told the
 *     path. Deny deletes it. Only an explicit Deny deletes: a timeout, a lost
 *     card, an answer this host cannot read or a host that stops is NOT a no;
 *   - one nobody answers is KEPT for the owner: an opaque name in an owner
 *     only folder that is never synced, roamed or backed up (KeptFolderGuard,
 *     a port of BGOS download-holding.js), 7 days, then deleted. The agent
 *     reads it as kept and is never given its path. The owner is told the
 *     moment it is kept, by a card (the only surface this host has), and Deny
 *     on that card deletes it in one tap; Allow gives that one file to the
 *     agent and remembers nothing;
 *   - limits, for keeping only: 50 MB a file, 5 files and 500 MB a session,
 *     25 files and 1 GB for the agent. Past them an unanswered download is
 *     deleted, and the ask says so before it is asked.
 *
 * WHAT IS DIFFERENT FROM THE DESKTOP, AND WHY.
 *   - Playwright cannot pause a transfer. So the bytes of an undecided
 *     download are bounded by watching the held folder: one that passes the
 *     agent's 1 GB ceiling is cancelled and deleted.
 *   - The agent runs on this machine as the same OS user. Owner only
 *     permissions keep other users out; they cannot keep out the agent's own
 *     shell. What the rules guarantee is that no tool hands the agent a kept
 *     file or its path, and the agent is told not to fetch it again.
 *   - A Deny is not remembered, as this host remembers no Deny on any gate.
 *
 * EVERY DETACHED PATH ENDS IN A .catch THAT LOGS A FIXED CODE. Playwright's
 * MCP context collects unhandled rejections and appends them, stack and all,
 * to the agent's next tool reply; a file system error names both paths, and a
 * kept path must never reach the agent.
 */

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const MB = 1024 * 1024
export const DOWNLOAD_KEEP_MS = 7 * 24 * 60 * 60 * 1000
/** Kc's numbers (#2198): a file, a session; and the ceiling for the agent across its people. */
export const DOWNLOAD_KEEP_LIMITS = Object.freeze({ fileBytes: 50 * MB, sessionBytes: 500 * MB, sessionFiles: 5, totalBytes: 1024 * MB, totalFiles: 25 })
/** A download ask is the desktop's 60 s strip: with a missed ask keeping the file, longer only holds up the agent's other asks. */
export const DOWNLOAD_ASK_WAIT_S = 60
/** The kept notice waits as long as a card may (GATE_WAIT_MAX_S). */
export const KEPT_NOTICE_WAIT_S = 1800
/** A notice is read slower than an ask: nothing is waiting on it. */
export const KEPT_NOTICE_POLL_MS = 10_000
/** How long a closing session waits for a transfer still arriving. */
export const DOWNLOAD_GRACE_MS = 5_000
export const HELD_POLL_MS = 500
/** A finished file in held/ that no download event claimed this long is adopted, never left silent. */
export const UNCLAIMED_AFTER_MS = 10_000
export const DOWNLOAD_NAME_MAX = 120
/** The card route's summary limit (PostBrowserGateCardDto). */
export const CARD_SUMMARY_MAX = 500
export const DOWNLOADS_FOLDER = 'browser-downloads'
/** The notice offers this one file, or Delete. Never a session or site grant. */
export const KEPT_NOTICE_CHOICES = Object.freeze(['allow_once', 'deny'])

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PARTIAL = '.crdownload'
const TERMINAL = new Set(['saved', 'deleted', 'failed'])
const ROWS_SHOWN = 6
const ROWS_REMEMBERED = 30

// ── Paths and names ───────────────────────────────────────────────────────────

/** Where one agent and person's downloads live, all inside ~/.bgos-agent/<id>/. */
export function downloadPaths({ agentRoot, assistantId, key }) {
  const root = path.join(agentRoot, String(assistantId), DOWNLOADS_FOLDER)
  const dir = path.join(root, key)
  return { root, dir, held: path.join(dir, 'held'), kept: path.join(dir, 'kept'), index: path.join(dir, 'downloads.json') }
}

const UNSAFE_CHARS = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** The site's file name, safe to show: no control or direction characters, at most 120 characters with the extension kept. */
export function cleanFileName(raw, max = DOWNLOAD_NAME_MAX) {
  const name = String(raw ?? '').replace(UNSAFE_CHARS, '').trim()
  if (!name) return 'download'
  if (name.length <= max) return name
  const ext = /\.[A-Za-z0-9]{1,15}$/.exec(name)?.[0] ?? ''
  return `${name.slice(0, Math.max(1, max - ext.length - 1)).trimEnd()}\u2026${ext}`
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i

/** A plain file name for the output folder on every system: the last part only, nothing Windows refuses. */
export function saveName(raw) {
  let name = cleanFileName(String(raw ?? '').split(/[\\/]/).pop())
  name = name.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/, '')
  if (!name || name === '.' || name === '..') return 'download'
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`
  return name
}

/** A path as the owner reads it: the home as ~ and / separators. */
export function displayPath(target, home = homedir()) {
  const p = String(target)
  const h = String(home || '')
  const inside = h && (p === h || p.toLowerCase().startsWith(`${h.toLowerCase()}${path.sep}`) || p.startsWith(`${h}/`))
  return (inside ? `~${p.slice(h.length)}` : p).replace(/\\/g, '/')
}

/** http(s) origin of a URL, or null (blob:, data: and the like). */
export function plainOrigin(url) {
  try {
    const u = new URL(String(url))
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

// ── Words ─────────────────────────────────────────────────────────────────────

function fit(build, name) {
  let n = name
  let text = build(n)
  while (text.length > CARD_SUMMARY_MAX && n.length > 8) {
    n = cleanFileName(n, Math.max(8, n.length - (text.length - CARD_SUMMARY_MAX) - 1))
    text = build(n)
  }
  return text.length > CARD_SUMMARY_MAX ? text.slice(0, CARD_SUMMARY_MAX) : text
}

const clip = (s, n = 60) => cleanFileName(s || '', n)

/** The ask, read after "<agent> wants to": what, where an Allow puts it, what no answer does. */
export function askSummary({ fileName, device, agentName, displayDir, keepable, fileLimit = DOWNLOAD_KEEP_LIMITS.fileBytes }) {
  const where = clip(device)
  const agent = clip(agentName || 'Your agent')
  const unanswered = keepable
    ? `If you don't answer, the file is kept for you on ${where} (up to ${sizeWords(fileLimit)}) and ${agent} doesn't get it.`
    : `If you don't answer, the file is deleted.`
  return fit((n) => `download ${n} into ${displayDir} on ${where}. ${unanswered}`, cleanFileName(fileName))
}

const NOTICE_WHY = {
  no_answer: 'nobody answered',
  session_closed: 'the browser closed before anyone answered',
  owner_download: 'you downloaded it while you held the browser',
  unnamed: 'the browser saved it without naming it',
  save_failed: 'it could not be put in its folder',
}

/** The notice the moment a file is kept: why, where, and what each button does. */
export function keptSummary({ fileName, device, agentName, displayDir, reason }) {
  const where = clip(device)
  const agent = clip(agentName || 'Your agent')
  const why = NOTICE_WHY[reason] || NOTICE_WHY.no_answer
  return fit(
    (n) => `download ${n}: ${why}, so it is kept for you on ${where} and ${agent} does not get it. Allow gives this one file to ${agent} in ${displayDir}; Deny deletes it now. It is deleted by itself after 7 days.`,
    cleanFileName(fileName),
  )
}

export function sizeWords(bytes) {
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  const unit = (v, name) => `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${name}`
  if (n < 1024) return `${Math.floor(n)} B`
  if (n < MB) return unit(n / 1024, 'KB')
  if (n < 1024 * MB) return unit(n / MB, 'MB')
  return unit(n / (1024 * MB), 'GB')
}

const KEPT_WORDS = {
  no_answer: 'no answer',
  session_closed: 'session closed',
  owner_download: 'they downloaded it themselves',
  unnamed: 'the browser did not name it',
  save_failed: 'it could not be put in your folder',
}

function limitWords(limit, limits = DOWNLOAD_KEEP_LIMITS) {
  if (limit === 'file') return `over the ${sizeWords(limits.fileBytes)} a kept file may have`
  if (limit === 'session') return 'this session already keeps as many files as it may'
  if (limit === 'total') return "your owner's machine already keeps as much as it may for you"
  if (limit === 'folder') return 'the private folder for kept files is not safe to use'
  return 'it could not be kept'
}

function stateWords(d) {
  switch (d.state) {
    case 'asking':
      return "waiting for your owner's answer."
    case 'saving':
      return 'allowed, still arriving.'
    case 'held':
      return "held on this machine for your owner, because its private folder could not be checked; it is settled when this machine's browser host next starts. You are not given it."
    case 'saved':
      return `saved in your browser folder: ${d.savedPath}`
    case 'kept':
      return `kept for your owner (${KEPT_WORDS[d.keptReason] || 'no answer'})${d.keptReady === false ? ', still arriving' : ''}. It stays on this machine for them; you are not given it.`
    case 'deleted':
      if (d.reason === 'owner_denied') return 'not saved: your owner said no.'
      if (d.reason === 'rule') return "not saved: your owner's rules refuse it."
      if (d.reason === 'owner_deleted') return 'deleted by your owner.'
      if (d.reason === 'expired') return 'deleted after 7 days.'
      if (d.reason === 'downloads_off') return 'not saved: downloads are off on this machine.'
      if (d.reason === 'too_many') return 'not saved: too many downloads were waiting for an answer.'
      if (d.reason === 'session_closed') return 'not saved: the session closed before it finished.'
      if (d.reason === 'not_kept') return `not kept: ${limitWords(d.limit, d.limits)}, so it was deleted.`
      return 'deleted.'
    case 'failed':
      return 'failed: the transfer did not finish.'
    default:
      return `${String(d.state || 'unknown').replace(/[^a-z_]/g, '')}.`
  }
}

/** The Downloads block of hoai_browser_status: a handle, the name, the size and the state; a path only for a file given to the agent. */
export function downloadLines(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return []
  const text = (d) => {
    const bytes = Number(d.bytes) || 0
    const size = d.state === 'asking' || d.state === 'saving' || (d.state === 'kept' && d.keptReady === false)
      ? bytes > 0 ? `${sizeWords(bytes)} so far` : 'size not known yet'
      : sizeWords(bytes)
    return `${d.handle} ${d.fileName}, ${d.state === 'asking' && bytes > 0 && d.done ? sizeWords(bytes) : size}, ${stateWords(d)}`
  }
  const lines = [`Downloads: ${text(rows[0])}`, ...rows.slice(1).map((r) => `  ${text(r)}`)]
  const kept = rows.filter((r) => r.state === 'kept').length
  if (kept) lines.push(`  Do not download ${kept === 1 ? 'it' : 'a kept file'} again: the site may serve it once. Ask your owner what to do with it.`)
  return lines
}

// ── The kept file guard (a port of BGOS frontend/electron-app/download-holding.js, #2198) ─

/**
 * The synced, roaming or backed up roots a kept file must never sit in. The
 * host gets OneDrive, OneDriveConsumer and OneDriveCommercial for this
 * (lib/browser-env.mjs HOST_ONLY_ENV); Chrome never does.
 */
export function syncedRoots({ platform, env = {}, home = '' }) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const under = (...parts) => (home ? p.join(home, ...parts) : null)
  const roots = platform === 'win32'
    ? [[env.OneDrive, 'OneDrive'], [env.OneDriveConsumer, 'OneDrive'], [env.OneDriveCommercial, 'OneDrive'], [under('OneDrive'), 'OneDrive'],
      [env.APPDATA, 'roaming profile'], [under('Dropbox'), 'Dropbox'], [under('Google Drive'), 'Google Drive'], [under('iCloudDrive'), 'iCloud Drive']]
    : platform === 'darwin'
      ? [[under('Library', 'Mobile Documents'), 'iCloud Drive'], [under('Library', 'CloudStorage'), 'a cloud storage provider'],
        [under('Desktop'), 'iCloud Desktop and Documents'], [under('Documents'), 'iCloud Desktop and Documents'],
        [under('Dropbox'), 'Dropbox'], [under('Google Drive'), 'Google Drive']]
      : [[under('Dropbox'), 'Dropbox'], [under('Google Drive'), 'Google Drive'], [under('OneDrive'), 'OneDrive'],
        [under('Nextcloud'), 'Nextcloud'], [under('ownCloud'), 'ownCloud'], [under('.config'), 'a synced settings folder']]
  return roots.filter(([root]) => typeof root === 'string' && p.isAbsolute(root))
}

export function syncedFolderOf(dir, { platform, env, home }) {
  const p = platform === 'win32' ? path.win32 : path.posix
  const fold = platform === 'linux' ? (v) => v : (v) => v.toLowerCase()
  const target = fold(p.resolve(dir))
  for (const [root, name] of syncedRoots({ platform, env, home })) {
    const base = fold(p.resolve(root))
    if (target === base || target.startsWith(base.endsWith(p.sep) ? base : base + p.sep)) return name
  }
  return null
}

const defaultRun = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 15_000, encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve({ stdout })))
})

/**
 * The folder kept files live in. Owner only (0700 and the uid off Windows;
 * on Windows inheritance removed and the user's SID alone, read back as SDDL),
 * never inside a synced folder (on its path and on its real path), never in a
 * roaming profile, excluded from Time Machine on macOS, and checked again
 * (same device and inode, not a link) before each use. Any rule that fails:
 * nothing is held at all and the browser refuses downloads.
 */
export class KeptFolderGuard {
  constructor({ dir, platform = process.platform, env = /** @type {Record<string, string | undefined>} */ (process.env), home = homedir(), run = /** @type {(file: string, args: string[]) => Promise<{ stdout: string }>} */ (defaultRun), fsImpl = /** @type {any} */ (fs), getuid = process.getuid, log = /** @type {(line: string) => void} */ (() => {}) }) {
    this.dir = dir
    this.platform = platform
    this.env = env
    this.home = home
    this.run = run
    this.fs = fsImpl
    this.getuid = getuid
    this.log = log
    this.ready = false
    this.reason = 'not_prepared'
    /** The ACL read back on Windows when it was not owner only, for a test's failure message. Never logged. */
    this.readBack = null
    this.identity = null
    this._preparing = null
  }

  verify() {
    if (!this.ready || !this.identity) return false
    try {
      const stat = this.fs.lstatSync(this.dir)
      return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === this.identity.dev && stat.ino === this.identity.ino
    } catch {
      return false
    }
  }

  /** Prepared once per process; a folder that changed since is prepared again. */
  prepare() {
    if (this.ready && this.verify()) return Promise.resolve(true)
    if (!this._preparing) {
      this._preparing = (async () => {
        this.ready = false
        try {
          this.reason = await this._prepare()
        } catch {
          this.reason = 'unavailable'
        }
        this.ready = this.reason === null
        if (!this.ready) this.log(`downloads: the private folder is not used (${this.reason}); this browser refuses downloads`)
        return this.ready
      })().finally(() => {
        this._preparing = null
      })
    }
    return this._preparing
  }

  async _prepare() {
    const p = this.platform === 'win32' ? path.win32 : path.posix
    const dir = this.dir
    if (typeof dir !== 'string' || !p.isAbsolute(dir)) return 'no_folder'
    const where = { platform: this.platform, env: this.env, home: this.home }
    if (syncedFolderOf(dir, where)) return 'synced_folder'
    let sid = null
    if (this.platform === 'win32') {
      sid = await this._sid()
      if (!sid) return 'not_owner_only'
      if (await this._roaming(sid)) return 'roaming_profile'
    }
    this.fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = this.fs.lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'not_a_plain_folder'
    // A parent that is a link or junction into a synced folder counts too.
    if (syncedFolderOf(this.fs.realpathSync.native(dir), where)) return 'synced_folder'
    if (this.platform === 'win32') {
      if (!(await this._ownerOnlyWindows(dir, sid))) return 'not_owner_only'
    } else {
      this.fs.chmodSync(dir, 0o700)
      const after = this.fs.lstatSync(dir)
      if ((after.mode & 0o777) !== 0o700 || (typeof this.getuid === 'function' && after.uid !== this.getuid())) return 'not_owner_only'
      // Every folder above it is the user's or the system's, and nobody else
      // can write there (a sticky /tmp style folder excepted): otherwise
      // another user could swap the folder for a link.
      for (let parent = p.dirname(dir); ; parent = p.dirname(parent)) {
        const st = this.fs.lstatSync(parent)
        const othersWrite = (st.mode & 0o002) !== 0 && (st.mode & 0o1000) === 0
        const owner = typeof this.getuid === 'function' ? [0, this.getuid()].includes(st.uid) : true
        if (othersWrite || !owner) return 'parent_not_private'
        if (p.dirname(parent) === parent) break
      }
    }
    if (this.platform === 'darwin') {
      try {
        await this.run('/usr/bin/tmutil', ['addexclusion', dir])
        const { stdout } = await this.run('/usr/bin/tmutil', ['isexcluded', dir])
        if (!/\[Excluded\]/.test(String(stdout))) return 'backup_exclusion_failed'
      } catch {
        return 'backup_exclusion_failed'
      }
    }
    const checked = this.fs.lstatSync(dir)
    this.identity = { dev: checked.dev, ino: checked.ino }
    return null
  }

  _system32() {
    return path.win32.join(this.env.SystemRoot || this.env.SYSTEMROOT || 'C:\\Windows', 'System32')
  }

  async _sid() {
    try {
      const who = String((await this.run(path.win32.join(this._system32(), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'])).stdout).trim()
      return /"(S-1-[0-9-]+)"\s*$/.exec(who)?.[1] ?? null
    } catch {
      return null
    }
  }

  /**
   * A roaming profile copies the profile root, and ~/.bgos-agent sits at the
   * root (the desktop keeps its folder in %LOCALAPPDATA% because Local never
   * roams). Windows records a roaming profile as CentralProfile; a missing
   * value is the normal local profile.
   */
  async _roaming(sid) {
    try {
      const key = `HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${sid}`
      const { stdout } = await this.run(path.win32.join(this._system32(), 'reg.exe'), ['query', key, '/v', 'CentralProfile'])
      return /CentralProfile\s+REG_\w+\s+\S/.test(String(stdout))
    } catch {
      return false
    }
  }

  // Inheritance removed, the user's own SID granted full control and nothing
  // else, then read back as SDDL (icacls /save, UTF-16): the same on every
  // language of Windows and every user name. A folder made where nothing is
  // inherited carries the creating token's default DACL as EXPLICIT entries
  // (SYSTEM, Administrators: measured on GitHub's Windows runner), which
  // /inheritance:r leaves, so any other allow entry is removed by its SID and
  // the folder read back again. An entry the guard cannot name is never
  // guessed at: the folder is refused. The read back file is written beside
  // the folder, inside the agent's own folder, and removed.
  async _ownerOnlyWindows(dir, sid) {
    const icacls = path.win32.join(this._system32(), 'icacls.exe')
    await this.run(icacls, [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`])
    // SDDL writes the built in Administrator (RID 500) as LA, not by its SID.
    // SDDL writes some accounts by alias: the built in Administrator (RID 500)
    // as LA, and a service account (SYSTEM, LocalService, NetworkService) as
    // SY, LS or NS. Any of these that IS the user is the user's own entry.
    const isMe = (trustee) => trustee === sid || WELL_KNOWN_SDDL[trustee] === sid || (trustee === 'LA' && /^S-1-5-21-[0-9-]+-500$/.test(sid))
    let sddl = await this._readSddl(dir)
    const others = sddlAces(sddl).filter((ace) => !isMe(ace.trustee))
    if (others.length) {
      const sids = others.map((ace) => (ace.type === 'A' ? WELL_KNOWN_SDDL[ace.trustee] ?? (/^S-1-[0-9-]+$/.test(ace.trustee) ? ace.trustee : null) : null))
      if (sids.some((other) => !other || other === sid)) {
        this.readBack = sddl
        return false
      }
      await this.run(icacls, [dir, '/remove:g', ...[...new Set(sids)].map((other) => `*${other}`)])
      sddl = await this._readSddl(dir)
    }
    const aces = sddlAces(sddl)
    const ok = /^D:P/.test(sddl) && aces.length === 1 && aces[0].type === 'A' && aces[0].flags === 'OICI' && aces[0].rights === 'FA' && isMe(aces[0].trustee)
    this.readBack = ok ? null : sddl
    return ok
  }

  async _readSddl(dir) {
    const icacls = path.win32.join(this._system32(), 'icacls.exe')
    const saved = path.win32.join(path.win32.dirname(dir), `.browser-downloads-acl-${process.pid}-${randomUUID()}.txt`)
    try {
      await this.run(icacls, [dir, '/save', saved])
      const lines = this.fs.readFileSync(saved).toString('utf16le').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim())
      return (lines[1] || '').trim()
    } finally {
      try {
        this.fs.unlinkSync(saved)
      } catch {}
    }
  }
}

/** The SDDL aliases a folder's entries may carry, and their SIDs (for icacls /remove). */
const WELL_KNOWN_SDDL = Object.freeze({
  SY: 'S-1-5-18', BA: 'S-1-5-32-544', BU: 'S-1-5-32-545', BG: 'S-1-5-32-546', PU: 'S-1-5-32-547',
  AU: 'S-1-5-11', WD: 'S-1-1-0', CO: 'S-1-3-0', CG: 'S-1-3-1', OW: 'S-1-3-4', IU: 'S-1-5-4',
  SU: 'S-1-5-6', NU: 'S-1-5-2', AN: 'S-1-5-7', LS: 'S-1-5-19', NS: 'S-1-5-20', RD: 'S-1-5-32-555', RU: 'S-1-5-32-554',
})

/** The entries of a DACL in SDDL: type, flags, rights and trustee of each. */
function sddlAces(sddl) {
  return [...String(sddl).matchAll(/\(([^)]*)\)/g)].map((m) => {
    const [type = '', flags = '', rights = '', , , trustee = ''] = m[1].split(';')
    return { type, flags, rights, trustee }
  })
}

// ── File moves ────────────────────────────────────────────────────────────────

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

/** rename, retried while Windows (an antivirus, the zone tag) still holds a just finished file. */
async function renameRetry(from, to, fsImpl = fs) {
  for (let attempt = 0; ; attempt++) {
    try {
      fsImpl.renameSync(from, to)
      return
    } catch (err) {
      if (attempt >= 8 || !['EBUSY', 'EPERM', 'EACCES'].includes(err?.code)) throw err
      await sleepMs(50 * (attempt + 1))
    }
  }
}

/** Into a folder under a name nobody has: a hard link refuses an existing name, so nothing is ever overwritten. */
async function placeUnique(from, dir, name, fsImpl = fs) {
  const ext = /\.[A-Za-z0-9]{1,15}$/.exec(name)?.[0] ?? ''
  const base = ext ? name.slice(0, -ext.length) : name
  for (let i = 0; i < 100; i++) {
    const target = path.join(dir, i === 0 ? name : `${base} (${i})${ext}`)
    try {
      fsImpl.linkSync(from, target)
    } catch (err) {
      if (err?.code === 'EEXIST') continue
      if (err?.code !== 'EXDEV' && err?.code !== 'EPERM' && err?.code !== 'ENOTSUP') throw err
      // Another volume, or links refused: copy, refusing an existing name, and check the size.
      try {
        fsImpl.copyFileSync(from, target, fs.constants.COPYFILE_EXCL)
      } catch (copyErr) {
        if (copyErr?.code === 'EEXIST') continue
        throw copyErr
      }
      if (fsImpl.statSync(target).size !== fsImpl.statSync(from).size) {
        fsImpl.rmSync(target, { force: true })
        throw Object.assign(new Error('copy size mismatch'), { code: 'ESIZE' })
      }
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fsImpl.rmSync(from, { force: true })
        break
      } catch (err) {
        if (attempt >= 8) throw err
        await sleepMs(50 * (attempt + 1))
      }
    }
    return target
  }
  throw Object.assign(new Error('no free name'), { code: 'ENAME' })
}

function rmQuiet(file, fsImpl = fs) {
  try {
    fsImpl.rmSync(file, { force: true })
  } catch {}
}

/** Delete, retried while Windows still holds the file (as renameRetry). True once it is gone. */
async function rmRetry(file, fsImpl = fs) {
  for (let attempt = 0; ; attempt++) {
    try {
      fsImpl.rmSync(file, { force: true })
    } catch (err) {
      if (attempt < 8 && ['EBUSY', 'EPERM', 'EACCES'].includes(err?.code)) {
        await sleepMs(50 * (attempt + 1))
        continue
      }
    }
    return !fsImpl.existsSync(file)
  }
}

/** A folder we made, still a plain folder (not a link or junction) inside `root` on disk. */
function plainFolderUnder(dir, root, fsImpl = fs) {
  try {
    const st = fsImpl.lstatSync(dir)
    return st.isDirectory() && !st.isSymbolicLink() && isUnder(fsImpl.realpathSync.native(dir), fsImpl.realpathSync.native(root))
  } catch {
    return false
  }
}

function isUnder(child, parent) {
  const c = path.resolve(child)
  const p = path.resolve(parent)
  return c === p || c.toLowerCase().startsWith(`${p.toLowerCase()}${path.sep}`)
}

// ── The store: one per agent ──────────────────────────────────────────────────

/**
 * Everything kept for one agent, across its people: the index of each
 * person's folder, the limits, keeping, the owner's notice and its answer,
 * and the 7 day sweep. One lock serialises every count, move and index write,
 * so two downloads kept together cannot both pass a limit.
 */
export class DownloadStore {
  constructor({ agentRoot, assistantId, gates, deviceLabel, home = homedir(), guard = /** @type {any} */ (null), limits = DOWNLOAD_KEEP_LIMITS, keepMs = DOWNLOAD_KEEP_MS, now = Date.now, noticePollMs = KEPT_NOTICE_POLL_MS, platform = process.platform, env = /** @type {Record<string, string | undefined>} */ (process.env), log = /** @type {(line: string) => void} */ (() => {}), fsImpl = /** @type {any} */ (fs) }) {
    this.agentRoot = agentRoot
    this.assistantId = assistantId
    this.agentDir = path.join(agentRoot, String(assistantId))
    this.root = path.join(this.agentDir, DOWNLOADS_FOLDER)
    this.gates = gates
    this.deviceLabel = deviceLabel
    this.home = home
    this.limits = limits
    this.keepMs = keepMs
    this.now = now
    this.noticePollMs = noticePollMs
    this.platform = platform
    this.fs = fsImpl
    this._log = log
    this.guard = guard ?? new KeptFolderGuard({ dir: this.root, platform, env, home, log })
    /** key -> Map(id -> row). Rows are shared with the live session, so one object holds the truth. */
    this._rows = new Map()
    this._loaded = new Set()
    this._lock = Promise.resolve()
    /** record ids whose notice this store is reading now. */
    this._watching = new Set()
    /** Notices being posted now: a stopping host waits for them (flushTells). */
    this._posting = new Set()
    this._stopped = false
    /** Set by the host to the start sweep: no browser of this agent starts before it. */
    this.ready = Promise.resolve()
  }

  paths(key) {
    return downloadPaths({ agentRoot: this.agentRoot, assistantId: this.assistantId, key })
  }

  outputDir(key) {
    return path.join(this.agentDir, 'browser-output', key)
  }

  displayOutputDir(key) {
    return displayPath(this.outputDir(key), this.home)
  }

  log(line) {
    try {
      this._log(line)
    } catch {}
  }

  /** Serialise one piece of work against every other count, move and write. */
  withLock(work) {
    const run = this._lock.then(work, work)
    this._lock = run.catch(() => {})
    return run
  }

  _map(key) {
    this._load(key)
    let rows = this._rows.get(key)
    if (!rows) {
      rows = new Map()
      this._rows.set(key, rows)
    }
    return rows
  }

  /** The index of one person's folder, read once. A file that cannot be read starts empty and says so. */
  _load(key) {
    if (this._loaded.has(key)) return
    this._loaded.add(key)
    const rows = new Map()
    this._rows.set(key, rows)
    let text = null
    try {
      text = this.fs.readFileSync(this.paths(key).index, 'utf8')
    } catch {
      return
    }
    try {
      const data = JSON.parse(text)
      for (const r of Array.isArray(data?.records) ? data.records : []) {
        if (!r || typeof r.id !== 'string' || !GUID.test(r.id)) continue
        const row = {
          id: r.id,
          key,
          handle: r.handle || `dl_${r.id.replace(/-/g, '').slice(0, 4)}`,
          fileName: cleanFileName(r.fileName),
          origin: typeof r.origin === 'string' ? r.origin : null,
          agentName: typeof r.agentName === 'string' ? r.agentName : null,
          startedAt: Number(r.startedAt) || 0,
          bytes: Number(r.bytes) || 0,
          state: r.state === 'kept' ? 'kept' : r.state === 'doomed' ? 'deleted' : 'held',
          ...(r.state === 'doomed' ? { doomed: true, reason: r.reason || 'owner_denied' } : {}),
          keptReady: r.state === 'kept',
          keptReason: r.keptReason || null,
          keptUntil: Number(r.keptUntil) || null,
          guid: typeof r.guid === 'string' && GUID.test(r.guid) ? r.guid : null,
          allowed: r.allowed === true,
          notice: r.notice && typeof r.notice === 'object' ? { told: r.notice.told === true, gateId: r.notice.gateId || null, expiresAt: r.notice.expiresAt || null } : { told: false },
        }
        rows.set(row.id, row)
      }
    } catch {
      this.log(`downloads: the index for ${key} could not be read; it starts empty`)
    }
  }

  /** Write one person's index: every download not yet over, origin only, never a URL. */
  _persist(key) {
    // Never an index in a folder the guard refused (synced, roaming, not owner
    // only), nor in one swapped since it was prepared.
    if (!this.guard.ready || !this.guard.verify()) return
    const rows = [...this._map(key).values()].filter((r) => !TERMINAL.has(r.state) || r.doomed)
    const records = rows.map((r) => ({
      id: r.id,
      handle: r.handle,
      fileName: r.fileName,
      origin: r.origin ?? null,
      agentName: r.agentName ?? null,
      startedAt: r.startedAt,
      bytes: r.bytes || 0,
      state: r.doomed ? 'doomed' : r.state === 'kept' && r.keptReady !== false ? 'kept' : 'held',
      ...(r.doomed ? { reason: r.reason || 'owner_denied' } : {}),
      ...(r.guid ? { guid: r.guid } : {}),
      ...(r.allowed ? { allowed: true } : {}),
      ...(r.keptReason ? { keptReason: r.keptReason } : {}),
      ...(r.keptUntil ? { keptUntil: r.keptUntil } : {}),
      notice: { told: r.notice?.told === true, gateId: r.notice?.gateId ?? null, expiresAt: r.notice?.expiresAt ?? null },
    }))
    const p = this.paths(key)
    this.fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 })
    const tmp = `${p.index}.${process.pid}.${randomUUID()}.tmp`
    try {
      this.fs.writeFileSync(tmp, JSON.stringify({ v: 1, records }, null, 2), { mode: 0o600 })
      this.fs.renameSync(tmp, p.index)
    } finally {
      rmQuiet(tmp, this.fs)
    }
  }

  /** A download of this session: shown, and written down while it is held so a crash cannot lose it. */
  track(key, row, { persist = true } = {}) {
    this._map(key).set(row.id, row)
    this._trim(key)
    if (persist && !TERMINAL.has(row.state)) this._persistQuiet(key)
  }

  changed(key) {
    this._trim(key)
    this._persistQuiet(key)
  }

  _persistQuiet(key) {
    try {
      this._persist(key)
    } catch (err) {
      this.log(`downloads: the index for ${key} could not be written (${err?.code || 'error'})`)
    }
  }

  _trim(key) {
    const rows = this._map(key)
    const done = [...rows.values()].filter((r) => TERMINAL.has(r.state) && !r.doomed).sort((a, b) => a.startedAt - b.startedAt)
    while (done.length > ROWS_REMEMBERED) rows.delete(done.shift().id)
  }

  /** The rows hoai_browser_status shows for one person, newest last. */
  rows(key) {
    const all = [...this._map(key).values()].sort((a, b) => a.startedAt - b.startedAt)
    const kept = new Set(all.filter((r) => r.state === 'kept'))
    const latest = new Set(all.filter((r) => !kept.has(r)).slice(-ROWS_SHOWN))
    return all.filter((r) => kept.has(r) || latest.has(r)).map((r) => ({ ...r, limits: this.limits }))
  }

  /** The held files this person's rows still own: a download in progress, held, or owed a delete. Never adopted by a watcher. */
  claimedGuids(key) {
    const out = new Set()
    for (const r of this._map(key).values()) if (r.guid && (!TERMINAL.has(r.state) || r.doomed)) out.add(r.guid)
    return out
  }

  /** Kept files and their bytes across every person of this agent. */
  totals() {
    let files = 0
    let bytes = 0
    for (const key of this._keys()) {
      for (const r of this._map(key).values()) {
        if (r.state === 'kept' && r.keptReady !== false) {
          files++
          bytes += r.bytes || 0
        }
      }
    }
    return { files, bytes }
  }

  _keys() {
    let names = []
    try {
      names = this.fs.readdirSync(this.root)
    } catch {}
    return [...new Set([...names.filter((n) => !n.startsWith('.')), ...this._rows.keys()])]
  }

  /** Which limit keeping this many bytes would pass, or null. */
  limitFor(bytes, session = { files: 0, bytes: 0 }) {
    const l = this.limits
    if (bytes > l.fileBytes) return 'file'
    if (session.files >= l.sessionFiles || session.bytes + bytes > l.sessionBytes) return 'session'
    const t = this.totals()
    if (t.files >= l.totalFiles || t.bytes + bytes > l.totalBytes) return 'total'
    return null
  }

  /**
   * Keep a finished held file for the owner: limits, the folder check, the
   * move to an opaque name, owner only, the index. { kept, limit }.
   */
  keep(key, row, heldPath, reason, session) {
    return this.withLock(async () => {
      if (row.state === 'kept' && row.keptReady === true) return { kept: true, bytes: row.bytes }
      let bytes = 0
      try {
        bytes = this.fs.statSync(heldPath).size
      } catch {
        return { kept: false, limit: 'missing' }
      }
      row.bytes = bytes
      const limit = this.limitFor(bytes, session)
      if (limit) return { kept: false, limit }
      if (!this.guard.verify()) return { kept: false, limit: 'folder' }
      const p = this.paths(key)
      this.fs.mkdirSync(p.kept, { recursive: true, mode: 0o700 })
      if (!plainFolderUnder(p.kept, this.root, this.fs)) return { kept: false, limit: 'folder' }
      const target = path.join(p.kept, row.id)
      await renameRetry(heldPath, target, this.fs)
      if (this.platform !== 'win32') {
        try {
          this.fs.chmodSync(target, 0o600)
        } catch {}
      }
      Object.assign(row, { state: 'kept', keptReady: true, keptReason: reason, keptUntil: this.now() + this.keepMs, guid: null, notice: row.notice?.told ? row.notice : { told: false } })
      this.changed(key)
      return { kept: true, bytes }
    })
  }

  /** Move a finished held file (Allow) or a kept one (the notice's Allow) into the output folder. */
  give(key, row, fromPath) {
    return this.withLock(async () => {
      if (row.state === 'saved') return row.savedPath
      const dir = this.outputDir(key)
      this.fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      if (!plainFolderUnder(dir, this.agentDir, this.fs)) throw Object.assign(new Error('output folder is not plain'), { code: 'EFOLDER' })
      try {
        row.bytes = this.fs.statSync(fromPath).size
      } catch {}
      const target = await placeUnique(fromPath, dir, saveName(row.fileName), this.fs)
      Object.assign(row, { state: 'saved', savedPath: target, guid: null, keptReady: undefined })
      this.changed(key)
      return target
    })
  }

  /** Delete a kept file: the owner's Deny on the notice, or the 7 day sweep. */
  deleteKept(key, row, reason) {
    return this.withLock(async () => {
      if (row.notice?.gateId) this.gates?.end?.(row.notice.gateId, { allowed: false, reason: 'download_ended' })
      // Recorded as to be deleted first, so a crash mid delete still deletes it.
      Object.assign(row, { state: 'deleted', reason, doomed: true })
      this.changed(key)
      const gone = await rmRetry(path.join(this.paths(key).kept, row.id), this.fs)
      // Still there (Windows holds it): it stays recorded, and is deleted again at the next sweep.
      if (gone) row.doomed = false
      this.changed(key)
    })
  }

  /**
   * Tell the owner a file was kept, once: a card with Allow (this one file to
   * the agent, nothing remembered) and Deny (deleted now). It is never
   * awaited by a close path; a post that fails is tried again later
   * (tellOwners) until it posts once.
   */
  tell(key, row) {
    if (this._stopped || !this.gates || row.state !== 'kept' || row.keptReady === false) return
    if (row.notice?.told || this._watching.has(row.id)) return
    this._watching.add(row.id)
    let posted
    const postedOrDone = new Promise((r) => (posted = r))
    this._posting.add(postedOrDone)
    void postedOrDone.then(() => this._posting.delete(postedOrDone))
    const outcome = this.gates.raise({
      key: `notice:${this.assistantId}:${key}:${row.id}`,
      assistantId: this.assistantId,
      kind: 'download',
      origin: row.origin ?? null,
      summary: keptSummary({ fileName: row.fileName, device: this.deviceLabel, agentName: row.agentName, displayDir: this.displayOutputDir(key), reason: row.keptReason }),
      agentName: row.agentName || 'Your agent',
      purpose: null,
      waitSeconds: KEPT_NOTICE_WAIT_S,
      choices: [...KEPT_NOTICE_CHOICES],
      action: null,
      attachMs: Infinity,
      pollMs: this.noticePollMs,
      onRaised: (gate) => {
        row.notice = { told: false, gateId: gate.gateId, expiresAt: gate.expiresAt }
      },
      onPosted: () => {
        row.notice = { ...row.notice, told: true }
        this.changed(key)
        posted()
      },
    })
    void Promise.resolve(outcome).finally(posted).catch(() => {})
    this._answered(key, row, outcome)
  }

  /** Resolves once every notice being posted has posted or failed. */
  flushTells() {
    return Promise.all([...this._posting])
  }

  _answered(key, row, outcome) {
    Promise.resolve(outcome)
      .then(async (out) => {
        this._watching.delete(row.id)
        if (this._stopped || row.state !== 'kept') return
        if (out?.reason === 'card_unreachable') {
          row.notice = { told: false }
          this.changed(key)
          this.log(`downloads: ${row.handle}: the owner could not be told yet; trying again later`)
          return
        }
        if (out?.allowed && KEPT_NOTICE_CHOICES.includes(out.choice) && out.choice !== 'deny') {
          await this.give(key, row, path.join(this.paths(key).kept, row.id))
          return
        }
        if (out?.choice === 'deny') await this.deleteKept(key, row, 'owner_deleted')
      })
      .catch((err) => {
        this._watching.delete(row.id)
        this.log(`downloads: ${row.handle}: the notice answer could not be applied (${err?.code || 'error'})`)
      })
  }

  /** Every kept file whose owner was not told yet is told; a notice posted before a restart is read again. */
  async tellOwners() {
    if (this._stopped) return
    for (const key of this._keys()) {
      for (const row of this._map(key).values()) {
        if (row.state !== 'kept' || row.keptReady === false || this._watching.has(row.id)) continue
        if (!row.notice?.told) {
          this.tell(key, row)
          continue
        }
        // The gate judges the card's expiry on its own clock, the one it was posted by.
        if (row.notice.gateId && row.notice.expiresAt && typeof this.gates?.watch === 'function') {
          this._watching.add(row.id)
          const out = this.gates.watch({ key: `notice:${this.assistantId}:${key}:${row.id}`, gateId: row.notice.gateId, assistantId: this.assistantId, kind: 'download', origin: row.origin ?? null, summary: '', expiresAt: row.notice.expiresAt, pollMs: this.noticePollMs, choices: [...KEPT_NOTICE_CHOICES] })
          this._answered(key, row, out)
        }
      }
    }
  }

  /**
   * The 7 day sweep: every kept file past its day goes, and a file in kept/
   * nobody lists goes once it is 7 days old. At host start, before any
   * browser runs, it also settles what a crash left in held/: a finished file
   * comes back kept (or saved, when the owner had already allowed it), a
   * partial one is deleted, and a finished file nobody recorded is kept.
   */
  sweep({ atStart = false } = {}) {
    return this.withLock(async () => {
      // The guard is prepared BEFORE anything a crash left is kept: an
      // unprepared guard reads as unsafe, and recovery must not lose a file
      // the rules keep.
      if (atStart) {
        try {
          await this.guard.prepare()
        } catch {}
      }
      const now = this.now()
      for (const key of this._keys()) {
        const rows = this._map(key)
        const p = this.paths(key)
        for (const row of [...rows.values()]) {
          if (row.doomed) {
            // Owed a delete (a Deny, a Delete, a refusal) that Windows refused
            // then, or a crash cut short: wherever its bytes are, they go now.
            const keptGone = await rmRetry(path.join(p.kept, row.id), this.fs)
            const heldGone = !row.guid || ((await rmRetry(path.join(p.held, row.guid), this.fs)) && (await rmRetry(path.join(p.held, `${row.guid}${PARTIAL}`), this.fs)))
            if (keptGone && heldGone) Object.assign(row, { doomed: false, guid: null })
            continue
          }
          if (row.state === 'kept' && row.keptReady !== false && row.keptUntil && row.keptUntil <= now) {
            rmQuiet(path.join(p.kept, row.id), this.fs)
            if (row.notice?.gateId) this.gates?.end?.(row.notice.gateId, { allowed: false, reason: 'download_ended' })
            Object.assign(row, { state: 'deleted', reason: 'expired' })
          } else if (row.state === 'kept' && row.keptReady !== false && !this.fs.existsSync(path.join(p.kept, row.id))) {
            rows.delete(row.id)
          }
        }
        let kept = []
        try {
          kept = this.fs.readdirSync(p.kept)
        } catch {}
        for (const name of kept) {
          if (rows.get(name)?.state === 'kept' || rows.get(name)?.doomed) continue
          try {
            if (now - this.fs.statSync(path.join(p.kept, name)).mtimeMs >= this.keepMs) rmQuiet(path.join(p.kept, name), this.fs)
          } catch {}
        }
        if (atStart) await this._recoverHeld(key, rows, p)
        this.changed(key)
      }
    })
  }

  async _recoverHeld(key, rows, p) {
    let names = []
    try {
      names = this.fs.readdirSync(p.held)
    } catch {}
    const claimed = new Set()
    for (const row of [...rows.values()]) {
      // Still owed a delete the sweep above could not make: never kept.
      if (row.doomed) {
        if (row.guid) claimed.add(row.guid)
        continue
      }
      if (row.state !== 'held') continue
      const finished = row.guid && names.includes(row.guid) ? path.join(p.held, row.guid) : null
      if (row.guid) claimed.add(row.guid)
      if (!finished) {
        Object.assign(row, { state: 'failed' })
        continue
      }
      if (row.allowed) {
        try {
          await this._giveUnlocked(key, row, finished)
          continue
        } catch {}
      }
      await this._keepUnlocked(key, row, finished, 'session_closed')
    }
    for (const name of names) {
      const file = path.join(p.held, name)
      if (name.endsWith(PARTIAL) || !GUID.test(name)) {
        if (!claimed.has(name.endsWith(PARTIAL) ? name.slice(0, -PARTIAL.length) : name)) rmQuiet(file, this.fs)
        continue
      }
      if (claimed.has(name)) continue
      // The folder cannot be trusted right now: the file stays where it is,
      // inside the agent folder, for a later start, and goes only by age.
      if (!this.guard.verify()) {
        try {
          if (this.now() - this.fs.statSync(file).mtimeMs >= this.keepMs) rmQuiet(file, this.fs)
        } catch {}
        continue
      }
      const row = { id: randomUUID(), key, handle: '', fileName: 'download', origin: null, agentName: null, startedAt: this.now(), bytes: 0, state: 'held', notice: { told: false } }
      row.handle = `dl_${row.id.replace(/-/g, '').slice(0, 4)}`
      rows.set(row.id, row)
      await this._keepUnlocked(key, row, file, 'unnamed')
    }
    for (const row of [...rows.values()]) if (row.state === 'failed' && row.guid) rmQuiet(path.join(p.held, `${row.guid}${PARTIAL}`), this.fs)
  }

  // The bodies of keep and give for callers already holding the lock.
  async _keepUnlocked(key, row, file, reason) {
    let bytes = 0
    try {
      bytes = this.fs.statSync(file).size
    } catch {}
    row.bytes = bytes
    const p = this.paths(key)
    // An unsafe folder never loses the file: it stays held for a later start.
    if (!this.guard.verify()) return
    this.fs.mkdirSync(p.kept, { recursive: true, mode: 0o700 })
    if (!plainFolderUnder(p.kept, this.root, this.fs)) return
    const limit = this.limitFor(bytes)
    if (limit) {
      rmQuiet(file, this.fs)
      Object.assign(row, { state: 'deleted', reason: 'not_kept', limit })
      return
    }
    await renameRetry(file, path.join(p.kept, row.id), this.fs)
    if (this.platform !== 'win32') {
      try {
        this.fs.chmodSync(path.join(p.kept, row.id), 0o600)
      } catch {}
    }
    Object.assign(row, { state: 'kept', keptReady: true, keptReason: reason, keptUntil: this.now() + this.keepMs, guid: null, notice: { told: false } })
  }

  async _giveUnlocked(key, row, file) {
    const dir = this.outputDir(key)
    this.fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!plainFolderUnder(dir, this.agentDir, this.fs)) throw Object.assign(new Error('output folder is not plain'), { code: 'EFOLDER' })
    const target = await placeUnique(file, dir, saveName(row.fileName), this.fs)
    Object.assign(row, { state: 'saved', savedPath: target, guid: null })
  }

  stop() {
    this._stopped = true
  }
}

// ── One browser session's downloads ───────────────────────────────────────────

/**
 * The downloads of one browser session (one agent and person). The engine
 * hands every Playwright download here (context 'download'); nothing else in
 * the host saves one. Every path below ends in a state the agent can read.
 */
export class SlotDownloads {
  constructor({ store, key, gates, gateKey, context = /** @type {() => { agentName?: string | null, purpose?: string | null }} */ (() => ({})), decide, remember = /** @type {(origin: string | null, choice: string) => void} */ (() => {}), ownerControl = () => false, choices, originOf = /** @type {(url: string) => string | null} */ (plainOrigin), graceMs = DOWNLOAD_GRACE_MS, heldPollMs = HELD_POLL_MS, unclaimedAfterMs = UNCLAIMED_AFTER_MS, log = /** @type {(line: string) => void} */ (() => {}), fsImpl = /** @type {any} */ (fs) }) {
    this.store = store
    this.key = key
    this.gates = gates
    this.gateKey = gateKey
    this.context = context
    this.decide = decide
    this.remember = remember
    this.ownerControl = ownerControl
    this.choices = choices
    this.originOf = originOf
    this.graceMs = graceMs
    this.heldPollMs = heldPollMs
    this.unclaimedAfterMs = unclaimedAfterMs
    this.fs = fsImpl
    this._log = log
    this.paths = store.paths(key)
    this.records = []
    this.seq = 0
    this._closing = false
    this._timer = null
    this._firstSeen = new Map()
  }

  log(line) {
    try {
      this._log(line)
    } catch {}
  }

  /** The Downloads rows for status: this session's and this person's still kept ones. */
  rows() {
    return this.store.rows(this.key)
  }

  /** The download an ask or a notice card is about, if a gate id is one. */
  forGate(gateId) {
    if (!gateId) return null
    return this.records.find((r) => r.askGateId === gateId || r.notice?.gateId === gateId) ?? null
  }

  /** The downloads that began after `seq` (for the reply of the call that started them). */
  since(seq) {
    return this.records.slice(seq)
  }

  onDownload(download) {
    const row = this._row(download)
    this.records.push(row)
    this.seq = this.records.length
    try {
      this._start(row)
    } catch (err) {
      this.log(`downloads: ${row.handle}: could not start (${err?.code || 'error'})`)
      this._detach(row, this._discard(row, 'deleted', 'downloads_off'))
    }
    return row
  }

  _row(download) {
    const id = randomUUID()
    const abs = download?._artifact?._initializer?.absolutePath
    const heldPath = typeof abs === 'string' && path.dirname(abs) === this.paths.held && GUID.test(path.basename(abs)) ? abs : null
    let url = ''
    try {
      url = String(download.url())
    } catch {}
    let origin = this.originOf(url)
    if (!origin) {
      try {
        origin = this.originOf(download.page()?.url())
      } catch {}
    }
    let name = 'download'
    try {
      name = download.suggestedFilename()
    } catch {}
    const ctx = this._ctx()
    const handle = this._handle(id)
    return { id, key: this.key, handle, fileName: cleanFileName(name), origin: origin ?? null, agentName: ctx.agentName ?? null, startedAt: Date.now(), bytes: 0, state: 'asking', guid: heldPath ? path.basename(heldPath) : null, heldPath, download, notice: { told: false } }
  }

  _handle(id) {
    const hex = id.replace(/-/g, '')
    const taken = new Set(this.store.rows(this.key).map((r) => r.handle))
    for (let n = 4; n < 32; n += 2) if (!taken.has(`dl_${hex.slice(0, n)}`)) return `dl_${hex.slice(0, n)}`
    return `dl_${hex}`
  }

  _ctx() {
    try {
      return this.context() || {}
    } catch {
      return {}
    }
  }

  /** A detached step: its failure is a fixed line in the host log, never an unhandled rejection. */
  _detach(row, work) {
    Promise.resolve(work).catch((err) => {
      this.log(`downloads: ${row.handle}: ${err?.code || 'error'}`)
      if (!TERMINAL.has(row.state) && !(row.state === 'kept' && row.keptReady !== false)) {
        this._discard(row, 'failed').catch(() => {})
      }
    })
  }

  _start(row) {
    if (!row.heldPath || !this.store.guard.ready || !this.store.guard.verify()) {
      // Playwright did not say where Chrome writes it, or the folder is not
      // safe: refused, and nothing is written about it in that folder.
      this.store.track(this.key, row, { persist: false })
      this._detach(row, this._discard(row, 'deleted', 'downloads_off'))
      return
    }
    this.store.track(this.key, row)
    this.watch()
    if (this._ownerHolds()) {
      row.owner = true
      this._detach(row, this._keepWhenDone(row, 'owner_download'))
      return
    }
    const undecided = this.records.filter((r) => r.state === 'asking').length
    if (undecided > this.store.limits.sessionFiles) {
      this._detach(row, this._discard(row, 'deleted', 'too_many'))
      return
    }
    const decision = this._decide(row)
    if (decision.verdict === 'allow') {
      row.state = 'saving'
      row.allowed = true
      this.store.changed(this.key)
      this._detach(row, this._saveWhenDone(row))
      return
    }
    if (decision.verdict === 'deny') {
      this._detach(row, this._discard(row, 'deleted', 'rule'))
      return
    }
    this._detach(row, this._ask(row))
  }

  _ownerHolds() {
    try {
      return this.ownerControl() === true
    } catch {
      return false
    }
  }

  _decide(row) {
    try {
      return this.decide(row.origin) || { verdict: 'ask' }
    } catch {
      return { verdict: 'ask' }
    }
  }

  /** Would no answer keep it: the folder is safe and it fits the limits as it stands. */
  _keepable(row) {
    if (row.overLimit || !this.store.guard.verify()) return false
    return this.store.limitFor(row.bytes || 0, this._session()) === null
  }

  _session() {
    let files = 0
    let bytes = 0
    for (const r of this.records) {
      if (r.state === 'kept' && r.keptReady !== false) {
        files++
        bytes += r.bytes || 0
      }
    }
    return { files, bytes }
  }

  async _ask(row) {
    for (let round = 0; round < 100; round++) {
      await this.gates.whenIdle(this.gateKey)
      if (row.state !== 'asking' || this._closing) return
      const decision = this._decide(row)
      if (decision.verdict === 'allow') {
        row.state = 'saving'
        row.allowed = true
        this.store.changed(this.key)
        return this._saveWhenDone(row)
      }
      if (decision.verdict === 'deny') return this._discard(row, 'deleted', 'rule')
      this._sizeNow(row)
      const ctx = this._ctx()
      const out = await this.gates.raise({
        key: this.gateKey,
        assistantId: this.store.assistantId,
        kind: 'download',
        origin: row.origin,
        summary: askSummary({ fileName: row.fileName, device: this.store.deviceLabel, agentName: ctx.agentName, displayDir: this.store.displayOutputDir(this.key), keepable: this._keepable(row), fileLimit: this.store.limits.fileBytes }),
        agentName: ctx.agentName ?? null,
        purpose: ctx.purpose ?? null,
        waitSeconds: DOWNLOAD_ASK_WAIT_S,
        choices: this.choices,
        action: null,
        attachMs: Infinity,
        onRaised: (gate) => {
          row.askGateId = gate.gateId
        },
      })
      // Another ask opened between the browser going idle and this one: wait again.
      if (out?.parked) continue
      return this._answered(row, out)
    }
    return this._answered(row, { allowed: false, reason: 'gate_timeout' })
  }

  async _answered(row, out) {
    if (row.state !== 'asking') return
    if (out?.allowed && this.choices.includes(out.choice) && out.choice !== 'deny') {
      try {
        this.remember(row.origin, out.choice)
      } catch {}
      row.state = 'saving'
      row.allowed = true
      this.store.changed(this.key)
      return this._saveWhenDone(row)
    }
    // Only the owner's Deny deletes. A timeout, a lost card, an answer this
    // host cannot read and a host that stops are no answer: the file is kept.
    if (out?.choice === 'deny') return this._discard(row, 'deleted', 'owner_denied')
    return this._keepWhenDone(row, 'no_answer')
  }

  async _finished(row) {
    let failure = 'failed'
    try {
      failure = await row.download.failure()
    } catch {}
    return !failure
  }

  async _saveWhenDone(row) {
    if (!(await this._finished(row))) return row.state === 'saving' ? this._discard(row, 'failed') : undefined
    if (row.state !== 'saving') return
    try {
      await this._give(row)
    } catch (err) {
      // The output folder could not take it (a link, a full disk): the owner
      // said yes, so it is kept for them rather than lost.
      this.log(`downloads: ${row.handle}: could not be put in the output folder (${err?.code || 'error'}); keeping it`)
      Object.assign(row, { state: 'kept', keptReason: 'save_failed', keptReady: false })
      return this._keepNow(row, 'save_failed')
    }
  }

  async _keepWhenDone(row, reason) {
    Object.assign(row, { state: 'kept', keptReason: reason, keptReady: false })
    if (!(await this._finished(row))) {
      if (row.state === 'kept' && row.keptReady === false) return this._discard(row, 'failed')
      return
    }
    if (row.state !== 'kept' || row.keptReady !== false) return
    return this._keepNow(row, reason)
  }

  /**
   * Keep it, ONCE: the no answer path and a closing session can both reach
   * here for one download, and a second keep would find the file already
   * moved and call it deleted.
   */
  _keepNow(row, reason) {
    if (!row.keeping) {
      row.keeping = (async () => {
        const result = await this.store.keep(this.key, row, row.heldPath, reason, this._session())
        if (!result.kept && result.limit === 'folder') {
          // The private folder cannot be trusted right now: the file is never
          // deleted for that; it stays held, inside the agent folder, and the
          // next start settles it.
          Object.assign(row, { state: 'held', keptReady: undefined })
          this.store.changed(this.key)
          return
        }
        if (!result.kept) return this._discard(row, 'deleted', 'not_kept', result.limit)
        this.store.tell(this.key, row)
      })()
    }
    return row.keeping
  }

  /** Save it into the output folder, ONCE (as _keepNow). */
  _give(row) {
    if (!row.giving) row.giving = this.store.give(this.key, row, row.heldPath)
    return row.giving
  }

  /** Cancel, delete every byte, end its ask, and say why. */
  async _discard(row, state, reason, limit) {
    const wasAsking = row.state === 'asking'
    Object.assign(row, { state, ...(reason ? { reason } : {}), ...(limit ? { limit } : {}), keptReady: undefined })
    // Written down as owed a delete BEFORE the cancel and the delete: a crash
    // in between deletes it at the next start, never keeps it.
    if (row.heldPath) row.doomed = true
    this.store.changed(this.key)
    if (wasAsking && row.askGateId) this.gates.end?.(row.askGateId, { allowed: false, reason: 'download_ended' })
    try {
      await Promise.race([row.download?.cancel?.(), sleepMs(2000)])
    } catch {}
    if (row.heldPath) {
      const gone = (await rmRetry(row.heldPath, this.fs)) && (await rmRetry(`${row.heldPath}${PARTIAL}`, this.fs))
      // Windows would not let it go: it stays recorded, so it is never adopted
      // as kept, and it is deleted again at the next start.
      if (gone) row.doomed = false
    }
    this.store.changed(this.key)
  }

  /** The size of a held download as it arrives. */
  _sizeNow(row) {
    if (!row.heldPath) return 0
    for (const f of [row.heldPath, `${row.heldPath}${PARTIAL}`]) {
      try {
        row.bytes = this.fs.statSync(f).size
        row.done = f === row.heldPath
        return row.bytes
      } catch {}
    }
    return row.bytes || 0
  }

  /** Watch the held folder for the life of the session (bytes as they arrive, files nobody claimed). */
  watch() {
    if (this._timer || this._closing || this._stopped) return
    this._timer = setInterval(() => {
      try {
        this._tick()
      } catch (err) {
        this.log(`downloads: the held folder could not be read (${err?.code || 'error'})`)
      }
    }, this.heldPollMs)
    this._timer.unref?.()
  }

  /**
   * Bytes while they arrive. Playwright cannot pause a transfer, so the held
   * folder is watched: an undecided file past the per file limit is no longer
   * promised to be kept, and past the agent's ceiling the newest undecided
   * download is cancelled. A finished file no download claimed is adopted.
   */
  _tick() {
    const live = this.records.filter((r) => r.state === 'asking' || r.state === 'saving' || (r.state === 'kept' && r.keptReady === false))
    for (const r of live) this._sizeNow(r)
    const undecided = live.filter((r) => r.state === 'asking' || (r.state === 'kept' && r.keptReady === false))
    for (const r of undecided) if ((r.bytes || 0) > this.store.limits.fileBytes) r.overLimit = 'file'
    let total = this.store.totals().bytes + undecided.reduce((n, r) => n + (r.bytes || 0), 0)
    const newestFirst = [...undecided].sort((a, b) => b.startedAt - a.startedAt || this.records.indexOf(b) - this.records.indexOf(a))
    for (const r of newestFirst) {
      if (total <= this.store.limits.totalBytes) break
      total -= r.bytes || 0
      this._detach(r, this._discard(r, 'deleted', 'not_kept', 'total'))
    }
    this._adoptUnclaimed(false)
  }

  _unclaimedNames() {
    let names = []
    try {
      names = this.fs.readdirSync(this.paths.held)
    } catch {
      return []
    }
    // Claimed by this session, or by any row the store keeps for this person
    // (another session's download still being decided, a file owed a delete).
    const claimed = new Set([...this.records.map((r) => r.guid).filter(Boolean), ...this.store.claimedGuids(this.key)])
    return names.filter((n) => !claimed.has(n.endsWith(PARTIAL) ? n.slice(0, -PARTIAL.length) : n))
  }

  /** A file Chrome wrote that no download event claimed: kept and its owner told, never left silent. */
  _adoptUnclaimed(now) {
    // An unsafe folder adopts nothing and deletes nothing: the next start settles it.
    if (!this.store.guard.verify()) return
    for (const name of this._unclaimedNames()) {
      const file = path.join(this.paths.held, name)
      if (name.endsWith(PARTIAL) || !GUID.test(name)) {
        if (now) rmQuiet(file, this.fs)
        continue
      }
      const seen = this._firstSeen.get(name) ?? Date.now()
      this._firstSeen.set(name, seen)
      if (!now && Date.now() - seen < this.unclaimedAfterMs) continue
      const row = { id: randomUUID(), key: this.key, handle: '', fileName: 'download', origin: null, agentName: this._ctx().agentName ?? null, startedAt: Date.now(), bytes: 0, state: 'kept', keptReason: 'unnamed', keptReady: false, guid: name, heldPath: file, download: null, notice: { told: false } }
      row.handle = this._handle(row.id)
      this.records.push(row)
      this.seq = this.records.length
      this.store.track(this.key, row)
      this._detach(row, this._keepNow(row, 'unnamed'))
    }
  }

  /**
   * Before the browser closes (stop, idle, Chrome gone, host stop): every
   * undecided download that finishes within the grace is kept for the owner
   * and its ask is ended; one still arriving is cancelled and deleted. An
   * allowed one is saved or, unfinished, cancelled. Then nothing is left in
   * held/ that nobody owns.
   */
  async drain(reason = 'session_closed') {
    this._closing = true
    const until = Date.now() + this.graceMs
    const settle = async (row) => {
      const left = Math.max(0, until - Date.now())
      const finished = await Promise.race([this._finished(row), sleepMs(left).then(() => false)])
      if (row.state === 'asking') {
        if (row.askGateId) this.gates.end?.(row.askGateId, { allowed: false, reason: 'session_closed' })
        if (!finished) return this._discard(row, 'deleted', 'session_closed')
        Object.assign(row, { state: 'kept', keptReason: reason, keptReady: false })
        return this._keepNow(row, reason)
      }
      if (row.state === 'kept' && row.keptReady === false) {
        if (!finished) return this._discard(row, 'deleted', 'session_closed')
        return this._keepNow(row, row.keptReason || reason)
      }
      if (row.state === 'saving') {
        if (!finished) return this._discard(row, 'failed')
        return this._give(row)
      }
    }
    const pending = this.records.filter((r) => r.download && (r.state === 'asking' || r.state === 'saving' || (r.state === 'kept' && r.keptReady === false)))
    await Promise.all(pending.map((r) => settle(r).catch((err) => this.log(`downloads: ${r.handle}: ${err?.code || 'error'} at close`))))
    try {
      this._adoptUnclaimed(true)
      await this.store.withLock(() => {})
    } catch (err) {
      this.log(`downloads: the held folder could not be settled at close (${err?.code || 'error'})`)
    }
    this.stop()
  }

  stop() {
    this._stopped = true
    if (this._timer) clearInterval(this._timer)
    this._timer = null
  }
}
