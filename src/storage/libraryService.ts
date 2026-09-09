/**
 * LibraryService orchestrates IndexedDB persistence for DnD Mapper.
 *
 * Enforces:
 *   1. 500 ms debounce after the last persisted change.
 *   2. 9-reference identity fingerprint check short-circuiting non-persisted changes.
 *   3. Per-shard SHA-256 hashing - only writes shards whose content changed.
 *   4. Core spine written LAST for crash recovery.
 *   5. Stale shard deletion for removed maps and sheets.
 *   6. Serialized flush execution via promise-chain lock with pendingDirty re-arm.
 *   7. Auto-save (__auto__) protection: cannot be renamed or deleted.
 */

import type {
  CharacterSheet,
  CustomTemplate,
  DndMapperSettings,
  DndMapperState,
  GameMap,
  LoadedDiceRule,
  MapSummary,
  NamedTemplate,
  RollTemplate,
} from "../game/domain.js";
import type { AttributeSchema } from "../game/domain.js";
import {
  deleteBatch,
  deleteFromStore,
  getAllKeysFromStore,
  getFromStore,
  openDatabase,
  putBatch,
  putToStore,
} from "./db.js";
import {
  AUTO_SLOT_ID,
  AUTO_SLOT_NAME,
  coreKey,
  mapKey,
  sheetKey,
  SLOTS_INDEX_KEY,
  STORE_IMAGES,
  STORE_LIBRARY,
  STORE_SLOTS_INDEX,
} from "./schema.js";
import type { LibraryCoreSnapshot, SlotIndexEntry, SlotInfo, SlotsIndex } from "./schema.js";
import type { UnpackResult } from "../vtf/types.js";

const SAVE_DEBOUNCE_MS = 500;

export interface PersistedFingerprint {
  readonly maps: readonly (GameMap | MapSummary)[];
  readonly sheets: Readonly<Record<string, CharacterSheet>>;
  readonly customTemplates: Readonly<Record<string, NamedTemplate | CustomTemplate>>;
  readonly globalRollTemplates: readonly RollTemplate[];
  readonly settings: DndMapperSettings;
  readonly attributeSchema: AttributeSchema;
  readonly activeSchemaTemplateId: string | null;
  readonly initiativeAttributeName: string | null;
  readonly loadedDiceRules: readonly LoadedDiceRule[];
}

export function captureFingerprint(state: DndMapperState): PersistedFingerprint {
  return {
    maps: state.maps,
    sheets: state.sheets,
    customTemplates: state.customTemplates,
    globalRollTemplates: state.globalRollTemplates,
    settings: state.settings,
    attributeSchema: state.attributeSchema,
    activeSchemaTemplateId: state.activeSchemaTemplateId,
    initiativeAttributeName: state.initiativeAttributeName,
    loadedDiceRules: state.loadedDiceRules,
  };
}

export function isFingerprintEqual(
  a: PersistedFingerprint | null,
  b: PersistedFingerprint | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;

  return (
    a.maps === b.maps &&
    a.sheets === b.sheets &&
    a.customTemplates === b.customTemplates &&
    a.globalRollTemplates === b.globalRollTemplates &&
    a.settings === b.settings &&
    a.attributeSchema === b.attributeSchema &&
    a.activeSchemaTemplateId === b.activeSchemaTemplateId &&
    a.initiativeAttributeName === b.initiativeAttributeName &&
    a.loadedDiceRules === b.loadedDiceRules
  );
}

