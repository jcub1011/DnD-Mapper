// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html } from "lit";
import "./dndm-collapsible-panel";
import type { DndmCollapsiblePanel } from "./dndm-collapsible-panel";
import type { DndmHostInitiative } from "./dndm-host-initiative.js";
import type { DndmSavesPanel } from "./dndm-saves-panel.js";

describe("<dndm-collapsible-panel>", () => {
  let panel: DndmCollapsiblePanel;

  beforeEach(() => {
    panel = document.createElement("dndm-collapsible-panel") as DndmCollapsiblePanel;
  });

  afterEach(() => {
    panel.remove();
  });

  it("renders panel with title, action button list, divider line, and content", async () => {
    panel.panelTitle = "Test Panel Title";
    panel.actions = html`<button type="button" class="test-action-btn">Action</button>`;
    panel.content = html`<div class="test-content">Inner Panel Content</div>`;

    document.body.appendChild(panel);
    await panel.updateComplete;

    // Title & title text
    const titleContainer = panel.querySelector(".dndm-panel-title") as HTMLElement;
    expect(titleContainer).not.toBeNull();
    expect(titleContainer.getAttribute("role")).toBe("button");
    expect(titleContainer.getAttribute("aria-expanded")).toBe("true");
    expect(titleContainer.getAttribute("title")).toBe("Test Panel Title");

    const titleText = panel.querySelector(".dndm-panel-title-text") as HTMLElement;
    expect(titleText).not.toBeNull();
    expect(titleText.textContent?.trim()).toBe("Test Panel Title");

    // Action button list
    const actionsContainer = panel.querySelector(".dndm-panel-actions") as HTMLElement;
    expect(actionsContainer).not.toBeNull();
    const actionBtn = actionsContainer.querySelector(".test-action-btn") as HTMLButtonElement;
    expect(actionBtn).not.toBeNull();
    expect(actionBtn.textContent).toBe("Action");

    // Divider line
    const divider = panel.querySelector(".dndm-panel-divider") as HTMLElement;
    expect(divider).not.toBeNull();

    // Body content
    const bodyContainer = panel.querySelector(".dndm-panel-body") as HTMLElement;
    expect(bodyContainer).not.toBeNull();
    const content = bodyContainer.querySelector(".test-content") as HTMLElement;
    expect(content).not.toBeNull();
    expect(content.textContent).toBe("Inner Panel Content");
  });

  it("renders panel title with ellipsis truncation structure", async () => {
    panel.panelTitle = "Very Long Panel Title That Exceeds The Side Rail Width Limit";
    document.body.appendChild(panel);
    await panel.updateComplete;

    const titleContainer = panel.querySelector(".dndm-panel-title") as HTMLElement;
    expect(titleContainer.classList.contains("dndm-panel-title")).toBe(true);

    const titleText = panel.querySelector(".dndm-panel-title-text") as HTMLElement;
    expect(titleText.classList.contains("dndm-panel-title-text")).toBe(true);
    expect(titleContainer.getAttribute("title")).toBe(
      "Very Long Panel Title That Exceeds The Side Rail Width Limit",
    );
  });

  it("toggles collapsed state when clicking the panel title", async () => {
    panel.panelTitle = "Collapsible Title";
    panel.content = html`<div>Content</div>`;
    const onToggle = vi.fn();
    panel.onToggleCollapse = onToggle;

    const onCollapseChange = vi.fn();
    panel.addEventListener("collapse-change", (e) => {
      onCollapseChange((e as CustomEvent<{ collapsed: boolean }>).detail);
    });

    document.body.appendChild(panel);
    await panel.updateComplete;

    const innerPanel = panel.querySelector(".dndm-panel") as HTMLElement;
    const titleEl = panel.querySelector(".dndm-panel-title") as HTMLElement;

    expect(panel.collapsed).toBe(false);
    expect(innerPanel.classList.contains("dndm-panel--collapsed")).toBe(false);

    // Click to collapse
    titleEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel.collapsed).toBe(true);
    expect(innerPanel.classList.contains("dndm-panel--collapsed")).toBe(true);
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(onCollapseChange).toHaveBeenCalledWith({ collapsed: true });

    // Click again to uncollapse
    titleEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel.collapsed).toBe(false);
    expect(innerPanel.classList.contains("dndm-panel--collapsed")).toBe(false);
    expect(onToggle).toHaveBeenCalledWith(false);
    expect(onCollapseChange).toHaveBeenCalledWith({ collapsed: false });
  });

  it("toggles collapsed state when clicking the title span element", async () => {
    panel.panelTitle = "Clickable Span";
    panel.content = html`<div>Content</div>`;
    document.body.appendChild(panel);
    await panel.updateComplete;

    const innerPanel = panel.querySelector(".dndm-panel") as HTMLElement;
    const titleSpan = panel.querySelector(".dndm-panel-title span") as HTMLElement;
    expect(titleSpan).not.toBeNull();

    titleSpan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel.collapsed).toBe(true);
    expect(innerPanel.classList.contains("dndm-panel--collapsed")).toBe(true);

    titleSpan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel.collapsed).toBe(false);
    expect(innerPanel.classList.contains("dndm-panel--collapsed")).toBe(false);
  });

  it("does not toggle collapse when clicking action buttons", async () => {
    const actionClick = vi.fn();
    panel.panelTitle = "Title with Action";
    panel.actions = html`
      <button type="button" class="test-action-btn" @click=${actionClick}>+</button>
    `;
    panel.content = html`<div>Content</div>`;

    document.body.appendChild(panel);
    await panel.updateComplete;

    const innerPanel = panel.querySelector(".dndm-panel") as HTMLElement;
    const actionBtn = panel.querySelector(".test-action-btn") as HTMLButtonElement;

    expect(panel.collapsed).toBe(false);

    actionBtn.click();
    expect(actionClick).toHaveBeenCalledTimes(1);
    expect(panel.collapsed).toBe(false);
    expect(innerPanel.classList.contains("dndm-panel--collapsed")).toBe(false);
  });

  it("supports keyboard navigation via Enter and Space on panel title", async () => {
    panel.panelTitle = "Keyboard Navigable Title";
    panel.content = html`<div>Content</div>`;
    document.body.appendChild(panel);
    await panel.updateComplete;

    const innerPanel = panel.querySelector(".dndm-panel") as HTMLElement;
    const titleEl = panel.querySelector(".dndm-panel-title") as HTMLElement;

    // Press Enter
    titleEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(panel.collapsed).toBe(true);
    expect(innerPanel.classList.contains("dndm-panel--collapsed")).toBe(true);

    // Press Space
    titleEl.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(panel.collapsed).toBe(false);
    expect(innerPanel.classList.contains("dndm-panel--collapsed")).toBe(false);
  });

  it("reflects programmatic collapsed property changes", async () => {
    panel.panelTitle = "Programmatic Toggle";
    panel.content = html`<div>Content</div>`;
    document.body.appendChild(panel);
    await panel.updateComplete;

    const innerPanel = panel.querySelector(".dndm-panel") as HTMLElement;
    const titleContainer = panel.querySelector(".dndm-panel-title") as HTMLElement;

    panel.collapsed = true;
    await panel.updateComplete;

    expect(innerPanel.classList.contains("dndm-panel--collapsed")).toBe(true);
    expect(titleContainer.getAttribute("aria-expanded")).toBe("false");

    panel.collapsed = false;
    await panel.updateComplete;

    expect(innerPanel.classList.contains("dndm-panel--collapsed")).toBe(false);
    expect(titleContainer.getAttribute("aria-expanded")).toBe("true");
  });

  it("supports alias <dndm-panel> custom element", async () => {
    const aliasEl = document.createElement("dndm-panel") as DndmCollapsiblePanel;
    aliasEl.panelTitle = "Alias Panel";
    aliasEl.content = html`<div>Alias Content</div>`;

    document.body.appendChild(aliasEl);
    await aliasEl.updateComplete;

    const titleSpan = aliasEl.querySelector(".dndm-panel-title span");
    expect(titleSpan?.textContent?.trim()).toBe("Alias Panel");

    aliasEl.remove();
  });

  it("renders divider lines in <dndm-saves-panel>", async () => {
    await import("./dndm-saves-panel.js");

    const saves = document.createElement("dndm-saves-panel") as DndmSavesPanel;
    document.body.appendChild(saves);
    await saves.updateComplete;

    const divider = saves.querySelector(".dndm-panel-divider");
    expect(divider).not.toBeNull();

    // Verify ordering: header -> divider -> body
    const header = saves.querySelector(".dndm-panel-header");
    const body = saves.querySelector(".dndm-panel-body");
    expect(header).not.toBeNull();
    expect(body).not.toBeNull();
    expect(divider!.previousElementSibling).toBe(header);
    expect(divider!.nextElementSibling).toBe(body);

    saves.remove();
  });

  it("renders divider lines in <dndm-host-initiative> for both empty and combat states", async () => {
    await import("./dndm-host-initiative.js");

    const init = document.createElement("dndm-host-initiative") as DndmHostInitiative;
    document.body.appendChild(init);
    await init.updateComplete;

    // Empty state
    let divider = init.querySelector(".dndm-panel-divider");
    expect(divider).not.toBeNull();
    let header = init.querySelector(".dndm-panel-header");
    let body = init.querySelector(".dndm-panel-body");
    expect(divider!.previousElementSibling).toBe(header);
    expect(divider!.nextElementSibling).toBe(body);

    // Active combat tracker state
    init.combat = {
      phase: "WaitingForRolls",
      roundNumber: 1,
      currentTurnIndex: 0,
      turnOrder: [],
    };
    await init.updateComplete;

    divider = init.querySelector(".dndm-panel-divider");
    expect(divider).not.toBeNull();
    header = init.querySelector(".dndm-panel-header");
    body = init.querySelector(".dndm-panel-body");
    expect(divider!.previousElementSibling).toBe(header);
    expect(divider!.nextElementSibling).toBe(body);

    init.remove();
  });
});
