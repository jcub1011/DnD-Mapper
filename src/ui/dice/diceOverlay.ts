/*
 * DiceOverlay — manages the single shared 3D physics dice overlay canvas.
 *
 * WebGL Context Ceiling Invariant:
 * Browsers strictly limit simultaneous active WebGL contexts (8–16 max across the page).
 * We pool all client rolls through a single Three.js DiceBox instance mounted on
 * a full-viewport transparent overlay above Phaser.
 *
 * Latest roll wins:
 * Only one roll's dice are ever on the board. A new roll first makes any
 * existing dice disappear (cancelling their fade and settling their log
 * entries immediately), then throws via the stock `box.roll()` path — whose
 * synchronous fast-forward lands every die on its authoritative face. Throws
 * therefore never interact, and a re-roll while dice are tumbling simply
 * clears them and re-throws.
 * Coloring is per roll (theme_customColorset): host gold, otherwise the
 * roller's resolved color.
 */

import { buildDiceNotation } from "../../game/dice.js";
import type { RollResult } from "../../game/domain.js";
import type DiceBox from "../../lib/dice-box/dice-box.js";
import type { DiceBoxColorset } from "../../lib/dice-box/dice-box.js";
import { diceAnimationTracker } from "./diceAnimationTracker.js";

export const DEFAULT_DICE_SCALE = 75;
export const DICE_FADE_DELAY_MS = 3000;

export class DiceOverlay {
  private box: DiceBox | null = null;
  private initializing: Promise<DiceBox | null> | null = null;
  private container: HTMLElement | null = null;
  /** The roll currently on the board, if any. */
  private currentRollId: string | null = null;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Serializes clear-plus-spawn sequences so concurrent rolls cannot
   * interleave. Launch never waits for physics.
   */
  private launchChain: Promise<void> = Promise.resolve();
  /** Bumps on detach so queued launches from a previous session abort. */
  private epoch = 0;
  private currentColor = "";
  private currentFontColor = "";
  private soundEnabled = false;
  private diceScale: number = DEFAULT_DICE_SCALE;
  private resizeObserver: ResizeObserver | null = null;

  getContainer(): HTMLElement | null {
    return this.container;
  }

  get isSoundEnabled(): boolean {
    return this.soundEnabled;
  }

  setSoundEnabled(enabled: boolean): void {
    this.soundEnabled = enabled;
    if (this.box) {
      this.box.sounds = enabled;
    }
  }

  getDiceScale(): number {
    return this.diceScale;
  }

  setDiceScale(scale: number): void {
    if (!Number.isFinite(scale)) return;
    const clamped = Math.max(25, Math.min(250, Math.round(scale)));
    this.diceScale = clamped;
    if (this.box) {
      void this.box.updateConfig({ baseScale: clamped });
    }
  }

  /**
   * Recalculates canvas dimensions and 3D physics box walls to match current container size.
   */
  updateDimensions(): void {
    if (this.box) {
      this.box.setDimensions();
    }
  }

