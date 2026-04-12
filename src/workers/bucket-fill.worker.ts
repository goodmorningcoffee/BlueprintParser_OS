/**
 * bucket-fill.worker.ts — Client-side bucket fill via WebWorker.
 *
 * Pipeline: receive ImageBitmap → downscale + grayscale (GPU filter) →
 * Otsu threshold + binarize (single pass) → separable morphological close →
 * burn barriers/exclusions → flood fill → leak-detect with auto-retry →
 * border trace → Douglas-Peucker simplify → normalize → return.
 *
 * Target: <400ms for a typical blueprint page.
 */

export interface BucketFillRequest {
  imageBitmap: ImageBitmap;
  seedX: number; // normalized 0-1
  seedY: number;
  tolerance: number;
  dilation: number;
  barriers: { x1: number; y1: number; x2: number; y2: number }[];
  polygonBarriers: { vertices: { x: number; y: number }[] }[];
  maxDimension?: number;
}

export interface BucketFillResult {
  type: "result" | "error";
  vertices?: { x: number; y: number }[];
  method?: string;
  error?: string;
  retries?: number;
}

// ─── Image processing primitives ─────────────────────────────────

/** Downscale + grayscale in one step using GPU-assisted canvas filter. */
function downscaleAndGrayscale(
  bitmap: ImageBitmap,
  maxDim: number
): { gray: Uint8Array; w: number; h: number } {
  const ow = bitmap.width;
  const oh = bitmap.height;
  const ratio = Math.min(maxDim / ow, maxDim / oh, 1);
  const w = Math.round(ow * ratio);
  const h = Math.round(oh * ratio);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  // GPU-assisted grayscale: browser composites in hardware
  ctx.filter = "grayscale(1)";
  ctx.drawImage(bitmap, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);

  // Extract R channel only (R=G=B after grayscale filter)
  const gray = new Uint8Array(w * h);
  const rgba = imgData.data;
  for (let i = 0; i < w * h; i++) gray[i] = rgba[i * 4];
  return { gray, w, h };
}

/** Otsu threshold + binarize in a single pass over the image. */
function otsuAndBinarize(gray: Uint8Array): Uint8Array {
  const n = gray.length;

  // Pass 1: build histogram + compute sum
  const hist = new Int32Array(256);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = gray[i];
    hist[v]++;
    sum += v;
  }

  // Find Otsu threshold
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

  // Pass 2: binarize
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = gray[i] > threshold ? 255 : 0;
  return bin;
}

// ─── Separable morphological operations (O(radius) per pixel) ────

/**
 * Dilate using separable kernels: horizontal pass then vertical pass.
 * For dilation with a square kernel, this is equivalent to the 2D version
 * but runs in O(w*h*radius) instead of O(w*h*radius²).
 * Wall = 0 (black), room = 255 (white). Dilation expands walls.
 */
function dilateSeparable(bin: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return new Uint8Array(bin);
  // Horizontal pass: expand walls left/right
  const hPass = new Uint8Array(bin.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let isWall = false;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      for (let nx = x0; nx <= x1; nx++) {
        if (bin[row + nx] === 0) { isWall = true; break; }
      }
      hPass[row + x] = isWall ? 0 : 255;
    }
  }
  // Vertical pass: expand walls up/down
  const out = new Uint8Array(bin.length);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let isWall = false;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(h - 1, y + radius);
      for (let ny = y0; ny <= y1; ny++) {
        if (hPass[ny * w + x] === 0) { isWall = true; break; }
      }
      out[y * w + x] = isWall ? 0 : 255;
    }
  }
  return out;
}

/** Erode using separable kernels. Shrinks walls. */
function erodeSeparable(bin: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return new Uint8Array(bin);
  // Horizontal pass
  const hPass = new Uint8Array(bin.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let allWall = true;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      for (let nx = x0; nx <= x1; nx++) {
        if (hPass[row + nx] !== 0 || bin[row + nx] !== 0) { allWall = false; break; }
      }
      // For erode: pixel is wall only if ALL neighbors are wall
      // But separable erode works differently — we need to check if all horizontal neighbors are wall
      hPass[row + x] = bin[row + x]; // Start with original
      for (let nx = x0; nx <= x1; nx++) {
        if (bin[row + nx] !== 0) { hPass[row + x] = 255; break; }
      }
      // Actually: erode = if ANY neighbor is room (255), pixel becomes room
      // No — erode wall: if ANY neighbor in kernel is room, result is room
      // This is: erode of walls = dilate of rooms
    }
  }
  // Simpler approach: erode(bin) = NOT dilate(NOT bin)
  // Invert, dilate, invert
  const inverted = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) inverted[i] = bin[i] === 0 ? 255 : 0;
  const dilated = dilateSeparable(inverted, w, h, radius);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = dilated[i] === 0 ? 255 : 0;
  return out;
}

