#!/usr/bin/env node

/**
 * Room-fixture generator for the bucket-fill accuracy instrument.
 *
 * PLAN §5 phase 0 item 2. Builds the closed-form room cells the accuracy harness
 * (`scripts/oneclick-accuracy.mjs`) measures against, and — the part that matters —
 * **emits the expected geometry as JSON alongside them**. The harness never guesses what a
 * room's area should be; the generator that drew it says so.
 *
 * This is a sibling of `make-synthetic-pdf.mjs` (the 100-page perf fixture) and shares its
 * conventions: pdf-lib, a seeded PRNG so the same seed gives the same bytes, and output under
 * the gitignored `test/fixtures/` so nothing here is committed. That script generates ONE
 * shape of fixture (a heavy scan-like plan set) and has no `--rooms` flag; this one generates
 * the accuracy cells.
 *
 * ── THE EIGHT CELLS ─────────────────────────────────────────────────────────────────────
 * Each isolates ONE variable. Every cell uses the same base room (490 x 290 pt centerline,
 * 3 pt walls) so that anything that moves is the feature under test, not the geometry.
 *
 *   plain            a sealed rectangle. The control.
 *   column-hole      + a FILLED interior column. Exercises hole handling, and forces the
 *                    harness to compare like with like (see AREA SEMANTICS below).
 *   l-niche          an L-shaped room. Non-convex, one reflex corner.
 *   door-gap         a 36 pt gap in one wall. SHOULD LEAK — this is the unsealable door.
 *   door-swing       the same gap, closed by a bezier arc. Curves are SEG_CURVE and are never
 *                    classified as hatch, which is exactly why a door swing can seal a gap.
 *   tile-grid        a regular hatch grid inside the room. Without hatch classification the
 *                    flood is trapped in one tile; with it, the region escalates to the room.
 *   poche-on-pitch   a wall drawn AS a run of regularly-pitched parallel strokes — a wall that
 *                    looks like hatch. It must stay hard, or the flood escapes through it.
 *   hairline         0.1 pt walls. At mask resolution a hairline may not survive rasterization
 *                    at all, which is the "raster underneath" ceiling upstream documents.
 *
 * ── EXPECTED AREA IS COMPUTED, NOT HAND-DERIVED ─────────────────────────────────────────
 * For a rectilinear polygon, insetting every edge by d = t/2 is exact:
 *     A_inner = A - P*d + (convex - reflex) * d^2
 * VERIFIED against two independent closed forms before use:
 *     490x290, t=3  ->  139769  ==  487*287
 *     700x450, t=3  ->  311559  ==  697*447
 * So `areaInnerFace` is exact for every rectilinear cell here, including the L-niche
 * (5 convex, 1 reflex -> 281559), where hand-deriving it would be error-prone.
 *
 * ── AREA SEMANTICS: the column-hole cell exposed a real apples-to-oranges risk ───────────
 * The raster worker reports area NET of holes (it counts flood pixels). The vector engine's
 * `ringArea(traceRegion(...))` is the OUTER ring, which INCLUDES a hole. On a plain room they
 * agree; on `column-hole` they differ by the whole column. The harness therefore reads the
 * vector engine's flood `count` for a net-of-holes number as well, and the two engines are
 * only ever compared net-to-net. This cell is what forced that, which is what fixtures are for.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────────────────
 *   node scripts/make-room-fixtures.mjs [--out test/fixtures/bucketfill] [--seed 1]
 *                                       [--only plain,l-niche]
 * Writes <out>/<cell>.pdf plus <out>/manifest.json, which is fed straight to the harness:
 *   node scripts/oneclick-accuracy.mjs --manifest test/fixtures/bucketfill/manifest.json
 *
 * Output is GENERATED, never committed (test/fixtures/ is gitignored). Revert = delete it.
 */

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const OUT = resolve(arg("out", "test/fixtures/bucketfill"));
const ONLY = (arg("only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);

// ── page + base room, in PDF space (origin BOTTOM-LEFT) ──────────────────────
const PAGE_W = 1224;
const PAGE_H = 792;
const WALL = 3; // pt — the wall stroke every cell uses unless it says otherwise

// ★ THE ROOM MUST STAY UNDER 30% OF THE SHEET. `oneclick.ts` has
//   const LEAK_FRACTION = 0.30;   // fill > 30% of the sheet ⇒ not an enclosed space
// and floodRegion returns {status:"leak"} above it. MEASURED the hard way: a first draft used
// a 700x450 room on this page = 32.5% of the sheet, and every sealed cell came back "leak"
// while the L-niche (29.4%) passed — an asymmetry that made no sense as an engine property and
// was the tell. The engine was right and the fixture was wrong: a real room IS a small
// fraction of a sheet.
// 490 x 290 = 142,100 pt² = 14.7% of this page — the same room OpenTakeoff's own sample uses,
// which also makes every number here directly comparable to the item-1 baseline.
const R = { x0: 200, y0: 250, x1: 690, y1: 540 }; // 490 x 290 centerline

// Device space is what the harness seeds in (y DOWN, matching the viewport transform).
const dev = (x, y) => ({ x, y: PAGE_H - y });

// ── exact rectilinear geometry ───────────────────────────────────────────────
const shoelace = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
};
const perimeter = (p) => {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    s += Math.hypot(x2 - x1, y2 - y1);
  }
  return s;
};
const cornerCounts = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  const ccw = a > 0;
  let convex = 0, reflex = 0;
  for (let i = 0; i < p.length; i++) {
    const A = p[(i - 1 + p.length) % p.length], B = p[i], C = p[(i + 1) % p.length];
    const cr = (B[0] - A[0]) * (C[1] - B[1]) - (B[1] - A[1]) * (C[0] - B[0]);
    if ((cr > 0) === ccw) convex++;
    else reflex++;
  }
  return { convex, reflex };
};
/** Exact for rectilinear polygons when d is smaller than the smallest feature. */
function innerFaceArea(poly, t) {
  const d = t / 2;
  const { convex, reflex } = cornerCounts(poly);
  return shoelace(poly) - perimeter(poly) * d + (convex - reflex) * d * d;
}