export async function hashShard(data: unknown): Promise<string> {
  const json = JSON.stringify(data);
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const msgBuffer = new TextEncoder().encode(json);
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let hash = 0;
  for (let i = 0; i < json.length; i++) {
    const char = json.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(16);
}

export class LibraryService {
  private db: IDBDatabase | null = null;
  private isDbOwned = false;

  private _isSaving = false;
  private pendingDirty = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushedFingerprint: PersistedFingerprint | null = null;

  // Key -> SHA-256 hash of last written JSON for AUTO_SLOT_ID
  private readonly autoFlushHashes = new Map<string, string>();

  // Mutex lock promise chain
  private saveLock: Promise<void> = Promise.resolve();

  // Cached reference to live state for debounced save
  private liveState: DndMapperState | null = null;

  public onSavingChanged: ((isSaving: boolean) => void) | null = null;
  public onSlotsChanged: (() => void) | null = null;

  constructor(private readonly saveDebounceMs = SAVE_DEBOUNCE_MS) {}

  public get isSaving(): boolean {
    return this._isSaving;
  }

  private setSaving(v: boolean): void {
    if (this._isSaving === v) return;
    this._isSaving = v;
    try {
      this.onSavingChanged?.(v);
    } catch {
      // Subscriber error shouldn't crash storage
    }
  }

  private notifySlotsChanged(): void {
    try {
      this.onSlotsChanged?.();
    } catch {
      // Subscriber error shouldn't crash storage
    }
  }

  private attachPromise: Promise<void> | null = null;

  public async attach(existingDb?: IDBDatabase): Promise<void> {
    if (this.db) {
      if (!existingDb || this.db === existingDb) return;
      if (this.isDbOwned) {
        try {
          this.db.close();
        } catch {
          // Ignore close errors
        }
      }
      this.db = null;
    }

    if (this.attachPromise) {
      await this.attachPromise;
      if (this.db) return;
    }

    this.attachPromise = (async () => {
      if (existingDb) {
        this.db = existingDb;
        this.isDbOwned = false;
      } else {
        this.db = await openDatabase();
        this.isDbOwned = true;
      }

      await this.ensureSlotsIndex();
      this.notifySlotsChanged();
    })();

    try {
      await this.attachPromise;
    } finally {
      this.attachPromise = null;
    }
  }

  public async detach(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Await any in-flight flush
    await this.saveLock;

    if (this.isDbOwned && this.db) {
      try {
        this.db.close();
      } catch {
        // Ignore close errors
      }
    }

    this.db = null;
    this.liveState = null;
    this.lastFlushedFingerprint = null;
    this.autoFlushHashes.clear();
    this.setSaving(false);
  }

  private async ensureDb(): Promise<IDBDatabase> {
    if (!this.db) {
      await this.attach();
    }
    if (!this.db) {
      throw new Error("LibraryService failed to open IndexedDB.");
    }
    return this.db;
  }

  private async ensureSlotsIndex(): Promise<SlotsIndex> {
    const db = this.db ?? (await this.ensureDb());
    const existing = await getFromStore<SlotsIndex>(db, STORE_SLOTS_INDEX, SLOTS_INDEX_KEY);
    if (existing && Array.isArray(existing.slots)) {
      return existing;
    }

    const initial: SlotsIndex = {
      slots: [
        {
          id: AUTO_SLOT_ID,
          name: AUTO_SLOT_NAME,
          kind: "Auto",
          updatedUtc: new Date().toISOString(),
        },
      ],
    };
    await putToStore(db, STORE_SLOTS_INDEX, SLOTS_INDEX_KEY, initial);
    return initial;
  }

  /**
   * Called whenever state changes.
   * Performs identity fingerprint check; if persisted fields haven't changed, returns immediately.
   */
  public onStateChanged(state: DndMapperState): void {
    this.liveState = state;
    const currentFingerprint = captureFingerprint(state);

    if (isFingerprintEqual(currentFingerprint, this.lastFlushedFingerprint)) {
      return;
    }

    this.pendingDirty = true;
    this.setSaving(true);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.liveState) {
        void this.flushAutoSave(this.liveState);
      }
    }, this.saveDebounceMs);
  }

  /**
   * Immediately flushes pending auto-save state.
   */
  public async flushAutoSave(state: DndMapperState): Promise<void> {
    // Chain onto saveLock to serialize flushes
    this.saveLock = this.saveLock.then(() => this.executeFlush(state)).catch(() => {});
    await this.saveLock;
  }

  private async executeFlush(state: DndMapperState): Promise<void> {
    if (!this.db) return;

    this.pendingDirty = false;
    const currentFingerprint = captureFingerprint(state);

    try {
      await this.saveSlotInternal(AUTO_SLOT_ID, AUTO_SLOT_NAME, state, true);
      this.lastFlushedFingerprint = currentFingerprint;
    } finally {
      if (this.pendingDirty) {
        // Edits arrived mid-flush: re-arm debounce
        this.setSaving(true);
        if (!this.debounceTimer && this.liveState) {
          this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            if (this.liveState) {
              void this.flushAutoSave(this.liveState);
            }
          }, this.saveDebounceMs);
        }
      } else {
        this.setSaving(false);
      }
    }
  }

  private async saveSlotInternal(
    slotId: string,
    slotName: string,
    state: DndMapperState,
    isAutoSave: boolean,
  ): Promise<void> {
    const db = await this.ensureDb();

    const core: LibraryCoreSnapshot = {
      schemaVersion: 1,
      settings: state.settings,
      attributeSchema: state.attributeSchema,
      activeSchemaTemplateId: state.activeSchemaTemplateId,
      initiativeAttributeName: state.initiativeAttributeName,
      customTemplates: Object.values(state.customTemplates),
      globalRollTemplates: state.globalRollTemplates,
      loadedDiceRules: state.loadedDiceRules,
      mapIds: state.maps.map((m) => m.id),
      sheetIds: Object.keys(state.sheets),
    };

    const batchItems: Array<{ key: string; value: unknown }> = [];
    const newHashes = new Map<string, string>();

    // 1. Map shards
    const currentMapKeys = new Set<string>();
    for (const map of state.maps) {
      const k = mapKey(slotId, map.id);
      currentMapKeys.add(k);
      const hash = await hashShard(map);

      if (isAutoSave && this.autoFlushHashes.get(k) === hash) {
        continue;
      }

      batchItems.push({ key: k, value: map });
      newHashes.set(k, hash);
    }

    // 2. Sheet shards
    const currentSheetKeys = new Set<string>();
    for (const sheet of Object.values(state.sheets)) {
      const k = sheetKey(slotId, sheet.id);
      currentSheetKeys.add(k);
      const hash = await hashShard(sheet);

      if (isAutoSave && this.autoFlushHashes.get(k) === hash) {
        continue;
      }

      batchItems.push({ key: k, value: sheet });
      newHashes.set(k, hash);
    }

    // 3. Core shard (written LAST)
    const cKey = coreKey(slotId);
    const coreH = await hashShard(core);
    if (!isAutoSave || this.autoFlushHashes.get(cKey) !== coreH) {
      batchItems.push({ key: cKey, value: core });
      newHashes.set(cKey, coreH);
    }

    // Execute batch put if there are dirty shards
    if (batchItems.length > 0) {
      await putBatch(db, STORE_LIBRARY, batchItems);

      if (isAutoSave) {
        for (const [k, h] of newHashes) {
          this.autoFlushHashes.set(k, h);
        }
      }
    }

    // 4. Stale shard deletion for auto save
    if (isAutoSave) {
      const staleKeys: string[] = [];
      const mapPrefix = `${slotId}:map:`;
      const sheetPrefix = `${slotId}:sheet:`;

      for (const k of this.autoFlushHashes.keys()) {
        if (k.startsWith(mapPrefix) && !currentMapKeys.has(k)) {
          staleKeys.push(k);
        } else if (k.startsWith(sheetPrefix) && !currentSheetKeys.has(k)) {
          staleKeys.push(k);
        }
      }

      if (staleKeys.length > 0) {
        await deleteBatch(db, STORE_LIBRARY, staleKeys);
        for (const k of staleKeys) {
          this.autoFlushHashes.delete(k);
        }
      }
    }

    // 5. Update slot index
    await this.touchSlotIndex(slotId, slotName, isAutoSave ? "Auto" : "Manual");
  }

  private async touchSlotIndex(
    slotId: string,
    name: string,
    kind: "Auto" | "Manual",
  ): Promise<void> {
    const db = await this.ensureDb();
    const index = await this.ensureSlotsIndex();
    const now = new Date().toISOString();

    const existingIndex = index.slots.findIndex((s) => s.id === slotId);
    const updatedEntry: SlotIndexEntry = {
      id: slotId,
      name,
      kind,
      updatedUtc: now,
    };

    let newSlots: SlotIndexEntry[];
    if (existingIndex >= 0) {
      newSlots = [...index.slots];
      newSlots[existingIndex] = updatedEntry;
    } else {
      newSlots = [...index.slots, updatedEntry];
    }

    await putToStore(db, STORE_SLOTS_INDEX, SLOTS_INDEX_KEY, { slots: newSlots });
    this.notifySlotsChanged();
  }

  // ── Slot CRUD Operations ──────────────────────────────────────────────────

  public async listSlots(): Promise<SlotInfo[]> {
    const index = await this.ensureSlotsIndex();
    return index.slots.map((s) => ({ ...s }));
  }

  public async saveSlot(slotId: string, name: string, state: DndMapperState): Promise<void> {
    if (!slotId || slotId === AUTO_SLOT_ID) {
      throw new Error(`Cannot manually save into '${AUTO_SLOT_ID}'.`);
    }

    await this.saveLock;
    this.setSaving(true);
    try {
      await this.saveSlotInternal(slotId, name, state, false);
    } finally {
      this.setSaving(false);
    }
  }

  public async loadSlot(slotId: string): Promise<DndMapperState | null> {
    const db = await this.ensureDb();
    const cKey = coreKey(slotId);
    const core = await getFromStore<LibraryCoreSnapshot>(db, STORE_LIBRARY, cKey);
    if (!core) return null;

    // Read maps and sheets in parallel
    const mapPromises = (core.mapIds || []).map((mid) =>
      getFromStore<GameMap>(db, STORE_LIBRARY, mapKey(slotId, mid)),
    );
    const sheetPromises = (core.sheetIds || []).map((sid) =>
      getFromStore<CharacterSheet>(db, STORE_LIBRARY, sheetKey(slotId, sid)),
    );

    const [mapResults, sheetResults] = await Promise.all([
      Promise.all(mapPromises),
      Promise.all(sheetPromises),
    ]);

    const maps: GameMap[] = mapResults.filter((m): m is GameMap => m !== null);
    const sheetsRecord: Record<string, CharacterSheet> = {};
    for (const s of sheetResults) {
      if (s) sheetsRecord[s.id] = s;
    }

    const templatesRecord: Record<string, NamedTemplate | CustomTemplate> = {};
    for (const t of core.customTemplates || []) {
      templatesRecord[t.id] = t;
    }

    // If loading the auto-save slot, seed the hash cache
    if (slotId === AUTO_SLOT_ID) {
      this.autoFlushHashes.clear();
      const coreH = await hashShard(core);
      this.autoFlushHashes.set(cKey, coreH);
      for (const m of maps) {
        const h = await hashShard(m);
        this.autoFlushHashes.set(mapKey(slotId, m.id), h);
      }
      for (const s of Object.values(sheetsRecord)) {
        const h = await hashShard(s);
        this.autoFlushHashes.set(sheetKey(slotId, s.id), h);
      }
    }

    const state: DndMapperState = {
      phase: "Lobby",
      settings: core.settings,
      attributeSchema: core.attributeSchema,
      maps,
      activeMapId: maps.length > 0 ? maps[0].id : null,
      sheets: sheetsRecord,
      customTemplates: templatesRecord,
      statusEffectTemplates: {},
      rollLog: [],
      globalRollTemplates: core.globalRollTemplates || [],
      activeSchemaTemplateId: core.activeSchemaTemplateId || null,
      initiativeAttributeName: core.initiativeAttributeName || null,
      activeCombat: null,
      pendingCenterRequest: null,
      focusRect: null,
      loadedDiceRules: core.loadedDiceRules || [],
      hostHeldKeys: [],
      dmPlayerId: null,
    };

    if (slotId === AUTO_SLOT_ID) {
      this.lastFlushedFingerprint = captureFingerprint(state);
    }

    return state;
  }

  public async deleteSlot(slotId: string): Promise<boolean> {
    if (slotId === AUTO_SLOT_ID) {
      throw new Error(`Cannot delete the '${AUTO_SLOT_NAME}' slot.`);
    }

    const db = await this.ensureDb();
    const index = await this.ensureSlotsIndex();
    const filtered = index.slots.filter((s) => s.id !== slotId);
    if (filtered.length === index.slots.length) {
      return false; // Slot not found
    }

    // Read core to find all shard keys to delete
    const cKey = coreKey(slotId);
    const core = await getFromStore<LibraryCoreSnapshot>(db, STORE_LIBRARY, cKey);
    const keysToDelete = [cKey];
    if (core) {
      for (const mid of core.mapIds || []) keysToDelete.push(mapKey(slotId, mid));
      for (const sid of core.sheetIds || []) keysToDelete.push(sheetKey(slotId, sid));
    }

    await deleteBatch(db, STORE_LIBRARY, keysToDelete);
    await putToStore(db, STORE_SLOTS_INDEX, SLOTS_INDEX_KEY, { slots: filtered });
    this.notifySlotsChanged();
    return true;
  }

  public async renameSlot(slotId: string, newName: string): Promise<boolean> {
    if (slotId === AUTO_SLOT_ID) {
      throw new Error(`Cannot rename the '${AUTO_SLOT_NAME}' slot.`);
    }

    const db = await this.ensureDb();
    const index = await this.ensureSlotsIndex();
    const slotEntry = index.slots.find((s) => s.id === slotId);
    if (!slotEntry) return false;

    const updatedSlots = index.slots.map((s) =>
      s.id === slotId ? { ...s, name: newName.trim(), updatedUtc: new Date().toISOString() } : s,
    );

    await putToStore(db, STORE_SLOTS_INDEX, SLOTS_INDEX_KEY, { slots: updatedSlots });
    this.notifySlotsChanged();
    return true;
  }

  // ── Image / Blob Operations ───────────────────────────────────────────────

  public async putImage(id: string, blob: Blob): Promise<void> {
    const db = await this.ensureDb();
    await putToStore(db, STORE_IMAGES, id, blob);
  }

  public async getImage(id: string): Promise<Blob | null> {
    const db = await this.ensureDb();
    return getFromStore<Blob>(db, STORE_IMAGES, id);
  }

  public async deleteImage(id: string): Promise<void> {
    const db = await this.ensureDb();
    await deleteFromStore(db, STORE_IMAGES, id);
  }

  public async listImageIds(): Promise<string[]> {
    const db = await this.ensureDb();
    return getAllKeysFromStore(db, STORE_IMAGES);
  }

  public async getBytesUsed(): Promise<number> {
    const db = await this.ensureDb();
    const imageKeys = await getAllKeysFromStore(db, STORE_IMAGES);
    let total = 0;

    for (const key of imageKeys) {
      const blob = await getFromStore<Blob>(db, STORE_IMAGES, key);
      if (blob) {
        total += blob.size;
      }
    }

    return total;
  }

  /**
   * Imports an unpacked VTF archive as a new slot.
   * Persists all extracted images to STORE_IMAGES, then saves the slot shards into STORE_LIBRARY.
   */
  public async importSlot(
    unpackResult: UnpackResult,
    slotId?: string,
    slotName?: string,
  ): Promise<string> {
    const db = await this.ensureDb();

    // 1. Batch store images into STORE_IMAGES
    const imageItems = Array.from(unpackResult.images.values()).map((asset) => ({
      key: asset.id,
      value: asset.blob,
    }));
    if (imageItems.length > 0) {
      await putBatch(db, STORE_IMAGES, imageItems);
    }

    // 2. Save slot shards into STORE_LIBRARY
    const id =
      slotId ||
      (typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `slot-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
    const name = slotName || unpackResult.slotTitle || "Imported slot";

    await this.saveSlot(id, name, unpackResult.state);
    return id;
  }
}
