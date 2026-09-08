import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDatabase } from "../storage/db.js";
import { LibraryService } from "../storage/libraryService.js";
import { LocalAssetSource, NullAssetSource } from "./assetSource.js";
import { decodeAndMaybeDownscale } from "./imageDownscale.js";
import {
  MAX_TEXTURE_SIZE_CAP,
  probeMaxTextureSize,
  resetMaxTextureSizeForTesting,
} from "./textureSize.js";

describe("Asset Pipeline", () => {
  describe("Texture Size Probing", () => {
    beforeEach(() => {
      resetMaxTextureSizeForTesting();
    });

    afterEach(() => {
      resetMaxTextureSizeForTesting();
    });

    it("returns clamped default 8192 when WebGL is unavailable or fails", () => {
      const size = probeMaxTextureSize();
      expect(size).toBe(MAX_TEXTURE_SIZE_CAP);
    });

    it("caches probed size on repeat calls", () => {
      const size1 = probeMaxTextureSize();
      const size2 = probeMaxTextureSize();
      expect(size1).toBe(size2);
    });
  });

  describe("AssetSource", () => {
    let service: LibraryService;

    beforeEach(async () => {
      await deleteDatabase();
      service = new LibraryService();
      await service.attach();
    });

    afterEach(async () => {
      await service.detach();
      await deleteDatabase();
    });

    it("NullAssetSource returns null for all queries", async () => {
      const source = new NullAssetSource();
      expect(await source.getUrl("any-id")).toBeNull();
      expect(await source.has("any-id")).toBe(false);
      source.revokeUrl("any-id");
    });

    it("LocalAssetSource creates, caches, checks, and revokes object URLs", async () => {
      const origCreate = URL.createObjectURL;
      const origRevoke = URL.revokeObjectURL;

      const createdUrls: string[] = [];
      const revokedUrls: string[] = [];

      URL.createObjectURL = vi.fn((_blob: Blob) => {
        const u = `blob:mock-uuid-${createdUrls.length + 1}`;
        createdUrls.push(u);
        return u;
      });

      URL.revokeObjectURL = vi.fn((url: string) => {
        revokedUrls.push(url);
      });

      try {
        const blob = new Blob(["hello-bytes"], { type: "image/png" });
        await service.putImage("img-abc", blob);

        const source = new LocalAssetSource(service);
        expect(await source.has("img-abc")).toBe(true);
        expect(await source.has("missing-img")).toBe(false);

        // First getUrl fetches from DB and creates object URL
        const url1 = await source.getUrl("img-abc");
        expect(url1).toBe("blob:mock-uuid-1");
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

        // Second getUrl uses cache without creating new URL
        const url2 = await source.getUrl("img-abc");
        expect(url2).toBe("blob:mock-uuid-1");
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

        // Revoke URL
        source.revokeUrl("img-abc");
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-uuid-1");

        // Disposal revokes any remaining URLs
        const url3 = await source.getUrl("img-abc");
        expect(url3).toBe("blob:mock-uuid-2");
        source.dispose();
        expect(revokedUrls).toContain("blob:mock-uuid-2");
      } finally {
        URL.createObjectURL = origCreate;
        URL.revokeObjectURL = origRevoke;
      }
    });
  });

  describe("Image Downscaling", () => {
    it("returns original blob when dimensions are within limit", async () => {
      const testBlob = new Blob(["mock-image-data"], { type: "image/png" });
      const result = await decodeAndMaybeDownscale(testBlob, 8192);
      expect(result.blob).toBe(testBlob);
      expect(result.wasDownscaled).toBe(false);
    });
  });
});
