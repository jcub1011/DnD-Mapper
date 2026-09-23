/*
 * Markup layer in Phaser MapScene.
 * Renders freehand SVG vector markup at DEPTH.MARKUP (2000).
 * Parses cell-unit SVG paths and scales them by CELL to world space.
 */

import Phaser from "phaser";
import { DEPTH } from "./depth";
import { CELL } from "./viewport";
import { parseSvgToStrokes, type MarkupStroke } from "../markup/bezier";

export const FALLBACK_MARKUP_COLOR = 0xc0392b;

/**
 * Parse a `#rrggbb` stroke color into a Phaser color int. Black (0x000000)
 * is a valid color — only genuinely unparseable input falls back.
 * (parseInt yields NaN for those; a plain `|| fallback` would also clobber
 * black since 0 is falsy.)
 */
export function parseMarkupColor(cssColor: string | null | undefined): number {
  if (!cssColor) return FALLBACK_MARKUP_COLOR;
  const parsed = parseInt(cssColor.replace("#", ""), 16);
  return Number.isNaN(parsed) ? FALLBACK_MARKUP_COLOR : parsed;
}

export class MarkupLayer {
  private gfx: Phaser.GameObjects.Graphics;
  private currentSvg: string | null = null;

  constructor(private readonly scene: Phaser.Scene) {
    this.gfx = this.scene.add.graphics();
    this.gfx.setDepth(DEPTH.MARKUP);
  }

  setMarkup(markupSvg: string | null): void {
    this.currentSvg = markupSvg;
    this.redraw();
  }

  redraw(): void {
    this.gfx.clear();
    if (!this.currentSvg || this.currentSvg.trim().length === 0) {
      return;
    }

    const strokes = parseSvgToStrokes(this.currentSvg);
    for (const stroke of strokes) {
      this.renderStroke(stroke);
    }
  }

  private renderStroke(stroke: MarkupStroke): void {
    const colorNum = parseMarkupColor(stroke.color);
    const strokeWidthPx = Math.max(1, stroke.width * CELL);

    this.gfx.lineStyle(strokeWidthPx, colorNum, 1.0);
    this.gfx.beginPath();

    this.renderPathCommands(stroke.d);

    this.gfx.strokePath();
  }

  private renderPathCommands(d: string): void {
    // Regex tokenizer for SVG path commands
    const cmdRegex = /([a-df-z])([^a-df-z]*)/gi;
    let cmdMatch: RegExpExecArray | null;

    let currentX = 0;
    let currentY = 0;

    while ((cmdMatch = cmdRegex.exec(d)) !== null) {
      const type = cmdMatch[1];
      const args = (cmdMatch[2].match(/-?\d+(?:\.\d+)?/g) || []).map(Number);

      switch (type) {
        case "M": {
          if (args.length >= 2) {
            currentX = args[0];
            currentY = args[1];
            this.gfx.moveTo(currentX * CELL, currentY * CELL);
          }
          break;
        }

        case "L": {
          if (args.length >= 2) {
            currentX = args[0];
            currentY = args[1];
            this.gfx.lineTo(currentX * CELL, currentY * CELL);
          }
          break;
        }

        case "Q": {
          for (let i = 0; i + 3 < args.length; i += 4) {
            const cx = args[i];
            const cy = args[i + 1];
            const endX = args[i + 2];
            const endY = args[i + 3];

            // Subdivide quadratic curve into 8 smooth line segments
            const steps = 8;
            for (let step = 1; step <= steps; step++) {
              const t = step / steps;
              const invT = 1 - t;
              const qx = invT * invT * currentX + 2 * invT * t * cx + t * t * endX;
              const qy = invT * invT * currentY + 2 * invT * t * cy + t * t * endY;
              this.gfx.lineTo(qx * CELL, qy * CELL);
            }

            currentX = endX;
            currentY = endY;
          }
          break;
        }

        case "C": {
          for (let i = 0; i + 5 < args.length; i += 6) {
            const c1x = args[i];
            const c1y = args[i + 1];
            const c2x = args[i + 2];
            const c2y = args[i + 3];
            const endX = args[i + 4];
            const endY = args[i + 5];

            // Subdivide cubic curve into 10 smooth line segments
            const steps = 10;
            for (let step = 1; step <= steps; step++) {
              const t = step / steps;
              const invT = 1 - t;
              const bx =
                invT * invT * invT * currentX +
                3 * invT * invT * t * c1x +
                3 * invT * t * t * c2x +
                t * t * t * endX;
              const by =
                invT * invT * invT * currentY +
                3 * invT * invT * t * c1y +
                3 * invT * t * t * c2y +
                t * t * t * endY;
              this.gfx.lineTo(bx * CELL, by * CELL);
            }

            currentX = endX;
            currentY = endY;
          }
          break;
        }

        case "Z":
        case "z": {
          this.gfx.closePath();
          break;
        }
      }
    }
  }

  onContextRestored(): void {
    this.redraw();
  }

  destroy(): void {
    this.gfx?.destroy();
  }
}
