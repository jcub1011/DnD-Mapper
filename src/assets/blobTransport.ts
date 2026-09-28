/**
 * BlobTransport abstractions and implementations for content-addressed blob sharing.
 *
 * Implements 08 — Asset Pipeline and 09 — Blob Share (Platform Feature Spec).
 *
 * Database "knockbox-local-blobs":
 *   store "blobs"    key = sha256                value = Blob
 *   store "handles"  key = [lobbyId, logicalId]  value = { sha256: string }
 */

export interface BlobTransport {
  has(sha256: string): Promise<boolean>;
  put(sha256: string, blob: Blob): Promise<void>;
  register(logicalId: string, sha256: string): Promise<void>;
  unregister(logicalId: string): Promise<void>;

  /** The handle lookup: logicalId -> hash, or null if this client holds no handle. */
  hashFor(logicalId: string): Promise<string | null>;

  /** Asynchronous: locally reads the Blob from IndexedDB and mints an object URL. */
  urlFor(sha256: string): Promise<string>;
}

export const LOCAL_BLOB_DB_NAME = "knockbox-local-blobs";
export const LOCAL_BLOB_DB_VERSION = 1;
export const STORE_BLOBS = "blobs";
export const STORE_HANDLES = "handles";
export const DEFAULT_LOBBY_ID = "local";

/**
 * Computes lowercase hex-encoded SHA-256 digest of a Blob.
 */
export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function openBlobDatabase(
  dbName = LOCAL_BLOB_DB_NAME,
  version = LOCAL_BLOB_DB_VERSION,
): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined" || indexedDB === null) {
    return Promise.reject(new Error("IndexedDB is not available in this environment."));
  }

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, version);

    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS);
      }
      if (!db.objectStoreNames.contains(STORE_HANDLES)) {
        db.createObjectStore(STORE_HANDLES);
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
    req.onblocked = () => reject(new Error("indexedDB.open blocked by another open connection"));
  });
}

/**
 * IndexedDB-backed BlobTransport for 'solo' and 'local-tab' launch modes.
 *
 * Implements R6 refcounting: identical bytes are stored once in the 'blobs' store,
 * and individual logical ids hold independent handles in the 'handles' store.
 * An image file is deleted from 'blobs' if and only if all handles pointing to it
 * are released.
 */
