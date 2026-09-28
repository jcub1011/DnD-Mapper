import { html, nothing, svg, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  AttributePreset,
  AttributeRow,
  AttributeSchema,
  AttributeValue,
  CharacterSheet,
  CustomTemplate,
  DndMapperSettings,
  DndMapperState,
  GameMap,
  MapSummary,
  NamedTemplate,
  StatusEffect,
  StatusEffectTemplate,
} from "../../game/domain";
import {
  createDefaultAttributeSchema,
  createDefaultDndMapperState,
  isFullMap,
  resolveAttributeContribution,
  resolveEffectiveMaxHp,
  toMapSummary,
} from "../../game/domain";
import { mayEditSheet, mayViewSheetNotesAndHp } from "../../game/rules";
import { GameElement } from "../app/GameElement";
import {
  copyIcon,
  expandIcon,
  eyeIcon,
  gearIcon,
  penIcon,
  popoutIcon,
  tokenPlusIcon,
} from "../icons";
import { toastService } from "../toast/toastService";
import { toSafeHtml } from "./markdown";
import {
  SHEET_SYNC_CHANNEL,
  buildSheetPopoutUrl,
  type SheetEditMessage,
  type SheetJoinMessage,
  type SheetLeaveMessage,
  type SheetStateMessage,
} from "./sheetPopout";
import "./dndm-status-effects";
import "./dndm-collapsible-panel";
import "../modals/dndm-sheet-settings-modal";
import type { SheetSettingsPatch } from "../modals/dndm-sheet-settings-modal";
import "../modals/dndm-notes-modal";
import type { NotesTab } from "../modals/dndm-notes-modal";
import "../modals/dndm-schema-preset-modal";
import "../modals/dndm-schema-cascade-warning";

const ABILITY_KEYS = new Set([
  "str",
  "dex",
  "con",
  "int",
  "wis",
  "cha",
  "strength",
  "dexterity",
  "constitution",
  "intelligence",
  "wisdom",
  "charisma",
]);

function isAbilityRow(row: AttributeRow): boolean {
  return row.type === "Score" && ABILITY_KEYS.has(row.name.toLowerCase().trim());
}

function shortAbilityName(name: string): string {
  const lower = name.toLowerCase().trim();
  if (lower.startsWith("str")) return "STR";
  if (lower.startsWith("dex")) return "DEX";
  if (lower.startsWith("con")) return "CON";
  if (lower.startsWith("int")) return "INT";
  if (lower.startsWith("wis")) return "WIS";
  if (lower.startsWith("cha")) return "CHA";
  return name.slice(0, 3).toUpperCase();
}

export type SheetPatch = Partial<
  Pick<CharacterSheet, "characterName" | "color" | "scopedMapId" | "notes">
>;

@customElement("dndm-character-sheet")
export class DndmCharacterSheet extends GameElement {
  @property({ attribute: false })
  sheets: Readonly<Record<string, CharacterSheet>> = {};

  @property({ type: String })
  selectedSheetId: string | null = null;

  @property({ type: String })
  activeMapId: string | null = null;

  @property({ attribute: false })
  attributeSchema: AttributeSchema = { preset: "DnD5eCore", rows: [] };

  @property({ attribute: false })
  statusEffectTemplates: Readonly<Record<string, StatusEffectTemplate>> = {};

  @property({ attribute: false })
  customTemplates: Readonly<Record<string, CustomTemplate | NamedTemplate>> = {};

  @property({ attribute: false })
  settings: DndMapperSettings = createDefaultDndMapperState().settings;

  @property({ type: Boolean })
  isDm = false;

  @property({ type: String })
  currentUserId: string | null = null;

  @property({ attribute: false })
  roster: readonly { id: string; name: string }[] = [];

  @property({ type: String })
  dmPlayerId: string | null = null;

  @property({ attribute: false })
  maps: readonly (GameMap | MapSummary)[] = [];

  /**
   * True when this instance runs inside a `?view=sheet` popout window.
   * Hides roster selection, destructive/canvas actions (delete, duplicate,
   * place-token), and the popout button itself; the instance never opens
   * nested popouts or a sync channel.
   */
  @property({ type: Boolean })
  isSheetPopout = false;

  // Callbacks
  @property({ attribute: false })
  onSelectSheet?: (sheetId: string | null) => void;

  @property({ attribute: false })
  onCreateSheet?: (characterName?: string, scopedMapId?: string | null) => void;

  @property({ attribute: false })
  onUpdateSheet?: (sheetId: string, patch: SheetPatch) => void;

  @property({ attribute: false })
  onAssignSheetOwner?: (sheetId: string, ownerUserId: string | null) => void;

  @property({ attribute: false })
  onSetSheetHp?: (sheetId: string, hp: number | null) => void;

  @property({ attribute: false })
  onSetSheetMaxHp?: (sheetId: string, maxHp: number | null) => void;

  @property({ attribute: false })
  onSetSheetAc?: (sheetId: string, ac: number | null) => void;

  @property({ attribute: false })
  onDeleteSheet?: (sheetId: string) => void;

  @property({ attribute: false })
  onDuplicateSheet?: (sheetId: string) => void;

  @property({ attribute: false })
  onPlaceToken?: (sheetId: string) => void;

  @property({ attribute: false })
  onUpdateAttributeValues?: (
    sheetId: string,
    values: Readonly<Record<string, AttributeValue>>,
  ) => void;

  @property({ attribute: false })
  onApplyStatusEffect?: (sheetId: string, effect: Omit<StatusEffect, "id" | "appliedUtc">) => void;

  @property({ attribute: false })
  onRemoveStatusEffect?: (sheetId: string, effectId: string) => void;

  @property({ attribute: false })
  onSetSchemaPreset?: (preset: AttributePreset) => void;

  // Local component UI state
  @state() private scopeFilter: "map" | "all" = "map";
  @state() private searchQuery = "";
  @state() private notesTab: NotesTab = "edit";
  @state() private settingsModalOpen = false;
  @state() private schemaModalOpen = false;
  @state() private cascadeWarningOpen = false;
  @state() private pendingPreset: AttributePreset | null = null;
  @state() private prunedAttributes: readonly string[] = [];

  // Notes modal: pinned to the sheet that was open when launched.
  @state() private notesModalOpen = false;
  @state() private notesModalSheetId: string | null = null;
  @state() private notesModalTab: NotesTab = "edit";
  @state() private modalDraftNotes: string | null = null;

  // Whole-sheet popout windows (BroadcastChannel live sync), one per sheet.
  private sheetChannel: BroadcastChannel | null = null;
  private sheetPopouts = new Map<string, Window>();
  private sheetPopoutPoll: number | null = null;

  // Draft inputs for 300ms debouncing
  @state() private draftName: string | null = null;
  @state() private draftNotes: string | null = null;
  @state() private draftValues: Record<string, AttributeValue> | null = null;

  // Click-to-edit number popover (attributes, HP, AC).
  // Single-value popovers (attribute / AC) use popoverDraft;
  // the HP popover edits current + max HP via popoverHpDraft / popoverMaxHpDraft.
  @state() private numberPopover: {
    kind: "attribute" | "hp" | "ac";
    sheetId: string;
    rowName?: string;
    rowType?: "Score" | "Modifier";
    anchorTop: number;
    anchorLeft: number;
  } | null = null;
  @state() private popoverDraft: string | null = null;
  @state() private popoverHpDraft: string | null = null;
  @state() private popoverMaxHpDraft: string | null = null;

  private debounceTimers = new Map<string, number>();

