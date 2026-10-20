export const MINIMUM_BROWSER_NODE_VERSION = '22.12.0'

// Pure compatibility check. Importing the host must not load Playwright or
// start a browser, including when Codex imports its managed host classes.
export function assertBrowserNodeVersion(version = process.versions.node) {
  const match = typeof version === 'string' && /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(version)
  if (!match || Number(match[1]) < 22 || Number(match[1]) === 22 && Number(match[2]) < 12) {
    const code = 'profile_browser_node_unqualified'
    throw Object.assign(new Error('The agent browser requires Node.js 22.12.0 or newer. Install a current patched Node.js 22 or 24 LTS release.'), { code, reason: code })
  }
  return true
}

/**
 * The plain line a launcher prints when this Node is older than the floor, else null (0.72.0). Only the Agent
 * Browser needs 22.12.0: Playwright 1.64.1 and the managed profile runtime are qualified on Node 22 and 24, and 18
 * and 20 are end of life. The channel runs on bun, so nothing else stops; the browser host refuses its work with
 * assertBrowserNodeVersion's own sentence.
 */
export function nodeFloorNotice(version = process.versions.node) {
  try { assertBrowserNodeVersion(version); return null } catch {}
  const shown = typeof version === 'string' && version ? version : 'an unknown version'
  return `This machine runs Node.js ${shown}, and the HOAI Agent Browser needs Node.js ${MINIMUM_BROWSER_NODE_VERSION} or newer: install a current Node.js 22 or 24 LTS release from https://nodejs.org, then restart this agent.`
}
