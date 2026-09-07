/**
 * A very small key/value store on IndexedDB.
 *
 * Device pairing has to outlive the tab, which rules out `sessionStorage`, and it has
 * to hold a non-extractable `CryptoKey`, which rules out `localStorage` — only
 * structured clone can carry one, and only IndexedDB persists it. Nothing here needs
 * indexes or queries, so this stays a bare get/put/delete rather than pulling in a
 * wrapper library.
 */

const DB_NAME = "gsend";
const DB_VERSION = 1;
const STORE = "kv";

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (opening) return opening;

  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
    // Another tab is holding an older version open. Rare, and retrying is pointless.
    request.onblocked = () => reject(new Error("indexedDB blocked"));
  });

  // A failed open must not be cached, or every later call inherits the same rejection.
  opening.catch(() => {
    opening = null;
  });

  return opening;
}

function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = body(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
      }),
  );
}

export function dbGet<T>(key: string): Promise<T | undefined> {
  return run<T | undefined>("readonly", (store) => store.get(key));
}

export function dbPut(key: string, value: unknown): Promise<void> {
  return run<void>("readwrite", (store) => store.put(value, key));
}

export function dbDelete(key: string): Promise<void> {
  return run<void>("readwrite", (store) => store.delete(key));
}

/**
 * Private browsing and some locked-down configurations reject IndexedDB outright.
 * Pairing is a convenience layered on top of a working app, so callers treat an
 * unavailable store as "this device simply has no memory" rather than an error.
 */
export function dbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}
