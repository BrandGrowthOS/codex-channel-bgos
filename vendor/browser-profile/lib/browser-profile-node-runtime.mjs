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