// ── drawing helpers ──────────────────────────────────────────────────────────
const BLACK = rgb(0, 0, 0);
function strokePoly(page, poly, thickness, closed = true) {
  for (let i = 0; i < poly.length - (closed ? 0 : 1); i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: BLACK });
  }
}
const rectPoly = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// ── the cells ────────────────────────────────────────────────────────────────
// Each returns { draw(page, font), rooms: [...] }. A room carries either an exact expected
// area (expect: "area") or a described behaviour (expect: "leak" | "diagnostic") — several
// cells exist to reveal what an engine DOES, and inventing a number for those would be worse
// than reporting the observation.
const CELLS = {
  plain() {
    const poly = rectPoly(R.x0, R.y0, R.x1, R.y1);
    return {
      draw: (page) => strokePoly(page, poly, WALL),
      rooms: [{ id: "plain", seed: dev(445, 395), expect: "area", poly, wallWidthPt: WALL }],
    };
  },

  "column-hole"() {
    const poly = rectPoly(R.x0, R.y0, R.x1, R.y1);
    const col = { x0: 300, y0: 330, x1: 340, y1: 370 }; // FILLED, so the hole is exactly 40x40
    return {
      draw: (page) => {
        strokePoly(page, poly, WALL);
        page.drawRectangle({
          x: col.x0, y: col.y0,
          width: col.x1 - col.x0, height: col.y1 - col.y0,
          color: BLACK,
        });
      },
      rooms: [{
        id: "column-hole",
        seed: dev(600, 470),
        expect: "area",
        poly,
        wallWidthPt: WALL,
        // Filled, not stroked: the hole is its literal footprint in BOTH engines, with no
        // stroke to inset. Subtracted from both oracles.
        holes: [{ w: col.x1 - col.x0, h: col.y1 - col.y0 }],
      }],
    };
  },

  "l-niche"() {
    // 700x450 with a 200x150 notch removed from the top-right. 5 convex + 1 reflex corner.
    const poly = [
      [R.x0, R.y0], [R.x1, R.y0], [R.x1, 420],
      [550, 420], [550, R.y1], [R.x0, R.y1],
    ];
    return {
      draw: (page) => strokePoly(page, poly, WALL),
      rooms: [{ id: "l-niche", seed: dev(400, 320), expect: "area", poly, wallWidthPt: WALL }],
    };
  },

  "door-gap"() {
    // A 36 pt hole in the bottom wall. NOTHING seals it, so the flood should escape into the
    // sheet. PLAN: "a 3-ft door is unsealable at max dilation" — this is that case, and the
    // expected outcome is a LEAK, not an area.
    const gapFrom = 430, gapTo = 466;
    return {
      draw: (page) => {
        strokePoly(page, [[R.x0, R.y0], [gapFrom, R.y0]], WALL, false);
        strokePoly(page, [[gapTo, R.y0], [R.x1, R.y0]], WALL, false);
        strokePoly(page, [[R.x1, R.y0], [R.x1, R.y1]], WALL, false);
        strokePoly(page, [[R.x1, R.y1], [R.x0, R.y1]], WALL, false);
        strokePoly(page, [[R.x0, R.y1], [R.x0, R.y0]], WALL, false);
      },
      rooms: [{
        id: "door-gap", seed: dev(445, 395), expect: "leak",
        poly: rectPoly(R.x0, R.y0, R.x1, R.y1), wallWidthPt: WALL,
        note: "36pt unsealed gap in the bottom wall — flood should escape",
      }],
    };
  },

  "door-swing"() {
    // The same gap, closed by a quarter-arc door swing. Bezier chords are SEG_CURVE and are
    // never classified as hatch, which is precisely what lets a swing seal a gap.
    const gapFrom = 430, gapTo = 466;
    return {
      draw: (page) => {
        strokePoly(page, [[R.x0, R.y0], [gapFrom, R.y0]], WALL, false);
        strokePoly(page, [[gapTo, R.y0], [R.x1, R.y0]], WALL, false);
        strokePoly(page, [[R.x1, R.y0], [R.x1, R.y1]], WALL, false);
        strokePoly(page, [[R.x1, R.y1], [R.x0, R.y1]], WALL, false);
        strokePoly(page, [[R.x0, R.y1], [R.x0, R.y0]], WALL, false);
        // drawSvgPath: SVG origin sits at (x,y) with y FLIPPED, so PDF (px,py) => SVG (px, PAGE_H-py).
        const r = gapTo - gapFrom;
        const k = 0.5523 * r;
        const sy = (pdfY) => PAGE_H - pdfY;
        page.drawSvgPath(
          `M ${gapFrom} ${sy(R.y0)} C ${gapFrom} ${sy(R.y0 + k)}, ${gapFrom + r - k} ${sy(R.y0 + r)}, ${gapFrom + r} ${sy(R.y0 + r)}`,
          { borderColor: BLACK, borderWidth: WALL, x: 0, y: PAGE_H },
        );
        strokePoly(page, [[gapFrom + r, R.y0 + r], [gapTo, R.y0]], WALL, false);
      },
      rooms: [{
        id: "door-swing", seed: dev(445, 395), expect: "diagnostic",
        poly: rectPoly(R.x0, R.y0, R.x1, R.y1), wallWidthPt: WALL,
        note: "same gap, sealed by a bezier swing — should NOT leak; area is slightly under the plain room",
      }],
    };
  },

  "tile-grid"() {
    // Regular 30 pt grid inside the room: many same-angle, regularly-pitched rows = hatch.
    // Strict flood is trapped in one tile; a hatch-aware flood escalates to the whole room.
    const poly = rectPoly(R.x0, R.y0, R.x1, R.y1);
    return {
      draw: (page) => {
        strokePoly(page, poly, WALL);
        // ★ PITCH IS A MASK-PIXEL CONSTANT, NOT A POINT CONSTANT. oneclick.ts:
        //     HATCH_MAX_PITCH = 24   // mask px
        // At the canonical scale for this page (3000/1224 = 2.451 mask px/pt) a 30 pt pitch is
        // 73.5 mask px — far outside the band, so a first draft at 30 pt was never classified
        // as hatch at all (softCount 0, no escalation, flood trapped in one tile). 8 pt = 19.6
        // mask px sits inside the band. This is risk #1 in miniature: the tuned constants are
        // mask-px literals, so fixture geometry has to be chosen in mask px too.
        for (let x = R.x0 + 8; x < R.x1; x += 8) {
          page.drawLine({ start: { x, y: R.y0 }, end: { x, y: R.y1 }, thickness: 0.5, color: BLACK });
        }
        for (let y = R.y0 + 8; y < R.y1; y += 8) {
          page.drawLine({ start: { x: R.x0, y }, end: { x: R.x1, y }, thickness: 0.5, color: BLACK });
        }
      },
      rooms: [{
        id: "tile-grid", seed: dev(445, 395), expect: "diagnostic",
        poly, wallWidthPt: WALL,
        note: "8pt hatch grid (19.6 mask px, inside HATCH_MAX_PITCH=24) — strict flood yields one tile; escalation yields the room",
      }],
    };
  },

  "poche-on-pitch"() {
    // The RIGHT wall is drawn as a run of regularly-pitched parallel strokes — a wall wearing
    // hatch's signature. If the classifier softens it, the flood escapes to the right.
    const poly = rectPoly(R.x0, R.y0, R.x1, R.y1);
    return {
      draw: (page) => {
        strokePoly(page, [[R.x0, R.y0], [R.x1, R.y0]], WALL, false);
        strokePoly(page, [[R.x1, R.y1], [R.x0, R.y1]], WALL, false);
        strokePoly(page, [[R.x0, R.y1], [R.x0, R.y0]], WALL, false);
        for (let i = 0; i < 12; i++) {
          const x = R.x1 + i * 2;
          page.drawLine({ start: { x, y: R.y0 }, end: { x, y: R.y1 }, thickness: 0.6, color: BLACK });
        }
      },
      rooms: [{
        id: "poche-on-pitch", seed: dev(445, 395), expect: "diagnostic",
        poly, wallWidthPt: WALL,
        note: "right wall is 12 parallel strokes at 2pt pitch — must stay HARD or the flood escapes right",
      }],
    };
  },

  hairline() {
    // 0.1 pt walls. At 2.451 mask px/pt a hairline is far under one mask pixel of width; it
    // survives only because buildMask burns every segment as a 1-px line regardless. The
    // raster leg is the one at risk here — antialiasing may put it under the Otsu threshold.
    const poly = rectPoly(R.x0, R.y0, R.x1, R.y1);
    return {
      draw: (page) => strokePoly(page, poly, 0.1),
      rooms: [{
        id: "hairline", seed: dev(445, 395), expect: "diagnostic",
        poly, wallWidthPt: 0.1,
        note: "0.1pt walls — vector burns 1 mask px regardless; raster may lose them to antialiasing",
      }],
    };
  },
};