/** Morphological close = dilate then erode. Seals small gaps. */
function morphClose(bin: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  return erodeSeparable(dilateSeparable(bin, w, h, radius), w, h, radius);
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

function floodFill(
  bin: Uint8Array, w: number, h: number,
  seedX: number, seedY: number
): Uint8Array {
  const filled = new Uint8Array(w * h);
  if (bin[seedY * w + seedX] === 0) return filled;

  const stack: [number, number][] = [[seedX, seedY]];
  filled[seedY * w + seedX] = 1;

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
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      let inSpan = false;
      for (let px = lx; px <= rx; px++) {
        if (bin[ny * w + px] !== 0 && !filled[ny * w + px]) {
          if (!inSpan) { stack.push([px, ny]); filled[ny * w + px] = 1; inSpan = true; }
        } else { inSpan = false; }
      }
    }
  }
  return filled;
}

// ─── Border tracing (Moore neighbor) ─────────────────────────────

function traceBorder(filled: Uint8Array, w: number, h: number): { x: number; y: number }[] {
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

// ─── Main pipeline ───────────────────────────────────────────────

function processFill(req: BucketFillRequest): BucketFillResult {
  const maxDim = req.maxDimension ?? 1000;

  // 1. Downscale + grayscale (GPU-assisted via OffscreenCanvas filter)
  const { gray, w, h } = downscaleAndGrayscale(req.imageBitmap, maxDim);
  req.imageBitmap.close();

  // 2. Otsu + binarize (single pass for histogram, single pass for threshold)
  const baseBin = otsuAndBinarize(gray);

  const seedPx = Math.max(0, Math.min(w - 1, Math.round(req.seedX * w)));
  const seedPy = Math.max(0, Math.min(h - 1, Math.round(req.seedY * h)));

  const LEAK_THRESHOLD = 0.25;
  const MAX_RETRIES = 3;
  let bestResult: { filled: Uint8Array; area: number } | null = null;
  let retries = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const radius = Math.max(1, Math.ceil(req.dilation / 2)) + attempt;

    // 3. Separable morphological close
    const closed = morphClose(new Uint8Array(baseBin), w, h, radius);

    // 4. Burn barriers
    for (const b of req.barriers) {
      burnLine(closed, w, h,
        Math.round(b.x1 * w), Math.round(b.y1 * h),
        Math.round(b.x2 * w), Math.round(b.y2 * h), 3);
    }

    // 5. Burn polygon exclusions
    for (const pe of req.polygonBarriers) {
      fillPolygonOnBinary(closed, w, h, pe.vertices);
    }

    // 6. Flood fill
    const filled = floodFill(closed, w, h, seedPx, seedPy);

    let area = 0;
    for (let i = 0; i < filled.length; i++) if (filled[i]) area++;

    if (area < 20) { retries++; continue; } // tiny speck, retry with more dilation

    const areaRatio = area / (w * h);
    if (!bestResult || (areaRatio <= LEAK_THRESHOLD && area > (bestResult.area / (w * h) <= LEAK_THRESHOLD ? bestResult.area : 0))) {
      bestResult = { filled, area };
    }
    if (areaRatio <= LEAK_THRESHOLD) break;
    retries++;
  }

  if (!bestResult || bestResult.area === 0) {
    return { type: "error", error: "Could not detect room boundary at click point" };
  }

  // 7. Border trace
  const border = traceBorder(bestResult.filled, w, h);
  if (border.length < 3) {
    return { type: "error", error: "Detected region too small" };
  }

  // 8. Simplify
  const epsilon = Math.max(w, h) * 0.005;
  const simplified = douglasPeucker(border, epsilon);
  if (simplified.length < 3) {
    return { type: "error", error: "Simplified polygon has too few vertices" };
  }

  // 9. Normalize to 0-1
  const vertices = simplified.map((p) => ({ x: p.x / w, y: p.y / h }));

  return { type: "result", vertices, method: "client-raster", retries };
}

// ─── Worker message handler ──────────────────────────────────────

self.addEventListener("message", (e: MessageEvent<BucketFillRequest>) => {
  try {
    const result = processFill(e.data);
    (self as unknown as Worker).postMessage(result);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: "error",
      error: err instanceof Error ? err.message : "Worker error",
    } satisfies BucketFillResult);
  }
});
