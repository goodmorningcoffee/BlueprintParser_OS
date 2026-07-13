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
  const hist = new Int32Array(256);
  let sum = 0;
  let neutral = true;
  for (let i = 0; i < n; i++) {
    const offset = i * 4;
    const v = rgba[offset];
    hist[v]++;
    sum += v;
    if (neutral && (v !== rgba[offset + 1] || v !== rgba[offset + 2])) neutral = false;
  }

  // A second draw is required only for colored input. Clearing first preserves
  // the old transparent-pixel/source-over behavior exactly.
  if (!neutral) {
    ctx.clearRect(0, 0, w, h);
    ctx.filter = "grayscale(1)";
    ctx.drawImage(bitmap, 0, 0, w, h);
    rgba = ctx.getImageData(0, 0, w, h).data;
    hist.fill(0);
    sum = 0;
    for (let i = 0; i < n; i++) {
      const v = rgba[i * 4];
      hist[v]++;
      sum += v;
    }
  }

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

  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = rgba[i * 4] > adjustedThreshold ? 255 : 0;
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

// ─── Burn barriers & polygon exclusions ──────────────────────────

function burnLine(
  bin: Uint8Array, w: number, h: number,
  x1: number, y1: number, x2: number, y2: number,
  thickness: number
) {
  const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
  const sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1;
  let err = dx - dy;
  let cx = x1, cy = y1;
  const r = Math.ceil(thickness / 2);
  while (true) {
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        const px = cx + ox, py = cy + oy;
        if (px >= 0 && px < w && py >= 0 && py < h) bin[py * w + px] = 0;
      }
    }
    if (cx === x2 && cy === y2) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; cx += sx; }
    if (e2 < dx) { err += dx; cy += sy; }
  }
}

function fillPolygonOnBinary(
  bin: Uint8Array, w: number, h: number,
  vertices: { x: number; y: number }[]
) {
  if (vertices.length < 3) return;
  const n = vertices.length;
  let minY = h, maxY = 0;
  for (const v of vertices) {
    const py = Math.round(v.y * h);
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  minY = Math.max(0, minY);
  maxY = Math.min(h - 1, maxY);
  for (let y = minY; y <= maxY; y++) {
    const intersections: number[] = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = vertices[i].y * h, yj = vertices[j].y * h;
      if ((yi > y) !== (yj > y)) {
        const xi = vertices[i].x * w, xj = vertices[j].x * w;
        intersections.push(Math.round(xi + ((y - yi) / (yj - yi)) * (xj - xi)));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let k = 0; k < intersections.length - 1; k += 2) {
      const xa = Math.max(0, intersections[k]);
      const xb = Math.min(w - 1, intersections[k + 1]);
      for (let x = xa; x <= xb; x++) bin[y * w + x] = 0;
    }
  }
}

// ─── Scanline flood fill ─────────────────────────────────────────

export function floodFill(
  bin: Uint8Array, w: number, h: number,
  seedX: number, seedY: number
): {
  filled: Uint8Array;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const filled = new Uint8Array(w * h);
  if (bin[seedY * w + seedX] === 0) {
    return { filled, area: 0, minX: w, minY: h, maxX: -1, maxY: -1 };
  }

  const stack: [number, number][] = [[seedX, seedY]];
  filled[seedY * w + seedX] = 1;
  let area = 1;
  let minX = seedX, maxX = seedX, minY = seedY, maxY = seedY;

  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    let lx = x;
    while (lx > 0 && bin[y * w + (lx - 1)] !== 0 && !filled[y * w + (lx - 1)]) {
      lx--; filled[y * w + lx] = 1;
    }
    let rx = x;
    while (rx < w - 1 && bin[y * w + (rx + 1)] !== 0 && !filled[y * w + (rx + 1)]) {
      rx++; filled[y * w + rx] = 1;
    }
    // The seed was counted when queued; every other pixel newly claimed by
    // this horizontal span is counted here without a second full-mask pass.
    area += rx - lx;
    if (lx < minX) minX = lx;
    if (rx > maxX) maxX = rx;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      let inSpan = false;
      for (let px = lx; px <= rx; px++) {
        if (bin[ny * w + px] !== 0 && !filled[ny * w + px]) {
          if (!inSpan) {
            stack.push([px, ny]);
            filled[ny * w + px] = 1;
            area++;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (ny < minY) minY = ny;
            if (ny > maxY) maxY = ny;
            inSpan = true;
          }
        } else { inSpan = false; }
      }
    }
  }
  return { filled, area, minX, minY, maxX, maxY };
}

