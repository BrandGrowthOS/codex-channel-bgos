import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url), { exactAuthority, canonical } = require('./browser-profile-core/coordinator-client.js')
const entries = new Set(), holders = new WeakMap()
const fail = () => Object.assign(new Error('profile_file_artifact_capacity'), { code: 'profile_file_artifact_capacity' })
/** Only exact runtime authority or a private compatibility owner can share slots. */
export const artifactInventoryScope = authority => authority === undefined ? Symbol('private artifact owner') : createHash('sha256').update(canonical(exactAuthority(authority))).digest('hex')
function holder(entry) { const receipt = Object.freeze({}); holders.set(receipt, entry); entry.holders.add(receipt); return receipt }
export function reserveArtifactInventory(scope) {
  if (entries.size >= 16 || [...entries].filter(entry => entry.scope === scope).length >= 4) throw fail()
  const entry = { scope, holders: new Set() }; entries.add(entry); return holder(entry)
}
export function retainArtifactInventory(receipt, scope) {
  const entry = holders.get(receipt); if (!entry || entry.scope !== scope || !entries.has(entry)) throw fail(); return holder(entry)
}
export function releaseArtifactInventory(receipt) {
  const entry = holders.get(receipt); if (!entry || !entries.has(entry)) throw fail()
  holders.delete(receipt); entry.holders.delete(receipt); if (!entry.holders.size) entries.delete(entry)
}
