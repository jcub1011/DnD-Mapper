import { describe, expect, it } from "vitest";
import { calculateRulerDistance } from "./ruler.js";

describe("ruler distance measurement", () => {
  it("calculates orthogonal distance correctly", () => {
    const result = calculateRulerDistance(0, 0, 4, 0);
    expect(result.dx).toBe(4);
    expect(result.dy).toBe(0);
    expect(result.chebyshevSquares).toBe(4);
    expect(result.euclideanCells).toBeCloseTo(4.0);
    expect(result.feet).toBe(20);
    expect(result.label).toBe("4 sq · 4.0 actual · 20 ft");
  });

  it("applies 5e Chebyshev distance for diagonals (diagonal = 1 sq)", () => {
    // 3 squares diagonally
    const result = calculateRulerDistance(0, 0, 3, 3);
    expect(result.dx).toBe(3);
    expect(result.dy).toBe(3);
    expect(result.chebyshevSquares).toBe(3); // Chebyshev max(3, 3) = 3 squares!
    expect(result.euclideanCells).toBeCloseTo(Math.hypot(3, 3)); // ~4.24
    expect(result.feet).toBe(15);
    expect(result.label).toBe("3 sq · 4.2 actual · 15 ft");
  });

  it("calculates asymmetric diagonal movement (e.g. 3-4-5 triangle)", () => {
    const result = calculateRulerDistance(1, 2, 4, 6);
    expect(result.dx).toBe(3);
    expect(result.dy).toBe(4);
    expect(result.chebyshevSquares).toBe(4);
    expect(result.euclideanCells).toBeCloseTo(5.0);
    expect(result.feet).toBe(20);
    expect(result.label).toBe("4 sq · 5.0 actual · 20 ft");
  });

  it("supports custom feet per square", () => {
    const result = calculateRulerDistance(0, 0, 5, 2, 10);
    expect(result.chebyshevSquares).toBe(5);
    expect(result.feet).toBe(50);
    expect(result.label).toBe("5 sq · 5.4 actual · 50 ft");
  });
});