  private setupResizeObserver(container: HTMLElement): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.box) {
          this.box.setDimensions();
        }
      });
      this.resizeObserver.observe(container);
    }
  }

  /**
   * Initializes the single shared DiceBox instance inside the supplied container element.
   */
  async attach(container: HTMLElement): Promise<void> {
    if (this.container === container && (this.box || this.initializing)) {
      return;
    }
    if (this.container !== container && this.box) {
      this.container = container;
      if (this.box.renderer?.domElement && !container.contains(this.box.renderer.domElement)) {
        container.appendChild(this.box.renderer.domElement);
        this.box.container = container;
        this.box.setDimensions();
      }
      this.setupResizeObserver(container);
      return;
    }
    this.container = container;
    this.setupResizeObserver(container);
    await this.ensureBox();
  }

  /**
   * Detaches and disposes the 3D dice overlay.
   */
  detach(): void {
    this.epoch += 1;
    this.launchChain = Promise.resolve();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.clearCurrentRoll();
    if (this.box) {
      try {
        this.box.onRollComplete = null;
      } catch {
        // best effort
      }
      this.box = null;
    }
    this.container = null;
    this.initializing = null;
  }

  private async ensureBox(): Promise<DiceBox | null> {
    if (this.box) return this.box;
    if (this.initializing) return this.initializing;
    let container = this.container;
    if (!container && typeof document !== "undefined") {
      const app = document.querySelector("dndm-app");
      container = (app?.querySelector("#dndm-dice-overlay") ||
        document.getElementById("dndm-dice-overlay") ||
        document.querySelector("#dndm-dice-overlay")) as HTMLElement | null;
      if (container) {
        this.container = container;
      }
    }
    if (!container || typeof window === "undefined") return null;

    this.initializing = (async () => {
      try {
        // Check for WebGL support
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (!gl) {
          console.warn("WebGL not supported; 3D dice falling back to immediate settle.");
          return null;
        }

        const DiceBoxModule = await import("../../lib/dice-box/dice-box.es.js");
        const DiceBoxClass = DiceBoxModule.default;

        const assetPath = new URL("assets/dice/", window.location.href).href;

        const box = new DiceBoxClass(container, {
          assetPath,
          theme_surface: "default",
          theme_material: "plastic",
          baseScale: this.diceScale,
          gravity_multiplier: 600,
          strength: 2,
          shadows: true,
          sounds: this.soundEnabled,
        });

        await box.initialize();
        this.box = box;
        return box;
      } catch (err) {
        console.warn("Failed to initialize 3D dice overlay:", err);
        return null;
      } finally {
        this.initializing = null;
      }
    })();

    return this.initializing;
  }

  private getColorset(color: string, fontColor: string): DiceBoxColorset {
    const safeColor = color || "#FFD700";
    const safeFont = fontColor || "#1a1208";
    return {
      name: `dndm-${safeColor.replace(/[^a-zA-Z0-9]/g, "_")}-${safeFont.replace(/[^a-zA-Z0-9]/g, "_")}`,
      background: safeColor,
      foreground: safeFont,
      texture: "none",
      material: "plastic",
    };
  }

  /**
   * Spawns tumbling 3D dice for the supplied RollResult with the resolved roller colors.
   *
   * Latest roll wins: any dice already on the board disappear first, so throws
   * never interact.
   */
  async roll(rollResult: RollResult, color: string, fontColor: string): Promise<void> {
    const rollId = rollResult.id;

    diceAnimationTracker.markAnimating(rollId);

    const epoch = this.epoch;
    const task = this.launchChain.then(() => {
      if (epoch !== this.epoch) {
        diceAnimationTracker.markSettled(rollId);
        return;
      }
      return this.runRoll(rollResult, color, fontColor, epoch);
    });
    // Keep the chain alive across failures; runRoll itself never throws.
    this.launchChain = task.then(
      () => undefined,
      () => undefined,
    );
    await task;
  }

  private async runRoll(
    rollResult: RollResult,
    color: string,
    fontColor: string,
    epoch: number,
  ): Promise<void> {
    const rollId = rollResult.id;
    try {
      const box = await this.ensureBox();
      if (epoch !== this.epoch) {
        diceAnimationTracker.markSettled(rollId);
        return;
      }
      if (!box) {
        // Immediate fallback if 3D dice engine is not available
        diceAnimationTracker.markSettled(rollId);
        return;
      }

      // Ensure 3D physics box walls and camera match current view window bounds
      box.setDimensions();

      const notation = buildDiceNotation(rollResult);
      if (!notation) {
        diceAnimationTracker.markSettled(rollId);
        return;
      }

      // Latest roll wins: vanish existing dice so throws never interact.
      this.clearCurrentRoll();

      const configUpdate: Record<string, unknown> = {};
      if (color !== this.currentColor || fontColor !== this.currentFontColor) {
        this.currentColor = color;
        this.currentFontColor = fontColor;
        configUpdate.theme_customColorset = this.getColorset(color, fontColor);
      }
      if (box.baseScale !== this.diceScale) {
        configUpdate.baseScale = this.diceScale;
      }
      if (box.sounds !== this.soundEnabled) {
        configUpdate.sounds = this.soundEnabled;
      }
      if (Object.keys(configUpdate).length > 0) {
        await box.updateConfig(configUpdate);
      }
      if (epoch !== this.epoch) {
        diceAnimationTracker.markSettled(rollId);
        return;
      }

      // Stock throw on a guaranteed-empty board: clears, spawns, and lands
      // every die on its authoritative face. Returns after launch (never waits
      // for physics); completion settles the roll and arms its fade.
      let launch: Promise<unknown>;
      try {
        launch = box.roll(notation);
      } catch (err) {
        console.warn("Dice roll physics failed", err);
        diceAnimationTracker.markSettled(rollId);
        return;
      }
      this.currentRollId = rollId;
      launch.then(
        () => {
          if (epoch === this.epoch) this.settleCurrent(rollId);
        },
        (err) => {
          console.warn("Dice roll physics failed", err);
          if (epoch === this.epoch) this.settleCurrent(rollId);
        },
      );
    } catch (err) {
      console.warn("Failed to launch 3D roll:", err);
      diceAnimationTracker.markSettled(rollId);
    }
  }

  /** Settles the board's roll and arms its fade. Stale completions are ignored. */
  private settleCurrent(rollId: string): void {
    if (this.currentRollId !== rollId) return;
    diceAnimationTracker.markSettled(rollId);
    if (this.fadeTimer !== null) {
      clearTimeout(this.fadeTimer);
    }
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = null;
      this.fadeCurrent(rollId);
    }, DICE_FADE_DELAY_MS);
  }

  /** Fades the board's roll if it is still the latest one. */
  private fadeCurrent(rollId: string): void {
    if (this.currentRollId !== rollId) return;
    this.currentRollId = null;
    if (this.box) {
      try {
        this.box.clearDice();
      } catch {
        // best effort
      }
    }
  }

  /**
   * Vanishes the board's roll: cancels its fade, reveals its log entry
   * immediately, and clears the scene. No-op when the board is empty.
   */
  private clearCurrentRoll(): void {
    if (this.fadeTimer !== null) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
    if (this.currentRollId === null) return;
    diceAnimationTracker.markSettled(this.currentRollId);
    this.currentRollId = null;
    if (this.box) {
      try {
        this.box.clearDice();
      } catch {
        // best effort
      }
    }
  }
}

export const diceOverlay = new DiceOverlay();
