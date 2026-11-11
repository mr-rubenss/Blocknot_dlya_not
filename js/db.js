// Хранилище на IndexedDB: партитуры, страницы и исходные файлы (PDF / изображения).
const DB_NAME = 'notebook-notes';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('scores')) {
        db.createObjectStore('scores', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('pages')) {
        const pages = db.createObjectStore('pages', { keyPath: 'id' });
        pages.createIndex('scoreId', 'scoreId');
      }
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Транзакция отменена'));
  });
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function getAll(store) {
  const db = await openDB();
  return promisify(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, id) {
  const db = await openDB();
  return promisify(db.transaction(store).objectStore(store).get(id));
}

export async function put(store, value) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return txDone(tx);
}

export async function putMany(entries) {
  // entries: [[store, value], ...]
  const db = await openDB();
  const stores = [...new Set(entries.map((e) => e[0]))];
  const tx = db.transaction(stores, 'readwrite');
  for (const [store, value] of entries) tx.objectStore(store).put(value);
  return txDone(tx);
}

export async function del(store, id) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id);
  return txDone(tx);
}

export async function getPages(scoreId) {
  const db = await openDB();
  const idx = db.transaction('pages').objectStore('pages').index('scoreId');
  const pages = await promisify(idx.getAll(scoreId));
  return pages.sort((a, b) => a.order - b.order);
}

export async function deleteScore(scoreId) {
  const db = await openDB();
  const pages = await getPages(scoreId);
  const fileIds = new Set(pages.map((p) => p.bg && p.bg.fileId).filter(Boolean));
  const tx = db.transaction(['scores', 'pages', 'files'], 'readwrite');
  tx.objectStore('scores').delete(scoreId);
  for (const p of pages) tx.objectStore('pages').delete(p.id);
  for (const f of fileIds) tx.objectStore('files').delete(f);
  return txDone(tx);
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (!already) await navigator.storage.persist();
    }
  } catch (e) {
    /* не критично */
  }
}
