/**
 * bucket-fill.worker.ts — Client-side bucket fill via WebWorker.
 *
 * MS-Paint model: one pass, no retry, no leak heuristic. Stops only at dark
 * pixels after morphological closing. Barriers are the user-facing control
 * for sealing unintended leaks. Text is treated as walls — the flood stops
 * at letter boundaries the same way it stops at real line-art walls. (If a
 * future feature needs to account for text-inside-room area, it adds back
 * real-world area of fully-enclosed text bboxes after the flood.)
 *
 * Pipeline: receive ImageBitmap → downscale + grayscale (GPU filter) → Otsu
 * threshold + binarize → morph close (user dilation knob) → burn user barriers
 * + polygon exclusions → flood fill → trace outer border → trace enclosed
 * holes → Douglas-Peucker simplify → normalize → return.
 *
 * Target: <400ms for a typical blueprint page.
 */

import {
  burnLine,
  fillPolygonOnBinary,
  findHoleBorders,
} from "@/lib/bucket-fill-mask-ops";

// ⚠ MANDATORY RE-EXPORT, not cosmetic. `findHoleBorders` moved to bucket-fill-mask-ops.ts,
// but two test files import it from THIS module and the phase-1 gate forbids editing tests:
//   src/lib/__tests__/bucket-fill-hole-detection.test.ts
//   src/lib/__tests__/bucket-fill-worker-perf-parity.test.ts
// NOTE: it is IMPORTED above as well as re-exported. `export { x } from "..."` alone would not
// bind `x` in this module's scope, and processFill calls it directly.
//
// The "@/" alias is this codebase's convention (3,356 alias imports vs 671 relative), so it is
// used here. NOTE for tooling: bare node does not resolve "@/" or extensionless .ts, and the
// accuracy harness imports this worker directly to drive the legacy leg. That is handled in the
// TOOLING (scripts/probes/_ts-resolve.mjs), not by making this file non-idiomatic.
export { findHoleBorders };

export interface BucketFillRequest {
  requestId: number;
  imageBitmap: ImageBitmap;
  seedX: number; // normalized 0-1
  seedY: number;
  tolerance: number;
  dilation: number;
  barriers: { x1: number; y1: number; x2: number; y2: number }[];
  polygonBarriers: { vertices: { x: number; y: number }[] }[];
  /** Textract word bounding boxes, normalized 0-1 [x, y, w, h]. Set to white
   *  (passable) before flood so the fill isn't blocked by text inside rooms. */
  textBboxes?: { x: number; y: number; w: number; h: number }[];
  maxDimension?: number;
}

export interface BucketFillResult {
  requestId: number;
  type: "result" | "error";
  vertices?: { x: number; y: number }[];
  /** Inner hole polygons (e.g., courtyards inside a U-shaped hallway). Each is a
   *  closed polygon in normalized 0–1 coordinates. Empty if no holes. */
  holes?: { vertices: { x: number; y: number }[] }[];
  holeCount?: number;
  /** Net area as fraction of page (filled pixels, already excludes holes). */
  areaFraction?: number;
  method?: string;
  error?: string;
}

// ─── Image processing primitives ─────────────────────────────────

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;

/** Build the grayscale-channel histogram and, when requested, prove that an
 * unfiltered neutral-raster draw is safe. The word path is guarded so unusual
 * endianness or alignment retains the byte-wise behavior. */
export function bucketRgbaHistogram(
  rgba: Uint8ClampedArray,
  pixelCount: number,
  checkFilterSafety: boolean,
): { hist: Int32Array; filterSafe: boolean } {
  const hist = new Int32Array(256);
  let filterSafe = true;
  if (LITTLE_ENDIAN && (rgba.byteOffset & 3) === 0 && rgba.byteLength >= pixelCount * 4) {
    const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      const pixel = pixels[i];
      hist[pixel & 255]++;
      if (checkFilterSafety && filterSafe && (
        ((pixel ^ (pixel >>> 8)) & 0xffff) !== 0 ||
        (pixel >>> 24) !== 255
      )) filterSafe = false;
    }
    return { hist, filterSafe };
  }

  for (let i = 0, offset = 0; i < pixelCount; i++, offset += 4) {
    const value = rgba[offset];
    hist[value]++;
    if (checkFilterSafety && filterSafe && (
      value !== rgba[offset + 1] ||
      value !== rgba[offset + 2] ||
      rgba[offset + 3] !== 255
    )) filterSafe = false;
  }
  return { hist, filterSafe };
}