  override connectedCallback(): void {
    super.connectedCallback();
    // Popout instances never open nested popouts — no channel needed.
    if (this.isSheetPopout) return;
    if (typeof BroadcastChannel !== "undefined" && !this.sheetChannel) {
      this.sheetChannel = new BroadcastChannel(SHEET_SYNC_CHANNEL);
      this.sheetChannel.onmessage = (event: MessageEvent) => {
        this.handleSheetChannelMessage(event.data);
      };
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.clearDebounceTimers();
    this.closeAllSheetPopouts(true);
    if (this.sheetChannel) {
      this.sheetChannel.close();
      this.sheetChannel = null;
    }
  }

  private clearDebounceTimers(): void {
    for (const timer of this.debounceTimers.values()) {
      window.clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private debounce(key: string, fn: () => void, ms = 300): void {
    const existing = this.debounceTimers.get(key);
    if (existing) {
      window.clearTimeout(existing);
    }
    const timer = window.setTimeout(() => {
      this.debounceTimers.delete(key);
      fn();
    }, ms);
    this.debounceTimers.set(key, timer);
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has("selectedSheetId")) {
      this.clearDebounceTimers();
      this.draftName = null;
      this.draftNotes = null;
      this.draftValues = null;
      this.closeNumberPopover(false);
    }
  }

  /** Grow the siderail notes editor to fit its content, up to the 80vh
   * CSS cap (beyond that it scrolls internally). Scoped to the rail — the
   * modal editor keeps its own fixed sizing. */
  private autosizeRailNotes(): void {
    const area = this.querySelector(
      ".dndm-sheet-notes-container > .dndm-sheet-notes-textarea",
    ) as HTMLTextAreaElement | null;
    if (!area) return;
    area.style.height = "auto";
    // No layout engine (e.g. happy-dom tests) reports scrollHeight 0 —
    // leave the stylesheet height alone in that case.
    if (area.scrollHeight > 0) {
      area.style.height = `${area.scrollHeight}px`;
    }
  }

  override updated(changedProperties: Map<string, unknown>): void {
    super.updated(changedProperties);
    this.autosizeRailNotes();
    // Live-sync every connected sheet popout after renders.
    if (this.sheetPopouts.size > 0) {
      for (const [sheetId, popout] of [...this.sheetPopouts]) {
        if (popout.closed) {
          this.sheetPopouts.delete(sheetId);
        } else {
          this.pushSheetState(sheetId);
        }
      }
      if (this.sheetPopouts.size === 0 && this.sheetPopoutPoll !== null) {
        window.clearInterval(this.sheetPopoutPoll);
        this.sheetPopoutPoll = null;
      }
    }
  }

  private getEffectiveState(): DndMapperState {
    return {
      phase: "Playing",
      settings: this.settings,
      attributeSchema: this.attributeSchema,
      maps: [],
      activeMapId: this.activeMapId,
      sheets: this.sheets as Record<string, CharacterSheet>,
      customTemplates: this.customTemplates,
      statusEffectTemplates: this.statusEffectTemplates,
      rollLog: [],
      globalRollTemplates: [],
      activeSchemaTemplateId: null,
      initiativeAttributeName: null,
      activeCombat: null,
      pendingCenterRequest: null,
      focusRect: null,
      loadedDiceRules: [],
      hostHeldKeys: [],
      dmPlayerId: this.isDm ? this.currentUserId || "dm-user" : "dm-id",
    };
  }

  private handleSelectSheet(sheetId: string | null): void {
    this.selectedSheetId = sheetId;
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string | null }>("select-sheet", {
        bubbles: true,
        composed: true,
        detail: { sheetId },
      }),
    );
    this.onSelectSheet?.(sheetId);
  }

  private handleCreateSheet(): void {
    const scopedMap = this.scopeFilter === "map" ? this.activeMapId : null;
    this.dispatchEvent(
      new CustomEvent<{ characterName: string; scopedMapId: string | null }>("create-sheet", {
        bubbles: true,
        composed: true,
        detail: { characterName: "New Character", scopedMapId: scopedMap },
      }),
    );
    this.onCreateSheet?.("New Character", scopedMap);
  }

