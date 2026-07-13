/**
 * Differential guardrails for the 4000px client bucket-fill fast path.
 *
 * The references deliberately use simple scalar algorithms. They pin the
 * byte-level morphology and 4-connected flood contracts independently of the
 * packed/scanline implementations in the worker.
 */
import { describe, expect, it } from "vitest";
import {
  bucketRgbaBinarize,
  bucketRgbaHistogram,
  detectSolidRoomRectangle,
  findHoleBorders,
  floodFill,
  floodSolidRoomRectangle,
  morphClose,
  traceBorder,
} from "@/workers/bucket-fill.worker";

function expandReference(
  input: Uint8Array,
  w: number,
  h: number,
  radius: number,
  target: 0 | 255,
): Uint8Array {
  const horizontal = new Uint8Array(input.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let found = false;
      for (let nx = Math.max(0, x - radius); nx <= Math.min(w - 1, x + radius); nx++) {
        if (input[y * w + nx] === target) { found = true; break; }
      }
      horizontal[y * w + x] = found ? target : 255 - target;
    }
  }
  const output = new Uint8Array(input.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let found = false;
      for (let ny = Math.max(0, y - radius); ny <= Math.min(h - 1, y + radius); ny++) {
        if (horizontal[ny * w + x] === target) { found = true; break; }
      }
      output[y * w + x] = found ? target : 255 - target;
    }
  }
  return output;
}

function closeReference(input: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  return expandReference(expandReference(input, w, h, radius, 0), w, h, radius, 255);
}

function randomBinary(length: number, seed: number): Uint8Array {
  let state = seed >>> 0;
  return Uint8Array.from({ length }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 31) === 0 ? 0 : 255;
  });
}

function masks(w: number, h: number): Uint8Array[] {
  const n = w * h;
  const edgeImpulse = new Uint8Array(n).fill(255);
  edgeImpulse[0] = 0;
  edgeImpulse[w - 1] = 0;
  edgeImpulse[(h - 1) * w] = 0;
  edgeImpulse[n - 1] = 0;
  return [
    new Uint8Array(n),
    new Uint8Array(n).fill(255),
    Uint8Array.from({ length: n }, (_, index) => ((index + Math.floor(index / w)) & 1) ? 255 : 0),
    edgeImpulse,
    randomBinary(n, w * 1009 + h * 9176),
    randomBinary(n, w * 7919 + h * 104729),
  ];
}

function floodReference(
  bin: Uint8Array,
  w: number,
  h: number,
  seedX: number,
  seedY: number,
) {
  const filled = new Uint8Array(bin.length);
  if (bin[seedY * w + seedX] === 0) {
    return { filled, area: 0, minX: w, minY: h, maxX: -1, maxY: -1, firstIndex: -1 };
  }
  const queue = [seedY * w + seedX];
  filled[queue[0]] = 1;
  let area = 0;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  let firstIndex = bin.length;
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head];
    const x = index % w;
    const y = (index - x) / w;
    area++;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    firstIndex = Math.min(firstIndex, index);
    const neighbors = [
      x > 0 ? index - 1 : -1,
      x + 1 < w ? index + 1 : -1,
      y > 0 ? index - w : -1,
      y + 1 < h ? index + w : -1,
    ];
    for (const neighbor of neighbors) {
      if (neighbor >= 0 && bin[neighbor] !== 0 && !filled[neighbor]) {
        filled[neighbor] = 1;
        queue.push(neighbor);
      }
    }
  }
  return { filled, area, minX, minY, maxX, maxY, firstIndex };
}

function rgbaHistogramReference(
  rgba: Uint8ClampedArray,
  pixelCount: number,
  checkFilterSafety: boolean,
) {
  const hist = new Int32Array(256);
  let filterSafe = true;
  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4;
    const value = rgba[offset];
    hist[value]++;
    if (checkFilterSafety && (
      value !== rgba[offset + 1] ||
      value !== rgba[offset + 2] ||
      rgba[offset + 3] !== 255
    )) filterSafe = false;
  }
  return { hist, filterSafe };
}