export function bucketRgbaBinarize(
  rgba: Uint8ClampedArray,
  pixelCount: number,
  threshold: number,
): Uint8Array {
  const bin = new Uint8Array(pixelCount);
  if (LITTLE_ENDIAN && (rgba.byteOffset & 3) === 0 && rgba.byteLength >= pixelCount * 4) {
    const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, pixelCount);
    for (let i = 0; i < pixelCount; i++) bin[i] = (pixels[i] & 255) > threshold ? 255 : 0;
    return bin;
  }
  for (let i = 0, offset = 0; i < pixelCount; i++, offset += 4) {
    bin[i] = rgba[offset] > threshold ? 255 : 0;
  }
  return bin;
}

/**
 * Downscale, grayscale, compute Otsu's threshold, and binarize without an
 * intermediate N-byte grayscale copy. Neutral source pixels are already
 * grayscale, so their values are used directly; colored rasters take the
 * original canvas-filter path before thresholding.
 *
 * `tolerance` shifts Otsu's threshold. Walls are dark (0), rooms are light
 * (255), and a pixel is passable when its grayscale value is greater than the
 * adjusted threshold. The default tolerance of 30 preserves pure Otsu.
 */
function downscaleAndBinarize(
  bitmap: ImageBitmap,
  maxDim: number,
  tolerance: number,
): { bin: Uint8Array; w: number; h: number } {
  const ow = bitmap.width;
  const oh = bitmap.height;
  const ratio = Math.min(maxDim / ow, maxDim / oh, 1);
  const w = Math.round(ow * ratio);
  const h = Math.round(oh * ratio);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  let rgba = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  let { hist, filterSafe } = bucketRgbaHistogram(rgba, n, true);

  // Filtered and unfiltered downscaling are byte-identical only for opaque
  // neutral pixels. Colored or translucent rasters retain the legacy filtered
  // draw; clearing first restores its original transparent backing store.
  if (!filterSafe) {
    ctx.clearRect(0, 0, w, h);
    ctx.filter = "grayscale(1)";
    ctx.drawImage(bitmap, 0, 0, w, h);
    rgba = ctx.getImageData(0, 0, w, h).data;
    ({ hist } = bucketRgbaHistogram(rgba, n, false));
  }

  // Deriving the sum from 256 bins is mathematically identical and avoids a
  // second accumulator update in the 10.7M-pixel hot loop.
  let sum = 0;
  for (let value = 0; value < hist.length; value++) sum += value * hist[value];

  let sumB = 0, wB = 0;
  let maxVar = 0, threshold = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; threshold = t; }
  }

  const adjustedThreshold = Math.max(0, Math.min(255, threshold + (30 - tolerance)));

  const bin = bucketRgbaBinarize(rgba, n, adjustedThreshold);
  return { bin, w, h };
}

// ─── Bit-packed morphological close ──────────────────────────────

/** Scalar exact fallback for out-of-contract radii that cannot use 32-bit shifts. */
function expandValueSeparable(
  input: Uint8Array,
  w: number,
  h: number,
  radius: number,
  target: 0 | 255,
): Uint8Array {
  const horizontal = new Uint8Array(input.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      horizontal[row + x] = 255 - target;
      for (let nx = x0; nx <= x1; nx++) {
        if (input[row + nx] === target) { horizontal[row + x] = target; break; }
      }
    }
  }
  const output = new Uint8Array(input.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      output[row + x] = 255 - target;
      for (let ny = y0; ny <= y1; ny++) {
        if (horizontal[ny * w + x] === target) { output[row + x] = target; break; }
      }
    }
  }
  return output;
}

