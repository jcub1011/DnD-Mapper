import { html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AttributeValue, StatusEffect } from "../../game/domain";
import { GameElement } from "../app/GameElement";
import {
  SHEET_SYNC_CHANNEL,
  parseSheetPopoutParams,
  type SheetEditIntent,
  type SheetStateMessage,
  type SheetSyncMessage,
} from "./sheetPopout";
import type { SheetPatch } from "./dndm-character-sheet";
import "./dndm-character-sheet";

/**
 * Single-sheet popout window view (`?view=sheet&sheetId=<id>`).
 *
 * Boots without Phaser/network (see main.ts) and renders one
 * `<dndm-character-sheet>` in popout mode as a BroadcastChannel client of
 * the main window. All edits are forwarded as `sheet-edit` intents; the
 * opener re-validates permissions and applies them, then pushes the updated
 * `sheet-state` back. Delete, duplicate, and place-token are main-window-only
 * (their buttons are hidden via `isSheetPopout`, and the opener drops such
 * intents even if forged).
 */
@customElement("dndm-sheet-popout-view")
export class DndmSheetPopoutView extends GameElement {
  @property({ type: String })
  sheetId: string | null = null;

  @state() private sheetState: SheetStateMessage | null = null;
  @state() private hasReceivedState = false;
  @state() private closedByOpener = false;

  private channel: BroadcastChannel | null = null;
  private resolvedSheetId: string | null = null;

  private readonly onBeforeUnload = (): void => {
    this.post({ type: "sheet-leave", sheetId: this.resolvedSheetId ?? "" });
  };

  override connectedCallback(): void {
    super.connectedCallback();
    const fromUrl = parseSheetPopoutParams(
      typeof window !== "undefined" ? window.location.search : "",
    );
    this.resolvedSheetId = this.sheetId ?? fromUrl.sheetId;
    if (!this.resolvedSheetId) return;
    if (typeof BroadcastChannel === "undefined") return;
    this.channel = new BroadcastChannel(SHEET_SYNC_CHANNEL);
    this.channel.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };
    this.post({ type: "sheet-join", sheetId: this.resolvedSheetId });
    window.addEventListener("beforeunload", this.onBeforeUnload);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("beforeunload", this.onBeforeUnload);
    if (this.channel) {
      try {
        if (this.resolvedSheetId) {
          this.channel.postMessage({ type: "sheet-leave", sheetId: this.resolvedSheetId });
        }
      } catch {
        // Channel already torn down — nothing to notify.
      }
      try {
        this.channel.close();
      } catch {
        // Already closed — nothing to clean up.
      }
      this.channel = null;
    }
  }

  private post(msg: SheetSyncMessage): void {
    if (!this.channel || !this.resolvedSheetId) return;
    try {
      this.channel.postMessage(msg);
    } catch {
      // Channel torn down — the opener will notice the silence via its poll.
    }
  }

  private postEdit(intent: SheetEditIntent): void {
    if (!this.resolvedSheetId) return;
    this.post({ type: "sheet-edit", sheetId: this.resolvedSheetId, intent });
  }

  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const data = msg as { type?: string; sheetId?: string };
    if (data.sheetId !== this.resolvedSheetId) return;
    if (data.type === "sheet-state") {
      this.hasReceivedState = true;
      this.sheetState = data as SheetStateMessage;
      const name = this.sheetState.sheet?.characterName;
      try {
        document.title = name ? `${name} — Character Sheet` : "Character Sheet";
      } catch {
        // Non-DOM test host — title is cosmetic.
      }
    } else if (data.type === "sheet-close") {
      this.closedByOpener = true;
      try {
        window.close();
      } catch {
        // Popup already gone — nothing to clean up.
      }
    }
  }

  override render(): TemplateResult {
    const sheetId = this.resolvedSheetId ?? this.sheetId;
    if (!sheetId) {
      return html`
        <div class="dndm-sheet-popout dndm-sheet-popout--empty">
          <p>Missing sheet id — this window needs <code>?view=sheet&amp;sheetId=…</code>.</p>
        </div>
      `;
    }
    if (typeof BroadcastChannel === "undefined") {
      return html`
        <div class="dndm-sheet-popout dndm-sheet-popout--empty">
          <p>Not connected (BroadcastChannel unavailable).</p>
        </div>
      `;
    }
    if (this.closedByOpener) {
      return html`
        <div class="dndm-sheet-popout dndm-sheet-popout--empty">
          <p>This sheet was closed from the main window. You can close this tab.</p>
        </div>
      `;
    }
    const snap = this.sheetState;
    if (!snap || !snap.sheet) {
      return html`
        <div class="dndm-sheet-popout dndm-sheet-popout--empty">
          <p>
            ${
              !this.hasReceivedState
                ? "Waiting for the main window…"
                : "This sheet was deleted or is no longer available. You can close this tab."
            }
          </p>
        </div>
      `;
    }
    const sheet = snap.sheet;
    return html`
      <div class="dndm-sheet-popout">
        <div class="dndm-sheet-popout-body">
          <dndm-character-sheet
          .sheets=${{ [sheet.id]: sheet }}
          .selectedSheetId=${sheet.id}
          .activeMapId=${snap.activeMapId}
          .attributeSchema=${snap.attributeSchema}
          .statusEffectTemplates=${snap.statusEffectTemplates}
          .settings=${snap.settings}
          .isDm=${snap.isDm}
          .currentUserId=${snap.currentUserId}
          .roster=${snap.roster}
          .dmPlayerId=${snap.dmPlayerId}
          .maps=${snap.maps}
          .isSheetPopout=${true}
          .onUpdateSheet=${(_id: string, patch: SheetPatch) => {
            this.postEdit({ kind: "updateSheet", patch });
          }}
          .onAssignSheetOwner=${(_id: string, ownerUserId: string | null) => {
            this.postEdit({ kind: "assignSheetOwner", ownerUserId });
          }}
          .onSetSheetHp=${(_id: string, hp: number | null) => {
            this.postEdit({ kind: "setSheetHp", hp });
          }}
          .onSetSheetMaxHp=${(_id: string, maxHp: number | null) => {
            this.postEdit({ kind: "setSheetMaxHp", maxHp });
          }}
          .onSetSheetAc=${(_id: string, ac: number | null) => {
            this.postEdit({ kind: "setSheetAc", ac });
          }}
          .onUpdateAttributeValues=${(
            _id: string,
            values: Readonly<Record<string, AttributeValue>>,
          ) => {
            this.postEdit({ kind: "updateAttributeValues", values });
          }}
          .onApplyStatusEffect=${(_id: string, effect: Omit<StatusEffect, "id" | "appliedUtc">) => {
            this.postEdit({ kind: "applyStatusEffect", effect });
          }}
          .onRemoveStatusEffect=${(_id: string, effectId: string) => {
            this.postEdit({ kind: "removeStatusEffect", effectId });
          }}
        ></dndm-character-sheet>
        </div>
      </div>
    `;
  }
}
