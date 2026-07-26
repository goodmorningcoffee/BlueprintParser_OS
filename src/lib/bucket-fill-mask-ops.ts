/**
 * bucket-fill-mask-ops.ts — raster mask primitives shared by both engines.
 *
 * MOVED HERE from `src/workers/bucket-fill.worker.ts` (bucket-fill rebuild, phase 1). The
 * implementations are UNCHANGED; only their home is. They live outside the worker because the
 * vendored One-Click path needs the same operations, and duplicating them would guarantee the
 * two engines drift on exactly the geometry we are trying to compare.
 *
 * ⚠ `findHoleBorders` is re-exported by the worker and MUST stay re-exported: two test files
 * import it from `@/workers/bucket-fill.worker`, and the phase-1 gate forbids editing tests.
 *   src/lib/__tests__/bucket-fill-hole-detection.test.ts
 *   src/lib/__tests__/bucket-fill-worker-perf-parity.test.ts
 *
 * The `SolidRoomRectangle` import is deliberately TYPE-ONLY. The worker imports this module for
 * `burnLine`/`fillPolygonOnBinary`, so a value import back into the worker would be a runtime
 * cycle — and importing the worker at runtime would execute its `self.addEventListener`
 * registration. `import type` is erased at compile time, so no cycle exists.
 */

import type { SolidRoomRectangle } from "@/workers/bucket-fill.worker";

// ─── Burn barriers & polygon exclusions ──────────────────────────

export function burnLine(
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

export function fillPolygonOnBinary(
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

// ─── Hole detection ──────────────────────────────────────────────

/**
 * Find and trace holes in the 0/1 mask produced by `floodFill`.
 *
 * Algorithm: flood from the exact filled-region bounding-box edges through
 * unfilled pixels; anything still unfilled afterward is enclosed-inside = a
 * hole. `bounds`, when supplied, must contain every filled pixel. Group
 * connected hole pixels into components and trace each one's border with the
 * same Moore neighbor routine used for the outer contour. This is the JS
 * equivalent of OpenCV's RETR_CCOMP hierarchy.
 */
export function findHoleBorders(
  filled: Uint8Array,
  w: number,
  h: number,
  bounds?: SolidRoomRectangle,
): { x: number; y: number }[][] {
  const minX = Math.max(0, bounds?.minX ?? 0);
  const minY = Math.max(0, bounds?.minY ?? 0);
  const maxX = Math.min(w - 1, bounds?.maxX ?? w - 1);
  const maxY = Math.min(h - 1, bounds?.maxY ?? h - 1);
  if (minX > maxX || minY > maxY) return [];

  // Pixels outside the flood's bounding box are necessarily unfilled and cannot be enclosed by
  // it. Work in a compact local mask so a typical room examines its own footprint instead of the
  // entire 4000px page. marks: 0=unclassified empty, 1=filled, 2=outside, 3=current hole,
  // 4=completed hole.
  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;
  const marks = new Uint8Array(boxW * boxH);
  for (let localY = 0; localY < boxH; localY++) {
    const sourceRow = (minY + localY) * w + minX;
    const localRow = localY * boxW;
    marks.set(filled.subarray(sourceRow, sourceRow + boxW), localRow);
  }

  // A typed queue holds local indices without allocating millions of boxed JS numbers. Entries
  // remain available after a component flood so the current hole can be retired after tracing.
  const queue = new Uint32Array(marks.length);
  const floodComponent = (seed: number, from: number, to: number): number => {
    let head = 0;
    let tail = 1;
    queue[0] = seed;
    marks[seed] = to;
    while (head < tail) {
      const index = queue[head++];
      const x = index % boxW;
      if (x > 0 && marks[index - 1] === from) {
        marks[index - 1] = to;
        queue[tail++] = index - 1;
      }
      if (x + 1 < boxW && marks[index + 1] === from) {
        marks[index + 1] = to;
        queue[tail++] = index + 1;
      }
      if (index >= boxW && marks[index - boxW] === from) {
        marks[index - boxW] = to;
        queue[tail++] = index - boxW;
      }
      if (index + boxW < marks.length && marks[index + boxW] === from) {
        marks[index + boxW] = to;
        queue[tail++] = index + boxW;
      }
    }
    return tail;
  };

  // Empty pixels on a flood-bbox edge are connected to page exterior. Flood each still-new edge
  // component once; subsequent edge visits see mark 2 and cost only the branch.
  for (let x = 0; x < boxW; x++) {
    if (marks[x] === 0) floodComponent(x, 0, 2);
    const bottom = (boxH - 1) * boxW + x;
    if (marks[bottom] === 0) floodComponent(bottom, 0, 2);
  }
  for (let y = 0; y < boxH; y++) {
    const left = y * boxW;
    if (marks[left] === 0) floodComponent(left, 0, 2);
    const right = left + boxW - 1;
    if (marks[right] === 0) floodComponent(right, 0, 2);
  }

  const traceCurrentHole = (startIndex: number): { x: number; y: number }[] => {
    const border: { x: number; y: number }[] = [];
    const dx = [1, 1, 0, -1, -1, -1, 0, 1];
    const dy = [0, 1, 1, 1, 0, -1, -1, -1];
    const startX = startIndex % boxW;
    const startY = (startIndex - startX) / boxW;
    let cx = startX;
    let cy = startY;
    let direction = 7;
    let iterations = 0;
    do {
      border.push({ x: cx + minX, y: cy + minY });
      const startDirection = (direction + 5) % 8;
      let found = false;
      for (let offset = 0; offset < 8; offset++) {
        const nextDirection = (startDirection + offset) % 8;
        const nx = cx + dx[nextDirection];
        const ny = cy + dy[nextDirection];
        if (
          nx >= 0 && nx < boxW && ny >= 0 && ny < boxH &&
          marks[ny * boxW + nx] === 3
        ) {
          direction = nextDirection;
          cx = nx;
          cy = ny;
          found = true;
          break;
        }
      }
      if (!found) break;
      iterations++;
    } while (
      (cx !== startX || cy !== startY) &&
      iterations < marks.length * 2
    );
    return border;
  };

  // Every remaining zero component is enclosed. Mark one component as the unique value 3 before
  // tracing so diagonally adjacent (but 4-disconnected) holes cannot merge in the 8-neighbor
  // contour walk; retire it to 4 afterward using the retained queue entries.
  const holePolys: { x: number; y: number }[][] = [];
  for (let index = 0; index < marks.length; index++) {
    if (marks[index] !== 0) continue;
    const componentLength = floodComponent(index, 0, 3);
    const border = traceCurrentHole(index);
    for (let queueIndex = 0; queueIndex < componentLength; queueIndex++) {
      marks[queue[queueIndex]] = 4;
    }
    if (border.length >= 3) holePolys.push(border);
  }
  return holePolys;
}
