import * as fs from 'node:fs/promises'
import path from 'node:path'

const fail = () => Object.assign(new Error('profile_file_private_directory_unproved'), { code: 'profile_file_private_directory_unproved' })
const current = callback => { const value = callback(); if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail() }; if (value === false) throw fail() }
const same = (a, b) => a.dev === b.dev && a.ino === b.ino
/** Agent plaintext materialization requires an actual private Linux directory.
 * Existing permissive directories are refused, never chmodded or adopted. */
export async function createAgentProfileFileArea({ directory, assertCurrent, filesystem = fs, platform = process.platform, uid = process.getuid?.() }) {
  if (platform !== 'linux' || !Number.isSafeInteger(uid) || uid < 0 || typeof assertCurrent !== 'function' || typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory || directory.includes('\0')) throw fail()
  const owned = stat => stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o077) === 0
  const ancestry = async (target, create, check) => {
    let item = path.parse(target).root; const rows = []
    for (const part of target.slice(item.length).split(path.sep).filter(Boolean)) {
      item = path.join(item, part); current(check); let stat
      try { stat = await filesystem.lstat(item) } catch (error) {
        if (!create || error?.code !== 'ENOENT') throw error
        current(check); await filesystem.mkdir(item, { mode: 0o700 }); stat = await filesystem.lstat(item)
      }
      current(check); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail()
      if ((item === directory || item.startsWith(directory + path.sep)) && !owned(stat)) throw fail()
      rows.push({ path: item, stat })
    }
    const real = await filesystem.realpath(target); current(check); if (real !== target) throw fail()
    return rows
  }
  current(assertCurrent); const original = await ancestry(directory, true, assertCurrent); current(assertCurrent)
  const verify = async (target, check = () => true) => {
    if (!(target === directory || target.startsWith(directory + path.sep)) || path.normalize(target) !== target) throw fail()
    const rows = await ancestry(target, false, check); current(check)
    for (const before of original) { const after = rows.find(row => row.path === before.path); if (!after || !same(before.stat, after.stat)) throw fail() }
    return true
  }
  await verify(directory, assertCurrent); current(assertCurrent)
  return Object.freeze({ directory, assertPrivateDirectory: verify })
}
