/**
 * 存储层：
 *  - IndexedDB: sources(来源配置) / files(歌谱索引) / handles(文件夹句柄)
 *  - OPFS(Origin Private File System): 导入/缓存的歌谱文件本体，可离线
 *  - localStorage: 轻量设置
 * 任何一层不可用都会自动降级到内存模式（应用仍可用，只是本次会话不持久化）。
 */

const DB_NAME = 'scorefinder';
const DB_VER = 1;
export const STORES = ['sources', 'files', 'handles'];

export const mem = {
  enabled: false,
  sources: new Map(),
  files: new Map(),
  handles: new Map(),
  opfs: new Map(), // path -> Blob
};

let dbPromise = null;
let openFailed = false;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let settled = false;
    const fallback = (why) => {
      if (settled) return;
      settled = true;
      openFailed = true;
      mem.enabled = true;
      console.warn('IndexedDB 不可用，切换到内存模式：' + why);
      resolve(null);
    };
    const timer = setTimeout(() => fallback('打开超时'), 3000);
    try {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) {
          const s = db.createObjectStore('files', { keyPath: 'id' });
          s.createIndex('sourceId', 'sourceId');
        }
        if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(req.result);
      };
      req.onerror = () => fallback(String(req.error));
      req.onblocked = () => fallback('被其它标签页占用');
    } catch (e) {
      fallback(e.message);
    }
  });
  return dbPromise;
}

function run(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const s = tx.objectStore(store);
    let out;
    try {
      out = fn(s);
    } catch (e) {
      reject(e);
      return;
    }
    tx.oncomplete = () => {
      // IDBRequest.result 可能是 undefined（例如 get 一个不存在的 key），
      // 不能把 request 对象本身当成结果返回
      resolve(out && typeof out === 'object' && 'result' in out ? out.result : out);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function idbGetAll(store) {
  const db = await openDB();
  if (!db) return [...mem[store].values()];
  return run(db, store, 'readonly', (s) => s.getAll());
}
export async function idbGet(store, key) {
  const db = await openDB();
  if (!db) return mem[store].get(key);
  return run(db, store, 'readonly', (s) => s.get(key));
}
export async function idbPut(store, value) {
  const db = await openDB();
  if (!db) {
    mem[store].set(value.id, value);
    return;
  }
  return run(db, store, 'readwrite', (s) => s.put(value));
}
export async function idbDelete(store, key) {
  const db = await openDB();
  if (!db) {
    mem[store].delete(key);
    return;
  }
  return run(db, store, 'readwrite', (s) => s.delete(key));
}
export async function idbClear(store) {
  const db = await openDB();
  if (!db) {
    mem[store].clear();
    return;
  }
  return run(db, store, 'readwrite', (s) => s.clear());
}
export async function idbPutMany(store, values, chunk = 400) {
  const db = await openDB();
  if (!db) {
    for (const v of values) mem[store].set(v.id, v);
    return;
  }
  for (let i = 0; i < values.length; i += chunk) {
    const part = values.slice(i, i + chunk);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const s = tx.objectStore(store);
      for (const v of part) s.put(v);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
}
export async function idbDeleteByIndex(store, indexName, key) {
  const db = await openDB();
  if (!db) {
    for (const [k, v] of mem[store]) if (v[indexName] === key) mem[store].delete(k);
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const idx = tx.objectStore(store).index(indexName);
    const req = idx.openCursor(IDBKeyRange.only(key));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        cur.delete();
        cur.continue();
      }
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------- 设置 ---------------- */

const SETTINGS_KEY = 'scorefinder.settings';
const DEFAULT_SETTINGS = {
  driveClientId: '',
  driveApiKey: '',
  driveMode: 'apiKey',
  driveFolder: '',
  driveFolderName: '',
  autoCacheViewed: true,
  persistRequested: false,
};

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
export function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
  return s;
}

/* ---------------- OPFS（不可用时降级为内存 Blob） ---------------- */

let opfsStatus = null; // null=未知 true=可用 false=不可用

export async function opfsAvailable() {
  if (opfsStatus !== null) return opfsStatus;
  try {
    const root = await Promise.race([
      navigator.storage.getDirectory(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('OPFS 超时')), 3000)),
    ]);
    opfsStatus = !!root;
  } catch {
    opfsStatus = false;
  }
  if (!opfsStatus) console.warn('OPFS 不可用，文件将只保存在内存中');
  return opfsStatus;
}

export async function opfsRoot() {
  return navigator.storage.getDirectory();
}

async function opfsDir(parts, create = false) {
  let dir = await opfsRoot();
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return dir;
}

export function safeFileName(name) {
  return String(name).replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180);
}

const memKey = (parts) => parts.map(safeFileName).join('/');

export async function opfsWrite(parts, blob) {
  if (!(await opfsAvailable())) {
    mem.opfs.set(memKey(parts), blob);
    return;
  }
  const dir = await opfsDir(parts.slice(0, -1), true);
  const fh = await dir.getFileHandle(safeFileName(parts[parts.length - 1]), { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

export async function opfsRead(parts) {
  if (!(await opfsAvailable())) return mem.opfs.get(memKey(parts)) || null;
  try {
    const dir = await opfsDir(parts.slice(0, -1), false);
    const fh = await dir.getFileHandle(safeFileName(parts[parts.length - 1]));
    return await fh.getFile();
  } catch {
    return null;
  }
}

export async function opfsDelete(parts) {
  if (!(await opfsAvailable())) return mem.opfs.delete(memKey(parts));
  try {
    const dir = await opfsDir(parts.slice(0, -1), false);
    await dir.removeEntry(safeFileName(parts[parts.length - 1]));
    return true;
  } catch {
    return false;
  }
}

export async function opfsListNames(parts) {
  if (!(await opfsAvailable())) {
    const prefix = parts.map(safeFileName).join('/') + '/';
    return [...mem.opfs.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split('/')[0]);
  }
  try {
    const dir = await opfsDir(parts, false);
    const out = [];
    for await (const [name] of dir.entries()) out.push(name);
    return out;
  } catch {
    return [];
  }
}

export async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch {
    /* ignore */
  }
  return false;
}

export async function storageUsage() {
  try {
    const est = await navigator.storage.estimate();
    return { usage: est.usage || 0, quota: est.quota || 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}
