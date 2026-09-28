/**
 * Projector display popout protocol.
 *
 * The DM's window opens a popup at `?view=display`. The popup boots the same
 * bundle with the Phaser map but no network, controller, or library (see
 * main.ts) and renders a player-safe, chrome-free view of the active map that
 * can be screen-shared (Discord etc.) while the DM keeps full control in their
 * own window.
 *
 * Transport is `postMessage` on the window handles rather than a
 * BroadcastChannel: the DM window runs inside the KnockBox iframe while the
 * popup is top-level, and browsers partition BroadcastChannel by top-level
 * site, so a channel could silently never connect.
 *
 * - popup  -> opener: `display-join` on boot and every heartbeat, saying
 *   whether it holds state yet. The opener pushes a full state to a popup
 *   that has none (the push right after `window.open` lands on its
 *   about:blank document and is lost) and adopts an unknown source, so the
 *   popup reconnects by itself after the DM window reloads.
 * - opener -> popup: `display-state` — the authority's own player projection
 *   (`projectForPlayer(state, null)`), so hidden tokens/images, fogged tokens,
 *   secret rolls and hidden combatants never leave the DM window.
 * - popup  -> opener: `display-asset-request`; opener -> popup: `display-asset`
 *   carrying the image Blob (not a URL — blob: URLs may not resolve across
 *   storage partitions).
 * - popup  -> opener: `display-leave` on beforeunload.
 *
 * Every message carries `channel: DISPLAY_CHANNEL` so unrelated postMessage
 * traffic (e.g. the KnockBox host frame) is ignored.
 */

import type { AssetSource } from "../../assets/assetSource";
import type { DiceColorRosterEntry } from "../../game/color";
import type { MatchState } from "../../game/types";
import { toastService } from "../toast/toastService";

export const DISPLAY_CHANNEL = "dndm-display";

/** Popup heartbeat; also how often the opener checks the popup is still open. */
export const DISPLAY_HEARTBEAT_MS = 2000;

/** How long the popup waits for an image before rendering its placeholder. */
const ASSET_TIMEOUT_MS = 15000;

export interface DisplayJoinMessage {
  channel: typeof DISPLAY_CHANNEL;
  type: "display-join";
  /** False until the popup has received its first `display-state`. */
  hasState: boolean;
}

export interface DisplayLeaveMessage {
  channel: typeof DISPLAY_CHANNEL;
  type: "display-leave";
}

export interface DisplayAssetRequestMessage {
  channel: typeof DISPLAY_CHANNEL;
  type: "display-asset-request";
  imageId: string;
}

export interface DisplayStateMessage {
  channel: typeof DISPLAY_CHANNEL;
  type: "display-state";
  /** Player projection of the match — never the DM's full state. */
  state: MatchState;
  roster: readonly DiceColorRosterEntry[];
}

export interface DisplayAssetMessage {
  channel: typeof DISPLAY_CHANNEL;
  type: "display-asset";
  imageId: string;
  blob: Blob | null;
}

export type DisplayPopupMessage =
  DisplayJoinMessage | DisplayLeaveMessage | DisplayAssetRequestMessage;
export type DisplayOpenerMessage = DisplayStateMessage | DisplayAssetMessage;
export type DisplayMessage = DisplayPopupMessage | DisplayOpenerMessage;

/** `?view=display` — the popup route (same bundle, map only, no net boot). */
export function buildDisplayPopoutUrl(): string {
  return "?view=display";
}

export function isDisplayPopoutSearch(search: string): boolean {
  try {
    return new URLSearchParams(search).get("view") === "display";
  } catch {
    return false;
  }
}

export function isDisplayPopoutLocation(
  locationLike: { search?: string | null } | undefined,
): boolean {
  return isDisplayPopoutSearch(locationLike?.search ?? "");
}

/** Narrow an incoming `MessageEvent.data` to a display-protocol message. */
export function asDisplayMessage(data: unknown): DisplayMessage | null {
  if (!data || typeof data !== "object") return null;
  const msg = data as { channel?: unknown; type?: unknown };
  if (msg.channel !== DISPLAY_CHANNEL || typeof msg.type !== "string") return null;
  return data as DisplayMessage;
}

function postTo(target: Window | null | undefined, msg: DisplayMessage): boolean {
  if (!target || target.closed) return false;
  try {
    target.postMessage(msg, window.location.origin);
    return true;
  } catch {
    // Window torn down mid-post — the heartbeat notices it's gone.
    return false;
  }
}

export interface DisplaySnapshot {
  readonly state: MatchState;
  readonly roster: readonly DiceColorRosterEntry[];
}

export interface DisplayPopoutHostOptions {
  /** Player-safe snapshot to send, or null when there is nothing to show yet. */
  getSnapshot(): DisplaySnapshot | null;
  /** Image bytes for an asset id, or null if unavailable. */
  resolveAsset(imageId: string): Promise<Blob | null>;
}

/**
 * DM-window side of the projector popout: opens/focuses the popup, pushes
 * state to it, and answers its asset requests.
 */
export class DisplayPopoutHost {
  private popout: Window | null = null;
  private pollId: number | null = null;
  private pushTimer: number | null = null;
  private disposed = false;

