import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto'
import { constants, lstatSync, mkdirSync, chmodSync, closeSync, fstatSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { hostname } from 'node:os'
import { connect } from 'node:net'
import { execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const derive = promisify(scrypt)
const FILE = 'agent-browser.vault.json'
const POLICY = 'agent-browser.settings.json'
const LEGACY = new Set(['Default', 'Local State', 'First Run', 'Last Version', 'Variations', 'DevToolsActivePort',
  'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'Crashpad', 'BrowserMetrics', 'ShaderCache', 'GrShaderCache',
  'GraphiteDawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Safe Browsing', 'component_crx_cache',
  'extensions_crx_cache', 'OptimizationHints', 'segmentation_platform', 'WidevineCdm', 'hyphen-data',
  'CertificateRevocation', 'PKIMetadata', 'TrustTokenKeyCommitments', 'ZxcvbnData', 'OriginTrials',
  'FileTypePolicies', 'SSLErrorAssistant', 'MEIPreload', 'Subresource Filter', 'PrivacySandboxAttestationsPreloaded'])
const MAX_BYTES = 16 * 1024 * 1024
const KDF = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const fail = code => Object.assign(new Error(code), { code })
const emptyState = () => ({ cookies: [], origins: [] })
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const encoded = (value, length) => typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').length === length
const protectedWindowsDirectories = new Map()

// Why a profile folder is refused, in words its owner can act on. The message
// reaches the agent (and through it the owner), so it never names a path, an
// account or a Windows error; `detail` carries those for the host's own log.
const PROFILE_REFUSALS = {
  alias: folder => `${folder} is a link or not a plain folder. Use a plain folder.`,
  owner_foreign: folder => `${folder} belongs to another account. Make the agent's own account its owner (on Windows, Full control of the folder for the agent's account lets the browser take it over), then try again.`,
  owner_not_set: folder => `Windows did not let the agent's account become the owner of ${folder}, and the folder could not be checked instead. Give the agent's account Full control of the folder, then try again.`,
  other_writer: folder => `another account can write to ${folder}. Remove that access, or on Windows give the agent's account Full control of the folder so the browser can lock the others out, then try again.`,
  not_private: folder => `${folder} could not be made private to the agent's account. Check the folder's permissions, then try again.`,
  acl_step_failed: folder => `the Windows permission step for ${folder} did not finish (PowerShell). Try again, and if it keeps failing check that PowerShell runs for the agent's account.`,
}
const PROFILE = 'the browser profile folder', ABOVE_PROFILE = 'a folder above the browser profile folder'
const refuse = (reason, detail, folder = PROFILE) => Object.assign(new Error(`unsafe_profile: ${PROFILE_REFUSALS[reason](folder)} The browser host log has the details.`),
  { code: 'unsafe_profile', reason, detail })

// Access bits that only read, list or traverse: FILE_READ_DATA, FILE_READ_EA,
// FILE_TRAVERSE, FILE_READ_ATTRIBUTES, READ_CONTROL, SYNCHRONIZE, GENERIC_READ
// and GENERIC_EXECUTE. Any other bit, known or not, lets an account change the
// folder, what is in it, its access list or its owner. Inherit-only entries
// count too: they hand that access to everything made in the folder.
const READ_ONLY_RIGHTS = 0xA01200A9
// ACCESS_DENIED and its object, callback and callback object forms. A deny lets
// no one in; any other entry type counts as an allow.
const DENY_ENTRIES = new Set([1, 6, 10, 12])
const otherWriter = (entry, me) => !DENY_ENTRIES.has(entry?.type) && entry?.sid !== me &&
  (!Number.isInteger(entry?.mask) || ((entry.mask >>> 0) & ~READ_ONLY_RIGHTS) !== 0)
const accounts = entries => [...new Set(entries.map(entry => entry?.name || entry?.sid || 'an entry with no account'))].join(', ')

// The vault's access list is one entry, the user's own Full control, so its
// allow-list is the user alone: SYSTEM and Administrators are other accounts.
function windowsOwnershipRefusal({ me, owner, dacl }) {
  if (typeof me !== 'string' || !me || typeof owner !== 'string' || !owner) return 'owner_not_set'
  if (owner !== me) return 'owner_foreign'
  if (dacl === null) return 'other_writer' // no access list at all lets everyone in
  if (!Array.isArray(dacl)) return 'owner_not_set'
  return dacl.some(entry => otherWriter(entry, me)) ? 'other_writer' : null
}

// powershell -Command - runs stdin one line at a time and goes on after an
// error, so each step catches its own and the last line always answers: the
// user, whether the access list was written and, when it was not (or after a
// lock without SetOwner), the folder's owner and every entry of its access
// list, whatever the entry type (GetAccessRules leaves out object and custom
// entries). A folder that takes the owner reads nothing back, as before.
// PowerShell reads stdin in the console code page, so the script stays ASCII:
// the folder arrives as UTF-16 in base64 (no quoting either), and non-ASCII
// in the answer is escaped.
function windowsAclScript(directory, setOwner) {
  const target = Buffer.from(directory, 'utf16le').toString('base64')
  return ["$ErrorActionPreference = 'Stop'", `$target = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${target}'))`, '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
    '$acl = New-Object System.Security.AccessControl.DirectorySecurity', ...(setOwner ? ['$acl.SetOwner($identity.User)'] : []),
    '$acl.SetAccessRuleProtection($true, $false)',
    "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity.User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')",
    '$acl.AddAccessRule($rule)',
    '$answer = @{ me = $identity.User.Value; set = $false }',
    'try { [System.IO.Directory]::SetAccessControl($target, $acl); $answer.set = $true } catch { $answer.error = $_.Exception.Message }',
    `$read = ${setOwner ? '-not $answer.set' : '$true'}`,
    '$name = { param($sid) try { $sid.Translate([System.Security.Principal.NTAccount]).Value } catch { $sid.Value } }',
    "if ($read) { try { $answer.meName = $identity.Name; $sd = New-Object System.Security.AccessControl.RawSecurityDescriptor(([System.IO.Directory]::GetAccessControl($target, 'Access,Owner')).GetSecurityDescriptorBinaryForm(), 0); " +
      '$answer.owner = $sd.Owner.Value; $answer.ownerName = & $name $sd.Owner; $answer.protected = [bool]($sd.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected); ' +
      '$answer.dacl = $null; if ($null -ne $sd.DiscretionaryAcl) { $answer.dacl = @(foreach ($ace in $sd.DiscretionaryAcl) { $known = $ace -is [System.Security.AccessControl.KnownAce]; ' +
      '@{ type = [int]$ace.AceType; flags = [int]$ace.AceFlags; mask = $(if ($known) { [int]$ace.AccessMask } else { $null }); sid = $(if ($known) { $ace.SecurityIdentifier.Value } else { $null }); name = $(if ($known) { & $name $ace.SecurityIdentifier } else { $null }) } }) } ' +
      '} catch { $answer.readError = $_.Exception.Message } }',
    "[Console]::Out.WriteLine([regex]::Replace((ConvertTo-Json $answer -Compress -Depth 4), '[^\\u0000-\\u007F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value }))",
  ].join('\n') + '\n'
}

function runWindowsAclScript(script) {
  let output
  try { output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, timeout: 10000 }) }
  catch (error) { return { failed: error.code === 'ETIMEDOUT' ? 'PowerShell did not finish within 10 s' : `PowerShell failed (${error.code || `exit ${error.status}`})` } }
  try { return JSON.parse(output.split(/\r?\n/).filter(line => line.startsWith('{')).pop()) }
  catch { return { failed: 'PowerShell gave no readable answer' } }
}