function dilateBitset(
  input: Uint32Array,
  horizontal: Uint32Array,
  output: Uint32Array,
  wordsPerRow: number,
  w: number,
  h: number,
  radius: number,
): void {
  const tailBits = w & 31;
  const tailMask = tailBits === 0 ? 0xffffffff : (0xffffffff >>> (32 - tailBits));
  for (let y = 0; y < h; y++) {
    const row = y * wordsPerRow;
    for (let wordIndex = 0; wordIndex < wordsPerRow; wordIndex++) {
      const index = row + wordIndex;
      const word = input[index];
      let expanded = word;
      for (let distance = 1; distance <= radius; distance++) {
        expanded |= (word << distance) | (word >>> distance);
        if (wordIndex > 0) expanded |= input[index - 1] >>> (32 - distance);
        if (wordIndex + 1 < wordsPerRow) expanded |= input[index + 1] << (32 - distance);
      }
      horizontal[index] = wordIndex + 1 === wordsPerRow ? expanded & tailMask : expanded;
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * wordsPerRow;
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let wordIndex = 0; wordIndex < wordsPerRow; wordIndex++) {
      let expanded = 0;
      for (let sourceY = y0; sourceY <= y1; sourceY++) {
        expanded |= horizontal[sourceY * wordsPerRow + wordIndex];
      }
      output[row + wordIndex] = expanded;
    }
  }
}

/**
 * Close dark walls with the same clipped square kernel as the legacy
 * separable implementation. Packing 32 binary pixels per word removes the
 * per-pixel neighborhood walk at the 4000px resolution setting.
 */
export function morphClose(
  bin: Uint8Array,
  w: number,
  h: number,
  radius: number,
): Uint8Array {
  if (radius <= 0) return new Uint8Array(bin);
  if (radius > 31) {
    return expandValueSeparable(
      expandValueSeparable(bin, w, h, radius, 0),
      w, h, radius, 255,
    );
  }

  const wordsPerRow = Math.ceil(w / 32);
  const packed = new Uint32Array(wordsPerRow * h);
  const horizontal = new Uint32Array(packed.length);
  const expanded = new Uint32Array(packed.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const packedRow = y * wordsPerRow;
    for (let x = 0; x < w; x++) {
      if (bin[row + x] === 0) packed[packedRow + (x >>> 5)] |= 1 << (x & 31);
    }
  }

  dilateBitset(packed, horizontal, expanded, wordsPerRow, w, h, radius);
  const tailBits = w & 31;
  const tailMask = tailBits === 0 ? 0xffffffff : (0xffffffff >>> (32 - tailBits));
  for (let y = 0; y < h; y++) {
    const row = y * wordsPerRow;
    for (let wordIndex = 0; wordIndex < wordsPerRow; wordIndex++) {
      const mask = wordIndex + 1 === wordsPerRow ? tailMask : 0xffffffff;
      packed[row + wordIndex] = (~expanded[row + wordIndex]) & mask;
    }
  }
  dilateBitset(packed, horizontal, expanded, wordsPerRow, w, h, radius);

  const output = new Uint8Array(bin.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const packedRow = y * wordsPerRow;
    for (let x = 0; x < w; x++) {
      output[row + x] = (expanded[packedRow + (x >>> 5)] & (1 << (x & 31))) !== 0 ? 255 : 0;
    }
  }
  return output;
}


