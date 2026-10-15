import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const pin = JSON.parse(readFileSync(new URL('./browser-profile-launch.pin.json', import.meta.url), 'utf8'))
const fail = () => Object.assign(new Error('profile_browser_version_unqualified'), { reason: 'profile_browser_version_unqualified', code: 'profile_browser_version_unqualified' })

// Read the pinned installed bundle through a declared package export. Parse a
// literal string list, never evaluate package source or replace unknown flags.
export function profileLaunchArguments({ version = require('playwright-core/package.json').version, bundle = readFileSync(require.resolve(pin.bundleExport)) } = {}) {
  if (version !== pin.playwrightVersion || createHash('sha256').update(bundle).digest('hex') !== pin.bundleSha256) throw fail()
  const match = bundle.toString('utf8').match(/disabledFeatures = (\[[\s\S]*?\])\.filter\(Boolean\);/)
  if (!match) throw fail()
  let features
  try { features = JSON.parse(match[1].replace(/\/\/[^\r\n]*/g, '').replace(/,\s*\]/, ']')) } catch { throw fail() }
  if (!Array.isArray(features) || !features.length || features.some(value => typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9]+$/.test(value)) || new Set(features).size !== features.length) throw fail()
  const original = '--disable-features=' + features.join(',')
  const combined = '--disable-features=' + [...features, ...pin.uiFeaturesDisabled.filter(value => !features.includes(value))].join(',')
  return { ignoreDefaultArgs: [original], args: [combined] }
}