/**
 * @param {string} directory
 * @param {{ ino: number | bigint }} stat
 * @param {(script: string) => any} [run]
 */
export function protectWindowsDirectory(directory, stat, run = runWindowsAclScript) {
  if (protectedWindowsDirectories.get(directory) === stat.ino) return
  // No passphrase, vault data or caller code enters this process. Restrict the
  // fixed profile directory to its current Windows identity and inherited files.
  const first = run(windowsAclScript(directory, true))
  if (first.set !== true) {
    // Setting the owner needs WRITE_OWNER, which Modify alone does not give,
    // not even to the folder's owner. A folder that is already the user's own
    // and that no other account can write gets the same access list without
    // SetOwner (an owner may write that list unless an OWNER RIGHTS entry
    // says otherwise), read back before it is accepted. Anything else is
    // refused, and says why.
    const reason = first.failed ? 'acl_step_failed' : windowsOwnershipRefusal(first)
    const me = first.meName || first.me, refused = `Windows refused to make ${me} its owner (${first.error})`
    if (reason === 'acl_step_failed') throw refuse(reason, first.failed)
    if (reason === 'owner_foreign') throw refuse(reason, `${directory} belongs to ${first.ownerName || first.owner}, not to ${me}; ${refused}`)
    if (reason === 'other_writer') throw refuse(reason, `${first.dacl === null ? 'everyone (no access list)' : accounts(first.dacl.filter(entry => otherWriter(entry, first.me)))} can write to ${directory}; ${refused}`)
    if (reason) throw refuse(reason, `${refused}, and its owner and access list could not be read (${first.readError || 'no answer'})`)
    const second = run(windowsAclScript(directory, false))
    if (second.failed) throw refuse('acl_step_failed', second.failed)
    const locked = second.set === true && second.owner === first.me && second.protected === true && Array.isArray(second.dacl) && second.dacl.length === 1 &&
      second.dacl[0]?.type === 0 && second.dacl[0].sid === first.me && second.dacl[0].flags === 3 && (second.dacl[0].mask >>> 0) === 0x1F01FF
    if (!locked) throw refuse('not_private', second.set === true ? `${directory} reads back as owner ${second.ownerName || second.owner}, ${second.protected ? '' : 'not '}protected, entries for ${accounts(second.dacl || [])}` : `the access list of ${directory} could not be limited to ${me} (${second.error})`)
  }
  protectedWindowsDirectories.set(directory, stat.ino)
}

