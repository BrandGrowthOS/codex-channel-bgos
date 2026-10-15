"use strict";

// Fixed source runs in a private isolated world of the existing document.
// Only readonly transactions are permitted. The reviewed structured-value
// encoder is supplied by main; its stopped read/restore methods are not used.
async function readLiveStorage(encode, metadata) {
  const fail = () => { throw new Error("profile_live_storage_unqualified"); };
  if (!/^https?:$/.test(location.protocol) || !Array.isArray(metadata) || metadata.length > 100) fail();
  const result = { schema: "hoai-origin-storage-v1", origin: location.origin, localStorage: [], indexedDB: [] };
  let measured = 0, records = 0, slots = 0;
  const account = (value, seen = new Set(), depth = 0) => {
    if (depth > 100 || ++slots > 100000) fail();
    if (typeof value === "string") measured += value.length * 2;
    else if (typeof value === "bigint") { const digits = String(value); if (digits.length > 10000) fail(); measured += digits.length * 2; }
    else if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      if (value instanceof Blob) measured += value.size;
      else if (value instanceof ArrayBuffer) measured += value.byteLength;
      else if (ArrayBuffer.isView(value)) account(value.buffer, seen, depth + 1);
      else if (value instanceof Map) { if (value.size * 2 > 100000 - slots) fail(); for (const [key, item] of value) { account(key, seen, depth + 1); account(item, seen, depth + 1); } }
      else if (value instanceof Set) { if (value.size > 100000 - slots) fail(); for (const item of value) account(item, seen, depth + 1); }
      else if (!(value instanceof Date) && !(value instanceof RegExp)) {
        if (Array.isArray(value) && value.length > 100000 - slots) fail();
        const keys = Object.keys(value); if (keys.length > 100000 - slots) fail();
        for (const key of keys) { measured += key.length * 2; account(value[key], seen, depth + 1); }
      }
    }
    if (measured > 16 * 1024 * 1024) fail();
  };
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i), value = localStorage.getItem(name);
    if (typeof name !== "string" || typeof value !== "string" || result.localStorage.length >= 10000) fail();
    measured += (name.length + value.length) * 2; if (measured > 16 * 1024 * 1024) fail(); result.localStorage.push({ name, value });
  }
  const names = await indexedDB.databases();
  if (names.length !== metadata.length || names.some(info => !metadata.some(item => item.name === info.name && item.version === info.version))) fail();
  for (const expected of metadata) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(expected.name);
      request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error("profile_live_database_changed")); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      if (db.version !== expected.version || db.objectStoreNames.length !== expected.stores.length || db.objectStoreNames.length > 100) fail();
      const exported = { name: db.name, version: db.version, stores: [] };
      for (const info of expected.stores) {
        if (!db.objectStoreNames.contains(info.name)) fail();
        const captured = await new Promise((resolve, reject) => {
          const tx = db.transaction(info.name, "readonly"), store = tx.objectStore(info.name);
          if (store.indexNames.length > 100 || [...store.indexNames].some(name => typeof name !== "string" || name.length > 1024)) { tx.abort(); reject(new Error("profile_live_index_unsupported")); return; }
          const item = { name: store.name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: [...store.indexNames].map(name => { const index = store.index(name); return { name, indexKeyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }; }) };
          const keys = [], values = []; let failure;
          const request = store.openCursor();
          request.onsuccess = () => {
            const row = request.result; if (!row) return;
            try {
              if (++records > 10000) fail();
              account(row.key); account(row.value);
              keys.push(row.key); values.push(row.value); row.continue();
            } catch (error) { failure = error; tx.abort(); }
          };
          tx.oncomplete = () => resolve({ item, keys, values });
          tx.onabort = () => reject(failure || tx.error || new Error("profile_live_read_aborted")); tx.onerror = () => {};
        });
        if (captured.item.autoIncrement !== info.autoIncrement || JSON.stringify(captured.item.keyPath) !== JSON.stringify(info.keyPath)) fail();
        captured.item.graph = await encode({ keys: captured.keys, values: captured.values });
        if (info.autoIncrement) {
          if (!Number.isSafeInteger(info.nextKey) || info.nextKey < 1) fail(); captured.item.nextKey = info.nextKey;
        }
        exported.stores.push(captured.item);
      }
      result.indexedDB.push(exported);
    } finally { db.close(); }
  }
  const json = JSON.stringify(result);
  if (new TextEncoder().encode(json).byteLength > 16 * 1024 * 1024) fail();
  return json;
}
module.exports = { readLiveStorage };
