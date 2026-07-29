/**
 * _legacy-mirror.mjs — THE legacy raster leg, in one place.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────
 * `src/workers/bucket-fill.worker.ts` exports most of its primitives (bucketRgbaHistogram,
 * bucketRgbaBinarize, morphClose, detectSolidRoomRectangle, floodSolidRoomRectangle, floodFill,
 * traceBorder, findHoleBorders) — but TWO of its steps are private and cannot be imported:
 * `downscaleAndBinarize` and `douglasPeucker`. Any harness that wants to drive the legacy engine
 * has to transcribe those two, and a transcription that drifts from the worker makes every
 * legacy number quietly wrong while still looking fine.
 *
 * `scripts/oneclick-accuracy.mjs` carried the only copy, with a sha256 PARITY pin at the bottom
 * of the file to catch drift. The moment a SECOND harness needed the legacy leg
 * (`scripts/corpus-differential.mjs`), copy-pasting would have produced two mirrors and two
 * pins — i.e. two things to keep in sync instead of one, which is exactly the failure the pin
 * was invented to prevent. So the mirrors, the pin, and the flood/trace sequence live here and
 * both harnesses import them.
 *
 * ⚠ THE CONTRACT: if the worker changes either private function OR `processFill`'s orchestration,
 * `checkParity()` fails LOUDLY (exit code 3, never silently) and the MIRROR blocks below must be
 * re-transcribed before any legacy number is believed. ★ That contract was NOT met between
 * 2026-07-26 and 2026-07-29: the extractor hashed a signature fragment, so the check could not
 * fail. See the note above `extractFn`.
 *
 * ⚠ THIS MODULE SHIMS `globalThis.self` ON IMPORT. The worker registers a global message
 * listener at import time and node has no `self`; without the shim the import throws. Importing
 * this module is therefore how a harness gets a loadable worker, and it must come after
 * `_ts-resolve.mjs`.
 */

import "./_ts-resolve.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./_paths.mjs";

// The worker registers a global message listener at import time. Shim BEFORE importing it.
globalThis.self ??= { addEventListener() {}, postMessage() {} };

/** The worker's REAL exported primitives. Everything here that is not a MIRROR is the product's. */
export const W = await import(join(REPO, "src/workers/bucket-fill.worker.ts"));

const { createCanvas } = await import("@napi-rs/canvas");

// ── MIRROR: worker `douglasPeucker` (bucket-fill.worker.ts:509) — NOT exported ───────────
// Transcribed, not approximated. Perpendicular distance to the chord, with the degenerate
// zero-length chord falling back to point distance, and the same [0,1] clamp on t.
export function douglasPeucker(points, epsilon) {
  if (points.length <= 2) return points;
  let maxDist = 0,
    maxIdx = 0;
  const start = points[0],
    end = points[points.length - 1];
  const ldx = end.x - start.x,
    ldy = end.y - start.y;
  const lenSq = ldx * ldx + ldy * ldy;
  for (let i = 1; i < points.length - 1; i++) {
    let dist;
    if (lenSq === 0) {
      const ddx = points[i].x - start.x,
        ddy = points[i].y - start.y;
      dist = Math.sqrt(ddx * ddx + ddy * ddy);
    } else {
      const t = Math.max(
        0,
        Math.min(1, ((points[i].x - start.x) * ldx + (points[i].y - start.y) * ldy) / lenSq),
      );
      const ddx = points[i].x - (start.x + t * ldx),
        ddy = points[i].y - (start.y + t * ldy);
      dist = Math.sqrt(ddx * ddx + ddy * ddy);
    }
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }
  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [start, end];
}

