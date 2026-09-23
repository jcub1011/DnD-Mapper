import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { CharacterSheet, Token } from "../../game/domain";
import { getReadableTextColor } from "../../game/color";
import { isTokenVisibleToPlayer } from "../../game/visibility";
import { GameElement } from "../app/GameElement";
import { toastService } from "../toast/toastService";
import "../modals/dndm-token-details-modal";

function tokenInitial(name: string): string {
  const trimmed = (name ?? "").trim();
  return trimmed.length > 0 ? trimmed[0].toUpperCase() : "?";
}

function effectiveColor(
  token: Token,
  sheets: Readonly<Record<string, CharacterSheet>>,
): string {
  const sheet = token.sheetId ? sheets[token.sheetId] : null;
  const sheetColor = sheet?.color?.trim();
  if (sheetColor && sheetColor.length > 0) return sheetColor;
  return token.color;
}

@customElement("dndm-token-rail")
export class DndmTokenRail extends GameElement {
  @property({ attribute: false })
  tokens: readonly Token[] = [];

  @property({ attribute: false })
  sheets: Readonly<Record<string, CharacterSheet>> = {};

  @property({ attribute: false })
  roster: readonly { id: string; name: string }[] = [];

  @property({ type: String })
  dmPlayerId: string | null = null;

  @property({ attribute: false })
  currentUserId: string | null = null;

  @property({ type: Boolean })
  isDm = false;

  @property({ attribute: false })
  onCenterOnToken?: (x: number, y: number) => void;

  @property({ attribute: false })
  onToggleHidden?: (tokenId: string, hidden: boolean) => void;

  @property({ attribute: false })
  onUpdateToken?: (tokenId: string, patch: { name?: string; color?: string; iconKind?: "Initial" | "Solid" }) => void;

  @property({ attribute: false })
  onReassignTokenSheet?: (tokenId: string, sheetId: string | null) => void;

  @property({ attribute: false })
  onDeleteToken?: (tokenId: string) => void;

  @state() private selectedTokenId: string | null = null;
  @state() private hovered: { name: string; hint: string; x: number; y: number } | null = null;
  @state() private railTop = 80;
  @state() private railBottom = 68;
  @state() private canScrollUp = false;
  @state() private canScrollDown = false;

  private resizeObserver: ResizeObserver | null = null;
  private boundUpdateOffsets = (): void => this.updateOffsets();
  private longPressTimer: number | null = null;
  private longPressFired = false;

  private static readonly LONG_PRESS_MS = 500;

  private get visibleTokens(): readonly Token[] {
    return (this.tokens ?? []).filter((t) => isTokenVisibleToPlayer(t, this.isDm));
  }

