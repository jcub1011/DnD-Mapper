import { describe, expect, it } from "vitest";
import {
  isStrokeHit,
  parseSvgToStrokes,
  pointToSegmentDistance,
  pointsToQuadraticBezier,
  serializeStrokesToSvg,
  type MarkupStroke,
} from "./bezier";

describe("Bezier Math and Stroke Eraser (Phase 10)", () => {
  describe("pointsToQuadraticBezier", () => {
    it("returns empty string for no points", () => {
      expect(pointsToQuadraticBezier([])).toBe("");
    });

    it("returns line to self for a single point", () => {
      expect(pointsToQuadraticBezier([{ x: 10, y: 20 }])).toBe("M 10 20 L 10 20");
    });

    it("returns single line segment for 2 points", () => {
      expect(
        pointsToQuadraticBezier([
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ]),
      ).toBe("M 0 0 L 10 10");
    });

    it("generates smooth quadratic curve with midpoints for 3+ points", () => {
      const points = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 10 },
        { x: 30, y: 10 },
      ];
      const d = pointsToQuadraticBezier(points);
      expect(d).toContain("M 0 0");
      expect(d).toContain("Q 10 0 15 5");
      expect(d).toContain("Q 20 10 30 10");
    });
  });

  describe("pointToSegmentDistance", () => {
    it("calculates perpendicular distance when point projects onto segment", () => {
      // Segment (0, 0) -> (10, 0), Point (5, 4)
      const dist = pointToSegmentDistance(5, 4, 0, 0, 10, 0);
      expect(dist).toBeCloseTo(4, 5);
    });

    it("calculates distance to closest endpoint when point projects outside segment", () => {
      // Segment (0, 0) -> (10, 0), Point (13, 4) -> closest is (10, 0)
      const dist = pointToSegmentDistance(13, 4, 0, 0, 10, 0);
      expect(dist).toBeCloseTo(5, 5); // 3-4-5 triangle
    });

    it("handles zero length segment", () => {
      const dist = pointToSegmentDistance(3, 4, 0, 0, 0, 0);
      expect(dist).toBeCloseTo(5, 5);
    });
  });

  describe("isStrokeHit", () => {
    const strokePoints = [
      { x: 5, y: 5 },
      { x: 15, y: 5 },
      { x: 25, y: 15 },
    ];

    it("returns true when eraser point is within radius of any segment", () => {
      // Point (10, 6) is distance 1 from segment (5,5)->(15,5)
      expect(isStrokeHit(strokePoints, { x: 10, y: 6 }, 1.5)).toBe(true);
    });

    it("returns false when eraser point is outside radius", () => {
      // Point (10, 10) is distance 5 from segment (5,5)->(15,5)
      expect(isStrokeHit(strokePoints, { x: 10, y: 10 }, 1.5)).toBe(false);
    });

    it("handles single-point stroke hit", () => {
      const single = [{ x: 5, y: 5 }];
      expect(isStrokeHit(single, { x: 5.5, y: 5 }, 1.0)).toBe(true);
      expect(isStrokeHit(single, { x: 8, y: 5 }, 1.0)).toBe(false);
    });
  });

  describe("SVG Serialization & Deserialization", () => {
    it("serializes strokes to cell-unit SVG and deserializes back", () => {
      const stroke: MarkupStroke = {
        id: "s1",
        color: "#27ae60",
        width: 0.08,
        points: [
          { x: 2, y: 2 },
          { x: 10, y: 8 },
        ],
        d: "M 2 2 L 10 8",
      };

      const svg = serializeStrokesToSvg([stroke]);
      expect(svg).toContain('stroke="#27ae60"');
      expect(svg).toContain('stroke-width="0.08"');
      expect(svg).toContain('d="M 2 2 L 10 8"');

      const parsed = parseSvgToStrokes(svg);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].color).toBe("#27ae60");
      expect(parsed[0].width).toBe(0.08);
      expect(parsed[0].d).toBe("M 2 2 L 10 8");
      expect(parsed[0].points.length).toBeGreaterThanOrEqual(2);
    });

    it("handles empty or null svg string gracefully", () => {
      expect(parseSvgToStrokes(null)).toEqual([]);
      expect(parseSvgToStrokes("")).toEqual([]);
    });
  });
});