export class IdbBlobTransport implements BlobTransport {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    public readonly lobbyId = DEFAULT_LOBBY_ID,
    private readonly dbName = LOCAL_BLOB_DB_NAME,
  ) {}

  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openBlobDatabase(this.dbName);
    }
    return this.dbPromise;
  }

  public async has(sha256: string): Promise<boolean> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_BLOBS, "readonly");
        const store = tx.objectStore(STORE_BLOBS);
        const req = store.count(sha256);
        req.onsuccess = () => resolve(req.result > 0);
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  public async put(sha256: string, blob: Blob): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_BLOBS, "readwrite");
        const store = tx.objectStore(STORE_BLOBS);
        store.put(blob, sha256);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
      } catch (err) {
        reject(err);
      }
    });
  }

  public async register(logicalId: string, sha256: string): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_HANDLES, "readwrite");
        const store = tx.objectStore(STORE_HANDLES);
        const handleKey = [this.lobbyId, logicalId];
        store.put({ sha256 }, handleKey);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
      } catch (err) {
        reject(err);
      }
    });
  }

  public async unregister(logicalId: string): Promise<void> {
    const db = await this.getDb();
    const handleKey = [this.lobbyId, logicalId];

    // Read existing handle to find which sha256 was pointed to
    const existingSha256 = await new Promise<string | null>((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_HANDLES, "readonly");
        const store = tx.objectStore(STORE_HANDLES);
        const req = store.get(handleKey);
        req.onsuccess = () => {
          const res = req.result as { sha256: string } | undefined;
          resolve(res ? res.sha256 : null);
        };
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });

    if (!existingSha256) {
      // Defensive no-op on unknown handle
      return;
    }

    // Delete handle and check remaining references across handles
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction([STORE_HANDLES, STORE_BLOBS], "readwrite");
        const handlesStore = tx.objectStore(STORE_HANDLES);
        const blobsStore = tx.objectStore(STORE_BLOBS);

        handlesStore.delete(handleKey);

        const getAllReq = handlesStore.getAll();
        getAllReq.onsuccess = () => {
          const allHandles = (getAllReq.result as Array<{ sha256: string }> | undefined) ?? [];
          const remainingRefCount = allHandles.filter((h) => h.sha256 === existingSha256).length;

          if (remainingRefCount === 0) {
            blobsStore.delete(existingSha256);
          }
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
      } catch (err) {
        reject(err);
      }
    });
  }

  public async releaseLobby(lobbyId = this.lobbyId): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction([STORE_HANDLES, STORE_BLOBS], "readwrite");
        const handlesStore = tx.objectStore(STORE_HANDLES);
        const blobsStore = tx.objectStore(STORE_BLOBS);

        const keysReq = handlesStore.getAllKeys();
        const valsReq = handlesStore.getAll();

        keysReq.onsuccess = () => {
          valsReq.onsuccess = () => {
            const keys = (keysReq.result as Array<[string, string]>) ?? [];
            const vals = (valsReq.result as Array<{ sha256: string }>) ?? [];

            const hashesToRecheck = new Set<string>();
            const keysToDelete: Array<[string, string]> = [];

            for (let i = 0; i < keys.length; i++) {
              const k = keys[i];
              if (Array.isArray(k) && k[0] === lobbyId) {
                keysToDelete.push(k);
                if (vals[i]) hashesToRecheck.add(vals[i].sha256);
              }
            }

            for (const k of keysToDelete) {
              handlesStore.delete(k);
            }

            // Calculate remaining references for hashes after deletions
            const remainingVals = vals.filter((_, i) => !keysToDelete.includes(keys[i]));
            for (const hash of hashesToRecheck) {
              const remainingCount = remainingVals.filter((v) => v.sha256 === hash).length;
              if (remainingCount === 0) {
                blobsStore.delete(hash);
              }
            }
          };
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
      } catch (err) {
        reject(err);
      }
    });
  }

  public async hashFor(logicalId: string): Promise<string | null> {
    const db = await this.getDb();
    const handleKey = [this.lobbyId, logicalId];
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_HANDLES, "readonly");
        const store = tx.objectStore(STORE_HANDLES);
        const req = store.get(handleKey);
        req.onsuccess = () => {
          const res = req.result as { sha256: string } | undefined;
          resolve(res ? res.sha256 : null);
        };
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  public async urlFor(sha256: string): Promise<string> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_BLOBS, "readonly");
        const store = tx.objectStore(STORE_BLOBS);
        const req = store.get(sha256);
        req.onsuccess = () => {
          try {
            const blob = req.result as Blob | undefined;
            if (!blob) {
              resolve("");
              return;
            }
            if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
              resolve(URL.createObjectURL(blob));
            } else {
              resolve(`blob:mock/${sha256}`);
            }
          } catch (err) {
            reject(err);
          }
        };
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  public async clear(): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction([STORE_HANDLES, STORE_BLOBS], "readwrite");
        tx.objectStore(STORE_HANDLES).clear();
        tx.objectStore(STORE_BLOBS).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
      } catch (err) {
        reject(err);
      }
    });
  }

  public close(): void {
    if (this.dbPromise) {
      this.dbPromise.then((db) => db.close()).catch(() => {});
      this.dbPromise = null;
    }
  }
}

/**
 * HTTP-backed BlobTransport for 'platform' launch mode calling KnockBox server /blob endpoints.
 */
export class HttpBlobTransport implements BlobTransport {
  private readonly handles = new Map<string, string>(); // logicalId -> sha256
  private readonly urls = new Map<string, string>(); // sha256 -> url

