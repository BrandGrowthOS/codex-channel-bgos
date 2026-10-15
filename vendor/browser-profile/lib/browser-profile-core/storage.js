"use strict";

// Runs only in a privileged, isolated storage page after the old runtime stops.
// Source is fixed by main. No supplied code or profile value is evaluated.
function createStorageAdapter() {
  const LIMIT_BYTES = 16 * 1024 * 1024;
  const LIMIT_NODES = 100000;
  const LIMIT_RECORDS = 10000;
  const fail = (message) => { throw new Error(`profile_storage: ${message}`); };
  const bytesToBase64 = bytes => {
    let text = "";
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(text);
  };
  const base64ToBytes = text => {
    if (typeof text !== "string" || text.length > LIMIT_BYTES * 2 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) fail("invalid binary value");
    const bytes = Uint8Array.from(atob(text), value => value.charCodeAt(0));
    if (bytesToBase64(bytes) !== text) fail("noncanonical binary value");
    return bytes;
  };
  const typed = new Map([
    ["Int8Array", Int8Array], ["Uint8Array", Uint8Array], ["Uint8ClampedArray", Uint8ClampedArray],
    ["Int16Array", Int16Array], ["Uint16Array", Uint16Array], ["Int32Array", Int32Array],
    ["Uint32Array", Uint32Array], ["Float32Array", Float32Array], ["Float64Array", Float64Array],
    ["BigInt64Array", BigInt64Array], ["BigUint64Array", BigUint64Array], ["DataView", DataView],
  ]);
  const bounded = value => {
    const json = JSON.stringify(value);
    if (new TextEncoder().encode(json).byteLength > LIMIT_BYTES) fail("state exceeds byte limit");
    return value;
  };

  async function encode(value) {
    const nodes = [], seen = new Map();
    let measured = 0, slots = 0;
    const visit = async (item, depth = 0) => {
      if (depth > 128) fail("value nesting exceeds limit");
      if (item === null || typeof item === "boolean" || typeof item === "string") {
        if (typeof item === "string") { measured += item.length * 2; if (measured > LIMIT_BYTES) fail("value exceeds byte limit"); }
        return item;
      }
      if (typeof item === "number") return Number.isFinite(item) && !Object.is(item, -0) ? item : { number: Object.is(item, -0) ? "-0" : String(item) };
      if (typeof item === "undefined") return { undefined: true };
      if (typeof item === "bigint") {const value=String(item);if(value.replace(/^-/, "").length>10000)fail("bigint exceeds limit");return {bigint:value};}
      if (typeof item !== "object") fail("unsupported value type");
      if (seen.has(item)) return { ref: seen.get(item) };
      if (nodes.length >= LIMIT_NODES) fail("too many value nodes");
      if (++slots > LIMIT_NODES) fail("value allocation exceeds limit");
      const id = nodes.length;
      seen.set(item, id);
      const node = {};
      nodes.push(node);
      if (item instanceof Date) { node.type = "date"; node.value = Number.isNaN(item.getTime()) ? null : item.toISOString(); }
      else if (item instanceof RegExp) { node.type = "regexp"; node.source = item.source; node.flags = item.flags; }
      else if (item instanceof ArrayBuffer) {
        measured += item.byteLength;
        if (measured > LIMIT_BYTES) fail("binary value exceeds byte limit");
        node.type = "buffer"; node.data = bytesToBase64(new Uint8Array(item));
      } else if (ArrayBuffer.isView(item)) {
        if (!typed.has(item.constructor.name)) fail("unsupported typed array");
        node.type = "view"; node.kind = item.constructor.name; node.buffer = await visit(item.buffer, depth + 1); node.offset = item.byteOffset; node.length = item instanceof DataView ? item.byteLength : item.length;
      } else if (typeof Blob !== "undefined" && item instanceof Blob) {
        measured += item.size;
        if (measured > LIMIT_BYTES) fail("blob exceeds byte limit");
        node.type = typeof File !== "undefined" && item instanceof File ? "file" : "blob";
        if(item.type.length>1024)fail("blob metadata exceeds limit");
        node.data = bytesToBase64(new Uint8Array(await item.arrayBuffer())); node.mime = item.type;
        if (node.type === "file") {if(item.name.length>4096||!Number.isSafeInteger(item.lastModified))fail("file metadata exceeds limit");node.name = item.name; node.lastModified = item.lastModified; }
      } else if (item instanceof Map) {
        slots += item.size * 2; if (slots > LIMIT_NODES) fail("value allocation exceeds limit");
        node.type = "map"; node.entries = [];
        for (const [key, entry] of item) node.entries.push([await visit(key, depth + 1), await visit(entry, depth + 1)]);
      } else if (item instanceof Set) {
        slots += item.size; if (slots > LIMIT_NODES) fail("value allocation exceeds limit");
        node.type = "set"; node.values = [];
        for (const entry of item) node.values.push(await visit(entry, depth + 1));
      } else if (Array.isArray(item)) {
        slots += item.length + Object.keys(item).length; if (slots > LIMIT_NODES) fail("value allocation exceeds limit");
        node.type = "array"; node.length = item.length; node.entries = [];
        for (const key of Object.keys(item)) node.entries.push([key, await visit(item[key], depth + 1)]);
      } else {
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) fail("unsupported structured value");
        slots += Object.keys(item).length; if (slots > LIMIT_NODES) fail("value allocation exceeds limit");
        node.type = "object"; node.nullPrototype = prototype === null; node.entries = [];
        for (const key of Object.keys(item)) node.entries.push([key, await visit(item[key], depth + 1)]);
      }
      return { ref: id };
    };
    const root = await visit(value);
    return bounded({ format: "hoai-structured-value-v1", root, nodes });
  }

  function decode(packet, budget = {slots:0}) {
    bounded(packet);
    if (!packet || packet.format !== "hoai-structured-value-v1" || !Array.isArray(packet.nodes) || packet.nodes.length > LIMIT_NODES) fail("invalid structured value");
    // Budget all decoded nodes and slots before allocating even the first array.
    // A short packet containing many sparse arrays must not amplify into GBs.
    for (const node of packet.nodes) {
      if (!node || typeof node !== "object") fail("invalid value node");
      let slots = 1;
      if (node.type === "array") {
        if (!Number.isSafeInteger(node.length) || node.length < 0) fail("invalid array length");
        slots += node.length;
      }
      if (Array.isArray(node.entries)) slots += node.entries.length * (node.type === "map" ? 2 : 1);
      if (Array.isArray(node.values)) slots += node.values.length;
      budget.slots += slots;
      if (budget.slots > LIMIT_NODES) fail("decoded allocation exceeds limit");
    }
    const shapes = {
      buffer:["type","data"],view:["type","kind","buffer","offset","length"],date:["type","value"],regexp:["type","source","flags"],
      blob:["type","data","mime"],file:["type","data","mime","name","lastModified"],map:["type","entries"],set:["type","values"],
      array:["type","length","entries"],object:["type","nullPrototype","entries"],
    };
    const values = new Map(), constructing = new Set();
    const integer = value => Number.isSafeInteger(value) && value >= 0;
    const visit = (value, depth = 0) => {
      if (depth > 128) fail("value nesting exceeds limit");
      if (value === null || ["string", "boolean", "number"].includes(typeof value)) return value;
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid encoded value");
      if (Object.hasOwn(value, "undefined") && Object.keys(value).length === 1 && value.undefined === true) return undefined;
      if (Object.hasOwn(value, "bigint") && Object.keys(value).length === 1 && typeof value.bigint === "string" && /^-?\d{1,10000}$/.test(value.bigint)) return BigInt(value.bigint);
      if (Object.hasOwn(value, "number") && Object.keys(value).length === 1) {
        const special = { "-0": -0, NaN, Infinity, "-Infinity": -Infinity };
        if (!Object.hasOwn(special, value.number)) fail("invalid number");
        return special[value.number];
      }
      if (!integer(value.ref) || Object.keys(value).length !== 1 || value.ref >= packet.nodes.length) fail("invalid reference");
      if (values.has(value.ref)) return values.get(value.ref);
      if (constructing.has(value.ref)) fail("cyclic binary view");
      constructing.add(value.ref);
      const node = packet.nodes[value.ref];
      if (!node || typeof node !== "object") fail("invalid value node");
      const shape=Object.hasOwn(shapes,node.type)?shapes[node.type]:null;
      if(!shape)fail("unsupported value node");
      if(Object.keys(node).length!==shape.length||shape.some(key=>!Object.hasOwn(node,key)))fail("invalid node schema");
      let result;
      switch (node.type) {
        case "buffer": result = base64ToBytes(node.data).buffer; break;
        case "view": {
          const Type = typed.get(node.kind);
          if (!Type || !integer(node.offset) || !integer(node.length)) fail("invalid typed array");
          const buffer = visit(node.buffer, depth + 1);
          if (!(buffer instanceof ArrayBuffer)) fail("invalid backing buffer");
          result = new Type(buffer, node.offset, node.length); break;
        }
        case "date":
          if(node.value!==null&&(typeof node.value!=="string"||node.value.length>27))fail("invalid date");
          result=new Date(node.value===null?NaN:node.value);
          if(node.value!==null&&(Number.isNaN(result.getTime())||result.toISOString()!==node.value))fail("invalid date");
          break;
        case "regexp":
          if(typeof node.source!=="string"||typeof node.flags!=="string"||node.flags.length>10)fail("invalid regexp");
          result=new RegExp(node.source,node.flags);
          if(result.source!==node.source||result.flags!==node.flags)fail("invalid regexp");
          break;
        case "blob":
          if(typeof node.mime!=="string"||node.mime.length>1024)fail("invalid blob");
          result=new Blob([base64ToBytes(node.data)],{type:node.mime});
          if(result.type!==node.mime)fail("invalid blob mime");
          break;
        case "file":
          if (typeof File === "undefined") fail("File is unsupported by this runtime");
          if(typeof node.mime!=="string"||node.mime.length>1024||typeof node.name!=="string"||node.name.length>4096||!Number.isSafeInteger(node.lastModified))fail("invalid file");
          result = new File([base64ToBytes(node.data)], node.name, { type: node.mime, lastModified: node.lastModified });
          if(result.name!==node.name||result.type!==node.mime||result.lastModified!==node.lastModified)fail("invalid file metadata");
          break;
        case "map": result = new Map(); break;
        case "set": result = new Set(); break;
        case "array":
          if (!integer(node.length) || node.length > LIMIT_NODES) fail("invalid array length");
          result = new Array(node.length); break;
        case "object":
          if(typeof node.nullPrototype!=="boolean")fail("invalid object prototype");
          result = node.nullPrototype ? Object.create(null) : {}; break;
        default: fail("unsupported value node");
      }
      values.set(value.ref, result);
      constructing.delete(value.ref);
      if (["map", "array", "object"].includes(node.type)) {
        if (!Array.isArray(node.entries) || node.entries.length > LIMIT_NODES) fail("invalid entries");
        for (const pair of node.entries) {
          if (!Array.isArray(pair) || pair.length !== 2) fail("invalid entry");
          if (node.type === "map") {
            const key = visit(pair[0], depth + 1);
            if (result.has(key)) fail("duplicate map key");
            result.set(key, visit(pair[1], depth + 1));
          }
          else {
            if (typeof pair[0] !== "string" || (node.type === "array" && (pair[0] === "length" || /^(0|[1-9]\d*)$/.test(pair[0]) && Number(pair[0]) < 4294967295 && Number(pair[0]) >= node.length))) fail("invalid property");
            if (Object.hasOwn(result, pair[0])) fail("duplicate property");
            Object.defineProperty(result, pair[0], { value: visit(pair[1], depth + 1), enumerable: true, writable: true, configurable: true });
          }
        }
      } else if (node.type === "set") {
        if (!Array.isArray(node.values) || node.values.length > LIMIT_NODES) fail("invalid set");
        for (const value of node.values) {
          const item = visit(value, depth + 1);
          if (result.has(item)) fail("duplicate set value");
          result.add(item);
        }
      }
      return result;
    };
    return visit(packet.root);
  }

  const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const transaction = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted")); tx.onerror = () => {}; });
  const openExisting = name => new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onupgradeneeded = () => { req.transaction.abort(); reject(new Error("IndexedDB disappeared during checkpoint")); };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
  function assignKey(value, keyPath, key) {
    const parts = keyPath.split(".");
    if (!parts.length || parts.some(part => !part)) fail("unsupported generator key path");
    let target = value;
    for (const part of parts.slice(0, -1)) { Object.defineProperty(target, part, {value:{},enumerable:true,writable:true,configurable:true}); target = target[part]; }
    Object.defineProperty(target, parts.at(-1), {value:key,enumerable:true,writable:true,configurable:true});
  }
  async function nextGeneratedKey(db, storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite"), store = tx.objectStore(storeName);
      const req = store.add({});
      let key;
      req.onsuccess = () => { key = req.result; tx.abort(); };
      req.onerror = () => { reject(new Error("IndexedDB generator cannot be exported")); };
      tx.onabort = () => { if (key !== undefined) resolve(key); else reject(new Error("IndexedDB generator could not be read")); };
      tx.oncomplete = () => reject(new Error("Generator probe unexpectedly committed"));
    });
  }
  async function read() {
    if (!/^https?:$/.test(location.protocol)) fail("unsupported origin");
    const result = { schema: "hoai-origin-storage-v1", origin: location.origin, localStorage: [], indexedDB: [] };
    for (let i = 0; i < localStorage.length; i++) { const name = localStorage.key(i); result.localStorage.push({ name, value: localStorage.getItem(name) }); }
    const databases = await indexedDB.databases();
    if (databases.length > 100) fail("too many databases");
    let count = 0, readBytes = 0, readSlots = 0;
    const accountRead = (value, seen = new Set(), depth = 0) => {
      if(depth>128)fail("value nesting exceeds limit");
      if(typeof value==="string")readBytes+=value.length*2;
      else if(value&&typeof value==="object"&&!seen.has(value)) {
        seen.add(value);readSlots++;
        if(value instanceof ArrayBuffer)readBytes+=value.byteLength;
        else if(ArrayBuffer.isView(value))accountRead(value.buffer,seen,depth+1);
        else if(value instanceof Blob)readBytes+=value.size;
        else if(value instanceof Map) {readSlots+=value.size*2;for(const [k,v]of value){accountRead(k,seen,depth+1);accountRead(v,seen,depth+1);}}
        else if(value instanceof Set) {readSlots+=value.size;for(const v of value)accountRead(v,seen,depth+1);}
        else if(!(value instanceof Date)&&!(value instanceof RegExp)) {
          readSlots+=Array.isArray(value)?value.length:Object.keys(value).length;
          for(const k of Object.keys(value)){readBytes+=k.length*2;accountRead(value[k],seen,depth+1);}
        }
      }
      if(readBytes>LIMIT_BYTES||readSlots>LIMIT_NODES)fail("source allocation exceeds limit");
    };
    for (const info of databases) {
      const db = await openExisting(info.name);
      try {
        const exported = { name: db.name, version: db.version, stores: [] };
        for (const storeName of db.objectStoreNames) {
          const captured = await new Promise((resolve,reject) => {
            const tx = db.transaction(storeName,"readonly"), store = tx.objectStore(storeName);
            const item = { name:storeName,keyPath:store.keyPath,autoIncrement:store.autoIncrement,indexes:[...store.indexNames].map(name=>{const index=store.index(name);return {name,indexKeyPath:index.keyPath,unique:index.unique,multiEntry:index.multiEntry};}),records:[] };
            const values=[], keys=[];
            let failure;
            const cursor=store.openCursor();
            cursor.onsuccess=()=>{
              const row=cursor.result;
              if(!row)return;
              try {
                if(++count>LIMIT_RECORDS)fail("too many database records");
                accountRead(row.key); accountRead(row.value);
                keys.push(row.key);values.push(row.value);row.continue();
              } catch(error) {failure=error;tx.abort();}
            };
            tx.oncomplete=()=>resolve({item,entries:[values,keys]});
            tx.onabort=()=>reject(failure||tx.error||new Error("IndexedDB read aborted"));
            tx.onerror=()=>{};
          });
          const {item,entries}=captured;
          // Capture keys and records in one graph, retaining shared buffers/cycles.
          item.graph = await encode({ keys: entries[1], values: entries[0] });
          if (item.autoIncrement) item.nextKey = await nextGeneratedKey(db, storeName);
          exported.stores.push(item);
        }
        result.indexedDB.push(exported);
      } finally { db.close(); }
    }
    prepare(result);
    return bounded(result);
  }

  function prepare(snapshot) {
    bounded(snapshot);
    if (!snapshot || snapshot.schema !== "hoai-origin-storage-v1" || snapshot.origin !== location.origin || !Array.isArray(snapshot.localStorage) || !Array.isArray(snapshot.indexedDB) || snapshot.indexedDB.length > 100) fail("wrong origin or schema");
    // Complete bounded validation/decode before touching destination storage.
    const names=new Set(), localNames=new Set(), prepared=[], budget={slots:0};
    const inlineKey=(value,path)=>Array.isArray(path)?path.map(part=>inlineKey(value,part)):path===""?value:path.split(".").reduce((item,part)=>item===null||item===undefined?undefined:item[part],value);
    const name=value=>typeof value==="string"&&value.length<=1024;
    const keyPath=value=>value===null||name(value)||Array.isArray(value)&&value.length<=100&&value.every(name);
    let count=0;
    for(const item of snapshot.localStorage) {
      if(!item||typeof item.name!=="string"||typeof item.value!=="string"||localNames.has(item.name))fail("invalid local storage");
      localNames.add(item.name);
    }
    for(const info of snapshot.indexedDB) {
      if(!info||!name(info.name)||names.has(info.name)||!Number.isSafeInteger(info.version)||info.version<1||!Array.isArray(info.stores)||info.stores.length>100)fail("invalid database schema");
      names.add(info.name);
      const stores=[], storeNames=new Set();
      for(const item of info.stores) {
        if(!item||!name(item.name)||storeNames.has(item.name)||!keyPath(item.keyPath)||typeof item.autoIncrement!=="boolean"||!Array.isArray(item.indexes)||item.indexes.length>100)fail("invalid store schema");
        if(item.autoIncrement&&(Array.isArray(item.keyPath)||item.keyPath===""||!Number.isSafeInteger(item.nextKey)||item.nextKey<1))fail("invalid generator");
        storeNames.add(item.name);
        const indexes=new Set();
        for(const index of item.indexes) {
          if(!index||!name(index.name)||indexes.has(index.name)||index.indexKeyPath===null||!keyPath(index.indexKeyPath)||typeof index.unique!=="boolean"||typeof index.multiEntry!=="boolean"||index.multiEntry&&Array.isArray(index.indexKeyPath))fail("invalid index schema");
          indexes.add(index.name);
        }
        const decoded=decode(item.graph,budget);
        if(!decoded||!Array.isArray(decoded.keys)||!Array.isArray(decoded.values)||decoded.keys.length!==decoded.values.length)fail("invalid records");
        count+=decoded.keys.length;if(count>LIMIT_RECORDS)fail("too many records");
        if(item.keyPath!==null)for(let i=0;i<decoded.keys.length;i++)if(indexedDB.cmp(decoded.keys[i],inlineKey(decoded.values[i],item.keyPath))!==0)fail("inline record key mismatch");
        const sortedKeys=[...decoded.keys].sort((a,b)=>indexedDB.cmp(a,b));
        for(let i=0;i<sortedKeys.length;i++){indexedDB.cmp(sortedKeys[i],sortedKeys[i]);if(i&&indexedDB.cmp(sortedKeys[i-1],sortedKeys[i])===0)fail("duplicate record key");}
        stores.push({item,decoded});
      }
      prepared.push({info,stores});
    }
    return prepared;
  }

  async function restore(snapshot) {
    const prepared=prepare(snapshot);
    if(localStorage.length||(await indexedDB.databases()).length)fail("destination must be empty");
    try {
      for(const item of snapshot.localStorage)localStorage.setItem(item.name,item.value);
      for(const {info,stores} of prepared) {
        const opened=indexedDB.open(info.name,info.version);
        opened.onupgradeneeded=()=>{
          try {
            for(const {item} of stores) {
              const store=opened.result.createObjectStore(item.name,{keyPath:item.keyPath,autoIncrement:item.autoIncrement});
              for(const index of item.indexes)store.createIndex(index.name,index.indexKeyPath,{unique:index.unique,multiEntry:index.multiEntry});
            }
          } catch {opened.transaction.abort();}
        };
        const db=await request(opened);
        try {
          for(const {item,decoded} of stores) {
            const tx=db.transaction(item.name,"readwrite"), done=transaction(tx), store=tx.objectStore(item.name);
            // Mark rejection handled while synchronous queue validation runs.
            done.catch(()=>{});
            try {
              for(let i=0;i<decoded.keys.length;i++) {
                if(store.keyPath===null)store.add(decoded.values[i],decoded.keys[i]);
                else store.add(decoded.values[i]);
              }
            } catch(error) {try{tx.abort();}catch{}await done.catch(()=>{});throw error;}
            await done;
            if(item.autoIncrement) {
              const actual=await nextGeneratedKey(db,item.name);
              if(actual>item.nextKey)fail("generator mismatch");
              if(actual<item.nextKey) {
                const bump=db.transaction(item.name,"readwrite"), completed=transaction(bump), target=bump.objectStore(item.name), value={};
                completed.catch(()=>{});
                try {
                  if(target.keyPath===null)target.add(value,item.nextKey-1);
                  else {assignKey(value,target.keyPath,item.nextKey-1);target.add(value);}
                  target.delete(item.nextKey-1);
                }catch(error){try{bump.abort();}catch{}await completed.catch(()=>{});throw error;}
                await completed;
              }
            }
          }
        } finally {db.close();}
      }
      return true;
    } catch(error) {
      // This origin was empty on admission. No failed stage may remain usable.
      localStorage.clear();
      for(const info of await indexedDB.databases())await request(indexedDB.deleteDatabase(info.name));
      throw new Error("profile_storage: destination staging failed");
    }
  }

  return { encode, decode, read, restore };
}
module.exports = { createStorageAdapter };