export interface SolidRoomRectangle {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Prove that the entire binary raster is one solid white rectangle on a black
 * background. A square morphological close is the identity for that shape as
 * long as the room survives the dilation radius.
 */
export function detectSolidRoomRectangle(
  bin: Uint8Array,
  w: number,
  h: number,
  radius: number,
): SolidRoomRectangle | null {
  const firstWhite = bin.indexOf(255);
  if (firstWhite < 0) return null;
  const minY = Math.floor(firstWhite / w);
  const minX = firstWhite - minY * w;
  const firstRowEnd = (minY + 1) * w;
  const firstBlack = bin.indexOf(0, firstWhite);
  const maxXExclusive = firstBlack < 0 || firstBlack >= firstRowEnd
    ? w
    : firstBlack - minY * w;
  if (maxXExclusive <= minX) return null;
  const firstExtraWhite = bin.indexOf(255, minY * w + maxXExclusive);
  if (firstExtraWhite >= 0 && firstExtraWhite < firstRowEnd) return null;

  let maxYExclusive = h;
  for (let y = minY; y < h; y++) {
    const row = y * w;
    const rowEnd = row + w;
    const rowFirstWhite = bin.indexOf(255, row);
    if (rowFirstWhite < 0 || rowFirstWhite >= rowEnd) {
      maxYExclusive = y;
      break;
    }
    if (rowFirstWhite !== row + minX) return null;
    const rowFirstBlack = bin.indexOf(0, row + minX);
    const rowMaxXExclusive = rowFirstBlack < 0 || rowFirstBlack >= rowEnd
      ? w
      : rowFirstBlack - row;
    if (rowMaxXExclusive !== maxXExclusive) return null;
    const rowExtraWhite = bin.indexOf(255, row + maxXExclusive);
    if (rowExtraWhite >= 0 && rowExtraWhite < rowEnd) return null;
  }
  if (bin.indexOf(255, maxYExclusive * w) >= 0) return null;
  if (maxXExclusive - minX <= radius * 2 || maxYExclusive - minY <= radius * 2) return null;
  return {
    minX,
    minY,
    maxX: maxXExclusive - 1,
    maxY: maxYExclusive - 1,
  };
}

// ─── Scanline flood fill ─────────────────────────────────────────

export interface FloodFillState extends SolidRoomRectangle {
  filled: Uint8Array;
  area: number;
  firstIndex: number;
}

export function floodSolidRoomRectangle(
  rectangle: SolidRoomRectangle,
  w: number,
  h: number,
): FloodFillState {
  const filled = new Uint8Array(w * h);
  for (let y = rectangle.minY; y <= rectangle.maxY; y++) {
    filled.fill(1, y * w + rectangle.minX, y * w + rectangle.maxX + 1);
  }
  return {
    filled,
    area: (rectangle.maxX - rectangle.minX + 1) * (rectangle.maxY - rectangle.minY + 1),
    ...rectangle,
    firstIndex: rectangle.minY * w + rectangle.minX,
  };
}

export function floodFill(
  bin: Uint8Array, w: number, h: number,
  seedX: number, seedY: number
): FloodFillState {
  const filled = new Uint8Array(w * h);
  if (bin[seedY * w + seedX] === 0) {
    return { filled, area: 0, minX: w, minY: h, maxX: -1, maxY: -1, firstIndex: -1 };
  }

  const stack: [number, number][] = [[seedX, seedY]];
  const seedIndex = seedY * w + seedX;
  filled[seedIndex] = 1;
  let area = 1;
  let minX = seedX, maxX = seedX, minY = seedY, maxY = seedY;
  let firstIndex = seedIndex;

  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    const row = y * w;
    let lx = x;
    while (lx > 0 && bin[row + lx - 1] !== 0 && !filled[row + lx - 1]) {
      lx--; filled[row + lx] = 1;
    }
    let rx = x;
    while (rx < w - 1 && bin[row + rx + 1] !== 0 && !filled[row + rx + 1]) {
      rx++; filled[row + rx] = 1;
    }
    // The seed was counted when queued; every other pixel newly claimed by
    // this horizontal span is counted here without a second full-mask pass.
    area += rx - lx;
    if (lx < minX) minX = lx;
    if (rx > maxX) maxX = rx;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (row + lx < firstIndex) firstIndex = row + lx;
    for (let direction = -1; direction <= 1; direction += 2) {
      const ny = y + direction;
      if (ny < 0 || ny >= h) continue;
      const neighborRow = ny * w;
      let inSpan = false;
      for (let px = lx; px <= rx; px++) {
        if (bin[neighborRow + px] !== 0 && !filled[neighborRow + px]) {
          if (!inSpan) {
            stack.push([px, ny]);
            filled[neighborRow + px] = 1;
            area++;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (ny < minY) minY = ny;
            if (ny > maxY) maxY = ny;
            if (neighborRow + px < firstIndex) firstIndex = neighborRow + px;
            inSpan = true;
          }
        } else { inSpan = false; }
      }
    }
  }
  return { filled, area, minX, minY, maxX, maxY, firstIndex };
}

