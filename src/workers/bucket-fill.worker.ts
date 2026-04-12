/**
 * bucket-fill.worker.ts — Client-side bucket fill via WebWorker.
 *
 * Pipeline: receive ImageBitmap → downscale → grayscale → Otsu threshold →
 * morphological close → burn barriers/exclusions → flood fill → leak-detect
 * with auto-retry → border trace → Douglas-Peucker simplify → normalize → return.
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

function downscale(
  bitmap: ImageBitmap,
  maxDim: number
): { data: Uint8ClampedArray; w: number; h: number; scaleX: number; scaleY: number } {
  const ow = bitmap.width;
  const oh = bitmap.height;
  const ratio = Math.min(maxDim / ow, maxDim / oh, 1);
  const w = Math.round(ow * ratio);
  const h = Math.round(oh * ratio);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  return { data: imgData.data, w, h, scaleX: ow / w, scaleY: oh / h };
}

function toGrayscale(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return gray;
}

function otsuThreshold(gray: Uint8Array): number {
  const hist = new Int32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0, wB = 0, wF: number;
  let maxVar = 0, threshold = 0;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

function binarize(gray: Uint8Array, threshold: number): Uint8Array {
  const bin = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    bin[i] = gray[i] > threshold ? 255 : 0;
  }
  return bin;
}

function dilate(bin: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return bin;
  const out = new Uint8Array(bin.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let isWall = false;
      for (let dy = -radius; dy <= radius && !isWall; dy++) {
        for (let dx = -radius; dx <= radius && !isWall; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < h && nx >= 0 && nx < w && bin[ny * w + nx] === 0) {
            isWall = true;
          }
        }
      }
      out[y * w + x] = isWall ? 0 : 255;
    }
  }
  return out;
}

function erode(bin: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return bin;
  const out = new Uint8Array(bin.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let allWall = true;
      for (let dy = -radius; dy <= radius && allWall; dy++) {
        for (let dx = -radius; dx <= radius && allWall; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
            if (bin[ny * w + nx] !== 0) allWall = false;
          }
        }
      }
      out[y * w + x] = allWall ? 0 : 255;
    }
  }
  return out;
}

function morphClose(bin: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  return erode(dilate(bin, w, h, radius), w, h, radius);
}

// ─── Burn barriers & polygon exclusions ──────────────────────────

function burnLine(
  bin: Uint8Array, w: number, h: number,
  x1: number, y1: number, x2: number, y2: number,
  thickness: number
) {
  // Bresenham with thickness
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
  // Scanline fill — mark polygon interior as wall (0)
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
      const x1 = Math.max(0, intersections[k]);
      const x2 = Math.min(w - 1, intersections[k + 1]);
      for (let x = x1; x <= x2; x++) bin[y * w + x] = 0;
    }
  }
}

// ─── Scanline flood fill ─────────────────────────────────────────

function floodFill(
  bin: Uint8Array, w: number, h: number,
  seedX: number, seedY: number
): Uint8Array {
  const filled = new Uint8Array(w * h); // 0 = unfilled, 1 = filled
  if (bin[seedY * w + seedX] === 0) return filled; // seed is on a wall

  const stack: [number, number][] = [[seedX, seedY]];
  filled[seedY * w + seedX] = 1;

  while (stack.length > 0) {
    const [x, y] = stack.pop()!;

    // Scan left
    let lx = x;
    while (lx > 0 && bin[y * w + (lx - 1)] !== 0 && !filled[y * w + (lx - 1)]) {
      lx--;
      filled[y * w + lx] = 1;
    }
    // Scan right
    let rx = x;
    while (rx < w - 1 && bin[y * w + (rx + 1)] !== 0 && !filled[y * w + (rx + 1)]) {
      rx++;
      filled[y * w + rx] = 1;
    }

    // Check rows above and below
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      let inSpan = false;
      for (let px = lx; px <= rx; px++) {
        if (bin[ny * w + px] !== 0 && !filled[ny * w + px]) {
          if (!inSpan) {
            stack.push([px, ny]);
            filled[ny * w + px] = 1;
            inSpan = true;
          }
        } else {
          inSpan = false;
        }
      }
    }
  }

  return filled;
}

// ─── Border tracing (Moore neighbor) ─────────────────────────────

function traceBorder(
  filled: Uint8Array, w: number, h: number
): { x: number; y: number }[] {
  // Find starting pixel (topmost, leftmost filled pixel)
  let startX = -1, startY = -1;
  outer: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (filled[y * w + x]) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }
  if (startX < 0) return [];

  const border: { x: number; y: number }[] = [];
  // 8-connected Moore neighbor tracing
  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];

  let cx = startX, cy = startY;
  let dir = 7; // start looking northwest

  const maxIter = w * h * 2; // safety limit
  let iter = 0;

  do {
    border.push({ x: cx, y: cy });
    // Rotate search direction to backtrack
    let startDir = (dir + 5) % 8; // start 3 positions back (90° CCW from previous entry direction)
    let found = false;
    for (let i = 0; i < 8; i++) {
      const d = (startDir + i) % 8;
      const nx = cx + dx[d];
      const ny = cy + dy[d];
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && filled[ny * w + nx]) {
        dir = d;
        cx = nx;
        cy = ny;
        found = true;
        break;
      }
    }
    if (!found) break;
    iter++;
  } while ((cx !== startX || cy !== startY) && iter < maxIter);

  return border;
}

// ─── Douglas-Peucker polygon simplification ──────────────────────

function douglasPeucker(
  points: { x: number; y: number }[],
  epsilon: number
): { x: number; y: number }[] {
  if (points.length <= 2) return points;

  let maxDist = 0, maxIdx = 0;
  const start = points[0], end = points[points.length - 1];
  const dx = end.x - start.x, dy = end.y - start.y;
  const lineLenSq = dx * dx + dy * dy;

  for (let i = 1; i < points.length - 1; i++) {
    let dist: number;
    if (lineLenSq === 0) {
      const ddx = points[i].x - start.x, ddy = points[i].y - start.y;
      dist = Math.sqrt(ddx * ddx + ddy * ddy);
    } else {
      const t = Math.max(0, Math.min(1, ((points[i].x - start.x) * dx + (points[i].y - start.y) * dy) / lineLenSq));
      const px = start.x + t * dx, py = start.y + t * dy;
      const ddx = points[i].x - px, ddy = points[i].y - py;
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

  // 1. Downscale
  const { data: rgba, w, h } = downscale(req.imageBitmap, maxDim);
  req.imageBitmap.close(); // free memory

  // 2. Grayscale
  const gray = toGrayscale(rgba, w, h);

  // 3. Otsu threshold → binary
  const thresh = otsuThreshold(gray);
  const baseBin = binarize(gray, thresh);

  // Seed pixel coords
  const seedPx = Math.max(0, Math.min(w - 1, Math.round(req.seedX * w)));
  const seedPy = Math.max(0, Math.min(h - 1, Math.round(req.seedY * h)));

  const LEAK_THRESHOLD = 0.25; // >25% of image = leaked
  const MAX_RETRIES = 3;

  let bestResult: { filled: Uint8Array; area: number; radius: number } | null = null;
  let retries = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const radius = Math.max(1, Math.ceil(req.dilation / 2)) + attempt;

    // 4. Morphological close
    const closed = morphClose(new Uint8Array(baseBin), w, h, radius);

    // 5. Burn barrier lines (thickness 3 at processing resolution)
    for (const b of req.barriers) {
      burnLine(closed, w, h,
        Math.round(b.x1 * w), Math.round(b.y1 * h),
        Math.round(b.x2 * w), Math.round(b.y2 * h), 3);
    }

    // 6. Burn polygon exclusions
    for (const pe of req.polygonBarriers) {
      fillPolygonOnBinary(closed, w, h, pe.vertices);
    }

    // 7. Flood fill
    const filled = floodFill(closed, w, h, seedPx, seedPy);

    // Count filled area
    let area = 0;
    for (let i = 0; i < filled.length; i++) if (filled[i]) area++;

    if (area === 0) {
      // Seed was on a wall — try with more dilation
      retries++;
      continue;
    }

    const areaRatio = area / (w * h);

    if (!bestResult || area > bestResult.area) {
      bestResult = { filled, area, radius };
    }

    if (areaRatio <= LEAK_THRESHOLD) {
      // Good fill, use this
      bestResult = { filled, area, radius };
      break;
    }

    // Leaked — retry with stronger close
    retries++;
  }

  if (!bestResult || bestResult.area === 0) {
    return { type: "error", error: "Could not detect room boundary at click point" };
  }

  // 8. Border trace
  const border = traceBorder(bestResult.filled, w, h);
  if (border.length < 3) {
    return { type: "error", error: "Detected region too small" };
  }

  // 9. Simplify (epsilon in pixel coords, ~0.5% of image dimension)
  const epsilon = Math.max(w, h) * 0.005;
  const simplified = douglasPeucker(border, epsilon);

  if (simplified.length < 3) {
    return { type: "error", error: "Simplified polygon has too few vertices" };
  }

  // 10. Normalize to 0-1
  const vertices = simplified.map((p) => ({
    x: p.x / w,
    y: p.y / h,
  }));

  return {
    type: "result",
    vertices,
    method: "client-raster",
    retries,
  };
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
