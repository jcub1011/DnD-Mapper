/*
 * Pure map & image domain helpers.
 *
 * Runs in the sandbox (no DOM, no Date, no Node).
 */

import type { GameMap, GridConfig, MapImage, NewMapImage } from "./domain.js";
import { createDefaultGridConfig } from "./domain.js";

/**
 * Standard RFC 4122 v4 UUID generator using Math.random().
 * Completely independent of Web Crypto / DOM / Node APIs for sandbox compatibility.
 */
export function generateGuid(): string {
  let d = "";
  for (let i = 0; i < 32; i++) {
    const r = (Math.random() * 16) | 0;
    if (i === 8 || i === 12 || i === 16 || i === 20) {
      d += "-";
    }
    d += (i === 12 ? 4 : i === 16 ? (r & 0x3) | 0x8 : r).toString(16);
  }
  return d;
}

/**
 * Pure arithmetic conversion from milliseconds timestamp to ISO 8601 UTC string.
 * Sandbox safe (the sandbox actively deletes the `Date` global).
 */
export function timestampToIsoUtc(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const millis = Math.floor(ms % 1000);
  const days = Math.floor(totalSeconds / 86400);
  let remSeconds = totalSeconds % 86400;
  if (remSeconds < 0) {
    remSeconds += 86400;
  }
  const hours = Math.floor(remSeconds / 3600);
  remSeconds %= 3600;
  const minutes = Math.floor(remSeconds / 60);
  const seconds = remSeconds % 60;

  // Howard Hinnant's algorithm (civil days since 1970-01-01)
  const z = days + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const year = y + (m <= 2 ? 1 : 0);

  const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const pad3 = (n: number) => (n < 10 ? `00${n}` : n < 100 ? `0${n}` : `${n}`);
  const pad4 = (n: number) => {
    const s = `${n}`;
    return "0000".slice(s.length) + s;
  };

  return `${pad4(year)}-${pad2(m)}-${pad2(d)}T${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${pad3(millis)}Z`;
}

/** Creates a fresh map with default grid, empty tokens, images, and empty (revealed) fog mask. */
export function createNewMap(name: string, now: number, listOrder = 0, id?: string): GameMap {
  return {
    id: id ?? generateGuid(),
    name: name.trim() || "Untitled Map",
    grid: createDefaultGridConfig(),
    images: [],
    tokens: [],
    createdUtc: timestampToIsoUtc(now),
    listOrder,
    defaultSpawnPosition: null,
    markupSvg: null,
    fogMask: "", // empty means all revealed
  };
}

/** Updates a map's name. */
export function renameMap(
  maps: readonly GameMap[],
  mapId: string,
  name: string,
): readonly GameMap[] {
  const trimmed = name.trim();
  if (!trimmed) return maps;
  return maps.map((m) => (m.id === mapId ? { ...m, name: trimmed } : m));
}

/** Deletes a map by id and compacts listOrder. */
export function deleteMap(maps: readonly GameMap[], mapId: string): readonly GameMap[] {
  const remaining = maps.filter((m) => m.id !== mapId);
  return remaining.map((m, idx) => ({ ...m, listOrder: idx }));
}

/** Duplicates a map including its tokens and images with new IDs. */
export function duplicateMap(
  maps: readonly GameMap[],
  mapId: string,
  now: number,
  newMapId?: string,
): { maps: readonly GameMap[]; duplicated: GameMap | null } {
  const source = maps.find((m) => m.id === mapId);
  if (!source) return { maps, duplicated: null };

  const id = newMapId ?? generateGuid();
  const duplicated: GameMap = {
    ...source,
    id,
    name: `${source.name} (Copy)`,
    createdUtc: timestampToIsoUtc(now),
    listOrder: maps.length,
    tokens: source.tokens.map((t) => ({ ...t, id: generateGuid(), mapId: id })),
    images: source.images.map((img) => ({ ...img, id: generateGuid() })),
  };

  return {
    maps: [...maps, duplicated],
    duplicated,
  };
}

/** Reorders maps according to the provided array of map IDs. */
export function reorderMaps(
  maps: readonly GameMap[],
  order: readonly string[],
): readonly GameMap[] {
  const mapById = new Map<string, GameMap>();
  for (const m of maps) {
    mapById.set(m.id, m);
  }

  const result: GameMap[] = [];
  for (let i = 0; i < order.length; i++) {
    const m = mapById.get(order[i]);
    if (m) {
      result.push({ ...m, listOrder: i });
      mapById.delete(order[i]);
    }
  }

  // Append any maps omitted from the order array
  for (const remaining of mapById.values()) {
    result.push({ ...remaining, listOrder: result.length });
  }

  return result;
}

