import { html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { GameElement } from "../app/GameElement";
import { toastService, type ToastEntry, type ToastService, type ToastTone } from "./toastService";

function iconForTone(tone: ToastTone): string {
  switch (tone) {
    case "success":
      return "✓";
    case "warn":
      return "⚠";
    case "danger":
      return "✕";
    case "info":
    default:
      return "ℹ";
  }
}

@customElement("dndm-toast")
export class DndmToast extends GameElement {
  @property({ attribute: false })
  service: ToastService = toastService;

  @state()
  private entries: readonly ToastEntry[] = [];

  private unsub?: () => void;

  override connectedCallback(): void {
    super.connectedCallback();
    this.unsub = this.service.subscribe((entries) => {
      this.entries = entries;
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
  }

  override render(): TemplateResult | typeof nothing {
    if (this.entries.length === 0) return nothing;

    return html`
      <div class="dndm-toast-stack" aria-live="polite">
        ${this.entries.map(
          (entry) => html`
            <div
              class="dndm-toast dndm-toast--${entry.tone}"
              @click=${() => this.service.dismiss(entry.id)}
              role="status"
            >
              <span class="dndm-toast-icon">${iconForTone(entry.tone)}</span>
              <span class="dndm-toast-message">${entry.message}</span>
            </div>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-toast": DndmToast;
  }
}