// Only the fixed profile selected by BrowserPool reaches this module. Reject
// aliases and symlinks before creating or opening anything under that profile.
export function secureProfileDir(directory) {
  const absolute = resolve(directory)
  let current = absolute
  while (true) {
    try {
      const st = lstatSync(current)
      const folder = current === absolute ? PROFILE : ABOVE_PROFILE
      if (!st.isDirectory() || st.isSymbolicLink()) throw refuse('alias', `${current} is ${st.isSymbolicLink() ? 'a link' : 'not a folder'}`, folder)
      if (process.platform !== 'win32' && st.uid !== 0 && st.uid !== process.getuid()) throw refuse('owner_foreign', `${current} belongs to uid ${st.uid}`, folder)
      if (process.platform !== 'win32' && (st.mode & 0o022) && !(st.uid === 0 && (st.mode & 0o1000))) {
        throw refuse('other_writer', `${current} can be written by its group or by everyone (mode ${(st.mode & 0o7777).toString(8)})`, folder)
      }
    }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const parent = dirname(current); if (parent === current) break; current = parent
  }
  mkdirSync(absolute, { recursive: true, mode: 0o700 })
  const st = lstatSync(absolute)
  if (st.isSymbolicLink() || !st.isDirectory()) throw refuse('alias', `${absolute} is ${st.isSymbolicLink() ? 'a link' : 'not a folder'}`)
  const real = realpathSync(absolute)
  if (real !== absolute) throw refuse('alias', `${absolute} resolves to ${real}`)
  if (process.platform !== 'win32') {
    if (st.uid !== process.getuid()) throw refuse('owner_foreign', `${absolute} belongs to uid ${st.uid}`)
    chmodSync(absolute, 0o700)
    const mode = lstatSync(absolute).mode
    if (mode & 0o077) throw refuse('not_private', `${absolute} keeps mode ${(mode & 0o7777).toString(8)} after chmod 700`)
  } else protectWindowsDirectory(absolute, st)
  return absolute
}

