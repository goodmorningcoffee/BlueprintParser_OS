// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  inspectSimpleSplitPolygon,
  splitAreasConserve,
  splitMeasurementsMatchGeometry,
  storedSplitBboxMatches,
} from "@/server/services/annotation-split-geometry";
import { hasSimplePolygonBoundary } from "@/server/services/annotation-split-boundary";

function tenThousandVertexComb() {
  const teeth = 2_499;
  const vertices = [
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.1 },
  ];
  const gap = 0.8 / (teeth * 2 + 2);
  for (let index = 0; index < teeth; index += 1) {
    const top = 0.1 + (2 * index + 1) * gap;
    const bottom = top + gap * 0.45;
    vertices.push(
      { x: 0.9, y: top },
      { x: 0.2, y: top },
      { x: 0.2, y: bottom },
      { x: 0.9, y: bottom },
    );
  }
  vertices.push({ x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 });
  return vertices;
}

function rotatePolygon(points: Array<{ x: number; y: number }>) {
  return points.map(({ x, y }) => {
    const centeredX = x - 0.5;
    const centeredY = y - 0.5;
    const scale = 0.7 / Math.SQRT2;
    return {
      x: 0.5 + scale * (centeredX - centeredY),
      y: 0.5 + scale * (centeredX + centeredY),
    };
  });
}

function tenThousandVertexRotatedZig() {
  const zigCount = 9_997;
  const vertices: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < zigCount; index += 1) {
    vertices.push({
      x: index % 2 === 0 ? 0.02 : 0.98,
      y: 0.1 + (0.8 * index) / (zigCount - 1),
    });
  }
  vertices.push({ x: 0.01, y: 0.9 }, { x: 0.01, y: 0.5 }, { x: 0.01, y: 0.1 });
  return rotatePolygon(vertices);
}

describe("atomic Split geometry authority", () => {
  it("accepts axis-aligned and rotated 10,000-vertex combs without a quadratic candidate scan", () => {
    const comb = tenThousandVertexComb();
    expect(comb).toHaveLength(10_000);
    expect(inspectSimpleSplitPolygon(comb)).toMatchObject({
      bbox: [0.1, 0.1, 0.9, 0.9],
    });
    expect(inspectSimpleSplitPolygon(rotatePolygon(comb))).not.toBeNull();
    expect(
      inspectSimpleSplitPolygon(tenThousandVertexRotatedZig()),
    ).not.toBeNull();
  });

  it("rejects a self-crossing boundary even when its split shoelace areas conserve", () => {
    const selfCrossing = [
      { x: 0.3066556852027976, y: 0.9 },
      { x: 0.22391711388435326, y: 0.47168368487976076 },
      { x: 0.39971649561927536, y: 0.1 },
      { x: 0.9, y: 0.49628349770886593 },
      { x: 0.5190634779919281, y: 0.10233426583402266 },
      { x: 0.1, y: 0.43248437932968864 },
    ];
    expect(inspectSimpleSplitPolygon(selfCrossing)).toBeNull();
  });

  it("rejects a near-vertical proper crossing whose exact orientation is below the contact tolerance", () => {
    const toleranceMaskedCrossing = [
      { x: 0.4000000000089621, y: 0.08041051678359508 },
      { x: 0.40000000008354947, y: 0.289706918373704 },
      { x: 0.4000000000584017, y: 0.4858625490218401 },
      { x: 0.2981348118185997, y: 0.6742676085978746 },
      { x: 0.40000000001213853, y: 0.6581375599652529 },
      { x: 0.4000000000723887, y: 0.7547271623462438 },
      { x: 0.40000000001780406, y: 0.4938933774083853 },
      { x: 0.4000000000321486, y: 0.47250760547816756 },
      { x: 0.22863380074501036, y: 0.26381034232676026 },
      { x: 0.17668670460581778, y: 0.22360925279557703 },
    ];
    expect(inspectSimpleSplitPolygon(toleranceMaskedCrossing)).toBeNull();
  });

  it("uses exact status ordering when a nearly collinear neighbor would mask a later crossing", () => {
    expect(
      inspectSimpleSplitPolygon([
        { x: 0.4, y: 0.7 },
        { x: 0.8, y: 0.7 },
        { x: 0.7, y: 0.5 },
        { x: 0.2, y: 0.6 },
        { x: 0.7, y: 0.1 },
        { x: 0.3, y: 0.5 },
        { x: 0.2, y: 0.8 },
      ]),
    ).toBeNull();
  });

  it("uses exact departure ordering when a floating slope tie would mask a crossing", () => {
    expect(
      hasSimplePolygonBoundary([
        { x: 0.336984948720783, y: 0.36619665045291183 },
        { x: 0.4280751151312344, y: 0.2997970385435129 },
        { x: 0.3543613928896202, y: 0.3535301992360255 },
        { x: 0.4188700424142453, y: 0.3065070192153206 },
        { x: 0.5543380799234712, y: 0.20775843337775612 },
      ]),
    ).toBe(false);
  });

  it("rejects a repeated non-neighbor boundary vertex", () => {
    expect(
      inspectSimpleSplitPolygon([
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.5, y: 0.5 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 },
        { x: 0.5, y: 0.5 },
      ]),
    ).toBeNull();
  });

  it("accepts mathematically disjoint near-contact edges above the minimum point resolution", () => {
    expect(
      inspectSimpleSplitPolygon([
        { x: 0.40000000000483177, y: 0.4000000000034386 },
        { x: 0.400000000003167, y: 0.40000000000390373 },
        { x: 0.4000000000021589, y: 0.40000000000218067 },
        { x: 0.40000000000298574, y: 0.40000000000068475 },
        { x: 0.4000000000018587, y: 0.400000000000619 },
        { x: 0.4000000000001125, y: 0.400000000000668 },
        { x: 0.4579616693779826, y: 0.060182562074624 },
        { x: 0.07699831589125097, y: 0.8342200600774959 },
        { x: 0.5915984390769154, y: 0.5042656781384721 },
      ]),
    ).not.toBeNull();
  });

  it("pins conservation, measurement ratio, and the exact float4 bbox tolerance", () => {
    expect(splitAreasConserve(1, 0.4, 0.6)).toBe(true);
    expect(splitAreasConserve(1, 0.4, 0.61)).toBe(false);
    expect(splitMeasurementsMatchGeometry(40, 60, 0.4, 0.6)).toBe(true);
    expect(splitMeasurementsMatchGeometry(40, 61, 0.4, 0.6)).toBe(false);
    expect(storedSplitBboxMatches([0, 0, 1, 1], [1e-6, 0, 1, 1])).toBe(true);
    expect(storedSplitBboxMatches([0, 0, 1, 1], [1.000_001e-6, 0, 1, 1])).toBe(
      false,
    );
  });
});
