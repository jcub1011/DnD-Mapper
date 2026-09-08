/*
 * Pure ruler measurement helpers.
 *
 * Rules:
 *   1. Cell coordinates everywhere. 1 unit = 1 grid cell.
 *   2. Chebyshev distance is used for D&D 5e grid distance (diagonal = 1 square).
 *   3. Euclidean distance is shown alongside for reference ("actual").
 *   4. Standard label format: "{cheb} sq · {euc:0.0} actual · {ft} ft".
 *   5. Strict JSON compatibility; pure TypeScript with no DOM or Node globals.
 */

import { FEET_PER_SQUARE } from "./domain.js";

export interface RulerMeasurement {
  readonly dx: number;
  readonly dy: number;
  readonly chebyshevSquares: number;
  readonly euclideanCells: number;
  readonly feet: number;
  readonly label: string;
}

/**
 * Computes grid and real-world distance between two cell points (x1, y1) and (x2, y2).
 * Both points are given in cell units.
 */
export function calculateRulerDistance(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  feetPerSquare: number = FEET_PER_SQUARE,
): RulerMeasurement {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);

  // In D&D 5e, movement on a square grid is Chebyshev distance:
  // moving diagonally costs 1 square (same as orthogonal).
  // Rounded to nearest integer square for discrete grid counting.
  const chebyshevSquares = Math.max(Math.round(dx), Math.round(dy));
  const euclideanCells = Math.hypot(dx, dy);
  const feet = chebyshevSquares * feetPerSquare;

  const label = `${chebyshevSquares} sq · ${euclideanCells.toFixed(1)} actual · ${feet} ft`;

  return {
    dx,
    dy,
    chebyshevSquares,
    euclideanCells,
    feet,
    label,
  };
}