function readVault(file) {
  let fd
  try {
    const link = lstatSync(file)
    if (link.isSymbolicLink()) throw fail('vault_unavailable')
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const st = fstatSync(fd)
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > MAX_BYTES * 2 ||
        (process.platform !== 'win32' && (st.uid !== process.getuid() || (st.mode & 0o077)))) throw fail('vault_unavailable')
    const envelope = JSON.parse(readFileSync(fd, 'utf8'))
    if (envelope.v !== 1 || !encoded(envelope.salt, 32) || !encoded(envelope.iv, 12) || !encoded(envelope.tag, 16) ||
        typeof envelope.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)) throw fail('vault_unavailable')
    return envelope
  } catch (error) { if (error.code === 'ENOENT') return null; throw fail('vault_unavailable') }
  finally { if (fd !== undefined) closeSync(fd) }
}

function validatedState(state) {
  if (!plain(state) || !Array.isArray(state.cookies) || !Array.isArray(state.origins) || Buffer.byteLength(JSON.stringify(state)) > MAX_BYTES) throw fail('invalid_browser_state')
  return structuredClone(state)
}

function validOrigin(origin) {
  try { const u = new URL(origin); return u.origin === origin && !u.username && !u.password &&
    (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) }
  catch { return false }
}

function validatedLogin(login) {
  if (!plain(login) || !validOrigin(login.origin) || typeof login.username !== 'string' || login.username.length > 512 ||
      typeof login.password !== 'string' || !login.password || login.password.length > 4096) throw fail('invalid_login')
  return { origin: login.origin, username: login.username, password: login.password }
}

/** Passphrase-encrypted agent state. No key or plaintext state is written. */
export class AgentBrowserVault {
  constructor({ profileDir, scope, snapshotMs = 2000 }) {
    this.dir = secureProfileDir(profileDir)
    this.file = join(this.dir, FILE)
    if (typeof scope !== 'string' || !scope || scope.length > 4096) throw fail('invalid_scope')
    this.scope = scope
    this.aad = Buffer.from(JSON.stringify({ v: 1, scope }))
    this.snapshotMs = snapshotMs
    this.key = null; this.salt = null; this.data = null; this.context = null
    this.tail = Promise.resolve(); this.timer = null; this.restoring = false; this.restored = false
    this.lastError = null
    this.epoch = 0; this.locking = false
    this.visitedOrigins = new Set(); this.trackedPages = new Map(); this.trackingContext = null; this.originOverflow = false
  }

  _legacyNames() { return readdirSync(this.dir).filter(name => name !== FILE && name !== POLICY && !/^\.agent-browser\.vault\.json\.[a-f0-9-]+\.tmp$/.test(name)) }
  status() { return { configured: !!readVault(this.file), unlocked: !!this.key, legacy: this._legacyNames().length > 0 } }
  bind(context) {
    this.context = context
    if (this.trackingContext === context) return
    this._stopTracking()
    this.trackingContext = context
    const rememberPage = page => {
      if (this.trackingContext !== context || this.trackedPages.has(page)) return
      const onFrame = frame => { if (this.trackingContext === context) this._rememberOrigin(frame.url()) }
      const onClose = () => { page.off?.('framenavigated', onFrame); this.trackedPages.delete(page) }
      this.trackedPages.set(page, { onFrame, onClose })
      for (const frame of page.frames()) onFrame(frame)
      page.on?.('framenavigated', onFrame); page.once?.('close', onClose)
    }
    const rememberWorker = worker => { if (this.trackingContext === context) this._rememberOrigin(worker.url()) }
    const onClose = () => { if (this.trackingContext === context) this._stopTracking() }
    this.trackingHandlers = { rememberPage, rememberWorker, onClose }
    context.on?.('page', rememberPage); context.on?.('serviceworker', rememberWorker); context.once?.('close', onClose)
    for (const page of context.pages?.() || []) rememberPage(page)
    for (const worker of context.serviceWorkers?.() || []) rememberWorker(worker)
  }

