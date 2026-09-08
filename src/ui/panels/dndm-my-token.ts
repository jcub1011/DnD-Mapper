import { html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Token } from "../../game/domain";
import { GameElement } from "../app/GameElement";

@customElement("dndm-my-token")
export class DndmMyToken extends GameElement {
  @property({ attribute: false })
  token: Token | null = null;

  @property({ attribute: false })
  onChangeColor?: (tokenId: string, color: string) => void;

  private handleColorChange(e: Event): void {
    if (!this.token) return;
    const color = (e.target as HTMLInputElement).value;
    this.dispatchEvent(
      new CustomEvent<{ tokenId: string; color: string }>("change-color", {
        bubbles: true,
        composed: true,
        detail: { tokenId: this.token.id, color },
      }),
    );
    this.onChangeColor?.(this.token.id, color);
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.token) return nothing;

    return html`
      <section class="dndm-panel dndm-mytokenp">
        <header class="dndm-panel-header">
          <span>My Token</span>
        </header>
        <div class="dndm-panel-body">
          <div class="dndm-mytokenp-row">
            <input
              type="color"
              class="dndm-mytokenp-color"
              .value=${this.token.color}
              title="Change my token color"
              @change=${this.handleColorChange}
            />
            <span class="dndm-mytokenp-name">${this.token.name}</span>
          </div>
        </div>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-my-token": DndmMyToken;
  }
}
