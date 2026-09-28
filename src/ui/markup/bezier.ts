/*
 * Freehand SVG vector markup geometry and smoothing.
 *
 * Implements Catmull-Rom / midpoint quadratic Bezier curve fitting,
 * stroke serialization into cell-unit coordinates, and segment distance
 * calculations for the stroke eraser.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface MarkupStroke {
  readonly id: string;
  readonly color: string;
  readonly width: number; // in cell units
  readonly points: readonly Point[];
  readonly d: string;
}

function fmt(n: number, precision = 3): string {
  return Number(n.toFixed(precision)).toString();
}

/**
 * Converts a sequence of raw pointer points into a smooth quadratic Bezier SVG path data string.
 */
export function pointsToQuadraticBezier(points: readonly Point[], precision = 3): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const p = points[0];
    return `M ${fmt(p.x, precision)} ${fmt(p.y, precision)} L ${fmt(p.x, precision)} ${fmt(p.y, precision)}`;
  }
  if (points.length === 2) {
    const p0 = points[0];
    const p1 = points[1];
    return `M ${fmt(p0.x, precision)} ${fmt(p0.y, precision)} L ${fmt(p1.x, precision)} ${fmt(p1.y, precision)}`;
  }

  let d = `M ${fmt(points[0].x, precision)} ${fmt(points[0].y, precision)}`;

  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const next = points[i + 1];
    const midX = (p.x + next.x) / 2;
    const midY = (p.y + next.y) / 2;
    d += ` Q ${fmt(p.x, precision)} ${fmt(p.y, precision)} ${fmt(midX, precision)} ${fmt(midY, precision)}`;
  }

  const lastControl = points[points.length - 2];
  const lastPoint = points[points.length - 1];
  d += ` Q ${fmt(lastControl.x, precision)} ${fmt(lastControl.y, precision)} ${fmt(lastPoint.x, precision)} ${fmt(lastPoint.y, precision)}`;

  return d;
}

/**
 * Calculates the shortest Euclidean distance from a point to a finite line segment (x1, y1) -> (x2, y2).
 */
export function pointToSegmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    return Math.hypot(px - x1, py - y1);
  }

  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;

  return Math.hypot(px - projX, py - projY);
}

/**
 * Tests whether an eraser circle at (eraserPoint.x, eraserPoint.y) with eraserRadius intersects a stroke.
 */
export function isStrokeHit(
  points: readonly Point[],
  eraserPoint: Point,
  eraserRadius: number,
): boolean {
  if (points.length === 0) return false;
  if (points.length === 1) {
    return Math.hypot(eraserPoint.x - points[0].x, eraserPoint.y - points[0].y) <= eraserRadius;
  }

  for (let i = 0; i < points.length - 1; i++) {
    const dist = pointToSegmentDistance(
      eraserPoint.x,
      eraserPoint.y,
      points[i].x,
      points[i].y,
      points[i + 1].x,
      points[i + 1].y,
    );
    if (dist <= eraserRadius) {
      return true;
    }
  }

  return false;
}

/**
 * Parses coordinates from an SVG path 'd' string into a Point array.
 */
export function parsePathDToPoints(d: string): Point[] {
  const points: Point[] = [];
  const numbers = d.match(/-?\d+(?:\.\d+)?/g);
  if (!numbers) return points;

  for (let i = 0; i + 1 < numbers.length; i += 2) {
    points.push({
      x: parseFloat(numbers[i]),
      y: parseFloat(numbers[i + 1]),
    });
  }

  return points;
}

/**
 * Serializes strokes into cell-unit SVG group markup.
 */
export function serializeStrokesToSvg(strokes: readonly MarkupStroke[]): string {
  if (strokes.length === 0) return "";
  return strokes
    .map(
      (s) =>
        `<g stroke="${s.color}" stroke-width="${s.width}" fill="none" stroke-linecap="round" stroke-linejoin="round">\n  <path d="${s.d}" />\n</g>`,
    )
    .join("\n");
}

let strokeCounter = 0;
function nextStrokeId(): string {
  strokeCounter++;
  return `stroke_${Date.now()}_${strokeCounter}`;
}

/**
 * Deserializes an SVG markup string into MarkupStroke objects.
 */
export function parseSvgToStrokes(svg: string | null): MarkupStroke[] {
  if (!svg || svg.trim().length === 0) return [];
  const strokes: MarkupStroke[] = [];

  // Match <g ...><path d="..." /></g> or standalone <path ... />
  const groupRegex = /<g\b([^>]*)>([\s\S]*?)<\/g>/gi;
  let groupMatch: RegExpExecArray | null;

  while ((groupMatch = groupRegex.exec(svg)) !== null) {
    const gAttrs = groupMatch[1];
    const inner = groupMatch[2];

    const colorMatch = /stroke="([^"]*)"/i.exec(gAttrs);
    const widthMatch = /stroke-width="([^"]*)"/i.exec(gAttrs);
    const pathMatch = /<path\b[^>]*\bd="([^"]*)"[^>]*\/?>/i.exec(inner);

    if (pathMatch) {
      const d = pathMatch[1];
      const color = colorMatch ? colorMatch[1] : "#c0392b";
      const width = widthMatch ? parseFloat(widthMatch[1]) : 0.04;
      const points = parsePathDToPoints(d);

      strokes.push({
        id: nextStrokeId(),
        color,
        width,
        points,
        d,
      });
    }
  }

  // Also check for standalone paths if no groups matched
  if (strokes.length === 0) {
    const pathRegex = /<path\b([^>]*)\bd="([^"]*)"([^>]*)\/?>/gi;
    let pathMatch: RegExpExecArray | null;
    while ((pathMatch = pathRegex.exec(svg)) !== null) {
      const allAttrs = pathMatch[1] + " " + pathMatch[3];
      const d = pathMatch[2];
      const colorMatch = /stroke="([^"]*)"/i.exec(allAttrs);
      const widthMatch = /stroke-width="([^"]*)"/i.exec(allAttrs);
      const color = colorMatch ? colorMatch[1] : "#c0392b";
      const width = widthMatch ? parseFloat(widthMatch[1]) : 0.04;
      const points = parsePathDToPoints(d);

      strokes.push({
        id: nextStrokeId(),
        color,
        width,
        points,
        d,
      });
    }
  }

  return strokes;
}