describe("bucket worker 4000px fast-path parity", () => {
  it("matches byte-wise RGBA histograms and opaque-neutral safety checks", () => {
    const opaqueNeutral = new Uint8ClampedArray(257 * 4);
    for (let i = 0; i < 257; i++) {
      const value = (i * 73) & 255;
      opaqueNeutral.set([value, value, value, 255], i * 4);
    }
    expect(bucketRgbaHistogram(opaqueNeutral, 257, true))
      .toEqual(rgbaHistogramReference(opaqueNeutral, 257, true));
    expect(bucketRgbaHistogram(opaqueNeutral, 257, false))
      .toEqual(rgbaHistogramReference(opaqueNeutral, 257, false));

    const colored = new Uint8ClampedArray(opaqueNeutral);
    colored[41] ^= 17;
    colored[4 * 88 + 3] = 127;
    expect(bucketRgbaHistogram(colored, 257, true))
      .toEqual(rgbaHistogramReference(colored, 257, true));

    const unalignedBacking = new Uint8ClampedArray(colored.length + 1);
    unalignedBacking.set(colored, 1);
    const unaligned = new Uint8ClampedArray(
      unalignedBacking.buffer,
      unalignedBacking.byteOffset + 1,
      colored.length,
    );
    expect(bucketRgbaHistogram(unaligned, 257, true))
      .toEqual(rgbaHistogramReference(unaligned, 257, true));
    for (const threshold of [0, 37, 127, 254, 255]) {
      const expected = Uint8Array.from({ length: 257 }, (_, index) =>
        colored[index * 4] > threshold ? 255 : 0);
      expect(bucketRgbaBinarize(colored, 257, threshold)).toEqual(expected);
      expect(bucketRgbaBinarize(unaligned, 257, threshold)).toEqual(expected);
    }
  });

  it("matches the scalar clipped close across word boundaries and radii 0-5", () => {
    for (const w of [1, 2, 3, 31, 32, 33, 63, 64, 65]) {
      for (const h of [1, 2, 3, 5]) {
        for (const radius of [0, 1, 2, 3, 4, 5]) {
          for (const input of masks(w, h)) {
            expect(morphClose(input, w, h, radius)).toEqual(closeReference(input, w, h, radius));
          }
        }
      }
    }
  });

  it("keeps the exact scalar fallback for radii beyond one bit word", () => {
    const w = 7, h = 5, radius = 32;
    const input = randomBinary(w * h, 0x5eed);
    expect(morphClose(input, w, h, radius)).toEqual(closeReference(input, w, h, radius));
  });

  it("proves solid rectangles are morphology identities and floods them exactly", () => {
    for (const { w, h, minX, minY, maxX, maxY } of [
      { w: 17, h: 13, minX: 0, minY: 0, maxX: 12, maxY: 10 },
      { w: 33, h: 19, minX: 5, minY: 3, maxX: 27, maxY: 15 },
      { w: 65, h: 21, minX: 17, minY: 0, maxX: 64, maxY: 20 },
    ]) {
      const input = new Uint8Array(w * h);
      for (let y = minY; y <= maxY; y++) {
        input.fill(255, y * w + minX, y * w + maxX + 1);
      }
      for (const radius of [0, 1, 2, 3, 4, 5]) {
        if (maxX - minX + 1 <= radius * 2 || maxY - minY + 1 <= radius * 2) continue;
        const rectangle = detectSolidRoomRectangle(input, w, h, radius);
        expect(rectangle).toEqual({ minX, minY, maxX, maxY });
        expect(morphClose(input, w, h, radius)).toEqual(input);
        expect(floodSolidRoomRectangle(rectangle!, w, h))
          .toEqual(floodFill(input, w, h, minX, minY));
      }
    }

    const punctured = new Uint8Array(20 * 16);
    for (let y = 3; y <= 12; y++) punctured.fill(255, y * 20 + 4, y * 20 + 16);
    punctured[8 * 20 + 9] = 0;
    expect(detectSolidRoomRectangle(punctured, 20, 16, 2)).toBeNull();
    punctured[8 * 20 + 9] = 255;
    punctured[15 * 20 + 19] = 255;
    expect(detectSolidRoomRectangle(punctured, 20, 16, 2)).toBeNull();

    const tooNarrow = new Uint8Array(9 * 9);
    for (let y = 2; y <= 6; y++) tooNarrow.fill(255, y * 9 + 3, y * 9 + 6);
    expect(detectSolidRoomRectangle(tooNarrow, 9, 9, 2)).toBeNull();
  });

  it("matches an independent BFS mask, area, and bounds oracle", () => {
    for (const [w, h] of [[1, 1], [3, 4], [17, 9], [33, 5]] as const) {
      for (const bin of masks(w, h)) {
        for (const [seedX, seedY] of [[0, 0], [w - 1, h - 1], [Math.floor(w / 2), Math.floor(h / 2)]]) {
          const actual = floodFill(bin, w, h, seedX, seedY);
          expect(actual).toEqual(floodReference(bin, w, h, seedX, seedY));
          expect(traceBorder(actual.filled, w, h, actual.firstIndex))
            .toEqual(traceBorder(actual.filled, w, h));
        }
      }
    }
  });

  it("proves the rectangular no-hole shortcut and rejects a punctured rectangle", () => {
    const w = 20, h = 16;
    const solid = new Uint8Array(w * h);
    for (let y = 3; y <= 12; y++) {
      for (let x = 4; x <= 15; x++) solid[y * w + x] = 255;
    }
    const solidFlood = floodFill(solid, w, h, 8, 8);
    expect(solidFlood.area).toBe(
      (solidFlood.maxX - solidFlood.minX + 1) * (solidFlood.maxY - solidFlood.minY + 1),
    );
    expect(findHoleBorders(solidFlood.filled, w, h)).toEqual([]);

    const punctured = new Uint8Array(solid);
    for (let y = 7; y <= 9; y++) {
      for (let x = 8; x <= 10; x++) punctured[y * w + x] = 0;
    }
    const puncturedFlood = floodFill(punctured, w, h, 7, 8);
    expect(puncturedFlood.area).not.toBe(
      (puncturedFlood.maxX - puncturedFlood.minX + 1) *
      (puncturedFlood.maxY - puncturedFlood.minY + 1),
    );
    expect(findHoleBorders(puncturedFlood.filled, w, h)).toHaveLength(1);
  });
});