  private handleDuplicateSheet(sheetId: string): void {
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string }>("duplicate-sheet", {
        bubbles: true,
        composed: true,
        detail: { sheetId },
      }),
    );
    this.onDuplicateSheet?.(sheetId);
  }

  private handlePlaceToken(sheetId: string): void {
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string }>("place-token", {
        bubbles: true,
        composed: true,
        detail: { sheetId },
      }),
    );
    this.onPlaceToken?.(sheetId);
  }

  private handleDeleteSheet(sheetId: string): void {
    this.closeSheetPopoutFor(sheetId, true);
    this.settingsModalOpen = false;
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string }>("delete-sheet", {
        bubbles: true,
        composed: true,
        detail: { sheetId },
      }),
    );
    this.onDeleteSheet?.(sheetId);
    if (this.selectedSheetId === sheetId) {
      this.handleSelectSheet(null);
    }
  }

  private handleScopeToggle(sheet: CharacterSheet): void {
    const isGlobal = sheet.scopedMapId === null;
    if (isGlobal && !this.activeMapId) return;
    this.emitUpdateSheet(sheet.id, {
      scopedMapId: isGlobal ? this.activeMapId : null,
    });
  }

  private handleColorInput(sheetId: string, e: Event): void {
    const value = (e.target as HTMLInputElement).value;
    this.emitUpdateSheet(sheetId, { color: value });
  }

  private emitUpdateSheet(sheetId: string, patch: SheetPatch): void {
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string; patch: SheetPatch }>("update-sheet", {
        bubbles: true,
        composed: true,
        detail: { sheetId, patch },
      }),
    );
    this.onUpdateSheet?.(sheetId, patch);
  }

  private emitAssignSheetOwner(sheetId: string, ownerUserId: string | null): void {
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string; ownerUserId: string | null }>("assign-sheet-owner", {
        bubbles: true,
        composed: true,
        detail: { sheetId, ownerUserId },
      }),
    );
    this.onAssignSheetOwner?.(sheetId, ownerUserId);
  }

  private emitUpdateAttributeValues(
    sheetId: string,
    values: Readonly<Record<string, AttributeValue>>,
  ): void {
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string; values: Readonly<Record<string, AttributeValue>> }>(
        "update-attributes",
        {
        bubbles: true,
        composed: true,
        detail: { sheetId, values },
        },
      ),
    );
    this.onUpdateAttributeValues?.(sheetId, values);
  }

  private emitApplyStatusEffect(
    sheetId: string,
    effect: Omit<StatusEffect, "id" | "appliedUtc">,
  ): void {
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string; effect: Omit<StatusEffect, "id" | "appliedUtc"> }>(
        "apply-status-effect",
        {
          bubbles: true,
          composed: true,
          detail: { sheetId, effect },
        },
      ),
    );
    this.onApplyStatusEffect?.(sheetId, effect);
  }

  private emitRemoveStatusEffect(sheetId: string, effectId: string): void {
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string; effectId: string }>("remove-status-effect", {
        bubbles: true,
        composed: true,
        detail: { sheetId, effectId },
      }),
    );
    this.onRemoveStatusEffect?.(sheetId, effectId);
  }

  // ── Debounced inputs ────────────────────────────────────────────────────────
  private onNameInput(sheetId: string, e: Event): void {
    const value = (e.target as HTMLInputElement).value;
    this.draftName = value;
    this.debounce("name", () => {
      this.emitUpdateSheet(sheetId, { characterName: value.trim() || "Unnamed Character" });
    });
  }

  private onNotesInput(sheetId: string, e: Event): void {
    const value = (e.target as HTMLTextAreaElement).value;
    this.applyNotesEdit(sheetId, value);
    // Grow immediately for responsiveness; updated() re-fits after render.
    this.autosizeRailNotes();
  }

  /** Shared notes edit path: rail textarea, notes modal, and popout window. */
  private applyNotesEdit(sheetId: string, value: string, skipPush = false): void {
    if (sheetId === this.selectedSheetId) {
      this.draftNotes = value;
    }
    if (this.notesModalOpen && sheetId === this.notesModalSheetId) {
      this.modalDraftNotes = value;
    }
    this.debounce(`notes_${sheetId}`, () => {
      this.emitUpdateSheet(sheetId, { notes: value });
    });
    // Popup-originated edits skip the instant echo: the popup already holds
    // this text, and updated() pushes the identical state post-render as its
    // acknowledgement. Echoing mid-keystroke invites clobber races.
    if (!skipPush) {
      this.pushSheetState(sheetId);
    }
  }

  /** Flush a pending debounced notes emit (e.g. modal closing mid-debounce). */
  private flushNotesDraft(sheetId: string): void {
    const key = `notes_${sheetId}`;
    const timer = this.debounceTimers.get(key);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    this.debounceTimers.delete(key);
    const sheet = this.sheets[sheetId];
    if (!sheet) return;
    const value =
      sheetId === this.selectedSheetId && this.draftNotes !== null
        ? this.draftNotes
        : this.notesModalOpen && sheetId === this.notesModalSheetId && this.modalDraftNotes !== null
          ? this.modalDraftNotes
          : sheet.notes || "";
    this.emitUpdateSheet(sheetId, { notes: value });
  }

  // ── Notes modal (pinned, live-synced) ─────────────────────────────────────
  private openNotesModal(sheet: CharacterSheet, editable: boolean): void {
    this.notesModalSheetId = sheet.id;
    this.notesModalTab = editable ? this.notesTab : "preview";
    this.modalDraftNotes = null;
    this.notesModalOpen = true;
  }

  private closeNotesModal(): void {
    // Dedupe: the modal can signal dismissal via both the `close` event
    // and the `onClose` callback for a single gesture.
    if (!this.notesModalOpen && this.modalDraftNotes === null) return;
    if (this.notesModalSheetId) {
      this.flushNotesDraft(this.notesModalSheetId);
    }
    this.notesModalOpen = false;
    this.modalDraftNotes = null;
  }

  private onModalNotesInput(sheetId: string, value: string): void {
    this.applyNotesEdit(sheetId, value);
  }

  // ── Connected whole-sheet popout window ───────────────────────────────────
  private resolveNotesValue(sheet: CharacterSheet): string {
    if (sheet.id === this.selectedSheetId && this.draftNotes !== null) {
      return this.draftNotes;
    }
    if (
      this.notesModalOpen &&
      sheet.id === this.notesModalSheetId &&
      this.modalDraftNotes !== null
    ) {
      return this.modalDraftNotes;
    }
    return sheet.notes || "";
  }

  private pushSheetState(sheetId: string): void {
    if (this.isSheetPopout) return;
    if (!this.sheetChannel) return;
    const popout = this.sheetPopouts.get(sheetId);
    if (!popout) return;
    if (popout.closed) {
      this.sheetPopouts.delete(sheetId);
      return;
    }
    const sheet = this.sheets[sheetId];
    if (!sheet) return;
    // Overlay unsent drafts so popups track in-progress typing (debounced
    // emits haven't reached props yet). Mirrors resolveNotesValue().
    const isSelected = sheet.id === this.selectedSheetId;
    // Summaries only — never ship full maps (tokens/images/fog) to popups.
    const maps = this.maps.map((m) => (isFullMap(m) ? toMapSummary(m) : m));
    const msg: SheetStateMessage = {
      type: "sheet-state",
      sheetId: sheet.id,
      sheet: {
        ...sheet,
        characterName: isSelected && this.draftName !== null ? this.draftName : sheet.characterName,
      notes: this.resolveNotesValue(sheet),
        values: isSelected && this.draftValues !== null ? this.draftValues : sheet.values,
      },
      attributeSchema: this.attributeSchema,
      statusEffectTemplates: this.statusEffectTemplates,
      settings: this.settings,
      isDm: this.isDm,
      currentUserId: this.currentUserId,
      roster: this.roster,
      dmPlayerId: this.dmPlayerId,
      maps,
      activeMapId: this.activeMapId,
    };
    this.sheetChannel.postMessage(msg);
  }

  private handleSheetChannelMessage(msg: unknown): void {
    if (this.isSheetPopout) return;
    if (!msg || typeof msg !== "object") return;
    const data = msg as SheetEditMessage | SheetJoinMessage | SheetLeaveMessage;
    if (typeof data.sheetId !== "string") return;
    if (data.type === "sheet-join") {
      this.pushSheetState(data.sheetId);
      return;
    }
    if (data.type === "sheet-leave") {
      this.sheetPopouts.delete(data.sheetId);
      return;
    }
    if (data.type !== "sheet-edit") return;
      const sheet = this.sheets[data.sheetId];
      if (!sheet) return;
      const state = this.getEffectiveState();
      const userId = this.currentUserId ?? (this.isDm ? (state.dmPlayerId ?? "") : "");
      if (!mayEditSheet(state, userId, sheet)) return;
    // HP/AC/notes are private fields: editing them additionally requires
    // the viewer gate, matching the main-window section rendering.
    const canViewPrivate = mayViewSheetNotesAndHp(state, userId, sheet);
    const intent = data.intent;
    switch (intent.kind) {
      case "updateSheet":
        if (intent.patch.notes !== undefined && !canViewPrivate) return;
        this.emitUpdateSheet(data.sheetId, intent.patch);
        break;
      case "assignSheetOwner":
        this.emitAssignSheetOwner(data.sheetId, intent.ownerUserId);
        break;
      case "setSheetHp":
        if (!canViewPrivate) return;
        this.forwardSetHp(data.sheetId, intent.hp);
        break;
      case "setSheetMaxHp":
        if (!canViewPrivate) return;
        this.forwardSetMaxHp(data.sheetId, intent.maxHp);
        break;
      case "setSheetAc":
        if (!canViewPrivate) return;
        this.forwardSetAc(data.sheetId, intent.ac);
        break;
      case "updateAttributeValues":
        this.emitUpdateAttributeValues(data.sheetId, intent.values);
        break;
      case "applyStatusEffect":
        this.emitApplyStatusEffect(data.sheetId, intent.effect);
        break;
      case "removeStatusEffect":
        this.emitRemoveStatusEffect(data.sheetId, intent.effectId);
        break;
      default:
        // Unknown or disallowed intent (delete/duplicate/place-token are
        // main-window-only) — ignore.
        break;
    }
  }

  /** Popup-originated vital forwards: numbers are re-clamped against live state. */
  private forwardSetHp(sheetId: string, hp: number | null): void {
    if (hp === null) {
      this.dispatchEvent(
        new CustomEvent<{ sheetId: string; hp: number | null }>("set-sheet-hp", {
          bubbles: true,
          composed: true,
          detail: { sheetId, hp },
        }),
      );
      this.onSetSheetHp?.(sheetId, hp);
      return;
    }
    const sheet = this.sheets[sheetId];
    if (sheet) this.setHpAbsolute(sheet, hp);
  }

  private forwardSetMaxHp(sheetId: string, maxHp: number | null): void {
    if (maxHp === null) {
      this.dispatchEvent(
        new CustomEvent<{ sheetId: string; maxHp: number | null }>("set-sheet-max-hp", {
          bubbles: true,
          composed: true,
          detail: { sheetId, maxHp },
        }),
      );
      this.onSetSheetMaxHp?.(sheetId, maxHp);
      return;
    }
    const sheet = this.sheets[sheetId];
    if (sheet) this.setMaxHpAbsolute(sheet, maxHp);
  }

  private forwardSetAc(sheetId: string, ac: number | null): void {
    if (ac === null) {
      this.dispatchEvent(
        new CustomEvent<{ sheetId: string; ac: number | null }>("set-sheet-ac", {
          bubbles: true,
          composed: true,
          detail: { sheetId, ac },
        }),
      );
      this.onSetSheetAc?.(sheetId, ac);
      return;
    }
    const sheet = this.sheets[sheetId];
    if (sheet) this.setAcAbsolute(sheet, ac);
  }

  private openSheetPopout(sheet: CharacterSheet): void {
    // One window per sheet: re-clicking focuses the existing window instead
    // of opening a duplicate. Other sheets' windows are left untouched so
    // multiple character sheets can be edited concurrently.
    const existing = this.sheetPopouts.get(sheet.id);
    if (existing && !existing.closed) {
      try {
        existing.focus();
      } catch {
        // Focus is best-effort — the window is still usable without it.
      }
      this.pushSheetState(sheet.id);
      return;
    }
    if (existing) {
      this.sheetPopouts.delete(sheet.id);
    }
    // The popup boots the same bundle at ?view=sheet&sheetId=… and syncs
    // over BroadcastChannel — no second app boot, no extra ticket.
    let popout: Window | null;
    try {
      popout = window.open(buildSheetPopoutUrl(sheet.id), "_blank", "width=1100,height=800");
    } catch {
      popout = null;
    }
    if (!popout) {
      console.warn("[dndm-character-sheet] sheet popout was blocked by the browser");
      toastService.warn(
        "Pop-up blocked — allow pop-ups to open the character sheet in a new window.",
      );
      return;
    }
    this.sheetPopouts.set(sheet.id, popout);
    this.pushSheetState(sheet.id);
    this.ensureSheetPopoutPoll();
  }

  private ensureSheetPopoutPoll(): void {
    if (this.sheetPopoutPoll !== null) return;
    this.sheetPopoutPoll = window.setInterval(() => {
      for (const [sheetId, popout] of [...this.sheetPopouts]) {
        if (popout.closed) {
          this.sheetPopouts.delete(sheetId);
        }
      }
      if (this.sheetPopouts.size === 0 && this.sheetPopoutPoll !== null) {
        window.clearInterval(this.sheetPopoutPoll);
        this.sheetPopoutPoll = null;
      }
    }, 500);
  }

  private closeSheetPopoutFor(sheetId: string, notify: boolean): void {
    const old = this.sheetPopouts.get(sheetId);
    if (!old) return;
    this.sheetPopouts.delete(sheetId);
    if (!old.closed) {
      try {
        old.close();
      } catch {
        // Popup already gone — nothing to clean up.
      }
    }
    if (notify && this.sheetChannel) {
      try {
        this.sheetChannel.postMessage({ type: "sheet-close", sheetId });
      } catch {
        // Channel already torn down — nothing to notify.
      }
    }
    if (this.sheetPopouts.size === 0 && this.sheetPopoutPoll !== null) {
      window.clearInterval(this.sheetPopoutPoll);
      this.sheetPopoutPoll = null;
    }
  }

  private closeAllSheetPopouts(notify: boolean): void {
    if (this.sheetPopoutPoll !== null) {
      window.clearInterval(this.sheetPopoutPoll);
      this.sheetPopoutPoll = null;
    }
    const entries = [...this.sheetPopouts];
    this.sheetPopouts.clear();
    for (const [sheetId, old] of entries) {
      if (!old.closed) {
        try {
          old.close();
        } catch {
          // Popup already gone — nothing to clean up.
        }
      }
      if (notify && this.sheetChannel) {
        try {
          this.sheetChannel.postMessage({ type: "sheet-close", sheetId });
        } catch {
          // Channel already torn down — nothing to notify.
        }
      }
    }
  }

  private onAttributeInput(sheet: CharacterSheet, row: AttributeRow, val: AttributeValue): void {
    const currentValues = this.draftValues ?? { ...sheet.values };
    const nextValues = { ...currentValues, [row.name]: val };
    this.draftValues = nextValues;
    this.debounce(`attr_${row.name}`, () => {
      this.emitUpdateAttributeValues(sheet.id, nextValues);
    });
  }

  // ── Immediate vital adjustments ─────────────────────────────────────────────
  private emitSetHp(sheetId: string, hp: number): void {
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string; hp: number }>("set-sheet-hp", {
        bubbles: true,
        composed: true,
        detail: { sheetId, hp },
      }),
    );
    this.onSetSheetHp?.(sheetId, hp);
  }

  private emitSetMaxHp(sheetId: string, maxHp: number): void {
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string; maxHp: number }>("set-sheet-max-hp", {
        bubbles: true,
        composed: true,
        detail: { sheetId, maxHp },
      }),
    );
    this.onSetSheetMaxHp?.(sheetId, maxHp);
  }

  private emitSetAc(sheetId: string, ac: number): void {
    this.dispatchEvent(
      new CustomEvent<{ sheetId: string; ac: number }>("set-sheet-ac", {
        bubbles: true,
        composed: true,
        detail: { sheetId, ac },
      }),
    );
    this.onSetSheetAc?.(sheetId, ac);
  }

  private setHpAbsolute(sheet: CharacterSheet, raw: number): void {
    if (!Number.isFinite(raw)) return;
    const effectiveMax = resolveEffectiveMaxHp(sheet);
    let nextHp = Math.round(raw);
    if (effectiveMax !== null) {
      nextHp = Math.min(nextHp, effectiveMax);
    }
    nextHp = Math.max(0, nextHp);
    this.emitSetHp(sheet.id, nextHp);
  }

  private setMaxHpAbsolute(sheet: CharacterSheet, raw: number): void {
    if (!Number.isFinite(raw)) return;
    const nextMax = Math.max(0, Math.round(raw));
    this.emitSetMaxHp(sheet.id, nextMax);
  }

  private setAcAbsolute(sheet: CharacterSheet, raw: number): void {
    if (!Number.isFinite(raw)) return;
    this.emitSetAc(sheet.id, Math.max(0, Math.round(raw)));
  }

  // ── Number popover (click-to-edit for attributes, HP, AC) ───────────────────
  private openNumberPopover(
    kind: "attribute" | "hp" | "ac",
    sheetId: string,
    anchor: HTMLElement,
    extra?: { rowName?: string; rowType?: "Score" | "Modifier" },
  ): void {
    const rect = anchor.getBoundingClientRect();
    const popoverWidth = 240;
    const estimatedHeight = kind === "hp" ? 190 : 140;
    let left = rect.left;
    if (typeof window !== "undefined") {
      left = Math.max(8, Math.min(rect.left, window.innerWidth - popoverWidth - 8));
    }
    let top = rect.bottom + 6;
    if (typeof window !== "undefined" && top + estimatedHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - estimatedHeight - 6);
    }
    this.numberPopover = {
      kind,
      sheetId,
      rowName: extra?.rowName,
      rowType: extra?.rowType,
      anchorTop: top,
      anchorLeft: left,
    };
    this.popoverDraft = null;
    this.popoverHpDraft = null;
    this.popoverMaxHpDraft = null;
  }

  private commitPopoverDrafts(sheet: CharacterSheet): void {
    const pop = this.numberPopover;
    if (!pop || pop.sheetId !== sheet.id) return;
    if (pop.kind === "attribute" && pop.rowName && pop.rowType) {
      if (this.popoverDraft !== null) {
        const n = parseInt(this.popoverDraft, 10);
        if (!isNaN(n)) {
          const row: AttributeRow = {
            name: pop.rowName,
            type: pop.rowType,
            default:
              pop.rowType === "Score"
                ? { kind: "Score", value: 10 }
                : { kind: "Modifier", value: 0 },
          };
          const fallback = pop.rowType === "Score" ? 10 : 0;
          this.onAttributeInput(sheet, row, {
            kind: pop.rowType,
            value: isNaN(n) ? fallback : n,
          } as AttributeValue);
        }
      }
    } else if (pop.kind === "ac") {
      if (this.popoverDraft !== null) {
        const n = parseInt(this.popoverDraft, 10);
        if (!isNaN(n)) this.setAcAbsolute(sheet, n);
      }
    } else if (pop.kind === "hp") {
      if (this.popoverMaxHpDraft !== null) {
        const n = parseInt(this.popoverMaxHpDraft, 10);
        if (!isNaN(n)) this.setMaxHpAbsolute(sheet, n);
      }
      if (this.popoverHpDraft !== null) {
        const n = parseInt(this.popoverHpDraft, 10);
        if (!isNaN(n)) this.setHpAbsolute(sheet, n);
      }
    }
  }

  private closeNumberPopover(commit: boolean): void {
    if (commit && this.numberPopover) {
      const sheet = this.sheets[this.numberPopover.sheetId];
      if (sheet) this.commitPopoverDrafts(sheet);
    }
    if (this.numberPopover !== null || this.popoverDraft !== null) {
      this.numberPopover = null;
      this.popoverDraft = null;
      this.popoverHpDraft = null;
      this.popoverMaxHpDraft = null;
    }
  }

  private stepPopoverValue(sheet: CharacterSheet, delta: number): void {
    const pop = this.numberPopover;
    if (!pop) return;
    if (pop.kind === "attribute" && pop.rowName && pop.rowType) {
      const values = this.draftValues ?? sheet.values;
      const current = values[pop.rowName];
      const base =
        current && current.kind === pop.rowType
          ? (current.value as number)
          : pop.rowType === "Score"
            ? 10
            : 0;
      const draftNum = this.popoverDraft !== null ? parseInt(this.popoverDraft, 10) : base;
      const next = (isNaN(draftNum) ? base : draftNum) + delta;
      this.popoverDraft = String(next);
      const row: AttributeRow = {
        name: pop.rowName,
        type: pop.rowType,
        default:
          pop.rowType === "Score" ? { kind: "Score", value: 10 } : { kind: "Modifier", value: 0 },
      };
      this.onAttributeInput(sheet, row, {
        kind: pop.rowType,
        value: next,
      } as AttributeValue);
    } else if (pop.kind === "ac") {
      const base = sheet.armorClass ?? 10;
      const draftNum = this.popoverDraft !== null ? parseInt(this.popoverDraft, 10) : base;
      const next = Math.max(0, (isNaN(draftNum) ? base : draftNum) + delta);
      this.popoverDraft = String(next);
      this.setAcAbsolute(sheet, next);
    } else if (pop.kind === "hp") {
      // HP popover has separate steppers per field; this helper is unused.
    }
  }

  // ── Preset switching with cascade prune warning ────────────────────────────
  private handleSelectPreset(preset: AttributePreset): void {
    this.schemaModalOpen = false;
    const newSchema = createDefaultAttributeSchema(preset);
    const currentRowNames = new Set(this.attributeSchema.rows.map((r) => r.name));
    const newRowNames = new Set(newSchema.rows.map((r) => r.name));

    const pruned: string[] = [];
    for (const name of currentRowNames) {
      if (!newRowNames.has(name)) {
        const hasData = Object.values(this.sheets).some((s) => {
          const v = s.values[name];
          if (!v) return false;
          if (v.kind === "Score" && v.value !== 10) return true;
          if (v.kind === "Modifier" && v.value !== 0) return true;
          if (v.kind === "Text" && v.value.trim().length > 0) return true;
          return false;
        });
        if (hasData) pruned.push(name);
      }
    }

    if (pruned.length > 0) {
      this.pendingPreset = preset;
      this.prunedAttributes = pruned;
      this.cascadeWarningOpen = true;
    } else {
      this.applyPreset(preset);
    }
  }

  private applyPreset(preset: AttributePreset): void {
    this.dispatchEvent(
      new CustomEvent<{ preset: AttributePreset }>("set-schema-preset", {
        bubbles: true,
        composed: true,
        detail: { preset },
      }),
    );
    this.onSetSchemaPreset?.(preset);
    this.pendingPreset = null;
    this.prunedAttributes = [];
  }

  override render(): TemplateResult {
    const state = this.getEffectiveState();
    const userId = this.currentUserId ?? (this.isDm ? (state.dmPlayerId ?? "") : "");

    // Sheet visibility is owned by host projection (`projectForPlayer`):
    // guests only ever receive sheets they may view, so the roster lists
    // everything it is given. Private-field redaction below stays: the DM
    // renders the full truth here.
    const visibleSheets = Object.values(this.sheets);

    // Filter by scope and search
    const filteredSheets = visibleSheets.filter((s) => {
      if (this.scopeFilter === "map" && this.activeMapId) {
        if (s.scopedMapId !== null && s.scopedMapId !== this.activeMapId) {
          return false;
        }
      }
      if (this.searchQuery) {
        return s.characterName.toLowerCase().includes(this.searchQuery.toLowerCase());
      }
      return true;
    });

    const activeSheet = this.selectedSheetId ? this.sheets[this.selectedSheetId] : null;
    // The open sheet must stay a member of the roster list: a sheet filtered
    // out by scope or search is not shown open (the selection id is retained,
    // so it reopens when the filter changes back). Popouts are pinned to one
    // sheet, so scope/search filtering is bypassed there. (Visibility itself
    // is host-projected, so no mayViewSheet gate runs here.)
    const pool = this.isSheetPopout ? visibleSheets : filteredSheets;
    const selectedSheet =
      activeSheet && pool.some((s) => s.id === activeSheet.id) ? activeSheet : null;

    const details = selectedSheet
      ? this.renderSheetDetails(selectedSheet, state, userId)
      : html`
          <div
            class="dndm-sheet-empty"
            style="padding: 20px; text-align: center; color: var(--dndm-text-muted); font-size: 0.9rem;"
          >
            Select or create a character sheet to view details.
          </div>
        `;

    // Popouts are a dedicated window, not a rail section: no collapsible
    // panel chrome, no roster — the responsive grid panel plus overlays.
    if (this.isSheetPopout) {
      return html`
        <div class="dndm-sheet-panel dndm-sheet-panel--popout">${details}</div>
        ${this.renderOverlays(selectedSheet)} ${this.renderNumberPopover()}
      `;
    }

    return html`
      <dndm-collapsible-panel
        panelTitle="Character Sheet"
        panelClass="dndm-character-sheet-panel"
        .onToggleCollapse=${() => {
          // Collapsing with the number popover open would orphan it over the
          // rail; commit any typed value like a backdrop click does.
          if (this.numberPopover) this.closeNumberPopover(true);
        }}
        .content=${html`
          <div class="dndm-sheet-panel">
            ${
              this.isSheetPopout
                ? nothing
                : html`
            <!-- Roster / Selector Header -->
        <div class="dndm-sheet-roster">
          <div class="dndm-sheet-roster-controls">
            <button
              class="dndm-btn dndm-btn--subtle"
              style="padding: 2px 6px; font-size: 0.75rem;"
              @click=${() => {
                this.scopeFilter = this.scopeFilter === "map" ? "all" : "map";
              }}
            >
              ${this.scopeFilter === "map" ? "Map" : "All"}
            </button>
                        <div
                          style="display: flex; align-items: center; gap: 4px; margin-left: auto;"
                        >
                          ${
                this.isDm || this.settings.playersCanCreateNPCs
                ? html`
                    <button
                      class="dndm-btn dndm-btn--primary"
                      title="New character sheet"
                      style="padding: 2px 8px; font-size: 0.75rem; min-width: 28px;"
                      @click=${() => this.handleCreateSheet()}
                    >
                      +
                    </button>
                  `
                  : nothing
              }
                          ${
                this.isDm
                ? html`
                    <button
                      class="dndm-btn dndm-btn--subtle"
                      title="Attribute Schema Presets"
                      style="padding: 2px 6px; font-size: 0.75rem;"
                      @click=${() => {
                        this.schemaModalOpen = true;
                      }}
                    >
                      Schema
                    </button>
                  `
                  : nothing
              }
            </div>
          </div>
          <div class="dndm-sheet-search-row">
            <input
              type="text"
              class="dndm-sheet-search"
              placeholder="Search sheets..."
              .value=${this.searchQuery}
              @input=${(e: Event) => {
                this.searchQuery = (e.target as HTMLInputElement).value;
              }}
            />
          </div>

          <!-- Sheet Chips -->
          <div class="dndm-sheet-chips">
            ${filteredSheets.map((s) => {
              const isActive = selectedSheet?.id === s.id;
              return html`
                <div
                  class="dndm-sheet-chip ${isActive ? "dndm-sheet-chip--active" : ""}"
                  @click=${() => this.handleSelectSheet(s.id)}
                >
                  <span
                    class="dndm-sheet-color-dot"
                    style="background-color: ${s.color || "#4a90e2"}; width: 10px; height: 10px;"
                  ></span>
                  <span>${s.characterName}</span>
                </div>
              `;
            })}
          </div>
        </div>
                  `
            }

        <!-- Selected Character Sheet Body -->
            ${details}
          </div>
        `}
      ></dndm-collapsible-panel>
      ${this.renderOverlays(selectedSheet)} ${this.renderNumberPopover()}
    `;
  }

  /** Settings / schema / notes modals shared by the rail panel and popouts. */
  private renderOverlays(selectedSheet: CharacterSheet | null): TemplateResult {
    return html`
      <dndm-sheet-settings-modal
        .isOpen=${this.settingsModalOpen}
        .sheet=${selectedSheet}
        .roster=${this.roster}
        .dmPlayerId=${this.dmPlayerId}
        .maps=${this.maps}
        .isDm=${this.isDm}
        .activeMapId=${this.activeMapId}
        .hideDestructiveActions=${this.isSheetPopout}
        @place-token=${(e: CustomEvent<{ sheetId: string }>) => {
          this.handlePlaceToken(e.detail.sheetId);
        }}
        @duplicate-sheet=${(e: CustomEvent<{ sheetId: string }>) => {
          this.handleDuplicateSheet(e.detail.sheetId);
        }}
        @save=${(e: CustomEvent<SheetSettingsPatch>) => {
          if (selectedSheet) {
            const { characterName, color, scopedMapId, ownerUserId } = e.detail;
            this.emitUpdateSheet(selectedSheet.id, { characterName, color, scopedMapId });
            if (ownerUserId !== undefined && ownerUserId !== selectedSheet.ownerUserId) {
              this.emitAssignSheetOwner(selectedSheet.id, ownerUserId);
            }
          }
          this.settingsModalOpen = false;
        }}
        @delete=${(e: CustomEvent<{ sheetId: string }>) => {
          this.handleDeleteSheet(e.detail.sheetId);
        }}
        @cancel=${() => {
          this.settingsModalOpen = false;
        }}
        @close=${() => {
          this.settingsModalOpen = false;
        }}
        .onCancel=${() => {
          this.settingsModalOpen = false;
        }}
        .onClose=${() => {
          this.settingsModalOpen = false;
        }}
      ></dndm-sheet-settings-modal>

      <dndm-schema-preset-modal
        .isOpen=${this.schemaModalOpen}
        .currentPreset=${this.attributeSchema.preset}
        @select-preset=${(e: CustomEvent<{ preset: AttributePreset }>) => {
          this.handleSelectPreset(e.detail.preset);
        }}
        @cancel=${() => {
          this.schemaModalOpen = false;
        }}
        @close=${() => {
          this.schemaModalOpen = false;
        }}
        .onCancel=${() => {
          this.schemaModalOpen = false;
        }}
        .onClose=${() => {
          this.schemaModalOpen = false;
        }}
      ></dndm-schema-preset-modal>

      <dndm-schema-cascade-warning
        .isOpen=${this.cascadeWarningOpen}
        .prunedAttributes=${this.prunedAttributes}
        @confirm=${() => {
          this.cascadeWarningOpen = false;
          if (this.pendingPreset) {
            this.applyPreset(this.pendingPreset);
          }
        }}
        @cancel=${() => {
          this.cascadeWarningOpen = false;
          this.pendingPreset = null;
        }}
        @close=${() => {
          this.cascadeWarningOpen = false;
          this.pendingPreset = null;
        }}
        .onCancel=${() => {
          this.cascadeWarningOpen = false;
          this.pendingPreset = null;
        }}
        .onClose=${() => {
          this.cascadeWarningOpen = false;
          this.pendingPreset = null;
        }}
      ></dndm-schema-cascade-warning>

      ${(() => {
        const modalSheet = this.notesModalSheetId
          ? (this.sheets[this.notesModalSheetId] ?? null)
          : null;
        if (!modalSheet) return nothing;
        const modalState = this.getEffectiveState();
        const modalUserId = this.currentUserId ?? (this.isDm ? (modalState.dmPlayerId ?? "") : "");
        const modalEditable = mayEditSheet(modalState, modalUserId, modalSheet);
        const modalNotesValue =
          this.modalDraftNotes !== null
            ? this.modalDraftNotes
            : modalSheet.id === this.selectedSheetId && this.draftNotes !== null
              ? this.draftNotes
              : modalSheet.notes || "";
        return html`
          <dndm-notes-modal
            .isOpen=${this.notesModalOpen}
            .sheetName=${modalSheet.characterName}
            .notesValue=${modalNotesValue}
            .editable=${modalEditable}
            .activeTab=${modalEditable ? this.notesModalTab : "preview"}
            .onTabChange=${(tab: NotesTab) => {
              this.notesModalTab = tab;
            }}
            .onNotesInput=${(value: string) => {
              this.onModalNotesInput(modalSheet.id, value);
            }}
            .onClose=${() => {
              this.closeNotesModal();
            }}
            @tab-change=${(e: CustomEvent<{ tab: NotesTab }>) => {
              this.notesModalTab = e.detail.tab;
            }}
            @notes-input=${(e: CustomEvent<{ value: string }>) => {
              this.onModalNotesInput(modalSheet.id, e.detail.value);
            }}
            @close=${() => {
              this.closeNotesModal();
            }}
          ></dndm-notes-modal>
        `;
      })()}
    `;
  }

  private renderNumberPopover(): TemplateResult | typeof nothing {
    const pop = this.numberPopover;
    if (!pop) return nothing;
    const sheet = this.sheets[pop.sheetId];
    if (!sheet) return nothing;

    const closeAndCommit = () => this.closeNumberPopover(true);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.closeNumberPopover(false);
      } else if (e.key === "Enter") {
        e.stopPropagation();
        this.closeNumberPopover(true);
      }
    };

    // Note: the chevron is a static `svg` template (not nested `html`
    // fragments) so the <path> lands in the SVG namespace. Bare <path>
    // fragments stamped via `html` end up in the XHTML namespace and
    // render as nothing. The "up" variant is the same icon rotated 180°.
    const chevronIcon = svg`
      <svg
        viewBox="0 0 16 16"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 6l5 5 5-5" />
      </svg>
    `;

    const stepButton = (dir: -1 | 1, titlePrefix: string, onStep: (delta: number) => void) => html`
      <button
        class="dndm-number-popover-step${dir === 1 ? " dndm-number-popover-step--up" : ""}"
        title=${dir === 1 ? `Increase ${titlePrefix}` : `Decrease ${titlePrefix}`}
        aria-label=${dir === 1 ? `Increase ${titlePrefix}` : `Decrease ${titlePrefix}`}
        @click=${() => onStep(dir)}
      >
        ${chevronIcon}
      </button>
    `;

    const numberField = (
      label: string,
      inputValue: string,
      onDraft: (v: string) => void,
      onCommit: () => void,
    ) => html`
      <input
        type="number"
        class="dndm-number-popover-input"
        .value=${inputValue}
        aria-label=${label}
        @input=${(e: Event) => {
          onDraft((e.target as HTMLInputElement).value);
        }}
        @change=${() => onCommit()}
        @keydown=${handleKey}
      />
    `;

    // Single value, centered hero stepper: [down] [ big number ] [up].
    const heroStepper = (
      label: string,
      inputValue: string,
      onDraft: (v: string) => void,
      onStep: (delta: number) => void,
      onCommit: () => void,
      titlePrefix: string,
    ) => html`
      <div class="dndm-number-popover-hero">
        ${stepButton(-1, titlePrefix, onStep)} ${numberField(label, inputValue, onDraft, onCommit)}
        ${stepButton(1, titlePrefix, onStep)}
      </div>
    `;

    // Compact labeled row for the HP popover: label left, stepper right.
    const compactRow = (
      label: string,
      inputValue: string,
      onDraft: (v: string) => void,
      onStep: (delta: number) => void,
      onCommit: () => void,
      titlePrefix: string,
    ) => html`
      <div class="dndm-number-popover-row">
        <span class="dndm-number-popover-label">${label}</span>
        <div class="dndm-number-popover-stepper">
          ${stepButton(-1, titlePrefix, onStep)}
          ${numberField(label, inputValue, onDraft, onCommit)} ${stepButton(1, titlePrefix, onStep)}
        </div>
      </div>
    `;
    let title = "Edit value";
    let body: TemplateResult = html``;
    if (pop.kind === "attribute" && pop.rowName && pop.rowType) {
      title = `Edit ${pop.rowName}`;
      const values = this.draftValues ?? sheet.values;
      const current = values[pop.rowName];
      const base =
        current && current.kind === pop.rowType
          ? String(current.value as number)
          : pop.rowType === "Score"
            ? "10"
            : "0";
      const inputValue = this.popoverDraft ?? base;
      body = heroStepper(
        pop.rowName,
        inputValue,
        (v) => {
          this.popoverDraft = v;
        },
        (d) => this.stepPopoverValue(sheet, d),
        () => {
          this.commitPopoverDrafts(sheet);
          this.popoverDraft = null;
        },
        pop.rowName,
      );
    } else if (pop.kind === "ac") {
      title = "Edit Armor Class";
      const base = String(sheet.armorClass ?? 10);
      const inputValue = this.popoverDraft ?? base;
      body = heroStepper(
        "AC",
        inputValue,
        (v) => {
          this.popoverDraft = v;
        },
        (d) => this.stepPopoverValue(sheet, d),
        () => {
          this.commitPopoverDrafts(sheet);
          this.popoverDraft = null;
        },
        "Armor Class",
      );
    } else if (pop.kind === "hp") {
      title = "Edit Hit Points";
      const hpInput = this.popoverHpDraft ?? String(sheet.hp ?? 0);
      const maxInput = this.popoverMaxHpDraft ?? (sheet.maxHp !== null ? String(sheet.maxHp) : "");
      const stepHp = (delta: number) => {
        const draftNum =
          this.popoverHpDraft !== null ? parseInt(this.popoverHpDraft, 10) : (sheet.hp ?? 0);
        const baseNum = isNaN(draftNum) ? (sheet.hp ?? 0) : draftNum;
        let next = Math.max(0, baseNum + delta);
        const effectiveMax = resolveEffectiveMaxHp(sheet);
        if (effectiveMax !== null) next = Math.min(next, effectiveMax);
        this.popoverHpDraft = String(next);
        this.setHpAbsolute(sheet, next);
      };
      const stepMaxHp = (delta: number) => {
        const draftNum =
          this.popoverMaxHpDraft !== null && this.popoverMaxHpDraft !== ""
            ? parseInt(this.popoverMaxHpDraft, 10)
            : (sheet.maxHp ?? 0);
        const baseNum = isNaN(draftNum) ? (sheet.maxHp ?? 0) : draftNum;
        const next = Math.max(0, baseNum + delta);
        this.popoverMaxHpDraft = String(next);
        this.setMaxHpAbsolute(sheet, next);
      };
      body = html`
        ${compactRow(
          "Current",
          hpInput,
          (v) => {
            this.popoverHpDraft = v;
          },
          stepHp,
          () => {
            this.commitPopoverDrafts(sheet);
            this.popoverHpDraft = null;
            this.popoverMaxHpDraft = null;
          },
          "HP",
        )}
        ${compactRow(
          "Max",
          maxInput,
          (v) => {
            this.popoverMaxHpDraft = v;
          },
          stepMaxHp,
          () => {
            this.commitPopoverDrafts(sheet);
            this.popoverHpDraft = null;
            this.popoverMaxHpDraft = null;
          },
          "max HP",
        )}
        <div class="dndm-number-popover-hint">Effective max includes status effects.</div>
      `;
    }

    return html`
      <div
        class="dndm-number-popover-backdrop"
        @click=${closeAndCommit}
        @keydown=${handleKey}
      ></div>
      <div
        class="dndm-number-popover"
        role="dialog"
        aria-label=${title}
        style="top: ${pop.anchorTop}px; left: ${pop.anchorLeft}px;"
        @click=${(e: Event) => e.stopPropagation()}
      >
        <div class="dndm-number-popover-header">
          <span class="dndm-number-popover-title">${title}</span>
          <button
            class="dndm-number-popover-close"
            title="Close"
            aria-label="Close"
            @click=${closeAndCommit}
          >
            ✕
          </button>
        </div>
        ${body}
      </div>
    `;
  }

  private renderSheetDetails(
    sheet: CharacterSheet,
    state: DndMapperState,
    userId: string,
  ): TemplateResult {
    const editable = mayEditSheet(state, userId, sheet);
    const canViewNotesAndHp = mayViewSheetNotesAndHp(state, userId, sheet);

    const effectiveMaxHp = resolveEffectiveMaxHp(sheet);
    const currentHp = sheet.hp ?? 0;
    const hpPercent =
      effectiveMaxHp !== null && effectiveMaxHp > 0
      ? Math.max(0, Math.min(100, Math.round((currentHp / effectiveMaxHp) * 100)))
      : 0;

    const isBloodied =
      effectiveMaxHp !== null && currentHp > 0 && currentHp <= Math.floor(effectiveMaxHp / 2);
    const isDead = effectiveMaxHp !== null && currentHp === 0;

    const abilityRows = this.attributeSchema.rows.filter(isAbilityRow);
    const otherRows = this.attributeSchema.rows.filter((r) => !isAbilityRow(r));

    const nameValue = this.draftName !== null ? this.draftName : sheet.characterName;
    const notesValue = this.draftNotes !== null ? this.draftNotes : sheet.notes || "";
    const isGlobal = sheet.scopedMapId === null;
    const sheetColor = sheet.color || "#4a90e2";

    const titleBar = html`
      <!-- Title Bar: color indicator + name on its own line -->
      <div class="dndm-sheet-header-title-bar">
        ${
          editable
          ? html`
              <label
                class="dndm-sheet-color-dot dndm-sheet-color-dot--editable"
                style="background-color: ${sheetColor};"
                title="Sheet color"
              >
                <span class="dndm-sheet-color-dot-sr">Sheet color</span>
                <input
                  type="color"
                  class="dndm-sheet-color-input"
                  .value=${sheetColor}
                  aria-label="Sheet color"
                  @input=${(e: Event) => this.handleColorInput(sheet.id, e)}
                />
              </label>
            `
          : html`
              <span
                class="dndm-sheet-color-dot"
                style="background-color: ${sheetColor};"
                title="Sheet color"
                aria-label="Sheet color"
              ></span>
              `
        }
        <input
          type="text"
          class="dndm-sheet-name-input"
          .value=${nameValue}
          ?disabled=${!editable}
          aria-label="Character name"
          @input=${(e: Event) => this.onNameInput(sheet.id, e)}
        />
      </div>
    `;

    const headerActions = html`
      <!-- Header action row: settings, add token, copy, scope toggle -->
      <div class="dndm-sheet-header-actions">
        <button
          class="dndm-btn dndm-btn--subtle dndm-btn--icon"
          type="button"
          title="Sheet settings — rename, recolor, assign owner, change map scope, or delete"
          aria-label="Sheet Settings"
          @click=${() => {
            this.settingsModalOpen = true;
          }}
        >
          ${gearIcon()}
        </button>
        ${
          this.isSheetPopout
            ? nothing
            : html`
        <button
          class="dndm-btn dndm-btn--subtle dndm-btn--icon"
          type="button"
                  title=${
                  this.activeMapId
            ? "Place a token for this character on the active map"
                    : "Open a map to place a token for this character"
                }
          aria-label="Place token"
          ?disabled=${!this.activeMapId}
          @click=${() => this.handlePlaceToken(sheet.id)}
        >
          ${tokenPlusIcon()}
        </button>
        <button
          class="dndm-btn dndm-btn--subtle dndm-btn--icon"
          type="button"
          title="Duplicate this sheet — creates an independent copy"
          aria-label="Duplicate sheet"
          @click=${() => this.handleDuplicateSheet(sheet.id)}
        >
          ${copyIcon()}
        </button>
              `
        }
        ${
          this.isSheetPopout
            ? nothing
            : html`
                <button
                  class="dndm-btn dndm-btn--subtle dndm-btn--icon"
                  type="button"
                  title="Open this sheet in a new window"
                  aria-label="Open sheet in new window"
                  @click=${() => this.openSheetPopout(sheet)}
                >
                  ${popoutIcon()}
                </button>
              `
        }
        ${
          this.isDm
          ? html`
              <button
                class="dndm-btn dndm-btn--subtle dndm-sheet-scope-toggle"
                type="button"
                  title=${
                  isGlobal
                  ? "Global sheet — listed on every map. Click to restrict to the active map."
                    : "Map-only sheet — listed on its map's roster. Click to share across all maps."
                }
                aria-label=${isGlobal ? "Switch sheet to map-only" : "Switch sheet to global"}
                aria-pressed=${isGlobal ? "false" : "true"}
                ?disabled=${isGlobal && !this.activeMapId}
                @click=${() => this.handleScopeToggle(sheet)}
              >
                ${isGlobal ? "Global" : "Map"}
              </button>
            `
            : nothing
        }
      </div>
    `;

    const provenance = html`
      ${
        sheet.representsUserId
        ? html`
            <div
              class="dndm-sheet-provenance"
              style="font-size: 0.78rem; color: var(--dndm-text-muted); font-style: italic; margin: -2px 0 6px 4px;"
            >
                (originally played by
                ${this.roster.find((p) => p.id === sheet.representsUserId)?.name ?? sheet.representsUserId})
            </div>
          `
          : nothing
      }
    `;

    const vitals = html`
      <!-- Vitals (HP & AC) -->
      ${
        canViewNotesAndHp
        ? html`
            <div class="dndm-sheet-vitals">
              <!-- HP Bar (click to edit HP / max HP) -->
                ${
                editable
                ? html`
                    <button
                      class="dndm-sheet-hp-bar dndm-sheet-hp-bar--clickable"
                      title="Edit HP"
                      @click=${(e: Event) => {
                        this.openNumberPopover("hp", sheet.id, e.currentTarget as HTMLElement);
                      }}
                    >
                      <div
                        class="dndm-sheet-hp-fill ${isDead ? "dndm-sheet-hp-fill--dead" : isBloodied ? "dndm-sheet-hp-fill--bloodied" : ""}"
                        style="width: ${hpPercent}%;"
                      ></div>
                      <div class="dndm-sheet-hp-text">
                          ${
                          sheet.hp != null && effectiveMaxHp != null
                          ? `${currentHp} / ${effectiveMaxHp} HP`
                            : "HP Not Set"
                        }
                        ${isDead ? " (Dead)" : isBloodied ? " (Bloodied)" : ""}
                      </div>
                    </button>
                  `
                : html`
                    <div class="dndm-sheet-hp-bar">
                      <div
                        class="dndm-sheet-hp-fill ${isDead ? "dndm-sheet-hp-fill--dead" : isBloodied ? "dndm-sheet-hp-fill--bloodied" : ""}"
                        style="width: ${hpPercent}%;"
                      ></div>
                      <div class="dndm-sheet-hp-text">
                          ${
                          sheet.hp != null && effectiveMaxHp != null
                          ? `${currentHp} / ${effectiveMaxHp} HP`
                            : "HP Not Set"
                        }
                        ${isDead ? " (Dead)" : isBloodied ? " (Bloodied)" : ""}
                      </div>
                    </div>
                    `
              }

              <!-- Controls Row -->
              <div class="dndm-sheet-vitals-row">
                <!-- HP Value -->
                <div class="dndm-sheet-stat-box">
                  <span style="font-size: 0.75rem; font-weight: bold;">HP:</span>
                    ${
                    editable
                    ? html`
                        <button
                          class="dndm-sheet-value-btn"
                          title="Edit HP"
                          @click=${(e: Event) => {
                            this.openNumberPopover("hp", sheet.id, e.currentTarget as HTMLElement);
                          }}
                        >
                          ${currentHp} / ${effectiveMaxHp ?? "—"}
                        </button>
                      `
                      : html`<span style="font-size: 0.85rem;"
                          >${currentHp} / ${effectiveMaxHp ?? "—"}</span
                        >`
                  }
                </div>

                <!-- AC Value -->
                <div class="dndm-sheet-stat-box">
                  <span style="font-size: 0.75rem; font-weight: bold;">AC:</span>
                    ${
                    editable
                    ? html`
                        <button
                          class="dndm-sheet-value-btn dndm-sheet-value-btn--ac"
                          title="Edit Armor Class"
                          @click=${(e: Event) => {
                            this.openNumberPopover("ac", sheet.id, e.currentTarget as HTMLElement);
                          }}
                        >
                          ${sheet.armorClass ?? 10}
                        </button>
                      `
                    : html`<span style="font-size: 1rem; font-weight: bold; margin-right: 4px;">
                        ${sheet.armorClass ?? 10}
                        </span>`
                  }
                </div>
              </div>
            </div>
          `
          : nothing
      }
    `;

    const scores = html`
      <!-- Ability Scores Grid -->
      ${
        abilityRows.length > 0
        ? html`
            <div class="dndm-sheet-scores-grid">
              ${abilityRows.map((row) => {
                const values = this.draftValues ?? sheet.values;
                const attrVal = values[row.name] ?? row.default;
                const contribution = resolveAttributeContribution(sheet, row.name, attrVal);
                const rawNum = attrVal.kind === "Score" ? attrVal.value : 10;
                const effectiveNum =
                  contribution.effectiveValue.kind === "Score"
                    ? contribution.effectiveValue.value
                    : 10;
                const mod = contribution.effectiveModifier;
                const modStr = mod >= 0 ? `+${mod}` : `${mod}`;

                return html`
                  <div class="dndm-score-card">
                    <span class="dndm-score-label" title=${row.name}
                      >${shortAbilityName(row.name)}</span
                    >
                    ${
                      editable
                      ? html`
                          <button
                            class="dndm-sheet-value-btn dndm-sheet-value-btn--score"
                            title="Edit ${row.name}"
                            @click=${(e: Event) => {
                              this.openNumberPopover(
                                "attribute",
                                sheet.id,
                                e.currentTarget as HTMLElement,
                                {
                                rowName: row.name,
                                rowType: "Score",
                                },
                              );
                            }}
                          >
                            ${rawNum}
                          </button>
                        `
                        : html`<span class="dndm-score-value">${effectiveNum}</span>`
                    }
                    <span class="dndm-score-modifier">${modStr}</span>
                  </div>
                `;
              })}
            </div>
          `
          : nothing
      }
    `;

    const attrsSection = html`
      <!-- Other Attributes / Skills -->
      ${
        otherRows.length > 0
        ? html`
            <div class="dndm-sheet-attrs-section">
              <span class="dndm-sheet-section-title">Attributes &amp; Skills</span>
              <div class="dndm-sheet-attrs-table">
                ${otherRows.map((row) => {
                  const values = this.draftValues ?? sheet.values;
                  const val = values[row.name] ?? row.default;

                  return html`
                    <div class="dndm-sheet-attr-row">
                      <span title=${row.name}>${row.name}</span>
                      ${this.renderAttributeValueEditor(sheet, row, val, editable)}
                    </div>
                  `;
                })}
              </div>
            </div>
          `
          : nothing
      }
    `;

    const statusEffects = html`
      <!-- Status Effects Section -->
      <dndm-status-effects
        .sheet=${sheet}
        .editable=${editable}
        .customTemplates=${Object.values(this.statusEffectTemplates)}
        @apply-effect=${(e: CustomEvent<{ effect: Omit<StatusEffect, "id" | "appliedUtc"> }>) => {
          this.emitApplyStatusEffect(sheet.id, e.detail.effect);
        }}
        @remove-effect=${(e: CustomEvent<{ effectId: string }>) => {
          this.emitRemoveStatusEffect(sheet.id, e.detail.effectId);
        }}
      ></dndm-status-effects>
    `;

    const notesSection = html`
      <!-- Notes Section -->
      ${
        canViewNotesAndHp
        ? (() => {
            const effectiveNotesTab: NotesTab = editable ? this.notesTab : "preview";
            const showingEdit = effectiveNotesTab === "edit";
            return html`
              <div class="dndm-sheet-notes-container">
                <div style="display: flex; align-items: center; justify-content: space-between;">
                  <span class="dndm-sheet-section-title" style="margin: 0;">Notes</span>
                  <div style="display: flex; gap: 2px; align-items: center;">
                    <button
                      class="dndm-btn dndm-btn--subtle dndm-notes-toggle"
                      style="padding: 1px 6px; font-size: 0.75rem;"
                      type="button"
                      aria-pressed=${showingEdit ? "true" : "false"}
                      ?disabled=${!editable}
                        title=${
                        editable
                        ? showingEdit
                          ? "Switch to markdown preview"
                          : "Switch to markdown editor"
                          : "Read-only — preview only"
                      }
                      @click=${() => {
                        if (!editable) return;
                        this.notesTab = showingEdit ? "preview" : "edit";
                      }}
                    >
                        ${
                        showingEdit
                        ? html`${eyeIcon(true)}<span>Preview</span>`
                          : html`${penIcon()}<span>Edit</span>`
                      }
                    </button>
                    <button
                      class="dndm-btn dndm-btn--subtle dndm-btn--icon"
                      style="padding: 1px 6px;"
                      type="button"
                      title="Open notes in a modal"
                      aria-label="Open notes in modal"
                      @click=${() => this.openNotesModal(sheet, editable)}
                    >
                      ${expandIcon()}
                    </button>
                  </div>
                </div>

                  ${
                  showingEdit
                  ? html`
                      <textarea
                        class="dndm-sheet-notes-textarea"
                        placeholder="Character backstory, inventory, notes (Markdown supported)..."
                        .value=${notesValue}
                        ?disabled=${!editable}
                        aria-label="Notes markdown editor"
                        @input=${(e: Event) => this.onNotesInput(sheet.id, e)}
                      ></textarea>
                    `
                  : html`
                      <div
                        class="dndm-sheet-notes-preview"
                        .innerHTML=${toSafeHtml(notesValue)}
                      ></div>
                      `
                }
              </div>
            `;
          })()
          : nothing
      }
    `;

    const hasVitals = canViewNotesAndHp;
    const hasScores = abilityRows.length > 0;
    const hasAttrs = otherRows.length > 0;

    // Popout windows fill the viewport height: paired sections share a row
    // and the notes editor absorbs the remaining space (sheet-popout.css).
    if (this.isSheetPopout) {
      return html`
        <div class="dndm-sheet-popout-head">${titleBar}${headerActions}</div>
        ${provenance}
        ${hasVitals && hasScores
          ? html`<div class="dndm-sheet-popout-cols">${vitals}${scores}</div>`
          : html`${vitals}${scores}`}
        ${hasAttrs
          ? html`<div class="dndm-sheet-popout-cols">${attrsSection}${statusEffects}</div>`
          : statusEffects}
        ${notesSection}
      `;
    }

    return html`
      ${titleBar}
      ${headerActions}
      ${provenance}
      ${vitals}
      ${scores}
      ${attrsSection}
      ${statusEffects}
      ${notesSection}
    `;
  }

  private renderAttributeValueEditor(
    sheet: CharacterSheet,
    row: AttributeRow,
    val: AttributeValue,
    editable: boolean,
  ): TemplateResult {
    switch (row.type) {
      case "Score": {
        const values = this.draftValues ?? sheet.values;
        const current = values[row.name];
        const num = current && current.kind === "Score" ? current.value : 10;
        return editable
          ? html`
              <button
                class="dndm-sheet-value-btn"
                title="Edit ${row.name}"
                @click=${(e: Event) => {
                  this.openNumberPopover("attribute", sheet.id, e.currentTarget as HTMLElement, {
                    rowName: row.name,
                    rowType: "Score",
                  });
                }}
              >
                ${num}
              </button>
            `
          : html`<span>${num}</span>`;
      }
      case "Modifier": {
        const values = this.draftValues ?? sheet.values;
        const current = values[row.name];
        const num = current && current.kind === "Modifier" ? current.value : 0;
        return editable
          ? html`
              <button
                class="dndm-sheet-value-btn"
                title="Edit ${row.name}"
                @click=${(e: Event) => {
                  this.openNumberPopover("attribute", sheet.id, e.currentTarget as HTMLElement, {
                    rowName: row.name,
                    rowType: "Modifier",
                  });
                }}
              >
                ${num >= 0 ? `+${num}` : num}
              </button>
            `
          : html`<span>${num >= 0 ? `+${num}` : num}</span>`;
      }
      case "Text": {
        const text = val.kind === "Text" ? val.value : "";
        return editable
          ? html`
              <input
                type="text"
                class="dndm-sheet-attr-input"
                .value=${text}
                @input=${(e: Event) => {
                  const t = (e.target as HTMLInputElement).value;
                  this.onAttributeInput(sheet, row, { kind: "Text", value: t });
                }}
              />
            `
          : html`<span>${text}</span>`;
      }
    }
  }
}