// ── MIRROR: worker `downscaleAndBinarize` (bucket-fill.worker.ts:133) — NOT exported ─────
// The worker takes an ImageBitmap and an OffscreenCanvas; here the page is rendered with
// @napi-rs/canvas instead. Everything downstream of getImageData is the worker's own
// EXPORTED code (bucketRgbaHistogram / bucketRgbaBinarize) plus its Otsu loop transcribed
// verbatim, including the `threshold + (30 - tolerance)` adjustment and the clamp.
//
// ★ THE COLOURED-PAGE BRANCH (worker:150-160) — added 2026-07-29, and it was MISSING before.
// `filterSafe` is false as soon as any pixel is non-neutral or translucent. Production then
// throws the unfiltered draw away and redraws through `ctx.filter = "grayscale(1)"`, so a red
// revision cloud or an orange stamp is thresholded on its LUMINANCE. The earlier mirror computed
// `filterSafe`, ignored it, and thresholded the RED channel — under which pure red (255,0,0) is
// 255, i.e. *passable*, where production sees 54 and calls it ink. On synthetic black-on-white
// fixtures that is invisible; on real drawings it makes the harness's legacy leg flood straight
// through coloured linework the shipping worker stops at, which biases a differential toward
// "legacy is worse". @napi-rs/canvas implements the filter with the same luminance coefficients
// (verified: #ff0000 -> 54,54,54), so this is a faithful mirror, not an approximation.
export function downscaleAndBinarize(srcCanvas, maxDimension, tol) {
  const ow = srcCanvas.width,
    oh = srcCanvas.height;
  const ratio = Math.min(maxDimension / ow, maxDimension / oh, 1);
  const w = Math.round(ow * ratio);
  const h = Math.round(oh * ratio);

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  // The worker draws onto a transparent backing store; a PDF render is opaque white, so match
  // production by painting white first. Without this, antialiased edges composite against
  // transparent black and the Otsu histogram sees ink that production never sees.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(srcCanvas, 0, 0, w, h);
  let rgba = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;

  let { hist, filterSafe } = W.bucketRgbaHistogram(rgba, n, true);
  let filterApplied = false;
  if (!filterSafe) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.filter = "grayscale(1)";
    ctx.drawImage(srcCanvas, 0, 0, w, h);
    ctx.filter = "none";
    rgba = ctx.getImageData(0, 0, w, h).data;
    ({ hist } = W.bucketRgbaHistogram(rgba, n, false));
    filterApplied = true;
    // Self-check: a real grayscale filter leaves every pixel neutral and opaque, so a second
    // safety probe must now come back TRUE. If it does not, the filter silently did nothing and
    // every legacy number on this page is being thresholded on the red channel. Say so loudly
    // rather than let the run look clean — this is the failure the branch above exists to prevent.
    const { filterSafe: nowSafe } = W.bucketRgbaHistogram(rgba, n, true);
    if (!nowSafe) {
      process.stderr.write(
        "\n!! GRAYSCALE FILTER DID NOT APPLY — this canvas backend ignores ctx.filter.\n" +
          "   The legacy leg is thresholding the RED channel and production is not.\n" +
          "   Coloured linework will read as passable. Do not trust legacy numbers on\n" +
          "   coloured pages until this is resolved.\n\n",
      );
    }
  }

  let sum = 0;
  for (let value = 0; value < hist.length; value++) sum += value * hist[value];
  let sumB = 0,
    wB = 0,
    maxVar = 0,
    threshold = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
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
  const adjustedThreshold = Math.max(0, Math.min(255, threshold + (30 - tol)));
  const bin = W.bucketRgbaBinarize(rgba, n, adjustedThreshold);
  // `filterSafe` is reported so a caller can put it in its output. A page where it is FALSE is a
  // page whose legacy answer depended on the grayscale branch above; a harness that never surfaces
  // it cannot tell a reader which rows those were.
  return { bin, w, h, otsu: threshold, adjusted: adjustedThreshold, filterSafe, filterApplied };
}

/**
 * The worker's `processFill` from the binarized raster onward (bucket-fill.worker.ts:556+),
 * step for step, on a seed already expressed in DOWNSCALED-RASTER pixels.
 *
 * Split out of the two harnesses so that "the legacy leg" is ONE sequence, not two that happen
 * to look alike. `areaFraction` is what the worker itself reports at :646 — already net of
 * holes, because holes are never marked during the flood.
 *
 * `prep` is the per-page work that does not depend on the seed (`detectSolidRoomRectangle` and
 * the optional `morphClose`); pass it in to reuse it across many seeds on one page, or omit it
 * and it is computed here. Reusing it is not an optimisation only: recomputing per seed would
 * make a 40-seed page 40x slower for a byte-identical answer.
 */
