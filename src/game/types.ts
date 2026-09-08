/*
 * The WIRE CONTRACT. Every value here crosses the boundary between the authority
 * module (which the KnockBox server runs, sandboxed) and the clients that render
 * it, so every value must be STRICT JSON:
 *
 *   - no `undefined` — use `null` (an optional property that is sometimes absent
 *     serializes to nothing and reads back as `undefined`, which the local
 *     emulator's fidelity check rejects outright)
 *   - no Date / Map / Set / class instances / functions / cycles
 *
 * Nothing here imports Phaser, Lit, or the DOM: `src/game/` is shared by the
 * authority module and the client, and the authority runs in a bare sandbox.
 */

import type {
  CampaignHeader,
  CenterViewportRequest,
  DndMapperPhase,
  DndMapperSettings,
  DndMapperState,
  FocusRect,
  GameMap,
  GridConfig,
  MapImage,
  MapSummary,
  NewMapImage,
  NewToken,
  Token,
} from "./domain.js";

/** A lobby member, as the platform reports it (`init`, `onPlayerJoined`). */
export interface PlayerInfo {
  readonly id: string;
  readonly displayName: string;
}

/**
 * The authoritative match state replicated across clients.
 * In DndMapper, this is the top-level DndMapperState.
 */
export type MatchState = DndMapperState;

/**
 * Client → authority intents.
 * Untrusted data received by authority via `applyIntent`.
 */
export type Intent =
  // maps
  | { readonly kind: "createMap"; readonly name: string }
  | { readonly kind: "renameMap"; readonly mapId: string; readonly name: string }
  | { readonly kind: "deleteMap"; readonly mapId: string }
  | { readonly kind: "duplicateMap"; readonly mapId: string }
  | { readonly kind: "reorderMaps"; readonly order: readonly string[] }
  | { readonly kind: "setActiveMap"; readonly mapId: string }
  | { readonly kind: "updateGrid"; readonly mapId: string; readonly grid: GridConfig }
  // tokens
  | { readonly kind: "spawnToken"; readonly mapId: string; readonly token: NewToken }
  | { readonly kind: "moveToken"; readonly tokenId: string; readonly x: number; readonly y: number }
  | { readonly kind: "updateToken"; readonly tokenId: string; readonly patch: Partial<Token> }
  | { readonly kind: "removeToken"; readonly tokenId: string }
  | { readonly kind: "setTokenHidden"; readonly tokenId: string; readonly hidden: boolean }
  // images
  | { readonly kind: "addImage"; readonly mapId: string; readonly image: NewMapImage }
  | {
      readonly kind: "transformImage";
      readonly imageId: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rotation: number;
    }
  | { readonly kind: "reorderImage"; readonly imageId: string; readonly layerOrder: number }
  | { readonly kind: "setImageLocked"; readonly imageId: string; readonly locked: boolean }
  | { readonly kind: "setImageHidden"; readonly imageId: string; readonly hidden: boolean }
  | { readonly kind: "removeImage"; readonly imageId: string }
  // fog — ONE intent per stroke, never per cell
  | {
      readonly kind: "paintFog";
      readonly mapId: string;
      readonly cells: readonly number[];
      readonly fogged: boolean;
    }
  | { readonly kind: "fillFog"; readonly mapId: string }
  | { readonly kind: "clearFog"; readonly mapId: string }
  // viewport
  | { readonly kind: "setFocusRect"; readonly rect: FocusRect | null }
  | {
      readonly kind: "centerViewport";
      readonly mapId: string;
      readonly x: number;
      readonly y: number;
    }
  // session
  | { readonly kind: "updateSettings"; readonly patch: Partial<DndMapperSettings> }
  // campaign loading
  | { readonly kind: "requestMap"; readonly mapId: string }
  | {
      readonly kind: "beginImport";
      readonly campaign: CampaignHeader;
      readonly chunkCount: number;
      readonly token?: string;
    }
  | {
      readonly kind: "importChunk";
      readonly token: string;
      readonly index: number;
      readonly maps: readonly GameMap[];
    }
  | { readonly kind: "commitImport"; readonly token: string }
  | { readonly kind: "startSession" };

/**
 * Authority → clients narrowed patches.
 * Carrying absolute values (never relative deltas) to ensure safe idempotence.
 */
export type Patch =
  | { readonly kind: "full"; readonly state: DndMapperState } // sync / join / reconnect only
  | { readonly kind: "token"; readonly token: Token } // absolute position, not a delta
  | { readonly kind: "tokenRemoved"; readonly tokenId: string }
  | { readonly kind: "fog"; readonly mapId: string; readonly mask: string } // whole mask for ONE map
  | { readonly kind: "image"; readonly image: MapImage }
  | { readonly kind: "imageRemoved"; readonly imageId: string }
  | { readonly kind: "grid"; readonly mapId: string; readonly grid: GridConfig }
  | { readonly kind: "activeMap"; readonly mapId: string }
  | { readonly kind: "focusRect"; readonly rect: FocusRect | null }
  | { readonly kind: "centerViewport"; readonly request: CenterViewportRequest }
  | { readonly kind: "settings"; readonly settings: DndMapperSettings }
  | { readonly kind: "mapList"; readonly maps: readonly MapSummary[] } // metadata only, no tokens/images
  | { readonly kind: "map"; readonly map: GameMap } // ONE map in full
  | { readonly kind: "dm"; readonly dmPlayerId: string } // succession
  | { readonly kind: "phase"; readonly phase: DndMapperPhase };

/** Import chunk budget for campaign streaming (~39% of 512 KiB cap). */
export const CHUNK_BUDGET = 200_000;

/** Max broadcast frame byte limit guard (~78% of 512 KiB cap). */
export const MAX_FRAME_BYTES = 400_000;

// Re-export full domain models and helpers
export * from "./domain.js";
export * from "./fog.js";
export * from "./snapping.js";
export * from "./stacking.js";
export * from "./dice.js";
export * from "./color.js";
export * from "./visibility.js";
export * from "./ruler.js";
