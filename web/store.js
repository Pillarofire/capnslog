// IndexedDB holds only data that is already ciphertext (server records and staged writes).
const DB = 'capnslog';
let dbp = null;

function open() {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('kv');
      db.createObjectStore('blocks', { keyPath: 'id' });
      db.createObjectStore('pending', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn, fallback) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const rq = fn(t.objectStore(store));
      t.oncomplete = () => resolve(rq ? rq.result : undefined);
      t.onerror = t.onabort = () => reject(t.error);
    });
  } catch (e) {
    if (typeof indexedDB !== 'undefined') console.warn('IndexedDB:', e);
    return fallback;
  }
}

export const idb = {
  get: (s, k) => tx(s, 'readonly', (o) => o.get(k), undefined),
  put: (s, v, k) => tx(s, 'readwrite', (o) => o.put(v, k), undefined),
  del: (s, k) => tx(s, 'readwrite', (o) => o.delete(k), undefined),
  all: (s) => tx(s, 'readonly', (o) => o.getAll(), []),
  clear: (s) => tx(s, 'readwrite', (o) => o.clear(), undefined),
  async wipe() { for (const s of ['kv', 'blocks', 'pending']) await this.clear(s); },
};