  constructor(
    private readonly ticket: string | null = null,
    private readonly baseUrl = "",
  ) {}

  private get headers(): HeadersInit {
    const h: Record<string, string> = {};
    if (this.ticket) {
      h["X-KnockBox-Ticket"] = this.ticket;
    }
    return h;
  }

  public async has(sha256: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/blob/${sha256}`, {
        method: "HEAD",
        headers: this.headers,
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  public async put(sha256: string, blob: Blob): Promise<void> {
    const res = await fetch(`${this.baseUrl}/blob/${sha256}`, {
      method: "PUT",
      headers: {
        ...this.headers,
        "Content-Type": blob.type || "application/octet-stream",
      },
      body: blob,
    });
    if (!res.ok && res.status !== 200) {
      throw new Error(`Failed to upload blob (${res.status}): ${await res.text()}`);
    }
  }

  public async register(
    logicalId: string,
    sha256: string,
    contentType = "image/webp",
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/blob/register`, {
      method: "POST",
      headers: {
        ...this.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ logicalId, sha256, contentType }),
    });

    if (!res.ok) {
      throw new Error(`Failed to register blob handle (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as { ok?: boolean; url?: string };
    this.handles.set(logicalId, sha256);
    if (data.url) {
      this.urls.set(sha256, data.url);
    }
  }

  public async unregister(logicalId: string): Promise<void> {
    this.handles.delete(logicalId);
    try {
      await fetch(`${this.baseUrl}/blob/register/${encodeURIComponent(logicalId)}`, {
        method: "DELETE",
        headers: this.headers,
      });
    } catch {
      // Defensive
    }
  }

  public async hashFor(logicalId: string): Promise<string | null> {
    return this.handles.get(logicalId) ?? null;
  }

  public async urlFor(sha256: string): Promise<string> {
    return this.urls.get(sha256) ?? `${this.baseUrl}/blob/${sha256}`;
  }
}

/**
 * Interface describing the blob methods exposed by KnockBox client plugins / peers.
 */
export interface KnockBoxBlobPlugin {
  registerBlob(logicalId: string, blob: Blob): Promise<string>;
  unregisterBlob(logicalId: string): Promise<void>;
  blobUrl(logicalId: string): string | null;
}

/**
 * KnockBox Addon-backed BlobTransport for 'platform' launch mode,
 * delegating to knockbox.registerBlob / unregisterBlob / blobUrl.
 *
 * Implements 09 — Blob Share (Platform Feature Spec) § Don't block the port on the addon release.
 */
export class KbBlobTransport implements BlobTransport {
  private readonly stagedBlobs = new Map<string, Blob>();
  private readonly handles = new Map<string, string>(); // logicalId -> sha256
  private readonly urls = new Map<string, string>(); // sha256 -> url

  constructor(private readonly plugin: KnockBoxBlobPlugin) {}

  public async has(sha256: string): Promise<boolean> {
    return this.urls.has(sha256);
  }

  public async put(sha256: string, blob: Blob): Promise<void> {
    this.stagedBlobs.set(sha256, blob);
  }

  public async register(logicalId: string, sha256: string): Promise<void> {
    const staged = this.stagedBlobs.get(sha256);
    if (!staged) {
      throw new Error(
        `Cannot register blob for logicalId "${logicalId}": no staged blob for hash ${sha256}`,
      );
    }
    const url = await this.plugin.registerBlob(logicalId, staged);
    this.handles.set(logicalId, sha256);
    this.urls.set(sha256, url);
    this.stagedBlobs.delete(sha256);
  }

  public async unregister(logicalId: string): Promise<void> {
    this.handles.delete(logicalId);
    await this.plugin.unregisterBlob(logicalId);
  }

  public async hashFor(logicalId: string): Promise<string | null> {
    return this.handles.get(logicalId) ?? null;
  }

  public async urlFor(sha256: string): Promise<string> {
    return this.urls.get(sha256) ?? "";
  }
}

