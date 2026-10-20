/**
 * win32-script-text: ASCII-only string expressions for the scripts generated
 * on Windows. WSH reads a .vbs as ANSI unless it is UTF-16 with a BOM, and
 * Windows PowerShell 5.1 reads a .ps1 with no BOM in the ANSI code page. The
 * files are written as BOM-less UTF-8, so an accented profile name or an Arabic
 * agent folder came out as mojibake: the task registered, then never started
 * (and `schtasks /Run` reported success every time). Every path in a generated
 * file goes through vbsString or psString instead, so the file is pure ASCII
 * whatever the paths hold, and an all-ASCII path is exactly the literal it
 * always was.
 *
 * Shared by the agent task (lib/agent-task-win32.mjs: run-agent.vbs,
 * install-agent-task.ps1) and the watcher's own service (lib/watcher-service.mjs:
 * run-hidden.vbs, install-task.ps1). A LEAF on purpose: it imports nothing, so
 * the watcher service does not pull agent-inventory into its import graph. It
 * ships in WATCHER_BUNDLE_FILES (lib/watcher-bundle.mjs).
 *
 * Plain JavaScript, no imports, import-safe.
 */

/** Printable ASCII, the only bytes every Windows reader decodes the same way. */
function isPlainAscii(code) {
  return code >= 0x20 && code <= 0x7e
}

/**
 * A VBScript string EXPRESSION for any text, written in ASCII only: runs of
 * printable ASCII in a "literal" (a quote doubled), every other UTF-16 unit as
 * ChrW(n), joined with &. VBScript's & always concatenates strings, so a ChrW
 * may come first.
 * @param {string} text
 */
export function vbsString(text) {
  const parts = []
  let run = ''
  const value = String(text)
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (isPlainAscii(code)) {
      run += value[i] === '"' ? '""' : value[i]
      continue
    }
    if (run) parts.push(`"${run}"`)
    run = ''
    parts.push(`ChrW(${code})`)
  }
  if (run || parts.length === 0) parts.push(`"${run}"`)
  return parts.join(' & ')
}

/**
 * The PowerShell twin of vbsString: 'literal' runs (a quote doubled) and
 * [char]0xNNNN units, joined with + inside parentheses; an all-ASCII path is
 * the plain single-quoted literal it always was.
 * @param {string} text
 */
export function psString(text) {
  const parts = []
  let run = ''
  const value = String(text)
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (isPlainAscii(code)) {
      run += value[i] === "'" ? "''" : value[i]
      continue
    }
    if (run) parts.push(`'${run}'`)
    run = ''
    parts.push(`[char]0x${code.toString(16).toUpperCase().padStart(4, '0')}`)
  }
  if (run || parts.length === 0) parts.push(`'${run}'`)
  // PowerShell's + takes its meaning from the LEFT operand: [char] + [char] is
  // an int, and a lone [char] is not a string. An empty literal first makes
  // every + a string concatenation (absolute paths start with a drive letter or
  // a UNC prefix, but the function must not depend on that).
  if (parts[0].startsWith('[char]')) parts.unshift("''")
  return parts.length === 1 ? parts[0] : `(${parts.join(' + ')})`
}
