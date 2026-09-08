// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDatabase } from "../storage/db.js";
import { LibraryService } from "../storage/libraryService.js";
import {
  type AssetSource,
  BlobShareAssetSource,
  LocalAssetSource,
  NullAssetSource,
  createAssetSource,
} from "./assetSource.js";
import {
  IdbBlobTransport,
  LOCAL_BLOB_DB_NAME,
  sha256Hex,
} from "./blobTransport.js";
import { decodeAndMaybeDownscale } from "./imageDownscale.js";
import {
  MAX_TEXTURE_SIZE_CAP,
  probeMaxTextureSize,
  resetMaxTextureSizeForTesting,
} from "./textureSize.js";
import {
  MAX_FILE_SIZE_BYTES,
  MAX_ROOM_STORAGE_BYTES,
  type MapImage,
} from "../game/domain.js";
import { ensureTexture } from "../ui/map/imageLayer.js";

let origCreateObjectURL: typeof URL.createObjectURL;
let origRevokeObjectURL: typeof URL.revokeObjectURL;

beforeEach(() => {
  origCreateObjectURL = URL.createObjectURL;
  origRevokeObjectURL = URL.revokeObjectURL;
  let counter = 0;
  URL.createObjectURL = vi.fn(() => `blob:mock-uuid-${++counter}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  URL.createObjectURL = origCreateObjectURL;
  URL.revokeObjectURL = origRevokeObjectURL;
});

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

  describe("AssetSource Implementations", () => {
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

    it("NullAssetSource returns null for all queries and no-ops on publish/release", async () => {
      const source = new NullAssetSource();
      expect(await source.resolve("any-id")).toBeNull();
      expect(await source.getUrl("any-id")).toBeNull();
      expect(await source.has("any-id")).toBe(false);
      await source.publish("any-id", new Blob([""]));
      await source.release("any-id");
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

        // First resolve fetches from DB and creates object URL
        const url1 = await source.resolve("img-abc");
        expect(url1).toBe("blob:mock-uuid-1");
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

        // Second resolve uses cache without creating new URL
        const url2 = await source.resolve("img-abc");
        expect(url2).toBe("blob:mock-uuid-1");
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

        // Release revokes URL
        await source.release("img-abc");
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-uuid-1");

        // Disposal revokes any remaining URLs
        const url3 = await source.resolve("img-abc");
        expect(url3).toBe("blob:mock-uuid-2");
        source.dispose();
        expect(revokedUrls).toContain("blob:mock-uuid-2");
      } finally {
        URL.createObjectURL = origCreate;
        URL.revokeObjectURL = origRevoke;
      }
    });

    it("createAssetSource returns appropriate implementation for launch mode", () => {
      const soloSource = createAssetSource("solo", service);
      expect(soloSource).toBeInstanceOf(BlobShareAssetSource);

      const tabSource = createAssetSource("local-tab", service);
      expect(tabSource).toBeInstanceOf(BlobShareAssetSource);

      const platformSource = createAssetSource("platform", service, "test-ticket");
      expect(platformSource).toBeInstanceOf(BlobShareAssetSource);
    });
  });

  describe("IdbBlobTransport & Content Addressing (09 — Blob Share Spec)", () => {
    let transport: IdbBlobTransport;

    beforeEach(async () => {
      await deleteDatabase(LOCAL_BLOB_DB_NAME);
      transport = new IdbBlobTransport("lobby-1", LOCAL_BLOB_DB_NAME);
    });

    afterEach(async () => {
      transport.close();
      await deleteDatabase(LOCAL_BLOB_DB_NAME);
    });

    it("computes reproducible sha256 hex digests", async () => {
      const blob1 = new Blob(["test-image-content-1"]);
      const blob2 = new Blob(["test-image-content-1"]);
      const blob3 = new Blob(["different-content"]);

      const hash1 = await sha256Hex(blob1);
      const hash2 = await sha256Hex(blob2);
      const hash3 = await sha256Hex(blob3);

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it("puts and checks presence of blobs by hash", async () => {
      const blob = new Blob(["image-bytes"], { type: "image/png" });
      const hash = await sha256Hex(blob);

      expect(await transport.has(hash)).toBe(false);
      await transport.put(hash, blob);
      expect(await transport.has(hash)).toBe(true);
    });

    it("registers handles and resolves them with hashFor", async () => {
      const blob = new Blob(["map-art-bytes"], { type: "image/png" });
      const hash = await sha256Hex(blob);

      await transport.put(hash, blob);
      await transport.register("map-image-1", hash);

      expect(await transport.hashFor("map-image-1")).toBe(hash);
      expect(await transport.hashFor("unknown-image")).toBeNull();
    });

    it("R6: Two logical ids in one lobby sharing the same bytes release independently", async () => {
      const blob = new Blob(["shared-battlemap-bytes"], { type: "image/png" });
      const hash = await sha256Hex(blob);

      await transport.put(hash, blob);
      await transport.register("map-a", hash);
      await transport.register("map-b", hash);

      expect(await transport.has(hash)).toBe(true);

      // Unregister map-b; map-a still references it, so the file survives
      await transport.unregister("map-b");
      expect(await transport.has(hash)).toBe(true);
      expect(await transport.hashFor("map-b")).toBeNull();
      expect(await transport.hashFor("map-a")).toBe(hash);

      // Unregister map-a; refcount drops to 0, so the file is deleted
      await transport.unregister("map-a");
      expect(await transport.has(hash)).toBe(false);
      expect(await transport.hashFor("map-a")).toBeNull();
    });

    it("releases all handles for a lobby and evicts unreferenced content", async () => {
      const blob1 = new Blob(["lobby1-unique"]);
      const blob2 = new Blob(["lobby1-and-2-shared"]);
      const h1 = await sha256Hex(blob1);
      const h2 = await sha256Hex(blob2);

      const t1 = new IdbBlobTransport("lobby-1", LOCAL_BLOB_DB_NAME);
      const t2 = new IdbBlobTransport("lobby-2", LOCAL_BLOB_DB_NAME);

      try {
        await t1.put(h1, blob1);
        await t1.register("img-1", h1);

        await t1.put(h2, blob2);
        await t1.register("img-shared-1", h2);

        await t2.register("img-shared-2", h2);

        expect(await t1.has(h1)).toBe(true);
        expect(await t1.has(h2)).toBe(true);

        // Releasing lobby-1 deletes h1, but h2 is kept because lobby-2 holds img-shared-2
        await t1.releaseLobby("lobby-1");
        expect(await t1.has(h1)).toBe(false);
        expect(await t1.has(h2)).toBe(true);

        // Releasing lobby-2 now drops h2
        await t2.releaseLobby("lobby-2");
        expect(await t2.has(h2)).toBe(false);
      } finally {
        t1.close();
        t2.close();
      }
    });

    it("handles defensive unregister on unknown logical id as a no-op", async () => {
      await expect(transport.unregister("non-existent-image")).resolves.toBeUndefined();
    });

    it("clears all stores on startup sweep", async () => {
      const blob = new Blob(["swept-art"]);
      const hash = await sha256Hex(blob);
      await transport.put(hash, blob);
      await transport.register("img-sweep", hash);

      expect(await transport.has(hash)).toBe(true);
      await transport.clear();

      expect(await transport.has(hash)).toBe(false);
      expect(await transport.hashFor("img-sweep")).toBeNull();
    });
  });

  describe("BlobShareAssetSource", () => {
    let transport: IdbBlobTransport;
    let source: BlobShareAssetSource;

    beforeEach(async () => {
      await deleteDatabase(LOCAL_BLOB_DB_NAME);
      transport = new IdbBlobTransport("lobby-alpha", LOCAL_BLOB_DB_NAME);
      source = new BlobShareAssetSource(transport);
    });

    afterEach(async () => {
      transport.close();
      await deleteDatabase(LOCAL_BLOB_DB_NAME);
    });

    it("publish hashes, uploads, and registers", async () => {
      const blob = new Blob(["art-bytes-xyz"], { type: "image/png" });
      const hash = await sha256Hex(blob);

      expect(await transport.has(hash)).toBe(false);
      await source.publish("img-101", blob);

      expect(await transport.has(hash)).toBe(true);
      expect(await transport.hashFor("img-101")).toBe(hash);
    });

    it("deduplicates: second publish of identical blob skips upload", async () => {
      const blob = new Blob(["identical-map-art"], { type: "image/png" });
      const putSpy = vi.spyOn(transport, "put");

      await source.publish("map-1", blob);
      expect(putSpy).toHaveBeenCalledTimes(1);

      // Second publish with different logicalId but identical bytes
      await source.publish("map-2", blob);
      expect(putSpy).toHaveBeenCalledTimes(1); // Not called again!

      expect(await source.resolve("map-1")).not.toBeNull();
      expect(await source.resolve("map-2")).not.toBeNull();
    });

    it("resolve returns null when handle is not published (exercising placeholder path)", async () => {
      expect(await source.resolve("unpublished-img")).toBeNull();
    });

    it("release unregisters handle", async () => {
      const blob = new Blob(["temp-art"]);
      await source.publish("temp-img", blob);
      expect(await source.resolve("temp-img")).not.toBeNull();

      await source.release("temp-img");
      expect(await source.resolve("temp-img")).toBeNull();
    });
  });

  describe("Phaser Texture Loading & Lifecycle (Wiring into Phaser)", () => {
    interface MockScene {
      textures: {
        exists: (key: string) => boolean;
        remove: (key: string) => boolean;
        _add: (key: string) => void;
      };
      load: {
        isLoading: () => boolean;
        start: () => void;
        image: (key: string, url: string) => void;
        on: (evt: string, fn: (...args: unknown[]) => void) => void;
        off: (evt: string, fn: (...args: unknown[]) => void) => void;
        emit: (evt: string, ...args: unknown[]) => void;
      };
    }

    let mockScene: MockScene;

    beforeEach(() => {
      const texturesMap = new Map<string, unknown>();
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

      mockScene = {
        textures: {
          exists: vi.fn((key: string) => texturesMap.has(key)),
          remove: vi.fn((key: string) => {
            texturesMap.delete(key);
            return true;
          }),
          _add: (key: string) => texturesMap.set(key, {}),
        },
        load: {
          isLoading: vi.fn(() => false),
          start: vi.fn(() => {}),
          image: vi.fn((_key: string, _url: string) => {}),
          on: vi.fn((evt: string, fn: (...args: unknown[]) => void) => {
            if (!listeners.has(evt)) listeners.set(evt, []);
            listeners.get(evt)!.push(fn);
          }),
          off: vi.fn((evt: string, fn: (...args: unknown[]) => void) => {
            const arr = listeners.get(evt);
            if (arr) {
              const idx = arr.indexOf(fn);
              if (idx >= 0) arr.splice(idx, 1);
            }
          }),
          emit: (evt: string, ...args: unknown[]) => {
            const arr = listeners.get(evt);
            if (arr) {
              for (const fn of [...arr]) fn(...args);
            }
          },
        },
      };
    });

    it("returns false and triggers placeholder when assetSource resolves null", async () => {
      const image: MapImage = {
        id: "img-null",
        name: "Test",
        contentType: "image/png",
        shareToken: null,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        originalWidth: 500,
        originalHeight: 500,
        rotation: 0,
        opacity: 1,
        layerOrder: 0,
        locked: false,
        hidden: false,
        byteSize: 100,
        wasDownscaled: false,
        originalLongEdgePx: 500,
        displayLongEdgePx: 500,
      };

      const nullSource = new NullAssetSource();
      const loaded = await ensureTexture(mockScene as unknown as Phaser.Scene, image, nullSource);
      expect(loaded).toBe(false);
    });

    it("loads texture, cleans up listener pair, and revokes blob: URL upon completion", async () => {
      const origRevoke = URL.revokeObjectURL;
      const revoked: string[] = [];
      URL.revokeObjectURL = vi.fn((u) => revoked.push(u));

      try {
        const image: MapImage = {
          id: "img-ok",
          name: "Test",
          contentType: "image/png",
          shareToken: null,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          originalWidth: 500,
          originalHeight: 500,
          rotation: 0,
          opacity: 1,
          layerOrder: 0,
          locked: false,
          hidden: false,
          byteSize: 100,
          wasDownscaled: false,
          originalLongEdgePx: 500,
          displayLongEdgePx: 500,
        };

        const mockSource: AssetSource = {
          resolve: vi.fn().mockResolvedValue("blob:http://localhost/uuid-1234"),
          publish: vi.fn(),
          release: vi.fn(),
          getUrl: vi.fn(),
          has: vi.fn(),
        };

        const promise = ensureTexture(mockScene as unknown as Phaser.Scene, image, mockSource);
        await new Promise((r) => setTimeout(r, 10));

        expect(mockScene.load.image).toHaveBeenCalledWith(
          "img-ok",
          "blob:http://localhost/uuid-1234",
        );
        expect(mockScene.load.start).toHaveBeenCalled();

        // Simulate filecomplete event
        mockScene.load.emit("filecomplete-image-img-ok");

        const ok = await promise;
        expect(ok).toBe(true);

        // Verify blob: URL was revoked to prevent memory leak
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/uuid-1234");
        // Verify listeners were removed
        expect(mockScene.load.off).toHaveBeenCalledWith(
          "filecomplete-image-img-ok",
          expect.any(Function),
        );
        expect(mockScene.load.off).toHaveBeenCalledWith("loaderror", expect.any(Function));
      } finally {
        URL.revokeObjectURL = origRevoke;
      }
    });

    it("scopes loaderror to matching file key and does not fail on other files", async () => {
      const image: MapImage = {
        id: "img-target",
        name: "Target",
        contentType: "image/png",
        shareToken: null,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        originalWidth: 500,
        originalHeight: 500,
        rotation: 0,
        opacity: 1,
        layerOrder: 0,
        locked: false,
        hidden: false,
        byteSize: 100,
        wasDownscaled: false,
        originalLongEdgePx: 500,
        displayLongEdgePx: 500,
      };

      const mockSource: AssetSource = {
        resolve: vi.fn().mockResolvedValue("http://example.com/target.png"),
        publish: vi.fn(),
        release: vi.fn(),
        getUrl: vi.fn(),
        has: vi.fn(),
      };

      const promise = ensureTexture(mockScene as unknown as Phaser.Scene, image, mockSource);
      await new Promise((r) => setTimeout(r, 10));

      // Emit loaderror for a different file
      mockScene.load.emit("loaderror", { key: "other-file-key" });

      // Target file should still complete
      mockScene.load.emit("filecomplete-image-img-target");

      const ok = await promise;
      expect(ok).toBe(true);
    });
  });

  describe("Image Downscaling & Caps Validation", () => {
    it("returns original blob when dimensions are within limit", async () => {
      const testBlob = new Blob(["mock-image-data"], { type: "image/png" });
      const result = await decodeAndMaybeDownscale(testBlob, 8192);
      expect(result.blob).toBe(testBlob);
      expect(result.wasDownscaled).toBe(false);
    });

    it("enforces 100 MB per-file and 1 GB room caps constants", () => {
      expect(MAX_FILE_SIZE_BYTES).toBe(100 * 1024 * 1024);
      expect(MAX_ROOM_STORAGE_BYTES).toBe(1024 * 1024 * 1024);
    });
  });
});