// ─── Border tracing (Moore neighbor) ─────────────────────────────

export function traceBorder(
  filled: Uint8Array,
  w: number,
  h: number,
  knownFirstIndex = -1,
): { x: number; y: number }[] {
  let startX = -1, startY = -1;
  if (knownFirstIndex >= 0 && filled[knownFirstIndex]) {
    startX = knownFirstIndex % w;
    startY = (knownFirstIndex - startX) / w;
  } else {
    outer: for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (filled[y * w + x]) { startX = x; startY = y; break outer; }
      }
    }
  }
  if (startX < 0) return [];

  const border: { x: number; y: number }[] = [];
  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];
  let cx = startX, cy = startY, dir = 7;
  const maxIter = w * h * 2;
  let iter = 0;

  do {
    border.push({ x: cx, y: cy });
    const startDir = (dir + 5) % 8;
    let found = false;
    for (let i = 0; i < 8; i++) {
      const d = (startDir + i) % 8;
      const nx = cx + dx[d], ny = cy + dy[d];
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && filled[ny * w + nx]) {
        dir = d; cx = nx; cy = ny; found = true; break;
      }
    }
    if (!found) break;
    iter++;
  } while ((cx !== startX || cy !== startY) && iter < maxIter);
  return border;
}

// ─── Douglas-Peucker polygon simplification ──────────────────────

function douglasPeucker(points: { x: number; y: number }[], epsilon: number): { x: number; y: number }[] {
  if (points.length <= 2) return points;
  let maxDist = 0, maxIdx = 0;
  const start = points[0], end = points[points.length - 1];
  const ldx = end.x - start.x, ldy = end.y - start.y;
  const lenSq = ldx * ldx + ldy * ldy;
  for (let i = 1; i < points.length - 1; i++) {
    let dist: number;
    if (lenSq === 0) {
      const ddx = points[i].x - start.x, ddy = points[i].y - start.y;
      dist = Math.sqrt(ddx * ddx + ddy * ddy);
    } else {
      const t = Math.max(0, Math.min(1, ((points[i].x - start.x) * ldx + (points[i].y - start.y) * ldy) / lenSq));
      const ddx = points[i].x - (start.x + t * ldx), ddy = points[i].y - (start.y + t * ldy);
      dist = Math.sqrt(ddx * ddx + ddy * ddy);
    }
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [start, end];
}


// ─── Main pipeline ───────────────────────────────────────────────

/** Set every pixel inside the normalized bbox to 1 (white / passable). Used to
 *  erase OCR text so the flood sweeps through those pixels instead of stopping. */
function eraseBboxToWhite(
  bin: Uint8Array,
  w: number,
  h: number,
  bbox: { x: number; y: number; w: number; h: number }
): void {
  const x0 = Math.max(0, Math.floor(bbox.x * w));
  const y0 = Math.max(0, Math.floor(bbox.y * h));
  const x1 = Math.min(w, Math.ceil((bbox.x + bbox.w) * w));
  const y1 = Math.min(h, Math.ceil((bbox.y + bbox.h) * h));
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = x0; x < x1; x++) bin[row + x] = 1;
  }
}

