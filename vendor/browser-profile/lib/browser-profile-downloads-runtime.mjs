import { createRequire } from 'node:module'
import { AgentProfileDownloads } from './browser-profile-downloads.mjs'
const require = createRequire(import.meta.url), { exactAuthority, sameAuthority } = require('./browser-profile-core/coordinator-client.js')
const bindings = new WeakSet(), fail = () => Object.assign(new Error('profile_download_binding_required'), { code: 'profile_download_binding_required' })

/** This is a main-only capability, never a serialized tool or renderer value.
 * Calling the original class method proves its private instance brand. */
export function createRuntimeDownloadBinding(manager, authority) {
  authority = exactAuthority(authority)
  try { AgentProfileDownloads.prototype.assertIdle.call(manager) } catch { throw fail() }
  if (!sameAuthority(manager.authority, authority)) throw fail()
  const check = () => { if (!sameAuthority(manager.authority, authority)) throw fail() }
  const binding = Object.freeze({
    async launchOptions() { check(); const result = await AgentProfileDownloads.prototype.launchOptions.call(manager); check(); return result },
    async bind(context, stop) { check(); if (typeof stop?.stop !== 'function') throw fail(); await AgentProfileDownloads.prototype.bind.call(manager, { context, stopBrowser: async () => (await stop.stop())?.stopped === true }); check() },
    assertAvailable() { check(); return AgentProfileDownloads.prototype.assertCurrent.call(manager) },
    assertHealthy() { check(); return AgentProfileDownloads.prototype.assertHealthy.call(manager) },
    assertIdle() { check(); return AgentProfileDownloads.prototype.assertIdle.call(manager) },
    onDownload(download) { check(); return AgentProfileDownloads.prototype.onDownload.call(manager, download) },
    activity() { return AgentProfileDownloads.prototype.activity.call(manager) },
    whenDrained() { return AgentProfileDownloads.prototype.whenDrained.call(manager) },
    dispose() { return AgentProfileDownloads.prototype.dispose.call(manager) }
  }); bindings.add(binding); return binding
}
export function assertRuntimeDownloadBinding(binding) { if (!bindings.has(binding)) throw fail(); return binding }
