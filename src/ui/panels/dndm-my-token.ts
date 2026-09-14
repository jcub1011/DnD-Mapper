import { html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Token } from "../../game/domain";
import { GameElement } from "../app/GameElement";
import "./dndm-collapsible-panel";

@customElement("dndm-my-token")
export class DndmMyToken extends GameElement {
  @property({ attribute: false })
  token: Token | null = null;

  @property({ attribute: false })
  onChangeColor?: (tokenId: string, color: string) => void;

  private readonly handleColorChange = (e: Event): void => {
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
  };

  override render(): TemplateResult | typeof nothing {
    if (!this.token) return nothing;

    return html`
      <dndm-collapsible-panel
        panelTitle="My Token"
        panelClass="dndm-mytokenp"
        .content=${html`
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
        `}
      ></dndm-collapsible-panel>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-my-token": DndmMyToken;
  }
}
