/**
 * AssetSource abstractions for retrieving and managing image URLs.
 */

import type { LibraryService } from "../storage/libraryService.js";

export interface AssetSource {
  getUrl(imageId: string): Promise<string | null>;
  revokeUrl(imageId: string): void;
  has(imageId: string): Promise<boolean>;
  dispose?(): void;
}

/**
 * An AssetSource that serves images stored locally in IndexedDB via LibraryService.
 * Automatically creates and caches object URLs.
 */
export class LocalAssetSource implements AssetSource {
  private readonly urls = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(private readonly libraryService: LibraryService) {}

  public async getUrl(imageId: string): Promise<string | null> {
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

  public revokeUrl(imageId: string): void {
    const url = this.urls.get(imageId);
    if (url) {
      URL.revokeObjectURL(url);
      this.urls.delete(imageId);
    }
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
 * A no-op AssetSource returning null for all assets.
 */
export class NullAssetSource implements AssetSource {
  public async getUrl(_imageId?: string): Promise<string | null> {
    return null;
  }

  public revokeUrl(_imageId?: string): void {}

  public async has(_imageId?: string): Promise<boolean> {
    return false;
  }
}
