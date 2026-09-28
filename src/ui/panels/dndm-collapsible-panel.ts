import { html, nothing, type PropertyDeclaration, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { GameElement } from "../app/GameElement";

/**
 * Standard reusable collapsible panel component for DnD-Mapper side rails.
 *
 * Provides consistent display and interaction logic:
 * - Header bar with a title and title bar action button list.
 * - Title truncates with ellipsis when horizontal width is restricted.
 * - Clicking the panel title or pressing Enter/Space toggles collapsed state.
 * - Divider line between the header and panel content.
 * - Content gets hidden when collapsed and shown when expanded.
 */
@customElement("dndm-collapsible-panel")
export class DndmCollapsiblePanel extends GameElement {
  @property({
    converter: {
      fromAttribute(value: string | null) {
        return value ?? "";
      },
      toAttribute(value: unknown) {
        return typeof value === "string" ? value : null;
      },
    },
  })
  panelTitle: string | TemplateResult = "";

  @property({ attribute: false })
  actions?: TemplateResult | TemplateResult[] | (() => TemplateResult) | unknown;

  @property({ type: Boolean, reflect: true })
  collapsed = false;

  @property({ attribute: false })
  content?: TemplateResult | (() => TemplateResult) | unknown;

  @property({ attribute: false })
  body?: TemplateResult | (() => TemplateResult) | unknown;

  @property({ type: String })
  panelClass = "";

  @property({ type: String })
  panelStyle = "";

  @property({ type: String })
  headerClass = "";

  @property({ type: String })
  headerStyle = "";

  @property({ type: String })
  actionsClass = "";

  @property({ type: String })
  actionsStyle = "";

  @property({ type: String })
  dividerClass = "";

  @property({ type: String })
  bodyClass = "";

  @property({ type: String })
  bodyStyle = "";

  @property({ attribute: false })
  onToggleCollapse?: (collapsed: boolean) => void;

  override connectedCallback(): void {
    super.connectedCallback();
    this.performUpdate();
  }

  override requestUpdate(name?: PropertyKey, oldValue?: unknown, options?: PropertyDeclaration): void {
    super.requestUpdate(name, oldValue, options);
    if (this.isConnected) {
      this.performUpdate();
    }
  }

  protected override updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);
    if (changedProperties.has("collapsed")) {
      this.syncPanelDomClass();
    }
  }

  private syncPanelDomClass(): void {
    const panelEl = this.querySelector<HTMLElement>(".dndm-panel");
    if (panelEl) {
      panelEl.classList.toggle("dndm-panel--collapsed", this.collapsed);
    }
  }

  public toggleCollapse(force?: boolean): void {
    this.collapsed = force !== undefined ? force : !this.collapsed;
    this.syncPanelDomClass();
    this.dispatchEvent(
      new CustomEvent("collapse-change", {
        bubbles: true,
        composed: true,
        detail: { collapsed: this.collapsed },
      }),
    );
    this.onToggleCollapse?.(this.collapsed);
  }

  private readonly handleTitleClick = (e: MouseEvent): void => {
    e.stopPropagation();
    this.toggleCollapse();
  };

  private readonly handleTitleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      this.toggleCollapse();
    }
  };

  private readonly handleHeaderClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    // Do not toggle if click is within actions container
    if (target.closest(".dndm-panel-actions")) {
      return;
    }

    // Check if click was on or inside interactive elements
    let el: HTMLElement | null = target;
    const header = this.querySelector<HTMLElement>(".dndm-panel-header");
    while (el && el !== header) {
      const tag = el.tagName;
      if (
        tag === "BUTTON" ||
        tag === "INPUT" ||
        tag === "SELECT" ||
        tag === "TEXTAREA" ||
        tag === "A" ||
        tag === "LABEL" ||
        (el.getAttribute("role") === "button" && !el.classList.contains("dndm-panel-title"))
      ) {
        return;
      }
      el = el.parentElement;
    }

    this.toggleCollapse();
  };

  private renderActions(): TemplateResult | typeof nothing {
    if (!this.actions) return nothing;
    if (typeof this.actions === "function") {
      return (this.actions as () => TemplateResult)();
    }
    if (Array.isArray(this.actions)) {
      return html`${this.actions.map((act) => act)}`;
    }
    return this.actions as TemplateResult;
  }

  private renderBody(): TemplateResult | typeof nothing {
    const target = this.content ?? this.body;
    if (!target) return nothing;
    if (typeof target === "function") {
      return (target as () => TemplateResult)();
    }
    return target as TemplateResult;
  }

  override render(): TemplateResult {
    const titleText = typeof this.panelTitle === "string" ? this.panelTitle : "";

    return html`
      <section
        class="dndm-panel ${this.collapsed ? "dndm-panel--collapsed" : ""} ${this.panelClass}"
        style=${this.panelStyle || nothing}
      >
        <header
          class="dndm-panel-header ${this.headerClass}"
          style=${this.headerStyle || nothing}
          @click=${this.handleHeaderClick}
        >
          <div
            class="dndm-panel-title"
            role="button"
            tabindex="0"
            aria-expanded=${!this.collapsed}
            title=${titleText}
            @click=${this.handleTitleClick}
            @keydown=${this.handleTitleKeyDown}
          >
            <span class="dndm-panel-title-text">${this.panelTitle}</span>
          </div>
          <div
            class="dndm-panel-actions ${this.actionsClass}"
            style=${this.actionsStyle || nothing}
            @click=${(e: Event) => e.stopPropagation()}
          >
            ${this.renderActions()}
          </div>
        </header>
        <div class="dndm-panel-divider ${this.dividerClass}" aria-hidden="true"></div>
        <div
          class="dndm-panel-body ${this.bodyClass}"
          style=${this.bodyStyle || nothing}
        >
          ${this.renderBody()}
        </div>
      </section>
    `;
  }
}

if (!customElements.get("dndm-panel")) {
  customElements.define("dndm-panel", class extends DndmCollapsiblePanel {});
}

declare global {
  interface HTMLElementTagNameMap {
    "dndm-collapsible-panel": DndmCollapsiblePanel;
    "dndm-panel": DndmCollapsiblePanel;
  }
}