export function legacyPrep(bin, w, h, dilation) {
  const radius = dilation <= 0 ? 0 : Math.ceil(dilation / 2);
  const solidRoom = W.detectSolidRoomRectangle(bin, w, h, radius);
  const closed = radius > 0 && !solidRoom ? W.morphClose(bin, w, h, radius) : bin;
  return { solidRoom, closed };
}

export function legacyFloodAndTrace(bin, w, h, seedPx, seedPy, dilation, prep = null) {
  const { solidRoom, closed } = prep ?? legacyPrep(bin, w, h, dilation);

  const t0 = performance.now();
  const canUseSolid =
    solidRoom !== null &&
    seedPx >= solidRoom.minX &&
    seedPx <= solidRoom.maxX &&
    seedPy >= solidRoom.minY &&
    seedPy <= solidRoom.maxY;
  const flood = canUseSolid
    ? W.floodSolidRoomRectangle(solidRoom, w, h)
    : W.floodFill(closed, w, h, seedPx, seedPy);
  const floodMs = performance.now() - t0;

  if (flood.area < 20) {
    return { status: "error:no-region", areaFraction: null, verts: 0, floodMs, traceMs: 0, solidRoom: canUseSolid };
  }

  const t1 = performance.now();
  const border = W.traceBorder(flood.filled, w, h, flood.firstIndex);
  if (border.length < 3) {
    return { status: "error:untraceable", areaFraction: null, verts: 0, floodMs, traceMs: performance.now() - t1, solidRoom: canUseSolid };
  }
  const epsilon = Math.max(w, h) * 0.005;
  const simplified = douglasPeucker(border, epsilon);
  const traceMs = performance.now() - t1;
  if (simplified.length < 3) {
    return { status: "error:too-few-verts", areaFraction: null, verts: 0, floodMs, traceMs, solidRoom: canUseSolid };
  }

  return {
    status: "ok",
    // processFill:646 — areaFraction is net of holes, counted as pixels were first marked.
    areaFraction: flood.area / (w * h),
    verts: simplified.length,
    floodMs,
    traceMs,
    solidRoom: canUseSolid,
    // The raw filled mask, for callers that compare REGIONS rather than areas (IoU in
    // scripts/corpus-differential.mjs). `flood.filled` is already the worker's own buffer —
    // handing it back costs nothing and stops a caller reimplementing the flood to get it.
    filled: flood.filled,
    bounds: { minX: flood.minX, minY: flood.minY, maxX: flood.maxX, maxY: flood.maxY },
  };
}

// ── PARITY CHECK — the claim in the header made real ─────────────────────────
// The mirrors above reimplement the worker's two PRIVATE steps. If the worker changes them and
// these mirrors do not, every legacy number silently becomes wrong while still looking fine.
// There is no import that can catch it (the functions are not exported), so pin their SOURCE.
// A mismatch is LOUD but not fatal: the run still happened, the numbers are just suspect.
const PINNED = {
  // sha256 (first 16 hex) of the exact function text — SIGNATURE **AND BODY** — in
  // src/workers/bucket-fill.worker.ts. Re-pinned 2026-07-29; see the bug note below for why the
  // 2026-07-26 values could not be carried forward.
  downscaleAndBinarize: "267019a7026a5334",
  douglasPeucker: "dd3a82672cd82c45",
  // ★ processFill's ORCHESTRATION is mirrored too (legacyFloodAndTrace above): the dilation→radius
  // rule, the solid-room gate, the `area < 20` floor, the `max(w,h) * 0.005` RDP epsilon and the
  // areaFraction expression are all transcribed constants living outside the two leaf functions.
  // Pinning only the leaves left every one of them free to drift silently.
  processFill: "e7fd75d79ef4694b",
};

