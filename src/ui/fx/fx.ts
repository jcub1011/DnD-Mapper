/*
 * The FX facade. Components never touch Phaser — they call this small imperative
 * API. Particle effects forward to the FxScene; screen-shake is applied to the
 * DOM app root (the canvas is a separate layer, so shaking the camera wouldn't
 * move the UI). This interface is the swap boundary: the whole Phaser layer could
 * be replaced behind it. The KnockBox global plugin is registered here at init,
 * so this facade also exposes the live networking peer via knockbox().
 */

import Phaser from "phaser";
import { COLORS, prefersReducedMotion } from "../../theme";
import { createLogger } from "../../log";
import type { LaunchMode } from "../../net/launch";
import { knockboxPluginConfig } from "../../net/knockboxPlugin";
import type { KnockBoxTransport } from "../../net/transport";
import { FxScene } from "./FxScene";
import { MapScene } from "../map/MapScene";

const log = createLogger("fx");

export interface Rectish {
  left: number;
  top: number;
  width: number;
  height: number;
}

class Fx {
  private game?: Phaser.Game;
  private scene?: FxScene;
  private mapScene?: MapScene;
  private shakeTarget?: HTMLElement;

  /** Boot the Phaser FX game into the given parent element. The KnockBox global
   *  plugin is registered here for EVERY launch mode: the real relay plugin on
   *  the platform, and the no-server peer (true host mode — the DM browser
   *  behind the controller holds the truth) for solo and multi-tab. One
   *  networking path, always. */
  init(parentId: string, mode: LaunchMode = "solo"): void {
    if (this.game) return;
    const net = knockboxPluginConfig(mode);
    log.info(`FX init (launch=${mode}, KnockBox plugin ${net ? "registered" : "MISSING"})`);
    if (!net) log.error("no KnockBox plugin class available — networking is disabled");
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: parentId,
      transparent: true,
      scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
      scene: [MapScene, FxScene],
      ...(net ? { plugins: { global: [net] } } : {}),
      // Prevent wheel default to prevent page scrolling in iframe and enable map zooming
      input: { mouse: { preventDefaultWheel: true } },
      fps: { target: 60 },
    });
    this.game.events.once(Phaser.Core.Events.READY, () => {
      this.scene = this.game!.scene.getScene("Fx") as FxScene;
      this.mapScene = this.game!.scene.getScene("Map") as MapScene;
      this.installContextLossGuards();
    });
  }

  /** Guard against WebGL context loss. On mobile Safari and backgrounded tabs the
   *  GPU can drop the canvas context; without intervention the FX particles and map
   *  silently never render again. */
  private installContextLossGuards(): void {
    const canvas = this.game?.canvas;
    if (!canvas) return;
    canvas.addEventListener("webglcontextlost", (e: Event) => {
      e.preventDefault(); // ask the browser to attempt a restore
      log.warn("WebGL context lost; map and FX paused until restore");
    });
    canvas.addEventListener("webglcontextrestored", () => {
      log.warn("WebGL context restored; resuming map and FX");
      this.scene = this.game?.scene.getScene("Fx") as FxScene | undefined;
      this.mapScene = this.game?.scene.getScene("Map") as MapScene | undefined;
      this.mapScene?.onContextRestored();
    });
  }

  /** Access the active MapScene if initialized. */
  map(): MapScene | undefined {
    return this.mapScene;
  }

  /** The KnockBox networking peer (the registered global plugin), if any. All
   *  launch modes register one — solo and local-tab get the no-server peer in
   *  true host mode, platform gets the real relay plugin. */
  knockbox(): KnockBoxTransport | undefined {
    const plugins = this.game?.plugins as unknown as { get(key: string): unknown } | undefined;
    return (plugins?.get("KnockBox") as KnockBoxTransport | undefined) ?? undefined;
  }

  /** Element whose transform is nudged for screen-shake (the UI root). */
  setShakeTarget(el: HTMLElement): void {
    this.shakeTarget = el;
  }

  private center(r: Rectish): [number, number] {
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  /** Particle burst centered on a screen point or DOM rect. intensity 0..1. */
  burstAt(target: Rectish | [number, number], intensity = 0.5, color: number = COLORS.cyan): void {
    if (!this.scene || prefersReducedMotion()) return;
    const [x, y] = Array.isArray(target) ? target : this.center(target);
    this.scene.burstAt(x, y, intensity, color);
  }

  /** Shake an element. intensity 0..1. Defaults to the UI root. */
  shake(intensity = 0.5, target?: HTMLElement): void {
    const el = target ?? this.shakeTarget;
    if (!el || prefersReducedMotion()) return;
    const px = Math.round(2 + intensity * 7);
    el.style.setProperty("--shake", `${px}px`);
    el.classList.remove("is-shaking");
    // Force reflow so the animation can restart if shakes stack.
    void el.offsetWidth;
    el.classList.add("is-shaking");
    window.setTimeout(() => el.classList.remove("is-shaking"), 420);
  }
}

/** Singleton FX facade shared by every component. */
export const fx = new Fx();