function processFill(req: BucketFillRequest): Omit<BucketFillResult, "requestId"> {
  const maxDim = req.maxDimension ?? 1000;

  // 1–2. Downscale + grayscale/Otsu + binarize.
  const { bin, w, h } = downscaleAndBinarize(req.imageBitmap, maxDim, req.tolerance);
  req.imageBitmap.close();

  const seedPx = Math.max(0, Math.min(w - 1, Math.round(req.seedX * w)));
  const seedPy = Math.max(0, Math.min(h - 1, Math.round(req.seedY * h)));

  // 3. Morphological close — the user's Dilation knob controls how aggressive
  // this is (closes small gaps in line art like 1–2px door-frame breaks).
  // Dilation=0 truly skips morphClose, preserving every dark pixel as a wall
  // (the old `Math.max(1, ...)` clamp forced a 1-pixel kernel that was a
  // near-noop but still ran — users wanted an explicit "no smoothing" mode
  // for plans with thin-wall mullions where morphology bridged real gaps).
  const radius = req.dilation <= 0 ? 0 : Math.ceil(req.dilation / 2);
  const solidRoom = detectSolidRoomRectangle(bin, w, h, radius);
  const closed = radius > 0 && !solidRoom ? morphClose(bin, w, h, radius) : bin;

  // 4. Burn user-drawn barrier lines (explicit door seals).
  for (const b of req.barriers) {
    burnLine(closed, w, h,
      Math.round(b.x1 * w), Math.round(b.y1 * h),
      Math.round(b.x2 * w), Math.round(b.y2 * h), 3);
  }

  // 5. Burn polygon exclusions (existing takeoff polygons the user already
  //    captured — shouldn't be re-filled).
  for (const pe of req.polygonBarriers) {
    fillPolygonOnBinary(closed, w, h, pe.vertices);
  }

  // 6. Flood fill — one pass, no retry, no leak rejection. Stops only at dark
  //    pixels after everything above has been applied. Text is a dark region
  //    like any other; the flood stops at letter boundaries. Text bboxes are
  //    preserved on the request payload for a future Tier 2 pass that adds
  //    enclosed-text area back to the reported sqft.
  const canUseSolidRoomFlood = solidRoom !== null &&
    req.barriers.length === 0 &&
    req.polygonBarriers.length === 0 &&
    seedPx >= solidRoom.minX && seedPx <= solidRoom.maxX &&
    seedPy >= solidRoom.minY && seedPy <= solidRoom.maxY;
  const flood = canUseSolidRoomFlood
    ? floodSolidRoomRectangle(solidRoom!, w, h)
    : floodFill(closed, w, h, seedPx, seedPy);
  const { filled, area } = flood;

  // 8. Net area was counted as pixels were first marked by the flood. Holes
  //    stay zero, so no second full-raster pass is required.

  if (area < 20) {
    return { type: "error", error: "Bad click — no connected region at that pixel" };
  }

  // 9. Border trace (outer contour). Holes traced separately so the preview
  //    can render with fill-rule="evenodd".
  const border = traceBorder(filled, w, h, flood.firstIndex);
  if (border.length < 3) {
    return { type: "error", error: "Filled region too small to trace a polygon" };
  }

  // 10. Find + trace enclosed holes (e.g., courtyard in a U-shaped hallway).
  const fillsBoundingBox = area ===
    (flood.maxX - flood.minX + 1) * (flood.maxY - flood.minY + 1);
  const holeBorders = fillsBoundingBox ? [] : findHoleBorders(filled, w, h, flood);

  // 11. Douglas-Peucker simplify outer + holes
  const epsilon = Math.max(w, h) * 0.005;
  const simplified = douglasPeucker(border, epsilon);
  if (simplified.length < 3) {
    return { type: "error", error: "Simplified polygon has too few vertices" };
  }

  // 12. Normalize outer to 0-1
  const vertices = simplified.map((p) => ({ x: p.x / w, y: p.y / h }));

  // 13. Simplify + normalize holes; drop degenerate ones
  const holes: { vertices: { x: number; y: number }[] }[] = [];
  for (const hb of holeBorders) {
    const hSimp = douglasPeucker(hb, epsilon);
    if (hSimp.length < 3) continue;
    holes.push({ vertices: hSimp.map((p) => ({ x: p.x / w, y: p.y / h })) });
  }

  return {
    type: "result",
    vertices,
    holes,
    holeCount: holes.length,
    areaFraction: area / (w * h),
    method: "client-raster",
  };
}

// ─── Worker message handler ──────────────────────────────────────

self.addEventListener("message", (e: MessageEvent<BucketFillRequest>) => {
  const requestId = e.data.requestId;
  try {
    const result = processFill(e.data);
    (self as unknown as Worker).postMessage({ requestId, ...result } satisfies BucketFillResult);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      requestId,
      type: "error",
      error: err instanceof Error ? err.message : "Worker error",
    } satisfies BucketFillResult);
  }
});