// ─── Border tracing (Moore neighbor) ─────────────────────────────

export function traceBorder(filled: Uint8Array, w: number, h: number): { x: number; y: number }[] {
  let startX = -1, startY = -1;
  outer: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (filled[y * w + x]) { startX = x; startY = y; break outer; }
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

// ─── Hole detection ──────────────────────────────────────────────

/**
 * Find and trace holes in a filled binary region.
 *
 * Algorithm: flood from the image edges through unfilled pixels; anything
 * still unfilled afterward is enclosed-inside = a hole. Group connected hole
 * pixels into components and trace each one's border with the same Moore
 * neighbor routine used for the outer contour. This is the JS equivalent of
 * OpenCV's RETR_CCOMP hierarchy.
 */
export function findHoleBorders(filled: Uint8Array, w: number, h: number): { x: number; y: number }[][] {
  // marks: 0 = filled, 1 = outside-reachable-from-edge, 2 = enclosed (hole candidate)
  const marks = new Uint8Array(filled.length);
  for (let i = 0; i < filled.length; i++) marks[i] = filled[i] ? 0 : 2;

  // Seed the outside-flood from every image-edge unfilled pixel.
  const stack: number[] = [];
  for (let x = 0; x < w; x++) {
    if (marks[x] === 2) { marks[x] = 1; stack.push(x); }
    const bi = (h - 1) * w + x;
    if (marks[bi] === 2) { marks[bi] = 1; stack.push(bi); }
  }
  for (let y = 0; y < h; y++) {
    const li = y * w;
    if (marks[li] === 2) { marks[li] = 1; stack.push(li); }
    const ri = y * w + (w - 1);
    if (marks[ri] === 2) { marks[ri] = 1; stack.push(ri); }
  }

  // 4-connected flood through unfilled pixels.
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0 && marks[i - 1] === 2) { marks[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && marks[i + 1] === 2) { marks[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && marks[i - w] === 2) { marks[i - w] = 1; stack.push(i - w); }
    if (y < h - 1 && marks[i + w] === 2) { marks[i + w] = 1; stack.push(i + w); }
  }

  // Anything still at mark==2 is enclosed. Group into components and trace.
  const holePolys: { x: number; y: number }[][] = [];
  const visited = new Uint8Array(filled.length);
  for (let i = 0; i < marks.length; i++) {
    if (marks[i] !== 2 || visited[i]) continue;
    const holeMask = new Uint8Array(filled.length);
    const bfs: number[] = [i];
    visited[i] = 1;
    holeMask[i] = 1;
    while (bfs.length) {
      const j = bfs.pop()!;
      const x = j % w;
      const y = (j - x) / w;
      if (x > 0 && marks[j - 1] === 2 && !visited[j - 1]) {
        visited[j - 1] = 1; holeMask[j - 1] = 1; bfs.push(j - 1);
      }
      if (x < w - 1 && marks[j + 1] === 2 && !visited[j + 1]) {
        visited[j + 1] = 1; holeMask[j + 1] = 1; bfs.push(j + 1);
      }
      if (y > 0 && marks[j - w] === 2 && !visited[j - w]) {
        visited[j - w] = 1; holeMask[j - w] = 1; bfs.push(j - w);
      }
      if (y < h - 1 && marks[j + w] === 2 && !visited[j + w]) {
        visited[j + w] = 1; holeMask[j + w] = 1; bfs.push(j + w);
      }
    }
    const border = traceBorder(holeMask, w, h);
    if (border.length >= 3) holePolys.push(border);
  }
  return holePolys;
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
  const closed = radius > 0 ? morphClose(bin, w, h, radius) : bin;

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
  const flood = floodFill(closed, w, h, seedPx, seedPy);
  const { filled, area } = flood;

  // 8. Net area was counted as pixels were first marked by the flood. Holes
  //    stay zero, so no second full-raster pass is required.

  if (area < 20) {
    return { type: "error", error: "Bad click — no connected region at that pixel" };
  }

  // 9. Border trace (outer contour). Holes traced separately so the preview
  //    can render with fill-rule="evenodd".
  const border = traceBorder(filled, w, h);
  if (border.length < 3) {
    return { type: "error", error: "Filled region too small to trace a polygon" };
  }

  // 10. Find + trace enclosed holes (e.g., courtyard in a U-shaped hallway).
  const fillsBoundingBox = area ===
    (flood.maxX - flood.minX + 1) * (flood.maxY - flood.minY + 1);
  const holeBorders = fillsBoundingBox ? [] : findHoleBorders(filled, w, h);

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