  _rememberOrigin(value) {
    let url
    try { url = new URL(value) } catch { return }
    if (!['https:', 'http:'].includes(url.protocol) || this.visitedOrigins.has(url.origin)) return
    if (this.visitedOrigins.size >= 1024) { this.originOverflow = true; return }
    this.visitedOrigins.add(url.origin)
  }

  _stopTracking() {
    const context = this.trackingContext, handlers = this.trackingHandlers
    this.trackingContext = null; this.trackingHandlers = null
    if (handlers) {
      context?.off?.('page', handlers.rememberPage); context?.off?.('serviceworker', handlers.rememberWorker); context?.off?.('close', handlers.onClose)
    }
    for (const [page, handlers] of this.trackedPages) {
      page.off?.('framenavigated', handlers.onFrame); page.off?.('close', handlers.onClose)
    }
    this.trackedPages.clear(); this.visitedOrigins.clear(); this.originOverflow = false
  }

  async _legacyActive() {
    const lock = join(this.dir, 'SingletonLock')
    try {
      const target = readlinkSync(lock), match = /^(.*)-(\d+)$/.exec(target)
      if (!match || match[1] !== hostname()) return true
      try { process.kill(Number(match[2]), 0); return true } catch (error) { if (error.code !== 'ESRCH') return true }
    } catch (error) { if (!['ENOENT', 'EINVAL', 'UNKNOWN'].includes(error.code)) return true }
    try {
      const st = lstatSync(join(this.dir, 'DevToolsActivePort'))
      if (!st.isFile() || st.isSymbolicLink() || st.size > 1024) return true
      const port = Number(readFileSync(join(this.dir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0])
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return true
      return await new Promise(resolve => {
        const socket = connect({ host: '127.0.0.1', port })
        const finish = active => { socket.destroy(); resolve(active) }
        socket.setTimeout(400, () => finish(true)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false))
      })
    } catch (error) { return error.code !== 'ENOENT' }
  }

  async _clearLegacy(epoch) {
    if (await this._legacyActive()) throw fail('legacy_browser_active')
    if (this.epoch !== epoch || this.locking) throw fail('vault_locked')
    secureProfileDir(this.dir)
    const names = this._legacyNames()
    if (names.some(name => !LEGACY.has(name))) throw fail('legacy_cleanup_required')
    for (const name of names) {
      const target = resolve(this.dir, name)
      if (dirname(target) !== this.dir || !target.startsWith(this.dir + sep)) throw refuse('alias', `${target} is not inside ${this.dir}`, 'a name in the browser profile folder')
      // Recursive deletion stays below this verified fixed profile. rm does
      // not follow symlinks; a native Chrome Singleton link is unlinked only.
      rmSync(target, { recursive: true, force: false })
    }
  }

  unlock(passphrase, options = {}) {
    const epoch = this.epoch
    return this._serial(() => this._unlock(passphrase, options, epoch))
  }