/**
 * Extract a top-level function's full text — signature AND body.
 *
 * ⛔ THE BUG THIS REPLACES, and why every legacy number since 2026-07-26 was guarded by nothing:
 * the previous implementation took `src.indexOf("{", start)` as the body's opening brace and
 * brace-matched from there. In TypeScript the first `{` after `function name(` is usually a TYPE
 * ANNOTATION, not the body. Measured on today's worker:
 *     downscaleAndBinarize → 137 chars, ending at the return type `: { bin; w; h }`
 *     douglasPeucker       → 56 chars: `function douglasPeucker(points: { x: number; y: number }`
 *                            — it did not even reach the `epsilon` parameter.
 * So the pin hashed a signature fragment. Every edit to either BODY — the Otsu shift, the RDP
 * clamp, the threshold arithmetic — left `checkParity()` printing "mirrors match the worker
 * source" while the mirrors went stale. The check that existed to make the legacy leg trustworthy
 * could not fail.
 *
 * The replacement anchors on layout instead of on braces: a top-level function in this
 * prettier-formatted codebase ends at the first `}` in column 0. `assertHasBody` then refuses to
 * hash anything that does not actually contain a body, so this class of failure cannot come back
 * silently — it becomes a loud FAIL rather than a green run.
 */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const end = src.indexOf("\n}", start);
  if (end === -1) return null;
  return src.slice(start, end + 2);
}

/** A pin over a signature is not a pin. Refuse to hash a fragment with no body in it. */
function assertHasBody(name, text) {
  if (!text.endsWith("\n}")) return `${name}: extract does not end at a column-0 '}' — parser broke`;
  if (!/\n  \S/.test(text)) return `${name}: extract contains no indented statement — signature only`;
  return null;
}

/**
 * Returns true if the mirrors still match the worker. Writes its own verdict to stderr and sets
 * `process.exitCode = 3` on drift — a harness that ignores the return value still cannot exit 0
 * on stale mirrors.
 */
export async function checkParity({ quiet = false } = {}) {
  try {
    const { createHash } = await import("node:crypto");
    const workerSrc = readFileSync(join(REPO, "src/workers/bucket-fill.worker.ts"), "utf8");
    const drift = [];
    const actual = {};
    for (const name of Object.keys(PINNED)) {
      const fn = extractFn(workerSrc, name);
      if (!fn) {
        drift.push(`${name}: NOT FOUND in the worker (renamed or removed?)`);
        continue;
      }
      const bad = assertHasBody(name, fn);
      if (bad) {
        drift.push(bad);
        continue;
      }
      const h = createHash("sha256").update(fn).digest("hex").slice(0, 16);
      actual[name] = h;
      if (PINNED[name] !== "PIN_ME" && PINNED[name] !== h) {
        drift.push(`${name}: worker=${h} pinned=${PINNED[name]} — the MIRROR in _legacy-mirror.mjs is STALE`);
      }
    }
    if (Object.values(PINNED).includes("PIN_ME")) {
      process.stderr.write(
        "PARITY: pins not yet set. Record these in PINNED in scripts/probes/_legacy-mirror.mjs:\n" +
          Object.entries(actual).map(([k, v]) => `    ${k}: "${v}",\n`).join("") + "\n",
      );
      return false;
    }
    if (drift.length) {
      process.stderr.write(
        "\n!! PARITY DRIFT — the legacy leg no longer mirrors the worker !!\n" +
          drift.map((d) => "   " + d).join("\n") +
          "\n   Re-transcribe the MIRROR: blocks in scripts/probes/_legacy-mirror.mjs before\n" +
          "   trusting any legacy number.\n\n",
      );
      process.exitCode = 3;
      return false;
    }
    if (!quiet) process.stderr.write("PARITY: legacy mirrors match the worker source.\n\n");
    return true;
  } catch (e) {
    process.stderr.write(`PARITY: check could not run (${e.message})\n`);
    return false;
  }
}
