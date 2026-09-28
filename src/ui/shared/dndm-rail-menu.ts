import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { GameElement } from "../app/GameElement";

@customElement("dndm-rail-menu")
export class DndmRailMenu extends GameElement {
  @property({ type: String })
  menuTitle = "Actions";

  @property({ attribute: false })
  actions?: () => TemplateResult;

  @state()
  private open = false;

  private toggle(e: Event): void {
    e.stopPropagation();
    this.open = !this.open;
  }

  private close(e: Event): void {
    e.stopPropagation();
    this.open = false;
  }

  override render(): TemplateResult {
    const content = this.actions ? this.actions() : nothing;

    return html`
      <div class="dndm-railactions">
        <div class="dndm-railactions__inline">${content}</div>
        <button
          class="dndm-btn dndm-btn--small dndm-btn--ghost dndm-railactions__trigger"
          type="button"
          title=${this.menuTitle}
          aria-label=${this.menuTitle}
          @click=${this.toggle}
        >
          ⋯
        </button>
        ${this.open
          ? html`
              <div class="dndm-railactions__backdrop" @click=${this.close}></div>
              <div class="dndm-railactions__pop" @click=${(e: Event) => e.stopPropagation()}>
                ${content}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-rail-menu": DndmRailMenu;
  }
}