// ── build ────────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const names = ONLY.length ? ONLY : Object.keys(CELLS);
const fixtures = [];

for (const name of names) {
  if (!CELLS[name]) {
    console.error(`FATAL: unknown cell "${name}". Known: ${Object.keys(CELLS).join(", ")}`);
    process.exit(2);
  }
  const cell = CELLS[name]();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  cell.draw(page, font);
  // A room label, so the text-layer seed path (detectRooms) has something to find, exactly as
  // a real sheet would carry.
  for (const r of cell.rooms) {
    page.drawText(r.id.toUpperCase(), {
      x: R.x0 + 20, y: R.y1 - 30, size: 10, font, color: BLACK,
    });
  }
  const bytes = await doc.save();
  const pdfPath = join(OUT, `${name}.pdf`);
  writeFileSync(pdfPath, bytes);

  fixtures.push({
    id: name,
    pdf: pdfPath,
    page: 1,
    wallWidthPt: cell.rooms[0].wallWidthPt,
    rooms: cell.rooms.map((r) => {
      const t = r.wallWidthPt;
      const holeArea = (r.holes || []).reduce((s, h) => s + h.w * h.h, 0);
      const areaCenterline = shoelace(r.poly) - holeArea;
      const areaInnerFace = innerFaceArea(r.poly, t) - holeArea;
      return {
        id: r.id,
        seed: r.seed,
        expect: r.expect,
        note: r.note ?? "",
        wallWidthPt: t,
        // Emitted by the generator that DREW the geometry — the harness never guesses.
        areaCenterline,
        areaInnerFace,
        predictedGapPct: 100 * (1 - areaInnerFace / areaCenterline),
        holes: r.holes ?? [],
      };
    }),
  });
  console.log(
    `[fixtures] ${name.padEnd(16)} ${bytes.length.toString().padStart(6)} B  ` +
      fixtures[fixtures.length - 1].rooms
        .map((r) => `${r.id}: ${r.expect} centerline=${r.areaCenterline} inner=${r.areaInnerFace.toFixed(1)} gap=${r.predictedGapPct.toFixed(3)}%`)
        .join(" | "),
  );
}

const manifestPath = join(OUT, "manifest.json");
writeFileSync(manifestPath, JSON.stringify({ generated: "make-room-fixtures.mjs", pageW: PAGE_W, pageH: PAGE_H, fixtures }, null, 2));
console.log(`\n[fixtures] ${fixtures.length} cells -> ${OUT}`);
console.log(`[fixtures] manifest: ${manifestPath}`);
console.log(`\nRun the harness:\n  node scripts/oneclick-accuracy.mjs --manifest ${manifestPath}\n`);
