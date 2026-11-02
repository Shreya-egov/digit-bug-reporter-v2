// IndexedDB stores, shared by the service worker, the offscreen recorder and the extension pages (same origin):
//   reports  bug reports (video blob, screenshot, captured events, draft text); only the newest 10 are kept
//   bugs     bug tracker rows; kept for good, and small (no media)
//   meta     small values, e.g. the linked tracker workbook's file handle and the last sync result
const DB_NAME = 'digit-bug-reporter';
const REPORTS = 'reports';
const BUGS = 'bugs';
const META = 'meta';
const KEEP = 10;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const names = req.result.objectStoreNames;
      if (!names.contains(REPORTS)) req.result.createObjectStore(REPORTS, { keyPath: 'id' });
      if (!names.contains(BUGS)) req.result.createObjectStore(BUGS, { keyPath: 'id' });
      if (!names.contains(META)) req.result.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => { db.close(); resolve(result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const get = (id) => tx(REPORTS, 'readonly', (s) => wrap(s.get(id)));

export const put = (report) => tx(REPORTS, 'readwrite', (s) => wrap(s.put(report)));

export const remove = (id) => tx(REPORTS, 'readwrite', (s) => wrap(s.delete(id)));

// Merge fields into an existing report inside one transaction.
export const update = (id, patch) => tx(REPORTS, 'readwrite', async (s) => {
  const current = (await wrap(s.get(id))) || { id };
  await wrap(s.put({ ...current, ...patch }));
});

// Keep only the newest reports so old videos don't pile up.
export const prune = () => tx(REPORTS, 'readwrite', async (s) => {
  const all = await wrap(s.getAll());
  all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const r of all.slice(KEEP)) await wrap(s.delete(r.id));
});

export const bugs = {
  get: (id) => tx(BUGS, 'readonly', (s) => wrap(s.get(id))),
  all: () => tx(BUGS, 'readonly', (s) => wrap(s.getAll())),
  remove: (id) => tx(BUGS, 'readwrite', (s) => wrap(s.delete(id))),
  // change(current or undefined) returns the new row; read and write happen in one transaction
  change: (id, change) => tx(BUGS, 'readwrite', async (s) => {
    const next = change(await wrap(s.get(id)));
    await wrap(s.put(next));
    return next;
  }),
};

export const meta = {
  get: (key) => tx(META, 'readonly', (s) => wrap(s.get(key))),
  set: (key, value) => tx(META, 'readwrite', (s) => wrap(s.put(value, key))),
  remove: (key) => tx(META, 'readwrite', (s) => wrap(s.delete(key))),
};
