import { describe, it, expect } from "vitest";
import { splitPolygonByLine, polygonArea, pointInPolygon, type Pt } from "@/lib/polygon-split";

const SQUARE: Pt[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe("splitPolygonByLine — clean bisect", () => {
  it("splits a square in half with a horizontal line", () => {
    const result = splitPolygonByLine(SQUARE, { x: -5, y: 5 }, { x: 15, y: 5 });
    expect(result).not.toBeNull();
    expect(result!.left.length).toBeGreaterThanOrEqual(3);
    expect(result!.right.length).toBeGreaterThanOrEqual(3);
    const totalArea = polygonArea(result!.left) + polygonArea(result!.right);
    expect(totalArea).toBeCloseTo(polygonArea(SQUARE), 6);
  });

  it("splits a square in half with a vertical line", () => {
    const result = splitPolygonByLine(SQUARE, { x: 5, y: -5 }, { x: 5, y: 15 });
    expect(result).not.toBeNull();
    expect(polygonArea(result!.left)).toBeCloseTo(50, 6);
    expect(polygonArea(result!.right)).toBeCloseTo(50, 6);
  });

  it("splits a square diagonally (corner to corner)", () => {
    const result = splitPolygonByLine(SQUARE, { x: -1, y: -1 }, { x: 11, y: 11 });
    expect(result).not.toBeNull();
    const totalArea = polygonArea(result!.left) + polygonArea(result!.right);
    expect(totalArea).toBeCloseTo(polygonArea(SQUARE), 6);
  });

  it("splits an asymmetric bisect", () => {
    const result = splitPolygonByLine(SQUARE, { x: -5, y: 3 }, { x: 15, y: 3 });
    expect(result).not.toBeNull();
    const totalArea = polygonArea(result!.left) + polygonArea(result!.right);
    expect(totalArea).toBeCloseTo(100, 6);
    const areas = [polygonArea(result!.left), polygonArea(result!.right)].sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(30, 6);
    expect(areas[1]).toBeCloseTo(70, 6);
  });
});

describe("splitPolygonByLine — no bisect", () => {
  it("returns null when the line doesn't intersect the polygon", () => {
    const result = splitPolygonByLine(SQUARE, { x: -5, y: 20 }, { x: 15, y: 20 });
    expect(result).toBeNull();
  });

  it("returns null when the line is parallel to and outside an edge", () => {
    const result = splitPolygonByLine(SQUARE, { x: -5, y: -1 }, { x: 15, y: -1 });
    expect(result).toBeNull();
  });

  it("returns null when the line is collinear with a polygon edge", () => {
    const result = splitPolygonByLine(SQUARE, { x: -5, y: 0 }, { x: 15, y: 0 });
    expect(result).toBeNull();
  });

  it("returns null for a polygon with fewer than 3 vertices", () => {
    const result = splitPolygonByLine(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      { x: 5, y: -5 },
      { x: 5, y: 5 }
    );
    expect(result).toBeNull();
  });
});

describe("splitPolygonByLine — complex polygons", () => {
  it("splits a concave L-shape cleanly when the line hits exactly two edges", () => {
    const LSHAPE: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ];
    const result = splitPolygonByLine(LSHAPE, { x: -5, y: 2 }, { x: 15, y: 2 });
    expect(result).not.toBeNull();
    const totalArea = polygonArea(result!.left) + polygonArea(result!.right);
    expect(totalArea).toBeCloseTo(polygonArea(LSHAPE), 6);
  });

  it("returns null for a line that hits an L-shape in more than 2 places", () => {
    const LSHAPE: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 7, y: 10 },
      { x: 7, y: 3 },
      { x: 3, y: 3 },
      { x: 3, y: 10 },
      { x: 0, y: 10 },
    ];
    const result = splitPolygonByLine(LSHAPE, { x: -5, y: 8 }, { x: 15, y: 8 });
    expect(result).toBeNull();
  });
});

describe("polygonArea", () => {
  it("computes the area of a unit square", () => {
    expect(polygonArea([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ])).toBeCloseTo(1, 10);
  });

  it("computes the area of a triangle", () => {
    expect(polygonArea([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 3 },
    ])).toBeCloseTo(6, 10);
  });

  it("is invariant to vertex order", () => {
    const poly: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const reversed: Pt[] = [...poly].reverse();
    expect(polygonArea(poly)).toBeCloseTo(polygonArea(reversed), 10);
  });
});

describe("pointInPolygon", () => {
  it("detects a point inside a square", () => {
    expect(pointInPolygon({ x: 5, y: 5 }, SQUARE)).toBe(true);
  });

  it("detects a point outside a square", () => {
    expect(pointInPolygon({ x: 15, y: 5 }, SQUARE)).toBe(false);
    expect(pointInPolygon({ x: -1, y: 5 }, SQUARE)).toBe(false);
    expect(pointInPolygon({ x: 5, y: 15 }, SQUARE)).toBe(false);
  });
});
