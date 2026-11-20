const DB_PREFIX = 'remote-panel-history-v1-';
const DEFAULT_MAX_THREADS = 12;
const DEFAULT_MAX_TURNS = 60;
const DEFAULT_MAX_BYTES = 600_000;

const openDbs = new Map();
const instances = new Set();

async function hashIdentity(token) {
  const bytes = new TextEncoder().encode(String(token));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

function openDb(name) {
  const existing = openDbs.get(name);
  if (existing) return existing;
  const promise = new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('threads')) db.createObjectStore('threads', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => { const db = request.result; db.onclose = () => openDbs.delete(name); resolve(db); };
    request.onerror = () => { openDbs.delete(name); reject(request.error); };
  });
  openDbs.set(name, promise);
  return promise;
}

const readResult = (request) => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const settled = (transaction) => new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });

export function createHistoryCache(getToken, options = {}) {
  const maxThreads = Number.isInteger(options.maxThreads) ? options.maxThreads : DEFAULT_MAX_THREADS;
  let dbPromise = null;
  let dbKey = '';
  let epoch = 0;

  async function scope() {
    let token = '';
    try { token = getToken ? getToken() : ''; } catch { token = ''; }
    if (!token) return '';
    try { return await hashIdentity(token); } catch { return ''; }
  }

  async function database() {
    const key = await scope();
    if (!key) return null;
    if (key === dbKey && dbPromise) return dbPromise;
    dbKey = key;
    dbPromise = openDb(DB_PREFIX + key).catch(() => { dbPromise = null; dbKey = ''; return null; });
    return dbPromise;
  }

  async function read(store, key) {
    const db = await database();
    if (!db || !db.objectStoreNames.contains(store)) return undefined;
    try { return await readResult(db.transaction(store, 'readonly').objectStore(store).get(key)); } catch { return undefined; }
  }

  async function readAll(store) {
    const db = await database();
    if (!db || !db.objectStoreNames.contains(store)) return [];
    try { return await readResult(db.transaction(store, 'readonly').objectStore(store).getAll()); } catch { return []; }
  }

  async function remove(store, key) {
    const db = await database();
    if (!db) return;
    try { const transaction = db.transaction(store, 'readwrite'); transaction.objectStore(store).delete(key); await settled(transaction); } catch {}
  }

  async function write(store, value) {
    const mine = epoch;
    const db = await database();
    if (!db || epoch !== mine) return false;
    try {
      const transaction = db.transaction(store, 'readwrite');
      transaction.objectStore(store).put(value);
      await settled(transaction);
      return epoch === mine;
    } catch { return false; }
  }

  function bound(entry) {
    let turns = Array.isArray(entry.turns) ? entry.turns : [];
    let truncated = turns.length > DEFAULT_MAX_TURNS;
    if (truncated) turns = turns.slice(0, DEFAULT_MAX_TURNS);
    let payload = { ...entry, turns };
    let guard = 0;
    while (JSON.stringify(payload).length > DEFAULT_MAX_BYTES && turns.length > 1 && guard++ < 24) {
      turns = turns.slice(0, Math.max(1, Math.floor(turns.length / 2)));
      truncated = true;
      payload = { ...entry, turns };
    }
    if (JSON.stringify(payload).length > DEFAULT_MAX_BYTES) { turns = []; truncated = true; payload = { ...entry, turns }; }
    return { ...payload, cursor: truncated ? (entry.headCursor ?? null) : (entry.cursor ?? null), pagedOlder: truncated ? false : Boolean(entry.pagedOlder) };
  }

  async function prune() {
    const all = await readAll('threads');
    if (all.length <= maxThreads) return;
    all.sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
    for (const stale of all.slice(maxThreads)) await remove('threads', stale.id);
  }

  const api = {
    async getThread(id) {
      if (!id) return null;
      const entry = await read('threads', String(id));
      return entry && entry.id ? entry : null;
    },
    async putThread(entry) {
      if (!entry || !entry.id) return false;
      const ok = await write('threads', { ...bound(entry), id: String(entry.id), usedAt: Date.now() });
      if (ok) await prune();
      return ok;
    },
    async entries() { return readAll('threads'); },
    async getSnapshot() { const entry = await read('meta', 'snapshot'); return entry && Array.isArray(entry.threads) ? entry : null; },
    async putSnapshot(threads, cursor) { if (!Array.isArray(threads)) return false; return write('meta', { key: 'snapshot', threads, cursor: cursor ?? null, usedAt: Date.now() }); },
    async clear() {
      const db = await database();
      if (!db) return;
      for (const store of ['threads', 'meta']) {
        if (!db.objectStoreNames.contains(store)) continue;
        try { const transaction = db.transaction(store, 'readwrite'); transaction.objectStore(store).clear(); await settled(transaction); } catch {}
      }
    },
    invalidate() {
      epoch++;
      dbKey = '';
      const pending = dbPromise;
      dbPromise = null;
      if (pending) pending.then((db) => { try { db.close(); } catch {} }).catch(() => {});
    },
  };
  instances.add(api);
  return api;
}

export async function clearHistoryCache() {
  for (const instance of instances) { try { instance.invalidate(); } catch {} }
  const names = new Set(openDbs.keys());
  try {
    if (typeof indexedDB.databases === 'function') {
      for (const info of await indexedDB.databases()) if (info && info.name && info.name.startsWith(DB_PREFIX)) names.add(info.name);
    }
  } catch {}
  await Promise.all([...names].map(async (name) => { try { await clearDb(name); } catch {} }));
  await Promise.all([...names].map((name) => new Promise((resolve) => {
    openDbs.delete(name);
    let request;
    try { request = indexedDB.deleteDatabase(name); } catch { resolve(); return; }
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  })));
}
