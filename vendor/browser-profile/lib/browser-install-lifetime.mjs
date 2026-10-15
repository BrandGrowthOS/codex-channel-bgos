import { readFileSync, readdirSync } from 'node:fs'

export const installRecoveryRequired = () => Object.assign(new Error('Chromium installation cleanup is unconfirmed. Do not retry or delete its recovery marker while an installer may still be running. Stop this host and verify the original installer and downloader have ended before explicitly recovering the cache.'), { code: 'browser_install_recovery_required' })

function linuxStat(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
  if (text.length > 16384) throw new Error('invalid_process_identity')
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)
  return { pid, group: Number(fields[2]), session: Number(fields[3]), start: fields[19] }
}

/** Dependency seams are local unit fixtures; production always uses the fixed /proc and kernel operations below. */
export function createInstallerGroupProof({ readStat = linuxStat, list = () => readdirSync('/proc'), probe = group => process.kill(-group, 0) } = {}) {
  const valid = item => item && Number.isSafeInteger(item.pid) && item.pid > 0 && Number.isSafeInteger(item.group) && item.group > 0 && Number.isSafeInteger(item.session) && item.session > 0 && typeof item.start === 'string' && /^\d+$/.test(item.start)
  return {
    capture(child, platform = process.platform) {
      if (platform !== 'linux' || !Number.isSafeInteger(child.pid) || child.pid <= 0) return null
      try {
        const original = readStat(child.pid)
        return valid(original) && original.pid === child.pid && original.group === child.pid && original.session === child.pid ? Object.freeze(original) : null
      } catch { return null }
    },
    empty(original, platform = process.platform) {
      if (platform !== 'linux' || !valid(original) || original.group !== original.pid || original.session !== original.pid) return false
      try {
        const entries = list()
        if (!Array.isArray(entries) || entries.length > 65536) return false
        for (const name of entries) {
          if (!/^\d+$/.test(name)) continue
          let current
          try { current = readStat(Number(name)) } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; return false }
          if (!valid(current) || current.pid !== Number(name)) return false
          if (current.pid === original.pid && current.start !== original.start) return false
          if (current.group === original.group) return false
        }
        // /proc enumeration alone races forks. Signal 0 has no delivered effect; only kernel ESRCH proves absence.
        try { probe(original.group); return false } catch (error) { if (error.code !== 'ESRCH') return false }
        // Refuse a reused leader or any surviving original identity after the kernel observation.
        try { readStat(original.pid); return false } catch (error) { return error.code === 'ENOENT' || error.code === 'ESRCH' }
      } catch { return false }
    },
  }
}
const groupProof = createInstallerGroupProof()
export const captureInstallerGroup = (child, platform = process.platform) => groupProof.capture(child, platform)
export const installerGroupEmpty = (original, platform = process.platform) => groupProof.empty(original, platform)

/** Logical refusal never releases physical ownership. close + real EOF are required even after exit. */
export function trackBrowserInstaller({ child, timeoutMs, verifyInstalled, release, markUnknown, captureGroup = captureInstallerGroup, groupEmpty = installerGroupEmpty }) {
  let resolveResult, rejectResult, resolvePhysical, rejectPhysical
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  const physical = new Promise((resolve, reject) => { resolvePhysical = resolve; rejectPhysical = reject })
  result.catch(() => {}); physical.catch(() => {})
  let failed = false, settled = false, closed = false, spawned = false, originalGroup = null, cleanupUnknown = false, exitCode
  let stdoutEnd = false, stderrEnd = false, pipeFailure = false
  const refuse = () => {
    if (failed || settled) return
    failed = true; cleanupUnknown = true
    try { markUnknown() } catch {}
    rejectResult(installRecoveryRequired())
  }
  const pipe = (stream, end) => {
    if (!stream || typeof stream.once !== 'function' || typeof stream.resume !== 'function') { pipeFailure = true; refuse(); return }
    stream.once('end', end)
    stream.once('error', () => { pipeFailure = true; refuse() })
    // Drain and discard installer output; never copy it to logs or public errors.
    stream.resume()
  }
  pipe(child.stdout, () => { stdoutEnd = true })
  pipe(child.stderr, () => { stderrEnd = true })
  const timer = setTimeout(refuse, Math.max(1, Math.min(180000, timeoutMs)))
  timer.unref?.()
  child.once('spawn', () => { spawned = true; try { originalGroup = captureGroup(child) } catch {} })
  child.once('error', refuse)
  child.once('exit', (code, signal) => { exitCode = code; if (code !== 0 || signal != null) refuse() })
  child.once('close', (code, signal) => {
    if (closed) return
    closed = true; clearTimeout(timer)
    if (code !== 0 || signal != null || exitCode !== 0 || pipeFailure || !stdoutEnd || !stderrEnd) refuse()
    let normal = false
    if (!failed && spawned && code === 0 && exitCode === 0 && stdoutEnd && stderrEnd) {
      try { normal = verifyInstalled() === true } catch {}
      if (!normal) refuse()
    }
    let known = normal
    if (!known) {
      try { known = (!spawned && child.pid == null) || (stdoutEnd && stderrEnd && !pipeFailure && groupEmpty(originalGroup) === true) } catch {}
    }
    if (known) { try { known = release() === true } catch { known = false } }
    if (!known) { refuse(); settled = true; rejectPhysical(installRecoveryRequired()); return }
    settled = true; cleanupUnknown = false; resolvePhysical()
    if (normal) resolveResult()
  })
  return { result, physical, cancel: refuse, activity: () => ({ pendingPhysicalOperations: closed ? 0 : 1, cleanupUnknown }) }
}