/** Updates a map's grid configuration. */
export function updateMapGrid(
  maps: readonly GameMap[],
  mapId: string,
  grid: GridConfig,
): readonly GameMap[] {
  return maps.map((m) => (m.id === mapId ? { ...m, grid } : m));
}

/** Adds an image to a map. */
export function addImageToMap(
  maps: readonly GameMap[],
  mapId: string,
  newImage: NewMapImage,
  imageId?: string,
): { maps: readonly GameMap[]; image: MapImage | null } {
  let createdImage: MapImage | null = null;
  const updatedMaps = maps.map((m) => {
    if (m.id !== mapId) return m;
    const maxLayer = m.images.reduce((acc, img) => Math.max(acc, img.layerOrder), -1);
    createdImage = {
      ...newImage,
      id: imageId ?? generateGuid(),
      shareToken: null,
      layerOrder: maxLayer + 1,
    };
    return {
      ...m,
      images: [...m.images, createdImage],
    };
  });

  return { maps: updatedMaps, image: createdImage };
}

/** Transforms an image's position, dimensions, or rotation. */
export function transformMapImage(
  maps: readonly GameMap[],
  imageId: string,
  transform: { x: number; y: number; width: number; height: number; rotation: number },
): { maps: readonly GameMap[]; image: MapImage | null } {
  let updatedImage: MapImage | null = null;
  const updatedMaps = maps.map((m) => {
    const imgIndex = m.images.findIndex((img) => img.id === imageId);
    if (imgIndex === -1) return m;
    const existing = m.images[imgIndex];
    updatedImage = {
      ...existing,
      x: transform.x,
      y: transform.y,
      width: Math.max(0.1, transform.width),
      height: Math.max(0.1, transform.height),
      rotation: transform.rotation,
    };
    const nextImages = [...m.images];
    nextImages[imgIndex] = updatedImage;
    return { ...m, images: nextImages };
  });

  return { maps: updatedMaps, image: updatedImage };
}

/** Reorders an image layerOrder within its map. */
export function reorderMapImage(
  maps: readonly GameMap[],
  imageId: string,
  layerOrder: number,
): { maps: readonly GameMap[]; image: MapImage | null } {
  let updatedImage: MapImage | null = null;
  const updatedMaps = maps.map((m) => {
    const imgIndex = m.images.findIndex((img) => img.id === imageId);
    if (imgIndex === -1) return m;
    updatedImage = { ...m.images[imgIndex], layerOrder };
    const nextImages = [...m.images];
    nextImages[imgIndex] = updatedImage;
    return { ...m, images: nextImages };
  });
  return { maps: updatedMaps, image: updatedImage };
}

/** Sets locked status on an image. */
export function setMapImageLocked(
  maps: readonly GameMap[],
  imageId: string,
  locked: boolean,
): { maps: readonly GameMap[]; image: MapImage | null } {
  let updatedImage: MapImage | null = null;
  const updatedMaps = maps.map((m) => {
    const imgIndex = m.images.findIndex((img) => img.id === imageId);
    if (imgIndex === -1) return m;
    updatedImage = { ...m.images[imgIndex], locked };
    const nextImages = [...m.images];
    nextImages[imgIndex] = updatedImage;
    return { ...m, images: nextImages };
  });
  return { maps: updatedMaps, image: updatedImage };
}

/** Sets hidden status on an image. */
export function setMapImageHidden(
  maps: readonly GameMap[],
  imageId: string,
  hidden: boolean,
): { maps: readonly GameMap[]; image: MapImage | null } {
  let updatedImage: MapImage | null = null;
  const updatedMaps = maps.map((m) => {
    const imgIndex = m.images.findIndex((img) => img.id === imageId);
    if (imgIndex === -1) return m;
    updatedImage = { ...m.images[imgIndex], hidden };
    const nextImages = [...m.images];
    nextImages[imgIndex] = updatedImage;
    return { ...m, images: nextImages };
  });
  return { maps: updatedMaps, image: updatedImage };
}

/** Removes an image from a map. */
export function removeMapImage(
  maps: readonly GameMap[],
  imageId: string,
): { maps: readonly GameMap[]; removed: boolean } {
  let removed = false;
  const updatedMaps = maps.map((m) => {
    const filtered = m.images.filter((img) => img.id !== imageId);
    if (filtered.length !== m.images.length) {
      removed = true;
      return { ...m, images: filtered };
    }
    return m;
  });
  return { maps: updatedMaps, removed };
}