  async _unlock(passphrase, { clearLegacy = false } = {}, epoch) {
    if (this.epoch !== epoch || this.locking) throw fail('vault_locked')
    if (this.key) throw fail('vault_already_unlocked')
    if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024 || typeof clearLegacy !== 'boolean') throw fail('invalid_passphrase')
    const status = this.status()
    if (status.legacy && !clearLegacy) throw fail('legacy_consent_required')
    const envelope = readVault(this.file), salt = envelope ? Buffer.from(envelope.salt, 'base64') : randomBytes(32)
    const key = await derive(passphrase, salt, 32, KDF)
    try {
      if (this.epoch !== epoch || this.locking) throw fail('vault_locked')
      let data = { v: 1, scope: this.scope, state: emptyState(), logins: [] }
      if (envelope) {
        try {
          const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
          decipher.setAAD(this.aad); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
          data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'))
        } catch { throw fail('vault_unlock_failed') }
        if (data.v !== 1 || data.scope !== this.scope || !Array.isArray(data.logins) || data.logins.length > 1000) throw fail('vault_unavailable')
        validatedState(data.state)
        const ids = new Set()
        for (const row of data.logins) { validatedLogin(row); if (typeof row.id !== 'string' || ids.has(row.id)) throw fail('vault_unavailable'); ids.add(row.id) }
      }
      if (status.legacy) await this._clearLegacy(epoch)
      this.key = key; this.salt = salt; this.data = data; this.restored = false; this.fresh = !envelope
      if (!envelope) await this._write()
      return { unlocked: true }
    } catch (error) { key.fill(0); this.key = null; this.salt = null; this.data = null; throw error }
  }

  restore(context = this.context) { const epoch = this.epoch; return this._serial(() => this._restore(context, epoch)) }
  async _restore(context, epoch) {
    if (this.epoch !== epoch || this.locking) throw fail('vault_locked')
    this._unlocked(); if (!context) throw fail('browser_unavailable')
    if (this.trackingContext !== context) this.bind(context)
    this.restoring = true
    try {
      const state = validatedState(this.data.state)
      // setStorageState replaces Playwright's visited-origin registry. Retain
      // open SPA origins so writes after unlock are captured without a reload.
      // Empty entries clear old locked storage through Playwright's internally
      // intercepted restore pages, without navigating the owner's document.
      const origins = new Set(state.origins.map(entry => entry.origin))
      const pages = context.pages?.() || []
      for (const page of pages) for (const frame of page.frames()) this._rememberOrigin(frame.url())
      for (const worker of context.serviceWorkers?.() || []) this._rememberOrigin(worker.url())
      if (this.originOverflow) throw fail('invalid_browser_state')
      for (const origin of this.visitedOrigins) {
        if (!origins.has(origin)) {
          state.origins.push({ origin, localStorage: [], indexedDB: [] })
          origins.add(origin)
        }
      }
      if (origins.size > 1024) throw fail('invalid_browser_state')
      if (pages.length && origins.size) {
        const cdp = await context.newCDPSession(pages[0])
        try {
          // Page-level deleteDatabase can remain blocked by a site's live
          // handles. Chromium's storage reset force-closes those connections
          // before Playwright restores either empty or saved IndexedDB state.
          for (const origin of origins) await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'indexeddb' })
        } finally { await cdp.detach() }
      }
      await context.setStorageState(state)
      if (this.epoch !== epoch || this.locking) throw fail('vault_locked')
      this.context = context; this.restored = true; this.fresh = false
    }
    finally { this.restoring = false }
    clearInterval(this.timer)
    this.timer = setInterval(() => { void this.snapshot().catch(() => { this.lastError = 'vault_snapshot_failed' }) }, this.snapshotMs)
    this.timer.unref?.()
  }

  retainCurrent(context = this.context) {
    const epoch = this.epoch
    return this._serial(async () => {
      this._unlocked()
      if (!this.fresh || this.restored || !context || this.epoch !== epoch || this.locking) throw fail('vault_locked')
      // First-time owner setup keeps the sign-in already in this context.
      // A configured vault always uses restore instead of adopting live state.
      const state = validatedState(await context.storageState({ indexedDB: true }))
      if (state.origins.length > 1024 || this.originOverflow) throw fail('invalid_browser_state')
      if (this.epoch !== epoch || this.locking) throw fail('vault_locked')
      this._unlocked(); this.data.state = state
      await this._write()
      if (this.epoch !== epoch || this.locking) throw fail('vault_locked')
      this.context = context; this.restored = true; this.fresh = false
      clearInterval(this.timer)
      this.timer = setInterval(() => { void this.snapshot().catch(() => { this.lastError = 'vault_snapshot_failed' }) }, this.snapshotMs)
      this.timer.unref?.()
    })
  }

  _unlocked() { if (!this.key || !this.data || this.locking) throw fail('vault_locked') }
  _serial(work) { const task = this.tail.then(work); this.tail = task.catch(() => {}); return task }
  async _write() {
    this._unlocked(); secureProfileDir(this.dir); readVault(this.file)
    const epoch = this.epoch
    const body = Buffer.from(JSON.stringify(this.data))
    if (body.length > MAX_BYTES) throw fail('vault_full')
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(this.aad)
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]); body.fill(0)
    const encodedBody = JSON.stringify({ v: 1, salt: this.salt.toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })
    const tmp = join(this.dir, `.${FILE}.${randomUUID()}.tmp`)
    let handle
    try {
      handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600)
      await handle.writeFile(encodedBody); await handle.sync(); await handle.close(); handle = null
      if (this.epoch !== epoch || this.locking) throw fail('vault_locked')
      await rename(tmp, this.file)
    } catch { throw fail('vault_write_failed') }
    finally { await handle?.close().catch(() => {}); await unlink(tmp).catch(() => {}) }
  }

  snapshot() { return this._serial(async () => {
    if (!this.key || !this.context || this.restoring || !this.restored || this.locking) return
    const before = this.data.state
    try {
      const state = await this.context.storageState({ indexedDB: true })
      this._unlocked(); this.data.state = validatedState(state); await this._write(); this.lastError = null
    } catch (error) { if (this.data) this.data.state = before; this.lastError = 'vault_snapshot_failed'; throw error }
  }) }
  list(origin) { this._unlocked(); return this.data.logins.filter(row => row.origin === origin).slice(0, 20).map(({ id, origin, username }) => ({ id, origin, username })) }
  readLogin(id, origin) { this._unlocked(); const row = this.data.logins.find(row => row.id === id && row.origin === origin); if (!row) throw fail('login_not_found'); return { ...row } }
  saveLogin(login) { return this._serial(async () => {
    this._unlocked(); const value = validatedLogin(login)
    const before = structuredClone(this.data.logins)
    const existing = this.data.logins.find(row => row.origin === value.origin && row.username === value.username)
    if (existing) Object.assign(existing, value)
    else { if (this.data.logins.length >= 1000) throw fail('vault_full'); this.data.logins.push({ id: randomUUID(), ...value }) }
    try { await this._write() } catch (error) { this.data.logins = before; throw error }
    return { saved: true }
  }) }
  removeLogin(id, origin) { return this._serial(async () => {
    this.readLogin(id, origin); const before = this.data.logins
    this.data.logins = this.data.logins.filter(row => row.id !== id || row.origin !== origin)
    try { await this._write() } catch (error) { this.data.logins = before; throw error }
    return { removed: true }
  }) }
  async lock() {
    this.epoch++; this.locking = true
    clearInterval(this.timer); this.timer = null
    await this.tail
    this.key?.fill(0); this.key = null; this.salt = null; this.data = null; this.context = null; this.restored = false
    this.locking = false
  }
}

export const browserVaultScope = ({ assistantId, principal }) => {
  if (!Number.isSafeInteger(assistantId) || assistantId <= 0 || typeof principal !== 'string' || !principal || principal.length > 256) throw fail('invalid_scope')
  return JSON.stringify({ assistantId, principal })
}
