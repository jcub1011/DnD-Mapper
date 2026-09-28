/**
 * Promise-based IndexedDB engine wrapper for DnD Mapper.
 */

import { DB_NAME, DB_VERSION, STORE_IMAGES, STORE_LIBRARY, STORE_SLOTS_INDEX } from "./schema.js";

export class StorageQuotaError extends Error {
  constructor(
    message = "Storage quota exceeded. The browser cannot store additional campaign data or images.",
  ) {
    super(message);
    this.name = "StorageQuotaError";
  }
}

function wrapError(err: unknown): Error {
  if (
    err &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name: string }).name === "QuotaExceededError"
  ) {
    return new StorageQuotaError();
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

export function openDatabase(dbName = DB_NAME, version = DB_VERSION): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new Error("IndexedDB is not available in this environment."));
  }

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, version);

    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_LIBRARY)) {
        db.createObjectStore(STORE_LIBRARY);
      }
      if (!db.objectStoreNames.contains(STORE_SLOTS_INDEX)) {
        db.createObjectStore(STORE_SLOTS_INDEX);
      }
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        db.createObjectStore(STORE_IMAGES);
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(wrapError(req.error ?? new Error("indexedDB.open failed")));
    req.onblocked = () => reject(new Error("indexedDB.open blocked by another open connection"));
  });
}

export function getFromStore<T>(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.get(key);

      req.onsuccess = () => {
        resolve((req.result as T) ?? null);
      };
      req.onerror = () => reject(wrapError(req.error));
      tx.onerror = () => reject(wrapError(tx.error));
    } catch (err) {
      reject(wrapError(err));
    }
  });
}

export function putToStore<T>(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  value: T,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      store.put(value, key);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(wrapError(tx.error));
      tx.onabort = () => reject(wrapError(tx.error ?? new Error("Transaction aborted")));
    } catch (err) {
      reject(wrapError(err));
    }
  });
}

export function deleteFromStore(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      store.delete(key);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(wrapError(tx.error));
      tx.onabort = () => reject(wrapError(tx.error ?? new Error("Transaction aborted")));
    } catch (err) {
      reject(wrapError(err));
    }
  });
}

export function putBatch(
  db: IDBDatabase,
  storeName: string,
  items: ReadonlyArray<{ readonly key: IDBValidKey; readonly value: unknown }>,
): Promise<void> {
  if (items.length === 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);

      for (const item of items) {
        store.put(item.value, item.key);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(wrapError(tx.error));
      tx.onabort = () => reject(wrapError(tx.error ?? new Error("Transaction aborted")));
    } catch (err) {
      reject(wrapError(err));
    }
  });
}

export function deleteBatch(
  db: IDBDatabase,
  storeName: string,
  keys: readonly IDBValidKey[],
): Promise<void> {
  if (keys.length === 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);

      for (const k of keys) {
        store.delete(k);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(wrapError(tx.error));
      tx.onabort = () => reject(wrapError(tx.error ?? new Error("Transaction aborted")));
    } catch (err) {
      reject(wrapError(err));
    }
  });
}

export function getAllKeysFromStore(db: IDBDatabase, storeName: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.getAllKeys();

      req.onsuccess = () => {
        const keys = (req.result as IDBValidKey[]).map(String);
        resolve(keys);
      };
      req.onerror = () => reject(wrapError(req.error));
      tx.onerror = () => reject(wrapError(tx.error));
    } catch (err) {
      reject(wrapError(err));
    }
  });
}

export function deleteDatabase(dbName = DB_NAME): Promise<void> {
  if (!isIndexedDbAvailable()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(wrapError(req.error ?? new Error("deleteDatabase failed")));
    req.onblocked = () => reject(new Error("deleteDatabase blocked"));
  });
}
