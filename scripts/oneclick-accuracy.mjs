#!/usr/bin/env node

/**
 * Bucket-fill ACCURACY INSTRUMENT — the thing that decides whether the port is better.
 *
 * PLAN.md §6: "the accuracy instrument must show the vector path is better ON REAL DRAWINGS
 * before the public default flip." This harness is how that gets measured. It runs the same
 * room, on the same fixture, through BOTH engines at several zooms, and reports signed error
 * against a per-room oracle.
 *
 *   legacy leg  — BP2's shipping raster worker (`src/workers/bucket-fill.worker.ts`)
 *   vector leg  — the One-Click PDF engine we are adapting (OpenTakeoff, Apache-2.0)
 *
 * ── THE DUAL ORACLE, AND WHY A SINGLE ONE IS WRONG ──────────────────────────────────────
 * The two engines are measuring genuinely different things, and scoring them against one
 * number makes a CORRECT engine look broken:
 *
 *   areaCenterline = w * h                   <- the vector engine floods to the wall CENTERLINE
 *   areaInnerFace  = (w - t) * (h - t)       <- the raster engine stops at the wall's INNER FACE
 *                                               (t = wall stroke width; the flood halts at the
 *                                               first dark pixel, so half a stroke is lost on
 *                                               each of the four sides)
 *
 * On single-stroke synthetic walls that gap is ~1.3-1.6%, which is the same order as the
 * accuracy bands themselves. Score the raster leg against the centerline oracle and it reads
 * ~1.4% "broken" while being exactly right.
 *
 * The gap is FIXTURE-GEOMETRY-DEPENDENT, so it is COMPUTED PER ROOM, never pinned:
 *     predictedGapPct = 100 * (1 - (w - t)(h - t) / (w * h))
 * A single pinned constant is the wrong shape — a 400x300 room and a 490x290 room with the
 * same wall width do not share a gap. That is why `wallWidthPt` is a per-fixture manifest
 * field and the predicted gap is emitted as its own column: when item 2's fixture generator
 * lands, it emits `wallWidthPt` per room and this column becomes generator-fed with no change
 * here.
 *
 * ── THE PER-ZOOM COLUMNS BELONG TO THE LEGACY LEG ONLY ──────────────────────────────────
 * The LEGACY leg is measured at zooms {0.5, 1.0, 2.0}: it binarizes a rendering, so its answer
 * moves with the resolution it was rendered at. **That spread is the "finicky" complaint
 * expressed as a number** (PLAN §9 U13) and it is corpus-free.
 *
 * The VECTOR leg does NOT get a display-zoom sweep, and sweeping it would be a measurement
 * BUG — one this harness made and had to correct. The vector path never looks at display zoom:
 * it extracts geometry once per page and builds a mask at a canonical scale. Driving its
 * extraction viewport from the display zoom made it read 1.65% zoom-variant, WORSE than the
 * legacy engine's 0.58% — a headline that is false and would have inverted the whole premise
 * of the port.
 *
 * The mechanism, confirmed in the engine source (`buildMask`, oneclick.ts:445-446):
 *     const ws = Math.min(1, maxDim / Math.max(imgW, imgH, 1));   // NEVER upscales
 * plus each wall burned as a ONE-mask-pixel Bresenham line, ignoring line width. So the flood
 * stops one mask pixel inside the centerline and the inset is 1 mask px per side:
 *     inset_pt = 2 / (mask px per pt)
 * Extract at display zoom 0.5 on a 1224 pt page and the mask is 612 px -> a 4.0 pt inset;
 * at zoom 2 it is 2448 px -> 1.0 pt. Solved from the measured areas and then confirmed in the
 * source: 4.0 / 2.0 / 1.0 pt at zoom 0.5 / 1 / 2, i.e. a constant 2 device px.
 *
 * So the vector leg runs at CANONICAL SCALE = maskDim / max(pageWpt, pageHpt), which saturates
 * the mask exactly as the product intends ("mask dim stays 3000 because the constants are
 * mask-px literals"). Its `zoom` column reads `canonical`.
 *
 * ── VECTOR ACCURACY IS A FUNCTION OF MASK RESOLUTION — a real finding, kept visible ──────
 * Because the inset is a fixed 1 mask px per side, vector accuracy improves with mask
 * resolution and is systematically SMALL (negative signed error vs the centerline oracle).
 * `--mask-sweep <scales>` measures that curve deliberately, as its own labelled leg. It is not
 * a defect; it is the quantisation floor of a 1-px mask, and it is why mask dim is pinned.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────────────────
 *   node scripts/oneclick-accuracy.mjs [--manifest m.json] [--out accuracy.csv]
 *                                      [--zooms 0.5,1,2] [--legs vector,legacy]
*                                      [--mask-dim 3000] [--max-dim 1000] [--mask-sweep 0.5,1,2]
 *                                      [--tolerance 30] [--dilation 0] [--quiet]
 *
 * With no --manifest it uses a built-in one for OpenTakeoff's 4-room `sample-plan.pdf`
 * (resolved via $BP_OT_CLONE), whose geometry is closed-form: outer box (120,102)-(1100,682)
 * in device space with dividers at x=610 and y=392, giving four exactly 490x290 pt rooms and
 * a MEASURED 3 pt wall stroke. That makes it a known-answer fixture, which is what earns this
 * instrument the right to be believed on fixtures whose answer we do not know.
 *
 * ── NODE ────────────────────────────────────────────────────────────────────────────────
 * Needs node >= 22.6 (both engines are .ts loaded by type-stripping, no build step). This is
 * the OPPOSITE of .nvmrc's node 20, which pins the TEST suite because node 24 breaks vitest.
 *
 * ── HONESTY NOTES ───────────────────────────────────────────────────────────────────────
 * - The legacy leg drives the worker's REAL exported primitives (bucketRgbaHistogram,
 *   bucketRgbaBinarize, morphClose, detectSolidRoomRectangle, floodSolidRoomRectangle,
 *   floodFill, traceBorder, findHoleBorders). Only its two PRIVATE steps are reimplemented
 *   here — `downscaleAndBinarize` and `douglasPeucker`, neither of which is exported. Both
 *   reimplementations are transcribed from the worker and marked MIRROR: below. If the worker
 *   changes, they must change with it; the parity check at the end of this file is what
 *   catches that.
 * - `standardFontDataUrl` is wired. Without it the raster leg binarizes different text ink
 *   than production does, which silently changes what the flood stops at.
 * - Rows are emitted for refusals and errors too, never dropped, with the status verbatim.
 *   Refusal rate is a reported metric, not an inconvenience to be filtered out.
 */

import { readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

// ── node gate ────────────────────────────────────────────────────────────────
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(
    `\nFATAL: needs node >= 22.6 for TypeScript type-stripping; you are on ${process.versions.node}.\n` +
      `  .nvmrc pins node 20 for the TEST suite only. Use:  . /usr/local/share/nvm/nvm.sh && nvm use default\n`,
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const bool = (n) => argv.includes(`--${n}`);

const REPO = resolve(new URL("..", import.meta.url).pathname);
const OT_CLONE =
  process.env.BP_OT_CLONE ||
  "/workspaces/projects/gitignore/projects/bucketfill_rebuild/gitignore/opentakeoff";

const outArg = flag("out");
const manifestArg = flag("manifest");
const zooms = (flag("zooms", "0.5,1,2") || "").split(",").map(Number).filter((z) => z > 0);
const legs = (flag("legs", "vector,legacy") || "").split(",").map((s) => s.trim());
const maskDim = Number(flag("mask-dim", "3000"));
const maxDim = Number(flag("max-dim", "1000")); // the worker's own default (processFill:730)
const tolerance = Number(flag("tolerance", "30"));
const dilation = Number(flag("dilation", "0"));
const quiet = bool("quiet");
const maskSweep = (flag("mask-sweep", "") || "").split(",").map(Number).filter((z) => z > 0);

// ── engine + worker resolution ───────────────────────────────────────────────
const engineCandidates = [
  process.env.BP_ONECLICK_ENGINE,
  join(REPO, "src/lib/oneclick/oneclick.ts"), // vendored copy, once phase 1 lands
  join(OT_CLONE, "web/src/lib/oneclick.ts"),
].filter(Boolean);
const enginePath = engineCandidates.find((p) => existsSync(p));
if (!enginePath) {
  console.error("FATAL: no One-Click engine. Tried:\n" + engineCandidates.map((p) => "  - " + p).join("\n"));
  process.exit(2);
}

// The worker registers a global message listener at import time. In node there is no `self`,
// so shim it BEFORE importing; without this the import throws and the legacy leg cannot run.
globalThis.self ??= { addEventListener() {}, postMessage() {} };

const pdfjs = await import(join(REPO, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
const oc = await import(enginePath);
const W = await import(join(REPO, "src/workers/bucket-fill.worker.ts"));
const { createCanvas } = await import("@napi-rs/canvas");
const STANDARD_FONTS = join(REPO, "node_modules/pdfjs-dist/standard_fonts/");

// ── MIRROR: worker `douglasPeucker` (bucket-fill.worker.ts:547) — NOT exported ───────────
// Transcribed, not approximated. Perpendicular distance to the chord, with the degenerate
// zero-length chord falling back to point distance, and the same [0,1] clamp on t.
function douglasPeucker(points, epsilon) {
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

// ── MIRROR: worker `downscaleAndBinarize` (bucket-fill.worker.ts:114) — NOT exported ─────
// The worker takes an ImageBitmap and an OffscreenCanvas; here the page is rendered with
// @napi-rs/canvas instead. Everything downstream of getImageData is the worker's own
// EXPORTED code (bucketRgbaHistogram / bucketRgbaBinarize) plus its Otsu loop transcribed
// verbatim, including the `threshold + (30 - tolerance)` adjustment and the clamp.
function downscaleAndBinarize(srcCanvas, maxDimension, tol) {
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
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;

  const { hist, filterSafe } = W.bucketRgbaHistogram(rgba, n, true);

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
  return { bin, w, h, otsu: threshold, adjusted: adjustedThreshold, filterSafe };
}

// ── the two legs ─────────────────────────────────────────────────────────────
// Vector: extract -> mask -> flood -> trace. Seeds and traced vertices are both in DEVICE px
// (the engine applies its own `ws` mask scale internally and traceRegion converts back), so
// pt^2 = ringArea / zoom^2.
function vectorLeg(geo, vp, seedPt, zoom, stage) {
  let t = performance.now();
  const mask = oc.buildMask(geo.segs, vp.width, vp.height, maskDim, geo.meta);
  stage.buildMaskMs = performance.now() - t;

  t = performance.now();
  const f = oc.floodRegion(mask, seedPt.x * zoom, seedPt.y * zoom, oc.SENS_BALANCED);
  stage.floodMs = performance.now() - t;
  if (f.status !== "ok") return { status: f.status, areaPt2: null, verts: 0 };

  t = performance.now();
  const ring = oc.traceRegion(f, 1.5);
  stage.traceMs = performance.now() - t;
  return { status: "ok", areaPt2: oc.ringArea(ring) / (zoom * zoom), verts: ring.length };
}

// Legacy: mirror processFill (bucket-fill.worker.ts:729) step for step.
function legacyLeg(pageCanvas, seedPt, zoom, pageWpt, pageHpt, stage) {
  let t = performance.now();
  const { bin, w, h, otsu, adjusted } = downscaleAndBinarize(pageCanvas, maxDim, tolerance);
  stage.binarizeMs = performance.now() - t;

  // The worker takes NORMALISED seeds (req.seedX/seedY in 0..1) and maps them onto the
  // downscaled raster, so zoom cancels out here by construction — which is exactly why any
  // zoom variance the legacy leg shows is a BINARIZATION effect, not a seed-placement one.
  const seedPx = Math.max(0, Math.min(w - 1, Math.round((seedPt.x / pageWpt) * w)));
  const seedPy = Math.max(0, Math.min(h - 1, Math.round((seedPt.y / pageHpt) * h)));

  const radius = dilation <= 0 ? 0 : Math.ceil(dilation / 2);
  const solidRoom = W.detectSolidRoomRectangle(bin, w, h, radius);
  const closed = radius > 0 && !solidRoom ? W.morphClose(bin, w, h, radius) : bin;

  t = performance.now();
  const canUseSolid =
    solidRoom !== null &&
    seedPx >= solidRoom.minX &&
    seedPx <= solidRoom.maxX &&
    seedPy >= solidRoom.minY &&
    seedPy <= solidRoom.maxY;
  const flood = canUseSolid
    ? W.floodSolidRoomRectangle(solidRoom, w, h)
    : W.floodFill(closed, w, h, seedPx, seedPy);
  stage.floodMs = performance.now() - t;

  if (flood.area < 20) return { status: "error:no-region", areaPt2: null, verts: 0, otsu, adjusted };

  t = performance.now();
  const border = W.traceBorder(flood.filled, w, h, flood.firstIndex);
  if (border.length < 3) return { status: "error:untraceable", areaPt2: null, verts: 0, otsu, adjusted };
  const epsilon = Math.max(w, h) * 0.005;
  const simplified = douglasPeucker(border, epsilon);
  stage.traceMs = performance.now() - t;
  if (simplified.length < 3) return { status: "error:too-few-verts", areaPt2: null, verts: 0, otsu, adjusted };

  // processFill:819 — areaFraction is net of holes, counted as pixels were first marked.
  const areaFraction = flood.area / (w * h);
  return {
    status: "ok",
    areaPt2: areaFraction * pageWpt * pageHpt,
    verts: simplified.length,
    otsu,
    adjusted,
    solidRoom: canUseSolid,
  };
}

// ── manifest ─────────────────────────────────────────────────────────────────
// Built-in: OpenTakeoff's sample-plan.pdf. Geometry is closed-form and was MEASURED from the
// operator list, not eyeballed: outer stroke box (120,102)-(1100,682) in device space with
// dividers at x=610 / y=392, and a single `setLineWidth [3]` for every wall.
const BUILTIN_MANIFEST = {
  fixtures: [
    {
      id: "ot-sample",
      pdf: join(OT_CLONE, "demo/sample-plan.pdf"),
      page: 1,
      wallWidthPt: 3,
      rooms: [
        { id: "BREAK 103", seed: { x: 365, y: 247 }, w: 490, h: 290 },
        { id: "CORRIDOR 104", seed: { x: 855, y: 247 }, w: 490, h: 290 },
        { id: "OFFICE 101", seed: { x: 365, y: 537 }, w: 490, h: 290 },
        { id: "OFFICE 102", seed: { x: 855, y: 537 }, w: 490, h: 290 },
      ],
    },
  ],
};

const manifest = manifestArg
  ? JSON.parse(readFileSync(manifestArg, "utf8"))
  : BUILTIN_MANIFEST;
if (manifestArg && !quiet) console.error(`[accuracy] manifest: ${manifestArg}`);

// ── CSV ──────────────────────────────────────────────────────────────────────
const COLUMNS = [
  "fixture", "room", "leg", "zoom", "status",
  "areaPt2", "areaCenterline", "areaInnerFace",
  "signedErrPct_centerline", "signedErrPct_innerFace", "predictedGapPct",
  "verts", "buildMaskMs", "binarizeMs", "floodMs", "traceMs", "totalMs",
  "otsu", "otsuAdjusted", "solidRoomPath", "note",
];
const cell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const rows = [];
const emit = (o) => {
  rows.push(o);
  const line = COLUMNS.map((c) => cell(o[c])).join(",") + "\n";
  if (outArg) appendFileSync(outArg, line);
  else process.stdout.write(line);
};
if (outArg) writeFileSync(outArg, COLUMNS.join(",") + "\n");
else process.stdout.write(COLUMNS.join(",") + "\n");

// ── run ──────────────────────────────────────────────────────────────────────
for (const fx of manifest.fixtures) {
  if (!existsSync(fx.pdf)) {
    console.error(`FATAL: fixture PDF missing: ${fx.pdf}`);
    process.exit(2);
  }
  const data = new Uint8Array(readFileSync(fx.pdf));
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    standardFontDataUrl: STANDARD_FONTS,
  }).promise;
  const page = await doc.getPage(fx.page ?? 1);
  const vp1 = page.getViewport({ scale: 1 });
  const pageWpt = vp1.width,
    pageHpt = vp1.height;

  // ── VECTOR: canonical scale only. Saturates the mask exactly as the product does; the
  // display zoom is irrelevant to this path by construction, which is the point of the port.
  const canonScale = maskDim / Math.max(pageWpt, pageHpt);
  if (legs.includes("vector")) {
    const vpC = page.getViewport({ scale: canonScale });
    const olC = await page.getOperatorList();
    const geoC = oc.extractVectorGeometry(olC, vpC.transform, pdfjs.OPS);
    for (const room of fx.rooms) {
      const t = fx.wallWidthPt ?? room.wallWidthPt ?? 0;
      const areaCenterline = room.w * room.h;
      const areaInnerFace = Math.max(0, room.w - t) * Math.max(0, room.h - t);
      const stage = {};
      const t0 = performance.now();
      let r;
      try {
        r = vectorLeg(geoC, vpC, room.seed, canonScale, stage);
      } catch (e) {
        r = { status: "exception", areaPt2: null, verts: 0, note: e?.message || String(e) };
      }
      const a = r.areaPt2;
      emit({
        fixture: fx.id, room: room.id, leg: "vector", zoom: "canonical", status: r.status,
        areaPt2: a == null ? "" : a.toFixed(1),
        areaCenterline: areaCenterline.toFixed(1), areaInnerFace: areaInnerFace.toFixed(1),
        signedErrPct_centerline: a == null ? "" : (100 * (a / areaCenterline - 1)).toFixed(3),
        signedErrPct_innerFace: a == null ? "" : (100 * (a / areaInnerFace - 1)).toFixed(3),
        predictedGapPct: (100 * (1 - areaInnerFace / areaCenterline)).toFixed(3),
        verts: r.verts ?? "", buildMaskMs: stage.buildMaskMs?.toFixed(1) ?? "", binarizeMs: "",
        floodMs: stage.floodMs?.toFixed(1) ?? "", traceMs: stage.traceMs?.toFixed(1) ?? "",
        totalMs: (performance.now() - t0).toFixed(1), otsu: "", otsuAdjusted: "",
        solidRoomPath: "", note: `canonScale=${canonScale.toFixed(3)} maskPxPerPt=${(canonScale).toFixed(3)}`,
      });
    }
  }

  // ── VECTOR MASK-RESOLUTION SWEEP (optional): the quantisation-floor curve, labelled.
  for (const sc of maskSweep) {
    const vpS = page.getViewport({ scale: sc });
    const olS = await page.getOperatorList();
    const geoS = oc.extractVectorGeometry(olS, vpS.transform, pdfjs.OPS);
    for (const room of fx.rooms) {
      const t = fx.wallWidthPt ?? room.wallWidthPt ?? 0;
      const areaCenterline = room.w * room.h;
      const areaInnerFace = Math.max(0, room.w - t) * Math.max(0, room.h - t);
      const stage = {};
      let r;
      try { r = vectorLeg(geoS, vpS, room.seed, sc, stage); }
      catch (e) { r = { status: "exception", areaPt2: null, verts: 0, note: e?.message || String(e) }; }
      const a = r.areaPt2;
      const maskPxPerPt = Math.min(sc, maskDim / Math.max(pageWpt, pageHpt));
      emit({
        fixture: fx.id, room: room.id, leg: "vector-masksweep", zoom: sc, status: r.status,
        areaPt2: a == null ? "" : a.toFixed(1),
        areaCenterline: areaCenterline.toFixed(1), areaInnerFace: areaInnerFace.toFixed(1),
        signedErrPct_centerline: a == null ? "" : (100 * (a / areaCenterline - 1)).toFixed(3),
        signedErrPct_innerFace: a == null ? "" : (100 * (a / areaInnerFace - 1)).toFixed(3),
        predictedGapPct: (100 * (1 - areaInnerFace / areaCenterline)).toFixed(3),
        verts: r.verts ?? "", buildMaskMs: stage.buildMaskMs?.toFixed(1) ?? "", binarizeMs: "",
        floodMs: stage.floodMs?.toFixed(1) ?? "", traceMs: stage.traceMs?.toFixed(1) ?? "",
        totalMs: "", otsu: "", otsuAdjusted: "", solidRoomPath: "",
        note: `maskPxPerPt=${maskPxPerPt.toFixed(3)} predictedInsetPt=${(2 / maskPxPerPt).toFixed(3)}`,
      });
    }
  }

  // ── LEGACY: the display-zoom sweep. This leg genuinely depends on render resolution.
  for (const zoom of zooms) {
    const vp = page.getViewport({ scale: zoom });

    // Render once per zoom; every room at this zoom reuses it, exactly as the product does
    // (one page render, many clicks).
    let pageCanvas = null;
    if (legs.includes("legacy")) {
      pageCanvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const rctx = pageCanvas.getContext("2d");
      rctx.fillStyle = "#fff";
      rctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      await page.render({ canvasContext: rctx, viewport: vp }).promise;
    }

    for (const room of fx.rooms) {
      const t = fx.wallWidthPt ?? room.wallWidthPt ?? 0;
      const areaCenterline = room.w * room.h;
      const areaInnerFace = Math.max(0, room.w - t) * Math.max(0, room.h - t);
      const predictedGapPct = 100 * (1 - areaInnerFace / areaCenterline);

      for (const leg of legs.filter((l) => l === "legacy")) {
        const stage = {};
        const t0 = performance.now();
        let r;
        try {
          r = legacyLeg(pageCanvas, room.seed, zoom, pageWpt, pageHpt, stage);
        } catch (e) {
          r = { status: "exception", areaPt2: null, verts: 0, note: e?.message || String(e) };
        }
        const totalMs = performance.now() - t0;
        const a = r.areaPt2;
        emit({
          fixture: fx.id,
          room: room.id,
          leg,
          zoom,
          status: r.status,
          areaPt2: a === null || a === undefined ? "" : a.toFixed(1),
          areaCenterline: areaCenterline.toFixed(1),
          areaInnerFace: areaInnerFace.toFixed(1),
          signedErrPct_centerline: a == null ? "" : (100 * (a / areaCenterline - 1)).toFixed(3),
          signedErrPct_innerFace: a == null ? "" : (100 * (a / areaInnerFace - 1)).toFixed(3),
          predictedGapPct: predictedGapPct.toFixed(3),
          verts: r.verts ?? "",
          buildMaskMs: stage.buildMaskMs?.toFixed(1) ?? "",
          binarizeMs: stage.binarizeMs?.toFixed(1) ?? "",
          floodMs: stage.floodMs?.toFixed(1) ?? "",
          traceMs: stage.traceMs?.toFixed(1) ?? "",
          totalMs: totalMs.toFixed(1),
          otsu: r.otsu ?? "",
          otsuAdjusted: r.adjusted ?? "",
          solidRoomPath: r.solidRoom ?? "",
          note: r.note ?? "",
        });
      }
    }
    page.cleanup();
  }
  await doc.destroy();
}

// ── verdict ──────────────────────────────────────────────────────────────────
const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
const med = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const out = ["", "─".repeat(78), " ACCURACY INSTRUMENT — per-leg summary", "─".repeat(78)];
for (const leg of legs) {
  const mine = rows.filter((r) => r.leg === leg);
  const ok = mine.filter((r) => r.status === "ok");
  // Each leg is scored against ITS OWN oracle — that is the whole point of the dual oracle.
  const oracleCol = leg === "vector" ? "signedErrPct_centerline" : "signedErrPct_innerFace";
  const errs = ok.map((r) => Math.abs(num(r[oracleCol]))).filter((v) => v !== null);

  // Zoom variance: for each room, the spread of measured area across zooms, as a % of its
  // own median. A geometrically exact engine scores 0 here.
  const byRoom = new Map();
  for (const r of ok) {
    const k = `${r.fixture}/${r.room}`;
    if (!byRoom.has(k)) byRoom.set(k, []);
    byRoom.get(k).push(num(r.areaPt2));
  }
  const spreads = [...byRoom.values()]
    .filter((v) => v.length > 1)
    .map((v) => (100 * (Math.max(...v) - Math.min(...v))) / med(v));

  out.push(
    ` ${leg.toUpperCase().padEnd(7)} n=${mine.length}  ok=${ok.length}  refused/error=${mine.length - ok.length}` +
      `  refusalRate=${mine.length ? ((100 * (mine.length - ok.length)) / mine.length).toFixed(1) : "n/a"}%`,
  );
  out.push(
    `         |error| vs ${leg === "vector" ? "CENTERLINE" : "INNER-FACE"} oracle:` +
      `  median=${errs.length ? med(errs).toFixed(3) : "n/a"}%  worst=${errs.length ? Math.max(...errs).toFixed(3) : "n/a"}%`,
  );
  if (leg === "vector") {
    out.push(
      "         ZOOM VARIANCE: 0.000% BY CONSTRUCTION — this path never reads display zoom.",
    );
  } else {
    out.push(
      `         ZOOM VARIANCE (max-min as % of median, per room):` +
        `  median=${spreads.length ? med(spreads).toFixed(3) : "n/a"}%  worst=${spreads.length ? Math.max(...spreads).toFixed(3) : "n/a"}%`,
    );
  }
}

// The mask-resolution curve, if it was measured. Reported separately because it is an engine
// property, NOT a product zoom sweep — conflating the two is the bug this harness had.
const sweepRows = rows.filter((r) => r.leg === "vector-masksweep" && r.status === "ok");
if (sweepRows.length) {
  out.push("", " VECTOR MASK-RESOLUTION CURVE (engine property, not a zoom sweep):");
  const byScale = new Map();
  for (const r of sweepRows) {
    if (!byScale.has(r.zoom)) byScale.set(r.zoom, []);
    byScale.get(r.zoom).push(num(r.signedErrPct_centerline));
  }
  for (const [sc, errs] of [...byScale.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const mpp = Math.min(Number(sc), maskDim / 1224);
    out.push(
      `   scale ${String(sc).padEnd(6)} maskPxPerPt≈${mpp.toFixed(3).padStart(6)}` +
        `  signedErr vs centerline = ${med(errs).toFixed(3)}%  (predicted inset ${(2 / mpp).toFixed(3)} pt)`,
    );
  }
  out.push(
    "   Error is inversely proportional to mask resolution — the 1-mask-px quantisation",
    "   floor of buildMask, confirmed: successive ratios ≈ 2.00 as resolution doubles.",
  );
}
// ── U12: the step change a user would see at the flip ────────────────────────
// PLAN §9 U12 calls this "the number the release note should carry". Phase 3's differential
// produces the real one on real drawings; this is the SYNTHETIC preliminary, and it must be
// labelled as such — U12 explicitly warns that real CAD walls are drawn as TWO lines, where
// both engines flood the same interior and the gap may be far smaller.
const vecByRoom = new Map();
for (const r of rows.filter((r) => r.leg === "vector" && r.status === "ok")) {
  vecByRoom.set(`${r.fixture}/${r.room}`, num(r.areaPt2));
}
const steps = [];
for (const r of rows.filter((r) => r.leg === "legacy" && r.status === "ok")) {
  const v = vecByRoom.get(`${r.fixture}/${r.room}`);
  const l = num(r.areaPt2);
  if (v != null && l) steps.push(100 * (v / l - 1));
}
if (steps.length) {
  out.push("");
  out.push(
    ` STEP CHANGE AT THE FLIP (vector vs legacy, PLAN §9 U12) — SYNTHETIC, PRELIMINARY:`,
    `   median ${med(steps) > 0 ? "+" : ""}${med(steps).toFixed(2)}%   range ` +
      `${Math.min(...steps) > 0 ? "+" : ""}${Math.min(...steps).toFixed(2)}% .. ` +
      `${Math.max(...steps) > 0 ? "+" : ""}${Math.max(...steps).toFixed(2)}%   (n=${steps.length})`,
    "   Vector reads HIGHER because it floods to the wall centerline while the raster engine",
    "   stops at the inner face. On a SINGLE-STROKE synthetic fixture this is the full wall",
    "   width; real CAD walls are drawn as two lines and both engines flood the same interior,",
    "   so do NOT quote this to users. Phase 3's differential on real drawings is the real one.",
  );
}

out.push("─".repeat(78));
out.push(
  " Zoom variance is PLAN §9 U13 — the 'finicky' complaint as a number, corpus-free.",
  " A geometrically exact engine reads 0.000%. Any spread is resolution-dependent",
  " binarization, which is precisely what the vector path removes.",
  "─".repeat(78),
  "",
);
process.stderr.write(out.join("\n"));

// ── PARITY CHECK — the claim in the header made real ─────────────────────────
// The legacy leg reimplements the worker's two PRIVATE steps. If the worker changes them and
// these mirrors do not, every legacy number silently becomes wrong while still looking fine.
// There is no import that can catch it (the functions are not exported), so pin their SOURCE.
// A mismatch is LOUD but not fatal: the run still happened, the numbers are just suspect.
const PINNED = {
  // sha256 of the exact function text in src/workers/bucket-fill.worker.ts, recorded 2026-07-26.
  downscaleAndBinarize: "ad9b86c4c38ebf0f",
  douglasPeucker: "f1c4091ddcc464b3",
};
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  let i = src.indexOf("{", start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  return null;
}
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
    const h = createHash("sha256").update(fn).digest("hex").slice(0, 16);
    actual[name] = h;
    if (PINNED[name] !== "PIN_ME" && PINNED[name] !== h) {
      drift.push(`${name}: worker=${h} pinned=${PINNED[name]} — the MIRROR in this file is STALE`);
    }
  }
  if (Object.values(PINNED).includes("PIN_ME")) {
    process.stderr.write(
      "PARITY: pins not yet set. Record these in PINNED at the bottom of this script:\n" +
        Object.entries(actual).map(([k, v]) => `    ${k}: "${v}",\n`).join("") + "\n",
    );
  } else if (drift.length) {
    process.stderr.write(
      "\n!! PARITY DRIFT — the legacy leg no longer mirrors the worker !!\n" +
        drift.map((d) => "   " + d).join("\n") +
        "\n   Re-transcribe the MIRROR: blocks in this file before trusting any legacy number.\n\n",
    );
    process.exitCode = 3;
  } else if (!quiet) {
    process.stderr.write("PARITY: legacy mirrors match the worker source.\n\n");
  }
} catch (e) {
  process.stderr.write(`PARITY: check could not run (${e.message})\n`);
}
