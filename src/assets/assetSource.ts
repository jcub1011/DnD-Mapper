/**
 * AssetSource abstractions for retrieving, publishing, and releasing map image assets.
 *
 * Implements 08 — Asset Pipeline:
 *  - LocalAssetSource: Phase 1 — DM local store, resolves blob: URLs from LibraryService.
 *  - BlobShareAssetSource: Phase 4 — Content-addressed sharing over BlobTransport (IdbBlobTransport or HttpBlobTransport).
 *  - NullAssetSource: Test double returning null to exercise dashed placeholder rendering.
 */

import type { LibraryService } from "../storage/libraryService.js";
import type { LaunchMode } from "../net/launch.js";
import {
  type BlobTransport,
  IdbBlobTransport,
  HttpBlobTransport,
  sha256Hex,
} from "./blobTransport.js";

export interface AssetSource {
  /** A URL Phaser can hand to `load.image()`, or null if unavailable here. */
  resolve(imageId: string): Promise<string | null>;

  /** Called by the DM after an image is added. No-op where there is nothing to publish. */
  publish(imageId: string, blob: Blob): Promise<void>;

  /** Called when an image is removed from the campaign. */
  release(imageId: string): Promise<void>;

  /** Backward-compatible alias for resolve(). */
  getUrl?(imageId: string): Promise<string | null>;
  revokeUrl?(imageId: string): void;
  has?(imageId: string): Promise<boolean>;
  dispose?(): void;
}

/**
 * An AssetSource serving images stored locally in IndexedDB via LibraryService.
 * Automatically creates and caches object URLs.
 */
export class LocalAssetSource implements AssetSource {
  private readonly urls = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(private readonly libraryService: LibraryService) {}

  public async resolve(imageId: string): Promise<string | null> {
    const existing = this.urls.get(imageId);
    if (existing) return existing;

    const inFlightPromise = this.inFlight.get(imageId);
    if (inFlightPromise) return inFlightPromise;

    const loadPromise = (async () => {
      try {
        const blob = await this.libraryService.getImage(imageId);
        if (!blob) return null;

        const url = URL.createObjectURL(blob);
        this.urls.set(imageId, url);
        return url;
      } finally {
        this.inFlight.delete(imageId);
      }
    })();

    this.inFlight.set(imageId, loadPromise);
    return loadPromise;
  }

  public async publish(_imageId: string, _blob: Blob): Promise<void> {
    // No-op for LocalAssetSource; the DM already has bytes in LibraryService
  }

  public async release(imageId: string): Promise<void> {
    const url = this.urls.get(imageId);
    if (url) {
      URL.revokeObjectURL(url);
      this.urls.delete(imageId);
    }
  }

  // ── Backward-compatible helpers ──────────────────────────────────────────

  public getUrl(imageId: string): Promise<string | null> {
    return this.resolve(imageId);
  }

  public revokeUrl(imageId: string): void {
    void this.release(imageId);
  }

  public async has(imageId: string): Promise<boolean> {
    if (this.urls.has(imageId)) return true;
    const blob = await this.libraryService.getImage(imageId);
    return blob !== null;
  }

  public dispose(): void {
    for (const url of this.urls.values()) {
      URL.revokeObjectURL(url);
    }
    this.urls.clear();
    this.inFlight.clear();
  }
}

/**
 * An AssetSource backed by a BlobTransport (IndexedDB locally or HTTP on platform).
 * Content-addressed: identical images hash identically and are stored once.
 */
export class BlobShareAssetSource implements AssetSource {
  constructor(public readonly transport: BlobTransport) {}

  public async publish(imageId: string, blob: Blob): Promise<void> {
    const hash = await sha256Hex(blob);
    if (!(await this.transport.has(hash))) {
      await this.transport.put(hash, blob);
    }
    await this.transport.register(imageId, hash);
  }

  public async resolve(imageId: string): Promise<string | null> {
    const hash = await this.transport.hashFor(imageId);
    if (hash === null) return null;
    return await this.transport.urlFor(hash);
  }

  public async release(imageId: string): Promise<void> {
    await this.transport.unregister(imageId);
  }

  public getUrl(imageId: string): Promise<string | null> {
    return this.resolve(imageId);
  }

  public async has(imageId: string): Promise<boolean> {
    const hash = await this.transport.hashFor(imageId);
    return hash !== null;
  }
}

/**
 * A test double AssetSource returning null for all assets.
 * Exercises the dashed placeholder rendering path.
 */
export class NullAssetSource implements AssetSource {
  public async resolve(_imageId?: string): Promise<string | null> {
    return null;
  }

  public async publish(_imageId: string, _blob: Blob): Promise<void> {}

  public async release(_imageId: string): Promise<void> {}

  public async getUrl(_imageId?: string): Promise<string | null> {
    return null;
  }

  public revokeUrl(_imageId?: string): void {}

  public async has(_imageId?: string): Promise<boolean> {
    return false;
  }
}

/**
 * Factory to construct the appropriate AssetSource based on launch mode.
 */
export function createAssetSource(
  launchMode: LaunchMode,
  _libraryService: LibraryService,
  ticket: string | null = null,
  lobbyId = "local",
): AssetSource {
  if (launchMode === "platform") {
    return new BlobShareAssetSource(new HttpBlobTransport(ticket));
  }

  // In solo and local-tab, use BlobShareAssetSource over IdbBlobTransport
  // to exercise identical multiplayer blob sharing locally.
  return new BlobShareAssetSource(new IdbBlobTransport(lobbyId));
}