  private get selectedToken(): Token | null {
    if (!this.selectedTokenId) return null;
    return (this.tokens ?? []).find((t) => t.id === this.selectedTokenId) ?? null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this.boundUpdateOffsets);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.updateOffsets());
      const canvasArea = this.closest(".dndm-canvas-area") ?? this.parentElement;
      if (canvasArea) this.resizeObserver.observe(canvasArea);
    }
    this.updateComplete.then(() => this.updateOffsets()).catch(() => undefined);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("resize", this.boundUpdateOffsets);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.cancelLongPress();
    this.hideHover();
  }

  protected override updated(): void {
    this.updateOffsets();
    this.syncScrollArrows();
  }

  private get listEl(): HTMLElement | null {
    return this.querySelector(".dndm-token-rail-list");
  }

  private syncScrollArrows(): void {
    const list = this.listEl;
    if (!list) {
      if (this.canScrollUp || this.canScrollDown) {
        this.canScrollUp = false;
        this.canScrollDown = false;
      }
      return;
    }
    const max = list.scrollHeight - list.clientHeight;
    const up = list.scrollTop > 1;
    const down = list.scrollTop < max - 1;
    if (up !== this.canScrollUp) this.canScrollUp = up;
    if (down !== this.canScrollDown) this.canScrollDown = down;
  }

  private tokenStep(): number {
    const first = this.listEl?.querySelector<HTMLElement>(".dndm-token-rail-avatar");
    // Avatar (28px) + list gap (6px).
    if (!first) return 34;
    const h = first.getBoundingClientRect().height || 28;
    return Math.round(h + 6);
  }

  private scrollByToken(direction: 1 | -1): void {
    this.listEl?.scrollBy({ top: direction * this.tokenStep(), behavior: "smooth" });
  }

  private updateOffsets(): void {
    const host = this.closest(".dndm-canvas-area") as HTMLElement | null;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    // Measure wrapping top floats (toolbar / inspector / banner) and bottom footer.
    const topEls = Array.from(
      host.querySelectorAll<HTMLElement>(
        ".dndm-canvas-toolbar, .dndm-canvas-inspector, .dndm-initiative-banner",
      ),
    );
    const footer = host.querySelector<HTMLElement>(".dndm-rollfooter");
    let bottom = 12;
    if (footer) {
      const r = footer.getBoundingClientRect();
      bottom = Math.max(12, hostRect.bottom - r.top + 8);
    }
    let top = 12;
    for (const el of topEls) {
      if (el.closest("dndm-token-rail")) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > hostRect.top && r.top < hostRect.bottom) {
        top = Math.max(top, r.bottom - hostRect.top + 8);
      }
    }
    const nextTop = Math.round(Math.min(top, 400));
    const nextBottom = Math.round(Math.min(bottom, 400));
    if (nextTop !== this.railTop) this.railTop = nextTop;
    if (nextBottom !== this.railBottom) this.railBottom = nextBottom;
  }

  private showHover(t: Token, anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    this.hovered = {
      name: t.name,
      hint: this.isDm
        ? "Click: details · Hold: center · Right-click: hide/reveal"
        : "Click: details · Hold: center",
      x: r.left,
      y: r.top + r.height / 2,
    };
  }

  private hideHover(): void {
    this.hovered = null;
  }

  private openDetails(t: Token): void {
    this.selectedTokenId = t.id;
    this.dispatchEvent(
      new CustomEvent<string>("open-token-details", {
        bubbles: true,
        composed: true,
        detail: t.id,
      }),
    );
  }

  private closeDetails(): void {
    this.selectedTokenId = null;
  }

  private handleAvatarClick(t: Token, e: Event): void {
    e.stopPropagation();
    if (this.longPressFired) {
      this.longPressFired = false;
      return;
    }
    this.cancelLongPress();
    this.openDetails(t);
  }

  private centerOnToken(t: Token): void {
    this.dispatchEvent(
      new CustomEvent<{ x: number; y: number }>("center-token", {
        bubbles: true,
        composed: true,
        detail: { x: t.x, y: t.y },
      }),
    );
    this.onCenterOnToken?.(t.x, t.y);
  }

  private startLongPress(t: Token): void {
    this.cancelLongPress();
    this.longPressFired = false;
    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = null;
      this.longPressFired = true;
      this.hideHover();
      this.centerOnToken(t);
    }, DndmTokenRail.LONG_PRESS_MS);
  }

  private cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private handlePressStart(t: Token, e: Event): void {
    if ((e as PointerEvent).button !== undefined && (e as PointerEvent).button !== 0) return;
    this.startLongPress(t);
  }

  private handlePressEnd(): void {
    // If the timer already fired, click will be suppressed via longPressFired.
    if (this.longPressTimer !== null) this.cancelLongPress();
  }

  private handleAvatarContextMenu(t: Token, e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    if (!this.isDm) {
      toastService.warn("Only the DM can toggle token visibility.");
      return;
    }
    const nextHidden = !t.hidden;
    this.dispatchEvent(
      new CustomEvent<{ tokenId: string; hidden: boolean }>("toggle-token-hidden", {
        bubbles: true,
        composed: true,
        detail: { tokenId: t.id, hidden: nextHidden },
      }),
    );
    this.onToggleHidden?.(t.id, nextHidden);
  }

  override render(): TemplateResult {
    const tokens = this.visibleTokens;
    const scrollable = tokens.length > 6;

    return html`
      <div
        class="dndm-token-rail"
        role="list"
        aria-label="Tokens"
        style="top: ${this.railTop}px; bottom: ${this.railBottom}px;"
      >
        ${scrollable
          ? html`<button
              type="button"
              class="dndm-token-rail-arrow"
              aria-label="Scroll tokens up"
              ?disabled=${!this.canScrollUp}
              @click=${(e: Event) => {
                e.stopPropagation();
                this.scrollByToken(-1);
              }}
            >
              ▲
            </button>`
          : nothing}
        <div
          class="dndm-token-rail-list"
          role="presentation"
          @scroll=${() => this.syncScrollArrows()}
          @wheel=${() => {
            // Let the wheel scroll natively; state syncs on scroll.
          }}
        >
        ${tokens.length === 0
          ? html`<div class="dndm-token-rail-empty" title="No tokens on this map">—</div>`
          : tokens.map((t) => {
              const bg = effectiveColor(t, this.sheets);
              const fg = getReadableTextColor(bg);
              const initial = tokenInitial(t.name);
              const isPlayer = t.type === "PlayerToken";
              const isMine =
                !!this.currentUserId &&
                (t.ownerUserId === this.currentUserId ||
                  t.representsUserId === this.currentUserId ||
                  // The host owns anything not assigned to a player.
                  (this.isDm && t.ownerUserId === null));
              const label = `${t.name}${t.hidden ? " (hidden)" : ""}${isMine ? " (you)" : ""}. Click for details, hold to center${this.isDm ? ", right-click to hide or reveal" : ""}.`;
              return html`
                <button
                  type="button"
                  role="listitem"
                  class="dndm-token-rail-avatar ${t.hidden ? "is-hidden" : ""} ${isMine
                    ? "is-mine"
                    : ""}"
                  style="--tok-bg: ${bg}; --tok-fg: ${fg};"
                  title=${label}
                  aria-label=${label}
                  @click=${(e: Event) => this.handleAvatarClick(t, e)}
                  @contextmenu=${(e: Event) => this.handleAvatarContextMenu(t, e)}
                  @pointerdown=${(e: Event) => this.handlePressStart(t, e)}
                  @pointerup=${() => this.handlePressEnd()}
                  @pointerleave=${() => this.handlePressEnd()}
                  @pointercancel=${() => this.handlePressEnd()}
                  @mouseenter=${(e: Event) =>
                    this.showHover(t, e.currentTarget as HTMLElement)}
                  @mouseleave=${() => {
                    this.handlePressEnd();
                    this.hideHover();
                  }}
                  @focus=${(e: Event) =>
                    this.showHover(t, e.currentTarget as HTMLElement)}
                  @blur=${() => this.hideHover()}
                >
                  ${t.iconKind !== "Solid"
                    ? html`<span class="dndm-token-rail-initial" aria-hidden="true"
                        >${initial}</span
                      >`
                    : nothing}
                  <span
                    class="dndm-token-rail-corner ${isPlayer ? "is-player" : "is-npc"}"
                    title=${isPlayer ? "Player" : "NPC"}
                    aria-hidden="true"
                    >${isPlayer ? "P" : "N"}</span
                  >
                  ${isMine
                    ? html`<span
                        class="dndm-token-rail-mine"
                        title="Your token"
                        aria-hidden="true"
                        >★</span
                      >`
                    : nothing}
                  ${t.hidden
                    ? html`<span
                        class="dndm-token-rail-hidden-dot"
                        title="Hidden"
                        aria-hidden="true"
                      ></span>`
                    : nothing}
                </button>
              `;
            })}
        </div>
        ${scrollable
          ? html`<button
              type="button"
              class="dndm-token-rail-arrow"
              aria-label="Scroll tokens down"
              ?disabled=${!this.canScrollDown}
              @click=${(e: Event) => {
                e.stopPropagation();
                this.scrollByToken(1);
              }}
            >
              ▼
            </button>`
          : nothing}
      </div>

      ${this.hovered
        ? html`<div
            class="dndm-token-rail-tip-float"
            role="tooltip"
            style="left: ${this.hovered.x}px; top: ${this.hovered.y}px;"
          >
            <span class="dndm-token-rail-tip-name">${this.hovered.name}</span>
            <span class="dndm-token-rail-tip-hint">${this.hovered.hint}</span>
          </div>`
        : nothing}

      <dndm-token-details-modal
        ?isOpen=${this.selectedToken !== null}
        .token=${this.selectedToken}
        .sheets=${this.sheets}
        .roster=${this.roster}
        .dmPlayerId=${this.dmPlayerId}
        .isDm=${this.isDm}
        .onUpdateToken=${this.onUpdateToken}
        .onToggleHidden=${this.onToggleHidden}
        .onReassignTokenSheet=${this.onReassignTokenSheet}
        .onDeleteToken=${this.onDeleteToken}
        .onCenterOnToken=${this.onCenterOnToken}
        .onClose=${() => this.closeDetails()}
        .onCancel=${() => this.closeDetails()}
        @close=${() => this.closeDetails()}
        @cancel=${() => this.closeDetails()}
      ></dndm-token-details-modal>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-token-rail": DndmTokenRail;
  }
}
