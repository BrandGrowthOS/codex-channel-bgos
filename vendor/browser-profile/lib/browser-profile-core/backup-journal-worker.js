"use strict";
// Only signed encrypted backup packets enter this worker. No portable draft,
// private endpoint key, passphrase or content key belongs in this file format.
const { parentPort } = require("node:worker_threads"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { MAX_WIRE_BYTES, scopeOf, validateEncryptedBackup, sha } = require("./active-backup-wire");
const NAME = /^[a-f0-9-]{36}-[a-f0-9-]{36}\.backup$/, fail = code => Object.assign(new Error(code), { code });
async function directory(dir) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) throw fail("profile_backup_journal_path");
  let current = path.parse(dir).root;
  for (const part of dir.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.promises.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await fs.promises.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || current === dir && process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) throw fail("profile_backup_journal_path");
  }
}
function fileStat(stat, max = MAX_WIRE_BYTES) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > max || process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) throw fail("profile_backup_journal_file");
}
async function read(file, max = MAX_WIRE_BYTES) {
  const before = await fs.promises.lstat(file); fileStat(before, max);
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat(); fileStat(stat, max); if (stat.dev !== before.dev || stat.ino !== before.ino) throw fail("profile_backup_journal_file");
    const chunks = []; let length = 0;
    for (;;) { const chunk = Buffer.alloc(Math.min(64 * 1024, max + 1 - length)); const result = await handle.read(chunk, 0, chunk.length, null); if (!result.bytesRead) break; length += result.bytesRead; if (length > max) throw fail("profile_backup_journal_size"); chunks.push(chunk.subarray(0, result.bytesRead)); }
    const after = await handle.stat(); if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || length !== stat.size) throw fail("profile_backup_journal_file");
    return { bytes: Buffer.concat(chunks), stat: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs } };
  } finally { await handle.close(); }
}
async function syncDirectory(dir) {
  if (process.platform === "win32") return false; let handle;
  try { handle = await fs.promises.open(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0)); await handle.sync(); return true; }
  catch (error) { if (["EINVAL", "ENOTSUP", "ENOSYS", "EISDIR"].includes(error.code)) return false; throw error; }
  finally { await handle?.close(); }
}
async function atomic(file, bytes) {
  const temporary = path.join(path.dirname(file), ".backup-" + crypto.randomUUID() + ".tmp"); let handle, renamed = false;
  try {
    handle = await fs.promises.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await fs.promises.rename(temporary, file); renamed = true; return { fileSynced: true, directorySynced: await syncDirectory(path.dirname(file)) };
  } finally { await handle?.close(); if (!renamed) await fs.promises.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
async function record(dir, name, options) {
  if (!NAME.test(name)) throw fail("profile_backup_journal_path");
  const file = path.join(dir, name), content = await read(file), backup = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(content.bytes)), metadata = validateEncryptedBackup(backup, options), wireHash = sha(content.bytes);
  let status = "unknown";
  try {
    const state = JSON.parse((await read(file + ".state", 1024)).bytes.toString("utf8"));
    if (Object.keys(state).length !== 4 || state.version !== 1 || state.bundleHash !== metadata.bundleHash || state.wireHash !== wireHash || !["prepared", "unknown", "confirmed"].includes(state.status)) throw fail("profile_backup_journal_state"); status = state.status;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { name, metadata, wireHash, wireBytes: content.bytes.length, stat: content.stat, status };
}
async function scan(dir, options) {
  const names = await fs.promises.readdir(dir); if (names.length > 32) throw fail("profile_backup_journal_quota");
  const records = []; let bytes = 0;
  for (const name of names) {
    if (!NAME.test(name)) { if (!/^\.backup-[a-f0-9-]{36}\.tmp$/.test(name) && !/\.backup\.state$/.test(name)) throw fail("profile_backup_journal_path"); continue; }
    const stat = await fs.promises.lstat(path.join(dir, name)); fileStat(stat); bytes += stat.size;
    // Other accounts/profiles are counted for physical quota, never loaded
    // under this caller's key pins or returned as its records.
    if (name.startsWith(options.scope.profileId + "-")) records.push(await record(dir, name, options));
  }
  return { records, bytes, count: names.filter(name => NAME.test(name)).length };
}
async function run(value) {
  const scope = scopeOf(value.scope), options = { scope, pins: value.pins }, dir = path.resolve(value.directory); await directory(dir);
  if (value.kind === "inspect") return (await scan(dir, options)).records;
  if (value.kind === "write") {
    const metadata = validateEncryptedBackup(value.backup, options), current = await scan(dir, options);
    if (current.records.some(row => row.status !== "confirmed")) throw fail("profile_backup_journal_unresolved");
    const bytes = Buffer.from(JSON.stringify(value.backup));
    if (bytes.length > MAX_WIRE_BYTES || current.bytes + bytes.length > value.maxBytes || current.count >= 8) throw fail("profile_backup_journal_quota");
    const name = scope.profileId + "-" + metadata.bundle.snapshotId + ".backup", file = path.join(dir, name);
    try { await fs.promises.lstat(file); throw fail("profile_backup_journal_exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const durability = await atomic(file, bytes), wireHash = sha(bytes);
    await atomic(file + ".state", Buffer.from(JSON.stringify({ version: 1, bundleHash: metadata.bundleHash, wireHash, status: "prepared" })));
    const result = await record(dir, name, options); if (result.wireHash !== wireHash) throw fail("profile_backup_journal_readback");
    if (current.records.length >= 2) {
      const oldest = [...current.records].sort((a, b) => a.metadata.bundle.sourceAuthority.writerEpoch - b.metadata.bundle.sourceAuthority.writerEpoch || a.metadata.bundle.sequence - b.metadata.bundle.sequence)[0];
      await fs.promises.unlink(path.join(dir, oldest.name + ".state")); await fs.promises.unlink(path.join(dir, oldest.name)); await syncDirectory(dir);
    }
    return { ...result, durability };
  }
  const found = await record(dir, value.name, options);
  if (found.metadata.bundleHash !== value.bundleHash || found.wireHash !== value.wireHash) throw fail("profile_backup_journal_changed");
  if (value.kind === "verify") return found;
  if (!["unknown", "confirmed"].includes(value.kind) || value.kind === "unknown" && found.status !== "prepared") throw fail("profile_backup_journal_state");
  const durability = await atomic(path.join(dir, found.name + ".state"), Buffer.from(JSON.stringify({ version: 1, bundleHash: found.metadata.bundleHash, wireHash: found.wireHash, status: value.kind })));
  const result = await record(dir, found.name, options); if (result.status !== value.kind) throw fail("profile_backup_journal_readback"); return { ...result, durability };
}
parentPort.once("message", value => { run(value).then(result => parentPort.postMessage({ ok: true, result }), error => parentPort.postMessage({ ok: false, code: /^profile_backup_[a-z_]+$/.test(error?.code) ? error.code : "profile_backup_journal_failed" })).finally(() => parentPort.close()); });