  constructor(private readonly opts: DisplayPopoutHostOptions) {
    window.addEventListener("message", this.onMessage);
  }

  get isOpen(): boolean {
    return !!this.popout && !this.popout.closed;
  }

  /** Open the popup, or focus it when one is already open. */
  open(): void {
    if (this.popout && !this.popout.closed) {
      try {
        this.popout.focus();
      } catch {
        // Focus is best-effort — the window is still usable without it.
      }
      this.pushNow();
      return;
    }
    let popout: Window | null;
    try {
      popout = window.open(buildDisplayPopoutUrl(), "_blank", "width=1280,height=720");
    } catch {
      popout = null;
    }
    if (!popout) {
      toastService.warn("Pop-up blocked — allow pop-ups to open the projector window.");
      return;
    }
    this.adopt(popout);
  }

  /** Coalesce a state push; bursts of changes (fog strokes) send once. */
  push(): void {
    if (!this.isOpen || this.pushTimer !== null) return;
    this.pushTimer = window.setTimeout(() => {
      this.pushTimer = null;
      this.pushNow();
    }, 0);
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener("message", this.onMessage);
    if (this.pollId !== null) window.clearInterval(this.pollId);
    if (this.pushTimer !== null) window.clearTimeout(this.pushTimer);
    this.pollId = null;
    this.pushTimer = null;
    // The popup is left open: after a DM-window reload it re-joins by itself.
    this.popout = null;
  }

  private adopt(popout: Window): void {
    this.popout = popout;
    this.pushNow();
    if (this.pollId !== null) return;
    this.pollId = window.setInterval(() => {
      if (this.popout && this.popout.closed) this.popout = null;
      if (!this.popout && this.pollId !== null) {
        window.clearInterval(this.pollId);
        this.pollId = null;
      }
    }, DISPLAY_HEARTBEAT_MS);
  }

  private pushNow(): void {
    if (this.disposed || !this.isOpen) return;
    const snap = this.opts.getSnapshot();
    if (!snap) return;
    postTo(this.popout, {
      channel: DISPLAY_CHANNEL,
      type: "display-state",
      state: snap.state,
      roster: snap.roster,
    });
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.origin !== window.location.origin) return;
    const msg = asDisplayMessage(event.data);
    if (!msg) return;
    const source = event.source as Window | null;
    if (!source) return;

    switch (msg.type) {
      case "display-join":
        // An unknown source is a popup that outlived a DM-window reload:
        // adopt it. A known one that already has state is just the heartbeat.
        if (source !== this.popout) this.adopt(source);
        else if (!msg.hasState) this.pushNow();
        return;
      case "display-leave":
        if (source === this.popout) this.popout = null;
        return;
      case "display-asset-request":
        if (source !== this.popout) return;
        void this.answerAsset(source, msg.imageId);
        return;
      default:
        return;
    }
  };

  private async answerAsset(target: Window, imageId: string): Promise<void> {
    let blob: Blob | null;
    try {
      blob = await this.opts.resolveAsset(imageId);
    } catch {
      blob = null;
    }
    postTo(target, { channel: DISPLAY_CHANNEL, type: "display-asset", imageId, blob });
  }
}

/**
 * Popup-side AssetSource: asks the DM window for image bytes once, caches the
 * Blob, and serves a fresh object URL per `resolve()` — the consumer
 * (`ensureTexture`) revokes each URL once the texture is uploaded, so a cached
 * URL would be dead the next time the image is needed (e.g. after a map
 * switch). Read-only — publish is a no-op here.
 */
export class ProxyAssetSource implements AssetSource {
  private readonly blobs = new Map<string, Blob>();
  private readonly pending = new Map<string, (url: string | null) => void>();
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(private readonly request: (imageId: string) => void) {}

  resolve(imageId: string): Promise<string | null> {
    const cached = this.blobs.get(imageId);
    if (cached) return Promise.resolve(URL.createObjectURL(cached));
    const existing = this.inFlight.get(imageId);
    if (existing) return existing;

    const promise = new Promise<string | null>((resolve) => {
      const timer = window.setTimeout(() => settle(null), ASSET_TIMEOUT_MS);
      const settle = (url: string | null): void => {
        window.clearTimeout(timer);
        this.pending.delete(imageId);
        this.inFlight.delete(imageId);
        resolve(url);
      };
      this.pending.set(imageId, settle);
    });
    this.inFlight.set(imageId, promise);
    this.request(imageId);
    return promise;
  }

  /** Deliver the opener's answer to a pending `resolve()`. */
  receive(imageId: string, blob: Blob | null): void {
    const settle = this.pending.get(imageId);
    if (!settle) return;
    if (!blob) {
      settle(null);
      return;
    }
    this.blobs.set(imageId, blob);
    settle(URL.createObjectURL(blob));
  }

  getUrl(imageId: string): Promise<string | null> {
    return this.resolve(imageId);
  }

  async publish(_imageId: string, _blob: Blob): Promise<void> {}

  async release(imageId: string): Promise<void> {
    this.blobs.delete(imageId);
  }

  dispose(): void {
    this.blobs.clear();
    for (const settle of [...this.pending.values()]) settle(null);
  }
}
