// Tiny IndexedDB key/value wrapper: game data files and save states live on the user's device only.
const DB = 'another-world';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('files');
      req.result.createObjectStore('saves');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => { db.close(); resolve(result.result); };
    t.onerror = t.onabort = () => { db.close(); reject(t.error); };
  });
}

export const putFile = (name, bytes) => tx('files', 'readwrite', (s) => s.put(bytes, name));
export const getFile = (name) => tx('files', 'readonly', (s) => s.get(name));
export const clearFiles = () => tx('files', 'readwrite', (s) => s.clear());
export const putSave = (slot, data) => tx('saves', 'readwrite', (s) => s.put(data, slot));
export const getSave = (slot) => tx('saves', 'readonly', (s) => s.get(slot));
