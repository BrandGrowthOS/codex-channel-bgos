"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { MAX_FILE_BYTES, FILE_TTL_MS, validateFileName } = require("./profile-file-crypto");
const pending = new Set(), held = new Set();
const fail = code => Object.assign(new Error(code), { code });
function current(check) {
  if (typeof check !== "function") throw fail("profile_file_context_changed");
  const value = check(); if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail("profile_file_context_changed"); }
  if (value === false) throw fail("profile_file_context_changed");
}
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
const regular = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && Number.isSafeInteger(stat.size) && stat.size >= 0 && stat.size <= MAX_FILE_BYTES;
function safePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || value.startsWith("\\\\") || value.includes("\0") || value.slice(path.parse(value).root.length).includes(":")) throw fail("profile_file_path_refused");
  return value;
}

/** Plaintext lives in bounded private memory until one explicit use. A path is
 * handed only to the trusted native/Playwright callback, never to the agent. */
class ProfileFileStaging {
  #handles = new WeakMap(); #records = new Set(); #work = new Set(); #closed = false; #cleanupUnknown = false;
  constructor({ directory, scope, assertPrivateDirectory, filesystem = fs.promises, now = Date.now, platform = process.platform }) {
    safePath(directory);
    if (typeof scope !== "string" || !/^[a-f0-9]{64}$/.test(scope) || typeof assertPrivateDirectory !== "function" || typeof now !== "function") throw fail("profile_file_staging_configuration_invalid");
    Object.defineProperties(this, { directory: { value: directory }, scope: { value: scope }, privateDirectory: { value: assertPrivateDirectory }, fs: { value: filesystem }, now: { value: now }, platform: { value: platform } });
  }
  #live() { if (this.#closed || this.#cleanupUnknown) throw fail(this.#cleanupUnknown ? "profile_file_cleanup_unconfirmed" : "profile_file_staging_closed"); }
  #clock() { const value = this.now(); if (!Number.isSafeInteger(value) || value < 0) throw fail("profile_file_context_changed"); return value; }
  #forget(record) { record.bytes?.fill(0); record.bytes = null; this.#records.delete(record); held.delete(record); }
  #prune() { const now = this.#clock(); for (const record of this.#records) if (record.state === "staged" && record.expiresAt <= now) { record.state = "expired"; this.#forget(record); } }
  stage({ bytes, fileName, expiresAt, assertCurrent }) {
    this.#live(); current(assertCurrent); this.#live(); this.#prune(); validateFileName(fileName);
    const now = this.#clock();
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + FILE_TTL_MS) throw fail("profile_file_staging_refused");
    if (held.size >= 16 || [...held].filter(record => record.scope === this.scope).length >= 4 || [...held].reduce((sum, record) => sum + record.size, 0) + bytes.length > 400 * 1024 * 1024) throw fail("profile_file_staging_capacity");
    const handle = Object.freeze({}), record = { scope: this.scope, fileName, expiresAt, size: bytes.length, bytes: Buffer.from(bytes), state: "staged", file: null, stat: null, clean: true };
    this.#handles.set(handle, record); this.#records.add(record); held.add(record); return handle;
  }
  discard(handle) { const record = this.#handles.get(handle); if (!record || record.state !== "staged") throw fail("profile_file_handle_spent"); record.state = "discarded"; this.#forget(record); }
  #run(work, afterClosed = false) {
    try { if (!afterClosed) this.#live(); } catch (error) { return Promise.reject(error); }
    if (this.#cleanupUnknown || pending.size >= 2) return Promise.reject(fail(this.#cleanupUnknown ? "profile_file_cleanup_unconfirmed" : "profile_file_io_capacity"));
    const lease = {}; pending.add(lease); let clean = true;
    const task = Promise.resolve().then(() => work(() => { clean = false; this.#cleanupUnknown = true; })).finally(() => { if (clean) { pending.delete(lease); this.#work.delete(task); } });
    this.#work.add(task); void task.catch(() => {}); return task;
  }
  async #ancestors(target, check, create = false) {
    const directory = path.dirname(safePath(target)), root = path.parse(directory).root, snapshots = [];
    let value = root;
    for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
      value = path.join(value, part); current(check); let stat;
      try { stat = await this.fs.lstat(value); } catch (error) {
        if (!create || error?.code !== "ENOENT" || !(value === this.directory || value.startsWith(this.directory + path.sep))) throw error;
        try { await this.fs.mkdir(value, { mode: 0o700 }); } catch (raced) { if (raced?.code !== "EEXIST") throw raced; }
        stat = await this.fs.lstat(value);
      }
      current(check);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("profile_file_path_refused");
      snapshots.push({ path: value, stat });
    }
    return snapshots;
  }
  async #unchanged(snapshots, check) {
    for (const before of snapshots) { const stat = await this.fs.lstat(before.path); current(check); if (!stat.isDirectory() || stat.isSymbolicLink() || !same(stat, before.stat)) throw fail("profile_file_path_changed"); }
  }
  readSelected({ selectedPath, assertCurrent }) {
    safePath(selectedPath); return this.#run(async uncertain => {
      const chunks = []; let opened, result; const check = () => { this.#live(); current(assertCurrent); };
      try {
        check(); const before = await this.#ancestors(selectedPath, check), initial = await this.fs.lstat(selectedPath); check();
        if (!regular(initial)) throw fail("profile_file_path_refused");
        opened = await this.fs.open(selectedPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); const stat = await opened.stat(); check();
        if (!regular(stat) || !same(stat, initial) || stat.size !== initial.size || stat.mtimeMs !== initial.mtimeMs) throw fail("profile_file_path_changed");
        await this.#unchanged(before, check); let length = 0;
        for (;;) {
          const bytes = Buffer.alloc(Math.min(64 * 1024, MAX_FILE_BYTES - length + 1)); chunks.push(bytes); const read = await opened.read(bytes, 0, bytes.length, null); check();
          if (!read.bytesRead) { bytes.fill(0); chunks.pop(); break; } length += read.bytesRead;
          if (length > MAX_FILE_BYTES) throw fail("profile_file_too_large");
          if (read.bytesRead < bytes.length) { bytes.fill(0, read.bytesRead); chunks[chunks.length - 1] = bytes.subarray(0, read.bytesRead); }
        }
        const after = await opened.stat(); check(); await this.#unchanged(before, check);
        const leaf = await this.fs.lstat(selectedPath); check();
        if (!regular(after) || !same(after, initial) || !same(leaf, initial) || !regular(leaf) || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs || length !== initial.size) throw fail("profile_file_path_changed");
        result = Buffer.concat(chunks, length); return { bytes: result, fileName: validateFileName(path.basename(selectedPath)) };
      } catch (error) { result?.fill(0); throw error; }
      finally { for (const bytes of chunks) bytes.fill(0); try { await opened?.close(); } catch { result?.fill(0); uncertain(); throw fail("profile_file_cleanup_unconfirmed"); } }
    });
  }
  withFile(handle, { assertCurrent, use }) {
    this.#live(); current(assertCurrent); this.#live(); this.#prune(); const record = this.#handles.get(handle);
    if (!record || record.state !== "staged" || !this.#records.has(record) || typeof use !== "function") return Promise.reject(fail("profile_file_handle_spent"));
    record.state = "claimed";
    const work = this.#run(async uncertain => {
      let opened, snapshots, failure, result; const directory = path.join(this.directory, crypto.randomUUID()), file = path.join(directory, record.fileName); record.file = file;
      const check = () => { this.#live(); current(assertCurrent); if (record.expiresAt <= this.#clock()) throw fail("profile_file_expired"); };
      try {
        check(); snapshots = await this.#ancestors(path.join(this.directory, ".proof"), check, true);
        if (await this.privateDirectory(this.directory) !== true) throw fail("profile_file_private_directory_unproved"); check();
        await this.fs.mkdir(directory, { mode: 0o700 }); record.directoryCreated = true; record.directoryStat = await this.fs.lstat(directory); check();
        if (!record.directoryStat.isDirectory() || record.directoryStat.isSymbolicLink()) throw fail("profile_file_path_refused");
        snapshots.push({ path: directory, stat: record.directoryStat });
        if (await this.privateDirectory(directory) !== true) throw fail("profile_file_private_directory_unproved"); check();
        opened = await this.fs.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600); record.stat = await opened.stat(); check();
        if (!regular(record.stat) || record.stat.size !== 0) throw fail("profile_file_path_refused");
        await opened.writeFile(record.bytes); await opened.sync(); const after = await opened.stat(); check();
        if (!regular(after) || !same(after, record.stat) || after.size !== record.size) throw fail("profile_file_path_changed");
        try { await opened.close(); } catch { record.clean = false; uncertain(); throw fail("profile_file_cleanup_unconfirmed"); }
        opened = null; await this.#unchanged(snapshots, check); const leaf = await this.fs.lstat(file); check();
        if (!regular(leaf) || !same(leaf, record.stat) || leaf.size !== record.size) throw fail("profile_file_path_changed");
        result = await use(file, record.fileName); check();
      } catch (error) { failure = error; }
      finally {
        const failures = [];
        try { await opened?.close(); } catch { failures.push(true); }
        if (record.directoryCreated) {
          try { const leaf = await this.fs.lstat(file); if (!record.stat || !regular(leaf) || !same(leaf, record.stat)) throw fail("profile_file_path_changed"); await this.fs.unlink(file); }
          catch (error) { if (error?.code !== "ENOENT") failures.push(true); }
          try { const stat = await this.fs.lstat(directory); if (!record.directoryStat || !stat.isDirectory() || stat.isSymbolicLink() || !same(stat, record.directoryStat)) throw fail("profile_file_path_changed"); await this.fs.rmdir(directory); }
          catch (error) { if (error?.code !== "ENOENT") failures.push(true); }
        }
        record.bytes?.fill(0); record.bytes = null;
        if (failures.length) { record.clean = false; uncertain(); } else { record.state = "spent"; this.#forget(record); }
      }
      if (!record.clean) throw fail("profile_file_cleanup_unconfirmed"); if (failure) throw failure; return result;
    });
    // Admission itself can refuse without creating a file. The one-use handle
    // still remains spent and its plaintext must not survive that refusal.
    return work.catch(error => { if (record.state === "claimed" && !record.file) { record.state = "spent"; this.#forget(record); } throw error; });
  }
  async whenDrained() {
    const results = await Promise.allSettled([...this.#work]);
    if (this.#cleanupUnknown || results.some(result => result.status === "rejected") && this.#work.size) throw fail("profile_file_cleanup_unconfirmed");
  }
  async dispose() {
    this.#closed = true; for (const record of this.#records) if (record.state === "staged") { record.state = "discarded"; this.#forget(record); }
    await this.whenDrained();
  }
}
module.exports = { ProfileFileStaging, MAX_STAGED_FILES: 4, MAX_GLOBAL_STAGED_FILES: 16 };
